/**
 * Reputation store — persisted service/agent reputation (P4-1)
 *
 * One row per (env, agent, capability), where capability is the service
 * semantic type — the same key the engine's ReputationTracker uses, so rows
 * map 1:1 onto `service_instances (env_id, provider_agent_id, semantic_type)`.
 * Environment-backed simulations load their env's rows into the runtime's
 * tracker at start and upsert the tracker back as collaboration outcomes
 * arrive (and on stop). Legacy scenario sims stay in-memory only.
 *
 * Scores are computed on read with the SAME formula the engine uses
 * (`computeReputationScore` from core): Bayesian success rate with a prior
 * (0.7, α=5) and recency decay (half-life 1 day). The engine decays on its
 * SIM clock; the API decays on wall time — both interpret `last_at` as a ms
 * epoch, and sim clocks are seeded from wall time at runtime construction,
 * so ages stay comparable across restarts.
 */

import { computeReputationScore, DEFAULT_REPUTATION_CONFIG } from '@active-collaboration/core';

import type { EafDatabase } from './database.js';

export interface AgentReputationRow {
  env_id: string;
  agent_id: string;
  capability: string;
  attempts: number;
  successes: number;
  failures: number;
  /**
   * T71 (R8, u1-F3): integer EVENT buckets — NULL on legacy rows written
   * before v64 (readers integerize from the weight sums, see core's
   * `integerizeReputationEvents`).
   */
  success_events: number | null;
  partial_events: number | null;
  failure_events: number | null;
  /** ms epoch of the last update (engine sim clock). */
  last_at: number;
}

/** Read-side reputation view attached to services/agents in API responses. */
export interface ReputationScoreView {
  score: number;
  attempts: number;
  successes: number;
  /**
   * T37 (R3, u4-F4): present ONLY on the zero-sample view — the Bayesian
   * prior the score equals, so a bare `score 0.7 · attempts 0` can never be
   * read as a measured 0.7. Absent once real attempts exist (the score is
   * then measured, not prior-driven).
   */
  prior?: number;
}

/** Record shape accepted from the engine tracker (no env id — scoped per env). */
export interface ReputationRecordInput {
  agentId: string;
  capability: string;
  attempts: number;
  successes: number;
  failures: number;
  /** T71: integer event buckets (absent on legacy callers — stored NULL). */
  successEvents?: number;
  partialEvents?: number;
  failureEvents?: number;
  lastAt: number;
}

export class ReputationStore {
  constructor(private readonly db: EafDatabase) {}

  /** All reputation rows of an environment (tracker load path). */
  rowsForEnv(envId: string): AgentReputationRow[] {
    return this.db
      .prepare('SELECT * FROM agent_reputation WHERE env_id = ?')
      .all(envId) as AgentReputationRow[];
  }

  /** Full per-capability breakdown of one agent in an environment. */
  rowsForAgent(envId: string, agentId: string): AgentReputationRow[] {
    return this.db
      .prepare(
        'SELECT * FROM agent_reputation WHERE env_id = ? AND agent_id = ? ' +
        'ORDER BY attempts DESC, capability ASC',
      )
      .all(envId, agentId) as AgentReputationRow[];
  }

  /**
   * Persist the engine tracker's contents for an environment: upsert every
   * record. Rows the tracker does not hold are left untouched — the tracker
   * was loaded from these very rows at sim start, so its contents are a
   * superset of what was there (plus anything learned since).
   */
  saveForEnv(envId: string, records: ReputationRecordInput[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO agent_reputation (env_id, agent_id, capability, attempts, successes, failures,
                                     success_events, partial_events, failure_events, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (env_id, agent_id, capability)
       DO UPDATE SET attempts = excluded.attempts, successes = excluded.successes,
                     failures = excluded.failures,
                     success_events = excluded.success_events,
                     partial_events = excluded.partial_events,
                     failure_events = excluded.failure_events,
                     last_at = excluded.last_at`,
    );
    const run = this.db.transaction((rows: ReputationRecordInput[]) => {
      for (const record of rows) {
        upsert.run(
          envId,
          record.agentId,
          record.capability,
          record.attempts,
          record.successes,
          record.failures,
          record.successEvents ?? null,
          record.partialEvents ?? null,
          record.failureEvents ?? null,
          Math.round(record.lastAt),
        );
      }
    });
    run(records);
  }

  /**
   * Scored reputation for every (agent, capability) pair of an env, keyed
   * `${agentId}::${capability}` — the batch shape the service serializers
   * consume. Scores decayed at `nowMs` (default: now).
   */
  scoresForEnv(envId: string, nowMs: number = Date.now()): Map<string, ReputationScoreView> {
    const map = new Map<string, ReputationScoreView>();
    for (const row of this.rowsForEnv(envId)) {
      map.set(ReputationStore.key(row.agent_id, row.capability), {
        score: computeReputationScore(
          { attempts: row.attempts, successes: row.successes, lastAt: row.last_at },
          nowMs,
        ),
        attempts: row.attempts,
        successes: row.successes,
      });
    }
    return map;
  }

  /** Scored reputation of one (agent, capability), or undefined when no history. */
  scoreFor(
    envId: string,
    agentId: string,
    capability: string,
    nowMs: number = Date.now(),
  ): ReputationScoreView | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM agent_reputation WHERE env_id = ? AND agent_id = ? AND capability = ?',
      )
      .get(envId, agentId, capability) as AgentReputationRow | undefined;
    if (!row) return undefined;
    return {
      score: computeReputationScore(
        { attempts: row.attempts, successes: row.successes, lastAt: row.last_at },
        nowMs,
      ),
      attempts: row.attempts,
      successes: row.successes,
    };
  }

  /**
   * Record one consumption failure against a provider agent (Fix-11 Phase 2,
   * §5): a failed world-layer invoke never reaches the engine's reputation
   * pipeline, so the usage outcome is scored here. Successes are deliberately
   * NOT scored — Fix-12's effect recheck owns those (no double accounting).
   */
  recordFailure(envId: string, agentId: string, capability: string, nowMs: number = Date.now()): void {
    this.recordOutcome(envId, agentId, capability, false, nowMs);
  }

  /**
   * R101 (trust-visibility, zhao-17): score ONE metered consumption outcome —
   * success or failure. The PM's round-4 ruling: the explicit lane's正式计量
   * （UsageRecord outcome）是声誉的客观数据源，成功与失败都计
   * attempts/successes；AC 协作仍由 runtime 的 Fix-12 管道覆盖（调用方负责
   * 排除 source='ac'，避免双重记账）。
   */
  recordOutcome(
    envId: string,
    agentId: string,
    capability: string,
    success: boolean,
    nowMs: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_reputation (env_id, agent_id, capability, attempts, successes, failures,
                                       success_events, partial_events, failure_events, last_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (env_id, agent_id, capability)
         DO UPDATE SET attempts = attempts + 1,
                       successes = successes + ?,
                       failures = failures + ?,
                       success_events = COALESCE(success_events, 0) + ?,
                       failure_events = COALESCE(failure_events, 0) + ?,
                       last_at = excluded.last_at`,
      )
      .run(
        envId, agentId, capability,
        success ? 1 : 0, success ? 0 : 1,
        success ? 1 : 0, success ? 0 : 1,
        Math.round(nowMs),
        success ? 1 : 0, success ? 0 : 1,
        success ? 1 : 0, success ? 0 : 1,
      );
  }

  /**
   * R101: ADDITIVE merge of a runtime tracker's learned deltas (the P4-1
   * persist path). saveForEnv's wholesale upsert clobbered increments the
   * invoke lane wrote while the sim was running (the tracker was loaded at
   * sim start and held a stale snapshot — zhao-17's frozen 0/0). The caller
   * (SimulationSeams.persistReputation) computes per-key deltas against the
   * load-time baseline; this applies them without ever decrementing a row.
   */
  mergeForEnv(envId: string, deltas: ReputationRecordInput[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO agent_reputation (env_id, agent_id, capability, attempts, successes, failures,
                                     success_events, partial_events, failure_events, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (env_id, agent_id, capability)
       DO UPDATE SET attempts = attempts + excluded.attempts,
                     successes = successes + excluded.successes,
                     failures = failures + excluded.failures,
                     success_events = COALESCE(success_events, 0) + excluded.success_events,
                     partial_events = COALESCE(partial_events, 0) + excluded.partial_events,
                     failure_events = COALESCE(failure_events, 0) + excluded.failure_events,
                     last_at = MAX(last_at, excluded.last_at)`,
    );
    const run = this.db.transaction((rows: ReputationRecordInput[]) => {
      for (const record of rows) {
        if (record.attempts <= 0 && record.successes <= 0 && record.failures <= 0) continue;
        upsert.run(
          envId,
          record.agentId,
          record.capability,
          record.attempts,
          record.successes,
          record.failures,
          record.successEvents ?? 0,
          record.partialEvents ?? 0,
          record.failureEvents ?? 0,
          Math.round(record.lastAt),
        );
      }
    });
    run(deltas);
  }

  /**
   * R102 (trust-ledger-consistency, wang-16/zhao-20): backfill reputation
   * rows from the metered ledger (usage_records is the唯一事实源) — explicit
   * agreements' consumption recomputed per (env, provider agent, service
   * semantic type) and MAX-merged (never clobbers the runtime's AC-written
   * rows; idempotent against the invoke lane's incremental writes). Rows
   * retired by service loss (service_id NULL) are unlinkable by design and
   * stay out — this heals the pre-R101 scoring gap (metered but never
   * scored) and the published/derived category mix-up, one pipeline for
   * every service shape.
   *
   * Returns the number of (agent, capability) cells touched.
   */
  reconcileFromMeteredUsage(nowMs: number = Date.now()): number {
    const rows = this.db
      .prepare(
        `SELECT a.env_id AS envId, a.provider_agent_id AS agentId, s.semantic_type AS capability,
                COUNT(*) AS attempts,
                COALESCE(SUM(CASE WHEN u.outcome = 'success' THEN 1 ELSE 0 END), 0) AS successes,
                COALESCE(SUM(CASE WHEN u.outcome = 'failure' THEN 1 ELSE 0 END), 0) AS failures,
                COALESCE(SUM(CASE WHEN u.outcome = 'partial' THEN 1 ELSE 0 END), 0) AS partials,
                MAX(u.started_at) AS lastSeenIso
         FROM usage_records u
         JOIN service_agreements a ON u.agreement_id = a.id
         JOIN service_instances s ON a.service_id = s.id
         WHERE a.provider_agent_id IS NOT NULL
           AND COALESCE(a.source, 'explicit') = 'explicit'
         GROUP BY a.env_id, a.provider_agent_id, s.semantic_type`,
      )
      .all() as Array<{
        envId: string; agentId: string; capability: string;
        attempts: number; successes: number; failures: number; partials: number; lastSeenIso: string;
      }>;
    if (rows.length === 0) return 0;
    const upsert = this.db.prepare(
      `INSERT INTO agent_reputation (env_id, agent_id, capability, attempts, successes, failures,
                                     success_events, partial_events, failure_events, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (env_id, agent_id, capability)
       DO UPDATE SET attempts = MAX(attempts, excluded.attempts),
                     successes = MAX(successes, excluded.successes),
                     failures = MAX(failures, excluded.failures),
                     success_events = MAX(COALESCE(success_events, 0), excluded.success_events),
                     partial_events = MAX(COALESCE(partial_events, 0), excluded.partial_events),
                     failure_events = MAX(COALESCE(failure_events, 0), excluded.failure_events),
                     last_at = MAX(last_at, excluded.last_at)`,
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const lastAt = Date.parse(row.lastSeenIso);
        upsert.run(
          row.envId, row.agentId, row.capability,
          row.attempts, row.successes, row.failures,
          row.successes, row.partials, row.failures,
          Number.isFinite(lastAt) ? Math.round(lastAt) : Math.round(nowMs),
        );
      }
    })();
    return rows.length;
  }

  /**
   * Pooled per-agent score across all capabilities (mirrors
   * ReputationTracker.agentScore): evidence decayed per row, then combined.
   * Returns the prior when the agent has no history.
   */
  overallForAgent(envId: string, agentId: string, nowMs: number = Date.now()): number {
    let attempts = 0;
    let successes = 0;
    for (const row of this.rowsForAgent(envId, agentId)) {
      const age = Math.max(0, nowMs - row.last_at);
      const decay = Math.pow(0.5, age / DEFAULT_REPUTATION_CONFIG.halfLifeMs);
      attempts += row.attempts * decay;
      successes += row.successes * decay;
    }
    if (attempts === 0) return DEFAULT_REPUTATION_CONFIG.prior;
    return (successes + DEFAULT_REPUTATION_CONFIG.alpha * DEFAULT_REPUTATION_CONFIG.prior) /
      (attempts + DEFAULT_REPUTATION_CONFIG.alpha);
  }

  static key(agentId: string, capability: string): string {
    return `${agentId}::${capability}`;
  }
}

/** Reputation view for a service/agent with NO history yet (prior score, zero counts). */
export function noHistoryView(): ReputationScoreView {
  // T37 (R3, u4-F4): the zero-sample view names its prior explicitly — the
  // score IS the prior until real attempts exist.
  const prior = DEFAULT_REPUTATION_CONFIG.prior;
  return { score: prior, attempts: 0, successes: 0, prior };
}
