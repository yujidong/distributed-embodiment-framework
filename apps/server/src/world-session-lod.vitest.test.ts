/**
 * DevLoop R30 (capacity §3): the LOD tier rides the P1W observer-pin
 * machinery — world-session status transitions map onto
 * EngineRuntime.setLodTier.
 *
 *   ACTIVE (observer pinned)              → 'observed' (full-precision dt=1)
 *   IDLE  (last observer released)        → 'idle'     (coarse 10s substep)
 *   wake/catch-up (醒来即追平)             → 'observed' for the fast-forward,
 *                                            restored to the steady tier after
 *
 * The P1W equivalence arms (world-session.vitest.test.ts part (b)) stay
 * bit-identical BECAUSE the catch-up advance always runs observed — this
 * file pins that mapping directly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { SimulationRegistry } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';

const tempDirs: string[] = [];
const registries: SimulationRegistry[] = [];
const services: WorldSessionService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const registry of registries.splice(0)) registry.stopAll();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lodScenario(): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'lod-env', name: 'LOD Env', description: 'tier-transition fixture' },
    zones: [
      {
        id: 'zone-a', name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
    ],
    devices: [
      {
        id: 'temp-sensor-a', name: 'Sensor A', type: 'temperature-sensor',
        capabilities: ['temperature-reading'], zoneId: 'zone-a', binding: 'sim://temp-sensor-a',
      },
    ],
    agents: [{
      id: 'lab-agent', name: 'Lab Agent', capabilities: ['temperature-monitoring'],
      managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
    }],
    events: [],
  } as unknown as ScenarioDefinition;
}

function makeService(nowRef: { now: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'world-session-lod-'));
  tempDirs.push(dir);
  const registry = new SimulationRegistry({}, dir);
  registries.push(registry);
  const scenarioRef = { current: lodScenario() };
  const service = new WorldSessionService({
    registry,
    scenarioOfEnv: () => scenarioRef.current,
    envOwnerIdOf: () => undefined,
    obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
    nowMs: () => nowRef.now,
    simPerWallSec: 60,
    attachDriver: false,
    idleGraceMs: 60_000, // never hibernates within these tests
  });
  services.push(service);
  return { registry, service };
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return predicate();
}

describe('R30 LOD tier rides the P1W observer pins', () => {
  it('observer arrival → observed; release → idle; the wake catch-up runs observed then restores idle', async () => {
    const now = { now: 0 };
    const { registry, service } = makeService(now);

    // Arrival: session materializes; the observer pins ACTIVE.
    const release = await service.observe('env-a');
    const record = registry.get('sim-env-a-world-session')!;
    expect(record.runtime.getLodTier()).toBe('observed');

    // Advance to sim 60 while observed (rate 60 → wall +1000ms).
    const anchor = record.runtime.getSimStartEpochMs();
    now.now = anchor + 1_000;
    await service.targetFor('env-a');
    expect(record.runtime.getSimTimeSec()).toBe(60);

    // Last observer leaves → IDLE tier (coarse physics from here on).
    release();
    expect(await until(() => registry.get('sim-env-a-world-session')!.runtime.getLodTier() === 'idle', 2_000))
      .toBe(true);
    expect(service.statusOf('env-a')!.status).toBe('idle');

    // Idle drift accumulates coarse batches (speed 60 → one advanceTo
    // stride per due window): +10s integrates ONE 10s batch, +5s banks
    // pending until the read surface flushes it.
    const idleRuntime = registry.get('sim-env-a-world-session')!.runtime;
    const before = idleRuntime.getPhysicsStepCount();
    await idleRuntime.advanceTo(idleRuntime.getSimTimeSec() + 10);
    expect(idleRuntime.getPhysicsStepCount() - before).toBe(1); // one 10s batch
    await idleRuntime.advanceTo(idleRuntime.getSimTimeSec() + 5);
    expect(idleRuntime.getPhysicsStepCount() - before).toBe(1); // 5s still banked
    idleRuntime.getSnapshot(); // read flush lands the banked 5s
    expect(idleRuntime.getPhysicsStepCount() - before).toBe(2);

    // A later arrival (targetFor, no pin): the catch-up fast-forward runs at
    // OBSERVED precision regardless of the idle tier the world drifted at,
    // then restores the idle steady tier.
    now.now = anchor + 3_000; // sim 180 target
    await service.targetFor('env-a');
    const after = registry.get('sim-env-a-world-session')!;
    expect(after.runtime.getSimTimeSec()).toBe(180);
    expect(after.runtime.getLodTier()).toBe('idle');
  });

  it('a pinned observer keeps the world observed across catches-up', async () => {
    const now = { now: 0 };
    const { registry, service } = makeService(now);
    const release = await service.observe('env-a');
    const record = registry.get('sim-env-a-world-session')!;
    const anchor = record.runtime.getSimStartEpochMs();

    now.now = anchor + 500;
    await service.targetFor('env-a'); // in-flight read, observer still pinned
    expect(record.runtime.getSimTimeSec()).toBe(30);
    expect(record.runtime.getLodTier()).toBe('observed');

    release();
    expect(await until(() => registry.get('sim-env-a-world-session')!.runtime.getLodTier() === 'idle', 2_000))
      .toBe(true);
  });
});
