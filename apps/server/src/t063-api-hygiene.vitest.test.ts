/**
 * @vitest-environment node
 *
 * T-063 (DevLoop R13) — R12-retry small-issue bundle:
 *   (a) string inject-event value → teaching 4xx, not 500
 *   (b) SERVICE_NOT_BACKED prose names PUT (not the stale POST)
 *   (c) empty worlds are marked on the env list (zones count + hint)
 *   (d) activity feed rejects offset/unknown query params loudly
 *   (e) code-authored governance notes are localized (zh default)
 *   (f) UX-03: GET /api/simulations — ?envId= is a deprecated alias, unknown
 *       params and conflicting aliases are teaching 400s
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importableScenario, makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('T-063 API hygiene bundle', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('(a) a string event value is a teaching 400 INVALID_EVENT_VALUE, not 500 ENGINE_ERROR', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { ...importableScenario('t063-events'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { type: 'temperature-spike', zoneId: 'zone-a', value: 'very hot' },
    });
    expect(res.statusCode).toBe(400);
    const error = res.json().error;
    expect(error.code).toBe('INVALID_EVENT_VALUE');
    expect(error.message).toContain('not numeric');
    expect(error.message).toContain('numbers or booleans');
  });

  it('(b) SERVICE_NOT_BACKED points at PUT /subscribe (the POST route answers 405)', async () => {
    // An unbacked published service: proposing an agreement on it → 409 whose
    // teaching prose names the REAL bookmark method.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { ...importableScenario('t063-unbacked'), visibility: 'public' },
    });
    const envId = created.json().id as string;

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const agentId = (detail.json().agents as Array<{ id: string }>)[0]!.id;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Weather Broker', semanticType: 'weather-forecast' },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id as string;

    const consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: { authorization: `Bearer ${consumer.token}` },
    });
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: { authorization: `Bearer ${consumer.token}` },
      payload: {},
    });
    expect(proposed.statusCode).toBe(409);
    expect(proposed.json().error.code).toBe('SERVICE_NOT_BACKED');
    const message = proposed.json().error.message as string;
    expect(message).toContain('PUT /api/services/:id/subscribe');
    expect(message).not.toContain('POST /api/services/:id/subscribe');
  });

  it('(c) an empty world is marked on the list (zones:0 + localized hint); a stocked one is not', async () => {
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Dead Husk', visibility: 'public' },
    });
    expect(empty.statusCode).toBe(201);
    const stocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { ...importableScenario('t063-stocked'), visibility: 'public' },
    });
    expect(stocked.statusCode).toBe(201);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments?filter=all',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const environments = list.json().environments as Array<{
      id: string;
      counts: { zones: number; devices: number };
      emptyWorldHint?: string;
    }>;
    const husk = environments.find(env => env.id === empty.json().id)!;
    expect(husk.counts.zones).toBe(0);
    expect(husk.counts.devices).toBe(0);
    expect(husk.emptyWorldHint).toBeDefined();
    expect(husk.emptyWorldHint).toContain('空世界'); // zh default locale
    const rich = environments.find(env => env.id === stocked.json().id)!;
    expect(rich.counts.zones).toBe(2);
    expect(rich.emptyWorldHint).toBeUndefined();
  });

  it('(d) activity feed rejects ?offset loudly and names the cursor contract', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { ...importableScenario('t063-activity'), visibility: 'public' },
    });
    const envId = created.json().id as string;

    const rejected = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?offset=50`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(rejected.statusCode).toBe(400);
    const message = rejected.json().error.message as string;
    expect(message).toContain('"offset"');
    expect(message).toContain('before');

    // The documented params still work.
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?limit=10`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json().entries)).toBe(true);
  });

  it('(e) governance notes are zh by default (code-authored reviewer reasons localized)', async () => {
    // makeTestApp defaults proposalReviewTimeoutAutoApprove OFF → the
    // no-LLM EscalatingReviewer answers; the low-risk auto-apply reason and
    // the escalate reason must be localized (zh default locale).
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: 'T063 Governance Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    const envId = created.json().id as string;
    const builder = await registerUser(ctx.app, { displayName: 'Builder' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: { authorization: `Bearer ${builder.token}` },
    });

    // Medium-risk path escalates with the localized unavailability reason.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: { authorization: `Bearer ${builder.token}` },
      payload: {
        kind: 'install-agents',
        payload: { agents: [{ name: '批量代理 1', capabilities: ['temperature-monitoring'] }, { name: '批量代理 2', capabilities: ['temperature-monitoring'] }, { name: '批量代理 3', capabilities: ['temperature-monitoring'] }, { name: '批量代理 4', capabilities: ['temperature-monitoring'] }, { name: '批量代理 5', capabilities: ['temperature-monitoring'] }] },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const proposal = proposed.json();
    if (proposal.status === 'escalated') {
      expect(proposal.aiReview.reason).toContain('语义审查器不可用');
    }
  });

  it('(f) GET /api/simulations: ?envId= is a working deprecated alias; unknown params and conflicting aliases are teaching 400s', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { ...importableScenario('t063-simlist'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);

    // Compatibility alias: filtered exactly like ?environmentId= (a server
    // deprecation warn is logged; the response body is unchanged).
    const aliased = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations?envId=${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(aliased.statusCode).toBe(200);
    const aliasedSims = aliased.json().simulations as Array<{ environmentId?: string }>;
    expect(aliasedSims.length).toBeGreaterThan(0);
    expect(aliasedSims.every(entry => entry.environmentId === envId)).toBe(true);

    // Unknown params are loud and name the real one.
    const rejected = await ctx.app.inject({
      method: 'GET',
      url: '/api/simulations?owner=me',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(rejected.statusCode).toBe(400);
    const message = rejected.json().error.message as string;
    expect(message).toContain('"owner"');
    expect(message).toContain('environmentId');

    // Both spellings, disagreeing → teaching 400.
    const conflict = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations?envId=${envId}&environmentId=env-other`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(conflict.statusCode).toBe(400);
    const conflictMessage = conflict.json().error.message as string;
    expect(conflictMessage).toContain('"envId"');
    expect(conflictMessage).toContain('"environmentId"');
  });
});
