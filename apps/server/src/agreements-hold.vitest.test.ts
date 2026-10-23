/**
 * @vitest-environment node
 *
 * D3 (DevLoop R28, T-080) — the consumer hold: a bounded circuit breaker.
 *
 * POST /api/agreements/:id/hold {durationSec ≤ 3600} by the consumer
 * suspends auto-trigger execution AND manual invokes for that agreement
 * only; status 'held' is provider-visible; the hold auto-expires (LAZY
 * evaluation — reads/trigger evaluations flip an expired hold back to
 * active, no resident sweeper); quota is untouched (nothing executes).
 * DELETE /api/agreements/:id/hold resumes. Terminate stays terminal.
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

describe('agreement consumer hold (D3, T-080)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let serviceId: string;
  let agreementId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('hold-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    serviceId = turnOn!.id;

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'turn-on' },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function hold(token: string, durationSec: number) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/hold`,
      headers: auth(token),
      payload: { durationSec },
    });
  }

  async function detail(token: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { status: string; holdExpiresAt?: string };
  }

  async function notificationsOf(token: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=100',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().notifications as Array<{ kind: string; body: Record<string, unknown> }>;
  }

  async function usageRows(): Promise<unknown[]> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().usage as unknown[];
  }

  it('the consumer holds an active agreement — held status, provider notified, audited', async () => {
    const res = await hold(consumer.token, 600);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; holdExpiresAt: string };
    expect(body.status).toBe('held');
    expect(Date.parse(body.holdExpiresAt)).toBeGreaterThan(Date.now() + 590_000);

    // Provider-visible: the detail (provider's read) shows held + the expiry.
    const providerView = await detail(owner.token);
    expect(providerView.status).toBe('held');
    expect(providerView.holdExpiresAt).toBeDefined();

    // The provider heard it without polling.
    const notes = await notificationsOf(owner.token);
    const held = notes.find(n => n.kind === 'agreement.held');
    expect(held).toBeDefined();
    expect(held!.body).toMatchObject({ status: 'held', durationSec: 600 });
    expect(typeof held!.body.holdExpiresAt).toBe('string');

    // T-025: the lifecycle transition is audited.
    const audit = ctx.app.db
      .prepare("SELECT payload_json FROM command_log WHERE kind = 'agreement-transition'")
      .all() as Array<{ payload_json: string }>;
    expect(
      audit.some(row => {
        const payload = JSON.parse(row.payload_json) as { agreementId?: string; from?: string; to?: string };
        return payload.agreementId === agreementId && payload.from === 'active' && payload.to === 'held';
      }),
    ).toBe(true);
  });

  it('manual invokes are suspended while held (AGREEMENT_HELD teaching the resume), quota untouched', async () => {
    expect((await hold(consumer.token, 600)).statusCode).toBe(200);
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on' },
    });
    expect(invoked.statusCode).toBe(409);
    expect(invoked.json().error.code).toBe('AGREEMENT_HELD');
    expect(invoked.json().error.message).toContain('DELETE /api/agreements/:id/hold');
    // Nothing executed → nothing metered → quota untouched.
    expect(await usageRows()).toEqual([]);
  });

  it('access control + bounds: provider cannot hold; non-active cannot hold; durationSec validated', async () => {
    expect((await hold(owner.token, 600)).statusCode).toBe(403); // provider — not their breaker

    // Body bounds validated while the agreement is still holdable (active).
    for (const bad of [0, -5, 1.5, 3601, '600']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/hold`,
        headers: auth(consumer.token),
        payload: { durationSec: bad },
      });
      expect(res.statusCode, `durationSec=${JSON.stringify(bad)}`).toBe(400);
      if (bad === 3601) expect(res.json().error.message).toContain('3600');
    }

    const suspended = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(suspended.statusCode).toBe(200);
    expect((await hold(consumer.token, 600)).statusCode).toBe(409); // suspended ≠ holdable
  });

  it('R99 (zhao-09): suspend response carries the irreversibility marker; resume on suspended names the way forward', async () => {
    const suspended = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe('suspended');
    // The action response says it plainly: machine-readable marker + note.
    expect(suspended.json().irreversible).toBe(true);
    expect(suspended.json().note).toContain('suspend 不可恢复');
    expect(suspended.json().note).toContain('hold');

    // resume (DELETE hold) on a suspended agreement: 409 AGREEMENT_NOT_HELD
    // + the way forward (terminate / re-propose; hold is the reversible lane).
    const resumed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agreements/${agreementId}/hold`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error.code).toBe('AGREEMENT_NOT_HELD');
    const message = resumed.json().error.message as string;
    expect(message).toContain('suspend 是不可逆的');
    expect(message).toContain('terminate');
    expect(message).toContain('hold');
  });

  it('DELETE hold resumes — provider notified, invokes work again', async () => {
    expect((await hold(consumer.token, 600)).statusCode).toBe(200);
    const resumed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agreements/${agreementId}/hold`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe('active');
    expect(resumed.json().holdExpiresAt).toBeUndefined();

    const notes = await notificationsOf(owner.token);
    expect(notes.some(n => n.kind === 'agreement.resumed')).toBe(true);

    // Resuming a second time (not held anymore) → honest 409.
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agreements/${agreementId}/hold`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('AGREEMENT_NOT_HELD');
  });

  it('the hold AUTO-EXPIRES lazily — the first read past the deadline flips it back to active', async () => {
    expect((await hold(consumer.token, 1)).statusCode).toBe(200);
    expect((await detail(consumer.token)).status).toBe('held');
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect((await detail(consumer.token)).status).toBe('active');
  });

  it('terminate stays available from held (held is non-terminal)', async () => {
    expect((await hold(consumer.token, 600)).statusCode).toBe(200);
    const terminated = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/terminate`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');
  });

  it('auto-trigger execution is suspended while held and fires again after resume', async () => {
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    const inject = () => ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35 },
    });

    expect((await hold(consumer.token, 600)).statusCode).toBe(200);
    expect((await inject()).statusCode).toBeLessThan(300);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await usageRows()).toEqual([]); // held: the trigger lane stayed quiet

    const resumed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agreements/${agreementId}/hold`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(resumed.json().status).toBe('active');

    expect((await inject()).statusCode).toBeLessThan(300);
    const deadline = Date.now() + 3000;
    for (;;) {
      const rows = await usageRows();
      if (rows.length > 0 || Date.now() > deadline) {
        expect(rows.length).toBe(1);
        expect(rows[0]).toMatchObject({ kind: 'invoke', action: 'turn-on', outcome: 'success' });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }, 8000);
});
