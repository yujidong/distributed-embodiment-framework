/**
 * TDD Tests for CollaborationProposalHandler Context Management Improvements
 *
 * Sprint 14: Optimize Agent Context Management
 *
 * These tests verify that:
 * 1. LLM prompts use natural language (not pipe-separated format)
 * 2. Collaboration history and trust information are included
 * 3. Current workload and active collaborations are considered
 * 4. Service information is complete
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  CollaborationProposalHandler,
  DEVICE_LIST_FILTER_THRESHOLD,
  DEVICE_LIST_MAX_SHOWN,
  DEFAULT_PROMPT_BUDGET_TOKENS,
  estimatePromptTokens,
} from '../CollaborationProposalHandler.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { CollaborationProposal } from '../types/proposal-handler.js';
import { EventType } from '@active-collaboration/shared';

describe('CollaborationProposalHandler - Context Management (Sprint 14)', () => {
  let handler: CollaborationProposalHandler;
  let mockLLMClient: LLMClient;
  let mockEnvironment: EnvironmentCenter;

  const createMockProposal = (overrides?: Partial<CollaborationProposal>): CollaborationProposal => ({
    id: 'proposal-1',
    proposedBy: 'agent-2',
    proposedTo: 'agent-1',
    task: 'temperature-control',
    description: 'Collaborate to reduce temperature in Conference Room A',
    services: ['cooling-service', 'monitoring-service'],
    timestamp: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    // Mock LLM client
    mockLLMClient = {
      chat: vi.fn(),
      quickChat: vi.fn(),
    } as unknown as LLMClient;

    // Mock environment
    mockEnvironment = {
      eventManager: {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        publish: vi.fn(),
      },
    } as unknown as EnvironmentCenter;

    // Create handler
    handler = new CollaborationProposalHandler({
      llmClient: mockLLMClient,
      environment: mockEnvironment,
      agentId: 'agent-1',
      agentName: 'TemperatureAgent',
      agentCapabilities: ['temperature-control', 'monitoring', 'cooling'],
      config: {
        enabled: true,
        autoExecuteAccepted: false,
        maxConcurrentCollaborations: 5,
        criteria: {
          minBenefitThreshold: 0.6,
          maxCostThreshold: 0.4,
        },
      },
    });
  });

  describe('RED: Test for Natural Language Prompts', () => {
    it('should use natural language format instead of pipe-separated format', async () => {
      // Arrange
      const proposal = createMockProposal();

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.8,
          costScore: 0.3,
          benefits: ['Shared resources', 'Faster completion'],
          costs: ['Resource commitment', 'Coordination overhead'],
          recommendedDecision: 'accept',
          reasoning: 'Benefits outweigh costs',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const prompt = calls[0][0].messages[0].content;

      // Should NOT contain pipe-separated format
      expect(prompt).not.toMatch(/\w+:\w+\|\w+:\w+\|\w+:\w+/);

      // Should contain natural language
      expect(prompt).toMatch(/You are|agent|collaboration|proposal/i);
    });

    it('should include clear section headers in prompt', async () => {
      // Arrange
      const proposal = createMockProposal();

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.7,
          costScore: 0.4,
          benefits: ['Access to cooling service'],
          costs: ['Resource usage'],
          recommendedDecision: 'accept',
          reasoning: 'Acceptable proposal',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should have clear sections
      expect(prompt).toMatch(/PROFILE|PROPOSAL|EVALUATION|DECISION/i);
    });

    it('should present information in structured format', async () => {
      // Arrange
      const proposal = createMockProposal({
        task: 'complex-multi-capability-task',
        description: 'Requires coordination across multiple services',
        services: ['service-1', 'service-2', 'service-3'],
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.6,
          costScore: 0.5,
          benefits: ['Multi-service coordination'],
          costs: ['High coordination overhead'],
          recommendedDecision: 'counter',
          reasoning: 'Needs negotiation',
          counterModifications: ['Reduce scope'],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should have bullet points or clear separators
      expect(prompt).toMatch(/-|\n|:/);

      // Should have multiple sections
      const sections = prompt.split(/\n\n+/).filter(s => s.trim().length > 0);
      expect(sections.length).toBeGreaterThan(2);
    });
  });

  describe('RED: Test for Collaboration History and Trust Information', () => {
    it('should include collaboration history with the proposing agent', async () => {
      // Arrange: Simulate previous collaborations
      const handlerWithHistory = new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'agent-1',
        agentName: 'TemperatureAgent',
        agentCapabilities: ['temperature-control'],
        config: {
          enabled: true,
          autoExecuteAccepted: false,
          maxConcurrentCollaborations: 5,
          criteria: {
            minBenefitThreshold: 0.6,
            maxCostThreshold: 0.4,
          },
        },
      });

      // Manually add collaboration history
      (handlerWithHistory as unknown as { collaborationHistory: Map<string, Date[]> }).collaborationHistory.set('agent-2', [
        new Date('2024-03-01'),
        new Date('2024-03-05'),
        new Date('2024-03-10'),
      ]);

      const proposal = createMockProposal({
        proposedBy: 'agent-2',
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.9,
          costScore: 0.2,
          benefits: ['Trusted partner', 'Proven collaboration history'],
          costs: ['Minimal'],
          recommendedDecision: 'accept',
          reasoning: 'High trust partner',
          counterModifications: [],
        }),
      });

      // Act
      await handlerWithHistory['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention trust or previous collaborations
      expect(prompt).toMatch(/trust|previous|history|collaborated/i);
    });

    it('should indicate first-time collaboration for new partners', async () => {
      // Arrange
      const proposal = createMockProposal({
        proposedBy: 'new-agent-999',
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.5,
          costScore: 0.5,
          benefits: ['Potential new partnership'],
          costs: ['Unknown reliability'],
          recommendedDecision: 'defer',
          reasoning: 'Need to verify new partner',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention unknown or first-time
      expect(prompt).toMatch(/unknown|first|new partner/i);
    });

    it('should use trust level in decision making', async () => {
      // Arrange: Create handler with trust history
      const handlerWithTrust = new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'agent-1',
        agentName: 'TemperatureAgent',
        agentCapabilities: ['temperature-control'],
        config: {
          enabled: true,
          autoExecuteAccepted: false,
          maxConcurrentCollaborations: 5,
          criteria: {
            minBenefitThreshold: 0.6,
            maxCostThreshold: 0.4,
          },
        },
      });

      // Add successful collaboration history
      (handlerWithTrust as unknown as { collaborationHistory: Map<string, Date[]> }).collaborationHistory.set('trusted-agent', [
        new Date('2024-03-01'),
        new Date('2024-03-05'),
      ]);

      const proposal = createMockProposal({
        proposedBy: 'trusted-agent',
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.8,
          costScore: 0.3,
          benefits: ['High trust', 'Proven reliability'],
          costs: ['Standard commitment'],
          recommendedDecision: 'accept',
          reasoning: 'Trusted partner with good history',
          counterModifications: [],
        }),
      });

      // Act
      const evaluation = await handlerWithTrust.evaluateProposal(proposal);

      // Assert
      expect(evaluation.decision).toBe('accept');
    });
  });

  describe('RED: Test for Current Workload and Active Collaborations', () => {
    it('should include current workload in prompt', async () => {
      // Arrange: Handler with active collaborations
      const busyHandler = new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'agent-1',
        agentName: 'TemperatureAgent',
        agentCapabilities: ['temperature-control'],
        config: {
          enabled: true,
          autoExecuteAccepted: false,
          maxConcurrentCollaborations: 5,
          criteria: {
            minBenefitThreshold: 0.6,
            maxCostThreshold: 0.4,
          },
        },
      });

      // Add active collaborations
      (busyHandler as unknown as { activeCollaborations: Set<string> }).activeCollaborations.add('ac-1');
      (busyHandler as unknown as { activeCollaborations: Set<string> }).activeCollaborations.add('ac-2');
      (busyHandler as unknown as { activeCollaborations: Set<string> }).activeCollaborations.add('ac-3');

      const proposal = createMockProposal();

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.6,
          costScore: 0.6,
          benefits: ['Additional collaboration'],
          costs: ['High workload'],
          recommendedDecision: 'counter',
          reasoning: 'Busy but can negotiate',
          counterModifications: ['Delay start time'],
        }),
      });

      // Act
      await busyHandler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention workload or active collaborations
      expect(prompt).toMatch(/workload|active|collaboration|busy/i);
    });

    it('should consider max concurrent collaborations limit', async () => {
      // Arrange: Handler at max capacity
      const fullHandler = new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'agent-1',
        agentName: 'TemperatureAgent',
        agentCapabilities: ['temperature-control'],
        config: {
          enabled: true,
          autoExecuteAccepted: false,
          maxConcurrentCollaborations: 3,
          criteria: {
            minBenefitThreshold: 0.6,
            maxCostThreshold: 0.4,
          },
        },
      });

      // Fill to max capacity
      (fullHandler as unknown as { activeCollaborations: Set<string> }).activeCollaborations.add('ac-1');
      (fullHandler as unknown as { activeCollaborations: Set<string> }).activeCollaborations.add('ac-2');
      (fullHandler as unknown as { activeCollaborations: Set<string> }).activeCollaborations.add('ac-3');

      const proposal = createMockProposal();

      // Act
      const evaluation = await fullHandler.evaluateProposal(proposal);

      // Assert
      // Should reject due to capacity
      expect(evaluation.decision).toBe('reject');
      expect(evaluation.reasoning).toContain('Maximum concurrent');
    });

    it('should show active collaboration count in prompt', async () => {
      // Arrange
      const proposal = createMockProposal();

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.7,
          costScore: 0.4,
          benefits: ['New collaboration'],
          costs: ['Resource commitment'],
          recommendedDecision: 'accept',
          reasoning: 'Acceptable proposal',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention collaboration count or status
      expect(prompt).toMatch(/\d+.*collaboration|collaboration.*\d+/i);
    });
  });

  describe('RED: Test for Complete Service Information', () => {
    it('should include agent capabilities in prompt', async () => {
      // Arrange
      const proposal = createMockProposal({
        services: ['cooling-service', 'hvac-control'],
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.8,
          costScore: 0.3,
          benefits: ['Matches capabilities'],
          costs: ['Resource usage'],
          recommendedDecision: 'accept',
          reasoning: 'Good capability match',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention capabilities
      expect(prompt).toMatch(/capabilities/i);
      expect(prompt).toContain('temperature-control');
      expect(prompt).toContain('monitoring');
    });

    it('should include requested services from proposal', async () => {
      // Arrange
      const proposal = createMockProposal({
        services: ['cooling-service', 'monitoring-service', 'hvac-control-service'],
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.7,
          costScore: 0.4,
          benefits: ['Service alignment'],
          costs: ['Coordination needed'],
          recommendedDecision: 'accept',
          reasoning: 'Services match capabilities',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention requested services
      expect(prompt).toContain('cooling-service');
      expect(prompt).toContain('monitoring-service');
      expect(prompt).toContain('hvac-control-service');
    });

    it('should align capabilities with requested services', async () => {
      // Arrange: Proposal with services that match agent capabilities
      const proposal = createMockProposal({
        services: ['cooling', 'monitoring'],
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.9,
          costScore: 0.2,
          benefits: ['Perfect capability match', 'Can provide all services'],
          costs: ['Minimal'],
          recommendedDecision: 'accept',
          reasoning: 'Excellent alignment',
          counterModifications: [],
        }),
      });

      // Act
      const evaluation = await handler.evaluateProposal(proposal);

      // Assert
      expect(evaluation.decision).toBe('accept');
      expect(evaluation.benefits.length).toBeGreaterThan(0);
    });
  });

  describe('GREEN: Verify Prompt Quality Improvements', () => {
    it('should generate prompts with clear evaluation criteria', async () => {
      // Arrange
      const proposal = createMockProposal();

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.7,
          costScore: 0.4,
          benefits: ['Good proposal'],
          costs: ['Some overhead'],
          recommendedDecision: 'accept',
          reasoning: 'Positive evaluation',
          counterModifications: [],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should mention evaluation criteria
      expect(prompt).toMatch(/criteria|alignment|benefit|cost/i);
    });

    it('should provide enough context for informed decision', async () => {
      // Arrange
      const proposal = createMockProposal({
        task: 'important-task',
        description: 'Critical task requiring careful consideration',
      });

      (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.6,
          costScore: 0.5,
          benefits: ['Important task'],
          costs: ['Resource intensive'],
          recommendedDecision: 'counter',
          reasoning: 'Needs adjustment',
          counterModifications: ['Reduce scope'],
        }),
      });

      // Act
      await handler['analyzeWithLLM'](proposal);

      // Assert
      const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
      const prompt = calls[0][0].messages[0].content;

      // Should be comprehensive
      expect(prompt.length).toBeGreaterThan(200);

      // Should include multiple decision factors
      expect(prompt).toMatch(/capability|workload|trust|benefit|risk/i);
    });
  });

  describe('T-202: honest capability surface (devices, not declarations)', () => {
    /** Handler whose DECLARED list is thin but whose bound devices deliver. */
    function makeFacilityHandler() {
      return new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'facility-agent',
        agentName: 'FacilityOps Agent',
        agentCapabilities: ['facility-management'],
        config: {
          enabled: true,
          autoExecuteAccepted: false,
          maxConcurrentCollaborations: 5,
          criteria: { minBenefitThreshold: 0.6, maxCostThreshold: 0.4 },
        },
        deviceSurface: () => [
          {
            id: 'hvac-office-a',
            name: 'Office A HVAC Unit',
            capabilities: ['cooling', 'heating', 'temperature-control'],
            zoneId: 'office-a',
          },
        ],
      });
    }

    it('shows the device-derived surface in the prompt (YOUR DEVICES section)', async () => {
      const handler = makeFacilityHandler();
      (mockLLMClient.chat as Mock).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.8, costScore: 0.2, benefits: [], costs: [],
          recommendedDecision: 'accept', reasoning: 'ok',
        }),
      });

      await handler['analyzeWithLLM'](createMockProposal({
        task: 'cool the office',
        capabilities: ['cooling'],
      }));

      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;
      // The enriched surface names what the declared list omits.
      expect(prompt).toContain('cooling');
      expect(prompt).toContain('YOUR DEVICES:');
      expect(prompt).toContain('Office A HVAC Unit');
      expect(prompt).toContain('zone office-a');
      // S1: proposal fields ride the untrusted-block sanitizer — the
      // capability is present inside the block (never raw on the line).
      expect(prompt).toMatch(/Requested Capabilities: <untrusted name="proposal-capabilities"[^>]*>\ncooling\n<\/untrusted>/);
    });

    it('capability fallback matches against the device-derived surface', () => {
      const handler = makeFacilityHandler();
      const evaluation = handler['evaluateByCapabilities'](createMockProposal({
        task: 'cool the office',
        capabilities: ['cooling'],
      }));

      // Pre-fix: declared ['facility-management'] matched nothing → reject.
      expect(evaluation.decision).toBe('accept');
      expect(evaluation.reasoning).toContain('1/1 matched');
    });

    it('attaches responderContext to handshake answer events', async () => {
      const handler = makeFacilityHandler();
      handler.setAgent({
        joinCollaboration: vi.fn().mockResolvedValue({ success: true, collaborationId: 'ac-1', role: 'participant' }),
      });
      (mockLLMClient.chat as Mock).mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.9, costScore: 0.2, benefits: ['cooler office'], costs: [],
          recommendedDecision: 'accept', reasoning: 'we can deliver cooling',
        }),
      });

      await handler['handleCollaborationProposal']({
        id: 'evt-1',
        type: EventType.COLLABORATION_PROPOSAL,
        source: 'sec-agent',
        timestamp: new Date(),
        payload: {
          proposal: {
            id: 'p-1', proposedBy: 'sec-agent', proposedTo: 'facility-agent',
            task: 'cool the office', capabilities: ['cooling'],
          },
        },
        metadata: {},
      } as never);

      const published = (mockEnvironment.eventManager.publish as Mock).mock.calls
        .map(call => call[0])
        .find((event: { payload?: { type?: string } }) => event.payload?.type === 'join-response');
      expect(published).toBeDefined();
      expect(published.payload.responderContext.providerAgentId).toBe('facility-agent');
      // P5 (R44-extreme-F3): the REAL initiator rides the answer — pre-fix
      // the trajectory record was self-only (providerAgentId = responder).
      expect(published.payload.responderContext.initiatorAgentId).toBe('sec-agent');
      expect(published.payload.responderContext.capabilities).toContain('cooling');
      expect(published.payload.responderContext.devices[0].name).toBe('Office A HVAC Unit');
    });
  });

  describe('R44-insane: YOUR DEVICES relevance filter (device-list prompt bound)', () => {
    /** A district manager bound to a large facility inventory. */
    const makeDistrictHandler = (deviceCount: number, relevantCount: number) => {
      const devices = [
        // The proposal-relevant tail: pumps the flood proposal needs. One
        // declares 'temperature-control' — the SYNONYM of the required
        // 'cooling' (word-root/synonym matching, not exact strings).
        ...Array.from({ length: relevantCount - 1 }, (_, i) => ({
          id: `flood-pump-${i}`,
          name: `排涝泵站 P-${i}号机组`,
          capabilities: ['flood-drainage', 'turn-on', 'turn-off'],
          zoneId: `zone-${i % 6}`,
        })),
        {
          id: 'hvac-hall',
          name: 'Central Hall HVAC',
          capabilities: ['temperature-control'],
          zoneId: 'zone-0',
        },
        // The noise tail: 3,602-device-city inventory the proposal does not need.
        ...Array.from({ length: deviceCount - relevantCount }, (_, i) => ({
          id: `noise-sensor-${i}`,
          name: `噪声监测传感器 N-${i}`,
          capabilities: ['noise-monitoring'],
          zoneId: `zone-${i % 6}`,
        })),
      ];
      return {
        devices,
        handler: new CollaborationProposalHandler({
          llmClient: mockLLMClient,
          environment: mockEnvironment,
          agentId: 'district-agent',
          agentName: '区管家',
          agentCapabilities: ['facility-management'],
          config: {
            enabled: true,
            autoExecuteAccepted: false,
            maxConcurrentCollaborations: 5,
            criteria: { minBenefitThreshold: 0.6, maxCostThreshold: 0.4 },
          },
          deviceSurface: () => devices,
        }),
      };
    };

    const evaluationOk = () => ({
      content: JSON.stringify({
        benefitScore: 0.8, costScore: 0.2, benefits: [], costs: [],
        recommendedDecision: 'accept', reasoning: 'ok',
      }),
    });

    /** The lines of the YOUR DEVICES section (between the section headers). */
    const deviceLines = (prompt: string): string[] => {
      const section = prompt.split('YOUR DEVICES:')[1]!.split('YOUR SERVICES')[0];
      return section.split('\n').filter(line => line.startsWith('- '));
    };

    beforeEach(() => {
      (mockLLMClient.chat as Mock).mockResolvedValue(evaluationOk());
    });

    it('lists every device at or below the threshold — no filtering, no summary', async () => {
      const { handler } = makeDistrictHandler(DEVICE_LIST_FILTER_THRESHOLD, 5);
      await handler['analyzeWithLLM'](createMockProposal({
        task: 'flood drainage',
        capabilities: ['flood-drainage'],
      }));
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;
      const lines = deviceLines(prompt);
      expect(lines).toHaveLength(DEVICE_LIST_FILTER_THRESHOLD);
      expect(prompt).not.toContain('…and');
      expect(prompt).toContain('noise-sensor-0');
    });

    it('above the threshold keeps the proposal-relevant devices and bounds the section', async () => {
      // 60+ devices, as the acceptance requires (50+).
      const { handler } = makeDistrictHandler(60, 10);
      await handler['analyzeWithLLM'](createMockProposal({
        task: 'flood drainage in district',
        capabilities: ['flood-drainage', 'cooling'],
      }));
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;
      const lines = deviceLines(prompt);

      // Bounded: top-N listed + exactly one summary line.
      expect(lines).toHaveLength(DEVICE_LIST_MAX_SHOWN + 1);
      const summary = lines.at(-1)!;
      expect(summary).toMatch(new RegExp(`…and ${60 - DEVICE_LIST_MAX_SHOWN} more \\(filter by capability`));

      // The 9 flood pumps AND the synonym-matched HVAC unit survive the cut
      // (capabilityMatches: temperature-control ≡ cooling). The 20 shown
      // slots cover those 10 + 10 relevance-0 fillers in original order, so
      // the deep tail of the inventory is what collapses into the summary.
      for (let i = 0; i < 9; i++) {
        expect(prompt).toContain(`flood-pump-${i}`);
      }
      expect(prompt).toContain('hvac-hall');
      expect(prompt).toContain('noise-sensor-0'); // filler slot (rank 11-20)
      expect(prompt).not.toContain('noise-sensor-39'); // hidden by relevance
    });

    it('never loses capability information — hidden devices\' capability union rides the summary', async () => {
      const { handler } = makeDistrictHandler(60, 10);
      await handler['analyzeWithLLM'](createMockProposal({
        task: 'flood drainage',
        capabilities: ['flood-drainage'],
      }));
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;
      const summary = deviceLines(prompt).at(-1)!;
      // The hidden noise devices' capability is still visible twice: in the
      // summary union and in the YOUR PROFILE surface line.
      expect(summary).toContain('noise-monitoring');
      expect(prompt).toMatch(/Capabilities \(declared \+ device-derived\):.*noise-monitoring/s);
    });

    it('bounds the whole evaluation prompt well under the 16K context (50+ devices < 8K tokens)', async () => {
      // The R44-insane reproduction shape: a district manager bound to the
      // full 150-device facility inventory.
      const { handler } = makeDistrictHandler(150, 6);
      await handler['analyzeWithLLM'](createMockProposal({
        task: 'flood drainage across the district',
        capabilities: ['flood-drainage'],
      }));
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;
      // Conservative tokenizer bound (3 chars/token overestimates tokens for
      // this mostly-ASCII prompt): 8K-token ceiling with wide margin.
      const estimatedTokens = Math.ceil(prompt.length / 3);
      expect(estimatedTokens).toBeLessThan(8192);
      // The devices that matter for THIS proposal are still in the list.
      expect(prompt).toContain('flood-pump-0');
    });
  });

  describe('R44-extreme-F1 (plan-r81 D1): total prompt budget — footprint-preserving trim', () => {
    /**
     * The extreme-tier reproduction shape: a district steward bound to 75
     * facility devices (Chinese names, like resilience-city-extreme). The
     * proposal footprint is the flood pumps + every device in zone-0 (the
     * proposal names the zone); the rest is inventory noise.
     */
    const makeStewardHandler = (configExtra?: Record<string, unknown>) => {
      const devices = [
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `flood-pump-${i}`,
          name: `排涝泵站 P-${i}号机组`,
          type: 'flood-pump',
          capabilities: ['flood-drainage', 'turn-on', 'turn-off'],
          zoneId: `zone-${i % 2}`,
        })),
        ...Array.from({ length: 69 }, (_, i) => ({
          id: `hvac-${i}`,
          name: `中央空调机组 ${i}号`,
          type: i % 2 === 0 ? 'hvac' : 'ventilation-fan',
          capabilities: ['temperature-control', 'turn-on', 'turn-off'],
          zoneId: `zone-${i % 6}`,
        })),
      ];
      return {
        devices,
        handler: new CollaborationProposalHandler({
          llmClient: mockLLMClient,
          environment: mockEnvironment,
          agentId: 'district-steward',
          agentName: '宝安区管家',
          agentCapabilities: ['facility-management'],
          config: {
            enabled: true,
            autoExecuteAccepted: false,
            maxConcurrentCollaborations: 5,
            criteria: { minBenefitThreshold: 0.6, maxCostThreshold: 0.4 },
            ...configExtra,
          } as never,
          deviceSurface: () => devices,
        }),
      };
    };

    const evaluationOk = () => ({
      content: JSON.stringify({
        benefitScore: 0.8, costScore: 0.2, benefits: [], costs: [],
        recommendedDecision: 'accept', reasoning: 'ok',
      }),
    });

    const floodProposal = () => createMockProposal({
      goal: 'district flood response',
      task: 'drain the flood in zone-0',
      description: 'mega-shelter-open: bring drainage online',
      capabilities: ['flood-drainage'],
    });

    beforeEach(() => {
      (mockLLMClient.chat as Mock).mockResolvedValue(evaluationOk());
    });

    afterEach(() => {
      delete process.env.PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS;
    });

    it('keeps the 75-device steward prompt within the default budget (no trim, no trim record)', async () => {
      const { handler } = makeStewardHandler();
      const evaluation = await handler.evaluateProposal(floodProposal());
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;
      // The default budget must hold with wide margin for the 8192-context
      // tier (+500 output reservation), and nothing was budget-trimmed (the
      // count-based section filter alone keeps it small).
      expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(DEFAULT_PROMPT_BUDGET_TOKENS);
      expect(estimatePromptTokens(prompt) + 500).toBeLessThan(8192);
      expect(evaluation.promptTrim).toBeUndefined();
    });

    it('over budget: footprint devices are listed in full and NEVER trimmed', async () => {
      // Tiny budget forces budget mode on the 75-device surface.
      const { handler } = makeStewardHandler({ promptBudgetTokens: 200 });
      await handler.evaluateProposal(floodProposal());
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;

      // Capability footprint: all six flood pumps listed in full.
      for (let i = 0; i < 6; i++) {
        expect(prompt).toContain(`flood-pump-${i}`);
      }
      // Zone footprint: zone-0 devices kept even though they are HVAC noise
      // (the proposal's task names zone-0).
      expect(prompt).toContain('hvac-0'); // zone-0
      expect(prompt).toContain('hvac-6'); // zone-0
      // Non-footprint devices are gone from the per-device list…
      expect(prompt).not.toContain('hvac-1 (');
      expect(prompt).not.toContain('hvac-5 (');
      // …and collapse into exactly one aggregate line.
      expect(prompt).toContain('…and');
    });

    it('over budget: the aggregate line carries the type mix and the hidden capability union', async () => {
      const { handler } = makeStewardHandler({ promptBudgetTokens: 200 });
      await handler.evaluateProposal(floodProposal());
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;

      // 75 total; footprint = 6 pumps + zone-0 hvacs (hvac-0, hvac-6 … hvac-66
      // → 12 devices, of which flood pumps never sit in zone-0 at indices
      // 1,3,5 — footprint counts: pumps 6 (zones 0/1 alternating: pumps 0,2,4
      // in zone-0) + zone-0 hvacs 12 = 18. Aggregated = 75 - 18 = 57.
      const aggregate = prompt.split('\n').find((line: string) => line.startsWith('- …and'));
      expect(aggregate).toBeDefined();
      expect(aggregate).toMatch(/…and \d+ more devices \(type mix: /);
      expect(aggregate).toContain('hvac×');
      expect(aggregate).toContain('ventilation-fan×');
      // The aggregated tail's capabilities survive as a union.
      expect(aggregate).toContain('their capabilities:');
      expect(aggregate).toContain('temperature-control');
      // And the trim record is exact about what happened.
      const evaluation = await handler.evaluateProposal(floodProposal());
      expect(evaluation.promptTrim).toBeDefined();
      expect(evaluation.promptTrim!.devicesListed + evaluation.promptTrim!.devicesAggregated).toBe(75);
      expect(evaluation.promptTrim!.budgetTokens).toBe(200);
      expect(evaluation.promptTrim!.estimatedTokensBefore).toBeGreaterThan(200);
      expect(evaluation.promptTrim!.estimatedTokensAfter).toBeLessThan(
        evaluation.promptTrim!.estimatedTokensBefore,
      );
    });

    it('the trim record reaches the handshake answer payload (responderContext) — visible, not silent', async () => {
      const { handler } = makeStewardHandler({ promptBudgetTokens: 200 });
      handler.setAgent({
        joinCollaboration: vi.fn().mockResolvedValue({ success: true, collaborationId: 'ac-1', role: 'participant' }),
      });

      await handler['handleCollaborationProposal']({
        id: 'evt-1',
        type: EventType.COLLABORATION_PROPOSAL,
        source: 'city-eoc',
        timestamp: new Date(),
        payload: {
          proposal: {
            id: 'p-75', proposedBy: 'city-eoc', proposedTo: 'district-steward',
            goal: 'district flood response',
            task: 'drain the flood in zone-0',
            capabilities: ['flood-drainage'],
          },
        },
        metadata: {},
      } as never);

      const published = (mockEnvironment.eventManager.publish as Mock).mock.calls
        .map(call => call[0])
        .find((event: { payload?: { type?: string } }) => event.payload?.type === 'join-response');
      expect(published).toBeDefined();
      expect(published.payload.responderContext.promptTrim).toBeDefined();
      expect(published.payload.responderContext.promptTrim.devicesAggregated).toBeGreaterThan(0);
    });

    it('footprint larger than the count filter: keeps the smaller count-filtered prompt and still records the event', async () => {
      // 'turn-on' matches ALL 75 devices → the footprint IS the inventory;
      // listing it in full would GROW the prompt past the count-filtered
      // one, so the smaller section wins and the trim says so.
      const { handler } = makeStewardHandler({ promptBudgetTokens: 200 });
      const evaluation = await handler.evaluateProposal(createMockProposal({
        goal: 'power up',
        task: 'turn everything on',
        capabilities: ['turn-on'],
      }));
      const prompt = (mockLLMClient.chat as Mock).mock.calls[0][0].messages[0].content;

      // The count-filtered section (top-20 + summary) is what was sent…
      expect(prompt).toMatch(/…and 55 more \(filter by capability/);
      // …and the trim record shows the attempt could not shrink further.
      expect(evaluation.promptTrim).toBeDefined();
      expect(evaluation.promptTrim!.devicesListed).toBe(75);
      expect(evaluation.promptTrim!.devicesAggregated).toBe(0);
      expect(evaluation.promptTrim!.estimatedTokensAfter).toBe(
        evaluation.promptTrim!.estimatedTokensBefore,
      );
    });

    it('PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS env drives the budget when config does not', async () => {
      const { handler } = makeStewardHandler();
      // Fits the 6000 default (previous test) but not a 200 env override.
      process.env.PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS = '200';
      const trimmed = await handler.evaluateProposal(floodProposal());
      expect(trimmed.promptTrim).toBeDefined();
      expect(trimmed.promptTrim!.budgetTokens).toBe(200);

      // Env removed → default budget → the same proposal needs no trim.
      delete process.env.PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS;
      const untrimmed = await handler.evaluateProposal(floodProposal());
      expect(untrimmed.promptTrim).toBeUndefined();
    });

    it('config.promptBudgetTokens wins over the env var', async () => {
      process.env.PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS = '200';
      const { handler } = makeStewardHandler({ promptBudgetTokens: 9000 });
      const evaluation = await handler.evaluateProposal(floodProposal());
      // Config budget 9000 > prompt → no trim even though the env says 200.
      expect(evaluation.promptTrim).toBeUndefined();
    });

    it('estimatePromptTokens counts CJK at ~1 token and the rest at ~4 chars/token', () => {
      expect(estimatePromptTokens('')).toBe(0);
      expect(estimatePromptTokens('abcd')).toBe(1);
      expect(estimatePromptTokens('中央空调')).toBe(4);
      expect(estimatePromptTokens('中央空调abcd')).toBe(5);
    });
  });
});
