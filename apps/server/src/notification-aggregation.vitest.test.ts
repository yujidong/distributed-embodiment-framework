/**
 * @vitest-environment node
 *
 * R68 — notification aggregation + retention governance.
 *
 * A collaboration storm used to insert one row per handshake (891 of 1031
 * rows were collaboration.accepted repeats; one admin inbox showed 448
 * unread). The contract now:
 *   - a same-key UNREAD row absorbs the repeat (repeat_count++, bubbles to
 *     the top, body refreshed) — the inbox shows ONE "×15" row
 *   - reading is the aggregation boundary: new activity after read starts
 *     a fresh row
 *   - rows without ref_id never merge (nothing to key on)
 *   - retention prunes read rows older than 30d and caps at 1000/user
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, importableScenario, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

describe('R68 notification aggregation', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    // notifications.env_id carries an FK — a real environment row is needed.
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/environments', headers: auth(owner.token),
      payload: { ...importableScenario('notif-agg'), visibility: 'public' },
    });
    envId = created.json().id as string;
  });
  afterEach(async () => { await ctx.cleanup(); });

  function fire(kind: string, refId: string, n: number): void {
    for (let i = 0; i < n; i += 1) {
      (ctx.app as any).notificationStore.create({
        userId: owner.id, envId, kind, title: `你的协作请求被接受 #${kind}`,
        refId,
      });
    }
  }

  it('same-key unread repeats merge into ONE row with repeatCount = N, newest title, bubbled to top', () => {
    fire('collaboration.accepted', 'ac-1', 15);
    const rows = (ctx.app as any).notificationStore.listForUser(owner.id, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeat_count).toBe(15);
    expect(rows[0]!.created_at).toBe(rows[0]!.created_at); // newest timestamp rides the merge
    // unread count counts ROWS (aggregated), not raw events
    expect((ctx.app as any).notificationStore.countUnread(owner.id)).toBe(1);
  });

  it('reading is the aggregation boundary — post-read activity opens a fresh row', async () => {
    fire('collaboration.accepted', 'ac-2', 3);
    await ctx.app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { authorization: `Bearer ${owner.token}` } });
    fire('collaboration.accepted', 'ac-2', 2);
    const rows = (ctx.app as any).notificationStore.listForUser(owner.id, {});
    const fresh = rows.filter(r => r.read_at === null);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.repeat_count).toBe(2);
    expect((ctx.app as any).notificationStore.countUnread(owner.id)).toBe(1);
  });

  it('distinct ref_ids (or no ref) never merge', () => {
    fire('collaboration.accepted', 'ac-a', 1);
    fire('collaboration.accepted', 'ac-b', 1);
    (ctx.app as any).notificationStore.create({ userId: owner.id, envId, kind: 'member.added', title: 'no ref' });
    expect((ctx.app as any).notificationStore.listForUser(owner.id, {})).toHaveLength(3);
  });

  it('retention prunes read rows beyond 30 days (best-effort)', () => {
    (ctx.app as any).notificationStore.create({ userId: owner.id, envId, kind: 'k.old', title: 'old read' });
    ctx.app.db
      .prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND kind = 'k.old'")
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), owner.id);
    fire('collaboration.accepted', 'ac-c', 1); // any create triggers pruneFor
    const kinds = (ctx.app as any).notificationStore.listForUser(owner.id, {}).map(r => r.kind);
    expect(kinds).not.toContain('k.old');
  });

  // -------------------------------------------------------------------------
  // T59 (R6, u1-F8/u2-F-3-1): the STREAMING verdict kinds aggregate per
  // (user, kind, ENV) — per-proposal refIds never merged, so a busy shared
  // environment stacked 65 unread auto_applied rows for one story.
  // -------------------------------------------------------------------------

  function fireVerdict(kind: string, n: number): void {
    for (let i = 0; i < n; i += 1) {
      (ctx.app as any).notificationStore.create({
        userId: owner.id,
        envId,
        kind,
        title: `你的提案已通过并应用 #${i}`,
        body: { proposalId: `prop-${kind}-${i}`, proposalKind: 'install-devices', status: 'applied' },
        refId: `proposals-applied:${envId}`,
      });
    }
  }

  it('T59: 5 same-env auto_applied verdicts → ONE row ×5 with the capped recent digest', () => {
    fireVerdict('proposal.auto_applied', 5);
    const rows = (ctx.app as any).notificationStore.listForUser(owner.id, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeat_count).toBe(5);
    const body = JSON.parse(rows[0]!.body_json);
    // The body keeps the LATEST full fields + a capped recent-proposals digest.
    expect(body.proposalId).toBe('prop-proposal.auto_applied-4'); // newest wins
    expect(body.recent).toHaveLength(5);
    expect(body.recent.map((item: { proposalId: string }) => item.proposalId)).toEqual([
      'prop-proposal.auto_applied-0',
      'prop-proposal.auto_applied-1',
      'prop-proposal.auto_applied-2',
      'prop-proposal.auto_applied-3',
      'prop-proposal.auto_applied-4',
    ]);
    expect(body.count).toBe(5);
    // ...and unread counts rows, not raw events.
    expect((ctx.app as any).notificationStore.countUnread(owner.id)).toBe(1);
  });

  it('T59: the recent digest is capped at 5 — the badge keeps the true count', () => {
    fireVerdict('proposal.applied', 9);
    const rows = (ctx.app as any).notificationStore.listForUser(owner.id, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repeat_count).toBe(9);
    const body = JSON.parse(rows[0]!.body_json);
    expect(body.recent).toHaveLength(5); // the cap
    expect(body.recent[4]!.proposalId).toBe('prop-proposal.applied-8'); // newest item present
    expect(body.count).toBe(9);
  });

  it('T59: read is still the boundary; kinds and envs stay isolated', async () => {
    fireVerdict('proposal.auto_applied', 2);
    await ctx.app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { authorization: `Bearer ${owner.token}` } });
    fireVerdict('proposal.auto_applied', 1);
    let rows = (ctx.app as any).notificationStore.listForUser(owner.id, {});
    expect(rows.filter((r: { read_at: null }) => r.read_at === null)).toHaveLength(1);
    expect(rows.find((r: { read_at: null }) => r.read_at === null)!.repeat_count).toBe(1);

    // A DIFFERENT env never merges into this env's row (same user+kind).
    const other = await ctx.app.inject({
      method: 'POST', url: '/api/environments', headers: auth(owner.token),
      payload: { ...importableScenario('notif-agg-2'), visibility: 'public' },
    });
    const otherEnvId = other.json().id as string;
    (ctx.app as any).notificationStore.create({
      userId: owner.id, envId: otherEnvId, kind: 'proposal.auto_applied',
      title: 'other env', body: { proposalId: 'prop-other' },
      refId: `proposals-applied:${otherEnvId}`,
    });
    rows = (ctx.app as any).notificationStore.listForUser(owner.id, {});
    expect(rows.filter((r: { env_id: string }) => r.env_id === otherEnvId)).toHaveLength(1);
    expect(rows.filter((r: { env_id: string }) => r.env_id === envId && r.read_at === null)).toHaveLength(1);

    // A per-object kind (reminded) is NOT env-aggregated — distinct refIds
    // stay distinct rows even within one env.
    (ctx.app as any).notificationStore.create({ userId: owner.id, envId, kind: 'proposal.reminded', title: 'r1', refId: 'p-1' });
    (ctx.app as any).notificationStore.create({ userId: owner.id, envId, kind: 'proposal.reminded', title: 'r2', refId: 'p-2' });
    rows = (ctx.app as any).notificationStore.listForUser(owner.id, { kind: 'proposal.reminded' });
    expect(rows).toHaveLength(2);
  });

  it('T59: listForUser filters by kind server-side (the --kind mute face)', () => {
    fireVerdict('proposal.auto_applied', 2);
    (ctx.app as any).notificationStore.create({ userId: owner.id, envId, kind: 'member.added', title: 'mixed' });
    const rows = (ctx.app as any).notificationStore.listForUser(owner.id, { kind: 'member.added' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('member.added');
    const empty = (ctx.app as any).notificationStore.listForUser(owner.id, { kind: 'collaboration.accepted' });
    expect(empty).toHaveLength(0);
  });
});
