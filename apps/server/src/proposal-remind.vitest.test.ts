/**
 * @vitest-environment node
 *
 * R33 (DevLoop, Care F2) — the escalated-proposal remind lane.
 *
 * The CareServices finding: 4 install proposals in a supervised zone sat
 * `escalated` for the whole session (~22 min) — no expiry, no remind lane
 * (agreements had one, the lane that most needs it did not), and every
 * downstream capability (agent binding, flows, services) died with them.
 * POST /api/proposals/:id/remind mirrors the agreement remind (T-309):
 * author-only, escalated-only, one notification to the DECIDER, 10-minute
 * window anchored at proposal creation or the last reminder (C6/T-088
 * anchor naming), and the nudge carries the escalateReason visibility note
 * (the supervised-zone consent gate) + the decide replyHint.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('R33 proposal remind (Care F2)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let other: TestUser;
  let envId: string;
  let proposalId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Facility Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Care Builder' });
    other = await registerUser(ctx.app, { displayName: 'Another Builder' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Care Center',
        visibility: 'public',
        mapData: { zones: [{ id: 'care-center', consentClass: 'supervised' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    for (const user of [builder, other]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
    }

    // The supervised-zone install: escalates to the owner (the gate itself
    // is consent-zones' contract; here it is the remind lane's setup).
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-devices',
        payload: { devices: [{ name: 'Vitals Sensor Bed-1', type: 'sensor', capabilities: ['heart-monitor'], zoneId: 'care-center' }] },
      },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe('escalated');
    proposalId = submitted.json().id as string;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function remind(token: string, id = proposalId) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${id}/remind`,
      headers: auth(token),
      payload: {},
    });
  }

  it('the author can nudge the deciding owner: one notification with the consent-gate reason + decide hint', async () => {
    // Age past the 10-minute window so the first remind is deliverable.
    ctx.app.db
      .prepare('UPDATE proposals SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), proposalId);

    const res = await remind(builder.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proposalId, status: 'escalated', reminded: true });

    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    const remindedRows = (inbox.json().notifications as Array<{
      kind: string; refId: string; body: Record<string, unknown>;
    }>).filter(n => n.kind === 'proposal.reminded');
    expect(remindedRows).toHaveLength(1);
    expect(remindedRows[0].refId).toBe(proposalId);
    // Care F2's visibility note: the nudge names WHY it waits (the
    // supervised consent gate) and the decider's move.
    expect(String(remindedRows[0].body.escalateReason)).toContain('supervised');
    expect(remindedRows[0].body.replyHint).toMatchObject({
      endpoint: `POST /api/proposals/${proposalId}/decide`,
      yourMove: true,
    });
  });

  it('author-only and escalated-only, with teaching errors', async () => {
    ctx.app.db
      .prepare('UPDATE proposals SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), proposalId);

    const asOwner = await remind(owner.token);
    expect(asOwner.statusCode).toBe(403);
    expect(asOwner.json().error.message).toContain('Only the proposal author may remind');

    const asOther = await remind(other.token);
    expect(asOther.statusCode).toBe(403);

    // Decided by the owner → no longer remindable (409, not a silent 200).
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'rejected' },
    });
    expect(decided.statusCode).toBe(200);
    const afterDecision = await remind(builder.token);
    expect(afterDecision.statusCode).toBe(409);
    expect(afterDecision.json().error.code).toBe('PROPOSAL_NOT_ESCALATED');
  });

  it('rate-limited: the window anchors at proposal CREATION, then at the last reminder (C6/T-088 anchor naming)', async () => {
    // First-ever remind inside the window names its real anchor.
    const fresh = await remind(builder.token);
    expect(fresh.statusCode).toBe(429);
    expect(fresh.json().error.code).toBe('REMIND_RATE_LIMITED');
    expect(fresh.json().error.message).toContain('no reminder has been sent yet');
    expect(fresh.json().error.message).toContain('PROPOSAL CREATION');
    expect(typeof fresh.json().error.retryAfterSec).toBe('number');
    expect(typeof fresh.json().error.earliestAt).toBe('string');
    expect(typeof fresh.json().error.anchoredAt).toBe('string');

    // Aged past the window → deliverable; the NEXT remind re-anchors at the
    // reminder (not creation) and states the exact earliest next time.
    ctx.app.db
      .prepare('UPDATE proposals SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), proposalId);
    const remindedAt = Date.now();
    const first = await remind(builder.token);
    expect(first.statusCode).toBe(200);
    expect(first.json().reminded).toBe(true);

    const second = await remind(builder.token);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.message).toContain('a reminder was already sent recently');
    const earliestMs = Date.parse(second.json().error.earliestAt as string);
    expect(earliestMs).toBeGreaterThanOrEqual(remindedAt + 10 * 60 * 1000 - 1500);
    expect(earliestMs).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1500);
  });
});
