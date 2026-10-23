/**
 * @vitest-environment node
 *
 * HIL reverse mapping P2 (design-hil-reverse-mapping.md §2-P2) — shadow
 * worlds: an observation-driven sandbox fork per environment with hass://
 * bindings, verified end-to-end against MockHassServer:
 * - create/status/destroy + permissions (FULL tier: env owner / admin);
 * - mock HA state_changed pushes evolve the shadow's device state AND its
 *   physical field (sensor-class entities), with (predicted, observed)
 *   residuals recorded per observation;
 * - actuation attempts on hass-bound devices inside the shadow are
 *   discarded + counted — and NEVER reach the mock HA (no HADevice exists
 *   in the fork by construction);
 * - E-stop freezes the observation channel (same gate as P1);
 * - fork GC: DELETE stops the fork; environment deletion cascades;
 *   boot-time reap of orphan shadow rows.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { MockHassServer } from './hass/mock-hass.js';
import { auth, makeTestApp, registerUser, until, type TestAppContext, type TestUser } from './test-utils.js';

const ADMIN_EMAIL = 'admin@example.com';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function createBoundEnv(
  app: FastifyInstance,
  owner: TestUser,
  entityId = 'sensor.living_room_temperature',
  initialState: Record<string, unknown> = { temperature: 20 },
): Promise<{ envId: string; deviceId: string }> {
  const envRes = await app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: auth(owner.token),
    payload: { name: 'HIL Shadow Campus', mapData: { zones: [{ id: 'zone-a' }] } },
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

const createShadow = (app: FastifyInstance, token: string, envId: string, body?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/shadow`,
    headers: auth(token),
    ...(body !== undefined ? { payload: body } : {}),
  });

const getShadow = (app: FastifyInstance, token: string, envId: string) =>
  app.inject({ method: 'GET', url: `/api/environments/${envId}/shadow`, headers: auth(token) });

const deleteShadow = (app: FastifyInstance, token: string, envId: string) =>
  app.inject({ method: 'DELETE', url: `/api/environments/${envId}/shadow`, headers: auth(token) });

/** Live device state inside the shadow fork (read via the registry). */
function shadowDeviceState(app: FastifyInstance, simulationId: string, deviceId: string) {
  const record = app.simulations.get(simulationId);
  return record?.runtime.getSnapshot().devices.find(d => d.id === deviceId)?.state;
}

function shadowZoneParameters(app: FastifyInstance, simulationId: string, zoneId: string) {
  const record = app.simulations.get(simulationId);
  return record?.runtime.getSnapshot().zones.find(z => z.id === zoneId)?.parameters;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('HIL reverse mapping P2 — /api/environments/:id/shadow', () => {
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

  it('requires authentication; only the env owner / an admin (FULL tier) may manage a shadow', async () => {
    const { app, admin, owner } = await boot();
    const outsider = await registerUser(app);
    const member = await registerUser(app);
    const { envId } = await createBoundEnv(app, owner);
    await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/members`,
      headers: auth(owner.token),
      payload: { userId: member.id, role: 'builder' },
    });

    expect((await app.inject({ method: 'POST', url: `/api/environments/${envId}/shadow` })).statusCode).toBe(401);
    expect((await createShadow(app, outsider.token, envId)).statusCode).toBe(403);
    expect((await createShadow(app, member.token, envId)).statusCode).toBe(403);
    expect((await getShadow(app, outsider.token, envId)).statusCode).toBe(403);

    const created = await createShadow(app, admin.token, envId);
    expect(created.statusCode).toBe(201);
    expect((await getShadow(app, owner.token, envId)).statusCode).toBe(200);
    expect((await deleteShadow(app, admin.token, envId)).statusCode).toBe(204);
  });

  it('creates a paused shadow fork; 409 on re-create, refresh re-forks, missing bindings 409', async () => {
    const { app, owner } = await boot();
    const { envId, deviceId } = await createBoundEnv(app, owner);

    const created = await createShadow(app, owner.token, envId);
    expect(created.statusCode).toBe(201);
    const status = created.json();
    expect(status).toMatchObject({
      envId,
      state: 'paused',
      fromCheckpoint: false,
      discardedCommandCount: 0,
    });
    // The subscription's baseline delivery lands right after creation
    // (async) — reality (21.5 °C) flows in without any explicit push.
    const baselineOk = await until(() => {
      const s = getShadowStatusSync(app, envId);
      return s?.observationCount !== undefined && s.observationCount >= 1;
    }, 5000);
    expect(baselineOk).toBe(true);
    expect(status.anchor.simTimeSec).toBe(0);
    expect(status.boundDevices).toEqual([
      expect.objectContaining({
        deviceId,
        entityId: 'sensor.living_room_temperature',
        discardedCommands: 0,
      }),
    ]);
    // …and the baseline observation is attributed to the bound device.
    const afterBaseline = (await getShadow(app, owner.token, envId)).json();
    expect(afterBaseline.boundDevices[0].observations).toBeGreaterThanOrEqual(1);
    // The fork carries the shadow lineage marker and holds a registry sim.
    const row = app.sandboxStore.get(status.sandboxId);
    expect(row?.status).toBe('active');
    expect(JSON.parse(row!.fork_base_json).policy).toMatchObject({ shadow: true });
    expect(app.simulations.get(status.simulationId)).toBeDefined();

    // Re-create without refresh → 409; with refresh → 200 and a NEW fork.
    const conflict = await createShadow(app, owner.token, envId);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('SHADOW_EXISTS');
    const refreshed = await createShadow(app, owner.token, envId, { refresh: true });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().sandboxId).not.toBe(status.sandboxId);
    expect(app.simulations.get(status.simulationId)).toBeUndefined(); // old fork stopped

    // An env without hass:// bindings cannot have a shadow.
    const bareEnv = await app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Bare', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    const bare = await createShadow(app, owner.token, bareEnv.json().id);
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error.code).toBe('SHADOW_NO_BOUND_DEVICES');
  });

  it('mock HA pushes evolve the shadow device state AND physical field, with residuals', async () => {
    const { app, mock: ha, owner } = await boot();
    const { envId, deviceId } = await createBoundEnv(app, owner);
    const created = await createShadow(app, owner.token, envId);
    expect(created.statusCode).toBe(201);
    const { simulationId } = created.json();

    // The subscription's baseline delivery applies the CURRENT reality
    // (21.5 °C in the mock fixture) over the forked base state (20 °C).
    const baselineOk = await until(() => {
      const s = getShadowStatusSync(app, envId);
      return s?.observationCount !== undefined && s.observationCount >= 1;
    }, 5000);
    expect(baselineOk).toBe(true);
    expect(shadowDeviceState(app, simulationId, deviceId)).toMatchObject({ state: 21.5 });

    // A real state change drives both the device state and the zone's
    // physical field (temperature sensor → 'temperature' parameter).
    ha.pushState('sensor.living_room_temperature', '23.7');
    const pushedOk = await until(
      () => shadowDeviceState(app, simulationId, deviceId)?.state === 23.7,
      5000,
    );
    expect(pushedOk).toBe(true);
    expect(shadowZoneParameters(app, simulationId, 'zone-a')).toMatchObject({ temperature: 23.7 });

    // The observation recorded the (predicted, observed) residual pair.
    const status = (await getShadow(app, owner.token, envId)).json();
    expect(status.observationCount).toBeGreaterThanOrEqual(2);
    expect(status.lastObservationAt).not.toBeNull();
    const residual = status.recentObservations.find((o: { changes: { key: string }[] }) =>
      o.changes.some(c => c.key === 'state' && (c as { observed: unknown }).observed === 23.7),
    );
    expect(residual).toBeDefined();
    expect(residual.changes).toContainEqual(
      expect.objectContaining({ key: 'state', observed: 23.7 }),
    );
    // The shadow's sim clock advanced with the observation stream.
    expect(status.simTimeSec).toBeGreaterThan(0);
  });

  it('actuation on a hass-bound device inside the shadow is discarded + counted, never reaching HA', async () => {
    const { app, mock: ha, owner } = await boot();
    const { envId, deviceId } = await createBoundEnv(app, owner);
    const created = await createShadow(app, owner.token, envId);
    const { simulationId } = created.json();

    const record = app.simulations.get(simulationId)!;
    const result = await record.runtime.executeHypotheticalDeviceCommand(deviceId, 'turn-on');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/shadow world: actuation "turn-on" .* discarded/);

    // The fork contains no HADevice at all — nothing reached the mock HA.
    expect(ha.serviceCalls).toHaveLength(0);

    const status = (await getShadow(app, owner.token, envId)).json();
    expect(status.discardedCommandCount).toBe(1);
    expect(status.boundDevices[0]).toMatchObject({ deviceId, discardedCommands: 1 });
  });

  it('E-stop freezes the shadow observation channel (same gate as P1)', async () => {
    const { app, mock: ha, owner } = await boot();
    // Engage BEFORE the shadow exists — otherwise the subscription's
    // baseline delivery races the engage and the outcome is timing.
    await app.inject({ method: 'POST', url: '/api/hass/estop', headers: auth(owner.token) });
    const { envId, deviceId } = await createBoundEnv(app, owner);
    const created = await createShadow(app, owner.token, envId);
    expect(created.statusCode).toBe(201);
    const { simulationId } = created.json();

    // Pushes (incl. the subscription's baseline delivery) are dropped while
    // the stop is engaged — no observation writes at all.
    ha.pushState('sensor.living_room_temperature', '25.1');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(shadowDeviceState(app, simulationId, deviceId)).not.toMatchObject({ state: 25.1 });
    let status = (await getShadow(app, owner.token, envId)).json();
    expect(status.estopActive).toBe(true);
    expect(status.observationCount).toBe(0);

    // Clearing the stop re-enables the channel.
    await app.inject({ method: 'DELETE', url: '/api/hass/estop', headers: auth(owner.token) });
    ha.pushState('sensor.living_room_temperature', '25.1');
    const ok = await until(
      () => shadowDeviceState(app, simulationId, deviceId)?.state === 25.1,
      5000,
    );
    expect(ok).toBe(true);
    status = (await getShadow(app, owner.token, envId)).json();
    expect(status.observationCount).toBeGreaterThanOrEqual(1);
  });

  it('DELETE destroys the fork (GC); environment deletion cascades; boot reaps orphan rows', async () => {
    const { app, owner } = await boot();
    const { envId } = await createBoundEnv(app, owner);
    const created = await createShadow(app, owner.token, envId);
    const { sandboxId, simulationId } = created.json();

    // DELETE: runtime torn down, row stopped, status 404.
    expect((await deleteShadow(app, owner.token, envId)).statusCode).toBe(204);
    expect(app.simulations.get(simulationId)).toBeUndefined();
    expect(app.sandboxStore.get(sandboxId)?.status).toBe('stopped');
    const gone = await getShadow(app, owner.token, envId);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('SHADOW_NOT_FOUND');

    // Environment deletion cascades through the sandbox teardown.
    const env2 = await createBoundEnv(app, owner);
    const created2 = await createShadow(app, owner.token, env2.envId);
    const sim2 = created2.json().simulationId as string;
    const delEnv = await app.inject({
      method: 'DELETE',
      url: `/api/environments/${env2.envId}`,
      headers: auth(owner.token),
    });
    expect(delEnv.statusCode).toBeLessThan(300);
    expect(app.simulations.get(sim2)).toBeUndefined();

    // Boot reap: a shadow-stamped row whose sim is gone is marked stopped.
    const env3 = await createBoundEnv(app, owner);
    const created3 = await createShadow(app, owner.token, env3.envId);
    const row3 = created3.json().sandboxId as string;
    const sim3 = created3.json().simulationId as string;
    // Simulate process death: the registry forgets the sim, the row lingers.
    app.simulations.stopAndRemove(sim3);
    const reaped = app.hassShadow.reapOrphanShadowForks();
    expect(reaped.reaped).toBeGreaterThanOrEqual(1);
    expect(app.sandboxStore.get(row3)?.status).toBe('stopped');
  });

  it('fromCheckpoint forks the authoritative world session\'s current dynamics', async () => {
    const { app, owner } = await boot();
    const { envId, deviceId } = await createBoundEnv(app, owner);
    // Env mutations wake the authoritative world session, so the cheap fork
    // has a live world to copy — the shadow starts "from the world's
    // moment" and is marked accordingly.
    const res = await createShadow(app, owner.token, envId, { fromCheckpoint: true });
    expect(res.statusCode).toBe(201);
    const status = res.json();
    expect(status.fromCheckpoint).toBe(true);
    expect(status.state).toBe('paused');
    expect(status.boundDevices).toEqual([
      expect.objectContaining({ deviceId, entityId: 'sensor.living_room_temperature' }),
    ]);
    const row = app.sandboxStore.get(status.sandboxId);
    expect(JSON.parse(row!.fork_base_json).policy).toMatchObject({ shadow: true, fromCheckpoint: true });
    expect(JSON.parse(row!.fork_base_json).checkpointId).toBeDefined();
  });
});

/** Synchronous shadow status read straight from the service (until() polling). */
function getShadowStatusSync(app: FastifyInstance, envId: string) {
  try {
    return app.hassShadow.status(envId);
  } catch {
    return undefined;
  }
}
