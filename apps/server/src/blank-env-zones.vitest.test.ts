/**
 * @vitest-environment node
 *
 * R76-F2 (blank-canvas onboarding) — the zero-zone way out.
 *
 * 「新建环境 → 空白」 creates a world with 0 zones, which dead-ended every
 * downstream bootstrap (no placement target, UNKNOWN_ZONE). The way out
 * already exists server-side (T-055) and is pinned here on the BLANK env
 * the finding actually hit: the owner creates the first zone directly via
 * POST /api/environments/:id/zones (unblocking device placement), and a
 * builder's same call converts into an install-zones proposal that the
 * owner approves into existence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestApp, registerUser, auth, type TestAppContext, type TestUser } from './test-utils.js';

describe('blank-environment zone bootstrap (R76-F2)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    // The blank-canvas path: name only, no mapData → 0 zones.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Blank Canvas', visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const zoneIds = async (token: string): Promise<string[]> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/zones`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().zones as Array<{ id: string }>).map(zone => zone.id);
  };

  it('blank creation warns loudly, then the owner creates the first zone and placement unblocks', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Another Blank', visibility: 'private' },
    });
    expect(created.statusCode).toBe(201);
    const warnings = created.json().warnings as string[];
    expect(warnings.some(w => w.includes('no zones'))).toBe(true);

    expect(await zoneIds(owner.token)).toEqual([]);

    // Owner direct create: the zone lands immediately (T-055, same validator
    // as the proposal rule check).
    const zone = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/zones`,
      headers: auth(owner.token),
      payload: { id: 'lobby', name: 'Lobby', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } },
    });
    expect(zone.statusCode).toBe(201);
    expect(zone.json().id).toBe('lobby');
    expect(await zoneIds(owner.token)).toEqual(['lobby']);

    // The original dead-end is gone: a device can be placed into the zone.
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Sensor', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'lobby' },
    });
    expect(device.statusCode).toBe(201);
  });

  it('builder first-zone create on a blank env converts to an install-zones proposal the owner approves', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });

    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/zones`,
      headers: auth(builder.token),
      payload: { id: 'garden', name: 'Garden' },
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().kind).toBe('install-zones');
    // No LLM in tests → the fallback reviewer escalates to the owner.
    expect(submitted.json().status).toBe('escalated');
    // Nothing landed yet — the proposal is the only effect.
    expect(await zoneIds(owner.token)).toEqual([]);

    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${submitted.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('applied');
    expect(await zoneIds(owner.token)).toEqual(['garden']);
  });
});
