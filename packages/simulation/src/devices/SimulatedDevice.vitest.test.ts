/**
 * @vitest-environment node
 *
 * Unit Tests for SimulatedDevice.executeCommand()
 *
 * Focus: no-op commands must fail loudly. A command that IS a declared
 * capability but has no registered state handler and produces no state
 * change must return { success: false } instead of silently succeeding.
 * Read/query-type commands legitimately cause no state change and must
 * NOT be flagged.
 */

import { describe, it, expect } from 'vitest';
import { SimulatedDevice } from './SimulatedDevice.js';
import type { SimulatedDeviceConfig } from './types.js';

/**
 * Helper to create a minimal simulated device
 */
function createDevice(overrides: Partial<SimulatedDeviceConfig> = {}): SimulatedDevice {
  return new SimulatedDevice({
    id: 'device-test-001',
    name: 'Test Speaker',
    type: 'speaker',
    initialState: { power: false, volume: 50 },
    capabilities: [
      { name: 'turn-on', type: 'write', parameters: [] },
      { name: 'play-alert', type: 'execute', parameters: [] },
      { name: 'set-volume', type: 'write', parameters: [] },
      { name: 'get-status', type: 'read', parameters: [] },
    ],
    behaviors: [],
    location: 'test-room',
    ...overrides,
  });
}

describe('SimulatedDevice.executeCommand - no-op commands fail loudly', () => {
  it('should fail when a declared capability has no handler and no effect', async () => {
    const device = createDevice({
      capabilities: [{ name: 'fictional-actuation', type: 'execute', parameters: [] }],
    });

    const result = await device.executeCommand('fictional-actuation', { message: 'evacuate' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('no handler / no effect for command fictional-actuation');
  });

  it('should still fail for unknown capabilities (existing behavior preserved)', async () => {
    const device = createDevice();

    const result = await device.executeCommand('nonexistent-command');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should succeed and change state for commands with a registered handler', async () => {
    const device = createDevice();

    const result = await device.executeCommand('turn-on');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect((device.getState() as unknown as Record<string, unknown>).power).toBe(true);
  });

  // T54 (R6, u4-F1): the placeholder oracle — construction initialState keys
  // are NOT "written"; real writes (commands, tick effects) and checkpoint
  // restores are. The server's read gate refuses value metrics aggregated
  // off never-written paths (COMPUTATION_DEVICE_STATE_UNWRITTEN).
  describe('T54: written state paths (placeholder vs measurement)', () => {
    it('a fresh device reports an EMPTY written set — initialState keys are placeholders, not measurements', () => {
      const device = createDevice();
      expect(device.getWrittenStatePaths()).toEqual([]);
    });

    it('executeCommand records the paths it wrote; restoreState marks the restored keys as written', async () => {
      const device = createDevice();
      const result = await device.executeCommand('turn-on');
      expect(result.success).toBe(true);
      expect(device.getWrittenStatePaths()).toContain('power');

      device.restoreState({ power: false, volume: 20, battery: 66 });
      const written = device.getWrittenStatePaths();
      expect(written).toContain('power');
      // Restored keys are authoritative-at-freeze world state, not fresh
      // placeholders — they count as written (the hibernate/resume face).
      expect(written).toContain('volume');
      expect(written).toContain('battery');
      expect((device.getState() as unknown as Record<string, unknown>).volume).toBe(20);
    });
  });

  it('should NOT flag read-type capabilities with no state change', async () => {
    const device = createDevice();

    const result = await device.executeCommand('get-status');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should NOT flag query-style command names even without read-type metadata', async () => {
    const device = createDevice({
      capabilities: [{ name: 'measure-battery', type: 'execute', parameters: [] }],
    });

    const result = await device.executeCommand('measure-battery');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // BUG-04: detect-* is the verb spelling of the same sensing class — the
  // shared read-only predicate (core capabilities/read-only.ts) now backs
  // isReadOnlyCommand, so a smoke detector's declared capability no longer
  // dies with "no handler / no effect".
  it('should NOT flag detect-* command names even without read-type metadata', async () => {
    const device = createDevice({
      capabilities: [{ name: 'detect-smoke', type: 'execute', parameters: [] }],
    });

    const result = await device.executeCommand('detect-smoke');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // And the honest executability surface lists it (as a query).
    expect(device.getExecutableCommands()).toContain('detect-smoke');
  });

  it('set-volume {volume} lands on the speaker state (BUG-06: spelling added)', async () => {
    const device = createDevice();

    // BUG-06: `volume` joined the generic set-* vocabulary — pre-fix, EVERY
    // spelling no-op'd on speakers (the state key is `volume`, and no branch
    // recognized the param).
    const result = await device.executeCommand('set-volume', { volume: 30 });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect((device.getState() as unknown as Record<string, unknown>).volume).toBe(30);
  });

  it('set-volume {value} maps to volume on speaker types (BUG-06: value alias)', async () => {
    const device = createDevice();

    // The generic value fallback only hunts a numeric `target*` key, which
    // speakers don't carry — speaker/audio devices map value → volume, the
    // same precedent as light → brightness.
    const result = await device.executeCommand('set-volume', { value: 30 });

    expect(result.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).volume).toBe(30);
  });

  it('should still flag set-* commands whose params match no known spelling (TASK-001: fake-success fix)', async () => {
    const device = createDevice();

    // GenericSetCommandHandler matches set-*, but { vol: 30 } matches no
    // accepted spelling. TASK-001: handler-matched no-ops are failures too —
    // "I asked for a change, you said success, nothing happened" is a fake
    // success.
    const result = await device.executeCommand('set-volume', { vol: 30 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('no effect');
  });
});

describe('SimulatedDevice.executeCommand - env-bridged light without initialState (DevLoop)', () => {
  // Environment devices created via the API often carry no initialState, so
  // their state has no `brightness` key until the first set-brightness. The
  // command must still work — the capability was declared.
  function createEnvLight(): SimulatedDevice {
    return createDevice({
      id: 'light-env-001',
      name: 'Env Desk Lamp',
      type: 'light',
      initialState: { zoneId: 'zone-office', status: 'active' },
      capabilities: [
        { name: 'turn-on', type: 'write', parameters: [] },
        { name: 'turn-off', type: 'write', parameters: [] },
        { name: 'set-brightness', type: 'write', parameters: [
          { name: 'brightness', type: 'number', required: true },
        ] },
      ],
    });
  }

  it('set-brightness creates the brightness state property dynamically', async () => {
    const device = createEnvLight();
    const result = await device.executeCommand('set-brightness', { brightness: 65 });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect((device.getState() as unknown as Record<string, unknown>).brightness).toBe(65);
  });

  it('set-brightness with brightness:value spelling also lands (TASK-001 alias)', async () => {
    // Env-bridged capabilities carry no parameter schema, so the {value}
    // spelling is NOT bounced by required-param validation — the handler's
    // alias must carry it to the brightness state property.
    const device = createEnvLight();
    (device as unknown as { capabilities: Array<{ name: string; parameters: unknown[] }> })
      .capabilities.find(c => c.name === 'set-brightness')!.parameters = [];
    const result = await device.executeCommand('set-brightness', { value: 40 });
    expect(result.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).brightness).toBe(40);
  });
});

describe('R13 (CB-F01): param-spelling honesty — accepted aliases + teaching failures', () => {
  function createPurifier(): SimulatedDevice {
    return new SimulatedDevice({
      id: 'purifier-r13',
      name: 'Ward Purifier',
      type: 'air-purifier',
      initialState: { zoneId: 'clinic-ward' },
      capabilities: [
        { name: 'air-purification', type: 'write', parameters: [] },
        { name: 'set-fan-speed', type: 'write', parameters: [] },
        { name: 'turn-on', type: 'write', parameters: [] },
      ],
      behaviors: [],
      location: 'clinic-ward',
    });
  }

  it('set-fan-speed accepts the state-property spelling {fanSpeed} (round-13 clinic flow evidence)', async () => {
    const device = createPurifier();
    const result = await device.executeCommand('set-fan-speed', { fanSpeed: 3 });
    expect(result.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).fanSpeed).toBe(3);
  });

  it('set-fan-speed still accepts the canonical {speed}', async () => {
    const device = createPurifier();
    const result = await device.executeCommand('set-fan-speed', { speed: 60 });
    expect(result.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).fanSpeed).toBe(60);
  });

  it('a no-effect failure names the params SENT and the spellings ACCEPTED', async () => {
    const device = createPurifier();
    // A spelling neither the handler nor the hints know.
    const result = await device.executeCommand('set-fan-speed', { level: 'high' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no handler / no effect for command set-fan-speed');
    expect(result.error).toContain('params sent: {level: high}');
    expect(result.error).toContain('params: speed, fanSpeed');
    expect(result.error).toContain('unrecognized params are dropped');
  });
});

describe('T-711 (R29, F5): set-fan-speed implies power-on', () => {
  function createDamper(): SimulatedDevice {
    return new SimulatedDevice({
      id: 'roof-damper',
      name: 'Roof Ventilation Damper',
      type: 'ventilation-damper',
      initialState: { zoneId: 'atrium', power: false },
      capabilities: [
        { name: 'set-fan-speed', type: 'write', parameters: [] },
        { name: 'turn-on', type: 'write', parameters: [] },
      ],
      behaviors: [],
      location: 'atrium',
    });
  }

  it('set-fan-speed from off powers the device on (same precedent as set-temperature)', async () => {
    const device = createDamper();
    const result = await device.executeCommand('set-fan-speed', { speed: 2 });
    expect(result.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    // Before T-711 the damper ended power:false, fanSpeed:2 — state written,
    // physics inert (F5).
    expect(state.fanSpeed).toBe(2);
    expect(state.power).toBe(true);
    expect(state.status).toBe('on');
  });

  it('the {fanSpeed} alias also powers on', async () => {
    const device = createDamper();
    const result = await device.executeCommand('set-fan-speed', { fanSpeed: 3 });
    expect(result.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.fanSpeed).toBe(3);
    expect(state.power).toBe(true);
  });

  it('an explicit power param in the same command still wins', async () => {
    const device = createDamper();
    const result = await device.executeCommand('set-fan-speed', { speed: 2, power: false });
    expect(result.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.fanSpeed).toBe(2);
    expect(state.power).toBe(false);
  });
});

describe('R13 (CB-F04): actuation syncs the tracked `powered` initialState key', () => {
  function createPaSpeaker(): SimulatedDevice {
    return new SimulatedDevice({
      id: 'pa-r13',
      name: 'Ward A PA Speaker',
      type: 'smart-plug',
      // Exactly the round-13 clinic device: initialState keyed on `powered`.
      initialState: { powered: false },
      capabilities: [
        { name: 'power-control', type: 'write', parameters: [] },
        { name: 'turn-on', type: 'write', parameters: [] },
        { name: 'turn-off', type: 'write', parameters: [] },
      ],
      behaviors: [],
      location: 'clinic-ward',
    });
  }

  it('turn-on flips powered alongside power/status (no stale dual truth)', async () => {
    const device = createPaSpeaker();
    const result = await device.executeCommand('turn-on');
    expect(result.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.power).toBe(true);
    expect(state.status).toBe('on');
    expect(state.powered).toBe(true);
  });

  it('turn-off flips powered back (and toggle reads it)', async () => {
    const device = createPaSpeaker();
    await device.executeCommand('turn-on');
    const off = await device.executeCommand('turn-off');
    expect(off.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).powered).toBe(false);

    // A device tracking ONLY `powered` toggles from its value.
    const toggled = await device.executeCommand('toggle');
    expect(toggled.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).powered).toBe(true);
  });
});

describe('R13 (CB-F01 same class): set-humidity accepts the documented targetHumidity spelling', () => {
  it('set-humidity {targetHumidity} lands on a humidifier-typed device', async () => {
    const device = new SimulatedDevice({
      id: 'hum-r13',
      name: 'Ward Humidifier',
      type: 'humidifier',
      initialState: {},
      capabilities: [{ name: 'set-humidity', type: 'write', parameters: [] }],
      behaviors: [],
      location: 'clinic-ward',
    });
    const result = await device.executeCommand('set-humidity', { targetHumidity: 55 });
    expect(result.success).toBe(true);
    expect((device.getState() as unknown as Record<string, unknown>).targetHumidity).toBe(55);
  });
});
