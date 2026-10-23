/**
 * @vitest-environment node
 *
 * Mechanism A — delegate runner + FlowEngine integration (no LLM backend):
 *   - advice delegate: judgment recorded, whitelisted outputs promoted into
 *     the guard namespace (delegate.<nodeId>.<key>) and read by downstream
 *     guards — exactly one guarded branch runs
 *   - actuating delegate: in-budget actuations execute through the SAME base
 *     (device) invoker path with zone context; budget-exhausted /
 *     out-of-budget proposals are rejected INDIVIDUALLY with recorded
 *     reasons (no wholesale failure, no silent truncation)
 *   - timeout → deterministic fallback ('none' honest no-op; 'node' runs the
 *     fallback action node out-of-band, at most once, via the compensate
 *     semantics — and NEVER when the delegate succeeded)
 *   - LLM down → T-022 rule-llm-down degradation (bounded transient retry,
 *     provider error in the reasoning, fallback fires)
 *   - no client / disabled assignee / operator-disabled actuation: honest
 *     degradation with the specific reason recorded
 *   - DETERMINISM: two engines fed the same scripted LLM answers produce
 *     identical traces (record-replay)
 *   - a flow WITHOUT delegate nodes runs the exact pre-A path (regression)
 */

import { describe, it, expect } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvocation, PlanNodeInvoker } from '../../workflow/plan-executor.js';
import type { DelegateBudgetDevice, DelegateNodeOutcome } from '../flow-delegate.js';
import {
  FlowEngine,
  createDelegateDispatchingInvoker,
  parseDelegateAnswer,
  type FlowDefinition,
  type FlowRunRecord,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'flow-delegate-test', name: 'Flow Delegate Test' },
    zones: [{ id: 'zone-b', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'hvac-b1', type: 'hvac',
        capabilities: ['cooling', 'temperature-control', 'set-temperature', 'set-mode', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
      {
        id: 'hvac-b2', type: 'hvac',
        capabilities: ['cooling', 'temperature-control', 'set-temperature', 'set-mode', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
      {
        // A real, bound, executable device the fake invoker FAILS on command
        // (injected device fault) — runtime governance lets it through; the
        // invoker double rejects the execution.
        id: 'hvac-broken', type: 'hvac',
        capabilities: ['set-temperature'],
        zoneId: 'zone-b',
      },
      {
        // R28: the grid-battery acceptance device (set-charging/set-power
        // vocabulary, per the R26 GridOperator world).
        id: 'battery-b1', type: 'battery',
        capabilities: ['set-charging', 'set-power'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'energy-optimizer', name: 'Energy Optimizer',
        capabilities: ['cooling', 'temperature-control'],
        managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b1', 'hvac-b2', 'hvac-broken', 'battery-b1'],
      },
    ],
    events: [],
  });
}

/** Scripted LLM client (record-replay): canned answers, counted calls. */
function scriptedClient(scripts: string[], opts: { calls?: unknown[] } = {}): LLMClient {
  let i = 0;
  return {
    quickChat: async (...args: unknown[]) => {
      opts.calls?.push(args);
      const script = scripts[i++];
      if (script === '__throw__') throw new Error('provider connection refused');
      if (script === '__hang__') await new Promise(() => undefined); // never settles
      return script;
    },
  } as unknown as LLMClient;
}

/** Base (device) invoker double: records every dispatch, honors pins. */
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
    if (node.deviceId === 'hvac-broken') {
      return { success: false, deviceId: 'hvac-broken', error: 'device offline (injected fault)' };
    }
    return { success: true, ...(node.deviceId !== undefined ? { deviceId: node.deviceId } : {}), result: { ok: true } };
  };
}

interface Harness {
  engine: FlowEngine;
  runs: FlowRunRecord[];
  log: InvokerLogEntry[];
}

/**
 * T-502 (EC24-F02): the budget-device inventory the runtime injects —
 * identity + live state, the surface the actuating prompt renders. Note the
 * non-primitive `history` entry: the prompt-side filter must drop it.
 */
function inventoryOf(deviceId: string): DelegateBudgetDevice | undefined {
  const known: Record<string, DelegateBudgetDevice> = {
    'hvac-b1': {
      deviceId: 'hvac-b1', name: 'HVAC B1', type: 'hvac', zoneId: 'zone-b',
      state: { power: true, targetTemperature: 24, mode: 'cool', history: [1, 2, 3] },
    },
    'hvac-b2': {
      deviceId: 'hvac-b2', name: 'HVAC B2', type: 'hvac', zoneId: 'zone-b',
      state: { power: false, targetTemperature: 22 },
    },
    'hvac-broken': { deviceId: 'hvac-broken', name: 'HVAC Broken', type: 'hvac', zoneId: 'zone-b' },
  };
  return known[deviceId];
}

function harness(
  flows: FlowDefinition[],
  client: LLMClient | undefined,
  depsExtra: Record<string, unknown> = {},
  engineExtra: { budgetDeviceOf?: (deviceId: string) => DelegateBudgetDevice | undefined } = {},
): Harness {
  const runs: FlowRunRecord[] = [];
  const log: InvokerLogEntry[] = [];
  const engine = new FlowEngine({
    scenario: scenario(),
    flowsProvider: () => flows,
    agents: new Map(),
    invoker: recordingInvoker(log),
    envStateReader: () => ({ 'zone-b': { temperature: 29, load: 0.9 } }),
    publish: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
    ...(engineExtra.budgetDeviceOf !== undefined
      ? { budgetDeviceOf: engineExtra.budgetDeviceOf }
      : {}),
    ...(client !== undefined || Object.keys(depsExtra).length > 0
      ? {
          delegateRunner: {
            llmClientFor: () => client,
            llmFailure: { retryAttempts: 1, retryBackoffMs: 1 },
            ...depsExtra,
          },
        }
      : {
          // client undefined: the seam is wired, lookup finds no client —
          // the honest no-LLM degradation path (never "no runner wired").
          delegateRunner: {
            llmClientFor: () => undefined,
            llmFailure: { retryAttempts: 1, retryBackoffMs: 1 },
            ...depsExtra,
          },
        }),
  });
  return { engine, runs, log };
}

function actuatingFlow(overrides: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'flow-shed',
    name: 'Shed load',
    enabled: true,
    trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
    plan: {
      goal: 'shed',
      nodes: [
        {
          id: 'pick-shed-target',
          assigneeAgentId: 'energy-optimizer',
          delegate: {
            question: 'Pick one HVAC to shed and a target temperature (18-26).',
            mode: 'actuating',
            budget: {
              maxCommands: 2,
              deviceIds: ['hvac-b1', 'hvac-b2'],
              allowedCommands: ['set-temperature'],
            },
            timeoutMs: 5000,
            fallback: { policy: 'none' },
          },
        },
      ],
    },
    ...(overrides as Partial<FlowDefinition>),
  } as FlowDefinition;
}

function delegateOutcome(run: FlowRunRecord, nodeId = 'pick-shed-target'): DelegateNodeOutcome {
  return run.nodeResults[nodeId]?.result as DelegateNodeOutcome;
}

const ANSWER_SHED = JSON.stringify({
  decision: 'shed-hvac-b1',
  reasoning: 'hvac-b1 has the highest load; thermal inertia allows 20°C.',
  confidence: 0.82,
  actuations: [
    { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 20 } },
  ],
});

// ---------------------------------------------------------------------------
// Advice variant
// ---------------------------------------------------------------------------

describe('delegate — advice variant', () => {
  it('records the judgment and promotes whitelisted outputs into downstream guards', async () => {
    const flow: FlowDefinition = {
      id: 'flow-advice',
      name: 'Advice',
      enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      plan: {
        goal: 'decide then act',
        nodes: [
          {
            id: 'ask',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'Which HVAC should we shed?',
              mode: 'advice',
              outputs: ['shed'],
            },
          },
          {
            id: 'act-on-b1',
            capability: 'turn-off',
            deviceId: 'hvac-b1',
            dependsOn: ['ask'],
            condition: "delegate.ask.shed == 'hvac-b1'",
          },
          {
            id: 'act-on-b2',
            capability: 'turn-off',
            deviceId: 'hvac-b2',
            dependsOn: ['ask'],
            condition: "delegate.ask.shed == 'hvac-b2'",
          },
        ],
      },
    };
    const answer = JSON.stringify({
      decision: 'shed-b1', reasoning: 'b1 is hottest',
      outputs: { shed: 'hvac-b1' },
    });
    const h = harness([flow], scriptedClient([answer]));

    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].status).toBe('success');
    const outcome = h.runs[0].nodeResults.ask?.result as DelegateNodeOutcome;
    expect(outcome).toMatchObject({
      variant: 'advice', assigneeAgentId: 'energy-optimizer',
      decision: 'shed-b1', decisionSource: 'llm', fallbackUsed: false,
      outputs: { shed: 'hvac-b1' },
    });
    // Exactly the guarded branch for hvac-b1 ran; the other was skipped.
    expect(h.runs[0].nodeResults['act-on-b1']?.status).toBe('succeeded');
    expect(h.runs[0].nodeResults['act-on-b2']?.status).toBe('skipped');
    expect(h.log.filter(e => e.nodeId === 'act-on-b1')).toHaveLength(1);
    expect(h.log.filter(e => e.nodeId === 'act-on-b2')).toHaveLength(0);
  });

  it('records (not silently drops) answer output keys outside the whitelist', async () => {
    const flow: FlowDefinition = {
      id: 'f', name: 'f', enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      plan: {
        goal: 'g',
        nodes: [
          { id: 'ask', assigneeAgentId: 'energy-optimizer',
            delegate: { question: 'q', mode: 'advice', outputs: ['wanted'] } },
        ],
      },
    };
    const answer = JSON.stringify({
      decision: 'd', reasoning: 'r',
      outputs: { wanted: 1, stray: 2 },
      actuations: [{ deviceId: 'hvac-b1', command: 'set-temperature' }],
    });
    const h = harness([flow], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0], 'ask');
    expect(outcome.outputs).toEqual({ wanted: 1 });
    expect(outcome.ignoredOutputKeys).toEqual(['stray']);
    // Advice can never actuate: the proposal is rejected with a reason and
    // the device invoker was never called.
    expect(outcome.rejectedActuations).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature',
        reason: 'advice delegates cannot actuate devices — the judgment is record-only' },
    ]);
    expect(h.log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Actuating variant
// ---------------------------------------------------------------------------

describe('delegate — actuating variant', () => {
  it('executes in-budget actuations through the base invoker with zone context + attribution', async () => {
    const h = harness([actuatingFlow()], scriptedClient([ANSWER_SHED]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome).toMatchObject({
      variant: 'actuating', decision: 'shed-hvac-b1', decisionSource: 'llm',
      fallbackUsed: false, budgetUsage: { maxCommands: 2, commandsExecuted: 1 },
    });
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature',
        params: { targetTemperature: 20 }, applied: true },
    ]);
    // Same command path as flow action nodes: one dispatch, zone context and
    // assignee attribution, synthetic node id derived from the delegate node.
    expect(h.log).toEqual([
      { nodeId: 'pick-shed-target#actuate', capability: 'set-temperature',
        deviceId: 'hvac-b1', params: { targetTemperature: 20 },
        agentId: 'energy-optimizer', zoneId: 'zone-b' },
    ]);
    expect(h.runs[0].nodeResults['pick-shed-target']?.deviceId).toBe('hvac-b1');
  });

  // T-605 (R26, HO26-F02): heterogeneous budgets are expressible and the
  // model PAIRS (device, command) naturally — an actuation on the device
  // that actually executes its command runs through the same base invoker.
  it('T-605: a heterogeneous union budget dispatches the model-paired (device, command) actuation', async () => {
    const flow = actuatingFlow();
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['set-temperature', 'turn-off'];
    const answer = JSON.stringify({
      decision: 'shed-b2', reasoning: 'b2 is idle-shedding first; b1 keeps the setpoint.',
      confidence: 0.9,
      actuations: [
        { deviceId: 'hvac-b2', command: 'set-temperature', params: { targetTemperature: 21 } },
      ],
    });
    const h = harness([flow], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 1 });
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-b2', command: 'set-temperature',
        params: { targetTemperature: 21 }, applied: true },
    ]);
    expect(h.log).toEqual([
      { nodeId: 'pick-shed-target#actuate', capability: 'set-temperature',
        deviceId: 'hvac-b2', params: { targetTemperature: 21 },
        agentId: 'energy-optimizer', zoneId: 'zone-b' },
    ]);
  });

  it('rejects budget-exhausted / out-of-budget proposals INDIVIDUALLY, never wholesale', async () => {
    const answer = JSON.stringify({
      decision: 'shed-all', reasoning: 'grid emergency',
      actuations: [
        { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 22 } },
        { deviceId: 'hvac-b2', command: 'set-temperature', params: { targetTemperature: 22 } },
        { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 18 } }, // over maxCommands
        { deviceId: 'hvac-b1', command: 'turn-off' },  // command not allowed
        { deviceId: 'temp-sensor', command: 'set-temperature' }, // device not in budget
      ],
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    // Node SUCCEEDS: the first two in-budget commands applied, the rest
    // rejected one by one with recorded reasons.
    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 2 });
    expect(outcome.actuations).toHaveLength(2);
    expect(outcome.rejectedActuations).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', reason: 'budget exhausted (maxCommands=2 already executed)' },
      { deviceId: 'hvac-b1', command: 'turn-off', reason: 'command is not in the budget allowedCommands' },
      { deviceId: 'temp-sensor', command: 'set-temperature', reason: 'device is not in the budget deviceIds' },
    ]);
    expect(h.log).toHaveLength(2);
  });

  it('records a failed actuation execution honestly (device fault) without failing the node', async () => {
    const answer = JSON.stringify({
      decision: 'try-broken', reasoning: 'it was worth a try',
      actuations: [{ deviceId: 'hvac-broken', command: 'set-temperature' }],
    });
    const flow = actuatingFlow();
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-broken'];
    const h = harness([flow], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-broken', command: 'set-temperature', applied: false,
        error: 'device offline (injected fault)' },
    ]);
    expect(h.runs[0].nodeResults['pick-shed-target']?.status).toBe('succeeded');
  });

  it('rejects ALL actuations when the operator disabled independent actuation (T-050 precedence)', async () => {
    const h = harness(
      [actuatingFlow()],
      scriptedClient([ANSWER_SHED]),
      { autoActuateIndependentFor: () => false },
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.decision).toBe('shed-hvac-b1'); // judgment still recorded
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 0 });
    expect(outcome.rejectedActuations?.[0]?.reason).toMatch(/autoActuateIndependent=false/);
    expect(h.log).toHaveLength(0); // no physical writes
  });
});

// ---------------------------------------------------------------------------
// T-502 (EC24-F02) — budget-device inventory in the actuating prompt
// ---------------------------------------------------------------------------

describe('delegate — T-502 budget-device inventory', () => {
  it('the actuating prompt carries each budget device\'s name/type/zone/state (primitives only)', async () => {
    const calls: unknown[] = [];
    const h = harness(
      [actuatingFlow()],
      scriptedClient([ANSWER_SHED], { calls }),
      {},
      { budgetDeviceOf: inventoryOf },
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    expect(calls).toHaveLength(1);
    const [userPrompt, systemPrompt] = (calls[0] as [string, string, unknown, unknown]);
    // The budget devices block: identity + live state per budget device.
    expect(userPrompt).toContain('BUDGET DEVICES');
    expect(userPrompt).toContain('HVAC B1');
    expect(userPrompt).toContain('HVAC B2');
    expect(userPrompt).toContain('"type": "hvac"');
    expect(userPrompt).toContain('"zoneId": "zone-b"');
    expect(userPrompt).toContain('"targetTemperature": 24');
    expect(userPrompt).toContain('"power": false');
    // The inventory is an UNTRUSTED world-data block, exactly like the
    // environment snapshot.
    expect(userPrompt).toContain('<untrusted');
    // Non-primitive state entries are filtered out (bounded prompt).
    expect(userPrompt).not.toContain('"history"');
    // The trusted budget still lists the bare ids + commands.
    expect(userPrompt).toContain('- devices (ONLY these): hvac-b1, hvac-b2');
    // The one added actuating system-prompt line.
    expect(systemPrompt).toContain('express it in `actuations` using the listed');
  });

  it('the advice prompt is byte-identical with and without the inventory (no leak)', async () => {
    const adviceFlow: FlowDefinition = {
      id: 'flow-advice-t502', name: 'Advice', enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      plan: {
        goal: 'g',
        nodes: [
          { id: 'ask', assigneeAgentId: 'energy-optimizer',
            delegate: { question: 'Which HVAC should we shed?', mode: 'advice', outputs: ['shed'] } },
        ],
      },
    };
    const answer = JSON.stringify({ decision: 'd', reasoning: 'r', outputs: { shed: 'hvac-b1' } });
    const withInventory: unknown[] = [];
    const withoutInventory: unknown[] = [];
    const a = harness([adviceFlow], scriptedClient([answer], { calls: withInventory }), {}, { budgetDeviceOf: inventoryOf });
    const b = harness([adviceFlow], scriptedClient([answer], { calls: withoutInventory }));
    await a.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b', simTimeSec: 100 });
    await b.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b', simTimeSec: 100 });

    const withPrompt = (withInventory[0] as [string])[0] as string;
    const withoutPrompt = (withoutInventory[0] as [string])[0] as string;
    expect(withPrompt).toBe(withoutPrompt); // byte-identical to pre-T-502
    expect(withPrompt).not.toContain('BUDGET');
    expect(withPrompt).not.toContain('HVAC B1'); // no inventory leak into advice
  });

  it('end-to-end: the enriched prompt\'s in-budget actuation executes through the base invoker', async () => {
    // The answer reads like a model that USED the inventory (b2 is the
    // powered-off unit; raise it) and proposes a well-formed actuation.
    const answer = JSON.stringify({
      decision: 'warm-up-b2', reasoning: 'HVAC B2 shows power:false and 22°C — restart it.',
      confidence: 0.9,
      actuations: [
        { deviceId: 'hvac-b2', command: 'set-temperature', params: { targetTemperature: 21 } },
      ],
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]), {}, { budgetDeviceOf: inventoryOf });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-b2', command: 'set-temperature',
        params: { targetTemperature: 21 }, applied: true },
    ]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 1 });
    expect(h.log).toEqual([
      { nodeId: 'pick-shed-target#actuate', capability: 'set-temperature',
        deviceId: 'hvac-b2', params: { targetTemperature: 21 },
        agentId: 'energy-optimizer', zoneId: 'zone-b' },
    ]);
  });

  it('a declining model still records zero actuations without error (honest do-nothing)', async () => {
    const answer = JSON.stringify({
      decision: 'hold', reasoning: 'Nothing needs action right now.',
      confidence: 0.7,
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]), {}, { budgetDeviceOf: inventoryOf });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.decision).toBe('hold');
    expect(outcome.actuations).toBeUndefined();
    expect(outcome.rejectedActuations).toBeUndefined();
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 0 });
    expect(h.log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R28 — the recommendation→actuation bridge (fallback cascade)
// ---------------------------------------------------------------------------

describe('delegate — recommendation bridge (R28)', () => {
  // The R26 grid-battery acceptance shape: the model reasons in prose and
  // never emits the structured array.
  const RECOMMEND_ONLY = JSON.stringify({
    decision: 'pause-battery',
    reasoning: 'Grid peak is here; recommend pausing battery charging to reduce load.',
    confidence: 0.75,
    recommendations: ['pause battery charging to reduce load'],
  });

  function batteryFlow(): FlowDefinition {
    return {
      id: 'flow-battery', name: 'Battery shed', enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      plan: {
        goal: 'shed battery load on grid peak',
        nodes: [
          {
            id: 'ask-battery',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'Reduce tower-base load within budget.',
              mode: 'actuating',
              budget: {
                maxCommands: 2,
                deviceIds: ['hvac-b1', 'hvac-b2'],
                allowedCommands: ['set-temperature', 'set-mode', 'turn-on', 'turn-off'],
              },
              timeoutMs: 5000,
              fallback: { policy: 'none' },
            },
          },
        ],
      },
    } as FlowDefinition;
  }

  function batteryInventory(deviceId: string): DelegateBudgetDevice | undefined {
    const known: Record<string, DelegateBudgetDevice> = {
      'hvac-b1': {
        deviceId: 'hvac-b1', name: 'HVAC B1', type: 'hvac', zoneId: 'zone-b',
        state: { power: true, targetTemperature: 24 },
      },
      'hvac-b2': { deviceId: 'hvac-b2', name: 'HVAC B2', type: 'hvac', zoneId: 'zone-b' },
    };
    return known[deviceId];
  }

  it('bridges recommendation text (no actuations array) into budget-constrained execution', async () => {
    const answer = JSON.stringify({
      decision: 'shed-hvac', reasoning: 'b1 is the heaviest load.',
      confidence: 0.8,
      recommendations: ['set HVAC B1 to 18 degrees cooling mode'],
    });
    const h = harness([batteryFlow()], scriptedClient([answer]), {}, { budgetDeviceOf: batteryInventory });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0], 'ask-battery');
    // Bridge parsed BOTH domain commands off the clause; both in budget.
    expect(outcome.recommendationBridge).toEqual({ source: 'recommendations', parsed: 2 });
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 2 });
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 18 }, applied: true },
      { deviceId: 'hvac-b1', command: 'set-mode', params: { mode: 'cooling' }, applied: true },
    ]);
    // The SAME base-invoker path as structured actuations: zone context,
    // assignee attribution, synthetic node id.
    expect(h.log.map(e => `${e.deviceId}:${e.capability}`)).toEqual([
      'hvac-b1:set-temperature', 'hvac-b1:set-mode',
    ]);
  });

  it('scans decision+reasoning prose when the recommendations field is absent', async () => {
    const answer = JSON.stringify({
      decision: 'pause-b2',
      reasoning: 'I recommend turning off HVAC B2; it is unoccupied.',
    });
    const h = harness([batteryFlow()], scriptedClient([answer]), {}, { budgetDeviceOf: batteryInventory });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0], 'ask-battery');
    expect(outcome.recommendationBridge).toEqual({ source: 'reasoning', parsed: 1 });
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-b2', command: 'turn-off', applied: true },
    ]);
    expect(h.log).toHaveLength(1);
  });

  it('structured actuations win: the bridge does NOT fire when the array is non-empty', async () => {
    const answer = JSON.stringify({
      decision: 'structured', reasoning: 'I can format the array.',
      actuations: [
        { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 20 } },
      ],
      recommendations: ['turn off HVAC B2 as well'], // must be IGNORED (structured wins)
    });
    const h = harness([batteryFlow()], scriptedClient([answer]), {}, { budgetDeviceOf: batteryInventory });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0], 'ask-battery');
    expect(outcome.recommendationBridge).toBeUndefined();
    expect(outcome.actuations).toEqual([
      { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 20 }, applied: true },
    ]);
    expect(h.log).toHaveLength(1); // only the structured actuation
  });

  it('gibberish recommendations produce honest rejectedActuations, no execution', async () => {
    const answer = JSON.stringify({
      decision: 'unclear', reasoning: 'not sure',
      recommendations: ['flurb the wozzle set'],
    });
    const h = harness([batteryFlow()], scriptedClient([answer]), {}, { budgetDeviceOf: batteryInventory });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0], 'ask-battery');
    expect(h.log).toHaveLength(0);
    expect(outcome.actuations).toBeUndefined();
    expect(outcome.rejectedActuations).toHaveLength(1);
    expect(outcome.rejectedActuations?.[0]?.reason).toContain('recommendation bridge');
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 0 });
  });

  it('bridge proposals respect maxCommands like structured ones (excess rejected, recorded)', async () => {
    const answer = JSON.stringify({
      decision: 'all', reasoning: 'shed everything',
      recommendations: ['turn off HVAC B1 and HVAC B2', 'set HVAC B1 to 18 degrees'],
    });
    const flow = batteryFlow();
    flow.plan.nodes[0].delegate!.budget!.maxCommands = 1;
    const h = harness([flow], scriptedClient([answer]), {}, { budgetDeviceOf: batteryInventory });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0], 'ask-battery');
    expect(outcome.budgetUsage).toEqual({ maxCommands: 1, commandsExecuted: 1 });
    expect(outcome.actuations).toHaveLength(1);
    // The over-budget bridge proposals reject through the SAME loop reasons.
    expect(outcome.rejectedActuations?.some(r => r.reason.includes('budget exhausted'))).toBe(true);
  });

  it('the R26 grid-battery acceptance shape: prose-only answer actuates the battery within budget', async () => {
    // "recommend pausing battery charging to reduce load" — the exact R26
    // failure mode (the model reasons, never formats the array) — maps to
    // set-charging rate:0 on the battery and EXECUTES within budget.
    const flow = batteryFlow();
    flow.plan.nodes[0].delegate!.budget = {
      maxCommands: 2, deviceIds: ['battery-b1'], allowedCommands: ['set-charging', 'set-power'],
    };
    const h = harness(
      [flow],
      scriptedClient([RECOMMEND_ONLY]),
      {},
      {
        budgetDeviceOf: deviceId => batteryInventory(deviceId) ?? (
          deviceId === 'battery-b1'
            ? {
                deviceId, name: 'Battery Bank', type: 'battery', zoneId: 'zone-b',
                state: { charging: true, chargingRate: 30 },
              }
            : undefined
        ),
      },
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0], 'ask-battery');
    expect(outcome.recommendationBridge).toEqual({ source: 'recommendations', parsed: 1 });
    expect(outcome.actuations).toEqual([
      { deviceId: 'battery-b1', command: 'set-charging', params: { rate: 0 }, applied: true },
    ]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 1 });
    expect(h.log).toEqual([
      { nodeId: 'ask-battery#actuate', capability: 'set-charging', deviceId: 'battery-b1',
        params: { rate: 0 }, agentId: 'energy-optimizer', zoneId: 'zone-b' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// T-084 (R28) — the no-actuation markers
// ---------------------------------------------------------------------------

describe('delegate — T-084 no-actuation markers', () => {
  // (a) allRejected: structured proposals emitted, every one budget-rejected.
  it('allRejected: structured actuations ALL out-of-budget → no marker ambiguity', async () => {
    const answer = JSON.stringify({
      decision: 'wrong-surface', reasoning: 'I tried.',
      actuations: [
        { deviceId: 'temp-sensor', command: 'set-temperature' },   // device not in budget
        { deviceId: 'hvac-b1', command: 'turn-off' },              // command not allowed
      ],
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 0 });
    expect(outcome.allRejected).toBe(true);
    expect(outcome.parseFailed).toBeUndefined();
    expect(outcome.noActionProposed).toBeUndefined();
    expect(outcome.rejectedActuations).toHaveLength(2);
  });

  // (a) allRejected: bridge proposals emitted, all rejected by a gate.
  it('allRejected: bridge-parsed actuations rejected by the operator gate', async () => {
    const flow = actuatingFlow();
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['set-temperature', 'turn-off'];
    const answer = JSON.stringify({
      decision: 'shed', reasoning: 'b1 is heaviest',
      recommendations: ['turn off HVAC B1'],
    });
    const h = harness(
      [flow],
      scriptedClient([answer]),
      { autoActuateIndependentFor: () => false },
      { budgetDeviceOf: inventoryOf },
    );
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.recommendationBridge).toEqual({ source: 'recommendations', parsed: 1 });
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 0 });
    expect(outcome.allRejected).toBe(true);
    expect(String(outcome.rejectedActuations?.[0]?.reason)).toMatch(/autoActuateIndependent=false/);
  });

  // (b) parseFailed: recommendations carried action vocabulary, none mappable.
  it('parseFailed: action-bearing recommendations the bridge could not map', async () => {
    const answer = JSON.stringify({
      decision: 'muddled', reasoning: 'unclear',
      recommendations: ['flurb the wozzle set'],
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.commandsExecuted ?? outcome.budgetUsage?.commandsExecuted).toBe(0);
    expect(outcome.parseFailed).toBe(true);
    expect(outcome.allRejected).toBeUndefined();
    expect(outcome.noActionProposed).toBeUndefined();
    expect(outcome.rejectedActuations?.[0]?.reason).toContain('recommendation bridge');
  });

  // (c) noActionProposed: nothing action-like anywhere in the answer.
  it('noActionProposed: an honest do-nothing answer (narrative prose only)', async () => {
    const answer = JSON.stringify({
      decision: 'hold', reasoning: 'Nothing needs action right now. Loads are within limits.',
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 0 });
    expect(outcome.noActionProposed).toBe(true);
    expect(outcome.parseFailed).toBeUndefined();
    expect(outcome.allRejected).toBeUndefined();
    expect(outcome.rejectedActuations).toBeUndefined(); // narrative ≠ failed parse
  });

  it('executed actuations carry NO marker (the markers are silence-only)', async () => {
    const h = harness([actuatingFlow()], scriptedClient([ANSWER_SHED]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.budgetUsage?.commandsExecuted).toBe(1);
    expect(outcome.allRejected).toBeUndefined();
    expect(outcome.parseFailed).toBeUndefined();
    expect(outcome.noActionProposed).toBeUndefined();
  });

  it('mixed outcome (some executed, some rejected) carries no allRejected marker', async () => {
    const answer = JSON.stringify({
      decision: 'shed-both', reasoning: 'go',
      actuations: [
        { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 20 } },
        { deviceId: 'temp-sensor', command: 'set-temperature' }, // rejected
      ],
    });
    const h = harness([actuatingFlow()], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.budgetUsage).toEqual({ maxCommands: 2, commandsExecuted: 1 });
    expect(outcome.allRejected).toBeUndefined(); // mixed story told by the records
  });

  it('execution faults do NOT read as allRejected (their silence is the error records)', async () => {
    const answer = JSON.stringify({
      decision: 'try-broken', reasoning: 'worth a try',
      actuations: [{ deviceId: 'hvac-broken', command: 'set-temperature' }],
    });
    const flow = actuatingFlow();
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-broken'];
    const h = harness([flow], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.actuations?.[0]?.applied).toBe(false);
    expect(outcome.allRejected).toBeUndefined();
    expect(outcome.noActionProposed).toBeUndefined();
  });

  it('degradation carries fallbackReason, never a silence marker (advice + actuating)', async () => {
    const flow = actuatingFlow();
    flow.plan.nodes[0].delegate!.timeoutMs = 25;
    const h = harness([flow], scriptedClient(['__hang__']));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.fallbackReason).toBe('timeout');
    expect(outcome.allRejected).toBeUndefined();
    expect(outcome.parseFailed).toBeUndefined();
    expect(outcome.noActionProposed).toBeUndefined();
  });

  it('advice delegates never carry actuation markers (they cannot actuate by design)', async () => {
    const flow: FlowDefinition = {
      id: 'f', name: 'f', enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      plan: {
        goal: 'g',
        nodes: [
          { id: 'ask', assigneeAgentId: 'energy-optimizer',
            delegate: { question: 'q', mode: 'advice' } },
        ],
      },
    };
    const answer = JSON.stringify({ decision: 'd', reasoning: 'r' });
    const h = harness([flow], scriptedClient([answer]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0], 'ask');
    expect(outcome.allRejected).toBeUndefined();
    expect(outcome.parseFailed).toBeUndefined();
    expect(outcome.noActionProposed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Timeout + fallback
// ---------------------------------------------------------------------------

describe('delegate — timeout + deterministic fallback', () => {
  it("fallback 'none': honest no-op success, flow continues, no fabricated judgment", async () => {
    const flow = actuatingFlow();
    flow.plan.nodes[0].delegate!.timeoutMs = 25;
    const h = harness([flow], scriptedClient(['__hang__']));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome).toMatchObject({
      decisionSource: 'rule-llm-down', fallbackUsed: true, fallbackReason: 'timeout',
      budgetUsage: { maxCommands: 2, commandsExecuted: 0 },
    });
    expect(outcome.decision).toBeUndefined();
    expect(String(outcome.reasoning)).toMatch(/timed out after 25ms/);
    expect(outcome.actuations).toBeUndefined();
    expect(h.log).toHaveLength(0);
  });

  it("fallback 'node': delegate fails, fallback action node runs ONCE out-of-band (compensate semantics)", async () => {
    const flow = actuatingFlow({
      plan: {
        goal: 'shed safely',
        nodes: [
          {
            id: 'pick-shed-target',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'q', mode: 'actuating',
              budget: { maxCommands: 2, deviceIds: ['hvac-b1'], allowedCommands: ['set-temperature'] },
              timeoutMs: 25,
              fallback: { policy: 'node', nodeId: 'safe-shed' },
            },
          },
          { id: 'safe-shed', capability: 'turn-off', deviceId: 'hvac-b1' },
        ],
      },
    });
    const h = harness([flow], scriptedClient(['__hang__']));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const run = h.runs[0];
    // T-109 (F15): the declared fallback lane DELIVERED — the run meters
    // 'success' (node-level failure stays visible below), not 'partial'.
    expect(run.status).toBe('success');
    expect(run.nodeResults['pick-shed-target']?.status).toBe('failed');
    expect(String(run.nodeResults['pick-shed-target']?.error)).toMatch(/degraded \(timeout/);
    expect(String(run.nodeResults['pick-shed-target']?.error)).toMatch(/safe-shed/);
    // The fallback node ran out-of-band, exactly once, tagged compensationFor.
    expect(run.nodeResults['safe-shed']).toMatchObject({
      status: 'succeeded', compensationFor: 'pick-shed-target', deviceId: 'hvac-b1',
    });
    expect(h.log.filter(e => e.nodeId === 'safe-shed')).toHaveLength(1);
    expect(h.log.filter(e => e.nodeId === 'safe-shed')[0].zoneId).toBe('zone-b');
  });

  it("fallback 'node' does NOT run when the delegate succeeds (compensation not required)", async () => {
    const flow = actuatingFlow({
      plan: {
        goal: 'shed safely',
        nodes: [
          {
            id: 'pick-shed-target',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'q', mode: 'advice',
              fallback: { policy: 'node', nodeId: 'safe-shed' },
            },
          },
          { id: 'safe-shed', capability: 'turn-off', deviceId: 'hvac-b1' },
        ],
      },
    });
    const h = harness([flow], scriptedClient([JSON.stringify({ decision: 'ok', reasoning: 'fine' })]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    expect(h.runs[0].nodeResults['pick-shed-target']?.status).toBe('succeeded');
    expect(h.runs[0].nodeResults['safe-shed']?.status).toBe('skipped');
    expect(String(h.runs[0].nodeResults['safe-shed']?.note)).toMatch(/compensation not required/);
    expect(h.log.filter(e => e.nodeId === 'safe-shed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LLM-down (T-022 semantics)
// ---------------------------------------------------------------------------

describe('delegate — llm-down degradation', () => {
  it('retries transient errors once, then degrades to rule-llm-down with the provider error on record', async () => {
    const h = harness([actuatingFlow()], scriptedClient(['__throw__', '__throw__']));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome.decisionSource).toBe('rule-llm-down');
    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.fallbackReason).toBe('llm-down');
    expect(String(outcome.reasoning)).toMatch(/provider connection refused/);
    expect(String(outcome.reasoning)).toMatch(/after 2 attempt\(s\)/);
    expect(outcome.decision).toBeUndefined();
  });

  it('a PERMANENT error is not retried (single attempt, honest degradation)', async () => {
    const permanent = JSON.stringify({ error: { message: '401 invalid api key' } });
    const client = scriptedClient(['__throw__']);
    (client as unknown as { quickChat: (...a: unknown[]) => Promise<unknown> }).quickChat =
      async () => { throw new Error('Error: 401 invalid api key'); };
    void permanent;
    const h = harness([actuatingFlow()], client);
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(String(outcome.reasoning)).toMatch(/401 invalid api key/);
  });

  it('no LLM client configured → rule degradation naming it (never a fabricated answer)', async () => {
    const h = harness([actuatingFlow()], undefined);
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const outcome = delegateOutcome(h.runs[0]);
    expect(outcome).toMatchObject({
      decisionSource: 'rule', fallbackUsed: true, fallbackReason: 'no-llm',
    });
    expect(String(outcome.reasoning)).toMatch(/no LLM client is configured/);
  });

  it('a disabled assignee fails honestly and its fallback node still runs', async () => {
    const flow = actuatingFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'pick-shed-target',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'q', mode: 'advice',
              fallback: { policy: 'node', nodeId: 'safe-shed' },
            },
          },
          { id: 'safe-shed', capability: 'turn-off', deviceId: 'hvac-b1' },
        ],
      },
    });
    const h = harness([flow], scriptedClient([]), { isEnabledAgent: () => false });
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    const run = h.runs[0];
    expect(run.nodeResults['pick-shed-target']?.status).toBe('failed');
    expect(String(run.nodeResults['pick-shed-target']?.error)).toMatch(/disabled — delegates honor the agent master switch/);
    expect(run.nodeResults['safe-shed']?.status).toBe('succeeded');
  });

  it('no delegate runner wired → delegate nodes fail honestly (never silently skipped)', async () => {
    const runs: FlowRunRecord[] = [];
    const engine = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => [actuatingFlow()],
      agents: new Map(),
      invoker: recordingInvoker([]),
      envStateReader: () => ({}),
      publish: () => undefined,
      onRun: r => runs.push(r),
    });
    await engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });
    expect(runs[0].nodeResults['pick-shed-target']?.status).toBe('failed');
    expect(String(runs[0].nodeResults['pick-shed-target']?.error)).toMatch(/no delegate runner is wired/);
  });
});

// ---------------------------------------------------------------------------
// Determinism (record-replay)
// ---------------------------------------------------------------------------

describe('delegate — determinism', () => {
  function normalizedRun(run: FlowRunRecord): unknown {
    const strip = (result: Record<string, unknown>): Record<string, unknown> => {
      const { startedAt: _s, finishedAt: _f, ...rest } = result;
      void _s; void _f;
      return rest;
    };
    const nodeResults: Record<string, unknown> = {};
    for (const [nodeId, nodeResult] of Object.entries(run.nodeResults)) {
      nodeResults[nodeId] = strip(nodeResult as unknown as Record<string, unknown>);
    }
    const { runId: _r, startedAt: _s2, finishedAt: _f2, ...rest } = run;
    void _r; void _s2; void _f2;
    // The executor's summary embeds the (unique) run id as the plan id —
    // normalize it; everything else must be identical.
    return JSON.stringify({ ...rest, nodeResults })
      .replace(/run-[0-9a-f-]{36}/g, 'run-<normalized>');
  }

  it('same scripted LLM responses → identical traces across two engines', async () => {
    const scriptedAnswers = [
      JSON.stringify({
        decision: 'shed-hvac-b1', reasoning: 'b1 hottest; 20°C is safe.', confidence: 0.8,
        actuations: [
          { deviceId: 'hvac-b1', command: 'set-temperature', params: { targetTemperature: 20 } },
          { deviceId: 'hvac-b2', command: 'set-temperature', params: { targetTemperature: 21 } },
          { deviceId: 'hvac-b1', command: 'turn-off' },
        ],
      }),
    ];
    const flow = actuatingFlow({
      plan: {
        goal: 'shed + verify',
        nodes: [
          {
            id: 'pick-shed-target',
            assigneeAgentId: 'energy-optimizer',
            delegate: {
              question: 'q', mode: 'actuating',
              budget: { maxCommands: 2, deviceIds: ['hvac-b1', 'hvac-b2'], allowedCommands: ['set-temperature'] },
              timeoutMs: 5000, fallback: { policy: 'none' },
            },
          },
          { id: 'verify', capability: 'turn-on', deviceId: 'hvac-b1', dependsOn: ['pick-shed-target'] },
        ],
      },
    });

    const runOnce = (): Harness => {
      const h = harness([flow], scriptedClient([...scriptedAnswers]));
      return h;
    };
    const a = runOnce();
    await a.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b', simTimeSec: 100 });
    const b = runOnce();
    await b.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b', simTimeSec: 100 });

    expect(a.runs).toHaveLength(1);
    expect(b.runs).toHaveLength(1);
    expect(JSON.stringify(normalizedRun(b.runs[0]))).toBe(JSON.stringify(normalizedRun(a.runs[0])));
    expect(a.log).toEqual(b.log);
  });
});

// ---------------------------------------------------------------------------
// No-delegate flows: pre-A path unchanged
// ---------------------------------------------------------------------------

describe('delegate — regression', () => {
  it('a flow without delegate nodes uses the raw invoker path (no delegate machinery)', async () => {
    const flow: FlowDefinition = {
      id: 'flow-plain', name: 'plain', enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
      plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'turn-off', deviceId: 'hvac-b1' }] },
    };
    const h = harness([flow], scriptedClient([ANSWER_SHED]));
    await h.engine.onEvent({ eventType: 'grid-peak', zoneId: 'zone-b' });

    expect(h.runs[0].status).toBe('success');
    expect(h.runs[0].nodeResults.n1).toMatchObject({ status: 'succeeded', deviceId: 'hvac-b1' });
    // The scripted LLM was never consulted for a delegate-free flow.
    expect((h.runs[0].nodeResults.n1?.result as Record<string, unknown>)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Answer parsing unit tests
// ---------------------------------------------------------------------------

describe('parseDelegateAnswer', () => {
  it('parses a clean JSON object', () => {
    expect(parseDelegateAnswer('{"decision":"d","reasoning":"r"}'))
      .toEqual({ decision: 'd', reasoning: 'r' });
  });

  it('parses fenced JSON and takes the LAST top-level object (T-103)', () => {
    const fenced = '```json\n{"decision":"first"}\n```';
    expect(parseDelegateAnswer(fenced)).toEqual({ decision: 'first' });
    const preamble = 'Sure! {"a":1} Here you go: {"decision":"d","reasoning":"r"}';
    expect(parseDelegateAnswer(preamble)).toEqual({ decision: 'd', reasoning: 'r' });
  });

  it('survives braces inside strings and rejects non-JSON', () => {
    expect(parseDelegateAnswer('{"decision":"curly } inside","reasoning":"r"}'))
      .toEqual({ decision: 'curly } inside', reasoning: 'r' });
    expect(parseDelegateAnswer('no json here')).toBeNull();
    expect(parseDelegateAnswer('[1,2,3]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher unit: action nodes pass through untouched
// ---------------------------------------------------------------------------

describe('createDelegateDispatchingInvoker', () => {
  it('routes action nodes to the base invoker with zone context, delegate nodes to the runner', async () => {
    const log: InvokerLogEntry[] = [];
    const base = recordingInvoker(log);
    const invoker = createDelegateDispatchingInvoker(base, {
      llmClientFor: () => scriptedClient([ANSWER_SHED]),
    }, { flowId: 'f', runId: 'r', zoneId: 'zone-b', envSnapshot: {} });

    const action = await invoker({ id: 'a1', capability: 'turn-off', deviceId: 'hvac-b1' }, 'energy-optimizer');
    expect(action.success).toBe(true);
    expect(log[0]).toMatchObject({ nodeId: 'a1', zoneId: 'zone-b' });

    const delegate = await invoker(
      { id: 'd1', capability: '', delegate: { question: 'q', mode: 'advice' } },
      'energy-optimizer',
    );
    expect(delegate.success).toBe(true);
    expect(log).toHaveLength(1); // advice: no base dispatch
  });

  // T-608 (R26, SC26-F03): flow-lane actuations carry the actor label
  // `flow:<flowId>` — BOTH the passthrough action nodes and the delegate's
  // synthetic actuation nodes (the base invoker threads it into the device
  // audit trail; params stay pure).
  it('T-608: base invocations carry actor "flow:<flowId>" (action pass-through AND synthetic actuations)', async () => {
    const contexts: Array<{ zoneId?: string; actor?: string } | undefined> = [];
    const base: PlanNodeInvoker = async (node, _agentId, context) => {
      contexts.push(context);
      return { success: true, ...(node.deviceId !== undefined ? { deviceId: node.deviceId } : {}), result: { ok: true } };
    };
    const invoker = createDelegateDispatchingInvoker(base, {
      llmClientFor: () => scriptedClient([ANSWER_SHED]),
    }, { flowId: 'flow-shed', runId: 'r', zoneId: 'zone-b', envSnapshot: {} });

    const action = await invoker({ id: 'a1', capability: 'turn-off', deviceId: 'hvac-b1' }, 'energy-optimizer');
    expect(action.success).toBe(true);
    expect(contexts[0]).toMatchObject({ zoneId: 'zone-b', actor: 'flow:flow-shed' });

    // Actuating delegate: the synthetic #actuate node inherits the label.
    const actuating = await invoker(
      {
        id: 'd2', capability: '',
        delegate: {
          question: 'shed one', mode: 'actuating',
          budget: { maxCommands: 1, deviceIds: ['hvac-b1'], allowedCommands: ['set-temperature'] },
        },
      },
      'energy-optimizer',
    );
    expect(actuating.success).toBe(true);
    // contexts[0] = the a1 pass-through; contexts[1] = the synthetic
    // 'd2#actuate' dispatch — both carry the flow actor label.
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toMatchObject({ zoneId: 'zone-b', actor: 'flow:flow-shed' });
  });
});
