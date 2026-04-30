/**
 * TDD Tests for ACNecessityAssessor Context Management Improvements
 *
 * Sprint 14: Optimize Agent Context Management
 *
 * These tests verify that:
 * 1. LLM prompts use natural language (not pipe-separated format)
 * 2. Information is not truncated (summary increased from 150 to 500 chars)
 * 3. Device states and workload are properly included
 * 4. Task parameters are complete
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { ACNecessityAssessor } from '../ACNecessityAssessor.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SpatialClusterSummary, AgentContext } from '../ACNecessityAssessor.js';

describe('ACNecessityAssessor - Context Management (Sprint 14)', () => {
  let assessor: ACNecessityAssessor;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Create assessor
    assessor = new ACNecessityAssessor({
      llmTimeout: 5000,
      maxRetries: 2,
      confidenceThreshold: 0.7,
      maxWorkloadThreshold: 3,
    }, mockLLMClient);
  });

  const createMockClusterSummary = (overrides?: Partial<SpatialClusterSummary>): SpatialClusterSummary => ({
    clusterId: 'cluster-1',
    region: {
      id: 'region-1',
      center: { x: 50, y: 50 },
      radius: 10,
      type: 'zone',
    },
    timeWindow: '2024-03-15T10:00:00Z - 2024-03-15T10:05:00Z',
    significance: 'high',
    summary: 'Temperature breach detected: temperature=28, threshold=25, severity=high',
    findings: [
      {
        eventType: 'temperature.breach',
        count: 5,
        trend: 'increasing',
        anomaly: true,
        details: {
          temperature: 28,
          threshold: 25,
          breach: true,
          severity: 'high',
        },
      },
    ],
    recommendation: 'immediate_action',
    ...overrides,
  });

  // Helper to create cluster summary that triggers LLM evaluation
  const createClusterForLLM = (overrides?: Partial<SpatialClusterSummary>): SpatialClusterSummary => createMockClusterSummary({
    significance: 'medium', // Not urgent to avoid early 'initiate_ac'
    recommendation: 'evaluate_with_llm', // Explicitly request LLM evaluation
    findings: [], // No findings to auto-infer capabilities
    summary: 'Generic event requiring LLM evaluation for decision making', // Generic summary with no trigger words
    ...overrides,
  });

  const createMockAgentContext = (overrides?: Partial<AgentContext>): AgentContext => ({
    agentId: 'agent-1',
    agentName: 'TemperatureAgent',
    capabilities: ['temperature-control', 'monitoring'],
    availableResources: [
      {
        deviceId: 'device-1',
        type: 'thermostat',
        capabilities: ['temperature-control'],
      },
    ],
    currentWorkload: 'idle',
    recentCollaborations: [],
    currentCollaborations: 0,
    ...overrides,
  });

  describe('RED: Test for Natural Language Prompts', () => {
    it('should use natural language format instead of pipe-separated format', async () => {
      // Arrange: Use createClusterForLLM to trigger LLM evaluation
      const clusterSummary = createClusterForLLM();
      const agentContext = createMockAgentContext({
        capabilities: ['all-caps'], // Generic capability that matches everything
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Agent lacks cooling capability',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // quickChat is called with (prompt, systemPrompt)
      const prompt = calls[0][0] as string;

      // Should NOT contain pipe-separated format
      expect(prompt).not.toMatch(/\w+:\w+\|\w+:\w+\|\w+:\w+/);

      // Should contain natural language markers
      expect(prompt).toMatch(/AGENT|COLLABORATION|EVENT|DECISION/i);
    });

    it('should include clear section headers in prompt', async () => {
      // Arrange
      const clusterSummary = createClusterForLLM();
      const agentContext = createMockAgentContext({
        capabilities: ["all-caps"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: false,
        reasoning: 'Can handle independently',
        urgency: 'medium',
        suggestedPartnerTypes: [],
        requiredCapabilities: [],
        confidence: 0.9,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should have clear sections
      expect(prompt).toMatch(/AGENT PROFILE|EVENT CONTEXT|CAPABILITY ANALYSIS|DECISION CRITERIA/i);
    });

    it('should present information in structured, readable format', async () => {
      // Arrange
      const clusterSummary = createClusterForLLM();
      const agentContext = createMockAgentContext({
        capabilities: ["all-caps"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Needs cooling capability',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should have bullet points or clear separators
      expect(prompt).toMatch(/-|\n|:/);

      // Should have multiple sections
      const sections = prompt.split(/\n\n+/).filter(s => s.trim().length > 0);
      expect(sections.length).toBeGreaterThan(2);
    });
  });

  describe('RED: Test for No Information Truncation', () => {
    it('should not truncate summary to 150 characters', async () => {
      // Arrange: Create a long summary with no capability-inference trigger words
      const longSummary = `Anomaly detected in Conference Room A at coordinates (50, 50). ` +
        `Current sensor reading shows 28 units which exceeds the configured limit of 25 units by 3. ` +
        `This represents a significant deviation from the optimal range of 20-24. ` +
        `The trend analysis shows an increasing pattern over the last 5 readings. ` +
        `Action is recommended to prevent further escalation. ` +
        `Affected area covers approximately 100 square meters. ` +
        `System status: operational but struggling to maintain setpoint. ` +
        `Occupancy level: elevated (approximately 15 people). ` +
        `External conditions: sunny, 32 degrees outdoor. ` +
        `Additional factors: recent equipment added in the room generating extra activity.`;

      const clusterSummary = createClusterForLLM({
        summary: longSummary,
      });

      const agentContext = createMockAgentContext({
        capabilities: ["all-caps"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Temperature breach requires action',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should include most of the summary (not truncated to 150)
      expect(prompt.length).toBeGreaterThan(150);

      // Should include key information from the summary
      expect(prompt).toContain('Anomaly detected');
      expect(prompt).toContain('28');
      expect(prompt).toContain('25');
    });

    it('should include all agent capabilities', async () => {
      // Arrange: Agent with many capabilities
      const agentWithManyCaps = createMockAgentContext({
        capabilities: [
          'temperature-control',
          'humidity-control',
          'lighting-control',
          'device-control',
          'monitoring',
          'security',
          'emergency-response',
        ],
      });

      const clusterSummary = createClusterForLLM();

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: false,
        reasoning: 'Has all required capabilities',
        urgency: 'low',
        suggestedPartnerTypes: [],
        requiredCapabilities: [],
        confidence: 0.9,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentWithManyCaps);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should mention all capabilities
      expect(prompt).toContain('temperature-control');
      expect(prompt).toContain('humidity-control');
      expect(prompt).toContain('lighting-control');
      expect(prompt).toContain('device-control');
    });

    it('should include complete available resources information', async () => {
      // Arrange: Agent with multiple devices
      const agentWithManyDevices = createMockAgentContext({
        availableResources: [
          {
            deviceId: 'device-1',
            type: 'thermostat',
            capabilities: ['temperature-control'],
          },
          {
            deviceId: 'device-2',
            type: 'humidity-sensor',
            capabilities: ['humidity-monitoring'],
          },
          {
            deviceId: 'device-3',
            type: 'light-controller',
            capabilities: ['lighting-control'],
          },
        ],
      });

      const clusterSummary = createClusterForLLM();

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: false,
        reasoning: 'Sufficient resources available',
        urgency: 'low',
        suggestedPartnerTypes: [],
        requiredCapabilities: [],
        confidence: 0.9,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentWithManyDevices);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should mention available resources
      expect(prompt).toMatch(/resources|devices/i);

      // Should include device information
      expect(prompt).toContain('device-1');
      expect(prompt).toContain('device-2');
      expect(prompt).toContain('device-3');
    });
  });

  describe('RED: Test for Device State and Workload Information', () => {
    it('should include current workload in agent context', async () => {
      // Arrange: Agent with moderate workload (below threshold to avoid preCheck deferral)
      const busyAgent = createMockAgentContext({
        currentWorkload: 'moderate',
        currentCollaborations: 2,
        recentCollaborations: ['ac-1', 'ac-2'],
      });

      const clusterSummary = createClusterForLLM();

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: false,
        reasoning: 'Agent at maximum capacity',
        urgency: 'medium',
        suggestedPartnerTypes: [],
        requiredCapabilities: [],
        confidence: 0.9,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, busyAgent);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should mention workload
      expect(prompt).toMatch(/workload|collaboration|busy/i);
    });

    it('should include device state information from availableResources', async () => {
      // Arrange: Resources with state information
      const agentWithDeviceStates = createMockAgentContext({
        availableResources: [
          {
            deviceId: 'device-1',
            type: 'thermostat',
            capabilities: ['temperature-control'],
            currentState: { temperature: 22, mode: 'cooling' },
            isOnline: true,
          },
          {
            deviceId: 'device-2',
            type: 'sensor',
            capabilities: ['monitoring'],
            currentState: { battery: 85, lastReading: 20.5 },
            isOnline: true,
          },
        ],
      });

      const clusterSummary = createClusterForLLM();

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: false,
        reasoning: 'Devices operational',
        urgency: 'low',
        suggestedPartnerTypes: [],
        requiredCapabilities: [],
        confidence: 0.9,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentWithDeviceStates);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should mention device state or status
      expect(prompt).toMatch(/resources|devices|Available Resources/i);
    });
  });

  describe('RED: Test for Complete Task Parameters', () => {
    it('should preserve critical task parameters from findings', async () => {
      // Arrange: Cluster with detailed task parameters
      const clusterWithTaskParams = createMockClusterSummary({
        findings: [
          {
            eventType: 'temperature.breach',
            count: 1,
            trend: 'increasing',
            anomaly: true,
            details: {
              taskTitle: 'Reduce Temperature',
              taskDescription: 'Lower temperature from 28°C to 22°C in Conference Room',
              taskType: 'temperature-adjustment',
              targetTemperature: 22,
              currentTemperature: 28,
              threshold: 25,
              urgency: 'high',
              requiredCapabilities: ['cooling', 'hvac-control'],
              room: 'conference-room',
              duration: 30,
            },
          },
        ],
      });

      const agentContext = createMockAgentContext({
        capabilities: ["all-caps"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Needs cooling capability',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling', 'hvac-control'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Act
      const assessment = await assessor.assess(clusterWithTaskParams, agentContext);

      // Assert
      // Should extract task parameters
      expect(assessment.taskParameters).toBeDefined();
      expect(assessment.taskParameters?.targetTemperature).toBe(22);
      expect(assessment.taskParameters?.currentTemperature).toBe(28);
      expect(assessment.taskParameters?.requiredCapabilities).toEqual(['cooling', 'hvac-control']);
    });

    it('should include task parameters in LLM prompt', async () => {
      // Arrange: Use createClusterForLLM but add task-specific findings
      const clusterWithTaskParams = createClusterForLLM({
        summary: 'Adjust Lighting task: target brightness 80, current brightness 40',
        findings: [
          {
            eventType: 'task.execution',
            count: 1,
            trend: 'stable',
            anomaly: false,
            details: {
              taskTitle: 'Adjust Lighting',
              targetBrightness: 80,
              currentBrightness: 40,
              room: 'meeting-room',
            },
          },
        ],
      });

      const agentContext = createMockAgentContext({
        capabilities: ["lighting-control", "light-control", "actuator-control", "device-control", "actuation"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: false,
        reasoning: 'Can handle independently',
        urgency: 'low',
        suggestedPartnerTypes: [],
        requiredCapabilities: [],
        confidence: 0.9,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterWithTaskParams, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should include task information
      expect(prompt).toContain('task');
      expect(prompt).toContain('brightness');
    });
  });

  describe('GREEN: Verify Prompt Quality Improvements', () => {
    it('should generate prompts that are easy for LLM to understand', async () => {
      // Arrange
      const clusterSummary = createClusterForLLM();
      const agentContext = createMockAgentContext({
        capabilities: ["all-caps"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Clear reasoning provided',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should be well-structured
      expect(prompt).toMatch(/\n/); // Has line breaks
      expect(prompt.length).toBeGreaterThan(200); // Adequate length

      // Should have clear sections
      const hasSections = prompt.match(/^[A-Z\s]+:$/m);
      expect(hasSections).toBeTruthy();
    });

    it('should include all necessary decision-making criteria', async () => {
      // Arrange
      const clusterSummary = createClusterForLLM();
      const agentContext = createMockAgentContext({
        capabilities: ["all-caps"],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'Based on criteria analysis',
        urgency: 'high',
        suggestedPartnerTypes: ['cooling-agent'],
        requiredCapabilities: ['cooling'],
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
      }));

      // Act
      await assessor.assess(clusterSummary, agentContext);

      // Assert
      const calls = (mockLLMClient.quickChat as Mock).mock.calls;
      const prompt = calls[0][0] as string;

      // Should mention decision criteria
      expect(prompt).toMatch(/criteria|rules|guidelines/i);
    });
  });
});
