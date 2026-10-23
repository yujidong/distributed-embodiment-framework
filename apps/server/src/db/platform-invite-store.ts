/**
 * Platform Invite Store — alpha capacity gating for REGISTRATION.
 *
 * Distinct from EnvInviteStore (env-invite-store.ts): that one parks an
 * email for membership in ONE environment; this one gates creating an
 * ACCOUNT at all when the deployment runs invite-only (EAF_INVITE_ONLY).
 *
 * Codes are high-entropy (`EAF-XXXXX-XXXXX`, 50 bits from an unambiguous
 * alphabet) and are compared by exact equality — no normalization, so no
 * case/whitespace ambiguity to exploit. Redemption is an atomic conditional
 * UPDATE (`used_count < max_uses`) run inside the registration transaction,
 * so concurrent registrations can never overspend the remaining uses.
 */

import { randomBytes } from 'node:crypto';

import type { EafDatabase } from './database.js';

/** Unambiguous alphabet (no 0/O, 1/I/L) — codes get read aloud and retyped. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface PlatformInviteRow {
  code: string;
  max_uses: number;
  used_count: number;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** Wire shape for admin API responses (camelCase, mirrors the row). */
export interface PublicPlatformInvite {
  code: string;
  maxUses: number;
  usedCount: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export function toPublicInvite(row: PlatformInviteRow): PublicPlatformInvite {
  return {
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Redemption verdict. 'invalid' deliberately collapses "code does not exist"
 * and "code is used up" into one answer (the user-facing copy says
 * "邀请码无效或已用完") — only expiry/revocation ('gone') is distinguished,
 * since that tells the user to ask for a FRESH code rather than retry.
 */
export type RedeemVerdict = 'ok' | 'invalid' | 'gone';

/** Generate one high-entropy code: EAF-XXXXX-XXXXX (10 × 32 ≈ 50 bits). */
export function generateInviteCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `EAF-${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export class PlatformInviteStore {
  constructor(private readonly db: EafDatabase) {}

  /** Mint a new invite. expiresInDays undefined/null = never expires. */
  create(input: { maxUses: number; expiresInDays?: number | null; createdBy: string }): PlatformInviteRow {
    const now = new Date();
    const row: PlatformInviteRow = {
      code: generateInviteCode(),
      max_uses: input.maxUses,
      used_count: 0,
      created_by: input.createdBy,
      created_at: now.toISOString(),
      expires_at:
        input.expiresInDays != null
          ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
          : null,
      revoked_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO platform_invites (code, max_uses, used_count, created_by, created_at, expires_at, revoked_at)
         VALUES (@code, @max_uses, @used_count, @created_by, @created_at, @expires_at, @revoked_at)`,
      )
      .run(row);
    return row;
  }

  /** All invites, newest first (the admin console ordering). */
  list(): PlatformInviteRow[] {
    return this.db
      .prepare('SELECT * FROM platform_invites ORDER BY created_at DESC, code DESC')
      .all() as PlatformInviteRow[];
  }

  find(code: string): PlatformInviteRow | undefined {
    return this.db.prepare('SELECT * FROM platform_invites WHERE code = ?').get(code) as
      | PlatformInviteRow
      | undefined;
  }

  /** Mark revoked (idempotent); false when the code is unknown. */
  revoke(code: string): boolean {
    if (this.find(code) === undefined) return false;
    this.db
      .prepare('UPDATE platform_invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), code);
    return true;
  }

  /**
   * True when NO invite can currently admit a registration — the bootstrap
   * seed check at boot (invite-only with zero usable codes is an operator
   * deadlock: the gate is up and nobody can get in).
   */
  hasUsableInvite(now: Date = new Date()): boolean {
    const row = this.db
      .prepare(
        `SELECT code FROM platform_invites
         WHERE revoked_at IS NULL AND used_count < max_uses
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(now.toISOString());
    return row !== undefined;
  }

  /**
   * Atomically consume one use of `code`. Exact-match lookup (codes are
   * high-entropy — no normalization differential to exploit). The increment
   * is a conditional UPDATE so two concurrent registrations sharing the last
   * remaining use cannot both succeed. Callers run this inside the same
   * transaction as the user INSERT, so a failed user creation rolls the
   * consumption back.
   */
  redeem(code: string, now: Date = new Date()): RedeemVerdict {
    const row = this.find(code);
    if (row === undefined) return 'invalid';
    if (row.revoked_at !== null) return 'gone';
    if (row.expires_at !== null && row.expires_at <= now.toISOString()) return 'gone';
    const result = this.db
      .prepare('UPDATE platform_invites SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses')
      .run(code);
    return result.changes === 1 ? 'ok' : 'invalid';
  }
}
