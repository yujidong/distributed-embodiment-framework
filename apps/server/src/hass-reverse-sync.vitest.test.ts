/**
 * @vitest-environment node
 *
 * HIL reverse mapping P1 (design-hil-reverse-mapping.md §2-P1) — snapshot
 * alignment of hass://-bound device state from reality into the base layer,
 * verified end-to-end against MockHassServer:
 * - policy GET/PUT: default 'manual', admin-only writes, validation;
 * - manual align-now: drift applied to the device row, drift + audit
 *   (command_log kind 'hass-reverse-sync') recorded, world-sync broadcast;
 * - live policy: mock HA state_changed pushes align the bound device;
 * - E-stop: freezes BOTH the manual and the live reverse channel (same gate
 *   as forward actuation); disabled policy rejects align-now;
 * - drift reporting on GET status (no write).
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { MockHassServer } from './hass/mock-hass.js';
import { REVERSE_SYNC_COMMAND_KIND, REVERSE_SYNC_SYSTEM_ACTOR } from './hass/reverse-sync.js';
import { auth, makeTestApp, registerUser, until, type TestAppContext, type TestUser } from './test-utils.js';

const ADMIN_EMAIL = 'admin@example.com';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createBoundDevice(
  app: FastifyInstance,
  owner: TestUser,
  entityId: string,
  initialState: Record<string, unknown>,
): Promise<{ envId: string; deviceId: string }> {
  const envRes = await app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: auth(owner.token),
    payload: { name: 'HIL Campus', mapData: { zones: [{ id: 'zone-a' }] } },
  });
  expect(envRes.statusCode).toBe(201);
  const envId = envRes.json().id as string;

  const deviceRes = await app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/devices`,
    headers: auth(owner.token),
    payload: {
      name: 'Real Thermometer',
      type: 'temperature-sensor',
      capabilities: ['temperature-reading'],
      zoneId: 'zone-a',
      initialState,
      binding: `hass://${entityId}`,
    },
  });
  expect(deviceRes.statusCode).toBe(201);
  return { envId, deviceId: deviceRes.json().id as string };
}

function deviceState(app: FastifyInstance, deviceId: string): Record<string, unknown> {
  const row = app.envStore.getDevice(deviceId);
  return row?.initial_state_json != null
    ? (JSON.parse(row.initial_state_json) as Record<string, unknown>)
    : {};
}

function reverseSyncLogs(app: FastifyInstance, envId: string) {
  return app.commandLogStore
    .listForEnv(envId, { kind: REVERSE_SYNC_COMMAND_KIND, limit: 50 })
    .map(row => ({ actorId: row.actor_id, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

const getStatus = (app: FastifyInstance, token: string) =>
  app.inject({ method: 'GET', url: '/api/hass/reverse-sync', headers: auth(token) });

const putPolicy = (app: FastifyInstance, token: string, policy: string) =>
  app.inject({
    method: 'PUT',
    url: '/api/hass/reverse-sync',
    headers: auth(token),
    payload: { policy },
  });

const alignNow = (app: FastifyInstance, token: string) =>
  app.inject({
    method: 'POST',
    url: '/api/hass/reverse-sync/align-now',
    headers: auth(token),
  });

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('HIL reverse mapping P1 — /api/hass/reverse-sync', () => {
  let ctx: TestAppContext | undefined;
  let mock: MockHassServer | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
    await mock?.close();
    mock = undefined;
  });

  async function boot() {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({
      hassUrl: mock.url,
      hassToken: 'test-token',
      adminEmails: [ADMIN_EMAIL],
    });
    const admin = await registerUser(ctx.app, { email: ADMIN_EMAIL });
    const owner = await registerUser(ctx.app);
    return { app: ctx.app, mock: mock!, admin, owner };
  }

  it('requires authentication on all three endpoints', async () => {
    ctx = await makeTestApp();
    for (const [method, url] of [
      ['GET', '/api/hass/reverse-sync'],
      ['PUT', '/api/hass/reverse-sync'],
      ['POST', '/api/hass/reverse-sync/align-now'],
    ] as const) {
      const res = await ctx.app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('defaults to the manual policy (safe default) and validates PUT', async () => {
    const { app, admin, owner } = await boot();

    const status = await getStatus(app, owner.token);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      policy: 'manual',
      estopActive: false,
      hass: { configured: true },
      boundDevices: 0,
      drift: [],
      recentAlignments: [],
    });

    // Non-admin cannot change the server-wide policy.
    const forbidden = await putPolicy(app, owner.token, 'live');
    expect(forbidden.statusCode).toBe(403);

    const invalid = await putPolicy(app, admin.token, 'continuous');
    expect(invalid.statusCode).toBe(400);

    const changed = await putPolicy(app, admin.token, 'disabled');
    expect(changed.statusCode).toBe(200);
    expect(changed.json().policy).toBe('disabled');
  });

  it('manual align-now applies the drift, audits it, and reports it', async () => {
    const { app, mock: ha, owner } = await boot();
    // Reality: sensor.living_room_temperature is 21.5 °C (mock fixture);
    // the sim base layer believes 20 °C.
    const { envId, deviceId } = await createBoundDevice(
      app,
      owner,
      'sensor.living_room_temperature',
      { temperature: 20 },
    );

    // GET status surfaces the drift WITHOUT writing anything.
    const before = await getStatus(app, owner.token);
    expect(before.json().boundDevices).toBe(1);
    const drift = before.json().drift as Array<Record<string, unknown>>;
    expect(drift).toContainEqual(
      expect.objectContaining({
        deviceId,
        entityId: 'sensor.living_room_temperature',
        key: 'state',
        simValue: null,
        hassValue: 21.5,
      }),
    );
    expect(deviceState(app, deviceId)).toEqual({ temperature: 20 });

    // A live push under the manual policy does NOT align.
    ha.pushState('sensor.living_room_temperature', '22.5');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(deviceState(app, deviceId)).toEqual({ temperature: 20 });

    // Manual trigger: the stored state takes reality's values.
    const aligned = await alignNow(app, owner.token);
    expect(aligned.statusCode).toBe(200);
    expect(aligned.json()).toMatchObject({ trigger: 'manual', alignedDevices: 1 });
    const state = deviceState(app, deviceId);
    expect(state.state).toBe(22.5);
    expect(state.unit_of_measurement).toBe('°C');

    // Drift is gone afterwards; the alignment is remembered.
    const after = await getStatus(app, owner.token);
    expect(after.json().drift).toEqual([]);
    expect(after.json().recentAlignments).toHaveLength(1);
    expect(after.json().recentAlignments[0]).toMatchObject({
      trigger: 'manual',
      actorId: owner.id,
      deviceId,
      entityId: 'sensor.living_room_temperature',
    });

    // Audit: one command_log row carrying the applied drift.
    const logs = reverseSyncLogs(app, envId);
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe(owner.id);
    expect(logs[0].payload).toMatchObject({
      deviceId,
      entityId: 'sensor.living_room_temperature',
      trigger: 'manual',
    });
    expect(logs[0].payload.changes).toEqual(
      expect.arrayContaining([
        { key: 'state', before: null, after: 22.5 },
      ]),
    );

    // Second trigger with no new drift: nothing written, nothing logged.
    const again = await alignNow(app, owner.token);
    expect(again.json()).toMatchObject({ alignedDevices: 0, unchangedDevices: 1 });
    expect(reverseSyncLogs(app, envId)).toHaveLength(1);
  });

  it('a non-member cannot align someone else\'s environment', async () => {
    const { app, owner } = await boot();
    const outsider = await registerUser(app);
    const { deviceId } = await createBoundDevice(
      app,
      owner,
      'sensor.living_room_temperature',
      { temperature: 20 },
    );

    const res = await alignNow(app, outsider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ alignedDevices: 0, unchangedDevices: 0 });
    expect(deviceState(app, deviceId)).toEqual({ temperature: 20 });

    // …and the drift is not visible to them either.
    const status = await getStatus(app, outsider.token);
    expect(status.json().boundDevices).toBe(0);
    expect(status.json().drift).toEqual([]);
  });

  it('live policy aligns on state_changed pushes (system actor audit)', async () => {
    const { app, mock: ha, admin, owner } = await boot();
    const { envId, deviceId } = await createBoundDevice(
      app,
      owner,
      'sensor.living_room_temperature',
      { temperature: 20 },
    );

    const switched = await putPolicy(app, admin.token, 'live');
    expect(switched.statusCode).toBe(200);

    // The reconcile subscribes asynchronously; the pushed change then aligns.
    ha.pushState('sensor.living_room_temperature', '23.7');
    const ok = await until(() => deviceState(app, deviceId).state === 23.7, 5000);
    expect(ok).toBe(true);

    const logs = reverseSyncLogs(app, envId);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].actorId).toBe(REVERSE_SYNC_SYSTEM_ACTOR);
    expect(logs[0].payload.trigger).toBe('live');
  });

  it('E-stop freezes BOTH the manual and the live reverse channel', async () => {
    const { app, mock: ha, admin, owner } = await boot();
    const { envId, deviceId } = await createBoundDevice(
      app,
      owner,
      'sensor.living_room_temperature',
      { temperature: 20 },
    );

    // Engage the stop BEFORE going live — otherwise the live subscription's
    // initial baseline delivery races the engage and the outcome is timing.
    await app.inject({
      method: 'POST',
      url: '/api/hass/estop',
      headers: auth(owner.token),
    });
    await putPolicy(app, admin.token, 'live');

    // Manual trigger is rejected with the same gate code as actuation.
    const blocked = await alignNow(app, owner.token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ESTOP_ACTIVE');

    // Live pushes (incl. the subscription's baseline delivery) are dropped
    // while the stop is engaged — no write, no audit row.
    ha.pushState('sensor.living_room_temperature', '25.1');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(deviceState(app, deviceId)).toEqual({ temperature: 20 });
    expect(reverseSyncLogs(app, envId)).toHaveLength(0);

    // Clearing the stop re-enables both lanes.
    await app.inject({
      method: 'DELETE',
      url: '/api/hass/estop',
      headers: auth(owner.token),
    });
    const aligned = await alignNow(app, owner.token);
    expect(aligned.statusCode).toBe(200);
    expect(deviceState(app, deviceId).state).toBe(25.1);
  });

  it('disabled policy rejects align-now and stops live alignment', async () => {
    const { app, mock: ha, admin, owner } = await boot();
    const { deviceId } = await createBoundDevice(
      app,
      owner,
      'sensor.living_room_temperature',
      { temperature: 20 },
    );

    await putPolicy(app, admin.token, 'live');
    ha.pushState('sensor.living_room_temperature', '22.0');
    await until(() => deviceState(app, deviceId).state === 22.0, 5000);

    await putPolicy(app, admin.token, 'disabled');
    const res = await alignNow(app, owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REVERSE_SYNC_DISABLED');

    ha.pushState('sensor.living_room_temperature', '26.4');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(deviceState(app, deviceId).state).toBe(22.0);
  });

  it('align-now surfaces HASS_NOT_CONFIGURED on a server without HA', async () => {
    ctx = await makeTestApp({ adminEmails: [ADMIN_EMAIL] });
    const owner = await registerUser(ctx.app);
    const res = await alignNow(ctx.app, owner.token);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('HASS_NOT_CONFIGURED');

    // GET status still reports (never errors).
    const status = await getStatus(ctx.app, owner.token);
    expect(status.statusCode).toBe(200);
    expect(status.json().hass).toEqual({ configured: false, state: 'unconfigured' });
  });
});
