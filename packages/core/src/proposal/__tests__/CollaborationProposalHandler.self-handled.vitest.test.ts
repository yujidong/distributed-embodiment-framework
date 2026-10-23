/**
 * @vitest-environment node
 *
 * FEAT-10 (dorm-life D11): the responder accept lane rejects "I already
 * self-handled this trigger event". When a proposal's factual trigger event
 * id (the initiator's L1 backfill) names an event THIS agent already
 * handled independently — real device commands dispatched, registered via
 * DualTriggerACManager.hasSelfHandledEvent — accepting would double-actuate
 * the same devices (the duty officer's spontaneous ventilation followed by
 * an AC turn-on of the same fan). The reject is deterministic, fires in
 * BOTH lanes (LLM and capability fallback), and costs no LLM call. Unwired
 * seam / no triggerEventId → legacy behavior, byte-identical.
 */

import { describe, it, expect } from 'vitest';

import { CollaborationProposalHandler } from '../CollaborationProposalHandler.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { ChatParams, ChatResponse, LLMClient } from '@active-collaboration/llm-integration';
import type { CollaborationProposal, ProposalEvaluation } from '../../types/proposal-handler.js';
import { EventManager } from '../../events/EventManager.js';

const CANNED_ACCEPT = JSON.stringify({
  benefitScore: 0.9,
  costScore: 0.1,
  benefits: ['can help'],
  costs: [],
  recommendedDecision: 'accept',
  reasoning: 'cheap to help',
});

function okResponse(content: string): ChatResponse {
  return {
    content,
    model: 'mock-model',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function setup(options: { selfHandled?: (eventId: string) => boolean } = {}) {
  const prompts: string[] = [];
  const llmClient = {
    chat: async (params: ChatParams) => {
      const content = typeof params.messages[0]?.content === 'string'
        ? params.messages[0].content
        : '';
      prompts.push(content);
      return okResponse(CANNED_ACCEPT);
    },
  } as unknown as LLMClient;

  const eventManager = new EventManager(1000);
  const handler = new CollaborationProposalHandler({
    llmClient,
    environment: { eventManager } as unknown as EnvironmentCenter,
    agentId: 'agent-1',
    agentName: 'Responder',
    agentCapabilities: ['ventilation'],
    config: {
      enabled: true,
      criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
      autoExecuteAccepted: false,
      notifyAllProposals: false,
      maxConcurrentCollaborations: 5,
    },
  });
  if (options.selfHandled !== undefined) {
    handler.setSelfHandledEventCheck(options.selfHandled);
  }
  return { handler, prompts };
}

const PROPOSAL: CollaborationProposal = {
  id: 'prop-1',
  proposedBy: 'agent-2',
  proposedTo: 'agent-1',
  type: 'collaboration-invitation',
  goal: 'Ventilate dorm-1 after the CO2 breach',
  capabilities: ['ventilation'],
  metadata: {
    triggerEventId: 'evt-co2-1',
    triggerEventType: 'co2-breach',
    triggerZoneId: 'dorm-1',
  },
};

/** Direct access to the fallback lane (same pattern as the manager suites). */
function evaluateByCapabilities(
  handler: CollaborationProposalHandler,
  proposal: CollaborationProposal,
): ProposalEvaluation {
  return (handler as unknown as {
    evaluateByCapabilities(p: CollaborationProposal): ProposalEvaluation;
  }).evaluateByCapabilities(proposal);
}

describe('CollaborationProposalHandler — FEAT-10 self-handling reject', () => {
  it('LLM lane: a self-handled trigger event rejects WITHOUT spending the evaluation call', async () => {
    const { handler, prompts } = setup({ selfHandled: () => true });

    const evaluation = await handler.evaluateProposal(PROPOSAL);

    expect(evaluation.decision).toBe('reject');
    expect(evaluation.reasoning).toContain('Self-handling rejection');
    expect(evaluation.reasoning).toContain('evt-co2-1');
    // The whole point: no LLM evaluation was spent on an event I already handled.
    expect(prompts).toHaveLength(0);
  });

  it('fallback lane: the same reject gates the capability evaluation', () => {
    const { handler } = setup({ selfHandled: () => true });

    const evaluation = evaluateByCapabilities(handler, PROPOSAL);

    expect(evaluation.decision).toBe('reject');
    expect(evaluation.reasoning).toContain('Self-handling rejection');
  });

  it('a trigger event the agent did NOT self-handle evaluates normally (LLM accept)', async () => {
    const { handler, prompts } = setup({ selfHandled: () => false });

    const evaluation = await handler.evaluateProposal(PROPOSAL);

    expect(evaluation.decision).toBe('accept');
    expect(prompts).toHaveLength(1);
  });

  it('unwired seam → legacy behavior (no gate, LLM evaluates)', async () => {
    const { handler, prompts } = setup();

    const evaluation = await handler.evaluateProposal(PROPOSAL);

    expect(evaluation.decision).toBe('accept');
    expect(prompts).toHaveLength(1);
  });

  it('a proposal without a triggerEventId is never gated', async () => {
    const { handler, prompts } = setup({ selfHandled: () => true });
    const noTrigger: CollaborationProposal = { ...PROPOSAL, metadata: {} };

    const evaluation = await handler.evaluateProposal(noTrigger);

    expect(evaluation.decision).toBe('accept');
    expect(prompts).toHaveLength(1);
  });
});
