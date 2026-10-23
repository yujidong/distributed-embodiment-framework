/**
 * @vitest-environment node
 *
 * EngineRuntime tests (no LLM backend, no network).
 *
 * Scenario: two adjacent zones — a sensor agent in zone A (temperature
 * sensor) and an actuator agent in zone B (HVAC). Two variants:
 *   - no-LLM (rule-only): agents run with Layer-2 disabled; event
 *     processing is verified through dual-trigger stats + snapshots.
 *   - mock-LLM: a structural LLMClient stub (same pattern as the
 *     trajectory-recorder smoke test) drives real Layer-2 assessments;
 *     decisions and trajectory lines are verified.
 *
 * Every runtime is stop()ed after each test — clean shutdown is part of
 * the contract (vitest must exit without dangling handles).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { EventType, type SystemEvent } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

// ---------------------------------------------------------------------------
// MockLLMClient — structural mirror of LLMClient (decision path only)
// ---------------------------------------------------------------------------

interface MockLogParams {
  systemPrompt?: string;
  userPrompt: string;
  response: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  model?: string;
  success: boolean;
  errorMessage?: string;
  context?: { agentId?: string; agentName?: string; eventId?: string };
}

class MockLLMClient {
  static readonly MODEL = 'mock-model';
  /** Canned structured decision the assessor's JSON path accepts. */
  static readonly CANNED = JSON.stringify({ decision: 'collaborate', reasoning: 'mock' });

  private loggingCallback: ((params: MockLogParams) => void) | null = null;
  private contextProvider: (() => MockLogParams['context']) | null = null;

  setLoggingCallback(callback: ((params: MockLogParams) => void) | null): void {
    this.loggingCallback = callback;
  }

  setContextProvider(provider: () => MockLogParams['context']): void {
    this.contextProvider = provider;
  }

  getProviderName(): string {
    return 'mock';
  }

  getModel(): string {
    return MockLLMClient.MODEL;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async quickChat(content: string, systemPrompt?: string): Promise<{
    content: string;
    model: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const start = Date.now();
    const response = {
      content: MockLLMClient.CANNED,
      model: MockLLMClient.MODEL,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
    this.loggingCallback?.({
      systemPrompt,
      userPrompt: content,
      response: response.content,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      durationMs: Date.now() - start,
      model: response.model,
      success: true,
      context: this.contextProvider?.() ?? {},
    });
    return response;
  }

  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    const userPrompt = params.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const systemPrompt = params.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    return this.quickChat(userPrompt, systemPrompt);
  }
}

// ---------------------------------------------------------------------------
// Scenario + helpers
// ---------------------------------------------------------------------------

function twoZoneScenario(withScheduledEvent = true) {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'runtime-test', name: 'Runtime Test Scenario' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: withScheduledEvent
      ? [
          {
            id: 'evt-scheduled-spike',
            type: 'temperature-spike',
            zoneId: 'zone-a',
            parameter: 'temperature',
            value: 33,
            atSimTimeSec: 3,
          },
        ]
      : [],
  });
}

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function makeRuntime(options?: EngineRuntimeOptions, withScheduledEvent = true): EngineRuntime {
  const runtime = new EngineRuntime(twoZoneScenario(withScheduledEvent), options);
  runtimes.push(runtime);
  return runtime;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engine-runtime-test-'));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No-LLM variant (rule-only dual-trigger config)
// ---------------------------------------------------------------------------

describe('EngineRuntime (rule-only, no LLM)', () => {
  it('bounds speed at start/resume (DevLoop DoS guard: 1e9 wedged the host)', () => {
    const runtime = makeRuntime(undefined, false);
    expect(() => runtime.start(1e9)).toThrow(/speed must be > 0 and <= 10000/);
    expect(() => runtime.start(Number.POSITIVE_INFINITY)).toThrow(/speed must be/);

    // Legal speed starts, then resume retargets with the same bound.
    runtime.start(1);
    runtime.pause();
    expect(() => runtime.resume(100_001)).toThrow(/speed must be > 0 and <= 10000/);
    runtime.resume(EngineRuntime.MAX_SPEED);
    expect(runtime.getSnapshot().speed).toBe(EngineRuntime.MAX_SPEED);
  });

  it('builds the world from a scenario and exposes a JSON-serializable snapshot', () => {
    const runtime = makeRuntime();

    const snapshot = runtime.getSnapshot();

    expect(snapshot.scenarioId).toBe('runtime-test');
    expect(snapshot.state).toBe('created');
    expect(snapshot.zones.map(z => z.id)).toEqual(['zone-a', 'zone-b']);
    expect(snapshot.devices.map(d => d.id)).toEqual(['temp-sensor-a', 'hvac-b']);
    expect(snapshot.devices.find(d => d.id === 'temp-sensor-a')?.role).toBe('sensor');
    expect(snapshot.devices.find(d => d.id === 'hvac-b')?.role).toBe('actuator');

    const agents = snapshot.agents.map(a => a.id);
    expect(agents).toEqual(['sensor-agent', 'actuator-agent']);
    for (const agent of snapshot.agents) {
      expect(agent.llmEnabled).toBe(false);
      expect(agent.eventsProcessed).toBe(0);
      expect(agent.activeACCount).toBe(0);
    }
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.managedZoneIds).toEqual(['zone-a']);

    // JSON round-trip: the snapshot must survive serialization unchanged.
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped).toEqual(snapshot);
  });

  it('advances sim time via step() and fires scheduled events', async () => {
    const runtime = makeRuntime();

    await runtime.step(2);
    let snapshot = runtime.getSnapshot();
    expect(snapshot.simTimeSec).toBe(2);
    expect(snapshot.tickCount).toBe(2);
    expect(snapshot.scheduledEvents[0].fired).toBe(false);

    await runtime.step(1); // crosses atSimTimeSec=3 → scheduled injection
    snapshot = runtime.getSnapshot();
    expect(snapshot.simTimeSec).toBe(3);
    expect(snapshot.scheduledEvents[0].fired).toBe(true);
    expect(snapshot.zones.find(z => z.id === 'zone-a')?.parameters.temperature).toBe(33);
    // The managing sensor agent processed the scheduled event.
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.eventsProcessed).toBe(1);
    expect(snapshot.agents.find(a => a.id === 'actuator-agent')?.eventsProcessed).toBe(0);
  });

  it('manual injection carrying a scripted event id consumes its scheduled firing (B2 demo mode)', async () => {
    const runtime = makeRuntime(); // evt-scheduled-spike scheduled at t=3 (value 33)

    // Demo playback injects the hero event EARLY (t=0, demo value 34): the
    // physical write lands immediately and the scheduled copy is consumed.
    await runtime.injectEvent({
      id: 'evt-scheduled-spike',
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 34,
    });
    let snapshot = runtime.getSnapshot();
    expect(snapshot.zones.find(z => z.id === 'zone-a')?.parameters.temperature).toBe(34);
    expect(snapshot.scheduledEvents[0].fired).toBe(true);

    // Crossing atSimTimeSec=3 must NOT re-fire: no second delivery to the
    // managing agent, no clobbering the demo value back to the scripted 33.
    await runtime.step(4);
    snapshot = runtime.getSnapshot();
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.eventsProcessed).toBe(1);
    expect(snapshot.zones.find(z => z.id === 'zone-a')?.parameters.temperature).not.toBe(33);
  });

  it('injectEvent sets the physical parameter and delivers to managing agents', async () => {
    const runtime = makeRuntime(undefined, false);

    const result = await runtime.injectEvent({
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 35,
    });

    expect(result.parameter).toBe('temperature');
    expect(result.value).toBe(35);
    expect(result.targetAgentIds).toEqual(['sensor-agent']);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.zones.find(z => z.id === 'zone-a')?.parameters.temperature).toBe(35);
    // R98: numeric event writes are ZONE-SCOPED even for bounds-less zones
    // (the legacy global value-model write pinned every zone at the value
    // forever — the chen-03 freeze). zone-b keeps its own reading; only the
    // event routing was ever zone-scoped, now the physics is too.
    expect(snapshot.zones.find(z => z.id === 'zone-b')?.parameters.temperature).not.toBe(35);
    expect(snapshot.zones.find(z => z.id === 'zone-b')?.parameters.humidity).not.toBe(35);
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.eventsProcessed).toBe(1);
    expect(snapshot.agents.find(a => a.id === 'actuator-agent')?.eventsProcessed).toBe(0);
  });

  it('derives parameter/value from the event type when not given', async () => {
    const runtime = makeRuntime(undefined, false);

    const result = await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'zone-a' });

    expect(result.parameter).toBe('temperature');
    expect(result.value).toBe(32);
    expect(runtime.getSnapshot().zones.find(z => z.id === 'zone-a')?.parameters.temperature).toBe(32);
  });

  it('rejects injection into an unknown zone with a descriptive error', async () => {
    const runtime = makeRuntime(undefined, false);

    await expect(
      runtime.injectEvent({ type: 'temperature-spike', zoneId: 'nowhere' }),
    ).rejects.toThrow(/unknown zone "nowhere"/);
  });

  it('never injects observation-only events — recorded state is not a stimulus (T-019)', async () => {
    // Replay exports bake recorded zone-samples / device-states / past
    // decisions as details-only events. Marked observationOnly they must
    // fire on schedule (consumers see them as fired) but NEVER reach
    // physics or agents — pre-fix, every baked sample became an injected
    // `zone-sample=true` parameter fanned out to managing agents (R10:
    // 2326 spurious decisions in one replayed window).
    const scenario = loadScenarioFile({
      version: '1.0',
      meta: { id: 'replay-hygiene', name: 'Replay Hygiene' },
      zones: [
        { id: 'zone-a', name: 'Zone A', baseline: { temperature: 20 } },
        { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'], baseline: { temperature: 20 } },
      ],
      devices: [
        {
          id: 'temp-sensor-a',
          type: 'temperature-sensor',
          capabilities: ['temperature-reading'],
          zoneId: 'zone-a',
        },
      ],
      agents: [
        {
          id: 'sensor-agent',
          name: 'Sensor Agent',
          capabilities: ['temperature-monitoring'],
          managesZoneIds: ['zone-a'],
          boundDeviceIds: ['temp-sensor-a'],
        },
      ],
      events: [
        {
          id: 'replay:zone:1',
          type: 'zone-sample',
          zoneId: 'zone-a',
          atSimTimeSec: 2,
          observationOnly: true,
          details: { simTimeSec: 2, parameters: { temperature: 31 } },
        },
        {
          id: 'replay:dev:1',
          type: 'device-state',
          zoneId: 'zone-a',
          atSimTimeSec: 2,
          observationOnly: true,
          details: { deviceId: 'temp-sensor-a', simTimeSec: 2 },
        },
        {
          id: 'replay:dec:1',
          type: 'sim-decision',
          zoneId: 'zone-a',
          atSimTimeSec: 2,
          observationOnly: true,
          details: { agentId: 'sensor-agent', decision: 'ignore' },
        },
        {
          id: 'evt-real-spike',
          type: 'temperature-spike',
          zoneId: 'zone-a',
          parameter: 'temperature',
          value: 33,
          atSimTimeSec: 3,
        },
      ],
    });
    // The loader whitelists the flag through to the definition.
    expect(scenario.events.filter(e => e.observationOnly === true).length).toBe(3);

    const runtime = new EngineRuntime(scenario);
    runtimes.push(runtime);
    await runtime.step(3);
    const snapshot = runtime.getSnapshot();

    // All scheduled events are marked fired (replay consumers see progress)
    // …but ONLY the real stimulus reached the managing agent.
    for (const event of snapshot.scheduledEvents) {
      expect(event.fired).toBe(true);
    }
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.eventsProcessed).toBe(1);

    // No observation-only physics write leaked: the baked sample would have
    // registered a bogus `zone-sample` parameter (resolveInjection's
    // `parameter ?? type` default), and the real spike is the only write.
    const zoneA = snapshot.zones.find(z => z.id === 'zone-a');
    expect(zoneA?.parameters).not.toHaveProperty('zone-sample');
    expect(zoneA?.parameters).not.toHaveProperty('sim-decision');
    expect(zoneA?.parameters).not.toHaveProperty('device-state');
    expect(zoneA?.parameters.temperature).toBe(33);
  });

  it('start/pause/resume/stop control the tick loop', async () => {
    const runtime = makeRuntime(undefined, false);

    runtime.start(1);
    expect(runtime.getState()).toBe('running');
    await sleep(60);
    const afterRun = runtime.getSimTimeSec();
    expect(afterRun).toBeGreaterThanOrEqual(2);

    runtime.pause();
    expect(runtime.getState()).toBe('paused');
    const frozenAt = runtime.getSimTimeSec();
    await sleep(50);
    expect(runtime.getSimTimeSec()).toBe(frozenAt);

    runtime.resume();
    expect(runtime.getState()).toBe('running');
    await sleep(50);
    expect(runtime.getSimTimeSec()).toBeGreaterThan(frozenAt);

    runtime.stop();
    expect(runtime.getState()).toBe('stopped');
    expect(() => runtime.start()).toThrow(/stopped/);
    // stop() is idempotent
    expect(() => runtime.stop()).not.toThrow();
  });

  it('step() works while paused for manual control', async () => {
    const runtime = makeRuntime(undefined, false);

    runtime.start(1);
    runtime.pause();
    const before = runtime.getSimTimeSec();
    await runtime.step(5);
    expect(runtime.getSimTimeSec()).toBe(before + 5);
  });

  // -------------------------------------------------------------------------
  // T43: running-state speed retarget + the trailing window speed face
  // -------------------------------------------------------------------------

  it('retargetSpeed changes the pace of a RUNNING runtime without a pause detour', async () => {
    const runtime = makeRuntime(undefined, false);

    runtime.start(2);
    runtime.retargetSpeed(50);
    expect(runtime.getState()).toBe('running'); // property change, no transition
    expect(runtime.getSnapshot().speed).toBe(50);
    await sleep(30); // a few ticks stride at the new pace
    expect(runtime.getSimTimeSec()).toBeGreaterThanOrEqual(50);

    // Same bounds as start/resume; a stopped runtime rejects.
    expect(() => runtime.retargetSpeed(0)).toThrow(/retargetSpeed: speed must be > 0 and <= 10000/);
    expect(() => runtime.retargetSpeed(100_001)).toThrow(/retargetSpeed: speed must be > 0 and <= 10000/);
    runtime.stop();
    expect(() => runtime.retargetSpeed(3)).toThrow(/stopped/);
  });

  it('samples the auto-run loop into a window speed face; pause clears it', async () => {
    // 60ms ticks: 4+ ticks inside ~350ms → ≥3 intervals, window math checkable.
    const runtime = makeRuntime({ tickMs: 60 }, false);
    runtime.start(5);

    await sleep(80);
    const early = runtime.getSnapshot();
    // T61: the sampler aggregates into 1s WALL BUCKETS — the honest-absence
    // window is "fewer than two wall seconds observed". At 80ms this is
    // usually absent; if the run straddled a wall-second boundary the face
    // is a 1-2s span, which is still honest (never a fake 0).
    expect(
      early.effectiveSpeedWindowPerSec === undefined ||
        (early.effectiveSpeedWindowSec ?? 0) <= 2,
    ).toBe(true);

    // T61: 1s-bucket aggregation — the window needs TWO wall seconds, so
    // run past a bucket boundary (total ~1.3s of running).
    await sleep(1200);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.state).toBe('running');
    // Σsim/Σwall over 60ms ticks at speed 5: noisy wall clock, so bound the
    // mean (never above the nominal ceiling speed/tickMs, never zero) and
    // check the covered span, not a brittle point value.
    expect(snapshot.effectiveSpeedWindowPerSec).toBeGreaterThan(0);
    expect(snapshot.effectiveSpeedWindowPerSec!).toBeLessThanOrEqual(5 / 0.06);
    expect(snapshot.effectiveSpeedWindowSec).toBeGreaterThan(0);
    expect(snapshot.effectiveSpeedWindowSec!).toBeLessThanOrEqual(60);
    // The instantaneous face keeps its own gate (lastTickWallMs > 0): a tick
    // body that costs 0ms on a fast host honestly shows no instant estimate —
    // the window face is independent of that quirk (T43's point).

    runtime.pause();
    const paused = runtime.getSnapshot();
    expect(paused.state).toBe('paused');
    expect(paused.effectiveSpeedWindowPerSec).toBeUndefined();
    expect(paused.effectiveSpeedWindowSec).toBeUndefined();

    // Resume restarts the window (no frozen-gap accounting).
    runtime.resume();
    await sleep(1500); // ≥2 wall seconds — two buckets, the honest window minimum
    const resumed = runtime.getSnapshot();
    expect(resumed.effectiveSpeedWindowPerSec).toBeDefined();
    // T61: fresh 1s-bucket window after resume — 1.5s of running spans at
    // most three wall seconds, never the pre-pause span.
    expect(resumed.effectiveSpeedWindowSec!).toBeLessThanOrEqual(3);
  });

  it('subscribe delivers bus events; unsubscribe stops them', async () => {
    const runtime = makeRuntime(undefined, false);

    const received: SystemEvent[] = [];
    const unsubscribe = runtime.subscribe(event => received.push(event));

    // Device command → device state change flows through the EventManager bus.
    const commandResult = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(commandResult.success).toBe(true);

    const stateChanges = received.filter(e => e.type === EventType.DEVICE_STATE_CHANGE);
    expect(stateChanges.length).toBeGreaterThanOrEqual(1);

    unsubscribe();
    const countAfterUnsub = received.length;
    await runtime.executeDeviceCommand('hvac-b', 'turn-off');
    expect(received.length).toBe(countAfterUnsub);
  });

  it('executeDeviceCommand fails descriptively for unmanaged devices', async () => {
    const runtime = makeRuntime(undefined, false);

    const result = await runtime.executeDeviceCommand('ghost-device', 'turn-on');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No agent manages device "ghost-device"/);
  });

  it('creates a trajectory file and records rule decisions without an LLM', async () => {
    const runtime = makeRuntime({ trajectoryDir: makeTempDir() }, false);

    const trajectoryPath = runtime.getTrajectoryFilePath();
    expect(trajectoryPath).not.toBeNull();
    // Living-worlds P2: the trajectory log is SEGMENTED — the append target
    // is <base>/segment-000001.jsonl, created lazily on the first record
    // (a recorder that never records leaves no empty artifact).
    expect(trajectoryPath).toMatch(/[\\/]segment-000001\.jsonl$/);
    expect(existsSync(trajectoryPath!)).toBe(false);

    await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'zone-a', value: 31 });
    // Rule-only agents resolve events via deterministic rules (no LLM):
    // the sensor-only agent must notify capable agents → initiate_ac (rule).
    const decisions = runtime.getSnapshot().recentDecisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      agentId: 'sensor-agent',
      decision: 'initiate_ac',
      decisionSource: 'rule',
    });

    // T-014: the trajectory record scores the deterministic decision
    // against the derived formal-model ground truth (Type E → initiate_ac)
    // and attributes its true source — no LLM, so no model field.
    const lines = readFileSync(trajectoryPath!, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      agentId: 'sensor-agent',
      decision: 'initiate_ac',
      decisionSource: 'rule',
      groundTruth: { correctDecision: 'initiate_ac', interactionType: 'E' },
      correct: true,
    });
    expect(lines[0].model).toBeUndefined();
  });

  it('rule-only: high-temperature event → rule decision → hvac commanded → temperature controlled', async () => {
    const runtime = makeRuntime(undefined, false);

    // 38°C heat spike in zone-b, managed by the hvac actuator agent.
    const result = await runtime.injectEvent({
      type: 'temperature-spike',
      zoneId: 'zone-b',
      parameter: 'temperature',
      value: 38,
      severity: 'high',
    });
    expect(result.targetAgentIds).toEqual(['actuator-agent']);

    // Deterministic rule decision, recorded without any LLM.
    const decisions = runtime.getSnapshot().recentDecisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      agentId: 'actuator-agent',
      eventType: 'temperature-spike',
      decision: 'handle_independently',
      decisionSource: 'rule',
    });
    // The defer/failure reason rides the snapshot (usability fix): the
    // rule path explains itself without digging server logs.
    expect(decisions[0].reasoning).toMatch(/direct actuator coverage/);

    // The rule actuation commanded the hvac toward the comfort target:
    // powered on with a 24°C setpoint (declared capability temperature-control
    // dispatches to the temperature handler).
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-b');
    expect(hvac?.state.power).toBe(true);
    expect(hvac?.state.targetTemperature).toBe(24);
    // Declared = executable: the capability contract is queryable.
    expect(hvac?.commands).toContain('temperature-control');

    // The registered cooling effect pulls the zone temperature back down.
    await runtime.step(30);
    const temp = runtime.getSnapshot().zones.find(z => z.id === 'zone-b')?.parameters.temperature;
    expect(typeof temp).toBe('number');
    expect(temp as number).toBeLessThan(38);
  });
});

// ---------------------------------------------------------------------------
// Mock-LLM variant (Layer-2 enabled with a stub client)
// ---------------------------------------------------------------------------

describe('EngineRuntime (mock LLM)', () => {
  it('records decisions and trajectory lines for injected events', async () => {
    const trajectoryDir = makeTempDir();
    const mock = new MockLLMClient();
    const runtime = makeRuntime({
      llmClient: mock as unknown as LLMClient,
      trajectoryDir,
      autoInitiateAC: false, // decision-level test: skip AC execution
    }, false);

    const snapshotBefore = runtime.getSnapshot();
    for (const agent of snapshotBefore.agents) {
      expect(agent.llmEnabled).toBe(true);
    }

    const result = await runtime.injectEvent({
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 34,
    });

    expect(result.targetAgentIds).toEqual(['sensor-agent']);

    // Decision recorded in the runtime decision stream.
    const snapshot = runtime.getSnapshot();
    expect(snapshot.zones.find(z => z.id === 'zone-a')?.parameters.temperature).toBe(34);
    expect(snapshot.recentDecisions.length).toBeGreaterThanOrEqual(1);
    const decision = snapshot.recentDecisions.find(d => d.agentId === 'sensor-agent');
    expect(decision).toBeDefined();
    expect(decision!.eventId).toBe(result.eventId);
    expect(['initiate_ac', 'handle_independently', 'defer', 'ignore']).toContain(decision!.decision);
    expect(['precheck', 'llm']).toContain(decision!.decisionSource);

    // Trajectory JSONL written through to disk.
    const trajectoryPath = runtime.getTrajectoryFilePath()!;
    expect(existsSync(trajectoryPath)).toBe(true);
    // T-014: the log is attributed to the model the injected client
    // actually calls (getModel()), not a scenario-declared llm.model
    // (P2: the base dir carries the model slug; the file is the segment).
    expect(trajectoryPath).toMatch(/mock-model[\\/]segment-000001\.jsonl$/);
    const lines = readFileSync(trajectoryPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const record = lines.find(l => l.eventId === result.eventId && l.agentId === 'sensor-agent');
    expect(record).toBeDefined();
    expect(record.decision).toBe(decision!.decision);
    // T-014: ground truth is derived from the formal model (Coverage × Gap
    // → Type A–E). The sensor-only agent facing this zone-a event with no
    // capability gap is Type E — it should notify capable agents.
    expect(record.groundTruth).toEqual({ correctDecision: 'initiate_ac', interactionType: 'E' });
    // A matching deterministic decision scores correct (not a false verdict).
    expect(record.correct).toBe(true);
    // Deterministic decisions made no LLM call — the model stays omitted.
    expect(record.decisionSource).toBe('precheck');
    expect(record.model).toBeUndefined();
  });

  it('attributes an LLM decision to the model that made it and scores it (T-014)', async () => {
    const trajectoryDir = makeTempDir();
    const mock = new MockLLMClient();
    const runtime = makeRuntime({
      llmClient: mock as unknown as LLMClient,
      trajectoryDir,
      autoInitiateAC: false,
    }, false);

    // Capabilities the temperature sensor agent cannot match → not
    // domain-relevant for STEP 0a, no actuator coverage → falls through
    // preCheck to the (mock) LLM with an immediate-action recommendation.
    // The declared face includes the agent's OWN 'temperature-monitoring' so
    // the intersection is NON-zero — FEAT-09's observe-only gate (zero
    // intersection ⟹ no initiate evaluation) does not apply; the remaining
    // gap (smoke-detection/fire-suppression) is what forces the LLM lane.
    const result = await runtime.injectEvent({
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 36,
      severity: 'high',
      requiredCapabilities: ['smoke-detection', 'fire-suppression', 'temperature-monitoring'],
    });

    const trajectoryPath = runtime.getTrajectoryFilePath()!;
    const lines = readFileSync(trajectoryPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    const record = lines.find(l => l.eventId === result.eventId && l.agentId === 'sensor-agent');
    expect(record).toBeDefined();
    expect(record.decisionSource).toBe('llm');
    // The record carries the model of the LLM call that produced it.
    expect(record.model).toBe(MockLLMClient.MODEL);
    // Sensor-only agent with a capability gap → Type D → should notify.
    expect(record.groundTruth).toEqual({ correctDecision: 'initiate_ac', interactionType: 'D' });
    expect(record.decision).toBe('initiate_ac');
    expect(record.correct).toBe(true);
  });

  it('T-024: recentDecisions carry the deciding model (llmModel) on LLM decisions', async () => {
    const mock = new MockLLMClient();
    const runtime = makeRuntime({
      llmClient: mock as unknown as LLMClient,
      autoInitiateAC: false,
    }, false);

    // Same forcing shape as the T-014 test: a declared face with ONE
    // own-capability intersection (non-zero ⟹ FEAT-09's observe-only gate
    // stays out) plus requirements the sensor agent cannot match → the
    // precheck falls through to the mock LLM.
    const result = await runtime.injectEvent({
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 36,
      severity: 'high',
      requiredCapabilities: ['smoke-detection', 'fire-suppression', 'temperature-monitoring'],
    });

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.agentId === 'sensor-agent' && d.eventId === result.eventId);
    expect(decision).toBeDefined();
    expect(decision!.decisionSource).toBe('llm');
    // The snapshot record mirrors the trajectory's per-record model —
    // console consumers see WHICH model decided without joining files.
    expect(decision!.llmModel).toBe(MockLLMClient.MODEL);

    // Deterministic (precheck) decisions made no LLM call — no llmModel,
    // matching the trajectory's matched-call omission for rule sources.
    const ruleOnly = makeRuntime({ autoInitiateAC: false }, false);
    const ruleResult = await ruleOnly.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35,
    });
    const ruleDecision = ruleOnly.getSnapshot().recentDecisions
      .find(d => d.agentId === 'sensor-agent' && d.eventId === ruleResult.eventId);
    expect(ruleDecision).toBeDefined();
    // No LLM client configured → the deterministic rule path decided.
    expect(['precheck', 'rule']).toContain(ruleDecision!.decisionSource);
    expect(ruleDecision!.llmModel).toBeUndefined();
  });

  it('supports per-agent LLM assignment (llmPerAgent)', async () => {
    const mock = new MockLLMClient();
    const runtime = makeRuntime({
      llmPerAgent: { 'sensor-agent': mock as unknown as LLMClient },
      autoInitiateAC: false,
    }, false);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.llmEnabled).toBe(true);
    expect(snapshot.agents.find(a => a.id === 'actuator-agent')?.llmEnabled).toBe(false);

    const result = await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'zone-a', value: 36 });
    expect(result.targetAgentIds).toEqual(['sensor-agent']);
    expect(
      runtime.getSnapshot().recentDecisions.some(d => d.eventId === result.eventId),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario baselines + event metadata extensions (schema v1.0 additions)
// ---------------------------------------------------------------------------

describe('EngineRuntime (baselines + event metadata)', () => {
  function baselineScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'baseline-test', name: 'Baseline Test' },
      zones: [
        { id: 'room-a', baseline: { temperature: 31.5, humidity: 68 } },
        { id: 'room-b', baseline: { co2: 550 } },
      ],
      devices: [
        {
          id: 'temp-sensor-a',
          type: 'temperature-sensor',
          capabilities: ['temperature-reading'],
          zoneId: 'room-a',
        },
      ],
      agents: [
        {
          id: 'sensor-agent',
          name: 'Sensor Agent',
          capabilities: ['temperature-monitoring'],
          managesZoneIds: ['room-a'],
          boundDeviceIds: ['temp-sensor-a'],
        },
      ],
    });
  }

  it('seeds zone baselines at build time without triggering agent decisions', () => {
    const runtime = new EngineRuntime(baselineScenario());
    runtimes.push(runtime);

    const snapshot = runtime.getSnapshot();
    // Baselines are visible immediately (no ticks have run).
    expect(snapshot.tickCount).toBe(0);
    expect(snapshot.zones.find(z => z.id === 'room-a')?.parameters.temperature).toBe(31.5);
    expect(snapshot.zones.find(z => z.id === 'room-a')?.parameters.humidity).toBe(68);
    expect(snapshot.zones.find(z => z.id === 'room-b')?.parameters.co2).toBe(550);
    // R99: baselines seed the spatial field PER-ZONE — a zone that never
    // declared a temperature baseline reads the (undeclared) default model,
    // not a sibling zone's baseline (the legacy global write collapsed
    // every bounds-less zone onto one shared value).
    expect(snapshot.zones.find(z => z.id === 'room-b')?.parameters.temperature).not.toBe(31.5);

    // Baselines are initial conditions, not incidents: no agent saw an event.
    expect(snapshot.agents[0].eventsProcessed).toBe(0);
    expect(snapshot.recentDecisions).toHaveLength(0);
  });

  function oneActuatorScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'event-metadata-test', name: 'Event Metadata Test' },
      zones: [{ id: 'zone-a' }],
      devices: [
        {
          id: 'hvac-a',
          type: 'hvac',
          capabilities: ['cooling', 'turn-on'],
          zoneId: 'zone-a',
        },
      ],
      agents: [
        {
          id: 'actuator-agent',
          name: 'Actuator Agent',
          capabilities: ['cooling'],
          managesZoneIds: ['zone-a'],
          boundDeviceIds: ['hvac-a'],
        },
      ],
    });
  }

  it('severity escalates an event to anomaly, changing the precheck outcome', async () => {
    // R100 semantic change (chen-11, pinned in
    // ACNecessityAssessor.smoke-request-face): a smoke event now ALWAYS
    // carries dispatch needs (smoke-monitoring / ventilation /
    // air-purification / emergency-broadcast / emergency-response) — the
    // empty inference that made "smoke = no requirements" was the R100 bug.
    // Consequence for THIS test's old first half: a cooling-only agent no
    // longer Type-A short-circuits a plain smoke reading (it has a real
    // gap → the LLM lane decides). The Type A short-circuit still holds
    // for an agent that actually covers the smoke needs.
    const smokeCapableScenario = () =>
      loadScenarioFile({
        version: '1.0',
        meta: { id: 'event-metadata-smoke', name: 'Event Metadata Smoke' },
        zones: [{ id: 'zone-a' }],
        devices: [
          { id: 'vent-a', type: 'ventilator', capabilities: ['ventilation', 'turn-on'], zoneId: 'zone-a' },
        ],
        agents: [
          {
            id: 'smoke-agent',
            name: 'Smoke Agent',
            capabilities: ['smoke-monitoring', 'ventilation', 'air-purification', 'emergency-broadcast', 'emergency-response'],
            managesZoneIds: ['zone-a'],
            boundDeviceIds: ['vent-a'],
          },
        ],
      });
    const covered = new EngineRuntime(smokeCapableScenario(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
      autoInitiateAC: false,
    });
    runtimes.push(covered);
    const coveredResult = await covered.injectEvent({
      type: 'smoke-detected',
      zoneId: 'zone-a',
      parameter: 'smoke',
      value: 0.05,
    });
    const coveredDecision = covered.getSnapshot().recentDecisions
      .find(d => d.agentId === 'smoke-agent' && d.eventId === coveredResult.eventId);
    // Full smoke-need coverage + direct zone coverage → Type A precheck,
    // no LLM call (the cheap path survives the R100 needs).
    expect(coveredDecision?.decisionSource).toBe('precheck');
    expect(coveredDecision?.decision).toBe('handle_independently');

    // Same plain reading for the cooling-only agent: real gap → LLM lane.
    const plain = new EngineRuntime(oneActuatorScenario(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
      autoInitiateAC: false,
    });
    runtimes.push(plain);
    const plainResult = await plain.injectEvent({
      type: 'smoke-detected',
      zoneId: 'zone-a',
      parameter: 'smoke',
      value: 0.05,
    });
    const plainDecision = plain.getSnapshot().recentDecisions
      .find(d => d.agentId === 'actuator-agent' && d.eventId === plainResult.eventId);
    expect(plainDecision?.decisionSource).toBe('llm');

    // With severity 'high': the event is an anomaly; the agent lacks the
    // smoke dispatch needs and the decision escalates to the LLM.
    // (Note: 'cooling' cannot substitute — but it WOULD match a
    // 'temperature-control' requirement via the domain aliases in
    // environment/types.ts, which is why this test uses a smoke event.)
    const severe = new EngineRuntime(oneActuatorScenario(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
      autoInitiateAC: false,
    });
    runtimes.push(severe);
    const severeResult = await severe.injectEvent({
      type: 'smoke-detected',
      zoneId: 'zone-a',
      parameter: 'smoke',
      value: 0.75,
      severity: 'high',
    });
    const severeDecision = severe.getSnapshot().recentDecisions
      .find(d => d.agentId === 'actuator-agent' && d.eventId === severeResult.eventId);
    expect(severeDecision?.decisionSource).toBe('llm');
    expect(severeDecision?.decision).not.toBe('handle_independently');
  });

  it('requiredCapabilities in the event payload drive the capability-gap check', async () => {
    // The event explicitly requires 'air-purification', which the agent
    // lacks → the Type A precheck fails and the decision reaches the LLM.
    const runtime = new EngineRuntime(oneActuatorScenario(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
      autoInitiateAC: false,
    });
    runtimes.push(runtime);
    const result = await runtime.injectEvent({
      type: 'smoke-detected',
      zoneId: 'zone-a',
      parameter: 'smoke',
      value: 0.75,
      requiredCapabilities: ['air-purification'],
    });
    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.agentId === 'actuator-agent' && d.eventId === result.eventId);
    expect(decision?.decisionSource).toBe('llm');
    expect(decision?.decision).not.toBe('handle_independently');
  });
});

// ---------------------------------------------------------------------------
// Spatial behavior (zones with bounds → localized writes, per-zone field)
// ---------------------------------------------------------------------------

describe('EngineRuntime (spatial behavior, bounded zones)', () => {
  function boundedScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'spatial-test', name: 'Spatial Test' },
      zones: [
        {
          id: 'room-a',
          bounds: { minX: 0, maxX: 4, minY: 0, maxY: 4 },
          adjacentZoneIds: ['room-b'],
          baseline: { temperature: 30, smoke: 0 },
        },
        {
          id: 'room-b',
          bounds: { minX: 4, maxX: 8, minY: 0, maxY: 4 },
          adjacentZoneIds: ['room-a'],
          baseline: { temperature: 20, smoke: 0 },
        },
        {
          // Distant zone: 40 m away, outside the 5 m diffusion range.
          id: 'room-c',
          bounds: { minX: 40, maxX: 44, minY: 0, maxY: 4 },
          adjacentZoneIds: [],
          baseline: { temperature: 20, smoke: 0 },
        },
      ],
      devices: [
        {
          id: 'sensor-a',
          type: 'smoke-sensor',
          capabilities: ['smoke-detection'],
          zoneId: 'room-a',
        },
      ],
      agents: [
        {
          id: 'sensor-agent',
          name: 'Sensor Agent',
          capabilities: ['smoke-detection'],
          managesZoneIds: ['room-a', 'room-b', 'room-c'],
          boundDeviceIds: ['sensor-a'],
        },
      ],
    });
  }

  it('seeds per-zone baselines: snapshot shows DIFFERENT values per zone', () => {
    const runtime = new EngineRuntime(boundedScenario());
    runtimes.push(runtime);

    const snapshot = runtime.getSnapshot();
    const tempOf = (id: string) => snapshot.zones.find(z => z.id === id)?.parameters.temperature;
    expect(tempOf('room-a')).toBe(30);
    expect(tempOf('room-b')).toBe(20);
    expect(tempOf('room-c')).toBe(20);
    // And baselines are initial conditions, not incidents.
    expect(snapshot.agents[0].eventsProcessed).toBe(0);
  });

  it('localized injection: target zone high, adjacent slightly elevated after ticks, distant unchanged', async () => {
    const runtime = new EngineRuntime(boundedScenario());
    runtimes.push(runtime);

    await runtime.injectEvent({
      type: 'smoke-detected',
      zoneId: 'room-a',
      parameter: 'smoke',
      value: 0.75,
    });

    // Immediately: only room-a's field holds the spike (injection radius =
    // half the zone diagonal, 2.83 m < 4 m to room-b's center → no spill).
    let snapshot = runtime.getSnapshot();
    const smokeOf = (id: string) => snapshot.zones.find(z => z.id === id)?.parameters.smoke as number;
    expect(smokeOf('room-a')).toBeCloseTo(0.75, 5);
    expect(smokeOf('room-b')).toBe(0);
    expect(smokeOf('room-c')).toBe(0);

    // After 30 sim-seconds: room-a relaxes down slowly, room-b picked up a
    // small share through diffusion, distant room-c is exactly untouched.
    await runtime.step(30);
    snapshot = runtime.getSnapshot();
    const a = smokeOf('room-a');
    const b = smokeOf('room-b');
    const c = smokeOf('room-c');
    expect(a).toBeGreaterThan(0.35);
    expect(b).toBeGreaterThan(0.005);
    expect(b).toBeLessThan(a);
    expect(c).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// Floor-aware physics (building tier, B-A)
// ---------------------------------------------------------------------------

describe('EngineRuntime — floor-aware physics (B-A)', () => {
  /**
   * Two stacked storeys sharing one floor plan: room-f1 sits directly above
   * room-f0 (NOT interconnected — the slab insulates them); shaft-f0/shaft-f1
   * are the declared stairwell connection.
   */
  function buildingScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-building', name: 'Runtime Building', storeyHeight: 3.5 },
      zones: [
        {
          id: 'room-f0',
          floor: 0,
          bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
          adjacentZoneIds: ['shaft-f0'],
          baseline: { temperature: 30 },
        },
        {
          id: 'room-f1',
          floor: 1,
          bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
          baseline: { temperature: 30 },
        },
        {
          id: 'shaft-f0',
          floor: 0,
          bounds: { minX: 6, maxX: 10, minY: 0, maxY: 5 },
          adjacentZoneIds: ['shaft-f1'],
          baseline: { temperature: 30 },
        },
        {
          id: 'shaft-f1',
          floor: 1,
          bounds: { minX: 6, maxX: 10, minY: 0, maxY: 5 },
          baseline: { temperature: 20 },
        },
      ],
      devices: [],
      agents: [],
    });
  }

  it('a localized event downstairs never spills into the room directly above', async () => {
    const runtime = new EngineRuntime(buildingScenario());
    runtimes.push(runtime);

    const zoneTemp = (id: string) =>
      runtime.getSnapshot().zones.find(z => z.id === id)?.parameters.temperature as number;
    expect(zoneTemp('room-f1')).toBe(30); // seeded baseline

    // Spike in room-f0: the write radius (half the diagonal, ~3.9 m) would
    // reach room-f1 (3.5 m straight up) under the old 3D rule.
    await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'room-f0', value: 40 });
    expect(zoneTemp('room-f0')).toBe(40);
    expect(zoneTemp('room-f1')).toBe(30); // the slab blocks the spillover

    await runtime.step(300);
    expect(zoneTemp('room-f1')).toBe(30); // and no cross-floor diffusion either
  });

  it('declared shaft zones couple across floors — weakly (slab attenuation)', async () => {
    const runtime = new EngineRuntime(buildingScenario());
    runtimes.push(runtime);

    const zoneTemp = (id: string) =>
      runtime.getSnapshot().zones.find(z => z.id === id)?.parameters.temperature as number;
    expect(zoneTemp('shaft-f0')).toBe(30);
    expect(zoneTemp('shaft-f1')).toBe(20);

    await runtime.step(600);

    // The declared connection exchanges heat: warm shaft-f0 cools, cool
    // shaft-f1 warms — conserved (equal masses, equal |ΔT|) — but the T-701
    // U·A model keeps a slab-separated shaft SLOW (90 m³ zones exchange
    // ~15 W at ΔT 10; an open same-floor doorway would converge far further
    // in 10 minutes). Bounds recalibrated for the mass-scaled exchange.
    const below = zoneTemp('shaft-f0');
    const above = zoneTemp('shaft-f1');
    expect(below).toBeLessThan(29.99);
    expect(below).toBeGreaterThan(29.5);
    expect(above).toBeGreaterThan(20.01);
    expect(above).toBeLessThan(20.5);
    // Energy-conserving pair exchange: equal volumes swing equally.
    expect(30 - below).toBeCloseTo(above - 20, 2);
  });
});

// ---------------------------------------------------------------------------
// Outdoor envelope & occupancy (building tier, B-B)
// ---------------------------------------------------------------------------

describe('EngineRuntime — outdoor envelope & occupancy (B-B)', () => {
  /**
   * room-a declares a connection to the outdoor boundary (a room facing the
   * weather); room-b is interior and far away; outdoor is the infinite
   * boundary whose baseline is externally driven.
   */
  function envelopeScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-envelope', name: 'Runtime Envelope' },
      zones: [
        {
          id: 'room-a',
          floor: 0,
          bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 },
          adjacentZoneIds: ['outdoor'],
          baseline: { temperature: 20 },
        },
        {
          id: 'room-b',
          floor: 0,
          bounds: { minX: 20, maxX: 26, minY: 20, maxY: 25 },
          baseline: { temperature: 20 },
        },
        {
          id: 'outdoor',
          type: 'outdoor',
          bounds: { minX: 8, maxX: 12, minY: 0, maxY: 5 },
          baseline: { temperature: 35 },
        },
      ],
      devices: [],
      agents: [],
    });
  }

  const zoneTemp = (runtime: EngineRuntime, id: string) =>
    runtime.getSnapshot().zones.find(z => z.id === id)?.parameters.temperature as number;

  it('outdoor heat seeps into the adjacent room through the envelope — slowly; interior untouched', async () => {
    const runtime = new EngineRuntime(envelopeScenario());
    runtimes.push(runtime);

    await runtime.step(600);

    const a = zoneTemp(runtime, 'room-a');
    // Envelope leak: the room warmed toward the 35°C outside…
    expect(a).toBeGreaterThan(20.5);
    // …but through envelopeU=0.1 the 15°C gap is nowhere near closed after
    // 10 minutes (an open same-floor doorway would have closed most of it).
    expect(a).toBeLessThan(23);
    // The outdoor boundary absorbed nothing from the building.
    expect(zoneTemp(runtime, 'outdoor')).toBe(35);
    // The interior room (no outdoor adjacency) is exactly untouched.
    expect(zoneTemp(runtime, 'room-b')).toBe(20);
  });

  it('an indoor spike never drags the outdoor boundary away from its baseline', async () => {
    const runtime = new EngineRuntime(envelopeScenario());
    runtimes.push(runtime);

    await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'room-a', value: 45 });
    expect(zoneTemp(runtime, 'room-a')).toBe(45);
    expect(zoneTemp(runtime, 'outdoor')).toBe(35);

    await runtime.step(300);
    expect(zoneTemp(runtime, 'outdoor')).toBe(35); // strong baseline adsorption
  });

  it('a weather event re-bases outdoor at runtime and the adjacent room follows', async () => {
    const runtime = new EngineRuntime(envelopeScenario());
    runtimes.push(runtime);

    // Cold front: the outside drops to 10°C. On an outdoor zone this is a
    // boundary-condition change — it updates the baseline, not a spike.
    await runtime.injectEvent({
      type: 'weather-change',
      zoneId: 'outdoor',
      parameter: 'temperature',
      value: 10,
    });
    expect(zoneTemp(runtime, 'outdoor')).toBe(10);

    await runtime.step(600);

    // The new baseline sticks (a one-off spike would have relaxed back to 35)…
    expect(zoneTemp(runtime, 'outdoor')).toBe(10);
    // …and the room facing outside cools toward it through the envelope.
    const a = zoneTemp(runtime, 'room-a');
    expect(a).toBeLessThan(19.5);
    expect(a).toBeGreaterThan(14); // envelope keeps it slow
    // Interior room still untouched.
    expect(zoneTemp(runtime, 'room-b')).toBe(20);
  });

  it('updateZoneBaseline drives an outdoor zone without an event', async () => {
    const runtime = new EngineRuntime(envelopeScenario());
    runtimes.push(runtime);

    runtime.updateZoneBaseline('outdoor', 'temperature', 5);
    expect(zoneTemp(runtime, 'outdoor')).toBe(5);

    await runtime.step(300);
    expect(zoneTemp(runtime, 'outdoor')).toBe(5);
    expect(zoneTemp(runtime, 'room-a')).toBeLessThan(20); // envelope leak-in
  });

  function classroomScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-occupancy', name: 'Runtime Occupancy' },
      zones: [
        {
          id: 'classroom',
          bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 },
          occupancy: 0,
          baseline: { temperature: 24, co2: 450 },
        },
      ],
      devices: [],
      agents: [],
      events: [
        // Class schedule: 40 students at t=10s, room empties at t=610s.
        { id: 'class-start', type: 'occupancy', zoneId: 'classroom', parameter: 'occupancy', value: 40, atSimTimeSec: 10 },
        { id: 'class-end', type: 'occupancy', zoneId: 'classroom', parameter: 'occupancy', value: 0, atSimTimeSec: 610 },
      ],
    });
  }

  it('scheduled occupancy drives CO2 + temperature up during class, then both fall back', async () => {
    const runtime = new EngineRuntime(classroomScenario());
    runtimes.push(runtime);

    const zone = () => runtime.getSnapshot().zones.find(z => z.id === 'classroom')!;
    expect(zone().occupancy).toBe(0);
    expect(zone().parameters.co2).toBe(450);

    // t=20s: the class-start schedule entry has fired.
    await runtime.step(20);
    expect(zone().occupancy).toBe(40);

    // t=600s: 40 people for ~10 minutes — CO2 and temperature accumulate.
    await runtime.step(580);
    const during = zone();
    expect(during.occupancy).toBe(40);
    expect(during.parameters.co2 as number).toBeGreaterThan(550);
    expect(during.parameters.temperature as number).toBeGreaterThan(24.5);
    const co2Peak = during.parameters.co2 as number;

    // t=920s: class ended at t=610s, occupancy cleared, sources removed…
    await runtime.step(320);
    const after = zone();
    expect(after.occupancy).toBe(0);
    // …and CO2 relaxes back toward the 450 ppm baseline.
    expect(after.parameters.co2 as number).toBeLessThan(co2Peak - 50);
  });

  it('setZoneOccupancy validates input and replaces (never stacks) effect sources', async () => {
    const runtime = new EngineRuntime(classroomScenario());
    runtimes.push(runtime);

    expect(() => runtime.setZoneOccupancy('nowhere', 5)).toThrow(/unknown zone/);
    expect(() => runtime.setZoneOccupancy('classroom', -1)).toThrow(/>= 0/);

    // Repeated updates: CO2 keeps accumulating smoothly (stacked duplicates
    // would multiply the rate and overshoot).
    runtime.setZoneOccupancy('classroom', 40);
    runtime.setZoneOccupancy('classroom', 40);
    runtime.setZoneOccupancy('classroom', 40);
    await runtime.step(60);
    const co2 = runtime.getSnapshot().zones.find(z => z.id === 'classroom')!.parameters.co2 as number;
    expect(co2).toBeGreaterThan(480);
    expect(co2).toBeLessThan(560); // ~+72 ppm gross minus relaxation, not 3×
    expect(runtime.getZoneOccupancy('classroom')).toBe(40);
  });

  // R98-occupancy-event-no-effect: a scheduled occupancy event declared
  // WITHOUT a value used to resolve to boolean `true`, get rejected by the
  // headcount guard, and have the rejection swallowed by the scheduler —
  // fired:true with zero world change and zero trace.
  function rushScenario(event: Record<string, unknown>) {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-rush', name: 'Runtime Rush' },
      zones: [
        { id: 'lab-101', baseline: { temperature: 25, co2: 550 } },
        { id: 'office-201', baseline: { temperature: 25 } },
      ],
      devices: [],
      agents: [],
      events: [event as never],
    });
  }

  it('a bare occupancy event (no value) applies the default headcount and the snapshot records the effect', async () => {
    const runtime = new EngineRuntime(rushScenario(
      { id: 'ev-morning-rush', type: 'occupancy', zoneId: 'lab-101', atSimTimeSec: 10 },
    ));
    runtimes.push(runtime);

    // Zones that never declared occupancy still EXPOSE the field (0) —
    // "no field" and "no change" must be distinguishable.
    const zone = () => runtime.getSnapshot().zones.find(z => z.id === 'lab-101')!;
    expect(zone().occupancy).toBe(0);

    await runtime.step(15);

    expect(zone().occupancy).toBe(1); // default headcount, not boolean true
    expect(runtime.getZoneOccupancy('lab-101')).toBe(1);
    // Untargeted zones stay at 0 (and still expose the field).
    expect(runtime.getSnapshot().zones.find(z => z.id === 'office-201')!.occupancy).toBe(0);

    // The fired event carries its trace: when it fired and what it wrote.
    const entry = runtime.getSnapshot().scheduledEvents.find(e => e.id === 'ev-morning-rush')!;
    expect(entry.fired).toBe(true);
    expect(entry.firedAtSimTimeSec).toBeGreaterThanOrEqual(10);
    expect(entry.effect).toEqual({ parameter: 'occupancy', value: 1 });
    expect(entry.error).toBeUndefined();
  });

  it('a rejected scheduled event records its error — fired:true without a trace is no longer possible', async () => {
    const runtime = new EngineRuntime(rushScenario(
      { id: 'ev-bad', type: 'occupancy', zoneId: 'lab-101', value: 'many', atSimTimeSec: 10 },
    ));
    runtimes.push(runtime);

    await runtime.step(15);

    // The world is honestly unchanged…
    expect(runtime.getSnapshot().zones.find(z => z.id === 'lab-101')!.occupancy).toBe(0);
    // …and the event entry SAYS why instead of silently swallowing it.
    const entry = runtime.getSnapshot().scheduledEvents.find(e => e.id === 'ev-bad')!;
    expect(entry.fired).toBe(true);
    expect(entry.firedAtSimTimeSec).toBeGreaterThanOrEqual(10);
    expect(entry.effect).toBeUndefined();
    expect(entry.error).toMatch(/not numeric/);
  });
});

// ---------------------------------------------------------------------------
// R98-noon-heat-freezes-building (chen-03): a scheduled temperature event on
// a BOUNDS-LESS zone resolved boolean true (no declared value) and wrote it
// through the LEGACY GLOBAL path — every zone read 1 °C from a pinned
// constant model (min=max=1), forever. Zones below deliberately have no
// bounds, mirroring the simtest-r1「AIoT 创新实验楼」environment.
// ---------------------------------------------------------------------------

describe('EngineRuntime — R98 noon heat (bounds-less zones, chen-03)', () => {
  function noonHeatScenario(extraEvents: Array<Record<string, unknown>> = []) {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-noon-heat', name: 'Runtime Noon Heat' },
      zones: [
        { id: 'lab-101', baseline: { temperature: 25, co2: 550 } },
        { id: 'office-201', baseline: { temperature: 25, co2: 520 } },
        // Outdoor declares its own baseline; untouched zones read their OWN
        // seeds (R99 per-zone field seeding — no global last-write-wins).
        { id: 'outdoor', type: 'outdoor', baseline: { temperature: 30 } },
      ],
      devices: [],
      agents: [],
      events: [
        { id: 'ev-noon-heat', type: 'temperature', zoneId: 'office-201', atSimTimeSec: 10 },
        ...(extraEvents as never[]),
      ],
    });
  }

  const zoneTemp = (runtime: EngineRuntime, id: string) =>
    runtime.getSnapshot().zones.find(z => z.id === id)?.parameters.temperature as number;

  it('a bare temperature event HEATS its zone (right direction), never freezes the building, and the heat relaxes back', async () => {
    const runtime = new EngineRuntime(noonHeatScenario());
    runtimes.push(runtime);

    await runtime.step(15);

    // Direction + magnitude: 32 (the bare-type default), not 1 °C — a few
    // ticks of relaxation have already started by the time we read.
    expect(zoneTemp(runtime, 'office-201')).toBeGreaterThan(31.5);
    expect(zoneTemp(runtime, 'office-201')).toBeLessThanOrEqual(32);
    // Zone-scoped: the rest of the building is untouched (the old global
    // write pinned EVERY zone at the value). Untouched zones read their OWN
    // seeded baseline (R99: per-zone field seeding — no more collapse onto
    // the last zone's value).
    expect(zoneTemp(runtime, 'lab-101')).toBe(25);
    expect(zoneTemp(runtime, 'outdoor')).toBe(30);
    // The event carries its trace (observability from the R98 occupancy fix).
    const entry = runtime.getSnapshot().scheduledEvents.find(e => e.id === 'ev-noon-heat')!;
    expect(entry.fired).toBe(true);
    expect(entry.effect).toEqual({ parameter: 'temperature', value: 32 });

    // Relaxation, not a freeze: the heat decays back toward the 25 baseline
    // (τ ≈ 2500 s at the legacy temperature rate — slow but moving).
    await runtime.step(600);
    const warmed = zoneTemp(runtime, 'office-201');
    expect(warmed).toBeLessThan(31.5);
    expect(warmed).toBeGreaterThan(29);

    await runtime.step(3600);
    expect(zoneTemp(runtime, 'office-201')).toBeLessThan(28); // clearly recovering
  });

  it('a boolean resolved for a numeric parameter is REJECTED with a teaching error — manual and scheduled', async () => {
    const runtime = new EngineRuntime(noonHeatScenario([
      { id: 'ev-bad-power', type: 'mystery', zoneId: 'office-201', parameter: 'power', atSimTimeSec: 10 },
    ]));
    runtimes.push(runtime);

    await expect(
      runtime.injectEvent({ type: 'temperature', zoneId: 'office-201', parameter: 'co2', value: true }),
    ).rejects.toThrow(/boolean value true for numeric parameter "co2"/);

    await runtime.step(15);
    // The scheduled misdeclaration is recorded ON the event — no silent
    // swallow, no world corruption.
    const entry = runtime.getSnapshot().scheduledEvents.find(e => e.id === 'ev-bad-power')!;
    expect(entry.fired).toBe(true);
    expect(entry.effect).toBeUndefined();
    expect(entry.error).toMatch(/numeric parameter "power"/);
    // …and the good event from the shared scenario still landed fine.
    expect(zoneTemp(runtime, 'office-201')).toBeGreaterThan(31.5);
    expect(zoneTemp(runtime, 'office-201')).toBeLessThanOrEqual(32);
  });

  it('event values clamp to physical possibility only — comfort-band breaches are legitimate disturbances', async () => {
    const runtime = new EngineRuntime(noonHeatScenario());
    runtimes.push(runtime);

    // 45 °C is outside the comfort band but physically meaningful (a fire
    // drill, a heat wave): applied verbatim, and it relaxes back.
    await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'office-201', value: 45 });
    expect(zoneTemp(runtime, 'office-201')).toBe(45);
    await runtime.step(600);
    expect(zoneTemp(runtime, 'office-201')).toBeLessThan(45);

    // A physically impossible write is clamped by the field's safety net.
    await runtime.injectEvent({ type: 'temperature-spike', zoneId: 'office-201', value: 500 });
    expect(zoneTemp(runtime, 'office-201')).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// R99-smoke-never-clears (chen-08): a scheduled smoke event on a BOUNDS-LESS
// zone took the legacy GLOBAL boolean write — smoke=1 for every zone
// (outdoor plaza included), pinned forever (64 sim-days observed). Boolean
// field flags (smoke/motion) now take the per-zone field write and relax
// back; zone baselines seed the field per-zone (no cross-zone collapse).
// ---------------------------------------------------------------------------

describe('EngineRuntime — R99 smoke clears (bounds-less zones, chen-08)', () => {
  function smokeScenario() {
    return loadScenarioFile({
      version: '1.0',
      meta: { id: 'runtime-smoke', name: 'Runtime Smoke' },
      zones: [
        { id: 'lab-101', baseline: { temperature: 25, co2: 550 } },
        { id: 'lab-102', baseline: { temperature: 25, co2: 550 } },
        { id: 'meeting-202', baseline: { temperature: 25, co2: 540 } },
        { id: 'outdoor', type: 'outdoor', baseline: { temperature: 30, co2: 420 } },
      ],
      devices: [],
      agents: [],
      events: [
        { id: 'ev-night-smoke', type: 'smoke', zoneId: 'lab-102', atSimTimeSec: 10 },
        { id: 'ev-co2-spike', type: 'air-quality', zoneId: 'meeting-202', atSimTimeSec: 10 },
      ],
    });
  }

  const zoneParam = (runtime: EngineRuntime, id: string, param: string) =>
    runtime.getSnapshot().zones.find(z => z.id === id)?.parameters[param] as number;

  it('smoke stains ONLY its zone and clears with the field relaxation — outdoor never polluted', async () => {
    const runtime = new EngineRuntime(smokeScenario());
    runtimes.push(runtime);

    await runtime.step(15);
    // The flag landed in lab-102 (1, a few ticks into its decay)…
    expect(zoneParam(runtime, 'lab-102', 'smoke')).toBeGreaterThan(0.5);
    // …and nowhere else — the legacy global write put smoke=1 in ALL 8
    // zones including the outdoor plaza.
    expect(zoneParam(runtime, 'lab-101', 'smoke')).toBe(0);
    expect(zoneParam(runtime, 'meeting-202', 'smoke')).toBe(0);
    expect(zoneParam(runtime, 'outdoor', 'smoke')).toBe(0);

    // Gradual clearing (field smoke relaxation, τ ≈ 100 s), not an instant
    // wipe and not a permanent stain.
    await runtime.step(60);
    const fading = zoneParam(runtime, 'lab-102', 'smoke');
    expect(fading).toBeLessThan(0.6);
    expect(fading).toBeGreaterThan(0.1);

    await runtime.step(600);
    expect(zoneParam(runtime, 'lab-102', 'smoke')).toBeLessThan(0.05);
    expect(zoneParam(runtime, 'outdoor', 'smoke')).toBe(0);
  });

  it('co2 decays from the event peak to the zone\'s OWN baseline — no mid-way freeze, no collapse to other zones', async () => {
    const runtime = new EngineRuntime(smokeScenario());
    runtimes.push(runtime);

    // Untouched zones hold their OWN seeded baselines (the legacy collapse
    // showed every zone the same value).
    expect(zoneParam(runtime, 'lab-101', 'co2')).toBe(550);
    expect(zoneParam(runtime, 'outdoor', 'co2')).toBe(420);

    await runtime.step(15);
    expect(zoneParam(runtime, 'meeting-202', 'co2')).toBeGreaterThan(1000); // near the 1500 peak

    await runtime.step(300);
    const decaying = zoneParam(runtime, 'meeting-202', 'co2');
    expect(decaying).toBeLessThan(900);
    expect(decaying).toBeGreaterThan(600); // still falling — not frozen

    await runtime.step(1200);
    // The attractor is meeting-202's DECLARED baseline 540 (its neighbors
    // differ: 550/420 — the decay must not collapse onto them).
    const settled = zoneParam(runtime, 'meeting-202', 'co2');
    expect(settled).toBeLessThan(560);
    expect(settled).toBeGreaterThanOrEqual(538);
    expect(zoneParam(runtime, 'lab-101', 'co2')).toBe(550);
  });

  it('a motion flag event is zone-scoped and clears too', async () => {
    const runtime = new EngineRuntime(smokeScenario());
    runtimes.push(runtime);

    await runtime.injectEvent({ type: 'motion-detected', zoneId: 'lab-101' });
    expect(zoneParam(runtime, 'lab-101', 'motion')).toBe(1);
    expect(zoneParam(runtime, 'lab-102', 'motion')).toBe(0);
    expect(zoneParam(runtime, 'outdoor', 'motion')).toBe(0);

    await runtime.step(1200);
    expect(zoneParam(runtime, 'lab-101', 'motion')).toBeLessThan(0.01);
  });
});
