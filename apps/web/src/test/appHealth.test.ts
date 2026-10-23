/**
 * App health tests (R14 P0-1) — the pure aggregation behind the sidebar's
 * 「应用」 overview tab: unbound agents, unmanaged zones (outdoor exempt),
 * disabled flows, service-less agents, and the unbound-devices group.
 */

import { describe, expect, it } from 'vitest';

import type { Flow, WorldAgent, WorldDevice, WorldService } from '../api/types';
import { computeAppHealth, unboundDevices } from '../lib/appHealth';

function makeDevice(id: string): WorldDevice {
  return {
    id,
    envId: 'env-1',
    name: `设备${id}`,
    type: 'meter',
    brand: null,
    capabilities: [],
    zoneId: 'zone-1',
    position: null,
    initialState: null,
    binding: `sim://${id}`,
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeAgent(
  id: string,
  overrides: Partial<WorldAgent> = {},
): WorldAgent {
  return {
    id,
    envId: 'env-1',
    name: `Agent${id}`,
    capabilities: [],
    boundDeviceIds: [],
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: 'user-a', displayName: '小A' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeService(id: string, providerId: string): WorldService {
  return {
    id,
    envId: 'env-1',
    name: `服务${id}`,
    semanticType: 'energy-monitoring',
    description: '',
    interface: {},
    origin: 'published',
    sourceDeviceId: null,
    visibility: 'public',
    unbacked: false,
    consumable: true,
    provider: { id: providerId, name: `Agent${providerId}`, owner: { id: 'user-a', displayName: '小A' } },
    reputation: { score: 0.7, attempts: 0, successes: 0 },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeFlow(id: string, enabled: boolean): Flow {
  return {
    id,
    envId: 'env-1',
    name: `Flow${id}`,
    description: '',
    enabled,
    trigger: { kind: 'schedule', everySimSec: 60 },
    plan: { goal: 'g', nodes: [] },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/** R14 P1-2: a zone-triggered flow actuating `capability` in `zoneId`. */
function makeZonedFlow(id: string, zoneId: string, capability: string, enabled = true): Flow {
  return {
    ...makeFlow(id, enabled),
    trigger: { kind: 'condition', zoneId, conditions: [{ path: 'temperature', op: '>', value: 30 }] },
    plan: { goal: 'g', nodes: [{ id: 'n1', capability }] },
  };
}

describe('computeAppHealth', () => {
  it('flags an agent with no bound devices and no services', () => {
    const issues = computeAppHealth({
      devices: [],
      agents: [makeAgent('a1')],
      services: [],
      zones: [],
      flows: [],
    });
    expect(issues).toEqual([
      { kind: 'agentNoDevices', id: 'a1', name: 'Agenta1' },
      { kind: 'agentNoServices', id: 'a1', name: 'Agenta1' },
    ]);
  });

  it('passes a fully wired agent', () => {
    const issues = computeAppHealth({
      devices: [makeDevice('d1')],
      agents: [makeAgent('a1', { boundDeviceIds: ['d1'], managedZoneIds: ['zone-1'] })],
      services: [makeService('s1', 'a1')],
      zones: [{ id: 'zone-1', name: '客厅' }],
      flows: [makeFlow('f1', true)],
    });
    expect(issues).toEqual([]);
  });

  it('flags zones no agent manages, but exempts outdoor zones', () => {
    const issues = computeAppHealth({
      devices: [],
      agents: [],
      services: [],
      zones: [
        { id: 'zone-1', name: '自习室' },
        { id: 'zone-2', name: '室外广场' },
        { id: 'zone-3', type: 'outdoor' },
      ],
      flows: [],
    });
    expect(issues).toEqual([{ kind: 'zoneUnmanaged', id: 'zone-1', name: '自习室' }]);
  });

  it('flags disabled flows and skips flow checks when the list is unavailable', () => {
    const base = { devices: [], agents: [], services: [], zones: [] };
    expect(
      computeAppHealth({ ...base, flows: [makeFlow('f1', false), makeFlow('f2', true)] }),
    ).toEqual([{ kind: 'flowDisabled', id: 'f1', name: 'Flowf1' }]);
    // flows=null (query loading/failed): no flow findings, no false alarms.
    expect(computeAppHealth({ ...base, flows: null })).toEqual([]);
  });

  it('orders findings by kind then name', () => {
    const issues = computeAppHealth({
      devices: [],
      agents: [makeAgent('a2'), makeAgent('a1')],
      services: [makeService('s1', 'a1'), makeService('s2', 'a2')],
      zones: [{ id: 'zone-1', name: '仓库' }],
      flows: [makeFlow('f1', false)],
    });
    expect(issues.map(issue => issue.kind)).toEqual([
      'agentNoDevices',
      'agentNoDevices',
      'zoneUnmanaged',
      'flowDisabled',
    ]);
    expect(issues[0].id).toBe('a1');
    expect(issues[1].id).toBe('a2');
  });

  it('flags an enabled zone-triggered flow whose trigger zone has no actuator', () => {
    const issues = computeAppHealth({
      devices: [],
      agents: [],
      services: [],
      zones: [],
      flows: [makeZonedFlow('f1', 'zone-1', 'cooling')],
    });
    expect(issues).toEqual([{ kind: 'flowZoneNoActuator', id: 'f1', name: 'Flowf1' }]);
  });

  it('passes when an in-zone device provides the capability (containment counts)', () => {
    const device = { ...makeDevice('d1'), capabilities: ['cooling-fan'] };
    const issues = computeAppHealth({
      devices: [device],
      agents: [],
      services: [],
      zones: [],
      flows: [makeZonedFlow('f1', 'zone-1', 'cooling')],
    });
    expect(issues).toEqual([]);
  });

  it('flags the flow when the only actuator sits in ANOTHER zone', () => {
    const device = { ...makeDevice('d1'), zoneId: 'zone-2', capabilities: ['cooling'] };
    const issues = computeAppHealth({
      devices: [device],
      agents: [],
      services: [],
      zones: [],
      flows: [makeZonedFlow('f1', 'zone-1', 'cooling')],
    });
    expect(issues).toEqual([{ kind: 'flowZoneNoActuator', id: 'f1', name: 'Flowf1' }]);
  });

  it('skips the actuator check for disabled flows and zone-less triggers', () => {
    const disabled = makeZonedFlow('f1', 'zone-1', 'cooling', false);
    const scheduled = { ...makeFlow('f2', true), plan: { goal: 'g', nodes: [{ id: 'n1', capability: 'cooling' }] } };
    const issues = computeAppHealth({
      devices: [],
      agents: [],
      services: [],
      zones: [],
      flows: [disabled, scheduled],
    });
    expect(issues).toEqual([{ kind: 'flowDisabled', id: 'f1', name: 'Flowf1' }]);
  });
});

describe('unboundDevices', () => {
  it('returns devices no agent is bound to', () => {
    const devices = [makeDevice('d1'), makeDevice('d2'), makeDevice('d3')];
    const agents = [makeAgent('a1', { boundDeviceIds: ['d1', 'd3'] })];
    expect(unboundDevices(devices, agents).map(device => device.id)).toEqual(['d2']);
  });
});
