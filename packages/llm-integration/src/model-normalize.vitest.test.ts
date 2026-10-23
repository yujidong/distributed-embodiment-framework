/**
 * Single-backend model normalization tests (P1 config-drift fix).
 *
 * The platform deploys ONE vLLM backend serving ONE model (LLM_MODEL). A
 * client constructed with `deployedModel` rewrites any mismatching request
 * model — whether it came from the client config (per-agent llm.model) or an
 * explicit ChatParams.model — to the deployed one, with a warn; strict mode
 * (config modelStrict or LLM_MODEL_STRICT=1) errors instead. Clients WITHOUT
 * deployedModel (e.g. the floorplan vision client, which deliberately calls
 * a different model) are never rewritten.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMClient } from './client';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const DEPLOYED = 'ac-decision-v5';
const DRIFTED = 'qwen3-14b-q4:latest';

function okResponse() {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1704067200,
      model: DEPLOYED,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

/** The model name that actually went out on the wire in call `n`. */
function wireModel(n = 0): string {
  const body = JSON.parse(mockFetch.mock.calls[n][1].body as string) as { model: string };
  return body.model;
}

describe('LLMClient model normalization (deployedModel)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
  });

  afterEach(() => {
    delete process.env.LLM_MODEL_STRICT;
  });

  it('no deployedModel configured → the declared model passes through (legacy)', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DRIFTED,
    });
    await client.quickChat('hi');
    expect(wireModel()).toBe(DRIFTED);
  });

  it('mismatching client config model is rewritten to the deployed model', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DRIFTED,
      deployedModel: DEPLOYED,
    });
    const response = await client.quickChat('hi');
    expect(wireModel()).toBe(DEPLOYED);
    expect(response.content).toBe('ok');
  });

  it('an explicit ChatParams.model mismatch is rewritten too', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DEPLOYED,
      deployedModel: DEPLOYED,
    });
    await client.chat({ messages: [{ role: 'user', content: 'hi' }], model: DRIFTED });
    expect(wireModel()).toBe(DEPLOYED);
  });

  it('a matching model is sent unchanged', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DEPLOYED,
      deployedModel: DEPLOYED,
    });
    await client.quickChat('hi');
    expect(wireModel()).toBe(DEPLOYED);
  });

  it('the warn names the agent, the requested model and the deployed model', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DRIFTED,
      deployedModel: DEPLOYED,
    });
    client.setContextProvider(() => ({ agentId: 'agent-007' }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await client.quickChat('hi');
    } finally {
      const warned = warnSpy.mock.calls.flat().join(' ');
      warnSpy.mockRestore();
      expect(warned).toContain('agent-007');
      expect(warned).toContain(DRIFTED);
      expect(warned).toContain(DEPLOYED);
    }
  });

  it('strict mode (config modelStrict) rejects the mismatch and never calls the backend', async () => {
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DRIFTED,
      deployedModel: DEPLOYED,
      modelStrict: true,
    });
    await expect(client.quickChat('hi')).rejects.toThrow(/not found in this deployment/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('strict mode via LLM_MODEL_STRICT=1 env', async () => {
    process.env.LLM_MODEL_STRICT = '1';
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DRIFTED,
      deployedModel: DEPLOYED,
    });
    await expect(client.quickChat('hi')).rejects.toThrow(/LLM_MODEL_STRICT/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('strict-mode error classifies PERMANENT (no retry, no breaker count)', async () => {
    const { isTransientLLMError } = await import('./types.js');
    const client = new LLMClient('openai-compatible', {
      baseURL: 'http://localhost:8000/v1',
      model: DRIFTED,
      deployedModel: DEPLOYED,
      modelStrict: true,
    });
    const error = await client.quickChat('hi').catch((e: unknown) => e);
    expect(isTransientLLMError(error)).toBe(false);
  });
});
