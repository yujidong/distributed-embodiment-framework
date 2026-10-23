/**
 * @vitest-environment node
 *
 * T-401 (DevLoop R19, CC-F01): the authoritative world session executes REAL
 * shared-world effects, so the Fix-9 sandbox exemption ("members may drive
 * ANY device in a sim — it never writes back") must NOT apply to it. The
 * command gate on world sessions (`envSession === true`):
 *
 * - a builder driving ANOTHER user's device → 403 naming the device, its
 *   owner, and the sanctioned cross-tenant lane (agreement invocations);
 * - the device owner, the env owner, and an admin all pass;
 * - PRIVATE sims of the same env keep Fix-9 any-device semantics;
 * - command_log audit rows are unchanged: a 403d command never reaches the
 *   audit lane; an allowed one lands exactly one `device-command` row.
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

describe('T-401: world-session device-command ownership gate', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let admin: TestUser;
  let envId: string;
  /** 'HVAC B' from the import — owned by the env creator (owner). */
  let ownerDeviceId: string;
  /** Builder-owned twin installed directly in env rows (pre-session). */
  let builderDeviceId: string;
  let sessionSimId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ adminEmails: ['admin@example.com'] });
    owner = await registerUser(ctx.app, { displayName: 'Env Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder B' });
    admin = await registerUser(ctx.app, { email: 'admin@example.com', displayName: 'Admin' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('gate-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    ownerDeviceId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });

    // The builder's own asset: a device + a managing agent, owned by the
    // builder. R73: the session AUTO-STARTS at env creation, so the rows
    // can no longer precede the materialization — instead they land in the
    // live world through the same topology rebuild a device-install API
    // call triggers (env rows are the durable truth; onWorldMutation
    // refreshes the session from them).
    const builderDevice = ctx.app.envStore.createDevice({
      envId,
      ownerId: builder.id,
      name: 'Builder HVAC',
      type: 'hvac',
      capabilities: ['turn-on', 'turn-off'],
      zoneId: 'zone-b',
    });
    builderDeviceId = builderDevice.id;
    ctx.app.envStore.createAgent({
      envId,
      ownerId: builder.id,
      name: 'Builder Agent',
      capabilities: ['temperature-control'],
      boundDeviceIds: [builderDevice.id],
      managedZoneIds: ['zone-b'],
    });

    // Rebuild the (auto-started) authoritative world session from the
    // current rows — the builder's device must be IN the world for the
    // ownership gate to be exercisable on it.
    await ctx.app.worldSessions.onWorldMutation(envId, { create: false });
    sessionSimId = `sim-${envId}-world-session`;
    expect(ctx.app.simulations.get(sessionSimId)).toBeDefined();
    expect(
      ctx.app.simulations.get(sessionSimId)!.runtime.getSnapshot()
        .devices.some(device => device.id === builderDeviceId),
    ).toBe(true);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function command(simId: string, token: string, deviceId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(token),
      payload: { deviceId, commandName: 'turn-on' },
    });
  }

  function deviceCommandRows() {
    return ctx.app.commandLogStore.listForEnv(envId, { kind: 'device-command' });
  }

  it('a builder driving the owner-owned device on the WORLD session is 403 with the lane hint', async () => {
    const res = await command(sessionSimId, builder.token, ownerDeviceId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    const message: string = res.json().error.message;
    // Names the device, its owner (display name), the authority, and the
    // sanctioned cross-tenant lane.
    expect(message).toContain('HVAC B');
    expect(message).toContain('Env Owner');
    expect(message).toContain('world session');
    expect(message).toContain('POST /api/agreements/:id/invocations');
    // The refused command never reaches the audit lane.
    expect(deviceCommandRows()).toHaveLength(0);
  });

  it('the device owner, the env owner, and an admin all pass on the world session', async () => {
    // Builder on OWN device.
    const own = await command(sessionSimId, builder.token, builderDeviceId);
    expect(own.statusCode).toBe(200);
    expect(own.json().success).toBe(true);

    // Env owner on the builder's device (FM-F05 remediation half).
    const envOwner = await command(sessionSimId, owner.token, builderDeviceId);
    expect(envOwner.statusCode).toBe(200);
    expect(envOwner.json().success).toBe(true);

    // Admin on the owner's device.
    const asAdmin = await command(sessionSimId, admin.token, ownerDeviceId);
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().success).toBe(true);

    // Audit contract unchanged: one device-command row per executed command.
    expect(deviceCommandRows()).toHaveLength(3);
  });

  it('the same builder command against a PRIVATE fork of the env keeps Fix-9 semantics (200)', async () => {
    const fork = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(builder.token),
      payload: { environmentId: envId },
    });
    expect(fork.statusCode).toBe(201);
    const forkId = fork.json().id as string;
    expect(forkId).not.toBe(sessionSimId);

    const res = await command(forkId, builder.token, ownerDeviceId);
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    // The fork's command IS audited (env-backed sim, Fix-1) — the gate is
    // about the world session only, not about auditing.
    expect(deviceCommandRows()).toHaveLength(1);
  });
});
