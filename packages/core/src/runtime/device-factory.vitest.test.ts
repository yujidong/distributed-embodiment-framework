/**
 * @vitest-environment node
 *
 * EngineRuntime deviceFactory extension-point tests (P3a, no LLM/network).
 *
 * Covers: the factory is honored for EVERY device when provided (including
 * sim:// defs); hass:// bindings load and reach the factory verbatim; the
 * default path (no factory) is byte-for-byte the old behavior — even a
 * hass:// binding builds as a SimulatedDevice; factory throws propagate at
 * build time; device dispose() hooks run on stop().
 *
 * Every runtime is stop()ed after each test — clean shutdown is part of the
 * contract (vitest must exit without dangling handles).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile, type ScenarioDevice } from '../scenario/index.js';
import {
  EngineRuntime,
  createSimulatedDevice,
  type RuntimeDevice,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mixedBindingScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'factory-test', name: 'Device Factory Test' },
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
        // no binding → defaults to sim://temp-sensor-a
      },
      {
        id: 'light-b',
        type: 'light',
        capabilities: ['lighting-control'],
        zoneId: 'zone-b',
        binding: 'hass://light.living_room',
      },
    ],
    agents: [
      {
        id: 'agent-1',
        name: 'Agent',
        capabilities: ['temperature-monitoring', 'lighting-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['temp-sensor-a', 'light-b'],
      },
    ],
    events: [],
  });
}

/**
 * Structural stand-in for a bridge device (mirrors what HADevice provides):
 * the Device fields the environment/agent layer touches plus the runtime
 * surface (getState/executeCommand/dispose).
 */
class StubDevice {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly location: string;
  readonly status = 'online';
  readonly capabilities: Array<{ name: string; type: 'read' | 'write' | 'execute'; parameters: [] }> = [];
  readonly services: unknown[] = [];
  readonly metadata: Record<string, unknown> = {};
  readonly connectionInfo = { protocol: 'websocket' as const, endpoint: 'stub://device' };
  lastHeartbeat = new Date();

  executed: Array<{ commandName: string; params?: Record<string, unknown> }> = [];
  disposed = false;

  constructor(def: ScenarioDevice) {
    this.id = def.id;
    this.name = def.name;
    this.type = def.type;
    this.location = def.zoneId;
  }

  getState(): Record<string, unknown> {
    return { stub: true, entityId: `stub://${this.id}` };
  }

  async executeCommand(commandName: string, params?: Record<string, unknown>) {
    this.executed.push({ commandName, ...(params !== undefined ? { params } : {}) });
    return { success: true, result: { stub: true }, timestamp: new Date(), executionTime: 1 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngineRuntime deviceFactory', () => {
  let runtime: EngineRuntime | undefined;

  afterEach(() => {
    runtime?.stop();
    runtime = undefined;
  });

  it('default path (no factory) builds sim devices — even for hass:// bindings', () => {
    runtime = new EngineRuntime(mixedBindingScenario());

    const snapshot = runtime.getSnapshot();
    const sensor = snapshot.devices.find(d => d.id === 'temp-sensor-a');
    const light = snapshot.devices.find(d => d.id === 'light-b');

    // Sim construction signature: zoneId + status seeded into initial state.
    expect(sensor?.state).toMatchObject({ zoneId: 'zone-a', status: 'active' });
    expect(light?.state).toMatchObject({ zoneId: 'zone-b', status: 'active' });
    expect(light?.state.stub).toBeUndefined();
  });

  it('honors the factory for EVERY device and routes commands to it', async () => {
    const seen: ScenarioDevice[] = [];
    const stubs = new Map<string, StubDevice>();
    runtime = new EngineRuntime(mixedBindingScenario(), {
      deviceFactory: def => {
        seen.push(def);
        const stub = new StubDevice(def);
        stubs.set(def.id, stub);
        return stub;
      },
    });

    // Factory saw both defs, in scenario order, with bindings resolved.
    expect(seen.map(d => d.id)).toEqual(['temp-sensor-a', 'light-b']);

    // Snapshot state comes from the factory-built devices.
    const snapshot = runtime.getSnapshot();
    for (const device of snapshot.devices) {
      expect(device.state).toMatchObject({ stub: true });
    }

    // Commands flow through the normal agent path into the factory device.
    const result = await runtime.executeDeviceCommand('light-b', 'turn-on', { brightness: 80 });
    expect(result.success).toBe(true);
    expect(stubs.get('light-b')?.executed).toEqual([
      { commandName: 'turn-on', params: { brightness: 80 } },
    ]);
    expect(stubs.get('temp-sensor-a')?.executed).toEqual([]);
  });

  it('passes hass:// bindings to the factory verbatim', () => {
    const seen: ScenarioDevice[] = [];
    runtime = new EngineRuntime(mixedBindingScenario(), {
      deviceFactory: def => {
        seen.push(def);
        return new StubDevice(def);
      },
    });

    const light = seen.find(d => d.id === 'light-b');
    const sensor = seen.find(d => d.id === 'temp-sensor-a');
    expect(light?.binding).toBe('hass://light.living_room');
    expect(sensor?.binding).toBe('sim://temp-sensor-a'); // loader default
  });

  it('propagates factory errors at build time with the device id', () => {
    expect(
      () =>
        new EngineRuntime(mixedBindingScenario(), {
          deviceFactory: def => {
            if (def.binding.startsWith('hass://')) {
              throw new Error(`unknown hass entity for device "${def.id}"`);
            }
            return createSimulatedDevice(def);
          },
        }),
    ).toThrow(/unknown hass entity.*light-b/);
  });

  it('runs device dispose() hooks on stop()', () => {
    const stubs: StubDevice[] = [];
    runtime = new EngineRuntime(mixedBindingScenario(), {
      deviceFactory: def => {
        const stub = new StubDevice(def);
        stubs.push(stub);
        return stub;
      },
    });

    runtime.stop();
    expect(stubs.map(s => s.disposed)).toEqual([true, true]);
    runtime = undefined; // already stopped
  });

  it('createSimulatedDevice builds the same device the default path uses', () => {
    const scenario = mixedBindingScenario();
    const device = createSimulatedDevice(scenario.devices[0]) as RuntimeDevice & {
      getState(): Record<string, unknown>;
    };
    expect(device.id).toBe('temp-sensor-a');
    expect(device.getState()).toMatchObject({ zoneId: 'zone-a', status: 'active' });
  });
});
