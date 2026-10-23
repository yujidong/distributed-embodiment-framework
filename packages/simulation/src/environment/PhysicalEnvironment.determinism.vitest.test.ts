/**
 * @vitest-environment node
 *
 * P1-7 regression: a fresh world must never be "dirty".
 *
 * Before the fix, every built-in default value model (SimpleFunctionModel /
 * DailyCycleModel) added per-read Gaussian noise (Math.random) — an
 * undeclared parameter returned a random draw at t=0: phantom smoke ≈1.5 in
 * a world without any smoke source, CO2 drifting ±50 ppm around 400, every
 * snapshot differing from the previous one. Randomness must be explicitly
 * declared: default models are now deterministic unless the caller opts
 * into `environmentNoise: true`, and custom models registered through the
 * public API keep their declared noise.
 */

import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { SimpleFunctionModel } from '../environment/models/SimpleFunctionModel.js';
import { PhysicalParameter } from '../devices/types.js';

function makeEnv(environmentNoise?: boolean): PhysicalEnvironment {
  return new PhysicalEnvironment(new TimeManager({ timeScale: 1 }), { environmentNoise });
}

const LOCATION = 'living-room';

describe('P1-7: deterministic world initialization', () => {
  it('undeclared parameters start at their deterministic base (smoke = 0, co2 = 400, pm2_5 = 10)', () => {
    const env = makeEnv();
    expect(env.getParameterValue('smoke', LOCATION)).toBe(0);
    expect(env.getParameterValue('co2', LOCATION)).toBe(400);
    expect(env.getParameterValue('pm2_5', LOCATION)).toBe(10);
  });

  it('repeated reads return the identical value (no per-read noise)', () => {
    const env = makeEnv();
    for (const parameter of ['smoke', 'co2', 'pm2_5', 'voc']) {
      const first = env.getParameterValue(parameter, LOCATION);
      for (let i = 0; i < 20; i++) {
        expect(env.getParameterValue(parameter, LOCATION)).toBe(first);
      }
    }
  });

  it('two independent environments produce identical values (reproducible across instances)', () => {
    const a = makeEnv();
    const b = makeEnv();
    for (const parameter of ['smoke', 'co2', 'pm2_5', 'voc', 'no2']) {
      expect(a.getParameterValue(parameter, LOCATION)).toBe(b.getParameterValue(parameter, LOCATION));
    }
  });

  it('opt-in: environmentNoise: true restores the legacy noisy default models', () => {
    const env = makeEnv(true);
    const reads = Array.from({ length: 30 }, () => env.getParameterValue('co2', LOCATION) as number);
    // Legacy model: base 400 ± N(0, 50). Noise present ⇒ reads must vary.
    expect(new Set(reads.map(v => v.toFixed(6))).size).toBeGreaterThan(1);
    expect(Math.max(...reads) - Math.min(...reads)).toBeGreaterThan(1);
  });

  it('custom models registered through the public API keep their declared noise', () => {
    const env = makeEnv(); // world noise OFF — but this model's noise is explicit
    env.registerValueModel(
      PhysicalParameter.CO2,
      new SimpleFunctionModel({ base: 400, noiseLevel: 10, minValue: 0 }),
    );
    const reads = Array.from({ length: 30 }, () => env.getParameterValue('co2', LOCATION) as number);
    expect(new Set(reads.map(v => v.toFixed(6))).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// T-304 (DevLoop R12, EN-F05) — custom (non-enum) parameters are stored, not
// dropped. Seeding and writes land in a STATIC per-location store; the
// standard enum physics is untouched.
// ---------------------------------------------------------------------------

describe('T-304: custom parameters are static stored fields', () => {
  it('seeding a custom baseline keeps the value readable at that location', () => {
    const env = makeEnv();
    env.setParameterBaseline('powerW', 'roof', 38000);
    expect(env.getParameterValue('powerW', 'roof')).toBe(38000);
    // Another location does not inherit the seeded value.
    expect(env.getParameterValue('powerW', 'room')).toBe(0);
  });

  it('values hold across physics steps (no relaxation, no coupling)', () => {
    const env = makeEnv();
    env.setParameterBaseline('pvOutputW', 'roof', 8000);
    env.setParameterBaseline('temperature', 'roof', 20);
    env.simulate(600, 60); // 10 sim-minutes of standard physics
    // The custom value rides the physics steps untouched (static store),
    // and the enum parameter keeps its own read path (constant global model
    // here — the enum physics is unchanged by the custom-parameter store).
    expect(env.getParameterValue('pvOutputW', 'roof')).toBe(8000);
    expect(env.getParameterValue('temperature', 'roof')).toBe(20);
  });

  it('a global write (legacy path) is readable from every location and overridable per zone', () => {
    const env = makeEnv();
    env.setParameterValue('occupancyCount', 'anywhere', 12);
    expect(env.getParameterValue('occupancyCount', 'zone-a')).toBe(12);
    expect(env.getParameterValue('occupancyCount', 'zone-b')).toBe(12);
    // A local write shadows the global entry at its location only.
    env.setLocalParameterValue('occupancyCount', 'zone-a', 3);
    expect(env.getParameterValue('occupancyCount', 'zone-a')).toBe(3);
    expect(env.getParameterValue('occupancyCount', 'zone-b')).toBe(12);
  });

  it('boolean custom parameters survive too (generic store)', () => {
    const env = makeEnv();
    env.setParameterBaseline('occupied', 'ward-102', true);
    expect(env.getParameterValue('occupied', 'ward-102')).toBe(true);
  });
});
