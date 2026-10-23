/**
 * @vitest-environment node
 *
 * R75 creation-contract guard (the validation process behind the single
 * creation funnel):
 *
 * 1. EVERY creation path (empty world AND scenario import) starts the
 *    always-on world session. This is the test that would have caught the
 *    R75 P0: the import branch shipped without the R73 wake, so every
 *    template-imported world was born dead (no agents thinking, no
 *    进入世界仿真 entry) while the empty-world branch worked — the bug lived
 *    exactly in the gap between two ad-hoc branch epilogues.
 * 2. Duplicate-name teaching: creating (or renaming into) a name the user
 *    already owns fires a warnings[] entry on the response — same-name
 *    worlds are legal but never silent.
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

describe('environment creation contracts (R75 funnel)', () => {
  let ctx: TestAppContext;
  let user: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    user = await registerUser(ctx.app);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** The wake is fire-and-forget — poll the detail until the session lands. */
  async function worldSessionOf(envId: string): Promise<{ status?: string } | null> {
    for (let i = 0; i < 20; i++) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}`,
        headers: auth(user.token),
      });
      const ws = res.json().worldSession;
      if (ws !== null && ws !== undefined) return ws;
      await new Promise(done => setTimeout(done, 250));
    }
    return null;
  }

  it('guard: the scenario-import path starts the world session', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload: importableScenario('guard-import'),
    });
    expect(res.statusCode).toBe(201);

    const ws = await worldSessionOf(res.json().id);
    expect(ws, 'imported env must have a world session (the R75 P0 regression)').not.toBeNull();
    expect(ws?.status).toBe('idle');
  });

  it('guard: the empty-world path starts the world session', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload: { name: 'Guard Empty', mapData: { zones: [{ id: 'z1', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }] } },
    });
    expect(res.statusCode).toBe(201);

    const ws = await worldSessionOf(res.json().id);
    expect(ws, 'empty env must have a world session').not.toBeNull();
    expect(ws?.status).toBe('idle');
  });

  it('teaching: creating a second same-name env warns on the response', async () => {
    const post = (name: string) => ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload: { name, mapData: { zones: [{ id: 'z1', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }] } },
    });

    const first = await post('Twin World');
    expect(first.statusCode).toBe(201);
    expect(first.json().warnings ?? []).toEqual([]);

    const second = await post('Twin World');
    expect(second.statusCode).toBe(201);
    const warnings = second.json().warnings ?? [];
    expect(warnings.some((w: string) => w.includes('You already own 1 other environment'))).toBe(true);

    // A different owner's same-name world is NOT a duplicate for this user.
    const other = await registerUser(ctx.app);
    const theirs = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { ...auth(other.token), 'content-type': 'application/json' },
      payload: { name: 'Twin World', mapData: { zones: [{ id: 'z1', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }] } },
    });
    expect(theirs.json().warnings ?? []).toEqual([]);
  });

  it('teaching: renaming into an owned name warns on the PATCH response', async () => {
    const mk = (name: string) => ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload: { name, mapData: { zones: [{ id: 'z1', bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }] } },
    });
    const a = await mk('Alpha');
    const b = await mk('Beta');

    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${b.json().id}`,
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload: { name: 'Alpha' },
    });
    expect(renamed.statusCode).toBe(200);
    const warnings = renamed.json().warnings ?? [];
    expect(warnings.some((w: string) => w.includes('You already own 1 other environment'))).toBe(true);

    // Renaming b to a fresh name stays silent.
    const clean = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${a.json().id}`,
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload: { name: 'Gamma' },
    });
    expect(clean.json().warnings ?? []).toEqual([]);
  });
});
