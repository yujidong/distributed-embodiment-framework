/**
 * @vitest-environment node
 *
 * User-perspective tests (W5) — 世界视角看生态，我的视角看"我有什么 /
 * 我用什么 / 我在参与什么 / 我要构建什么".
 *
 * Covers: migration v5 (service_subscriptions), the subscribe/unsubscribe
 * endpoints (idempotency + the visibility boundary — hidden others' offers
 * answer 404), the workbench overview (per-env ownership counts for two
 * users sharing one env, flat service/subscription lists, simulation
 * creator tracking), the deployment manifest (catalog join incl. the
 * ambiguous-match rule, backed-by projections, generated notes), and the
 * environment detail's mySubscriptions field.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('user perspective (W5)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let stranger: TestUser;
  let envId: string;

  // Fixture ids, filled by the shared setup below.
  let deviceMeterId: string;
  let deviceAmbigId: string;
  let deviceNoBrandId: string;
  let agentMainId: string;
  let serviceDerivedId: string;
  let servicePublishedId: string;
  let serviceHiddenId: string;
  let catalogModelId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Perspective Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });

    // Catalog fixtures: one UNIQUE match (TestVendor/test-meter) and one
    // AMBIGUOUS match (AmbigVendor/ambig × 2).
    const unique = ctx.app.catalogStore.create({
      vendor: 'TestVendor',
      model: 'TM-1',
      name: 'Test Meter',
      deviceType: 'test-meter',
      capabilities: ['energy-monitoring'],
      priceCny: 100,
      purchaseUrl: 'https://example.com/tm-1',
      source: 'seed',
      status: 'active',
    });
    catalogModelId = unique.id;
    for (const model of ['AM-1', 'AM-2']) {
      ctx.app.catalogStore.create({
        vendor: 'AmbigVendor',
        model,
        name: `Ambig ${model}`,
        deviceType: 'ambig',
        capabilities: [],
        priceCny: 50,
        source: 'seed',
        status: 'active',
      });
    }

    // Owner's devices: catalog-matched / ambiguous / unbranded.
    deviceMeterId = (
      await createDevice(ctx, owner.token, envId, {
        name: 'Meter',
        type: 'test-meter',
        brand: 'TestVendor',
        capabilities: ['energy-monitoring'],
        zoneId: 'zone-a',
      })
    ).id;
    deviceAmbigId = (
      await createDevice(ctx, owner.token, envId, {
        name: 'Ambig',
        type: 'ambig',
        brand: 'AmbigVendor',
        capabilities: [],
        zoneId: 'zone-a',
      })
    ).id;
    deviceNoBrandId = (
      await createDevice(ctx, owner.token, envId, {
        name: 'NoBrand',
        type: 'misc',
        capabilities: [],
        zoneId: 'zone-b',
      })
    ).id;

    // Owner's agents: one with a bound device (derives a service), one pure
    // software (no bindings → the manifest notes it).
    agentMainId = (
      await createAgent(ctx, owner.token, envId, {
        name: 'Main Agent',
        capabilities: [],
        boundDeviceIds: [deviceMeterId],
        managedZoneIds: ['zone-a'],
      })
    ).id;
    // T-206: an agent with no bound devices may declare no capabilities —
    // the pure-software row keeps its name/shape with an empty list.
    await createAgent(ctx, owner.token, envId, {
      name: 'Pure Software',
      capabilities: [],
      boundDeviceIds: [],
    });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    serviceDerivedId = services
      .json()
      .services.find((s: { origin: string }) => s.origin === 'derived').id;

    servicePublishedId = (
      await publishService(ctx, owner.token, envId, agentMainId, {
        name: 'Brokerage',
        semanticType: 'energy-trading',
      })
    ).id;
    serviceHiddenId = (
      await publishService(ctx, owner.token, envId, agentMainId, {
        name: 'Secret',
        semanticType: 'secret-thing',
        visibility: 'hidden',
      })
    ).id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------------
  // Migration v5
  // -------------------------------------------------------------------------

  it('migration v5 creates service_subscriptions with the expected shape', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 5')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 5, name: 'service-subscriptions' });

    const columns = (
      ctx.app.db.prepare('PRAGMA table_info(service_subscriptions)').all() as { name: string }[]
    ).map(column => column.name);
    expect(columns).toEqual(['user_id', 'service_id', 'env_id', 'created_at']);

    const indexes = ctx.app.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'service_subscriptions'")
      .all() as { name: string }[];
    // The UNIQUE(user_id, service_id) constraint materializes as an index.
    expect(indexes.some(index => index.name.includes('service_subscriptions'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Subscribe / unsubscribe
  // -------------------------------------------------------------------------

  it('subscribe is idempotent: 201 first, 200 + alreadySubscribed on repeat', async () => {
    const first = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${servicePublishedId}/subscribe`,
      headers: auth(builder.token),
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      serviceId: servicePublishedId,
      userId: builder.id,
      envId,
      alreadySubscribed: false,
    });

    const second = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${servicePublishedId}/subscribe`,
      headers: auth(builder.token),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadySubscribed).toBe(true);

    // One row only — the UNIQUE constraint held.
    const rows = ctx.app.db
      .prepare('SELECT COUNT(*) AS n FROM service_subscriptions WHERE user_id = ? AND service_id = ?')
      .get(builder.id, servicePublishedId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('unsubscribe is idempotent: 204 whether or not a bookmark existed', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceDerivedId}/subscribe`,
      headers: auth(builder.token),
    });
    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceDerivedId}/subscribe`,
      headers: auth(builder.token),
    });
    expect(first.statusCode).toBe(204);
    const second = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceDerivedId}/subscribe`,
      headers: auth(builder.token),
    });
    expect(second.statusCode).toBe(204);
    expect(ctx.app.serviceStore.subscribedServiceIds(builder.id, envId)).toEqual([]);
  });

  it('404s on unknown services and requires auth', async () => {
    const unknown = await ctx.app.inject({
      method: 'PUT',
      url: '/api/services/no-such-service/subscribe',
      headers: auth(builder.token),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('SERVICE_NOT_FOUND');

    const anonymous = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${servicePublishedId}/subscribe`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('enforces the visibility boundary: hidden others’ offers answer 404', async () => {
    // hidden: provider owner + env owner only → the builder (plain member)
    // and the stranger both get the same 404 as for an unknown id.
    const member = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceHiddenId}/subscribe`,
      headers: auth(builder.token),
    });
    expect(member.statusCode).toBe(404);
    expect(member.json().error.code).toBe('SERVICE_NOT_FOUND');

    const notMember = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceHiddenId}/subscribe`,
      headers: auth(stranger.token),
    });
    expect(notMember.statusCode).toBe(404);

    // The provider owner CAN subscribe to their own hidden offer.
    const provider = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceHiddenId}/subscribe`,
      headers: auth(owner.token),
    });
    expect(provider.statusCode).toBe(201);
  });

  it('members-visibility offers are subscribable by members, not strangers', async () => {
    const membersOnly = (
      await publishService(ctx, owner.token, envId, agentMainId, {
        name: 'Members Only',
        semanticType: 'members-thing',
        visibility: 'members',
      })
    ).id;

    const member = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${membersOnly}/subscribe`,
      headers: auth(builder.token),
    });
    expect(member.statusCode).toBe(201);

    const notMember = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${membersOnly}/subscribe`,
      headers: auth(stranger.token),
    });
    expect(notMember.statusCode).toBe(404);
  });

  it('environment detail carries the caller’s subscription ids', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${servicePublishedId}/subscribe`,
      headers: auth(builder.token),
    });
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(builder.token),
    });
    expect(detail.json().mySubscriptions).toEqual([servicePublishedId]);

    const anonymous = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    expect(anonymous.json().mySubscriptions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // GET /api/me/overview
  // -------------------------------------------------------------------------

  it('overview reports per-env ownership counts for two users in a shared env', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${servicePublishedId}/subscribe`,
      headers: auth(builder.token),
    });
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceDerivedId}/subscribe`,
      headers: auth(builder.token),
    });

    const mine = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/overview',
      headers: auth(owner.token),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().user.id).toBe(owner.id);
    const ownerCard = mine.json().environments.find((env: { id: string }) => env.id === envId);
    expect(ownerCard).toMatchObject({
      name: 'Perspective Lab',
      mapType: 'grid',
      myRole: 'owner',
      myDevices: 3,
      myAgents: 2,
      // derived + published + hidden — hidden still belongs to the caller.
      myServices: 3,
      mySubscriptions: 0,
      runningSimulations: 0,
    });
    expect(mine.json().totals).toMatchObject({
      environments: 1,
      myDevices: 3,
      myAgents: 2,
      myServices: 3,
      mySubscriptions: 0,
      runningSimulations: 0,
    });

    const theirs = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/overview',
      headers: auth(builder.token),
    });
    const builderCard = theirs.json().environments.find((env: { id: string }) => env.id === envId);
    expect(builderCard).toMatchObject({
      myRole: 'builder',
      myDevices: 0,
      myAgents: 0,
      myServices: 0,
      mySubscriptions: 2,
    });
  });

  it('overview lists my published services and my subscriptions across envs', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceDerivedId}/subscribe`,
      headers: auth(builder.token),
    });

    const ownerView = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })
    ).json();
    const offered = ownerView.myServices.map((s: { name: string }) => s.name).sort();
    expect(offered).toEqual(['Brokerage', 'Meter: 用能监测', 'Secret']);
    expect(ownerView.myServices[0]).toMatchObject({ envId, envName: 'Perspective Lab' });
    expect(ownerView.mySubscriptions).toEqual([]);

    const builderView = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(builder.token) })
    ).json();
    expect(builderView.myServices).toEqual([]);
    expect(builderView.mySubscriptions).toEqual([
      {
        id: serviceDerivedId,
        envId,
        envName: 'Perspective Lab',
        name: 'Meter: 用能监测',
        semanticType: 'energy-monitoring',
        provider: { agentId: agentMainId, agentName: 'Main Agent', ownerId: owner.id, ownerName: 'Owner' },
      },
    ]);
  });

  it('subscription provider is fully populated — including ownerId ("找谁签约", Fix-10)', async () => {
    // R4 finding: a subscriber saw provider nulls in the subscription detail.
    // B (owner) publishes; A (builder, member) subscribes; every provider
    // field must be non-null/non-empty in both the overview and the
    // deployment manifest.
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${servicePublishedId}/subscribe`,
      headers: auth(builder.token),
    });

    const overview = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(builder.token) })
    ).json();
    const subscription = overview.mySubscriptions.find(
      (s: { id: string }) => s.id === servicePublishedId,
    );
    expect(subscription).toBeDefined();
    expect(subscription.provider).toEqual({
      agentId: agentMainId,
      agentName: 'Main Agent',
      ownerId: owner.id,
      ownerName: 'Owner',
    });
    for (const value of Object.values(subscription.provider)) {
      expect(value).toBeTruthy();
    }

    const manifest = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment`,
        headers: auth(builder.token),
      })
    ).json();
    const consumed = manifest.servicesConsumed.find(
      (s: { id: string }) => s.id === servicePublishedId,
    );
    expect(consumed.provider).toEqual({
      agentId: agentMainId,
      agentName: 'Main Agent',
      ownerId: owner.id,
      ownerName: 'Owner',
    });
  });

  it('overview excludes public environments the caller is not a member of', async () => {
    const view = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/overview',
      headers: auth(stranger.token),
    });
    expect(
      view.json().environments.find((env: { id: string }) => env.id === envId),
    ).toBeUndefined();
    expect(view.json().totals.environments).toBe(0);
  });

  it('overview requires auth', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/overview' });
    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /api/environments/:id/deployment
  // -------------------------------------------------------------------------

  it('deployment manifest: devices join the catalog (unique / ambiguous / unbranded)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/deployment`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const manifest = res.json();
    expect(manifest.environment).toEqual({ id: envId, name: 'Perspective Lab' });

    const byInstance = new Map(
      manifest.devicesToDeploy.map((d: { instanceId: string }) => [d.instanceId, d]),
    );
    expect(byInstance.get(deviceMeterId)).toMatchObject({
      name: 'Meter',
      type: 'test-meter',
      zoneId: 'zone-a',
      catalogModelId,
      vendor: 'TestVendor',
      model: 'TM-1',
      priceCny: 100,
      purchaseUrl: 'https://example.com/tm-1',
    });
    // Ambiguous (two active models) → catalog fields stay absent, brand kept.
    const ambig = byInstance.get(deviceAmbigId);
    expect(ambig.vendor).toBe('AmbigVendor');
    expect(ambig.catalogModelId).toBeUndefined();
    expect(ambig.model).toBeUndefined();
    expect(ambig.priceCny).toBeUndefined();
    // Unbranded → nothing catalog-ish at all.
    const noBrand = byInstance.get(deviceNoBrandId);
    expect(noBrand.vendor).toBeUndefined();
    expect(noBrand.catalogModelId).toBeUndefined();

    expect(manifest.notes).toContain('1 台设备待采购，名录总价约 ¥100');
    expect(manifest.notes).toContain('2 台设备未匹配到名录型号（无品牌或型号不唯一），需人工确认采购渠道');
  });

  it('deployment manifest: binding + deploymentStatus + sync-bindings summary (Fix-18, R7 F-05)', async () => {
    // Bridge the meter to real hardware, then wire a twin-sync binding on it.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${deviceMeterId}`,
      headers: auth(owner.token),
      payload: { binding: 'hass://sensor.living_room_temperature' },
    });
    expect(patched.statusCode).toBe(200);
    const bound = await ctx.app.inject({
      method: 'PUT',
      url: `/api/environments/${envId}/sync-bindings`,
      headers: auth(owner.token),
      payload: {
        bindings: [{ deviceInstanceId: deviceMeterId, attributeKey: 'energy', source: 'manual' }],
      },
    });
    expect(bound.statusCode).toBe(200);

    const manifest = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment`,
        headers: auth(owner.token),
      })
    ).json();

    const byInstance = new Map(
      manifest.devicesToDeploy.map((d: { instanceId: string }) => [d.instanceId, d]),
    );
    // Bridged devices are told apart from simulation-only ones.
    expect(byInstance.get(deviceMeterId)).toMatchObject({
      binding: 'hass://sensor.living_room_temperature',
      deploymentStatus: 'bridged',
    });
    expect(byInstance.get(deviceAmbigId)).toMatchObject({
      binding: `sim://${deviceAmbigId}`,
      deploymentStatus: 'simulation-only',
    });
    expect(manifest.syncBindings).toEqual([
      { deviceInstanceId: deviceMeterId, attributeKey: 'energy', source: 'manual', status: 'active' },
    ]);
    expect(manifest.notes).toContain('1 台设备已桥接真实硬件（hass:// 绑定），其余为纯仿真设备');

    // The summary is scoped to the caller's own devices — the builder owns
    // none here, so their manifest carries no sync bindings.
    const builderManifest = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment`,
        headers: auth(builder.token),
      })
    ).json();
    expect(builderManifest.syncBindings).toEqual([]);
  });

  it('deployment manifest: agents, services to offer (backed-by), notes', async () => {
    const manifest = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment`,
        headers: auth(owner.token),
      })
    ).json();

    const agentNames = manifest.myAgents.map((a: { name: string }) => a.name).sort();
    expect(agentNames).toEqual(['Main Agent', 'Pure Software']);
    const pure = manifest.myAgents.find((a: { name: string }) => a.name === 'Pure Software');
    expect(pure.capabilities).toEqual([]);
    expect(pure.llm).toBeNull();

    const offered = new Map(
      manifest.servicesToOffer.map((s: { id: string }) => [s.id, s]),
    );
    expect(offered.get(serviceDerivedId)).toMatchObject({
      semanticType: 'energy-monitoring',
      origin: 'derived',
      backedByDeviceIds: [deviceMeterId],
    });
    // Published + unbacked: no bound device offers energy-trading.
    expect(offered.get(servicePublishedId)).toMatchObject({
      origin: 'published',
      backedByDeviceIds: [],
    });
    expect(manifest.notes).toContain('纯软件主体：Pure Software 无绑定设备，部署仅需 Agent 与服务契约');
  });

  it('deployment manifest: servicesConsumed mirrors the caller’s subscriptions', async () => {
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${serviceDerivedId}/subscribe`,
      headers: auth(builder.token),
    });
    const manifest = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment`,
        headers: auth(builder.token),
      })
    ).json();
    expect(manifest.myAgents).toEqual([]);
    expect(manifest.devicesToDeploy).toEqual([]);
    expect(manifest.servicesToOffer).toEqual([]);
    expect(manifest.servicesConsumed).toEqual([
      {
        id: serviceDerivedId,
        name: 'Meter: 用能监测',
        semanticType: 'energy-monitoring',
        provider: { agentId: agentMainId, agentName: 'Main Agent', ownerId: owner.id, ownerName: 'Owner' },
      },
    ]);
    expect(manifest.notes).toContain('你在该环境中还没有设备与 Agent —— 可先在「名录」放置设备或创建 Agent');
  });

  it('deployment manifest is member-only (403 stranger, 401 anonymous, 404 unknown env)', async () => {
    const notMember = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/deployment`,
      headers: auth(stranger.token),
    });
    expect(notMember.statusCode).toBe(403);

    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/deployment`,
    });
    expect(anonymous.statusCode).toBe(401);

    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments/no-such-env/deployment',
      headers: auth(owner.token),
    });
    expect(unknown.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Simulation creator tracking
  // -------------------------------------------------------------------------

  it('records the simulation creator when authenticated; anonymous stays null', async () => {
    const mine = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(mine.statusCode).toBe(201);
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { environmentId: envId },
    });
    expect(anon.statusCode).toBe(201);

    // Fix-47: the list is caller-scoped — the owner (creator of `mine`,
    // member of the env backing `anon`) sees both; anonymous callers would
    // see neither.
    const list = (
      await ctx.app.inject({ method: 'GET', url: '/api/simulations', headers: auth(owner.token) })
    ).json().simulations;
    const mineEntry = list.find((s: { id: string }) => s.id === mine.json().id);
    const anonEntry = list.find((s: { id: string }) => s.id === anon.json().id);
    expect(mineEntry.createdBy).toBe(owner.id);
    expect(anonEntry.createdBy).toBeUndefined();

    // created-but-not-started does NOT count as 运行中 — but it DOES count
    // as 曾创建过 (simulationCount); the anonymous sim belongs to no one.
    let overview = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })
    ).json();
    expect(overview.environments[0].runningSimulations).toBe(0);
    expect(overview.environments[0].simulationCount).toBe(1);
    expect(overview.totals.simulationCount).toBe(1);

    // Fix-47: start/stop are creator (or env owner/builder/admin) ops.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${mine.json().id}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    overview = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })
    ).json();
    expect(overview.environments[0].runningSimulations).toBe(1);
    expect(overview.environments[0].runningSimulationIds).toEqual([mine.json().id]);
    expect(overview.totals.runningSimulations).toBe(1);

    // Another member never CREATED a sim (simulationCount stays 0), but R47
    // made runningSimulations count every LIVE sim on their environment
    // under the same creator-OR-member visibility as GET /api/simulations —
    // the workbench 运行中仿真 attach button must offer the team's sim to
    // stakeholders who never started one. Anonymous sims belong to no one.
    const builderView = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(builder.token) })
    ).json();
    expect(builderView.environments[0].runningSimulations).toBe(1);
    expect(builderView.environments[0].runningSimulationIds).toEqual([mine.json().id]);
    expect(builderView.environments[0].simulationCount).toBe(0);

    // Stopped sims drop out of the running count but stay in simulationCount.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${mine.json().id}/stop`,
      headers: auth(owner.token),
      payload: {},
    });
    overview = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })
    ).json();
    expect(overview.environments[0].runningSimulations).toBe(0);
    expect(overview.environments[0].simulationCount).toBe(1);
  });

  it('R6-D-F02: overview flags a world-session env (hasWorldSession) with simulationCount still 0', async () => {
    // R73: the world session auto-starts at env creation — the official
    // always-on path never creates a simulation, so simulationCount cannot
    // be the only onboarding ③ signal.
    expect(await until(() => ctx.app.worldSessions.statusOf(envId) !== undefined, 10_000)).toBe(true);
    const overview = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })
    ).json();
    const entry = overview.environments.find((e: { id: string }) => e.id === envId);
    expect(entry.simulationCount).toBe(0);
    expect(entry.hasWorldSession).toBe(true);
  });

  it('R2-FEAT-07: overview separates blueprint installs from plain owned content (myBlueprintInstalls)', async () => {
    // The setup's manually created devices/agents carry no lineage — the
    // onboarding ② signal must NOT credit them (nor template-import content).
    const find = (overview: { environments: Array<{ id: string } & Record<string, number>> }) =>
      overview.environments.find(e => e.id === envId)!;
    const before = find(
      (await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })).json(),
    );
    expect(before.myDevices).toBeGreaterThan(0);
    expect(before.myBlueprintInstalls).toBe(0);

    const install = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/classroom-energy-saver/install`,
      headers: auth(owner.token),
      payload: { zoneId: 'zone-a' },
    });
    expect(install.statusCode).toBe(201);

    const after = find(
      (await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(owner.token) })).json(),
    );
    // classroom-energy-saver = 2 devices + 1 agent, all lineage-tagged.
    expect(after.myBlueprintInstalls).toBe(3);
    // …and only for the installer — a fellow member owns nothing here.
    const builderView = find(
      (await ctx.app.inject({ method: 'GET', url: '/api/me/overview', headers: auth(builder.token) })).json(),
    );
    expect(builderView.myBlueprintInstalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function createDevice(
  ctx: TestAppContext,
  token: string,
  envId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/devices`,
    headers: auth(token),
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function createAgent(
  ctx: TestAppContext,
  token: string,
  envId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/agents`,
    headers: auth(token),
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function publishService(
  ctx: TestAppContext,
  token: string,
  envId: string,
  agentId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/agents/${agentId}/services`,
    headers: auth(token),
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}
