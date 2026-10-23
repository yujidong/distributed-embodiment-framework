/**
 * @vitest-environment node
 *
 * Drift guard for core's STANDARD_PHYSICAL_PARAMETERS mirror
 * (`packages/core/src/scenario/standard-parameters.ts`).
 *
 * Core must never import @active-collaboration/simulation (arch guard), yet
 * scenario validation (FEAT-03 parameterPhysics / parameterEffects) needs to
 * know the standard-parameter set — so the enum values are mirrored there
 * DELIBERATELY. This test is the contract that keeps the mirror honest: when
 * PhysicalParameter gains or loses a value, update the core mirror in the
 * same change.
 */
import { describe, it, expect } from 'vitest';

import { STANDARD_PHYSICAL_PARAMETERS } from '@active-collaboration/core';

import { PhysicalParameter } from '../devices/types.js';

describe('standard-parameters mirror (core) ⇆ PhysicalParameter enum (simulation)', () => {
  it('the mirror covers exactly the enum value set', () => {
    const enumValues = Object.values(PhysicalParameter).sort();
    const mirrored = [...STANDARD_PHYSICAL_PARAMETERS].sort();
    expect(mirrored).toEqual(enumValues);
  });
});
