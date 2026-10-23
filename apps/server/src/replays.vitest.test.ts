/**
 * @vitest-environment node
 *
 * Replay tests (P-E) — POST /api/environments/:id/replays:
 * - 转换语义：wall_time → atSimTimeSec（窗口起点 = 0 秒）；窗口前最后观测
 *   → 设备 initialState；窗内仅值变化生成事件；entity → 设备解析（直接
 *   设备 id + sync_bindings 源标识反查）；孤儿观测/非法命令计入 skipped；
 * - device-command 类 command_log 记录的 after 状态 → 事件（提案类 kind
 *   不生成事件）；
 * - download / save 两态；from >= to → 400；空窗口 → eventCount 0；
 * - 权限：成员可用，非成员（私有环境）403，未认证 401；
 * - 产物过 loadScenarioFile 校验。
 */

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { loadScenarioFile } from '@active-collaboration/core';

import { parseMapData } from './db/environment-store.js';
import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 固定的回放窗口起点："上周三暴雨那晚" 20:00。 */
const T0 = Date.parse('2026-07-22T20:00:00.000Z');

function iso(offsetSec: number): string {
  return new Date(T0 + offsetSec * 1000).toISOString();
}

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../../../config/scenarios/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

interface ReplayFixture {
  envId: string;
  sensorId: string;
  outdoorSensorId: string;
  hvacId: string;
}

async function createFixture(app: FastifyInstance, owner: TestUser): Promise<ReplayFixture> {
  const envRes = await app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: auth(owner.token),
    payload: { name: 'Replay Campus', mapData: { zones: [{ id: 'zone-a' }] } },
  });
  expect(envRes.statusCode).toBe(201);
  const envId = envRes.json().id as string;

  const mkDevice = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const sensorId = await mkDevice({
    name: 'Indoor Thermometer',
    type: 'temperature-sensor',
    capabilities: ['temperature-reading'],
    zoneId: 'zone-a',
    initialState: { temperature: 20 },
  });
  const outdoorSensorId = await mkDevice({
    name: 'Outdoor Thermometer',
    type: 'temperature-sensor',
    capabilities: ['temperature-reading'],
    zoneId: 'zone-a',
  });
  const hvacId = await mkDevice({
    name: 'HVAC',
    type: 'hvac',
    capabilities: ['temperature-control', 'cooling'],
    zoneId: 'zone-a',
  });

  // 室内传感器走 manual 源；室外传感器走 hass 源（观测的 entity_id 写成
  // 'hass:<entity>' 形式，回放需经 sync_bindings 反查设备实例）。
  const bindRes = await app.inject({
    method: 'PUT',
    url: `/api/environments/${envId}/sync-bindings`,
    headers: auth(owner.token),
    payload: {
      bindings: [
        { deviceInstanceId: sensorId, attributeKey: 'temperature', source: 'manual' },
        {
          deviceInstanceId: outdoorSensorId,
          attributeKey: 'temperature',
          source: 'hass:sensor.outdoor_temp',
        },
      ],
    },
  });
  expect(bindRes.statusCode).toBe(200);

  return { envId, sensorId, outdoorSensorId, hvacId };
}

/** 造一窗历史：窗口前初始值 + 窗内多次变化 + 无变化重复 + 孤儿观测 + 命令记录。 */
function seedHistory(app: FastifyInstance, fixture: ReplayFixture, ownerId: string): void {
  const { envId, sensorId, hvacId } = fixture;
  const obs = (entityId: string, key: string, value: number, offsetSec: number) =>
    app.observationStore.append({ envId, entityId, key, value, wallTime: iso(offsetSec) });

  // 窗口起点前的最后一次观测 → 设备 initialState（18°C）。
  obs(sensorId, 'temperature', 18, -3600);
  // 窗内：变化 → 事件；同值重复 → unchanged；再变化 → 事件。
  obs(sensorId, 'temperature', 21, 600);
  obs(sensorId, 'temperature', 21, 1200);
  obs(sensorId, 'temperature', 25, 1800);
  // hass 源标识写法的观测（经 sync_bindings 反查到 outdoorSensorId）。
  obs('hass:sensor.outdoor_temp', 'temperature', 5, 900);
  // 孤儿观测：既不是设备实例 id，也没有任何绑定 → skipped。
  obs('hass:sensor.ghost', 'temperature', 0, 1000);

  // device-command 记录：after 状态 → 事件；提案类 kind 不参与回放；
  // 指向不存在设备的命令 → skipped。
  app.commandLogStore.append({
    envId,
    actorId: ownerId,
    kind: 'device-command',
    payload: { deviceId: hvacId, after: { power: true } },
    wallTime: iso(1500),
  });
  app.commandLogStore.append({
    envId,
    actorId: ownerId,
    kind: 'install-devices',
    payload: { before: null, after: { devices: [] } },
    wallTime: iso(1600),
  });
  app.commandLogStore.append({
    envId,
    actorId: ownerId,
    kind: 'device-command',
    payload: { deviceId: 'no-such-device', after: { power: false } },
    wallTime: iso(1550),
  });
}

function postReplay(
  app: FastifyInstance,
  token: string,
  envId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/replays`,
    headers: auth(token),
    payload,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/environments/:id/replays', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('download：时间映射 / 初始状态 / skipped / unchanged，产物过 schema 校验', async () => {
    const owner = await registerUser(ctx.app);
    const fixture = await createFixture(ctx.app, owner);
    seedHistory(ctx.app, fixture, owner.id);

    const res = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(0),
      to: iso(3600),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.report).toMatchObject({
      envId: fixture.envId,
      window: { from: iso(0), to: iso(3600) },
      eventCount: 4,
      observationEvents: 3,
      commandEvents: 1,
      initialStateCount: 1,
      skipped: 2,
      unchanged: 1,
    });

    const scenario = body.scenario;
    expect(scenario.version).toBe('1.0');
    expect(scenario.meta.id).toMatch(/^replay-/);

    // 事件按仿真时间排序；atSimTimeSec = (wall_time − from) / 1000。
    const events = scenario.events as Array<Record<string, unknown>>;
    expect(events.map(event => event.atSimTimeSec)).toEqual([600, 900, 1500, 1800]);
    expect(events[0]).toMatchObject({
      type: 'observation-replay',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 21,
    });
    // hass 源标识的观测落到了室外传感器所在 zone 的事件上。
    expect(events[1]).toMatchObject({
      type: 'observation-replay',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 5,
    });
    expect(events[2]).toMatchObject({
      type: 'device-command-replay',
      zoneId: 'zone-a',
      parameter: 'power',
      value: true,
    });
    expect(events[3]).toMatchObject({ parameter: 'temperature', value: 25 });
    // 事件 id 唯一（schema 语义校验也要求）。
    expect(new Set(events.map(event => event.id)).size).toBe(events.length);

    // 初始状态：窗口前最后观测（18°C）覆盖设备行上的当前值（20°C）。
    const sensor = (scenario.devices as Array<Record<string, unknown>>).find(
      device => device.id === fixture.sensorId,
    );
    expect((sensor?.initialState as Record<string, unknown>).temperature).toBe(18);

    // 产物必须过 loadScenarioFile 的 schema + 语义校验。
    expect(() => loadScenarioFile(scenario)).not.toThrow();
  });

  it('save：写入用户 scenario 源并返回 scenarioId', async () => {
    const owner = await registerUser(ctx.app);
    const fixture = await createFixture(ctx.app, owner);
    seedHistory(ctx.app, fixture, owner.id);

    const res = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(0),
      to: iso(3600),
      mode: 'save',
      name: '暴雨那晚',
    });
    expect(res.statusCode).toBe(201);
    const { scenarioId, report } = res.json();
    expect(typeof scenarioId).toBe('string');
    expect(report.eventCount).toBe(4);

    const fetched = await ctx.app.inject({ method: 'GET', url: `/api/scenarios/${scenarioId}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().meta).toMatchObject({ id: scenarioId, name: '暴雨那晚' });
    expect(fetched.json().events).toHaveLength(4);
  });

  it('from >= to → 400；非 ISO → 400；非法 mode → 400', async () => {
    const owner = await registerUser(ctx.app);
    const fixture = await createFixture(ctx.app, owner);

    const inverted = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(3600),
      to: iso(0),
    });
    expect(inverted.statusCode).toBe(400);

    const equal = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(0),
      to: iso(0),
    });
    expect(equal.statusCode).toBe(400);

    const notIso = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: 'last-wednesday',
      to: iso(3600),
    });
    expect(notIso.statusCode).toBe(400);

    const badMode = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(0),
      to: iso(3600),
      mode: 'upload',
    });
    expect(badMode.statusCode).toBe(400);
  });

  it('空窗口生成空 events 的 scenario（report.eventCount === 0）', async () => {
    const owner = await registerUser(ctx.app);
    const fixture = await createFixture(ctx.app, owner);

    const res = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(0),
      to: iso(3600),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.report.eventCount).toBe(0);
    expect(body.scenario.events).toEqual([]);
    expect(() => loadScenarioFile(body.scenario)).not.toThrow();
  });

  it('权限：非成员（私有环境）403，未认证 401', async () => {
    const owner = await registerUser(ctx.app);
    const stranger = await registerUser(ctx.app);
    const fixture = await createFixture(ctx.app, owner);

    const forbidden = await postReplay(ctx.app, stranger.token, fixture.envId, {
      from: iso(0),
      to: iso(3600),
    });
    expect(forbidden.statusCode).toBe(403);

    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${fixture.envId}/replays`,
      payload: { from: iso(0), to: iso(3600) },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// T-101: world-tier map metadata survives replay → re-import
// ---------------------------------------------------------------------------

describe('replay export carries world-tier map metadata (T-101)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** scenario JSON → env → replay export（download 模式）。 */
  async function replayExported(payload: Record<string, unknown>) {
    const envRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload,
    });
    expect(envRes.statusCode).toBe(201);
    const envId = envRes.json().id as string;

    const res = await postReplay(ctx.app, owner.token, envId, {
      from: iso(0),
      to: iso(3600),
    });
    expect(res.statusCode).toBe(200);
    return res.json().scenario as Record<string, unknown>;
  }

  it('building tier: storeyHeight + floorPlans survive replay and re-import', async () => {
    const scenario = await replayExported(loadFixture('teaching-building.json'));

    // The exported scenario itself carries the fields...
    expect((scenario.meta as Record<string, unknown>).storeyHeight).toBe(3.5);
    const map = scenario.map as { floorPlans?: unknown[] };
    expect(map.floorPlans).toHaveLength(3);
    // ...and still passes loader validation.
    expect(() => loadScenarioFile(scenario)).not.toThrow();

    const reimport = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario,
    });
    expect(reimport.statusCode).toBe(201);

    const mapData = parseMapData(ctx.app.envStore.getEnvironment(reimport.json().id)!);
    expect(mapData.storeyHeight).toBe(3.5);
    expect(mapData.floorPlans).toHaveLength(3);
  });

  it('geo tier: map block, zone polygons and device brand/position survive', async () => {
    const scenario = await replayExported(loadFixture('shenzhen-resilience.json'));

    const map = scenario.map as {
      type: string;
      center: { lat: number; lng: number };
      zoom?: number;
    };
    expect(map.type).toBe('geo');
    expect(map.center).toEqual({ lat: 22.59, lng: 114.08 });
    expect(map.zoom).toBe(10);

    const zones = scenario.zones as Array<{ id: string; polygon?: unknown }>;
    expect(zones.filter(zone => Array.isArray(zone.polygon))).toHaveLength(6);

    const devices = scenario.devices as Array<{
      id: string;
      brand?: string;
      position?: { lat: number; lng: number };
    }>;
    const branded = devices.filter(device => typeof device.brand === 'string');
    expect(branded.length).toBeGreaterThanOrEqual(1);
    const positioned = devices.filter(
      device => typeof device.position?.lat === 'number' && typeof device.position?.lng === 'number',
    );
    expect(positioned.length).toBeGreaterThanOrEqual(1);

    expect(() => loadScenarioFile(scenario)).not.toThrow();
    const reimport = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario,
    });
    expect(reimport.statusCode).toBe(201);

    const mapData = parseMapData(ctx.app.envStore.getEnvironment(reimport.json().id)!);
    expect(mapData.center).toEqual({ lat: 22.59, lng: 114.08 });
    expect(mapData.zoom).toBe(10);
    expect(mapData.zones.filter(zone => Array.isArray(zone.polygon))).toHaveLength(6);

    const rows = ctx.app.envStore.devicesOf(reimport.json().id as string);
    expect(rows.filter(row => row.brand !== null).length).toBe(branded.length);
    expect(rows.filter(row => row.position_json !== null).length).toBe(positioned.length);
  });
});

// ---------------------------------------------------------------------------
// T-019 (DevLoop R17, EC-F05): device-command replay events carry ONLY the
// command's parameter surface — never the full post-command device state.
// ---------------------------------------------------------------------------

describe('device-command replay event hygiene (T-019)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let fixture: ReplayFixture;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app);
    fixture = await createFixture(ctx.app, owner);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Replay events of type device-command-replay for the seeded window. */
  const commandReplayEvents = async (): Promise<Array<Record<string, unknown>>> => {
    const res = await postReplay(ctx.app, owner.token, fixture.envId, {
      from: iso(0),
      to: iso(3600),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().scenario.events as Array<Record<string, unknown>>)
      .filter(event => event.type === 'device-command-replay');
  };

  it('a bare command becomes ONE semantic marker event, not a full-state dump', async () => {
    // EC-F05 reproduction: one `turn-on` used to emit 7 events — zoneId,
    // status, power, mode, targetTemperature, cumulativeEnergyWh, on.
    ctx.app.commandLogStore.append({
      envId: fixture.envId,
      actorId: owner.id,
      kind: 'device-command',
      payload: {
        deviceId: fixture.hvacId,
        commandName: 'turn-on',
        before: { zoneId: 'zone-a', status: 'off', cumulativeEnergyWh: 7368.49 },
        after: {
          zoneId: 'zone-a',
          status: 'on',
          power: true,
          mode: 'off',
          targetTemperature: 24,
          cumulativeEnergyWh: 7368.49,
          on: true,
        },
      },
      wallTime: iso(100),
    });

    const events = await commandReplayEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      parameter: 'turn-on',
      value: true,
      zoneId: 'zone-a',
      details: { deviceId: fixture.hvacId, commandName: 'turn-on' },
    });
    // State keys must never surface as replay parameters.
    for (const key of [
      'zoneId', 'status', 'power', 'mode',
      'targetTemperature', 'cumulativeEnergyWh', 'on',
    ]) {
      expect(events.some(event => event.parameter === key), key).toBe(false);
    }
  });

  it("a parameterized command emits exactly its scalar arguments (the command's parameter schema)", async () => {
    ctx.app.commandLogStore.append({
      envId: fixture.envId,
      actorId: owner.id,
      kind: 'device-command',
      payload: {
        deviceId: fixture.hvacId,
        commandName: 'set-target',
        params: { targetTemperature: 24, mode: 'cool' },
        before: { targetTemperature: 26, zoneId: 'zone-a' },
        after: { targetTemperature: 24, mode: 'cool', zoneId: 'zone-a', status: 'on' },
      },
      wallTime: iso(100),
    });

    const events = await commandReplayEvents();
    // Only the injectable numeric argument became a replay parameter; the
    // string argument rides details.params verbatim instead of dying at
    // injection (physical parameters accept numbers/booleans only).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      parameter: 'targetTemperature',
      value: 24,
      details: {
        deviceId: fixture.hvacId,
        commandName: 'set-target',
        params: { targetTemperature: 24, mode: 'cool' },
      },
    });
    expect(events.some(event => event.parameter === 'mode')).toBe(false);
  });

  it('legacy records without commandName fall back to the before/after delta', async () => {
    ctx.app.commandLogStore.append({
      envId: fixture.envId,
      actorId: owner.id,
      kind: 'device-command',
      payload: {
        deviceId: fixture.hvacId,
        before: { power: false, zoneId: 'zone-a', cumulativeEnergyWh: 7368.49 },
        after: { power: true, zoneId: 'zone-a', cumulativeEnergyWh: 7368.49 },
      },
      wallTime: iso(100),
    });

    const events = await commandReplayEvents();
    // The §4.3 design's intended semantics: only keys the command CHANGED.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ parameter: 'power', value: true });
    expect(events.some(event => event.parameter === 'zoneId')).toBe(false);
    expect(events.some(event => event.parameter === 'cumulativeEnergyWh')).toBe(false);
  });
});
