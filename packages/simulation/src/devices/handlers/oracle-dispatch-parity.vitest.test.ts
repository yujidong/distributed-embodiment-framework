/**
 * T-056 — executability oracle vs runtime dispatch parity (hardening).
 *
 * Zero live sightings across four exploration rounds, but the two sides were
 * only incidentally aligned: the oracle (isCapabilityExecutable) answers from
 * its OWN CommandHandlerRegistry instance while every device dispatches
 * through a per-device instance of the same class — a handler registered at
 * runtime (registerHandler, the extension point T-034's effect models will
 * use) would have executed on devices while validation kept rejecting it.
 *
 * The shared contract (this file pins it): registering a handler on ANY
 * registry instance IS oracle coverage — registerHandler records the handler
 * in the module-level source isCapabilityExecutable consults.
 *
 * Two tests:
 * 1. the SWEEP — for a corpus of every capability name the platform knows
 *    (all device-template capabilities + the command families the handlers
 *    recognize + known dead marketing names), a fresh registry's handler
 *    verdict and the oracle's verdict must agree exactly (modulo the
 *    documented read/query class);
 * 2. the CANARY — registering a fake handler on a device-style registry
 *    flips the oracle, or the test fails.
 */

import { describe, afterEach, it, expect } from 'vitest';

import { DeviceTemplateRegistry } from '../../registry/DeviceTemplateRegistry.js';
import type { CommandHandler } from './CommandHandler.js';
import {
  CommandHandlerRegistry,
  _resetCustomCommandHandlersForTests,
} from './CommandHandlerRegistry.js';
import {
  isCapabilityExecutable,
  isReadOnlyCapabilityName,
} from './capability-contract.js';
import {
  executableCommandPath,
  multiCommandNamesForDeviceType,
  capabilityNameToDeviceCapability,
  isReadOnlyCapabilityName as coreIsReadOnlyCapabilityName,
} from '@active-collaboration/core';

afterEach(() => {
  // The canary mutates the shared handler source — keep it test-local.
  _resetCustomCommandHandlersForTests();
});

/** The command families the built-in handlers recognize by pattern. */
const HANDLER_FAMILY_PROBES: string[] = [
  // PowerCommandHandler
  'turn-on', 'turn-off', 'power-on', 'power-off', 'switch-on', 'switch-off',
  // TemperatureCommandHandler
  'set-temperature', 'adjust-temperature', 'increase-temperature', 'decrease-temperature',
  // ClimateModeCommandHandler
  'set-mode', 'set-climate-mode',
  // SimpleActionCommandHandler
  'open', 'close', 'stop', 'lock', 'unlock', 'activate', 'deactivate', 'play-alert',
  // GenericSetCommandHandler (any set-*)
  'set-brightness', 'set-fan-speed', 'set-humidity', 'set-message', 'set-content',
  'set-signal', 'set-color', 'set-anything-at-all',
  // Read/query class (oracle-true WITHOUT a handler, by contract)
  'temperature-reading', 'read-temperature', 'get-status', 'query-state',
  'check-air', 'measure-noise', 'sense-motion', 'brightness-reading',
  'energy-monitoring', 'motion-detection',
  // BUG-04: the detect-* verb spelling of the same sensing class — the
  // prefix the four legacy read-only vocabularies drifted on.
  'detect-smoke', 'detect-fire', 'detect-motion', 'detect-leak', 'detect-fault',
  // Capability-NAME commands the handlers execute directly
  // (R101: ventilation / emergency-broadcast joined this group — real
  // handlers in EmergencyStoryCommandHandler).
  'temperature-control', 'cooling', 'heating', 'ventilation', 'emergency-broadcast',
  // Known DEAD marketing names (no handler, not read-only → oracle must
  // stay false so derived services / flow validation keep rejecting them)
  'trigger-alert', 'content-display', 'people-counting',
  'lock-control', 'power-control', 'signal-control', 'lighting-control',
];

function corpus(): string[] {
  const names = new Set<string>(HANDLER_FAMILY_PROBES);
  for (const template of DeviceTemplateRegistry.listTemplates()) {
    for (const capability of template.capabilities) names.add(capability);
  }
  return [...names];
}

describe('T-056: executability oracle vs runtime dispatch parity', () => {
  it('sweep: every known command name has identical registry-handler and oracle verdicts', () => {
    const registry = new CommandHandlerRegistry('parity-sweep', 'generic');
    const rows = corpus().map(name => ({
      name,
      handler: registry.getHandler(name) !== undefined,
      oracle: isCapabilityExecutable(name),
      readOnly: isReadOnlyCapabilityName(name),
    }));

    // Contract, stated once:
    //   oracle(name) === handler(name) || isReadOnly(name)
    for (const row of rows) {
      expect(
        row.oracle,
        `oracle(${row.name}) must equal handler(${row.handler}) || readOnly(${row.readOnly})`,
      ).toBe(row.handler || row.readOnly);
    }

    // And the dangerous halves, spelled out for failure readability:
    // (a) a handler-backed command must NEVER be oracle-false (flows would
    //     422 on commands devices execute);
    expect(rows.filter(r => r.handler && !r.oracle)).toEqual([]);
    // (b) a non-read-only oracle-true name must be handler-backed on a real
    //     registry (validation must never bless something nothing executes).
    expect(rows.filter(r => r.oracle && !r.readOnly && !r.handler)).toEqual([]);
    // (c) the dead marketing names stay dead — minus the two the R101 P0
    //     deliberately brought to life (ventilation / emergency-broadcast
    //     now have REAL handlers, see EmergencyStoryCommandHandler; the
    //     ticket overrode the dead-name stance for the emergency-story
    //     pair). trigger-alert / content-display stay dead.
    for (const alive of ['ventilation', 'emergency-broadcast']) {
      expect(isCapabilityExecutable(alive), `${alive} must be oracle-true (R101 handler)`).toBe(true);
    }
    for (const dead of ['trigger-alert', 'content-display']) {
      expect(isReadOnlyCapabilityName(dead), `${dead} must not be read-only`).toBe(false);
      expect(isCapabilityExecutable(dead), `${dead} must stay oracle-false`).toBe(false);
    }

    // The corpus must actually cover the platform (a sweep over an empty
    // corpus would pass vacuously).
    expect(corpus().length).toBeGreaterThan(100);
  });

  it('canary: registering a handler on a device-style registry flips the oracle', () => {
    // 'trigger-alert' is dead today (asserted by the sweep).
    expect(isCapabilityExecutable('trigger-alert')).toBe(false);

    // The runtime dispatch path: a device's registry gains a custom handler
    // (the T-034 effect-model extension point).
    const deviceRegistry = new CommandHandlerRegistry('canary-device', 'emergency-button');
    deviceRegistry.registerHandler({
      canHandle: (commandName: string) => commandName === 'trigger-alert',
      execute: () => ({ alert: true }),
    } as unknown as CommandHandler);

    // T-056 shared contract: the SAME registration is oracle coverage —
    // validation and dispatch can no longer disagree about the command.
    expect(deviceRegistry.getHandler('trigger-alert')).toBeDefined();
    expect(isCapabilityExecutable('trigger-alert')).toBe(true);

    // The oracle flips ONLY for the covered name — no collateral coverage.
    // (R101: emergency-broadcast is now BUILT-IN true — its handler ships
    // with the registry — so it is no longer a usable collateral probe;
    // content-display keeps that role.)
    expect(isCapabilityExecutable('content-display')).toBe(false);
  });

  it('canary: a throwing custom handler degrades to no-coverage, never breaks validation', () => {
    const deviceRegistry = new CommandHandlerRegistry('canary-broken', 'generic');
    deviceRegistry.registerHandler({
      canHandle: () => {
        throw new Error('broken handler');
      },
      execute: () => ({}),
    } as unknown as CommandHandler);

    // The oracle stays usable and conservative.
    expect(isCapabilityExecutable('some-unknown-command')).toBe(false);
    expect(isCapabilityExecutable('turn-on')).toBe(true);
  });
});

describe('T-408: lock-family vocabulary parity (validation === dispatch)', () => {
  // The seed smart-lock shape (config/scenarios/personal-health.json
  // zw-door-lock): the access-control class, not the literal command names.
  const smartLock = {
    id: 'zw-door-lock',
    name: 'Door Lock',
    type: 'smart-lock',
    role: 'actuator' as const,
    capabilities: ['access-control', 'remote-access-grant'],
    zoneId: 'zone-a',
    binding: 'sim://zw-door-lock',
  };
  const billboard = { ...smartLock, id: 'bb-1', type: 'billboard' };

  it('lock-family types expand the access-control class to the secure-state commands', () => {
    expect(multiCommandNamesForDeviceType('access-control', 'smart-lock')).toEqual(['lock']);
    expect(multiCommandNamesForDeviceType('remote-access-grant', 'smart-lock'))
      .toEqual(['grant-temporary-access']);
    // 'lock-control' (the dead marketing spelling) also routes to the real
    // command on lock types.
    expect(multiCommandNamesForDeviceType('lock-control', 'door-lock')).toEqual(['lock']);
    // A lock NEVER expands to both lock and unlock — the sequence would
    // end unlocked.
  });

  it('executableCommandPath agrees with the expansion under the real oracle', () => {
    expect(executableCommandPath(smartLock, 'access-control', isCapabilityExecutable))
      .toEqual(['lock']);
    expect(executableCommandPath(smartLock, 'remote-access-grant', isCapabilityExecutable))
      .toEqual(['grant-temporary-access']);
    // DECLARED lock/unlock take the single-command path (handler-backed).
    const declared = { ...smartLock, capabilities: ['lock', 'unlock'] };
    expect(executableCommandPath(declared, 'lock', isCapabilityExecutable)).toEqual(['lock']);
    expect(executableCommandPath(declared, 'unlock', isCapabilityExecutable)).toEqual(['unlock']);
  });

  it('non-lock types get NO expansion — validation does not loosen without a dispatch path', () => {
    expect(multiCommandNamesForDeviceType('access-control', 'billboard')).toBeNull();
    expect(executableCommandPath(billboard, 'access-control', isCapabilityExecutable)).toBeNull();
    // And the handler/dispatch oracle vocabulary itself is unchanged.
    expect(isCapabilityExecutable('lock')).toBe(true);
    expect(isCapabilityExecutable('unlock')).toBe(true);
    expect(isCapabilityExecutable('grant-temporary-access')).toBe(true);
    expect(isCapabilityExecutable('access-control')).toBe(false);
  });
});

describe('BUG-04: one read-only predicate across every lane', () => {
  // The drift case plus representatives of each class.
  const CASES = [
    'detect-smoke', 'detect-fire', 'detect-leak',
    'temperature-reading', 'motion-detection', 'read-power',
    'turn-on', 'set-temperature', 'temperature-control', 'trigger-alert',
  ];

  it('the authoring oracle IS core shared predicate (same function, not a copy)', () => {
    expect(isReadOnlyCapabilityName).toBe(coreIsReadOnlyCapabilityName);
  });

  it('oracle verdict and capability typing agree on every case', () => {
    for (const name of CASES) {
      const readOnly = coreIsReadOnlyCapabilityName(name);
      expect(isReadOnlyCapabilityName(name), `oracle(${name})`).toBe(readOnly);
      // capabilityNameToDeviceCapability types read-only names 'read'
      // (SimulatedDevice.isReadOnlyCommand honors that metadata first, so
      // the dispatch lane agrees transitively; the name-heuristic fallback
      // reads the same predicate).
      expect(
        capabilityNameToDeviceCapability(name).type === 'read',
        `capability typing(${name})`,
      ).toBe(readOnly);
    }
    // The BUG-04 acceptance, spelled out: detect-smoke is read-only in
    // every lane (the prompt-side isSensorStyleCapability reads the same
    // predicate — pinned in core's capabilities/__tests__/read-only suite).
    expect(coreIsReadOnlyCapabilityName('detect-smoke')).toBe(true);
    expect(isCapabilityExecutable('detect-smoke')).toBe(true); // as a query
  });
});
