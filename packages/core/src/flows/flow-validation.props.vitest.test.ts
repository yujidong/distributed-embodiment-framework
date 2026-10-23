/**
 * @vitest-environment node
 *
 * Wave F2-1 (docs/plan-r84-verification-framework.md): fast-check property
 * tests for flow validation (packages/core/src/flows/flow-types.ts
 * validateFlow — the compiler pass every user-authored flow goes through).
 *
 *   P1 robustness: arbitrary input NEVER throws and always returns a
 *      PlanIssue list (validateFlow's documented contract is "returns
 *      issues only — never throws").
 *   P2 soundness on well-formed input: a generated VALID flow (schedule
 *      trigger, unique node ids, dependsOn pointing strictly backwards —
 *      a DAG by construction) validates with zero error-level issues.
 *   P3 completeness on cycles: any dependsOn graph containing a cycle is
 *      REJECTED with an error-level issue ("dependency cycle detected").
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateFlow } from './flow-types.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const safeWord = fc.string({ unit: fc.constantFrom(...'abcdefghij'.split('')), minLength: 1, maxLength: 12 });

/** One action node; dependsOn is supplied by the caller (graph shape varies per property). */
function actionNodeArb(id: string, dependsOn: fc.Arbitrary<string[]>): fc.Arbitrary<Record<string, unknown>> {
  return dependsOn.map(deps => ({
    id,
    capability: `cap-${id}`,
    ...(deps.length > 0 ? { dependsOn: deps } : {}),
  }));
}

function flowWithNodes(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: 'flow-prop',
    name: 'Property Flow',
    enabled: true,
    trigger: { kind: 'schedule', atSimTimeSec: 60 },
    plan: { goal: 'property-test goal', nodes },
  };
}

const errorsOf = (flow: unknown) => validateFlow(flow).filter(i => i.level === 'error');

// ---------------------------------------------------------------------------
// P1 — arbitrary input never throws
// ---------------------------------------------------------------------------

describe('validateFlow robustness', () => {
  it('never throws on arbitrary JSON-ish input and always returns issues', () => {
    fc.assert(
      fc.property(fc.anything(), input => {
        let issues: ReturnType<typeof validateFlow> | undefined;
        expect(() => {
          issues = validateFlow(input);
        }).not.toThrow();
        expect(Array.isArray(issues)).toBe(true);
        for (const issue of issues!) {
          expect(['error', 'warning']).toContain(issue.level);
          expect(typeof issue.message).toBe('string');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on shape-valid flows with arbitrary dependsOn wiring', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }).chain(count => {
          const ids = Array.from({ length: count }, (_, i) => `n${i}`);
          return fc.array(
            fc.subarray(ids).map(deps => deps),
            { minLength: count, maxLength: count },
          ).map(depLists => depLists.map((deps, i) => ({
            id: ids[i],
            capability: 'cooling',
            ...(deps.length > 0 ? { dependsOn: deps } : {}),
          })));
        }),
        nodes => {
          expect(() => validateFlow(flowWithNodes(nodes))).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// P2 — valid DAG flows pass with zero errors
// ---------------------------------------------------------------------------

describe('validateFlow soundness', () => {
  it('generated valid flows (schedule trigger, backward-only dependsOn) carry no error issues', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }).chain(count => {
          const nodes: fc.Arbitrary<Record<string, unknown>>[] = [];
          for (let i = 0; i < count; i++) {
            const earlier = Array.from({ length: i }, (_, k) => `n${k}`);
            nodes.push(actionNodeArb(`n${i}`, fc.subarray(earlier)));
          }
          return fc.tuple(...nodes);
        }),
        safeWord,
        nodes => {
          const flow = flowWithNodes(nodes);
          expect(errorsOf(flow)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// P3 — cycles are always rejected
// ---------------------------------------------------------------------------

/** Oracle: does the dependsOn graph contain a cycle? (DFS, three colors.) */
function oracleHasCycle(nodes: ReadonlyArray<{ id: string; dependsOn?: string[] }>): boolean {
  const edges = new Map(nodes.map(n => [n.id, (n.dependsOn ?? []).filter(d => nodes.some(m => m.id === d))]));
  const state = new Map<string, number>(); // 0=visiting, 1=done
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 0) return true;
    if (s === 1) return false;
    state.set(id, 0);
    for (const dep of edges.get(id) ?? []) {
      if (visit(dep)) return true;
    }
    state.set(id, 1);
    return false;
  };
  return nodes.some(n => visit(n.id));
}

describe('validateFlow cycle rejection', () => {
  it('any cyclic dependsOn graph yields an error issue; acyclic ones yield no cycle error', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }).chain(count => {
          const ids = Array.from({ length: count }, (_, i) => `n${i}`);
          return fc
            .array(fc.subarray(ids.filter(id => true)), { minLength: count, maxLength: count })
            .map(depLists =>
              depLists.map((deps, i) => ({
                id: ids[i],
                dependsOn: deps.filter(d => d !== ids[i]), // self-deps are a separate, dedicated error
              })),
            );
        }),
        depNodes => {
          const nodes = depNodes.map(n => ({
            id: n.id,
            capability: 'cooling',
            ...(n.dependsOn.length > 0 ? { dependsOn: n.dependsOn } : {}),
          }));
          const issues = validateFlow(flowWithNodes(nodes));
          const cycleErrors = issues.filter(
            i => i.level === 'error' && /dependency cycle detected/.test(i.message),
          );
          if (oracleHasCycle(depNodes)) {
            expect(cycleErrors.length).toBeGreaterThan(0);
          } else {
            expect(cycleErrors).toEqual([]);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
