/**
 * @vitest-environment node
 *
 * T-405 (DevLoop R19, CC-F03): data-lane stream incremental frames +
 * spontaneous close.
 *
 * Reproduction (run BEFORE the fix — must be RED): a zone-query computation
 * stream delivers `subscribed` + ONE initial data frame, then goes silent
 * even though an in-zone scheduled event fires while connected. Pinned
 * cause: the connect-time frame anchors the cadence clock
 * (`lastPushSimTime`), so the ONLY trigger in the window lands within
 * cadenceSec of the initial push and is silently swallowed — nothing ever
 * pushes again.
 *
 * Also covers the observe()-pin hardening: a stream that closes before the
 * (asynchronous) world-session pin resolves must not leak the pin, a pinned
 * session stays ACTIVE (never closes the stream) and the last disconnect
 * demotes to IDLE — R73 (永远运行下去) made IDLE terminal: the demotion
 * sweep is a no-op stub and worlds never hibernate — and metering stays
 * kind='stream' / unit='message' with quantity = pushed frames.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  auth,
  elapsedSince,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import type { WorldSessionService } from './world-session.js';

/** Poll until the predicate holds (bounded). */
async function until(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

interface Frame {
  kind: string;
  data?: Record<string, unknown>;
  reason?: string;
}

describe('T-405: data-lane stream incremental frames + pin lifecycle', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let agreementId: string;
  let baseUrl: string;

  beforeEach(async () => {
    // Wall-rate 60 (1 wall-sec = 1 sim-minute) + a short idle grace so the
    // lifecycle is observable in real time without long waits.
    ctx = await makeTestApp({ worldSessionSimPerWallSec: 60, worldSessionIdleGraceMs: 250 });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        visibility: 'public',
        meta: { id: 'stream-lab', name: 'Stream Lab', description: 'T-405 fixture' },
        zones: [{ id: 'zone-a', baseline: { temperature: 22 } }],
        devices: [
          {
            id: 'temp-sensor-a', name: 'Sensor A', type: 'sensor',
            capabilities: ['temperature-reading'], zoneId: 'zone-a', initialState: { active: false },
          },
        ],
        agents: [{
          id: 'care-bot', name: 'Care Bot', capabilities: ['care-status'],
          managesZoneIds: ['zone-a'], boundDeviceIds: ['temp-sensor-a'],
        }],
        // No scheduled dues. Under R73 the world AUTO-STARTS at env creation,
        // so a scenario due's wall moment is anchored at CREATION and fires
        // before the stream connects (fixture setup wall-time varies) — the
        // "trigger fires mid-stream" premise cannot be staged that way
        // anymore. The T-405 cadence-anchor regression is trigger-source-
        // agnostic (the fix lives in pushFrame's anchoring), so the tests
        // inject the in-zone trigger explicitly mid-stream instead.
        events: [],
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const detail = (await ctx.app.inject({
      method: 'GET', url: `/api/environments/${envId}`, headers: auth(owner.token),
    })).json();
    const providerAgentId = (detail.agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Care Bot')!.id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${providerAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'zone-temp', semanticType: 'care-status-aggregate' },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id as string;
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number', unit: '°C' }] } },
      },
    });
    expect(registered.statusCode).toBe(201);
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
    const proposed = await ctx.app.inject({
      method: 'POST', url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      // cadenceSec 3600 (1 sim-hour): ANY trigger within an hour of another
      // push is throttled — exactly the burst-vs-isolated distinction.
      payload: { terms: { read: { fields: ['avgTemperature'], cadenceSec: 3600 } } },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST', url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token), payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `ws://127.0.0.1:${(ctx.app.server!.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function openStream(): Promise<{ socket: WebSocket; frames: Frame[]; closes: string[] }> {
    return new Promise(resolve => {
      const frames: Frame[] = [];
      const closes: string[] = [];
      const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
        headers: auth(consumer.token),
      });
      socket.on('message', data => frames.push(JSON.parse(String(data)) as Frame));
      socket.on('close', (code, reason) => closes.push(`${code} ${reason}`));
      socket.on('open', () => resolve({ socket, frames, closes }));
    });
  }

  /** The mid-stream trigger: an in-zone injection into the (auto-started)
   *  world session — the same onInjectedEvent → pushFrame path a scheduled
   *  due takes, but deterministic under R73 (see the fixture note). */
  function injectSpike() {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/sim-${envId}-world-session/events`,
      headers: auth(owner.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 35 },
    });
  }

  it('an in-zone trigger mid-stream pushes an INCREMENTAL frame (isolated trigger is never swallowed)', async () => {
    const { socket, frames } = await openStream();
    // The initial frame (subscribed + one data) must arrive…
    expect(await until(() => frames.some(frame => frame.kind === 'data'), 10_000)).toBe(true);
    const baseline = frames.find(frame => frame.kind === 'data');
    expect(baseline?.data?.avgTemperature).toBe(22);

    // …and the in-zone trigger fires while we are connected — the ONLY
    // trigger in the cadence window (cadenceSec 3600). It must push a second
    // data frame: cadence throttles BURSTS, never swallows isolated triggers
    // (pre-fix the connect-time frame anchored the cadence clock and this
    // push was swallowed — the stream stayed silent forever).
    const injected = await injectSpike();
    expect([200, 202]).toContain(injected.statusCode);
    const incremental = await until(
      () => frames.filter(frame => frame.kind === 'data').length >= 2,
      10_000,
    );
    expect(incremental).toBe(true);
    // The second frame is the trigger RESPONSE: it carries the spiked metric.
    const dataFrames = frames.filter(frame => frame.kind === 'data');
    expect(dataFrames.at(-1)?.data?.avgTemperature).toBe(35);
    socket.close();
  }, 30_000);

  it('a pinned session stays ACTIVE with the stream open; the last disconnect demotes to IDLE and the world NEVER hibernates (R73)', async () => {
    const { socket, frames, closes } = await openStream();
    const pinnedAt = Date.now();
    expect(await until(() => frames.some(frame => frame.kind === 'data'), 5_000)).toBe(true);

    // Well past the 250ms idle grace, with no near dues: the stream's pin
    // must keep the world ACTIVE and the socket OPEN. Class (b) negative
    // window (R21 test-debt): proving the grace timer does NOT fire
    // requires really passing that wall time — elapsed measured from the
    // observed pin, not a re-guessed fixed sleep.
    while (Date.now() - pinnedAt < 1_500) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const view = ctx.app.worldSessions.statusOf(envId);
    expect(view?.status).toBe('active');
    expect(view?.observers).toBeGreaterThanOrEqual(1);
    expect(closes).toHaveLength(0);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.close();
    // Last disconnect → demotion to IDLE proceeds (the pin was real, not a
    // leak)…
    expect(await until(
      () => ctx.app.worldSessions.statusOf(envId)?.status === 'idle',
      10_000,
    )).toBe(true);
    // …but R73 (永远运行下去): IDLE is terminal. The demotion sweep is a
    // no-op stub — well past the grace the world is STILL resident (runtime
    // never released, never HIBERNATED).
    const demotedAt = Date.now();
    await elapsedSince(demotedAt, 700);
    const after = ctx.app.worldSessions.statusOf(envId);
    expect(after?.status).toBe('idle');
    expect(after?.hibernatedAt).toBeUndefined();
    expect(ctx.app.simulations.get(`sim-${envId}-world-session`)).toBeDefined();
  }, 20_000);

  it('closing immediately after connect releases the pin even when observe() resolves late (no leak)', async () => {
    // Gate the world-session observe() resolution: the pin acquisition is
    // asynchronous (void ...then(...)) — hold it until AFTER the socket's
    // cleanup ran, then let it resolve and prove the late release still
    // lands (pre-fix the pin would leak: the session would stay pinned
    // ACTIVE forever).
    const service = ctx.app.worldSessions as WorldSessionService;
    const originalObserve = service.observe.bind(service);
    // Gate BEFORE the connect — the route's observe() fires during the
    // upgrade, so the flag must already be set to hold that resolution.
    let gate: (() => void) | undefined;
    let gated = true;
    (service as unknown as { observe: typeof originalObserve }).observe = async envIdArg => {
      const release = await originalObserve(envIdArg);
      if (gated) {
        await new Promise<void>(resolve => {
          gate = resolve;
        });
      }
      return release;
    };

    const { socket } = await openStream();
    socket.close();
    // Bounded settle (R21 test-debt): the close's cleanup must run BEFORE
    // the gate releases the held observe() — the end state is identical
    // either way, so this only preserves the tested ordering; 200ms is the
    // generous window for a local WS close handshake.
    await new Promise(resolve => setTimeout(resolve, 200)); // cleanup has run

    gate?.();
    gated = false;
    (service as unknown as { observe: typeof originalObserve }).observe = originalObserve;

    // The pin must be released on the late resolve — the session demotes to
    // IDLE with observers back at 0 instead of staying pinned ACTIVE forever.
    // (R73: the demotion ends at IDLE — worlds never hibernate anymore.)
    expect(await until(
      () => ctx.app.worldSessions.statusOf(envId)?.status === 'idle',
      10_000,
    )).toBe(true);
    expect(ctx.app.worldSessions.statusOf(envId)?.observers).toBe(0);
  }, 20_000);

  it('metering is unchanged: kind=stream, unit=message, quantity = pushed frames', async () => {
    const { socket, frames } = await openStream();
    expect(await until(() => frames.some(frame => frame.kind === 'data'), 10_000)).toBe(true);
    // A mid-stream trigger pushes the second metered frame.
    const injected = await injectSpike();
    expect([200, 202]).toContain(injected.statusCode);
    expect(await until(() => frames.filter(frame => frame.kind === 'data').length >= 2, 10_000)).toBe(true);
    socket.close();
    // Positive wait (R21 test-debt): poll until the stream's usage record
    // is flushed on close — was a fixed 150ms sleep.
    expect(await until(
      () => (ctx.app.agreementStore.usageOf(agreementId)).length >= 1,
      10_000,
    )).toBe(true);

    const usage = ctx.app.agreementStore.usageOf(agreementId);
    expect(usage).toHaveLength(1);
    expect(usage[0].kind).toBe('stream');
    expect(usage[0].unit).toBe('message');
    expect(usage[0].quantity).toBeGreaterThanOrEqual(2);
    expect(usage[0].outcome).toBe('success');
  }, 40_000);
});
