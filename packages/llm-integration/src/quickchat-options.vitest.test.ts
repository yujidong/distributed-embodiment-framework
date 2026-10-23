/**
 * R32-A3: quickChat request overrides — maxTokens must reach the provider
 * params (OpenAI-compatible max_tokens), while omitted options keep the provider
 * default (4096) untouched for legacy callers.
 */
import { describe, it, expect, vi } from 'vitest';
import { LLMClient } from './client.js';

describe('R32-A3: quickChat maxTokens plumbing', () => {
  it('passes maxTokens through to chat params when provided', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'stub',
    });
    const chatSpy = vi.fn(async () => ({ content: 'ok' }));
    client.chat = chatSpy as unknown as typeof client.chat;

    await client.quickChat('question', 'system', undefined, { type: 'object' }, { maxTokens: 256 });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    const params = chatSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.maxTokens).toBe(256);
    expect(params.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'question' },
    ]);
    expect(params.format).toEqual({ type: 'object' });
  });

  it('omits maxTokens entirely when no options given (provider default preserved)', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'stub',
    });
    const chatSpy = vi.fn(async () => ({ content: 'ok' }));
    client.chat = chatSpy as unknown as typeof client.chat;

    await client.quickChat('question');

    const params = chatSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect('maxTokens' in params).toBe(false);
  });
});
