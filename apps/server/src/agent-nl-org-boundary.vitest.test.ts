/**
 * @vitest-environment node
 *
 * R46C P0-A — the NL agent-command channel's device organization boundary
 * (NL 通道组织边界).
 *
 * POST /api/simulations/:id/commands got its org boundary in R46 P0-2, but
 * POST /api/agents/:id/command kept only the environment-role check
 * (assertControl): a builder of the environment could phrase a cross-org
 * order as a natural-language agent command and it executed (供电局通过水务
 * agent 的 NL 命令关掉水务的阀门, 200 — the SAME device 403s on the direct
 * channel). The fix reuses device-command-gates.ts at the EXECUTION layer
 * (the final targets are only known in the decision's deviceActions / the
 * bridged prose), injected through the NL seam:
 *
 * - another member's device via an NL command → 403 with a localized
 *   teaching message (R76-F5: the SAME text as the foreign-mention pass —
 *   owner + the device's exposed services + the agreement path);
 * - one's OWN device via one's own agent → 200 + executed;
 * - an ACTIVE agreement (consumer = caller) opens the lane → 200;
 * - admins pass on any device.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Same multi-stakeholder mini-city as the R46 P0-2 sim-lane suite. */
function cityScenario() {
  return {
    version: '1.0',
    meta: { id: 'mini-city', name: 'Mini City', description: 'R46C P0-A fixture' },
    zones: [
      { id: 'zone-power', adjacentZoneIds: ['zone-water'] },
      { id: 'zone-water', adjacentZoneIds: ['zone-power'] },
    ],
    devices: [
      {
        id: 'grid-monitor-1',
        name: '电网监测终端 1',
        type: 'electric-grid-monitor',
        capabilities: ['grid-reading'],
        zoneId: 'zone-power',
      },
      {
        id: 'pump-valve-1',
        name: '排涝智能阀 1',
        type: 'smart-valve',
        capabilities: ['turn-on', 'turn-off'],
        zoneId: 'zone-water',
      },
    ],
    agents: [
      {
        id: 'power-keeper',
        name: '宝安工业带·110kV 变电站管家',
        capabilities: ['grid-reading'],
        managesZoneIds: ['zone-power'],
        boundDeviceIds: ['grid-monitor-1'],
      },
      {
        id: 'pump-keeper',
        name: '宝安工业带·雨水泵站管家',
        capabilities: ['valve-control'],
        managesZoneIds: ['zone-water'],
        boundDeviceIds: ['pump-valve-1'],
      },
    ],
    events: [],
  };
}

describe('R46C P0-A: NL agent commands respect the device org boundary', () => {
  let ctx: TestAppContext;
  let importer: TestUser;
  let power: TestUser;
  let water: TestUser;
  let admin: TestUser;
  let envId: string;
  let simId: string;
  let pumpValveId: string;
  /** Env-backed sims run agents under their env ROW id (a UUID). */
  let pumpAgentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ adminEmails: ['admin@example.com'] });
    importer = await registerUser(ctx.app, { displayName: 'Importer' });
    power = await registerUser(ctx.app, { email: 'power@sz.gov.cn', displayName: 'Power Bureau' });
    water = await registerUser(ctx.app, { email: 'water@sz.gov.cn', displayName: 'Water Bureau' });
    admin = await registerUser(ctx.app, { email: 'admin@example.com', displayName: 'Admin' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(importer.token),
      payload: {
        ...cityScenario(),
        visibility: 'private',
        invites: [
          { email: 'power@sz.gov.cn' },
          { email: 'water@sz.gov.cn' },
        ],
        ownerAssignment: {
          agents: [
            { agentNamePattern: '变电站', toUserEmail: 'power@sz.gov.cn' },
            { agentNamePattern: '泵站', toUserEmail: 'water@sz.gov.cn' },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    pumpValveId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(d => d.name === '排涝智能阀 1')!.id;

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(importer.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(importer.token),
    });
    const pumpAgent = (snapshot.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name.includes('泵站'));
    expect(pumpAgent).toBeTruthy();
    pumpAgentId = pumpAgent!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function nlCommand(token: string, text: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${pumpAgentId}/command`,
      headers: auth(token),
      payload: { text, simId },
    });
  }

  /** The valve's live state JSON (full-stack effect checks key-agnostically). */
  async function valveState(): Promise<string> {
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(importer.token),
    });
    expect(snapshot.statusCode).toBe(200);
    const valve = (snapshot.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
      .find(d => d.id === pumpValveId);
    expect(valve).toBeTruthy();
    return JSON.stringify(valve!.state ?? {});
  }

  it("the power bureau CANNOT close water's valve by phrasing it as an agent command — refused at the ENTRY gate, before any decision (R99)", async () => {
    const before = await valveState();
    const res = await nlCommand(power.token, '关闭排涝智能阀 1');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    const message: string = res.json().error.message;
    // R99 (zhao-10): the entry identity gate names the TRUE reason — the
    // REQUESTER is not the agent's owner — never the mislabeling "设备不在
    // 我的管理范围" (the valve IS bound to the pump-keeper agent). The
    // sanctioned lanes (ask read-only / service-marketplace agreement) ride
    // the same message.
    expect(message).toContain('所有者');
    expect(message).toContain('Water Bureau');
    expect(message).toContain('发起合约');
    expect(message).toContain('/api/services/');
    expect(message).not.toContain('不在我的管理范围内');

    // No decision ran: no NL audit row exists for this denial (the refusal
    // predates the pipeline — no LLM spend, no decision-context churn).
    const audit = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=agent-nl-command`,
      headers: auth(importer.token),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries ?? []).toHaveLength(0);

    // The device did NOT move.
    expect(await valveState()).toBe(before);
  });

  it('the ENV OWNER may command a member\'s agent (entry gate passes)', async () => {
    const res = await nlCommand(importer.token, '打开排涝智能阀 1');
    expect(res.statusCode).toBe(200);
    expect(res.json().executionResult.actions[0]).toMatchObject({ success: true });
  });

  it('cross-member ASK stays open (read-only costs no decision resources)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${pumpAgentId}/ask`,
      headers: auth(power.token),
      payload: { text: '排涝智能阀 1 现在是什么状态？', simId },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().naturalLanguageResponse).toBe('string');
  });

  it('execution-layer denial speaks the REQUESTER-accurate cause when the device IS bound to the agent (R99 wording)', async () => {
    // The valve stays BOUND to water's pump-keeper but its OWNERSHIP moves
    // to the power bureau (governance-plane handover — same lane
    // ownership-transfer proposals use). Water (agent owner, entry gate
    // passes) then commands its own agent about its own bound device and
    // hits the device-ownership gate at the execution layer.
    ctx.app.envStore.updateDevice(pumpValveId, { ownerId: power.id });
    const res = await nlCommand(water.token, '关闭排涝智能阀 1');
    expect(res.statusCode).toBe(403);
    const message: string = res.json().error.message;
    // The true cause: the REQUESTER is not the device owner — never the
    // agent-voice "不在我的管理范围内" (the device IS bound to this agent).
    expect(message).toContain('排涝智能阀 1');
    expect(message).toContain('Power Bureau');
    expect(message).toContain('不是它的所有者');
    expect(message).toContain('发起合约');
    expect(message).not.toContain('不在我的管理范围内');
  });

  it("water opening its OWN valve through its own agent executes (200 + command ran)", async () => {
    const before = await valveState();
    const res = await nlCommand(water.token, '打开排涝智能阀 1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intent.action).toBe('set_parameter');
    expect(body.executionResult.actions).toHaveLength(1);
    expect(body.executionResult.actions[0]).toMatchObject({
      deviceId: pumpValveId,
      command: 'turn-on',
      success: true,
    });
    expect(body.executionResult.success).toBe(true);

    // The device ACTUALLY moved.
    expect(await valveState()).not.toBe(before);
  });

  it('an ACTIVE agreement opens the cross-org NL lane (consumer = caller)', async () => {
    // Before: power is fenced out.
    const before = await nlCommand(power.token, '打开排涝智能阀 1');
    expect(before.statusCode).toBe(403);

    // Power signs a contract on water's pump-turn-on service; water accepts.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(power.token),
    });
    const pumpTurnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name.startsWith('排涝智能阀 1:') && service.name.includes('开启'));
    expect(pumpTurnOn).toBeTruthy();
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${pumpTurnOn!.id}/agreements`,
      headers: auth(power.token),
      payload: { terms: {} },
    });
    expect(proposed.statusCode).toBe(201);
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${proposed.json().id}/decide`,
      headers: auth(water.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');

    // The sanctioned lane: the SAME NL command now executes.
    const during = await nlCommand(power.token, '打开排涝智能阀 1');
    expect(during.statusCode).toBe(200);
    expect(during.json().executionResult.actions[0]).toMatchObject({ success: true });
  });

  it('admins pass on any device through the NL channel', async () => {
    const res = await nlCommand(admin.token, '打开排涝智能阀 1');
    expect(res.statusCode).toBe(200);
    expect(res.json().executionResult.actions[0]).toMatchObject({ success: true });
  });
});
