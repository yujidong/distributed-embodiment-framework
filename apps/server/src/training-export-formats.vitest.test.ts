/**
 * @vitest-environment node
 *
 * Wave-3b 训练格式对齐：`GET /api/environments/:id/training-export?format=sft|dpo`
 *
 * - sft：decision 记录 → {instruction, response, meta}。只收
 *   decisionSource=llm 的记录；instruction 优先 LLM 实见 userPrompt，缺省
 *   退化 trajectory context 摘要；两者皆无跳过并计数（manifest.counts）。
 * - dpo：{prompt, chosen, rejected, meta} 偏好对——构造有效果
 *   （goalAchieved=true）/无效果（goalAchieved=false）两条同 agent 同事件
 *   类型的决策，断言 chosen/rejected；配不上对的成功记录单独输出 chosen
 *   （rejected=null）。配对规则写在 manifest.payload.pairing。
 * - 权限/审计与原始导出一致（owner-only + command_log，payload 带 format）。
 *
 * 决策记录手写落盘（与 Fix-22 套件一致的诚实接缝：文件格式归 core
 * TrajectoryRecorder 所有）；仿真只用于取得 trajectory 目录。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

describe('Wave-3b training-export 训练视图（format=sft|dpo）', () => {
  let t: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let agentId: string;

  function llmDecision(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      recordedAt: new Date(T0).toISOString(),
      scenario: envId,
      condition: 'engine-runtime',
      iteration: 0,
      eventId: 'evt-x',
      agentId,
      context: { capabilities: ['cooling'], partnerServices: [], partnerServicesTotal: 0 },
      decision: 'handle_independently',
      decisionSource: 'llm',
      reasoning: '温度超标，独立处理',
      groundTruth: { correctDecision: 'unknown', interactionType: 'temperature-response' },
      correct: false,
      ...overrides,
    }) + '\n';
  }

  beforeEach(async () => {
    t = await makeTestApp();
    owner = await registerUser(t.app);

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: importableScenario('wave3b-env'),
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
    const filePath = t.app.simulations.getOrThrow(sim.json().id).runtime.getTrajectoryFilePath();
    expect(filePath).not.toBeNull();
    // P2 分段日志：目录惰性创建，手写夹具先建目录。
    mkdirSync(dirname(filePath as string), { recursive: true });

    // 1. LLM 决策：完整 prompt（instruction 应取 userPrompt）+ 有效果。
    appendFileSync(
      filePath as string,
      llmDecision({
        recordedAt: new Date(T0).toISOString(),
        eventId: 'evt-s1',
        decision: 'initiate_ac',
        reasoning: '需要 cooling 伙伴协作',
        prompt: { systemPrompt: 'sys', userPrompt: '事件 temperature-spike @ zone-a；zone 温度 35°C；可用能力 [cooling]；伙伴 []' },
        goalAchieved: true,
        model: 'qwen3:8b',
      }),
    );
    // 2. LLM 决策：无 prompt（instruction 退化 context 摘要）+ 无效果。
    appendFileSync(
      filePath as string,
      llmDecision({
        recordedAt: new Date(T0 + 10_000).toISOString(),
        eventId: 'evt-s2',
        decision: 'initiate_ac',
        reasoning: '再次尝试协作',
        goalAchieved: false,
      }),
    );
    // 3. rule 决策：SFT 不收（filteredNonLlm）；DPO 里是另一事件类型的
    //    有效果决策 → 配不上对，单独输出 chosen。
    appendFileSync(
      filePath as string,
      llmDecision({
        recordedAt: new Date(T0 + 20_000).toISOString(),
        eventId: 'evt-s3',
        decisionSource: 'rule',
        decision: 'handle_independently',
        reasoning: '规则命中',
        goalAchieved: true,
        groundTruth: { correctDecision: 'unknown', interactionType: 'other-type' },
      }),
    );
    // 4. LLM 决策：prompt 与 context 皆缺 → 两种格式都跳过并计数。
    appendFileSync(
      filePath as string,
      llmDecision({
        recordedAt: new Date(T0 + 30_000).toISOString(),
        eventId: 'evt-s4',
        context: undefined,
        goalAchieved: true,
      }),
    );
  });

  afterEach(async () => {
    await t.cleanup();
  });

  function parseNdjson(body: string): Array<Record<string, unknown>> {
    return body
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }

  async function exportAs(qs: string) {
    return t.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/training-export${qs}`,
      headers: auth(owner.token),
    });
  }

  it('format=sft：LLM 决策 → instruction/response 对，跳过与过滤如实计数', async () => {
    const res = await exportAs('?format=sft');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const lines = parseNdjson(res.body);
    const manifest = lines[0];
    expect(manifest.kind).toBe('manifest');
    const payload = manifest.payload as {
      format: string;
      fields: Record<string, string>;
      counts: Record<string, number>;
      environment: { id: string };
    };
    expect(payload.format).toBe('sft');
    expect(payload.fields).toHaveProperty('instruction');
    expect(payload.fields).toHaveProperty('response');
    expect(payload.environment.id).toBe(envId);
    // 2 条 LLM 且上下文可用的决策出样；rule 决策过滤；缺上下文跳过。
    expect(payload.counts).toEqual({ samples: 2, skippedNoContext: 1, filteredNonLlm: 1 });

    const [s1, s2] = lines.slice(1) as Array<{
      instruction: string;
      response: string;
      meta: Record<string, unknown>;
    }>;
    // 样本 1：instruction = LLM 实见的 userPrompt（含事件/zone/能力上下文）。
    expect(s1.instruction).toContain('temperature-spike');
    expect(s1.instruction).toContain('zone-a');
    expect(s1.instruction).toContain('cooling');
    expect(s1.response).toContain('Decision: initiate_ac');
    expect(s1.response).toContain('Reasoning: 需要 cooling 伙伴协作');
    expect(s1.meta).toMatchObject({ agentId, eventId: 'evt-s1', decisionSource: 'llm', model: 'qwen3:8b' });
    // 样本 2：无 prompt → 退化 context 摘要（JSON，含能力/事件 id）。
    expect(s2.instruction).toContain('evt-s2');
    expect(JSON.parse(s2.instruction).capabilities).toEqual(['cooling']);
    expect(s2.response).toContain('Reasoning: 再次尝试协作');

    // 审计：payload 带 format。
    const rows = t.app.commandLogStore.listForEnv(envId, { kind: 'training-export' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json).format).toBe('sft');
  });

  it('format=dpo：有效果 vs 无效果配对为 chosen/rejected；孤立成功单独输出 chosen', async () => {
    const res = await exportAs('?format=dpo');
    expect(res.statusCode).toBe(200);

    const lines = parseNdjson(res.body);
    const manifest = lines[0];
    const payload = manifest.payload as {
      format: string;
      pairing: { rule: string; windowMs: number; outcome: string };
      counts: Record<string, number>;
    };
    expect(payload.format).toBe('dpo');
    // 配对规则简单透明，写进 manifest。
    expect(payload.pairing.rule).toContain('agentId');
    expect(payload.pairing.rule).toContain('interactionType');
    expect(payload.pairing.windowMs).toBe(3_600_000);
    expect(payload.pairing.outcome).toContain('goalAchieved');
    expect(payload.counts).toEqual({
      pairs: 1,
      chosenOnly: 1,
      unpairedRejected: 0,
      skippedNoOutcome: 0,
      skippedNoContext: 1,
    });

    const records = lines.slice(1) as Array<{
      prompt: string;
      chosen: string;
      rejected: string | null;
      meta: Record<string, unknown>;
    }>;
    expect(records).toHaveLength(2);

    const pair = records.find(r => r.rejected !== null)!;
    expect(pair.meta).toMatchObject({
      agentId,
      eventType: 'temperature-response',
      chosenEventId: 'evt-s1',
      rejectedEventId: 'evt-s2',
    });
    // chosen = 有效果（goalAchieved=true）的决策 + 理由；rejected = 无效果的。
    expect(pair.chosen).toContain('Decision: initiate_ac');
    expect(pair.chosen).toContain('需要 cooling 伙伴协作');
    expect(pair.rejected).toContain('再次尝试协作');
    expect(pair.prompt).toContain('temperature-spike');

    // 配不上对的成功记录（rule 决策、另一事件类型）：单独输出 chosen。
    const solo = records.find(r => r.rejected === null)!;
    expect(solo.chosen).toContain('规则命中');
    expect(solo.meta).toMatchObject({ agentId, eventType: 'other-type', chosenEventId: 'evt-s3' });
  });

  it('format=structured：完整 CognitiveDecision 对作为 response；缺 cognitiveDecision 的记录如实跳过', async () => {
    // 追加一条 Phase-1 轨迹：LLM 决策携带完整 cognitiveDecision。
    const sim2 = await t.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim2.statusCode).toBe(201);
    const filePath2 = t.app.simulations.getOrThrow(sim2.json().id).runtime.getTrajectoryFilePath();
    mkdirSync(dirname(filePath2 as string), { recursive: true });
    appendFileSync(
      filePath2 as string,
      llmDecision({
        recordedAt: new Date(T0 + 40_000).toISOString(),
        eventId: 'evt-cog',
        decision: 'handle_independently',
        reasoning: 'Own HVAC covers the zone.',
        prompt: { systemPrompt: 'sys', userPrompt: 'cognitive prompt for evt-cog' },
        groundTruth: { correctDecision: 'handle_independently', interactionType: 'A' },
        correct: true,
        cognitiveDecision: {
          situation: { type: 'anomaly', severity: 3, affectedZones: ['zone-a'], rootCauseHypothesis: 'heat load', confidence: 0.8 },
          goals: [{ goal: 'maintain_comfort', priority: 1 }],
          actionPlan: { primary: {
            action: 'handle_independently',
            reasoning: 'own devices cover it',
            deviceActions: [{ deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } }],
          } },
          explanation: { summary: 'Own HVAC covers the zone.', factors: [{ name: 'comfort', weight: 0.8 }] },
          collaboration: { needed: false },
          uncertainty: { overall: 0.2, dataQuality: 0.9, riskFactors: ['sensor_calibration'] },
        },
      }),
    );

    const res = await exportAs('?format=structured&simId=' + sim2.json().id);
    expect(res.statusCode).toBe(200);

    const lines = parseNdjson(res.body);
    const manifest = lines[0];
    const payload = manifest.payload as {
      format: string;
      fields: Record<string, string>;
      counts: Record<string, number>;
    };
    expect(payload.format).toBe('structured');
    expect(payload.fields).toHaveProperty('instruction');
    expect(payload.fields.response).toContain('CognitiveDecision');
    // 1 个样本；其余按原因计数（Phase-1 前轨迹 / rule 决策如实跳过）。
    expect(payload.counts).toEqual({
      samples: 1, templatedPrecheck: 0, skippedNoContext: 0, filteredNonLlm: 0, skippedNoCognitive: 0,
    });

    const [sample] = lines.slice(1) as Array<{
      instruction: string;
      response: Record<string, unknown>;
      meta: Record<string, unknown>;
    }>;
    expect(sample.instruction).toContain('cognitive prompt for evt-cog');
    // response 是完整 CognitiveDecision 对象（多字段标签）。
    const cd = sample.response as {
      situation: { type: string; severity: number };
      actionPlan: { primary: { action: string; deviceActions: unknown[] } };
      explanation: { factors: unknown[] };
      uncertainty: { riskFactors: string[] };
    };
    expect(cd.situation.type).toBe('anomaly');
    expect(cd.situation.severity).toBe(3);
    expect(cd.actionPlan.primary.action).toBe('handle_independently');
    expect(cd.actionPlan.primary.deviceActions).toEqual([
      { deviceId: 'hvac-1', command: 'set-temperature', params: { targetTemperature: 24 } },
    ]);
    expect(cd.explanation.factors).toEqual([{ name: 'comfort', weight: 0.8 }]);
    expect(cd.uncertainty.riskFactors).toEqual(['sensor_calibration']);
    // meta 携带派生 legacy 决策 + ground truth（label-consistency gate 消费）。
    expect(sample.meta).toMatchObject({
      agentId,
      eventId: 'evt-cog',
      legacyDecision: 'handle_independently',
      groundTruth: { correctDecision: 'handle_independently', interactionType: 'A' },
      correct: true,
    });
  });

  it('format=structured 对缺 cognitiveDecision 的旧轨迹如实计数（不臆造字段）', async () => {
    // 独立仿真：两条旧格式记录（LLM 无 cognitiveDecision + rule 决策）。
    const sim3 = await t.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim3.statusCode).toBe(201);
    const filePath3 = t.app.simulations.getOrThrow(sim3.json().id).runtime.getTrajectoryFilePath();
    mkdirSync(dirname(filePath3 as string), { recursive: true });
    appendFileSync(filePath3 as string, llmDecision({
      recordedAt: new Date(T0 + 50_000).toISOString(),
      eventId: 'evt-old-llm',
      prompt: { userPrompt: 'binary-era prompt' },
    }));
    appendFileSync(filePath3 as string, llmDecision({
      recordedAt: new Date(T0 + 60_000).toISOString(),
      eventId: 'evt-old-rule',
      decisionSource: 'rule',
    }));

    const res = await exportAs('?format=structured&simId=' + sim3.json().id);
    expect(res.statusCode).toBe(200);

    const lines = parseNdjson(res.body);
    const payload = lines[0].payload as { counts: Record<string, number> };
    expect(payload.counts).toEqual({
      samples: 0, templatedPrecheck: 0, skippedNoContext: 0, filteredNonLlm: 1, skippedNoCognitive: 1,
    });
  });

  it('format=structured：precheck Type-A 短路记录模板化为六区块 templated 对（v5.2 lever-1）', async () => {
    // 独立仿真 + 环境面：绑定一台 zone-a 的设备（带 cooling 命令）与一台
    // 纯传感设备（不进 MY_DEVICES）。
    const env2 = await t.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        meta: { id: 'wave3b-precheck-env', name: 'Precheck Lab', description: 'precheck templating fixture' },
        zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
        devices: [
          { id: 'hvac-a', name: 'HVAC A', type: 'hvac', capabilities: ['cooling', 'temperature-reading'], zoneId: 'zone-a' },
          { id: 'sensor-a', name: 'Sensor A', type: 'sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
        ],
        agents: [{
          id: 'steward-a', name: '楼层管家A', capabilities: ['cooling'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a', 'sensor-a'],
        }],
        events: [],
      },
    });
    expect(env2.statusCode).toBe(201);
    const env2Id = env2.json().id;
    const agent2Id = t.app.envStore.agentsOf(env2Id)[0].id;
    // 导入时设备 id 会重映射——按能力面解析两台设备的新 id。
    const env2Devices = t.app.envStore.devicesOf(env2Id);
    const hvacId = env2Devices.find(d => JSON.parse(d.capabilities_json).includes('cooling'))?.id;
    const sensorId = env2Devices.find(d => !JSON.parse(d.capabilities_json).includes('cooling'))?.id;
    expect(hvacId).toBeDefined();
    expect(sensorId).toBeDefined();

    const sim = await t.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: env2Id },
    });
    expect(sim.statusCode).toBe(201);
    const filePath = t.app.simulations.getOrThrow(sim.json().id).runtime.getTrajectoryFilePath();
    mkdirSync(dirname(filePath as string), { recursive: true });
    appendFileSync(filePath as string, JSON.stringify({
      recordedAt: new Date(T0).toISOString(),
      scenario: env2Id,
      condition: 'engine-runtime',
      iteration: 0,
      eventId: 'evt-pre-a',
      agentId: agent2Id,
      context: {
        capabilities: ['cooling'],
        managedZoneIds: ['zone-a'],
        actuatorZoneIds: ['zone-a'],
        partnerServices: [{ serviceName: 'Partner Cooling', capabilities: ['cooling'], providerAgentId: 'p1' }],
        partnerServicesTotal: 7,
      },
      decision: 'handle_independently',
      decisionSource: 'precheck',
      reasoning: 'Agent has direct actuator coverage in zone-a and all required capabilities (cooling).',
      reasoningCode: 'precheck.independent',
      reasoningParams: { zone: 'zone-a', required: 'cooling' },
      groundTruth: { correctDecision: 'handle_independently', interactionType: 'A' },
      correct: true,
    }) + '\n');
    // 对照：precheck 的 initiate_ac 短路（Type E）不模板化 → filteredNonLlm。
    appendFileSync(filePath as string, JSON.stringify({
      recordedAt: new Date(T0 + 5_000).toISOString(),
      scenario: env2Id,
      condition: 'engine-runtime',
      iteration: 0,
      eventId: 'evt-pre-e',
      agentId: agent2Id,
      context: { capabilities: ['cooling'], partnerServices: [], partnerServicesTotal: 0 },
      decision: 'initiate_ac',
      decisionSource: 'precheck',
      reasoningCode: 'precheck.no_coverage_delegate',
      reasoningParams: { zone: 'zone-b', required: 'cooling' },
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'E' },
      correct: true,
    }) + '\n');

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/environments/${env2Id}/training-export?format=structured&simId=` + sim.json().id,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);

    const lines = parseNdjson(res.body);
    const payload = lines[0].payload as { counts: Record<string, number>; templating: { rule: string } };
    expect(payload.counts).toEqual({
      samples: 1, templatedPrecheck: 1, skippedNoContext: 0, filteredNonLlm: 1, skippedNoCognitive: 0,
    });
    expect(payload.templating.rule).toContain('precheck.independent');

    const [sample] = lines.slice(1) as Array<{
      instruction: string;
      response: Record<string, unknown>;
      meta: Record<string, unknown>;
    }>;
    // instruction 按决策时提示格式重建：agent 名/能力/EVENT_NEEDS/COVERAGE/
    // MY_DEVICES（纯传感设备被剔除）/AVAILABLE_PARTNERS。
    expect(sample.instruction).toContain('AGENT: 楼层管家A');
    expect(sample.instruction).toContain('Caps=[cooling]');
    expect(sample.instruction).toContain('Zone=zone-a');
    expect(sample.instruction).toContain('EVENT_NEEDS:');
    expect(sample.instruction).toContain('cooling');
    expect(sample.instruction).toContain('COVERAGE: DIRECT');
    expect(sample.instruction).toContain('MY_DEVICES');
    expect(sample.instruction).toContain(hvacId as string);
    expect(sample.instruction).not.toContain(sensorId as string);
    expect(sample.instruction).toContain('AVAILABLE_PARTNERS: 1 of 7');
    expect(sample.instruction).toContain('DECISION:');

    // response：完整六区块 CognitiveDecision 模板（handle + zone 内设备动作）。
    const cd = sample.response as {
      situation: { type: string; severity: number; affectedZones: string[] };
      goals: unknown[];
      actionPlan: { primary: { action: string; reasoning: string; deviceActions: Array<{ deviceId: string; command: string }> } };
      explanation: { summary: string; factors: Array<{ name: string }> };
      collaboration: { needed: boolean };
      uncertainty: { overall: number; riskFactors: string[] };
    };
    expect(cd.situation.affectedZones).toEqual(['zone-a']);
    expect(cd.goals).toHaveLength(1);
    expect(cd.actionPlan.primary.action).toBe('handle_independently');
    expect(cd.actionPlan.primary.reasoning).toContain('direct actuator coverage in zone-a');
    // deviceActions 取事件 zone 内可执行设备；命令命中声明需求（cooling）。
    expect(cd.actionPlan.primary.deviceActions).toEqual([{ deviceId: hvacId, command: 'cooling' }]);
    expect(cd.explanation.summary).toContain('templated-precheck');
    expect(cd.explanation.factors.map(f => f.name)).toEqual(['coverage_direct', 'required_capabilities_met']);
    expect(cd.collaboration.needed).toBe(false);
    expect(cd.uncertainty.riskFactors).toEqual(['precheck-context-reconstructed']);

    // meta：templated 标记 + 溯源 + ground truth（label gate 可消费）。
    expect(sample.meta).toMatchObject({
      agentId: agent2Id,
      eventId: 'evt-pre-a',
      decisionSource: 'precheck',
      templated: true,
      source: 'templated-precheck',
      legacyDecision: 'handle_independently',
      groundTruth: { correctDecision: 'handle_independently', interactionType: 'A' },
      correct: true,
    });
  });

  it('format 校验：非法取值 400；缺省保持原始信封流', async () => {
    expect((await exportAs('?format=rlhf')).statusCode).toBe(400);

    const raw = await exportAs('');
    expect(raw.statusCode).toBe(200);
    const lines = parseNdjson(raw.body);
    expect(lines[0].kind).toBe('manifest');
    expect((lines[0].payload as Record<string, unknown>).format).toBeUndefined();
    // 原始流里是信封：4 条手写决策都是 decision kind。
    expect(lines.slice(1).every(line => line.kind === 'decision')).toBe(true);
  });
});
