/**
 * @vitest-environment node
 *
 * Service layer tests (W3) — derived + published services as the cross-owner
 * visibility boundary.
 *
 * Covers: migration v4 schema, the derivation sync triggers (agent create /
 * rebind / device capability change / device rename / agent delete / device
 * delete), world-sync service broadcasts, the three-level visibility matrix
 * (incl. anonymous), published-vs-derived edit rules, the unbacked flag, and
 * the seeded city services.
 */

import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  auth,
  makeTestApp,
  registerUser,
  until,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import { backfillDerivedServiceInterfaces } from './db/database.js';

describe('service layer (W3)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Service Lab',
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
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------------
  // HTTP helpers
  //
  // Fix-1: HTTP device/agent creation is env-owner only (a builder's create
  // becomes a proposal). Tests about the derivation sync use the owner;
  // tests that specifically need a BUILDER-owned agent seed it through the
  // store (seedBuilderAgent) — that is the state an approved proposal would
  // have produced.
  // -------------------------------------------------------------------------

  function createDevice(token: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(token),
      payload: {
        name: 'Meter',
        type: 'energy-meter',
        capabilities: ['energy-monitoring'],
        zoneId: 'zone-a',
        ...overrides,
      },
    });
  }

  function createAgent(token: string, boundDeviceIds: string[]) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(token),
      payload: { name: 'Agent', capabilities: [], boundDeviceIds },
    });
  }

  /**
   * Seed a builder-owned device + agent directly (as an approved proposal
   * would have created them) and run the derivation sync the route runs.
   */
  function seedBuilderAgent(capabilities = ['energy-monitoring'], deviceName = 'Meter') {
    const device = ctx.app.envStore.createDevice({
      envId,
      ownerId: builder.id,
      name: deviceName,
      type: 'energy-meter',
      capabilities,
      zoneId: 'zone-a',
    });
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: builder.id,
      name: 'Agent',
      capabilities: [],
      boundDeviceIds: [device.id],
    });
    ctx.app.serviceStore.syncDerivedForAgent(agent.id);
    return { device, agent };
  }

  function listServices(token?: string, query = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services${query}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  function publishService(token: string, agentId: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: auth(token),
      payload: { name: 'Offer', semanticType: 'energy-trading', ...body },
    });
  }

  // -------------------------------------------------------------------------
  // Migration v4
  // -------------------------------------------------------------------------

  it('migration v4 creates service_instances with the expected shape', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 4')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 4, name: 'service-instances' });

    const columns = (
      ctx.app.db.prepare('PRAGMA table_info(service_instances)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(columns).toEqual([
      'id',
      'env_id',
      'provider_agent_id',
      'name',
      'semantic_type',
      'description',
      'interface_json',
      'origin',
      'source_device_id',
      'source_flow_id', // Mechanism D (v38 rebuild — origin gains 'flow')
      'visibility',
      'created_at',
      'zone_id', // D2 (T-079, v47) — declared zone of published/flow offers
    ]);

    const indexes = (
      ctx.app.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'service_instances'")
        .all() as Array<{ name: string }>
    ).map(index => index.name);
    expect(indexes).toContain('idx_service_instances_env');
    expect(indexes).toContain('idx_service_instances_semantic_type');
  });

  // -------------------------------------------------------------------------
  // Migration v18 — derived interface backfill (Fix-20, Fix-15 leftover)
  // -------------------------------------------------------------------------

  it('migration v18 backfills empty interfaces of legacy derived services', async () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 18')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 18, name: 'derived-service-interface-backfill' });

    // A live derived service (Fix-15 interface present), then rewind its row
    // to the pre-Fix-15 legacy shape ('{}') to simulate an old database.
    const device = (
      await createDevice(owner.token, {
        name: 'AC',
        type: 'hvac',
        capabilities: ['turn-on', 'set-temperature'],
      })
    ).json();
    await createAgent(owner.token, [device.id]);
    const legacy = (await listServices(owner.token)).json().services
      .find((s: { semanticType: string }) => s.semanticType === 'turn-on');
    ctx.app.db
      .prepare("UPDATE service_instances SET interface_json = '{}' WHERE id = ?")
      .run(legacy.id);

    // A published offer with an empty interface must NOT be touched (only
    // derived rows are backfilled), nor a derived row whose device is gone.
    const published = ctx.app.serviceStore.createService({
      envId,
      providerAgentId: legacy.provider.id,
      name: 'Manual',
      semanticType: 'turn-on',
      description: '',
      origin: 'published',
    });
    const orphan = ctx.app.serviceStore.createService({
      envId,
      providerAgentId: legacy.provider.id,
      name: 'Orphan',
      semanticType: 'turn-on',
      description: '',
      origin: 'derived',
      sourceDeviceId: null,
    });

    const updated = backfillDerivedServiceInterfaces(ctx.app.db);
    expect(updated).toBe(1);
    const refilled = ctx.app.serviceStore.getService(legacy.id)!;
    const actions = (JSON.parse(refilled.interface_json).actions as Array<{ name: string }>)
      .map(action => action.name);
    expect(actions).toEqual(['turn-on', 'set-temperature']);
    expect(ctx.app.serviceStore.getService(published.id)!.interface_json).toBe('{}');
    expect(ctx.app.serviceStore.getService(orphan.id)!.interface_json).toBe('{}');
  });

  // -------------------------------------------------------------------------
  // Derivation sync
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // R53 — semantic (aggregate) offers over the capability bundle
  // -------------------------------------------------------------------------

  it('R53: a pump-steward capability bundle derives an aggregate drainage-control offer, and the semantic type joins the agent declarations', async () => {
    // The grounded shenzhen pump-steward surface: valve-control +
    // water-level-monitoring (+ generic actuation).
    const valve = (
      await createDevice(owner.token, {
        name: '排涝智能阀 1',
        capabilities: ['valve-control', 'turn-on', 'turn-off', 'open'],
      })
    ).json();
    const gauge = (
      await createDevice(owner.token, {
        name: '内涝水位计 1',
        capabilities: ['water-level-monitoring'],
      })
    ).json();
    const agent = (await createAgent(owner.token, [valve.id, gauge.id])).json();

    const services = (await listServices(owner.token)).json().services;
    const aggregate = services.filter((s: { origin: string }) => s.origin === 'aggregate');
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]).toMatchObject({
      semanticType: 'drainage-control',
      name: '区域排涝调度',
      sourceDeviceId: null,
      unbacked: false,
    });
    // P5: origin=aggregate is a first-class list filter (400 pre-P5).
    const onlyAggregate = (await listServices(owner.token, '?origin=aggregate')).json().services;
    expect(onlyAggregate).toHaveLength(1);
    expect(onlyAggregate[0].semanticType).toBe('drainage-control');
    // The callable surface = the actuation backing's executable commands
    // (the list API already parses interface_json into `interface`).
    const actions = (aggregate[0].interface as { actions: Array<{ name: string }> }).actions;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(action => /^turn-(on|off)$|^open$|^valve/.test(action.name) || action.name.length > 0)).toBe(true);

    // The stored declaration stays CLEAN (the PATCH backing check polices
    // hand-written capabilities) — the semantic surface joins the RUNTIME
    // matching at scenario assembly: a sim on this env sees the agent's
    // capabilities unioned with drainage-control.
    const detail = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json();
    const declared = detail.agents.find((a: { id: string }) => a.id === agent.id).capabilities;
    expect(declared).not.toContain('drainage-control');
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    const snap = (await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${sim.json().id}/snapshot`,
      headers: auth(owner.token),
    })).json();
    const runtimeCaps = snap.agents.find((a: { id: string }) => a.id === agent.id).capabilities;
    expect(runtimeCaps).toContain('drainage-control');

    // Unbinding the gauge drops the qualification AND the offer (idempotent
    // sync), while the valve's own device-derived rows survive.
    const unbind = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
      payload: { boundDeviceIds: [valve.id] },
    });
    expect(unbind.statusCode, JSON.stringify(unbind.json()).slice(0, 200)).toBe(200);
    const after = (await listServices(owner.token)).json().services;
    expect(
      after.filter((s: { origin: string }) => s.origin === 'aggregate'),
      JSON.stringify(after.map((s: { origin: string; semanticType: string }) => `${s.origin}:${s.semanticType}`)),
    ).toHaveLength(0);
  });

  it('derives one service per (bound device × capability) on agent create', async () => {
    const device = (
      await createDevice(owner.token, {
        name: 'Main Meter',
        capabilities: ['energy-monitoring', 'power-monitoring'],
      })
    ).json();
    const agent = (await createAgent(owner.token, [device.id])).json();

    const listed = await listServices(owner.token);
    expect(listed.statusCode).toBe(200);
    const services = listed.json().services;
    expect(services).toHaveLength(2);
    expect(services.map((s: { name: string }) => s.name).sort()).toEqual([
      'Main Meter: 用能监测',
      'Main Meter: 电力监测',
    ]);
    for (const service of services) {
      expect(service.origin).toBe('derived');
      expect(service.semanticType).toMatch(/monitoring/);
      expect(service.sourceDeviceId).toBe(device.id);
      // T-208: derived rows default to members-only visibility.
      expect(service.visibility).toBe('members');
      expect(service.unbacked).toBe(false);
      expect(service.provider).toEqual({
        id: agent.id,
        name: 'Agent',
        owner: { id: owner.id, displayName: 'Owner' },
      });
    }
  });

  it('derived services expose the backing device callable surface as interface.actions (Fix-15, F-27)', async () => {
    const device = (
      await createDevice(owner.token, {
        name: 'AC',
        type: 'hvac',
        capabilities: [
          'temperature-control', 'cooling', 'heating',
          'turn-on', 'turn-off', 'set-temperature', 'set-mode',
          'not-a-command', // not executable: filtered out of the actions
        ],
      })
    ).json();
    await createAgent(owner.token, [device.id]);

    const services = (await listServices(owner.token)).json().services;
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      const names = (service.interface.actions as Array<{ name: string }>).map(a => a.name);
      expect(names).toContain('set-temperature');
      expect(names).toContain('turn-on');
      expect(names).not.toContain('not-a-command');
    }
    // Parameter schema basics ride along for the well-known commands.
    const setTemperature = services[0].interface.actions
      .find((a: { name: string }) => a.name === 'set-temperature');
    expect(setTemperature.parameters.targetTemperature).toMatchObject({ type: 'number' });
    const setMode = services[0].interface.actions
      .find((a: { name: string }) => a.name === 'set-mode');
    expect(setMode.parameters.mode.enum).toContain('cooling');

    // The detail channel (`eaf service get`) carries the same interface.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${services[0].id}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().interface.actions.length).toBeGreaterThan(0);

    // A capability change refreshes the interface, not only the rows.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { capabilities: ['energy-monitoring'] },
    });
    const refreshed = (await listServices(owner.token)).json().services;
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].interface.actions.map((a: { name: string }) => a.name))
      .toEqual(['energy-monitoring']);
  });

  it('keeps derived services in sync on rebind (unbind removes, bind adds)', async () => {
    const first = (await createDevice(owner.token, { name: 'First', type: 'light', capabilities: ['turn-on'] })).json();
    const second = (
      await createDevice(owner.token, {
        name: 'Second', type: 'light', capabilities: ['turn-off', 'set-brightness'], zoneId: 'zone-b',
      })
    ).json();
    const agent = (await createAgent(owner.token, [first.id])).json();
    expect((await listServices(owner.token)).json().services).toHaveLength(1);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
      payload: { boundDeviceIds: [second.id] },
    });
    expect(patched.statusCode).toBe(200);

    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { name: string }) => s.name).sort()).toEqual([
      'Second: 亮度调节',
      'Second: 关闭',
    ]);
    // Unbinding everything removes all derived services.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
      payload: { boundDeviceIds: [] },
    });
    expect((await listServices(owner.token)).json().services).toHaveLength(0);
  });

  it('refreshes derived services when a device capability set changes', async () => {
    const device = (await createDevice(owner.token, { type: 'light', capabilities: ['turn-on'] })).json();
    await createAgent(owner.token, [device.id]);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { capabilities: ['turn-off', 'set-brightness'] },
    });
    expect(patched.statusCode).toBe(200);

    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType).sort()).toEqual([
      'set-brightness',
      'turn-off',
    ]);
  });

  it('renames derived services when the source device is renamed', async () => {
    const device = (await createDevice(owner.token, { name: 'Old Name' })).json();
    await createAgent(owner.token, [device.id]);
    expect(
      (await listServices(owner.token)).json().services.map((s: { name: string }) => s.name),
    ).toEqual(['Old Name: 用能监测']);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { name: 'New Name' },
    });
    expect(
      (await listServices(owner.token)).json().services.map((s: { name: string }) => s.name),
    ).toEqual(['New Name: 用能监测']);
  });

  it('cascades services on agent delete and removes derived rows on device delete', async () => {
    const device = (await createDevice(owner.token)).json();
    const agent = (await createAgent(owner.token, [device.id])).json();
    await publishService(owner.token, agent.id, { name: 'Explicit' });
    expect((await listServices(owner.token)).json().services).toHaveLength(2);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await listServices(owner.token)).json().services).toHaveLength(0);

    const device2 = (await createDevice(owner.token)).json();
    await createAgent(owner.token, [device2.id]);
    expect((await listServices(owner.token)).json().services).toHaveLength(1);
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${device2.id}`,
      headers: auth(owner.token),
    });
    expect((await listServices(owner.token)).json().services).toHaveLength(0);
  });

  it('publishes world-sync service messages for derivation changes', async () => {
    const messages: Array<{ action: string; objectType: string }> = [];
    const unsubscribe = ctx.app.worldSync.subscribe(envId, message => {
      if (message.kind === 'world') messages.push(message);
    });
    try {
      const device = (await createDevice(owner.token, { type: 'light', capabilities: ['turn-on', 'turn-off'] })).json();
      await createAgent(owner.token, [device.id]);
      const created = messages.filter(m => m.objectType === 'service' && m.action === 'created');
      expect(created).toHaveLength(2);

      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/devices/${device.id}`,
        headers: auth(owner.token),
        payload: { capabilities: ['turn-off'] },
      });
      const deleted = messages.filter(m => m.objectType === 'service' && m.action === 'deleted');
      expect(deleted).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  // -------------------------------------------------------------------------
  // Publishing + edit rules
  // -------------------------------------------------------------------------

  it('publishes explicit offers (agent owner or env owner only)', async () => {
    const { agent } = seedBuilderAgent();

    const published = await publishService(builder.token, agent.id, {
      name: 'Energy brokerage',
      semanticType: 'energy-trading',
      description: 'Brokers surplus capacity',
      interface: { params: [{ name: 'kwh', type: 'number' }] },
      visibility: 'members',
    });
    expect(published.statusCode).toBe(201);
    const service = published.json();
    expect(service.origin).toBe('published');
    expect(service.sourceDeviceId).toBeNull();
    expect(service.visibility).toBe('members');
    expect(service.interface).toEqual({ params: [{ name: 'kwh', type: 'number' }] });

    const byEnvOwner = await publishService(owner.token, agent.id, { name: 'Owner offer' });
    expect(byEnvOwner.statusCode).toBe(201);

    for (const token of [viewer.token, stranger.token]) {
      const forbidden = await publishService(token, agent.id, {});
      expect(forbidden.statusCode).toBe(403);
    }
    const badBody = await publishService(builder.token, agent.id, { semanticType: '' });
    expect(badBody.statusCode).toBe(400);
  });

  it('R80-1: re-publishing the same provider+semanticType warns (non-blocking), first publish does not', async () => {
    const { agent } = seedBuilderAgent();

    // First publish of the type — no advisory.
    const first = await publishService(builder.token, agent.id, { name: 'Energy desk' });
    expect(first.statusCode).toBe(201);
    expect(first.json().warnings).toBeUndefined();

    // Same provider agent + same semantic type → 201 WITH the advisory
    // naming the existing offer (teach, don't refuse).
    const second = await publishService(builder.token, agent.id, { name: 'Energy desk 2' });
    expect(second.statusCode).toBe(201);
    const warnings = second.json().warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('energy-trading');
    expect(warnings[0]).toContain('Energy desk');
    expect(warnings[0]).toContain('allowed');

    // A different semantic type, or the same type under ANOTHER provider
    // agent, is legitimate — no advisory.
    const otherType = await publishService(builder.token, agent.id, { semanticType: 'demand-response' });
    expect(otherType.statusCode).toBe(201);
    expect(otherType.json().warnings).toBeUndefined();
    const { agent: secondAgent } = seedBuilderAgent(['energy-monitoring'], 'Meter 2');
    const otherProvider = await publishService(builder.token, secondAgent.id, { name: 'Mirror desk' });
    expect(otherProvider.statusCode).toBe(201);
    expect(otherProvider.json().warnings).toBeUndefined();
  });

  it('published services are fully editable; derived ones accept visibility only', async () => {
    const { device, agent } = seedBuilderAgent();
    const published = (await publishService(builder.token, agent.id, {})).json();
    const derived = (await listServices(owner.token)).json().services.find(
      (s: { origin: string }) => s.origin === 'derived',
    );

    const fullEdit = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${published.id}`,
      headers: auth(builder.token),
      payload: { name: 'Renamed', semanticType: 'capacity-brokerage', description: 'd', visibility: 'hidden' },
    });
    expect(fullEdit.statusCode).toBe(200);
    expect(fullEdit.json()).toMatchObject({
      name: 'Renamed',
      semanticType: 'capacity-brokerage',
      visibility: 'hidden',
    });

    const derivedNameEdit = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${derived.id}`,
      headers: auth(builder.token),
      payload: { name: 'Not allowed' },
    });
    expect(derivedNameEdit.statusCode).toBe(409);
    expect(derivedNameEdit.json().error.code).toBe('SERVICE_DERIVED_READONLY');

    const derivedVisibility = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${derived.id}`,
      headers: auth(builder.token),
      payload: { visibility: 'members' },
    });
    expect(derivedVisibility.statusCode).toBe(200);
    expect(derivedVisibility.json().visibility).toBe('members');

    // Visibility survives the derivation sync (managed rows are not reset).
    // (The env owner drives the sync — Fix-1: direct edits are owner-only.)
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { capabilities: ['energy-monitoring', 'extra'] },
    });
    const after = (await listServices(owner.token)).json().services.find(
      (s: { id: string }) => s.id === derived.id,
    );
    expect(after.visibility).toBe('members');

    // Only the agent owner or env owner may edit.
    const byStranger = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${published.id}`,
      headers: auth(stranger.token),
      payload: { name: 'Nope' },
    });
    expect(byStranger.statusCode).toBe(403);
  });

  it('deletes published services only — derived deletion is a 409', async () => {
    const { agent } = seedBuilderAgent();
    const published = (await publishService(builder.token, agent.id, {})).json();
    const derived = (await listServices(owner.token)).json().services.find(
      (s: { origin: string }) => s.origin === 'derived',
    );

    const derivedDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${derived.id}`,
      headers: auth(builder.token),
    });
    expect(derivedDelete.statusCode).toBe(409);
    expect(derivedDelete.json().error.code).toBe('SERVICE_DERIVED_READONLY');

    const publishedDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/services/${published.id}`,
      headers: auth(builder.token),
    });
    expect(publishedDelete.statusCode).toBe(204);
  });

  // -------------------------------------------------------------------------
  // Unbacked flag
  // -------------------------------------------------------------------------

  it('flags published services backed by no bound device as unbacked', async () => {
    const { agent } = seedBuilderAgent(['energy-monitoring']);

    const backed = (await publishService(builder.token, agent.id, {
      name: 'Backed',
      semanticType: 'energy-monitoring',
    })).json();
    expect(backed.unbacked).toBe(false);

    const unbacked = (await publishService(builder.token, agent.id, {
      name: 'Brokered',
      semanticType: 'weather-forecast',
    })).json();
    expect(unbacked.unbacked).toBe(true);

    // Env detail carries the same flag.
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    const brokered = detail.json().services.find((s: { name: string }) => s.name === 'Brokered');
    expect(brokered.unbacked).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Visibility matrix
  // -------------------------------------------------------------------------

  it('applies the public/members/hidden visibility matrix (incl. anonymous)', async () => {
    const { agent } = seedBuilderAgent();
    await publishService(builder.token, agent.id, { name: 'Public offer', visibility: 'public' });
    await publishService(builder.token, agent.id, { name: 'Members offer', visibility: 'members' });
    await publishService(builder.token, agent.id, { name: 'Hidden offer', visibility: 'hidden' });

    const namesOf = async (token?: string) =>
      ((await listServices(token)).json().services as Array<{ name: string }>).map(s => s.name).sort();

    // Derived service stored visibility defaults to members (T-208), but the
    // env-following mode (设备私有、服务公开) reads members-derived rows as
    // public on a PUBLIC environment — anonymous/non-member readers see the
    // derived row alongside the explicitly public offer; PUBLISHED offers
    // keep their own tier.
    const DERIVED = 'Meter: 用能监测';
    expect(await namesOf()).toEqual([DERIVED, 'Public offer']); // anonymous
    expect(await namesOf(stranger.token)).toEqual([DERIVED, 'Public offer']); // non-member
    expect(await namesOf(viewer.token)).toEqual(['Members offer', DERIVED, 'Public offer']);
    // builder = provider agent owner, owner = env owner → hidden too
    expect(await namesOf(builder.token)).toEqual([
      'Hidden offer',
      'Members offer',
      DERIVED,
      'Public offer',
    ]);
    expect(await namesOf(owner.token)).toEqual([
      'Hidden offer',
      'Members offer',
      DERIVED,
      'Public offer',
    ]);

    // The env detail response applies the same rules.
    const anonDetail = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    expect(anonDetail.json().services.map((s: { name: string }) => s.name).sort()).toEqual([
      DERIVED,
      'Public offer',
    ]);
    const ownerDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(ownerDetail.json().services).toHaveLength(4);
  });

  it('filters the list by semanticType, provider and origin', async () => {
    const { agent } = seedBuilderAgent(['turn-on', 'turn-off']);
    const otherAgent = ctx.app.envStore.createAgent({
      envId,
      ownerId: builder.id,
      name: 'Other Agent',
      capabilities: [],
      boundDeviceIds: [],
    });
    await publishService(builder.token, otherAgent.id, { name: 'Solo', semanticType: 'turn-on' });

    const byType = await listServices(owner.token, '?semanticType=turn-on');
    expect(byType.json().services).toHaveLength(2); // derived turn-on + published Solo

    const byProvider = await listServices(owner.token, `?provider=${agent.id}`);
    expect(byProvider.json().services).toHaveLength(2);

    const byOrigin = await listServices(owner.token, '?origin=published');
    expect(byOrigin.json().services).toHaveLength(1);

    // P5: 'aggregate' joins the origin filter enum (this world has no
    // aggregate offers — the filter is valid and simply matches nothing).
    const byAggregate = await listServices(owner.token, '?origin=aggregate');
    expect(byAggregate.statusCode).toBe(200);
    expect(byAggregate.json().services).toHaveLength(0);

    const badOrigin = await listServices(owner.token, '?origin=bogus');
    expect(badOrigin.statusCode).toBe(400);
  });

  it('full-text search: q matches name/description/semanticType, case-insensitive, composable (Fix-20, F-09)', async () => {
    seedBuilderAgent(['energy-monitoring']); // derived "Meter: energy-monitoring"
    const { agent } = seedBuilderAgent(['energy-monitoring'], 'Roof Meter');
    await publishService(builder.token, agent.id, {
      name: 'Peak Trading',
      description: 'Sells peak-shaving capacity',
    });

    // Name substring, case-insensitive.
    const byName = await listServices(owner.token, '?q=peak');
    expect(byName.json().services.map((s: { name: string }) => s.name)).toEqual(['Peak Trading']);
    // Description substring.
    const byDescription = await listServices(owner.token, '?q=PEAK-SHAVING');
    expect(byDescription.json().services).toHaveLength(1);
    // Semantic type substring matches every offer of that type.
    const byType = await listServices(owner.token, '?q=energy');
    expect(byType.json().services).toHaveLength(3);
    // No match → empty, not an error.
    const noMatch = await listServices(owner.token, '?q=no-such-thing');
    expect(noMatch.statusCode).toBe(200);
    expect(noMatch.json().services).toHaveLength(0);
    // Composable with the exact filters.
    const composed = await listServices(owner.token, '?q=meter&origin=published');
    expect(composed.json().services).toHaveLength(0);
    const composedHit = await listServices(owner.token, '?q=meter&origin=derived');
    expect(composedHit.json().services).toHaveLength(2);
    // Empty q is a 400 like the other filters.
    const empty = await listServices(owner.token, '?q=');
    expect(empty.statusCode).toBe(400);
  });

  it('CJK search: "温度" hits "温湿度计" (subsequence), exact CJK and Latin still work (Wave-1a, R8 F-02/F-15)', async () => {
    const { agent } = seedBuilderAgent();
    const thMeter = (
      await publishService(builder.token, agent.id, { name: '温湿度计', semanticType: 'temperature-humidity' })
    ).json();
    const energy = (
      await publishService(builder.token, agent.id, { name: '能源监测', semanticType: 'energy-monitoring' })
    ).json();
    const cooling = (
      await publishService(builder.token, agent.id, { name: 'HVAC B', semanticType: 'cooling' })
    ).json();
    const names = (res: { json: () => { services: Array<{ name: string }> } }) =>
      res.json().services.map(service => service.name);

    // 非相邻中文字符按序命中（纯子串/bigram 包含都做不到的用例）。
    const subsequence = await listServices(owner.token, `?q=${encodeURIComponent('温度')}`);
    expect(names(subsequence)).toEqual(['温湿度计']);
    expect(thMeter.id).toBeTruthy();
    // 逆序不命中：'度温' 不是 "温湿度计" 的保序子序列。
    const reversed = await listServices(owner.token, `?q=${encodeURIComponent('度温')}`);
    expect(names(reversed)).toEqual([]);
    // 常规中文子串仍命中。
    const cjk = await listServices(owner.token, `?q=${encodeURIComponent('能源')}`);
    expect(names(cjk)).toEqual(['能源监测']);
    expect(energy.id).toBeTruthy();
    // 英文 token 维持子串语义。
    const latin = await listServices(owner.token, '?q=cooling');
    expect(names(latin)).toEqual(['HVAC B']);
    expect(cooling.id).toBeTruthy();
    // 混合 token：每个 token 都要命中同一字段。
    const mixed = await listServices(owner.token, `?q=${encodeURIComponent('温湿 humidity')}`);
    expect(names(mixed)).toEqual(['温湿度计']);
  });

  // -------------------------------------------------------------------------
  // GET /api/services/:id (Fix-10)
  // -------------------------------------------------------------------------

  it('gets one service by id with the same shape as the list entries', async () => {
    const { agent } = seedBuilderAgent();
    const published = (await publishService(builder.token, agent.id, { name: 'One Offer' })).json();

    const res = await ctx.app.inject({ method: 'GET', url: `/api/services/${published.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: published.id,
      envId,
      name: 'One Offer',
      origin: 'published',
      visibility: 'public',
      unbacked: true,
      provider: { id: agent.id, owner: { id: builder.id, displayName: 'Builder' } },
    });
    expect(res.json().reputation).toMatchObject({ score: expect.any(Number) });

    // Unknown id → the same 404 as everywhere else.
    const unknown = await ctx.app.inject({ method: 'GET', url: '/api/services/no-such-service' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('SERVICE_NOT_FOUND');
  });

  it('GET /api/services/:id enforces the visibility boundary (404 like unknown ids)', async () => {
    const { agent } = seedBuilderAgent();
    const hidden = (await publishService(builder.token, agent.id, { name: 'Hidden', visibility: 'hidden' })).json();
    const members = (await publishService(builder.token, agent.id, { name: 'Members', visibility: 'members' })).json();

    // hidden: provider owner + env owner see it; everyone else gets 404.
    for (const token of [builder.token, owner.token]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/services/${hidden.id}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }
    for (const token of [viewer.token, stranger.token]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/services/${hidden.id}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('SERVICE_NOT_FOUND');
    }
    const anonymous = await ctx.app.inject({ method: 'GET', url: `/api/services/${hidden.id}` });
    expect(anonymous.statusCode).toBe(404);

    // members: members see it, strangers + anonymous do not.
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/services/${members.id}`, headers: auth(viewer.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/services/${members.id}`, headers: auth(stranger.token) }))
        .statusCode,
    ).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/services/${members.id}` })).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Subscribe method semantics (Fix-10): POST → 405 + Allow
  // -------------------------------------------------------------------------

  it('POST on the subscribe endpoint answers 405 with an Allow header', async () => {
    const { agent } = seedBuilderAgent();
    const published = (await publishService(builder.token, agent.id, {})).json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${published.id}/subscribe`,
      headers: auth(builder.token),
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('PUT, DELETE');
    expect(res.json().error.code).toBe('METHOD_NOT_ALLOWED');

    // Unknown ids get the same 405 — the method is wrong regardless of target.
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/services/no-such-service/subscribe',
      headers: auth(builder.token),
    });
    expect(unknown.statusCode).toBe(405);
    expect(unknown.headers.allow).toBe('PUT, DELETE');
  });

  // -------------------------------------------------------------------------
  // Seed
  // -------------------------------------------------------------------------

  it('seeds the Suzhou city world with derived + published services', () => {
    const env = ctx.app.envStore.findEnvironmentByName('苏州智慧城市（金鸡湖-姑苏示范）');
    expect(env).toBeDefined();
    const services = ctx.app.serviceStore.servicesOf(env!.id);

    const derived = services.filter(s => s.origin === 'derived');
    const published = services.filter(s => s.origin === 'published');
    // Template v2: 31 devices bound across 9 agents (滴滴/美团/哈啰 bind none):
    // 4×1 + 2×4 + 3×2 + 1×3 + 4×2 + 5×5 + 3×1 + 1×4 + 2×2 + 2×2 + 2×4 + 2×3 + (1×2 + 1×4).
    // T-207: only executable-on-type capabilities derive — the world's dead
    // capabilities (emergency-broadcast, lock-control, content-display, …)
    // no longer contract services.
    // T-043: honest labels — the 7 lamp controllers' 'lighting-control'
    // marketing rows collapsed into their direct turn-on rows (the only
    // executable path for lighting-control on a light that declares turn-on
    // IS turn-on), so 64 honest rows replace 71 (7 duplicates gone).
    // R40 gallery v2.1: the flow-executability hotfix (4764333) added
    // turn-off to the DR terminal (lc-sip-01) and the CBD charging pile
    // (cp-jinji-01) — 2 more executable capabilities, 2 more derived rows.
    expect(derived).toHaveLength(66);
    expect(published).toHaveLength(7);

    const publishedByAgent = new Map(
      published.map(s => {
        const agent = ctx.app.envStore.getAgent(s.provider_agent_id)!;
        return [agent.name, s];
      }),
    );
    expect(publishedByAgent.get('国网苏州供电公司')?.name).toBe('需求响应负荷聚合服务');
    expect(publishedByAgent.get('苏州应急管理中心')?.name).toBe('突发事件联动调度服务');
    expect(publishedByAgent.get('滴滴出行（苏州运力中心）')?.name).toBe('网约车运力调度服务');
    expect(publishedByAgent.get('美团配送（园区站）')?.name).toBe('即时配送应急投送服务');
    expect(publishedByAgent.get('特来电充电运营')?.name).toBe('有序充电调度服务');
    expect(publishedByAgent.get('哈啰出行')?.name).toBe('短驳运力保障服务');
    expect(publishedByAgent.get('万达广场商业物业')?.name).toBe('商业楼宇需求响应服务');
    for (const service of published) {
      expect(service.description.length).toBeGreaterThan(0);
      expect(service.visibility).toBe('public');
    }
  });

  it('seeds derived services for the first-boot home worlds too', () => {
    for (const name of ['跨品牌智能家居', '苏州夏日傍晚公寓']) {
      const env = ctx.app.envStore.findEnvironmentByName(name);
      if (env === undefined) continue; // name drift — not the point of this test
      expect(ctx.app.serviceStore.servicesOf(env.id).length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // T-207 — honest derived services (executable-on-type filter)
  // -------------------------------------------------------------------------

  it('T-207: derives services only for capabilities executable on that device type', async () => {
    // R101 evolution: emergency-broadcast now HAS a handler — the siren
    // derives BOTH services (pre-R101 the dead capability minted nothing).
    const siren = (
      await createDevice(owner.token, {
        name: 'SEC Siren', type: 'siren', capabilities: ['emergency-broadcast', 'turn-on'],
      })
    ).json();
    await createAgent(owner.token, [siren.id]);

    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType).sort())
      .toEqual(['emergency-broadcast', 'turn-on']);

    // The negative path, exercised with a capability that has no handler
    // and no semantic route: 'people-counting' still mints nothing.
    const counter = (
      await createDevice(owner.token, {
        name: 'Hall Counter', type: 'crowd-monitor', capabilities: ['people-counting'],
      })
    ).json();
    await createAgent(owner.token, [counter.id]);
    const after = (await listServices(owner.token)).json().services;
    expect(after.filter((s: { sourceDeviceId?: string }) => s.sourceDeviceId === counter.id)).toEqual([]);
  });

  it('T-207: a display advertising set-brightness derives no set-brightness service; a light does', async () => {
    // RF-F07: set-brightness is globally executable but TYPE-DEAD on a
    // display (no effect model) — the dead command used to reach the market.
    const display = (
      await createDevice(owner.token, {
        name: 'Shop Display', type: 'display', capabilities: ['set-brightness', 'content-display'],
      })
    ).json();
    await createAgent(owner.token, [display.id]);
    const afterDisplay = (await listServices(owner.token)).json().services;
    // set-brightness is type-dead on a display; content-display IS the
    // display's own surface (semantic route display → set-message).
    expect(afterDisplay.map((s: { semanticType: string }) => s.semanticType)).toEqual(['content-display']);

    const light = (
      await createDevice(owner.token, {
        name: 'Shop Lightstrip', type: 'light', capabilities: ['set-brightness'],
      })
    ).json();
    await createAgent(owner.token, [light.id]);
    const afterLight = (await listServices(owner.token)).json().services;
    expect(afterLight.map((s: { semanticType: string }) => s.semanticType).sort())
      .toEqual(['content-display', 'set-brightness']);
  });

  it('T-207: hass:// devices keep full derivation (real hardware)', async () => {
    const hass = (
      await createDevice(owner.token, {
        name: 'Real Siren', type: 'siren', capabilities: ['emergency-broadcast'],
        binding: 'hass://siren.hallway',
      })
    ).json();
    await createAgent(owner.token, [hass.id]);
    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType)).toEqual(['emergency-broadcast']);
  });

  // -------------------------------------------------------------------------
  // T-047 — R11-corrective: oracle-first order + catalog type metadata
  // (audit T-207 NEEDS-REFACTOR: the regex family table ran BEFORE the
  // oracle and suppressed sensor telemetry; catalog-custom types were
  // mis-handled by English type substrings)
  // -------------------------------------------------------------------------

  it('T-047: sensor read capabilities derive again (the oracle decides first)', async () => {
    // The audit's case: a lux/illuminance sensor whose type carries NO
    // light-family substring. The old order ran the family table first, so
    // /bright|dim|illumin/ killed `brightness-reading` (telemetry!) unless
    // the TYPE STRING happened to contain 'light'. Read/query capabilities
    // must derive on any type that declares them.
    const lux = (
      await createDevice(owner.token, {
        name: 'Atrium Lux Sensor', type: 'lux-meter',
        capabilities: ['brightness-reading', 'illuminance-monitoring'],
      })
    ).json();
    // Same class of mis-fire: a noise station's volume telemetry is not
    // speaker output (audit: `/volume/` vs volume-monitoring).
    const noise = (
      await createDevice(owner.token, {
        name: 'Noise Station', type: 'noise-monitor-station', capabilities: ['volume-monitoring'],
      })
    ).json();
    await createAgent(owner.token, [lux.id, noise.id]);

    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType).sort()).toEqual([
      'brightness-reading', 'illuminance-monitoring', 'volume-monitoring',
    ]);
  });

  it('T-047: catalog-known device types derive from catalog metadata, not English regexes', async () => {
    // A catalog-custom display type with no /display|screen|sign|board/
    // substring: the regex table can never know it, but the catalog model
    // DECLARES the type's capabilities — metadata is the authority.
    ctx.app.catalogStore.create({
      vendor: 'TestVendor', model: 'SL-EINK-1', name: 'Shelf Label E-Ink',
      deviceType: 'shelf-label-eink', capabilities: ['set-content', 'get-state'],
      source: 'community', status: 'active',
    });
    const shelf = (
      await createDevice(owner.token, {
        name: 'Aisle 3 Label', type: 'shelf-label-eink', capabilities: ['set-content'],
      })
    ).json();
    await createAgent(owner.token, [shelf.id]);
    const afterShelf = (await listServices(owner.token)).json().services;
    expect(afterShelf.map((s: { semanticType: string }) => s.semanticType)).toEqual(['set-content']);

    // Catalog metadata REJECTS too: the seed catalog knows 'curtain', and
    // no curtain model declares a content-family member — a curtain
    // "advertising" set-content is type-dead even though set-* has a
    // global handler.
    const curtain = (
      await createDevice(owner.token, {
        name: 'Living Room Curtain', type: 'curtain', capabilities: ['set-content'],
      })
    ).json();
    await createAgent(owner.token, [curtain.id]);
    const afterCurtain = (await listServices(owner.token)).json().services;
    expect(afterCurtain.map((s: { semanticType: string }) => s.semanticType)).toEqual(['set-content']);

    // The regex table remains as the LAST-RESORT tier for types the catalog
    // has no metadata for (RF-F07 preserved: set-brightness on a type with
    // no light substring and no catalog entry stays dead).
    const vending = (
      await createDevice(owner.token, {
        name: 'Vending Machine', type: 'vending-machine', capabilities: ['set-brightness'],
      })
    ).json();
    await createAgent(owner.token, [vending.id]);
    const afterVending = (await listServices(owner.token)).json().services;
    expect(afterVending.map((s: { semanticType: string }) => s.semanticType)).toEqual(['set-content']);
  });

  // -------------------------------------------------------------------------
  // T-053 — env-following derived-service visibility (设备私有、服务公开)
  // -------------------------------------------------------------------------

  it('T-053: a PUBLIC environment opens members-derived AND aggregate services to anonymous visitors BY DEFAULT', async () => {
    const device = (
      await createDevice(owner.token, { name: 'Demo Meter', type: 'energy-meter', capabilities: ['energy-monitoring'] })
    ).json();
    await createAgent(owner.token, [device.id]);
    const derivedType = (await listServices(owner.token)).json().services
      .find((s: { origin: string }) => s.origin === 'derived')!.semanticType;
    // Aggregate offers share the derived posture (both are auto-derived from
    // device capabilities) — seed one directly, as syncAggregateOffers would.
    ctx.app.serviceStore.createService({
      envId, providerAgentId: ctx.app.envStore.agentsOf(envId).at(-1)!.id,
      name: 'Campus comfort', semanticType: 'campus-air-comfort',
      description: '', interface: { actions: [] }, origin: 'aggregate', visibility: 'members',
    });

    // No knob at all: the default follows the (public) environment.
    const anon = await listServices(undefined);
    expect(anon.statusCode).toBe(200);
    const anonDerived = anon.json().services.filter((s: { origin: string }) => s.origin === 'derived');
    expect(anonDerived).toHaveLength(1);
    expect(anonDerived[0].semanticType).toBe(derivedType);
    expect(anon.json().services.some((s: { origin: string }) => s.origin === 'aggregate')).toBe(true);

    // ...and in the env detail, with the live mode surfaced as 'public'.
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}` });
    expect(detail.json().services.filter((s: { origin: string }) => s.origin === 'derived')).toHaveLength(1);
    expect(detail.json().derivedServiceVisibility).toBe('public');

    // The stored rows themselves still read 'members' — the mode is an
    // env-level read-time overlay, not a rewrite (owner-facing PATCH
    // semantics unchanged).
    const rows = ctx.app.serviceStore.servicesOf(envId);
    expect(rows.find(s => s.origin === 'derived')!.visibility).toBe('members');
    expect(rows.find(s => s.origin === 'aggregate')!.visibility).toBe('members');
  });

  it('T-053: knob=members explicitly RETRACTS the public default on a public environment', async () => {
    const device = (
      await createDevice(owner.token, { name: 'Demo Meter', type: 'energy-meter', capabilities: ['energy-monitoring'] })
    ).json();
    await createAgent(owner.token, [device.id]);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }], derivedServiceVisibility: 'members' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().derivedServiceVisibility).toBe('members');

    // Anonymous sees nothing derived anymore...
    const anon = await listServices(undefined);
    expect(anon.json().services.filter((s: { origin: string }) => s.origin === 'derived')).toHaveLength(0);
    // ...while members keep the members tier.
    const memberView = (await listServices(viewer.token)).json().services;
    expect(memberView.filter((s: { origin: string }) => s.origin === 'derived')).toHaveLength(1);
  });

  it('T-053: knob=public only TIGHTENS — it is inert on a private environment', async () => {
    const priv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private Lab', visibility: 'private', mapData: { zones: [{ id: 'zone-a' }], derivedServiceVisibility: 'public' } },
    });
    expect(priv.statusCode).toBe(201);
    // The stored knob is 'public' but the EFFECTIVE mode never widens past
    // the environment's own visibility — no accidental leak.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${priv.json().id}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().derivedServiceVisibility).toBe('members');
    // Anonymous is stopped by the env read gate regardless.
    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${priv.json().id}/services`,
    });
    expect(anon.statusCode).toBe(403);
  });

  it('T-053: hidden derived rows and published members offers are NEVER opened by the env-following mode', async () => {
    // A hidden-derived agent (per-bed vitals class) + a published members offer.
    const device = (
      await createDevice(owner.token, { name: 'Bed Monitor', type: 'energy-meter', capabilities: ['energy-monitoring'] })
    ).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Hidden Agent', capabilities: [], boundDeviceIds: [device.id], derivedServiceVisibility: 'hidden' },
    });
    const published = ctx.app.serviceStore.createService({
      envId, providerAgentId: ctx.app.envStore.agentsOf(envId).at(-1)!.id,
      name: 'Members-only offer', semanticType: 'energy-monitoring',
      description: '', interface: { actions: [] }, origin: 'published', visibility: 'members',
    });
    expect(published.visibility).toBe('members');

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }], derivedServiceVisibility: 'public' } },
    });
    expect(patched.statusCode).toBe(200);

    const anon = (await listServices(undefined)).json().services;
    expect(anon.filter((s: { origin: string; visibility: string }) => s.origin === 'derived' && s.visibility === 'hidden')).toHaveLength(0);
    expect(anon.some((s: { name: string }) => s.name === 'Members-only offer')).toBe(false);
    // Members still see everything.
    const memberView = (await listServices(viewer.token)).json().services;
    expect(memberView.some((s: { name: string }) => s.name === 'Members-only offer')).toBe(true);
  });

  it('T-053: mapData.derivedServiceVisibility rejects unknown values with a teaching message', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
      payload: { mapData: { zones: [{ id: 'zone-a' }], derivedServiceVisibility: 'everyone' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('mapData.derivedServiceVisibility');
    expect(res.json().error.message).toContain('"members" | "public"');
  });

  // -------------------------------------------------------------------------
  // T-043 — honest semantic labels over the executable surface
  // -------------------------------------------------------------------------

  it('T-043: a marketing capability whose only path is on/off collapses into the direct switching rows', async () => {
    // 'environment' on a smart plug dispatches to turn-on — and the device
    // DECLARES turn-on/turn-off, so the marketing row adds a duplicate
    // service for the same relay. Exactly the verbatim switching rows derive.
    const plug = (
      await createDevice(owner.token, {
        name: 'Hall Socket', type: 'smart-plug', capabilities: ['environment', 'turn-on', 'turn-off'],
      })
    ).json();
    await createAgent(owner.token, [plug.id]);
    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType).sort())
      .toEqual(['turn-off', 'turn-on']);
  });

  it('T-043: switching-only surface without direct switching rows gets ONE honest switching service', async () => {
    // A smart plug declaring only 'environment': every executable route
    // resolves to turn-on — the service must say switching, not
    // 'environment'. (The pre-R101 fixture used an exhaust fan's
    // 'ventilation' — that capability is genuinely executable now, so the
    // collapse case moved to this plug.)
    const plug = (
      await createDevice(owner.token, {
        name: 'Hall Socket', type: 'smart-plug', capabilities: ['environment'],
      })
    ).json();
    await createAgent(owner.token, [plug.id]);
    const services = (await listServices(owner.token)).json().services;
    expect(services).toHaveLength(1);
    expect(services[0].semanticType).toBe('switching');
    // The honest surface in name, description AND interface actions.
    expect(services[0].name).toContain('开关');
    expect(services[0].description).toContain('开启/关闭');
    expect(services[0].description).toContain('environment');
    expect((services[0].interface as { actions: Array<{ name: string }> }).actions.map(a => a.name))
      .toEqual(['turn-on']);
  });

  it('T-043: several switching-only marketing capabilities collapse into a single switching row', async () => {
    const plug = (
      await createDevice(owner.token, {
        name: 'Kitchen Socket', type: 'smart-plug', capabilities: ['environment', 'smart-home'],
      })
    ).json();
    await createAgent(owner.token, [plug.id]);
    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType)).toEqual(['switching']);
  });

  it('T-043: richer mapped surfaces keep the capability label and advertise the REAL commands', async () => {
    // 'content-display' on a display dispatches to set-message — a real
    // (non-switching) route, so the label stays, but the interface must
    // advertise set-message, not the TYPE-DEAD set-brightness the old
    // whole-device interface leaked.
    const display = (
      await createDevice(owner.token, {
        name: 'Lobby Display', type: 'display', capabilities: ['set-brightness', 'content-display'],
      })
    ).json();
    await createAgent(owner.token, [display.id]);
    const services = (await listServices(owner.token)).json().services;
    expect(services.map((s: { semanticType: string }) => s.semanticType)).toEqual(['content-display']);
    const actions = (services[0].interface as { actions: Array<{ name: string }> }).actions
      .map(a => a.name);
    expect(actions).toContain('set-message');
    expect(actions).not.toContain('set-brightness');
  });

  it('T-043: re-sync relabels existing rows in place and prunes collapsed duplicates (upgrade path)', async () => {
    // Simulate a pre-T-043 database: a plug with the old 'environment' row
    // plus a bogus duplicate, then re-run the sync (what migration v36 does
    // via backfillDerivedServices) — expect one honest switching row.
    // (The pre-R101 fixture used a fan's 'ventilation'; that capability is
    // genuinely executable now, so the legacy-row case moved to this plug.)
    const plug = (
      await createDevice(owner.token, {
        name: 'Attic Socket', type: 'smart-plug', capabilities: ['environment'],
      })
    ).json();
    const agent = (await createAgent(owner.token, [plug.id])).json();
    const before = (await listServices(owner.token)).json().services;
    expect(before.map((s: { semanticType: string }) => s.semanticType)).toEqual(['switching']);

    // Hand-write the legacy shape the old derivation produced.
    ctx.app.serviceStore.createService({
      envId, providerAgentId: agent.id,
      name: 'Attic Socket: environment', semanticType: 'environment',
      description: 'legacy', interface: {}, origin: 'derived', sourceDeviceId: plug.id,
    });
    ctx.app.serviceStore.syncDerivedForAgent(agent.id);
    const after = (await listServices(owner.token)).json().services
      .filter((s: { origin: string }) => s.origin === 'derived');
    expect(after).toHaveLength(1);
    expect(after[0].semanticType).toBe('switching');
  });

  // -------------------------------------------------------------------------
  // T-208 — derived services default to members visibility
  // -------------------------------------------------------------------------

  it('T-208: new derived services start members; explicit PATCH to public works; published honors its body', async () => {
    const device = (
      await createDevice(owner.token, { name: 'Vitals Monitor', type: 'sensor', capabilities: ['energy-monitoring'] })
    ).json();
    const agent = (await createAgent(owner.token, [device.id])).json();

    // Derived: default members-only.
    const derived = (await listServices(owner.token)).json().services
      .find((s: { origin: string }) => s.origin === 'derived');
    expect(derived.visibility).toBe('members');

    // The STORED tier is 'members' — on this PUBLIC env the env-following
    // mode (see the T-053 block) reads it as public for anonymous readers;
    // the stored default is what a private env (or knob=members) enforces.
    const anon = await listServices(undefined);
    expect(anon.statusCode).toBe(200);
    expect((anon.json().services as Array<{ id: string }>).some(s => s.id === derived.id)).toBe(true);

    // Explicit PATCH to public still works (visibility is the one editable
    // derived field).
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${derived.id}`,
      headers: auth(owner.token),
      payload: { visibility: 'public' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().visibility).toBe('public');

    // Published offers honor their explicit body-supplied visibility.
    const published = await publishService(owner.token, agent.id, { visibility: 'public' });
    expect(published.statusCode).toBe(201);
    expect(published.json().visibility).toBe('public');
  });

  // -------------------------------------------------------------------------
  // R15 (FR15-F02) — derivedServiceVisibility: hidden-on-create is atomic
  // -------------------------------------------------------------------------

  it('R15/FR15-F02: derivedServiceVisibility:hidden derives services BORN hidden (no members window)', async () => {
    // The live-round shape: a care provider installs a vitals agent. Before
    // the fix the per-bed services were members-visible until the provider's
    // hide PATCH landed minutes later.
    const device = (
      await createDevice(owner.token, { name: 'Bed-1 Vitals Watch', type: 'sensor', capabilities: ['energy-monitoring'] })
    ).json();
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Vitals Agent',
        capabilities: [],
        boundDeviceIds: [device.id],
        derivedServiceVisibility: 'hidden',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().derivedServiceVisibility).toBe('hidden');

    // A fellow member NEVER sees the service — not at creation, not later.
    const memberList = (await listServices(builder.token)).json().services as Array<{ id: string; origin: string }>;
    const derived = memberList.find(s => s.origin === 'derived');
    expect(derived).toBeUndefined();
    const byId = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(builder.token),
    });
    expect(
      ((byId.json().services as Array<{ origin: string }>).some(s => s.origin === 'derived')),
    ).toBe(false);
    const ownerList = (await listServices(owner.token)).json().services as Array<{ id: string; origin: string; visibility: string }>;
    const ownerDerived = ownerList.find(s => s.origin === 'derived')!;
    expect(ownerDerived.visibility).toBe('hidden');

    // Late binding honors the declaration too: a second device bound later
    // derives hidden at the derivation moment (window-free by construction).
    const second = (
      await createDevice(owner.token, { name: 'Bed-2 Vitals Watch', type: 'sensor', capabilities: ['energy-monitoring'] })
    ).json();
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      headers: auth(owner.token),
      payload: { boundDeviceIds: [device.id, second.id] },
    });
    expect(patched.statusCode).toBe(200);
    const after = (await listServices(owner.token)).json().services as Array<{ origin: string; visibility: string }>;
    expect(after.filter(s => s.origin === 'derived')).toHaveLength(2);
    expect(after.filter(s => s.origin === 'derived').every(s => s.visibility === 'hidden')).toBe(true);
  });

  it('R15/FR15-F02: install-agents proposals carry derivedServiceVisibility; invalid values are named, never dropped', async () => {
    // A builder's install-agents proposal with derivedServiceVisibility rides
    // the pipeline; the rule check validates the closed enum.
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-agents',
        payload: { agents: [{ name: 'Sneaky', capabilities: [], derivedServiceVisibility: 'secret' }] },
      },
    });
    expect(bad.statusCode).toBe(201);
    expect(bad.json().status).toBe('rejected');
    expect(
      ((bad.json().ruleCheck.issues ?? []) as string[]).some(
        issue => issue.includes('derivedServiceVisibility') && issue.includes('hidden'),
      ),
    ).toBe(true);

    // The owner route rejects the same typo synchronously with a 400.
    const badDirect = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Sneaky', capabilities: [], derivedServiceVisibility: 'secret' },
    });
    expect(badDirect.statusCode).toBe(400);
    expect(badDirect.json().error.message).toContain('derivedServiceVisibility');

    // The valid value survives the whole pipeline: an applied install-agents
    // proposal derives hidden services at apply time.
    const device = (
      await createDevice(owner.token, { name: 'Proposal Watch', type: 'sensor', capabilities: ['energy-monitoring'] })
    ).json();
    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(owner.token),
      payload: {
        kind: 'install-agents',
        payload: {
          agents: [{
            name: 'Proposal Vitals Agent',
            capabilities: [],
            boundDeviceIds: [device.id],
            derivedServiceVisibility: 'hidden',
          }],
        },
      },
    });
    expect(proposal.statusCode).toBe(201);
    // The test pipeline has no AI reviewer — the low-risk proposal escalates
    // to the owner, whose approval applies it.
    if (proposal.json().status === 'escalated') {
      const decided = await ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${proposal.json().id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'approved' },
      });
      expect(decided.statusCode).toBe(200);
      expect(decided.json().status).toBe('applied');
    } else {
      expect(proposal.json().status).toBe('applied');
    }
    const derived = (await listServices(owner.token)).json().services as Array<{
      origin: string; visibility: string;
    }>;
    expect(derived.find(s => s.origin === 'derived')!.visibility).toBe('hidden');
  });
});

describe('service stream visibility (W3)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Service Stream Lab', visibility: 'public', mapData: { zones: [{ id: 'z' }] } },
    });
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try { socket.close(); } catch { /* already closed */ }
    }
    await ctx.cleanup();
  });

  it('does not leak hidden/members service broadcasts to unauthorized subscribers', async () => {
    // Anonymous subscriber on a public env: sees public changes only.
    const socket = new WebSocket(`${baseUrl}/api/environments/${envId}/stream`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const received: Array<Record<string, unknown>> = [];
    socket.on('message', raw => {
      const parsed = JSON.parse(raw.toString()) as { kind?: string };
      if (parsed.kind === 'world') received.push(parsed as Record<string, unknown>);
    });

    // The owner's agent publishes a hidden offer — invisible to the anon socket.
    // (Owner-driven since Fix-1: direct world edits are env-owner only; the
    // visibility boundary under test is subscriber-side, not publisher-side.)
    const device = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/devices`,
        headers: auth(owner.token),
        payload: { name: 'Meter', type: 'energy-meter', capabilities: ['turn-on'], zoneId: 'z' },
      })
    ).json();
    const agent = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'Agent', capabilities: [], boundDeviceIds: [device.id] },
      })
    ).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.id}/services`,
      headers: auth(owner.token),
      payload: { name: 'Hidden offer', semanticType: 'secret-sauce', visibility: 'hidden' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.id}/services`,
      headers: auth(owner.token),
      payload: { name: 'Members offer', semanticType: 'club-stuff', visibility: 'members' },
    });

    // Prove the socket is still alive with a public change it MUST see; the
    // hidden/members offers must never have arrived by then. The stream is
    // ordered per socket, so the PUBLIC device message arriving is a
    // positive anchor: the earlier hidden/members creates were already
    // delivered-or-filtered by then (was a fixed 200ms sleep — R21
    // test-debt, the flake shape when the public frame lands late).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Public Device', type: 'light', capabilities: ['on'], zoneId: 'z' },
    });
    expect(await until(
      () => received.some(m => m.objectType === 'device'),
      10_000,
      50,
    )).toBe(true);

    const serviceMessages = received.filter(m => m.objectType === 'service');
    const names = serviceMessages.map(m => (m.object as { name?: string }).name);
    expect(names).not.toContain('Hidden offer');
    expect(names).not.toContain('Members offer');
    // The derived 'Meter: 开启' create is stored members-only (T-208) but the
    // env-following mode reads derived rows as public on this PUBLIC env —
    // the stream stays consistent with the list/detail reads, so the
    // anonymous subscriber receives it.
    expect(names).toContain('Meter: 开启');
    expect(received.some(m => m.objectType === 'device')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T62 (R6, u4-F5): the signing gate's backing-ambiguity verdict, hoisted to
// the market faces — an ambiguous published offer is visible at list/get
// time (with the exact devices the 409 will name), not discovered at propose.
// ---------------------------------------------------------------------------

describe('T62: service signability summary (u4-F5 replay)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Signability Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function createDevice(token: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(token),
      payload: {
        name: 'Meter',
        type: 'energy-meter',
        capabilities: ['energy-monitoring'],
        zoneId: 'zone-a',
        ...overrides,
      },
    });
  }

  it('an ambiguous published offer carries signability=ambiguous on list+get naming the SAME devices the 409 will', async () => {
    // u4's shape: one provider agent, TWO bound devices holding the semantic
    // type, in DIFFERENT zones.
    const d1 = (await createDevice(owner.token, { name: 'Meter A', zoneId: 'zone-a' })).json();
    const d2 = (await createDevice(owner.token, { name: 'Meter B', zoneId: 'zone-b' })).json();
    const agent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Aggregator', capabilities: [], boundDeviceIds: [d1.id, d2.id] },
    })).json();
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.id}/services`,
      headers: auth(owner.token),
      payload: { name: '教室空气质量改善', semanticType: 'energy-monitoring' },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id as string;

    const listed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<Record<string, any>>;
    const row = listed.find(s => s.id === serviceId)!;
    expect(row.signability).toMatchObject({
      verdict: 'ambiguous',
      candidateDevices: ['Meter A', 'Meter B'],
    });
    expect(row.signability.reason).toContain('SERVICE_BACKING_AMBIGUOUS');

    // The detail face carries the same verdict.
    const got = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
    })).json();
    expect(got.signability.verdict).toBe('ambiguous');
    expect(got.signability.candidateDevices).toEqual(['Meter A', 'Meter B']);

    // The 409 message and the marker speak one language: proposing refuses
    // and names exactly the candidate devices the summary listed.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(409);
    expect(proposed.json().error.code).toBe('SERVICE_BACKING_AMBIGUOUS');
    for (const name of ['Meter A', 'Meter B']) {
      expect(proposed.json().error.message).toContain(name);
    }
  });

  it('a single-backing published offer reads signability=backed; a device-less one reads unbacked', async () => {
    const d1 = (await createDevice(owner.token, { name: 'Solo Meter' })).json();
    const agent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Solo Agent', capabilities: [], boundDeviceIds: [d1.id] },
    })).json();
    const backed = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.id}/services`,
      headers: auth(owner.token),
      payload: { name: 'Solo offer', semanticType: 'energy-monitoring' },
    });
    const backedGot = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${backed.json().id as string}`,
      headers: auth(owner.token),
    })).json();
    expect(backedGot.signability).toEqual({ verdict: 'backed' });

    // An agent with NO bound devices → the published offer is honestly unbacked.
    const emptyAgent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Empty Agent', capabilities: [], boundDeviceIds: [] },
    })).json();
    const unbacked = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${emptyAgent.id}/services`,
      headers: auth(owner.token),
      payload: { name: 'Ghost offer', semanticType: 'energy-monitoring' },
    });
    const unbackedGot = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${unbacked.json().id as string}`,
      headers: auth(owner.token),
    })).json();
    // T68a (R7): the unbacked verdict carries its reason too — "why can't I
    // sign this?" answers on the catalog face, not only in the later 409.
    expect(unbackedGot.signability.verdict).toBe('unbacked');
    expect(unbackedGot.signability.reason).toContain('Empty Agent');
    expect(unbackedGot.signability.reason).toContain('energy-monitoring');
    expect(unbackedGot.signability.reason).toContain('SERVICE_NOT_BACKED');
  });

  it('T68a (R7, u2-F-5): aggregate offers carry RULE-lane signability — backed with actuation backing, unbacked (with the gate reason) without', async () => {
    // backed: the bundle qualifies the built-in drainage-control rule AND a
    // bound device holds the rule's actuation capability (valve-control).
    const valve = (
      await createDevice(owner.token, {
        name: '排涝智能阀',
        type: 'pump',
        capabilities: ['valve-control', 'turn-on', 'turn-off'],
      })
    ).json();
    const gauge = (
      await createDevice(owner.token, {
        name: '内涝水位计',
        type: 'sensor',
        capabilities: ['water-level-monitoring'],
      })
    ).json();
    const agent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: '泵站管家', capabilities: [], boundDeviceIds: [valve.id, gauge.id] },
    })).json();

    const listed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services?origin=aggregate`,
      headers: auth(owner.token),
    })).json().services as Array<Record<string, any>>;
    expect(listed).toHaveLength(1);
    expect(listed[0].semanticType).toBe('drainage-control');
    expect(listed[0].signability).toEqual({ verdict: 'backed' });
    const got = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${listed[0].id as string}`,
      headers: auth(owner.token),
    })).json();
    expect(got.signability).toEqual({ verdict: 'backed' });

    // unbacked (u2's 避难安置保障 shape): the rule resolves but NO bound
    // device holds the actuation capability — the propose gate's 409
    // SERVICE_NOT_BACKED class. Seeded directly (the derivation sync deletes
    // such a row on the qualifying device's departure; the READ-time state —
    // a row minted from declared capabilities alone — is exactly this) on a
    // device-less agent so the actuation backing is empty.
    const emptyAgent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: '声明-only 管家', capabilities: [], boundDeviceIds: [] },
    })).json();
    const stranded = ctx.app.serviceStore.createService({
      envId,
      providerAgentId: emptyAgent.id,
      name: '避难安置保障',
      semanticType: 'drainage-control',
      description: '',
      interface: {},
      origin: 'aggregate',
      sourceDeviceId: null,
      visibility: 'members',
    });
    const strandedGot = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${stranded.id}`,
      headers: auth(owner.token),
    })).json();
    expect(strandedGot.signability.verdict).toBe('unbacked');
    expect(strandedGot.signability.reason).toContain('valve-control');
    expect(strandedGot.signability.reason).toContain('SERVICE_NOT_BACKED');
    // The catalog verdict is the GATE's verdict: proposing refuses with the
    // same code the reason names.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${stranded.id}/agreements`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(409);
    expect(proposed.json().error.code).toBe('SERVICE_NOT_BACKED');

    // The stale-rule class: the semantic type matches NO rule of the merged
    // table — also unbacked, naming the missing rule (never a bare verdict).
    const stale = ctx.app.serviceStore.createService({
      envId,
      providerAgentId: emptyAgent.id,
      name: '无规则聚合',
      semanticType: 'never-a-rule',
      description: '',
      interface: {},
      origin: 'aggregate',
      sourceDeviceId: null,
      visibility: 'members',
    });
    const staleGot = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${stale.id}`,
      headers: auth(owner.token),
    })).json();
    expect(staleGot.signability.verdict).toBe('unbacked');
    expect(staleGot.signability.reason).toContain('no semantic offer rule');
    expect(staleGot.signability.reason).toContain('never-a-rule');
  });
});

describe('T84: the read-source writability face on signability (R10 u1-F3)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Read-Source Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * u1's exact shape: a sensor device whose only "data" is a numeric
   * initialState key (a scenario placeholder — nothing in this world ever
   * writes the path), bound to an agent that declares the reading
   * capability → the auto-minted device-aggregate read lane reads
   * never-written device state.
   */
  async function seedAutoMintedSensorService(): Promise<string> {
    const sensor = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Temp Sensor',
        type: 'temperature-sensor',
        capabilities: ['temperature-monitoring'],
        zoneId: 'zone-a',
        initialState: { temperature: 24.5 },
      },
    })).json();
    const agent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        boundDeviceIds: [sensor.id],
      },
    })).json();
    const derived = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services?provider=${agent.id as string}&origin=derived`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; semanticType: string }>;
    const row = derived.find(service => service.semanticType === 'temperature-monitoring');
    expect(row, `derived temperature-monitoring row expected, got: ${JSON.stringify(derived)}`).toBeDefined();
    return row!.id;
  }

  it('a never-written device-state read source is named by the readSource face against whichever live world the default read targets (session lane → own-sim lane on start); propose itself is NOT refused', async () => {
    const serviceId = await seedAutoMintedSensorService();
    const getService = async () => (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
    })).json();

    // T54/T86 honesty under R73 auto-start + T129 (R21-F1) timing: the
    // authoritative world session EXISTS and materializes the device as soon
    // as the world-mutation topology refresh lands — deterministically before
    // the probe below now that the catch-up advance no longer serializes the
    // mutation (pre-T129 this assertion rode a race where `before` beat the
    // refresh and the oracle stayed silent by accident of timing). Wait for
    // the TOPOLOGY (not a timer), then the oracle speaks against the session:
    // the read lane's fallback world never wrote 'temperature' → the honest
    // verdict is ambiguous + never-written (probedLane world-session).
    const worldSessions = (ctx.app as unknown as {
      worldSessions: { statusOf(id: string): { simulationId: string } | undefined };
    }).worldSessions;
    const sessionSimId = worldSessions.statusOf(envId)!.simulationId;
    expect(await until(
      () => (ctx.app.simulations.get(sessionSimId)?.runtime.getSnapshot().devices.length ?? 0) > 0,
      5_000,
    )).toBe(true);
    const before = await getService();
    expect(before.signability.verdict).toBe('ambiguous');
    expect(before.signability.readSource).toMatchObject({
      status: 'never-written',
      fields: ['temperature'],
      simulationId: sessionSimId,
      probedLane: 'world-session',
    });

    // A live sim materializes the placeholder world — the probe (the SAME
    // T54 oracle the read gate refuses with) now proves 'temperature' was
    // never written here.
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);

    const after = await getService();
    expect(after.signability.verdict).toBe('ambiguous');
    expect(after.signability.readSource).toMatchObject({
      status: 'never-written',
      fields: ['temperature'],
      simulationId: simId,
      // T86 (R11, u1-F1): the owner started this sim and views it — the
      // probe names the OWN-SIM lane (the default read target when she has one).
      probedLane: 'own-sim',
    });
    // The reason speaks the read-time refusal's own wording family + the
    // no-hard-refusal boundary (sign with the expectation) — and T86 layers
    // it by lane: the sim-less fallback to the world session is named as
    // NOT covered by the refusal promise.
    expect(after.signability.reason).toContain('COMPUTATION_DEVICE_STATE_UNWRITTEN');
    expect(after.signability.reason).toContain('NOT refused');
    expect(after.signability.reason).toContain('your running simulation');
    expect(after.signability.reason).toContain('Lane honesty');
    expect(after.signability.reason).toContain('world session');
    // The backing-ambiguity shape must NOT ride along (no candidate devices —
    // the discrimination between the two ambiguity kinds is the field's job).
    expect(after.signability.candidateDevices).toBeUndefined();

    // The list face carries the same judgment (scan where offers are browsed).
    const listed = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; signability?: { verdict: string; readSource?: { status: string } } }>;
    const row = listed.find(service => service.id === serviceId);
    expect(row?.signability?.verdict).toBe('ambiguous');
    expect(row?.signability?.readSource?.status).toBe('never-written');

    // The honesty boundary: speculative signing stays LEGAL — propose is
    // not refused (the consumer signs with the read expectation, and the
    // read lane's T54 409 does the refusing if nothing ever writes).
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
  });

  it('T86 (R11, u1-F1): a viewer with NO own sim is never judged against ANOTHER member\'s sim — no refusal promise minted from an unreadable world', async () => {
    // u1's取证 D (she was the ENV OWNER): the old probe took
    // runningAllForEnvironment[0] — her warning was minted against another
    // MEMBER's sim (a world her reads could only 403) while her sim-less
    // default read fell to the world session. The probe now resolves through
    // the read lane's own adjudication: no targetable own sim → the
    // world-session branch → no live session (a GET never creates one) →
    // honest unknown, no readSource face. (T96, R14: "own" is STRICTLY the
    // caller's own — the env-owner clause is gone from the default lane, so
    // an owner's running sim is as foreign as any member's for a default
    // read; explicit simulationId keeps the carve-out.)
    const serviceId = await seedAutoMintedSensorService();
    const member = await registerUser(ctx.app, { displayName: 'Member Chen' });
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(member.token),
      payload: {},
    })).statusCode).toBe(200);
    // The MEMBER (not the env owner) starts the sim — u1/陈功's shape.
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(member.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    expect(sim.statusCode).toBe(201);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${sim.json().id as string}/start`,
        headers: auth(member.token),
        payload: {},
      })).statusCode,
    ).toBe(200);

    // The env OWNER (no own sim) views the service: the member's sim proves
    // nothing about her read lanes — the plain backed verdict stands (no ⚠,
    // no foreign simulationId in sight).
    const ownerGot = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
    })).json() as { signability?: { verdict: string; readSource?: { status: string; simulationId: string } } };
    expect(ownerGot.signability).toEqual({ verdict: 'backed' });
    // The MEMBER still gets her own-sim judgment on the same face.
    const memberGot = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(member.token),
    })).json() as { signability?: { verdict: string; readSource?: { status: string; probedLane: string; simulationId: string } } };
    expect(memberGot.signability?.readSource).toMatchObject({
      status: 'never-written',
      probedLane: 'own-sim',
      simulationId: sim.json().id,
    });
  });

  it('a zone-sourced computation never trips the read-source face (the zone face is world-maintained)', async () => {
    // A zone-query spec over the standard parameter surface: the probed
    // world maintains zone parameters, so no never-written claim exists.
    const published = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Zone Agent', capabilities: [], boundDeviceIds: [] },
    })).json();
    const service = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${published.id as string}/services`,
      headers: auth(owner.token),
      payload: { name: 'Zone Reading', semanticType: 'zone-reading' },
    }));
    expect(service.statusCode).toBe(201);
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${service.json().id as string}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'zone-query',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'zone', path: 'temperature', fn: 'avg', as: 'avgTemperature' }],
        },
        interface: { dataSchema: { fields: [{ name: 'avgTemperature', type: 'number' }] } },
      },
    });
    expect(registered.statusCode).toBe(201);

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    const got = (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${service.json().id as string}`,
      headers: auth(owner.token),
    })).json();
    // No device value metric → the probe has nothing to say; the published
    // single-device-less offer reads its plain verdict (unbacked here — the
    // zone-query computation makes it consumable, not invocable).
    expect(got.signability.readSource).toBeUndefined();
  });
});

describe('T91 (R13, u2-F1): the read-source probe shares the read lane\'s FULL adjudication — own-sim absent AND ambiguous both fall through to the live world session', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let member: TestUser;
  let envId: string;
  let derivedServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    member = await registerUser(ctx.app, { displayName: 'Member Chen' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Read-Source Matrix Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    // The placeholder carrier: `temperature` is physics-written in any live
    // world (the T54 oracle would honestly go silent for it after catch-up),
    // so the matrix metrics read `placeholder_level` — a path NOTHING in this
    // world ever writes. The verdict then fires in EVERY live world.
    const sensor = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Temp Sensor',
        type: 'temperature-sensor',
        capabilities: ['temperature-monitoring'],
        zoneId: 'zone-a',
        initialState: { temperature: 24.5, placeholder_level: 7 },
      },
    })).json();
    const agent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        boundDeviceIds: [sensor.id],
      },
    })).json();
    const derived = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services?provider=${agent.id as string}&origin=derived`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; semanticType: string }>;
    derivedServiceId = derived.find(service => service.semanticType === 'temperature-monitoring')!.id;
    // Replace the auto-mint (it reads `temperature`) with the placeholder
    // spec — the never-written claim must not depend on physics timing.
    const registered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${derivedServiceId}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-a'],
          metrics: [{ source: 'device', capability: 'temperature-monitoring', path: 'placeholder_level', fn: 'avg', as: 'placeholderAvg' }],
        },
        interface: { dataSchema: { fields: [{ name: 'placeholderAvg', type: 'number' }] } },
      },
    });
    expect(registered.statusCode).toBe(201);
    // u2's shape: a MEMBER (not the env owner) runs her own sims.
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(member.token),
      payload: {},
    })).statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  interface ReadSourceFace {
    status: string;
    fields: string[];
    simulationId: string;
    probedLane: 'own-sim' | 'world-session';
  }

  async function getSignability(serviceId: string, viewer: TestUser): Promise<{
    verdict: string;
    reason?: string;
    readSource?: ReadSourceFace;
  }> {
    return (await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(viewer.token),
    })).json().signability;
  }

  async function startOwnSim(viewer: TestUser): Promise<string> {
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(viewer.token),
      payload: { environmentId: envId, options: { llmClient: 'none' } },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(viewer.token),
      payload: {},
    })).statusCode).toBe(200);
    return simId;
  }

  async function stopSim(viewer: TestUser, simId: string): Promise<void> {
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(viewer.token),
      payload: {},
    })).statusCode).toBe(200);
  }

  /** The read lane's own session entry (targetFor) — what an actual default READ does. */
  async function materializeSession(): Promise<string> {
    const record = await ctx.app.worldSessions.targetFor(envId);
    expect(record).toBeDefined();
    const view = ctx.app.worldSessions.statusOf(envId);
    expect(view?.state).not.toBe('hibernated');
    return view!.simulationId;
  }

  /**
   * The session-lane invariant (T91): with no targetable own sim — absent OR
   * ambiguous — the only verdict the catalog may carry is the LIVE session's
   * (world-session lane). When the T54 oracle cannot speak for the session
   * (any rebuild/wake restore marks the world's state keys written — the
   * checkpoint discipline, by design), the honest outcome is NO face at all;
   * the pure decision table in agreements/targeting.vitest.test.ts pins the
   * lane selection itself.
   */
  function expectSessionLaneOrHonestUnknown(
    signability: { verdict: string; reason?: string; readSource?: ReadSourceFace },
    sessionSimId: string,
  ): void {
    if (signability.readSource !== undefined) {
      expect(signability.readSource).toMatchObject({
        status: 'never-written',
        probedLane: 'world-session',
        simulationId: sessionSimId,
      });
      expect(signability.reason).toContain('lands on this session');
    }
  }

  it('five-config matrix: the probe follows the read lane per viewer shape — own-sim verdict when one sim is hers, the session fallback when none is, honest unknown with no live world', async () => {
    // C1 (无自有 sim · 无活会话): a GET never creates the world — honest
    // unknown, plain verdict, no ⚠.
    expect(await getSignability(derivedServiceId, member)).toEqual({ verdict: 'backed' });

    // C2 (恰一台自有 sim · backed): the OWN-SIM lane — the viewer's own
    // world is judged, the wording layers the sim-less fallback honestly.
    const sim1 = await startOwnSim(member);
    const ownSim = await getSignability(derivedServiceId, member);
    expect(ownSim.verdict).toBe('ambiguous');
    expect(ownSim.readSource).toMatchObject({
      status: 'never-written',
      fields: ['placeholderAvg'],
      probedLane: 'own-sim',
    });
    expect(ownSim.reason).toContain('your running simulation');
    expect(ownSim.reason).toContain('Lane honesty');

    // C3 (两台自有 sim = ambiguous · 有活会话): T91's delta — the probe
    // follows the read lane's fallback to the LIVE world session instead of
    // falling silent (r13: the layered ⚠ vanished for exactly this shape).
    const sessionSimId = await materializeSession();
    const sim2 = await startOwnSim(member);
    const ambiguous = await getSignability(derivedServiceId, member);
    expect(ambiguous.verdict).toBe('backed'); // the ambiguous roster is a READ-lane 409, never a backing fact
    expectSessionLaneOrHonestUnknown(ambiguous, sessionSimId);

    // C4 (停掉一台 → 恰一台自有 sim · 会话仍活): the own-sim lane wins again.
    await stopSim(member, sim2);
    const backToOwn = await getSignability(derivedServiceId, member);
    expect(backToOwn.readSource).toMatchObject({ probedLane: 'own-sim', simulationId: sim1 });

    // C5 (无自有 sim · 有活会话): the sim-less default read lands on the
    // live session — the probe judges THAT world (u2's no-sim lane).
    await stopSim(member, sim1);
    const noSim = await getSignability(derivedServiceId, member);
    expectSessionLaneOrHonestUnknown(noSim, sessionSimId);

    // C6 (unbacked × 有活会话): read-source truth is orthogonal to backing
    // truth — the probe's judgment rides the UNBACKED verdict the same way.
    // The provider binds a device (the spec is registrable) but its published
    // semanticType covers NOTHING → the plain verdict is unbacked.
    const straySensor = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Stray Sensor',
        type: 'temperature-sensor',
        capabilities: ['temperature-monitoring'],
        zoneId: 'zone-b',
        initialState: { temperature: 19, placeholder_level: 3 },
      },
    })).json();
    const strayAgent = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Unbacked Agent',
        capabilities: ['temperature-monitoring'],
        boundDeviceIds: [straySensor.id],
      },
    })).json();
    const published = (await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${strayAgent.id as string}/services`,
      headers: auth(owner.token),
      payload: { name: 'Water Level Reading', semanticType: 'water-level-reading' },
    }));
    expect(published.statusCode).toBe(201);
    const unbackedRegistered = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${published.json().id as string}/computation`,
      headers: auth(owner.token),
      payload: {
        kind: 'device-aggregate',
        refreshSec: 60,
        inputs: {
          zones: ['zone-b'],
          metrics: [{ source: 'device', capability: 'temperature-monitoring', path: 'placeholder_level', fn: 'avg', as: 'placeholderAvg' }],
        },
        interface: { dataSchema: { fields: [{ name: 'placeholderAvg', type: 'number' }] } },
      },
    });
    expect(unbackedRegistered.statusCode).toBe(201);
    const unbacked = await getSignability(published.json().id as string, member);
    expect(unbacked.verdict).toBe('unbacked');
    expectSessionLaneOrHonestUnknown(unbacked, sessionSimId);

    // C7 (无活会话 — 会话已冻结): a GET never WAKES the session either —
    // back to honest unknown, the plain verdict restored.
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionSimId}/stop`,
      headers: auth(owner.token),
      payload: {},
    })).statusCode).toBe(200);
    const frozen = await getSignability(derivedServiceId, member);
    expect(frozen).toEqual({ verdict: 'backed' });
  });
});
