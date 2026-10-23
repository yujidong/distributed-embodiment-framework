/**
 * @vitest-environment node
 *
 * Mechanism C — the per-flow policy envelope (design-mixed-initiative-flows
 * §7): authoring validation (this block) and runtime enforcement (the blocks
 * below). The envelope bounds ALL agent activity inside one flow whatever
 * entry point fired it, and slots into the decisionPolicy precedence chain
 * at the FLOW tier: sim option > flow envelope > per-agent decisionPolicy >
 * platform default (and can only RESTRICT, never grant).
 */

import { describe, it, expect } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvocation, PlanNodeInvoker } from '../../workflow/plan-executor.js';
import type { DelegateNodeOutcome } from '../flow-delegate.js';
import {
  FlowEngine,
  validateFlow,
  type FlowDefinition,
  type FlowPolicyEnvelope,
  type FlowRunRecord,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseFlow(overrides: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'f-policy',
    name: 'Policy flow',
    enabled: true,
    trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
    plan: {
      goal: 'g',
      nodes: [
        {
          id: 'ask',
          assigneeAgentId: 'energy-optimizer',
          delegate: {
            question: 'Pick an HVAC to shed.',
            mode: 'actuating',
            budget: {
              maxCommands: 1,
              deviceIds: ['hvac-b1'],
              allowedCommands: ['set-temperature'],
            },
          },
        },
      ],
    },
    ...(overrides as Partial<FlowDefinition>),
  } as FlowDefinition;
}

function errorsOf(issues: ReturnType<typeof validateFlow>): string[] {
  return issues.filter(i => i.level === 'error').map(i => i.message);
}

function warningsOf(issues: ReturnType<typeof validateFlow>): string[] {
  return issues.filter(i => i.level === 'warning').map(i => i.message);
}

// ---------------------------------------------------------------------------
// Authoring validation — envelope shape + semantics
// ---------------------------------------------------------------------------

describe('policy envelope — authoring validation', () => {
  it('accepts the full design sketch (maxDelegationsPerRun + minConfidenceToActuate + escalate)', () => {
    const policy: FlowPolicyEnvelope = {
      maxDelegationsPerRun: 1,
      minConfidenceToActuate: 0.6,
      onBudgetExhausted: 'escalate',
      escalate: { channel: 'notification', toRole: 'owner' },
    };
    const issues = validateFlow(baseFlow({ policy }));
    expect(errorsOf(issues)).toEqual([]);
    expect(warningsOf(issues)).toEqual([]);
  });

  it('accepts a partial envelope (each field optional)', () => {
    expect(errorsOf(validateFlow(baseFlow({ policy: { maxDelegationsPerRun: 2 } })))).toEqual([]);
    expect(errorsOf(validateFlow(baseFlow({ policy: { minConfidenceToActuate: 0.5 } })))).toEqual([]);
    expect(errorsOf(validateFlow(baseFlow({ policy: { onBudgetExhausted: 'fallback' } })))).toEqual([]);
  });

  it('rejects a typo\'d key loudly (closed schema — the standing trap, inverted)', () => {
    const issues = validateFlow(
      baseFlow({ policy: { maxDelegationPerRun: 1 } as unknown as FlowPolicyEnvelope }),
    );
    expect(errorsOf(issues).some(m => m.includes('/policy'))).toBe(true);
  });

  it('rejects out-of-range values (maxDelegationsPerRun < 1, confidence > 1)', () => {
    expect(
      errorsOf(validateFlow(baseFlow({ policy: { maxDelegationsPerRun: 0 } }))).length,
    ).toBeGreaterThan(0);
    expect(
      errorsOf(validateFlow(baseFlow({ policy: { minConfidenceToActuate: 1.4 } }))).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an escalate block that is dead config (onBudgetExhausted !== 'escalate')", () => {
    const explicit = validateFlow(
      baseFlow({ policy: { maxDelegationsPerRun: 1, onBudgetExhausted: 'fallback', escalate: { channel: 'notification', toRole: 'owner' } } }),
    );
    expect(errorsOf(explicit).some(m => m.includes("'escalate' is declared but onBudgetExhausted"))).toBe(true);

    const defaulted = validateFlow(
      baseFlow({ policy: { maxDelegationsPerRun: 1, escalate: { channel: 'notification', toRole: 'owner' } } }),
    );
    expect(errorsOf(defaulted).some(m => m.includes("'escalate' is declared but onBudgetExhausted"))).toBe(true);
  });

  it("rejects escalation channels other than notification/owner (v1 surface)", () => {
    const issues = validateFlow(
      baseFlow({
        policy: {
          maxDelegationsPerRun: 1,
          onBudgetExhausted: 'escalate',
          escalate: { channel: 'proposal', toRole: 'owner' } as unknown as FlowPolicyEnvelope['escalate'],
        },
      }),
    );
    expect(errorsOf(issues).some(m => m.includes('/policy/escalate'))).toBe(true);
  });

  it('warns when the envelope bounds nothing (no delegate nodes in the plan)', () => {
    const flow = baseFlow({
      plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'turn-off', deviceId: 'hvac-b1' }] },
      policy: { maxDelegationsPerRun: 1 },
    });
    const warnings = warningsOf(validateFlow(flow));
    expect(warnings.some(m => m.includes('no delegate nodes'))).toBe(true);
    expect(errorsOf(validateFlow(flow))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Authoring validation — the Wave-D self-trigger footgun (implemented with C)
// ---------------------------------------------------------------------------

describe('policy envelope — self-trigger + required-no-default input warning', () => {
  const plainPlan = { goal: 'g', nodes: [{ id: 'n1', capability: 'turn-off', deviceId: 'hvac-b1' }] };

  it('warns: an automatic trigger can never satisfy a required-no-default input (honest FAILED runs)', () => {
    const flow = baseFlow({
      plan: plainPlan,
      inputs: [{ name: 'setpoint', type: 'number', required: true }],
      trigger: { kind: 'schedule', everySimSec: 600 },
    });
    const warnings = warningsOf(validateFlow(flow));
    expect(warnings.some(m => m.includes("'setpoint'") && m.includes('honest FAILED'))).toBe(true);
    expect(errorsOf(validateFlow(flow))).toEqual([]); // legal, just a footgun
  });

  it('does not warn when every required input carries a default', () => {
    const flow = baseFlow({
      plan: plainPlan,
      inputs: [{ name: 'setpoint', type: 'number', required: true, default: 20 }],
      trigger: { kind: 'schedule', everySimSec: 600 },
    });
    expect(warningsOf(validateFlow(flow)).some(m => m.includes('honest FAILED'))).toBe(false);
  });

  it('does not warn for optional inputs or surface-less flows', () => {
    const optional = baseFlow({
      plan: plainPlan,
      inputs: [{ name: 'mode', type: 'string' }],
    });
    expect(warningsOf(validateFlow(optional)).some(m => m.includes('honest FAILED'))).toBe(false);
    expect(warningsOf(validateFlow(baseFlow({ plan: plainPlan }))).some(m => m.includes('honest FAILED'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime fixtures (same shape as flow-delegate.vitest.test.ts)
// ---------------------------------------------------------------------------

function runtimeScenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'flow-policy-test', name: 'Flow Policy Test' },
    zones: [{ id: 'zone-b', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'hvac-b1', type: 'hvac',
        capabilities: ['cooling', 'set-temperature', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
      {
        id: 'hvac-b2', type: 'hvac',
        capabilities: ['cooling', 'set-temperature', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'energy-optimizer', name: 'Energy Optimizer',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b1', 'hvac-b2'],
      },
    ],
    events: [],
  });
}

/** Scripted LLM client: canned answers, counted calls. */
function scriptedClient(scripts: string[], calls: unknown[] = []): LLMClient {
  let i = 0;
  return {
    quickChat: async (...args: unknown[]) => {
      calls.push(args);
      const script = scripts[i++];
      if (script === '__throw__') throw new Error('provider connection refused');
      return script;
    },
  } as unknown as LLMClient;
}

interface InvokerLogEntry {
  nodeId: string; capability: string; deviceId?: string;
  params?: Record<string, unknown>; agentId: string; zoneId?: string;
}
function recordingInvoker(log: InvokerLogEntry[]): PlanNodeInvoker {
  return async (node, agentId, context): Promise<PlanNodeInvocation> => {
    log.push({
      nodeId: node.id, capability: node.capability,
      ...(node.deviceId !== undefined ? { deviceId: node.deviceId } : {}),
      ...(node.params !== undefined ? { params: node.params } : {}),
      agentId,
      ...(context?.zoneId !== undefined ? { zoneId: context.zoneId } : {}),
    });
    return { success: true, ...(node.deviceId !== undefined ? { deviceId: node.deviceId } : {}), result: { ok: true } };
  };
}

interface PolicyHarness {
  engine: FlowEngine;
  runs: FlowRunRecord[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  log: InvokerLogEntry[];
}

function policyHarness(
  flows: FlowDefinition[] | (() => FlowDefinition[]),
  client: LLMClient | undefined,
  depsExtra: Record<string, unknown> = {},
): PolicyHarness {
  const runs: FlowRunRecord[] = [];
  const log: InvokerLogEntry[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const engine = new FlowEngine({
    scenario: runtimeScenario(),
    flowsProvider: typeof flows === 'function' ? flows : () => flows,
    agents: new Map(),
    invoker: recordingInvoker(log),
    envStateReader: () => ({ 'zone-b': { temperature: 29, load: 0.9 } }),
    publish: (type, payload) => events.push({ type, payload }),
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
    delegateRunner: {
      llmClientFor: () => client,
      llmFailure: { retryAttempts: 1, retryBackoffMs: 1 },
      ...depsExtra,
    },
  });
  return { engine, runs, events, log };
}

/** Two actuating delegates (d1, d2) + a deterministic tail action node. */
function twoDelegateFlow(policy: FlowPolicyEnvelope): FlowDefinition {
  return {
    id: 'flow-two-delegates',
    name: 'Two delegates',
    enabled: true,
    trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
    policy,
    plan: {
      goal: 'shed twice',
      nodes: [
        {
          id: 'd1',
          assigneeAgentId: 'energy-optimizer',
          delegate: {
            question: 'Pick HVAC #1 target.',
            mode: 'actuating',
            budget: { maxCommands: 1, deviceIds: ['hvac-b1'], allowedCommands: ['set-temperature'] },
            fallback: { policy: 'none' },
          },
        },
        {
          id: 'd2',
          assigneeAgentId: 'energy-optimizer',
          delegate: {
            question: 'Pick HVAC #2 target.',
            mode: 'actuating',
            budget: { maxCommands: 1, deviceIds: ['hvac-b2'], allowedCommands: ['set-temperature'] },
            fallback: { policy: 'none' },
          },
        },
        { id: 'tail', capability: 'turn-on', deviceId: 'hvac-b1' },
      ],
    },
  } as FlowDefinition;
}

function actuatingAnswer(deviceId: string, confidence?: number): string {
  return JSON.stringify({
    decision: `shed-${deviceId}`,
    reasoning: 'highest load first.',
    ...(confidence !== undefined ? { confidence } : {}),
    actuations: [
      { deviceId, command: 'set-temperature', params: { targetTemperature: 20 } },
    ],
  });
}

function outcomeOf(run: FlowRunRecord, nodeId: string): DelegateNodeOutcome {
  return run.nodeResults[nodeId]?.result as DelegateNodeOutcome;
}

// ---------------------------------------------------------------------------
// Runtime enforcement — maxDelegationsPerRun
// ---------------------------------------------------------------------------

describe('policy envelope — maxDelegationsPerRun', () => {
  it('caps delegate execution per run: the 2nd delegate refuses BEFORE consulting the LLM and takes its fallback', async () => {
    const llmCalls: unknown[] = [];
    const client = scriptedClient([actuatingAnswer('hvac-b1', 0.9)], llmCalls);
    const h = policyHarness([twoDelegateFlow({ maxDelegationsPerRun: 1 })], client);

    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs).toHaveLength(1);
    const run = h.runs[0];
    // d1 ran and actuated; d2 refused by the envelope (fallback 'none' =
    // honest no-op SUCCESS); the deterministic tail still ran.
    expect(outcomeOf(run, 'd1')).toMatchObject({
      decisionSource: 'llm', fallbackUsed: false,
      budgetUsage: { maxCommands: 1, commandsExecuted: 1 },
    });
    expect(outcomeOf(run, 'd2')).toMatchObject({
      decisionSource: 'rule', fallbackUsed: true, fallbackReason: 'budget-exhausted',
    });
    expect(String(outcomeOf(run, 'd2').reasoning)).toMatch(/maxDelegationsPerRun=1/);
    expect(run.nodeResults.d2?.status).toBe('succeeded');
    expect(run.nodeResults.tail?.status).toBe('succeeded');
    expect(run.status).toBe('success');
    // The budget check precedes the LLM: exactly ONE consult for the run.
    expect(llmCalls).toHaveLength(1);
    // Only d1's actuation reached the device lane.
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(1);
    expect(h.log.filter(e => e.nodeId === 'd2#actuate')).toHaveLength(0);
  });

  it("a budget-exhausted delegate with fallback {policy:'node'} fails the node and the fallback node runs out-of-band", async () => {
    const flow = twoDelegateFlow({ maxDelegationsPerRun: 1 });
    // Give d2 a deterministic fallback node.
    flow.plan.nodes[1].delegate!.fallback = { policy: 'node', nodeId: 'safe-shed' };
    flow.plan.nodes.push({ id: 'safe-shed', capability: 'turn-off', deviceId: 'hvac-b2' } as never);
    const h = policyHarness([flow], scriptedClient([actuatingAnswer('hvac-b1', 0.9)]));

    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const run = h.runs[0];
    expect(run.nodeResults.d2?.status).toBe('failed');
    expect(String(run.nodeResults.d2?.error)).toMatch(/degraded \(budget-exhausted/);
    expect(run.nodeResults['safe-shed']).toMatchObject({
      status: 'succeeded', compensationFor: 'd2', deviceId: 'hvac-b2',
    });
    // T-109 (F15): fallback-delivered degradation meters 'success' at the
    // run level (the failed node stays failed above — node honesty intact).
    expect(run.status).toBe('success');
  });

  it('the budget is per-run: a fresh trigger re-arms the counter', async () => {
    const h = policyHarness(
      [twoDelegateFlow({ maxDelegationsPerRun: 2 })],
      scriptedClient([actuatingAnswer('hvac-b1', 0.9), actuatingAnswer('hvac-b2', 0.9)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    const run = h.runs[0];
    expect(outcomeOf(run, 'd1').fallbackUsed).toBe(false);
    expect(outcomeOf(run, 'd2').fallbackUsed).toBe(false);
    expect(h.log.filter(e => e.nodeId.endsWith('#actuate'))).toHaveLength(2);
  });

  it('a degraded delegate still consumed budget (the cap counts executions, not successes)', async () => {
    const flow = twoDelegateFlow({ maxDelegationsPerRun: 2 });
    // Deterministic order: d2 waits for d1 (same-wave invocation order is
    // engine-internal; the budget semantics must not depend on it). d1 gets
    // TWO unparseable answers (retryAttempts=1 retries transient errors —
    // unparseable counts) so it degrades honestly while consuming budget.
    (flow.plan.nodes[1] as { dependsOn?: string[] }).dependsOn = ['d1'];
    const h = policyHarness(
      [flow],
      scriptedClient(['not json at all', 'still not json', actuatingAnswer('hvac-b2', 0.9)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    const run = h.runs[0];
    expect(outcomeOf(run, 'd1').fallbackUsed).toBe(true); // unparseable → llm-down degradation, budget spent
    expect(outcomeOf(run, 'd1').fallbackReason).toBe('llm-down');
    expect(outcomeOf(run, 'd2').fallbackUsed).toBe(false);
    expect(outcomeOf(run, 'd2').budgetUsage).toEqual({ maxCommands: 1, commandsExecuted: 1 });
  });
});

// ---------------------------------------------------------------------------
// Runtime enforcement — minConfidenceToActuate
// ---------------------------------------------------------------------------

describe('policy envelope — minConfidenceToActuate', () => {
  function oneDelegateFlow(policy?: FlowPolicyEnvelope): FlowDefinition {
    return {
      id: 'flow-one-delegate',
      name: 'One delegate',
      enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      ...(policy !== undefined ? { policy } : {}),
      plan: {
        goal: 'shed once',
        nodes: [
          {
            id: 'd1',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'Pick an HVAC target.',
              mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-b1'], allowedCommands: ['set-temperature'] },
            },
          },
          { id: 'tail', capability: 'turn-on', deviceId: 'hvac-b1', dependsOn: ['d1'] },
        ],
      },
    } as FlowDefinition;
  }

  it('low confidence → actuation refused, judgment + confidence recorded honestly, flow continues (advice semantics)', async () => {
    const h = policyHarness(
      [oneDelegateFlow({ minConfidenceToActuate: 0.6 })],
      scriptedClient([actuatingAnswer('hvac-b1', 0.4)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const run = h.runs[0];
    const outcome = outcomeOf(run, 'd1');
    expect(run.status).toBe('success');
    expect(run.nodeResults.tail?.status).toBe('succeeded'); // flow continues
    expect(outcome).toMatchObject({
      decisionSource: 'llm', fallbackUsed: false, confidence: 0.4,
      decision: 'shed-hvac-b1',
    });
    expect(outcome.actuations).toBeUndefined();
    expect(outcome.rejectedActuations).toEqual([
      {
        deviceId: 'hvac-b1', command: 'set-temperature',
        reason: expect.stringMatching(/minConfidenceToActuate=0.6 not met \(confidence 0.4\)/),
      },
    ]);
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(0); // no physical write
  });

  it('an answer with NO usable confidence does not satisfy a declared threshold (conservative)', async () => {
    const answer = JSON.stringify({
      decision: 'shed', reasoning: 'sure',
      actuations: [{ deviceId: 'hvac-b1', command: 'set-temperature' }],
    });
    const h = policyHarness([oneDelegateFlow({ minConfidenceToActuate: 0.6 })], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = outcomeOf(h.runs[0], 'd1');
    expect(outcome.confidence).toBeUndefined();
    expect(outcome.rejectedActuations?.[0]?.reason).toMatch(/confidence not reported/);
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(0);
  });

  it('confidence at or above the threshold actuates normally', async () => {
    const h = policyHarness(
      [oneDelegateFlow({ minConfidenceToActuate: 0.6 })],
      scriptedClient([actuatingAnswer('hvac-b1', 0.6)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    expect(outcomeOf(h.runs[0], 'd1').budgetUsage).toEqual({ maxCommands: 1, commandsExecuted: 1 });
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(1);
  });

  it('no envelope → low confidence actuates (the envelope never invents constraints)', async () => {
    const h = policyHarness([oneDelegateFlow()], scriptedClient([actuatingAnswer('hvac-b1', 0.2)]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Precedence (sim option > flow envelope > agent decisionPolicy > default)
// ---------------------------------------------------------------------------

describe('policy envelope — precedence interactions', () => {
  function precedenceFlow(): FlowDefinition {
    return {
      id: 'flow-prec', name: 'Precedence', enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      policy: { minConfidenceToActuate: 0.9 },
      plan: {
        goal: 'g',
        nodes: [{
          id: 'd1', assigneeAgentId: 'energy-optimizer',
          delegate: {
            question: 'q', mode: 'actuating',
            budget: { maxCommands: 1, deviceIds: ['hvac-b1'], allowedCommands: ['set-temperature'] },
          },
        }],
      },
    } as FlowDefinition;
  }

  it('sim-level autoActuateIndependent=false overrides the envelope: the OPERATOR reason is the recorded one', async () => {
    const h = policyHarness([precedenceFlow()], scriptedClient([actuatingAnswer('hvac-b1', 0.95)]), {
      autoActuateIndependentFor: () => false, // sim tier forbids (confidence would pass the envelope gate)
    });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    const outcome = outcomeOf(h.runs[0], 'd1');
    expect(outcome.rejectedActuations?.[0]?.reason).toMatch(/autoActuateIndependent=false/);
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(0);
  });

  it('the envelope restricts even when the agent decisionPolicy allows (envelope > agent policy)', async () => {
    const h = policyHarness([precedenceFlow()], scriptedClient([actuatingAnswer('hvac-b1', 0.5)]), {
      autoActuateIndependentFor: () => true, // per-agent/sim tier ALLOWS actuation
    });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    const outcome = outcomeOf(h.runs[0], 'd1');
    expect(outcome.rejectedActuations?.[0]?.reason).toMatch(/minConfidenceToActuate=0.9/);
    expect(h.log.filter(e => e.nodeId === 'd1#actuate')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Escalation (onBudgetExhausted: 'escalate')
// ---------------------------------------------------------------------------

describe('policy envelope — escalation on exhaustion', () => {
  it("'escalate' mode: every refused delegate rides policyEscalations on the run record AND the flow.executed bus event", async () => {
    const h = policyHarness(
      [twoDelegateFlow({
        maxDelegationsPerRun: 1,
        onBudgetExhausted: 'escalate',
        escalate: { channel: 'notification', toRole: 'owner' },
      })],
      scriptedClient([actuatingAnswer('hvac-b1', 0.9)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const run = h.runs[0];
    expect(run.policyEscalations).toEqual([
      {
        kind: 'budget-exhausted', nodeId: 'd2',
        message: expect.stringMatching(/maxDelegationsPerRun=1/),
      },
    ]);
    const executed = h.events.filter(e => e.type === 'flow.executed');
    expect(executed).toHaveLength(1);
    expect((executed[0].payload.policyEscalations as unknown[]).length).toBe(1);
  });

  it("'fallback' mode (the default): the refusal still rides the node result, but NO escalation signal is emitted", async () => {
    const h = policyHarness(
      [twoDelegateFlow({ maxDelegationsPerRun: 1 })],
      scriptedClient([actuatingAnswer('hvac-b1', 0.9)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const run = h.runs[0];
    expect(run.policyEscalations).toBeUndefined();
    expect(outcomeOf(run, 'd2').fallbackReason).toBe('budget-exhausted'); // still honest
    const executed = h.events.filter(e => e.type === 'flow.executed');
    expect(executed[0].payload.policyEscalations).toBeUndefined();
  });

  it('a run that never exhausts emits nothing even in escalate mode', async () => {
    const h = policyHarness(
      [twoDelegateFlow({ maxDelegationsPerRun: 5, onBudgetExhausted: 'escalate' })],
      scriptedClient([actuatingAnswer('hvac-b1', 0.9), actuatingAnswer('hvac-b2', 0.9)]),
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    expect(h.runs[0].policyEscalations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Kill-switch (design §7: "enabled:false 即停" — free, verified)
// ---------------------------------------------------------------------------

describe('policy envelope — kill-switch', () => {
  it('a disabled flow never runs — the delegate lane dies with the engine switch (no runs, no LLM consults)', async () => {
    const llmCalls: unknown[] = [];
    const client = scriptedClient([actuatingAnswer('hvac-b1', 0.9)], llmCalls);
    const flow = twoDelegateFlow({ maxDelegationsPerRun: 1, onBudgetExhausted: 'escalate' });
    flow.enabled = false;
    let current: FlowDefinition = flow;
    const h = policyHarness(() => [current], client);

    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    expect(h.runs).toHaveLength(0);
    expect(llmCalls).toHaveLength(0);

    // Re-enabling through the SAME live provider takes effect on the next
    // evaluation (the envelope machinery resumes with it).
    current = { ...flow, enabled: true };
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    expect(h.runs).toHaveLength(1);
    expect(llmCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism (record-replay with the envelope ACTIVE)
// ---------------------------------------------------------------------------

describe('policy envelope — determinism', () => {
  function normalizedRun(run: FlowRunRecord): string {
    const nodeResults: Record<string, unknown> = {};
    for (const [nodeId, nodeResult] of Object.entries(run.nodeResults)) {
      const { startedAt: _s, finishedAt: _f, ...rest } = nodeResult as unknown as Record<string, unknown>;
      void _s; void _f;
      nodeResults[nodeId] = rest;
    }
    const { runId: _r, startedAt: _s2, finishedAt: _f2, ...rest } = run;
    void _r; void _s2; void _f2;
    return JSON.stringify({ ...rest, nodeResults })
      .replace(/run-[0-9a-f-]{36}/g, 'run-<normalized>');
  }

  it('same scripted answers + same envelope → identical traces (incl. escalations) across two engines', async () => {
    const policy: FlowPolicyEnvelope = {
      maxDelegationsPerRun: 1,
      minConfidenceToActuate: 0.6,
      onBudgetExhausted: 'escalate',
    };
    const flow = twoDelegateFlow(policy);
    // d1 answers with low confidence (gate refuses its actuation, judgment
    // recorded); d2 hits the budget (escalated refusal) — both policy lanes
    // active in one deterministic trace.
    const runOnce = (): PolicyHarness =>
      policyHarness([flow], scriptedClient([actuatingAnswer('hvac-b1', 0.4)]));

    const a = runOnce();
    await a.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b', simTimeSec: 100 });
    const b = runOnce();
    await b.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b', simTimeSec: 100 });

    expect(a.runs).toHaveLength(1);
    expect(b.runs).toHaveLength(1);
    expect(normalizedRun(b.runs[0])).toBe(normalizedRun(a.runs[0]));
    // Sanity: the run actually exercised both envelope lanes.
    expect(a.runs[0].policyEscalations?.length).toBe(1);
    expect(outcomeOf(a.runs[0], 'd1').rejectedActuations?.[0]?.reason).toMatch(/minConfidenceToActuate/);
  });
});
