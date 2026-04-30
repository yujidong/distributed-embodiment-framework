/**
 * Tests for OntologyContextComposer
 *
 * Tests the composer that aggregates ontology reasoning and formats for sections
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OntologyContextComposer } from './OntologyContextComposer.js';
import { OntologyReasoningEngine } from '../ontology/OntologyReasoningEngine.js';
import type { DeviceStateInfo, ServiceInfo, PeerAgentInfo } from './AgentContextBuilder.js';
import type { ResourceOntology, ResourceOntologyClass } from '../resource/Resource.js';
import type { ServiceOntology, ServiceOntologyClass, ServiceType } from '../service/SemanticService.js';

/**
 * Helper function to create a mock ResourceOntology
 */
function createMockResourceOntology(overrides: Partial<ResourceOntology> = {}): ResourceOntology {
  return {
    ontologyClass: 'ssn:TemperatureSensor' as ResourceOntologyClass,
    semanticDescription: {
      what: 'Temperature Sensor',
      purpose: 'Monitor ambient temperature',
      constraints: [],
    },
    spatialContext: {
      location: 'living-room',
    },
    rawCapabilities: [
      { name: 'temperature-reading', type: 'read' },
    ],
    ...overrides,
  };
}

/**
 * Helper function to create a mock ServiceOntology
 */
function createMockServiceOntology(overrides: Partial<ServiceOntology> = {}): ServiceOntology {
  return {
    serviceType: 'resource-backed' as ServiceType,
    ontologyClass: 'ssn:TemperatureObservation' as ServiceOntologyClass,
    businessCapability: {
      name: 'Temperature Monitoring',
      description: 'Monitor temperature',
      inputs: [],
      outputs: [{ name: 'temperature', type: 'number' }],
    },
    dependencies: [],
    spatialContext: { source: 'inherited' },
    semanticContext: {
      businessDescription: 'Temperature monitoring',
      applicableScenarios: [],
      collaborationHints: [],
    },
    ...overrides,
  };
}

describe('OntologyContextComposer', () => {
  let composer: OntologyContextComposer;
  let mockReasoningEngine: OntologyReasoningEngine;

  beforeEach(() => {
    mockReasoningEngine = new OntologyReasoningEngine();
    composer = new OntologyContextComposer(mockReasoningEngine);
  });

  describe('composeForTask', () => {
    it('should compose ontology context for a task', async () => {
      const task = 'Control temperature in the living room';
      const resources: DeviceStateInfo[] = [
        {
          id: 'device-1',
          name: 'Temperature Sensor',
          type: 'sensor',
          location: 'living-room',
          capabilities: ['temperature-reading'],
          currentState: { temperature: 22 },
          isOnline: true,
          resourceOntology: createMockResourceOntology(),
        },
      ];
      const services = { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] };
      const peers: PeerAgentInfo[] = [];

      const result = await composer.composeForTask(task, resources, services, peers);

      expect(result).toBeDefined();
      expect(result.internalReasoning).toBeDefined();
      expect(result.externalReasoning).toBeDefined();
      expect(result.combinedReasoning).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('should identify internal capabilities for matching task', async () => {
      const task = 'Read temperature';
      const resources: DeviceStateInfo[] = [
        {
          id: 'device-1',
          name: 'Temp Sensor',
          type: 'sensor',
          location: 'room-1',
          capabilities: ['temperature-reading'],
          currentState: {},
          isOnline: true,
          resourceOntology: createMockResourceOntology({
            rawCapabilities: [{ name: 'temperature-reading', type: 'read' }],
          }),
        },
      ];
      const services = { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] };

      const result = await composer.composeForTask(task, resources, services, []);

      expect(result.internalReasoning).toBeDefined();
    });

    it('should identify collaboration opportunities with peer services', async () => {
      const task = 'Control temperature';
      const resources: DeviceStateInfo[] = [];
      const services = { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] };
      const peers: PeerAgentInfo[] = [
        {
          id: 'agent-2',
          name: 'Climate Agent',
          capabilities: ['hvac-control'],
          services: [
            {
              id: 'hvac-service',
              name: 'HVAC Control Service',
              providerAgentId: 'agent-2',
              providerAgentName: 'Climate Agent',
              category: 'control',
              capabilities: ['hvac-control'],
              status: 'available',
              serviceOntology: createMockServiceOntology({
                businessCapability: {
                  name: 'HVAC Control',
                  description: 'Control heating and cooling',
                  inputs: [{ name: 'targetTemp', type: 'number' }],
                  outputs: [],
                },
              }),
            },
          ],
          status: 'online',
        },
      ];

      const result = await composer.composeForTask(task, resources, services, peers);

      expect(result.externalReasoning).toBeDefined();
    });

    it('should generate a summary of reasoning results', async () => {
      const task = 'Monitor temperature';
      const resources: DeviceStateInfo[] = [
        {
          id: 'device-1',
          name: 'Temp Sensor',
          type: 'sensor',
          location: 'room-1',
          capabilities: ['temperature-reading'],
          currentState: { temperature: 22 },
          isOnline: true,
          resourceOntology: createMockResourceOntology(),
        },
      ];
      const services = { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] };
      const peers: PeerAgentInfo[] = [];

      const result = await composer.composeForTask(task, resources, services, peers);

      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });

  describe('formatForLLM', () => {
    it('should format ontology context result for LLM consumption', () => {
      const mockResult = {
        internalReasoning: {
          canHandle: true,
          matchingResources: [{ id: 'd1', name: 'Sensor', ontologyClass: 'ssn:Sensor', capabilities: ['temp'], location: 'room1' }],
          missingCapabilities: [],
          reasoning: 'Can handle',
          confidence: 0.9,
        },
        externalReasoning: {
          compatibleServices: [],
          canCollaborate: false,
          reasoning: 'No peers available',
        },
        combinedReasoning: {
          canHandleInternally: true,
          canCollaborate: false,
          recommendedStrategy: 'direct' as const,
          reasoning: 'Handle internally',
        },
        summary: 'Task can be handled with internal resources',
      };

      const formatted = composer.formatForLLM(mockResult);

      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Internal');
      expect(formatted).toContain('Collaboration');
    });

    it('should include strategy information in formatted output', () => {
      const mockResult = {
        internalReasoning: {
          canHandle: false,
          matchingResources: [],
          missingCapabilities: ['hvac-control'],
          reasoning: 'Missing HVAC control',
          confidence: 0.3,
        },
        externalReasoning: {
          compatibleServices: [
            { serviceId: 's1', serviceName: 'HVAC Service', businessCapabilitySpec: 'HVAC Control', compatibilityScore: 0.85, collaborationHints: [] },
          ],
          canCollaborate: true,
          reasoning: 'Found compatible service',
        },
        combinedReasoning: {
          canHandleInternally: false,
          canCollaborate: true,
          recommendedStrategy: 'collaborative' as const,
          reasoning: 'Collaborate with HVAC service',
        },
        summary: 'Collaboration recommended',
      };

      const formatted = composer.formatForLLM(mockResult);

      expect(formatted).toContain('Strategy');
      expect(formatted).toContain('collaborative');
    });
  });

  describe('toOntologyResource', () => {
    it('should convert DeviceStateInfo to ontology resource format', () => {
      const deviceInfo: DeviceStateInfo = {
        id: 'device-1',
        name: 'Temp Sensor',
        type: 'sensor',
        location: 'living-room',
        capabilities: ['temperature-reading'],
        currentState: { temperature: 22 },
        isOnline: true,
        resourceOntology: createMockResourceOntology(),
      };

      const ontologyResource = composer.toOntologyResource(deviceInfo);

      expect(ontologyResource.id).toBe('device-1');
      expect(ontologyResource.name).toBe('Temp Sensor');
      expect(ontologyResource.type).toBe('sensor');
      expect(ontologyResource.ontology).toBeDefined();
    });

    it('should handle device without ontology', () => {
      const deviceInfo: DeviceStateInfo = {
        id: 'device-2',
        name: 'Basic Device',
        type: 'actuator',
        capabilities: ['control'],
        currentState: {},
        isOnline: true,
      };

      const ontologyResource = composer.toOntologyResource(deviceInfo);

      expect(ontologyResource.id).toBe('device-2');
      expect(ontologyResource.ontology).toBeUndefined();
    });
  });

  describe('toOntologyService', () => {
    it('should convert ServiceInfo to ontology service format', () => {
      const serviceInfo: ServiceInfo = {
        id: 'service-1',
        name: 'Temperature Service',
        providerAgentId: 'agent-1',
        providerAgentName: 'Test Agent',
        category: 'monitoring',
        capabilities: ['read-temperature'],
        status: 'available',
        serviceOntology: createMockServiceOntology(),
      };

      const ontologyService = composer.toOntologyService(serviceInfo);

      expect(ontologyService.id).toBe('service-1');
      expect(ontologyService.name).toBe('Temperature Service');
      expect(ontologyService.ontology).toBeDefined();
    });

    it('should handle service without ontology', () => {
      const serviceInfo: ServiceInfo = {
        id: 'service-2',
        name: 'Basic Service',
        providerAgentId: 'agent-1',
        providerAgentName: 'Test Agent',
        category: 'general',
        capabilities: [],
        status: 'available',
      };

      const ontologyService = composer.toOntologyService(serviceInfo);

      expect(ontologyService.id).toBe('service-2');
      expect(ontologyService.ontology).toBeUndefined();
    });
  });

  describe('Integration with ReasoningEngine', () => {
    it('should use OntologyReasoningEngine for internal reasoning', async () => {
      const task = 'What is the temperature?';
      const resources: DeviceStateInfo[] = [
        {
          id: 'device-1',
          name: 'Temperature Sensor',
          type: 'sensor',
          location: 'room-1',
          capabilities: ['temperature-reading'],
          currentState: { temperature: 22 },
          isOnline: true,
          resourceOntology: createMockResourceOntology({
            ontologyClass: 'ssn:TemperatureSensor' as ResourceOntologyClass,
            rawCapabilities: [{ name: 'temperature-reading', type: 'read' }],
          }),
        },
      ];
      const services = { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] };

      const result = await composer.composeForTask(task, resources, services, []);

      expect(result.internalReasoning).toBeDefined();
      expect(result.internalReasoning?.matchingResources).toBeDefined();
    });

    it('should use OntologyReasoningEngine for external reasoning', async () => {
      const task = 'Who can help with HVAC?';
      const resources: DeviceStateInfo[] = [];
      const services = { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] };
      const peers: PeerAgentInfo[] = [
        {
          id: 'agent-2',
          name: 'Climate Agent',
          capabilities: ['hvac'],
          services: [
            {
              id: 'hvac-service',
              name: 'HVAC Service',
              providerAgentId: 'agent-2',
              providerAgentName: 'Climate Agent',
              category: 'control',
              capabilities: ['hvac-control'],
              status: 'available',
              serviceOntology: createMockServiceOntology({
                businessCapability: {
                  name: 'HVAC Control',
                  description: 'Control HVAC systems',
                  inputs: [],
                  outputs: [],
                },
              }),
            },
          ],
          status: 'online',
        },
      ];

      const result = await composer.composeForTask(task, resources, services, peers);

      expect(result.externalReasoning).toBeDefined();
    });
  });
});
