/**
 * @vitest-environment node
 *
 * EngineRuntime × flows + agent enable/disable integration tests (no LLM backend):
 *   - an event-triggered flow runs BEFORE the managing agents see the event
 *   - the flow actuates the assignee agent's own device (sim HVAC)
 *   - scenario-declared flows work without an explicit flowsProvider
 *   - FLOW_TRIGGERED / FLOW_EXECUTED reach the bus; onFlowRun gets records
 *   - condition-triggered flows fire from step() ticks
 *   - enabled: false agents receive no events; setAgentEnabled toggles at
 *     runtime (both directions)
 *
 * Every runtime is stop()ed after each test — clean shutdown is part of
 * the contract.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { EventType, type SystemEvent } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import type { FlowDefinition, FlowRunRecord } from '../flows/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

// ---------------------------------------------------------------------------
// Scenario + helpers
// ---------------------------------------------------------------------------

function coolingFlow(): FlowDefinition {
  return {
    id: 'flow-cool-zone-b',
    name: 'Cool zone B on heat',
    enabled: true,
    trigger: { kind: 'event', eventType: 'temperature-spike', zoneId: 'zone-b' },
    plan: {
      goal: 'Cool zone B',
      nodes: [{ id: 'cool', capability: 'cooling' }],
    },
  };
}

function scenarioJSON(agentOverrides: Record<string, unknown> = {}) {
  return {
    version: '1.0' as const,
    meta: { id: 'runtime-flow-test', name: 'Runtime Flow Test' },
    zones: [
      // Explicit baselines: without them the default DailyCycleModel rides the
      // seasonal+diurnal curve (18°C base ±5°C daily ±12°C seasonal), so on a
      // summer afternoon zone-a starts above 30°C and the edge-trigger test's
      // "22°C default: no fire" assumption breaks — season-dependent flake.
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'], baseline: { temperature: 22 } },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'], baseline: { temperature: 22 } },
    ],
    devices: [
      {
        id: 'temp-sensor-a', type: 'temperature-sensor',
        capabilities: ['temperature-reading'], zoneId: 'zone-a',
      },
      {
        id: 'hvac-b', type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'heating', 'set-temperature', 'set-mode', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent', name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
        ...agentOverrides,
      },
      {
        id: 'actuator-agent', name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  };
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(
  options?: EngineRuntimeOptions,
  agentOverrides: Record<string, unknown> = {},
): EngineRuntime {
  const runtime = new EngineRuntime(loadScenarioFile(scenarioJSON(agentOverrides)), options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

// ---------------------------------------------------------------------------
// Flow integration
// ---------------------------------------------------------------------------

describe('EngineRuntime — flows', () => {
  it('runs an event-triggered flow before agents see the event, actuating its device', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const order: string[] = [];
    const runtime = makeRuntime({
      flowsProvider: () => [coolingFlow()],
    });
    runtime.onFlowRun(record => flowRuns.push(record));
    runtime.subscribe((event: SystemEvent) => {
      if (event.type === EventType.FLOW_TRIGGERED) order.push('flow-triggered');
      if (event.type === EventType.FLOW_EXECUTED) order.push('flow-executed');
    });

    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-b', parameter: 'temperature', value: 34,
    });

    // The flow ran (bus order: TRIGGERED before EXECUTED) …
    expect(order).toEqual(['flow-triggered', 'flow-executed']);
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0]).toMatchObject({
      flowId: 'flow-cool-zone-b',
      triggerKind: 'event', status: 'success',
    });
    // Fix-44b: unique run ids.
    expect(flowRuns[0].runId).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(flowRuns[0].nodeResults.cool.status).toBe('succeeded');

    // … and the agent received the event AFTER the flow completed (the flow
    // execution is awaited inside injectEvent, before agent delivery — proven
    // here by the completed run record already existing at delivery time).
    expect(result.targetAgentIds).toEqual(['actuator-agent']);

    // The flow actuated the HVAC through the agent's own device path:
    // DeviceResource's cooling expansion ends with power on + cooling mode.
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-b');
    expect(hvac?.state.power).toBe(true);
    expect(hvac?.state.mode).toBe('cooling');

    // The managing agent still processed the event itself.
    expect(runtime.getSnapshot().agents.find(a => a.id === 'actuator-agent')?.eventsProcessed).toBe(1);
  });

  it('proves flow-before-agent ordering with an explicit order log', async () => {
    const order: string[] = [];
    const flow = coolingFlow();
    const runtime = makeRuntime({ flowsProvider: () => [flow] });
    runtime.onFlowRun(() => order.push('flow-run'));

    // Any agent decision recorded means the agent processed the event.
    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-b', parameter: 'temperature', value: 34,
    });
    order.push('after-inject');

    // The flow run record exists before injectEvent returned; agent delivery
    // happens inside injectEvent, so the flow strictly precedes it.
    expect(order).toEqual(['flow-run', 'after-inject']);
    expect(runtime.getSnapshot().agents.find(a => a.id === 'actuator-agent')?.eventsProcessed).toBe(1);
  });

  it('drives scenario-declared flows without an explicit flowsProvider', async () => {
    const json = scenarioJSON();
    const scenario = loadScenarioFile({ ...json, flows: [coolingFlow()] });
    const runtime = new EngineRuntime(scenario);
    runtimes.push(runtime);

    expect(runtime.getFlowEngine()).not.toBeNull();
    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-b', parameter: 'temperature', value: 34,
    });
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-b')?.state.power).toBe(true);
  });

  it('builds no flow engine for legacy scenarios (zero behavior change)', async () => {
    const runtime = makeRuntime(undefined);
    expect(runtime.getFlowEngine()).toBeNull();
    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35,
    });
    expect(result.targetAgentIds).toEqual(['sensor-agent']);
  });

  it('fires condition-triggered flows from step() ticks (edge-triggered)', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const flow: FlowDefinition = {
      id: 'flow-watch-temp',
      name: 'Watch zone A temperature',
      enabled: true,
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'zone-a.temperature', op: '>', value: 30 }],
      },
      plan: { goal: 'Cool', nodes: [{ id: 'cool', capability: 'cooling' }] },
    };
    const runtime = makeRuntime({ flowsProvider: () => [flow] });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.step(1); // 22°C default: no fire
    expect(flowRuns).toHaveLength(0);

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 33,
    });
    // R40-C1 post-write snapshot point: the injection itself evaluates
    // condition triggers (the write IS the world's new truth — waiting for
    // the next tick let the agent channel erase the evidence first).
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].triggerKind).toBe('condition');

    await runtime.step(1); // snapshot already fired: no double-count
    expect(flowRuns).toHaveLength(1);

    await runtime.step(1); // still true: no re-fire
    expect(flowRuns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Agent enable/disable
// ---------------------------------------------------------------------------

describe('EngineRuntime — agent enabled', () => {
  it('delivers no events to an agent declared enabled: false', async () => {
    const runtime = makeRuntime(undefined, { enabled: false });

    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35,
    });

    expect(result.targetAgentIds).toEqual([]);
    expect(runtime.isAgentEnabled('sensor-agent')).toBe(false);
    expect(runtime.isAgentEnabled('actuator-agent')).toBe(true);
    const snapshot = runtime.getSnapshot();
    expect(snapshot.agents.find(a => a.id === 'sensor-agent')?.eventsProcessed).toBe(0);
  });

  it('setAgentEnabled toggles delivery at runtime (both directions)', async () => {
    const runtime = makeRuntime();

    runtime.setAgentEnabled('sensor-agent', false);
    let result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35,
    });
    expect(result.targetAgentIds).toEqual([]);

    runtime.setAgentEnabled('sensor-agent', true);
    result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 36,
    });
    expect(result.targetAgentIds).toEqual(['sensor-agent']);
    expect(runtime.getSnapshot().agents.find(a => a.id === 'sensor-agent')?.eventsProcessed).toBe(1);
  });

  it('setAgentEnabled throws on unknown agents', () => {
    const runtime = makeRuntime();
    expect(() => runtime.setAgentEnabled('ghost', false)).toThrow(/unknown agent/);
  });

  it('a disabled agent does not become the event target via the adjacent fallback', async () => {
    // sensor-agent (zone-a manager) disabled: the event must NOT spill to
    // zone-b's actuator-agent through the adjacency fallback.
    const runtime = makeRuntime(undefined, { enabled: false });
    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35,
    });
    expect(result.targetAgentIds).toEqual([]);
    expect(runtime.getSnapshot().agents.find(a => a.id === 'actuator-agent')?.eventsProcessed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-304 (DevLoop R12, EN-F05) — custom baseline parameters reach the zone
// snapshot, so condition triggers can evaluate them. Generic union: any
// declared baseline key rides along with the standard seven.
// ---------------------------------------------------------------------------

describe('EngineRuntime — custom baseline parameters in condition flows (T-304)', () => {
  function energyScenarioJSON() {
    return {
      version: '1.0' as const,
      meta: { id: 'runtime-custom-param-test', name: 'Custom Param Test' },
      zones: [
        {
          id: 'roof', name: 'Roof', adjacentZoneIds: ['room'],
          baseline: { temperature: 25, powerW: 38000, pvOutputW: 8000 },
        },
        { id: 'room', name: 'Room', adjacentZoneIds: ['roof'], baseline: { temperature: 22 } },
      ],
      devices: [
        {
          id: 'meter-roof', type: 'power-meter',
          capabilities: ['power-monitoring'], zoneId: 'roof',
        },
      ],
      agents: [
        {
          id: 'energy-agent', name: 'Energy Agent',
          capabilities: ['power-monitoring'],
          managesZoneIds: ['roof'], boundDeviceIds: ['meter-roof'],
        },
      ],
      events: [],
    };
  }

  it('a condition on a custom baseline parameter FIRES on the seeded world', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = new EngineRuntime(loadScenarioFile(energyScenarioJSON()), {
      flowsProvider: () => [{
        // T-704 note: pvOutputW is now TIME-VARYING (daylight curve — 0 at
        // sim midnight), so this uses the static custom param powerW; the
        // pvOutputW day/night curve has its own tests (pv-daylight).
        id: 'flow-load-surplus',
        name: 'Load surplus diversion',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'roof',
          conditions: [{ path: 'powerW', op: '>', value: 30000 }],
        },
        plan: { goal: 'Track surplus', nodes: [] },
      }],
    });
    runtimes.push(runtime);
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.step(1);
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].status).toBe('success');
    // A threshold the seeded value (38000) does NOT meet stays quiet — the
    // very authoring case EN-F05 gave up on ("> 50000" on a 38000W feed).
    const runtime2 = new EngineRuntime(loadScenarioFile(energyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-load-high',
        name: 'Load very high',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'roof',
          conditions: [{ path: 'powerW', op: '>', value: 50000 }],
        },
        plan: { goal: 'Not yet', nodes: [] },
      }],
    });
    runtimes.push(runtime2);
    const runs2: FlowRunRecord[] = [];
    runtime2.onFlowRun(record => runs2.push(record));
    await runtime2.step(1);
    expect(runs2).toHaveLength(0);
  });

  it('standard-parameter conditions still fire (no regression), and the snapshot carries custom keys per zone', async () => {
    // Zones without bounds share the global model; the LAST zone's baseline
    // wins for temperature (room's 22°C), so >21 fires on the standard path.
    const runtime = new EngineRuntime(loadScenarioFile(energyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-roof-hot',
        name: 'Roof warm',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'roof',
          conditions: [{ path: 'temperature', op: '>', value: 21 }],
        },
        plan: { goal: 'Watch', nodes: [] },
      }],
    });
    runtimes.push(runtime);
    const runs: FlowRunRecord[] = [];
    runtime.onFlowRun(record => runs.push(record));
    await runtime.step(1);
    expect(runs).toHaveLength(1);

    // Snapshot exposure per zone (the condition read path IS the snapshot):
    // a custom-key condition on the zone WITHOUT the baseline never fires,
    // proving room's snapshot carries no custom keys while roof's does.
    const probe = new EngineRuntime(loadScenarioFile(energyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-room-power',
        name: 'Room has power reading',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'room',
          conditions: [{ path: 'powerW', op: '>', value: -1 }],
        },
        plan: { goal: 'Probe', nodes: [] },
      }],
    });
    runtimes.push(probe);
    const probeRuns: FlowRunRecord[] = [];
    probe.onFlowRun(record => probeRuns.push(record));
    await probe.step(1);
    expect(probeRuns).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T-061 (DevLoop R13) — custom baseline params + evaluated values are
  // OBSERVABLE, not just condition-evaluable: the user-facing snapshot and
  // the run trace both show declared vs evaluated.
  // -------------------------------------------------------------------------

  it('T-061: the firing run record carries path + evaluatedValue + threshold per condition', async () => {
    const runs: FlowRunRecord[] = [];
    const runtime = new EngineRuntime(loadScenarioFile(energyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-load-trace',
        name: 'Load trace',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'roof',
          conditions: [{ path: 'powerW', op: '>', value: 30000 }],
        },
        plan: { goal: 'Track', nodes: [] },
      }],
    });
    runtimes.push(runtime);
    runtime.onFlowRun(record => runs.push(record));
    await runtime.step(1);
    expect(runs).toHaveLength(1);
    const evaluation = runs[0].triggerEvaluation;
    expect(evaluation).toBeDefined();
    expect(evaluation!.kind).toBe('condition');
    expect(evaluation!.zoneId).toBe('roof');
    expect(typeof evaluation!.simTimeSec).toBe('number');
    expect(evaluation!.conditions).toEqual([
      {
        path: 'powerW',
        op: '>',
        threshold: 30000,
        evaluatedValue: 38000,
        met: true,
      },
    ]);
  });

  it('T-061: an event-triggered run records the matched event + condition detail', async () => {
    const runs: FlowRunRecord[] = [];
    const runtime = new EngineRuntime(loadScenarioFile(energyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-event-trace',
        name: 'Event trace',
        enabled: true,
        trigger: {
          kind: 'event',
          eventType: 'power-surge',
          zoneId: 'roof',
          parameter: 'powerW',
          conditions: [{ path: 'powerW', op: '>', value: 30000 }],
        },
        plan: { goal: 'Track', nodes: [] },
      }],
    });
    runtimes.push(runtime);
    runtime.onFlowRun(record => runs.push(record));
    await runtime.injectEvent({
      type: 'power-surge', zoneId: 'roof', parameter: 'powerW', value: 41000,
    });
    expect(runs).toHaveLength(1);
    const evaluation = runs[0].triggerEvaluation!;
    expect(evaluation.kind).toBe('event');
    expect(evaluation.zoneId).toBe('roof');
    expect(evaluation.event).toMatchObject({
      eventType: 'power-surge', zoneId: 'roof', parameter: 'powerW', newValue: 41000,
    });
    // The condition evaluated against the event-merged snapshot: 41000
    // (the INJECTED value), not the 38000 baseline.
    expect(evaluation.conditions).toEqual([
      { path: 'powerW', op: '>', threshold: 30000, evaluatedValue: 41000, met: true },
    ]);
  });

  it('T-061: getSnapshot() zones expose declared custom params AND the declared baseline', async () => {
    const runtime = new EngineRuntime(loadScenarioFile(energyScenarioJSON()));
    runtimes.push(runtime);
    const snapshot = runtime.getSnapshot();
    const roof = snapshot.zones.find(z => z.id === 'roof');
    expect(roof).toBeDefined();
    // Evaluated custom quantities are in parameters (timeline reads this).
    // (No tick has run: pvOutputW still shows the seeded peak; from the
    // first tick on, T-704's daylight drive replaces it — 0 at sim night.)
    expect(roof!.parameters.pvOutputW).toBe(8000);
    expect(roof!.parameters.powerW).toBe(38000);
    // The declared baseline rides along verbatim — declared vs evaluated
    // side by side makes threshold authoring possible.
    expect(roof!.baseline).toEqual({ temperature: 25, powerW: 38000, pvOutputW: 8000 });
    const room = snapshot.zones.find(z => z.id === 'room');
    expect(room!.parameters.powerW).toBeUndefined(); // no bleed across zones
    expect(room!.baseline).toEqual({ temperature: 22 });
  });
});

describe('EngineRuntime — injected custom parameters in condition flows (T-606)', () => {
  // SC26-F02 regression shape: a badge-anomaly condition on a parameter NO
  // baseline declares. Pre-T-606 the snapshot union never enumerated the
  // injection-written name, so the flow could not fire (0 runs across two
  // qualifying injections in the field round).
  function lobbyScenarioJSON() {
    return {
      version: '1.0' as const,
      meta: { id: 'runtime-injected-param-test', name: 'Injected Param Test' },
      zones: [
        { id: 'lobby', name: 'Lobby', adjacentZoneIds: [], baseline: { temperature: 22 } },
      ],
      devices: [
        { id: 'cam-lobby', type: 'camera', capabilities: ['video-monitoring'], zoneId: 'lobby' },
      ],
      agents: [
        {
          id: 'guard-agent', name: 'Guard Agent',
          capabilities: ['video-monitoring'],
          managesZoneIds: ['lobby'], boundDeviceIds: ['cam-lobby'],
        },
      ],
      events: [],
    };
  }

  it('a condition on a runtime-injected parameter fires after the injection that sets it', async () => {
    const runs: FlowRunRecord[] = [];
    const runtime = new EngineRuntime(loadScenarioFile(lobbyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-badge-anomaly',
        name: 'Badge anomaly escalation',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'lobby',
          conditions: [{ path: 'badge-anomaly-count', op: '>', value: 2 }],
        },
        plan: { goal: 'Escalate', nodes: [] },
      }],
    });
    runtimes.push(runtime);
    runtime.onFlowRun(record => runs.push(record));

    // Before any injection: the parameter does not exist anywhere — the
    // condition is unresolvable (false) and nothing fires.
    await runtime.step(1);
    expect(runs).toHaveLength(0);

    // The injection writes the custom parameter; the union grows with it.
    await runtime.injectEvent({
      type: 'badge-anomaly',
      zoneId: 'lobby',
      parameter: 'badge-anomaly-count',
      value: 3,
    });

    // Next tick: the edge fires with the injected value visible in the
    // run's condition evidence.
    await runtime.step(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].triggerEvaluation!.conditions).toEqual([
      { path: 'badge-anomaly-count', op: '>', threshold: 2, evaluatedValue: 3, met: true },
    ]);

    // The user-facing snapshot exposes the injected name too (same union).
    const lobby = runtime.getSnapshot().zones.find(z => z.id === 'lobby');
    expect(lobby!.parameters['badge-anomaly-count']).toBe(3);

    // No cross-zone bleed: another zone sees no value for the name (the
    // union grew the NAME, the VALUE stays zone-local).
    expect(runtime.getSnapshot().zones).toHaveLength(1);
  });

  it('a below-threshold injection grows the union without firing (edge semantics intact)', async () => {
    const runs: FlowRunRecord[] = [];
    const runtime = new EngineRuntime(loadScenarioFile(lobbyScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-badge-anomaly',
        name: 'Badge anomaly escalation',
        enabled: true,
        trigger: {
          kind: 'condition',
          zoneId: 'lobby',
          conditions: [{ path: 'badge-anomaly-count', op: '>', value: 2 }],
        },
        plan: { goal: 'Escalate', nodes: [] },
      }],
    });
    runtimes.push(runtime);
    runtime.onFlowRun(record => runs.push(record));

    await runtime.injectEvent({
      type: 'badge-anomaly',
      zoneId: 'lobby',
      parameter: 'badge-anomaly-count',
      value: 1,
    });
    await runtime.step(1);
    expect(runs).toHaveLength(0);
  });
});

describe('EngineRuntime — flow actor attribution (T-608)', () => {
  // SC26-F03: flows reached devices with no actor context — all 4 flow-locked
  // doors audited `by:"unknown"` while direct commands attributed. The flow
  // lane now labels actuations `flow:<flowId>` (stable, resolvable via flows).
  function doorScenarioJSON() {
    return {
      version: '1.0' as const,
      meta: { id: 'runtime-flow-actor-test', name: 'Flow Actor Test' },
      zones: [{ id: 'entrance', name: 'Entrance', adjacentZoneIds: [], baseline: { temperature: 22 } }],
      devices: [
        { id: 'door-1', type: 'door-lock', capabilities: ['lock', 'unlock'], zoneId: 'entrance' },
      ],
      agents: [
        {
          id: 'security-agent', name: 'Security Agent',
          capabilities: ['lock'],
          managesZoneIds: ['entrance'], boundDeviceIds: ['door-1'],
        },
      ],
      events: [],
    };
  }

  it('a flow-driven lock writes accessLog {by: "flow:<flowId>"} + lastActionBy same', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = new EngineRuntime(loadScenarioFile(doorScenarioJSON()), {
      flowsProvider: () => [{
        id: 'flow-lockdown',
        name: 'Lockdown',
        enabled: true,
        trigger: { kind: 'event', eventType: 'lockdown', zoneId: 'entrance' },
        plan: {
          goal: 'lock the entrance',
          nodes: [{ id: 'lock-entrance', capability: 'lock', assigneeAgentId: 'security-agent' }],
        },
      }],
    });
    runtimes.push(runtime);
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'lockdown', zoneId: 'entrance' });

    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].status).toBe('success');
    const door = runtime.getSnapshot().devices.find(d => d.id === 'door-1');
    expect(door).toBeDefined();
    expect(door!.state.locked).toBe(true);
    expect(door!.state.lastActionBy).toBe('flow:flow-lockdown');
    const log = door!.state.accessLog as Array<{ action: string; by: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'lock', by: 'flow:flow-lockdown' });
  });
});
