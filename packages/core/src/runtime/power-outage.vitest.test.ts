/**
 * @vitest-environment node
 *
 * T-103 (DevLoop R32, F-PH21) — power-outage physical envelope, no LLM.
 *
 * R29 measured: a `power-outage` event was accepted and routed to agents but
 * physically inert (zero device status changes, energy kept metering,
 * displays stayed on). The envelope must make it REAL:
 *   - every electric device in the event zone loses power (state.power=false
 *     + a visible powerOutage marker) for the event's duration;
 *   - energy freezes (0 W draw while cut off);
 *   - commands to cut-off devices fail with the outage named;
 *   - restore is GRADUAL (one device per restore step, pre-outage power
 *     state returned);
 *   - devices OUTSIDE the zone are untouched, and the grid_power parameter
 *     write still lands (agent triggers can watch it).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';
import { PowerOutageState, POWER_RESTORE_STAGGER_SEC } from './power-outage.js';

function outageScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'outage-test', name: 'Power Outage Test Scenario' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'hvac-a1',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
      {
        id: 'display-a2',
        type: 'display',
        capabilities: ['information-display', 'turn-on', 'turn-off'],
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
        id: 'agent-a',
        name: 'Agent A',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a1', 'display-a2'],
      },
      {
        id: 'agent-b',
        name: 'Agent B',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(): EngineRuntime {
  const runtime = new EngineRuntime(outageScenario());
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

function deviceState(runtime: EngineRuntime, deviceId: string): Record<string, unknown> {
  const device = runtime.getSnapshot().devices.find(d => d.id === deviceId);
  if (!device) throw new Error(`device ${deviceId} missing from snapshot`);
  return device.state as Record<string, unknown>;
}

describe('PowerOutageState (pure state machine)', () => {
  it('cuts off for the duration, restores gradually, then drops the envelope', () => {
    const outages = new PowerOutageState();
    outages.begin('zone-a', 100, 60, [
      { deviceId: 'd1', powered: true },
      { deviceId: 'd2', powered: true },
      { deviceId: 'd3', powered: false }, // was already off — stays off
    ]);

    // Active window: force-off every tick (idempotent).
    expect(outages.tick(120)).toEqual([
      { deviceId: 'd1', powered: false, zoneId: 'zone-a' },
      { deviceId: 'd2', powered: false, zoneId: 'zone-a' },
      { deviceId: 'd3', powered: false, zoneId: 'zone-a' },
    ]);
    expect(outages.isDeviceCutOff('d1', 120)).toBe(true);

    // At end (160): no more cut-offs; staggered restores begin.
    expect(outages.tick(160)).toEqual([]); // d1 restores at 162, d2 at 164, d3 at 166
    expect(outages.isDeviceCutOff('d1', 160)).toBe(false); // restoring — commands pass

    expect(outages.tick(162)).toEqual([{ deviceId: 'd1', powered: true, zoneId: 'zone-a' }]);
    expect(outages.tick(163)).toEqual([]); // not d2's turn yet
    expect(outages.tick(164)).toEqual([{ deviceId: 'd2', powered: true, zoneId: 'zone-a' }]);
    expect(outages.tick(166)).toEqual([{ deviceId: 'd3', powered: false, zoneId: 'zone-a' }]);

    // Everything restored → the envelope is gone.
    expect(outages.tick(200)).toEqual([]);
    expect(outages.active()).toEqual([]);
  });

  it('restores in declaration order (deterministic stagger schedule)', () => {
    const outages = new PowerOutageState();
    const envelope = outages.begin('zone-a', 0, 10, [
      { deviceId: 'a', powered: true },
      { deviceId: 'b', powered: true },
    ]);
    expect(envelope.devices.map(d => [d.deviceId, d.restoreAtSimSec])).toEqual([
      ['a', 10 + POWER_RESTORE_STAGGER_SEC],
      ['b', 10 + 2 * POWER_RESTORE_STAGGER_SEC],
    ]);
  });

  it('a re-injected outage on the same zone replaces the pending envelope', () => {
    const outages = new PowerOutageState();
    outages.begin('zone-a', 0, 10, [{ deviceId: 'd1', powered: true }]);
    outages.begin('zone-a', 5, 100, [{ deviceId: 'd1', powered: true }]);
    expect(outages.active()).toHaveLength(1);
    expect(outages.active()[0]!.endSimSec).toBe(105);
  });
});

describe('EngineRuntime power-outage envelope (T-103)', () => {
  it('devices in the zone lose power immediately; other zones untouched', async () => {
    const runtime = makeRuntime();
    await runtime.executeDeviceCommand('hvac-a1', 'turn-on');
    await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    await runtime.executeDeviceCommand('display-a2', 'turn-on');

    await runtime.injectEvent({ type: 'power-outage', zoneId: 'zone-a', durationSec: 60 });

    // The zone's devices are dead and visibly so.
    expect(deviceState(runtime, 'hvac-a1').power).toBe(false);
    expect(deviceState(runtime, 'hvac-a1').powerOutage).toBe(true);
    expect(deviceState(runtime, 'display-a2').power).toBe(false);
    expect(deviceState(runtime, 'display-a2').powerOutage).toBe(true);
    // The neighbor zone keeps running.
    expect(deviceState(runtime, 'hvac-b').power).toBe(true);
    expect(deviceState(runtime, 'hvac-b').powerOutage).toBeUndefined();
  });

  it('commands to cut-off devices fail with the outage named', async () => {
    const runtime = makeRuntime();
    await runtime.injectEvent({ type: 'power-outage', zoneId: 'zone-a', durationSec: 60 });

    const result = await runtime.executeDeviceCommand('hvac-a1', 'turn-on');
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('unpowered');
    expect(String(result.error)).toContain('power outage');

    // A device outside the outage still obeys.
    const ok = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(ok.success).toBe(true);
  });

  it('energy freezes while cut off and resumes after restore', async () => {
    const runtime = makeRuntime();
    await runtime.executeDeviceCommand('hvac-a1', 'turn-on');
    await runtime.step(5);
    const duringPre = deviceState(runtime, 'hvac-a1').cumulativeEnergyWh as number;

    await runtime.injectEvent({ type: 'power-outage', zoneId: 'zone-a', durationSec: 30 });
    await runtime.step(5); // 5 sim-s inside the outage
    const duringPost = deviceState(runtime, 'hvac-a1').cumulativeEnergyWh as number;
    expect(duringPost).toBe(duringPre); // frozen — 0 W while unpowered

    // Step past end + stagger (30 + 2) so hvac-a1 (first in the zone) restores.
    await runtime.step(35);
    const restored = deviceState(runtime, 'hvac-a1');
    expect(restored.power).toBe(true);
    expect(restored.powerOutage).toBeUndefined();
    await await runtime.step(5); // metering resumes
    expect(deviceState(runtime, 'hvac-a1').cumulativeEnergyWh as number)
      .toBeGreaterThan(duringPost);
  });

  it('restore is gradual — one device per restore step', async () => {
    const runtime = makeRuntime();
    await runtime.executeDeviceCommand('hvac-a1', 'turn-on');
    await runtime.executeDeviceCommand('display-a2', 'turn-on');
    await runtime.injectEvent({ type: 'power-outage', zoneId: 'zone-a', durationSec: 20 });

    await runtime.step(20); // exactly at end — nothing restored yet
    expect(deviceState(runtime, 'hvac-a1').power).toBe(false);
    // eslint-disable-next-line no-console

    await runtime.step(2); // +2s: first zone device (hvac-a1) restores
    // eslint-disable-next-line no-console
    expect(deviceState(runtime, 'hvac-a1').power).toBe(true);
    expect(deviceState(runtime, 'display-a2').power).toBe(false);

    await runtime.step(2); // +4s: second device (display-a2) restores
    expect(deviceState(runtime, 'display-a2').power).toBe(true);
  });

  it('the grid_power physical write lands (trigger-visible) and transitions narrate on the bus', async () => {
    const runtime = makeRuntime();
    const powerEvents: Array<Record<string, unknown>> = [];
    runtime.subscribe(event => {
      if ((event.metadata as Record<string, unknown> | undefined)?.eventType === 'device.power') {
        powerEvents.push(event.payload as Record<string, unknown>);
      }
    });

    const result = await runtime.injectEvent({ type: 'power-outage', zoneId: 'zone-a' });
    expect(result.parameter).toBe('grid_power');
    expect(result.value).toBe(0);

    // The cut-off transitions are real device-state events (F-PH21's
    // complaint was "zero device status changes").
    expect(powerEvents.length).toBe(2); // hvac-a1 + display-a2
    expect(powerEvents.every(p => p.power === false && p.reason === 'power-outage')).toBe(true);
  });
});
