/**
 * flowGraph round-trip tests: flow → canvas graph → flow preserves the
 * trigger and plan nodes (dependsOn rebuilt from edges), plus the immediate
 * validation feedback (cycles, self-loops, isolated nodes).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { Flow } from '../api/types';
import { TRIGGER_NODE_ID, flowToGraph, graphToFlow } from '../lib/flowGraph';

// graphToFlow reads the active i18next bundle for issue messages; pin to zh-CN
// so the cycle/self-loop/isolated/trigger assertions stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

function makeFlow(): Pick<Flow, 'trigger' | 'plan'> {
  return {
    trigger: { kind: 'event', eventType: 'fire', zoneId: 'zone-a' },
    plan: {
      goal: '降温并通报',
      nodes: [
        { id: 'cool', capability: 'cooling', params: { target: 24 } },
        { id: 'vent', capability: 'ventilation', dependsOn: ['cool'] },
        {
          id: 'notify',
          capability: 'messaging',
          assigneeAgentId: 'agent-1',
          dependsOn: ['cool', 'vent'],
          condition: 'zone-a.temperature > 30',
          onFail: { policy: 'retry', retries: 2 },
        },
      ],
    },
  };
}

describe('flowToGraph / graphToFlow', () => {
  it('round-trips trigger and plan nodes', () => {
    const flow = makeFlow();
    const { nodes, edges } = flowToGraph(flow);

    // 1 trigger node + 3 action nodes; 3 dependsOn edges.
    expect(nodes.filter(n => n.type === 'trigger')).toHaveLength(1);
    expect(nodes.filter(n => n.type === 'action')).toHaveLength(3);
    expect(edges.map(e => e.id).sort()).toEqual([
      'cool->notify',
      'cool->vent',
      'vent->notify',
    ]);

    const result = graphToFlow(nodes, edges);
    expect(result.issues.filter(i => i.level === 'error')).toEqual([]);
    expect(result.trigger).toEqual(flow.trigger);
    expect(result.planNodes).toEqual(flow.plan.nodes);
  });

  it('lays out waves in columns (Kahn wave → x)', () => {
    const { nodes } = flowToGraph(makeFlow());
    const byId = new Map(nodes.map(n => [n.id, n]));
    // cool (wave 0) left of vent (wave 1) left of notify (wave 2).
    expect(byId.get('cool')!.position.x).toBeLessThan(byId.get('vent')!.position.x);
    expect(byId.get('vent')!.position.x).toBeLessThan(byId.get('notify')!.position.x);
    // The trigger node sits in its own column to the left.
    expect(byId.get(TRIGGER_NODE_ID)!.position.x).toBeLessThan(byId.get('cool')!.position.x);
  });

  it('drops dependsOn when the edge is removed', () => {
    const { nodes, edges } = flowToGraph(makeFlow());
    const kept = edges.filter(e => e.id !== 'cool->vent');
    const result = graphToFlow(nodes, kept);
    const vent = result.planNodes.find(n => n.id === 'vent');
    expect(vent).toBeDefined();
    expect(vent!.dependsOn).toBeUndefined();
  });

  it('flags cycles as errors', () => {
    const { nodes, edges } = flowToGraph({
      trigger: { kind: 'schedule', everySimSec: 60 },
      plan: {
        goal: 'g',
        nodes: [
          { id: 'a', capability: 'c1' },
          { id: 'b', capability: 'c2' },
        ],
      },
    });
    const cyclic = [
      ...edges,
      { id: 'a->b', source: 'a', target: 'b' },
      { id: 'b->a', source: 'b', target: 'a' },
    ];
    const result = graphToFlow(nodes, cyclic);
    const errors = result.issues.filter(i => i.level === 'error');
    expect(errors.some(i => i.message.includes('环'))).toBe(true);
    expect(errors.map(i => i.nodeId).sort()).toEqual(['a', 'b']);
  });

  it('flags self-loops as errors', () => {
    const { nodes, edges } = flowToFlowSafe();
    const result = graphToFlow(nodes, [
      ...edges,
      { id: 'a->a', source: 'a', target: 'a' },
    ]);
    expect(result.issues.some(i => i.level === 'error' && i.message.includes('自环'))).toBe(true);
  });

  it('warns about isolated action nodes', () => {
    const { nodes, edges } = flowToFlowSafe();
    const result = graphToFlow(nodes, edges);
    expect(
      result.issues.some(i => i.level === 'warning' && i.nodeId === 'b' && i.message.includes('孤立')),
    ).toBe(true);
  });

  it('ignores edges touching the trigger node with a warning', () => {
    const { nodes, edges } = flowToFlowSafe();
    const result = graphToFlow(nodes, [
      ...edges,
      { id: 'trigger->a', source: TRIGGER_NODE_ID, target: 'a' },
    ]);
    expect(result.issues.every(i => i.level !== 'error')).toBe(true);
    expect(result.issues.some(i => i.message.includes('触发器'))).toBe(true);
    expect(result.planNodes.find(n => n.id === 'a')!.dependsOn).toBeUndefined();
  });

  it('round-trips notify / wait / service nodes on their own cards', () => {
    const flow: Pick<Flow, 'trigger' | 'plan'> = {
      trigger: { kind: 'event', eventType: 'fire', zoneId: 'zone-a' },
      plan: {
        goal: 'g',
        nodes: [
          { id: 'cool', capability: 'cooling' },
          {
            id: 'hold',
            wait: { simSec: 300 },
            dependsOn: ['cool'],
          },
          {
            id: 'tell',
            notify: { to: 'role', target: 'owner', message: '火警已处置' },
            dependsOn: ['hold'],
          },
          {
            id: 'call-svc',
            service: { semanticType: 'load-management', action: 'shed' },
            params: { amount: 2 },
            dependsOn: ['cool'],
          },
        ],
      },
    };
    const { nodes, edges } = flowToGraph(flow);

    // Each node renders on the card matching its block type.
    const typeOf = new Map(nodes.map(n => [n.id, n.type]));
    expect(typeOf.get('cool')).toBe('action');
    expect(typeOf.get('hold')).toBe('wait');
    expect(typeOf.get('tell')).toBe('notify');
    expect(typeOf.get('call-svc')).toBe('service');

    const result = graphToFlow(nodes, edges);
    expect(result.issues.filter(i => i.level === 'error')).toEqual([]);
    // The notify / wait / service blocks survive the round-trip field-for-field.
    expect(result.planNodes).toEqual(flow.plan.nodes);
  });
});

function flowToFlowSafe() {
  return flowToGraph({
    trigger: { kind: 'condition', zoneId: 'zone-a', conditions: [{ path: 'temperature', op: '>', value: 30 }] },
    plan: {
      goal: 'g',
      nodes: [
        { id: 'a', capability: 'c1' },
        { id: 'b', capability: 'c2' },
      ],
    },
  });
}
