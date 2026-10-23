/**
 * @vitest-environment node
 *
 * R46 P0-2 — device-command organization boundary (设备命令组织边界).
 *
 * The world session got its ownership gate in T-401, but the sim channel
 * kept Fix-9's any-device sandbox: inside an environment-backed simulation
 * a builder could operate ANY device (供电局开了水务的阀门, 200). The gate
 * on POST /api/simulations/:id/commands (env-backed sims):
 *
 * - another member's device → 403 with a teaching message (device, owner,
 *   the sanctioned lanes: active agreement / ownership-transfer proposal);
 * - one's OWN device → 200;
 * - IMPORTER-owned devices stay shared-sandbox for builders → 200;
 * - the env owner and admins pass on any device (world-session parity);
 * - an ACTIVE agreement (consumer = caller, provider agent manages the
 *   device) opens the lane → 200 — and a HELD agreement does not (the
 *   consumer's own circuit-breaker pause suspends the authorization).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Same multi-stakeholder mini-city as the P0-1 suite, plus the unassigned
 *  coordinator's screen (an importer-owned MANAGED device). */
function cityScenario() {
  return {
    version: '1.0',
    meta: { id: 'mini-city', name: 'Mini City', description: 'R46 P0-2 fixture' },
    zones: [
      { id: 'zone-power', adjacentZoneIds: ['zone-water'] },
      { id: 'zone-water', adjacentZoneIds: ['zone-power'] },
    ],
    devices: [
      {
        id: 'grid-monitor-1',
        name: '电网监测终端 1',
        type: 'electric-grid-monitor',
        capabilities: ['grid-reading'],
        zoneId: 'zone-power',
      },
      {
        id: 'pump-valve-1',
        name: '排涝智能阀 1',
        type: 'smart-valve',
        capabilities: ['turn-on', 'turn-off'],
        zoneId: 'zone-water',
      },
      {
        id: 'coord-screen-1',
        name: '应急指挥屏 1',
        type: 'light',
        capabilities: ['turn-on', 'turn-off'],
        zoneId: 'zone-power',
      },
    ],
    agents: [
      {
        id: 'power-keeper',
        name: '宝安工业带·110kV 变电站管家',
        capabilities: ['grid-reading'],
        managesZoneIds: ['zone-power'],
        boundDeviceIds: ['grid-monitor-1'],
      },
      {
        id: 'pump-keeper',
        name: '宝安工业带·雨水泵站管家',
        capabilities: ['valve-control'],
        managesZoneIds: ['zone-water'],
        boundDeviceIds: ['pump-valve-1'],
      },
      {
        id: 'city-coordinator',
        name: '市应急管理局',
        capabilities: ['lighting-control'],
        managesZoneIds: ['zone-power'],
        boundDeviceIds: ['coord-screen-1'],
      },
    ],
    events: [],
  };
}

describe('R46 P0-2: device-command org boundary on env-backed sims', () => {
  let ctx: TestAppContext;
  let importer: TestUser;
  let power: TestUser;
  let water: TestUser;
  let admin: TestUser;
  let envId: string;
  let simId: string;
  let gridMonitorId: string;
  let pumpValveId: string;
  let coordScreenId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ adminEmails: ['admin@example.com'] });
    importer = await registerUser(ctx.app, { displayName: 'Importer' });
    power = await registerUser(ctx.app, { email: 'power@sz.gov.cn', displayName: 'Power Bureau' });
    water = await registerUser(ctx.app, { email: 'water@sz.gov.cn', displayName: 'Water Bureau' });
    admin = await registerUser(ctx.app, { email: 'admin@example.com', displayName: 'Admin' });

    // The R46 P0-1 flow: invite + assign at import time, so the orgs own
    // their assets before any rehearsal starts.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(importer.token),
      payload: {
        ...cityScenario(),
        visibility: 'private',
        invites: [
          { email: 'power@sz.gov.cn' },
          { email: 'water@sz.gov.cn' },
        ],
        ownerAssignment: {
          agents: [
            { agentNamePattern: '变电站', toUserEmail: 'power@sz.gov.cn' },
            { agentNamePattern: '泵站', toUserEmail: 'water@sz.gov.cn' },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    const device = (name: string): string =>
      (created.json().devices as Array<{ id: string; name: string }>)
        .find(d => d.name === name)!.id;
    gridMonitorId = device('电网监测终端 1');
    pumpValveId = device('排涝智能阀 1');
    coordScreenId = device('应急指挥屏 1');

    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(importer.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function command(token: string, deviceId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(token),
      payload: { deviceId, commandName: 'turn-on' },
    });
  }

  it("water drives its own pump valve (200) but NOT the power bureau's grid monitor (403, teaching)", async () => {
    const own = await command(water.token, pumpValveId);
    expect(own.statusCode).toBe(200);
    expect(own.json().success).toBe(true);

    const foreign = await command(water.token, gridMonitorId);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('FORBIDDEN');
    const message: string = foreign.json().error.message;
    // Names the device, its owner, and the sanctioned cross-org lanes.
    expect(message).toContain('电网监测终端 1');
    expect(message).toContain('Power Bureau');
    expect(message).toContain('agreements');
    expect(message).toContain('ownership-transfer');
  });

  it('R49: a denied cross-org attempt lands in the audit trail (command_log → activity feed)', async () => {
    // The negative samples matter as much as the executed ones: an owner
    // reviewing "who tried to touch my devices" is a governance surface.
    const denied = await command(water.token, gridMonitorId);
    expect(denied.statusCode).toBe(403);

    const activity = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/activity?limit=50`,
      headers: auth(importer.token),
    });
    expect(activity.statusCode).toBe(200);
    const entries = activity.json().entries as Array<{ summary: string; kind: string }>;
    const denial = entries.find(e => e.summary.includes('device-command-denied'));
    expect(denial).toBeDefined();
    expect(denial!.summary).toContain('电网监测终端 1');
    // The executed turn-on of the OWN valve is audited alongside.
    expect(entries.some(e => e.summary.includes('device-command'))).toBe(true);
  });

  it('importer-owned devices stay shared-sandbox for builders (200)', async () => {
    // The coordinator was never reassigned, so their screen is still the
    // importer's — an unassigned asset every builder may rehearse on.
    const res = await command(water.token, coordScreenId);
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('the env owner and admins pass on any device (world-session parity)', async () => {
    const byOwner = await command(importer.token, pumpValveId);
    expect(byOwner.statusCode).toBe(200);
    const byAdmin = await command(admin.token, pumpValveId);
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().success).toBe(true);
  });

  it('an ACTIVE agreement opens the cross-org lane; a HELD one closes it again', async () => {
    // Before the agreement: power cannot touch water's valve.
    const before = await command(power.token, pumpValveId);
    expect(before.statusCode).toBe(403);

    // Power signs a contract on water's pump-turn-on service (derived,
    // backed by the valve) and water accepts.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(power.token),
    });
    const pumpTurnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name.startsWith('排涝智能阀 1:') && service.name.includes('开启'));
    expect(pumpTurnOn).toBeTruthy();
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${pumpTurnOn!.id}/agreements`,
      headers: auth(power.token),
      payload: { terms: {} },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(water.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');

    // Active agreement = the sanctioned lane: power may now command.
    const during = await command(power.token, pumpValveId);
    expect(during.statusCode).toBe(200);
    expect(during.json().success).toBe(true);

    // The consumer's hold is their own circuit breaker — the authorization
    // suspends with it.
    const held = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/hold`,
      headers: auth(power.token),
      payload: { durationSec: 300 },
    });
    expect(held.statusCode).toBe(200);
    expect(held.json().status).toBe('held');
    const after = await command(power.token, pumpValveId);
    expect(after.statusCode).toBe(403);
  });

  it('the world session keeps its STRICTER T-401 gate (no shared-sandbox carve-out)', async () => {
    await ctx.app.worldSessions.targetFor(envId);
    const sessionSimId = `sim-${envId}-world-session`;
    // The coordinator's screen is importer-owned: shared sandbox on a
    // private sim, but the world session writes back for real — 403.
    const privateSim = await command(water.token, coordScreenId);
    expect(privateSim.statusCode).toBe(200);
    const worldSession = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sessionSimId}/commands`,
      headers: auth(water.token),
      payload: { deviceId: coordScreenId, commandName: 'turn-on' },
    });
    expect(worldSession.statusCode).toBe(403);
    expect(worldSession.json().error.message).toContain('world session');
  });
});
