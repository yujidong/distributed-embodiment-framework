/**
 * @vitest-environment node
 *
 * T-035 (DevLoop R17) — agreement trigger-clause auto-execution (SF-F03).
 *
 * Wave-4a persisted structured terms.trigger/action but nothing ever
 * executed them: the consumer injected the exact trigger of an active
 * agreement and nothing happened — "active agreement" did not deliver the
 * promised automation. The executor (agreement-trigger-executor.ts)
 * subscribes every env-backed sim's injected events; a matching trigger on
 * an ACTIVE agreement executes the agreed action through the SAME
 * invocation core as manual invokes: metered UsageRecord (kind=invoke),
 * settlement receipt, command_log audit attributed to the agreement + the
 * triggering event. Suspended agreements never fire; non-matching events
 * do nothing; a spent quota window skips (logged, unmetered) — the manual
 * 429 policy.
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

describe('agreement trigger auto-execution (T-035)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
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
      payload: { ...importableScenario('trigger-autoexec-lab'), visibility: 'public' },
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

    // Propose with a trigger clause + the agreed action, then accept → ACTIVE.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          notes: 'heat wave in zone-a → provider turns the HVAC unit on',
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'turn-on' },
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
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');

    // A RUNNING env-backed sim — the executor is attached at its creation.
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

  function inject(zoneId: string, type: string, value?: number) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: {
        type,
        zoneId,
        ...(type === 'temperature-spike' ? { parameter: 'temperature', ...(value !== undefined ? { value } : {}) } : {}),
      },
    });
  }

  async function usageRows(): Promise<Array<{ kind: string; action: string; outcome: string }>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().usage as Array<{ kind: string; action: string; outcome: string }>;
  }

  /** Poll until the async auto-invocation lands (bounded). */
  async function waitForUsage(timeoutMs = 3000): Promise<Array<{ kind: string; action: string; outcome: string }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await usageRows();
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('a matching event auto-invokes the agreed action through the metered path', async () => {
    const res = await inject('zone-a', 'temperature-spike', 35);
    expect(res.statusCode).toBeLessThan(300);

    const rows = await waitForUsage();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ kind: 'invoke', action: 'turn-on', outcome: 'success' });
    // FEAT-08/UX-04: the row names the sim that metered it and the lane it
    // entered through — the trigger automation, not a manual invoke.
    expect(rows[0]).toMatchObject({ source: 'autoTrigger', simulationId: simId });

    // Same settlement lane as manual invokes: a receipt exists.
    const receipts = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/receipts`,
      headers: auth(consumer.token),
    });
    expect(receipts.statusCode).toBe(200);
    expect((receipts.json().receipts as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Audit trail: the command_log entry is attributed to the AGREEMENT and
    // the triggering event (autoTrigger), with the consumer owner as actor.
    const logRow = (ctx.app.db
      .prepare('SELECT actor_id, kind, payload_json FROM command_log WHERE payload_json LIKE ?')
      .all(`%"${agreementId}"%`) as Array<{ actor_id: string; kind: string; payload_json: string }>)
      .find(row => row.kind === 'device-command');
    expect(logRow).toBeDefined();
    const payload = JSON.parse(logRow!.payload_json) as {
      agreementId: string;
      autoTrigger?: { eventType: string; zoneId: string };
      commandName: string;
    };
    expect(payload.agreementId).toBe(agreementId);
    expect(payload.commandName).toBe('turn-on');
    expect(payload.autoTrigger).toMatchObject({ eventType: 'temperature-spike', zoneId: 'zone-a' });
    expect(logRow!.actor_id).toBe(consumer.id);
  });

  it('FEAT-08/UX-04: a manual invoke row carries source=manual + the target sim; the trigger row stays autoTrigger', async () => {
    // One trigger fire first (autoTrigger row), then a manual invoke against
    // the SAME agreement + sim — the two rows must be distinguishable.
    await inject('zone-a', 'temperature-spike', 35);
    await waitForUsage();

    const invoked = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/invocations`,
      headers: auth(consumer.token),
      payload: { simulationId: simId, action: 'turn-on' },
    });
    expect(invoked.statusCode).toBe(200);
    expect(invoked.json().success).toBe(true);

    const rows = (await usageRows()) as Array<{ outcome: string; source?: string; simulationId?: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ source: 'autoTrigger', simulationId: simId });
    expect(rows[1]).toMatchObject({ source: 'manual', simulationId: simId });
  });

  it('non-matching events do nothing (below threshold / other type / other zone)', async () => {
    await inject('zone-a', 'temperature-spike', 25); // below threshold 30
    await inject('zone-a', 'motion-detected'); // different event type
    await inject('zone-b', 'temperature-spike', 35); // different zone

    // Negative window (R21 test-debt): no positive signal exists for "the
    // trigger never fires" — 400ms is a generous bound (a matching fire
    // lands in tens of ms via the waitForUsage poll path) so a slow-but-
    // present wrong fire is still caught.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await usageRows()).toEqual([]);
  });

  it('BUG-03: an AC-shaped agreement (trigger WITHOUT action) never auto-executes on a matching event', async () => {
    // The AC ephemeral bridge lands terms.trigger (eventType + comma-joined
    // capabilities + zoneId, no terms.action) — contract data only. The
    // T-035 executor must not read such a trigger as an automation clause
    // even when an injected event matches every field.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature' },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const acShapedId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${acShapedId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');

    await inject('zone-a', 'temperature-spike', 35);

    // Same negative window as 'non-matching events do nothing' — a wrong
    // fire would land its metered row in tens of ms.
    await new Promise(resolve => setTimeout(resolve, 400));
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${acShapedId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toEqual([]);
  });

  it('a suspended agreement does not fire', async () => {
    const suspended = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(suspended.statusCode).toBe(200);

    await inject('zone-a', 'temperature-spike', 35);
    // Negative window (R21 test-debt): no positive signal exists for "the
    // trigger never fires" — 400ms is a generous bound (a matching fire
    // lands in tens of ms via the waitForUsage poll path) so a slow-but-
    // present wrong fire is still caught.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await usageRows()).toEqual([]);
  });

  it('a spent quota window skips the auto-invoke and meters the skip reason (C3)', async () => {
    // Re-propose with a 1-per-window quota on the same service.
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          quotaPerWindow: 1,
          windowSec: 3600,
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'turn-on' },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const quotaAgreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${quotaAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);

    // First matching injection fires (and meters) once.
    await inject('zone-a', 'temperature-spike', 35);
    const first = await (async () => {
      const deadline = Date.now() + 3000;
      for (;;) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/agreements/${quotaAgreementId}/usage`,
          headers: auth(consumer.token),
        });
        const rows = res.json().usage as Array<{ outcome: string; failureReason?: string }>;
        if (rows.length > 0 || Date.now() > deadline) return rows;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })();
    expect(first.length).toBe(1);
    expect(first[0]).toMatchObject({ outcome: 'success' });

    // Second matching injection: quota spent → skipped, and C3 (R25-NF4)
    // meters the skip as outcome='failure' with the REASON — the consumer
    // no longer needs the server log to know why nothing happened (and the
    // failure row burns no quota: countUsageSince counts successes only).
    await inject('zone-a', 'temperature-spike', 36);
    const second = await (async () => {
      const deadline = Date.now() + 3000;
      for (;;) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/agreements/${quotaAgreementId}/usage`,
          headers: auth(consumer.token),
        });
        const rows = res.json().usage as Array<{ outcome: string; failureReason?: string }>;
        if (rows.length > 1 || Date.now() > deadline) return rows;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })();
    expect(second.length).toBe(2);
    expect(second[1]).toMatchObject({ kind: 'invoke', action: 'turn-on', outcome: 'failure' });
    expect(second[1].failureReason).toContain('quota window spent');
    expect(second[1].failureReason).toContain('1/1');
    // FEAT-08/UX-04: the skip row is attributed exactly like the fire it
    // replaced — the trigger lane, in the sim it fired in.
    expect(second[1]).toMatchObject({ source: 'autoTrigger', simulationId: simId });
  });

  it('UX-05: terms.meteringUnit lands on both the fired and the quota-skipped trigger rows', async () => {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          meteringUnit: 'actuation',
          quotaPerWindow: 1,
          windowSec: 3600,
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'turn-on' },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const meteredAgreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${meteredAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);

    // First injection fires (invoke-lane), the second hits the spent quota
    // window (meterSkippedTrigger) — BOTH rows carry the negotiated unit.
    await inject('zone-a', 'temperature-spike', 35);
    await inject('zone-a', 'temperature-spike', 36);
    const deadline = Date.now() + 3000;
    let rows: Array<{ outcome: string; unit: string }> = [];
    for (;;) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/agreements/${meteredAgreementId}/usage`,
        headers: auth(consumer.token),
      });
      rows = res.json().usage as Array<{ outcome: string; unit: string }>;
      if (rows.length > 1 || Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ outcome: 'success', unit: 'actuation' });
    expect(rows[1]).toMatchObject({ outcome: 'failure', unit: 'actuation' });
  });

  // -------------------------------------------------------------------
  // C3 (R25-NF4, DevLoop R28): triggered-execution failures name WHY on
  // the usage row the consumer reads — the R25 acceptance had to reproduce
  // the command manually to learn the param vocabulary.
  // -------------------------------------------------------------------
  it('C3: a device-rejected trigger execution carries the failure reason on the usage row', async () => {
    // A second agreement whose agreed action the device cannot execute
    // meaningfully: set-temperature with no temperature param → the device
    // rejects it with its vocabulary teaching (the NF4 repro shape).
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    const temperatureControl = ((services.json().services as Array<{ id: string; name: string; semanticType: string }>)
      .find(service => service.semanticType === 'temperature-control'));
    expect(temperatureControl).toBeDefined();
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${temperatureControl.id}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'set-temperature' }, // no temperature param
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const rejectedAgreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${rejectedAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);

    await inject('zone-a', 'temperature-spike', 35);
    const rows = await (async () => {
      const deadline = Date.now() + 3000;
      for (;;) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/agreements/${rejectedAgreementId}/usage`,
          headers: auth(consumer.token),
        });
        const found = res.json().usage as Array<{ outcome: string; failureReason?: string }>;
        if (found.length > 0 || Date.now() > deadline) return found;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('failure');
    // The reason is the DEVICE's teaching (param vocabulary), on the row —
    // not a server log line.
    expect(typeof rows[0].failureReason).toBe('string');
    expect(rows[0].failureReason!.length).toBeGreaterThan(0);
  });

  it('C3: a backing device absent from the running sim meters the 409 reason (stale-sim drift)', async () => {
    // RT26-F05 shape: the sim PREDATES a late install — the env gains a new
    // device + derived service after the sim was built, so the trigger's
    // target device exists in the env but not in the runtime.
    const newDevice = ctx.app.envStore.createDevice({
      envId,
      ownerId: owner.id,
      name: 'Late HVAC',
      type: 'hvac',
      capabilities: ['turn-on'],
      zoneId: 'zone-b',
    });
    const labAgent = ctx.app.envStore.agentsOf(envId)[0]!;
    await ctx.app.envStore.updateAgent(labAgent.id, {
      boundDeviceIds: [...JSON.parse(labAgent.bound_device_ids_json) as string[], newDevice.id],
    });
    // The binding mints the derived service on the LATE device.
    const changes = ctx.app.serviceStore.syncDerivedForAgent(labAgent.id);
    const lateService = changes.find(change => change.action === 'created')?.row;
    expect(lateService).toBeDefined();

    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${lateService!.id}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'turn-on' },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const staleAgreementId = proposed.json().id as string;
    const decided = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${staleAgreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    expect(decided.statusCode).toBe(200);

    // The running sim was built BEFORE the late install → the trigger fires,
    // the shared core throws SERVICE_NOT_BACKED, and the 409's reason is
    // metered on the usage row instead of dying in a server log.
    await inject('zone-a', 'temperature-spike', 35);
    const rows = await (async () => {
      const deadline = Date.now() + 3000;
      for (;;) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/agreements/${staleAgreementId}/usage`,
          headers: auth(consumer.token),
        });
        const found = res.json().usage as Array<{ outcome: string; failureReason?: string }>;
        if (found.length > 0 || Date.now() > deadline) return found;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ outcome: 'failure' });
    expect(rows[0].failureReason).toContain('not present in the running simulation');
    expect(rows[0].failureReason).toContain(newDevice.id);
  });
});

/**
 * T-064 (DevLoop R17) — cross-zone escalation: the canonical ward→lobby-PA
 * scenario, end to end.
 *
 * A zone-scoped flow CANNOT actuate another zone's device BY DESIGN (the
 * flow invoker refuses cross-zone actuation — pinned by
 * EngineRuntime.flow-zone-targeting and flow-invoker-deviceid suites). The
 * governed path for "an event in zone A must drive a device in zone B" is an
 * AGREEMENT with a trigger clause on the ward event and terms.action on the
 * provider's lobby device: governed (terms-enforced, device-gated),
 * metered (UsageRecord + receipt) and attributed (command_log autoTrigger +
 * the invocation-context actor). This test proves that whole chain: ward
 * patient-call event → trigger fires → lobby PA set-message via the metered
 * path, with the PA's display state honestly attributed (contentSetBy =
 * agreement:<id> — the R17 invocation-context actor, NOT params pollution).
 */
describe('T-064: cross-zone escalation — ward patient-call → lobby PA (agreement trigger)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let consumer: TestUser;
  let envId: string;
  let agreementId: string;
  let simId: string;
  /** The PA's device-instance id (import remaps ids — capture at creation). */
  let paDeviceId: string;

  const MESSAGE = '3 号病房呼叫，请家属到一楼大厅服务台';

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Hospital Admin' });
    consumer = await registerUser(ctx.app, { displayName: 'Ward Station' });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        version: '1.0',
        meta: { id: 'ward-lobby-hospital', name: 'Ward Lobby Hospital' },
        zones: [
          { id: 'zone-ward', adjacentZoneIds: [] },
          { id: 'zone-lobby', adjacentZoneIds: [] },
        ],
        devices: [
          {
            id: 'ward-button',
            name: 'Ward Call Button',
            type: 'button',
            capabilities: ['press'],
            zoneId: 'zone-ward',
          },
          {
            id: 'lobby-pa',
            name: 'Lobby PA',
            type: 'display-panel',
            capabilities: ['set-message', 'turn-on', 'turn-off'],
            zoneId: 'zone-lobby',
          },
        ],
        agents: [
          {
            id: 'lobby-desk-agent',
            name: 'Lobby Desk Agent',
            capabilities: ['display-control'],
            managesZoneIds: ['zone-lobby'],
            boundDeviceIds: ['lobby-pa'],
          },
        ],
        events: [],
        visibility: 'public',
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id as string;
    paDeviceId = (created.json().devices as Array<{ id: string; name: string }>)
      .find(device => device.name === 'Lobby PA')!.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/join`,
      headers: auth(consumer.token),
    });

    // The provider's PA message service (derived from the set-message
    // capability: "Lobby PA: set-message").
    const services = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}/services`,
      headers: auth(owner.token),
    });
    expect(services.statusCode).toBe(200);
    const paService = (services.json().services as Array<{ id: string; name: string }>)
      .find(service => service.name.includes('set-message'));
    expect(paService).toBeDefined();

    // The escalation contract itself: WHEN a patient-call raises in the ward
    // THEN the lobby PA shows the negotiated message. terms.action.params are
    // BINDING (the consumer cannot widen or alter the agreed text).
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${paService!.id}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          notes: 'ward patient-call → lobby PA announcement',
          trigger: { eventType: 'patient-call', zoneId: 'zone-ward' },
          action: { command: 'set-message', params: { content: MESSAGE } },
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
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('active');

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

  async function waitForPaMessage(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snap = await ctx.app.inject({
        method: 'GET',
        url: `/api/simulations/${simId}/snapshot`,
        headers: auth(owner.token),
      });
      const pa = ((snap.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
        .find(device => device.id === paDeviceId))!;
      if (pa.state.content === MESSAGE || Date.now() > deadline) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('a ward-zone event escalates to the lobby-zone PA through the metered agreement path', async () => {
    // The ward button press (an event in zone-ward — a DIFFERENT zone than
    // the PA's zone-lobby; a zone-scoped flow would refuse this actuation).
    const injected = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'patient-call', zoneId: 'zone-ward' },
    });
    expect(injected.statusCode).toBeLessThan(300);

    // The PA actually displays the negotiated message…
    await waitForPaMessage();
    const snap = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    const pa = ((snap.json().devices as Array<{ id: string; state: Record<string, unknown> }>)
      .find(device => device.id === paDeviceId))!;
    expect(pa.state.content).toBe(MESSAGE);
    // …attributed to the AGREEMENT via the invocation-context actor (R17
    // params-purity), never by stamping params.actor.
    expect(pa.state.contentSetBy).toBe(`agreement:${agreementId}`);

    // Metered: exactly one successful invoke UsageRecord + a settlement receipt.
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.json().usage).toEqual([
      expect.objectContaining({ kind: 'invoke', action: 'set-message', outcome: 'success' }),
    ]);
    const receipts = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/receipts`,
      headers: auth(consumer.token),
    });
    expect((receipts.json().receipts as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Attributed: the command_log row names the agreement AND the ward event.
    const logRow = (ctx.app.db
      .prepare('SELECT actor_id, kind, payload_json FROM command_log WHERE payload_json LIKE ?')
      .all(`%"${agreementId}"%`) as Array<{ actor_id: string; kind: string; payload_json: string }>)
      .find(row => row.kind === 'device-command');
    expect(logRow).toBeDefined();
    const payload = JSON.parse(logRow!.payload_json) as {
      commandName: string;
      params?: Record<string, unknown>;
      autoTrigger?: { eventType: string; zoneId: string };
    };
    expect(payload.commandName).toBe('set-message');
    expect(payload.autoTrigger).toMatchObject({ eventType: 'patient-call', zoneId: 'zone-ward' });
    // Params purity holds on the audit trail too: only the negotiated content.
    expect(payload.params).toEqual({ content: MESSAGE });
  });

  it('an event in the LOBBY zone (the PA’s own zone) does not fire the ward trigger', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: { type: 'patient-call', zoneId: 'zone-lobby' },
    });
    // Negative window (R21 test-debt): no positive signal exists for "the
    // trigger never fires" — 400ms is a generous bound (a matching fire
    // lands in tens of ms via the waitForUsage poll path) so a slow-but-
    // present wrong fire is still caught.
    await new Promise(resolve => setTimeout(resolve, 400));
    const usage = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(usage.json().usage).toEqual([]);
  });
});
