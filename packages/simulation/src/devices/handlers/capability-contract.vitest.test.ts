/**
 * @vitest-environment node
 *
 * Capability → command contract tests ("declared = executable").
 *
 * Regression guard for RC-3 / P1-5: capabilities that device templates and
 * scenario device definitions declare must be executable — either a
 * registered command handler accepts them or they are read/query
 * capabilities. Derived live from the CommandHandlerRegistry (single source
 * of truth), never from a static list.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SimulatedDevice } from '../SimulatedDevice.js';
import {
  acceptedParameterNames,
  isCapabilityExecutable,
  executableCommandsForCapabilities,
  serviceInterfaceForCapabilities,
  validateCommandParams,
} from './capability-contract.js';
import { GenericSetCommandHandler, GENERIC_SET_PARAM_NAMES } from './GenericSetCommandHandler.js';

const templatesDir = join(__dirname, '..', 'templates');

/** Capabilities declared by scenario + catalog hvac definitions (RC-3 dead commands). */
const HVAC_DECLARED_CAPABILITIES = [
  'temperature-control',
  'cooling',
  'heating',
  'turn-on',
  'turn-off',
  'set-temperature',
  'set-mode',
  'set-fan-speed',
];

function createHvac(): SimulatedDevice {
  return new SimulatedDevice({
    id: 'hvac-test-001',
    name: 'Test HVAC',
    type: 'hvac',
    initialState: { zoneId: 'classroom-101', status: 'active' },
    capabilities: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off']
      .map(name => ({ name, type: 'write' as const, parameters: [] })),
    behaviors: [],
    location: 'classroom-101',
  });
}

describe('capability → command contract (declared = executable)', () => {
  it('serviceInterfaceForCapabilities exposes executable actions with parameter hints (Fix-15, F-27)', () => {
    const iface = serviceInterfaceForCapabilities([
      ...HVAC_DECLARED_CAPABILITIES,
      'not-a-command',
    ]);
    const names = iface.actions.map(action => action.name);
    expect(names).toEqual(HVAC_DECLARED_CAPABILITIES); // dead commands filtered, order kept

    const setTemperature = iface.actions.find(action => action.name === 'set-temperature')!;
    expect(setTemperature.parameters.targetTemperature).toMatchObject({ type: 'number' });
    const setMode = iface.actions.find(action => action.name === 'set-mode')!;
    expect(setMode.parameters.mode.enum).toContain('cooling');
    // Commands without hints stay callable, with an empty parameter map.
    const turnOn = iface.actions.find(action => action.name === 'turn-on')!;
    expect(turnOn.parameters).toEqual({});
  });

  it('every hvac-declared capability maps to a handler (was: 3 dead commands)', () => {
    for (const cap of HVAC_DECLARED_CAPABILITIES) {
      expect(isCapabilityExecutable(cap), `capability "${cap}" must be executable`).toBe(true);
    }
    expect(executableCommandsForCapabilities(HVAC_DECLARED_CAPABILITIES))
      .toEqual(HVAC_DECLARED_CAPABILITIES);
  });

  it('every capability in every JSON device template is executable (scan)', () => {
    const templateFiles = readdirSync(templatesDir).filter(f => f.endsWith('.json'));
    expect(templateFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of templateFiles) {
      const template = JSON.parse(readFileSync(join(templatesDir, file), 'utf-8')) as {
        capabilities?: Array<{ name?: string; type?: string } | string>;
      };
      for (const cap of template.capabilities ?? []) {
        const name = typeof cap === 'string' ? cap : cap.name;
        const type = typeof cap === 'string' ? undefined : cap.type;
        if (!name || type === 'read') continue;
        if (!isCapabilityExecutable(name)) {
          violations.push(`${file}: "${name}" has no handler and is not read-only`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('temperature-control executes as set-temperature (state + power-on)', async () => {
    const device = createHvac();

    const result = await device.executeCommand('temperature-control', { target: 24 });

    expect(result.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.targetTemperature).toBe(24);
    expect(state.power).toBe(true);
  });

  it('cooling / heating execute as climate-mode commands', async () => {
    const device = createHvac();

    const cooling = await device.executeCommand('cooling');
    expect(cooling.success).toBe(true);
    let state = device.getState() as unknown as Record<string, unknown>;
    expect(state.mode).toBe('cooling');
    expect(state.power).toBe(true);

    const heating = await device.executeCommand('heating', { target: 21 });
    expect(heating.success).toBe(true);
    state = device.getState() as unknown as Record<string, unknown>;
    expect(state.mode).toBe('heating');
    expect(state.targetTemperature).toBe(21);
  });

  it('getExecutableCommands derives the list from capabilities ∩ handlers', () => {
    const device = createHvac();
    expect(device.getExecutableCommands()).toEqual([
      'temperature-control',
      'cooling',
      'heating',
      'turn-on',
      'turn-off',
    ]);
  });

  it('getExecutableCommands keeps read/query capabilities and drops dead ones', () => {
    const device = new SimulatedDevice({
      id: 'sensor-test-001',
      name: 'Test Sensor',
      type: 'temperature-sensor',
      initialState: {},
      capabilities: [
        { name: 'temperature-reading', type: 'read', parameters: [] },
        { name: 'fictional-actuation', type: 'execute', parameters: [] },
      ],
      behaviors: [],
      location: 'room',
    });
    const commands = device.getExecutableCommands();
    expect(commands).toContain('temperature-reading');
    expect(commands).not.toContain('fictional-actuation');
  });
});

describe('Fix-44j: capability-name actions carry parameter hints', () => {
  it('temperature-control exposes the temperature parameter', () => {
    const iface = serviceInterfaceForCapabilities(['temperature-control', 'cooling', 'turn-on']);
    const temp = iface.actions.find(a => a.name === 'temperature-control')!;
    expect(temp.parameters.temperature).toMatchObject({ type: 'number' });
    const cool = iface.actions.find(a => a.name === 'cooling')!;
    expect(cool.parameters.targetTemperature).toBeDefined();
    // No-param actions stay honestly empty.
    const on = iface.actions.find(a => a.name === 'turn-on')!;
    expect(on.parameters).toEqual({});
  });

  it('set-mode documents its enum', () => {
    const iface = serviceInterfaceForCapabilities(['set-mode']);
    expect(iface.actions[0].parameters.mode.enum).toEqual(expect.arrayContaining(['cooling', 'heating', 'auto']));
  });
});

// ---------------------------------------------------------------------------
// T-506 (EC24-F03) — generic set-* charging spellings + no-op teaching
// ---------------------------------------------------------------------------

function createBattery(): SimulatedDevice {
  return new SimulatedDevice({
    id: 'battery-test-001',
    name: 'Test Battery',
    type: 'battery',
    initialState: { zoneId: 'basement', status: 'active', chargeLevel: 80 },
    capabilities: ['set-charging'].map(name => ({ name, type: 'write' as const, parameters: [] })),
    behaviors: [],
    location: 'basement',
  });
}

describe('T-506: generic set-* charging spellings (declared = executable, usable)', () => {
  it('set-charging {charging}/{enable}/{rate}/{chargingRate} change battery state and succeed', async () => {
    const battery = createBattery();
    const state = () => battery.getState() as unknown as Record<string, unknown>;

    const stop = await battery.executeCommand('set-charging', { charging: false });
    expect(stop.success).toBe(true);
    expect(state().charging).toBe(false);

    const resume = await battery.executeCommand('set-charging', { enable: true });
    expect(resume.success).toBe(true);
    expect(state().charging).toBe(true);

    const rate = await battery.executeCommand('set-charging', { rate: 7.5 });
    expect(rate.success).toBe(true);
    expect(state().chargingRate).toBe(7.5);

    const aliased = await battery.executeCommand('set-charging', { chargingRate: 11 });
    expect(aliased.success).toBe(true);
    expect(state().chargingRate).toBe(11);
  });

  it('the generic set-* no-op failure names the accepted spellings (never a bare shrug)', async () => {
    const battery = createBattery();
    const noOp = await battery.executeCommand('set-charging', { boost: 1 });
    expect(noOp.success).toBe(false);
    const error = String((noOp as { error?: unknown }).error);
    expect(error).toContain('set-charging');
    expect(error).toContain('charging');
    expect(error).toContain('unrecognized params are dropped');
    // R2-FEAT-11: the failure names only spellings that actually change THIS
    // battery's state — 'value' is a type-gated no-op here and must NOT be
    // advertised as usable (that misadvertising is what misled the clinic
    // rounds into {enable}/{power} attempts on sprinklers).
    expect(error).toContain('enable');
    expect(error).not.toContain('value');

    // The deviceType-less oracle keeps the generic handler's full exported
    // spellings (backward-compatible contract for callers without context).
    expect(acceptedParameterNames('set-charging')).toEqual(GENERIC_SET_PARAM_NAMES);
    // Commands with their own hints keep the specific list (no behavior change).
    expect(acceptedParameterNames('set-temperature')).toContain('targetTemperature');
    // Non-set commands without hints still teach nothing (unchanged contract).
    expect(acceptedParameterNames('turn-on')).toBeUndefined();
  });

  it('parity: every exported generic spelling produces a state update from the handler', () => {
    const handler = new GenericSetCommandHandler('parity-device');
    const cases: Array<[string, unknown, string, Record<string, unknown>]> = [
      ['value', 5, 'generic', { value: 0 }],
      ['brightness', 0.6, 'light', {}],
      ['power', false, 'generic', { power: true }],
      ['speed', 3, 'generic', {}],
      ['fanSpeed', 3, 'generic', {}],
      ['targetHumidity', 45, 'humidifier', {}],
      ['target', 22, 'hvac', {}],
      ['targetTemp', 21, 'hvac', {}],
      ['mode', 'cooling', 'hvac', {}],
      ['charging', true, 'generic', {}],
      ['enable', false, 'generic', {}],
      ['rate', 7.5, 'generic', {}],
      ['chargingRate', 11, 'generic', {}],
      ['volume', 30, 'speaker', {}],
    ];
    // The exported list and the parity cases stay in lockstep (R13: the
    // vocabulary lives in exactly one place — the handler — and this test
    // fails the moment either side drifts).
    expect(GENERIC_SET_PARAM_NAMES).toEqual(cases.map(([name]) => name));
    for (const [name, value, deviceType, currentState] of cases) {
      const update = handler.execute({
        commandName: 'set-x',
        params: { [name]: value },
        currentState,
        deviceType,
        deviceId: 'd',
      });
      expect(
        Object.keys(update).length,
        `param "${name}" must produce a state update`,
      ).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // R102 (wang-17): the shared command-parameter validator — one schema for
  // every dispatch lane (invoke gate / sim command / flow node / executor).
  // -------------------------------------------------------------------------

  describe('validateCommandParams (R102)', () => {
    it('a known numeric param with a string value is a VIOLATION naming param/expectation/received', () => {
      const result = validateCommandParams('cooling', { targetTemperature: 'hot' }, 'hvac');
      expect(result.violation).toContain('targetTemperature');
      expect(result.violation).toContain('number');
      expect(result.violation).toContain('"hot"');
    });

    it('out-of-range numbers violate with the range spelled out', () => {
      expect(validateCommandParams('set-temperature', { targetTemperature: 45 }).violation)
        .toContain('[5, 40]');
      expect(validateCommandParams('set-temperature', { targetTemperature: 24 }).violation)
        .toBeUndefined();
      expect(validateCommandParams('set-fan-speed', { speed: 120 }).violation).toContain('[0, 100]');
    });

    it('the set-mode enum is enforced on climate types and free elsewhere (T-607)', () => {
      expect(validateCommandParams('set-mode', { mode: 'party' }, 'hvac').violation)
        .toContain('cooling|heating|auto');
      expect(validateCommandParams('set-mode', { mode: 'turbo' }, 'air-purifier').violation)
        .toBeUndefined();
      expect(validateCommandParams('set-mode', { mode: 'cooling' }, 'hvac').violation)
        .toBeUndefined();
    });

    it('over-cap strings violate; valid messages pass', () => {
      expect(validateCommandParams('emergency-broadcast', { message: 'x'.repeat(600) }).violation)
        .toContain('500');
      expect(validateCommandParams('emergency-broadcast', { message: 'smoke in lab-102' }).violation)
        .toBeUndefined();
      expect(validateCommandParams('emergency-broadcast', { message: 42 }).violation)
        .toContain('expects a string');
    });

    it('unknown params are DROPPED (never applied) and reported, never silently', () => {
      const result = validateCommandParams('cooling', { targetTemperature: 24, frobnicate: 1 });
      expect(result.violation).toBeUndefined();
      expect(result.dropped).toEqual(['frobnicate']);
      // A command with no schema at all drops every param (existing 口径).
      expect(validateCommandParams('turn-off', { anything: 1 }).dropped).toEqual(['anything']);
    });
  });
});
