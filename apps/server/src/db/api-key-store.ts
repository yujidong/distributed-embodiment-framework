/**
 * API-key store — the external-caller credential (R55).
 *
 * JWTs are for platform citizens (web UI, CLI). An API key is for the
 * OUTSIDE world: an existing service, a script, a cron job, another
 * platform — anything that speaks plain HTTP and wants to consume an
 * environment's services without becoming a platform user session.
 *
 * Semantics:
 * - a key ACTS AS its owning user (it inherits their permissions and their
 *   agreement lanes — the key is a credential, not a separate principal);
 * - scope narrows it to one environment (env_id NOT NULL) and optionally
 *   to a single service (service_id NULL = every service in the env);
 * - storage is SHA-256 — the plaintext `eak_…` is returned exactly once
 *   at creation and never leaves the client again;
 * - lifecycle: optional expiry (expires_at), revoke (revoked_at),
 *   last_used_at bookkeeping for hygiene.
 */

import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export interface ApiKeyRow {
  id: string;
  user_id: string;
  env_id: string;
  service_id: string | null;
  name: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/** The credential prefix — distinguishes keys from JWTs at parse time. */
export const API_KEY_PREFIX = 'eak_';

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf-8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ApiKeyStore {
  constructor(private readonly db: EafDatabase) {}

  /** Create a key; the plaintext secret is returned ONCE, never stored. */
  createKey(input: {
    userId: string;
    envId: string;
    serviceId?: string | null;
    name: string;
    ttlDays?: number | null;
  }): { row: ApiKeyRow; plaintext: string } {
    const id = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    const plaintext = `${API_KEY_PREFIX}${secret}`;
    const row: ApiKeyRow = {
      id,
      user_id: input.userId,
      env_id: input.envId,
      service_id: input.serviceId ?? null,
      name: input.name,
      key_hash: hashApiKey(plaintext),
      created_at: nowIso(),
      last_used_at: null,
      expires_at:
        input.ttlDays !== undefined && input.ttlDays !== null
          ? new Date(Date.now() + input.ttlDays * 86_400_000).toISOString()
          : null,
      revoked_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, user_id, env_id, service_id, name, key_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.user_id, row.env_id, row.service_id, row.name, row.key_hash, row.created_at, row.expires_at);
    return { row, plaintext };
  }

  /**
   * Verify a presented credential. Returns the row when valid (not revoked,
   * not expired) and stamps last_used_at — the stamp is best-effort and
   * throttled to one write per minute per key (a hot external caller must
   * not turn every invoke into a DB write).
   */
  verifyKey(plaintext: string): ApiKeyRow | null {
    if (!plaintext.startsWith(API_KEY_PREFIX)) return null;
    const row = this.db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
      .get(hashApiKey(plaintext)) as ApiKeyRow | undefined;
    if (row === undefined) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at !== null && row.expires_at <= nowIso()) return null;
    const stale =
      row.last_used_at === null || Date.now() - Date.parse(row.last_used_at) > 60_000;
    if (stale) {
      this.db
        .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .run(nowIso(), row.id);
    }
    return row;
  }

  listKeys(userId: string, envId?: string): ApiKeyRow[] {
    const rows = (
      envId === undefined
        ? this.db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId)
        : this.db
            .prepare('SELECT * FROM api_keys WHERE user_id = ? AND env_id = ? ORDER BY created_at DESC')
            .all(userId, envId)
    ) as ApiKeyRow[];
    // Expired/revoked keys stay listed (hygiene: the owner sees the state)
    // — the secret is never in a row, so listing is safe.
    return rows;
  }

  /** Revoke by id — only the owning user may. Returns true when it landed. */
  revokeKey(id: string, userId: string): boolean {
    const result = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(nowIso(), id, userId);
    return result.changes > 0;
  }
}
