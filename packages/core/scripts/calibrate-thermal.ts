/**
 * Thermal calibration tool (P3d).
 *
 * Given a MEASURED room-temperature curve and the thermostat setpoint
 * sequence that produced it, fit the simulator's thermal constants
 * (SpatialField temperature relaxation rate + effective HVAC °C/s rate) so
 * the sim matches reality — this is what makes "仿真验证过" mean something.
 *
 * The fit uses the real SpatialField (relaxation dynamics) and the real
 * thermostat control loop (±0.5 °C hysteresis), single-zone; see
 * packages/simulation/src/calibration/thermalFit.ts for the model.
 *
 * Usage (from the repo root):
 *   npx tsx packages/core/scripts/calibrate-thermal.ts \
 *     --csv packages/core/scripts/fixtures/thermal-curve.csv \
 *     --initial-temp 33.5 --ambient 31.5 \
 *     --setpoints "0=25,1800=off"
 *
 * Options:
 *   --csv <path>            measured curve: "timeSec,temperature" rows,
 *                           '#' comments allowed (REQUIRED)
 *   --initial-temp <°C>     room temperature at t=0 (REQUIRED)
 *   --ambient <°C>          ambient attractor the room relaxes toward (REQUIRED)
 *   --setpoints <spec>      "0=25,1800=27,3600=off" — setpoint sequence (REQUIRED)
 *   --relax <min:max[:steps]>   relaxation-rate search range, 1/s
 *                               (default 0.0001:0.005:13)
 *   --effect <min:max[:steps]>  HVAC-rate search range, °C/s
 *                               (default 0.005:0.08:13)
 *   --random <n>            seeded refinement samples around the grid winner
 *                           (default 200; 0 = grid only)
 *   --seed <n>              refinement RNG seed (default 1 — deterministic)
 *
 * Output: best-fit rates + RMSE (vs the current default constants), an ASCII
 * comparison table, a full comparison CSV written next to the input
 * (<input>.fit.csv), and a suggested patch snippet for the sim constants.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import {
  DEFAULT_THERMAL_RATES,
  fitThermalCurve,
  formatComparison,
  formatPatchSnippet,
  parseThermalCsv,
  type FitOptions,  type RateRange,
  type SetpointStep,
  type ThermalScenario,
} from '../../simulation/src/calibration/thermalFit.js';

configureLogger({ level: LoggerLevel.ERROR });

interface CliArgs {
  csv?: string;
  initialTemp?: number;
  ambientTemp?: number;
  setpoints?: SetpointStep[];
  options: FitOptions;
}

function parseRange(spec: string, flag: string): RateRange {
  const parts = spec.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2 || parts.length > 3) {
    throw new Error(`${flag}: expected "min:max[:steps]", got "${spec}"`);
  }
  const [min, max, steps] = parts;
  if (!(min > 0) || !(max > min)) {
    throw new Error(`${flag}: need 0 < min < max, got "${spec}"`);
  }
  return { min, max, steps: steps ?? 13 };
}

function parseSetpoints(spec: string): SetpointStep[] {
  const steps: SetpointStep[] = spec.split(',').map(entry => {
    const [atField, targetField] = entry.split('=').map(part => part.trim());
    const atSec = Number(atField);
    if (!Number.isFinite(atSec) || atSec < 0) {
      throw new Error(`--setpoints: bad time in "${entry}" (want "sec=temp" pairs)`);
    }
    if (targetField.toLowerCase() === 'off') return { atSec, targetC: null };
    const targetC = Number(targetField);
    if (!Number.isFinite(targetC)) {
      throw new Error(`--setpoints: bad target in "${entry}" (a number or "off")`);
    }
    return { atSec, targetC };
  });
  steps.sort((a, b) => a.atSec - b.atSec);
  if (steps.length === 0 || steps[0].atSec !== 0) {
    throw new Error('--setpoints: the first step must be at t=0');
  }
  return steps;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { options: {} };
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag}: missing value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => next(i++, flag);
    switch (flag) {
      case '--csv': args.csv = value(); break;
      case '--initial-temp': args.initialTemp = Number(value()); break;
      case '--ambient': args.ambientTemp = Number(value()); break;
      case '--setpoints': args.setpoints = parseSetpoints(value()); break;
      case '--relax': args.options.relaxationRange = parseRange(value(), flag); break;
      case '--effect': args.options.effectRange = parseRange(value(), flag); break;
      case '--random': args.options.randomSamples = Number(value()); break;
      case '--seed': args.options.seed = Number(value()); break;
      default:
        throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (!args.csv) throw new Error('--csv is required');
  if (args.initialTemp === undefined || !Number.isFinite(args.initialTemp)) {
    throw new Error('--initial-temp is required (°C at t=0)');
  }
  if (args.ambientTemp === undefined || !Number.isFinite(args.ambientTemp)) {
    throw new Error('--ambient is required (relaxation attractor °C)');
  }
  if (!args.setpoints) throw new Error('--setpoints is required ("0=25,1800=off")');
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = resolve(process.cwd(), args.csv as string);
  const measured = parseThermalCsv(readFileSync(csvPath, 'utf-8'));
  console.log(`loaded ${measured.length} measured samples from ${args.csv}`);

  const scenario: ThermalScenario = {
    initialTemp: args.initialTemp as number,
    ambientTemp: args.ambientTemp as number,
    setpoints: args.setpoints as SetpointStep[],
    dtSec: 1,
  };
  const result = fitThermalCurve(measured, scenario, args.options);

  console.log('\n=== fit result ===');
  console.log(
    `relaxationRate  ${result.relaxationRate.toFixed(6)} 1/s   ` +
    `(sim default ${DEFAULT_THERMAL_RATES.relaxationRate})`,
  );
  console.log(
    `hvacEffectRate  ${result.hvacEffectRate.toFixed(6)} °C/s  ` +
    `(sim default ≈${DEFAULT_THERMAL_RATES.hvacEffectRate})`,
  );
  console.log(
    `RMSE            ${result.rmse.toFixed(4)} °C   (default constants: ${result.defaultRmse.toFixed(4)} °C)`,
  );

  console.log('\n=== measured vs fitted ===');
  console.log(formatComparison(measured, result.simulated));

  const outPath = csvPath.replace(/\.csv$/i, '') + '.fit.csv';
  const lines = ['timeSec,measured,fitted,diff'];
  for (let i = 0; i < measured.length; i++) {
    const diff = result.simulated[i].temperature - measured[i].temperature;
    lines.push(
      `${measured[i].timeSec},${measured[i].temperature.toFixed(3)},` +
      `${result.simulated[i].temperature.toFixed(3)},${diff.toFixed(3)}`,
    );
  }
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`\nfull comparison written to ${outPath}`);

  console.log('\n=== suggested patch ===');
  console.log(formatPatchSnippet(result));

  // Exit code signals whether the fit beats the defaults at all.
  if (result.rmse >= result.defaultRmse) {
    console.warn('\nWARNING: fit did not improve on the default constants — check the scenario inputs.');
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (error) {
  console.error(`calibrate-thermal: ${(error as Error).message}`);
  process.exit(2);
}
