/**
 * CollaborationProposalHandler Wave-4a tests — counter/defer convergence.
 *
 * The responder side of the handshake negotiation:
 * - a 'counter' decision publishes a CORRELATABLE counter answer
 *   (collaborationId + agentId + acDecision + evaluationSource, Fix-8 shape)
 *   so the initiator can re-evaluate it;
 * - a 'defer' decision publishes a defer answer (with the suggested delay)
 *   and schedules ONE re-evaluation — a proposal still undecided after the
 *   defer converts to a rejection, so the handshake always converges;
 * - the initiator's 'counter-response' closes the loop: accept → join under
 *   the counter's conditions with the regular join-response accept (the
 *   initiator's evaluation source is passed through); reject → stand down.
 */

import { describe, it, expect, vi } from 'vitest';
import { CollaborationProposalHandler } from '../CollaborationProposalHandler.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { EventManager } from '../../events/EventManager.js';
import { EventType, EventPriority } from '@active-collaboration/shared';

// criteria below: minBenefitThreshold 0.5 / maxCostThreshold 0.7.
// benefitScore 0.45 sits in the "near threshold" band → counter or defer
// (per recommendedDecision); 0.9/0.1 is a clear accept.
const CANNED_COUNTER = JSON.stringify({
  benefitScore: 0.45,
  costScore: 0.5,
  benefits: ['grid relief'],
  costs: ['evening commitment'],
  recommendedDecision: 'counter',
  reasoning: 'acceptable with modifications',
  counterModifications: ['run after 18:00'],
});
const CANNED_DEFER = JSON.stringify({
  benefitScore: 0.45,
  costScore: 0.5,
  benefits: ['grid relief'],
  costs: ['uncertain load'],
  recommendedDecision: 'defer',
  reasoning: 'need more information',
});
const CANNED_ACCEPT = JSON.stringify({
  benefitScore: 0.9,
  costScore: 0.1,
  benefits: ['can help'],
  costs: [],
  recommendedDecision: 'accept',
  reasoning: 'cheap to help',
});

function mockLLMSequence(responses: string[]): LLMClient {
  let index = 0;
  return {
    chat: async () => ({
      content: responses[Math.min(index++, responses.length - 1)],
      model: 'mock-model',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  } as unknown as LLMClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('CollaborationProposalHandler — counter/defer (Wave-4a)', () => {
  function setup(llmResponses: string[], deferDelayMs?: number) {
    const eventManager = new EventManager(1000);
    const joinCollaboration = vi.fn().mockResolvedValue({ success: true, collaborationId: 'ac-1', role: 'participant' });
    const handler = new CollaborationProposalHandler({
      llmClient: mockLLMSequence(llmResponses),
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
        ...(deferDelayMs !== undefined ? { deferDelayMs } : {}),
      },
    });
    handler.setAgent({ joinCollaboration });
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
    return { eventManager, handler, published, joinCollaboration };
  }

  function propose(eventManager: EventManager, requiredCapabilities: string[] = ['cooling']): void {
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
        requiredCapabilities,
      },
      metadata: {},
    });
  }

  it('a counter decision publishes a correlatable counter answer (Fix-8 shape)', async () => {
    const { eventManager, handler, published } = setup([CANNED_COUNTER]);
    propose(eventManager);
    await sleep(100);

    const counters = published.filter(p => p.type === 'counter');
    expect(counters).toHaveLength(1);
    expect(counters[0]).toMatchObject({
      acDecision: 'counter',
      agentId: 'agent-1',
      collaborationId: 'ac-1',
      evaluationSource: 'llm',
      counterProposal: { modifications: ['run after 18:00'] },
    });
    // No premature accept/reject alongside the counter.
    expect(published.filter(p => p.type === 'join-response' || p.type === 'reject')).toHaveLength(0);
    handler.stop();
  });

  it('defer publishes a defer answer and the re-evaluation closes with an accept', async () => {
    // R44-dense-F2: the defer lane is exercised with a proposal the agent
    // CANNOT deliver ('water-pumping' vs cooling devices) — a capability-
    // match proposal now shortcuts to accept via the cross-check below.
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_DEFER, CANNED_ACCEPT], 50);
    propose(eventManager, ['water-pumping']);

    await vi.waitFor(() => {
      expect(published.filter(p => p.type === 'join-response')).toHaveLength(1);
    }, { timeout: 2000 });

    const defers = published.filter(p => p.type === 'defer');
    expect(defers).toHaveLength(1);
    expect(defers[0]).toMatchObject({
      acDecision: 'defer',
      agentId: 'agent-1',
      collaborationId: 'ac-1',
      evaluationSource: 'llm',
      deferMs: 50,
    });

    const accepts = published.filter(p => p.type === 'join-response');
    expect(accepts[0]).toMatchObject({ acDecision: 'accept', collaborationId: 'ac-1' });
    expect(joinCollaboration).toHaveBeenCalledWith('ac-1', expect.anything());
    handler.stop();
  });

  it('a proposal still undecided after one defer converts to a rejection', async () => {
    // R44-dense-F2: same undeliverable-proposal framing as the defer test
    // above — the defer convergence ladder (defer → re-eval → reject) is
    // observable only when the capability cross-check cannot accept.
    const { eventManager, handler, published } = setup([CANNED_DEFER, CANNED_DEFER], 50);
    propose(eventManager, ['water-pumping']);

    await vi.waitFor(() => {
      expect(published.filter(p => p.type === 'reject')).toHaveLength(1);
    }, { timeout: 2000 });

    // Exactly one defer was published (the first decision); the re-evaluation
    // rejected instead of deferring again.
    expect(published.filter(p => p.type === 'defer')).toHaveLength(1);
    expect(published.filter(p => p.type === 'join-response')).toHaveLength(0);
    handler.stop();
  });

  it('counter-response accept joins under the counter conditions and answers accept (initiator source passed through)', async () => {
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_ACCEPT]);
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'counter-response',
        acDecision: 'accept',
        agentId: 'agent-2',
        targetAgentId: 'agent-1',
        collaborationId: 'ac-1',
        reason: 'the modified conditions are acceptable',
        evaluationSource: 'rule',
        proposal: {
          id: 'ac-1',
          proposedBy: 'agent-2',
          proposedTo: 'agent-1',
          type: 'collaboration-invitation',
          goal: 'Reduce grid load',
          capabilities: ['cooling'],
          metadata: { collaborationId: 'ac-1' },
        },
      },
      metadata: {},
    });

    await vi.waitFor(() => {
      expect(published.filter(p => p.type === 'join-response')).toHaveLength(1);
    }, { timeout: 2000 });

    const accepts = published.filter(p => p.type === 'join-response');
    expect(accepts[0]).toMatchObject({
      acDecision: 'accept',
      agentId: 'agent-1',
      collaborationId: 'ac-1',
      // The initiator made this decision by rule — the label says so.
      evaluationSource: 'rule',
    });
    expect(String(accepts[0].reason)).toContain('Counter-proposal accepted');
    expect(joinCollaboration).toHaveBeenCalledWith('ac-1', expect.anything());
    handler.stop();
  });

  it('counter-response reject stands down — no join, no further answer', async () => {
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_ACCEPT]);
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'counter-response',
        acDecision: 'reject',
        agentId: 'agent-2',
        targetAgentId: 'agent-1',
        collaborationId: 'ac-1',
        reason: 'modified conditions rejected',
        evaluationSource: 'rule',
      },
      metadata: {},
    });
    await sleep(100);

    // The handler itself published nothing (the recorder sees the test's own
    // counter-response on the bus — filter it out).
    expect(published.filter(p => p.type !== 'counter-response')).toHaveLength(0);
    expect(joinCollaboration).not.toHaveBeenCalled();
    handler.stop();
  });

  it('a counter-response addressed to ANOTHER agent is ignored', async () => {
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_ACCEPT]);
    eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: 'agent-2',
      priority: EventPriority.NORMAL,
      payload: {
        type: 'counter-response',
        acDecision: 'accept',
        agentId: 'agent-2',
        targetAgentId: 'agent-9',
        collaborationId: 'ac-1',
        reason: 'not for me',
        proposal: { id: 'ac-1', proposedBy: 'agent-2', proposedTo: 'agent-9' },
      },
      metadata: {},
    });
    await sleep(100);

    expect(published.filter(p => p.type !== 'counter-response')).toHaveLength(0);
    expect(joinCollaboration).not.toHaveBeenCalled();
    handler.stop();
  });
});

/**
 * R45-P1: rule-accept scoped to fallback only.
 *
 * R44-dense-F2 added a capability cross-check that converted an LLM
 * reject/defer into a rule accept whenever the capability match cleared the
 * fallback bar. R45 measured the consequence (devloop-r45-realistic-report
 * §2.2/F1): the rule lane accepted 158/158, overriding LEGITIMATE LLM
 * rejections ("workload too high", relevance misses) and driving accept
 * precision to 46%. The cross-check is removed: an explicit LLM judgment is
 * respected; the deterministic capability rule decides only when the LLM
 * cannot answer at all (the 'fallback' path — LLM error/timeout/unparseable
 * output, covered in fix12 tests).
 */
describe('CollaborationProposalHandler — rule scoped to fallback (R45-P1)', () => {
  function setup(llmResponses: string[], maxConcurrentCollaborations = 5) {
    const eventManager = new EventManager(1000);
    const joinCollaboration = vi.fn().mockResolvedValue({ success: true, collaborationId: 'ac-1', role: 'participant' });
    const handler = new CollaborationProposalHandler({
      llmClient: mockLLMSequence(llmResponses),
      environment: { eventManager } as unknown as EnvironmentCenter,
      agentId: 'agent-1',
      agentName: 'Responder',
      agentCapabilities: ['cooling', 'temperature-control'],
      config: {
        enabled: true,
        criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
        autoExecuteAccepted: false,
        notifyAllProposals: false,
        maxConcurrentCollaborations,
      },
    });
    handler.setAgent({ joinCollaboration });
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
    return { eventManager, handler, published, joinCollaboration };
  }

  const CANNED_REJECT = JSON.stringify({
    benefitScore: 0.2,
    costScore: 0.6,
    benefits: [],
    costs: ['my devices cannot cover the emergency'],
    recommendedDecision: 'reject',
    reasoning: 'Device capabilities do not cover the needs',
  });

  function propose(eventManager: EventManager, requiredCapabilities: string[]): void {
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
        requiredCapabilities,
      },
      metadata: {},
    });
  }

  it('LLM reject + capability match ≥ threshold → the reject stands (no rule override)', async () => {
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_REJECT]);
    propose(eventManager, ['cooling']);
    await sleep(100);

    const rejects = published.filter(p => p.type === 'reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({
      acDecision: 'reject',
      agentId: 'agent-1',
      collaborationId: 'ac-1',
      evaluationSource: 'llm',
    });
    expect(published.filter(p => p.type === 'join-response' || p.type === 'defer')).toHaveLength(0);
    expect(joinCollaboration).not.toHaveBeenCalled();
    handler.stop();
  });

  it('LLM defer + capability match → the defer stands (defer ladder converges, no rule shortcut)', async () => {
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_DEFER], 5);
    propose(eventManager, ['cooling']);
    await sleep(100);

    const defers = published.filter(p => p.type === 'defer');
    expect(defers).toHaveLength(1);
    expect(defers[0]).toMatchObject({ acDecision: 'defer', evaluationSource: 'llm' });
    expect(published.filter(p => p.type === 'join-response')).toHaveLength(0);
    expect(joinCollaboration).not.toHaveBeenCalled();
    handler.stop();
  });

  it('LLM failure + capability match 0.6 → fallback accepts (rule lane keeps its rescue role)', async () => {
    // LLM throws (unparseable) → the catch-path capability fallback decides.
    // 2/3 required caps matched ('cooling', 'temperature-control' out of
    // + 'grid-dispatch') = 0.67 ≥ 0.5 threshold → accept, labelled 'fallback'.
    const { eventManager, handler, published, joinCollaboration } = setup(['not-json{{']);
    propose(eventManager, ['cooling', 'temperature-control', 'grid-dispatch']);
    await sleep(100);

    const accepts = published.filter(p => p.type === 'join-response');
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      acDecision: 'accept',
      agentId: 'agent-1',
      collaborationId: 'ac-1',
      evaluationSource: 'fallback',
    });
    expect(String(accepts[0].reason)).toContain('2/3');
    expect(joinCollaboration).toHaveBeenCalledWith('ac-1', expect.anything());
    handler.stop();
  });

  it('workload reject (max collaborations reached) is not overridden even with a perfect capability match', async () => {
    // R45-F1: the dominant override victim was the LLM workload reject — the
    // deterministic pre-LLM workload gate rejects, and no capability evidence
    // may convert it into an accept.
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_ACCEPT], 0);
    propose(eventManager, ['cooling']);
    await sleep(100);

    const rejects = published.filter(p => p.type === 'reject');
    expect(rejects).toHaveLength(1);
    expect(String(rejects[0].reason)).toContain('Maximum concurrent collaborations');
    expect(published.filter(p => p.type === 'join-response')).toHaveLength(0);
    expect(joinCollaboration).not.toHaveBeenCalled();
    handler.stop();
  });

  it('LLM reject with NO capability match → the reject stands (llm source)', async () => {
    const { eventManager, handler, published, joinCollaboration } = setup([CANNED_REJECT]);
    propose(eventManager, ['water-pumping']);
    await sleep(100);

    const rejects = published.filter(p => p.type === 'reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ acDecision: 'reject', evaluationSource: 'llm' });
    expect(published.filter(p => p.type === 'join-response')).toHaveLength(0);
    expect(joinCollaboration).not.toHaveBeenCalled();
    handler.stop();
  });

  it('LLM counter + capability match → the counter is preserved (negotiation intent not overridden)', async () => {
    const { eventManager, handler, published } = setup([CANNED_COUNTER]);
    propose(eventManager, ['cooling']);
    await sleep(100);

    expect(published.filter(p => p.type === 'counter')).toHaveLength(1);
    expect(published.filter(p => p.type === 'join-response' || p.type === 'reject' || p.type === 'defer')).toHaveLength(0);
    handler.stop();
  });
});
