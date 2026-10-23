/**
 * Agent Autonomous Active Collaboration Tests
 *
 * Tests for Agent's autonomous decision-making in AC participation
 *
 * CRITICAL ARCHITECTURE PRINCIPLES:
 * 1. Agent is INDEPENDENT decision-making core
 * 2. Agent autonomously decides whether to join AC
 * 3. CollaborationManager ONLY tracks state, does NOT control behavior
 * 4. AC formation is spontaneous, agents join voluntarily
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CognitiveAgent, AgentStatus } from '../CognitiveAgent.js';
import { CollaborationManager, ACState, CollaborationStatus, CollaborationPriority } from '../../management/CollaborationManager.js';
import { CollaborationProposalHandler } from '../../proposal/CollaborationProposalHandler.js';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { CognitiveAgentConfig } from '../CognitiveAgent.js';
import type { CollaborationProposal, ProposalHandlerConfig } from '../../types/proposal-handler.js';
import { EventManager } from '../../events/index.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

describe('Agent Autonomous AC Participation', () => {
  let agent: CognitiveAgent;
  let collaborationManager: CollaborationManager;
  let eventManager: EventManager;
  let mockEnvironment: Record<string, unknown>;
  let mockLLMClient: LLMClient;

  beforeEach(() => {
    // Create real EventManager for event handling
    eventManager = new EventManager(1000);

    // Create CollaborationManager for state tracking
    collaborationManager = new CollaborationManager();
    collaborationManager.eventManager = eventManager;

    // Mock environment center with real event manager
    mockEnvironment = {
      id: 'test-env',
      eventManager: eventManager,
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      getParameter: vi.fn(),
    };

    // Mock LLM client that accepts proposals
    mockLLMClient = {
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          benefitScore: 0.8,
          costScore: 0.2,
          benefits: ['Resource sharing', 'Task collaboration'],
          costs: ['Minor overhead'],
          recommendedDecision: 'accept',
          reasoning: 'Proposal aligns with capabilities and goals',
        }),
      }),
    } as unknown as LLMClient;
  });

  afterEach(() => {
    if (agent) {
      agent.stop();
    }
  });

  describe('RED Phase: Missing Functionality', () => {
    it('should have CollaborationProposalHandler integrated in CognitiveAgent', () => {
      /**
       * Test: Agent should have proposalHandler property
       * Current State: FAILS - proposalHandler not integrated
       */
      const config: CognitiveAgentConfig = {
        id: 'agent-1',
        name: 'Test Agent 1',
        description: 'Agent for testing',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['temperature-control', 'hvac-management'],
      };

      agent = new CognitiveAgent(config);

      // This should FAIL initially - proposalHandler doesn't exist yet
      expect(agent.proposalHandler).toBeDefined();
      expect(agent.proposalHandler).toBeInstanceOf(CollaborationProposalHandler);
    });

    it('should have joinCollaboration method', () => {
      /**
       * Test: Agent should have joinCollaboration method
       * Current State: FAILS - method doesn't exist
       */
      const config: CognitiveAgentConfig = {
        id: 'agent-1',
        name: 'Test Agent 1',
        description: 'Agent for testing',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['temperature-control'],
      };

      agent = new CognitiveAgent(config);

      // This should FAIL initially - joinCollaboration doesn't exist yet
      expect(typeof agent.joinCollaboration).toBe('function');
    });

    it('should have participationStatus tracking', () => {
      /**
       * Test: Agent should track its participation status in ACs
       * Current State: FAILS - participationStatus doesn't exist
       */
      const config: CognitiveAgentConfig = {
        id: 'agent-1',
        name: 'Test Agent 1',
        description: 'Agent for testing',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['temperature-control'],
      };

      agent = new CognitiveAgent(config);

      // This should FAIL initially - participationStatus doesn't exist yet
      expect(agent.getActiveParticipations()).toBeDefined();
      expect(typeof agent.getParticipationStatus).toBe('function');
    });
  });

  describe('Agent Autonomous Decision Making', () => {
    beforeEach(() => {
      const config: CognitiveAgentConfig = {
        id: 'agent-1',
        name: 'HVAC Controller',
        description: 'HVAC control agent',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['temperature-control', 'hvac-management'],
      };

      agent = new CognitiveAgent(config);
      agent.start();
    });

    it('should autonomously evaluate and accept AC proposal', async () => {
      /**
       * Test: Agent receives proposal, evaluates it, and autonomously decides to join
       * Architecture: Agent makes independent decision, not forced by external entity
       */
      const proposal: CollaborationProposal = {
        id: 'proposal-1',
        proposedBy: 'agent-initiator',
        proposedTo: 'agent-1',
        type: 'collaboration-request',
        goal: 'Coordinate HVAC operations',
        task: 'Optimize building temperature',
        description: 'Join collaboration to optimize building HVAC',
        capabilities: ['temperature-control'],
        priority: 'high',
      };

      // Publish proposal event
      eventManager.publish({
        type: EventType.COLLABORATION_PROPOSAL,
        source: 'agent-initiator',
        priority: EventPriority.HIGH,
        payload: { proposal },
        metadata: {},
      });

      // Wait for agent to process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Agent should have evaluated and decided autonomously
      const handler = agent.proposalHandler as CollaborationProposalHandler;
      expect(handler).toBeDefined();

      const stats = handler.getStats();
      expect(stats.activeCollaborations).toBeGreaterThan(0);
    });

    it('should call joinCollaboration after accepting proposal', async () => {
      /**
       * Test: After accepting proposal, agent should call joinCollaboration
       * Architecture: Agent autonomously joins AC, not forced by CollaborationManager
       */
      const collaborationId = 'ac-123';

      // Agent should be able to join collaboration autonomously
      const result = await agent.joinCollaboration(collaborationId, {
        role: 'hvac-controller',
        capabilities: ['temperature-control'],
      });

      expect(result.success).toBe(true);
      expect(result.collaborationId).toBe(collaborationId);

      // Verify participation status is tracked
      const status = agent.getParticipationStatus(collaborationId);
      expect(status).toBeDefined();
      expect(status.role).toBe('hvac-controller');
    });
  });

  describe('CollaborationManager Role', () => {
    it('should have addParticipant method for agents to call', () => {
      /**
       * Test: CollaborationManager provides addParticipant for agents to call
       * Architecture: Agent calls this method, CM doesn't force agent to join
       */
      expect(typeof collaborationManager.addParticipant).toBe('function');
    });

    it('should have getParticipant method to query participants', () => {
      /**
       * Test: CollaborationManager provides getParticipant to query state
       * Architecture: CM tracks state, provides query interface
       */
      expect(typeof collaborationManager.getParticipant).toBe('function');
    });

    it('should NOT have methods that force agent behavior', () => {
      /**
       * Test: CollaborationManager should NOT have controlling methods
       * Architecture: CM only tracks state, doesn't control agents
       */
      const forbiddenMethods = [
        'forceAgentToJoin',
        'assignAgentToCollaboration',
        'commandAgent',
        'controlAgent',
      ];

      for (const method of forbiddenMethods) {
        expect(typeof (collaborationManager as unknown as Record<string, unknown>)[method]).toBe('undefined');
      }
    });

    it('should track AC state but not control transitions', async () => {
      /**
       * Test: CM tracks state transitions but agents drive the transitions
       */
      const collaborationId = 'ac-test';

      // Create initial collaboration session
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-1',
        CollaborationPriority.HIGH,
        'Test collaboration',
        []
      );

      // Initialize AC state tracking
      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Session created');

      // CM should track state
      expect(collaborationManager.getCurrentACState(session.id)).toBeDefined();

      // But state transitions should be triggered by agent actions
      // not by CM directly controlling them
    });
  });

  describe('Automatic State Transitions', () => {
    beforeEach(() => {
      const config: CognitiveAgentConfig = {
        id: 'agent-1',
        name: 'Test Agent',
        description: 'Test agent',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['test-capability'],
      };

      agent = new CognitiveAgent(config);
    });

    it('should transition from forming to ready when all participants join', async () => {
      /**
       * Test: AC automatically transitions from FORMING to READY
       * when all expected participants have joined
       */
      const collaborationId = 'ac-auto-transition';

      // Create collaboration in FORMING state
      const session = collaborationManager.createSession(
        'service-composition',
        [], // Initially no participants
        'agent-initiator',
        CollaborationPriority.HIGH,
        'Auto-transition test',
        []
      );

      // Initialize AC state tracking
      await collaborationManager.trackACState(session.id, ACState.FORMING, 'Collaboration initiated');

      // Set expected participants
      collaborationManager.setExpectedParticipants(session.id, ['agent-1', 'agent-2']);

      // Agent 1 joins
      await agent.joinCollaboration(session.id, { role: 'participant' });
      collaborationManager.addParticipant(session.id, 'agent-1', { role: 'participant', capabilities: [] });

      // State should still be FORMING (not all participants joined)
      let currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.FORMING);

      // Simulate agent-2 joining
      collaborationManager.addParticipant(session.id, 'agent-2', { role: 'participant', capabilities: [] });

      // Now state should automatically transition to READY
      // (This tests the automatic transition logic we need to implement)
      currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.READY);
    });

    it('should transition from ready to running when collaboration starts', async () => {
      /**
       * Test: AC automatically transitions from READY to RUNNING
       * when collaboration execution begins
       */
      const collaborationId = 'ac-run-transition';

      // Create collaboration in READY state
      const session = collaborationManager.createSession(
        'service-composition',
        ['agent-1'],
        'agent-1',
        CollaborationPriority.HIGH,
        'Run transition test',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.READY, 'All participants joined');

      // Start collaboration execution
      collaborationManager.updateSessionStatus(session.id, CollaborationStatus.IN_PROGRESS);

      // State should automatically transition to RUNNING
      const currentState = collaborationManager.getCurrentACState(session.id);
      expect(currentState).toBe(ACState.RUNNING);
    });
  });

  describe('Event Mechanism for Proposals', () => {
    it('should use COLLABORATION_PROPOSAL event type', () => {
      /**
       * Test: System uses unified COLLABORATION_PROPOSAL event type
       */
      expect(EventType.COLLABORATION_PROPOSAL).toBeDefined();
      expect(EventType.COLLABORATION_PROPOSAL).toBe('collaboration.proposal');
    });

    it('should have CollaborationProposalHandler subscribe to proposal events', async () => {
      /**
       * Test: CollaborationProposalHandler subscribes to COLLABORATION_PROPOSAL events
       */
      const handlerConfig: ProposalHandlerConfig = {
        enabled: true,
        criteria: {
          minBenefitThreshold: 0.5,
          maxCostThreshold: 0.7,
        },
        autoExecuteAccepted: true,
        notifyAllProposals: false,
        maxConcurrentCollaborations: 5,
      };

      const handler = new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'agent-1',
        agentName: 'Test Agent',
        agentCapabilities: ['test'],
        config: handlerConfig,
      });

      // Start handler to subscribe to events
      handler.start();

      // Verify subscription was created
      const stats = eventManager.getStats();
      expect(stats.totalSubscriptions).toBeGreaterThan(0);
    });
  });

  describe('End-to-End AC Formation', () => {
    it('should complete full AC formation flow autonomously', async () => {
      /**
       * Test: Complete flow from proposal to running AC
       * 1. Initiator creates AC in FORMING state
       * 2. Initiator sends proposals to potential participants
       * 3. Agents receive proposals, evaluate, and decide to join
       * 4. Agents call joinCollaboration
       * 5. AC transitions to READY when all participants join
       * 6. AC transitions to RUNNING when execution starts
       */
      const initiatorConfig: CognitiveAgentConfig = {
        id: 'initiator',
        name: 'Initiator Agent',
        description: 'AC initiator',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['coordination'],
      };

      const participantConfig: CognitiveAgentConfig = {
        id: 'participant-1',
        name: 'Participant Agent 1',
        description: 'AC participant',
        owner: 'test-owner',
        environment: mockEnvironment,
        llmClient: mockLLMClient,
        capabilities: ['task-execution'],
      };

      const initiator = new CognitiveAgent(initiatorConfig);
      const participant = new CognitiveAgent(participantConfig);

      initiator.start();
      participant.start();

      // Step 1: Initiator creates AC
      const session = collaborationManager.createSession(
        'service-composition',
        [],
        'initiator',
        CollaborationPriority.HIGH,
        'E2E test collaboration',
        []
      );

      await collaborationManager.trackACState(session.id, ACState.FORMING, 'AC created');

      // Set expected participants
      collaborationManager.setExpectedParticipants(session.id, ['participant-1']);

      // Step 2: Initiator sends proposal
      const proposal: CollaborationProposal = {
        id: 'proposal-e2e',
        proposedBy: 'initiator',
        proposedTo: 'participant-1',
        type: 'collaboration-request',
        goal: 'E2E test',
        description: 'Join E2E test collaboration',
        capabilities: ['task-execution'],
        priority: 'high',
      };

      eventManager.publish({
        type: EventType.COLLABORATION_PROPOSAL,
        source: 'initiator',
        priority: EventPriority.HIGH,
        payload: { proposal },
        metadata: {},
      });

      // Step 3: Wait for participant to process
      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 4: Participant joins
      const joinResult = await participant.joinCollaboration(session.id, {
        role: 'executor',
      });

      expect(joinResult.success).toBe(true);

      // Step 5: Add participant to AC
      collaborationManager.addParticipant(session.id, 'participant-1', { role: 'executor' });

      // Step 6: Verify state transitions
      const finalState = collaborationManager.getCurrentACState(session.id);
      expect(finalState).toBe(ACState.READY);

      // Cleanup
      initiator.stop();
      participant.stop();
    });
  });
});
