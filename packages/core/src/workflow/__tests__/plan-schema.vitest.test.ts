/**
 * @vitest-environment node
 *
 * Plan schema v1 tests (P4-3, no LLM backend):
 *   - JSON shape validation (ajv)
 *   - DAG semantics (cycles, bad refs, compensation refs, duplicates)
 *   - condition mini-language parse + evaluate
 */

import { describe, it, expect } from 'vitest';
import {
  validatePlanShape,
  validatePlanSemantics,
  parsePlanCondition,
  evaluatePlanCondition,
  type PlanNode,
  type WorkflowPlan,
} from '../plan-schema.js';

function makeNode(id: string, capability: string, extra: Partial<PlanNode> = {}): PlanNode {
  return { id, capability, ...extra };
}

function makePlan(nodes: PlanNode[], extra: Record<string, unknown> = {}): WorkflowPlan {
  return {
    id: 'plan-test',
    goal: 'test goal',
    nodes,
    metadata: { author: 'manual', createdAt: '2026-07-22T00:00:00.000Z' },
    ...extra,
  } as WorkflowPlan;
}

describe('validatePlanShape', () => {
  it('accepts a minimal valid plan', () => {
    const issues = validatePlanShape(makePlan([makeNode('a', 'cooling')]));
    expect(issues).toEqual([]);
  });

  it('rejects missing required top-level fields', () => {
    const issues = validatePlanShape({ id: 'x' });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(i => i.level === 'error')).toBe(true);
  });

  it('rejects a node with empty capability', () => {
    const plan = makePlan([makeNode('a', '')]);
    const issues = validatePlanShape(plan);
    expect(issues.some(i => i.nodeId === 'a' || i.message.includes('capability'))).toBe(true);
  });

  it('rejects unknown node properties and bad onFail enum', () => {
    const plan = makePlan([
      { id: 'a', capability: 'cooling', bogus: 1 } as unknown as PlanNode,
      makeNode('b', 'cooling', { onFail: { policy: 'explode' as never } }),
    ]);
    const issues = validatePlanShape(plan);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects non-object input without throwing', () => {
    expect(validatePlanShape('not a plan').length).toBeGreaterThan(0);
    expect(validatePlanShape(null).length).toBeGreaterThan(0);
    expect(validatePlanShape(42).length).toBeGreaterThan(0);
  });
});

describe('validatePlanSemantics', () => {
  it('accepts a linear DAG', () => {
    const plan = makePlan([
      makeNode('a', 'cooling'),
      makeNode('b', 'cooling', { dependsOn: ['a'] }),
      makeNode('c', 'cooling', { dependsOn: ['b'] }),
    ]);
    expect(validatePlanSemantics(plan)).toEqual([]);
  });

  it('detects a dependency cycle', () => {
    const plan = makePlan([
      makeNode('a', 'cooling', { dependsOn: ['c'] }),
      makeNode('b', 'cooling', { dependsOn: ['a'] }),
      makeNode('c', 'cooling', { dependsOn: ['b'] }),
    ]);
    const issues = validatePlanSemantics(plan);
    expect(issues.some(i => i.message.includes('cycle'))).toBe(true);
  });

  it('detects a self-dependency', () => {
    const plan = makePlan([makeNode('a', 'cooling', { dependsOn: ['a'] })]);
    const issues = validatePlanSemantics(plan);
    expect(issues.some(i => i.message.includes('depends on itself'))).toBe(true);
  });

  it('detects dependsOn references to unknown nodes', () => {
    const plan = makePlan([makeNode('a', 'cooling', { dependsOn: ['ghost'] })]);
    const issues = validatePlanSemantics(plan);
    expect(issues.some(i => i.nodeId === 'a' && i.message.includes("unknown node 'ghost'"))).toBe(true);
  });

  it('detects duplicate node ids', () => {
    const plan = makePlan([makeNode('a', 'cooling'), makeNode('a', 'heating')]);
    const issues = validatePlanSemantics(plan);
    expect(issues.some(i => i.message.includes('duplicate node id'))).toBe(true);
  });

  it('requires compensateNodeId for the compensate policy and it must exist', () => {
    const missing = makePlan([makeNode('a', 'cooling', { onFail: { policy: 'compensate' } })]);
    expect(validatePlanSemantics(missing).some(i => i.message.includes('requires compensateNodeId'))).toBe(true);

    const unknown = makePlan([
      makeNode('a', 'cooling', { onFail: { policy: 'compensate', compensateNodeId: 'ghost' } }),
    ]);
    expect(validatePlanSemantics(unknown).some(i => i.message.includes("unknown node 'ghost'"))).toBe(true);

    const self = makePlan([
      makeNode('a', 'cooling', { onFail: { policy: 'compensate', compensateNodeId: 'a' } }),
    ]);
    expect(validatePlanSemantics(self).some(i => i.message.includes('cannot compensate itself'))).toBe(true);

    const ok = makePlan([
      makeNode('a', 'cooling', { onFail: { policy: 'compensate', compensateNodeId: 'safe' } }),
      makeNode('safe', 'device-control'),
    ]);
    expect(validatePlanSemantics(ok)).toEqual([]);
  });

  it('flags unparseable conditions as errors', () => {
    const plan = makePlan([makeNode('a', 'cooling', { condition: 'turn it on when hot' })]);
    const issues = validatePlanSemantics(plan);
    expect(issues.some(i => i.nodeId === 'a' && i.message.includes('not parseable'))).toBe(true);
  });
});

describe('parsePlanCondition', () => {
  it('parses numeric comparisons with dotted paths', () => {
    expect(parsePlanCondition('zone.temperature > 30')).toEqual({
      path: 'zone.temperature', op: '>', value: 30,
    });
    expect(parsePlanCondition('humidity <= 55')).toEqual({
      path: 'humidity', op: '<=', value: 55,
    });
    expect(parsePlanCondition('zone.temperature>=26.5')).toEqual({
      path: 'zone.temperature', op: '>=', value: 26.5,
    });
    expect(parsePlanCondition('temp < -5')).toEqual({ path: 'temp', op: '<', value: -5 });
  });

  it('parses boolean and quoted-string literals', () => {
    expect(parsePlanCondition('zone.occupied == true')).toEqual({
      path: 'zone.occupied', op: '==', value: true,
    });
    expect(parsePlanCondition("hvac.mode == 'cooling'")).toEqual({
      path: 'hvac.mode', op: '==', value: 'cooling',
    });
    expect(parsePlanCondition('alarm != "off"')).toEqual({
      path: 'alarm', op: '!=', value: 'off',
    });
  });

  it('rejects non-v1 constructs', () => {
    expect(parsePlanCondition('temp > 30 && humidity > 60')).toBeNull();
    expect(parsePlanCondition('temp > hot')).toBeNull();       // bare word literal
    expect(parsePlanCondition('> 30')).toBeNull();              // missing path
    expect(parsePlanCondition('')).toBeNull();
    expect(parsePlanCondition('temp ~ 30')).toBeNull();         // unknown operator
  });
});

describe('evaluatePlanCondition', () => {
  const snapshot = {
    temperature: 33,                       // flat key
    zone: { temperature: 26, occupied: true },
    hvac: { mode: 'cooling' },
  };

  it('resolves flat keys and dotted walks', () => {
    expect(evaluatePlanCondition(parsePlanCondition('temperature > 30')!, snapshot).result).toBe(true);
    expect(evaluatePlanCondition(parsePlanCondition('zone.temperature > 30')!, snapshot).result).toBe(false);
    expect(evaluatePlanCondition(parsePlanCondition('zone.occupied == true')!, snapshot).result).toBe(true);
    expect(evaluatePlanCondition(parsePlanCondition("hvac.mode == 'cooling'")!, snapshot).result).toBe(true);
  });

  it('supports all comparison operators numerically', () => {
    expect(evaluatePlanCondition(parsePlanCondition('temperature >= 33')!, snapshot).result).toBe(true);
    expect(evaluatePlanCondition(parsePlanCondition('temperature <= 32')!, snapshot).result).toBe(false);
    expect(evaluatePlanCondition(parsePlanCondition('temperature != 33')!, snapshot).result).toBe(false);
  });

  it('reports unresolved paths and non-numeric comparisons', () => {
    const missing = evaluatePlanCondition(parsePlanCondition('zone.co2 > 800')!, snapshot);
    expect(missing.result).toBeUndefined();
    expect(missing.unresolvedReason).toContain('zone.co2');

    const nonNumeric = evaluatePlanCondition(parsePlanCondition("hvac.mode > 3")!, snapshot);
    expect(nonNumeric.result).toBeUndefined();
    expect(nonNumeric.unresolvedReason).toContain('not numeric');
  });
});
