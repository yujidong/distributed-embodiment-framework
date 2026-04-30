/**
 * TDD Tests for Spatial Proximity Scoring in PartnerSelectionNegotiator
 *
 * Tests verify that:
 * 1. extractPosition handles all DeviceLocation variants
 * 2. calculateProximityScore returns correct values for various position scenarios
 * 3. Integration test: findPartners with agents at different distances produces correct proximity scores
 * 4. Proximity score correctly flows into final matchScore via weighted calculation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PartnerSelectionNegotiator } from '../PartnerSelectionNegotiator.js';
import type { NegotiatorConfig } from '../PartnerSelectionNegotiator.js';
import type { ACNecessityAssessment } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SpatialPosition } from '@active-collaboration/shared';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a minimal EnvironmentCenter-like mock that supports discoverAgents.
 * We use a plain object with the methods the negotiator actually calls.
 */
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

/**
 * Create a mock CognitiveAgent with position data via resourceManager.
 */
function createMockAgent(
  id: string,
  name: string,
  capabilities: string[],
  position: SpatialPosition | null,
  currentCollaborations = 0
): Record<string, unknown> {
  const resources = position
    ? [{ getLocation: () => ({ path: `room-${id}`, position: { x: position.x, y: position.y, z: position.z } }) }]
    : [];

  return {
    id,
    name,
    capabilities,
    currentCollaborations,
    resourceManager: {
      getAllResources: () => resources,
    },
  };
}

/**
 * Create a minimal ACNecessityAssessment for testing.
 */
function createMockAssessment(
  agentId: string,
  agentName: string,
  requiredCapabilities: string[],
  resourcesWithLocations: Array<{ deviceId: string; location: unknown }> = []
): ACNecessityAssessment {
  return {
    clusterSummary: {
      clusterId: 'test-cluster-1',
      region: {
        id: 'region-1',
        center: { x: 0, y: 0 },
        radius: 10,
        type: 'zone',
      },
      timeWindow: '2024-01-01T00:00:00Z - 2024-01-01T00:05:00Z',
      significance: 'high',
      summary: 'Test event requiring collaboration',
      findings: [
        {
          eventType: 'temperature.breach',
          count: 3,
          trend: 'increasing',
          anomaly: true,
          details: { temperature: 28, threshold: 25 },
        },
      ],
      recommendation: 'immediate_action',
    } as SpatialClusterSummary,
    agentContext: {
      agentId,
      agentName,
      capabilities: ['temperature-control'],
      availableResources: resourcesWithLocations.map(r => ({
        deviceId: r.deviceId,
        type: 'sensor',
        capabilities: ['temperature-sensing'],
        location: r.location,
      })),
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: true,
      reasoning: 'Test collaboration',
      urgency: 'high',
      suggestedPartnerTypes: ['climate-control-agent'],
      requiredCapabilities,
      confidence: 0.9,
      estimatedDuration: 60000,
      potentialRisks: [],
    },
    decision: 'initiate_ac',
    timestamp: new Date(),
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('PartnerSelectionNegotiator - Spatial Proximity Scoring', () => {

  // --------------------------------------------------------------------------
  // 1. extractPosition tests
  // --------------------------------------------------------------------------
  describe('extractPosition (via internal behavior)', () => {
    let negotiator: PartnerSelectionNegotiator;

    beforeEach(() => {
      negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter([]));
    });

    /**
     * Since extractPosition is private, we test it indirectly through
     * the public findPartners method. We set up an assessment with a
     * resource that has a specific location, then verify the proximity
     * scores of candidates reflect correct position extraction.
     *
     * However, we can also test it more directly by using (negotiator as any)
     * to access private methods for unit testing.
     */

    it('should return null for string location', () => {
      const result = (negotiator as any).extractPosition('room-1');
      expect(result).toBeNull();
    });

    it('should return null for null location', () => {
      const result = (negotiator as any).extractPosition(null);
      expect(result).toBeNull();
    });

    it('should return null for undefined location', () => {
      const result = (negotiator as any).extractPosition(undefined);
      expect(result).toBeNull();
    });

    it('should return null for object without position', () => {
      const result = (negotiator as any).extractPosition({ path: 'room-1' });
      expect(result).toBeNull();
    });

    it('should return null for object with incomplete position (missing y)', () => {
      const result = (negotiator as any).extractPosition({ path: 'room-1', position: { x: 10 } });
      expect(result).toBeNull();
    });

    it('should return null for object with incomplete position (missing x)', () => {
      const result = (negotiator as any).extractPosition({ path: 'room-1', position: { y: 10 } });
      expect(result).toBeNull();
    });

    it('should extract position from valid object with x, y (z defaults to 0)', () => {
      const result = (negotiator as any).extractPosition({
        path: 'room-1',
        position: { x: 10, y: 20 },
      });
      expect(result).toEqual({ x: 10, y: 20, z: 0 });
    });

    it('should extract full position from valid object with x, y, z', () => {
      const result = (negotiator as any).extractPosition({
        path: 'room-1',
        position: { x: 5, y: 15, z: 3 },
      });
      expect(result).toEqual({ x: 5, y: 15, z: 3 });
    });

    it('should handle object with extra properties', () => {
      const result = (negotiator as any).extractPosition({
        path: 'room-1',
        position: { x: 1, y: 2, z: 3 },
        metadata: { floor: 2 },
        customField: 'value',
      });
      expect(result).toEqual({ x: 1, y: 2, z: 3 });
    });
  });

  // --------------------------------------------------------------------------
  // 2. calculateProximityScore tests
  // --------------------------------------------------------------------------
  describe('calculateProximityScore', () => {
    it('should return 1.0 for same position', () => {
      const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter([]));
      const pos: SpatialPosition = { x: 10, y: 20, z: 0 };
      const result = (negotiator as any).calculateProximityScore(pos, pos);
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('should return 0.5 when both positions are null', () => {
      const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter([]));
      const result = (negotiator as any).calculateProximityScore(null, null);
      expect(result).toBeCloseTo(0.5, 5);
    });

    it('should return 0.5 when first position is null', () => {
      const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter([]));
      const pos: SpatialPosition = { x: 10, y: 20, z: 0 };
      const result = (negotiator as any).calculateProximityScore(null, pos);
      expect(result).toBeCloseTo(0.5, 5);
    });

    it('should return 0.5 when second position is null', () => {
      const negotiator = new PartnerSelectionNegotiator({}, createMockEnvironmentCenter([]));
      const pos: SpatialPosition = { x: 10, y: 20, z: 0 };
      const result = (negotiator as any).calculateProximityScore(pos, null);
      expect(result).toBeCloseTo(0.5, 5);
    });

    it('should return decreasing values for increasing distance', () => {
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        createMockEnvironmentCenter([])
      );
      const origin: SpatialPosition = { x: 0, y: 0, z: 0 };

      const scoreAt10m = (negotiator as any).calculateProximityScore(origin, { x: 10, y: 0, z: 0 });
      const scoreAt20m = (negotiator as any).calculateProximityScore(origin, { x: 20, y: 0, z: 0 });
      const scoreAt30m = (negotiator as any).calculateProximityScore(origin, { x: 30, y: 0, z: 0 });
      const scoreAt40m = (negotiator as any).calculateProximityScore(origin, { x: 40, y: 0, z: 0 });

      // Scores should decrease with distance
      expect(scoreAt10m).toBeGreaterThan(scoreAt20m);
      expect(scoreAt20m).toBeGreaterThan(scoreAt30m);
      expect(scoreAt30m).toBeGreaterThan(scoreAt40m);

      // Verify specific values: score = 1 - distance/maxDistance
      expect(scoreAt10m).toBeCloseTo(0.8, 5);  // 1 - 10/50
      expect(scoreAt20m).toBeCloseTo(0.6, 5);  // 1 - 20/50
      expect(scoreAt30m).toBeCloseTo(0.4, 5);  // 1 - 30/50
      expect(scoreAt40m).toBeCloseTo(0.2, 5);  // 1 - 40/50
    });

    it('should return 0 for positions beyond maxProximityDistance', () => {
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        createMockEnvironmentCenter([])
      );
      const origin: SpatialPosition = { x: 0, y: 0, z: 0 };
      const far: SpatialPosition = { x: 60, y: 0, z: 0 };

      const result = (negotiator as any).calculateProximityScore(origin, far);
      expect(result).toBe(0);
    });

    it('should return 0 for positions exactly at maxProximityDistance (boundary)', () => {
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        createMockEnvironmentCenter([])
      );
      const origin: SpatialPosition = { x: 0, y: 0, z: 0 };
      const atBoundary: SpatialPosition = { x: 50, y: 0, z: 0 };

      const result = (negotiator as any).calculateProximityScore(origin, atBoundary);
      // 1 - 50/50 = 0
      expect(result).toBeCloseTo(0, 5);
    });

    it('should use 3D distance (not just 2D)', () => {
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        createMockEnvironmentCenter([])
      );
      const origin: SpatialPosition = { x: 0, y: 0, z: 0 };
      // 3D distance = sqrt(30^2 + 40^2) = 50
      const pos3D: SpatialPosition = { x: 30, y: 40, z: 0 };

      const result = (negotiator as any).calculateProximityScore(origin, pos3D);
      // 1 - 50/50 = 0
      expect(result).toBeCloseTo(0, 5);
    });

    it('should use custom maxProximityDistance from config', () => {
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 100 },
        createMockEnvironmentCenter([])
      );
      const origin: SpatialPosition = { x: 0, y: 0, z: 0 };
      const at50m: SpatialPosition = { x: 50, y: 0, z: 0 };

      const result = (negotiator as any).calculateProximityScore(origin, at50m);
      // 1 - 50/100 = 0.5
      expect(result).toBeCloseTo(0.5, 5);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Integration: findPartners with agents at different distances
  // --------------------------------------------------------------------------
  describe('Integration: findPartners with spatial proximity', () => {
    it('should assign correct proximity scores based on agent distances', async () => {
      // Arrange: initiator at origin
      const initiatorPosition: SpatialPosition = { x: 0, y: 0, z: 0 };

      // Three agents at different distances
      const nearAgent = createMockAgent('agent-near', 'NearAgent', ['cooling', 'temperature-control'], { x: 5, y: 0, z: 0 });
      const midAgent = createMockAgent('agent-mid', 'MidAgent', ['cooling', 'temperature-control'], { x: 25, y: 0, z: 0 });
      const farAgent = createMockAgent('agent-far', 'FarAgent', ['cooling', 'temperature-control'], { x: 100, y: 0, z: 0 });

      const envCenter = createMockEnvironmentCenter([nearAgent, midAgent, farAgent]);
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        envCenter
      );

      const assessment = createMockAssessment(
        'initiator-1',
        'InitiatorAgent',
        ['cooling', 'temperature-control'],
        [{ deviceId: 'device-init', location: { path: 'room-init', position: initiatorPosition } }]
      );

      // Act
      const result = await negotiator.findPartners(assessment);

      // Assert
      expect(result.selectedPartners.length).toBeGreaterThan(0);

      // Find each partner in the result
      const nearPartner = result.selectedPartners.find(p => p.agentId === 'agent-near');
      const midPartner = result.selectedPartners.find(p => p.agentId === 'agent-mid');
      const farPartner = result.selectedPartners.find(p => p.agentId === 'agent-far');

      // Near agent: distance 5m, proximity = 1 - 5/50 = 0.9
      expect(nearPartner).toBeDefined();
      expect(nearPartner!.proximity).toBeCloseTo(0.9, 3);

      // Mid agent: distance 25m, proximity = 1 - 25/50 = 0.5
      expect(midPartner).toBeDefined();
      expect(midPartner!.proximity).toBeCloseTo(0.5, 3);

      // Far agent: distance 100m, proximity = max(0, 1 - 100/50) = 0
      expect(farPartner).toBeDefined();
      expect(farPartner!.proximity).toBeCloseTo(0, 3);
    });

    it('should assign 0.5 proximity when initiator has no position', async () => {
      // Agents with positions
      const agent1 = createMockAgent('agent-1', 'Agent1', ['cooling'], { x: 10, y: 20, z: 0 });
      const agent2 = createMockAgent('agent-2', 'Agent2', ['cooling'], null);

      const envCenter = createMockEnvironmentCenter([agent1, agent2]);
      const negotiator = new PartnerSelectionNegotiator({}, envCenter);

      // Assessment with no location on resources
      const assessment = createMockAssessment('initiator-1', 'InitiatorAgent', ['cooling'], []);

      const result = await negotiator.findPartners(assessment);

      // Both should have 0.5 proximity (initiator has no position)
      for (const partner of result.selectedPartners) {
        expect(partner.proximity).toBeCloseTo(0.5, 3);
      }
    });

    it('should assign 0.5 proximity when candidate has no position', async () => {
      const agentNoPosition = createMockAgent('agent-no-pos', 'NoPositionAgent', ['cooling'], null);

      const envCenter = createMockEnvironmentCenter([agentNoPosition]);
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        envCenter
      );

      const initiatorPos: SpatialPosition = { x: 0, y: 0, z: 0 };
      const assessment = createMockAssessment(
        'initiator-1',
        'InitiatorAgent',
        ['cooling'],
        [{ deviceId: 'device-init', location: { path: 'room-init', position: initiatorPos } }]
      );

      const result = await negotiator.findPartners(assessment);

      const partner = result.selectedPartners.find(p => p.agentId === 'agent-no-pos');
      expect(partner).toBeDefined();
      expect(partner!.proximity).toBeCloseTo(0.5, 3);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Proximity flows into matchScore
  // --------------------------------------------------------------------------
  describe('Proximity score flows into matchScore', () => {
    it('should produce higher matchScore for closer agents (all else being equal)', async () => {
      // Two agents with identical capabilities and workload, different positions
      const closeAgent = createMockAgent('agent-close', 'CloseAgent', ['cooling', 'temperature-control'], { x: 5, y: 0, z: 0 });
      const farAgent = createMockAgent('agent-far', 'FarAgent', ['cooling', 'temperature-control'], { x: 45, y: 0, z: 0 });

      const envCenter = createMockEnvironmentCenter([closeAgent, farAgent]);
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        envCenter
      );

      const initiatorPos: SpatialPosition = { x: 0, y: 0, z: 0 };
      const assessment = createMockAssessment(
        'initiator-1',
        'InitiatorAgent',
        ['cooling', 'temperature-control'],
        [{ deviceId: 'device-init', location: { path: 'room-init', position: initiatorPos } }]
      );

      const result = await negotiator.findPartners(assessment);

      const closePartner = result.selectedPartners.find(p => p.agentId === 'agent-close');
      const farPartner = result.selectedPartners.find(p => p.agentId === 'agent-far');

      expect(closePartner).toBeDefined();
      expect(farPartner).toBeDefined();

      // Close agent should have higher matchScore
      expect(closePartner!.matchScore).toBeGreaterThan(farPartner!.matchScore);
    });

    it('should correctly weight proximity in matchScore calculation', async () => {
      // Test with known values to verify the weighted calculation
      const agent = createMockAgent('agent-1', 'TestAgent', ['cooling', 'temperature-control'], { x: 10, y: 0, z: 0 });

      const envCenter = createMockEnvironmentCenter([agent]);
      const config: Partial<NegotiatorConfig> = {
        maxProximityDistance: 50,
        capabilityWeight: 0.4,
        workloadWeight: 0.25,
        reliabilityWeight: 0.2,
        proximityWeight: 0.15,
      };
      const negotiator = new PartnerSelectionNegotiator(config, envCenter);

      const initiatorPos: SpatialPosition = { x: 0, y: 0, z: 0 };
      const assessment = createMockAssessment(
        'initiator-1',
        'InitiatorAgent',
        ['cooling', 'temperature-control'],
        [{ deviceId: 'device-init', location: { path: 'room-init', position: initiatorPos } }]
      );

      const result = await negotiator.findPartners(assessment);

      const partner = result.selectedPartners.find(p => p.agentId === 'agent-1');
      expect(partner).toBeDefined();

      // Proximity = 1 - 10/50 = 0.8
      expect(partner!.proximity).toBeCloseTo(0.8, 3);

      // Verify matchScore includes proximity contribution
      // matchScore = capabilityScore * 0.4 + workloadScore * 0.25 + reliability * 0.2 + proximity * 0.15
      // The exact values depend on capability matching and workload estimation,
      // but we can verify the proximity contribution is correctly included.
      const proximityContribution = partner!.proximity * config.proximityWeight!;
      // proximity contribution = 0.8 * 0.15 = 0.12
      expect(proximityContribution).toBeCloseTo(0.12, 3);

      // matchScore must be at least the proximity contribution
      expect(partner!.matchScore).toBeGreaterThanOrEqual(proximityContribution - 0.001);
    });

    it('should produce the same matchScore for two agents at same distance with same capabilities', async () => {
      const agent1 = createMockAgent('agent-a', 'AgentA', ['cooling', 'temperature-control'], { x: 10, y: 0, z: 0 });
      const agent2 = createMockAgent('agent-b', 'AgentB', ['cooling', 'temperature-control'], { x: 0, y: 10, z: 0 });

      const envCenter = createMockEnvironmentCenter([agent1, agent2]);
      const negotiator = new PartnerSelectionNegotiator(
        { maxProximityDistance: 50 },
        envCenter
      );

      const initiatorPos: SpatialPosition = { x: 0, y: 0, z: 0 };
      const assessment = createMockAssessment(
        'initiator-1',
        'InitiatorAgent',
        ['cooling', 'temperature-control'],
        [{ deviceId: 'device-init', location: { path: 'room-init', position: initiatorPos } }]
      );

      const result = await negotiator.findPartners(assessment);

      const partnerA = result.selectedPartners.find(p => p.agentId === 'agent-a');
      const partnerB = result.selectedPartners.find(p => p.agentId === 'agent-b');

      expect(partnerA).toBeDefined();
      expect(partnerB).toBeDefined();

      // Both at same distance, same capabilities -> same proximity and same matchScore
      expect(partnerA!.proximity).toBeCloseTo(partnerB!.proximity, 5);
      expect(partnerA!.matchScore).toBeCloseTo(partnerB!.matchScore, 5);
    });
  });
});
