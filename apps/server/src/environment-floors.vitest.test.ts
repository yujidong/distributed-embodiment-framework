/**
 * @vitest-environment node
 *
 * Building tier (B-A) server tests: floor metadata survives the
 * scenario-import → map_data → scenario-bridge round trip.
 *
 * Covers:
 * - import: zone `buildingId`/`floor` and meta `storeyHeight`/
 *   `slabAttenuation` land in the environment's map data (and are served
 *   back on the environment detail);
 * - bridge: `environmentToScenario` hands the same fields back to the
 *   engine-facing ScenarioDefinition (adjacency symmetrized by the loader);
 * - update: mapData patches with floor metadata parse back intact.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environmentToScenario } from './environment-bridge.js';
import { parseMapData } from './db/environment-store.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

function buildingScenarioBody(): Record<string, unknown> {
  return {
    version: '1.0',
    meta: {
      id: 'floors-lab',
      name: 'Floors Lab',
      description: 'B-A import/bridge round trip',
      storeyHeight: 3,
      slabAttenuation: 0.2,
    },
    zones: [
      {
        id: 'room-f0',
        buildingId: 'main',
        floor: 0,
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 },
        adjacentZoneIds: ['shaft-f0'],
        baseline: { temperature: 26 },
      },
      { id: 'shaft-f0', buildingId: 'main', floor: 0, adjacentZoneIds: ['shaft-f1'] },
      { id: 'shaft-f1', buildingId: 'main', floor: 1 },
      {
        id: 'room-f1',
        buildingId: 'main',
        floor: 1,
        bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 },
      },
    ],
    devices: [
      {
        id: 'hvac-f0',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling'],
        zoneId: 'room-f0',
      },
    ],
    agents: [],
  };
}

describe('environment floor metadata (B-A)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('import bakes buildingId/floor + storeyHeight/slabAttenuation into map data', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: buildingScenarioBody(),
    });
    expect(created.statusCode).toBe(201);

    const detail = created.json();
    const zones = detail.zones as Array<Record<string, unknown>>;
    const byId = new Map(zones.map(zone => [zone.id as string, zone]));

    expect(byId.get('room-f0')).toMatchObject({ buildingId: 'main', floor: 0 });
    expect(byId.get('shaft-f1')).toMatchObject({ buildingId: 'main', floor: 1 });
    expect(detail.storeyHeight).toBe(3);

    // The stored map data carries the floor block (parseMapData view).
    const row = ctx.app.envStore.getEnvironment(detail.id as string)!;
    const mapData = parseMapData(row);
    expect(mapData.storeyHeight).toBe(3);
    expect(mapData.slabAttenuation).toBe(0.2);
    const storedById = new Map(mapData.zones.map(zone => [zone.id, zone]));
    expect(storedById.get('room-f0')).toMatchObject({ buildingId: 'main', floor: 0 });
    expect(storedById.get('room-f1')?.floor).toBe(1);
    // Adjacency was symmetrized at import (shaft-f1 ← shaft-f0 implied).
    expect(storedById.get('shaft-f1')?.adjacentZoneIds).toContain('shaft-f0');
  });

  it('bridge hands floor metadata back to the ScenarioDefinition', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: buildingScenarioBody(),
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

    const env = ctx.app.envStore.getEnvironment(envId)!;
    const scenario = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );

    expect(scenario.meta.storeyHeight).toBe(3);
    expect(scenario.meta.slabAttenuation).toBe(0.2);
    const byId = new Map(scenario.zones.map(zone => [zone.id, zone]));
    expect(byId.get('room-f0')).toMatchObject({ buildingId: 'main', floor: 0 });
    expect(byId.get('shaft-f1')).toMatchObject({ buildingId: 'main', floor: 1 });
    expect(byId.get('shaft-f1')!.adjacentZoneIds).toContain('shaft-f0');
    expect(byId.get('room-f0')!.baseline).toEqual({ temperature: 26 });
  });

  it('mapData update with floor metadata parses back intact', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Floor Patch Lab',
        mapData: { zones: [{ id: 'room', bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } }] },
      },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: {
        mapData: {
          storeyHeight: 4.2,
          zones: [
            { id: 'room', buildingId: 'main', floor: 2, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } },
          ],
        },
      },
    });
    expect(patched.statusCode).toBe(200);

    const mapData = parseMapData(ctx.app.envStore.getEnvironment(envId)!);
    expect(mapData.storeyHeight).toBe(4.2);
    expect(mapData.zones[0]).toMatchObject({ id: 'room', buildingId: 'main', floor: 2 });
  });
});
