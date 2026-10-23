/**
 * @vitest-environment node
 *
 * DevLoop R30 (capacity §3): zone-level LOD — the physics level-of-detail
 * tier (PhysicsLodTier).
 *
 * ACCEPTANCE (Task 1):
 *   (a) OBSERVED is the default and BYTE-IDENTICAL to a pre-R30 run: a
 *       runtime that never touches setLodTier and one pinned to 'observed'
 *       produce equal snapshots, and every sim-second integrates exactly one
 *       dt=1 substep (physicsStepCount == simTimeSec at speed 1).
 *   (b) IDLE coarsens ~10×: the same advanceTo work integrates ~1/10 the
 *       substeps (ceil batches of IDLE_PHYSICS_SUBSTEP_SEC).
 *   (c) The idle integration stays CORRECT, just coarser: an idle-run world
 *       with an active heater converges to (approximately) the same zone
 *       temperature as an observed-run twin — same attractor, coarser path.
 *   (d) Reads never serve stale physics: getSnapshot flushes pending idle
 *       batches (the snapshot's physics is integrated up to simTimeSec).
 *
 * Fixture discipline (lessons.md): every zone pins `baseline.temperature`,
 * and comparison arms share ONE clock anchor (freshWithAnchor) so the
 * time-dependent default value models cannot drift the low-order digits.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, IDLE_PHYSICS_SUBSTEP_SEC } from './index.js';
import type { EngineSnapshot } from './contract.js';

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function track<T extends EngineRuntime>(runtime: T): T {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function lodScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'lod-test', name: 'LOD Test' },
    zones: [
      {
        id: 'zone-a',
        name: 'Zone A',
        adjacentZoneIds: ['zone-b'],
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
      {
        id: 'zone-b',
        name: 'Zone B',
        adjacentZoneIds: ['zone-a'],
        bounds: { minX: 12, maxX: 22, minY: 0, maxY: 10 },
        baseline: { temperature: 18 },
      },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        name: 'Sensor A',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'heater-a',
        name: 'Heater A',
        type: 'heater',
        capabilities: ['turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'monitor-agent',
        name: 'Monitor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a', 'heater-a'],
      },
    ],
    events: [],
  });
}

/** Fresh runtime sharing runtimeA's clock anchor (the P0/P1 discipline). */
function freshWithAnchor(anchorEpochMs: number): EngineRuntime {
  const runtime = track(new EngineRuntime(lodScenario()));
  const world = runtime.exportWorldState();
  runtime.stop();
  const twin = track(new EngineRuntime(lodScenario()));
  twin.restoreWorldState({ ...world, simStartEpochMs: anchorEpochMs });
  return twin;
}

function zoneTemp(snapshot: EngineSnapshot, zoneId: string): number {
  const zone = snapshot.zones.find(z => z.id === zoneId);
  expect(zone).toBeDefined();
  const value = zone!.parameters['temperature'];
  expect(typeof value).toBe('number');
  return value as number;
}

describe('DevLoop R30: zone-level physics LOD tier', () => {
  it('defaults to observed; explicit observed is byte-identical to default', async () => {
    const base = track(new EngineRuntime(lodScenario()));
    const anchor = base.getSimStartEpochMs();
    const explicitObserved = freshWithAnchor(anchor);
    explicitObserved.setLodTier('observed');

    await base.step(120);
    await explicitObserved.step(120);

    expect(base.getLodTier()).toBe('observed');
    expect(explicitObserved.getLodTier()).toBe('observed');
    // One dt=1 substep per sim-second at speed 1 (the pre-R30 contract).
    expect(base.getPhysicsStepCount()).toBe(120);
    expect(explicitObserved.getPhysicsStepCount()).toBe(120);
    expect(base.getSnapshot().zones).toEqual(explicitObserved.getSnapshot().zones);
    expect(base.getSimTimeSec()).toBe(explicitObserved.getSimTimeSec());
  });

  it('idle integrates ~10x fewer substeps for the same advance work', async () => {
    const observed = track(new EngineRuntime(lodScenario()));
    const anchor = observed.getSimStartEpochMs();
    const idle = freshWithAnchor(anchor);
    idle.setLodTier('idle');

    // advanceTo walks the same window in both tiers.
    await observed.advanceTo(3600);
    await idle.advanceTo(3600);

    expect(observed.getSimTimeSec()).toBe(3600);
    expect(idle.getSimTimeSec()).toBe(3600);
    // Observed: ~1 substep/sim-sec. Idle: batches of >=10 sim-sec → ~1/10.
    expect(observed.getPhysicsStepCount()).toBeGreaterThanOrEqual(3600);
    expect(idle.getPhysicsStepCount()).toBeLessThanOrEqual(
      Math.ceil(3600 / IDLE_PHYSICS_SUBSTEP_SEC) + 1,
    );
    expect(idle.getPhysicsStepCount()).toBeLessThanOrEqual(
      observed.getPhysicsStepCount() / 9,
    );
  });

  it('idle step() batches too (per-tick strides accumulate, not integrate)', async () => {
    const runtime = track(new EngineRuntime(lodScenario()));
    runtime.setLodTier('idle');
    await runtime.step(90);
    expect(runtime.getSimTimeSec()).toBe(90);
    // 90 one-second ticks → batches at 10,20,...,90 = 9 coarse substeps
    // (each <= 10s). The observed tier would have integrated 90.
    expect(runtime.getPhysicsStepCount()).toBe(9);
  });

  it('idle evolution is the same integration, coarser: heater twin converges near the observed run', async () => {
    const observed = track(new EngineRuntime(lodScenario()));
    const anchor = observed.getSimStartEpochMs();
    const idle = freshWithAnchor(anchor);

    // Turn the heater on in BOTH worlds (device command path).
    for (const runtime of [observed, idle]) {
      const result = await runtime.executeDeviceCommand('heater-a', 'turn-on');
      expect(result.success).toBe(true);
    }
    idle.setLodTier('idle');

    await observed.advanceTo(600);
    await idle.advanceTo(600);

    const tObserved = zoneTemp(observed.getSnapshot(), 'zone-a');
    const tIdle = zoneTemp(idle.getSnapshot(), 'zone-a');
    // Both worlds heated from 22°C for 600 sim-s with the same drive; the
    // coarse path differs only in integration error (well under a degree
    // for a system with minute-scale time constants).
    expect(Math.abs(tIdle - tObserved)).toBeLessThan(1.0);
    expect(tIdle).toBeGreaterThan(22.5); // the heater visibly ran
    expect(tObserved).toBeGreaterThan(22.5);
  });

  it('getSnapshot flushes pending idle physics (reads never serve stale values)', async () => {
    const runtime = track(new EngineRuntime(lodScenario()));
    runtime.setLodTier('idle');
    // 25 ticks: batches integrated at 10 and 20; 5 seconds pending.
    await runtime.step(25);
    const beforeFlushSteps = runtime.getPhysicsStepCount();
    expect(beforeFlushSteps).toBe(2); // batches at 10 and 20
    // A read surface flushes the pending 5s (one coarse substep of dt=5).
    runtime.getSnapshot();
    expect(runtime.getPhysicsStepCount()).toBe(beforeFlushSteps + 1);
    // A second read with no advancement adds nothing.
    runtime.getSnapshot();
    expect(runtime.getPhysicsStepCount()).toBe(beforeFlushSteps + 1);
  });

  it('tier switch back to observed flushes idle-accumulated seconds at the idle stride', async () => {
    const runtime = track(new EngineRuntime(lodScenario()));
    runtime.setLodTier('idle');
    await runtime.step(14); // batch at 10; 4 seconds pending
    expect(runtime.getPhysicsStepCount()).toBe(1);
    runtime.setLodTier('observed'); // flushes the pending 4s
    expect(runtime.getPhysicsStepCount()).toBe(2);
    // From here on the observed contract resumes: 1 substep/sim-sec.
    await runtime.step(5);
    expect(runtime.getPhysicsStepCount()).toBe(7);
  });
});
