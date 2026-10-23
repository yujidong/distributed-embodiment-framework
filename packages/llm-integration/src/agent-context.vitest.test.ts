/**
 * Per-agent logging attribution (runWithLLMAgentContext).
 *
 * The logging contextProvider is runtime-level (EngineRuntime sets only the
 * in-flight eventId); decision lanes that KNOW the agent wrap their LLM call
 * in runWithLLMAgentContext so a failed/timed-out call is attributed to that
 * agent instead of landing as llm-failure agentId 'unknown'. The marker
 * rides AsyncLocalStorage, so concurrent agents sharing one client never
 * cross-attribute.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, runWithLLMAgentContext } from './client';

// Providers import fetch from 'cross-fetch' directly — mock the module.
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('cross-fetch', () => ({ default: mockFetch }));

const MODEL = 'ac-decision-v5';

function okResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1704067200,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  };
}

function client(baseURL = 'http://localhost:8000/v1'): LLMClient {
  return new LLMClient('openai-compatible', { baseURL, model: MODEL });
}

describe('LLMClient per-agent logging attribution (runWithLLMAgentContext)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      return okResponse(`echo:${body.messages[body.messages.length - 1].content}`);
    });
  });

  it('the marker lands on the log context (and the provider eventId survives the merge)', async () => {
    const c = client();
    c.setContextProvider(() => ({ eventId: 'evt-1' }));
    const seen: Array<{ agentId?: string; eventId?: string }> = [];
    c.setLoggingCallback(params => seen.push({
      agentId: params.context?.agentId,
      eventId: params.context?.eventId,
    }));

    await runWithLLMAgentContext({ agentId: 'agent-a' }, () => c.quickChat('hi'));

    expect(seen).toEqual([{ agentId: 'agent-a', eventId: 'evt-1' }]);
  });

  it('a FAILED call inside the marker is attributed to the agent (the llm-failure case)', async () => {
    const c = client('http://localhost:9998/v1');
    const seen: Array<{ agentId?: string; success: boolean }> = [];
    c.setLoggingCallback(params => seen.push({
      agentId: params.context?.agentId,
      success: params.success,
    }));
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });

    await expect(
      runWithLLMAgentContext({ agentId: 'agent-b' }, () => c.quickChat('hi')),
    ).rejects.toThrow();

    expect(seen).toEqual([{ agentId: 'agent-b', success: false }]);
  });

  it('concurrent agents sharing ONE client never cross-attribute', async () => {
    const c = client('http://localhost:9997/v1');
    const byPrompt = new Map<string, string | undefined>();
    c.setLoggingCallback(params => byPrompt.set(params.userPrompt, params.context?.agentId));

    const slow = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
      const prompt = body.messages[body.messages.length - 1].content;
      await slow(prompt === 'from-a' ? 20 : 1); // interleave completions
      return okResponse(`echo:${prompt}`);
    });

    await Promise.all([
      runWithLLMAgentContext({ agentId: 'agent-a' }, () => c.quickChat('from-a')),
      runWithLLMAgentContext({ agentId: 'agent-b' }, () => c.quickChat('from-b')),
    ]);

    expect(byPrompt.get('from-a')).toBe('agent-a');
    expect(byPrompt.get('from-b')).toBe('agent-b');
  });

  it('an explicit contextProvider agentId wins over the ambient marker', async () => {
    const c = client('http://localhost:9996/v1');
    c.setContextProvider(() => ({ agentId: 'provider-agent' }));
    const seen: Array<string | undefined> = [];
    c.setLoggingCallback(params => seen.push(params.context?.agentId));

    await runWithLLMAgentContext({ agentId: 'marker-agent' }, () => c.quickChat('hi'));

    expect(seen).toEqual(['provider-agent']);
  });

  it('no marker, no provider → attribution stays absent (legacy behavior unchanged)', async () => {
    const c = client('http://localhost:9995/v1');
    const seen: Array<string | undefined> = [];
    c.setLoggingCallback(params => seen.push(params.context?.agentId));

    await c.quickChat('hi');

    expect(seen).toEqual([undefined]);
  });
});
