/**
 * Flow wizard lib tests (R14 P1-1): zone parameter vocabulary, the
 * zone-scoped action options (in-zone device + bound agent required), and
 * the generated create-flow body shape.
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone, WorldAgent, WorldDevice } from '../api/types';
import {
  FALLBACK_PARAMETERS,
  buildFlowFromWizard,
  deviceProvides,
  wizardTriggerReady,
  zoneActionOptions,
  zoneParameters,
} from '../lib/flowWizard';

function makeDevice(
  id: string,
  zoneId: string,
  capabilities: string[],
): WorldDevice {
  return {
    id,
    envId: 'env-1',
    name: `设备${id}`,
    type: 'hvac',
    brand: null,
    capabilities,
    commands: [],
    zoneId,
    position: null,
    initialState: null,
    binding: `sim://${id}`,
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeAgent(id: string, boundDeviceIds: string[]): WorldAgent {
  return {
    id,
    envId: 'env-1',
    name: `Agent${id}`,
    capabilities: [],
    boundDeviceIds,
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('zoneParameters', () => {
  it('uses the zone baseline numeric keys when declared', () => {
    const zone: EnvZone = { id: 'z', name: '客厅', baseline: { temperature: 26, occupied: true, co2: 500 } };
    expect(zoneParameters(zone)).toEqual(['co2', 'temperature']);
  });

  it('falls back to the well-known vocabulary without a baseline', () => {
    expect(zoneParameters({ id: 'z' })).toEqual([...FALLBACK_PARAMETERS]);
    expect(zoneParameters(undefined)).toEqual([...FALLBACK_PARAMETERS]);
  });
});

describe('deviceProvides', () => {
  it('matches exactly and by case-insensitive containment', () => {
    expect(deviceProvides(['cooling'], 'cooling')).toBe(true);
    expect(deviceProvides(['temperature-control'], 'cooling')).toBe(false);
    expect(deviceProvides(['cooling-fan'], 'cooling')).toBe(true);
    expect(deviceProvides(['heating'], 'cooling')).toBe(false);
  });
});

describe('zoneActionOptions', () => {
  const devices = [
    makeDevice('d1', 'zone-a', ['cooling', 'ventilation']),
    makeDevice('d2', 'zone-a', ['lighting']),
    makeDevice('d3', 'zone-b', ['cooling']),
    makeDevice('d4', 'zone-a', ['smoke-exhaust']), // unbound
  ];

  it('offers only in-zone capabilities of agent-bound devices', () => {
    const options = zoneActionOptions('zone-a', devices, [makeAgent('a1', ['d1', 'd2'])]);
    expect(options).toEqual([
      { capability: 'cooling', deviceNames: ['设备d1'] },
      { capability: 'lighting', deviceNames: ['设备d2'] },
      { capability: 'ventilation', deviceNames: ['设备d1'] },
    ]);
  });

  it('is empty when no agent is bound to the zone devices', () => {
    expect(zoneActionOptions('zone-a', devices, [makeAgent('a1', [])])).toEqual([]);
    expect(zoneActionOptions('zone-a', devices, [])).toEqual([]);
  });
});

describe('wizardTriggerReady', () => {
  it('requires zone, parameter and a finite threshold', () => {
    expect(wizardTriggerReady({ zoneId: 'z', parameter: 'temperature', threshold: 30 })).toBe(true);
    expect(wizardTriggerReady({ zoneId: '', parameter: 'temperature', threshold: 30 })).toBe(false);
    expect(wizardTriggerReady({ zoneId: 'z', parameter: 'temperature', threshold: NaN })).toBe(false);
  });
});

describe('buildFlowFromWizard', () => {
  it('emits a zone-scoped condition trigger plus one action node', () => {
    expect(
      buildFlowFromWizard({
        zoneId: 'zone-a',
        parameter: 'temperature',
        op: '>',
        threshold: 30,
        capability: 'cooling',
        name: '客厅高温降温',
        goal: '把客厅温度降下来',
      }),
    ).toEqual({
      name: '客厅高温降温',
      description: '',
      enabled: true,
      trigger: {
        kind: 'condition',
        zoneId: 'zone-a',
        conditions: [{ path: 'temperature', op: '>', value: 30 }],
      },
      plan: { goal: '把客厅温度降下来', nodes: [{ id: 'n1', capability: 'cooling' }] },
    });
  });
});
