/**
 * @vitest-environment node
 *
 * T-058b (DevLoop R14, design-consent-semantics.md §4) — per-data-subject
 * access grants: the provider-owned door on hidden services.
 *
 * The stakeholder story is FR-F03 (family): a per-bed vitals service is
 * hidden — all-or-nothing privacy with no negotiated middle ground. The
 * grant lane adds the middle: request → grant (person × period × basis) →
 * the family can see the service and propose a terms.read agreement →
 * reads deliver, metered kind=read → revoke → 404 again + reads answer
 * 409 ACCESS_GRANT_REVOKED (metered failure) while the agreement itself
 * keeps its status (termination stays bilateral).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, until, type TestAppContext, type TestUser } from './test-utils.js';

const FUTURE_ISO = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

describe('T-058b access grants (consent semantics §4)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let family: TestUser;
  let outsider: TestUser;
  let envId: string;
  let serviceId: string;
  let providerAgentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Eldercare Operator' });
    family = await registerUser(ctx.app, { displayName: 'Family of 101-2' });
    outsider = await registerUser(ctx.app, { displayName: 'Outsider' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'eldercare', name: 'Eldercare Facility' },
        zones: [
          { id: 'ward-102', consentClass: 'supervised', adjacentZoneIds: ['hall'] },
          { id: 'hall', adjacentZoneIds: ['ward-102'] },
        ],
        devices: [],
        agents: [],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    // The per-bed vitals offer: a published data service the operator hides.
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Care Bot', capabilities: [] },
    });
    expect(agent.statusCode).toBe(201);
    providerAgentId = agent.json().id as string;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: '跌倒检测手表（101-2床）', semanticType: 'fall-watch-101-2' },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;

    const hidden = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
      payload: { visibility: 'hidden' },
    });
    expect(hidden.statusCode).toBe(200);

    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['ward-102'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: {
          dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] },
        },
      },
    });
    expect(registered.statusCode).toBe(201);

    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(family.token) });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function notificationsOf(token: string): Promise<Array<{ kind: string; refId: string | null }>> {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/notifications', headers: auth(token) });
    return res.json().notifications as Array<{ kind: string; refId: string | null }>;
  }

  // -----------------------------------------------------------------------
  // §4.1 the door: hidden + grant → visible; expiry/revocation → 404 again
  // -----------------------------------------------------------------------

  it('FR-F03 family story: request → grant → visible → propose terms.read → read → revoke', async () => {
    // Before: hidden is all-or-nothing — the family gets 404 everywhere.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(404);
    const listBefore = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}/services`, headers: auth(family.token),
    });
    expect(listBefore.json().services).toHaveLength(0);

    // The request lane (not the proposal pipeline).
    const request = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-requests`,
      headers: auth(family.token),
      payload: { purpose: '家属了解 101-2 床父亲跌倒情况', durationDays: 90 },
    });
    expect(request.statusCode).toBe(201);
    expect(request.json().status).toBe('pending');
    const requestId = request.json().id as string;
    expect(
      (await notificationsOf(owner.token)).some(n => n.kind === 'service.access-requested' && n.refId === requestId),
    ).toBe(true);

    // No SLA — but the remind nudge is rate-limited from CREATION (T-309 pattern).
    const earlyRemind = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-requests/${requestId}/remind`,
      headers: auth(family.token),
      payload: {},
    });
    expect(earlyRemind.statusCode).toBe(429);
    expect(earlyRemind.json().error.message).toContain('REQUEST CREATION');

    // The provider grants: person × period × basis + the declarative
    // resident label (§4.3 — provider-owned honesty, not platform-verified).
    const grant = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: {
        requestId,
        expiresAt: FUTURE_ISO(90),
        basis: 'family of resident 101-2',
        dataSubject: { ref: 'resident-101-2', consentBasis: 'care-contract §7' },
      },
    });
    expect(grant.statusCode).toBe(201);
    expect(grant.json().dataSubject).toEqual({ ref: 'resident-101-2', consentBasis: 'care-contract §7' });
    expect(
      (await notificationsOf(family.token)).some(n => n.kind === 'service.access-granted'),
    ).toBe(true);
    // The request closed as granted.
    const queue = await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}/access-requests`, headers: auth(owner.token),
    });
    expect(queue.json().requests.find((r: { id: string }) => r.id === requestId).status).toBe('granted');

    // The door opened: GET, list, env detail, and PROPOSE all pass now.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(200);
    const listAfter = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}/services`, headers: auth(family.token),
    });
    expect(listAfter.json().services.map((s: { id: string }) => s.id)).toContain(serviceId);
    const detail = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(family.token),
    });
    expect(detail.json().services.map((s: { id: string }) => s.id)).toContain(serviceId);

    // The agreement is the CONTRACT: terms.read scopes fields + quota.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(family.token),
      payload: { terms: { read: { fields: ['avgTemperature'], quotaPerWindow: 3, windowSec: 86400 } } },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.json().status).toBe('active');

    // Live read: metered kind=read, receipt, terms enforced.
    const sim = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(family.token),
      payload: { environmentId: envId },
    });
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${sim.json().id}/start`, headers: auth(family.token), payload: {},
    });
    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token),
      payload: { simulationId: sim.json().id as string },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().usage.kind).toBe('read');
    expect(read.json().usage.outcome).toBe('success');

    // Revocation: the door closes immediately — 404 again.
    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/access-grants/${family.id}`,
      headers: auth(owner.token),
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (await notificationsOf(family.token)).some(n => n.kind === 'service.access-revoked'),
    ).toBe(true);
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(404);

    // The agreement does NOT silently die: reads answer 409
    // ACCESS_GRANT_REVOKED, metered as failure.
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token),
      payload: { simulationId: sim.json().id as string },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ACCESS_GRANT_REVOKED');
    const usage = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/usage`, headers: auth(family.token),
    });
    const rows = usage.json().usage as Array<{ kind: string; outcome: string }>;
    expect(rows.filter(r => r.kind === 'read' && r.outcome === 'failure')).toHaveLength(1);
    // The agreement itself keeps its status — termination is bilateral.
    const agreement = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(family.token),
    });
    expect(agreement.json().status).toBe('active');
  });

  it('an expired grant reads as 404 (no manual revocation needed)', async () => {
    // DevLoop R21 test-debt: was a fixed 1.3s wall-clock wait for a 1.1s
    // TTL to lapse (load-flaky in both directions: the initial 200 could
    // race past expiry, or the expiry could be judged too early). Now: a
    // wide-enough TTL for the positive 200, then POLL until the row reads
    // as expired — the wait ends at the earliest honest moment.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: family.id, expiresAt: new Date(Date.now() + 2_000).toISOString(), basis: 'short trial' },
    });
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(200);
    const expired = await until(async () =>
      (await ctx.app.inject({
        method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
      })).statusCode === 404, 15_000, 100);
    expect(expired).toBe(true);
  });

  it('a repeat grant EXTENDS the same (service, grantee) row', async () => {
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: family.id, expiresAt: FUTURE_ISO(7), basis: 'initial' },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: family.id, expiresAt: FUTURE_ISO(90), basis: 'extended' },
    });
    expect(second.statusCode).toBe(201);
    const ledger = await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}/access-grants`, headers: auth(owner.token),
    });
    const grants = ledger.json().grants as Array<{ id: string; expiresAt: string; basis: string }>;
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(first.json().id);
    expect(new Date(grants[0].expiresAt).toISOString()).toBe(new Date(second.json().expiresAt).toISOString());
  });

  // -----------------------------------------------------------------------
  // §4.2 the request lane — boundaries
  // -----------------------------------------------------------------------

  it('outsiders neither request nor learn the service exists (404)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-requests`,
      headers: auth(outsider.token),
      payload: { purpose: 'curiosity' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SERVICE_NOT_FOUND');
  });

  it('only hidden services take requests (visible offers → 409 teaching)', async () => {
    const visible = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'Public Newsletter', semanticType: 'newsletter' },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${visible.json().id}/access-requests`,
      headers: auth(family.token),
      payload: { purpose: 'why not' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SERVICE_NOT_HIDDEN');
  });

  it('requester withdraws; provider can explicitly reject; only pending closes', async () => {
    const request = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-requests`,
      headers: auth(family.token),
      payload: { purpose: 'x' },
    });
    const id = request.json().id as string;
    // Family cannot read the provider queue.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}/access-requests`, headers: auth(family.token),
    })).statusCode).toBe(403);
    // Re-request after withdrawal is possible.
    const withdrawn = await ctx.app.inject({
      method: 'DELETE', url: `/api/services/${serviceId}/access-requests/${id}`, headers: auth(family.token),
    });
    expect(withdrawn.json().status).toBe('withdrawn');

    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-requests`,
      headers: auth(family.token),
      payload: { purpose: 'second attempt' },
    });
    const rejected = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/access-requests/${again.json().id}`,
      headers: auth(owner.token),
    });
    expect(rejected.json().status).toBe('rejected');
    // Closing twice → 409.
    const twice = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/access-requests/${again.json().id}`,
      headers: auth(owner.token),
    });
    expect(twice.statusCode).toBe(409);
  });

  // -----------------------------------------------------------------------
  // Grant validation
  // -----------------------------------------------------------------------

  it('grants require a future expiry and member grantees; dataSubject is closed', async () => {
    const noExpiry = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: family.id },
    });
    expect(noExpiry.statusCode).toBe(400);
    expect(noExpiry.json().error.message).toContain('expiresAt');

    const past = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: family.id, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.statusCode).toBe(400);

    const notMember = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: outsider.id, expiresAt: FUTURE_ISO(30) },
    });
    expect(notMember.statusCode).toBe(400);
    expect(notMember.json().error.code).toBe('GRANTEE_NOT_MEMBER');

    const badLabel = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: {
        userId: family.id,
        expiresAt: FUTURE_ISO(30),
        dataSubject: { ref: 'resident-101-2', relationship: 'daughter' },
      },
    });
    expect(badLabel.statusCode).toBe(400);
    expect(badLabel.json().error.message).toContain('dataSubject.relationship');

    // The family (grantee) cannot grant, only the provider/env owner.
    const wrongGranter = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(family.token),
      payload: { userId: family.id, expiresAt: FUTURE_ISO(30) },
    });
    expect(wrongGranter.statusCode).toBe(403);
  });

  it('the provider AGENT owner (not the env owner) can grant and revoke too', async () => {
    // A second operator user owns a care agent of their own. A builder's
    // agent create is an install-agents PROPOSAL — the owner approves it.
    const provider = await registerUser(ctx.app, { displayName: 'Care Team' });
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(provider.token) });
    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(provider.token),
      payload: { name: 'Nurse Bot', capabilities: [] },
    });
    expect(proposal.statusCode).toBe(201);
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    const detail = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    });
    const nurseBot = (detail.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'Nurse Bot')!;
    const service = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${nurseBot.id}/services`,
      headers: auth(provider.token),
      payload: { name: 'Vitals (bed 101-3)', semanticType: 'vitals-101-3', visibility: 'hidden' },
    });
    expect(service.statusCode).toBe(201);
    const sid = service.json().id as string;

    // The provider owner grants; the ENV owner also may (both are grantors);
    // a random member may not.
    const granted = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${sid}/access-grants`,
      headers: auth(provider.token),
      payload: { userId: family.id, expiresAt: FUTURE_ISO(30), basis: 'care-team decision' },
    });
    expect(granted.statusCode).toBe(201);
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${sid}`, headers: auth(family.token),
    })).statusCode).toBe(200);

    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${sid}/access-grants/${family.id}`,
      headers: auth(provider.token),
    });
    expect(revoked.statusCode).toBe(204);
  });

  it('T-067: the expiry probe is INERT without EAF_ALLOW_GRANT_TIME_CONTROL (default deployment)', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(owner.token),
      payload: { userId: family.id, expiresAt: FUTURE_ISO(90) },
    });
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}/access-grants/${family.id}`,
      headers: auth(owner.token),
      payload: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TEST_INFRA_DISABLED');
    expect(res.json().error.message).toContain('EAF_ALLOW_GRANT_TIME_CONTROL');
    // And the grant itself is untouched (still visible).
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T-067 (R16) — grant-expiry boundary probe (TEST-INFRA, env-flag-gated).
// Grant durations are provider-decided with a 1-day floor at creation, so
// natural expiry cannot be observed in a round window. The probe collapses
// the boundary: PATCH (env owner only, EAF_ALLOW_GRANT_TIME_CONTROL=1,
// shorten-only) → expired grant → GET 404 + active-agreement reads →
// 409 ACCESS_GRANT_REVOKED. Production floors unchanged.
// ---------------------------------------------------------------------------

describe('T-067 grant expiry boundary probe (test infra)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner
  let provider: TestUser; // provider agent owner (NOT the env owner — probes must be env-owner-only)
  let family: TestUser;
  let envId: string;
  let serviceId: string;
  let agreementId: string;
  let simId: string;

  beforeEach(async () => {
    // The flag is the deployment switch — tests opt in explicitly; the
    // default-deployment behavior (403 TEST_INFRA_DISABLED) is covered above.
    ctx = await makeTestApp({ allowGrantTimeControl: true });
    owner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    provider = await registerUser(ctx.app, { displayName: 'Provider' });
    family = await registerUser(ctx.app, { displayName: 'Family' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'probe-env', name: 'Probe Env' },
        zones: [{ id: 'ward-1', adjacentZoneIds: [] }],
        devices: [],
        agents: [],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(provider.token) });
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(family.token) });

    // A member's agent create is an install-agents PROPOSAL — approve it.
    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(provider.token),
      payload: { name: 'Care Bot', capabilities: [] },
    });
    expect(proposal.statusCode).toBe(201);
    const proposalDecided = await ctx.app.inject({
      method: 'POST', url: `/api/proposals/${proposal.json().id}/decide`,
      headers: auth(owner.token), payload: { decision: 'approved' },
    });
    expect(proposalDecided.json().status).toBe('applied');
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    const providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'Care Bot')!.id;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(provider.token),
      payload: { name: 'Per-bed vitals', semanticType: 'vitals-bed-1', visibility: 'hidden' },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id as string;
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(provider.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: { zones: ['ward-1'], metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }] },
        interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
      },
    });
    expect(registered.statusCode).toBe(201);

    const granted = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/access-grants`,
      headers: auth(provider.token),
      payload: { userId: family.id, expiresAt: FUTURE_ISO(90), basis: 'family' },
    });
    expect(granted.statusCode).toBe(201);

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(family.token),
      payload: { terms: { read: { fields: ['avgTemperature'] } } },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/decide`,
      headers: auth(provider.token), payload: { decision: 'accept' },
    });
    expect(decided.json().status).toBe('active');

    const sim = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(family.token),
      payload: { environmentId: envId },
    });
    simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${simId}/start`, headers: auth(family.token), payload: {},
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const probe = (token: string, body: Record<string, unknown>, userId = family.id) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}/access-grants/${userId}`,
      headers: auth(token),
      payload: body,
    });

  it('both halves of the expiry boundary: GET → 404 AND active-agreement reads → 409 ACCESS_GRANT_REVOKED', async () => {
    // Sanity: the grant is open and the read works.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(200);
    expect((await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token), payload: { simulationId: simId },
    })).statusCode).toBe(200);

    // Shorten the 90-day grant into the past (the whole point of the probe).
    const shortened = await probe(owner.token, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(shortened.statusCode).toBe(200);
    expect(new Date(shortened.json().expiresAt).getTime()).toBeLessThan(Date.now());

    // Half 1: the door closed — grantee-side 404, no existence leak.
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/services/${serviceId}`, headers: auth(family.token),
    })).statusCode).toBe(404);

    // Half 2: the contract does not silently die — reads 409, metered failure.
    const refused = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/reads`,
      headers: auth(family.token), payload: { simulationId: simId },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ACCESS_GRANT_REVOKED');
    const usage = (await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}/usage`, headers: auth(family.token),
    })).json().usage as Array<{ kind: string; outcome: string }>;
    expect(usage.filter(row => row.kind === 'read' && row.outcome === 'failure')).toHaveLength(1);
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(family.token),
    })).json().status).toBe('active'); // termination stays bilateral

    // Expiry is silent by design — no service.access-revoked notification.
    const notifications = (await ctx.app.inject({
      method: 'GET', url: '/api/notifications', headers: auth(family.token),
    })).json().notifications as Array<{ kind: string }>;
    expect(notifications.some(n => n.kind === 'service.access-revoked')).toBe(false);
  });

  it('env-owner-only, shorten-only, closed body — every misuse teaches', async () => {
    // The provider owner (a legitimate grantor!) may NOT probe.
    const wrongOwner = await probe(provider.token, { expiresAt: new Date().toISOString() });
    expect(wrongOwner.statusCode).toBe(403);
    expect(wrongOwner.json().error.message).toContain('environment owner');

    // Extending is not the probe's job.
    const extend = await probe(owner.token, { expiresAt: FUTURE_ISO(180) });
    expect(extend.statusCode).toBe(409);
    expect(extend.json().error.code).toBe('GRANT_EXPIRY_NOT_SHORTER');
    expect(extend.json().error.message).toContain('POST /api/services/:id/access-grants');

    // Closed body: unknown fields are named, never silently dropped.
    const extra = await probe(owner.token, { expiresAt: new Date().toISOString(), basis: 'why not' });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.message).toMatch(/basis.*allowed: expiresAt/);

    // Unknown grant → 404.
    const missing = await probe(owner.token, { expiresAt: new Date().toISOString() }, 'no-such-user');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ACCESS_GRANT_NOT_FOUND');

    // Non-ISO expiry → 400.
    const badIso = await probe(owner.token, { expiresAt: 'yesterday' });
    expect(badIso.statusCode).toBe(400);
  });
});
