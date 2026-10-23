/**
 * L5 Meta-cognition — Adaptive Behavior tests (§7.4).
 *
 * Pins every feedback-loop rule: widen-uncertainty on poor calibration,
 * overconfidence warning, underconfidence → reduce escalations, action
 * deprioritization, strategy gears, and the minimum-sample guard (fresh
 * agents get 'balanced' with zero adjustments).
 */

import { describe, expect, it } from 'vitest';
import { computeAdaptiveBehavior, renderAdaptiveHints } from '../adaptive-behavior.js';
import { DecisionQualityTracker } from '../decision-quality.js';

/** Build metrics by replaying (confidence, outcome) pairs through the tracker. */
function metricsFrom(pairs: Array<[number, 'success' | 'partial' | 'failure']>): ReturnType<DecisionQualityTracker['getMetrics']> {
  const tracker = new DecisionQualityTracker();
  for (const [confidence, outcome] of pairs) {
    tracker.recordDecision({ action: 'handle_independently', confidence, outcome });
  }
  return tracker.getMetrics();
}

describe('computeAdaptiveBehavior', () => {
  it('fresh agent (no evaluations): balanced, NO adjustments', () => {
    const policy = computeAdaptiveBehavior(metricsFrom([]));
    expect(policy.strategy).toBe('balanced');
    expect(policy.widenUncertainty).toBe(false);
    expect(policy.calibrationWarning).toBe(false);
    expect(policy.reduceEscalations).toBe(false);
    expect(policy.deprioritizedActions).toEqual([]);
    expect(policy.notes).toEqual([]);
  });

  it('below min sample: no rule fires even with extreme numbers', () => {
    // 4 evaluated (< default 5): 0.95 confidence, all failures.
    const policy = computeAdaptiveBehavior(metricsFrom([
      [0.95, 'failure'], [0.95, 'failure'], [0.95, 'failure'], [0.95, 'failure'],
    ]));
    expect(policy.calibrationWarning).toBe(false);
    expect(policy.widenUncertainty).toBe(false);
    expect(policy.strategy).toBe('balanced');
  });

  it('poor calibration (score < 0.6) → widenUncertainty + conservative gear', () => {
    // 6 decisions at 0.9 confidence, 2 success → actual 0.33, ECE 0.57 → score 0.43.
    const metrics = metricsFrom([
      [0.9, 'success'], [0.9, 'success'],
      [0.9, 'failure'], [0.9, 'failure'], [0.9, 'failure'], [0.9, 'failure'],
    ]);
    expect(metrics.calibrationScore).toBeLessThan(0.6);
    const policy = computeAdaptiveBehavior(metrics);
    expect(policy.widenUncertainty).toBe(true);
    expect(policy.strategy).toBe('conservative');
    expect(policy.notes[0]).toContain('widen your uncertainty reporting');
  });

  it('overconfident (avgConfidence > 0.9, success < 0.7) → calibrationWarning', () => {
    const metrics = metricsFrom([
      [0.95, 'success'], [0.95, 'success'],
      [0.95, 'failure'], [0.95, 'failure'], [0.95, 'failure'], [0.95, 'failure'],
    ]);
    const policy = computeAdaptiveBehavior(metrics);
    expect(policy.calibrationWarning).toBe(true);
    expect(policy.notes.join(' ')).toContain('overconfident');
  });

  it('underconfident (avgConfidence < 0.5, success > 0.8) → reduceEscalations', () => {
    // 6 decisions at 0.4 confidence, 6 successes → success 1.0, avgConfidence 0.4.
    const metrics = metricsFrom([
      [0.4, 'success'], [0.4, 'success'], [0.4, 'success'],
      [0.4, 'success'], [0.4, 'success'], [0.4, 'success'],
    ]);
    const policy = computeAdaptiveBehavior(metrics);
    expect(policy.reduceEscalations).toBe(true);
    expect(policy.notes.join(' ')).toContain('underconfident');
    // Badly calibrated in EITHER direction → conservative gear (the agent does
    // not know itself); the targeted reduceEscalations correction coexists.
    expect(metrics.calibrationScore).toBeLessThan(0.6);
    expect(policy.strategy).toBe('conservative');
  });

  it('consistently failing action (≥3 samples, successRate < 0.4) → deprioritized', () => {
    const tracker = new DecisionQualityTracker();
    // initiate_ac fails 4/4; handle_independently succeeds 4/4.
    for (let i = 0; i < 4; i++) {
      tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'failure' });
      tracker.recordDecision({ action: 'handle_independently', confidence: 0.7, outcome: 'success' });
    }
    const policy = computeAdaptiveBehavior(tracker.getMetrics());
    expect(policy.deprioritizedActions).toEqual(['initiate_ac']);
    expect(policy.strategy).toBe('conservative');
  });

  it('action with <3 samples is never deprioritized (thin evidence)', () => {
    const tracker = new DecisionQualityTracker();
    for (let i = 0; i < 2; i++) {
      tracker.recordDecision({ action: 'initiate_ac', confidence: 0.8, outcome: 'failure' });
    }
    tracker.recordDecision({ action: 'handle_independently', confidence: 0.7, outcome: 'success' });
    const policy = computeAdaptiveBehavior(tracker.getMetrics());
    expect(policy.deprioritizedActions).toEqual([]);
  });

  it('well-calibrated + succeeding agent earns the exploratory gear', () => {
    // confidence 0.8 × 5 with 4 success (calibrated); plus calibrated 0.4×5 with 2.
    const tracker = new DecisionQualityTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordDecision({ action: 'handle_independently', confidence: 0.8, outcome: i < 4 ? 'success' : 'failure' });
    }
    for (let i = 0; i < 5; i++) {
      tracker.recordDecision({ action: 'handle_independently', confidence: 0.4, outcome: i < 2 ? 'success' : 'failure' });
    }
    const metrics = tracker.getMetrics();
    expect(metrics.calibrationScore).toBe(1);
    expect(metrics.successRate).toBe(0.6);
    // successRate 0.6 < 0.8 → balanced, not exploratory.
    expect(computeAdaptiveBehavior(metrics).strategy).toBe('balanced');

    // High-but-imperfect calibration with high success → exploratory gear.
    const good = metricsFrom([
      [0.8, 'success'], [0.8, 'success'], [0.8, 'success'], [0.8, 'success'],
      [0.8, 'success'], [0.9, 'success'],
    ]);
    const goodPolicy = computeAdaptiveBehavior(good);
    expect(goodPolicy.strategy).toBe('exploratory');
    expect(goodPolicy.widenUncertainty).toBe(false);
  });

  it('renderAdaptiveHints lists each firing rule deterministically', () => {
    const tracker = new DecisionQualityTracker();
    for (let i = 0; i < 4; i++) {
      tracker.recordDecision({ action: 'initiate_ac', confidence: 0.95, outcome: 'failure' });
      tracker.recordDecision({ action: 'handle_independently', confidence: 0.95, outcome: 'failure' });
    }
    const policy = computeAdaptiveBehavior(tracker.getMetrics());
    const lines = renderAdaptiveHints(policy);
    expect(lines.some(l => l.startsWith('ADAPTIVE: widen uncertainty reporting'))).toBe(true);
    expect(lines.some(l => l.includes('calibration warning'))).toBe(true);
    expect(lines.some(l => l.includes('de-prioritize consistently failing actions [initiate_ac,handle_independently]'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('strategy gear=conservative');
    expect(renderAdaptiveHints(policy)).toEqual(lines); // deterministic
  });

  it('renderAdaptiveHints is empty for a no-adjustment policy', () => {
    expect(renderAdaptiveHints(computeAdaptiveBehavior(metricsFrom([])))).toEqual([]);
  });
});
