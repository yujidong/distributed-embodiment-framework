/**
 * @vitest-environment node
 *
 * ReputationTracker unit tests (P4-1) — score math and persistence seam.
 *
 * Covers: Bayesian prior fallback, outcome weights (success 1 / partial 0.5 /
 * failure 0), prior strength α, recency decay toward the prior, aggregate
 * agent scores, outcome classification, and the toJSON/fromJSON round-trip.
 * A controllable clock (injected `now`) makes decay deterministic.
 */

import { describe, it, expect } from 'vitest';

import {
  ReputationTracker,
  computeReputationScore,
  classifyCollaborationOutcome,
  DEFAULT_REPUTATION_CONFIG,
  type ReputationConfig,
} from '../index.js';

const { prior, alpha, halfLifeMs } = DEFAULT_REPUTATION_CONFIG;
const T0 = 1_700_000_000_000; // fixed reference time (ms)

/** Tracker on a manually advanced clock. */
function makeTracker(config?: Partial<ReputationConfig>) {
  let now = T0;
  const tracker = new ReputationTracker(config, () => now);
  return {
    tracker,
    advance: (ms: number) => { now += ms; },
    setNow: (ms: number) => { now = ms; },
  };
}

describe('ReputationTracker — score math', () => {
  it('returns the prior (0.7) for an unknown agent/capability', () => {
    const { tracker } = makeTracker();
    expect(tracker.score('agent-x', 'cooling')).toBeCloseTo(prior, 10);
    expect(tracker.agentScore('agent-x')).toBeCloseTo(prior, 10);
  });

  it('a single success lifts the score only slightly above the prior', () => {
    const { tracker } = makeTracker();
    tracker.recordAttempt('agent-a', 'cooling', 1);
    // (1 + 5·0.7) / (1 + 5) = 4.5/6 = 0.75
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(0.75, 10);
  });

  it('a single failure drops the score below the prior', () => {
    const { tracker } = makeTracker();
    tracker.recordAttempt('agent-a', 'cooling', 0);
    // (0 + 3.5) / 6 ≈ 0.5833
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(3.5 / 6, 10);
  });

  it('data dominates the prior after enough attempts', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < 20; i++) tracker.recordAttempt('agent-a', 'cooling', 1);
    // (20 + 3.5) / 25 = 0.94
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(23.5 / 25, 10);

    for (let i = 0; i < 40; i++) tracker.recordAttempt('agent-a', 'cooling', 0);
    // (20 + 3.5) / 65 ≈ 0.3615
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(23.5 / 65, 10);
  });

  it('partial outcomes count as half a success', () => {
    const { tracker } = makeTracker();
    tracker.recordCollaborationOutcome({
      participants: ['agent-a'],
      capabilities: ['cooling'],
      outcome: 'partial',
    });
    const record = tracker.getRecord('agent-a', 'cooling');
    expect(record).toBeDefined();
    expect(record!.attempts).toBe(1);
    expect(record!.successes).toBeCloseTo(0.5, 10);
    expect(record!.failures).toBeCloseTo(0.5, 10);
    // (0.5 + 3.5) / 6 = 0.6667
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(4 / 6, 10);
  });

  it('recordCollaborationOutcome attributes every participant × every capability', () => {
    const { tracker } = makeTracker();
    tracker.recordCollaborationOutcome({
      participants: ['agent-a', 'agent-b'],
      capabilities: ['cooling', 'heating'],
      outcome: 'failure',
    });
    for (const agent of ['agent-a', 'agent-b']) {
      for (const capability of ['cooling', 'heating']) {
        const record = tracker.getRecord(agent, capability);
        expect(record?.attempts).toBe(1);
        expect(record?.successes).toBe(0);
        expect(record?.failures).toBe(1);
      }
    }
  });

  it('recency decay: stale evidence fades back to the prior', () => {
    const { tracker, advance } = makeTracker();
    for (let i = 0; i < 10; i++) tracker.recordAttempt('agent-a', 'cooling', 1);
    const fresh = tracker.score('agent-a', 'cooling');
    expect(fresh).toBeGreaterThan(0.85);

    // One half-life: evidence halves → (5 + 3.5) / (5 + 5) = 0.85
    advance(halfLifeMs);
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(0.85, 5);

    // Many half-lives: effectively no evidence → prior
    advance(20 * halfLifeMs);
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo(prior, 2);
  });

  it('decay uses time since the LAST update, not the first', () => {
    const { tracker, advance } = makeTracker();
    tracker.recordAttempt('agent-a', 'cooling', 1);
    advance(halfLifeMs * 10); // first attempt nearly forgotten
    tracker.recordAttempt('agent-a', 'cooling', 1); // fresh evidence
    const score = tracker.score('agent-a', 'cooling');
    // ~one effective success + one effective attempt → still above prior
    expect(score).toBeGreaterThan(prior);
  });

  it('agentScore pools evidence across capabilities', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < 4; i++) tracker.recordAttempt('agent-a', 'cooling', 1);
    for (let i = 0; i < 4; i++) tracker.recordAttempt('agent-a', 'heating', 0);
    // pooled: 4 successes / 8 attempts → (4 + 3.5) / 13 ≈ 0.577
    expect(tracker.agentScore('agent-a')).toBeCloseTo(7.5 / 13, 5);
  });

  it('computeReputationScore (pure helper) matches tracker.score', () => {
    const record = { attempts: 4, successes: 3, lastAt: T0 };
    const expected = (3 + alpha * prior) / (4 + alpha);
    expect(computeReputationScore(record, T0)).toBeCloseTo(expected, 10);
    // half a half-life of age: decay = 2^-0.5 ≈ 0.7071
    const decay = Math.pow(0.5, 0.5);
    const aged = (3 * decay + alpha * prior) / (4 * decay + alpha);
    expect(computeReputationScore(record, T0 + halfLifeMs / 2)).toBeCloseTo(aged, 10);
  });
});

describe('classifyCollaborationOutcome', () => {
  it('classifies success / partial / failure from goals', () => {
    expect(classifyCollaborationOutcome({
      success: true,
      results: { goals: [{ achieved: true }, { achieved: true }] },
    })).toBe('success');

    expect(classifyCollaborationOutcome({
      success: false,
      results: { goals: [{ achieved: true }, { achieved: false }] },
    })).toBe('partial');

    expect(classifyCollaborationOutcome({
      success: false,
      results: { goals: [{ achieved: false }] },
    })).toBe('failure');
  });

  it('honors the success flag when no goal detail exists', () => {
    expect(classifyCollaborationOutcome({ success: true })).toBe('success');
    expect(classifyCollaborationOutcome({ success: false })).toBe('failure');
  });
});

describe('ReputationTracker — persistence seam', () => {
  it('toJSON/fromJSON round-trips records', () => {
    const { tracker } = makeTracker();
    tracker.recordAttempt('agent-a', 'cooling', 1);
    tracker.recordAttempt('agent-a', 'cooling', 0);
    tracker.recordAttempt('agent-b', 'heating', 0.5);

    const json = tracker.toJSON();
    // T71 (R8, u1-F3): v2 — records carry the integer event buckets.
    expect(json.version).toBe(2);
    expect(json.records).toHaveLength(2);

    const restored = new ReputationTracker({}, () => T0);
    restored.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(restored.getRecord('agent-a', 'cooling')).toEqual(
      tracker.getRecord('agent-a', 'cooling'),
    );
    expect(restored.score('agent-b', 'heating')).toBeCloseTo(
      tracker.score('agent-b', 'heating'),
      10,
    );
  });

  it('fromJSON replaces existing cells and tolerates malformed entries', () => {
    const tracker = new ReputationTracker({}, () => T0);
    tracker.recordAttempt('stale', 'cooling', 1);
    tracker.fromJSON({
      version: 1,
      records: [
        { agentId: 'agent-a', capability: 'cooling', attempts: 2, successes: 1, failures: 1, lastAt: T0 },
        { capability: 'missing-agent', attempts: 1, successes: 1 } as never,
        { agentId: 'agent-b', capability: 'heating', attempts: Number.NaN, successes: 0 } as never,
      ],
    });
    expect(tracker.size).toBe(1); // only the well-formed row survives
    expect(tracker.getRecord('stale', 'cooling')).toBeUndefined();
    expect(tracker.getRecord('agent-a', 'cooling')?.attempts).toBe(2);
  });

  it('setRecord seeds a cell (server load path) and clamps inconsistent counts', () => {
    const tracker = new ReputationTracker({}, () => T0);
    tracker.setRecord('agent-a', 'cooling', { attempts: 10, successes: 8, lastAt: T0 });
    expect(tracker.score('agent-a', 'cooling')).toBeCloseTo((8 + 3.5) / 15, 10);

    tracker.setRecord('agent-b', 'cooling', { attempts: 2, successes: 5 });
    const record = tracker.getRecord('agent-b', 'cooling');
    expect(record?.successes).toBe(2); // clamped to attempts
  });

  // T71 (R8, u1-F3): the ACCOUNT face counts EVENTS — weights stay the score
  // formula's business, but a count of collaborations is never 0.5.
  it('T71: event buckets count whole events — success, partial, failure each land their own bucket', () => {
    const { tracker } = makeTracker();
    tracker.recordAttempt('agent-a', 'cooling', 1);
    tracker.recordAttempt('agent-a', 'cooling', 1);
    tracker.recordAttempt('agent-a', 'cooling', 0.5);
    tracker.recordAttempt('agent-a', 'cooling', 0);
    tracker.recordAttempt('agent-a', 'cooling', 0);

    const record = tracker.getRecord('agent-a', 'cooling');
    expect(record?.attempts).toBe(5);
    expect(record?.successEvents).toBe(2);
    expect(record?.partialEvents).toBe(1);
    expect(record?.failureEvents).toBe(2);
    // ok + partial + failed === attempts (the invariant the report face vouches for)
    expect(record!.successEvents + record!.partialEvents + record!.failureEvents).toBe(record!.attempts);
    // The WEIGHT sums are unchanged scoring quantities.
    expect(record?.successes).toBeCloseTo(2.5, 10);
    expect(record?.failures).toBeCloseTo(2.5, 10);
  });

  it('T71: v1 rows without buckets are integerized from weight sums (exact for integer sums)', () => {
    const tracker = new ReputationTracker({}, () => T0);
    tracker.fromJSON({
      version: 1,
      records: [
        // Legacy integer row: the reconstruction is exact.
        { agentId: 'agent-a', capability: 'cooling', attempts: 3, successes: 2, failures: 1, lastAt: T0 },
        // Legacy partial row (weight 0.5 once): 1.5/1.5 with 4 attempts →
        // one visible partial in the fractional part (approximation declared
        // in the eval methodology for higher partial counts).
        {
          agentId: 'agent-b', capability: 'heating', attempts: 4, successes: 1.5, failures: 1.5,
          lastAt: T0,
        } as never,
      ],
    });
    const a = tracker.getRecord('agent-a', 'cooling');
    expect(a?.successEvents).toBe(2);
    expect(a?.partialEvents).toBe(0);
    expect(a?.failureEvents).toBe(1);
    const b = tracker.getRecord('agent-b', 'heating');
    expect(b?.successEvents).toBe(1);
    expect(b?.partialEvents).toBe(1);
    expect(b?.failureEvents).toBe(2);
    expect(b!.successEvents + b!.partialEvents + b!.failureEvents).toBe(b!.attempts);
  });

  it('summarize returns pooled score and top capabilities by attempts', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < 5; i++) tracker.recordAttempt('agent-a', 'cooling', 1);
    tracker.recordAttempt('agent-a', 'heating', 0);
    const summary = tracker.summarize('agent-a');
    expect(summary.totalAttempts).toBe(6);
    expect(summary.topCapabilities[0].capability).toBe('cooling');
    expect(summary.topCapabilities[0].attempts).toBe(5);
    expect(summary.overallScore).toBeCloseTo(tracker.agentScore('agent-a'), 10);
  });
});
