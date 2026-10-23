/**
 * @vitest-environment node
 *
 * Mechanism D (design-mixed-initiative-flows.md §5.2) — the flow
 * input-parameter surface:
 *   - authoring: inputs declaration semantics + "${input:name}" reference
 *     validation (422 teaching issues, never silent)
 *   - run time: resolveFlowRunParams (the SINGLE oracle both ends share —
 *     manual runs, flow-service invocations, and the engine's own gate)
 *   - interpolation: whole-string refs keep the input's TYPE, embedded refs
 *     interpolate as text, node guards substitute too, and the definition is
 *     never mutated
 *   - FlowEngine.runDirect: triggerKind 'manual'|'service', record.inputs,
 *     refused records on invalid params, null on unknown/disabled
 */

import { describe, it, expect } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { PlanNodeInvocation, PlanNodeInvoker } from '../../workflow/plan-executor.js';
import {
  FlowEngine,
  interpolateFlowInputs,
  referencedInputNames,
  resolveFlowRunParams,
  validateFlow,
  type FlowDefinition,
  type FlowInputSpec,
  type FlowRunRecord,
} from '../index.js';

function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'flow-inputs-test', name: 'Flow Inputs Test' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
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

function inputsFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: 'night-setback',
    name: 'Night setback',
    enabled: true,
    trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
    inputs: [
      { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
      { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
    ],
    plan: {
      goal: 'night setback to the given setpoint',
      nodes: [
        {
          id: 'n1', capability: 'cooling', deviceId: 'ac-a',
          params: { targetTemperature: '${input:setpoint}', profile: 'mode-${input:mode}' },
        },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authoring: declaration semantics
// ---------------------------------------------------------------------------

describe('validateFlow — inputs declarations', () => {
  it('accepts a well-formed surface and drops no field silently', () => {
    const issues = validateFlow(inputsFlow(), scenario());
    expect(issues.filter(i => i.level === 'error')).toEqual([]);
  });

  it('rejects duplicate input names', () => {
    const issues = validateFlow(inputsFlow({
      inputs: [
        { name: 'setpoint', type: 'number' },
        { name: 'setpoint', type: 'string' },
      ],
    }), scenario());
    expect(issues.some(i => i.level === 'error' && i.message.includes("duplicate input name 'setpoint'"))).toBe(true);
  });

  it('rejects a default whose type contradicts the declaration', () => {
    const issues = validateFlow(inputsFlow({
      inputs: [{ name: 'setpoint', type: 'number', default: '20' }],
    }), scenario());
    expect(issues.some(i => i.level === 'error' && i.message.includes("'setpoint' declares type 'number' but its default"))).toBe(true);
  });

  it('rejects enum values outside the declared type and enum on booleans', () => {
    const enumType = validateFlow(inputsFlow({
      inputs: [{ name: 'mode', type: 'string', enum: ['eco', 3] }],
    }), scenario());
    expect(enumType.some(i => i.level === 'error' && i.message.includes('enum carries 3'))).toBe(true);

    const boolEnum = validateFlow(inputsFlow({
      inputs: [{ name: 'force', type: 'boolean', enum: [true] }],
    }), scenario());
    expect(boolEnum.some(i => i.level === 'error' && i.message.includes('boolean with an enum'))).toBe(true);
  });

  it('rejects min/max on non-number inputs and inverted bounds', () => {
    const minMax = validateFlow(inputsFlow({
      inputs: [{ name: 'mode', type: 'string', min: 1, max: 5 }],
    }), scenario());
    expect(minMax.some(i => i.level === 'error' && i.message.includes("type is 'string' — bounds apply to number inputs only"))).toBe(true);

    const inverted = validateFlow(inputsFlow({
      inputs: [{ name: 'setpoint', type: 'number', min: 26, max: 16 }],
    }), scenario());
    expect(inverted.some(i => i.level === 'error' && i.message.includes('min (26) > max (16)'))).toBe(true);
  });

  it('rejects a default outside the declared bounds', () => {
    const issues = validateFlow(inputsFlow({
      inputs: [{ name: 'setpoint', type: 'number', required: true, min: 16, max: 26, default: 30 }],
    }), scenario());
    expect(issues.some(i => i.level === 'error' && i.message.includes('default 30 is outside its own bounds'))).toBe(true);
  });

  it('rejects unknown inputs keys loudly (closed schema)', () => {
    const issues = validateFlow(inputsFlow({
      inputs: [{ name: 'setpoint', type: 'number', requried: true } as unknown as FlowInputSpec],
    }), scenario());
    expect(issues.some(i => i.level === 'error' && i.message.includes("schema: /inputs/0"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authoring: "${input:x}" reference validation
// ---------------------------------------------------------------------------

describe('validateFlow — input references', () => {
  it('rejects a reference to an undeclared input (teaching, names the node)', () => {
    const flow = inputsFlow();
    (flow.plan.nodes[0].params as Record<string, unknown>).targetTemperature = '${input:target}';
    const issues = validateFlow(flow, scenario());
    expect(issues.some(i =>
      i.level === 'error' && i.nodeId === 'n1' &&
      i.message.includes("'${input:target}' which is not a declared input"),
    )).toBe(true);
  });

  it('rejects a reference on a flow with NO declared surface', () => {
    const flow = inputsFlow();
    delete flow.inputs;
    const issues = validateFlow(flow, scenario());
    expect(issues.some(i =>
      i.level === 'error' &&
      i.message.includes("declares no inputs surface"),
    )).toBe(true);
  });

  it('rejects a reference to an optional, defaultless input (unresolvable when omitted)', () => {
    const flow = inputsFlow({
      inputs: [{ name: 'setpoint', type: 'number' }],
    });
    const issues = validateFlow(flow, scenario());
    expect(issues.some(i =>
      i.level === 'error' &&
      i.message.includes("neither required nor defaulted"),
    )).toBe(true);
  });

  it('accepts references to required or defaulted inputs, incl. inside guards', () => {
    const flow = inputsFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'n1', capability: 'cooling', deviceId: 'ac-a',
            params: { targetTemperature: '${input:setpoint}' },
            condition: 'temperature > ${input:setpoint}',
          },
        ],
      },
    });
    expect(validateFlow(flow, scenario()).filter(i => i.level === 'error')).toEqual([]);
  });

  it('referencedInputNames extracts every occurrence (params deep + condition)', () => {
    expect(referencedInputNames('${input:a} and ${input:b} but ${input:a}')).toEqual(['a', 'b', 'a']);
  });
});

// ---------------------------------------------------------------------------
// Run-time oracle: resolveFlowRunParams (the single function both ends use)
// ---------------------------------------------------------------------------

describe('resolveFlowRunParams — the run-time oracle', () => {
  const inputs: FlowInputSpec[] = [
    { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
    { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
    { name: 'quiet', type: 'boolean', default: false },
  ];

  it('applies defaults and returns the effective params', () => {
    const { params, issues } = resolveFlowRunParams(inputs, { setpoint: 20 });
    expect(issues).toEqual([]);
    expect(params).toEqual({ setpoint: 20, mode: 'comfort', quiet: false });
  });

  it('rejects unknown keys — the surface is closed', () => {
    const { issues } = resolveFlowRunParams(inputs, { setpoint: 20, setpoitn: 21 });
    expect(issues.some(i => i.level === 'error' && i.message.includes("'setpoitn' is not a declared input"))).toBe(true);
  });

  it('rejects type mismatches without coercion', () => {
    const stringNum = resolveFlowRunParams(inputs, { setpoint: '20' });
    expect(stringNum.issues.some(i => i.level === 'error' && i.message.includes("input 'setpoint' must be a number"))).toBe(true);

    const boolString = resolveFlowRunParams(inputs, { setpoint: 20, quiet: 'no' });
    expect(boolString.issues.some(i => i.level === 'error' && i.message.includes("input 'quiet' must be a boolean"))).toBe(true);
  });

  it('enforces min/max bounds and enum membership', () => {
    const below = resolveFlowRunParams(inputs, { setpoint: 15 });
    expect(below.issues.some(i => i.level === 'error' && i.message.includes('below its minimum 16'))).toBe(true);
    const above = resolveFlowRunParams(inputs, { setpoint: 27 });
    expect(above.issues.some(i => i.level === 'error' && i.message.includes('above its maximum 26'))).toBe(true);
    const offEnum = resolveFlowRunParams(inputs, { setpoint: 20, mode: 'sport' });
    expect(offEnum.issues.some(i => i.level === 'error' && i.message.includes('outside its enum'))).toBe(true);
  });

  it('flags missing required inputs (a default satisfies required)', () => {
    const { issues } = resolveFlowRunParams(inputs, {});
    expect(issues.some(i => i.level === 'error' && i.message.includes("required input 'setpoint'"))).toBe(true);
    const defaulted = resolveFlowRunParams(
      [{ name: 'setpoint', type: 'number', required: true, default: 20 }],
      {},
    );
    expect(defaulted.issues).toEqual([]);
    expect(defaulted.params).toEqual({ setpoint: 20 });
  });

  it('refuses params on a flow with no declared surface', () => {
    const { issues } = resolveFlowRunParams(undefined, { setpoint: 20 });
    expect(issues.some(i => i.level === 'error' && i.message.includes('declares no inputs surface'))).toBe(true);
    expect(resolveFlowRunParams(undefined, undefined).params).toEqual({});
  });

  it('an empty surface is a valid zero-arg signature (params still refused)', () => {
    const { issues } = resolveFlowRunParams([], { x: 1 });
    expect(issues.some(i => i.level === 'error')).toBe(true);
    expect(resolveFlowRunParams([], undefined).issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe('interpolateFlowInputs', () => {
  it('whole-string references keep the input TYPE (number stays number)', () => {
    const flow = inputsFlow();
    const out = interpolateFlowInputs(flow, { setpoint: 20, mode: 'eco' });
    expect((out.plan.nodes[0].params as Record<string, unknown>).targetTemperature).toBe(20);
    expect((out.plan.nodes[0].params as Record<string, unknown>).profile).toBe('mode-eco');
  });

  it('never mutates the flow definition (provider re-reads it per run)', () => {
    const flow = inputsFlow();
    const before = JSON.stringify(flow);
    interpolateFlowInputs(flow, { setpoint: 20, mode: 'eco' });
    expect(JSON.stringify(flow)).toBe(before);
  });

  it('interpolates node guard conditions', () => {
    const flow = inputsFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'n1', capability: 'cooling', deviceId: 'ac-a',
            condition: 'temperature > ${input:setpoint}',
          },
        ],
      },
    });
    const out = interpolateFlowInputs(flow, { setpoint: 25, mode: 'eco' });
    expect(out.plan.nodes[0].condition).toBe('temperature > 25');
  });

  it('T-110 (F20): interpolates delegate node questions', () => {
    const flow = inputsFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'ask',
            delegate: {
              question: 'Is the target zone ${input:zone} above ${input:setpoint} degrees right now?',
              mode: 'advice',
              outputs: ['answer'],
            },
          },
        ],
      },
    });
    const out = interpolateFlowInputs(flow, { setpoint: 26, mode: 'eco', zone: 'lab-b' });
    expect((out.plan.nodes[0].delegate as { question: string }).question)
      .toBe('Is the target zone lab-b above 26 degrees right now?');
    // The ORIGINAL definition is untouched (provider re-reads per run).
    expect((flow.plan.nodes[0].delegate as { question: string }).question)
      .toContain('${input:zone}');
  });

  it('walks nested params structures', () => {
    const flow = inputsFlow({
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'n1', capability: 'cooling', deviceId: 'ac-a',
            params: { schedule: [{ at: '${input:mode}' }] },
          },
        ],
      },
    });
    const out = interpolateFlowInputs(flow, { setpoint: 20, mode: 'eco' });
    expect((out.plan.nodes[0].params as { schedule: Array<{ at: string }> }).schedule[0].at).toBe('eco');
  });
});

// ---------------------------------------------------------------------------
// FlowEngine.runDirect (manual + service trigger kinds)
// ---------------------------------------------------------------------------

interface Harness {
  engine: FlowEngine;
  invocations: Array<{ node: string; params?: Record<string, unknown> }>;
  runs: FlowRunRecord[];
}

function harness(flows: FlowDefinition[]): Harness {
  const runs: FlowRunRecord[] = [];
  const invocations: Harness['invocations'] = [];
  const invoker: PlanNodeInvoker = async (node): Promise<PlanNodeInvocation> => {
    invocations.push({ node: node.id, params: node.params });
    return { success: true, result: { ok: true } };
  };
  const engine = new FlowEngine({
    scenario: scenario(),
    flowsProvider: () => flows,
    agents: new Map(),
    invoker,
    envStateReader: () => ({ 'zone-a': { temperature: 22 } }),
    publish: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
    onRun: record => runs.push(record),
  });
  return { engine, invocations, runs };
}

describe('FlowEngine.runDirect — parameterized direct runs', () => {
  it('runs with params, substitutes into node params, records effective inputs', async () => {
    const h = harness([inputsFlow()]);
    const record = await h.engine.runDirect('night-setback', 'service', { setpoint: 18, mode: 'eco' });
    expect(record).not.toBeNull();
    expect(record!.triggerKind).toBe('service');
    expect(record!.status).toBe('success');
    expect(record!.inputs).toEqual({ setpoint: 18, mode: 'eco' });
    expect(h.invocations).toEqual([
      { node: 'n1', params: { targetTemperature: 18, profile: 'mode-eco' } },
    ]);
  });

  it('applies defaults for omitted optional inputs', async () => {
    const h = harness([inputsFlow()]);
    const record = await h.engine.runDirect('night-setback', 'manual', { setpoint: 21 });
    expect(record!.triggerKind).toBe('manual');
    expect(record!.inputs).toEqual({ setpoint: 21, mode: 'comfort' });
    expect(h.invocations[0].params).toEqual({ targetTemperature: 21, profile: 'mode-comfort' });
  });

  it('refuses invalid params honestly (defense in depth — same oracle)', async () => {
    const h = harness([inputsFlow()]);
    const record = await h.engine.runDirect('night-setback', 'service', { setpoint: 40 });
    expect(record!.status).toBe('failed');
    expect(record!.summary).toContain('invalid run parameters');
    expect(record!.summary).toContain('above its maximum 26');
    expect(h.invocations).toEqual([]); // nothing executed
  });

  it('refuses params on a surfaceless flow', async () => {
    const flow = inputsFlow();
    delete flow.inputs;
    delete flow.plan.nodes[0].params;
    const h = harness([flow]);
    const record = await h.engine.runDirect('night-setback', 'manual', { setpoint: 20 });
    expect(record!.status).toBe('failed');
    expect(record!.summary).toContain('declares no inputs surface');
  });

  it('returns null for unknown or disabled flows (triggerManually keeps its boolean)', async () => {
    const h = harness([inputsFlow({ enabled: false })]);
    expect(await h.engine.runDirect('night-setback', 'manual')).toBeNull();
    expect(await h.engine.runDirect('nope', 'manual')).toBeNull();
    expect(await h.engine.triggerManually('night-setback')).toBe(false);

    const h2 = harness([inputsFlow()]);
    expect(await h2.engine.triggerManually('night-setback', { params: { setpoint: 20 } })).toBe(true);
    expect(h2.runs[0].inputs).toEqual({ setpoint: 20, mode: 'comfort' });
  });

  it('a flow without a surface runs bit-identically (no inputs on the record)', async () => {
    const flow = inputsFlow();
    delete flow.inputs;
    delete flow.plan.nodes[0].params;
    const h = harness([flow]);
    const record = await h.engine.runDirect('night-setback', 'manual');
    expect(record!.status).toBe('success');
    expect(record!.inputs).toBeUndefined();
    expect(h.runs[0].inputs).toBeUndefined();
  });
});
