/**
 * @vitest-environment node
 *
 * S3 (Task 3): cross-process world-session resume — the P1W deferred gap.
 * Frozen world sessions (POST /stop freeze semantics — R73 removed the idle
 * sweep, so an explicit freeze or a prior process's checkpoint is the only
 * way into HIBERNATED) release their runtime while the checkpoint stays on
 * disk. The recovery is boot-scan + lazy-rebind:
 *
 * - HTTP level: freeze a session in server A over shared data dirs,
 *   "restart" into a fresh server B over the SAME db + trajectory dir, and
 *   see the boot scan adopt the checkpoint and EAGERLY WAKE the world
 *   (R74c/R76: worlds never sleep across restarts) with history intact
 *   (same session id, sim-time continues past the checkpoint, dues stay
 *   fired exactly once, the wall anchor never jumps).
 * - Registry level (injected clock — the downtime arithmetic doubles as the
 *   Task 4 contract): a restart + downtime window replays the MISSED dues
 *   exactly once, via both the boot-scan adopt and the lazy (arrival-driven)
 *   rebind.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { SimulationRegistry, type SimulationRecord } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';
import { auth, buildTestServer, registerUser } from './test-utils.js';
import { WebSocket } from 'ws';

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
// HTTP level — server A hibernates, server B (same data dirs) recovers
// ---------------------------------------------------------------------------

describe('S3 Task 3: world-session boot recovery across a restart (HTTP)', () => {
  const apps: FastifyInstance[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'freeze (POST /stop) → restart (new server over the same data dirs) → hibernated view with checkpoint metadata → arrival wakes with history intact',
    { timeout: 45_000 },
    async () => {
      // Shared, FILE-backed data dirs so the "restart" sees server A's state.
      const base = mkdtempSync(join(tmpdir(), 'eaf-resume-s3-'));
      dirs.push(base);
      const dbPath = join(base, 'eaf.db');
      const trajectoryDir = join(base, 'trajectories');
      const boot = (): Promise<FastifyInstance> => buildTestServer({
        userDir: join(base, 'scenarios'),
        trajectoryDir,
        databasePath: dbPath,
        webDist: join(base, 'no-web-dist'),
        rateLimitEnabled: false,
        proposalReviewTimeoutAutoApprove: false,
        // Wall-rate 60 (1 wall-sec = 1 sim-minute) + a short idle grace so
        // the hibernate boundary is observable without long waits.
        worldSessionSimPerWallSec: 60,
        worldSessionIdleGraceMs: 250,
      });

      // ── Server A: env + data-service agreement (the arrival surface) ──
      const appA = await boot();
      apps.push(appA);
      const owner = await registerUser(appA, { displayName: 'Resume Owner' });
      const consumer = await registerUser(appA, { displayName: 'Resume Consumer' });
      const created = await appA.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: {
          version: '1.0',
          visibility: 'public',
          meta: { id: 'resume-lab', name: 'Resume Lab', description: 'S3 fixture' },
          zones: [{ id: 'zone-a', baseline: { temperature: 22, humidity: 45 } }],
          devices: [{
            id: 'temp-sensor-a', name: 'Sensor A', type: 'sensor',
            capabilities: ['temperature-reading'], zoneId: 'zone-a', initialState: { active: false },
          }],
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
      const envId = created.json().id as string;
      const sessionSimId = `sim-${envId}-world-session`;
      const detail = (await appA.inject({
        method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
      })).json();
      const providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
        .find(agent => agent.name === 'Care Bot')!.id;
      const published = await appA.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
        headers: auth(owner.token),
        payload: { name: 'zone-temp', semanticType: 'care-status-aggregate' },
      });
      expect(published.statusCode).toBe(201);
      const registered = await appA.inject({
        method: 'POST',
        url: `/api/services/${published.json().id}/computation`,
        headers: auth(owner.token),
        payload: {
          kind: 'zone-query',
          refreshSec: 60,
          inputs: { zones: ['zone-a'], metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }] },
          interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] } },
        },
      });
      expect(registered.statusCode).toBe(201);
      await appA.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
      const proposed = await appA.inject({
        method: 'POST', url: `/api/services/${published.json().id}/agreements`,
        headers: auth(consumer.token),
        payload: { terms: { read: { fields: ['avgTemperature'] } } },
      });
      expect(proposed.statusCode).toBe(201);
      const agreementId = proposed.json().id as string;
      const decided = await appA.inject({
        method: 'POST', url: `/api/agreements/${agreementId}/decide`,
        headers: auth(owner.token), payload: { decision: 'accept' },
      });
      expect(decided.statusCode).toBe(200);

      // ── Phase 1 (server A): the world auto-started at env creation
      // (R73); the read lands on it, then FREEZE explicitly — R73 removed
      // the idle sweep, so POST /stop's freeze semantics (checkpoint +
      // release) are the remaining path into HIBERNATED. ──
      const read = await appA.inject({
        method: 'POST', url: `/api/agreements/${agreementId}/reads`,
        headers: auth(consumer.token), payload: {},
      });
      expect(read.statusCode).toBe(200);
      // Rate 60: the catch-up runs far past sim 4 (both dues fired) — wait
      // for it so the checkpoint provably carries the fired markers.
      expect(await until(
        () => (appA.worldSessions.statusOf(envId)?.simTimeSec ?? 0) >= 4,
        5_000,
      )).toBe(true);
      const frozenOnA = await appA.inject({
        method: 'POST', url: `/api/simulations/${sessionSimId}/stop`,
        headers: auth(owner.token),
      });
      expect(frozenOnA.statusCode).toBe(200);
      expect(frozenOnA.json().state).toBe('hibernated');
      const viewA = appA.worldSessions.statusOf(envId)!;
      expect(viewA.status).toBe('hibernated');
      const checkpointAt = viewA.checkpointAtSec!;
      const anchorA = viewA.simStartEpochMs!;
      expect(checkpointAt).toBeGreaterThanOrEqual(4);
      expect(appA.simulations.get(sessionSimId)).toBeUndefined(); // runtime released

      // ── Phase 2: shutdown A, boot B over the SAME data dirs ──
      await appA.close();
      apps.splice(apps.indexOf(appA), 1); // A is gone; only B closes in cleanup
      const appB = await boot();
      apps.push(appB);

      // Boot-scan recovery + R74c/R76 (always-on completion): B adopts the
      // on-disk checkpoint AND eagerly wakes the world — worlds never sleep
      // across restarts, so there is NO hibernated-without-arrival window
      // anymore. The wake is fire-and-forget from boot: poll for it.
      expect(await until(
        () => ['active', 'idle'].includes(appB.worldSessions.statusOf(envId)?.status ?? ''),
        10_000,
      )).toBe(true);
      const detailB = (await appB.inject({
        method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
      })).json();
      // The SAME session identity survived the restart…
      expect(detailB.worldSession).toMatchObject({
        status: expect.stringMatching(/^(active|idle)$/),
        simulationId: sessionSimId,
      });
      // …with the SAME wall anchor — the time base never jumps across the
      // restart (T-410; simStartEpochMs makes the mapping inspectable)…
      expect(detailB.worldSession.simStartEpochMs).toBe(anchorA);
      // …and sim-time continues PAST the checkpoint boundary (the eager
      // wake fast-forwarded over the downtime window).
      expect(detailB.worldSession.simTimeSec).toBeGreaterThan(checkpointAt);

      // ── Phase 3: an arrival lands on the boot-woken world, history intact ──
      const readB = await appB.inject({
        method: 'POST', url: `/api/agreements/${agreementId}/reads`,
        headers: auth(consumer.token), payload: {},
      });
      expect(readB.statusCode).toBe(200);
      expect(readB.json().simulationId).toBe(sessionSimId);
      const viewB = appB.worldSessions.statusOf(envId)!;
      // Anchor continuity across the whole restart.
      expect(viewB.simStartEpochMs).toBe(anchorA);
      // History intact: the pre-checkpoint dues are fired (set markers make
      // refire impossible) and the world did not restart at t=0.
      const snapshot = appB.simulations.get(sessionSimId)!.runtime.getSnapshot();
      expect(snapshot.scheduledEvents.map(event => ({ id: event.id, fired: event.fired }))).toEqual([
        { id: 'evt-due-2', fired: true },
        { id: 'evt-due-4', fired: true },
      ]);
      expect(snapshot.simTimeSec).toBeGreaterThan(checkpointAt);
    },
  );

  it(
    'hard kill WITHOUT any checkpointed world: the boot scan still resurrects crash-lost sessions (F7 eager half)',
    { timeout: 45_000 },
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'eaf-crash-eager-'));
      dirs.push(base);
      const boot = (): Promise<FastifyInstance> => buildTestServer({
        userDir: join(base, 'scenarios'),
        trajectoryDir: join(base, 'trajectories'),
        databasePath: join(base, 'eaf.db'),
        webDist: join(base, 'no-web-dist'),
        rateLimitEnabled: false,
        proposalReviewTimeoutAutoApprove: false,
        worldSessionSimPerWallSec: 60,
        worldSessionIdleGraceMs: 250,
      });

      const appA = await boot();
      apps.push(appA);
      const owner = await registerUser(appA, { displayName: 'Crash Owner' });
      const created = await appA.inject({
        method: 'POST', url: '/api/environments', headers: auth(owner.token),
        payload: {
          version: '1.0', visibility: 'public',
          meta: { id: 'crash-lab', name: 'Crash Lab', description: 'F7 fixture' },
          zones: [{ id: 'zone-a', baseline: { temperature: 22, humidity: 45 } }],
          devices: [], agents: [],
        },
      });
      expect(created.statusCode).toBe(201);
      const envId = created.json().id as string;
      const sessionSimId = `sim-${envId}-world-session`;
      // R73: auto-started at env creation; runs continuously → never writes
      // a checkpoint (that is exactly the crash shape).
      expect(await until(() => appA.worldSessions.statusOf(envId) !== undefined, 5_000)).toBe(true);
      await appA.close();
      apps.splice(apps.indexOf(appA), 1);
      expect(existsSync(join(base, 'trajectories', sessionSimId, 'checkpoint.json'))).toBe(false);

      // Restart over the same dirs: the R76 bare-world resurrection must fire
      // even when ZERO checkpointed worlds exist — the old `rebound > 0` gate
      // swallowed exactly this case (all worlds were running when the process
      // died) and crash-lost sessions never came back.
      const appB = await boot();
      apps.push(appB);
      expect(await until(() => appB.worldSessions.statusOf(envId) !== undefined, 10_000)).toBe(true);
      const detail = (await appB.inject({
        method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
      })).json();
      expect(detail.worldSession).toMatchObject({
        status: expect.stringMatching(/^(active|idle)$/),
        simulationId: sessionSimId,
      });
      // Honestly a FRESH world (no fake history), and it serves again.
      const snapshot = await appB.inject({
        method: 'GET', url: `/api/simulations/${sessionSimId}/snapshot`, headers: auth(owner.token),
      });
      expect(snapshot.statusCode).toBe(200);
    },
  );

  it(
    'crash-loss invisible to the boot scan (trajectory dir gone): the env world STREAM lazily re-materializes (F7 lazy half)',
    { timeout: 45_000 },
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'eaf-crash-lazy-'));
      dirs.push(base);
      const boot = (): Promise<FastifyInstance> => buildTestServer({
        userDir: join(base, 'scenarios'),
        trajectoryDir: join(base, 'trajectories'),
        databasePath: join(base, 'eaf.db'),
        webDist: join(base, 'no-web-dist'),
        rateLimitEnabled: false,
        proposalReviewTimeoutAutoApprove: false,
        worldSessionSimPerWallSec: 60,
        worldSessionIdleGraceMs: 250,
      });

      const appA = await boot();
      apps.push(appA);
      const owner = await registerUser(appA, { displayName: 'Lazy Owner' });
      const created = await appA.inject({
        method: 'POST', url: '/api/environments', headers: auth(owner.token),
        payload: {
          version: '1.0', visibility: 'public',
          meta: { id: 'lazy-lab', name: 'Lazy Lab', description: 'F7 fixture' },
          zones: [{ id: 'zone-a', baseline: { temperature: 22, humidity: 45 } }],
          devices: [], agents: [],
        },
      });
      expect(created.statusCode).toBe(201);
      const envId = created.json().id as string;
      const sessionSimId = `sim-${envId}-world-session`;
      expect(await until(() => appA.worldSessions.statusOf(envId) !== undefined, 5_000)).toBe(true);
      await appA.close();
      apps.splice(apps.indexOf(appA), 1);
      // Erase the on-disk trace: the boot scan iterates trajectory dirs, so a
      // session whose dir is gone (or was never created) is invisible to it.
      rmSync(join(base, 'trajectories', sessionSimId), { recursive: true, force: true });

      const appB = await boot();
      apps.push(appB);
      // No eager recovery, no arrival yet: the detail honestly reports the
      // missing world and the session snapshot 404s (the pre-fix END state).
      const detail0 = (await appB.inject({
        method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
      })).json();
      expect(detail0.worldSession ?? null).toBeNull();
      const snapshot404 = await appB.inject({
        method: 'GET', url: `/api/simulations/${sessionSimId}/snapshot`, headers: auth(owner.token),
      });
      expect(snapshot404.statusCode).toBe(404);

      // An observer arrives (the web world view opens this stream): the
      // session lazily re-materializes — the recovery entry point that used
      // to not exist.
      await appB.listen({ port: 0, host: '127.0.0.1' });
      const port = (appB.server!.address() as { port: number }).port;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/environments/${envId}/stream`, {
        headers: auth(owner.token),
      });
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      expect(await until(() => appB.worldSessions.statusOf(envId) !== undefined, 10_000)).toBe(true);
      const detail1 = (await appB.inject({
        method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
      })).json();
      expect(detail1.worldSession).toMatchObject({
        status: expect.stringMatching(/^(active|idle)$/),
        simulationId: sessionSimId,
      });
      const snapshot200 = await appB.inject({
        method: 'GET', url: `/api/simulations/${sessionSimId}/snapshot`, headers: auth(owner.token),
      });
      expect(snapshot200.statusCode).toBe(200);
      socket.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Registry level — restart + downtime replays missed dues exactly once
// (Task 3's adopt paths; the arithmetic IS Task 4's downtime contract)
// ---------------------------------------------------------------------------

/** Deterministic rule-only world with a sparse due schedule (30/60/90). */
function invariantScenario(withId: string): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: withId, name: 'Resume Invariant Lab', description: 'S3 fixture' },
    zones: [
      {
        id: 'zone-a', name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
    ],
    devices: [{
      id: 'temp-sensor-a', name: 'Sensor A', type: 'temperature-sensor',
      capabilities: ['temperature-reading'], zoneId: 'zone-a', binding: 'sim://temp-sensor-a',
    }],
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

const RATE = 60; // sim-sec per wall-sec
const SESSION_DIR_SUFFIX = '-world-session';

interface Arm {
  registry: SimulationRegistry;
  service: WorldSessionService;
  now: { now: number };
  scenario: { current: ScenarioDefinition };
  /** The arm's trajectory base dir (shared between a process and its "restart"). */
  dir: string;
}

describe('S3 Task 3/4: restart + downtime window replays missed dues exactly once', () => {
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const services: WorldSessionService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh "process": new registry + service; `sharedDir` simulates the
   *  same data dirs surviving a restart. */
  function makeArm(envId: string, sharedDir?: string): Arm {
    const dir = sharedDir ?? mkdtempSync(join(tmpdir(), 'world-session-resume-'));
    if (sharedDir === undefined) tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const now = { now: 0 };
    const scenario = { current: invariantScenario(envId) };
    const service = new WorldSessionService({
      registry,
      scenarioOfEnv: () => scenario.current,
      envOwnerIdOf: () => undefined,
      obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
      nowMs: () => now.now,
      simPerWallSec: RATE,
      attachDriver: false,
      idleGraceMs: 5,
      hibernateHorizonSimSec: 5,
      // The lazy-rebind half of the recovery (as wired in server.ts).
      findHibernatedCheckpoint: env => {
        const path = join(dir, `sim-${env}${SESSION_DIR_SUFFIX}`, 'checkpoint.json');
        return existsSync(path) ? path : undefined;
      },
    });
    services.push(service);
    return { registry, service, now, scenario, dir };
  }

  /** The world projection dues are counted on. */
  function firedMap(registry: SimulationRegistry, simId: string): Record<string, boolean> {
    const snapshot = registry.get(simId)!.runtime.getSnapshot();
    const out: Record<string, boolean> = {};
    for (const event of snapshot.scheduledEvents) out[event.id] = event.fired;
    return out;
  }

  /** Server A's lifecycle: observe → t1=30 → freeze (R73: the idle sweep is
   *  gone — registry.hibernate + adoption, the POST /stop semantics).
   *  Returns the anchor. */
  async function runFirstLife(arm: Arm, envId: string): Promise<number> {
    const release = await arm.service.observe(envId);
    const record = arm.registry.get(`sim-${envId}${SESSION_DIR_SUFFIX}`)!;
    const anchor = record.runtime.getSimStartEpochMs();
    arm.now.now = anchor + 500; // sim 30 at rate 60
    await arm.service.targetFor(envId);
    expect(arm.registry.get(`sim-${envId}${SESSION_DIR_SUFFIX}`)!.runtime.getSimTimeSec()).toBe(30);
    release();
    const live = arm.registry.get(`sim-${envId}${SESSION_DIR_SUFFIX}`)!;
    const frozen = await arm.registry.hibernate(live.id);
    arm.service.adoptExternalHibernate(envId, {
      record: frozen,
      simStartEpochMs: anchor,
    });
    expect(arm.service.statusOf(envId)?.status).toBe('hibernated');
    // The process "dies": close the service, keep the dir (disk survives).
    arm.service.close();
    return anchor;
  }

  it(
    'boot-scan adopt: B (new registry + service over the checkpoint) wakes at wall-now, firing the window dues exactly once',
    { timeout: 30_000 },
    async () => {
      const envId = 'env-scan';
      const armA = makeArm(envId);
      const anchor = await runFirstLife(armA, envId);
      const checkpointPath = join(armA.dir, `sim-${envId}${SESSION_DIR_SUFFIX}`, 'checkpoint.json');

      // ── The "restart": a FRESH registry + service over the same dir. ──
      const armB = makeArm(envId, armA.dir);
      // (Preconditions of a fresh process: nothing in memory.)
      expect(armB.service.statusOf(envId)).toBeUndefined();

      // Boot scan (mirrors server.ts): adopt + surface the hibernated view.
      const adopted = armB.registry.adoptHibernatedCheckpoint(checkpointPath);
      expect(adopted).toBeDefined();
      expect(adopted!.record.checkpoint.simTimeSec).toBe(30);
      expect(adopted!.simStartEpochMs).toBe(anchor);
      const view = armB.service.adoptHibernated(envId, adopted!);
      expect(view).toMatchObject({
        status: 'hibernated',
        simulationId: `sim-${envId}${SESSION_DIR_SUFFIX}`,
        checkpointAtSec: 30,
      });

      // 10 wall-sec of "downtime" after the anchor → the world is late by
      // sim 600 at rate 60; the window (30, 600] contains dues 60 and 90.
      armB.now.now = anchor + 10_000;
      await armB.service.targetFor(envId);
      const simId = `sim-${envId}${SESSION_DIR_SUFFIX}`;
      expect(armB.registry.get(simId)!.runtime.getSimTimeSec()).toBe(600);
      const fired = firedMap(armB.registry, simId);
      expect(fired).toEqual({ 'evt-due-30': true, 'evt-due-60': true, 'evt-due-90': true });
    },
  );

  it(
    'lazy rebind (no boot scan): the FIRST arrival finds the checkpoint on disk and wakes the same history',
    { timeout: 30_000 },
    async () => {
      const envId = 'env-lazy';
      const armA = makeArm(envId);
      const anchor = await runFirstLife(armA, envId);

      const armB = makeArm(envId, armA.dir);
      expect(armB.service.statusOf(envId)).toBeUndefined();
      // No explicit adopt — the arrival itself must discover the checkpoint
      // (findHibernatedCheckpoint) and continue the world.
      armB.now.now = anchor + 2_000; // sim 120 — window dues 60/90
      await armB.service.targetFor(envId);
      const simId = `sim-${envId}${SESSION_DIR_SUFFIX}`;
      expect(armB.registry.get(simId)!.runtime.getSimTimeSec()).toBe(120);
      expect(firedMap(armB.registry, simId)).toEqual({
        'evt-due-30': true, 'evt-due-60': true, 'evt-due-90': true,
      });
    },
  );

  it('a corrupt checkpoint degrades to a fresh world (never blocks the arrival)', async () => {
    const envId = 'env-corrupt';
    const armA = makeArm(envId);
    await runFirstLife(armA, envId);
    const checkpointPath = join(armA.dir, `sim-${envId}${SESSION_DIR_SUFFIX}`, 'checkpoint.json');
    writeFileSync(checkpointPath, '{torn json', 'utf-8');

    const armB = makeArm(envId, armA.dir);
    armB.now.now = Date.now();
    const record: SimulationRecord | undefined = await armB.service.targetFor(envId);
    expect(record).toBeDefined(); // a fresh world materialized at t=0…
    expect(record!.runtime.getSimTimeSec()).toBeGreaterThanOrEqual(0);
    expect(firedMap(armB.registry, record!.id)['evt-due-30']).toBe(false); // …dues unfired
  });

  it(
    'crash-loss (hard kill, NO checkpoint on disk): the env stream observe lazily re-materializes a FRESH world',
    { timeout: 30_000 },
    async () => {
      const envId = 'env-crash';
      const armA = makeArm(envId);
      // A continuously-observed world (the pin keeps it ACTIVE, so it never
      // hibernates and never writes a checkpoint) — then the process DIES.
      const release = await armA.service.observe(envId);
      const simId = `sim-${envId}${SESSION_DIR_SUFFIX}`;
      // The anchor is the runtime's own (wall-clock) birth stamp — advance
      // the injected clock RELATIVE to it, like runFirstLife does.
      const anchor = armA.registry.get(simId)!.runtime.getSimStartEpochMs();
      armA.now.now = anchor + 1_000; // sim 60 at rate 60
      await armA.service.targetFor(envId);
      expect(armA.registry.get(simId)!.runtime.getSimTimeSec()).toBe(60);
      release();
      armA.service.close(); // hard kill: no freeze, no checkpoint
      expect(existsSync(join(armA.dir, simId, 'checkpoint.json'))).toBe(false);

      // ── Restart over the same (checkpoint-less) data dirs. ──
      const armB = makeArm(envId, armA.dir);
      // statusOf stays passive: no arrival yet → the world is absent…
      expect(armB.service.statusOf(envId)).toBeUndefined();
      // …until the env world stream's observe lazily re-materializes it.
      const releaseB = await armB.service.observeOrMaterialize(envId);
      const view = armB.service.statusOf(envId)!;
      expect(view.status).toBe('active');
      expect(view.observers).toBe(1);
      expect(view.simulationId).toBe(simId); // the deterministic id survives
      // Honestly a FRESH world at t=0 — not a fake continuation: no dues
      // fired, no sim-time carried over.
      expect(armB.registry.get(simId)!.runtime.getSimTimeSec()).toBe(0);
      expect(firedMap(armB.registry, simId)).toEqual({
        'evt-due-30': false, 'evt-due-60': false, 'evt-due-90': false,
      });
      releaseB();
    },
  );

  it(
    'crash-loss recovery PREFERS the disk checkpoint: stream observe after a freeze-restart wakes the history',
    { timeout: 30_000 },
    async () => {
      const envId = 'env-crash-checkpoint';
      const armA = makeArm(envId);
      const anchor = await runFirstLife(armA, envId); // freeze at sim 30

      const armB = makeArm(envId, armA.dir);
      expect(armB.service.statusOf(envId)).toBeUndefined();
      // No boot scan, no explicit adopt — the stream observe finds the
      // checkpoint (tryRebindFromDisk) and fast-forwards through downtime.
      armB.now.now = anchor + 2_000; // sim 120 at rate 60
      const releaseB = await armB.service.observeOrMaterialize(envId);
      const simId = `sim-${envId}${SESSION_DIR_SUFFIX}`;
      expect(armB.service.statusOf(envId)!.status).toBe('active');
      expect(armB.registry.get(simId)!.runtime.getSimTimeSec()).toBe(120);
      expect(firedMap(armB.registry, simId)).toEqual({
        'evt-due-30': true, 'evt-due-60': true, 'evt-due-90': true,
      });
      releaseB();
    },
  );

  it('stream observe on an unsimulatable (0-zone) env is warn-only: no session, a no-op release', async () => {
    const envId = 'env-blank';
    const arm = makeArm(envId);
    // The R73 birth-failure shape: scenarioOfEnv throws ENVIRONMENT_INVALID
    // for an env with no zones (server.ts's env-rows adapter).
    Object.defineProperty(arm.scenario, 'current', {
      get(): ScenarioDefinition {
        throw new Error(`ENVIRONMENT_INVALID: env ${envId} has no zones`);
      },
    });
    const release = await arm.service.observeOrMaterialize(envId);
    expect(() => release()).not.toThrow(); // the stream's cleanup path
    expect(arm.service.statusOf(envId)).toBeUndefined();
  });
});
