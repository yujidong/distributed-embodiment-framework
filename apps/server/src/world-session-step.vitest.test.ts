/**
 * @vitest-environment node
 *
 * T-507 (DevLoop R24, EC24-F07/F08): world-session step semantics + observer
 * definition — TEACHING, not a mechanism change.
 *
 * In-dev reproduction (R24): stepping the authoritative session advances
 * exactly n × speed sim-s, is monotone, never clamped by the wall anchor,
 * and never rewound by the next arrival's catch-up. The round's felt
 * divergence ("large n advances ~10 sim-s while toSimTimeSec advances
 * fully") is the SEMANTICS: n counts ticks (× the session's compression
 * rate), toSimTimeSec names the catch-up target, and the wall-anchored
 * clock keeps running between calls. `n`-as-ticks is the shared step
 * contract (WONT_FIX ruling) — so the fix is the teaching riding the
 * response/error, plus the observer definition on the view (only WS stream
 * connections pin ACTIVE; HTTP reads/steps never do — unchanged).
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

describe('T-507: world-session step teaching + observer definition', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;
  let sessionSimId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('gate-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    await ctx.app.worldSessions.targetFor(envId);
    sessionSimId = `sim-${envId}-world-session`;
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const sessionSimTime = () =>
    ctx.app.simulations.get(sessionSimId)!.runtime.getSimTimeSec();

  function step(simId: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(owner.token),
      payload: body,
    });
  }

  it('the step response teaches the semantics: n = ticks × speed, toSimTimeSec = catch-up target, live clock', async () => {
    const res = await step(sessionSimId, { n: 100 });
    expect(res.statusCode).toBe(200);
    const teaching = res.json().stepSemantics as { n: string; toSimTimeSec: string; liveClock: string };
    // n is TICKS — the arithmetic and the per-request cap are named, so a
    // "large n, small sim jump" observation is explainable from the response.
    expect(teaching.n).toContain('ticks');
    expect(teaching.n).toContain('sim-s per tick');
    expect(teaching.n).toMatch(/cap \d+ ticks/);
    // The recommended lane for large jumps.
    expect(teaching.toSimTimeSec).toContain('catch-up target');
    expect(teaching.toSimTimeSec).toContain('preferred');
    // The wall-anchored clock caveat.
    expect(teaching.liveClock).toContain('wall-anchored');
    // And the mechanism itself is honest: 100 ticks advanced ~100 sim-s.
    expect(res.json().simTimeSec).toBeGreaterThanOrEqual(100 - 1e-6); // fp accumulation
  });

  it('a PRIVATE sim step response carries no teaching block (contract unchanged)', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const simId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    const res = await step(simId, { n: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().stepSemantics).toBeUndefined();
  });

  it('STEP_TOO_LARGE on a world session recommends toSimTimeSec (the catch-up destination)', async () => {
    const res = await step(sessionSimId, { n: 10_000 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('STEP_TOO_LARGE');
    expect(res.json().error.message).toContain('toSimTimeSec');
    expect(res.json().error.message).toContain('wall-anchored');
  });

  it('observer definition unchanged: HTTP reads and steps never pin — only WS stream connections do', async () => {
    // HTTP step + snapshot + env detail: the observer pin count stays 0.
    await step(sessionSimId, { n: 10 });
    await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${sessionSimId}/snapshot`,
      headers: auth(owner.token),
    });
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().worldSession.observers).toBe(0);

    // A WS stream connection IS an observer (pin held for the connection).
    const release = await ctx.app.worldSessions.observe(envId);
    const pinned = await ctx.app.worldSessions.statusOf(envId);
    expect(pinned?.observers).toBe(1);
    expect(pinned?.status).toBe('active');
    release();
  });

  it('stepping is monotone and never rewound by the next arrival (the attribution check)', async () => {
    const before = sessionSimTime();
    await step(sessionSimId, { n: 50 });
    const stepped = sessionSimTime();
    expect(stepped - before).toBeGreaterThanOrEqual(50 - 1e-6); // fp accumulation

    // The next arrival's catch-up (targetFor) must never move the world back.
    await ctx.app.worldSessions.targetFor(envId);
    expect(sessionSimTime()).toBeGreaterThanOrEqual(stepped);
  });
});
