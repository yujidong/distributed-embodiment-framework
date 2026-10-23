/**
 * @vitest-environment node
 *
 * T-051(c) runtime/authoring parity: FlowEngine's run-time assignment pass
 * accepts the executability oracle (FlowEngineOptions.isExecutableCapability)
 * and its verdicts then match what the authoring validation
 * (server assertFlowValid) would 422 for. Pre-fix the runtime resolved
 * WITHOUT the oracle, so a declared-but-unexecutable capability (or an
 * ambiguity that only exists when non-executable devices count) passed the
 * runtime gate and died mid-run — or refused with a different diagnosis
 * than authoring produced for the same flow.
 *
 * The oracle is injected as a plain predicate (core cannot depend on the
 * simulation package that owns the real one); these tests only pin the
 * CONTRACT: with the oracle, resolution and refusal messages are the
 * authoring pass's own.
 */

import { describe, it, expect } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvoker } from '../../workflow/plan-executor.js';
import {
  FlowEngine,
  type FlowDefinition,
  type FlowRunRecord,
} from '../index.js';

/** Agent bound to two devices: 'sw' declares switch, 'fan' declares turn-on. */
function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'oracle-parity', name: 'Oracle Parity' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      { id: 'sw', type: 'light-switch', capabilities: ['switch'], zoneId: 'zone-a' },
      { id: 'fan', type: 'fan', capabilities: ['turn-on'], zoneId: 'zone-a' },
    ],
    agents: [
      {
        id: 'agent-a', name: 'Agent A',
        capabilities: ['switch', 'turn-on'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['sw', 'fan'],
      },
    ],
    events: [],
  });
}

async function runFlowOnce(
  flows: FlowDefinition[],
  isExecutableCapability?: (capabilityName: string) => boolean,
): Promise<FlowRunRecord[]> {
  const runs: FlowRunRecord[] = [];
  const invoker: PlanNodeInvoker = async () => ({ success: true, result: { ok: true } });
  const engine = new FlowEngine({
    scenario: scenario(),
    flowsProvider: () => flows,
    agents: new Map(),
    invoker,
    envStateReader: () => ({ 'zone-a': { temperature: 22 } }),
    publish: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
    ...(isExecutableCapability !== undefined ? { isExecutableCapability } : {}),
  });
  await engine.triggerManually(flows[0].id);
  return runs;
}

/** Oracle: only 'turn-on' (and read names) dispatch at run time. */
const oracle = (capabilityName: string): boolean => capabilityName === 'turn-on';

function flowFor(capability: string): FlowDefinition {
  return {
    id: 'flow-1',
    name: 'Parity flow',
    enabled: true,
    trigger: { kind: 'event', eventType: 'temperature-spike', zoneId: 'zone-a' },
    plan: {
      goal: 'actuate',
      nodes: [{ id: 'n1', capability, assigneeAgentId: 'agent-a' }],
    },
  };
}

describe('FlowEngine runtime oracle parity (T-051)', () => {
  it('without the oracle a declared-but-unexecutable capability RUNS (the legacy divergence)', async () => {
    const runs = await runFlowOnce([flowFor('switch')]);
    expect(runs).toHaveLength(1);
    // Legacy behavior: declared = executable → the run proceeds (and would
    // die in the invoker with a no-effect command).
    expect(runs[0].status).toBe('success');
  });

  it('with the oracle the same flow is refused with the authoring diagnosis', async () => {
    const runs = await runFlowOnce([flowFor('switch')], oracle);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].summary).toContain('no bound device provides an executable command');
    expect(runs[0].summary).toContain('turn-on'); // teaches the alternative
    expect(runs[0].nodeResults.n1).toMatchObject({ status: 'failed' });
  });

  it('ambiguity counts agree with the oracle: two declared, one executable → no ambiguity', async () => {
    // Node capability 'turn-on': device 'fan' declares it exactly; device
    // 'sw' only declares 'switch'. Without the oracle the containment
    // matcher ALSO counts... (it does not contain here, so both engines
    // agree this one is unambiguous) — the oracle's contribution is that a
    // device whose capability is declared-but-unexecutable stops counting
    // toward ambiguity, matching the authoring 422 counts.
    const runs = await runFlowOnce([flowFor('turn-on')], oracle);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');
    expect(runs[0].summary).not.toContain('ambiguous');
  });
});

// R1 (B1-9 / P-19): the stale-simulation probe — an AUTO-triggered run that
// UNSATs against the frozen snapshot but resolves against the CURRENT
// environment says so in the run record (the manual lane's 409 diagnosis),
// instead of a bare refusal that sends the operator editing declarations.
describe('FlowEngine stale-simulation probe (R1 B1-9)', () => {
  const frozenScenario = (): ScenarioDefinition =>
    loadScenarioFile({
      version: '1.0',
      meta: { id: 'stale-probe-frozen', name: 'Stale Probe Frozen' },
      zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
      devices: [
        // u3's replay shape: the sim froze BEFORE the agent's capability
        // declaration was widened — the frozen world cannot resolve
        // 'purification', the CURRENT env can (the probe stands in for the
        // env-side check the server wires).
        { id: 'switch-1', type: 'light-switch', capabilities: ['switch'], zoneId: 'zone-a' },
      ],
      agents: [
        {
          id: 'agent-a', name: 'Agent A',
          capabilities: ['switch'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['switch-1'],
        },
      ],
      events: [],
    });

  function staleFlow(): FlowDefinition {
    return {
      id: 'flow-stale',
      name: 'Purify',
      enabled: true,
      trigger: { kind: 'event', eventType: 'dust-spike', zoneId: 'zone-a' },
      plan: {
        goal: 'purify',
        nodes: [{ id: 'n1', capability: 'purification', assigneeAgentId: 'agent-a' }],
      },
    };
  }

  async function runWithProbe(probe?: (flow: FlowDefinition) => boolean): Promise<FlowRunRecord[]> {
    const runs: FlowRunRecord[] = [];
    const invoker: PlanNodeInvoker = async () => ({ success: true, result: { ok: true } });
    const engine = new FlowEngine({
      scenario: frozenScenario(),
      flowsProvider: () => [staleFlow()],
      agents: new Map(),
      invoker,
      envStateReader: () => ({ 'zone-a': { temperature: 22 } }),
      publish: () => undefined,
      now: () => '2026-01-01T00:00:00.000Z',
      onRun: record => runs.push(record),
      ...(probe !== undefined ? { staleFlowProbe: probe } : {}),
    });
    await engine.triggerManually(staleFlow().id);
    return runs;
  }

  it('probe TRUE: the refusal names the stale simulation and the recreate guidance', async () => {
    const runs = await runWithProbe(() => true);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].summary).toContain('refused');
    expect(runs[0].summary).toContain('FLOW_STALE_SIMULATION');
    expect(runs[0].summary).toContain('the environment changed after this simulation was created');
    expect(runs[0].summary).toContain('recreate the simulation');
  });

  it('probe FALSE (flow broken in the current env too): bare refusal, unchanged', async () => {
    const runs = await runWithProbe(() => false);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].summary).toContain('refused');
    expect(runs[0].summary).not.toContain('FLOW_STALE_SIMULATION');
  });

  it('no probe wired (core-only consumers): bare refusal, unchanged', async () => {
    const runs = await runWithProbe();
    expect(runs).toHaveLength(1);
    expect(runs[0].summary).not.toContain('FLOW_STALE_SIMULATION');
  });

  it('the late-setter (setStaleFlowProbe) reaches the same verdict', async () => {
    const runs: FlowRunRecord[] = [];
    const invoker: PlanNodeInvoker = async () => ({ success: true, result: { ok: true } });
    const engine = new FlowEngine({
      scenario: frozenScenario(),
      flowsProvider: () => [staleFlow()],
      agents: new Map(),
      invoker,
      envStateReader: () => ({ 'zone-a': { temperature: 22 } }),
      publish: () => undefined,
      now: () => '2026-01-01T00:00:00.000Z',
      onRun: record => runs.push(record),
    });
    engine.setStaleFlowProbe(() => true);
    await engine.triggerManually(staleFlow().id);
    expect(runs[0].summary).toContain('FLOW_STALE_SIMULATION');
  });
});
