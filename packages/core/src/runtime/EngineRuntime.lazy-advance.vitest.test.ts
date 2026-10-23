/**
 * @vitest-environment node
 *
 * Living-worlds P1 (design-living-worlds.md §8): lazy advance —
 * EngineRuntime.advanceTo + due moments.
 *
 * P1 ACCEPTANCE INVARIANT #2 lives here (the P0 hibernate invariant
 * generalized): with the same seeded scripted schedule, rule-only mode,
 *
 *   (a) a continuous tick-driven run to T (step(T)) produces S_tick;
 *   (b) a lazy advanceTo(T) run produces S_lazy;
 *   (c) S_lazy == S_tick — world state bit-equal (projection) AND the
 *       fired-event / flow-run sequences equal AND tickCount == T (the P0
 *       anchor: tickCount == simTimeSec at speed 1 regardless of who drove
 *       the ticks);
 *   (d) efficiency: the lazy run executes dramatically fewer tick bodies
 *       than T (≥10× fewer for this sparse schedule) — physics substeps are
 *       NOT reduced (dt=1 keeps bit-equality); the saving is the per-tick
 *       scheduling/evaluation body.
 *
 * The condition-flow arm pins the §8.3 red line: with enabled
 * condition-trigger flows the due cadence IS the tick grid, so a big jump
 * can never skip a rising edge a tick run would have caught.
 *
 * Fixture discipline (lessons.md + P0): every zone pins
 * `baseline.temperature`, AND the two comparison arms share one CLOCK ANCHOR
 * (anchorOf/freshWithAnchor) — time-dependent default value models (the
 * light/humidity diurnals, the seasonal outdoor curve) read through
 * simStartEpochMs + simTimeSec, so separately constructed runtimes otherwise
 * drift in the low-order digits. The anchor pin is exactly the P0
 * checkpoint's restore rule, applied at t=0.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';
import type { EngineSnapshot } from './contract.js';
import type { FlowDefinition, FlowRunRecord } from '../flows/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function track<T extends EngineRuntime>(runtime: T): T {
  runtimes.push(runtime);
  return runtime;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-lazy-advance-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const T = 3600; // 1 simulated hour

/** Sparse scripted schedule: 5 events + occupancy window + 2 flows + 1 effect check. */
function lazyScenario(options: { withConditionFlow?: boolean; llmForced?: boolean } = {}) {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'lazy-advance-test', name: 'Lazy Advance Test' },
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
      { id: 'evt-a', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 33, atSimTimeSec: 50 },
      { id: 'evt-b', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 31, atSimTimeSec: 300 },
      { id: 'evt-c', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 34, atSimTimeSec: 900 },
      { id: 'evt-d', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 32, atSimTimeSec: 2000 },
      {
        id: 'evt-e', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature',
        value: 34, atSimTimeSec: 3500,
        ...(options.llmForced === true
          ? { requiredCapabilities: ['smoke-detection', 'fire-suppression'], severity: 'high' as const }
          : {}),
      },
    ],
    flows: lazyFlows(options.withConditionFlow === true),
  });
}

function lazyFlows(withCondition: boolean): FlowDefinition[] {
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
        cooldownSimSec: 120,
      },
      plan: { goal: 'Cool zone B on heat', nodes: [{ id: 'cool', capability: 'cooling' }] },
    });
  }
  return flows;
}

const RUN_OPTIONS = {
  faultSeed: 987654321,
  effectCheckWindowSec: 30,
  llmFailure: { retryBackoffMs: 0 }, // DX 快赢：消除 assessor 墙钟退避 flake
} satisfies EngineRuntimeOptions;

/**
 * A fresh runtime sharing the reference runtime's CLOCK ANCHOR — the P0
 * checkpoint discipline, applied to the two comparison arms: time-dependent
 * value models (light/humidity diurnals, the seasonal outdoor curve) are
 * pure functions of simStartEpochMs + simTimeSec, so two SEPARATELY
 * constructed runtimes drift in the low-order digits even before anything
 * happens. Adopting a t=0 world export pins the anchor (and nothing else
 * — a t=0 export of a freshly built runtime is its own construction state).
 * Capture the anchor BEFORE anything drives the reference runtime.
 */
function anchorOf(reference: EngineRuntime): ReturnType<EngineRuntime['exportWorldState']> {
  return JSON.parse(JSON.stringify(reference.exportWorldState())) as ReturnType<EngineRuntime['exportWorldState']>;
}

function freshWithAnchor(
  anchor: ReturnType<EngineRuntime['exportWorldState']>,
  scenario: ReturnType<typeof lazyScenario>,
  options: EngineRuntimeOptions,
): EngineRuntime {
  const runtime = new EngineRuntime(scenario, options);
  runtime.restoreWorldState(anchor);
  return runtime;
}

/** Comparable world projection of a snapshot (the invariant compares this). */
function worldProjection(snapshot: EngineSnapshot): unknown {
  return JSON.parse(JSON.stringify({
    simTimeSec: snapshot.simTimeSec,
    speed: snapshot.speed,
    tickCount: snapshot.tickCount,
    zones: snapshot.zones.map(zone => ({
      id: zone.id,
      parameters: zone.parameters,
      ...(zone.occupancy !== undefined ? { occupancy: zone.occupancy } : {}),
    })),
    devices: snapshot.devices.map(device => ({
      id: device.id,
      state: device.state,
      fault: device.fault,
    })),
    scheduledEvents: snapshot.scheduledEvents.map(event => ({ id: event.id, fired: event.fired })),
  }));
}

/** Comparable flow-run sequence (run ids and wall timestamps are not deterministic by design). */
function flowRunProjection(runs: FlowRunRecord[]): unknown {
  return runs.map(run => ({
    flowId: run.flowId,
    triggerKind: run.triggerKind,
    status: run.status,
    simTimeSec: run.triggerEvaluation?.simTimeSec,
  }));
}

/** Both arms start identically: fresh runtime + a cooling command (registers a Fix-12 check at t=35). */
async function prime(runtime: EngineRuntime): Promise<void> {
  await runtime.executeDeviceCommand('hvac-b', 'turn-on');
  await runtime.executeDeviceCommand('hvac-b', 'set-temperature', { targetTemperature: 18 });
}

// ---------------------------------------------------------------------------
// Due moments on a live runtime
// ---------------------------------------------------------------------------

describe('EngineRuntime lazy advance — due moments', () => {
  it('peekNextDueMoment walks the scripted schedule from the runtime state', async () => {
    const runtime = track(new EngineRuntime(lazyScenario(), RUN_OPTIONS));
    await prime(runtime);
    // First due: the Fix-12 effect check registered at t=0 (window 30).
    expect(runtime.peekNextDueMoment()!.atSimSec).toBe(30);
    // With a horizon below it: nothing due.
    expect(runtime.peekNextDueMoment(10)).toBeNull();
    // All moments within the hour (unfired events + occupancy + flow
    // schedules; 3600 is the periodic flow's last crossing, inclusive).
    const ats = runtime.peekDueMoments(runtime.getSimTimeSec(), T).map(m => m.atSimSec);
    expect(ats).toEqual([30, 50, 300, 600, 900, 1200, 1800, 2000, 2400, 3000, 3500, 3600]);
    // After stepping past the first events, they drop out of the set.
    await runtime.step(60);
    expect(runtime.peekDueMoments(runtime.getSimTimeSec(), T).map(m => m.atSimSec)[0]).toBe(300);
  });

  it('condition flows pin the due cadence to the tick grid (no laziness, no missed edges)', () => {
    const runtime = track(new EngineRuntime(lazyScenario({ withConditionFlow: true }), RUN_OPTIONS));
    expect(runtime.peekNextDueMoment()!.atSimSec).toBe(1); // every tick is a due moment
    expect(runtime.peekNextDueMoment(0.5)).toBeNull(); // strictly after the current time
  });

  it('FEAT-01: daily anchors are due moments — lazy advanceTo wakes and fires them', { timeout: 60_000 }, async () => {
    // Two lazy advanceTo sweeps are compute-heavy; under full-suite parallel
    // load the default 5 s timeout is too tight (observed red only then).
    const scenario = lazyScenario();
    scenario.flows = [
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
        // zone-b arrive = 600 → anchor 480.
        trigger: {
          kind: 'schedule',
          relativeToOccupancy: { zoneId: 'zone-b', before: 'arrive', offsetSec: 120 },
        },
        plan: { goal: 'Precool zone B', nodes: [{ id: 'cool', capability: 'cooling' }] },
      },
    ];
    const runtime = track(new EngineRuntime(scenario, RUN_OPTIONS));
    const runs: FlowRunRecord[] = [];
    runtime.onFlowRun(record => runs.push(record));

    // Both anchors are offered as due moments (480 = 600-120, 1500).
    const ats = runtime.peekDueMoments(runtime.getSimTimeSec(), T).map(m => m.atSimSec);
    expect(ats).toContain(480);
    expect(ats).toContain(1500);

    // A lazy advance across both anchors fires both flows — no per-tick run.
    await runtime.advanceTo(T);
    expect(runs.map(run => run.flowId).sort()).toEqual(['flow-precool', 'flow-tod']);

    // Day-1 anchors fire again on the next lazy advance.
    await runtime.advanceTo(T + 86400);
    const day1 = runs.filter(run => (run.triggerEvaluation?.simTimeSec ?? 0) > 86400);
    expect(day1.map(run => run.flowId).sort()).toEqual(['flow-precool', 'flow-tod']);
  });
});

// ---------------------------------------------------------------------------
// advanceTo mechanics
// ---------------------------------------------------------------------------

describe('EngineRuntime lazy advance — mechanics', () => {
  it('lands exactly on the target and keeps the tickCount anchor', async () => {
    const runtime = track(new EngineRuntime(lazyScenario(), RUN_OPTIONS));
    await runtime.advanceTo(T);
    expect(runtime.getSimTimeSec()).toBe(T);
    expect(runtime.getSnapshot().tickCount).toBe(T); // P0 anchor: tickCount == simTimeSec at speed 1
    expect(runtime.getState()).toBe('created'); // advanceTo does not flip lifecycle state (like step)
  });

  it('rejects non-forward targets with teaching errors', async () => {
    const runtime = track(new EngineRuntime(lazyScenario(), RUN_OPTIONS));
    await runtime.advanceTo(10);
    await expect(runtime.advanceTo(10)).rejects.toThrow(/must be greater than the current simTimeSec/);
    await expect(runtime.advanceTo(Number.NaN)).rejects.toThrow(/must be a finite number/);
  });

  it('chunked advanceTo equals one-shot advanceTo (the server lazy driver chunks)', { timeout: 60_000 }, async () => {
    const oneShot = track(new EngineRuntime(lazyScenario(), RUN_OPTIONS));
    const anchor = anchorOf(oneShot);
    await prime(oneShot);
    await oneShot.advanceTo(T);

    const chunked = track(freshWithAnchor(anchor, lazyScenario(), RUN_OPTIONS));
    await prime(chunked);
    for (let t = 600; t <= T; t += 600) {
      await chunked.advanceTo(t);
    }

    expect(worldProjection(chunked.getSnapshot())).toEqual(worldProjection(oneShot.getSnapshot()));
  });

  it('start({lazy}) runs without the wall-clock timer; pause/resume keep the mode', async () => {
    const runtime = track(new EngineRuntime(lazyScenario(), { ...RUN_OPTIONS, tickMs: 500 }));
    runtime.start(1, { lazy: true });
    expect(runtime.getState()).toBe('running');
    expect(runtime.isLazyAdvance()).toBe(true);
    // No wall ticks: the world only moves when advanceTo drives it. Give any
    // stray timer ample time to (wrongly) fire — 1.5× the tick interval.
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(runtime.getSimTimeSec()).toBe(0);

    runtime.pause();
    expect(runtime.getState()).toBe('paused');
    runtime.resume();
    expect(runtime.getState()).toBe('running');
    expect(runtime.isLazyAdvance()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(runtime.getSimTimeSec()).toBe(0); // still due-driven — resume kept the mode
  });
});

// ---------------------------------------------------------------------------
// P1 ACCEPTANCE INVARIANT #2 (rule-only)
// ---------------------------------------------------------------------------

describe('EngineRuntime lazy advance — P1 acceptance invariant #2 (rule-only)', () => {
  it('advanceTo(T) == per-tick stepping to T, with dramatically fewer tick bodies', { timeout: 60_000 }, async () => {
    // (a) continuous tick-driven run.
    const tickRun = track(new EngineRuntime(lazyScenario(), RUN_OPTIONS));
    const anchor = anchorOf(tickRun); // t=0 clock anchor, captured pre-run
    const tickFlows: FlowRunRecord[] = [];
    tickRun.onFlowRun(record => tickFlows.push(record));
    await prime(tickRun);
    await tickRun.step(T);
    expect(tickRun.getSimTimeSec()).toBe(T);

    // (b) lazy due-driven run — same seed, same schedule, fresh runtime
    // sharing the tick run's clock anchor (see anchorOf/freshWithAnchor).
    const lazyRun = track(freshWithAnchor(anchor, lazyScenario(), RUN_OPTIONS));
    const lazyFlowsRuns: FlowRunRecord[] = [];
    lazyRun.onFlowRun(record => lazyFlowsRuns.push(record));
    await prime(lazyRun);
    await lazyRun.advanceTo(T);
    expect(lazyRun.getSimTimeSec()).toBe(T);

    // (c) equality: world projection, fired events, flow-run sequence.
    expect(worldProjection(lazyRun.getSnapshot())).toEqual(worldProjection(tickRun.getSnapshot()));
    expect(flowRunProjection(lazyFlowsRuns)).toEqual(flowRunProjection(tickFlows));
    // The scripted schedule fired the same events in the same order.
    expect(tickRun.getSnapshot().scheduledEvents.filter(e => e.fired).map(e => e.id))
      .toEqual(['evt-a', 'evt-b', 'evt-c', 'evt-d', 'evt-e']);
    expect(lazyRun.getSnapshot().scheduledEvents.filter(e => e.fired).map(e => e.id))
      .toEqual(tickRun.getSnapshot().scheduledEvents.filter(e => e.fired).map(e => e.id));

    // (d) efficiency: the tick run executes T bodies; the lazy run only its
    // due moments (+ the target landing) — flow actuations register further
    // Fix-12 checks, so the exact count is data-dependent; the bound is the
    // contract: ≥10× fewer for this sparse schedule.
    expect(tickRun.getTickBodyCount()).toBe(T);
    expect(lazyRun.getTickBodyCount()).toBeLessThanOrEqual(Math.floor(T / 10));
    expect(lazyRun.getTickBodyCount()).toBeGreaterThanOrEqual(10); // it really advanced through dues
  });

  it('condition-trigger flows: advanceTo == per-tick (the §8.3 red line — no missed edges)', { timeout: 60_000 }, async () => {
    const tickRun = track(new EngineRuntime(lazyScenario({ withConditionFlow: true }), RUN_OPTIONS));
    const anchor = anchorOf(tickRun);
    const tickFlows: FlowRunRecord[] = [];
    tickRun.onFlowRun(record => tickFlows.push(record));
    await tickRun.step(T);

    const lazyRun = track(freshWithAnchor(anchor, lazyScenario({ withConditionFlow: true }), RUN_OPTIONS));
    const lazyFlowsRuns: FlowRunRecord[] = [];
    lazyRun.onFlowRun(record => lazyFlowsRuns.push(record));
    await lazyRun.advanceTo(T);

    expect(worldProjection(lazyRun.getSnapshot())).toEqual(worldProjection(tickRun.getSnapshot()));
    expect(flowRunProjection(lazyFlowsRuns)).toEqual(flowRunProjection(tickFlows));
    // The condition edge actually fired in both (the spikes cross 30°C).
    expect(tickFlows.filter(r => r.flowId === 'flow-condition').length).toBeGreaterThan(0);
    // No laziness with condition flows: every tick was a due moment.
    expect(lazyRun.getTickBodyCount()).toBe(T);
  });
});

// ---------------------------------------------------------------------------
// LLM arm: decisions replay from records (record-replay, like P0)
// ---------------------------------------------------------------------------

type LoggingCallback = (params: Record<string, unknown>) => void;
type ContextProvider = () => Record<string, unknown> | undefined;

class ScriptedLLMClient {
  static readonly MODEL = 'scripted-model';
  static readonly CANNED = JSON.stringify({ decision: 'collaborate', reasoning: 'scripted' });
  calls = 0;
  private loggingCallback: LoggingCallback | null = null;
  private contextProvider: ContextProvider | null = null;

  setLoggingCallback(callback: LoggingCallback | null): void { this.loggingCallback = callback; }
  setContextProvider(provider: ContextProvider | null): void { this.contextProvider = provider; }
  getProviderName(): string { return 'scripted'; }
  getModel(): string { return ScriptedLLMClient.MODEL; }
  async healthCheck(): Promise<boolean> { return true; }
  async quickChat(content: string): Promise<{ content: string; model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    this.calls += 1;
    const response = ScriptedLLMClient.CANNED;
    this.loggingCallback?.({
      userPrompt: content,
      response,
      durationMs: 1,
      model: ScriptedLLMClient.MODEL,
      success: true,
      context: this.contextProvider?.(),
    });
    return {
      content: response,
      model: ScriptedLLMClient.MODEL,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    const userPrompt = params.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    return this.quickChat(userPrompt);
  }
}

class RecordReplayLLMClient {
  static readonly MODEL = 'record-replay';
  private readonly responses = new Map<string, string>();
  served = 0;
  misses: string[] = [];

  constructor(records: Array<{ prompt?: { userPrompt?: string }; rawResponse?: string }>) {
    for (const record of records) {
      const prompt = record.prompt?.userPrompt;
      if (typeof prompt === 'string' && typeof record.rawResponse === 'string') {
        if (!this.responses.has(prompt)) this.responses.set(prompt, record.rawResponse);
      }
    }
  }

  setLoggingCallback(): void { /* not needed here */ }
  setContextProvider(): void { /* not needed here */ }
  getProviderName(): string { return 'record-replay'; }
  getModel(): string { return RecordReplayLLMClient.MODEL; }
  async healthCheck(): Promise<boolean> { return true; }
  async quickChat(userPrompt: string): Promise<{ content: string; model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const recorded = this.responses.get(userPrompt);
    if (recorded === undefined) {

      this.misses.push(userPrompt.slice(0, 80));
      throw new Error(`RecordReplayLLMClient: no recorded response for prompt (never re-invoke a model during replay): "${userPrompt.slice(0, 120)}…"`);
    }
    this.served += 1;
    return {
      content: recorded,
      model: RecordReplayLLMClient.MODEL,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    const userPrompt = params.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    return this.quickChat(userPrompt);
  }
}

describe('EngineRuntime lazy advance — LLM arm (record-replay, never re-invoke)', () => {
  it('advanceTo(T) answers LLM-needing moments from the tick run\'s records and matches it', { timeout: 60_000 }, async () => {
    const dir = makeTempDir();
    const scripted = new ScriptedLLMClient();

    // Tick-driven reference with the scripted "model".
    const tickRun = track(new EngineRuntime(lazyScenario({ llmForced: true }), {
      ...RUN_OPTIONS,
      trajectoryDir: dir,
      llmClient: scripted as unknown as LLMClient,
      autoInitiateAC: false, // decision-level: no AC execution handshakes
    }));
    const anchor = anchorOf(tickRun);
    await tickRun.step(T);
    expect(scripted.calls).toBeGreaterThanOrEqual(1); // the LLM path ran
    const reference = worldProjection(tickRun.getSnapshot());

    // Lazy run: decisions served ONLY from the tick run's recorded pairs.
    const records = readJsonl(tickRun.getTrajectoryFilePath()!);
    const replay = new RecordReplayLLMClient(records);
    expect(replay['responses'].size).toBeGreaterThanOrEqual(1);

    const lazyRun = track(freshWithAnchor(anchor, lazyScenario({ llmForced: true }), {
      ...RUN_OPTIONS,
      trajectoryDir: dir,
      trajectoryAppend: true,
      llmClient: replay as unknown as LLMClient,
      autoInitiateAC: false,
    }));
    await lazyRun.advanceTo(T);

    expect(replay.served).toBeGreaterThanOrEqual(1); // answered from records
    expect(replay.misses).toEqual([]); // and ONLY from records
    expect(worldProjection(lazyRun.getSnapshot())).toEqual(reference);
  });
});

// ---------------------------------------------------------------------------

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}
