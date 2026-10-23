/**
 * @vitest-environment node
 *
 * BUG-09 — light/humidity device effects are dt-normalized.
 *
 * Pre-fix, PhysicsLayer.applyLightEffect / applyHumidityEffect added their
 * magnitude on EVERY pass with no deltaTime, so the equilibrium against the
 * field's fixed relaxation scaled with 1/dt and zone readings drifted with
 * the engine tick rate / LOD substep (dorm-life D5: brightness=10 zones
 * read 50/256/901 lux depending on tick). Post-fix:
 *   - light: the effect magnitude is the luminaire's STEADY-STATE lux
 *     contribution (brightness mapped via brightnessToLuxContribution) and
 *     the drive integrates at the field's light relaxation rate, so the
 *     zone converges to baseline + contribution for ANY dt;
 *   - humidity: the magnitude is a %RH/s RATE scaled by dt (identical to
 *     the old per-pass add on the observed dt=1 grid).
 *
 * Anchors: the brightness→lux mapping table, and steady-state readings of
 * the SAME lamp/humidifier across tick dt ∈ {0.25, 1, 4} s.
 */

import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { SimulatedDevice } from '../devices/SimulatedDevice.js';
import type { PhysicsLayer } from './PhysicsLayer.js';
import { PhysicalParameter } from '../devices/types.js';
import type { DeviceCapability } from '@active-collaboration/shared';
import { brightnessToLuxContribution, MAX_LUMINAIRE_LUX } from './illuminance.js';

function makeWorld(): { env: PhysicalEnvironment; physics: PhysicsLayer } {
  const timeManager = new TimeManager({ timeScale: 1 });
  timeManager.jumpTo(new Date(Date.UTC(2026, 5, 1)));
  const env = new PhysicalEnvironment(timeManager, { environmentNoise: false });
  const physics = env.getPhysicsLayer();
  if (!physics) throw new Error('physics layer expected to be enabled');
  return { env, physics };
}

function registerZone(physics: PhysicsLayer, id: string, x: number, y: number): void {
  physics.getSpatialManager().registerLocation({ id, name: id, path: id, position: { x, y } });
}

function capabilities(...names: string[]): DeviceCapability[] {
  return names.map(name => ({ name, type: 'execute' as const, parameters: [] }));
}

describe('BUG-09 — brightness → lux mapping table', () => {
  it('maps the 0-100 brightness scale linearly to 0-500 lux', () => {
    const table: Array<[number, number]> = [
      [0, 0],
      [10, 50],
      [25, 125],
      [50, 250],
      [75, 375],
      [100, 500],
    ];
    for (const [brightness, lux] of table) {
      expect(brightnessToLuxContribution(brightness)).toBe(lux);
    }
    expect(MAX_LUMINAIRE_LUX).toBe(500);
  });

  it('treats values in (0, 1] as the legacy 0-1 fraction scale', () => {
    expect(brightnessToLuxContribution(0.5)).toBe(250);
    expect(brightnessToLuxContribution(0.8)).toBe(400); // the light family's historical default
    expect(brightnessToLuxContribution(1)).toBe(500); // 1 = FULL on the fraction scale
  });

  it('clamps out-of-range brightness to the 0-500 lux band', () => {
    expect(brightnessToLuxContribution(-20)).toBe(0);
    expect(brightnessToLuxContribution(150)).toBe(500);
  });
});

describe('BUG-09 — light effect dt-normalization', () => {
  /**
   * The same lamp (type 'light', set-brightness 10 → 50 lux contribution)
   * in a zone with a 100 lux ambient baseline. Steady state must be
   * ≈ 150 lux regardless of the physics tick size.
   */
  async function runLampWorld(stepSize: number): Promise<number> {
    const { env, physics } = makeWorld();
    registerZone(physics, 'office', 0, 0);
    env.setParameterBaseline('light', 'office', 100);
    env.setParameterValue('light', 'office', 100);

    const lamp = new SimulatedDevice({
      id: 'lamp-1',
      name: 'Desk Lamp',
      type: 'light',
      initialState: { power: false, brightness: 100 },
      capabilities: capabilities('turn-on', 'turn-off', 'set-brightness'),
      behaviors: [],
      location: 'office',
    });
    lamp.setPhysicalEnvironment(env);

    await lamp.executeCommand('turn-on');
    const result = await lamp.executeCommand('set-brightness', { brightness: 10 });
    expect(result.success).toBe(true);
    // The device registered the MAPPED lux contribution, not the raw 0-100
    // brightness (the pre-fix magnitude passed 10 straight through).
    const effect = physics.getDeviceEffect('lamp-1', PhysicalParameter.LIGHT);
    expect(effect).toBeDefined();
    expect(effect!.magnitude).toBe(50);

    env.simulate(200, stepSize); // 20× the 10 s light relaxation constant
    return env.getParameterValue('light', 'office') as number;
  }

  it('steady-state illuminance is baseline + mapped contribution at dt = 1 s', async () => {
    expect(await runLampWorld(1)).toBeCloseTo(150, 0);
  });

  it('the SAME lamp converges to the same steady state across tick dt / LOD substeps', async () => {
    const [fine, nominal, coarse] = [
      await runLampWorld(0.25),
      await runLampWorld(1),
      await runLampWorld(4),
    ];
    // Pre-fix the equilibrium scaled with 1/dt (≈ 150 / 105 / 30 lux here).
    expect(Math.abs(fine - nominal)).toBeLessThan(2);
    expect(Math.abs(coarse - nominal)).toBeLessThan(2);
    expect(nominal).toBeCloseTo(150, 0);
  });

  it('lamp off: the zone relaxes back to its ambient baseline', async () => {
    const { env, physics } = makeWorld();
    registerZone(physics, 'office', 0, 0);
    env.setParameterBaseline('light', 'office', 100);
    env.setParameterValue('light', 'office', 100);

    const lamp = new SimulatedDevice({
      id: 'lamp-1',
      name: 'Desk Lamp',
      type: 'light',
      initialState: { power: false, brightness: 100 },
      capabilities: capabilities('turn-on', 'turn-off', 'set-brightness'),
      behaviors: [],
      location: 'office',
    });
    lamp.setPhysicalEnvironment(env);

    await lamp.executeCommand('turn-on');
    await lamp.executeCommand('set-brightness', { brightness: 10 });
    env.simulate(200, 1);
    expect(env.getParameterValue('light', 'office') as number).toBeCloseTo(150, 0);

    await lamp.executeCommand('turn-off');
    env.simulate(200, 1);
    expect(env.getParameterValue('light', 'office') as number).toBeCloseTo(100, 0);
  });
});

describe('BUG-09 — humidity effect dt-normalization', () => {
  /**
   * A humidifier-strength source (0.15 %RH/s) in a 40 %RH baseline zone at
   * a held 24 °C. Steady state ≈ 40 + 0.15/0.003 = 90 %RH for ANY dt.
   */
  function runHumidifierWorld(stepSize: number): number {
    const { env, physics } = makeWorld();
    registerZone(physics, 'bath', 0, 0);
    env.setParameterBaseline('humidity', 'bath', 40);
    env.setParameterValue('humidity', 'bath', 40);
    env.setParameterBaseline('temperature', 'bath', 24);
    env.setParameterValue('temperature', 'bath', 24);
    env.registerDeviceEffect({
      deviceId: 'humidifier-1',
      parameter: PhysicalParameter.HUMIDITY,
      effect: 'humidity',
      magnitude: 0.15, // %RH/s rate
      affectedArea: { location: 'bath', radius: 3, position: { x: 0, y: 0 } },
    });

    env.simulate(1800, stepSize); // >5× the 333 s humidity relaxation constant
    return env.getParameterValue('humidity', 'bath') as number;
  }

  it('steady-state humidity matches the rate/relaxation equilibrium at dt = 1 s', () => {
    expect(runHumidifierWorld(1)).toBeCloseTo(90, 0);
  });

  it('the SAME humidifier converges to the same steady state across tick dt / LOD substeps', () => {
    const [fine, nominal, coarse] = [
      runHumidifierWorld(0.25),
      runHumidifierWorld(1),
      runHumidifierWorld(4),
    ];
    // Pre-fix the equilibrium scaled with 1/dt (≈ 240 (clamped 100) / 90 / 52.5 %RH).
    expect(Math.abs(fine - nominal)).toBeLessThan(2);
    expect(Math.abs(coarse - nominal)).toBeLessThan(2);
    expect(nominal).toBeCloseTo(90, 0);
  });
});
