/**
 * T-024 (DevLoop R17) — reviewer LLM observability (ED-F11).
 *
 * The proposal-review LLM client used to be built bare: no
 * instrumentLLMClient, no response cache — review tokens/latency were
 * invisible to the metrics collector, and identical review prompts were
 * re-billed on every resubmission. selectProposalReviewer now attaches the
 * shared cache + the metrics sinks, exactly like the registry's simulation
 * clients.
 */

import { describe, it, expect } from 'vitest';

import { LLMCache } from '@active-collaboration/llm-integration';

import { selectProposalReviewer } from './server.js';
import { LLMReviewer } from './proposal-llm-reviewer.js';
import type { ServerConfig } from './config.js';

function minimalConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    llmProvider: 'openai-compatible',
    llmBaseUrl: 'http://127.0.0.1:9/v1', // unreachable by design (failure-path probe)
    llmModel: 'review-model',
    proposalReviewer: 'llm',
    proposalReviewLlmTimeoutMs: 500,
    proposalReviewTimeoutAutoApprove: true,
    ...overrides,
  } as ServerConfig;
}

describe('T-024: reviewer client observability wiring', () => {
  it('returns undefined when no LLM backend is configured', () => {
    expect(selectProposalReviewer(
      minimalConfig({ llmBaseUrl: undefined, llmModel: undefined, proposalReviewer: 'auto' }),
      undefined as never,
      { warn: () => {} },
    )).toBeUndefined();
  });

  it('attaches the shared cache to the reviewer client', () => {
    const cache = new LLMCache();
    const reviewer = selectProposalReviewer(minimalConfig(), undefined as never, { warn: () => {} }, {
      cache,
    });
    expect(reviewer).toBeInstanceOf(LLMReviewer);
    // The reviewer's client carries the SAME cache instance the simulation
    // clients share — identical review prompts are served, not re-billed.
    expect((reviewer as unknown as { deps: { llm: { getCache(): LLMCache | null } } })
      .deps.llm.getCache()).toBe(cache);
  });

  it('routes review calls through the metrics sinks (latency accounting on failure)', async () => {
    const latencies: Array<{ durationMs: number; success: boolean }> = [];
    const usages: unknown[] = [];
    const reviewer = selectProposalReviewer(minimalConfig(), undefined as never, { warn: () => {} }, {
      onUsage: usage => usages.push(usage),
      onLatency: (durationMs, success) => latencies.push({ durationMs, success }),
    });
    expect(reviewer).toBeInstanceOf(LLMReviewer);
    const llm = (reviewer as unknown as { deps: { llm: { chat(p: unknown): Promise<unknown> } } }).deps.llm;

    // The instrumentation wraps chat(): the unreachable provider fails, and
    // the latency sink still sees the call (success=false) — without the
    // wrap, review failures were invisible to /metrics.
    await expect(llm.chat({ messages: [{ role: 'user', content: 'probe' }] })).rejects.toThrow();
    expect(latencies.length).toBe(1);
    expect(latencies[0]!.success).toBe(false);
    expect(usages).toEqual([]);
  });
});
