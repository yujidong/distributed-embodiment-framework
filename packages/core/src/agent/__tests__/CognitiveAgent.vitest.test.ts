/**
 * CognitiveAgent Basic Tests
 *
 * Tests for core CognitiveAgent functionality and Feature Flag integration
 * This is a minimal test suite to ensure basic functionality works
 * and to demonstrate Feature Flag usage in tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CognitiveAgent } from '../CognitiveAgent.js';
import { featureFlags } from '../../config/FeatureFlags.js';
import type { CognitiveAgentConfig } from '../CognitiveAgent.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ResourceManager } from '../../resource/ResourceManager.js';
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

  // T-712 (R29, F9): agent-lane actor attribution. The auto-actuation lane
  // used to reach the device with no invocation context, so secure-state
  // audit fields (lock accessLog, lastActionBy) fell back to 'unknown'.
  // The agent now attributes itself (`agent:<agentId>`), mirroring the flow
  // lane's `flow:<flowId>` (T-608). Verified here with a mock device spying
  // on the third (invocation-context) argument.
  describe('T-712: agent-lane actor attribution', () => {
    const makeDevice = () => {
      const executeCommand = vi.fn(async () => ({ success: true, result: {} }));
      const device = {
        id: 'lab-door-lock',
        name: 'Lab Door Lock',
        type: 'door-lock',
        status: 'online',
        location: 'lab-a',
        capabilities: [{ name: 'unlock', type: 'write' }],
        executeCommand,
      } as unknown as Parameters<ResourceManager['registerDevice']>[0];
      return { device, executeCommand };
    };

    beforeEach(() => {
      agent = new CognitiveAgent({ ...mockConfig, id: 'LabOps-agent' });
    });

    it('executeDeviceCommand without an actor attributes agent:<agentId>', async () => {
      const { device, executeCommand } = makeDevice();
      agent.resourceManager.registerDevice(device, 'test-owner');

      const result = await agent.executeDeviceCommand('lab-door-lock', 'unlock');
      expect(result.success).toBe(true);
      expect(executeCommand).toHaveBeenCalledWith(
        'unlock',
        undefined,
        { actor: 'agent:LabOps-agent' },
      );
    });

    it('an explicit actor (user label, flow id) always wins', async () => {
      const { device, executeCommand } = makeDevice();
      agent.resourceManager.registerDevice(device, 'test-owner');

      await agent.executeDeviceCommand('lab-door-lock', 'unlock', undefined, {
        actor: 'flow:overheat-guard',
      });
      expect(executeCommand).toHaveBeenCalledWith(
        'unlock',
        undefined,
        { actor: 'flow:overheat-guard' },
      );
    });

    it('executeDeviceCapability without a context attributes agent:<agentId>', async () => {
      const { device, executeCommand } = makeDevice();
      agent.resourceManager.registerDevice(device, 'test-owner');

      // The AC auto-actuation lane (ACExecutor) calls with no 4th argument.
      const result = await agent.executeDeviceCapability('lab-door-lock', 'unlock');
      expect(result.success).toBe(true);
      expect(executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.objectContaining({ actor: 'agent:LabOps-agent' }),
      );
    });
  });

  // R40-C2 (design §7.1): the decision-quality metrics ride the experiment
  // export — projected through the same B2 summary face the eval report
  // uses (honest nulls until an outcome reconciles, never fabricated 0.5s).
  describe('exportExperimentData decisionQuality', () => {
    it('exports honest nulls when no cognitive decisions were recorded', () => {
      agent = new CognitiveAgent(mockConfig);
      const data = agent.exportExperimentData();

      expect(data.decisionQuality).toBeDefined();
      expect(data.decisionQuality.decisionCount).toBe(0);
      expect(data.decisionQuality.evaluatedDecisions).toBe(0);
      expect(data.decisionQuality.calibrationScore).toBeNull();
      expect(data.decisionQuality.successRate).toBeNull();
    });

    it('exports the quality ring aggregation once decisions reconcile to outcomes', () => {
      agent = new CognitiveAgent(mockConfig);
      const meta = agent.getDualTriggerACManager()?.getMetaCognition();
      expect(meta).toBeDefined();
      // One independent decision with an actuation lane → outcome 'success'.
      meta!.noteAssessment({
        action: 'handle_independently',
        confidence: 0.8,
        hasCognitiveDeviceActions: true,
        hasInvokeFlow: false,
        plannedCommandCount: 0,
      });

      const data = agent.exportExperimentData();
      expect(data.decisionQuality.decisionCount).toBe(1);
      expect(data.decisionQuality.evaluatedDecisions).toBe(1);
      expect(data.decisionQuality.successRate).toBe(1);
      // 1 − ECE with one bucket (predicted 0.8, actual 1.0) → 0.8.
      expect(data.decisionQuality.calibrationScore).toBe(0.8);
    });
  });
});
