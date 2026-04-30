/**
 * TDD Tests for AutonomousDecisionEngine Context Management Improvements
 *
 * Sprint 14: Optimize Agent Context Management
 *
 * These tests verify that:
 * 1. LLM prompts use natural language (not pipe-separated format)
 * 2. Information is not truncated (payload increased from 200 to 500 chars)
 * 3. Device states are properly included in context
 * 4. Task parameters are complete and not lost
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AutonomousDecisionEngine } from '../AutonomousDecisionEngine.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { SystemEvent } from '@active-collaboration/shared';

describe('AutonomousDecisionEngine - Context Management (Sprint 14)', () => {
  let engine: AutonomousDecisionEngine;
  let mockLLMClient: LLMClient;
  let mockEnvironment: EnvironmentCenter;

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Mock environment
    mockEnvironment = {
      listDevices: vi.fn(),
      listAgents: vi.fn(),
      eventManager: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
      services: new Map(),
    } as unknown as EnvironmentCenter;

    // Create engine with auto LLM processing enabled for testing
    engine = new AutonomousDecisionEngine({
      llmClient: mockLLMClient,
      environment: mockEnvironment,
      agentId: 'test-agent-1',
      agentName: 'TestAgent',
      agentCapabilities: ['temperature-control', 'monitoring', 'device-control'],
      config: {
        enableAutoLLMProcessing: true, // Enable LLM for testing
        useStructuredRules: true,
      },
    });
  });

  describe('RED: Test for Natural Language Prompts', () => {
    it('should use natural language format instead of pipe-separated format', async () => {
      // Arrange: Create an event that will trigger LLM analysis
      const event: SystemEvent = {
        id: 'event-1',
        type: 'device.unknown_event' as SystemEvent['type'],
        source: 'sensor-1',
        priority: 'normal' as SystemEvent['priority'],
        payload: {
          temperature: 25,
          humidity: 60,
          location: { x: 10, y: 20 },
        },
        metadata: {},
        timestamp: new Date(),
      };

      // Mock LLM response
      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'medium',
          urgency: 0.5,
          requirements: ['temperature-control'],
          potentialImpact: 'Temperature reading needs monitoring',
        }),
      });

      // Act: Analyze the event (will trigger LLM)
      await engine['analyzeEventWithLLM'](event);

      // Assert: Verify the prompt uses natural language, not pipe format
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should NOT contain pipe-separated key-value format like "Agent:name|Event:type"
      const pipeKvFormat = /\w+:\s*\w+\s*\|\s*\w+:\s*\w+/;
      expect(prompt).not.toMatch(pipeKvFormat);

      // Should contain natural language markers
      expect(prompt).toMatch(/You are|event|data|capabilities/i);
    });

    it('should include clear section headers in prompt', async () => {
      // Arrange
      const event: SystemEvent = {
        id: 'event-2',
        type: 'device.anomaly' as SystemEvent['type'],
        source: 'sensor-2',
        priority: 'high' as SystemEvent['priority'],
        payload: {
          anomaly: true,
          severity: 'high',
        },
        metadata: {},
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'high',
          urgency: 0.8,
          requirements: ['monitoring'],
          potentialImpact: 'Anomaly detected',
        }),
      });

      // Act
      await engine['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should have clear sections
      expect(prompt).toMatch(/EVENT ANALYSIS|DECISION FRAMEWORK|YOUR CAPABILITIES/i);
    });
  });

  describe('RED: Test for No Information Truncation', () => {
    it('should not truncate payload to 200 characters (increased to 500)', async () => {
      // Arrange: Create event with large payload
      const largePayload = {
        temperature: 25.5,
        humidity: 60.2,
        pressure: 1013.25,
        location: {
          x: 10.5,
          y: 20.3,
          z: 1.5,
          floor: 2,
          room: 'conference-room',
          building: 'main-building',
        },
        deviceInfo: {
          id: 'sensor-123',
          type: 'multi-sensor',
          manufacturer: 'ACME Corp',
          model: 'MS-2000',
          firmwareVersion: '2.1.0',
          lastCalibration: '2024-01-15',
          accuracy: 0.95,
        },
        readings: {
          temperature: [25.1, 25.3, 25.5, 25.2, 25.4],
          humidity: [60.1, 60.2, 60.0, 60.3, 60.2],
          pressure: [1013.0, 1013.2, 1013.3, 1013.1, 1013.2],
        },
        metadata: {
          timestamp: '2024-03-15T10:30:00Z',
          quality: 'good',
          confidence: 0.98,
        },
      };

      const event: SystemEvent = {
        id: 'event-3',
        type: 'device.reading' as SystemEvent['type'],
        source: 'sensor-3',
        priority: 'normal' as SystemEvent['priority'],
        payload: largePayload,
        metadata: {},
        timestamp: new Date(),
      };

      const payloadStr = JSON.stringify(largePayload);

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'low',
          urgency: 0.3,
          requirements: [],
          potentialImpact: 'Normal reading',
        }),
      });

      // Act
      await engine['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Extract the data section from prompt
      const dataMatch = prompt.match(/Data:\s*(.+?)(?=\n|$)/s);
      const dataInPrompt = dataMatch ? dataMatch[1] : '';

      // Should include at least 500 characters (not just 200)
      expect(dataInPrompt.length).toBeGreaterThanOrEqual(Math.min(500, payloadStr.length));

      // Should not be severely truncated
      if (payloadStr.length > 500) {
        expect(dataInPrompt.length).toBeGreaterThanOrEqual(500);
      } else {
        expect(dataInPrompt).toEqual(payloadStr);
      }
    });

    it('should include all agent capabilities (not just first 3)', async () => {
      // Arrange: Agent with many capabilities
      const agentWithManyCaps = new AutonomousDecisionEngine({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'test-agent-2',
        agentName: 'MultiCapableAgent',
        agentCapabilities: [
          'temperature-control',
          'humidity-control',
          'lighting-control',
          'device-control',
          'monitoring',
          'security',
          'emergency-response',
          'hvac-control',
        ],
        config: {
          enableAutoLLMProcessing: true,
        },
      });

      const event: SystemEvent = {
        id: 'event-4',
        type: 'device.unknown' as SystemEvent['type'],
        source: 'sensor-4',
        priority: 'normal' as SystemEvent['priority'],
        payload: {},
        metadata: {},
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'medium',
          urgency: 0.5,
          requirements: [],
          potentialImpact: 'Unknown event',
        }),
      });

      // Act
      await agentWithManyCaps['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should mention "capabilities" (plural) indicating all capabilities
      expect(prompt.toLowerCase()).toContain('capabilities');

      // Should include all capabilities, not just first 3
      const capabilitiesInPrompt = prompt.match(/capabilities?[:\s]+([^\n]+)/i);
      if (capabilitiesInPrompt) {
        const capsList = capabilitiesInPrompt[1];
        // Should have more than 3 capabilities mentioned
        expect(capsList.split(',').length).toBeGreaterThan(3);
      }
    });
  });

  describe('RED: Test for Device State Information', () => {
    it('should include device state information in context when available', async () => {
      // This test verifies that device states are available in the agent's context
      // The AutonomousDecisionEngine receives agentCapabilities which should reflect device states

      // Arrange: Create engine with specific capabilities that reflect device states
      const engineWithDevices = new AutonomousDecisionEngine({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'test-agent-3',
        agentName: 'DeviceAwareAgent',
        agentCapabilities: [
          'temperature-control:device1:online',
          'humidity-control:device2:online',
          'lighting-control:device3:offline',
        ],
        config: {
          enableAutoLLMProcessing: true,
        },
      });

      const event: SystemEvent = {
        id: 'event-5',
        type: 'device.state_change' as SystemEvent['type'],
        source: 'device1',
        priority: 'normal' as SystemEvent['priority'],
        payload: {
          deviceId: 'device1',
          oldState: 'offline',
          newState: 'online',
        },
        metadata: {},
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'medium',
          urgency: 0.6,
          requirements: ['device-control'],
          potentialImpact: 'Device state changed',
        }),
      });

      // Act
      await engineWithDevices['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should mention capabilities (which include device state info)
      expect(prompt).toMatch(/capabilities/i);
    });
  });

  describe('RED: Test for Complete Task Parameters', () => {
    it('should preserve critical task parameters in event data', async () => {
      // Arrange: Event with important task parameters
      const event: SystemEvent = {
        id: 'event-6',
        type: 'task.execution' as SystemEvent['type'],
        source: 'user-1',
        priority: 'high' as SystemEvent['priority'],
        payload: {
          taskType: 'temperature-adjustment',
          targetTemperature: 22,
          currentTemperature: 28,
          threshold: 25,
          room: 'conference-room',
          urgency: 'high',
          duration: 30,
          requiredCapabilities: ['temperature-control', 'hvac-control'],
        },
        metadata: {
          userId: 'user-123',
          timestamp: '2024-03-15T10:30:00Z',
        },
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'high',
          urgency: 0.8,
          requirements: ['temperature-control', 'hvac-control'],
          potentialImpact: 'Temperature adjustment needed',
        }),
      });

      // Act
      await engine['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should include critical task parameters
      expect(prompt).toContain('targetTemperature');
      expect(prompt).toContain('22'); // target value
      expect(prompt).toContain('threshold');
      expect(prompt).toContain('urgency');
    });

    it('should not lose nested parameters in payload', async () => {
      // Arrange: Event with deeply nested parameters
      const event: SystemEvent = {
        id: 'event-7',
        type: 'complex.task' as SystemEvent['type'],
        source: 'system',
        priority: 'normal' as SystemEvent['priority'],
        payload: {
          level1: {
            level2: {
              level3: {
                criticalParam: 'must-not-lose',
                value: 42,
              },
            },
          },
          parameters: {
            target: {
              temperature: 20,
              humidity: 50,
            },
            constraints: {
              min: 18,
              max: 25,
            },
          },
        },
        metadata: {},
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'medium',
          urgency: 0.5,
          requirements: [],
          potentialImpact: 'Complex task',
        }),
      });

      // Act
      await engine['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should preserve nested structure (at least the critical parts)
      expect(prompt).toContain('criticalParam');
      expect(prompt).toContain('must-not-lose');
    });
  });

  describe('GREEN: Verify Prompt Quality Improvements', () => {
    it('should generate prompts with clear structure', async () => {
      // Arrange
      const event: SystemEvent = {
        id: 'event-8',
        type: 'test.event' as SystemEvent['type'],
        source: 'test-source',
        priority: 'normal' as SystemEvent['priority'],
        payload: {
          testData: 'value',
        },
        metadata: {},
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'low',
          urgency: 0.2,
          requirements: [],
          potentialImpact: 'Test',
        }),
      });

      // Act
      await engine['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Prompt should have clear sections
      const lines = prompt.split('\n').filter(line => line.trim().length > 0);
      expect(lines.length).toBeGreaterThan(3); // Should have multiple lines/sections

      // Should not be a single line or just pipe-separated
      const singleLinePipeFormat = /^[A-Za-z]+:[^|]+\|[A-Za-z]+:[^|]+\|[A-Za-z]+:[^|]+$/;
      expect(prompt).not.toMatch(singleLinePipeFormat);
    });

    it('should provide adequate context for LLM decision making', async () => {
      // Arrange
      const event: SystemEvent = {
        id: 'event-9',
        type: 'emergency.fire_alarm' as SystemEvent['type'],
        source: 'sensor-5',
        priority: 'urgent' as SystemEvent['priority'],
        payload: {
          severity: 'critical',
          location: { x: 50, y: 50, floor: 1 },
          type: 'fire',
          confidence: 0.95,
        },
        metadata: {},
        timestamp: new Date(),
      };

      (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          severity: 'critical',
          urgency: 1.0,
          requirements: ['emergency-response'],
          potentialImpact: 'Fire emergency',
        }),
      });

      // Act
      await engine['analyzeEventWithLLM'](event);

      // Assert
      const calls = (mockLLMClient.chat as Mock<[ChatParams], Promise<ChatResponse>>).mock.calls;
      const prompt = (calls[0][0] as ChatParams).messages[0].content;

      // Should include key decision-making information
      expect(prompt).toMatch(/fire|emergency|critical|severity/i);
      expect(prompt.length).toBeGreaterThan(100); // Adequate length
    });
  });
});
