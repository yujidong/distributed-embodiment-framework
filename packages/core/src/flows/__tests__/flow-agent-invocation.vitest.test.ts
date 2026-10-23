/**
 * @vitest-environment node
 *
 * Mechanism B — agent-invocable flows (design-mixed-initiative-flows.md §6):
 * the flow-level `agentInvocable` flag (default OFF), the ONE oracle that
 * decides both what an agent is OFFERED and what the engine GATE accepts
 * (isFlowInvocableByAgent / agentInvocableFlowOfferings), and the governed
 * execution lane FlowEngine.runAsAgent — triggerKind 'agent', T-201
 * same-tenant gate, the Mechanism-D inputs oracle, honest FAILED records on
 * bad params, and the Mechanism-C policy envelope bounding the agent entry
 * point FOR FREE (C's requested precedence test).
 */

import { describe, it, expect } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvocation, PlanNodeInvoker } from '../../workflow/plan-executor.js';
import {
  FlowEngine,
  agentInvocableFlowOfferings,
  isFlowInvocableByAgent,
  validateFlow,
  type FlowDefinition,
  type FlowRunRecord,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two tenants: agent-a is owned by 'owner-1', agent-b by 'owner-2'. Flows
 * stamped authorUserId 'owner-1' are in agent-a's scope and OUTSIDE
 * agent-b's (T-201).
 */
function tenantScenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'agent-invocation-test', name: 'Agent Invocation Test' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'hvac-a', type: 'hvac',
        capabilities: ['cooling', 'set-temperature', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b', type: 'hvac',
        capabilities: ['cooling', 'set-temperature', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'agent-a', name: 'Agent A',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
        ownerUserId: 'owner-1',
      },
      {
        id: 'agent-b', name: 'Agent B',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-b'],
        ownerUserId: 'owner-2',
      },
    ],
    events: [],
  });
}

function invocableFlow(overrides: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'night-setback',
    name: 'Night setback program',
    enabled: true,
    agentInvocable: true,
    authorUserId: 'owner-1',
    trigger: { kind: 'event', eventType: 'never', zoneId: 'zone-a' },
    inputs: [
      { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
      { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
    ],
    plan: {
      goal: 'night setback',
      nodes: [
        {
          id: 'n1', capability: 'set-temperature', deviceId: 'hvac-a',
          params: { targetTemperature: '${input:setpoint}' },
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

interface InvokerLogEntry {
  nodeId: string; deviceId?: string; params?: Record<string, unknown>;
  agentId: string;
}

function recordingInvoker(log: InvokerLogEntry[]): PlanNodeInvoker {
  return async (node, agentId): Promise<PlanNodeInvocation> => {
    log.push({
      nodeId: node.id,
      ...(node.deviceId !== undefined ? { deviceId: node.deviceId } : {}),
      ...(node.params !== undefined ? { params: node.params } : {}),
      agentId,
    });
    return { success: true, ...(node.deviceId !== undefined ? { deviceId: node.deviceId } : {}), result: { ok: true } };
  };
}

interface Harness {
  engine: FlowEngine;
  runs: FlowRunRecord[];
  log: InvokerLogEntry[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function harness(
  flows: FlowDefinition[] | (() => FlowDefinition[]),
  depsExtra: Record<string, unknown> = {},
): Harness {
  const runs: FlowRunRecord[] = [];
  const log: InvokerLogEntry[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const engine = new FlowEngine({
    scenario: tenantScenario(),
    flowsProvider: typeof flows === 'function' ? flows : () => flows,
    agents: new Map(),
    invoker: recordingInvoker(log),
    envStateReader: () => ({ 'zone-a': { temperature: 29 } }),
    publish: (type, payload) => events.push({ type, payload }),
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
    delegateRunner: {
      llmClientFor: () => undefined,
      ...depsExtra,
    },
  });
  return { engine, runs, log, events };
}

// ---------------------------------------------------------------------------
// Authoring validation — the flag
// ---------------------------------------------------------------------------

describe('agentInvocable — authoring validation', () => {
  it('accepts the flag (no errors; only the documented self-trigger footgun warning, now naming the agent lane)', () => {
    const issues = validateFlow(invocableFlow(), tenantScenario());
    expect(errorsOf(issues)).toEqual([]);
    const warnings = warningsOf(issues);
    expect(warnings.some(m => m.includes('honest FAILED'))).toBe(true);
    expect(warnings.some(m => m.includes('an agent invocation (this flow is agent-invocable)'))).toBe(true);
    expect(warnings.some(m => m.includes('agentInvocable: this flow is authored'))).toBe(false);
  });

  it('rejects non-boolean values loudly (closed schema — the standing trap, inverted)', () => {
    const issues = validateFlow(invocableFlow({ agentInvocable: 'yes' }));
    expect(errorsOf(issues).some(m => m.includes('/agentInvocable'))).toBe(true);
  });

  it('defaults OFF — omitting the flag is pre-B behavior', () => {
    const flow = invocableFlow();
    delete (flow as Partial<FlowDefinition>).agentInvocable;
    expect(flow.agentInvocable).toBeUndefined();
    expect(errorsOf(validateFlow(flow, tenantScenario()))).toEqual([]);
    expect(warningsOf(validateFlow(flow, tenantScenario())).some(m => m.includes('agent invocation'))).toBe(false);
  });

  it('teaches when a member-authored flag lets no agent invoke (inert flag warning rides the assignment errors)', () => {
    // authorUserId 'owner-9' owns no agent: the nodes cannot assign (the
    // standing T-201 errors) AND the flag is inert — the warning says the
    // flag-specific part the node errors do not.
    const flow = invocableFlow({ authorUserId: 'owner-9' });
    const issues = validateFlow(flow, tenantScenario());
    expect(errorsOf(issues).some(m => m.includes('another tenant'))).toBe(true);
    expect(warningsOf(issues).some(m => m.includes('agentInvocable') && m.includes('no agent'))).toBe(true);
  });

  it('does not warn for env-owner flows (unrestricted scope) or eligible authors', () => {
    const ownerless = invocableFlow();
    delete (ownerless as Partial<FlowDefinition>).authorUserId;
    expect(warningsOf(validateFlow(ownerless, tenantScenario())).some(m => m.includes('agentInvocable:'))).toBe(false);

    const eligible = invocableFlow(); // owner-1 owns agent-a
    expect(warningsOf(validateFlow(eligible, tenantScenario())).some(m => m.includes('agentInvocable:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The one oracle — offering honesty (gate == listing)
// ---------------------------------------------------------------------------

describe('agentInvocableFlowOfferings — honest listing', () => {
  const foreign = invocableFlow({ id: 'foreign-flow', authorUserId: 'owner-2' });
  const flagOff = invocableFlow({ id: 'flag-off' });
  delete (flagOff as Partial<FlowDefinition>).agentInvocable;
  const disabled = invocableFlow({ id: 'disabled-flow', enabled: false });

  it('offers ONLY same-tenant, enabled, flag-on flows — with the inputs contract', () => {
    const offerings = agentInvocableFlowOfferings(
      [invocableFlow(), foreign, flagOff, disabled],
      'agent-a',
      tenantScenario(),
    );
    expect(offerings).toEqual([
      {
        flowId: 'night-setback',
        name: 'Night setback program',
        inputs: invocableFlow().inputs,
      },
    ]);
  });

  it('offers a foreign owner NOTHING (cross-tenant is the Mechanism-D lane, not offered)', () => {
    expect(agentInvocableFlowOfferings([invocableFlow()], 'agent-b', tenantScenario())).toEqual([]);
  });

  it('unknown agents are offered nothing', () => {
    expect(agentInvocableFlowOfferings([invocableFlow()], 'agent-ghost', tenantScenario())).toEqual([]);
  });

  it('isFlowInvocableByAgent agrees with the listing for every (flow, agent) pair', () => {
    const scenario = tenantScenario();
    const flows = [invocableFlow(), foreign, flagOff, disabled];
    for (const flow of flows) {
      for (const agentId of ['agent-a', 'agent-b', 'agent-ghost']) {
        const listed = agentInvocableFlowOfferings([flow], agentId, scenario).length === 1;
        expect(isFlowInvocableByAgent(flow, agentId, scenario), `${flow.id} x ${agentId}`).toBe(listed);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The governed execution lane — FlowEngine.runAsAgent
// ---------------------------------------------------------------------------

describe('runAsAgent — gate refusals (pre-run, no run records)', () => {
  it('refuses a flag-OFF flow with teaching (the default lane)', async () => {
    const flow = invocableFlow();
    delete (flow as Partial<FlowDefinition>).agentInvocable;
    const h = harness([flow]);
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-a', { setpoint: 20 });
    expect(outcome).toMatchObject({ status: 'refused' });
    expect((outcome as { reason: string }).reason).toContain('not agent-invocable');
    expect(h.runs).toEqual([]); // pre-run gate: absence, never synthetic
  });

  it('refuses a disabled flow', async () => {
    const h = harness([invocableFlow({ enabled: false })]);
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-a');
    expect((outcome as { reason: string }).reason).toContain('disabled');
    expect(h.runs).toEqual([]);
  });

  it('refuses an unknown flow and names the offered set', async () => {
    const h = harness([invocableFlow()]);
    const outcome = await h.engine.runAsAgent('hallucinated-flow', 'agent-a');
    expect((outcome as { reason: string }).reason).toContain("unknown flow 'hallucinated-flow'");
    expect((outcome as { reason: string }).reason).toContain('night-setback');
    expect(h.runs).toEqual([]);
  });

  it('refuses a foreign owner with the flow-service/agreement pointer (trade-off #3)', async () => {
    const h = harness([invocableFlow()]);
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-b');
    expect((outcome as { reason: string }).reason).toContain('outside the author scope');
    expect((outcome as { reason: string }).reason).toContain('flow-service');
    expect(h.runs).toEqual([]);
  });

  it('refuses an unknown agent', async () => {
    const h = harness([invocableFlow()]);
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-ghost');
    expect((outcome as { reason: string }).reason).toContain("does not exist in this scenario");
    expect(h.runs).toEqual([]);
  });
});

describe('runAsAgent — governed invocation', () => {
  it('invokes: triggerKind agent, attribution, inputs oracle (defaults + caller values)', async () => {
    const h = harness([invocableFlow()]);
    const outcome = await h.engine.runAsAgent(
      'night-setback', 'agent-a',
      { setpoint: 20, mode: 'eco' },
      { eventId: 'evt-1' },
    );
    expect(outcome.status).toBe('invoked');
    const run = (outcome as { run: FlowRunRecord }).run;
    expect(run.triggerKind).toBe('agent');
    expect(run.status).toBe('success');
    expect(run.invokedBy).toEqual({ agentId: 'agent-a', eventId: 'evt-1' });
    expect(run.inputs).toEqual({ setpoint: 20, mode: 'eco' });
    // The interpolated plan actuated the flow AUTHOR's pinned device.
    expect(h.log).toEqual([
      { nodeId: 'n1', deviceId: 'hvac-a', params: { targetTemperature: 20 }, agentId: 'agent-a' },
    ]);
    // The bus payload carries the attribution too.
    expect(h.events.some(e => e.type === 'flow.executed' && e.payload.invokedBy?.agentId === 'agent-a')).toBe(true);
  });

  it('applies declared defaults when the caller omits optional params', async () => {
    const h = harness([invocableFlow()]);
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-a', { setpoint: 18 });
    const run = (outcome as { run: FlowRunRecord }).run;
    expect(run.status).toBe('success');
    expect(run.inputs).toEqual({ setpoint: 18, mode: 'comfort' }); // enum default applied
  });

  it('bad params land an HONEST FAILED run record (never a silent substitution)', async () => {
    const h = harness([invocableFlow()]);
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-a', { setpoint: 30 });
    expect(outcome.status).toBe('invoked'); // the agent DID invoke — the record says what happened
    const run = (outcome as { run: FlowRunRecord }).run;
    expect(run.triggerKind).toBe('agent');
    expect(run.status).toBe('failed');
    expect(run.summary).toContain('invalid run parameters');
    expect(run.summary).toContain('above its maximum');
    expect(run.invokedBy?.agentId).toBe('agent-a');
    expect(h.log).toEqual([]); // nothing actuated
  });

  it('an unsatisfiable assignment refuses the run honestly (author validation governs executability)', async () => {
    const flow = invocableFlow({
      plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'set-temperature', deviceId: 'hvac-b' }] },
    });
    const h = harness([flow]); // hvac-b is bound to agent-b — outside author scope
    const outcome = await h.engine.runAsAgent('night-setback', 'agent-a', { setpoint: 20 });
    const run = (outcome as { run: FlowRunRecord }).run;
    expect(run.status).toBe('failed');
    expect(run.summary).toContain('refused');
  });
});

// ---------------------------------------------------------------------------
// Mechanism C precedence — the envelope bounds the agent entry point FOR FREE
// (C's requested test: agent-triggered runs converge on runFlow)
// ---------------------------------------------------------------------------

describe('runAsAgent — policy envelope precedence (Mechanism C)', () => {
  const lowConfidenceAnswer = JSON.stringify({
    decision: 'set-20', reasoning: 'peaking', confidence: 0.7,
    actuations: [{ deviceId: 'hvac-a', command: 'set-temperature', params: { targetTemperature: 20 } }],
  });

  function twoDelegateAgentFlow(): FlowDefinition {
    return {
      id: 'agent-envelope-flow',
      name: 'Agent envelope flow',
      enabled: true,
      agentInvocable: true,
      trigger: { kind: 'event', eventType: 'never', zoneId: 'zone-a' },
      policy: { maxDelegationsPerRun: 1, onBudgetExhausted: 'escalate' },
      plan: {
        goal: 'shed twice',
        nodes: [
          {
            id: 'd1', assigneeAgentId: 'agent-a',
            delegate: {
              question: 'q1', mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-a'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' },
            },
          },
          {
            id: 'd2', assigneeAgentId: 'agent-a',
            delegate: {
              question: 'q2', mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-a'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' },
            },
          },
        ],
      },
    };
  }

  it('agent-triggered runs respect the envelope: budget cap + escalation record', async () => {
    const client: LLMClient = { quickChat: async () => lowConfidenceAnswer } as unknown as LLMClient;
    const h = harness([twoDelegateAgentFlow()], { llmClientFor: () => client });
    const outcome = await h.engine.runAsAgent('agent-envelope-flow', 'agent-a', undefined, { eventId: 'evt-9' });
    expect(outcome.status).toBe('invoked');
    const run = (outcome as { run: FlowRunRecord }).run;
    // d1 executed; d2 was refused by the envelope cap BEFORE consulting the LLM.
    expect(run.nodeResults['d2']?.status).toBe('succeeded'); // fallback 'none' = honest no-op
    const d2 = run.nodeResults['d2']?.result as { fallbackReason?: string };
    expect(d2.fallbackReason).toBe('budget-exhausted');
    // escalate mode surfaced the refusal on the agent-triggered run record.
    expect(run.policyEscalations).toEqual([
      { kind: 'budget-exhausted', nodeId: 'd2', message: expect.stringContaining('maxDelegationsPerRun=1') },
    ]);
    expect(run.invokedBy).toEqual({ agentId: 'agent-a', eventId: 'evt-9' });
  });
});

// ---------------------------------------------------------------------------
// Determinism arm — record/replay
// ---------------------------------------------------------------------------

describe('runAsAgent — determinism (record/replay)', () => {
  it('two engines, same scripted answers + invocations → identical normalized traces', async () => {
    const answer = JSON.stringify({
      decision: 'set-21', reasoning: 'shed', confidence: 0.9,
      actuations: [{ deviceId: 'hvac-a', command: 'set-temperature', params: { targetTemperature: 21 } }],
    });
    // Node results carry wall-clock timestamps (PlanNodeResult) and the
    // record carries a fresh runId — normalize both (the delegate suite's
    // record-replay precedent).
    const stripVolatile = (run: FlowRunRecord): unknown =>
      JSON.parse(
        JSON.stringify(run)
          .replace(/run-[0-9a-f-]{36}/g, 'run-<id>')
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<t>'),
      );
    const client: LLMClient = { quickChat: async () => answer } as unknown as LLMClient;
    const flow = invocableFlow();
    const h1 = harness([flow], { llmClientFor: () => client });
    const h2 = harness([flow], { llmClientFor: () => client });
    const o1 = await h1.engine.runAsAgent('night-setback', 'agent-a', { setpoint: 21, mode: 'eco' });
    const o2 = await h2.engine.runAsAgent('night-setback', 'agent-a', { setpoint: 21, mode: 'eco' });
    expect(stripVolatile((o1 as { run: FlowRunRecord }).run)).toEqual(stripVolatile((o2 as { run: FlowRunRecord }).run));
    expect(h1.log).toEqual(h2.log);
    expect(h1.log[0]?.params).toEqual({ targetTemperature: 21 });
  });
});
