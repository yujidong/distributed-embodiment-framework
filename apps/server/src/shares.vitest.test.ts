/**
 * @vitest-environment node
 *
 * Replay share routes (R15-B1): anonymous read-only replay links.
 * Visibility boundary mirrors the anonymous env-detail rule — only public
 * environments can be shared; private envs are rejected outright. Shares
 * are frozen snapshots: readable anonymously until expiry, gone after.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from './db/database.js';
import { ReplayShareStore } from './db/replay-share-store.js';
import { auth, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

/** Minimal two-zone public/private environment created by a fresh user. */
async function createEnv(
  ctx: TestAppContext,
  token: string,
  visibility: 'public' | 'private',
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/environments',
    headers: auth(token),
    payload: {
      version: '1.0',
      meta: { id: `share-env-${visibility}`, name: `Share ${visibility}`, description: 'd' },
      visibility,
      zones: [{ id: 'zone-a' }],
      devices: [],
      agents: [],
      events: [],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe('replay shares (R15-B1)', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('creates a share of a public env and serves it anonymously', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date().toISOString();

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
      payload: { from, to, name: 'Demo Run', description: 'campus demo' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.shareId).toBeTruthy();
    expect(body.sharePath).toBe(`/share/${body.shareId}`);
    expect(body.report).toBeDefined();

    // The whole point: NO auth header.
    const viewed = await ctx.app.inject({ method: 'GET', url: `/api/shares/${body.shareId}` });
    expect(viewed.statusCode).toBe(200);
    const share = viewed.json();
    expect(share.name).toBe('Demo Run');
    expect(share.envName).toBe('Share public');
    expect(share.scenario.meta).toBeDefined();
    expect(Array.isArray(share.scenario.events)).toBe(true);
  });

  it('rejects sharing a private environment (visibility boundary)', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'private');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
      payload: { from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ENV_NOT_PUBLIC');
  });

  it('requires auth and env read access', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    const window = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date().toISOString() };

    const anon = await ctx.app.inject({
      method: 'POST', url: `/api/environments/${envId}/replay-shares`, payload: window,
    });
    expect(anon.statusCode).toBe(401);

    const stranger = await registerUser(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(stranger.token),
      payload: window,
    });
    // Public env: any logged-in user has read access → share allowed.
    expect(res.statusCode).toBe(201);
  });

  it('unknown share ids are 404; expired shares vanish (store-level)', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/shares/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SHARE_NOT_FOUND');

    // Expiry is enforced (and pruned) by the store on read.
    const db = openDatabase(':memory:');
    try {
      const store = new ReplayShareStore(db);
      const share = store.create({
        environmentId: 'env1',
        environmentName: 'E',
        name: 'n',
        description: '',
        scenarioJson: '{"meta":{}}',
        eventCount: 0,
        createdBy: 'u1',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // already past
      });
      expect(store.get(share.id)).toBeUndefined();
      // Pruned, not just hidden.
      expect(store.listForEnv('env1')).toHaveLength(0);
    } finally {
      // Leaked native SQLite handles can access-violate (0xC0000005) at
      // worker-thread teardown.
      db.close();
    }
  });

  it('validates expiresInDays bounds', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    for (const bad of [0, -1, 366, 1.5, 'seven']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/replay-shares`,
        headers: auth(owner.token),
        payload: {
          from: new Date(Date.now() - 60_000).toISOString(),
          to: new Date().toISOString(),
          expiresInDays: bad,
        },
      });
      expect(res.statusCode, `expiresInDays=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('T-107: a typo\'d body key is 400 with a rename hint, not silently defaulted', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');

    const typo = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date().toISOString(),
        expiresInDay: 1,
      },
    });
    expect(typo.statusCode).toBe(400);
    const message = typo.json().error.message as string;
    expect(message).toContain('expiresInDay');
    expect(message).toContain('expiresInDays');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date().toISOString(),
        ttl: 5,
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toContain('"ttl"');
  });

  it('T-107: all legal keys still mint correctly (custom expiry honored)', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date().toISOString(),
        name: 'Named',
        description: 'described',
        expiresInDays: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    const { shareId, expiresAt } = res.json();
    // 1 day, not the 30-day default the old silent drop would have minted.
    const deltaDays = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(deltaDays).toBeLessThan(1.1);
    expect(deltaDays).toBeGreaterThan(0.9);

    const viewed = await ctx.app.inject({ method: 'GET', url: `/api/shares/${shareId}` });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json().name).toBe('Named');
  });
});

describe('replay-share lifecycle (T-108)', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function mintShare(envId: string, token: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date().toISOString(),
        name: 'Lifecycle',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().shareId as string;
  }

  it('owner lists shares; strangers cannot list or revoke', async () => {
    const owner = await registerUser(ctx.app);
    const stranger = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    const shareId = await mintShare(envId, stranger.token);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
    });
    expect(listed.statusCode).toBe(200);
    const shares = listed.json().shares as Array<{ id: string }>;
    expect(shares.map(s => s.id)).toContain(shareId);

    const strangerList = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(stranger.token),
    });
    expect(strangerList.statusCode).toBe(403);

    const strangerRevoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/replay-shares/${shareId}`,
      headers: auth(stranger.token),
    });
    expect(strangerRevoke.statusCode).toBe(403);
    // Not revoked: still anonymously readable.
    expect((await ctx.app.inject({ method: 'GET', url: `/api/shares/${shareId}` })).statusCode).toBe(200);
  });

  it('owner revocation tombstones the link (410, removed from list)', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    const shareId = await mintShare(envId, owner.token);

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/replay-shares/${shareId}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    const viewed = await ctx.app.inject({ method: 'GET', url: `/api/shares/${shareId}` });
    expect(viewed.statusCode).toBe(410);
    expect(viewed.json().error.code).toBe('SHARE_REVOKED');

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/replay-shares`,
      headers: auth(owner.token),
    });
    expect(listed.json().shares).toHaveLength(0);

    // Revoking again: nothing live left → 404.
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/replay-shares/${shareId}`,
      headers: auth(owner.token),
    });
    expect(again.statusCode).toBe(404);
  });

  it('the env owner is notified when a stranger mints a share', async () => {
    const owner = await registerUser(ctx.app);
    const stranger = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    const shareId = await mintShare(envId, stranger.token);

    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    expect(inbox.statusCode).toBe(200);
    const notifications = inbox.json().notifications as Array<{ kind: string; refId: string }>;
    const minted = notifications.find(n => n.kind === 'share.created');
    expect(minted?.refId).toBe(shareId);
  });

  it('mint and revoke are audited in the command log', async () => {
    const owner = await registerUser(ctx.app);
    const envId = await createEnv(ctx, owner.token, 'public');
    const shareId = await mintShare(envId, owner.token);

    const kinds = () =>
      (ctx.app.commandLogStore.listForEnv(envId) as Array<{ kind: string; payload_json: string }>)
        .filter(row => row.kind.startsWith('share-'))
        .map(row => ({ kind: row.kind, payload: JSON.parse(row.payload_json) }));
    expect(kinds().map(k => k.kind)).toEqual(['share-create']);
    expect(kinds()[0].payload.shareId).toBe(shareId);

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/replay-shares/${shareId}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);
    // listForEnv is newest-first.
    expect(kinds().map(k => k.kind)).toEqual(['share-revoke', 'share-create']);
  });
});
