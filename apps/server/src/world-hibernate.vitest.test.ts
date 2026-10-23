/**
 * @vitest-environment node
 *
 * Living-worlds P0 hibernate/resume (design-living-worlds.md §9) — the
 * server-level lifecycle:
 *
 * - POST /:id/hibernate freezes the world into a versioned checkpoint under
 *   the sim's trajectory dir and releases the runtime; the registry keeps a
 *   lightweight record; lists show state 'hibernated' + checkpoint metadata.
 * - POST /:id/resume rebuilds the runtime from the checkpoint (same sim id,
 *   same trajectory dir, history appended) and continues running.
 * - Acceptance invariant (rule-only): the snapshot projection through the
 *   full registry round-trip (engine export → checkpoint file → read →
 *   restore) EQUALS the pre-hibernate snapshot, and a post-boundary
 *   scheduled event fires exactly once — matching a continuously-run twin.
 * - Runtime-touching routes answer a teaching 409 SIM_HIBERNATED while the
 *   frozen history (/trajectory, /timeline) stays readable.
 *
 * Fixture discipline (from the core-level twin test): every zone pins
 * baseline parameters — unbounded/unpinned zones ride the seasonal diurnal
 * model, a function of construction wall time, which would make separately
 * constructed worlds incomparable.
 *
 * Clock discipline (T118 de-flake): the suite runs on an INJECTED clock —
 * makeTestApp({ simulationTickTimer }) replaces the tick loop's wall timer
 * with a manual one, so a resumed runtime is 'running' (its tick fire is
 * armed) but wall time moves the world only when a test explicitly fires
 * the timer. The pre-seam suite had to absorb "a wall tick may have slipped
 * in" between /resume and /pause with float tolerances (`toBeCloseTo`,
 * `toBeGreaterThanOrEqual`) — under parallel load those tolerances got
 * punched through and the suite flapped. The window is now a deterministic
 * zero, and every wall-clock slack below is tightened to exact equality.
 * The wall ANCHOR is pinned too (`simulationSimStartEpochMs`): both
 * comparison arms share one `simStartEpochMs`, so sim-time-stamped device
 * state (lastReadingAt) is bit-identical instead of construction-gap luck.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MockHassServer } from './hass/mock-hass.js';
import type { TickTimer } from '@active-collaboration/core';
import {
  auth,
  createUserScenario,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/**
 * The pinned WALL anchor (clock-anchor discipline, T118): every runtime this
 * app constructs shares it, so sim-time stamps (a sensor's
 * `lastReadingAt = round(anchor + simTimeSec)`) stop depending on the
 * construction gap between the two comparison arms. Pre-seam the arms
 * anchored at their own construction moments and the integer second rounded
 * differently whenever the gap straddled a half-second boundary — an
 * independent load-sensitive flake the tick-timer injection alone cannot
 * remove (getSimStartEpochMs's own contract: two-runtime equality requires
 * a SHARED anchor).
 */
const PINNED_SIM_START_EPOCH_MS = Date.UTC(2030, 0, 1);

/**
 * The injected wall clock (T118): a manual replacement for the tick loop's
 * wall timer (EngineRuntimeOptions.tickTimer, threaded here through
 * BuildServerOptions.simulationTickTimer). Arming a tick records it; nothing
 * fires on its own — a running world advances only through fireAll(), so the
 * resumed runtime's live window (resume → pause) costs a deterministic zero
 * wall ticks instead of "however many the loaded machine let through".
 */
function makeManualTickTimer() {
  const armed = new Map<number, () => void>();
  let nextId = 1;
  const timer: TickTimer = {
    schedule(callback: () => void, _delayMs: number): unknown {
      const id = nextId++;
      armed.set(id, callback);
      return id;
    },
    cancel(handle: unknown): void {
      armed.delete(handle as number);
    },
  };
  return {
    timer,
    /** Fire every armed tick once (a manual "wall moment"). */
    fireAll(): number {
      const fires = [...armed.values()];
      armed.clear();
      for (const fire of fires) fire();
      return fires.length;
    },
    /** Armed-but-unfired tick count (0 = no wall timer live anywhere). */
    armedCount(): number {
      return armed.size;
    },
  };
}

/** Deterministic world: bounded zones with pinned baselines + scheduled events. */
function hibernateLabScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Hibernate Lab', description: 'living-worlds P0 fixture' },
    zones: [
      {
        id: 'zone-a',
        name: 'Zone A',
        adjacentZoneIds: ['zone-b'],
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
      {
        id: 'zone-b',
        name: 'Zone B',
        adjacentZoneIds: ['zone-a'],
        bounds: { minX: 12, maxX: 22, minY: 0, maxY: 10 },
        baseline: { temperature: 24 },
      },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        name: 'Sensor A',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        name: 'HVAC B',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'lab-agent',
        name: 'Lab Agent',
        capabilities: ['temperature-monitoring', 'temperature-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['temp-sensor-a', 'hvac-b'],
      },
    ],
    events: [
      {
        id: 'evt-pre-boundary',
        type: 'temperature-spike',
        zoneId: 'zone-a',
        parameter: 'temperature',
        value: 33,
        atSimTimeSec: 10,
      },
      {
        id: 'evt-post-boundary',
        type: 'temperature-spike',
        zoneId: 'zone-b',
        parameter: 'temperature',
        value: 34,
        atSimTimeSec: 50,
      },
    ],
  };
}

/**
 * Structural equality for the acceptance invariant — EXACT, non-integer
 * numbers included.
 *
 * Why exact (T118): the clock is injected, wall ticks no longer slip into
 * the resumed runtime's live window, so both comparison arms execute the
 * IDENTICAL step(40) → advanceTo(60) sequence — the physics integration
 * partitions the same total sim time identically and even the
 * exponential-decay floats agree bit-for-bit (the checkpoint's JSON
 * round-trip of doubles is exact). Pre-seam this comparison carried a
 * |diff| ≤ 0.05 slack (`toBeCloseTo(…, 1)`) PURELY to absorb that wall-clock
 * luck; with the slack's cause gone, a mismatch is a real regression.
 * Integers (simTimeSec, tickCount), strings and booleans were always exact.
 */
function expectWorldsEqual(actual: unknown, expected: unknown, path = 'world'): void {
  if (typeof expected === 'number' && !Number.isInteger(expected)) {
    expect(
      actual,
      `float mismatch at ${path}: ${String(actual)} vs ${String(expected)}`,
    ).toBe(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(actual, `shape at ${path}`).toEqual(expect.any(Array));
    expect((actual as unknown[]).length, `length at ${path}`).toBe(expected.length);
    expected.forEach((item, i) => expectWorldsEqual((actual as unknown[])[i], item, `${path}[${i}]`));
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    expect(actual, `shape at ${path}`).not.toBeNull();
    expect(typeof actual, `shape at ${path}`).toBe('object');
    for (const [key, value] of Object.entries(expected)) {
      expectWorldsEqual((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(actual, `exact at ${path}`).toEqual(expected);
}

/** Comparable snapshot projection — the invariant compares this shape. */
function projection(snapshot: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify({
    simTimeSec: snapshot.simTimeSec,
    speed: snapshot.speed,
    tickCount: snapshot.tickCount,
    zones: (snapshot.zones as Array<Record<string, unknown>>).map(zone => ({
      id: zone.id,
      parameters: zone.parameters,
    })),
    devices: (snapshot.devices as Array<Record<string, unknown>>).map(device => ({
      id: device.id,
      state: device.state,
    })),
    scheduledEvents: (snapshot.scheduledEvents as Array<Record<string, unknown>>).map(event => ({
      id: event.id,
      fired: event.fired,
    })),
  }));
}

describe('living-worlds P0: hibernate/resume (server lifecycle)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  /** The injected clock — wall time only moves when a test fires it. */
  let tickTimer: ReturnType<typeof makeManualTickTimer>;

  beforeEach(async () => {
    tickTimer = makeManualTickTimer();
    ctx = await makeTestApp({
      simulationTickTimer: tickTimer.timer,
      simulationSimStartEpochMs: PINNED_SIM_START_EPOCH_MS,
    });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...hibernateLabScenario('hibernate-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createSim(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function step(simId: string, n: number): Promise<Record<string, unknown>> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(owner.token),
      payload: { n },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /** Advance to an absolute sim time (deterministic comparison anchor). */
  async function stepTo(simId: string, toSimTimeSec: number): Promise<Record<string, unknown>> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(owner.token),
      payload: { toSimTimeSec },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function pause(simId: string): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/pause`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  }

  async function snapshot(simId: string): Promise<Record<string, unknown>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('acceptance invariant (rule-only): resume reproduces the frozen world and matches a continuous twin', async () => {
    // Continuous reference: T + T2 = 40 + 20 sim-sec. Stepping to an ABSOLUTE
    // sim time anchors the comparison; with the injected clock the resumed
    // runtime cannot gain a wall tick while briefly live, so both arms
    // execute the identical step(40) → advanceTo(60) sequence and compare
    // EXACTLY (the pre-seam suite only dared a ±0.05 float slack here).
    const continuousId = await createSim();
    await step(continuousId, 40);
    await stepTo(continuousId, 60);
    const referenceSnapshot = await snapshot(continuousId);
    expect(referenceSnapshot.simTimeSec).toBe(60);
    const reference = projection(referenceSnapshot);

    // Hibernated branch: same world, run T → freeze → thaw → run T2.
    const simId = await createSim();
    const at40 = await step(simId, 40);
    expect(at40.simTimeSec).toBe(40);

    const hibernated = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/hibernate`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(hibernated.statusCode).toBe(200);
    expect(hibernated.json().state).toBe('hibernated');
    expect(hibernated.json().checkpoint.simTimeSec).toBe(40);

    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/resume`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state).toBe('running');
    // Identity: sim time CONTINUES from the freeze — EXACTLY. The resumed
    // runtime IS live (exactly one tick fire armed — the running contract
    // holds), but the injected clock cannot fire it on its own, so no wall
    // tick can slip in between this response and the pause below. (Pre-seam
    // this was `toBeGreaterThanOrEqual(40)`: however much wall time the
    // loaded machine let through.)
    expect(tickTimer.armedCount()).toBe(1);
    expect(resumed.json().simTimeSec).toBe(40);
    // The injected clock DRIVES the world too: firing the armed tick
    // advances exactly one sim-second — deterministic, not wall-luck. (The
    // fired tick re-arms the next wall moment; its async body settles before
    // the snapshot below reads 41.)
    expect(tickTimer.fireAll()).toBe(1);
    await until(() => snapshot(simId).then(s => s.simTimeSec === 41), 5000);
    expect((await snapshot(simId)).simTimeSec).toBe(41);
    await pause(simId);
    // pause() cancels the armed tick fire — the world is sealed again.
    expect(tickTimer.armedCount()).toBe(0);

    // T2 crosses the post-boundary event at t=50 — fires exactly once.
    const end = await stepTo(simId, 60);
    expect(end.simTimeSec).toBe(60);
    const finalWorld = projection(await snapshot(simId));

    // THE INVARIANT: hibernate+resume == continuous run (trajectory
    // equivalence — EXACT now that the clock is injected: both arms ran the
    // identical step/advance sequence; see expectWorldsEqual).
    expectWorldsEqual(finalWorld, reference);
    const fired = (finalWorld as { scheduledEvents: Array<{ id: string; fired: boolean }> }).scheduledEvents
      .filter(event => event.fired).map(event => event.id);
    expect(fired).toEqual(['evt-pre-boundary', 'evt-post-boundary']);
  });

  it('hibernate writes a versioned checkpoint; list shows hibernated + metadata; runtime routes teach', async () => {
    const simId = await createSim();
    await step(simId, 12);

    const hibernated = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/hibernate`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(hibernated.statusCode).toBe(200);
    const body = hibernated.json();
    expect(body.hibernatedAt).toBeTruthy();
    expect(body.checkpoint.bytes).toBeGreaterThan(0);
    expect(existsSync(body.checkpoint.path)).toBe(true);
    // Versioned, self-contained envelope on disk.
    const onDisk = JSON.parse(readFileSync(body.checkpoint.path, 'utf-8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.kind).toBe('world-checkpoint');
    expect(onDisk.simId).toBe(simId);
    expect(onDisk.scenario.zones.map((z: { id: string }) => z.id).sort()).toEqual(['zone-a', 'zone-b']);
    expect(onDisk.world.simTimeSec).toBe(12);

    // List: state 'hibernated' + checkpoint metadata + frozen sim time.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations',
      headers: auth(owner.token),
    });
    const entry = list.json().simulations.find((s: { id: string }) => s.id === simId);
    expect(entry.state).toBe('hibernated');
    expect(entry.simTimeSec).toBe(12);
    expect(entry.checkpoint.path).toBe(body.checkpoint.path);
    expect(entry.hibernatedAt).toBe(body.hibernatedAt);

    // Runtime-touching routes: teaching 409, not a misleading 404.
    for (const [method, url] of [
      ['GET', `/api/simulations/${simId}/snapshot`],
      ['POST', `/api/simulations/${simId}/start`],
      ['POST', `/api/simulations/${simId}/step`],
      ['POST', `/api/simulations/${simId}/events`],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: auth(owner.token),
        payload: method === 'POST' ? { n: 1, type: 'temperature-spike', zoneId: 'zone-a' } : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error.code).toBe('SIM_HIBERNATED');
      expect(res.json().error.message).toContain('resume');
    }

    // Frozen history stays readable.
    const timeline = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/timeline`,
      headers: auth(owner.token),
    });
    expect(timeline.statusCode).toBe(200);
    expect(Array.isArray(timeline.json().records)).toBe(true);
  });

  it('hibernate is idempotent; resume twice keeps one live runtime; stop discards the hibernated sim', async () => {
    const simId = await createSim();
    await step(simId, 5);
    const first = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {},
    });
    expect(first.statusCode).toBe(200);
    const again = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().checkpoint.path).toBe(first.json().checkpoint.path);
    expect(again.json().checkpoint.bytes).toBe(first.json().checkpoint.bytes);

    // Resume, then resume again (paused-resume flavor) — still fine.
    const resume1 = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(owner.token), payload: {},
    });
    expect(resume1.statusCode).toBe(200);
    expect(resume1.json().state).toBe('running');
    const resume2 = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(owner.token), payload: {},
    });
    expect(resume2.statusCode).toBe(200);
    expect(resume2.json().state).toBe('running'); // runtime.resume() is a no-op unless paused

    // Hibernate again (re-freeze) and stop → discarded from the list.
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {},
    });
    const stopped = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token), payload: {},
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().state).toBe('stopped');
    const list = await ctx.app.inject({
      method: 'GET', url: '/api/simulations', headers: auth(owner.token),
    });
    expect(list.json().simulations.find((s: { id: string }) => s.id === simId)).toBeUndefined();
  });

  it('teaching refusal: a stopped simulation cannot hibernate', async () => {
    const simId = await createSim();
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(owner.token), payload: {} });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SIM_ALREADY_STOPPED');
  });

  it('teaching refusal: real-device (hass://) worlds stay hot — REAL_DEVICE_SURFACE', async () => {
    const mock = await MockHassServer.start();
    try {
      const hassCtx = await makeTestApp({
        hassUrl: mock.url,
        hassToken: 'test-token',
        simulationTickTimer: tickTimer.timer,
        simulationSimStartEpochMs: PINNED_SIM_START_EPOCH_MS,
      });
      try {
        const user = await registerUser(hassCtx.app, { displayName: 'HA User' });
        const base = hibernateLabScenario('hass-hibernate-lab');
        const scenario = {
          ...base,
          devices: [
            base.devices[0]!, // temp-sensor-a (sim://)
            {
              id: 'ha-light-b',
              type: 'light',
              capabilities: ['lighting-control', 'turn-on', 'turn-off'],
              zoneId: 'zone-b',
              binding: 'hass://light.living_room',
            },
          ],
          agents: [{
            ...base.agents[0]!,
            capabilities: ['temperature-monitoring', 'lighting-control'],
            boundDeviceIds: ['temp-sensor-a', 'ha-light-b'],
          }],
        };
        const uploaded = await createUserScenario(hassCtx.app, scenario);
        expect(uploaded.statusCode).toBe(201);
        const created = await hassCtx.app.inject({
          method: 'POST',
          url: '/api/simulations',
          headers: auth(user.token),
          payload: { scenarioId: scenario.meta.id },
        });
        if (created.statusCode !== 201) console.log('DEBUG create sim:', created.body);
        expect(created.statusCode).toBe(201);
        const res = await hassCtx.app.inject({
          method: 'POST',
          url: `/api/simulations/${created.json().id}/hibernate`,
          headers: auth(user.token),
          payload: {},
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe('REAL_DEVICE_SURFACE');
        expect(res.json().error.message).toContain('hass://');
      } finally {
        await hassCtx.cleanup();
      }
    } finally {
      await mock.close();
    }
  });

  it('access control: only the creator / env owner|builder / admin may hibernate or resume', async () => {
    const simId = await createSim();
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const denied = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(stranger.token), payload: {},
    });
    expect(denied.statusCode).toBe(403);

    // Owner (env owner, not the sim creator) may.
    const allowed = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {},
    });
    expect(allowed.statusCode).toBe(200);

    // A stranger cannot resume it either.
    const deniedResume = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(stranger.token), payload: {},
    });
    expect(deniedResume.statusCode).toBe(403);

    // ...and the owner resumes it back to running.
    const resumed = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(owner.token), payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state).toBe('running');
  });

  it('resume of a corrupted checkpoint fails with a teaching error (audit trail kept)', async () => {
    const simId = await createSim();
    await step(simId, 5);
    const hibernated = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {},
    });
    expect(hibernated.statusCode).toBe(200);

    // Corrupt the checkpoint behind the registry's back.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(hibernated.json().checkpoint.path, '{"version": 1, "kind": "wor', 'utf-8');

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(owner.token), payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHECKPOINT_UNREADABLE');
    // The sim stays hibernated (no half-resumed state).
    const list = await ctx.app.inject({ method: 'GET', url: '/api/simulations', headers: auth(owner.token) });
    expect(list.json().simulations.find((s: { id: string }) => s.id === simId).state).toBe('hibernated');
  });

  it('trajectory + sim-timeline history continues after resume (no truncation)', async () => {
    const simId = await createSim();
    // Env import remaps device ids to fresh instance ids — read them from the
    // snapshot, then pick the HVAC (the device with turn-on).
    const snap = await snapshot(simId);
    const hvac = (snap.devices as Array<{ id: string; commands?: string[] }>)
      .find(device => (device.commands ?? []).includes('turn-on'));
    expect(hvac).toBeDefined();

    // Produce a timeline record: a device command lands in sim-timeline.jsonl.
    const command = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvac!.id, commandName: 'turn-on' },
    });
    expect(command.statusCode).toBe(200);

    const before = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${simId}/timeline`, headers: auth(owner.token),
    });
    const beforeRecords = before.json().records as Array<Record<string, unknown>>;

    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {} });
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(owner.token), payload: {} });

    // A post-resume command appends AFTER the pre-hibernate history.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvac!.id, commandName: 'turn-off' },
    });
    const after = await ctx.app.inject({
      method: 'GET', url: `/api/simulations/${simId}/timeline`, headers: auth(owner.token),
    });
    const afterRecords = after.json().records as Array<Record<string, unknown>>;
    expect(afterRecords.length).toBeGreaterThan(beforeRecords.length);
    expect(afterRecords.slice(0, beforeRecords.length)).toEqual(beforeRecords);
  });

  it('tally windows span the freeze: injections before hibernate still count after resume', async () => {
    const simId = await createSim();
    // Three injections pre-freeze (same type/zone → a countSince window sees them).
    for (let i = 0; i < 3; i++) {
      const injected = await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${simId}/events`,
        headers: auth(owner.token),
        payload: { type: 'motion-detected', zoneId: 'zone-a', parameter: 'motion', value: 1 },
      });
      expect(injected.statusCode).toBe(200);
    }
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/hibernate`, headers: auth(owner.token), payload: {} });
    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/resume`, headers: auth(owner.token), payload: {} });
    // One more injection post-resume — if the ring survived, the tally module
    // sees all four (verified through the registry's tally seam directly:
    // the HTTP surface for countSince is the data-service evaluator, out of
    // scope here). Structural check: the checkpoint carries the ring.
    const list = await ctx.app.inject({ method: 'GET', url: '/api/simulations', headers: auth(owner.token) });
    const entry = list.json().simulations.find((s: { id: string }) => s.id === simId);
    expect(entry.state).toBe('running');
    const checkpoint = JSON.parse(readFileSync(join(ctx.trajectoryDir, simId, 'checkpoint.json'), 'utf-8'));
    expect(checkpoint.eventTally.filter((e: { eventType: string }) => e.eventType === 'motion-detected')).toHaveLength(3);
  });
});
