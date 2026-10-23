/**
 * @vitest-environment node
 *
 * Thermal calibration fit tests (P3d).
 *
 * The core property: a synthetic curve generated with KNOWN rates is
 * recovered by the fit ≈ the original rates. Verified twice — once against
 * an in-test generated curve, and once against the committed fixture
 * (packages/core/scripts/fixtures/thermal-curve.csv, ground truth in its
 * header) so the CLI's demo data can never silently drift away from what
 * the fitter can recover.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fitThermalCurve,
  parseThermalCsv,
  sampleCurve,
  simulateThermalCurve,
  toThermalCsv,
  formatComparison,
  formatPatchSnippet,
  type ThermalSample,
} from './thermalFit.js';

/** Scenario shared by the fixture and the in-test curve (see fixture header). */
const SCENARIO = {
  initialTemp: 33.5,
  ambientTemp: 31.5,
  setpoints: [
    { atSec: 0, targetC: 25 as number | null },
    { atSec: 1800, targetC: null as number | null },
  ],
  dtSec: 1,
};
const DURATION_SEC = 2700;
const TRUTH = { relaxationRate: 0.0008, hvacEffectRate: 0.03 };

/** Deterministic ±0.05 °C "sensor noise", 60 s sampling (fixture recipe). */
function syntheticMeasured(): ThermalSample[] {
  const curve = simulateThermalCurve({ ...SCENARIO, durationSec: DURATION_SEC }, TRUTH);
  const measured: ThermalSample[] = [];
  for (let t = 0; t <= DURATION_SEC; t += 60) {
    const noise = (((t * 7919) % 100) / 100) * 0.1 - 0.05;
    measured.push({ timeSec: t, temperature: sampleCurve(curve, 1, [t])[0] + noise });
  }
  return measured;
}

describe('fitThermalCurve', () => {
  it('recovers known rates from a synthetic curve (generated in-test)', () => {
    const result = fitThermalCurve(syntheticMeasured(), SCENARIO, { randomSamples: 300, seed: 7 });

    // Within ~5% of the ground truth despite the injected sensor noise.
    expect(Math.abs(result.relaxationRate - TRUTH.relaxationRate) / TRUTH.relaxationRate)
      .toBeLessThan(0.05);
    expect(Math.abs(result.hvacEffectRate - TRUTH.hvacEffectRate) / TRUTH.hvacEffectRate)
      .toBeLessThan(0.05);
    // The fit beats the simulator's current default constants decisively.
    expect(result.rmse).toBeLessThan(0.1);
    expect(result.rmse).toBeLessThan(result.defaultRmse / 5);
  });

  it('recovers the committed fixture curve (the CLI demo data)', () => {
    const fixturePath = join(
      __dirname,
      '../../../core/scripts/fixtures/thermal-curve.csv',
    );
    const measured = parseThermalCsv(readFileSync(fixturePath, 'utf-8'));
    expect(measured.length).toBeGreaterThan(10);

    const result = fitThermalCurve(measured, SCENARIO, { randomSamples: 300, seed: 7 });

    expect(Math.abs(result.relaxationRate - TRUTH.relaxationRate) / TRUTH.relaxationRate)
      .toBeLessThan(0.05);
    expect(Math.abs(result.hvacEffectRate - TRUTH.hvacEffectRate) / TRUTH.hvacEffectRate)
      .toBeLessThan(0.05);
    expect(result.rmse).toBeLessThan(0.1);
  });

  it('is deterministic for a fixed seed', () => {
    const measured = syntheticMeasured();
    const a = fitThermalCurve(measured, SCENARIO, { randomSamples: 100, seed: 3 });
    const b = fitThermalCurve(measured, SCENARIO, { randomSamples: 100, seed: 3 });
    expect(a.relaxationRate).toBe(b.relaxationRate);
    expect(a.hvacEffectRate).toBe(b.hvacEffectRate);
    expect(a.rmse).toBe(b.rmse);
  });

  it('rejects too-short inputs', () => {
    expect(() =>
      fitThermalCurve([{ timeSec: 0, temperature: 33.5 }], SCENARIO),
    ).toThrow(/at least 2/);
  });
});

describe('thermal CSV + output helpers', () => {
  it('parses CSV with comments, a header row and CRLF endings', () => {
    const text = '# comment\r\n\r\ntimeSec,temperature\r\n0,33.5\r\n60,31.6\r\n';
    expect(parseThermalCsv(text)).toEqual([
      { timeSec: 0, temperature: 33.5 },
      { timeSec: 60, temperature: 31.6 },
    ]);
  });

  it('round-trips through toThermalCsv (3-decimal precision)', () => {
    const samples = syntheticMeasured().slice(0, 5);
    const parsed = parseThermalCsv(toThermalCsv(samples));
    expect(parsed).toHaveLength(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(parsed[i].timeSec).toBe(samples[i].timeSec);
      expect(Math.abs(parsed[i].temperature - samples[i].temperature)).toBeLessThan(0.001);
    }
  });

  it('rejects malformed data lines', () => {
    expect(() => parseThermalCsv('0,33.5\nnope\n')).toThrow(/malformed/);
    expect(() => parseThermalCsv('# only comments\n')).toThrow(/no samples/);
  });

  it('formats the ASCII comparison and the patch snippet', () => {
    const measured = syntheticMeasured();
    const result = fitThermalCurve(measured, SCENARIO, { randomSamples: 50, seed: 1 });

    const table = formatComparison(measured, result.simulated);
    expect(table).toContain('measured');
    expect(table).toContain('fitted');
    expect(table.split('\n').length).toBeGreaterThan(5);

    const snippet = formatPatchSnippet(result);
    expect(snippet).toContain('RELAXATION_RATES');
    expect(snippet).toContain(result.relaxationRate.toFixed(6));
    expect(snippet).toContain(result.hvacEffectRate.toFixed(4));
  });
});
