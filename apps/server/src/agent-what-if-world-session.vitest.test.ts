/**
 * R81-D4 (plan-r81 Wave D — D2-F4 root fix): the what-if fork's WORLD SOURCE.
 *
 * Plain sims are FROZEN scenario snapshots by design; the authoritative
 * world session is the evolving world. These tests pin the reroute:
 *
 * - a device added to the RUNNING world session is visible to — and acted
 *   on by — a what-if asked through an agent running in a frozen plain sim,
 *   and the fork anchors at the session's CURRENT sim time (not the frozen
 *   sim's t0);
 * - a hibernated session still donates its checkpoint (topology from the
 *   env's current rows);
 * - an env without a reachable session falls back to the agent's own sim
 *   (the legacy source), honestly labeled.
 *
 * Every response carries `forkSource: { kind, simulationId }` so the caller
 * can see WHICH world the prediction tested.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, until, type TestAppContext, type TestUser } from './test-utils.js';
import { worldSessionSimIdOf } from './sandbox-service.js';

describe('agent what-if fork source (R81-D4: world-session current state)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'What-if WS Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * One hot lobby (32°C baseline) with an UNPOWERED hvac-1 (a device
   * surface for the bound agent that does not hold the room), plus a frozen
   * plain sim of the same env (the D2-F4 blind lane). Tests power up a
   * cooler through the world and what-if its loss.
   */
  async function createLab(): Promise<{
    envId: string;
    agentId: string;
    hvac1Id: string;
    sessionSimId: string;
    plainSimId: string;
  }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        meta: { id: 'what-if-ws-lab', name: 'What-if WS Lab' },
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
            initialState: { power: false, status: 'off', mode: 'cooling', targetTemperature: 22 },
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
      },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    // Env import remaps scenario ids to instance ids — ask by name.
    const agentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'ThermalOps')!.id;
    const hvac1Id = (created.json().devices as Array<{ id: string; name: string }>)
      .find(d => d.name === 'HVAC 1')!.id;

    // R73 auto-starts the authoritative session; targetFor pins the arrival.
    const sessionSimId = worldSessionSimIdOf(envId);
    const session = await ctx.app.worldSessions.targetFor(envId);
    expect(session?.id).toBe(sessionSimId);

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    return { envId, agentId, hvac1Id, sessionSimId, plainSimId: sim.json().id as string };
  }

  function whatIf(agentId: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/what-if`,
      headers: auth(owner.token),
      payload,
    });
  }

  // T82 (R9, u3-F1): the AGENT_AMBIGUOUS candidate for the authoritative
  // session is named for WHAT it is — "platform world-session", not
  // "created by unknown" — and its state word is the runtime's (the same
  // word the sim roster and `env session status`.state speak).
  it('AGENT_AMBIGUOUS names the world-session candidate "platform world-session" (T82)', async () => {
    const { agentId, sessionSimId, plainSimId } = await createLab();
    const ambiguous = await ctx.app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/command`,
      headers: auth(owner.token),
      payload: { text: 'set the lobby temperature to 21' },
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error.code).toBe('AGENT_AMBIGUOUS');
    const message: string = ambiguous.json().error.message;
    expect(message).toContain(plainSimId);
    expect(message).toContain(`${sessionSimId} (running, platform world-session)`);
    expect(message).not.toContain('created by unknown');
    // The roster the message teaches carries the same marker (kind field).
    const envId = sessionSimId.replace(/^sim-/, '').replace(/-world-session$/, '');
    const sims = (await ctx.app.inject({
      method: 'GET', url: `/api/simulations?environmentId=${envId}`, headers: auth(owner.token),
    })).json().simulations as Array<{ id: string; kind?: string }>;
    expect(sims.find(sim => sim.id === sessionSimId)?.kind).toBe('world-session');
    // And `env session status` speaks the same runtime-state word (T82).
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json() as { worldSession?: { state?: string; status?: string } };
    expect(detail.worldSession?.state).toBe('running');
  });

  it('forks from the RUNNING world session: a runtime-new device is visible and the fork anchors at the world’s now', async () => {
    const { envId, agentId, sessionSimId, plainSimId } = await createLab();

    // T27 (R3): an EXPLICIT simId now forks that sim (the user pointed at
    // it), so the R81-D4 default lane — session is the evolving world — is
    // exercised WITHOUT simId. The agent must live in exactly one sim: stop
    // the user's private plain sim, leaving the session as the only record.
    ctx.app.simulations.stopAndRemove(plainSimId);

    // The world moves on its own timeline.
    const sessionRecord = ctx.app.simulations.get(sessionSimId)!;
    await sessionRecord.runtime.advanceTo(42);

    // The user drops a NEW cooler into the running world (catalog one-click
    // shape: direct owner create). The world session rebuilds on the
    // mutation and the what-if must see it.
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'HVAC 2',
        type: 'hvac',
        capabilities: ['set-temperature', 'turn-on', 'turn-off'],
        zoneId: 'lobby',
        initialState: { power: true, status: 'on', mode: 'cooling', targetTemperature: 22 },
      },
    });
    expect(added.statusCode).toBe(201);
    const hvac2Id = added.json().id as string;
    expect(
      await until(
        () => ctx.app.simulations.get(sessionSimId)?.runtime.getSnapshot().devices.some(d => d.id === hvac2Id) ?? false,
        10_000,
      ),
    ).toBe(true);

    // NB: the R82 mutation rebuild REPLACES the session's runtime — re-fetch
    // the record instead of holding the pre-mutation one.
    const hvac2Before = ctx.app.simulations.get(sessionSimId)!.runtime.getSnapshot().devices.find(d => d.id === hvac2Id)!.state;
    const res = await whatIf(agentId, {
      intervention: { type: 'device_command', target: hvac2Id, action: 'turn-off' },
      durationSec: 900,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The fork tested the world session's CURRENT state: the new device
    // exists there (no "unknown device" 400), and the anchor is the world's
    // now.
    expect(body.forkSource).toEqual({ kind: 'world-session', simulationId: sessionSimId });
    expect(body.simulationId).toBe(sessionSimId);
    expect(body.simTimeSec).toBeGreaterThanOrEqual(42);
    // Killing the lobby's only ACTIVE cooler heats it: a real, non-zero verdict
    // on the runtime-new device (pre-fix this was a zero-delta confident
    // neutral against the frozen sim, or "unknown device").
    expect(body.result.verdict).toBe('degradation');
    expect(body.result.delta['temperature_lobby']).toBeGreaterThan(0);

    // The NO-REFLOW red line still holds: the authoritative world is untouched.
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
    const hvac2After = ctx.app.simulations.get(sessionSimId)!.runtime.getSnapshot().devices.find(d => d.id === hvac2Id)!;
    expect(hvac2After.state).toEqual(hvac2Before);
  }, 30_000);

  it('T27 (R3 u1-F4): an EXPLICIT simId forks THAT sim, not the session behind its back', async () => {
    const { agentId, hvac1Id, sessionSimId, plainSimId } = await createLab();

    // The world session advances on its own timeline; the user's private sim
    // stays at ITS clock — u1 watched HER sim (accelerated, hours in) while
    // the default fork silently tested the idle session (sim-time 270), so
    // the baseline could not be hers. Pointing --sim at her sim must fork it.
    await ctx.app.simulations.get(sessionSimId)!.runtime.advanceTo(42);

    const res = await whatIf(agentId, {
      intervention: { type: 'device_command', target: hvac1Id, action: 'turn-on' },
      durationSec: 900,
      simId: plainSimId,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The fork tested the user's named sim (kind 'simulation'), anchored at
    // the sim's own t0 — NOT the session's now.
    expect(body.forkSource).toEqual({ kind: 'simulation', simulationId: plainSimId });
    expect(body.simTimeSec).toBe(0);
    expect(body.simulationId).toBe(plainSimId);
    // The physics verdict is the named world's: powering the lobby cooler in
    // the 32°C room cools it (the same judgment the fallback lane gets).
    expect(body.result.verdict).toBe('improvement');
    expect(body.result.delta['temperature_lobby']).toBeLessThan(0);

    // The session world still stands (the fork never mutates its source).
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
  }, 30_000);

  it('T127 (R20-u3 N1): a RESOLVED default binding forks the bound sim — the disclosure’s world, not the session behind its back', async () => {
    const { envId, agentId, hvac1Id, sessionSimId, plainSimId } = await createLab();

    // The r20 shape: the owner bound a default sim (T122) and the agent runs
    // in BOTH worlds. Start the private sim (a binding resolves only while
    // RUNNING) and bind it — an explicit owner world choice.
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${plainSimId}/start`,
      headers: auth(owner.token),
    });
    expect(started.statusCode).toBe(200);
    const bound = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { defaultSimulationId: plainSimId },
    });
    expect(bound.statusCode).toBe(200);

    // The session's clock drifts away from the plain sim's t0 — the two
    // worlds are distinguishable, exactly the u3 divergence (disclosure said
    // mu96biat-4, fork provenance said world-session @ a different clock).
    await ctx.app.simulations.get(sessionSimId)!.runtime.advanceTo(42);

    // No simId — resolution goes THROUGH the live binding (the pre-T122
    // answer here was AGENT_AMBIGUOUS; the note names the bound sim).
    const res = await whatIf(agentId, {
      intervention: { type: 'device_command', target: hvac1Id, action: 'turn-on' },
      durationSec: 900,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The fork tested the BOUND world: kind 'simulation' + the bound id at
    // ITS t0 — NOT the session's now (42+). Disclosure and fork provenance
    // name the same world.
    expect(body.defaultSimNote).toContain(plainSimId);
    expect(body.forkSource).toEqual({ kind: 'simulation', simulationId: plainSimId });
    expect(body.simulationId).toBe(plainSimId);
    // The bound sim's OWN clock (it just started and ticks from t0) — NOT
    // the session's now (42+), which is the pre-fix contradiction.
    expect(body.simTimeSec).toBeLessThan(42);
    // The verdict is the bound world's physics: its 32°C lobby cools.
    expect(body.result.verdict).toBe('improvement');
    expect(body.result.delta['temperature_lobby']).toBeLessThan(0);

    // The no-reflow red line: neither source world was mutated.
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
    expect(ctx.app.simulations.get(plainSimId)).toBeDefined();
  }, 30_000);

  it('falls back to the agent’s own sim when the env has no reachable session — and says so', async () => {
    const { agentId, hvac1Id, sessionSimId, plainSimId } = await createLab();

    // No live session, no hibernated checkpoint: the legacy source stands.
    // T27: no simId in the payload — the plain sim is the agent's only live
    // record, so this exercises the FALLBACK lane, not the explicit fork.
    ctx.app.simulations.stopAndRemove(sessionSimId);
    expect(ctx.app.simulations.get(sessionSimId)).toBeUndefined();
    expect(ctx.app.simulations.getHibernated(sessionSimId)).toBeUndefined();

    const res = await whatIf(agentId, {
      intervention: { type: 'device_command', target: hvac1Id, action: 'turn-on' },
      durationSec: 900,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.forkSource).toEqual({ kind: 'simulation', simulationId: plainSimId });
    expect(body.simTimeSec).toBe(0); // the frozen sim's own t0
    // Powering the lobby's cooler in the 32°C room cools it: improvement.
    expect(body.result.verdict).toBe('improvement');
    expect(body.result.delta['temperature_lobby']).toBeLessThan(0);
  }, 30_000);

  it('a HIBERNATED session still donates its checkpoint (world-session source, not the frozen sim)', async () => {
    const { agentId, hvac1Id, sessionSimId, plainSimId } = await createLab();

    const sessionRecord = ctx.app.simulations.get(sessionSimId)!;
    await sessionRecord.runtime.advanceTo(42);

    // POST stop on a live session is FREEZE semantics: checkpoint + release.
    // T27: the plain sim stays the agent's only LIVE record and the ask
    // carries NO simId — the hibernated-session donation lane.
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionSimId}/stop`,
      headers: auth(owner.token),
    });
    expect(stopped.statusCode).toBe(200);
    expect(ctx.app.simulations.get(sessionSimId)).toBeUndefined();
    expect(ctx.app.simulations.getHibernated(sessionSimId)).toBeDefined();

    const res = await whatIf(agentId, {
      intervention: { type: 'device_command', target: hvac1Id, action: 'turn-on' },
      durationSec: 900,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.forkSource).toEqual({ kind: 'world-session', simulationId: sessionSimId });
    expect(body.simTimeSec).toBeGreaterThanOrEqual(42); // the checkpoint's moment
    expect(body.result.verdict).toBe('improvement');
    expect(body.result.delta['temperature_lobby']).toBeLessThan(0);
    void plainSimId;
  }, 30_000);
});
