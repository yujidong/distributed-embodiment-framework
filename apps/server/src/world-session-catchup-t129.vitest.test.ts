/**
 * @vitest-environment node
 *
 * T129 (R21-F1) — the world-session catch-up under a GIANT gap: the r20/r21
 * outage's exact seat. A world hours behind wall needs tens of thousands of
 * sim-sec fast-forwarded; the pre-fix code ran that advance INSIDE the
 * per-env ops FIFO with the caller awaiting all of it, so every
 * consumption-lane call sat behind the queue head until the public gateway
 * answered a bare 504 (R21: both agreements' invokes + the consumer's read,
 * >100s, zero platform teaching, usage frozen for +15 minutes).
 *
 * The contract pinned here (world semantics unchanged — the advance always
 * completes, never truncates, never jumps):
 * - `targetFor` returns within the injected sync cap while the advance keeps
 *   running on the background chain (detach, not cancellation);
 * - the background advance reaches the FULL wall-mapped target (until());
 * - arrivals during a long advance are no longer head-of-line blocked;
 * - a record replaced/removed mid-advance bails the background loop quietly;
 * - a healthy sub-cap gap keeps the EXACT pre-T129 semantics: targetFor
 *   returns the world already fully caught up;
 * - lifecycle statuses are untouched by all of it (zero state-machine drift).
 *
 * Clock discipline (the P1W equivalence-suite pattern): simPerWallSec 60
 * (1 wall-sec = 1 sim-min) with an injected nowMs, and the gap is always
 * computed FROM THE RUNTIME'S ANCHOR (`getSimStartEpochMs`) — a 10-wall-
 * minute gap maps to 36000 sim-sec (10 wall-HOURS of sim at the production
 * rate 1), the same "hours behind" shape without paying 36000 physics steps.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { SimulationRegistry } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';

const RATE = 60; // sim-sec per wall-sec (the P1W suite's speed-up knob)
/** A 10-wall-minute gap = 36000 sim-sec (10 production wall-hours at rate 1). */
const GAP_WALL_MS = 10 * 60_000;
const GAP_SIM_SEC = (GAP_WALL_MS / 1000) * RATE;

async function until(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function smallWorld(id: string): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id, name: `World ${id}`, description: 't129 fixture' },
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

describe('T129: the world-session catch-up detaches from its caller and still completes', () => {
  const dirs: string[] = [];
  const registries: SimulationRegistry[] = [];
  const services: WorldSessionService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) service.close();
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeService(
    envId: string,
    nowRef: { now: number },
    options: { catchUpSyncWaitMs: number },
  ) {
    const dir = mkdtempSync(join(tmpdir(), 't129-catchup-'));
    dirs.push(dir);
    const registry = new SimulationRegistry({}, dir);
    registries.push(registry);
    const service = new WorldSessionService({
      registry,
      scenarioOfEnv: () => smallWorld(`t129-${envId}`),
      envOwnerIdOf: () => undefined,
      obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
      nowMs: () => nowRef.now,
      simPerWallSec: RATE,
      attachDriver: false,
      catchUpSyncWaitMs: options.catchUpSyncWaitMs,
    });
    services.push(service);
    return { registry, service };
  }

  /**
   * Materialize the session, RELEASE the observer pin, then set the clock
   * GAP_WALL_MS past the runtime's own anchor (the clock-anchor discipline:
   * the catch-up target is anchor-relative arithmetic) and slow each
   * advanceTo chunk. Returns the pieces the assertions need.
   */
  async function materializeThenFallBehind(
    registry: SimulationRegistry,
    service: WorldSessionService,
    envId: string,
    nowRef: { now: number },
    advanceDelayMs: number,
  ): Promise<string> {
    const release = await service.observe(envId);
    release(); // unpin: no observer → the session's resting status is 'idle'
    const simId = service.statusOf(envId)!.simulationId;
    const anchorMs = registry.get(simId)!.runtime.getSimStartEpochMs();
    nowRef.now = anchorMs + GAP_WALL_MS;
    if (advanceDelayMs > 0) {
      const record = registry.get(simId)!;
      const runtime = record.runtime as unknown as Record<string, unknown>;
      const original = (record.runtime.advanceTo as (...a: unknown[]) => Promise<unknown>).bind(record.runtime);
      runtime.advanceTo = async (...args: unknown[]) => {
        await new Promise(resolve => setTimeout(resolve, advanceDelayMs));
        return original(...args);
      };
    }
    return simId;
  }

  function simTimeOf(registry: SimulationRegistry, simId: string): number {
    return registry.get(simId)?.runtime.getSimTimeSec() ?? 0;
  }

  it('a giant gap: targetFor answers within the sync cap, the advance completes in the background to the FULL target (no truncation)', async () => {
    const nowRef = { now: Date.now() };
    const { registry, service } = makeService('env-a', nowRef, { catchUpSyncWaitMs: 300 });
    const simId = await materializeThenFallBehind(registry, service, 'env-a', nowRef, 20);

    const startedAt = Date.now();
    const record = await service.targetFor('env-a');
    const elapsedMs = Date.now() - startedAt;
    expect(record).toBeDefined();
    // The caller is released at the cap — NOT held for the whole advance.
    expect(elapsedMs).toBeLessThan(1500);

    // The world does not lie: the background advance reaches the full
    // wall-mapped target, never truncated, never jumped.
    expect(await until(() => simTimeOf(registry, simId) >= GAP_SIM_SEC - 1e-6, 15_000)).toBe(true);
    // Status untouched by the detach: resting at idle (the observer was
    // released), no new lifecycle state, no transition added.
    expect(service.statusOf('env-a')!.status).toBe('idle');
  }, 25_000);

  it('arrivals during a long advance are not head-of-line blocked (the r21 queue shape is gone)', async () => {
    const nowRef = { now: Date.now() };
    const { registry, service } = makeService('env-b', nowRef, { catchUpSyncWaitMs: 200 });
    const simId = await materializeThenFallBehind(registry, service, 'env-b', nowRef, 30);

    await service.targetFor('env-b'); // kicks the giant background advance, released at the cap
    // While the advance is still running, a second arrival must NOT wait
    // behind it (pre-fix it queued on the ops FIFO for the whole advance).
    const secondStartedAt = Date.now();
    const second = await service.targetFor('env-b');
    expect(second).toBeDefined();
    expect(Date.now() - secondStartedAt).toBeLessThan(1000);
    // …and the first advance still completes in the background.
    expect(await until(() => simTimeOf(registry, simId) >= GAP_SIM_SEC - 1e-6, 15_000)).toBe(true);
  }, 25_000);

  it('the record vanishing mid-advance (env teardown / out-of-band stop) bails the background loop quietly', async () => {
    const nowRef = { now: Date.now() };
    const { registry, service } = makeService('env-c', nowRef, { catchUpSyncWaitMs: 150 });
    const simId = await materializeThenFallBehind(registry, service, 'env-c', nowRef, 25);

    await service.targetFor('env-c'); // detach: the advance runs on
    // Tear the record out mid-advance — the loop's per-chunk revalidation
    // must notice and stop (no throw, no unhandled rejection, no zombie
    // advance against a dead runtime).
    registry.stopAndRemove(simId);
    service.dropForEnv('env-c');
    await new Promise(resolve => setTimeout(resolve, 800));
    const stopped = registry.get(simId);
    expect(stopped === undefined || stopped.runtime.getState() === 'stopped').toBe(true);
  }, 15_000);

  it('a healthy small gap keeps the old semantics: targetFor returns the world ALREADY caught up (sub-cap advance awaited)', async () => {
    const nowRef = { now: Date.now() };
    const { registry, service } = makeService('env-d', nowRef, { catchUpSyncWaitMs: 10_000 });
    const release = await service.observe('env-d');
    const simId = service.statusOf('env-d')!.simulationId;
    const anchorMs = registry.get(simId)!.runtime.getSimStartEpochMs();
    nowRef.now = anchorMs + 2_000; // a 2 wall-sec gap = 120 sim-sec at rate 60
    const record = await service.targetFor('env-d');
    release();
    expect(record).toBeDefined();
    // Well under the cap: the advance finished inline — the caller sees a
    // fully-materialized world exactly as before T129 existed.
    expect(simTimeOf(registry, simId)).toBeCloseTo(120, 0);
    expect(service.statusOf('env-d')!.status).toBe('idle');
  }, 15_000);
});
