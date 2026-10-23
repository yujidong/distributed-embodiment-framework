/**
 * @vitest-environment node
 *
 * Mechanism B — the agent-invocation flag, server side (migration v40):
 *   - the `agentInvocable` body field on create/PATCH (boolean, default
 *     off; verbatim storage; merged-candidate re-validation)
 *   - the runtime-facing definition (flowsProvider) carries the flag
 *   - scenario-JSON import survives the hop (four-channel promise)
 *   - the run ledger records agent-run attribution (invokedBy agentId +
 *     eventId — the (agentId, eventId) pair that joins runs to decisions)
 *
 * The governed execution lane itself (LLM decision → FlowEngine.runAsAgent
 * → triggerKind 'agent') is exercised end-to-end in core's
 * EngineRuntime.flows-agent-invoked suite; here we prove the storage +
 * wire contract that lane lands on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FlowRunRecord } from '@active-collaboration/core';

import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('flow agent-invocable flag (Mechanism B)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let builder: TestUser;
  let envId: string;
  let hvacId: string;
  let ownerAgentId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    builder = await registerUser(ctx.app, { displayName: 'Builder' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Invocable Lab',
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

  function flowBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Night setback',
      enabled: true,
      trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
      inputs: [{ name: 'setpoint', type: 'number', required: true, min: 16, max: 26 }],
      plan: {
        goal: 'parameterized setback',
        nodes: [
          {
            id: 'n1', capability: 'cooling', deviceId: hvacId,
            params: { targetTemperature: '${input:setpoint}' },
          },
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
      payload: flowBody(overrides),
    });
  }

  // ---------------------------------------------------------------------------

  it('migration v40 adds flows.agent_invocable + flow_runs.invoked_by_*', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 40')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 40, name: 'flow-agent-invocable' });
    const flowColumns = (
      ctx.app.db.prepare('PRAGMA table_info(flows)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(flowColumns).toContain('agent_invocable');
    const runColumns = (
      ctx.app.db.prepare('PRAGMA table_info(flow_runs)').all() as Array<{ name: string }>
    ).map(column => column.name);
    expect(runColumns).toContain('invoked_by_agent_id');
    expect(runColumns).toContain('invoked_by_event_id');
    // The flag defaults OFF (existing rows stay not-invocable).
    const row = ctx.app.db
      .prepare('SELECT agent_invocable FROM flows LIMIT 1')
      .all() as Array<{ agent_invocable: number }>;
    for (const existing of row) expect(existing.agent_invocable).toBe(0);
  });

  it('creates a flow with the flag, stored verbatim and served back (default = absent)', async () => {
    const plain = await createFlow(owner.token);
    expect(plain.statusCode).toBe(201);
    expect(plain.json().agentInvocable).toBeUndefined();

    const flagged = await createFlow(owner.token, { agentInvocable: true });
    expect(flagged.statusCode).toBe(201);
    expect(flagged.json().agentInvocable).toBe(true);

    const fetched = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flagged.json().id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().agentInvocable).toBe(true);

    // The runtime-facing definition (flowsProvider) carries the flag — the
    // offering + gate oracle reads exactly this shape.
    const def = ctx.app.flowStore.listEnabled(envId, owner.id)
      .find(f => f.id === flagged.json().id);
    expect(def?.agentInvocable).toBe(true);
  });

  it('400s a non-boolean flag (teaching, not silent)', async () => {
    expect((await createFlow(owner.token, { agentInvocable: 'yes' })).statusCode).toBe(400);
    expect((await createFlow(owner.token, { agentInvocable: 1 })).statusCode).toBe(400);
  });

  it('PATCH toggles the flag and re-validates the merged candidate', async () => {
    const flow = (await createFlow(owner.token)).json();
    expect(flow.agentInvocable).toBeUndefined();

    const on = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { agentInvocable: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().agentInvocable).toBe(true);
    expect(ctx.app.flowStore.getById(flow.id)!.agent_invocable).toBe(1);

    const off = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { agentInvocable: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().agentInvocable).toBeUndefined();
    expect(ctx.app.flowStore.getById(flow.id)!.agent_invocable).toBe(0);

    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/flows/${flow.id}`,
      headers: auth(owner.token),
      payload: { agentInvocable: 'true' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('scenario-JSON import survives the hop (embedded flows keep the flag)', async () => {
    const importResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        meta: { id: 'imported-invocable-world', name: 'Imported world' },
        visibility: 'public',
        zones: [{ id: 'zone-a', name: 'Zone A' }],
        devices: [
          { id: 'dev-hvac', name: 'HVAC', type: 'hvac', capabilities: ['cooling'], zoneId: 'zone-a' },
        ],
        agents: [
          { id: 'agent-hvac', name: 'A', capabilities: ['cooling'], boundDeviceIds: ['dev-hvac'], managesZoneIds: ['zone-a'] },
        ],
        events: [],
        flows: [
          {
            id: 'embedded-invocable',
            name: 'Embedded invocable',
            enabled: true,
            agentInvocable: true,
            trigger: { kind: 'schedule', everySimSec: 600 },
            plan: {
              goal: 'g',
              nodes: [{ id: 'n1', capability: 'cooling', assigneeAgentId: 'agent-hvac' }],
            },
          },
        ],
      },
    });
    expect(importResponse.statusCode).toBe(201);
    const importedEnvId = importResponse.json().id;
    const flows = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${importedEnvId}/flows`,
    });
    expect(flows.statusCode).toBe(200);
    const embedded = flows.json().flows.find((f: { name: string }) => f.name === 'Embedded invocable');
    expect(embedded).toBeDefined();
    expect(embedded.agentInvocable).toBe(true);
  });

  it('the run ledger persists agent-run attribution and serves it back (invokedBy join key)', async () => {
    const flow = (await createFlow(owner.token, { agentInvocable: true })).json();
    // The registry's onFlowRun listener hands records to recordRun — the
    // shape an agent-triggered run produces (triggerKind 'agent' +
    // invokedBy; the core EngineRuntime suite proves the lane end to end).
    const record: FlowRunRecord = {
      runId: `run-agent-${Date.now()}`,
      flowId: flow.id,
      triggerKind: 'agent',
      status: 'success',
      summary: 'plan success',
      nodeResults: {},
      inputs: { setpoint: 20 },
      invokedBy: { agentId: ownerAgentId, eventId: 'evt-42' },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    ctx.app.flowStore.recordRun({ ...record, simulationId: 'sim-1' });

    const runs = await ctx.app.inject({ method: 'GET', url: `/api/flows/${flow.id}/runs` });
    expect(runs.statusCode).toBe(200);
    const run = runs.json().runs[0];
    expect(run.triggerKind).toBe('agent');
    expect(run.invokedBy).toEqual({ agentId: ownerAgentId, eventId: 'evt-42' });
    expect(run.inputs).toEqual({ setpoint: 20 });

    const row = ctx.app.db
      .prepare('SELECT invoked_by_agent_id, invoked_by_event_id FROM flow_runs WHERE id = ?')
      .get(run.id) as { invoked_by_agent_id: string | null; invoked_by_event_id: string | null };
    expect(row.invoked_by_agent_id).toBe(ownerAgentId);
    expect(row.invoked_by_event_id).toBe('evt-42');
  });
});
