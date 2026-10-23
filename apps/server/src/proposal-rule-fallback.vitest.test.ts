/**
 * @vitest-environment node
 *
 * Fix-45d: the no-LLM fallback reviewer (EscalatingReviewer) mirrors the
 * Fix-12 timeout policy instead of escalate-everything.
 *
 * E2E background (B-agent P2-1, 2026-08-15): on an LLM-less server every
 * proposal escalated with reason "AI semantic review is not implemented yet
 * (P-A)" labeled source 'ai' — the R4 "低风险秒批" experience vanished and a
 * stub decision wore the AI badge. Governance suites default the policy OFF
 * (test-utils) to test the owner-decide lifecycle; THIS suite opts back in
 * and pins the production default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';
import { EscalatingReviewer } from './proposal-reviewer.js';

describe('Fix-45d: no-LLM reviewer follows the timeout auto-approve policy', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };
  let builder: { id: string; token: string };
  let envId: string;

  beforeEach(async () => {
    // Production default: auto-approve low-risk when no reviewer is available.
    ctx = await makeTestApp({ proposalReviewTimeoutAutoApprove: true });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'RuleFallback Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: { authorization: `Bearer ${builder.token}` },
    });
    expect(joined.statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('a low-risk install-devices proposal auto-applies with source rule-fallback (not ai)', async () => {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: { authorization: `Bearer ${builder.token}` },
      payload: { name: 'Cool Lamp', type: 'light', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });
    // Builder device-creates convert to install-devices proposals (Fix-1).
    expect([201, 202]).toContain(proposed.statusCode);
    const proposal = proposed.json().proposal ?? proposed.json();
    expect(proposal.status).toBe('applied');
    expect(proposal.aiReview.source).toBe('rule-fallback');
    expect(proposal.aiReview.reason).not.toContain('not implemented');
    // The device actually landed.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect((detail.json().devices as Array<{ name: string }>).some(d => d.name === 'Cool Lamp')).toBe(true);
  });

  it('T-004: a rule-fallback auto-apply pings the env owner (proposal.auto_applied)', async () => {
    // The gap (Explorer R2): a builder's low-risk proposal auto-applies via
    // the rule-fallback reviewer and the owner's world changes with NO
    // notification — they never learn a device appeared.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: { authorization: `Bearer ${builder.token}` },
      payload: { name: 'Quiet Lamp', type: 'light', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });
    const proposal = proposed.json().proposal ?? proposed.json();
    expect(proposal.status).toBe('applied');
    expect(proposal.aiReview.source).toBe('rule-fallback');

    const ownerInbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(ownerInbox.statusCode).toBe(200);
    const notifications = ownerInbox.json().notifications as Array<{
      kind: string;
      refId: string | null;
      body: Record<string, unknown>;
      title: string;
    }>;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].kind).toBe('proposal.auto_applied');
    // T59: env-aggregated family key (per-proposal detail stays in the body).
    expect(notifications[0].refId).toBe(`proposals-applied:${envId}`);
    expect(notifications[0].body).toMatchObject({
      proposalId: proposal.id,
      proposalKind: 'install-devices',
      status: 'applied',
      authorId: builder.id,
    });

    // The author's side is unchanged (their own proposal.applied row) and
    // the owner may acknowledge the auto-apply like any notification.
    const builderInbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${builder.token}` },
    });
    expect((builderInbox.json().notifications as Array<{ kind: string }>).map(n => n.kind))
      .toEqual(['proposal.applied']);

    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/notifications/${notifications[0].id}/read`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().readAt).not.toBeNull();
  });

  it("policy OFF restores the pure-escalate funnel with an honest source", async () => {
    const off = await makeTestApp({ proposalReviewTimeoutAutoApprove: false });
    try {
      const o = await registerUser(off.app);
      const b = await registerUser(off.app, { displayName: 'B2' });
      const created = await off.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${o.token}` },
        payload: { name: 'Escalate Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
      });
      await off.app.inject({
        method: 'POST',
        url: `/api/environments/${created.json().id}/join`,
        headers: { authorization: `Bearer ${b.token}` },
      });
      const proposed = await off.app.inject({
        method: 'POST',
        url: `/api/environments/${created.json().id}/devices`,
        headers: { authorization: `Bearer ${b.token}` },
        payload: { name: 'Lamp', type: 'light', capabilities: ['turn-on'], zoneId: 'zone-a' },
      });
      const proposal = proposed.json().proposal ?? proposed.json();
      expect(proposal.status).toBe('escalated');
      expect(proposal.aiReview.source).toBe('rule-fallback');
      expect(proposal.aiReview.reason).toContain('未配置 LLM'); // T-063(e): localized
    } finally {
      await off.cleanup();
    }
  });

  it('the reviewer unit: low→allow, medium→escalate, high→escalate, honest source', async () => {
    const reviewer = new EscalatingReviewer({ autoApproveLowRisk: true });
    const low = await reviewer.review({ riskLevel: 'low' } as never);
    expect(low).toMatchObject({ outcome: 'allow', source: 'rule-fallback' });
    const medium = await reviewer.review({ riskLevel: 'medium' } as never);
    expect(medium).toMatchObject({ outcome: 'escalate', source: 'rule-fallback' });
    const high = await reviewer.review({ riskLevel: 'high' } as never);
    expect(high).toMatchObject({ outcome: 'escalate', source: 'rule-fallback' });
    expect(high.reason).not.toContain('not implemented');
  });
});
