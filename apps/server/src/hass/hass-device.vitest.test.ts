/**
 * @vitest-environment node
 *
 * HADevice + device-factory tests against MockHassServer (no real HA).
 * Covers: cached getState refreshed by pushed state_changed; executeCommand
 * allowlist mapping (the exact call_service JSON reaching HA); read commands
 * answered from cache WITHOUT a service call; unknown commands failing
 * loudly and never reaching HA; offline-entity health gate; unknown-entity
 * build errors from createDeviceFromBinding.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { HAWebSocketConnection } from './connection.js';
import { createDeviceFromBinding, DeviceBindingError } from './device-factory.js';
import { mapHassEntity } from './entity-map.js';
import { HADevice } from './HADevice.js';
import { MockHassServer } from './mock-hass.js';
import type { ScenarioDevice } from '@active-collaboration/core';

const TOKEN = 'test-token';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('waitFor: condition not met within timeout');
}

function makeDevice(
  connection: HAWebSocketConnection,
  entityId: string,
  overrides: { id?: string; staleMs?: number } = {},
): HADevice {
  const entity = connection.getEntity(entityId);
  if (!entity) throw new Error(`fixture entity ${entityId} missing`);
  const mapping = mapHassEntity(entityId, entity.attributes);
  return new HADevice({
    id: overrides.id ?? `dev-${entityId}`,
    name: `Device ${entityId}`,
    zoneId: 'zone-a',
    entityId,
    capabilities: mapping.capabilities,
    connection,
    ...(overrides.staleMs !== undefined ? { staleMs: overrides.staleMs } : {}),
  });
}

describe('HADevice', () => {
  let mock: MockHassServer | undefined;
  let connection: HAWebSocketConnection | undefined;
  const devices: HADevice[] = [];

  async function readyConnection(): Promise<HAWebSocketConnection> {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });
    await connection.connect();
    return connection;
  }

  afterEach(async () => {
    while (devices.length > 0) devices.pop()?.dispose();
    connection?.close();
    connection = undefined;
    await mock?.close();
    mock = undefined;
  });

  it('reads getState() from the cache and follows pushed state_changed', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'sensor.living_room_temperature');
    devices.push(device);

    // Attributes flow through (unit_of_measurement), plus HA raw state.
    expect(device.getState()).toMatchObject({
      entityId: 'sensor.living_room_temperature',
      zoneId: 'zone-a',
      state: '21.5',
      unit_of_measurement: '°C',
      online: true,
    });
    expect(device.type).toBe('sensor');
    expect(device.isOnline()).toBe(true);

    mock!.pushState('sensor.living_room_temperature', '23.1');
    await waitFor(() => device.getState().state === '23.1');
    expect(device.lastHeartbeat.getTime()).toBeGreaterThan(0);
  });

  it('maps set-temperature on climate to the exact call_service JSON', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'climate.living_room_ac');
    devices.push(device);

    const result = await device.executeCommand('set-temperature', { targetTemperature: 22 });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      entityId: 'climate.living_room_ac',
      command: 'set-temperature',
      service: 'climate.set_temperature',
    });
    expect(mock!.serviceCalls).toEqual([
      {
        domain: 'climate',
        service: 'set_temperature',
        target: { entity_id: 'climate.living_room_ac' },
        service_data: { temperature: 22 },
      },
    ]);
  });

  it('turn-on reaches HA and the pushed state updates power', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'light.living_room');
    devices.push(device);
    expect(device.getState().power).toBe(false);

    const result = await device.executeCommand('turn-on');
    expect(result.success).toBe(true);
    expect(mock!.serviceCalls.at(-1)).toMatchObject({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: 'light.living_room' },
    });

    // Mock auto-apply broadcasts the new state through the subscription.
    await waitFor(() => device.getState().power === true);
    expect(device.getState().state).toBe('on');
  });

  it('answers monitoring commands from cache WITHOUT calling HA', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'sensor.living_room_temperature');
    devices.push(device);
    const callsBefore = mock!.serviceCalls.length;

    const result = await device.executeCommand('temperature-monitoring');

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ state: '21.5' });
    expect(mock!.serviceCalls.length).toBe(callsBefore); // nothing sent
  });

  it('fails unknown commands loudly and NEVER sends them to HA', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'climate.living_room_ac');
    devices.push(device);
    const callsBefore = mock!.serviceCalls.length;

    const result = await device.executeCommand('self-destruct');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/self-destruct.*unsupported on HA entity.*climate\.living_room_ac/);
    expect(mock!.serviceCalls.length).toBe(callsBefore); // the safety floor held
  });

  it('refuses actuation while the entity is unavailable', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'light.living_room');
    devices.push(device);

    mock!.pushState('light.living_room', 'unavailable');
    await waitFor(() => !device.isOnline());

    const result = await device.executeCommand('turn-on');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unavailable/);
    expect(mock!.serviceCalls).toEqual([]);
  });

  it('marks the device offline when the state goes stale', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'light.living_room', { staleMs: 50 });
    devices.push(device);
    expect(device.isOnline()).toBe(true);

    // DevLoop R21 test-debt: was a fixed 80ms sleep past the 50ms staleness
    // window — poll for the transition instead (positive condition).
    await waitFor(() => !device.isOnline());
    expect(device.isOnline()).toBe(false);

    // A fresh push revives it.
    mock!.pushState('light.living_room', 'on');
    await waitFor(() => device.isOnline());
  });

  it('reports ExecutionResult metadata (timestamp + executionTime)', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'switch.air_purifier');
    devices.push(device);

    const result = await device.executeCommand('turn-on');
    expect(result.timestamp).toBeInstanceOf(Date);
    expect(result.executionTime).toBeGreaterThanOrEqual(1);
  });

  it('setDevicePosition is a documented no-op', async () => {
    const conn = await readyConnection();
    const device = makeDevice(conn, 'light.living_room');
    devices.push(device);
    expect(() => device.setDevicePosition()).not.toThrow();
  });
});

describe('createDeviceFromBinding', () => {
  let mock: MockHassServer | undefined;
  let connection: HAWebSocketConnection | undefined;

  afterEach(async () => {
    connection?.close();
    connection = undefined;
    await mock?.close();
    mock = undefined;
  });

  const def = (binding: string): ScenarioDevice => ({
    id: 'dev-1',
    name: 'Device 1',
    type: 'light',
    role: 'actuator',
    capabilities: ['lighting-control'],
    zoneId: 'zone-a',
    binding,
  });

  it('throws a clear build error for an entity HA does not have', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });
    await connection.connect();

    expect(() =>
      createDeviceFromBinding(def('hass://light.does_not_exist'), { connection: connection! }),
    ).toThrow(DeviceBindingError);
    expect(() =>
      createDeviceFromBinding(def('hass://light.does_not_exist'), { connection: connection! }),
    ).toThrow(/hass:\/\/ entity "light\.does_not_exist" \(device "dev-1"\) not found/);
  });

  it('builds an HADevice for a known entity and a sim device for sim://', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });
    await connection.connect();

    const haDevice = createDeviceFromBinding(def('hass://light.living_room'), {
      connection: connection!,
    });
    expect(haDevice).toBeInstanceOf(HADevice);
    expect(haDevice.id).toBe('dev-1');
    (haDevice as HADevice).dispose();

    const simDevice = createDeviceFromBinding(def('sim://dev-1'), { connection: connection! });
    expect(simDevice).not.toBeInstanceOf(HADevice);
    expect(simDevice.getState()).toMatchObject({ zoneId: 'zone-a', status: 'active' });
  });

  it('rejects unsupported binding schemes', async () => {
    mock = await MockHassServer.start();
    connection = new HAWebSocketConnection({ url: mock.url, token: TOKEN });
    await connection.connect();

    expect(() =>
      createDeviceFromBinding(def('mqtt://broker/device'), { connection: connection! }),
    ).toThrow(/unsupported binding/);
  });
});
