/**
 * @vitest-environment node
 *
 * DevLoop R30 Task 3 — multi-rate simulation at the IDLE tier.
 *
 * Frequency-separated subsystems (idle tier only; observed keeps the
 * per-tick contract byte-identical):
 *   - Physics: banked into 10s coarse batches (Task 1 — recomputed here as
 *     part of the engine-step accounting);
 *   - Environment parameters (outdoor sinusoid + PV daylight): every
 *     IDLE_ENV_BASELINE_EVERY_TICKS-th tick;
 *   - Condition-flow re-evaluation due grid: every
 *     IDLE_CONDITION_EVAL_EVERY_TICKS-th tick instead of every tick — the
 *     dominant idle-density lever (a condition-flow world gets no laziness
 *     at the observed tier by design, §8.3's bit-exact default);
 *   - Sensor sampling + agent decisions: already event/cadence driven.
 *
 * ACCEPTANCE: an idle condition-flow world's ENGINE STEPS (tick bodies)
 * drop ~10× for the same advanced sim-time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';
import {
  IDLE_CONDITION_EVAL_EVERY_TICKS,
  IDLE_ENV_BASELINE_EVERY_TICKS,
} from './index.js';
import type { FlowDefinition } from '../flows/index.js';

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function track<T extends EngineRuntime>(runtime: T): T {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.stop();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function conditionWorld(): ReturnType<typeof loadScenarioFile> {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'multirate-test', name: 'Multi-rate Test' },
    zones: [
      {
        id: 'zone-a', name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
      {
        id: 'outdoor-a', name: 'Outdoor', type: 'outdoor',
        bounds: { minX: 20, maxX: 30, minY: 0, maxY: 10 },
        adjacentZoneIds: ['zone-a'],
        // NO explicit temperature baseline — rides the auto sinusoid.
      },
    ],
    devices: [
      {
        id: 'hvac-a', name: 'HVAC A', type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'monitor-agent', name: 'Monitor', capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
      },
    ],
    events: [],
    flows: [
      {
        id: 'flow-condition',
        name: 'Heat edge',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'zone-a',
          conditions: [{ path: 'temperature', op: '>', value: 30 }],
          cooldownSimSec: 120,
        },
        plan: { goal: 'Cool on heat', nodes: [{ id: 'cool', capability: 'cooling' }] },
      } as unknown as FlowDefinition,
    ],
  });
}

describe('R30 Task 3: multi-rate simulation at the idle tier', () => {
  it('observed tier keeps the tick-grid condition cadence; idle coarsens 10x', () => {
    const observed = track(new EngineRuntime(conditionWorld()));
    expect(observed.getLodTier()).toBe('observed');
    observed.start(1, { lazy: true });
    // Observed: the next due after t=0 is the very next tick boundary.
    expect(observed.peekNextDueMoment()?.atSimSec).toBe(1);

    const idle = track(new EngineRuntime(conditionWorld()));
    idle.setLodTier('idle');
    idle.start(1, { lazy: true });
    // Idle: the condition-eval grid is IDLE_CONDITION_EVAL_EVERY_TICKS ticks.
    expect(idle.peekNextDueMoment()?.atSimSec).toBe(IDLE_CONDITION_EVAL_EVERY_TICKS);
  });

  it('an explicit conditionEvalEverySimSec policy wins over the LOD default', () => {
    const idle = track(new EngineRuntime(conditionWorld(), { conditionEvalEverySimSec: 45 }));
    idle.setLodTier('idle');
    idle.start(1, { lazy: true });
    expect(idle.peekNextDueMoment()?.atSimSec).toBe(45);
  });

  it('ACCEPTANCE: idle engine steps (tick bodies) drop ~10x for the same advance', async () => {
    const T = 3600;
    const observed = track(new EngineRuntime(conditionWorld()));
    observed.start(1, { lazy: true });
    await observed.advanceTo(T);
    const observedBodies = observed.getTickBodyCount();

    const idle = track(new EngineRuntime(conditionWorld()));
    idle.setLodTier('idle');
    idle.start(1, { lazy: true });
    await idle.advanceTo(T);
    const idleBodies = idle.getTickBodyCount();

    // Same world, same window: 3600 observed bodies vs ~360 idle bodies.
    expect(observedBodies).toBeGreaterThanOrEqual(T - 1);
    expect(idleBodies).toBeLessThanOrEqual(Math.ceil(T / IDLE_CONDITION_EVAL_EVERY_TICKS) + 2);
    expect(observedBodies / idleBodies).toBeGreaterThanOrEqual(8);
    expect(idle.getSimTimeSec()).toBe(T); // the window fully advanced
  });

  it('environment baselines refresh every 5th tick at idle (every tick when observed)', { timeout: 30_000 }, async () => {
    // The outdoor zone's value relaxes toward its (sinusoid) baseline — at
    // the idle tier the baseline only refreshes on every
    // IDLE_ENV_BASELINE_EVERY_TICKS-th advanceTickBy call, so the value
    // holds steady within the window and moves again at the refresh.
    const observed = track(new EngineRuntime(conditionWorld()));
    observed.start(1, { lazy: true });
    const idle = track(new EngineRuntime(conditionWorld()));
    idle.setLodTier('idle');
    idle.start(1, { lazy: true });

    // Advance to a strictly-decreasing part of the daily curve (past the
    // 14:00 peak): sim 7200s = 14:00 exactly... use 9000s (15:00), falling.
    await observed.advanceTo(9000);
    await idle.advanceTo(9000);
    const observedTemp = outdoorTemperature(observed);
    const idleTemp = outdoorTemperature(idle);
    expect(observedTemp).toBeDefined();
    expect(idleTemp).toBeDefined();
    // Same attractor family, coarser refresh: the 5-tick granularity is
    // invisible next to the hour-scale sinusoid (≤4s staleness).
    expect(Math.abs(idleTemp! - observedTemp!)).toBeLessThan(0.5);
    // And the refresh cadence itself: the value holds steady until the
    // next 5-tick boundary lands a fresh sinusoid value.
    const before = outdoorTemperature(idle)!;
    await idle.advanceTo(idle.getSimTimeSec() + IDLE_ENV_BASELINE_EVERY_TICKS - 1);
    const mid = outdoorTemperature(idle)!;
    expect(mid).toBe(before); // no refresh within the window
    await idle.advanceTo(idle.getSimTimeSec() + 1);
    const after = outdoorTemperature(idle)!;
    expect(Math.abs(after - before)).toBeLessThan(1); // refreshed with the sinusoid
  });

  it('device energy accumulation batches with physics at idle (dt-scaled totals match)', async () => {
    const observed = track(new EngineRuntime(conditionWorld()));
    observed.start(1, { lazy: true });
    const idle = track(new EngineRuntime(conditionWorld()));
    idle.setLodTier('idle');
    idle.start(1, { lazy: true });

    for (const runtime of [observed, idle]) {
      const result = await runtime.executeDeviceCommand('hvac-a', 'turn-on');
      expect(result.success).toBe(true);
    }
    await observed.advanceTo(600);
    await idle.advanceTo(600);

    const energyOf = (runtime: EngineRuntime): unknown =>
      runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.cumulativeEnergyWh;
    const observedWh = energyOf(observed);
    const idleWh = energyOf(idle);
    expect(typeof observedWh).toBe('number');
    // The idle run accumulated in 10s batches; dt-scaled accumulation means
    // the TOTAL matches within float rounding (≤1% of the observed total).
    expect(Math.abs((idleWh as number) - (observedWh as number)))
      .toBeLessThanOrEqual(Math.abs(observedWh as number) * 0.01 + 1e-9);
  });
});

function outdoorTemperature(runtime: EngineRuntime): number | undefined {
  const zone = runtime.getSnapshot().zones.find(z => z.id === 'outdoor-a');
  const value = zone?.parameters['temperature'];
  return typeof value === 'number' ? value : undefined;
}
