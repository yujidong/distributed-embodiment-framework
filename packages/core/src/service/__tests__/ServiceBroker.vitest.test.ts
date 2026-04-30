/**
 * ServiceBroker Tests - Sprint 10
 *
 * Tests that ServiceBroker uses service.getProviderInfo() instead of
 * directly accessing ResourceManagers to find provider agents.
 *
 * This validates the Device/Resource/Service separation principle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceBroker } from '../ServiceBroker.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { AgentService, ProviderInfo, ServiceStats } from '../Service.js';
import { ServiceHealthStatus } from '../Service.js';
import type { ServiceExecutionContext } from '../Service.js';
import type { CollaborationServiceQuery } from '../ServiceRequest.js';
import type { Device, Service } from '@active-collaboration/shared';

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

  constructor(config: {
    id: string;
    name: string;
    deviceId: string;
    category: string;
    description: string;
    providerInfo: ProviderInfo;
    actionType?: 'observe' | 'control' | 'both';
  }) {
    this.id = config.id;
    this.name = config.name;
    this.deviceId = config.deviceId;
    this.category = config.category;
    this.description = config.description;
    this._providerInfo = config.providerInfo;
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

  async execute(_context: ServiceExecutionContext): Promise<import('../Service.js').ServiceExecutionResult> {
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

describe('ServiceBroker - Sprint 10: Provider Agent Resolution', () => {
  let mockEnvironment: EnvironmentCenter;
  let serviceBroker: ServiceBroker;

  beforeEach(() => {
    // Create mock environment
    mockEnvironment = {
      id: 'test-env-001',
      discoverServices: vi.fn(),
      listAgents: vi.fn(),
      getDevice: vi.fn(),
      getServiceRegistration: vi.fn(),
    } as unknown as EnvironmentCenter;

    serviceBroker = new ServiceBroker(mockEnvironment);
  });

  describe('discoverServices', () => {
    it('should use getProviderInfo() to find provider agent', async () => {
      // Arrange - Create services with provider info
      const service = new MockService({
        id: 'service-001',
        name: 'Temperature Service',
        deviceId: 'device-001',
        category: 'monitoring',
        description: 'Temperature monitoring service',
        providerInfo: {
          providerAgentId: 'agent-alpha',
          providerAgentName: 'Alpha Agent',
        },
      });

      const mockAgents = [
        { id: 'agent-alpha', name: 'Alpha Agent' },
        { id: 'agent-beta', name: 'Beta Agent' },
      ];

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue(mockAgents as unknown as import('../../environment/types.js').Agent[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        type: 'sensor',
        capabilities: [],
      } as unknown as Device);

      // Act - Query for services
      const query: CollaborationServiceQuery = {
        serviceType: 'monitoring',
        requiredCapabilities: ['temperature'],
      };

      const result = await serviceBroker.discoverServices(query);

      // Assert - Verify provider info was used
      expect(result.offers.length).toBeGreaterThan(0);

      // The offer should have the correct providerId from getProviderInfo()
      const offer = result.offers.find(o => o.serviceId === 'service-001');
      expect(offer).toBeDefined();
      expect(offer?.providerId).toBe('agent-alpha');

      // Verify that listAgents was called
      expect(mockEnvironment.listAgents).toHaveBeenCalled();
    });

    it('should NOT access resourceManager.getAllResources() on agents', async () => {
      // Arrange - Create a service with provider info
      const service = new MockService({
        id: 'service-003',
        name: 'Test Service',
        deviceId: 'device-003',
        category: 'test',
        description: 'Test service',
        providerInfo: {
          providerAgentId: 'agent-gamma',
          providerAgentName: 'Test Agent',
        },
      });

      // Create mock agents with resourceManager that should NOT be accessed
      const mockAgentWithResourceManager = {
        id: 'agent-gamma',
        name: 'Test Agent',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([
            { id: 'resource-001', deviceId: 'device-003' },
          ]),
        },
      };

      // Spy on getAllResources to ensure it's NOT called
      const getAllResourcesSpy = mockAgentWithResourceManager.resourceManager.getAllResources;

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue([mockAgentWithResourceManager] as unknown as import('../../environment/types.js').Agent[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        type: 'sensor',
        capabilities: [],
      } as unknown as Device);

      // Act
      const query: CollaborationServiceQuery = {
        serviceType: 'all',  // Use wildcard to allow empty requiredCapabilities
        requiredCapabilities: [],
      };

      await serviceBroker.discoverServices(query);

      // Assert - resourceManager.getAllResources should NOT have been called
      expect(getAllResourcesSpy).not.toHaveBeenCalled();
    });

    it('should correctly match services to agents using providerAgentId', async () => {
      // Arrange
      const service = new MockService({
        id: 'service-004',
        name: 'Humidity Service',
        deviceId: 'device-004',
        category: 'monitoring',
        description: 'Humidity monitoring',
        providerInfo: {
          providerAgentId: 'agent-delta',
          providerAgentName: 'Humidity Agent',
        },
      });

      const mockAgents = [
        { id: 'agent-alpha', name: 'Other Agent 1' },
        { id: 'agent-delta', name: 'Humidity Agent' }, // This is the provider
        { id: 'agent-beta', name: 'Other Agent 2' },
      ];

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue(mockAgents as unknown as import('../../environment/types.js').Agent[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        type: 'sensor',
        capabilities: [],
      } as unknown as Device);

      // Act
      const query: CollaborationServiceQuery = {
        serviceType: 'monitoring',
        requiredCapabilities: ['humidity'],
      };

      const result = await serviceBroker.discoverServices(query);

      // Assert - Should find the correct provider agent
      expect(result.offers.length).toBeGreaterThan(0);
      expect(result.offers[0].providerId).toBe('agent-delta');
      expect(result.offers[0].providerName).toBe('Humidity Agent');
    });

    it('should skip services when provider agent is not found in agent list', async () => {
      // Arrange - Service references an agent that doesn't exist in listAgents
      const service = new MockService({
        id: 'service-005',
        name: 'Orphan Service',
        deviceId: 'device-005',
        category: 'test',
        description: 'Service with non-existent provider',
        providerInfo: {
          providerAgentId: 'agent-nonexistent',
          providerAgentName: 'Non-existent Agent',
        },
      });

      const mockAgents = [
        { id: 'agent-alpha', name: 'Alpha Agent' },
        { id: 'agent-beta', name: 'Beta Agent' },
      ];

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue(mockAgents as unknown as import('../../environment/types.js').Agent[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        type: 'sensor',
        capabilities: [],
      } as unknown as Device);

      // Act
      const query: CollaborationServiceQuery = {
        serviceType: 'all',  // Use wildcard to allow empty requiredCapabilities
        requiredCapabilities: [],
      };

      const result = await serviceBroker.discoverServices(query);

      // Assert - Service should be skipped because provider agent not found
      expect(result.offers.length).toBe(0);
    });

    it('should respect excludedProviders constraint using providerAgentId', async () => {
      // Arrange
      const service = new MockService({
        id: 'service-006',
        name: 'Test Service',
        deviceId: 'device-006',
        category: 'control',
        description: 'Test control service',
        providerInfo: {
          providerAgentId: 'agent-excluded',
          providerAgentName: 'Excluded Agent',
        },
      });

      const mockAgents = [
        { id: 'agent-excluded', name: 'Excluded Agent' },
      ];

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue(mockAgents as unknown as import('../../environment/types.js').Agent[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        type: 'actuator',
        capabilities: [],
      } as unknown as Device);

      // Act - Query with excluded provider
      const query: CollaborationServiceQuery = {
        serviceType: 'all',  // Use wildcard to allow empty requiredCapabilities
        requiredCapabilities: [],
        constraints: {
          excludedProviders: ['agent-excluded'],
        },
      };

      const result = await serviceBroker.discoverServices(query);

      // Assert - Service should be excluded
      expect(result.offers.length).toBe(0);
    });

    it('should respect allowedProviders constraint using providerAgentId', async () => {
      // Arrange
      const service1 = new MockService({
        id: 'service-007',
        name: 'Service A',
        deviceId: 'device-007',
        category: 'test',
        description: 'Service A',
        providerInfo: {
          providerAgentId: 'agent-allowed',
          providerAgentName: 'Allowed Agent',
        },
      });

      const service2 = new MockService({
        id: 'service-008',
        name: 'Service B',
        deviceId: 'device-008',
        category: 'test',
        description: 'Service B',
        providerInfo: {
          providerAgentId: 'agent-not-allowed',
          providerAgentName: 'Not Allowed Agent',
        },
      });

      const mockAgents = [
        { id: 'agent-allowed', name: 'Allowed Agent' },
        { id: 'agent-not-allowed', name: 'Not Allowed Agent' },
      ];

      vi.mocked(mockEnvironment.discoverServices).mockReturnValue([service1, service2] as unknown as Service[]);
      vi.mocked(mockEnvironment.listAgents).mockReturnValue(mockAgents as unknown as import('../../environment/types.js').Agent[]);
      vi.mocked(mockEnvironment.getDevice).mockReturnValue({
        type: 'sensor',
        capabilities: [],
      } as unknown as Device);

      // Act - Query with allowed provider
      const query: CollaborationServiceQuery = {
        serviceType: 'all',  // Use wildcard to allow empty requiredCapabilities
        requiredCapabilities: [],
        constraints: {
          allowedProviders: ['agent-allowed'],
        },
      };

      const result = await serviceBroker.discoverServices(query);

      // Assert - Only service from allowed provider should be included
      expect(result.offers.length).toBe(1);
      expect(result.offers[0].providerId).toBe('agent-allowed');
    });
  });
});
