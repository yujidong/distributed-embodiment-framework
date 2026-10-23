/**
 * Replay Share Store (R15-B1) — read-only shareable replay links.
 *
 * A share freezes a replay-service scenario snapshot (the environment's
 * observation window as events) behind an unguessable id. Anonymous viewers
 * fetch it via GET /api/shares/:id — no account, no env membership — until
 * it expires. Shares intentionally survive their environment (see migration
 * v24) and are pruned lazily on read once past expires_at.
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export interface ReplayShareCreateInput {
  environmentId: string;
  environmentName: string;
  name: string;
  description: string;
  /** Full scenario JSON (string — stored verbatim, served verbatim). */
  scenarioJson: string;
  eventCount: number;
  createdBy: string;
  /** ISO timestamp — GET rejects rows past this point. */
  expiresAt: string;
}

export interface ReplayShareRow {
  id: string;
  env_id: string;
  env_name: string;
  name: string;
  description: string;
  scenario_json: string;
  event_count: number;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  /** T-108: owner revocation tombstone (NULL = live). */
  revoked_at: string | null;
}

export class ReplayShareStore {
  constructor(private readonly db: EafDatabase) {}

  create(input: ReplayShareCreateInput): ReplayShareRow {
    const row: ReplayShareRow = {
      id: randomUUID(),
      env_id: input.environmentId,
      env_name: input.environmentName,
      name: input.name,
      description: input.description,
      scenario_json: input.scenarioJson,
      event_count: input.eventCount,
      created_by: input.createdBy,
      created_at: new Date().toISOString(),
      expires_at: input.expiresAt,
      revoked_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO replay_shares
           (id, env_id, env_name, name, description, scenario_json, event_count, created_by, created_at, expires_at, revoked_at)
         VALUES (@id, @env_id, @env_name, @name, @description, @scenario_json, @event_count, @created_by, @created_at, @expires_at, @revoked_at)`,
      )
      .run(row);
    return row;
  }

  /** One share by id; expired/revoked shares count as absent (expired are pruned). */
  get(id: string): ReplayShareRow | undefined {
    const row = this.peek(id);
    if (row === undefined) return undefined;
    if (row.revoked_at !== null) return undefined;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.delete(id);
      return undefined;
    }
    return row;
  }

  /**
   * Raw row lookup without readability rules or pruning — lets the viewer
   * route distinguish a deliberate revocation (410) from an unknown link
   * (404). (T-108)
   */
  peek(id: string): ReplayShareRow | undefined {
    return this.db
      .prepare('SELECT * FROM replay_shares WHERE id = ?')
      .get(id) as ReplayShareRow | undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM replay_shares WHERE id = ?').run(id);
  }

  /**
   * Owner revocation (T-108): tombstones one live share of the environment.
   * Returns false when the share does not exist, belongs to another env, or
   * was already revoked/expired.
   */
  revoke(environmentId: string, id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE replay_shares SET revoked_at = ?
         WHERE id = ? AND env_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(new Date().toISOString(), id, environmentId, new Date().toISOString());
    return result.changes > 0;
  }

  /** Live (non-revoked) shares of one environment, newest first (owner list). */
  listForEnv(environmentId: string, limit = 20): ReplayShareRow[] {
    return this.db
      .prepare(
        `SELECT * FROM replay_shares
         WHERE env_id = ? AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(environmentId, limit) as ReplayShareRow[];
  }
}
