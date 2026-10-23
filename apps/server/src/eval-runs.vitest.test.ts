/**
 * @vitest-environment node
 *
 * Wave-3a 批量评估 runner（eval-runs）全流程：
 * - 提交 → 异步串行执行 → GET 聚合结果：rule-only 跑 2 个 run，断言
 *   per-run 指标（与单跑 eval-report 同口径）与跨 run 对比表结构；
 * - T-016 列表端点 GET /api/environments/:id/eval-runs：摘要行（arms/
 *   metricsDigest）+ newest first + 与 by-id 同门的权限；
 * - 每次 run 创建的仿真仍可查单跑 eval-report（source=registry）；
 * - 权限：匿名 401、非成员 403、viewer 成员可提交（实验工具）；
 * - 审计：创建落 command_log（kind='eval-run'）；
 * - 规格校验：空 runs / 重复 label / 未定义的 prompt 变体 → 400。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
} from './test-utils.js';

const SPEC = {
  runs: [
    { label: 'rule-a', llmClient: 'none', steps: 5 },
    { label: 'rule-b', llmClient: 'none', steps: 5 },
  ],
  events: [
    { type: 'temperature-spike', zoneId: 'zone-a', value: 35, severity: 'high' },
  ],
};

describe('eval-runs 批量评估（Wave-3a）', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createEnv(token: string, id = 'eval-runs-env'): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(token),
      payload: importableScenario(id),
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function submit(envId: string, token: string, spec: unknown = SPEC) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/eval-runs`,
      headers: auth(token),
      payload: spec,
    });
  }

  async function getJob(id: string, token: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/eval-runs/${id}`,
      headers: auth(token),
    });
  }

  it('全流程：rule-only 跑 2 个 run，聚合结构 + 对比表 + 单跑报告可查', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token);

    const created = await submit(envId, owner.token);
    expect(created.statusCode).toBe(201);
    const job = created.json();
    expect(job.status).toBe('pending');
    expect(job.envId).toBe(envId);
    expect(job.spec.runs).toHaveLength(2);

    // 等队列排空（等价于批量到达终态），再 GET 聚合结果。
    await ctx.app.evalRunService.drain();
    const done = await getJob(job.id, owner.token);
    expect(done.statusCode).toBe(200);
    const body = done.json();
    expect(body.status).toBe('done');
    expect(body.startedAt).not.toBeNull();
    expect(body.finishedAt).not.toBeNull();

    const { result } = body;
    expect(result.envId).toBe(envId);
    expect(result.runs).toHaveLength(2);
    for (const [i, label] of ['rule-a', 'rule-b'].entries()) {
      const run = result.runs[i];
      expect(run.label).toBe(label);
      expect(run.status).toBe('done');
      expect(run.llm).toBe('rule-only');
      expect(typeof run.simId).toBe('string');
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      // 与单跑 eval-report 同口径的指标。
      expect(run.metrics.decisions.total).toBeGreaterThan(0);
      expect(run.metrics.decisions.bySource).toBeTypeOf('object');
      expect(run.metrics).toHaveProperty('handshakes');
      expect(run.metrics).toHaveProperty('effectChecks');
      expect(run.metrics).toHaveProperty('reputation');

      // 每次 run 的仿真仍可查单跑 eval-report（registry 路径）。T-015：
      // by-id 读跟随 Fix-47 —— run 仿真以提交者身份创建，用同身份读。
      const single = await ctx.app.inject({
        method: 'GET',
        url: `/api/simulations/${run.simId}/eval-report`,
        headers: auth(owner.token),
      });
      expect(single.statusCode).toBe(200);
      expect(single.json().source).toBe('registry');
      expect(single.json().decisions.total).toBe(run.metrics.decisions.total);
    }

    // 跨 run 对比表：labels 顺序对齐，rule-only 的 LLM 占比为 0。
    expect(result.comparison.labels).toEqual(['rule-a', 'rule-b']);
    expect(result.comparison.metrics.decisions).toHaveLength(2);
    expect(result.comparison.metrics.llmShare).toEqual([0, 0]);
    expect(result.comparison.metrics.handshakeSuccessRate).toHaveLength(2);
    expect(result.comparison.metrics.effectCheckPassRate).toHaveLength(2);
    expect(result.comparison.metrics.reputationAttempts).toHaveLength(2);
  });

  it('atSimTimeSec 调度 + llmModel/promptVariant 透传（rule-only 下安全降级）', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-variants');
    const created = await submit(envId, owner.token, {
      runs: [
        { label: 'base', llmClient: 'none', steps: 3 },
        // llmModel/promptVariant 在 rule-only preset 下被忽略但如实记录。
        { label: 'variant', llmClient: 'none', llmModel: 'qwen3:8b', llmPromptVariant: 'v2', steps: 3 },
      ],
      events: [
        { type: 'temperature-spike', zoneId: 'zone-a', value: 33, atSimTimeSec: 4 },
        { type: 'temperature-spike', zoneId: 'zone-a', value: 36, atSimTimeSec: 8 },
      ],
      promptVariants: { v2: 'You are a strict AC decider. Answer JSON only.' },
    });
    expect(created.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();
    const body = (await getJob(created.json().id, owner.token)).json();
    expect(body.status).toBe('done');
    const [base, variant] = body.result.runs;
    expect(base.status).toBe('done');
    expect(variant.status).toBe('done');
    expect(variant.llmModel).toBe('qwen3:8b');
    expect(variant.llmPromptVariant).toBe('v2');
    // 两个调度事件都被注入并产生决策。
    expect(base.metrics.events).toBe(2);
  });

  it('权限：匿名 401、非成员 403、viewer 成员可提交、非成员 GET 403、未知 id 404', async () => {
    const owner = await registerUser(ctx.app);
    const stranger = await registerUser(ctx.app);
    const viewer = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-acl');
    // owner 拉 viewer 进环境。
    const add = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { email: viewer.email, role: 'viewer' },
    });
    expect(add.statusCode).toBeLessThan(300);

    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/eval-runs`,
      payload: SPEC,
    });
    expect(anonymous.statusCode).toBe(401);

    expect((await submit(envId, stranger.token)).statusCode).toBe(403);
    // viewer 也可以提交（实验工具，只创建隔离仿真）。
    const byViewer = await submit(envId, viewer.token);
    expect(byViewer.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();

    const jobId = byViewer.json().id as string;
    expect((await getJob(jobId, stranger.token)).statusCode).toBe(403);
    expect((await getJob(jobId, viewer.token)).statusCode).toBe(200);
    const anonymousGet = await ctx.app.inject({ method: 'GET', url: `/api/eval-runs/${jobId}` });
    expect(anonymousGet.statusCode).toBe(401);
    expect((await getJob('evalrun-nope', owner.token)).statusCode).toBe(404);
  });

  it('审计：创建落 command_log（kind=eval-run）', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-audit');
    const created = await submit(envId, owner.token);
    expect(created.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();

    const entries = ctx.app.commandLogStore.listForEnv(envId, { kind: 'eval-run' });
    expect(entries).toHaveLength(1);
    const payload = JSON.parse(entries[0].payload_json);
    expect(payload.evalRunId).toBe(created.json().id);
    expect(payload.runs).toEqual([
      { label: 'rule-a', llmClient: 'none', llmModel: null, llmPromptVariant: null, agentOverrides: null },
      { label: 'rule-b', llmClient: 'none', llmModel: null, llmPromptVariant: null, agentOverrides: null },
    ]);
    expect(payload.events).toBe(1);
    expect(entries[0].actor_id).toBe(owner.id);
  });

  it('T-016 列表端点：摘要行 + newest first + 权限同 by-id', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-list');

    // 两个先后提交的批量（等第一个 drain 完再提交第二个，保证时间戳有序）。
    const first = await submit(envId, owner.token);
    expect(first.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();
    const second = await submit(envId, owner.token);
    expect(second.statusCode).toBe(201);
    // 第二个还在队列里 → 列表能看到 pending 行（metricsDigest 全 null）。
    const duringList = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/eval-runs`,
      headers: auth(owner.token),
    });
    expect(duringList.statusCode).toBe(200);
    const during = duringList.json().runs as Array<Record<string, unknown>>;
    expect(during).toHaveLength(2);
    expect(during[0].id).toBe(second.json().id);
    // 还在队列里（提交后立即被 executor 领走也是 running）——digest 全 null。
    expect(['pending', 'running']).toContain(during[0].status);
    expect(during[0].arms).toBe(2);
    expect(during[0].metricsDigest).toEqual({
      decisionAccuracy: null,
      handshakeSuccessRate: null,
      effectCheckPassRate: null,
    });

    await ctx.app.evalRunService.drain();

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/eval-runs`,
      headers: auth(owner.token),
    });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json().runs as Array<Record<string, unknown>>;
    // newest first：第二个批量在前。
    expect(rows.map(row => row.id)).toEqual([second.json().id, first.json().id]);
    expect(rows.every(row => row.envId === envId)).toBe(true);
    // drain 完的两个批量都是 done，摘要行带跨 run 均值的 digest。
    expect(rows.every(row => row.status === 'done')).toBe(true);
    expect(rows.every(row => row.arms === 2)).toBe(true);
    for (const row of rows) {
      expect(row.createdAt).toBeTypeOf('string');
      expect(row.startedAt).not.toBeNull();
      expect(row.finishedAt).not.toBeNull();
      const digest = row.metricsDigest as Record<string, unknown>;
      expect(Object.keys(digest).sort()).toEqual([
        'decisionAccuracy',
        'effectCheckPassRate',
        'handshakeSuccessRate',
      ]);
      // 与 by-id 的 comparison 同口径：均值要么是 number，要么全 null。
      for (const value of Object.values(digest)) {
        expect(['number', 'object']).toContain(typeof value);
      }
    }
    // by-id 对齐抽查：摘要均值 = comparison 数组的均值。
    const detail = (await getJob(second.json().id as string, owner.token)).json();
    const accuracy = detail.result.comparison.metrics.accuracy as Array<number | null>;
    const expected = accuracy.filter((v): v is number => v !== null)
      .reduce((sum, v) => sum + v, 0) / accuracy.filter(v => v !== null).length;
    expect((rows[0].metricsDigest as { decisionAccuracy: number }).decisionAccuracy).toBeCloseTo(
      expected,
      10,
    );

    // 权限与 by-id 同门：匿名 401、非成员 403、viewer 成员 200、环境不存在 404。
    const stranger = await registerUser(ctx.app);
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/eval-runs`,
    });
    expect(anonymous.statusCode).toBe(401);
    const strangerList = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/eval-runs`,
      headers: auth(stranger.token),
    });
    expect(strangerList.statusCode).toBe(403);
    const viewer = await registerUser(ctx.app);
    const add = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { email: viewer.email, role: 'viewer' },
    });
    expect(add.statusCode).toBeLessThan(300);
    const viewerList = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/eval-runs`,
      headers: auth(viewer.token),
    });
    expect(viewerList.statusCode).toBe(200);
    expect(((viewerList.json().runs as unknown[]).length)).toBe(2);
    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/env-nope/eval-runs`,
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ENVIRONMENT_NOT_FOUND');
  });

  it('规格校验：空 runs / 重复 label / 未定义 prompt 变体 → 400', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-400');

    expect((await submit(envId, owner.token, { runs: [], events: [] })).statusCode).toBe(400);
    expect(
      (await submit(envId, owner.token, {
        runs: [{ label: 'x' }, { label: 'x' }],
        events: [],
      })).statusCode,
    ).toBe(400);
    expect(
      (await submit(envId, owner.token, {
        runs: [{ label: 'x', llmPromptVariant: 'ghost' }],
        events: [],
        promptVariants: { v1: 'prompt' },
      })).statusCode,
    ).toBe(400);
    expect(
      (await submit(envId, owner.token, {
        runs: [{ label: 'x' }],
        events: [{ zoneId: 'zone-a' }],
      })).statusCode,
    ).toBe(400);
    // agentOverrides：同 run 内重复 agentId / capabilities 非字符串数组 → 400。
    expect(
      (await submit(envId, owner.token, {
        runs: [{ label: 'x', agentOverrides: [{ agentId: 'a' }, { agentId: 'a' }] }],
        events: [],
      })).statusCode,
    ).toBe(400);
    expect(
      (await submit(envId, owner.token, {
        runs: [{ label: 'x', agentOverrides: [{ agentId: 'a', capabilities: 'cooling' }] }],
        events: [],
      })).statusCode,
    ).toBe(400);
  });

  it('Wave-3b agentOverrides：只作用于该 run 的 scenario 副本，真实世界不变', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-ab');
    const agentRow = ctx.app.envStore.agentsOf(envId)[0];
    const originalCapabilities = JSON.parse(agentRow.capabilities_json) as string[];

    const created = await submit(envId, owner.token, {
      runs: [
        {
          label: 'variant-b',
          llmClient: 'none',
          steps: 3,
          agentOverrides: [
            { agentId: agentRow.id, capabilities: ['cooling'], llmModel: 'qwen3:8b', systemPrompt: 'You are variant B.' },
          ],
        },
        { label: 'baseline', llmClient: 'none', steps: 3 },
      ],
      events: [{ type: 'temperature-spike', zoneId: 'zone-a', value: 35, severity: 'high' }],
    });
    expect(created.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();
    const body = (await getJob(created.json().id, owner.token)).json();
    expect(body.status).toBe('done');
    const [variant, baseline] = body.result.runs;
    expect(variant.status).toBe('done');
    expect(baseline.status).toBe('done');

    // 覆盖回声（审计/复现）。
    expect(variant.agentOverrides).toEqual([
      { agentId: agentRow.id, capabilities: ['cooling'], llmModel: 'qwen3:8b', systemPrompt: 'You are variant B.' },
    ]);
    expect(baseline.agentOverrides).toBeUndefined();

    // 该 run 的 scenario 副本生效：variant 仿真里的 agent 能力已被替换；
    // baseline 仿真保持原样。
    const variantAgent = ctx.app.simulations
      .getOrThrow(variant.simId)
      .runtime.getSnapshot()
      .agents.find(a => a.id === agentRow.id)!;
    expect(variantAgent.capabilities).toEqual(['cooling']);
    const baselineAgent = ctx.app.simulations
      .getOrThrow(baseline.simId)
      .runtime.getSnapshot()
      .agents.find(a => a.id === agentRow.id)!;
    expect(baselineAgent.capabilities).toEqual(originalCapabilities);

    // 真实世界（环境实例行）不动。
    const after = ctx.app.envStore.agentsOf(envId)[0];
    expect(JSON.parse(after.capabilities_json)).toEqual(originalCapabilities);
    expect(after.llm_json).toBe(agentRow.llm_json);
  });

  it('Wave-3b agentOverrides：引用不存在的 agentId → 该 run failed，批量继续', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-ab-404');
    const created = await submit(envId, owner.token, {
      runs: [
        { label: 'bad', llmClient: 'none', steps: 3, agentOverrides: [{ agentId: 'agent-nope' }] },
        { label: 'good', llmClient: 'none', steps: 3 },
      ],
      events: [{ type: 'temperature-spike', zoneId: 'zone-a' }],
    });
    expect(created.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();
    const body = (await getJob(created.json().id, owner.token)).json();
    expect(body.status).toBe('done');
    const [bad, good] = body.result.runs;
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('agent-nope');
    expect(good.status).toBe('done');
  });

  it('T-008：未知字段拒绝（不再静默丢弃），带改名提示与接受列表', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-unknown-fields');

    // 顶层：prompts → promptVariants。
    const top = await submit(envId, owner.token, {
      runs: [{ label: 'x' }],
      events: [],
      prompts: { v1: 'p' },
    });
    expect(top.statusCode).toBe(400);
    expect(top.json().error.message).toContain('"prompts"');
    expect(top.json().error.message).toContain('promptVariants');

    // runs[]：model → llmModel（A/B 工具里静默丢 model 意味着比较噪声）。
    const model = await submit(envId, owner.token, {
      runs: [{ label: 'x', model: 'qwen3:8b' }],
      events: [],
    });
    expect(model.statusCode).toBe(400);
    expect(model.json().error.message).toContain('"model"');
    expect(model.json().error.message).toContain('llmModel');

    // runs[]：step → steps。
    const step = await submit(envId, owner.token, {
      runs: [{ label: 'x', step: 5 }],
      events: [],
    });
    expect(step.statusCode).toBe(400);
    expect(step.json().error.message).toContain('steps');

    // events[]：simTimeSec → atSimTimeSec（拼错曾把调度点静默变成"立即注入"）。
    const simTime = await submit(envId, owner.token, {
      runs: [{ label: 'x' }],
      events: [{ type: 'temperature-spike', zoneId: 'zone-a', simTimeSec: 3 }],
    });
    expect(simTime.statusCode).toBe(400);
    expect(simTime.json().error.message).toContain('"simTimeSec"');
    expect(simTime.json().error.message).toContain('atSimTimeSec');

    // agentOverrides[]：caps → capabilities。
    const caps = await submit(envId, owner.token, {
      runs: [{ label: 'x', agentOverrides: [{ agentId: 'a', caps: ['cooling'] }] }],
      events: [],
    });
    expect(caps.statusCode).toBe(400);
    expect(caps.json().error.message).toContain('"caps"');
    expect(caps.json().error.message).toContain('capabilities');

    // 完整 injectEvent 形状（humanNarrative 等）仍被接受。
    const ok = await submit(envId, owner.token, {
      runs: [{ label: 'narrative', llmClient: 'none', steps: 2 }],
      events: [
        {
          type: 'temperature-spike',
          zoneId: 'zone-a',
          severity: 'high',
          atSimTimeSec: 1,
          humanNarrative: '机房温度飙升',
          focusZoneId: 'zone-a',
        },
      ],
    });
    expect(ok.statusCode).toBe(201);
    // 排空队列（否则 afterEach 关库后串行队列的 execute 会撞上已关闭的 DB）。
    await ctx.app.evalRunService.drain();
    const done = (await getJob(ok.json().id, owner.token)).json();
    expect(done.status).toBe('done');
    expect(done.result.runs[0].status).toBe('done');
  });

  it('T-008：环境删除 → 任务行级联清除，GET 返回 404 EVAL_RUN_NOT_FOUND', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(owner.token, 'eval-runs-env-deleted');
    const created = await submit(envId, owner.token);
    expect(created.statusCode).toBe(201);
    await ctx.app.evalRunService.drain();
    expect((await getJob(created.json().id, owner.token)).statusCode).toBe(200);

    // eval_runs.env_id ON DELETE CASCADE：环境删除带走任务行（不会留下
    // 报 403"非成员"的孤儿行）。
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBeLessThan(300);
    const res = await getJob(created.json().id, owner.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('EVAL_RUN_NOT_FOUND');
  });
});
