/**
 * @vitest-environment node
 *
 * Auth hardening tests (P4-4):
 * - POST /api/auth/change-password — wrong current password 400
 *   INVALID_CURRENT_PASSWORD, weak new password 400 INVALID_PASSWORD, success
 *   204 (login with old fails, new works). Documented choice: the change
 *   does NOT invalidate existing tokens (JWTs are stateless; logout-all is
 *   the "sign out everywhere" lever).
 * - POST /api/auth/logout-all — bumps users.token_version; every token
 *   issued before the call (including the caller's) then 401s via the `tv`
 *   claim check; fresh logins work.
 * - GET /api/auth/me — carries `isAdmin` (ADMIN_EMAILS membership).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('auth hardening (P4-4)', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp({ adminEmails: ['admin@example.com'] });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const changePassword = (token: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: auth(token),
      payload,
    });

  describe('change-password', () => {
    it('400 INVALID_CURRENT_PASSWORD when the current password is wrong', async () => {
      const user = await registerUser(ctx.app);
      const res = await changePassword(user.token, {
        currentPassword: 'not-the-password',
        newPassword: 'new-password-456',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CURRENT_PASSWORD');
    });

    it('400 INVALID_PASSWORD when the new password is weak', async () => {
      const user = await registerUser(ctx.app);
      const res = await changePassword(user.token, {
        currentPassword: user.password,
        newPassword: 'short',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PASSWORD');
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: { currentPassword: 'x', newPassword: 'y' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('success: old password stops working, new one logs in; existing token keeps working', async () => {
      const user = await registerUser(ctx.app);
      const res = await changePassword(user.token, {
        currentPassword: user.password,
        newPassword: 'new-password-456',
      });
      expect(res.statusCode).toBe(204);

      const oldLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: user.password },
      });
      expect(oldLogin.statusCode).toBe(401);

      const newLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: 'new-password-456' },
      });
      expect(newLogin.statusCode).toBe(200);

      // Documented choice: changing the password does NOT rotate
      // token_version, so tokens issued before the change stay valid until
      // expiry or an explicit logout-all.
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(user.token),
      });
      expect(me.statusCode).toBe(200);
    });
  });

  describe('logout-all', () => {
    it('invalidates every token issued before the call (including the caller\'s)', async () => {
      const user = await registerUser(ctx.app);
      // A second session for the same account.
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: user.password },
      });
      const secondToken = second.json().token as string;

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/logout-all',
        headers: auth(user.token),
      });
      expect(res.statusCode).toBe(204);

      for (const token of [user.token, secondToken]) {
        const me = await ctx.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: auth(token),
        });
        expect(me.statusCode).toBe(401);
      }

      // Re-login issues a token at the new version, which authenticates.
      const relogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: user.email, password: user.password },
      });
      expect(relogin.statusCode).toBe(200);
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(relogin.json().token),
      });
      expect(me.statusCode).toBe(200);
    });

    it('requires authentication', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout-all' });
      expect(res.statusCode).toBe(401);
    });

    it('a token minted without a tv claim (pre-P4-4 shape) no longer authenticates', async () => {
      const user = await registerUser(ctx.app);
      // Forge a legacy-shaped token with the server's own (dev-default) secret.
      const legacyToken = ctx.app.jwt.sign({ sub: user.id, email: user.email });
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(legacyToken),
      });
      expect(me.statusCode).toBe(401);
    });
  });

  describe('GET /api/auth/me isAdmin', () => {
    it('is true for ADMIN_EMAILS members and false otherwise', async () => {
      const admin = await registerUser(ctx.app, { email: 'ADMIN@example.com' });
      const plain = await registerUser(ctx.app, { email: 'plain@example.com' });

      const adminMe = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(admin.token),
      });
      expect(adminMe.json().isAdmin).toBe(true);

      const plainMe = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(plain.token),
      });
      expect(plainMe.json().isAdmin).toBe(false);
    });
  });
});
