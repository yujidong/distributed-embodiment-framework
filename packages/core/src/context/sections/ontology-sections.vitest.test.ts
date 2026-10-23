/**
 * Tests for Ontology Context Sections
 *
 * Tests for OntologyResourcesSection, OntologyServicesSection, OntologyReasoningSection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OntologyResourcesSection } from './OntologyResourcesSection.js';
import { OntologyServicesSection } from './OntologyServicesSection.js';
import { OntologyReasoningSection } from './OntologyReasoningSection.js';
import type { SectionContext } from './ContextSection.js';
import type { DeviceStateInfo, ServiceInfo } from '../AgentContextBuilder.js';
import type { ResourceOntology, ResourceOntologyClass } from '../../resource/Resource.js';
import type { ServiceOntology, ServiceOntologyClass, ServiceType } from '../../service/SemanticService.js';
import type { CombinedReasoningResult } from '../../ontology/OntologyReasoningEngine.js';

/**
 * Helper function to create a mock ResourceOntology
 */
function createMockResourceOntology(overrides: Partial<ResourceOntology> = {}): ResourceOntology {
  return {
    ontologyClass: 'ssn:TemperatureSensor' as ResourceOntologyClass,
    semanticDescription: {
      what: 'Temperature Sensor',
      purpose: 'Monitor ambient temperature',
      constraints: ['Accuracy: +/-0.5C'],
    },
    spatialContext: {
      location: 'living-room',
      position: { x: 1, y: 2, z: 0 },
      zone: 'zone-1',
      coverage: ['living-room', 'kitchen'],
    },
    rawCapabilities: [
      { name: 'temperature-reading', type: 'read', description: 'Read temperature' },
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
      description: 'Monitor ambient temperature',
      inputs: [],
      outputs: [{ name: 'temperature', type: 'number', unit: 'celsius' }],
      guarantees: ['Accuracy: +/-0.5C'],
    },
    dependencies: [{ type: 'resource', id: 'device-1', requiredCapabilities: ['temperature-reading'] }],
    spatialContext: {
      location: 'living-room',
      zones: ['zone-1'],
      source: 'inherited',
    },
    semanticContext: {
      businessDescription: 'Temperature monitoring service',
      applicableScenarios: ['home-comfort', 'energy-efficiency'],
      collaborationHints: ['Works well with HVAC control services'],
    },
    ...overrides,
  };
}

/**
 * Helper function to create a mock SectionContext
 */
function createMockSectionContext(overrides: Partial<SectionContext> = {}): SectionContext {
  return {
    agent: {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'Test agent',
      capabilities: ['sense', 'actuate'],
      status: 'online',
    },
    environment: {
      id: 'env-1',
      name: 'Test Environment',
      type: 'smart-home',
    },
    resources: [],
    services: { own: [], fromPeers: [] },
    peers: [],
    temporal: { currentTime: new Date() },
    ...overrides,
  };
}

describe('OntologyResourcesSection', () => {
  let section: OntologyResourcesSection;

  beforeEach(() => {
    section = new OntologyResourcesSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('ontology-resources');
    expect(section.priority).toBe(85);
  });

  it('should not include when no resources have ontology', () => {
    const context = createMockSectionContext({
      resources: [
        { id: 'd1', name: 'Device', type: 'sensor', capabilities: [], currentState: {}, isOnline: true },
      ],
    });
    expect(section.shouldInclude(context)).toBe(false);
  });

  it('should include when resources have ontology', () => {
    const context = createMockSectionContext({
      resources: [
        {
          id: 'd1',
          name: 'Temperature Sensor',
          type: 'sensor',
          capabilities: ['temperature-reading'],
          currentState: {},
          isOnline: true,
          resourceOntology: createMockResourceOntology(),
        },
      ],
    });
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should build ontology resources content', async () => {
    const context = createMockSectionContext({
      resources: [
        {
          id: 'device-1',
          name: 'Temperature Sensor',
          type: 'sensor',
          location: 'living-room',
          capabilities: ['temperature-reading'],
          currentState: { temperature: 22.5 },
          isOnline: true,
          resourceOntology: createMockResourceOntology(),
        },
      ],
    });
    const content = await section.build(context);

    expect(content).toContain('## Resource Ontology');
    expect(content).toContain('Temperature Sensor');
    expect(content).toContain('ssn:TemperatureSensor');
    expect(content).toContain('Monitor ambient temperature');
    expect(content).toContain('living-room');
    expect(content).toContain('temperature-reading');
  });

  it('should include spatial context when available', async () => {
    const context = createMockSectionContext({
      resources: [
        {
          id: 'device-1',
          name: 'Sensor with Position',
          type: 'sensor',
          capabilities: [],
          currentState: {},
          isOnline: true,
          resourceOntology: createMockResourceOntology({
            spatialContext: {
              location: 'kitchen',
              position: { x: 5, y: 3, z: 0 },
              zone: 'cooking-zone',
            },
          }),
        },
      ],
    });
    const content = await section.build(context);

    expect(content).toContain('Spatial Context');
    expect(content).toContain('kitchen');
  });

  it('should include capabilities when available', async () => {
    const context = createMockSectionContext({
      resources: [
        {
          id: 'device-1',
          name: 'Multi-capability Device',
          type: 'hybrid',
          capabilities: ['temperature', 'humidity', 'pressure'],
          currentState: {},
          isOnline: true,
          resourceOntology: createMockResourceOntology({
            rawCapabilities: [
              { name: 'temperature', type: 'read' },
              { name: 'humidity', type: 'read' },
              { name: 'pressure', type: 'read' },
            ],
          }),
        },
      ],
    });
    const content = await section.build(context);

    expect(content).toContain('Capabilities');
    expect(content).toContain('temperature, humidity, pressure');
  });
});

describe('OntologyServicesSection', () => {
  let section: OntologyServicesSection;

  beforeEach(() => {
    section = new OntologyServicesSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('ontology-services');
    expect(section.priority).toBe(75);
  });

  it('should not include when no services have ontology', () => {
    const context = createMockSectionContext({
      services: {
        own: [{ id: 's1', name: 'Service', providerAgentId: 'a1', providerAgentName: 'A1', category: 'test', capabilities: [], status: 'available' }],
        fromPeers: [],
      },
    });
    expect(section.shouldInclude(context)).toBe(false);
  });

  it('should include when own services have ontology', () => {
    const context = createMockSectionContext({
      services: {
        own: [
          {
            id: 's1',
            name: 'Temperature Service',
            providerAgentId: 'agent-1',
            providerAgentName: 'Test Agent',
            category: 'monitoring',
            capabilities: ['read-temperature'],
            status: 'available',
            serviceOntology: createMockServiceOntology(),
          },
        ],
        fromPeers: [],
      },
    });
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should include when peer services have ontology', () => {
    const context = createMockSectionContext({
      services: {
        own: [],
        fromPeers: [
          {
            id: 's1',
            name: 'Peer Service',
            providerAgentId: 'agent-2',
            providerAgentName: 'Peer Agent',
            category: 'control',
            capabilities: ['hvac-control'],
            status: 'available',
            serviceOntology: createMockServiceOntology(),
          },
        ],
      },
    });
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should build own services ontology content', async () => {
    const context = createMockSectionContext({
      services: {
        own: [
          {
            id: 'service-1',
            name: 'Temperature Monitoring',
            providerAgentId: 'agent-1',
            providerAgentName: 'Test Agent',
            category: 'monitoring',
            capabilities: ['read-temperature'],
            status: 'available',
            serviceOntology: createMockServiceOntology(),
          },
        ],
        fromPeers: [],
      },
    });
    const content = await section.build(context);

    expect(content).toContain('## Service Ontology');
    expect(content).toContain('Temperature Monitoring');
    expect(content).toContain('(Own)');
    expect(content).toContain('ssn:TemperatureObservation');
    expect(content).toContain('Temperature Monitoring');
  });

  it('should build peer services ontology content', async () => {
    const context = createMockSectionContext({
      services: {
        own: [],
        fromPeers: [
          {
            id: 'peer-service-1',
            name: 'HVAC Control',
            providerAgentId: 'agent-2',
            providerAgentName: 'Climate Agent',
            category: 'control',
            capabilities: ['hvac-control'],
            status: 'available',
            serviceOntology: createMockServiceOntology({
              businessCapability: {
                name: 'HVAC Control',
                description: 'Control heating and cooling',
                inputs: [{ name: 'targetTemp', type: 'number', unit: 'celsius' }],
                outputs: [],
              },
              semanticContext: {
                businessDescription: 'HVAC control service',
                applicableScenarios: ['climate-control'],
                collaborationHints: ['Works with temperature sensors'],
              },
            }),
          },
        ],
      },
    });
    const content = await section.build(context);

    expect(content).toContain('HVAC Control');
    expect(content).toContain('(Peer)');
    expect(content).toContain('climate-control');
  });

  it('should include collaboration hints', async () => {
    const context = createMockSectionContext({
      services: {
        own: [
          {
            id: 'service-1',
            name: 'Temperature Service',
            providerAgentId: 'agent-1',
            providerAgentName: 'Test Agent',
            category: 'monitoring',
            capabilities: [],
            status: 'available',
            serviceOntology: createMockServiceOntology(),
          },
        ],
        fromPeers: [],
      },
    });
    const content = await section.build(context);

    expect(content).toContain('Collaboration Hints');
    expect(content).toContain('HVAC control');
  });

  it('should include dependencies', async () => {
    const context = createMockSectionContext({
      services: {
        own: [
          {
            id: 'service-1',
            name: 'Temperature Service',
            providerAgentId: 'agent-1',
            providerAgentName: 'Test Agent',
            category: 'monitoring',
            capabilities: [],
            status: 'available',
            serviceOntology: createMockServiceOntology({
              dependencies: [
                { type: 'resource', id: 'device-1', requiredCapabilities: ['temperature'] },
                { type: 'service', id: 'data-service', requiredCapabilities: ['storage'] },
              ],
            }),
          },
        ],
        fromPeers: [],
      },
    });
    const content = await section.build(context);

    expect(content).toContain('Dependencies');
    expect(content).toContain('resource');
    expect(content).toContain('service');
  });
});

describe('OntologyReasoningSection', () => {
  let section: OntologyReasoningSection;

  beforeEach(() => {
    section = new OntologyReasoningSection();
  });

  it('should have correct id and priority', () => {
    expect(section.id).toBe('ontology-reasoning');
    expect(section.priority).toBe(50);
  });

  it('should not include when no ontology reasoning is available', () => {
    const context = createMockSectionContext();
    expect(section.shouldInclude(context)).toBe(false);
  });

  it('should include when ontology reasoning is available', () => {
    const mockReasoning: CombinedReasoningResult = {
      canHandleInternally: true,
      canCollaborate: false,
      recommendedStrategy: 'direct',
      reasoning: 'Can handle internally',
    };
    const context = createMockSectionContext({ ontologyReasoning: mockReasoning });
    expect(section.shouldInclude(context)).toBe(true);
  });

  it('should build internal reasoning content', async () => {
    const mockReasoning: CombinedReasoningResult = {
      canHandleInternally: true,
      canCollaborate: false,
      recommendedStrategy: 'direct',
      internalReasoning: {
        canHandle: true,
        matchingResources: [
          { id: 'device-1', name: 'Temperature Sensor', ontologyClass: 'ssn:TemperatureSensor', capabilities: ['temperature'] },
        ],
        missingCapabilities: [],
        reasoning: 'Found matching resources',
        confidence: 0.9,
      },
      reasoning: 'Can handle internally',
    };
    const context = createMockSectionContext({ ontologyReasoning: mockReasoning });
    const content = await section.build(context);

    expect(content).toContain('## Ontology Reasoning Analysis');
    expect(content).toContain('Internal Capability Analysis');
    expect(content).toContain('Can Handle Internally');
    expect(content).toContain('Yes');
    expect(content).toContain('Temperature Sensor');
  });

  it('should build collaboration reasoning content', async () => {
    const mockReasoning: CombinedReasoningResult = {
      canHandleInternally: false,
      canCollaborate: true,
      recommendedStrategy: 'collaborative',
      externalReasoning: {
        compatibleServices: [
          { serviceId: 'service-1', serviceName: 'HVAC Service', businessCapabilitySpec: 'HVAC Control', compatibilityScore: 0.85, collaborationHints: [] },
        ],
        canCollaborate: true,
        reasoning: 'Found compatible peer services',
      },
      reasoning: 'Collaboration recommended',
    };
    const context = createMockSectionContext({ ontologyReasoning: mockReasoning });
    const content = await section.build(context);

    expect(content).toContain('Collaboration Analysis');
    expect(content).toContain('Compatible Services');
    expect(content).toContain('HVAC Service');
  });

  it('should build recommended strategy content', async () => {
    const mockReasoning: CombinedReasoningResult = {
      canHandleInternally: false,
      canCollaborate: true,
      recommendedStrategy: 'collaborative',
      combinedReasoning: {
        confidence: 0.85,
        recommendedStrategy: 'collaborative',
      },
      reasoning: 'Collaboration recommended',
    } as unknown as CombinedReasoningResult;
    const context = createMockSectionContext({ ontologyReasoning: mockReasoning });
    const content = await section.build(context);

    expect(content).toContain('Recommended Strategy');
    expect(content).toContain('collaborative');
    expect(content).toContain('85%');
  });

  it('should handle missing internal reasoning', async () => {
    const mockReasoning: CombinedReasoningResult = {
      canHandleInternally: false,
      canCollaborate: false,
      recommendedStrategy: 'decomposed',
      reasoning: 'Cannot handle directly',
    };
    const context = createMockSectionContext({ ontologyReasoning: mockReasoning });
    const content = await section.build(context);

    expect(content).toContain('## Ontology Reasoning Analysis');
    expect(content).toContain('Can Handle Internally');
    expect(content).toContain('No');
  });
});

describe('Ontology Section Priority Ordering', () => {
  it('should have correct priority ordering relative to basic sections', () => {
    const ontologyResources = new OntologyResourcesSection();
    const ontologyServices = new OntologyServicesSection();
    const ontologyReasoning = new OntologyReasoningSection();

    // OntologyResourcesSection should be after ResourcesSection (90) but before ServicesSection (80)
    expect(ontologyResources.priority).toBeLessThan(90);
    expect(ontologyResources.priority).toBeGreaterThan(80);

    // OntologyServicesSection should be after ServicesSection (80) but before PeersSection (70)
    expect(ontologyServices.priority).toBeLessThan(80);
    expect(ontologyServices.priority).toBeGreaterThan(70);

    // OntologyReasoningSection should be after TaskSection (60) but before TemporalSection (40)
    expect(ontologyReasoning.priority).toBeLessThan(60);
    expect(ontologyReasoning.priority).toBeGreaterThan(40);
  });
});
