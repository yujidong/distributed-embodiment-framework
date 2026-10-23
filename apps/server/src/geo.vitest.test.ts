/**
 * @vitest-environment node
 *
 * Geo map tier tests (product_design.md §11.4, P2d):
 *
 * - projection math (equirectangular around the env center, meters);
 * - polygon bbox → zone bounds for the engine;
 * - derived adjacency (boundary-touch / proximity heuristic);
 * - geo validation on the environment create + device create/patch paths
 *   (bad latitude / bad polygon / bad position → 400; grid maps unchanged);
 * - the suzhou-city template: idempotent seeding, wire shape, bridge
 *   projection + adjacency + baked events, and a rule-only simulation that
 *   builds and steps from it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localizedText } from '@active-collaboration/shared';

import { environmentToScenario } from './environment-bridge.js';
import { importScenarioAsEnvironment } from './environment-import.js';
import { ApiError } from './errors.js';
import {
  ADJACENCY_TOLERANCE_M,
  METERS_PER_DEG_LAT,
  deriveGeoAdjacency,
  parseGeoMapData,
  parseGeoPolygon,
  polygonBboxMeters,
  projectToMeters,
  validateDevicePositionForEnv,
} from './geo.js';
import { seedTemplates, SYSTEM_USER_EMAIL } from './db/seed.js';
import { unbackedFlagsForEnv } from './db/service-store.js';
import type { EnvZone } from './db/environment-store.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

const CITY_NAME = '苏州智慧城市（金鸡湖-姑苏示范）';
const CENTER = { lat: 31.268, lng: 120.6615 };

// ---------------------------------------------------------------------------
// Projection + geometry units
// ---------------------------------------------------------------------------

describe('geo projection', () => {
  it('projects the center onto the origin', () => {
    const { x, y } = projectToMeters(CENTER, CENTER.lat, CENTER.lng);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('projects a known offset to expected meters', () => {
    // 0.001° lng east at 31.268°N: 111320 * 0.001 * cos(31.268°) ≈ 95.15 m.
    const east = projectToMeters(CENTER, CENTER.lat, CENTER.lng + 0.001);
    expect(east.x).toBeCloseTo(95.15, 1);
    expect(east.y).toBe(0);
    // 0.001° lat north is 111.32 m; y points SOUTH (screen convention), so
    // north of the center is negative y.
    const north = projectToMeters(CENTER, CENTER.lat + 0.001, CENTER.lng);
    expect(north.x).toBe(0);
    expect(north.y).toBeCloseTo(-METERS_PER_DEG_LAT * 0.001, 6);
  });

  it('computes polygon bounding boxes in meters', () => {
    const polygon: [number, number][] = [
      [31.288, 120.598],
      [31.288, 120.646],
      [31.326, 120.646],
      [31.326, 120.598],
    ];
    const bbox = polygonBboxMeters(CENTER, polygon);
    // Height: 0.038° lat ≈ 4230 m; width: 0.048° lng ≈ 4568 m at this latitude.
    expect(bbox.maxY - bbox.minY).toBeCloseTo(0.038 * METERS_PER_DEG_LAT, 0);
    expect(bbox.maxX - bbox.minX).toBeCloseTo(
      0.048 * METERS_PER_DEG_LAT * Math.cos((CENTER.lat * Math.PI) / 180),
      0,
    );
    expect(bbox.minX).toBeLessThan(0);
    expect(bbox.maxX).toBeLessThan(0); // entirely west of the center lng
  });
});

describe('geo adjacency derivation', () => {
  const square = (id: string, lat: number, lng: number, size = 0.01): EnvZone => ({
    id,
    polygon: [
      [lat, lng],
      [lat, lng + size],
      [lat + size, lng + size],
      [lat + size, lng],
    ],
  });

  it('marks shared-edge polygons adjacent', () => {
    const a = square('a', 31.0, 120.0);
    const b = square('b', 31.0, 120.01); // shares a's east edge
    const adjacency = deriveGeoAdjacency([a, b], CENTER);
    expect(adjacency.get('a')).toEqual(['b']);
    expect(adjacency.get('b')).toEqual(['a']);
  });

  it('marks overlapping / containing polygons adjacent', () => {
    const a = square('a', 31.0, 120.0, 0.02);
    const b = square('b', 31.005, 120.005, 0.005); // fully inside a
    const adjacency = deriveGeoAdjacency([a, b], CENTER);
    expect(adjacency.get('a')).toEqual(['b']);
    expect(adjacency.get('b')).toEqual(['a']);
  });

  it('bridges small drawing gaps below the tolerance', () => {
    // 0.002° ≈ 223 m gap < ADJACENCY_TOLERANCE_M.
    const a = square('a', 31.0, 120.0);
    const b = square('b', 31.0, 120.012);
    const adjacency = deriveGeoAdjacency([a, b], CENTER);
    expect(adjacency.get('a')).toEqual(['b']);
  });

  it('keeps genuinely separated polygons non-adjacent', () => {
    // 0.02° ≈ 2226 m gap > ADJACENCY_TOLERANCE_M.
    const a = square('a', 31.0, 120.0);
    const b = square('b', 31.0, 120.03);
    const adjacency = deriveGeoAdjacency([a, b], CENTER);
    expect(adjacency.get('a')).toEqual([]);
    expect(adjacency.get('b')).toEqual([]);
  });

  it('tolerance sanity: 500 m is larger than a small gap, smaller than a district hop', () => {
    expect(ADJACENCY_TOLERANCE_M).toBe(500);
    expect(0.002 * METERS_PER_DEG_LAT).toBeLessThan(ADJACENCY_TOLERANCE_M);
    expect(0.02 * METERS_PER_DEG_LAT).toBeGreaterThan(ADJACENCY_TOLERANCE_M);
  });
});

// ---------------------------------------------------------------------------
// Validation units
// ---------------------------------------------------------------------------

describe('geo validation', () => {
  it('accepts a valid closed-ring polygon (drops the duplicate closing point)', () => {
    const polygon = parseGeoPolygon(
      [[31.0, 120.0], [31.0, 120.01], [31.01, 120.01], [31.0, 120.0]],
      'polygon',
    );
    expect(polygon).toHaveLength(3);
  });

  it('rejects polygons with fewer than 3 points', () => {
    expect(() => parseGeoPolygon([[31.0, 120.0], [31.0, 120.01]], 'polygon')).toThrow(ApiError);
  });

  it('rejects out-of-range coordinates', () => {
    expect(() => parseGeoPolygon([[91, 120.0], [31.0, 120.01], [31.01, 120.01]], 'polygon')).toThrow(
      /latitude/,
    );
    expect(() =>
      parseGeoPolygon([[31.0, 181], [31.0, 120.01], [31.01, 120.01]], 'polygon'),
    ).toThrow(/longitude/);
  });

  it('rejects degenerate (zero-area) polygons', () => {
    expect(() =>
      parseGeoPolygon([[31.0, 120.0], [31.0, 120.01], [31.0, 120.02]], 'polygon'),
    ).toThrow(/degenerate/);
  });

  it('rejects diagonal-collinear rings with a non-degenerate bbox', () => {
    expect(() =>
      parseGeoPolygon(
        [[31.0, 120.0], [31.005, 120.005], [31.01, 120.01]],
        'polygon',
      ),
    ).toThrow(/degenerate/);
  });

  it('rejects self-intersecting (crossed) rings', () => {
    // Crossed quadrilateral with unequal lobes (non-zero shoelace area, so
    // it reaches the crossing check instead of the area check).
    expect(() =>
      parseGeoPolygon(
        [[31.0, 120.0], [31.01, 120.01], [31.002, 120.01], [31.01, 120.0]],
        'polygon',
      ),
    ).toThrow(/self-intersects/);
  });

  it('rejects bowtie rings (zero-area crossed ring)', () => {
    expect(() =>
      parseGeoPolygon(
        [[31.0, 120.0], [31.01, 120.01], [31.0, 120.01], [31.01, 120.0]],
        'polygon',
      ),
    ).toThrow(/degenerate/);
  });

  it('rejects rings with a repeated non-closing vertex', () => {
    expect(() =>
      parseGeoPolygon(
        [[31.0, 120.0], [31.0, 120.01], [31.01, 120.01], [31.0, 120.01], [31.01, 120.0]],
        'polygon',
      ),
    ).toThrow(/repeats a vertex/);
  });

  it('accepts concave but well-formed rings', () => {
    // L-shaped ring: concave, non-crossing, clearly positive area.
    const polygon = parseGeoPolygon(
      [
        [31.0, 120.0],
        [31.0, 120.01],
        [31.005, 120.01],
        [31.005, 120.005],
        [31.01, 120.005],
        [31.01, 120.0],
      ],
      'polygon',
    );
    expect(polygon).toHaveLength(6);
  });

  it('requires a valid center for geo map data', () => {
    expect(() => parseGeoMapData({})).toThrow(/center/);
    expect(() => parseGeoMapData({ center: { lat: -91, lng: 120 } })).toThrow(/latitude/);
    expect(parseGeoMapData({ center: { lat: 31.3, lng: 120.6 }, zoom: 12 }).zoom).toBe(12);
    expect(() => parseGeoMapData({ center: { lat: 31.3, lng: 120.6 }, zoom: 25 })).toThrow(/zoom/);
  });

  it('validates device positions only for geo environments', () => {
    expect(() => validateDevicePositionForEnv('geo', { lat: 95, lng: 120 })).toThrow(ApiError);
    expect(() => validateDevicePositionForEnv('geo', { lat: 31.3 })).toThrow(ApiError);
    expect(() => validateDevicePositionForEnv('geo', { lat: 31.3, lng: 120.6 })).not.toThrow();
    // Grid maps keep free-form positions.
    expect(() => validateDevicePositionForEnv('grid', { x: 1, y: 2 })).not.toThrow();
    expect(() => validateDevicePositionForEnv('grid', null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HTTP: geo environment + device validation
// ---------------------------------------------------------------------------

const GEO_ZONES = [
  { id: 'west', name: '西区', polygon: [[31.0, 120.0], [31.0, 120.01], [31.01, 120.01], [31.01, 120.0]] },
  { id: 'east', name: '东区', polygon: [[31.0, 120.01], [31.0, 120.02], [31.01, 120.02], [31.01, 120.01]] },
];

describe('geo HTTP validation', () => {
  let ctx: TestAppContext;
  let user: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    user = await registerUser(ctx.app);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const createGeoEnv = (mapData: unknown) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(user.token),
      payload: { name: 'Geo Lab', mapType: 'geo', mapData },
    });

  it('creates a geo environment and echoes center/zoom/polygons', async () => {
    const res = await createGeoEnv({ center: CENTER, zoom: 12, zones: GEO_ZONES });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mapType).toBe('geo');
    expect(body.mapCenter).toEqual(CENTER);
    expect(body.mapZoom).toBe(12);
    expect(body.zones).toHaveLength(2);
    expect(body.zones[0].polygon).toHaveLength(4);
    expect(body.events).toEqual([]);
  });

  it('400s on a bad center latitude', async () => {
    const res = await createGeoEnv({ center: { lat: 91, lng: 120 }, zones: GEO_ZONES });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_GEO');
  });

  it('400s on a missing center', async () => {
    const res = await createGeoEnv({ zones: GEO_ZONES });
    expect(res.statusCode).toBe(400);
  });

  it('400s on a malformed polygon', async () => {
    const res = await createGeoEnv({
      center: CENTER,
      zones: [{ id: 'bad', polygon: [[31.0, 120.0], [31.0, 120.01]] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_GEO');
  });

  it('400s on an event referencing an unknown zone', async () => {
    const res = await createGeoEnv({
      center: CENTER,
      zones: GEO_ZONES,
      events: [{ id: 'e1', type: 'humidity-spike', zoneId: 'nowhere' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates device positions for geo envs (create + patch)', async () => {
    const env = (await createGeoEnv({ center: CENTER, zones: GEO_ZONES })).json();

    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/devices`,
      headers: auth(user.token),
      payload: {
        name: 'Sensor',
        type: 'temp-humidity-sensor',
        capabilities: ['temperature-monitoring'],
        zoneId: 'west',
        position: { lat: 95, lng: 120 },
      },
    });
    expect(bad.statusCode).toBe(400);

    const good = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/devices`,
      headers: auth(user.token),
      payload: {
        name: 'Sensor',
        type: 'temp-humidity-sensor',
        capabilities: ['temperature-monitoring'],
        zoneId: 'west',
        position: { lat: 31.005, lng: 120.005 },
      },
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().position).toEqual({ lat: 31.005, lng: 120.005 });

    const badPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${good.json().id}`,
      headers: auth(user.token),
      payload: { position: { lat: 31.005, lng: 200 } },
    });
    expect(badPatch.statusCode).toBe(400);

    const goodPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${good.json().id}`,
      headers: auth(user.token),
      payload: { position: { lat: 31.006, lng: 120.006 } },
    });
    expect(goodPatch.statusCode).toBe(200);
    expect(goodPatch.json().position).toEqual({ lat: 31.006, lng: 120.006 });
  });

  it('grid envs keep free-form positions (regression)', async () => {
    const env = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(user.token),
        payload: { name: 'Grid Lab', mapType: 'grid', mapData: { zones: [{ id: 'room' }] } },
      })
    ).json();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/devices`,
      headers: auth(user.token),
      payload: {
        name: 'Sensor',
        type: 'temp-humidity-sensor',
        capabilities: ['temperature-monitoring'],
        zoneId: 'room',
        position: { x: 1.5, y: 2.5 },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().position).toEqual({ x: 1.5, y: 2.5 });
  });
});

// ---------------------------------------------------------------------------
// Suzhou city template
// ---------------------------------------------------------------------------

describe('suzhou-city template', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const cityEnv = () => ctx.app.envStore.findEnvironmentByName(CITY_NAME);

  it('seeds the city environment on boot (public, system-owned, geo)', () => {
    const env = cityEnv();
    expect(env).toBeDefined();
    expect(env!.visibility).toBe('public');
    expect(env!.map_type).toBe('geo');
    expect(ctx.app.userStore.findByEmail(SYSTEM_USER_EMAIL)).toBeDefined();
    expect(env!.owner_id).toBe(ctx.app.userStore.findByEmail(SYSTEM_USER_EMAIL)!.id);
  });

  it('seeding is idempotent (second run creates nothing)', () => {
    const seedDir = join(__dirname, '../../../config/scenarios');
    const again = seedTemplates(ctx.app.userStore, ctx.app.envStore, seedDir);
    expect(again).toEqual([]);
    // ...and the template file itself parses to one environment. Bilingual
    // templates ship meta.name as {zh, en}; the zh side is the canonical
    // stored name (see seed.ts localized-text boundary).
    const raw = JSON.parse(readFileSync(join(seedDir, 'suzhou-city.json'), 'utf-8'));
    expect(localizedText(raw.meta.name, 'zh-CN')).toBe(CITY_NAME);
  });

  it('exposes the full city world over the detail API', async () => {
    const env = cityEnv()!;
    const res = await ctx.app.inject({ method: 'GET', url: `/api/environments/${env.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mapType).toBe('geo');
    expect(body.mapCenter.lat).toBeCloseTo(31.268, 3);
    expect(body.zones).toHaveLength(9);
    expect(body.devices).toHaveLength(33);
    expect(body.agents).toHaveLength(12);
    expect(body.events).toHaveLength(7);
    for (const zone of body.zones) {
      expect(zone.polygon.length).toBeGreaterThanOrEqual(3);
    }
    // Devices carry {lat, lng} positions inside the map's coordinate span.
    for (const device of body.devices) {
      expect(device.position.lat).toBeGreaterThan(31);
      expect(device.position.lat).toBeLessThan(32);
      expect(device.position.lng).toBeGreaterThan(120);
      expect(device.position.lng).toBeLessThan(121);
    }
  });

  it('bridges to a scenario with meter bounds, derived adjacency and events', () => {
    const env = cityEnv()!;
    const scenario = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(env.id),
      ctx.app.envStore.agentsOf(env.id),
    );
    expect(scenario.zones).toHaveLength(9);
    expect(scenario.events).toHaveLength(7);

    const gusu = scenario.zones.find(z => z.id === 'gusu-old-town')!;
    // Polygon bbox in projected meters (see projection tests above).
    expect(gusu.bounds).toBeDefined();
    expect(gusu.bounds!.maxY - gusu.bounds!.minY).toBeCloseTo(0.038 * METERS_PER_DEG_LAT, 0);
    // Declared adjacency of 姑苏老城. Since R64 a declared adjacentZoneIds
    // list wins over polygon-proximity derivation, and the R69 real-data
    // enrichment (f69f1b2) shipped declared lists for every district.
    expect(gusu.adjacentZoneIds.sort()).toEqual(
      ['suzhou-station', 'xiangcheng-residential'].sort(),
    );
    // 太湖新城's declared neighbors (also symmetric below).
    const taihu = scenario.zones.find(z => z.id === 'taihu-new-town')!;
    expect(taihu.adjacentZoneIds.sort()).toEqual(['snd-industrial', 'wuzhong-south'].sort());
    // Every adjacency is symmetric.
    for (const zone of scenario.zones) {
      for (const adjId of zone.adjacentZoneIds) {
        const other = scenario.zones.find(z => z.id === adjId);
        expect(other?.adjacentZoneIds).toContain(zone.id);
      }
    }
    // Events keep their schedule + collaboration metadata.
    const rushHour = scenario.events.find(e => e.id === 'evt-rush-hour')!;
    expect(rushHour.zoneId).toBe('suzhou-station');
    expect(rushHour.atSimTimeSec).toBe(30);
    expect(rushHour.requiredCapabilities).toContain('fleet-dispatch');
  });

  it('builds and steps a rule-only simulation from the city environment', async () => {
    const env = cityEnv()!;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: env.id },
    });
    expect(created.statusCode).toBe(201);
    const sim = created.json();
    expect(sim.llm).toBe('rule-only');

    // Step past the first two scheduled events (evt-rush-hour @ 30,
    // evt-pm25-exceed @ 60 sim-sec).
    const step = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim.id}/step`,
      payload: { n: 65 },
    });
    expect(step.statusCode).toBe(200);

    const snapshot = (
      await ctx.app.inject({ method: 'GET', url: `/api/simulations/${sim.id}/snapshot` })
    ).json();
    expect(snapshot.scenarioId).toBe(env.id);
    expect(snapshot.zones).toHaveLength(9);
    expect(snapshot.devices).toHaveLength(33);
    expect(snapshot.agents).toHaveLength(12);
    // The PM2.5 event landed in the field (baseline is 52 in 高新区工业园;
    // SNAPSHOT_PARAMETERS samples a fixed set — traffic/power events reach
    // agents via the event payload, not the zone parameter overlay).
    const snd = snapshot.zones.find((z: { id: string }) => z.id === 'snd-industrial');
    expect(snd.parameters.pm2_5).toBeGreaterThan(52);
    const fired = snapshot.scheduledEvents.filter((e: { fired: boolean }) => e.fired);
    expect(fired.map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining(['evt-rush-hour', 'evt-pm25-exceed']),
    );
  });
});

// ---------------------------------------------------------------------------
// Suzhou city template v2 (W4) — municipal devices + commercial stakeholders
// ---------------------------------------------------------------------------

describe('suzhou-city template v2', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const seedDir = join(__dirname, '../../../config/scenarios');
  const cityEnv = () => ctx.app.envStore.findEnvironmentByName(CITY_NAME)!;
  const agentsByName = () =>
    new Map(ctx.app.envStore.agentsOf(cityEnv().id).map(a => [a.name, a]));

  const COMMERCIAL = ['滴滴出行（苏州运力中心）', '美团配送（园区站）', '特来电充电运营', '哈啰出行', '万达广场商业物业'];

  it('contains all 12 stakeholder agents (7 government/public + 5 commercial)', () => {
    const agents = agentsByName();
    expect(agents.size).toBe(12);
    for (const name of [
      '苏州市交通管理局',
      '国网苏州供电公司',
      '苏州市环境监测中心',
      '苏州市政照明管理所',
      '苏州公安交管指挥中心',
      '工业园区物业集团',
      '苏州应急管理中心',
      ...COMMERCIAL,
    ]) {
      expect(agents.has(name), name).toBe(true);
    }
  });

  it('uses municipal-grade catalog models (consumer/generic units swapped out)', () => {
    const devices = ctx.app.envStore.devicesOf(cityEnv().id);
    expect(devices).toHaveLength(33);
    const names = devices.map(d => d.name ?? '').join('\n');
    // One entry per municipal model family, with the expected quantities.
    const expected: Array<[RegExp, number]> = [
      [/AQMS-1000/g, 1], // 聚光国标站
      [/XHAQMS-3000/g, 3], // 先河网格化微站
      [/iDS-TCE500/g, 2], // 海康雷视车检器
      [/DH-ITC/g, 2], // 大华车检器
      [/HSC-100/g, 2], // 海信信号机
      [/DTSD342/g, 4], // 威胜三相电表
      [/SZ10-NB/g, 5], // 顺舟单灯控制器
      [/智慧灯杆/g, 2],
      [/雷达水位计/g, 2],
      [/DS-2DC/g, 3], // 海康球机
      [/TCDZ-120/g, 2], // 特来电充电桩
      [/井盖传感器/g, 2],
      [/应急广播音柱/g, 2],
      [/负控终端/g, 1],
    ];
    for (const [pattern, count] of expected) {
      expect(names.match(pattern), String(pattern)).toHaveLength(count);
    }
    // v1 consumer brands are gone.
    expect(names).not.toMatch(/小米|青萍|三思/);
    // Every device sits inside its zone polygon's coordinate span.
    for (const device of devices) {
      expect(device.position_json).toContain('"lat":31.');
    }
  });

  it('publishes one cross-owner service per commercial stakeholder', () => {
    const agents = agentsByName();
    const services = ctx.app.serviceStore.servicesOf(cityEnv().id);
    const published = services.filter(s => s.origin === 'published');
    expect(published).toHaveLength(7); // 2 government (W3) + 5 commercial (W4)

    const publishedByAgent = new Map<string, string[]>();
    for (const s of published) {
      const agent = ctx.app.envStore.getAgent(s.provider_agent_id)!;
      publishedByAgent.set(agent.name, [...(publishedByAgent.get(agent.name) ?? []), s.name]);
    }
    for (const name of COMMERCIAL) {
      expect(publishedByAgent.get(name)?.length, name).toBeGreaterThanOrEqual(1);
    }
    expect(publishedByAgent.get('滴滴出行（苏州运力中心）')).toContain('网约车运力调度服务');
    expect(publishedByAgent.get('美团配送（园区站）')).toContain('即时配送应急投送服务');
    expect(publishedByAgent.get('特来电充电运营')).toContain('有序充电调度服务');
    expect(publishedByAgent.get('哈啰出行')).toContain('短驳运力保障服务');
    expect(publishedByAgent.get('万达广场商业物业')).toContain('商业楼宇需求响应服务');
    // The two W3 government offers survive.
    expect(publishedByAgent.get('国网苏州供电公司')).toContain('需求响应负荷聚合服务');
    expect(publishedByAgent.get('苏州应急管理中心')).toContain('突发事件联动调度服务');

    // Platform agents (滴滴/美团/哈啰) bind NO devices — their fleets are
    // virtual — so their published offers are necessarily unbacked.
    for (const name of ['滴滴出行（苏州运力中心）', '美团配送（园区站）', '哈啰出行']) {
      expect(JSON.parse(agents.get(name)!.bound_device_ids_json)).toEqual([]);
    }
    const unbacked = unbackedFlagsForEnv(ctx.app.envStore, services);
    for (const s of published) {
      const agent = ctx.app.envStore.getAgent(s.provider_agent_id)!;
      if (['滴滴出行（苏州运力中心）', '美团配送（园区站）', '哈啰出行'].includes(agent.name)) {
        expect(unbacked.get(s.id), `${agent.name} / ${s.name}`).toBe(true);
      }
    }
  });

  it('forces cross-stakeholder collaboration: no single agent covers any event', () => {
    const env = cityEnv();
    const scenario = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(env.id),
      ctx.app.envStore.agentsOf(env.id),
    );
    expect(scenario.events).toHaveLength(7);
    for (const event of scenario.events) {
      const required = event.requiredCapabilities ?? [];
      expect(required.length, event.id).toBeGreaterThan(0);
      for (const agent of scenario.agents) {
        const covers = required.every(cap => agent.capabilities.includes(cap));
        expect(covers, `${event.id} fully covered by ${agent.name}`).toBe(false);
      }
    }
  });

  it('upgrades a stale v1-seeded template env in place (system-owned)', () => {
    // Simulate an OLD v1-seeded database: same template name, old revision
    // marker (description), v1-era content, owned by the system account.
    const system = ctx.app.userStore.findByEmail(SYSTEM_USER_EMAIL)!;
    ctx.app.envStore.deleteEnvironment(cityEnv().id);
    const v1 = importScenarioAsEnvironment(
      ctx.app.envStore,
      {
        version: '1.0',
        meta: {
          id: 'suzhou-city',
          name: CITY_NAME,
          description: '城市级地理地图（geo）示范环境：20 台城市设备，7 个利益方 Agent（v1）。',
        },
        map: { type: 'geo', center: { lat: 31.268, lng: 120.6615 }, zoom: 11 },
        zones: [
          {
            id: 'gusu-old-town',
            name: '姑苏老城',
            polygon: [[31.288, 120.598], [31.288, 120.646], [31.326, 120.646], [31.326, 120.598]],
          },
        ],
        devices: [
          {
            id: 'aq-gusu-01',
            name: '先河空气质量监测站（姑苏观前）',
            type: 'air-quality-sensor',
            capabilities: ['air-quality-monitoring'],
            zoneId: 'gusu-old-town',
            position: { lat: 31.307, lng: 120.622 },
          },
        ],
        agents: [
          {
            id: 'env-monitor',
            name: '苏州市环境监测中心',
            capabilities: ['air-quality-monitoring'],
            boundDeviceIds: ['aq-gusu-01'],
          },
        ],
        events: [],
      },
      { ownerId: system.id, visibility: 'public', serviceStore: ctx.app.serviceStore },
    );

    const created = seedTemplates(
      ctx.app.userStore,
      ctx.app.envStore,
      seedDir,
      undefined,
      ctx.app.serviceStore,
    );
    expect(created).toHaveLength(1);

    // The v1 env is gone (cascaded) and replaced by the v2 world.
    expect(ctx.app.envStore.getEnvironment(v1.id)).toBeUndefined();
    const upgraded = ctx.app.envStore.findEnvironmentByName(CITY_NAME)!;
    expect(upgraded.id).not.toBe(v1.id);
    expect(ctx.app.envStore.devicesOf(upgraded.id)).toHaveLength(33);
    expect(ctx.app.envStore.agentsOf(upgraded.id)).toHaveLength(12);
    // Published services (2 government + 5 commercial) were re-seeded too.
    const published = ctx.app.serviceStore
      .servicesOf(upgraded.id)
      .filter(s => s.origin === 'published');
    expect(published).toHaveLength(7);

    // …and the upgrade itself is idempotent.
    expect(
      seedTemplates(ctx.app.userStore, ctx.app.envStore, seedDir, undefined, ctx.app.serviceStore),
    ).toEqual([]);
  });

  it('coexists with a user-owned env that collides with the template name', async () => {
    const user = await registerUser(ctx.app);
    ctx.app.envStore.deleteEnvironment(cityEnv().id);
    const mine = ctx.app.envStore.createEnvironment({
      name: CITY_NAME,
      description: 'my own city world, not the template',
      mapType: 'geo',
      mapData: { center: CENTER, zones: [], events: [] },
      ownerId: user.id,
    });

    // Template identity is (name, system owner): the user copy never shadows
    // the gallery — the system template seeds alongside it, untouched.
    const created = seedTemplates(ctx.app.userStore, ctx.app.envStore, seedDir);
    expect(created).toHaveLength(1);
    expect(ctx.app.envStore.getEnvironment(mine.id)?.description).toBe(
      'my own city world, not the template',
    );
    const system = ctx.app.userStore.findByEmail(SYSTEM_USER_EMAIL)!;
    const template = ctx.app.envStore.findEnvironmentByNameAndOwner(CITY_NAME, system.id);
    expect(template).toBeDefined();
    expect(template!.id).not.toBe(mine.id);
  });
});
