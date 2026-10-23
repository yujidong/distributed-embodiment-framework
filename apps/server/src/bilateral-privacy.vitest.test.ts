/**
 * @vitest-environment node
 *
 * T-060 (DevLoop R14, design-consent-semantics.md §6) — bilateral privacy:
 * the agreement lifecycle's push channels align with the REST 404 boundary.
 *
 * FR-F12's original leak: "EldercareOperator agreement terminated (service
 * 跌倒检测手表…)" was readable by every env member in the activity feed, and
 * every stream subscriber received every agreement frame. Now both channels
 * are bilateral (the two parties + the env owner), and the market-temperature
 * signal returns as a non-attributed env-level count (D-4 default = offered).
 */

import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('T-060 bilateral agreement privacy (consent semantics §6)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner AND provider (owns the imported lab-agent)
  let consumer: TestUser;
  let thirdMember: TestUser; // member, never a party
  let envId: string;
  let serviceId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    thirdMember = await registerUser(ctx.app, { displayName: 'Bystander' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('bilateral-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    for (const user of [consumer, thirdMember]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
    }

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    serviceId = ((services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启'))!.id;

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = (ctx.app.server.address() as AddressInfo);
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await ctx.cleanup();
  });

  function connect(token?: string): WebSocket {
    const socket = new WebSocket(`${baseUrl}/api/environments/${envId}/stream`, {
      headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
    });
    sockets.push(socket);
    return socket;
  }

  function opened(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  }

  /** Resolves on the NEXT agreement frame, or null if `timeoutMs` passes. */
  function nextAgreementFrame(socket: WebSocket, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        socket.off('message', onMessage);
        resolve(null);
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData): void => {
        const parsed = JSON.parse(raw.toString()) as { kind?: string };
        if (parsed.kind !== 'agreement') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(parsed as Record<string, unknown>);
      };
      socket.on('message', onMessage);
    });
  }

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

  // -----------------------------------------------------------------------
  // World stream: agreement frames reach parties + owner, nobody else
  // -----------------------------------------------------------------------

  it('streams agreement frames to parties and the env owner only', async () => {
    const consumerSocket = connect(consumer.token);
    const ownerSocket = connect(owner.token);
    const thirdSocket = connect(thirdMember.token);
    const anonSocket = connect();
    await Promise.all([opened(consumerSocket), opened(ownerSocket), opened(thirdSocket), opened(anonSocket)]);

    const consumerFrame = nextAgreementFrame(consumerSocket);
    const ownerFrame = nextAgreementFrame(ownerSocket);
    const thirdFrame = nextAgreementFrame(thirdSocket);
    const anonFrame = nextAgreementFrame(anonSocket);
    const agreementId = await propose();

    expect(((await consumerFrame) ?? {}).agreementId).toBe(agreementId);
    expect(((await ownerFrame) ?? {}).agreementId).toBe(agreementId);
    // The bystander and the anonymous viewer get NOTHING — REST 404 boundary.
    expect(await thirdFrame).toBeNull();
    expect(await anonFrame).toBeNull();

    // World frames still flow to everyone (the bilateral gate is scoped to
    // agreement frames, not the whole stream) — prove with a device create.
    const worldSeen = new Promise(resolve => {
      thirdSocket.on('message', (raw: WebSocket.RawData) => {
        const parsed = JSON.parse(raw.toString()) as { kind?: string; objectType?: string };
        if (parsed.kind === 'world' && parsed.objectType === 'device') resolve(true);
      });
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Lamp', type: 'smart-light', capabilities: ['lighting-control'], zoneId: 'zone-a' },
    });
    expect(await worldSeen).toBe(true);
  });

  it('the PROVIDER (non-owner) party also receives the frames', async () => {
    // A distinct provider user owns a service of their own.
    const provider = await registerUser(ctx.app, { displayName: 'Care Team' });
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(provider.token) });
    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(provider.token),
      payload: { name: 'Nurse Bot', capabilities: [] },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    const detail = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    });
    const nurseBot = (detail.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'Nurse Bot')!;
    const service = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${nurseBot.id}/services`,
      headers: auth(provider.token),
      payload: { name: 'Ward Vitals', semanticType: 'vitals' },
    });
    expect(service.statusCode).toBe(201);
    // Back it with a computation so the propose gate opens (unbacked offers
    // refuse agreements — T-310).
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.json().id}/computation`,
      headers: auth(provider.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
      },
    });
    expect(registered.statusCode).toBe(201);

    const providerSocket = connect(provider.token);
    await opened(providerSocket);
    const frame = nextAgreementFrame(providerSocket);
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.json().id}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    expect(((await frame) ?? {}).action).toBe('proposed');
  });

  // -----------------------------------------------------------------------
  // Aggregate transparency signal (D-4 default = offered)
  // -----------------------------------------------------------------------

  it('exposes a non-attributed activeCount on the env detail', async () => {
    const before = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(thirdMember.token),
    });
    expect(before.json().agreementTransparency.activeCount).toBe(0);

    const agreementId = await propose();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    const after = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(thirdMember.token),
    });
    const transparency = after.json().agreementTransparency as { activeCount: number; note: string };
    expect(transparency.activeCount).toBe(1);
    expect(transparency.note).toContain('non-attributed');
    // The count names nobody: no party, service or agreement ids anywhere.
    expect(JSON.stringify(transparency)).not.toContain(consumer.id);
    expect(JSON.stringify(transparency)).not.toContain(owner.id);
    expect(JSON.stringify(transparency)).not.toContain(serviceId);
  });

  it('the bilateral feed gate composes with hidden services (party sees, others do not)', async () => {
    const labDetail = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    });
    const labAgentId = (labDetail.json().agents as Array<{ id: string; name: string }>)
      .find(a => a.name === 'Lab Agent')!.id;
    const hidden = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${labAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: '跌倒检测手表（101-2床）', semanticType: 'fall-detection', visibility: 'hidden' },
    });
    expect(hidden.statusCode).toBe(201);
    const agreementId = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: hidden.json().id,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: labAgentId,
      providerOwnerId: owner.id,
      terms: {},
    }).id;

    const feedOf = async (token: string): Promise<Array<{ kind: string }>> =>
      ((await ctx.app.inject({
        method: 'GET', url: `/api/environments/${envId}/activity`, headers: auth(token),
      })).json().entries as Array<{ kind: string }>);
    expect((await feedOf(consumer.token)).filter(e => e.kind === 'agreement').length).toBeGreaterThan(0);
    expect((await feedOf(thirdMember.token)).filter(e => e.kind === 'agreement')).toHaveLength(0);
    // The agreement id never appears in the bystander's feed at all.
    const bystanderRaw = await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}/activity`, headers: auth(thirdMember.token),
    });
    expect(bystanderRaw.body).not.toContain(agreementId);
  });
});
