/**
 * @vitest-environment node
 *
 * T122 (R17-u3 / R19-u4) — the environment-level DEFAULT SIMULATION binding.
 *
 * The usability story: shared multi-sim environments hit AGENT_AMBIGUOUS /
 * SIMULATION_AMBIGUOUS on every default-lane call — every round of testing
 * re-paid the same disambiguation tax. Now the OWNER may bind one simulation
 * of the env (`PATCH /api/environments/:id { defaultSimulationId }`, CLI
 * `eaf env set-default-sim`) and the ask/what-if/read DEFAULT lanes target it
 * while it is RUNNING, with the answer disclosing「使用环境默认仿真 X」.
 *
 * Pinned here at the ROUTE level (the pure adjudication legs live in
 * agreements/targeting.vitest.test.ts):
 * - three states of the default ask lane: bound → answers; unbound single
 *   candidate → answers; unbound several → the honest 409;
 * - the explicit simId ALWAYS wins over the binding;
 * - the binding gone STALE (bound sim stopped) is inert: the lane falls back
 *   to the standard adjudication and the 409 carries the rebind/clear
 *   guidance — never a silent world switch;
 * - the PATCH contract: owner-only, the sim must exist and belong to THIS
 *   env, the world session is not bindable, null clears, detail surfaces it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('T122 env default-simulation binding (ask lane + PATCH contract)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let member: TestUser;
  let envId: string;
  /** The env-row agent id (env-backed runtimes key agents by these, not scenario ids). */
  let agentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    member = await registerUser(ctx.app, { displayName: 'Env Member' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('default-sim-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    agentId = (detail.agents as Array<{ id: string; name: string }>).find(
      agent => agent.name === 'Lab Agent',
    )!.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(member.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function patch(token: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(token),
      payload: body,
    });
  }

  async function startEnvSim(token: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  async function stopSim(token: string, simId: string): Promise<void> {
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(token),
      payload: {},
    });
    expect(stopped.statusCode).toBe(200);
  }

  function ask(token: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/ask`,
      headers: auth(token),
      payload: body,
    });
  }

  function whatIf(token: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/what-if`,
      headers: auth(token),
      payload: body,
    });
  }

  function stopWorldSession(): Promise<{ statusCode: number }> {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/sim-${envId}-world-session/stop`,
      headers: auth(owner.token),
      payload: {},
    });
  }

  /** R73: env creation auto-wakes the session fire-and-forget — poll until
   *  it is a LIVE registry candidate (runtime running), the positive signal
   *  every single-candidate scenario below needs. */
  async function waitSessionLive(): Promise<void> {
    const live = await until(
      () => ctx.app.worldSessions?.statusOf(envId)?.state === 'running',
      5_000,
    );
    expect(live).toBe(true);
  }

  it('PATCH contract: owner-only, unknown sim 404, session not bindable, null clears, detail surfaces', async () => {
    // a non-owner member cannot set the binding
    const simId = await startEnvSim(owner.token);
    const forbidden = await patch(member.token, { defaultSimulationId: simId });
    expect(forbidden.statusCode).toBe(403);

    // unknown sim → honest 404 with the roster pointer
    const missing = await patch(owner.token, { defaultSimulationId: 'sim-nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SIMULATION_NOT_FOUND');

    // the env's authoritative world session is not bindable — env creation
    // wakes the session (R73, fire-and-forget), so allow it a moment to
    // appear in the registry before asserting the teaching 400.
    const sessionSimId = `sim-${envId}-world-session`;
    let sessionPatch;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      sessionPatch = await patch(owner.token, { defaultSimulationId: sessionSimId });
      if (sessionPatch.statusCode === 400) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(sessionPatch!.statusCode).toBe(400);
    expect(sessionPatch!.json().error.message).toContain('world session');

    // set + clear round-trip; the detail surface carries the binding
    const set = await patch(owner.token, { defaultSimulationId: simId });
    expect(set.statusCode).toBe(200);
    expect(set.json().defaultSimulationId).toBe(simId);
    const detailAfterSet = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    expect(detailAfterSet.defaultSimulationId).toBe(simId);
    const cleared = await patch(owner.token, { defaultSimulationId: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().defaultSimulationId).toBeNull();
  });

  it('three states of the default ask lane: bound → answers; unbound single → answers; unbound multi → 409', async () => {
    // state 3 (no binding, several candidates: two user sims + the platform
    // world session — R73 auto-created it with the env): the honest roster 409
    const simA = await startEnvSim(owner.token);
    const simB = await startEnvSim(member.token);
    const ambiguous = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error.code).toBe('AGENT_AMBIGUOUS');

    // state 1 (binding set by the owner): the default ask answers from the
    // bound sim — the multi-candidate tie is resolved by the owner's
    // decision — and the answer DISCLOSES the world it came from.
    const set = await patch(owner.token, { defaultSimulationId: simA });
    expect(set.statusCode).toBe(200);
    const bound = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().simulationId).toBe(simA);
    expect(bound.json().defaultSimNote).toContain('使用环境默认仿真');
    expect(bound.json().naturalLanguageResponse).toContain('使用环境默认仿真');

    // the EXPLICIT simId always wins over the binding (and no disclosure)
    const explicit = await ask(member.token, { text: "what's the status of zone-a?", simId: simB });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().simulationId).toBe(simB);
    expect(explicit.json().defaultSimNote).toBeUndefined();

    // state 2 (no binding, single candidate): with the binding cleared and
    // both user sims stopped, the only live candidate is the platform world
    // session — the legacy answer stands, no disclosure.
    await patch(owner.token, { defaultSimulationId: null });
    await stopSim(owner.token, simA);
    await stopSim(member.token, simB);
    const single = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(single.statusCode).toBe(200);
    expect(single.json().simulationId).toBe(`sim-${envId}-world-session`);
    expect(single.json().defaultSimNote).toBeUndefined();
  });

  it('a STALE binding is inert: stopped bound sim falls back with the rebind guidance, never a silent switch', async () => {
    const simA = await startEnvSim(owner.token);
    const simB = await startEnvSim(member.token);
    await patch(owner.token, { defaultSimulationId: simA });

    // the bound sim stops → the binding cannot answer: fall back to the
    // standard adjudication (the world session + simB are still candidates →
    // the honest 409) and SAY the binding is stale + how to fix it.
    await stopSim(owner.token, simA);
    const stale = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('AGENT_AMBIGUOUS');
    expect(stale.json().error.message).toContain('已停止运行');
    expect(stale.json().error.message).toContain('set-default-sim');

    // the fallback NEVER silently picks a world for the caller: even with the
    // stale binding, an EXPLICIT simId answers — from the world NAMED.
    const explicit = await ask(member.token, { text: "what's the status of zone-a?", simId: simB });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().simulationId).toBe(simB);
    expect(explicit.json().defaultSimNote).toBeUndefined();
  });

  it('the what-if lane rides the same binding: a bound default disambiguates, discloses, and FORKS the bound world (T127)', async () => {
    const simA = await startEnvSim(owner.token);
    const simB = await startEnvSim(member.token);
    await patch(owner.token, { defaultSimulationId: simA });

    const whatIf = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/what-if`,
      headers: auth(member.token),
      payload: { text: 'what if I turn off hvac-b for 30 minutes?' },
    });
    expect(whatIf.statusCode).toBe(200);
    expect(whatIf.json().agentId).toBe(agentId);
    expect(whatIf.json().simulationId).toBe(simA);
    expect(whatIf.json().defaultSimNote).toContain('使用环境默认仿真');
    // T127 (R20-u3 N1): the fork tests the BOUND world — the disclosure and
    // the fork provenance must name the SAME sim. Pre-fix the fork went to
    // the authoritative world session while the disclosure said the bound
    // sim (two contradictory lines, one answer).
    expect(whatIf.json().forkSource).toEqual({ kind: 'simulation', simulationId: simA });
  });

  // -------------------------------------------------------------------------
  // T130 (R21-F2): the SINGLE-candidate path used to skip the binding
  // adjudication entirely — an inert binding + the agent running in exactly
  // ONE live world answered 200 with ZERO disclosure (R21 spot-check leg B:
  // r21-u3-ask-inert-binding — a silent world switch breaching the help
  // contract's "fall back … disclose it, and point here to rebind or
  // --clear" promise). These pin the flip.
  // -------------------------------------------------------------------------
  it('T130: an inert binding + a SINGLE live candidate — ask answers 200 WITH the ⚠ fall-back disclosure (R21 leg B flipped)', async () => {
    const simA = await startEnvSim(owner.token);
    const bound = await patch(owner.token, { defaultSimulationId: simA });
    expect(bound.statusCode).toBe(200);
    await waitSessionLive();

    // The bound sim stops; the authoritative world session is now the
    // agent's ONLY live world. Pre-T130 this ask was a silent 200.
    await stopSim(owner.token, simA);
    const inert = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(inert.statusCode).toBe(200);
    expect(inert.json().simulationId).toBe(`sim-${envId}-world-session`);
    const note = inert.json().defaultSimNote as string;
    expect(typeof note).toBe('string');
    expect(note).toContain('已停止运行'); // the WHY (not-running)
    expect(note).toContain('权威 world session'); // the world that ACTUALLY answered
    expect(note).toContain('set-default-sim');
    expect(note).toContain('--clear'); // the rebind/clear guidance
    // R102: the disclosure leads the human body, not just --json.
    expect(inert.json().naturalLanguageResponse).toContain('已停止运行');
    expect(inert.json().naturalLanguageResponse).toContain('--clear');
  });

  it('T130: the inert single-candidate state on what-if — ⚠ disclosure AND the fork provenance still name the actual world (T127 honesty intact)', async () => {
    const simA = await startEnvSim(owner.token);
    await patch(owner.token, { defaultSimulationId: simA });
    await waitSessionLive();
    await stopSim(owner.token, simA);

    const result = await whatIf(member.token, { text: 'what if I turn off hvac-b for 30 minutes?' });
    expect(result.statusCode).toBe(200);
    expect(result.json().simulationId).toBe(`sim-${envId}-world-session`);
    expect(result.json().defaultSimNote).toContain('已停止运行');
    // The fork tests the world the answer actually rode — the fall-back
    // session itself. Provenance and disclosure agree (no T127-style
    // contradiction, no silent session preference overriding the note).
    expect(result.json().forkSource).toEqual({
      kind: 'world-session',
      simulationId: `sim-${envId}-world-session`,
    });
  });

  it('T130: an inert binding falling back to the caller\'s OWN single sim — the ⚠ line names THAT world, the what-if fork agrees', async () => {
    const simA = await startEnvSim(owner.token);
    const simB = await startEnvSim(member.token);
    await patch(owner.token, { defaultSimulationId: simA });
    await waitSessionLive();
    // Only the member's own simB stays live: the bound simA stopped AND the
    // session frozen — the fall-back world is the caller's own sim, so the
    // ⚠ line must name it (never a hardcoded "权威 world session").
    await stopSim(owner.token, simA);
    expect((await stopWorldSession()).statusCode).toBe(200);

    const inert = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(inert.statusCode).toBe(200);
    expect(inert.json().simulationId).toBe(simB);
    const note = inert.json().defaultSimNote as string;
    expect(note).toContain('已停止运行');
    expect(note).toContain(`回退到你自己唯一运行中的仿真 ${simB}`);
    expect(note).toContain('set-default-sim');

    // what-if: provenance = that same world — never the hibernated session
    // behind the disclosure's back.
    const result = await whatIf(member.token, { text: 'what if I turn off hvac-b for 30 minutes?' });
    expect(result.statusCode).toBe(200);
    expect(result.json().simulationId).toBe(simB);
    expect(result.json().defaultSimNote).toContain(`回退到你自己唯一运行中的仿真 ${simB}`);
    expect(result.json().forkSource).toEqual({ kind: 'simulation', simulationId: simB });
  });

  it('T130: a LIVE binding + a single candidate — the default-binding disclosure, symmetric with the multi-candidate hit', async () => {
    const simA = await startEnvSim(owner.token);
    const bound = await patch(owner.token, { defaultSimulationId: simA });
    expect(bound.statusCode).toBe(200);
    await waitSessionLive();
    // Freeze the session so the bound sim is the agent's ONLY live world.
    expect((await stopWorldSession()).statusCode).toBe(200);

    const single = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(single.statusCode).toBe(200);
    expect(single.json().simulationId).toBe(simA);
    expect(single.json().defaultSimNote).toContain('使用环境默认仿真');
    expect(single.json().naturalLanguageResponse).toContain('使用环境默认仿真');
  });

  it('T130: NO binding + a single own-sim candidate — bit-identical silence (zero disclosure, zero noise)', async () => {
    const simB = await startEnvSim(member.token);
    await waitSessionLive();
    expect((await stopWorldSession()).statusCode).toBe(200);

    const single = await ask(member.token, { text: "what's the status of zone-a?" });
    expect(single.statusCode).toBe(200);
    expect(single.json().simulationId).toBe(simB);
    expect(single.json().defaultSimNote).toBeUndefined();
    expect(single.json().naturalLanguageResponse).not.toContain('使用环境默认仿真');
    expect(single.json().naturalLanguageResponse).not.toContain('已停止运行');
  });
});
