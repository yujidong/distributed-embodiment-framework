/**
 * Service marketplace tests (W3):
 * - lib/services grouping/filtering (semantic-type groups, provider/origin
 *   filters, per-agent and per-device projections);
 * - lib/worldChange reducer handling of objectType 'service' (created /
 *   updated / deleted, id-deduped) — the marketplace's incremental updates
 *   from the world stream;
 * - service toast/actor attribution via provider.owner.
 *
 * NB: visibility filtering itself is server-side (REST + stream), so the
 * reducer tests assert only that already-filtered frames apply cleanly.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../i18n/config';
import type { EnvironmentDetail, WorldAgent, WorldDevice, WorldService } from '../api/types';
import {
  filterServices,
  groupServicesBySemanticType,
  providersOf,
  semanticTypesOf,
  servicesBackedByDevice,
  servicesOfAgent,
} from '../lib/services';
import { actorOf, applyWorldChange, describeWorldChange, parseWorldMessage } from '../lib/worldChange';

// describeWorldChange reads the active i18next bundle; pin to zh-CN so the
// attribution assertion stays exact.
beforeAll(() => {
  void i18n.changeLanguage('zh-CN');
});

function makeService(id: string, overrides: Partial<WorldService> = {}): WorldService {
  return {
    id,
    envId: 'env-1',
    name: `服务${id}`,
    semanticType: 'energy-monitoring',
    description: '',
    interface: {},
    origin: 'derived',
    sourceDeviceId: 'd1',
    visibility: 'public',
    unbacked: false,
    consumable: true,
    provider: { id: 'a1', name: 'AgentA', owner: { id: 'user-b', displayName: '小B' } },
    reputation: { score: 0.7, attempts: 0, successes: 0 },
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeDevice(id: string): WorldDevice {
  return {
    id,
    envId: 'env-1',
    name: `设备${id}`,
    type: 'meter',
    brand: null,
    capabilities: ['energy-monitoring'],
    zoneId: 'zone-1',
    position: null,
    initialState: null,
    binding: `sim://${id}`,
    owner: { id: 'user-b', displayName: '小B' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeAgent(id: string, name: string): WorldAgent {
  return {
    id,
    envId: 'env-1',
    name,
    capabilities: [],
    boundDeviceIds: [],
    managedZoneIds: [],
    llm: null,
    enabled: true,
    owner: { id: 'user-b', displayName: '小B' },
    createdAt: '2026-01-01T00:00:00Z',
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
    agents: [makeAgent('a1', 'AgentA')],
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

describe('service marketplace grouping/filtering', () => {
  const services = [
    makeService('s1', { name: '电表: energy-monitoring', semanticType: 'energy-monitoring' }),
    makeService('s2', {
      name: 'Brokerage',
      semanticType: 'energy-trading',
      origin: 'published',
      sourceDeviceId: null,
      unbacked: true,
      consumable: false,
      provider: { id: 'a2', name: 'AgentB', owner: { id: 'user-c', displayName: '小C' } },
    }),
    makeService('s3', { name: '电表: power-monitoring', semanticType: 'power-monitoring' }),
  ];

  it('collects distinct semantic types and providers (sorted)', () => {
    expect(semanticTypesOf(services)).toEqual([
      'energy-monitoring',
      'energy-trading',
      'power-monitoring',
    ]);
    expect(providersOf(services)).toEqual([
      { id: 'a1', name: 'AgentA' },
      { id: 'a2', name: 'AgentB' },
    ]);
  });

  it('filters by semantic type, provider and origin independently', () => {
    expect(filterServices(services, { semanticType: 'energy-trading' }).map(s => s.id)).toEqual([
      's2',
    ]);
    expect(filterServices(services, { providerAgentId: 'a1' }).map(s => s.id)).toEqual(['s1', 's3']);
    expect(filterServices(services, { origin: 'published' }).map(s => s.id)).toEqual(['s2']);
    expect(
      filterServices(services, { origin: 'derived', semanticType: 'power-monitoring' }).map(s => s.id),
    ).toEqual(['s3']);
    expect(filterServices(services, {})).toHaveLength(3);
  });

  it('full-text q matches name/description/semantic type, case-insensitive, composable (Fix-20, F-09)', () => {
    const withDescription = [
      ...services,
      makeService('s4', { name: '削峰', semanticType: 'energy-trading', description: 'Peak-shaving capacity' }),
    ];
    // Name substring (case-insensitive).
    expect(filterServices(withDescription, { q: 'brokerage' }).map(s => s.id)).toEqual(['s2']);
    // Description substring.
    expect(filterServices(withDescription, { q: 'PEAK-SHAVING' }).map(s => s.id)).toEqual(['s4']);
    // Semantic type substring.
    expect(filterServices(withDescription, { q: 'monitoring' }).map(s => s.id)).toEqual(['s1', 's3']);
    // Composable with the exact filters; blank q matches everything.
    expect(filterServices(withDescription, { q: 'monitoring', origin: 'published' })).toHaveLength(0);
    expect(filterServices(withDescription, { q: '  ' })).toHaveLength(4);
    expect(filterServices(withDescription, { q: 'no-such-thing' })).toHaveLength(0);
  });

  it('groups by semantic type, sorted by type then provider/name', () => {
    const groups = groupServicesBySemanticType(services);
    expect(groups.map(group => group.semanticType)).toEqual([
      'energy-monitoring',
      'energy-trading',
      'power-monitoring',
    ]);
    expect(groups[0]!.services.map(s => s.id)).toEqual(['s1']);
    expect(groups[1]!.services[0]!.unbacked).toBe(true);
  });

  it('projects per-agent and per-device service lists for the detail panels', () => {
    expect(servicesOfAgent(services, 'a2').map(s => s.id)).toEqual(['s2']);
    expect(servicesBackedByDevice(services, 'd1').map(s => s.id)).toEqual(['s1', 's3']);
    expect(servicesBackedByDevice(services, 'nope')).toEqual([]);
  });
});

describe('applyWorldChange with objectType service', () => {
  it('created: appends, deduped by id (optimistic apply + broadcast)', () => {
    const detail = makeDetail();
    const message = parseWorldMessage({
      kind: 'world',
      action: 'created',
      objectType: 'service',
      object: makeService('s1'),
    })!;
    expect(message).not.toBeNull();

    const once = applyWorldChange(detail, message);
    expect(once.services.map(s => s.id)).toEqual(['s1']);
    const twice = applyWorldChange(once, message);
    expect(twice.services).toHaveLength(1);
  });

  it('updated: replaces by id; unknown id upserts', () => {
    const detail = makeDetail({ services: [makeService('s1')] });
    const renamed = applyWorldChange(detail, {
      kind: 'world',
      action: 'updated',
      objectType: 'service',
      object: makeService('s1', { name: '改名', visibility: 'members' }),
    });
    expect(renamed.services[0]!.name).toBe('改名');
    expect(renamed.services[0]!.visibility).toBe('members');

    const upserted = applyWorldChange(detail, {
      kind: 'world',
      action: 'updated',
      objectType: 'service',
      object: makeService('s9'),
    });
    expect(upserted.services.map(s => s.id)).toEqual(['s1', 's9']);
  });

  it('deleted: removes by id (derivation unbind / published delete)', () => {
    const detail = makeDetail({ services: [makeService('s1'), makeService('s2')] });
    const next = applyWorldChange(detail, {
      kind: 'world',
      action: 'deleted',
      objectType: 'service',
      object: { id: 's1' },
    });
    expect(next.services.map(s => s.id)).toEqual(['s2']);
  });

  it('rejects malformed service objects', () => {
    const detail = makeDetail();
    const next = applyWorldChange(detail, {
      kind: 'world',
      action: 'created',
      objectType: 'service',
      object: { id: 'broken' },
    });
    expect(next).toBe(detail);
  });
});

describe('service change attribution', () => {
  it('attributes service changes to the provider owner', () => {
    const message = {
      kind: 'world' as const,
      action: 'created' as const,
      objectType: 'service' as const,
      object: makeService('s1', { name: '新服务' }),
    };
    expect(actorOf(message)).toBe('user-b');
    expect(describeWorldChange(message)).toBe('小B 添加了服务「新服务」');
  });
});
