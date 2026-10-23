/**
 * @vitest-environment node
 *
 * Wave-3a eval-report 重启可评估（扫盘 fallback）：
 * - registry 命中：source='registry'（既有行为不变）；
 * - registry 未命中（server 重启后内存记录丢失）：按 simId 扫
 *   `<trajectoryBaseDir>/<simId>/` 重建指标，source='disk'，registry
 *   独有的状态如实缺省（state=null + notes）；
 * - 跨进程验证：app1 跑完仿真写盘后关闭，app2（同一 DB 文件 + 同一
 *   trajectory 目录、空 registry）仍能 GET 出评估报告；
 * - 手造 trajectory 目录（无 DB 记录）也能重建；
 * - 盘上无记录 → 404。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { auth, importableScenario, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('eval-report 扫盘 fallback（Wave-3a）', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('registry 命中时 source=registry，聚合结构不变', async () => {
    const user = await registerUser(ctx.app);
    const env = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(user.token),
      payload: importableScenario('eval-disk-reg'),
    });
    const envId = env.json().id as string;
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(user.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      // Fix-47: event injection / lifecycle ops require the creator (or env
      // owner/builder, admin) — authenticate as the sim's creator.
      headers: auth(user.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', value: 35, severity: 'high' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(user.token),
      payload: { n: 5 },
    });

    // T-015: by-id sim reads follow Fix-47 — read as the sim's creator.
    const report = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/eval-report`, headers: auth(user.token) });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.source).toBe('registry');
    expect(body.simId).toBe(simId);
    expect(body.state).toBe('created');
    expect(body.decisions.total).toBeGreaterThan(0);
    expect(body.decisions.bySource).toBeTypeOf('object');
    expect(body).not.toHaveProperty('notes');
  });

  it('手造 trajectory 目录：registry 未命中 → source=disk 重建指标', async () => {
    const simId = 'sim-manual-disktest';
    const dir = join(ctx.trajectoryDir, simId);
    mkdirSync(dir, { recursive: true });
    const records = [
      { eventId: 'evt-1', agentId: 'agent-1', decision: 'collaborate', kind: 'assessment', decisionSource: 'llm', correct: true, scenario: 'manual-scenario' },
      { eventId: 'evt-2', agentId: 'agent-1', decision: 'handle_independently', kind: 'assessment', decisionSource: 'rule', correct: false, scenario: 'manual-scenario' },
      { eventId: 'evt-1', agentId: 'agent-2', decision: 'accept', kind: 'collaboration-response', collaborationId: 'ac-1', decisionSource: 'rule' },
    ];
    writeFileSync(
      join(dir, 'engine-runtime-iter0-manual-scenario-qwen3.jsonl'),
      records.map(r => JSON.stringify(r)).join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'sim-timeline.jsonl'),
      [
        { kind: 'zone-sample', environmentId: 'env-manual', simId, simTimeSec: 30, recordedAt: new Date().toISOString(), zones: [] },
        { kind: 'zone-sample', environmentId: 'env-manual', simId, simTimeSec: 42, recordedAt: new Date().toISOString(), zones: [] },
      ].map(r => JSON.stringify(r)).join('\n') + '\n',
    );

    // T-015: this hand-made disk report references an environment that does
    // not exist ('env-manual') — unattributable, so it keeps the open
    // transition semantics and reads anonymously.
    const report = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/eval-report` });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.source).toBe('disk');
    expect(body.simId).toBe(simId);
    expect(body.scenarioId).toBe('manual-scenario');
    expect(body.environmentId).toBe('env-manual');
    expect(body.state).toBeNull();
    expect(body.simTimeSec).toBe(42);
    expect(body.decisions).toMatchObject({
      total: 2,
      correct: 1,
      accuracy: 0.5,
      bySource: { llm: 1, rule: 1 },
    });
    expect(body.handshakes).toMatchObject({ initiated: 1, succeeded: 1, failed: 0, successRate: 1 });
    expect(Array.isArray(body.notes)).toBe(true);
    expect(body.notes.length).toBeGreaterThan(0);
  });

  it('盘上无该 simId 的目录 → 404', async () => {
    const report = await ctx.app.inject({ method: 'GET', url: '/api/simulations/sim-nope/eval-report' });
    expect(report.statusCode).toBe(404);
    expect(report.json().error.code).toBe('SIMULATION_NOT_FOUND');
  });

  it('路径穿越式 simId → 404（扫盘不出 baseDir）', async () => {
    const report = await ctx.app.inject({ method: 'GET', url: '/api/simulations/..%2F..%2Fetc/eval-report' });
    expect(report.statusCode).toBe(404);
  });
});

describe('eval-report 跨进程重启（Wave-3a）', () => {
  let workDir: string;
  let trajectoryDir: string;
  let databasePath: string;
  const apps: Array<{ close: () => Promise<unknown> }> = [];
  const userDirs: string[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'eaf-eval-restart-'));
    trajectoryDir = join(workDir, 'trajectories');
    databasePath = join(workDir, 'eaf.db');
  });

  afterEach(async () => {
    // 先关 app（释放 SQLite 文件锁）再删目录 —— Windows 上锁着的文件删不掉。
    for (const app of apps.splice(0)) {
      try { await app.close(); } catch { /* 已关 */ }
    }
    for (const dir of userDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  async function boot() {
    const userDir = mkdtempSync(join(tmpdir(), 'eaf-eval-restart-users-'));
    const app = await buildServer({
      userDir,
      trajectoryDir,
      databasePath,
      logger: false,
      webDist: join(userDir, 'no-web-dist'),
      rateLimitEnabled: false,
    });
    apps.push(app);
    userDirs.push(userDir);
    return { app };
  }

  it('app1 跑完写盘后关闭，app2（空 registry）仍GET出 source=disk 报告', async () => {
    // app1：建环境 → 跑仿真 → 停（持久化 reputation）→ 关闭进程。
    const first = await boot();
    const user = await registerUser(first.app);
    const env = await first.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(user.token),
      payload: importableScenario('eval-restart-env'),
    });
    expect(env.statusCode).toBe(201);
    const envId = env.json().id as string;
    const sim = await first.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(user.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    await first.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      // Fix-47: 事件注入/生命周期操作需创建者（或环境 owner/builder、admin）身份。
      headers: auth(user.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', value: 35, severity: 'high' },
    });
    // 设备命令 → DEVICE_OPERATION_EXECUTED → sim-timeline 落一条 device-state
    // 记录（携带 environmentId，扫盘 fallback 靠它去 DB 查 reputation）。
    // 环境导入会给设备实例发新 id，从快照里取真实 id。
    const snapshot = await first.app.inject({ method: 'GET', url: `/api/simulations/${simId}/snapshot`, headers: auth(user.token) });
    const hvac = snapshot.json().devices.find((d: { type: string }) => d.type === 'hvac') as { id: string };
    const command = await first.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(user.token),
      payload: { deviceId: hvac.id, commandName: 'turn-on' },
    });
    expect(command.statusCode).toBe(200);
    await first.app.inject({ method: 'POST', url: `/api/simulations/${simId}/step`, headers: auth(user.token), payload: { n: 5 } });
    await first.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(user.token) });
    await first.app.close();

    // app2：同一 DB + 同一 trajectory 目录，registry 为空（重启）。用户行在
    // 共享 DB 里 —— 登录同一账号读取（T-015：扫盘报告同样走环境读权限）。
    const second = await boot();
    const relogin = await second.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(relogin.statusCode).toBe(200);
    const report = await second.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/eval-report`,
      headers: auth(relogin.json().token),
    });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.source).toBe('disk');
    expect(body.simId).toBe(simId);
    expect(body.environmentId).toBe(envId);
    expect(body.state).toBeNull();
    expect(body.decisions.total).toBeGreaterThan(0);
    expect(body.reputation).toHaveProperty('totals');
    expect(body.reputation).toHaveProperty('agents');
    expect(body.notes.join(' ')).toContain('restart');
    expect(body.notes.join(' ')).toContain('reputation');
    await second.app.close();
  });
});
