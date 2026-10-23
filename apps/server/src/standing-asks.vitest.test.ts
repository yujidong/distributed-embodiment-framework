/**
 * @vitest-environment node
 *
 * T-069 (DevLoop R23, R19 NW-F04 — design-data-services.md §11): standing
 * asks (需求板) on FUTURE counterpart assets. The night-watch replay is the
 * headline: NightWatch (a builder owning nothing) posts "when someone
 * publishes atrium lighting, I want the intrusion-lighting trigger deal";
 * the facility manager arrives LATER, installs their lights (governed
 * proposals), and the ask matches — notification + pre-filled PROPOSED
 * agreement, provider decides as usual. The R19 gap ("当你发布 X 服务时，
 * 我想要触发 Y" was inexpressible) is closed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

interface AskJson {
  id: string;
  envId: string;
  asker: { id: string; displayName: string };
  semanticType: string;
  zoneId?: string;
  desiredTerms: Record<string, unknown>;
  note: string;
  autoPropose: boolean;
  status: 'open' | 'matched' | 'withdrawn' | 'expired';
  matchedServiceId?: string;
  matchedAt?: string;
  expiresAt: string;
  createdAt: string;
}

interface NotificationJson {
  id: string;
  kind: string;
  title: string;
  body: Record<string, unknown>;
  refId: string | null;
}

describe('T-069 standing asks (需求板)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let night: TestUser; // the R19 NightWatch successor — owns nothing
  let facility: TestUser; // the future counterpart asset owner
  let stranger: TestUser; // not a member
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Ops Owner' });
    night = await registerUser(ctx.app, { displayName: 'NightWatch' });
    facility = await registerUser(ctx.app, { displayName: 'Facility' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Lighthouse Tower',
        mapData: {
          zones: [
            { id: 'atrium', name: 'Atrium' },
            { id: 'night-perimeter', name: 'Night Perimeter' },
            { id: 'roof-plant', name: 'Roof Plant' },
          ],
        },
        visibility: 'public',
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    for (const user of [night, facility]) {
      const joined = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
      expect(joined.statusCode).toBe(200);
    }
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------

  async function postAsk(
    token: string,
    body: Record<string, unknown>,
    expectStatus = 201,
  ): Promise<AskJson> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/asks`,
      headers: auth(token),
      payload: body,
    });
    expect(res.statusCode, res.json()?.error?.message ?? '').toBe(expectStatus);
    return res.json() as AskJson;
  }

  async function listAsks(token: string, status = 'open'): Promise<AskJson[]> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/asks?status=${status}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().asks ?? []) as AskJson[];
  }

  async function notificationsOf(token: string): Promise<NotificationJson[]> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=100',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().notifications as NotificationJson[];
  }

  /** The facility's governed install: proposal → owner approves → applied. */
  async function facilityInstallsLight(zoneId = 'atrium'): Promise<void> {
    const devicesRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(facility.token),
      payload: {
        kind: 'install-devices',
        payload: {
          devices: [
            {
              name: 'Atrium Floodlight',
              type: 'light',
              capabilities: ['lighting-control'],
              zoneId,
            },
          ],
        },
      },
    });
    expect(devicesRes.statusCode).toBe(201);
    const devicesProposal = devicesRes.json().id as string;

    // No capabilities at install (the T-206 backing rule would reject an
    // unbound capability declaration); the device binding below is what
    // derives the lighting-control service.
    const agentsRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(facility.token),
      payload: {
        kind: 'install-agents',
        payload: {
          agents: [
            {
              name: 'Atrium Lighting Agent',
              capabilities: [],
              boundDeviceIds: [],
              managedZoneIds: [zoneId],
            },
          ],
        },
      },
    });
    expect(agentsRes.statusCode).toBe(201);

    const deviceApply = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${devicesProposal}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(deviceApply.json().status).toBe('applied');
    const device = ctx.app.envStore
      .devicesOf(envId)
      .find(row => row.name === 'Atrium Floodlight')!;

    const agentApply = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${agentsRes.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(agentApply.json().status).toBe('applied');
    const agent = ctx.app.envStore
      .agentsOf(envId)
      .find(row => row.owner_id === facility.id && row.name === 'Atrium Lighting Agent')!;

    // Binding derives the lighting-control service (the derivation-sync
    // 'created' seam the matcher rides). Builders edit through governance —
    // a modify-object proposal the owner approves.
    const bindProposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(facility.token),
      payload: {
        kind: 'modify-object',
        payload: { targetId: agent.id, patch: { boundDeviceIds: [device.id] } },
      },
    });
    expect(bindProposal.statusCode).toBe(201);
    const bind = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${bindProposal.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(bind.json().status).toBe('applied');
  }

  const nightAskBody = (overrides: Record<string, unknown> = {}) => ({
    // 'switching' is the honest derived label a future floodlight carries
    // (lighting-control's surface on a light collapses to switching — the
    // exact service R19's night shift contracted).
    semanticType: 'switching',
    zoneId: 'atrium',
    autoPropose: true,
    note: 'night shift: emergency lighting on intrusion',
    desiredTerms: {
      trigger: { eventType: 'intrusion-detected', zoneId: 'night-perimeter' },
      // R103 (zhao-23) signing gate: the negotiated action must be on the
      // backing device's callable surface. The floodlight's lighting-control
      // face collapses to ['turn-on'] on the shared executability oracle
      // (semantic mapping intercepts before the multi-command expansion), so
      // the clause is the callable 'turn-on' — 'set-brightness' would make
      // the honest auto-propose degrade to skipped-invalid-terms.
      action: { command: 'turn-on' },
      quotaPerWindow: 20,
      windowSec: 86400,
    },
    ...overrides,
  });

  // -------------------------------------------------------------------
  // The night-watch replay (R19 NW-F04 closure)
  // -------------------------------------------------------------------

  it('night-watch replay: ask first, facility installs later → match + pre-filled proposal → active', async () => {
    // 00:55 — NightWatch joins owning NOTHING and posts the standing ask.
    const ask = await postAsk(night.token, nightAskBody());
    expect(ask.status).toBe('open');
    expect(ask.autoPropose).toBe(true);
    expect(ask.desiredTerms).toMatchObject({ quotaPerWindow: 20, windowSec: 86400 });

    // Morning — the facility arrives and installs the atrium lights through
    // the GOVERNED path (proposal → owner approve → derivation sync).
    await facilityInstallsLight();

    // The ask matched exactly once and names the derived service.
    const mine = await listAsks(night.token, 'mine');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe('matched');
    expect(mine[0]!.matchedServiceId).toBeDefined();
    expect(mine[0]!.matchedAt).toBeDefined();

    const matchedService = ctx.app.serviceStore.getService(mine[0]!.matchedServiceId!)!;
    expect(matchedService.semantic_type).toBe('switching');
    expect(matchedService.origin).toBe('derived');

    // NightWatch received the doorbell (zh default locale title).
    const nightInbox = await notificationsOf(night.token);
    const matched = nightInbox.find(n => n.kind === 'ask.matched');
    expect(matched).toBeDefined();
    expect(matched!.title).toContain('需求板');
    expect(matched!.body).toMatchObject({
      askId: ask.id,
      semanticType: 'switching',
      serviceId: matchedService.id,
      serviceName: matchedService.name,
      autoPropose: 'proposed',
    });
    expect(typeof matched!.body.agreementId).toBe('string');

    // The provider saw the PRE-FILLED proposal with honest provenance.
    const facilityInbox = await notificationsOf(facility.token);
    const proposed = facilityInbox.find(n => n.kind === 'agreement.proposed');
    expect(proposed).toBeDefined();
    expect(proposed!.body).toMatchObject({ provenance: 'standing-ask', askId: ask.id });

    const agreementId = matched!.body.agreementId as string;
    const agreement = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(night.token),
    });
    expect(agreement.statusCode).toBe(200);
    const terms = agreement.json().terms as { notes?: string };
    expect(terms.notes).toContain('pre-filled from standing ask');
    expect(terms.notes).toContain(ask.id);
    expect(agreement.json().status).toBe('proposed');

    // The facility decides — governance unchanged, accept lands ACTIVE.
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(facility.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');

    // Single-match: a SECOND provider publishing the same semantic type
    // must NOT re-ring the consumed ask.
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Owner Light', type: 'light', capabilities: ['lighting-control'], zoneId: 'atrium' },
    });
    expect(second.statusCode).toBe(201);
    const secondDeviceId = second.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner Agent',
        capabilities: [],
        boundDeviceIds: [secondDeviceId],
        managedZoneIds: ['atrium'],
      },
    });
    const inboxAfter = await notificationsOf(night.token);
    expect(inboxAfter.filter(n => n.kind === 'ask.matched')).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // Matching conditions (the no-match table)
  // -------------------------------------------------------------------

  it('wrong semanticType never matches', async () => {
    await postAsk(night.token, nightAskBody({ semanticType: 'security-status', zoneId: undefined }));
    await facilityInstallsLight();
    const inbox = await notificationsOf(night.token);
    expect(inbox.filter(n => n.kind === 'ask.matched')).toHaveLength(0);
    expect((await listAsks(night.token, 'mine'))[0]!.status).toBe('open');
  });

  it('zone-scoped ask does not match a service in another zone', async () => {
    await postAsk(night.token, nightAskBody()); // wants atrium lighting
    await facilityInstallsLight('roof-plant'); // installs in roof-plant instead
    const inbox = await notificationsOf(night.token);
    expect(inbox.filter(n => n.kind === 'ask.matched')).toHaveLength(0);
    expect((await listAsks(night.token, 'mine'))[0]!.status).toBe('open');
  });

  it('an env-wide ask (no zoneId) matches any zone', async () => {
    await postAsk(night.token, nightAskBody({ zoneId: undefined, autoPropose: false }));
    await facilityInstallsLight('roof-plant');
    const inbox = await notificationsOf(night.token);
    expect(inbox.filter(n => n.kind === 'ask.matched')).toHaveLength(1);
  });

  it('expired asks match nothing and lazily flip to expired', async () => {
    // Plant an already-expired ask through the store (the route refuses
    // past expiries by design — the lazy transition covers real decay).
    const row = ctx.app.standingAskStore.create({
      envId,
      askerId: night.id,
      semanticType: 'lighting-control',
      zoneId: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await facilityInstallsLight();
    const inbox = await notificationsOf(night.token);
    expect(inbox.filter(n => n.kind === 'ask.matched')).toHaveLength(0);
    const mine = await listAsks(night.token, 'mine');
    expect(mine.find(a => a.id === row.id)!.status).toBe('expired');
    expect((await listAsks(night.token, 'open'))).toHaveLength(0);
  });

  it('the provider never matches their own service (self-echo suppression)', async () => {
    await postAsk(facility.token, nightAskBody({ zoneId: undefined, autoPropose: false }));
    await facilityInstallsLight();
    const inbox = await notificationsOf(facility.token);
    expect(inbox.filter(n => n.kind === 'ask.matched')).toHaveLength(0);
  });

  it('hidden derived services do not match (visibility wins over demand)', async () => {
    await postAsk(night.token, nightAskBody({ zoneId: undefined }));
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Hidden Light', type: 'light', capabilities: ['lighting-control'], zoneId: 'atrium' },
    });
    expect(device.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Hidden Agent',
        capabilities: [],
        boundDeviceIds: [device.json().id],
        managedZoneIds: ['atrium'],
        derivedServiceVisibility: 'hidden',
      },
    });
    const inbox = await notificationsOf(night.token);
    expect(inbox.filter(n => n.kind === 'ask.matched')).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // The explicit-publish seam + honest autoPropose degradation
  // -------------------------------------------------------------------

  it('explicit publish matches; autoPropose on an unbacked offer skips honestly', async () => {
    // The ask targets the PUBLISHED vocabulary (the explicit offer's own
    // semanticType) — a broker may publish any type, no derivation involved.
    await postAsk(night.token, nightAskBody({ zoneId: undefined, semanticType: 'lighting-control' }));
    // Owner-direct agent create (a builder's POST converts to a proposal).
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Broker Agent', capabilities: [], boundDeviceIds: [], managedZoneIds: [] },
    });
    expect(agent.statusCode).toBe(201);

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.json().id}/services`,
      headers: auth(owner.token),
      payload: {
        name: 'Atrium Lighting Broker',
        semanticType: 'lighting-control',
        description: 'brokered offer with no device',
      },
    });
    expect(published.statusCode).toBe(201);

    const inbox = await notificationsOf(night.token);
    const matched = inbox.find(n => n.kind === 'ask.matched');
    expect(matched).toBeDefined();
    // Honest degradation: no contract that can never deliver (T-310 lesson).
    expect(matched!.body.autoPropose).toBe('skipped-unbacked');
    expect(matched!.body.agreementId).toBeUndefined();
    expect((matched!.body.replyHint as { endpoint: string }).endpoint).toContain('/agreements');
    // The provider (owner here) got NO agreement.proposed — nothing was
    // proposed on an undeliverable offer.
    const providerInbox = await notificationsOf(owner.token);
    expect(providerInbox.filter(n => n.kind === 'agreement.proposed')).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // T-603 (R26, GO26-F01): autoPropose cannot silently burn the single match
  // -------------------------------------------------------------------

  it('T-603: autoPropose without a desiredTerms.action clause → teaching 400; autoPropose:false or a valid action → 201', async () => {
    // The schema-legal but flow-unusable shape: no action clause.
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/asks`,
      headers: auth(night.token),
      payload: nightAskBody({
        zoneId: undefined,
        desiredTerms: { quotaPerWindow: 20, windowSec: 86400 },
      }),
    });
    expect(refused.statusCode).toBe(400);
    const message = refused.json().error.message as string;
    expect(message).toContain('terms.action');
    expect(message).toContain('consuming the ask\'s single match');
    // Both remedies named.
    expect(message).toContain('autoPropose: false');

    // Same terms, manual lane → fine.
    const manual = await postAsk(night.token, nightAskBody({
      zoneId: undefined,
      autoPropose: false,
      desiredTerms: { quotaPerWindow: 20, windowSec: 86400 },
    }));
    expect(manual.status).toBe('open');
    expect(manual.autoPropose).toBe(false);

    // With the action clause → fine (the full shape the replay test runs).
    const actionable = await postAsk(night.token, nightAskBody({ zoneId: undefined }));
    expect(actionable.status).toBe('open');
    expect(actionable.autoPropose).toBe(true);
  });

  it('T-603: a skipped-invalid-terms match carries the CAUSE in the asker notification (manual-propose replyHint is actionable)', async () => {
    // Action present (creation gate passes) but a read clause no derived
    // service can satisfy — the gate refuses at match time.
    await postAsk(night.token, nightAskBody({
      desiredTerms: {
        trigger: { eventType: 'intrusion-detected', zoneId: 'night-perimeter' },
        action: { command: 'set-brightness', params: { brightness: 100 } },
        read: { fields: ['lumen-log'] },
        quotaPerWindow: 20,
        windowSec: 86400,
      },
    }));

    await facilityInstallsLight();

    const inbox = await notificationsOf(night.token);
    const matched = inbox.find(n => n.kind === 'ask.matched');
    expect(matched).toBeDefined();
    expect(matched!.body.autoPropose).toBe('skipped-invalid-terms');
    expect(matched!.body.agreementId).toBeUndefined();
    // The reason is the gate's own teaching, so the asker can fix the terms
    // before proposing manually.
    expect(typeof matched!.body.autoProposeReason).toBe('string');
    expect(matched!.body.autoProposeReason).toContain('computation');
    expect((matched!.body.replyHint as { endpoint: string }).endpoint).toContain('/agreements');
  });

  // -------------------------------------------------------------------
  // Quota / validation / lifecycle guards
  // -------------------------------------------------------------------

  it('caps open asks at 10 per member per env with a teaching 429', async () => {
    for (let i = 0; i < 10; i++) {
      await postAsk(night.token, nightAskBody({ zoneId: undefined }));
    }
    const eleventh = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/asks`,
      headers: auth(night.token),
      payload: nightAskBody(),
    });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json().error.code).toBe('ASK_QUOTA_EXCEEDED');
    expect(eleventh.json().error.message).toContain('10');
    expect(eleventh.json().error.message).toContain('DELETE /api/environments/:id/asks/:askId');

    // Withdraw frees a slot (re-ask keeps the board honest).
    const open = await listAsks(night.token, 'mine');
    const withdrawn = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/asks/${open[0]!.id}`,
      headers: auth(night.token),
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().status).toBe('withdrawn');
    await postAsk(night.token, nightAskBody()); // 201 again
  });

  it('validates the closed schema with teaching errors', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...nightAskBody(), capability: 'x' }, /not recognized/],
      [{ ...nightAskBody(), semanticType: '' }, /semanticType.*non-empty/],
      [{ ...nightAskBody(), zoneId: 'zone-nope' }, /zone-nope/],
      [{ ...nightAskBody(), desiredTerms: { bogus: 1 } }, /terms\.bogus/],
      [{ ...nightAskBody(), note: 'x'.repeat(501) }, /note.*too long/],
      [{ ...nightAskBody(), expiresAt: '1999-01-01T00:00:00.000Z' }, /already in the past/],
      [
        {
          ...nightAskBody(),
          expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(),
        },
        /too far out/,
      ],
    ];
    for (const [body, pattern] of cases) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/asks`,
        headers: auth(night.token),
        payload: body,
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.message).toMatch(pattern);
    }
  });

  it('T-503 (amended by D2): zone + a never-mintable type now 201s — declared supply can match', async () => {
    // Pre-D2 this refused: zone-pinned asks could only ever match DERIVED
    // services, so a free marketing name like 'air-quality' was structurally
    // unmatchable. §11.2(6) is AMENDED (R28 D2/T-079): published/flow
    // services may DECLARE a zoneId at publish, so any type is matchable by
    // future declared supply — the refusal would block exactly the asks the
    // declaration exists to serve.
    const created = await postAsk(night.token, nightAskBody({ semanticType: 'air-quality' }));
    expect(created.status).toBe('open');

    // The zone-mintable spelling keeps passing unchanged.
    await postAsk(night.token, nightAskBody({ semanticType: 'co2-reading' }));

    // The free type stays postable env-wide (zone-less future supply).
    await postAsk(night.token, nightAskBody({ semanticType: 'air-quality', zoneId: undefined }));

    // The 'switching' collapse label and executable actuation types stay
    // postable zone-pinned (derived-lane matchability unchanged).
    await postAsk(night.token, nightAskBody({ semanticType: 'switching' }));
    await postAsk(night.token, nightAskBody({ semanticType: 'set-brightness' }));
  });

  // -------------------------------------------------------------------
  // C1 (R25-NF2, DevLoop R28): the positive-path 201 teaches matchability
  // + already-existing satisfiers (the R25 repro: an ask sat open beside a
  // service that fulfilled it until a SECOND one was minted).
  // -------------------------------------------------------------------
  it('C1: zone-pinned 201 carries zone matchability + lists already-matching services (no claim)', async () => {
    await facilityInstallsLight(); // mints the derived switching service @atrium
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/asks`,
      headers: auth(night.token),
      // autoPropose off — the preview must not depend on the auto-propose lane.
      payload: nightAskBody({ autoPropose: false }),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();

    // (a) zone matchability note rides the positive path too.
    expect(body.matchPreview.zoneMatchability).toContain('derived services');
    expect(body.matchPreview.zoneMatchability).toContain('declared the same zoneId');
    expect(body.matchPreview.zoneMatchability).toContain('strict type equality');

    // (b) the already-matching service is listed with the propose-directly move.
    expect(body.matchPreview.existingMatches).toHaveLength(1);
    const match = body.matchPreview.existingMatches[0];
    expect(match.semanticType).toBe('switching');
    expect(match.origin).toBe('derived');
    expect(match.zoneId).toBe('atrium');
    expect(match.providerName).toBe('Facility');
    expect(body.matchPreview.note).toContain('1 existing service');
    expect(body.matchPreview.note).toContain('only when a NEW service appears');
    expect(body.matchPreview.note).toContain('POST /api/services/{serviceId}/agreements');

    // Read-only preview: the ask is NOT claimed and the provider is not
    // notified (single-match semantics untouched).
    expect(body.status).toBe('open');
    expect((await notificationsOf(facility.token)).filter(n => n.kind === 'ask.matched-provider'))
      .toHaveLength(0);
  });

  it('C1: preview excludes self-assets, foreign zones, hidden services; absent when nothing matches', async () => {
    await facilityInstallsLight();

    // The PROVIDER's own ask never lists their own service (self-echo rule).
    const own = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/asks`,
      headers: auth(facility.token),
      payload: nightAskBody({ autoPropose: false }),
    });
    expect(own.statusCode).toBe(201);
    expect(own.json().matchPreview.existingMatches ?? []).toHaveLength(0);
    // The zone note still teaches (zone-pinned), but no satisfier note.
    expect(own.json().matchPreview.note).toBeUndefined();

    // Wrong zone → the atrium service does not satisfy a roof-plant ask.
    const wrongZone = await postAsk(night.token, nightAskBody({ autoPropose: false, zoneId: 'roof-plant' }));
    expect(wrongZone.matchPreview.existingMatches ?? []).toHaveLength(0);

    // Env-wide ask → no zoneMatchability note at all.
    const envWide = await postAsk(night.token, nightAskBody({ autoPropose: false, zoneId: undefined }));
    expect(envWide.matchPreview?.zoneMatchability).toBeUndefined();
    // ...but the atrium service DOES satisfy an env-wide switching ask.
    expect(envWide.matchPreview.existingMatches).toHaveLength(1);

    // Nothing matches a type nobody supplies → the whole field is absent.
    const none = await postAsk(night.token, nightAskBody({ autoPropose: false, zoneId: undefined, semanticType: 'set-fan-speed' }));
    expect(none.matchPreview).toBeUndefined();
  });

  it('T-504: a match notifies the PROVIDER too — decide lane when auto-proposed, board when not', async () => {
    // (a) autoPropose: the pre-filled proposal's decide lane rides the hint.
    const ask = await postAsk(night.token, nightAskBody());
    await facilityInstallsLight();
    const facilityInbox = await notificationsOf(facility.token);
    const providerMatched = facilityInbox.filter(n => n.kind === 'ask.matched-provider');
    expect(providerMatched).toHaveLength(1); // exactly once (one-shot)
    expect(providerMatched[0]!.refId).toBe(ask.id);
    expect(providerMatched[0]!.body).toMatchObject({
      askId: ask.id,
      semanticType: 'switching',
      askerName: 'NightWatch',
      autoPropose: 'proposed',
    });
    expect(typeof providerMatched[0]!.body.serviceName).toBe('string');
    expect(typeof providerMatched[0]!.body.agreementId).toBe('string');
    expect(providerMatched[0]!.body.replyHint).toMatchObject({ yourMove: true });
    expect(String(providerMatched[0]!.body.replyHint.endpoint)).toContain('/decide');

    // The asker side still fires exactly once — both parties, once each.
    const nightInbox = await notificationsOf(night.token);
    expect(nightInbox.filter(n => n.kind === 'ask.matched')).toHaveLength(1);

    // (b) no autoPropose: the hint points at the board (the asker's move —
    // nothing waits on the provider). Supply via the owner's direct lane
    // (device + bound agent), the same 'created' seam governance rides.
    await postAsk(night.token, nightAskBody({ zoneId: undefined, autoPropose: false }));
    const owned = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Owner Light', type: 'light', capabilities: ['lighting-control'], zoneId: 'atrium' },
    });
    expect(owned.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner Agent',
        capabilities: [],
        boundDeviceIds: [owned.json().id],
        managedZoneIds: ['atrium'],
      },
    });
    const ownerInbox = await notificationsOf(owner.token);
    const boardMatch = ownerInbox.filter(n => n.kind === 'ask.matched-provider');
    expect(boardMatch).toHaveLength(1);
    const boardHint = boardMatch[0]!.body;
    expect(boardHint.autoPropose).toBe('off');
    expect(boardHint.agreementId).toBeUndefined();
    expect(boardHint.askerName).toBe('NightWatch');
    expect(boardHint.replyHint).toMatchObject({ yourMove: false });
    expect(String(boardHint.replyHint.endpoint)).toContain('/asks');
  });

  it('withdraw is asker-only and refused after the match consumed it', async () => {
    const ask = await postAsk(night.token, nightAskBody({ zoneId: undefined }));
    // Another member (even the owner) cannot withdraw someone else's ask.
    const foreign = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/asks/${ask.id}`,
      headers: auth(owner.token),
    });
    expect(foreign.statusCode).toBe(403);

    await facilityInstallsLight();
    const after = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/asks/${ask.id}`,
      headers: auth(night.token),
    });
    expect(after.statusCode).toBe(409);
    expect(after.json().error.code).toBe('ASK_NOT_OPEN');
    expect(after.json().error.message).toContain('re-ask');

    const unknown = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/asks/00000000-0000-0000-0000-000000000000`,
      headers: auth(night.token),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('ASK_NOT_FOUND');
  });

  // -------------------------------------------------------------------
  // Bilateral privacy — the board is member-only
  // -------------------------------------------------------------------

  it('the board never leaks to non-members (even on a public env)', async () => {
    await postAsk(night.token, nightAskBody({ zoneId: undefined, note: 'private intent' }));
    const outsider = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/asks`,
      headers: auth(stranger.token),
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().error.message).toContain('member-only');
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/asks`,
    });
    expect(anonymous.statusCode).toBe(401);

    // Viewers may browse (read surface) but not ask. Joining lands the
    // builder role — the owner demotes to viewer first (house membership).
    const viewer = await registerUser(ctx.app, { displayName: 'Viewer' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(viewer.token),
    });
    const demoted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}/members/${viewer.id}`,
      headers: auth(owner.token),
      payload: { role: 'viewer' },
    });
    expect(demoted.statusCode).toBe(200);
    const view = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/asks`,
      headers: auth(viewer.token),
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().asks).toHaveLength(1);
    const viewerPost = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/asks`,
      headers: auth(viewer.token),
      payload: nightAskBody(),
    });
    expect(viewerPost.statusCode).toBe(403);
  });

  it('asks cascade with the environment (no orphans)', async () => {
    await postAsk(night.token, nightAskBody({ zoneId: undefined }));
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
    const rows = ctx.app.db
      .prepare('SELECT COUNT(*) AS n FROM standing_asks WHERE env_id = ?')
      .get(envId) as { n: number };
    expect(rows.n).toBe(0);
  });

  // -------------------------------------------------------------------
  // D2 (DevLoop R28, T-079): published services declare a zone — a
  // zone-pinned ask can match a NON-derived offer for the first time.
  // -------------------------------------------------------------------

  /** The env owner publishes an explicit offer on their own agent. */
  async function ownerPublishesService(
    body: Record<string, unknown>,
  ): Promise<{ id: string; zoneId?: string }> {
    const agentRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Ops Broker Agent', capabilities: [], boundDeviceIds: [], managedZoneIds: [] },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json().id as string;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: auth(owner.token),
      payload: body,
    });
    expect(published.statusCode, published.json()?.error?.message ?? '').toBe(201);
    return published.json() as { id: string; zoneId?: string };
  }

  it('D2: a zone-declaring PUBLISHED service matches a zone-pinned ask (single-match + notification)', async () => {
    // The previously structurally-unmatchable shape: a zone-pinned ask for a
    // free-named type no derivation can mint.
    const ask = await postAsk(night.token, nightAskBody({
      semanticType: 'air-quality',
      autoPropose: false,
    }));

    const service = await ownerPublishesService({
      name: 'Atrium Air Concierge',
      semanticType: 'air-quality',
      zoneId: 'atrium',
    });
    // Governance-visible: the publish response carries the declared zone.
    expect(service.zoneId).toBe('atrium');

    // The board matched single-shot; the asker heard about it.
    const mine = await listAsks(night.token, 'mine');
    expect(mine.find(row => row.id === ask.id)?.status).toBe('matched');
    expect(mine.find(row => row.id === ask.id)?.matchedServiceId).toBe(service.id);
    const notes = await notificationsOf(night.token);
    expect(notes.some(n => n.kind === 'ask.matched' && n.refId === service.id)).toBe(true);

    // The service list carries the declared zone too (derived rows keep
    // deriving theirs from the source device — no field for them).
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(night.token),
    });
    const listed = (services.json().services as Array<{ id: string; zoneId?: string }>)
      .find(row => row.id === service.id);
    expect(listed?.zoneId).toBe('atrium');
  });

  it('D2: an UNDECLARED published service stays zone-less — a zone-pinned ask does not match', async () => {
    // Both ask shapes BEFORE the supply arrives (matching fires at the
    // service-'created' seam).
    const ask = await postAsk(night.token, nightAskBody({
      semanticType: 'air-quality',
      autoPropose: false,
    }));
    const envWide = await postAsk(night.token, nightAskBody({
      semanticType: 'air-quality',
      zoneId: undefined,
      autoPropose: false,
    }));

    const service = await ownerPublishesService({ name: 'Air Concierge (no zone)', semanticType: 'air-quality' });
    expect(service.zoneId).toBeUndefined();

    const mine = await listAsks(night.token, 'mine');
    // Zone-pinned: undeclared = unprovable presence → no match (honest miss).
    expect(mine.find(row => row.id === ask.id)?.status).toBe('open');
    // Zone-less ask: matches the zone-less offer as before.
    expect(mine.find(row => row.id === envWide.id)?.status).toBe('matched');
    expect(mine.find(row => row.id === envWide.id)?.matchedServiceId).toBe(service.id);
  });

  it('D2: a declared zone DIFFERENT from the ask zone does not match', async () => {
    const ask = await postAsk(night.token, nightAskBody({
      semanticType: 'air-quality',
      autoPropose: false,
    }));
    const service = await ownerPublishesService({
      name: 'Roof Plant Air',
      semanticType: 'air-quality',
      zoneId: 'roof-plant',
    });
    expect(service.zoneId).toBe('roof-plant');
    const mine = await listAsks(night.token, 'mine');
    expect(mine.find(row => row.id === ask.id)?.status).toBe('open');
  });

  it('D2: publish validates the declared zone against the environment (teaching 400)', async () => {
    const agentRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Ops Broker Agent 2', capabilities: [], boundDeviceIds: [], managedZoneIds: [] },
    });
    const agentId = agentRes.json().id as string;
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'Nowhere Air', semanticType: 'air-quality', zoneId: 'zone-nope' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain('zone-nope');
    expect(refused.json().error.message).toContain('"atrium"');
  });
});
