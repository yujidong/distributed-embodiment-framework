/**
 * User store — persistence for registered accounts
 *
 * Emails are stored lowercase (normalized at the auth layer) so uniqueness
 * is case-insensitive. Password hashes are bcrypt (10 rounds) — the store
 * treats them as opaque strings.
 */

import { randomUUID } from 'node:crypto';

import type { EafDatabase } from './database.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: string;
  /** Session-invalidation counter (P4-4, schema v8); embedded in JWTs as `tv`. */
  token_version: number;
  /** Outbound notification webhook (Wave-4b, schema v20); NULL = pull-only inbox. */
  webhook_url: string | null;
}

/** User shape safe to hand to API responses (no password hash). */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export class UserStore {
  constructor(private readonly db: EafDatabase) {}

  /** Create a user; returns the row. Throws on duplicate email (SQLITE_CONSTRAINT). */
  create(email: string, passwordHash: string, displayName: string): UserRow {
    const row: UserRow = {
      id: randomUUID(),
      email,
      password_hash: passwordHash,
      display_name: displayName,
      created_at: new Date().toISOString(),
      token_version: 0,
      webhook_url: null,
    };
    this.db
      .prepare(
        'INSERT INTO users (id, email, password_hash, display_name, created_at, token_version) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.email, row.password_hash, row.display_name, row.created_at, row.token_version);
    return row;
  }

  findByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  }

  findById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  /** Replace the password hash (change-password flow, P4-4). */
  updatePassword(id: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  /** Rename the user (PATCH /api/me, Fix-13); returns the updated row. */
  updateDisplayName(id: string, displayName: string): UserRow {
    this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
    return this.findById(id)!;
  }

  /** Set or clear the notification webhook (Wave-4b, PUT/DELETE /api/me/notification-webhook). */
  setWebhookUrl(id: string, url: string | null): void {
    this.db.prepare('UPDATE users SET webhook_url = ? WHERE id = ?').run(url, id);
  }

  /**
   * Invalidate every token issued so far (logout-all, P4-4): bump the
   * token_version so JWTs carrying the old `tv` claim stop authenticating.
   * Returns the new version.
   */
  bumpTokenVersion(id: string): number {
    this.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
    return this.findById(id)?.token_version ?? 0;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  /** Every registered account, newest first (GET /api/admin/users). */
  list(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC, id DESC').all() as UserRow[];
  }
}
