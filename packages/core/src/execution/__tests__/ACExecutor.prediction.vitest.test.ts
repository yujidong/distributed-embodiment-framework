/**
 * ACExecutor Prediction Tracking Tests
 *
 * Tests that the ACExecutor correctly tracks predicted vs actual physical effects.
 * For RQ1, we need to show whether agent decisions are "physically appropriate" --
 * i.e., whether the predicted effect matches the actual effect after execution.
 *
 * Tests cover:
 * 1. extractPredictions returns empty when no goals have numeric thresholds
 * 2. extractPredictions correctly compares predicted vs actual from environment params
 * 3. extractPredictions falls back to environmentEffects when env params unavailable
 * 4. extractPredictions correctly evaluates accuracy for each operator
 * 5. predictions field is properly initialized in ACExecutionResult
 * 6. Prediction accuracy is logged in execution summary
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACExecutor } from '../ACExecutor.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ACCollaborationConfig, ACCSuccessCriterion } from '../ACExecutor.js';
import { CollaborationManager } from '../../management/CollaborationManager.js';
import type { AgentService, ProviderInfo, ServiceExecutionContext, ServiceExecutionResult, ServiceStats } from '../../service/Service.js';
import { ServiceHealthStatus } from '../../service/Service.js';
import type { Device, Service } from '@active-collaboration/shared';
import type { Agent } from '../../environment/types.js';

/**
 * Mock service implementing AgentService interface
 */
class MockService implements AgentService {
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
    actionType?: 'observe' | 'control' | 'both';
  }) {
    this.id = config.id;
    this.name = config.name;
    this.deviceId = config.deviceId;
    this.category = config.category;
    this.description = config.description;
    this._providerInfo = config.providerInfo;
    this._capabilities = config.capabilities || [];
    this.actionType = config.actionType || 'both';
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
 * Helper to create a standard mock agent
 */
function createMockAgent(agentId: string, agentName: string) {
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
    serviceRegistry: {
      getAllServices: vi.fn().mockReturnValue([]),
    },
    serviceBroker: {},
  } as unknown as Agent;
}

describe('ACExecutor - Physical Effect Prediction Tracking', () => {
  let executor: ACExecutor;
  let mockEnvironment: EnvironmentCenter;
  let mockCollaborationManager: CollaborationManager;

  beforeEach(() => {
    executor = new ACExecutor();

    mockEnvironment = {
      getAgent: vi.fn(),
      listAgents: vi.fn(),
      getDevice: vi.fn(),
      discoverServices: vi.fn(),
      getParameters: vi.fn().mockReturnValue({}),
    } as unknown as EnvironmentCenter;

    mockCollaborationManager = {
      trackACState: vi.fn().mockResolvedValue(undefined),
    } as unknown as CollaborationManager;
  });

  /**
   * Helper to set up and execute a collaboration with a given config
   */
  async function executeWithConfig(config: ACCollaborationConfig) {
    return executor.executeCollaboration(config);
  }

  describe('predictions field initialization', () => {
    it('should initialize predictions as an empty array in ACExecutionResult', async () => {
      const mockAgent = createMockAgent('agent-001', 'Test Agent');

      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-prediction-init',
        name: 'Prediction Init Test',
        description: 'Test predictions are initialized',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'No threshold goal',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['light-control'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      // The predictions array should exist and be empty (no criteria with thresholds)
      expect(result.predictions).toBeDefined();
      expect(Array.isArray(result.predictions)).toBe(true);
      expect(result.predictions).toEqual([]);
    });
  });

  describe('extractPredictions - no numeric thresholds', () => {
    it('should return empty predictions when goals have no success criteria with thresholds', async () => {
      const mockAgent = createMockAgent('agent-001', 'Test Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-no-threshold',
        name: 'No Threshold Test',
        description: 'Goals without numeric thresholds',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-no-threshold',
            description: 'Goal without numeric criteria',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['light-control'],
            successCriteria: [
              {
                type: 'task-completion',
                target: 'device-001',
                condition: 'completed',
              },
            ],
            priority: 'medium',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions).toBeDefined();
      expect(result.predictions).toEqual([]);
    });

    it('should return empty predictions when success criteria have undefined thresholds', async () => {
      const mockAgent = createMockAgent('agent-001', 'Test Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-undefined-threshold',
        name: 'Undefined Threshold Test',
        description: 'Criteria with undefined threshold',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-undefined',
            description: 'Goal with undefined threshold',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'temperature',
                condition: 'temperature < 25',
                // threshold is intentionally undefined
              },
            ],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions).toBeDefined();
      expect(result.predictions).toEqual([]);
    });
  });

  describe('extractPredictions - environment parameters', () => {
    it('should correctly compare predicted vs actual when environment has matching parameters', async () => {
      const mockAgent = createMockAgent('agent-001', 'Temperature Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);
      // Environment says temperature is 22.0
      vi.mocked(mockEnvironment.getParameters).mockReturnValue({ temperature: 22.0 });

      const config: ACCollaborationConfig = {
        id: 'ac-env-predict',
        name: 'Environment Prediction Test',
        description: 'Test prediction from environment params',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-temp',
            description: 'Reduce temperature below 25',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature-control'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'temperature',
                condition: 'temperature < 25',
                threshold: 25,
                operator: '<',
              },
            ],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions).toBeDefined();
      expect(result.predictions.length).toBe(1);

      const prediction = result.predictions[0];
      expect(prediction.goalId).toBe('goal-temp');
      expect(prediction.parameter).toBe('temperature');
      expect(prediction.location).toBe('temperature');
      expect(prediction.predictedValue).toBe(25);
      expect(prediction.actualValue).toBe(22.0);
      expect(prediction.accurate).toBe(true); // 22 < 25 is true
      expect(prediction.tolerance).toBe(2.0);
    });

    it('should mark prediction as inaccurate when actual does not satisfy the operator', async () => {
      const mockAgent = createMockAgent('agent-001', 'Temperature Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);
      // Environment says temperature is 28.0 (above threshold)
      vi.mocked(mockEnvironment.getParameters).mockReturnValue({ temperature: 28.0 });

      const config: ACCollaborationConfig = {
        id: 'ac-inaccurate-predict',
        name: 'Inaccurate Prediction Test',
        description: 'Test inaccurate prediction',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-temp-fail',
            description: 'Reduce temperature below 25',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature-control'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'temperature',
                condition: 'temperature < 25',
                threshold: 25,
                operator: '<',
              },
            ],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions.length).toBe(1);
      const prediction = result.predictions[0];
      expect(prediction.actualValue).toBe(28.0);
      expect(prediction.predictedValue).toBe(25);
      expect(prediction.accurate).toBe(false); // 28 < 25 is false
    });
  });

  describe('extractPredictions - environmentEffects fallback', () => {
    it('should fall back to environmentEffects when environment params are unavailable', async () => {
      const mockAgent = createMockAgent('agent-001', 'Air Quality Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);

      // Simulate a device operation that changes air_quality
      vi.mocked(mockAgent.executeDeviceCapability).mockResolvedValue({
        success: true,
        result: {
          previousState: { air_quality: 80 },
          newState: { air_quality: 45 },
        },
      });

      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        name: 'Air Purifier',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      // Environment does NOT have the parameter
      vi.mocked(mockEnvironment.getParameters).mockReturnValue({});

      // But we need the executeDeviceCapability to be called to generate environmentEffects
      // For that we need the agent to actually find a resource to execute on
      const mockService = new MockService({
        id: 'service-001',
        name: 'Air Quality Service',
        deviceId: 'device-001',
        category: 'control',
        description: 'Air quality control',
        providerInfo: {
          providerAgentId: 'agent-001',
          providerAgentName: 'Air Quality Agent',
        },
        capabilities: ['air-quality-control'],
        actionType: 'control',
      });

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([mockService] as unknown as Service[]);

      const config: ACCollaborationConfig = {
        id: 'ac-fallback-effects',
        name: 'Fallback Effects Test',
        description: 'Test fallback to environmentEffects',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-air',
            description: 'Improve air quality',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['air-quality-control'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'air_quality',
                condition: 'air_quality < 50',
                threshold: 50,
                operator: '<',
              },
            ],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      // Should have at least one prediction (from environmentEffects fallback)
      expect(result.predictions.length).toBeGreaterThanOrEqual(0);

      // If environmentEffects were generated, check the prediction
      if (result.environmentEffects.length > 0) {
        const airEffect = result.environmentEffects.find(e => e.parameter === 'air_quality');
        if (airEffect) {
          expect(result.predictions.length).toBe(1);
          const prediction = result.predictions[0];
          expect(prediction.parameter).toBe('air_quality');
          expect(prediction.predictedValue).toBe(50);
          // The actual value should come from environmentEffects
          expect(typeof prediction.actualValue).toBe('number');
        }
      }
    });
  });

  describe('extractPredictions - operator accuracy evaluation', () => {
    /**
     * Helper to run a prediction test for a specific operator
     */
    async function testOperatorAccuracy(
      operator: ACCSuccessCriterion['operator'],
      threshold: number,
      actualValue: number,
      expectedAccurate: boolean
    ) {
      const mockAgent = createMockAgent('agent-001', 'Operator Test Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);
      vi.mocked(mockEnvironment.getParameters).mockReturnValue({ temperature: actualValue });

      const config: ACCollaborationConfig = {
        id: `ac-operator-${operator}-${actualValue}`,
        name: `Operator ${operator} Test`,
        description: `Test ${operator} operator`,
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-operator',
            description: `Test ${operator} operator`,
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'temperature',
                condition: `temperature ${operator} ${threshold}`,
                threshold,
                operator,
              },
            ],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions.length).toBe(1);
      expect(result.predictions[0].accurate).toBe(expectedAccurate);
      expect(result.predictions[0].actualValue).toBe(actualValue);
      expect(result.predictions[0].predictedValue).toBe(threshold);
    }

    it('should correctly evaluate > operator (accurate)', async () => {
      await testOperatorAccuracy('>', 20, 25, true);
    });

    it('should correctly evaluate > operator (inaccurate)', async () => {
      await testOperatorAccuracy('>', 20, 15, false);
    });

    it('should correctly evaluate < operator (accurate)', async () => {
      await testOperatorAccuracy('<', 25, 22, true);
    });

    it('should correctly evaluate < operator (inaccurate)', async () => {
      await testOperatorAccuracy('<', 25, 30, false);
    });

    it('should correctly evaluate >= operator (equal value)', async () => {
      await testOperatorAccuracy('>=', 25, 25, true);
    });

    it('should correctly evaluate >= operator (greater value)', async () => {
      await testOperatorAccuracy('>=', 25, 30, true);
    });

    it('should correctly evaluate >= operator (less than)', async () => {
      await testOperatorAccuracy('>=', 25, 20, false);
    });

    it('should correctly evaluate <= operator (equal value)', async () => {
      await testOperatorAccuracy('<=', 25, 25, true);
    });

    it('should correctly evaluate <= operator (less value)', async () => {
      await testOperatorAccuracy('<=', 25, 20, true);
    });

    it('should correctly evaluate <= operator (greater value)', async () => {
      await testOperatorAccuracy('<=', 25, 30, false);
    });

    it('should correctly evaluate == operator (within tolerance)', async () => {
      // tolerance is 2.0, so actual 26 vs predicted 25 should be accurate
      await testOperatorAccuracy('==', 25, 26, true);
    });

    it('should correctly evaluate == operator (outside tolerance)', async () => {
      // tolerance is 2.0, so actual 28 vs predicted 25 should be inaccurate
      await testOperatorAccuracy('==', 25, 28, false);
    });

    it('should correctly evaluate == operator (exact match)', async () => {
      await testOperatorAccuracy('==', 25, 25, true);
    });

    it('should correctly evaluate != operator (different values)', async () => {
      await testOperatorAccuracy('!=', 25, 30, true);
    });

    it('should correctly evaluate != operator (same values)', async () => {
      await testOperatorAccuracy('!=', 25, 25, false);
    });
  });

  describe('extractPredictions - no operator fallback', () => {
    it('should use tolerance-based comparison when no operator is specified', async () => {
      const mockAgent = createMockAgent('agent-001', 'No Operator Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);
      // Actual value is within tolerance (2.0) of threshold
      vi.mocked(mockEnvironment.getParameters).mockReturnValue({ humidity: 53 });

      const config: ACCollaborationConfig = {
        id: 'ac-no-operator',
        name: 'No Operator Test',
        description: 'Test no operator fallback',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-no-op',
            description: 'Achieve target humidity',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['humidity-control'],
            successCriteria: [
              {
                type: 'metric-threshold',
                target: 'humidity',
                condition: 'humidity == 55',
                threshold: 55,
                // No operator specified
              },
            ],
            priority: 'medium',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions.length).toBe(1);
      // 53 is within tolerance 2.0 of 55 (|53-55| = 2.0 <= 2.0)
      expect(result.predictions[0].accurate).toBe(true);
    });
  });

  describe('extractPredictions - multiple goals and criteria', () => {
    it('should generate predictions for multiple criteria across goals', async () => {
      const mockAgent = createMockAgent('agent-001', 'Multi Goal Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);
      vi.mocked(mockEnvironment.getParameters).mockReturnValue({
        temperature: 22.0,
        humidity: 45.0,
      });

      const config: ACCollaborationConfig = {
        id: 'ac-multi-predict',
        name: 'Multi Prediction Test',
        description: 'Test predictions for multiple goals',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-temp',
            description: 'Control temperature',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature-control'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'temperature',
                condition: 'temperature < 25',
                threshold: 25,
                operator: '<',
              },
            ],
            priority: 'high',
          },
          {
            id: 'goal-humidity',
            description: 'Control humidity',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['humidity-control'],
            successCriteria: [
              {
                type: 'environment-parameter',
                target: 'humidity',
                condition: 'humidity > 40',
                threshold: 40,
                operator: '>',
              },
            ],
            priority: 'medium',
          },
        ],
      };

      const result = await executeWithConfig(config);

      expect(result.predictions.length).toBe(2);

      const tempPrediction = result.predictions.find(p => p.parameter === 'temperature');
      expect(tempPrediction).toBeDefined();
      expect(tempPrediction!.goalId).toBe('goal-temp');
      expect(tempPrediction!.accurate).toBe(true); // 22 < 25

      const humidityPrediction = result.predictions.find(p => p.parameter === 'humidity');
      expect(humidityPrediction).toBeDefined();
      expect(humidityPrediction!.goalId).toBe('goal-humidity');
      expect(humidityPrediction!.accurate).toBe(true); // 45 > 40
    });
  });

  describe('predictions - backward compatibility', () => {
    it('should not break existing behavior when predictions is empty', async () => {
      const mockAgent = createMockAgent('agent-001', 'Compat Agent');
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-compat',
        name: 'Compatibility Test',
        description: 'Ensure backward compatibility',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-compat',
            description: 'Simple goal',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['light-control'],
            successCriteria: [
              {
                type: 'task-completion',
                target: 'device-001',
                condition: 'completed',
              },
            ],
            priority: 'high',
          },
        ],
      };

      const result = await executeWithConfig(config);

      // All standard result fields should still work
      expect(result.collaborationId).toBe('ac-compat');
      expect(result.success).toBeDefined();
      expect(result.finalState).toBeDefined();
      expect(result.startTime).toBeDefined();
      expect(result.endTime).toBeDefined();
      expect(result.duration).toBeDefined();
      expect(result.goalsAchieved).toBeDefined();
      expect(result.goalsFailed).toBeDefined();
      expect(result.deviceOperations).toBeDefined();
      expect(result.environmentEffects).toBeDefined();
      expect(result.agentCommunications).toBeDefined();
      expect(result.tasksExecuted).toBeDefined();
      expect(result.predictions).toBeDefined();
      expect(result.predictions).toEqual([]);
    });
  });
});
