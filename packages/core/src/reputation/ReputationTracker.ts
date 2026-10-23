/**
 * ReputationTracker — service/agent reputation learned from collaboration
 * history (P4-1, vision doc: 工具评价与淘汰 — learn from AC outcome history).
 *
 * One cell per (agentId, capability): { attempts, successes, failures,
 * lastAt }. Capabilities are keyed by SEMANTIC TYPE (the capability string
 * requested by an AC and offered by a service), which works across both
 * service granularities (engine runtime: one service per device; platform:
 * one service per device × capability).
 *
 * Score math (Bayesian with a prior, plus recency decay on read):
 *
 *   raw score   = (successes + α·prior) / (attempts + α)
 *   decay(age)  = 2^(-age / halfLife)          applied to the evidence
 *   read score  = (successes·decay + α·prior) / (attempts·decay + α)
 *
 * - prior = 0.7: an unknown agent is presumed decent-but-unproven (optimistic
 *   enough that newcomers still get selected, below a proven 100% record).
 * - α = 5 pseudo-attempts: after ~5 real attempts the data dominates the
 *   prior; a single success lifts the score only slightly (0.7 → 0.75).
 * - half-life = 1 day of SIM time: as evidence ages it fades back to the
 *   prior, so a long-idle agent is treated as unknown again rather than
 *   keeping a stale perfect/terrible record forever.
 *
 * Outcome weights: success = 1, partial = 0.5, failure = 0 (counted into
 * `successes` as the weight and into `failures` as 1 − weight; attempts
 * always += 1).
 *
 * Update paths (wired by EngineRuntime):
 * 1. COLLABORATION_COMPLETED events → every participating agent × every
 *    capability the AC requested, weighted by the classified outcome.
 * 2. Device-operation failures attributable to an agent (DEVICE_ERROR from
 *    the fault seam, DEVICE_OPERATION_EXECUTED with success=false) → the
 *    owning agent × the failing device's capability names, weight 0.
 *    Attribution choice: device ownership (the agent bound to the failing
 *    device) — the only agent who could have delivered through it.
 *
 * The tracker is storage-free: `toJSON()/fromJSON()` is the persistence seam
 * (the server persists per environment; the engine never touches disk).
 */

// ============================================================================
// Types
// ============================================================================

/** Classified collaboration outcome. */
export type ReputationOutcome = 'success' | 'partial' | 'failure';

/** Weight of an outcome in the record: success 1, partial 0.5, failure 0. */
export const OUTCOME_WEIGHTS: Record<ReputationOutcome, number> = {
  success: 1,
  partial: 0.5,
  failure: 0,
};

/** One (agentId, capability) reputation cell. Counts are fractional (partial outcomes). */
export interface ReputationRecord {
  agentId: string;
  capability: string;
  /** Integer EVENT count — every attempt, however weighted. */
  attempts: number;
  /** Sum of outcome weights (success=1, partial=0.5, failure=0) — the SCORING quantity. */
  successes: number;
  /** Sum of (1 − weight). successes + failures === attempts. */
  failures: number;
  /**
   * T71 (R8, u1-F3): integer EVENT buckets — weights may be fractional
   * (partial = 0.5) but a COUNT of collaborations never is. The report and
   * account faces consume these; the score formula keeps consuming the
   * weight sums above.
   */
  successEvents: number;
  partialEvents: number;
  failureEvents: number;
  /** Timestamp (ms, caller's clock — sim time in the runtime) of the last update. */
  lastAt: number;
}

/**
 * T71: integer-ize a legacy weight-sum cell into event buckets.
 *
 * Weight sums cannot losslessly recover event counts (a +1.0 success and a
 * +0.5/+0.5 partial pair produce the same sums), so:
 * - integer weight sums (the common case: every recorded event was a clean
 *   success/failure) are EXACT — successEvents = successes, failureEvents =
 *   failures;
 * - half-integer sums carry exactly one visible partial in their fractional
 *   part; higher partial counts in legacy rows are approximated (declared as
 *   such in the eval methodology — legacy rows are integerized, never shown
 *   as fractional counts).
 */
export function integerizeReputationEvents(row: {
  attempts: number;
  successes: number;
  failures: number;
}): { successEvents: number; partialEvents: number; failureEvents: number } {
  const attempts = Math.max(0, Math.round(row.attempts));
  const fracSuccesses = row.successes - Math.floor(row.successes);
  const partialEvents = Math.max(0, Math.min(1, Math.round(Math.max(0, fracSuccesses) * 2)));
  const successEvents = Math.max(0, Math.round(row.successes - 0.5 * partialEvents));
  const failureEvents = Math.max(0, attempts - successEvents - partialEvents);
  return { successEvents, partialEvents, failureEvents };
}

/** A record with its current (decayed) score attached. */
export interface ScoredReputation extends ReputationRecord {
  score: number;
}

/** Tunables for the score formula. */
export interface ReputationConfig {
  /** Prior success probability for an unknown (agentId, capability). Default 0.7. */
  prior: number;
  /** Prior strength in pseudo-attempts. Default 5. */
  alpha: number;
  /** Evidence half-life in milliseconds (sim time in the runtime). Default 1 day. */
  halfLifeMs: number;
}

export const DEFAULT_REPUTATION_CONFIG: ReputationConfig = {
  prior: 0.7,
  alpha: 5,
  halfLifeMs: 24 * 60 * 60 * 1000,
};

/** JSON persistence shape (version for future migrations). */
export interface ReputationTrackerJSON {
  version: 2;
  records: ReputationRecord[];
}

/**
 * T71: load-tolerant record — v1 rows (and DB rows predating the event
 * buckets) carry no event counts; `fromJSON` integerizes their weight sums.
 */
export type ReputationRecordLoad = Omit<
  ReputationRecord,
  'successEvents' | 'partialEvents' | 'failureEvents'
> & Partial<Pick<ReputationRecord, 'successEvents' | 'partialEvents' | 'failureEvents'>>;

export interface ReputationTrackerLoadJSON {
  version: number;
  records: ReputationRecordLoad[];
}

// ============================================================================
// Pure helpers (exported for the server's read-side scoring)
// ============================================================================

/**
 * Score a record at a given time: recency-decayed Bayesian success rate.
 * `attempts`/`successes` may be fractional. Returns the prior when the
 * (decayed) evidence is empty.
 */
export function computeReputationScore(
  record: { attempts: number; successes: number; lastAt: number },
  nowMs: number,
  config: ReputationConfig = DEFAULT_REPUTATION_CONFIG,
): number {
  const age = Math.max(0, nowMs - record.lastAt);
  const decay = Math.pow(0.5, age / config.halfLifeMs);
  const effectiveAttempts = record.attempts * decay;
  const effectiveSuccesses = record.successes * decay;
  return (effectiveSuccesses + config.alpha * config.prior) /
    (effectiveAttempts + config.alpha);
}

/**
 * Classify a COLLABORATION_COMPLETED payload into success|partial|failure.
 * Mirrors DualTriggerACManager.recordCollaborationOutcome's classification
 * (kept duplicated deliberately: the AC manager's logic is private and
 * covered by its own tests; both implement the same documented rule):
 * all goals achieved → success; some achieved → partial; none →
 * success-flag decides.
 */
export function classifyCollaborationOutcome(payload: {
  success?: boolean;
  results?: { goals?: Array<{ achieved?: boolean }> };
  goals?: Array<{ achieved?: boolean }> | number;
}): ReputationOutcome {
  const success = payload.success !== false;
  const goals = payload.results?.goals ?? payload.goals ?? [];
  const goalsTotal = Array.isArray(goals) ? goals.length : (typeof goals === 'number' ? goals : 1);
  const goalsAchieved = Array.isArray(goals)
    ? goals.filter(g => g.achieved === true).length
    : (success ? goalsTotal : 0);

  if (success && goalsAchieved === goalsTotal && goalsTotal > 0) return 'success';
  if (goalsAchieved > 0) return 'partial';
  return success ? 'success' : 'failure';
}

// ============================================================================
// ReputationTracker
// ============================================================================

export class ReputationTracker {
  private readonly config: ReputationConfig;
  private readonly now: () => number;
  private readonly cells = new Map<string, ReputationRecord>();

  /**
   * @param config - score formula overrides (defaults documented above)
   * @param now - clock in ms; EngineRuntime passes SIM time, others Date.now
   */
  constructor(config: Partial<ReputationConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_REPUTATION_CONFIG, ...config };
    this.now = now;
  }

  getConfig(): ReputationConfig {
    return { ...this.config };
  }

  /**
   * Record one attempt for (agentId, capability) with an outcome weight in
   * [0, 1] (1 = full success, 0.5 = partial, 0 = failure).
   */
  recordAttempt(agentId: string, capability: string, weight: number, at?: number): void {
    if (!agentId || !capability) return;
    const w = Math.min(1, Math.max(0, weight));
    const key = ReputationTracker.key(agentId, capability);
    const cell = this.cells.get(key) ?? {
      agentId,
      capability,
      attempts: 0,
      successes: 0,
      failures: 0,
      successEvents: 0,
      partialEvents: 0,
      failureEvents: 0,
      lastAt: 0,
    };
    // T71: the EVENT bucket is the integer classification of the same
    // outcome whose WEIGHT rides successes/failures — counts stay counts.
    if (w > 0.99) cell.successEvents += 1;
    else if (w < 0.01) cell.failureEvents += 1;
    else cell.partialEvents += 1;
    cell.attempts += 1;
    cell.successes += w;
    cell.failures += 1 - w;
    cell.lastAt = at ?? this.now();
    this.cells.set(key, cell);
  }

  /**
   * Record a collaboration outcome for every participating agent × every
   * requested capability (success=1, partial=0.5, failure=0).
   */
  recordCollaborationOutcome(input: {
    participants: string[];
    capabilities: string[];
    outcome: ReputationOutcome;
    at?: number;
  }): void {
    const weight = OUTCOME_WEIGHTS[input.outcome];
    for (const agentId of input.participants) {
      for (const capability of input.capabilities) {
        this.recordAttempt(agentId, capability, weight, input.at);
      }
    }
  }

  /**
   * Current score for (agentId, capability) with recency decay applied.
   * Falls back to the prior when there is no history.
   */
  score(agentId: string, capability: string): number {
    const cell = this.cells.get(ReputationTracker.key(agentId, capability));
    if (!cell) return this.config.prior;
    return computeReputationScore(cell, this.now(), this.config);
  }

  /**
   * Aggregate score over every recorded capability of an agent (evidence
   * pooled across cells, decayed per cell). Prior when no history at all.
   */
  agentScore(agentId: string): number {
    let attempts = 0;
    let successes = 0;
    const nowMs = this.now();
    for (const cell of this.cells.values()) {
      if (cell.agentId !== agentId) continue;
      const age = Math.max(0, nowMs - cell.lastAt);
      const decay = Math.pow(0.5, age / this.config.halfLifeMs);
      attempts += cell.attempts * decay;
      successes += cell.successes * decay;
    }
    if (attempts === 0) return this.config.prior;
    return (successes + this.config.alpha * this.config.prior) /
      (attempts + this.config.alpha);
  }

  /** Copy of the raw record for (agentId, capability), or undefined. */
  getRecord(agentId: string, capability: string): ReputationRecord | undefined {
    const cell = this.cells.get(ReputationTracker.key(agentId, capability));
    return cell ? { ...cell } : undefined;
  }

  /**
   * Full per-capability breakdown for an agent, each entry scored,
   * sorted by attempts (most-exercised capability first).
   */
  getAgentReputation(agentId: string): ScoredReputation[] {
    const out: ScoredReputation[] = [];
    for (const cell of this.cells.values()) {
      if (cell.agentId !== agentId) continue;
      out.push({ ...cell, score: this.score(cell.agentId, cell.capability) });
    }
    return out.sort((a, b) => b.attempts - a.attempts);
  }

  /**
   * Compact per-agent summary for snapshots: overall (pooled) score plus
   * the top-N most-attempted capabilities with their scores.
   */
  summarize(agentId: string, topN = 3): {
    overallScore: number;
    totalAttempts: number;
    topCapabilities: Array<{ capability: string; score: number; attempts: number }>;
  } {
    const breakdown = this.getAgentReputation(agentId);
    return {
      overallScore: this.agentScore(agentId),
      totalAttempts: breakdown.reduce((sum, cell) => sum + cell.attempts, 0),
      topCapabilities: breakdown.slice(0, topN).map(cell => ({
        capability: cell.capability,
        score: cell.score,
        attempts: cell.attempts,
      })),
    };
  }

  /**
   * Upsert a record directly (persistence load path, test seeding).
   * Counts are clamped to be consistent (successes + failures = attempts).
   * Event buckets ride when given; absent buckets are integerized from the
   * weight sums (legacy rows — exact for integer sums, approximated else).
   */
  setRecord(
    agentId: string,
    capability: string,
    data: {
      attempts: number;
      successes: number;
      failures?: number;
      successEvents?: number;
      partialEvents?: number;
      failureEvents?: number;
      lastAt?: number;
    },
  ): void {
    if (!agentId || !capability) return;
    const attempts = Math.max(0, data.attempts);
    const successes = Math.min(Math.max(0, data.successes), attempts);
    const failures = data.failures !== undefined
      ? Math.min(Math.max(0, data.failures), attempts)
      : attempts - successes;
    const events = integerizeReputationEvents({ attempts, successes, failures });
    const pickEvent = (value: number | undefined, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
    this.cells.set(ReputationTracker.key(agentId, capability), {
      agentId,
      capability,
      attempts,
      successes,
      failures,
      successEvents: pickEvent(data.successEvents, events.successEvents),
      partialEvents: pickEvent(data.partialEvents, events.partialEvents),
      failureEvents: pickEvent(data.failureEvents, events.failureEvents),
      lastAt: data.lastAt ?? this.now(),
    });
  }

  /** Every raw record (persistence save path). */
  listRecords(): ReputationRecord[] {
    return [...this.cells.values()].map(cell => ({ ...cell }));
  }

  /** Number of (agentId, capability) cells. */
  get size(): number {
    return this.cells.size;
  }

  /** Serialize for persistence (storage-free engine; the server persists). */
  toJSON(): ReputationTrackerJSON {
    return { version: 2, records: this.listRecords() };
  }

  /** Replace all cells from a previously serialized snapshot. Tolerant of malformed entries. */
  fromJSON(json: ReputationTrackerLoadJSON | undefined | null): void {
    this.cells.clear();
    if (!json || !Array.isArray(json.records)) return;
    for (const record of json.records) {
      if (!record || typeof record.agentId !== 'string' || typeof record.capability !== 'string') {
        continue;
      }
      if (!Number.isFinite(record.attempts) || !Number.isFinite(record.successes)) continue;
      this.setRecord(record.agentId, record.capability, {
        attempts: record.attempts,
        successes: record.successes,
        ...(typeof record.failures === 'number' && Number.isFinite(record.failures)
          ? { failures: record.failures }
          : {}),
        // T71: v2 rows carry the integer event buckets; v1 rows (and
        // malformed rows) fall back to setRecord's weight-sum integerization.
        ...(typeof record.successEvents === 'number' && Number.isFinite(record.successEvents)
          ? { successEvents: record.successEvents }
          : {}),
        ...(typeof record.partialEvents === 'number' && Number.isFinite(record.partialEvents)
          ? { partialEvents: record.partialEvents }
          : {}),
        ...(typeof record.failureEvents === 'number' && Number.isFinite(record.failureEvents)
          ? { failureEvents: record.failureEvents }
          : {}),
        ...(typeof record.lastAt === 'number' && Number.isFinite(record.lastAt)
          ? { lastAt: record.lastAt }
          : {}),
      });
    }
  }

  private static key(agentId: string, capability: string): string {
    return `${agentId}::${capability}`;
  }
}

export default ReputationTracker;
