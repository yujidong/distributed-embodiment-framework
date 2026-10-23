/**
 * Admin routes — operator actions gated on ADMIN_EMAILS (R15-A2)
 *
 * - `POST /api/admin/backup` — consistent SQLite snapshot of the live
 *   database into `<dbDir>/backups/eaf-<timestamp>.db` using better-sqlite3's
 *   `.backup()` (the sqlite3 CLI `.backup` equivalent). WAL-safe: no
 *   stop-the-world, the API keeps serving while the snapshot runs. The
 *   server picks the destination path — callers cannot write arbitrary
 *   files. Operators prune old snapshots; docs/deployment.md documents the
 *   restore procedure (verified round-trip in migration.vitest.test.ts).
 *
 * - Platform invites (alpha capacity gating, EAF_INVITE_ONLY, schema v57):
 *   - `POST /api/admin/invites` `{maxUses?, expiresInDays?}` → 201 with the
 *     row INCLUDING the plaintext code — this is the only creation-time view;
 *     the code is also the row's primary key, so it stays listable (unlike a
 *     hashed credential), but operators should still treat it as a secret in
 *     transit.
 *   - `GET /api/admin/invites` → `{invites}` with usage statistics.
 *   - `POST /api/admin/invites/:code/revoke` → 200 with the revoked row
 *     (idempotent); 404 for an unknown code.
 *
 * - `GET /api/admin/users` — the operator account roster for the invite-only
 *   alpha: every registered user with `isAdmin` derived from ADMIN_EMAILS
 *   (same derivation as GET /api/auth/me). Never carries credential fields.
 */

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { isAdminEmail } from '../auth/admin.js';
import type { EafDatabase } from '../db/database.js';
import { toPublicInvite, type PlatformInviteStore } from '../db/platform-invite-store.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { ApiError } from '../errors.js';

export interface AdminRoutesContext {
  db: EafDatabase;
  /** SQLite file path — backups land next to it, in a `backups/` subdir. */
  databasePath: string;
  /** Lowercase ADMIN_EMAILS. */
  adminEmails: string[];
  /** Alpha capacity gating: platform registration invites (schema v57). */
  inviteStore: PlatformInviteStore;
  /** Registered accounts (GET /api/admin/users roster). */
  userStore: UserStore;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AdminRoutesContext): void {
  app.post('/api/admin/backup', { preHandler: app.authenticate }, async request => {
    if (!isAdminEmail(request.user!.email, ctx.adminEmails)) {
      throw new ApiError(403, 'FORBIDDEN', 'Admin backup requires an admin account');
    }
    if (ctx.databasePath === ':memory:') {
      throw new ApiError(400, 'BACKUP_NOT_SUPPORTED', 'The in-memory database cannot be backed up');
    }

    const dir = join(dirname(ctx.databasePath), 'backups');
    const target = join(dir, `eaf-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    try {
      mkdirSync(dir, { recursive: true });
      await ctx.db.backup(target);
    } catch (error) {
      throw new ApiError(
        500,
        'BACKUP_FAILED',
        `Database backup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      path: target,
      sizeBytes: statSync(target).size,
      createdAt: new Date().toISOString(),
    };
  });

  // -------------------------------------------------------------------------
  // Platform invites (alpha capacity gating, schema v57)
  // -------------------------------------------------------------------------

  app.post('/api/admin/invites', { preHandler: app.authenticate }, async (request, reply) => {
    if (!isAdminEmail(request.user!.email, ctx.adminEmails)) {
      throw new ApiError(403, 'FORBIDDEN', 'Invite management requires an admin account');
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const maxUses = body.maxUses === undefined ? 1 : Number(body.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      throw new ApiError(400, 'INVALID_MAX_USES', 'Body field "maxUses" must be an integer >= 1');
    }
    let expiresInDays: number | null = null;
    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
      expiresInDays = Number(body.expiresInDays);
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1) {
        throw new ApiError(
          400,
          'INVALID_EXPIRES_IN_DAYS',
          'Body field "expiresInDays" must be an integer >= 1 (or omitted for no expiry)',
        );
      }
    }
    const row = ctx.inviteStore.create({
      maxUses,
      expiresInDays,
      createdBy: request.user!.email,
    });
    return reply.code(201).send(toPublicInvite(row));
  });

  app.get('/api/admin/invites', { preHandler: app.authenticate }, async request => {
    if (!isAdminEmail(request.user!.email, ctx.adminEmails)) {
      throw new ApiError(403, 'FORBIDDEN', 'Invite management requires an admin account');
    }
    return { invites: ctx.inviteStore.list().map(toPublicInvite) };
  });

  app.post('/api/admin/invites/:code/revoke', { preHandler: app.authenticate }, async request => {
    if (!isAdminEmail(request.user!.email, ctx.adminEmails)) {
      throw new ApiError(403, 'FORBIDDEN', 'Invite management requires an admin account');
    }
    const { code } = request.params as { code: string };
    if (!ctx.inviteStore.revoke(code)) {
      throw new ApiError(404, 'INVITE_NOT_FOUND', `Unknown invite code "${code}"`);
    }
    return toPublicInvite(ctx.inviteStore.find(code)!);
  });

  // -------------------------------------------------------------------------
  // Registered-user roster (invite-only alpha operations)
  // -------------------------------------------------------------------------

  app.get('/api/admin/users', { preHandler: app.authenticate }, async request => {
    if (!isAdminEmail(request.user!.email, ctx.adminEmails)) {
      throw new ApiError(403, 'FORBIDDEN', 'User listing requires an admin account');
    }
    return {
      users: ctx.userStore.list().map(row => ({
        ...toPublicUser(row),
        isAdmin: isAdminEmail(row.email, ctx.adminEmails),
      })),
    };
  });
}
