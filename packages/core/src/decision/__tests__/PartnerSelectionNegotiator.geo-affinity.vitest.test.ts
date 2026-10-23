/**
 * @vitest-environment node
 *
 * R45-P1: geoAffinity in the initiator's candidate scoring — the
 * administrative-corridor ranking that the proximity term cannot supply in
 * bounds-less city worlds (there every candidate scores the neutral 0.5, so
 * 6 capability-identical district substation stewards tied and ALL accepted
 * — docs/devloop-r45-realistic-report.md §2.4).
 *
 * Ladder over the zone graph (managedZoneIds × the event zone):
 *   1.0 same zone (属地) > 0.8 adjacent corridor (走廊) > 0.3 far (远区);
 *   no zone evidence ⇒ 0 ⇒ legacy score untouched (宽容, bonus-only).
 * Split: serviceAffinity × 0.7 + geoAffinity × 0.3 (capability stays
 * primary; geo is the tie-breaker).
 */

import { describe, it, expect } from 'vitest';
import { PartnerSelectionNegotiator } from '../PartnerSelectionNegotiator.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';

/** The R45 substation corridor: nan↔bao adjacent; fu/luo adjacent; yan/long far. */
const ZONES = [
  { id: 'nan-substation', adjacentZoneIds: ['bao-substation'] },
  { id: 'bao-substation', adjacentZoneIds: ['nan-substation', 'yan-substation'] },
  { id: 'yan-substation', adjacentZoneIds: ['bao-substation'] },
  { id: 'fu-substation', adjacentZoneIds: ['luo-substation'] },
  { id: 'luo-substation', adjacentZoneIds: ['fu-substation'] },
  { id: 'long-substation', adjacentZoneIds: [] },
];

function createMockEnvironmentCenter(
  agents: Array<Record<string, unknown>>,
): EnvironmentCenter {
  return {
    discoverAgents: (criteria: { capabilities?: string[]; excludeIds?: string[] }) =>
      agents.filter(a => !criteria.excludeIds?.includes(a.id as string)) as any[],
    listAgents: () => agents as any[],
    discoverServices: () => [],
  } as unknown as EnvironmentCenter;
}

/** A capability-identical substation keeper with a zone face (metadata shape). */
function createKeeper(id: string, managedZoneIds: string[]): Record<string, unknown> {
  return {
    id,
    name: id,
    capabilities: ['power-monitoring', 'turn-on', 'load-management'],
    currentCollaborations: 0,
    resourceManager: { getAllResources: () => [] },
    metadata: { managedZoneIds },
  };
}

function createMockAssessment(
  agentId: string,
  requiredCapabilities: string[],
  eventZone: string,
): ACNecessityAssessment {
  return {
    clusterSummary: {
      clusterId: 'cluster-nan-load-gap',
      region: { id: eventZone, center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: '2026-08-29T10:00:00Z - 2026-08-29T10:05:00Z',
      significance: 'high',
      summary: 'Nanshan load gap after transfer — cross-zone generator support needed',
      findings: [],
      recommendation: 'immediate_action',
    } as unknown as SpatialClusterSummary,
    agentContext: {
      agentId,
      agentName: 'Initiator',
      capabilities: [],
      availableResources: [],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: true,
      reasoning: 'Test collaboration',
      urgency: 'high',
      suggestedPartnerTypes: [],
      requiredCapabilities,
      confidence: 0.9,
      estimatedDuration: 60000,
      potentialRisks: [],
    },
    decision: 'initiate_ac',
    timestamp: new Date(),
  } as unknown as ACNecessityAssessment;
}

describe('PartnerSelectionNegotiator — geoAffinity corridor ranking (R45-P1)', () => {
  it('ranks same-zone > adjacent-corridor > far-zone among capability-equal candidates (nan-load-gap → Bao’an first)', async () => {
    const env = createMockEnvironmentCenter([
      // nan keeper: same zone as the event (属地)
      createKeeper('nan-substation-keeper', ['nan-substation']),
      // bao keeper: the declared support corridor (走廊)
      createKeeper('bao-substation-keeper', ['bao-substation']),
      // yan: adjacent to bao, NOT to nan → far
      createKeeper('yan-substation-keeper', ['yan-substation']),
      // luo / long: far districts
      createKeeper('luo-substation-keeper', ['luo-substation']),
      createKeeper('long-substation-keeper', ['long-substation']),
    ]);
    const negotiator = new PartnerSelectionNegotiator({}, env);
    negotiator.setZoneTopology(ZONES);

    const result = await negotiator.findPartners(
      createMockAssessment('city-energy', ['power-monitoring', 'load-management'], 'nan-substation'),
    );

    const byId = new Map(result.allRankedCandidates!.map(c => [c.agentId, c]));
    expect(byId.get('nan-substation-keeper')!.geoAffinity).toBe(1);
    expect(byId.get('bao-substation-keeper')!.geoAffinity).toBeCloseTo(0.8, 10);
    expect(byId.get('yan-substation-keeper')!.geoAffinity).toBeCloseTo(0.3, 10);
    expect(byId.get('luo-substation-keeper')!.geoAffinity).toBeCloseTo(0.3, 10);

    // Ordering: same zone first, corridor (Bao'an) second, far zones behind.
    const order = result.allRankedCandidates!.map(c => c.agentId);
    expect(order.indexOf('nan-substation-keeper')).toBeLessThan(order.indexOf('bao-substation-keeper'));
    expect(order.indexOf('bao-substation-keeper')).toBeLessThan(order.indexOf('yan-substation-keeper'));
    expect(order.indexOf('bao-substation-keeper')).toBeLessThan(order.indexOf('luo-substation-keeper'));
    // The acceptance criterion: Bao'an ranks FIRST among the SUPPORT
    // candidates (the initiator city-energy is not a candidate; the
    // nan-substation keeper is the HOST, not a supporter).
    const supporters = order.filter(id => id !== 'nan-substation-keeper');
    expect(supporters[0]).toBe('bao-substation-keeper');
  });

  it('candidates without a zone face keep the legacy score (宽容 — geoAffinity 0, no penalty)', async () => {
    const bare = createKeeper('bare-keeper', []);
    const far = createKeeper('luo-substation-keeper', ['luo-substation']);
    const env = createMockEnvironmentCenter([bare, far]);
    const negotiator = new PartnerSelectionNegotiator({}, env);
    negotiator.setZoneTopology(ZONES);

    const result = await negotiator.findPartners(
      createMockAssessment('initiator-1', ['power-monitoring'], 'nan-substation'),
    );
    const byId = new Map(result.allRankedCandidates!.map(c => [c.agentId, c]));
    // No zone face ⇒ geoAffinity 0 (bonus-only, never negative).
    expect(byId.get('bare-keeper')!.geoAffinity).toBe(0);
    expect(byId.get('luo-substation-keeper')!.geoAffinity).toBeCloseTo(0.3, 10);
    // A far-zone candidate WITH zone evidence outranks the bare twin only
    // through the geo bonus — and never falls below the legacy score.
    expect(byId.get('luo-substation-keeper')!.matchScore)
      .toBeGreaterThan(byId.get('bare-keeper')!.matchScore);
  });

  it('service evidence stays primary: a service-matched far candidate outranks a geo-matched bare one only within the 0.7/0.3 split', async () => {
    // Two candidates with identical base scores; one carries matching
    // service evidence but sits far away, the other sits in the corridor
    // with no service evidence. 0.7×1 (service) > 0.3×0.8 (geo) → the
    // service-backed candidate wins (能力仍为主，地理做 tie-breaker).
    const far = {
      ...createKeeper('far-with-services', ['luo-substation']),
      metadata: { managedZoneIds: ['luo-substation'] },
    };
    const corridor = createKeeper('corridor-bare', ['bao-substation']);
    const env = createMockEnvironmentCenter([far, corridor]);
    const negotiator = new PartnerSelectionNegotiator({}, env);
    negotiator.setZoneTopology(ZONES);

    // Give the far candidate matching service evidence via the registry.
    (env as unknown as { discoverServices: () => unknown[] }).discoverServices = () => [
      { name: 'power-support', category: 'power-monitoring', providerAgentId: 'far-with-services' },
    ];

    const result = await negotiator.findPartners(
      createMockAssessment('initiator-1', ['power-monitoring'], 'nan-substation'),
    );
    const byId = new Map(result.allRankedCandidates!.map(c => [c.agentId, c]));
    expect(byId.get('far-with-services')!.serviceAffinity).toBe(1);
    expect(byId.get('far-with-services')!.matchScore)
      .toBeGreaterThan(byId.get('corridor-bare')!.matchScore);
  });

  it('without an injected topology, same-zone still ranks first (adjacency degrades to empty)', async () => {
    const env = createMockEnvironmentCenter([
      createKeeper('nan-substation-keeper', ['nan-substation']),
      createKeeper('bao-substation-keeper', ['bao-substation']),
    ]);
    const negotiator = new PartnerSelectionNegotiator({}, env);
    // NOTE: no setZoneTopology call — graceful degradation.
    const result = await negotiator.findPartners(
      createMockAssessment('initiator-1', ['power-monitoring'], 'nan-substation'),
    );
    const byId = new Map(result.allRankedCandidates!.map(c => [c.agentId, c]));
    expect(byId.get('nan-substation-keeper')!.geoAffinity).toBe(1);
    // No adjacency data: bao is merely "not same zone" → 0.3, still ranked
    // below the host but above a bare candidate.
    expect(byId.get('bao-substation-keeper')!.geoAffinity).toBeCloseTo(0.3, 10);
    expect(result.allRankedCandidates![0].agentId).toBe('nan-substation-keeper');
  });
});
