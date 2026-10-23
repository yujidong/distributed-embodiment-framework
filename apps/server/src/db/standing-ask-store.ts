/**
 * Standing-ask store — the 需求板 (demand board), T-069 (DevLoop R23,
 * R19 NW-F04 — design-data-services.md §11).
 *
 * A standing ask is a member's persisted demand for a FUTURE counterpart
 * asset: "when someone publishes a service of semanticType X (in zone Z),
 * I want to hear about it (and optionally receive a pre-filled proposal)".
 * It closes the async-market cold-start gap — an agreement/access-request
 * can only target an EXISTING service, and every notification channel
 * reaches only the env owner or an existing bilateral counterparty, so a
 * successor who owns nothing could receive nothing.
 *
 * Lifecycle: open → matched (single-match, one notification then off the
 * board) | withdrawn (asker DELETE) | expired (lazy — evaluated on read and
 * on match; no resident sweeper, stale data is never returned).
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export type StandingAskStatus = 'open' | 'matched' | 'withdrawn' | 'expired';

export const STANDING_ASK_STATUSES: readonly StandingAskStatus[] = [
  'open',
  'matched',
  'withdrawn',
  'expired',
];

export interface StandingAskRow {
  id: string;
  env_id: string;
  asker_id: string;
  semantic_type: string;
  zone_id: string | null;
  desired_terms_json: string;
  note: string;
  auto_propose: number;
  status: StandingAskStatus;
  matched_service_id: string | null;
  matched_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface CreateStandingAskInput {
  envId: string;
  askerId: string;
  semanticType: string;
  zoneId?: string | null;
  /** Pre-validated AgreementTerms (parseTermsBody ran at the route). */
  desiredTerms?: Record<string, unknown>;
  note?: string;
  autoPropose?: boolean;
  expiresAt: string;
}

/**
 * design §11.2(4): per (member, env) cap on OPEN asks — the spam guard.
 * The 11th concurrent open ask answers 429 with the withdraw remedy.
 */
export const MAX_OPEN_ASKS_PER_MEMBER = 10;

export class StandingAskStore {
  constructor(private readonly db: EafDatabase) {}

  create(input: CreateStandingAskInput): StandingAskRow {
    const row: StandingAskRow = {
      id: randomUUID(),
      env_id: input.envId,
      asker_id: input.askerId,
      semantic_type: input.semanticType,
      zone_id: input.zoneId ?? null,
      desired_terms_json: JSON.stringify(input.desiredTerms ?? {}),
      note: input.note ?? '',
      auto_propose: input.autoPropose === true ? 1 : 0,
      status: 'open',
      matched_service_id: null,
      matched_at: null,
      expires_at: input.expiresAt,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO standing_asks
         (id, env_id, asker_id, semantic_type, zone_id, desired_terms_json, note,
          auto_propose, status, matched_service_id, matched_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.env_id, row.asker_id, row.semantic_type, row.zone_id,
        row.desired_terms_json, row.note, row.auto_propose, row.status,
        row.matched_service_id, row.matched_at, row.expires_at, row.created_at,
      );
    return row;
  }

  get(id: string): StandingAskRow | undefined {
    return this.db
      .prepare('SELECT * FROM standing_asks WHERE id = ?')
      .get(id) as StandingAskRow | undefined;
  }

  /**
   * Lazy expiry (design §11.2(4)): flip every OPEN ask of the env whose
   * expires_at is past. Called before list + match so no consumer ever sees
   * an "open" ask that is factually expired.
   */
  private expireStale(envId: string): void {
    this.db
      .prepare(
        `UPDATE standing_asks SET status = 'expired'
         WHERE env_id = ? AND status = 'open' AND expires_at <= ?`,
      )
      .run(envId, new Date().toISOString());
  }

  /** The env's board. `statuses` filters the lifecycle (default: open). */
  listForEnv(envId: string, statuses: readonly StandingAskStatus[] = ['open']): StandingAskRow[] {
    this.expireStale(envId);
    const placeholders = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM standing_asks
         WHERE env_id = ? AND status IN (${placeholders})
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(envId, ...statuses) as StandingAskRow[];
  }

  /** Open asks of one semantic type — the matching candidate set. */
  listOpenBySemanticType(envId: string, semanticType: string): StandingAskRow[] {
    this.expireStale(envId);
    return this.db
      .prepare(
        `SELECT * FROM standing_asks
         WHERE env_id = ? AND semantic_type = ? AND status = 'open'
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(envId, semanticType) as StandingAskRow[];
  }

  /** The member's OPEN ask count in the env (quota probe). */
  countOpenOf(envId: string, askerId: string): number {
    this.expireStale(envId);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM standing_asks
         WHERE env_id = ? AND asker_id = ? AND status = 'open'`,
      )
      .get(envId, askerId) as { n: number };
    return row.n;
  }

  /**
   * design §11.2(5) single-match: claim the ask for one service. Returns
   * the updated row, or undefined when the ask is no longer open (a
   * concurrent claim won — first-match wins, the loser is silently a
   * no-match; SQLite serializes the UPDATE).
   */
  markMatched(id: string, serviceId: string): StandingAskRow | undefined {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE standing_asks
         SET status = 'matched', matched_service_id = ?, matched_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(serviceId, now, id);
    if (result.changes === 0) return undefined;
    return this.get(id);
  }

  /** The asker's withdraw. Returns the updated row, or undefined if not open. */
  withdraw(id: string): StandingAskRow | undefined {
    const result = this.db
      .prepare(`UPDATE standing_asks SET status = 'withdrawn' WHERE id = ? AND status = 'open'`)
      .run(id);
    if (result.changes === 0) return undefined;
    return this.get(id);
  }
}
