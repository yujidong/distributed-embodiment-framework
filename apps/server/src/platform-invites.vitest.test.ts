/**
 * @vitest-environment node
 *
 * Platform invite gate (alpha capacity gating — EAF_INVITE_ONLY, schema v57).
 *
 * Covers: the registration gate in invite-only mode (missing/wrong/expired/
 * exhausted/revoked all rejected with localized teaching copy that never
 * echoes the code), the atomic used_count increment (two concurrent
 * registrations racing for the LAST use — exactly one wins), open mode
 * unaffected, the ADMIN_EMAILS-gated invite management API (non-admin 403,
 * anonymous 401), the bootstrap seed (invite-only boot with zero usable
 * invites mints a single-use code for the first ADMIN_EMAILS entry), and
 * failed validations counting against the /api/auth/* rate-limit bucket.
 *
 * Invite-only suites run on a FILE database so the test can seed/read
 * platform_invites rows directly (expired invites can't be created through
 * the admin API — expiresInDays has a 1-day floor).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, type TestAppContext } from './test-utils.js';

const ADMIN_EMAIL = 'admin@example.com';

interface InviteRow {
  code: string;
  max_uses: number;
  used_count: number;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** Test fixture: invite-only app on a temp FILE db + a raw handle on it. */
interface InviteFixture {
  ctx: TestAppContext;
  dir: string;
  db: Database.Database;
}

async function makeInviteOnlyApp(
  overrides: Record<string, unknown> = {},
): Promise<InviteFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'eaf-invite-test-'));
  const ctx = await makeTestApp({
    databasePath: join(dir, 'eaf.db'),
    inviteOnly: true,
    adminEmails: [ADMIN_EMAIL],
    ...overrides,
  });
  // better-sqlite3 WAL permits a second reader connection on the same file.
  const db = new Database(join(dir, 'eaf.db'), { readonly: true });
  return { ctx, dir, db };
}

/** Read-write handle (for planting expired invites past the API's 1-day floor). */
function rwHandle(fixture: InviteFixture): Database.Database {
  return new Database(join(fixture.dir, 'eaf.db'));
}

async function closeFixture(fixture: InviteFixture): Promise<void> {
  fixture.db.close();
  await fixture.ctx.cleanup();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function registerPayload(email: string, extra: Record<string, unknown> = {}) {
  return { email, password: 'super-secret', displayName: 'Tester', ...extra };
}

/** Register the admin using the bootstrap seed code read from the db. */
async function adminToken(fixture: InviteFixture): Promise<string> {
  const seed = fixture.db
    .prepare('SELECT code FROM platform_invites ORDER BY created_at ASC LIMIT 1')
    .get() as InviteRow | undefined;
  expect(seed, 'bootstrap seed invite should exist').toBeDefined();
  const res = await fixture.ctx.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: registerPayload(ADMIN_EMAIL, { inviteCode: seed!.code }),
  });
  expect(res.statusCode).toBe(201);
  const login = await fixture.ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: ADMIN_EMAIL, password: 'super-secret' },
  });
  expect(login.statusCode).toBe(200);
  return login.json().token as string;
}

describe('platform invite gate (EAF_INVITE_ONLY)', () => {
  let fixture: InviteFixture;
  beforeEach(async () => {
    fixture = await makeInviteOnlyApp();
  });
  afterEach(async () => {
    await closeFixture(fixture);
  });

  it('boot mints a single-use bootstrap invite for the first ADMIN_EMAILS entry', () => {
    const rows = fixture.db.prepare('SELECT * FROM platform_invites').all() as InviteRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBe(ADMIN_EMAIL);
    expect(rows[0].max_uses).toBe(1);
    expect(rows[0].used_count).toBe(0);
    expect(rows[0].code).toMatch(/^EAF-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // And the public health probe advertises the gate.
    return fixture.ctx.app
      .inject({ method: 'GET', url: '/api/health' })
      .then(res => {
        expect(res.json().auth).toEqual({ inviteOnly: true });
      });
  });

  it('rejects registration without a code (403 INVITE_REQUIRED, zh-CN default)', async () => {
    const res = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('nocode@example.com'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INVITE_REQUIRED');
    expect(res.json().error.message).toContain('邀请码');
  });

  it('localizes the rejection to en-US on Accept-Language', async () => {
    const res = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'accept-language': 'en-US,en;q=0.9' },
      payload: registerPayload('nocode@example.com'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('invite code');
    expect(res.json().error.message).not.toContain('邀请码');
  });

  it('rejects an unknown code (403 INVITE_INVALID) without echoing any part of it', async () => {
    const res = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('wrong@example.com', { inviteCode: 'EAF-AAAAA-BBBBB' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INVITE_INVALID');
    expect(res.json().error.message).not.toContain('AAAAA');
  });

  it('rejects an expired code with 410 INVITE_GONE', async () => {
    const token = await adminToken(fixture);
    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(token),
      payload: { maxUses: 5 },
    });
    expect(created.statusCode).toBe(201);
    const code = created.json().code as string;
    // Push expiry into the past (the API floor is 1 day — expiry itself is
    // the behavior under test, not the floor).
    const rw = rwHandle(fixture);
    rw.prepare("UPDATE platform_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code = ?")
      .run(code);
    rw.close();

    const res = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('expired@example.com', { inviteCode: code }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INVITE_GONE');
  });

  it('rejects a revoked code with 410 INVITE_GONE', async () => {
    const token = await adminToken(fixture);
    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(token),
      payload: {},
    });
    const code = created.json().code as string;
    const revoked = await fixture.ctx.app.inject({
      method: 'POST',
      url: `/api/admin/invites/${encodeURIComponent(code)}/revoke`,
      headers: auth(token),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).not.toBeNull();

    const res = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('revoked@example.com', { inviteCode: code }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('INVITE_GONE');
  });

  it('redeems a valid code exactly once per use; the exhausted code then reads INVALID', async () => {
    const token = await adminToken(fixture);
    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(token),
      payload: { maxUses: 1 },
    });
    const code = created.json().code as string;

    const ok = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('first@example.com', { inviteCode: code }),
    });
    expect(ok.statusCode).toBe(201);

    const spent = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('second@example.com', { inviteCode: code }),
    });
    expect(spent.statusCode).toBe(403);
    expect(spent.json().error.code).toBe('INVITE_INVALID');

    const row = fixture.db
      .prepare('SELECT used_count FROM platform_invites WHERE code = ?')
      .get(code) as InviteRow;
    expect(row.used_count).toBe(1);
  });

  it('two concurrent registrations racing for the LAST use: exactly one succeeds', async () => {
    const token = await adminToken(fixture);
    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(token),
      payload: { maxUses: 1 },
    });
    const code = created.json().code as string;

    const [a, b] = await Promise.all([
      fixture.ctx.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload('racer-a@example.com', { inviteCode: code }),
      }),
      fixture.ctx.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload('racer-b@example.com', { inviteCode: code }),
      }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([201, 403]);
    const row = fixture.db
      .prepare('SELECT used_count FROM platform_invites WHERE code = ?')
      .get(code) as InviteRow;
    expect(row.used_count).toBe(1);
  });

  it('duplicate-email is rejected BEFORE the gate redeems the code', async () => {
    const token = await adminToken(fixture);
    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(token),
      payload: { maxUses: 2 },
    });
    const code = created.json().code as string;
    const ok = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('dupe@example.com', { inviteCode: code }),
    });
    expect(ok.statusCode).toBe(201);
    const dupe = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('dupe@example.com', { inviteCode: code }),
    });
    // EMAIL_TAKEN precedes redemption — the second use must remain unspent.
    expect(dupe.statusCode).toBe(409);
    const row = fixture.db
      .prepare('SELECT used_count FROM platform_invites WHERE code = ?')
      .get(code) as InviteRow;
    expect(row.used_count).toBe(1);
  });

  it('invite management API: create/list/revoke are ADMIN_EMAILS-gated', async () => {
    const token = await adminToken(fixture);

    // Anonymous → 401; non-admin → 403 on every endpoint.
    const anon = await fixture.ctx.app.inject({ method: 'GET', url: '/api/admin/invites' });
    expect(anon.statusCode).toBe(401);

    // Register a second (non-admin) user with a fresh invite.
    const created = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(token),
      payload: { maxUses: 3, expiresInDays: 7 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ maxUses: 3, usedCount: 0, createdBy: ADMIN_EMAIL });
    expect(typeof created.json().expiresAt).toBe('string');

    const member = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: registerPayload('member@example.com', { inviteCode: created.json().code }),
    });
    expect(member.statusCode).toBe(201);
    const memberLogin = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'member@example.com', password: 'super-secret' },
    });
    const nonAdminToken = memberLogin.json().token as string;
    const forbidden = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/admin/invites',
      headers: auth(nonAdminToken),
    });
    expect(forbidden.statusCode).toBe(403);
    const forbiddenCreate = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: auth(nonAdminToken),
      payload: {},
    });
    expect(forbiddenCreate.statusCode).toBe(403);

    // Admin list carries usage statistics (bootstrap seed spent by adminToken
    // + the 3-use code with 1 use consumed by the member above).
    const list = await fixture.ctx.app.inject({
      method: 'GET',
      url: '/api/admin/invites',
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    const invites = list.json().invites as Array<{ code: string; usedCount: number; maxUses: number }>;
    expect(invites).toHaveLength(2);
    const multi = invites.find(i => i.maxUses === 3)!;
    expect(multi.usedCount).toBe(1);

    // Revoke of an unknown code → 404.
    const missing = await fixture.ctx.app.inject({
      method: 'POST',
      url: '/api/admin/invites/EAF-XXXXX-YYYYY/revoke',
      headers: auth(token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('failed invite validations count against the /api/auth/* rate-limit bucket', async () => {
    await closeFixture(fixture);
    fixture = await makeInviteOnlyApp({ rateLimitEnabled: true, rateLimitAuthPerMin: 3 });
    const attempt = () =>
      fixture.ctx.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload('brute@example.com', { inviteCode: 'EAF-GUESS-00000' }),
      });
    for (let i = 0; i < 3; i++) {
      expect((await attempt()).statusCode).toBe(403);
    }
    expect((await attempt()).statusCode).toBe(429);
  });
});

describe('registration without the invite gate (default dev posture)', () => {
  it('inviteOnly=false leaves registration open; /api/health advertises it', async () => {
    const ctx = await makeTestApp(); // default: inviteOnly=false (non-strict env)
    try {
      const health = await ctx.app.inject({ method: 'GET', url: '/api/health' });
      expect(health.json().auth).toEqual({ inviteOnly: false });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload('open@example.com'),
      });
      expect(res.statusCode).toBe(201);
      // A stray inviteCode field is ignored when the gate is off.
      const res2 = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: registerPayload('open2@example.com', { inviteCode: 'EAF-AAAAA-BBBBB' }),
      });
      expect(res2.statusCode).toBe(201);
    } finally {
      await ctx.cleanup();
    }
  });
});
