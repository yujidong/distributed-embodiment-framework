/**
 * @vitest-environment node
 *
 * T-070 (DevLoop R22, FM-F05 terms half) — trigger-action auto-reset terms.
 *
 * An event-armed actuation used to peg a device indefinitely (the night's
 * floodlight stuck at 100%). terms.autoReset { afterSec | onEvent, action }
 * now rides the T-035 trigger automation: a SUCCESSFUL trigger-driven
 * invocation of terms.action arms ONE pending reset; afterSec fires it at
 * the sim-time deadline, onEvent fires it on the next matching injection;
 * the reset runs through the SAME metered path (usage + receipt +
 * command_log with an autoReset marker, invocation-context actor
 * 'agreement:<id>:auto-reset') and is NOT quota-gated. Suspended
 * agreements never reset (status re-read at fire time, arm dropped,
 * unmeterd). Validation: closed schema, autoReset without trigger+action
 * 400, missing action 400, no firing condition 400.
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

describe('agreement auto-reset terms (T-070)', () => {
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
      payload: { ...importableScenario('autoreset-lab'), visibility: 'public' },
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

  /** Propose trigger+action(+autoReset), accept, create + start a sim. */
  async function activateWithReset(
    autoReset: Record<string, unknown>,
  ): Promise<{ agreementId: string; simId: string }> {
    const proposed = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          notes: 'heat wave → on; the clause un-pegs itself',
          trigger: { eventType: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', threshold: 30 },
          action: { command: 'turn-on' },
          autoReset,
        },
      },
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
    return { agreementId, simId };
  }

  async function injectEvent(simId: string, type: string, value?: number, zoneId = 'zone-a') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/events`,
      headers: auth(owner.token),
      payload: {
        type,
        zoneId,
        ...(type === 'temperature-spike' ? { parameter: 'temperature', ...(value !== undefined ? { value } : {}) } : {}),
      },
    });
    expect(res.statusCode).toBeLessThan(300);
  }

  async function usageRows(agreementId: string): Promise<Array<{ kind: string; action: string; outcome: string }>> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/usage`,
      headers: auth(consumer.token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().usage as Array<{ kind: string; action: string; outcome: string }>;
  }

  /** Poll until the usage list contains `action` (bounded). */
  async function waitForAction(
    agreementId: string,
    action: string,
    timeoutMs = 6000,
  ): Promise<Array<{ kind: string; action: string; outcome: string }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await usageRows(agreementId);
      if (rows.some(row => row.action === action) || Date.now() > deadline) return rows;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it('afterSec: the reset fires after the window, metered and attributed', async () => {
    // Default sim: speed 1 sim-s/tick, tick 10ms → 100 sim-s per wall-s.
    // 150 sim-sec ≈ 1.5 wall-sec — fast for the test, still a real window.
    const { agreementId, simId } = await activateWithReset({
      afterSec: 150,
      action: { command: 'turn-off' },
    });

    await injectEvent(simId, 'temperature-spike', 35);
    const armed = await waitForAction(agreementId, 'turn-on');
    expect(armed.some(row => row.action === 'turn-on' && row.outcome === 'success')).toBe(true);

    const rows = await waitForAction(agreementId, 'turn-off');
    const reset = rows.find(row => row.action === 'turn-off');
    expect(reset).toMatchObject({ kind: 'invoke', outcome: 'success' });
    // UX-04: the reset row reads its own lane — 'autoReset', distinct from
    // the arming trigger's 'autoTrigger' row above it in the same ledger.
    expect(reset).toMatchObject({ source: 'autoReset' });
    expect(rows.find(row => row.action === 'turn-on')).toMatchObject({ source: 'autoTrigger' });

    // Same settlement lane: a receipt exists for the reset too.
    const receipts = await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}/receipts`,
      headers: auth(consumer.token),
    });
    expect(receipts.statusCode).toBe(200);
    expect((receipts.json().receipts as unknown[]).length).toBeGreaterThanOrEqual(2);

    // Audit trail: the reset's command_log entry names the agreement, the
    // autoReset marker, and the event that armed it; the device-state actor
    // is the agreement's automation ('agreement:<id>:auto-reset').
    const logRows = (ctx.app.db
      .prepare('SELECT payload_json FROM command_log WHERE payload_json LIKE ?')
      .all(`%"${agreementId}"%`) as Array<{ payload_json: string }>)
      .map(row => JSON.parse(row.payload_json) as {
        agreementId?: string;
        commandName?: string;
        autoReset?: { armedByEventType: string };
      });
    const resetRow = logRows.find(row => row.commandName === 'turn-off');
    expect(resetRow).toBeDefined();
    expect(resetRow!.agreementId).toBe(agreementId);
    expect(resetRow!.autoReset).toMatchObject({ armedByEventType: 'temperature-spike' });
  });

  it('T-505: a pending arm is observable on the agreement view, then absent after it fires', { timeout: 15_000 }, async () => {
    // 300 sim-s ≈ 3 wall-s at the default 100 sim-s/wall-s — a real window
    // long enough to observe the arm before it fires.
    const { agreementId, simId } = await activateWithReset({
      afterSec: 300,
      action: { command: 'turn-off' },
    });

    const view = (token: string) => ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(token),
    });

    // Before any trigger: nothing armed — the field is absent, not null.
    expect((await view(consumer.token)).json().armedReset).toBeUndefined();

    await injectEvent(simId, 'temperature-spike', 35);
    await waitForAction(agreementId, 'turn-on');

    // The arm is visible to the consumer (and the provider/env owner —
    // same visibility as the agreement itself): what will fire, when
    // (sim-time deadline on the armed runtime's clock), and the arming
    // event. dueSimSec is verifiable against the live sim clock: within
    // (0, afterSec] of now.
    const armed = (await view(consumer.token)).json();
    expect(armed.armedReset).toMatchObject({
      command: 'turn-off',
      armedByEventType: 'temperature-spike',
    });
    expect(String(armed.armedReset.armedByEventId)).toContain('temperature-spike');
    expect(typeof armed.armedReset.dueSimSec).toBe('number');
    const snapshot = await ctx.app.inject({
      method: 'GET',
      url: `/api/simulations/${simId}/snapshot`,
      headers: auth(owner.token),
    });
    const simTimeSec = snapshot.json().simTimeSec as number;
    expect(armed.armedReset.dueSimSec - simTimeSec).toBeGreaterThan(0);
    expect(armed.armedReset.dueSimSec - simTimeSec).toBeLessThanOrEqual(300);

    const asProvider = (await view(owner.token)).json();
    expect(asProvider.armedReset).toBeDefined();

    // After the reset fires, the field is gone.
    await waitForAction(agreementId, 'turn-off');
    const fired = (await view(consumer.token)).json();
    expect(fired.armedReset).toBeUndefined();
  });

  it('T-505: suspending the agreement drops the observable arm (runtime state, not a promise)', async () => {
    const { agreementId, simId } = await activateWithReset({
      afterSec: 300,
      action: { command: 'turn-off' },
    });
    await injectEvent(simId, 'temperature-spike', 35);
    await waitForAction(agreementId, 'turn-on');
    const before = (await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(consumer.token),
    })).json();
    expect(before.armedReset).toBeDefined();

    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
      payload: {},
    });
    const after = (await ctx.app.inject({
      method: 'GET',
      url: `/api/agreements/${agreementId}`,
      headers: auth(consumer.token),
    })).json();
    expect(after.armedReset).toBeUndefined();
  });

  it('onEvent: the reset fires on the next matching event, not on non-matching ones', async () => {
    const { agreementId, simId } = await activateWithReset({
      onEvent: { eventType: 'all-clear' },
      action: { command: 'turn-off' },
    });

    await injectEvent(simId, 'temperature-spike', 35);
    await waitForAction(agreementId, 'turn-on');

    // A NON-matching event must not fire the reset.
    await injectEvent(simId, 'motion-detected');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect((await usageRows(agreementId)).some(row => row.action === 'turn-off')).toBe(false);

    await injectEvent(simId, 'all-clear');
    const rows = await waitForAction(agreementId, 'turn-off');
    expect(rows.some(row => row.action === 'turn-off' && row.outcome === 'success')).toBe(true);
  });

  it('a suspended agreement does not reset (arm drops, unmetered)', async () => {
    const { agreementId, simId } = await activateWithReset({
      afterSec: 150,
      action: { command: 'turn-off' },
    });

    await injectEvent(simId, 'temperature-spike', 35);
    await waitForAction(agreementId, 'turn-on');

    // Suspend BEFORE the window elapses.
    const suspended = await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/suspend`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(suspended.statusCode).toBe(200);

    // Long past the window (the 250ms recheck loop has fired several times).
    await new Promise(resolve => setTimeout(resolve, 2200));
    const rows = await usageRows(agreementId);
    expect(rows.some(row => row.action === 'turn-off')).toBe(false);
    expect(rows.length).toBe(1); // only the trigger invocation — the dropped reset is unmetered
  });

  it('validation: closed schema + the clause rides the trigger automation', async () => {
    const propose = (autoReset: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/services/${serviceId}/agreements`,
        headers: auth(consumer.token),
        payload: { terms: { ...extra, autoReset } },
      });

    // No trigger+action → 400 naming the requirement.
    const orphan = await propose({ afterSec: 60, action: { command: 'turn-off' } });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json().error.message).toMatch(/terms\.trigger and terms\.action must both be present/);

    const base = {
      trigger: { eventType: 'temperature-spike' },
      action: { command: 'turn-on' },
    };

    // Unknown key → 400 with the allowed list.
    const unknown = await propose({ afterSec: 60, resetTo: 'off', action: { command: 'turn-off' } }, base);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toMatch(/terms\.autoReset\.resetTo/);

    // Missing action → 400 (the platform never guesses an inverse).
    const noAction = await propose({ afterSec: 60 }, base);
    expect(noAction.statusCode).toBe(400);
    expect(noAction.json().error.message).toMatch(/must say what reset means/);

    // No firing condition → 400.
    const inert = await propose({ action: { command: 'turn-off' } }, base);
    expect(inert.statusCode).toBe(400);
    expect(inert.json().error.message).toMatch(/needs a firing condition/);

    // The happy shape is accepted and echoed on the agreement.
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/agreements`,
      headers: auth(consumer.token),
      payload: {
        terms: {
          ...base,
          autoReset: { afterSec: 300, action: { command: 'turn-off' } },
        },
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().terms.autoReset).toEqual({
      afterSec: 300,
      action: { command: 'turn-off' },
    });
  });

  it('a spent quota window still resets (the reset is not quota-gated)', async () => {
    // quota 1/window: the trigger invocation spends it; the reset must fire
    // anyway (un-pegging the device is part of the automation, and its
    // usage row then counts in FUTURE windows — honest metering).
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
          autoReset: { afterSec: 150, action: { command: 'turn-off' } },
        },
      },
    });
    expect(proposed.statusCode).toBe(201);
    const agreementId = proposed.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/agreements/${agreementId}/decide`,
      headers: auth(owner.token),
      payload: { decision: 'accept' },
    });
    const sim = await ctx.app.inject({
      method: 'POST',
      url: '/api/simulations',
      headers: auth(owner.token),
      payload: { environmentId: envId },
    });
    const simId = sim.json().id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/simulations/${simId}/start`,
      headers: auth(owner.token),
      payload: {},
    });

    await injectEvent(simId, 'temperature-spike', 35);
    await waitForAction(agreementId, 'turn-on');

    const rows = await waitForAction(agreementId, 'turn-off');
    expect(rows.some(row => row.action === 'turn-off' && row.outcome === 'success')).toBe(true);
    // And the metered reset means the window is now spent for NEW triggers
    // (2 successful invokes against a quota of 1) — a re-trigger is skipped,
    // and C3 (R25-NF4) meters the skip honestly: one turn-on SUCCESS total,
    // plus a failure row whose reason names the spent window.
    await injectEvent(simId, 'temperature-spike', 36);
    await new Promise(resolve => setTimeout(resolve, 400));
    const afterSkip = await usageRows(agreementId);
    expect(afterSkip.filter(row => row.action === 'turn-on' && row.outcome === 'success').length).toBe(1);
    const skipRow = afterSkip.find(row => row.action === 'turn-on' && row.outcome === 'failure');
    expect(skipRow).toBeDefined();
    expect((skipRow as { failureReason?: string }).failureReason).toContain('quota window spent');
  });
});
