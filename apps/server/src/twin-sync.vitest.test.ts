/**
 * @vitest-environment node
 *
 * Twin sync tests (P-D) — sync bindings + observations:
 * - PUT sync-bindings: owner-only, replace semantics, sensory-attribute
 *   validation (actuator attributes rejected), source format validation;
 * - POST observations: manual push → device state update + observation row +
 *   world-sync broadcast; per-binding throttling (rows never throttled);
 * - GET observations: time-window + entity filters;
 * - hass: bindings subscribe through the shared HA connection (MockHassServer)
 *   and degrade to status 'unavailable' when HA is not configured.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { MockHassServer } from './hass/mock-hass.js';
import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';
import type { StreamMessage } from './world-sync.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createEnvWithSensor(app: FastifyInstance, owner: TestUser) {
  const envRes = await app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: auth(owner.token),
    payload: { name: 'Twin Campus', mapData: { zones: [{ id: 'zone-a' }] } },
  });
  expect(envRes.statusCode).toBe(201);
  const envId = envRes.json().id as string;

  const deviceRes = await app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/devices`,
    headers: auth(owner.token),
    payload: {
      name: 'Campus Thermometer',
      type: 'temperature-sensor',
      capabilities: ['temperature-reading'],
      zoneId: 'zone-a',
      initialState: { temperature: 20 },
    },
  });
  expect(deviceRes.statusCode).toBe(201);
  return { envId, deviceId: deviceRes.json().id as string };
}

async function createActuatorDevice(app: FastifyInstance, owner: TestUser, envId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/devices`,
    headers: auth(owner.token),
    payload: {
      name: 'HVAC',
      type: 'hvac',
      capabilities: ['temperature-control', 'cooling'],
      zoneId: 'zone-a',
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

function putBindings(app: FastifyInstance, token: string, envId: string, bindings: unknown[]) {
  return app.inject({
    method: 'PUT',
    url: `/api/environments/${envId}/sync-bindings`,
    headers: auth(token),
    payload: { bindings },
  });
}

function pushObservation(
  app: FastifyInstance,
  token: string,
  envId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/observations`,
    headers: auth(token),
    payload,
  });
}

function deviceState(app: FastifyInstance, deviceId: string): Record<string, unknown> {
  const row = app.envStore.getDevice(deviceId);
  return row?.initial_state_json != null
    ? (JSON.parse(row.initial_state_json) as Record<string, unknown>)
    : {};
}

function subscribeWorld(app: FastifyInstance, envId: string): StreamMessage[] {
  const messages: StreamMessage[] = [];
  app.worldSync.subscribe(envId, message => messages.push(message));
  return messages;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

describe('PUT /api/environments/:id/sync-bindings', () => {
  let ctx: TestAppContext | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
  });

  it('replaces the binding set (owner) and defaults minIntervalSec to 60', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);

    const res = await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'temperature', source: 'manual' },
    ]);
    expect(res.statusCode).toBe(200);
    const bindings = res.json().bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      deviceInstanceId: deviceId,
      attributeKey: 'temperature',
      source: 'manual',
      minIntervalSec: 60,
      status: 'active',
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/sync-bindings`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().bindings).toHaveLength(1);

    // Replace semantics: a second PUT with an empty set removes everything.
    const cleared = await putBindings(ctx.app, owner.token, envId, []);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().bindings).toHaveLength(0);
  });

  it('rejects non-owner callers (builder/viewer)', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const builder = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    ctx.app.envStore.addMember(envId, builder.id, 'builder');

    const res = await putBindings(ctx.app, builder.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'temperature', source: 'manual' },
    ]);
    expect(res.statusCode).toBe(403);

    const outsider = await registerUser(ctx.app);
    const denied = await putBindings(ctx.app, outsider.token, envId, []);
    expect(denied.statusCode).toBe(403);
  });

  // R5 F-06 (Fix-13 contract clarification): the path exists with PUT/GET
  // only — POST is a method mismatch, not a missing route. Pin the behavior
  // the usability test tripped over so the contract note stays honest.
  it('POST on the sync-bindings path is a 404 method mismatch (write verb is PUT)', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const { envId } = await createEnvWithSensor(ctx.app, owner);

    const post = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sync-bindings`,
      headers: auth(owner.token),
      payload: { bindings: [] },
    });
    expect(post.statusCode).toBe(404);

    // …while the declared verbs do exist and answer.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/sync-bindings`,
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(200);
  });

  it('rejects bindings on actuator (non-sensory) attributes', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    const hvacId = await createActuatorDevice(ctx.app, owner, envId);

    // Pure actuator: no read-class capability at all.
    const actuator = await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: hvacId, attributeKey: 'temperature', source: 'manual' },
    ]);
    expect(actuator.statusCode).toBe(400);
    expect(actuator.json().error.code).toBe('SYNC_BINDING_NOT_SENSORY');

    // Sensor device, but the attribute does not match its read capability.
    const mismatched = await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'humidity', source: 'manual' },
    ]);
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.code).toBe('SYNC_BINDING_NOT_SENSORY');

    // Nothing was written by the rejected sets.
    expect(ctx.app.twinSync.listBindings(envId)).toHaveLength(0);
  });

  it('validates source format and device existence', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);

    const badSource = await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'temperature', source: 'mqtt://broker' },
    ]);
    expect(badSource.statusCode).toBe(400);

    const unknownDevice = await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: 'no-such-device', attributeKey: 'temperature', source: 'manual' },
    ]);
    expect(unknownDevice.statusCode).toBe(404);
    expect(unknownDevice.json().error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('marks hass: bindings unavailable when HA is not configured', async () => {
    ctx = await makeTestApp(); // no HASS_URL/HASS_TOKEN
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);

    const res = await putBindings(ctx.app, owner.token, envId, [
      {
        deviceInstanceId: deviceId,
        attributeKey: 'temperature',
        source: 'hass:sensor.living_room_temperature',
      },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings[0]).toMatchObject({
      source: 'hass:sensor.living_room_temperature',
      status: 'unavailable',
    });
  });
});

// ---------------------------------------------------------------------------
// Manual observations
// ---------------------------------------------------------------------------

describe('POST /api/environments/:id/observations', () => {
  let ctx: TestAppContext | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
  });

  it('applies the value to the device row, records the observation, broadcasts', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'temperature', source: 'manual' },
    ]);
    const world = subscribeWorld(ctx.app, envId);

    const res = await pushObservation(ctx.app, owner.token, envId, {
      deviceInstanceId: deviceId,
      key: 'temperature',
      value: 23.5,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().applied).toBe(true);
    expect(res.json().observation).toMatchObject({
      envId,
      entityId: deviceId,
      key: 'temperature',
      value: 23.5,
      simTime: null,
    });

    // Device state updated (synced value wins over the seeded 20).
    expect(deviceState(ctx.app, deviceId).temperature).toBe(23.5);

    // WorldSync broadcast on the environment channel.
    const deviceUpdates = world.filter(
      m => m.kind === 'world' && m.action === 'updated' && m.objectType === 'device',
    );
    expect(deviceUpdates).toHaveLength(1);
    expect((deviceUpdates[0] as { object: { id: string } }).object.id).toBe(deviceId);
  });

  it('accepts pushes from builders, rejects viewers and unbound attributes', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const builder = await registerUser(ctx.app);
    const viewer = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    ctx.app.envStore.addMember(envId, builder.id, 'builder');
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
    await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'temperature', source: 'manual' },
    ]);

    const byBuilder = await pushObservation(ctx.app, builder.token, envId, {
      deviceInstanceId: deviceId,
      key: 'temperature',
      value: 21,
    });
    expect(byBuilder.statusCode).toBe(201);

    const byViewer = await pushObservation(ctx.app, viewer.token, envId, {
      deviceInstanceId: deviceId,
      key: 'temperature',
      value: 21,
    });
    expect(byViewer.statusCode).toBe(403);

    const unbound = await pushObservation(ctx.app, owner.token, envId, {
      deviceInstanceId: deviceId,
      key: 'pressure',
      value: 1013,
    });
    expect(unbound.statusCode).toBe(404);
    expect(unbound.json().error.code).toBe('SYNC_BINDING_NOT_FOUND');
  });

  it('throttles state application per minIntervalSec but never drops observations', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    await putBindings(ctx.app, owner.token, envId, [
      {
        deviceInstanceId: deviceId,
        attributeKey: 'temperature',
        source: 'manual',
        minIntervalSec: 60,
      },
    ]);
    const world = subscribeWorld(ctx.app, envId);

    let fakeNow = 1_000_000;
    ctx.app.twinSync.now = () => fakeNow;

    const first = await pushObservation(ctx.app, owner.token, envId, {
      deviceInstanceId: deviceId,
      key: 'temperature',
      value: 21,
    });
    expect(first.json().applied).toBe(true);

    // Inside the throttle window: observation recorded, state NOT updated.
    fakeNow += 10_000;
    const second = await pushObservation(ctx.app, owner.token, envId, {
      deviceInstanceId: deviceId,
      key: 'temperature',
      value: 22,
    });
    expect(second.json().applied).toBe(false);
    expect(deviceState(ctx.app, deviceId).temperature).toBe(21);

    // Past the window: applied again.
    fakeNow += 61_000;
    const third = await pushObservation(ctx.app, owner.token, envId, {
      deviceInstanceId: deviceId,
      key: 'temperature',
      value: 23,
    });
    expect(third.json().applied).toBe(true);
    expect(deviceState(ctx.app, deviceId).temperature).toBe(23);

    // All three observations landed; only two broadcasts went out.
    const rows = ctx.app.observationStore.query(envId, { entityId: deviceId });
    expect(rows.map(r => JSON.parse(r.value_json))).toEqual([21, 22, 23]);
    const broadcasts = world.filter(
      m => m.kind === 'world' && m.action === 'updated' && m.objectType === 'device',
    );
    expect(broadcasts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Observation queries
// ---------------------------------------------------------------------------

describe('GET /api/environments/:id/observations', () => {
  let ctx: TestAppContext | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
  });

  it('filters by entity and wall-time window (oldest first)', async () => {
    ctx = await makeTestApp();
    const owner = await registerUser(ctx.app);
    const member = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    ctx.app.envStore.addMember(envId, member.id, 'viewer');
    await putBindings(ctx.app, owner.token, envId, [
      { deviceInstanceId: deviceId, attributeKey: 'temperature', source: 'manual' },
    ]);

    const t0 = '2026-07-01T08:00:00.000Z';
    const t1 = '2026-07-01T09:00:00.000Z';
    const t2 = '2026-07-01T10:00:00.000Z';
    ctx.app.observationStore.append({ envId, entityId: deviceId, key: 'temperature', value: 20, wallTime: t0 });
    ctx.app.observationStore.append({ envId, entityId: deviceId, key: 'temperature', value: 21, wallTime: t1 });
    ctx.app.observationStore.append({ envId, entityId: deviceId, key: 'temperature', value: 22, wallTime: t2 });
    ctx.app.observationStore.append({ envId, entityId: 'other-device', key: 'temperature', value: 99, wallTime: t1 });

    // S2 (device privacy): the query-filter semantics hold at the OWNER
    // tier — observations ARE sensor readings, so the env owner reads all.
    const all = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/observations`,
      headers: auth(owner.token),
    });
    expect(all.statusCode).toBe(200);
    expect(all.json().observations).toHaveLength(4);

    // A MEMBER (viewer) sees NONE of the owner-device readings: rows are
    // omitted with an honest count (values never travel this lane; foreign
    // telemetry goes through the service layer only).
    const memberAll = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/observations`,
      headers: auth(member.token),
    });
    expect(memberAll.statusCode).toBe(200);
    expect(memberAll.json().observations).toEqual([]);
    expect(memberAll.json().redacted).toBe(4);

    // Window [t0, t2): t2 excluded, other-device excluded by entityId filter.
    const windowed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/observations?entityId=${deviceId}&from=${t0}&to=${t2}`,
      headers: auth(owner.token),
    });
    expect(windowed.statusCode).toBe(200);
    const observations = windowed.json().observations as Array<Record<string, unknown>>;
    expect(observations.map(o => o.value)).toEqual([20, 21]);
    expect(observations.map(o => o.wallTime)).toEqual([t0, t1]);

    const badFrom = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/observations?from=not-a-date`,
      headers: auth(member.token),
    });
    expect(badFrom.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// hass: bindings
// ---------------------------------------------------------------------------

describe('hass: sync bindings', () => {
  let ctx: TestAppContext | undefined;
  let mock: MockHassServer | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
    await mock?.close();
    mock = undefined;
  });

  it('subscribes to the shared HA connection and syncs state_changed pushes', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);
    const world = subscribeWorld(ctx.app, envId);

    const res = await putBindings(ctx.app, owner.token, envId, [
      {
        deviceInstanceId: deviceId,
        attributeKey: 'temperature',
        source: 'hass:sensor.living_room_temperature',
        minIntervalSec: 0,
      },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings[0].status).toBe('active');

    // Subscribing delivered the cached state (21.5) synchronously.
    await vi.waitFor(() => {
      expect(deviceState(ctx!.app, deviceId).temperature).toBe(21.5);
    });

    mock.pushState('sensor.living_room_temperature', '24.5');
    await vi.waitFor(() => {
      expect(deviceState(ctx!.app, deviceId).temperature).toBe(24.5);
    });

    const rows = ctx.app.observationStore.query(envId, { entityId: deviceId });
    expect(rows.map(r => JSON.parse(r.value_json))).toEqual([21.5, 24.5]);
    expect(
      world.filter(m => m.kind === 'world' && m.action === 'updated' && m.objectType === 'device')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('marks the binding unavailable for an unknown hass entity', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
    const owner = await registerUser(ctx.app);
    const { envId, deviceId } = await createEnvWithSensor(ctx.app, owner);

    const res = await putBindings(ctx.app, owner.token, envId, [
      {
        deviceInstanceId: deviceId,
        attributeKey: 'temperature',
        source: 'hass:sensor.no_such_entity',
      },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings[0].status).toBe('unavailable');
  });
});
