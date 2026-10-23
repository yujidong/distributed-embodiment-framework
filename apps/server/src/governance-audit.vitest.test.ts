/**
 * @vitest-environment node
 *
 * T-025 (R10 EB-F08) — command_log audit coverage for governance actions.
 *
 * After driving proposals, agreement transitions, membership mutations and
 * share mints on one env, the owner's command-log used to contain ONLY
 * device/zone rows — "who suspended the contract?" and "who minted the
 * anonymous replay link?" were unauditable. This suite sweeps EVERY
 * governance mutation surface and asserts each lands EXACTLY ONE audited
 * row (actor = who acted, from/to = the state change), that FAILED
 * mutations leave no row, that the raw agreement rows stay OUT of the
 * activity feed (T-060 bilateral privacy + no double count), and that
 * Fix-9 member scoping still applies (an actor sees their own rows).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MESSAGES } from './i18n/messages.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

interface AuditRow {
  id: number;
  actor: { id: string } | null;
  kind: string;
  payload: Record<string, unknown>;
}

describe('governance-action audit sweep (T-025)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let stranger: TestUser;
  let envId: string;
  /** Derived service "HVAC B: 开启" (provider = owner's lab-agent). */
  let turnOnServiceId: string;
  /** Published-then-hidden data service (computation + access grants). */
  let hiddenServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('audit-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    const detail = created.json();
    const providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    turnOnServiceId = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启')!.id;

    // The hidden data service: publish on the provider agent, hide it, then
    // register a computation (the access-grant + computation surfaces).
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'Zone temp aggregate', semanticType: 'zone-temp-aggregate' },
    });
    expect(published.statusCode).toBe(201);
    hiddenServiceId = published.json().id as string;
    const computation = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hiddenServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: {
          dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] },
        },
      },
    });
    expect(computation.statusCode).toBe(201);
    const hidden = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${hiddenServiceId}`,
      headers: auth(owner.token),
      payload: { visibility: 'hidden' },
    });
    expect(hidden.statusCode).toBe(200);

    // NOTE: the beforeEach computation register itself lands one audit row —
    // the computation assertions below account for it (counted as the
    // FIRST registered row).
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Owner view of the command log filtered to one kind. */
  async function auditRows(kind: string): Promise<AuditRow[]> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?limit=500&kind=${encodeURIComponent(kind)}`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    // Newest first — reverse for chronological assertions.
    return (res.json().entries as AuditRow[]).reverse();
  }

  async function drive(token: string, method: string, url: string, payload?: Record<string, unknown>) {
    return ctx.app.inject({
      method,
      url,
      headers: auth(token),
      ...(payload !== undefined ? { payload } : {}),
    });
  }

  it('every governance mutation lands exactly one audited row (full sweep)', async () => {
    // --- membership ------------------------------------------------------
    const member = await registerUser(ctx.app, { displayName: 'Member' });
    expect((await drive(owner.token, 'POST', `/api/environments/${envId}/members`, { email: member.email, role: 'builder' })).statusCode).toBe(201);
    expect((await drive(owner.token, 'PATCH', `/api/environments/${envId}/members/${member.id}`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await drive(owner.token, 'DELETE', `/api/environments/${envId}/members/${member.id}`)).statusCode).toBe(204);

    const memberRows = await auditRows('member-change');
    expect(memberRows).toHaveLength(3);
    expect(memberRows.map(row => row.payload.action)).toEqual(['added', 'role-changed', 'removed']);
    expect(memberRows.map(row => row.payload.userId)).toEqual([member.id, member.id, member.id]);
    expect(memberRows.map(row => row.payload.before)).toEqual([null, 'builder', 'viewer']);
    expect(memberRows.map(row => row.payload.after)).toEqual(['builder', 'viewer', null]);
    for (const row of memberRows) expect(row.actor?.id).toBe(owner.id);

    // --- agreement lifecycle ---------------------------------------------
    const proposed = await drive(consumer.token, 'POST', `/api/services/${turnOnServiceId}/agreements`, { terms: { quotaPerWindow: 10 } });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    expect((await drive(owner.token, 'POST', `/api/agreements/${agreementId}/decide`, { decision: 'accept' })).statusCode).toBe(200);
    expect((await drive(owner.token, 'POST', `/api/agreements/${agreementId}/suspend`)).statusCode).toBe(200);
    // A failed mutation must leave NO row (double suspend → 409).
    expect((await drive(owner.token, 'POST', `/api/agreements/${agreementId}/suspend`)).statusCode).toBe(409);
    expect((await drive(owner.token, 'POST', `/api/agreements/${agreementId}/terminate`)).statusCode).toBe(200);

    // Second agreement: counter → consumer decides the counter-offer.
    const proposed2 = await drive(consumer.token, 'POST', `/api/services/${turnOnServiceId}/agreements`, { terms: { quotaPerWindow: 5 } });
    const agreement2Id = proposed2.json().id as string;
    expect((await drive(owner.token, 'POST', `/api/agreements/${agreement2Id}/counter`, { terms: { quotaPerWindow: 8 } })).statusCode).toBe(200);
    expect((await drive(consumer.token, 'POST', `/api/agreements/${agreement2Id}/decide`, { decision: 'accept' })).statusCode).toBe(200);

    const agreementRows = await auditRows('agreement-transition');
    expect(agreementRows).toHaveLength(7);
    expect(agreementRows.map(row => [row.payload.from, row.payload.to])).toEqual([
      [null, 'proposed'],
      ['proposed', 'active'],
      ['active', 'suspended'],
      ['suspended', 'terminated'],
      [null, 'proposed'],
      ['proposed', 'countered'],
      ['countered', 'active'],
    ]);
    // Actor attribution: the consumer proposed/accepted the counter, the
    // owner decided/suspended/terminated/countered.
    expect(agreementRows.map(row => row.actor?.id)).toEqual([
      consumer.id, owner.id, owner.id, owner.id, consumer.id, owner.id, consumer.id,
    ]);
    expect(agreementRows[0].payload.terms).toMatchObject({ quotaPerWindow: 10 });
    expect(agreementRows[5].payload.counteredTerms).toMatchObject({ quotaPerWindow: 8 });
    expect(agreementRows.every(row => row.payload.serviceId === turnOnServiceId)).toBe(true);

    // --- access grants -----------------------------------------------------
    expect((await drive(owner.token, 'POST', `/api/services/${hiddenServiceId}/access-grants`, {
      userId: consumer.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      basis: 'consent (sweep test)',
    })).statusCode).toBe(201);
    expect((await drive(owner.token, 'DELETE', `/api/services/${hiddenServiceId}/access-grants/${consumer.id}`)).statusCode).toBe(204);

    const grantRows = await auditRows('access-grant');
    expect(grantRows).toHaveLength(2);
    expect(grantRows.map(row => row.payload.action)).toEqual(['granted', 'revoked']);
    expect(grantRows.map(row => row.payload.granteeUserId)).toEqual([consumer.id, consumer.id]);
    expect(grantRows[0].payload.basis).toBe('consent (sweep test)');
    expect((grantRows[0].payload.expiresAt as string).length).toBe(24); // ISO
    expect(grantRows[1].payload.before).toMatchObject({ expiresAt: grantRows[0].payload.expiresAt });
    expect(grantRows[1].payload.after).toBeNull();
    for (const row of grantRows) expect(row.actor?.id).toBe(owner.id);

    // --- computations ------------------------------------------------------
    // beforeEach already registered one; revoke + re-register here.
    expect((await drive(owner.token, 'DELETE', `/api/services/${hiddenServiceId}/computation`)).statusCode).toBe(200);
    expect((await drive(owner.token, 'POST', `/api/services/${hiddenServiceId}/computation`, {
      kind: 'zone-query',
      refreshSec: 60,
      inputs: {
        zones: ['zone-a'],
        metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
      },
      interface: {
        dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] },
      },
    })).statusCode).toBe(201);

    const computationRows = await auditRows('computation-change');
    expect(computationRows).toHaveLength(3);
    expect(computationRows.map(row => row.payload.action)).toEqual([
      'registered', 'revoked', 'registered',
    ]);
    expect(computationRows.map(row => row.payload.objectId)).toEqual([
      hiddenServiceId, hiddenServiceId, hiddenServiceId,
    ]);
    expect(computationRows[1].payload.activeAgreementsNotified).toBe(0);
    for (const row of computationRows) expect(row.actor?.id).toBe(owner.id);

    // --- replay shares (T-108 landed earlier — pinned as part of the sweep) -
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date().toISOString();
    const minted = await drive(owner.token, 'POST', `/api/environments/${envId}/replay-shares`, { from, to });
    expect(minted.statusCode).toBe(201);
    const shareId = minted.json().shareId as string;
    expect((await drive(owner.token, 'DELETE', `/api/environments/${envId}/replay-shares/${shareId}`)).statusCode).toBe(204);
    expect((await auditRows('share-create'))).toHaveLength(1);
    expect((await auditRows('share-revoke'))).toHaveLength(1);
  });

  it('the activity feed does NOT render raw agreement-transition rows (T-060 bilateral + no double count)', async () => {
    const proposed = await drive(consumer.token, 'POST', `/api/services/${turnOnServiceId}/agreements`, { terms: {} });
    const agreementId = proposed.json().id as string;
    expect((await drive(owner.token, 'POST', `/api/agreements/${agreementId}/decide`, { decision: 'reject' })).statusCode).toBe(200);

    const feed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?limit=200`,
      headers: auth(owner.token),
    });
    expect(feed.statusCode).toBe(200);
    const entries = feed.json().entries as Array<{ kind: string; objectId: string; summary: string }>;
    // The agreement lifecycle appears ONCE per transition (from the
    // agreement table, bilateral-filtered) — never as raw command rows.
    const agreementEntries = entries.filter(entry => entry.objectId === agreementId);
    expect(agreementEntries.length).toBe(2); // proposed + rejected
    expect(agreementEntries.every(entry => entry.kind === 'agreement')).toBe(true);
    expect(entries.some(entry => entry.kind === 'command' && entry.objectId === agreementId)).toBe(false);

    // Member-change rows DO render (env governance history).
    const member = await registerUser(ctx.app, { displayName: 'Feed Member' });
    await drive(owner.token, 'POST', `/api/environments/${envId}/members`, { email: member.email, role: 'builder' });
    const feed2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?limit=200`,
      headers: auth(owner.token),
    });
    const entries2 = feed2.json().entries as Array<{ kind: string; summary: string }>;
    expect(entries2.some(entry => entry.kind === 'command' && entry.summary.includes('member-change: added'))).toBe(true);
  });

  it('T60 (R6, u3-P2-1): kind/actor filters apply BEFORE the limit — min(limit, matches) semantics', async () => {
    // A tiny limit against an unfiltered-heavy feed: ?kind=agreement&limit=1
    // must return exactly ONE agreement entry (the newest), not "whatever
    // filled the unfiltered first page".
    const proposed = await drive(consumer.token, 'POST', `/api/services/${turnOnServiceId}/agreements`, { terms: {} });
    const agreementId = proposed.json().id as string;
    await drive(owner.token, 'POST', `/api/agreements/${agreementId}/decide`, { decision: 'accept' });

    const feed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?kind=agreement&limit=1`,
      headers: auth(owner.token),
    });
    expect(feed.statusCode).toBe(200);
    const entries = feed.json().entries as Array<{ kind: string; objectId: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('agreement');
    expect(entries[0].objectId).toBe(agreementId);

    // A filter with zero hits is an honest empty page, not an error.
    const none = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?kind=event&limit=50`,
      headers: auth(owner.token),
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().entries).toHaveLength(0);

    // The actor filter slices the same way (substring, case-insensitive).
    const byActor = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?actor=${encodeURIComponent(consumer.displayName)}&limit=5`,
      headers: auth(owner.token),
    });
    const actorEntries = byActor.json().entries as Array<{ actor: { id: string } | null }>;
    expect(actorEntries.length).toBeGreaterThan(0);
    expect(actorEntries.every(entry => entry.actor?.id === consumer.id)).toBe(true);
  });

  // T75 (R8, u3-F4): the feed's closing-transition actor comes from the
  // agreement-transition audit row (the REAL acting user), not the row-shape
  // guess that attributed every terminate to the provider. The R8 incident:
  // Linxi proposed and recycled 33s later, the audit read actor=Wangdun (the
  // PROVIDER) while the notification said "terminated by the other party" —
  // one event, two contradicting faces.
  it('T75: a consumer recycling their own proposal audits actor=consumer (single attribution source)', async () => {
    const proposed = await drive(consumer.token, 'POST', `/api/services/${turnOnServiceId}/agreements`, { terms: {} });
    const agreementId = proposed.json().id as string;
    // 33 seconds pass (the u3-F4 timeline compressed) — the consumer, not
    // the provider, recycles the proposal.
    expect((await drive(consumer.token, 'POST', `/api/agreements/${agreementId}/terminate`, { reason: 'changed my mind' })).statusCode).toBe(200);

    const feed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?kind=agreement&limit=50`,
      headers: auth(owner.token),
    });
    expect(feed.statusCode).toBe(200);
    const entries = feed.json().entries as Array<{ kind: string; action: string; objectId: string; actor: { id: string } | null }>;
    const terminated = entries.find(entry => entry.objectId === agreementId && entry.action === 'terminated');
    expect(terminated).toBeDefined();
    // The REAL actor (consumer), never the provider-owner shape fallback.
    expect(terminated!.actor?.id).toBe(consumer.id);

    // The other side's notification carries the same fact from the same
    // actor stamp: the body names WHO terminated (the Fix-16 consumerName
    // channel, now on the terminate face too).
    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=50',
      headers: auth(owner.token),
    });
    expect(inbox.statusCode).toBe(200);
    const notifications = inbox.json().notifications as Array<{ kind: string; refId?: string; body?: { terminatedBy?: string; terminatedByName?: string } }>;
    const terminatedNote = notifications.find(note => note.kind === 'agreement.terminated' && note.refId === agreementId);
    expect(terminatedNote).toBeDefined();
    expect(terminatedNote!.body?.terminatedBy).toBe('party');
    expect(terminatedNote!.body?.terminatedByName).toBe('Consumer');
  });

  // T75: an env-owner termination is NEITHER party's act — the notification
  // title must say so instead of "by the other party" (the two-party title
  // would contradict the audit actor for the third-party closer). This
  // fixture's env owner is also the service's provider, so the message
  // itself is pinned at the catalog (the route branch is `isParty ? A : B`).
  it('T75: the env-owner termination title names the env owner, never "the other party"', async () => {
    expect(MESSAGES['zh-CN'].chrome.notif.agreementTerminatedByEnvOwner).toContain('环境所有者');
    expect(MESSAGES['zh-CN'].chrome.notif.agreementTerminatedByEnvOwner).not.toContain('对方');
    expect(MESSAGES['en-US'].chrome.notif.agreementTerminatedByEnvOwner).toContain('environment owner');
  });

  it('Fix-9 member scoping: a non-owner member sees their own governance rows, not the owner\'s', async () => {
    const proposed = await drive(consumer.token, 'POST', `/api/services/${turnOnServiceId}/agreements`, { terms: {} });
    const agreementId = proposed.json().id as string;
    await drive(owner.token, 'POST', `/api/agreements/${agreementId}/decide`, { decision: 'accept' });
    // The consumer never sees the owner's decide row, but sees their own propose row.
    const seen = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log?limit=500&kind=agreement-transition`,
      headers: auth(consumer.token),
    });
    const rows = seen.json().entries as AuditRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].actor?.id).toBe(consumer.id);
    expect(rows[0].payload.to).toBe('proposed');

    // A stranger gets 403 (read gate on the command log itself).
    expect((await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log`,
      headers: auth(stranger.token),
    })).statusCode).toBe(403);
  });
});
