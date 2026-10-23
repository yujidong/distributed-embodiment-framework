/**
 * Scripted spatial validation for the Suzhou apartment scenario (no LLM).
 *
 *   1. Build an EngineRuntime on config/scenarios/suzhou-apartment.json
 *      (scheduled scenario events stripped for a controlled experiment).
 *   2. Inject a temperature-spike into living-room (33.5°C).
 *   3. Command lr-hvac: set-temperature 25 → thermostat control loop.
 *   4. Run 30 sim-minutes (speed 60 sim-s/tick), print zone temperatures.
 *      Expected: living-room falls toward 25 and STABILIZES (no runaway);
 *      master-bedroom stays near its own baseline (≠ living-room).
 *   5. turn-off the HVAC, run 10 more sim-minutes.
 *      Expected: living-room relaxes back up toward its 31.5°C baseline.
 *
 * Run from the repo root:
 *   npx tsx packages/core/scripts/validate-suzhou-spatial.ts
 */

import { resolve } from 'node:path';

import { configureLogger, LoggerLevel } from '@active-collaboration/shared';
import { loadScenarioFromFile } from '../src/scenario/index.js';
import { EngineRuntime } from '../src/runtime/index.js';

configureLogger({ level: LoggerLevel.ERROR });

function zoneTemperatures(runtime: EngineRuntime): Record<string, string> {
  const snapshot = runtime.getSnapshot();
  const out: Record<string, string> = {};
  for (const zone of snapshot.zones) {
    const t = zone.parameters.temperature;
    out[zone.id] = typeof t === 'number' ? t.toFixed(2) : String(t);
  }
  return out;
}

async function main(): Promise<void> {
  const scenarioPath = resolve(process.cwd(), 'config/scenarios/suzhou-apartment.json');
  const scenario = loadScenarioFromFile(scenarioPath);
  // Strip scheduled scenario events: this is a controlled experiment.
  const runtime = new EngineRuntime({ ...scenario, events: [] }, {});

  runtime.start(60); // 60 simulated seconds per tick
  runtime.pause();   // manual stepping at that speed

  console.log('t=0min (baselines)      ', zoneTemperatures(runtime));

  await runtime.injectEvent({
    type: 'temperature-spike',
    zoneId: 'living-room',
    parameter: 'temperature',
    value: 33.5,
  });
  console.log('injected temperature-spike @living-room = 33.5');
  console.log('t=0min (after injection)', zoneTemperatures(runtime));

  const cmd = await runtime.executeDeviceCommand('lr-hvac', 'set-temperature', { targetTemperature: 25 });
  console.log(`lr-hvac set-temperature 25 → success=${cmd.success}`);

  for (let m = 1; m <= 30; m++) {
    const t0 = performance.now();
    await runtime.step(1); // 1 tick = 1 sim-minute
    if (m % 5 === 0 || m <= 2) {
      console.log(`t=${m}min (hvac on, step ${(performance.now() - t0).toFixed(0)}ms)    `, zoneTemperatures(runtime));
    }
  }

  const off = await runtime.executeDeviceCommand('lr-hvac', 'turn-off', {});
  console.log(`lr-hvac turn-off → success=${off.success}`);

  for (let m = 31; m <= 40; m++) {
    await runtime.step(1);
    if (m % 5 === 0) {
      console.log(`t=${m}min (hvac OFF)    `, zoneTemperatures(runtime));
    }
  }

  runtime.stop();

  runtime.stop();
  // Explicit exit: with the whole core module graph loaded, stdin ends up
  // resumed (a stdio handle keeps node's loop alive even after stop()).
  process.exit(0);
}

main().catch(error => {
  console.error('validation failed:', error);
  process.exit(1);
});
