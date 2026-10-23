/**
 * @vitest-environment node
 *
 * User-orchestrated business flow tests (core flows module, migration v21).
 *
 * Covers: migration v21 schema, flow CRUD incl. auth/permission matrix, the
 * validateFlow gate (bad trigger / bad plan / UNSAT assignments → 422
 * FLOW_INVALID with issues), enable/disable, the run ledger endpoint
 * (incl. pruning), the manual-run endpoint against a REAL EngineRuntime
 * (registry flowsProvider + onFlowRun wiring), and agent 启停
 * (PATCH /api/agents/:id enabled → agent_instances + running runtime).
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

describe('user-orchestrated flows', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let builder2: TestUser;
  let viewer: TestUser;
  let envId: string;
  let agentId: string;
  /** T-201: builder-owned agent (the flow-author tenant in most tests). */
  let builderAgentId: string;
  /** The shared zone-a lamp (owned by owner, bound by both agents). */
  let lamp1Id: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });
    builder2 = await registerUser(ctx.app, { displayName: 'Builder2' });
    viewer = await registerUser(ctx.app, { displayName: 'Viewer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Flow Lab',
        visibility: 'public',
        // T78: the trigger types this suite authors with are DECLARED in the
        // world — the ghost-event-type oracle treats undeclared types
        // honestly, so tests that assert a warnings-free (or exactly-N-
        // warnings) create must declare their events. The ghost case gets
        // its own dedicated test below.
        mapData: {
          zones: [{ id: 'zone-a' }],
          events: [
            'test-event', 'air-quality', 'fire-alarm', 'grid-peak', 'heat-spike',
            'light-spike', 'patient-call', 'smoke-detected', 'temperature-spike',
          ].map((type, index) => ({ id: `evt-${index}`, type, zoneId: 'zone-a' })),
        },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    for (const user of [builder, builder2]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
    }
    ctx.app.envStore.addMember(envId, viewer.id, 'viewer');

    // A switch device + its owner agent — the flow plan's actuation surface.
    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Lamp',
        type: 'light',
        capabilities: ['turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    });
    expect(device.statusCode).toBe(201);
    lamp1Id = device.json().id;
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Lamp Agent', capabilities: [], boundDeviceIds: [device.json().id] },
    });
    expect(agent.statusCode).toBe(201);
    agentId = agent.json().id;

    // T-201: a second tenant (builder) with their OWN agent bound in the same
    // zone — flows authored by builder may only actuate agents owned by
    // builder (author-scoped assignment). Direct store insert: builder API
    // creates go through the proposal pipeline, which is not under test here.
    builderAgentId = ctx.app.envStore.createAgent({
      envId,
      ownerId: builder.id,
      name: 'Builder Lamp Agent',
      // T1 (R2): declares what its device provides — an empty declaration
      // would trip the capability-drift warning on every flow here and
      // pollute tests that assert a warnings-free create (T-606).
      capabilities: ['turn-on'],
      boundDeviceIds: [device.json().id],
      managedZoneIds: [],
    }).id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('Fix-44a: scenario-embedded flows persist through the import path', async () => {
    // The four-channel promise: "场景 JSON 可内嵌 flows 数组随场景加载".
    // Pre-fix, the import endpoint silently dropped the flows array — the
    // UI showed "还没有业务流" for a campus that ships two (E2E 2026-08-15).
    const { readFileSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const scenario = JSON.parse(readFileSync(
      resolve(__dirname, '../../../config/scenarios/campus-assumed.json'),
      'utf8',
    )) as { flows?: unknown[] };
    expect((scenario.flows ?? []).length).toBeGreaterThanOrEqual(2);

    const imported = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario,
    });
    expect(imported.statusCode).toBe(201);
    const campusEnvId = imported.json().id;

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${campusEnvId}/flows`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    const flows = list.json().flows as Array<{ name: string; enabled: boolean }>;
    expect(flows).toHaveLength((scenario.flows ?? []).length);
    expect(flows.every(f => f.enabled)).toBe(true);
    // The shipped example flow survived by name.
    expect(flows.some(f => f.name.includes('高温自动降温'))).toBe(true);
    // 30s test timeout: importing the full campus-assumed scenario (dozens
    // of zones/devices + embedded flows) starves past the 5s default under
    // the nightly runner's oversubscribed worker pool; the assertions are
    // unchanged — this is wall-clock headroom, not a semantic relaxation.
  }, 30_000);

  it('T-020: flows survive the env→scenario export hop (replay round-trip)', async () => {
    // EC-F03: the four-channel promise was one-way — replay scenarios had
    // flows:[] and re-imported envs had 0 flows. Author two flows (one
    // owner-authored/unrestricted, one builder-authored with T-201 pins),
    // export via replay, re-import: the flows must survive with trigger/
    // plan intact and pins REMAPPED onto the new env's instance ids.
    const ownerFlow = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(owner.token),
      payload: {
        name: 'Owner: lamp on',
        enabled: true,
        trigger: { kind: 'event', eventType: 'light-spike', zoneId: 'zone-a' },
        plan: { goal: 'turn the lamp on', nodes: [{ id: 'n1', capability: 'turn-on' }] },
      },
    });
    expect(ownerFlow.statusCode).toBe(201);
    const builderFlow = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(builder.token),
      payload: {
        name: 'Builder: pinned lamp',
        enabled: true,
        trigger: { kind: 'schedule', everySimSec: 600 },
        plan: {
          goal: 'builder actuates their own pinned agent+device',
          nodes: [{
            id: 'n1',
            capability: 'turn-on',
            assigneeAgentId: builderAgentId,
            deviceId: lamp1Id,
          }],
        },
      },
    });
    expect(builderFlow.statusCode).toBe(201);

    // --- Export hop: replay embeds the env's flows ------------------------
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/replays`,
      headers: auth(owner.token),
      payload: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().report).toMatchObject({ flowsEmbedded: 2, flowsSkipped: 0 });

    const exportedFlows = replay.json().scenario.flows as Array<{
      id: string;
      name: string;
      enabled: boolean;
      authorUserId?: string;
      trigger: Record<string, unknown>;
      plan: { goal: string; nodes: Array<Record<string, unknown>> };
    }>;
    expect(exportedFlows).toHaveLength(2);

    const exportedOwner = exportedFlows.find(flow => flow.name === 'Owner: lamp on')!;
    const exportedBuilder = exportedFlows.find(flow => flow.name === 'Builder: pinned lamp')!;
    // Owner-authored rows export unstamped (governance principal, unrestricted).
    expect(exportedOwner.authorUserId).toBeUndefined();
    // Builder-authored rows keep the server-stamped authorship and BOTH pins.
    expect(exportedBuilder.authorUserId).toBe(builder.id);
    expect(exportedBuilder.plan.nodes[0]).toMatchObject({
      assigneeAgentId: builderAgentId,
      deviceId: lamp1Id,
    });
    expect(exportedBuilder.trigger).toEqual({ kind: 'schedule', everySimSec: 600 });

    // --- Import hop: the re-imported env owns the flows, pins remapped ----
    const scenario = replay.json().scenario as Record<string, unknown>;
    const reimport = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: scenario,
    });
    expect(reimport.statusCode).toBe(201);
    const newEnvId = reimport.json().id as string;

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${newEnvId}/flows`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().flows as Array<{
      name: string;
      enabled: boolean;
      createdBy: string | null;
      trigger: Record<string, unknown>;
      plan: { goal: string; nodes: Array<Record<string, unknown>> };
    }>;
    expect(rows).toHaveLength(2);

    const builderRow = rows.find(flow => flow.name === 'Builder: pinned lamp')!;
    expect(builderRow.enabled).toBe(true);
    expect(builderRow.trigger).toEqual({ kind: 'schedule', everySimSec: 600 });
    // Ownership-neutral re-stamp: the importer (the new env's owner) owns the
    // re-imported flows — builder authorship does not transfer.
    expect(builderRow.createdBy).toBe(owner.id);

    // Pins were remapped onto the NEW env's regenerated instance ids.
    const newAgentIds = ctx.app.envStore
      .agentsOf(newEnvId)
      .filter(row => row.name === 'Builder Lamp Agent')
      .map(row => row.id);
    const newDeviceIds = ctx.app.envStore
      .devicesOf(newEnvId)
      .filter(row => row.name === 'Lamp')
      .map(row => row.id);
    expect(newAgentIds).toHaveLength(1);
    expect(newDeviceIds).toHaveLength(1);
    expect(builderRow.plan.nodes[0].assigneeAgentId).toBe(newAgentIds[0]);
    expect(builderRow.plan.nodes[0].deviceId).toBe(newDeviceIds[0]);
    expect(builderRow.plan.nodes[0].assigneeAgentId).not.toBe(builderAgentId);
    expect(builderRow.plan.nodes[0].deviceId).not.toBe(lamp1Id);
  });

  it('Fix-44f: per-environment flow cap rejects the 51st flow', async () => {
    // Fill to the cap with minimal valid flows (event trigger on zone-a +
    // turn-on node delivered by the Lamp Agent).
    const makeFlow = (i: number) => ({
      name: `filler-${i}`,
      enabled: false, // disabled fillers cost no evaluation time
      trigger: { kind: 'event', eventType: 'light-spike', zoneId: 'zone-a' },
      plan: { goal: 'fill', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    });
    for (let i = 0; i < 50; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/flows`,
        headers: auth(builder.token),
        payload: makeFlow(i),
      });
      expect(res.statusCode, `filler ${i}`).toBe(201);
    }
    const over = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(builder.token),
      payload: makeFlow(50),
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('FLOW_QUOTA_EXCEEDED');
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function validFlowBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Lamp on',
      trigger: { kind: 'event', eventType: 'test-event' },
      plan: {
        goal: 'turn the lamp on',
        // Default assignee is the FLOW AUTHOR'S agent (T-201 author scoping):
        // most tests create flows as builder, whose stamp scopes resolution
        // to builder-owned agents.
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: builderAgentId }],
      },
      ...overrides,
    };
  }

  function createFlow(token: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(token),
      payload: validFlowBody(overrides),
    });
  }

  // -------------------------------------------------------------------------
  // Migration v21
  // -------------------------------------------------------------------------

  it('migration v21 creates flows/flow_runs and adds agent_instances.enabled', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 21')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 21, name: 'flows-and-agent-enabled' });

    const flowColumns = (
      ctx.app.db.prepare('PRAGMA table_info(flows)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(flowColumns).toEqual([
      'id',
      'environment_id',
      'name',
      'description',
      'enabled',
      'trigger_json',
      'plan_json',
      'created_by',
      'created_at',
      'updated_at',
      'installed_from', // Fix-38: blueprint lineage
      'inputs_json', // Mechanism D (v37, ALTER TABLE appends last)
      'policy_json', // Mechanism C (v39, ALTER TABLE appends last)
      'agent_invocable', // Mechanism B (v40, ALTER TABLE appends last)
    ]);

    const runColumns = (
      ctx.app.db.prepare('PRAGMA table_info(flow_runs)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(runColumns).toEqual([
      'id',
      'flow_id',
      'simulation_id',
      'trigger_kind',
      'status',
      'summary',
      'node_results_json',
      'started_at',
      'finished_at',
      'trigger_evaluation_json', // T-061 (v30, ALTER TABLE appends last)
      'inputs_json', // Mechanism D (v37, ALTER TABLE appends last)
      'policy_escalations_json', // Mechanism C (v39, ALTER TABLE appends last)
      'invoked_by_agent_id', // Mechanism B (v40, ALTER TABLE appends last)
      'invoked_by_event_id', // Mechanism B (v40, ALTER TABLE appends last)
      'capability_drift_json', // T1 (R2, v62, ALTER TABLE appends last)
    ]);

    const agentColumns = (
      ctx.app.db.prepare('PRAGMA table_info(agent_instances)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(agentColumns).toContain('enabled');
  });

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  it('creates, lists, reads, patches and deletes a flow', async () => {
    const created = await createFlow(builder.token, { description: 'demo' });
    expect(created.statusCode).toBe(201);
    const flow = created.json();
    expect(flow).toMatchObject({
      envId,
      name: 'Lamp on',
      description: 'demo',
      enabled: true,
      createdBy: builder.id,
      trigger: { kind: 'event', eventType: 'test-event' },
    });
    expect(flow.plan.nodes).toHaveLength(1);

    const list = await ctx.app.inject({ method: 'GET', url: `/api/environments/${envId}/flows` });
    expect(list.statusCode).toBe(200);
    expect(list.json().flows.map((f: { id: string }) => f.id)).toEqual([flow.id]);

    const got = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(flow.id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(builder.token),
      payload: { name: 'Renamed', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: 'Renamed', enabled: false });
    expect(patched.json().updatedAt > flow.updatedAt).toBe(true);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/flows/${flow.id}`,
      headers: auth(builder.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}` })).statusCode).toBe(404);
  });

  // T74 (R8, u3-F3): flow lifecycle lands in the activity audit — flows are
  // the fire/security automation topology, so "who changed the linkage rules,
  // when" must be answerable from the feed. The delete row carries a payload
  // snapshot: the flow row is physically gone, the audit line stays readable.
  it('T74: flow create/update/delete land in the activity audit (kind=flow, actor = operator)', async () => {
    const created = await createFlow(builder.token, { name: 'Audited flow' });
    expect(created.statusCode).toBe(201);
    const flow = created.json();

    const readFlowEntries = async (): Promise<Array<{ kind: string; action: string; summary: string; actor: { id: string } | null; objectType: string; objectId: string }>> => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/activity?kind=flow&limit=50`,
        headers: auth(owner.token),
      });
      expect(res.statusCode).toBe(200);
      return res.json().entries as never;
    };

    const createdEntry = (await readFlowEntries()).find(e => e.objectId === flow.id);
    expect(createdEntry).toBeDefined();
    expect(createdEntry!.kind).toBe('flow');
    expect(createdEntry!.action).toBe('created');
    expect(createdEntry!.actor?.id).toBe(builder.id);
    expect(createdEntry!.summary).toContain('Audited flow');
    expect(createdEntry!.summary).toContain('enabled');

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(builder.token),
      payload: { name: 'Audited flow v2', enabled: false },
    });
    expect(patched.statusCode).toBe(200);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/flows/${flow.id}`,
      headers: auth(builder.token),
    });
    expect(deleted.statusCode).toBe(204);

    const entries = (await readFlowEntries()).filter(e => e.objectId === flow.id);
    const updated = entries.find(e => e.action === 'updated');
    expect(updated).toBeDefined();
    expect(updated!.summary).toContain('Audited flow v2');
    expect(updated!.summary).toContain('disabled');
    // The DELETE line survives the row removal via its own payload snapshot.
    const deletedEntry = entries.find(e => e.action === 'deleted');
    expect(deletedEntry).toBeDefined();
    expect(deletedEntry!.summary).toContain('Audited flow v2');
  });

  // T78 (R8, u4-P1-3 / u3-P2-F5): the ghost-event-type oracle — a trigger on
  // a type the world never declares warns at authoring AND stays visible on
  // the read faces (create/get/list), never a silently-armed flow.
  it('T78: an undeclared trigger eventType warns (create + get/list); a declared one stays quiet', async () => {
    const ghost = await createFlow(builder.token, {
      name: 'Zombie watch',
      trigger: { kind: 'event', eventType: 'zombie-invasion' },
    });
    expect(ghost.statusCode).toBe(201); // non-blocking: the type is legal to author
    const warnings = ghost.json().validationWarnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.join(' ')).toContain('zombie-invasion');
    expect(warnings!.join(' ')).toContain('this world declares: test-event');

    // Declared type: no GHOST warning (UX-16: the enabled 'Zombie watch'
    // above shares the same lamp, so a last-writer-wins contention warning
    // is legitimate here — the ghost-type oracle itself stays quiet).
    const declared = await createFlow(builder.token, { name: 'Declared watch' });
    expect(declared.statusCode).toBe(201);
    const declaredWarnings = (declared.json().validationWarnings as string[] | undefined) ?? [];
    expect(declaredWarnings.join(' ')).not.toContain('zombie-invasion');
    expect(declaredWarnings.every(w => w.includes('last-writer-wins'))).toBe(true);

    // The read faces carry the annotation too (u4-P1-3's "flow get 无标注").
    const got = await ctx.app.inject({ method: 'GET', url: `/api/flows/${ghost.json().id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json().validationWarnings as string[]).join(' ')).toContain('zombie-invasion');
    const gotDeclared = await ctx.app.inject({ method: 'GET', url: `/api/flows/${declared.json().id}` });
    expect(gotDeclared.json().validationWarnings).toBeUndefined();

    // Cleanup for the flow-cap test below (the suite shares one env).
    await ctx.app.inject({ method: 'DELETE', url: `/api/flows/${ghost.json().id}`, headers: auth(builder.token) });
    await ctx.app.inject({ method: 'DELETE', url: `/api/flows/${declared.json().id}`, headers: auth(builder.token) });
  });

  // T-606 (R26, SC26-F02): condition flows can see runtime-injected custom
  // parameters — the create/patch responses carry the non-blocking lint
  // for paths that only exist via injection.
  it('T-606: a condition on an undeclared path 201s with validationWarnings; baseline-declared stays quiet', async () => {
    const injected = await createFlow(builder.token, {
      name: 'Badge anomaly',
      enabled: false,
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'badge-anomaly-count', op: '>', value: 2 }],
      },
    });
    expect(injected.statusCode).toBe(201);
    const warnings = injected.json().validationWarnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.join(' ')).toContain('badge-anomaly-count');
    expect(warnings!.join(' ')).toContain('injects it at runtime');

    // A standard parameter condition carries no warning (201, no field).
    const standard = await createFlow(builder.token, {
      name: 'Hot lobby',
      enabled: false,
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 30 }],
      },
    });
    expect(standard.statusCode).toBe(201);
    expect(standard.json().validationWarnings).toBeUndefined();

    // Declaring the key in a zone baseline silences the lint (structural).
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const mapData = parseMapData(env);
    const zone = mapData.zones.find(z => z.id === 'zone-a')!;
    (zone as { baseline?: Record<string, number> }).baseline = {
      ...(zone.baseline ?? {}),
      'badge-anomaly-count': 0,
    };
    ctx.app.envStore.updateEnvironment(envId, { mapData });
    const structural = await createFlow(builder.token, {
      name: 'Badge anomaly structural',
      enabled: false,
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'badge-anomaly-count', op: '>', value: 2 }],
      },
    });
    expect(structural.statusCode).toBe(201);
    expect(structural.json().validationWarnings).toBeUndefined();
  });

  // UX-16 (pm-dev-backlog): 多自动化通道写同一设备是 last-writer-wins 既定
  // 语义——创作期检测+警告，不阻断。两族冲突方：其他启用中的 Flow、
  // active 合约的触发自动化。
  it('UX-16: saving a flow that shares a device with another flow / an active agreement warns (never blocks)', async () => {
    // Flow A alone: nothing to contend with — no warning.
    const flowA = await createFlow(builder.token, { name: 'Lamp on A' });
    expect(flowA.statusCode).toBe(201);
    expect(flowA.json().validationWarnings).toBeUndefined();

    // Flow B actuates the SAME lamp (same capability, same assignee device)
    // → the create response names Flow A and the last-writer-wins semantics.
    const flowB = await createFlow(builder.token, { name: 'Lamp on B' });
    expect(flowB.statusCode).toBe(201); // warns, never blocks
    const bWarnings = (flowB.json().validationWarnings as string[]).join('\n');
    expect(bWarnings).toContain('flow "Lamp on A" also actuates device');
    expect(bWarnings).toContain('Lamp');
    expect(bWarnings).toContain('last-writer-wins');

    // Family 2: an ACTIVE agreement whose trigger automation writes the
    // same lamp. The derived turn-on service pins the lamp as its backing.
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOnService = (services.json().services as Array<{ id: string; semanticType: string }>)
      .find(service => service.semanticType === 'turn-on')!;
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnService.id}/agreements`,
      headers: auth(builder.token),
      payload: {
        terms: {
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a' },
          action: { command: 'turn-on' },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${proposed.json().id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');

    // Flow C: warns about BOTH families — the two flows and the agreement's
    // trigger automation.
    const flowC = await createFlow(builder.token, { name: 'Lamp on C' });
    expect(flowC.statusCode).toBe(201);
    const cWarnings = (flowC.json().validationWarnings as string[]).join('\n');
    expect(cWarnings).toContain('flow "Lamp on A" also actuates device');
    expect(cWarnings).toContain('flow "Lamp on B" also actuates device');
    expect(cWarnings).toContain('trigger automation also writes device');

    // PATCH re-validates with SELF excluded: editing Flow A names Flow B
    // but never Flow A itself.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flowA.json().id}`,
      headers: auth(builder.token),
      payload: { trigger: { kind: 'event', eventType: 'heat-spike' } },
    });
    expect(patched.statusCode).toBe(200);
    const aWarnings = (patched.json().validationWarnings as string[]).join('\n');
    expect(aWarnings).toContain('flow "Lamp on B" also actuates device');
    expect(aWarnings).not.toContain('flow "Lamp on A" also actuates device');
  });

  // T-090 (R28, RT26-F01): open-ended delegate questions carry a
  // non-blocking authoring lint on the create response — teaching the
  // closed-threshold form (T-609 guidance), never a 422.
  it('T-090: an open-ended delegate question 201s with validationWarnings; closed form stays quiet', async () => {
    const openEnded = await createFlow(builder.token, {
      name: 'Ask openly',
      enabled: false,
      plan: {
        goal: 'ask the agent',
        nodes: [
          {
            id: 'ask',
            delegate: {
              question: 'What should we do about the lamp?',
              mode: 'advice',
              outputs: ['answer'],
            },
          },
        ],
      },
    });
    expect(openEnded.statusCode).toBe(201);
    const warnings = openEnded.json().validationWarnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.join(' ')).toContain("node 'ask'");
    expect(warnings!.join(' ')).toContain('closed-threshold');
    expect(warnings!.join(' ')).toContain('open-ended');

    const closed = await createFlow(builder.token, {
      name: 'Ask closed',
      enabled: false,
      plan: {
        goal: 'ask the agent',
        nodes: [
          {
            id: 'ask',
            delegate: { question: 'Is zone-a temperature above 30?', mode: 'advice', outputs: ['answer'] },
          },
        ],
      },
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().validationWarnings).toBeUndefined();
  });

  it('the env owner may patch/delete another user\'s flow', async () => {
    const flow = (await createFlow(builder.token)).json();
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().enabled).toBe(false);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
  });

  // -------------------------------------------------------------------------
  // Auth + permissions
  // -------------------------------------------------------------------------

  it('requires authentication for mutations', async () => {
    const flow = (await createFlow(builder.token)).json();
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/flows`,
        payload: validFlowBody(),
      })).statusCode,
    ).toBe(401);
    expect(
      (await ctx.app.inject({
        method: 'PATCH',
        url: `/api/flows/${flow.id}`,
        payload: { enabled: false },
      })).statusCode,
    ).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/api/flows/${flow.id}` })).statusCode,
    ).toBe(401);
  });

  it('rejects viewers and non-owning builders on mutations', async () => {
    // viewer cannot create (builder-or-owner gate)
    expect((await createFlow(viewer.token)).statusCode).toBe(403);

    const flow = (await createFlow(builder.token)).json();
    // another builder may not patch/delete a flow they did not create
    expect(
      (await ctx.app.inject({
        method: 'PATCH',
        url: `/api/flows/${flow.id}`,
        headers: auth(builder2.token),
        payload: { enabled: false },
      })).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({
        method: 'DELETE',
        url: `/api/flows/${flow.id}`,
        headers: auth(builder2.token),
      })).statusCode,
    ).toBe(403);
  });

  it('hides private-environment flows from strangers', async () => {
    const stranger = await registerUser(ctx.app, { displayName: 'Stranger' });
    const privateEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Private', visibility: 'private', mapData: { zones: [{ id: 'zone-a' }] } },
    });
    const privateEnvId = privateEnv.json().id;

    expect(
      (await ctx.app.inject({
        method: 'GET',
        url: `/api/environments/${privateEnvId}/flows`,
        headers: auth(stranger.token),
      })).statusCode,
    ).toBe(403);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${privateEnvId}/flows`,
        headers: auth(stranger.token),
        payload: validFlowBody(),
      })).statusCode,
    ).toBe(403);
  });

  // -------------------------------------------------------------------------
  // validateFlow gate (422 FLOW_INVALID)
  // -------------------------------------------------------------------------

  it('rejects a semantically invalid trigger with 422 issues', async () => {
    const response = await createFlow(owner.token, { trigger: { kind: 'schedule' } });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe('FLOW_INVALID');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.some((i: { message: string }) => i.message.includes('schedule'))).toBe(true);
  });

  it('rejects a malformed plan with 422 issues', async () => {
    const response = await createFlow(owner.token, { plan: { goal: 'x', nodes: [] } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('FLOW_INVALID');
    expect(response.json().error.issues.length).toBeGreaterThan(0);
  });

  it('rejects unsatisfiable assignments against the environment (UNSAT)', async () => {
    const response = await createFlow(owner.token, {
      plan: {
        goal: 'impossible',
        nodes: [{ id: 'n1', capability: 'no-such-capability' }],
      },
    });
    expect(response.statusCode).toBe(422);
    const issues = response.json().error.issues;
    expect(issues.some((i: { message: string }) => i.message.includes('UNSAT'))).toBe(true);

    const unknownAssignee = await createFlow(owner.token, {
      plan: {
        goal: 'ghost',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: 'agent-that-does-not-exist' }],
      },
    });
    expect(unknownAssignee.statusCode).toBe(422);
  });

  it('re-validates on trigger/plan patches', async () => {
    const flow = (await createFlow(owner.token)).json();
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { trigger: { kind: 'condition', zoneId: 'zone-a', conditions: [] } },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error.code).toBe('FLOW_INVALID');

    // name-only patches skip revalidation and succeed
    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { name: 'Still valid' },
    });
    expect(renamed.statusCode).toBe(200);
  });

  it('FEAT-01: accepts the three time-semantics declaration forms (round-trip intact)', async () => {
    // 23:30 就寝 — daily time-of-day anchor.
    const bedtime = await createFlow(owner.token, {
      name: 'Bedtime 23:30',
      trigger: { kind: 'schedule', atTimeOfDaySec: 84600 },
    });
    expect(bedtime.statusCode).toBe(201);
    expect(bedtime.json().trigger).toEqual({ kind: 'schedule', atTimeOfDaySec: 84600 });

    // 22:00–06:00 时间窗 — condition active window (crossing midnight).
    const nightWatch = await createFlow(owner.token, {
      name: 'Night watch',
      trigger: {
        kind: 'condition', zoneId: 'zone-a',
        conditions: [{ path: 'motion', op: '==', value: true }],
        activeWindowSimSec: [79200, 21600],
      },
    });
    expect(nightWatch.statusCode).toBe(201);
    expect(nightWatch.json().trigger.activeWindowSimSec).toEqual([79200, 21600]);

    // 到馆前 30 分钟预冷 — occupancy-relative anchor. zone-a declares no
    // occupantSchedule in this env, so the unpinned form 201s WITH the
    // honest warning (never a silent never-firing flow).
    const precool = await createFlow(owner.token, {
      name: 'Precool before arrival',
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { before: 'arrive', offsetSec: 1800 },
      },
    });
    expect(precool.statusCode).toBe(201);
    expect(precool.json().trigger.relativeToOccupancy).toEqual({ before: 'arrive', offsetSec: 1800 });
    expect(
      (precool.json().validationWarnings ?? []).some((w: string) => w.includes('occupantSchedule')),
    ).toBe(true);
  });

  it('FEAT-01: rejects an empty active window and a schedule with no time field', async () => {
    const emptyWindow = await createFlow(owner.token, {
      trigger: {
        kind: 'condition', zoneId: 'zone-a',
        conditions: [{ path: 'motion', op: '==', value: true }],
        activeWindowSimSec: [12000, 12000],
      },
    });
    expect(emptyWindow.statusCode).toBe(422);
    expect(emptyWindow.json().error.code).toBe('FLOW_INVALID');
    expect(
      emptyWindow.json().error.issues.some((i: { message: string }) => i.message.includes('activeWindowSimSec')),
    ).toBe(true);

    const noTime = await createFlow(owner.token, { trigger: { kind: 'schedule' } });
    expect(noTime.statusCode).toBe(422);
    expect(
      noTime.json().error.issues.some((i: { message: string }) => i.message.includes('atTimeOfDaySec')),
    ).toBe(true);

    // relativeToOccupancy pinned to a zone with no occupantSchedule → 422.
    const unanchored = await createFlow(owner.token, {
      trigger: {
        kind: 'schedule',
        relativeToOccupancy: { zoneId: 'zone-a', before: 'arrive', offsetSec: 1800 },
      },
    });
    expect(unanchored.statusCode).toBe(422);
    expect(
      unanchored.json().error.issues.some((i: { message: string }) => i.message.includes('occupantSchedule')),
    ).toBe(true);
  });

  it('validates request body field types with 400', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(owner.token),
      payload: { ...validFlowBody(), enabled: 'yes' },
    });
    expect(response.statusCode).toBe(400);

    const flow = (await createFlow(owner.token)).json();
    const emptyPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(emptyPatch.statusCode).toBe(400);
  });

  it('R13 CB-F01: rejects an all-unrecognized params object with a rename hint (422)', async () => {
    // The round-13 clinic evidence: set-fan-speed IS executable (a handler
    // exists), but the node carried {fanSpeed: 3} — a spelling the handler
    // dropped silently, so the flow validated and the run failed mid-way
    // ("no handler / no effect"). Authoring must teach the rename now.
    const purifier = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Ward Purifier', type: 'air-purifier',
        capabilities: ['set-fan-speed', 'turn-on'], zoneId: 'zone-a',
      },
    });
    expect(purifier.statusCode).toBe(201);
    const purifierAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'ClinicDuty Agent', capabilities: [],
        boundDeviceIds: [purifier.json().id],
      },
    });
    expect(purifierAgent.statusCode).toBe(201);

    const bad = await createFlow(owner.token, {
      trigger: { kind: 'event', eventType: 'patient-call', zoneId: 'zone-a' },
      plan: {
        goal: 'purge ward air',
        nodes: [{
          id: 'purge', capability: 'set-fan-speed',
          assigneeAgentId: purifierAgent.json().id, deviceId: purifier.json().id,
          params: { fan_speed: 3 },
        }],
      },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('FLOW_INVALID');
    const message = bad.json().error.issues[0].message as string;
    expect(message).toContain("command 'set-fan-speed' accepts params (speed, fanSpeed)");
    expect(message).toContain('fan_speed → speed');
    expect(message).toContain('would execute with no effect');

    // Control: BOTH accepted spellings still create — the canonical {speed}
    // and the round-13 payload {fanSpeed} (handler alias, hints list it).
    for (const params of [{ speed: 60 }, { fanSpeed: 3 }]) {
      const good = await createFlow(owner.token, {
        trigger: { kind: 'event', eventType: 'patient-call', zoneId: 'zone-a' },
        plan: {
          goal: 'purge ward air',
          nodes: [{
            id: 'purge', capability: 'set-fan-speed',
            assigneeAgentId: purifierAgent.json().id, deviceId: purifier.json().id,
            params,
          }],
        },
      });
      expect(good.statusCode).toBe(201);
    }
  });

  it('T-002: rejects declared-but-unexecutable capabilities with executable alternatives (422)', async () => {
    // The trap: agent AND device both declare 'switch', so pre-T-002
    // validation passed — then the run failed with
    // "no handler / no effect for command switch". The executability oracle
    // (simulation capability-contract) must turn that into an authoring-time
    // 422 that teaches the executable vocabulary.
    const sw = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Corridor Switch', type: 'light-switch', capabilities: ['switch'], zoneId: 'zone-a' },
    });
    expect(sw.statusCode).toBe(201);
    const swAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Switch Agent', capabilities: ['switch'], boundDeviceIds: [sw.json().id] },
    });
    expect(swAgent.statusCode).toBe(201);

    // Explicit assignee: message names the node, the gap, and alternatives.
    const explicit = await createFlow(owner.token, {
      plan: {
        goal: 'flip the switch',
        nodes: [{ id: 'n1', capability: 'switch', assigneeAgentId: swAgent.json().id }],
      },
    });
    expect(explicit.statusCode).toBe(422);
    expect(explicit.json().error.code).toBe('FLOW_INVALID');
    const explicitMessage = explicit.json().error.issues[0].message as string;
    expect(explicitMessage).toContain("'switch'");
    expect(explicitMessage).toContain('no bound device provides an executable command');
    expect(explicitMessage).toContain('turn-on');

    // Auto-assigned variant: same diagnosis without an assignee.
    const auto = await createFlow(owner.token, {
      plan: { goal: 'flip the switch', nodes: [{ id: 'n1', capability: 'switch' }] },
    });
    expect(auto.statusCode).toBe(422);
    expect((auto.json().error.issues[0].message as string)).toContain(
      'no registered command handler executes it',
    );

    // Control: an executable capability on the same env still creates.
    const ok = await createFlow(owner.token, {
      plan: {
        goal: 'lamp on instead',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: agentId }],
      },
    });
    expect(ok.statusCode).toBe(201);

    // Regression guard: semantic 'lighting-control' on a light device runs
    // via DeviceResource multi-command expansion (turn-on + set-brightness)
    // even though no handler is registered for the literal name — the
    // wizard offers raw device capabilities, so this must stay creatable.
    const panel = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Panel Light',
        type: 'light',
        capabilities: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'],
        zoneId: 'zone-a',
      },
    });
    expect(panel.statusCode).toBe(201);
    const panelAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Panel Agent', capabilities: [], boundDeviceIds: [panel.json().id] },
    });
    expect(panelAgent.statusCode).toBe(201);
    const semantic = await createFlow(owner.token, {
      plan: {
        goal: 'light the panel',
        nodes: [{ id: 'n1', capability: 'lighting-control', assigneeAgentId: panelAgent.json().id }],
      },
    });
    expect(semantic.statusCode).toBe(201);
  });

  it('R101 (wang-13): the ventilation capability validates, RUNS, and physically clears CO2 — one executability truth', async () => {
    // wang-13 replay: a fresh-air hvac declaring ventilation. His first
    // attempt (`turn-on`, not declared) was 422'd listing the DECLARED caps;
    // the listed `ventilation` then validated but failed at run time with
    // "no handler / no effect" — the creation oracle and the runtime
    // dispatch were two truths. R101 adds the real handler; both now agree.
    const ventEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Vent Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'lab-101', baseline: { co2: 800 } }] },
      },
    });
    expect(ventEnv.statusCode).toBe(201);
    const ventEnvId = ventEnv.json().id as string;
    const fresh = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${ventEnvId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: '实验室101新风空调(王)', type: 'hvac',
        capabilities: ['ventilation', 'cooling', 'temperature-control'], zoneId: 'lab-101',
      },
    });
    expect(fresh.statusCode).toBe(201);
    const ventAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${ventEnvId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Vent Agent', capabilities: [], boundDeviceIds: [fresh.json().id] },
    });
    expect(ventAgent.statusCode).toBe(201);

    const ventFlow = (overrides: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${ventEnvId}/flows`,
        headers: auth(owner.token),
        payload: {
          name: 'CO2超标自动开新风(王)',
          trigger: { kind: 'event', eventType: 'air-quality' },
          plan: { goal: 'ventilate', nodes: [{ id: 'n1', capability: 'x', assigneeAgentId: ventAgent.json().id, deviceId: fresh.json().id }] },
          ...overrides,
        },
      });

    // Step 1: a NOT-declared capability is still a 422 naming what the
    // device declares (unchanged teaching).
    const plan = (capability: string) => ({
      plan: { goal: 'ventilate', nodes: [{ id: 'n1', capability, assigneeAgentId: ventAgent.json().id, deviceId: fresh.json().id }] },
    });
    const undeclared = await ventFlow(plan('turn-on'));
    expect(undeclared.statusCode).toBe(422);

    // Step 2: ventilation now VALIDATES — and it is the truth this time.
    const created = await ventFlow(plan('ventilation'));
    expect(created.statusCode).toBe(201);

    // Face check: the device detail's commands read the same oracle —
    // ventilation is listed (it was missing pre-R101).
    const deviceDetail = await ctx.app.inject({
      method: 'GET',
      url: `/api/devices/${fresh.json().id as string}`,
      headers: auth(owner.token),
    });
    expect(deviceDetail.json().commands).toContain('ventilation');

    // Step 3: the run EXECUTES (was "no handler / no effect for command
    // ventilation") and the zone's CO2 really clears toward outdoor.
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: ventEnvId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    const record = ctx.app.simulations.get(simId)!;
    await record.runtime.injectEvent({ type: 'air-quality', zoneId: 'lab-101', parameter: 'co2', value: 1500 });

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${created.json().id}/run`,
      headers: auth(owner.token),
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.status).toBe('success');

    // The air exchange physically decays CO2 BELOW the zone's 800 baseline
    // toward outdoor (~420) — natural relaxation alone can never go there.
    await record.runtime.step(3600);
    const co2 = record.runtime.getSnapshot().zones.find(z => z.id === 'lab-101')!.parameters.co2 as number;
    expect(co2).toBeLessThan(600);

    // A genuinely dead name (no handler anywhere) is still a 422.
    const dead = await ventFlow(plan('trigger-alert'));
    expect(dead.statusCode).toBe(422);
  }, 30_000);

  it('T-408: the seed smart-lock vocabulary validates and executes — access-control expands to the audited lock', async () => {
    // The seed shape (config/scenarios/personal-health.json zw-door-lock):
    // a smart-lock declaring the access-control class — NOT the literal
    // lock/unlock command names. Pre-T-408 a lockdown flow on
    // 'access-control' was a 422 whose hint listed open/close but never the
    // lock vocabulary the handler actually claims.
    const lock = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Door Lock',
        type: 'smart-lock',
        capabilities: ['access-control', 'remote-access-grant'],
        zoneId: 'zone-a',
        initialState: { locked: false },
      },
    });
    expect(lock.statusCode).toBe(201);
    const lockAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Lock Agent', capabilities: [], boundDeviceIds: [lock.json().id] },
    });
    expect(lockAgent.statusCode).toBe(201);

    // Authoring: the lockdown node now validates (type expansion
    // access-control → lock on lock-family types).
    const flow = await createFlow(owner.token, {
      plan: {
        goal: 'lockdown',
        nodes: [
          { id: 'n1', capability: 'access-control', assigneeAgentId: lockAgent.json().id },
        ],
      },
    });
    expect(flow.statusCode).toBe(201);

    // Execution: the run dispatches 'lock' (the secure-state command) and
    // the device lands locked with the T-034 who/when audit trail.
    const simId = await createSimulation();
    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.json().id}/run`,
      headers: auth(owner.token),
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.status).toBe('success');

    const device = ctx.app.simulations.get(simId)!.runtime.getSnapshot()
      .devices.find(d => d.id === lock.json().id || (d.state as Record<string, unknown>) !== undefined && d.name === 'Door Lock')!;
    expect(device).toBeDefined();
    const state = device.state as Record<string, unknown>;
    expect(state.locked).toBe(true);
    expect(state.lastLockTime).toEqual(expect.any(String));
    expect(Array.isArray(state.accessLog)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Run ledger
  // -------------------------------------------------------------------------

  it('serves the run ledger (newest first, limit, pruning at 50)', async () => {
    const flow = (await createFlow(owner.token)).json();

    const empty = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().runs).toEqual([]);

    // 55 synthetic runs — the store prunes each flow to the most recent 50.
    for (let i = 0; i < 55; i += 1) {
      ctx.app.flowStore.recordRun({
        runId: `run-${String(i).padStart(3, '0')}`,
        flowId: flow.id,
        triggerKind: 'event',
        status: 'success',
        summary: `run ${i}`,
        nodeResults: {},
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }

    // T-061: a run carrying trigger-evaluation detail round-trips through
    // the ledger API (path + evaluatedValue + threshold stay observable).
    ctx.app.flowStore.recordRun({
      runId: 'run-traced',
      flowId: flow.id,
      triggerKind: 'condition',
      status: 'success',
      summary: 'traced run',
      triggerEvaluation: {
        kind: 'condition',
        zoneId: 'roof',
        simTimeSec: 120,
        conditions: [{ path: 'pvOutputW', op: '>', threshold: 6000, evaluatedValue: 8000, met: true }],
      },
      nodeResults: {},
      startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    });

    const runs = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    expect(runs.statusCode).toBe(200);
    const listed = runs.json().runs;
    expect(listed).toHaveLength(50);
    expect(listed[0].id).toBe('run-traced'); // newest first
    expect(listed[0].triggerEvaluation).toEqual({
      kind: 'condition',
      zoneId: 'roof',
      simTimeSec: 120,
      conditions: [{ path: 'pvOutputW', op: '>', threshold: 6000, evaluatedValue: 8000, met: true }],
    });
    // UX-14: the trigger sim time is hoisted to the top level — present
    // (never absent), the evaluation's simTimeSec when known, null on
    // legacy rows without an evaluation.
    expect(listed[0].triggerSimTimeSec).toBe(120);
    expect(listed[1].id).toBe('run-054');
    expect(listed[49].id).toBe('run-006'); // run-000..005 pruned
    expect(listed[1]).toMatchObject({ flowId: flow.id, triggerKind: 'event', status: 'success' });
    expect(listed[1].triggerEvaluation).toBeUndefined(); // legacy shape: absent, not null
    expect(listed[1].triggerSimTimeSec).toBeNull();

    const limited = await ctx.app.inject({
      method: 'GET',
      url: `/api/flows/${flow.id}/runs?limit=2`,
    });
    expect(limited.json().runs.map((r: { id: string }) => r.id)).toEqual(['run-traced', 'run-054']);

    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs?limit=0` })).statusCode,
    ).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Manual run against a real EngineRuntime (registry wiring)
  // -------------------------------------------------------------------------

  async function createSimulation(): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  }

  it('manually triggers a flow in a running env-backed simulation and records the run', async () => {
    const flow = (await createFlow(owner.token)).json();
    const simId = await createSimulation();

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.flowId).toBe(flow.id);
    expect(body.run).toMatchObject({
      flowId: flow.id,
      simulationId: simId,
      triggerKind: 'manual',
    });
    expect(['success', 'partial', 'failed']).toContain(body.run.status);

    // The run landed in the ledger via the registry's onFlowRun wiring.
    const runs = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    expect(runs.json().runs.map((r: { id: string }) => r.id)).toContain(body.run.id);
  });

  it('T1 (R2 u3-F1): revoking the assignee declaration annotates subsequent runs with capabilityDrift', async () => {
    // u3's sequence: author a flow while the agent declares the capability,
    // run it clean, REVOKE the declaration (agent PATCH), run again — the
    // execution truth (the bound device) still provides the capability so
    // the run still succeeds, but the ledger now carries the explicit
    // degraded annotation (never silent again). The live declaration probe
    // (registry wiring) is what makes a sim created BEFORE the revoke see
    // it; the drift must also survive a NEW sim (frozen scenario without
    // the declaration).
    const smoke = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Exhaust Fan B1',
        type: 'fan',
        capabilities: ['turn-on'],
        zoneId: 'zone-a',
      },
    });
    expect(smoke.statusCode).toBe(201);
    const fanId = smoke.json().id;
    const guard = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'WD-值守-B栋',
        capabilities: ['turn-on'],
        boundDeviceIds: [fanId],
      },
    });
    expect(guard.statusCode).toBe(201);
    const guardId = guard.json().id;

    const createdFlow = await createFlow(owner.token, {
      name: 'B栋排烟',
      trigger: { kind: 'event', eventType: 'fire-alarm', zoneId: 'zone-a' },
      plan: {
        goal: 'clear the smoke',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: guardId, deviceId: fanId }],
      },
    });
    expect(createdFlow.statusCode).toBe(201);
    const flow = createdFlow.json();

    const runOnce = async (simId: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${simId}/flows/${flow.id}/run`,
        headers: auth(owner.token),
      });

    // 1. Clean authority: sim + run created while the declaration exists.
    const sim1 = await createSimulation();
    const clean = (await runOnce(sim1)).json();
    expect(clean.run.status).toBe('success');
    expect(clean.run.capabilityDrift).toBeUndefined();

    // 2. REVOKE the declaration (agent PATCH — the u3 move).
    const revoked = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${guardId}`,
      headers: auth(owner.token),
      payload: { capabilities: [] },
    });
    expect(revoked.statusCode).toBe(200);

    // 2b. Authoring receipt for a NEW flow in the revoked world is
    // WARNING-level (exit code 0 semantics — never a 422) and rides the
    // create response as validationWarnings (human and --json share it).
    const warnedFlow = await createFlow(owner.token, {
      name: 'B栋排烟 v2',
      trigger: { kind: 'event', eventType: 'fire-alarm', zoneId: 'zone-a' },
      plan: {
        goal: 'clear the smoke',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: guardId, deviceId: fanId }],
      },
    });
    expect(warnedFlow.statusCode).toBe(201);
    // UX-16: the earlier flow on the same fan adds a legitimate
    // last-writer-wins contention warning — the DRIFT warning is what this
    // test pins, exactly once.
    const authoring = warnedFlow.json().validationWarnings as string[];
    expect(authoring.filter(w => w.includes('does not declare capability'))).toHaveLength(1);

    // 4. The OLD sim (frozen scenario still carries the grant) now annotates:
    const staleRun = (await runOnce(sim1)).json();
    expect(staleRun.run.status).toBe('success'); // semantics unchanged
    expect(staleRun.run.capabilityDrift).toEqual([
      {
        nodeId: 'n1',
        capability: 'turn-on',
        assigneeAgentId: guardId,
        declaredCapabilities: [],
      },
    ]);

    // 5. A NEW sim (frozen snapshot created after the revoke) annotates too.
    const sim2 = await createSimulation();
    const freshRun = (await runOnce(sim2)).json();
    expect(freshRun.run.status).toBe('success');
    expect(freshRun.run.capabilityDrift).toHaveLength(1);

    // 6. The runs endpoint surfaces the annotation for both runs.
    const ledger = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    const rows = ledger.json().runs as Array<{
      id: string;
      status: string;
      capabilityDrift?: Array<{
        nodeId: string;
        capability: string;
        assigneeAgentId: string;
        declaredCapabilities: string[];
      }>;
    }>;
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(clean.run.id)?.capabilityDrift).toBeUndefined();
    expect(byId.get(staleRun.run.id)?.capabilityDrift).toEqual([
      { nodeId: 'n1', capability: 'turn-on', assigneeAgentId: guardId, declaredCapabilities: [] },
    ]);
    expect(byId.get(freshRun.run.id)?.capabilityDrift).toHaveLength(1);

    // 7. The flow list/get faces annotate the stored flow against the LIVE
    // world (存量 flow 的漂移标注，作者没有重新编辑过它).
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/flows`,
    });
    const listedFlow = (listed.json().flows as Array<{
      id: string;
      capabilityDrift?: Array<{ capability: string }>;
    }>).find(f => f.id === flow.id);
    expect(listedFlow?.capabilityDrift).toEqual([
      { capability: 'turn-on', assigneeAgentId: guardId, nodeId: 'n1', declaredCapabilities: [] },
    ]);

    // 8. Re-granting clears the annotation (honest both ways).
    const reGrantPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${guardId}`,
      headers: auth(owner.token),
      payload: { capabilities: ['turn-on'] },
    });
    expect(reGrantPatch.statusCode).toBe(200);
    expect(reGrantPatch.json().capabilities).toEqual(['turn-on']);
    const reGrant = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/flows`,
    });
    const reGrantFlow = (reGrant.json().flows as Array<{
      id: string;
      capabilityDrift?: unknown;
    }>).find(f => f.id === flow.id);
    expect(reGrantFlow?.capabilityDrift).toBeUndefined();
  });

  it('T-051: runtime resolution uses the executability oracle (parity with the authoring 422)', async () => {
    // A legacy/imported row the authoring gate never saw: agent AND device
    // both declare 'switch'. Pre-T-051 the RUNTIME resolved assignments
    // without the oracle, so this flow passed the runtime gate and died
    // mid-run (or worse, ambiguity verdicts diverged from the authoring
    // 422s). The runtime pass now validates with the same oracle.
    const sw = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Corridor Switch', type: 'light-switch', capabilities: ['switch'], zoneId: 'zone-a' },
    });
    expect(sw.statusCode).toBe(201);
    const swAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Switch Agent', capabilities: ['switch'], boundDeviceIds: [sw.json().id] },
    });
    expect(swAgent.statusCode).toBe(201);

    // Direct store insert — bypasses the authoring 422 on purpose (that
    // gate is covered by the T-002 test above).
    const row = ctx.app.flowStore.create({
      environmentId: envId,
      name: 'Legacy switch flow',
      description: '',
      enabled: true,
      trigger: { kind: 'event', eventType: 'temperature-spike', zoneId: 'zone-a' },
      plan: {
        goal: 'flip the switch',
        nodes: [{ id: 'n1', capability: 'switch', assigneeAgentId: swAgent.json().id }],
      },
      createdBy: owner.id,
    });

    const simId = await createSimulation();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${row.id}/run`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(200);
    // The run is REFUSED with the SAME teaching message authoring produces
    // ("declared but no registered command handler executes it") — the
    // verdicts can no longer diverge across the two passes.
    expect(response.json().run.status).toBe('failed');
    expect(response.json().run.nodeResults.n1.status).toBe('failed');
    // Explicit-assignee diagnosis (the same string the T-002 authoring 422
    // produces for this shape).
    expect(String(response.json().run.nodeResults.n1.error)).toContain(
      'no bound device provides an executable command',
    );

    // Control: an executable capability still runs to success at runtime.
    const ok = (await createFlow(owner.token, {
      plan: { goal: 'lamp on', nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: agentId }] },
    })).json();
    const okRun = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${ok.id}/run`,
      headers: auth(owner.token),
    });
    expect(okRun.statusCode).toBe(200);
    expect(okRun.json().run.status).toBe('success');
  });

  it('rejects manual runs of disabled flows and foreign flows', async () => {
    const flow = (await createFlow(owner.token, { enabled: false })).json();
    const simId = await createSimulation();

    const disabled = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(owner.token),
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error.code).toBe('FLOW_NOT_RUNNABLE');

    // enable it → the running sim picks the change up (flowsProvider re-read)
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { enabled: true },
    });
    const enabled = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(owner.token),
    });
    expect(enabled.statusCode).toBe(200);

    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/no-such-flow/run`,
      headers: auth(owner.token),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('FLOW_NOT_FOUND');
  });

  it('T-003: manual run against a stale simulation returns 409 FLOW_STALE_SIMULATION', async () => {
    // 1. Freeze the world: create the sim BEFORE the env gains the fan.
    const simId = await createSimulation();

    // 2. Edit the environment AFTER the sim exists: add a Fan + its agent.
    //    The sim's frozen snapshot predates both.
    const fan = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Fan', type: 'fan', capabilities: ['cooling'], zoneId: 'zone-a' },
    });
    expect(fan.statusCode).toBe(201);
    const fanAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Fan Agent', capabilities: [], boundDeviceIds: [fan.json().id] },
    });
    expect(fanAgent.statusCode).toBe(201);

    // 3. Author a flow against the CURRENT world — create-time validation
    //    passes (the fan agent exists now), but the run targets the frozen
    //    snapshot where it does not.
    const flow = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/flows`,
        headers: auth(owner.token),
        payload: {
          name: 'Cool it',
          trigger: { kind: 'event', eventType: 'heat-spike' },
          plan: {
            goal: 'cool the room',
            nodes: [{ id: 'n1', capability: 'cooling', assigneeAgentId: fanAgent.json().id }],
          },
        },
      })
    ).json();
    expect(flow.id).toBeDefined();

    // 4. Manual run → 409 with the recreate guidance, not a doomed run.
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('FLOW_STALE_SIMULATION');
    expect(response.json().error.message).toContain(
      'the environment changed after this simulation was created — recreate the simulation to run this flow',
    );
    expect(Array.isArray(response.json().error.issues)).toBe(true);

    // Refused BEFORE triggering — no run landed in the ledger.
    const runs = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    expect(runs.json().runs).toEqual([]);

    // Control: a flow resolving against BOTH worlds still runs — the guard
    // must not become a blanket rejection of older simulations.
    const lampFlow = (await createFlow(owner.token)).json();
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${lampFlow.id}/run`,
      headers: auth(owner.token),
    });
    expect(ok.statusCode).toBe(200);

    // Control: a flow UNSAT against BOTH worlds is the flow's own problem —
    // the world moved on after authoring (the fan was deleted), so no
    // stale-sim 409: the run proceeds and records its own failure.
    const doomed = (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/flows`,
        headers: auth(owner.token),
        payload: {
          name: 'Doomed',
          trigger: { kind: 'event', eventType: 'heat-spike' },
          plan: {
            goal: 'cool the room too late',
            nodes: [{ id: 'n1', capability: 'cooling', assigneeAgentId: fanAgent.json().id }],
          },
        },
      })
    ).json();
    expect(doomed.id).toBeDefined();
    const fanDeleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/devices/${fan.json().id}`,
      headers: auth(owner.token),
    });
    expect(fanDeleted.statusCode).toBe(204);
    const sim2 = await createSimulation();
    const doomedRun = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${sim2}/flows/${doomed.id}/run`,
      headers: auth(owner.token),
    });
    expect(doomedRun.statusCode).toBe(200);
    expect(doomedRun.json().run.status).toBe('failed');
  });

  it('requires builder/owner membership for manual runs', async () => {
    const flow = (await createFlow(owner.token)).json();
    const simId = await createSimulation();

    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      })).statusCode,
    ).toBe(401);
    expect(
      (await ctx.app.inject({
        method: 'POST',
        url: `/api/simulations/${simId}/flows/${flow.id}/run`,
        headers: auth(viewer.token),
      })).statusCode,
    ).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Agent 启停 (PATCH /api/agents/:id enabled)
  // -------------------------------------------------------------------------

  it('toggles agent enabled and syncs the running simulation runtime', async () => {
    const simId = await createSimulation();
    const record = ctx.app.simulations.get(simId)!;
    expect(record.runtime.isAgentEnabled(agentId)).toBe(true);

    const disabled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().enabled).toBe(false);
    expect(record.runtime.isAgentEnabled(agentId)).toBe(false);

    const enabled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().enabled).toBe(true);
    expect(record.runtime.isAgentEnabled(agentId)).toBe(true);

    expect(
      (await ctx.app.inject({
        method: 'PATCH',
        url: `/api/agents/${agentId}`,
        headers: auth(owner.token),
        payload: { enabled: 'no' },
      })).statusCode,
    ).toBe(400);
  });

  it('bridges a disabled agent into new simulations (ScenarioAgent.enabled)', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: auth(owner.token),
      payload: { enabled: false },
    });
    const simId = await createSimulation();
    const record = ctx.app.simulations.get(simId)!;
    expect(record.runtime.isAgentEnabled(agentId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T-201 — author-scoped assignment, deviceId pinning, deviceId in traces
  // -------------------------------------------------------------------------

  it('T-201: rejects a cross-tenant explicit assignee with the governance message (422)', async () => {
    // builder authors a flow whose node actuates the OWNER's agent.
    const response = await createFlow(builder.token, {
      plan: {
        goal: 'unlock the clinic',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: agentId }],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('FLOW_INVALID');
    const message = response.json().error.issues[0].message as string;
    expect(message).toContain('is owned by another tenant');
    expect(message).toContain('agreement invocation (provider-executed, metered)');
  });

  it('T-201: auto-match considers only the flow author\'s agents (HF-F01 topology)', async () => {
    // Two tenants' agents bound in one zone: owner's lock-style agent and
    // builder's lamp agent. builder's unpinned auto-match flow resolves to
    // THEIR agent — the owner's zone-local agent is never a candidate.
    const auto = await createFlow(builder.token, {
      plan: { goal: 'lights on', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    });
    expect(auto.statusCode).toBe(201);

    // A builder2 flow where ONLY foreign agents provide the capability →
    // authoring-time error teaching the agreement path.
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(builder2.token),
      payload: {
        name: 'Not mine to actuate',
        trigger: { kind: 'event', eventType: 'test-event' },
        plan: { goal: 'lamp on', nodes: [{ id: 'n1', capability: 'turn-off' }] },
      },
    });
    expect(foreign.statusCode).toBe(422);
    const foreignMessage = foreign.json().error.issues[0].message as string;
    expect(foreignMessage).toContain('no agent owned by the flow author');
    expect(foreignMessage).toContain('agreement invocation (provider-executed, metered)');
  });

  it('T-201: ambiguous capability 422s naming devices; a deviceId pin fixes it', async () => {
    // Give the builder's agent a SECOND device providing turn-on in the
    // same zone: one unpinned node, two qualifying devices → 422.
    const lamp2 = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: 'Desk Lamp', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a' },
    });
    expect(lamp2.statusCode).toBe(201);
    const lamp2Id = lamp2.json().id as string;
    ctx.app.db
      .prepare('UPDATE agent_instances SET bound_device_ids_json = ? WHERE id = ?')
      .run(JSON.stringify([lamp1Id, lamp2Id]), builderAgentId);

    const ambiguous = await createFlow(builder.token, {
      plan: { goal: 'lights on', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    });
    expect(ambiguous.statusCode).toBe(422);
    const message = ambiguous.json().error.issues[0].message as string;
    expect(message).toContain("capability 'turn-on' is ambiguous");
    expect(message).toContain('2 devices provide it');
    expect(message).toContain('Desk Lamp');

    // Pinning one device resolves it deterministically.
    const pinned = await createFlow(builder.token, {
      plan: { goal: 'desk lamp only', nodes: [{ id: 'n1', capability: 'turn-on', deviceId: lamp2Id }] },
    });
    expect(pinned.statusCode).toBe(201);
  });

  it('T-201: run ledger rows carry the per-node deviceId', async () => {
    const flow = (await createFlow(builder.token)).json();
    const simId = await createSimulation();

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(builder.token),
    });
    expect(run.statusCode).toBe(200);
    const record = run.json().run as {
      status: string;
      nodeResults: Record<string, { deviceId?: string; status: string }>;
    };
    expect(['success', 'partial']).toContain(record.status);
    expect(record.nodeResults.n1.deviceId).toBeDefined();
    // The ledger row carries the same deviceId (persisted node_results_json).
    const ledger = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    const rows = ledger.json().runs as Array<{ nodeResults: Record<string, { deviceId?: string }> }>;
    expect(rows[0].nodeResults.n1.deviceId).toBe(record.nodeResults.n1.deviceId);
  });

  it('T-201: authorUserId is server-stamped — a client-supplied value is rejected', async () => {
    const response = await createFlow(builder.token, { authorUserId: 'user-attacker' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('authorUserId');

    const flow = (await createFlow(builder.token)).json();
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(builder.token),
      payload: { authorUserId: 'user-attacker' },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('T-201: the env owner\'s flows keep unrestricted semantics (no stamp)', async () => {
    // Owner-authored flow actuating the builder's agent — allowed: the env
    // owner is the governance principal and its flows carry no stamp.
    const response = await createFlow(owner.token, {
      plan: {
        goal: 'borrow the builder lamp',
        nodes: [{ id: 'n1', capability: 'turn-on', assigneeAgentId: builderAgentId }],
      },
    });
    expect(response.statusCode).toBe(201);
  });

  // -------------------------------------------------------------------------
  // T-305 (DevLoop R12, EN-F02/FR-F01) — trigger-zone validation is
  // UNCONDITIONAL on the REST authoring path. An empty world used to make
  // the Fix-44k gate vacuous (environmentToScenario throws → no scenario →
  // zone check skipped → bogus-zone flows 201'd).
  // -------------------------------------------------------------------------

  it('T-305: empty env — bogus trigger zone → 422 (was 201); any zoned trigger teaches the no-zones remedy', async () => {
    const emptyEnv = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { name: 'Empty World Lab' },
    });
    expect(emptyEnv.statusCode).toBe(201);
    const emptyEnvId = emptyEnv.json().id as string;

    const post = (payload: Record<string, unknown>) => ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${emptyEnvId}/flows`,
      headers: auth(owner.token),
      payload,
    });

    // EN-F02's probe: bogus zone id on an env with no zones.
    const bogus = await post({
      name: 'Bogus zone probe',
      trigger: { kind: 'event', eventType: 'smoke-detected', zoneId: 'zz-bogus' },
      plan: { goal: 'react', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    });
    expect(bogus.statusCode).toBe(422);
    expect(bogus.json().error.code).toBe('FLOW_INVALID');
    expect(bogus.json().error.issues.some(
      (i: { message: string }) => i.message.includes('no zones yet') ||
        i.message.includes('zz-bogus'),
    )).toBe(true);

    // ANY zoned trigger on an empty env teaches the bootstrap remedy.
    const anyZone = await post({
      name: 'Any zone probe',
      trigger: { kind: 'condition', zoneId: 'room-999-nonexistent', conditions: [{ path: 'temperature', op: '>', value: 30 }] },
      plan: { goal: 'react', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    });
    expect(anyZone.statusCode).toBe(422);
    expect(anyZone.json().error.issues.some(
      (i: { message: string }) => i.message.includes('no zones yet'),
    )).toBe(true);
    expect(anyZone.json().error.issues.some(
      (i: { message: string }) => i.message.includes('import zones'),
    )).toBe(true);

    // Schedule triggers (no trigger zone) still create cleanly on an empty env
    // (plan nodes are still required by the shape check; assignment
    // satisfiability stays scenario-gated — nothing to check against here).
    const schedule = await post({
      name: 'Night check',
      trigger: { kind: 'schedule', everySimSec: 3600 },
      plan: { goal: 'noop', nodes: [{ id: 'n1', capability: 'turn-on' }] },
    });
    expect(schedule.statusCode).toBe(201);
  });

  it('T-305: zoned env — bogus zone still 422; valid zone 201; PATCH re-validation covered', async () => {
    const bogus = await createFlow(owner.token, {
      trigger: { kind: 'event', eventType: 'smoke-detected', zoneId: 'zz-bogus' },
    });
    expect(bogus.statusCode).toBe(422);
    expect(bogus.json().error.issues.some(
      (i: { message: string }) => i.message.includes('zz-bogus'),
    )).toBe(true);

    // Valid zone → 201.
    const ok = await createFlow(owner.token, {
      trigger: { kind: 'event', eventType: 'smoke-detected', zoneId: 'zone-a' },
    });
    expect(ok.statusCode).toBe(201);

    // PATCH re-validation: editing the trigger to a bogus zone → 422.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${ok.json().id}`,
      headers: auth(owner.token),
      payload: { trigger: { kind: 'event', eventType: 'smoke-detected', zoneId: 'zz-bogus' } },
    });
    expect(patched.statusCode).toBe(422);
    expect(patched.json().error.issues.some(
      (i: { message: string }) => i.message.includes('zz-bogus'),
    )).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Mechanism A: delegate nodes (mixed-initiative flows)
  // -------------------------------------------------------------------------

  it('MI-A: creates an advice delegate flow (201) and stores the delegate node verbatim', async () => {
    const response = await createFlow(owner.token, {
      name: 'Ask the lamp agent',
      plan: {
        goal: 'delegate the judgment',
        nodes: [
          {
            id: 'ask',
            delegate: {
              question: 'Is now a good time to turn the lamp on?',
              mode: 'advice',
              outputs: ['verdict'],
              timeoutMs: 15000,
              fallback: { policy: 'none' },
            },
            assigneeAgentId: agentId,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const flow = response.json();
    expect(flow.plan.nodes[0].delegate).toMatchObject({ mode: 'advice', outputs: ['verdict'] });
  });

  it('MI-A: rejects advice+budget and actuating-without-budget with teaching 422s', async () => {
    const adviceWithBudget = await createFlow(owner.token, {
      plan: {
        goal: 'g',
        nodes: [
          {
            id: 'd1', assigneeAgentId: agentId,
            delegate: {
              question: 'q', mode: 'advice',
              budget: { maxCommands: 1, deviceIds: [lamp1Id], allowedCommands: ['turn-on'] },
            },
          },
        ],
      },
    });
    expect(adviceWithBudget.statusCode).toBe(422);
    expect(adviceWithBudget.json().error.issues.some(
      (i: { message: string }) => i.message.includes("mode 'advice' but carries a budget"),
    )).toBe(true);

    const actuatingWithoutBudget = await createFlow(owner.token, {
      plan: {
        goal: 'g',
        nodes: [{ id: 'd1', assigneeAgentId: agentId, delegate: { question: 'q', mode: 'actuating' } }],
      },
    });
    expect(actuatingWithoutBudget.statusCode).toBe(422);
    expect(actuatingWithoutBudget.json().error.issues.some(
      (i: { message: string }) => i.message.includes("mode 'actuating' but carries no budget"),
    )).toBe(true);
  });

  it('MI-A: rejects a delegate budget outside the trigger zone (ratified trade-off #1)', async () => {
    // A two-zone env: lamp-b sits in zone-b while the flow triggers on zone-a.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Delegate Zone Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }, { id: 'zone-b' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    const zonedEnvId = created.json().id;
    const lampB = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${zonedEnvId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Lamp B', type: 'light',
        capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-b',
      },
    });
    expect(lampB.statusCode).toBe(201);
    // The budget device must be agent-bound for assignment resolution to
    // reach the zone-containment verdict (own-devices-only actuation path).
    const lampBAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${zonedEnvId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Lamp B Agent', capabilities: [], boundDeviceIds: [lampB.json().id] },
    });
    expect(lampBAgent.statusCode).toBe(201);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${zonedEnvId}/flows`,
      headers: auth(owner.token),
      payload: {
        name: 'Cross-zone delegate budget',
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
        plan: {
          goal: 'shed',
          nodes: [
            {
              id: 'pick',
              delegate: {
                question: 'Pick a shedding target.',
                mode: 'actuating',
                budget: { maxCommands: 1, deviceIds: [lampB.json().id], allowedCommands: ['turn-on'] },
              },
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(422);
    const issues = response.json().error.issues;
    // The teaching names the zone containment rule and the agreement path.
    expect(issues.some((i: { message: string }) =>
      i.message.includes("sits in zone 'zone-b' but the trigger zone is 'zone-a'"))).toBe(true);
    expect(issues.some((i: { message: string }) =>
      i.message.includes('agreement invocation'))).toBe(true);
  });
});
