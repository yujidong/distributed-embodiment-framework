/**
 * @vitest-environment node
 *
 * R2 Lane B — T6 / T8 / T9 回归套件。
 *
 * - T6（u4-F2）可见性矩阵：terminated 合约的 get/usage/receipts 对 env 成员
 *   与公开环境读者（含匿名）开放**受限视图**（与列表 R5-F06/R5-F08 同口径），
 *   非 terminated 行保持存在性保护（404）；当事方/env owner 恒为完整视图。
 * - T8（u2-F2）：aggregate 报价的详情面走**规则道**（与签约门禁/ invoke 道
 *   同一判定）——有背板不再假警告 unbacked（backing 视图 + callableActions），
 *   背板漂移为空后如实显示 unbacked。
 * - T9（u2-F5/u4-F7/B1-10 MVP）：remind 落痕（v63 列）+ agent provider 的
 *   确定性应答三态——全支撑→accept、明显不可交付→reject+reason、判定不了
 *   →hold（保持 proposed，用例直测纯函数）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assessProviderDeliverability } from './agreements/provider-decision.js';
import type { AgreementRoutesContext } from './agreements/context.js';
import type { AgreementRow } from './db/agreement-store.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('R2 agreements: T6 可见性 / T8 规则道背板 / T9 提醒落痕与确定性应答', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner AND provider (owns the imported lab-agent)
  let consumer: TestUser; // builder member who signs
  let member: TestUser; // member, never a party
  let stranger: TestUser; // not a member, never a party
  let envId: string;
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    member = await registerUser(ctx.app, { displayName: 'Member' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('agreement-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(member.token) });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    expect(turnOn).toBeTruthy();
    turnOnServiceId = turnOn!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -----------------------------------------------------------------------
  // helpers
  // -----------------------------------------------------------------------

  function propose(token: string, serviceId: string, body: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(token),
      payload: body,
    });
  }

  function act(token: string, id: string, action: string, body?: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/${action}`,
      headers: auth(token),
      ...(body !== undefined ? { payload: body } : {}),
    });
  }

  function readLane(token: string | undefined, id: string, sub = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}${sub}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  /** propose → accept → terminate：一条 terminated 的显式合约。 */
  async function terminatedAgreement(serviceId = turnOnServiceId): Promise<string> {
    const proposed = await propose(consumer.token, serviceId);
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    expect((await act(owner.token, id, 'decide', { decision: 'accept' })).statusCode).toBe(200);
    expect((await act(consumer.token, id, 'terminate', {})).statusCode).toBe(200);
    return id;
  }

  // -----------------------------------------------------------------------
  // T6 — the permission matrix on the READ lanes
  // -----------------------------------------------------------------------

  describe('T6: terminated 合约成员受限详情（读侧，状态机零变化）', () => {
    it('权限矩阵：当事方/owner 完整视图；成员与公开环境读者（含匿名）受限视图；非 terminated 保持 404', async () => {
      const terminatedId = await terminatedAgreement();

      // 当事方（consumer）→ 完整视图（无 view 标记，带 owner 身份）。
      const partyGet = await readLane(consumer.token, terminatedId);
      expect(partyGet.statusCode).toBe(200);
      expect(partyGet.json().view).toBeUndefined();
      expect(partyGet.json().consumer.displayName).toBe('Consumer');
      expect(partyGet.json().outcome).toBe('ended-without-delivery'); // T34: 0 计量行

      // env owner → 完整视图。
      const ownerGet = await readLane(owner.token, terminatedId);
      expect(ownerGet.statusCode).toBe(200);
      expect(ownerGet.json().view).toBeUndefined();

      // env 成员（非当事方）→ 受限视图。
      const memberGet = await readLane(member.token, terminatedId);
      expect(memberGet.statusCode).toBe(200);
      expect(memberGet.json().view).toBe('restricted');
      expect(memberGet.json().consumer).toBeUndefined(); // 无 owner 身份
      expect(memberGet.json().outcome).toBe('ended-without-delivery'); // T34: 0 计量行

      // 公开环境陌生人（已认证）→ 受限视图（与列表 R5-F08 同口径）。
      const strangerGet = await readLane(stranger.token, terminatedId);
      expect(strangerGet.statusCode).toBe(200);
      expect(strangerGet.json().view).toBe('restricted');

      // 匿名 × 公开环境 × terminated → 受限视图（列表通道本就匿名可读）。
      const anonGet = await readLane(undefined, terminatedId);
      expect(anonGet.statusCode).toBe(200);
      expect(anonGet.json().view).toBe('restricted');

      // usage / receipts：成员受限可读（agent 级账目），带 restricted 标记。
      const memberUsage = await readLane(member.token, terminatedId, '/usage');
      expect(memberUsage.statusCode).toBe(200);
      expect(memberUsage.json().view).toBe('restricted');
      expect(Array.isArray(memberUsage.json().usage)).toBe(true);
      const partyUsage = await readLane(consumer.token, terminatedId, '/usage');
      expect(partyUsage.statusCode).toBe(200);
      expect(partyUsage.json().view).toBeUndefined();
      const memberReceipts = await readLane(member.token, terminatedId, '/receipts');
      expect(memberReceipts.statusCode).toBe(200);
      expect(memberReceipts.json().view).toBe('restricted');

      // 非 terminated：存在性保护不变——成员/陌生人/匿名 × active → 404。
      const activeId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
      expect((await readLane(member.token, activeId)).statusCode).toBe(404);
      expect((await readLane(stranger.token, activeId)).statusCode).toBe(404);
      expect((await readLane(undefined, activeId)).statusCode).toBe(404);
    });

    it('私有环境的陌生人 × terminated 仍 404（列表看不到，详情也不开）', async () => {
      // 先在公开环境制造 terminated 行（成员可读受限视图），再把环境转私有
      // ——私有环境对陌生人完全不可见：列表没有、详情也不开（404）。
      const terminatedId = await terminatedAgreement();
      expect((await readLane(member.token, terminatedId)).json().view).toBe('restricted');
      expect((await readLane(stranger.token, terminatedId)).statusCode).toBe(200);

      const flipped = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}`,
        headers: auth(owner.token),
        payload: { visibility: 'private' },
      });
      expect(flipped.statusCode).toBe(200);

      // 成员仍读受限视图；陌生人与匿名 → 404（存在性保护恢复）。
      expect((await readLane(member.token, terminatedId)).statusCode).toBe(200);
      expect((await readLane(stranger.token, terminatedId)).statusCode).toBe(404);
      expect((await readLane(undefined, terminatedId)).statusCode).toBe(404);
    });

    // ---------------------------------------------------------------------
    // T30 (R3 u2-F-02, PM 裁定：非当事方成员两侧同受限) — the LIST lane
    // converges to the restricted view. The list used to serialize non-party
    // member rows via agreementToJson (owner displayName / terms leaked on
    // the very rows `agreement get` anonymizes).
    // ---------------------------------------------------------------------

    it('T30: list 行与 get 逐字段一致——非当事方成员两侧同受限（无 owner 身份/无 terms）', async () => {
      const terminatedId = await terminatedAgreement();

      const listed = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements?envId=${envId}&include=terminated`,
        headers: auth(member.token),
      });
      expect(listed.statusCode).toBe(200);
      const rows = listed.json().agreements as Array<Record<string, unknown>>;
      const listedRow = rows.find(row => row.id === terminatedId);
      expect(listedRow).toBeTruthy();
      expect(listedRow!.view).toBe('restricted');
      expect(listedRow!.consumer).toBeUndefined();
      expect(listedRow!.provider).toBeUndefined();
      expect(listedRow!.terms).toBeUndefined();
      expect(listedRow!.outcome).toBe('ended-without-delivery'); // T34: 0 计量行
      // 该合约无 caller-owned consumer agent（默认提案）→ agent 名为 null，
      // provider 侧是 lab-agent（参与方以 agent 呈现）。
      expect(listedRow!.consumerAgentName).toBeNull();
      expect(listedRow!.providerAgentName).toBe('Lab Agent');

      // 字段级一致：同 id 的 get body 与 list 行形状相同（restricted 形态）。
      const got = await readLane(member.token, terminatedId);
      expect(got.statusCode).toBe(200);
      expect(Object.keys(got.json()).sort()).toEqual(Object.keys(listedRow!).sort());
      expect(got.json()).toMatchObject(listedRow!);

      // 当事方与 owner 的 full 视图不变：list 行带 owner 身份与 terms。
      const partyList = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements?envId=${envId}&include=terminated`,
        headers: auth(consumer.token),
      });
      const partyRow = (partyList.json().agreements as Array<Record<string, unknown>>)
        .find(row => row.id === terminatedId);
      expect(partyRow!.view).toBeUndefined();
      expect(partyRow!.terms).toBeDefined();
      const ownerList = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements?envId=${envId}&include=terminated`,
        headers: auth(owner.token),
      });
      const ownerRow = (ownerList.json().agreements as Array<Record<string, unknown>>)
        .find(row => row.id === terminatedId);
      expect(ownerRow!.view).toBeUndefined();
      expect(ownerRow!.terms).toBeDefined();

      // 公开环境陌生人 list 行同样受限（现状不变）。
      const strangerList = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements?envId=${envId}&include=terminated`,
        headers: auth(stranger.token),
      });
      const strangerRow = (strangerList.json().agreements as Array<Record<string, unknown>>)
        .find(row => row.id === terminatedId);
      expect(strangerRow!.view).toBe('restricted');
    });

    it('T30: 成员 × active 不出现在列表（存在性保护零变化）；role 过滤不含非当事方 terminated', async () => {
      const activeId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
      const memberList = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements?envId=${envId}`,
        headers: auth(member.token),
      });
      expect((memberList.json().agreements as Array<{ id: string }>).map(row => row.id))
        .not.toContain(activeId);

      // role 过滤的语义保持 party-scoped：非当事方 terminated 行不出现。
      const terminatedId = await terminatedAgreement();
      const roleList = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements?envId=${envId}&include=terminated&role=consumer`,
        headers: auth(member.token),
      });
      expect((roleList.json().agreements as Array<{ id: string }>).map(row => row.id))
        .not.toContain(terminatedId);
    });
  });

  // -----------------------------------------------------------------------
  // T8 — the aggregate detail face speaks the RULE lane
  // -----------------------------------------------------------------------

  describe('T8: aggregate 详情背板与签约门禁同一判定源', () => {
    async function bindDrainageBundle(): Promise<{ aggregateServiceId: string; valveName: string }> {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: '排涝智能阀',
          type: 'smart-valve',
          capabilities: ['valve-control', 'turn-on', 'turn-off', 'open'],
          zoneId: 'zone-b',
        },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: '内涝水位计',
          type: 'flood-detector',
          capabilities: ['water-level-monitoring'],
          zoneId: 'zone-b',
        },
      });
      const env = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token) });
      const devices = env.json().devices as Array<{ id: string; name: string }>;
      const valveId = devices.find(d => d.name === '排涝智能阀')!.id;
      const gaugeId = devices.find(d => d.name === '内涝水位计')!.id;
      const agents = env.json().agents as Array<{ id: string; boundDeviceIds: string[] }>;
      const labAgentId = agents.find(a => a.boundDeviceIds.includes(devices.find(d => d.name === 'HVAC B')!.id))!.id;
      const rebound = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${labAgentId}`,
        headers: auth(owner.token),
        payload: { boundDeviceIds: [...new Set([...agents.find(a => a.id === labAgentId)!.boundDeviceIds, valveId, gaugeId])] },
      });
      expect(rebound.statusCode, JSON.stringify(rebound.json()).slice(0, 200)).toBe(200);
      const services = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services`,
        headers: auth(owner.token),
      });
      const offer = (services.json().services as Array<{ id: string; name: string; origin: string }>)
        .find(s => s.origin === 'aggregate' && s.name === '区域排涝调度');
      expect(offer).toBeDefined();
      return { aggregateServiceId: offer!.id, valveName: '排涝智能阀' };
    }

    it('u2-F2 回放：有规则背板的 aggregate，agreement get 不再假警告 unbacked（backing 视图 + callable 动作面）', async () => {
      const { aggregateServiceId, valveName } = await bindDrainageBundle();
      const proposed = await propose(consumer.token, aggregateServiceId);
      expect(proposed.statusCode).toBe(201);
      const id = proposed.json().id as string;

      const got = await readLane(consumer.token, id);
      expect(got.statusCode).toBe(200);
      const backing = got.json().backing;
      expect(backing).toMatchObject({ kind: 'rule', rule: 'drainage-control' });
      expect(backing.devices.length).toBeGreaterThanOrEqual(1);
      expect(backing.devices.map((d: { name: string }) => d.name)).toContain(valveName);
      expect(backing.actuates).toContain('valve-control');
      // callable 动作面非空——消费方在签约前看到真可调动作（非 null ≠ unbacked）。
      expect(Array.isArray(got.json().callableActions)).toBe(true);
      expect((got.json().callableActions as string[]).length).toBeGreaterThan(0);
    });

    it('真无背板的 aggregate（pre-gate 遗留行形态）：get 如实显示 backing null + callableActions null（与 409 同源）', async () => {
      // 现行平台里 propose/counter/accept 门禁（R6-B-F01）与解绑/删除的
      // retire 纪律让"无背板的 aggregate 合约行"无法经正常流产生——这里用
      // store 直建一份 pre-gate 遗留行形状（v60 restore 同型的合成夹具），
      // 钉住详情面对该类的诚实显示。
      const labAgentId = (await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}`,
        headers: auth(owner.token),
      })).json().agents as Array<{ id: string }>;
      const agentId = labAgentId[0]!.id;
      // 一个规则可解析（drainage-control 是内置规则）但没有任何绑定设备
      // 持有其 actuates 能力的 aggregate 行。
      const staleOffer = ctx.app.serviceStore.createService({
        envId,
        providerAgentId: agentId,
        name: '区域排涝调度（遗留）',
        semanticType: 'drainage-control',
        origin: 'aggregate',
        interface: {},
      });
      const created = ctx.app.agreementStore.createAgreement({
        envId,
        serviceId: staleOffer.id,
        consumerAgentId: null,
        consumerOwnerId: consumer.id,
        providerAgentId: agentId,
        providerOwnerId: owner.id,
        terms: {},
      });
      const got = await readLane(consumer.token, created.id);
      expect(got.statusCode).toBe(200);
      expect(got.json().backing).toBeNull();
      expect(got.json().callableActions).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // T9 — the remind trace + the agent provider's deterministic verdicts
  // -----------------------------------------------------------------------

  describe('T9: remind 落痕 + agent provider 确定性应答三态', () => {
    async function agePastRemindWindow(id: string): Promise<void> {
      ctx.app.db
        .prepare('UPDATE service_agreements SET created_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), id);
    }

    it('全支撑 → accept：remind 触发确定性应答，走正式 decide-accept 机制（审计 + 双侧可见）', async () => {
      const proposed = await propose(consumer.token, turnOnServiceId);
      const id = proposed.json().id as string;
      await agePastRemindWindow(id);

      const reminded = await act(consumer.token, id, 'remind');
      expect(reminded.statusCode).toBe(200);
      expect(reminded.json().reminded).toBe(true);
      // 提醒落痕：v63 列 + 响应回显（updated_at 不动——提醒不是迁移）。
      expect(reminded.json().remindCount).toBe(1);
      expect(typeof reminded.json().lastRemindedAt).toBe('string');
      // 确定性应答：全支撑 → accept，状态沿既有 proposed → active 边。
      expect(reminded.json().autoDecision).toMatchObject({ decision: 'accept' });
      expect(reminded.json().status).toBe('active');

      const got = await readLane(consumer.token, id);
      expect(got.json().status).toBe('active');
      expect(got.json().remindCount).toBe(1);

      // 消费方通知（决定必知 A3 + decidedBy 标记）。
      const inbox = await ctx.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: auth(consumer.token),
      });
      const accepted = (inbox.json().notifications as Array<{ kind: string; body: Record<string, unknown> }>)
        .find(n => n.kind === 'agreement.accepted' && (n.body as { agreementId?: string }).agreementId === id);
      expect(accepted).toBeDefined();
      expect(String(accepted!.body.decidedBy)).toContain('provider-agent');
    });

    it('明显不可交付 → reject 带 reason：签约后背板漂移（能力被撤），remind 触发确定性拒绝', async () => {
      // 摄像头 + 已发布服务：propose 时背板真实存在（门禁放行），随后设备
      // 能力面被改写——published 服务行不随设备能力再生（无 retire），提案
      // 悬在世界已漂移的行上，正是确定性应答要收口的形态。
      const camera = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: {
          name: '门口摄像头',
          type: 'camera',
          capabilities: ['camera-reading'],
          zoneId: 'zone-a',
        },
      });
      expect(camera.statusCode).toBe(201);
      const cameraId = camera.json().id as string;
      const env = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token) });
      const devices = env.json().devices as Array<{ id: string; name: string }>;
      const agents = env.json().agents as Array<{ id: string; boundDeviceIds: string[]; name: string }>;
      // 承载 agent：绑定 HVAC B 的就是导入场景的 lab-agent。
      const hvacBId = devices.find(d => d.name === 'HVAC B')!.id;
      const labAgent = agents.find(a => a.boundDeviceIds.includes(hvacBId))!;
      const rebound = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${labAgent.id}`,
        headers: auth(owner.token),
        payload: { boundDeviceIds: [...new Set([...labAgent.boundDeviceIds, cameraId])] },
      });
      expect(rebound.statusCode).toBe(200);
      const published = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents/${labAgent.id}/services`,
        headers: auth(owner.token),
        payload: { name: '门口影像', semanticType: 'camera-reading' },
      });
      expect(published.statusCode).toBe(201);
      const serviceId = published.json().id as string;

      const proposed = await propose(consumer.token, serviceId);
      expect(proposed.statusCode, JSON.stringify(proposed.json()).slice(0, 200)).toBe(201);
      const id = proposed.json().id as string;

      // 背板漂移：摄像头不再持有 camera-reading（服务行幸存——published 行
      // 无源设备、不触发派生再生/retire）。
      const recapped = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/devices/${cameraId}`,
        headers: auth(owner.token),
        payload: { capabilities: ['zoom-reading'] },
      });
      expect(recapped.statusCode).toBe(200);

      await agePastRemindWindow(id);
      const reminded = await act(consumer.token, id, 'remind');
      expect(reminded.statusCode).toBe(200);
      expect(reminded.json().autoDecision).toMatchObject({ decision: 'reject' });
      expect(typeof reminded.json().autoDecision.reason).toBe('string');
      expect(reminded.json().status).toBe('rejected');

      // reason 落 status_reason（0a38ba69 的 reason 通道），get 可读。
      const got = await readLane(consumer.token, id);
      expect(got.json().status).toBe('rejected');
      expect(String(got.json().statusReason)).toContain('auto-decline');

      // 消费方收到带 reason 的拒绝通知。
      const inbox = await ctx.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: auth(consumer.token),
      });
      const rejected = (inbox.json().notifications as Array<{ kind: string; body: Record<string, unknown> }>)
        .find(n => n.kind === 'agreement.rejected' && (n.body as { agreementId?: string }).agreementId === id);
      expect(rejected).toBeDefined();
      expect(typeof rejected!.body.reason).toBe('string');
    });

    it('hold：判定不了（retired/unlinked 行）→ 保持 proposed，不替人做主（纯函数直测）', () => {
      const agreementRoutesCtx = {
        envStore: ctx.app.envStore,
        serviceStore: ctx.app.serviceStore,
      } as unknown as AgreementRoutesContext;
      const retiredRow = {
        id: 'agg-retired',
        env_id: envId,
        service_id: null,
        provider_agent_id: null,
        terms_json: '{}',
        status: 'proposed',
      } as unknown as AgreementRow;
      const verdict = assessProviderDeliverability(agreementRoutesCtx, retiredRow);
      expect(verdict).toMatchObject({ action: 'hold' });
      // 确定性：同输入同输出（无 LLM）。
      expect(assessProviderDeliverability(agreementRoutesCtx, retiredRow)).toEqual(verdict);
    });
  });
});
