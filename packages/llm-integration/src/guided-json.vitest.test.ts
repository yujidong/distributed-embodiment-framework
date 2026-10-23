/**
 * Unit tests for the F0-2 guided JSON toggle (LLM_GUIDED_JSON) and the
 * explicit failure mode when a backend rejects response_format.
 *
 * Providers import fetch from 'cross-fetch' directly — mock the module
 * (same pattern as format-support.vitest.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { GUIDED_JSON_ENV, isGuidedJsonEnabled } from './guided-json';
import { LLMError } from './types';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    situation: { type: 'object' },
    actionPlan: { type: 'object' },
    uncertainty: { type: 'object' },
  },
  required: ['situation', 'actionPlan', 'uncertainty'],
};

function mockOkResponse() {
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

/** vLLM's documented error envelope for an unsupported request field. */
function mockVllm400() {
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({
      object: 'error',
      message: 'unknown field: response_format is not supported by this server',
      type: 'BadRequestError',
      param: null,
      code: 400,
    }),
  };
}

function lastRequestBody(): Record<string, any> {
  const init = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1];
  return JSON.parse(init.body as string);
}

function makeProvider(extra: Record<string, unknown> = {}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseURL: 'http://localhost:8000/v1',
    model: 'ac-decision-v5',
    ...extra,
  });
}

const messages = [{ role: 'user' as const, content: 'hi' }];

afterEach(() => {
  delete process.env[GUIDED_JSON_ENV];
});

describe('isGuidedJsonEnabled', () => {
  it('defaults to ON when the env is unset', () => {
    delete process.env[GUIDED_JSON_ENV];
    expect(isGuidedJsonEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'OFF', ' False '])('is OFF for LLM_GUIDED_JSON=%s', value => {
    expect(isGuidedJsonEnabled({ [GUIDED_JSON_ENV]: value } as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(['1', 'true', 'on'])('stays ON for LLM_GUIDED_JSON=%s', value => {
    expect(isGuidedJsonEnabled({ [GUIDED_JSON_ENV]: value } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('OpenAICompatibleProvider guided JSON request construction', () => {
  beforeEach(() => {
    delete process.env[GUIDED_JSON_ENV];
    mockFetch.mockResolvedValue(mockOkResponse());
  });

  it('default (env unset): a schema format is sent as response_format json_schema', async () => {
    await makeProvider().chat({ messages, format: DECISION_SCHEMA });
    expect(lastRequestBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: DECISION_SCHEMA },
    });
  });

  it('LLM_GUIDED_JSON=0: response_format is omitted entirely (schema AND "json")', async () => {
    process.env[GUIDED_JSON_ENV] = '0';
    const provider = makeProvider();
    await provider.chat({ messages, format: DECISION_SCHEMA });
    expect('response_format' in lastRequestBody()).toBe(false);
    await provider.chat({ messages, format: 'json' });
    expect('response_format' in lastRequestBody()).toBe(false);
  });

  it('config guidedJson:false wins over the env default', async () => {
    await makeProvider({ guidedJson: false }).chat({ messages, format: DECISION_SCHEMA });
    expect('response_format' in lastRequestBody()).toBe(false);
  });

  it('config guidedJson:true wins over LLM_GUIDED_JSON=0', async () => {
    process.env[GUIDED_JSON_ENV] = '0';
    await makeProvider({ guidedJson: true }).chat({ messages, format: DECISION_SCHEMA });
    expect(lastRequestBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: DECISION_SCHEMA },
    });
  });

  it('a format-less request never carries response_format regardless of the toggle', async () => {
    await makeProvider().chat({ messages });
    expect('response_format' in lastRequestBody()).toBe(false);
  });
});

describe('guided JSON failure is explicit (never silent)', () => {
  beforeEach(() => {
    delete process.env[GUIDED_JSON_ENV];
  });

  it('a 400 on a guided-JSON request names response_format and the LLM_GUIDED_JSON escape hatch', async () => {
    mockFetch.mockResolvedValue(mockVllm400());
    const error = await makeProvider().chat({ messages, format: DECISION_SCHEMA }).catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('400');
    expect(error.message).toContain('response_format');
    expect(error.message).toContain(GUIDED_JSON_ENV);
    // The backend's own explanation rides the cause.
    expect(String(error.cause?.message)).toContain('not supported');
  });

  it('a 400 WITHOUT response_format (guided off) carries no guided hint', async () => {
    mockFetch.mockResolvedValue(mockVllm400());
    const error = await makeProvider({ guidedJson: false })
      .chat({ messages, format: DECISION_SCHEMA })
      .catch(e => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.message).toContain('400');
    expect(error.message).not.toContain(GUIDED_JSON_ENV);
  });
});
