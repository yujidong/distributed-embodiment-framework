/**
 * @vitest-environment node
 *
 * Coarse fast-forward (world-session catch-up of multi-day backlogs):
 * EngineRuntime.advanceTo(T, { coarseStrideSec, coarseSubstepSec }).
 *
 * THE EQUIVALENCE ARM'S SUBSTANCE lives here: due-moment fidelity is
 * UNCHANGED under the coarse option — every due (scenario events, occupancy
 * boundaries, flow schedule/daily anchors, effect checks) fires exactly once
 * at the SAME sim moment as the full-precision advanceTo arm (itself proven
 * == per-tick stepping by EngineRuntime.lazy-advance.vitest.test.ts, P1
 * invariant #2). Only the inter-due PHYSICS is coarser (dt ≈ coarseSubstepSec
 * instead of dt=1): cross-precision physical readings are NOT bit-exact — a
 * documented LOD tolerance of the same category as the idle tier (§8.4).
 *
 * What is pinned:
 *   (a) due fidelity over a 1-day window: identical fired-event ids AND
 *       firedAtSimTimeSec, identical flow-run sequences (flowId + sim time),
 *       identical occupancy at every day boundary, identical due-effect-check
 *       behaviour (the run sequences match end-to-end);
 *   (b) coarse == coarse when chunked (the server catch-up chunks) — the
 *       stride grid is fully determined by the due sequence, so chunking at
 *       arbitrary sim times stays bit-equal;
 *   (c) physics savings: ≥8× fewer physics substeps for this schedule;
 *   (d) temperature tolerance: the coarse arm's thermal readings stay within
 *       the documented bound of the precise arm (measured, asserted);
 *   (e) condition flows: the §8.3 10× grid applies during coarse advance —
 *       a rising edge is still caught, at most one coarse-grid slot later;
 *   (f) coarseStrideSec ≤ speed is ignored (the advance stays bit-exact).
 */

import { describe, it, expect, afterEach } from 'vitest';

import type { EngineRuntimeOptions } from './index.js';
import { EngineRuntime } from './index.js';
import { loadScenarioFile } from '../scenario/index.js';
import type { EngineSnapshot } from './contract.js';
import type { FlowDefinition, FlowRunRecord } from '../flows/index.js';

const runtimes: EngineRuntime[] = [];

function track<T extends EngineRuntime>(runtime: T): T {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.stop();
});

const DAY = 86_400;

/** Multi-day scripted schedule: daily occupancy + 4 flow streams + events across days. */
function coarseScenario(options: { withConditionFlow?: boolean } = {}) {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'coarse-advance-test', name: 'Coarse Advance Test' },
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
        baseline: { temperature: 22 },
        occupantSchedule: { count: 8, startSimTimeSec: 600, endSimTimeSec: 2400 },
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
        id: 'hvac-a',
        name: 'HVAC A',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        name: 'HVAC B',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off', 'set-temperature'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'monitor-agent',
        name: 'Monitor Agent',
        capabilities: ['temperature-monitoring', 'temperature-control'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a', 'hvac-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [
      { id: 'evt-d0-a', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 33, atSimTimeSec: 50 },
      { id: 'evt-d0-b', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 31, atSimTimeSec: 900 },
      { id: 'evt-d1', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 34, atSimTimeSec: DAY + 100 },
      { id: 'evt-d2', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 32, atSimTimeSec: 2 * DAY + 4200 },
    ],
    flows: coarseFlows(options.withConditionFlow === true),
  });
}

function coarseFlows(withCondition: boolean): FlowDefinition[] {
  const flows: FlowDefinition[] = [
    {
      id: 'flow-periodic',
      name: 'Periodic cooling',
      enabled: true,
      trigger: { kind: 'schedule', everySimSec: 600 },
      plan: { goal: 'Cool zone B', nodes: [{ id: 'cool', capability: 'cooling' }] },
    },
    {
      id: 'flow-oneshot',
      name: 'One-shot at 1800',
      enabled: true,
      trigger: { kind: 'schedule', atSimTimeSec: 1800 },
      plan: { goal: 'Cool zone B once', nodes: [{ id: 'cool', capability: 'cooling' }] },
    },
    {
      id: 'flow-tod',
      name: 'Daily at 1500',
      enabled: true,
      trigger: { kind: 'schedule', atTimeOfDaySec: 1500 },
      plan: { goal: 'Cool zone B daily', nodes: [{ id: 'cool', capability: 'cooling' }] },
    },
    {
      id: 'flow-precool',
      name: 'Precool 2min before arrival',
      enabled: true,
      // zone-b arrive = 600 → anchor 480 every day.
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { zoneId: 'zone-b', before: 'arrive', offsetSec: 120 },
      },
      plan: { goal: 'Precool zone B', nodes: [{ id: 'cool', capability: 'cooling' }] },
    },
  ];
  if (withCondition) {
    flows.push({
      id: 'flow-condition',
      name: 'Heat edge',
      enabled: true,
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 30 }],
        cooldownSimSec: 1200,
      },
      plan: { goal: 'Cool zone B on heat', nodes: [{ id: 'cool', capability: 'cooling' }] },
    });
  }
  return flows;
}

const RUN_OPTIONS = {
  faultSeed: 987654321,
  effectCheckWindowSec: 30,
  llmFailure: { retryBackoffMs: 0 },
} satisfies EngineRuntimeOptions;

/** The P0 clock-anchor discipline, same as the lazy-advance suite. */
function anchorOf(reference: EngineRuntime): ReturnType<EngineRuntime['exportWorldState']> {
  return JSON.parse(JSON.stringify(reference.exportWorldState())) as ReturnType<EngineRuntime['exportWorldState']>;
}

function freshWithAnchor(
  anchor: ReturnType<EngineRuntime['exportWorldState']>,
  scenario: ReturnType<typeof coarseScenario>,
): EngineRuntime {
  const runtime = new EngineRuntime(scenario, RUN_OPTIONS);
  runtime.restoreWorldState(anchor);
  return runtime;
}

function worldProjection(snapshot: EngineSnapshot): unknown {
  return JSON.parse(JSON.stringify({
    simTimeSec: snapshot.simTimeSec,
    zones: snapshot.zones.map(zone => ({
      id: zone.id,
      parameters: zone.parameters,
      ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
    })),
    devices: snapshot.devices.map(device => ({ id: device.id, state: device.state, fault: device.fault })),
    scheduledEvents: snapshot.scheduledEvents.map(event => ({
      id: event.id,
      fired: event.fired,
      firedAtSimTimeSec: event.firedAtSimTimeSec,
    })),
  }));
}

function flowRunProjection(runs: FlowRunRecord[]): unknown {
  return runs.map(run => ({
    flowId: run.flowId,
    triggerKind: run.triggerKind,
    status: run.status,
    simTimeSec: run.triggerEvaluation?.simTimeSec,
  }));
}

function zoneTemperature(snapshot: EngineSnapshot, zoneId: string): number {
  const zone = snapshot.zones.find(z => z.id === zoneId);
  return (zone?.parameters as Record<string, number | undefined> | undefined)?.temperature ?? Number.NaN;
}

describe('EngineRuntime coarse advance — due fidelity against the precise arm', () => {
  it('1-day window: identical fired events (id + fire time), flow runs, and occupancy', { timeout: 180_000 }, async () => {
    const precise = track(new EngineRuntime(coarseScenario(), RUN_OPTIONS));
    const anchor = anchorOf(precise);
    const preciseFlows: FlowRunRecord[] = [];
    precise.onFlowRun(record => preciseFlows.push(record));
    await precise.advanceTo(DAY);

    const coarse = track(freshWithAnchor(anchor, coarseScenario()));
    const coarseFlows: FlowRunRecord[] = [];
    coarse.onFlowRun(record => coarseFlows.push(record));
    await coarse.advanceTo(DAY, { coarseStrideSec: 3600, coarseSubstepSec: 10 });

    expect(coarse.getSimTimeSec()).toBe(DAY);

    // Due fidelity: the event record (ids + EXACT fire times) is identical.
    const firedOf = (snapshot: EngineSnapshot) =>
      snapshot.scheduledEvents.filter(e => e.fired).map(e => ({ id: e.id, at: e.firedAtSimTimeSec }));
    expect(firedOf(coarse.getSnapshot())).toEqual(firedOf(precise.getSnapshot()));
    expect(firedOf(precise.getSnapshot()).map(e => e.id)).toEqual(['evt-d0-a', 'evt-d0-b']);

    // Flow-run sequences identical (flowId, kind, status, sim time) — this
    // covers periodic/one-shot/daily-anchor/occupancy-relative triggers AND
    // the Fix-12 effect checks their actuations register (a divergence there
    // would shift later runs).
    expect(flowRunProjection(coarseFlows)).toEqual(flowRunProjection(preciseFlows));
    expect(preciseFlows.length).toBeGreaterThan(100); // the schedule really ran

    // Occupancy at the day boundary identical (arrive fired at 600, depart at 2400).
    const occOf = (snapshot: EngineSnapshot) => snapshot.zones.find(z => z.id === 'zone-b')?.occupancy;
    expect(occOf(coarse.getSnapshot())).toBe(occOf(precise.getSnapshot()));

    // Device states identical except INTEGRATED quantities — cumulative
    // energy is power×dt accumulated, the same LOD-tolerance category as the
    // thermal readings (not bit-exact across precision tiers, §8.4).
    const discreteState = (snapshot: EngineSnapshot) =>
      snapshot.devices.map(d => {
        const { cumulativeEnergyWh: _drop, ...rest } = d.state as Record<string, unknown>;
        return { id: d.id, state: rest };
      });
    expect(discreteState(coarse.getSnapshot())).toEqual(discreteState(precise.getSnapshot()));
    const energyOf = (snapshot: EngineSnapshot, id: string) =>
      (snapshot.devices.find(d => d.id === id)?.state as Record<string, number>).cumulativeEnergyWh;
    const energyDelta = Math.abs(
      energyOf(coarse.getSnapshot(), 'hvac-a') - energyOf(precise.getSnapshot(), 'hvac-a'),
    );
    // Measured on this fixture: ~0.3% after a day of cooling cycles.
    expect(energyDelta / energyOf(precise.getSnapshot(), 'hvac-a')).toBeLessThan(0.01);

    // (c) physics savings: precise integrates dt=1 → ~DAY substeps; coarse
    // integrates dt≈10 → ~DAY/10.
    const preciseSteps = precise.getPhysicsStepCount();
    const coarseSteps = coarse.getPhysicsStepCount();
    expect(coarseSteps).toBeLessThanOrEqual(Math.ceil(preciseSteps / 8));
    expect(coarseSteps).toBeGreaterThan(1000); // it really integrated the day

    // (d) thermal tolerance: NOT bit-exact — within the documented bound.
    const deltaTemp = Math.abs(
      zoneTemperature(coarse.getSnapshot(), 'zone-a') - zoneTemperature(precise.getSnapshot(), 'zone-a'),
    );
    // Measured on this fixture: ≪0.5 °C after a day with two heat spikes.
    expect(deltaTemp).toBeLessThan(0.5);
  });

  it('chunked coarse == one-shot coarse (the server catch-up chunks at arbitrary sim times)', { timeout: 180_000 }, async () => {
    const oneShot = track(new EngineRuntime(coarseScenario(), RUN_OPTIONS));
    const anchor = anchorOf(oneShot);
    await oneShot.advanceTo(2 * DAY, { coarseStrideSec: 3600, coarseSubstepSec: 10 });

    const chunked = track(freshWithAnchor(anchor, coarseScenario()));
    // The world-session chunk cap (3600) is NOT aligned to the due grid.
    for (let t = 3600; t <= 2 * DAY; t += 3600) {
      await chunked.advanceTo(t, { coarseStrideSec: 3600, coarseSubstepSec: 10 });
    }

    expect(worldProjection(chunked.getSnapshot())).toEqual(worldProjection(oneShot.getSnapshot()));
  });

  it('coarse advanceTo == per-tick stepping on due firing (the gold standard), shorter window', { timeout: 180_000 }, async () => {
    const T = 6 * 3600; // 6 hours — step() is the slow gold standard.
    const tickRun = track(new EngineRuntime(coarseScenario(), RUN_OPTIONS));
    const anchor = anchorOf(tickRun);
    const tickFlows: FlowRunRecord[] = [];
    tickRun.onFlowRun(record => tickFlows.push(record));
    await tickRun.step(T);

    const coarse = track(freshWithAnchor(anchor, coarseScenario()));
    const coarseFlows: FlowRunRecord[] = [];
    coarse.onFlowRun(record => coarseFlows.push(record));
    await coarse.advanceTo(T, { coarseStrideSec: 1800, coarseSubstepSec: 10 });

    const firedOf = (snapshot: EngineSnapshot) =>
      snapshot.scheduledEvents.filter(e => e.fired).map(e => ({ id: e.id, at: e.firedAtSimTimeSec }));
    expect(firedOf(coarse.getSnapshot())).toEqual(firedOf(tickRun.getSnapshot()));
    expect(flowRunProjection(coarseFlows)).toEqual(flowRunProjection(tickFlows));
    const occOf = (snapshot: EngineSnapshot) => snapshot.zones.find(z => z.id === 'zone-b')?.occupancy;
    expect(occOf(coarse.getSnapshot())).toBe(occOf(tickRun.getSnapshot()));
  });

  it('condition flows: the §8.3 10× grid catches the edge at most one grid slot late', { timeout: 180_000 }, async () => {
    const T = 3600;
    const precise = track(new EngineRuntime(coarseScenario({ withConditionFlow: true }), RUN_OPTIONS));
    const anchor = anchorOf(precise);
    const preciseFlows: FlowRunRecord[] = [];
    precise.onFlowRun(record => preciseFlows.push(record));
    await precise.advanceTo(T);

    const coarse = track(freshWithAnchor(anchor, coarseScenario({ withConditionFlow: true })));
    const coarseFlows: FlowRunRecord[] = [];
    coarse.onFlowRun(record => coarseFlows.push(record));
    await coarse.advanceTo(T, { coarseStrideSec: 1800, coarseSubstepSec: 10 });

    const firstConditionRun = (runs: FlowRunRecord[]) =>
      runs.find(run => run.flowId === 'flow-condition')?.triggerEvaluation?.simTimeSec;
    const pAt = firstConditionRun(preciseFlows);
    const cAt = firstConditionRun(coarseFlows);
    // Both arms catch the heat edge (evt-d0-a spikes zone-a to 33 at t=50).
    expect(pAt).toBeDefined();
    expect(cAt).toBeDefined();
    // The coarse grid is 10× the tick grid: detection lands at most one
    // coarse-grid slot after the precise arm (never earlier, never skipped).
    expect(cAt!).toBeGreaterThanOrEqual(pAt!);
    expect(cAt! - pAt!).toBeLessThanOrEqual(10);
  });

  it('coarseStrideSec ≤ speed is ignored — the advance stays bit-exact', { timeout: 60_000 }, async () => {
    const T = 3600;
    const plain = track(new EngineRuntime(coarseScenario(), RUN_OPTIONS));
    const anchor = anchorOf(plain);
    await plain.advanceTo(T);

    const ignored = track(freshWithAnchor(anchor, coarseScenario()));
    await ignored.advanceTo(T, { coarseStrideSec: 1 }); // speed is 1 → no coarse path

    expect(worldProjection(ignored.getSnapshot())).toEqual(worldProjection(plain.getSnapshot()));
    expect(ignored.getSnapshot().tickCount).toBe(T); // the P0 anchor holds
  });

  it('a 3-day backlog fast-forwards with full due fidelity and ≫8× fewer physics steps', { timeout: 300_000 }, async () => {
    const T = 3 * DAY;
    const coarse = track(new EngineRuntime(coarseScenario(), RUN_OPTIONS));
    const flows: FlowRunRecord[] = [];
    coarse.onFlowRun(record => flows.push(record));
    const startedMs = Date.now();
    await coarse.advanceTo(T, { coarseStrideSec: 3600, coarseSubstepSec: 10 });
    const wallMs = Date.now() - startedMs;

    expect(coarse.getSimTimeSec()).toBe(T);
    // Every scripted event fired exactly once, at its declared sim time.
    const declaredAt: Record<string, number> = {
      'evt-d0-a': 50,
      'evt-d0-b': 900,
      'evt-d1': DAY + 100,
      'evt-d2': 2 * DAY + 4200,
    };
    const fired = coarse.getSnapshot().scheduledEvents.filter(e => e.fired);
    expect(fired.map(e => e.id)).toEqual(['evt-d0-a', 'evt-d0-b', 'evt-d1', 'evt-d2']);
    for (const event of fired) {
      expect(event.firedAtSimTimeSec).toBe(declaredAt[event.id]);
    }
    // 3 days × (144 periodic + 1 daily + 1 precool + effect checks) flow runs.
    expect(flows.length).toBeGreaterThan(3 * 140);
    // Occupancy schedule ran all 3 days (depart at 2400 daily → 0 at end).
    expect(coarse.getSnapshot().zones.find(z => z.id === 'zone-b')?.occupancy).toBe(0);
    // Physics substeps ≈ T/10, not T.
    expect(coarse.getPhysicsStepCount()).toBeLessThanOrEqual(Math.ceil(T / 8));
    // Report line for the capacity notes (not a CI gate).
    console.log(
      `[coarse-advance bench] 3-day backlog: ${T} sim-sec in ${wallMs}ms ` +
        `(${Math.round((T / Math.max(wallMs, 1)) * 1000)} sim-sec/s, ${coarse.getPhysicsStepCount()} physics substeps)`,
    );
  });
});
