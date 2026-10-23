/**
 * Unit Tests for structured output (ChatParams.format) support
 *
 * Verifies that each provider maps `format` into its wire format:
 * - SiliconFlowProvider / OpenAICompatibleProvider: OpenAI-style `response_format`
 * - LLMClient.quickChat: passes `format` through to the provider
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiliconFlowProvider } from './providers/siliconflow';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { LLMClient } from './client';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['collaborate', 'independent'] },
    reasoning: { type: 'string' },
  },
  required: ['decision', 'reasoning'],
};

function mockSiliconFlowResponse() {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'Qwen/Qwen3-8B',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

function lastRequestBody(): Record<string, any> {
  const init = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1];
  return JSON.parse(init.body as string);
}

describe('SiliconFlowProvider format support', () => {
  let provider: SiliconFlowProvider;

  beforeEach(() => {
    provider = new SiliconFlowProvider({ apiKey: 'test-key' });
    mockFetch.mockResolvedValue(mockSiliconFlowResponse());
  });

  it('maps format: "json" to response_format json_object', async () => {
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: 'json' });
    expect(lastRequestBody().response_format).toEqual({ type: 'json_object' });
  });

  it('maps a JSON schema object to response_format json_schema', async () => {
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: DECISION_SCHEMA });
    expect(lastRequestBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: DECISION_SCHEMA },
    });
  });

  it('omits response_format when format is not provided', async () => {
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect('response_format' in lastRequestBody()).toBe(false);
  });
});

describe('OpenAICompatibleProvider format support', () => {
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
    });
    mockFetch.mockResolvedValue(mockSiliconFlowResponse());
  });

  it('maps format: "json" to response_format json_object', async () => {
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: 'json' });
    expect(lastRequestBody().response_format).toEqual({ type: 'json_object' });
  });

  it('maps a JSON schema object to response_format json_schema', async () => {
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], format: DECISION_SCHEMA });
    expect(lastRequestBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: DECISION_SCHEMA },
    });
  });

  it('omits response_format when format is not provided', async () => {
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect('response_format' in lastRequestBody()).toBe(false);
  });
});

describe('LLMClient.quickChat format pass-through', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(mockSiliconFlowResponse());
  });

  it('forwards the format argument to the provider request', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
    });
    await client.quickChat('hi', 'system prompt', undefined, DECISION_SCHEMA);
    expect(lastRequestBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: DECISION_SCHEMA },
    });
  });

  it('sends no format when the argument is omitted', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: 'test-model',
    });
    await client.quickChat('hi', 'system prompt');
    expect('response_format' in lastRequestBody()).toBe(false);
  });
});
