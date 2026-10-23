/**
 * @vitest-environment node
 *
 * GET /api/admin/users — the operator account roster behind the invite-only
 * alpha (companion to the ADMIN_EMAILS-gated invite management API covered
 * in platform-invites.vitest.test.ts). Pins: anonymous 401, non-admin 403,
 * and the admin list shape (email/displayName/createdAt/isAdmin, newest
 * first, never any credential field).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, type TestAppContext } from './test-utils.js';

const ADMIN_EMAIL = 'admin@example.com';

function registerPayload(email: string, displayName = 'Tester') {
  return { email, password: 'super-secret', displayName };
}

async function registerAndLogin(ctx: TestAppContext, email: string, displayName?: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: registerPayload(email, displayName),
  });
  expect(res.statusCode).toBe(201);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: 'super-secret' },
  });
  expect(login.statusCode).toBe(200);
  return login.json().token as string;
}

describe('GET /api/admin/users', () => {
  let ctx: TestAppContext;
  beforeEach(async () => {
    // inviteOnly stays off (default) — registration is open, the roster gate
    // under test is ADMIN_EMAILS, not the invite code.
    ctx = await makeTestApp({ adminEmails: [ADMIN_EMAIL] });
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('rejects anonymous callers with 401 and non-admins with 403 FORBIDDEN', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(anon.statusCode).toBe(401);

    const memberToken = await registerAndLogin(ctx, 'member@example.com');
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: auth(memberToken),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');
  });

  it('returns every registered user with isAdmin derived from ADMIN_EMAILS', async () => {
    const adminToken = await registerAndLogin(ctx, ADMIN_EMAIL, 'Admin One');
    const memberToken = await registerAndLogin(ctx, 'member@example.com', 'Member Two');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const users = res.json().users as Array<Record<string, unknown>>;
    // The harness boots with a pre-seeded system account; assert on the two
    // users this test registered (newest first).
    const mine = users.filter(u =>
      ['member@example.com', ADMIN_EMAIL].includes(u.email as string),
    );
    expect(mine.map(u => u.email)).toEqual(['member@example.com', ADMIN_EMAIL]);

    const member = mine[0];
    expect(member.displayName).toBe('Member Two');
    expect(typeof member.createdAt).toBe('string');
    expect(member.isAdmin).toBe(false);
    const admin = mine[1];
    expect(admin.displayName).toBe('Admin One');
    expect(admin.isAdmin).toBe(true);
    // No credential material in the roster.
    for (const user of users) {
      expect(user).not.toHaveProperty('password_hash');
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('token_version');
    }
    expect(typeof memberToken).toBe('string');
  });
});
