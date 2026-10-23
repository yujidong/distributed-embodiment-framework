/**
 * CollaborationProposalHandler Fix-12 tests (R4 小周 F-15/F-16)
 *
 * Covers the collaboration-quality batch:
 * - accept evaluation is LLM-first: a working LLM decides and the response
 *   is labelled evaluationSource 'llm';
 * - the capability fallback is TIGHTENED: empty required capabilities no
 *   longer rubber-stamps ("0/0 matched" used to accept at the 0.5 default),
 *   and an under-50% match rejects with the match detail in the reasoning;
 * - fallback outcomes are labelled 'fallback' (not 'rule'/'llm') so the
 *   trajectory shows the LLM did not participate;
 * - the evaluation LLM call has its own wall-clock budget (llmTimeoutMs):
 *   a hung model degrades to the fallback in milliseconds instead of
 *   burning the provider-level timeout (~120s class) — the root cause
 *   of handshake accepts landing ~110-120s after the proposal.
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

function mockLLM(behavior: 'accept' | 'throw' | 'hang'): LLMClient {
  return {
    chat: async () => {
      if (behavior === 'throw') throw new Error('LLM unavailable');
      if (behavior === 'hang') {
        await new Promise(resolve => setTimeout(resolve, 3_000));
      }
      return {
        content: CANNED_ACCEPT,
        model: 'mock-model',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as LLMClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('CollaborationProposalHandler — accept quality (Fix-12)', () => {
  function setup(behavior: 'accept' | 'throw' | 'hang', llmTimeoutMs?: number) {
    const eventManager = new EventManager(1000);
    const handler = new CollaborationProposalHandler({
      llmClient: mockLLM(behavior),
      environment: { eventManager } as unknown as EnvironmentCenter,
      agentId: 'agent-1',
      agentName: 'Responder',
      agentCapabilities: ['cooling', 'temperature-control'],
      config: {
        enabled: true,
        criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
        autoExecuteAccepted: false,
        notifyAllProposals: false,
        maxConcurrentCollaborations: 5,
        ...(llmTimeoutMs !== undefined ? { llmTimeoutMs } : {}),
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

  function propose(eventManager: EventManager, requiredCapabilities?: string[]): void {
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'ac-proposal',
        collaborationId: 'ac-1',
        initiatorId: 'agent-2',
        targetAgentId: 'agent-1',
        description: 'Reduce grid load by shedding cooling',
        ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
      },
      metadata: {},
    });
  }

  it('LLM-first: a working LLM decides and the accept is labelled llm', async () => {
    const { eventManager, handler, published } = setup('accept');
    propose(eventManager, ['cooling']);
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'llm' });
    handler.stop();
  });

  it('fallback rejects an EMPTY required-capability list instead of rubber-stamping', async () => {
    const { eventManager, handler, published } = setup('throw');
    propose(eventManager, []);
    await sleep(100);

    // Wave 6 F5: empty-capability proposals now DEFER (not hard-reject) to
    // give the initiator time to clarify or find other partners.
    const answers = published.filter(p => p.type === 'defer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'defer', evaluationSource: 'fallback' });
    expect(String(answers[0].reason)).toContain('no required capabilities');
    // No accept may slip through alongside the reject.
    expect(published.filter(p => p.type === 'join-response')).toHaveLength(0);
    handler.stop();
  });

  it('fallback rejects when under half the required capabilities match, with detail', async () => {
    const { eventManager, handler, published } = setup('throw');
    propose(eventManager, ['cooling', 'grid-dispatch', 'load-shedding']);
    await sleep(100);

    const answers = published.filter(p => p.type === 'reject');
    expect(answers).toHaveLength(1);
    expect(answers[0].evaluationSource).toBe('fallback');
    expect(String(answers[0].reason)).toContain('1/3');
    expect(String(answers[0].reason)).toContain('grid-dispatch');
    handler.stop();
  });

  it('fallback accepts on a genuine capability match and says so honestly', async () => {
    const { eventManager, handler, published } = setup('throw');
    propose(eventManager, ['cooling', 'temperature-control']);
    await sleep(100);

    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ acDecision: 'accept', evaluationSource: 'fallback' });
    expect(String(answers[0].reason)).toContain('2/2');
    handler.stop();
  });

  it('a hung evaluation LLM hits the per-call budget and falls back fast (≪120s)', async () => {
    const { eventManager, handler, published } = setup('hang', 100);
    const startedAt = Date.now();
    propose(eventManager, ['cooling']);

    await sleep(1500);
    const elapsed = Date.now() - startedAt;

    // The answer is out — capability fallback accepted the matching proposal —
    // and it took the ~100ms budget, not the ~120s provider timeout (R4 F-16).
    const answers = published.filter(p => p.type === 'join-response');
    expect(answers).toHaveLength(1);
    expect(answers[0].evaluationSource).toBe('fallback');
    expect(elapsed).toBeLessThan(5000);
    handler.stop();
  }, 15_000);
});
