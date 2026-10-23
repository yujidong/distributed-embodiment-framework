/**
 * @vitest-environment node
 *
 * Fix-38: App Blueprints — one-click application templates.
 *
 * Student journey: pick a blueprint → install into a zone → the zone now
 * has devices + an agent + (optionally) a flow that responds to events.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestApp, registerUser, type TestAppContext } from './test-utils.js';

describe('Fix-38: App Blueprints', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Teacher' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Blueprint Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });
  afterEach(async () => { await ctx.cleanup(); });

  it('built-in blueprints are seeded on boot', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/blueprints',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const bps = res.json().blueprints as Array<{ id: string; isBuiltin: boolean }>;
    expect(bps.length).toBeGreaterThanOrEqual(6);
    expect(bps.every(bp => bp.isBuiltin)).toBe(true);
    const ids = bps.map(bp => bp.id);
    expect(ids).toContain('classroom-energy-saver');
    expect(ids).toContain('dorm-guardian');
    expect(ids).toContain('corridor-smart-lighting');
    // R15-F: 深圳韧性专属蓝图（R13 遗留）。
    expect(ids).toContain('sz-flood-drainage');
    expect(ids).toContain('sz-cbd-air-guard');
    expect(ids).toContain('sz-emergency-lighting');
  });

  it('installs a shenzhen blueprint with its flow (R15-F)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/sz-flood-drainage/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-a' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().summary).toMatchObject({ devices: 2, agents: 1, flows: 1 });

    const flows = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/flows`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const flow = (flows.json().flows as Array<{ name: string; enabled: boolean }>)
      .find(f => f.name === '暴雨自动排水');
    expect(flow).toMatchObject({ enabled: true });
  });

  it('install creates devices + agent + flow in the target zone', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/classroom-energy-saver/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-a' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary.devices).toBe(2);
    expect(body.summary.agents).toBe(1);
    expect(body.summary.flows).toBe(1);
    expect(body.createdIds.devices).toHaveLength(2);
    expect(body.createdIds.agents).toHaveLength(1);
    expect(body.createdIds.flows).toHaveLength(1);

    // Verify objects exist in the environment.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const devices = detail.json().devices as Array<{ name: string; zoneId: string }>;
    expect(devices.some(d => d.name === '教室温感' && d.zoneId === 'zone-a')).toBe(true);
    expect(devices.some(d => d.name === '教室空调' && d.zoneId === 'zone-a')).toBe(true);
    const agents = detail.json().agents as Array<{ name: string }>;
    expect(agents.some(a => a.name === '节能管家')).toBe(true);

    // Flow was created.
    const flows = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/flows`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect((flows.json().flows as Array<{ name: string }>).some(f => f.name === '高温自动降温')).toBe(true);
  });

  it('install into a nonexistent zone fails with UNKNOWN_ZONE', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/classroom-energy-saver/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'no-such-zone' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNKNOWN_ZONE');
  });

  it('install is idempotent per zone (duplicate installs create more objects)', async () => {
    // Install twice — blueprints are templates, not singletons.
    // Each install creates fresh objects (matching "blueprint is a starting point").
    for (let i = 0; i < 2; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/blueprints/dorm-guardian/install`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { zoneId: 'zone-b' },
      });
      expect(res.statusCode).toBe(201);
    }
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const dormDevices = (detail.json().devices as Array<{ name: string }>)
      .filter(d => d.name === '宿舍温感');
    expect(dormDevices).toHaveLength(2);
  });

  it('custom blueprint can be created and installed', async () => {
    // Create a custom blueprint.
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/blueprints',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: '自定义传感器',
        description: '只有一个传感器的最小蓝图',
        definition: {
          devices: [
            { name: '自定义温感', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: '${zoneId}' },
          ],
          agents: [],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const bpId = create.json().id;

    // Install it.
    const install = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/${bpId}/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-b' },
    });
    expect(install.statusCode).toBe(201);
    expect(install.json().summary.devices).toBe(1);
  });

  // R1 (B1-8 / P-18): blueprint agents pass the SAME capability-backing
  // gate as owner-direct creation — the sz-emergency-lighting lesson (the
  // agent declared fire-monitoring no bound device provided; install
  // succeeded, the fire flow UNSAT'd on the day).
  it('install rejects an agent declaring capabilities no bound device provides (B1-8)', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/blueprints',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: '无支撑能力蓝图',
        description: 'agent 声明了设备给不了的能力',
        definition: {
          devices: [
            { name: '自定义温感', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: '${zoneId}' },
          ],
          agents: [
            { name: '越权值守', capabilities: ['fire-monitoring'], boundDeviceIndexes: [0] },
          ],
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const bpId = create.json().id;

    const install = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/${bpId}/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-a' },
    });
    expect(install.statusCode).toBe(422);
    expect(install.json().error.code).toBe('AGENT_CAPABILITIES_UNBACKED');
    expect(install.json().error.message).toContain('fire-monitoring');
    // Nothing leaked: the failed install leaves no device rows behind.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect((detail.json().devices as Array<{ name: string }>).some(d => d.name === '自定义温感')).toBe(false);
  });

  it('built-in blueprints pass the capability-backing gate (B1-8 follow-through)', async () => {
    // The two blueprints whose agents once declared unbacked capabilities —
    // their sensing devices now back those declarations.
    for (const bpId of ['sz-emergency-lighting', 'sz-flood-drainage']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/blueprints/${bpId}/install`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { zoneId: 'zone-a' },
      });
      expect(res.statusCode, `${bpId}: ${res.body}`).toBe(201);
    }
  });

  it('built-in blueprints cannot be deleted', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/blueprints/classroom-energy-saver',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unauthenticated users cannot list blueprints', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/blueprints' });
    expect(res.statusCode).toBe(401);
  });

  it('uninstall removes exactly the objects installed from that blueprint', async () => {
    // Two blueprints into the same env — uninstall must be selective.
    for (const bpId of ['classroom-energy-saver', 'dorm-guardian']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/blueprints/${bpId}/install`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { zoneId: 'zone-a' },
      });
      expect(res.statusCode).toBe(201);
    }

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/blueprints/classroom-energy-saver/instances`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ devices: 2, agents: 1, flows: 1 });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const names = (detail.json().devices as Array<{ name: string }>).map(d => d.name);
    expect(names).not.toContain('教室温感');
    expect(names).not.toContain('教室空调');
    // The other blueprint's objects are untouched.
    expect(names).toContain('宿舍温感');
    expect(names).toContain('宿舍空调');
    const agentNames = (detail.json().agents as Array<{ name: string }>).map(a => a.name);
    expect(agentNames).not.toContain('节能管家');
    expect(agentNames).toContain('宿舍守护者');

    const flows = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/flows`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect((flows.json().flows as Array<{ name: string }>).some(f => f.name === '高温自动降温')).toBe(false);
  });

  it('uninstall is idempotent — a second call reports zeros', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/dorm-guardian/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-b' },
    });
    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/blueprints/dorm-guardian/instances`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(first.json().summary).toEqual({ devices: 2, agents: 1, flows: 0 });
    const second = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/blueprints/dorm-guardian/instances`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().summary).toEqual({ devices: 0, agents: 0, flows: 0 });
  });

  it('uninstall cleans up instances of a since-deleted custom blueprint', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/blueprints',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: '一次性蓝图',
        description: '装完就删模板',
        definition: {
          devices: [
            { name: '一次性温感', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: '${zoneId}' },
          ],
          agents: [],
        },
      },
    });
    const bpId = create.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/blueprints/${bpId}/install`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { zoneId: 'zone-a' },
    });
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/blueprints/${bpId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(del.statusCode).toBe(204);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/blueprints/${bpId}/instances`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ devices: 1, agents: 0, flows: 0 });
  });

  it('strangers cannot uninstall blueprint instances', async () => {
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/environments/${envId}/blueprints/dorm-guardian/instances`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('R6-D-S3: collaboration-pair blueprints (partnerSuggestion)', () => {
  let ctx: TestAppContext;
  let owner: { id: string; token: string };
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Teacher' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { name: 'Pair Lab', visibility: 'public', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });
  afterEach(async () => { await ctx.cleanup(); });

  it('seeds the CO2 监测员 ⇄ 新风管家 pair pointing at each other', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/blueprints',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(200);
    const bps = res.json().blueprints as Array<{
      id: string;
      definition: { partnerSuggestion?: { blueprintId: string; note?: string } };
    }>;
    const monitor = bps.find(bp => bp.id === 'co2-monitor');
    const manager = bps.find(bp => bp.id === 'fresh-air-manager');
    expect(monitor).toBeDefined();
    expect(manager).toBeDefined();
    expect(monitor!.definition.partnerSuggestion?.blueprintId).toBe('fresh-air-manager');
    expect(manager!.definition.partnerSuggestion?.blueprintId).toBe('co2-monitor');
    expect(monitor!.definition.partnerSuggestion?.note).toBeTruthy();
    // Self-sufficient cards carry no pair metadata.
    const classroom = bps.find(bp => bp.id === 'classroom-energy-saver');
    expect(classroom!.definition.partnerSuggestion).toBeUndefined();
  });

  it('installs the pair into one zone (成对安装流程)', async () => {
    for (const bpId of ['co2-monitor', 'fresh-air-manager']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/blueprints/${bpId}/install`,
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { zoneId: 'zone-a' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().summary).toMatchObject({ devices: 1, agents: 1, flows: 0 });
    }
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    const deviceNames = (detail.json().devices as Array<{ name: string }>).map(d => d.name);
    expect(deviceNames).toContain('CO2 传感器');
    expect(deviceNames).toContain('新风机');
    const agentNames = (detail.json().agents as Array<{ name: string }>).map(a => a.name);
    expect(agentNames).toContain('环境监测员');
    expect(agentNames).toContain('新风管家');
  });

  it('accepts a valid partnerSuggestion on custom blueprints and echoes it', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/blueprints',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: '配套卡',
        definition: {
          devices: [
            { name: '灯', type: 'light', capabilities: ['turn-on'], zoneId: '${zoneId}' },
          ],
          agents: [],
          partnerSuggestion: { blueprintId: 'co2-monitor', note: '搭配监测员' },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().definition.partnerSuggestion).toEqual({
      blueprintId: 'co2-monitor',
      note: '搭配监测员',
    });
  });

  it('rejects a malformed partnerSuggestion with BAD_REQUEST', async () => {
    const base = {
      name: '坏卡',
      definition: {
        devices: [{ name: '灯', type: 'light', capabilities: ['turn-on'], zoneId: '${zoneId}' }],
        agents: [],
      },
    };
    for (const partnerSuggestion of [
      'co2-monitor',
      { blueprintId: '' },
      { note: 'no id' },
      { blueprintId: 'co2-monitor', note: 42 },
    ]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/blueprints',
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { ...base, definition: { ...base.definition, partnerSuggestion } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('partnerSuggestion');
    }
  });
});

