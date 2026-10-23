/**
 * @vitest-environment node
 *
 * Deterministic plan executor tests (P4-3, no LLM backend):
 *   - success chains + topological wave ordering
 *   - condition guards (true / false / unresolved → skip subtree)
 *   - failure policies: retry (backoff, exhaustion), compensate, abort
 *   - fault-injected device failures (invoker throws / reports failure)
 *   - the executor NEVER throws across its boundary
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PlanExecutor,
  type PlanNodeInvocation,
  type PlanNodeInvoker,
} from '../plan-executor.js';
import type { PlanNode, WorkflowPlan } from '../plan-schema.js';

function makePlan(nodes: PlanNode[]): WorkflowPlan {
  return {
    id: 'plan-exec-test',
    goal: 'executor test goal',
    nodes,
    metadata: { author: 'manual', createdAt: '2026-07-22T00:00:00.000Z' },
  };
}

function assignmentsFor(plan: WorkflowPlan, agentId = 'agent-1'): Map<string, string> {
  return new Map(plan.nodes.map(n => [n.id, agentId]));
}

/** Invoker that records call order and always succeeds. */
function recordingInvoker(calls: string[] = []): PlanNodeInvoker {
  return async (node) => {
    calls.push(node.id);
    return { success: true, result: { node: node.id } };
  };
}

function immediateExecutor(): PlanExecutor {
  return new PlanExecutor({ sleep: async () => {}, backoffMs: 1 });
}

describe('PlanExecutor — success paths', () => {
  it('runs a dependency chain in order and reports success', async () => {
    const plan = makePlan([
      { id: 'a', capability: 'temperature-reading' },
      { id: 'b', capability: 'cooling', dependsOn: ['a'] },
      { id: 'c', capability: 'temperature-reading', dependsOn: ['b'] },
    ]);
    const calls: string[] = [];
    const result = await immediateExecutor().execute(
      plan, assignmentsFor(plan), recordingInvoker(calls), () => ({}),
    );

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(result.status).toBe('success');
    expect(result.nodeResults.a.status).toBe('succeeded');
    expect(result.nodeResults.b.attempts).toBe(1);
    expect(result.nodeResults.c.startedAt).toBeDefined();
    expect(result.nodeResults.c.finishedAt).toBeDefined();
    expect(result.summary).toContain('3 succeeded');
  });

  it('respects topological waves for branching DAGs', async () => {
    const plan = makePlan([
      { id: 'a', capability: 'x' },
      { id: 'b', capability: 'x', dependsOn: ['a'] },
      { id: 'c', capability: 'x', dependsOn: ['a'] },
      { id: 'd', capability: 'x', dependsOn: ['b', 'c'] },
    ]);
    const calls: string[] = [];
    const result = await immediateExecutor().execute(
      plan, assignmentsFor(plan), recordingInvoker(calls), () => ({}),
    );

    expect(result.status).toBe('success');
    expect(calls[0]).toBe('a');
    expect(calls[3]).toBe('d');
    expect(new Set(calls.slice(1, 3))).toEqual(new Set(['b', 'c']));
  });
});

describe('PlanExecutor — condition guards', () => {
  const plan = makePlan([
    { id: 'sense', capability: 'temperature-reading' },
    { id: 'cool', capability: 'cooling', dependsOn: ['sense'], condition: 'zone.temperature > 30' },
    { id: 'report', capability: 'temperature-reading', dependsOn: ['cool'] },
  ]);

  it('executes guarded nodes when the condition holds', async () => {
    const calls: string[] = [];
    const result = await immediateExecutor().execute(
      plan, assignmentsFor(plan), recordingInvoker(calls),
      () => ({ zone: { temperature: 33 } }),
    );
    expect(calls).toEqual(['sense', 'cool', 'report']);
    expect(result.status).toBe('success');
  });

  it('skips the whole subtree when the condition is false', async () => {
    const calls: string[] = [];
    const result = await immediateExecutor().execute(
      plan, assignmentsFor(plan), recordingInvoker(calls),
      () => ({ zone: { temperature: 26 } }),
    );
    expect(calls).toEqual(['sense']);
    expect(result.nodeResults.cool.status).toBe('skipped');
    expect(result.nodeResults.cool.note).toContain('evaluated false');
    expect(result.nodeResults.report.status).toBe('skipped');
    expect(result.status).toBe('success'); // skips are not failures
  });

  it('treats an unresolvable condition path as false (conservative)', async () => {
    const result = await immediateExecutor().execute(
      plan, assignmentsFor(plan), recordingInvoker(),
      () => ({ zone: {} }),
    );
    expect(result.nodeResults.cool.status).toBe('skipped');
    expect(result.nodeResults.cool.note).toContain('unresolved');
    expect(result.status).toBe('success');
  });

  it('skips conservatively when the env reader throws', async () => {
    const result = await immediateExecutor().execute(
      plan, assignmentsFor(plan), recordingInvoker(),
      () => { throw new Error('sensor bus down'); },
    );
    expect(result.nodeResults.cool.status).toBe('skipped');
    expect(result.nodeResults.cool.note).toContain('sensor bus down');
    expect(result.status).toBe('success');
  });
});

describe('PlanExecutor — failure policies', () => {
  it('retry: succeeds after transient (fault-injected) failures, with linear backoff', async () => {
    const plan = makePlan([
      { id: 'a', capability: 'cooling', onFail: { policy: 'retry', retries: 3 } },
    ]);
    const sleeps: number[] = [];
    const executor = new PlanExecutor({ backoffMs: 100, sleep: async (ms) => { sleeps.push(ms); } });

    let failuresLeft = 2; // fault injection: fail twice, then recover
    const invoker: PlanNodeInvoker = async () => {
      if (failuresLeft-- > 0) return { success: false, error: 'fault-injected: device unreachable' };
      return { success: true };
    };

    const result = await executor.execute(plan, assignmentsFor(plan), invoker, () => ({}));
    expect(result.status).toBe('success');
    expect(result.nodeResults.a.status).toBe('succeeded');
    expect(result.nodeResults.a.attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]); // linear backoff before attempts 2 and 3
  });

  it('retry exhausted: node fails, dependents blocked, overall failed when nothing succeeded', async () => {
    const plan = makePlan([
      { id: 'a', capability: 'cooling', onFail: { policy: 'retry', retries: 1 } },
      { id: 'b', capability: 'temperature-reading', dependsOn: ['a'] },
    ]);
    const invoker: PlanNodeInvoker = async () => ({ success: false, error: 'permanent fault' });

    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));
    expect(result.nodeResults.a.status).toBe('failed');
    expect(result.nodeResults.a.attempts).toBe(2); // 1 + retries
    expect(result.nodeResults.a.error).toBe('permanent fault');
    expect(result.nodeResults.b.status).toBe('blocked');
    expect(result.status).toBe('failed');
  });

  it('abort (default): failure blocks dependents; partial when siblings succeeded', async () => {
    const plan = makePlan([
      { id: 'ok', capability: 'temperature-reading' },
      { id: 'bad', capability: 'cooling' }, // no onFail → abort
      { id: 'downstream', capability: 'temperature-reading', dependsOn: ['bad'] },
    ]);
    const invoker: PlanNodeInvoker = async (node) =>
      node.id === 'bad'
        ? { success: false, error: 'fault-injected: command rejected' }
        : { success: true };

    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));
    expect(result.nodeResults.ok.status).toBe('succeeded');
    expect(result.nodeResults.bad.status).toBe('failed');
    expect(result.nodeResults.bad.attempts).toBe(1); // abort = single attempt
    expect(result.nodeResults.downstream.status).toBe('blocked');
    expect(result.nodeResults.downstream.error).toContain("'bad' failed");
    expect(result.status).toBe('partial');
  });

  it('compensate: runs the compensation node once, then aborts dependents', async () => {
    const plan = makePlan([
      { id: 'sense', capability: 'temperature-reading' },
      {
        id: 'cool', capability: 'cooling', dependsOn: ['sense'],
        onFail: { policy: 'compensate', compensateNodeId: 'safe-mode' },
      },
      { id: 'safe-mode', capability: 'device-control' },
      { id: 'verify', capability: 'temperature-reading', dependsOn: ['cool'] },
    ]);
    const calls: string[] = [];
    const invoker: PlanNodeInvoker = async (node) => {
      calls.push(node.id);
      if (node.id === 'cool') throw new Error('fault-injected: device offline'); // throwing fault
      return { success: true };
    };

    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));

    // compensation ran exactly once (at failure time, not again in its wave)
    expect(calls.filter(id => id === 'safe-mode')).toHaveLength(1);
    expect(calls.indexOf('safe-mode')).toBeGreaterThan(calls.indexOf('cool'));

    expect(result.nodeResults.sense.status).toBe('succeeded');
    expect(result.nodeResults.cool.status).toBe('failed');
    expect(result.nodeResults.cool.error).toBe('fault-injected: device offline');
    expect(result.nodeResults.cool.note).toContain('safe-mode');
    expect(result.nodeResults['safe-mode'].status).toBe('succeeded');
    expect(result.nodeResults['safe-mode'].compensationFor).toBe('cool');
    expect(result.nodeResults.verify.status).toBe('blocked');
    expect(result.status).toBe('partial');
  });

  // T-109 (R32, F15): a fallback-delivered degradation is NOT a run failure.
  it('T-109: fallback-delivered degradation meters as SUCCESS (no dependents blocked)', async () => {
    // The F15 shape: a delegate-like judgment node fails, its DECLARED
    // fallback lane succeeds, and nothing depends on the failed node —
    // the authored behavior was delivered.
    const plan = makePlan([
      { id: 'sense', capability: 'temperature-reading' },
      {
        id: 'judge', capability: 'device-control', dependsOn: ['sense'],
        onFail: { policy: 'compensate', compensateNodeId: 'fallback-lane' },
      },
      { id: 'fallback-lane', capability: 'device-control' },
    ]);
    const invoker: PlanNodeInvoker = async node => {
      if (node.id === 'judge') return { success: false, error: 'delegate degraded (LLM down)' };
      return { success: true };
    };

    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));

    // Node-level honesty: the judgment failed, the fallback delivered.
    expect(result.nodeResults.judge.status).toBe('failed');
    expect(result.nodeResults['fallback-lane'].status).toBe('succeeded');
    expect(result.nodeResults['fallback-lane'].compensationFor).toBe('judge');
    // Run-level classification: delivered, not provider-hostile.
    expect(result.status).toBe('success');
    expect(result.summary).toContain('degraded but fallback-delivered');
  });

  it('T-109: an UNCOMPENSATED failure still meters partial/failed (strictness kept)', async () => {
    const plan = makePlan([
      { id: 'sense', capability: 'temperature-reading' },
      { id: 'act', capability: 'cooling', dependsOn: ['sense'] },
    ]);
    const invoker: PlanNodeInvoker = async node =>
      node.id === 'act' ? { success: false, error: 'device offline' } : { success: true };
    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));
    expect(result.status).toBe('partial');
  });

  it('T-109: a fallback lane that ALSO fails keeps the run failed', async () => {
    const plan = makePlan([
      {
        id: 'judge', capability: 'device-control',
        onFail: { policy: 'compensate', compensateNodeId: 'fallback-lane' },
      },
      { id: 'fallback-lane', capability: 'device-control' },
    ]);
    const invoker: PlanNodeInvoker = async () => ({ success: false, error: 'everything down' });
    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));
    expect(result.nodeResults.judge.status).toBe('failed');
    expect(result.nodeResults['fallback-lane'].status).toBe('failed');
    expect(result.status).toBe('failed'); // succeeded === 0
  });

  it('compensation-only nodes are not scheduled when never triggered', async () => {
    const plan = makePlan([
      { id: 'cool', capability: 'cooling', onFail: { policy: 'compensate', compensateNodeId: 'safe-mode' } },
      { id: 'safe-mode', capability: 'device-control' },
    ]);
    const calls: string[] = [];
    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), recordingInvoker(calls), () => ({}));

    expect(calls).toEqual(['cool']); // safe-mode never invoked
    expect(result.nodeResults['safe-mode'].status).toBe('skipped');
    expect(result.nodeResults['safe-mode'].note).toContain('not required');
    expect(result.status).toBe('success');
  });

  it('records compensation failure honestly', async () => {
    const plan = makePlan([
      { id: 'bad', capability: 'cooling', onFail: { policy: 'compensate', compensateNodeId: 'fix' } },
      { id: 'fix', capability: 'device-control' },
    ]);
    const invoker: PlanNodeInvoker = async () => ({ success: false, error: 'everything is broken' });

    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), invoker, () => ({}));
    expect(result.nodeResults.bad.status).toBe('failed');
    expect(result.nodeResults.fix.status).toBe('failed');
    expect(result.nodeResults.fix.compensationFor).toBe('bad');
    expect(result.status).toBe('failed');
  });
});

describe('PlanExecutor — boundary guarantees', () => {
  it('fails a node without an assignment (run validatePlan first)', async () => {
    const plan = makePlan([{ id: 'a', capability: 'cooling' }]);
    const result = await immediateExecutor().execute(
      plan, new Map(), recordingInvoker(), () => ({}),
    );
    expect(result.nodeResults.a.status).toBe('failed');
    expect(result.nodeResults.a.error).toContain('no assignee');
    expect(result.status).toBe('failed');
  });

  it('never throws, even when the invoker throws on every node', async () => {
    const plan = makePlan([
      { id: 'a', capability: 'cooling' },
      { id: 'b', capability: 'cooling', dependsOn: ['a'] },
    ]);
    const throwingInvoker: PlanNodeInvoker = async () => { throw new Error('catastrophic'); };
    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), throwingInvoker, () => ({}));
    expect(result.status).toBe('failed');
    expect(result.nodeResults.a.status).toBe('failed');
    expect(result.nodeResults.b.status).toBe('blocked');
  });

  it('refuses a cyclic plan defensively instead of hanging', async () => {
    const plan = makePlan([
      { id: 'a', capability: 'cooling', dependsOn: ['b'] },
      { id: 'b', capability: 'cooling', dependsOn: ['a'] },
    ]);
    const result = await immediateExecutor().execute(plan, assignmentsFor(plan), recordingInvoker(), () => ({}));
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('cycle');
  });

  it('mediates every node call through the invoker with node + assignee', async () => {
    const plan = makePlan([{ id: 'a', capability: 'cooling', params: { target: 26 } }]);
    const invoker = vi.fn(async (node: PlanNode, agentId: string): Promise<PlanNodeInvocation> => {
      expect(node.params).toEqual({ target: 26 });
      expect(agentId).toBe('agent-hvac');
      return { success: true };
    });
    await immediateExecutor().execute(
      plan, new Map([['a', 'agent-hvac']]), invoker, () => ({}),
    );
    expect(invoker).toHaveBeenCalledTimes(1);
  });
});
