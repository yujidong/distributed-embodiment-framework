/**
 * @vitest-environment node
 *
 * Living-worlds P1W (design-living-worlds.md §4.3/§6/§9): the authoritative
 * world session — lifecycle, authority wiring, and ACCEPTANCE INVARIANT #3.
 *
 * R73 (永远运行下去, 2f12769): worlds NEVER hibernate on idle — the demotion
 * sweep is a no-op stub and environment creation AUTO-STARTS the session.
 * The only paths into HIBERNATED that remain are the explicit freeze
 * (POST /stop on the session sim → checkpoint) and a cross-process
 * checkpoint (S3); both still wake through the same fast-forward path.
 *
 * - HTTP level: the session auto-starts at env creation and is the default
 *   target of data reads / agreement activation, the env detail carries
 *   `worldSession`, status transitions ride the env world stream, WS
 *   observation pins ACTIVE (the last disconnect demotes to IDLE — never
 *   HIBERNATED), governance world-changes land in the live world.
 * - Registry level (injected clock, no driver — the P1 clock-anchor
 *   discipline): invariant #3 — a session observed to t1, frozen, and
 *   woken at t3 by B fast-forwards through the empty window (A's effects
 *   present, dues fired exactly once) and yields the SAME world as a
 *   continuously-ACTIVE session through t1..t3.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { SimulationRegistry, type SimulationRecord } from './simulation-registry.js';
import { readTrajectoryDirRecords } from './trajectory-store.js';
import { WorldSessionService, scenarioDriftNotes } from './world-session.js';
import {
  auth,
  elapsedSince,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Poll until the predicate holds (bounded). */
async function until(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// HTTP level — lifecycle, surfaces, pins, obligations
// ---------------------------------------------------------------------------

describe('living-worlds P1W: the authoritative world session (HTTP lifecycle)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let providerAgentId: string;
  let serviceId: string;
  let agreementId: string;

  const SPEC = {
    kind: 'zone-query',
    refreshSec: 60,
    inputs: {
      zones: ['zone-a'],
      metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
    },
  };
  const IFACE = {
    dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] },
  };

  beforeEach(async () => {
    // Wall-rate 60 (1 wall-sec = 1 sim-minute) + a short idle grace so the
    // lifecycle is observable in real time without long waits.
    ctx = await makeTestApp({ worldSessionSimPerWallSec: 60, worldSessionIdleGraceMs: 250 });
    owner = await registerUser(ctx.app, { displayName: 'Session Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Session Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'world-session-lab', name: 'World Session Lab', description: 'P1W fixture' },
        zones: [
          { id: 'zone-a', baseline: { temperature: 22, humidity: 45 } },
        ],
        devices: [
          {
            id: 'temp-sensor-a', name: 'Sensor A', type: 'sensor',
            capabilities: ['temperature-reading'], zoneId: 'zone-a', initialState: { active: false },
          },
        ],
        agents: [{
          id: 'care-bot', name: 'Care Bot', capabilities: ['care-status'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
        }],
        events: [
          { id: 'evt-due-2', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 30, atSimTimeSec: 2 },
          { id: 'evt-due-4', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 31, atSimTimeSec: 4 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'zone-temp', semanticType: 'care-status-aggregate' },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: { ...SPEC, interface: IFACE },
    });
    expect(registered.statusCode).toBe(201);
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTemperature'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function sessionDetail() {
    return ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    });
  }

  it('auto-starts at env creation (R73); a data read lands on the SAME authoritative session — NOT a per-user sim', async () => {
    // R73 (永远运行下去): environment creation auto-starts the authoritative
    // world session (fire-and-forget from the route) — no world-needing
    // arrival is required for the env detail to carry `worldSession`.
    expect(
      await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000),
    ).toBe(true);

    const read = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token), payload: {},
    });
    expect(read.statusCode).toBe(200);
    // The read lands on the auto-started session (same identity), never a
    // per-user sim.
    expect(read.json().simulationId).toBe(`sim-${envId}-world-session`);

    const detail = (await sessionDetail()).json();
    expect(detail.worldSession).toMatchObject({
      status: expect.any(String),
      simulationId: `sim-${envId}-world-session`,
      simTimeSec: expect.any(Number),
    });
    // T-410 (R19, NW-F08): the WALL anchor rides the view — equal to the
    // runtime's own anchor (no more now−simTime sampling with ±s error).
    expect(detail.worldSession.simStartEpochMs).toBe(
      ctx.app.simulations.get(`sim-${envId}-world-session`)!.runtime.getSimStartEpochMs(),
    );
    // C5 (T-087, HO26-F06 — DevLoop R28): the session IS discoverable in
    // GET /api/simulations now — marked platformOwned:true so consumers can
    // tell the authoritative world session from user sims (addressable-but-
    // invisible was the R26 finding).
    const sims = (await ctx.app.inject({
      method: 'GET', url: `/api/simulations?environmentId=${envId}`, headers: auth(owner.token),
    })).json().simulations as Array<{ id: string; platformOwned?: true; kind?: string }>;
    const sessionEntry = sims.find(sim => sim.id === `sim-${envId}-world-session`);
    expect(sessionEntry).toBeDefined();
    expect(sessionEntry!.platformOwned).toBe(true);
    // T82 (R9, u3-F1): the session row is labeled by TYPE — the roster face
    // (and API consumers) can tell the authoritative session apart from a
    // user sim without string-matching the id.
    expect(sessionEntry!.kind).toBe('world-session');
    // Every OTHER entry is a user sim — the flag marks exactly the session.
    expect(sims.filter(sim => sim.platformOwned === true)).toHaveLength(1);
    // The per-user /me list keeps the session-free contract (registry.list).
    expect(ctx.app.simulations.list().some(sim => sim.platformOwned === true)).toBe(false);
    // T82: the session view carries the RUNTIME state alongside the attention
    // status — AGENT_AMBIGUOUS says "running", sim list says state=running;
    // the env session face must speak the same word (status 'idle' merely
    // means "no observers right now").
  });

  it('pause on the world session is refused honestly (409 WORLD_SESSION_PAUSE_UNSUPPORTED), never a fake {state:paused}', async () => {
    expect(
      await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000),
    ).toBe(true);
    const sessionId = `sim-${envId}-world-session`;
    const pause = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionId}/pause`,
      headers: auth(owner.token),
    });
    expect(pause.statusCode).toBe(409);
    expect(pause.json().error.code).toBe('WORLD_SESSION_PAUSE_UNSUPPORTED');
    // The refusal names the TRUE state; the runtime is left untouched
    // (observers / catch-up would silently revoke a pause anyway).
    expect(pause.json().error.message).toContain('running');
    expect(ctx.app.simulations.get(sessionId)!.runtime.getState()).toBe('running');
  });

  it(
    'observers pin the session ACTIVE (WS subscription); the last disconnect demotes to IDLE — and the world NEVER hibernates (R73)',
    { timeout: 20_000 },
    async () => {
      // R73: the session auto-started at env creation (fire-and-forget) —
      // wait for it so the env world stream's observeOrMaterialize pins an
      // EXISTING session (this test does not exercise the crash-recovery
      // materialize branch — world-session-resume-s3 pins that).
      expect(
        await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000),
      ).toBe(true);
      const anchorAtBirth = ctx.app.worldSessions.statusOf(envId)!.simStartEpochMs!;
      expect(anchorAtBirth).toEqual(expect.any(Number));

      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const baseUrl = `ws://127.0.0.1:${(ctx.app.server!.address() as { port: number }).port}`;

      const frames: Array<Record<string, unknown>> = [];
      const transitions: Array<Record<string, unknown>> = [];
      const envSocket = new WebSocket(`${baseUrl}/api/environments/${envId}/stream`, {
        headers: auth(owner.token),
      });
      envSocket.on('message', data => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.kind === 'world-session') transitions.push(message);
      });
      await new Promise<void>(resolve => envSocket.on('open', () => resolve()));
      // The env world stream holds a pin on the existing session → ACTIVE.
      expect(
        await until(() => ctx.app.worldSessions.statusOf(envId)?.status === 'active', 5_000),
      ).toBe(true);

      // The data stream (no ?simulationId) targets + PINS the session too.
      const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
        headers: auth(consumer.token),
      });
      socket.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
      await new Promise<void>(resolve => socket.on('open', () => resolve()));
      const pinnedAt = Date.now();
      expect(await until(() => frames.some(frame => frame.kind === 'data'), 5_000)).toBe(true);

      // Pinned: still active well past the idle grace (250ms). Class (b)
      // negative window (R21 test-debt): proving the grace timer does NOT
      // fire requires really passing that wall time; elapsed is MEASURED
      // from the observed pin, not a stacked fixed sleep.
      await elapsedSince(pinnedAt, 700);
      let status = (await sessionDetail()).json().worldSession.status;
      expect(status).toBe('active');
      expect((await sessionDetail()).json().worldSession.observers).toBeGreaterThanOrEqual(1);

      // Both observers disconnect → the last release demotes ACTIVE → IDLE.
      // The env stream carried the pin transition while it was open (the
      // demotion frame itself races the closing socket — assert the
      // transition via the status surface instead).
      socket.close();
      envSocket.close();
      const demoted = await until(
        () => ctx.app.worldSessions.statusOf(envId)?.status === 'idle',
        5_000,
      );
      expect(demoted).toBe(true);
      expect(transitions.some(frame => frame.status === 'active')).toBe(true);

      // R73 (永远运行下去): past the grace the world is STILL resident — the
      // demotion sweep is a no-op stub, so IDLE is terminal; the runtime is
      // never released and the wall anchor never jumps (T-410).
      const demotedAt = Date.now();
      await elapsedSince(demotedAt, 700);
      const view = ctx.app.worldSessions.statusOf(envId)!;
      expect(view.status).toBe('idle');
      expect(view.hibernatedAt).toBeUndefined();
      expect(ctx.app.simulations.get(`sim-${envId}-world-session`)).toBeDefined();
      expect(view.simStartEpochMs).toBe(anchorAtBirth);

      // A later arrival lands on the SAME living world — same session id,
      // same wall anchor, sim time continuous (no checkpoint boundary).
      await ctx.app.inject({
        method: 'POST', url: `/api/agreements/${agreementId}/reads`,
        headers: auth(consumer.token), payload: {},
      });
      expect(ctx.app.worldSessions.statusOf(envId)!.simulationId).toBe(`sim-${envId}-world-session`);
      expect(ctx.app.worldSessions.statusOf(envId)!.simStartEpochMs).toBe(anchorAtBirth);
    },
  );

  it('a governance world-change (owner device install) lands in the live session world', async () => {
    // Materialize + pin the session via a read.
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token), payload: {},
    });
    const sessionSimId = `sim-${envId}-world-session`;
    const before = ctx.app.simulations.get(sessionSimId)!.runtime.getSnapshot();
    expect(before.devices.some(device => device.name === 'Heater New')).toBe(false);

    // Owner direct edit: install a device into the env (change-pipeline
    // 'env-direct-edit' → the session's topology refresh). The hook is
    // fire-and-forget from the route — poll for the landed effect.
    const installed = await ctx.app.inject({
      method: 'POST', url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Heater New', type: 'heater', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a' },
    });
    expect(installed.statusCode).toBe(201);
    const landed = await until(() =>
      ctx.app.simulations.get(sessionSimId)!.runtime.getSnapshot()
        .devices.some(device => device.name === 'Heater New'),
    5_000);
    expect(landed).toBe(true);
    // Identity survived the rebuild (same session, history continues).
    expect(ctx.app.worldSessions.statusOf(envId)?.simulationId).toBe(sessionSimId);
  });

  it('waking a FROZEN world (explicit POST /stop) fast-forwards and reports schema drift as a teaching warning', async () => {
    const sessionSimId = `sim-${envId}-world-session`;
    // The read lands on the auto-started session; let the catch-up run past
    // both fixture dues (sim 2/4 at wall-rate 60), then FREEZE explicitly —
    // R73 removed the idle sweep, so POST /stop's freeze semantics
    // (checkpoint + release) are the remaining path into HIBERNATED.
    await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token), payload: {},
    });
    expect(
      await until(() => (ctx.app.worldSessions.statusOf(envId)?.simTimeSec ?? 0) >= 4, 5_000),
    ).toBe(true);
    const frozen = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sessionSimId}/stop`,
      headers: auth(owner.token),
    });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().state).toBe('hibernated');
    const checkpointAt = ctx.app.worldSessions.statusOf(envId)!.checkpointAtSec!;
    expect(checkpointAt).toBeGreaterThanOrEqual(4);
    expect(ctx.app.simulations.get(sessionSimId)).toBeUndefined(); // runtime released
    // The frozen window must span real wall time for the fast-forward to be
    // observable (wall-rate 60: 50ms ≈ 3 sim-sec).
    await new Promise(resolve => setTimeout(resolve, 50));

    // The env changes while the world is away (owner installs a device).
    // The governance action WAKES the frozen world (§6.1: 动作即唤醒):
    // fast-forward from the checkpoint with the CURRENT topology.
    const installed = await ctx.app.inject({
      method: 'POST', url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Drift Heater', type: 'heater', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });
    expect(installed.statusCode).toBe(201);
    const woken = await until(() =>
      ctx.app.worldSessions.statusOf(envId)?.status === 'active' ||
      ctx.app.worldSessions.statusOf(envId)?.status === 'idle',
    5_000);
    expect(woken).toBe(true);
    const view = ctx.app.worldSessions.statusOf(envId)!;
    // Wall-rate 60: the empty window (>= grace) maps to sim time well past
    // the checkpoint boundary.
    expect(view.simTimeSec).toBeGreaterThan(checkpointAt);
    expect(view.driftWarning).toBeDefined();
    expect(view.driftWarning!.join(' ')).toContain('device');
    // The drifted-in device is present in the woken world.
    const landed = await until(() =>
      ctx.app.simulations.get(sessionSimId)!.runtime.getSnapshot()
        .devices.some(device => device.name === 'Drift Heater'),
    5_000);
    expect(landed).toBe(true);
  });

  it('R6-A-F01/F02: POST /hibernate on the world session surfaces the hibernated view (+ asOf) on the env detail', async () => {
    const sessionSimId = `sim-${envId}-world-session`;
    // Live view first: asOf marks the wall moment the displayed simTimeSec
    // belongs to (anchor arithmetic — two reads of a frozen idle display
    // agree bit-wise; a lagging asOf says "display cached, world alive").
    expect(await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000)).toBe(true);
    const liveDetail = (await sessionDetail()).json();
    expect(typeof liveDetail.worldSession.asOf).toBe('string');
    const liveAnchor = liveDetail.worldSession.simStartEpochMs;
    expect(typeof liveAnchor).toBe('number');
    // Deterministic: simStartEpochMs + simTimeSec×1000/rate. asOf is an ISO
    // stamp (ms precision) — new Date(fraction).toISOString() truncates the
    // sub-ms fraction, so the exact float disagrees by <1ms whenever the
    // arithmetic lands off-grid (the 2026-09-14 wall-clock flake). Compare
    // within one millisecond: the anchor arithmetic stays pinned, the
    // serialization quantum stops deciding the verdict.
    expect(Math.abs(
      Date.parse(liveDetail.worldSession.asOf) -
      (liveAnchor + (liveDetail.worldSession.simTimeSec * 1000) / liveDetail.worldSession.simPerWallSec),
    )).toBeLessThan(1);
    const liveDetail2 = (await sessionDetail()).json();
    if (liveDetail2.worldSession.simTimeSec === liveDetail.worldSession.simTimeSec) {
      expect(liveDetail2.worldSession.asOf).toBe(liveDetail.worldSession.asOf);
    }

    // FREEZE through the GENERIC /hibernate route (the R6 drill path) —
    // before the fix the env detail kept showing status "idle", simTimeSec 0,
    // no hibernatedAt/checkpoint metadata, and the wall anchor was gone.
    const frozen = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sessionSimId}/hibernate`,
      headers: auth(owner.token),
    });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().state).toBe('hibernated');

    const detail = (await sessionDetail()).json();
    expect(detail.worldSession.status).toBe('hibernated');
    expect(typeof detail.worldSession.hibernatedAt).toBe('string');
    expect(detail.worldSession.checkpointAtSec).toBeGreaterThanOrEqual(0);
    expect(detail.worldSession.simTimeSec).toBe(detail.worldSession.checkpointAtSec);
    // The wall anchor survives the freeze (docs/deployment.md §6: 永不跳变).
    expect(detail.worldSession.simStartEpochMs).toBe(liveAnchor);
    // R6-A-F02: a hibernated view's asOf is the freeze stamp itself.
    expect(detail.worldSession.asOf).toBe(detail.worldSession.hibernatedAt);
  });
});

// ---------------------------------------------------------------------------
// Registry level — ACCEPTANCE INVARIANT #3 (injected clock, anchor-shared)
// ---------------------------------------------------------------------------

/**
 * Deterministic rule-only world with a sparse due schedule (scheduled
 * events at sim 30/60/90) and an optional extra device (A's install).
 */
function invariantScenario(withId: string, extraDevice: boolean): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: withId, name: 'Invariant Lab', description: 'P1W invariant fixture' },
    zones: [
      {
        id: 'zone-a', name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
    ],
    devices: [
      {
        id: 'temp-sensor-a', name: 'Sensor A', type: 'temperature-sensor',
        capabilities: ['temperature-reading'], zoneId: 'zone-a', binding: 'sim://temp-sensor-a',
      },
      ...(extraDevice
        ? [{
            id: 'heater-installed', name: 'Heater (A installed)',
            type: 'heater', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a',
            binding: 'sim://heater-installed',
          }]
        : []),
    ],
    agents: [{
      id: 'lab-agent', name: 'Lab Agent', capabilities: ['temperature-monitoring'],
      managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
    }],
    events: [30, 60, 90].map(simSec => ({
      id: `evt-due-${simSec}`,
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 33,
      atSimTimeSec: simSec,
    })),
  } as unknown as ScenarioDefinition;
}

describe('living-worlds P1W: acceptance invariant #3 (hibernate+fast-forward ≡ continuous)', () => {
  const RATE = 60; // sim-sec per wall-sec (the wall-rate knob, sped up for the test)
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const services: WorldSessionService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeArm(
    envId: string,
    scenarioRef: { current: ScenarioDefinition },
    nowRef: { now: number },
    onSessionCreated?: (record: SimulationRecord) => void,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'world-session-arm-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const service = new WorldSessionService({
      registry,
      scenarioOfEnv: () => scenarioRef.current,
      envOwnerIdOf: () => undefined,
      obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
      nowMs: () => nowRef.now,
      simPerWallSec: RATE,
      attachDriver: false,
      idleGraceMs: 5,
      // At RATE 60 the empty window is ~90 sim-sec; "no near dues" must be
      // read on the same scale (default 3600 would keep the world resident
      // through the whole test window).
      hibernateHorizonSimSec: 5,
      ...(onSessionCreated !== undefined ? { onSessionCreated } : {}),
    });
    services.push(service);
    return { registry, service };
  }

  /** The world projection the arms are compared on (P1's comparator shape). */
  function projection(registry: SimulationRegistry, simId: string) {
    const snapshot = registry.get(simId)!.runtime.getSnapshot();
    return {
      zones: snapshot.zones.map(zone => ({
        id: zone.id,
        parameters: zone.parameters,
        ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
      })),
      devices: snapshot.devices.map(device => ({ id: device.id, state: device.state })),
      scheduledEvents: snapshot.scheduledEvents.map(event => ({ id: event.id, fired: event.fired })),
      // NOTE: agent counters (eventsProcessed…) are deliberately NOT compared
      // — they are liveness bookkeeping, not checkpointed world state (P0's
      // export carries reputation/rings/toggles, not per-agent counters), so
      // they legitimately reset across a rebuild/hibernate boundary. The
      // world itself (zones/devices/fired dues) is the equality contract.
    };
  }

  it(
    'part (a): observed to t1 → A acts → hibernate → B arrives at t3 → fast-forward lands A\'s effects and fires the window\'s dues exactly once',
    { timeout: 30_000 },
    async () => {
      const nowA = { now: 0 };
      const scenarioA = { current: invariantScenario('inv-a', false) };
      const armA = makeArm('env-a', scenarioA, nowA);

      // Observer arrives: the session materializes and advances to t1=30.
      const releaseA = await armA.service.observe('env-a');
      const recordA = armA.registry.get('sim-env-a-world-session')!;
      const anchorA = recordA.runtime.getSimStartEpochMs();
      nowA.now = anchorA + 500; // sim 30 at rate 60
      await armA.service.targetFor('env-a'); // materialize to t1
      expect(recordA.runtime.getSimTimeSec()).toBe(30);
      // The t=30 due fired (exactly once so far).
      expect(projection(armA.registry, recordA.id).scheduledEvents.find(e => e.id === 'evt-due-30')!.fired)
        .toBe(true);

      // A's governance action (device install) — recorded in env rows; the
      // live session lands it through the topology refresh. NOTE: the rebuild
      // REPLACES the registry record — re-fetch rather than holding recordA.
      scenarioA.current = invariantScenario('inv-a', true);
      await armA.service.onWorldMutation('env-a', { create: false });
      expect(armA.registry.get('sim-env-a-world-session')!.runtime.getSnapshot()
        .devices.some(device => device.id === 'heater-installed'))
        .toBe(true);

      // The observer leaves; then the world is FROZEN explicitly at t1.
      // R73 removed the idle demotion sweep — the remaining hibernation
      // path is POST /stop's freeze semantics: registry.hibernate (checkpoint
      // + release) adopted back into the service state.
      releaseA();
      const liveA = armA.registry.get('sim-env-a-world-session')!;
      const frozenA = await armA.registry.hibernate(liveA.id);
      armA.service.adoptExternalHibernate('env-a', {
        record: frozenA,
        simStartEpochMs: anchorA,
      });
      expect(armA.service.statusOf('env-a')?.status).toBe('hibernated');
      expect(armA.service.statusOf('env-a')!.checkpointAtSec).toBe(30);

      // B "arrives" at t3 (sim 120 = wall +2s from the anchor): wake +
      // fast-forward over the empty window (dues 60/90 in between).
      nowA.now = anchorA + 2_000;
      await armA.service.targetFor('env-a');
      const woken = armA.registry.get('sim-env-a-world-session')!;
      expect(woken).toBeDefined();
      expect(woken.runtime.getSimTimeSec()).toBe(120);
      const projA = projection(armA.registry, woken.id);
      // Every due in (t1, t3] fired exactly once…
      for (const id of ['evt-due-60', 'evt-due-90']) {
        expect(projA.scheduledEvents.find(event => event.id === id)!.fired).toBe(true);
      }
      // …and A's effect is present in B's observed world.
      expect(projA.devices.some(device => device.id === 'heater-installed')).toBe(true);
    },
  );

  it(
    'part (b): equivalence — a continuously-ACTIVE session through t1..t3 yields the SAME world',
    { timeout: 30_000 },
    async () => {
      // Arm 1 — the hibernate/fast-forward arm (same choreography as (a)).
      const now1 = { now: 0 };
      const scenario1 = { current: invariantScenario('inv-1', false) };
      const arm1 = makeArm('env-1', scenario1, now1);
      const release1 = await arm1.service.observe('env-1');
      const record1 = arm1.registry.get('sim-env-1-world-session')!;
      const anchor = record1.runtime.getSimStartEpochMs();
      const t0Export = record1.runtime.exportWorldState(); // shared anchor seed

      now1.now = anchor + 500; // t1 = 30
      await arm1.service.targetFor('env-1');
      scenario1.current = invariantScenario('inv-1', true); // A acts
      await arm1.service.onWorldMutation('env-1', { create: false });
      release1();
      // R73: freeze explicitly (the idle sweep is gone) — the hibernate arm
      // crosses the window as a checkpoint + fast-forward.
      const live1 = arm1.registry.get('sim-env-1-world-session')!;
      const frozen1 = await arm1.registry.hibernate(live1.id);
      arm1.service.adoptExternalHibernate('env-1', {
        record: frozen1,
        simStartEpochMs: anchor,
      });
      expect(arm1.service.statusOf('env-1')?.status).toBe('hibernated');

      // Arm 2 — continuously ACTIVE: same anchor (the t0 export is restored
      // into its fresh runtime through the onSessionCreated seam — the P1
      // clock-anchor discipline), same choreography, observer NEVER leaves.
      const now2 = { now: 0 };
      const scenario2 = { current: invariantScenario('inv-2', false) };
      let seeded = false;
      const arm2 = makeArm('env-2', scenario2, now2, record => {
        record.runtime.restoreWorldState(t0Export);
        seeded = true;
      });
      const release2 = await arm2.service.observe('env-2');
      const record2 = arm2.registry.get('sim-env-2-world-session')!;
      expect(seeded).toBe(true);
      expect(record2.runtime.getSimStartEpochMs()).toBe(anchor);

      now2.now = anchor + 500; // t1 = 30 (same absolute wall mapping)
      await arm2.service.targetFor('env-2');
      scenario2.current = invariantScenario('inv-2', true);
      await arm2.service.onWorldMutation('env-2', { create: false });

      // B arrives at t3 in both arms.
      now1.now = anchor + 2_000;
      now2.now = anchor + 2_000;
      await arm1.service.targetFor('env-1');
      await arm2.service.targetFor('env-2');
      release2(); // arm 2's observer finally leaves — after the comparison point

      const proj1 = projection(arm1.registry, 'sim-env-1-world-session');
      const proj2 = projection(arm2.registry, 'sim-env-2-world-session');
      // NOTE: the arms' scenario meta.id differ (env ids ride the scenario),
      // but zones/devices/agents/events use the SAME fixture ids — the
      // projection compares exactly those.
      expect(proj1).toEqual(proj2);
      // Every window due fired in BOTH arms (set-markers make refire
      // structurally impossible; the bit-equal worlds above are the
      // behavioral proof — a missed or double execution would diverge the
      // physics the projections carry).
      for (const proj of [proj1, proj2]) {
        expect(proj.scheduledEvents.map(event => event.fired)).toEqual([true, true, true]);
      }
    },
  );

  it('scenarioDriftNotes: added/removed topology yields teaching notes', () => {
    const before = invariantScenario('drift', false);
    const after = invariantScenario('drift', true);
    const notes = scenarioDriftNotes(before, after);
    expect(notes.join(' ')).toContain('device "heater-installed:heater:sim://heater-installed" was added');
    expect(scenarioDriftNotes(after, before).join(' ')).toContain('was removed');
    expect(scenarioDriftNotes(before, invariantScenario('drift', false))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG-07: a world-session runtime rebuild must never let a pending AC
// handshake die silently — the old runtime narrates every parked handshake
// as ac-cancelled (reason 'runtime-rebuild') into the SHARED trajectory
// before the swap.
// ---------------------------------------------------------------------------

describe('BUG-07: rebuildLiveSession narrates pending AC handshakes as ac-cancelled (runtime-rebuild)', () => {
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];

  afterEach(() => {
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Two-agent world; the AC targets a GHOST partner so the handshake stays parked. */
  function bug07Scenario(withId: string): ScenarioDefinition {
    return {
      version: '1.0',
      meta: { id: withId, name: 'BUG-07 Lab', description: 'handshake-rebuild fixture' },
      zones: [{ id: 'zone-a', name: 'Zone A', baseline: { temperature: 22, humidity: 45 } }],
      devices: [
        {
          id: 'temp-sensor-a', name: 'Sensor A', type: 'temperature-sensor',
          capabilities: ['temperature-reading'], zoneId: 'zone-a', binding: 'sim://temp-sensor-a',
        },
      ],
      agents: [
        {
          id: 'sensor-agent', name: 'Sensor Agent', capabilities: ['temperature-monitoring'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
        },
        {
          id: 'actuator-agent', name: 'Actuator Agent', capabilities: ['temperature-control'],
          managesZoneIds: ['zone-a'], boundDeviceIds: [],
        },
      ],
      events: [],
    } as unknown as ScenarioDefinition;
  }

  /** Park an AC handshake on the runtime's initiator agent (ghost partner → no answer ever). */
  async function parkHandshake(runtime: SimulationRecord['runtime'], collaborationId: string): Promise<void> {
    const agents = (runtime as unknown as {
      agents: Map<string, unknown>;
    }).agents;
    const initiator = agents.get('sensor-agent') as {
      collaborationCoordinator: {
        handleAutonomousACInitiation: (config: unknown, result: unknown) => Promise<void>;
      };
    };
    await initiator.collaborationCoordinator.handleAutonomousACInitiation(
      {
        id: collaborationId,
        name: 'Rebuild cancel probe',
        description: 'park a handshake across a runtime rebuild',
        priority: 'high',
        participantAgentIds: ['ghost-agent'],
        requiredResources: [],
        goals: [],
      },
      {},
    );
  }

  it('pending handshake lands ac-cancelled decisionSource=aborted reason=runtime-rebuild in the shared trajectory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug07-rebuild-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const scenario = bug07Scenario('bug07');
    const record = await registry.createEnvSession({ envId: 'env-bug07', scenario });

    await parkHandshake(record.runtime, 'ac-bug07');
    // The handshake is parked — no conclusion on the bus yet.
    expect(
      record.runtime.getCollaborations().find(c => c.id === 'ac-bug07' && c.agentId === 'sensor-agent')?.status,
    ).toBe('pending');

    await registry.rebuildLiveSession(record.id, scenario);

    // The cancel was narrated by the OLD runtime into the SHARED (append-mode)
    // trajectory before the swap — the death is explicit, never implicit.
    const records = await readTrajectoryDirRecords(join(dir, record.id), {});
    const cancels = records.filter(
      r => r.kind === 'collaboration-response' && r.decision === 'cancelled' && r.collaborationId === 'ac-bug07',
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.decisionSource).toBe('aborted');
    expect(cancels[0]!.reasoning).toBe('runtime-rebuild');
    expect(cancels[0]!.agentId).toBe('sensor-agent');

    // The session closed on the bus too (every agent's view finalizes).
    const rebuilt = registry.get(record.id)!;
    expect(rebuilt).toBeDefined();

    // Idempotent: tearing everything down afterwards narrates NOTHING more
    // (the abort handle was consumed by the rebuild).
    registry.stopAll();
    const after = await readTrajectoryDirRecords(join(dir, record.id), {});
    expect(
      after.filter(
        r => r.kind === 'collaboration-response' && r.decision === 'cancelled' && r.collaborationId === 'ac-bug07',
      ),
    ).toHaveLength(1);
  });

  it('a plain stop narrates the parked handshake with reason runtime-stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bug07-stop-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const record = await registry.createEnvSession({ envId: 'env-bug07b', scenario: bug07Scenario('bug07b') });

    await parkHandshake(record.runtime, 'ac-bug07-stop');
    registry.stopAll();

    const records = await readTrajectoryDirRecords(join(dir, record.id), {});
    const cancels = records.filter(
      r => r.kind === 'collaboration-response' && r.decision === 'cancelled' && r.collaborationId === 'ac-bug07-stop',
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.decisionSource).toBe('aborted');
    expect(cancels[0]!.reasoning).toBe('runtime-stopped');
  });
});

// ---------------------------------------------------------------------------
// R2-BUG-04: the generic sim routes are ARRIVAL paths for the world session
// (sim stream pins ACTIVE, /start wakes + catches up honestly, /events lands
// at the caught-up clock) — the session's lazy runtime used to make all
// three look "running" while the wall-mapped clock sat frozen.
// ---------------------------------------------------------------------------

describe('R2-BUG-04: generic sim routes wake/catch up the world session', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let sessionId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ worldSessionSimPerWallSec: 60, worldSessionIdleGraceMs: 250 });
    owner = await registerUser(ctx.app, { displayName: 'Arrival Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'r2-bug04-lab', name: 'R2 BUG-04 Lab', description: 'arrival-path fixture' },
        zones: [{ id: 'zone-a', baseline: { temperature: 22 } }],
        devices: [],
        agents: [],
        events: [
          // Declared (T66i) but far beyond the test's wall window — never fires.
          { id: 'evt-far', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 30, atSimTimeSec: 999_999_999 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    sessionId = `sim-${envId}-world-session`;
    // R73: the session auto-starts (fire-and-forget) at env creation.
    expect(await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 5_000)).toBe(true);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function snapshotSimTimeSec(): Promise<number> {
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${sessionId}/snapshot`, headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().simTimeSec as number;
  }

  /** Wall-mapped target the catch-up must reach (rate 60 in this harness). */
  function wallTargetSec(): number {
    const anchor = ctx.app.worldSessions.statusOf(envId)!.simStartEpochMs!;
    return ((Date.now() - anchor) / 1000) * 60;
  }

  it('/start on the session is no fake 200 — it catches the world up and answers the real simTimeSec', async () => {
    // Let the world fall behind: no arrival, no due → the lazy clock freezes.
    const frozen = await snapshotSimTimeSec();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await snapshotSimTimeSec()).toBeLessThan(frozen + 10); // still frozen (≈24 sim-s behind)

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sessionId}/start`, headers: auth(owner.token), payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('running');
    // The response carries the REAL clock — caught up to wall-now, not the
    // frozen moment the pre-fix fake 200 implied.
    expect(res.json().simTimeSec).toBeGreaterThanOrEqual(wallTargetSec() - 5);
  });

  it('/start with {speed} on the session is a teaching 400 (wall rate is fixed; retarget via /resume)', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sessionId}/start`, headers: auth(owner.token), payload: { speed: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
    expect(res.json().error.message).toContain('/resume');
  });

  it('/events catches the session up BEFORE the injection lands (no more frozen-moment booking)', async () => {
    const frozen = await snapshotSimTimeSec();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await snapshotSimTimeSec()).toBeLessThan(frozen + 10); // frozen precondition

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35 },
    });
    expect(res.statusCode).toBe(200);
    // The injection went through the session service first — the clock is
    // caught up to wall-now, so the event lands in the present.
    expect(await snapshotSimTimeSec()).toBeGreaterThanOrEqual(wallTargetSec() - 5);
  });

  it('the sim stream pins the session ACTIVE while connected and releases on disconnect', { timeout: 15_000 }, async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `ws://127.0.0.1:${(ctx.app.server!.address() as { port: number }).port}`;
    const socket = new WebSocket(`${baseUrl}/api/simulations/${sessionId}/stream`, {
      headers: auth(owner.token),
    });
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    // An initial snapshot frame arrives, and the pin flips the session ACTIVE.
    expect(await until(() => frames.some(frame => frame.kind === 'snapshot'), 5_000)).toBe(true);
    expect(await until(() => ctx.app.worldSessions.statusOf(envId)?.status === 'active', 5_000)).toBe(true);

    socket.close();
    expect(await until(() => ctx.app.worldSessions.statusOf(envId)?.status === 'idle', 5_000)).toBe(true);
  });
});
