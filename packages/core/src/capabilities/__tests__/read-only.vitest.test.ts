/**
 * BUG-04 — the single read-only capability predicate.
 *
 * Three vocabulary copies disagreed on the `detect-` verb prefix: the
 * authoring oracle matched the `detect` substring while
 * capabilityNameToDeviceCapability, SimulatedDevice.isReadOnlyCommand and
 * the prompt-side isSensorStyleCapability did not — `detect-smoke` was
 * validated as executable, shown to the LLM as an actuation command, then
 * died at runtime with "no handler / no effect" (lab-safety, 4/4 repro).
 *
 * Pins: the shared predicate's verdicts (detect-* read-only; superset of
 * every legacy vocabulary so no historical true verdict flips), and the
 * CORE-side consumers reading it (capability typing + the planner/prompt
 * predicate). The simulation-side consumers (authoring oracle re-export,
 * SimulatedDevice dispatch) are pinned in the simulation package's
 * oracle-dispatch-parity suite.
 */

import { describe, expect, it } from 'vitest';

import { isReadOnlyCapabilityName } from '../read-only.js';
import { isSensorStyleCapability } from '../../decision/rule-actuation-planner.js';
import { capabilityNameToDeviceCapability } from '../../runtime/contract.js';

const READ_ONLY_NAMES = [
  // The BUG-04 verb prefix (the drifted class).
  'detect-smoke', 'detect-fire', 'detect-motion', 'detect-leak', 'detect-fault',
  // Sensing-noun substrings (all four legacy vocabularies agreed).
  'temperature-reading', 'brightness-reading', 'motion-detection',
  'energy-monitoring', 'power-monitoring', 'co2-sensing',
  // Verb prefixes (oracle + dispatch agreed; contract.ts newly aligned).
  'read-power', 'read-smoke-level', 'get-status', 'get-alarm-status',
  'query-state', 'check-air', 'measure-noise', 'sense-motion',
];

const ACTUATION_NAMES = [
  'turn-on', 'turn-off', 'set-temperature', 'set-mode', 'set-volume',
  'temperature-control', 'cooling', 'heating', 'ventilation',
  'emergency-broadcast', 'lock', 'unlock',
  // Dead marketing names stay non-read-only (the parity sweep keeps them dead).
  'trigger-alert', 'content-display', 'lighting-control',
];

describe('BUG-04: the single read-only capability predicate', () => {
  it('classifies the read-only vocabulary (detect-* included)', () => {
    for (const name of READ_ONLY_NAMES) {
      expect(isReadOnlyCapabilityName(name), `${name} must be read-only`).toBe(true);
    }
  });

  it('keeps actuation and dead marketing names out of the read-only class', () => {
    for (const name of ACTUATION_NAMES) {
      expect(isReadOnlyCapabilityName(name), `${name} must NOT be read-only`).toBe(false);
    }
  });

  it('capabilityNameToDeviceCapability types detect-* as read (was: execute → no handler)', () => {
    expect(capabilityNameToDeviceCapability('detect-smoke').type).toBe('read');
    expect(capabilityNameToDeviceCapability('detect-fire').type).toBe('read');
    expect(capabilityNameToDeviceCapability('temperature-reading').type).toBe('read');
    // The write/execute branches are untouched.
    expect(capabilityNameToDeviceCapability('temperature-control').type).toBe('write');
    expect(capabilityNameToDeviceCapability('turn-on').type).toBe('execute');
  });

  it('the prompt-side predicate (isSensorStyleCapability) is the same source', () => {
    for (const name of [...READ_ONLY_NAMES, ...ACTUATION_NAMES]) {
      expect(isSensorStyleCapability(name), `${name} predicates must agree`)
        .toBe(isReadOnlyCapabilityName(name));
    }
    // The drifted case, spelled out: detect-smoke never reaches the LLM as
    // an actuation command again.
    expect(isSensorStyleCapability('detect-smoke')).toBe(true);
  });
});
