/**
 * @vitest-environment node
 *
 * T128 (R20-u2 F1): the invoke lane's honest wait floor.
 *
 * The r20 outage: invoke awaits the provider agent's decision SYNCHRONOUSLY,
 * and in a slow/cold LLM window that wait blew through the public gateway's
 * 100s — the caller saw a bare 504, no platform teaching, and no way to know
 * the work was still running (u2: usage stayed empty, every contract hung).
 * This round is honest-ification, NOT async architecture: past the wait
 * floor (default 90s, under the gateway's kill) the route answers 503
 * INVOKE_DECISION_PENDING + retryAfterSec + Retry-After, and the execution
 * FINISHES in the background — its usage row and receipt land when the
 * decision completes, so the caller reconciles via `agreement usage` instead
 * of re-invoking into a double execution.
 *
 * The suite injects a 300ms wait floor and delays the device-command path
 * (the LLM-shaped window) well past it: the 503 must arrive at the floor,
 * not at execution completion, and the late metering must still land.
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

describe('T128: invoke answers 503 INVOKE_DECISION_PENDING past its honest wait floor — and still lands the metering', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner AND provider (owns the imported lab-agent)
  let consumer: TestUser; // builder member who signs + invokes
  let envId: string;
  /** Derived service "HVAC B: 开启" — provider = owner's lab-agent. */
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp({ invokeDecisionWaitMs: 300 });
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('agreement-lab'), visibility: 'public' },
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
    expect(turnOn).toBeTruthy();
    turnOnServiceId = turnOn!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function act(token: string, id: string, action: string, body?: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/${action}`,
      headers: auth(token),
      ...(body !== undefined ? { payload: body } : {}),
    });
  }

  function getSub(token: string, id: string, sub: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}/${sub}`,
      headers: auth(token),
    });
  }

  /** propose → accept; returns the active agreement id. */
  async function activeAgreement(): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    const decided = await act(owner.token, id, 'decide', { decision: 'accept' });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
    return id;
  }

  async function runningEnvSim(): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    return simId;
  }

  it('a slow provider decision: 503 + retryAfterSec at the floor, and the background execution still lands usage + receipt', async () => {
    const id = await activeAgreement();
    const simId = await runningEnvSim();

    // Simulate the slow-LLM window: the runtime's decision-backed device
    // command path takes ~1.5s wall — far past the 300ms floor this suite
    // injects, far under a real gateway kill. The patch rides the TARGET
    // record's runtime (the invoke pins this sim explicitly).
    const record = ctx.app.simulations.get(simId)!;
    const runtime = record.runtime as unknown as Record<string, unknown>;
    const original = (record.runtime.executeDeviceCommand as (...a: unknown[]) => Promise<unknown>).bind(record.runtime);
    runtime.executeDeviceCommand = async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return original(...args);
    };

    const startedAt = Date.now();
    const res = await act(consumer.token, id, 'invocations', { action: 'turn-on', simulationId: simId });
    const elapsedMs = Date.now() - startedAt;

    // The 503 envelope arrived at the floor (this side of any gateway kill),
    // NOT at execution completion.
    expect(res.statusCode).toBe(503);
    expect(elapsedMs).toBeLessThan(1200);
    const err = res.json().error as { code: string; message: string; retryAfterSec: number };
    expect(err.code).toBe('INVOKE_DECISION_PENDING');
    expect(typeof err.retryAfterSec).toBe('number');
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(err.retryAfterSec));
    // The teaching: the work is NOT lost, check usage, never re-invoke.
    expect(err.message).toContain('usage');
    expect(err.message).toContain('agreement usage');
    expect(err.message).toContain('决策仍在进行');
    expect(err.message).toContain('不要重复 invoke');

    // The detached execution completes and lands its metering — the promise
    // the 503 makes ("决策完成后计量正常落账") is checkable right here.
    let invokeRows: Array<{ kind: string; outcome: string }> = [];
    let receipts: Array<{ usageRecordIds: string[] }> = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const usage = await getSub(consumer.token, id, 'usage');
      expect(usage.statusCode).toBe(200);
      invokeRows = (usage.json().usage as Array<{ kind: string; outcome: string }>)
        .filter(row => row.kind === 'invoke');
      const receiptList = await getSub(consumer.token, id, 'receipts');
      receipts = receiptList.json().receipts as Array<{ usageRecordIds: string[] }>;
      if (invokeRows.length > 0 && receipts.length > 0) break;
    }
    expect(invokeRows).toHaveLength(1);
    expect(invokeRows[0]!.outcome).toBe('success');
    expect(receipts.length).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('a fast decision is untouched: the execution answers 200 inside the floor (no 503, metering inline)', async () => {
    const id = await activeAgreement();
    const simId = await runningEnvSim();

    const res = await act(consumer.token, id, 'invocations', { action: 'turn-on', simulationId: simId });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    const usage = await getSub(consumer.token, id, 'usage');
    expect((usage.json().usage as Array<{ kind: string; outcome: string }>)
      .filter(row => row.kind === 'invoke')).toHaveLength(1);
  });
});
