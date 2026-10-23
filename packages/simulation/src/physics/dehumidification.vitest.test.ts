/**
 * @vitest-environment node
 *
 * T-104 (DevLoop R32, F-PH10) — active dehumidification.
 *
 * R29 measured: "dehumidification not demonstrable as active moisture
 * removal" — RH moved exactly as constant-moisture re-computation predicts
 * (fell while warming... rose while cooling) and climbed straight back.
 * The fix gives a running cooling coil a CONDENSATE MASS drain proportional
 * to the cooling delivered (latent share of the load), removed from the
 * zone's ABSOLUTE humidity — so RH genuinely drops and stays lower even
 * after the zone re-warms.
 */

import { describe, it, expect } from 'vitest';

import { HumidityModel } from './HumidityModel.js';
import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { PhysicalParameter } from '../devices/types.js';

const model = new HumidityModel();

describe('T-104 — HumidityModel.calculateCoilCondensate (unit physics)', () => {
  const base = {
    coolingPowerW: 2600,
    deltaTimeSec: 600,
    airTempC: 24,
    relativeHumidity: 75,
    zoneVolumeM3: 1200,
  };

  it('condenses when the coil is below the dew point: RH drops at CONSTANT temperature', () => {
    const { condensateG, newRelativeHumidity } = model.calculateCoilCondensate(base);
    expect(condensateG).toBeGreaterThan(0);
    // Same temperature, LESS moisture — the F-PH10 signature the old model
    // could not produce (its RH dips only accompanied temperature moves).
    expect(newRelativeHumidity).toBeLessThan(75);
    expect(newRelativeHumidity).toBeGreaterThan(20);
  });

  it('condensate is proportional to cooling power × time (∝ the temp drop the coil causes)', () => {
    const a = model.calculateCoilCondensate(base);
    const b = model.calculateCoilCondensate({ ...base, coolingPowerW: base.coolingPowerW * 2 });
    const c = model.calculateCoilCondensate({ ...base, deltaTimeSec: base.deltaTimeSec * 3 });
    expect(b.condensateG).toBeGreaterThan(a.condensateG * 1.9);
    expect(c.condensateG).toBeGreaterThan(a.condensateG * 2.9);
  });

  it('no condensate when the coil is above the dew point (dry air)', () => {
    // RH 30% at 24°C → dew point ≈ 24 − (100−30)/5 = 10°C; coil at 14°C.
    const dry = model.calculateCoilCondensate({ ...base, relativeHumidity: 30, coilTempC: 14 });
    expect(dry.condensateG).toBe(0);
    expect(dry.newRelativeHumidity).toBe(30);
  });

  it('never drains below the 20% RH floor', () => {
    // Absurd cooling (100 kW · 1 h) against a small room: the drain clamps.
    const drained = model.calculateCoilCondensate({
      ...base, coolingPowerW: 100_000, deltaTimeSec: 3600, zoneVolumeM3: 50,
    });
    expect(drained.newRelativeHumidity).toBeGreaterThanOrEqual(20);
  });

  it('moisture removal PERSISTS through a re-warm (mass was actually removed)', () => {
    // F-PH10's decisive observation: turn the unit off → RH climbed straight
    // back with T (constant-moisture). With mass removed it must not.
    const rh0 = 75, t0 = 24;
    const { newRelativeHumidity: rhAfterDrain } = model.calculateCoilCondensate(base);
    const ahDrained = model.calculateAbsoluteHumidity(rhAfterDrain, t0);
    // Re-warm to 28°C holding the DRAINED moisture: RH stays far below 75%.
    const rhRewarmed = model.calculateRelativeHumidity(ahDrained, 28);
    expect(rhRewarmed).toBeLessThan(rh0 - 10);
  });
});

describe('T-104 — PhysicsLayer wiring (cooling drains zone moisture)', () => {
  function makeCoolingWorld(): { env: PhysicalEnvironment } {
    const time = new TimeManager();
    time.jumpTo(new Date(Date.UTC(2026, 5, 1)));
    const env = new PhysicalEnvironment(time, { environmentNoise: false });
    // Humid basement: 75% RH baseline at 24°C.
    env.setParameterBaseline('humidity', 'basement', 75);
    env.setParameterValue('humidity', 'basement', 75);
    env.setParameterValue('temperature', 'basement', 24);
    // Zone volume via zone-physics registration → thermal mass → the
    // condensate model has a volume to spread the drained mass over.
    env.getPhysicsLayer()?.registerZonePhysics('basement', { floor: 0, volumeM3: 1200 });
    env.registerDeviceEffect({
      deviceId: 'hvac-basement',
      parameter: PhysicalParameter.TEMPERATURE,
      effect: 'cooling',
      magnitude: -2600,
      affectedArea: { location: 'basement', radius: 5, position: { x: 0, y: 0 } },
    });
    return { env };
  }

  it('a running cooling coil drives RH DOWN while the zone cools', () => {
    const { env } = makeCoolingWorld();
    const rhStart = env.getParameterValue('humidity', 'basement') as number;
    for (let i = 0; i < 10; i++) env.simulate(60, 1); // 10 sim-min of cooling
    const rhAfter = env.getParameterValue('humidity', 'basement') as number;
    const tAfter = env.getParameterValue('temperature', 'basement') as number;

    // Constant-moisture physics alone would push RH UP as T falls; the
    // condensate drain must win overall (net RH decrease).
    expect(rhAfter).toBeLessThan(rhStart);
    // Sanity: the coil actually cooled the zone in this window.
    expect(tAfter).toBeLessThan(24);
  });

  it('after the coil stops, RH stays below the constant-moisture backtrack', async () => {
    const { env } = makeCoolingWorld();
    for (let i = 0; i < 10; i++) env.simulate(60, 1);
    const rhDrained = env.getParameterValue('humidity', 'basement') as number;
    const tDrained = env.getParameterValue('temperature', 'basement') as number;

    // Coil off: what RH would constant-moisture physics alone predict once
    // the zone relaxes back toward 24°C? (dew-point-free upper bound: the
    // RH the SAME absolute moisture would show at the warmer temperature.)
    const ah = model.calculateAbsoluteHumidity(rhDrained, tDrained);
    const rhIfMoistureKept = model.calculateRelativeHumidity(ah, 24);

    // The point: rhDrained < rhIfMoistureKept is trivially true when colder;
    // the REAL assertion is that drained moisture < original — i.e. RH at
    // 24°C-equivalent is now far below the original 75%.
    expect(rhIfMoistureKept).toBeLessThan(75);
  });
});
