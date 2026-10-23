/**
 * @vitest-environment node
 *
 * Fix-22 训练数据导出 + 评估钩子：
 *
 * - `GET /api/environments/:id/training-export` — NDJSON 流（首行 manifest，
 *   之后是 decision/collaboration/zone-sample/device-state/usage/
 *   reputation-snapshot 统一信封）；owner-only（成员 403、匿名 401）；
 *   导出行为落 command_log 审计。
 * - `GET /api/simulations/:id/eval-report` — 对 1 事件 1 决策 1 握手的小
 *   仿真聚合决策质量指标。
 *
 * 仿真跑 rule-only（无 LLM 后端），决策记录是真实产物；握手记录与
 * sim-timeline 采样行手写落盘（与 simulation-trajectory 套件一致的诚实
 * 接缝：文件格式归 core TrajectoryRecorder / sim-timeline 所有）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SIM_TIMELINE_FILE } from './sim-timeline.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

interface Envelope {
  kind: string;
  simId: string | null;
  simTimeSec: number | null;
  recordedAt: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

describe('Fix-22 training export + eval report', () => {
  let t: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let simId: string;
  let trajectoryFile: string;
  /** 导入后实例行使用新 id（environment-import），按行查询。 */
  let agentId: string;

  beforeEach(async () => {
    t = await makeTestApp();
    owner = await registerUser(t.app);

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: importableScenario('fix22-env'),
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    agentId = t.app.envStore.agentsOf(envId)[0].id;

    const sim = await t.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id;
    const filePath = t.app.simulations.getOrThrow(simId).runtime.getTrajectoryFilePath();
    expect(filePath).not.toBeNull();
    trajectoryFile = filePath as string;

    // 1 事件 → 1 条 rule 决策（rule-only 运行）。
    // Fix-47: start/step/stop 需要创建者（或环境 owner/builder、admin）身份。
    await t.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    await t.app.inject({ method: 'POST', url: `/api/simulations/${simId}/step`, headers: auth(owner.token), payload: { n: 2 } });
    const injected = await t.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a' },
    });
    expect(injected.statusCode).toBe(200);
    await t.app.inject({ method: 'POST', url: `/api/simulations/${simId}/step`, headers: auth(owner.token), payload: { n: 1 } });
    await t.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token) });

    // 1 条握手记录（accept）。（P2 分段日志：目录惰性创建，手写夹具先建目录。）
    mkdirSync(dirname(trajectoryFile), { recursive: true });
    appendFileSync(
      trajectoryFile,
      JSON.stringify({
        recordedAt: new Date().toISOString(),
        scenario: envId,
        condition: 'engine-runtime',
        iteration: 0,
        eventId: 'evt-ac-1',
        agentId: 'partner-agent',
        kind: 'collaboration-response',
        collaborationId: 'ac-1',
        context: { capabilities: [], partnerServices: [], partnerServicesTotal: 0 },
        decision: 'accept',
        decisionSource: 'rule',
        reasoning: '对方具备 cooling 能力，接受协作',
        groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
        correct: false,
      }) + '\n',
    );

    // sim-timeline：1 条 zone 采样 + 1 条设备状态变化。
    const timelinePath = join(dirname(trajectoryFile), SIM_TIMELINE_FILE);
    appendFileSync(
      timelinePath,
      JSON.stringify({
        kind: 'zone-sample',
        environmentId: envId,
        simId,
        simTimeSec: 3,
        recordedAt: new Date().toISOString(),
        zones: [{ zoneId: 'zone-a', parameters: { temperature: 31.5 }, occupancy: 2 }],
      }) + '\n',
    );
    appendFileSync(
      timelinePath,
      JSON.stringify({
        kind: 'device-state',
        environmentId: envId,
        simId,
        simTimeSec: 4,
        recordedAt: new Date().toISOString(),
        deviceId: 'hvac-b',
        service: 'turn-on',
      }) + '\n',
    );

    // 1 条服务消费计量（FK 需要一个 service 与 agreement）。
    const service =
      t.app.serviceStore.servicesOf(envId)[0] ??
      t.app.serviceStore.createService({
        envId,
        providerAgentId: agentId,
        name: 'Cooling',
        semanticType: 'cooling',
        origin: 'published',
      });
    const agreement = t.app.agreementStore.createAgreement({
      envId,
      serviceId: service.id,
      consumerAgentId: agentId,
      consumerOwnerId: owner.id,
      providerAgentId: agentId,
      providerOwnerId: owner.id,
      terms: {},
      source: 'explicit',
      status: 'active',
    });
    t.app.agreementStore.appendUsage({
      agreementId: agreement.id,
      envId,
      consumerAgentId: agentId,
      providerAgentId: agentId,
      kind: 'invoke',
      action: 'turn-on',
      quantity: 1,
      unit: 'call',
      outcome: 'success',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    // 声誉：温度类 capability 一行（eval-report 的效果回检切片）。
    t.app.reputationStore.saveForEnv(envId, [
      { agentId, capability: 'temperature-control', attempts: 2, successes: 1, failures: 1, lastAt: Date.now() },
    ]);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  function parseNdjson(body: string): Envelope[] {
    return body
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Envelope);
  }

  async function exportAs(token: string, qs = '') {
    return t.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/training-export${qs}`,
      headers: auth(token),
    });
  }

  it('exports every record kind as NDJSON with a manifest header', async () => {
    const res = await exportAs(owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const lines = parseNdjson(res.body);
    const manifest = lines[0];
    expect(manifest.kind).toBe('manifest');
    const manifestPayload = manifest.payload as {
      environment: { id: string; name: string };
      snapshot: { zones: unknown[]; devices: unknown[]; agents: unknown[]; services: unknown[] };
      counts: Record<string, number>;
      total: number;
      window: { simId: string | null; from: string | null; to: string | null };
    };
    expect(manifestPayload.environment.id).toBe(envId);
    expect(manifestPayload.snapshot.zones.length).toBe(2);
    expect(manifestPayload.snapshot.devices.length).toBe(2);
    expect(manifestPayload.snapshot.agents.length).toBe(1);
    expect(manifestPayload.window).toEqual({ simId: null, from: null, to: null });

    const kinds = new Set(lines.slice(1).map(line => line.kind));
    expect(kinds).toEqual(
      new Set(['decision', 'collaboration', 'zone-sample', 'device-state', 'usage', 'reputation-snapshot']),
    );
    expect(manifestPayload.total).toBe(lines.length - 1);
    expect(manifestPayload.counts.decision).toBe(1);
    expect(manifestPayload.counts.collaboration).toBe(1);

    // 信封形状：决策记录带 agentId 与完整 payload（含理由/来源）。
    const decision = lines.find(line => line.kind === 'decision')!;
    expect(decision.simId).toBe(simId);
    expect(decision.agentId).toBe(agentId);
    expect(decision.payload.decisionSource).toBe('rule');
    const collaboration = lines.find(line => line.kind === 'collaboration')!;
    expect(collaboration.payload.collaborationId).toBe('ac-1');
    expect(collaboration.payload.reasoning).toContain('接受协作');
    const zoneSample = lines.find(line => line.kind === 'zone-sample')!;
    expect(zoneSample.simTimeSec).toBe(3);
    const usage = lines.find(line => line.kind === 'usage')!;
    expect(usage.payload.outcome).toBe('success');
    const reputation = lines.find(line => line.kind === 'reputation-snapshot')!;
    expect(reputation.agentId).toBe(agentId);
    expect(reputation.payload.attempts).toBe(2);
    expect(typeof reputation.payload.score).toBe('number');
  });

  it('rejects non-owners (member 403, anonymous 401)', async () => {
    const stranger = await registerUser(t.app);
    expect((await exportAs(stranger.token)).statusCode).toBe(403);

    // 成员（builder）同样 403 —— 导出限定 owner。
    const member = await registerUser(t.app);
    const added = await t.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { userId: member.id, role: 'builder' },
    });
    expect(added.statusCode).toBe(201);
    expect((await exportAs(member.token)).statusCode).toBe(403);

    const anonymous = await t.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/training-export`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('audits the export in command_log', async () => {
    const res = await exportAs(owner.token);
    expect(res.statusCode).toBe(200);
    const rows = t.app.commandLogStore.listForEnv(envId, { kind: 'training-export' });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(payload.action).toBe('exported');
    expect(payload.objectId).toBe(envId);
    expect(rows[0].actor_id).toBe(owner.id);
  });

  it('filters by simId and by the [from, to) window', async () => {
    // 另一个仿真（也产生 1 条决策）不应出现在 simId 过滤的导出里。
    const other = await t.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const otherId = other.json().id as string;
    await t.app.inject({ method: 'POST', url: `/api/simulations/${otherId}/start`, headers: auth(owner.token), payload: { speed: 1 } });
    await t.app.inject({
      method: 'POST',
      url: `/api/simulations/${otherId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a' },
    });
    await t.app.inject({ method: 'POST', url: `/api/simulations/${otherId}/stop`, headers: auth(owner.token) });

    const filtered = await exportAs(owner.token, `?simId=${simId}`);
    expect(filtered.statusCode).toBe(200);
    const lines = parseNdjson(filtered.body);
    const simRecords = lines.filter(line => line.simId !== null);
    expect(simRecords.length).toBeGreaterThan(0);
    expect(new Set(simRecords.map(line => line.simId))).toEqual(new Set([simId]));

    // 未来窗口：时序记录全被过滤，只剩 manifest + reputation-snapshot。
    const future = await exportAs(owner.token, `?from=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`);
    const futureKinds = new Set(parseNdjson(future.body).map(line => line.kind));
    expect(futureKinds).toEqual(new Set(['manifest', 'reputation-snapshot']));

    const bad = await exportAs(owner.token, '?from=not-a-date');
    expect(bad.statusCode).toBe(400);
  });

  it('T-008: rejects unknown query params (?sim= typo used to return the FULL dataset)', async () => {
    // `?sim=` is the natural typo for `?simId=` — it used to be silently
    // ignored, exporting every simulation's records to a caller who asked
    // for one.
    const res = await exportAs(owner.token, `?sim=${simId}`);
    expect(res.statusCode).toBe(400);
    const message = res.json().error.message as string;
    expect(message).toContain('"sim"');
    expect(message).toContain('simId');
    // Accepted params keep working.
    expect((await exportAs(owner.token, `?simId=${simId}&format=sft`)).statusCode).toBe(200);
  });

  it('T-008: a simId filter that matches nothing gets a manifest note (not a silent empty export)', async () => {
    const res = await exportAs(owner.token, '?simId=sim-ghost');
    expect(res.statusCode).toBe(200);
    const lines = parseNdjson(res.body);
    const manifest = lines[0];
    // simId 过滤只作用于盘上仿真记录；DB 侧（usage/reputation）照导。
    expect(new Set(lines.slice(1).map(line => line.kind))).toEqual(
      new Set(['usage', 'reputation-snapshot']),
    );
    expect(manifest.payload.notes).toBeDefined();
    expect(JSON.stringify(manifest.payload.notes)).toContain('sim-ghost');
    expect(JSON.stringify(manifest.payload.notes)).toContain('matched no simulation directory');
    // A matching filter produces no note.
    const match = await exportAs(owner.token, `?simId=${simId}`);
    expect((parseNdjson(match.body)[0].payload as { notes?: unknown }).notes).toBeUndefined();
  });

  it('eval-report aggregates the 1-event 1-decision 1-handshake run', async () => {
    // 效果回检切片来自运行时 reputation 追踪器（Fix-12 的落点）。
    t.app.simulations.getOrThrow(simId).runtime.loadReputationJSON({
      version: 1,
      records: [
        { agentId, capability: 'temperature-control', attempts: 2, successes: 1, failures: 1, lastAt: Date.now() },
      ],
    });

    // T-015: by-id sim reads follow Fix-47 — read as the sim's creator.
    const res = await t.app.inject({ method: 'GET', url: `/api/simulations/${simId}/eval-report`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.simId).toBe(simId);
    expect(report.environmentId).toBe(envId);
    expect(report.state).toBe('stopped');
    expect(report.events).toBe(1);
    expect(report.decisions.total).toBe(1);
    expect(report.decisions.bySource).toEqual({ rule: 1 });
    expect(report.handshakes).toEqual({
      initiated: 1,
      succeeded: 1,
      // FEAT-04: accepted-but-unmetered 计数（本轮 accept 无 context 面，
      // 不可判定 → 不入桶）。
      succeededUnmetered: 0,
      failed: 0,
      // R100: 取消单列计数（本轮无取消）。
      cancelled: 0,
      successRate: 1,
      // R5-F05: 发起去重取消拆分（本轮无取消）。
      cancelledByCoordinator: 0,
      negotiationSuccessRate: 1,
      // R2 T5: 失败归因分解（本轮 succeeded=1，无失败可归因）。
      failures: {
        total: 0,
        byCause: {
          'no-partner': 0,
          'abandoned-before-response': 0,
          'all-rejected': 0,
          timeout: 0,
          superseded: 0,
          aborted: 0,
          pendingAtSampling: 0,
        },
      },
    });
    expect(report.effectChecks).toEqual({
      // T71 (R8, u1-F3): counts are integer EVENT buckets — partial owns its
      // bucket (0 here), never a 0.5 leaking into successes/failures.
      attempts: 2, successes: 1, partial: 0, failures: 1, passRate: 0.5,
      // R100: device-execution 真实设备调用切片（本轮无回执记录）。
      deviceExecutions: { attempts: 0, successes: 0, failures: 0 },
      // UX-02: 失败下钻（本轮无 device-execution 回执、无 goalAchieved=false
      // 决策记录——reputation 失败桶来自聚合行，无 trajectory 痕迹可指）。
      failureBreakdown: {
        byKind: { 'device-execution': 0, 'goal-unachieved': 0 },
        byCause: {},
        records: [],
      },
    });
    expect(report.reputation.totals).toEqual({ attempts: 2, successes: 1, partial: 0, failures: 1 });
    expect(report.reputation.agents).toEqual([
      { agentId, attempts: 2, successes: 1, partial: 0, failures: 1 },
    ]);
  });

  it('eval-report marks a rejected handshake as failed and 404s unknown sims', async () => {
    const sim = await t.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const id = sim.json().id as string;
    const filePath = t.app.simulations.getOrThrow(id).runtime.getTrajectoryFilePath() as string;
    // P2 分段日志：目录惰性创建，手写夹具先建目录。
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(
      filePath,
      JSON.stringify({
        recordedAt: new Date().toISOString(),
        scenario: envId,
        condition: 'engine-runtime',
        iteration: 0,
        eventId: 'evt-ac-2',
        agentId: 'partner-agent',
        kind: 'collaboration-response',
        collaborationId: 'ac-2',
        context: { capabilities: [], partnerServices: [], partnerServicesTotal: 0 },
        decision: 'reject',
        decisionSource: 'rule',
        groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
        correct: false,
      }) + '\n',
    );

    const res = await t.app.inject({ method: 'GET', url: `/api/simulations/${id}/eval-report`, headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().handshakes).toEqual({
      initiated: 1,
      succeeded: 0,
      // FEAT-04: 无成功握手，unmetered 桶恒 0。
      succeededUnmetered: 0,
      failed: 1,
      // R100: 取消单列计数（reject 不是 cancelled）。
      cancelled: 0,
      successRate: 0,
      // R5-F05: 无赢家接住的取消 = 真失败，不计入 cancelledByCoordinator。
      cancelledByCoordinator: 0,
      negotiationSuccessRate: 0,
      // R2 T5: 有 reject 应答的失败握手归 all-rejected。
      failures: {
        total: 1,
        byCause: {
          'no-partner': 0,
          'abandoned-before-response': 0,
          'all-rejected': 1,
          timeout: 0,
          superseded: 0,
          aborted: 0,
          pendingAtSampling: 0,
        },
      },
    });
    expect(res.json().decisions.total).toBe(0);
    expect(res.json().decisions.accuracy).toBeNull();

    const missing = await t.app.inject({ method: 'GET', url: '/api/simulations/sim-nope/eval-report' });
    expect(missing.statusCode).toBe(404);
  });
});
