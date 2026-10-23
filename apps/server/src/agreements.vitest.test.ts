/**
 * @vitest-environment node
 *
 * Service consumption chain tests (Fix-11,
 * service-consumption-design.md §3–§4, Phase 1).
 *
 * Covers: migration v14 schema, the agreement lifecycle (propose → decide →
 * suspend/terminate incl. every invalid transition), the permission matrix
 * (outsiders 404, non-parties 403, role-scoped actions), invoke execution
 * through the env's RUNNING simulation (success / failure / no-sim 409 /
 * unbacked 409), append-only UsageRecord metering with the command_log
 * effectRef, and the NullSettlementProvider's archived receipts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceExecutableCommandNames } from '@active-collaboration/simulation';

import { sweepStaleProposedAgreements } from './agreement-stale.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('service agreements (Fix-11)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner AND provider (owns the imported lab-agent)
  let consumer: TestUser; // builder member who signs + invokes
  let stranger: TestUser; // not a member, never a party
  let envId: string;
  let hvacId: string;
  /** Derived service "HVAC B: 开启" — provider = owner's lab-agent. */
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    stranger = await registerUser(ctx.app, { displayName: 'Stranger' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('agreement-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    hvacId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'HVAC B')!.id;

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

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  function propose(token: string | undefined, serviceId: string, body: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      payload: body,
    });
  }

  function listAgreements(token: string | undefined, query = '') {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/agreements${query}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  function act(token: string | undefined, id: string, action: string, body?: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/${action}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
      ...(body !== undefined ? { payload: body } : {}),
    });
  }

  function getSub(token: string | undefined, id: string, sub: string) {
    return ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}/${sub}`,
      ...(token !== undefined ? { headers: auth(token) } : {}),
    });
  }

  /** propose → accept; returns the active agreement id. */
  async function activeAgreement(serviceId = turnOnServiceId): Promise<string> {
    const proposed = await propose(consumer.token, serviceId);
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    const decided = await act(owner.token, id, 'decide', { decision: 'accept' });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
    return id;
  }

  async function runningEnvSim(): Promise<string> {
    return runningEnvSimAs(owner.token);
  }

  /** T-052: run an env sim as a SPECIFIC user (ownership of the target). */
  async function runningEnvSimAs(token: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(token),
      payload: { environmentId: envId },
    });
    expect(created.statusCode).toBe(201);
    const simId = created.json().id as string;
    const started = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(token),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().state).toBe('running');
    return simId;
  }

  // -------------------------------------------------------------------------
  // Migration v14
  // -------------------------------------------------------------------------

  it('R99 (wang-07 triage): an explicit agreement + its usage ledger survive the consumer creating / invoke-targeting / stopping their OWN sim', async () => {
    const id = await activeAgreement();
    await runningEnvSim();
    const first = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(first.statusCode).toBe(200);

    // wang-07's step 3: the consumer's OWN sim is a legal invoke target.
    const consumerSim = await runningEnvSimAs(consumer.token);
    const targeted = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      simulationId: consumerSim,
    });
    expect(targeted.statusCode).toBe(200);

    // …and stopping it afterwards touches nothing (his step 4 was the
    // NOT_FOUND mystery — the sim lifecycle must not swallow agreements).
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${consumerSim}/stop`,
      headers: auth(consumer.token),
    });
    expect(stopped.statusCode).toBe(200);

    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}`,
      headers: auth(consumer.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe('active');
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toHaveLength(2);
    const receipts = await getSub(consumer.token, id, 'receipts');
    expect(receipts.statusCode).toBe(200);
    // 30s test timeout: the test boots TWO env sims (owner's + the
    // consumer's own) on top of the beforeEach full-app boot — on the
    // 4-vCPU nightly runner the 6-worker pool starves this past the 5s
    // default (passes in isolation and in the fast lane either way).
  }, 30_000);

  it('R99: a terminated agreement is a VISIBLE terminal state — terminatedAt + outcome, teaching not-active message, recentlyTerminated in the list', async () => {
    const id = await activeAgreement();
    await runningEnvSim();
    await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    const terminated = await act(consumer.token, id, 'terminate');
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');

    // Parties keep the full read surface: get carries terminatedAt + the
    // shared outcome 口径 (metered outcome wins — the last invoke succeeded).
    const got = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}`,
      headers: auth(consumer.token),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().status).toBe('terminated');
    expect(typeof got.json().terminatedAt).toBe('string');
    expect(got.json().outcome).toBe('success');
    expect((await getSub(consumer.token, id, 'usage')).statusCode).toBe(200);
    expect((await getSub(consumer.token, id, 'receipts')).statusCode).toBe(200);

    // Operations on it say the TERMINATION FACT (when + outcome), never
    // "not found".
    const invoke = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(invoke.statusCode).toBe(409);
    expect(invoke.json().error.code).toBe('AGREEMENT_NOT_ACTIVE');
    expect(invoke.json().error.message).toContain('was terminated at');
    expect(invoke.json().error.message).toContain('success');
    expect(invoke.json().error.message).not.toContain('not found');

    // Parties already see their OWN terminated rows in the default list
    // (existing semantics — wang-07's row was gone because it was DELETED,
    // not terminated); recentlyTerminated additionally surfaces the fresh
    // terminal state with the outcome.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(consumer.token),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().agreements as Array<{ id: string }>).some(a => a.id === id)).toBe(true);
    const recent = list.json().recentlyTerminated as Array<{ id: string; outcome: string }>;
    expect(recent.some(a => a.id === id && a.outcome === 'success')).toBe(true);
  });

  it('R102 (wang-18): the reason channel — reject/suspend/terminate carry an optional reason into statusReason + the other side\'s notification', async () => {
    // reject with a reason: statusReason + consumer notification.
    const rejected = await propose(consumer.token, turnOnServiceId);
    expect(rejected.statusCode).toBe(201);
    const rejectedId = rejected.json().id as string;
    const decided = await act(owner.token, rejectedId, 'decide', {
      decision: 'reject',
      reason: '条款窗口太短，改报 300s 再试',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('rejected');
    expect(decided.json().statusReason).toBe('条款窗口太短，改报 300s 再试');
    const notes = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    });
    const rejectNote = (notes.json().notifications as Array<{ kind: string; refId: string | null; body: Record<string, unknown> }>)
      .find(n => n.kind === 'agreement.rejected' && n.refId === rejectedId);
    expect(rejectNote?.body.reason).toBe('条款窗口太短，改报 300s 再试');

    // suspend + terminate with reasons on an active agreement.
    const id = await activeAgreement();
    const suspended = await act(owner.token, id, 'suspend', { reason: '设备周检，暂停两天' });
    expect(suspended.json().status).toBe('suspended');
    expect(suspended.json().statusReason).toBe('设备周检，暂停两天');
    const terminated = await act(owner.token, id, 'terminate', { reason: '周检发现设备需更换，终止重签' });
    expect(terminated.json().status).toBe('terminated');
    expect(terminated.json().statusReason).toBe('周检发现设备需更换，终止重签');
    const termNote = (await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    })).json().notifications.find((n: { kind: string; refId: string | null }) =>
      n.kind === 'agreement.terminated' && n.refId === id);
    expect(termNote?.body.reason).toBe('周检发现设备需更换，终止重签');

    // No reason → the column stays NULL (v60 party-act semantics) and the
    // API omits the field (display layers render 未记录原因).
    const plain = await propose(consumer.token, turnOnServiceId);
    const plainId = plain.json().id as string;
    const plainRejected = await act(owner.token, plainId, 'decide', { decision: 'reject' });
    expect(plainRejected.json().statusReason).toBeUndefined();
  });

  it('T24 (R3 u1-F1/u2-F-10): decide accept --reason lands in statusReason + the consumer notification (the R102 help promise kept)', async () => {
    // accept WITH a reason: statusReason lands on the row; the consumer's
    // agreement.accepted notification carries it; both get faces show it.
    const proposed = await propose(consumer.token, turnOnServiceId);
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    const decided = await act(owner.token, id, 'decide', {
      decision: 'accept',
      reason: '同意设备商备用调用：高峰时段可调',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');
    expect(decided.json().statusReason).toBe('同意设备商备用调用：高峰时段可调');

    const consumerNotes = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    });
    const acceptNote = (consumerNotes.json().notifications as Array<{ kind: string; refId: string | null; body: Record<string, unknown> }>)
      .find(n => n.kind === 'agreement.accepted' && n.refId === id);
    expect(acceptNote?.body.reason).toBe('同意设备商备用调用：高峰时段可调');

    const gotConsumer = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}`,
      headers: auth(consumer.token),
    });
    expect(gotConsumer.statusCode).toBe(200);
    expect(gotConsumer.json().statusReason).toBe('同意设备商备用调用：高峰时段可调');
    const gotProvider = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}`,
      headers: auth(owner.token),
    });
    expect(gotProvider.json().statusReason).toBe('同意设备商备用调用：高峰时段可调');

    // accept WITHOUT a reason keeps the column NULL (field omitted both in
    // the JSON and in the notification body — 未记录原因 fallback applies).
    const plain = await propose(consumer.token, turnOnServiceId);
    expect(plain.statusCode).toBe(201);
    const plainId = plain.json().id as string;
    const plainAccepted = await act(owner.token, plainId, 'decide', { decision: 'accept' });
    expect(plainAccepted.statusCode).toBe(200);
    expect(plainAccepted.json().statusReason).toBeUndefined();
    const plainNotes = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    });
    const plainNote = (plainNotes.json().notifications as Array<{ kind: string; refId: string | null; body: Record<string, unknown> }>)
      .find(n => n.kind === 'agreement.accepted' && n.refId === plainId);
    expect(plainNote?.body.reason).toBeUndefined();
  });

  it('migration v14 creates the three consumption tables', () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 14')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 14, name: 'service-agreements-usage-settlement' });

    const columns = (table: string) =>
      (ctx.app.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(column => column.name);
    expect(columns('service_agreements')).toEqual([
      'id', 'env_id', 'service_id', 'consumer_agent_id', 'consumer_owner_id',
      'provider_agent_id', 'provider_owner_id', 'terms_json',
      // v33 (R14 consent semantics): counter-offer terms (T-59) — the table
      // was rebuilt once more, so the column order reflects that rebuild.
      'countered_terms_json', 'status',
      // v15 (Phase 2): establishment path + AC linkage.
      'source', 'collaboration_id',
      // D3 (R28, T-080): v48 rebuild adds the consumer hold (status CHECK
      // expansion) + the lazy-expiry deadline.
      'hold_expires_at',
      // R5-F09 (v59): the first-activation stamp — the terminated-outcome
      // 口径 reads it to tell "was active" from "never in effect".
      'activated_at',
      // v60 (R6-E-F08): the rebuild (nullable service_id/provider_agent_id
      // for retire-unlink + the platform-event reason column) moves the
      // timestamps back to the tail.
      'status_reason',
      'created_at', 'updated_at',
      // v63 (R2 T9): the remind trace — ALTER-appended after the v60 tail
      // (newest stamp + running count; reminders are not lifecycle
      // transitions, this is the observable mark).
      'last_reminded_at', 'remind_count',
    ]);
    expect(columns('usage_records')).toEqual([
      'id', 'agreement_id', 'env_id', 'consumer_agent_id', 'provider_agent_id',
      'kind', 'action', 'quantity', 'unit', 'outcome', 'effect_ref',
      'started_at', 'ended_at',
      // C3 (R28): v45 ALTER-ADDs the failure cause column (last position).
      'failure_reason',
      // v58: ALTER-ADDs the metered service's origin dimension (last).
      'origin',
      // FEAT-08 (v66): the metering simulation's attribution (ALTER-ADD).
      'simulation_id',
      // UX-04 (v67): the invoke lane's entry kind (ALTER-ADD).
      'source',
    ]);
    expect(columns('settlement_receipts')).toEqual([
      'id', 'agreement_id', 'env_id', 'provider', 'status',
      'usage_record_ids_json', 'quote_json', 'created_at',
    ]);
  });

  // -------------------------------------------------------------------------
  // Propose
  // -------------------------------------------------------------------------

  it('propose creates a proposed agreement with default-empty terms', async () => {
    const res = await propose(consumer.token, turnOnServiceId);
    expect(res.statusCode).toBe(201);
    const agreement = res.json();
    expect(agreement.status).toBe('proposed');
    expect(agreement.terms).toEqual({});
    expect(agreement.envId).toBe(envId);
    expect(agreement.serviceId).toBe(turnOnServiceId);
    expect(agreement.service.semanticType).toBe('turn-on');
    expect(agreement.consumer.id).toBe(consumer.id);
    expect(agreement.consumerAgentId).toBeNull();
    expect(agreement.provider.id).toBe(owner.id);
    expect(agreement.providerAgentName).toBe('Lab Agent');
  });

  it('propose stores validated terms and a caller-owned consumer agent', async () => {
    const device = ctx.app.envStore.createDevice({
      envId,
      ownerId: consumer.id,
      name: 'Consumer Meter',
      type: 'energy-meter',
      capabilities: ['energy-monitoring'],
      zoneId: 'zone-a',
    });
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: consumer.id,
      name: 'Consumer Agent',
      capabilities: [],
      boundDeviceIds: [device.id],
    });

    const res = await propose(consumer.token, turnOnServiceId, {
      consumerAgentId: agent.id,
      terms: { meteringUnit: 'action', notes: '组合应用用量', pricePerUnit: '0' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().consumerAgentId).toBe(agent.id);
    expect(res.json().consumerAgentName).toBe('Consumer Agent');
    expect(res.json().terms).toEqual({
      meteringUnit: 'action',
      notes: '组合应用用量',
      pricePerUnit: '0',
    });
  });

  it('propose validation: anonymous 401, unknown service 404, bad terms 400, foreign consumer agent 403/404', async () => {
    expect((await propose(undefined, turnOnServiceId)).statusCode).toBe(401);
    expect((await propose(consumer.token, 'no-such-service')).statusCode).toBe(404);
    expect((await propose(consumer.token, turnOnServiceId, { terms: { bogus: 1 } })).statusCode).toBe(400);
    expect((await propose(consumer.token, turnOnServiceId, { terms: { quotaPerWindow: -1 } })).statusCode).toBe(400);
    expect((await propose(consumer.token, turnOnServiceId, { consumerAgentId: 'no-such-agent' })).statusCode).toBe(404);

    // The provider's own lab-agent is not the caller's — rejected as a consumer agent.
    const agents = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(consumer.token),
    });
    const labAgentId = (agents.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
    const foreign = await propose(consumer.token, turnOnServiceId, { consumerAgentId: labAgentId });
    expect(foreign.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // List + visibility
  // -------------------------------------------------------------------------

  it('list: parties and the env owner see the agreement; outsiders see nothing', async () => {
    const id = await activeAgreement();

    const asConsumer = await listAgreements(consumer.token, `?envId=${envId}&role=consumer`);
    expect(asConsumer.statusCode).toBe(200);
    expect(asConsumer.json().agreements.map((a: { id: string }) => a.id)).toEqual([id]);

    const asProvider = await listAgreements(owner.token, `?envId=${envId}&role=provider`);
    expect(asProvider.json().agreements.map((a: { id: string }) => a.id)).toEqual([id]);

    // The env owner sees every agreement in their env (here: also provider).
    const asEnvOwner = await listAgreements(owner.token, `?envId=${envId}`);
    expect(asEnvOwner.json().agreements.map((a: { id: string }) => a.id)).toEqual([id]);

    // Strangers (not a party, not env owner) get an empty list — no leak.
    const asStranger = await listAgreements(stranger.token, `?envId=${envId}`);
    expect(asStranger.statusCode).toBe(200);
    expect(asStranger.json().agreements).toEqual([]);

    // Status filter + role-narrowing: consumer has nothing as provider.
    const none = await listAgreements(consumer.token, `?envId=${envId}&role=provider`);
    expect(none.json().agreements).toEqual([]);
    const byStatus = await listAgreements(consumer.token, `?envId=${envId}&status=active`);
    expect(byStatus.json().agreements).toHaveLength(1);
    const wrongStatus = await listAgreements(consumer.token, `?envId=${envId}&status=proposed`);
    expect(wrongStatus.json().agreements).toEqual([]);

    // Query validation.
    expect((await listAgreements(consumer.token)).statusCode).toBe(400);
    expect((await listAgreements(consumer.token, `?envId=${envId}&role=bogus`)).statusCode).toBe(400);
    expect((await listAgreements(consumer.token, `?envId=${envId}&status=bogus`)).statusCode).toBe(400);
    expect((await listAgreements(consumer.token, '?envId=no-such-env')).statusCode).toBe(404);
    expect((await listAgreements(undefined, `?envId=${envId}`)).statusCode).toBe(401);
  });

  it('get one: parties and the env owner read it; outsiders get 404 like unknown ids (Wave-1a, 陈工 R8)', async () => {
    const id = await activeAgreement();
    const getOne = (token: string | undefined, agreementId = id) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/agreements/${agreementId}`,
        ...(token !== undefined ? { headers: auth(token) } : {}),
      });

    // Both parties and the env owner get the same shape as the list entries.
    for (const token of [consumer.token, owner.token]) {
      const res = await getOne(token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        envId,
        serviceId: turnOnServiceId,
        status: 'active',
        service: { id: turnOnServiceId, name: 'HVAC B: 开启' },
      });
    }

    // Outsiders: 404 exactly like an unknown id — no existence leak.
    // T6: anonymous readers are treated like strangers on the read lanes
    // (optionalAuth) — a live row 404s for them exactly as for a logged-in
    // outsider; only terminated × public-env opens the restricted view.
    const strangerRes = await getOne(stranger.token);
    expect(strangerRes.statusCode).toBe(404);
    expect(strangerRes.json().error.code).toBe('AGREEMENT_NOT_FOUND');
    const unknown = await getOne(consumer.token, 'no-such-agreement');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('AGREEMENT_NOT_FOUND');
    // Anonymous: 404 like every other outsider (T6 — optionalAuth on the
    // read lane; a live row stays existence-protected, terminated × public
    // env alone opens the restricted view).
    expect((await getOne(undefined)).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Lifecycle transitions
  // -------------------------------------------------------------------------

  it('decide: provider accepts (→ active) or rejects (→ rejected); others 403/404; replayed decide 409', async () => {
    const acceptId = (await propose(consumer.token, turnOnServiceId)).json().id as string;

    // The consumer may not decide their own proposal; strangers get 404.
    expect((await act(consumer.token, acceptId, 'decide', { decision: 'accept' })).statusCode).toBe(403);
    expect((await act(stranger.token, acceptId, 'decide', { decision: 'accept' })).statusCode).toBe(404);
    expect((await act(owner.token, acceptId, 'decide', { decision: 'maybe' })).statusCode).toBe(400);

    const accepted = await act(owner.token, acceptId, 'decide', { decision: 'accept' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('active');
    expect(accepted.json().updatedAt > accepted.json().createdAt).toBe(true);

    // A decided agreement is no longer proposed.
    const replayed = await act(owner.token, acceptId, 'decide', { decision: 'reject' });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().error.code).toBe('AGREEMENT_NOT_PROPOSED');

    const rejectId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    const rejected = await act(owner.token, rejectId, 'decide', { decision: 'reject' });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('rejected');

    // Rejected is terminal.
    expect((await act(owner.token, rejectId, 'terminate')).statusCode).toBe(409);
  });

  it('suspend: provider-only, active-only; suspended agreements can still be terminated', async () => {
    const id = await activeAgreement();

    expect((await act(consumer.token, id, 'suspend')).statusCode).toBe(403);
    expect((await act(stranger.token, id, 'suspend')).statusCode).toBe(404);

    const suspended = await act(owner.token, id, 'suspend');
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().status).toBe('suspended');

    // Not active anymore — a second suspend conflicts.
    expect((await act(owner.token, id, 'suspend')).statusCode).toBe(409);

    const terminated = await act(consumer.token, id, 'terminate');
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');
  });

  it('terminate: either party from proposed/active/suspended; env owner who is not a party may terminate too (v60, both parties notified); terminal 409', async () => {
    // Consumer retracts a proposed agreement.
    const proposedId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    expect((await act(stranger.token, proposedId, 'terminate')).statusCode).toBe(404);
    const retracted = await act(consumer.token, proposedId, 'terminate');
    expect(retracted.statusCode).toBe(200);
    expect(retracted.json().status).toBe('terminated');
    expect((await act(consumer.token, proposedId, 'terminate')).statusCode).toBe(409);

    // Provider terminates an active agreement.
    const activeId = await activeAgreement();
    const terminated = await act(owner.token, activeId, 'terminate');
    expect(terminated.statusCode).toBe(200);
    expect(terminated.json().status).toBe('terminated');

    // v60 (R6-E-F08): the env owner who is NOT a party may now TERMINATE
    // (the closer of last resort for provider-unavailable rows — both
    // parties get the notification). Build an agreement between the consumer
    // and a third party's service: stranger joins as builder and offers a
    // service through their own agent.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(stranger.token),
    });
    const device = ctx.app.envStore.createDevice({
      envId,
      ownerId: stranger.id,
      name: 'Stranger Lamp',
      type: 'light',
      capabilities: ['turn-on'],
      zoneId: 'zone-a',
    });
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: stranger.id,
      name: 'Stranger Agent',
      capabilities: [],
      boundDeviceIds: [device.id],
    });
    ctx.app.serviceStore.syncDerivedForAgent(agent.id);
    const strangerService = ctx.app.serviceStore
      .servicesOfAgent(agent.id)
      .find(service => service.semantic_type === 'turn-on')!;

    const theirsId = (await propose(consumer.token, strangerService.id)).json().id as string;
    // Env owner (not a party) sees it in the list and may terminate it (v60)
    // — but still may not DECIDE it (the decide right is the provider's).
    const envOwnerList = await listAgreements(owner.token, `?envId=${envId}`);
    expect(envOwnerList.json().agreements.map((a: { id: string }) => a.id)).toContain(theirsId);
    const ownerTerminated = await act(owner.token, theirsId, 'terminate');
    expect(ownerTerminated.statusCode).toBe(200);
    expect(ownerTerminated.json().status).toBe('terminated');
    // Both parties learn the env owner's termination.
    for (const userId of [consumer.id, stranger.id]) {
      const hit = ctx.app.notificationStore.latestOfKind(userId, 'agreement.terminated', theirsId);
      expect(hit, `agreement.terminated reaches ${userId}`).toBeDefined();
    }
    expect((await act(owner.token, theirsId, 'decide', { decision: 'accept' })).statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Invoke
  // -------------------------------------------------------------------------

  it('invoke: consumer-only, active-only; no private sim → the world session is created on demand (T-501)', async () => {
    const proposedId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    const notActive = await act(consumer.token, proposedId, 'invocations', { action: 'turn-on' });
    expect(notActive.statusCode).toBe(409);
    expect(notActive.json().error.code).toBe('AGREEMENT_NOT_ACTIVE');

    const id = await activeAgreement();
    expect((await act(owner.token, id, 'invocations', { action: 'turn-on' })).statusCode).toBe(403);
    expect((await act(stranger.token, id, 'invocations', { action: 'turn-on' })).statusCode).toBe(404);

    // T-501 (CB24-F01): with no private sim at all the invoke no longer
    // 409s — the env's authoritative world session materializes on demand
    // and executes the consumption (SIMULATION_NOT_RUNNING remains the
    // honest fallback only when the session cannot exist).
    const noSim = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(noSim.statusCode).toBe(200);
    expect(noSim.json().simulationId).toBe(`sim-${envId}-world-session`);
    expect(noSim.json().success).toBe(true);

    // Validation happens before the simulation check.
    expect((await act(consumer.token, id, 'invocations', {})).statusCode).toBe(400);
    expect((await act(consumer.token, id, 'invocations', { action: 'x', params: [] })).statusCode).toBe(400);

    // A created-but-not-started PRIVATE simulation does not hijack the
    // default target — the world session stays it.
    await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const stillSession = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(stillSession.statusCode).toBe(200);
    expect(stillSession.json().simulationId).toBe(`sim-${envId}-world-session`);

    // The permission/validation rejections metered nothing; the two
    // executed invokes metered exactly two rows.
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toHaveLength(2);
  });

  it('invoke success: routed to the provider agent\'s device, usage recorded with command_log effectRef', async () => {
    const id = await activeAgreement();
    const simId = await runningEnvSim();

    // T-501: the invoke pins the private sim explicitly — the snapshot
    // story below reads THIS sim (the omitted-simulationId default, the
    // authoritative world session, has its own T-501 tests above).
    const res = await act(consumer.token, id, 'invocations', { action: 'turn-on', simulationId: simId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.agreementId).toBe(id);
    expect(body.simulationId).toBe(simId);
    expect(body.deviceId).toBe(hvacId);
    expect(body.action).toBe('turn-on');

    // Usage record: kind=invoke, quantity=1, unit=action, outcome=success,
    // effectRef → the command_log entry of the executed device command.
    expect(body.usage.kind).toBe('invoke');
    expect(body.usage.quantity).toBe(1);
    expect(body.usage.unit).toBe('action');
    expect(body.usage.outcome).toBe('success');
    expect(body.usage.effectRef).not.toBeNull();
    const logRow = ctx.app.db
      .prepare('SELECT * FROM command_log WHERE id = ?')
      .get(Number(body.usage.effectRef)) as { kind: string; actor_id: string; payload_json: string };
    expect(logRow.kind).toBe('device-command');
    expect(logRow.actor_id).toBe(consumer.id);
    const payload = JSON.parse(logRow.payload_json) as Record<string, unknown>;
    expect(payload.deviceId).toBe(hvacId);
    expect(payload.commandName).toBe('turn-on');
    expect(payload.agreementId).toBe(id);

    // The device really turned on inside the simulation. S2 (device
    // privacy): the deep state assert is the ENV OWNER's view; the invoking
    // CONSUMER still sees the honest coarse status ('on') — the payload
    // stays service-layer data, the on/off signal is world-coarse.
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    const hvac = (snapshot.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
      .find(device => device.id === hvacId)!;
    expect(hvac.state.power).toBe(true);

    const consumerView = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(consumer.token),
    });
    const coarse = (consumerView.json().devices as Array<Record<string, unknown>>)
      .find(device => device.id === hvacId)!;
    expect(coarse.status).toBe('on');
    expect(coarse.stateRedacted).toBe(true);
    expect((coarse.state as Record<string, unknown>).power).toBeUndefined();
  });

  it('UX-05: terms.meteringUnit overrides the invoke usage unit (default stays action)', async () => {
    const proposed = await propose(consumer.token, turnOnServiceId, { terms: { meteringUnit: 'invoke' } });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    const decided = await act(owner.token, id, 'decide', { decision: 'accept' });
    expect(decided.statusCode).toBe(200);

    const res = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(res.statusCode).toBe(200);
    expect(res.json().usage.kind).toBe('invoke');
    expect(res.json().usage.unit).toBe('invoke');

    // The default is untouched: an agreement without meteringUnit still
    // meters unit='action'.
    const plainId = await activeAgreement();
    const plain = await act(consumer.token, plainId, 'invocations', { action: 'turn-on' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().usage.unit).toBe('action');
  });

  /** The provider agent's row id (Lab Agent) — reputation keys on it. */
  function labAgentIdFor(): string {
    return ctx.app.envStore.agentsOf(envId).find(agent => agent.name === 'Lab Agent')!.id;
  }

  it('T-205/T-303 + R103 44g: provider-side dispatch failures are metered; consumer-side unknown actions 422 unmetered+unscored', async () => {
    const id = await activeAgreement();
    await runningEnvSim();

    // T-303: an unknown action is refused pre-execution with the teaching
    // 422 naming the device's executable commands. R103 (zhao-23, 44g 纪律):
    // a consumer-side probing error is NEITHER metered (no failure row) NOR
    // scored against the provider — the provider never pays for the
    // consumer's out-of-contract vocabulary.
    const repBefore = ctx.app.reputationStore.scoreFor(envId, labAgentIdFor(), 'turn-on');
    const unknown = await act(consumer.token, id, 'invocations', { action: 'no-such-command' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe('DEVICE_COMMAND_NOT_EXECUTABLE');
    expect(unknown.json().error.message).toContain('HVAC B');
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentIdFor(), 'turn-on')?.attempts ?? 0)
      .toBe(repBefore?.attempts ?? 0);

    // A command IN the executable set that fails at dispatch (no params →
    // "no handler / no effect") keeps the T-205 contract: 200 success:false,
    // metered failure, settled receipt — a PROVIDER-side delivery failure.
    const dispatchFailed = await act(consumer.token, id, 'invocations', { action: 'temperature-control' });
    expect(dispatchFailed.statusCode).toBe(200);
    expect(dispatchFailed.json().success).toBe(false);
    expect(typeof dispatchFailed.json().error).toBe('string');
    expect(dispatchFailed.json().usage.outcome).toBe('failure');
    expect(dispatchFailed.json().receiptId).not.toBeNull();
    expect(dispatchFailed.json().applied).toMatchObject({ action: 'temperature-control', deviceId: hvacId });

    // The ledger: ONLY the dispatch failure is metered — the consumer probe
    // left no failure row.
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toHaveLength(1);
    expect(usage.json().usage.map((u: { outcome: string }) => u.outcome)).toEqual(['failure']);
    const receipts = await getSub(consumer.token, id, 'receipts');
    expect(receipts.json().receipts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // R98 (simtest-r1 wang-03 / zhao-06): ONE honest executability surface —
  // the invoke gate, the signing-time callableActions and the device-detail
  // `commands` field all read the same oracle (deviceExecutableCommandNames).
  // -------------------------------------------------------------------------

  it('R98 (zhao-06): propose/accept/detail expose the backing device\'s callableActions', async () => {
    const proposed = await propose(consumer.token, turnOnServiceId);
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().callableActions).toContain('turn-on');
    const id = proposed.json().id as string;
    const decided = await act(owner.token, id, 'decide', { decision: 'accept' });
    expect(decided.json().callableActions).toContain('turn-on');
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${id}`,
      headers: auth(consumer.token),
    });
    expect(detail.json().callableActions).toContain('turn-on');

    // The gate's teaching list IS the shared oracle's answer for the backing
    // device (∪ nothing — no terms clause here): pin the parity so the
    // "responds to: X" list can never name a command the dispatch lacks.
    await runningEnvSim();
    const refused = await act(consumer.token, id, 'invocations', { action: 'no-such-command' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('DEVICE_COMMAND_NOT_EXECUTABLE');
    const device = await ctx.app.inject({
      method: 'GET',
      url: `/api/devices/${hvacId}`,
      headers: auth(owner.token),
    });
    const oracle = deviceExecutableCommandNames(
      device.json().capabilities as string[],
      device.json().type as string,
      `sim://${hvacId}`,
    );
    expect([...(refused.json().error.executableCommands as string[])].sort())
      .toEqual([...oracle].sort());
  });

  it('R98/R101 (wang-03/chen-11): the emergency-broadcast speaker now SIGNS and EXECUTES — the handler exists', async () => {
    // wang-03's original grievance, closed at the root by R101: a PA speaker
    // declaring 'emergency-broadcast' used to execute NOTHING (dead
    // marketing name). The EmergencyBroadcastCommandHandler now exists, so
    // the same setup signs and invokes for real.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zoneId = (detail.json().zones as Array<{ id: string }>)[0]!.id;
    const speaker = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: '应急广播音箱', type: 'pa-column',
        capabilities: ['emergency-broadcast'], zoneId,
      },
    });
    expect(speaker.statusCode).toBe(201);
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: '广播员', capabilities: ['emergency-broadcast'],
        boundDeviceIds: [speaker.json().id as string],
      },
    });
    expect(agent.statusCode).toBe(201);
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.json().id as string}/services`,
      headers: auth(owner.token),
      payload: { name: '楼宇应急广播服务', semanticType: 'emergency-broadcast' },
    });
    expect(published.statusCode).toBe(201);
    const svc = published.json() as { id: string };

    // Signing: the R100 zero-commands gate PASSES — the capability is
    // executable now (callableActions carries it).
    const proposed = await propose(consumer.token, svc.id);
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().callableActions).toContain('emergency-broadcast');
    const id = proposed.json().id as string;
    await act(owner.token, id, 'decide', { decision: 'accept' });

    await runningEnvSim();
    const invoked = await act(consumer.token, id, 'invocations', {
      action: 'emergency-broadcast',
      params: { message: 'smoke in lab-102' },
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().success).toBe(true);
    // The full signing → invoke → dispatch chain executes the R101 handler
    // (the alert state + lastBroadcast audit on the device is pinned at the
    // runtime level in EngineRuntime.emergency-story tests).
    expect(invoked.json().applied).toMatchObject({
      action: 'emergency-broadcast',
      deviceId: speaker.json().id as string,
    });
  });

  it('R102 (wang-17): an invoke with a WRONG-TYPE param is refused 422 — no state write, metered failure, never a success', async () => {
    // wang-17 replay: cooling with targetTemperature:"hot" used to return
    // success and write the string into the device's state.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zoneId = (detail.json().zones as Array<{ id: string }>)[0]!.id;
    const hvac = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: '新风空调(王)', type: 'hvac',
        capabilities: ['cooling', 'turn-on', 'turn-off'], zoneId,
        initialState: { targetTemperature: 24 },
      },
    });
    expect(hvac.statusCode).toBe(201);
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: '新风管家', capabilities: ['cooling'], boundDeviceIds: [hvac.json().id as string] },
    });
    expect(agent.statusCode).toBe(201);
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.json().id as string}/services`,
      headers: auth(owner.token),
      payload: { name: '新风换气', semanticType: 'cooling' },
    });
    expect(published.statusCode).toBe(201);

    const proposed = await propose(consumer.token, published.json().id as string);
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    await act(owner.token, id, 'decide', { decision: 'accept' });

    await runningEnvSim();

    // The replay: string for a numeric param → 422 INVALID_PARAMS.
    const bad = await act(consumer.token, id, 'invocations', {
      action: 'cooling',
      params: { targetTemperature: 'hot' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('INVALID_PARAMS');
    // The error names the parameter, the expectation, and the received value
    // — same quality bar as the action-name refusal.
    expect(bad.json().error.message).toContain('targetTemperature');
    expect(bad.json().error.message).toContain('"hot"');
    expect(bad.json().error.message).toContain('number');

    // …and R103 (44g 纪律): consumer-side param errors are NEITHER metered
    // NOR scored — the ledger stays empty, the provider's reputation
    // untouched (supersedes the R102-lane failure-row metering).
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toEqual([]);

    // A legal invoke afterwards still works end to end (no gate overreach).
    const good = await act(consumer.token, id, 'invocations', {
      action: 'cooling',
      params: { targetTemperature: 22 },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().success).toBe(true);
  });

  it('R100: a device whose capabilities are ALL still dead names is refused at signing (gate keeps its teeth)', async () => {
    // Same gate as R100, exercised with 'people-counting' — a marketing name
    // with NO executable route at all (dead by T-056 design; only
    // ventilation/emergency-broadcast were brought to life by R101.
    // 'content-display'/'trigger-alert' stay dead as literal names but DO
    // map to set-message via the semantic route, so they are not
    // zero-command cases for this gate).
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zoneId = (detail.json().zones as Array<{ id: string }>)[0]!.id;
    const kiosk = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: '人流统计屏', type: 'crowd-monitor', capabilities: ['people-counting'], zoneId },
    });
    expect(kiosk.statusCode).toBe(201);
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: { name: '导览员', capabilities: ['people-counting'], boundDeviceIds: [kiosk.json().id as string] },
    });
    expect(agent.statusCode).toBe(201);
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.json().id as string}/services`,
      headers: auth(owner.token),
      payload: { name: '人流统计服务', semanticType: 'people-counting' },
    });
    expect(published.statusCode).toBe(201);
    const svc = published.json() as { id: string };

    // propose refuses…
    const refusedPropose = await propose(consumer.token, svc.id);
    expect(refusedPropose.statusCode).toBe(409);
    expect(refusedPropose.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(refusedPropose.json().error.message).toContain('ZERO executable commands');
    // …and decide-accept speaks the same refusal (legacy direct-created row).
    const legacy = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: svc.id,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: agent.json().id as string,
      providerOwnerId: owner.id,
      terms: {},
    });
    const refusedAccept = await act(owner.token, legacy.id, 'decide', { decision: 'accept' });
    expect(refusedAccept.statusCode).toBe(409);
    expect(refusedAccept.json().error.code).toBe('SERVICE_NOT_BACKED');

    // The invoke lane's honesty for PRE-GATE rows is unchanged: backed but
    // the device executes nothing — the truthful "no executable commands" +
    // the provider's remedy, never a fictional 'responds to' list.
    const preGate = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: svc.id,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: agent.json().id as string,
      providerOwnerId: owner.id,
      terms: {},
      status: 'active',
    });

    await runningEnvSim();
    const first = await act(consumer.token, preGate.id, 'invocations', { action: 'run', params: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().success).toBe(false);
    expect(first.json().error).toContain('no executable commands');
    expect(first.json().error).toContain('补救');
    expect(first.json().error).not.toContain('responds to');
    const taught = await act(consumer.token, preGate.id, 'invocations', {
      action: 'trigger-alert',
      params: { message: 'load shed warning' },
    });
    expect(taught.json().success).toBe(false);
    expect(taught.json().error).toContain('not found');
    expect(taught.json().error).not.toContain('responds to');
    // Metering unchanged: both refusals land in the ledger as failures.
    const usage = await getSub(consumer.token, preGate.id, 'usage');
    expect(usage.json().usage.map((u: { outcome: string }) => u.outcome))
      .toEqual(['failure', 'failure']);
  });

  it('R100: a SENSOR-backed read-class service is exempt from the zero-commands gate (no false positive)', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const zoneId = (detail.json().zones as Array<{ id: string }>)[0]!.id;
    // A smoke sensor whose only capability is read-class — no commands by
    // nature. Its monitoring service must still sign fine.
    const sensor = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: '广场烟雾传感器', type: 'smoke-sensor', capabilities: ['smoke-monitoring'], zoneId },
    });
    expect(sensor.statusCode).toBe(201);
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: '安防专员', capabilities: ['smoke-monitoring'],
        boundDeviceIds: [sensor.json().id as string],
      },
    });
    expect(agent.statusCode).toBe(201);
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.json().id as string}/services`,
      headers: auth(owner.token),
      payload: { name: '烟雾监测服务', semanticType: 'smoke-monitoring' },
    });
    expect(published.statusCode).toBe(201);

    const proposed = await propose(consumer.token, published.json().id as string);
    expect(proposed.statusCode).toBe(201);
  });

  it('invoke on an unbacked published service → 409 SERVICE_NOT_BACKED (no usage recorded)', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const labAgentId = (detail.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${labAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'Weather Broker', semanticType: 'weather-forecast' },
    });
    expect(published.statusCode).toBe(201);

    // T-310: propose now refuses unbacked offers at the boundary — the
    // invoke-path refusal below is pinned with a LEGACY row (pre-T-310
    // agreements keep their read/act paths; nothing was migrated).
    const legacy = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: published.json().id as string,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: labAgentId,
      providerOwnerId: owner.id,
      terms: {},
    });
    const refusedPropose = await propose(consumer.token, published.json().id as string);
    expect(refusedPropose.statusCode).toBe(409);
    expect(refusedPropose.json().error.code).toBe('SERVICE_NOT_BACKED');

    await act(owner.token, legacy.id, 'decide', { decision: 'accept' });
    await runningEnvSim();
    const res = await act(consumer.token, legacy.id, 'invocations', { action: 'forecast' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SERVICE_NOT_BACKED');
    const usage = await getSub(consumer.token, legacy.id, 'usage');
    expect(usage.json().usage).toEqual([]);
  });

  // C4 (T-086, RT26-F05 — DevLoop R28): the pre-flight drift hint. A frozen
  // world predating a late install used to surface ONLY as the invoke-time
  // 409; the detail + accept responses now pre-flight the same fact.
  it('C4: agreement detail/accept note when the backing device is absent from the consumer\'s sims', async () => {
    // The owner's long-lived sim (targetable by the consumer) predates the
    // late install below.
    const simId = await runningEnvSim();

    // Late install: a new device bound to the lab agent AFTER the sim was
    // built → a derived service the running sim cannot back.
    const lateDevice = ctx.app.envStore.createDevice({
      envId,
      ownerId: owner.id,
      name: 'Late HVAC',
      type: 'hvac',
      capabilities: ['turn-on'],
      zoneId: 'zone-b',
    });
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const labAgent = ctx.app.envStore.agentsOf(envId)
      .find(agent => agent.name === 'Lab Agent')!;
    await ctx.app.envStore.updateAgent(labAgent.id, {
      boundDeviceIds: [...(JSON.parse(labAgent.bound_device_ids_json) as string[]), lateDevice.id],
    });
    const changes = ctx.app.serviceStore.syncDerivedForAgent(labAgent.id);
    const lateService = changes.find(change => change.action === 'created')?.row;
    expect(lateService).toBeDefined();

    // (a) The ACCEPT response pre-flights the drift the consumer would hit.
    const proposed = await propose(consumer.token, lateService!.id);
    expect(proposed.statusCode).toBe(201);
    const accepted = await act(owner.token, proposed.json().id, 'decide', { decision: 'accept' });
    expect(accepted.statusCode).toBe(200);
    const drift = accepted.json().backingDeviceDrift as {
      deviceId: string;
      deviceName: string;
      absentFrom: Array<{ simulationId: string; state: string }>;
      note: string;
    } | undefined;
    expect(drift).toBeDefined();
    expect(drift!.deviceId).toBe(lateDevice.id);
    expect(drift!.deviceName).toBe('Late HVAC');
    expect(drift!.absentFrom).toEqual([{ simulationId: simId, state: 'running' }]);
    expect(drift!.note).toContain('SERVICE_NOT_BACKED');
    expect(drift!.note).toContain('world session');

    // (b) The detail view carries the same hint (consumer perspective).
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${proposed.json().id}`,
      headers: auth(consumer.token),
    });
    expect(read.statusCode).toBe(200);
    expect((read.json().backingDeviceDrift as { deviceId: string }).deviceId).toBe(lateDevice.id);

    // (c) No drift → no field: the ORIGINAL service's device IS in the sim.
    const cleanId = await activeAgreement();
    const cleanRead = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${cleanId}`,
      headers: auth(consumer.token),
    });
    expect(cleanRead.json().backingDeviceDrift).toBeUndefined();

    // (d) R84 (R44-F2 teach-back): the invoke-time 409 names the backing
    // device — no bare UUID in the user-facing message (the usage ledger's
    // refusal reason keeps the exact id as the machine channel).
    const invoke = await act(consumer.token, proposed.json().id, 'invocations', { action: 'turn-on' });
    expect(invoke.statusCode).toBe(409);
    expect(invoke.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(invoke.json().error.message).toContain('Late HVAC');
    expect(invoke.json().error.message).not.toContain(lateDevice.id);
  });

  it('invoke on a suspended agreement → 409 AGREEMENT_NOT_ACTIVE', async () => {
    const id = await activeAgreement();
    await runningEnvSim();
    await act(owner.token, id, 'suspend');
    const res = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AGREEMENT_NOT_ACTIVE');
  });

  // -------------------------------------------------------------------------
  // Usage metering + receipts
  // -------------------------------------------------------------------------

  it('usage: both parties and the env owner read the append-only record list; outsiders 404/401', async () => {
    const id = await activeAgreement();
    await runningEnvSim();
    await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    // R103 (zhao-23): an out-of-surface action probe is a CONSUMER-side
    // error — 422 teaching, but NOT metered (the ledger carries provider
    // delivery outcomes, not caller typos).
    const probe = await act(consumer.token, id, 'invocations', { action: 'no-such-command' });
    expect(probe.statusCode).toBe(422);

    for (const party of [consumer, owner]) {
      const res = await getSub(party.token, id, 'usage');
      expect(res.statusCode).toBe(200);
      const usage = res.json().usage;
      expect(usage).toHaveLength(1);
      expect(usage.map((u: { outcome: string }) => u.outcome)).toEqual(['success']);
      expect(usage[0].agreementId).toBe(id);
      expect(usage[0].envId).toBe(envId);
      expect(usage[0].providerAgentId).not.toBeNull();
      expect(typeof usage[0].startedAt).toBe('string');
    }

    expect((await getSub(stranger.token, id, 'usage')).statusCode).toBe(404);
    // T6: anonymous rides the same read lane as a stranger — live rows 404.
    expect((await getSub(undefined, id, 'usage')).statusCode).toBe(404);
  });

  // v58: the UsageRecord carries the metered service's origin (snapshot of
  // service_instances.origin at write time) — the origin funnel reads the
  // ledger directly instead of only the trajectory face.
  it('usage rows carry the metered service origin (v58) — invoke response and ledger read agree', async () => {
    const id = await activeAgreement();
    await runningEnvSim();
    // The lab service is device-derived — assert the store agrees before
    // pinning the wire value to it.
    const expectedOrigin = ctx.app.serviceStore.getService(turnOnServiceId)!.origin;
    expect(expectedOrigin).toBe('derived');

    const invoked = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().usage.origin).toBe('derived');

    // The failure-row face: an out-of-surface probe is a consumer-side
    // refusal (R103: unmetered), so the ledger keeps only delivery rows.
    await act(consumer.token, id, 'invocations', { action: 'no-such-command' });
    const res = await getSub(consumer.token, id, 'usage');
    expect(res.statusCode).toBe(200);
    expect(res.json().usage.map((u: { origin?: string }) => u.origin))
      .toEqual(['derived']);
  });

  it('receipts: every invoke settles through the Null provider — archived, status=recorded, no amounts', async () => {
    const id = await activeAgreement();
    await runningEnvSim();
    const first = (await act(consumer.token, id, 'invocations', { action: 'turn-on' })).json();
    const second = (await act(consumer.token, id, 'invocations', { action: 'turn-off' })).json();

    const res = await getSub(consumer.token, id, 'receipts');
    expect(res.statusCode).toBe(200);
    const receipts = res.json().receipts;
    expect(receipts).toHaveLength(2);
    expect(receipts[0].provider).toBe('recorded-only'); // TASK-018: renamed from 'null'
    expect(receipts[0].status).toBe('recorded');
    expect(receipts[0].quote).toBeNull();
    expect(receipts[0].usageRecordIds).toEqual([first.usage.id]);
    expect(receipts[1].usageRecordIds).toEqual([second.usage.id]);
    expect(receipts.map((r: { id: string }) => r.id)).toEqual([first.receiptId, second.receiptId]);

    // Provider reads the same receipts; outsiders cannot.
    expect((await getSub(owner.token, id, 'receipts')).json().receipts).toHaveLength(2);
    expect((await getSub(stranger.token, id, 'receipts')).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // T-205 — invocation honesty
  // -------------------------------------------------------------------------

  it('T-205: enforces terms.action.command — out-of-scope action is 422 quoting the clause', async () => {
    // RF-F09: the terms said "only set-brightness, never turn-off" and a
    // turn-off invoke executed anyway. The structured clause is binding now.
    const proposed = await propose(consumer.token, turnOnServiceId, {
      terms: { action: { command: 'turn-on' } },
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    await act(owner.token, id, 'decide', { decision: 'accept' });
    await runningEnvSim();

    const res = await act(consumer.token, id, 'invocations', { action: 'turn-off' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AGREEMENT_TERMS_VIOLATION');
    expect(res.json().error.message).toContain('"turn-on"');
    expect(res.json().error.message).toContain('"turn-off"');
    // Refused BEFORE execution — nothing metered.
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toEqual([]);
  });

  it('T-205: terms.action.params merge-override the request params and echo in applied', async () => {
    const proposed = await propose(consumer.token, turnOnServiceId, {
      terms: { action: { command: 'turn-on', params: { agreed: 'clause' } } },
    });
    const id = (await proposed.json()).id as string;
    await act(owner.token, id, 'decide', { decision: 'accept' });
    await runningEnvSim();

    const res = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      params: { agreed: 'request-override-attempt', extra: 'kept' },
    });
    expect(res.statusCode).toBe(200);
    // The negotiated param WINS over the request; unconstrained keys pass.
    expect(res.json().applied.params).toEqual({ agreed: 'clause', extra: 'kept' });
    expect(res.json().applied.action).toBe('turn-on');
    expect(res.json().applied.deviceId).toBe(hvacId);
  });

  it('T-501: several running sims and no simulationId → the authoritative world session is the default invoke target', async () => {
    const id = await activeAgreement();
    const simA = await runningEnvSim();
    const simB = await runningEnvSim();

    // CB24-F01 (R24): the omitted-simulationId invoke lands in the env's
    // AUTHORITATIVE world session (created on demand, materialized to
    // wall-now) — no longer the ambiguity 409 over private sims, and never
    // a silent first-match into one of them. Manual invokes and
    // trigger-driven consumption share one world.
    const res = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulationId).toBe(`sim-${envId}-world-session`);
    expect(res.json().success).toBe(true);

    // Usage + receipt land for the world-session invoke.
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toHaveLength(1);
    expect(usage.json().usage[0].outcome).toBe('success');
    const receipts = await getSub(consumer.token, id, 'receipts');
    expect(receipts.json().receipts).toHaveLength(1);

    // Explicit targeting lands the invoke in THAT simulation.
    const targeted = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      simulationId: simA,
    });
    expect(targeted.statusCode).toBe(200);
    expect(targeted.json().simulationId).toBe(simA);

    // The explicit world-session id resolves IDENTICALLY — the round's
    // self-contradictory 409 ("is running — invocations require a running
    // simulation") is unreachable.
    const explicitSession = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      simulationId: `sim-${envId}-world-session`,
    });
    expect(explicitSession.statusCode).toBe(200);
    expect(explicitSession.json().simulationId).toBe(`sim-${envId}-world-session`);

    // An explicit but unknown sim is refused with a diagnosis.
    const unknown = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      simulationId: 'sim-does-not-exist',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('SIMULATION_NOT_FOUND');

    void simB;
  });

  it('T-205: a failed invoke appears in usage + receipt but does not advance the quota count', async () => {
    // Quota 2/window: two FAILED invokes must leave the budget intact
    // (quota counts delivered consumption acts only).
    const proposed = await propose(consumer.token, turnOnServiceId, {
      terms: { quotaPerWindow: 2, windowSec: 3600 },
    });
    const id = (await proposed.json()).id as string;
    await act(owner.token, id, 'decide', { decision: 'accept' });
    await runningEnvSim();

    for (let i = 0; i < 2; i += 1) {
      // T-303 note: 'no-such-command' would now 422 at the device gate; a
      // command in the executable set that fails at DISPATCH (missing params
      // → no state change) exercises the same T-205 failure-metering path.
      const failed = await act(consumer.token, id, 'invocations', { action: 'temperature-control' });
      expect(failed.json().success).toBe(false);
      expect(failed.json().usage.outcome).toBe('failure');
      expect(failed.json().receiptId).not.toBeNull();
    }

    // Two failures metered, quota untouched: a third, VALID invoke succeeds.
    const ok = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);

    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage.map((u: { outcome: string }) => u.outcome))
      .toEqual(['failure', 'failure', 'success']);
  });

  it('T-307: quota counts invoke-kind only — a zero-message stream session never starves the invoke budget', async () => {
    // EN-F17's starvation sequence (quota widened to 3 so the arithmetic
    // isolates the stream row): two successful invokes + a zero-message
    // stream session (kind='stream', qty=0, outcome success). Pre-fix, the
    // stream row counted: the next invoke was 429 current:3 — passive
    // observation burned the paid control budget. Post-fix the third invoke
    // is allowed (current=2), and only the third SUCCESS blocks the fourth.
    const proposed = await propose(consumer.token, turnOnServiceId, {
      terms: { quotaPerWindow: 3, windowSec: 600 },
    });
    const id = (await proposed.json()).id as string;
    await act(owner.token, id, 'decide', { decision: 'accept' });
    await runningEnvSim();

    for (let i = 0; i < 2; i += 1) {
      const ok = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().success).toBe(true);
    }

    // The usage row a closed zero-message stream session appends (exactly
    // what AgreementStreamSessions meters on close with 0 pushed frames).
    const at = new Date().toISOString();
    ctx.app.agreementStore.appendUsage({
      agreementId: id,
      envId,
      consumerAgentId: null,
      providerAgentId: ctx.app.serviceStore.getService(turnOnServiceId)!.provider_agent_id,
      kind: 'stream',
      action: 'stream',
      quantity: 0,
      unit: 'message',
      outcome: 'success',
      effectRef: null,
      startedAt: at,
      endedAt: at,
    });

    // Third invoke is ALLOWED (the stream row does not count) and succeeds…
    const third = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(third.statusCode).toBe(200);
    expect(third.json().success).toBe(true);

    // …and NOW the invoke budget is exhausted: the fourth invoke 429s with
    // current:3 (sliding window math otherwise unchanged).
    const fourth = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(fourth.json().error.current).toBe(3);

    // Stream metering rows are still appended (audit completeness). The
    // quota-refused fourth invoke is pre-execution and meters nothing.
    const usage = await getSub(consumer.token, id, 'usage');
    const kinds = usage.json().usage.map((u: { kind: string }) => u.kind);
    expect(kinds.filter(kind => kind === 'stream')).toHaveLength(1);
    expect(kinds.filter(kind => kind === 'invoke')).toHaveLength(3);
  });

  it('T-307 pin: GET /api/agreements without envId → 400 (EO-F06 reported [] — the route must keep requiring envId)', async () => {
    const res = await listAgreements(consumer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('envId');
  });

  it('T-052: a foreign member\'s sim is not a target — explicit 403, no silent auto-pick', async () => {
    const id = await activeAgreement();
    // A THIRD member (not the consumer, not the env owner) runs a sim.
    const third = await registerUser(ctx.app, { displayName: 'Third Member' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(third.token),
    });
    const foreignSim = await runningEnvSimAs(third.token);

    // Explicit cross-tenant targeting → 403 with a teaching message.
    const explicit = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      simulationId: foreignSim,
    });
    expect(explicit.statusCode).toBe(403);
    expect(explicit.json().error.message).toContain('created by another user');
    expect(explicit.json().error.message).toContain('POST /api/simulations');

    // Omitted simulationId + the only private running sim is foreign → the
    // T-501 default is the env's authoritative world session (the platform's
    // own world — no silent landing into another tenant's sim; the
    // foreign-only 403 remains the legacy-fallback contract when the
    // session cannot exist).
    const autoPick = await act(consumer.token, id, 'invocations', { action: 'turn-on' });
    expect(autoPick.statusCode).toBe(200);
    expect(autoPick.json().simulationId).toBe(`sim-${envId}-world-session`);

    // The consumer's OWN sim stays targetable explicitly.
    const mine = await runningEnvSimAs(consumer.token);
    const ok = await act(consumer.token, id, 'invocations', {
      action: 'turn-on',
      simulationId: mine,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().simulationId).toBe(mine);

    // Nothing metered for the refusal (pre-execution gates never meter);
    // the two successful invokes metered exactly two rows.
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toHaveLength(2);
  });

  it('T-052: legacy prose-only agreements surface termsEnforced: false (structured ones true)', async () => {
    const legacyId = await activeAgreement(); // proposed with NO terms
    await runningEnvSim();

    // The marker is visible BEFORE any invoke (agreement JSON).
    const legacyGet = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${legacyId}`,
      headers: auth(consumer.token),
    });
    expect(legacyGet.json().termsEnforced).toBe(false);

    // …and on the invocation result.
    const invoked = await act(consumer.token, legacyId, 'invocations', { action: 'turn-on' });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().termsEnforced).toBe(false);

    // A structured action clause flips the marker — and is enforced (T-205).
    const structuredId = (await propose(consumer.token, turnOnServiceId, {
      terms: { action: { command: 'turn-on' } },
    })).json().id as string;
    await act(owner.token, structuredId, 'decide', { decision: 'accept' });
    const structuredGet = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${structuredId}`,
      headers: auth(consumer.token),
    });
    expect(structuredGet.json().termsEnforced).toBe(true);
    const invokedStructured = await act(consumer.token, structuredId, 'invocations', {
      action: 'turn-on',
    });
    expect(invokedStructured.json().termsEnforced).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T-303 (DevLoop R12, EN-F06) — the invoke device gate
  // -------------------------------------------------------------------------

  it('T-303: prose-only invoke of a command the backing device cannot execute → 422 teaching, unmetered (R103), state untouched', async () => {
    // EN-F06 topology: a PV inverter (turn-on/turn-off/power-monitoring only)
    // behind a prose-only agreement — 'set-temperature' used to ride the
    // generic set-* alias handler INTO the inverter with success:true.
    const pv = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Rooftop PV Inverter',
        type: 'pv-inverter',
        capabilities: ['power-monitoring', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    });
    expect(pv.statusCode).toBe(201);
    const pvId = pv.json().id as string;

    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Energy Agent',
        capabilities: ['turn-off'],
        boundDeviceIds: [pvId],
        managedZoneIds: ['zone-b'],
      },
    });
    expect(agent.statusCode).toBe(201);
    const agentId = agent.json().id as string;

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'Inverter Shutdown', semanticType: 'turn-off' },
    });
    expect(published.statusCode).toBe(201);

    // Prose-only terms (no structured action clause) — the gate is additional
    // and unconditional for exactly this legacy class.
    const id = await activeAgreement(published.json().id);
    const simId = await runningEnvSim();

    const refused = await act(consumer.token, id, 'invocations', {
      action: 'set-temperature',
      params: { temperature: 9 },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('DEVICE_COMMAND_NOT_EXECUTABLE');
    const message = refused.json().error.message as string;
    expect(message).toContain("'set-temperature' is not executable");
    expect(message).toContain("'Rooftop PV Inverter'");
    expect(message).toContain('turn-on');
    expect(message).toContain('turn-off');

    // Device state untouched — no targetTemperature:9 written into the PV.
    const snapshot = await ctx.app.inject({ method: 'GET', url: `/api/simulations/${simId}/snapshot` });
    const pvState = (snapshot.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
      .find(device => device.id === pvId)!.state;
    expect(pvState.targetTemperature).toBeUndefined();

    // R103 (zhao-23): a command the backing device cannot execute is a
    // CONSUMER-side error — 422 teaching, but NOT metered (no failure row,
    // no success receipt); the provider's record stays clean.
    const usage = await getSub(consumer.token, id, 'usage');
    expect(usage.json().usage).toHaveLength(0);
    const receipts = await getSub(consumer.token, id, 'receipts');
    expect(receipts.json().receipts).toEqual([]);

    // A command IN the executable set still executes and meters success.
    const ok = await act(consumer.token, id, 'invocations', { action: 'turn-off' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);
    expect(ok.json().usage.outcome).toBe('success');
    const after = await getSub(consumer.token, id, 'usage');
    expect(after.json().usage).toHaveLength(1);
  });

  it('T-303: structured terms violation still wins when both gates would fire', async () => {
    const structuredId = (await propose(consumer.token, turnOnServiceId, {
      terms: { action: { command: 'turn-on' } },
    })).json().id as string;
    await act(owner.token, structuredId, 'decide', { decision: 'accept' });
    await runningEnvSim();

    // 'set-temperature' is BOTH outside the terms clause AND not executable
    // on HVAC B — the terms clause is the operative teaching (checked first).
    const refused = await act(consumer.token, structuredId, 'invocations', {
      action: 'set-temperature',
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('AGREEMENT_TERMS_VIOLATION');
  });

  // -------------------------------------------------------------------------
  // T-306 (DevLoop R12, EN-F07) — ambiguous published-service backing is an
  // error, not an arbitrary first-match pick. Applies at propose (earliest
  // teaching point), invoke and stream; derived services pin their device.
  // -------------------------------------------------------------------------

  async function ambiguousServiceTopology(): Promise<{ serviceId: string; names: [string, string] }> {
    const devA = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'HVAC Unit 101', type: 'hvac',
        capabilities: ['temperature-reading', 'turn-on', 'turn-off'], zoneId: 'zone-b',
      },
    });
    const devB = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: 'Plant-Room Water Heater', type: 'water-heater',
        capabilities: ['temperature-reading', 'turn-on', 'turn-off'], zoneId: 'zone-b',
      },
    });
    const agent = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload: {
        name: 'Utility Agent', capabilities: ['temperature-reading'],
        boundDeviceIds: [devA.json().id, devB.json().id], managedZoneIds: ['zone-b'],
      },
    });
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.json().id}/services`,
      headers: auth(owner.token),
      payload: { name: 'HVAC Setpoint-as-a-Service', semanticType: 'temperature-reading' },
    });
    expect(published.statusCode).toBe(201);
    return {
      serviceId: published.json().id as string,
      names: ['HVAC Unit 101', 'Plant-Room Water Heater'],
    };
  }

  it('T-306: ambiguous published service → propose 409 naming both devices with the remedy', async () => {
    const { serviceId, names } = await ambiguousServiceTopology();

    const proposed = await propose(consumer.token, serviceId);
    expect(proposed.statusCode).toBe(409);
    expect(proposed.json().error.code).toBe('SERVICE_BACKING_AMBIGUOUS');
    const message = proposed.json().error.message as string;
    expect(message).toContain(names[0]);
    expect(message).toContain(names[1]);
    expect(message).toContain('derived services pin their source device');
    expect(proposed.json().error.candidateDevices).toEqual(names);
    // Nothing was created.
    const list = await listAgreements(consumer.token, `?envId=${envId}`);
    expect(list.json().agreements).toEqual([]);
  });

  it('T-306: pre-existing ambiguous agreement → invoke 409 (no arbitrary first-match)', async () => {
    const { serviceId, names } = await ambiguousServiceTopology();
    // A legacy row proposed before the devices became ambiguous (direct store
    // insert — the propose gate now refuses this shape going forward).
    const row = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: ctx.app.serviceStore.getService(serviceId)!.provider_agent_id,
      providerOwnerId: owner.id,
      terms: {},
    });
    await act(owner.token, row.id, 'decide', { decision: 'accept' });
    await runningEnvSim();

    const invoked = await act(consumer.token, row.id, 'invocations', { action: 'turn-on' });
    expect(invoked.statusCode).toBe(409);
    expect(invoked.json().error.code).toBe('SERVICE_BACKING_AMBIGUOUS');
    expect(invoked.json().error.message).toContain(names[0]);
    expect(invoked.json().error.message).toContain(names[1]);
  });

  it('T-306 regression: single-device published service + derived service propose cleanly with backingDeviceId', async () => {
    // Derived service (pins its source device): the standing turn-on service.
    const derivedAgreement = await propose(consumer.token, turnOnServiceId);
    expect(derivedAgreement.statusCode).toBe(201);
    expect(derivedAgreement.json().backingDeviceId).toBe(hvacId);

    // Published service with exactly ONE covering device: only Sensor A
    // declares temperature-reading among the lab-agent's bindings.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    const labAgentId = (detail.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
    const sensorId = (detail.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'Sensor A')!.id;
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${labAgentId}/services`,
      headers: auth(owner.token),
      payload: { name: 'Room Temperature Reading', semanticType: 'temperature-reading' },
    });
    expect(published.statusCode).toBe(201);

    const single = await propose(consumer.token, published.json().id);
    expect(single.statusCode).toBe(201);
    expect(single.json().backingDeviceId).toBe(sensorId);
  });

  // -------------------------------------------------------------------------
  // T-309 (DevLoop R12, FR-F07/FR-F05) — demand-side governance minimal:
  // the remind nudge + the env governance policy surface.
  // -------------------------------------------------------------------------

  it('T-409: remind tolerates Content-Type: application/json with an EMPTY body (no FST_ERR_CTP_EMPTY_JSON_BODY)', async () => {
    const proposedId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    // Age past the 10-minute window so the first remind is deliverable.
    ctx.app.db
      .prepare('UPDATE service_agreements SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), proposedId);

    // The CC-F06 shape: an API client that unconditionally sets the JSON
    // content-type and sends no payload. Empty body is LEGAL for remind —
    // the outcome must be the route's own semantics (200 / the 429 teaching
    // rate limit), never a raw framework parse error.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${proposedId}/remind`,
      headers: { ...auth(consumer.token), 'content-type': 'application/json' },
      payload: '',
    });
    expect([200, 429]).toContain(res.statusCode);
    expect(String(res.body)).not.toContain('FST_ERR_CTP_EMPTY_JSON_BODY');
    if (res.statusCode === 429) {
      expect(res.json().error.code).toBe('REMIND_RATE_LIMITED');
    } else {
      expect(res.json().reminded).toBe(true);
    }
  });

  it('T-309 + T9: remind — consumer-only, rate-limited; the remind trace lands and the agent provider decides deterministically', async () => {
    const proposedId = (await propose(consumer.token, turnOnServiceId)).json().id as string;

    // Age the proposal past the 10-minute window (created 11 minutes ago).
    ctx.app.db
      .prepare('UPDATE service_agreements SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), proposedId);

    // Non-consumer → 403 (the provider and a stranger alike).
    expect((await act(owner.token, proposedId, 'remind')).statusCode).toBe(403);
    expect((await act(stranger.token, proposedId, 'remind')).statusCode).toBe(404);

    // First remind (11 min after proposal) delivers the nudge AND lands the
    // T9 trace on the row.
    const first = await act(consumer.token, proposedId, 'remind');
    expect(first.statusCode).toBe(200);
    expect(first.json().reminded).toBe(true);
    expect(first.json().remindCount).toBe(1);
    expect(typeof first.json().lastRemindedAt).toBe('string');

    // T9: the provider is the lab AGENT and the derived turn-on offer is
    // fully deliverable, so the deterministic decision lane accepts through
    // the ordinary proposed → active edge (same decide mechanics: audit +
    // consumer notification; no new transition).
    expect(first.json().autoDecision).toMatchObject({ decision: 'accept' });
    const afterAuto = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${proposedId}`,
      headers: auth(consumer.token),
    });
    expect(afterAuto.json().status).toBe('active');
    expect(afterAuto.json().remindCount).toBe(1);
    // The consumer learns the verdict without polling (Fix-16 mechanics).
    const consumerInbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    });
    expect(
      (consumerInbox.json().notifications as Array<{ kind: string; body?: Record<string, unknown> }>)
        .some(n => n.kind === 'agreement.accepted' && n.body?.decidedBy !== undefined),
    ).toBe(true);

    // Second remind → the proposal is gone (the lane accepted it): the
    // status guard answers 409, not the rate limit.
    const second = await act(consumer.token, proposedId, 'remind');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('AGREEMENT_NOT_PROPOSED');

    // Rate-limit teaching (C6/R13) on a proposal that STAYS proposed: an
    // in-window remind of a fresh proposal → 429 stating the EXACT earliest
    // remind time (anchor + window) — machine-readable earliestAt/anchoredAt
    // ride the error details alongside retryAfterSec.
    const freshId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    const freshRemind = await act(consumer.token, freshId, 'remind');
    expect(freshRemind.statusCode).toBe(429);
    expect(freshRemind.json().error.code).toBe('REMIND_RATE_LIMITED');
    expect(typeof freshRemind.json().error.retryAfterSec).toBe('number');
    expect(freshRemind.json().error.message).toContain('no reminder has been sent yet');
    expect(freshRemind.json().error.message).toContain('PROPOSAL CREATION');
    const earliestMs = Date.parse(freshRemind.json().error.earliestAt as string);
    expect(Number.isFinite(earliestMs)).toBe(true);
    expect(earliestMs).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000 + 1500);
    expect(typeof freshRemind.json().error.anchoredAt).toBe('string');

    // Active agreements are not remindable (409) — here the row went active
    // through the T9 lane itself.
    const active = await act(consumer.token, proposedId, 'remind');
    expect(active.statusCode).toBe(409);
    expect(active.json().error.code).toBe('AGREEMENT_NOT_PROPOSED');

    // The provider's inbox gained exactly ONE agreement.reminded row.
    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(owner.token),
    });
    const reminded = (inbox.json().notifications as Array<{ kind: string }>)
      .filter(n => n.kind === 'agreement.reminded');
    expect(reminded).toHaveLength(1);
  });

  it('R77-F5: decide accept notifies the consumer with the explicit "callable now" state', async () => {
    const proposedId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    const decided = await act(owner.token, proposedId, 'decide', { decision: 'accept' });
    expect(decided.statusCode).toBe(200);

    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: auth(consumer.token),
    });
    const accepted = (inbox.json().notifications as Array<{ kind: string; body: Record<string, unknown> }>)
      .find(n => n.kind === 'agreement.accepted');
    expect(accepted).toBeTruthy();
    expect(accepted!.body.callable).toBe(true);
    expect(accepted!.body.serviceName).toBe('HVAC B: 开启');
    expect(accepted!.body.note).toContain('ACTIVE');
  });

  it('R77-F5: the stale-proposal sweep aggregates one provider reminder, throttled to one per 24h', async () => {
    const deps = {
      agreementStore: ctx.app.agreementStore,
      notificationStore: ctx.app.notificationStore,
      serviceStore: ctx.app.serviceStore,
    };
    const providerInbox = async () => {
      const inbox = await ctx.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: auth(owner.token),
      });
      return (inbox.json().notifications as Array<{ kind: string; body: Record<string, unknown> }>)
        .filter(n => n.kind === 'agreement.proposed-stale');
    };

    // A fresh proposal is NOT stale — the sweep stays silent.
    const freshId = (await propose(consumer.token, turnOnServiceId)).json().id as string;
    expect(sweepStaleProposedAgreements(deps)).toEqual({ stale: 0, notified: 0 });
    expect(await providerInbox()).toHaveLength(0);

    // Age the proposal past 24h → one aggregated reminder naming the service.
    ctx.app.db
      .prepare('UPDATE service_agreements SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), freshId);
    expect(sweepStaleProposedAgreements(deps)).toEqual({ stale: 1, notified: 1 });
    const reminders = await providerInbox();
    expect(reminders).toHaveLength(1);
    const listed = reminders[0]!.body.agreements as Array<{ agreementId: string; serviceName: string; waitingHours: number }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.agreementId).toBe(freshId);
    expect(listed[0]!.serviceName).toBe('HVAC B: 开启');
    expect(listed[0]!.waitingHours).toBeGreaterThanOrEqual(24);

    // Re-runs inside the 24h re-notify window stay silent (unread OR read).
    expect(sweepStaleProposedAgreements(deps).notified).toBe(0);
    expect(await providerInbox()).toHaveLength(1);

    // Decided proposals leave the stale set.
    await act(owner.token, freshId, 'decide', { decision: 'reject' });
    expect(sweepStaleProposedAgreements(deps, Date.now() + 48 * 60 * 60 * 1000).stale).toBe(0);
  });

  it('T-309: env detail surfaces the governance policy block (FR-F05)', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(consumer.token),
    });
    expect(detail.statusCode).toBe(200);
    const governance = detail.json().governance as { proposalReview: string; notes: string };
    expect(governance.proposalReview).toBe('ai-assisted-auto-apply');
    expect(governance.notes).toContain('auto-applied');
    expect(governance.notes).toContain('notified');
  });
});
