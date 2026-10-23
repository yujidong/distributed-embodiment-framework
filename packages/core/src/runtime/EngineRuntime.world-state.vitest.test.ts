/**
 * @vitest-environment node
 *
 * Living-worlds P0 (design-living-worlds.md §9): world-state export/restore —
 * the checkpoint seam behind hibernate/resume.
 *
 * The P0 acceptance invariant lives here in its engine-level form:
 *
 *   run T sim-seconds → export at T → fresh runtime restores → run T2 more
 *   == continuous run of T+T2 (same schedule, same seeded world)
 *
 * The rule-only arm runs the full deterministic path; the mock-LLM arm pins
 * the design's explicit rule — LLM decisions replay from trajectory records,
 * the resumed run's client NEVER invokes a model (RecordReplayClient serves
 * the continuous run's recorded responses, matched by prompt).
 *
 * Fixture discipline (lessons.md): every zone pins `baseline.temperature` —
 * unbounded/unpinned zones ride the seasonal DailyCycleModel, which is a
 * function of the construction wall time and would make separately
 * constructed worlds incomparable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';
import { ENGINE_WORLD_STATE_VERSION, type EngineSnapshot, type EngineWorldStateExport } from './contract.js';
import { planWorldStateRestore } from './shaping/index.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'engine-world-state-'));
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

/**
 * Two bounded zones with pinned baselines (a custom static quantity
 * `powerW` rides zone-b's baseline to cover the custom-parameter path), an
 * HVAC in zone-b, a sensor in zone-a, one managing agent bound to both.
 * Scheduled events: `pre-boundary` fires at t=10 (before the checkpoint),
 * `post-boundary` at t=50 (after — proves the scheduler set survives and
 * fires exactly once in the resumed run).
 */
function boundedScenario(options: { llmForced?: boolean } = {}) {
  const llmForcing = options.llmForced === true
    ? { requiredCapabilities: ['smoke-detection', 'fire-suppression'], severity: 'high' as const }
    : {};
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'world-state-test', name: 'World State Test' },
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
        baseline: { temperature: 24, powerW: 1500 },
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
        id: 'hvac-b',
        name: 'HVAC B',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'world-agent',
        name: 'World Agent',
        capabilities: ['temperature-monitoring', 'temperature-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['temp-sensor-a', 'hvac-b'],
      },
    ],
    events: [
      {
        id: 'evt-pre-boundary',
        type: 'temperature-spike',
        zoneId: 'zone-a',
        parameter: 'temperature',
        value: 33,
        atSimTimeSec: 10,
      },
      {
        id: 'evt-post-boundary',
        type: 'temperature-spike',
        zoneId: 'zone-b',
        parameter: 'temperature',
        value: 34,
        atSimTimeSec: 50,
        ...llmForcing,
      },
    ],
  });
}

const RUN_OPTIONS = {
  faultSeed: 123456789,
  effectCheckWindowSec: 30,
  llmFailure: { retryBackoffMs: 0 }, // DX 快赢：消除 assessor 墙钟退避 flake
} satisfies EngineRuntimeOptions;

/** Comparable world projection of a snapshot (the P0 invariant compares this). */
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
    scheduledEvents: snapshot.scheduledEvents.map(event => ({
      id: event.id,
      fired: event.fired,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Rule-only arm: export/restore + the acceptance invariant
// ---------------------------------------------------------------------------

describe('EngineRuntime world-state export/restore (rule-only)', () => {
  it('exports a JSON-serializable, versioned world state', async () => {
    const runtime = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    await runtime.step(10); // t=10: pre-boundary event fired
    runtime.setZoneOccupancy('zone-a', 6);
    runtime.setDeviceFault('hvac-b', { failureRate: 0.5 });

    const world = runtime.exportWorldState();

    expect(world.formatVersion).toBe(ENGINE_WORLD_STATE_VERSION);
    expect(world.simTimeSec).toBe(10);
    expect(world.rng).toEqual({ seed: 123456789, draws: 0 });
    expect(world.zones['zone-a'].occupancy).toBe(6);
    expect(world.zones['zone-a'].field?.temperature?.value).toBe(33);
    expect(world.zones['zone-a'].field?.temperature?.baseline).toBe(22);
    expect(world.zones['zone-b'].custom?.powerW).toBe(1500);
    expect(world.devices['hvac-b'].fault).toEqual({ failureRate: 0.5 });
    expect(world.scheduler.firedEventIds).toContain('evt-pre-boundary');
    expect(world.scheduler.firedEventIds).not.toContain('evt-post-boundary');

    // Pure data: survives a JSON round-trip unchanged.
    expect(JSON.parse(JSON.stringify(world))).toEqual(world);
  });

  it('restores onto a fresh runtime and reproduces the world bit-for-bit', async () => {
    const continuous = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    await continuous.step(10);
    await continuous.injectEvent({ type: 'humidity-spike', zoneId: 'zone-b', parameter: 'humidity', value: 80 });
    continuous.setZoneOccupancy('zone-b', 12);
    const world = continuous.exportWorldState();
    continuous.pause();

    const resumed = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    resumed.restoreWorldState(JSON.parse(JSON.stringify(world)) as EngineWorldStateExport);

    // The restored runtime's world equals the exported moment — before any
    // further stepping: zones, occupancy, device states, scheduler flags.
    expect(worldProjection(resumed.getSnapshot())).toEqual(worldProjection(continuous.getSnapshot()));
  });

  it('P0 acceptance invariant (rule-only): hibernate+resume == continuous run', async () => {
    // Continuous reference: T+T2 = 40 + 20 sim-seconds (pure step() driving —
    // no auto-run timer, so the two runs advance through identical tick
    // sequences; mixing start() with step() would let wall-clock ticks
    // interleave and the comparison would measure timer jitter, not restore
    // fidelity).
    const continuous = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    await continuous.step(40); // T = 40 sim-sec: pre-boundary event (t=10) fired
    expect(continuous.getSimTimeSec()).toBe(40);

    const world = continuous.exportWorldState();
    // T2 = 20 more sim-sec: crosses the post-boundary event at t=50.
    await continuous.step(20);
    expect(continuous.getSimTimeSec()).toBe(60);

    // Hibernated branch: fresh runtime adopts the checkpoint at T=40, then
    // runs the same T2.
    const resumed = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    resumed.restoreWorldState(world);
    await resumed.step(20);
    expect(resumed.getSimTimeSec()).toBe(60);

    const a = worldProjection(continuous.getSnapshot());
    const b = worldProjection(resumed.getSnapshot());
    expect(b).toEqual(a);

    // The post-boundary scheduled event fired exactly once on each side
    // (scheduler state survived: pre-boundary not re-fired, post-boundary
    // fired in both).
    const firedA = continuous.getSnapshot().scheduledEvents.filter(e => e.fired).map(e => e.id);
    const firedB = resumed.getSnapshot().scheduledEvents.filter(e => e.fired).map(e => e.id);
    expect(firedA).toEqual(['evt-pre-boundary', 'evt-post-boundary']);
    expect(firedB).toEqual(firedA);
  });

  it('carries pending effect checks, agent toggles and reputation across the boundary', async () => {
    const scenario = boundedScenario();
    const continuous = track(new EngineRuntime(scenario, RUN_OPTIONS));
    await continuous.step(10);
    // A cooling command registers a pending Fix-12 effect check (due in 30s).
    await continuous.executeDeviceCommand('hvac-b', 'turn-on');
    await continuous.executeDeviceCommand('hvac-b', 'set-temperature', { targetTemperature: 18 });
    continuous.setAgentEnabled('world-agent', false);
    continuous.setReputation('world-agent', 'cooling', { attempts: 3, successes: 1, lastAt: 12345 });

    const world = continuous.exportWorldState();
    const setTempCheck = world.pendingEffectChecks.find(c => c.commandName === 'set-temperature');
    expect(setTempCheck).toBeDefined();
    expect(setTempCheck!.dueSimSec).toBe(10 + 30); // registered at t=10, window 30s
    expect(world.agents['world-agent'].enabled).toBe(false);
    expect(world.reputation?.records.some(r => r.capability === 'cooling')).toBe(true);

    const resumed = track(new EngineRuntime(scenario, RUN_OPTIONS));
    resumed.restoreWorldState(world);
    const snapshot = resumed.getSnapshot();
    // Pending effect checks survive verbatim (due moments, not timers).
    expect(resumed.exportWorldState().pendingEffectChecks).toEqual(world.pendingEffectChecks);
    // Agent toggle survives.
    expect(snapshot.agents.find(a => a.id === 'world-agent')?.capabilities).toBeDefined();
    expect(resumed.isAgentEnabled('world-agent')).toBe(false);
    // Reputation survives.
    expect(resumed.getReputation('world-agent', 'cooling')).toMatchObject({ attempts: 3, successes: 1 });
    // Device state survives (power on + commanded setpoint).
    const hvac = snapshot.devices.find(d => d.id === 'hvac-b')!;
    expect(hvac.state.power).toBe(true);
    expect(hvac.state.targetTemperature).toBe(18);
  });

  it('cognition parameter face survives the checkpoint boundary (R40-C3)', async () => {
    const scenario = boundedScenario();
    const continuous = track(new EngineRuntime(scenario, RUN_OPTIONS));
    // t=10: the pre-boundary event (zone-a temperature) fires, then an
    // injected humidity event — both land in the managing agent's
    // world-model parameter face (the legacy getEnvironmentStateSnapshot).
    await continuous.step(10);
    await continuous.injectEvent({ type: 'humidity-spike', zoneId: 'zone-a', parameter: 'humidity', value: 78 });

    const world = continuous.exportWorldState();
    const cognition = world.agents['world-agent'].cognition!;
    expect(cognition.environmentParams).toBeDefined();
    expect(cognition.environmentParams!['zone-a:temperature']).toEqual({ value: 33, atSimTimeSec: 10 });
    expect(cognition.environmentParams!['zone-a:humidity']).toEqual({ value: 78, atSimTimeSec: 10 });

    // Pre-hibernate reference: the agent's legacy projection (key/value/
    // location; timestamps are wall-clock and re-stamped on restore).
    const faceProjection = (runtime: EngineRuntime) =>
      ((runtime as unknown as {
        agents: Map<string, { getEnvironmentStateSnapshot(): ReadonlyArray<{ key: string; value: number | boolean; location: string }> }>;
      }).agents.get('world-agent'))!.getEnvironmentStateSnapshot()
        .map(e => ({ key: e.key, value: e.value, location: e.location }));
    const before = faceProjection(continuous);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const resumed = track(new EngineRuntime(scenario, RUN_OPTIONS));
    resumed.restoreWorldState(JSON.parse(JSON.stringify(world)) as EngineWorldStateExport);

    // The resumed agent's legacy projection equals the hibernated moment's —
    // pre-C3 it started from ZERO until the next event arrived.
    expect(faceProjection(resumed)).toEqual(before);

    // Round trip: re-exporting the resumed world carries the same face
    // (same capture sim-time stamp — the runtime clock was restored to t=10).
    expect(resumed.exportWorldState().agents['world-agent'].cognition?.environmentParams)
      .toEqual(cognition.environmentParams);

    // Pre-C3 checkpoint (no environmentParams field): restore does not crash,
    // the face honestly starts empty.
    const legacyWorld = JSON.parse(JSON.stringify(world)) as EngineWorldStateExport;
    delete legacyWorld.agents['world-agent'].cognition!.environmentParams;
    const legacy = track(new EngineRuntime(scenario, RUN_OPTIONS));
    expect(() => legacy.restoreWorldState(legacyWorld)).not.toThrow();
    expect(faceProjection(legacy)).toEqual([]);
  });

  it('restores the fault RNG position (seed + draws)', async () => {
    const scenario = boundedScenario();
    const runtime = track(new EngineRuntime(scenario, RUN_OPTIONS));
    // failureRate consumes one draw per commanded device-op.
    runtime.setDeviceFault('hvac-b', { failureRate: 0.9 });
    for (let i = 0; i < 5; i++) {
      await runtime.executeDeviceCommand('hvac-b', 'turn-on');
      await runtime.executeDeviceCommand('hvac-b', 'turn-off');
    }
    const world = runtime.exportWorldState();
    expect(world.rng.draws).toBeGreaterThan(0);
    runtime.setDeviceFault('hvac-b', null);

    const resumed = track(new EngineRuntime(scenario, RUN_OPTIONS));
    resumed.restoreWorldState(world);
    // Export again: same seed, same draw count — the position was restored.
    const reExported = resumed.exportWorldState();
    expect(reExported.rng).toEqual(world.rng);
  });

  it('refuses to restore a non-fresh runtime or an unsupported format version', async () => {
    const runtime = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    await runtime.step(1);
    const world = runtime.exportWorldState();

    const other = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    other.start(1);
    other.pause();
    expect(() => other.restoreWorldState(world)).toThrow(/only a freshly created runtime/);

    const fresh = track(new EngineRuntime(boundedScenario(), RUN_OPTIONS));
    expect(() =>
      fresh.restoreWorldState({ ...world, formatVersion: 999 as never }),
    ).toThrow(/unsupported world-state format version/);
  });

  it('planWorldStateRestore: global deviations only, drift warnings, occupancy order', () => {
    const world: EngineWorldStateExport = {
      formatVersion: ENGINE_WORLD_STATE_VERSION,
      simTimeSec: 100,
      speed: 1,
      tickCount: 100,
      simStartEpochMs: Date.now(),
      eventSeq: 4,
      rng: { seed: 1, draws: 0 },
      zones: {
        'zone-a': {
          occupancy: 5,
          field: { temperature: { value: 25, baseline: 22 } },
          custom: { deskOccupied: true },
          global: { humidity: 80 },
        },
        'zone-gone': { global: { temperature: 20 } },
      },
      devices: {
        'hvac-b': { state: { power: true }, fault: { offline: true } },
        'dev-gone': { state: {}, fault: null },
      },
      deviceEffects: [],
      agents: { 'world-agent': { enabled: false }, 'agent-gone': { enabled: true } },
      reputation: null,
      recentDecisions: [],
      acCapabilities: {},
      scheduler: { firedEventIds: [], occupancyFired: [] },
      pendingEffectChecks: [],
      flowEngine: null,
    };
    const plan = planWorldStateRestore(world, {
      scenario: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      deviceIds: new Set(['hvac-b']),
      agentIds: new Set(['world-agent']),
      // Fresh model reads: humidity matches (clock-driven — no write back),
      // temperature deviates (an injected constant must be re-applied).
      readParameter: (parameter, zoneId) =>
        parameter === 'humidity' && zoneId === 'zone-a' ? 80 : 21,
    });

    expect(plan.fieldBaselines).toEqual([{ zoneId: 'zone-a', parameter: 'temperature', value: 22 }]);
    expect(plan.fieldValues).toEqual([{ zoneId: 'zone-a', parameter: 'temperature', value: 25 }]);
    expect(plan.customWrites).toEqual([{ zoneId: 'zone-a', parameter: 'deskOccupied', value: true }]);
    expect(plan.occupancyWrites).toEqual([{ zoneId: 'zone-a', count: 5 }]);
    expect(plan.globalWrites).toEqual([]); // humidity matched the fresh model
    expect(plan.faultWrites).toEqual([{ deviceId: 'hvac-b', fault: { offline: true } }]);
    expect(plan.agentDisables).toEqual(['world-agent']);
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('zone-b'),
      expect.stringContaining('zone-gone'),
      expect.stringContaining('dev-gone'),
      expect.stringContaining('agent-gone'),
    ]));

    // A deviating global read produces exactly one write-back.
    const plan2 = planWorldStateRestore(world, {
      scenario: { zones: [{ id: 'zone-a' }] },
      deviceIds: new Set(),
      agentIds: new Set(),
      readParameter: () => 50,
    });
    expect(plan2.globalWrites).toEqual([
      { zoneId: 'zone-a', parameter: 'humidity', value: 80 },
    ]);
  });

  it('trajectoryAppend keeps the hibernated sim\'s decision history (no truncation)', async () => {
    const scenario = boundedScenario({ llmForced: false });
    const dir = makeTempDir();
    const first = track(new EngineRuntime(scenario, { ...RUN_OPTIONS, trajectoryDir: dir }));
    await first.step(10); // pre-boundary event → decision record
    const recordsBefore = readJsonl(first.getTrajectoryFilePath()!);
    expect(recordsBefore.length).toBeGreaterThanOrEqual(1);

    // The resumed runtime reuses the SAME directory with append semantics.
    const resumed = track(new EngineRuntime(scenario, {
      ...RUN_OPTIONS,
      trajectoryDir: dir,
      trajectoryAppend: true,
    }));
    resumed.restoreWorldState(first.exportWorldState());
    await resumed.step(50); // t=60 — post-boundary event fires → records append
    const recordsAfter = readJsonl(resumed.getTrajectoryFilePath()!);
    expect(recordsAfter.length).toBeGreaterThan(recordsBefore.length);
    // History intact: every pre-hibernate record still present, in order.
    expect(recordsAfter.slice(0, recordsBefore.length)).toEqual(recordsBefore);
  });
});

// ---------------------------------------------------------------------------
// LLM arm: decisions replay from records, never re-invoked
// ---------------------------------------------------------------------------

/**
 * A deterministic scripted client: answers every call with the same canned
 * structured decision (the continuous run's "model"). It honors the logging
 * callback + context provider the runtime wires in (assembleLlmLogging) —
 * without emitting those entries the trajectory would never record the
 * (userPrompt, rawResponse) pairs the record-replay arm replays from.
 */
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

/**
 * The design's record-replay rule (§6.3): a resumed world's LLM-needing
 * moments answer from the trajectory's recorded (prompt, response) pairs —
 * a call with no record is a MISS (the design forbids re-invoking the model
 * during replay; misses fail loudly instead of inventing an answer).
 */
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

describe('EngineRuntime world-state (LLM arm: record-replay, never re-invoke)', () => {
  it('P0 acceptance invariant (LLM): resumed run answers from records and matches the continuous run', async () => {
    const scenario = boundedScenario({ llmForced: true });
    const dir = makeTempDir();
    const scripted = new ScriptedLLMClient();

    // Continuous run: T=40 (LLM-forced event fires at t=10) + T2=20 (second
    // LLM-forced event at t=50 — the resumed run's LLM-needing moment).
    const continuous = track(new EngineRuntime(scenario, {
      ...RUN_OPTIONS,
      trajectoryDir: dir,
      llmClient: scripted as unknown as LLMClient,
      autoInitiateAC: false, // decision-level: no AC execution handshakes
    }));
    await continuous.step(40); // t=40
    expect(scripted.calls).toBeGreaterThanOrEqual(1); // the LLM path ran
    const world = continuous.exportWorldState();
    await continuous.step(20); // t=60 — post-boundary LLM moment
    expect(scripted.calls).toBeGreaterThanOrEqual(2);
    const reference = worldProjection(continuous.getSnapshot());

    // Build the replay source from the CONTINUOUS run's trajectory records.
    const records = readJsonl(continuous.getTrajectoryFilePath()!);
    const replay = new RecordReplayLLMClient(records);
    expect(replay['responses'].size).toBeGreaterThanOrEqual(2); // both moments recorded

    // Resumed run: same checkpoint, decisions served from records only.
    const resumed = track(new EngineRuntime(scenario, {
      ...RUN_OPTIONS,
      trajectoryDir: dir,
      trajectoryAppend: true,
      llmClient: replay as unknown as LLMClient,
      autoInitiateAC: false,
    }));
    resumed.restoreWorldState(world);
    await resumed.step(20); // t=60 — same LLM-needing moment

    expect(replay.served).toBeGreaterThanOrEqual(1); // answered from records
    expect(replay.misses).toEqual([]); // and ONLY from records
    expect(worldProjection(resumed.getSnapshot())).toEqual(reference);
  });
});

// ---------------------------------------------------------------------------

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}
