/**
 * @vitest-environment node
 *
 * /api/hass/* route tests — auth required; status reports (never errors on)
 * unconfigured HA; entities proxy + capability preview against MockHassServer;
 * 503s when HA is configured but unreachable.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { executableCommandsForCapabilities } from '@active-collaboration/simulation';

import { MockHassServer } from './hass/mock-hass.js';
import { auth, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('/api/hass routes', () => {
  let ctx: TestAppContext | undefined;
  let mock: MockHassServer | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
    await mock?.close();
    mock = undefined;
  });

  it('requires authentication', async () => {
    ctx = await makeTestApp();
    for (const url of ['/api/hass/status', '/api/hass/entities']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('reports unconfigured status without erroring', async () => {
    ctx = await makeTestApp(); // no HASS_URL/HASS_TOKEN
    const user = await registerUser(ctx.app);

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/status',
      headers: auth(user.token),
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ configured: false, state: 'unconfigured' });

    const entities = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/entities',
      headers: auth(user.token),
    });
    expect(entities.statusCode).toBe(503);
    expect(entities.json().error.code).toBe('HASS_NOT_CONFIGURED');
  });

  it('serves status + entity preview against the mock HA', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
    const user = await registerUser(ctx.app);

    // Status before first use: configured but not yet connected.
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/status',
      headers: auth(user.token),
    });
    expect(before.json()).toEqual({ configured: true, state: 'disconnected' });

    const entities = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/entities',
      headers: auth(user.token),
    });
    expect(entities.statusCode).toBe(200);
    const list = entities.json().entities as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThanOrEqual(10);

    const climate = list.find(e => e.entityId === 'climate.living_room_ac');
    expect(climate).toMatchObject({
      domain: 'climate',
      state: 'cool',
      capabilities: ['temperature-control', 'cooling', 'heating', 'temperature-monitoring'],
    });
    const door = list.find(e => e.entityId === 'binary_sensor.front_door');
    expect(door?.capabilities).toEqual(['contact-monitoring']);

    // Status after first use: ready with the entity count.
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/status',
      headers: auth(user.token),
    });
    expect(after.json()).toMatchObject({ configured: true, state: 'ready' });
    expect((after.json() as { entityCount: number }).entityCount).toBe(list.length);
  });

  it('Fix-18 (R7 F-02): entities carry suggestedCapabilities in the platform command vocabulary', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
    const user = await registerUser(ctx.app);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/entities',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().entities as Array<{
      entityId: string;
      capabilities: string[];
      suggestedCapabilities: string[];
    }>;

    // A light suggests the semantic capabilities PLUS the control verbs —
    // copying it yields a device whose commands are non-empty and
    // executable (the raw `capabilities` copy left `commands: []`).
    const light = list.find(e => e.entityId === 'light.living_room')!;
    expect(light.suggestedCapabilities).toEqual([
      'lighting-control', 'brightness-control', 'turn-on', 'turn-off', 'set-brightness',
    ]);
    expect(executableCommandsForCapabilities(light.suggestedCapabilities)).toEqual(
      expect.arrayContaining(['turn-on', 'turn-off', 'set-brightness']),
    );

    // Monitoring-only entities suggest no control verbs.
    const door = list.find(e => e.entityId === 'binary_sensor.front_door')!;
    expect(door.suggestedCapabilities).toEqual(['contact-monitoring']);
  });

  it('filters entities by domain and query substring', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
    const user = await registerUser(ctx.app);

    const byDomain = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/entities?domain=sensor',
      headers: auth(user.token),
    });
    const sensors = byDomain.json().entities as Array<Record<string, unknown>>;
    expect(sensors.length).toBeGreaterThanOrEqual(3);
    expect(sensors.every(e => e.domain === 'sensor')).toBe(true);

    const byQuery = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/entities?q=curtain',
      headers: auth(user.token),
    });
    expect((byQuery.json().entities as Array<Record<string, unknown>>).map(e => e.entityId))
      .toEqual(['cover.living_room_curtain']);
  });

  it('reports HASS_CONNECT_FAILED when HA is unreachable', async () => {
    // Nothing listens on this port.
    ctx = await makeTestApp({ hassUrl: 'ws://127.0.0.1:1/api/websocket', hassToken: 'test-token' });
    const user = await registerUser(ctx.app);

    const entities = await ctx.app.inject({
      method: 'GET',
      url: '/api/hass/entities',
      headers: auth(user.token),
    });
    expect(entities.statusCode).toBe(503);
    expect(entities.json().error.code).toBe('HASS_CONNECT_FAILED');
  });
});
