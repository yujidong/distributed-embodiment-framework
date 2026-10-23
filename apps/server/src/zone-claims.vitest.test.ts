/**
 * @vitest-environment node
 *
 * Zone-claim autonomy tests (P-B, multi-user-simulation-design.md §5.3).
 *
 * Lifecycle: a builder claims a zone (force-escalated to the owner — claims
 * never auto-approve), the owner approves, the claim lands in zone_claims;
 * from then on the steward's LOW-risk proposals fully inside that zone skip
 * AI review and apply directly, while cross-zone, high-risk, and other
 * users' proposals still run the full funnel; reverting the claim proposal
 * revokes the grant and restores the full funnel.
 *
 * The server runs the P-A escalate-everything reviewer here (no LLM
 * configured), which is exactly what proves the autonomy path bypasses the
 * reviewer rather than relying on a lenient one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('zone-claim autonomy (P-B §5.3)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let other: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    other = await registerUser(ctx.app, { displayName: 'Other' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Autonomy Lab',
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

  function submit(token: string, kind: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind, payload },
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

  function installIn(zoneId: string, overrides: Record<string, unknown> = {}) {
    return {
      devices: [
        {
          name: `Sensor in ${zoneId}`,
          type: 'temperature-sensor',
          capabilities: ['temperature-reading'],
          zoneId,
          ...overrides,
        },
      ],
    };
  }

  it('runs the full claim → autonomy → revoke lifecycle', async () => {
    // 1. Claim: force-escalated to the owner even though it is low-risk —
    //    the escalate-everything reviewer never even sees it (rule layer).
    const claim = await submit(builder.token, 'zone-claim', { zoneId: 'zone-a' });
    expect(claim.statusCode).toBe(201);
    expect(claim.json().status).toBe('escalated');
    expect(claim.json().riskLevel).toBe('low');
    expect(claim.json().ruleCheck.forceEscalate).toBe(true);
    expect(claim.json().ruleCheck.escalateReason).toContain('owner');
    expect(ctx.app.zoneClaimStore.listForEnv(envId)).toHaveLength(0);

    // 2. Owner approves → applied, and the grant is a REAL world effect.
    const granted = await decide(owner.token, claim.json().id, 'approved');
    expect(granted.json().status).toBe('applied');
    const claims = ctx.app.zoneClaimStore.listForEnv(envId);
    expect(claims).toHaveLength(1);
    expect(claims[0].zone_id).toBe('zone-a');
    expect(claims[0].grantee_id).toBe(builder.id);
    expect(claims[0].granted_by).toBe(owner.id);

    // 3. Steward's low-risk proposal inside the claimed zone skips AI
    //    review and applies directly (recorded with source 'zone-claim').
    const inZone = await submit(builder.token, 'install-devices', installIn('zone-a'));
    expect(inZone.json().status).toBe('applied');
    expect(inZone.json().aiReview.source).toBe('zone-claim');
    expect(inZone.json().aiReview.outcome).toBe('allow');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(1);

    // 4. An inject-scenario fully inside the zone (device + event) also
    //    auto-approves.
    const overlay = await submit(builder.token, 'inject-scenario', {
      devices: installIn('zone-a').devices,
      events: [
        { id: 'drill', type: 'fire-alarm', zoneId: 'zone-a', severity: 'low', atSimTimeSec: 30 },
      ],
    });
    expect(overlay.json().status).toBe('applied');

    // 5. Cross-zone footprints still run the full funnel.
    const crossZone = await submit(builder.token, 'inject-scenario', {
      devices: installIn('zone-a').devices,
      events: [
        { id: 'other-zone-event', type: 'fire-alarm', zoneId: 'zone-b', severity: 'low', atSimTimeSec: 30 },
      ],
    });
    expect(crossZone.json().status).toBe('escalated');
    const otherZone = await submit(builder.token, 'install-devices', installIn('zone-b'));
    expect(otherZone.json().status).toBe('escalated');

    // 6. High-risk inside the claimed zone still escalates.
    const highRisk = await submit(
      builder.token,
      'install-devices',
      installIn('zone-a', { binding: 'hass://sensor.real_temp' }),
    );
    expect(highRisk.json().status).toBe('escalated');
    expect(highRisk.json().riskLevel).toBe('high');

    // 7. Autonomy is personal: another builder in the same zone escalates.
    const notSteward = await submit(other.token, 'install-devices', installIn('zone-a'));
    expect(notSteward.json().status).toBe('escalated');

    // 8. Reverting the claim revokes the grant; the funnel is back.
    const reverted = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${claim.json().id}/revert`,
      headers: auth(builder.token),
    });
    expect(reverted.json().status).toBe('reverted');
    expect(ctx.app.zoneClaimStore.listForEnv(envId)).toHaveLength(0);

    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?kind=revert:zone-claim`,
      headers: auth(owner.token),
    });
    expect(log.json().entries).toHaveLength(1);
    expect(log.json().entries[0].payload.before.zoneId).toBe('zone-a');

    const afterRevoke = await submit(builder.token, 'install-devices', installIn('zone-a'));
    expect(afterRevoke.json().status).toBe('escalated');
  });

  it('owner rejection of a claim grants nothing', async () => {
    const claim = await submit(builder.token, 'zone-claim', { zoneId: 'zone-a' });
    const rejected = await decide(owner.token, claim.json().id, 'rejected');
    expect(rejected.json().status).toBe('rejected');
    expect(ctx.app.zoneClaimStore.listForEnv(envId)).toHaveLength(0);

    const res = await submit(builder.token, 'install-devices', installIn('zone-a'));
    expect(res.json().status).toBe('escalated');
  });
});
