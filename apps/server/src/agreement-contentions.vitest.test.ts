/**
 * @vitest-environment node
 *
 * D1 (DevLoop R28, T-085 / GO26-F04) — contended device-param contracts.
 *
 * Two or more ACTIVE agreements whose trigger automation writes the same
 * (deviceId, param) pair contend. The ruling: DETECT + WARN, never block —
 * last-writer-wins stays, the warning is the remedy. This suite pins the
 * three visibility surfaces:
 * 1. the ACCEPT-time response names the other active agreement(s);
 * 2. GET /api/agreements/:id carries the same contentions array;
 * 3. at trigger EXECUTION time the command_log payload carries the
 *    contention (both agreementIds visible).
 * Plus the honest negatives: different params → no contention; a terminated
 * other agreement stops contending.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('agreement device-param contentions (D1, T-085)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumerA: TestUser;
  let consumerB: TestUser;
  let envId: string;
  let serviceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumerA = await registerUser(ctx.app, { displayName: 'Consumer A' });
    consumerB = await registerUser(ctx.app, { displayName: 'Consumer B' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('contention-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    for (const consumer of [consumerA, consumerB]) {
      const joined = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(consumer.token),
      });
      expect(joined.statusCode).toBe(200);
    }

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    serviceId = turnOn!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Propose a trigger-action agreement as `consumer`; return its id. */
  async function propose(
    consumer: TestUser,
    terms: Record<string, unknown>,
  ): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms },
    });
    expect(proposed.statusCode).toBe(201);
    return proposed.json().id as string;
  }

  async function accept(agreementId: string): Promise<Record<string, unknown>> {
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    return decided.json();
  }

  const heatWaveTrigger = {
    eventType: 'temperature-spike',
    zoneId: 'zone-a',
    parameter: 'temperature',
    threshold: 30,
  };

  it('the SECOND accept carries contentions naming the first active agreement', async () => {
    const first = await propose(consumerA, {
      notes: 'heat wave → turn HVAC on',
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    const firstAccept = await accept(first);
    expect(firstAccept.status).toBe('active');
    expect(firstAccept.contentions).toBeUndefined(); // nothing to contend YET
    // The imported scenario remaps device/agent ids — the backing ids are canonical.
    const deviceId = firstAccept.backingDeviceId as string;
    const providerAgentId = firstAccept.providerAgentId as string;
    expect(deviceId).toBeTruthy();

    const second = await propose(consumerB, {
      notes: 'my own heat-wave automation on the same unit',
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    const secondAccept = await accept(second);
    expect(secondAccept.status).toBe('active');
    // Parameterless turn-on actions contend on the whole device state ('*').
    expect(secondAccept.contentions).toEqual([
      expect.objectContaining({
        agreementId: first,
        deviceId,
        param: '*',
        providerAgentId,
        providerAgentName: 'Lab Agent',
        serviceId,
      }),
    ]);
    // Provider identity is the owner ref (both parties can chase the race).
    const contention = (secondAccept.contentions as Array<{ provider: { id: string } }>)[0];
    expect(contention.provider.id).toBe(owner.id);
  });

  it('GET /api/agreements/:id carries the contention for BOTH parties', async () => {
    const first = await propose(consumerA, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    const firstAccept = await accept(first);
    const deviceId = firstAccept.backingDeviceId as string;
    const second = await propose(consumerB, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(second);

    for (const [reader, agreementId, otherId] of [
      [consumerA, first, second],
      [consumerB, second, first],
    ] as const) {
      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements/${agreementId}`,
        headers: auth(reader.token),
      });
      expect(detail.statusCode).toBe(200);
      const contentions = detail.json().contentions as Array<{ agreementId: string }>;
      expect(contentions).toEqual([
        expect.objectContaining({ agreementId: otherId, deviceId, param: '*' }),
      ]);
    }
  });

  it('agreements writing DIFFERENT params on the same device do not contend', async () => {
    await accept(await propose(consumerA, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on', params: { gentle: true } },
    }));
    const second = await propose(consumerB, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on', params: { boost: true } },
    });
    const secondAccept = await accept(second);
    expect(secondAccept.contentions).toBeUndefined();
  });

  it('a TERMINATED other agreement stops contending', async () => {
    const first = await propose(consumerA, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(first);
    const second = await propose(consumerB, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(second);

    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${first}/terminate`,
      headers: auth(consumerA.token),
      payload: {},
    });
    expect(terminated.statusCode).toBe(200);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${second}`,
      headers: auth(consumerB.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().contentions).toBeUndefined();
  });

  it('UX-16: the LIST carries a contentionSummary on both contending rows (and none after termination)', async () => {
    const first = await propose(consumerA, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(first);
    const second = await propose(consumerB, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(second);

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().agreements as Array<{ id: string; contentionSummary?: { count: number; pairs: number } }>;
    const byId = new Map(rows.map(row => [row.id, row]));
    // Parameterless turn-on: both contend on the whole-device pair ('*').
    expect(byId.get(first)?.contentionSummary).toEqual({ count: 1, pairs: 1 });
    expect(byId.get(second)?.contentionSummary).toEqual({ count: 1, pairs: 1 });

    // A third, non-contending agreement (different param) carries NO summary
    // — the absent field is the honest "nothing to warn about".
    const third = await propose(consumerA, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on', params: { gentle: true } },
    });
    await accept(third);
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(owner.token),
    });
    const afterById = new Map(
      (after.json().agreements as Array<{ id: string; contentionSummary?: unknown }>).map(row => [row.id, row]),
    );
    expect(afterById.get(third)?.contentionSummary).toBeUndefined();
    // The original pair still contends.
    expect(afterById.get(first)?.contentionSummary).toEqual({ count: 1, pairs: 1 });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${second}/terminate`,
      headers: auth(consumerB.token),
      payload: {},
    });
    const final = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(owner.token),
    });
    const finalById = new Map(
      (final.json().agreements as Array<{ id: string; contentionSummary?: unknown }>).map(row => [row.id, row]),
    );
    expect(finalById.get(first)?.contentionSummary).toBeUndefined();
  });

  it('trigger execution logs the contention on the command_log payload (both agreementIds)', async () => {
    const first = await propose(consumerA, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(first);
    const second = await propose(consumerB, {
      trigger: heatWaveTrigger,
      action: { command: 'turn-on' },
    });
    await accept(second);

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    // The backing device id from the agreement detail (ids remap on import).
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${first}`,
      headers: auth(consumerA.token),
    });
    const deviceId = detail.json().backingDeviceId as string;

    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35 },
    });
    expect(injected.statusCode).toBeLessThan(300);

    // Poll until BOTH automations landed their metered invoke (bounded).
    const deadline = Date.now() + 3000;
    for (;;) {
      const rows = ctx.app.db
        .prepare("SELECT payload_json FROM command_log WHERE kind = 'device-command'")
        .all() as Array<{ payload_json: string }>;
      const forOurPair = rows
        .map(row => JSON.parse(row.payload_json) as {
          agreementId: string; contentionWith?: Array<{ agreementId: string }>;
        })
        .filter(payload => payload.agreementId === first || payload.agreementId === second);
      if (forOurPair.length >= 2 || Date.now() > deadline) {
        // Both fired: each command_log row names the OTHER agreement.
        expect(forOurPair.length).toBe(2);
        for (const payload of forOurPair) {
          const otherId = payload.agreementId === first ? second : first;
          expect(payload.contentionWith).toEqual([
            expect.objectContaining({ agreementId: otherId, deviceId, param: '*' }),
          ]);
        }
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }, 8000);
});
