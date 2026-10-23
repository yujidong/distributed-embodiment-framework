/**
 * @vitest-environment node
 *
 * Fix-43e: instance scoping — MMO "副本" semantics for environment-backed
 * simulations. E2E 2026-08-15: a 971-zone campus cost 21s/tick (pre Fix-43b),
 * so 30 concurrent classroom sims were impossible; scoping a sim to its
 * author's claimed rooms (+ corridor) must cost like a standalone small world.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importScenarioAsEnvironment } from './environment-import.js';
import { environmentToScenario } from './environment-bridge.js';
import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

const CAMPUS = JSON.parse(readFileSync(
  resolve(__dirname, '../../../config/scenarios/campus-assumed.json'),
  'utf8',
)) as { zones: Array<{ id: string }>; devices: Array<{ id: string; zoneId: string }>; events: Array<{ zoneId: string }> };

/** Scenario devices → DB device rows (snake_case) for the bridge. */
function deviceRows(): Array<Record<string, unknown>> {
  return CAMPUS.devices.map(d => ({
    id: d.id,
    name: d.id,
    type: 'sensor',
    capabilities_json: JSON.stringify(['temperature-reading']),
    zone_id: d.zoneId,
    binding: null,
    initial_state_json: null,
  }));
}
function envRow(): Record<string, unknown> {
  return {
    id: 'env-scope', name: 'Scope Lab', description: '', owner_id: 'u1',
    visibility: 'private', map_type: 'grid', map_data_json: JSON.stringify(CAMPUS_TO_MAPDATA()),
    created_at: '', updated_at: '',
  };
}

describe('Fix-43e: instance scoping (environmentToScenario zoneIds)', () => {
  it('prunes zones/devices/events/adjacency/agent bindings to the scope', () => {
    const scope = ['tb1-classroom-f0-1', 'tb1-corridor-f0', 'dorm1-room-f0-1'];
    const scoped = environmentToScenario(
      // A minimal env row shape is enough for the grid path.
      envRow() as never,
      deviceRows() as never,
      [] as never,
      { zoneIds: scope },
    );
    expect(scoped.zones.map(z => z.id).sort()).toEqual([...scope].sort());
    // Adjacency filtered to in-scope neighbors only.
    const room = scoped.zones.find(z => z.id === 'tb1-classroom-f0-1')!;
    expect(room.adjacentZoneIds).toEqual(['tb1-corridor-f0']);
    // Devices outside the scope pruned.
    const zoneIds = new Set(scoped.devices.map(d => d.zoneId));
    for (const z of zoneIds) expect(scope).toContain(z);
    // Events filtered to the scope.
    const full = environmentToScenario(
      envRow() as never,
      deviceRows() as never,
      [] as never,
    );
    expect(full.events.length).toBeGreaterThan(scoped.events.length);
  });

  it('unknown zone in the scope → ApiError UNKNOWN_ZONE', () => {
    expect(() => environmentToScenario(
      envRow() as never,
      deviceRows() as never,
      [] as never,
      { zoneIds: ['no-such-zone'] },
    )).toThrowError(/UNKNOWN_ZONE|not in the environment/);
  });
});

function CAMPUS_TO_MAPDATA(): Record<string, unknown> {
  // Rebuild a grid mapData from the campus scenario zones (bounds/adjacency).
  const zoneById = new Map(CAMPUS.zones.map(z => [z.id, z]));
  return {
    zones: CAMPUS.zones.map(z => ({
      id: z.id,
      name: z.id,
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8 },
      adjacentZoneIds: (z as { adjacentZoneIds?: string[] }).adjacentZoneIds ?? [],
      floor: (z as { floor?: number }).floor,
      buildingId: (z as { buildingId?: string }).buildingId,
    })),
    events: CAMPUS.events.map((e, i) => ({ ...e, id: e.zoneId + '-evt-' + i })),
  };
}

describe('Fix-43e: instance scoping (API end-to-end parity)', () => {
  let ctx: TestAppContext;
  let owner: { token: string };

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('a 5-zone scoped sim on the 132-zone campus ≈ a standalone 5-zone world', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: CAMPUS,
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id;

    const scope = ['tb1-classroom-f0-1', 'tb1-classroom-f0-2', 'tb1-corridor-f0', 'dorm1-room-f0-1', 'lib1-reading-f0-1'];
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId, zoneIds: scope },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id;

    // The snapshot contains ONLY the scoped zones (the pruned world IS the sim).
    // T-015: by-id sim reads follow Fix-47 — read as the sim's creator.
    const snap = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/snapshot`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().zones.map((z: { id: string }) => z.id).sort()).toEqual([...scope].sort());
    // Stepping the scoped sim is cheap (the 132-zone full campus is ~2.5ms/tick
    // post Fix-43b; the scoped instance must be in the same league or better).
    const t0 = Date.now();
    const step = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      // Fix-47: lifecycle ops require the creator (or env owner/builder/admin).
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { n: 50 },
    });
    expect(step.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);

    // Unknown zone → 400 UNKNOWN_ZONE.
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId, zoneIds: ['nope'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('UNKNOWN_ZONE');

    // No scope → full world (legacy behavior).
    const full = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId },
    });
    const fullSnap = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${full.json().id}/snapshot`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(fullSnap.json().zones).toHaveLength(CAMPUS.zones.length);
  });
});

describe('Fix-43c: env detail includeServices=summary', () => {
  let ctx: TestAppContext;
  let owner: { token: string };
  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });
  afterEach(async () => { await ctx.cleanup(); });

  it('summary shrinks services to {total, visible}; full stays the array', async () => {
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` }, payload: CAMPUS,
    });
    const envId = created.json().id;
    const full = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(Array.isArray(full.json().services)).toBe(true);
    const summary = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}?includeServices=summary`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().services).toMatchObject({ total: full.json().services.length, visible: full.json().services.length });
    const bad = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}?includeServices=nope`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(bad.statusCode).toBe(400);
  });
});
