/**
 * @vitest-environment node
 *
 * Mechanism C — the per-flow policy envelope, server side (migration v39):
 *   - the `policy` body field on create/PATCH (verbatim storage, closed
 *     schema + semantic 422s through the SAME core compiler pass, PATCH
 *     null-removal)
 *   - the END-TO-END escalation story: a flow whose envelope exhausts its
 *     delegation budget during a run surfaces policyEscalations on the run
 *     ledger AND a notification to the env owner ('escalate' mode only)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('flow policy envelope (Mechanism C)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;
  let ownerAgentId: string;
  let hvacId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Policy Lab',
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
    hvacId = device.json().id;
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'HVAC Agent', capabilities: [], boundDeviceIds: [hvacId] },
    });
    expect(agent.statusCode).toBe(201);
    ownerAgentId = agent.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** A two-delegate flow with an envelope (advice delegates need no budget). */
  function envelopeFlowBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Two judgments',
      enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
      policy: { maxDelegationsPerRun: 1, onBudgetExhausted: 'escalate' },
      plan: {
        goal: 'two bounded judgments',
        nodes: [
          { id: 'd1', assigneeAgentId: ownerAgentId, delegate: { question: 'q1', mode: 'advice' } },
          { id: 'd2', assigneeAgentId: ownerAgentId, delegate: { question: 'q2', mode: 'advice' } },
        ],
      },
      ...overrides,
    };
  }

  function createFlow(token: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(token),
      payload: envelopeFlowBody(overrides),
    });
  }

  // ---------------------------------------------------------------------------

  it('migration v39 adds flows.policy_json', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 39')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 39, name: 'flow-policy-envelope' });
    const columns = (
      ctx.app.db.prepare('PRAGMA table_info(flows)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(columns).toContain('policy_json');
  });

  it('creates a flow with an envelope, stored verbatim and served back', async () => {
    const created = await createFlow(owner.token);
    expect(created.statusCode).toBe(201);
    const policy = {
      maxDelegationsPerRun: 1,
      onBudgetExhausted: 'escalate',
    };
    expect(created.json().policy).toEqual(policy);

    const fetched = await ctx.app.inject({ method: 'GET', url: `/api/flows/${created.json().id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().policy).toEqual(policy);

    // The runtime-facing definition (flowsProvider) carries the envelope too.
    const def = ctx.app.flowStore.listEnabled(envId, owner.id)[0];
    expect(def.policy).toEqual(policy);
  });

  it('422s a typo\'d envelope key through the core compiler pass (closed schema)', async () => {
    const response = await createFlow(owner.token, {
      policy: { maxDelegationPerRun: 1 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('FLOW_INVALID');
    expect(
      (response.json().error.issues as Array<{ message: string }>)
        .some(issue => issue.message.includes('/policy')),
    ).toBe(true);
  });

  it("422s the dead escalate config (escalate without onBudgetExhausted 'escalate')", async () => {
    const response = await createFlow(owner.token, {
      policy: { maxDelegationsPerRun: 1, escalate: { channel: 'notification', toRole: 'owner' } },
    });
    expect(response.statusCode).toBe(422);
    expect(
      (response.json().error.issues as Array<{ message: string }>)
        .some(issue => issue.message.includes("'escalate' is declared but onBudgetExhausted")),
    ).toBe(true);
  });

  it('400s a non-object / null policy on create (null removal is PATCH-only)', async () => {
    expect((await createFlow(owner.token, { policy: null })).statusCode).toBe(400);
    expect((await createFlow(owner.token, { policy: [1] })).statusCode).toBe(400);
    expect((await createFlow(owner.token, { policy: 'strict' })).statusCode).toBe(400);
  });

  it('an envelope on a delegate-free flow still 201s (a warning, not an error)', async () => {
    const response = await createFlow(owner.token, {
      policy: { maxDelegationsPerRun: 3 },
      plan: {
        goal: 'plain action',
        nodes: [{ id: 'n1', capability: 'cooling', deviceId: hvacId }],
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('PATCH replaces and null-removes the envelope; bad envelopes 422 on the merged candidate', async () => {
    const flow = (await createFlow(owner.token)).json();

    const replaced = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { policy: { maxDelegationsPerRun: 5, minConfidenceToActuate: 0.7 } },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().policy).toEqual({ maxDelegationsPerRun: 5, minConfidenceToActuate: 0.7 });

    // A bad envelope on PATCH re-runs the compiler pass on the MERGED flow.
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { policy: { minConfidenceToActuate: 9 } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('FLOW_INVALID');

    const removed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { policy: null },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().policy).toBeUndefined();
    // The stored definition has no envelope anymore (pre-C semantics).
    expect(ctx.app.flowStore.getById(flow.id)!.policy_json).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // The end-to-end escalation story
  // ---------------------------------------------------------------------------

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

  it("escalate mode: budget exhaustion lands policyEscalations on the run ledger AND notifies the env owner", async () => {
    const flow = (await createFlow(owner.token)).json();
    const simId = await createSimulation();

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(owner.token),
    });
    expect(run.statusCode).toBe(200);
    const record = run.json().run;
    expect(record.status).toBe('success'); // both delegates degrade honestly (no LLM in a rule-only sim)

    // d1 consumed the delegation budget (no-llm degradation still counts);
    // d2 was refused by the envelope and the refusal was ESCALATED.
    expect(record.nodeResults.d1.result.fallbackReason).toBe('no-llm');
    expect(record.nodeResults.d2.result.fallbackReason).toBe('budget-exhausted');
    expect(record.policyEscalations).toEqual([
      {
        kind: 'budget-exhausted',
        nodeId: 'd2',
        message: expect.stringContaining('maxDelegationsPerRun=1'),
      },
    ]);

    // The escalation became a notification to the OWNER (toRole: 'owner' —
    // the only party who can edit any flow), chained to the run.
    const ownerInbox = await notificationsOf(owner);
    const escalation = ownerInbox.find(n => n.kind === 'flow-policy-escalation');
    expect(escalation).toBeDefined();
    expect(escalation!.refId).toBe(record.id);
    expect(escalation!.title).toContain('Two judgments');
    const body = escalation!.body as Record<string, unknown>;
    expect(body.flowId).toBe(flow.id);
    expect(body.runId).toBe(record.id);
    expect(body.triggerKind).toBe('manual');
    expect((body.escalations as Array<{ nodeId: string }>)[0].nodeId).toBe('d2');

    // Nobody else was signaled (the builder is not the envelope's audience).
    const builderInbox = await notificationsOf(builder);
    expect(builderInbox.some(n => n.kind === 'flow-policy-escalation')).toBe(false);
  });

  it("fallback mode (the default): exhaustion rides the node results but notifies nobody", async () => {
    const flow = (await createFlow(owner.token, {
      policy: { maxDelegationsPerRun: 1 },
    })).json();
    const simId = await createSimulation();

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(owner.token),
    });
    expect(run.statusCode).toBe(200);
    const record = run.json().run;
    expect(record.nodeResults.d2.result.fallbackReason).toBe('budget-exhausted'); // still honest
    expect(record.policyEscalations).toBeUndefined();
    expect((await notificationsOf(owner)).some(n => n.kind === 'flow-policy-escalation')).toBe(false);
  });
});
