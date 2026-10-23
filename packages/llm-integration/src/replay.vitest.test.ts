/**
 * F4-2 VCR replay mode (plan-r84) — LLM_REPLAY / config.replay.
 *
 * Replay mode serves chat() ONLY from the response cache: a hit behaves like
 * a normal cached response (provider never called), a miss throws
 * LLMReplayMissError carrying the request fingerprint for re-recording, and
 * replay without an attached cache is a configuration error. With replay off
 * (default) a miss still falls through to the provider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMCache, buildCacheKey } from './cache';
import { LLMClient, LLMReplayMissError, isReplayMissError } from './client';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const MODEL = 'ac-decision-v5';
const CONFIG = { baseURL: 'http://localhost:8000/v1', model: MODEL };

function mockOpenAICompatibleResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1704067200,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

/** Pre-populate a cache the way llm-record.mjs does: keyed by buildCacheKey. */
function recordedCache(userPrompt: string, response: string): LLMCache {
  const cache = new LLMCache();
  cache.set(
    buildCacheKey({
      provider: 'openai-compatible',
      model: MODEL,
      systemPrompt: 'You decide.',
      userPrompt,
      temperature: 0,
    }),
    { response, model: MODEL, storedAt: Date.now() },
  );
  return cache;
}

describe('LLMClient replay mode (F4-2)', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(mockOpenAICompatibleResponse('{"action":"wait"}'));
  });

  afterEach(() => {
    delete process.env.LLM_REPLAY;
  });

  it('serves a recorded request from the cache — provider never called', async () => {
    const client = new LLMClient('openai-compatible', {
      ...CONFIG,
      replay: true,
      cache: recordedCache('把客厅空调调到26度', '{"action":"set_parameter"}'),
    });

    const res = await client.quickChat('把客厅空调调到26度', 'You decide.', undefined, undefined, { temperature: 0 });

    expect(res.content).toBe('{"action":"set_parameter"}');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a cache miss throws LLMReplayMissError with the request fingerprint', async () => {
    const client = new LLMClient('openai-compatible', {
      ...CONFIG,
      replay: true,
      cache: new LLMCache(),
    });

    const error = await client
      .quickChat('unrecorded prompt for the fingerprint test', 'You decide.', undefined, undefined, { temperature: 0 })
      .catch((e: unknown) => e);

    expect(isReplayMissError(error)).toBe(true);
    const miss = error as LLMReplayMissError;
    expect(miss.cacheKey).toBe(
      buildCacheKey({
        provider: 'openai-compatible',
        model: MODEL,
        systemPrompt: 'You decide.',
        userPrompt: 'unrecorded prompt for the fingerprint test',
        temperature: 0,
      }),
    );
    expect(miss.message).toContain('LLM_REPLAY cache miss');
    expect(miss.message).toContain('unrecorded prompt for the fingerprint test');
    expect(miss.message).toContain('llm-record.mjs');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('replay without an attached cache is a configuration error', async () => {
    const client = new LLMClient('openai-compatible', { ...CONFIG, replay: true });

    await expect(client.quickChat('hello')).rejects.toThrow(LLMReplayMissError);
    await expect(client.quickChat('hello')).rejects.toThrow(/requires a response cache/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('replay off (default): a miss falls through to the provider', async () => {
    const client = new LLMClient('openai-compatible', { ...CONFIG, cache: new LLMCache() });

    const res = await client.quickChat('hello');
    expect(res.content).toBe('{"action":"wait"}');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('the LLM_REPLAY env enables replay when config.replay is unset', async () => {
    process.env.LLM_REPLAY = '1';
    const client = new LLMClient('openai-compatible', { ...CONFIG, cache: new LLMCache() });

    await expect(client.quickChat('hello')).rejects.toThrow(LLMReplayMissError);
    expect(mockFetch).not.toHaveBeenCalled();

    // An explicit config flag wins over the env.
    const explicit = new LLMClient('openai-compatible', { ...CONFIG, cache: new LLMCache(), replay: false });
    await explicit.quickChat('hello');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
