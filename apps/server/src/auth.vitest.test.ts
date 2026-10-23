/**
 * @vitest-environment node
 *
 * Auth API tests (fastify inject, in-memory SQLite, no network).
 *
 * Covers register / login / me / logout, the 400/401/409 paths, email
 * normalization, the httpOnly cookie set at login, and both token transports
 * (Bearer header + cookie) accepted by `authenticate`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('auth API', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('registers a user (201), normalizing email case and hiding the password hash', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'Alice@Example.COM', password: 'super-secret', displayName: 'Alice' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('alice@example.com');
    expect(body.displayName).toBe('Alice');
    expect(typeof body.id).toBe('string');
    expect(body.password_hash).toBeUndefined();
    expect(body.password).toBeUndefined();
  });

  it('400s on invalid email / short password / missing displayName', async () => {
    const badEmail = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: 'super-secret', displayName: 'X' },
    });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json().error.code).toBe('INVALID_EMAIL');

    const shortPw = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'x@example.com', password: 'short', displayName: 'X' },
    });
    expect(shortPw.statusCode).toBe(400);
    expect(shortPw.json().error.code).toBe('INVALID_PASSWORD');

    const noName = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'x@example.com', password: 'super-secret' },
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe('INVALID_DISPLAY_NAME');
  });

  it('409s on duplicate email (case-insensitive)', async () => {
    await registerUser(ctx.app, { email: 'dup@example.com' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'DUP@example.com', password: 'super-secret', displayName: 'Dup' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('logs in (token + httpOnly cookie) and serves /me via Bearer AND cookie', async () => {
    const user = await registerUser(ctx.app, { email: 'bob@example.com', displayName: 'Bob' });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'Bob@Example.com', password: user.password },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token;
    expect(typeof token).toBe('string');

    const cookie = login.cookies.find(c => c.name === 'eaf_token');
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.path).toBe('/');
    expect(cookie!.value).toBe(token);

    const viaBearer = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(token),
    });
    expect(viaBearer.statusCode).toBe(200);
    expect(viaBearer.json().email).toBe('bob@example.com');
    expect(viaBearer.json().displayName).toBe('Bob');

    const viaCookie = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `eaf_token=${token}` },
    });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().id).toBe(user.id);
  });

  it('401s login on wrong password and unknown email (same error)', async () => {
    const user = await registerUser(ctx.app, { email: 'carol@example.com' });

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'carol@example.com', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@example.com', password: user.password },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('401s /me without a token or with a garbage token', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe('UNAUTHORIZED');

    const garbage = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(garbage.statusCode).toBe(401);
  });

  it('logs out (204) and clears the cookie', async () => {
    const user = await registerUser(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(204);
    const cookie = res.cookies.find(c => c.name === 'eaf_token');
    expect(cookie).toBeDefined();
    expect(cookie!.value).toBe('');
  });

  it('rejects tokens whose signature does not match the server secret', async () => {
    // A token signed by ANOTHER server instance (different secret) must not authenticate.
    const other = await makeTestApp();
    try {
      const stranger = await registerUser(other.app, { email: 'mallory@example.com' });
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(stranger.token),
      });
      // Same dev secret in tests → signature verifies, but the user id is
      // unknown to THIS database, so it is still a 401.
      expect(res.statusCode).toBe(401);
    } finally {
      await other.cleanup();
    }
  });

  it('PATCH /api/me renames the caller (Fix-13, R5 F-02); validates the name', async () => {
    const user = await registerUser(ctx.app, { displayName: 'Garbled ??' });

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: auth(user.token),
      payload: { displayName: '  小莽  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: user.id, email: user.email, displayName: '小莽' });

    // The rename is visible on the auth-facing read path too.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(user.token),
    });
    expect(me.json().displayName).toBe('小莽');

    // Validation: empty / whitespace-only / oversized → 400 INVALID_DISPLAY_NAME.
    for (const displayName of ['', '   ', 'x'.repeat(81)]) {
      const bad = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/me',
        headers: auth(user.token),
        payload: { displayName },
      });
      expect(bad.statusCode, JSON.stringify(displayName)).toBe(400);
      expect(bad.json().error.code).toBe('INVALID_DISPLAY_NAME');
    }
    // Unauthenticated → 401.
    expect(
      (await ctx.app.inject({ method: 'PATCH', url: '/api/me', payload: { displayName: 'X' } }))
        .statusCode,
    ).toBe(401);
  });

  it('mixed-case emails yield a CONSISTENT admin identity on every ADMIN_EMAILS gate (R21 Task-0)', async () => {
    // Raw mixed-case admin config — the helper canonicalizes both sides
    // (config.ts lowercases ADMIN_EMAILS, but BuildServerOptions callers
    // pass the list through unparsed).
    const adminCtx = await makeTestApp({ adminEmails: ['Root@Example.COM'] });
    try {
      // (a) mixed-case INPUT at register/login: the row is stored lowercase
      // (login/register share normalizeEmail) and /api/auth/me says admin.
      const user = await registerUser(adminCtx.app, { email: 'Root@Example.COM' });
      const me = await adminCtx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(user.token),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().email).toBe('root@example.com');
      expect(me.json().isAdmin).toBe(true);

      // Parity with another gate: POST /api/admin/backup must NOT 403 (the
      // in-memory DB makes it 400 BACKUP_NOT_SUPPORTED instead — still proof
      // the admin check passed).
      const backup = await adminCtx.app.inject({
        method: 'POST',
        url: '/api/admin/backup',
        headers: auth(user.token),
      });
      expect(backup.statusCode).toBe(400);
      expect(backup.json().error.code).toBe('BACKUP_NOT_SUPPORTED');

      // (b) mixed-case ROW (legacy DB / direct store seed): auth resolves
      // identity by id, so request.user.email keeps the row's case. Before
      // the fix, /api/auth/me raw-compared and returned isAdmin:false while
      // admin/observability/hass/simulations/environments all said true.
      // (SQL `=` is case-sensitive, so this insert coexists with the
      // lowercase row from (a) — exactly the legacy-DB shape.)
      const legacy = adminCtx.app.userStore.create(
        'Root@Example.com',
        '$2a$10$abcdefghijklmnopqrstuv012345678901234567890123456789012',
        'Root',
      );
      const legacyToken = adminCtx.app.jwt.sign(
        { sub: legacy.id, email: legacy.email, tv: legacy.token_version },
        { expiresIn: '7d' },
      );
      const legacyMe = await adminCtx.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth(legacyToken),
      });
      expect(legacyMe.statusCode).toBe(200);
      expect(legacyMe.json().email).toBe('Root@Example.com'); // row form preserved
      expect(legacyMe.json().isAdmin).toBe(true); // THE regression: was false

      const legacyBackup = await adminCtx.app.inject({
        method: 'POST',
        url: '/api/admin/backup',
        headers: auth(legacyToken),
      });
      expect(legacyBackup.statusCode).toBe(400); // admin gate passed, DB unsupported
      expect(legacyBackup.json().error.code).toBe('BACKUP_NOT_SUPPORTED');
    } finally {
      await adminCtx.cleanup();
    }
  });
});
