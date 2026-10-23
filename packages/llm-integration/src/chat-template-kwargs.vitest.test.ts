/**
 * chat_template_kwargs pass-through tests (Qwen3 enable_thinking).
 *
 * The OpenAI-compatible provider sends ChatParams.chatTemplateKwargs verbatim
 * as the `chat_template_kwargs` request field — the vLLM extension its chat
 * template reads. A backend that simply ignores the unknown field (vLLM's
 * behavior for non-Qwen models) must keep working unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient } from './client';

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
      model: 'qwen3-27b',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

function wireBody(n = 0): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[n][1].body as string) as Record<string, unknown>;
}

function client(): LLMClient {
  return new LLMClient('openai-compatible', {
    baseURL: 'http://localhost:8000/v1',
    model: 'qwen3-27b',
  });
}

describe('chat_template_kwargs pass-through', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });

  it('chatTemplateKwargs reaches the wire as chat_template_kwargs', async () => {
    await client().chat({
      messages: [{ role: 'user', content: 'hi' }],
      chatTemplateKwargs: { enable_thinking: false },
    });
    expect(wireBody().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('the field is omitted entirely when chatTemplateKwargs is unset', async () => {
    await client().chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect('chat_template_kwargs' in wireBody()).toBe(false);
  });

  it('quickChat forwards options.chatTemplateKwargs', async () => {
    await client().quickChat('hi', undefined, undefined, undefined, {
      maxTokens: 64,
      temperature: 0,
      chatTemplateKwargs: { enable_thinking: false },
    });
    const body = wireBody();
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0);
  });

  it('quickChat omits the field when options.chatTemplateKwargs is undefined', async () => {
    await client().quickChat('hi', undefined, undefined, undefined, {
      maxTokens: 64,
      chatTemplateKwargs: undefined,
    });
    expect('chat_template_kwargs' in wireBody()).toBe(false);
  });

  it('a backend that ignores the unknown field (non-Qwen on vLLM) still answers', async () => {
    // The mock server does not even look at chat_template_kwargs — the
    // response parses exactly as without the field (no crash, content intact).
    const response = await client().chat({
      messages: [{ role: 'user', content: 'hi' }],
      format: 'json',
      chatTemplateKwargs: { enable_thinking: false },
    });
    expect(response.content).toBe('{"ok":true}');
    expect(response.model).toBe('qwen3-27b');
  });
});
