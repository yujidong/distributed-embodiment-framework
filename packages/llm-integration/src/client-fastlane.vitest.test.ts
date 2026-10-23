/**
 * Fast-lane call-site marking tests (per-function routing).
 *
 * Historically the fast lane keyed on the ac-decision model-name prefix.
 * With per-function model routing the lane follows the CALL SITE: a client
 * constructed with fastLane:true (the decision/triage clients) takes the
 * fast-lane queue regardless of model name; fastLane:false opts an
 * ac-decision-prefixed model OUT. Unmarked clients keep the legacy prefix
 * heuristic as compat fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, getLLMQueueStats, getFastLaneQueueStats } from './client';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

function okResponse() {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1704067200,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

describe('fast-lane queue selection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });

  it('fastLane:true routes to the fast lane even without the ac-decision prefix', async () => {
    const fastBefore = getFastLaneQueueStats().waitCount;
    const globalBefore = getLLMQueueStats().waitCount;
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'qwen3-27b',
      fastLane: true,
    });
    await client.quickChat('hi');
    expect(getFastLaneQueueStats().waitCount).toBe(fastBefore + 1);
    expect(getLLMQueueStats().waitCount).toBe(globalBefore);
  });

  it('fastLane:false opts an ac-decision-prefixed model OUT of the fast lane', async () => {
    const fastBefore = getFastLaneQueueStats().waitCount;
    const globalBefore = getLLMQueueStats().waitCount;
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'ac-decision-v6',
      fastLane: false,
    });
    await client.quickChat('hi');
    expect(getFastLaneQueueStats().waitCount).toBe(fastBefore);
    expect(getLLMQueueStats().waitCount).toBe(globalBefore + 1);
  });

  it('unmarked clients keep the legacy ac-decision prefix heuristic', async () => {
    const fastBefore = getFastLaneQueueStats().waitCount;
    const globalBefore = getLLMQueueStats().waitCount;
    const prefixed = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'ac-decision-v6',
    });
    await prefixed.quickChat('hi');
    expect(getFastLaneQueueStats().waitCount).toBe(fastBefore + 1);
    expect(getLLMQueueStats().waitCount).toBe(globalBefore);

    const plain = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'qwen3-27b',
    });
    await plain.quickChat('hi');
    expect(getFastLaneQueueStats().waitCount).toBe(fastBefore + 1);
    expect(getLLMQueueStats().waitCount).toBe(globalBefore + 1);
  });
});
