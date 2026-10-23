/**
 * @vitest-environment node
 *
 * FEAT-07: env-level occupantSchedule PATCH — the runtime entry (no
 * environment rebuild).
 *
 *  - owner installs/updates/clears a zone's timetable; the write persists to
 *    map_data (the next materialize's truth) AND lands in the LIVE world
 *    session runtime through OccupantScheduleSync (appliedRuntimes reports
 *    the push honestly);
 *  - an in-window schedule corrects the live headcount immediately (the
 *    core seam's conservative catch-up; boundary firing itself is pinned by
 *    the core suite);
 *  - teaching validation: every malformed payload is a 400 spelling out the
 *    legal shape and ranges;
 *  - permissions: owner only (builder 403, anonymous 401); unknown zone 404
 *    naming the known ones.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineRuntime, ScenarioDefinition } from '@active-collaboration/core';

import { openDatabase, type EafDatabase } from './db/database.js';
import { EnvironmentStore } from './db/environment-store.js';
import { environmentToScenario } from './environment-bridge.js';
import { SimulationRegistry } from './simulation-registry.js';
import { OccupantScheduleSync } from './sim-registry/occupant-schedule-sync.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('FEAT-07: env occupantSchedule PATCH', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;
  let sessionSimId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder B' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('schedule-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    // R73: the authoritative world session auto-starts at env creation.
    sessionSimId = `sim-${envId}-world-session`;
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function patchSchedule(zoneId: string, token: string | undefined, schedule: unknown) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/zones/${zoneId}/occupant-schedule`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: { schedule },
    });
  }

  it('install lands in map_data AND the live runtime push is reported (no environment rebuild)', async () => {
    // Window [0, 86400) always covers the freshly started session's clock.
    const res = await patchSchedule('zone-a', owner.token, {
      count: 12,
      startSimTimeSec: 0,
      endSimTimeSec: 86400,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      envId,
      zoneId: 'zone-a',
      occupantSchedule: { count: 12, startSimTimeSec: 0, endSimTimeSec: 86400 },
      cleared: false,
      appliedRuntimes: 1,
    });

    // "No rebuild": the world's sim IDENTITY is unchanged (the session may
    // hot-reload from the env rows — same id, still registered; the live
    // in-place push itself is pinned by the registry-level suite below).
    const after = ctx.app.simulations.get(sessionSimId);
    expect(after).toBeDefined();
    expect(after!.id).toBe(sessionSimId);

    // Persisted: the detail view (map_data truth) carries the schedule.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zone = (detail.json().zones as Array<{ id: string; occupantSchedule?: unknown }>)
      .find(z => z.id === 'zone-a');
    expect(zone?.occupantSchedule).toEqual({ count: 12, startSimTimeSec: 0, endSimTimeSec: 86400 });
  });

  it('update replaces the timetable; clear drops it (response + map_data truth)', async () => {
    await patchSchedule('zone-a', owner.token, { count: 12, startSimTimeSec: 0, endSimTimeSec: 86400 });
    const updated = await patchSchedule('zone-a', owner.token, {
      count: 30,
      startSimTimeSec: 28800,
      endSimTimeSec: 64800,
      repeatDaily: false,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().occupantSchedule)
      .toEqual({ count: 30, startSimTimeSec: 28800, endSimTimeSec: 64800, repeatDaily: false });

    const cleared = await patchSchedule('zone-a', owner.token, null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ zoneId: 'zone-a', occupantSchedule: null, cleared: true });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zone = (detail.json().zones as Array<{ id: string; occupantSchedule?: unknown }>)
      .find(z => z.id === 'zone-a');
    expect(zone?.occupantSchedule).toBeUndefined();
  });

  it('teaching validation: malformed payloads are 400s that spell out the legal shape', async () => {
    const cases: Array<{ schedule: unknown; match: RegExp }> = [
      { schedule: { count: -1, startSimTimeSec: 0, endSimTimeSec: 100 }, match: /schedule\.count.*integer >= 0/ },
      { schedule: { count: 1.5, startSimTimeSec: 0, endSimTimeSec: 100 }, match: /schedule\.count.*integer >= 0/ },
      { schedule: { count: 5, startSimTimeSec: '08:00', endSimTimeSec: 100 }, match: /schedule\.startSimTimeSec.*28800 = 08:00/ },
      { schedule: { count: 5, startSimTimeSec: 0, endSimTimeSec: -3 }, match: /schedule\.endSimTimeSec.*number >= 0/ },
      { schedule: { count: 5, startSimTimeSec: 0, endSimTimeSec: 100, repeatDaily: 'yes' }, match: /schedule\.repeatDaily.*boolean/ },
      { schedule: { count: 5, startSimTimeSec: 0, endSimTimeSec: 100, foo: 1 }, match: /unknown field\(s\).*count, startSimTimeSec, endSimTimeSec, repeatDaily/ },
      { schedule: '8-18', match: /must be an object.*or null to clear/ },
    ];
    for (const { schedule, match } of cases) {
      const res = await patchSchedule('zone-a', owner.token, schedule);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
      expect(res.json().error.message).toMatch(match);
    }
    // Missing both timetable keys entirely.
    const missing = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/zones/zone-a/occupant-schedule`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toMatch(/must include "schedule" and\/or "overlay"/);
  });

  it('permissions: builder 403, anonymous 401; unknown zone 404 naming the known zones', async () => {
    const schedule = { count: 5, startSimTimeSec: 0, endSimTimeSec: 100 };
    const byBuilder = await patchSchedule('zone-a', builder.token, schedule);
    expect(byBuilder.statusCode).toBe(403);
    const anonymous = await patchSchedule('zone-a', undefined, schedule);
    expect(anonymous.statusCode).toBe(401);

    const unknown = await patchSchedule('nowhere', owner.token, schedule);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('UNKNOWN_ZONE');
    expect(unknown.json().error.message).toMatch(/zone-a, zone-b/);
  });
});

describe('FEAT-07 phase-2: env occupantSchedule OVERLAY PATCH', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let sessionSimId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('overlay-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    // R73: the authoritative world session auto-starts at env creation.
    sessionSimId = `sim-${envId}-world-session`;
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function patch(zoneId: string, token: string | undefined, body: unknown) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/zones/${zoneId}/occupant-schedule`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: body,
    });
  }

  const OVERLAY = {
    // Always-on overlay window covering the fresh session's clock (t≈0).
    schedule: { count: 40, startSimTimeSec: 0, endSimTimeSec: 86400 },
    startsAtSimSec: 0,
    endsAtSimSec: 7 * 86400,
  };

  it('overlay-only install lands in map_data AND the live runtime (headcount corrected in-window)', async () => {
    const res = await patch('zone-a', owner.token, { overlay: OVERLAY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      envId,
      zoneId: 'zone-a',
      occupantSchedule: null,
      occupantScheduleOverlay: OVERLAY,
      cleared: false,
      overlayCleared: false,
      appliedRuntimes: 1,
    });

    // Live runtime: the overlay governs NOW — scenario zone carries the
    // overlay and the in-window arrive corrected the headcount.
    const runtime = ctx.app.simulations.get(sessionSimId)!.runtime;
    expect(runtime.scenario.zones.find(z => z.id === 'zone-a')?.occupantScheduleOverlay).toEqual(OVERLAY);
    expect(runtime.getZoneOccupancy('zone-a')).toBe(40);

    // map_data truth: a future materialize picks the overlay up.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zone = (detail.json().zones as Array<{ id: string; occupantScheduleOverlay?: unknown }>)
      .find(z => z.id === 'zone-a');
    expect(zone?.occupantScheduleOverlay).toEqual(OVERLAY);
  });

  it('overlay: null clears it — live runtime reverts to the base timetable immediately', async () => {
    await patch('zone-a', owner.token, { schedule: { count: 5, startSimTimeSec: 0, endSimTimeSec: 86400 } });
    await patch('zone-a', owner.token, { overlay: OVERLAY });
    const runtime = ctx.app.simulations.get(sessionSimId)!.runtime;
    expect(runtime.getZoneOccupancy('zone-a')).toBe(40);

    const cleared = await patch('zone-a', owner.token, { overlay: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      zoneId: 'zone-a',
      occupantSchedule: { count: 5, startSimTimeSec: 0, endSimTimeSec: 86400 },
      occupantScheduleOverlay: null,
      overlayCleared: true,
    });
    // Base timetable governs again NOW (in-window arrive catch-up).
    expect(runtime.getZoneOccupancy('zone-a')).toBe(5);
    expect(runtime.scenario.zones.find(z => z.id === 'zone-a')?.occupantScheduleOverlay).toBeUndefined();

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zone = (detail.json().zones as Array<{ id: string; occupantScheduleOverlay?: unknown }>)
      .find(z => z.id === 'zone-a');
    expect(zone?.occupantScheduleOverlay).toBeUndefined();
  });

  it('teaching validation: overlay shape errors are 400, a degenerate window is 422', async () => {
    const badWindow = await patch('zone-a', owner.token, {
      overlay: { schedule: { count: 1, startSimTimeSec: 0, endSimTimeSec: 100 }, startsAtSimSec: 500, endsAtSimSec: 500 },
    });
    expect(badWindow.statusCode).toBe(422);
    expect(badWindow.json().error.code).toBe('OCCUPANT_OVERLAY_WINDOW_INVALID');
    expect(badWindow.json().error.message).toMatch(/endsAtSimSec \(500\) must exceed startsAtSimSec \(500\)/);

    const cases: Array<{ body: unknown; match: RegExp }> = [
      { body: { overlay: 'exam-week' }, match: /"overlay" must be an object.*or null to clear/ },
      { body: { overlay: { ...OVERLAY, foo: 1 } }, match: /"overlay" has unknown field\(s\).*schedule, startsAtSimSec, endsAtSimSec/ },
      { body: { overlay: { ...OVERLAY, schedule: { count: -1, startSimTimeSec: 0, endSimTimeSec: 100 } } }, match: /"overlay\.schedule\.count".*integer >= 0/ },
      { body: { overlay: { ...OVERLAY, startsAtSimSec: 'next monday' } }, match: /"overlay\.startsAtSimSec".*ABSOLUTE sim-time second/ },
    ];
    for (const { body, match } of cases) {
      const res = await patch('zone-a', owner.token, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
      expect(res.json().error.message).toMatch(match);
    }
  });
});

describe('FEAT-07: OccupantScheduleSync live-set hygiene', () => {
  it('no live runtimes → 0 applied; stopped runtimes are dropped', () => {
    const sync = new OccupantScheduleSync();
    expect(sync.applyZoneSchedule('env-x', 'zone-a', { count: 1, startSimTimeSec: 0, endSimTimeSec: 10 })).toBe(0);

    const stopped = {
      getState: () => 'stopped',
    } as unknown as EngineRuntime;
    sync.attach('env-x', stopped);
    expect(sync.applyZoneSchedule('env-x', 'zone-a', { count: 1, startSimTimeSec: 0, endSimTimeSec: 10 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: a real env-backed runtime takes the patch IN PLACE (no
// rebuild — the record identity is held across the push).
// ---------------------------------------------------------------------------

describe('FEAT-07: OccupantScheduleSync — env-backed runtime integration', () => {
  const registries: SimulationRegistry[] = [];
  const dbs: EafDatabase[] = [];

  afterEach(() => {
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const db of dbs.splice(0)) db.close();
  });

  function itScenario(): ScenarioDefinition {
    return {
      version: '1.0',
      meta: { id: 'schedule-sync-it', name: 'Schedule Sync IT' },
      zones: [
        {
          id: 'zone-a',
          name: 'Zone A',
          bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
          baseline: { temperature: 22 },
        },
      ],
      devices: [],
      agents: [],
      events: [],
    } as unknown as ScenarioDefinition;
  }

  it('the patch lands in the LIVE runtime in place; clear leaves the headcount untouched', async () => {

    const db = openDatabase(':memory:');
    dbs.push(db);
    const envStore = new EnvironmentStore(db);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
    ).run(new Date().toISOString());
    const env = envStore.createEnvironment({ name: 'World', ownerId: 'user-1' });

    const sync = new OccupantScheduleSync();
    const registry = new SimulationRegistry(
      {}, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, sync,
    );
    registries.push(registry);

    const record = await registry.create(itScenario(), {}, env.id);
    // Window [0, 86400) covers the fresh runtime's clock → in-window arrive
    // corrects the headcount immediately.
    const applied = sync.applyZoneSchedule(env.id, 'zone-a', {
      count: 9,
      startSimTimeSec: 0,
      endSimTimeSec: 86400,
    });
    expect(applied).toBe(1);
    expect(record.runtime.scenario.zones[0]?.occupantSchedule)
      .toEqual({ count: 9, startSimTimeSec: 0, endSimTimeSec: 86400 });
    expect(record.runtime.getZoneOccupancy('zone-a')).toBe(9);

    const cleared = sync.applyZoneSchedule(env.id, 'zone-a', null);
    expect(cleared).toBe(1);
    expect(record.runtime.scenario.zones[0]?.occupantSchedule).toBeUndefined();
    // Clearing is not an eviction — the standing headcount is the world's.
    expect(record.runtime.getZoneOccupancy('zone-a')).toBe(9);
  });

  it('FEAT-07 phase-2: a rebuilt session picks the overlay up from map_data and its window governs', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const envStore = new EnvironmentStore(db);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
    ).run(new Date().toISOString());
    const env = envStore.createEnvironment({ name: 'World', ownerId: 'user-1' });

    // What the PATCH route persists: base timetable + a calendar overlay
    // (exam-week hours) in map_data.
    const overlay = {
      schedule: { count: 40, startSimTimeSec: 0, endSimTimeSec: 86400 },
      startsAtSimSec: 0,
      endsAtSimSec: 7 * 86400,
    };
    const updated = envStore.updateEnvironment(env.id, {
      mapData: {
        zones: [
          {
            id: 'zone-a',
            name: 'Zone A',
            bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
            baseline: { temperature: 22 },
            occupantSchedule: { count: 5, startSimTimeSec: 28800, endSimTimeSec: 64800 },
            occupantScheduleOverlay: overlay,
          },
        ],
      },
    });

    // The bridge (next materialize's truth) carries the overlay verbatim…
    const bridged = environmentToScenario(updated, [], []);
    expect(bridged.zones[0]?.occupantScheduleOverlay).toEqual(overlay);

    // …and a freshly built env-backed runtime is governed by it (the window
    // covers t=0 → the overlay arrive fires on the first ticks).
    const sync = new OccupantScheduleSync();
    const registry = new SimulationRegistry(
      {}, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, sync,
    );
    registries.push(registry);
    const record = await registry.create(bridged, {}, env.id);
    expect(record.runtime.scenario.zones[0]?.occupantScheduleOverlay).toEqual(overlay);
    await record.runtime.step(2);
    expect(record.runtime.getZoneOccupancy('zone-a')).toBe(40);
  });
});
