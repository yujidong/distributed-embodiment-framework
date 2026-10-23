/**
 * @vitest-environment node
 *
 * EngineRuntime × agent-invoked flows (Mechanism B, no LLM backend): the REAL
 * wiring — the runtime binds each agent's decision surface to the flow
 * engine's runAsAgent lane and to the honest invocable-flows listing, so an
 * LLM decision naming one of its owner's agent-invocable flows executes it
 * as triggerKind 'agent' with ledger attribution, while the deterministic
 * device-improvisation lane stands down (the flow IS the handling).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { loadScenarioFile } from '../scenario/index.js';
import type { FlowDefinition, FlowRunRecord } from '../flows/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenarioJSON(flows: FlowDefinition[]) {
  return {
    version: '1.0' as const,
    meta: { id: 'runtime-agent-invoked-flow-test', name: 'Runtime Agent Invoked Flow Test' },
    zones: [{ id: 'zone-a', name: 'Zone A', adjacentZoneIds: [], baseline: { temperature: 26 } }],
    devices: [
      {
        id: 'temp-sensor-a', type: 'temperature-sensor',
        capabilities: ['temperature-reading'], zoneId: 'zone-a',
      },
      {
        id: 'hvac-a', type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'heating', 'set-temperature', 'set-mode', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'sensor-agent', name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent', name: 'Actuator Agent',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a'],
      },
    ],
    events: [],
    flows,
  };
}

/** An agent-invocable parameterized setback owned by the (unrestricted) env. */
function invocableFlow(overrides: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'night-setback',
    name: 'Night setback program',
    enabled: true,
    agentInvocable: true,
    // Its own trigger never fires in these tests (distinct event type).
    trigger: { kind: 'event', eventType: 'never-fires', zoneId: 'zone-a' },
    inputs: [
      { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
      { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
    ],
    plan: {
      goal: 'parameterized night setback',
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

const runtimes: EngineRuntime[] = [];

function makeRuntime(flows: FlowDefinition[], options?: EngineRuntimeOptions): EngineRuntime {
  const runtime = new EngineRuntime(loadScenarioFile(scenarioJSON(flows)), options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

/** Independent + invokeFlow answer (structured JSON path). */
const INVOKE_ANSWER = JSON.stringify({
  decision: 'independent',
  reasoning: 'grid stress — run the standard night setback procedure',
  invokeFlow: { flowId: 'night-setback', params: { setpoint: 20, mode: 'eco' } },
});

function fakeClient(answer: string): LLMClient {
  return { quickChat: async () => answer } as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

describe('EngineRuntime — agent-invoked flows (Mechanism B)', () => {
  it('an LLM decision naming an invocable flow runs it as triggerKind agent, attributed + linked to the decision', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([invocableFlow()], {
      llmPerAgent: { 'actuator-agent': fakeClient(INVOKE_ANSWER) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    // A high-severity humidity event infers humidity-control — a capability
    // absent from the actuator agent's honest surface (declared ∪ bound
    // devices), so the decision reaches the LLM, not the Type A precheck.
    await runtime.injectEvent({ type: 'humidity', zoneId: 'zone-a', value: 85, severity: 'high' });

    expect(flowRuns).toHaveLength(1);
    const run = flowRuns[0];
    expect(run.triggerKind).toBe('agent');
    expect(run.status).toBe('success');
    expect(run.inputs).toEqual({ setpoint: 20, mode: 'eco' });
    expect(run.nodeResults['n1']?.status).toBe('succeeded');

    // The flow actuated the agent's OWN device through the flow lane.
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-a');
    expect(hvac?.state.targetTemperature).toBe(20);

    // Attribution + decision↔run linkage: the run names the deciding agent
    // and the in-flight event; the decision record names the flow. The pair
    // (agentId, eventId) joins the two streams.
    const decisions = runtime.getSnapshot().recentDecisions.filter(d => d.agentId === 'actuator-agent');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions[decisions.length - 1];
    expect(decision.decision).toBe('handle_independently');
    expect(decision.invokeFlow).toEqual({ flowId: 'night-setback', params: { setpoint: 20, mode: 'eco' } });
    expect(run.invokedBy).toBeDefined();
    expect(run.invokedBy!.agentId).toBe('actuator-agent');
    expect(run.invokedBy!.eventId).toBe(decision.eventId);
  });

  it('flag OFF → the invocation is refused with teaching and the agent improvises as before (no agent run)', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const flow = invocableFlow();
    delete (flow as Partial<FlowDefinition>).agentInvocable;
    const runtime = makeRuntime([flow], {
      llmPerAgent: { 'actuator-agent': fakeClient(INVOKE_ANSWER) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'humidity', zoneId: 'zone-a', value: 85, severity: 'high' });

    expect(flowRuns).toEqual([]); // no agent-triggered run (pre-run gate)
    const decisions = runtime.getSnapshot().recentDecisions.filter(d => d.agentId === 'actuator-agent');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const decision = decisions[decisions.length - 1];
    expect(decision.invokeFlow).toEqual({ flowId: 'night-setback', params: { setpoint: 20, mode: 'eco' } });
    // The teaching refusal rides the assessment object (the manager-level
    // tests assert it verbatim); at the runtime surface the outcome is the
    // ABSENCE of any agent-triggered run while the intent stays recorded.
  });

  it('a hallucinated flowId is refused with the offered set named (prompt injection cannot widen the gate)', async () => {
    const answer = JSON.stringify({
      decision: 'independent',
      reasoning: 'trying something else',
      invokeFlow: { flowId: 'evil-exfiltration-flow' },
    });
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([invocableFlow()], {
      llmPerAgent: { 'actuator-agent': fakeClient(answer) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'humidity', zoneId: 'zone-a', value: 85, severity: 'high' });

    // The gate named the unknown flow and the offered set (asserted at the
    // manager level); here: no run happened and the intent stays recorded.
    expect(flowRuns).toEqual([]);
    const decisions = runtime.getSnapshot().recentDecisions.filter(d => d.agentId === 'actuator-agent');
    const decision = decisions[decisions.length - 1];
    expect(decision.invokeFlow).toEqual({ flowId: 'evil-exfiltration-flow' });
  });

  it('bad params land an honest FAILED agent-run (never a silent substitution)', async () => {
    const answer = JSON.stringify({
      decision: 'independent',
      reasoning: 'setback to an out-of-range value',
      invokeFlow: { flowId: 'night-setback', params: { setpoint: 30 } },
    });
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([invocableFlow()], {
      llmPerAgent: { 'actuator-agent': fakeClient(answer) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'humidity', zoneId: 'zone-a', value: 85, severity: 'high' });

    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].triggerKind).toBe('agent');
    expect(flowRuns[0].status).toBe('failed');
    expect(flowRuns[0].summary).toContain('invalid run parameters');
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-a');
    expect(hvac?.state.targetTemperature).toBeUndefined(); // nothing actuated
  });

  it('shadow sims never invoke flows (the lane is gated with the standing actuation gates)', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([invocableFlow()], {
      acMode: 'shadow',
      llmPerAgent: { 'actuator-agent': fakeClient(INVOKE_ANSWER) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'humidity', zoneId: 'zone-a', value: 85, severity: 'high' });

    expect(flowRuns).toEqual([]); // T-302: absence, never synthetic
    const decisions = runtime.getSnapshot().recentDecisions.filter(d => d.agentId === 'actuator-agent');
    const decision = decisions[decisions.length - 1];
    expect(decision.invokeFlow).toEqual({ flowId: 'night-setback', params: { setpoint: 20, mode: 'eco' } });
  });

  it('Mechanism C precedence at the REAL wiring: an agent-triggered run respects the policy envelope', async () => {
    const lowConfidence = JSON.stringify({
      decision: 'set-20', reasoning: 'peaking', confidence: 0.7,
      actuations: [{ deviceId: 'hvac-a', command: 'set-temperature', params: { targetTemperature: 20 } }],
    });
    const flow = invocableFlow({
      policy: { maxDelegationsPerRun: 1, onBudgetExhausted: 'escalate' },
      plan: {
        goal: 'delegate twice under an envelope',
        nodes: [
          {
            id: 'd1', assigneeAgentId: 'actuator-agent',
            delegate: {
              question: 'q1', mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-a'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' },
            },
          },
          {
            id: 'd2', assigneeAgentId: 'actuator-agent',
            delegate: {
              question: 'q2', mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-a'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' },
            },
          },
        ],
      },
    });
    const flowRuns: FlowRunRecord[] = [];
    // The SAME scripted client answers both the decision (independent +
    // invokeFlow) and the delegate questions (low-confidence answer).
    let call = 0;
    const client: LLMClient = {
      quickChat: async () => (call++ === 0 ? INVOKE_ANSWER : lowConfidence),
    } as unknown as LLMClient;
    const runtime = makeRuntime([flow], { llmPerAgent: { 'actuator-agent': client } });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'humidity', zoneId: 'zone-a', value: 85, severity: 'high' });

    expect(flowRuns).toHaveLength(1);
    const run = flowRuns[0];
    expect(run.triggerKind).toBe('agent');
    // The envelope bounded the agent-triggered run: d2 refused by the cap.
    const d2 = run.nodeResults['d2']?.result as { fallbackReason?: string };
    expect(d2.fallbackReason).toBe('budget-exhausted');
    expect(run.policyEscalations).toEqual([
      { kind: 'budget-exhausted', nodeId: 'd2', message: expect.stringContaining('maxDelegationsPerRun=1') },
    ]);
    expect(run.invokedBy?.agentId).toBe('actuator-agent');
  });
});
