/**
 * ACExecutor Tests - Sprint 13
 *
 * Tests that ACExecutor uses ServiceBroker instead of directly accessing
 * agent.resourceManager.getAllResources() for architecture consistency.
 *
 * This follows the same pattern as Sprint 10 (ServiceBroker) and Sprint 11 (CollaborationWorkflow).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACExecutor } from '../ACExecutor.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ACCollaborationConfig } from '../ACExecutor.js';
import { CollaborationManager } from '../../management/CollaborationManager.js';
import type { AgentService, ProviderInfo, ServiceExecutionContext, ServiceStats, ServiceExecutionResult } from '../../service/Service.js';
import { ServiceHealthStatus } from '../../service/Service.js';
import type { Device, Service } from '@active-collaboration/shared';
import type { Agent } from '../../environment/types.js';

/**
 * Mock service that implements AgentService with getProviderInfo
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
 * Mock resource with capabilities
 */
class MockResource {
  id: string;
  name: string;
  deviceId: string;
  private capabilities: Record<string, unknown>[];

  constructor(config: { id: string; name: string; deviceId: string; capabilities: Record<string, unknown>[] }) {
    this.id = config.id;
    this.name = config.name;
    this.deviceId = config.deviceId;
    this.capabilities = config.capabilities;
  }

  getCapabilities(): Record<string, unknown>[] {
    return this.capabilities;
  }

  getDevice(): Record<string, unknown> {
    return {
      id: this.deviceId,
      type: 'test-device',
      executeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
  }
}

describe('ACExecutor - Sprint 13 ServiceBroker Integration', () => {
  let executor: ACExecutor;
  let mockEnvironment: EnvironmentCenter;
  let mockCollaborationManager: CollaborationManager;

  beforeEach(() => {
    executor = new ACExecutor();

    // Create mock environment
    mockEnvironment = {
      getAgent: vi.fn(),
      listAgents: vi.fn(),
      getDevice: vi.fn(),
      discoverServices: vi.fn(),
    } as unknown as EnvironmentCenter;

    // Create mock collaboration manager
    mockCollaborationManager = {
      trackACState: vi.fn().mockResolvedValue(undefined),
    } as unknown as CollaborationManager;
  });

  describe('executeCollaboration - Architecture Compliance', () => {
    it('should NOT call resourceManager.getAllResources() directly', async () => {
      // Arrange - Create agent with mocked resourceManager
      const mockAgent = {
        id: 'agent-001',
        name: 'Test Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({
            id: 'task-001',
            status: 'pending',
          }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([] as unknown as Service[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [{ type: 'execute', name: 'light-control' }],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-test-002',
        name: 'Test AC 2',
        description: 'Test collaboration 2',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Control light',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['light-control'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      // Act - Execute the collaboration
      await executor.executeCollaboration(config);

      // Assert - This should FAIL if architecture is violated
      // After refactoring, this should PASS
      expect(mockAgent.resourceManager.getAllResources).not.toHaveBeenCalled();
    });

    it('should use ServiceBroker (discoverServices) to find services', async () => {
      // Create a service that should be discovered via ServiceBroker
      const mockService = new MockService({
        id: 'service-001',
        name: 'Temperature Service',
        deviceId: 'device-001',
        category: 'monitoring',
        description: 'Temperature monitoring service',
        providerInfo: {
          providerAgentId: 'agent-001',
          providerAgentName: 'Test Agent',
        },
        capabilities: ['temperature-sensing'],
      });

      // Setup mock agent
      const mockAgent = {
        id: 'agent-001',
        name: 'Test Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({
            id: 'task-001',
            status: 'pending',
          }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      // Setup environment mocks
      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([mockService] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'sensor',
        capabilities: [{ type: 'read', name: 'temperature' }],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      // Create collaboration config
      const config: ACCollaborationConfig = {
        id: 'ac-001',
        name: 'Test AC',
        description: 'Test collaboration',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Monitor temperature',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      // Act - Execute the collaboration
      await executor.executeCollaboration(config);

      // Assert - Verify that resourceManager.getAllResources was NOT called
      // The executor should use ServiceBroker instead
      expect(mockAgent.resourceManager.getAllResources).not.toHaveBeenCalled();

      // Verify that discoverServices was called (using ServiceBroker)
      expect(mockEnvironment.discoverServices).toHaveBeenCalled();
    });

    it('should use service metadata (getProviderInfo) to match services to agents', async () => {
      // Arrange - Create agent and services
      const mockAgent = {
        id: 'agent-alpha',
        name: 'Alpha Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({
            id: 'task-001',
            status: 'pending',
          }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      const service1 = new MockService({
        id: 'service-001',
        name: 'Temperature Service',
        deviceId: 'device-001',
        category: 'monitoring',
        description: 'Temperature monitoring',
        providerInfo: {
          providerAgentId: 'agent-alpha',
          providerAgentName: 'Alpha Agent',
        },
        capabilities: ['temperature'],
      });

      const service2 = new MockService({
        id: 'service-002',
        name: 'Humidity Service',
        deviceId: 'device-002',
        category: 'monitoring',
        description: 'Humidity monitoring',
        providerInfo: {
          providerAgentId: 'agent-beta',
          providerAgentName: 'Beta Agent',
        },
        capabilities: ['humidity'],
      });

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service1, service2] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'sensor',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-002',
        name: 'Test AC 2',
        description: 'Test collaboration 2',
        environment: mockEnvironment,
        participantAgentIds: ['agent-alpha'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Monitor temperature',
            targetDevices: ['device-001'],
            targetAgents: ['agent-alpha'],
            requiredCapabilities: ['temperature'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      // Act
      await executor.executeCollaboration(config);

      // Assert - Verify services were discovered using getProviderInfo
      expect(mockEnvironment.discoverServices).toHaveBeenCalled();
      expect(mockEnvironment.listAgents).toHaveBeenCalled();
    });
  });

  describe('matchSelfResources - Architecture Compliance', () => {
    it('should use ServiceBroker to discover self-services instead of resourceManager.getAllResources()', async () => {
      // Arrange - Create agent with resources and services
      const mockAgent = {
        id: 'agent-001',
        name: 'Test Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([
            new MockResource({
              id: 'resource-001',
              name: 'Light Resource',
              deviceId: 'device-001',
              capabilities: [{ name: 'light-control' }],
            }),
          ]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({
            id: 'task-001',
            status: 'pending',
          }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      const mockService = new MockService({
        id: 'service-001',
        name: 'Light Control Service',
        deviceId: 'device-001',
        category: 'control',
        description: 'Light control service',
        providerInfo: {
          providerAgentId: 'agent-001',
          providerAgentName: 'Test Agent',
        },
        capabilities: ['light-control'],
        actionType: 'control',
      });

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([mockService] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [{ type: 'execute', name: 'toggle' }],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-003',
        name: 'Test AC 3',
        description: 'Test collaboration 3',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Control light',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['light-control'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      // Act
      await executor.executeCollaboration(config);

      // Assert - resourceManager.getAllResources should NOT be called
      expect(mockAgent.resourceManager.getAllResources).not.toHaveBeenCalled();

      // ServiceBroker should be used instead
      expect(mockEnvironment.discoverServices).toHaveBeenCalled();
    });

    it('should discover services with providerAgentId matching the agent', async () => {
      // Arrange
      const mockAgent = {
        id: 'agent-gamma',
        name: 'Gamma Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({
            id: 'task-001',
            status: 'pending',
          }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      // Service provided by this agent
      const selfService = new MockService({
        id: 'service-self',
        name: 'Self Service',
        deviceId: 'device-001',
        category: 'control',
        description: 'Self service',
        providerInfo: {
          providerAgentId: 'agent-gamma',
          providerAgentName: 'Gamma Agent',
        },
        capabilities: ['custom-capability'],
      });

      // Service provided by another agent
      const externalService = new MockService({
        id: 'service-external',
        name: 'External Service',
        deviceId: 'device-002',
        category: 'control',
        description: 'External service',
        providerInfo: {
          providerAgentId: 'agent-delta',
          providerAgentName: 'Delta Agent',
        },
        capabilities: ['custom-capability'],
      });

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([selfService, externalService] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'actuator',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-004',
        name: 'Test AC 4',
        description: 'Test collaboration 4',
        environment: mockEnvironment,
        participantAgentIds: ['agent-gamma'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Use custom capability',
            targetDevices: ['device-001'],
            targetAgents: ['agent-gamma'],
            requiredCapabilities: ['custom-capability'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert
      expect(mockEnvironment.discoverServices).toHaveBeenCalled();
      // The executor should be able to match self services using providerAgentId
      expect(result).toBeDefined();
    });
  });

  describe('Architecture Consistency with Sprint 10 and 11', () => {
    it('should follow the same ServiceBroker pattern as Sprint 10', async () => {
      // This test ensures ACExecutor follows the same architecture as ServiceBroker
      // from Sprint 10: using service.getProviderInfo() instead of direct ResourceManager access

      const mockAgent = {
        id: 'agent-001',
        name: 'Test Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([
            { id: 'resource-001', deviceId: 'device-001' },
          ]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({ id: 'task-001', status: 'pending' }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      const mockService = new MockService({
        id: 'service-001',
        name: 'Test Service',
        deviceId: 'device-001',
        category: 'test',
        description: 'Test service',
        providerInfo: {
          providerAgentId: 'agent-001',
          providerAgentName: 'Test Agent',
        },
        capabilities: ['test-capability'],
      });

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([mockService] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'sensor',
        capabilities: [],
        executeCommand: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-005',
        name: 'Test AC 5',
        description: 'Test collaboration 5',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Test goal',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['test-capability'],
            successCriteria: [],
            priority: 'high',
          },
        ],
      };

      // Act
      await executor.executeCollaboration(config);

      // Assert - Follow Sprint 10 pattern: NO direct resourceManager access
      expect(mockAgent.resourceManager.getAllResources).not.toHaveBeenCalled();

      // Use ServiceBroker pattern: discoverServices + getProviderInfo
      expect(mockEnvironment.discoverServices).toHaveBeenCalled();
      expect(mockEnvironment.listAgents).toHaveBeenCalled();
    });

    it('should maintain existing functionality while using ServiceBroker', async () => {
      // This test ensures that refactoring to use ServiceBroker doesn't break functionality

      const mockAgent = {
        id: 'agent-001',
        name: 'Test Agent',
        status: 'idle',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([]),
          getResource: vi.fn().mockReturnValue(null),
        },
        taskManager: {
          createTask: vi.fn().mockReturnValue({ id: 'task-001', status: 'pending' }),
        },
        dialogueManager: {
          sendMessage: vi.fn().mockReturnValue({
            subject: 'test',
            content: 'test',
          }),
        },
        eventManager: {
          subscribe: vi.fn(),
        },
        executeDeviceCapability: vi.fn().mockResolvedValue({ success: true, result: { value: 25.0 } }),
        requestService: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as Agent;

      const mockService = new MockService({
        id: 'service-001',
        name: 'Temperature Service',
        deviceId: 'device-001',
        category: 'monitoring',
        description: 'Temperature monitoring service',
        providerInfo: {
          providerAgentId: 'agent-001',
          providerAgentName: 'Test Agent',
        },
        capabilities: ['temperature'],
      });

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([mockService] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgent] as unknown as Agent[]);
      vi.mocked(mockEnvironment.getAgent).mockReturnValue(mockAgent);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        id: 'device-001',
        type: 'sensor',
        capabilities: [{ type: 'read', name: 'temperature' }],
        executeCommand: vi.fn().mockResolvedValue({ success: true, value: 25.0 }),
      } as unknown as Device);

      const config: ACCollaborationConfig = {
        id: 'ac-006',
        name: 'Test AC 6',
        description: 'Test collaboration 6',
        environment: mockEnvironment,
        participantAgentIds: ['agent-001'],
        collaborationManager: mockCollaborationManager,
        goals: [
          {
            id: 'goal-001',
            description: 'Monitor temperature',
            targetDevices: ['device-001'],
            targetAgents: ['agent-001'],
            requiredCapabilities: ['temperature'],
            successCriteria: [
              {
                type: 'device-state',
                target: 'device-001',
                condition: 'state == active',
              },
            ],
            priority: 'high',
          },
        ],
      };

      // Act
      const result = await executor.executeCollaboration(config);

      // Assert - Functionality should still work
      expect(result).toBeDefined();
      expect(result.collaborationId).toBe('ac-006');
      expect(result.tasksExecuted.length).toBeGreaterThan(0);
    });
  });
});
