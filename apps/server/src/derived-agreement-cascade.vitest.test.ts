/**
 * @vitest-environment node
 *
 * T-403 (DevLoop R19, NW-F03) + R100 (agreement-row-integrity, wang-07):
 * derivation-sync agreement honesty.
 *
 * A modify-object capability patch (or owner-direct PATCH) regenerates a
 * device's derived services; rows whose (device, semanticType) key left the
 * expected set are deleted. Pre-R100 `service_agreements.service_id … ON
 * DELETE CASCADE` physically DESTROYED every agreement riding them (the
 * 404 was "truthful" and the ledger was gone). R100 closes the hole at the
 * choke point: ServiceStore.deleteService RETIRES + UNLINKS the agreements
 * first (v60 discipline generalized to service rows) — active/held →
 * suspended, pending → rejected, AC → terminated, all with
 * status_reason 'service-unavailable' — so the row and its usage/receipts
 * ledger SURVIVE. What this suite pins:
 *
 * - rule check: non-blocking warnings name the retiring ACTIVE agreements;
 *   CROSS-PARTY ones force-escalate to the env owner;
 * - apply time (proposal + owner-direct PATCH): each consumer of a live
 *   retired agreement gets an `agreement.derived-regenerated` notification
 *   with the LANDED status + reason + successor semantic types;
 * - the retired row keeps reading (200, suspended, serviceId null), usage
 *   rows survive;
 * - revert path unaffected (services regenerate; no crash);
 * - patches that delete nothing change nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('T-403: derivation-sync agreement cascade honesty', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let agentSeq = 0;

  beforeEach(async () => {
    // Auto-approve low-risk proposals so the SELF-PARTY case exercises the
    // auto-apply path (cross-party cases force-escalate regardless).
    ctx = await makeTestApp({ proposalReviewTimeoutAutoApprove: true });
    owner = await registerUser(ctx.app, { displayName: 'Night Watch' });
    consumer = await registerUser(ctx.app, { displayName: 'Corner Cafe' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'cascade-lab', name: 'Cascade Lab', description: 'T-403 fixture' },
        zones: [{ id: 'zone-a', baseline: { temperature: 22 } }],
        devices: [],
        agents: [],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function installDevice(name: string, capabilities: string[]): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name, type: 'light', capabilities, zoneId: 'zone-a' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function installAgent(deviceId: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: `Agent ${++agentSeq}`,
        capabilities: [],
        boundDeviceIds: [deviceId],
        managedZoneIds: ['zone-a'],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  function derivedService(agentId: string, semanticType: string) {
    return ctx.app.serviceStore
      .servicesOfAgent(agentId)
      .find(row => row.origin === 'derived' && row.semantic_type === semanticType);
  }

  /** Consumer proposes on the service; the provider owner accepts. */
  async function activeAgreementOn(serviceId: string): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: {} },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
    return agreementId;
  }

  function submitModify(deviceId: string, capabilities: string[]) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(owner.token),
      payload: {
        kind: 'modify-object',
        payload: { targetId: deviceId, patch: { capabilities } },
      },
    });
  }

  async function notificationsOf(token: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(token),
    });
    return res.json().notifications as Array<{
      kind: string;
      refId: string | null;
      body: Record<string, unknown>;
    }>;
  }

  function derivedRegeneratedOf(rows: Array<{ kind: string }>) {
    return rows.filter(row => row.kind === 'agreement.derived-regenerated');
  }

  it('cross-party: warning + force-escalate, then consumer notification with successor hints; the 404 stays truthful', async () => {
    const deviceId = await installDevice('Floodlight', ['turn-on', 'turn-off']);
    const agentId = await installAgent(deviceId);
    const turnOff = derivedService(agentId, 'turn-off');
    expect(turnOff).toBeDefined();
    const agreementId = await activeAgreementOn(turnOff!.id);

    // The night's routine patch — dropping turn-off regenerates the derived
    // rows; the turn-off row (and its agreement) cascade away.
    const submitted = await submitModify(deviceId, ['turn-on']);
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    // Cross-party harm → owner review, not auto-apply.
    expect(proposal.status).toBe('escalated');
    expect(proposal.ruleCheck.forceEscalate).toBe(true);
    expect(proposal.ruleCheck.warnings.join(' ')).toContain(agreementId);
    expect(proposal.ruleCheck.warnings.join(' ')).toContain('Floodlight');

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');

    // R100: the agreement SURVIVES the regeneration — retired to suspended
    // with status_reason 'service-unavailable', unlinked from the dead
    // service row, fully readable by its consumer (never a fake 404).
    const retired = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(consumer.token),
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().status).toBe('suspended');
    expect(retired.json().statusReason).toBe('service-unavailable');
    expect(retired.json().serviceId).toBeNull();

    // ...and the consumer HEARS about it: doorbell + the landed status +
    // successor map.
    const notices = derivedRegeneratedOf(await notificationsOf(consumer.token));
    expect(notices).toHaveLength(1);
    expect(notices[0].refId).toBe(agreementId);
    expect(notices[0].body.reason).toBe('derived-service-regenerated');
    expect(notices[0].body.status).toBe('suspended');
    expect(notices[0].body.statusReason).toBe('service-unavailable');
    expect(notices[0].body.agreementId).toBe(agreementId);
    expect(notices[0].body.serviceId).toBe(turnOff!.id);
    expect(notices[0].body.proposalId).toBe(proposal.id);
    // Nothing was created by this sync — the successor list is empty.
    expect(notices[0].body.successorSemanticTypes).toEqual([]);
    // The derived row is gone.
    expect(derivedService(agentId, 'turn-off')).toBeUndefined();
  });

  it('R100: the usage ledger survives the retirement (reconciliation after service loss)', async () => {
    const deviceId = await installDevice('Meter', ['turn-on', 'turn-off']);
    const agentId = await installAgent(deviceId);
    const turnOff = derivedService(agentId, 'turn-off');
    const agreementId = await activeAgreementOn(turnOff!.id);
    // One metered invoke on the active agreement (registry lane — direct
    // store append keeps the fixture light; the ledger shape is the same).
    ctx.app.agreementStore.appendUsage({
      agreementId,
      envId,
      consumerAgentId: null,
      providerAgentId: agentId,
      kind: 'invoke',
      action: 'turn-off',
      quantity: 1,
      unit: 'action',
      outcome: 'success',
      effectRef: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    const submitted = await submitModify(deviceId, ['turn-on']);
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${submitted.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');

    // The usage row did NOT cascade away with the service row.
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toHaveLength(1);
    expect(usage.json().usage[0].action).toBe('turn-off');
    // …and the retired row itself stays readable.
    const retired = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(consumer.token),
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().status).toBe('suspended');
  });

  it('successor hints: a swap (turn-on → turn-off) names the created semantic type', async () => {
    const deviceId = await installDevice('Pump', ['turn-on']);
    const agentId = await installAgent(deviceId);
    const turnOn = derivedService(agentId, 'turn-on');
    const agreementId = await activeAgreementOn(turnOn!.id);

    const submitted = await submitModify(deviceId, ['turn-off']);
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${submitted.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');

    const notices = derivedRegeneratedOf(await notificationsOf(consumer.token));
    expect(notices).toHaveLength(1);
    expect(notices[0].refId).toBe(agreementId);
    expect(notices[0].body.successorSemanticTypes).toEqual(['turn-off']);
    expect(derivedService(agentId, 'turn-off')).toBeDefined();
  });

  it('self-party: auto-applies WITH the warning; the author\'s own inbox stays quiet (self-echo suppression)', async () => {
    const deviceId = await installDevice('Lamp', ['turn-on', 'turn-off']);
    const agentId = await installAgent(deviceId);
    const turnOff = derivedService(agentId, 'turn-off');

    // The night's own contract: the author is the consumer too.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOff!.id}/agreements`,
      headers: auth(owner.token),
      payload: { terms: {} },
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

    const submitted = await submitModify(deviceId, ['turn-on']);
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    // Self-party harm stays on the normal funnel — low risk auto-applies.
    expect(proposal.status).toBe('applied');
    expect(proposal.ruleCheck.forceEscalate).toBe(false);
    expect(proposal.ruleCheck.warnings.join(' ')).toContain(agreementId);
    // The actor IS the consumer — notify() self-echo suppression applies
    // (T-049 shape); the warning on the proposal is the notice.
    expect(derivedRegeneratedOf(await notificationsOf(owner.token))).toHaveLength(0);
  });

  it('the owner-direct PATCH fires the same notification (no proposal involved)', async () => {
    const deviceId = await installDevice('Fan', ['turn-on', 'turn-off']);
    const agentId = await installAgent(deviceId);
    const turnOff = derivedService(agentId, 'turn-off');
    const agreementId = await activeAgreementOn(turnOff!.id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      headers: auth(owner.token),
      payload: { capabilities: ['turn-on'] },
    });
    expect(patched.statusCode).toBe(200);

    const notices = derivedRegeneratedOf(await notificationsOf(consumer.token));
    expect(notices).toHaveLength(1);
    expect(notices[0].body.reason).toBe('derived-service-regenerated');
    expect(notices[0].body.statusReason).toBe('service-unavailable');
    expect(notices[0].body.proposalId).toBeUndefined();
    // R100: retired, not destroyed — the row keeps reading.
    const retired = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(consumer.token),
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().status).toBe('suspended');
    expect(retired.json().statusReason).toBe('service-unavailable');
  });

  it('revert still works after a cascade apply, and a no-op patch changes nothing', async () => {
    const deviceId = await installDevice('Sign', ['turn-on', 'turn-off']);
    const agentId = await installAgent(deviceId);
    const turnOff = derivedService(agentId, 'turn-off');
    await activeAgreementOn(turnOff!.id);

    // A patch that deletes nothing (rename): applied, no notifications, no
    // service loss.
    const renamed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(owner.token),
      payload: {
        kind: 'modify-object',
        payload: { targetId: deviceId, patch: { name: 'Sign Prime' } },
      },
    });
    expect(renamed.json().status).toBe('applied');
    expect(renamed.json().ruleCheck.warnings).toHaveLength(0);
    expect(derivedRegeneratedOf(await notificationsOf(consumer.token))).toHaveLength(0);
    expect(derivedService(agentId, 'turn-off')).toBeDefined();

    // Cascade apply, then revert: the device row restores and the sync
    // regenerates the derived service. The retired agreement stays retired
    // (suspended, unlinked — R100 keeps the row and its ledger; no service
    // lane relinks contracts automatically, same "no auto-resume" discipline
    // as the v60 provider lane).
    const submitted = await submitModify(deviceId, ['turn-on']);
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${submitted.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    expect(derivedService(agentId, 'turn-off')).toBeUndefined();

    const reverted = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${submitted.json().id}/revert`,
      headers: auth(owner.token),
    });
    expect(reverted.statusCode, JSON.stringify(reverted.json())).toBe(200);
    expect(reverted.json().status).toBe('reverted');
    expect(derivedService(agentId, 'turn-off')).toBeDefined();
  });
});
