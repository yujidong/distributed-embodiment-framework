/**
 * @vitest-environment node
 *
 * EngineRuntime effect-verification tests (Fix-12, R4 陈工 F-15).
 *
 * "Command executed" is not "treatment worked": 8 sim-days of zero cooling
 * had been scored as cooling success (0.75). Now a successfully executed
 * heating/cooling/temperature-control command registers a SIM-time scheduled
 * recheck of the zone temperature; when the value did not move in the
 * commanded direction within the window, the responsible agent takes a
 * reputation FAILURE on the device's temperature-class capabilities.
 * Non-temperature commands keep the old semantics (no recheck).
 *
 * Harness mirrors reputation.vitest.test.ts (same two-zone fixture, same
 * publish seam). The window is shrunk via effectCheckWindowSec and sim time
 * is advanced with step() — no wall-clock waiting.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { EventPriority, EventType } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'effect-check-test', name: 'Effect Check Test Scenario' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
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
  });
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(options?: EngineRuntimeOptions): EngineRuntime {
  const runtime = new EngineRuntime(twoZoneScenario(), {
    effectCheckWindowSec: 5,
    ...options,
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

/** Publish directly on the runtime's bus (in-package test seam). */
function publish(runtime: EngineRuntime, type: EventType, payload: Record<string, unknown>): void {
  const envCenter = (runtime as unknown as {
    envCenter: { eventManager: { publish: (event: unknown) => void } };
  }).envCenter;
  envCenter.eventManager.publish({
    type,
    source: 'effect-check-test',
    payload,
    priority: EventPriority.NORMAL,
    metadata: {},
  });
}

/** Read the current zone temperature through the snapshot surface. */
function zoneTemperature(runtime: EngineRuntime, zoneId: string): number {
  const zone = runtime.getSnapshot().zones.find(z => z.id === zoneId);
  return zone?.parameters.temperature as number;
}

/** Write a zone temperature directly (in-package physics seam). */
function setZoneTemperature(runtime: EngineRuntime, zoneId: string, value: number): void {
  (runtime as unknown as {
    physicalEnv: { setParameterValue: (p: string, l: string, v: number) => void };
  }).physicalEnv.setParameterValue('temperature', zoneId, value);
}

describe('EngineRuntime effect verification (Fix-12)', () => {
  it('records a reputation failure when a cooling command produces no cooling', async () => {
    const runtime = makeRuntime();

    // Command reported EXECUTED (no error) — but nothing actuates, so the
    // zone temperature stays put: the R4 "8 days of zero cooling" shape.
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'cooling',
      result: { ok: true },
    });
    // Not yet due: no judgment before the effect window elapses.
    expect(runtime.getReputation('actuator-agent', 'cooling')).toMatchObject({ attempts: 0 });

    await runtime.step(6); // 6 sim-s > 5 sim-s window

    for (const capability of ['temperature-control', 'cooling']) {
      const cell = runtime.getReputation('actuator-agent', capability);
      if (!Array.isArray(cell)) {
        expect(cell.attempts).toBe(1);
        expect(cell.failures).toBe(1);
        expect(cell.score).toBeCloseTo(3.5 / 6, 5);
      }
    }
    // Non-temperature capabilities of the same device are untouched.
    expect(runtime.getReputation('actuator-agent', 'turn-on')).toMatchObject({ attempts: 0 });
  });

  it('records nothing when the zone temperature actually moved the commanded way', async () => {
    const runtime = makeRuntime();

    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'cooling',
      result: { ok: true },
    });
    // The treatment worked: the zone cooled well below the pre-command value.
    setZoneTemperature(runtime, 'zone-b', zoneTemperature(runtime, 'zone-b') - 3);

    await runtime.step(6);

    expect(runtime.getReputation('actuator-agent')).toEqual([]);
  });

  it('derives the expected direction of setTemperature from the command params', async () => {
    const runtime = makeRuntime();

    // Target 26°C against a ~22°C zone → expected direction UP; no physical
    // effect follows, so this must score as a failure too.
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'setTemperature',
      params: { targetTemperature: 26 },
      result: { ok: true },
    });

    await runtime.step(6);

    const cell = runtime.getReputation('actuator-agent', 'temperature-control');
    if (!Array.isArray(cell)) {
      expect(cell.attempts).toBe(1);
      expect(cell.failures).toBe(1);
    }
  });

  it('ignores non-temperature commands entirely (legacy semantics unchanged)', async () => {
    const runtime = makeRuntime();

    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'turn-on',
      result: { ok: true },
    });

    await runtime.step(6);

    expect(runtime.getReputation('actuator-agent')).toEqual([]);
  });
});
