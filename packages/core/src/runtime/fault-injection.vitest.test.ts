/**
 * @vitest-environment node
 *
 * EngineRuntime failure-mode injection tests (P3d, no LLM, no network).
 *
 * Scenario: the same two-zone fixture as the EngineRuntime suite — a sensor
 * agent in zone A and an actuator agent in zone B (hvac-b). Faults are set
 * on hvac-b and observed through the runtime's public surface:
 * executeDeviceCommand (manual path, same seam the DeviceCommandCoordinator
 * uses for agent/AC-initiated commands), getSnapshot (state + fault
 * exposure), and the event stream (device.fault_changed transitions).
 *
 * Every runtime is stop()ed after each test — clean shutdown is part of the
 * contract (vitest must exit without dangling handles).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { EventType, type SystemEvent } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions, type FaultProfile } from './index.js';

// ---------------------------------------------------------------------------
// Scenario + helpers (mirrors EngineRuntime.vitest.test.ts)
// ---------------------------------------------------------------------------

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'fault-test', name: 'Fault Injection Test Scenario' },
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
  const runtime = new EngineRuntime(twoZoneScenario(), options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

function deviceSnapshot(runtime: EngineRuntime, deviceId: string) {
  const device = runtime.getSnapshot().devices.find(d => d.id === deviceId);
  if (!device) throw new Error(`device ${deviceId} missing from snapshot`);
  return device;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngineRuntime fault injection (P3d)', () => {
  it('leaves devices fault-free by default (no behavioral change)', async () => {
    const runtime = makeRuntime();

    expect(runtime.getDeviceFault('hvac-b')).toBeNull();
    expect(runtime.listDeviceFaults()).toEqual({});
    expect(deviceSnapshot(runtime, 'hvac-b').fault).toBeNull();

    const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(result.success).toBe(true);
    expect(deviceSnapshot(runtime, 'hvac-b').state.power).toBe(true);
  });

  it('offline: every command fails with "device offline" and state is frozen', async () => {
    const runtime = makeRuntime();
    const before = deviceSnapshot(runtime, 'hvac-b').state;

    runtime.setDeviceFault('hvac-b', { offline: true });
    expect(runtime.getDeviceFault('hvac-b')).toEqual({ offline: true });
    expect(deviceSnapshot(runtime, 'hvac-b').fault).toEqual({ offline: true });

    const on = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(on.success).toBe(false);
    expect(on.error).toBe('device offline');

    // The command never reached the device; the reported state is the
    // last-known state frozen at fault-set time.
    expect(deviceSnapshot(runtime, 'hvac-b').state).toEqual(before);

    // Clearing the fault restores normal operation.
    runtime.setDeviceFault('hvac-b', null);
    expect(runtime.getDeviceFault('hvac-b')).toBeNull();
    expect(deviceSnapshot(runtime, 'hvac-b').fault).toBeNull();
    const retry = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(retry.success).toBe(true);
    expect(deviceSnapshot(runtime, 'hvac-b').state.power).toBe(true);
  });

  it('failureRate 1 fails every command with "intermittent failure"; 0 never does', async () => {
    const runtime = makeRuntime();

    runtime.setDeviceFault('hvac-b', { failureRate: 1 });
    const fail = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(fail.success).toBe(false);
    expect(fail.error).toBe('intermittent failure');

    runtime.setDeviceFault('hvac-b', { failureRate: 0 });
    const ok = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(ok.success).toBe(true);
  });

  it('failureRate is reproducible with a fixed faultSeed', async () => {
    const profile: FaultProfile = { failureRate: 0.5 };
    const runOnce = async (): Promise<boolean[]> => {
      const runtime = makeRuntime({ faultSeed: 42 });
      runtime.setDeviceFault('hvac-b', profile);
      const outcomes: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
        outcomes.push(result.success);
      }
      return outcomes;
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first).toEqual(second);
    // With rate 0.5 over 12 draws, an all-success or all-failure sequence is
    // a broken RNG (probability 2·2⁻¹² with a working one).
    expect(first.some(Boolean)).toBe(true);
    expect(first.some(s => !s)).toBe(true);
  });

  it('latencyMs delays command execution (async)', async () => {
    const runtime = makeRuntime();
    runtime.setDeviceFault('hvac-b', { latencyMs: 120 });

    const start = Date.now();
    const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(100); // small slack for timer jitter
  });

  it('staleState: commands execute but getState reports the frozen state', async () => {
    const runtime = makeRuntime();
    const before = deviceSnapshot(runtime, 'hvac-b').state;

    runtime.setDeviceFault('hvac-b', { staleState: true });

    // Actuation still works (the device received the command)...
    const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(result.success).toBe(true);

    // ...but state reporting is stuck at the fault-set snapshot.
    expect(deviceSnapshot(runtime, 'hvac-b').state).toEqual(before);

    // Clearing unsticks reporting; the real (changed) state surfaces.
    runtime.setDeviceFault('hvac-b', null);
    expect(deviceSnapshot(runtime, 'hvac-b').state.power).toBe(true);
  });

  it('narrates fault-caused command failures on the bus (device.error)', async () => {
    const runtime = makeRuntime();
    const received: SystemEvent[] = [];
    const unsubscribe = runtime.subscribe(event => received.push(event));

    runtime.setDeviceFault('hvac-b', { offline: true });
    const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(result.success).toBe(false);
    unsubscribe();

    // The fault seam emits device.error so every command path (coordinator
    // AND agent-internal ACExecutor paths) is narrated in the episode log.
    const errors = received.filter(e => e.type === EventType.DEVICE_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({
      deviceId: 'hvac-b',
      commandName: 'turn-on',
      error: 'device offline',
      fault: { offline: true },
    });
  });

  it('emits device.fault_changed on set and clear (and not on no-op re-apply)', async () => {
    const runtime = makeRuntime();
    const received: SystemEvent[] = [];
    const unsubscribe = runtime.subscribe(event => received.push(event));

    runtime.setDeviceFault('hvac-b', { offline: true });
    runtime.setDeviceFault('hvac-b', { offline: true }); // identical → no transition
    runtime.setDeviceFault('hvac-b', null);
    runtime.setDeviceFault('hvac-b', null); // already clear → no transition
    unsubscribe();

    const events = received.filter(e => e.type === EventType.DEVICE_FAULT_CHANGED);
    expect(events).toHaveLength(2);
    expect(events[0].payload).toEqual({ deviceId: 'hvac-b', profile: { offline: true } });
    expect(events[1].payload).toEqual({ deviceId: 'hvac-b', profile: null });
  });

  it('rejects unknown devices and invalid profiles', () => {
    const runtime = makeRuntime();

    expect(() => runtime.setDeviceFault('ghost', { offline: true })).toThrow(/unknown device/);
    expect(() => runtime.setDeviceFault('hvac-b', { failureRate: 1.5 })).toThrow(/failureRate/);
    expect(() => runtime.setDeviceFault('hvac-b', { failureRate: -0.1 })).toThrow(/failureRate/);
    expect(() => runtime.setDeviceFault('hvac-b', { latencyMs: -5 })).toThrow(/latencyMs/);
    expect(() =>
      runtime.setDeviceFault('hvac-b', { offline: 'yes' } as unknown as FaultProfile),
    ).toThrow(/offline/);

    // Failed validation leaves no fault behind.
    expect(runtime.listDeviceFaults()).toEqual({});
  });

  it('lists all active faults and combines fault modes', async () => {
    const runtime = makeRuntime();

    runtime.setDeviceFault('hvac-b', { latencyMs: 10, staleState: true });
    runtime.setDeviceFault('temp-sensor-a', { offline: true });

    expect(runtime.listDeviceFaults()).toEqual({
      'hvac-b': { latencyMs: 10, staleState: true },
      'temp-sensor-a': { offline: true },
    });

    // staleState + latency: slow but successful command, frozen reporting.
    const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(result.success).toBe(true);
    expect(deviceSnapshot(runtime, 'hvac-b').state.power).not.toBe(true);
  });
});
