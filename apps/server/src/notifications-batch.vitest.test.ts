/**
 * @vitest-environment node
 *
 * T59 (R6, u1-F8/u2-F-3-1) — applied-class notices aggregate per
 * (recipient, kind, ENV), superseding the T39 wall-clock bucket coalescer
 * (R4's retest clause: under real collaboration cadence the 2s bucket
 * degenerated into one row per proposal — u2 saw 9 applied rows in 12
 * minutes, u1's inbox held 65 unread auto_applied rows).
 *
 * The contract now:
 *  - every applied-class notice of one environment merges into ONE row
 *    (repeat_count = the ×N badge, latest title/body win);
 *  - the body keeps the LATEST full fields plus a capped `recent` digest
 *    (last AGGREGATED_ITEM_CAP proposal items — "改了哪个 agent 的什么" is
 *    still answerable; the full audit stays in the activity feed);
 *  - reading is the aggregation boundary; recipients are isolated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { notify, proposalObjectSummary } from './notifications.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('T59 (R6): applied-class notices aggregate per (recipient, kind, env)', () => {
  let ctx: TestAppContext;
  let author: TestUser;
  let other: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    author = await registerUser(ctx.app, { displayName: 'Builder' });
    other = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(author.token),
      payload: {
        version: '1.0',
        meta: { id: 'batch-lab', name: 'Batch Lab' },
        zones: [{ id: 'zone-a', adjacentZoneIds: [] as string[] }],
        devices: [],
        agents: [],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function appliedNotice(index: number) {
    return notify(ctx.app.notificationStore, {
      recipientId: author.id,
      actorId: other.id,
      envId,
      kind: 'proposal.applied',
      title: '你的提案已通过并应用',
      allowSelf: true,
      body: {
        proposalId: `prop-${index}`,
        proposalKind: 'install-devices',
        status: 'applied',
        summary: `安装设备 烟感-${index}`,
      },
      refId: `proposals-applied:${envId}`,
    });
  }

  function appliedRows(): Array<{ title: string; repeatCount: number; body: Record<string, unknown> }> {
    return ctx.app.notificationStore.listForUser(author.id, { limit: 100 })
      .filter(row => row.kind === 'proposal.applied')
      .map(row => ({
        title: row.title,
        repeatCount: row.repeat_count,
        body: JSON.parse(row.body_json) as Record<string, unknown>,
      }));
  }

  it('N applies merge into ONE row: ×N badge, latest body wins, capped recent digest accumulates', () => {
    appliedNotice(1);
    appliedNotice(2);
    appliedNotice(3);

    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].repeatCount).toBe(3);
    const body = rows[0].body;
    expect(body.count).toBe(3);
    expect(body.proposalId).toBe('prop-3'); // the latest full fields win
    expect(body.status).toBe('applied');
    const recent = body.recent as Array<{ proposalId: string; summary?: string }>;
    expect(recent.map(item => item.proposalId)).toEqual(['prop-1', 'prop-2', 'prop-3']);
    expect(recent[2].summary).toBe('安装设备 烟感-3');
  });

  it('a single apply keeps the ordinary one-row one-item shape', () => {
    appliedNotice(1);
    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].repeatCount).toBe(1);
    expect((rows[0].body.recent as unknown[])).toHaveLength(1);
  });

  it('the recent digest is capped (AGGREGATED_ITEM_CAP) — the badge keeps the true count', () => {
    for (let i = 1; i <= 8; i += 1) appliedNotice(i);
    const rows = appliedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].repeatCount).toBe(8);
    const recent = rows[0].body.recent as Array<{ proposalId: string }>;
    expect(recent).toHaveLength(5); // AGGREGATED_ITEM_CAP
    expect(recent[4].proposalId).toBe('prop-8'); // the NEWEST item survives the cap
    expect(rows[0].body.count).toBe(8);
  });

  it('recipients are isolated: another user’s notices never merge into mine', () => {
    appliedNotice(1);
    notify(ctx.app.notificationStore, {
      recipientId: other.id,
      actorId: author.id,
      envId,
      kind: 'proposal.applied',
      title: 'x',
      allowSelf: true,
      body: { proposalId: 'prop-other', proposalKind: 'modify-object', status: 'applied' },
      refId: `proposals-applied:${envId}`,
    });
    expect(appliedRows()).toHaveLength(1);
    expect(((appliedRows()[0].body.recent as Array<{ proposalId: string }>))[0].proposalId)
      .toBe('prop-1');
  });

  it('proposalObjectSummary names the objects (u3: “改了哪个 agent 的什么”); unknown payloads stay undefined', () => {
    expect(proposalObjectSummary('install-devices', {
      devices: [{ name: '烟感-A1', type: 'smoke-detector' }, { name: '音柱-B2' }],
    })).toBe('安装设备 烟感-A1、音柱-B2');
    expect(proposalObjectSummary('install-devices', {
      devices: Array.from({ length: 5 }, (_, i) => ({ name: `dev-${i}` })),
    })).toBe('安装设备 dev-0、dev-1、dev-2 等');
    expect(proposalObjectSummary('install-agents', { agents: ['walter-1'] })).toBe('安装 Agent walter-1');
    expect(proposalObjectSummary('unknown-kind', { anything: 1 })).toBeUndefined();
  });
});
