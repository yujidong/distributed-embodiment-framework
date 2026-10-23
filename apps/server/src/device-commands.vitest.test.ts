/**
 * @vitest-environment node
 *
 * Sim device-command endpoint tests (Fix-1, unified change pipeline §4.1).
 *
 * Covers the three things the endpoint gained:
 * - AUTH: anonymous → 401; non-members → 403 on env-backed sims; owner and
 *   builder may control devices; viewers are 403 (read-only, Fix-4). Legacy
 *   scenario sims belong to their creator.
 * - AUDIT: an executed command on an env-backed sim lands in command_log as
 *   `device-command` with the caller as actor, `{deviceId, commandName,
 *   before, after}` and the sim time — the exact shape replay-service.ts
 *   consumes (proved end-to-end: command → replay → events).
 * - ERROR SEMANTICS: unknown device 404 DEVICE_NOT_FOUND (split from the
 *   engine's catch-all "No agent manages device"), existing-but-unmanaged
 *   device 409 DEVICE_NOT_MANAGED, unknown command 400 UNKNOWN_COMMAND.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockHassServer } from './hass/mock-hass.js';
import {
  auth,
  createUserScenario,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('sim device commands (Fix-1)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let envId: string;
  /** Instance id of the imported 'HVAC B' device (import regenerates ids). */
  let hvacId: string;
  /** Instance id of the imported 'Sensor A' (a reading-only face — the T80 target). */
  let sensorId: string;

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
      payload: { ...importableScenario('command-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');
    hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;
    sensorId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'Sensor A')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createEnvSim(token?: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: { environmentId: envId },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  function command(simId: string, token: string | undefined, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload,
    });
  }

  // -------------------------------------------------------------------------
  // Auth matrix
  // -------------------------------------------------------------------------

  it('auth matrix: anonymous 401, non-member 403, viewer 403 (read-only, Fix-4), owner/builder 200', async () => {
    const simId = await createEnvSim(owner.token);

    const anonymous = await command(simId, undefined, { deviceId: hvacId, commandName: 'turn-on' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('UNAUTHORIZED');

    // Public environment, but commands are member-only.
    const nonMember = await command(simId, stranger.token, { deviceId: hvacId, commandName: 'turn-on' });
    expect(nonMember.statusCode).toBe(403);
    expect(nonMember.json().error.code).toBe('FORBIDDEN');

    // Fix-4: viewers are read-only end to end — commands are 403 with a
    // message that names the missing role.
    const viewerRes = await command(simId, viewer.token, { deviceId: hvacId, commandName: 'turn-on' });
    expect(viewerRes.statusCode).toBe(403);
    expect(viewerRes.json().error.code).toBe('FORBIDDEN');
    expect(viewerRes.json().error.message).toContain('read-only');

    for (const member of [owner, builder]) {
      const res = await command(simId, member.token, { deviceId: hvacId, commandName: 'turn-on' });
      expect(res.statusCode, `member ${member.displayName}`).toBe(200);
      expect(res.json().success).toBe(true);
    }
  });

  it('private env: member commands, non-member 403', async () => {
    const priv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('command-lab-private'), visibility: 'private' },
    });
    const privId = priv.json().id as string;
    const privHvacId = (priv.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: privId },
    });
    const simId = sim.json().id as string;

    expect((await command(simId, stranger.token, { deviceId: privHvacId, commandName: 'turn-on' })).statusCode).toBe(403);
    expect((await command(simId, owner.token, { deviceId: privHvacId, commandName: 'turn-on' })).statusCode).toBe(200);
  });

  it('legacy scenario sims: only the creator may command', async () => {
    await createUserScenario(ctx.app, importableScenario('legacy-lab'));
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { scenarioId: 'legacy-lab' },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    // Legacy sims keep the scenario's own device ids.
    expect((await command(simId, stranger.token, { deviceId: 'hvac-b', commandName: 'turn-on' })).statusCode).toBe(403);
    expect((await command(simId, owner.token, { deviceId: 'hvac-b', commandName: 'turn-on' })).statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Audit: command_log + replay consumption
  // -------------------------------------------------------------------------

  it('executed commands land in command_log (actor, before/after, simTime)', async () => {
    const simId = await createEnvSim(owner.token);
    // Fix-47: step is a creator/owner/builder/admin-only op — authenticate.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/step`,
      headers: auth(owner.token),
      payload: { n: 5 },
    });

    const res = await command(simId, builder.token, { deviceId: hvacId, commandName: 'turn-on' });
    expect(res.statusCode).toBe(200);

    const entries = ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command' });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.actor_id).toBe(builder.id); // the ACTUAL operator
    expect(entry.proposal_id).toBeNull();
    expect(entry.sim_time).toBeGreaterThanOrEqual(5);
    const payload = JSON.parse(entry.payload_json) as Record<string, unknown>;
    expect(payload.deviceId).toBe(hvacId);
    expect(payload.commandName).toBe('turn-on');
    // before/after are the device's runtime state around the command.
    expect((payload.before as Record<string, unknown>).power ?? false).toBe(false);
    expect(payload.after).toMatchObject({ power: true });
  });

  it('failed commands are NOT logged; replays turn logged commands into events', async () => {
    const simId = await createEnvSim(owner.token);
    const from = new Date(Date.now() - 60_000).toISOString();

    // A failed command (unknown command) leaves no audit entry.
    const bad = await command(simId, builder.token, { deviceId: hvacId, commandName: 'self-destruct' });
    expect(bad.statusCode).toBe(400);
    expect(ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command' })).toHaveLength(0);

    // Two users "fight" over the same AC — both commands are attributable.
    await command(simId, builder.token, { deviceId: hvacId, commandName: 'turn-on' });
    await command(simId, owner.token, { deviceId: hvacId, commandName: 'turn-off' });
    const entries = ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command' });
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.actor_id).sort()).toEqual([builder.id, owner.id].sort());

    // End-to-end: the logged commands feed the replay pipeline (P0-2).
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: { from, to: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(replay.statusCode).toBe(200);
    const report = replay.json().report;
    expect(report.commandEvents).toBeGreaterThan(0);
    expect(report.eventCount).toBeGreaterThan(0);
    const events = replay.json().scenario.events as Array<Record<string, unknown>>;
    expect(events.some(event => event.type === 'device-command-replay')).toBe(true);
  });

  it('command-log: members get a scoped audit view, the owner the full log (Fix-9)', async () => {
    // A builder-owned device (direct store insert — the HTTP create path
    // would detour through the proposal pipeline, irrelevant here). An agent
    // must manage it for commands to land.
    const buildersLamp = ctx.app.envStore.createDevice({
      envId,
      ownerId: builder.id,
      name: 'Builder Lamp',
      type: 'smart-light',
      capabilities: ['turn-on', 'turn-off'],
      zoneId: 'zone-a',
    });
    const lampAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Lamp Keeper', capabilities: ['turn-on'], boundDeviceIds: [buildersLamp.id] },
    });
    expect(lampAgent.statusCode).toBe(201);

    const simId = await createEnvSim(owner.token);
    // Three audited commands: owner → builder's lamp, builder → owner's hvac,
    // owner → owner's hvac.
    await command(simId, owner.token, { deviceId: buildersLamp.id, commandName: 'turn-on' });
    await command(simId, builder.token, { deviceId: hvacId, commandName: 'turn-on' });
    await command(simId, owner.token, { deviceId: hvacId, commandName: 'turn-off' });

    const commandLog = (token: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/command-log?kind=device-command`,
        headers: auth(token),
      });

    // Owner: the full log.
    const asOwner = await commandLog(owner.token);
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json().entries).toHaveLength(3);

    // Builder: their own action + commands targeting THEIR device — even when
    // the actor was someone else ("越权做得到、审计看得见") — but NOT the
    // owner-on-owner-device entry.
    const asBuilder = await commandLog(builder.token);
    expect(asBuilder.statusCode).toBe(200);
    const builderEntries = asBuilder.json().entries as Array<{
      actor: { id: string };
      payload: { deviceId: string };
    }>;
    expect(builderEntries).toHaveLength(2);
    expect(builderEntries.map(e => e.payload.deviceId).sort()).toEqual(
      [buildersLamp.id, hvacId].sort(),
    );
    const lampEntry = builderEntries.find(e => e.payload.deviceId === buildersLamp.id)!;
    expect(lampEntry.actor.id).toBe(owner.id); // who commanded MY device

    // Viewer: member, but nothing relates to them → empty scoped view.
    const asViewer = await commandLog(viewer.token);
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json().entries).toHaveLength(0);

    // Stranger: not a member → still 403.
    expect((await commandLog(stranger.token)).statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Error semantics
  // -------------------------------------------------------------------------

  it('distinguishes unknown device (404) from unmanaged device (409)', async () => {
    // An env device that no agent manages.
    const free = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Free Lamp', type: 'smart-light', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });
    expect(free.statusCode).toBe(201);

    const simId = await createEnvSim(owner.token);

    const ghost = await command(simId, owner.token, { deviceId: 'ghost-device', commandName: 'turn-on' });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('DEVICE_NOT_FOUND');
    expect(ghost.json().error.message).toContain('ghost-device');

    const unmanaged = await command(simId, owner.token, { deviceId: free.json().id, commandName: 'turn-on' });
    expect(unmanaged.statusCode).toBe(409);
    expect(unmanaged.json().error.code).toBe('DEVICE_NOT_MANAGED');
    expect(unmanaged.json().error.message).toContain('no agent manages');
  });

  it('Fix-18 (R7 F-03): a device managed only AFTER sim creation gets the recreate hint', async () => {
    // Unmanaged at sim-creation time — the snapshot freezes that world.
    const free = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Late Lamp', type: 'smart-light', capabilities: ['turn-on'], zoneId: 'zone-a' },
    });
    expect(free.statusCode).toBe(201);
    const simId = await createEnvSim(owner.token);

    // The world moves on: an agent now manages the device.
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Late Keeper', capabilities: ['turn-on'], boundDeviceIds: [free.json().id] },
    });
    expect(agent.statusCode).toBe(201);

    // The 409 names the way out: recreate the simulation.
    const res = await command(simId, owner.token, { deviceId: free.json().id, commandName: 'turn-on' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DEVICE_NOT_MANAGED');
    expect(res.json().error.message).toContain('frozen snapshot');
    expect(res.json().error.message).toContain('recreate the simulation');
  });

  it('unknown command on a managed device is a 400 (single error layer)', async () => {
    const simId = await createEnvSim(owner.token);
    const res = await command(simId, owner.token, { deviceId: hvacId, commandName: 'self-destruct' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_COMMAND');
    expect(res.json().error.message).toContain('self-destruct');
  });

  // T80 (R9, u2-F1): the sim command lane runs the ONE command-equivalence
  // judgment (resolveCommandEquivalence against the device's executable
  // face). R9's field device (a monitoring-only sensor) happily "executed"
  // temperature-control / set-temperature / turn-on and dressed the sensor
  // READING up as a control result — a fake success on the operator's face.
  it('T80: a lexically-near but unsupported command is a 400 honest refusal, metered as a denial — never a fake success', async () => {
    const simId = await createEnvSim(owner.token);

    // 'temperature-control' on a reading-only face: not verbatim, and the
    // temperature-family equivalence finds no setter on the face → refused
    // with the surface named (the teaching message IS the remediation).
    const near = await command(simId, owner.token, { deviceId: sensorId, commandName: 'temperature-control' });
    expect(near.statusCode).toBe(400);
    expect(near.json().error.code).toBe('UNKNOWN_COMMAND');
    expect(near.json().error.message).toContain('temperature-control');
    expect(near.json().error.message).toContain('temperature-reading');

    // 'set-temperature' is the temperature-family ask — same refusal on a
    // face that has no temperature SETTER (this is the u2 device's case).
    const family = await command(simId, owner.token, { deviceId: sensorId, commandName: 'set-temperature' });
    expect(family.statusCode).toBe(400);
    expect(family.json().error.code).toBe('UNKNOWN_COMMAND');

    // Failure metering: the refused attempts land as device-command-denied
    // audit rows and NEVER as executed device-command rows.
    expect(ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command' })).toHaveLength(0);
    const denials = ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command-denied' });
    expect(denials.length).toBe(2);

    // The honest positives survive: the verbatim face reads, and the
    // temperature-family ask resolves against a face that DECLARES a setter.
    const verbatim = await command(simId, owner.token, { deviceId: sensorId, commandName: 'temperature-reading' });
    expect(verbatim.statusCode).toBe(200);
    expect(verbatim.json().success).toBe(true);

    const hvacSet = await command(simId, owner.token, {
      deviceId: hvacId, commandName: 'set-temperature', params: { temperature: 20 },
    });
    expect(hvacSet.statusCode).toBe(200);
    expect(hvacSet.json().success).toBe(true);
    // ...and the executed commands are audited as before (denials + 2 executes).
    expect(ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command' })).toHaveLength(2);
  });

  it('rename traps get a teaching 400: command→commandName, payload/args→params (T-001)', async () => {
    const simId = await createEnvSim(owner.token);

    // `command` is a common name for commandName (TASK-004).
    const wrongCommand = await command(simId, owner.token, {
      deviceId: hvacId,
      command: 'turn-on',
    });
    expect(wrongCommand.statusCode).toBe(400);
    expect(wrongCommand.json().error.message).toContain('"command"');
    expect(wrongCommand.json().error.message).toContain('"commandName"');

    // `payload` and `args` (T-001) are common names for params. Without the
    // hint, a parameterized command would run parameterless — e.g.
    // set-brightness with no level silently no-ops — instead of 400.
    for (const alias of ['payload', 'args']) {
      const res = await command(simId, owner.token, {
        deviceId: hvacId,
        commandName: 'turn-on',
        [alias]: { level: 3 },
      });
      expect(res.statusCode, `alias ${alias}`).toBe(400);
      expect(res.json().error.message).toContain(`"${alias}"`);
      expect(res.json().error.message).toContain('"params"');
    }
  });
});

describe('sim device commands — hass:// ownership (Fix-9, R4-P1)', () => {
  let ctx: TestAppContext | undefined;
  let mock: MockHassServer | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
    await mock?.close();
    mock = undefined;
  });

  it('sandbox rule: members drive any SIM device, but a hass:// device obeys only its owner', async () => {
    mock = await MockHassServer.start();
    ctx = await makeTestApp({
      hassUrl: mock.url,
      hassToken: 'test-token',
      // Connectivity assertion: the owner's command must actually reach HA.
      hassDefaultPolicy: 'allow',
    });
    const app = ctx.app;
    const owner = await registerUser(app, { displayName: 'Owner' });
    const builder = await registerUser(app, { displayName: 'Builder' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('hass-ownership-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    const hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;
    await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });

    // The owner binds a REAL light through the hass:// bridge (zone-a is
    // managed by the imported lab agent, so the light is commandable).
    const light = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Real Light', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a' },
    });
    expect(light.statusCode).toBe(201);
    const lightId = light.json().id as string;
    const bound = await app.inject({
      method: 'PATCH',
      url: `/api/devices/${lightId}`,
      headers: auth(owner.token),
      payload: { binding: 'hass://light.living_room' },
    });
    expect(bound.statusCode).toBe(200);
    // An agent must MANAGE the light for commands to reach it at all.
    const lightAgent = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Light Keeper', capabilities: ['lighting-control'], boundDeviceIds: [lightId] },
    });
    expect(lightAgent.statusCode).toBe(201);

    const sim = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;

    const command = (token: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/api/simulations/${simId}/commands`,
        headers: auth(token),
        payload,
      });

    // Sandbox semantics: a builder MAY drive the owner's sim:// device.
    const simDevice = await command(builder.token, { deviceId: hvacId, commandName: 'turn-on' });
    expect(simDevice.statusCode).toBe(200);
    expect(simDevice.json().success).toBe(true);

    // Hard exception: the hass://-bound device refuses the non-owner…
    const foreign = await command(builder.token, { deviceId: lightId, commandName: 'turn-on' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('FORBIDDEN');
    expect(foreign.json().error.message).toContain('real hardware');
    expect(foreign.json().error.message).toContain('only the device owner');
    expect(mock.serviceCalls).toHaveLength(0); // nothing reached real hardware

    // …but obeys its owner — the command bridges to (mock) HA for real.
    const byOwner = await command(owner.token, { deviceId: lightId, commandName: 'turn-on' });
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().success).toBe(true);
    expect(mock.serviceCalls).toEqual([
      { domain: 'light', service: 'turn_on', target: { entity_id: 'light.living_room' } },
    ]);
  });
});
