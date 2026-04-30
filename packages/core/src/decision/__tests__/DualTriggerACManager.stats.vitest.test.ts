/**
 * Enhanced Statistics Collection Tests for DualTriggerACManager
 *
 * These tests verify that the enhanced statistics fields are correctly tracked:
 * 1. Stats are initialized with correct default values
 * 2. layer2DecisionDistribution tracks each decision type correctly
 * 3. avgAssessmentTimeMs is computed correctly from tracked values
 * 4. avgConfidence is computed correctly
 * 5. layer1FilterRate is computed correctly
 * 6. Division by zero is handled (all rates return 0 when no events processed)
 * 7. getStats() returns all computed metrics alongside raw stats
 *
 * Strategy: The ACNecessityAssessor has complex pre-check logic that may override
 * LLM responses. To isolate the DualTriggerACManager's stats tracking, we spy on
 * the assessor's assess() method to return predetermined assessments.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import type { ACNecessityAssessment, AgentContext } from '../ACNecessityAssessor.js';
import type { SpatialClusterSummary } from '../../events/SpatialTemporalClusterEngine.js';

// ============================================================================
// Helper Types for Private Member Access
// ============================================================================

/** Interface for accessing DualTriggerACManager private members in tests */
interface DualTriggerACManagerTestAccess {
  resourceManager: ResourceManagerLike | undefined;
  serviceRegistry: ServiceRegistryLike | undefined;
  acNecessityAssessor: AssessorAccess | null;
  stats: {
    totalEventsProcessed: number;
    filteredByLayer1: number;
    passedToLayer2: number;
    acDecisionMade: number;
    acInitiated: number;
    handledIndependently: number;
    deferred: number;
    layer2DecisionDistribution: Record<string, number>;
    totalAssessmentTimeMs: number;
    assessmentCount: number;
    totalConfidence: number;
    confidenceCount: number;
  };
}

/** Assessor access for spying */
interface AssessorAccess {
  assess: Mock<(summary: SpatialClusterSummary, context: AgentContext) => Promise<ACNecessityAssessment>>;
  getStats: () => Record<string, number>;
}

/** Minimal ResourceManager interface */
interface ResourceManagerLike {
  getResource: Mock<(deviceId: string) => DeviceResourceLike | null>;
}

/** Device resource returned by ResourceManager */
interface DeviceResourceLike {
  getState: () => Record<string, unknown>;
  getLocation: () => Record<string, unknown>;
  isAvailable: () => boolean;
}

/** Minimal ServiceRegistry interface */
interface ServiceRegistryLike {
  getOwnServices: Mock<() => ServiceEntryLike[]>;
}

/** Service entry from ServiceRegistry */
interface ServiceEntryLike {
  name: string;
  capabilities: string[];
  status: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock assessment with specific decision and confidence */
function createMockAssessment(
  decision: ACNecessityAssessment['decision'],
  confidence: number = 0.5
): ACNecessityAssessment {
  return {
    clusterSummary: {
      clusterId: 'test-cluster',
      region: { id: 'test-region', center: { x: 0, y: 0 }, radius: 10, type: 'zone' },
      timeWindow: new Date().toISOString(),
      significance: 'medium',
      summary: 'Test cluster summary',
      findings: [],
      recommendation: 'evaluate_with_llm',
    },
    agentContext: {
      agentId: 'test-agent',
      agentName: 'TestAgent',
      capabilities: ['temperature-control'],
      availableResources: [],
      currentWorkload: 'idle',
      recentCollaborations: [],
      currentCollaborations: 0,
    },
    llmAssessment: {
      needsCollaboration: decision === 'initiate_ac',
      reasoning: `Test: ${decision}`,
      urgency: 'medium',
      suggestedPartnerTypes: [],
      requiredCapabilities: [],
      confidence,
      estimatedDuration: 1000,
      potentialRisks: [],
    },
    decision,
    timestamp: new Date(),
  };
}

/**
 * Create a DualTriggerACManager configured to bypass Layer 1 (disableSpatiotemporal)
 * so events go directly to Layer 2 assessment.
 */
function createManager(configOverrides: Record<string, unknown> = {}): {
  manager: DualTriggerACManager;
  mockLLMClient: LLMClient;
  mockEnvironment: EnvironmentCenter;
  onACInitiation: Mock;
} {
  const mockLLMClient = {
    chat: vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            needsCollaboration: false,
            reasoning: 'Test reasoning',
            urgency: 'low',
            suggestedPartnerTypes: [],
            requiredCapabilities: [],
            confidence: 0.5,
            estimatedDuration: 1000,
            potentialRisks: [],
          }),
        },
      }],
    }),
    quickChat: vi.fn().mockResolvedValue('{"decision":"handle_independently"}'),
  } as unknown as LLMClient;

  const mockResourceManager: ResourceManagerLike = {
    getResource: vi.fn(),
  };

  const mockServiceRegistry: ServiceRegistryLike = {
    getOwnServices: vi.fn().mockReturnValue([]),
  };

  const mockEnvironment = {
    listDevices: vi.fn().mockReturnValue([]),
    listAgents: vi.fn().mockReturnValue([]),
    getParameters: vi.fn().mockReturnValue({}),
    eventManager: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      publish: vi.fn(),
    },
    services: new Map(),
  } as unknown as EnvironmentCenter;

  const onACInitiation = vi.fn();

  const manager = new DualTriggerACManager(
    'test-agent-stats',
    'StatsTestAgent',
    ['temperature-control', 'hvac-control', 'monitoring', 'cooling'],
    mockLLMClient,
    mockEnvironment,
    onACInitiation,
    {
      enableLayer1: true,
      enableLayer2: true,
      autoInitiateAC: false,
      disableSpatiotemporal: true, // Bypass Layer 1 for direct Layer 2 testing
      ...configOverrides,
    }
  );

  // Inject mock dependencies
  const access = manager as unknown as DualTriggerACManagerTestAccess;
  access.resourceManager = mockResourceManager;
  access.serviceRegistry = mockServiceRegistry;

  return { manager, mockLLMClient, mockEnvironment, onACInitiation };
}

/** Create a standard non-urgent event */
function createEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return {
    id: `event-${Date.now()}-${Math.random()}`,
    type: 'generic.event',
    source: 'device-1',
    timestamp: new Date(),
    payload: {},
    priority: 'normal',
    ...overrides,
  };
}

/**
 * Spy on the assessor's assess() method to return a specific decision and confidence.
 * This isolates the DualTriggerACManager's stats tracking from the assessor's
 * internal pre-check logic.
 */
function mockAssessorDecision(
  manager: DualTriggerACManager,
  decision: ACNecessityAssessment['decision'],
  confidence: number = 0.5
): void {
  const access = manager as unknown as DualTriggerACManagerTestAccess;
  const assessor = access.acNecessityAssessor;
  if (!assessor) {
    throw new Error('Assessor not initialized - enable Layer 2');
  }
  vi.spyOn(assessor, 'assess').mockResolvedValue(createMockAssessment(decision, confidence));
}

// ============================================================================
// Tests
// ============================================================================

describe('DualTriggerACManager - Enhanced Statistics', () => {

  // ==========================================================================
  // 1. Stats are initialized with correct default values
  // ==========================================================================
  describe('Stats initialization', () => {
    it('should initialize all stats fields to zero/empty defaults', () => {
      const { manager } = createManager();
      const access = manager as unknown as DualTriggerACManagerTestAccess;

      expect(access.stats.totalEventsProcessed).toBe(0);
      expect(access.stats.filteredByLayer1).toBe(0);
      expect(access.stats.passedToLayer2).toBe(0);
      expect(access.stats.acDecisionMade).toBe(0);
      expect(access.stats.acInitiated).toBe(0);
      expect(access.stats.handledIndependently).toBe(0);
      expect(access.stats.deferred).toBe(0);

      // Enhanced stats
      expect(access.stats.layer2DecisionDistribution).toBeDefined();
      expect(access.stats.layer2DecisionDistribution.initiate_ac).toBe(0);
      expect(access.stats.layer2DecisionDistribution.handle_independently).toBe(0);
      expect(access.stats.layer2DecisionDistribution.defer).toBe(0);
      expect(access.stats.layer2DecisionDistribution.ignore).toBe(0);
      expect(access.stats.totalAssessmentTimeMs).toBe(0);
      expect(access.stats.assessmentCount).toBe(0);
      expect(access.stats.totalConfidence).toBe(0);
      expect(access.stats.confidenceCount).toBe(0);
    });
  });

  // ==========================================================================
  // 2. layer2DecisionDistribution tracks each decision type
  // ==========================================================================
  describe('layer2DecisionDistribution tracking', () => {
    it('should track handle_independently decisions', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'handle_independently', 0.7);

      const event = createEvent();
      await manager.processEvent(event);

      const stats = manager.getStats();
      expect(stats.layer2DecisionDistribution.handle_independently).toBe(1);
    });

    it('should track defer decisions', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'defer', 0.4);

      const event = createEvent();
      await manager.processEvent(event);

      const stats = manager.getStats();
      expect(stats.layer2DecisionDistribution.defer).toBe(1);
    });

    it('should track ignore decisions', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'ignore', 0.3);

      const event = createEvent();
      await manager.processEvent(event);

      const stats = manager.getStats();
      expect(stats.layer2DecisionDistribution.ignore).toBe(1);
    });

    it('should track initiate_ac decisions', async () => {
      const { manager, mockEnvironment } = createManager();
      mockAssessorDecision(manager, 'initiate_ac', 0.9);

      // Mock discoverAgents to prevent error during AC initiation
      (mockEnvironment as any).discoverAgents = vi.fn().mockResolvedValue([]);

      const event = createEvent();
      await manager.processEvent(event);

      const stats = manager.getStats();
      expect(stats.layer2DecisionDistribution.initiate_ac).toBe(1);
    });

    it('should track multiple decisions of different types', async () => {
      const { manager } = createManager();

      // Process one handle_independently
      mockAssessorDecision(manager, 'handle_independently', 0.7);
      await manager.processEvent(createEvent());

      // Process one defer
      mockAssessorDecision(manager, 'defer', 0.4);
      await manager.processEvent(createEvent());

      // Process another handle_independently
      mockAssessorDecision(manager, 'handle_independently', 0.8);
      await manager.processEvent(createEvent());

      const stats = manager.getStats();
      expect(stats.layer2DecisionDistribution.handle_independently).toBe(2);
      expect(stats.layer2DecisionDistribution.defer).toBe(1);
    });
  });

  // ==========================================================================
  // 3. avgAssessmentTimeMs is computed correctly
  // ==========================================================================
  describe('avgAssessmentTimeMs computation', () => {
    it('should track assessment time and compute average', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'handle_independently', 0.7);

      // Process multiple events
      await manager.processEvent(createEvent());
      await manager.processEvent(createEvent());

      const stats = manager.getStats();
      // Assessment count should be 2
      expect(stats.assessmentCount).toBe(2);
      // avgAssessmentTimeMs should be a non-negative number
      expect(stats.avgAssessmentTimeMs).toBeGreaterThanOrEqual(0);
      // Should be totalAssessmentTimeMs / assessmentCount
      expect(stats.avgAssessmentTimeMs).toBe(stats.totalAssessmentTimeMs / stats.assessmentCount);
    });
  });

  // ==========================================================================
  // 4. avgConfidence is computed correctly
  // ==========================================================================
  describe('avgConfidence computation', () => {
    it('should track confidence and compute average', async () => {
      const { manager } = createManager();

      // Process with confidence 0.8
      mockAssessorDecision(manager, 'handle_independently', 0.8);
      await manager.processEvent(createEvent());

      // Process with confidence 0.6
      mockAssessorDecision(manager, 'handle_independently', 0.6);
      await manager.processEvent(createEvent());

      const stats = manager.getStats();
      expect(stats.confidenceCount).toBe(2);
      // Average of 0.8 and 0.6 = 0.7
      expect(stats.avgConfidence).toBeCloseTo(0.7, 5);
    });

    it('should handle single confidence value', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'defer', 0.42);

      await manager.processEvent(createEvent());

      const stats = manager.getStats();
      expect(stats.confidenceCount).toBe(1);
      expect(stats.avgConfidence).toBeCloseTo(0.42, 5);
    });
  });

  // ==========================================================================
  // 5. layer1FilterRate is computed correctly
  // ==========================================================================
  describe('layer1FilterRate computation', () => {
    it('should compute filter rate as filteredByLayer1 / totalEventsProcessed', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'handle_independently', 0.7);

      // Process 3 events
      await manager.processEvent(createEvent());
      await manager.processEvent(createEvent());
      await manager.processEvent(createEvent());

      const stats = manager.getStats();
      expect(stats.totalEventsProcessed).toBe(3);
      // layer1FilterRate should be computed
      expect(typeof stats.layer1FilterRate).toBe('number');
      expect(stats.layer1FilterRate).toBeGreaterThanOrEqual(0);
      expect(stats.layer1FilterRate).toBeLessThanOrEqual(1);
    });
  });

  // ==========================================================================
  // 6. Division by zero is handled
  // ==========================================================================
  describe('Division by zero handling', () => {
    it('should return 0 for layer1FilterRate when no events processed', () => {
      const { manager } = createManager();
      const stats = manager.getStats();

      expect(stats.totalEventsProcessed).toBe(0);
      expect(stats.layer1FilterRate).toBe(0);
    });

    it('should return 0 for avgAssessmentTimeMs when no assessments made', () => {
      const { manager } = createManager();
      const stats = manager.getStats();

      expect(stats.assessmentCount).toBe(0);
      expect(stats.avgAssessmentTimeMs).toBe(0);
    });

    it('should return 0 for avgConfidence when no confidence values tracked', () => {
      const { manager } = createManager();
      const stats = manager.getStats();

      expect(stats.confidenceCount).toBe(0);
      expect(stats.avgConfidence).toBe(0);
    });
  });

  // ==========================================================================
  // 7. getStats() returns all computed metrics alongside raw stats
  // ==========================================================================
  describe('getStats() comprehensive return', () => {
    it('should return all raw stats and computed metrics', async () => {
      const { manager } = createManager();
      mockAssessorDecision(manager, 'handle_independently', 0.75);

      await manager.processEvent(createEvent());

      const stats = manager.getStats();

      // Raw stats
      expect(stats.totalEventsProcessed).toBe(1);
      expect(stats.filteredByLayer1).toBeDefined();
      expect(stats.passedToLayer2).toBeDefined();
      expect(stats.acDecisionMade).toBeDefined();
      expect(stats.acInitiated).toBeDefined();
      expect(stats.handledIndependently).toBeDefined();
      expect(stats.deferred).toBeDefined();

      // Enhanced raw stats
      expect(stats.layer2DecisionDistribution).toBeDefined();
      expect(stats.totalAssessmentTimeMs).toBeDefined();
      expect(stats.assessmentCount).toBeDefined();
      expect(stats.totalConfidence).toBeDefined();
      expect(stats.confidenceCount).toBeDefined();

      // Computed metrics
      expect(stats.layer1FilterRate).toBeDefined();
      expect(stats.avgAssessmentTimeMs).toBeDefined();
      expect(stats.avgConfidence).toBeDefined();

      // Layer stats
      expect(stats.layer1Stats).toBeDefined();
      expect(stats.layer2Stats).toBeDefined();
    });

    it('should return consistent values between raw and computed metrics', async () => {
      const { manager } = createManager();

      // Process event with confidence 0.9
      mockAssessorDecision(manager, 'handle_independently', 0.9);
      await manager.processEvent(createEvent());

      const stats = manager.getStats();

      // Computed avgConfidence should equal totalConfidence / confidenceCount
      if (stats.confidenceCount > 0) {
        expect(stats.avgConfidence).toBeCloseTo(
          stats.totalConfidence / stats.confidenceCount,
          5
        );
      }

      // Computed avgAssessmentTimeMs should equal totalAssessmentTimeMs / assessmentCount
      if (stats.assessmentCount > 0) {
        expect(stats.avgAssessmentTimeMs).toBeCloseTo(
          stats.totalAssessmentTimeMs / stats.assessmentCount,
          5
        );
      }

      // Computed layer1FilterRate should equal filteredByLayer1 / totalEventsProcessed
      if (stats.totalEventsProcessed > 0) {
        expect(stats.layer1FilterRate).toBeCloseTo(
          stats.filteredByLayer1 / stats.totalEventsProcessed,
          5
        );
      }
    });
  });
});
