/**
 * @vitest-environment node
 *
 * BUG-01 — persisted device-role recheck at the bridge. Rows written while
 * the loader's capability classifier misread verb-prefixed read-only names
 * (read-occupancy / detect-smoke / read-power) as execute were persisted as
 * role='actuator'/'hybrid' although every capability is OBSERVATION — the
 * precheck then granted actuator-zone coverage the actuation planner could
 * never command. environmentToScenario rechecks such rows against the
 * shared read-only predicate and downgrades them to 'sensor'.
 */

import { describe, expect, it } from 'vitest';

import {
  environmentToScenario,
  recheckPersistedDeviceRole,
} from './environment-bridge.js';
import type {
  AgentInstanceRow,
  DeviceInstanceRow,
  EnvironmentRow,
} from './db/environment-store.js';

describe('recheckPersistedDeviceRole (BUG-01)', () => {
  it('downgrades a persisted actuator whose capabilities are ALL read-only', () => {
    expect(recheckPersistedDeviceRole('actuator', ['read-occupancy', 'detect-smoke'])).toBe('sensor');
    expect(recheckPersistedDeviceRole('actuator', ['read-power'])).toBe('sensor');
  });

  it('downgrades a persisted hybrid with no actuation-class capability', () => {
    expect(recheckPersistedDeviceRole('hybrid', ['read-power', 'query-status'])).toBe('sensor');
  });

  it('keeps a persisted actuator holding at least one actuation command', () => {
    expect(recheckPersistedDeviceRole('actuator', ['read-power', 'turn-off'])).toBe('actuator');
    expect(recheckPersistedDeviceRole('hybrid', ['read-power', 'turn-off'])).toBe('hybrid');
  });

  it('never touches a persisted sensor or an unparseable role', () => {
    expect(recheckPersistedDeviceRole('sensor', ['turn-off'])).toBe('sensor');
    expect(recheckPersistedDeviceRole(undefined, ['read-power'])).toBeUndefined();
  });
});

describe('environmentToScenario — persisted role recheck (BUG-01)', () => {
  function envRow(): EnvironmentRow {
    return {
      id: 'env-bug01',
      name: 'BUG-01 Env',
      description: '',
      map_type: 'building',
      map_data_json: JSON.stringify({ zones: [{ id: 'zone-a', name: 'Zone A' }] }),
      owner_id: 'owner-1',
      visibility: 'private',
      guide_json: null,
      default_simulation_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as EnvironmentRow;
  }

  function deviceRow(overrides: Partial<DeviceInstanceRow>): DeviceInstanceRow {
    return {
      id: 'dev-1',
      env_id: 'env-bug01',
      owner_id: 'owner-1',
      name: 'Device 1',
      type: 'camera',
      brand: null,
      capabilities_json: JSON.stringify(['read-occupancy']),
      zone_id: 'zone-a',
      position_json: null,
      initial_state_json: null,
      binding: null,
      role: null,
      created_at: new Date().toISOString(),
      ...overrides,
    } as DeviceInstanceRow;
  }

  it('a stale persisted role=actuator on a read-only device bridges as sensor', () => {
    const scenario = environmentToScenario(
      envRow(),
      [deviceRow({ role: 'actuator', capabilities_json: JSON.stringify(['read-occupancy', 'detect-smoke']) })],
      [] as AgentInstanceRow[],
    );
    expect(scenario.devices[0].role).toBe('sensor');
  });

  it('a persisted actuator with a real actuation command keeps its role', () => {
    const scenario = environmentToScenario(
      envRow(),
      [deviceRow({ role: 'actuator', type: 'charging-pile', capabilities_json: JSON.stringify(['turn-off', 'read-power']) })],
      [] as AgentInstanceRow[],
    );
    expect(scenario.devices[0].role).toBe('actuator');
  });

  it('NULL role still falls through to the loader inference (legacy rows)', () => {
    const scenario = environmentToScenario(
      envRow(),
      [deviceRow({ role: null, capabilities_json: JSON.stringify(['read-occupancy']) })],
      [] as AgentInstanceRow[],
    );
    expect(scenario.devices[0].role).toBe('sensor');
  });
});
