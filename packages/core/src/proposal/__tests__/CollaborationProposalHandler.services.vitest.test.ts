/**
 * R42-A/F3 (§7.1 + §7.2): service semantics in the AC responder prompt.
 *
 * - §7.1: the agent seam's `listMyServices` renders a "YOUR SERVICES (what
 *   you expose to others)" section; an unwired seam renders none (backward
 *   compatible) — the 631-service catalog finally enters the accept/reject
 *   decision path.
 * - §7.2: "Services Requested" expands structured terms as name[semanticType]
 *   while legacy plain strings keep their name-only rendering, and evaluation
 *   criterion 6 (SERVICE MATCH) rides the prompt.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  CollaborationProposalHandler,
  SERVICE_LIST_FILTER_THRESHOLD,
  SERVICE_LIST_MAX_SHOWN,
} from '../CollaborationProposalHandler.js';
import type { LLMClient } from '@active-collaboration/llm-integration';
import type { ChatParams, ChatResponse } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { CollaborationProposal } from '../types/proposal-handler.js';

const LLM_ANSWER = JSON.stringify({
  benefitScore: 0.8,
  costScore: 0.3,
  benefits: ['Service match'],
  costs: ['Resource commitment'],
  recommendedDecision: 'accept',
  reasoning: 'Productized exactly this',
  counterModifications: [],
});

function createHandler() {
  const mockLLMClient = {
    chat: vi.fn(),
    quickChat: vi.fn(),
  } as unknown as LLMClient;
  const mockEnvironment = {
    eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
  } as unknown as EnvironmentCenter;
  const handler = new CollaborationProposalHandler({
    llmClient: mockLLMClient,
    environment: mockEnvironment,
    agentId: 'agent-1',
    agentName: 'FloorButler',
    agentCapabilities: ['temperature-control'],
    config: {
      enabled: true,
      autoExecuteAccepted: false,
      maxConcurrentCollaborations: 5,
      criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
    },
  });
  return { handler, mockLLMClient };
}

async function promptOf(handler: CollaborationProposalHandler, mockLLMClient: LLMClient, proposal: CollaborationProposal): Promise<string> {
  (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>)
    .mockResolvedValue({ content: LLM_ANSWER });
  await handler['analyzeWithLLM'](proposal);
  const calls = (mockLLMClient.chat as Mock<(params: ChatParams) => Promise<ChatResponse>>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].messages[0].content as string;
}

const baseProposal: CollaborationProposal = {
  id: 'proposal-1',
  proposedBy: 'agent-2',
  proposedTo: 'agent-1',
  type: 'collaboration-invitation',
  goal: 'cool the library',
  task: 'temperature-control',
  description: 'Cool the library reading room',
  capabilities: ['temperature-control'],
};

describe('CollaborationProposalHandler — service semantics (R42-A/F3)', () => {
  describe('§7.1 YOUR SERVICES section (agent.listMyServices seam)', () => {
    it('renders the own service face name[semanticType] when the seam is wired', async () => {
      const { handler, mockLLMClient } = createHandler();
      handler.setAgent({
        joinCollaboration: async () => ({ success: true, collaborationId: 'c1', role: 'participant' }),
        listMyServices: () => [
          { name: 'night-cooling', semanticType: 'hvac-lease' },
          { name: '楼层温度控制', semanticType: 'temperature-control', visibility: 'public' },
        ],
      } as never);

      const prompt = await promptOf(handler, mockLLMClient, { ...baseProposal });

      expect(prompt).toContain('YOUR SERVICES (what you expose to others):');
      expect(prompt).toContain('- night-cooling[hvac-lease]');
      expect(prompt).toContain('- 楼层温度控制[temperature-control] (public)');
    });

    it('renders "none" when the seam is absent (backward compatible)', async () => {
      const { handler, mockLLMClient } = createHandler();
      handler.setAgent({
        joinCollaboration: async () => ({ success: true, collaborationId: 'c1', role: 'participant' }),
      } as never);

      const prompt = await promptOf(handler, mockLLMClient, { ...baseProposal });

      expect(prompt).toContain('YOUR SERVICES: none');
    });
  });

  describe('§7.2 Services Requested + criterion 6', () => {
    it('expands structured terms as name[semanticType] and legacy strings as name-only', async () => {
      const { handler, mockLLMClient } = createHandler();
      handler.setAgent({
        joinCollaboration: async () => ({ success: true, collaborationId: 'c1', role: 'participant' }),
        listMyServices: () => [{ name: 'night-cooling', semanticType: 'hvac-lease' }],
      } as never);

      const structured = await promptOf(handler, mockLLMClient, {
        ...baseProposal,
        services: [{ name: 'night-cooling', semanticType: 'hvac-lease', terms: { visibility: 'public' } }],
      });
      expect(structured).toContain('Services Requested:');
      expect(structured).toContain('night-cooling[hvac-lease]{public}');

      const legacy = await promptOf(handler, mockLLMClient, {
        ...baseProposal,
        services: ['cooling-service'],
      });
      expect(structured).not.toContain('cooling-service');
      expect(legacy).toContain('cooling-service');
      expect(legacy).not.toContain('cooling-service[');
    });

    it('adds evaluation criterion 6 (SERVICE MATCH → strong evidence for ACCEPT)', async () => {
      const { handler, mockLLMClient } = createHandler();
      const prompt = await promptOf(handler, mockLLMClient, { ...baseProposal });
      expect(prompt).toContain('6. SERVICE MATCH');
      expect(prompt).toMatch(/strong evidence for ACCEPT/);
    });
  });

  describe('R44-colossal: YOUR SERVICES relevance filter (service-catalog prompt bound)', () => {
    /**
     * The titanic reproduction shape: a district manager anchoring one device
     * per facility derives a huge own-service catalog (859 @ 250 facilities).
     * Most rows are irrelevant to any single proposal; a shelter-open proposal
     * needs lighting/temperature services.
     */
    const makeDistrictHandler = (serviceCount: number, relevantCount: number) => {
      const mockLLMClient = { chat: vi.fn(), quickChat: vi.fn() } as unknown as LLMClient;
      const mockEnvironment = {
        eventManager: { subscribe: vi.fn(), unsubscribe: vi.fn(), publish: vi.fn() },
      } as unknown as EnvironmentCenter;
      const services = [
        // The proposal-relevant head: shelter services.
        ...Array.from({ length: relevantCount }, (_, i) => ({
          name: `应急照明租赁 S-${i}`,
          semanticType: i % 2 === 0 ? 'lighting-control' : 'temperature-control',
          visibility: 'public',
        })),
        // The noise tail the proposal does not need.
        ...Array.from({ length: serviceCount - relevantCount }, (_, i) => ({
          name: `电网监测服务 N-${i}`,
          semanticType: 'power-monitoring',
        })),
      ];
      const handler = new CollaborationProposalHandler({
        llmClient: mockLLMClient,
        environment: mockEnvironment,
        agentId: 'baoan-steward',
        agentName: '宝安区 区管家',
        agentCapabilities: ['facility-management'],
        config: {
          enabled: true,
          autoExecuteAccepted: false,
          maxConcurrentCollaborations: 5,
          criteria: { minBenefitThreshold: 0.5, maxCostThreshold: 0.7 },
        },
      });
      handler.setAgent({
        joinCollaboration: async () => ({ success: true, collaborationId: 'c1', role: 'participant' }),
        listMyServices: () => services,
      } as never);
      return { handler, mockLLMClient, services };
    };

    /** The lines of the YOUR SERVICES section (up to the workload line). */
    const serviceLines = (prompt: string): string[] => {
      const section = prompt.split('YOUR SERVICES (what you expose to others):')[1]!.split('- Current Workload')[0];
      return section.split('\n').filter(line => line.startsWith('- '));
    };

    const shelterProposal: CollaborationProposal = {
      ...baseProposal,
      task: 'open shelters for the typhoon evacuation',
      capabilities: ['evacuation', 'lighting-control'],
      services: [{ name: '应急照明租赁', semanticType: 'lighting-control' }],
    };

    it('lists every service at or below the threshold — no filtering, no summary', async () => {
      const { handler, mockLLMClient } = makeDistrictHandler(SERVICE_LIST_FILTER_THRESHOLD, 5);
      const prompt = await promptOf(handler, mockLLMClient, shelterProposal);
      const lines = serviceLines(prompt);
      expect(lines).toHaveLength(SERVICE_LIST_FILTER_THRESHOLD);
      expect(prompt).not.toContain('…and');
    });

    it('above the threshold keeps the proposal-relevant services and bounds the section', async () => {
      // 100+ services, as the acceptance requires.
      const { handler, mockLLMClient, services } = makeDistrictHandler(120, 12);
      const prompt = await promptOf(handler, mockLLMClient, shelterProposal);
      const lines = serviceLines(prompt);

      // Bounded: top-N listed + exactly one summary line.
      expect(lines).toHaveLength(SERVICE_LIST_MAX_SHOWN + 1);
      const summary = lines.at(-1)!;
      expect(summary).toMatch(
        new RegExp(`…and ${120 - SERVICE_LIST_MAX_SHOWN} more \\(filter by semanticType; their types: power-monitoring\\)`),
      );

      // All 12 relevant services survive the cut (ranked before the noise tail).
      for (let i = 0; i < 12; i++) {
        expect(prompt).toContain(`应急照明租赁 S-${i}`);
      }
      // The noise head fills the remaining shown slots in original order; the
      // deep tail is hidden by relevance.
      expect(prompt).toContain('电网监测服务 N-0');
      expect(prompt).not.toContain('电网监测服务 N-100');
      expect(services).toHaveLength(120);
    });

    it('never loses the service surface — hidden services\' semanticType union rides the summary', async () => {
      const { handler, mockLLMClient } = makeDistrictHandler(120, 12);
      const prompt = await promptOf(handler, mockLLMClient, shelterProposal);
      const summary = serviceLines(prompt).at(-1)!;
      // The hidden noise services' semanticType is still visible in the union.
      expect(summary).toContain('power-monitoring');
    });

    it('bounds the whole evaluation prompt well under the 16K context (100+ services < 8K tokens)', async () => {
      // The titanic reproduction: 859 own services on a district manager
      // (pre-fix: ~10K tok for this section alone → 16,384 overflow → 400).
      const { handler, mockLLMClient } = makeDistrictHandler(859, 12);
      const prompt = await promptOf(handler, mockLLMClient, shelterProposal);
      // Conservative tokenizer bound (3 chars/token overestimates tokens for
      // this CJK/ASCII mix): 8K-token ceiling with wide margin.
      const estimatedTokens = Math.ceil(prompt.length / 3);
      expect(estimatedTokens).toBeLessThan(8192);
      // The services that matter for THIS proposal are still in the list.
      expect(prompt).toContain('应急照明租赁 S-0');
      // And the section itself is bounded to top-N + summary.
      expect(serviceLines(prompt)).toHaveLength(SERVICE_LIST_MAX_SHOWN + 1);
    });
  });
});
