/**
 * @vitest-environment node
 *
 * Fix-2 (RC-2) full-chain field-fidelity round trip.
 *
 * One fixture — config/scenarios/teaching-building.json — travels the whole
 * pipeline and is asserted at EVERY hop, so a field dropped in any layer
 * fails this file loudly:
 *
 *   scenario JSON ──▶ POST /api/environments (import → map_data)
 *                 ──▶ GET /api/environments/:id (detail view)
 *                 ──▶ environmentToScenario (bridge)
 *                 ──▶ POST /api/simulations {environmentId} (engine snapshot)
 *                 ──▶ scheduled occupancy/weather events fire with
 *                     observable effects (P1-2).
 *
 * Adding a zone/meta field to the core loader schema + MAP_META_FIELDS is
 * enough to carry it through every hop — the converters are spread
 * passthrough (env-map-conversion.ts), and this test pins the fixture's
 * full field set at each boundary.
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadScenarioFile, type ScenarioEvent } from '@active-collaboration/core';

import { environmentToScenario } from './environment-bridge.js';
import { parseMapData } from './db/environment-store.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

const FIXTURE_URL = new URL('../../../config/scenarios/teaching-building.json', import.meta.url);

function teachingBuilding(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as Record<string, unknown>;
}

interface RawFixtureZone {
  id: string;
  name?: string;
  type?: string;
  buildingId?: string;
  floor?: number;
  occupancy?: number;
  bounds?: Record<string, number>;
  baseline?: Record<string, number | boolean>;
  adjacentZoneIds?: string[];
  rooms?: Array<Record<string, string>>;
}

const FIXTURE_ZONES = (teachingBuilding().zones ?? []) as RawFixtureZone[];
const FIXTURE_EVENTS = (teachingBuilding().events ?? []) as Array<Record<string, unknown>>;

/** Fields every zone must keep across every hop (the fixture's field set). */
function expectZoneFidelity(actual: Record<string, unknown>, raw: RawFixtureZone, where: string) {
  expect(actual.id, where).toBe(raw.id);
  if (raw.name !== undefined) expect(actual.name, where).toBe(raw.name);
  if (raw.type !== undefined) expect(actual.type, where).toBe(raw.type);
  if (raw.buildingId !== undefined) expect(actual.buildingId, where).toBe(raw.buildingId);
  if (raw.floor !== undefined) expect(actual.floor, where).toBe(raw.floor);
  if (raw.occupancy !== undefined) expect(actual.occupancy, where).toBe(raw.occupancy);
  if (raw.bounds !== undefined) expect(actual.bounds, where).toEqual(raw.bounds);
  if (raw.baseline !== undefined) expect(actual.baseline, where).toEqual(raw.baseline);
  // R82: declarative rooms ride every hop verbatim (deep equality).
  if (raw.rooms !== undefined) expect(actual.rooms, where).toEqual(raw.rooms);
  const actualAdj = new Set((actual.adjacentZoneIds ?? []) as string[]);
  for (const declared of raw.adjacentZoneIds ?? []) {
    expect(actualAdj.has(declared), `${where}: adjacency ${raw.id}→${declared}`).toBe(true);
  }
}

function eventsById(events: Array<{ id: string }>): Map<string, unknown> {
  return new Map(events.map(event => [event.id, event]));
}

describe('teaching-building field fidelity (Fix-2 round trip)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let detail: Record<string, unknown>;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...teachingBuilding(), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    detail = created.json();
    envId = detail.id as string;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('import + detail view keep every zone field, map meta and all 19 events', () => {
    // Detail view (API wire shape).
    expect(detail.storeyHeight).toBe(3.5);
    const zones = detail.zones as Array<Record<string, unknown>>;
    expect(zones).toHaveLength(FIXTURE_ZONES.length);
    const byId = new Map(zones.map(zone => [zone.id as string, zone]));
    for (const raw of FIXTURE_ZONES) {
      const actual = byId.get(raw.id);
      expect(actual, `detail zone ${raw.id}`).toBeDefined();
      expectZoneFidelity(actual!, raw, `detail zone ${raw.id}`);
    }
    const events = detail.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(FIXTURE_EVENTS.length);
    const eventById = eventsById(events as Array<{ id: string }>);
    for (const raw of FIXTURE_EVENTS) {
      expect(eventById.get(raw.id as string), `detail event ${raw.id}`).toMatchObject(raw);
    }

    // Stored map data (parseMapData view) — the layer the bridge reads.
    const mapData = parseMapData(ctx.app.envStore.getEnvironment(envId)!);
    expect(mapData.storeyHeight).toBe(3.5);
    expect(mapData.events).toHaveLength(FIXTURE_EVENTS.length);
    const storedById = new Map(mapData.zones.map(zone => [zone.id, zone]));
    for (const raw of FIXTURE_ZONES) {
      expectZoneFidelity(
        storedById.get(raw.id) as unknown as Record<string, unknown>,
        raw,
        `mapData zone ${raw.id}`,
      );
    }
  });

  it('bridge reproduces the direct-loaded ScenarioDefinition', () => {
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const bridged = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );
    const direct = loadScenarioFile(teachingBuilding());

    expect(bridged.meta.storeyHeight).toBe(direct.meta.storeyHeight);
    const bridgedById = new Map(bridged.zones.map(zone => [zone.id, zone]));
    for (const zone of direct.zones) {
      const actual = bridgedById.get(zone.id);
      expect(actual, `bridged zone ${zone.id}`).toBeDefined();
      expect(actual).toMatchObject({
        ...(zone.name !== undefined ? { name: zone.name } : {}),
        ...(zone.type !== undefined ? { type: zone.type } : {}),
        ...(zone.buildingId !== undefined ? { buildingId: zone.buildingId } : {}),
        ...(zone.floor !== undefined ? { floor: zone.floor } : {}),
        ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
        ...(zone.bounds !== undefined ? { bounds: zone.bounds } : {}),
        ...(zone.baseline !== undefined ? { baseline: zone.baseline } : {}),
      });
      expect([...(actual!.adjacentZoneIds ?? [])].sort()).toEqual([...zone.adjacentZoneIds].sort());
    }
    // Events: same set, same payloads (order-independent).
    const byId = eventsById(bridged.events);
    expect(bridged.events).toHaveLength(direct.events.length);
    for (const event of direct.events) {
      expect(byId.get(event.id), `bridged event ${event.id}`).toEqual(event);
    }
  });

  it('simulation from the environment schedules all 19 events and seeds zone occupancy', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;

    const snapshot = (
      await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/snapshot` })
    ).json();
    expect(snapshot.scheduledEvents).toHaveLength(FIXTURE_EVENTS.length);
    expect(snapshot.scheduledEvents.every((e: { fired: boolean }) => !e.fired)).toBe(true);
    // Initial headcount is observable from the start (seeded from the zone).
    const classroom = snapshot.zones.find((z: { id: string }) => z.id === 'classroom-101');
    expect(classroom.occupancy).toBe(0);
  });

  it(
    'scheduled occupancy + weather events have observable effects (P1-2)',
    { timeout: 300_000 },
    async () => {
      const simId = (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/simulations',
          payload: { environmentId: envId },
        })
      ).json().id as string;
      const step = async (n: number) => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/simulations/${simId}/step`,
          payload: { n },
        });
        expect(res.statusCode).toBe(200);
        return res.json().simTimeSec as number;
      };
      const snapshot = async () =>
        (
          await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/snapshot` })
        ).json();

      // 1000 sim-seconds per tick: reach t=29000 (past the 8:00 = 28800 bell).
      await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/start`, payload: { speed: 1000 } });
      await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/pause` });

      expect(await step(29)).toBeGreaterThanOrEqual(28800);
      let snap = await snapshot();
      let classroom = snap.zones.find((z: { id: string }) => z.id === 'classroom-101');
      // 8:00 上课事件：教室里有人了 — occupancy observable in the snapshot.
      // (Scheduled events fire at the end of the tick that crosses their
      // schedule, so the headcount is visible immediately; the CO2 it
      // produces accumulates over the following ticks.)
      expect(classroom.occupancy).toBe(40);
      const fired = snap.scheduledEvents.find((e: { id: string }) => e.id === 'class-101-start');
      expect(fired.fired).toBe(true);

      // 40 人约 17 分钟：CO2 从 600 ppm baseline 明显上升。
      await step(1);
      snap = await snapshot();
      classroom = snap.zones.find((z: { id: string }) => z.id === 'classroom-101');
      expect(classroom.parameters.co2 as number).toBeGreaterThan(650);

      // Reach t=51000 (past the 14:00 = 50400 cold front).
      expect(await step(22)).toBeGreaterThanOrEqual(50400);
      snap = await snapshot();
      let outdoor = snap.zones.find((z: { id: string }) => z.id === 'outdoor');
      // 冷空气过境：outdoor 从 33°C baseline 降到 18°C 附近（baseline 通道）。
      expect(outdoor.parameters.temperature as number).toBeLessThan(20);

      // 持续生效：再推进 1 仿真小时，outdoor 仍停在 18°C 附近而非弹回 33°C。
      await step(4);
      snap = await snapshot();
      outdoor = snap.zones.find((z: { id: string }) => z.id === 'outdoor');
      expect(outdoor.parameters.temperature as number).toBeLessThan(20);
    },
  );
});

// ---------------------------------------------------------------------------
// T-021 (DevLoop R17, R10 EC-F07): agent `cannotDeliverClasses` (the medical
// scope-of-practice blocklist PartnerSelectionNegotiator consumes) and device
// `role` persist through the import bridge and every serialization hop.
// ---------------------------------------------------------------------------

describe('agent/device extras survive the import round trip (T-021)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function personalHealth(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(new URL('../../../config/scenarios/personal-health.json', import.meta.url), 'utf-8'),
    ) as Record<string, unknown>;
  }

  it('personal-health: the scope-of-practice blocklist survives import, bridge and replay export', async () => {
    const raw = personalHealth();
    const declared = new Map(
      ((raw.agents ?? []) as Array<{ id: string; cannotDeliverClasses?: string[] }>)
        .filter(agent => agent.cannotDeliverClasses !== undefined)
        .map(agent => [agent.id, agent.cannotDeliverClasses!]),
    );
    // The fixture declares the medical blocklist on both delivery agents.
    expect(declared.size).toBeGreaterThanOrEqual(2);

    // --- Import: the blocklist persists on the agent rows -------------------
    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...raw, visibility: 'public' },
    });
    expect(imported.statusCode).toBe(201);
    const envId = imported.json().id as string;

    const detailRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(detailRes.statusCode).toBe(200);
    const agents = detailRes.json().agents as Array<{
      id: string;
      name: string;
      cannotDeliverClasses?: string[];
    }>;
    const withBlocklist = agents.filter(agent => agent.cannotDeliverClasses !== undefined);
    expect(withBlocklist.length).toBe(declared.size);
    // Each imported agent's blocklist is one of the declared lists VERBATIM
    // (ids regenerate; the class lists must not).
    const declaredLists = [...declared.values()].map(list => JSON.stringify(list));
    for (const agent of withBlocklist) {
      expect(agent.cannotDeliverClasses!.length).toBeGreaterThan(0);
      expect(declaredLists).toContain(JSON.stringify(agent.cannotDeliverClasses));
    }
    // The flagship constraint is present: the community agent may not
    // deliver controlled substances.
    expect(
      withBlocklist.some(agent => agent.cannotDeliverClasses!.includes('controlled-substance-dispense')),
    ).toBe(true);

    // --- Bridge: the runtime-bound scenario carries the blocklist -----------
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const bridged = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );
    const bridgedWithBlocklist = bridged.agents.filter(
      agent => agent.cannotDeliverClasses !== undefined,
    );
    expect(bridgedWithBlocklist.length).toBe(declared.size);
    // And every bridged device carries an explicit loader-resolved role.
    for (const device of bridged.devices) {
      expect(['sensor', 'actuator', 'hybrid']).toContain(device.role);
    }

    // --- Export hop: replay re-emits both fields ----------------------------
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    const exportedAgents = (replay.json().scenario.agents ?? []) as Array<{
      cannotDeliverClasses?: string[];
    }>;
    expect(exportedAgents.filter(agent => agent.cannotDeliverClasses !== undefined).length)
      .toBe(declared.size);
    const exportedDevices = (replay.json().scenario.devices ?? []) as Array<{ role?: string }>;
    expect(exportedDevices.every(device => device.role !== undefined)).toBe(true);

    // --- Full round trip: re-import keeps the fields ------------------------
    const reimport = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: replay.json().scenario,
    });
    expect(reimport.statusCode).toBe(201);
    const reimportedDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${reimport.json().id}`,
      headers: auth(owner.token),
    });
    const reimportedAgents = reimportedDetail.json().agents as Array<{
      cannotDeliverClasses?: string[];
    }>;
    expect(
      reimportedAgents.filter(agent => agent.cannotDeliverClasses !== undefined).length,
    ).toBe(declared.size);
  });

  it('interactive PATCH can set and clear both fields (owner direct edit)', async () => {
    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...personalHealth(), visibility: 'public' },
    });
    expect(imported.statusCode).toBe(201);
    const envId = imported.json().id as string;
    const agentId = ((imported.json().agents ?? []) as Array<{ id: string; name: string }>)
      .find(agent => agent.name.includes('社区'))!.id;
    const deviceId = ((imported.json().devices ?? []) as Array<{ id: string; name: string }>)[0].id;

    // Set the blocklist + an explicit role…
    const patchedAgent = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { cannotDeliverClasses: ['narcotic-dispense'] },
    });
    expect(patchedAgent.statusCode).toBe(200);
    expect(patchedAgent.json().cannotDeliverClasses).toEqual(['narcotic-dispense']);

    const patchedDevice = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      headers: auth(owner.token),
      payload: { role: 'actuator' },
    });
    expect(patchedDevice.statusCode).toBe(200);
    expect(patchedDevice.json().role).toBe('actuator');

    // …and clear them again (null), plus a bad role is a teaching 400.
    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { cannotDeliverClasses: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().cannotDeliverClasses).toBeUndefined();

    const badRole = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      headers: auth(owner.token),
      payload: { role: 'robot' },
    });
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().error.message).toMatch(/sensor \| actuator \| hybrid/);
  });
});

// ---------------------------------------------------------------------------
// T-032 (DevLoop R17, R10 EC-F09): demo metadata (tagline / heroEventId /
// recommendedPlaybackRate / vendorDisclaimer) gets an env-level home in
// mapData.demo — it used to die at the template→env import, so the demo
// player only worked on the template catalog, never on imported envs.
// ---------------------------------------------------------------------------

describe('demo metadata survives the env lifecycle (T-032)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function shenzhen(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(new URL('../../../config/scenarios/shenzhen-resilience.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
  }

  it('template→env import keeps all four demo fields on the detail view and map data', async () => {
    const raw = shenzhen();
    const meta = raw.meta as Record<string, unknown>;
    expect(meta.tagline).toBeDefined();
    expect(typeof meta.heroEventId).toBe('string');
    expect(meta.heroEventId.length).toBeGreaterThan(0);
    expect(typeof meta.recommendedPlaybackRate).toBe('number');
    expect(meta.recommendedPlaybackRate).toBeGreaterThan(0);
    expect(meta.vendorDisclaimer).toBeDefined();

    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: raw,
    });
    expect(imported.statusCode).toBe(201);
    const envId = imported.json().id as string;

    // Detail view: the demo block is surfaced (null would be the EC-F09 bug).
    const demo = imported.json().demo;
    expect(demo).toEqual({
      tagline: meta.tagline,
      heroEventId: meta.heroEventId,
      recommendedPlaybackRate: meta.recommendedPlaybackRate,
      vendorDisclaimer: meta.vendorDisclaimer,
    });

    // Stored map data — the layer the bridge/export reads.
    const mapData = parseMapData(ctx.app.envStore.getEnvironment(envId)!);
    expect(mapData.demo).toEqual(demo);
  });

  it('bridge + replay export re-emit demo metadata, and re-import keeps it', async () => {
    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: shenzhen(),
    });
    expect(imported.statusCode).toBe(201);
    const envId = imported.json().id as string;

    // Bridge: the runtime-bound scenario meta carries the demo fields.
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const bridged = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );
    expect(bridged.meta.tagline).toEqual((shenzhen().meta as Record<string, unknown>).tagline);
    expect(bridged.meta.heroEventId).toBe(shenzhen().meta.heroEventId);
    expect(bridged.meta.recommendedPlaybackRate).toBe(shenzhen().meta.recommendedPlaybackRate);
    expect(bridged.meta.vendorDisclaimer).toBeDefined();

    // Replay export: the downloaded scenario embeds the demo fields back…
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    const exportedMeta = replay.json().scenario.meta;
    expect(exportedMeta.tagline).toEqual((shenzhen().meta as Record<string, unknown>).tagline);
    expect(exportedMeta.heroEventId).toBe(shenzhen().meta.heroEventId);
    expect(exportedMeta.recommendedPlaybackRate).toBe(shenzhen().meta.recommendedPlaybackRate);
    expect(exportedMeta.vendorDisclaimer).toBeDefined();

    // …so the demo player works on the RE-IMPORTED env too.
    const reimport = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: replay.json().scenario,
    });
    expect(reimport.statusCode).toBe(201);
    expect(reimport.json().demo).toEqual(imported.json().demo);
  });

  it('empty-world creation accepts mapData.demo; malformed shapes are teaching 400s', async () => {
    const demo = {
      tagline: { zh: '演示世界', en: 'Demo world' },
      heroEventId: 'evt-x',
      recommendedPlaybackRate: 2,
      vendorDisclaimer: { zh: '示例', en: 'illustrative' },
    };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'demo-world', mapData: { zones: [], demo } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().demo).toEqual(demo);

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'demo-world-2',
        mapData: { zones: [], demo: { tagline: 'plain string is not the {zh,en} shape' } },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/mapData\.demo\.tagline/);

    const badRate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${created.json().id}`,
      headers: auth(owner.token),
      payload: {
        mapData: { zones: [], demo: { recommendedPlaybackRate: -3 } },
      },
    });
    expect(badRate.statusCode).toBe(400);
    expect(badRate.json().error.message).toMatch(/recommendedPlaybackRate.*positive/);
  });
});
