/**
 * @vitest-environment node
 *
 * FlowEngine tests (no runtime, no devices):
 *   - event trigger matching (selectors, conditions, wildcards, disabled)
 *   - condition trigger edge semantics + cooldown
 *   - schedule trigger one-shot / periodic / tick-crossing / window
 *   - assignment UNSAT short-circuit
 *   - never-throw guarantee (throwing invoker, throwing provider)
 *   - run records + bus events + serialized execution
 */

import { describe, it, expect, vi } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvocation, PlanNodeInvoker } from '../../workflow/plan-executor.js';
import {
  FlowEngine,
  FLOW_EVENT_TYPES,
  type FlowDefinition,
  type FlowRunRecord,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'flow-engine-test', name: 'Flow Engine Test' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    // DevLoop: assignment resolution requires the capability to be backed by
    // a BOUND DEVICE (the executable contract — the runtime invoker only
    // actuates devices). The agent's declared capabilities alone used to
    // qualify, which is exactly the validate-OK/run-fail gap this suite's
    // fixture now mirrors correctly.
    devices: [
      {
        id: 'ac-a', type: 'hvac',
        capabilities: ['cooling', 'temperature-control'],
        zoneId: 'zone-a',
      },
      {
        id: 'light-a', type: 'light',
        capabilities: ['lighting-control', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'agent-a', name: 'Agent A',
        capabilities: ['cooling', 'lighting-control'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['ac-a', 'light-a'],
      },
    ],
    events: [],
  });
}

interface Harness {
  engine: FlowEngine;
  invoker: PlanNodeInvoker;
  published: Array<{ type: string; payload: Record<string, unknown> }>;
  runs: FlowRunRecord[];
  env: Record<string, unknown>;
}

function harness(flows: FlowDefinition[], invokerImpl?: PlanNodeInvoker): Harness {
  const published: Harness['published'] = [];
  const runs: FlowRunRecord[] = [];
  const env: Record<string, unknown> = { 'zone-a': { temperature: 22, motion: false } };
  const invoker: PlanNodeInvoker = invokerImpl ?? (async () => ({ success: true, result: { ok: true } }));
  const engine = new FlowEngine({
    scenario: scenario(),
    flowsProvider: () => flows,
    agents: new Map(),
    invoker,
    envStateReader: () => env,
    publish: (type, payload) => { published.push({ type, payload }); },
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
  });
  return { engine, invoker, published, runs, env };
}

function eventFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: 'flow-1',
    name: 'Test flow',
    enabled: true,
    trigger: { kind: 'event', eventType: 'temperature-spike', zoneId: 'zone-a' },
    plan: { goal: 'cool', nodes: [{ id: 'n1', capability: 'cooling' }] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Event triggers
// ---------------------------------------------------------------------------

describe('FlowEngine — event triggers', () => {
  it('fires on a matching event and publishes TRIGGERED then EXECUTED', async () => {
    const h = harness([eventFlow()]);
    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', newValue: 35 });

    expect(h.published.map(p => p.type)).toEqual([FLOW_EVENT_TYPES.TRIGGERED, FLOW_EVENT_TYPES.EXECUTED]);
    // Fix-44b: run ids are globally unique ('run-<uuid>') — the old
    // per-engine 'flow-1-run-N' scheme collided across simulations.
    expect(String(h.published[0].payload.runId)).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(h.published[0].payload).toMatchObject({ flowId: 'flow-1', triggerKind: 'event' });
    expect(h.published[1].payload).toMatchObject({ status: 'success', flowId: 'flow-1' });
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({
      runId: h.published[0].payload.runId, flowId: 'flow-1', triggerKind: 'event', status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(h.runs[0].nodeResults.n1.status).toBe('succeeded');
    // nodeResults must be JSON-serializable
    expect(() => JSON.stringify(h.runs[0].nodeResults)).not.toThrow();
  });

  it('does not fire when a declared selector mismatches', async () => {
    const h = harness([eventFlow()]);
    await h.engine.onEvent({ eventType: 'humidity-spike', zoneId: 'zone-a' });
    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-b' });
    expect(h.runs).toHaveLength(0);
  });

  it('treats undeclared selectors as wildcards', async () => {
    const h = harness([eventFlow({ trigger: { kind: 'event' } })]);
    await h.engine.onEvent({ eventType: 'anything', zoneId: 'anywhere' });
    expect(h.runs).toHaveLength(1);
  });

  it('T-312: an event trigger without zoneId scopes the run to the EVENT zone', async () => {
    const contexts: Array<Record<string, unknown> | undefined> = [];
    const invoker: PlanNodeInvoker = async (_node, _agentId, context) => {
      contexts.push(context);
      return { success: true };
    };
    // No trigger.zoneId — before T-312 the run executed unscoped
    // (whole-environment invoker context) even though the event carried one.
    const flow = eventFlow({ trigger: { kind: 'event', eventType: 'temperature-spike' } });
    const h = harness([flow], invoker);

    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', newValue: 35 });

    expect(h.runs).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ zoneId: 'zone-a', actor: 'flow:flow-1' });
  });

  it('T-312: a declared trigger zoneId still wins over the event zone', async () => {
    const contexts: Array<Record<string, unknown> | undefined> = [];
    const invoker: PlanNodeInvoker = async (_node, _agentId, context) => {
      contexts.push(context);
      return { success: true };
    };
    const flow = eventFlow({
      trigger: { kind: 'event', eventType: 'temperature-spike', zoneId: 'zone-a' },
    });
    const h = harness([flow], invoker);

    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' });

    expect(h.runs).toHaveLength(1);
    expect(contexts[0]).toMatchObject({ zoneId: 'zone-a' });
  });

  it('never fires a disabled flow', async () => {
    const h = harness([eventFlow({ enabled: false })]);
    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' });
    expect(h.runs).toHaveLength(0);
  });

  it('evaluates trigger conditions against the post-event snapshot (AND)', async () => {
    const flow = eventFlow({
      trigger: {
        kind: 'event',
        eventType: 'temperature-spike',
        conditions: [
          { path: 'zone-a.temperature', op: '>', value: 30 },
          { path: 'motion', op: '==', value: false },
        ],
      },
    });
    const h = harness([flow]);

    // Injected value 25 → first condition false, no fire
    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', newValue: 25 });
    expect(h.runs).toHaveLength(0);

    // Injected value 35 → both hold, fire
    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', newValue: 35 });
    expect(h.runs).toHaveLength(1);
  });

  it('serializes concurrent triggers through the internal queue', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slowInvoker: PlanNodeInvoker = async (node): Promise<PlanNodeInvocation> => {
      order.push(`start:${node.id}`);
      await gate;
      order.push(`end:${node.id}`);
      return { success: true };
    };
    const flow1 = eventFlow();
    const flow2 = eventFlow({ id: 'flow-2', plan: { goal: 'g', nodes: [{ id: 'n2', capability: 'cooling' }] } });
    const h = harness([flow1, flow2], slowInvoker);

    const p1 = h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' });
    const p2 = h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' });
    // Let both enqueue, then release the gate
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([p1, p2]);

    // Both onEvent calls match BOTH flows; the second call's first flow
    // enqueues ahead of the first call's second flow (queue order). Runs
    // must strictly serialize — no run starts before the previous one ends.
    expect(order).toEqual([
      'start:n1', 'end:n1', 'start:n1', 'end:n1',
      'start:n2', 'end:n2', 'start:n2', 'end:n2',
    ]);
    // Fix-44b: unique run ids (order still matters for the queue semantics).
    const runIds = h.runs.map(r => r.runId);
    expect(new Set(runIds).size).toBe(4);
    for (const id of runIds) expect(id).toMatch(/^run-[0-9a-f-]{36}$/);
    expect(h.runs.map(r => r.flowId)).toEqual(['flow-1', 'flow-1', 'flow-2', 'flow-2']);
  });
});

// ---------------------------------------------------------------------------
// Condition triggers (edge + cooldown)
// ---------------------------------------------------------------------------

describe('FlowEngine — T-107 condition-trigger hysteresis (F10)', () => {
  function hysteresisFlow(hysteresisSimC: number): FlowDefinition {
    return eventFlow({
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 26 }],
        hysteresisSimC,
      },
    });
  }

  it('a false dip shorter than the window does NOT re-arm the edge (26.01 °C flicker)', async () => {
    const h = harness([hysteresisFlow(3600)]); // 1 sim-hour re-arm window

    await h.engine.onTick(0); // 22 → false
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(10); // rising edge: fire
    expect(h.runs).toHaveLength(1);

    // A brief dip (10 sim-s « 3600) and return: continuation, NOT a trigger.
    (h.env['zone-a'] as Record<string, unknown>).temperature = 25.99;
    await h.engine.onTick(20); // false — streak starts
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(30); // true again after 10 s of false: swallowed
    expect(h.runs).toHaveLength(1);
  });

  it('a false period LONGER than the window re-arms normally', async () => {
    const h = harness([hysteresisFlow(60)]);

    await h.engine.onTick(0);
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(10); // fire
    expect(h.runs).toHaveLength(1);

    (h.env['zone-a'] as Record<string, unknown>).temperature = 25.99;
    await h.engine.onTick(20); // false streak begins at t=20
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.5;
    await h.engine.onTick(200); // false for 180 s ≥ 60: re-armed → fire
    expect(h.runs).toHaveLength(2);
  });

  it('no hysteresis declared: old edge semantics unchanged (every dip retriggers)', async () => {
    const h = harness([hysteresisFlow(0)]);
    await h.engine.onTick(0);
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(10); // fire
    (h.env['zone-a'] as Record<string, unknown>).temperature = 25.99;
    await h.engine.onTick(20);
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(30); // brief dip retriggers (pre-T-107 behavior)
    expect(h.runs).toHaveLength(2);
  });

  it('hysteresis rides the trigger fingerprint (editing the window re-arms)', async () => {
    const flows = [hysteresisFlow(3600)];
    const h = harness(flows);
    await h.engine.onTick(0);
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(10); // fire
    (h.env['zone-a'] as Record<string, unknown>).temperature = 25.99;
    await h.engine.onTick(20);
    // Edit the trigger: fingerprint changes, edge memory discarded.
    flows[0] = hysteresisFlow(0);
    (h.env['zone-a'] as Record<string, unknown>).temperature = 26.01;
    await h.engine.onTick(30); // fresh edge under the new definition: fire
    expect(h.runs).toHaveLength(2);
  });
});

describe('FlowEngine — condition triggers', () => {
  function conditionFlow(cooldownSimSec?: number): FlowDefinition {
    return eventFlow({
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 30 }],
        ...(cooldownSimSec !== undefined ? { cooldownSimSec } : {}),
      },
    });
  }

  it('fires on the rising edge only, not while the condition stays true', async () => {
    const h = harness([conditionFlow()]);

    await h.engine.onTick(1); // 22 → false
    expect(h.runs).toHaveLength(0);

    (h.env['zone-a'] as Record<string, unknown>).temperature = 35;
    await h.engine.onTick(2); // false → true: fire
    await h.engine.onTick(3); // stays true: no fire
    expect(h.runs).toHaveLength(1);

    (h.env['zone-a'] as Record<string, unknown>).temperature = 20;
    await h.engine.onTick(4); // back to false: no fire, rearms the edge
    (h.env['zone-a'] as Record<string, unknown>).temperature = 40;
    await h.engine.onTick(5); // rising edge again: fire
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1].triggerKind).toBe('condition');
  });

  it('suppresses re-fires during the cooldown window', async () => {
    const h = harness([conditionFlow(100)]);
    const zone = h.env['zone-a'] as Record<string, unknown>;

    zone.temperature = 35;
    await h.engine.onTick(10); // fire at t=10
    expect(h.runs).toHaveLength(1);

    zone.temperature = 20;
    await h.engine.onTick(20);
    zone.temperature = 36;
    await h.engine.onTick(50); // edge at t=50 but within cooldown (10+100): suppressed
    expect(h.runs).toHaveLength(1);

    zone.temperature = 20;
    await h.engine.onTick(60);
    zone.temperature = 37;
    await h.engine.onTick(120); // edge at t=120, cooldown elapsed: fire
    expect(h.runs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Schedule triggers
// ---------------------------------------------------------------------------

describe('FlowEngine — schedule triggers', () => {
  it('fires a one-shot schedule exactly once', async () => {
    const h = harness([eventFlow({ trigger: { kind: 'schedule', atSimTimeSec: 60 } })]);

    await h.engine.onTick(30);
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(60); // reached
    await h.engine.onTick(90); // already fired
    await h.engine.onTick(120);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].triggerKind).toBe('schedule');
  });

  it('fires a periodic schedule at every crossed period, at most once per tick', async () => {
    const h = harness([eventFlow({ trigger: { kind: 'schedule', everySimSec: 60 } })]);

    await h.engine.onTick(30);  // (0, 30]: no crossing
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(90);  // (30, 90]: crosses 60 → fire once
    expect(h.runs).toHaveLength(1);
    await h.engine.onTick(300); // (90, 300]: crosses 120/180/240/300 → still once per tick
    expect(h.runs).toHaveLength(2);
  });

  it('respects the start/end window', async () => {
    const h = harness([eventFlow({
      trigger: { kind: 'schedule', everySimSec: 60, startAtSimTimeSec: 120, endAtSimTimeSec: 240 },
    })]);

    await h.engine.onTick(60);  // before start
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(150); // crosses 120 → fire
    await h.engine.onTick(200); // crosses 180 → fire
    await h.engine.onTick(250); // crosses 240 (at end, inclusive) → fire
    await h.engine.onTick(400); // past end → no fire
    expect(h.runs).toHaveLength(3);
  });

  it('a throwing flowsProvider keeps the tick window open — the crossed schedule is NOT lost', async () => {
    const runs: FlowRunRecord[] = [];
    let providerCalls = 0;
    const flow = eventFlow({
      // Windowed periodic: the t=60 crossing lives inside [0, 70]. If the
      // failed tick consumed the window, the NEXT tick's prev (100) is past
      // `end` and the schedule is gone forever.
      trigger: { kind: 'schedule', everySimSec: 60, startAtSimTimeSec: 0, endAtSimTimeSec: 70 },
    });
    const engine = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => {
        providerCalls += 1;
        if (providerCalls === 2) throw new Error('transient store fault');
        return [flow];
      },
      agents: new Map(),
      invoker: async () => ({ success: true }),
      envStateReader: () => ({}),
      publish: () => undefined,
      onRun: record => runs.push(record),
    });

    await engine.onTick(0);   // establishes lastTickSimSec = 0, no crossing
    expect(runs).toHaveLength(0);
    await engine.onTick(100); // provider throws — the (0, 100] window (crossing t=60) must stay open
    await engine.onTick(200); // recovered: (0, 200] still crosses t=60 within [0, 70] → fire
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerKind).toBe('schedule');
  });
});

// ---------------------------------------------------------------------------
// FEAT-01: time semantics (daily time-of-day / active window / occupancy-relative)
// ---------------------------------------------------------------------------

/** Scenario with an occupantSchedule (08:00–18:00) on zone-a. */
function scenarioWithOccupancy(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'flow-engine-occ-test', name: 'Flow Engine Occupancy Test' },
    zones: [
      {
        id: 'zone-a',
        adjacentZoneIds: [],
        occupantSchedule: { count: 30, startSimTimeSec: 28800, endSimTimeSec: 64800 },
      },
      {
        id: 'zone-b',
        adjacentZoneIds: [],
        occupantSchedule: { count: 5, startSimTimeSec: 32400, endSimTimeSec: 61200, repeatDaily: false },
      },
    ],
    devices: [
      {
        id: 'ac-a', type: 'hvac',
        capabilities: ['cooling', 'temperature-control'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'agent-a', name: 'Agent A',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['ac-a'],
      },
    ],
    events: [],
  });
}

function harnessWithScenario(flows: FlowDefinition[], sc: ScenarioDefinition): Harness {
  const published: Harness['published'] = [];
  const runs: FlowRunRecord[] = [];
  const env: Record<string, unknown> = { 'zone-a': { temperature: 22 }, 'zone-b': { temperature: 22 } };
  const engine = new FlowEngine({
    scenario: sc,
    flowsProvider: () => flows,
    agents: new Map(),
    invoker: async () => ({ success: true, result: { ok: true } }),
    envStateReader: () => env,
    publish: (type, payload) => { published.push({ type, payload }); },
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
  });
  return { engine, invoker: async () => ({ success: true }), published, runs, env };
}

describe('FlowEngine — FEAT-01 daily time-of-day schedules', () => {
  it('fires atTimeOfDaySec once per sim day at the daily anchor (23:30 = 84600)', async () => {
    const h = harness([eventFlow({ trigger: { kind: 'schedule', atTimeOfDaySec: 84600 } })]);

    await h.engine.onTick(80000);  // (0, 80000]: 84600 not reached
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(85000);  // (80000, 85000]: crosses 84600 → fire
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].triggerKind).toBe('schedule');
    await h.engine.onTick(86399);  // same day, already fired
    expect(h.runs).toHaveLength(1);
    await h.engine.onTick(86400 + 84600); // day 1 anchor → fire again
    expect(h.runs).toHaveLength(2);
    await h.engine.onTick(2 * 86400 + 84600); // day 2 anchor (tick spans a full day)
    expect(h.runs).toHaveLength(3);
  });

  it('a large tick spanning several days fires a daily anchor at most once per tick', async () => {
    const h = harness([eventFlow({ trigger: { kind: 'schedule', atTimeOfDaySec: 43200 } })]);
    await h.engine.onTick(3 * 86400); // (0, 259200]: anchors of day 0/1/2 crossed
    expect(h.runs).toHaveLength(1);   // at-most-once-per-tick (periodic parity)
  });

  it('combines atTimeOfDaySec with the existing one-shot/periodic forms', async () => {
    const h = harness([eventFlow({
      trigger: { kind: 'schedule', atSimTimeSec: 100, atTimeOfDaySec: 84600 },
    })]);
    await h.engine.onTick(120);   // one-shot
    expect(h.runs).toHaveLength(1);
    await h.engine.onTick(85000); // daily anchor
    expect(h.runs).toHaveLength(2);
  });

  it('editing the daily anchor re-arms the fired memory (fingerprint parity)', async () => {
    const flows = [eventFlow({ trigger: { kind: 'schedule' as const, atTimeOfDaySec: 84600 } })];
    const h = harness(flows);
    await h.engine.onTick(85000);
    expect(h.runs).toHaveLength(1);
    // Same-day edit to a later anchor: the new fingerprint re-arms.
    flows[0] = eventFlow({ trigger: { kind: 'schedule' as const, atTimeOfDaySec: 86000 } });
    await h.engine.onTick(86100);
    expect(h.runs).toHaveLength(2);
  });

  it('checkpoint export/restore does not refire an already-fired daily anchor', async () => {
    const flow = eventFlow({ trigger: { kind: 'schedule', atTimeOfDaySec: 84600 } });
    const h1 = harness([flow]);
    await h1.engine.onTick(85000); // fires day-0 anchor
    expect(h1.runs).toHaveLength(1);
    const state = h1.engine.exportTriggerState();

    const h2 = harness([flow]);
    h2.engine.restoreTriggerState(state);
    await h2.engine.onTick(86399); // same day, restored memory → no refire
    expect(h2.runs).toHaveLength(0);
    await h2.engine.onTick(86400 + 84600); // next day's anchor fires normally
    expect(h2.runs).toHaveLength(1);
  });
});

describe('FlowEngine — FEAT-01 occupancy-relative schedules', () => {
  it('fires offsetSec BEFORE the arrive boundary (到馆前 30 分钟预冷)', async () => {
    const h = harnessWithScenario(
      [eventFlow({
        trigger: {
          kind: 'schedule',
          relativeToOccupancy: { zoneId: 'zone-a', before: 'arrive', offsetSec: 1800 },
        },
      })],
      scenarioWithOccupancy(),
    );
    // zone-a arrive = 28800 (08:00); anchor = 27000 (07:30).
    await h.engine.onTick(26000);
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(27100); // crosses 27000 → fire
    expect(h.runs).toHaveLength(1);
    await h.engine.onTick(30000); // same boundary already fired
    expect(h.runs).toHaveLength(1);
    await h.engine.onTick(86400 + 27100); // day 1: repeatDaily default → fire again
    expect(h.runs).toHaveLength(2);
  });

  it('without zoneId anchors every scheduled zone; repeatDaily:false fires day 0 only', async () => {
    const h = harnessWithScenario(
      [eventFlow({
        trigger: { kind: 'schedule', relativeToOccupancy: { before: 'depart', offsetSec: 600 } },
      })],
      scenarioWithOccupancy(),
    );
    // zone-a depart = 64800 → anchor 64200; zone-b depart = 61200 → anchor 60600.
    await h.engine.onTick(60700);  // crosses zone-b's anchor → fire
    expect(h.runs).toHaveLength(1);
    await h.engine.onTick(64300);  // crosses zone-a's anchor → fire
    expect(h.runs).toHaveLength(2);
    // Day 1: zone-a (repeatDaily) fires; zone-b (repeatDaily:false) does not.
    await h.engine.onTick(86400 + 60700);
    expect(h.runs).toHaveLength(2);
    await h.engine.onTick(86400 + 64300);
    expect(h.runs).toHaveLength(3);
  });

  it('a zone without occupantSchedule never anchors (no crash, no fire)', async () => {
    // The default scenario() fixture has no occupantSchedule at all.
    const h = harness([eventFlow({
      trigger: { kind: 'schedule', relativeToOccupancy: { before: 'arrive', offsetSec: 1800 } },
    })]);
    await h.engine.onTick(100000);
    expect(h.runs).toHaveLength(0);
  });
});

describe('FlowEngine — FEAT-01 condition active windows', () => {
  const windowFlow = (window: [number, number]) =>
    eventFlow({
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 30 }],
        activeWindowSimSec: window,
      },
    });

  it('suppresses edges outside the window and fires on an in-window edge', async () => {
    const h = harness([windowFlow([25200, 64800])]); // 07:00–18:00
    h.env['zone-a'] = { temperature: 35 };
    await h.engine.onTick(1000);  // 00:16 — outside window: no edge
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(30000); // 08:20 — in-window rising edge → fire
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].triggerKind).toBe('condition');
  });

  it('a predicate already true at window open rises AT the open (folded window)', async () => {
    const h = harness([windowFlow([25200, 64800])]);
    h.env['zone-a'] = { temperature: 35 };
    await h.engine.onTick(1000);   // outside window → level false recorded
    await h.engine.onTick(2000);   // still outside
    await h.engine.onTick(25300);  // window opens with predicate true → edge fires
    expect(h.runs).toHaveLength(1);
  });

  it('an edge that falls and rises again inside the window refires (edge semantics intact)', async () => {
    const h = harness([windowFlow([25200, 64800])]);
    h.env['zone-a'] = { temperature: 35 };
    await h.engine.onTick(30000); // fire
    expect(h.runs).toHaveLength(1);
    h.env['zone-a'] = { temperature: 20 };
    await h.engine.onTick(30100); // false streak re-arms
    h.env['zone-a'] = { temperature: 35 };
    await h.engine.onTick(30200); // new rising edge in-window → refire
    expect(h.runs).toHaveLength(2);
  });

  it('a crossing-midnight window (22:00–06:00) opens overnight only', async () => {
    const h = harness([windowFlow([79200, 21600])]);
    h.env['zone-a'] = { temperature: 35 };
    await h.engine.onTick(40000);  // 11:06 — daytime, outside: no fire
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(80000);  // 22:13 — inside overnight window → fire
    expect(h.runs).toHaveLength(1);
    // The window folds false while closed (daytime), so the next overnight
    // entry is a fresh rising edge.
    await h.engine.onTick(86400 + 30000); // day 1, 08:20 — outside → re-arm
    await h.engine.onTick(86400 + 80000); // day 1, 22:13 — fresh edge → refire
    expect(h.runs).toHaveLength(2);
  });

  it('dorm-life regression: physics power noise at 03:00 cannot fire a daytime-only flow', async () => {
    const flow = eventFlow({
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'power', op: '>', value: 800 }],
        activeWindowSimSec: [25200, 84600], // 07:00–23:30
      },
    });
    const h = harness([flow]);
    h.env['zone-a'] = { power: 1200 }; // 凌晨物理驱动功率尖峰
    await h.engine.onTick(10800); // 03:00 — outside the window: suppressed
    expect(h.runs).toHaveLength(0);
    await h.engine.onTick(30000); // 08:20 — in-window: fires once
    expect(h.runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe('FlowEngine — robustness', () => {
  it('refuses UNSAT flows with a failed EXECUTED event, never calling the invoker', async () => {
    const invoker = vi.fn(async (): Promise<PlanNodeInvocation> => ({ success: true }));
    const flow = eventFlow({ plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'teleportation' }] } });
    const h = harness([flow], invoker);

    await h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' });

    expect(invoker).not.toHaveBeenCalled();
    expect(h.published.map(p => p.type)).toEqual([FLOW_EVENT_TYPES.EXECUTED]);
    expect(h.published[0].payload.status).toBe('failed');
    expect(String(h.published[0].payload.summary)).toContain('UNSAT');
    expect(h.runs[0].status).toBe('failed');
    // TASK-003: UNSAT nodes now carry error details in nodeResults (was {}
    // — the Explorer's "no hint what went wrong" finding).
    expect(h.runs[0].nodeResults.n1?.status).toBe('failed');
    expect(String(h.runs[0].nodeResults.n1?.error)).toContain('UNSAT');
  });

  it('survives a throwing invoker (never-throw, failed run)', async () => {
    const throwing: PlanNodeInvoker = async () => { throw new Error('device exploded'); };
    const h = harness([eventFlow()], throwing);

    await expect(
      h.engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' }),
    ).resolves.toBeUndefined();

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].status).toBe('failed');
    expect(h.runs[0].nodeResults.n1.status).toBe('failed');
    expect(h.runs[0].nodeResults.n1.error).toContain('device exploded');
  });

  it('survives a throwing flowsProvider', async () => {
    const engine = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => { throw new Error('provider fault'); },
      agents: new Map(),
      invoker: async () => ({ success: true }),
      envStateReader: () => ({}),
      publish: () => undefined,
    });
    await expect(engine.onEvent({ eventType: 'x', zoneId: 'z' })).resolves.toBeUndefined();
    await expect(engine.onTick(1)).resolves.toBeUndefined();
  });

  it('survives a throwing publish and a throwing onRun listener', async () => {
    const engine = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => [eventFlow()],
      agents: new Map(),
      invoker: async () => ({ success: true }),
      envStateReader: () => ({}),
      publish: () => { throw new Error('bus down'); },
      onRun: () => { throw new Error('listener fault'); },
    });
    await expect(
      engine.onEvent({ eventType: 'temperature-spike', zoneId: 'zone-a' }),
    ).resolves.toBeUndefined();
  });

  it('survives a throwing envStateReader (conditions treated conservatively)', async () => {
    const flow = eventFlow({
      trigger: { kind: 'condition', zoneId: 'zone-a', conditions: [{ path: 'temperature', op: '>', value: 30 }] },
    });
    const engine = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => [flow],
      agents: new Map(),
      invoker: async () => ({ success: true }),
      envStateReader: () => { throw new Error('env down'); },
      publish: () => undefined,
    });
    await expect(engine.onTick(1)).resolves.toBeUndefined();
  });
});
