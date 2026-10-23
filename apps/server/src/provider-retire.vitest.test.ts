/**
 * @vitest-environment node
 *
 * v60 (R6-E-F08, data/usertest-r6/track-e-capability.md §3): provider-agent
 * removal RETIRES its agreements instead of letting the FK cascade destroy
 * them — docs/lifecycles/agreement.md「死亡语义」is the spec:
 *
 * - explicit active/held → suspended, pending offers (proposed/countered) →
 *   rejected, ephemeral AC active → terminated — all with
 *   status_reason='provider-unavailable'; every row (terminated history
 *   included) is UNLINKED (service_id/provider_agent_id → NULL) so the
 *   cascades delete nothing and the ledger survives;
 * - world visibility: consumer doorbell (agreement.provider-removed),
 *   agreement-transition audit rows, and the env-owner-only
 *   providerUnavailableAgreements section of the arrival digest;
 * - NO auto-resume anywhere (no suspended → active edge); the explicit
 *   closing channel is terminate — extended to the env owner (both parties
 *   notified when the owner acts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NOTIFICATION_KINDS } from './notifications.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('v60 (R6-E-F08): provider-agent removal retires, never destroys', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let serviceId: string;
  let providerAgentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('provider-retire-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
    expect(joined.statusCode).toBe(200);
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    expect(turnOn).toBeTruthy();
    serviceId = turnOn!.id;
    providerAgentId = ctx.app.serviceStore.getService(serviceId)!.provider_agent_id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function propose(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function decide(id: string, decision: 'accept' | 'reject', token = owner.token) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/decide`,
      headers: auth(token),
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
    return res;
  }

  function providerRemovedNotifications(userId: string, agreementId: string) {
    return ctx.app.notificationStore
      .listForUser(userId, { limit: 500 })
      .filter(row => row.kind === NOTIFICATION_KINDS.agreementProviderRemoved && row.ref_id === agreementId);
  }

  it('direct DELETE retires every live agreement, unlinks all rows, and preserves terminated history', async () => {
    const active = await propose();
    await decide(active, 'accept');
    const pending = await propose();
    const countered = await propose();
    const counter = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${countered}/counter`,
      headers: auth(owner.token),
      payload: { terms: { notes: 'retire-test counter' } },
    });
    expect(counter.statusCode).toBe(200);
    const held = await propose();
    await decide(held, 'accept');
    const hold = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${held}/hold`,
      headers: auth(consumer.token),
      payload: { durationSec: 3600 },
    });
    expect(hold.statusCode).toBe(200);
    const history = await propose();
    await decide(history, 'accept');
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${history}/terminate`,
      headers: auth(consumer.token),
    });
    expect(terminated.statusCode).toBe(200);
    // An ephemeral AC agreement (born active) of the same provider.
    const ac = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId,
      providerOwnerId: owner.id,
      terms: {},
      source: 'ac',
      status: 'active',
      collaborationId: 'ac-retire-test',
    });

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${providerAgentId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect(ctx.app.envStore.getAgent(providerAgentId)).toBeUndefined();

    const rows = Object.fromEntries(
      [active, pending, countered, held, history, ac.id]
        .map(id => [id, ctx.app.agreementStore.getAgreement(id)] as const),
    );
    // Nothing was destroyed — every row survives, unlinked.
    for (const id of [active, pending, countered, held, history, ac.id]) {
      expect(rows[id], `agreement ${id} survives the provider removal`).toBeDefined();
      expect(rows[id]!.service_id).toBeNull();
      expect(rows[id]!.provider_agent_id).toBeNull();
    }
    expect(rows[active]!.status).toBe('suspended');
    expect(rows[active]!.status_reason).toBe('provider-unavailable');
    expect(rows[pending]!.status).toBe('rejected');
    expect(rows[pending]!.status_reason).toBe('provider-unavailable');
    expect(rows[countered]!.status).toBe('rejected');
    expect(rows[countered]!.status_reason).toBe('provider-unavailable');
    // A held row lands suspended with the hold settled (the resume+suspend
    // net effect — no new lifecycle edge).
    expect(rows[held]!.status).toBe('suspended');
    expect(rows[held]!.hold_expires_at).toBeNull();
    expect(rows[held]!.status_reason).toBe('provider-unavailable');
    // Ephemeral AC terminates (born-active, ends terminated; unmetered →
    // 'cancelled' per the shared terminatedAgreementOutcome 口径).
    expect(rows[ac.id]!.status).toBe('terminated');
    expect(rows[ac.id]!.status_reason).toBe('provider-unavailable');
    // Terminated HISTORY is preserved untouched (no reason rewrite).
    expect(rows[history]!.status).toBe('terminated');
    expect(rows[history]!.status_reason).toBeNull();

    // The consumer got a doorbell per retired live agreement — none for the
    // already-terminal history row.
    for (const id of [active, pending, countered, held, ac.id]) {
      expect(
        providerRemovedNotifications(consumer.id, id).length,
        `provider-removed notification for ${id}`,
      ).toBeGreaterThan(0);
    }
    expect(providerRemovedNotifications(consumer.id, history)).toHaveLength(0);

    // The retired row still serializes (consumer view): null refs + the
    // incremental statusReason field.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${active}`,
      headers: auth(consumer.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('suspended');
    expect(detail.json().statusReason).toBe('provider-unavailable');
    expect(detail.json().serviceId).toBeNull();
    expect(detail.json().providerAgentId).toBeNull();

    // A2 parity: a suspended agreement never meters invokes.
    const invoke = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${active}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on' },
    });
    expect(invoke.statusCode).toBe(409);
    expect(invoke.json().error.code).toBe('AGREEMENT_NOT_ACTIVE');

    // The audit trail carries one agreement-transition row per retire.
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log`,
      headers: auth(owner.token),
    });
    const transitions = (log.json().entries as Array<{ kind: string; payload: { agreementId?: string; to?: string; reason?: string } }>)
      .filter(entry => entry.kind === 'agreement-transition' && entry.payload.reason === 'provider-unavailable');
    expect(transitions.map(entry => entry.payload.agreementId).sort())
      .toEqual([ac.id, active, countered, held, pending].sort());
  });

  it('arrival digest surfaces provider-unavailable agreements to the ENV OWNER only (memo invalidated by the retire)', async () => {
    const active = await propose();
    await decide(active, 'accept');

    // Freeze today's memo BEFORE the removal: the section is empty.
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().providerUnavailableAgreements).toEqual([]);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${providerAgentId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);

    // Same day, same viewer — the retire stamp expires the frozen memo and
    // the owner sees the parked contract (the R5-F07 signal pattern).
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    expect(after.statusCode).toBe(200);
    const entries = after.json().providerUnavailableAgreements as Array<{
      agreementId: string; reason: string; provider: { agentId: string | null };
    }>;
    expect(entries.map(entry => entry.agreementId)).toContain(active);
    const entry = entries.find(candidate => candidate.agreementId === active)!;
    expect(entry.reason).toBe('provider-unavailable');
    expect(entry.provider.agentId).toBeNull();

    // The consumer (a party, but NOT the env owner) gets the empty section —
    // their doorbell was the notification, not the owner's work queue.
    const consumerDigest = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(consumer.token),
    });
    expect(consumerDigest.statusCode).toBe(200);
    expect(consumerDigest.json().providerUnavailableAgreements).toEqual([]);
  });

  it('no auto-resume: nothing revives a retired agreement (no suspended → active edge)', async () => {
    const active = await propose();
    await decide(active, 'accept');
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${providerAgentId}`,
      headers: auth(owner.token),
    });
    expect(ctx.app.agreementStore.getAgreement(active)!.status).toBe('suspended');

    // A "revived" provider (a fresh agent under the same owner) changes
    // nothing — revival is an explicit human decision, never a side effect.
    const recreated = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Revived Provider', capabilities: [], boundDeviceIds: [] },
    });
    expect(recreated.statusCode).toBe(201);
    expect(ctx.app.agreementStore.getAgreement(active)!.status).toBe('suspended');

    // The provider owner alone cannot resume either (the documented
    // asymmetry): their suspend lane refuses a non-active row…
    const suspend = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${active}/suspend`,
      headers: auth(owner.token),
    });
    expect(suspend.statusCode).toBe(409);
    // …and the explicit closing channel (terminate) works for a party.
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${active}/terminate`,
      headers: auth(consumer.token),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('terminated');
    expect(ctx.app.agreementStore.getAgreement(active)!.status_reason).toBeNull();
  });
});

describe('v60 (R6-E-F08): env owner is the closer of last resort', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Retire Governance Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function submitProposal(token: string, kind: string, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(token),
      payload: { kind, payload },
    });
  }

  function decideProposal(token: string, proposalId: string, decision: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/decide`,
      headers: auth(token),
      payload: { decision },
    });
  }

  it('env owner terminates a retired agreement; BOTH parties are notified', async () => {
    // Builder-owned device + agent through the governance pipeline.
    const deviceProposal = await submitProposal(builder.token, 'install-devices', {
      devices: [
        { name: 'Corridor Sensor', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
      ],
    });
    await decideProposal(owner.token, deviceProposal.json().id, 'approved');
    const device = ctx.app.envStore.devicesOf(envId).at(-1)!;
    const agentProposal = await submitProposal(builder.token, 'install-agents', {
      agents: [
        { name: 'Doomed Provider', capabilities: ['temperature-monitoring'], boundDeviceIds: [device.id] },
      ],
    });
    await decideProposal(owner.token, agentProposal.json().id, 'approved');
    const agent = ctx.app.envStore.agentsOf(envId).find(row => row.name === 'Doomed Provider')!;
    const service = ctx.app.serviceStore.servicesOfAgent(agent.id).at(-1)!;

    // Viewer (consumer) contracts with the builder's provider agent.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/agreements`,
      headers: auth(viewer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(builder.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.json().status).toBe('active');

    // The provider agent is removed through the pipeline → the agreement is
    // retired (suspended, provider-unavailable), not destroyed.
    const removal = await submitProposal(builder.token, 'remove-agents', { agentIds: [agent.id] });
    const applied = await decideProposal(owner.token, removal.json().id, 'approved');
    expect(applied.json().status).toBe('applied');
    const retired = ctx.app.agreementStore.getAgreement(agreementId)!;
    expect(retired.status).toBe('suspended');
    expect(retired.status_reason).toBe('provider-unavailable');

    // The env owner — neither party — closes the parked contract.
    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/terminate`,
      headers: auth(owner.token),
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('terminated');

    // BOTH parties learn the env owner's termination.
    for (const userId of [builder.id, viewer.id]) {
      const hit = ctx.app.notificationStore.latestOfKind(
        userId,
        NOTIFICATION_KINDS.agreementTerminated,
        agreementId,
      );
      expect(hit, `agreement.terminated notification reaches ${userId}`).toBeDefined();
    }
    // And the digest section no longer parks the closed row.
    const digest = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    const parked = (digest.json().providerUnavailableAgreements as Array<{ agreementId: string }>)
      .map(entry => entry.agreementId);
    expect(parked).not.toContain(agreementId);
  });
});
