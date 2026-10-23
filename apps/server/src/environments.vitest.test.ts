/**
 * @vitest-environment node
 *
 * Environment API tests (fastify inject, in-memory SQLite).
 *
 * Covers: first-boot seeds (the two bundled demo scenarios as public
 * environments owned by the system user), empty-world creation, scenario
 * JSON import (zones/devices/agents expanded, brand preserved), list/detail
 * visibility rules, owner-only patch/delete, and join/leave semantics.
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

describe('environment seeds', () => {
  let ctx: TestAppContext;

  beforeEach(async () => {
    ctx = await makeTestApp();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('seeds the two bundled scenarios as public environments on first boot', async () => {
    const user = await registerUser(ctx.app);
    const res = await ctx.app.inject({
      method: 'GET',
      // R15-D2: seeded worlds are public — the default list is the caller's
      // own environments, so the seed check opts into the full catalog.
      url: '/api/environments?filter=all',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    const envs = res.json().environments;

    const crossBrand = envs.find((e: { name: string }) => e.name === '跨品牌智能家居演示');
    const suzhou = envs.find((e: { name: string }) => e.name === '苏州夏日傍晚公寓');
    expect(crossBrand).toBeDefined();
    expect(suzhou).toBeDefined();

    for (const seed of [crossBrand, suzhou]) {
      expect(seed.visibility).toBe('public');
      expect(seed.owner.displayName).toBe('System');
      expect(seed.mapType).toBe('grid');
      expect(seed.myRole).toBeNull(); // visible because public, not membership
    }
    expect(crossBrand.counts).toMatchObject({ devices: 4, agents: 4, members: 1 });
    expect(suzhou.counts).toMatchObject({ devices: 19, agents: 5, members: 1 });
    // Fix-13 (R5 F-03): the list carries the marketplace scale too.
    expect(typeof crossBrand.counts.services).toBe('number');
    expect(crossBrand.counts.services).toBeGreaterThanOrEqual(0);

    // Detail: zones come from map data; brand survives the import (the core
    // loader drops it, so this proves the raw-file path).
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${crossBrand.id}`,
      headers: auth(user.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().zones).toHaveLength(1);
    expect(detail.json().devices).toHaveLength(4);
    expect(detail.json().devices.map((d: { brand: string }) => d.brand)).toContain('Xiaomi');
    expect(detail.json().agents).toHaveLength(4);
    expect(detail.json().members).toHaveLength(1);
    expect(detail.json().members[0].role).toBe('owner');
  });
});

describe('environment CRUD', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function createEmpty(overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'My World', ...overrides },
    });
  }

  it('requires auth for create and list (401 unauthenticated)', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      payload: { name: 'Nope' },
    });
    expect(create.statusCode).toBe(401);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/environments' });
    expect(list.statusCode).toBe(401);
  });

  it('creates an empty environment; creator becomes the owner member', async () => {
    const res = await createEmpty({
      description: 'empty world',
      mapData: { zones: [{ id: 'z1' }, { id: 'z2', adjacentZoneIds: ['z1'] }] },
      visibility: 'public',
    });
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.name).toBe('My World');
    expect(env.visibility).toBe('public');
    expect(env.zones).toHaveLength(2);
    expect(env.devices).toHaveLength(0);
    expect(env.agents).toHaveLength(0);
    expect(env.members).toHaveLength(1);
    expect(env.members[0]).toMatchObject({ userId: owner.id, role: 'owner', displayName: 'Owner' });
    expect(env.myRole).toBe('owner');
    expect(env.owner).toEqual({ id: owner.id, displayName: 'Owner' });
  });

  it('400s create without a name / with bad visibility / bad mapData', async () => {
    expect((await createEmpty({ name: '' })).statusCode).toBe(400);
    expect((await createEmpty({ visibility: 'friends' })).statusCode).toBe(400);
    expect((await createEmpty({ mapData: { zones: [{ noId: true }] } })).statusCode).toBe(400);
    expect((await createEmpty({ mapData: { zones: [{ id: 'a' }, { id: 'a' }] } })).statusCode).toBe(400);
  });

  it('caps the environment name at 200 chars on create, patch and import (Fix-6)', async () => {
    const tooLong = 'x'.repeat(201);
    const create = await createEmpty({ name: tooLong });
    expect(create.statusCode).toBe(400);
    expect(create.json().error.message).toContain('200');

    const ok = await createEmpty({ name: 'x'.repeat(200) });
    expect(ok.statusCode).toBe(201);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${ok.json().id}`,
      headers: auth(owner.token),
      payload: { name: tooLong },
    });
    expect(patch.statusCode).toBe(400);

    const importTooLong = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('long-name'), meta: { ...importableScenario('long-name').meta, name: tooLong } },
    });
    expect(importTooLong.statusCode).toBe(400);
    expect(importTooLong.json().error.message).toContain('200');
  });

  it('imports a full scenario JSON: zones, devices (with brand), agents', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('import-lab'), visibility: 'public' },
    });
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.name).toBe('Importable Lab');
    expect(env.description).toBe('imported by test');
    expect(env.mapType).toBe('grid');
    expect(env.zones.map((z: { id: string }) => z.id)).toEqual(['zone-a', 'zone-b']);
    expect(env.devices).toHaveLength(2);
    const sensor = env.devices.find((d: { type: string }) => d.type === 'temperature-sensor');
    expect(sensor.brand).toBe('TestBrand');
    expect(sensor.zoneId).toBe('zone-a');
    expect(sensor.initialState).toEqual({ temperature: 20 });
    expect(sensor.owner).toEqual({ id: owner.id, displayName: 'Owner' });
    expect(env.agents).toHaveLength(1);
    expect(env.agents[0].boundDeviceIds).toHaveLength(2);
    expect(env.agents[0].managedZoneIds).toEqual(['zone-a', 'zone-b']);
  });

  it('400s import of an invalid scenario body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { version: '1.0', meta: { id: 'bad', name: 'Bad' }, zones: [], devices: [], agents: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SCENARIO_VALIDATION_FAILED');
  });

  it('BUG-06: 422s import of a scenario whose embedded flow carries an unrecognized param spelling', async () => {
    // The scenario JSON lane now applies the SAME T-002/R13 gates the REST
    // flow routes enforce — pre-fix the loader validated with both oracles
    // defaulted off, so {vol: 30} sailed through and died mid-run.
    const scenario = (id: string, params: Record<string, unknown>) => ({
      version: '1.0',
      meta: { id, name: 'BUG-06 Flow Gate' },
      zones: [{ id: 'room-1' }],
      devices: [
        { id: 'spk-1', type: 'speaker', capabilities: ['set-volume'], zoneId: 'room-1' },
      ],
      agents: [
        {
          id: 'agent-1', name: 'PA Agent', capabilities: [],
          managesZoneIds: ['room-1'], boundDeviceIds: ['spk-1'],
        },
      ],
      flows: [
        {
          id: 'quiet-flow',
          name: 'Quiet Flow',
          enabled: true,
          trigger: { kind: 'event', eventType: 'loud-noise', zoneId: 'room-1' },
          plan: {
            goal: 'lower the volume',
            nodes: [
              {
                id: 'n1', capability: 'set-volume',
                assigneeAgentId: 'agent-1', deviceId: 'spk-1', params,
              },
            ],
          },
        },
      ],
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario('bug06-flow-bad', { vol: 30 }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('FLOW_INVALID');
    expect(res.json().error.message).toContain('vol → volume');

    // The well-spelled twin imports cleanly.
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario('bug06-flow-ok', { volume: 30 }),
    });
    expect(ok.statusCode).toBe(201);
  });

  it('lists only my envs + public envs (not other users’ private envs)', async () => {
    const mine = (await createEmpty({ name: 'Mine (private)' })).json();
    expect((await createEmpty({ name: 'Mine (public)', visibility: 'public' })).statusCode).toBe(201);

    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments?filter=all',
      headers: auth(stranger.token),
    });
    const names = list.json().environments.map((e: { name: string }) => e.name);
    expect(names).not.toContain('Mine (private)');
    expect(names).toContain('Mine (public)');

    const ownList = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(owner.token),
    });
    const entry = ownList.json().environments.find((e: { id: string }) => e.id === mine.id);
    expect(entry.myRole).toBe('owner');
    expect(entry.counts).toEqual({ devices: 0, agents: 0, members: 1, services: 0, zones: 0 }); // T-063: zones joins the counts
  });

  it('default list = my environments only; ?filter=all adds the public catalog (R15-D2)', async () => {
    expect((await createEmpty({ name: 'D2-of-owner', visibility: 'public' })).statusCode).toBe(201);

    const stranger = await registerUser(ctx.app, { displayName: 'Stranger D2' });
    const strangerEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(stranger.token),
      payload: { name: 'D2-of-stranger' },
    });
    expect(strangerEnv.statusCode).toBe(201);

    // Default: each caller sees exactly their own worlds — not the public
    // catalog, not other people's.
    const mineOnly = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(stranger.token),
    });
    const mineNames = mineOnly.json().environments.map((e: { name: string }) => e.name);
    expect(mineNames).toEqual(['D2-of-stranger']);

    // Explicit opt-in restores the full visible set.
    const all = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments?filter=all',
      headers: auth(stranger.token),
    });
    const allNames = all.json().environments.map((e: { name: string }) => e.name);
    expect(allNames).toContain('D2-of-owner');
    expect(allNames).toContain('D2-of-stranger');

    // Bad filter value → 400 (not silently ignored).
    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments?filter=everything',
      headers: auth(stranger.token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('detail access: public env readable anonymously; private env forbidden to strangers', async () => {
    const pub = (await createEmpty({ name: 'Pub', visibility: 'public' })).json();
    const priv = (await createEmpty({ name: 'Priv' })).json();

    const anonPub = await ctx.app.inject({ method: 'GET', url: `/api/environments/${pub.id}` });
    expect(anonPub.statusCode).toBe(200);
    expect(anonPub.json().myRole).toBeNull();

    const anonPriv = await ctx.app.inject({ method: 'GET', url: `/api/environments/${priv.id}` });
    expect(anonPriv.statusCode).toBe(403);

    const stranger = await registerUser(ctx.app);
    const strangerPriv = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${priv.id}`,
      headers: auth(stranger.token),
    });
    expect(strangerPriv.statusCode).toBe(403);
    expect(strangerPriv.json().error.code).toBe('FORBIDDEN');

    const unknown = await ctx.app.inject({ method: 'GET', url: '/api/environments/nope' });
    expect(unknown.statusCode).toBe(404);
  });

  it('patches name/visibility (owner only); strangers and members get 403', async () => {
    const env = (await createEmpty({ name: 'Before' })).json();

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${env.id}`,
      headers: auth(owner.token),
      payload: { name: 'After', visibility: 'public', description: 'now public' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe('After');
    expect(patched.json().visibility).toBe('public');
    expect(patched.json().description).toBe('now public');

    // Fix-1: the owner's direct patch is audited as env-direct-edit with the
    // patched fields' before/after values.
    const logEntries = ctx.app.commandLogStore.listForEnv(env.id, { kind: 'env-direct-edit' });
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].actor_id).toBe(owner.id);
    const logPayload = JSON.parse(logEntries[0].payload_json) as {
      objectType: string;
      action: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(logPayload).toMatchObject({ objectType: 'environment', action: 'updated' });
    expect(logPayload.before).toMatchObject({ name: 'Before', visibility: 'private' });
    expect(logPayload.after).toMatchObject({ name: 'After', visibility: 'public' });

    // Now public → a stranger may read, but not patch.
    const stranger = await registerUser(ctx.app);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/environments/${env.id}` })).statusCode,
    ).toBe(200);
    const forbidden = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${env.id}`,
      headers: auth(stranger.token),
      payload: { name: 'Hijack' },
    });
    expect(forbidden.statusCode).toBe(403);

    const empty = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${env.id}`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('deletes an environment (owner only); members + instances cascade', async () => {
    const env = (await createEmpty({ name: 'Doomed' })).json();
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/devices`,
      headers: auth(owner.token),
      payload: { name: 'D', type: 'sensor', capabilities: [], zoneId: 'z' },
    });
    // No zones → unknown zone; add one first.
    expect(device.statusCode).toBe(400);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${env.id}`,
      headers: auth(owner.token),
      payload: { mapData: { zones: [{ id: 'z' }] } },
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/devices`,
      headers: auth(owner.token),
      payload: { name: 'D', type: 'sensor', capabilities: [], zoneId: 'z' },
    });
    expect(created.statusCode).toBe(201);
    const deviceId = created.json().id;

    const stranger = await registerUser(ctx.app);
    const forbidden = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${env.id}`,
      headers: auth(stranger.token),
    });
    expect(forbidden.statusCode).toBe(403);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${env.id}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/environments/${env.id}` })).statusCode,
    ).toBe(404);
    // Cascade: the device row is gone too (404 at the device endpoint).
    const orphan = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceId}`,
      headers: auth(owner.token),
      payload: { name: 'x' },
    });
    expect(orphan.statusCode).toBe(404);
  });
});

describe('env-create boundary honesty (T-301)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('400s unknown query params with the template-import teaching text', async () => {
    // The exact R12 orchestrator mistake: ?templateId= was silently ignored
    // and produced an empty world that looked like success.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments?templateId=community-nursing-home',
      headers: auth(owner.token),
      payload: { name: 'Bootstrap Mistake' },
    });
    expect(res.statusCode).toBe(400);
    const message = res.json().error.message as string;
    expect(message).toContain('templateId');
    expect(message).toContain('POST /api/environments takes a JSON body');
    expect(message).toContain('GET /api/scenario-templates');
    expect(message).toContain('POST that scenario JSON as the body');
    // Nothing was created behind the 400.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(owner.token),
    });
    expect(list.json().environments).toHaveLength(0);
  });

  it('400s ANY query param on create, naming all of them', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments?foo=1&bar=2',
      headers: auth(owner.token),
      payload: { name: 'Nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('"foo"');
    expect(res.json().error.message).toContain('"bar"');
    expect(res.json().error.message).toContain('parameters');
  });

  it('empty create → 201 + warnings naming the no-zones remedy (not blocked)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Blank Canvas' },
    });
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]).toContain('no zones');
    expect(env.warnings[0]).toContain('import a scenario template');
  });

  it('create with mapData.zones → 201 without warnings', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Zoned', mapData: { zones: [{ id: 'z1' }] } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toBeUndefined();
  });

  it('template-import create (zoned scenario) → 201 without warnings; list/detail unchanged', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: importableScenario('t301-import'),
    });
    expect(res.statusCode).toBe(201);
    const env = res.json();
    expect(env.zones).toHaveLength(2);
    expect(env.warnings).toBeUndefined();

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().environments[0].warnings).toBeUndefined();

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${env.id}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().warnings).toBeUndefined();
  });
});

describe('environment membership', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let other: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    other = await registerUser(ctx.app, { displayName: 'Other' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createEnv(visibility: 'public' | 'private'): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: `Env (${visibility})`, visibility },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it('join: public env → builder; re-join reports alreadyMember; private → 403', async () => {
    const pubId = await createEnv('public');
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${pubId}/join`,
      headers: auth(other.token),
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ envId: pubId, userId: other.id, role: 'builder', alreadyMember: false });

    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${pubId}/join`,
      headers: auth(other.token),
    });
    expect(again.json().alreadyMember).toBe(true);
    expect(again.json().role).toBe('builder');

    // The member now sees the env with its role in the list …
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(other.token),
    });
    const entry = list.json().environments.find((e: { id: string }) => e.id === pubId);
    expect(entry.myRole).toBe('builder');
    expect(entry.counts.members).toBe(2);

    const privId = await createEnv('private');
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${privId}/join`,
      headers: auth(other.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('leave: members leave (204); non-member 400; owner cannot leave', async () => {
    const pubId = await createEnv('public');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${pubId}/join`,
      headers: auth(other.token),
    });

    const left = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${pubId}/leave`,
      headers: auth(other.token),
    });
    expect(left.statusCode).toBe(204);

    const notMember = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${pubId}/leave`,
      headers: auth(other.token),
    });
    expect(notMember.statusCode).toBe(400);
    expect(notMember.json().error.code).toBe('NOT_A_MEMBER');

    const ownerLeave = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${pubId}/leave`,
      headers: auth(owner.token),
    });
    expect(ownerLeave.statusCode).toBe(400);
    expect(ownerLeave.json().error.code).toBe('OWNER_CANNOT_LEAVE');
  });
});

describe('hass:// binding passthrough on scenario import (T-110)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const scenarioWithBinding = (binding: string) => ({
    version: '1.0',
    meta: { id: 'binding-scenario', name: 'Binding Scenario', description: 'd' },
    zones: [{ id: 'zone-a' }],
    devices: [
      {
        id: 'dev-bound',
        name: 'Living Room Light',
        type: 'smart-light',
        capabilities: ['lighting-control'],
        zoneId: 'zone-a',
        binding,
      },
    ],
    agents: [],
    events: [],
  });

  it('preserves a hass:// binding through import; sim stays the default', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenarioWithBinding('hass://light.living-room'),
    });
    expect(res.statusCode).toBe(201);
    const devices = res.json().devices as Array<{ binding: string }>;
    expect(devices).toHaveLength(1);
    expect(devices[0].binding).toBe('hass://light.living-room');

    // Stored row keeps it (the bridge/sim paths read the row, not the wire).
    const envId = res.json().id as string;
    expect(ctx.app.envStore.devicesOf(envId)[0].binding).toBe('hass://light.living-room');

    // No binding → the wire's sim://<uuid> default (unchanged behavior).
    const plain = {
      ...scenarioWithBinding('sim://whatever'),
      meta: { id: 'binding-scenario-2', name: 'Plain', description: 'd' },
    };
    const plainRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: plain,
    });
    expect(plainRes.statusCode).toBe(201);
    expect(ctx.app.envStore.devicesOf(plainRes.json().id)[0].binding).toBeNull();
  });

  it('still rejects invalid binding URIs (loader validation)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenarioWithBinding('ftp://not-a-binding'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SCENARIO_VALIDATION_FAILED');
  });
});

describe('request body limit for scenario imports (T-111)', () => {
  it('a >1MiB scenario imports successfully under the 32MB default limit', async () => {
    const ctx = await makeTestApp();
    try {
      const owner = await registerUser(ctx.app, { displayName: 'Owner' });
      // >1MiB document (Fastify's old default rejected this): pad the
      // description with a long string.
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: {
          version: '1.0',
          meta: {
            id: 'big-import',
            name: 'Big Import',
            description: 'x'.repeat(1024 * 1024 + 4096),
          },
          zones: [{ id: 'zone-a' }],
          devices: [],
          agents: [],
          events: [],
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().zones).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it('an oversized body is a 413 platform envelope with guidance, not a raw framework error', async () => {
    const ctx = await makeTestApp({ maxBodyBytes: 4096 });
    try {
      const owner = await registerUser(ctx.app, { displayName: 'Owner' });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: {
          version: '1.0',
          meta: { id: 'too-big', name: 'Too Big', description: 'x'.repeat(32 * 1024) },
          zones: [{ id: 'zone-a' }],
          devices: [],
          agents: [],
          events: [],
        },
      });
      expect(res.statusCode).toBe(413);
      const error = res.json().error;
      expect(error.code).toBe('REQUEST_BODY_TOO_LARGE');
      expect(error.message).toContain('EAF_MAX_BODY_BYTES');
      expect(error.message).toContain('replay window');
      expect(error.limitBytes).toBe(4096);
    } finally {
      await ctx.cleanup();
    }
  });

  it('a Content-Length/body mismatch is a 400 platform envelope, not a raw Fastify code (R13 CB-F08)', async () => {
    const ctx = await makeTestApp();
    try {
      const owner = await registerUser(ctx.app, { displayName: 'Owner' });
      const body = JSON.stringify({ name: 'Mismatch World', mapData: { zones: [{ id: 'z1' }] } });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { ...auth(owner.token), 'content-type': 'application/json', 'content-length': String(body.length - 7) },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      const error = res.json().error;
      expect(error.code).toBe('CONTENT_LENGTH_MISMATCH');
      expect(error.message).toContain('Content-Length');
      expect(error.message).toContain('--data-binary');
    } finally {
      await ctx.cleanup();
    }
  });
});


// ---------------------------------------------------------------------------
// D2-F7 — list query honesty
// ---------------------------------------------------------------------------

describe('GET /api/environments query honesty (D2-F7)', () => {
  let ctx: TestAppContext;
  let user: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    user = await registerUser(ctx.app, { displayName: 'Querier' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('unknown query params are a loud 400 with the filter teaching', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments?visibility=public',
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('"visibility"');
    expect(body.error.message).toContain('filter=all');
  });

  it('empty "mine" with publics available carries the filter=all hint', async () => {
    // Fresh user with zero envs; the seeded gallery is public.
    const fresh = await registerUser(ctx.app, { displayName: 'Fresh' });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(fresh.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.environments).toEqual([]);
    expect(typeof body.hint).toBe('string');
    expect(body.hint).toContain('filter=all');
  });
});
