/**
 * @vitest-environment node
 *
 * Plan-image underlay tests (B-D): `map_data.floorPlans` storage and
 * exposure — via the empty-world create path (mapData.floorPlans), via the
 * scenario import path (non-validated `map.floorPlans` sidecar), and the
 * environment detail response. Also the malformed-input 400s.
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

const PLAN = {
  buildingId: 'EB',
  floor: 1,
  image: 'data:image/png;base64,aGVsbG8=',
  pixelsPerMeter: 12.5,
};

describe('floor-plan underlays (B-D)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('stores floorPlans on empty-world creation and returns them in the detail', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Plan Lab',
        mapData: {
          zones: [{ id: 'zone-a', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 6 }, floor: 1 }],
          floorPlans: [PLAN],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().floorPlans).toEqual([PLAN]);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${created.json().id}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().floorPlans).toEqual([PLAN]);
  });

  it('recovers map.floorPlans from a scenario import (sidecar block)', async () => {
    const scenario = {
      ...importableScenario('plan-import'),
      map: { floorPlans: [PLAN] },
    };
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().floorPlans).toEqual([PLAN]);
  });

  it('defaults floorPlans to [] when absent', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'No Plans', mapData: { zones: [] } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().floorPlans).toEqual([]);
  });

  it('rejects malformed floorPlans entries with a 400', async () => {
    for (const bad of [
      { ...PLAN, floor: 1.5 },
      { ...PLAN, image: '' },
      { ...PLAN, pixelsPerMeter: 0 },
      { floor: 1, image: 'x.png' },
    ]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: { name: 'Bad Plans', mapData: { zones: [], floorPlans: [bad] } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('floorPlans');
    }
  });
});
