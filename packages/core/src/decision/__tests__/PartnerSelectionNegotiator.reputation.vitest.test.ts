/**
 * @vitest-environment node
 *
 * PartnerSelectionNegotiator × ReputationTracker integration tests (P4-1).
 *
 * With a tracker attached and `reputationEnabled` (default), the static
 * reliability term is replaced by the learned per-capability score: a
 * partner with a failed track record for the requested capability loses to
 * an equally capable healthy alternative. With the flag off (or no tracker)
 * the legacy local-history behavior is preserved (ablation path).
 */

import { describe, it, expect } from 'vitest';
import { PartnerSelectionNegotiator } from '../PartnerSelectionNegotiator.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { ReputationTracker } from '../../reputation/index.js';

// ---------------------------------------------------------------------------
// Helpers (same mock pattern as the proximity suite)
// ---------------------------------------------------------------------------

function createMockEnvironmentCenter(agents: Array<Record<string, unknown>>): EnvironmentCenter {
  return {
    discoverAgents: (criteria: { capabilities?: string[]; excludeIds?: string[] }) => {
      let result = agents;
      if (criteria.excludeIds) {
        result = result.filter(a => !criteria.excludeIds!.includes(a.id as string));
      }
      return result as any[];
    },
    listAgents: () => agents as any[],
  } as unknown as EnvironmentCenter;
}

function createMockAgent(
  id: string,
  name: string,
  capabilities: string[],
  currentCollaborations = 0,
): Record<string, unknown> {
  return {
    id,
    name,
    capabilities,
    currentCollaborations,
    resourceManager: { getAllResources: () => [] },
  };
}

function createMockAssessment(
  agentId: string,
  agentName: string,
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
      agentName,
      capabilities: ['temperature-control'],
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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PartnerSelectionNegotiator — reputation-based reliability (P4-1)', () => {
  const agents = () => [
    createMockAgent('agent-faulty', 'FaultyAgent', ['cooling', 'temperature-control']),
    createMockAgent('agent-healthy', 'HealthyAgent', ['cooling', 'temperature-control']),
  ];

  /** Tracker where faulty has 10/10 failures and healthy 10/10 successes on 'cooling'. */
  function makeTracker(): ReputationTracker {
    const tracker = new ReputationTracker();
    for (let i = 0; i < 10; i++) tracker.recordAttempt('agent-faulty', 'cooling', 0);
    for (let i = 0; i < 10; i++) tracker.recordAttempt('agent-healthy', 'cooling', 1);
    return tracker;
  }

  it('faulted agent loses to a healthy alternative with equal capabilities', async () => {
    const tracker = makeTracker();
    const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter(agents()));
    negotiator.setReputationTracker(tracker);

    const assessment = createMockAssessment('initiator-1', 'Initiator', ['cooling']);
    const result = await negotiator.findPartners(assessment);

    const faulty = result.selectedPartners.find(p => p.agentId === 'agent-faulty');
    const healthy = result.selectedPartners.find(p => p.agentId === 'agent-healthy');
    expect(faulty).toBeDefined();
    expect(healthy).toBeDefined();

    // Reliability comes from the tracker (per requested capability):
    // healthy = (10+3.5)/15 = 0.9, faulty = (0+3.5)/15 ≈ 0.2333
    expect(healthy!.reliability).toBeCloseTo(0.9, 5);
    expect(faulty!.reliability).toBeCloseTo(3.5 / 15, 5);

    // Everything else equal, the healthy partner outranks the faulted one.
    expect(healthy!.matchScore).toBeGreaterThan(faulty!.matchScore);
    expect(result.selectedPartners[0].agentId).toBe('agent-healthy');
  });

  it('falls back to the prior (0.7) for agents without history', async () => {
    const tracker = new ReputationTracker();
    const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter(agents()));
    negotiator.setReputationTracker(tracker);

    const assessment = createMockAssessment('initiator-1', 'Initiator', ['cooling']);
    const result = await negotiator.findPartners(assessment);

    for (const partner of result.selectedPartners) {
      expect(partner.reliability).toBeCloseTo(0.7, 5);
    }
  });

  it('averages the score over all requested capabilities', async () => {
    const tracker = new ReputationTracker();
    for (let i = 0; i < 10; i++) tracker.recordAttempt('agent-healthy', 'cooling', 1);
    // 'ventilation' unknown for both → prior
    const negotiator = new PartnerSelectionNegotiator(
      {},
      createMockEnvironmentCenter([
        createMockAgent('agent-healthy', 'HealthyAgent', ['cooling', 'ventilation']),
      ]),
    );
    negotiator.setReputationTracker(tracker);

    const assessment = createMockAssessment('initiator-1', 'Initiator', ['cooling', 'ventilation']);
    const result = await negotiator.findPartners(assessment);

    const partner = result.selectedPartners.find(p => p.agentId === 'agent-healthy');
    expect(partner).toBeDefined();
    // (0.9 + 0.7) / 2 = 0.8
    expect(partner!.reliability).toBeCloseTo(0.8, 5);
  });

  it('reputationEnabled=false restores the legacy static reliability (ablation)', async () => {
    const tracker = makeTracker();
    const negotiator = new PartnerSelectionNegotiator(
      { reputationEnabled: false },
      createMockEnvironmentCenter(agents()),
    );
    negotiator.setReputationTracker(tracker);

    const assessment = createMockAssessment('initiator-1', 'Initiator', ['cooling']);
    const result = await negotiator.findPartners(assessment);

    for (const partner of result.selectedPartners) {
      // Legacy default: no local collaboration history → 0.5
      expect(partner.reliability).toBeCloseTo(0.5, 5);
    }
  });

  it('without a tracker the legacy reliability is used', async () => {
    const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter(agents()));

    const assessment = createMockAssessment('initiator-1', 'Initiator', ['cooling']);
    const result = await negotiator.findPartners(assessment);

    for (const partner of result.selectedPartners) {
      expect(partner.reliability).toBeCloseTo(0.5, 5);
    }
  });

  it('legacy local history still applies when the tracker is detached', async () => {
    const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter(agents()));
    negotiator.setReputationTracker(makeTracker());
    negotiator.setReputationTracker(null);
    negotiator.recordCollaborationResult('agent-faulty', false);
    negotiator.recordCollaborationResult('agent-faulty', false);
    negotiator.recordCollaborationResult('agent-faulty', true);

    const assessment = createMockAssessment('initiator-1', 'Initiator', ['cooling']);
    const result = await negotiator.findPartners(assessment);

    const faulty = result.selectedPartners.find(p => p.agentId === 'agent-faulty');
    expect(faulty!.reliability).toBeCloseTo(1 / 3, 5);
  });
});
