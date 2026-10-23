/**
 * @vitest-environment node
 *
 * FEAT-03 acceptance tests — opt-in field dynamics for custom (non-enum)
 * zone parameters (`parameterPhysics` in PhysicalEnvironmentConfig).
 *
 * A scenario declaring `parameterPhysics: { gas: { relaxRatePerSec,
 * relaxToBaseline: true } }` moves that key off the T-304 static store onto
 * the spatial field: an injection relaxes back toward the seeded zone
 * baseline at the declared rate. Undeclared keys keep the T-304 static
 * semantics exactly (regression: PhysicalEnvironment.determinism.vitest.test.ts).
 */
import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import type { PhysicalEnvironmentConfig } from '../devices/types.js';

function makeEnv(config: PhysicalEnvironmentConfig = {}): PhysicalEnvironment {
  const time = new TimeManager({ timeScale: 1 });
  return new PhysicalEnvironment(time, { environmentNoise: false, ...config });
}

describe('FEAT-03 — declared custom parameters take the field path', () => {
  it('a declared gas injection relaxes back to the seeded baseline at the declared rate', () => {
    const env = makeEnv({
      parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } },
    });
    env.setParameterBaseline('gas', 'lab-a', 100);
    expect(env.getParameterValue('gas', 'lab-a')).toBe(100);

    // A leak: injection to 800.
    env.setLocalParameterValue('gas', 'lab-a', 800);
    expect(env.getParameterValue('gas', 'lab-a')).toBe(800);

    // 600 s at 0.003/s: gap closes by 1-(1-0.003)^600 ≈ 83.5% → ≈215.
    env.simulate(600, 1);
    const after = env.getParameterValue('gas', 'lab-a') as number;
    expect(after).toBeGreaterThan(150);
    expect(after).toBeLessThan(300);

    // Long run: converges onto the 100 baseline.
    env.simulate(3600, 10);
    const settled = env.getParameterValue('gas', 'lab-a') as number;
    expect(Math.abs(settled - 100)).toBeLessThan(5);
  });

  it('the declared relaxRatePerSec is honored (not the generic 0.005/s)', () => {
    const slow = makeEnv({
      parameterPhysics: { gas: { relaxRatePerSec: 0.001, relaxToBaseline: true } },
    });
    const fast = makeEnv({
      parameterPhysics: { gas: { relaxRatePerSec: 0.01, relaxToBaseline: true } },
    });
    for (const env of [slow, fast]) {
      env.setParameterBaseline('gas', 'lab-a', 0);
      env.setLocalParameterValue('gas', 'lab-a', 500);
      env.simulate(300, 1);
    }
    const slowValue = slow.getParameterValue('gas', 'lab-a') as number;
    const fastValue = fast.getParameterValue('gas', 'lab-a') as number;
    // 0.001/s × 300 s → ≈74% remaining; 0.01/s × 300 s → ≈5% remaining.
    expect(slowValue).toBeGreaterThan(300);
    expect(fastValue).toBeLessThan(60);
  });

  it('relaxToBaseline: false decays toward the environment default instead of a zone baseline', () => {
    const env = makeEnv({
      parameterPhysics: { fume: { relaxRatePerSec: 0.01, relaxToBaseline: false } },
    });
    // Seeding writes only the current value (no baseline attractor).
    env.setParameterBaseline('fume', 'lab-a', 0);
    env.setLocalParameterValue('fume', 'lab-a', 400);
    env.simulate(300, 1);
    const after = env.getParameterValue('fume', 'lab-a') as number;
    // Decays toward the environment default (0), not back up to any baseline.
    expect(after).toBeLessThan(60);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it('undeclared keys keep the T-304 static semantics (no relaxation, no coupling)', () => {
    const env = makeEnv({
      parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } },
    });
    env.setParameterBaseline('pvOutputW', 'roof', 8000);
    env.setLocalParameterValue('occupancyCount', 'roof', 42);
    env.simulate(600, 60);
    expect(env.getParameterValue('pvOutputW', 'roof')).toBe(8000);
    expect(env.getParameterValue('occupancyCount', 'roof')).toBe(42);
  });
});
