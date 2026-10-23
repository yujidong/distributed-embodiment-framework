/**
 * @vitest-environment node
 *
 * R6-E-F08 full failover (agreement-failover.ts) — the unreachable-provider
 * watchdog, complementary to the v60 retire semantic (provider-retire
 * suite covers REMOVED providers; this suite covers STALE ones):
 *
 * - an explicit ACTIVE agreement whose provider missed heartbeats past the
 *   failover threshold is parked: suspended + status_reason
 *   'provider-unreachable', BOTH owners notified, agreement-transition audit
 *   + env-stream broadcast;
 * - a heartbeat comeback closes the parked row (terminated,
 *   'provider-recovered') and re-signs a born-active SUCCESSOR on identical
 *   terms — "re-activation = terminate + re-sign", no suspended → active
 *   edge anywhere (TLA zero-expansion, same posture as the retire);
 * - retired rows (provider-unavailable) NEVER recover;
 * - unknown liveness (no running world session / no heartbeat-tracked
 *   registration → probe null) is zero-disturbance by construction;
 * - the threshold is configurable (unreachableMs);
 * - the env owner's digest work queue carries suggestedSubstitutes —
 *   same-env semantic_type twins from OTHER providers (lightweight DB
 *   match, no LLM).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FAILOVER_UNREACHABLE_MS,
  FAILOVER_ACTOR_ID,
  sweepProviderFailover,
  type ProviderLivenessProbe,
} from './agreement-failover.js';
import type { ChangePipeline } from './change-pipeline.js';
import {
  PROVIDER_RECOVERED_REASON,
  PROVIDER_UNAVAILABLE_REASON,
  PROVIDER_UNREACHABLE_REASON,
} from './db/agreement-store.js';
import { NOTIFICATION_KINDS } from './notifications.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

interface PipelineSpy {
  logs: Array<{ envId: string; actorId: string; kind: string; payload: Record<string, unknown> }>;
  broadcasts: Array<{ envId: string; action: string; agreementId: string; actorId: string }>;
}

describe('R6-E-F08 failover: the unreachable-provider watchdog', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let serviceId: string;
  let providerAgentId: string;
  let spy: PipelineSpy;
  /** agentId → freshest heartbeat ms (null/undefined = unknown liveness). */
  let heartbeats: Map<string, number | null>;
  let liveness: ProviderLivenessProbe;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('provider-failover-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    const joined = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });
    expect(joined.statusCode).toBe(200);
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const turnOn = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启');
    expect(turnOn).toBeTruthy();
    serviceId = turnOn!.id;
    providerAgentId = ctx.app.serviceStore.getService(serviceId)!.provider_agent_id;

    spy = { logs: [], broadcasts: [] };
    heartbeats = new Map();
    liveness = {
      latestHeartbeatMs: (_envId, agentId) => heartbeats.get(agentId) ?? null,
    };
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function propose(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function activate(): Promise<string> {
    const id = await propose();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(res.statusCode).toBe(200);
    return id;
  }

  function pipelineSpy(): ChangePipeline {
    return {
      publishAgreement: (env: string, action: string, agreementId: string, actorId: string) => {
        spy.broadcasts.push({ envId: env, action, agreementId, actorId });
      },
      log: (entry: PipelineSpy['logs'][number]) => {
        spy.logs.push(entry);
      },
    } as unknown as ChangePipeline;
  }

  function sweep(nowMs: number = Date.now(), unreachableMs?: number) {
    return sweepProviderFailover(
      {
        agreementStore: ctx.app.agreementStore,
        serviceStore: ctx.app.serviceStore,
        envStore: ctx.app.envStore,
        notificationStore: ctx.app.notificationStore,
        pipeline: pipelineSpy(),
        liveness,
        ...(unreachableMs !== undefined ? { unreachableMs } : {}),
      },
      nowMs,
    );
  }

  function notificationsOf(userId: string, kind: string, agreementId: string) {
    return ctx.app.notificationStore
      .listForUser(userId, { limit: 500 })
      .filter(row => row.kind === kind && row.ref_id === agreementId);
  }

  it('parks an active agreement whose provider missed heartbeats past the threshold (both owners notified + audit + broadcast)', () => {
    return activate().then(id => {
      const now = Date.now();
      heartbeats.set(providerAgentId, now - DEFAULT_FAILOVER_UNREACHABLE_MS - 60_000);

      const result = sweep(now);
      expect(result).toEqual({ watched: 1, suspended: 1, recovered: 0 });

      const row = ctx.app.agreementStore.getAgreement(id)!;
      expect(row.status).toBe('suspended');
      expect(row.status_reason).toBe(PROVIDER_UNREACHABLE_REASON);
      expect(row.activated_at).not.toBeNull(); // activation history survives the park
      // The park keeps every reference — unlike the retire, nothing unlinks.
      expect(row.service_id).toBe(serviceId);
      expect(row.provider_agent_id).toBe(providerAgentId);

      // Both owners get the doorbell (the provider owner still EXISTS here,
      // unlike the removal path's consumer-only notify).
      for (const userId of [consumer.id, owner.id]) {
        const hits = notificationsOf(userId, NOTIFICATION_KINDS.agreementProviderUnreachable, id);
        expect(hits.length, `provider-unreachable notification for ${userId}`).toBeGreaterThan(0);
      }

      // Audit + env-stream broadcast, system-acted.
      const audit = spy.logs.find(entry =>
        entry.kind === 'agreement-transition' && entry.payload.agreementId === id);
      expect(audit).toBeDefined();
      expect(audit!.actorId).toBe(FAILOVER_ACTOR_ID);
      expect(audit!.payload).toMatchObject({
        from: 'active',
        to: 'suspended',
        reason: PROVIDER_UNREACHABLE_REASON,
        providerAgentId,
        serviceId,
      });
      expect(spy.broadcasts).toContainEqual({
        envId, action: 'suspended', agreementId: id, actorId: FAILOVER_ACTOR_ID,
      });
    });
  });

  it('recovery: a heartbeat comeback terminates the parked row and re-signs a born-active successor on identical terms', async () => {
    const id = await activate();
    const original = ctx.app.agreementStore.getAgreement(id)!;
    heartbeats.set(providerAgentId, Date.now() - DEFAULT_FAILOVER_UNREACHABLE_MS - 60_000);
    sweep();
    expect(ctx.app.agreementStore.getAgreement(id)!.status).toBe('suspended');

    // The provider is back.
    heartbeats.set(providerAgentId, Date.now());
    const result = sweep();
    expect(result.recovered).toBe(1);
    expect(result.suspended).toBe(0);

    // Old row: terminally closed, never resurrected.
    const closed = ctx.app.agreementStore.getAgreement(id)!;
    expect(closed.status).toBe('terminated');
    expect(closed.status_reason).toBe(PROVIDER_RECOVERED_REASON);

    // Successor: born active, identical parties/terms, fresh ledger.
    const successors = ctx.app.agreementStore
      .agreementsOfEnv(envId)
      .filter(row => row.id !== id && row.status === 'active');
    expect(successors).toHaveLength(1);
    const successor = successors[0]!;
    expect(successor.service_id).toBe(serviceId);
    expect(successor.consumer_agent_id).toBe(original.consumer_agent_id);
    expect(successor.consumer_owner_id).toBe(original.consumer_owner_id);
    expect(successor.provider_agent_id).toBe(providerAgentId);
    expect(successor.provider_owner_id).toBe(original.provider_owner_id);
    expect(successor.terms_json).toBe(original.terms_json);
    expect(successor.source).toBe('explicit');
    expect(successor.activated_at).not.toBeNull();

    for (const userId of [consumer.id, owner.id]) {
      const hits = notificationsOf(userId, NOTIFICATION_KINDS.agreementProviderRecovered, id);
      expect(hits.length, `provider-recovered notification for ${userId}`).toBeGreaterThan(0);
      const body = JSON.parse(hits[0]!.body_json) as { successorAgreementId?: string };
      expect(body.successorAgreementId).toBe(successor.id);
    }

    // Two audit rows tell the whole story: the close and the re-sign.
    const closeAudit = spy.logs.find(entry =>
      entry.kind === 'agreement-transition' && entry.payload.to === 'terminated' &&
      entry.payload.reason === PROVIDER_RECOVERED_REASON);
    expect(closeAudit?.payload).toMatchObject({ agreementId: id, successorAgreementId: successor.id });
    const resignAudit = spy.logs.find(entry =>
      entry.kind === 'agreement-transition' && entry.payload.agreementId === successor.id);
    expect(resignAudit?.payload).toMatchObject({
      from: null, to: 'active', reason: PROVIDER_RECOVERED_REASON, supersedesAgreementId: id,
    });
    expect(spy.broadcasts).toContainEqual({
      envId, action: 'terminated', agreementId: id, actorId: FAILOVER_ACTOR_ID,
    });
    expect(spy.broadcasts).toContainEqual({
      envId, action: 'accepted', agreementId: successor.id, actorId: FAILOVER_ACTOR_ID,
    });
  });

  it('a REMOVED provider (provider-unavailable) never recovers — the watchdog leaves retired rows alone', async () => {
    const id = await activate();
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/agents/${providerAgentId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBe(204);
    expect(ctx.app.agreementStore.getAgreement(id)!.status_reason).toBe(PROVIDER_UNAVAILABLE_REASON);

    // Even a "fresh heartbeat" signal cannot revive a retired row (the watch
    // set excludes it twice over: reason is provider-unavailable AND the
    // provider reference is unlinked).
    heartbeats.set(providerAgentId, Date.now());
    const result = sweep();
    expect(result).toEqual({ watched: 0, suspended: 0, recovered: 0 });
    const row = ctx.app.agreementStore.getAgreement(id)!;
    expect(row.status).toBe('suspended');
    expect(row.status_reason).toBe(PROVIDER_UNAVAILABLE_REASON);
    expect(ctx.app.agreementStore.agreementsOfEnv(envId)).toHaveLength(1); // no successor
  });

  it('zero disturbance: unknown liveness (probe null) never judges; proposed/held rows are out of scope', async () => {
    const active = await activate();
    const pending = await propose();
    const held = await activate();
    const hold = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${held}/hold`,
      headers: auth(consumer.token),
      payload: { durationSec: 3600 },
    });
    expect(hold.statusCode).toBe(200);

    // No liveness signal at all — nothing moves, nothing notifies.
    const result = sweep();
    expect(result.suspended).toBe(0);
    expect(result.recovered).toBe(0);
    expect(ctx.app.agreementStore.getAgreement(active)!.status).toBe('active');
    expect(ctx.app.agreementStore.getAgreement(pending)!.status).toBe('proposed');
    expect(ctx.app.agreementStore.getAgreement(held)!.status).toBe('held');
    expect(spy.logs).toHaveLength(0);
    expect(spy.broadcasts).toHaveLength(0);
    expect(notificationsOf(consumer.id, NOTIFICATION_KINDS.agreementProviderUnreachable, active))
      .toHaveLength(0);

    // A stale signal parks ONLY the active row — pending offers and consumer
    // holds are not the watchdog's business.
    heartbeats.set(providerAgentId, Date.now() - DEFAULT_FAILOVER_UNREACHABLE_MS - 60_000);
    const second = sweep();
    expect(second.suspended).toBe(1);
    expect(ctx.app.agreementStore.getAgreement(active)!.status).toBe('suspended');
    expect(ctx.app.agreementStore.getAgreement(pending)!.status).toBe('proposed');
    expect(ctx.app.agreementStore.getAgreement(held)!.status).toBe('held');
  });

  it('the unreachable threshold is configurable (unreachableMs)', async () => {
    const id = await activate();
    const now = Date.now();
    heartbeats.set(providerAgentId, now - 10 * 60_000); // 10 min silent

    // A 30-minute budget tolerates 10 minutes of silence…
    expect(sweep(now, 30 * 60_000).suspended).toBe(0);
    expect(ctx.app.agreementStore.getAgreement(id)!.status).toBe('active');
    // …a 5-minute one (the default) does not…
    expect(sweep(now).suspended).toBe(1);
    expect(ctx.app.agreementStore.getAgreement(id)!.status).toBe('suspended');
    // …and a parked row only recovers when the heartbeat is INSIDE the budget.
    heartbeats.set(providerAgentId, now - 10 * 60_000); // still 10 min stale
    expect(sweep(now + 60_000).recovered).toBe(0);
    heartbeats.set(providerAgentId, now + 60_000); // fresh
    expect(sweep(now + 60_000).recovered).toBe(1);
  });

  it('the owner digest queues the parked row WITH suggestedSubstitutes (semantic twins from other providers)', async () => {
    const id = await activate();
    const lostSemanticType = ctx.app.serviceStore.getService(serviceId)!.semantic_type;

    // A second provider offering the same semantic type in the same env.
    const substituteAgent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: 'Substitute Provider', capabilities: [], boundDeviceIds: [] },
    });
    expect(substituteAgent.statusCode).toBe(201);
    const substituteAgentId = substituteAgent.json().id as string;
    const substitute = ctx.app.serviceStore.createService({
      envId,
      providerAgentId: substituteAgentId,
      name: '替代 HVAC 开启',
      semanticType: lostSemanticType,
      origin: 'published',
    });

    // Freeze today's memo BEFORE the park: the section is empty.
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    expect(before.json().providerUnavailableAgreements).toEqual([]);

    heartbeats.set(providerAgentId, Date.now() - DEFAULT_FAILOVER_UNREACHABLE_MS - 60_000);
    sweep();

    // The watchdog stamp expires the frozen memo; the owner sees the parked
    // contract and its re-contracting lead. Non-owners still see nothing.
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    const entries = after.json().providerUnavailableAgreements as Array<{
      agreementId: string;
      reason: string;
      suggestedSubstitutes: Array<{ serviceId: string; serviceName: string; providerAgentId: string; providerAgentName: string | null }>;
    }>;
    const entry = entries.find(candidate => candidate.agreementId === id);
    expect(entry, 'parked row in the owner work queue').toBeDefined();
    expect(entry!.reason).toBe(PROVIDER_UNREACHABLE_REASON);
    expect(entry!.suggestedSubstitutes).toEqual([
      {
        serviceId: substitute.id,
        serviceName: substitute.name,
        providerAgentId: substituteAgentId,
        providerAgentName: 'Substitute Provider',
      },
    ]);

    const consumerDigest = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(consumer.token),
    });
    expect(consumerDigest.json().providerUnavailableAgreements).toEqual([]);
  });

  it('substitutes stay empty when the reference is unlinked (retired) or no semantic twin exists', async () => {
    // Case 1: a parked (unreachable) row whose service has no twin.
    const noTwin = await activate();
    heartbeats.set(providerAgentId, Date.now() - DEFAULT_FAILOVER_UNREACHABLE_MS - 60_000);
    sweep();

    // Case 2: a retired (removed provider) row — unlinked, nothing to match on.
    const otherService = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const second = (otherService.json().services as Array<{ id: string; name: string }>)
      .find(service => service.id !== serviceId);
    expect(second).toBeTruthy();
    const secondProviderAgentId = ctx.app.serviceStore.getService(second!.id)!.provider_agent_id;
    const retired = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: second!.id,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: secondProviderAgentId,
      providerOwnerId: owner.id,
      terms: {},
      source: 'explicit',
      status: 'active',
    });
    if (secondProviderAgentId === providerAgentId) {
      // Same provider owns both services in this fixture — retire via delete.
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/agents/${providerAgentId}`,
        headers: auth(owner.token),
      });
    } else {
      await ctx.app.inject({
        method: 'DELETE',
        url: `/api/agents/${secondProviderAgentId}`,
        headers: auth(owner.token),
      });
    }

    const digest = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/digest`,
      headers: auth(owner.token),
    });
    const entries = digest.json().providerUnavailableAgreements as Array<{
      agreementId: string;
      reason: string;
      suggestedSubstitutes: unknown[];
    }>;
    const noTwinEntry = entries.find(candidate => candidate.agreementId === noTwin);
    const retiredEntry = entries.find(candidate => candidate.agreementId === retired.id);
    expect(retiredEntry, 'retired row is queued too (both reasons share the section)').toBeDefined();
    expect(retiredEntry!.reason).toBe(PROVIDER_UNAVAILABLE_REASON);
    expect(retiredEntry!.suggestedSubstitutes).toEqual([]);
    // The no-twin parked row: when the retire above deleted the ONLY other
    // agent, no twin can exist — empty either way.
    if (noTwinEntry !== undefined) {
      expect(noTwinEntry.suggestedSubstitutes).toEqual([]);
    }
  });
});
