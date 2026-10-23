/**
 * World-change reducer tests (P2c world sync): created/updated/deleted for
 * devices, agents and environment patches, plus wire parsing robustness.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { EnvironmentDetail, WorldAgent, WorldDevice } from '../api/types';
import {
  applyWorldChange,
  applyWorldSession,
  describeWorldChange,
  parseWorldMessage,
  parseWorldSessionMessage,
} from '../lib/worldChange';

// describeWorldChange reads the active i18next bundle; pin to zh-CN so the
// toast line assertions stay exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

function makeDevice(id: string, overrides: Partial<WorldDevice> = {}): WorldDevice {
  return {
    id,
    envId: 'env-1',
    name: `设备${id}`,
    type: 'lamp',
    brand: null,
    capabilities: ['switch'],
    zoneId: 'zone-1',
    position: null,
    initialState: null,
    binding: `sim://${id}`,
    owner: { id: 'user-b', displayName: '小B' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Partial<WorldAgent> = {}): WorldAgent {
  return {
    id,
    envId: 'env-1',
    name: `Agent${id}`,
    capabilities: [],
    boundDeviceIds: [],
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: 'user-b', displayName: '小B' },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<EnvironmentDetail> = {}): EnvironmentDetail {
  return {
    id: 'env-1',
    name: '测试环境',
    description: 'desc',
    mapType: 'grid',
    mapCenter: null,
    mapZoom: null,
    storeyHeight: null,
    floorPlans: [],
    semanticOfferRules: [],
    capabilitySynonyms: [],
    visibility: 'public',
    owner: { id: 'user-a', displayName: '小A' },
    zones: [{ id: 'zone-1', name: '客厅' }],
    events: [],
    devices: [makeDevice('d1')],
    agents: [makeAgent('a1')],
    services: [],
    members: [],
    governance: {
      proposalReview: 'ai-assisted-auto-apply',
      notes: '',
      supervisedZones: [],
      supervisedZoneNote: '',
      humanReview: { maxAgentsPerProposal: 0, maxEventsPerProposal: 0, maxZonesTouched: 0 },
      humanReviewNote: '',
    },
    myRole: 'owner',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('applyWorldChange', () => {
  it('created device: appends, and dedupes a repeated create (optimistic apply + broadcast)', () => {
    const detail = makeDetail();
    const device = makeDevice('d2');
    const message = parseWorldMessage({
      kind: 'world',
      action: 'created',
      objectType: 'device',
      object: device,
    })!;

    const once = applyWorldChange(detail, message);
    expect(once.devices.map(d => d.id)).toEqual(['d1', 'd2']);

    const twice = applyWorldChange(once, message);
    expect(twice.devices).toHaveLength(2);
  });

  it('updated device: replaces by id; unknown id upserts (missed create)', () => {
    const detail = makeDetail();
    const renamed = applyWorldChange(detail, {
      kind: 'world',
      action: 'updated',
      objectType: 'device',
      object: makeDevice('d1', { name: '新名字' }),
    });
    expect(renamed.devices[0].name).toBe('新名字');
    expect(renamed.devices).toHaveLength(1);

    const upserted = applyWorldChange(detail, {
      kind: 'world',
      action: 'updated',
      objectType: 'device',
      object: makeDevice('d9'),
    });
    expect(upserted.devices.map(d => d.id)).toEqual(['d1', 'd9']);
  });

  it('deleted device: removes by id and ignores unknown ids', () => {
    const detail = makeDetail({ devices: [makeDevice('d1'), makeDevice('d2')] });
    const next = applyWorldChange(detail, {
      kind: 'world',
      action: 'deleted',
      objectType: 'device',
      object: { id: 'd1' },
    });
    expect(next.devices.map(d => d.id)).toEqual(['d2']);

    const unchanged = applyWorldChange(detail, {
      kind: 'world',
      action: 'deleted',
      objectType: 'device',
      object: { id: 'nope' },
    });
    expect(unchanged.devices).toHaveLength(2);
  });

  it('agent created/updated/deleted mirror the device semantics', () => {
    const detail = makeDetail();
    const created = applyWorldChange(detail, {
      kind: 'world',
      action: 'created',
      objectType: 'agent',
      object: makeAgent('a2'),
    });
    expect(created.agents.map(a => a.id)).toEqual(['a1', 'a2']);

    const updated = applyWorldChange(created, {
      kind: 'world',
      action: 'updated',
      objectType: 'agent',
      object: makeAgent('a2', { boundDeviceIds: ['d1'] }),
    });
    expect(updated.agents.find(a => a.id === 'a2')?.boundDeviceIds).toEqual(['d1']);

    const deleted = applyWorldChange(updated, {
      kind: 'world',
      action: 'deleted',
      objectType: 'agent',
      object: { id: 'a1' },
    });
    expect(deleted.agents.map(a => a.id)).toEqual(['a2']);
  });

  it('environment updated: merges name/visibility/zones, keeps instances', () => {
    const detail = makeDetail();
    const next = applyWorldChange(detail, {
      kind: 'world',
      action: 'updated',
      objectType: 'environment',
      object: {
        id: 'env-1',
        name: '改名后',
        visibility: 'private',
        zones: [{ id: 'zone-1', name: '客厅' }, { id: 'zone-2', name: '卧室' }],
      },
    });
    expect(next.name).toBe('改名后');
    expect(next.visibility).toBe('private');
    expect(next.zones).toHaveLength(2);
    expect(next.devices).toHaveLength(1);
    expect(next.agents).toHaveLength(1);
  });

  it('malformed messages leave the detail untouched', () => {
    const detail = makeDetail();
    expect(
      applyWorldChange(detail, {
        kind: 'world',
        action: 'created',
        objectType: 'device',
        object: { nope: true },
      }),
    ).toBe(detail);
  });
});

describe('parseWorldMessage', () => {
  it('accepts well-formed messages and rejects junk', () => {
    expect(
      parseWorldMessage({
        kind: 'world',
        action: 'created',
        objectType: 'device',
        object: { id: 'd1' },
      }),
    ).not.toBeNull();
    expect(parseWorldMessage(null)).toBeNull();
    expect(parseWorldMessage({ kind: 'snapshot', data: {} })).toBeNull();
    expect(
      parseWorldMessage({ kind: 'world', action: 'mutated', objectType: 'device', object: {} }),
    ).toBeNull();
    expect(
      parseWorldMessage({ kind: 'world', action: 'created', objectType: 'user', object: {} }),
    ).toBeNull();
    expect(
      parseWorldMessage({ kind: 'world', action: 'created', objectType: 'device', object: 'x' }),
    ).toBeNull();
  });
});

describe('world-session frames (R82)', () => {
  it('parseWorldSessionMessage accepts a well-formed frame and rejects junk', () => {
    expect(
      parseWorldSessionMessage({
        kind: 'world-session',
        envId: 'env-1',
        status: 'idle',
        simTimeSec: 42,
        simulationId: 'sim-env-1-world-session',
      }),
    ).not.toBeNull();
    expect(parseWorldSessionMessage(null)).toBeNull();
    expect(parseWorldSessionMessage({ kind: 'world', action: 'created' })).toBeNull();
    expect(
      parseWorldSessionMessage({ kind: 'world-session', status: 'running', simTimeSec: 1, simulationId: 's' }),
    ).toBeNull();
    expect(
      parseWorldSessionMessage({ kind: 'world-session', status: 'idle', simTimeSec: 'x', simulationId: 's' }),
    ).toBeNull();
    expect(
      parseWorldSessionMessage({ kind: 'world-session', status: 'idle', simTimeSec: 1 }),
    ).toBeNull();
  });

  it('a creation frame on a session-less detail surfaces world.worldSession (the create-while-open bug)', () => {
    const detail = makeDetail();
    expect(detail.worldSession).toBeUndefined();

    const message = parseWorldSessionMessage({
      kind: 'world-session',
      envId: 'env-1',
      status: 'idle',
      simTimeSec: 3,
      simulationId: 'sim-env-1-world-session',
    })!;
    const next = applyWorldSession(detail, message);

    expect(next.worldSession).toMatchObject({
      status: 'idle',
      simTimeSec: 3,
      simulationId: 'sim-env-1-world-session',
    });
    // The frame omits the compression rate — a fresh view takes the server
    // default (1 sim-sec per wall-sec).
    expect(next.worldSession?.simPerWallSec).toBe(1);
    expect(next.devices).toBe(detail.devices);
  });

  it('a transition frame updates status and preserves rate/anchor/drift from the loaded view', () => {
    const detail = makeDetail({
      worldSession: {
        status: 'idle',
        simTimeSec: 10,
        simulationId: 'sim-env-1-world-session',
        simPerWallSec: 4,
        simStartEpochMs: 1_700_000_000_000,
        driftWarning: ['+ 设备 cam-1（新增）'],
      },
    });
    const next = applyWorldSession(detail, {
      kind: 'world-session',
      envId: 'env-1',
      status: 'active',
      simTimeSec: 12,
      simulationId: 'sim-env-1-world-session',
      observers: 2,
    });
    expect(next.worldSession).toMatchObject({
      status: 'active',
      simTimeSec: 12,
      observers: 2,
      simPerWallSec: 4,
      simStartEpochMs: 1_700_000_000_000,
      driftWarning: ['+ 设备 cam-1（新增）'],
    });
  });

  it('transitioning to hibernated drops observers; waking drops the checkpoint pair', () => {
    const live = applyWorldSession(makeDetail(), {
      kind: 'world-session',
      envId: 'env-1',
      status: 'active',
      simTimeSec: 5,
      simulationId: 'sim-env-1-world-session',
      observers: 1,
    });
    expect(live.worldSession?.observers).toBe(1);

    const hibernated = applyWorldSession(live, {
      kind: 'world-session',
      envId: 'env-1',
      status: 'hibernated',
      simTimeSec: 5,
      simulationId: 'sim-env-1-world-session',
      checkpointAtSec: 5,
      hibernatedAt: '2026-01-01T01:00:00Z',
    });
    expect(hibernated.worldSession?.status).toBe('hibernated');
    expect(hibernated.worldSession?.observers).toBeUndefined();
    expect(hibernated.worldSession?.checkpointAtSec).toBe(5);
    expect(hibernated.worldSession?.hibernatedAt).toBe('2026-01-01T01:00:00Z');

    const woken = applyWorldSession(hibernated, {
      kind: 'world-session',
      envId: 'env-1',
      status: 'idle',
      simTimeSec: 9,
      simulationId: 'sim-env-1-world-session',
    });
    expect(woken.worldSession?.checkpointAtSec).toBeUndefined();
    expect(woken.worldSession?.hibernatedAt).toBeUndefined();
  });
});

describe('describeWorldChange', () => {
  it('renders actor + action + object type + name', () => {
    expect(
      describeWorldChange({
        kind: 'world',
        action: 'created',
        objectType: 'device',
        object: makeDevice('d2', { name: '台灯', owner: { id: 'u', displayName: '小B' } }),
      }),
    ).toBe('小B 添加了设备「台灯」');
    expect(
      describeWorldChange({
        kind: 'world',
        action: 'deleted',
        objectType: 'agent',
        object: { id: 'a1' },
      }),
    ).toBe('删除了Agent');
    expect(
      describeWorldChange({
        kind: 'world',
        action: 'updated',
        objectType: 'environment',
        object: { id: 'env-1' },
      }),
    ).toBe('环境设置已更新');
  });
});
