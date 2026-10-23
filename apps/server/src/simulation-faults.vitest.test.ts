/**
 * @vitest-environment node
 *
 * Simulation fault-injection API tests (P3d, no LLM backend, no network).
 *
 * End-to-end: create a simulation → PUT an offline fault on hvac-b → a
 * manual command fails with { success:false, error:'device offline' } and
 * the fault is visible in the snapshot → DELETE the fault → the command
 * works again. Plus the validation/404 edges and the GET faults map.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { auth, createUserScenario, registerUser, type TestUser } from './test-utils.js';

/** Two-zone scenario mirroring the simulation suite's lab fixture. */
function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Fault Lab' },
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
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
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
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  };
}

describe('simulation fault injection API (P3d)', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;
  // Fix-1: device commands require an authenticated caller.
  let commander: TestUser;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'fault-store-test-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'fault-traj-test-'));
    app = await buildServer({ userDir, trajectoryDir, logger: false, databasePath: ':memory:' });
    commander = await registerUser(app, { displayName: 'Commander' });
    const res = await createUserScenario(app, labScenario('fault-lab'), commander.token);
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  async function createSimulation(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'fault-lab' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  function command(simId: string, deviceId: string, commandName: string) {
    return app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(commander.token),
      payload: { deviceId, commandName },
    });
  }

  it('offline fault → command fails with "device offline" → clear → works (end-to-end)', async () => {
    const id = await createSimulation();

    // Healthy baseline: the command succeeds.
    const healthy = await command(id, 'hvac-b', 'turn-on');
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().success).toBe(true);

    // Inject the offline fault.
    const put = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/hvac-b`,
      payload: { offline: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ deviceId: 'hvac-b', fault: { offline: true } });

    // The fault is visible in the snapshot; the reported state is frozen at
    // the fault-set value (power reached true via the healthy command).
    const snapshot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    const hvac = snapshot.json().devices.find((d: { id: string }) => d.id === 'hvac-b');
    expect(hvac.fault).toEqual({ offline: true });
    const frozenState = hvac.state;
    expect(frozenState.power).toBe(true);

    // ...and in the faults map.
    const map = await app.inject({ method: 'GET', url: `/api/simulations/${id}/faults` });
    expect(map.json().faults).toEqual({ 'hvac-b': { offline: true } });

    // A manual command now fails with the device-offline error.
    const offline = await command(id, 'hvac-b', 'turn-on');
    expect(offline.statusCode).toBe(200);
    expect(offline.json().success).toBe(false);
    expect(offline.json().error).toBe('device offline');

    // Even a state-changing command attempt leaves the frozen report untouched.
    const offAttempt = await command(id, 'hvac-b', 'turn-off');
    expect(offAttempt.json().success).toBe(false);
    const stuckSnapshot = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    const stuck = stuckSnapshot.json().devices.find((d: { id: string }) => d.id === 'hvac-b');
    expect(stuck.state).toEqual(frozenState);

    // Other devices are unaffected.
    const sensor = await app.inject({
      method: 'POST',
      url: `/api/simulations/${id}/commands`,
      headers: auth(commander.token),
      payload: { deviceId: 'temp-sensor-a', commandName: 'temperature-reading' },
    });
    expect(sensor.json().success).not.toBe(false);

    // Clear (twice — DELETE is idempotent) → the command works again.
    const clear = await app.inject({
      method: 'DELETE',
      url: `/api/simulations/${id}/faults/hvac-b`,
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toEqual({ deviceId: 'hvac-b', fault: null });
    const clearAgain = await app.inject({
      method: 'DELETE',
      url: `/api/simulations/${id}/faults/hvac-b`,
    });
    expect(clearAgain.statusCode).toBe(200);

    const restored = await command(id, 'hvac-b', 'turn-on');
    expect(restored.json().success).toBe(true);

    const after = await app.inject({ method: 'GET', url: `/api/simulations/${id}/snapshot` });
    const hvacAfter = after.json().devices.find((d: { id: string }) => d.id === 'hvac-b');
    expect(hvacAfter.fault).toBeNull();
    expect(hvacAfter.state.power).toBe(true);
  });

  it('supports combined profiles and replaces them on re-PUT', async () => {
    const id = await createSimulation();

    const put = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/temp-sensor-a`,
      payload: { failureRate: 0.3, latencyMs: 5, staleState: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().fault).toEqual({ failureRate: 0.3, latencyMs: 5, staleState: true });

    // Re-PUT replaces the whole profile.
    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/temp-sensor-a`,
      payload: { staleState: true },
    });
    expect(replaced.json().fault).toEqual({ staleState: true });

    const map = await app.inject({ method: 'GET', url: `/api/simulations/${id}/faults` });
    expect(map.json().faults).toEqual({ 'temp-sensor-a': { staleState: true } });
  });

  it('404s on unknown simulation and unknown device', async () => {
    const id = await createSimulation();

    const noSim = await app.inject({
      method: 'PUT',
      url: '/api/simulations/sim-ghost/faults/hvac-b',
      payload: { offline: true },
    });
    expect(noSim.statusCode).toBe(404);
    expect(noSim.json().error.code).toBe('SIMULATION_NOT_FOUND');

    const noDevice = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/ghost-device`,
      payload: { offline: true },
    });
    expect(noDevice.statusCode).toBe(404);
    expect(noDevice.json().error.code).toBe('DEVICE_NOT_FOUND');

    const noDeviceDelete = await app.inject({
      method: 'DELETE',
      url: `/api/simulations/${id}/faults/ghost-device`,
    });
    expect(noDeviceDelete.statusCode).toBe(404);

    const noSimMap = await app.inject({ method: 'GET', url: '/api/simulations/sim-ghost/faults' });
    expect(noSimMap.statusCode).toBe(404);
  });

  it('400s on invalid fault profiles', async () => {
    const id = await createSimulation();

    const badRate = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/hvac-b`,
      payload: { failureRate: 1.5 },
    });
    expect(badRate.statusCode).toBe(400);

    const badLatency = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/hvac-b`,
      payload: { latencyMs: -10 },
    });
    expect(badLatency.statusCode).toBe(400);

    const badOffline = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/hvac-b`,
      payload: { offline: 'yes' },
    });
    expect(badOffline.statusCode).toBe(400);

    const notAnObject = await app.inject({
      method: 'PUT',
      url: `/api/simulations/${id}/faults/hvac-b`,
      payload: [1, 2],
    });
    expect(notAnObject.statusCode).toBe(400);

    // None of the failed attempts left a fault behind.
    const map = await app.inject({ method: 'GET', url: `/api/simulations/${id}/faults` });
    expect(map.json().faults).toEqual({});
  });
});
