/**
 * @vitest-environment node
 *
 * D4 (DevLoop R28, T-081) — the auto-minted read lane on derived telemetry.
 *
 * When a derived service's source device has a readable parameter that maps
 * to a computation metric, the derivation sync auto-registers a minimal
 * device-aggregate ComputationSpec over that single device (the T-065
 * per-bed pattern generalized) — removing the double ceremony for "I want
 * to read my sensor's data as a service". The mint is marked autoMinted;
 * the provider may override it with an explicit registration; devices
 * without readable params keep the SERVICE_DERIVED_READONLY boundary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auth, makeTestApp, registerUser, type TestAppContext, type TestUser } from './test-utils.js';

describe('derived telemetry auto-mint (D4, T-081)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let providerAgentId: string;
  let watchDeviceId: string;
  let heartRateServiceId: string;
  let batteryServiceId: string;
  let hvacServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Ward Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Night Nurse' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'ward-automint', name: 'Ward (auto-mint)', description: 'fixture' },
        zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
        devices: [
          {
            id: 'watch-bed-1',
            name: 'Vitals Watch Bed 1',
            type: 'watch',
            capabilities: ['heart-rate-reading', 'battery-reading'],
            zoneId: 'zone-a',
            // heartRate maps to heart-rate-reading; battery to
            // battery-reading; steps maps to NEITHER (capability isolation).
            initialState: { heartRate: 72, battery: 88, steps: 3000 },
          },
          {
            id: 'hvac-b',
            name: 'HVAC B',
            type: 'hvac',
            capabilities: ['turn-on', 'turn-off'],
            zoneId: 'zone-a',
            // no initialState → no readable params → no mint.
          },
        ],
        agents: [{
          id: 'ward-bot',
          name: 'Ward Bot',
          capabilities: [],
          managesZoneIds: ['zone-a'],
          boundDeviceIds: ['watch-bed-1', 'hvac-b'],
        }],
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    const detail = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json();
    const agent = (detail.agents as Array<{ id: string; name: string }>)
      .find(row => row.name === 'Ward Bot')!;
    providerAgentId = agent.id;
    watchDeviceId = (detail.devices as Array<{ id: string; name: string }>)
      .find(row => row.name === 'Vitals Watch Bed 1')!.id;

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const rows = services.json().services as Array<{
      id: string; name: string; interface: { dataSchema?: { fields: Array<{ name: string }> } };
      computation?: { autoMinted?: boolean; kind: string };
    }>;
    heartRateServiceId = rows.find(row => row.name.includes('heart-rate'))!.id;
    batteryServiceId = rows.find(row => row.name.includes('battery'))!.id;
    // Derived row labels localize the command ("HVAC B: 开启").
    hvacServiceId = rows.find(row => row.name.startsWith('HVAC B:'))!.id;
    expect(heartRateServiceId).toBeDefined();
    expect(batteryServiceId).toBeDefined();
    expect(hvacServiceId).toBeDefined();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function computationOf(token: string, serviceId: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().computation as null | {
      kind: string;
      spec: Record<string, unknown> & { autoMinted?: boolean };
    };
  }

  it('mints a minimal device-aggregate over the single source device at derivation time', async () => {
    const computation = await computationOf(owner.token, heartRateServiceId);
    expect(computation).not.toBeNull();
    expect(computation!.kind).toBe('device-aggregate');
    expect(computation!.spec.autoMinted).toBe(true);
    expect(computation!.spec.devices).toEqual([watchDeviceId]);
    expect(computation!.spec.metrics).toEqual([
      {
        source: 'device',
        capability: 'heart-rate-reading',
        path: 'heartRate',
        fn: 'avg',
        as: 'heartRate',
      },
    ]);

    // The service summary is governance-visible with the mint marker, and
    // the generated interface carries the matching dataSchema.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const row = (services.json().services as Array<{
      id: string;
      computation?: { autoMinted?: boolean };
      interface: { dataSchema?: { fields: Array<{ name: string; type: string }> } };
    }>).find(service => service.id === heartRateServiceId)!;
    expect(row.computation?.autoMinted).toBe(true);
    expect(row.interface.dataSchema?.fields).toEqual([{ name: 'heartRate', type: 'number' }]);
  });

  it('isolates capabilities: the heart-rate mint exposes heartRate only; the battery mint exposes battery', async () => {
    const heart = await computationOf(owner.token, heartRateServiceId);
    const battery = await computationOf(owner.token, batteryServiceId);
    // 'steps' maps to neither capability; each service mints only its own.
    expect((heart!.spec.metrics as Array<{ as: string }>).map(m => m.as)).toEqual(['heartRate']);
    expect((battery!.spec.metrics as Array<{ as: string }>).map(m => m.as)).toEqual(['battery']);
  });

  it('devices without readable params mint nothing — SERVICE_DERIVED_READONLY stays', async () => {
    expect(await computationOf(owner.token, hvacServiceId)).toBeNull();
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${hvacServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: '*',
          metrics: [{ source: 'device', capability: 'turn-on', fn: 'count', as: 'count' }],
        },
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SERVICE_DERIVED_READONLY');
    expect(refused.json().error.message).toContain('no auto-minted read lane to override');
  });

  it('the auto-mint opens the read lane end-to-end — and T54: a value read off NEVER-WRITTEN device state refuses as a placeholder (409 + failure + agreement alive)', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${heartRateServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['heartRate'] } } },
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

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(consumer.token),
      payload: { environmentId: envId },
    });
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(consumer.token),
      payload: {},
    });

    // T54 (R6, u4-F1): the watch's heartRate has sat at the scenario
    // initialState (72) since construction — no command, tick write-back, or
    // physics effect ever wrote it. A "successful" 72 bpm delivery would be
    // the same fabricated reading as u4's power=0 meter; the read refuses.
    const read = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/reads`,
      headers: auth(consumer.token),
      payload: { simulationId: simId },
    });
    expect(read.statusCode).toBe(409);
    expect(read.json().error.code).toBe('COMPUTATION_DEVICE_STATE_UNWRITTEN');
    expect(read.json().error.fields).toEqual(['heartRate']);
    expect(read.json().error.message).toContain('placeholder');
    expect(read.json().error.message).toContain('NOT terminated');
    expect(read.json().error.message).toContain('POST /api/services/:id/computation');
    // Metered as a FAILURE read row (audit trail) — and no receipt burned.
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.json().usage).toEqual([
      expect.objectContaining({ kind: 'read', outcome: 'failure' }),
    ]);
    // The contract does not silently die (termination stays bilateral).
    expect((await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${agreementId}`, headers: auth(consumer.token),
    })).json().status).toBe('active');
  });

  it('the provider OVERRIDES the mint with an explicit registration (replaces it)', async () => {
    const overridden = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${heartRateServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 30,
        inputs: {
          zones: '*',
          devices: [watchDeviceId],
          metrics: [
            { source: 'device', capability: 'heart-rate-reading', path: 'heartRate', fn: 'max', as: 'peakHeartRate' },
          ],
        },
        interface: { dataSchema: { fields: [{ name: 'peakHeartRate', type: 'number' }] } },
      },
    });
    expect(overridden.statusCode, overridden.json()?.error?.message ?? '').toBe(201);
    const computation = await computationOf(owner.token, heartRateServiceId);
    expect(computation!.spec.autoMinted).toBeUndefined(); // the mint is GONE
    expect(computation!.spec.metrics).toEqual([
      expect.objectContaining({ fn: 'max', as: 'peakHeartRate' }),
    ]);

    // The override owns the interface: a re-sync does not clobber it back.
    ctx.app.serviceStore.syncDerivedForAgent(providerAgentId);
    const after = await computationOf(owner.token, heartRateServiceId);
    expect(after!.spec.autoMinted).toBeUndefined();
    expect(after!.spec.metrics).toEqual([expect.objectContaining({ as: 'peakHeartRate' })]);
  });

  it('revoking the mint is final: a re-sync does not resurrect it (and drops the dataSchema)', async () => {
    const revoked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${heartRateServiceId}/computation`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(await computationOf(owner.token, heartRateServiceId)).toBeNull();

    ctx.app.serviceStore.syncDerivedForAgent(providerAgentId);
    expect(await computationOf(owner.token, heartRateServiceId)).toBeNull();

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const row = (services.json().services as Array<{
      id: string; interface: { dataSchema?: unknown };
    }>).find(service => service.id === heartRateServiceId)!;
    expect(row.interface.dataSchema).toBeUndefined();
  });
});
