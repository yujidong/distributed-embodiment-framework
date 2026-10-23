/**
 * @vitest-environment node
 *
 * Mechanism A (mixed-initiative flows) — delegate node SCHEMA + VALIDATION:
 *   - FLOW_JSON_SCHEMA accepts both node variants; PLAN_JSON_SCHEMA does NOT
 *     (LLM-synthesized plans may never embed judgment steps)
 *   - action/delegate mutual exclusion with teaching errors
 *   - mode cross rules (advice+budget / actuating-without-budget /
 *     actuating+outputs)
 *   - fallback reference rules (unknown / self / delegate chaining)
 *   - budget governance: existence, binding, command executability,
 *     zone containment (ratified trade-off #1: budgets stay INSIDE the
 *     trigger zone), author scoping (T-201), disabled assignee, auto-match
 */

import { describe, it, expect } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import { validatePlanShape } from '../../workflow/plan-schema.js';
import { FLOW_JSON_SCHEMA, validateFlow, type FlowDefinition } from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'delegate-validation-test', name: 'Delegate Validation Test' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'hvac-b1', type: 'hvac',
        capabilities: ['cooling', 'temperature-control', 'set-temperature', 'set-mode', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
      {
        id: 'hvac-b2', type: 'hvac',
        capabilities: ['cooling', 'temperature-control', 'set-temperature', 'set-mode', 'turn-on'],
        zoneId: 'zone-b',
      },
      {
        id: 'hvac-a1', type: 'hvac',
        capabilities: ['cooling', 'set-temperature'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'energy-optimizer', name: 'Energy Optimizer',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b1', 'hvac-b2'],
      },
      {
        id: 'zone-a-agent', name: 'Zone A Agent',
        capabilities: ['cooling'],
        managesZoneIds: ['zone-a'], boundDeviceIds: ['hvac-a1'],
      },
    ],
    events: [],
  });
}

/** Executability oracle (simulation's isCapabilityExecutable, test double). */
const executable = (name: string): boolean =>
  ['cooling', 'temperature-control', 'set-temperature', 'set-mode', 'turn-on', 'turn-off',
   'heating', 'set-brightness', 'toggle', 'set-power', 'lighting-control'].includes(name);

function delegateFlow(overrides: Record<string, unknown> = {}): FlowDefinition {
  return {
    id: 'flow-delegate',
    name: 'Delegate flow',
    enabled: true,
    trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-b' },
    plan: {
      goal: 'shed load',
      nodes: [
        {
          id: 'pick-shed-target',
          delegate: {
            question: 'Pick one HVAC to shed and a target temperature (18-26).',
            mode: 'actuating',
            budget: {
              maxCommands: 2,
              deviceIds: ['hvac-b1'],
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

function errorsOf(flow: unknown, sc?: ScenarioDefinition): string[] {
  return validateFlow(flow, sc, { isExecutableCapability: executable })
    .filter(i => i.level === 'error')
    .map(i => i.message);
}

// ---------------------------------------------------------------------------
// Shape acceptance / rejection
// ---------------------------------------------------------------------------

describe('delegate node — schema', () => {
  it('FLOW_JSON_SCHEMA accepts a valid actuating delegate node', () => {
    expect(errorsOf(delegateFlow())).toEqual([]);
  });

  it('FLOW_JSON_SCHEMA accepts a valid advice delegate node', () => {
    const flow = delegateFlow({
      plan: {
        goal: 'ask',
        nodes: [
          {
            id: 'ask-judgment',
            delegate: {
              question: 'Which zone looks most at risk?',
              mode: 'advice',
              outputs: ['riskZone'],
            },
          },
        ],
      },
    });
    expect(errorsOf(flow)).toEqual([]);
  });

  it('PLAN_JSON_SCHEMA REJECTS delegate nodes (LLM plans may not embed judgment steps)', () => {
    const issues = validatePlanShape({
      id: 'p', goal: 'g',
      metadata: { author: 'llm', createdAt: 'now' },
      nodes: [
        { id: 'n1', capability: 'cooling' } as never,
        {
          id: 'n2', capability: 'cooling',
          delegate: { question: 'q', mode: 'advice' },
        } as never,
      ],
    });
    expect(issues.some(i => i.level === 'error' && /delegate|additional/.test(i.message))).toBe(true);
  });

  it('rejects unknown fields inside the delegate block (fail loudly)', () => {
    const flow = delegateFlow();
    (flow.plan.nodes[0] as { delegate: Record<string, unknown> }).delegate.timeoutSimSec = 120;
    expect(errorsOf(flow)).toHaveLength(1);
    expect(errorsOf(flow)[0]).toMatch(/schema/);
  });

  it('rejects a node carrying BOTH capability and delegate, with teaching', () => {
    const flow = delegateFlow();
    (flow.plan.nodes[0] as unknown as { capability: string }).capability = 'cooling';
    const errors = errorsOf(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/capability \(action node\) \+ delegate \(delegate node\)/);
    expect(errors[0]).toMatch(/EXACTLY ONE/);
    expect(errors[0]).toMatch(/split the concerns/);
  });

  it('rejects a node carrying NONE of the five kind blocks, with teaching', () => {
    const flow = delegateFlow();
    delete (flow.plan.nodes[0] as unknown as { delegate?: unknown }).delegate;
    const errors = errorsOf(flow);
    expect(errors.some(e => /none of 'capability', 'delegate', 'service', 'notify' or 'wait'/.test(e))).toBe(true);
  });

  it('rejects action-only fields on a delegate node, with teaching (not silent)', () => {
    const flow = delegateFlow();
    (flow.plan.nodes[0] as unknown as { params: unknown }).params = { x: 1 };
    const errors = errorsOf(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/action-only field\(s\) 'params'/);
    expect(errors[0]).toMatch(/delegate.budget.deviceIds/);
  });
});

// ---------------------------------------------------------------------------
// Mode cross rules
// ---------------------------------------------------------------------------

describe('delegate node — mode cross rules', () => {
  it('advice + budget → error teaching the mode split', () => {
    const flow = delegateFlow({
      plan: {
        goal: 'ask',
        nodes: [
          {
            id: 'ask1',
            delegate: {
              question: 'q', mode: 'advice',
              budget: { maxCommands: 1, deviceIds: ['hvac-b1'], allowedCommands: ['set-temperature'] },
            },
          },
        ],
      },
    });
    const errors = errorsOf(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/mode 'advice' but carries a budget/);
  });

  it('actuating without budget → error', () => {
    const flow = delegateFlow({
      plan: {
        goal: 'act',
        nodes: [{ id: 'd1', delegate: { question: 'q', mode: 'actuating' } }],
      },
    });
    const errors = errorsOf(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/mode 'actuating' but carries no budget/);
  });

  it('actuating + outputs → error (outputs are advice-only)', () => {
    const flow = delegateFlow();
    (flow.plan.nodes[0].delegate!).outputs = ['chosenDevice'];
    const errors = errorsOf(flow);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/declares outputs/);
  });
});

// ---------------------------------------------------------------------------
// Fallback references
// ---------------------------------------------------------------------------

describe('delegate node — fallback references', () => {
  function flowWithFallback(fallback: unknown): FlowDefinition {
    return delegateFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'd1',
            delegate: { question: 'q', mode: 'advice', fallback: fallback as never },
          },
          { id: 'safe-shed', capability: 'turn-off', deviceId: 'hvac-b1', dependsOn: [] },
        ],
      },
    });
  }

  it('accepts a fallback referencing an existing action node', () => {
    expect(errorsOf(flowWithFallback({ policy: 'node', nodeId: 'safe-shed' }))).toEqual([]);
  });

  it('rejects an unknown fallback target, naming known nodes', () => {
    const errors = errorsOf(flowWithFallback({ policy: 'node', nodeId: 'nope' }));
    expect(errors.some(e => /fallback references unknown node 'nope'/.test(e) && /safe-shed/.test(e))).toBe(true);
  });

  it('rejects a self-referencing fallback', () => {
    expect(errorsOf(flowWithFallback({ policy: 'node', nodeId: 'd1' }))[0])
      .toMatch(/cannot use itself/);
  });

  it('rejects a fallback that targets another delegate node (no chaining)', () => {
    const flow = flowWithFallback({ policy: 'node', nodeId: 'safe-shed' });
    const target = flow.plan.nodes[1] as unknown as Record<string, unknown>;
    delete target.capability;
    delete target.deviceId;
    target.delegate = { question: 'q2', mode: 'advice' };
    const errors = errorsOf(flow);
    expect(errors.some(e => /which is itself a delegate node/.test(e))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // R33 (DevLoop, Smart F4) — authoring WARNINGs for the silent-supersession
  // traps (a 422 would be wrong: dedicated fallback nodes are legal).
  // -------------------------------------------------------------------------

  function warningsOf(flow: unknown): string[] {
    return validateFlow(flow, undefined, { isExecutableCapability: executable })
      .filter(i => i.level === 'warning')
      .map(i => i.message);
  }

  it('R33: onFail + fallback on the SAME delegate node warns that fallback SUPersedes onFail (not 422)', () => {
    const flow = flowWithFallback({ policy: 'node', nodeId: 'safe-shed' });
    (flow.plan.nodes[0] as unknown as { onFail: unknown }).onFail = { policy: 'abort' };
    // Still authorable — the warning teaches the runtime precedence (the
    // engine rewrites the node's failure handling into the fallback).
    expect(errorsOf(flow)).toEqual([]);
    const warnings = warningsOf(flow);
    expect(warnings.some(w =>
      /BOTH onFail and delegate\.fallback/.test(w) && /SUPersedes/.test(w),
    )).toBe(true);
  });

  it('R33: a fallback targeting a GUARDED branch node warns the branch is excluded from scheduling (Smart F4 trap)', () => {
    const flow = flowWithFallback({ policy: 'node', nodeId: 'gate-lock' });
    (flow.plan.nodes[1] as unknown as Record<string, unknown>).id = 'gate-lock';
    (flow.plan.nodes[1] as unknown as Record<string, unknown>).condition = 'delegate.d1.verdict == "real-intrusion"';
    expect(errorsOf(flow)).toEqual([]);
    const warnings = warningsOf(flow);
    expect(warnings.some(w =>
      /fallback references node 'gate-lock', which carries a condition/.test(w) &&
      /EXCLUDED from normal scheduling/.test(w),
    )).toBe(true);
  });

  it('R33: a fallback to a DEDICATED (condition-less) action node stays warning-free', () => {
    expect(warningsOf(flowWithFallback({ policy: 'node', nodeId: 'safe-shed' }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Budget governance (ratified trade-off #1 + T-201)
// ---------------------------------------------------------------------------

describe('delegate node — budget governance', () => {
  it('accepts an in-zone, bound, executable budget (zone-b trigger, zone-b device)', () => {
    const errors = errorsOf(delegateFlow(), scenario());
    expect(errors).toEqual([]);
  });

  it('REJECTS a budget device outside the trigger zone (trade-off #1)', () => {
    const flow = delegateFlow();
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-a1'];
    const errors = errorsOf(flow, scenario());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/sits in zone 'zone-a' but the trigger zone is 'zone-b'/);
    expect(errors[0]).toMatch(/inside the trigger zone/);
    expect(errors[0]).toMatch(/agreement invocation/);
  });

  it('rejects a budget device that does not exist', () => {
    const flow = delegateFlow();
    (flow.plan.nodes[0] as { assigneeAgentId?: string }).assigneeAgentId = 'energy-optimizer';
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['ghost-hvac'];
    const errors = errorsOf(flow, scenario());
    expect(errors.some(e => /'ghost-hvac' does not exist/.test(e))).toBe(true);
  });

  it('rejects a budget device not bound to the assignee, naming the holder', () => {
    const flow = delegateFlow();
    (flow.plan.nodes[0] as { assigneeAgentId?: string }).assigneeAgentId = 'energy-optimizer';
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-a1'];
    const errors = errorsOf(flow, scenario());
    expect(errors.some(e => /is not bound to assignee 'energy-optimizer'/.test(e) && /zone-a-agent/.test(e)))
      .toBe(true);
  });

  it('rejects an allowedCommand with no executable path on ANY budget device', () => {
    const flow = delegateFlow();
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['teleport'];
    const errors = errorsOf(flow, scenario());
    expect(errors.some(e => /no executable path on ANY budget device/.test(e) && /'teleport'/.test(e))).toBe(true);
  });

  // T-605 (R26, HO26-F02): per-command UNION semantics — the authoring gate
  // matches the runtime contract (device ∈ deviceIds ∧ command ∈
  // allowedCommands, model pairs naturally). Heterogeneous budgets are
  // expressible; only a command executable on NO budget device 422s.
  it('T-605: heterogeneous budget validates — a command needs a path on AT LEAST ONE device', () => {
    const flow = delegateFlow();
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-b1', 'hvac-b2'];
    // 'turn-off' is executable on hvac-b1 only (hvac-b2 lacks it).
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['set-temperature', 'turn-off'];
    const errors = errorsOf(flow, scenario());
    expect(errors).toEqual([]);
    // The pairing is TAUGHT: a warning names which devices run the command.
    const warnings = validateFlow(flow, scenario(), { isExecutableCapability: executable })
      .filter(i => i.level === 'warning')
      .map(i => i.message);
    const pairing = warnings.find(m => /'turn-off'/.test(m) && /hvac-b1/.test(m) && /hvac-b2/.test(m));
    expect(pairing).toBeDefined();
    expect(pairing).toMatch(/executes on 1 of 2 budget devices/);
  });

  it('T-605: a command executable on no SINGLE-device budget still 422s, naming the command and the device capabilities', () => {
    const flow = delegateFlow();
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-b2'];
    // hvac-b2 does not declare 'turn-off'.
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['turn-off'];
    const errors = errorsOf(flow, scenario());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/'turn-off' has no executable path on ANY budget device/);
    expect(errors[0]).toMatch(/hvac-b2 executes: /);
  });

  // R33 (DevLoop, Smart F3): the budget-gate error must BREAK the circular
  // authoring loop — list what the devices CAN execute (expanded through
  // the runtime's own dispatch routes) and name the exits (use the declared
  // capability name, or declare the wanted command literally via the
  // capability-widening lane). The old message showed DECLARED capabilities
  // ("provides: cooling"), so a 'set-temperature' budget against a
  // 'cooling'-only device looked unfixable without guessing.
  it('R33: semantic-capability case — the error shows the expansion and both fix lanes', () => {
    const sc = scenario();
    // The Smart F3 shape: the device declares ONLY the semantic 'cooling',
    // and the registry oracle backs command names, not semantic words.
    const hvacA1 = sc.devices.find(d => d.id === 'hvac-a1')!;
    hvacA1.capabilities = ['cooling'];
    const strictOracle = (name: string): boolean => name.startsWith('set-') || ['turn-on', 'turn-off'].includes(name);

    const flow = delegateFlow({ trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' } });
    (flow.plan.nodes[0] as { assigneeAgentId?: string }).assigneeAgentId = 'zone-a-agent';
    flow.plan.nodes[0].delegate!.budget!.deviceIds = ['hvac-a1'];
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['set-temperature'];

    const errors = validateFlow(flow, sc, { isExecutableCapability: strictOracle })
      .filter(i => i.level === 'error')
      .map(i => i.message);
    expect(errors).toHaveLength(1);
    const message = errors[0];
    // The executable surface (expanded), not the raw declared list.
    expect(message).toMatch(/hvac-a1 executes: set-temperature/);
    expect(message).toMatch(/declared: cooling/);
    // The loop-breaker: the command IS reachable via the semantic expansion,
    // but the gate matches literals — both exits are named.
    expect(message).toMatch(/reachable on a budget device through a declared semantic capability/);
    expect(message).toMatch(/use the DECLARED capability name as the allowedCommand/);
    expect(message).toMatch(/declare 'set-temperature' literally/);
    expect(message).toMatch(/modify-object proposal/);
  });

  it('R33: a command registered nowhere — the error names the executable vocabulary instead', () => {
    const flow = delegateFlow();
    flow.plan.nodes[0].delegate!.budget!.allowedCommands = ['teleport'];
    const errors = errorsOf(flow, scenario());
    const message = errors.find(e => /'teleport'/.test(e));
    expect(message).toBeDefined();
    expect(message).toMatch(/'teleport' is not a registered command on this platform/);
    expect(message).toMatch(/use one of the executable names above/);
    expect(message).toMatch(/executes: /);
  });

  it('without the executability oracle, declared commands pass (legacy core-only semantics)', () => {
    const flow = delegateFlow();
    const errors = validateFlow(flow, scenario())
      .filter(i => i.level === 'error')
      .map(i => i.message);
    expect(errors).toEqual([]);
  });

  it('rejects a cross-tenant explicit assignee (T-201)', () => {
    const sc = scenario();
    (sc.agents[1] as { ownerUserId?: string }).ownerUserId = 'someone-else';
    const flow = delegateFlow();
    (flow as { authorUserId?: string }).authorUserId = 'tenant-a';
    (flow.plan.nodes[0] as { assigneeAgentId?: string }).assigneeAgentId = 'zone-a-agent';
    const errors = errorsOf(flow, sc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/owned by another tenant/);
    expect(errors[0]).toMatch(/agreement invocation/);
  });

  it('rejects a disabled assignee', () => {
    const sc = scenario();
    (sc.agents[0] as { enabled?: boolean }).enabled = false;
    const flow = delegateFlow();
    (flow.plan.nodes[0] as { assigneeAgentId?: string }).assigneeAgentId = 'energy-optimizer';
    const errors = errorsOf(flow, sc);
    expect(errors.some(e => /'energy-optimizer' is disabled/.test(e))).toBe(true);
  });

  it('auto-match picks the agent bound to every budget device; ambiguity is a warning', () => {
    const sc = scenario();
    // Both agents eligible for advice (no budget) → ambiguity warning, first wins.
    const adviceFlow = delegateFlow({
      plan: { goal: 'g', nodes: [{ id: 'd1', delegate: { question: 'q', mode: 'advice' } }] },
    });
    const result = validateFlow(adviceFlow, sc, { isExecutableCapability: executable });
    expect(result.some(i => i.level === 'warning' && /ambiguous/.test(i.message))).toBe(true);
    expect(result.filter(i => i.level === 'error')).toEqual([]);

    // Actuating with a budget only zone-a-agent's device qualifies → resolves
    // to zone-a-agent without ambiguity.
    const actuatingFlow = delegateFlow({
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'd1',
            delegate: {
              question: 'q', mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-a1'], allowedCommands: ['set-temperature'] },
            },
          },
        ],
      },
    });
    const result2 = validateFlow(actuatingFlow, sc, { isExecutableCapability: executable });
    expect(result2.filter(i => i.level === 'error')).toEqual([]);
    expect(result2.some(i => i.level === 'warning' && /ambiguous/.test(i.message))).toBe(false);
  });

  it('schedule triggers (no zone) allow cross-zone budgets — same asymmetry as action nodes', () => {
    const flow = delegateFlow({
      trigger: { kind: 'schedule', everySimSec: 3600 },
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'd1',
            assigneeAgentId: 'zone-a-agent',
            delegate: {
              question: 'q', mode: 'actuating',
              budget: { maxCommands: 1, deviceIds: ['hvac-a1'], allowedCommands: ['set-temperature'] },
            },
          },
        ],
      },
    });
    // hvac-a1 is in zone-a and the trigger has NO zone (facility-level
    // schedule) — the zone gate must stay silent; binding/executability pass.
    const errors = errorsOf(flow, scenario());
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DAG participation
// ---------------------------------------------------------------------------

describe('delegate node — DAG participation', () => {
  it('action nodes may dependOn delegate nodes (full-list semantics pass)', () => {
    const flow = delegateFlow({
      plan: {
        goal: 'g',
        nodes: [
          { id: 'd1', delegate: { question: 'q', mode: 'advice', outputs: ['riskZone'] } },
          { id: 'act', capability: 'turn-off', deviceId: 'hvac-b1', dependsOn: ['d1'] },
        ],
      },
    });
    expect(errorsOf(flow, scenario())).toEqual([]);
  });

  it('a delegate dependsOn referencing an unknown node fails the shared semantics pass', () => {
    const flow = delegateFlow({
      plan: {
        goal: 'g',
        nodes: [
          { id: 'd1', delegate: { question: 'q', mode: 'advice' }, dependsOn: ['ghost'] },
        ],
      },
    });
    expect(errorsOf(flow)).toHaveLength(1);
    expect(errorsOf(flow)[0]).toMatch(/dependsOn references unknown node 'ghost'/);
  });
});

// ---------------------------------------------------------------------------
// T-108 (R32, F16) — advice-guard degradation teaching
// ---------------------------------------------------------------------------

describe('delegate node — T-108 advice-guard degradation warning', () => {
  function guardFlow(delegateFallback: Record<string, unknown> | undefined): FlowDefinition {
    return delegateFlow({
      trigger: { kind: 'event', eventType: 'smoke', zoneId: 'zone-b' },
      plan: {
        goal: 'route the cleanroom verdict',
        nodes: [
          {
            id: 'ask-verdict',
            delegate: {
              question: 'Is the cleanroom verdict zone-b? (yes/no)',
              mode: 'advice',
              outputs: ['verdict'],
              ...(delegateFallback !== undefined ? { fallback: delegateFallback } : {}),
            },
          },
          {
            id: 'go-lab-b',
            capability: 'air-purification',
            condition: 'delegate.ask-verdict.verdict == "lab-b"',
            dependsOn: ['ask-verdict'],
          },
          {
            id: 'go-elsewhere',
            capability: 'cooling',
            condition: 'delegate.ask-verdict.verdict != "lab-b"',
            dependsOn: ['ask-verdict'],
          },
        ],
      },
    });
  }

  function adviceWarnings(flow: unknown): string[] {
    return validateFlow(flow, undefined)
      .filter(i => i.level === 'warning' && /advice|dead-ends/i.test(i.message) && /fallback/.test(i.message))
      .map(i => i.message);
  }

  it('warns when an advice guard references a fallback-less delegate (F16 deadlock)', () => {
    const warnings = adviceWarnings(guardFlow(undefined));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'go-lab-b'");
    expect(warnings[0]).toContain("'go-elsewhere'");
    expect(warnings[0]).toContain("delegate 'ask-verdict'");
    expect(warnings[0]).toContain('BOTH branches');
    // Teaching, not blocking.
    expect(errorsOf(guardFlow(undefined))).toEqual([]);
  });

  it('a declared fallback node covers the degraded lane — no warning', () => {
    expect(adviceWarnings(guardFlow({ policy: 'node', nodeId: 'manual-branch' }))).toEqual([]);
  });

  it('an explicit fallback {policy:"none"} is the author\'s informed opt-out — no warning', () => {
    expect(adviceWarnings(guardFlow({ policy: 'none' }))).toEqual([]);
  });

  it('guards on ENV state (bare-condition guards) never warn', () => {
    const flow = delegateFlow({
      trigger: { kind: 'event', eventType: 'smoke', zoneId: 'zone-b' },
      plan: {
        goal: 'purify when humid',
        nodes: [
          { id: 'ask', delegate: { question: 'Is zone-b temperature above 30?', mode: 'advice', outputs: ['answer'] } },
          { id: 'act', capability: 'cooling', condition: 'humidity > 70', dependsOn: ['ask'] },
        ],
      },
    });
    expect(adviceWarnings(flow)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-090 (R28) — delegate-question open-endedness lint
// ---------------------------------------------------------------------------

describe('delegate node — T-090 question lint', () => {
  function questionFlow(question: string): FlowDefinition {
    return delegateFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'ask',
            delegate: { question, mode: 'advice', outputs: ['answer'] },
          },
        ],
      },
    });
  }

  function warningsOf(flow: unknown): string[] {
    return validateFlow(flow, undefined)
      .filter(i => i.level === 'warning' && /open-ended/.test(i.message))
      .map(i => i.message);
  }

  it.each([
    'What should we do about the peak?',
    'How should we handle the grid event?',
    'Is it okay to shed the battery now?',
    'What do you recommend for the hospital wing?',
    'Should we shut down HVAC B1?',
    "What's the best setpoint right now?",
  ])('warns (non-blocking) on the open-ended phrasing "%s"', question => {
    const warnings = warningsOf(questionFlow(question));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("node 'ask'");
    expect(warnings[0]).toContain('closed-threshold');
    // Teaching, not blocking: no error-level issue appeared.
    expect(errorsOf(questionFlow(question))).toEqual([]);
  });

  it('closed-threshold and bounded-choice questions stay clean', () => {
    expect(warningsOf(questionFlow('Is zone-b temperature above 30?'))).toEqual([]);
    expect(warningsOf(questionFlow('Pick one budget HVAC and a target temperature (18-26).'))).toEqual([]);
    expect(warningsOf(questionFlow('Which zone has the highest load right now?'))).toEqual([]);
  });

  it('one warning per offending delegate node (not per pattern hit)', () => {
    const warnings = warningsOf(questionFlow('What should we do, and how should we do it?'));
    expect(warnings).toHaveLength(1);
  });

  it('the baseline fixture stays clean (no warning drift into existing shapes)', () => {
    expect(warningsOf(delegateFlow())).toEqual([]);
  });
});
