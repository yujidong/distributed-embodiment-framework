/**
 * @vitest-environment node
 *
 * Sandbox fork tests (P-C, multi-user-simulation-design.md §3 Layer 0, §11).
 *
 * Covers the acceptance paths:
 * - fork the pure base layer (`overlays: []` — no proposal events);
 * - fork with a selected overlay (map-event filtering by proposal id prefix);
 * - invalid overlay ids → 400;
 * - the sandboxes_per_user_per_env quota → 429;
 * - stop releases the registry instance (idempotent, permission matrix);
 * - isolation: a device command inside the sandbox never touches the shared
 *   environment store;
 * - environment deletion cascades: sandbox runtimes stopped, rows gone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseMapData } from './db/environment-store.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('sandboxes (P-C sandbox fork)', () => {
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
        name: 'Sandbox Lab',
        visibility: 'public',
        mapData: {
          zones: [
            { id: 'zone-a', bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 } },
            { id: 'zone-b' },
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

  afterEach(async () => {
    await ctx.cleanup();
  });

  function fork(token: string, body: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(token),
      payload: body,
    });
  }

  function listSandboxes(token: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/sandboxes`,
      headers: auth(token),
    });
  }

  function stopSandbox(token: string, sandboxId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/sandboxes/${sandboxId}/stop`,
      headers: auth(token),
    });
  }

  // T-015: by-id sim reads follow Fix-47 — a sandbox fork belongs to its
  // creator, so read it as the fork owner (was anonymous before any read gate).
  function simSnapshot(simulationId: string, token: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simulationId}/snapshot`,
      headers: auth(token),
    });
  }

  /** Submit + owner-approve a proposal; returns the final row. */
  async function applyProposal(kind: string, payload: Record<string, unknown>) {
    const submitted = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: { kind, payload },
    });
    expect(submitted.statusCode).toBe(201);
    const proposal = submitted.json();
    expect(proposal.status).toBe('escalated');
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/proposals/${proposal.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'approved' },
    });
    expect(decided.json().status).toBe('applied');
    return decided.json();
  }

  function injectScenarioPayload(eventId: string, zoneId: string) {
    return {
      events: [
        { id: eventId, type: 'fire-alarm', zoneId, severity: 'high', atSimTimeSec: 60 },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Fork semantics: base layer vs overlays
  // -------------------------------------------------------------------------

  it('forks the pure base layer with overlays: [] (proposal events excluded)', async () => {
    const applied = await applyProposal('inject-scenario', injectScenarioPayload('fire-drill', 'zone-a'));

    const res = await fork(builder.token, { overlays: [] });
    expect(res.statusCode).toBe(201);
    const sandbox = res.json();
    expect(sandbox.status).toBe('active');
    expect(sandbox.envId).toBe(envId);
    expect(sandbox.owner.id).toBe(builder.id);
    // P2F §10.4: forkBase carries the lineage material (policy + the
    // fork-moment scenario fingerprint) alongside the overlay selection.
    expect(sandbox.forkBase.overlays).toEqual([]);
    expect(sandbox.forkBase.policy).toEqual({ scheduling: 'tick' });
    expect(sandbox.forkBase.scenarioFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const snapshot = await simSnapshot(sandbox.simulationId, builder.token);
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().scenarioId).toBe(envId);
    expect(snapshot.json().scheduledEvents).toEqual([]);

    // The shared world still carries the injected event.
    const env = ctx.app.envStore.getEnvironment(envId)!;
    expect((parseMapData(env).events ?? []).map(event => event.id)).toEqual([
      `${applied.id}:fire-drill`,
    ]);
  });

  it('forks with a selected overlay and filters map events by proposal prefix', async () => {
    const drillA = await applyProposal('inject-scenario', injectScenarioPayload('drill-a', 'zone-a'));
    const drillB = await applyProposal('inject-scenario', injectScenarioPayload('drill-b', 'zone-b'));

    const res = await fork(builder.token, { overlays: [drillA.id] });
    expect(res.statusCode).toBe(201);
    const snapshot = await simSnapshot(res.json().simulationId, builder.token);
    expect(snapshot.json().scheduledEvents.map((event: { id: string }) => event.id)).toEqual([
      `${drillA.id}:drill-a`,
    ]);

    // No overlays field at all → the world as-is (both overlays' events).
    const all = await fork(builder.token);
    expect(all.statusCode).toBe(201);
    expect(all.json().forkBase.overlays).toBeNull();
    expect(all.json().forkBase.policy).toEqual({ scheduling: 'tick' });
    const allSnapshot = await simSnapshot(all.json().simulationId, builder.token);
    expect(allSnapshot.json().scheduledEvents.map((event: { id: string }) => event.id).sort()).toEqual(
      [`${drillA.id}:drill-a`, `${drillB.id}:drill-b`].sort(),
    );
  });

  it('rejects invalid overlay ids with 400', async () => {
    // Unknown id.
    expect((await fork(builder.token, { overlays: ['no-such-proposal'] })).statusCode).toBe(400);

    // A proposal that exists but is not APPLIED (still escalated).
    const pending = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(builder.token),
      payload: { kind: 'inject-scenario', payload: injectScenarioPayload('pending', 'zone-a') },
    });
    expect(pending.json().status).toBe('escalated');
    const notApplied = await fork(builder.token, { overlays: [pending.json().id] });
    expect(notApplied.statusCode).toBe(400);

    // An applied proposal of the WRONG kind (install-devices).
    const installed = await applyProposal('install-devices', {
      devices: [
        { name: 'Corridor Sensor', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
      ],
    });
    expect((await fork(builder.token, { overlays: [installed.id] })).statusCode).toBe(400);

    // Malformed overlays field.
    expect((await fork(builder.token, { overlays: 'not-an-array' })).statusCode).toBe(400);
    expect((await fork(builder.token, { overlays: [42] })).statusCode).toBe(400);
  });

  it('rejects unknown body fields instead of dropping them silently (T-001)', async () => {
    // {name, speed} used to vanish — the fork succeeded with no name and the
    // default pace, the classic "I asked for X and got defaults" trap.
    const res = await fork(builder.token, { overlays: [], speed: 10, name: 'stress-test' });
    expect(res.statusCode).toBe(400);
    const message = res.json().error.message as string;
    // Both unknown fields are named, and the accepted list is given.
    expect(message).toContain('"speed"');
    expect(message).toContain('"name"');
    expect(message).toContain('"overlays"');
    // The hint must teach where pace is actually set: on the forked
    // simulation itself (it starts in state "created").
    expect(message).toContain('/api/simulations/');
    expect(message).toContain('start');
  });

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  it('follows environment read-access semantics: members fork, strangers on private envs cannot', async () => {
    // Public env: any authenticated user (even a non-member stranger) may fork.
    expect((await fork(stranger.token)).statusCode).toBe(201);
    // A viewer member may fork (same gate as running an env simulation).
    expect((await fork(viewer.token)).statusCode).toBe(201);

    // Anonymous is rejected outright.
    const anon = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/sandboxes`,
      payload: {},
    });
    expect(anon.statusCode).toBe(401);

    // Private env: non-members get 403.
    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private Lab', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    const privateFork = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${privateEnv.json().id}/sandboxes`,
      headers: auth(stranger.token),
      payload: {},
    });
    expect(privateFork.statusCode).toBe(403);
  });

  it('lists sandboxes: users see their own, the environment owner sees all', async () => {
    await fork(builder.token);
    await fork(owner.token);

    const asBuilder = await listSandboxes(builder.token);
    expect(asBuilder.statusCode).toBe(200);
    expect(asBuilder.json().sandboxes).toHaveLength(1);
    expect(asBuilder.json().sandboxes[0].owner.id).toBe(builder.id);

    const asOwner = await listSandboxes(owner.token);
    expect(asOwner.json().sandboxes).toHaveLength(2);

    const asViewer = await listSandboxes(viewer.token);
    expect(asViewer.json().sandboxes).toHaveLength(0);

    // Unknown environment → 404.
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments/no-such-env/sandboxes',
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  it('enforces the sandboxes_per_user_per_env quota (429), released by stop', async () => {
    const small = await makeTestApp({ quotaMaxSandboxesPerUserPerEnv: 1 });
    try {
      const qOwner = await registerUser(small.app, { displayName: 'QOwner' });
      const env = await small.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(qOwner.token),
        payload: { name: 'Quota Lab', mapData: { zones: [{ id: 'zone-a' }] } },
      });
      const qEnvId = env.json().id;

      const first = await small.app.inject({
        method: 'POST',
        url: `/api/environments/${qEnvId}/sandboxes`,
        headers: auth(qOwner.token),
        payload: {},
      });
      expect(first.statusCode).toBe(201);

      const second = await small.app.inject({
        method: 'POST',
        url: `/api/environments/${qEnvId}/sandboxes`,
        headers: auth(qOwner.token),
        payload: {},
      });
      expect(second.statusCode).toBe(429);
      expect(second.json().error.code).toBe('QUOTA_EXCEEDED');
      expect(second.json().error.quota).toBe('sandboxes_per_user_per_env');
      expect(second.json().error.limit).toBe(1);

      // Stopping the first fork releases the slot.
      const stopped = await small.app.inject({
        method: 'POST',
        url: `/api/sandboxes/${first.json().id}/stop`,
        headers: auth(qOwner.token),
      });
      expect(stopped.statusCode).toBe(200);
      const third = await small.app.inject({
        method: 'POST',
        url: `/api/environments/${qEnvId}/sandboxes`,
        headers: auth(qOwner.token),
        payload: {},
      });
      expect(third.statusCode).toBe(201);
    } finally {
      await small.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Stop lifecycle
  // -------------------------------------------------------------------------

  it('stop releases the registry instance, is idempotent, and is owner-gated', async () => {
    const created = await fork(builder.token);
    const sandbox = created.json();
    expect(ctx.app.simulations.has(sandbox.simulationId)).toBe(true);

    // A stranger may not stop someone else's sandbox.
    expect((await stopSandbox(stranger.token, sandbox.id)).statusCode).toBe(403);

    const stopped = await stopSandbox(builder.token, sandbox.id);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().status).toBe('stopped');
    expect(ctx.app.simulations.has(sandbox.simulationId)).toBe(false);
    expect((await simSnapshot(sandbox.simulationId, builder.token)).statusCode).toBe(404);

    // Idempotent; the environment owner may stop too.
    expect((await stopSandbox(builder.token, sandbox.id)).statusCode).toBe(200);

    const other = (await fork(builder.token)).json();
    const byOwner = await stopSandbox(owner.token, other.id);
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().status).toBe('stopped');

    // Unknown sandbox → 404.
    expect((await stopSandbox(owner.token, 'no-such-sandbox')).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  it('device state changes inside the sandbox never touch the shared environment store', async () => {
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Shared HVAC',
        type: 'hvac',
        capabilities: ['temperature-control', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    });
    expect(device.statusCode).toBe(201);
    const deviceId = device.json().id;
    // Device commands route through a managing agent — bind one.
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Lab Agent',
        capabilities: ['temperature-control'],
        boundDeviceIds: [deviceId],
        managedZoneIds: ['zone-a'],
      },
    });
    expect(agent.statusCode).toBe(201);

    const envBefore = ctx.app.envStore.getEnvironment(envId)!;
    const deviceBefore = ctx.app.envStore.getDevice(deviceId)!;
    const detailBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });

    const sandbox = (await fork(builder.token)).json();
    // S2 (device privacy): the fork COPIES full device state (physics
    // fidelity), but the builder READS the owner's device through the coarse
    // seam — the on/off signal is the honest observable here.
    const stateBefore = (await simSnapshot(sandbox.simulationId, builder.token)).json()
      .devices.find((d: { id: string }) => d.id === deviceId);
    expect(stateBefore.stateRedacted).toBe(true);
    const command = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sandbox.simulationId}/commands`,
      headers: auth(builder.token),
      payload: { deviceId, commandName: 'turn-on' },
    });
    expect(command.statusCode).toBe(200);
    expect(command.json().success).toBe(true);

    // The sandbox world DID change (the command ran against the fork)…
    const stateAfter = (await simSnapshot(sandbox.simulationId, builder.token)).json()
      .devices.find((d: { id: string }) => d.id === deviceId);
    expect(stateAfter.status).toBe('on');

    // …and the shared environment storage is byte-identical.
    expect(ctx.app.envStore.getEnvironment(envId)).toEqual(envBefore);
    expect(ctx.app.envStore.getDevice(deviceId)).toEqual(deviceBefore);
    const detailAfter = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    // T129 (R21-F1): `worldSession.asOf`/`simTimeSec` are the LIVE world's
    // clock face — the catch-up advance is decoupled from the caller (it
    // completes on the background chain), so two reads at different wall
    // moments may legitimately straddle an advance. The S2 contract here is
    // "the fork wrote nothing to SHARED ENV STORAGE" — byte-compare
    // everything except the moving clock face; identity + status stay pinned.
    const beforeBody = detailBefore.json() as Record<string, unknown>;
    const afterBody = detailAfter.json() as Record<string, unknown>;
    const { worldSession: _beforeClock, ...storageBefore } = beforeBody;
    const { worldSession: _afterClock, ...storageAfter } = afterBody;
    expect(storageAfter).toEqual(storageBefore);
    expect(afterBody.worldSession).toMatchObject({
      simulationId: (beforeBody.worldSession as { simulationId: string }).simulationId,
      status: (beforeBody.worldSession as { status: string }).status,
    });
  });

  // -------------------------------------------------------------------------
  // S2 (device privacy): fork reads gate foreign device detail
  // -------------------------------------------------------------------------

  it('S2: fork creation copies full state, but fork reads gate foreign devices coarse', async () => {
    // Owner device (foreign to the fork creator) carrying telemetry.
    const ownerDevice = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner Meter',
        type: 'meter',
        capabilities: ['energy-monitoring'],
        zoneId: 'zone-a',
        initialState: { power: true, cumulativeEnergyWh: 4321.5 },
      },
    });
    expect(ownerDevice.statusCode).toBe(201);
    const ownerDeviceId = ownerDevice.json().id as string;

    // Builder device via the governed path (install-devices proposal).
    const builderProposal = await applyProposal('install-devices', {
      devices: [{
        name: 'Builder Sensor',
        type: 'sensor',
        capabilities: ['temperature-sensing'],
        zoneId: 'zone-b',
        initialState: { temperature: 21.5, unit: 'C' },
      }],
    });
    expect(builderProposal.status).toBe('applied');
    const builderDeviceId = (builderProposal.createdIds.devices as string[])[0];

    const sandbox = (await fork(builder.token)).json();
    expect(sandbox.simulationId).toBeTruthy();

    // The FORK CREATOR reads the fork: their own device full, the owner's
    // coarse (state emptied + self-labeled; the reading never rides the
    // snapshot even though the fork's physics runs on it).
    const snapshot = (await simSnapshot(sandbox.simulationId, builder.token)).json();
    const mine = snapshot.devices.find((d: { id: string }) => d.id === builderDeviceId);
    expect(mine.stateRedacted).toBeUndefined();
    expect(mine.state.temperature).toBe(21.5);
    const foreign = snapshot.devices.find((d: { id: string }) => d.id === ownerDeviceId);
    expect(foreign.stateRedacted).toBe(true);
    expect(foreign.state).toEqual({});
    expect(foreign.status).toBe('on'); // { power: true } is honestly coarse
    expect(JSON.stringify(foreign)).not.toContain('4321.5');
    expect(JSON.stringify(foreign)).not.toContain('cumulativeEnergyWh');

    // P2F §10.2: the ENV OWNER is the governance principal over every fork
    // of their world (implicit fork 'owner' role) — they read the fork's
    // world surfaces; a stranger still cannot.
    const ownerRead = await simSnapshot(sandbox.simulationId, owner.token);
    expect(ownerRead.statusCode).toBe(200);
    const stranger = await registerUser(ctx.app, { displayName: 'Fork Stranger' });
    expect((await simSnapshot(sandbox.simulationId, stranger.token)).statusCode).toBe(403);

    // The registry record carries the fork marker (read-side seam anchor).
    const record = ctx.app.simulations.getOrThrow(sandbox.simulationId);
    expect(record.sourceEnvId).toBe(envId);
    expect(record.environmentId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Environment deletion cascade
  // -------------------------------------------------------------------------

  it('deleting the environment stops its sandboxes and removes their rows', async () => {
    const sandbox = (await fork(builder.token)).json();
    expect(ctx.app.simulations.has(sandbox.simulationId)).toBe(true);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);

    expect(ctx.app.simulations.has(sandbox.simulationId)).toBe(false);
    expect(ctx.app.sandboxStore.get(sandbox.id)).toBeUndefined();
    expect((await stopSandbox(builder.token, sandbox.id)).statusCode).toBe(404);
  });
});
