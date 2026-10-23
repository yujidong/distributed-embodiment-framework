/**
 * @vitest-environment node
 *
 * Simulation API + WebSocket stream tests (no LLM backend, no external network —
 * the WS client connects to an in-process listener on 127.0.0.1:0).
 *
 * Lifecycle coverage: create → start → step → inject event → snapshot
 * reflects the injected parameter → command → pause/resume → stop; stopped
 * simulations stay queryable. Graceful shutdown: `app.close()` must stop
 * every runtime (verified via the registry decorator) and vitest must exit
 * without dangling handles.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import { buildServer } from './server.js';
import { createUserScenario } from './test-utils.js';
import { auth, registerUser } from './test-utils.js';

/** Two-zone scenario mirroring the core EngineRuntime test fixture. */
function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Simulation Lab' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  };
}

describe('simulation API', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'sim-store-test-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'sim-traj-test-'));
    app = await buildServer({ userDir, trajectoryDir, logger: false, databasePath: ':memory:' });
    const res = await createUserScenario(app, labScenario('sim-lab'));
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  async function createSimulation(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'sim-lab' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it('creates a simulation and lists it', async () => {
    const id = await createSimulation();
    const list = await app.inject({ method: 'GET', url: '/api/simulations' });
    const entry = list.json().simulations.find((s: { id: string }) => s.id === id);
    expect(entry).toBeDefined();
    expect(entry.scenarioId).toBe('sim-lab');
    expect(entry.state).toBe('created');
    expect(entry.simTimeSec).toBe(0);
    expect(entry.llm).toBe('rule-only');
  });

  it('404s creation with an unknown scenarioId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SCENARIO_NOT_FOUND');
  });

  it('rejects unknown top-level body fields instead of dropping them (DevLoop)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'sim-lab', speed: 10 },
    });
    expect(res.statusCode).toBe(400);
    const message = res.json().error.message as string;
    expect(message).toContain('"speed"');
    // The hint must tell the caller where speed actually lives.
    expect(message).toContain('/start');
    expect(message).toContain('/resume');
  });

  it('resume {speed} retargets the pace; invalid speed is a 400 (DevLoop)', async () => {
    const id = await createSimulation();
    const start = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/start`,
      payload: { speed: 2 },
    });
    expect(start.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });
    const resume = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/resume`,
      payload: { speed: 7 },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().state).toBe('running');
    const snapshot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    expect(snapshot.json().speed).toBe(7);

    // Same validation contract as /start.
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });
    const bad = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/resume`,
      payload: { speed: -1 },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json().error.message as string)).toContain('speed');

    await app.inject({ method: 'POST', url: `/api/simulations/${id}/stop` });
  });

  it('resume {speed} on a RUNNING sim retargets in place (T43: no silent drop)', async () => {
    const id = await createSimulation();
    const start = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/start`,
      payload: { speed: 2 },
    });
    expect(start.statusCode).toBe(200);
    // Previously: running + speed was silently dropped (resume no-ops unless
    // paused). Now the route retargets the live runtime and says so.
    const retarget = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/resume`,
      payload: { speed: 9 },
    });
    expect(retarget.statusCode).toBe(200);
    expect(retarget.json().state).toBe('running');
    expect(retarget.json().speedRetargeted).toBe(true);
    expect(retarget.json().speed).toBe(9);
    const snapshot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    expect(snapshot.json().speed).toBe(9);

    // Omitted speed on a running sim: plain idempotent resume, no retarget face.
    const plain = await app.inject({ method: 'POST', url: `/api/simulations/${id}/resume` });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().state).toBe('running');
    expect(plain.json().speedRetargeted).toBeUndefined();

    // Paused path unchanged: no speedRetargeted face on the resume transition.
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });
    const paused = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/resume`,
      payload: { speed: 4 },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().state).toBe('running');
    expect(paused.json().speedRetargeted).toBeUndefined();
    const after = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    expect(after.json().speed).toBe(4);

    await app.inject({ method: 'POST', url: `/api/simulations/${id}/stop` });
  });

  it('start/resume echo the pace in force (DOC-02: speed + nominal wall multiplier)', async () => {
    const id = await createSimulation();
    const start = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/start`,
      payload: { speed: 5 },
    });
    expect(start.statusCode).toBe(200);
    // speed=5 sim-s/tick at the default tickMs=10 → 500 sim-s per wall-s.
    expect(start.json().speed).toBe(5);
    expect(start.json().nominalSpeedPerSec).toBe(500);

    // Resume echoes the pace in force even without a retarget.
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });
    const resume = await app.inject({ method: 'POST', url: `/api/simulations/${id}/resume` });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().speed).toBe(5);
    expect(resume.json().nominalSpeedPerSec).toBe(500);

    // A retarget echoes the NEW pace.
    const retarget = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/resume`,
      payload: { speed: 0.5 },
    });
    expect(retarget.statusCode).toBe(200);
    expect(retarget.json().speed).toBe(0.5);
    expect(retarget.json().nominalSpeedPerSec).toBe(50);

    // Pause keeps the bare shape (no pace face added).
    const pause = await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });
    expect(pause.json().speed).toBeUndefined();
    expect(pause.json().nominalSpeedPerSec).toBeUndefined();

    await app.inject({ method: 'POST', url: `/api/simulations/${id}/stop` });
  });

  it('runs the full lifecycle: start → step → inject → snapshot → stop', async () => {
    const id = await createSimulation();

    const start = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/start`,
      payload: { speed: 5 },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().state).toBe('running');

    const pause = await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });
    expect(pause.json().state).toBe('paused');
    const resume = await app.inject({ method: 'POST', url: `/api/simulations/${id}/resume` });
    expect(resume.json().state).toBe('running');

    const step = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { n: 2 },
    });
    expect(step.statusCode).toBe(200);
    expect(step.json().simTimeSec).toBeGreaterThanOrEqual(10);

    const event = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/events`,
      payload: { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 31 },
    });
    expect(event.statusCode).toBe(200);
    expect(event.json().parameter).toBe('temperature');
    expect(event.json().value).toBe(31);
    expect(event.json().targetAgentIds).toContain('sensor-agent');

    const snapshot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    expect(snapshot.statusCode).toBe(200);
    const zoneA = snapshot.json().zones.find((z: { id: string }) => z.id === 'zone-a');
    expect(zoneA.parameters.temperature).toBe(31);
    expect(snapshot.json().agents).toHaveLength(2);

    const stop = await app.inject({ method: 'POST', url: `/api/simulations/${id}/stop` });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().state).toBe('stopped');

    // Stopped simulations stay queryable …
    const after = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    expect(after.statusCode).toBe(200);
    expect(after.json().state).toBe('stopped');
    const listed = await app.inject({ method: 'GET', url: `/api/simulations` });
    expect(listed.json().simulations.some((s: { id: string }) => s.id === id)).toBe(true);

    // … but reject further control with a 409.
    const stepAfterStop = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { n: 1 },
    });
    expect(stepAfterStop.statusCode).toBe(409);
    expect(stepAfterStop.json().error.code).toBe('SIMULATION_STOPPED');
  });

  it('step toSimTimeSec advances to an absolute simulation time (Fix-10)', async () => {
    const id = await createSimulation();

    // From 0 with the default speed (1 sim-s/tick): lands exactly on 120.
    const stepped = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { toSimTimeSec: 120 },
    });
    expect(stepped.statusCode).toBe(200);
    expect(stepped.json().simTimeSec).toBeGreaterThanOrEqual(120);

    // Mutually exclusive with n.
    const both = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { n: 1, toSimTimeSec: 180 },
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('BAD_REQUEST');

    // Not after the current sim time — the message names the current value.
    const backwards = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { toSimTimeSec: 60 },
    });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().error.message).toContain('120');

    // Malformed values.
    for (const payload of [{ toSimTimeSec: 0 }, { toSimTimeSec: 'later' }]) {
      const bad = await app.inject({ method: 'POST', url: `/api/simulations/${id}/step`, payload });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('step rejects unknown body fields 400 instead of silently dropping them (S1)', async () => {
    const id = await createSimulation();

    // The historical trap: {"ticks": 100} returned 200 having stepped 1 tick.
    const ticks = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { ticks: 100 },
    });
    expect(ticks.statusCode).toBe(400);
    expect(ticks.json().error.code).toBe('BAD_REQUEST');
    expect(ticks.json().error.message).toContain('"ticks"');
    expect(ticks.json().error.message).toContain('"n"');
    expect(ticks.json().error.message).toContain('"toSimTimeSec"');

    // Unknown fields are rejected even alongside a valid one — nothing ran.
    const mixed = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { n: 5, speed: 60 },
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().error.message).toContain('"speed"');
    const snapshot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    expect(snapshot.json().simTimeSec).toBe(0);

    // The accepted fields still work.
    const ok = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { n: 2 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('step toSimTimeSec derives the tick count from the runtime speed', async () => {
    const id = await createSimulation();
    // speed 60 sim-s/tick → 28800 needs 480 ticks; the landing point may
    // overshoot the target by less than one speed step.
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/start`, payload: { speed: 60 } });
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/pause` });

    const stepped = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/step`,
      payload: { toSimTimeSec: 28800 },
    });
    expect(stepped.statusCode).toBe(200);
    expect(stepped.json().simTimeSec).toBeGreaterThanOrEqual(28800);
    expect(stepped.json().simTimeSec).toBeLessThan(28800 + 60);
  });

  it('executes device commands and reports unmanaged devices', async () => {
    // Fix-1: device commands require authentication (any authenticated user
    // may drive a creator-less legacy sim).
    const commander = await registerUser(app, { displayName: 'Commander' });
    const id = await createSimulation();

    const anonymous = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/commands`,
      payload: { deviceId: 'hvac-b', commandName: 'turn-on' },
    });
    expect(anonymous.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/commands`,
      headers: auth(commander.token),
      payload: { deviceId: 'hvac-b', commandName: 'turn-on' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);

    // Fix-1: an unknown device is a 404 (no longer 200 + success:false).
    const unmanaged = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/commands`,
      headers: auth(commander.token),
      payload: { deviceId: 'ghost-device', commandName: 'turn-on' },
    });
    expect(unmanaged.statusCode).toBe(404);
    expect(unmanaged.json().error.code).toBe('DEVICE_NOT_FOUND');

    const malformed = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/commands`,
      headers: auth(commander.token),
      payload: { deviceId: 'hvac-b' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('400s on bad event bodies and unknown zones', async () => {
    const id = await createSimulation();

    const noType = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/events`,
      payload: { zoneId: 'zone-a' },
    });
    expect(noType.statusCode).toBe(400);

    const badZone = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/events`,
      payload: { type: 'temperature-spike', zoneId: 'zone-x' },
    });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json().error.code).toBe('UNKNOWN_ZONE');
  });

  it('404s every simulation route for unknown ids', async () => {
    // Fix-1: /commands requires auth — the sweep authenticates so the 404
    // (not a 401) is what each route answers for an unknown id.
    const user = await registerUser(app);
    const urls = [
      { method: 'GET' as const, url: '/api/simulations/nope/snapshot' },
      { method: 'GET' as const, url: '/api/simulations/nope/trajectory' },
      { method: 'POST' as const, url: '/api/simulations/nope/start' },
      { method: 'POST' as const, url: '/api/simulations/nope/pause' },
      { method: 'POST' as const, url: '/api/simulations/nope/resume' },
      { method: 'POST' as const, url: '/api/simulations/nope/stop' },
      { method: 'POST' as const, url: '/api/simulations/nope/step', payload: { n: 1 } },
      { method: 'POST' as const, url: '/api/simulations/nope/events', payload: { type: 't', zoneId: 'z' } },
      { method: 'POST' as const, url: '/api/simulations/nope/commands', payload: { deviceId: 'd', commandName: 'c' } },
      { method: 'GET' as const, url: '/api/simulations/nope/stream' },
    ];
    for (const req of urls) {
      const res = await app.inject({ ...req, headers: auth(user.token) });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404);
      expect(res.json().error.code).toBe('SIMULATION_NOT_FOUND');
    }
  });

  it('stops all runtimes on app.close() (graceful shutdown)', async () => {
    const id = await createSimulation();
    await app.inject({ method: 'POST', url: `/api/simulations/${id}/start`, payload: { speed: 1 } });
    expect(app.simulations.getOrThrow(id).runtime.getState()).toBe('running');

    await app.close();
    expect(app.simulations.getOrThrow(id).runtime.getState()).toBe('stopped');
  });
});

describe('simulation WebSocket stream', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;
  let simId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'sim-stream-test-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'sim-traj-test-'));
    // Snapshot cadence of 1 sim-second keeps the stream chatty in tests.
    app = await buildServer({ userDir, trajectoryDir, logger: false, snapshotEverySimSec: 1, databasePath: ':memory:' });
    await createUserScenario(app, labScenario('sim-lab'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'sim-lab' },
    });
    simId = created.json().id;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  function connect(path: string): WebSocket {
    const socket = new WebSocket(`${baseUrl}${path}`);
    sockets.push(socket);
    return socket;
  }

  function nextMessage(socket: WebSocket, timeoutMs = 4000): Promise<{ kind: string; data: never }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for stream message')), timeoutMs);
      socket.once('message', raw => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      socket.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it('pushes an immediate snapshot, then delta frames as sim time advances (R30)', async () => {
    const socket = connect(`/api/simulations/${simId}/stream`);

    const first = await nextMessage(socket);
    expect(first.kind).toBe('snapshot');
    // NB: snapshot.runtimeId is the ENGINE runtime id (`runtime-<scenarioId>`),
    // not the registry's simulation id.
    expect((first.data as { scenarioId: string }).scenarioId).toBe('sim-lab');

    // Speed 10 → 1 sim-second every ~10 ms real time; cadence is 1 sim-second.
    // R30: within the 30s resync window the cadence lane sends ADDITIVE
    // zone-delta/device-delta frames (the full snapshot stays for the
    // initial sync, resync, and topology/large diffs).
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, payload: { speed: 10 } });
    const frames: Array<{ kind: string; simTimeSec?: number }> = [];
    for (let i = 0; i < 12; i++) {
      frames.push(await nextMessage(socket));
    }
    const kinds = new Set(frames.map(f => f.kind));
    // A freshly started sim drifts its zones → zone deltas arrive; within the
    // 30s resync window every frame is additive (zone-delta / device-delta /
    // event) and carries the sim time — with ONE designed exception: FEAT-02
    // (zone power ↔ device-ledger coupling) converges each zone's `power`
    // field from its 500 W baseline to the 0 W ledger sum on the first
    // physics pass after start. That first cadence's diff (8 zone-deltas + 1
    // device-delta) crosses the bandwidth crossover in sim-stream-deltas.ts,
    // so the stream sends its documented large-diff fallback — ONE full
    // snapshot — and the delta lane resumes from there (verified: every
    // later cadence rides deltas). More than one snapshot here, or one
    // landing AFTER deltas, is a regression.
    const snapshotIndexes = frames.flatMap((f, i) => (f.kind === 'snapshot' ? [i] : []));
    expect(snapshotIndexes.length).toBeLessThanOrEqual(1);
    if (snapshotIndexes.length === 1) {
      const firstDelta = frames.findIndex(f => f.kind !== 'snapshot');
      expect(snapshotIndexes[0]).toBeLessThan(firstDelta === -1 ? frames.length : firstDelta);
    }
    for (const frame of frames) {
      if (frame.kind === 'snapshot') continue;
      expect(['zone-delta', 'device-delta', 'event']).toContain(frame.kind);
      expect(frame.simTimeSec ?? (frame as { data?: { simTimeSec?: number } }).data?.simTimeSec)
        .toBeGreaterThanOrEqual(1);
    }
    expect(kinds.size).toBeGreaterThan(0);

    socket.close();
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });
  });

  it('rejects unknown simulations with 404 before the upgrade', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/simulations/nope/stream' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SIMULATION_NOT_FOUND');

    // And a real upgrade attempt fails to open.
    const socket = connect('/api/simulations/nope/stream');
    await new Promise<void>(resolve => {
      socket.on('error', () => resolve());
      socket.on('close', () => resolve());
    });
  });

  // -------------------------------------------------------------------------
  // T-007 lifecycle regressions: a stopped simulation must END its stream
  // (final stopped snapshot + close 1001), the stream is receive-only, and a
  // dead peer is terminated by the heartbeat instead of holding the socket.
  // -------------------------------------------------------------------------

  /** Wait for the first message matching `predicate` (skips the rest). */
  function waitForMessage<T>(
    socket: WebSocket,
    predicate: (parsed: { kind: string; data?: never }) => boolean,
    timeoutMs = 4000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for matching stream message')),
        timeoutMs,
      );
      const onMessage = (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as { kind: string; data?: never };
        if (!predicate(parsed)) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as T);
      };
      socket.on('message', onMessage);
      socket.once('error', err => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        reject(err);
      });
    });
  }

  /** Resolve with {code, reason} on the next 'close'. */
  function nextClose(socket: WebSocket, timeoutMs = 4000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for stream close')), timeoutMs);
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      socket.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  it('ends the stream with a final stopped snapshot + close 1001 when the simulation stops', async () => {
    const socket = connect(`/api/simulations/${simId}/stream`);
    const first = await nextMessage(socket);
    expect(first.kind).toBe('snapshot');
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, payload: { speed: 10 } });

    const closed = nextClose(socket);
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });

    // The LAST frame before the close is a snapshot reporting state:'stopped'
    // — the client learns WHY the stream ended, not just that it ended.
    const finalFrame = await waitForMessage<{ kind: string; data: { state: string } }>(
      socket,
      parsed => parsed.kind === 'snapshot' && (parsed.data as { state?: string }).state === 'stopped',
    );
    expect(finalFrame.kind).toBe('snapshot');
    expect(finalFrame.data.state).toBe('stopped');

    const close = await closed;
    expect(close.code).toBe(1001);
    expect(close.reason).toBe('simulation stopped');
  });

  it('sends one snapshot then closes 1001 when connecting to an already-stopped simulation', async () => {
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, payload: { speed: 10 } });
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });

    const socket = connect(`/api/simulations/${simId}/stream`);
    const first = await nextMessage(socket);
    expect(first.kind).toBe('snapshot');
    expect((first.data as { state: string }).state).toBe('stopped');
    const close = await nextClose(socket);
    expect(close.code).toBe(1001);
    expect(close.reason).toBe('simulation stopped');
  });

  it('answers client-sent data with a STREAM_READ_ONLY error frame and keeps the stream open', async () => {
    const socket = connect(`/api/simulations/${simId}/stream`);
    await nextMessage(socket); // initial snapshot

    socket.send('hello?');
    const errorFrame = await waitForMessage<{ kind: string; code: string; message: string }>(
      socket,
      parsed => parsed.kind === 'error',
    );
    expect(errorFrame.code).toBe('STREAM_READ_ONLY');
    expect(errorFrame.message).toMatch(/receive-only/);
    expect(errorFrame.message).toMatch(/\/api\/simulations/); // teaches where to go

    // The stream survives the confused client: frames keep flowing (R30:
    // the cadence lane is delta frames inside the resync window).
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, payload: { speed: 10 } });
    const after = await waitForMessage<{ kind: string }>(
      socket,
      parsed => parsed.kind === 'snapshot' || parsed.kind === 'zone-delta' || parsed.kind === 'device-delta',
    );
    expect(['snapshot', 'zone-delta', 'device-delta']).toContain(after.kind);
    socket.close();
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });
  });
});

// ---------------------------------------------------------------------------
// T-007: heartbeat — a peer that dies without a FIN (killed CLI wrapper,
// dropped WiFi) must be terminated within ~2 heartbeat cycles instead of
// holding its socket, subscription and ws gauge open forever.
// ---------------------------------------------------------------------------
describe('simulation WebSocket stream heartbeat', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;
  let simId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'sim-hb-test-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'sim-hb-traj-'));
    app = await buildServer({
      userDir,
      trajectoryDir,
      logger: false,
      snapshotEverySimSec: 1,
      databasePath: ':memory:',
      agreementStreamHeartbeatMs: 100,
    });
    await createUserScenario(app, labScenario('sim-hb-lab'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'sim-hb-lab' },
    });
    simId = created.json().id;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  it('terminates a dead peer (no pong) within two heartbeat cycles', async () => {
    const gauge = () =>
      (app as unknown as { metrics: { wsConnections: () => { simulation: number } } })
        .metrics.wsConnections().simulation;
    const socket = new WebSocket(`${baseUrl}/api/simulations/${simId}/stream`);
    sockets.push(socket);
    await new Promise<void>(resolve => socket.once('open', resolve));
    expect(gauge()).toBe(1);

    // Pause the underlying TCP: the server's pings get no pong back. The
    // paused client cannot itself observe the terminate (it stopped
    // reading), so the assertion is the SERVER-side gauge, then the close
    // is confirmed after resuming the socket.
    (socket as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
    const deadline = Date.now() + 2000; // ~2 cycles of 100ms + slack
    while (gauge() !== 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(gauge()).toBe(0); // the dead peer's slot was released, not leaked
    (socket as unknown as { _socket: { pause(): void; resume(): void } })._socket.resume();
    await new Promise<void>(resolve => socket.once('close', resolve));
  });
});
