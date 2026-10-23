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
  // Fix-21: reaching the LLM now requires (a) direct actuator coverage of the
  // event zone (otherwise preCheck classifies the agent sensor-only or
  // Type D/E and decides without an LLM call) and (b) a capability gap
  // (otherwise the Type A rule decides 'handle_independently' without an LLM
  // call). The 'power.surge' finding infers 'power-management', which no test
  // fixture below lists in its capabilities.
  const createClusterForLLM = (overrides?: Partial<SpatialClusterSummary>): SpatialClusterSummary => createMockClusterSummary({
    significance: 'medium', // Not urgent to avoid early 'initiate_ac'
    recommendation: 'evaluate_with_llm', // Explicitly request LLM evaluation
    findings: [{
      eventType: 'power.surge',
      count: 1,
      trend: 'stable',
      anomaly: false,
      details: {},
    }],
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
    // Fix-21: direct actuator coverage of region-1 (the default event zone)
    // so preCheck does not classify this agent as sensor-only.
    actuatorZoneIds: ['region-1'],
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

    // Fix-21 SKIPPED: Sprint-14 spec expected a verbose natural-language
    // prompt with named section headers (AGENT PROFILE / EVENT CONTEXT /
    // CAPABILITY ANALYSIS / DECISION CRITERIA). The prompt format was later
    // deliberately redesigned to a compact token-efficient layout
    // (`AGENT: name | Caps=[...]`, EVENT_NEEDS, AVAILABLE_PARTNERS — see
    // buildPrompt), which the ablation experiments depend on. The old
    // section-header format is superseded, not unimplemented.
    it.skip('should include clear section headers in prompt', async () => {
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

      // Fix-21: updated to current prompt format. The compact prompt is a
      // single block of labeled lines (AGENT/EVENT/AVAILABLE_PARTNERS/
      // DECISION) rather than the Sprint-14 verbose multi-paragraph layout.
      // "Structured, readable" now means: multiple distinct labeled lines.
      const labeledLines = prompt
        .split('\n')
        .filter(l => /^[A-Z_]+:/.test(l.trim()));
      expect(labeledLines.length).toBeGreaterThan(2);
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

    // Fix-21 SKIPPED: Sprint-14 spec required embedding the full device
    // inventory (device IDs) in the LLM prompt. The current compact prompt
    // deliberately conveys agent capability via `Caps=[...]` and partner
    // services only; Resource-layer device IDs are intentionally omitted
    // for token efficiency (ablation design). Superseded spec.
    it.skip('should include complete available resources information', async () => {
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

    // Fix-21 SKIPPED: same superseded Sprint-14 spec as
    // 'should include complete available resources information' — the compact
    // prompt format intentionally omits per-device state from the prompt.
    it.skip('should include device state information from availableResources', async () => {
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
          // Fix-21: keep a capability gap so preCheck falls through to the LLM
          // (see createClusterForLLM comment above).
          {
            eventType: 'power.surge',
            count: 1,
            trend: 'stable',
            anomaly: false,
            details: {},
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

    // Fix-21 SKIPPED: Sprint-14 spec expected explicit decision-criteria
    // prose ('criteria|rules|guidelines') in the prompt. The compact prompt
    // instead encodes the decision rule inline (COVERAGE guidance, EVENT_NEEDS
    // comparison, final 'Should this agent initiate collaboration? DECISION:'
    // question). Superseded format spec.
    it.skip('should include all necessary decision-making criteria', async () => {
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

  describe('stored-text cap (T-106)', () => {
    it('caps an oversized reasoning/rawResponse at parse time with a marker', async () => {
      // Plain multi-line answer (FSM path): reasoning = everything after the
      // first line, so the 1MB tail is the stored reasoning.
      const hugeReasoning = 'r'.repeat(1024 * 1024);
      const responseText = `analyzing the event
${hugeReasoning}`;
      (mockLLMClient.quickChat as Mock).mockResolvedValue(responseText);

      const result = await assessor.assess(createClusterForLLM(), createMockAgentContext());

      expect(result.llmAssessment.reasoning!.length).toBeLessThanOrEqual(16 * 1024 + 100);
      expect(result.llmAssessment.reasoning).toMatch(/\[truncated \d+ of 1048576 chars\]$/);
      expect(result.llmAssessment.rawResponse!.length).toBeLessThanOrEqual(16 * 1024 + 100);
      expect(result.llmAssessment.rawResponse).toMatch(/\[truncated/);
    });

    it('keeps short responses byte-identical (no marker)', async () => {
      const responseText = 'analyzing the event\ncovered by own actuator';
      (mockLLMClient.quickChat as Mock).mockResolvedValue(responseText);

      const result = await assessor.assess(createClusterForLLM(), createMockAgentContext());

      expect(result.llmAssessment.reasoning).toBe('covered by own actuator');
      expect(result.llmAssessment.rawResponse).toBe(responseText);
    });
  });

  // ---------------------------------------------------------------------------
  // T-203 — event context in prompts + honest independent/ignore bookkeeping
  // ---------------------------------------------------------------------------

  describe('T-203: event context + independent/ignore honesty', () => {
    it('renders the original event type, parameter and value in the prompt', async () => {
      // RF-F08: two different injected events (footfall-spike vs PM2.5=180)
      // produced the SAME "environment.param_changed ... severity=high"
      // prompt. The cluster summary now carries eventType/parameter/newValue
      // and buildPrompt renders it verbatim.
      const clusterSummary = createClusterForLLM({
        summary: 'Event footfall-spike from engine-runtime:evt-42, parameter=motion-count, newValue=180, severity=high',
      });
      const agentContext = createMockAgentContext();

      (mockLLMClient.quickChat as Mock).mockResolvedValue(JSON.stringify({
        needsCollaboration: true,
        reasoning: 'busy corridor',
        urgency: 'medium',
        suggestedPartnerTypes: [],
        requiredCapabilities: ['surveillance'],
        confidence: 0.8,
        estimatedDuration: 0,
        potentialRisks: [],
      }));

      await assessor.assess(clusterSummary, agentContext);

      const prompt = (mockLLMClient.quickChat as Mock).mock.calls[0][0] as string;
      expect(prompt).toContain('footfall-spike');
      expect(prompt).toContain('parameter=motion-count');
      expect(prompt).toContain('newValue=180');
    });

    /**
     * Cluster that reaches the LLM's final-decision step: the agent has NO
     * actuator zones (sensor-only), and the explicit requiredCapabilities
     * match <2 of its capabilities, so the sensor-only domain gate lets the
     * LLM decide instead of auto-initiating.
     */
    const clusterForFinalDecision = (): SpatialClusterSummary => createClusterForLLM({
      findings: [{
        eventType: 'temperature.breach',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { requiredCapabilities: ['cooling'] },
      }],
      summary: 'Temperature breach detected, trend increasing',
    });

    it('maps an LLM "independent" answer with matching capabilities to handle_independently', async () => {
      // RF-F10: the model answered independent; the required list infers
      // 'cooling', the agent declares only 'temperature-control' — a
      // SYNONYM pair. The old raw substring check failed the match and
      // recorded 'ignore' (eval accuracy 0/2); capabilityMatches accepts
      // it and the decision honors the LLM's independent answer.
      const clusterSummary = clusterForFinalDecision();
      const agentContext = createMockAgentContext({
        capabilities: ['temperature-control'],
        actuatorZoneIds: [],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(
        'DECISION: independent' + '\n' + 'My HVAC equipment covers this event.',
      );

      const result = await assessor.assess(clusterSummary, agentContext);

      expect(result.decision).toBe('handle_independently');
      expect(result.decisionSource).toBe('llm');
      // The recorded raw answer stays the LLM's own (RF-F10 audit trail).
      expect(String(result.llmAssessment.rawResponse)).toContain('independent');
    });

    it('records defer (needs review) — never ignore — on an independent answer with mismatched vocabulary', async () => {
      // The binary LLM answer cannot express "not this agent's
      // responsibility" → a capability mismatch means the decision needs
      // review: defer. 'ignore' stays reserved for the deterministic Type D
      // precheck (low severity / no requirements).
      const clusterSummary = clusterForFinalDecision();
      const agentContext = createMockAgentContext({
        capabilities: ['monitoring'],
        actuatorZoneIds: [],
      });

      (mockLLMClient.quickChat as Mock).mockResolvedValue(
        'DECISION: independent' + '\n' + 'Seems manageable.',
      );

      const result = await assessor.assess(clusterSummary, agentContext);

      expect(result.decision).toBe('defer');
      expect(result.decision).not.toBe('ignore');
    });
  });

  // ---------------------------------------------------------------------------
  // T-041 (R11 corrective) — canonical decision-alias mapping at parse time
  // ---------------------------------------------------------------------------

  describe('T-041: canonical decision aliases + declared-requirement fork', () => {
    /**
     * Custom (user-defined) event type whose payload declares NO
     * requiredCapabilities — the retail-retry footfall-spike shape. The
     * agent has direct actuator coverage, and the inferred keyword table
     * "requires" emergency-response/monitoring for any anomalous non-
     * temp/humidity/light event, so the preChecks fall through to the LLM.
     */
    const customEventCluster = (): SpatialClusterSummary => createClusterForLLM({
      findings: [{
        eventType: 'footfall-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { parameter: 'motion-count', newValue: 180 }, // NO requiredCapabilities
      }],
      summary: 'Event footfall-spike from engine-runtime:evt-42, parameter=motion-count, newValue=180',
    });

    const retailAgent = (): AgentContext => createMockAgentContext({
      agentId: 'retail-agent',
      capabilities: ['lighting-control'],
      actuatorZoneIds: ['region-1'], // direct coverage → not sensor-only
    });

    it.each([
      // (label, LLM answer, structured?)
      ['independent (canonical)', 'DECISION: independent\nBrighten the strip.', false],
      ['handle-it-myself (alias, punctuation)', 'DECISION: handle-it-myself\nI own the lights.', false],
      ['do it myself (alias, spacing)', 'DECISION: do it myself\nMine.', false],
      ['self-handle (alias)', 'DECISION: self-handle\nKnown devices.', false],
      ['on my own (alias)', 'DECISION: on my own\nNo partner needed.', false],
      ['solo (alias)', 'DECISION: solo\nGot it.', false],
      ['Handle-It-Myself (structured JSON)', JSON.stringify({ decision: 'Handle-It-Myself', reasoning: 'own lights' }), true],
      ['independent (structured JSON)', JSON.stringify({ decision: 'independent', reasoning: 'own lights' }), true],
    ])('custom event + no declared requirements + "%s" → handle_independently', async (_label, answer) => {
      const clusterSummary = customEventCluster();
      const agentContext = retailAgent();
      (mockLLMClient.quickChat as Mock).mockResolvedValue(answer);

      const result = await assessor.assess(clusterSummary, agentContext);

      // The audit's exact failure: the inferred keyword table demanded
      // emergency-response/monitoring → every independent answer was stored
      // as defer. Now the AUTHOR declared nothing → the agent (who knows its
      // own devices) handles it.
      expect(result.decision).toBe('handle_independently');
      expect(result.decisionSource).toBe('llm');
      expect(result.llmAssessment.llmDecision).toBe('handle_independently');
      expect(result.llmAssessment.needsCollaboration).toBe(false);
      expect(result.llmAssessment.declaredRequiredCapabilities).toEqual([]);
    });

    it('declared unmet requiredCapabilities + "independent" → defer with an honest reason', async () => {
      const clusterSummary = createClusterForLLM({
        findings: [{
          eventType: 'smoke-detected',
          count: 1,
          trend: 'increasing',
          anomaly: true,
          details: { parameter: 'pm25', newValue: 180, requiredCapabilities: ['air-purification', 'ventilation'] },
        }],
        summary: 'Event smoke-detected, parameter=pm25, newValue=180',
      });
      const agentContext = retailAgent(); // has lighting-control only
      (mockLLMClient.quickChat as Mock).mockResolvedValue('DECISION: independent\nI will try.');

      const result = await assessor.assess(clusterSummary, agentContext);

      expect(result.decision).toBe('defer');
      expect(result.llmAssessment.llmDecision).toBe('handle_independently'); // the model's answer is preserved
      expect(result.llmAssessment.declaredRequiredCapabilities).toEqual(['air-purification', 'ventilation']);
      // Honest reason on the record: WHY the independent answer was downgraded.
      expect(result.llmAssessment.reasoning).toMatch(/deferred: event declares requiredCapabilities/i);
      expect(result.llmAssessment.reasoning).toContain('air-purification');
    });

    it.each([
      ['cooperate', JSON.stringify({ decision: 'cooperate', reasoning: 'need a partner' })],
      ['work-together', JSON.stringify({ decision: 'work-together', reasoning: 'need a partner' })],
      ['partner', JSON.stringify({ decision: 'partner', reasoning: 'need a partner' })],
      ['yes', JSON.stringify({ decision: 'yes', reasoning: 'collaboration needed' })],
      ['collaborate (prose)', 'DECISION: collaborate\nFind a partner.'],
    ])('collaborate alias "%s" → initiate_ac path', async (_label, answer) => {
      const clusterSummary = customEventCluster();
      const agentContext = retailAgent();
      (mockLLMClient.quickChat as Mock).mockResolvedValue(answer);

      const result = await assessor.assess(clusterSummary, agentContext);

      expect(result.decision).toBe('initiate_ac');
      expect(result.llmAssessment.llmDecision).toBe('initiate_ac');
      expect(result.llmAssessment.needsCollaboration).toBe(true);
    });

    it('explicit defer and ignore answers are honored verbatim (aliases survive parsing)', async () => {
      const clusterSummary = customEventCluster();
      const agentContext = retailAgent();

      (mockLLMClient.quickChat as Mock).mockResolvedValue(
        JSON.stringify({ decision: 'escalate', reasoning: 'need human help' }),
      );
      expect((await assessor.assess(clusterSummary, agentContext)).decision).toBe('defer');

      (mockLLMClient.quickChat as Mock).mockResolvedValue(
        JSON.stringify({ decision: 'not-mine', reasoning: 'another agent owns this zone' }),
      );
      expect((await assessor.assess(clusterSummary, agentContext)).decision).toBe('ignore');
    });

    it('unparseable answers keep the safety-first default (initiate_ac)', async () => {
      const clusterSummary = customEventCluster();
      const agentContext = retailAgent();
      (mockLLMClient.quickChat as Mock).mockResolvedValue('Hmm, the weather is nice today.');

      const result = await assessor.assess(clusterSummary, agentContext);

      expect(result.decision).toBe('initiate_ac');
      expect(result.llmAssessment.llmDecision).toBe('initiate_ac');
    });
  });

  describe('T-024-part3: decisionSubSource parse-quality marker', () => {
    /**
     * Which parser won the LLM answer must be observable on the assessment:
     * 'llm-json' = the provider honored the structured-output format,
     * 'llm-fsm' = the prose keyword scanner had to recover the answer.
     * Downstream (recentDecisions, trajectory) uses it to measure
     * structured-output compliance per model/provider.
     */
    const clusterSummary = createClusterForLLM({
      findings: [{
        eventType: 'footfall-spike',
        count: 1,
        trend: 'increasing',
        anomaly: true,
        details: { parameter: 'motion-count', newValue: 180 },
      }],
      summary: 'Event footfall-spike from engine-runtime:evt-42, parameter=motion-count, newValue=180',
    });
    const agentContext = createMockAgentContext({
      agentId: 'retail-agent',
      capabilities: ['lighting-control'],
      actuatorZoneIds: ['region-1'],
    });

    it('a structured {"decision","reasoning"} JSON answer is marked llm-json', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(
        JSON.stringify({ decision: 'collaborate', reasoning: 'need a partner' }),
      );
      const result = await assessor.assess(clusterSummary, agentContext);
      expect(result.decisionSource).toBe('llm');
      expect(result.llmAssessment.decisionSubSource).toBe('llm-json');
    });

    it('a prose answer recovered by the FSM scanner is marked llm-fsm', async () => {
      (mockLLMClient.quickChat as Mock).mockResolvedValue(
        'DECISION: collaborate\nFind a partner.',
      );
      const result = await assessor.assess(clusterSummary, agentContext);
      expect(result.decisionSource).toBe('llm');
      expect(result.llmAssessment.decisionSubSource).toBe('llm-fsm');
    });

    it('rule/precheck decisions never carry the marker', async () => {
      // Sensor-only agent (no actuator coverage of the event zone): Fix-21
      // preCheck decides without any LLM call.
      const covered = createMockClusterSummary({
        significance: 'high',
        recommendation: 'immediate_action',
        findings: [{
          eventType: 'temperature.breach',
          count: 5,
          trend: 'increasing',
          anomaly: true,
          details: {},
        }],
        summary: 'Temperature breach detected: temperature=28, threshold=25',
      });
      const sensorOnly = createMockAgentContext({
        capabilities: ['monitoring'],
        actuatorZoneIds: [], // no direct actuator coverage → preCheck path
      });
      (mockLLMClient.quickChat as Mock).mockResolvedValue('anything');
      const result = await assessor.assess(covered, sensorOnly);
      expect(result.decisionSource).not.toBe('llm');
      expect(mockLLMClient.quickChat).not.toHaveBeenCalled();
      expect(result.llmAssessment?.decisionSubSource).toBeUndefined();
    });
  });
});
