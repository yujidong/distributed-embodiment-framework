/**
 * @vitest-environment node
 *
 * DevLoop R29 air-exchange acceptance tests.
 *
 *  T-707 — gradual CO2 ventilation: 646→<500 spans ≥5 consecutive 60 s
 *          samples (exponential, ratio ~constant per sample); asymptote
 *          ≥ 420 (never below outdoor); turn-off resumes accumulation
 *          toward the pre-ventilation attractor (F-PH07/F-PH08).
 *  T-708 — PM2.5 gradual spread: point injection + diffusion raises the
 *          neighbor over ≥3 ticks to a small peak (<15% of source), decays
 *          back to baseline within 10 sim-min; a neighbor NEVER gets
 *          cleaner because of contamination next door; source decay ratio
 *          ≈0.657/60 s preserved.
 */
import { describe, it, expect } from 'vitest';

import { TimeManager } from '../environment/TimeManager.js';
import { PhysicalEnvironment } from '../environment/PhysicalEnvironment.js';
import { SpatialField } from './SpatialField.js';
import { PhysicalParameter } from '../devices/types.js';

const NO_ATTRACTOR = () => undefined;

describe('T-707 — gradual CO2 ventilation (F-PH08)', () => {
  function makeVentilatedWorld(co2Baseline: number): {
    env: PhysicalEnvironment;
    time: TimeManager;
  } {
    const time = new TimeManager();
    time.jumpTo(new Date(Date.UTC(2026, 5, 1)));
    const env = new PhysicalEnvironment(time, { environmentNoise: false });
    // Zone baseline pins the relaxation attractor at the occupancy level.
    env.setParameterBaseline('co2', 'lab-a', co2Baseline);
    // A running air handler (cooling effect = air in motion). The effect's
    // affectedArea registers lab-a with the propagation engine + field.
    env.registerDeviceEffect({
      deviceId: 'hvac-beta',
      parameter: PhysicalParameter.TEMPERATURE,
      effect: 'cooling',
      magnitude: -3000,
      affectedArea: { location: 'lab-a', radius: 5, position: { x: 0, y: 0 } },
    });
    return { env, time };
  }

  it('646→<500 spans ≥5 one-minute samples, exponential with ~constant ratio, floor 420', () => {
    const { env } = makeVentilatedWorld(646);
    const samples: number[] = [646];
    // 60 one-minute samples (the tester's cadence).
    for (let minute = 0; minute < 60; minute++) {
      env.simulate(60, 1); // 60 × 1 s physics steps
      samples.push(env.getParameterValue('co2', 'lab-a') as number);
    }

    // Gradual: crossing below 500 needs ≥ 5 samples (was ONE step).
    const belowIdx = samples.findIndex(v => v < 500);
    expect(belowIdx).toBeGreaterThanOrEqual(5);
    // Exponential with ~constant per-sample ratio (±2%).
    const ratios: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const excess0 = samples[i - 1] - 420;
      const excess1 = samples[i] - 420;
      if (excess0 > 1 && excess1 > 1) ratios.push(excess1 / excess0);
    }
    expect(ratios.length).toBeGreaterThan(3);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    expect(spread).toBeLessThan(0.02);
    // Asymptote ≥ outdoor (never below 420, never a below-baseline step).
    const final = samples[samples.length - 1];
    expect(final).toBeGreaterThanOrEqual(420);
    expect(final).toBeLessThanOrEqual(460);
  });

  it('turn-off resumes accumulation toward the pre-ventilation attractor', () => {
    const { env } = makeVentilatedWorld(646);
    // Ventilate 20 min, then stop the handler.
    for (let i = 0; i < 20; i++) env.simulate(60, 1);
    const afterVent = env.getParameterValue('co2', 'lab-a') as number;
    expect(afterVent).toBeLessThan(560);

    env.unregisterDeviceEffect('hvac-beta');
    // With the handler off, the zone's default relaxation toward its 646
    // baseline resumes (occupancy accumulation climbs again).
    for (let i = 0; i < 30; i++) env.simulate(60, 1);
    const afterRecovery = env.getParameterValue('co2', 'lab-a') as number;
    expect(afterRecovery).toBeGreaterThan(afterVent);
  });
});

describe('T-708 — PM2.5 gradual diffusion + correct direction (F-PH09)', () => {
  /**
   * lab-b (source) and cleanroom 4.95 m away (weak coupling — geometry
   * falloff 0.01: the source's decay stays relax-dominated, preserving the
   * measured ratio ≈0.636/60 s vs the field-observed 0.657, while the
   * neighbor still receives gradual inflow). Both relax toward the ambient
   * model (10 µg/m³); cleanroom's own baseline is the controlled 2.
   */
  function makeField(): SpatialField {
    const field = new SpatialField();
    field.registerLocation('lab-b', { x: 0, y: 0 });
    field.registerLocation('cleanroom', { x: 4.95, y: 0 });
    field.registerZoneMetadata('lab-b', { floor: 0, adjacentZoneIds: ['cleanroom'] });
    field.registerZoneMetadata('cleanroom', { floor: 0, adjacentZoneIds: ['lab-b'] });
    field.setBaseline(PhysicalParameter.PM25, 'cleanroom', 2);
    field.set(PhysicalParameter.PM25, 'cleanroom', 2);
    return field;
  }
  const ATTRACTOR = () => 10; // ambient PM2.5 model

  it('point injection spreads gradually: cleanroom rises over ≥3 ticks to a small peak, then decays', () => {
    const field = makeField();
    // Point write (radius 0) — the T-708 injection semantics.
    field.set(PhysicalParameter.PM25, 'lab-b', 150);

    const cleanroomSamples: number[] = [];
    for (let t = 0; t < 600; t++) {
      field.step(1, ATTRACTOR);
      cleanroomSamples.push(field.get(PhysicalParameter.PM25, 'cleanroom')!);
    }

    // Rises over ≥3 ticks (was a one-step jump to 6.696 that then froze).
    const first = cleanroomSamples[0];
    const third = cleanroomSamples[2];
    expect(first).toBeGreaterThan(2.001);
    expect(third).toBeGreaterThan(first);
    // Small peak: <15% of the 150 µg/m³ source.
    const peak = Math.max(...cleanroomSamples);
    expect(peak).toBeLessThan(150 * 0.15);
    // Decays back to the 2±0.5 baseline within 10 sim-min.
    const last = cleanroomSamples[cleanroomSamples.length - 1];
    expect(Math.abs(last - 2)).toBeLessThanOrEqual(0.5);
  });

  it('source decay ratio ≈0.657/60 s preserved', () => {
    const field = makeField();
    field.set(PhysicalParameter.PM25, 'lab-b', 150);
    for (let t = 0; t < 60; t++) field.step(1, ATTRACTOR);
    const after = field.get(PhysicalParameter.PM25, 'lab-b')!;
    // Measured in the field: 96.5→63.4 per 60 s (ratio 0.657, τ≈143 s).
    expect(after / 150).toBeGreaterThan(0.55);
    expect(after / 150).toBeLessThan(0.75);
  });

  it('a neighbor NEVER gets cleaner because of contamination next door', () => {
    const field = new SpatialField();
    field.registerLocation('lab-a', { x: 0, y: 0 });
    field.registerLocation('lab-b', { x: 3, y: 0 });
    field.registerZoneMetadata('lab-a', { floor: 0, adjacentZoneIds: ['lab-b'] });
    field.registerZoneMetadata('lab-b', { floor: 0, adjacentZoneIds: ['lab-a'] });
    // lab-a currently DIRTY (30) though its baseline is 10; a small spike
    // lands in lab-b (15, baseline 14 → delta 1, falloff 0.4).
    field.setBaseline(PhysicalParameter.PM25, 'lab-a', 10);
    field.set(PhysicalParameter.PM25, 'lab-a', 30);
    field.setBaseline(PhysicalParameter.PM25, 'lab-b', 14);
    field.setLocalized(PhysicalParameter.PM25, 'lab-b', 15, 5, ATTRACTOR);

    // Additive spillover: lab-a = 30 + 1×0.4 (the old absolute write made
    // it 10 + 0.4 = 10.4 — contamination next door CLEANED it, F-PH09).
    expect(field.get(PhysicalParameter.PM25, 'lab-a')!).toBeCloseTo(30.4, 5);
  });
});
