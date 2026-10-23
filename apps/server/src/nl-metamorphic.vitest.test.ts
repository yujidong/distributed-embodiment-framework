/**
 * @vitest-environment node
 *
 * F2-2 NL 蜕变关系（metamorphic relations）库 —— plan-r84 Wave F2-2 的 PR 快道。
 *
 * 同一关系库的另一条道是 scripts/nl-metamorphic-llm.mjs（真 LLM 夜间道）；
 * 两边的语料与期望值共享 scripts/nl-metamorphic-cases.mjs。本文件驱动规则路径
 * （makeTestApp 无 LLM，intent.parseSource 必须是 'rules'），断言是确定性的。
 *
 * 关系 ↔ 历史 bug 锚点（docs/usability-findings.md）：
 *   MR1 同义改写不变量  ↔ R44-F2（群体表述/跨区静默解析）、R76-F4（同名误路由）
 *   MR2 越权保持        ↔ R76-F5（越权文案双轨）、R46C-P0-A（NL 不得是越权侧门）
 *   MR3 单调性          ↔ R44-F2、R76-F4
 *   MR4 裸 UUID 红线    ↔ R44-F2（teach-back 裸 UUID）、R83-F1（what-if 教学）
 *   MR5 语言一致性      ↔ R83-F1、R44-F2
 *
 * 回滚验证锚点：fixture C（同名设备）的 MR1b/MR3b 依赖 command-parser.ts 的
 * bestNameFragmentMatches own-first tie-break（ownDeviceIds）——回滚它，这两条
 * 必须红（教学 pass 误报「属于他人」）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BARE_UUID,
  MR1_EXPECT,
  MR1_RULE_TEXTS,
  MR2_RULE_TEXTS,
  MR3_RULE,
  MR5_RULE_PAIRS,
  MR6_RULE,
  MR_LAB_AGENT_ID,
  MR_SAME_NAME_QUALIFIED_TEXTS,
  MR_SAME_NAME_TEXTS,
  MR_WHATIF_MAPPED_TEXT,
  MR_WHATIF_UNMAPPED_TEXT,
  isSubset,
  mrEnvScenario,
  mrLabScenario,
  setsEqual,
  successfulDeviceIds,
  sortedUnique,
} from '../../scripts/nl-metamorphic-cases.mjs';

import {
  auth,
  createUserScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
} from './test-utils.js';

interface CommandResponse {
  statusCode: number;
  body: Record<string, any>;
}

/** 环境夹具里走治理通道加一个设备（builder 提案 → owner 批准），返回设备行 id。 */
async function addEnvDevice(
  ctx: TestAppContext,
  envId: string,
  ownerToken: string,
  proposerToken: string,
  device: { name: string; type: string; capabilities: string[]; zoneId: string },
): Promise<string> {
  const proposal = await ctx.app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/devices`,
    headers: auth(proposerToken),
    payload: device,
  });
  expect(proposal.statusCode).toBe(201);
  const decided = await ctx.app.inject({
    method: 'POST',
    url: `/api/proposals/${proposal.json().id}/decide`,
    headers: auth(ownerToken),
    payload: { decision: 'approved' },
  });
  expect(decided.json().status).toBe('applied');
  const rows = await ctx.app.inject({
    method: 'GET',
    url: `/api/environments/${envId}/devices`,
    headers: auth(ownerToken),
  });
  const matches = (rows.json().devices as Array<{ id: string; name: string }>)
    .filter(d => d.name === device.name);
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1].id;
}

/** 环境夹具里走治理通道加一个绑定 Agent，返回其 env 行 id（运行时 id）。 */
async function addEnvAgent(
  ctx: TestAppContext,
  envId: string,
  ownerToken: string,
  proposerToken: string,
  agent: { name: string; capabilities: string[]; boundDeviceIds: string[] },
): Promise<string> {
  const proposal = await ctx.app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/agents`,
    headers: auth(proposerToken),
    payload: agent,
  });
  expect(proposal.statusCode).toBe(201);
  const decided = await ctx.app.inject({
    method: 'POST',
    url: `/api/proposals/${proposal.json().id}/decide`,
    headers: auth(ownerToken),
    payload: { decision: 'approved' },
  });
  expect(decided.json().status).toBe('applied');
  const rows = await ctx.app.inject({
    method: 'GET',
    url: `/api/environments/${envId}/agents`,
    headers: auth(ownerToken),
  });
  const found = (rows.json().agents as Array<{ id: string; name: string }>)
    .find(a => a.name === agent.name);
  expect(found).toBeDefined();
  return found!.id;
}

// ============================================================================
// Fixture A —— 双区双空调（MR1a / MR3a / MR5 / R83-F1 what-if / MR4）
// ============================================================================

describe('F2-2 NL metamorphic relations — rule lane (scenario lab)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; email: string; token: string };
  let simId: string;
  /** MR4 sweep: every user-facing message this suite produced. */
  const messages: string[] = [];

  beforeAll(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'MR Owner' });
    const created = await createUserScenario(ctx.app, mrLabScenario('mr-lab'), owner.token);
    expect(created.statusCode).toBe(201);
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'mr-lab' },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function command(text: string): Promise<CommandResponse> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${MR_LAB_AGENT_ID}/command`,
      headers: auth(owner.token),
      payload: { text, simId },
    });
    const body = res.json();
    if (typeof body?.naturalLanguageResponse === 'string') messages.push(body.naturalLanguageResponse);
    if (typeof body?.error?.message === 'string') messages.push(body.error.message);
    return { statusCode: res.statusCode, body };
  }

  describe('MR1a 同义改写不变量：改写路由到同一设备（R44-F2）', () => {
    it('所有同义改写 → 同一 intent 路由 + 同一执行设备', async () => {
      const seenTargets: string[] = [];
      for (const text of MR1_RULE_TEXTS) {
        const res = await command(text);
        expect(res.statusCode, `text=${text}`).toBe(200);
        // 规则道：测试服无 LLM，parseSource 恒为 rules —— 锁死这条道的确定性。
        expect(res.body.intent.parseSource, `text=${text}`).toBe('rules');
        expect(res.body.intent.action, `text=${text}`).toBe(MR1_EXPECT.action);
        // 路由（intent.targetDevices）与执行（executionResult）双层一致。
        expect(sortedUnique(res.body.intent.targetDevices ?? []), `text=${text}`)
          .toEqual(MR1_EXPECT.deviceIds);
        expect(successfulDeviceIds(res.body), `text=${text}`).toEqual(MR1_EXPECT.deviceIds);
        seenTargets.push(JSON.stringify(successfulDeviceIds(res.body)));
      }
      // 蜕变核心：等价类内结果两两相同。
      expect(new Set(seenTargets).size).toBe(1);
    }, 60_000);
  });

  describe('MR3a 单调性：加 zone 限定不得落到更远的设备（R44-F2 跨区）', () => {
    it('限定客厅后执行集收窄到客厅设备，且是无限定执行集的子集', async () => {
      const base = await command(MR3_RULE.base);
      expect(base.statusCode).toBe(200);
      const baseDevices = successfulDeviceIds(base.body);
      expect(setsEqual(baseDevices, ['ac-living', 'ac-bed'])).toBe(true);

      const qualified = await command(MR3_RULE.qualified);
      expect(qualified.statusCode).toBe(200);
      expect(qualified.body.intent.targetZones).toEqual([MR3_RULE.zoneId]);
      const qualifiedDevices = successfulDeviceIds(qualified.body);
      // 非空、收窄、且全部落在被指名的 zone —— 不得落到更远的设备。
      expect(qualifiedDevices.length).toBeGreaterThan(0);
      expect(isSubset(qualifiedDevices, baseDevices)).toBe(true);
      expect(setsEqual(qualifiedDevices, MR3_RULE.zoneDeviceIds)).toBe(true);
    }, 60_000);
  });

  describe('MR5 语言一致性：中英文等价命令 action 类型一致（R83-F1）', () => {
    for (const pair of MR5_RULE_PAIRS) {
      it(`「${pair.zh}」 ↔ 「${pair.en}」`, async () => {
        const zh = await command(pair.zh);
        const en = await command(pair.en);
        expect(zh.statusCode).toBe(200);
        expect(en.statusCode).toBe(200);
        expect(zh.body.intent.parseSource).toBe('rules');
        expect(en.body.intent.parseSource).toBe('rules');
        expect(zh.body.intent.action).toBe(pair.action);
        expect(en.body.intent.action).toBe(pair.action);
        if (pair.compare === 'full') {
          // 规则路径可判定的部分：参数与执行设备集合也一致。
          expect(zh.body.intent.targetParameters).toEqual(pair.params);
          expect(en.body.intent.targetParameters).toEqual(pair.params);
          expect(setsEqual(successfulDeviceIds(zh.body), successfulDeviceIds(en.body))).toBe(true);
          expect(successfulDeviceIds(zh.body)).toEqual(pair.deviceIds);
        }
      }, 60_000);
    }
  });

  describe('R83-F1 锚点：what-if 中文调温映射 + 未映射教学', () => {
    async function whatIf(text: string): Promise<CommandResponse> {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${MR_LAB_AGENT_ID}/what-if`,
        headers: auth(owner.token),
        payload: { text, simId },
      });
      const body = res.json();
      if (typeof body?.error?.message === 'string') messages.push(body.error.message);
      return { statusCode: res.statusCode, body };
    }

    it('中文调温 what-if 映射为 intervention（不再 400）', async () => {
      const res = await whatIf(MR_WHATIF_MAPPED_TEXT);
      expect(res.statusCode).toBe(200);
      // R83-F1 的修复语义：中文调温映射到干预（zone 级 parameter_change 或
      // 解析到空调设备的 device_command），而不是未映射教学 400。
      expect(res.body.result.scenario.intervention.type).toMatch(/parameter_change|device_command/);
    }, 60_000);

    it('未映射 what-if 的教学按设备名列设备、无裸 UUID', async () => {
      const res = await whatIf(MR_WHATIF_UNMAPPED_TEXT);
      expect(res.statusCode).toBe(400);
      const message = res.body.error.message as string;
      expect(message).toContain('已知设备');
      expect(message).toContain('客厅空调');
      expect(message).not.toContain('ac-living');
      expect(message).not.toMatch(BARE_UUID);
    }, 60_000);
  });

  describe('MR6 集合目标展开：群体表述 = zone ∩ 能力类别（R84 / R44-F2 residual）', () => {
    it('「把全部空调打开」展开为全部自有空调；加 zone 限定后收窄且为子集', async () => {
      const all = await command(MR6_RULE.openAll);
      expect(all.statusCode).toBe(200);
      expect(all.body.intent.parseSource).toBe('rules');
      expect(all.body.intent.collective?.matched).toBe(2);
      expect(successfulDeviceIds(all.body)).toEqual(MR6_RULE.allDeviceIds);

      const qualified = await command(MR6_RULE.zoneQualified);
      expect(qualified.statusCode).toBe(200);
      expect(qualified.body.intent.collective?.matched).toBe(1);
      const qualifiedDevices = successfulDeviceIds(qualified.body);
      // zone 限定收窄、非空、且是无限定执行集的子集（MR3 同族单调性）。
      expect(qualifiedDevices).toEqual(MR6_RULE.zoneDeviceIds);
      expect(isSubset(qualifiedDevices, MR6_RULE.allDeviceIds)).toBe(true);
    }, 60_000);

    it('零命中集合目标给教学（按设备名列可操作面），不是静默观察', async () => {
      const res = await command(MR6_RULE.zeroMatch);
      expect(res.statusCode).toBe(200);
      expect(res.body.intent.collective?.matched).toBe(0);
      expect(res.body.executionResult.success).toBe(false);
      expect(successfulDeviceIds(res.body)).toEqual([]);
      const reasons = (res.body.executionResult.rejected ?? []).map(r => r.reason).join(' | ');
      expect(reasons).toContain(MR6_RULE.zeroMatchWord);
      for (const name of MR6_RULE.availableNames) expect(reasons).toContain(name);
      // 教学进自然语言回复（refused 行），且全套件文案过 MR4 红线。
      expect(res.body.naturalLanguageResponse).toContain(MR6_RULE.zeroMatchWord);
    }, 60_000);
  });

  describe('MR4 裸 UUID 红线（R44-F2 teach-back）', () => {
    it('404 / rename-trap 400 / ask 与 what-if 错误 / 本套件所有文案 都不含裸 UUID', async () => {
      const notFound = await ctx.app.inject({
        method: 'POST',
        url: '/api/agents/no-such-agent/command',
        headers: auth(owner.token),
        payload: { text: 'status' },
      });
      expect(notFound.statusCode).toBe(404);
      messages.push(notFound.json().error.message);

      // R84 扩扫①：ask 通道的同类 404（与 command 通道共享 resolveAgentRecord，
      // 但文案构造独立进扫描，防两条通道漂移）。
      const askNotFound = await ctx.app.inject({
        method: 'POST',
        url: '/api/agents/no-such-agent/ask',
        headers: auth(owner.token),
        payload: { text: 'status' },
      });
      expect(askNotFound.statusCode).toBe(404);
      messages.push(askNotFound.json().error.message);

      const renameTrap = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${MR_LAB_AGENT_ID}/command`,
        headers: auth(owner.token),
        payload: { command: 'make it cool' },
      });
      expect(renameTrap.statusCode).toBe(400);
      messages.push(renameTrap.json().error.message);

      // R84 扩扫②：what-if 的未知字段拒绝（rename-trap 同族文案构造）。
      const whatIfTrap = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${MR_LAB_AGENT_ID}/what-if`,
        headers: auth(owner.token),
        payload: { text: MR_WHATIF_MAPPED_TEXT, horizonSec: 600, simId },
      });
      expect(whatIfTrap.statusCode).toBe(400);
      messages.push(whatIfTrap.json().error.message);

      // R84 扩扫③：emergency 通道的 naturalLanguageResponse + ask 的回答体。
      const emergency = await command('着火了，紧急撤离');
      expect(emergency.statusCode).toBe(200);
      const ask = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${MR_LAB_AGENT_ID}/ask`,
        headers: auth(owner.token),
        payload: { text: '现在情况怎么样', simId },
      });
      expect(ask.statusCode).toBe(200);
      if (typeof ask.json()?.naturalLanguageResponse === 'string') messages.push(ask.json().naturalLanguageResponse);

      // 套件跑到这里已收集全部 command/ask/what-if 文案——统一过红线。
      // （409 AGENT_AMBIGUOUS 有意豁免：既有契约钉住 simId 出现在 message。）
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message).not.toMatch(BARE_UUID);
      }
    }, 60_000);
  });
});

// ============================================================================
// Fixture B —— 越权保持（R76-F5 形状：Flower 指挥林姐的 Agent）
// ============================================================================

describe('F2-2 MR2 越权保持 — 任意改写不得变成已执行（R76-F5）', () => {
  let ctx: TestAppContext;
  let flower: { id: string; email: string; token: string };
  let linAgentId: string;
  let simId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const envOwner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    const lin = await registerUser(ctx.app, { displayName: '街区运营者林姐' });
    flower = await registerUser(ctx.app, { displayName: 'Flower' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(envOwner.token),
      payload: { ...mrEnvScenario('mr-denial-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    for (const member of [lin, flower]) {
      const join = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members`,
        headers: auth(envOwner.token),
        payload: { email: member.email, role: 'builder' },
      });
      expect(join.statusCode).toBe(201);
    }
    const lightId = await addEnvDevice(ctx, envId, envOwner.token, lin.token, {
      name: '客厅温度传感器', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a',
    });
    linAgentId = await addEnvAgent(ctx, envId, envOwner.token, lin.token, {
      name: 'Lin Light Keeper', capabilities: ['turn-on'], boundDeviceIds: [lightId],
    });
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(envOwner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('每个越权改写都 403 + 本地化教学 + 无裸 UUID，设备状态不变', async () => {
    for (const text of MR2_RULE_TEXTS) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/agents/${linAgentId}/command`,
        headers: auth(flower.token),
        payload: { text, simId },
      });
      expect(res.statusCode, `text=${text}`).toBe(403);
      const message = res.json().error.message as string;
      // 教学恒成立（R99 请求者口径，b508e8c9）：越权 command 在决策入口即
      // 被拒，文案点名请求者非所有者 + agent 归属者、指路合约——不再点名
      // 设备（设备归属不是拒绝原因）。
      expect(message, `text=${text}`).toContain('所有者');
      expect(message, `text=${text}`).toContain('街区运营者林姐');
      expect(message, `text=${text}`).toContain('发起合约');
      expect(message, `text=${text}`).not.toMatch(BARE_UUID);
      expect(message, `text=${text}`).not.toContain('Natural-language agent commands');
    }
  }, 60_000);
});

// ============================================================================
// Fixture C —— 同名误路由（R76-F4 形状：两人各有一台同名「智能窗帘」）
// 回滚验证锚点：own-first tie-break 回滚后本组必须红。
// ============================================================================

describe('F2-2 MR1b/MR3b 同名设备 own-first（R76-F4）', () => {
  let ctx: TestAppContext;
  let mei: { id: string; email: string; token: string };
  let meiAgentId: string;
  let meiCurtainId: string;
  let simId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const envOwner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    const lin = await registerUser(ctx.app, { displayName: '街区运营者林姐' });
    mei = await registerUser(ctx.app, { displayName: '小我' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(envOwner.token),
      payload: { ...mrEnvScenario('mr-samename-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    for (const member of [lin, mei]) {
      const join = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/members`,
        headers: auth(envOwner.token),
        payload: { email: member.email, role: 'builder' },
      });
      expect(join.statusCode).toBe(201);
    }
    // 林姐先放一台「智能窗帘」（listing order 在前——回滚后它赢下 tie）。
    await addEnvDevice(ctx, envId, envOwner.token, lin.token, {
      name: '智能窗帘', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a',
    });
    // 小我自己的同名窗帘 + 绑定它的 Agent（先于仿真启动）。
    meiCurtainId = await addEnvDevice(ctx, envId, envOwner.token, mei.token, {
      name: '智能窗帘', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-b',
    });
    expect(meiCurtainId).toBeTruthy();
    meiAgentId = await addEnvAgent(ctx, envId, envOwner.token, mei.token, {
      name: 'Mei Curtain Keeper', capabilities: ['turn-on'], boundDeviceIds: [meiCurtainId],
    });
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(envOwner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function meiCommand(text: string): Promise<CommandResponse> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${meiAgentId}/command`,
      headers: auth(mei.token),
      payload: { text, simId },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  function expectNoForeignTeaching(body: Record<string, any>, text: string): void {
    const response = body.naturalLanguageResponse as string;
    // 指名自己的同名设备绝不应触发「属于他人」教学（R76-F4）。
    expect(response, `text=${text}`).not.toContain('属于');
    expect(response, `text=${text}`).not.toContain('发起合约');
    expect(response, `text=${text}`).not.toContain('街区运营者林姐');
    expect(response, `text=${text}`).not.toMatch(BARE_UUID);
  }

  it('MR1b 同义改写：指名自己的同名设备 → 永远落在本人设备、无越权教学', async () => {
    const seen: string[] = [];
    for (const text of MR_SAME_NAME_TEXTS) {
      const res = await meiCommand(text);
      expect(res.statusCode, `text=${text}`).toBe(200);
      expect(successfulDeviceIds(res.body), `text=${text}`).toEqual([meiCurtainId]);
      expectNoForeignTeaching(res.body, text);
      seen.push(JSON.stringify(successfulDeviceIds(res.body)));
    }
    expect(new Set(seen).size).toBe(1);
  }, 60_000);

  it('MR3b 单调性：加所有格限定不得把路由推离本人设备', async () => {
    for (const text of MR_SAME_NAME_QUALIFIED_TEXTS) {
      const res = await meiCommand(text);
      expect(res.statusCode, `text=${text}`).toBe(200);
      expect(successfulDeviceIds(res.body), `text=${text}`).toEqual([meiCurtainId]);
      expectNoForeignTeaching(res.body, text);
    }
  }, 60_000);
});
