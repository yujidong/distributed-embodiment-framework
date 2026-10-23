/**
 * L5 Meta-cognition — Adaptive Behavior (§7.4).
 *
 * THE FEEDBACK LOOP: decisions → outcomes → quality tracking → behavior
 * adjustment → better decisions. This module is the pure rule set that maps
 * a DecisionQualityMetrics snapshot onto behavior ADJUSTMENTS:
 *
 *   - calibrationScore < 0.6            → widenUncertainty (report more
 *                                          doubt; prompt confidence hint
 *                                          scaled by confidenceAdjustment);
 *   - consistently failing actions      → deprioritizedActions (lower their
 *                                          priority in the action plan);
 *   - consistently succeeding partners  → trust raise (lives in
 *                                          trust-calibration, fed by the
 *                                          same outcome stream);
 *   - avgConfidence > 0.9, success < 0.7→ calibrationWarning (overconfident);
 *   - avgConfidence < 0.5, success > 0.8→ reduceEscalations (underconfident —
 *                                          stop escalating what you get right).
 *
 * Strategy gears (§7.4 {conservative, balanced, exploratory}) adjust WEIGHTS
 * AND THRESHOLDS ONLY — the constraint chain (safety, budgets, scopes,
 * autonomy modes) is NEVER relaxed by L5 (mechanism-C envelope discipline).
 *
 * All rules are gated on a minimum evaluated sample: a fresh agent is
 * 'balanced' with no adjustments — no behavior change from thin evidence.
 */

import type { DecisionQualityMetrics } from './decision-quality.js';

// ============================================================================
// Policy
// ============================================================================

/** The strategy gear set (§7.4) — weights/thresholds only, constraints fixed. */
export type BehaviorStrategy = 'conservative' | 'balanced' | 'exploratory';

/** The behavior adjustments derived from tracked decision quality. */
export interface AdaptiveBehaviorPolicy {
  strategy: BehaviorStrategy;
  /** Poor calibration → report MORE uncertainty (widen confidence intervals). */
  widenUncertainty: boolean;
  /** Overconfidence detected → warn in the prompt context. */
  calibrationWarning: boolean;
  /** Underconfidence detected → reduce unnecessary escalations. */
  reduceEscalations: boolean;
  /** Actions with consistently poor outcomes → lower priority in plans. */
  deprioritizedActions: string[];
  /** Human-readable rule firings (audit trail, bounded). */
  notes: string[];
}

export interface AdaptiveBehaviorOptions {
  /** Minimum evaluated decisions before any adjustment fires (default 5). */
  minSample?: number;
  /** calibrationScore below this → widenUncertainty (default 0.6). */
  widenThreshold?: number;
  /** Action successRate below this (with ≥3 samples) → deprioritize (default 0.4). */
  deprioritizeSuccessRate?: number;
  /** Samples an action needs before deprioritization (default 3). */
  deprioritizeMinCount?: number;
}

const DEFAULTS = {
  minSample: 5,
  widenThreshold: 0.6,
  deprioritizeSuccessRate: 0.4,
  deprioritizeMinCount: 3,
};

/**
 * Derive the adaptive behavior policy from quality metrics (pure).
 * Deterministic; no rule fires below the minimum sample.
 */
export function computeAdaptiveBehavior(
  metrics: DecisionQualityMetrics,
  options: AdaptiveBehaviorOptions = {},
): AdaptiveBehaviorPolicy {
  const minSample = options.minSample ?? DEFAULTS.minSample;
  const widenThreshold = options.widenThreshold ?? DEFAULTS.widenThreshold;
  const deprioritizeRate = options.deprioritizeSuccessRate ?? DEFAULTS.deprioritizeSuccessRate;
  const deprioritizeMinCount = options.deprioritizeMinCount ?? DEFAULTS.deprioritizeMinCount;

  const notes: string[] = [];
  const enoughData = metrics.evaluatedDecisions >= minSample;

  const widenUncertainty = enoughData && metrics.calibrationScore < widenThreshold;
  if (widenUncertainty) {
    notes.push(
      `calibration ${metrics.calibrationScore} < ${widenThreshold}: widen your uncertainty reporting ` +
      '(your confidence has not matched your outcomes)',
    );
  }

  const calibrationWarning = enoughData && metrics.avgConfidence > 0.9 && metrics.successRate < 0.7;
  if (calibrationWarning) {
    notes.push(
      `overconfident: you report ${metrics.avgConfidence} average confidence but only ` +
      `${metrics.successRate} of evaluated decisions succeeded`,
    );
  }

  const reduceEscalations = enoughData && metrics.avgConfidence < 0.5 && metrics.successRate > 0.8;
  if (reduceEscalations) {
    notes.push(
      `underconfident: you report ${metrics.avgConfidence} average confidence yet ` +
      `${metrics.successRate} of evaluated decisions succeeded — handle more independently, ` +
      'escalate less',
    );
  }

  const deprioritizedActions = metrics.actionOutcomes
    .filter(outcome => outcome.count >= deprioritizeMinCount && outcome.successRate < deprioritizeRate)
    .map(outcome => outcome.action);
  if (deprioritizedActions.length > 0) {
    notes.push(
      `consistently failing actions — lower their priority: ${deprioritizedActions.join(', ')}`,
    );
  }

  return {
    strategy: deriveStrategy(metrics, enoughData, deprioritizedActions.length > 0),
    widenUncertainty,
    calibrationWarning,
    reduceEscalations,
    deprioritizedActions,
    notes,
  };
}

/** Strategy gear (§7.4): recent quality picks the gear; constraints never move. */
function deriveStrategy(
  metrics: DecisionQualityMetrics,
  enoughData: boolean,
  hasDeprioritized: boolean,
): BehaviorStrategy {
  if (!enoughData) return 'balanced';
  if (metrics.calibrationScore < 0.6 || metrics.successRate < 0.5 || hasDeprioritized) {
    return 'conservative';
  }
  if (metrics.calibrationScore >= 0.8 && metrics.successRate >= 0.8) {
    return 'exploratory';
  }
  return 'balanced';
}

/** Render the policy's advice lines for the prompt context (bounded, deterministic). */
export function renderAdaptiveHints(policy: AdaptiveBehaviorPolicy): string[] {
  const lines: string[] = [];
  if (policy.widenUncertainty) lines.push('ADAPTIVE: widen uncertainty reporting — your confidence has not matched outcomes');
  if (policy.calibrationWarning) lines.push('ADAPTIVE: calibration warning — you are overconfident; discount your own certainty');
  if (policy.reduceEscalations) lines.push('ADAPTIVE: reduce unnecessary escalations — your independent judgment is succeeding');
  if (policy.deprioritizedActions.length > 0) {
    lines.push(`ADAPTIVE: de-prioritize consistently failing actions [${policy.deprioritizedActions.join(',')}]`);
  }
  if (lines.length > 0) lines.push(`ADAPTIVE: strategy gear=${policy.strategy} (weights/thresholds only — constraints unchanged)`);
  return lines;
}
