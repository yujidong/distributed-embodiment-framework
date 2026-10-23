/**
 * @vitest-environment node
 *
 * EngineRuntime × delegate flows integration (Mechanism A, no LLM backend):
 *   - an actuating delegate drives the assignee's REAL bound device through
 *     the same own-devices command path flow action nodes use (the sim HVAC
 *     actually executes set-temperature), with the delegate outcome in the
 *     run record
 *   - shadow sims: the flow engine (delegate nodes included) is suspended —
 *     no run records, no device writes, nothing synthetic (T-302 covers the
 *     new node type for free)
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { loadScenarioFile } from '../scenario/index.js';
import type { FlowRunRecord, DelegateNodeOutcome } from '../flows/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenarioJSON() {
  return {
    version: '1.0' as const,
    meta: { id: 'runtime-delegate-flow-test', name: 'Runtime Delegate Flow Test' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'], baseline: { temperature: 22 } },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'], baseline: { temperature: 24 } },
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
      },
      {
        id: 'actuator-agent', name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
    flows: [
      {
        id: 'flow-delegate-shed',
        name: 'Delegate shed on grid peak',
        enabled: true,
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
        plan: {
          goal: 'Delegate the shed decision to the actuator agent',
          nodes: [
            {
              id: 'pick-shed-target',
              assigneeAgentId: 'actuator-agent',
              delegate: {
                question: 'Zone B is peaking. Set hvac-b to an economical target temperature (20-24).',
                mode: 'actuating',
                budget: {
                  maxCommands: 1,
                  deviceIds: ['hvac-b'],
                  allowedCommands: ['set-temperature'],
                },
                timeoutMs: 5000,
                fallback: { policy: 'none' },
              },
            },
          ],
        },
      },
    ],
  };
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(options?: EngineRuntimeOptions): EngineRuntime {
  const runtime = new EngineRuntime(loadScenarioFile(scenarioJSON()), options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

const SHED_ANSWER = JSON.stringify({
  decision: 'set-20',
  reasoning: 'zone-b at 24°C with grid peak; 20°C sheds load safely.',
  confidence: 0.8,
  actuations: [{ deviceId: 'hvac-b', command: 'set-temperature', params: { targetTemperature: 20 } }],
});

function fakeClient(answer: string): LLMClient {
  return { quickChat: async () => answer } as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

describe('EngineRuntime — delegate flows', () => {
  it('an actuating delegate drives its owner device through the real command path', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime({
      llmPerAgent: { 'actuator-agent': fakeClient(SHED_ANSWER) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'grid-peak', zoneId: 'zone-b' });

    expect(flowRuns).toHaveLength(1);
    const run = flowRuns[0];
    expect(run.status).toBe('success');
    const node = run.nodeResults['pick-shed-target'];
    expect(node?.status).toBe('succeeded');
    expect(node?.deviceId).toBe('hvac-b');
    const outcome = node?.result as DelegateNodeOutcome;
    expect(outcome).toMatchObject({
      variant: 'actuating',
      assigneeAgentId: 'actuator-agent',
      decision: 'set-20',
      decisionSource: 'llm',
      fallbackUsed: false,
      budgetUsage: { maxCommands: 1, commandsExecuted: 1 },
      actuations: [
        { deviceId: 'hvac-b', command: 'set-temperature', params: { targetTemperature: 20 }, applied: true },
      ],
    });
    // The sim HVAC actually received the command: its state carries the
    // commanded target (same effect a flow action node would produce).
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-b');
    expect(hvac).toBeDefined();
    expect(hvac?.state.targetTemperature).toBe(20);
  });

  it('no LLM wired → honest rule degradation, device untouched, run recorded', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime();
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'grid-peak', zoneId: 'zone-b' });

    expect(flowRuns).toHaveLength(1);
    const node = flowRuns[0].nodeResults['pick-shed-target'];
    expect(node?.status).toBe('succeeded'); // fallback 'none' = honest no-op
    const outcome = node?.result as DelegateNodeOutcome;
    expect(outcome).toMatchObject({
      decisionSource: 'rule',
      fallbackUsed: true,
      fallbackReason: 'no-llm',
    });
    expect(outcome.actuations).toBeUndefined();
  });

  it('shadow sims suspend the flow engine entirely — delegates never run (T-302)', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime({
      acMode: 'shadow',
      llmPerAgent: { 'actuator-agent': fakeClient(SHED_ANSWER) },
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    expect(runtime.getFlowEngine()).toBeNull();
    await runtime.injectEvent({ type: 'grid-peak', zoneId: 'zone-b' });

    // Absence, never synthetic (T-302): no run records at all, and the
    // device was never touched.
    expect(flowRuns).toHaveLength(0);
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-b');
    expect(hvac?.state.targetTemperature).toBeUndefined();
  });

  it('Mechanism C: the policy envelope rides the REAL runtime wiring — budget cap + confidence gate + escalation record', async () => {
    const flowRuns: FlowRunRecord[] = [];
    // Two sequential delegates; the envelope caps the run at ONE delegation
    // and gates the first delegate's actuation on confidence 0.9.
    const flow = {
      ...scenarioJSON().flows![0],
      id: 'flow-envelope',
      policy: {
        maxDelegationsPerRun: 1,
        minConfidenceToActuate: 0.9,
        onBudgetExhausted: 'escalate' as const,
      },
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'ask-1',
            assigneeAgentId: 'actuator-agent',
            delegate: {
              question: 'q1', mode: 'actuating' as const,
              budget: { maxCommands: 1, deviceIds: ['hvac-b'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' as const },
            },
          },
          {
            id: 'ask-2',
            assigneeAgentId: 'actuator-agent',
            delegate: {
              question: 'q2', mode: 'actuating' as const,
              budget: { maxCommands: 1, deviceIds: ['hvac-b'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' as const },
            },
          },
        ],
      },
    };
    const lowConfidence = JSON.stringify({
      decision: 'set-20', reasoning: 'peaking', confidence: 0.7,
      actuations: [{ deviceId: 'hvac-b', command: 'set-temperature', params: { targetTemperature: 20 } }],
    });
    const runtime = makeRuntime({
      llmPerAgent: { 'actuator-agent': fakeClient(lowConfidence) },
      flowsProvider: () => [flow as never],
    });
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'grid-peak', zoneId: 'zone-b' });

    expect(flowRuns).toHaveLength(1);
    const run = flowRuns[0];
    // ask-1 executed but the confidence gate refused its actuation.
    const first = run.nodeResults['ask-1']?.result as DelegateNodeOutcome;
    expect(first.fallbackUsed).toBe(false);
    expect(first.rejectedActuations?.[0]?.reason).toMatch(/minConfidenceToActuate=0.9/);
    // ask-2 was refused by the budget cap BEFORE consulting the LLM and the
    // escalate mode surfaced it on the run record.
    const second = run.nodeResults['ask-2']?.result as DelegateNodeOutcome;
    expect(second).toMatchObject({ fallbackUsed: true, fallbackReason: 'budget-exhausted' });
    expect(run.policyEscalations).toEqual([
      { kind: 'budget-exhausted', nodeId: 'ask-2', message: expect.stringContaining('maxDelegationsPerRun=1') },
    ]);
    // No physical write happened (the confidence gate refused the only
    // in-budget actuation of the only delegate that ran).
    const hvac = runtime.getSnapshot().devices.find(d => d.id === 'hvac-b');
    expect(hvac?.state.targetTemperature).toBeUndefined();
  });
});
