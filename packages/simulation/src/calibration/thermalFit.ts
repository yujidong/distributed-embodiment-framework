/**
 * Thermal calibration fit (P3d)
 *
 * Given a MEASURED room-temperature curve (CSV `{ timeSec, temperature }`,
 * e.g. a Home Assistant history export) and the thermostat setpoint
 * sequence that produced it, fit the simulator's two thermal constants so
 * the sim reproduces reality:
 *
 *   - `relaxationRate` (1/s) — the SpatialField relaxation rate for
 *     `temperature` (how fast the room drifts back to ambient);
 *   - `hvacEffectRate` (°C/s) — the effective warming/cooling rate the HVAC
 *     delivers while its effect is enabled (the production value ~0.022 °C/s
 *     emerges from HeatTransferModel: effectivePower / thermalMass).
 *
 * The simulated curve uses the REAL pieces: a SpatialField (with per-instance
 * rate overrides) for relaxation dynamics, and the real thermostat control
 * loop (`applyDeviceControlLoop`, ±0.5 °C hysteresis) to cycle the effect —
 * driven by the SAME setpoint sequence as the real run. Single-zone: with
 * one location, diffusion is a no-op by construction.
 *
 * Fitting: log-spaced grid search over (relaxationRate × hvacEffectRate)
 * minimizing RMSE against the measured samples, then an optional seeded
 * random refinement around the grid winner. Deterministic for a fixed seed.
 *
 * This module is used by packages/core/scripts/calibrate-thermal.ts and is
 * deliberately free of engine/runtime concerns.
 */

import { applyDeviceControlLoop, type DeviceControlView } from '../devices/controllers.js';
import { PhysicalParameter } from '../devices/types.js';
import { SpatialField } from '../physics/SpatialField.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One measured sample: seconds since run start, °C. */
export interface ThermalSample {
  timeSec: number;
  temperature: number;
}

/** One setpoint change: at `atSec` the thermostat is set to `targetC` (null = HVAC off). */
export interface SetpointStep {
  atSec: number;
  targetC: number | null;
}

/** Fixed scenario parameters of the measured run. */
export interface ThermalScenario {
  /** Room temperature at t=0 (°C). */
  initialTemp: number;
  /** Ambient/outside attractor the room relaxes toward (°C). */
  ambientTemp: number;
  /** Setpoint sequence, sorted by atSec ascending; the first entry must have atSec 0. */
  setpoints: SetpointStep[];
  /** Integration step (simulated seconds, default 1). */
  dtSec?: number;
}

/** The two fitted thermal constants. */
export interface ThermalRates {
  /** SpatialField relaxation rate for temperature (1/s). */
  relaxationRate: number;
  /** Effective HVAC warming/cooling rate while enabled (°C/s, magnitude). */
  hvacEffectRate: number;
}

/** Inclusive [min, max] search range with a grid step count. */
export interface RateRange {
  min: number;
  max: number;
  steps: number;
}

export interface FitOptions {
  relaxationRange?: RateRange;
  effectRange?: RateRange;
  /** Seeded random refinement samples around the grid winner (0 = off). */
  randomSamples?: number;
  /** Seed for the refinement RNG (default 1 — deterministic fits). */
  seed?: number;
}

export interface FitResult extends ThermalRates {
  rmse: number;
  /** RMSE of the simulator's current default constants (for comparison). */
  defaultRmse: number;
  /** Simulated temperatures aligned to the measured sample times. */
  simulated: ThermalSample[];
}

/** The simulator's current default thermal constants (documentation anchor). */
export const DEFAULT_THERMAL_RATES: ThermalRates = {
  relaxationRate: 0.0004, // SpatialField RELAXATION_RATES.temperature
  hvacEffectRate: 0.022, // ~3 kW HVAC through HeatTransferModel defaults
};

const DEFAULT_RELAXATION_RANGE: RateRange = { min: 0.0001, max: 0.005, steps: 13 };
const DEFAULT_EFFECT_RANGE: RateRange = { min: 0.005, max: 0.08, steps: 13 };

// ---------------------------------------------------------------------------
// Simulation (real SpatialField + real thermostat controller)
// ---------------------------------------------------------------------------

const ROOM = 'room';

/**
 * Simulate the room-temperature curve of `scenario` with the given rates.
 * Returns the field temperature on the dt grid (index i = time i·dtSec,
 * covering [0, durationSec]).
 */
export function simulateThermalCurve(
  scenario: ThermalScenario & { durationSec: number },
  rates: ThermalRates,
): number[] {
  const dt = scenario.dtSec ?? 1;
  const steps = Math.max(1, Math.round(scenario.durationSec / dt));

  const field = new SpatialField({ relaxation: { temperature: rates.relaxationRate } });
  field.registerLocation(ROOM, { x: 0, y: 0 });
  field.setBaseline(PhysicalParameter.TEMPERATURE, ROOM, scenario.ambientTemp);
  field.set(PhysicalParameter.TEMPERATURE, ROOM, scenario.initialTemp);
  // Only the seeded per-location baseline attracts (no global fallback).
  const attractor = (): number | undefined => undefined;

  const setpoints = [...scenario.setpoints].sort((a, b) => a.atSec - b.atSec);

  // Thermostat device state mirrored for the controller view.
  let powered = false;
  let targetC: number | null = null;
  /** Effect direction, chosen at setpoint activation (like the real device). */
  let effectSign = 1;
  let effectEnabled = false;
  let activeSetpointIndex = -1;

  const view: DeviceControlView = {
    type: 'hvac',
    getStateValue: key => {
      if (key === 'power') return powered;
      if (key === 'targetTemperature') return targetC ?? undefined;
      return undefined;
    },
    readLocal: parameter =>
      parameter === PhysicalParameter.TEMPERATURE
        ? field.get(PhysicalParameter.TEMPERATURE, ROOM)
        : undefined,
    getEffectMagnitude: parameter =>
      parameter === PhysicalParameter.TEMPERATURE ? effectSign : undefined,
    setEffectEnabled: (parameter, enabled) => {
      if (parameter === PhysicalParameter.TEMPERATURE) effectEnabled = enabled;
    },
  };

  const curve: number[] = [scenario.initialTemp];
  for (let i = 1; i <= steps; i++) {
    const t = i * dt;

    // Activate setpoint steps that came due (direction fixed at activation,
    // mirroring the real handler choosing the effect sign at command time).
    while (activeSetpointIndex + 1 < setpoints.length &&
      setpoints[activeSetpointIndex + 1].atSec <= t - 1e-9) {
      activeSetpointIndex += 1;
      const step = setpoints[activeSetpointIndex];
      targetC = step.targetC;
      powered = step.targetC !== null;
      if (powered) {
        const current = field.get(PhysicalParameter.TEMPERATURE, ROOM) ?? scenario.initialTemp;
        effectSign = (step.targetC as number) >= current ? 1 : -1;
        effectEnabled = true;
      } else {
        effectEnabled = false;
      }
    }

    // 1. Device control loop (real thermostat hysteresis policy).
    if (powered) applyDeviceControlLoop(view);

    // 2. HVAC effect: the fitted effective rate while the effect is enabled.
    if (effectEnabled) {
      const current = field.get(PhysicalParameter.TEMPERATURE, ROOM);
      if (current !== undefined) {
        field.set(
          PhysicalParameter.TEMPERATURE,
          ROOM,
          current + effectSign * rates.hvacEffectRate * dt,
        );
      }
    }

    // 3. Field dynamics (relaxation toward the ambient baseline + clamp).
    field.step(dt, attractor);

    curve.push(field.get(PhysicalParameter.TEMPERATURE, ROOM) ?? scenario.initialTemp);
  }
  return curve;
}

/** Sample a dt-grid curve at arbitrary measurement times (nearest grid point). */
export function sampleCurve(curve: number[], dtSec: number, timesSec: number[]): number[] {
  return timesSec.map(t => {
    const index = Math.min(curve.length - 1, Math.max(0, Math.round(t / dtSec)));
    return curve[index];
  });
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

/** Root-mean-square error between measured and simulated temperatures. */
export function rmse(measured: number[], simulated: number[]): number {
  if (measured.length === 0 || measured.length !== simulated.length) {
    throw new Error(`rmse: length mismatch (${measured.length} vs ${simulated.length})`);
  }
  let sum = 0;
  for (let i = 0; i < measured.length; i++) {
    const d = measured[i] - simulated[i];
    sum += d * d;
  }
  return Math.sqrt(sum / measured.length);
}

/** mulberry32 deterministic PRNG for the refinement stage. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Log-spaced grid values in [min, max]. */
function logGrid(range: RateRange): number[] {
  const steps = Math.max(2, range.steps);
  const logMin = Math.log(range.min);
  const logMax = Math.log(range.max);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(Math.exp(logMin + ((logMax - logMin) * i) / (steps - 1)));
  }
  return out;
}

/**
 * Fit (relaxationRate, hvacEffectRate) against the measured curve.
 * Deterministic for a fixed seed; the scenario's duration is taken from the
 * last measured sample.
 */
export function fitThermalCurve(
  measured: ThermalSample[],
  scenario: ThermalScenario,
  options: FitOptions = {},
): FitResult {
  if (measured.length < 2) {
    throw new Error('fitThermalCurve: need at least 2 measured samples');
  }
  const dt = scenario.dtSec ?? 1;
  const durationSec = measured[measured.length - 1].timeSec;
  const times = measured.map(s => s.timeSec);
  const values = measured.map(s => s.temperature);

  const evaluate = (rates: ThermalRates): number => {
    const curve = simulateThermalCurve({ ...scenario, durationSec }, rates);
    return rmse(values, sampleCurve(curve, dt, times));
  };

  // 1. Coarse log-grid search.
  const relaxGrid = logGrid(options.relaxationRange ?? DEFAULT_RELAXATION_RANGE);
  const effectGrid = logGrid(options.effectRange ?? DEFAULT_EFFECT_RANGE);
  let best: ThermalRates = { relaxationRate: relaxGrid[0], hvacEffectRate: effectGrid[0] };
  let bestRmse = Number.POSITIVE_INFINITY;
  for (const relaxationRate of relaxGrid) {
    for (const hvacEffectRate of effectGrid) {
      const score = evaluate({ relaxationRate, hvacEffectRate });
      if (score < bestRmse) {
        bestRmse = score;
        best = { relaxationRate, hvacEffectRate };
      }
    }
  }

  // 2. Seeded random refinement: log-uniform jitter in a shrinking
  //    neighborhood (±1 grid step, halved every quarter of the budget).
  const randomSamples = options.randomSamples ?? 200;
  if (randomSamples > 0) {
    const rng = mulberry32(options.seed ?? 1);
    const relaxStep =
      (Math.log(options.relaxationRange?.max ?? DEFAULT_RELAXATION_RANGE.max) -
        Math.log(options.relaxationRange?.min ?? DEFAULT_RELAXATION_RANGE.min)) /
      (Math.max(2, options.relaxationRange?.steps ?? DEFAULT_RELAXATION_RANGE.steps) - 1);
    const effectStep =
      (Math.log(options.effectRange?.max ?? DEFAULT_EFFECT_RANGE.max) -
        Math.log(options.effectRange?.min ?? DEFAULT_EFFECT_RANGE.min)) /
      (Math.max(2, options.effectRange?.steps ?? DEFAULT_EFFECT_RANGE.steps) - 1);
    for (let i = 0; i < randomSamples; i++) {
      const shrink = Math.pow(0.5, Math.floor((i / randomSamples) * 4));
      const jitter = (span: number) => (rng() * 2 - 1) * span * shrink;
      const candidate: ThermalRates = {
        relaxationRate: best.relaxationRate * Math.exp(jitter(relaxStep)),
        hvacEffectRate: best.hvacEffectRate * Math.exp(jitter(effectStep)),
      };
      const score = evaluate(candidate);
      if (score < bestRmse) {
        bestRmse = score;
        best = candidate;
      }
    }
  }

  const curve = simulateThermalCurve({ ...scenario, durationSec }, best);
  const simulatedValues = sampleCurve(curve, dt, times);
  const defaultCurve = simulateThermalCurve({ ...scenario, durationSec }, DEFAULT_THERMAL_RATES);
  const defaultRmse = rmse(values, sampleCurve(defaultCurve, dt, times));

  return {
    ...best,
    rmse: rmse(values, simulatedValues),
    defaultRmse,
    simulated: measured.map((s, i) => ({ timeSec: s.timeSec, temperature: simulatedValues[i] })),
  };
}

// ---------------------------------------------------------------------------
// CSV + comparison output
// ---------------------------------------------------------------------------

/**
 * Parse a `{ timeSec, temperature }` CSV. Blank lines and `#` comments are
 * skipped; a leading non-numeric line is treated as a header. Extra columns
 * are ignored.
 */
export function parseThermalCsv(text: string): ThermalSample[] {
  const samples: ThermalSample[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [timeField, tempField] = line.split(',').map(part => part.trim());
    const timeSec = Number(timeField);
    const temperature = Number(tempField);
    if (Number.isNaN(timeSec) || Number.isNaN(temperature)) {
      if (samples.length === 0) continue; // header row
      throw new Error(`parseThermalCsv: malformed data line "${line}"`);
    }
    samples.push({ timeSec, temperature });
  }
  if (samples.length === 0) throw new Error('parseThermalCsv: no samples found');
  return samples;
}

/** Serialize samples to CSV (fixture generation / comparison output). */
export function toThermalCsv(samples: ThermalSample[]): string {
  const lines = ['timeSec,temperature'];
  for (const s of samples) {
    lines.push(`${s.timeSec},${s.temperature.toFixed(3)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Small ASCII comparison of the measured and fitted curves: a compact table
 * (downsampled to at most `maxRows` rows) plus per-row absolute error.
 */
export function formatComparison(
  measured: ThermalSample[],
  simulated: ThermalSample[],
  maxRows = 24,
): string {
  if (measured.length !== simulated.length) {
    throw new Error('formatComparison: measured/simulated length mismatch');
  }
  const stride = Math.max(1, Math.ceil(measured.length / maxRows));
  const lines = [
    '   time(s) | measured |  fitted  |   diff',
    '-----------+----------+----------+--------',
  ];
  for (let i = 0; i < measured.length; i += stride) {
    const m = measured[i];
    const s = simulated[i];
    lines.push(
      `${m.timeSec.toFixed(0).padStart(10)} | ${m.temperature.toFixed(2).padStart(8)} | ` +
      `${s.temperature.toFixed(2).padStart(8)} | ${(s.temperature - m.temperature).toFixed(2).padStart(6)}`,
    );
  }
  return lines.join('\n');
}

/**
 * Suggested patch for the simulator constants, given a fit. Printed as a
 * snippet the operator can paste into SpatialField.ts (relaxation rate) —
 * the HVAC rate is an emergent value (effectivePower / thermalMass), so the
 * snippet explains how to reach it rather than naming a single constant.
 */
export function formatPatchSnippet(result: FitResult): string {
  const thermalMass = (3000 * 0.9) / result.hvacEffectRate; // 3 kW template × default efficiency
  return [
    '// packages/simulation/src/physics/SpatialField.ts',
    'const RELAXATION_RATES: Record<string, number> = {',
    `  temperature: ${result.relaxationRate.toFixed(6)}, // calibrated (RMSE ${result.rmse.toFixed(3)} °C; default ${DEFAULT_THERMAL_RATES.relaxationRate} → RMSE ${result.defaultRmse.toFixed(3)} °C)`,
    '  ...',
    '};',
    '',
    `// HVAC effective rate fitted at ${result.hvacEffectRate.toFixed(4)} °C/s`,
    `// (sim default ≈ ${DEFAULT_THERMAL_RATES.hvacEffectRate} °C/s). It is emergent:`,
    '// rate = hvacPower × hvacEfficiency / thermalMass (HeatTransferModel). For the',
    `// 3 kW template at 0.9 efficiency that implies thermalMass ≈ ${(thermalMass / 1000).toFixed(1)} kJ/K`,
    '// — adjust roomVolume/thermalMass (HeatTransferModel defaults) or the template',
    '// wattage (DeviceTemplateRegistry) to match your hardware.',
  ].join('\n');
}
