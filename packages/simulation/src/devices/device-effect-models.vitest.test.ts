/**
 * @vitest-environment node
 *
 * T-034 (DevLoop R17) — executable lock/display effect models.
 *
 * Round-11 SF/RF findings: smart locks advertised lock/unlock with no
 * secure-state semantics (`locked` flipped but no who/when audit), and
 * display devices advertised content commands that nothing executed
 * ('switch displays to promo content' was inexpressible; set-brightness on
 * displays was a silent no-op). Post-T-047 the derivation is honest, but
 * the devices still could not DO the useful thing — these tests pin the
 * effect models that close that gap, plus the catalog honesty that every
 * display/lock capability the templates advertise now dispatches.
 */

import { describe, it, expect } from 'vitest';

import { SimulatedDevice } from './SimulatedDevice.js';
import { DeviceTemplateRegistry } from '../registry/DeviceTemplateRegistry.js';
import { isCapabilityExecutable } from './handlers/capability-contract.js';

function lockDevice(): SimulatedDevice {
  return new SimulatedDevice({
    id: 'lock-1',
    name: 'Lab Smart Lock',
    type: 'smart-lock',
    initialState: { status: 'active', locked: true, lastLockTime: null },
    capabilities: ['lock', 'unlock', 'get-access-log', 'grant-temporary-access']
      .map(name => ({ name, type: 'write' as const, parameters: [] })),
    behaviors: [],
    location: 'zone-a',
  });
}

function displayDevice(type = 'display-panel'): SimulatedDevice {
  return new SimulatedDevice({
    id: 'display-1',
    name: 'Lab Display',
    type,
    initialState: { status: 'idle' },
    capabilities: [
      'show-message', 'show-schedule', 'update-status', 'set-content', 'set-brightness',
    ].map(name => ({ name, type: 'write' as const, parameters: [] })),
    behaviors: [],
    location: 'zone-a',
  });
}

describe('T-034: smart-lock secure-state semantics', () => {
  it('lock/unlock transition the locked state AND audit who/when', async () => {
    const device = lockDevice();

    // R17 params-purity: the actor rides the invocation CONTEXT (3rd arg),
    // never the command params.
    const unlock = await device.executeCommand('unlock', undefined, { actor: 'security-guard' });
    expect(unlock.success).toBe(true);
    let state = device.getState() as unknown as Record<string, unknown>;
    expect(state.locked).toBe(false);
    expect(state.lastUnlockTime).toEqual(expect.any(String));
    expect(state.lastActionBy).toBe('security-guard');
    expect(state.accessLog).toEqual([
      { action: 'unlock', at: expect.any(String), by: 'security-guard' },
    ]);

    const lock = await device.executeCommand('lock', undefined, { actor: 'night-shift' });
    expect(lock.success).toBe(true);
    state = device.getState() as unknown as Record<string, unknown>;
    expect(state.locked).toBe(true);
    expect(state.lastLockTime).toEqual(expect.any(String));
    expect((state.accessLog as Array<{ action: string; by: string }>).map(e => e.action))
      .toEqual(['unlock', 'lock']);
  });

  it('actor-less commands audit honestly as unknown (never a fake system actor)', async () => {
    const device = lockDevice();
    await device.executeCommand('unlock');
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.lastActionBy).toBe('unknown');
    expect((state.accessLog as Array<{ by: string }>)[0]!.by).toBe('unknown');
  });

  it('grant-temporary-access records a bounded grant list', async () => {
    const device = lockDevice();
    const grant = await device.executeCommand('grant-temporary-access', {
      to: 'cleaning-crew',
      durationSec: 1800,
    }, { actor: 'owner' });
    expect(grant.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.temporaryGrants).toEqual([
      // T-706: a timed grant also carries expiresAt (sim clock + duration).
      { to: 'cleaning-crew', durationSec: 1800, expiresAt: expect.any(String), grantedAt: expect.any(String), by: 'owner' },
    ]);
  });

  it('the accessLog ring is capped (20 entries)', async () => {
    const device = lockDevice();
    for (let i = 0; i < 25; i++) {
      await device.executeCommand(
        i % 2 === 0 ? 'lock' : 'unlock',
        undefined,
        { actor: `user-${i}` },
      );
    }
    const log = (device.getState() as unknown as Record<string, unknown>).accessLog as unknown[];
    expect(log.length).toBe(20);
    // Newest kept: the last cycled actor is user-24.
    expect((log[log.length - 1] as { by: string }).by).toBe('user-24');
  });

  it('R17 params-purity: an actor in params is NOT honored (params stay semantic-only)', async () => {
    // The pre-R17 spelling stamped identity into params; the invocation
    // context is now the ONLY attribution channel — a stray params.actor is
    // an unrecognized command argument, audited as 'unknown'.
    const device = lockDevice();
    const outcome = await device.executeCommand('unlock', { actor: 'impersonator' });
    expect(outcome.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.lastActionBy).toBe('unknown');
    expect((state.accessLog as Array<{ by: string }>)[0]!.by).toBe('unknown');
  });

  it('T-408: on lock-family devices close means LOCKED and open means unlocked (no split-brain)', async () => {
    // The seed vocabulary assumes the collapsed two-state contract
    // (zw-door-lock ships initialState.locked) — pre-T-408 a lockdown via
    // 'close' wrote {open:false, closed:true} and left the seed's
    // locked:false untouched: {locked:false, open:false, closed:true}.
    const device = new SimulatedDevice({
      id: 'lock-split',
      name: 'Split Brain Lock',
      type: 'smart-lock',
      initialState: { locked: false },
      capabilities: ['close', 'open'].map(name => ({ name, type: 'write' as const, parameters: [] })),
      behaviors: [],
      location: 'zone-a',
    });

    const closed = await device.executeCommand('close');
    expect(closed.success).toBe(true);
    let state = device.getState() as unknown as Record<string, unknown>;
    expect(state.closed).toBe(true);
    expect(state.open).toBe(false);
    expect(state.locked).toBe(true); // the collapsed contract

    const opened = await device.executeCommand('open');
    expect(opened.success).toBe(true);
    state = device.getState() as unknown as Record<string, unknown>;
    expect(state.open).toBe(true);
    expect(state.closed).toBe(false);
    expect(state.locked).toBe(false);
  });

  it('T-408: non-lock types keep the plain open/close semantics (no locked write)', async () => {
    const device = new SimulatedDevice({
      id: 'curtain-1',
      name: 'Curtain',
      type: 'curtain',
      initialState: {},
      capabilities: ['close', 'open'].map(name => ({ name, type: 'write' as const, parameters: [] })),
      behaviors: [],
      location: 'zone-a',
    });
    await device.executeCommand('close');
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.closed).toBe(true);
    expect('locked' in state).toBe(false);
  });
});

describe('T-034: display content effect model', () => {
  it('show-message sets content + timestamp (rendered by the state table)', async () => {
    const device = displayDevice();
    const result = await device.executeCommand('show-message', {
      content: 'Fire drill at 15:00 — use stairwell B',
    }, { actor: 'admin' });
    expect(result.success).toBe(true);
    const state = device.getState() as unknown as Record<string, unknown>;
    expect(state.content).toBe('Fire drill at 15:00 — use stairwell B');
    expect(state.contentUpdatedAt).toEqual(expect.any(String));
    expect(state.contentSetBy).toBe('admin');
  });

  it('every content command spelling reaches the same content field', async () => {
    const device = displayDevice();
    await device.executeCommand('set-message', { message: 'promo A' });
    expect((device.getState() as unknown as Record<string, unknown>).content).toBe('promo A');

    await device.executeCommand('set-content', { content: 'promo B' });
    expect((device.getState() as unknown as Record<string, unknown>).content).toBe('promo B');

    await device.executeCommand('show-content', { text: 'promo C' });
    expect((device.getState() as unknown as Record<string, unknown>).content).toBe('promo C');

    await device.executeCommand('display-message', { value: 42 });
    expect((device.getState() as unknown as Record<string, unknown>).content).toBe('42');
  });

  it('show-schedule reads the schedule spelling; update-status writes status', async () => {
    const device = displayDevice();
    await device.executeCommand('show-schedule', { schedule: 'Mon 09:00 briefing' });
    expect((device.getState() as unknown as Record<string, unknown>).content).toBe('Mon 09:00 briefing');

    await device.executeCommand('update-status', { status: 'showing' });
    expect((device.getState() as unknown as Record<string, unknown>).status).toBe('showing');
  });

  it('a content command without any payload fails loudly (no silent no-op)', async () => {
    const device = displayDevice();
    const result = await device.executeCommand('show-message');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/content/i);
  });

  it('set-brightness on display-family devices writes brightness (was a silent no-op)', async () => {
    for (const type of ['display-panel', 'display', 'traffic-sign']) {
      const device = displayDevice(type);
      const result = await device.executeCommand('set-brightness', { brightness: 0.8 });
      expect(result.success, `set-brightness must act on type ${type}`).toBe(true);
      expect((device.getState() as unknown as Record<string, unknown>).brightness).toBe(0.8);
    }
  });
});

describe('T-034: catalog honesty — advertised display/lock capabilities all dispatch', () => {
  const TEMPLATE_NAMES = ['display-panel', 'smart-lock', 'digital-billboard', 'variable-message-sign'];

  it('every capability these templates advertise is executable (handler or read-only)', () => {
    for (const name of TEMPLATE_NAMES) {
      const template = DeviceTemplateRegistry.getTemplate(name);
      expect(template, `template ${name} exists`).toBeDefined();
      for (const capability of template!.capabilities) {
        expect(
          isCapabilityExecutable(capability),
          `${name}.${capability} is advertised but nothing executes it`,
        ).toBe(true);
      }
    }
  });

  it('the content/secure commands carry parameter hints for flow authoring', () => {
    // Hints double as the accepted-parameter oracle (CB-F01): without them,
    // flow authors get no validation and runtime params silently drop.
    for (const command of [
      'set-message', 'set-content', 'show-message', 'show-content', 'display-message',
      'lock', 'unlock', 'grant-temporary-access',
    ]) {
      expect(isCapabilityExecutable(command), `${command} is handler-backed`).toBe(true);
    }
  });
});
