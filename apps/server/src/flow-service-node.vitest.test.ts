/**
 * @vitest-environment node
 *
 * R6-B-F03 — flow SERVICE nodes (the cross-owner orchestration carrier),
 * server-side wiring of FlowServiceNodeExecutor.
 *
 * The executor was a dead class (never instantiated): core's FlowEngine
 * honestly failed every service node with "no service-invocation lane
 * wired". The registry-seam wiring (mirroring the FEAT-05 notify executor)
 * now attaches one agreement-mediated FlowServiceInvoker per env-backed
 * runtime, so:
 *   - a service node whose flow author holds NO active agreement fails
 *     honestly with the teaching move (sign one first) — never a silent
 *     skip, never the unwired-lane error;
 *   - with an ACTIVE agreement the node runs through the SAME unified
 *     invocation core as manual invokes (executeAgreementInvocation):
 *     metered UsageRecord + settlement receipt, ids riding the node result.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineRuntime } from '@active-collaboration/core';

import type { AgreementRoutesContext } from './agreements/index.js';
import { FlowServiceNodeExecutor } from './flow-service-node-executor.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('flow service nodes (R6-B-F03): executor wiring + governed lane', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let serviceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('flow-service-node-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    serviceId = turnOn!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createServiceFlow(token: string) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/flows`,
      headers: auth(token),
      payload: {
        name: 'Orchestrated setback',
        enabled: true,
        trigger: { kind: 'event', eventType: 'grid-peak', zoneId: 'zone-a' },
        plan: {
          goal: 'turn the HVAC on through the provider contract',
          nodes: [{ id: 'n1', service: { serviceId } }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }

  async function createSimulation(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function signActiveAgreement(): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { notes: 'consumer orchestrates the HVAC', action: { command: 'turn-on' } } },
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

  it('attach() sets the FlowServiceInvoker on the runtime (registry seam)', () => {
    const executor = new FlowServiceNodeExecutor({} as AgreementRoutesContext);
    let wired: unknown;
    executor.attach(envId, {
      setFlowServiceInvoker: (invoker: unknown) => { wired = invoker; },
    } as unknown as EngineRuntime);
    expect(wired).toBeTypeOf('function');
  });

  it('no active agreement: the node fails honestly with the signing move (not the unwired-lane error)', async () => {
    const flow = await createServiceFlow(consumer.token);
    const simId = await createSimulation();

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(consumer.token),
    });
    expect(run.statusCode).toBe(200);
    const record = run.json().run;
    expect(record.status).toBe('failed');
    const node = record.nodeResults.n1;
    expect(node.status).toBe('failed');
    // The wired lane's teaching error — before wiring, core answered
    // "no service-invocation lane wired" for every service node.
    expect(node.error).toContain('NO active agreement');
    expect(node.error).toContain(`POST /api/services/${serviceId}/agreements`);
    expect(node.error).not.toContain('no service-invocation lane wired');
  });

  it('active agreement: the node runs through the unified metered invocation lane', async () => {
    const agreementId = await signActiveAgreement();
    const flow = await createServiceFlow(consumer.token);
    const simId = await createSimulation();

    const run = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/flows/${flow.id}/run`,
      headers: auth(consumer.token),
    });
    expect(run.statusCode).toBe(200);
    const record = run.json().run;
    expect(record.status).toBe('success');
    const node = record.nodeResults.n1;
    expect(node.status).toBe('succeeded');
    // The unified lane's receipts ride the node result.
    expect(node.result.agreementId).toBe(agreementId);
    expect(node.result.serviceId).toBe(serviceId);
    expect(node.result.action).toBe('turn-on');
    expect(typeof node.result.usageId).toBe('string');
    expect(typeof node.result.receiptId).toBe('string');

    // Metered exactly like a manual invoke: one UsageRecord row.
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.statusCode).toBe(200);
    const rows = usage.json().usage as Array<{ kind: string; action: string; outcome: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'invoke', action: 'turn-on', outcome: 'success' });
  });
});
