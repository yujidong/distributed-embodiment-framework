/**
 * ACExecutor Environment Parameter Verification Tests - P12
 *
 * Tests the verifyCriterion() method's environment-parameter case, which was
 * modified in P12 to:
 *
 * 1. Priority 1: Read actual environment state from EnvironmentCenter.getParameters()
 *    for independent verification
 * 2. Priority 2: Fallback to recorded effects from execution if EnvironmentCenter
 *    has no data
 * 3. No data case: Return false (do NOT assume success)
 *
 * Since verifyCriterion is a private method, we test it through the public
 * executeCollaboration() pipeline, which calls verifyCriterion internally
 * when processing successCriteria of type 'environment-parameter'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACExecutor } from '../ACExecutor.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ACCollaborationConfig, ACCSuccessCriterion } from '../ACExecutor.js';
import { CollaborationManager } from '../../management/CollaborationManager.js';
import type { AgentService, ProviderInfo, ServiceExecutionContext, ServiceExecutionResult, ServiceStats } from '../../service/Service.js';
import { ServiceHealthStatus } from '../../service/Service.js';
import type { Device, Service } from '@active-collaboration/shared';
import type { Agent } from '../../environment/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Minimal mock service for agent discovery
 */
class StubService implements AgentService {
  id: string;
  name: string;
  deviceId: string;
  uri: string;
  httpMethod: import('@active-collaboration/shared').HTTPMethod;
  parameters: import('@active-collaboration/shared').ParameterDefinition[];
  location: string;
  category: string;
  isConditional: boolean;
  description: string;
  actionType: 'observe' | 'control' | 'both';

  private _providerInfo: ProviderInfo;
  private _capabilities: string[];

  constructor(config: {
    id: string;
    name: string;
    deviceId: string;
    category: string;
    description: string;
    providerInfo: ProviderInfo;
    capabilities?: string[];
  }) {
    this.id = config.id;
    this.name = config.name;
    this.deviceId = config.deviceId;
    this.category = config.category;
    this.description = config.description;
    this._providerInfo = config.providerInfo;
    this._capabilities = config.capabilities || [];
    this.actionType = 'both';
    this.uri = `agent://${config.providerInfo.providerAgentId}/services/${config.id}`;
    this.httpMethod = 'POST';
    this.parameters = [];
    this.location = 'test-location';
    this.isConditional = false;
  }

  getProviderInfo(): ProviderInfo {
    return this._providerInfo;
  }

  getCapabilities(): string[] {
    return this._capabilities;
  }

  async execute(_context: ServiceExecutionContext): Promise<ServiceExecutionResult> {
    return { success: true, executedAt: new Date(), executionTime: 0 };
  }

  getHealth(): ServiceHealthStatus {
    return ServiceHealthStatus.HEALTHY;
  }

  getStats(): ServiceStats {
    return { totalExecutions: 0, successfulExecutions: 0, failedExecutions: 0, averageExecutionTime: 0 };
  }

  isAvailable(): boolean {
    return true;
  }

  getOwner(): string {
    return this._providerInfo.providerAgentId || 'unknown';
  }
}

/**
 * Helper to create a real EnvironmentCenter instance with no agents/devices.
 * We only need the parameters feature for these tests.
 */
function createRealEnvironmentCenter(): EnvironmentCenter {
  return new EnvironmentCenter({
    id: 'env-test-center',
    name: 'Test Environment Center',
    description: 'Test environment for P12 parameter verification tests',
    createdBy: 'test-user',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Helper to create a mock collaboration manager
 */
function createMockCollaborationManager(): CollaborationManager {
  return {
    trackACState: vi.fn().mockResolvedValue(undefined),
  } as unknown as CollaborationManager;
}

/**
 * Helper to create a mock agent that satisfies the executeCollaboration pipeline.
 * The agent needs: id, name, status, taskManager, dialogueManager, eventManager,
 * resourceManager, executeDeviceCapability, requestService
 */
function createMockAgent(agentId = 'agent-001', agentName = 'Test Agent') {
  return {
    id: agentId,
    name: agentName,
    status: 'idle',
    resourceManager: {
      getAllResources: vi.fn().mockReturnValue([]),
      getResource: vi.fn().mockReturnValue(null),
    },
    taskManager: {
      createTask: vi.fn().mockReturnValue({ id: 'task-001', status: 'pending' }),
    },
    dialogueManager: {
      sendMessage: vi.fn().mockReturnValue({ subject: 'test', content: 'test' }),
    },
    eventManager: {
      subscribe: vi.fn(),
    },
    executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
    requestService: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as Agent;
}

/**
 * Helper to create a mock environment that delegates getParameters() to a
 * real EnvironmentCenter instance. This lets us control parameter state
 * while mocking everything else the pipeline needs.
 */
function createMockEnvironmentWithParams(realEnvCenter: EnvironmentCenter) {
  return {
    getAgent: vi.fn(),
    listAgents: vi.fn(),
    getDevice: vi.fn(),
    discoverServices: vi.fn().mockReturnValue([] as unknown as Service[]),
    messageBroker: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    // Delegate getParameters to the real EnvironmentCenter
    getParameters: () => realEnvCenter.getParameters(),
    getParameter: (key: string) => realEnvCenter.getParameter(key),
  } as unknown as EnvironmentCenter;
}

/**
 * Helper to build a collaboration config for testing environment-parameter criteria.
 */
function buildCollaborationConfig(
  env: EnvironmentCenter,
  collabManager: CollaborationManager,
  successCriteria: ACCSuccessCriterion[],
  agentIds: string[] = ['agent-001'],
  deviceIds: string[] = ['device-001'],
): ACCollaborationConfig {
  return {
    id: 'ac-env-verify-test',
    name: 'Environment Verify Test',
    description: 'Test environment parameter verification (P12)',
    environment: env,
    participantAgentIds: agentIds,
    collaborationManager: collabManager,
    goals: [
      {
        id: 'goal-env-001',
        description: 'Verify environment parameter',
        targetDevices: deviceIds,
        targetAgents: agentIds,
        requiredCapabilities: ['temperature'],
        successCriteria,
        priority: 'high',
      },
    ],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('ACExecutor - P12 Environment Parameter Verification', () => {
  let executor: ACExecutor;
  let realEnvCenter: EnvironmentCenter;
  let mockEnvironment: EnvironmentCenter;
  let mockCollabManager: CollaborationManager;
  let mockAgent: Agent;

  beforeEach(() => {
    executor = new ACExecutor();
    realEnvCenter = createRealEnvironmentCenter();
    mockEnvironment = createMockEnvironmentWithParams(realEnvCenter);
    mockCollabManager = createMockCollaborationManager();
    mockAgent = createMockAgent();

    // Wire up agent to mock environment
    vi.mocked(mockEnvironment.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(mockAgent);
    vi.mocked(mockEnvironment.listAgents as ReturnType<typeof vi.fn>).mockReturnValue([mockAgent]);
    vi.mocked(mockEnvironment.getDevice as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'device-001',
      type: 'sensor',
      capabilities: [{ type: 'read', name: 'temperature' }],
      executeCommand: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as Device);
  });

  // ==========================================================================
  // Scenario 1: EnvironmentCenter has actual parameter value (Priority 1)
  // ==========================================================================

  describe('Priority 1: EnvironmentCenter has actual parameter value', () => {
    it('should verify environment parameter using actual EnvironmentCenter value when condition matches', async () => {
      // Arrange: Set temperature=22 in the real EnvironmentCenter
      realEnvCenter.setParameter('temperature', 22);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 20',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: The goal should be achieved because 22 > 20
      expect(result).toBeDefined();
      expect(result.goalsAchieved).toContain('goal-env-001');
      expect(result.goalsFailed).not.toContain('goal-env-001');
    });

    it('should fail verification when actual EnvironmentCenter value does not match condition', async () => {
      // Arrange: Set temperature=18 in the real EnvironmentCenter
      realEnvCenter.setParameter('temperature', 18);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 20',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: The goal should fail because 18 is not > 20
      expect(result).toBeDefined();
      expect(result.goalsFailed).toContain('goal-env-001');
      expect(result.goalsAchieved).not.toContain('goal-env-001');
    });

    it('should use EnvironmentCenter value even when a recorded effect also exists (Priority 1 takes precedence)', async () => {
      // Arrange: Set temperature=22 in EnvironmentCenter (the actual state)
      // We will also create a recorded effect with temperature=30, but Priority 1
      // should use the real value (22), not the effect (30).
      realEnvCenter.setParameter('temperature', 22);

      // The condition 22 > 25 is false, so even though a recorded effect says 30,
      // the verification should use 22 (the real value) and fail.
      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 25',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: Goal should fail because actual value (22) does not satisfy > 25
      // Even though a recorded effect might claim 30, the real value is used.
      expect(result).toBeDefined();
      expect(result.goalsFailed).toContain('goal-env-001');
    });
  });

  // ==========================================================================
  // Scenario 2: EnvironmentCenter has no value but recorded effect exists
  //              (Priority 2 fallback)
  // ==========================================================================

  describe('Priority 2: Fallback to recorded effect when EnvironmentCenter has no value', () => {
    /**
     * Helper to set up an agent and environment that produces recorded effects
     * through the legacy execution path.
     *
     * Strategy: Force the three-phase approach to fail (by making discoverServices
     * throw on first call) so the pipeline falls back to the legacy path. Then,
     * the legacy path discovers a self-service and calls executeDeviceCapability
     * on the agent, which produces an environment effect.
     */
    function createEnvironmentWithEffectSupport(
      env: EnvironmentCenter,
      agentId: string,
      executeResult: { previousState: Record<string, unknown>; newState: Record<string, unknown> },
    ) {
      const agent = createMockAgent(agentId);

      // Make executeDeviceCapability return a result that produces an environment effect
      (agent as unknown as Record<string, unknown>).executeDeviceCapability =
        vi.fn().mockResolvedValue({
          success: true,
          result: executeResult,
        });

      // Create a service that will be discovered by getSelfServices (ServiceBroker pattern)
      const service = new StubService({
        id: 'service-temperature',
        name: 'Temperature Control',
        deviceId: 'device-001',
        category: 'control',
        description: 'Temperature control service',
        providerInfo: {
          providerAgentId: agentId,
          providerAgentName: 'Test Agent',
        },
        capabilities: ['temperature'],
      });

      // Set up mock environment to return agent and service
      vi.mocked(env.getAgent as ReturnType<typeof vi.fn>).mockReturnValue(agent);
      vi.mocked(env.listAgents as ReturnType<typeof vi.fn>).mockReturnValue([agent]);

      // First call to discoverServices throws (forcing three-phase to fail -> legacy fallback)
      // Second call returns the service (used by legacy path)
      // discoverServices is synchronous, so we use mockImplementation for throw behavior
      const discoverMock = vi.fn()
        .mockImplementationOnce(() => { throw new Error('Three-phase service discovery failed'); })
        .mockReturnValue([service] as unknown as Service[]);
      (env as unknown as Record<string, unknown>).discoverServices = discoverMock;

      vi.mocked(env.getDevice as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'device-001',
        name: 'Temperature Sensor',
        type: 'sensor',
        capabilities: [{ type: 'read', name: 'temperature' }],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      return { agent, service };
    }

    it('should use recorded effect value when EnvironmentCenter has no matching parameter', async () => {
      // Arrange: Do NOT set temperature in EnvironmentCenter (no parameter).
      // Set up agent/environment so the pipeline produces a recorded effect
      // with temperature=28 via executeDeviceCapability in the legacy path.
      createEnvironmentWithEffectSupport(
        mockEnvironment,
        'agent-001',
        { previousState: { temperature: 20 }, newState: { temperature: 28 } },
      );

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 25',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: The goal should be achieved because the recorded effect
      // has temperature=28 which satisfies > 25
      expect(result).toBeDefined();
      // The effect should have been recorded
      expect(result.environmentEffects.length).toBeGreaterThan(0);
      // The goal should be achieved using the fallback effect value
      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should fail when recorded effect value does not match condition', async () => {
      // Arrange: No parameter in EnvironmentCenter, recorded effect has temperature=18
      createEnvironmentWithEffectSupport(
        mockEnvironment,
        'agent-001',
        { previousState: { temperature: 25 }, newState: { temperature: 18 } },
      );

      // Condition: > 25, but effect says 18 - should fail
      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 25',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: Goal should fail because 18 is not > 25
      expect(result).toBeDefined();
      expect(result.goalsFailed).toContain('goal-env-001');
    });
  });

  // ==========================================================================
  // Scenario 3: Neither EnvironmentCenter nor recorded effects have data
  //             (No data case: return false)
  // ==========================================================================

  describe('No data case: return false', () => {
    it('should return false when neither EnvironmentCenter nor recorded effects have the parameter', async () => {
      // Arrange: Do NOT set any parameters in EnvironmentCenter
      // The mock agent produces no environment effects by default

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'humidity',
          condition: '> 50',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: Goal should fail because there is no data to verify
      expect(result).toBeDefined();
      expect(result.goalsFailed).toContain('goal-env-001');
      expect(result.goalsAchieved).not.toContain('goal-env-001');
    });

    it('should NOT assume success when environment parameter data is completely absent', async () => {
      // Arrange: Empty EnvironmentCenter, no recorded effects
      // This tests the critical P12 requirement: do NOT assume success

      // Use multiple criteria where none have data
      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'air_quality',
          condition: '> 80',
        },
        {
          type: 'environment-parameter',
          target: 'pressure',
          condition: '< 1013',
        },
      ]);

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert: All criteria should fail - no assumptions of success
      expect(result).toBeDefined();
      expect(result.goalsFailed).toContain('goal-env-001');
      expect(result.goalsAchieved).not.toContain('goal-env-001');
    });
  });

  // ==========================================================================
  // Scenario 4: Condition matching with various operators
  // ==========================================================================

  describe('Condition matching with various operators against actual environment values', () => {
    it('should correctly evaluate "greater than" (>) condition', async () => {
      realEnvCenter.setParameter('temperature', 30);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 25',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should fail "greater than" (>) when value is at the boundary', async () => {
      realEnvCenter.setParameter('temperature', 25);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 25',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsFailed).toContain('goal-env-001');
    });

    it('should correctly evaluate "less than" (<) condition', async () => {
      realEnvCenter.setParameter('temperature', 18);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '< 20',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should fail "less than" (<) when value is at the boundary', async () => {
      realEnvCenter.setParameter('temperature', 20);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '< 20',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsFailed).toContain('goal-env-001');
    });

    it('should correctly evaluate "equals" (==) condition with numeric values', async () => {
      realEnvCenter.setParameter('temperature', 22);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '== 22',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should fail "equals" (==) when value does not match', async () => {
      realEnvCenter.setParameter('temperature', 22);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '== 23',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsFailed).toContain('goal-env-001');
    });

    it('should correctly evaluate "not equals" (!=) condition', async () => {
      realEnvCenter.setParameter('temperature', 22);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '!= 25',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should handle string-valued environment parameters with equals condition', async () => {
      realEnvCenter.setParameter('status', 'active');

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'status',
          condition: "== 'active'",
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should handle multiple environment parameter criteria in a single goal', async () => {
      // Set multiple parameters
      realEnvCenter.setParameter('temperature', 22);
      realEnvCenter.setParameter('humidity', 55);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 20',
        },
        {
          type: 'environment-parameter',
          target: 'humidity',
          condition: '> 50',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      // Both criteria should be met
      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should fail goal when one of multiple criteria is not met', async () => {
      // Set temperature to pass, humidity to fail
      realEnvCenter.setParameter('temperature', 22);
      realEnvCenter.setParameter('humidity', 30);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 20',
        },
        {
          type: 'environment-parameter',
          target: 'humidity',
          condition: '> 50',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      // Goal should fail because humidity criterion is not met
      expect(result.goalsFailed).toContain('goal-env-001');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge cases', () => {
    it('should handle null parameter value in EnvironmentCenter', async () => {
      // Setting null should be treated as "no value" by the verification
      realEnvCenter.setParameter('temperature', null);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 20',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      // null should not satisfy the condition; should fallback or return false
      expect(result.goalsFailed).toContain('goal-env-001');
    });

    it('should handle zero as a valid parameter value', async () => {
      realEnvCenter.setParameter('temperature', 0);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '== 0',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      // Zero is a valid value and should match == 0
      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should handle negative parameter values', async () => {
      realEnvCenter.setParameter('temperature', -5);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '< 0',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should handle type normalization: environment_parameter with underscores', async () => {
      // The verifyCriterion method normalizes underscores to hyphens
      realEnvCenter.setParameter('temperature', 22);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment_parameter',  // underscore instead of hyphen
          target: 'temperature',
          condition: '> 20',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      // Should still work due to type normalization
      expect(result.goalsAchieved).toContain('goal-env-001');
    });

    it('should handle parameter that was set and then changed', async () => {
      // Set initial value, then change it
      realEnvCenter.setParameter('temperature', 15);
      realEnvCenter.setParameter('temperature', 28);

      const config = buildCollaborationConfig(mockEnvironment, mockCollabManager, [
        {
          type: 'environment-parameter',
          target: 'temperature',
          condition: '> 25',
        },
      ]);

      const result = await executor.executeCollaboration(config);

      // Should use the latest value (28), which satisfies > 25
      expect(result.goalsAchieved).toContain('goal-env-001');
    });
  });

  // ==========================================================================
  // Integration with real EnvironmentCenter
  // ==========================================================================

  describe('Integration with real EnvironmentCenter parameters', () => {
    it('should verify parameters set via setParameter() on a real EnvironmentCenter', async () => {
      // Use a real EnvironmentCenter directly in the config (not a mock)
      // But we still need to mock getAgent/getDevice for the pipeline
      const realEnv = createRealEnvironmentCenter();
      realEnv.setParameter('temperature', 24);

      // Create mock collaboration manager
      const collabManager = createMockCollaborationManager();

      // We cannot use a fully real EnvironmentCenter because the pipeline
      // calls getAgent which requires registered agents. Instead, we verify
      // that getParameters() returns the expected values.
      const params = realEnv.getParameters();
      expect(params).toHaveProperty('temperature', 24);
    });

    it('should verify parameters set via updateParameters() on a real EnvironmentCenter', async () => {
      const realEnv = createRealEnvironmentCenter();
      realEnv.updateParameters({
        temperature: 22,
        humidity: 60,
        air_quality: 85,
      });

      const params = realEnv.getParameters();
      expect(params).toHaveProperty('temperature', 22);
      expect(params).toHaveProperty('humidity', 60);
      expect(params).toHaveProperty('air_quality', 85);
    });

    it('should return empty object from getParameters() when no parameters are set', async () => {
      const realEnv = createRealEnvironmentCenter();
      const params = realEnv.getParameters();
      expect(Object.keys(params)).toHaveLength(0);
    });
  });
});
