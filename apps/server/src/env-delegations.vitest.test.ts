/**
 * @vitest-environment node
 *
 * Env decision-delegation tests (T-072, DevLoop R23 —
 * design-consent-semantics.md §3 / D-1 decide half).
 *
 * Commit-1 surface: the delegation resource itself — owner grants
 * zone-claim decide rights to ONE member at a time (scope validation, zone
 * narrowing, the revoke-first 409, refresh semantics), notifications to
 * the delegate (zh/en), the governance block on the env detail, audit rows
 * (command_log kind 'delegation-change'), and the membership-end lifecycle
 * (member removal / self-leave revokes the delegation — an active
 * delegation always names a current member).
 *
 * The decide path itself (delegate deciding an escalated zone-claim with
 * delegate attribution) lives in the same file's second describe block —
 * see 'decide path'.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('env decision delegations (T-072, D-1 decide half)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let other: TestUser;
  let outsider: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    other = await registerUser(ctx.app, { displayName: 'Other' });
    outsider = await registerUser(ctx.app, { displayName: 'Outsider' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Delegation Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
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
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function grant(token: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(token),
      payload,
    });
  }

  async function inbox(userId: string, token: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().notifications.filter(
      (n: { envId: string }) => n.envId === envId,
    ) as Array<{ kind: string; body: Record<string, unknown> }>;
  }

  it('grants, lists, surfaces on the governance block, and notifies the delegate', async () => {
    const res = await grant(owner.token, { userId: builder.id, zones: ['zone-a'] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      scope: 'zone-claims',
      zones: ['zone-a'],
      delegate: { id: builder.id, displayName: 'Builder' },
      grantedBy: { id: owner.id },
    });

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(other.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().delegations).toHaveLength(1);
    expect(list.json().delegations[0].delegate.id).toBe(builder.id);

    // The env detail's governance block carries the delegation — members
    // see WHO may decide before anyone relies on it.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(other.token),
    });
    expect(detail.statusCode).toBe(200);
    const governance = detail.json().governance;
    expect(governance.decisionDelegations).toHaveLength(1);
    expect(governance.decisionDelegations[0]).toMatchObject({
      scope: 'zone-claims',
      zones: ['zone-a'],
      delegate: { id: builder.id },
    });
    expect(governance.decisionDelegationNote).toContain('zone-claim');

    // The delegate hears it from their inbox (zh default locale).
    const notes = await inbox(builder.id, builder.token);
    const grantedNote = notes.find(n => n.kind === 'governance.delegation-granted');
    expect(grantedNote).toBeDefined();
    expect(grantedNote!.body).toMatchObject({ scope: 'zone-claims', zones: ['zone-a'] });
    expect(grantedNote!.body.replyHint).toMatchObject({ yourMove: true });

    // Audit: command_log carries the governance mutation.
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=delegation-change`,
      headers: auth(owner.token),
    });
    expect(log.json().entries).toHaveLength(1);
    expect(log.json().entries[0].payload).toMatchObject({
      action: 'granted',
      scope: 'zone-claims',
      delegateUserId: builder.id,
      zones: ['zone-a'],
    });
  });

  it('validates the grant: owner-as-delegate, non-member, unknown zone, foreign scope', async () => {
    expect((await grant(owner.token, { userId: owner.id })).statusCode).toBe(400);

    const notMember = await grant(owner.token, { userId: outsider.id });
    expect(notMember.statusCode).toBe(409);
    expect(notMember.json().error.message).toContain('member');

    expect((await grant(owner.token, { userId: builder.id, zones: ['nope'] })).statusCode).toBe(400);

    const foreignScope = await grant(owner.token, { userId: builder.id, scope: 'supervised-consent' });
    expect(foreignScope.statusCode).toBe(400);
    expect(foreignScope.json().error.message).toContain('zone-claims');

    // 'all' (and omission) both mean every zone.
    const all = await grant(owner.token, { userId: builder.id, zones: 'all' });
    expect(all.statusCode).toBe(201);
    expect(all.json().zones).toBe('all');
  });

  it('keeps ONE delegate per scope: switching requires an explicit revoke', async () => {
    await grant(owner.token, { userId: builder.id });

    const switchAttempt = await grant(owner.token, { userId: other.id });
    expect(switchAttempt.statusCode).toBe(409);
    expect(switchAttempt.json().error.message).toContain('revoke');

    // Re-granting the SAME delegate refreshes the zone scope (200).
    const refresh = await grant(owner.token, { userId: builder.id, zones: ['zone-b'] });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().zones).toEqual(['zone-b']);
  });

  it('is owner-only to grant; the list is member-readable but stranger-gated on private envs', async () => {
    expect((await grant(builder.token, { userId: builder.id })).statusCode).toBe(403);

    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private', visibility: 'private', mapData: { zones: [{ id: 'z' }] } },
    });
    const strangerRead = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${privateEnv.json().id}/delegations`,
      headers: auth(outsider.token),
    });
    expect(strangerRead.statusCode).toBe(403);
  });

  it('revokes with notification + audit; a second revoke teaches 404', async () => {
    await grant(owner.token, { userId: builder.id });

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/delegations/${builder.id}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    const notes = await inbox(builder.id, builder.token);
    expect(notes.some(n => n.kind === 'governance.delegation-revoked')).toBe(true);

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/delegations/${builder.id}`,
      headers: auth(owner.token),
    });
    expect(again.statusCode).toBe(404);

    // Only the owner may revoke.
    await grant(owner.token, { userId: builder.id });
    const notOwner = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/delegations/${builder.id}`,
      headers: auth(other.token),
    });
    expect(notOwner.statusCode).toBe(403);

    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=delegation-change`,
      headers: auth(owner.token),
    });
    const actions = log.json().entries.map((e: { payload: { action: string } }) => e.payload.action);
    expect(actions).toContain('granted');
    expect(actions).toContain('revoked');
  });

  it('membership removal revokes the delegation (lifecycle honesty)', async () => {
    await grant(owner.token, { userId: builder.id });

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/members/${builder.id}`,
      headers: auth(owner.token),
    });
    expect(removed.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
    });
    expect(list.json().delegations).toHaveLength(0);

    const notes = await inbox(builder.id, builder.token);
    const revokedNote = notes.find(n => n.kind === 'governance.delegation-revoked');
    expect(revokedNote?.body).toMatchObject({ reason: 'member-removed' });

    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=delegation-change`,
      headers: auth(owner.token),
    });
    const revokedRow = log
      .json()
      .entries.find((e: { payload: { reason?: string } }) => e.payload.reason === 'member-removed');
    expect(revokedRow).toBeDefined();
  });

  it('self-leave revokes the delegation too', async () => {
    await grant(owner.token, { userId: builder.id });

    const left = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/leave`,
      headers: auth(builder.token),
    });
    expect(left.statusCode).toBe(204);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
    });
    expect(list.json().delegations).toHaveLength(0);
  });
});

describe('zone-claim decide delegation (T-072 decide path)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let steward: TestUser;
  let delegate: TestUser;
  let other: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    steward = await registerUser(ctx.app, { displayName: 'Steward' });
    delegate = await registerUser(ctx.app, { displayName: 'Delegate' });
    other = await registerUser(ctx.app, { displayName: 'Other' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Decide Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    for (const user of [steward, delegate, other]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
    }
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function claimZone(token: string, zoneId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind: 'zone-claim', payload: { zoneId, rationale: 'night shift' } },
    });
  }

  function decide(token: string, proposalId: string, decision: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(token),
      payload: { decision },
    });
  }

  async function escalatedClaimId(token: string, zoneId: string): Promise<string> {
    const claim = await claimZone(token, zoneId);
    expect(claim.statusCode).toBe(201);
    expect(claim.json().status).toBe('escalated');
    return claim.json().id as string;
  }

  it('full lifecycle: delegate decides in scope, with attribution and doorbells', async () => {
    const claimId = await escalatedClaimId(steward.token, 'zone-a');
    // Owner delegates zone-claim decisions (zone-a only) to the delegate.
    const granted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id, zones: ['zone-a'] },
    });
    expect(granted.statusCode).toBe(201);

    const decided = await decide(delegate.token, claimId, 'approved');
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('applied');
    // Attribution: the DELEGATE is the reviewer; aiReview names the source.
    expect(decided.json().reviewerId).toBe(delegate.id);
    expect(decided.json().aiReview.source).toBe('delegate');
    expect(decided.json().aiReview.reason).toContain('delegated');
    // Real world effect: the claim landed, granted BY the delegate.
    const claims = ctx.app.zoneClaimStore.listForEnv(envId);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ zone_id: 'zone-a', grantee_id: steward.id, granted_by: delegate.id });

    // The apply entry's audit row distinguishes the decider (Fix-1 +
    // T-072): actor = author, decidedBy = delegate, decidedVia = delegate.
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=zone-claim`,
      headers: auth(owner.token),
    });
    const apply = log.json().entries.find(
      (e: { proposalId: string }) => e.proposalId === claimId,
    );
    expect(apply).toBeDefined();
    expect(apply.payload.decidedBy).toBe(delegate.id);
    expect(apply.payload.decidedVia).toBe('delegate');
    expect(apply.actor.id).toBe(steward.id);

    // The AUTHOR hears the verdict as usual (allowSelf carries platform
    // verdicts; here the actor is the delegate, so it is a plain delivery).
    // The OWNER hears that their delegated right was exercised.
    const ownerInbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    const ownerNotes = ownerInbox.json().notifications.filter(
      (n: { envId: string }) => n.envId === envId,
    );
    expect(
      ownerNotes.some(
        (n: { kind: string; body: { proposalId?: string } }) =>
          n.kind === 'proposal.delegate-applied' && n.body.proposalId === claimId,
      ),
    ).toBe(true);
    const stewardInbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(steward.token),
    });
    const stewardNotes = stewardInbox.json().notifications.filter(
      (n: { envId: string }) => n.envId === envId,
    );
    expect(
      stewardNotes.some(
        (n: { kind: string; body: { proposalId?: string } }) =>
          n.kind === 'proposal.applied' && n.body.proposalId === claimId,
      ),
    ).toBe(true);
  });

  it('an escalated zone-claim also notifies the active delegate', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id },
    });
    const claimId = await escalatedClaimId(steward.token, 'zone-b');

    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(delegate.token),
    });
    const notes = inbox.json().notifications.filter(
      (n: { envId: string }) => n.envId === envId,
    );
    const ping = notes.find(
      (n: { kind: string; body: { proposalId?: string } }) =>
        n.kind === 'proposal.escalated' && n.body.proposalId === claimId,
    );
    expect(ping).toBeDefined();
    expect(ping.body.delegatedToYou).toBe(true);
    expect(ping.body.replyHint).toMatchObject({ yourMove: true });
  });

  it('out-of-scope zone → teaching 403 naming the covered zones; owner unaffected', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id, zones: ['zone-a'] },
    });
    const claimId = await escalatedClaimId(steward.token, 'zone-b');

    const refused = await decide(delegate.token, claimId, 'approved');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('"zone-b"');
    expect(refused.json().error.message).toContain('zone-a');
    expect(refused.json().error.message).toContain('owner');

    // The owner still decides it (delegation never takes their right away).
    const ownerDecided = await decide(owner.token, claimId, 'rejected');
    expect(ownerDecided.json().status).toBe('rejected');
    expect(ownerDecided.json().aiReview.source).toBe('owner');
    expect(ownerDecided.json().reviewerId).toBe(owner.id);
  });

  it('non-zone-claim kinds stay owner-only: the delegate gets the scope-boundary 403', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id },
    });
    const install = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(steward.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{
            name: 'Sensor', type: 'temperature-sensor',
            capabilities: ['temperature-reading'], zoneId: 'zone-a',
          }],
        },
      },
    });
    expect(install.json().status).toBe('escalated');

    const refused = await decide(delegate.token, install.json().id, 'approved');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('zone-claims');
    expect(refused.json().error.message).toContain('install-devices');
  });

  it('without a delegation, deciding teaches the delegation surface; with one, non-delegates are named', async () => {
    const claimId = await escalatedClaimId(steward.token, 'zone-a');

    const noDelegation = await decide(other.token, claimId, 'approved');
    expect(noDelegation.statusCode).toBe(403);
    expect(noDelegation.json().error.message).toContain('/delegations');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id },
    });
    const wrongMember = await decide(other.token, claimId, 'approved');
    expect(wrongMember.statusCode).toBe(403);
    expect(wrongMember.json().error.message).toContain('Delegate');
  });

  it('after revocation the delegate is back to the teaching 403', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id },
    });
    const claimId = await escalatedClaimId(steward.token, 'zone-a');

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/delegations/${delegate.id}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    const refused = await decide(delegate.token, claimId, 'approved');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('/delegations');
  });

  it("the member's proposal list marks decidable-by-me", async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id, zones: ['zone-a'] },
    });
    const inScope = await escalatedClaimId(steward.token, 'zone-a');
    const outOfScope = await escalatedClaimId(steward.token, 'zone-b');
    const install = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(steward.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [{
            name: 'Sensor', type: 'temperature-sensor',
            capabilities: ['temperature-reading'], zoneId: 'zone-a',
          }],
        },
      },
    });
    expect(install.json().status).toBe('escalated');

    const byId = (token: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/proposals`,
        headers: auth(token),
      }).then(res => {
        const map = new Map<string, boolean>();
        for (const p of res.json().proposals as Array<{ id: string; youCanDecide: boolean }>) {
          map.set(p.id, p.youCanDecide);
        }
        return map;
      });

    // The delegate: in-scope zone-claim only.
    const delegateView = await byId(delegate.token);
    expect(delegateView.get(inScope)).toBe(true);
    expect(delegateView.get(outOfScope)).toBe(false);
    expect(delegateView.get(install.json().id)).toBe(false);
    // The owner: every escalated proposal.
    const ownerView = await byId(owner.token);
    expect(ownerView.get(inScope)).toBe(true);
    expect(ownerView.get(outOfScope)).toBe(true);
    expect(ownerView.get(install.json().id)).toBe(true);
    // A plain member: nothing.
    const otherView = await byId(other.token);
    expect([...otherView.values()]).not.toContain(true);

    // Single read carries the same mark.
    const single = await ctx.app.inject({
      method: 'GET',
      url: `/api/proposals/${inScope}`,
      headers: auth(delegate.token),
    });
    expect(single.json().youCanDecide).toBe(true);
  });

  it('audit rows distinguish owner-decided from delegate-decided applies', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id, zones: ['zone-a'] },
    });
    const delegateClaim = await escalatedClaimId(steward.token, 'zone-a');
    await decide(delegate.token, delegateClaim, 'approved');

    const ownerClaim = await escalatedClaimId(steward.token, 'zone-b');
    await decide(owner.token, ownerClaim, 'approved');

    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=zone-claim`,
      headers: auth(owner.token),
    });
    const byProposal = new Map(
      (log.json().entries as Array<{ proposalId: string; payload: { decidedBy: string; decidedVia: string } }>)
        .map(e => [e.proposalId, e.payload]),
    );
    expect(byProposal.get(delegateClaim)).toMatchObject({ decidedBy: delegate.id, decidedVia: 'delegate' });
    expect(byProposal.get(ownerClaim)).toMatchObject({ decidedBy: owner.id, decidedVia: 'owner' });
  });

  // T-602 (DevLoop R26, SC26-F05): the conflict-of-interest gate. A delegate
  // deciding their OWN org's claim used to sail through (grantee == grantedBy
  // == decidedBy, decidedVia "delegate"). Self-dealing now returns to the
  // §5.3 default (owner decides); third-party delegate decides stay green.
  it('T-602: delegate deciding their OWN claim → teaching 403; the claim stays with the owner', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/delegations`,
      headers: auth(owner.token),
      payload: { userId: delegate.id, zones: ['zone-a'] },
    });

    // The delegate's own org claims zone-a.
    const ownClaim = await escalatedClaimId(delegate.token, 'zone-a');

    const refused = await decide(delegate.token, ownClaim, 'approved');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('You authored this claim');
    expect(refused.json().error.message).toContain('conflict of interest');
    expect(refused.json().error.message).toContain('environment owner');
    // The proposal is untouched by the refused decide.
    const stillEscalated = await ctx.app.inject({
      method: 'GET',
      url: `/api/proposals/${ownClaim}`,
      headers: auth(owner.token),
    });
    expect(stillEscalated.json().status).toBe('escalated');

    // The list/read decoration is honest about the gate (owner yes,
    // authoring delegate no) — same lane the decide route enforces.
    const byId = (token: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/proposals`,
        headers: auth(token),
      }).then(res =>
        new Map(
          (res.json().proposals as Array<{ id: string; youCanDecide: boolean }>)
            .map(p => [p.id, p.youCanDecide] as const),
        ),
      );
    expect((await byId(delegate.token)).get(ownClaim)).toBe(false);
    expect((await byId(owner.token)).get(ownClaim)).toBe(true);

    // The owner lane is the remedy: deciding their own claim works for the
    // owner (and a third-party claim stays decidable by the delegate).
    const ownerDecided = await decide(owner.token, ownClaim, 'approved');
    expect(ownerDecided.statusCode).toBe(200);
    expect(ownerDecided.json().status).toBe('applied');
    expect(ownerDecided.json().aiReview.source).toBe('owner');

    const thirdParty = await escalatedClaimId(steward.token, 'zone-a');
    const thirdPartyDecided = await decide(delegate.token, thirdParty, 'approved');
    expect(thirdPartyDecided.statusCode).toBe(200);
    expect(thirdPartyDecided.json().aiReview.source).toBe('delegate');
    expect(thirdPartyDecided.json().status).toBe('applied');
  });
});
