/**
 * @vitest-environment node
 *
 * Wave-4a (小林 R8 F-14): structured agreement terms — `trigger` / `action`.
 *
 * Covers: the closed-subschema validation of POST /api/services/:id/agreements
 * (valid shapes persist and echo; unknown keys and malformed values 400, in
 * the same style as the existing terms), and the ac-agreement-bridge backfill
 * that gives AC-sourced ephemeral agreements a structured trigger built from
 * the collaboration's triggering event type + requiredCapabilities.
 *
 * trigger/action are contract data in THIS suite: the closed-subschema
 * validation and the AC-bridge backfill. Automatic trigger execution
 * landed in T-035 (R17) — see agreements-trigger-autoexec.vitest.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventType, type EngineRuntime } from '@active-collaboration/core';

import { AcAgreementBridge } from './ac-agreement-bridge.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('agreement terms trigger/action (Wave-4a)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('terms-trigger-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

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
    turnOnServiceId = turnOn!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function proposeWithTerms(terms: unknown) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms },
    });
  }

  it('persists and echoes a valid structured trigger + action', async () => {
    const res = await proposeWithTerms({
      notes: 'grid-peak 时调回 26°C',
      trigger: { eventType: 'grid-peak', parameter: 'temperature', threshold: 26, zoneId: 'zone-a' },
      action: { command: 'set-temperature', params: { value: 26 } },
    });
    if (res.statusCode !== 201) console.error('PROPOSE_422', JSON.stringify(res.json()));
    expect(res.statusCode).toBe(201);
    expect(res.json().terms).toEqual({
      notes: 'grid-peak 时调回 26°C',
      trigger: { eventType: 'grid-peak', parameter: 'temperature', threshold: 26, zoneId: 'zone-a' },
      action: { command: 'set-temperature', params: { value: 26 } },
    });
  });

  it('rejects an unknown trigger field with 400 naming the allowed keys', async () => {
    const res = await proposeWithTerms({ trigger: { eventType: 'grid-peak', cron: '0 18 * * *' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('terms.trigger.cron');
    expect(res.json().error.message).toContain('eventType');
  });

  it('rejects a non-numeric trigger threshold', async () => {
    const res = await proposeWithTerms({ trigger: { threshold: 'high' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('terms.trigger.threshold');
  });

  it('rejects an action without a command', async () => {
    const res = await proposeWithTerms({ action: { params: { value: 26 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('terms.action.command');
  });

  it('rejects an unknown action field and a non-object action.params', async () => {
    const unknownField = await proposeWithTerms({ action: { command: 'set-temperature', delay: 5 } });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().error.message).toContain('terms.action.delay');

    const badParams = await proposeWithTerms({ action: { command: 'set-temperature', params: [26] } });
    expect(badParams.statusCode).toBe(400);
    expect(badParams.json().error.message).toContain('terms.action.params');
  });

  it('still rejects unknown top-level terms keys (closed schema unchanged)', async () => {
    const res = await proposeWithTerms({ discount: '10%' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('terms.discount');
  });
});

describe('ac-agreement-bridge trigger backfill (Wave-4a)', () => {
  function setup() {
    const created: Array<Record<string, unknown>> = [];
    const bridge = new AcAgreementBridge({
      envStore: {
        getAgent: (id: string) =>
          id === 'initiator-agent' || id === 'responder-agent'
            ? { id, env_id: 'env-1', owner_id: `owner-of-${id}` }
            : undefined,
      } as never,
      serviceStore: {
        servicesOfAgent: () => [{ id: 'svc-cooling', semantic_type: 'cooling' }],
      } as never,
      agreementStore: {
        activeAgreementsOfCollaboration: () => [],
        createAgreement: vi.fn((input: Record<string, unknown>) => created.push(input)),
      } as never,
    });

    const handlers: Array<{ handler: (event: unknown) => void; eventType: string }> = [];
    const runtime = {
      subscribe: (handler: (event: unknown) => void, eventType: string) => {
        handlers.push({ handler, eventType });
      },
    } as unknown as EngineRuntime;
    bridge.attach('env-1', runtime);

    const emit = (payload: Record<string, unknown>): void => {
      for (const { handler, eventType } of handlers) {
        if (eventType === EventType.COLLABORATION_MESSAGE) {
          handler({ payload, source: payload.agentId ?? 'responder-agent' });
        }
      }
    };
    return { created, emit };
  }

  it('backfills triggerEventType + requiredCapabilities into terms.trigger', () => {
    const { created, emit } = setup();
    emit({
      type: 'ac-proposal',
      collaborationId: 'ac-1',
      initiatorId: 'initiator-agent',
      targetAgentId: 'responder-agent',
      requiredCapabilities: ['cooling'],
      triggerEventType: 'heat-wave',
    });
    emit({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'responder-agent',
      collaborationId: 'ac-1',
    });

    expect(created).toHaveLength(1);
    expect(created[0].terms).toEqual({
      trigger: { eventType: 'heat-wave', parameter: 'cooling' },
    });
  });

  it('BUG-02: backfills the trigger event ZONE into terms.trigger.zoneId (the payload carried it all along)', () => {
    const { created, emit } = setup();
    emit({
      type: 'ac-proposal',
      collaborationId: 'ac-1z',
      initiatorId: 'initiator-agent',
      targetAgentId: 'responder-agent',
      requiredCapabilities: ['cooling'],
      triggerEventType: 'heat-wave',
      triggerZoneId: 'dorm-3-f1',
    });
    emit({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'responder-agent',
      collaborationId: 'ac-1z',
    });

    expect(created).toHaveLength(1);
    expect(created[0].terms).toEqual({
      trigger: { eventType: 'heat-wave', parameter: 'cooling', zoneId: 'dorm-3-f1' },
    });
  });

  it('skips the agreement when the proposal named no capabilities (P5: no honest offer to meter)', () => {
    const { created, emit } = setup();
    emit({
      type: 'ac-proposal',
      collaborationId: 'ac-2',
      initiatorId: 'initiator-agent',
      targetAgentId: 'responder-agent',
      // no requiredCapabilities, no triggerEventType
    });
    emit({
      type: 'join-response',
      acDecision: 'accept',
      agentId: 'responder-agent',
      collaborationId: 'ac-2',
    });

    // P5: without requested capabilities there is no matching basis — the
    // pre-P5 "first offer" fallback metered against an arbitrary service.
    expect(created).toHaveLength(0);
  });
});
