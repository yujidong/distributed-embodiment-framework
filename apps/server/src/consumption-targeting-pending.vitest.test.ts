/**
 * @vitest-environment node
 *
 * T129 (R21-F1): the consumption lanes' honesty against a stalled/stopped
 * world-session targeting — the r21 outage's exact blast radius. On the
 * public demo env, `eaf agreement invoke` (2/2 contracts, both provider
 * kinds) and `eaf agreement read` (consumer with NO own sim) hung >100s and
 * died as bare gateway 504s: the session-targeting await sat BEFORE T128's
 * invoke 503 race (unreachable) and the read lane had NO floor at all.
 *
 * Two layers pinned here, both required (they are not interchangeable):
 * 1. ROOT (world-session catch-up detaches after its sync cap): a 48h-of-sim
 *    catch-up no longer holds the lane — invoke/read get served promptly
 *    while the advance finishes in the background (world never truncated).
 * 2. BELT (the lane wait floors, T128's pattern generalized): a targeting
 *    that genuinely cannot progress answers 503 INSIDE the injected floor —
 *    CONSUMPTION_TARGET_PENDING (invoke lane) / READ_TARGETING_PENDING
 *    (read lane) + retryAfterSec + Retry-After + teaching — never a bare
 *    504, never a hang. The read 503 meters NOTHING (a read never
 *    double-executes; retry is safe); the invoke 503 keeps the invocation
 *    running server-side.
 *
 * Plus the restart-shaped state (external hibernate → checkpoint on disk →
 * first arrival wakes + bounded catch-up) and the healthy no-regression
 * paths (own-sim early exit, live session).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

const HOUR_MS = 3_600_000;

describe('T129: consumption lanes answer within their floors against world-session targeting stalls', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let invokeAgreementId: string;
  let readAgreementId: string;
  const nowRef = { now: Date.now() };

  const SPEC = {
    kind: 'zone-query',
    refreshSec: 60,
    inputs: {
      zones: ['zone-a', 'zone-b'],
      metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
    },
  };
  const IFACE = {
    dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] },
  };

  beforeEach(async () => {
    nowRef.now = Date.now();
    ctx = await makeTestApp({
      // The belts: short injected floors (the 90s defaults are untestable).
      invokeDecisionWaitMs: 800,
      consumptionTargetWaitMs: 800,
      // T129 seams: the world-session clock + a short catch-up sync cap.
      worldSessionNowMs: () => nowRef.now,
      worldSessionCatchUpSyncWaitMs: 200,
    });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('agreement-lab'), visibility: 'public' },
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
    expect(turnOn).toBeTruthy();

    // invoke contract (device-backed service, provider = owner's lab-agent)
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOn!.id}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    invokeAgreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${invokeAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);

    // read contract (computation-backed service on the same env)
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    const providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'temp-aggregate', semanticType: 'temperature-aggregate' },
    });
    expect(published.statusCode).toBe(201);
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${published.json().id as string}/computation`,
      headers: auth(owner.token),
      payload: { ...SPEC, interface: IFACE },
    });
    expect(registered.statusCode).toBe(201);
    const readProposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${published.json().id as string}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { read: { fields: ['avgTemperature'] } } },
    });
    expect(readProposed.statusCode).toBe(201);
    readAgreementId = readProposed.json().id as string;
    const readDecided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${readAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(readDecided.statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function worldSessions(): { targetFor(id: string): Promise<unknown>; statusOf(id: string): { simulationId: string; simTimeSec: number } | undefined } {
    return (ctx.app as unknown as { worldSessions: never }).worldSessions;
  }

  /**
   * The R21 state: consumer has NO own running sim (default targeting falls
   * to the authoritative world session) and the session faces a giant
   * catch-up (48h of clock, each advance chunk slowed — hours of sim work).
   */
  async function fallBehind48h(): Promise<string> {
    const service = worldSessions();
    const release = await (service as unknown as { observe(id: string): Promise<() => void> }).observe(envId);
    release();
    const view = service.statusOf(envId)!;
    const simId = view.simulationId;
    const record = ctx.app.simulations.get(simId)!;
    const anchorMs = record.runtime.getSimStartEpochMs();
    nowRef.now = anchorMs + 48 * HOUR_MS;
    const runtime = record.runtime as unknown as Record<string, unknown>;
    const original = (record.runtime.advanceTo as (...a: unknown[]) => Promise<unknown>).bind(record.runtime);
    runtime.advanceTo = async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return original(...args);
    };
    return simId;
  }

  it('invoke, no own sim, 48h catch-up: served promptly (targeting detaches), the action lands, metering inline', async () => {
    const simId = await fallBehind48h();
    const startedAt = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${invokeAgreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on' },
    });
    const elapsedMs = Date.now() - startedAt;
    // Pre-fix this request waited out the WHOLE catch-up (8s+ in this exact
    // harness, R21: >100s in production) — the T128 503 unreachable. Now the
    // targeting detaches at the sync cap and the invocation proceeds.
    expect(elapsedMs).toBeLessThan(1_400);
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().simulationId).toBe(simId);
    // Metering landed inline (the invocation was never lost).
    const usage = await ctx.app.inject({
      method: 'GET', url: `/api/agreements/${invokeAgreementId}/usage`, headers: auth(consumer.token),
    });
    expect((usage.json().usage as Array<{ kind: string }>).filter(row => row.kind === 'invoke')).toHaveLength(1);
    // The catch-up still completes in the background — the world is never
    // truncated: sim time reaches the full 48h wall-mapped target.
    const target = 48 * HOUR_MS / 1000;
    expect(await until(() => (worldSessions().statusOf(envId)?.simTimeSec ?? 0) >= target - 0.5, 20_000)).toBe(true);
  }, 30_000);

  it('read, no own sim, 48h catch-up: served promptly with an honestly-stamped frame', async () => {
    await fallBehind48h();
    const startedAt = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${readAgreementId}/reads`,
      headers: auth(consumer.token),
      payload: {},
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(1_400);
    expect(res.statusCode).toBe(200);
    // The frame carries its world provenance — a consumer can see WHICH sim
    // moment the frame came from (the honest lag disclosure).
    expect(res.json().frame).toBeDefined();
    expect(typeof res.json().frame.provenance.simTimeSec).toBe('number');
  }, 30_000);

  it('a targeting that cannot progress: invoke 503 CONSUMPTION_TARGET_PENDING inside the floor, the invocation still lands', async () => {
    const service = worldSessions() as { targetFor: (id: string) => Promise<unknown> };
    const original = service.targetFor.bind(service);
    service.targetFor = () => new Promise(() => undefined); // never resolves
    try {
      const startedAt = Date.now();
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${invokeAgreementId}/invocations`,
        headers: auth(consumer.token),
        payload: { action: 'turn-on' },
      });
      const elapsedMs = Date.now() - startedAt;
      expect(res.statusCode).toBe(503);
      expect(elapsedMs).toBeLessThan(1_500); // at the injected floor, with inject overhead
      const err = res.json().error as { code: string; message: string; retryAfterSec: number };
      expect(err.code).toBe('CONSUMPTION_TARGET_PENDING');
      expect(typeof err.retryAfterSec).toBe('number');
      expect(err.retryAfterSec).toBeGreaterThan(0);
      expect(res.headers['retry-after']).toBe(String(err.retryAfterSec));
      // Teaching (R102: human face ≥ --json): the work is NOT lost, check
      // usage, never re-invoke.
      expect(err.message).toContain('agreement usage');
      expect(err.message).toContain('不要重复 invoke');
    } finally {
      service.targetFor = original;
    }
  }, 20_000);

  it('a targeting that cannot progress: read 503 READ_TARGETING_PENDING inside the floor, NOTHING metered', async () => {
    const service = worldSessions() as { targetFor: (id: string) => Promise<unknown> };
    const original = service.targetFor.bind(service);
    service.targetFor = () => new Promise(() => undefined);
    try {
      const startedAt = Date.now();
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${readAgreementId}/reads`,
        headers: auth(consumer.token),
        payload: {},
      });
      const elapsedMs = Date.now() - startedAt;
      expect(res.statusCode).toBe(503);
      expect(elapsedMs).toBeLessThan(1_500); // at the injected floor, with inject overhead
      const err = res.json().error as { code: string; message: string; retryAfterSec: number };
      expect(err.code).toBe('READ_TARGETING_PENDING');
      expect(err.retryAfterSec).toBeGreaterThan(0);
      expect(res.headers['retry-after']).toBe(String(err.retryAfterSec));
      // Teaching: nothing metered, retry is safe (never double-executes),
      // where to look when it keeps pending.
      expect(err.message).toContain('Nothing was metered');
      expect(err.message).toContain('eaf env session status');
      // A precondition rejection meters nothing — zero usage rows.
      const usage = await ctx.app.inject({
        method: 'GET', url: `/api/agreements/${readAgreementId}/usage`, headers: auth(consumer.token),
      });
      expect(usage.json().usage as unknown[]).toHaveLength(0);
    } finally {
      service.targetFor = original;
    }
  }, 20_000);

  it('restart-shaped state (external hibernate → checkpoint): the first arrival wakes + catches up INSIDE the floor, no hang', async () => {
    // Materialize the session, then freeze it out-of-band (the generic
    // /hibernate route adopts FREEZE semantics for session sims).
    const service = worldSessions();
    const release = await (service as unknown as { observe(id: string): Promise<() => void> }).observe(envId);
    release();
    const simId = service.statusOf(envId)!.simulationId;
    const frozen = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/hibernate`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(frozen.statusCode).toBe(200);
    expect(service.statusOf(envId)!.status).toBe('hibernated');
    // The world falls 2 wall-hours behind while frozen.
    const record = ctx.app.simulations.get(simId);
    const anchorMs = (record ?? ctx.app.simulations.get(simId)) === undefined
      ? Date.now()
      : service.statusOf(envId)!.simStartEpochMs!;
    nowRef.now = anchorMs + 2 * HOUR_MS;

    // The restart-shaped FIRST question: consumer read, no own sim.
    const startedAt = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${readAgreementId}/reads`,
      headers: auth(consumer.token),
      payload: {},
    });
    const elapsedMs = Date.now() - startedAt;
    expect([200, 503]).toContain(res.statusCode);
    expect(elapsedMs).toBeLessThan(5_000);
    if (res.statusCode === 200) {
      expect(res.json().frame).toBeDefined();
    } else {
      expect(res.json().error.code).toBe('READ_TARGETING_PENDING');
    }
    // Either way the world is awake again and caught up to wall-now.
    const target = 2 * HOUR_MS / 1000;
    expect(await until(() => (service.statusOf(envId)?.simTimeSec ?? 0) >= target - 0.5, 15_000)).toBe(true);
  }, 25_000);

  it('healthy paths unchanged: own-sim early exit targets the caller sim, a live session answers fast', async () => {
    // A live session with no gap answers fast (sub-cap catch-up awaited —
    // pre-T129 semantics for healthy worlds).
    const service = worldSessions();
    const release = await (service as unknown as { observe(id: string): Promise<() => void> }).observe(envId);
    release();
    const fresh = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${readAgreementId}/reads`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().frame.provenance.simulationId).toBe(service.statusOf(envId)!.simulationId);

    // T51 own-sim early exit: with her OWN running sim, the read targets it
    // and the session is never consulted (the stall below would 503 if the
    // session leg were touched).
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/simulations', headers: auth(consumer.token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const ownSimId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST', url: `/api/simulations/${ownSimId}/start`, headers: auth(consumer.token), payload: {},
    });
    expect(started.statusCode).toBe(200);

    const stall = service as unknown as { targetFor: (id: string) => Promise<unknown> };
    const original = stall.targetFor.bind(stall);
    stall.targetFor = () => new Promise(() => undefined); // would hang the session leg
    try {
      const own = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${readAgreementId}/reads`,
        headers: auth(consumer.token),
        payload: {},
      });
      expect(own.statusCode).toBe(200);
      expect(own.json().frame.provenance.simulationId).toBe(ownSimId);
    } finally {
      stall.targetFor = original;
    }
  }, 25_000);
});
