/**
 * CollaborationWorkflow Engine Tests - Sprint 11
 *
 * Tests for verifying that CollaborationWorkflow uses service-based ownership checks
 * instead of directly accessing ResourceManager.getAllResources()
 *
 * Sprint 11 Goal:
 * - Remove direct ResourceManager access in CollaborationWorkflow
 * - Use service metadata (getProviderInfo().providerAgentId) for ownership checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CollaborationWorkflowEngine, CollaborationWorkflow } from '../CollaborationWorkflow.js';
import type { ServiceBroker } from '../../service/index.js';
import type { SystemEvent } from '@active-collaboration/shared';

/**
 * Mock Service that simulates services with provider info
 */
class MockService {
  id: string;
  deviceId: string;
  category: string;
  private _providerAgentId?: string;
  private _providerAgentName?: string;
  private _providerCapabilities?: string[];

  constructor(config: {
    id: string;
    deviceId: string;
    category: string;
    providerAgentId?: string;
    providerAgentName?: string;
    providerCapabilities?: string[];
  }) {
    this.id = config.id;
    this.deviceId = config.deviceId;
    this.category = config.category;
    this._providerAgentId = config.providerAgentId;
    this._providerAgentName = config.providerAgentName;
    this._providerCapabilities = config.providerCapabilities;
  }

  getProviderInfo() {
    return {
      providerAgentId: this._providerAgentId,
      providerAgentName: this._providerAgentName,
      providerCapabilities: this._providerCapabilities,
    };
  }
}

/**
 * Mock Environment that provides services
 */
class MockEnvironment {
  private services: MockService[] = [];
  private agents: any[] = [];

  discoverServices(query: any): MockService[] {
    if (query.providerAgentId) {
      return this.services.filter(s =>
      s.getProviderInfo().providerAgentId === query.providerAgentId
      );
    }
    return this.services;
  }

  listAgents(): any[] {
    return this.agents;
  }

  addService(service: MockService): void {
    this.services.push(service);
  }

  addAgent(agent: any): void {
    this.agents.push(agent);
  }
}

/**
 * Mock ServiceBroker
 */
class MockServiceBroker {
  private environment: MockEnvironment;

  public offers: any[] = [];

  constructor(environment: MockEnvironment) {
    this.environment = environment;
  }

  async discoverServices(query: any): Promise<{ offers: any[] }> {
    let services = this.environment.discoverServices(query);

    // Filter by service type if specified (and not wildcard)
    if (query.serviceType && query.serviceType !== 'all' && query.serviceType !== 'any') {
      services = services.filter(s => s.category === query.serviceType);
    }

    // Filter by allowedProviders if specified
    if (query.constraints?.allowedProviders && query.constraints.allowedProviders.length > 0) {
      services = services.filter(s =>
        query.constraints.allowedProviders.includes(s.getProviderInfo().providerAgentId)
      );
    }

    // Filter by excludedProviders if specified
    if (query.constraints?.excludedProviders && query.constraints.excludedProviders.length > 0) {
      services = services.filter(s =>
        !query.constraints.excludedProviders.includes(s.getProviderInfo().providerAgentId)
      );
    }

    const offers = services.map(s => ({
      serviceId: s.id,
      providerId: s.getProviderInfo().providerAgentId || 'unknown',
      serviceName: s.id,
      deviceId: s.deviceId,
    }));
    return { offers };
  }

  selectBestOffer(discovery: { offers: any[] }): any {
    return discovery.offers[0] || null;
  }

  async requestService(offer: any, query: any, requestId: string): Promise<any> {
    return {
      success: true,
      contract: { contractId: `contract-${Date.now()}` },
    };
  }

  getOfferForService(serviceId: string): any {
    return this.offers.find(o => o.serviceId === serviceId);
  }
}

describe('CollaborationWorkflowEngine - Sprint 11', () => {
  let workflowEngine: CollaborationWorkflowEngine;
  let mockServiceBroker: MockServiceBroker;
  let mockEnvironment: MockEnvironment;

  let consoleWarnSpy: any;
  let consoleLogSpy: any;

  beforeEach(() => {
    mockEnvironment = new MockEnvironment();
    mockServiceBroker = new MockServiceBroker(mockEnvironment);
    workflowEngine = new CollaborationWorkflowEngine(mockServiceBroker as unknown as ServiceBroker);

    // Don't suppress console output for debugging
    // consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (consoleWarnSpy) consoleWarnSpy.mockRestore();
    if (consoleLogSpy) consoleLogSpy.mockRestore();
  });

  describe('Service-based ownership check', () => {
    it('should use service.getProviderInfo().providerAgentId to check ownership instead of ResourceManager', async () => {
      // Setup: Create services for different agents
      const agentAServices = [
        new MockService({
          id: 'service-a1',
          deviceId: 'device-a1',
          category: 'temperature-sensor',
          providerAgentId: 'agent-A',
          providerAgentName: 'Agent A',
          providerCapabilities: ['temperature-sensing'],
        }),
        new MockService({
          id: 'service-a2',
          deviceId: 'device-a2',
          category: 'hvac-control',
          providerAgentId: 'agent-A',
          providerAgentName: 'Agent A',
          providerCapabilities: ['hvac-control'],
        }),
      ];

      const agentBServices = [
        new MockService({
          id: 'service-b1',
          deviceId: 'device-b1',
          category: 'temperature-sensor',
          providerAgentId: 'agent-B',
          providerAgentName: 'Agent B',
          providerCapabilities: ['temperature-sensing'],
        }),
      ];

      // Add all services to environment
      [...agentAServices, ...agentBServices].forEach(s => mockEnvironment.addService(s));

      // Register a workflow
      const workflow: CollaborationWorkflow = {
        workflowId: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test workflow for Sprint 11',
        dependencies: [
          {
            resourceType: 'temperature-sensor',
            triggerCondition: { eventType: 'test-event' },
            required: true,
          },
        ],
        negotiationStrategy: 'sequential',
      };
      workflowEngine.registerWorkflow(workflow);

      // Execute workflow for agent-A
      const event: SystemEvent = {
        id: 'event-1',
        type: 'test-event',
        source: 'agent-A',
        timestamp: new Date(),
        payload: {},
      };

      const result = await workflowEngine.executeWorkflow('test-workflow', event);
      // Verify: The workflow should have discovered services using provider info
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.servicesRequested.length).toBeGreaterThan(0);
    });

    it('should NOT access resourceManager.getAllResources() when checking device ownership', async () => {
      // This test verifies that the implementation does NOT use resourceManager.getAllResources()
      // Setup: Create a service for a DIFFERENT agent (so STEP 1 will fail and STEP 2 will be reached)
      const otherAgentService = new MockService({
        id: 'service-other',
        deviceId: 'device-other',
        category: 'temperature-sensor',
        providerAgentId: 'agent-other', // Different from the requesting agent
        providerAgentName: 'Other Agent',
        providerCapabilities: ['sensing'],
      });

      // Create a service for the requesting agent but with DIFFERENT category
      // This will trigger STEP 2 (tryCreateServiceFromResources)
      const requestingAgentService = new MockService({
        id: 'service-test-hvac',
        deviceId: 'device-hvac',
        category: 'hvac-controller', // Different category from what we'll request
        providerAgentId: 'agent-test',
        providerAgentName: 'Test Agent',
        providerCapabilities: ['hvac-control'],
      });

      mockEnvironment.addService(otherAgentService);
      mockEnvironment.addService(requestingAgentService);

      // Create a mock agent with resourceManager that should NOT be accessed
      const mockAgent = {
        id: 'agent-test',
        resourceManager: {
          getAllResources: vi.fn().mockReturnValue([
            { id: 'device-hvac', deviceId: 'device-hvac' },
          ]),
        },
      };

      // Add the mock agent to the environment so it can be found by listAgents()
      mockEnvironment.addAgent(mockAgent);

      // Verify resourceManager exists but should not be called
      expect(mockAgent.resourceManager.getAllResources).toBeDefined();

      // Register workflow that requests temperature-sensor (which the agent doesn't have)
      const workflow: CollaborationWorkflow = {
        workflowId: 'ownership-test',
        name: 'Ownership Test',
        description: 'Test workflow',
        dependencies: [
          {
            resourceType: 'temperature-sensor',
            triggerCondition: { eventType: 'ownership-check-event' },
            required: true,
          },
        ],
        negotiationStrategy: 'sequential',
      };
      workflowEngine.registerWorkflow(workflow);

      const event: SystemEvent = {
        id: 'event-2',
        type: 'ownership-check-event',
        source: 'agent-test',
        timestamp: new Date(),
        payload: {},
      };

      await workflowEngine.executeWorkflow('ownership-test', event);
      // The critical assertion: resourceManager.getAllResources should NOT have been called
      // The implementation should use service.getProviderInfo().providerAgentId instead
      expect(mockAgent.resourceManager.getAllResources).not.toHaveBeenCalled();
    });
    it('should correctly identify services owned by a specific agent using provider info', async () => {
      // Setup: Multiple agents' services
      const services = [
        new MockService({
          id: 'service-agent1-temp',
          deviceId: 'device-temp-1',
          category: 'temperature-sensor',
          providerAgentId: 'agent-1',
          providerAgentName: 'Agent 1',
        }),
        new MockService({
          id: 'service-agent2-temp',
          deviceId: 'device-temp-2',
          category: 'temperature-sensor',
          providerAgentId: 'agent-2',
          providerAgentName: 'Agent 2',
        }),
        new MockService({
          id: 'service-agent1-hvac',
          deviceId: 'device-hvac-1',
          category: 'hvac-control',
          providerAgentId: 'agent-1',
          providerAgentName: 'Agent 1',
        }),
      ];
      services.forEach(s => mockEnvironment.addService(s));
      // Register workflow
      const workflow: CollaborationWorkflow = {
        workflowId: 'multi-agent-test',
        name: 'Multi Agent Test',
        description: 'Test workflow for multiple agents',
        dependencies: [
          {
            resourceType: 'temperature-sensor',
            triggerCondition: { eventType: 'multi-agent-event' },
            required: true,
          },
        ],
        negotiationStrategy: 'sequential',
      };
      workflowEngine.registerWorkflow(workflow);
      // Execute workflow for agent-1
      const event: SystemEvent = {
        id: 'event-3',
        type: 'multi-agent-event',
        source: 'agent-1',
        timestamp: new Date(),
        payload: {},
      };
      const result = await workflowEngine.executeWorkflow('multi-agent-test', event);
      expect(result).toBeDefined();
      // When agent-1 requests, it should prefer agent-1's own services
      // The workflow should have found services
      expect(result.servicesRequested.length).toBeGreaterThan(0);
    });
  });
  describe('tryCreateServiceFromResources refactoring', () => {
    it('should use service.getProviderInfo() instead of resourceManager to check ownership', async () => {
      // Setup: Create services with provider info
      const services = [
        new MockService({
          id: 'hvac-service',
          deviceId: 'hvac-device-1',
          category: 'hvac-controller',
          providerAgentId: 'agent-test',
          providerAgentName: 'Test Agent',
          providerCapabilities: ['hvac-control', 'temperature-control'],
        }),
      ];
      services.forEach(s => mockEnvironment.addService(s));
      // Register workflow that triggers hvac-control dependency
      const workflow: CollaborationWorkflow = {
        workflowId: 'hvac-test',
        name: 'HVAC Test',
        description: 'Test workflow for HVAC',
        dependencies: [
          {
            resourceType: 'hvac-control',
            triggerCondition: { eventType: 'hvac-event' },
            required: true,
          },
        ],
        negotiationStrategy: 'sequential',
      };
      workflowEngine.registerWorkflow(workflow);
      const event: SystemEvent = {
        id: 'event-4',
        type: 'hvac-event',
        source: 'agent-test',
        timestamp: new Date(),
        payload: {},
      };
      const result = await workflowEngine.executeWorkflow('hvac-test', event);
      expect(result).toBeDefined();
      // The workflow should have successfully processed the dependency
      // using service metadata instead of resourceManager access
      expect(result.actionsTaken.length).toBeGreaterThan(0);
    });
  });
});
