/**
 * Per-function LLM routing — CognitiveAgent call-site distribution tests.
 *
 * A deployment may route individual call-site classes to their own model
 * (LLM_DECISION_MODEL / LLM_EVAL_MODEL / LLM_NL_MODEL). The runtime hands
 * the routed clients to every agent as `llmFunctionClients`; CognitiveAgent
 * must wire:
 *   - decision → DualTriggerACManager (AC necessity, initiator lane)
 *   - eval     → CollaborationProposalHandler (responder lane)
 *   - nl       → the NL seam's llmChat
 * while counter-offers (CollaborationCoordinator) keep the agent's own
 * client. Absent slots fall through to the shared client.
 */

import { describe, it, expect, vi } from 'vitest';
import { CognitiveAgent } from '../CognitiveAgent.js';
import { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

function stubClient(label: string): LLMClient {
  return {
    label,
    getProviderName: () => 'openai-compatible',
    getModel: () => label,
    chat: vi.fn(async () => ({ content: 'ok', model: label })),
    quickChat: vi.fn(async () => ({ content: 'ok', model: label })),
  } as unknown as LLMClient;
}

function buildAgent(
  shared: LLMClient,
  llmFunctionClients?: { decision?: LLMClient; eval?: LLMClient; nl?: LLMClient },
): CognitiveAgent {
  return new CognitiveAgent({
    id: `agent-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Routing Test Agent',
    description: 'per-function routing test',
    owner: 'test',
    environment: new EnvironmentCenter({
      id: `fn-route-env-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Function Routing Test Environment',
      createdBy: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    llmClient: shared,
    capabilities: [],
    ...(llmFunctionClients !== undefined ? { llmFunctionClients } : {}),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const managerOf = (agent: CognitiveAgent): any => (agent as any).dualTriggerACManager;
const coordinatorOf = (agent: CognitiveAgent): any => (agent as any).collaborationCoordinator;

describe('CognitiveAgent per-function LLM routing', () => {
  it('routed clients reach their call sites; counter-offers keep the shared client', async () => {
    const shared = stubClient('shared');
    const decision = stubClient('decision');
    const evalC = stubClient('eval');
    const nl = stubClient('nl');
    const agent = buildAgent(shared, { decision, eval: evalC, nl });

    // decision → AC necessity manager (initiator lane).
    expect(managerOf(agent).llmClient).toBe(decision);
    // eval → proposal-response evaluation (responder lane).
    expect((agent.proposalHandler as any).llmClient).toBe(evalC);
    // counter-offers keep the agent's own client (not routed).
    expect(coordinatorOf(agent).llmClient).toBe(shared);

    // nl → the NL seam's llmChat.
    const seam = (agent as any).buildNLSeam({});
    expect(typeof seam.llmChat).toBe('function');
    await seam.llmChat({ messages: [{ role: 'user', content: 'hi' }] });
    expect((nl.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((shared.chat as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('absent slots fall through to the shared client', async () => {
    const shared = stubClient('shared');
    const evalC = stubClient('eval');
    const agent = buildAgent(shared, { eval: evalC });

    expect(managerOf(agent).llmClient).toBe(shared);
    expect((agent.proposalHandler as any).llmClient).toBe(evalC);

    const seam = (agent as any).buildNLSeam({});
    await seam.llmChat({ messages: [{ role: 'user', content: 'hi' }] });
    expect((shared.chat as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('no function clients at all → every call site on the shared client (legacy)', () => {
    const shared = stubClient('shared');
    const agent = buildAgent(shared);

    expect(managerOf(agent).llmClient).toBe(shared);
    expect((agent.proposalHandler as any).llmClient).toBe(shared);
    expect(coordinatorOf(agent).llmClient).toBe(shared);
  });
});
