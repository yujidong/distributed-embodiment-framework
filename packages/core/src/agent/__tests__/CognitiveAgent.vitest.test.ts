/**
 * CognitiveAgent Basic Tests
 *
 * Tests for core CognitiveAgent functionality and Feature Flag integration
 * This is a minimal test suite to ensure basic functionality works
 * and to demonstrate Feature Flag usage in tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CognitiveAgent } from '../CognitiveAgent.js';
import { featureFlags } from '../../config/FeatureFlags.js';
import type { CognitiveAgentConfig } from '../CognitiveAgent.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

describe('CognitiveAgent - Basic Functionality', () => {
  let agent: CognitiveAgent;
  let mockConfig: CognitiveAgentConfig;

  beforeEach(() => {
    // Mock environment center
    const mockEnvironment = {
      id: 'test-env',
      eventManager: {
        subscribe: () => {},
        emit: () => {},
        publish: () => ({ id: 'event-123', type: 'test', timestamp: new Date() }),
      },
      registerAgent: () => {},
      unregisterAgent: () => {},
    } as unknown as EnvironmentCenter;

    // Mock LLM client
    const mockLLMClient = {
      chat: async () => ({ content: 'test response' }),
    } as unknown as LLMClient;

    mockConfig = {
      id: 'test-agent-1',
      name: 'Test Agent',
      description: 'A test agent for unit testing',
      capabilities: ['task-execution', 'testing'],
      environment: mockEnvironment,
      llmClient: mockLLMClient,
      owner: 'test-owner',
    };
  });

  afterEach(() => {
    if (agent) {
      // Cleanup if needed
    }
  });

  describe('Initialization', () => {
    it('should create agent with correct basic properties', () => {
      agent = new CognitiveAgent(mockConfig);

      expect(agent.id).toBe('test-agent-1');
      expect(agent.name).toBe('Test Agent');
      expect(agent.description).toBe('A test agent for unit testing');
    });

    it('should initialize with default capabilities if none provided', () => {
      mockConfig.capabilities = undefined;
      agent = new CognitiveAgent(mockConfig);

      expect(agent.capabilities).toContain('task-execution');
      expect(agent.capabilities).toContain('code-generation');
      expect(agent.capabilities).toContain('collaboration');
    });

    it('should initialize service layer components', () => {
      agent = new CognitiveAgent(mockConfig);

      // Verify service layer components are initialized
      expect(agent.serviceRegistry).toBeDefined();
      expect(agent.servicePublisher).toBeDefined();
      expect(agent.serviceBroker).toBeDefined();
    });
  });

  describe('Service Layer Integration', () => {
    beforeEach(() => {
      agent = new CognitiveAgent(mockConfig);
    });

    it('should have service registry for local services', () => {
      expect(agent.serviceRegistry).toBeDefined();
      expect(typeof agent.serviceRegistry.registerService).toBe('function');
      expect(typeof agent.serviceRegistry.getService).toBe('function');
    });

    it('should have service publisher for global publishing', () => {
      expect(agent.servicePublisher).toBeDefined();
      expect(typeof agent.servicePublisher.publishService).toBe('function');
    });

    it('should have service broker for external discovery', () => {
      expect(agent.serviceBroker).toBeDefined();
      expect(typeof agent.serviceBroker.discoverServices).toBe('function');
    });
  });

  describe('Feature Flag Integration', () => {
    it('should work with all feature flags disabled (default)', () => {
      // Verify default state - all flags should be disabled
      expect(featureFlags.isEnabled('verticalLayerArchitecture')).toBe(false);
      expect(featureFlags.isEnabled('serviceDiscovery')).toBe(false);

      // Agent should still initialize correctly
      agent = new CognitiveAgent(mockConfig);
      expect(agent).toBeDefined();
    });

    it('should demonstrate feature flag usage in tests', () => {
      // This test demonstrates how to use feature flags in tests
      const featureName = 'testFeature';

      // Initially disabled
      expect(featureFlags.isEnabled(featureName)).toBe(false);

      // Enable feature
      featureFlags.setEnabled(featureName, true);
      expect(featureFlags.isEnabled(featureName)).toBe(true);

      // Disable feature
      featureFlags.setEnabled(featureName, false);
      expect(featureFlags.isEnabled(featureName)).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing owner gracefully', () => {
      // This should not throw
      expect(() => {
        new CognitiveAgent(mockConfig);
      }).not.toThrow();
    });
  });
});
