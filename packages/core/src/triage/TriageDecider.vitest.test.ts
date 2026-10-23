/**
 * Unit tests for TriageDecider + parseTriageDecision (P4-2)
 *
 * No LLM backend: the triage client is a scripted fake implementing the LLMClient
 * surface the decider uses (quickChat).
 */

import { describe, it, expect, vi } from 'vitest';
import type { LLMClient } from '@active-collaboration/llm-integration';
import { TriageDecider, parseTriageDecision } from './TriageDecider.js';

describe('parseTriageDecision', () => {
  it('parses the structured JSON form', () => {
    const parsed = parseTriageDecision('{"decision":"independent","reasoning":"agent covers it"}');
    expect(parsed).toEqual({ decision: 'independent', reasoning: 'agent covers it' });
  });

  it('parses JSON inside markdown fences / surrounding prose', () => {
    const parsed = parseTriageDecision('Sure! ```json\n{"decision":"collaborate","reasoning":"needs partner"}\n```');
    expect(parsed?.decision).toBe('collaborate');
    expect(parsed?.reasoning).toBe('needs partner');
  });

  it('is case-insensitive on the decision value', () => {
    expect(parseTriageDecision('{"decision":"COLLABORATE"}')?.decision).toBe('collaborate');
  });

  it('rejects invalid enum values and falls back to keywords', () => {
    expect(parseTriageDecision('{"decision":"maybe"}')).toBeNull();
    expect(parseTriageDecision('{"decision":"maybe"}\nCOLLABORATE')?.decision).toBe('collaborate');
  });

  it('keyword fallback: earliest occurrence wins', () => {
    expect(parseTriageDecision('INDEPENDENT — no collaboration needed')?.decision).toBe('independent');
    expect(parseTriageDecision('I will collaborate, not stay independent')?.decision).toBe('collaborate');
  });

  it('returns null when nothing is extractable', () => {
    expect(parseTriageDecision('')).toBeNull();
    expect(parseTriageDecision('the weather is nice')).toBeNull();
    // @ts-expect-error — defensive against non-string input
    expect(parseTriageDecision(undefined)).toBeNull();
  });
});

describe('TriageDecider', () => {
  const fakeClient = (impl: () => Promise<unknown>) =>
    ({ quickChat: vi.fn(impl) }) as unknown as LLMClient;

  it('returns a decision with latency and raw response', async () => {
    const client = fakeClient(async () => ({ content: '{"decision":"collaborate","reasoning":"x"}', model: 'm' }));
    const decider = new TriageDecider(client);
    const outcome = await decider.decide('sys', 'user', { type: 'object' });

    expect(outcome?.decision).toBe('collaborate');
    expect(outcome?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcome?.rawResponse).toContain('collaborate');

    // Prompt + schema are passed through verbatim to the cheap model
    const call = (client.quickChat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('user');
    expect(call[1]).toBe('sys');
    expect(call[3]).toEqual({ type: 'object' });
  });

  it('accepts plain-string responses (legacy client shape)', async () => {
    const decider = new TriageDecider(fakeClient(async () => '{"decision":"independent","reasoning":"y"}'));
    expect((await decider.decide('s', 'u'))?.decision).toBe('independent');
  });

  it('returns null when the call fails — never throws', async () => {
    const decider = new TriageDecider(fakeClient(async () => { throw new Error('connection refused'); }));
    await expect(decider.decide('s', 'u')).resolves.toBeNull();
  });

  it('returns null on unparseable responses', async () => {
    const decider = new TriageDecider(fakeClient(async () => ({ content: 'huh?', model: 'm' })));
    expect(await decider.decide('s', 'u')).toBeNull();
  });
});
