/**
 * @vitest-environment node
 *
 * F0-3 教学文案错误信封契约测试（plan-r84 Wave F0-3）——钉住两条教学文案的
 * 结构惯例，防止 R76-F5（英文 raw 泄漏）/ R83-F1（裸 UUID teach-back）类
 * 回归：
 *
 * 1. POST /api/agents/:id/command 的跨组织越权 403（ForeignDeviceTeachingError）：
 *    message 本地化（跟随请求 locale）、点名设备名与归属者、指路合约路径、
 *    绝不出现裸 UUID；
 * 2. POST /api/agents/:id/what-if 的未映射 400（WhatIfUnmappedError）：
 *    message 本地化、按设备名列出已知设备、绝不出现裸 UUID。
 *
 * spec 侧（schema + 路由引用）由 openapi.vitest.test.ts 的
 * "pins the NL/what-if teaching error envelopes" 钉住；本文件驱动真实实现
 * （路由级，makeTestApp + inject，与 agent-nl/agent-what-if 同一套 harness）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auth,
  createUserScenario,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
} from './test-utils.js';

/** F0-3 红线：教学文案引用设备名/显示名，裸 UUID 一律不得出现在 message。 */
const BARE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/;

const EN_HEADERS = { 'accept-language': 'en-US' };

describe('F0-3 teaching-error contract — NL command 403 (R76-F5)', () => {
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
      payload: { ...importableScenario('f03-denial-lab'), visibility: 'public' },
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
    // 林姐's OWN device + the agent bound to it, via the governance lane
    // (builder 的创建走提案 → owner 批准)，且必须先于仿真启动。
    const deviceProposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(lin.token),
      payload: { name: '客厅温度传感器', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a' },
    });
    expect(deviceProposal.statusCode).toBe(201);
    const approvedDevice = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${deviceProposal.json().id}/decide`,
      headers: auth(envOwner.token),
      payload: { decision: 'approved' },
    });
    expect(approvedDevice.json().status).toBe('applied');
    const deviceRows = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/devices`,
      headers: auth(envOwner.token),
    });
    const lightId = (deviceRows.json().devices as Array<{ id: string; name: string }>)
      .find(d => d.name === '客厅温度传感器')!.id;

    const agentProposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(lin.token),
      payload: { name: 'Lin Light Keeper', capabilities: ['turn-on'], boundDeviceIds: [lightId] },
    });
    expect(agentProposal.statusCode).toBe(201);
    const approvedAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${agentProposal.json().id}/decide`,
      headers: auth(envOwner.token),
      payload: { decision: 'approved' },
    });
    expect(approvedAgent.json().status).toBe('applied');
    const agentRows = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/agents`,
      headers: auth(envOwner.token),
    });
    linAgentId = (agentRows.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'Lin Light Keeper')!.id;

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

  async function crossOrgCommand(headers: Record<string, string>): Promise<{ statusCode: number; message: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${linAgentId}/command`,
      headers: { ...auth(flower.token), ...headers },
      payload: { text: '打开客厅温度传感器', simId },
    });
    return { statusCode: res.statusCode, message: res.json().error?.message ?? '' };
  }

  it('zh (default locale): 教学文案点名归属者、指路合约、无裸 UUID、无英文 raw', async () => {
    const res = await crossOrgCommand({});
    expect(res.statusCode).toBe(403);
    // R99 请求者口径（b508e8c9）：越权 command 在决策入口被拒，文案点名
    // 请求者非所有者 + agent 归属者——设备归属不是拒绝原因。
    expect(res.message).toContain('所有者');
    expect(res.message).toContain('Lin Light Keeper');
    expect(res.message).toContain('街区运营者林姐');
    expect(res.message).toContain('发起合约');
    expect(res.message).toContain('/api/services/{id}/agreements');
    expect(res.message).not.toMatch(BARE_UUID);
    // R76-F5 红线：英文 raw gate 原文只进审计，不进用户响应。
    expect(res.message).not.toContain('Natural-language agent commands');
    expect(res.message).not.toContain('owned by');
  }, 30_000);

  it('en (Accept-Language: en-US): same teaching, localized to English, still no bare UUID', async () => {
    const res = await crossOrgCommand(EN_HEADERS);
    expect(res.statusCode).toBe(403);
    expect(res.message).toContain('"Lin Light Keeper"');
    expect(res.message).toContain('belongs to 街区运营者林姐');
    expect(res.message).toContain('propose an agreement');
    expect(res.message).toContain('/api/services/{id}/agreements');
    expect(res.message).not.toMatch(BARE_UUID);
    expect(res.message).not.toContain('属于');
  }, 30_000);
});

describe('F0-3 teaching-error contract — what-if unmapped 400 (R83-F1)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; email: string; token: string };
  let simId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'What-if Owner' });
    const created = await createUserScenario(ctx.app, {
      version: '1.0',
      meta: { id: 'f03-what-if-lab', name: 'F0-3 What-if Lab' },
      zones: [
        { id: 'lobby', name: 'Lobby', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 }, baseline: { temperature: 32 } },
      ],
      devices: [
        {
          id: 'hvac-1',
          name: 'HVAC 1',
          type: 'hvac',
          capabilities: ['set-temperature', 'turn-on', 'turn-off'],
          zoneId: 'lobby',
          initialState: { power: true, status: 'on', mode: 'cooling', targetTemperature: 22 },
        },
      ],
      agents: [
        {
          id: 'thermal-ops-1',
          name: 'ThermalOps',
          capabilities: ['temperature-control'],
          managesZoneIds: ['lobby'],
          boundDeviceIds: ['hvac-1'],
        },
      ],
    }, owner.token);
    expect(created.statusCode).toBe(201);
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'f03-what-if-lab' },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function unmappedWhatIf(text: string, headers: Record<string, string>): Promise<{ statusCode: number; message: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: { ...auth(owner.token), ...headers },
      payload: { text, simId },
    });
    return { statusCode: res.statusCode, message: res.json().error?.message ?? '' };
  }

  it('zh (default locale): 未映射教学按设备名列出已知设备、无裸 UUID', async () => {
    const res = await unmappedWhatIf('如果明天下雨会怎样', {});
    expect(res.statusCode).toBe(400);
    expect(res.message).toContain('我理解了这个 what-if 问题');
    expect(res.message).toContain('已知设备');
    expect(res.message).toContain('HVAC 1');
    expect(res.message).not.toContain('hvac-1');
    expect(res.message).not.toMatch(BARE_UUID);
  }, 30_000);

  it('en (Accept-Language: en-US): the unmapped teaching speaks English and names devices', async () => {
    const res = await unmappedWhatIf('what if it rains tomorrow?', EN_HEADERS);
    expect(res.statusCode).toBe(400);
    expect(res.message).toContain('could not map it onto an intervention');
    expect(res.message).toContain('Known devices');
    expect(res.message).toContain('HVAC 1');
    expect(res.message).not.toContain('hvac-1');
    expect(res.message).not.toMatch(BARE_UUID);
    expect(res.message).not.toContain('已知设备');
  }, 30_000);
});
