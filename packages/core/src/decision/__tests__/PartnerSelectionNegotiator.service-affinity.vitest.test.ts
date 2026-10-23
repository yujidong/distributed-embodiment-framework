/**
 * @vitest-environment node
 *
 * R42-A/F3 §7.3: serviceAffinity in the initiator's candidate scoring.
 *
 * - A candidate whose service semanticTypes are word-root near neighbors of
 *   the event's requiredCapabilities gains a BONUS (outranks an equal twin
 *   without service evidence).
 * - No service evidence ⇒ no penalty (the legacy weighted score is kept —
 *   宽容: the capability match still decides).
 * - Generic-tail kinship does not create false affinity
 *   ('temperature-control' vs 'lighting-control' share only 'control').
 * - §7.2: the created proposal carries the structured service terms.
 */

import { describe, it, expect } from 'vitest';
import { PartnerSelectionNegotiator } from '../PartnerSelectionNegotiator.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';

function createMockEnvironmentCenter(
  agents: Array<Record<string, unknown>>,
  servicesByProvider: Map<string, Array<{ name: string; category: string }>> = new Map(),
): EnvironmentCenter {
  return {
    discoverAgents: (criteria: { capabilities?: string[]; excludeIds?: string[] }) => {
      let result = agents;
      if (criteria.excludeIds) {
        result = result.filter(a => !criteria.excludeIds!.includes(a.id as string));
      }
      return result as any[];
    },
    listAgents: () => agents as any[],
    // R42-A/F3: the service registry face (provider-grouped derived rows).
    // TWO provider shapes: AgentService's getProviderInfo() AND the plain
    // `providerAgentId` field of ResourceCoordinator's auto-published device
    // services (the 156-row mesh — getProviderInfo alone misses them).
    discoverServices: () =>
      [...servicesByProvider.entries()].flatMap(([providerAgentId, services]) =>
        services.map((s, i) => (i % 2 === 0
          ? { name: s.name, category: s.category, providerAgentId }
          : { name: s.name, category: s.category, getProviderInfo: () => ({ providerAgentId }) })),
      ),
  } as unknown as EnvironmentCenter;
}

function createMockAgent(id: string, name: string, capabilities: string[]): Record<string, unknown> {
  return {
    id,
    name,
    capabilities,
    currentCollaborations: 0,
    resourceManager: { getAllResources: () => [] },
  };
}

function createMockAssessment(
  agentId: string,
  requiredCapabilities: string[],
): ACNecessityAssessment {
  return {
    clusterSummary: {
      clusterId: 'test-cluster-1',
      region: { id: 'region-1', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: '2024-01-01T00:00:00Z - 2024-01-01T00:05:00Z',
      significance: 'high',
      summary: 'Test event requiring collaboration',
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

describe('PartnerSelectionNegotiator — serviceAffinity (R42-A/F3 §7.3)', () => {
  it('word-root near neighbors earn a bonus: service-backed candidate outranks the equal bare twin', async () => {
    const services = new Map<string, Array<{ name: string; category: string }>>([
      // 'air-quality' shares the domain root with required 'air-quality-monitoring'
      ['agent-air', [{ name: '空气治理服务', category: 'air-quality' }]],
      // generic tail only: shares 'control' with 'temperature-control' — NOT kin
      ['agent-light', [{ name: '照明服务', category: 'lighting-control' }]],
    ]);
    const env = createMockEnvironmentCenter(
      [
        createMockAgent('agent-air', 'AirAgent', ['air-quality-monitoring']),
        createMockAgent('agent-light', 'LightAgent', ['air-quality-monitoring']),
        createMockAgent('agent-bare', 'BareAgent', ['air-quality-monitoring']),
      ],
      services,
    );
    const negotiator = new PartnerSelectionNegotiator({}, env);

    const result = await negotiator.findPartners(
      createMockAssessment('initiator-1', ['air-quality-monitoring']),
    );

    const air = result.allRankedCandidates!.find(c => c.agentId === 'agent-air')!;
    const light = result.allRankedCandidates!.find(c => c.agentId === 'agent-light')!;
    const bare = result.allRankedCandidates!.find(c => c.agentId === 'agent-bare')!;

    // Affinity direction: near-neighbor evidence = 1, generic-tail = 0,
    // no evidence = 0.
    expect(air.serviceAffinity).toBe(1);
    expect(light.serviceAffinity).toBe(0);
    expect(bare.serviceAffinity).toBe(0);

    // Bonus direction: service-evidence candidate ranks above both twins…
    expect(air.matchScore).toBeGreaterThan(bare.matchScore);
    // …while no evidence and NON-matching evidence keep the same legacy
    // score (宽容: mismatched services never penalize).
    expect(light.matchScore).toBeCloseTo(bare.matchScore, 10);
    expect(result.allRankedCandidates![0].agentId).toBe('agent-air');
  });

  it('no service registry at all keeps the legacy score unchanged (mechanism silent)', async () => {
    const env = createMockEnvironmentCenter([
      createMockAgent('agent-a', 'A', ['cooling']),
      createMockAgent('agent-b', 'B', ['cooling']),
    ]);
    const negotiator = new PartnerSelectionNegotiator({}, env);

    const result = await negotiator.findPartners(createMockAssessment('initiator-1', ['cooling']));
    for (const candidate of result.allRankedCandidates!) {
      expect(candidate.serviceAffinity).toBe(0);
    }
    // The legacy weighted sum: both twins equal, ordering deterministic.
    const [a, b] = result.allRankedCandidates!;
    expect(a.matchScore).toBeCloseTo(b.matchScore, 10);
  });

  it('§7.2: the proposal carries the selected partners\' structured service terms', async () => {
    const services = new Map<string, Array<{ name: string; category: string }>>([
      ['agent-air', [{ name: '空气治理服务', category: 'air-quality' }]],
    ]);
    const env = createMockEnvironmentCenter(
      [createMockAgent('agent-air', 'AirAgent', ['air-quality-monitoring'])],
      services,
    );
    const negotiator = new PartnerSelectionNegotiator({ maxPartners: 1 }, env);

    const result = await negotiator.findPartners(
      createMockAssessment('initiator-1', ['air-quality-monitoring']),
    );

    expect(result.proposal.services).toEqual([
      { name: '空气治理服务', semanticType: 'air-quality' },
    ]);
  });
});
