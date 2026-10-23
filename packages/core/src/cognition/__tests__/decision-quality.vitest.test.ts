/**
 * L5 Meta-cognition — Decision Quality Tracker unit tests (§7.1).
 *
 * Pins: calibration math (perfect / overconfident / empty), bucket layout,
 * FIFO pending resolution, per-action aggregates, ring bound, unknown-outcome
 * honesty (never counted as correct or incorrect).
 */

import { describe, expect, it } from 'vitest';
import {
  DECISION_QUALITY_RING_CAP,
  DecisionQualityTracker,
  topUncalibratedActions,
} from '../decision-quality.js';

describe('DecisionQualityTracker', () => {
  it('starts neutral: no data → calibration 0.5, successRate 0.5, empty buckets', () => {
    const tracker = new DecisionQualityTracker();
    const metrics = tracker.getMetrics();
    expect(metrics.totalDecisions).toBe(0);
    expect(metrics.calibrationScore).toBe(0.5);
    expect(metrics.evaluatedDecisions).toBe(0);
    expect(metrics.avgConfidence).toBe(0.5);
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.confidenceBuckets).toEqual([]);
    expect(metrics.actionOutcomes).toEqual([]);
  });

  it('perfect calibration → score 1.0 and per-bucket predicted == actual', () => {
    const tracker = new DecisionQualityTracker();
    // 5 decisions at confidence 0.8, 4 succeed → actual 0.8 == predicted.
    for (let i = 0; i < 5; i++) {
      tracker.recordDecision({
        action: 'handle_independently',
        confidence: 0.8,
        outcome: i < 4 ? 'success' : 'failure',
      });
    }
    // 5 decisions at confidence 0.4, 2 succeed → actual 0.4 == predicted.
    for (let i = 0; i < 5; i++) {
      tracker.recordDecision({
        action: 'defer',
        confidence: 0.4,
        outcome: i < 2 ? 'success' : 'failure',
      });
    }
    const metrics = tracker.getMetrics();
    expect(metrics.calibrationScore).toBe(1);
    expect(metrics.correctDecisions).toBe(6);
    expect(metrics.incorrectDecisions).toBe(4);
    expect(metrics.confidenceBuckets).toHaveLength(2);
    const high = metrics.confidenceBuckets.find(b => b.range[0] === 0.8)!;
    expect(high.predicted).toBe(0.8);
    expect(high.actual).toBe(0.8);
    expect(high.count).toBe(5);
    const low = metrics.confidenceBuckets.find(b => b.range[0] === 0.4)!;
    expect(low.predicted).toBe(0.4);
    expect(low.actual).toBe(0.4);
  });

  it('overconfidence lowers the score (predicted 0.9, actual 0.4 → 1 − 0.5 = 0.5)', () => {
    const tracker = new DecisionQualityTracker();
    for (let i = 0; i < 10; i++) {
      tracker.recordDecision({
        action: 'handle_independently',
        confidence: 0.9,
        outcome: i < 4 ? 'success' : 'failure',
      });
    }
    const metrics = tracker.getMetrics();
    expect(metrics.successRate).toBe(0.4);
    expect(metrics.calibrationScore).toBe(0.5); // 1 − |0.9 − 0.4|
  });

  it('confidence 1.0 rides the last bucket [0.9, 1.0]', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'initiate_ac', confidence: 1, outcome: 'success' });
    const [bucket] = tracker.getMetrics().confidenceBuckets;
    expect(bucket.range).toEqual([0.9, 1]);
    expect(bucket.predicted).toBe(1);
  });

  it('pending decisions resolve FIFO per action word; unknown stays excluded', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8 }); // pending
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.6 }); // pending
    tracker.recordDecision({ action: 'defer', confidence: 0.7 }); // no outcome path

    let metrics = tracker.getMetrics();
    expect(metrics.totalDecisions).toBe(3);
    expect(metrics.evaluatedDecisions).toBe(0); // nothing counted yet — honest

    expect(tracker.resolveOutcome('initiate_ac', 'failure')).toBe(true);
    expect(tracker.resolveOutcome('initiate_ac', 'success')).toBe(true);
    expect(tracker.resolveOutcome('initiate_ac', 'failure')).toBe(false); // no pendings left

    metrics = tracker.getMetrics();
    expect(metrics.evaluatedDecisions).toBe(2); // defer stays excluded
    expect(metrics.correctDecisions).toBe(1);
    expect(metrics.incorrectDecisions).toBe(1);
    // FIFO: the first pending (0.8) failed, the second (0.6) succeeded.
    expect(metrics.confidenceBuckets.find(b => b.range[0] === 0.8)?.actual).toBe(0);
    expect(metrics.confidenceBuckets.find(b => b.range[0] === 0.6)?.actual).toBe(1);
  });

  it('partial outcomes count as correct (goals partially achieved)', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'partial' });
    const metrics = tracker.getMetrics();
    expect(metrics.correctDecisions).toBe(1);
    expect(metrics.incorrectDecisions).toBe(0);
    expect(metrics.successRate).toBe(1);
  });

  it('actionOutcomes aggregate per word with successRate and avgConfidence', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.9, outcome: 'success' });
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.7, outcome: 'failure' });
    tracker.recordDecision({ action: 'handle_independently', confidence: 0.6, outcome: 'success' });
    tracker.recordDecision({ action: 'defer', confidence: 0.5 }); // unknown — no aggregate

    const { actionOutcomes } = tracker.getMetrics();
    expect(actionOutcomes).toHaveLength(2);
    const ac = actionOutcomes.find(a => a.action === 'initiate_ac')!;
    expect(ac.count).toBe(2);
    expect(ac.successRate).toBe(0.5);
    expect(ac.avgConfidence).toBe(0.8);
    const indep = actionOutcomes.find(a => a.action === 'handle_independently')!;
    expect(indep.successRate).toBe(1);
  });

  it('clamps non-finite confidence to 0.5 and bounds the ring (drop-oldest)', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'x', confidence: Number.NaN });
    expect(tracker.getRecords()[0].confidence).toBe(0.5);

    const big = new DecisionQualityTracker();
    for (let i = 0; i < DECISION_QUALITY_RING_CAP + 50; i++) {
      big.recordDecision({ action: 'handle_independently', confidence: 0.5 + (i % 10) / 100, outcome: 'success' });
    }
    expect(big.getRecords()).toHaveLength(DECISION_QUALITY_RING_CAP);
    expect(big.getMetrics().totalDecisions).toBe(DECISION_QUALITY_RING_CAP);
    // Oldest dropped: first retained record is #50 (confidence 0.5 + 0).
    expect(big.getRecords()[0].confidence).toBeCloseTo(0.5, 10);
  });

  it('records round-trip through getRecords/restoreRecords for checkpointing', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, decisionSource: 'llm', atSimTimeSec: 42 });
    tracker.resolveOutcome('initiate_ac', 'success');

    const revived = new DecisionQualityTracker();
    revived.restoreRecords(JSON.parse(JSON.stringify(tracker.getRecords())));
    expect(revived.getMetrics()).toEqual(tracker.getMetrics());
  });

  it('clear() empties everything', () => {
    const tracker = new DecisionQualityTracker();
    tracker.recordDecision({ action: 'a', confidence: 0.9, outcome: 'success' });
    tracker.clear();
    expect(tracker.getMetrics().totalDecisions).toBe(0);
  });
});

describe('topUncalibratedActions (R40-B2 eval-report face)', () => {
  it('ranks action words by |avgConfidence − successRate| descending', () => {
    const tracker = new DecisionQualityTracker();
    // initiate_ac: 1 success of 5 → successRate 0.2, gap |0.8−0.2| = 0.6 (worst).
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'success' });
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'failure' });
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'failure' });
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'failure' });
    tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'failure' });
    // handle_independently: avgConfidence 0.6, successRate 0.5 → gap 0.1.
    tracker.recordDecision({ action: 'handle_independently', confidence: 0.6, outcome: 'success' });
    tracker.recordDecision({ action: 'handle_independently', confidence: 0.6, outcome: 'failure' });

    const ranked = topUncalibratedActions(tracker.getMetrics());
    expect(ranked.map(r => r.action)).toEqual(['initiate_ac', 'handle_independently']);
    expect(ranked[0].gap).toBe(0.6);
    expect(ranked[1].gap).toBe(0.1);
    // The ActionOutcome aggregates ride along (same numbers the metrics carry).
    expect(ranked[0]).toMatchObject({ count: 5, avgConfidence: 0.8, successRate: 0.2 });
  });

  it('caps the list, breaks ties on the action word, and is empty with no outcomes', () => {
    const tracker = new DecisionQualityTracker();
    for (const action of ['defer', 'ignore', 'initiate_ac', 'handle_independently']) {
      // Every word gets the same gap (1.0 vs 0.0) → tie order is lexical.
      tracker.recordDecision({ action, confidence: 1, outcome: 'failure' });
    }
    const capped = topUncalibratedActions(tracker.getMetrics(), 3);
    expect(capped).toHaveLength(3);
    expect(capped.map(r => r.action)).toEqual(['defer', 'handle_independently', 'ignore']);

    const empty = new DecisionQualityTracker();
    empty.recordDecision({ action: 'defer', confidence: 0.7 }); // still pending
    expect(topUncalibratedActions(empty.getMetrics())).toEqual([]);
  });
});
