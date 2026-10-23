/**
 * @vitest-environment node
 *
 * R1 B1-8 (u3 F2/F3 / P-17+P-18) — authoring/runtime 口径一致性:
 *
 *   - the declared-zone cross-zone refusal is the SAME check authoring and
 *     runtime run (resolveFlowAssignments), and `crossZone: true` is the
 *     explicit declaration both sides honor ("配置绿灯、着火爆雷" is over);
 *   - an EVENT trigger with no declared zoneId — where the run scopes to
 *     whichever zone the event fires in — warns at authoring with the exact
 *     runtime refusal wording plus the `crossZone` escape hatch;
 *   - capability deliverability is ONE truth (bound devices + the injected
 *     executability oracle) for authoring AND runtime: an agent whose bound
 *     device provides the capability resolves even when its own capability
 *     table omits the name.
 */

import { describe, it, expect, vi } from 'vitest';

import { loadScenarioFile, type ScenarioDefinition } from '../../scenario/index.js';
import type { CognitiveAgent } from '../../agent/CognitiveAgent.js';
import type { PlanNodeInvoker } from '../../workflow/plan-executor.js';
import { validateFlow } from '../flow-types.js';
import { createFlowNodeInvoker, resolveFlowAssignments } from '../flow-invoker.js';
import { FlowEngine, type FlowDefinition, type FlowRunRecord } from '../flow-engine.js';

function scenario(): ScenarioDefinition {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'zone-parity', name: 'Zone Parity' },
    zones: [{ id: 'z-atrium', adjacentZoneIds: [] }, { id: 'z-corridor', adjacentZoneIds: [] }],
    devices: [
      { id: 'atrium-sensor', type: 'smoke-sensor', capabilities: ['smoke-detection'], zoneId: 'z-atrium' },
      { id: 'corridor-speaker', type: 'speaker', capabilities: ['emergency-broadcast', 'turn-on'], zoneId: 'z-corridor' },
    ],
    agents: [
      {
        id: 'sec-agent', name: 'Security',
        capabilities: ['emergency-broadcast', 'turn-on'],
        managesZoneIds: ['z-atrium', 'z-corridor'], boundDeviceIds: ['atrium-sensor', 'corridor-speaker'],
      },
    ],
    // T78: the event types this suite's flows trigger on are DECLARED — the
    // ghost-event-type oracle treats undeclared types honestly, and these
    // tests count ZONE warnings (a second, unrelated warning would drown
    // their toHaveLength assertions). The ghost case is a separate face.
    events: [{ id: 'evt-smoke', type: 'smoke-detected', zoneId: 'z-atrium' }],
  });
}

const CROSS_ZONE_FLOW: FlowDefinition = {
  id: 'flow-cross',
  name: 'Corridor broadcast',
  enabled: true,
  trigger: { kind: 'condition', zoneId: 'z-atrium', conditions: [{ path: 'smoke', op: '>', value: 0.5 }] },
  plan: {
    goal: 'broadcast in the corridor when the atrium detects smoke',
    nodes: [{ id: 'n1', capability: 'emergency-broadcast', deviceId: 'corridor-speaker' }],
  },
};

describe('B1-8: declared-zone cross-zone pin — authoring and runtime agree', () => {
  it('authoring refuses the undeclared cross-zone pin (same function the runtime runs)', () => {
    const issues = validateFlow(CROSS_ZONE_FLOW, scenario()).filter(i => i.level === 'error');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("sits in zone 'z-corridor' but the trigger zone is 'z-atrium'");
  });

  it('`crossZone: true` clears the authoring refusal', () => {
    const declared = {
      ...CROSS_ZONE_FLOW,
      plan: {
        ...CROSS_ZONE_FLOW.plan,
        nodes: CROSS_ZONE_FLOW.plan.nodes.map(n => ({ ...n, crossZone: true })),
      },
    };
    const issues = validateFlow(declared, scenario()).filter(i => i.level === 'error');
    expect(issues).toHaveLength(0);
  });

  it('runtime refuses with the SAME message, and honors the crossZone declaration', async () => {
    const runs: FlowRunRecord[] = [];
    const engine = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => [CROSS_ZONE_FLOW],
      agents: new Map(),
      invoker: async () => ({ success: true, result: { ok: true } }),
      envStateReader: () => ({ 'z-atrium': { smoke: 1 } }),
      publish: () => undefined,
      now: () => '2026-01-01T00:00:00.000Z',
      onRun: record => runs.push(record),
    });
    await engine.triggerManually(CROSS_ZONE_FLOW.id);
    expect(runs[0].status).toBe('failed');
    // PARITY: the runtime summary carries the authoring error's own words.
    const authoring = validateFlow(CROSS_ZONE_FLOW, scenario()).find(i => i.level === 'error');
    expect(runs[0].summary).toContain(authoring!.message.split(' — ')[0]);

    const declared = {
      ...CROSS_ZONE_FLOW,
      plan: {
        ...CROSS_ZONE_FLOW.plan,
        nodes: CROSS_ZONE_FLOW.plan.nodes.map(n => ({ ...n, crossZone: true })),
      },
    };
    const ok: FlowRunRecord[] = [];
    const engine2 = new FlowEngine({
      scenario: scenario(),
      flowsProvider: () => [declared],
      agents: new Map(),
      invoker: async () => ({ success: true, result: { ok: true } }),
      envStateReader: () => ({ 'z-atrium': { smoke: 1 } }),
      publish: () => undefined,
      now: () => '2026-01-01T00:00:00.000Z',
      onRun: record => ok.push(record),
    });
    await engine2.triggerManually(declared.id);
    expect(ok[0].status).toBe('success');
  });
});

describe('B1-8: event trigger without a declared zone warns at authoring', () => {
  const eventFlow = (crossZone?: boolean): FlowDefinition => ({
    id: 'flow-event',
    name: 'Event broadcast',
    enabled: true,
    trigger: { kind: 'event', eventType: 'smoke-detected' },
    plan: {
      goal: 'broadcast',
      nodes: [{ id: 'n1', capability: 'emergency-broadcast', deviceId: 'corridor-speaker', ...(crossZone ? { crossZone: true } : {}) }],
    },
  });

  it('warns with the runtime refusal wording + the crossZone escape hatch', () => {
    const warnings = validateFlow(eventFlow(), scenario()).filter(i => i.level === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("sits in zone 'z-corridor'");
    expect(warnings[0].message).toContain('refuses to actuate another zone');
    expect(warnings[0].message).toContain('crossZone: true');
  });

  it('no warning when the declaration is explicit', () => {
    const warnings = validateFlow(eventFlow(true), scenario()).filter(i => i.level === 'warning');
    expect(warnings).toHaveLength(0);
  });

  it('the runtime zone scoping resolves identically (same resolveFlowAssignments)', () => {
    const authoring = validateFlow(eventFlow(), scenario());
    const runtime = resolveFlowAssignments(eventFlow(), scenario());
    // Same truth, same function: no error either side (the event zone only
    // exists at run time — the warning is the authoring face of it).
    expect(authoring.filter(i => i.level === 'error')).toHaveLength(0);
    expect(runtime.issues.filter(i => i.level === 'error')).toHaveLength(0);
  });
});

describe('B1-8: capability truth is one table (bound devices, not the declaration list)', () => {
  it('an agent whose bound device provides the capability resolves even when its capability list omits it', () => {
    const world = loadScenarioFile({
      version: '1.0',
      meta: { id: 'cap-truth', name: 'Capability Truth' },
      zones: [{ id: 'z1', adjacentZoneIds: [] }],
      devices: [{ id: 'pump-1', type: 'pump', capabilities: ['turn-on', 'turn-off'], zoneId: 'z1' }],
      agents: [
        // The declaration list says only 'monitoring' — the BOUND DEVICE is
        // what flows actuate, and it provides turn-on/turn-off.
        { id: 'pump-keeper', name: 'Keeper', capabilities: ['monitoring'], managesZoneIds: ['z1'], boundDeviceIds: ['pump-1'] },
      ],
      // T78: declare the triggered type (the oracle is honest about ghosts).
      events: [{ id: 'evt-flood', type: 'flood', zoneId: 'z1' }],
    });
    const flow: FlowDefinition = {
      id: 'flow-pump',
      name: 'Run pump',
      enabled: true,
      trigger: { kind: 'event', eventType: 'flood' },
      plan: { goal: 'run the pump', nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: 'pump-keeper' }] },
    };
    expect(validateFlow(flow, world).filter(i => i.level === 'error')).toHaveLength(0);
    expect(resolveFlowAssignments(flow, world).issues.filter(i => i.level === 'error')).toHaveLength(0);
    expect(resolveFlowAssignments(flow, world).assignments.get('n1')).toBe('pump-keeper');
  });
});

describe('B1-8: the runtime invoker honors crossZone for unpinned nodes too', () => {
  interface MockResource { id: string; getCapabilities: () => Array<{ name: string }> }
  function makeResource(id: string, capabilities: string[]): MockResource {
    return { id, getCapabilities: () => capabilities.map(name => ({ name })) };
  }
  function makeAgent(resources: MockResource[]): CognitiveAgent {
    const exec = vi.fn(async () => ({ success: true, result: { ok: true } }));
    return {
      resourceManager: { getAllResources: () => resources },
      executeDeviceCapability: exec,
    } as unknown as CognitiveAgent;
  }

  it('auto-match refuses out-of-zone actuation without the declaration, falls back with it', async () => {
    const agent = makeAgent([
      makeResource('corridor-speaker', ['emergency-broadcast', 'turn-on']),
    ]);
    const invoker = createFlowNodeInvoker(new Map([['sec-agent', agent]]), undefined, id => (id === 'corridor-speaker' ? 'z-corridor' : undefined));
    const node = { id: 'n1', capability: 'emergency-broadcast', assigneeAgentId: 'sec-agent' };

    const refused = await invoker(node, 'sec-agent', { zoneId: 'z-atrium' });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('refusing to actuate a device in another zone');

    const allowed = await invoker({ ...node, crossZone: true }, 'sec-agent', { zoneId: 'z-atrium' });
    expect(allowed.success).toBe(true);
    expect(allowed.deviceId).toBe('corridor-speaker');
  });
});
