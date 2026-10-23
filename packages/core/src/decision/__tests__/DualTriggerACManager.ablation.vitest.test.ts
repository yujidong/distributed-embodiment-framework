/**
 * Ablation Experiment Configuration Tests for DualTriggerACManager
 *
 * These tests verify that ablation flags correctly disable specific features:
 * 1. disableSpatiotemporal: Events bypass Layer 1 and go directly to Layer 2
 * 2. disablePhysicalContext: Excludes device locations and environment parameters from context
 * 3. disableACHistory: Excludes AC history from agent context
 * 4. All flags default to false: Normal operation is preserved
 *
 * The ablation logic itself is tested through real code paths.
 * Only minimal external interfaces (EnvironmentCenter, LLM) are mocked.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DualTriggerACManager } from '../DualTriggerACManager.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '../../events/EventManager.js';
import type { AgentContext } from '../ACNecessityAssessor.js';

// ============================================================================
// Helper Types for Private Member Access
// ============================================================================

/** Interface for accessing DualTriggerACManager private members in tests */
interface DualTriggerACManagerTestAccess {
  resourceManager: ResourceManagerLike | undefined;
  serviceRegistry: ServiceRegistryLike | undefined;
  activeACs: Map<string, Record<string, unknown>>;
  acHistory: Array<{
    collaborationId: string;
    partners: string[];
    outcome: 'success' | 'partial' | 'failure';
    goalsTotal: number;
    goalsAchieved: number;
    completedAt: Date;
  }>;
  buildAgentContext: () => Promise<AgentContext>;
  config: {
    disableSpatiotemporal?: boolean;
    disablePhysicalContext?: boolean;
    disableACHistory?: boolean;
  };
}

/** Minimal ResourceManager interface used by DualTriggerACManager */
interface ResourceManagerLike {
  getResource: Mock<(deviceId: string) => DeviceResourceLike | null>;
}

/** Device resource returned by ResourceManager */
interface DeviceResourceLike {
  getState: () => Record<string, unknown>;
  getLocation: () => Record<string, unknown>;
  isAvailable: () => boolean;
}

/** Minimal ServiceRegistry interface used by DualTriggerACManager */
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
// Helper: Create a standard non-urgent event
// ============================================================================

function createNonUrgentEvent(): SystemEvent {
  return {
    id: 'event-1',
    type: 'device.state.update',
    source: 'device-1',
    timestamp: new Date(),
    payload: {
      temperature: 22,
      trend: 'stable',
    },
    priority: 'normal',
  };
}

// ============================================================================
// Helper: Create a DualTriggerACManager with given config
// ============================================================================

function createManager(
  configOverrides: Record<string, unknown> = {}
): {
  manager: DualTriggerACManager;
  mockLLMClient: LLMClient;
  mockEnvironment: EnvironmentCenter;
  mockResourceManager: ResourceManagerLike;
  mockServiceRegistry: ServiceRegistryLike;
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
    getParameters: vi.fn().mockReturnValue({
      outdoorTemperature: 30,
      humidity: 60,
    }),
    eventManager: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      publish: vi.fn(),
    },
    services: new Map(),
  } as unknown as EnvironmentCenter;

  const onACInitiation = vi.fn();

  const manager = new DualTriggerACManager(
    'test-agent-1',
    'TestAgent',
    ['temperature-control', 'monitoring'],
    mockLLMClient,
    mockEnvironment,
    onACInitiation,
    {
      enableLayer1: true,
      enableLayer2: true,
      autoInitiateAC: false,
      ...configOverrides,
    }
  );

  // Inject mock dependencies
  const access = manager as unknown as DualTriggerACManagerTestAccess;
  access.resourceManager = mockResourceManager;
  access.serviceRegistry = mockServiceRegistry;

  return { manager, mockLLMClient, mockEnvironment, mockResourceManager, mockServiceRegistry, onACInitiation };
}

// ============================================================================
// Tests
// ============================================================================

describe('DualTriggerACManager - Ablation Experiment Flags', () => {

  // ==========================================================================
  // 1. disableSpatiotemporal flag
  // ==========================================================================
  describe('disableSpatiotemporal flag', () => {
    it('should bypass Layer 1 and go directly to Layer 2 when flag is true', async () => {
      // Arrange: Manager with Layer 1 enabled but spatiotemporal disabled
      const { manager, mockLLMClient } = createManager({
        enableLayer1: true,
        enableLayer2: true,
        disableSpatiotemporal: true,
      });

      // Mock the LLM quickChat to return a valid assessment response
      // The assessor uses quickChat, not chat
      (mockLLMClient as unknown as { quickChat: Mock }).quickChat.mockResolvedValue(
        JSON.stringify({
          needsCollaboration: false,
          reasoning: 'Temperature is normal',
          urgency: 'low',
          suggestedPartnerTypes: [],
          requiredCapabilities: [],
          confidence: 0.9,
          estimatedDuration: 0,
          potentialRisks: [],
        })
      );

      const event = createNonUrgentEvent();

      // Act: Process a non-urgent event
      const result = await manager.processEvent(event);

      // Assert: Event should NOT be filtered through Layer 1.
      // When disableSpatiotemporal is true, it goes directly to Layer 2
      // which means the assessor is invoked.
      // The result should NOT be 'filtered_layer1' (which is Layer 1's pass-through).
      // Instead it should go through Layer 2: 'handled_independently', 'deferred', or 'ac_initiated'
      expect(result.path).not.toBe('filtered_layer1');
      expect(result.stats.layerUsed).toBe(2);
    });

    it('should use Layer 1 normally when flag is false or not set', async () => {
      // Arrange: Manager with Layer 1 enabled, no ablation flag
      const { manager } = createManager({
        enableLayer1: true,
        enableLayer2: true,
      });

      const event = createNonUrgentEvent();

      // Act
      const result = await manager.processEvent(event);

      // Assert: Non-urgent events go through Layer 1 (returns filtered_layer1)
      expect(result.path).toBe('filtered_layer1');
      expect(result.stats.layerUsed).toBe(1);
    });
  });

  // ==========================================================================
  // 2. disablePhysicalContext flag
  // ==========================================================================
  describe('disablePhysicalContext flag', () => {
    it('should exclude location from resources when flag is true', async () => {
      // Arrange
      const { manager, mockResourceManager } = createManager({
        enableLayer1: false,
        enableLayer2: true,
        disablePhysicalContext: true,
      });

      // Set up agent devices with resource manager
      manager.setAgentDevices([
        { deviceId: 'device-1', type: 'sensor', capabilities: ['monitoring'] },
      ]);

      mockResourceManager.getResource.mockReturnValue({
        getState: () => ({ temperature: 25 }),
        getLocation: () => ({ x: 10, y: 20, z: 0 }),
        isAvailable: () => true,
      });

      // Act
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      const context = await access.buildAgentContext();

      // Assert: Location should be undefined when physical context is disabled
      expect(context.availableResources[0].location).toBeUndefined();
    });

    it('should exclude environment parameters when flag is true', async () => {
      // Arrange
      const { manager, mockEnvironment } = createManager({
        enableLayer1: false,
        enableLayer2: true,
        disablePhysicalContext: true,
      });

      manager.setAgentDevices([]);

      // Environment has parameters available
      (mockEnvironment as unknown as Record<string, Mock>).getParameters.mockReturnValue({
        outdoorTemperature: 35,
        humidity: 80,
      });

      // Act
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      const context = await access.buildAgentContext();

      // Assert: environmentState should be empty when physical context is disabled
      expect(context.environmentState).toEqual({});
    });

    it('should exclude location from environment device fallback when flag is true', async () => {
      // Arrange
      const { manager, mockEnvironment } = createManager({
        enableLayer1: false,
        enableLayer2: true,
        disablePhysicalContext: true,
      });

      manager.setAgentDevices([]);

      (mockEnvironment as unknown as Record<string, Mock>).listDevices.mockReturnValue([
        {
          id: 'env-device-1',
          type: 'sensor',
          capabilities: ['monitoring'],
          state: { temperature: 24 },
          location: { x: 5, y: 10 },
          status: 'online',
        },
      ]);

      // Act
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      const context = await access.buildAgentContext();

      // Assert: Location should be undefined even from environment devices
      expect(context.availableResources[0].location).toBeUndefined();
    });

    it('should include location and environment parameters when flag is false', async () => {
      // Arrange: Normal operation (flag not set)
      const { manager, mockResourceManager } = createManager({
        enableLayer1: false,
        enableLayer2: true,
      });

      manager.setAgentDevices([
        { deviceId: 'device-1', type: 'sensor', capabilities: ['monitoring'] },
      ]);

      mockResourceManager.getResource.mockReturnValue({
        getState: () => ({ temperature: 25 }),
        getLocation: () => ({ x: 10, y: 20, z: 0 }),
        isAvailable: () => true,
      });

      // Act
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      const context = await access.buildAgentContext();

      // Assert: Location should be present in normal operation
      expect(context.availableResources[0].location).toBeDefined();
      expect(context.availableResources[0].location.x).toBe(10);
    });
  });

  // ==========================================================================
  // 3. disableACHistory flag
  // ==========================================================================
  describe('disableACHistory flag', () => {
    it('should return empty acHistory when flag is true', async () => {
      // Arrange
      const { manager } = createManager({
        enableLayer1: false,
        enableLayer2: true,
        disableACHistory: true,
      });

      manager.setAgentDevices([]);

      // Inject some AC history
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      access.acHistory.push({
        collaborationId: 'ac-1',
        partners: ['agent-2'],
        outcome: 'success',
        goalsTotal: 3,
        goalsAchieved: 3,
        completedAt: new Date(),
      });

      // Act
      const context = await access.buildAgentContext();

      // Assert: acHistory should be empty despite having history
      expect(context.acHistory).toEqual([]);
    });

    it('should return real acHistory when flag is false', async () => {
      // Arrange
      const { manager } = createManager({
        enableLayer1: false,
        enableLayer2: true,
      });

      manager.setAgentDevices([]);

      // Inject some AC history
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      access.acHistory.push({
        collaborationId: 'ac-1',
        partners: ['agent-2'],
        outcome: 'success',
        goalsTotal: 3,
        goalsAchieved: 3,
        completedAt: new Date(),
      });

      // Act
      const context = await access.buildAgentContext();

      // Assert: acHistory should contain the entry
      expect(context.acHistory).toHaveLength(1);
      expect(context.acHistory[0].collaborationId).toBe('ac-1');
    });
  });

  // ==========================================================================
  // 4. All flags default to false - Normal operation preserved
  // ==========================================================================
  describe('default behavior (all flags off)', () => {
    it('should use Layer 1 normally when no ablation flags are set', async () => {
      // Arrange: No ablation flags
      const { manager } = createManager({
        enableLayer1: true,
        enableLayer2: true,
      });

      const event = createNonUrgentEvent();

      // Act
      const result = await manager.processEvent(event);

      // Assert: Normal Layer 1 processing
      expect(result.path).toBe('filtered_layer1');
    });

    it('should include all context when no ablation flags are set', async () => {
      // Arrange: No ablation flags
      const { manager, mockResourceManager, mockEnvironment } = createManager({
        enableLayer1: false,
        enableLayer2: true,
      });

      manager.setAgentDevices([
        { deviceId: 'device-1', type: 'sensor', capabilities: ['monitoring'] },
      ]);

      mockResourceManager.getResource.mockReturnValue({
        getState: () => ({ temperature: 25 }),
        getLocation: () => ({ x: 10, y: 20, z: 0 }),
        isAvailable: () => true,
      });

      (mockEnvironment as unknown as Record<string, Mock>).getParameters.mockReturnValue({
        outdoorTemperature: 30,
        humidity: 60,
      });

      // Inject history
      const access = manager as unknown as DualTriggerACManagerTestAccess;
      access.acHistory.push({
        collaborationId: 'ac-1',
        partners: ['agent-2'],
        outcome: 'success',
        goalsTotal: 2,
        goalsAchieved: 2,
        completedAt: new Date(),
      });

      // Act
      const context = await access.buildAgentContext();

      // Assert: All context should be present
      expect(context.availableResources[0].location).toBeDefined();
      expect(context.environmentState.outdoorTemperature).toBe(30);
      expect(context.acHistory).toHaveLength(1);
    });

    it('should have undefined ablation flags in config when not set', () => {
      // Arrange & Act
      const { manager } = createManager({
        enableLayer1: true,
        enableLayer2: true,
      });

      const access = manager as unknown as DualTriggerACManagerTestAccess;

      // Assert: Ablation flags should be undefined (falsy)
      expect(access.config.disableSpatiotemporal).toBeFalsy();
      expect(access.config.disablePhysicalContext).toBeFalsy();
      expect(access.config.disableACHistory).toBeFalsy();
    });
  });
});
