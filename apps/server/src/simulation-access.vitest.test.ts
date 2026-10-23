/**
 * @vitest-environment node
 *
 * Simulation list/operation authorization (Fix-47 越权修复).
 *
 * Before this fix, GET /api/simulations returned EVERY user's simulations,
 * `?environmentId=` was silently ignored, and any caller could stop/pause/
 * resume/start/step someone else's simulation (越权写). Now:
 *
 * - LIST visibility: admin sees all; anyone else sees only sims they
 *   created, sims of environments they are a member of, and creator-less
 *   legacy sims (transition semantics). `?environmentId=` narrows to one
 *   environment and requires read access to it (member or public env;
 *   403 on a private env for non-members, 404 on an unknown env id).
 * - CONTROL (start/pause/resume/stop/step, fault writes, event injection):
 *   the sim's creator, an owner/builder of its environment, or an admin —
 *   everyone else is 403. Viewers get the read-only message in their own
 *   terms. Creator-less sims (anonymous creations) stay operable by anyone.
 * - Body-less ops tolerate an empty JSON body (no more
 *   FST_ERR_CTP_EMPTY_JSON_BODY on Content-Type: application/json).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  createUserScenario,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

const ADMIN_EMAIL = 'admin@example.com';

/** Minimal legacy scenario (mirrors simulations.vitest.test.ts). */
function labScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Access Lab' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] as string[] }],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
    ],
    events: [],
  };
}

describe('simulation access control (Fix-47)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let admin: TestUser;
  let envId: string; // public env owned by `owner`

  beforeEach(async () => {
    ctx = await makeTestApp({ adminEmails: [ADMIN_EMAIL] });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    admin = await registerUser(ctx.app, { email: ADMIN_EMAIL, displayName: 'Admin' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('access-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');

    const scenario = await createUserScenario(ctx.app, labScenario('access-legacy'));
    expect(scenario.statusCode).toBe(201);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createEnvSim(token: string | undefined, env: string = envId): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: { environmentId: env },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createLegacySim(token?: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: { scenarioId: 'access-legacy' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  function list(token?: string, query = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/simulations${query}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  function op(action: string, simId: string, token?: string, emptyJsonBody = false) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/${action}`,
      headers: {
        ...(token !== undefined ? auth(token) : {}),
        ...(emptyJsonBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(emptyJsonBody ? { payload: '' } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // List visibility
  // -------------------------------------------------------------------------

  it('list: a user no longer sees OTHER users’ simulations', async () => {
    const mine = await createEnvSim(owner.token);
    const legacy = await createLegacySim(stranger.token);

    const ownerList = (await list(owner.token)).json().simulations;
    expect(ownerList.some((s: { id: string }) => s.id === mine)).toBe(true);
    // The stranger's legacy sim is neither owner's creation nor in owner's env.
    expect(ownerList.some((s: { id: string }) => s.id === legacy)).toBe(false);

    // The stranger sees their own sim, but not the owner's env sim (not a member).
    const strangerList = (await list(stranger.token)).json().simulations;
    expect(strangerList.some((s: { id: string }) => s.id === legacy)).toBe(true);
    expect(strangerList.some((s: { id: string }) => s.id === mine)).toBe(false);

    // Members see every sim of their environment, whoever created it.
    const viewerList = (await list(viewer.token)).json().simulations;
    expect(viewerList.some((s: { id: string }) => s.id === mine)).toBe(true);

    // Anonymous callers see neither attributable sims nor env-backed sims.
    const anonList = (await list()).json().simulations;
    expect(anonList.some((s: { id: string }) => s.id === mine)).toBe(false);
    expect(anonList.some((s: { id: string }) => s.id === legacy)).toBe(false);

    // Admin sees everything.
    const adminList = (await list(admin.token)).json().simulations;
    expect(adminList.some((s: { id: string }) => s.id === mine)).toBe(true);
    expect(adminList.some((s: { id: string }) => s.id === legacy)).toBe(true);
  });

  it('list: creator-less legacy sims stay visible to everyone (transition semantics)', async () => {
    const orphan = await createLegacySim(); // anonymous creation
    for (const token of [undefined, stranger.token, admin.token]) {
      const sims = (await list(token)).json().simulations;
      expect(sims.some((s: { id: string }) => s.id === orphan)).toBe(true);
    }
  });

  it('list: ?environmentId= filters, validates read access, and 404s unknown envs', async () => {
    const inEnv = await createEnvSim(owner.token);
    const outside = await createLegacySim(owner.token);

    // The filter actually narrows the list.
    const filtered = (await list(owner.token, `?environmentId=${envId}`)).json().simulations;
    expect(filtered.some((s: { id: string }) => s.id === inEnv)).toBe(true);
    expect(filtered.some((s: { id: string }) => s.id === outside)).toBe(false);

    // T52 (R6, u1-F6): the roster carries the creator's DISPLAY NAME beside
    // the raw id — the "whose sim is which" face.
    expect(filtered.find((s: { id: string }) => s.id === inEnv)).toMatchObject({
      createdBy: owner.id,
      creatorName: 'Owner',
    });

    // Public env: a non-member may filter by it explicitly.
    const strangerFiltered = await list(stranger.token, `?environmentId=${envId}`);
    expect(strangerFiltered.statusCode).toBe(200);
    expect(strangerFiltered.json().simulations.some((s: { id: string }) => s.id === inEnv)).toBe(true);

    // Private env: non-members are 403; the member filter works.
    const priv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('access-lab-private'), visibility: 'private' },
    });
    const privId = priv.json().id as string;
    const denied = await list(stranger.token, `?environmentId=${privId}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    const anonDenied = await list(undefined, `?environmentId=${privId}`);
    expect(anonDenied.statusCode).toBe(403);
    const memberFiltered = await list(owner.token, `?environmentId=${privId}`);
    expect(memberFiltered.statusCode).toBe(200);

    // Admin bypasses the visibility check.
    const adminFiltered = await list(admin.token, `?environmentId=${privId}`);
    expect(adminFiltered.statusCode).toBe(200);

    // Unknown env id → 404; empty value → 400.
    const missing = await list(owner.token, '?environmentId=no-such-env');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ENVIRONMENT_NOT_FOUND');
    const empty = await list(owner.token, '?environmentId=');
    expect(empty.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Lifecycle control (stop is the representative op; step spot-checked)
  // -------------------------------------------------------------------------

  it('stop: creator 200; viewer 403 (read-only); stranger 403; anonymous 403; env owner 200; admin 200', async () => {
    // Creator (a viewer may create and then control their OWN sim).
    const viewersOwn = await createEnvSim(viewer.token);
    expect((await op('stop', viewersOwn, viewer.token)).statusCode).toBe(200);

    // A sim created by the builder (an env member).
    const sim = await createEnvSim(builder.token);

    // Viewer member (not the creator) is read-only.
    const viewerStop = await op('stop', sim, viewer.token);
    expect(viewerStop.statusCode).toBe(403);
    expect(viewerStop.json().error.code).toBe('FORBIDDEN');
    expect(viewerStop.json().error.message).toContain('read-only');

    // Non-member and anonymous callers are 403.
    expect((await op('stop', sim, stranger.token)).statusCode).toBe(403);
    expect((await op('stop', sim)).statusCode).toBe(403);

    // The env owner (not the creator) may stop it — classroom management.
    expect((await op('stop', sim, owner.token)).statusCode).toBe(200);

    // Admin may stop any sim.
    const adminTarget = await createEnvSim(builder.token);
    expect((await op('stop', adminTarget, admin.token)).statusCode).toBe(200);

    // The creator may stop their own.
    const buildersOwn = await createEnvSim(builder.token);
    expect((await op('stop', buildersOwn, builder.token)).statusCode).toBe(200);
  });

  it('legacy sims: only the creator (or admin) controls them; creator-less sims stay open', async () => {
    const sim = await createLegacySim(stranger.token);
    expect((await op('stop', sim, owner.token)).statusCode).toBe(403);
    expect((await op('stop', sim)).statusCode).toBe(403);
    expect((await op('stop', sim, stranger.token)).statusCode).toBe(200);

    const orphan = await createLegacySim(); // anonymous creation, createdBy undefined
    expect((await op('stop', orphan, stranger.token)).statusCode).toBe(200);
  });

  it('start/pause/resume/step are gated the same way (spot-check with step + start)', async () => {
    const sim = await createEnvSim(builder.token);
    expect((await op('step', sim, stranger.token)).statusCode).toBe(403);
    expect((await op('start', sim, viewer.token)).statusCode).toBe(403);
    expect((await op('start', sim, builder.token)).statusCode).toBe(200);
    expect((await op('pause', sim, builder.token)).statusCode).toBe(200);
    expect((await op('resume', sim, builder.token)).statusCode).toBe(200);
    const stepped = await op('step', sim, builder.token);
    expect(stepped.statusCode).toBe(200);
  });

  it('event injection and fault writes follow the same gate', async () => {
    const sim = await createEnvSim(builder.token);
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim}/events`,
      headers: auth(stranger.token),
      payload: { type: 'temperature-spike', zoneId: 'zone-a' },
    });
    expect(injected.statusCode).toBe(403);
    const faulted = await ctx.app.inject({
      method: 'PUT',
      url: `/api/simulations/${sim}/faults/some-device`,
      headers: auth(stranger.token),
      payload: { offline: true },
    });
    expect(faulted.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Empty JSON body tolerance
  // -------------------------------------------------------------------------

  it('stop tolerates Content-Type: application/json with an EMPTY body (no more 400)', async () => {
    const sim = await createEnvSim(builder.token);
    const res = await op('stop', sim, builder.token, /* emptyJsonBody */ true);
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('stopped');

    // Malformed JSON still 400s.
    const malformed = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim}/step`,
      headers: { ...auth(builder.token), 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(malformed.statusCode).toBe(400);
  });
});
