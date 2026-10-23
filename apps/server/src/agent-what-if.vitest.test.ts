/**
 * Agent what-if route tests (cognitive architecture Phase 4, §4.4 — the
 * simulation engine AS the world model).
 *
 * POST /api/agents/:id/what-if — end-to-end over a REAL simulation created
 * through the API: structured + text interventions, the deterministic
 * dual-fork prediction (baseline vs intervention), teaching validation,
 * determinism (same request → bit-identical result), the no-reflow red line
 * (the live world is untouched), and the VERIFY-BEFORE-ACT lane on
 * POST /api/agents/:id/command (a predicted degradation blocks the batch
 * before any device command executes).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { auth, createUserScenario, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

/**
 * One hot lobby held cool by an HVAC — the spec's worked example. Baselines
 * are PINNED (wall-clock-independent); the 8×8 room keeps thermal mass small
 * so a test window shows the physics (same discipline as the core tests).
 */
function whatIfLabScenario(
  id: string,
  hvacPowered = true,
  metaExtra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { id, name: 'What-if Lab', ...metaExtra },
    zones: [
      {
        id: 'lobby',
        name: 'Lobby',
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
        baseline: { temperature: 32 },
      },
    ],
    devices: [
      {
        id: 'hvac-1',
        name: 'HVAC 1',
        type: 'hvac',
        capabilities: ['set-temperature', 'turn-on', 'turn-off'],
        zoneId: 'lobby',
        initialState: { power: hvacPowered, status: hvacPowered ? 'on' : 'off', mode: 'cooling', targetTemperature: 22 },
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
  };
}

describe('agent what-if routes (Phase 4 predictive lane)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; email: string; token: string };

  beforeAll(async () => {
    ctx = await makeTestApp();
    const user = await registerUser(ctx.app, { displayName: 'What-if Owner' });
    owner = { id: user.id, email: user.email, token: user.token };
    const created = await createUserScenario(ctx.app, whatIfLabScenario('what-if-lab'), owner.token);
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function createSim(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'what-if-lab' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function snapshotOf(simId: string): Promise<{ zones: Array<{ id: string; parameters: Record<string, unknown> }>; devices: Array<{ id: string; state: Record<string, unknown> }> }> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('401s without authentication', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      payload: { intervention: { type: 'device_disable', target: 'hvac-1' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s (teaching) when no live simulation runs the agent', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/no-such-agent/what-if',
      headers: auth(owner.token),
      payload: { text: 'what if it gets hot?' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('AGENT_NOT_FOUND');
  });

  it('runs a structured what-if end to end: degradation with series, deltas, and an untouched live world', async () => {
    const simId = await createSim();
    const before = await snapshotOf(simId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        durationSec: 900,
        simId,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agentId).toBe('thermal-ops-1');
    expect(body.simulationId).toBe(simId);
    expect(body.simTimeSec).toBe(0); // the fork anchored at the world's t0

    const result = body.result;
    expect(result.verdict).toBe('degradation');
    expect(result.confidence).toBeGreaterThanOrEqual(0.3);
    // Default metric trio scoped to the intervention zone (hvac-1 → lobby).
    expect(result.delta['temperature_lobby']).toBeGreaterThan(0);
    expect(result.delta['energy_lobby']).toBeLessThan(0);
    expect(result.baseline['temperature_lobby'].length).toBeGreaterThan(2);
    expect(result.intervention['temperature_lobby']).not.toEqual(result.baseline['temperature_lobby']);
    expect(result.contributions.length).toBe(3);
    expect(result.explanation).toContain('degradation');
    // The prediction is FAST (the task brief's < 2s budget for a window).
    expect(body.durationMs).toBeLessThan(4000);

    // The NO-REFLOW red line: the live world is exactly as it was.
    const after = await snapshotOf(simId);
    expect(after.zones).toEqual(before.zones);
    expect(after.devices.map(d => d.state)).toEqual(before.devices.map(d => d.state));
  }, 30_000);

  it('parses free text ("what if I turn off HVAC 1 for 30 minutes?") onto the structured scenario', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: 'What if I turn off HVAC 1 for 30 minutes?', simId },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.scenario.intervention).toEqual({ type: 'device_command', target: 'hvac-1', action: 'turn-off' });
    expect(result.scenario.durationSec).toBe(1800);
    expect(result.verdict).toBe('degradation');
  }, 30_000);

  it('R83: zone-NAMED zh prose (「如果把 Lobby 温度调到 35 度会怎样」) maps onto the zone’s HVAC', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: '如果把 Lobby 温度调到 35 度会怎样', simId },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.scenario.intervention).toEqual({
      type: 'device_command',
      target: 'hvac-1',
      action: 'set-temperature',
      value: 35,
    });
  }, 30_000);

  it('T2 (R2 u1-F1): temperature asks downgrade onto a capability-named surface; delta uses the real setpoint', async () => {
    // u1's campus shape: the target AC speaks CAPABILITY names
    // (temperature-control/cooling), a SIBLING thermostat puts
    // set-temperature into the parse budget's world-wide command union.
    const t2Scenario: Record<string, unknown> = {
      version: '1.0',
      meta: { id: 'what-if-t2', name: 'What-if T2' },
      zones: [
        {
          id: 'bldg-d-f1', name: 'D栋一层', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 },
          baseline: { temperature: 30 },
        },
      ],
      devices: [
        {
          id: 'ac-d-f1', name: 'D栋空调', type: 'hvac',
          capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
          zoneId: 'bldg-d-f1',
          initialState: { power: true, status: 'on', mode: 'cooling', targetTemperature: 24 },
        },
        {
          id: 'thermo-d-f1', name: 'D栋温控', type: 'thermostat',
          capabilities: ['set-temperature', 'temperature-reading'],
          zoneId: 'bldg-d-f1',
          initialState: { targetTemperature: 20 },
        },
      ],
      agents: [
        {
          id: 'thermal-ops-t2', name: 'ThermalOps-T2', capabilities: ['temperature-control'],
          managesZoneIds: ['bldg-d-f1'], boundDeviceIds: ['ac-d-f1', 'thermo-d-f1'],
        },
      ],
    };
    const created = await createUserScenario(ctx.app, t2Scenario, owner.token);
    expect(created.statusCode).toBe(201);
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'what-if-t2' },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    // en: relative delta ("setpoint by 2 degrees") → mapped + offset 24+2.
    const en = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-t2/what-if',
      headers: auth(owner.token),
      payload: { text: "What if I raise D栋空调's setpoint by 2 degrees for 30 minutes?", simId },
    });
    expect(en.statusCode).toBe(200);
    const enResult = en.json().result;
    expect(enResult.scenario.intervention).toEqual({
      type: 'device_command', target: 'ac-d-f1', action: 'temperature-control', value: 26,
    });
    expect(enResult.notes.some((n: string) => n.includes('mapped to its "temperature-control"'))).toBe(true);

    // zh: 「调高2度」 (no 温度 keyword) reaches the same delta lane.
    const zh = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-t2/what-if',
      headers: auth(owner.token),
      payload: { text: '如果把D栋空调调高2度会怎样？', simId },
    });
    expect(zh.statusCode).toBe(200);
    expect(zh.json().result.scenario.intervention).toEqual({
      type: 'device_command', target: 'ac-d-f1', action: 'temperature-control', value: 26,
    });
  }, 30_000);

  it('R83: an unmapped zh question answers in zh and names devices (no raw ids)', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: '如果明天下雨会怎样', simId },
    });
    expect(res.statusCode).toBe(400);
    const message = res.json().error.message as string;
    expect(message).toContain('我理解了这个 what-if 问题');
    expect(message).toContain('HVAC 1');
    expect(message).not.toContain('hvac-1');
  }, 30_000);

  it('T25 (R3 u1-F2): the zh TAIL question (no opener) and the hyphen spelling open the lane directly', async () => {
    const simId = await createSim();
    // u1's shape: 「HVAC 1 关掉 30 分钟会怎样」 — sentence-final interrogative,
    // no 如果/what-if prefix. The device literal + turn-off verb are the cues.
    const tail = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: 'HVAC 1 关掉 30 分钟会怎样', simId },
    });
    expect(tail.statusCode).toBe(200);
    expect(tail.json().result.scenario.intervention).toEqual({
      type: 'device_command', target: 'hvac-1', action: 'turn-off',
    });
    expect(tail.json().result.scenario.durationSec).toBe(1800);

    // The hyphen spelling ("what-if …") is the same opener.
    const hyphen = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: 'what-if I turn off HVAC 1 for 30 minutes?', simId },
    });
    expect(hyphen.statusCode).toBe(200);
    expect(hyphen.json().result.scenario.intervention).toEqual({
      type: 'device_command', target: 'hvac-1', action: 'turn-off',
    });
  }, 30_000);

  it('T25 (R3 u1-F2): a tail question WITHOUT an intervention cue stays outside the lane (teaching 400, not a misparse)', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: '今天天气会怎样', simId },
    });
    expect(res.statusCode).toBe(400);
    const message = res.json().error.message as string;
    // The teaching names the tail-question form (R102: the error teaches the
    // usable shapes) — it is the lane's entry gate, not the unmapped error.
    // The harness locale is zh-CN, so the teaching answers in zh.
    expect(message).toContain('不是 what-if 问题');
    expect(message).toContain('会怎样');
  }, 30_000);

  it('R51: a COORDINATOR (no bound devices) resolves names through its managed zones', async () => {
    // The coordinator manages the lobby but owns nothing; a same-named
    // valve in the annex must not steal the mention.
    const scenario = {
      ...whatIfLabScenario('what-if-coordinator'),
      zones: [
        { id: 'lobby', name: 'Lobby', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 }, baseline: { temperature: 32 } },
        { id: 'annex', name: 'Annex', bounds: { minX: 8, maxX: 16, minY: 0, maxY: 8 }, baseline: { temperature: 30 } },
      ],
      devices: [
        {
          id: 'lobby-valve', name: '排水阀 1', type: 'smart-valve',
          capabilities: ['turn-on', 'turn-off', 'open'], zoneId: 'lobby',
        },
        {
          id: 'annex-valve', name: '排水阀 1', type: 'smart-valve',
          capabilities: ['turn-on', 'turn-off', 'open'], zoneId: 'annex',
        },
      ],
      agents: [
        {
          id: 'coordinator-1', name: 'District Coordinator',
          capabilities: ['coordination'], managesZoneIds: ['lobby'],
          boundDeviceIds: [],
        },
      ],
    };
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/environments', headers: auth(owner.token), payload: scenario,
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    // import remaps scenario ids to instance ids — ask through the real one
    const coordinatorId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'District Coordinator')!.id;
    const sim = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${coordinatorId}/what-if`,
      headers: auth(owner.token),
      payload: { text: '如果关闭排水阀1十五分钟会怎样', simId },
    });
    expect(res.statusCode).toBe(200);
    // The managed-zone scope (lobby) disambiguates the same-named valves.
    const target = res.json().result.scenario.intervention.target as string;
    const zoneOfTarget = (created.json().devices as Array<{ id: string; zoneId: string }>).find(d => d.id === target)?.zoneId;
    expect(zoneOfTarget).toBe('lobby');
  }, 30_000);

  it('is DETERMINISTIC end to end: the same request returns a bit-identical result', async () => {
    const simId = await createSim();
    const payload = {
      intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
      durationSec: 600,
      simId,
    };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Strip the wall-clock duration — everything else must be identical.
    const { durationMs: _a, ...firstResult } = first.json();
    const { durationMs: _b, ...secondResult } = second.json();
    expect(secondResult).toEqual(firstResult);
  }, 30_000);

  it('teaches on every bad input (never silently drops)', async () => {
    const simId = await createSim();
    const post = async (payload: Record<string, unknown>): Promise<{ statusCode: number; message: string }> => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/agents/thermal-ops-1/what-if',
        headers: auth(owner.token),
        payload: { simId, ...payload },
      });
      return { statusCode: res.statusCode, message: res.json().error?.message ?? '' };
    };

    // Rename trap fires BEFORE the generic unknown-field error.
    expect(await post({ question: 'what if it gets hot?' })).toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('did you mean "text"'),
    });
    expect(await post({ text: 'what if x?', intervention: { type: 'device_disable', target: 'hvac-1' } }))
      .toMatchObject({ statusCode: 400 });
    expect(await post({ durationSec: 0, intervention: { type: 'device_disable', target: 'hvac-1' } }))
      .toMatchObject({ statusCode: 400, message: expect.stringContaining('[1, 3600]') });
    expect(await post({ text: 'turn off hvac-1' })).toMatchObject({
      statusCode: 400,
      // T25: the entry-gate teaching localizes (harness locale zh-CN) and
      // names every accepted shape, tail question included.
      message: expect.stringContaining('不是 what-if 问题'),
    });
    expect(await post({ text: 'what if it rains tomorrow?' })).toMatchObject({
      statusCode: 400,
      // R83: default locale is zh-CN and devices are NAMED, never raw ids.
      message: expect.stringContaining('HVAC 1'),
    });
    expect(
      await post({ intervention: { type: 'device_command', target: 'hvac-99', action: 'turn-off' } }),
    ).toMatchObject({ statusCode: 400, message: expect.stringContaining('hvac-99') });
    expect(
      await post({ intervention: { type: 'device_command', target: 'hvac-1', action: 'self-destruct' } }),
    ).toMatchObject({ statusCode: 400, message: expect.stringContaining('self-destruct') });
    expect(
      await post({ intervention: { type: 'parameter_change', target: 'lobby', action: 'temperature' } }),
    ).toMatchObject({ statusCode: 400, message: expect.stringContaining('value is required') });
  });

  it('R40-B1 quota: meta.whatIfQuota.maxDurationSec caps the lookahead with a teaching 400', async () => {
    const created = await createUserScenario(
      ctx.app,
      whatIfLabScenario('what-if-lab-quota', true, { whatIfQuota: { maxDurationSec: 300 } }),
      owner.token,
    );
    expect(created.statusCode).toBe(201);
    const simRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'what-if-lab-quota' },
    });
    expect(simRes.statusCode).toBe(201);
    const simId = simRes.json().id as string;

    // Beyond the world's own budget → teaching 4xx naming the allowed cap.
    const over = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        durationSec: 600,
        simId,
      },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toContain('[1, 300]');
    expect(over.json().error.message).toContain('whatIfQuota.maxDurationSec');

    // Within the quota runs normally.
    const within = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-off' },
        durationSec: 300,
        simId,
      },
    });
    expect(within.statusCode).toBe(200);
    expect(within.json().result.scenario.durationSec).toBe(300);

    // Free-text durations clamp to the quota (never past it).
    const text = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: { text: 'What if I turn off HVAC 1 for 30 minutes?', simId },
    });
    expect(text.statusCode).toBe(200);
    expect(text.json().result.scenario.durationSec).toBe(300);
  }, 30_000);

  it('an IMPROVEMENT hypothesis (turn the HVAC ON in the hot, uncooled world) verifies positively', async () => {
    // A dedicated UNCOOLED lab (hvac-1 starts unpowered in the 32°C lobby) —
    // NB: turning the HVAC off through /command would itself be blocked by
    // verify-before-act (it IS a degradation), so the setup must be baked
    // into the scenario, not commanded.
    const created = await createUserScenario(ctx.app, whatIfLabScenario('what-if-lab-off', false), owner.token);
    expect(created.statusCode).toBe(201);
    const simRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'what-if-lab-off' },
    });
    expect(simRes.statusCode).toBe(201);
    const simId = simRes.json().id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/what-if',
      headers: auth(owner.token),
      payload: {
        intervention: { type: 'device_command', target: 'hvac-1', action: 'turn-on' },
        durationSec: 1800,
        simId,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.verdict).toBe('improvement');
    expect(res.json().result.delta['temperature_lobby']).toBeLessThan(0);
  }, 30_000);

  it('VERIFY-BEFORE-ACT on /command: a predicted DEGRADATION blocks the device write', async () => {
    const simId = await createSim();
    const before = await snapshotOf(simId);

    // "set temperature to 35" in a zone the HVAC holds at 22 — the fork
    // predicts heating the lobby outside its comfort band → blocked.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/command',
      headers: auth(owner.token),
      payload: { text: 'set the lobby temperature to 35', simId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.executionResult.success).toBe(false);
    expect(body.executionResult.actions).toEqual([]);
    expect(body.executionResult.verification?.verdict).toBe('degradation');
    expect(body.executionResult.rejected?.[0].reason).toContain('what-if verification');

    // Full-stack proof: the device state NEVER moved.
    const after = await snapshotOf(simId);
    const device = after.devices.find(d => d.id === 'hvac-1');
    expect(device.state.targetTemperature).toBe(before.devices.find(d => d.id === 'hvac-1').state.targetTemperature);
  }, 30_000);

  it('VERIFY-BEFORE-ACT on /command: a benign command still executes and reports its verification', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/thermal-ops-1/command',
      headers: auth(owner.token),
      payload: { text: 'set the lobby temperature to 24', simId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.executionResult.actions).toHaveLength(1);
    expect(body.executionResult.actions[0]).toMatchObject({ deviceId: 'hvac-1', command: 'set-temperature', success: true });
    // Cooling the 32°C lobby toward 24 is inside the band — not a degradation.
    expect(body.executionResult.verification).toBeDefined();
    expect(body.executionResult.verification?.verdict).not.toBe('degradation');

    const snapshot = await snapshotOf(simId);
    const device = snapshot.devices.find(d => d.id === 'hvac-1');
    expect(device.state.targetTemperature).toBe(24);
  }, 30_000);
});

/**
 * R98 zhao-05: lab-101 holds several ACs; a generic 「101 的空调」 mention
 * used to be silently mapped onto a colleague's already-off AC, answering
 * "no effect" (neutral + zeros) about the WRONG device. The answer must now
 * declare its mapping basis (chosen device NAMED, candidates listed) and an
 * all-zero window must read inconclusive, never an affirmative neutral.
 */
describe('agent what-if — R98 mapping honesty (zhao-05)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; email: string; token: string };

  beforeAll(async () => {
    ctx = await makeTestApp();
    const user = await registerUser(ctx.app, { displayName: 'R98 What-if Owner' });
    owner = { id: user.id, email: user.email, token: user.token };
    const created = await createUserScenario(ctx.app, {
      version: '1.0',
      meta: { id: 'what-if-r98-lab', name: 'R98 What-if Lab' },
      zones: [
        { id: 'lab-101', name: '实验室101', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 }, baseline: { temperature: 32 } },
      ],
      devices: [
        {
          id: 'zhao-ac', name: '赵-101空调', type: 'hvac',
          capabilities: ['set-temperature', 'turn-on', 'turn-off'], zoneId: 'lab-101',
          initialState: { power: true, status: 'on', mode: 'cooling', targetTemperature: 24 },
        },
        {
          id: 'li-ac', name: 'lab-101 格力空调', type: 'hvac',
          capabilities: ['set-temperature', 'turn-on', 'turn-off'], zoneId: 'lab-101',
          initialState: { power: false, status: 'off' },
        },
      ],
      agents: [
        {
          id: 'zhao-butler', name: '赵家楼宇管家', capabilities: ['temperature-control'],
          managesZoneIds: ['lab-101'], boundDeviceIds: ['zhao-ac', 'li-ac'],
        },
      ],
    }, owner.token);
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function createSim(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'what-if-r98-lab' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('the answer declares its mapping basis: simulated device NAMED in the explanation, parse notes in the response', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/zhao-butler/what-if',
      headers: auth(owner.token),
      payload: { text: '如果把 赵-101空调 关掉 30 分钟会怎样？', simId },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.scenario.intervention.target).toBe('zhao-ac');
    // The explanation says WHICH device was simulated — readable name, no
    // bare-UUID-only reference (T55: and no "(name (uuid))" hybrid either —
    // the structured scenario.intervention.target carries the id).
    expect(result.explanation).toContain('赵-101空调');
    expect(result.explanation).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(result.explanation).not.toContain('(zhao-ac)');
    // The parse notes reach the response (previously computed and dropped).
    expect(result.notes.some((n: string) => n.includes('30 分钟') || n.includes('30 minutes'))).toBe(true);
    // Turning the cooling AC off in the 32°C lab heats it: a real verdict,
    // not zeros.
    expect(result.verdict).toBe('degradation');
  }, 30_000);

  it('turning off an already-off AC is INCONCLUSIVE with the causes named — never an affirmative neutral', async () => {
    const simId = await createSim();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/agents/zhao-butler/what-if',
      headers: auth(owner.token),
      payload: { text: '如果把 lab-101 格力空调 关掉 30 分钟会怎样？', simId },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.scenario.intervention.target).toBe('li-ac');
    expect(Object.values(result.delta as Record<string, number>).every(v => v === 0)).toBe(true);
    expect(result.verdict).toBe('inconclusive');
    expect(result.explanation).toContain('lab-101 格力空调');
    expect(result.explanation).not.toContain('(li-ac)'); // T55: NL face carries no raw ids
    expect(result.explanation).toContain('already in the requested state');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// T109 (R18, u1-F1): the WHAT-IF lane's jurisdiction disclosure — the ask
// lane's T105 judgment wired at the what-if assembly point. u1 asked the
// A栋 butler to preview a B栋 device and got a bare delta table (it read
// like the agent could operate B栋); the EN twin fell back to the
// requester's OWN device with "zone clues [none]" — the jurisdiction-only
// parse surface never saw "building B". Both halves close here:
//   - the parse's zone surface is the FULL world (the runNLAsk mentionZones
//     role), so a foreign-building mention resolves honestly;
//   - a cross-district intervention rides the bilingual 「不在辖区」 note
//     (structured top-level `jurisdictionNote`, same field as ask).
// The world is ENV-backed (the production shape: env rows drive the manager
// pointer), two single-floor districts, one controllable HVAC each.
// ---------------------------------------------------------------------------
describe('T109 (R18, u1-F1): a cross-district what-if carries the jurisdiction disclosure', () => {
  let ctx: TestAppContext;
  let owner: { id: string; email: string; token: string };
  let keeperA: string;
  let simId: string;
  let hvacA1: string;
  let hvacB1: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    const user = await registerUser(ctx.app, { displayName: 'What-if Jurisdiction Owner' });
    owner = { id: user.id, email: user.email, token: user.token };
    const bounds = { minX: 0, maxX: 8, minY: 0, maxY: 8 };
    const hvacState = { power: true, status: 'on', mode: 'cooling', targetTemperature: 22 };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'what-if-jurisdiction', name: 'What-if Jurisdiction Lab', description: 'two districts' },
        zones: [
          { id: 'zone-a1', name: 'A栋1F', bounds, baseline: { temperature: 21 } },
          { id: 'zone-b1', name: 'B栋1F', bounds, baseline: { temperature: 31 } },
        ],
        devices: [
          {
            id: 'hvac-a1', name: 'A栋空调', type: 'hvac',
            capabilities: ['set-temperature', 'turn-on', 'turn-off'],
            zoneId: 'zone-a1', initialState: hvacState,
          },
          {
            id: 'hvac-b1', name: 'B栋空调', type: 'hvac',
            capabilities: ['set-temperature', 'turn-on', 'turn-off'],
            zoneId: 'zone-b1', initialState: hvacState,
          },
        ],
        agents: [
          {
            id: 'keeper-a', name: 'A栋管家', capabilities: ['temperature-control'],
            managesZoneIds: ['zone-a1'], boundDeviceIds: ['hvac-a1'],
          },
          {
            id: 'keeper-b', name: 'B栋管家', capabilities: ['temperature-control'],
            managesZoneIds: ['zone-b1'], boundDeviceIds: ['hvac-b1'],
          },
        ],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const labEnvId = created.json().id as string;
    // The env import assigns SERVER ids to devices (declared ids are names
    // only) — resolve them by their stable display names.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${labEnvId}`,
      headers: auth(owner.token),
    });
    const deviceRows = detail.json().devices as Array<{ id: string; name: string }>;
    hvacA1 = deviceRows.find(row => row.name === 'A栋空调')!.id;
    hvacB1 = deviceRows.find(row => row.name === 'B栋空调')!.id;
    const roster = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${labEnvId}/agents`,
      headers: auth(owner.token),
    });
    const rows = roster.json().agents as Array<{ id: string; name: string }>;
    keeperA = rows.find(row => row.name === 'A栋管家')!.id;
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: labEnvId, options: { llmClient: 'none' } },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id;
    expect(
      (await ctx.app.inject({
        method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(owner.token), payload: {},
      })).statusCode,
    ).toBe(200);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  function whatIf(agentId: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/what-if`,
      headers: auth(owner.token),
      payload: { simId, ...payload },
    });
  }

  // u1 F1 verbatim sentence shape: the A栋 butler previews a B栋 device.
  it('「如果把 B栋 的空调调到 26 度会怎样」 asked of A栋管家: the fork runs the FOREIGN device and the note discloses it', async () => {
    const res = await whatIf(keeperA, { text: '如果把 B栋 的空调调到 26 度会怎样' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The intervention resolved to the foreign device (never silently swapped
    // onto the requester's own unit).
    expect(body.result.scenario.intervention.target).toBe(hvacB1);
    const note = body.jurisdictionNote as string | undefined;
    expect(note).toBeDefined();
    expect(note).toContain('不在该 agent 的辖区');
    expect(note).toContain('B栋1F'); // the REAL parsed zone name — never a fabrication
    expect(note).toContain('B栋管家'); // the manager pointer
    expect(note).toContain('fork 演练'); // the authority boundary, what-if wording
  }, 30_000);

  it('the STRUCTURED intervention path discloses too: targeting the foreign device carries the note', async () => {
    const res = await whatIf(keeperA, {
      intervention: { type: 'device_command', target: hvacB1, action: 'turn-off' },
      durationSec: 600,
    });
    expect(res.statusCode).toBe(200);
    const note = res.json().jurisdictionNote as string | undefined;
    expect(note).toBeDefined();
    expect(note).toContain('B栋1F');
    expect(note).toContain('B栋管家');
  }, 30_000);

  it('a zone-targeted parameter_change discloses the foreign ZONE itself (parameter/event lanes target zoneIds)', async () => {
    const res = await whatIf(keeperA, {
      intervention: { type: 'parameter_change', target: 'zone-b1', action: 'temperature', value: 35 },
      durationSec: 600,
    });
    expect(res.statusCode).toBe(200);
    const note = res.json().jurisdictionNote as string | undefined;
    expect(note).toBeDefined();
    expect(note).toContain('B栋1F');
    expect(note).toContain('不在该 agent 的辖区');
  }, 30_000);

  it('「What if I turn off the AC in building B」: the EN zone clue resolves against the WORLD surface (was: own-device fallback with "zone clues [none]")', async () => {
    const res = await whatIf(keeperA, { text: 'What if I turn off the AC in building B' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The zone clue now hits the foreign building — the intervention resolves
    // to the B栋 unit instead of silently falling back to the requester's own.
    expect(body.result.scenario.intervention.target).toBe(hvacB1);
    expect(body.jurisdictionNote as string | undefined).toBeDefined();
  }, 30_000);

  it('an OWN-district what-if carries NO note — zero打扰 on the normal path', async () => {
    const res = await whatIf(keeperA, { text: '如果把 A栋 的空调调到 26 度会怎样' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.scenario.intervention.target).toBe(hvacA1);
    expect(body.jurisdictionNote).toBeUndefined();
  }, 30_000);
});
