/**
 * @vitest-environment node
 *
 * Quota tests (P4-4): enforcement of the four quotas with tiny configured
 * limits, the 429 `{error:{code:'QUOTA_EXCEEDED', quota, limit, current}}`
 * shape, and the GET /api/me/quotas introspection payload. Rate limiting is
 * disabled in these apps (test-utils default) so only quotas interfere.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { BuildServerOptions } from './server.js';
import { auth, createUserScenario, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

/** Minimal two-zone scenario (mirrors the simulation suite fixture). */
function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Quota Lab' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
    ],
    events: [],
  };
}

describe('quotas (P4-4)', () => {
  let ctx: TestAppContext | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
  });

  async function setup(overrides: BuildServerOptions = {}) {
    ctx = await makeTestApp(overrides);
    const user = await registerUser(ctx.app);
    return { app: ctx.app, user };
  }

  function createEnv(app: TestAppContext['app'], user: TestUser) {
    return app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(user.token),
      payload: { name: 'Quota World', mapData: { zones: [{ id: 'zone-a' }] } },
    });
  }

  it('environments_per_user: second create within the limit, next one 429s', async () => {
    const { app, user } = await setup({ quotaMaxEnvsPerUser: 2 });
    expect((await createEnv(app, user)).statusCode).toBe(201);
    expect((await createEnv(app, user)).statusCode).toBe(201);

    const limited = await createEnv(app, user);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      quota: 'environments_per_user',
      limit: 2,
      current: 2,
    });
  });

  it('devices_per_env: covers both the plain create and catalog instantiate paths', async () => {
    const { app, user } = await setup({ quotaMaxDevicesPerEnv: 1 });
    const env = await createEnv(app, user);
    const envId = env.json().id as string;

    const first = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(user.token),
      payload: { name: 'Sensor', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
    });
    expect(first.statusCode).toBe(201);

    const plainLimited = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(user.token),
      payload: { name: 'Sensor 2', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
    });
    expect(plainLimited.statusCode).toBe(429);
    expect(plainLimited.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      quota: 'devices_per_env',
      limit: 1,
      current: 1,
    });

    const instantiateLimited = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices:instantiate`,
      headers: auth(user.token),
      payload: { modelId: 'seed-gree-kfr-35gw-yunjia', zoneId: 'zone-a' },
    });
    expect(instantiateLimited.statusCode).toBe(429);
    expect(instantiateLimited.json().error.quota).toBe('devices_per_env');
  });

  it('agents_per_env: create past the limit 429s', async () => {
    const { app, user } = await setup({ quotaMaxAgentsPerEnv: 1 });
    const env = await createEnv(app, user);
    const envId = env.json().id as string;
        // T-206: no bound devices → no declared capabilities (backing rule).
    const payload = { name: 'Agent', capabilities: [] };

    const first = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(user.token),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const limited = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(user.token),
      payload,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      quota: 'agents_per_env',
      limit: 1,
      current: 1,
    });
  });

  it('running_sims_per_user: live sims count; created/stopped do not', async () => {
    const { app, user } = await setup({ quotaMaxRunningSimsPerUser: 1 });
    const seeded = await createUserScenario(app, labScenario('quota-lab'), user.token);
    expect(seeded.statusCode).toBe(201);

    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/simulations',
        headers: auth(user.token),
        payload: { scenarioId: 'quota-lab' },
      });

    // Created-but-never-started does not consume the quota…
    const first = await create();
    expect(first.statusCode).toBe(201);
    const second = await create();
    expect(second.statusCode).toBe(201);
    const simId = second.json().id as string;

    // …but once one is running, the next create is rejected.
    const started = await app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(user.token),
    });
    expect(started.statusCode).toBe(200);

    const limited = await create();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      quota: 'running_sims_per_user',
      limit: 1,
      current: 1,
    });

    // Stopping frees the slot again.
    await app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop`, headers: auth(user.token) });
    expect((await create()).statusCode).toBe(201);

    // Anonymous legacy creations are not attributable → not quota-checked.
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'quota-lab' },
    });
    expect(anonymous.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/api/simulations/${anonymous.json().id}/stop` });
  });

  it('GET /api/me/quotas reports limit + used per quota', async () => {
    const { app, user } = await setup(); // defaults: 20 / 200 / 50 / 3
    const env = await createEnv(app, user);
    const envId = env.json().id as string;
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(user.token),
        payload: { name: `Sensor ${i}`, type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
      });
    }
    await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(user.token),
      // T-206: unbound agents declare no capabilities (backing rule).
      payload: { name: 'Agent', capabilities: [] },
    });
    // P-C: one active sandbox in this env counts toward the per-env quota.
    const sandbox = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(user.token),
      payload: {},
    });
    expect(sandbox.statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: '/api/me/quotas',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quotas).toEqual({
      environmentsPerUser: { limit: 20, used: 1 },
      devicesPerEnv: { limit: 200, used: 2 },
      agentsPerEnv: { limit: 50, used: 1 },
      runningSimsPerUser: { limit: 3, used: 0 },
      sandboxesPerUserPerEnv: { limit: 3, used: 1 },
    });
  });

  it('GET /api/me/quotas requires authentication', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/me/quotas' });
    expect(res.statusCode).toBe(401);
  });
});
