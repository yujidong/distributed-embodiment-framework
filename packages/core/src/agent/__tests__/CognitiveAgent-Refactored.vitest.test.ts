/**
 * CognitiveAgent Integration Tests (Refactored Version)
 *
 * Tests for the refactored CognitiveAgent using coordinator pattern
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CognitiveAgent } from '../CognitiveAgent.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { Device, DeviceType, SystemEvent } from '@active-collaboration/shared';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenterData } from '../../environment/types.js';

describe('CognitiveAgent', () => {
  let agent: CognitiveAgent;
  let environment: EnvironmentCenter;

  const mockLLMClient = {
    generateResponse: async () => 'test response',
    generateEmbedding: async () => [0.1, 0.2, 0.3],
  };

  const createTestDevice = (id: string, name: string): Device => ({
    id,
    name,
    type: 'sensor' as DeviceType,
    capabilities: [
      {
        name: 'temperature-sensing',
        type: 'read' as const,
        parameters: []
      }
    ],
    location: 'test-location',
    currentState: { temperature: 25 }
  } as unknown as Device);

  beforeEach(() => {
    // Create environment (no start/stop needed)
    environment = new EnvironmentCenter({
      id: 'test-env',
      name: 'Test Environment',
      createdBy: 'test-user',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as EnvironmentCenterData);

    // Create agent
    agent = new CognitiveAgent({
      id: 'test-agent-001',
      name: 'Test Agent',
      description: 'Test agent for validation',
      owner: 'test-user',
      environment,
      llmClient: mockLLMClient as unknown as LLMClient,
      capabilities: ['test-capability']
    });
  });

  afterEach(() => {
    if (agent) {
      agent.stop();
    }
  });

  describe('Initialization', () => {
    it('should initialize with correct properties', () => {
      expect(agent.id).toBe('test-agent-001');
      expect(agent.name).toBe('Test Agent');
      expect(agent.type).toBe('cognitive');
      expect(agent.status).toBe('idle');
      expect(agent.capabilities).toContain('test-capability');
    });

    it('should initialize all core managers', () => {
      expect(agent.resourceManager).toBeDefined();
      expect(agent.taskManager).toBeDefined();
      expect(agent.dialogueManager).toBeDefined();
      expect(agent.collaborationManager).toBeDefined();
      expect(agent.serviceRegistry).toBeDefined();
    });

    it('should initialize event system', () => {
      expect(agent.eventManager).toBeDefined();
      expect(agent.eventEmitter).toBeDefined();
    });
  });

  describe('Lifecycle Management', () => {
    it('should start correctly', () => {
      agent.start();
      expect(agent.status).toBe('idle');
    });

    it('should stop correctly', () => {
      agent.start();
      agent.stop();
      expect(agent.status).toBe('stopped');
    });

    it('should restart correctly', () => {
      agent.start();
      agent.stop();
      agent.start();
      expect(agent.status).toBe('idle');
    });
  });

  describe('Device Management', () => {
    it('should assign devices', () => {
      const device = createTestDevice('device-1', 'Temperature Sensor');
      agent.assignDevices([device], 'test-user');

      const stats = agent.getStats();
      expect(stats.deviceCount).toBe(1);
    });

    it('should handle multiple device assignments', () => {
      const devices = [
        createTestDevice('device-1', 'Temperature Sensor'),
        createTestDevice('device-2', 'Humidity Sensor'),
      ];
      agent.assignDevices(devices, 'test-user');

      const stats = agent.getStats();
      expect(stats.deviceCount).toBe(2);
    });
  });

  describe('Collaboration Management', () => {
    it('should get active collaborations', () => {
      const collaborations = agent.getActiveCollaborations();
      expect(Array.isArray(collaborations)).toBe(true);
    });

    it('should handle withdrawal request', async () => {
      const result = await agent.withdrawFromCollaboration(
        'collab-1',
        'Test withdrawal'
      );
      expect(result).toHaveProperty('success');
    });

    it('should handle dissolution proposal', async () => {
      const result = await agent.proposeDissolution(
        'collab-1',
        'Test dissolution'
      );
      expect(result).toHaveProperty('success');
    });

    it('should handle dissolution vote', async () => {
      const result = await agent.voteOnDissolution('proposal-1', true);
      expect(result).toHaveProperty('success');
    });
  });

  describe('Service Execution', () => {
    it('should handle device capability execution', async () => {
      const result = await agent.executeDeviceCapability(
        'device-1',
        'temperature-sensing'
      );
      expect(result).toHaveProperty('success');
    });

    it('should handle service request', async () => {
      const result = await agent.requestService(
        'agent-2',
        'service-1'
      );
      expect(result).toHaveProperty('success');
    });
  });

  describe('Environment Observation', () => {
    it('should observe environment parameters', async () => {
      const observations = await agent.observeEnvironment(['temperature']);
      expect(typeof observations).toBe('object');
    });
  });

  describe('Event Handling', () => {
    it('should handle events', async () => {
      const event = {
        id: 'event-1',
        type: 'TEST_EVENT' as SystemEvent['type'],
        timestamp: new Date(),
        source: 'test',
        priority: 'normal' as const,
        payload: { data: 'test' },
        metadata: {}
      } as unknown as SystemEvent;

      await expect(agent.handleEvent(event)).resolves.not.toThrow();
    });
  });

  describe('Communication', () => {
    it('should communicate with other agents', async () => {
      await expect(
        agent.communicateWithAgent('agent-2', 'Hello')
      ).resolves.not.toThrow();
    });
  });

  describe('Metadata Management', () => {
    it('should get stats', () => {
      const stats = agent.getStats();
      expect(stats).toHaveProperty('status');
      expect(stats).toHaveProperty('deviceCount');
      expect(stats).toHaveProperty('serviceCount');
      expect(stats).toHaveProperty('collaborationCount');
    });

    it('should get info', () => {
      const info = agent.getInfo();
      expect(info.id).toBe('test-agent-001');
      expect(info.name).toBe('Test Agent');
      expect(info.type).toBe('cognitive');
    });

    it('should update name', () => {
      agent.updateName('Updated Agent');
      expect(agent.name).toBe('Updated Agent');
    });

    it('should update metadata', () => {
      agent.updateMetadata({ testKey: 'testValue' });
      expect(agent.metadata.testKey).toBe('testValue');
    });
  });
});
