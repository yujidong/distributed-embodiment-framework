/**
 * @vitest-environment node
 *
 * FEAT-05 + FEAT-06 — flow NOTIFY/WAIT nodes, server side:
 *   - the notify lane END TO END: a run delivers the node's message through
 *     the environment notification pipeline (to='owner'/'role'/'agent'
 *     recipient resolution), the recipients + notification ids ride the run
 *     ledger's node result, and the teaching 422s fire at authoring;
 *   - the wait lane through the API: a manual run of a wait-carrying flow
 *     answers the honest intermediate 'waiting' record (nothing persisted),
 *     and stepping the sim to the due second lands the terminal ledger row
 *     with the wait node's schedule ({waitSimSec, dueSimSec, resumedAtSimSec}).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('flow notify/wait nodes (FEAT-05/06)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;
  let agentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Notify Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(builder.token),
    });

    const device = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'HVAC',
        type: 'hvac',
        capabilities: ['cooling', 'temperature-control'],
        zoneId: 'zone-a',
      },
    });
    expect(device.statusCode).toBe(201);
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'HVAC Agent', capabilities: [], boundDeviceIds: [device.json().id] },
    });
    expect(agent.statusCode).toBe(201);
    agentId = agent.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function flowBody(nodes: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
    return {
      name: 'Notify flow',
      enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
      plan: { goal: 'notify', nodes },
      ...overrides,
    };
  }

  function createFlow(token: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(token),
      payload: body,
    });
  }

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

  async function notificationsOf(user: TestUser): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(user.token),
    });
    expect(response.statusCode).toBe(200);
    return response.json().notifications;
  }

  async function runFlow(simId: string, flowId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flowId}/run`,
      headers: auth(owner.token),
    });
  }

  // ---------------------------------------------------------------------------
  // FEAT-05: the notify lane end to end
  // ---------------------------------------------------------------------------

  it("to='owner': the message lands in the env owner's inbox and the ledger records the recipients", async () => {
    const flow = (await createFlow(owner.token, flowBody([
      { id: 'n1', notify: { to: 'owner', message: 'grid peak — setback applied' } },
    ]))).json();
    const simId = await createSimulation();

    const run = await runFlow(simId, flow.id);
    expect(run.statusCode).toBe(200);
    const record = run.json().run;
    expect(record.status).toBe('success');
    expect(record.nodeResults.n1.status).toBe('succeeded');
    expect(record.nodeResults.n1.result.to).toBe('owner');
    expect(record.nodeResults.n1.result.recipients).toHaveLength(1);
    expect(record.nodeResults.n1.result.notificationIds).toHaveLength(1);

    const inbox = await notificationsOf(owner);
    const delivered = inbox.find(n => n.kind === 'flow.notification');
    expect(delivered).toBeDefined();
    expect(delivered!.title).toBe('grid peak — setback applied');
    const body = delivered!.body as Record<string, unknown>;
    expect(body.flowId).toBe(flow.id);
    expect(body.nodeId).toBe('n1');
    expect(body.to).toBe('owner');
    // The ledger's notification id is the inbox row's id (the join key).
    expect(record.nodeResults.n1.result.notificationIds).toContain(delivered!.id);
  });

  it("to='role' builder: every member with the role is notified, the owner is not", async () => {
    const flow = (await createFlow(owner.token, flowBody([
      { id: 'n1', notify: { to: 'role', target: 'builder', message: 'builders: check the schedule' } },
    ]))).json();
    const simId = await createSimulation();

    const run = await runFlow(simId, flow.id);
    expect(run.statusCode).toBe(200);
    expect(run.json().run.status).toBe('success');

    const builderInbox = await notificationsOf(builder);
    expect(builderInbox.some(n => n.kind === 'flow.notification' && n.title === 'builders: check the schedule')).toBe(true);
    const ownerInbox = await notificationsOf(owner);
    expect(ownerInbox.some(n => n.kind === 'flow.notification')).toBe(false);
  });

  it("to='agent': the notification resolves to the agent's OWNER user (the handshake-answer rule)", async () => {
    const flow = (await createFlow(owner.token, flowBody([
      { id: 'n1', notify: { to: 'agent', target: agentId, message: 'agent: verify your HVAC' } },
    ]))).json();
    const simId = await createSimulation();

    const run = await runFlow(simId, flow.id);
    expect(run.statusCode).toBe(200);
    const record = run.json().run;
    expect(record.status).toBe('success');
    expect(record.nodeResults.n1.result.to).toBe('agent');
    expect(record.nodeResults.n1.result.target).toBe(agentId);

    const ownerInbox = await notificationsOf(owner);
    expect(ownerInbox.some(n => n.kind === 'flow.notification' && n.title === 'agent: verify your HVAC')).toBe(true);
  });

  it('authoring 422s teach: a typo’d role / a dangling agent / a target on to=owner', async () => {
    const badRole = await createFlow(owner.token, flowBody([
      { id: 'n1', notify: { to: 'role', target: 'janitor', message: 'm' } },
    ]));
    expect(badRole.statusCode).toBe(422);
    expect(badRole.json().error.code).toBe('FLOW_INVALID');
    expect(JSON.stringify(badRole.json())).toContain("role 'janitor'");

    const badAgent = await createFlow(owner.token, flowBody([
      { id: 'n1', notify: { to: 'agent', target: 'agent-ghost', message: 'm' } },
    ]));
    expect(badAgent.statusCode).toBe(422);
    expect(JSON.stringify(badAgent.json())).toContain("agent 'agent-ghost'");

    const strayTarget = await createFlow(owner.token, flowBody([
      { id: 'n1', notify: { to: 'owner', target: agentId, message: 'm' } },
    ]));
    expect(strayTarget.statusCode).toBe(422);
    expect(JSON.stringify(strayTarget.json())).toContain('drop the target');

    const mixed = await createFlow(owner.token, flowBody([
      { id: 'n1', capability: 'cooling', notify: { to: 'owner', message: 'm' } },
    ]));
    expect(mixed.statusCode).toBe(422);
    expect(JSON.stringify(mixed.json())).toContain('EXACTLY ONE');
  });

  // ---------------------------------------------------------------------------
  // FEAT-06: the wait lane through the API
  // ---------------------------------------------------------------------------

  it("a manual run of a wait-carrying flow answers 'waiting' (unpersisted), and stepping to the due second lands the terminal ledger row", async () => {
    const flow = (await createFlow(owner.token, flowBody([
      { id: 'w1', wait: { simSec: 300 } },
      { id: 'n1', dependsOn: ['w1'], notify: { to: 'owner', message: 'staggered notify fired' } },
    ]))).json();
    const simId = await createSimulation();
    const record = ctx.app.simulations.get(simId)!;

    const run = await runFlow(simId, flow.id);
    expect(run.statusCode).toBe(200);
    const intermediate = run.json().run;
    expect(intermediate.status).toBe('waiting');
    expect(intermediate.summary).toContain('parked on a wait node');
    expect(intermediate.waiting.resumeAtSimSec).toBeGreaterThan(0);
    expect(intermediate.waiting.pendingNodeIds).toEqual(['w1', 'n1']);
    // The wait node's schedule is already recorded; the notify has not fired.
    expect(intermediate.nodeResults.w1.status).toBe('succeeded');
    expect(intermediate.nodeResults.w1.result.waitSimSec).toBe(300);
    expect(intermediate.nodeResults.n1).toBeUndefined();
    // NOTHING persisted yet — one ledger row per run, at completion.
    const runsBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/flows/${flow.id}/runs`,
      headers: auth(owner.token),
    });
    expect(runsBefore.statusCode).toBe(200);
    expect(runsBefore.json().runs).toEqual([]);
    expect((await notificationsOf(owner)).some(n => n.kind === 'flow.notification')).toBe(false);

    // Step the sim past the due second: the run resumes, the notify fires,
    // and the TERMINAL ledger row lands with the full schedule.
    await record.runtime.step(400);
    const runsAfter = await ctx.app.inject({
      method: 'GET',
      url: `/api/flows/${flow.id}/runs`,
      headers: auth(owner.token),
    });
    const rows = runsAfter.json().runs as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(intermediate.id);
    expect(rows[0]!.status).toBe('success');
    const nodeResults = rows[0]!.nodeResults as Record<string, { status: string; result?: Record<string, unknown> }>;
    expect(nodeResults.w1?.status).toBe('succeeded');
    expect(nodeResults.w1?.result).toMatchObject({ waitSimSec: 300 });
    expect(nodeResults.w1?.result?.resumedAtSimSec).toBe(nodeResults.w1?.result?.dueSimSec);
    expect(nodeResults.n1?.status).toBe('succeeded');
    expect((await notificationsOf(owner)).some(n => n.kind === 'flow.notification' && n.title === 'staggered notify fired')).toBe(true);
  }, 30_000);
});
