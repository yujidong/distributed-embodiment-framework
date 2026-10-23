/**
 * Proposal + command-log stores — P-A governance kernel persistence
 * (multi-user-simulation-design.md §4, §9)
 *
 * `proposals` carries one row per requested shared-world change; the state
 * machine (submitted → rule_check → ai_review → approved/escalated →
 * applied → reverted) is driven by the proposal service, this store only
 * persists transitions. `command_log` is the append-only audit of every
 * applied change and its revert — its `{before, after}` payload is what
 * makes a revert the apply entry's inverse operation.
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export type ProposalKind =
  | 'install-devices'
  | 'install-agents'
  | 'install-zones'
  | 'remove-agents'
  | 'remove-devices'
  | 'inject-scenario'
  | 'modify-object'
  | 'zone-claim'
  | 'adopt-config'
  // C3 (R42-B, devloop-r41-a1 §8): governance-plane ownership handover.
  | 'ownership-transfer';
export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  'install-devices',
  'install-agents',
  'install-zones',
  'remove-agents',
  'remove-devices',
  'inject-scenario',
  'modify-object',
  'zone-claim',
  'adopt-config',
  'ownership-transfer',
];

export type ProposalStatus =
  | 'submitted'
  | 'rule_check'
  | 'ai_review'
  | 'approved'
  | 'rejected'
  | 'escalated'
  | 'applied'
  | 'reverted';
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'submitted',
  'rule_check',
  'ai_review',
  'approved',
  'rejected',
  'escalated',
  'applied',
  'reverted',
];

export type ProposalRiskLevel = 'low' | 'medium' | 'high';

export interface ProposalRow {
  id: string;
  env_id: string;
  author_id: string;
  kind: ProposalKind;
  payload_json: string;
  risk_level: ProposalRiskLevel;
  status: ProposalStatus;
  rule_check_json: string | null;
  ai_review_json: string | null;
  reviewer_id: string | null;
  created_at: string;
  decided_at: string | null;
  applied_at: string | null;
  expires_at: string | null;
}

export interface CreateProposalInput {
  envId: string;
  authorId: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  status?: ProposalStatus;
  expiresAt?: string | null;
}

/** Columns a state transition may touch (never author/kind/payload). */
export interface ProposalTransition {
  status: ProposalStatus;
  riskLevel?: ProposalRiskLevel;
  ruleCheck?: unknown;
  aiReview?: unknown;
  reviewerId?: string | null;
  decidedAt?: string | null;
  appliedAt?: string | null;
}

export interface CommandLogRow {
  id: number;
  env_id: string;
  actor_id: string;
  proposal_id: string | null;
  kind: string;
  payload_json: string;
  sim_time: number | null;
  wall_time: string;
}

export interface AppendCommandLogInput {
  envId: string;
  actorId: string;
  proposalId?: string | null;
  kind: string;
  payload: unknown;
  simTime?: number | null;
  /** Wall-clock override (tests / backfill); defaults to now. */
  wallTime?: string;
}

export class ProposalStore {
  constructor(private readonly db: EafDatabase) {}

  /** Run `fn` inside a database transaction (savepoint-safe when nested). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  create(input: CreateProposalInput): ProposalRow {
    const row: ProposalRow = {
      id: randomUUID(),
      env_id: input.envId,
      author_id: input.authorId,
      kind: input.kind,
      payload_json: JSON.stringify(input.payload),
      risk_level: 'low',
      status: input.status ?? 'submitted',
      rule_check_json: null,
      ai_review_json: null,
      reviewer_id: null,
      created_at: new Date().toISOString(),
      decided_at: null,
      applied_at: null,
      expires_at: input.expiresAt ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO proposals
         (id, env_id, author_id, kind, payload_json, risk_level, status,
          rule_check_json, ai_review_json, reviewer_id,
          created_at, decided_at, applied_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.author_id, row.kind, row.payload_json, row.risk_level,
        row.status, row.rule_check_json, row.ai_review_json, row.reviewer_id,
        row.created_at, row.decided_at, row.applied_at, row.expires_at,
      );
    return row;
  }

  get(id: string): ProposalRow | undefined {
    return this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as
      | ProposalRow
      | undefined;
  }

  /** Persist a state-machine transition; returns the updated row. */
  transition(id: string, patch: ProposalTransition): ProposalRow {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Proposal "${id}" not found`);
    }
    const next: ProposalRow = {
      ...existing,
      status: patch.status,
      risk_level: patch.riskLevel ?? existing.risk_level,
      rule_check_json:
        patch.ruleCheck !== undefined ? JSON.stringify(patch.ruleCheck) : existing.rule_check_json,
      ai_review_json:
        patch.aiReview !== undefined ? JSON.stringify(patch.aiReview) : existing.ai_review_json,
      reviewer_id: patch.reviewerId !== undefined ? patch.reviewerId : existing.reviewer_id,
      decided_at: patch.decidedAt !== undefined ? patch.decidedAt : existing.decided_at,
      applied_at: patch.appliedAt !== undefined ? patch.appliedAt : existing.applied_at,
    };
    this.db
      .prepare(
        `UPDATE proposals
         SET status = ?, risk_level = ?, rule_check_json = ?, ai_review_json = ?,
             reviewer_id = ?, decided_at = ?, applied_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status, next.risk_level, next.rule_check_json, next.ai_review_json,
        next.reviewer_id, next.decided_at, next.applied_at, id,
      );
    return next;
  }

  /**
   * Proposals of one environment, newest first. `authorId` scopes the list
   * to one author (non-owner visibility); `status` filters by state.
   */
  listForEnv(
    envId: string,
    filters: { authorId?: string; status?: ProposalStatus } = {},
  ): ProposalRow[] {
    let sql = 'SELECT * FROM proposals WHERE env_id = ?';
    const params: string[] = [envId];
    if (filters.authorId !== undefined) {
      sql += ' AND author_id = ?';
      params.push(filters.authorId);
    }
    if (filters.status !== undefined) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    return this.db.prepare(sql).all(...params) as ProposalRow[];
  }

  /**
   * Fix-16 owner todo: escalated proposals awaiting a decision in
   * environments the user OWNS (the author's side of the loop is the
   * notification inbox, not this count).
   */
  countEscalatedForEnvOwner(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM proposals p
         JOIN environments e ON e.id = p.env_id
         WHERE p.status = 'escalated' AND e.owner_id = ?`,
      )
      .get(userId) as { n: number };
    return row.n;
  }
}

export class CommandLogStore {
  constructor(private readonly db: EafDatabase) {}

  append(input: AppendCommandLogInput): CommandLogRow {
    const wallTime = input.wallTime ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO command_log
         (env_id, actor_id, proposal_id, kind, payload_json, sim_time, wall_time)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.envId,
        input.actorId,
        input.proposalId ?? null,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.simTime ?? null,
        wallTime,
      );
    return this.db
      .prepare('SELECT * FROM command_log WHERE id = ?')
      .get(result.lastInsertRowid) as CommandLogRow;
  }

  /** Audit query: newest entries first, optional kind filter. `before` (ISO) is the activity feed's pagination cursor (Wave-1a). */
  listForEnv(envId: string, filters: { limit?: number; kind?: string; before?: string } = {}): CommandLogRow[] {
    let sql = 'SELECT * FROM command_log WHERE env_id = ?';
    const params: (string | number)[] = [envId];
    if (filters.kind !== undefined) {
      sql += ' AND kind = ?';
      params.push(filters.kind);
    }
    if (filters.before !== undefined) {
      sql += ' AND wall_time < ?';
      params.push(filters.before);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(filters.limit ?? 100);
    return this.db.prepare(sql).all(...params) as CommandLogRow[];
  }

  /**
   * Time-window query (P-E replay material): oldest first. `from` inclusive,
   * `to` exclusive — same window semantics as ObservationStore.query.
   */
  queryInWindow(envId: string, from: string, to: string, limit = 5000): CommandLogRow[] {
    return this.db
      .prepare(
        `SELECT * FROM command_log
         WHERE env_id = ? AND wall_time >= ? AND wall_time < ?
         ORDER BY wall_time ASC, id ASC LIMIT ?`,
      )
      .all(envId, from, to, limit) as CommandLogRow[];
  }

  /**
   * The APPLY entry of a proposal (its kind, not a `revert:*` entry) — the
   * record a revert inverts. Undefined when the proposal was never applied.
   */
  findApplyEntry(proposalId: string, kind: string): CommandLogRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM command_log
         WHERE proposal_id = ? AND kind = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(proposalId, kind) as CommandLogRow | undefined;
  }
}
