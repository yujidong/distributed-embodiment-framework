/**
 * @vitest-environment node
 *
 * R100 (agreement-row-integrity, wang-07): the retire+unlink discipline
 * generalized to every asset deletion path — an explicit agreement row and
 * its usage ledger must NEVER be physically cascade-swallowed.
 *
 * Covered paths:
 * - owner-direct DELETE /api/devices/:id (derived rows leave through the
 *   agreement-retiring deleteService choke point);
 * - blueprint uninstall (agent deletion retires via the v60 provider lane,
 *   device deletion drops derived rows through the same choke point);
 * - the T-403 regeneration lane lives in derived-agreement-cascade.vitest.test.ts;
 *   the sim-lifecycle non-deletion proof (R99 wang-07 triage) lives in
 *   agreements.vitest.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('R100: agreement rows survive every asset deletion path (retire + unlink)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Integrity Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
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

  /** Consumer proposes on the service; the provider owner accepts → active. */
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

  function appendUsageRow(agreementId: string, providerAgentId: string): void {
    ctx.app.agreementStore.appendUsage({
      agreementId,
      envId,
      consumerAgentId: null,
      providerAgentId,
      kind: 'invoke',
      action: 'turn-on',
      quantity: 1,
      unit: 'action',
      outcome: 'success',
      effectRef: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
  }

  async function retiredView(agreementId: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      status: string;
      statusReason?: string;
      serviceId: string | null;
      providerAgentId: string | null;
    };
  }

  it('owner-direct device DELETE: the agreement on its derived service retires (suspended + service-unavailable), the usage ledger survives', async () => {
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Hall Lamp', type: 'light', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });
    expect(device.statusCode).toBe(201);
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Lamp Agent', capabilities: ['turn-on'], boundDeviceIds: [device.json().id] },
    });
    expect(agent.statusCode).toBe(201);
    const service = ctx.app.serviceStore
      .servicesOfAgent(agent.json().id)
      .find(row => row.origin === 'derived' && row.semantic_type === 'turn-on');
    expect(service).toBeDefined();
    const agreementId = await activeAgreementOn(service!.id);
    appendUsageRow(agreementId, agent.json().id);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${device.json().id}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);

    // R100: retired, not swallowed — row + ledger fully readable.
    const retired = await retiredView(agreementId);
    expect(retired.status).toBe('suspended');
    expect(retired.statusReason).toBe('service-unavailable');
    expect(retired.serviceId).toBeNull();
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toHaveLength(1);
  });

  it('blueprint uninstall: agreements on the installed agent\'s services retire via the provider lane (provider-unavailable, refs nulled)', async () => {
    const installed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/classroom-energy-saver/install`,
      headers: auth(owner.token),
      payload: { zoneId: 'zone-a' },
    });
    expect(installed.statusCode).toBe(201);
    const agentId = installed.json().createdIds.agents[0] as string;
    // Mint derived rows for the installed agent (the interactive install
    // lane syncs on demand; the test mints explicitly).
    ctx.app.serviceStore.syncDerivedForAgent(agentId);
    const service = ctx.app.serviceStore
      .servicesOfAgent(agentId)
      .find(row => row.origin === 'derived');
    expect(service).toBeDefined();
    const agreementId = await activeAgreementOn(service!.id);
    appendUsageRow(agreementId, agentId);

    const uninstalled = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/blueprints/classroom-energy-saver/instances`,
      headers: auth(owner.token),
    });
    expect(uninstalled.statusCode).toBe(200);
    expect(uninstalled.json().summary.agents).toBe(1);

    // R100: the provider-agent removal retires via the v60 lane —
    // suspended, provider-unavailable, BOTH refs unlinked; ledger survives.
    const retired = await retiredView(agreementId);
    expect(retired.status).toBe('suspended');
    expect(retired.statusReason).toBe('provider-unavailable');
    expect(retired.serviceId).toBeNull();
    expect(retired.providerAgentId).toBeNull();
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toHaveLength(1);
  });
});
