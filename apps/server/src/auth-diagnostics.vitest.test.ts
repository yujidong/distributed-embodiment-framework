/**
 * @vitest-environment node
 *
 * T-062: 401 diagnostics — every rejection carries a machine-readable
 * `error.reason` + teaching message + RFC 6750 WWW-Authenticate header, and
 * the two recurring LLM-agent copy artifacts (lowercase scheme, quoted
 * token) are accepted instead of silently read as anonymous.
 */

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTH_FAILURE_REASONS, AUTH_FAILURE_MESSAGES } from './auth/index.js';
import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('auth 401 diagnostics (T-062)', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const me = async (headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers });

  it('exposes every reason the middleware can emit with a teaching message', () => {
    for (const reason of AUTH_FAILURE_REASONS) {
      expect(typeof AUTH_FAILURE_MESSAGES[reason]).toBe('string');
      // teaching messages must say what to do next (re-login / header shape)
      expect(AUTH_FAILURE_MESSAGES[reason].length).toBeGreaterThan(20);
    }
  });

  it('reason=missing when no Authorization header and no cookie arrive', async () => {
    const res = await me();
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.reason).toBe('missing');
    expect(res.headers['www-authenticate']).toContain('invalid_request');
  });

  it('reason=bad_scheme when Authorization uses a non-Bearer scheme', async () => {
    const res = await me({ authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('bad_scheme');
    expect(res.headers['www-authenticate']).toContain('invalid_token');
  });

  it('reason=malformed on a tail-truncated token (R13 CB-F02: signature-length rule)', async () => {
    const user = await registerUser(ctx.app);
    const truncated = user.token.slice(0, Math.max(10, user.token.length - 8));
    const res = await me({ authorization: `Bearer ${truncated}` });
    expect(res.statusCode).toBe(401);
    // 3 segments survive the truncation, so fast-jwt reports
    // FAST_JWT_INVALID_SIGNATURE — but the signature segment is SHORTER than
    // HS256's 43 base64url chars, i.e. structurally truncated. R13 rule:
    // signature-LENGTH mismatch ⇒ malformed ("truncated in copy-paste"
    // teaching), never wrong_key (which blames server rotation).
    expect(res.json().error.reason).toBe('malformed');
  });

  it('truncation classification is deterministic at every cut point (payload or signature)', async () => {
    const user = await registerUser(ctx.app);
    // Cut inside the payload (IB's 40-char sighting) and inside the
    // signature (CB's sighting) — both must read as malformed now.
    for (const cut of [40, user.token.length - 8, user.token.length - 1]) {
      const res = await me({ authorization: `Bearer ${user.token.slice(0, cut)}` });
      expect(res.statusCode, `cut=${cut}`).toBe(401);
      expect(res.json().error.reason, `cut=${cut}`).toBe('malformed');
    }
  });

  it('reason=malformed on a structurally broken token (not 3 segments)', async () => {
    const res = await me({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('malformed');
  });

  it('reason=wrong_key only for a FULL-LENGTH signature that fails verification', async () => {
    // Self-contained wrong-key JWT: valid shape, full 43-char HS256-length
    // garbage signature — a length-matched signature failing verify is the
    // only shape that still means "signed by a different secret".
    const foreign = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: randomUUID(), email: 'x@example.com', tv: 0 })).toString('base64url'),
      'A'.repeat(43),
    ].join('.');
    const res = await me({ authorization: `Bearer ${foreign}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('wrong_key');
  });

  it('reason=expired on a validly signed but past-exp token', async () => {
    const user = await registerUser(ctx.app);
    // DevLoop R21 test-debt: an explicit past `exp` claim is signed
    // verbatim (jsonwebtoken keeps a payload-provided exp when no expiresIn
    // option is given) — the token is born expired; no 1.2s wall-clock wait
    // for a '1s' TTL to lapse.
    const expired = ctx.app.jwt.sign(
      { sub: user.id, email: user.email, tv: 0, exp: Math.floor(Date.now() / 1000) - 60 },
    );
    const res = await me({ authorization: `Bearer ${expired}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('expired');
  });

  it('reason=stale_version after logout-all bumps token_version', async () => {
    const user = await registerUser(ctx.app);
    const bump = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { authorization: `Bearer ${user.token}` } });
    expect(bump.statusCode).toBe(204);
    const res = await me({ authorization: `Bearer ${user.token}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('stale_version');
  });

  it('reason=unknown_user when the signing user no longer exists', async () => {
    const ghost = ctx.app.jwt.sign({ sub: randomUUID(), email: 'ghost@example.com', tv: 0 }, { expiresIn: '1h' });
    const res = await me({ authorization: `Bearer ${ghost}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.reason).toBe('unknown_user');
  });

  it('accepts a case-insensitive scheme keyword (RFC 6750) — the recurring agent artifact', async () => {
    const user = await registerUser(ctx.app);
    const res = await me({ authorization: `bearer ${user.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(user.email);
  });

  it('accepts a token wrapped in literal quotes (shell copy artifact)', async () => {
    const user = await registerUser(ctx.app);
    const res = await me({ authorization: `Bearer "${user.token}"` });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(user.email);
  });

  it('optionalAuth: no credential stays anonymous, a broken PRESENT credential 401s (R13 IB-F06)', async () => {
    // Anonymous read of a legacy/open route keeps working…
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(anon.statusCode).toBe(200);
    // …but a credential that IS present and broken no longer silently
    // downgrades to anonymous — that masked token diagnostics on every
    // public read (a truncated-token probe false-passed with 200).
    const broken = await ctx.app.inject({
      method: 'GET',
      url: '/api/scenarios',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(broken.statusCode).toBe(401);
    expect(broken.json().error.reason).toBe('malformed');
  });

  it('optionalAuth on a public environment: truncated token now 401s instead of false-passing 200 (R13 IB-F06)', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'PubOwner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Public Read', visibility: 'public', mapData: { zones: [{ id: 'z1' }] } },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id;

    // Anonymous read: 200 (public by design).
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    expect(anon.statusCode).toBe(200);

    // Truncated token: 401 with the reason — the auth test no longer
    // false-passes against a public read endpoint.
    const truncated = owner.token.slice(0, 40);
    const broken = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${truncated}` },
    });
    expect(broken.statusCode).toBe(401);
    expect(broken.json().error.reason).toBe('malformed');
    expect(broken.headers['www-authenticate']).toContain('invalid_token');
  });

  it('optionalAuth: a time-stale credential still downgrades to anonymous (stale cookie must not lock out public reads)', async () => {
    const owner = await registerUser(ctx.app, { displayName: 'StaleOwner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Stale Read', visibility: 'public', mapData: { zones: [{ id: 'z1' }] } },
    });
    const envId = created.json().id;
    // Born-expired token (R21 test-debt): payload-provided past `exp` —
    // deterministic, no wall-clock wait.
    const expired = ctx.app.jwt.sign(
      { sub: owner.id, email: owner.email, tv: 0, exp: Math.floor(Date.now() / 1000) - 60 },
    );
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().myRole).toBeNull();
  });
});
