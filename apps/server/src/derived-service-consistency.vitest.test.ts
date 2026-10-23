/**
 * @vitest-environment node
 *
 * Derived-service dual-face consistency (P1).
 *
 * The runtime registry face (core's deriveDeviceService — what
 * ResourceCoordinator.publishDeviceAsService stamps) and the world-layer
 * face (ServiceStore.syncDerivedForAgent rows) now share one derivation
 * source of truth. This suite pins the cross-face contract:
 * - runtime face: one `<device name> Service` per device, semanticType =
 *   the device resource type, capabilities = declared names ∪ device-only
 *   semantics;
 * - world face: one `<device name>: <label>` row per executable capability,
 *   every honest semantic_type reachable from the runtime capability set
 *   (or the shared SEMANTIC_TYPE_SWITCHING collapse);
 * - the honest-label rules are literally the same function in both faces.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveDeviceService,
  honestSemanticType,
  SEMANTIC_TYPE_SWITCHING,
} from '@active-collaboration/core';

import { honestSemanticType as storeHonestSemanticType } from './db/service-store.js';
import {
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';

describe('derived-service dual-face consistency (P1)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: {
        name: 'Derivation Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Seed a device + bound agent and run the world-face derivation sync. */
  function seedDerived(name: string, type: string, capabilities: string[]) {
    const device = ctx.app.envStore.createDevice({
      envId,
      ownerId: owner.id,
      name,
      type,
      capabilities,
      zoneId: 'zone-a',
    });
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: owner.id,
      name: `${name} Agent`,
      capabilities: [],
      boundDeviceIds: [device.id],
    });
    ctx.app.serviceStore.syncDerivedForAgent(agent.id);
    const rows = ctx.app.serviceStore
      .servicesOfAgent(agent.id)
      .filter(row => row.origin === 'derived');
    return { device, agent, rows };
  }

  /** The runtime-face derivation for the same device. */
  function runtimeSpecOf(device: { name: string; type: string; capabilities_json: string }) {
    return deriveDeviceService({
      name: device.name,
      type: device.type,
      capabilities: (JSON.parse(device.capabilities_json) as string[]).map(name => ({ name })),
    });
  }

  it('the honest-label rules are literally the same function in both faces', () => {
    // service-store re-exports core's helper — one source of truth.
    expect(storeHonestSemanticType).toBe(honestSemanticType);
    expect(honestSemanticType('ventilation', ['turn-on', 'turn-off'])).toBe(SEMANTIC_TYPE_SWITCHING);
  });

  it('sensor device: world rows stay inside the runtime capability set', () => {
    const { device, rows } = seedDerived('Meter', 'energy-meter', ['energy-monitoring']);
    const spec = runtimeSpecOf(device);

    // Runtime face keeps its established shape.
    expect(spec.name).toBe('Meter Service');
    expect(spec.semanticType).toBe('device');
    expect(spec.capabilities).toContain('energy-monitoring');

    // World face keeps its per-capability row shape…
    expect(rows).toHaveLength(1);
    expect(rows[0].name.startsWith('Meter: ')).toBe(true);
    // …and its semantic labels are reachable from the runtime capability set.
    expect(spec.capabilities).toContain(rows[0].semantic_type);
  });

  it('light device: every world-row semantic type is a runtime capability', () => {
    const { device, rows } = seedDerived('Floodlight', 'smart-light', [
      'lighting-control',
      'turn-on',
      'turn-off',
      'set-brightness',
    ]);
    const spec = runtimeSpecOf(device);

    expect(spec.name).toBe('Floodlight Service');
    expect(spec.semanticType).toBe('lighting');
    expect(spec.capabilities).toEqual([
      'lighting-control',
      'turn-on',
      'turn-off',
      'set-brightness',
    ]);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.name.startsWith('Floodlight: ')).toBe(true);
      expect(spec.capabilities).toContain(row.semantic_type);
    }
    // lighting-control's executable surface on this light is pure power
    // switching, so the shared T-043 rule collapses it into the verbatim
    // turn-on/turn-off rows — both faces agree nothing richer is offered.
    expect(rows.map(r => r.semantic_type).sort()).toEqual([
      'set-brightness',
      'turn-off',
      'turn-on',
    ]);
  });

  it('R101 evolution: an exhaust fan\'s ventilation now mints a VERBATIM ventilation row (it really runs)', async () => {
    // Pre-R101 this collapsed to SEMANTIC_TYPE_SWITCHING because the
    // ventilation command dispatched to nothing (only power switching was
    // real). The R101 handler made ventilation genuinely executable — the
    // 'switching' label would now be the lie.
    const { device, rows } = seedDerived('Bathroom Fan', 'exhaust-fan', ['ventilation']);
    const spec = runtimeSpecOf(device);

    expect(spec.name).toBe('Bathroom Fan Service');
    expect(spec.capabilities).toContain('ventilation');
    // World face: the honest label keeps the capability verbatim — the
    // executable surface IS ventilation (rule: surface === capability).
    expect(rows).toHaveLength(1);
    expect(rows[0].semantic_type).toBe('ventilation');
  });

  it('switching-only device: both faces speak the shared switching vocabulary', () => {
    // A smart plug declaring 'environment': no literal handler, and its
    // only executable route is power switching — the T-043 collapse still
    // labels it 'switching', not the marketing name.
    const { device, rows } = seedDerived('Hall Plug', 'smart-plug', ['environment']);
    const spec = runtimeSpecOf(device);

    // Runtime face: the marketing capability name is what the device declared.
    expect(spec.name).toBe('Hall Plug Service');
    expect(spec.capabilities).toContain('environment');

    // World face: the honest label collapses to the SHARED switching constant.
    expect(rows).toHaveLength(1);
    expect(rows[0].semantic_type).toBe(SEMANTIC_TYPE_SWITCHING);
  });
});
