/**
 * @vitest-environment node
 *
 * FEAT-03 stage 2 acceptance tests — device coupling onto DECLARED custom
 * zone parameters (`parameterEffects` in PhysicalEnvironmentConfig).
 *
 * A scenario declaring
 *   parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } }
 *   parameterEffects: [{ capability: 'ventilation', zoneParameter: 'gas', ratePerSec: -1 }]
 * couples every ON device holding the `ventilation` capability to the zone's
 * `gas` field entry: while the device runs, the parameter drifts at
 * ratePerSec × dt ON TOP of the stage-1 relaxation (dt-normalized, BUG-09
 * discipline). Turn-off unregisters the coupling through the standard
 * all-effects path. Couplings onto undeclared or standard (enum) keys are
 * dropped at intake with a warning (scenario files get a teaching rejection
 * at load — scenario-parameter-effects.vitest.test.ts in core).
 */
import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { SimulatedDevice } from '../devices/SimulatedDevice.js';
import type { PhysicalEnvironmentConfig } from '../devices/types.js';

const CONFIG: PhysicalEnvironmentConfig = {
  environmentNoise: false,
  parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } },
  parameterEffects: [{ capability: 'ventilation', zoneParameter: 'gas', ratePerSec: -1 }],
};

function makeEnv(config: PhysicalEnvironmentConfig = CONFIG): PhysicalEnvironment {
  return new PhysicalEnvironment(new TimeManager({ timeScale: 1 }), config);
}

function fumeHood(env: PhysicalEnvironment, overrides?: { capabilities?: string[]; type?: string }): SimulatedDevice {
  const device = new SimulatedDevice({
    id: 'hood-1',
    name: 'Lab Fume Hood',
    type: overrides?.type ?? 'fume-hood',
    initialState: { status: 'active' },
    capabilities: (overrides?.capabilities ?? ['turn-on', 'turn-off', 'ventilation'])
      .map(name => ({ name, type: 'write' as const, parameters: [] })),
    behaviors: [],
    location: 'lab-a',
  });
  device.setPhysicalEnvironment(env);
  return device;
}

/** Seed the zone, inject a gas spike to 800. */
function seedAndInject(env: PhysicalEnvironment): void {
  env.setParameterBaseline('gas', 'lab-a', 0);
  env.setLocalParameterValue('gas', 'lab-a', 800);
}

describe('FEAT-03 stage 2 — device coupling onto declared custom parameters', () => {
  it('a running fume hood visibly accelerates gas decay beyond the stage-1 relaxation', async () => {
    // Device OFF: stage-1 relaxation only.
    const off = makeEnv();
    seedAndInject(off);

    // Device ON: relaxation + declared coupling.
    const on = makeEnv();
    seedAndInject(on);
    const hood = fumeHood(on);
    const turnedOn = await hood.executeCommand('turn-on');
    expect(turnedOn.success).toBe(true);

    off.simulate(150, 1);
    on.simulate(150, 1);
    // Off ≈ relax-only: 800×(1−0.003)^150 ≈ 510. On ≈ 389 (relax + 1/s drain).
    const off150 = off.getParameterValue('gas', 'lab-a') as number;
    const on150 = on.getParameterValue('gas', 'lab-a') as number;
    expect(off150).toBeGreaterThan(400);
    expect(on150).toBeLessThan(off150 - 80);
    expect(on150).toBeGreaterThan(0);

    off.simulate(150, 1);
    on.simulate(150, 1);
    // Off ≈ 325; on ≈ 127 — the gap widens with time.
    const off300 = off.getParameterValue('gas', 'lab-a') as number;
    const on300 = on.getParameterValue('gas', 'lab-a') as number;
    expect(off300).toBeGreaterThan(250);
    expect(on300).toBeLessThan(off300 - 100);
    expect(on300).toBeGreaterThan(0);
  });

  it('turn-off stops the coupling (relaxation-only decay resumes)', async () => {
    const env = makeEnv();
    seedAndInject(env);
    const hood = fumeHood(env);
    await hood.executeCommand('turn-on');
    env.simulate(100, 1);
    const whileOn = env.getParameterValue('gas', 'lab-a') as number;

    await hood.executeCommand('turn-off');
    // The coupling effect is gone with the device (standard all-effects path).
    const layer = env.getPhysicsLayer()!;
    expect(layer.listDeviceEffects().some(e => e.deviceId === 'hood-1')).toBe(false);

    env.simulate(100, 1);
    const afterOff = env.getParameterValue('gas', 'lab-a') as number;
    // Relaxation still decays the value, but at the declared 0.003/s rate:
    // afterOff ≈ whileOn × 0.997^100 ≈ whileOn × 0.74 — NOT the coupled drain.
    expect(afterOff).toBeLessThan(whileOn);
    expect(afterOff).toBeGreaterThan(whileOn * 0.6);
  });

  it('a device WITHOUT the declared capability couples nothing', async () => {
    const env = makeEnv();
    seedAndInject(env);
    const plain = fumeHood(env, { capabilities: ['turn-on', 'turn-off'], type: 'heater' });
    await plain.executeCommand('turn-on');
    env.simulate(300, 1);
    // Identical to the relax-only reference (bit-for-bit — nothing registered).
    const reference = makeEnv();
    seedAndInject(reference);
    reference.simulate(300, 1);
    expect(env.getParameterValue('gas', 'lab-a')).toBe(reference.getParameterValue('gas', 'lab-a'));
  });

  it('the deviceType selector couples too (capability absent)', async () => {
    const env = makeEnv({
      environmentNoise: false,
      parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } },
      parameterEffects: [{ deviceType: 'fume-hood', zoneParameter: 'gas', ratePerSec: -1 }],
    });
    seedAndInject(env);
    const hood = fumeHood(env, { capabilities: ['turn-on', 'turn-off'] });
    await hood.executeCommand('turn-on');
    env.simulate(300, 1);
    const value = env.getParameterValue('gas', 'lab-a') as number;
    expect(value).toBeLessThan(200); // relax-only would be ≈325
    expect(value).toBeGreaterThan(0);
  });

  it('couplings onto UNDECLARED custom keys are dropped at intake (T-304 static semantics preserved)', async () => {
    const env = makeEnv({
      environmentNoise: false,
      parameterPhysics: { gas: { relaxRatePerSec: 0.003, relaxToBaseline: true } },
      // 'fume' is NOT declared in parameterPhysics.
      parameterEffects: [{ capability: 'ventilation', zoneParameter: 'fume', ratePerSec: -1 }],
    });
    expect(env.getParameterEffectDeclarations()).toHaveLength(0);

    env.setParameterBaseline('fume', 'lab-a', 400);
    const hood = fumeHood(env);
    await hood.executeCommand('turn-on');
    env.simulate(600, 1);
    // Static store: nothing moves, no matter what runs.
    expect(env.getParameterValue('fume', 'lab-a')).toBe(400);
  });

  it('couplings onto STANDARD (enum) parameters are dropped at intake (dedicated physics stays)', () => {
    const env = makeEnv({
      environmentNoise: false,
      parameterEffects: [{ capability: 'ventilation', zoneParameter: 'temperature', ratePerSec: -1 }],
    });
    expect(env.getParameterEffectDeclarations()).toHaveLength(0);
  });

  it('deterministic replay: identical worlds + identical commands produce identical values', async () => {
    async function run(): Promise<number[]> {
      const env = makeEnv();
      seedAndInject(env);
      const hood = fumeHood(env);
      await hood.executeCommand('turn-on');
      const readings: number[] = [];
      for (let i = 0; i < 3; i++) {
        env.simulate(100, 1);
        readings.push(env.getParameterValue('gas', 'lab-a') as number);
      }
      await hood.executeCommand('turn-off');
      env.simulate(100, 1);
      readings.push(env.getParameterValue('gas', 'lab-a') as number);
      return readings;
    }
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });
});
