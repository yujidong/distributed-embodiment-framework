/**
 * @vitest-environment node
 *
 * FEAT-05 + FEAT-06 — flow NOTIFY and WAIT nodes:
 *   - authoring: the mutual-exclusion teaching pre-check covers the two new
 *     kinds (stray fields refused loudly), validateNotifyNodes' target rules
 *     (agent/role/owner), validateWaitNodes' no-dependents warning;
 *   - notify lane: dispatch to the injected FlowNotifyInvoker (never the
 *     own-devices invoker), the unwired lane's honest failure, recipients
 *     riding the run ledger's node result;
 *   - wait lane: deterministic sim-clock staggering — waves split at wait
 *     nodes, the run parks (intermediate 'waiting' record, nothing
 *     persisted), resumes from onTick at the due sim second, chained and
 *     staggered waits, boundary propagation (failed/skipped waits),
 *     checkpoint survival, and the flow-vanished-mid-wait honest failure.
 */

import { describe, it, expect } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvocation, PlanNodeInvoker } from '../../workflow/plan-executor.js';
import {
  FlowEngine,
  FLOW_BUILTIN_NODE_ASSIGNEE,
  computeCapabilityDrift,
  resolveFlowAssignments,
  validateFlow,
  type FlowDefinition,
  type FlowNotifyInvoker,
  type FlowRunRecord,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function testScenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'notify-wait-test', name: 'Notify/Wait Test' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'hvac-a', type: 'hvac',
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
    ],
    events: [],
  });
}

function flowOf(nodes: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'flow-1',
    name: 'Test flow',
    enabled: true,
    trigger: { kind: 'event', eventType: 'demand-surge', zoneId: 'zone-a' },
    plan: { goal: 'test', nodes },
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
  nodeId: string;
  agentId: string;
}

interface Harness {
  engine: FlowEngine;
  runs: FlowRunRecord[];
  log: InvokerLogEntry[];
  notifyLog: Array<{ nodeId: string; flowId?: string }>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function harness(
  flows: FlowDefinition[] | (() => FlowDefinition[]),
  options: {
    invoker?: PlanNodeInvoker;
    notifyInvoker?: FlowNotifyInvoker;
    envState?: Record<string, unknown>;
  } = {},
): Harness {
  const runs: FlowRunRecord[] = [];
  const log: InvokerLogEntry[] = [];
  const notifyLog: Array<{ nodeId: string; flowId?: string }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const invoker: PlanNodeInvoker = options.invoker ?? (async (node, agentId): Promise<PlanNodeInvocation> => {
    log.push({ nodeId: node.id, agentId });
    return { success: true, result: { ok: true } };
  });
  const notifyInvoker: FlowNotifyInvoker = options.notifyInvoker ?? (async (node, context) => {
    notifyLog.push({ nodeId: node.id, ...(context?.flowId !== undefined ? { flowId: context.flowId } : {}) });
    return { success: true, result: { recipients: ['owner-1'], notificationIds: ['ntf-1'] } };
  });
  const engine = new FlowEngine({
    scenario: testScenario(),
    flowsProvider: typeof flows === 'function' ? flows : () => flows,
    agents: new Map(),
    invoker,
    envStateReader: () => options.envState ?? { 'zone-a': { temperature: 29 } },
    publish: (type, payload) => events.push({ type, payload }),
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
    notifyInvoker,
  });
  return { engine, runs, log, notifyLog, events };
}

function fireDemand(engine: FlowEngine, simTimeSec: number): Promise<void> {
  return engine.onEvent({ eventType: 'demand-surge', zoneId: 'zone-a', simTimeSec });
}

// ---------------------------------------------------------------------------
// FEAT-05 — authoring validation
// ---------------------------------------------------------------------------

describe('notify node — authoring validation', () => {
  const notifyNode = { id: 'n1', notify: { to: 'owner', message: 'grid peak incoming' } };

  it('accepts a well-formed notify node (to owner/agent/role)', () => {
    expect(errorsOf(validateFlow(flowOf([notifyNode]), testScenario()))).toEqual([]);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'agent', target: 'agent-a', message: 'check your HVAC' } },
    ]), testScenario()))).toEqual([]);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'role', target: 'builder', message: 'heads up' } },
    ]), testScenario()))).toEqual([]);
  });

  it('mutual exclusion: capability + notify is a teaching error naming all five kinds', () => {
    const issues = errorsOf(validateFlow(flowOf([
      { id: 'n1', capability: 'cooling', notify: { to: 'owner', message: 'm' } },
    ]), testScenario()));
    expect(issues.some(m => m.includes('EXACTLY ONE') && m.includes('notify node') && m.includes('wait node'))).toBe(true);
  });

  it('stray action fields on a notify node are refused loudly', () => {
    const issues = errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'owner', message: 'm' }, params: { x: 1 }, deviceId: 'hvac-a' },
    ]), testScenario()));
    expect(issues.some(m => m.includes("'params'") && m.includes("'deviceId'") && m.includes('user inboxes'))).toBe(true);
  });

  it("to='owner' forbids a target (silently meaningless otherwise)", () => {
    const issues = errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'owner', target: 'agent-a', message: 'm' } },
    ]), testScenario()));
    expect(issues.some(m => m.includes("targets 'owner'") && m.includes('drop the target'))).toBe(true);
  });

  it("to='agent'/'role' require a target; a typo'd role is an error; a dangling agent is a dead reference", () => {
    expect(errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'agent', message: 'm' } },
    ]), testScenario())).some(m => m.includes("targets 'agent'") && m.includes('no target'))).toBe(true);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'role', message: 'm' } },
    ]), testScenario())).some(m => m.includes('owner') && m.includes('builder') && m.includes('viewer'))).toBe(true);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'role', target: 'janitor', message: 'm' } },
    ]), testScenario())).some(m => m.includes("role 'janitor'") && m.includes('silently notify nobody'))).toBe(true);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'n1', notify: { to: 'agent', target: 'agent-ghost', message: 'm' } },
    ]), testScenario())).some(m => m.includes("agent 'agent-ghost'") && m.includes('does not exist'))).toBe(true);
  });

  it('a node with none of the five kind blocks names all five in the teaching error', () => {
    const issues = errorsOf(validateFlow(flowOf([{ id: 'n1' }]), testScenario()));
    expect(issues.some(m =>
      m.includes("'notify'") && m.includes("'wait'") && m.includes('notify block {to, target?, message}'),
    )).toBe(true);
  });

  it('notify nodes resolve no assignee and never drift', () => {
    const flow = flowOf([notifyNode]);
    const { assignments, issues } = resolveFlowAssignments(flow, testScenario());
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
    expect(assignments.get('n1')).toBe(FLOW_BUILTIN_NODE_ASSIGNEE);
    expect(computeCapabilityDrift(flow, assignments, () => [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FEAT-05 — runtime lane
// ---------------------------------------------------------------------------

describe('notify node — runtime lane', () => {
  it('dispatches to the notify lane (never the own-devices invoker); the result rides the run ledger', async () => {
    const h = harness([flowOf([
      { id: 'a1', capability: 'set-temperature', deviceId: 'hvac-a', params: { targetTemperature: 20 } },
      { id: 'n1', dependsOn: ['a1'], notify: { to: 'owner', message: 'setback applied' } },
    ])]);
    await fireDemand(h.engine, 100);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']); // own-devices invoker saw only the action node
    expect(h.notifyLog).toEqual([{ nodeId: 'n1', flowId: 'flow-1' }]);
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0]!;
    expect(run.status).toBe('success');
    expect(run.nodeResults['n1']?.status).toBe('succeeded');
    expect(run.nodeResults['n1']?.result).toEqual({ recipients: ['owner-1'], notificationIds: ['ntf-1'] });
  });

  it('an unwired lane is an honest node failure, never a silent skip', async () => {
    const h = harness([flowOf([
      { id: 'n1', notify: { to: 'owner', message: 'm' } },
    ])]);
    // Late-unbind: simulate a runtime with no notification lane.
    (h.engine as unknown as { notifyInvoker?: unknown }).notifyInvoker = undefined;
    await fireDemand(h.engine, 100);
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0]!;
    expect(run.status).toBe('failed');
    expect(run.nodeResults['n1']?.error).toContain('no notification lane wired');
  });

  it('a lane fault is an honest node failure (the serial queue drains)', async () => {
    const h = harness(
      [flowOf([{ id: 'n1', notify: { to: 'owner', message: 'm' } }])],
      {
        notifyInvoker: async () => ({ success: false, error: "no member holds role 'builder'" }),
      },
    );
    await fireDemand(h.engine, 100);
    expect(h.runs[0]?.status).toBe('failed');
    expect(h.runs[0]?.nodeResults['n1']?.error).toContain("no member holds role 'builder'");
  });
});

// ---------------------------------------------------------------------------
// FEAT-06 — authoring validation
// ---------------------------------------------------------------------------

describe('wait node — authoring validation', () => {
  it('accepts a well-formed wait node; warns when nothing depends on it', () => {
    const flow = flowOf([
      { id: 'a1', capability: 'set-temperature', deviceId: 'hvac-a' },
      { id: 'w1', dependsOn: ['a1'], wait: { simSec: 300 } },
      { id: 'a2', dependsOn: ['w1'], capability: 'set-temperature', deviceId: 'hvac-a' },
    ]);
    expect(errorsOf(validateFlow(flow, testScenario()))).toEqual([]);
    expect(warningsOf(validateFlow(flow, testScenario())).some(m => m.includes('delays nothing'))).toBe(false);

    const dangling = flowOf([{ id: 'w1', wait: { simSec: 60 } }]);
    expect(errorsOf(validateFlow(dangling, testScenario()))).toEqual([]);
    expect(warningsOf(validateFlow(dangling, testScenario()))
      .some(m => m.includes("wait node 'w1' has no dependents") && m.includes('delays nothing'))).toBe(true);
  });

  it('mutual exclusion + stray fields teach; simSec must be positive (closed schema)', () => {
    expect(errorsOf(validateFlow(flowOf([
      { id: 'w1', wait: { simSec: 60 }, service: { serviceId: 'svc' } },
    ]), testScenario())).some(m => m.includes('EXACTLY ONE'))).toBe(true);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'w1', wait: { simSec: 60 }, assigneeAgentId: 'agent-a' },
    ]), testScenario())).some(m => m.includes("'assigneeAgentId'") && m.includes('sim-clock delay'))).toBe(true);
    expect(errorsOf(validateFlow(flowOf([
      { id: 'w1', wait: { simSec: 0 } },
    ]), testScenario())).some(m => m.includes('simSec'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FEAT-06 — deterministic staggering
// ---------------------------------------------------------------------------

describe('wait node — deterministic sim-clock staggering', () => {
  const chainFlow = () => flowOf([
    { id: 'a1', capability: 'set-temperature', deviceId: 'hvac-a', params: { targetTemperature: 24 } },
    { id: 'w1', dependsOn: ['a1'], wait: { simSec: 300 } },
    { id: 'a2', dependsOn: ['w1'], capability: 'set-temperature', deviceId: 'hvac-a', params: { targetTemperature: 20 } },
  ]);

  it('a three-node chain staggers exactly at the declared sim second and the ledger records the schedule', async () => {
    const h = harness([chainFlow()]);
    await fireDemand(h.engine, 100);
    // Wave 1: a1 executed; the wait armed at 100 + 300; a2 NOT yet; no run record.
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']);
    expect(h.runs).toEqual([]);
    expect(h.events.some(e => e.type === 'flow.executed')).toBe(false);
    expect(h.engine.waitDueSimSecs()).toEqual([400]);

    await h.engine.onTick(399);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']); // not due yet
    expect(h.runs).toEqual([]);

    await h.engine.onTick(400);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1', 'a2']); // resumed exactly at due
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0]!;
    expect(run.status).toBe('success');
    expect(Object.keys(run.nodeResults).sort()).toEqual(['a1', 'a2', 'w1']);
    expect(run.nodeResults['w1']).toMatchObject({
      status: 'succeeded',
      result: { waitSimSec: 300, dueSimSec: 400, resumedAtSimSec: 400 },
    });
    expect(h.engine.waitDueSimSecs()).toEqual([]);
  });

  it('runDirect answers an honest intermediate WAITING record — never persisted, never published', async () => {
    const h = harness([chainFlow()]);
    await h.engine.onTick(100); // anchor the engine clock
    const intermediate = await h.engine.runDirect('flow-1', 'manual');
    expect(intermediate).not.toBeNull();
    expect(intermediate!.status).toBe('waiting');
    expect(intermediate!.summary).toContain('parked on a wait node');
    expect(intermediate!.waiting).toEqual({ resumeAtSimSec: 400, pendingNodeIds: ['w1', 'a2'] });
    expect(Object.keys(intermediate!.nodeResults).sort()).toEqual(['a1', 'w1']); // the armed schedule is recorded
    // Nothing landed on the ledger/bus yet — one row per run, at completion.
    expect(h.runs).toEqual([]);
    expect(h.events.some(e => e.type === 'flow.executed')).toBe(false);

    await h.engine.onTick(400);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.runId).toBe(intermediate!.runId); // same run, terminal record
    expect(h.runs[0]!.status).toBe('success');
  });

  it('chained waits resume wave by wave (a1 → +100s → a2 → +50s → a3)', async () => {
    const h = harness([flowOf([
      { id: 'a1', capability: 'set-temperature', deviceId: 'hvac-a' },
      { id: 'w1', dependsOn: ['a1'], wait: { simSec: 100 } },
      { id: 'a2', dependsOn: ['w1'], capability: 'set-temperature', deviceId: 'hvac-a' },
      { id: 'w2', dependsOn: ['a2'], wait: { simSec: 50 } },
      { id: 'a3', dependsOn: ['w2'], capability: 'set-temperature', deviceId: 'hvac-a' },
    ])]);
    await fireDemand(h.engine, 1000);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']);
    expect(h.engine.waitDueSimSecs()).toEqual([1100]);

    await h.engine.onTick(1100);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1', 'a2']);
    expect(h.runs).toEqual([]); // w2 armed at 1150 — still parked
    expect(h.engine.waitDueSimSecs()).toEqual([1150]);

    await h.engine.onTick(1150);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1', 'a2', 'a3']);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.status).toBe('success');
    expect(h.runs[0]!.nodeResults['w2']?.result).toMatchObject({ waitSimSec: 50, dueSimSec: 1150, resumedAtSimSec: 1150 });
  });

  it('staggered branches: each wait resumes at its own due inside one run', async () => {
    const h = harness([flowOf([
      { id: 'a1', capability: 'set-temperature', deviceId: 'hvac-a' },
      { id: 'w1', dependsOn: ['a1'], wait: { simSec: 100 } },
      { id: 'b1', dependsOn: ['w1'], capability: 'set-temperature', deviceId: 'hvac-a' },
      { id: 'w2', dependsOn: ['a1'], wait: { simSec: 300 } },
      { id: 'b2', dependsOn: ['w2'], capability: 'set-temperature', deviceId: 'hvac-a' },
    ])]);
    await fireDemand(h.engine, 0);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']);
    // One parked continuation — its EARLIEST armed due is the wake moment.
    expect(h.engine.waitDueSimSecs()).toEqual([100]);

    await h.engine.onTick(100);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1', 'b1']);
    expect(h.runs).toEqual([]); // b2's wait still armed

    await h.engine.onTick(300);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1', 'b1', 'b2']);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.status).toBe('success');
  });

  it('a condition-skipped wait resolves its dependents WITHOUT a sim-time wait (executor skip semantics)', async () => {
    const h = harness(
      [flowOf([
        { id: 'a1', capability: 'set-temperature', deviceId: 'hvac-a' },
        { id: 'w1', dependsOn: ['a1'], wait: { simSec: 300 }, condition: 'temperature > 100' },
        { id: 'a2', dependsOn: ['w1'], capability: 'set-temperature', deviceId: 'hvac-a' },
      ])],
      { envState: { 'zone-a': { temperature: 29 } } },
    );
    await fireDemand(h.engine, 100);
    // The wait evaluated false → skipped → the dependent subtree skipped,
    // the run completes immediately (no parking).
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.status).toBe('success');
    expect(h.runs[0]!.nodeResults['w1']?.status).toBe('skipped');
    expect(h.runs[0]!.nodeResults['a2']?.status).toBe('skipped');
    expect(h.engine.waitDueSimSecs()).toEqual([]);
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']);
  });

  it('a failed prerequisite blocks the wait and its downstream across the wave boundary', async () => {
    const failingInvoker: PlanNodeInvoker = async node =>
      node.id === 'a1'
        ? { success: false, error: 'device offline' }
        : { success: true, result: { ok: true } };
    const h = harness([chainFlow()], { invoker: failingInvoker });
    await fireDemand(h.engine, 100);
    expect(h.runs).toHaveLength(1);
    const run = h.runs[0]!;
    expect(run.status).toBe('failed');
    expect(run.nodeResults['a1']?.status).toBe('failed');
    expect(run.nodeResults['w1']?.status).toBe('blocked');
    expect(run.nodeResults['w1']?.error).toBe("dependency 'a1' failed");
    expect(run.nodeResults['a2']?.status).toBe('blocked');
    expect(h.engine.waitDueSimSecs()).toEqual([]); // nothing armed — no parking
  });

  it('a flow deleted while parked fails the run honestly at the due tick', async () => {
    let flows = [chainFlow()];
    const h = harness(() => flows);
    await fireDemand(h.engine, 100);
    expect(h.engine.waitDueSimSecs()).toEqual([400]);
    flows = []; // deleted mid-wait
    await h.engine.onTick(400);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.status).toBe('failed');
    expect(h.runs[0]!.summary).toContain('was removed while parked on a wait node');
    expect(h.log.map(e => e.nodeId)).toEqual(['a1']); // a2 never ran
  });

  it('a parked run survives export/restore (hibernate → resume keeps the schedule)', async () => {
    const flow = chainFlow();
    const h1 = harness([flow]);
    await fireDemand(h1.engine, 100);
    expect(h1.log.map(e => e.nodeId)).toEqual(['a1']);
    const snapshot = h1.engine.exportTriggerState();
    expect(snapshot.waitContinuations).toHaveLength(1);
    expect(snapshot.waitContinuations![0]).toMatchObject({
      flowId: 'flow-1',
      armedWaits: [{ nodeId: 'w1', dueSimSec: 400 }],
      executedNodeIds: ['a1', 'w1'],
    });

    // A fresh engine (post-restart) adopts the checkpoint and resumes.
    const h2 = harness([flow]);
    h2.engine.restoreTriggerState(snapshot);
    expect(h2.engine.waitDueSimSecs()).toEqual([400]);
    await h2.engine.onTick(400);
    expect(h2.log.map(e => e.nodeId)).toEqual(['a2']); // only the remaining wave
    expect(h2.runs).toHaveLength(1);
    expect(h2.runs[0]!.status).toBe('success');
    expect(h2.runs[0]!.nodeResults['a1']?.status).toBe('succeeded'); // wave-1 results carried over
    expect(h2.runs[0]!.nodeResults['w1']?.result).toMatchObject({ resumedAtSimSec: 400 });
  });

  it('two engines with the same timeline produce identical staggered traces (determinism)', async () => {
    const drive = async (): Promise<{ log: InvokerLogEntry[]; runs: FlowRunRecord[] }> => {
      const h = harness([chainFlow()]);
      await fireDemand(h.engine, 100);
      await h.engine.onTick(399);
      await h.engine.onTick(400);
      return { log: h.log, runs: h.runs };
    };
    const first = await drive();
    const second = await drive();
    expect(first.log).toEqual(second.log);
    const normalize = (runs: FlowRunRecord[]) =>
      runs.map(r => [r.status, r.summary.replace(r.runId, '<runId>')]);
    expect(normalize(first.runs)).toEqual(normalize(second.runs));
  });
});
