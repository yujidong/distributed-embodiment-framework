/**
 * L5 Meta-cognition — Decision Quality Tracker (§7.1 self-assessment).
 *
 * The decision-outcome reconciliation loop the design calls the calibration
 * curve: every cognitive decision carries a SELF-REPORTED confidence
 * (LLMAssessment.confidence / CognitiveDecision.uncertainty.overall), and
 * later a real OUTCOME arrives (AC completion, actuation success, nothing).
 * Reconciling the two answers "am I right when I think I am?" —
 *
 *   - `confidenceBuckets` is the classic reliability diagram: per 0.1-wide
 *     confidence range, the average predicted confidence vs the fraction
 *     that actually succeeded;
 *   - `calibrationScore` = 1 − weighted Expected Calibration Error
 *     (1.0 = perfectly calibrated, drops toward 0 as |predicted − actual|
 *     grows; the 0.5 "random" anchor in the task spec corresponds to a
 *     systematically mis-predicting agent, e.g. reporting ~0.9 while
 *     succeeding ~40% of the time);
 *   - `actionOutcomes` breaks effectiveness down per action word
 *     ('initiate_ac', 'handle_independently', …).
 *
 * Outcome semantics (documented, deterministic):
 *   success/failure/partial map to correct=success|partial / incorrect=failure;
 *   'unknown' (defer/ignore, policy-blocked actuation, never-resolved
 *   pendings) counts toward totalDecisions but is EXCLUDED from calibration
 *   — never silently scored as either side (honest accounting, T-302).
 *
 * Bounded: the tracker keeps a cap on retained decision records (drop-oldest
 * ring); metrics derive from that window only (T-011: caps designed at write
 * time). Pure data + pure derivation — no IO, no clocks.
 */

// ============================================================================
// Types
// ============================================================================

/** Honest outcome tag for one decision (aligns with the AC outcome vocabulary). */
export type DecisionOutcome = 'success' | 'partial' | 'failure' | 'unknown';

/** One reconciled (decision, confidence, outcome) triple (§7.1's episodic feed). */
export interface DecisionQualityRecord {
  /** Decision word: 'initiate_ac' | 'handle_independently' | 'defer' | 'ignore' | … */
  action: string;
  /** Self-reported confidence at decision time, 0..1. */
  confidence: number;
  /** 'unknown' while the outcome is still pending. */
  outcome: DecisionOutcome;
  /** Where the decision came from ('llm' | 'precheck' | 'rule' | …), audit only. */
  decisionSource?: string;
  atSimTimeSec?: number;
}

/** One bucket of the reliability diagram (0.1-wide confidence ranges). */
export interface ConfidenceBucket {
  /** Inclusive low / high bounds, e.g. [0.7, 0.8). */
  range: [number, number];
  /** Average self-reported confidence inside the range. */
  predicted: number;
  /** Fraction of the range's evaluated decisions that were correct. */
  actual: number;
  count: number;
}

/** Per-action effectiveness (the "actionOutcomes" contract face). */
export interface ActionOutcome {
  action: string;
  /** correct / evaluated (evaluated = success|partial|failure only). */
  successRate: number;
  avgConfidence: number;
  count: number;
}

/** The metrics snapshot (contract face; extras power adaptive behavior §7.4). */
export interface DecisionQualityMetrics {
  totalDecisions: number;
  /** 1 − weighted ECE over populated buckets; 0.5 when nothing is evaluated yet. */
  calibrationScore: number;
  confidenceBuckets: ConfidenceBucket[];
  correctDecisions: number;
  incorrectDecisions: number;
  actionOutcomes: ActionOutcome[];
  // --- extensions the adaptive-behavior rules read (documented) ------------
  /** Decisions with a known outcome (correct + incorrect). */
  evaluatedDecisions: number;
  /** Mean self-reported confidence over evaluated decisions (0.5 when empty). */
  avgConfidence: number;
  /** correct / evaluated (0.5 when empty). */
  successRate: number;
}

/** An action's per-action effectiveness + its calibration gap (R40-B2). */
export interface UncalibratedAction extends ActionOutcome {
  /** |avgConfidence − successRate| — how far self-report drifts from reality. */
  gap: number;
}

/**
 * R40-B2 (元认知暴露面): rank the evaluated action words by calibration gap
 * (|avgConfidence − successRate|, descending) — the "top uncalibrated
 * actions" the eval report exposes per agent. Pure derivation of
 * `getMetrics()`'s actionOutcomes; ties break on the action word for
 * deterministic output. Cap bounds the exposure (default 3).
 */
export function topUncalibratedActions(
  metrics: DecisionQualityMetrics,
  cap = 3,
): UncalibratedAction[] {
  return metrics.actionOutcomes
    .map(action => ({
      ...action,
      gap: round3(Math.abs(action.avgConfidence - action.successRate)),
    }))
    .sort((a, b) => b.gap - a.gap || a.action.localeCompare(b.action))
    .slice(0, Math.max(0, cap));
}

/** Retention bound for reconciled records (drop-oldest). */
export const DECISION_QUALITY_RING_CAP = 256;

/** Number of 0.1-wide confidence buckets ([0,0.1) … [0.9,1.0]). */
const BUCKET_COUNT = 10;

// ============================================================================
// Tracker
// ============================================================================

/**
 * Per-agent rolling decision-quality state. Decisions enter via
 * `recordDecision` (outcome 'unknown' = pending for actions whose outcome
 * arrives later, e.g. initiate_ac → COLLABORATION_COMPLETED) and are resolved
 * FIFO per action word by `resolveOutcome`. Metrics are pure derivations of
 * the bounded ring — the tracker never mutates numbers directly.
 */
export class DecisionQualityTracker {
  private records: DecisionQualityRecord[] = [];

  /** Record a decision (outcome defaults to pending/'unknown'). */
  recordDecision(record: Omit<DecisionQualityRecord, 'outcome'> & { outcome?: DecisionOutcome }): void {
    const confidence = Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : 0.5;
    this.records.push({
      ...record,
      confidence,
      outcome: record.outcome ?? 'unknown',
    });
    if (this.records.length > DECISION_QUALITY_RING_CAP) {
      this.records.splice(0, this.records.length - DECISION_QUALITY_RING_CAP);
    }
  }

  /**
   * Resolve the OLDEST pending ('unknown' outcome) record of `action` to a
   * real outcome (FIFO — collaborations complete in initiation order well
   * enough for v1; mis-ordered completions resolve against the next-oldest
   * pending of the same word). Returns true when a pending record resolved.
   */
  resolveOutcome(action: string, outcome: Exclude<DecisionOutcome, 'unknown'>): boolean {
    const pending = this.records.find(r => r.action === action && r.outcome === 'unknown');
    if (pending === undefined) return false;
    pending.outcome = outcome;
    return true;
  }

  /** The bounded record ring (oldest→newest copy — checkpoint/export seam). */
  getRecords(): DecisionQualityRecord[] {
    return this.records.map(r => ({ ...r }));
  }

  /** Replace the ring (checkpoint restore). */
  restoreRecords(records: readonly DecisionQualityRecord[]): void {
    this.records = records.slice(-DECISION_QUALITY_RING_CAP).map(r => ({
      action: String(r.action),
      confidence: Math.min(1, Math.max(0, Number.isFinite(r.confidence) ? r.confidence : 0.5)),
      outcome: r.outcome,
      ...(r.decisionSource !== undefined ? { decisionSource: r.decisionSource } : {}),
      ...(r.atSimTimeSec !== undefined ? { atSimTimeSec: r.atSimTimeSec } : {}),
    }));
  }

  /** Derive the metrics snapshot (pure function of the ring). */
  getMetrics(): DecisionQualityMetrics {
    const evaluated = this.records.filter(r => r.outcome !== 'unknown');
    const correct = evaluated.filter(r => r.outcome === 'success' || r.outcome === 'partial');
    const incorrect = evaluated.filter(r => r.outcome === 'failure');

    const buckets: ConfidenceBucket[] = [];
    const byIndex = new Map<number, DecisionQualityRecord[]>();
    for (const record of evaluated) {
      // c ∈ [0,1] → bucket ⌊c·10⌋ (confidence 1.0 rides the last bucket).
      const index = Math.min(BUCKET_COUNT - 1, Math.floor(record.confidence * BUCKET_COUNT));
      const list = byIndex.get(index);
      if (list === undefined) byIndex.set(index, [record]);
      else list.push(record);
    }
    for (const [index, inBucket] of byIndex) {
      const bucketCorrect = inBucket.filter(r => r.outcome === 'success' || r.outcome === 'partial').length;
      buckets.push({
        range: [index / BUCKET_COUNT, (index + 1) / BUCKET_COUNT],
        predicted: round3(inBucket.reduce((sum, r) => sum + r.confidence, 0) / inBucket.length),
        actual: round3(bucketCorrect / inBucket.length),
        count: inBucket.length,
      });
    }

    // Weighted Expected Calibration Error → complement (the calibration score).
    const ece = evaluated.length > 0
      ? buckets.reduce((sum, b) => sum + (b.count / evaluated.length) * Math.abs(b.predicted - b.actual), 0)
      : 0;
    const calibrationScore = evaluated.length > 0 ? round3(Math.max(0, Math.min(1, 1 - ece))) : 0.5;

    // Per-action aggregates over evaluated records, deterministic word order.
    const actions = [...new Set(evaluated.map(r => r.action))];
    const actionOutcomes: ActionOutcome[] = actions.map(action => {
      const ofAction = evaluated.filter(r => r.action === action);
      const ok = ofAction.filter(r => r.outcome === 'success' || r.outcome === 'partial').length;
      return {
        action,
        successRate: round3(ok / ofAction.length),
        avgConfidence: round3(ofAction.reduce((sum, r) => sum + r.confidence, 0) / ofAction.length),
        count: ofAction.length,
      };
    });

    return {
      totalDecisions: this.records.length,
      calibrationScore,
      confidenceBuckets: buckets,
      correctDecisions: correct.length,
      incorrectDecisions: incorrect.length,
      actionOutcomes,
      evaluatedDecisions: evaluated.length,
      avgConfidence: evaluated.length > 0
        ? round3(evaluated.reduce((sum, r) => sum + r.confidence, 0) / evaluated.length)
        : 0.5,
      successRate: evaluated.length > 0 ? round3(correct.length / evaluated.length) : 0.5,
    };
  }

  /** Drop everything (agent destroy parity). */
  clear(): void {
    this.records = [];
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
