/**
 * @vitest-environment node
 *
 * R44-dense-F2: adaptive broadcast fan-out in PartnerSelectionNegotiator.
 *
 * The legacy fixed maxPartners=5 broadcast was calibrated when per-response
 * accept rates were 55-62% (campus/standard). At dense scale (193 agents,
 * ranked pools of 30+ capability-identical stewards) the measured
 * per-response accept rate is ~11% (LLM lane), leaving P(≥1 accept) at a
 * coin flip — the 10/12 dense handshake outcome. When the ranked pool is
 * more than 3× maxPartners, the primary broadcast widens toward
 * maxBroadcastPartners (default 15, bounded by 3× maxPartners and the pool).
 * Small worlds keep the legacy fan-out exactly.
 */

import { describe, it, expect } from 'vitest';
import { PartnerSelectionNegotiator } from '../PartnerSelectionNegotiator.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';

function createMockEnvironmentCenter(
  agents: Array<Record<string, unknown>>,
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
    discoverServices: () => [],
  } as unknown as EnvironmentCenter;
}

function createMockAgent(id: string, capabilities: string[]): Record<string, unknown> {
  return {
    id,
    name: `Agent ${id}`,
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

describe('PartnerSelectionNegotiator — adaptive fan-out (R44-dense-F2)', () => {
  it('small pool (≤ 3× maxPartners) keeps the legacy 5-partner broadcast', async () => {
    const env = createMockEnvironmentCenter(
      Array.from({ length: 12 }, (_, i) => createMockAgent(`agent-${i}`, ['monitoring'])),
    );
    const negotiator = new PartnerSelectionNegotiator({}, env);

    const result = await negotiator.findPartners(createMockAssessment('initiator-1', ['monitoring']));

    expect(result.selectedPartners).toHaveLength(5);
  });

  it('dense pool widens the broadcast to 3× maxPartners (default cap 15)', async () => {
    const env = createMockEnvironmentCenter(
      Array.from({ length: 40 }, (_, i) => createMockAgent(`agent-${i}`, ['monitoring'])),
    );
    const negotiator = new PartnerSelectionNegotiator({}, env);

    const result = await negotiator.findPartners(createMockAssessment('initiator-1', ['monitoring']));

    expect(result.selectedPartners).toHaveLength(15);
    // The proposal targets the widened set.
    expect(result.proposal.targetPartnerIds).toHaveLength(15);
    // The ranked list still carries everyone for Phase 7 fallback.
    expect(result.allRankedCandidates).toHaveLength(40);
  });

  it('fan-out never exceeds the pool itself (slice clamps)', async () => {
    const env = createMockEnvironmentCenter(
      Array.from({ length: 6 }, (_, i) => createMockAgent(`agent-${i}`, ['monitoring'])),
    );
    const negotiator = new PartnerSelectionNegotiator({ maxPartners: 5, maxBroadcastPartners: 30 }, env);

    const result = await negotiator.findPartners(createMockAssessment('initiator-1', ['monitoring']));

    // Pool 6 ≤ 3×5 → no widening, and the slice cannot exceed the pool.
    expect(result.selectedPartners).toHaveLength(5);
    expect(result.allRankedCandidates).toHaveLength(6);
  });

  it('maxBroadcastPartners caps the widened fan-out', async () => {
    const env = createMockEnvironmentCenter(
      Array.from({ length: 40 }, (_, i) => createMockAgent(`agent-${i}`, ['monitoring'])),
    );
    const negotiator = new PartnerSelectionNegotiator({ maxBroadcastPartners: 8 }, env);

    const result = await negotiator.findPartners(createMockAssessment('initiator-1', ['monitoring']));

    expect(result.selectedPartners).toHaveLength(8);
  });

  it('a configured maxPartners > 5 also widens (3× rule, bounded by pool)', async () => {
    const env = createMockEnvironmentCenter(
      Array.from({ length: 40 }, (_, i) => createMockAgent(`agent-${i}`, ['monitoring'])),
    );
    const negotiator = new PartnerSelectionNegotiator({ maxPartners: 8, maxBroadcastPartners: 30 }, env);

    const result = await negotiator.findPartners(createMockAssessment('initiator-1', ['monitoring']));

    expect(result.selectedPartners).toHaveLength(24); // min(30, 3×8=24, 40)
  });
});
