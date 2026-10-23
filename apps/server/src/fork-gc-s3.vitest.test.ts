/**
 * @vitest-environment node
 *
 * S3 (Task 2): sandbox-fork retention + quota teaching.
 *
 * - quota 429 TEACHES the release path (stop endpoint + env knob + sweep);
 * - the age sweep removes STALE forks (row marked stopped, quota slot
 *   released, registry sim + its trajectory dir torn down) and keeps FRESH
 *   ones;
 * - ownership rules (T-011 mirror): the fork's SOURCE environment and any
 *   non-sandbox simulation are untouched by the sweep.
 *
 * Determinism: the sweep takes an injected `now`, so "stale vs fresh" is a
 * time-shift, not an mtime game.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('S3 Task 2: fork quota teaching + age-based retention sweep', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Fork GC Lab',
        visibility: 'public',
        mapData: {
          zones: [{ id: 'zone-a', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } }],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function fork(token: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(token),
      payload: {},
    });
  }

  it('over-quota fork fails 429 with a TEACHING message (release path + knob + sweep)', async () => {
    const small = await makeTestApp({ quotaMaxSandboxesPerUserPerEnv: 1 });
    try {
      const ownerToken = (await registerUser(small.app)).token;
      const created = await small.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(ownerToken),
        payload: {
          name: 'Small Lab',
          visibility: 'public',
          mapData: { zones: [{ id: 'zone-a' }] },
        },
      });
      expect(created.statusCode).toBe(201);
      const forkCall = () => small.app.inject({
        method: 'POST',
        url: `/api/environments/${created.json().id}/sandboxes`,
        headers: auth(ownerToken),
        payload: {},
      });
      const first = await forkCall();
      expect(first.statusCode).toBe(201);
      const second = await forkCall();
      expect(second.statusCode).toBe(429);
      const error = second.json().error;
      expect(error.code).toBe('QUOTA_EXCEEDED');
      expect(error.quota).toBe('sandboxes_per_user_per_env');
      // The teaching payload: how to release a slot, the knob, and the sweep.
      expect(error.message).toContain('POST /api/sandboxes/:id/stop');
      expect(error.message).toContain('QUOTA_MAX_SANDBOXES_PER_USER_PER_ENV');
      expect(error.message).toContain('EAF_FORK_MAX_AGE_DAYS');
    } finally {
      await small.cleanup();
    }
  });

  it('sweep removes STALE forks (row stopped, quota slot released, sim + dir gone) and keeps fresh ones', async () => {
    const first = (await fork(builder.token)).json();
    const second = (await fork(builder.token)).json();
    expect(first.status).toBe('active');
    expect(second.status).toBe('active');
    const firstDir = join(ctx.trajectoryDir, first.simulationId);
    expect(existsSync(firstDir)).toBe(true);

    // Fresh sweep horizon: everything is younger than a day → nothing swept.
    const fresh = ctx.app.sandboxService.sweepStaleForks({
      maxAgeMs: 7 * 24 * 3600 * 1000,
      now: Date.now() + 24 * 3600 * 1000,
    });
    expect(fresh.swept).toBe(0);
    expect(fresh.kept).toBe(2);

    // Stale horizon (now + 8 days): both forks exceed the 7-day window.
    const stale = ctx.app.sandboxService.sweepStaleForks({
      maxAgeMs: 7 * 24 * 3600 * 1000,
      now: Date.now() + 8 * 24 * 3600 * 1000,
    });
    expect(stale.swept).toBe(2);
    expect(stale.kept).toBe(0);

    // Rows are stopped (idempotent re-sweep: nothing left to sweep).
    expect(ctx.app.sandboxService.sweepStaleForks({
      maxAgeMs: 7 * 24 * 3600 * 1000,
      now: Date.now() + 9 * 24 * 3600 * 1000,
    }).swept).toBe(0);

    // The registry sim + its trajectory dir went with the row.
    expect(ctx.app.simulations.get(first.simulationId)).toBeUndefined();
    expect(existsSync(firstDir)).toBe(false);
    const listed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(builder.token),
    })).json().sandboxes as Array<{ id: string; status: string }>;
    const statuses = new Map(listed.map(row => [row.id, row.status]));
    expect(statuses.get(first.id)).toBe('stopped');
    expect(statuses.get(second.id)).toBe('stopped');

    // Quota slots released: forking again succeeds without touching the knob.
    const again = await fork(builder.token);
    expect(again.statusCode).toBe(201);
  });

  it('the sweep never touches the fork SOURCE environment or non-sandbox simulations', async () => {
    // A fork from the env + an ordinary env-backed simulation with its own
    // trajectory dir (NOT a sandbox — must be invisible to the fork sweep).
    const forked = (await fork(builder.token)).json();
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    const simDir = join(ctx.trajectoryDir, simId);
    expect(existsSync(simDir)).toBe(true);

    const result = ctx.app.sandboxService.sweepStaleForks({
      maxAgeMs: 7 * 24 * 3600 * 1000,
      now: Date.now() + 30 * 24 * 3600 * 1000, // a month out — maximally stale
    });
    expect(result.swept).toBe(1); // ONLY the sandbox row

    // The environment row + its map survive untouched.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().name).toBe('Fork GC Lab');

    // The non-sandbox sim and its trajectory dir survive untouched.
    expect(ctx.app.simulations.get(simId)).toBeDefined();
    expect(existsSync(simDir)).toBe(true);
    // The fork's artifacts are gone.
    expect(existsSync(join(ctx.trajectoryDir, forked.simulationId))).toBe(false);
  });
});
