/**
 * @vitest-environment node
 *
 * hass:// end-to-end tests (P3a) — a mixed scenario (one hass:// entity on
 * MockHassServer + one sim:// device) running through the normal engine
 * paths: HTTP create → agents command BOTH backends →
 * device.operation_executed fires for both. Also: unconfigured HA →
 * 503 HASS_NOT_CONFIGURED; unknown entity → 400 HASS_UNKNOWN_ENTITY;
 * sim://-only scenarios never touch the hass path.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { SystemEvent } from '@active-collaboration/core';

import { MockHassServer } from './hass/mock-hass.js';
import { auth, createUserScenario, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

/** One zone pair, one sim sensor, one HA light, one agent driving both. */
function mixedScenario(id: string, hassEntity = 'light.living_room') {
  return {
    version: '1.0',
    meta: { id, name: 'Mixed Sim/HA Lab' },
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
        initialState: { temperature: 20 },
      },
      {
        id: 'ha-light-b',
        type: 'light',
        capabilities: ['lighting-control', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
        binding: `hass://${hassEntity}`,
      },
    ],
    agents: [
      {
        id: 'lab-agent',
        name: 'Lab Agent',
        capabilities: ['temperature-monitoring', 'lighting-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['temp-sensor-a', 'ha-light-b'],
      },
    ],
    events: [],
  };
}

async function uploadScenario(ctx: TestAppContext, scenario: Record<string, unknown>): Promise<void> {
  const res = await createUserScenario(ctx.app, scenario);
  if (res.statusCode !== 201) {
    throw new Error(`scenario upload failed: ${res.statusCode} ${res.body}`);
  }
}

describe('hass:// simulations (end-to-end, mock HA)', () => {
  let ctx: TestAppContext | undefined;
  let mock: MockHassServer | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
    await mock?.close();
    mock = undefined;
  });

  it('runs a mixed sim/hass scenario: agents act on BOTH backends', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({
      hassUrl: mock.url,
      hassToken: 'test-token',
      // P3a connectivity tests: opt OUT of the P3b gate's safe default
      // ('confirm') — these tests assert actuation reaches the socket.
      hassDefaultPolicy: 'allow',
    });
    await uploadScenario(ctx, mixedScenario('mixed-lab'));

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'mixed-lab' },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    // Fix-1: device commands require an authenticated caller.
    const commander = await registerUser(ctx.app, { displayName: 'Commander' });
    const commandHeaders = auth(commander.token);

    // Subscribe to the engine event stream BEFORE issuing commands.
    const events: SystemEvent[] = [];
    const runtime = ctx.app.simulations.getOrThrow(simId).runtime;
    const unsubscribe = runtime.subscribe(event => events.push(event));

    // 1. Command the HA-backed device through the normal engine path.
    const haCommand = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: commandHeaders,
      payload: { deviceId: 'ha-light-b', commandName: 'turn-on' },
    });
    expect(haCommand.statusCode).toBe(200);
    expect(haCommand.json().success).toBe(true);
    // …and HA received the translated service call.
    expect(mock.serviceCalls).toEqual([
      { domain: 'light', service: 'turn_on', target: { entity_id: 'light.living_room' } },
    ]);

    // 2. Command the sim-backed device through the same path.
    const simCommand = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: commandHeaders,
      payload: { deviceId: 'temp-sensor-a', commandName: 'temperature-reading' },
    });
    expect(simCommand.statusCode).toBe(200);
    expect(simCommand.json().success).toBe(true);

    // 3. device.operation_executed fired for BOTH backends.
    const operationEvents = events.filter(e => e.type === 'device.operation_executed');
    const deviceIds = new Set(
      operationEvents.map(e => (e.payload as { deviceId?: string }).deviceId),
    );
    expect(deviceIds).toContain('ha-light-b');
    expect(deviceIds).toContain('temp-sensor-a');
    unsubscribe();

    // 4. Snapshot reflects the HA entity state (mock auto-applied turn_on).
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
    });
    const haLight = (snapshot.json().devices as Array<Record<string, unknown>>)
      .find(d => d.id === 'ha-light-b');
    expect((haLight?.state as Record<string, unknown>).power).toBe(true);
    expect((haLight?.state as Record<string, unknown>).entityId).toBe('light.living_room');
    // …while the sim device keeps its sim state shape.
    const simSensor = (snapshot.json().devices as Array<Record<string, unknown>>)
      .find(d => d.id === 'temp-sensor-a');
    expect(simSensor?.state).toMatchObject({ zoneId: 'zone-a', status: 'active' });

    // 5a. T80 (R9, u2-F1): a command NOT on the device's declared face
    //     ('set-temperature' — ha-light-b declares lighting-control/turn-on/
    //     turn-off) is refused 400 UNKNOWN_COMMAND at the route's equivalence
    //     gate, before any dispatch — never a fake success.
    const unsupported = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: commandHeaders,
      payload: { deviceId: 'ha-light-b', commandName: 'set-temperature', params: { targetTemperature: 18 } },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe('UNKNOWN_COMMAND');
    expect(unsupported.json().error.message).toContain('set-temperature');

    // 5b. The HA device's DECLARED-but-untranslatable commands still fail
    //     loudly at EXECUTION level end-to-end ('lighting-control' is on the
    //     declared face but maps to no HA service for the light domain).
    //    (Fix-1: execution failures come back as a SINGLE-layer
    //    `{ success:false, error }` — the route flattens the engine's old
    //    double-wrap; the important part: it failed and nothing reached HA.)
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: commandHeaders,
      payload: { deviceId: 'ha-light-b', commandName: 'lighting-control' },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().success).toBe(false);
    expect(bad.json().error).toMatch(/unsupported on HA entity/);
    // …and never reached HA (still exactly one recorded call).
    expect(mock.serviceCalls).toHaveLength(1);

    await ctx.app.inject({ method: 'POST', url: `/api/simulations/${simId}/stop` });
  });

  it('sim://-only scenarios build identically with HA configured (no hass path)', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({
      hassUrl: mock.url,
      hassToken: 'test-token',
      // P3a connectivity tests: opt OUT of the P3b gate's safe default
      // ('confirm') — these tests assert actuation reaches the socket.
      hassDefaultPolicy: 'allow',
    });

    const simOnly = mixedScenario('sim-only-lab');
    (simOnly.devices as Array<Record<string, unknown>>)[1].binding = 'sim://ha-light-b';
    await uploadScenario(ctx, simOnly);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'sim-only-lab' },
    });
    expect(created.statusCode).toBe(201);
    // The HA connection was never opened for a sim-only scenario.
    expect(ctx.app.hass.status()).toEqual({ configured: true, state: 'disconnected' });
  });

  it('fails 503 HASS_NOT_CONFIGURED when HA is not configured', async () => {
    ctx = await makeTestApp(); // no HASS_URL/HASS_TOKEN
    await uploadScenario(ctx, mixedScenario('unconfigured-lab'));

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'unconfigured-lab' },
    });
    expect(created.statusCode).toBe(503);
    expect(created.json().error.code).toBe('HASS_NOT_CONFIGURED');
    expect(ctx.app.simulations.list()).toEqual([]); // nothing half-created
  });

  it('fails 400 HASS_UNKNOWN_ENTITY naming the entity', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({ hassUrl: mock.url, hassToken: 'test-token' });
    await uploadScenario(ctx, mixedScenario('ghost-lab', 'light.does_not_exist'));

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'ghost-lab' },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe('HASS_UNKNOWN_ENTITY');
    expect(created.json().error.message).toContain('light.does_not_exist');
    expect(ctx.app.simulations.list()).toEqual([]);
  });
});
