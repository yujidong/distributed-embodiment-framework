/**
 * CollaborationProposalHandler loop-guard tests (Fix-8)
 *
 * Regression: COLLABORATION_MESSAGE responses (join-response / reject /
 * counter) carry the original `proposal` object. normalizeProposal used to
 * treat that embedded proposal as a FRESH formal proposal, so the handler
 * evaluated its own accept and published another accept — an infinite
 * synchronous event loop (join-response × N) that starved the event loop
 * and OOM'd the process. The formal-proposal branch is now restricted to
 * COLLABORATION_PROPOSAL events.
 */

import { describe, it, expect } from 'vitest';
import { CollaborationProposalHandler } from '../CollaborationProposalHandler.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { EventManager } from '../../events/EventManager.js';
import { EventType, EventPriority } from '@active-collaboration/shared';

const CANNED_ACCEPT = JSON.stringify({
  benefitScore: 0.9,
  costScore: 0.1,
  benefits: ['can help'],
  costs: [],
  recommendedDecision: 'accept',
  reasoning: 'cheap to help',
});

function mockLLM(): LLMClient {
  return {
    chat: async () => ({
      content: CANNED_ACCEPT,
      model: 'mock-model',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  } as unknown as LLMClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('CollaborationProposalHandler loop guard (Fix-8)', () => {
  function setup() {
    const eventManager = new EventManager(1000);
    const handler = new CollaborationProposalHandler({
      llmClient: mockLLM(),
      environment: { eventManager } as unknown as EnvironmentCenter,
      agentId: 'agent-1',
      agentName: 'Responder',
      agentCapabilities: ['cooling'],
      config: {
        enabled: true,
        criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
        autoExecuteAccepted: false,
        notifyAllProposals: false,
        maxConcurrentCollaborations: 5,
      },
    });
    const published: Array<Record<string, unknown>> = [];
    eventManager.subscribe({
      subscriberId: 'recorder',
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: event => {
        published.push(event.payload as Record<string, unknown>);
      },
      priority: EventPriority.NORMAL,
    });
    handler.start();
    return { eventManager, handler, published };
  }

  it('ignores a join-response carrying an embedded proposal (no accept loop)', async () => {
    const { eventManager, handler, published } = setup();

    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-1',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        agentId: 'agent-1',
        collaborationId: 'ac-1',
        proposal: {
          id: 'p-1',
          proposedBy: 'agent-2',
          proposedTo: 'agent-1',
          type: 'collaboration-invitation',
          goal: 'Cool zone-a',
        },
      },
      metadata: {},
    });

    await sleep(100);
    // Exactly the one message we published — the handler must not answer.
    expect(published).toHaveLength(1);
    handler.stop();
  });

  it('ignores a reject message carrying an embedded proposal', async () => {
    const { eventManager, handler, published } = setup();

    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'reject',
        acDecision: 'reject',
        agentId: 'agent-2',
        collaborationId: 'ac-1',
        proposal: {
          id: 'p-1',
          proposedBy: 'agent-2',
          proposedTo: 'agent-1',
          type: 'collaboration-invitation',
          goal: 'Cool zone-a',
        },
      },
      metadata: {},
    });

    await sleep(100);
    expect(published).toHaveLength(1);
    handler.stop();
  });

  it('still answers a genuine ac-proposal exactly once', async () => {
    const { eventManager, handler, published } = setup();

    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'ac-proposal',
        collaborationId: 'ac-1',
        initiatorId: 'agent-2',
        targetAgentId: 'agent-1',
        description: 'Cool zone-a together',
        requiredCapabilities: ['cooling'],
      },
      metadata: {},
    });

    await sleep(100);
    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', collaborationId: 'ac-1' });
    handler.stop();
  });
});
