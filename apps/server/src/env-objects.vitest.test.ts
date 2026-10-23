/**
 * @vitest-environment node
 *
 * World-object API tests — device/agent instances inside environments.
 *
 * Fix-1 (unified change pipeline): structural edits to the shared world are
 * governed. The OWNER may still edit directly (every edit lands in
 * command_log as `env-direct-edit` with before/after); a BUILDER's device
 * create is converted into an `install-devices` proposal (returned instead
 * of a device), and — since Fix-7 — a builder's agent create becomes an
 * `install-agents` proposal and deleting their OWN device a `remove-devices`
 * one. Every other builder mutation is a 403 pointing at the proposal API.
 * Viewer membership is arranged through the store directly — the HTTP API
 * has no role-assignment endpoint in this slice.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environmentToScenario } from './environment-bridge.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('world objects (devices + agents)', () => {
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
        name: 'Object Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    // Builder joins through the API; viewer membership is seeded via the
    // store (no HTTP role-assignment endpoint exists in P2a).
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

  function createDevice(token: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(token),
      payload: {
        name: 'Thermostat',
        type: 'hvac',
        brand: 'Gree',
        capabilities: ['temperature-control'],
        zoneId: 'zone-a',
        initialState: { power: false },
        ...overrides,
      },
    });
  }

  function commandLog(token: string, kind?: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/command-log${kind !== undefined ? `?kind=${kind}` : ''}`,
      headers: auth(token),
    });
  }

  it('owner creates devices directly (audited); builder creation becomes a proposal', async () => {
    const byOwner = await createDevice(owner.token);
    expect(byOwner.statusCode).toBe(201);
    expect(byOwner.json().owner).toEqual({ id: owner.id, displayName: 'Owner' });
    expect(byOwner.json().envId).toBe(envId);
    expect(byOwner.json().brand).toBe('Gree');
    expect(byOwner.json().initialState).toEqual({ power: false });

    // Fix-1: the owner's direct create lands in command_log as
    // env-direct-edit with before/after.
    const log = await commandLog(owner.token, 'env-direct-edit');
    expect(log.statusCode).toBe(200);
    const entries = log.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].actor.id).toBe(owner.id);
    expect(entries[0].payload).toMatchObject({
      objectType: 'device',
      action: 'created',
      objectId: byOwner.json().id,
      before: null,
    });
    expect(entries[0].payload.after.name).toBe('Thermostat');

    // Fix-1: a builder's POST is converted into an install-devices proposal
    // — no device appears until the pipeline approves it.
    const byBuilder = await createDevice(builder.token);
    expect(byBuilder.statusCode).toBe(201);
    const proposal = byBuilder.json();
    expect(proposal.kind).toBe('install-devices');
    expect(proposal.status).toBe('escalated'); // default reviewer escalates
    expect(proposal.author.id).toBe(builder.id);
    expect(proposal.payload.devices[0]).toMatchObject({
      name: 'Thermostat',
      type: 'hvac',
      zoneId: 'zone-a',
    });
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(1); // owner's only

    // Owner approval applies the builder's proposal → the device lands,
    // attributed to the builder.
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(2);

    const byViewer = await createDevice(viewer.token);
    expect(byViewer.statusCode).toBe(403);

    const byStranger = await createDevice(stranger.token);
    expect(byStranger.statusCode).toBe(403);

    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      payload: { name: 'X', type: 't', capabilities: [], zoneId: 'zone-a' },
    });
    expect(anon.statusCode).toBe(401);
  });

  // C2 (R25-NF3, DevLoop R28): the direct create teaches that installing a
  // device alone publishes nothing — derived services mint only when an
  // agent binds it (the R25 provider story: device applied, no service, no
  // hint).
  it('C2: owner direct device-create carries the agent-binding hint; zero-capability devices skip it', async () => {
    const created = await createDevice(owner.token);
    expect(created.statusCode).toBe(201);
    const warningText = ((created.json().warnings as string[]) ?? []).join(' ');
    expect(warningText).toContain('no bound agent');
    expect(warningText).toContain('Thermostat');
    expect(warningText).toContain('POST /api/environments/:id/agents');

    // A zero-capability device carries no binding hint (nothing to derive —
    // the executability teaching owns that case).
    const bare = await createDevice(owner.token, { name: 'Bare Beacon', capabilities: [] });
    expect(bare.statusCode).toBe(201);
    expect(((bare.json().warnings as string[]) ?? []).join(' ')).not.toContain('no bound agent');
  });

  it('Fix-18 (R7 F-01): a create carrying binding keeps it — hass:// force-escalates to the owner', async () => {
    // Builder path: the binding rides the converted proposal (never silently
    // dropped) and the rule check force-escalates hass:// to the owner.
    const byBuilder = await createDevice(builder.token, { binding: 'hass://light.living_room' });
    expect(byBuilder.statusCode).toBe(201);
    const proposal = byBuilder.json();
    expect(proposal.kind).toBe('install-devices');
    expect(proposal.status).toBe('escalated');
    expect(proposal.riskLevel).toBe('high');
    expect(proposal.ruleCheck.forceEscalate).toBe(true);
    expect(proposal.ruleCheck.escalateReason).toContain('hass://');
    expect(proposal.payload.devices[0].binding).toBe('hass://light.living_room');
    expect(ctx.app.envStore.devicesOf(envId)).toHaveLength(0); // nothing lands unapproved

    // Owner approval applies the binding — the device is bridged at birth.
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    expect(ctx.app.envStore.devicesOf(envId)[0].binding).toBe('hass://light.living_room');

    // Owner path: direct create binds immediately (same body field).
    const byOwner = await createDevice(owner.token, {
      name: 'Bound Lamp',
      binding: 'hass://switch.porch',
    });
    expect(byOwner.statusCode).toBe(201);
    expect(byOwner.json().binding).toBe('hass://switch.porch');

    // A malformed binding is a 400, not a silent drop to sim://.
    const bad = await createDevice(owner.token, { binding: 'mqtt://nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('400s on unknown zone and on malformed bodies', async () => {
    const badZone = await createDevice(owner.token, { zoneId: 'nope' });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json().error.code).toBe('UNKNOWN_ZONE');

    expect((await createDevice(owner.token, { name: '' })).statusCode).toBe(400);
    expect((await createDevice(owner.token, { capabilities: 'lots' })).statusCode).toBe(400);
    expect((await createDevice(owner.token, { capabilities: [1] })).statusCode).toBe(400);
  });

  it('T-038 (RF-F06): GET /devices lists the env devices behind the same read gate as the detail', async () => {
    const created = await createDevice(owner.token);
    expect(created.statusCode).toBe(201);
    const device = created.json();

    // Members and anonymous readers of the PUBLIC env all see the list —
    // identical rows to the environment detail's devices array.
    for (const token of [owner.token, builder.token, viewer.token]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/devices`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().devices).toHaveLength(1);
      expect(res.json().devices[0]).toMatchObject({ id: device.id, name: 'Thermostat' });
      expect(res.json().devices[0].owner).toEqual({ id: owner.id, displayName: 'Owner' });
    }
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}/devices` });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().devices).toHaveLength(1);

    // The gate is the env's, not a bypass: a stranger on a PRIVATE env gets
    // the same teachable 403 as every sibling read endpoint.
    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private Lab', visibility: 'private', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(privateEnv.statusCode).toBe(201);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${privateEnv.json().id}/devices`,
      headers: auth(stranger.token),
    });
    expect(denied.statusCode).toBe(403);

    // Unknown env is 404, not an empty list.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/environments/env-does-not-exist/devices',
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(404);
  });

  it('T-038 (FF-F02): GET /api/devices/:id fetches one device; gate follows its env', async () => {
    const created = await createDevice(owner.token);
    expect(created.statusCode).toBe(201);
    const device = created.json();

    // S2 (device privacy): the ENV OWNER reads the full view — same shape as
    // the create response (the create response may carry capability
    // warnings, which are create-time only).
    const byOwner = await ctx.app.inject({
      method: 'GET',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
    });
    expect(byOwner.statusCode).toBe(200);
    const { warnings: _createOnly, ...deviceCore } = device as Record<string, unknown>;
    expect(byOwner.json()).toEqual(deviceCore);

    // A BUILDER member sees the COARSE projection of the owner's device:
    // structure facts + status, but no initialState (telemetry) and an
    // explicit visibility marker.
    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/api/devices/${device.id}`,
      headers: auth(builder.token),
    });
    expect(fetched.statusCode).toBe(200);
    const coarse = fetched.json() as Record<string, unknown>;
    expect(coarse.id).toBe(device.id);
    expect(coarse.name).toBe('Thermostat');
    expect(coarse.stateVisibility).toBe('coarse');
    expect(coarse.status).toBe('off'); // initialState { power: false }
    expect(coarse.initialState).toBeUndefined();

    // Anonymous may read a PUBLIC env's device (same as the detail view) —
    // in the coarse view (never the owner's telemetry).
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/devices/${device.id}` });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().id).toBe(device.id);
    expect(anon.json().initialState).toBeUndefined();

    // Unknown id → the named 404.
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/devices/does-not-exist',
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('DEVICE_NOT_FOUND');

    // A device in a PRIVATE env hides from strangers (403, not 404).
    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Vault', visibility: 'private', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    const secret = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${privateEnv.json().id}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Vault Sensor', type: 'sensor', capabilities: [], zoneId: 'zone-a' },
    });
    expect(secret.statusCode).toBe(201);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/devices/${secret.json().id}`,
      headers: auth(stranger.token),
    });
    expect(denied.statusCode).toBe(403);
    // …while the owner still reads it.
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: `/api/devices/${secret.json().id}`,
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(200);
  });

  it('PATCH: env owner only (audited); builders are pointed at the proposal API', async () => {
    const device = (await createDevice(owner.token)).json();

    const byEnvOwner = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { name: 'Renamed', zoneId: 'zone-b', initialState: { power: true } },
    });
    expect(byEnvOwner.statusCode).toBe(200);
    expect(byEnvOwner.json().name).toBe('Renamed');
    expect(byEnvOwner.json().zoneId).toBe('zone-b');
    expect(byEnvOwner.json().initialState).toEqual({ power: true });

    // The update is audited with the before/after object JSON.
    const log = await commandLog(owner.token, 'env-direct-edit');
    const update = log.json().entries.find(
      (entry: { payload: { action: string } }) => entry.payload.action === 'updated',
    );
    expect(update.actor.id).toBe(owner.id);
    expect(update.payload.before.name).toBe('Thermostat');
    expect(update.payload.after.name).toBe('Renamed');

    // Fix-1: direct edits are env-owner only — a builder patching SOMEONE
    // ELSE'S device gets a teaching 403 (Chinese, no manual-API guidance).
    const otherBuilder = await registerUser(ctx.app, { displayName: 'OtherBuilder' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(otherBuilder.token),
    });
    for (const token of [otherBuilder.token, viewer.token]) {
      const denied = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/devices/${device.id}`,
        headers: auth(token),
        payload: { name: 'Hijack' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.message).toContain('仅限环境所有者');
      // R98: the governed path is named, never a "POST /api/…" instruction.
      expect(denied.json().error.message).toContain('modify-object');
      expect(denied.json().error.message).not.toContain('POST /api');
    }

    // Env owner patching a zone that does not exist → 400.
    const badZone = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { zoneId: 'nowhere' },
    });
    expect(badZone.statusCode).toBe(400);
  });

  it("PATCH: a builder's OWN device converts to a modify-object proposal (R98, li-01) — approval lands the change", async () => {
    // The builder gets a device through the governed path (install-devices
    // proposal approved by the owner), so they genuinely OWN one.
    const proposed = await createDevice(builder.token, { name: 'Builder Meter' });
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposed.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    const mine = ctx.app.envStore.devicesOf(envId).find(d => d.name === 'Builder Meter')!;
    expect(mine.owner_id).toBe(builder.id);

    // R98 (li-01): the Web/CLI save path — same call, now a 201 modify-object
    // proposal with the SAME patch semantics, not a dead-end 403.
    const converted = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${mine.id}`,
      headers: auth(builder.token),
      payload: { name: 'Self-Rename', zoneId: 'zone-b' },
    });
    expect(converted.statusCode).toBe(201);
    expect(converted.json().kind).toBe('modify-object');
    expect(converted.json().payload).toMatchObject({
      targetId: mine.id,
      patch: { name: 'Self-Rename', zoneId: 'zone-b' },
    });

    // Owner approval (or the pipeline's auto-apply for low-risk patches —
    // either way) lands the rename + zone move.
    if (converted.json().status !== 'applied') {
      const approved = await ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${converted.json().id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'approved' },
      });
      expect(approved.json().status).toBe('applied');
    }
    const after = ctx.app.envStore.getDevice(mine.id)!;
    expect(after.name).toBe('Self-Rename');
    expect(after.zone_id).toBe('zone-b');
  });

  it('DELETE: env owner only (audited); builders and viewers 403', async () => {
    const first = (await createDevice(owner.token)).json();
    const byViewer = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${first.id}`,
      headers: auth(viewer.token),
    });
    expect(byViewer.statusCode).toBe(403);

    const byBuilder = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${first.id}`,
      headers: auth(builder.token),
    });
    expect(byBuilder.statusCode).toBe(403);

    const byEnvOwner = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${first.id}`,
      headers: auth(owner.token),
    });
    expect(byEnvOwner.statusCode).toBe(204);

    const log = await commandLog(owner.token, 'env-direct-edit');
    const deletion = log.json().entries.find(
      (entry: { payload: { action: string } }) => entry.payload.action === 'deleted',
    );
    expect(deletion.actor.id).toBe(owner.id);
    expect(deletion.payload).toMatchObject({ objectType: 'device', action: 'deleted', after: null });
    expect(deletion.payload.before.id).toBe(first.id);

    const gone = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${first.id}`,
      headers: auth(owner.token),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('F6: DELETE tolerates Content-Type: application/json with an EMPTY body (root tolerant parser)', async () => {
    // Clients that unconditionally set a JSON content-type on body-less
    // DELETEs used to 400 with a raw FST_ERR_CTP_EMPTY_JSON_BODY on every
    // route outside the T-409 tolerant scopes.
    const device = (await createDevice(owner.token)).json();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${device.id}`,
      headers: { ...auth(owner.token), 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(204);
  });

  it('DELETE agent/device fires a catalog-change notification (P2: FK-cascade rows must converge the live world: mirror)', async () => {
    const device = (await createDevice(owner.token)).json();
    const agent = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'A', capabilities: ['temperature-control'], boundDeviceIds: [device.id] },
      })
    ).json();

    const seen: string[] = [];
    const unsubscribe = ctx.app.serviceStore.onCatalogChange(id => seen.push(id));
    try {
      // Agent delete: every service row goes via FK CASCADE — no store write
      // method runs, so the route must notify explicitly.
      const deletedAgent = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/agents/${agent.id}`,
        headers: auth(owner.token),
      });
      expect(deletedAgent.statusCode).toBe(204);
      expect(seen).toContain(envId);

      seen.length = 0;
      const deletedDevice = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/devices/${device.id}`,
        headers: auth(owner.token),
      });
      expect(deletedDevice.statusCode).toBe(204);
      expect(seen).toContain(envId);
    } finally {
      unsubscribe();
    }
  });

  it('validates the agent llm block shape at write time (DevLoop)', async () => {
    // The env API used to accept any object; the scenario schema requires
    // {provider, model} — a malformed block only failed at simulation time
    // (ENVIRONMENT_INVALID), long after the author configured it.
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'BadLlm', capabilities: [], llm: { model: 'qwen' } },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json().error.message as string)).toContain('llm.provider');

    const good = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'GoodLlm',
        capabilities: [],
        llm: { provider: 'openai-compatible', model: 'qwen3-vl:8b', params: { temperature: 0.2 } },
      },
    });
    expect(good.statusCode).toBe(201);
    expect(good.json().llm.provider).toBe('openai-compatible');

    const agentId = good.json().id;
    const badPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { llm: { provider: 'openai-compatible' } },
    });
    expect(badPatch.statusCode).toBe(400);
    expect((badPatch.json().error.message as string)).toContain('llm.model');
  });

  it('creates agents (owner directly; builder via install-agents proposal) and validates boundDeviceIds', async () => {
    const device = (await createDevice(owner.token)).json();

    // Fix-7: a builder's POST is converted into an install-agents proposal —
    // the rule checker rejects it here because the bound device belongs to
    // the OWNER, not the builder (设备私有原则).
    const byBuilder = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(builder.token),
      payload: { name: 'Agent', capabilities: [], boundDeviceIds: [device.id] },
    });
    expect(byBuilder.statusCode).toBe(201);
    expect(byBuilder.json().kind).toBe('install-agents');
    expect(byBuilder.json().status).toBe('rejected');
    expect(byBuilder.json().ruleCheck.issues.join(' ')).toContain('owned by another user');
    expect(ctx.app.envStore.agentsOf(envId)).toHaveLength(0);

    const foreignEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Other Env', mapData: { zones: [{ id: 'zone-x' }] } },
    });
    const foreignDevice = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${foreignEnv.json().id}/devices`,
        headers: auth(owner.token),
        payload: { name: 'F', type: 't', capabilities: [], zoneId: 'zone-x' },
      })
    ).json();

    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Agent', capabilities: [], boundDeviceIds: [foreignDevice.id] },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('DEVICE_NOT_FOUND');

    const ghost = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Agent', capabilities: [], boundDeviceIds: ['ghost-device'] },
    });
    expect(ghost.statusCode).toBe(404);

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Climate Agent',
        capabilities: ['temperature-control'],
        boundDeviceIds: [device.id],
        managedZoneIds: ['zone-a'],
        llm: { provider: 'openai-compatible', model: 'qwen3' },
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().owner.id).toBe(owner.id);
    expect(ok.json().boundDeviceIds).toEqual([device.id]);
    expect(ok.json().llm).toEqual({ provider: 'openai-compatible', model: 'qwen3' });

    // Audited like every owner direct edit.
    const log = await commandLog(owner.token, 'env-direct-edit');
    const createdEntry = log.json().entries.find(
      (entry: { payload: { objectType: string; action: string } }) =>
        entry.payload.objectType === 'agent' && entry.payload.action === 'created',
    );
    expect(createdEntry.actor.id).toBe(owner.id);
    expect(createdEntry.payload.after.name).toBe('Climate Agent');
  });

  it('PATCH/DELETE agents: env owner only; binding revalidated on patch', async () => {
    const device = (await createDevice(owner.token)).json();
    const agent = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'A', capabilities: [], boundDeviceIds: [device.id] },
      })
    ).json();

    const badPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
      payload: { boundDeviceIds: ['ghost'] },
    });
    expect(badPatch.statusCode).toBe(404);

    const byViewer = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(viewer.token),
      payload: { name: 'Hijack' },
    });
    expect(byViewer.statusCode).toBe(403);

    const byBuilder = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(builder.token),
      payload: { name: 'Hijack' },
    });
    expect(byBuilder.statusCode).toBe(403);

    const byEnvOwner = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
      payload: { name: 'Agent Renamed' },
    });
    expect(byEnvOwner.statusCode).toBe(200);
    expect(byEnvOwner.json().name).toBe('Agent Renamed');

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${agent.id}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('viewer cannot create agents either', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(viewer.token),
      payload: { name: 'A', capabilities: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // T-206 — capability honesty at agent authoring (owner-direct paths)
  // -------------------------------------------------------------------------

  it('T-206: owner-direct agent create rejects unbacked capabilities (422, teaching error)', async () => {
    const aq = await createDevice(owner.token, {
      name: 'Air Quality Station', type: 'air-quality-sensor',
      capabilities: ['air-quality-reading'], brand: null,
    });
    expect(aq.statusCode).toBe(201);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Health HVAC Agent', capabilities: ['hvac-control'], boundDeviceIds: [aq.json().id] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AGENT_CAPABILITIES_UNBACKED');
    const issues = res.json().error.issues.join(' ');
    expect(issues).toContain('"hvac-control"');
    expect(issues).toContain('not provided by any bound device');
    expect(issues).toContain('air-quality-reading');
  });

  it('T-206: owner-direct agent create accepts backed capabilities', async () => {
    const hvac = await createDevice(owner.token);
    expect(hvac.statusCode).toBe(201);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Facility Agent', capabilities: ['temperature-control'], boundDeviceIds: [hvac.json().id] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('T-206: owner-direct agent PATCH enforces backing on the resulting bound set', async () => {
    const hvac = await createDevice(owner.token);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Facility Agent', capabilities: [], boundDeviceIds: [hvac.json().id] },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id as string;

    // Unbacked capability patch → 422.
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { capabilities: ['surveillance'] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('AGENT_CAPABILITIES_UNBACKED');
    expect(bad.json().error.issues.join(' ')).toContain('"surveillance"');

    // Backed patch → 200.
    const good = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { capabilities: ['temperature-control'] },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().capabilities).toEqual(['temperature-control']);
  });

  // BUG-08 ③ (dorm-life 绕行 #1): the endorsement oracle accepts the device
  // TYPE's executable expansion (multiCommandNamesForDeviceType — the same
  // type-gated route the flow executability oracle accepts), so an agent
  // bound to an exhaust-fan may declare 'ventilation' without the device
  // literally declaring it. Generic non-type-gated mappings still reject.
  it('T-206 + BUG-08③: device-type expansion backs a declaration (exhaust-fan → ventilation)', async () => {
    const fan = await createDevice(owner.token, {
      name: 'Bathroom Exhaust Fan', type: 'exhaust-fan',
      capabilities: ['turn-on', 'turn-off', 'set-speed'], brand: null,
    });
    expect(fan.statusCode).toBe(201);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Ventilation Agent', capabilities: ['ventilation'], boundDeviceIds: [fan.json().id] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().capabilities).toEqual(['ventilation']);
  });

  it('T-206 + BUG-08③: a non-type-gated generic mapping still does NOT back (fire-monitoring on a sensor)', async () => {
    const sensor = await createDevice(owner.token, {
      name: 'Temperature Sensor', type: 'temperature-sensor',
      capabilities: ['temperature-reading'], brand: null,
    });
    expect(sensor.statusCode).toBe(201);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Watchman', capabilities: ['fire-monitoring'], boundDeviceIds: [sensor.json().id] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AGENT_CAPABILITIES_UNBACKED');
    expect(res.json().error.issues.join(' ')).toContain('"fire-monitoring"');
  });

  // -------------------------------------------------------------------------
  // T-051: per-agent decisionPolicy (agent authoring channel)
  // -------------------------------------------------------------------------

  it('T-051: agent create/PATCH accept decisionPolicy (closed shape); null clears', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Policy Agent',
        capabilities: [],
        boundDeviceIds: [],
        decisionPolicy: { autoActuateIndependent: false, autoInitiateAC: true },
      },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().id as string;
    expect(created.json().decisionPolicy).toEqual({
      autoActuateIndependent: false,
      autoInitiateAC: true,
    });

    // Validation: unknown key / non-boolean / empty object all teach.
    const unknownKey = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'X', capabilities: [], decisionPolicy: { autoActuate: true } },
    });
    expect(unknownKey.statusCode).toBe(400);
    expect(unknownKey.json().error.message).toContain('decisionPolicy.autoActuate');

    const nonBoolean = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: { autoInitiateAC: 'yes' } },
    });
    expect(nonBoolean.statusCode).toBe(400);

    const empty = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: {} },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toContain('at least one of');

    // PATCH updates; null clears the policy entirely.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: { autoActuateIndependent: false } },
    });
    expect(patched.json().decisionPolicy).toEqual({ autoActuateIndependent: false });

    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().decisionPolicy).toBeUndefined();
  });

  it('R43-B: decisionPolicy accepts the precheckPassThrough pair (enum + [0,1] rate); bad values teach', async () => {
    // Valid pair round-trips.
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'PassThrough Agent',
        capabilities: [],
        boundDeviceIds: [],
        decisionPolicy: { precheckPassThrough: 'sample', precheckPassThroughRate: 0.4 },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().decisionPolicy).toEqual({
      precheckPassThrough: 'sample',
      precheckPassThroughRate: 0.4,
    });

    // Unknown enum value → named rejection.
    const badMode = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: { precheckPassThrough: 'sometimes' } },
    });
    expect(badMode.statusCode).toBe(400);
    expect(badMode.json().error.message).toContain('precheckPassThrough');

    // Rate outside [0,1] → named rejection.
    const badRate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: { precheckPassThrough: 'sample', precheckPassThroughRate: 1.5 } },
    });
    expect(badRate.statusCode).toBe(400);
    expect(badRate.json().error.message).toContain('precheckPassThroughRate');

    // Non-boolean on the legacy boolean keys still teaches.
    const nonBool = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: { autoInitiateAC: 'yes', precheckPassThrough: 'all' } },
    });
    expect(nonBool.statusCode).toBe(400);
    expect(nonBool.json().error.message).toContain('autoInitiateAC');
  });

  it('R45-P1: decisionPolicy accepts role "coordinator" (dispatcher); other role values teach', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Dispatcher Agent',
        capabilities: [],
        boundDeviceIds: [],
        decisionPolicy: { role: 'coordinator' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().decisionPolicy).toEqual({ role: 'coordinator' });

    const badRole = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${created.json().id}`,
      headers: auth(owner.token),
      payload: { decisionPolicy: { role: 'executor' } },
    });
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json().error.message).toContain('decisionPolicy.role');
  });

  it('T-051: install-agents and modify-object proposals carry decisionPolicy', async () => {
    // Builder install with a policy → applied agent keeps it.
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'install-agents',
        payload: {
          agents: [
            {
              name: 'Governed Policy Agent',
              capabilities: [],
              boundDeviceIds: [],
              decisionPolicy: { autoInitiateAC: false },
            },
          ],
        },
      },
    });
    expect(submitted.statusCode).toBe(201);
    if (submitted.json().status !== 'applied') {
      const decided = await ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${submitted.json().id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'approved' },
      });
      expect(decided.json().status).toBe('applied');
    }
    const agent = ctx.app.envStore
      .agentsOf(envId)
      .find(row => row.name === 'Governed Policy Agent')!;
    expect(agent).toBeDefined();

    // modify-object patches it; revert restores the before policy.
    const modify = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: {
        kind: 'modify-object',
        payload: { targetId: agent.id, patch: { decisionPolicy: { autoActuateIndependent: false } } },
      },
    });
    expect(modify.statusCode).toBe(201);
    const modifyId = modify.json().id as string;
    if (modify.json().status !== 'applied') {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${modifyId}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'approved' },
      });
    }
    expect(
      JSON.parse(ctx.app.envStore.getAgent(agent.id)!.decision_policy_json ?? 'null'),
    ).toEqual({ autoActuateIndependent: false });

    const reverted = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${modifyId}/revert`,
      headers: auth(builder.token),
    });
    expect(reverted.json().status).toBe('reverted');
    expect(
      JSON.parse(ctx.app.envStore.getAgent(agent.id)!.decision_policy_json ?? 'null'),
    ).toEqual({ autoInitiateAC: false });
  });

  it('T-051: the bridge threads decisionPolicy into ScenarioAgent for sims', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Bridged Policy Agent',
        capabilities: [],
        boundDeviceIds: [],
        decisionPolicy: { autoActuateIndependent: false },
      },
    });
    const agentId = created.json().id as string;

    // Sim options carry the sim-level switch; the agent's own policy rides
    // the bridged scenario. Both reach the runtime per T-050 precedence.
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: {
        environmentId: envId,
        options: { autoActuateIndependent: true },
      },
    });
    expect(sim.statusCode).toBe(201);

    // Direct bridge assertion: the env row lands as decisionPolicy on the
    // scenario agent (core resolves sim option > policy > default).
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const scenario = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );
    const bridged = scenario.agents.find(a => a.id === agentId)!;
    expect(bridged.decisionPolicy).toEqual({ autoActuateIndependent: false });

    // The option is part of the accepted options vocabulary (bad type 400s).
    const badOption = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: {
        environmentId: envId,
        options: { autoActuateIndependent: 'nope' },
      },
    });
    expect(badOption.statusCode).toBe(400);
    expect(badOption.json().error.message).toContain('autoActuateIndependent');
  });
});

// ---------------------------------------------------------------------------
// NF2702 (DevLoop R28) — agents/zones list GETs (T-038 read-surface parity)
// ---------------------------------------------------------------------------

describe('world objects — NF2702 agents/zones list routes', () => {
  // Reuse the same harness shape as the main suite (public env, members,
  // stranger, viewer).
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
        name: 'List Lab',
        visibility: 'public',
        mapData: {
          zones: [
            { id: 'zone-a', name: 'Zone A' },
            { id: 'zone-b', name: 'Zone B' },
          ],
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
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
  });

  // Same rule as the main suite above: an unclosed app leaks its native
  // better-sqlite3 handle into worker-thread teardown (0xC0000005 risk).
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('GET /agents lists the env agents, rows identical to the env detail, same read gate', async () => {
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Listed Agent', capabilities: [], managedZoneIds: ['zone-a'] },
    });
    expect(agent.statusCode).toBe(201);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/agents`,
      headers: auth(builder.token),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().agents).toEqual(detail.json().agents);

    // Anonymous on the public env reads; a stranger on a private env 403s;
    // unknown env 404s (never an empty list).
    expect((await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}/agents` })).statusCode).toBe(200);
    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private', visibility: 'private', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${privateEnv.json().id}/agents`,
        headers: auth(stranger.token),
      })).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/environments/env-does-not-exist/agents',
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(404);
    void viewer;
  });

  it('GET /zones lists the env zones, rows identical to the env detail, same read gate', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/zones`,
      headers: auth(builder.token),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().zones).toEqual(detail.json().zones);
    expect(listed.json().zones.map((z: { id: string }) => z.id)).toEqual(['zone-a', 'zone-b']);

    expect((await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}/zones` })).statusCode).toBe(200);
    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: '/api/environments/env-does-not-exist/zones',
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(404);
  });

  // T-715 (R29, F-PH25): the documented-but-404 pair. GET /zones landed with
  // T-038 (covered above — the R29 404 was a stale dist); the env-scoped
  // agent PATCH alias is pinned here: same handler core as /api/agents/:id,
  // env-scoped teaching 404, owner-only.
  describe('PATCH /api/environments/:id/agents/:agentId (T-715 alias)', () => {
    it('updates the agent through the env-scoped path (owner)', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'Pre-Patch', capabilities: [], managedZoneIds: ['zone-a'] },
      });
      expect(created.statusCode).toBe(201);
      const agentId = (created.json() as { id: string }).id;

      const patched = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/agents/${agentId}`,
        headers: auth(owner.token),
        payload: { name: 'Post-Patch', managedZoneIds: ['zone-b'] },
      });
      expect(patched.statusCode).toBe(200);
      const body = patched.json() as { id: string; name: string; managedZoneIds: string[] };
      expect(body.id).toBe(agentId);
      expect(body.name).toBe('Post-Patch');
      expect(body.managedZoneIds).toEqual(['zone-b']);
      // Same shape the flat route returns (WorldAgent), same store effect.
      expect(ctx.app.envStore.getAgent(agentId)!.name).toBe('Post-Patch');
    });

    it('an agent of ANOTHER env under this env path is a teaching 404', async () => {
      const otherEnv = await ctx.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(owner.token),
        payload: { name: 'Other', visibility: 'public', mapData: { zones: [{ id: 'zone-x' }] } },
      });
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${otherEnv.json().id}/agents`,
        headers: auth(owner.token),
        payload: { name: 'Foreign', capabilities: [] },
      });
      const foreignId = (created.json() as { id: string }).id;

      const wrongEnv = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/agents/${foreignId}`,
        headers: auth(owner.token),
        payload: { name: 'Nope' },
      });
      expect(wrongEnv.statusCode).toBe(404);
      expect((wrongEnv.json() as { error: { code: string } }).error.code).toBe('AGENT_NOT_FOUND');
      // Unknown env path segment is a plain 404 as well.
      expect(
        (await ctx.app.inject({
          method: 'PATCH',
          url: `/api/environments/env-does-not-exist/agents/${foreignId}`,
          headers: auth(owner.token),
          payload: { name: 'Nope' },
        })).statusCode,
      ).toBe(404);
    });

    it('keeps the Fix-1 governance: builders 403, anonymous 401', async () => {
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/agents`,
        headers: auth(owner.token),
        payload: { name: 'Governed', capabilities: [] },
      });
      const agentId = (created.json() as { id: string }).id;

      expect(
        (await ctx.app.inject({
          method: 'PATCH',
          url: `/api/environments/${envId}/agents/${agentId}`,
          headers: auth(builder.token),
          payload: { name: 'Builder Edit' },
        })).statusCode,
      ).toBe(403);
      expect(
        (await ctx.app.inject({
          method: 'PATCH',
          url: `/api/environments/${envId}/agents/${agentId}`,
          payload: { name: 'Anonymous Edit' },
        })).statusCode,
      ).toBe(401);
    });
  });
});


/**
 * R5-F12 (fault-injection drill visibility): agent responses expose
 * `effectiveModel` — the model actually served after deployment model
 * normalization — so a drill operator PATCHing a stale llm.model sees the
 * rewrite on the API surface instead of only in trajectory context.
 */
describe('R5-F12 — effectiveModel in agent responses', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function setup(llmModel?: string): Promise<void> {
    ctx = await makeTestApp(
      llmModel !== undefined
        ? { llmBaseUrl: 'http://localhost:9/v1', llmModel }
        : {},
    );
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'F12 Lab', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  }

  function createAgent(payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'A', capabilities: [], ...payload },
    });
  }

  it('deployed LLM_MODEL wins over a declared llm.model (create, PATCH, list)', async () => {
    await setup('ac-decision-v4:latest');

    // Create: the declared model is echoed in llm, effectiveModel shows the
    // model the deployment actually serves.
    const created = await createAgent({
      llm: { provider: 'openai-compatible', model: 'stale-ollama:7b' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().llm.model).toBe('stale-ollama:7b');
    expect(created.json().effectiveModel).toBe('ac-decision-v4:latest');
    const agentId = created.json().id;

    // PATCH llm.model (the drill's injection lane): the response shows the
    // normalization result at once.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { llm: { provider: 'openai-compatible', model: 'another-stale:3b' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().llm.model).toBe('another-stale:3b');
    expect(patched.json().effectiveModel).toBe('ac-decision-v4:latest');

    // The env-scoped list carries the same field.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().agents.find((a: { id: string }) => a.id === agentId).effectiveModel)
      .toBe('ac-decision-v4:latest');

    // An agent without its own model still normalizes to the deployed model
    // (shared client pins deployedModel too).
    const shared = await createAgent({ name: 'Shared' });
    expect(shared.json().effectiveModel).toBe('ac-decision-v4:latest');

    // Explicit llm:null (rule-only) → no model at all, field absent.
    const ruleOnly = await createAgent({ name: 'RuleOnly', llm: null });
    expect(ruleOnly.statusCode).toBe(201);
    expect('effectiveModel' in ruleOnly.json()).toBe(false);
  });

  it('no LLM_MODEL pinned: a declared model is served as-is; undeterminable is omitted', async () => {
    await setup();

    const declared = await createAgent({
      llm: { provider: 'openai-compatible', model: 'qwen3-vl:8b' },
    });
    expect(declared.statusCode).toBe(201);
    expect(declared.json().effectiveModel).toBe('qwen3-vl:8b');

    // No declaration and no deployment pin → the shared default is not
    // per-agent determinable here; the field stays absent (honest omission).
    const shared = await createAgent({ name: 'Shared' });
    expect('effectiveModel' in shared.json()).toBe(false);
  });
});
