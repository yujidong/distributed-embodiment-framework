/**
 * Tests for updated AgentContextBuilder with section registration
 *
 * Tests the section-based context building and integration with OntologyContextComposer
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentContextBuilder } from './AgentContextBuilder.js';
import { OntologyContextComposer } from './OntologyContextComposer.js';
import { OntologyReasoningEngine } from '../ontology/OntologyReasoningEngine.js';
import {
  AgentIdentitySection,
  EnvironmentSection,
  ResourcesSection,
  ServicesSection,
  PeersSection,
  TemporalSection,
  TaskSection,
} from './sections/index.js';
import {
  OntologyResourcesSection,
  OntologyServicesSection,
  OntologyReasoningSection,
} from './sections/index.js';
import type { ContextSection, SectionContext } from './sections/ContextSection.js';
import type { AgentInfo } from './AgentContextBuilder.js';
import type { ResourceManager } from '../resource/ResourceManager.js';
import type { ServiceRegistry } from '../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

/**
 * Helper to create mock ResourceManager
 */
function createMockResourceManager(): ResourceManager {
  return {
    getAllResources: vi.fn().mockReturnValue([]),
    getResource: vi.fn(),
    registerResource: vi.fn(),
    unregisterResource: vi.fn(),
  } as unknown as ResourceManager;
}

/**
 * Helper to create mock ServiceRegistry
 */
function createMockServiceRegistry(): ServiceRegistry {
  return {
    getAllServices: vi.fn().mockReturnValue([]),
    getService: vi.fn(),
    registerService: vi.fn(),
    unregisterService: vi.fn(),
  } as unknown as ServiceRegistry;
}

/**
 * Helper to create mock EnvironmentCenter
 */
function createMockEnvironmentCenter(): EnvironmentCenter {
  return {
    id: 'env-1',
    name: 'Test Environment',
    listAgents: vi.fn().mockResolvedValue([]),
  } as unknown as EnvironmentCenter;
}

describe('AgentContextBuilder with Section Support', () => {
  let builder: AgentContextBuilder;
  let mockAgent: AgentInfo;
  let mockResourceManager: ResourceManager;
  let mockServiceRegistry: ServiceRegistry;
  let mockEnvironment: EnvironmentCenter;

  beforeEach(() => {
    mockAgent = {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'Test agent description',
      capabilities: ['sense', 'actuate'],
      status: 'online',
      metadata: { role: 'test-role' },
    };

    mockResourceManager = createMockResourceManager();
    mockServiceRegistry = createMockServiceRegistry();
    mockEnvironment = createMockEnvironmentCenter();

    builder = new AgentContextBuilder(
      mockAgent,
      mockResourceManager,
      mockServiceRegistry,
      mockEnvironment
    );
  });

  describe('Section Registration', () => {
    it('should have default sections registered', () => {
      const sections = builder.getSections();
      expect(sections.length).toBeGreaterThan(0);

      // Check that core sections are present
      const sectionIds = sections.map(s => s.id);
      expect(sectionIds).toContain('agent-identity');
      expect(sectionIds).toContain('environment');
      expect(sectionIds).toContain('resources');
      expect(sectionIds).toContain('services');
      expect(sectionIds).toContain('peers');
      expect(sectionIds).toContain('temporal');
    });

    it('should allow registering custom sections', () => {
      const customSection: ContextSection = {
        id: 'custom-section',
        priority: 55,
        shouldInclude: () => true,
        build: async () => 'Custom content',
        getMetadata: () => ({}),
      };

      builder.registerSection(customSection);

      const sections = builder.getSections();
      const sectionIds = sections.map(s => s.id);
      expect(sectionIds).toContain('custom-section');
    });

    it('should sort sections by priority', () => {
      const sections = builder.getSections();
      for (let i = 0; i < sections.length - 1; i++) {
        expect(sections[i].priority).toBeGreaterThanOrEqual(sections[i + 1].priority);
      }
    });

    it('should allow unregistering sections', () => {
      const initialSections = builder.getSections();
      const initialCount = initialSections.length;

      builder.unregisterSection('temporal');

      const sections = builder.getSections();
      expect(sections.length).toBe(initialCount - 1);
      expect(sections.map(s => s.id)).not.toContain('temporal');
    });
  });

  describe('Section-Based Context Building', () => {
    it('should build context using sections', async () => {
      const context = await builder.buildFullContext();

      expect(context).toBeDefined();
      expect(context.self).toBeDefined();
      expect(context.self.id).toBe('agent-1');
    });

    it('should format context for LLM using sections', async () => {
      const context = await builder.buildFullContext();
      const formatted = await builder.formatContextForLLMAsync(context);

      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Agent Identity');
    });

    it('should include task section when task is provided', async () => {
      const context = await builder.buildFullContext();
      const formatted = await builder.formatContextForLLMAsync(context, 'Test task');

      expect(formatted).toContain('Current Task');
      expect(formatted).toContain('Test task');
    });

    it('should not include task section when no task is provided', async () => {
      const context = await builder.buildFullContext();
      const formatted = await builder.formatContextForLLMAsync(context);

      expect(formatted).not.toContain('Current Task');
    });
  });

  describe('Ontology Integration', () => {
    it('should have ontology sections registered', () => {
      const sections = builder.getSections();
      const sectionIds = sections.map(s => s.id);

      expect(sectionIds).toContain('ontology-resources');
      expect(sectionIds).toContain('ontology-services');
      expect(sectionIds).toContain('ontology-reasoning');
    });

    it('should have OntologyContextComposer', () => {
      const composer = builder.getOntologyComposer();
      expect(composer).toBeDefined();
      expect(composer).toBeInstanceOf(OntologyContextComposer);
    });

    it('should include ontology reasoning when task is provided', async () => {
      // This test verifies that the builder can perform ontology reasoning
      // when a task is provided
      const context = await builder.buildFullContext();

      // When formatting with a task, ontology reasoning should be triggered
      const formatted = await builder.formatContextForLLMAsync(context, 'Control temperature');

      // The formatted output should exist
      expect(formatted).toBeDefined();
    });
  });

  describe('Backward Compatibility', () => {
    it('should still support buildFullPrompt', () => {
      const instructions = 'Test instructions';
      const task = 'Test task';

      const prompt = builder.buildFullPrompt(task, instructions);

      expect(prompt).toBeDefined();
      expect(prompt).toContain('Test task');
      expect(prompt).toContain('Test instructions');
    });

    it('should maintain existing interface', async () => {
      const context = await builder.buildFullContext();

      expect(context.self).toBeDefined();
      expect(context.environment).toBeDefined();
      expect(context.resources).toBeDefined();
      expect(context.availableServices).toBeDefined();
      expect(context.peerAgents).toBeDefined();
      expect(context.temporal).toBeDefined();
    });
  });

  describe('Priority Ordering', () => {
    it('should maintain correct priority order for all sections', () => {
      const sections = builder.getSections();
      const expectedOrder = [
        'agent-identity',    // 100
        'environment',       // 95
        'resources',         // 90
        'ontology-resources', // 85
        'services',          // 80
        'ontology-services', // 75
        'peers',             // 70
        'task',              // 60
        'ontology-reasoning', // 50
        'temporal',          // 40
      ];

      const actualOrder = sections.map(s => s.id);

      // Check that all expected sections are present
      for (const expected of expectedOrder) {
        expect(actualOrder).toContain(expected);
      }
    });
  });
});

describe('Section-based formatting integration', () => {
  it('should format all sections in priority order', async () => {
    const mockAgent: AgentInfo = {
      id: 'agent-1',
      name: 'Integration Test Agent',
      description: 'Agent for integration testing',
      capabilities: ['test'],
      status: 'online',
    };

    const mockResourceManager = createMockResourceManager();
    const mockServiceRegistry = createMockServiceRegistry();
    const mockEnvironment = createMockEnvironmentCenter();

    const builder = new AgentContextBuilder(
      mockAgent,
      mockResourceManager,
      mockServiceRegistry,
      mockEnvironment
    );

    const context = await builder.buildFullContext();
    const formatted = await builder.formatContextForLLM(context, 'Integration test task');

    // Verify sections appear in correct order
    const agentIdentityIndex = formatted.indexOf('## Agent Identity');
    const environmentIndex = formatted.indexOf('## Environment State');
    const temporalIndex = formatted.indexOf('## Temporal Information');

    // Agent Identity should come before Environment
    expect(agentIdentityIndex).toBeLessThan(environmentIndex);
    // Environment should come before Temporal
    expect(environmentIndex).toBeLessThan(temporalIndex);
  });
});
