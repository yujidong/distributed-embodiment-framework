/**
 * @vitest-environment node
 *
 * Mechanism B — the agent decision surface (design-mixed-initiative-flows
 * §6): the assessor's HONEST invocable-flows listing (only offered flows
 * reach the prompt, S1-sanitized), the structured-answer invokeFlow parse,
 * and DualTriggerACManager's governed execution exit — an honored
 * invocation replaces device improvisation, a refusal degrades to it with
 * the teaching reason on the record, and the standing actuation gates
 * (shadow etc.) suppress the lane by naming themselves.
 */

import { describe, it, expect, vi } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { AgentFlowInvocationOutcome } from '../../flows/index.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';

// ---------------------------------------------------------------------------
// Assessor fixtures
// ---------------------------------------------------------------------------

function fakeClient(answer: string): LLMClient {
  return { quickChat: async () => answer } as unknown as LLMClient;
}

function clusterSummary(): SpatialClusterSummary {
  // Fix-21 recipe to REACH the LLM: direct actuator coverage of the event
  // zone (not sensor-only) + a capability gap (the 'power.surge' finding
  // infers 'power-management', which the fixture agent does not list).
  return {
    clusterId: 'c-1',
    region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
    temporalWindow: { start: new Date(), end: new Date(), duration: 0 },
    statistics: { eventCount: 1, eventTypes: new Map(), significanceScore: 50, trend: 'stable' },
    significance: 'medium',
    findings: [{
      eventType: 'power.surge',
      count: 1,
      trend: 'stable',
      anomaly: false,
      details: {},
    }],
    summary: 'Generic event requiring LLM evaluation for decision making',
    recommendation: 'evaluate_with_llm',
  } as unknown as SpatialClusterSummary;
}

function agentContext(extra: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    agentName: 'Agent One',
    capabilities: ['cooling', 'temperature-control'],
    availableResources: [],
    currentWorkload: 'idle' as const,
    recentCollaborations: [],
    currentCollaborations: 0,
    actuatorZoneIds: ['zone-a'],
    managedZoneIds: ['zone-a'],
    adjacentZoneIds: [],
    ...extra,
  };
}

const OFFERINGS = [
  {
    flowId: 'night-setback',
    name: 'Night setback program',
    inputs: [
      { name: 'setpoint', type: 'number' as const, required: true },
      { name: 'mode', type: 'string' as const, enum: ['eco', 'comfort'], default: 'comfort' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Assessor — honest listing + structured invokeFlow parse
// ---------------------------------------------------------------------------

describe('assessor — invocable-flows prompt surface (S1 honesty)', () => {
  it('lists ONLY the offered flows (ids, names, param contracts) when offerings exist', async () => {
    const prompts: string[] = [];
    const client: LLMClient = {
      quickChat: async (prompt: string) => {
        prompts.push(prompt);
        return '{"decision": "independent", "reasoning": "standard procedure fits"}';
      },
    } as unknown as LLMClient;
    const assessor = new ACNecessityAssessor({ useStructuredOutput: true }, client);
    await assessor.assess(clusterSummary(), agentContext({ invocableFlows: OFFERINGS }));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('INVOCABLE_FLOWS');
    expect(prompts[0]).toContain('night-setback');
    expect(prompts[0]).toContain('Night setback program');
    expect(prompts[0]).toContain('setpoint:number (required)');
    // R40-A4: the instruction teaches the STRUCTURED_OUTPUT encoding —
    // actionPlan.primary.action="invoke_flow" with flowId/flowParams. The
    // pre-Phase-1 root-level "invokeFlow" key wording is gone (providers
    // that ignore the constrained format used to emit the dropped encoding).
    expect(prompts[0]).toContain('"invoke_flow"');
    expect(prompts[0]).toContain('flowParams');
  });

  it('no offerings → the exact pre-B prompt (no INVOCABLE_FLOWS block)', async () => {
    const prompts: string[] = [];
    const client: LLMClient = {
      quickChat: async (prompt: string) => {
        prompts.push(prompt);
        return '{"decision": "independent", "reasoning": "r"}';
      },
    } as unknown as LLMClient;
    const assessor = new ACNecessityAssessor({ useStructuredOutput: true }, client);
    await assessor.assess(clusterSummary(), agentContext());
    expect(prompts[0]).not.toContain('INVOCABLE_FLOWS');
    expect(prompts[0]).not.toContain('invokeFlow');
  });

  it('a structured independent answer with invokeFlow surfaces it on the decision record', async () => {
    const client = fakeClient(
      '{"decision": "independent", "reasoning": "run the standard setback", ' +
      '"invokeFlow": {"flowId": "night-setback", "params": {"setpoint": 20}}}',
    );
    const assessor = new ACNecessityAssessor({ useStructuredOutput: true }, client);
    const assessment = await assessor.assess(clusterSummary(), agentContext({ invocableFlows: OFFERINGS }));
    expect(assessment.decision).toBe('handle_independently');
    expect(assessment.invokeFlow).toEqual({ flowId: 'night-setback', params: { setpoint: 20 } });
    expect(assessment.llmAssessment.invokeFlow).toEqual({ flowId: 'night-setback', params: { setpoint: 20 } });
  });

  it('a malformed invokeFlow is dropped WITH a note (never silent)', async () => {
    const client = fakeClient(
      '{"decision": "independent", "reasoning": "r", "invokeFlow": {"flowId": 42}}',
    );
    const assessor = new ACNecessityAssessor({ useStructuredOutput: true }, client);
    const assessment = await assessor.assess(clusterSummary(), agentContext({ invocableFlows: OFFERINGS }));
    expect(assessment.decision).toBe('handle_independently');
    expect(assessment.invokeFlow).toBeUndefined();
    expect(assessment.llmAssessment.reasoning).toContain('invokeFlow ignored: malformed');
  });

  it('a hallucinated flowId parses verbatim (the GATE refuses downstream — defense in depth)', async () => {
    const client = fakeClient(
      '{"decision": "independent", "reasoning": "r", "invokeFlow": {"flowId": "not-offered"}}',
    );
    const assessor = new ACNecessityAssessor({ useStructuredOutput: true }, client);
    const assessment = await assessor.assess(clusterSummary(), agentContext({ invocableFlows: OFFERINGS }));
    expect(assessment.invokeFlow).toEqual({ flowId: 'not-offered' });
  });

  it('a collaborate answer carrying invokeFlow records it but the decision stays initiate_ac', async () => {
    const client = fakeClient(
      '{"decision": "collaborate", "reasoning": "need a partner", ' +
      '"invokeFlow": {"flowId": "night-setback"}}',
    );
    const assessor = new ACNecessityAssessor({ useStructuredOutput: true, confidenceThreshold: 0 }, client);
    const assessment = await assessor.assess(clusterSummary(), agentContext({ invocableFlows: OFFERINGS }));
    expect(assessment.llmAssessment.needsCollaboration).toBe(true);
    expect(assessment.invokeFlow).toEqual({ flowId: 'night-setback' });
  });
});

// ---------------------------------------------------------------------------
// Manager — the governed execution exit
// ---------------------------------------------------------------------------

interface ManagerAccess {
  processAssessmentResult(a: Record<string, unknown>, t: number): Promise<{ path: string }>;
  executeFlowInvocation(a: Record<string, unknown>): Promise<boolean>;
}

function makeManager(config: Record<string, unknown> = {}) {
  const executor = vi.fn(async () => ({ success: true }));
  const invoked: Array<{ flowId: string; params?: Record<string, unknown> }> = [];
  let nextOutcome: AgentFlowInvocationOutcome = {
    status: 'invoked',
    run: {
      runId: 'run-fixed', flowId: 'night-setback', triggerKind: 'agent', status: 'success',
      summary: 'ok', nodeResults: {}, startedAt: 't', finishedAt: 't',
    },
  };
  const flowInvoker = vi.fn(async (flowId: string, params?: Record<string, unknown>) => {
    invoked.push({ flowId, ...(params !== undefined ? { params } : {}) });
    return nextOutcome;
  });
  const environment = {
    listDevices: () => [],
    listAgents: () => [],
    getParameters: () => ({}),
    eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
    services: new Map(),
  } as unknown as EnvironmentCenter;
  const manager = new DualTriggerACManager(
    'agent-1', 'Agent One', ['cooling', 'temperature-control'],
    fakeClient('{"decision": "independent", "reasoning": "r"}'),
    environment,
    vi.fn(),
    {
      enableLayer1: false,
      enableLayer2: true,
      // Actuation-capable manager (autoInitiateAC false would gate every
      // independent actuation lane as "decision-only evaluation").
      autoInitiateAC: true,
      commandExecutor: executor,
      flowInvoker,
      ...config,
    },
  );
  // Own in-zone actuator so the deterministic fallback lane can plan a
  // command when an invocation is refused.
  manager.setAgentDevices([
    { deviceId: 'hvac-a', type: 'hvac', capabilities: ['set-temperature'], zoneId: 'zone-a' },
  ]);
  return {
    mgr: manager as unknown as ManagerAccess,
    executor,
    flowInvoker,
    invoked,
    setOutcome: (outcome: AgentFlowInvocationOutcome) => { nextOutcome = outcome; },
  };
}

function invokeAssessment(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision: 'handle_independently',
    decisionSource: 'llm',
    clusterSummary: {
      clusterId: 'c-1',
      region: { id: 'zone-a', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      significance: 'high',
      summary: 'Event grid-peak, parameter=load, newValue=0.95',
      findings: [],
      recommendation: 'immediate_action',
    },
    llmAssessment: { reasoning: 'covered' },
    invokeFlow: { flowId: 'night-setback', params: { setpoint: 20 } },
    ...extra,
  };
}

describe('DualTriggerACManager — flow invocation exit', () => {
  it('an honored invocation runs the flow and does NOT improvise device commands', async () => {
    const h = makeManager();
    const assessment = invokeAssessment();
    const result = await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(result.path).toBe('handled_independently');
    expect(h.invoked).toEqual([{ flowId: 'night-setback', params: { setpoint: 20 } }]);
    expect(h.executor).not.toHaveBeenCalled();
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning))
      .toContain(`[flow invoked: 'night-setback' run=run-fixed status=success]`);
  });

  it('a refused invocation degrades to the deterministic device commands with the teaching reason', async () => {
    const h = makeManager();
    h.setOutcome({ status: 'refused', reason: "flow 'night-setback' is not agent-invocable — set agentInvocable: true" });
    const assessment = invokeAssessment();
    await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(h.invoked).toHaveLength(1);
    expect(h.executor).toHaveBeenCalled(); // fell back to improvisation
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning))
      .toContain("[flow invocation 'night-setback' refused: flow 'night-setback' is not agent-invocable");
  });

  it('no lane wired → refusal note + device commands (pre-B behavior)', async () => {
    const h = makeManager({ flowInvoker: undefined });
    const assessment = invokeAssessment();
    await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(h.flowInvoker).not.toHaveBeenCalled();
    expect(h.executor).toHaveBeenCalled();
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning))
      .toContain('no flow-invocation lane is wired');
  });

  it('shadow mode refuses the invocation and names the operative gate', async () => {
    const h = makeManager({ acMode: 'shadow' });
    const assessment = invokeAssessment();
    await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(h.flowInvoker).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning))
      .toContain(`[flow invocation 'night-setback' refused: acMode=shadow`);
  });

  it('a lane that THROWS degrades honestly (note + device commands)', async () => {
    const h = makeManager({ flowInvoker: async () => { throw new Error('lane exploded'); } });
    const assessment = invokeAssessment();
    await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(h.executor).toHaveBeenCalled();
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning))
      .toContain('failed in the lane: lane exploded');
  });

  it('a non-independent decision never invokes (the defer/AC paths own it; invokeFlow stays on the record)', async () => {
    const h = makeManager({ autoInitiateAC: true });
    const assessment = invokeAssessment({ decision: 'defer', invokeFlow: { flowId: 'night-setback' } });
    const result = await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(result.path).toBe('deferred');
    expect(h.flowInvoker).not.toHaveBeenCalled();
    expect(h.executor).not.toHaveBeenCalled();
    // The decision record still carries the named flow (consumers see the
    // deferred decision + what it wanted to run).
    expect((assessment as { invokeFlow?: unknown }).invokeFlow).toEqual({ flowId: 'night-setback' });
  });

  it('decisions without invokeFlow are bit-identical pre-B behavior (no lane calls)', async () => {
    const h = makeManager();
    const assessment = invokeAssessment();
    delete (assessment as { invokeFlow?: unknown }).invokeFlow;
    await h.mgr.processAssessmentResult(assessment, Date.now());
    expect(h.flowInvoker).not.toHaveBeenCalled();
    expect(h.executor).toHaveBeenCalled();
    expect(String((assessment.llmAssessment as { reasoning?: string }).reasoning)).toBe('covered');
  });
});
