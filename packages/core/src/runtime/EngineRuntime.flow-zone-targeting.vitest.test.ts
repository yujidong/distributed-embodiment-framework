/**
 * @vitest-environment node
 *
 * Campus-pilot P0 regression (2026-08-18): a zone-triggered flow must
 * actuate a device IN the trigger zone.
 *
 * Incident: 132-zone campus, one building-manager agent bound to 40+
 * classroom HVACs. The condition flow "tb1-classroom-f0-1 temperature > 30
 * → cooling" fired and recorded 'success', but the run actuated
 * tb1-classroom-f0-8's AC (the first capability match in resource order)
 * while the overheated room climbed 38 → 43 °C for 8 sim hours.
 *
 * Two gaps are pinned here:
 *   1. Assignment/invocation were zone-blind. Now: zone-triggered runs
 *      prefer zone-serving assignees and in-zone devices, and REFUSE
 *      cross-zone actuation when the assignee has no in-zone device
 *      (explicit failure instead of a silent wrong-room 'success').
 *   2. A `handle_independently` decision outside rule-only mode issues no
 *      commands by design, but the record gave no hint (silent null). The
 *      recorded reasoning now carries an explicit `[actuation: none …]`
 *      note; rule-only zero-command plans say why as well.
 *
 * Every runtime is stop()ed after each test.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile } from '../scenario/index.js';
import type { FlowDefinition, FlowRunRecord } from '../flows/index.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const HVAC_CAPS = ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'];

/**
 * One manager agent bound to two HVACs in two zones — hvac-b listed FIRST,
 * so the pre-fix invoker (first capability match wins) actuated zone-b's
 * device for a zone-a trigger.
 */
function oneAgentTwoZones() {
  return {
    version: '1.0' as const,
    meta: { id: 'flow-zone-targeting', name: 'Flow Zone Targeting' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      { id: 'hvac-b', type: 'hvac', capabilities: HVAC_CAPS, zoneId: 'zone-b' },
      { id: 'hvac-a', type: 'hvac', capabilities: HVAC_CAPS, zoneId: 'zone-a' },
    ],
    agents: [
      {
        id: 'manager', name: 'Building Manager',
        capabilities: ['temperature-monitoring', 'temperature-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['hvac-b', 'hvac-a'],
      },
    ],
    events: [],
  };
}

/**
 * Two agents: the zone-b manager sorts FIRST in scenario order but cannot
 * serve zone-a; assignment must prefer the zone-serving agent.
 */
function twoAgents() {
  const json = oneAgentTwoZones();
  return {
    ...json,
    agents: [
      {
        id: 'zone-b-manager', name: 'Zone B Manager',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b'],
      },
      {
        id: 'zone-a-manager', name: 'Zone A Manager',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
      },
    ],
  };
}

/** The only cooling device lives in zone-b; the flow triggers on zone-a. */
function noInZoneDevice() {
  const json = oneAgentTwoZones();
  return {
    ...json,
    devices: [{ id: 'hvac-b', type: 'hvac', capabilities: HVAC_CAPS, zoneId: 'zone-b' }],
    agents: [
      {
        id: 'manager', name: 'Building Manager',
        capabilities: ['temperature-monitoring', 'temperature-control'],
        managesZoneIds: ['zone-a', 'zone-b'], boundDeviceIds: ['hvac-b'],
      },
    ],
  };
}

function overheatFlow(): FlowDefinition {
  return {
    id: 'flow-cool-zone-a',
    name: 'Cool zone A on overheat',
    enabled: true,
    trigger: {
      kind: 'condition',
      zoneId: 'zone-a',
      conditions: [{ path: 'temperature', op: '>', value: 30 }],
    },
    plan: { goal: 'Cool zone A', nodes: [{ id: 'cool', capability: 'cooling', params: { targetTemperature: 26 } }] },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const runtimes: EngineRuntime[] = [];

function makeRuntime(
  scenarioJSON: Record<string, unknown>,
  options?: EngineRuntimeOptions,
): { runtime: EngineRuntime; flowRuns: FlowRunRecord[] } {
  const flowRuns: FlowRunRecord[] = [];
  const runtime = new EngineRuntime(loadScenarioFile(scenarioJSON), options);
  runtime.onFlowRun(record => flowRuns.push(record));
  runtimes.push(runtime);
  return { runtime, flowRuns };
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

/** Minimal structural LLM stub — precheck decisions never reach it. */
class MockLLMClient {
  setLoggingCallback(): void { /* no-op */ }
  setContextProvider(): void { /* no-op */ }
  getProviderName(): string { return 'mock'; }
  async healthCheck(): Promise<boolean> { return true; }
  async quickChat(): Promise<never> { throw new Error('precheck must not call the LLM'); }
}

// ---------------------------------------------------------------------------
// Zone-targeted actuation
// ---------------------------------------------------------------------------

describe('EngineRuntime — flow actuation targets the trigger zone (campus-pilot P0)', () => {
  it('cools the overheated zone’s own HVAC, not the first match in another zone', async () => {
    const { runtime, flowRuns } = makeRuntime(oneAgentTwoZones(), {
      flowsProvider: () => [overheatFlow()],
    });

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });
    await runtime.step(1); // condition edge → fire

    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].status).toBe('success');

    const devices = runtime.getSnapshot().devices;
    const hvacA = devices.find(d => d.id === 'hvac-a');
    const hvacB = devices.find(d => d.id === 'hvac-b');
    // The trigger zone's AC got the cooling chain …
    expect(hvacA?.state.power).toBe(true);
    expect(hvacA?.state.mode).toBe('cooling');
    // … and the other zone's AC was NOT touched (pre-fix behavior: hvac-b
    // was actuated while zone-a kept heating).
    expect(hvacB?.state.power).not.toBe(true);
  });

  it('prefers the zone-serving assignee over the first capable agent in scenario order', async () => {
    const { runtime, flowRuns } = makeRuntime(twoAgents(), {
      flowsProvider: () => [overheatFlow()],
    });

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });
    await runtime.step(1);

    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].status).toBe('success');
    const devices = runtime.getSnapshot().devices;
    expect(devices.find(d => d.id === 'hvac-a')?.state.power).toBe(true);
    expect(devices.find(d => d.id === 'hvac-b')?.state.power).not.toBe(true);
  });

  it('fails loudly instead of actuating another zone when the assignee has no in-zone device', async () => {
    const { runtime, flowRuns } = makeRuntime(noInZoneDevice(), {
      flowsProvider: () => [overheatFlow()],
    });

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });
    await runtime.step(1);

    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].status).toBe('failed');
    expect(flowRuns[0].nodeResults.cool.status).toBe('failed');
    expect(flowRuns[0].nodeResults.cool.error).toContain("in trigger zone 'zone-a'");
    // The wrong zone's AC stays off — no more silent cross-zone 'success'.
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-b')?.state.power).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision-without-actuation visibility
// ---------------------------------------------------------------------------

describe('EngineRuntime — handle_independently actuation visibility', () => {
  it('T-204: LLM-mode precheck decisions now actuate the in-zone device too', async () => {
    // FF-F06: in LLM mode the precheck used to short-circuit events the
    // agent could handle with an advisory "issues no device command" note —
    // LLM agents NEVER actuated their own devices. With autoActuateIndependent
    // (default ON), the same decision drives the agent's own in-zone HVAC.
    const { runtime } = makeRuntime(oneAgentTwoZones(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
    });

    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'manager');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('handle_independently');
    expect(decision!.decisionSource).toBe('precheck');
    // The decision acted: the in-zone HVAC is on, no "none" note.
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.power).toBe(true);
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-b')?.state.power).not.toBe(true);
    expect(decision!.reasoning ?? '').not.toContain('[actuation: none');
  });

  it('T-204: decision-only evaluation (autoInitiateAC=false) records but does not actuate', async () => {
    const { runtime } = makeRuntime(oneAgentTwoZones(), {
      llmClient: new MockLLMClient() as unknown as LLMClient,
      autoInitiateAC: false,
    });

    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'manager');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('handle_independently');
    // No silent null: the record explains the missing commands.
    expect(decision!.reasoning).toContain('[actuation: none');
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.power).not.toBe(true);
  });

  it('rule-only decisions with a zero-command plan record the skip reason', async () => {
    const { runtime } = makeRuntime(oneAgentTwoZones());

    // Occupancy is not a temperature-class event: the rule planner produces
    // zero commands even in rule-only mode.
    const result = await runtime.injectEvent({
      type: 'occupancy', zoneId: 'zone-a', parameter: 'occupancy', value: 40,
    });

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'manager');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('handle_independently');
    expect(decision!.reasoning).toContain('[actuation: none');
    expect(decision!.reasoning).toContain('not temperature-class');
  });

  it('rule-only temperature events still actuate the in-zone HVAC (regression guard)', async () => {
    const { runtime } = makeRuntime(oneAgentTwoZones());

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    const devices = runtime.getSnapshot().devices;
    expect(devices.find(d => d.id === 'hvac-a')?.state.power).toBe(true);
    expect(devices.find(d => d.id === 'hvac-b')?.state.power).not.toBe(true);
    // A decision that DID actuate carries no "none" note.
    const decision = runtime.getSnapshot().recentDecisions.find(d => d.agentId === 'manager');
    expect(decision?.reasoning ?? '').not.toContain('[actuation: none');
  });

  // -------------------------------------------------------------------------
  // T-050 (R11 corrective) — actuation option plumbing + shadow semantics.
  // The toggles resolve as sim option > scenario agent decisionPolicy >
  // default true; acMode 'shadow' is observe/record only.
  // -------------------------------------------------------------------------

  it('T-050: sim option autoActuateIndependent=false → decision recorded, no actuation', async () => {
    const { runtime } = makeRuntime(oneAgentTwoZones(), {
      autoActuateIndependent: false,
    });

    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'manager');
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('handle_independently');
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.power).not.toBe(true);
    // No silent null: the record explains the gate that blocked commands.
    expect(decision!.reasoning).toContain('[actuation: none');
    expect(decision!.reasoning).toContain('autoActuateIndependent=false');
  });

  it('T-050: scenario agent decisionPolicy.autoActuateIndependent=false → no actuation', async () => {
    const scenario = oneAgentTwoZones();
    (scenario.agents as Array<Record<string, unknown>>)[0].decisionPolicy = {
      autoActuateIndependent: false,
    };
    const { runtime } = makeRuntime(scenario);

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.power).not.toBe(true);
  });

  it('T-050: the sim option OVERRIDES the scenario decisionPolicy (operator wins)', async () => {
    const scenario = oneAgentTwoZones();
    (scenario.agents as Array<Record<string, unknown>>)[0].decisionPolicy = {
      autoActuateIndependent: false,
    };
    const { runtime } = makeRuntime(scenario, {
      autoActuateIndependent: true,
    });

    await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.power).toBe(true);
  });

  it('T-050: acMode shadow records decisions but never actuates devices', async () => {
    const { runtime } = makeRuntime(oneAgentTwoZones(), {
      acMode: 'shadow',
    });

    const result = await runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'manager');
    expect(decision).toBeDefined();
    // The decision is still recorded…
    expect(decision!.decision).toBe('handle_independently');
    // …but shadow = observe/record only: no physics mutation, and the
    // record says which gate suppressed the commands.
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-a')?.state.power).not.toBe(true);
    expect(runtime.getSnapshot().devices.find(d => d.id === 'hvac-b')?.state.power).not.toBe(true);
    expect(decision!.reasoning).toContain('[actuation: none');
    expect(decision!.reasoning).toContain('shadow');
  });
});

// ---------------------------------------------------------------------------
// T-302 (DevLoop R12, EO-F03) — the shadow promise is ABSOLUTE: it covers the
// FLOW lane too. A shadow sim with enabled flows never executes them (no run
// records, no device writes — and no fabricated would-have-run records);
// enabled/advisory sims run flows exactly as before. The no-actuation note
// names the OPERATIVE gate instead of a 4-way disjunction (EO-F09).
// ---------------------------------------------------------------------------

function eventFlow(): FlowDefinition {
  return {
    id: 'flow-emergency-light',
    name: 'Emergency light on motion',
    enabled: true,
    trigger: {
      kind: 'event',
      eventType: 'motion-detected',
      zoneId: 'zone-a',
    },
    plan: {
      goal: 'Light zone A',
      nodes: [{ id: 'light', capability: 'lighting-control', params: { brightness: 100 } }],
    },
  };
}

function motionScenario() {
  return {
    version: '1.0' as const,
    meta: { id: 'flow-shadow-suppression', name: 'Flow Shadow Suppression' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'lamp-a', type: 'smart-lamp',
        capabilities: ['lighting-control', 'turn-on', 'turn-off'], zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'manager', name: 'Building Manager',
        capabilities: ['lighting-control'],
        managesZoneIds: ['zone-a', 'zone-b'],
        boundDeviceIds: ['lamp-a'],
      },
    ],
    events: [],
  };
}

describe('EngineRuntime — acMode shadow suppresses FLOW actuation (T-302)', () => {
  it('shadow sim: enabled event flow + injection → zero flow runs, zero device writes', async () => {
    const { runtime, flowRuns } = makeRuntime(motionScenario(), {
      acMode: 'shadow',
      flowsProvider: () => [eventFlow()],
    });

    await runtime.injectEvent({
      type: 'motion-detected', zoneId: 'zone-a', parameter: 'motion', value: 1,
    });
    await runtime.step(1);

    // Flows simply never fire — no run ledger entries (and no fabricated
    // would-have-run records), no device-state mutation.
    expect(flowRuns).toHaveLength(0);
    const lamp = runtime.getSnapshot().devices.find(d => d.id === 'lamp-a');
    expect(lamp?.state.power).not.toBe(true);
    expect(lamp?.state.brightness).toBeUndefined();
    // The flow engine is not even assembled in shadow mode.
    expect(runtime.getFlowEngine()).toBeNull();
  });

  it('control (enabled): the same flow + injection runs and actuates', async () => {
    const { runtime, flowRuns } = makeRuntime(motionScenario(), {
      flowsProvider: () => [eventFlow()],
    });

    await runtime.injectEvent({
      type: 'motion-detected', zoneId: 'zone-a', parameter: 'motion', value: 1,
    });
    await runtime.step(1);

    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].status).toBe('success');
    const lamp = runtime.getSnapshot().devices.find(d => d.id === 'lamp-a');
    expect(lamp?.state.power).toBe(true);
  });

  it('T-302 note specificity: each suppressing gate names only itself', async () => {
    // acMode=shadow → the shadow branch, not the disjunction.
    const shadow = makeRuntime(oneAgentTwoZones(), { acMode: 'shadow' });
    const shadowResult = await shadow.runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });
    const shadowDecision = shadow.runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === shadowResult.eventId && d.agentId === 'manager')!;
    expect(shadowDecision.reasoning).toContain('[actuation: none');
    expect(shadowDecision.reasoning).toContain('acMode=shadow');
    expect(shadowDecision.reasoning).not.toContain('autoActuateIndependent');
    expect(shadowDecision.reasoning).not.toContain('no command executor');

    // autoActuateIndependent=false → its own branch.
    const optOut = makeRuntime(oneAgentTwoZones(), { autoActuateIndependent: false });
    const optOutResult = await optOut.runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });
    const optOutDecision = optOut.runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === optOutResult.eventId && d.agentId === 'manager')!;
    expect(optOutDecision.reasoning).toContain('[actuation: none');
    expect(optOutDecision.reasoning).toContain('autoActuateIndependent=false');
    expect(optOutDecision.reasoning).not.toContain('shadow');

    // decision-only evaluation (autoInitiateAC=false) → its own branch.
    const decisionOnly = makeRuntime(oneAgentTwoZones(), { autoInitiateAC: false });
    const decisionOnlyResult = await decisionOnly.runtime.injectEvent({
      type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 38,
    });
    const decisionOnlyDecision = decisionOnly.runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === decisionOnlyResult.eventId && d.agentId === 'manager')!;
    expect(decisionOnlyDecision.reasoning).toContain('[actuation: none');
    expect(decisionOnlyDecision.reasoning).toContain('decision-only evaluation');
  });
});
