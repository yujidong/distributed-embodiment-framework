/**
 * @vitest-environment node
 *
 * R46 P0-1 — 资产归属下放 (import-time ownership assignment).
 *
 * The multi-user model's most basic defect: after a multi-stakeholder
 * scenario import every agent/device was owned by the importer, so
 * `/api/me/overview` showed myAgents:0 for the real stakeholders and
 * cross-user agreements were impossible (the consumer agent must be one
 * you own). The import body now carries `invites` (immediate membership)
 * + `ownerAssignment` (regex rules, world-INITIALIZATION not a runtime
 * transfer — no ownership-transfer proposals on this path).
 *
 * Covered:
 * - happy path: agents reassigned by name pattern, unmatched stay with the
 *   importer, devices FOLLOW their reassigned managing agent (the pump
 *   valves go to water exactly because their keeper does);
 * - explicit device rules override the follow rule;
 * - /api/me/overview counts the assignee's agents;
 * - a cross-user agreement naming the assignee's agent as consumerAgentId
 *   passes the "must own" gate;
 * - boundary honesty: non-member target 400 (with the invites remedy),
 *   unknown email 404, invalid regex 400, invites/ownerAssignment on an
 *   empty-world body 400, failed imports leave no half-built world.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

/** Multi-stakeholder mini city: two org keepers + one unclaimed coordinator. */
function cityScenario() {
  return {
    version: '1.0',
    meta: { id: 'mini-city', name: 'Mini City', description: 'R46 P0-1 fixture' },
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
        id: 'pump-level-1',
        name: '内涝水位计 1',
        type: 'flood-detector',
        capabilities: ['flood-reading'],
        zoneId: 'zone-water',
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
        capabilities: ['valve-control', 'flood-reading'],
        managesZoneIds: ['zone-water'],
        boundDeviceIds: ['pump-valve-1', 'pump-level-1'],
      },
      {
        id: 'city-coordinator',
        name: '市应急管理局',
        capabilities: ['coordination'],
        managesZoneIds: ['zone-power', 'zone-water'],
        boundDeviceIds: [],
      },
    ],
    events: [],
  };
}

interface InstanceJson {
  id: string;
  name: string;
  owner: { id: string; displayName: string };
}

describe('R46 P0-1: import-time ownership assignment', () => {
  let ctx: TestAppContext;
  let importer: TestUser;
  let power: TestUser;
  let water: TestUser;
  let outsider: TestUser;

  beforeEach(async () => {
    ctx = await makeTestApp();
    importer = await registerUser(ctx.app, { displayName: 'Importer' });
    power = await registerUser(ctx.app, { email: 'power@sz.gov.cn', displayName: 'Power Bureau' });
    water = await registerUser(ctx.app, { email: 'water@sz.gov.cn', displayName: 'Water Bureau' });
    outsider = await registerUser(ctx.app, { displayName: 'Outsider' });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** The R46 body: invite both stakeholders, assign keepers by name pattern. */
  function assignmentBody(overrides: Record<string, unknown> = {}) {
    return {
      ...cityScenario(),
      visibility: 'private',
      invites: [
        { email: 'power@sz.gov.cn' },
        { email: 'water@sz.gov.cn', role: 'builder' },
      ],
      ownerAssignment: {
        agents: [
          { agentNamePattern: '变电站', toUserEmail: 'power@sz.gov.cn' },
          { agentNamePattern: '泵站', toUserEmail: 'water@sz.gov.cn' },
        ],
      },
      ...overrides,
    };
  }

  function importEnv(body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(importer.token),
      payload: body,
    });
  }

  it('assigns agents by pattern; devices follow their reassigned keeper; unmatched stay importer-owned', async () => {
    const created = await importEnv(assignmentBody());
    expect(created.statusCode).toBe(201);
    const detail = created.json();

    const agents = detail.agents as InstanceJson[];
    const substation = agents.find(a => a.name.includes('变电站'))!;
    const pump = agents.find(a => a.name.includes('泵站'))!;
    const coordinator = agents.find(a => a.name === '市应急管理局')!;
    expect(substation.owner.id).toBe(power.id);
    expect(pump.owner.id).toBe(water.id);
    // No pattern matched the coordinator — the importer keeps it.
    expect(coordinator.owner.id).toBe(importer.id);

    // Follow rule: the pump valve AND the flood sensor moved with their
    // keeper; the grid monitor moved with the substation keeper.
    const devices = detail.devices as InstanceJson[];
    expect(devices.find(d => d.name === '排涝智能阀 1')!.owner.id).toBe(water.id);
    expect(devices.find(d => d.name === '内涝水位计 1')!.owner.id).toBe(water.id);
    expect(devices.find(d => d.name === '电网监测终端 1')!.owner.id).toBe(power.id);

    // The invitees are members (builders) the moment the world lands.
    const members = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${detail.id}/members`,
      headers: auth(importer.token),
    });
    const emails = (members.json().members as Array<{ email?: string; displayName: string }>)
      .map(m => m.email ?? m.displayName);
    expect(emails).toContain('power@sz.gov.cn');
    expect(emails).toContain('water@sz.gov.cn');
  });

  it('explicit device rules override the follow rule', async () => {
    const created = await importEnv(assignmentBody({
      ownerAssignment: {
        agents: [
          { agentNamePattern: '变电站', toUserEmail: 'power@sz.gov.cn' },
          { agentNamePattern: '泵站', toUserEmail: 'water@sz.gov.cn' },
        ],
        devices: [{ deviceNamePattern: '水位计', toUserEmail: 'power@sz.gov.cn' }],
      },
    }));
    expect(created.statusCode).toBe(201);
    const devices = created.json().devices as InstanceJson[];
    // Explicit rule wins over following the (water-owned) pump keeper.
    expect(devices.find(d => d.name === '内涝水位计 1')!.owner.id).toBe(power.id);
    expect(devices.find(d => d.name === '排涝智能阀 1')!.owner.id).toBe(water.id);
  });

  it('the assignee sees the agents in /api/me/overview and can sign a cross-user agreement', async () => {
    const created = await importEnv(assignmentBody());
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;
    const substationId = (created.json().agents as InstanceJson[])
      .find(a => a.name.includes('变电站'))!.id;

    // myAgents no longer 0 for the power bureau.
    const overview = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/overview',
      headers: auth(power.token),
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().totals.myAgents).toBe(1);
    const envOverview = (overview.json().environments as Array<{ id: string; myAgents: number }>)
      .find(env => env.id === envId);
    expect(envOverview?.myAgents).toBe(1);

    // Cross-user agreement: power (consumer) names THEIR assigned agent as
    // consumerAgentId against water's pump service — the "must be an agent
    // you own" 403 is gone.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(power.token),
    });
    expect(services.statusCode).toBe(200);
    const pumpTurnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name.startsWith('排涝智能阀 1:') && service.name.includes('开启'));
    expect(pumpTurnOn).toBeTruthy();

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${pumpTurnOn!.id}/agreements`,
      headers: auth(power.token),
      payload: { consumerAgentId: substationId, terms: {} },
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().consumerAgentId).toBe(substationId);
  });

  it('a target that is not a member is a teaching 400 and leaves no half-built world', async () => {
    // outsider is registered but NOT invited — assignment may not hand
    // world assets to someone outside the world.
    const rejected = await importEnv(assignmentBody({
      ownerAssignment: {
        agents: [{ agentNamePattern: '泵站', toUserEmail: outsider.email }],
      },
    }));
    expect(rejected.statusCode).toBe(400);
    const message: string = rejected.json().error.message;
    expect(message).toContain(outsider.email);
    expect(message).toContain('invites');

    // One transaction: nothing landed.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/environments',
      headers: auth(importer.token),
    });
    expect((list.json().environments as unknown[]).length).toBe(0);
  });

  it('unknown emails and invalid patterns are loud 400/404 before the world is built', async () => {
    const unknownInvite = await importEnv(assignmentBody({
      invites: [{ email: 'ghost@sz.gov.cn' }],
    }));
    expect(unknownInvite.statusCode).toBe(404);
    expect(unknownInvite.json().error.code).toBe('USER_NOT_FOUND');
    expect(unknownInvite.json().error.message).toContain('members:batch');

    const unknownTarget = await importEnv(assignmentBody({
      ownerAssignment: {
        agents: [{ agentNamePattern: '泵站', toUserEmail: 'ghost@sz.gov.cn' }],
      },
    }));
    expect(unknownTarget.statusCode).toBe(404);
    expect(unknownTarget.json().error.code).toBe('USER_NOT_FOUND');

    const badRegex = await importEnv(assignmentBody({
      ownerAssignment: {
        agents: [{ agentNamePattern: '泵站(', toUserEmail: 'water@sz.gov.cn' }],
      },
    }));
    expect(badRegex.statusCode).toBe(400);
    expect(badRegex.json().error.message).toContain('agentNamePattern');

    const notAnArray = await importEnv(assignmentBody({ ownerAssignment: { agents: '变电站' } }));
    expect(notAnArray.statusCode).toBe(400);
    expect(notAnArray.json().error.message).toContain('ownerAssignment.agents');
  });

  it('invites/ownerAssignment on an EMPTY-world body are a teaching 400', async () => {
    const res = await importEnv({ name: 'Empty', invites: [{ email: power.email }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('scenario-import');

    const res2 = await importEnv({
      name: 'Empty',
      ownerAssignment: { agents: [{ agentNamePattern: '变电站', toUserEmail: power.email }] },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.message).toContain('ownerAssignment');
  });

  it('import-time invites notify the invitee and land a member-change audit row', async () => {
    const created = await importEnv(assignmentBody());
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(power.token),
    });
    expect(inbox.statusCode).toBe(200);
    const added = (inbox.json().notifications as Array<{ kind: string }>)
      .find(n => n.kind === 'member.added');
    expect(added).toBeTruthy();

    const audit = ctx.app.commandLogStore.listForEnv(envId, { kind: 'member-change' });
    expect(audit.map(row => row.actor_id)).toEqual([importer.id, importer.id]);
  });
});
