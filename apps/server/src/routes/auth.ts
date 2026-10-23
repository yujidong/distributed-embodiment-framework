/**
 * Auth routes — register / login / logout / me, plus P4-4 session hardening
 *
 * - `POST /api/auth/register` `{email, password, displayName, inviteCode?}` →
 *   201 public user; 400 on validation failure, 409 on duplicate email.
 *   Emails are lowercase-normalized; passwords are bcrypt-hashed (10 rounds).
 *   Alpha capacity gating (EAF_INVITE_ONLY, schema v57): when the deployment
 *   runs invite-only, registration redeems a platform invite code in the same
 *   transaction as the user insert — missing code → 403 INVITE_REQUIRED,
 *   unknown/exhausted → 403 INVITE_INVALID, expired/revoked → 410 INVITE_GONE
 *   (localized teaching copy; the message never echoes any part of the code).
 * - `POST /api/auth/login` `{email, password}` → `{token}` + sets the
 *   httpOnly `eaf_token` cookie; 401 on bad credentials (same error for
 *   unknown email and wrong password — no account enumeration). Tokens embed
 *   the user's current `token_version` as `tv` (P4-4).
 * - `POST /api/auth/logout` → clears the cookie (open + idempotent).
 * - `GET  /api/auth/me` → current user (+ `isAdmin` when the email is in
 *   ADMIN_EMAILS), 401 when unauthenticated.
 * - `POST /api/auth/change-password` (auth) `{currentPassword, newPassword}`
 *   → 204. 400 INVALID_CURRENT_PASSWORD when the current password is wrong,
 *   400 INVALID_PASSWORD when the new one is weak. Deliberate choice: the
 *   change does NOT invalidate existing tokens (JWTs are stateless and carry
 *   no password proof) — callers wanting "sign out everywhere after change"
 *   should call logout-all. Documented in openapi.yaml.
 * - `POST /api/auth/logout-all` (auth) → 204. Bumps `users.token_version`,
 *   which invalidates EVERY token issued so far (including the caller's) via
 *   the `tv` check in auth/index.ts, and clears the cookie.
 */

import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

import { AUTH_COOKIE } from '../auth/index.js';
import { isAdminEmail, normalizeEmail } from '../auth/admin.js';
import type { EafDatabase } from '../db/database.js';
import type { PlatformInviteStore } from '../db/platform-invite-store.js';
import { ApiError } from '../errors.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { t } from '../i18n/index.js';

const BCRYPT_ROUNDS = 10;
/** Deliberately simple: local part + @ + dotted domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export interface AuthRoutesContext {
  userStore: UserStore;
  /** Lowercase ADMIN_EMAILS — feeds the `isAdmin` flag on /api/auth/me (P4-4). */
  adminEmails: string[];
  /**
   * Alpha capacity gating (schema v57): when true, registration requires a
   * valid platform invite code (`inviteCode` body field). Optional so test
   * setups without the invite chain stay minimal — but a true flag without
   * the store/db fails CLOSED (503), never open.
   */
  inviteOnly?: boolean;
  inviteStore?: PlatformInviteStore;
  /** Shared handle so redemption + user creation run in ONE transaction. */
  db?: EafDatabase;
  /**
   * R15-D10: registration accepts pending env invites. Optional so test
   * setups without the classroom chain stay minimal.
   */
  onRegistered?: (input: { userId: string; email: string }) => void;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AuthRoutesContext): void {
  app.post('/api/auth/register', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim().length > 0
        ? body.displayName.trim()
        : null;

    if (!EMAIL_PATTERN.test(email)) {
      throw new ApiError(400, 'INVALID_EMAIL', 'Body field "email" must be a valid email address');
    }
    // TASK-006 (DevLoop): check duplicate email BEFORE other field validation —
    // a user with an existing account + a missing displayName got
    // INVALID_DISPLAY_NAME instead of the actionable EMAIL_TAKEN.
    if (ctx.userStore.findByEmail(email)) {
      throw new ApiError(409, 'EMAIL_TAKEN', `Email "${email}" is already registered`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ApiError(
        400,
        'INVALID_PASSWORD',
        `Body field "password" must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (displayName === null) {
      throw new ApiError(400, 'INVALID_DISPLAY_NAME', 'Body field "displayName" must be a non-empty string');
    }

    // Alpha capacity gating (EAF_INVITE_ONLY, schema v57): the invite code is
    // redeemed in the SAME transaction as the user insert — a failed insert
    // rolls the consumption back, and the conditional UPDATE inside redeem()
    // makes concurrent registrations unable to overspend the remaining uses.
    // Every failed attempt still rides the /api/auth/* rate-limit bucket (the
    // limiter counts requests, not outcomes) so code guessing is throttled.
    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    let user;
    if (ctx.inviteOnly === true) {
      if (ctx.inviteStore === undefined || ctx.db === undefined) {
        // Misconfigured gate — fail CLOSED, never open.
        throw new ApiError(
          503,
          'INVITE_GATE_UNCONFIGURED',
          'Registration is invite-only but the invite store is not wired — server misconfiguration',
        );
      }
      const inviteCode =
        typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
      if (inviteCode.length === 0) {
        throw new ApiError(403, 'INVITE_REQUIRED', t(request.locale, 'chrome.auth.inviteRequired'));
      }
      const inviteStore = ctx.inviteStore;
      user = ctx.db.transaction(() => {
        const verdict = inviteStore.redeem(inviteCode);
        if (verdict === 'gone') {
          throw new ApiError(410, 'INVITE_GONE', t(request.locale, 'chrome.auth.inviteGone'));
        }
        if (verdict !== 'ok') {
          throw new ApiError(403, 'INVITE_INVALID', t(request.locale, 'chrome.auth.inviteInvalid'));
        }
        return ctx.userStore.create(email, passwordHash, displayName);
      })();
    } else {
      user = ctx.userStore.create(email, passwordHash, displayName);
    }
    // R15-D10: a teacher may have invited this email into class environments
    // BEFORE the account existed — accept every pending invite now.
    ctx.onRegistered?.({ userId: user.id, email });
    return reply.code(201).send(toPublicUser(user));
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const user = ctx.userStore.findByEmail(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const token = app.jwt.sign(
      { sub: user.id, email: user.email, tv: user.token_version },
      { expiresIn: '7d' },
    );
    void reply.setCookie(AUTH_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
    });
    return { token };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    void reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async request => {
    const user = ctx.userStore.findById(request.user!.id);
    if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    return {
      ...toPublicUser(user),
      // Task-0 hotfix: compare canonical forms — a mixed-case users.email row
      // used to get isAdmin:false here while every other ADMIN_EMAILS gate
      // said true (audit §3.1). isAdminEmail is the one truth.
      isAdmin: isAdminEmail(user.email, ctx.adminEmails),
    };
  });

  app.post(
    '/api/auth/change-password',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const currentPassword =
        typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

      const user = ctx.userStore.findById(request.user!.id);
      if (!user) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
        throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new ApiError(
          400,
          'INVALID_PASSWORD',
          `Body field "newPassword" must be at least ${MIN_PASSWORD_LENGTH} characters`,
        );
      }
      ctx.userStore.updatePassword(user.id, bcrypt.hashSync(newPassword, BCRYPT_ROUNDS));
      return reply.code(204).send();
    },
  );

  app.post('/api/auth/logout-all', { preHandler: app.authenticate }, async (request, reply) => {
    ctx.userStore.bumpTokenVersion(request.user!.id);
    void reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
