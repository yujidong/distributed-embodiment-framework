/**
 * @vitest-environment node
 *
 * Device privacy view-model tests (DevLoop S2, Task 1) — the canonical
 * projection seam every device-bearing read surface must go through.
 *
 * Tier rule: admin / env owner / device owner → full; everyone else
 * (members, viewers, anonymous, fork creators reading their fork) → coarse.
 * Coarse keeps world-structure facts + an honestly-derived on/off/present
 * status and hides initialState / runtime state / the hass:// entity id.
 */

import { describe, expect, it } from 'vitest';

import {
  coarseDeviceStatus,
  deviceDetailTier,
  deviceOwnershipOracle,
  projectDeviceJson,
  projectDeviceStateRecord,
  projectSnapshotDevice,
  type DeviceOwnership,
} from './device-privacy.js';

const OWN = 'user-owner'; // device owner
const ENV_OWNER = 'user-env-owner'; // environment owner (not the device owner)
const MEMBER = 'user-member'; // another member — foreign device
const ADMIN = 'user-admin';

const ownership: DeviceOwnership = { ownerId: OWN, envOwnerId: ENV_OWNER };

describe('deviceDetailTier (the single tier decision)', () => {
  it('full for the device owner, the env owner, and an admin', () => {
    expect(deviceDetailTier({ userId: OWN }, ownership)).toBe('full');
    expect(deviceDetailTier({ userId: ENV_OWNER }, ownership)).toBe('full');
    expect(deviceDetailTier({ userId: ADMIN, isAdmin: true }, ownership)).toBe('full');
  });

  it('coarse for other members, viewers, and anonymous', () => {
    expect(deviceDetailTier({ userId: MEMBER }, ownership)).toBe('coarse');
    expect(deviceDetailTier({ userId: null }, ownership)).toBe('coarse');
    // An admin-FLAGGED anonymous context is impossible in practice, but the
    // admin check wins by design (deployment admins are governance).
    expect(deviceDetailTier({ userId: null, isAdmin: true }, ownership)).toBe('full');
  });

  it('coarse when ownership is unresolvable (deleted tenant row — deletion does not declassify)', () => {
    expect(deviceDetailTier({ userId: OWN }, undefined)).toBe('coarse');
    expect(deviceDetailTier({ userId: ENV_OWNER }, undefined)).toBe('coarse');
    expect(deviceDetailTier({ userId: ADMIN, isAdmin: true }, undefined)).toBe('full');
  });

  it('coarse when the env owner is unresolvable but the device owner matches', () => {
    expect(deviceDetailTier({ userId: OWN }, { ownerId: OWN, envOwnerId: null })).toBe('full');
    expect(deviceDetailTier({ userId: MEMBER }, { ownerId: OWN, envOwnerId: null })).toBe('coarse');
  });
});

describe('coarseDeviceStatus (physics-honest status)', () => {
  it('derives on/off from the powered predicates the simulation itself uses', () => {
    expect(coarseDeviceStatus({ power: true, temperature: 22.5 })).toBe('on');
    expect(coarseDeviceStatus({ power: false })).toBe('off');
    expect(coarseDeviceStatus({ status: 'on' })).toBe('on');
    expect(coarseDeviceStatus({ status: 'active' })).toBe('on');
    expect(coarseDeviceStatus({ status: 'idle' })).toBe('present');
  });

  it('reports presence-only for pure sensors (the reading itself stays hidden)', () => {
    expect(coarseDeviceStatus({ temperature: 36.6, unit: '°C' })).toBe('present');
    expect(coarseDeviceStatus({})).toBe('present');
    expect(coarseDeviceStatus(null)).toBe('present');
    expect(coarseDeviceStatus(undefined)).toBe('present');
  });
});

describe('projectDeviceJson (env-row wire shape)', () => {
  const fullJson = {
    id: 'dev-1',
    envId: 'env-1',
    name: 'Bedside watch',
    type: 'wearable',
    brand: 'Acme',
    capabilities: ['fall-detection'],
    commands: [],
    zoneId: 'ward-102',
    position: { x: 1, y: 2 },
    initialState: { heartRate: 78, fall: false },
    binding: 'sim://dev-1',
    owner: { id: OWN, displayName: 'Owner' },
    createdAt: '2026-08-01T00:00:00Z',
  };

  it('full tier passes through byte-identical', () => {
    expect(projectDeviceJson(fullJson, { userId: OWN }, ownership)).toBe(fullJson);
    expect(projectDeviceJson(fullJson, { userId: ENV_OWNER }, ownership)).toBe(fullJson);
  });

  it('coarse tier keeps world-structure facts, hides initialState + marks visibility', () => {
    const coarse = projectDeviceJson(fullJson, { userId: MEMBER }, ownership);
    expect(coarse.initialState).toBeUndefined();
    expect(coarse.stateVisibility).toBe('coarse');
    expect(coarse.status).toBe('present'); // no power/status key → presence-only
    expect(coarse.name).toBe('Bedside watch');
    expect(coarse.type).toBe('wearable');
    expect(coarse.zoneId).toBe('ward-102');
    expect(coarse.position).toEqual({ x: 1, y: 2 });
    expect(coarse.owner).toEqual({ id: OWN, displayName: 'Owner' });
    expect(coarse.binding).toBe('sim://dev-1'); // sim scheme is derivable, not secret
  });

  it('coarse tier preserves on/off and redacts the hass:// entity id but not the scheme', () => {
    const hassJson = {
      ...fullJson,
      initialState: { power: true, targetTemperature: 24 },
      binding: 'hass://climate.ward_102',
    };
    const coarse = projectDeviceJson(hassJson, { userId: MEMBER }, ownership);
    expect(coarse.status).toBe('on');
    expect(coarse.binding).toBe('hass://redacted');
    expect(JSON.stringify(coarse)).not.toContain('ward_102');
    expect(JSON.stringify(coarse)).not.toContain('targetTemperature');
  });

  it('uses the caller-supplied initialState (twin-synced telemetry) over the json copy', () => {
    const coarse = projectDeviceJson(
      { ...fullJson, initialState: {} },
      { userId: MEMBER },
      ownership,
      { power: false },
    );
    expect(coarse.status).toBe('off');
  });
});

describe('projectSnapshotDevice (runtime snapshot entries)', () => {
  const device = {
    id: 'dev-1',
    name: 'Bedside watch',
    type: 'wearable',
    role: 'sensor',
    zoneId: 'ward-102',
    state: { heartRate: 78, cumulativeEnergyWh: 12.5 },
    commands: ['read-heart-rate'],
    fault: null,
  };

  it('full tier passes through unchanged', () => {
    expect(projectSnapshotDevice(device, { userId: OWN }, ownership)).toBe(device);
  });

  it('coarse tier empties state, keeps identity + fault health, and self-labels', () => {
    const coarse = projectSnapshotDevice(device, { userId: MEMBER }, ownership);
    expect((coarse as { state: unknown }).state).toEqual({});
    expect((coarse as { stateRedacted?: boolean }).stateRedacted).toBe(true);
    expect((coarse as { status?: string }).status).toBe('present');
    expect(coarse.id).toBe('dev-1');
    expect(coarse.commands).toEqual(['read-heart-rate']);
    expect(coarse.fault).toBeNull();
    expect(JSON.stringify(coarse)).not.toContain('heartRate');
    expect(JSON.stringify(coarse)).not.toContain('cumulativeEnergyWh');
  });

  it('an actuator keeps its on/off signal in coarse (status) while the payload hides', () => {
    const ac = { ...device, state: { power: true, targetTemperature: 18, mode: 'cool' } };
    const coarse = projectSnapshotDevice(ac, { userId: MEMBER }, ownership);
    expect((coarse as { status?: string }).status).toBe('on');
    expect(JSON.stringify(coarse)).not.toContain('targetTemperature');
  });
});

describe('projectDeviceStateRecord (sim-timeline device-state records)', () => {
  const record = {
    kind: 'device-state' as const,
    environmentId: 'env-1',
    simId: 'sim-1',
    simTimeSec: 120,
    recordedAt: '2026-08-22T12:00:00Z',
    deviceId: 'dev-1',
    service: 'set-temperature',
    params: { temperature: 20 },
    result: { ok: true, applied: { temperature: 20 } },
    actor: 'member',
  };

  it('full tier passes through unchanged', () => {
    expect(projectDeviceStateRecord(record, { userId: OWN }, ownership)).toBe(record);
  });

  it('coarse keeps the history marker (device/service/time) and strips the telemetry', () => {
    const coarse = projectDeviceStateRecord(record, { userId: MEMBER }, ownership);
    expect(coarse.params).toBeUndefined();
    expect(coarse.result).toBeUndefined();
    expect(coarse.redacted).toBe(true);
    expect(coarse.deviceId).toBe('dev-1');
    expect(coarse.service).toBe('set-temperature');
    expect(coarse.simTimeSec).toBe(120);
    expect(coarse.actor).toBe('member');
  });
});

describe('deviceOwnershipOracle', () => {
  it('resolves device owner + env owner in one cached lookup; unresolvable ids return undefined', () => {
    const oracle = deviceOwnershipOracle(
      id =>
        id === 'dev-1'
          ? ({
              id: 'dev-1',
              env_id: 'env-1',
              owner_id: OWN,
              name: 'd',
              type: 'sensor',
              brand: null,
              capabilities_json: '[]',
              zone_id: 'z',
              position_json: null,
              initial_state_json: null,
              binding: null,
              role: null,
              created_at: '2026-08-01T00:00:00Z',
            })
          : undefined,
      envId => (envId === 'env-1' ? ENV_OWNER : null),
    );
    expect(oracle('dev-1')).toEqual({ ownerId: OWN, envOwnerId: ENV_OWNER });
    expect(oracle('gone')).toBeUndefined();
  });
});
