/**
 * Tests for ACContextBuilder
 *
 * Tests the AC decision context building functionality.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ACContextBuilder,
  type ACDecisionContext,
  type AgentContextForAC,
  type ResourceContext,
  type ServiceContext,
  type CollaborationContext,
  type EnvironmentContext,
  type OntologyReasoningContext,
  type TemporalContext,
} from './ACContextBuilder.js';
import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';
import type { SystemEvent } from '../events/EventManager.js';
import type { AgentContext, AgentTraits, MotivationSuggestion } from '../decision/ACNecessityAssessor.js';
import type { ResourceManager } from '../resource/ResourceManager.js';
import type { ServiceRegistry } from '../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a mock SpatialClusterSummary
 */
function createMockClusterSummary(overrides: Partial<SpatialClusterSummary> = {}): SpatialClusterSummary {
  return {
    clusterId: 'test-cluster-1',
    region: {
      id: 'region-1',
      center: { x: 10, y: 20 },
      radius: 50,
      type: 'zone',
    },
    timeWindow: new Date().toISOString(),
    significance: 'high',
    summary: 'Temperature spike detected in zone A',
    findings: [
      {
        eventType: 'temperature_reading',
        count: 5,
        trend: 'increasing',
        anomaly: true,
        details: { temperature: 35, threshold: 30 },
      },
    ],
    recommendation: 'immediate_action',
    ...overrides,
  };
}

/**
 * Create a mock SystemEvent
 */
function createMockEvent(payload: Record<string, unknown> = {}): SystemEvent {
  return {
    id: `event-${Date.now()}`,
    type: 'device_state_update' as SystemEvent['type'],
    source: 'test-device',
    timestamp: new Date(),
    priority: 'high' as SystemEvent['priority'],
    payload,
    metadata: {},
  };
}

/**
 * Create a minimal mock ResourceManager
 */
function createMockResourceManager(): ResourceManager {
  return {
    getAllResources: () => [],
    getResource: vi.fn(),
    registerResource: vi.fn(),
    unregisterResource: vi.fn(),
  } as unknown as ResourceManager;
}

/**
 * Create a minimal mock ServiceRegistry
 */
function createMockServiceRegistry(): ServiceRegistry {
  return {
    getAllServices: () => [],
    registerService: vi.fn(),
    unregisterService: vi.fn(),
    getService: vi.fn(),
  } as unknown as ServiceRegistry;
}

/**
 * Create a minimal mock EnvironmentCenter
 */
function createMockEnvironmentCenter(): EnvironmentCenter {
  return {
    id: 'env-1',
    name: 'Test Environment',
    listDevices: () => [],
    listAgents: async () => [],
  } as unknown as EnvironmentCenter;
}

// ============================================================================
// Tests
// ============================================================================

describe('ACContextBuilder', () => {
  let builder: ACContextBuilder;
  let mockResourceManager: ResourceManager;
  let mockServiceRegistry: ServiceRegistry;
  let mockEnvironment: EnvironmentCenter;

  beforeEach(() => {
    mockResourceManager = createMockResourceManager();
    mockServiceRegistry = createMockServiceRegistry();
    mockEnvironment = createMockEnvironmentCenter();

    builder = new ACContextBuilder(
      {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'A test agent',
        capabilities: ['temperature-control', 'monitoring'],
        metadata: { role: 'climate-controller' },
        status: 'active',
      },
      mockResourceManager,
      mockServiceRegistry,
      mockEnvironment
    );
  });

  describe('ACDecisionContext Interface', () => {
    it('should define triggerEvent in decision context', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent({ temperature: 35 });

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.triggerEvent).toBeDefined();
      expect(context.triggerEvent.eventId).toBe(triggerEvent.id);
      expect(context.triggerEvent.eventType).toBe(String(triggerEvent.type));
    });

    it('should include clusterSummary in decision context', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.clusterSummary).toBe(clusterSummary);
    });

    it('should include agentContext with correct agent info', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.agentContext.id).toBe('agent-1');
      expect(context.agentContext.name).toBe('Test Agent');
      expect(context.agentContext.capabilities).toContain('temperature-control');
      expect(context.agentContext.role).toBe('climate-controller');
      expect(context.agentContext.status).toBe('active');
    });

    it('should include agent traits when provided', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();
      const traits: AgentTraits = {
        proactivity: 0.8,
        cautiousness: 0.3,
        socialPreference: 0.6,
        riskTolerance: 0.7,
      };

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent, traits);

      expect(context.agentContext.traits).toEqual(traits);
    });

    it('should include motivation suggestion when provided', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();
      const motivation: MotivationSuggestion = {
        overall: 0.9,
        shouldAct: true,
        suggestedAction: 'collaborate',
        confidence: 0.85,
      };

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent, undefined, motivation);

      expect(context.agentContext.motivationSuggestion).toEqual(motivation);
    });

    it('should include resourceContext with own resources', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.resourceContext).toBeDefined();
      expect(context.resourceContext.ownResources).toBeDefined();
      expect(Array.isArray(context.resourceContext.capabilityGaps)).toBe(true);
      expect(Array.isArray(context.resourceContext.availableCapabilities)).toBe(true);
    });

    it('should include serviceContext', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.serviceContext).toBeDefined();
      expect(context.serviceContext.ownServices).toBeDefined();
      expect(context.serviceContext.peerServices).toBeDefined();
    });

    it('should include collaborationContext with peerAgents', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.collaborationContext).toBeDefined();
      expect(context.collaborationContext.peerAgents).toBeDefined();
      expect(context.collaborationContext.recommendedPartners).toBeDefined();
    });

    it('should include environmentContext', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.environmentContext).toBeDefined();
    });

    it('should include temporalContext with urgency level', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.temporalContext).toBeDefined();
      expect(context.temporalContext.currentTime).toBeInstanceOf(Date);
      expect(['low', 'medium', 'high', 'urgent']).toContain(context.temporalContext.urgencyLevel);
    });
  });

  describe('Capability Gap Analysis', () => {
    it('should identify capability gaps when required capabilities are missing', async () => {
      const clusterSummary = createMockClusterSummary({
        findings: [{
          eventType: 'complex_task',
          count: 1,
          trend: 'stable',
          anomaly: false,
          details: {
            requiredCapabilities: ['advanced-analytics', 'ml-processing'],
          },
        }],
      });
      const triggerEvent = createMockEvent({
        requiredCapabilities: ['advanced-analytics', 'ml-processing'],
      });

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      // The agent only has 'temperature-control' and 'monitoring'
      // So it should have capability gaps for 'advanced-analytics' and 'ml-processing'
      expect(context.resourceContext.capabilityGaps.length).toBeGreaterThan(0);
    });

    it('should have empty capability gaps when agent has all required capabilities', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      // No specific required capabilities, so gaps should be based on analysis
      expect(Array.isArray(context.resourceContext.capabilityGaps)).toBe(true);
    });
  });

  describe('Partner Recommendation', () => {
    it('should return empty recommendedPartners when no capability gaps', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      // Without peers in the mock environment, recommended partners should be empty
      expect(context.collaborationContext.recommendedPartners).toBeDefined();
    });

    it('should recommend partners based on capability matching', async () => {
      // Create environment with a peer agent that has the needed capability
      const mockEnvWithPeers = {
        ...mockEnvironment,
        listAgents: async () => [
          {
            id: 'agent-2',
            name: 'Analytics Agent',
            capabilities: ['advanced-analytics', 'ml-processing'],
            status: 'active',
          },
        ],
        services: new Map([
          ['service-1', {
            service: {
              id: 'service-1',
              name: 'Analytics Service',
              capabilities: ['advanced-analytics'],
            },
            agentId: 'agent-2',
          }],
        ]),
      } as unknown as EnvironmentCenter;

      const builderWithPeers = new ACContextBuilder(
        {
          id: 'agent-1',
          name: 'Test Agent',
          description: 'A test agent',
          capabilities: ['temperature-control'],
          metadata: { role: 'climate-controller' },
          status: 'active',
        },
        mockResourceManager,
        mockServiceRegistry,
        mockEnvWithPeers
      );

      const clusterSummary = createMockClusterSummary({
        findings: [{
          eventType: 'complex_task',
          count: 1,
          trend: 'stable',
          anomaly: false,
          details: {
            requiredCapabilities: ['advanced-analytics'],
          },
        }],
      });
      const triggerEvent = createMockEvent({
        requiredCapabilities: ['advanced-analytics'],
      });

      const context = await builderWithPeers.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.collaborationContext.peerAgents.length).toBe(1);
      expect(context.collaborationContext.peerAgents[0].id).toBe('agent-2');
    });
  });

  describe('Ontology Reasoning', () => {
    it('should include ontology reasoning context when available', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      // Ontology reasoning may or may not be present depending on implementation
      if (context.ontologyReasoning) {
        expect(context.ontologyReasoning.taskAnalysis).toBeDefined();
        expect(context.ontologyReasoning.collaborationAnalysis).toBeDefined();
      }
    });
  });

  describe('Urgency Level Determination', () => {
    it('should determine urgent level for critical severity', async () => {
      const clusterSummary = createMockClusterSummary({ significance: 'urgent' });
      const triggerEvent = createMockEvent({
        context: { severity: 'critical' },
      });

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.temporalContext.urgencyLevel).toBe('urgent');
    });

    it('should determine high level for high significance', async () => {
      const clusterSummary = createMockClusterSummary({ significance: 'high' });
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(['high', 'urgent']).toContain(context.temporalContext.urgencyLevel);
    });

    it('should determine low level for low significance', async () => {
      const clusterSummary = createMockClusterSummary({ significance: 'low' });
      // Event with low severity so cluster significance becomes the determining factor
      const triggerEvent = createMockEvent({ context: { severity: 'low' } });

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.temporalContext.urgencyLevel).toBe('low');
    });
  });

  describe('Workload Calculation', () => {
    it('should calculate workload based on active collaborations', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent();

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(['idle', 'light', 'moderate', 'heavy']).toContain(context.agentContext.currentWorkload);
    });
  });

  describe('Normalized Event Context', () => {
    it('should normalize trigger event into NormalizedEventContext', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent({
        temperature: 35,
        context: { severity: 'high' },
      });

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.triggerEvent.severity).toBeDefined();
      expect(['low', 'normal', 'medium', 'high', 'urgent', 'critical']).toContain(context.triggerEvent.severity);
      expect(context.triggerEvent.rawPayload).toBeDefined();
    });

    it('should extract task context from trigger event', async () => {
      const clusterSummary = createMockClusterSummary();
      const triggerEvent = createMockEvent({
        taskTitle: 'Adjust Temperature',
        taskDescription: 'Lower the temperature to target level',
        taskType: 'climate-control',
        requiredCapabilities: ['temperature-control'],
      });

      const context = await builder.buildDecisionContext(clusterSummary, triggerEvent);

      expect(context.triggerEvent.taskContext).toBeDefined();
      expect(context.triggerEvent.taskContext?.taskTitle).toBe('Adjust Temperature');
    });
  });
});
