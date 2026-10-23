/**
 * @vitest-environment node
 *
 * Service consumption chain — Phase 2 tests (Fix-11,
 * service-consumption-design.md §3.1/§3.2.2/§5, §6):
 *
 * - migration v15: service_agreements gains `source` ('explicit' default)
 *   and `collaboration_id`;
 * - AC ephemeral agreements (§3.1 implicit path): the bridge subscribes the
 *   env-backed runtime's bus — accept lands a born-active source='ac'
 *   agreement; completion/cancel terminates it and meters kind='ac' usage;
 * - stream consumption (§3.2.2): WS /api/agreements/:id/stream pushes the
 *   backing device's observation changes and meters one kind='stream'
 *   UsageRecord per session (quantity = pushed messages);
 * - reputation (§5): a failed invoke scores the provider agent's reputation;
 *   successes stay with Fix-12's recheck (no double accounting);
 * - config: AC_EPHEMERAL_AGREEMENTS (default true) gates the bridge.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { EventType, type EngineRuntime, type SystemEvent } from '@active-collaboration/core';

import { AcAgreementBridge } from './ac-agreement-bridge.js';
import { loadConfig } from './config.js';
import type { AgreementRow } from './db/agreement-store.js';
import {
  auth,
  importableScenario,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('service consumption Phase 2 (Fix-11)', () => {
  let ctx: TestAppContext;
  let owner: TestUser; // env owner AND provider (owns the imported lab-agent)
  let consumer: TestUser;
  let stranger: TestUser;
  let envId: string;
  let labAgentId: string;
  let hvacId: string;
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
      payload: { ...importableScenario('phase2-lab'), visibility: 'public' },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
    labAgentId = (created.json().agents as Array<{ id: string; name: string }>)
      .find(agent => agent.name === 'Lab Agent')!.id;
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
    turnOnServiceId = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

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
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
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

  // -------------------------------------------------------------------------
  // Migration v15
  // -------------------------------------------------------------------------

  it('migration v15 adds source + collaboration_id; explicit stays the default', async () => {
    const migration = ctx.app.db
      .prepare('SELECT version, name FROM migrations WHERE version = 15')
      .get() as { version: number; name: string } | undefined;
    expect(migration).toEqual({ version: 15, name: 'agreement-source-ac-ephemeral' });

    const columns = (ctx.app.db.prepare('PRAGMA table_info(service_agreements)').all() as Array<{ name: string }>)
      .map(column => column.name);
    // v15 appended source + collaboration_id; v33 (R14 consent semantics)
    // rebuilt the table once more — countered_terms_json joined the column
    // list and the status CHECK gained 'countered' (order reflects the
    // v33 rebuild, rows copied verbatim). D3 (R28): v48 rebuilt again for
    // the 'held' status + hold_expires_at. R5-F09 (v59): activated_at.
    // v60 (R6-E-F08): the retire rebuild adds status_reason and moves the
    // timestamps back to the tail. v63 (R2 T9): ALTER-appended remind trace
    // columns (last_reminded_at / remind_count) after that tail.
    expect(columns).toEqual([
      'id', 'env_id', 'service_id', 'consumer_agent_id', 'consumer_owner_id',
      'provider_agent_id', 'provider_owner_id', 'terms_json', 'countered_terms_json',
      'status', 'source', 'collaboration_id', 'hold_expires_at', 'activated_at',
      'status_reason', 'created_at', 'updated_at',
      'last_reminded_at', 'remind_count',
    ]);

    const id = await activeAgreement();
    const row = ctx.app.agreementStore.getAgreement(id)!;
    expect(row.source).toBe('explicit');
    expect(row.collaboration_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // AC ephemeral agreements (§3.1 implicit path)
  // -------------------------------------------------------------------------

  /** Minimal fake runtime: captures bus subscribers and replays events. */
  function fakeRuntime() {
    const listeners: Array<{ types: string[] | undefined; listener: (event: SystemEvent) => void }> = [];
    const runtime = {
      subscribe(listener: (event: SystemEvent) => void, types?: unknown) {
        listeners.push({ types: (Array.isArray(types) ? types : [types]) as string[], listener });
        return () => undefined;
      },
      fire(type: string, payload: Record<string, unknown>, source = 'test') {
        for (const entry of listeners) {
          if (entry.types === undefined || entry.types.includes(type)) {
            entry.listener({ type, source, payload } as unknown as SystemEvent);
          }
        }
      },
    };
    return runtime;
  }

  function attachBridge() {
    const runtime = fakeRuntime();
    const bridge = new AcAgreementBridge({
      envStore: ctx.app.envStore,
      serviceStore: ctx.app.serviceStore,
      agreementStore: ctx.app.agreementStore,
      // R78 病灶 C guard: the completion path must NOTIFY both parties.
      notificationStore: ctx.app.notificationStore,
    });
    bridge.attach(envId, runtime as unknown as EngineRuntime);
    return runtime;
  }

  function consumerAgent(): string {
    return ctx.app.envStore.createAgent({
      envId,
      ownerId: consumer.id,
      name: 'Buyer Agent',
      capabilities: [],
      boundDeviceIds: [],
    }).id;
  }

  it('an AC accept lands a born-active ephemeral agreement; completion terminates + meters it', () => {
    const runtime = attachBridge();
    const initiatorId = consumerAgent();

    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-proposal',
      collaborationId: 'ac-1',
      initiatorId,
      requiredCapabilities: ['turn-on'],
    });
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'join-response',
      acDecision: 'accept',
      agentId: labAgentId,
      collaborationId: 'ac-1',
    });

    const agreements = ctx.app.agreementStore.activeAgreementsOfCollaboration('ac-1');
    expect(agreements).toHaveLength(1);
    const agreement = agreements[0];
    expect(agreement.source).toBe('ac');
    expect(agreement.status).toBe('active');
    expect(agreement.collaboration_id).toBe('ac-1');
    expect(agreement.service_id).toBe(turnOnServiceId);
    expect(agreement.consumer_agent_id).toBe(initiatorId);
    expect(agreement.consumer_owner_id).toBe(consumer.id);
    expect(agreement.provider_agent_id).toBe(labAgentId);
    expect(agreement.provider_owner_id).toBe(owner.id);

    // A duplicate accept for the same responder never double-meters.
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'join-response',
      acDecision: 'accept',
      agentId: labAgentId,
      collaborationId: 'ac-1',
    });
    expect(ctx.app.agreementStore.activeAgreementsOfCollaboration('ac-1')).toHaveLength(1);

    runtime.fire(EventType.COLLABORATION_COMPLETED, {
      collaborationId: 'ac-1',
      success: true,
    });

    const closed = ctx.app.agreementStore.getAgreement(agreement.id)!;
    expect(closed.status).toBe('terminated');
    // R102: the auto-termination writes its reason into statusReason —
    // agreement get answers WHY the platform ended it (ac-completed).
    expect(closed.status_reason).toBe('ac-completed');
    const usage = ctx.app.agreementStore.usageOf(agreement.id);
    expect(usage).toHaveLength(1);
    expect(usage[0].kind).toBe('ac');
    expect(usage[0].quantity).toBe(1);
    expect(usage[0].unit).toBe('collaboration');
    expect(usage[0].outcome).toBe('success');

    // R78 病灶 C guard: the termination is NOT silent — both the consumer
    // and the provider owner learn it (with the ac-completed cause).
    const inboxOf = (userId: string) =>
      ctx.app.notificationStore.listForUser(userId, { limit: 200 }).filter(
        n => n.kind === 'agreement.terminated',
      );
    const consumerNotices = inboxOf(consumer.id);
    const providerNotices = inboxOf(owner.id);
    expect(consumerNotices.length).toBeGreaterThanOrEqual(1);
    expect(providerNotices.length).toBeGreaterThanOrEqual(1);
    expect(consumerNotices[0].body_json).toContain('ac-completed');
    expect(providerNotices[0].body_json).toContain('ac-completed');
  });

  it('ac-cancelled (partial accept + timeout) terminates the agreement WITHOUT metering a failure', () => {
    // Fix-21: a cancelled collaboration never executed (the coordinator only
    // runs the executor after a completed handshake), so there is no
    // consumption to meter. The accepting provider consented in good faith —
    // recording outcome='failure' mis-recorded a non-execution as a failed
    // consumption.
    const runtime = attachBridge();
    const initiatorId = consumerAgent();
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-proposal',
      collaborationId: 'ac-2',
      initiatorId,
      requiredCapabilities: ['turn-on'],
    });
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'join-response',
      acDecision: 'accept',
      agentId: labAgentId,
      collaborationId: 'ac-2',
    });
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-cancelled',
      collaborationId: 'ac-2',
      outcome: 'timeout',
      acceptedBy: [labAgentId],
      declinedBy: [],
    });

    const agreements = ctx.app.agreementStore.agreementsOfEnv(envId)
      .filter((row: AgreementRow) => row.collaboration_id === 'ac-2');
    expect(agreements).toHaveLength(1);
    expect(agreements[0].status).toBe('terminated');
    // No usage row: nothing was executed, nothing was consumed.
    expect(ctx.app.agreementStore.usageOf(agreements[0].id)).toHaveLength(0);
    // R78 病灶 C guard: the cancelled termination notifies too (ac-cancelled).
    const cancelledNotices = ctx.app.notificationStore
      .listForUser(consumer.id, { limit: 200 })
      .filter(n => n.kind === 'agreement.terminated');
    expect(cancelledNotices.length).toBeGreaterThanOrEqual(1);
    expect(cancelledNotices[0].body_json).toContain('ac-cancelled');

    // A late COLLABORATION_COMPLETED for the same id does not meter either
    // (the agreement is already terminated; closeCollaboration only touches
    // active agreements).
    runtime.fire(EventType.COLLABORATION_COMPLETED, {
      collaborationId: 'ac-2',
      success: true,
    });
    expect(ctx.app.agreementStore.usageOf(agreements[0].id)).toHaveLength(0);
  });

  it('no accept → no agreement; unknown initiator/responder services are skipped', () => {
    const runtime = attachBridge();
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'ac-proposal',
      collaborationId: 'ac-3',
      initiatorId: consumerAgent(),
      requiredCapabilities: ['turn-on'],
    });
    expect(ctx.app.agreementStore.activeAgreementsOfCollaboration('ac-3')).toHaveLength(0);

    // An accept from an agent with no service offers meters nothing.
    const serviceLess = consumerAgent();
    runtime.fire(EventType.COLLABORATION_MESSAGE, {
      type: 'join-response',
      acDecision: 'accept',
      agentId: serviceLess,
      collaborationId: 'ac-3',
    });
    expect(ctx.app.agreementStore.activeAgreementsOfCollaboration('ac-3')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Stream consumption (§3.2.2)
  // -------------------------------------------------------------------------

  async function listen(): Promise<string> {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (typeof address === 'object' && address !== null) {
      return `ws://127.0.0.1:${address.port}`;
    }
    throw new Error('listen failed');
  }

  function collect(socket: WebSocket): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    return frames;
  }

  function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (predicate()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > ms) {
          clearInterval(poll);
          reject(new Error('waitFor timed out'));
        }
      }, 10);
    });
  }

  // -------------------------------------------------------------------------
  // R54 — aggregate offers are invocable (the action picks the backing)
  // -------------------------------------------------------------------------

  it('R54: an aggregate offer carries an agreement through to a real device effect (action-selected backing)', async () => {
    // Grow the lab agent's bundle into the campus-air-comfort surface:
    // temperature-control + cooling (+ air-quality would need a monitor).
    // Use the grounded pump surface instead — drainage-control needs
    // valve-control + water-level-monitoring; add both to the lab agent.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: '排涝智能阀',
        type: 'smart-valve',
        capabilities: ['valve-control', 'turn-on', 'turn-off', 'open'],
        zoneId: 'zone-b',
      },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: {
        name: '内涝水位计',
        type: 'flood-detector',
        capabilities: ['water-level-monitoring'],
        zoneId: 'zone-b',
      },
    });
    const devices = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json().devices as Array<{ id: string; name: string }>;
    const valveId = devices.find(d => d.name === '排涝智能阀')!.id;
    const gaugeId = devices.find(d => d.name === '内涝水位计')!.id;
    // APPEND to the existing bindings — dropping the temp sensor would 422
    // the rebind (declared temperature-monitoring loses its backing).
    const agentsBefore = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    })).json().agents as Array<{ id: string; boundDeviceIds: string[] }>;
    const existing = agentsBefore.find(a => a.id === labAgentId)!.boundDeviceIds;
    const rebinding = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${labAgentId}`,
      headers: auth(owner.token),
      payload: { boundDeviceIds: [...new Set([...existing, valveId, gaugeId])] },
    });
    expect(rebinding.statusCode, JSON.stringify(rebinding.json()).slice(0, 200)).toBe(200);

    const services = (await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    })).json().services as Array<{ id: string; name: string; origin: string }>;
    const offer = services.find(s => s.origin === 'aggregate' && s.name === '区域排涝调度');
    expect(offer).toBeDefined();

    // propose → accept on the AGGREGATE offer (backing-ambiguity check must
    // not fire — bundles are structurally backed).
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${offer!.id}/agreements`,
      headers: auth(consumer.token),
      payload: {},
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

    // Invoke the offer's action 'open' — the resolver must pick the VALVE
    // (the bundle device that executes it), not the HVAC or the gauge.
    const simId = await runningEnvSim();
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'open', params: { value: 1 }, simulationId: simId },
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().success).toBe(true);
    // The ACTION-SELECTED backing is the VALVE (the bundle device that
    // executes 'open') — proven by the invocation's audited device-command.
    const audit = ctx.app.db
      .prepare(
        `SELECT payload_json FROM command_log
         WHERE env_id = ? AND kind = 'device-command' AND payload_json LIKE ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .all(envId, `%${agreementId}%`) as Array<{ payload_json: string }>;
    expect(audit.length).toBeGreaterThan(0);
    const payload = JSON.parse(audit[0]!.payload_json) as { deviceId: string; commandName: string };
    expect(payload.deviceId).toBe(valveId);
    expect(payload.commandName).toBe('open');
  });

  it('stream pushes backing-device observations and meters one kind=stream record per session', async () => {
    const baseUrl = await listen();
    const agreementId = await activeAgreement();
    const simId = await runningEnvSim();

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames = collect(socket);
    await waitFor(() => frames.some(frame => frame.kind === 'subscribed'));
    expect(frames[0]).toMatchObject({
      kind: 'subscribed',
      agreementId,
      deviceId: hvacId,
      semanticType: 'turn-on',
    });

    // An invoke changes the backing device's state → one observation frame.
    // T-501: the invoke pins simulationId to the sim the STREAM bound — the
    // omitted-simulationId default is the authoritative world session now,
    // and this private-sim stream would (correctly) observe nothing there.
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().success).toBe(true);
    await waitFor(() => frames.some(frame => frame.kind === 'observation'));
    const observation = frames.find(frame => frame.kind === 'observation')!;
    expect(observation.deviceId).toBe(hvacId);
    expect(observation.agreementId).toBe(agreementId);
    expect(Array.isArray(observation.changedParameters)).toBe(true);
    expect((observation.changedParameters as unknown[]).length).toBeGreaterThan(0);

    socket.close();
    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream'));
    const streamUsage = ctx.app.agreementStore.usageOf(agreementId)
      .filter(record => record.kind === 'stream');
    expect(streamUsage).toHaveLength(1);
    expect(streamUsage[0].unit).toBe('message');
    expect(streamUsage[0].outcome).toBe('success');
    expect(streamUsage[0].quantity).toBeGreaterThanOrEqual(1);
  });

  it('simulation stop closes the hosted stream session and meters it (Wave-6)', async () => {
    const baseUrl = await listen();
    const agreementId = await activeAgreement();
    const simId = await runningEnvSim();

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames = collect(socket);
    await waitFor(() => frames.some(frame => frame.kind === 'subscribed'));
    const closed = new Promise<number>(resolve => {
      socket.on('close', code => resolve(code));
    });

    // Stopping the hosting simulation actively closes the stream (close
    // frame 1001) instead of letting it ping/pong on unmetered.
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(owner.token),
    });
    expect(stopped.statusCode).toBe(200);
    expect(await closed).toBe(1001);

    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream'));
    const streamUsage = ctx.app.agreementStore.usageOf(agreementId)
      .filter(record => record.kind === 'stream');
    expect(streamUsage).toHaveLength(1);
    expect(streamUsage[0].unit).toBe('message');
    expect(streamUsage[0].outcome).toBe('success');

    // A stopped sim no longer accepts streams (unchanged precondition).
    const attempt = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const status = await new Promise<number>((resolve, reject) => {
      attempt.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      attempt.on('open', () => resolve(101));
      attempt.on('error', reject);
    });
    expect(status).toBe(409);
  });

  it('stream meters on abrupt disconnect too (terminate without close frame, F-21)', async () => {
    const baseUrl = await listen();
    const agreementId = await activeAgreement();
    await runningEnvSim();

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames = collect(socket);
    await waitFor(() => frames.some(frame => frame.kind === 'subscribed'));

    // Abrupt kill (process death / Ctrl+C / closed pipe): no close handshake.
    socket.terminate();
    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream'));
    const streamUsage = ctx.app.agreementStore.usageOf(agreementId)
      .filter(record => record.kind === 'stream');
    expect(streamUsage).toHaveLength(1);
    expect(streamUsage[0].unit).toBe('message');
  });

  it('stream rejects before the upgrade: no running sim → 409, stranger → 404, not active → 409', async () => {
    const baseUrl = await listen();
    const agreementId = await activeAgreement();

    const attempt = (id: string, token: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl}/api/agreements/${id}/stream`, {
          headers: auth(token),
        });
        socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.on('open', () => resolve(101));
        socket.on('error', reject);
      });

    // No running simulation → rejected, not parked.
    expect(await attempt(agreementId, consumer.token)).toBe(409);
    // Outsider → 404 (existence must not leak).
    expect(await attempt(agreementId, stranger.token)).toBe(404);

    // Proposed (not yet active) → 409.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(await attempt(proposed.json().id as string, consumer.token)).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Quota enforcement (Fix-20, §6 Phase 2)
  // -------------------------------------------------------------------------

  it('quotaPerWindow+windowSec terms cap invokes per sliding window (429 QUOTA_EXCEEDED)', async () => {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { quotaPerWindow: 2, windowSec: 3600 } },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    await runningEnvSim();

    const invoke = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/invocations`,
        headers: auth(consumer.token),
        payload: { action: 'turn-on' },
      });

    expect((await invoke()).statusCode).toBe(200);
    expect((await invoke()).statusCode).toBe(200);
    const rejected = await invoke();
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe('QUOTA_EXCEEDED');
    expect(rejected.json().error.message).toContain('2/2');
    expect(rejected.json().error.message).toContain('3600s');
    expect(rejected.json().error.limit).toBe(2);
    expect(rejected.json().error.current).toBe(2);
    // A rejected invoke is not metered.
    expect(ctx.app.agreementStore.usageOf(agreementId)).toHaveLength(2);
  });

  it('agreements without quota terms stay unlimited (infinite-resources default)', async () => {
    const agreementId = await activeAgreement(); // no terms
    await runningEnvSim();
    for (let i = 0; i < 3; i += 1) {
      const invoked = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/invocations`,
        headers: auth(consumer.token),
        payload: { action: 'turn-on' },
      });
      expect(invoked.statusCode).toBe(200);
    }
    expect(ctx.app.agreementStore.usageOf(agreementId)).toHaveLength(3);
  });

  it('windowKind fixed anchors tumbling windows at the agreement activation (Wave-6)', async () => {
    // quotaPerWindow 1 / windowSec 120, fixed. The (fabricated) activation
    // was 130s ago, so the CURRENT fixed window started only 10s ago — a
    // usage record from 60s ago belongs to the PREVIOUS fixed window and
    // must not count, while the trailing sliding window would still count it.
    const propose = (terms: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/services/${turnOnServiceId}/agreements`,
        headers: auth(consumer.token),
        payload: { terms },
      });
    const accept = async (id: string) => {
      const decided = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'accept' },
      });
      expect(decided.statusCode).toBe(200);
    };
    const invoke = (id: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${id}/invocations`,
        headers: auth(consumer.token),
        payload: { action: 'turn-on' },
      });
    const backdate = (id: string, secondsAgo: number) => {
      ctx.app.db
        .prepare('UPDATE service_agreements SET updated_at = ? WHERE id = ?')
        .run(new Date(Date.now() - secondsAgo * 1000).toISOString(), id);
    };
    const staleUsage = (id: string, secondsAgo: number) => {
      const agreement = ctx.app.agreementStore.getAgreement(id)!;
      const startedAt = new Date(Date.now() - secondsAgo * 1000).toISOString();
      ctx.app.agreementStore.appendUsage({
        agreementId: id,
        envId,
        consumerAgentId: agreement.consumer_agent_id,
        providerAgentId: agreement.provider_agent_id,
        kind: 'invoke',
        action: 'turn-on',
        quantity: 1,
        unit: 'action',
        outcome: 'success',
        startedAt,
        endedAt: startedAt,
      });
    };

    const fixedId = (await propose({ quotaPerWindow: 1, windowSec: 120, windowKind: 'fixed' })).json().id as string;
    const slidingId = (await propose({ quotaPerWindow: 1, windowSec: 120 })).json().id as string;
    await accept(fixedId);
    await accept(slidingId);
    await runningEnvSim();

    backdate(fixedId, 130);
    backdate(slidingId, 130);
    staleUsage(fixedId, 60);
    staleUsage(slidingId, 60);

    // Fixed: the stale record sits in the previous tumbling window → allowed.
    expect((await invoke(fixedId)).statusCode).toBe(200);
    // Sliding: the same stale record is still inside the trailing 120s → 429.
    const rejected = await invoke(slidingId);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe('QUOTA_EXCEEDED');
  });

  it('terms.windowKind is validated (sliding | fixed only)', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { quotaPerWindow: 1, windowSec: 60, windowKind: 'hourly' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('windowKind');

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: { terms: { quotaPerWindow: 1, windowSec: 60, windowKind: 'fixed' } },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().terms.windowKind).toBe('fixed');
  });

  // -------------------------------------------------------------------------
  // Stream parameter filter + backing device disambiguation (Fix-20)
  // -------------------------------------------------------------------------

  it('agreement payloads expose backingDeviceId; unbacked offers refuse PROPOSE (T-310) but legacy rows read null', async () => {
    const agreementId = await activeAgreement();
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(consumer.token),
    });
    const agreement = (list.json().agreements as Array<{ id: string; backingDeviceId: string | null }>)
      .find(row => row.id === agreementId)!;
    expect(agreement.backingDeviceId).toBe(hvacId);

    // An unbacked offer (published by the consumer on a device-less agent).
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: consumer.id,
      name: 'Broker',
      capabilities: [],
      boundDeviceIds: [],
    });
    const offer = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.id}/services`,
      headers: auth(consumer.token),
      payload: { name: 'Brokered', semanticType: 'turn-on' },
    });
    expect(offer.statusCode).toBe(201);
    // T-310: the contract boundary is honest — a contract that can never
    // deliver is refused with the bookmark remedy; subscribe stays 201.
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${offer.json().id}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SERVICE_NOT_BACKED');
    expect(refused.json().error.message).toContain('subscribe');
    const bookmark = await ctx.app.inject({
      method: 'PUT',
      url: `/api/services/${offer.json().id}/subscribe`,
      headers: auth(consumer.token),
    });
    expect(bookmark.statusCode).toBe(201);

    // Existing (legacy) proposed-unbacked rows keep their read paths — the
    // payload still resolves backingDeviceId to null instead of failing.
    const legacy = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId: offer.json().id as string,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: agent.id,
      providerOwnerId: consumer.id,
      terms: {},
    });
    const legacyList = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements?envId=${envId}`,
      headers: auth(consumer.token),
    });
    const legacyRow = (legacyList.json().agreements as Array<{ id: string; backingDeviceId: string | null }>)
      .find(row => row.id === legacy.id)!;
    expect(legacyRow.backingDeviceId).toBeNull();
  });

  it('T-310: service list/get label unbacked offers consumable:false with the reason', async () => {
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: consumer.id,
      name: 'Aggregator',
      capabilities: [],
      boundDeviceIds: [],
    });
    const offer = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents/${agent.id}/services`,
      headers: auth(consumer.token),
      payload: { name: 'care-status-aggregate', semanticType: 'care-status' },
    });
    expect(offer.statusCode).toBe(201);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(consumer.token),
    });
    const row = (listed.json().services as Array<{
      name: string; unbacked: boolean; consumable: boolean; consumableNote?: string;
    }>).find(s => s.name === 'care-status-aggregate')!;
    expect(row.unbacked).toBe(true);
    expect(row.consumable).toBe(false);
    expect(row.consumableNote).toContain('no backing device');
    expect(row.consumableNote).toContain('subscribe');

    const single = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${offer.json().id}`,
      headers: auth(consumer.token),
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().consumable).toBe(false);
    expect(single.json().consumableNote).toBeDefined();

    // A BACKED derived service reads consumable:true with no note.
    const derived = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${turnOnServiceId}`,
      headers: auth(consumer.token),
    });
    expect(derived.json().consumable).toBe(true);
    expect(derived.json().consumableNote).toBeUndefined();
  });

  it('stream ?params= pushes only frames where a listed parameter changed', async () => {
    const baseUrl = await listen();
    const agreementId = await activeAgreement();
    const simId = await runningEnvSim();

    // A filter matching nothing → no observation frames (but the session
    // upgrades and the subscribed frame echoes the filter).
    const filtered = new WebSocket(
      `${baseUrl}/api/agreements/${agreementId}/stream?params=no-such-param`,
      { headers: auth(consumer.token) },
    );
    const filteredFrames = collect(filtered);
    await waitFor(() => filteredFrames.some(frame => frame.kind === 'subscribed'));
    expect(filteredFrames[0].params).toEqual(['no-such-param']);

    const unfiltered = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const unfilteredFrames = collect(unfiltered);
    await waitFor(() => unfilteredFrames.some(frame => frame.kind === 'subscribed'));

    // T-501: the invokes pin the sim the STREAMS bound (the omitted-id
    // default is the authoritative world session now).
    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(invoked.statusCode).toBe(200);
    await waitFor(() => unfilteredFrames.some(frame => frame.kind === 'observation'));
    // Negative window (R21 test-debt): the filtered socket must NOT deliver
    // the observation — no positive signal exists; the anchor (unfiltered
    // frame observed) plus a generous 300ms bound catches a leaking filter.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(filteredFrames.some(frame => frame.kind === 'observation')).toBe(false);

    // A filter naming the changed parameter receives the next frame.
    const changedParam = (
      unfilteredFrames.find(frame => frame.kind === 'observation')!
        .changedParameters as string[]
    )[0];
    const positive = new WebSocket(
      `${baseUrl}/api/agreements/${agreementId}/stream?params=${encodeURIComponent(changedParam)}`,
      { headers: auth(consumer.token) },
    );
    const positiveFrames = collect(positive);
    await waitFor(() => positiveFrames.some(frame => frame.kind === 'subscribed'));
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-off', simulationId: simId },
    });
    await waitFor(() => positiveFrames.some(frame => frame.kind === 'observation'));

    filtered.close();
    unfiltered.close();
    positive.close();
  });

  it('stream rejects a malformed ?params= filter before the upgrade', async () => {
    const baseUrl = await listen();
    const agreementId = await activeAgreement();
    await runningEnvSim();

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream?params=`, {
        headers: auth(consumer.token),
      });
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.on('open', () => resolve(101));
      socket.on('error', reject);
    });
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Reputation from usage outcomes (§5)
  // -------------------------------------------------------------------------

  it('R101: explicit-lane metered invokes score success AND failure (PM round-4 ruling)', async () => {
    const agreementId = await activeAgreement();
    const simId = await runningEnvSim();

    const before = ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on');
    expect(before).toBeUndefined();

    // Fix-44g: a GENUINE execution failure (fault-injected device), not a
    // vocabulary probe — unknown actions are consumer errors, unmetered and
    // unscored (see agreements.vitest.test.ts).
    const fault = await ctx.app.inject({
      method: 'PUT',
      url: `/api/simulations/${simId}/faults/${hvacId}`,
      headers: auth(consumer.token),
      payload: { offline: true },
    });
    expect(fault.statusCode).toBe(200);

    const failed = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      // T-501: pin the faulted sim (the omitted-id default is the healthy
      // authoritative world session now).
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().success).toBe(false);
    expect(failed.json().usage.outcome).toBe('failure');

    const afterFailure = ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!;
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.successes).toBe(0);

    // R101: a SUCCESS now scores too (the explicit lane's metered usage is
    // the provider's objective track record — success was previously
    // invisible because only the AC runtime pipeline scored).
    const cleared = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/simulations/${simId}/faults/${hvacId}`,
      headers: auth(consumer.token),
    });
    expect(cleared.statusCode).toBe(200);
    const succeeded = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(succeeded.json().success).toBe(true);
    const afterSuccess = ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!;
    expect(afterSuccess.attempts).toBe(2);
    expect(afterSuccess.successes).toBe(1);
  });

  it('R101 (zhao-17 replay): 3 successes score 3/3; an out-of-surface command is a consumer error (R103: unmetered, unscored); sim stop does not clobber; service get shows usageSummary + trackRecord', async () => {
    const agreementId = await activeAgreement();
    const simId = await runningEnvSim();

    for (let i = 0; i < 3; i++) {
      const ok = await ctx.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/invocations`,
        headers: auth(consumer.token),
        payload: { action: 'turn-on', simulationId: simId },
      });
      expect(ok.json().success).toBe(true);
    }
    // R103 (zhao-23): a command the backing device cannot execute is a
    // CONSUMER-side error — 422 teaching, never metered or scored against
    // the provider (this refines the original zhao-17 replay, which counted
    // the gate refusal as a provider failure).
    const refused = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'self-destruct', simulationId: simId },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe('DEVICE_COMMAND_NOT_EXECUTABLE');

    const scored = ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!;
    expect(scored.attempts).toBe(3);
    expect(scored.successes).toBe(3);

    // The stale-snapshot clobber is gone: stopping the sim (whose tracker
    // learned nothing since its load-time baseline) leaves the invoke
    // lane's increments intact.
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/stop`,
      headers: auth(owner.token),
    });
    expect(stopped.statusCode).toBe(200);
    const afterStop = ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!;
    expect(afterStop.attempts).toBe(3);
    expect(afterStop.successes).toBe(3);

    // The market surface: usageSummary is stranger-verifiable (aggregate)
    // and trackRecord distinguishes the proven service from a fresh one.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${turnOnServiceId}`,
      headers: auth(stranger.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().trackRecord).toBe('established');
    expect(detail.json().usageSummary).toMatchObject({
      windowDays: 30,
      invocations: 3,
      succeeded: 3,
      failed: 0,
      successRate: 1,
    });
  });

  it('R101: AC-sourced agreements never score in the invoke lane (runtime covers them — no double accounting)', async () => {
    const agreementId = await activeAgreement();
    // Flip the fixture agreement to the AC source (the ephemeral lane).
    ctx.app.db
      .prepare("UPDATE service_agreements SET source = 'ac' WHERE id = ?")
      .run(agreementId);
    const simId = await runningEnvSim();

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(ok.json().success).toBe(true);
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')).toBeUndefined();
  });

  it('R101: a service with zero attempts is marked trackRecord none (cold start ≠ proven)', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${turnOnServiceId}`,
      headers: auth(stranger.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().trackRecord).toBe('none');
    expect(detail.json().usageSummary).toMatchObject({
      windowDays: 30,
      invocations: 0,
      successRate: null,
    });
  });

  it('T121 (R10-u4): a card carrying usageSummary carries the reputation-vs-usage methodology note (same denominators disclosure)', async () => {
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${turnOnServiceId}`,
      headers: auth(stranger.token),
    });
    expect(detail.statusCode).toBe(200);
    const note = detail.json().methodologyNote as string | undefined;
    expect(note).toBeDefined();
    expect(note).toContain('ALL-HISTORY');
    expect(note).toContain('last-30-days');
    expect(note).toContain('different denominators');
  });

  it('R102 one ledger: boot reconcile backfills reputation from metered usage (idempotent, AC excluded, incremental on top)', async () => {
    const agreementId = await activeAgreement();
    // Simulate PRE-R101 history: metered usage rows with NO reputation write
    // (zhao-20's broadcast service shape — 6 failures, score frozen at 0.7).
    const now = new Date().toISOString();
    for (const outcome of ['success', 'success', 'success', 'failure'] as const) {
      ctx.app.agreementStore.appendUsage({
        agreementId, envId, consumerAgentId: null, providerAgentId: labAgentId,
        kind: 'invoke', action: 'turn-on', quantity: 1, unit: 'action',
        outcome, effectRef: null, startedAt: now, endedAt: now,
      });
    }
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')).toBeUndefined();

    const touched = ctx.app.reputationStore.reconcileFromMeteredUsage();
    expect(touched).toBeGreaterThanOrEqual(1);
    const rep = ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!;
    expect(rep.attempts).toBe(4);
    expect(rep.successes).toBe(3);
    // Idempotent: a second reconcile changes nothing (MAX-merge).
    ctx.app.reputationStore.reconcileFromMeteredUsage();
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!.attempts).toBe(4);

    // The incremental invoke lane keeps counting ON TOP of the backfill.
    const simId = await runningEnvSim();
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(ok.json().success).toBe(true);
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!.attempts).toBe(5);
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!.successes).toBe(4);

    // AC-sourced usage is the runtime's lane — excluded from the reconcile.
    const acId = await activeAgreement();
    ctx.app.db.prepare("UPDATE service_agreements SET source = 'ac' WHERE id = ?").run(acId);
    for (const _ of [1, 2]) {
      ctx.app.agreementStore.appendUsage({
        agreementId: acId, envId, consumerAgentId: null, providerAgentId: labAgentId,
        kind: 'ac', action: null, quantity: 1, unit: 'collaboration',
        outcome: 'success', effectRef: null, startedAt: now, endedAt: now,
      });
    }
    ctx.app.reputationStore.reconcileFromMeteredUsage();
    expect(ctx.app.reputationStore.scoreFor(envId, labAgentId, 'turn-on')!.attempts).toBe(5);

    // The service face agrees: trackRecord established + summary consistent.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${turnOnServiceId}`,
      headers: auth(stranger.token),
    });
    expect(detail.json().trackRecord).toBe('established');
    expect(detail.json().usageSummary.invocations).toBeGreaterThanOrEqual(7);
  });

  it('R102: usageSummary差额有名有姓——invocations = succeeded + failed + partial + other', async () => {
    const agreementId = await activeAgreement();
    const now = new Date().toISOString();
    for (const outcome of ['success', 'failure', 'partial'] as const) {
      ctx.app.agreementStore.appendUsage({
        agreementId, envId, consumerAgentId: null, providerAgentId: labAgentId,
        kind: 'invoke', action: 'turn-on', quantity: 1, unit: 'action',
        outcome, effectRef: null, startedAt: now, endedAt: now,
      });
    }
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/services/${turnOnServiceId}`,
      headers: auth(stranger.token),
    });
    expect(detail.json().usageSummary).toMatchObject({
      invocations: 3,
      succeeded: 1,
      failed: 1,
      partial: 1,
      other: 0,
    });
  });

  // -------------------------------------------------------------------------
  // Config flag
  // -------------------------------------------------------------------------

  it('AC_EPHEMERAL_AGREEMENTS defaults to true and honors an explicit off', () => {
    expect(loadConfig({}).acEphemeralAgreements).toBe(true);
    expect(loadConfig({ AC_EPHEMERAL_AGREEMENTS: 'false' }).acEphemeralAgreements).toBe(false);
    expect(loadConfig({ AC_EPHEMERAL_AGREEMENTS: '0' }).acEphemeralAgreements).toBe(false);
    // Stream heartbeat (F-21): 30s default, overridable.
    expect(loadConfig({}).agreementStreamHeartbeatMs).toBe(30_000);
    expect(loadConfig({ AGREEMENT_STREAM_HEARTBEAT_MS: '5000' }).agreementStreamHeartbeatMs).toBe(5000);
  });

  // -------------------------------------------------------------------------
  // Stream heartbeat (Fix-15, F-21)
  // -------------------------------------------------------------------------

  it('heartbeat ends a dead-peer stream and still meters it (F-21)', async () => {
    // A killed CLI does not always close its TCP socket (the npx/tsx wrapper
    // dies, the orphaned node child keeps the connection open) — no close
    // frame, no FIN. The ping/pong heartbeat must detect the dead peer and
    // terminate the socket so the session is metered. Uses a dedicated app
    // with a 60ms cadence instead of the 30s default.
    const hb = await makeTestApp({ agreementStreamHeartbeatMs: 60 });
    try {
      const hbOwner = await registerUser(hb.app, { displayName: 'Owner' });
      const hbConsumer = await registerUser(hb.app, { displayName: 'Consumer' });
      const created = await hb.app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: auth(hbOwner.token),
        payload: { ...importableScenario('phase2-lab-hb'), visibility: 'public' },
      });
      const hbEnvId = created.json().id as string;
      await hb.app.inject({
        method: 'POST',
        url: `/api/environments/${hbEnvId}/join`,
        headers: auth(hbConsumer.token),
      });
      const services = await hb.app.inject({
        method: 'GET',
        url: `/api/environments/${hbEnvId}/services`,
        headers: auth(hbOwner.token),
      });
      const serviceId = (services.json().services as Array<{ id: string; name: string }>)
        .find(service => service.name === 'HVAC B: 开启')!.id;
      const proposed = await hb.app.inject({
        method: 'POST',
        url: `/api/services/${serviceId}/agreements`,
        headers: auth(hbConsumer.token),
        payload: {},
      });
      const agreementId = proposed.json().id as string;
      await hb.app.inject({
        method: 'POST',
        url: `/api/agreements/${agreementId}/decide`,
        headers: auth(hbOwner.token),
        payload: { decision: 'accept' },
      });
      const sim = await hb.app.inject({
        method: 'POST',
        url: '/api/simulations',
        headers: auth(hbOwner.token),
        payload: { environmentId: hbEnvId },
      });
      await hb.app.inject({
        method: 'POST',
        url: `/api/simulations/${sim.json().id as string}/start`,
        headers: auth(hbOwner.token),
        payload: {},
      });

      await hb.app.listen({ port: 0, host: '127.0.0.1' });
      const address = hb.app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/agreements/${agreementId}/stream`, {
        headers: auth(hbConsumer.token),
      });
      const frames: Array<Record<string, unknown>> = [];
      socket.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
      await waitFor(() => frames.some(frame => frame.kind === 'subscribed'));

      // Simulate the dead peer: stop reading — pings are never processed,
      // so no pong ever leaves the client (kernel TCP ACKs don't count).
      socket.pause();
      await waitFor(
        () => hb.app.agreementStore.usageOf(agreementId).some(record => record.kind === 'stream'),
        10_000,
      );
      const streamUsage = hb.app.agreementStore.usageOf(agreementId)
        .filter(record => record.kind === 'stream');
      expect(streamUsage).toHaveLength(1);
      expect(streamUsage[0].unit).toBe('message');
    } finally {
      await hb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T-109: suspension stops established streams; consumer errors stay silent
// ---------------------------------------------------------------------------

describe('agreement stream suspension + consumer-error notify (T-109)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let hvacId: string;
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('phase2-lab'), visibility: 'public' },
    });
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
    turnOnServiceId = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name === 'HVAC B: 开启')!.id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Local copy of the waitFor helper (the shared one is scoped above). */
  function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (predicate()) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - started > ms) {
          clearInterval(poll);
          reject(new Error('waitFor timed out'));
        }
      }, 25);
    });
  }

  async function inboxKinds(token: string): Promise<string[]> {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/notifications', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return (res.json().notifications as Array<{ kind: string }>).map(n => n.kind);
  }

  it('suspension closes the established socket on the next device event and meters failure', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const baseUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    const agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    const simId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/simulations',
        headers: auth(owner.token),
        payload: { environmentId: envId },
      })
    ).json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', data => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await waitFor(() => frames.some(frame => frame.kind === 'subscribed'));

    // Live stream: an invoke pushes an observation frame. T-501: pin the
    // sim the stream bound (the omitted-id default is the world session).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'turn-on', simulationId: simId },
    });
    await waitFor(() => frames.some(frame => frame.kind === 'observation'));

    // A consumer-side error (typo'd action) does NOT notify the provider.
    // T-303: the typo is now refused pre-execution by the device gate (422,
    // metered as failure) — still a consumer-side error, no provider ping.
    const before = await inboxKinds(owner.token);
    const probe = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { action: 'warp-drive' },
    });
    expect(probe.statusCode).toBe(422);
    expect(probe.json().error.code).toBe('DEVICE_COMMAND_NOT_EXECUTABLE');
    expect(await inboxKinds(owner.token)).toEqual(before);

    // Suspend → the ESTABLISHED socket must stop delivering observations.
    const suspended = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
    });
    expect(suspended.statusCode).toBe(200);

    // Toggling the backing device after suspension produces a device-state
    // change: the session must answer with a 'closed' frame, never another
    // observation.
    const toggled = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/commands`,
      headers: auth(owner.token),
      payload: { deviceId: hvacId, commandName: 'turn-off', params: {} },
    });
    expect(toggled.statusCode).toBe(200);
    await waitFor(() => frames.some(frame => frame.kind === 'closed'));
    const closedFrame = frames.find(frame => frame.kind === 'closed')!;
    expect(closedFrame.reason).toContain('suspended');
    expect(frames.filter(frame => frame.kind === 'observation')).toHaveLength(1);

    // Reconnect while suspended keeps the pre-existing 409.
    const reconnect = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
      headers: auth(consumer.token),
    });
    const rejected = await new Promise<number>(resolve => {
      reconnect.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      reconnect.on('open', () => resolve(-1));
    });
    expect(rejected).toBe(409);

    // The ended session meters a non-success outcome.
    await waitFor(() => ctx.app.agreementStore.usageOf(agreementId)
      .some(record => record.kind === 'stream' && record.outcome === 'failure'));
    socket.close();
  });

  it('a genuine provider-side invoke failure still notifies the provider (T-109 regression guard)', async () => {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    const agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    const simId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/simulations',
        headers: auth(owner.token),
        payload: { environmentId: envId },
      })
    ).json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    const fault = await ctx.app.inject({
      method: 'PUT',
      url: `/api/simulations/${simId}/faults/${hvacId}`,
      headers: auth(consumer.token),
      payload: { offline: true },
    });
    expect(fault.statusCode).toBe(200);

    const failed = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      // T-501: pin the faulted sim (the omitted-id default is the healthy
      // authoritative world session now).
      payload: { action: 'turn-on', simulationId: simId },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().success).toBe(false);
    expect(await inboxKinds(owner.token)).toContain('agreement.invoke-failed');
  });

  it('T-306: a stream upgrade on an ambiguously-backed agreement is rejected 409 (not a silent first-match bind)', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('listen failed');
    const baseUrl = `ws://127.0.0.1:${address.port}`;

    // Two devices covering 'temperature-reading', one provider agent bound to
    // both — a pre-fix agreement row on an ambiguously-backed service.
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
        name: 'HVAC Unit 102', type: 'hvac',
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
      payload: { name: 'Ambient Reading', semanticType: 'temperature-reading' },
    });
    expect(published.statusCode).toBe(201);
    const serviceId = published.json().id as string;

    const row = ctx.app.agreementStore.createAgreement({
      envId,
      serviceId,
      consumerAgentId: null,
      consumerOwnerId: consumer.id,
      providerAgentId: ctx.app.serviceStore.getService(serviceId)!.provider_agent_id,
      providerOwnerId: owner.id,
      terms: {},
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${row.id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    const simId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/simulations',
        headers: auth(owner.token),
        payload: { environmentId: envId },
      })
    ).json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    const attempt = new WebSocket(`${baseUrl}/api/agreements/${row.id}/stream`, {
      headers: auth(consumer.token),
    });
    const status = await new Promise<number>((resolve, reject) => {
      attempt.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      attempt.on('open', () => resolve(101));
      attempt.on('error', reject);
    });
    expect(status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// T-311 (DevLoop R12, EN-F10) — stream sim targeting has invoke parity
// ---------------------------------------------------------------------------

describe('stream sim targeting parity (T-311)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let turnOnServiceId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    consumer = await registerUser(ctx.app, { displayName: 'Consumer' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: { ...importableScenario('t311-lab'), visibility: 'public' },
    });
    envId = created.json().id;
    await ctx.app.inject({ method: 'POST', url: `/api/environments/${envId}/join`, headers: auth(consumer.token) });
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    turnOnServiceId = (services.json().services as Array<{ id: string; name: string }>)
      .find(s => s.name === 'HVAC B: 开启')!.id;
  });
  afterEach(async () => { await ctx.cleanup(); });

  async function simAs(token: string): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(token),
      payload: { environmentId: envId },
    });
    const simId = created.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(token),
      payload: {},
    });
    return simId;
  }

  async function activeAgreementId(): Promise<string> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${turnOnServiceId}/agreements`,
      headers: auth(consumer.token),
      payload: {},
    });
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${id}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    return id;
  }

  it('two running sims and no param → 409 SIMULATION_AMBIGUOUS; ?simulationId binds that sim', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('listen failed');
    const baseUrl = `ws://127.0.0.1:${address.port}`;

    const agreementId = await activeAgreementId();
    const simA = await simAs(owner.token);
    const simB = await simAs(owner.token);

    const attempt = (query: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream${query}`, {
          headers: auth(consumer.token),
        });
        socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        socket.on('open', () => resolve(101));
        socket.on('error', reject);
      });

    // No param → ambiguity is an explicit 409, never a silent first-match bind.
    expect(await attempt('')).toBe(409);

    // Explicit param → the upgrade binds THAT sim (hello frame names it).
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream?simulationId=${simA}`, {
        headers: auth(consumer.token),
      });
      socket.on('message', data => {
        const frame = JSON.parse(String(data)) as { kind: string; simulationId?: string };
        if (frame.kind === 'subscribed') {
          expect(frame.simulationId).toBe(simA);
          socket.close();
          resolve();
        }
      });
      socket.on('error', reject);
    });

    // An explicit but unknown id → 404 before the upgrade.
    expect(await attempt('?simulationId=sim-does-not-exist')).toBe(404);

    void simB;
  });

  it('single running sim → unchanged default binding', async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('listen failed');
    const baseUrl = `ws://127.0.0.1:${address.port}`;

    const agreementId = await activeAgreementId();
    const simId = await simAs(owner.token);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}/api/agreements/${agreementId}/stream`, {
        headers: auth(consumer.token),
      });
      socket.on('message', data => {
        const frame = JSON.parse(String(data)) as { kind: string; simulationId?: string };
        if (frame.kind === 'subscribed') {
          expect(frame.simulationId).toBe(simId);
          socket.close();
          resolve();
        }
      });
      socket.on('error', reject);
    });
  });
});
