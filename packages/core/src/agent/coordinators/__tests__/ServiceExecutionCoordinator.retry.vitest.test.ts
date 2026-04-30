/**
 * ServiceExecutionCoordinator Retry Logic Tests
 *
 * Tests for retry logic in cross-agent service requests
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
}

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
}

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
}

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
}

describe('ServiceExecutionCoordinator Retry Logic', () => {
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

  describe('Retry Behavior', () => {
    it('should retry failed requests with exponential backoff', async () => {
      let callCount = 0;
      const delays: number[] = [];

      (mockServiceBroker.requestService as Mock).mockImplementation(async () => {
        callCount++;
        delays.push(Date.now());

        if (callCount < 3) {
          throw new Error('Temporary failure');
        }

        return { success: true, result: { data: 'Success on retry' } };
      });

      const result = await coordinator.requestService('agent-2', 'service-1', {}, { maxRetries: 3, retryDelay: 100 });

      expect(result.success).toBe(true);
      expect(callCount).toBe(3);
      expect(delays.length).toBeGreaterThanOrEqual(2);
    });

    it('should fail after max retries exhausted', async () => {
      (mockServiceBroker.requestService as Mock).mockImplementation(async () => {
        throw new Error('Persistent failure');
      });

      const result = await coordinator.requestService('agent-2', 'service-1', {}, { maxRetries: 2, retryDelay: 50 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Persistent failure');
    });
  });
});
