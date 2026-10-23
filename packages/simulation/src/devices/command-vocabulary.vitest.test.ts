/**
 * @vitest-environment node
 *
 * Fix-44g: capability→command vocabulary alignment.
 *
 * Incident (E2E 2026-08-15): the flow-invoker path expands the 'cooling'
 * capability into the chain set-mode → turn-on → set-temperature
 * (core DeviceResource.resolveMultiCommand), but SimulatedDevice.executeCommand
 * required an EXACT declared-capability match and no handler claimed
 * 'set-mode' — the shipped flow example ("教室高温自动降温") could never
 * actuate an HVAC; the observed cooling came entirely from the agent rule
 * path. The docs' invoke vocabulary ('set-temperature') failed the same way.
 *
 * These tests pin the aligned contract: every command the resource layer can
 * emit is executable on a device declaring only capability names.
 */

import { describe, it, expect } from 'vitest';

import { SimulatedDevice } from './SimulatedDevice.js';

function campusHvac(): SimulatedDevice {
  // Exactly the campus fixture's declaration: capability names ONLY.
  const caps = ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'];
  return new SimulatedDevice({
    id: 'tb1-hvac-f0-1',
    name: '101 教室空调',
    type: 'hvac',
    capabilities: caps.map(name => ({ name, type: 'execute' as const, parameters: [] })),
    initialState: { power: false },
    behaviors: [],
  });
}

describe('Fix-44g: expansion-chain commands execute on capability-name devices', () => {
  it('set-mode {mode:cooling} powers the device and sets the mode', async () => {
    const hvac = campusHvac();
    const result = await hvac.executeCommand('set-mode', { mode: 'cooling' });
    expect(result.success).toBe(true);
    const state = hvac.getState() as unknown as Record<string, unknown>;
    expect(state.mode).toBe('cooling');
    expect(state.power).toBe(true);
  });

  it('the full shipped-example chain lands the setpoint', async () => {
    const hvac = campusHvac();
    // Exactly what DeviceResource.resolveMultiCommand('cooling', {targetTemperature: 26}) emits.
    const step1 = await hvac.executeCommand('set-mode', { mode: 'cooling' });
    const step2 = await hvac.executeCommand('turn-on', {});
    const step3 = await hvac.executeCommand('set-temperature', { temperature: 26 });
    expect(step1.success).toBe(true);
    expect(step2.success).toBe(true);
    expect(step3.success).toBe(true);
    const state = hvac.getState() as unknown as Record<string, unknown>;
    expect(state.mode).toBe('cooling');
    expect(state.power).toBe(true);
    expect(Number(state.targetTemperature)).toBe(26);
  });

  it('set-temperature alone also works (docs invoke vocabulary)', async () => {
    const hvac = campusHvac();
    const result = await hvac.executeCommand('set-temperature', { temperature: 24 });
    expect(result.success).toBe(true);
    expect(Number((hvac.getState() as unknown as Record<string, unknown>).targetTemperature)).toBe(24);
  });

  it('set-mode with an invalid mode fails with the reason (not a silent success)', async () => {
    const hvac = campusHvac();
    const result = await hvac.executeCommand('set-mode', { mode: 'party' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('cooling|heating|auto');
  });

  it('truly unknown commands still bounce with "not found"', async () => {
    const hvac = campusHvac();
    const result = await hvac.executeCommand('make-coffee', {});
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// T-607 (DevLoop R26, GO26-F02 + HO26-F05): the closed mode enum is scoped to
// climate device types — non-climate devices take set-mode generically (any
// non-empty mode string verbatim), so 'turbo' on a purifier or 'track' on a
// tracker no longer fails with the climate vocabulary.
// ---------------------------------------------------------------------------

describe('T-607: set-mode vocabulary follows the device type', () => {
  function device(type: string): SimulatedDevice {
    return new SimulatedDevice({
      id: `dev-${type}`,
      name: `dev ${type}`,
      type,
      capabilities: [
        { name: 'air-purification', type: 'execute' as const, parameters: [] },
        { name: 'set-mode', type: 'execute' as const, parameters: [] },
      ],
      initialState: {},
      behaviors: [],
    });
  }

  it('purifier set-mode {mode:turbo} succeeds and writes the mode verbatim', async () => {
    const purifier = device('air-purifier');
    const result = await purifier.executeCommand('set-mode', { mode: 'turbo' });
    expect(result.success).toBe(true);
    expect((purifier.getState() as unknown as Record<string, unknown>).mode).toBe('turbo');
  });

  it('tracker set-mode {mode:track} succeeds (no set-power rework needed)', async () => {
    const tracker = device('solar-tracker');
    const result = await tracker.executeCommand('set-mode', { mode: 'track' });
    expect(result.success).toBe(true);
    expect((tracker.getState() as unknown as Record<string, unknown>).mode).toBe('track');
  });

  it('UPS set-mode {mode:eco} succeeds', async () => {
    const ups = device('ups');
    const result = await ups.executeCommand('set-mode', { mode: 'eco' });
    expect(result.success).toBe(true);
    expect((ups.getState() as unknown as Record<string, unknown>).mode).toBe('eco');
  });

  it('a non-climate empty mode still fails honestly', async () => {
    const purifier = device('air-purifier');
    const result = await purifier.executeCommand('set-mode', { mode: '' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('non-empty string');
  });

  it('thermostat (climate family) keeps the closed enum teaching', async () => {
    const thermostat = device('thermostat');
    const result = await thermostat.executeCommand('set-mode', { mode: 'turbo' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('cooling|heating|auto');
    const valid = await thermostat.executeCommand('set-mode', { mode: 'cooling' });
    expect(valid.success).toBe(true);
    expect((thermostat.getState() as unknown as Record<string, unknown>).mode).toBe('cooling');
  });
});
