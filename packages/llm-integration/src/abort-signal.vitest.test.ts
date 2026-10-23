/**
 * T-023 (DevLoop R17) — LLM call lifecycle bounds.
 *
 * Two surfaces:
 * 1. `combineAbortSignals` (providers/base): a caller-owned signal (e.g. a
 *    review budget) and the provider timeout combine — whichever fires first
 *    aborts the ONE fetch signal. Previously the reviewer's Promise.race
 *    timeout orphaned the in-flight request: it kept holding a global
 *    LLM_MAX_CONCURRENT slot for up to the provider timeout (120s).
 * 2. `ChatParams.signal` end to end: providers pass the combined signal to
 *    fetch and classify caller-aborts honestly; LLMClient rejects an
 *    already-aborted request before it enters the request queue.
 *
 * cross-fetch is module-mocked (the established pattern in
 * openai-compatible.vitest.test.ts) so the mock fetch can honor init.signal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { combineAbortSignals } from './providers/base';
import { LLMClient } from './client';
import { LLMError } from './types';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

function okChatResponse() {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

/** A fetch that never settles until its init.signal aborts (the orphaned-request shape). */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  );
}

describe('combineAbortSignals (T-023)', () => {
  it('drops undefined entries and passes a single signal through', () => {
    const only = AbortSignal.timeout(1000);
    expect(combineAbortSignals(only)).toBe(only);
    expect(combineAbortSignals(undefined, only, undefined)).toBe(only);
  });

  it('returns undefined for zero live signals', () => {
    expect(combineAbortSignals()).toBeUndefined();
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  it('aborts when EITHER source fires', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals(first.signal, second.signal)!;
    expect(combined.aborted).toBe(false);

    first.abort();
    expect(combined.aborted).toBe(true);

    const late = new AbortController();
    const combined2 = combineAbortSignals(AbortSignal.timeout(1_000_000), late.signal)!;
    late.abort();
    expect(combined2.aborted).toBe(true);
  });

  it('an already-aborted source aborts the combination immediately', () => {
    const dead = new AbortController();
    dead.abort();
    const alive = new AbortController();
    const combined = combineAbortSignals(dead.signal, alive.signal)!;
    expect(combined.aborted).toBe(true);
  });

  it('cleans up listeners after the first abort (no leak across combines)', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal)!;
    a.abort();
    // Firing b afterwards must not throw (its listener was removed).
    expect(() => b.abort()).not.toThrow();
    expect(combined.aborted).toBe(true);
  });
});

describe('OpenAICompatibleProvider caller abort (T-023)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects with an honest caller-abort error and forwards the combined signal', async () => {
    mockFetch.mockImplementation(hangingFetch());
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
      timeout: 60_000,
    });

    const caller = new AbortController();
    const pending = provider.chat({
      messages: [{ role: 'user', content: 'review this' }],
      signal: caller.signal,
    });
    const asserted = pending.then(
      () => { throw new Error('expected rejection'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(LLMError);
        expect((error as Error).message).toContain('aborted by the caller');
      },
    );
    // The fetch saw ONE signal that carries BOTH the provider timeout and
    // the caller's — aborting the caller must abort the fetch's signal.
    const fetchSignal = mockFetch.mock.calls[0]![1]!.signal as AbortSignal;
    expect(fetchSignal.aborted).toBe(false);
    caller.abort();
    expect(fetchSignal.aborted).toBe(true);
    await asserted;
  });

  it('a plain timeout (no caller signal) still names the timeout', async () => {
    mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        }, { once: true });
      }),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
      timeout: 5,
    });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow(/timed out after 5ms/);
  });
});

describe('LLMClient abort lifecycle (T-023)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okChatResponse());
  });

  it('rejects an already-aborted request before any provider call', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
    });
    const caller = new AbortController();
    caller.abort();

    await expect(client.chat({
      messages: [{ role: 'user', content: 'nope' }],
      signal: caller.signal,
    })).rejects.toThrow(/aborted before dispatch/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('forwards the caller signal through the queue into the provider fetch', async () => {
    mockFetch.mockImplementation(hangingFetch());
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
      timeout: 60_000,
    });
    const caller = new AbortController();
    const pending = client.chat({
      messages: [{ role: 'user', content: 'slow' }],
      signal: caller.signal,
    });
    const assertion = pending.catch(() => undefined); // rejection is enough
    caller.abort();
    await assertion;
    const fetchSignal = mockFetch.mock.calls[0]![1]!.signal as AbortSignal;
    expect(fetchSignal.aborted).toBe(true);
  });
});
