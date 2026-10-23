/**
 * @vitest-environment node
 *
 * Static plan validator tests (P4-3, no LLM backend):
 *   - satisfiability against a capability index (assignee / UNSAT)
 *   - preferred-assignee handling
 *   - condition parseability surfacing
 *   - side-effect report (actuation vs monitoring)
 */

import { describe, it, expect } from 'vitest';
import {
  validatePlan,
  classifySideEffect,
  type CapabilityIndex,
} from '../plan-validator.js';
import type { PlanNode, WorkflowPlan } from '../plan-schema.js';

/** The running example: 客厅温度 33° → 降温 (sense → cool → verify). */
function coolingPlan(): WorkflowPlan {
  return {
    id: 'plan-cool-living-room',
    goal: '客厅温度 33°，降温到 26°',
    nodes: [
      { id: 'sense', capability: 'temperature-reading' },
      {
        id: 'cool', capability: 'cooling',
        params: { targetTemperature: 26 },
        dependsOn: ['sense'],
        condition: 'zone.temperature > 30',
        onFail: { policy: 'retry', retries: 2 },
      },
      { id: 'verify', capability: 'temperature-reading', dependsOn: ['cool'] },
    ],
    metadata: { author: 'llm', model: 'test-model', createdAt: '2026-07-22T00:00:00.000Z' },
  };
}

const HOME_INDEX: CapabilityIndex = new Map<string, string[]>([
  ['agent-sensor', ['temperature-reading', 'humidity-reading']],
  ['agent-hvac', ['cooling', 'heating', 'hvac-control']],
]);

describe('validatePlan — satisfiable plans', () => {
  it('validates the 3-node cooling plan and assigns every node', () => {
    const result = validatePlan(coolingPlan(), HOME_INDEX);
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.level === 'error')).toEqual([]);
    expect(result.assignments.get('sense')).toBe('agent-sensor');
    expect(result.assignments.get('cool')).toBe('agent-hvac');
    expect(result.assignments.get('verify')).toBe('agent-sensor');
  });

  it('reports side effects: actuation vs monitoring', () => {
    const result = validatePlan(coolingPlan(), HOME_INDEX);
    expect(result.sideEffects.actuation).toEqual(['cool']);
    expect(result.sideEffects.monitoring).toEqual(['sense', 'verify']);
    expect(result.sideEffects.unknown).toEqual([]);
  });

  it('honors a satisfiable preferred assignee', () => {
    const plan = coolingPlan();
    plan.nodes[1].assigneeAgentId = 'agent-hvac';
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(true);
    expect(result.assignments.get('cool')).toBe('agent-hvac');
    expect(result.issues).toEqual([]);
  });

  it('reassigns with a warning when the preferred agent lacks the capability', () => {
    const plan = coolingPlan();
    plan.nodes[1].assigneeAgentId = 'agent-sensor'; // sensor agent cannot cool
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(true);
    expect(result.assignments.get('cool')).toBe('agent-hvac');
    expect(result.issues.some(i =>
      i.level === 'warning' && i.nodeId === 'cool' && i.message.includes('agent-sensor'),
    )).toBe(true);
  });

  it('warns when the preferred assignee is not in the index', () => {
    const plan = coolingPlan();
    plan.nodes[1].assigneeAgentId = 'agent-ghost';
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(true);
    expect(result.assignments.get('cool')).toBe('agent-hvac');
    expect(result.issues.some(i => i.level === 'warning' && i.message.includes('agent-ghost'))).toBe(true);
  });

  it('matches capabilities via synonyms/substrings (shared matching semantics)', () => {
    const plan = coolingPlan();
    plan.nodes[1].capability = 'temperature-control'; // synonym of cooling / hvac-control
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(true);
    expect(result.assignments.get('cool')).toBe('agent-hvac');
  });
});

describe('validatePlan — unsatisfiable / invalid plans', () => {
  it('marks UNSAT capabilities as errors and leaves the node unassigned', () => {
    const plan = coolingPlan();
    plan.nodes[1].capability = 'quantum-teleportation';
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(false);
    expect(result.assignments.has('cool')).toBe(false);
    expect(result.issues.some(i =>
      i.level === 'error' && i.nodeId === 'cool' && i.message.includes('UNSAT'),
    )).toBe(true);
  });

  it('surfaces condition parse errors', () => {
    const plan = coolingPlan();
    plan.nodes[1].condition = 'when it feels hot';
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.nodeId === 'cool' && i.message.includes('not parseable'))).toBe(true);
  });

  it('surfaces DAG errors (cycle) alongside satisfiability info', () => {
    const plan = coolingPlan();
    plan.nodes[0].dependsOn = ['verify']; // sense → cool → verify → sense
    const result = validatePlan(plan, HOME_INDEX);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.message.includes('cycle'))).toBe(true);
  });

  it('stops after shape errors when the JSON shape is broken', () => {
    const result = validatePlan({ id: 'x' }, HOME_INDEX);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.assignments.size).toBe(0);
  });
});

describe('classifySideEffect', () => {
  it('classifies by documented keyword heuristic (actuation wins)', () => {
    expect(classifySideEffect('cooling')).toBe('actuation');
    expect(classifySideEffect('hvac-control')).toBe('actuation');
    expect(classifySideEffect('temperature-reading')).toBe('monitoring');
    expect(classifySideEffect('motion-detection')).toBe('monitoring');
    expect(classifySideEffect('quantum-teleportation')).toBe('unknown');
  });
});
