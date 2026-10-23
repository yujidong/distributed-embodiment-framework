/**
 * @vitest-environment node
 *
 * Living-worlds P1 (design-living-worlds.md §8): lazy scheduling — the
 * server-level lifecycle of sims created with `options.scheduling: 'lazy'`.
 *
 * - The default stays 'tick' (no behavior change; P0 invariants rerun green).
 * - A lazy sim runs WITHOUT the fixed-interval tick timer: the registry's
 *   due-moment driver wakes it at (wall-mapped) due moments only — an HTTP
 *   test drives a scheduled event through the full create/start path and
 *   watches it fire with no other engine work in between.
 * - The terms.read freshness floor (§8.5) is wired as an external due: with
 *   no dues of its own, a lazy sim still advances at least once per active
 *   agreement's minFreshnessSec of wall time; without an active floor it
 *   sleeps (sim time frozen, zero engine work).
 * - A lazy sim hibernates and resumes lazy (the scheduling mode rides the
 *   checkpoint envelope's createOptions).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from './db/database.js';
import { AgreementStore } from './db/agreement-store.js';
import { lazyFreshnessFloorSecForEnv } from './lazy-driver.js';
import { SimulationRegistry } from './simulation-registry.js';
import type { ScenarioDefinition } from '@active-collaboration/core';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Deterministic world: bounded zones with pinned baselines + a scheduled event at t=10. */
function lazyLabScenario(id: string, withEvent = true, withBinding = false) {
  return {
    version: '1.0',
    meta: { id, name: 'Lazy Lab', description: 'living-worlds P1 fixture' },
    zones: [
      {
        id: 'zone-a',
        name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        name: 'Sensor A',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
        ...(withBinding ? { binding: 'sim://temp-sensor-a' } : {}),
      },
    ],
    agents: [
      {
        id: 'lab-agent',
        name: 'Lab Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
    ],
    events: withEvent
      ? [
          {
            id: 'evt-lazy-due',
            type: 'temperature-spike',
            zoneId: 'zone-a',
            parameter: 'temperature',
            value: 33,
            atSimTimeSec: 10,
          },
        ]
      : [],
  };
}

/** Poll until the predicate holds (bounded) — real-timer driver tests. */
async function until(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe('living-worlds P1: lazy scheduling (server lifecycle)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...lazyLabScenario('lazy-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createSim(options: Record<string, unknown> = {}): Promise<{ id: string; body: Record<string, unknown> }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId, options },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json().id, body: res.json() };
  }

  async function start(simId: string): Promise<void> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: { speed: 1 },
    });
    expect(res.statusCode).toBe(200);
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

  it(
    'a lazy sim fires its scheduled event due-driven — no fixed-interval tick timer',
    { timeout: 20_000 },
    async () => {
      const { id, body } = await createSim({ scheduling: 'lazy' });
      expect(body.scheduling).toBe('lazy');
      await start(id);

      // The event at t=10 is ~100 wall-ms away at speed 1 × tickMs 10
      // (100 sim-s per wall-s). The driver wakes there and ONLY there.
      const advanced = await until(
        () => (ctx.app.simulations.get(id)!.runtime.getSimTimeSec() >= 10),
        10_000,
      );
      expect(advanced).toBe(true);
      await pause(id);

      const snap = await snapshot(id);
      expect(snap.simTimeSec).toBeGreaterThanOrEqual(10);
      const fired = (snap.scheduledEvents as Array<{ id: string; fired: boolean }>)
        .filter(event => event.fired).map(event => event.id);
      expect(fired).toEqual(['evt-lazy-due']); // exactly once, due-driven

      const list = await ctx.app.inject({
        method: 'GET',
        url: '/api/simulations',
        headers: auth(owner.token),
      });
      expect(list.json().simulations.find((s: { id: string }) => s.id === id).scheduling).toBe('lazy');
    },
  );

  it('the default stays tick (scheduling: "tick" in every response; behavior unchanged)', async () => {
    const { id, body } = await createSim();
    expect(body.scheduling).toBe('tick');
    await start(id);
    // A tick sim advances immediately (fixed-interval timer, no due needed).
    const advanced = await until(
      () => (ctx.app.simulations.get(id)!.runtime.getSimTimeSec() >= 1),
      5_000,
    );
    expect(advanced).toBe(true);
    await pause(id);
  });

  it('rejects unknown scheduling values with a teaching 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId, options: { scheduling: 'deferred' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(
      /options\.scheduling must be "tick" \| "lazy", got "deferred"/,
    );
  });

  it(
    'a lazy sim hibernates and resumes lazy (the mode rides the checkpoint envelope)',
    { timeout: 20_000 },
    async () => {
      const { id } = await createSim({ scheduling: 'lazy' });
      await start(id);
      await until(() => ctx.app.simulations.get(id)!.runtime.getSimTimeSec() >= 10, 10_000);
      await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${id}/pause`,
        headers: auth(owner.token),
        payload: {},
      });

      const hibernated = await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${id}/hibernate`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(hibernated.statusCode).toBe(200);
      expect(hibernated.json().state).toBe('hibernated');

      const resumed = await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${id}/resume`,
        headers: auth(owner.token),
        payload: {},
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().state).toBe('running');
      expect(resumed.json().simTimeSec).toBeGreaterThanOrEqual(10); // identity continues
      const record = ctx.app.simulations.get(id)!;
      expect(record.scheduling).toBe('lazy');
      expect(record.runtime.isLazyAdvance()).toBe(true);
      await pause(id);
    },
  );
});

// ---------------------------------------------------------------------------
// Freshness floor wiring (registry-direct, real timers)
// ---------------------------------------------------------------------------

describe('living-worlds P1: terms.read freshness floor as a lazy due source', () => {
  const tempDirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const dbs: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    // Close native SQLite handles — a leaked one can access-violate
    // (0xC0000005) at worker-thread teardown.
    for (const db of dbs.splice(0)) db.close();
  });

  function makeRegistry(freshness?: { floorSecForEnv(envId: string): number | undefined }): SimulationRegistry {
    const dir = mkdtempSync(join(tmpdir(), 'lazy-freshness-'));
    tempDirs.push(dir);
    const registry = new SimulationRegistry({}, dir, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, freshness);
    registries.push(registry);
    return registry;
  }

  it(
    'a lazy sim with an active floor advances even with no dues of its own; without one it sleeps',
    { timeout: 20_000 },
    async () => {
      // With a 0.4s floor: the driver wakes at least every 0.4s wall and
      // advances (rate 100 sim-s/s at speed 1 × tickMs 10 → ≥ 40 sim-s/wake).
      // The floor wires through the sim's ENVIRONMENT (terms.read agreements
      // are env concepts), so the create carries an environmentId.
      const withFloor = makeRegistry({ floorSecForEnv: () => 0.4 });
      const record = await withFloor.create(
        lazyLabScenario('lazy-floor', false, true) as unknown as ScenarioDefinition,
        { scheduling: 'lazy', tickMs: 10 },
        'env-floor',
      );
      record.runtime.start(1, { lazy: true });
      const advanced = await until(() => record.runtime.getSimTimeSec() >= 30, 10_000);
      expect(advanced).toBe(true);
      record.runtime.pause();

      // Without any due (no events, no flows) and no floor: the world sleeps.
      const noFloor = makeRegistry();
      const sleeper = await noFloor.create(
        lazyLabScenario('lazy-sleep', false, true) as unknown as ScenarioDefinition,
        { scheduling: 'lazy', tickMs: 10 },
      );
      const sleepStart = Date.now();
      sleeper.runtime.start(1, { lazy: true });
      // Class (b) negative window (R21 test-debt): proving the lazy world
      // does NO engine work between dues requires really letting 1500ms
      // (≈150 tick periods) pass; the elapsed remainder is measured, not a
      // re-guessed fixed sleep.
      while (Date.now() - sleepStart < 1500) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(sleeper.runtime.getSimTimeSec()).toBe(0); // no engine work between dues
      sleeper.runtime.pause();
    },
  );

  it('lazyFreshnessFloorSecForEnv: tightest active terms.read.minFreshnessSec wins', () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const store = new AgreementStore(db);
    // Minimal FK-valid parents (raw SQL — this test only exercises the
    // terms_json read path, not the agreement lifecycle).
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?), ('user-2', 'u2@t.test', 'x', 'U2', ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO environments (id, name, owner_id, visibility, created_at, updated_at)
       VALUES ('env-x', 'X', 'user-1', 'public', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_instances (id, env_id, owner_id, name, created_at)
       VALUES ('agent-1', 'env-x', 'user-2', 'Provider', ?)`,
    ).run(now);

    const base = {
      envId: 'env-x',
      consumerAgentId: null,
      consumerOwnerId: 'user-1',
      providerAgentId: 'agent-1',
      providerOwnerId: 'user-2',
    };
    const service = (n: number): { serviceId: string } => {
      const id = `svc-${n}`;
      db.prepare(
        `INSERT INTO service_instances (id, env_id, provider_agent_id, name, semantic_type, origin, created_at)
         VALUES (?, 'env-x', 'agent-1', ?, 'sensor', 'derived', ?)`,
      ).run(id, id, now);
      return { serviceId: id };
    };

    const floor = lazyFreshnessFloorSecForEnv(store);
    // No agreements → no floor.
    expect(floor('env-x')).toBeUndefined();
    // Non-active and read-less agreements carry no floor.
    store.createAgreement({ ...base, ...service(1), terms: {}, status: 'proposed' });
    store.createAgreement({ ...base, ...service(2), terms: { read: {} }, status: 'active' });
    expect(floor('env-x')).toBeUndefined();
    // The TIGHTEST active floor wins (5 vs 2 vs inactive 1).
    store.createAgreement({
      ...base, ...service(3), status: 'active',
      terms: { read: { minFreshnessSec: 5 } },
    });
    store.createAgreement({
      ...base, ...service(4), status: 'active',
      terms: { read: { minFreshnessSec: 2 } },
    });
    store.createAgreement({
      ...base, ...service(5), status: 'proposed',
      terms: { read: { minFreshnessSec: 1 } },
    });
    expect(floor('env-x')).toBe(2);
    // Another env is untouched.
    expect(floor('env-other')).toBeUndefined();
  });
});
