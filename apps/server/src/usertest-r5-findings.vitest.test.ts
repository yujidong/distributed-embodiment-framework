/**
 * @vitest-environment node
 *
 * usertest-r5 campaign 回归（data/usertest-r5/findings.md）：
 *
 * - R5-F01: PATCH mapData 深合并（zones/events/floorPlans 按 id/floor 合并，
 *   显式 [] 才清空）；zones 从 N>0 清到 0 需要 confirmClearZones: true
 *   （否则 409 MAP_ZONES_CLEAR_UNCONFIRMED）——教程的 demo 化 PATCH 不再
 *   静默摧毁世界。
 * - R5-F02: 服务端 LLM 已配置时，未声明 llm 块的 agent 在 llmClient:'auto'
 *   下缺省沿用共享 client（openapi CreateAgentBody.llm 的承诺兑现）；
 *   显式 llm:null opt-out 保留 rule-only + llmWarning。
 * - R5-F03: agent 属主可直改纯决策配置（llm / decisionPolicy / enabled，
 *   落 command_log）；结构变更仍走 modify-object 提案（403 指路）。
 * - R5-F04: mapData PATCH 白名单补 semanticOfferRules / capabilitySynonyms
 *   （校验与存储层同源），环境详情回读两字段（读-改-写保真），未知键
 *   400 点名而非静默剥除。
 * - R5-F05: eval-report handshakes 拆出 cancelledByCoordinator（发起去重
 *   的机制性取消），另报真实协商成功率 negotiationSuccessRate。
 * - R5-F06: agreements 列表 ?include=terminated 向环境成员开放已
 *   terminated 的合约（默认视图不变）；环境 digest 把"已完成的协作"
 *   列为一等成果（completedCollaborations）。
 * - R5-F09: 从未 active 的 explicit 合约被 terminate 后，digest 与 F08
 *   受限视图的 outcome 记 'cancelled'（共享判定
 *   terminatedAgreementOutcome，v59 activated_at 列），不再误标
 *   'completed'；曾 active 后 terminate 的合约口径不变。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrajectoryRecord } from '@active-collaboration/core';

import { terminatedAgreementOutcome } from './db/agreement-store.js';
import { aggregateEvalRecords } from './eval-report.js';
import { SimRuntimeBuilder } from './sim-registry/runtime-builder.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

// ---------------------------------------------------------------------------
// R5-F01 + R5-F04: mapData PATCH 深合并 + 白名单完整性
// ---------------------------------------------------------------------------

const SEMANTIC_RULE = {
  semanticType: 'fresh-air-dispatch',
  label: '新风调度',
  description: 'CO2 超标时联动新风',
  requires: ['co2-monitoring'],
  actuates: ['ventilation-control'],
};
const SYNONYMS = [
  ['cooling', 'air-conditioning'],
  ['heating', 'space-heating'],
];

describe('R5-F01/F04 — mapData PATCH 深合并与白名单完整性', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Merge Lab',
        mapData: {
          zones: [{ id: 'zone-a' }, { id: 'zone-b' }],
          events: [{ id: 'ev-1', type: 'temperature-spike', zoneId: 'zone-a' }],
          semanticOfferRules: [SEMANTIC_RULE],
          capabilitySynonyms: SYNONYMS,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function patchEnv(payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload,
    });
  }

  async function detail() {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('F01 复现：只拨 derivedServiceVisibility 的 PATCH 不再抹掉 zones/events/semantic 字段', async () => {
    // 教程（docs/tutorial-smart-campus.md §9）的 demo 化操作——修复前
    // 这一下会把 zones/events/floorPlans 全清掉并剥除 P3 字段。
    const response = await patchEnv({
      visibility: 'public',
      mapData: { derivedServiceVisibility: 'public' },
    });
    expect(response.statusCode).toBe(200);

    const env = await detail();
    expect(env.zones.map((z: { id: string }) => z.id)).toEqual(['zone-a', 'zone-b']);
    expect(env.events).toHaveLength(1);
    expect(env.derivedServiceVisibility).toBe('public');
    expect(env.semanticOfferRules).toEqual([SEMANTIC_RULE]);
    expect(env.capabilitySynonyms).toEqual(SYNONYMS);
  });

  it('F01：zones/events 键存在即整表替换（单条增删可表达），缺省键保留', async () => {
    const response = await patchEnv({
      mapData: {
        zones: [{ id: 'zone-a', name: 'A renamed' }, { id: 'zone-c' }],
        events: [{ id: 'ev-2', type: 'co2-spike', zoneId: 'zone-c' }],
      },
    });
    expect(response.statusCode).toBe(200);

    const env = await detail();
    // zone-b 被整表替换删除（web ZonePanel removeZone 的通道），
    // zone-a 改名、zone-c 新增；events 整表替换为 ev-2（校验对合并后
    // 的 zone 表通过——ev-2 引用的是同批带入的 zone-c）。
    expect(env.zones.map((z: { id: string }) => z.id)).toEqual(['zone-a', 'zone-c']);
    expect(env.zones.find((z: { id: string }) => z.id === 'zone-a').name).toBe('A renamed');
    expect(env.events.map((e: { id: string }) => e.id)).toEqual(['ev-2']);
  });

  it('F01：清空 zones 需要 confirmClearZones（409），确认后放行', async () => {
    const denied = await patchEnv({ mapData: { zones: [] } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('MAP_ZONES_CLEAR_UNCONFIRMED');
    expect(denied.json().error.zoneCount).toBe(2);
    // 世界未被动过。
    expect((await detail()).zones).toHaveLength(2);

    // 残留 events 引用已删 zone 会被同一校验拦住（400）——确认清 zones
    // 的调用方需一并清空引用它们的 events。
    const dangling = await patchEnv({ mapData: { zones: [] }, confirmClearZones: true });
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().error.message).toContain('references unknown zone');

    const confirmed = await patchEnv({ mapData: { zones: [], events: [] }, confirmClearZones: true });
    expect(confirmed.statusCode).toBe(200);
    expect((await detail()).zones).toHaveLength(0);
  });

  it('F04：未知 mapData 键 400 点名（不再静默剥除）；详情回读 semantic 字段保真', async () => {
    const response = await patchEnv({ mapData: { semanticOfferRulez: [] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('"semanticOfferRulez"');
    expect(response.json().error.message).toContain('"semanticOfferRules"');
    // 存量字段原样保留。
    const env = await detail();
    expect(env.semanticOfferRules).toEqual([SEMANTIC_RULE]);
    expect(env.capabilitySynonyms).toEqual(SYNONYMS);
  });

  it('F04：semantic 字段可经 PATCH 显式改写（读-改-写 round-trip）', async () => {
    const env = await detail();
    const rules = env.semanticOfferRules as Array<Record<string, unknown>>;
    const rewritten = await patchEnv({
      mapData: { semanticOfferRules: [...rules, { ...SEMANTIC_RULE, semanticType: 'climate-control' }] },
    });
    expect(rewritten.statusCode).toBe(200);
    const after = await detail();
    expect(after.semanticOfferRules).toHaveLength(2);
    // 显式 [] 清空该列表（标量覆盖语义），zones 不受影响。
    const cleared = await patchEnv({ mapData: { capabilitySynonyms: [] } });
    expect(cleared.statusCode).toBe(200);
    const final = await detail();
    expect(final.capabilitySynonyms).toEqual([]);
    expect(final.zones).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// R5-F02: 无 llm 块的 agent 缺省沿用共享 client
// ---------------------------------------------------------------------------

describe('R5-F02 — 未声明 llm 块的 agent 缺省沿用共享 client', () => {
  const builder = new SimRuntimeBuilder(
    {
      llmProvider: 'openai-compatible',
      llmBaseUrl: 'http://localhost:8000/v1',
      llmModel: 'm-deployed',
    },
    undefined,
    undefined,
    undefined as never,
    undefined,
  );

  const base = {
    version: '1.0' as const,
    meta: { id: 'w', name: 'w' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [],
    events: [],
  };
  type Scenario = Parameters<SimRuntimeBuilder['build']>[0]['scenario'];

  it('复现修复：无 llm 块的世界在 llmClient:auto 下不再静默 rule-only', () => {
    const scenario = {
      ...base,
      agents: [
        { id: 'a1', name: 'A1', capabilities: [] },
        { id: 'a2', name: 'A2', capabilities: [] },
      ],
    } as unknown as Scenario;
    const resolution = builder.resolveLLM(scenario, 'auto');
    expect(resolution.mode).toBe('llm');
    expect(resolution.client).toBeDefined();
    expect(resolution.model).toBe('m-deployed');
    expect(resolution.warning).toBeUndefined();
  });

  it('显式 opt-out 保留：全 llm:null 的世界仍 rule-only 并带 llmWarning', () => {
    const scenario = {
      ...base,
      agents: [{ id: 'a1', name: 'A1', capabilities: [], llm: null }],
    } as unknown as Scenario;
    const resolution = builder.resolveLLM(scenario, 'auto');
    expect(resolution.mode).toBe('rule-only');
    expect(resolution.warning).toContain('opts out');
  });

  it('混合世界：opt-out 的 agent 不挡其他 agent 沿用共享 client', () => {
    const scenario = {
      ...base,
      agents: [
        { id: 'a1', name: 'A1', capabilities: [], llm: null },
        { id: 'a2', name: 'A2', capabilities: [] },
      ],
    } as unknown as Scenario;
    const resolution = builder.resolveLLM(scenario, 'auto');
    expect(resolution.mode).toBe('llm');
    expect(resolution.client).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R5-F03: agent 属主可直改纯决策配置
// ---------------------------------------------------------------------------

describe('R5-F03 — agent 属主的决策配置直改通道', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let stranger: TestUser;
  let envId: string;
  let agentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Owner Patch Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    expect(joined.statusCode).toBeLessThan(300);
    // 属主 ≠ 环境 owner 的 agent（提案管道的落点形态，直接建行绕开提案编排）。
    agentId = ctx.app.envStore.createAgent({
      envId,
      ownerId: builder.id,
      name: 'Builder Agent',
      capabilities: [],
    }).id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function patchAgent(token: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(token),
      payload,
    });
  }

  it('属主可直改 llm / enabled / decisionPolicy，且落 command_log', async () => {
    const llm = await patchAgent(builder.token, { llm: { provider: 'openai-compatible', model: 'm' } });
    expect(llm.statusCode).toBe(200);
    expect(llm.json().llm).toEqual({ provider: 'openai-compatible', model: 'm' });

    const enabled = await patchAgent(builder.token, { enabled: false });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().enabled).toBe(false);

    const policy = await patchAgent(builder.token, { decisionPolicy: { autoInitiateAC: false } });
    expect(policy.statusCode).toBe(200);

    const optOut = await patchAgent(builder.token, { llm: null });
    expect(optOut.statusCode).toBe(200);
    expect(optOut.json().llm).toBeNull();

    // command_log 审计：actor 是属主本人。
    const log = ctx.app.commandLogStore.listForEnv(envId, { limit: 50 });
    const edits = log.filter(
      row =>
        row.kind === 'env-direct-edit' &&
        row.actor_id === builder.id &&
        row.payload_json.includes(`"objectId":"${agentId}"`),
    );
    expect(edits.length).toBeGreaterThanOrEqual(4);
  });

  it('属主改结构字段仍 403 并指路 modify-object；混合 body 整体拒绝', async () => {
    const structural = await patchAgent(builder.token, { name: 'Rename' });
    expect(structural.statusCode).toBe(403);
    expect(structural.json().error.message).toContain('decision configuration');
    expect(structural.json().error.message).toContain('modify-object');

    const mixed = await patchAgent(builder.token, { enabled: true, capabilities: ['x'] });
    expect(mixed.statusCode).toBe(403);

    // 没改成——enabled 保持初始值（结构字段拖累了整个请求，整体 403 不落库）。
    expect(ctx.app.envStore.getAgent(agentId)!.enabled).toBe(1);
  });

  it('他人（非属主非环境 owner）一律 403；环境 owner 权限不变', async () => {
    const denied = await patchAgent(stranger.token, { enabled: false });
    expect(denied.statusCode).toBe(403);

    const byOwner = await patchAgent(owner.token, { name: 'Owner Renamed', enabled: true });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().name).toBe('Owner Renamed');
  });
});

// ---------------------------------------------------------------------------
// R5-F05: 握手成功率拆出发起去重取消
// ---------------------------------------------------------------------------

describe('R5-F05 — eval-report 握手小节拆出 cancelledByCoordinator', () => {
  function response(overrides: Partial<TrajectoryRecord>): TrajectoryRecord {
    return {
      recordedAt: new Date().toISOString(),
      scenario: 's',
      condition: 'c',
      iteration: 0,
      eventId: 'ev',
      agentId: 'agent-1',
      kind: 'collaboration-response',
      context: { capabilities: [], partnerServices: [], partnerServicesTotal: 0 },
      decision: 'reject',
      decisionSource: 'rule',
      correct: null,
      ...overrides,
    } as TrajectoryRecord;
  }

  it('复现修复：同一事件被赢家接住的去重取消不计入真实协商成功率分母', () => {
    const m = aggregateEvalRecords(
      [
        // 事件 E1：赢家握手（accept）+ 两个输家被协调器取消（消防演练三方
        // 同时发起的形态）。
        response({ collaborationId: 'win-1', eventId: 'E1', decision: 'accept', agentId: 'p1' }),
        response({ collaborationId: 'lose-1', eventId: 'E1', decision: 'cancelled', agentId: 'p2' }),
        response({ collaborationId: 'lose-2', eventId: 'E1', decision: 'cancelled', agentId: 'p3' }),
        // 事件 E2：真失败（全员拒绝 → cancelled，无赢家接住）。
        response({ collaborationId: 'lose-3', eventId: 'E2', decision: 'reject', agentId: 'p4' }),
        response({ collaborationId: 'lose-3', eventId: 'E2', decision: 'cancelled', agentId: 'p1' }),
      ],
      [],
    );
    expect(m.handshakes.initiated).toBe(4);
    expect(m.handshakes.succeeded).toBe(1);
    // legacy 口径不变（分母含机制性取消）。
    expect(m.handshakes.failed).toBe(3);
    expect(m.handshakes.successRate).toBe(1 / 4);
    // R5-F05 新口径：2 起去重取消拆出，真实协商成功率 1/2。
    expect(m.handshakes.cancelledByCoordinator).toBe(2);
    expect(m.handshakes.negotiationSuccessRate).toBe(1 / 2);
  });

  it('无协作 / 无去重取消时的诚实空态', () => {
    const empty = aggregateEvalRecords([], []);
    expect(empty.handshakes.cancelledByCoordinator).toBe(0);
    expect(empty.handshakes.negotiationSuccessRate).toBeNull();

    const realFailure = aggregateEvalRecords(
      [response({ collaborationId: 'c1', eventId: 'E9', decision: 'cancelled' })],
      [],
    );
    expect(realFailure.handshakes.cancelledByCoordinator).toBe(0);
    expect(realFailure.handshakes.negotiationSuccessRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R5-F06: include=terminated + digest 已完成协作
// ---------------------------------------------------------------------------

describe('R5-F06 — terminated 合约的成员可见性与 digest 成果面', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let newbie: TestUser;
  let envId: string;
  let serviceId: string;
  let serviceName: string;
  let agreementId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    newbie = await registerUser(ctx.app, { displayName: 'Newbie' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('r5-f06-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    for (const user of [consumer, newbie]) {
      const joined = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
      expect(joined.statusCode).toBeLessThan(300);
    }

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    expect(turnOn).toBeTruthy();
    serviceId = turnOn!.id;
    serviceName = turnOn!.name;

    // 一份走完整生命周期的合约：propose → accept → terminate。
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/terminate`,
      headers: auth(consumer.token),
    });
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('默认视图不变：非当事成员看不到任何合约；当事方默认仍见 terminated 行', async () => {
    const newbieDefault = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(newbie.token),
    });
    expect(newbieDefault.statusCode).toBe(200);
    expect(newbieDefault.json().agreements).toEqual([]);

    const partyDefault = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(consumer.token),
    });
    expect(partyDefault.json().agreements.map((a: { id: string }) => a.id)).toContain(agreementId);
  });

  it('include=terminated 向环境成员开放已完成的协作；非法值 400', async () => {
    const included = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}&include=terminated`,
      headers: auth(newbie.token),
    });
    expect(included.statusCode).toBe(200);
    const rows = included.json().agreements as Array<{ id: string; status: string }>;
    expect(rows.map(row => row.id)).toContain(agreementId);
    expect(rows.every(row => row.status === 'terminated')).toBe(true);

    const bogus = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}&include=bogus`,
      headers: auth(newbie.token),
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error.message).toContain('"include"');
  });

  it('digest 把已完成的协作列为一等成果（参与者、服务、结果）', async () => {
    const digest = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(newbie.token),
    });
    expect(digest.statusCode).toBe(200);
    const completed = digest.json().completedCollaborations as Array<{
      agreementId: string;
      source: string;
      service: { id: string; name: string | null };
      consumer: { agentId: string | null; agentName: string | null };
      provider: { agentId: string; agentName: string | null };
      outcome: string;
      terminatedAt: string;
    }>;
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const entry = completed.find(row => row.agreementId === agreementId)!;
    expect(entry).toBeDefined();
    expect(entry.source).toBe('explicit');
    expect(entry.service).toEqual({ id: serviceId, name: serviceName });
    expect(entry.provider.agentName).toBe('Lab Agent');
    expect(entry.outcome).toBe('ended-without-delivery'); // T34: 曾 active 但 0 计量行
  });
});

// ---------------------------------------------------------------------------
// R5-F08: 公开环境陌生人的 terminated 受限视图
// ---------------------------------------------------------------------------

describe('R5-F08 — 公开环境陌生人的 terminated 合约受限视图', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let stranger: TestUser;
  let envId: string;
  let serviceName: string;
  let terminatedId: string;
  let activeId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('r5-f08-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    serviceName = turnOn!.name;

    const runLifecycle = async (terminate: boolean): Promise<string> => {
      const proposed = await ctx.app.inject({
        method: 'POST',
        url: `/api/services/${turnOn!.id}/agreements`,
        headers: auth(consumer.token),
        payload: {},
      });
      expect(proposed.statusCode).toBe(201);
      const id = proposed.json().id as string;
      const decided = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'accept' },
      });
      expect(decided.statusCode).toBe(200);
      if (terminate) {
        const terminated = await ctx.app.inject({
          method: 'POST',
          url: `/api/agreements/${id}/terminate`,
          headers: auth(consumer.token),
        });
        expect(terminated.statusCode).toBe(200);
      }
      return id;
    };
    terminatedId = await runLifecycle(true);
    activeId = await runLifecycle(false);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function listAgreements(token?: string, query = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}${query}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  it('非成员读者看到 terminated 合约的受限视图（Agent 名 / 服务名 / 结果 / 时间，无 owner 身份）', async () => {
    const res = await listAgreements(stranger.token, '&include=terminated');
    expect(res.statusCode).toBe(200);
    const rows = res.json().agreements as Array<Record<string, unknown>>;
    const entry = rows.find(row => row.id === terminatedId)!;
    expect(entry).toBeDefined();
    expect(entry.view).toBe('restricted');
    expect(entry.status).toBe('terminated');
    expect(entry.service).toEqual({ id: expect.any(String), name: serviceName });
    expect(entry.providerAgentName).toBe('Lab Agent');
    expect(entry.outcome).toBe('ended-without-delivery'); // T34: 曾 active 但 0 计量行
    expect(typeof entry.terminatedAt).toBe('string');
    // 匿名化口径：不落 owner 身份、不带条款细节。
    expect(entry.consumer).toBeUndefined();
    expect(entry.provider).toBeUndefined();
    expect(entry.terms).toBeUndefined();
    // ACTIVE 合约仍仅成员可见——陌生人的列表里没有它。
    expect(rows.some(row => row.id === activeId)).toBe(false);
  });

  it('匿名读者（无凭证）在公开环境同样可读受限视图', async () => {
    const res = await listAgreements(undefined, '&include=terminated');
    expect(res.statusCode).toBe(200);
    const rows = res.json().agreements as Array<{ id: string; view?: string }>;
    const entry = rows.find(row => row.id === terminatedId)!;
    expect(entry.view).toBe('restricted');
    expect(rows.some(row => row.id === activeId)).toBe(false);
  });

  it('匿名读者在私有环境或不带 include=terminated 时仍是 401', async () => {
    const noInclude = await listAgreements();
    expect(noInclude.statusCode).toBe(401);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { visibility: 'private' },
    });
    expect(patched.statusCode).toBe(200);
    const privateEnv = await listAgreements(undefined, '&include=terminated');
    expect(privateEnv.statusCode).toBe(401);
    // 登录的非成员在私有环境的陌生人通道同样关闭（空列表，旧行为）。
    const strangerPrivate = await listAgreements(stranger.token, '&include=terminated');
    expect(strangerPrivate.statusCode).toBe(200);
    expect(strangerPrivate.json().agreements).toEqual([]);
  });

  it('成员的 include=terminated 视图不变（完整视图，无 restricted 标记）', async () => {
    const res = await listAgreements(consumer.token, '&include=terminated');
    expect(res.statusCode).toBe(200);
    const rows = res.json().agreements as Array<{ id: string; view?: string; terms?: unknown }>;
    const entry = rows.find(row => row.id === terminatedId)!;
    expect(entry.view).toBeUndefined();
    expect(entry.terms).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R5-F09: 未生效合约的 terminated outcome 口径
// ---------------------------------------------------------------------------

describe('R5-F09 — 从未生效的合约不再被标成 "completed"', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let stranger: TestUser;
  let envId: string;
  let serviceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('r5-f09-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    expect(turnOn).toBeTruthy();
    serviceId = turnOn!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** propose → (optionally accept) → terminate；返回合约 id。 */
  async function runLifecycle(accept: boolean): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    if (accept) {
      const decided = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'accept' },
      });
      expect(decided.statusCode).toBe(200);
    }
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/terminate`,
      headers: auth(consumer.token),
    });
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');
    return id;
  }

  async function digestOutcomeOf(agreementId: string): Promise<string> {
    const digest = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    expect(digest.statusCode).toBe(200);
    const completed = digest.json().completedCollaborations as Array<{
      agreementId: string;
      outcome: string;
    }>;
    const entry = completed.find(row => row.agreementId === agreementId);
    expect(entry, `digest entry for ${agreementId}`).toBeDefined();
    return entry!.outcome;
  }

  async function restrictedOutcomeOf(agreementId: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}&include=terminated`,
      headers: auth(stranger.token),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().agreements as Array<{ id: string; view?: string; outcome?: string }>;
    const entry = rows.find(row => row.id === agreementId);
    expect(entry, `restricted entry for ${agreementId}`).toBeDefined();
    expect(entry!.view).toBe('restricted');
    return entry!.outcome!;
  }

  it('F09 复现修复：proposed 直接 terminate（从未 accept）→ digest 与受限视图都记 cancelled，不再记 completed', async () => {
    const neverActiveId = await runLifecycle(false);

    expect(await digestOutcomeOf(neverActiveId)).toBe('cancelled');
    expect(await restrictedOutcomeOf(neverActiveId)).toBe('cancelled');
  });

  it('T34 (R3 u3-F6/u4-F7)：曾 active 但 0 计量行 → ended-without-delivery（不再是 completed），两条通道一致', async () => {
    const wasActiveId = await runLifecycle(true);

    expect(await digestOutcomeOf(wasActiveId)).toBe('ended-without-delivery');
    expect(await restrictedOutcomeOf(wasActiveId)).toBe('ended-without-delivery');
  });

  it('共享判定 terminatedAgreementOutcome：AC 取消（无 usage 行）沿用 cancelled；计量 outcome 永远优先', async () => {
    // 纯函数层钉死同一口径——digest 与受限视图都调它，不允许出现第二份拷贝。
    const acRow = { source: 'ac', activated_at: '2026-01-01T00:00:00.000Z' } as const;
    expect(terminatedAgreementOutcome(acRow, undefined)).toBe('cancelled');
    expect(terminatedAgreementOutcome(acRow, 'partial')).toBe('partial');

    const explicitNeverActive = { source: 'explicit', activated_at: null } as const;
    expect(terminatedAgreementOutcome(explicitNeverActive, undefined)).toBe('cancelled');
    const explicitWasActive = { source: 'explicit', activated_at: '2026-01-01T00:00:00.000Z' } as const;
    expect(terminatedAgreementOutcome(explicitWasActive, undefined)).toBe('ended-without-delivery');
    expect(terminatedAgreementOutcome(explicitWasActive, 'failure')).toBe('failure');
    expect(terminatedAgreementOutcome(explicitWasActive, 'success')).toBe('success');
  });
});
