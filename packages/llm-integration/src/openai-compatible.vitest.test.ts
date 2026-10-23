/**
 * Unit Tests for the generic OpenAI-compatible provider
 *
 * Verifies:
 * - Request body shape, including ChatParams.format → response_format mapping
 * - Authorization: Bearer header is sent only when an apiKey is configured
 *   (no OPENAI_API_KEY environment fallback — T-102)
 * - Malformed 200 responses (no usage / empty choices / no content) fail
 *   with an LLMError naming the real problem, not a TypeError (T-102)
 * - AbortSignal.timeout aborts surface as "timed out after Nms" (T-102)
 * - healthCheck uses GET {baseURL}/models and tolerates failures
 * - Factory creates OpenAICompatibleProvider for 'openai-compatible'
 * - 'siliconflow' factory behavior is unchanged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { SiliconFlowProvider } from './providers/siliconflow';
import { createProvider, getAvailableProviders } from './providers/factory';
import { LLMError } from './types';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const VLLM_CONFIG = { baseURL: 'http://localhost:8000/v1', model: 'Qwen/Qwen2.5-7B-Instruct' };

const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['collaborate', 'independent'] },
    reasoning: { type: 'string' },
  },
  required: ['decision', 'reasoning'],
};

function mockChatResponse(model = 'Qwen/Qwen2.5-7B-Instruct') {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

function lastRequestUrl(): string {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
}

function lastRequestInit(): { headers: Record<string, string>; body: string } {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1];
}

function lastRequestBody(): Record<string, any> {
  return JSON.parse(lastRequestInit().body);
}

describe('OpenAICompatibleProvider', () => {
  const ENV_KEY = 'OPENAI_API_KEY';
  let savedEnv: string | undefined;

  beforeEach(() => {
    mockFetch.mockResolvedValue(mockChatResponse());
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('requires baseURL and model', () => {
    expect(() => new OpenAICompatibleProvider({ model: 'm' } as any)).toThrow(LLMError);
    expect(() => new OpenAICompatibleProvider({ baseURL: 'http://x/v1' } as any)).toThrow(LLMError);
  });

  it('posts to {baseURL}/chat/completions with the standard body shape', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(lastRequestUrl()).toBe('http://localhost:8000/v1/chat/completions');
    const body = lastRequestBody();
    expect(body.model).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(2000);
  });

  it('passes temperature 0 and maxTokens 0 through unchanged (T-104)', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      maxTokens: 0,
    });
    const body = lastRequestBody();
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(0);

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(lastRequestBody().temperature).toBe(0.7);
    expect(lastRequestBody().max_tokens).toBe(2000);
  });

  it('maps format: "json" to response_format json_object', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: 'json' });
    expect(lastRequestBody().response_format).toEqual({ type: 'json_object' });
  });

  it('maps a JSON schema object to response_format json_schema', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: DECISION_SCHEMA });
    expect(lastRequestBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: DECISION_SCHEMA },
    });
  });

  it('omits response_format when format is not provided', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect('response_format' in lastRequestBody()).toBe(false);
  });

  it('passes tools through in the request body', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'get_temperature',
        description: 'Read zone temperature',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    }];
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools });
    expect(lastRequestBody().tools).toEqual(tools);
  });

  it('sends NO Authorization header when apiKey is absent', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const headers = lastRequestInit().headers;
    expect('Authorization' in headers).toBe(false);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends Authorization: Bearer when apiKey is set', async () => {
    const provider = new OpenAICompatibleProvider({ ...VLLM_CONFIG, apiKey: 'sk-test' });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(lastRequestInit().headers['Authorization']).toBe('Bearer sk-test');
  });

  it('maps the response content and token usage', async () => {
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(response.model).toBe('Qwen/Qwen2.5-7B-Instruct');
    expect(response.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
  });

  it('healthCheck GETs {baseURL}/models without auth when apiKey is absent', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    await expect(provider.healthCheck()).resolves.toBe(true);
    expect(lastRequestUrl()).toBe('http://localhost:8000/v1/models');
    expect('Authorization' in lastRequestInit().headers).toBe(false);
  });

  it('healthCheck returns false instead of throwing when the server is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    await expect(provider.healthCheck()).resolves.toBe(false);
  });

  it('healthCheck returns false on a non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502 });
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    await expect(provider.healthCheck()).resolves.toBe(false);
  });

  it('resolves with usage undefined when the backend omits the usage block', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
    });
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(response.usage).toBeUndefined();
  });

  it('rejects with an LLMError (not a TypeError) when choices is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    const error = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('no choices');
  });

  it('rejects with an LLMError when the message content is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        choices: [
          { index: 0, message: { role: 'assistant' }, finish_reason: 'stop' },
        ],
      }),
    });
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    const error = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('no message content');
  });

  it('rewords AbortSignal.timeout aborts as a timed-out request', async () => {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'TimeoutError';
    mockFetch.mockRejectedValue(abortError);
    const provider = new OpenAICompatibleProvider({ ...VLLM_CONFIG, timeout: 1234 });

    const error = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('timed out after 1234ms');
    expect(error.message).not.toContain('aborted');
  });

  it('sends NO Authorization header even when OPENAI_API_KEY is set in the environment', async () => {
    process.env[ENV_KEY] = 'sk-from-env';
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect('Authorization' in lastRequestInit().headers).toBe(false);
  });

  it('strips qwen-style <think> blocks from the returned content (T-103)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'Qwen/Qwen2.5-7B-Instruct',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<think>draft {"outcome":"reject"}</think>\n{"outcome":"allow"}',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const provider = new OpenAICompatibleProvider(VLLM_CONFIG);

    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('{"outcome":"allow"}');
  });
});

describe('createProvider openai-compatible / siliconflow', () => {
  const SF_ENV_KEY = 'SILICONFLOW_API_KEY';
  let savedSfEnv: string | undefined;

  beforeEach(() => {
    mockFetch.mockResolvedValue(mockChatResponse('Qwen/Qwen3-8B'));
    savedSfEnv = process.env[SF_ENV_KEY];
    delete process.env[SF_ENV_KEY];
  });

  afterEach(() => {
    if (savedSfEnv === undefined) {
      delete process.env[SF_ENV_KEY];
    } else {
      process.env[SF_ENV_KEY] = savedSfEnv;
    }
  });

  it('creates an OpenAICompatibleProvider for type openai-compatible', () => {
    const provider = createProvider('openai-compatible', VLLM_CONFIG);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe('openai-compatible');
    expect(provider.defaultModel).toBe('Qwen/Qwen2.5-7B-Instruct');
  });

  it('lists openai-compatible among the available providers', () => {
    expect(getAvailableProviders()).toContain('openai-compatible');
  });

  it('still creates a SiliconFlowProvider for type siliconflow', () => {
    const provider = createProvider('siliconflow', { apiKey: 'sk-test', model: 'Qwen/Qwen3-8B' });
    expect(provider).toBeInstanceOf(SiliconFlowProvider);
    expect(provider.name).toBe('siliconflow');
  });

  it('siliconflow still requires an apiKey', () => {
    expect(() => createProvider('siliconflow', {} as any)).toThrow(LLMError);
  });

  it('siliconflow still maps format to response_format and sends Bearer auth', async () => {
    const provider = createProvider('siliconflow', { apiKey: 'sk-test', model: 'Qwen/Qwen3-8B' });
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: 'json' });

    expect(lastRequestUrl()).toBe('https://api.siliconflow.cn/v1/chat/completions');
    expect(lastRequestInit().headers['Authorization']).toBe('Bearer sk-test');
    expect(lastRequestBody().response_format).toEqual({ type: 'json_object' });
  });
});
