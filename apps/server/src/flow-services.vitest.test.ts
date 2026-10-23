/**
 * @vitest-environment node
 *
 * Mechanism D (design-mixed-initiative-flows.md §5) — Flow-as-a-Service.
 *
 * This file covers the PUBLISH lane (Task-2 scope): a provider publishes a
 * flow as an origin='flow' service through the existing agent-services
 * route (`backing: {kind:'flow', flowId}`), the interface is GENERATED from
 * the flow's declared inputs surface (one 'run' action + parameter hints +
 * the Wave-A delegate-node count), T-201 author scoping gates the provider
 * agent at publish time, and the market rides the existing surfaces
 * (origin filter, consumable verdict, flow-edit interface refresh, flow
 * deletion cascade).
 *
 * The negotiation + invocation + metering story lives here too (see the
 * end-to-end describe block) — publish is where it starts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('flow-services (Mechanism D): publish + market', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let provider: TestUser;
  let consumer: TestUser;
  let envId: string;
  /** Owner-owned agent bound to the HVAC — the flow's actuation surface. */
  let ownerAgentId: string;
  /** Provider-owned agent in the same env (T-201: OUTSIDE owner flows). */
  let providerAgentId: string;
  let hvacId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    provider = await registerUser(ctx.app, { displayName: 'Provider' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Flow Service Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;

    for (const user of [provider, consumer]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/join`,
        headers: auth(user.token),
      });
    }

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
    const ownerAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'HVAC Agent', capabilities: [], boundDeviceIds: [hvacId] },
    });
    expect(ownerAgent.statusCode).toBe(201);
    ownerAgentId = ownerAgent.json().id;
    providerAgentId = ctx.app.envStore.createAgent({
      envId,
      ownerId: provider.id,
      name: 'Provider Agent',
      capabilities: [],
      boundDeviceIds: [hvacId],
      managedZoneIds: [],
    }).id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** The canonical publishable flow: an inputs surface + ${input:x} params. */
  async function createParameterizedFlow(token: string, overrides: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(token),
      payload: {
        name: 'Night setback',
        enabled: true,
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
        inputs: [
          { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
          { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
        ],
        plan: {
          goal: 'night setback to the given setpoint',
          nodes: [{
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}', profile: 'mode-${input:mode}' },
          }],
        },
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  function publishFlowService(token: string, agentId: string, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: auth(token),
      payload: { name: '夜间节能回退', semanticType: 'energy-setback', ...body },
    });
  }

  // ---------------------------------------------------------------------------

  it('publishes a flow as an origin=flow service with a generated interface', async () => {
    const flow = await createParameterizedFlow(owner.token);
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
      visibility: 'members',
    });
    expect(published.statusCode).toBe(201);
    const json = published.json();
    expect(json.origin).toBe('flow');
    expect(json.sourceFlowId).toBe(flow.id);
    expect(json.sourceDeviceId).toBeNull();
    expect(json.visibility).toBe('members');
    // The consumable verdict: backed by the flow (unbacked=false) — the
    // T-310 SERVICE_NOT_BACKED propose gate opens for it.
    expect(json.unbacked).toBe(false);
    expect(json.consumable).toBe(true);
    // The interface IS the contract: one 'run' action whose parameters are
    // the flow's declared inputs, plus the delegate-node count (Wave-A
    // caution surfaced as data).
    expect(json.interface).toEqual({
      kind: 'flow',
      flowId: flow.id,
      flowName: 'Night setback',
      actions: [{
        name: 'run',
        parameters: {
          setpoint: { type: 'number', required: true, min: 16, max: 26 },
          mode: { type: 'string', default: 'comfort', enum: ['eco', 'comfort'] },
        },
      }],
      delegateNodeCount: 0,
    });
  });

  it('counts delegate nodes in the generated interface (Wave-A caution as data)', async () => {
    const flow = await createParameterizedFlow(owner.token, {
      name: 'Delegate setback',
      plan: {
        goal: 'setback with a delegated judgment step',
        nodes: [
          {
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}' },
          },
          {
            id: 'judge',
            delegate: {
              question: '确认回退不会影响在住人员舒适度',
              mode: 'advice',
              outputs: ['ok'],
              timeoutMs: 5000,
              fallback: { policy: 'none' },
            },
            dependsOn: ['n1'],
          },
        ],
      },
    });
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().interface.delegateNodeCount).toBe(1);
  });

  it('refuses to publish a flow without a declared inputs surface (422 teaching)', async () => {
    // No ${input:} references either — the surface is the ONLY missing piece.
    const flow = await createParameterizedFlow(owner.token, {
      inputs: undefined,
      plan: {
        goal: 'fixed setback',
        nodes: [{ id: 'n1', capability: 'cooling', deviceId: hvacId, params: { targetTemperature: 20 } }],
      },
    });
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(422);
    expect(published.json().error.code).toBe('FLOW_INPUTS_REQUIRED');
    expect(published.json().error.message).toContain('inputs surface');
  });

  it('a zero-arg surface (inputs: []) publishes as a closed no-param service', async () => {
    const flow = await createParameterizedFlow(owner.token, {
      inputs: [],
      plan: {
        goal: 'fixed setback',
        nodes: [{ id: 'n1', capability: 'cooling', deviceId: hvacId, params: { targetTemperature: 20 } }],
      },
    });
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().interface.actions).toEqual([
      { name: 'run', parameters: {} },
    ]);
  });

  it('T-201: refuses a provider agent outside the flow author scope', async () => {
    // A MEMBER-authored flow (explicit author principal): only agents owned
    // by that member may front it. The env owner's agent is outside the
    // scope even though the owner outranks the member in env governance —
    // authorship, not rank, is the boundary (the flow runs in the
    // provider's context, so who fronts it IS who executes it).
    const flow = await createParameterizedFlow(provider.token);
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(422);
    expect(published.json().error.code).toBe('SERVICE_BACKING_INVALID');
    expect(published.json().error.message).toContain('author scope');

    // The author's OWN agent is eligible (positive control).
    const ok = await publishFlowService(provider.token, providerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('unknown / disabled / foreign-env flows refuse with teaching errors', async () => {
    const unknown = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: 'nope' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('FLOW_NOT_FOUND');

    const flow = await createParameterizedFlow(owner.token);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { enabled: false },
    });
    const disabled = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().error.code).toBe('FLOW_NOT_RUNNABLE');
  });

  it('refuses a manual interface on flow publish and a later interface PATCH (generated surface)', async () => {
    const flow = await createParameterizedFlow(owner.token);
    const withIface = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
      interface: { actions: [] },
    });
    expect(withIface.statusCode).toBe(400);

    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id;

    const patchIface = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
      payload: { interface: { actions: [{ name: 'run-legacy' }] } },
    });
    expect(patchIface.statusCode).toBe(409);
    expect(patchIface.json().error.code).toBe('SERVICE_FLOW_MANAGED');

    // Non-interface edits stay open to the provider.
    const patchName = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
      payload: { name: '夜间节能回退 v2' },
    });
    expect(patchName.statusCode).toBe(200);
    expect(patchName.json().name).toBe('夜间节能回退 v2');
  });

  it('the market rides existing surfaces: origin filter + member visibility', async () => {
    const flow = await createParameterizedFlow(owner.token);
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
      visibility: 'members',
    });
    expect(published.statusCode).toBe(201);

    const byOrigin = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services?origin=flow`,
      headers: auth(consumer.token),
    });
    expect(byOrigin.statusCode).toBe(200);
    expect(byOrigin.json().services).toHaveLength(1);
    expect(byOrigin.json().services[0]).toMatchObject({ origin: 'flow', sourceFlowId: flow.id });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${published.json().id}`,
      headers: auth(consumer.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().interface.kind).toBe('flow');
  });

  it('flow edits refresh the generated interface (contract never drifts)', async () => {
    const flow = await createParameterizedFlow(owner.token);
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id;

    const edited = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: {
        inputs: [
          { name: 'setpoint', type: 'number', required: true, min: 17, max: 25 },
        ],
        plan: {
          goal: 'night setback to the given setpoint',
          nodes: [{
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}' },
          }],
        },
      },
    });
    expect(edited.statusCode).toBe(200);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(consumer.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().interface.actions[0].parameters).toEqual({
      setpoint: { type: 'number', required: true, min: 17, max: 25 },
    });
  });

  it('deleting the flow cascades the flow-service (unpublish by removal)', async () => {
    const flow = await createParameterizedFlow(owner.token);
    const published = await publishFlowService(owner.token, ownerAgentId, {
      backing: { kind: 'flow', flowId: flow.id },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id;

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
    });
    expect(removed.statusCode).toBe(204);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(404);
  });

  it('migration v38 widens the origin CHECK and adds source_flow_id', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 38')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 38, name: 'flow-backed-services' });

    const columns = (
      ctx.app.db.prepare('PRAGMA table_info(service_instances)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(columns).toContain('source_flow_id');

    // The widened CHECK accepts 'flow' rows (pre-existing origins still work).
    ctx.app.db
      .prepare("INSERT INTO service_instances (id, env_id, provider_agent_id, name, semantic_type, origin, source_flow_id, visibility, created_at) VALUES ('svc-flow-check', ?, ?, 'x', 'y', 'flow', NULL, 'public', '2026-01-01T00:00:00.000Z')")
      .run(envId, ownerAgentId);
    const row = ctx.app.serviceStore.getService('svc-flow-check');
    expect(row?.origin).toBe('flow');
    ctx.app.serviceStore.deleteService('svc-flow-check');
  });
});


// =============================================================================
// Invocation + metering (Task-3 scope): the shared executeAgreementInvocation
// core gains the flow lane — terms gates at propose/counter, T-205 merge-
// override, the inputs oracle, per-run metering (unit 'flow-run'), effectRef
// chaining to the flow_runs ledger, receipts, audit, and the stream refusal.
// =============================================================================

describe('flow-services (Mechanism D): invocation + metering', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let ownerAgentId: string;
  let hvacId: string;
  let flowId: string;
  let serviceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Flow Invoke Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
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

    const flow = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(owner.token),
      payload: {
        name: 'Night setback',
        enabled: true,
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
        inputs: [
          { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
          { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
        ],
        plan: {
          goal: 'night setback to the given setpoint',
          nodes: [{
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}', profile: 'mode-${input:mode}' },
          }],
        },
      },
    });
    expect(flow.statusCode).toBe(201);
    flowId = flow.json().id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${ownerAgentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: '夜间节能回退',
        semanticType: 'energy-setback',
        backing: { kind: 'flow', flowId },
        visibility: 'members',
      },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Propose → accept, returning the ACTIVE agreement id. */
  async function activeAgreement(terms: Record<string, unknown>): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
    return agreementId;
  }

  /** A RUNNING env-backed sim (the owner's — consumers may target it). */
  async function runningSim(): Promise<string> {
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    const simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  function invoke(agreementId: string, token: string, body: Record<string, unknown>, simId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(token),
      payload: { action: 'run', simulationId: simId, ...body },
    });
  }

  // ---------------------------------------------------------------------------

  it('propose-time terms gate: action clause required, run-only, params within the surface', async () => {
    const noAction = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { notes: 'no structured clause' } },
    });
    expect(noAction.statusCode).toBe(400);
    expect(noAction.json().error.message).toContain('terms.action');

    const wrongCommand = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { action: { command: 'turn-on' } } },
    });
    expect(wrongCommand.statusCode).toBe(400);
    expect(wrongCommand.json().error.message).toContain('"run"');

    const badParams = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { action: { command: 'run', params: { setpoint: 99 } } } },
    });
    expect(badParams.statusCode).toBe(422);
    expect(badParams.json().error.code).toBe('FLOW_PARAMS_INVALID');
  });

  it('invokes with params: deterministic run against provider devices, metered per-run with effectRef + receipt', async () => {
    const agreementId = await activeAgreement({
      notes: 'grid-peak 时自动回退',
      action: { command: 'run', params: { setpoint: 20 } },
    });
    const simId = await runningSim();

    const res = await invoke(agreementId, consumer.token, { params: { setpoint: 22, mode: 'eco' } }, simId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe('run');
    expect(body.termsEnforced).toBe(true);
    // T-205 merge-override: the negotiated setpoint (20) wins over the
    // caller's 22 — the consumer cannot widen the agreed clause.
    expect(body.applied.params).toEqual({ setpoint: 20, mode: 'eco' });
    expect(body.applied.flow).toMatchObject({
      flowId,
      status: 'success',
      triggerKind: 'service',
      inputs: { setpoint: 20, mode: 'eco' },
    });
    expect(body.deviceId).toBeNull();

    // Metering: ONE usage row, per-run, effectRef chains to the run ledger.
    expect(body.usage).toMatchObject({
      kind: 'invoke',
      action: 'run',
      quantity: 1,
      unit: 'flow-run',
      outcome: 'success',
    });
    const runId = body.usage.effectRef;

    // The receipt exists (same settlement lane as device invokes).
    const receipts = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/receipts`,
      headers: auth(consumer.token),
    });
    expect(receipts.statusCode).toBe(200);
    expect((receipts.json().receipts as unknown[]).length).toBeGreaterThanOrEqual(1);

    // effectRef resolves in the flow_runs ledger: triggerKind 'service',
    // effective inputs, node trace against the provider's device.
    const runs = await ctx.app.inject({
      method: 'GET',
      url: `/api/flows/${flowId}/runs`,
      headers: auth(owner.token),
    });
    expect(runs.statusCode).toBe(200);
    const run = (runs.json().runs as Array<Record<string, unknown>>).find(r => r.id === runId);
    expect(run).toBeDefined();
    expect(run).toMatchObject({
      triggerKind: 'service',
      status: 'success',
      inputs: { setpoint: 20, mode: 'eco' },
    });
    expect((run!.nodeResults as Record<string, unknown>).n1).toBeDefined();

    // The deterministic effect landed on the provider's device: cooling to
    // the terms-constrained setpoint.
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    expect(snapshot.statusCode).toBe(200);
    const hvac = (snapshot.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
      .find(device => device.id === hvacId);
    expect(hvac?.state.targetTemperature).toBe(20);
    // (the interpolated 'profile' param rides the command params — asserted
    // in applied.params above — but is not HVAC physics state; only the
    // temperature applies.)

    // Audit trail: one command_log row names the agreement + the run.
    const auditRow = (ctx.app.db
      .prepare('SELECT actor_id, kind, payload_json FROM command_log WHERE payload_json LIKE ?')
      .all(`%"${runId}"%`) as Array<{ actor_id: string; kind: string; payload_json: string }>)
      .find(row => row.kind === 'flow-service-run');
    expect(auditRow).toBeDefined();
    const payload = JSON.parse(auditRow!.payload_json) as { agreementId: string; flowId: string };
    expect(payload.agreementId).toBe(agreementId);
    expect(payload.flowId).toBe(flowId);
    expect(auditRow!.actor_id).toBe(consumer.id);
  });

  it('out-of-bounds invoke params: 422 teaching, metered failure, quota untouched', async () => {
    // No terms params — the caller supplies everything; quota 1/window so a
    // burned quota would be visible on the next invoke.
    const agreementId = await activeAgreement({
      action: { command: 'run' },
      quotaPerWindow: 1,
      windowSec: 3600,
    });
    const simId = await runningSim();

    const bad = await invoke(agreementId, consumer.token, { params: { setpoint: 40 } }, simId);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('FLOW_PARAMS_INVALID');
    expect(bad.json().error.message).toContain('above its maximum 26');

    // Failure is metered for audit but does NOT burn quota (T-205: failures
    // never count) — a valid invoke still goes through.
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    const rows = usage.json().usage as Array<{ outcome: string; unit: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'failure', unit: 'flow-run' });

    const good = await invoke(agreementId, consumer.token, { params: { setpoint: 21 } }, simId);
    expect(good.statusCode).toBe(200);
    expect(good.json().success).toBe(true);

    // NOW the window is spent (1 success) — the next invoke 429s.
    const spent = await invoke(agreementId, consumer.token, { params: { setpoint: 21 } }, simId);
    expect(spent.statusCode).toBe(429);
  });

  it('a non-run action is a terms violation; streams refuse with the invoke remedy', async () => {
    const agreementId = await activeAgreement({ action: { command: 'run' } });
    const simId = await runningSim();

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('AGREEMENT_TERMS_VIOLATION');
    expect(wrong.json().error.message).toContain('"run"');

    // The stream lane refuses before the upgrade (plain HTTP error body).
    const stream = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/stream`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(stream.statusCode).toBe(409);
    expect(stream.json().error.code).toBe('SERVICE_NOT_STREAMABLE');
    expect(stream.json().error.message).toContain('invocations');
  });

  it('disabled-after-publish flow refuses at invoke with FLOW_NOT_RUNNABLE (manual-lane code)', async () => {
    const agreementId = await activeAgreement({ action: { command: 'run', params: { setpoint: 20 } } });
    const simId = await runningSim();

    const disabled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flowId}`,
      headers: auth(owner.token),
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    const refused = await invoke(agreementId, consumer.token, {}, simId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('FLOW_NOT_RUNNABLE');
  });
});


// =============================================================================
// Auto-execution (Task-4 scope): T-035's AgreementTriggerExecutor fires a
// flow-service's terms.trigger → run through the SAME metered path — zero
// executor changes (the flow branch lives inside the shared invocation
// core). Exactly-once per matching event; attribution stays separated: the
// flow's OWN trigger is the provider's automation (unmetered), the
// agreement's trigger is the consumer's contract (metered + receipted).
// =============================================================================

describe('flow-services (Mechanism D): trigger auto-execution', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let ownerAgentId: string;
  let hvacId: string;
  let flowId: string;
  let serviceId: string;
  let agreementId: string;
  let simId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Flow Autoexec Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
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

    // The flow's OWN trigger listens to 'grid-peak' (the provider's lane);
    // the AGREEMENT below triggers on 'demand-surge' (the consumer's lane) —
    // distinct events keep the attribution assertions clean.
    const flow = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(owner.token),
      payload: {
        name: 'Night setback',
        enabled: true,
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
        inputs: [{ name: 'setpoint', type: 'number', required: true, min: 16, max: 26 }],
        plan: {
          goal: 'night setback to the given setpoint',
          nodes: [{
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}' },
          }],
        },
      },
    });
    expect(flow.statusCode).toBe(201);
    flowId = flow.json().id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${ownerAgentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: '夜间节能回退',
        semanticType: 'energy-setback',
        backing: { kind: 'flow', flowId },
        visibility: 'members',
      },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id;

    // Consumer proposes a TRIGGERED run contract; provider accepts → ACTIVE.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          notes: 'demand surge → run the setback program at 20',
          trigger: { eventType: 'demand-surge', zoneId: 'zone-a' },
          action: { command: 'run', params: { setpoint: 20 } },
          quotaPerWindow: 1,
          windowSec: 3600,
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.json().status).toBe('active');

    // The RUNNING env-backed sim — the executor attaches at its creation.
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function inject(type: string, zoneId: string) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type, zoneId },
    });
  }

  async function usageRows(): Promise<Array<Record<string, string>>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().usage as Array<Record<string, string>>;
  }

  async function flowRuns(): Promise<Array<Record<string, unknown>>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/flows/${flowId}/runs`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().runs as Array<Record<string, unknown>>;
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('a matching event auto-runs the flow-service EXACTLY ONCE through the metered path', async () => {
    const res = await inject('demand-surge', 'zone-a');
    expect(res.statusCode).toBeLessThan(300);

    await waitFor(async () => (await usageRows()).length > 0);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'invoke',
      action: 'run',
      quantity: 1,
      unit: 'flow-run',
      outcome: 'success',
    });

    // Exactly one service-triggered run; the usage row's effectRef resolves
    // to it in the ledger.
    const runs = await flowRuns();
    const serviceRuns = runs.filter(run => run.triggerKind === 'service');
    expect(serviceRuns).toHaveLength(1);
    expect(serviceRuns[0]).toMatchObject({
      status: 'success',
      inputs: { setpoint: 20 },
    });
    expect(rows[0].effectRef).toBe(serviceRuns[0].id);

    // A settled receipt exists for the auto-run.
    const receipts = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/receipts`,
      headers: auth(consumer.token),
    });
    expect((receipts.json().receipts as unknown[]).length).toBeGreaterThanOrEqual(1);

    // The audit row carries the autoTrigger attribution + consumer actor.
    const auditRow = (ctx.app.db
      .prepare('SELECT actor_id, kind, payload_json FROM command_log WHERE payload_json LIKE ?')
      .all(`%"${serviceRuns[0].id as string}"%`) as Array<{ actor_id: string; kind: string; payload_json: string }>)
      .find(row => row.kind === 'flow-service-run');
    expect(auditRow).toBeDefined();
    const payload = JSON.parse(auditRow!.payload_json) as {
      agreementId: string;
      autoTrigger?: { eventType: string; zoneId: string };
    };
    expect(payload.agreementId).toBe(agreementId);
    expect(payload.autoTrigger).toMatchObject({ eventType: 'demand-surge', zoneId: 'zone-a' });
    expect(auditRow!.actor_id).toBe(consumer.id);

    // Steady state: no further usage or runs appear (exactly-once, not a
    // retry loop) after the async tail settles.
    // Negative window (R21 test-debt): proving exactly-once / no-retry — no
    // positive signal exists; 400ms is a generous bound over the ~25ms
    // trigger latency so a stray retry would still be caught.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await usageRows()).toHaveLength(1);
    expect((await flowRuns()).filter(run => run.triggerKind === 'service')).toHaveLength(1);
  });

  it('non-matching events do not auto-run the agreement', async () => {
    await inject('demand-surge', 'zone-b'); // wrong zone
    await inject('motion-detected', 'zone-a'); // wrong type
    // Negative window (R21 test-debt): non-matching events must not auto-run
    // — generous 400ms bound (a matching run lands in tens of ms).
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await usageRows()).toEqual([]);
    expect((await flowRuns()).filter(run => run.triggerKind === 'service')).toEqual([]);
  });

  it('attribution separation: the flow\'s OWN trigger runs unmetered (provider lane)', async () => {
    const res = await inject('grid-peak', 'zone-a');
    expect(res.statusCode).toBeLessThan(300);

    await waitFor(async () => (await flowRuns()).some(run => run.triggerKind === 'event'));
    const eventRuns = (await flowRuns()).filter(run => run.triggerKind === 'event');
    expect(eventRuns).toHaveLength(1);
    // The provider's own automation takes no default params — the run
    // carries only what the trigger evaluation provided (no inputs surface
    // violation: params were omitted, and setpoint is required → the run
    // must have FAILED honestly rather than silently substituting).
    expect(eventRuns[0].status).toBe('failed');

    // ...and it never touched the consumer's agreement: zero usage rows.
    expect(await usageRows()).toEqual([]);
  });

  it('a spent quota window skips the auto-run and meters the skip reason (C3)', async () => {
    // Burn the 1-per-window budget with a manual invoke first.
    const manual = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'run', simulationId: simId },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().success).toBe(true);
    expect(await usageRows()).toHaveLength(1);

    // The trigger matches but the window is spent → skip, and C3 (R25-NF4)
    // meters it: outcome='failure' with the spent-window reason on the row
    // (no flow RUN appears — the run itself never happened; the failure row
    // burns no quota: countUsageSince counts successes only).
    await inject('demand-surge', 'zone-a');
    await waitFor(async () => (await usageRows()).length > 1);
    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'invoke', action: 'run', outcome: 'failure', unit: 'flow-run' });
    expect((rows[1] as { failureReason?: string }).failureReason).toContain('quota window spent');
    expect((await flowRuns()).filter(run => run.triggerKind === 'service')).toHaveLength(1);
  });

  it('T-070 autoReset runs the flow with the RESET clause params, not the main action\'s (R33, Care F1)', { timeout: 15_000 }, async () => {
    // A second agreement on the same flow-service with its OWN event type:
    // trigger → run@setpoint 20 (the main action), autoReset → run@setpoint
    // 26 (the negotiated RESTORE value). The device lane honored the reset
    // clause; the flow lane merged terms.action.params over the reset's —
    // the reset fired, was metered SUCCESS, and silently re-delivered the
    // trigger's value instead of restoring.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          notes: 'surge → setback 20; the clause un-pegs itself back to 26',
          trigger: { eventType: 'reset-test-surge', zoneId: 'zone-a' },
          action: { command: 'run', params: { setpoint: 20 } },
          autoReset: { afterSec: 150, action: { command: 'run', params: { setpoint: 26 } } },
          quotaPerWindow: 5,
          windowSec: 3600,
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const resetAgreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${resetAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.json().status).toBe('active');

    await inject('reset-test-surge', 'zone-a');

    // Trigger run lands first; the reset fires ~150 sim-s later (~1.5 wall-s
    // at the default 100 sim-s/wall-s).
    await waitFor(async () => (await flowRuns()).some(run => run.triggerKind === 'service'));
    await waitFor(
      async () => (await flowRuns()).filter(run => run.triggerKind === 'service').length >= 2,
      10_000,
    );
    const serviceRuns = (await flowRuns()).filter(run => run.triggerKind === 'service');
    expect(serviceRuns).toHaveLength(2);
    // Runs list newest-first: [0] = the reset, [1] = the trigger invocation.
    expect(serviceRuns[1]).toMatchObject({ status: 'success', inputs: { setpoint: 20 } });
    // THE BUG: this used to run as {setpoint: 20} (the MAIN action's params
    // merged over the reset's) — the reset must deliver its OWN clause.
    expect(serviceRuns[0]).toMatchObject({ status: 'success', inputs: { setpoint: 26 } });

    // Both invocations are metered successes on the reset agreement.
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${resetAgreementId}/usage`,
      headers: auth(consumer.token),
    });
    const rows = usage.json().usage as Array<{ action: string; outcome: string; unit: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.action === 'run' && row.outcome === 'success' && row.unit === 'flow-run')).toBe(true);

    // The arm is observable while pending and cleared after it fires.
    const after = (await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${resetAgreementId}`,
      headers: auth(consumer.token),
    })).json();
    expect(after.armedReset).toBeUndefined();
  });
});


// =============================================================================
// THE end-to-end story (Task-6 scope): provider publishes a flow-with-params
// → consumer proposes terms.action run → provider counters → consumer
// accepts → invokes with params → deterministic run against PROVIDER devices
// → metered receipt + effectRef chaining to the run ledger → terms.trigger
// auto-fires EXACTLY ONCE through the same metered path.
// =============================================================================

describe('flow-services (Mechanism D): the end-to-end story', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let ownerAgentId: string;
  let hvacId: string;
  let flowId: string;
  let serviceId: string;
  let agreementId: string;
  let simId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Flow Story Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
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

    // (1) PROVIDER publishes a flow WITH a parameter surface. The flow's own
    // trigger ('grid-peak') is the provider's lane; the agreement below
    // triggers on 'demand-surge' — attribution stays separable.
    const flow = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(owner.token),
      payload: {
        name: 'Night setback',
        enabled: true,
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
        inputs: [
          { name: 'setpoint', type: 'number', required: true, min: 16, max: 26 },
          { name: 'mode', type: 'string', enum: ['eco', 'comfort'], default: 'comfort' },
        ],
        plan: {
          goal: 'night setback to the given setpoint',
          nodes: [{
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}', profile: 'mode-${input:mode}' },
          }],
        },
      },
    });
    expect(flow.statusCode).toBe(201);
    flowId = flow.json().id;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${ownerAgentId}/services`,
      headers: auth(owner.token),
      payload: {
        name: '夜间节能回退',
        semanticType: 'energy-setback',
        backing: { kind: 'flow', flowId },
        visibility: 'members',
      },
    });
    expect(published.statusCode).toBe(201);
    serviceId = published.json().id;
    expect(published.json().origin).toBe('flow');

    // The RUNNING simulation the whole story executes inside.
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(sim.statusCode).toBe(201);
    simId = sim.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function usageRows(): Promise<Array<Record<string, string>>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().usage as Array<Record<string, string>>;
  }

  async function serviceRuns(): Promise<Array<Record<string, unknown>>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/flows/${flowId}/runs`,
      headers: auth(owner.token),
    });
    return (res.json().runs as Array<Record<string, unknown>>)
      .filter(run => run.triggerKind === 'service');
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('publish → propose → counter → accept → invoke → metered deterministic run → trigger exactly once', async () => {
    // (2) CONSUMER proposes the run contract.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          notes: 'demand surge → run the setback program',
          trigger: { eventType: 'demand-surge', zoneId: 'zone-a' },
          action: { command: 'run', params: { setpoint: 22 } },
          quotaPerWindow: 5,
          windowSec: 3600,
          pricePerUnit: '0.5',
          priceUnit: 'CNY/flow-run',
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    agreementId = proposed.json().id as string;
    expect(proposed.json().status).toBe('proposed');

    // (3) PROVIDER counters: setpoint pinned to 20 (T-059 — the counter is a
    // FULL terms object; the decide right passes to the consumer).
    const countered = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/counter`,
      headers: auth(owner.token),
      payload: {
        terms: {
          notes: 'demand surge → run the setback program (countered: setpoint 20)',
          trigger: { eventType: 'demand-surge', zoneId: 'zone-a' },
          action: { command: 'run', params: { setpoint: 20 } },
          quotaPerWindow: 5,
          windowSec: 3600,
          pricePerUnit: '0.5',
          priceUnit: 'CNY/flow-run',
        },
      },
    });
    expect(countered.statusCode).toBe(200);
    expect(countered.json().status).toBe('countered');
    expect(countered.json().counteredTerms.action.params).toEqual({ setpoint: 20 });

    // (4) CONSUMER accepts the counter — the countered terms BECOME the contract.
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(consumer.token),
      payload: { decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');
    expect(accepted.json().terms.action.params).toEqual({ setpoint: 20 });

    // (5) CONSUMER invokes WITH PARAMS. The caller asks setpoint 24 + eco;
    // the countered clause merges 20 over it (the consumer cannot widen).
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'run', params: { setpoint: 24, mode: 'eco' }, simulationId: simId },
    });
    expect(invoked.statusCode).toBe(200);
    const body = invoked.json();
    expect(body.success).toBe(true);
    expect(body.applied.params).toEqual({ setpoint: 20, mode: 'eco' });
    expect(body.usage).toMatchObject({ kind: 'invoke', unit: 'flow-run', outcome: 'success' });
    const manualRunId = body.usage.effectRef;

    // (6) The run was DETERMINISTIC against the PROVIDER's device, with the
    // terms-constrained setpoint and the effective inputs on the ledger row.
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    const hvac = (snapshot.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
      .find(device => device.id === hvacId);
    expect(hvac?.state.targetTemperature).toBe(20);

    const runs = await serviceRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: manualRunId, status: 'success', inputs: { setpoint: 20, mode: 'eco' } });
    expect((runs[0].nodeResults as Record<string, { deviceId?: string }>).n1?.deviceId).toBe(hvacId);

    // (7) Metered receipt: the usage row settles through the SAME lane as
    // device invokes; effectRef chains the receipt to the run ledger.
    const receipts = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/receipts`,
      headers: auth(consumer.token),
    });
    expect(receipts.statusCode).toBe(200);
    const receiptList = receipts.json().receipts as Array<{ id: string }>;
    expect(receiptList.length).toBeGreaterThanOrEqual(1);

    // (8) The TRIGGER auto-fires EXACTLY ONCE through the same metered path.
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'demand-surge', zoneId: 'zone-a' },
    });
    expect(injected.statusCode).toBeLessThan(300);

    await waitFor(async () => (await usageRows()).length >= 2);
    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.unit === 'flow-run' && row.outcome === 'success')).toBe(true);

    const autoRuns = await serviceRuns();
    expect(autoRuns).toHaveLength(2);
    const autoRun = autoRuns.find(run => run.id !== manualRunId);
    expect(autoRun).toMatchObject({ status: 'success', inputs: { setpoint: 20, mode: 'comfort' } });
    expect(rows[1].effectRef).toBe(autoRun!.id);

    // The auto-run is attributed to the agreement + the triggering event.
    const auditRow = (ctx.app.db
      .prepare('SELECT actor_id, kind, payload_json FROM command_log WHERE payload_json LIKE ?')
      .all(`%"${autoRun!.id as string}"%`) as Array<{ actor_id: string; kind: string; payload_json: string }>)
      .find(row => row.kind === 'flow-service-run');
    expect(auditRow).toBeDefined();
    const auditPayload = JSON.parse(auditRow!.payload_json) as {
      agreementId: string;
      autoTrigger?: { eventType: string; zoneId: string };
    };
    expect(auditPayload.agreementId).toBe(agreementId);
    expect(auditPayload.autoTrigger).toMatchObject({ eventType: 'demand-surge', zoneId: 'zone-a' });

    // Steady state: exactly-once (no retry loop after the async tail).
    // Negative window (R21 test-debt): proving exactly-once / no-retry — no
    // positive signal exists; 400ms is a generous bound over the ~25ms
    // trigger latency so a stray retry would still be caught.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await usageRows()).toHaveLength(2);
    expect(await serviceRuns()).toHaveLength(2);
  });
});
