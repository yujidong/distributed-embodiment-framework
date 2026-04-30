/**
 * Tests for ContextSection Interface and SectionContext
 *
 * These tests verify the foundation of the section-based context architecture.
 */

import { describe, it, expect } from 'vitest';
import type { ContextSection, SectionContext } from './ContextSection.js';
import type { AgentInfo, DeviceStateInfo, ServiceInfo, PeerAgentInfo, EnvironmentState } from '../AgentContextBuilder.js';
import type { CombinedReasoningResult } from '../../ontology/OntologyReasoningEngine.js';

describe('ContextSection Interface', () => {
  it('should define required properties on ContextSection', () => {
    // Create a mock implementation to verify interface structure
    const mockSection: ContextSection = {
      id: 'test-section',
      priority: 50,
      shouldInclude: (context: SectionContext) => true,
      build: async (context: SectionContext) => 'Test content',
      getMetadata: () => ({ version: '1.0' }),
    };

    expect(mockSection.id).toBe('test-section');
    expect(mockSection.priority).toBe(50);
    expect(typeof mockSection.shouldInclude).toBe('function');
    expect(typeof mockSection.build).toBe('function');
    expect(typeof mockSection.getMetadata).toBe('function');
  });

  it('should allow sections to have different priorities', () => {
    const highPrioritySection: ContextSection = {
      id: 'high-priority',
      priority: 100,
      shouldInclude: () => true,
      build: async () => 'High priority content',
      getMetadata: () => ({}),
    };

    const lowPrioritySection: ContextSection = {
      id: 'low-priority',
      priority: 10,
      shouldInclude: () => true,
      build: async () => 'Low priority content',
      getMetadata: () => ({}),
    };

    expect(highPrioritySection.priority).toBeGreaterThan(lowPrioritySection.priority);
  });

  it('should support async build method', async () => {
    const asyncSection: ContextSection = {
      id: 'async-section',
      priority: 50,
      shouldInclude: () => true,
      build: async () => {
        // Simulate async operation
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'Async content';
      },
      getMetadata: () => ({}),
    };

    const result = await asyncSection.build({} as SectionContext);
    expect(result).toBe('Async content');
  });
});

describe('SectionContext Interface', () => {
  it('should have all required context properties', () => {
    const mockAgent: AgentInfo = {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'Test agent description',
      capabilities: ['sense', 'actuate'],
      status: 'online',
    };

    const mockEnvironment: EnvironmentState = {
      id: 'env-1',
      name: 'Test Environment',
      type: 'smart-home',
    };

    const mockResources: DeviceStateInfo[] = [
      {
        id: 'device-1',
        name: 'Temperature Sensor',
        type: 'sensor',
        location: 'living-room',
        capabilities: ['temperature-reading'],
        currentState: { temperature: 22.5 },
        isOnline: true,
      },
    ];

    const mockServices: ServiceInfo[] = [
      {
        id: 'service-1',
        name: 'Temperature Service',
        providerAgentId: 'agent-1',
        providerAgentName: 'Test Agent',
        category: 'monitoring',
        capabilities: ['read-temperature'],
        status: 'available',
      },
    ];

    const mockPeers: PeerAgentInfo[] = [
      {
        id: 'agent-2',
        name: 'Peer Agent',
        capabilities: ['control'],
        services: [],
        status: 'online',
      },
    ];

    const sectionContext: SectionContext = {
      agent: mockAgent,
      environment: mockEnvironment,
      resources: mockResources,
      services: {
        own: mockServices,
        fromPeers: [],
      },
      peers: mockPeers,
      temporal: {
        currentTime: new Date(),
      },
    };

    expect(sectionContext.agent).toBe(mockAgent);
    expect(sectionContext.environment).toBe(mockEnvironment);
    expect(sectionContext.resources).toBe(mockResources);
    expect(sectionContext.services.own).toBe(mockServices);
    expect(sectionContext.peers).toBe(mockPeers);
    expect(sectionContext.temporal).toBeDefined();
    expect(sectionContext.task).toBeUndefined();
    expect(sectionContext.ontologyReasoning).toBeUndefined();
  });

  it('should support optional task property', () => {
    const sectionContext: SectionContext = {
      agent: {} as AgentInfo,
      environment: {} as EnvironmentState,
      resources: [],
      services: { own: [], fromPeers: [] },
      peers: [],
      temporal: { currentTime: new Date() },
      task: 'Control temperature in living room',
    };

    expect(sectionContext.task).toBe('Control temperature in living room');
  });

  it('should support optional ontologyReasoning property', () => {
    const mockReasoning: CombinedReasoningResult = {
      canHandleInternally: true,
      canCollaborate: false,
      recommendedStrategy: 'direct',
      reasoning: 'Can handle internally',
    };

    const sectionContext: SectionContext = {
      agent: {} as AgentInfo,
      environment: {} as EnvironmentState,
      resources: [],
      services: { own: [], fromPeers: [] },
      peers: [],
      temporal: { currentTime: new Date() },
      ontologyReasoning: mockReasoning,
    };

    expect(sectionContext.ontologyReasoning).toBe(mockReasoning);
  });
});

describe('Section Sorting by Priority', () => {
  it('should sort sections by priority in descending order', () => {
    const sections: ContextSection[] = [
      { id: 'low', priority: 10, shouldInclude: () => true, build: async () => '', getMetadata: () => ({}) },
      { id: 'high', priority: 100, shouldInclude: () => true, build: async () => '', getMetadata: () => ({}) },
      { id: 'mid', priority: 50, shouldInclude: () => true, build: async () => '', getMetadata: () => ({}) },
    ];

    // Sort by priority descending
    const sorted = [...sections].sort((a, b) => b.priority - a.priority);

    expect(sorted[0].id).toBe('high');
    expect(sorted[1].id).toBe('mid');
    expect(sorted[2].id).toBe('low');
  });
});

describe('Section Inclusion Logic', () => {
  it('should include section when shouldInclude returns true', () => {
    const section: ContextSection = {
      id: 'conditional-section',
      priority: 50,
      shouldInclude: (context) => context.task !== undefined,
      build: async () => 'Conditional content',
      getMetadata: () => ({}),
    };

    const contextWithTask: SectionContext = {
      agent: {} as AgentInfo,
      environment: {} as EnvironmentState,
      resources: [],
      services: { own: [], fromPeers: [] },
      peers: [],
      temporal: { currentTime: new Date() },
      task: 'Some task',
    };

    const contextWithoutTask: SectionContext = {
      agent: {} as AgentInfo,
      environment: {} as EnvironmentState,
      resources: [],
      services: { own: [], fromPeers: [] },
      peers: [],
      temporal: { currentTime: new Date() },
    };

    expect(section.shouldInclude(contextWithTask)).toBe(true);
    expect(section.shouldInclude(contextWithoutTask)).toBe(false);
  });

  it('should include section based on resources availability', () => {
    const section: ContextSection = {
      id: 'resource-section',
      priority: 50,
      shouldInclude: (context) => context.resources.length > 0,
      build: async () => 'Resource content',
      getMetadata: () => ({}),
    };

    const contextWithResources: SectionContext = {
      agent: {} as AgentInfo,
      environment: {} as EnvironmentState,
      resources: [{ id: '1', name: 'Device', type: 'sensor', capabilities: [], currentState: {}, isOnline: true }],
      services: { own: [], fromPeers: [] },
      peers: [],
      temporal: { currentTime: new Date() },
    };

    const contextWithoutResources: SectionContext = {
      agent: {} as AgentInfo,
      environment: {} as EnvironmentState,
      resources: [],
      services: { own: [], fromPeers: [] },
      peers: [],
      temporal: { currentTime: new Date() },
    };

    expect(section.shouldInclude(contextWithResources)).toBe(true);
    expect(section.shouldInclude(contextWithoutResources)).toBe(false);
  });
});
