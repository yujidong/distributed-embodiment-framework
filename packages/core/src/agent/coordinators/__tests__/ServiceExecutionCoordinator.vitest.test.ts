/**
 * ServiceExecutionCoordinator Unit Tests
 *
 * Tests for Service Layer coordinator - cross-agent service requests
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ServiceExecutionCoordinator } from '../ServiceExecutionCoordinator.js';
import type { ServiceBroker } from '../../../service/ServiceBroker.js';
import type { ServiceRegistry } from '../../../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../../../environment/EnvironmentCenter.js';
import type { EventEmitter } from '../../../events/EventEmitter.js';
import { EventType } from '@active-collaboration/shared';

// Helper functions to create mocks
const createMockServiceBroker = (): ServiceBroker => {
  return {
    discoverServices: vi.fn().mockResolvedValue({
    offers: [
      {
        serviceId: 'service-1',
        providerAgentId: 'agent-2',
        capabilities: ['monitoring'],
      },
    ],
  }),
  requestService: vi.fn().mockResolvedValue({
    success: true,
    result: { data: 'Service executed' },
  }),
} as unknown as ServiceBroker;
};

const createMockServiceRegistry = (): ServiceRegistry => {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn().mockReturnValue({
      id: 'service-1',
      name: 'Test Service',
      capabilities: ['monitoring'],
    }),
    getAll: vi.fn().mockReturnValue([]),
    findByCapability: vi.fn().mockReturnValue([]),
  } as unknown as ServiceRegistry;
};

const createMockEnvironmentCenter = (): EnvironmentCenter => {
  return {
    getAgent: vi.fn().mockReturnValue({
      id: 'agent-2',
      name: 'Test Agent 2',
      status: 'online',
    }),
    registerService: vi.fn(),
    unregisterService: vi.fn(),
  } as unknown as EnvironmentCenter;
};

const createMockEventEmitter = (): EventEmitter => {
  return {
    emit: vi.fn().mockReturnValue({
      id: 'event-123',
      source: 'agent-1',
      timestamp: new Date(),
    }),
    emitStateChange: vi.fn(),
    emitError: vi.fn(),
    emitWarning: vi.fn(),
    getEmitterId: vi.fn().mockReturnValue('agent-1'),
    getEventManager: vi.fn(),
  } as unknown as EventEmitter;
};

describe('ServiceExecutionCoordinator', () => {
  let coordinator: ServiceExecutionCoordinator;
  let mockServiceBroker: ServiceBroker;
  let mockServiceRegistry: ServiceRegistry;
  let mockEnvironmentCenter: EnvironmentCenter;
  let mockEventEmitter: EventEmitter;

  const agentId = 'agent-1';

  beforeEach(() => {
    vi.clearAllMocks();
    mockServiceBroker = createMockServiceBroker();
    mockServiceRegistry = createMockServiceRegistry();
    mockEnvironmentCenter = createMockEnvironmentCenter();
    mockEventEmitter = createMockEventEmitter();

    coordinator = new ServiceExecutionCoordinator(
      mockServiceBroker,
      mockServiceRegistry,
      mockEnvironmentCenter,
      mockEventEmitter,
      agentId
    );
  });

  describe('Constructor', () => {
    it('should create coordinator with all dependencies', () => {
      expect(coordinator).toBeDefined();
    });
  });

  describe('requestService', () => {
    it('should request service from another agent successfully', async () => {
      const targetAgentId = 'agent-2';
      const serviceId = 'service-1';
      const parameters = { value: 50 };

      const result = await coordinator.requestService(
        targetAgentId,
        serviceId,
        parameters
      );

      expect(result.success).toBe(true);
      expect(result.providerAgentId).toBe(targetAgentId);
      expect(mockServiceBroker.discoverServices).toHaveBeenCalled();
      expect(mockServiceBroker.requestService).toHaveBeenCalled();
    });

    it('should emit COLLABORATION_MESSAGE event on successful request', async () => {
      const targetAgentId = 'agent-2';
      const serviceId = 'service-1';

      await coordinator.requestService(targetAgentId, serviceId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        EventType.COLLABORATION_MESSAGE,
        expect.objectContaining({
          agentId: agentId,
          targetAgentId,
          serviceId,
        })
      );
    });

    it('should return error when service not found', async () => {
      (mockServiceBroker.discoverServices as Mock).mockResolvedValue({
        offers: [],
      });

      const result = await coordinator.requestService('agent-2', 'non-existent-service');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when agent not found', async () => {
      (mockServiceBroker.discoverServices as Mock).mockResolvedValue({
        offers: [{ serviceId: 'service-1' }],
      });
      (mockEnvironmentCenter.getAgent as Mock).mockReturnValue(undefined);

      const result = await coordinator.requestService('non-existent-agent', 'service-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle service broker errors', async () => {
      (mockServiceBroker.discoverServices as Mock).mockRejectedValue(
        new Error('Service broker error')
      );

      const result = await coordinator.requestService('agent-2', 'service-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Service broker error');
    });
  });

  describe('getService', () => {
    it('should get service from registry', () => {
      const service = coordinator.getService('service-1');
      expect(service).toBeDefined();
      expect(mockServiceRegistry.get).toHaveBeenCalledWith('service-1');
    });
  });

  describe('getAllServices', () => {
    it('should get all services from registry', () => {
      const services = coordinator.getAllServices();
      expect(Array.isArray(services)).toBe(true);
      expect(mockServiceRegistry.getAll).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle request with no parameters', async () => {
      const result = await coordinator.requestService('agent-2', 'service-1');

      expect(result.success).toBe(true);
      expect(mockServiceBroker.requestService).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        agentId
      );
    });

    it('should handle request with complex parameters', async () => {
      const complexParams = {
        config: { threshold: 25, enabled: true },
        data: [1, 2, 3],
        metadata: { source: 'test' },
      };

      const result = await coordinator.requestService('agent-2', 'service-1', complexParams);

      expect(result.success).toBe(true);
      expect(mockServiceBroker.requestService).toHaveBeenCalledWith(
        expect.anything(),
        complexParams,
        agentId
      );
    });
  });
});
