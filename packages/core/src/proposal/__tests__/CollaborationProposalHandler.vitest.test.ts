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

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { CollaborationProposalHandler } from '../CollaborationProposalHandler.js';
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
});
