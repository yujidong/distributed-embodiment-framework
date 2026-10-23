/**
 * Unit tests for LLM response cache (P4-2)
 *
 * Covers:
 * - buildCacheKey stability: whitespace-insensitive, format key-order-insensitive,
 *   case-sensitive, temperature-bucketed
 * - LLMCache LRU eviction
 * - LLMClient integration: a cache hit short-circuits the request queue
 *   (provider fetch called exactly once for two identical requests) and the
 *   logging callback still fires with `cached: true`
 * - stats: hits / misses / hitRate / tokensSavedEstimate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMCache, buildCacheKey } from './cache';
import { LLMClient } from './client';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const SCHEMA_A = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['collaborate', 'independent'] },
    reasoning: { type: 'string' },
  },
  required: ['decision', 'reasoning'],
};

// Same schema, different key order
const SCHEMA_B = {
  required: ['decision', 'reasoning'],
  properties: {
    reasoning: { type: 'string' },
    decision: { type: 'string', enum: ['collaborate', 'independent'] },
  },
  type: 'object',
};

const BASE_KEY = {
  provider: 'openai-compatible',
  model: 'Qwen/Qwen2.5-7B-Instruct',
  systemPrompt: 'You decide.',
  userPrompt: 'Should we collaborate?',
};

describe('buildCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(buildCacheKey(BASE_KEY)).toBe(buildCacheKey({ ...BASE_KEY }));
  });

  it('is whitespace-insensitive (trim + collapsed runs)', () => {
    const a = buildCacheKey(BASE_KEY);
    const b = buildCacheKey({
      ...BASE_KEY,
      systemPrompt: '  You\n decide.  ',
      userPrompt: 'Should we\t collaborate?\n',
    });
    expect(a).toBe(b);
  });

  it('is NOT case-insensitive', () => {
    const a = buildCacheKey(BASE_KEY);
    const b = buildCacheKey({ ...BASE_KEY, userPrompt: 'SHOULD WE COLLABORATE?' });
    expect(a).not.toBe(b);
  });

  it('is insensitive to JSON-schema key order in format', () => {
    const a = buildCacheKey({ ...BASE_KEY, format: SCHEMA_A });
    const b = buildCacheKey({ ...BASE_KEY, format: SCHEMA_B });
    expect(a).toBe(b);
  });

  it('distinguishes format: json vs a schema vs none', () => {
    const none = buildCacheKey(BASE_KEY);
    const json = buildCacheKey({ ...BASE_KEY, format: 'json' as const });
    const schema = buildCacheKey({ ...BASE_KEY, format: SCHEMA_A });
    expect(new Set([none, json, schema]).size).toBe(3);
  });

  it('distinguishes model, provider, and temperature', () => {
    const base = buildCacheKey({ ...BASE_KEY, temperature: 0 });
    expect(buildCacheKey({ ...BASE_KEY, temperature: 0, model: 'other' })).not.toBe(base);
    expect(buildCacheKey({ ...BASE_KEY, temperature: 0, provider: 'other' })).not.toBe(base);
    expect(buildCacheKey({ ...BASE_KEY, temperature: 0.5 })).not.toBe(base);
    // Documented: omitted temperature is its own bucket, distinct from explicit 0
    expect(buildCacheKey({ ...BASE_KEY })).not.toBe(base);
  });
});

describe('LLMCache', () => {
  it('returns undefined and counts a miss for unknown keys', () => {
    const cache = new LLMCache();
    expect(cache.get('nope')).toBeUndefined();
    const stats = cache.getStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  it('serves stored entries and tracks hit stats + tokens saved', () => {
    const cache = new LLMCache();
    cache.set('k1', {
      response: 'hello',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: 'm',
      storedAt: Date.now(),
    });
    const entry = cache.get('k1');
    expect(entry?.response).toBe('hello');

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(1);
    expect(stats.tokensSavedEstimate).toBe(15);
    expect(stats.size).toBe(1);
  });

  it('evicts the least-recently-used entry beyond maxSize', () => {
    const cache = new LLMCache({ maxSize: 2 });
    const entry = (r: string) => ({ response: r, model: 'm', storedAt: Date.now() });
    cache.set('a', entry('a'));
    cache.set('b', entry('b'));

    // Touch 'a' so 'b' becomes the LRU entry
    expect(cache.get('a')?.response).toBe('a');

    cache.set('c', entry('c'));

    expect(cache.get('b')).toBeUndefined(); // evicted
    expect(cache.get('a')?.response).toBe('a');
    expect(cache.get('c')?.response).toBe('c');
    expect(cache.getStats().size).toBe(2);
  });

  it('degrades to in-memory when SQLite persistence is unavailable', () => {
    // better-sqlite3 is not a dependency of this package — init must not throw.
    const cache = new LLMCache({ persistPath: '/nonexistent-dir/cache.db' });
    cache.set('k', { response: 'v', model: 'm', storedAt: Date.now() });
    expect(cache.get('k')?.response).toBe('v');
  });
});

describe('LLMClient cache integration', () => {
  function mockOpenAICompatibleResponse(content: string) {
    return {
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1704067200,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    };
  }

  beforeEach(() => {
    mockFetch.mockResolvedValue(mockOpenAICompatibleResponse('{"decision":"collaborate","reasoning":"test"}'));
  });

  it('second identical call is served from cache — provider called once, callback marked cached', async () => {
    const client = new LLMClient('openai-compatible', { baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct' });
    const cache = new LLMCache();
    client.enableCache(cache);

    const logCalls: Array<Record<string, unknown>> = [];
    client.setLoggingCallback(params => logCalls.push(params as unknown as Record<string, unknown>));

    const first = await client.quickChat('Should we collaborate?', 'You decide.');
    const second = await client.quickChat('Should we collaborate?', 'You decide.');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second.content).toBe(first.content);
    expect(second.usage?.totalTokens).toBe(15);

    expect(logCalls).toHaveLength(2);
    expect(logCalls[0].cached).toBeUndefined();
    expect(logCalls[1].cached).toBe(true);

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
    expect(stats.tokensSavedEstimate).toBe(15);
  });

  it('different prompts miss the cache', async () => {
    const client = new LLMClient('openai-compatible', { baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct' });
    client.enableCache(new LLMCache());

    await client.quickChat('prompt one');
    await client.quickChat('prompt two');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('whitespace-only differences still hit the cache', async () => {
    const client = new LLMClient('openai-compatible', { baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct' });
    client.enableCache(new LLMCache());

    await client.quickChat('Should we collaborate?');
    await client.quickChat('  Should we\n collaborate?  ');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('constructor config.cache enables caching', async () => {
    const client = new LLMClient('openai-compatible', { baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct', cache: { maxSize: 10 } });
    expect(client.getCache()).not.toBeNull();

    await client.quickChat('hello');
    await client.quickChat('hello');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('no cache by default — identical calls hit the provider twice', async () => {
    const client = new LLMClient('openai-compatible', { baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct' });
    expect(client.getCache()).toBeNull();

    await client.quickChat('hello');
    await client.quickChat('hello');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
