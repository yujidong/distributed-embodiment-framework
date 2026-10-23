/**
 * Circuit breaker tests (R40-A5).
 *
 * The behavior contract, in event order (the R39 live-probe failure mode:
 * a dead LLM backend made every agent event wait out the provider timeout
 * before degrading):
 * 1. threshold consecutive failures OPEN the breaker;
 * 2. while OPEN, guard() rejects fast (LlmCircuitOpenError, ≈0ms) — never
 *    calling the backend;
 * 3. after the cooldown, exactly ONE half-open probe passes; success
 *    closes, failure re-opens for a full cooldown;
 * 4. AbortError (caller canceled) never counts as a backend failure;
 * 5. one backend key = one shared breaker (decision + triage clients).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { LlmCircuitBreaker, LlmCircuitOpenError, isCircuitOpenError } from './circuit-breaker.js';
import { isTransientLLMError, LLMError } from './types.js';

const KEY = 'test:backend';

beforeEach(() => {
  LlmCircuitBreaker.resetRegistry();
});

function failingBackend(): () => Promise<never> {
  return () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:11434'));
}

function okBackend(): () => Promise<string> {
  return async () => 'ok';
}

describe('LlmCircuitBreaker', () => {
  it('opens after the failure threshold and fails FAST afterwards', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 2, cooldownMs: 60_000 });
    await expect(breaker.guard(failingBackend())).rejects.toThrow('ECONNREFUSED');
    await expect(breaker.guard(failingBackend())).rejects.toThrow('ECONNREFUSED');

    const start = Date.now();
    await expect(breaker.guard(failingBackend())).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(Date.now() - start).toBeLessThan(50); // fast-fail, no backend wait
  });

  it('the circuit-open error classifies NON-transient (no retry backoff on it)', () => {
    let openError: unknown;
    LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60_000 })
      .guard(failingBackend())
      .catch(() => undefined);
    // synthesize via a second guard on the now-open breaker
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60_000 });
    breaker
      .guard(() => Promise.reject(new Error('first failure')))
      .catch(() => undefined);
    return breaker
      .guard(okBackend())
      .catch((error: unknown) => {
        openError = error;
        expect(isCircuitOpenError(openError)).toBe(true);
        expect(isTransientLLMError(openError)).toBe(false);
      });
  });

  it('half-open probe success closes the breaker', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60 });
    await expect(breaker.guard(failingBackend())).rejects.toThrow('ECONNREFUSED');
    await expect(breaker.guard(okBackend())).rejects.toBeInstanceOf(LlmCircuitOpenError);
    await new Promise(resolve => setTimeout(resolve, 70)); // cooldown elapses
    expect(await breaker.guard(okBackend())).toBe('ok'); // probe passes → closed
    expect(await breaker.guard(okBackend())).toBe('ok'); // normal again
  });

  it('half-open probe failure re-opens for a full cooldown', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60 });
    await expect(breaker.guard(failingBackend())).rejects.toThrow('ECONNREFUSED');
    await new Promise(resolve => setTimeout(resolve, 70));
    await expect(breaker.guard(failingBackend())).rejects.toThrow('ECONNREFUSED'); // probe fails
    await expect(breaker.guard(okBackend())).rejects.toBeInstanceOf(LlmCircuitOpenError); // re-opened
  });

  it('AbortError (caller canceled) never counts as a backend failure', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60_000 });
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    await expect(breaker.guard(() => Promise.reject(abortError))).rejects.toThrow('aborted');
    // Not counted → breaker still closed, next call goes through.
    expect(await breaker.guard(okBackend())).toBe('ok');
  });

  // R5-F10: the WRAPPED caller-abort forms must not count either — the
  // provider rethrows a caller abort as LLMError("…aborted by the caller…",
  // cause: AbortError) and the queue rejects a still-queued task with
  // "…aborted before dispatch…". Without the exemption, two consecutive
  // evaluation-budget timeouts (a slow large model) would open the breaker
  // for every caller on the backend.
  it('provider-wrapped caller abort (LLMError, cause AbortError) never counts', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60_000 });
    const cause = new Error('The operation was aborted');
    cause.name = 'AbortError';
    const wrapped = new LLMError(
      'Request to http://x/v1/chat/completions aborted by the caller after 30000ms',
      'openai-compatible',
      cause,
    );
    await expect(breaker.guard(() => Promise.reject(wrapped))).rejects.toThrow('aborted by the caller');
    expect(await breaker.guard(okBackend())).toBe('ok');
  });

  it('queue dispatch abort (caller AbortSignal while queued) never counts', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60_000 });
    const dispatchAbort = new Error('LLM request aborted before dispatch (caller AbortSignal)');
    await expect(breaker.guard(() => Promise.reject(dispatchAbort))).rejects.toThrow('aborted before dispatch');
    await expect(breaker.guard(() => Promise.reject(dispatchAbort))).rejects.toThrow('aborted before dispatch');
    expect(await breaker.guard(okBackend())).toBe('ok');
  });

  // fault-injection 'slow LLM' row: a caller-side TIMEOUT (AbortSignal.timeout
  // reason = TimeoutError) is slow-backend evidence and MUST count — only
  // deliberate caller aborts (reason AbortError) stay exempt.
  it('caller-budget timeout (wrapped, cause TimeoutError) counts toward the breaker', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 2, cooldownMs: 60_000 });
    const cause = new Error('The operation timed out');
    cause.name = 'TimeoutError';
    const wrapped = new LLMError(
      'Request to http://x/v1/chat/completions aborted by the caller after 2000ms',
      'openai-compatible',
      cause,
    );
    await expect(breaker.guard(() => Promise.reject(wrapped))).rejects.toThrow();
    await expect(breaker.guard(() => Promise.reject(wrapped))).rejects.toThrow();
    // Two counted timeouts open the breaker — the next call fast-fails.
    await expect(breaker.guard(okBackend())).rejects.toThrow('circuit-open');
  });

  it('one backend key shares one breaker across clients', () => {
    const a = LlmCircuitBreaker.for('vllm:http://x', { threshold: 2 });
    const b = LlmCircuitBreaker.for('vllm:http://x');
    expect(a).toBe(b);
    expect(LlmCircuitBreaker.for('vllm:http://y')).not.toBe(a);
  });

  // P1 config-drift fix: a 404 (stale model name) is a CLIENT/config error —
  // the backend answered, so it must never open the breaker and degrade
  // every LLM decision. Only transient failures (network/5xx/timeout) count.
  const notFound = () =>
    Promise.reject(new LLMError('API request failed: 404 Not Found', 'openai-compatible'));

  it('consecutive 404s (client errors) never open the breaker', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 2, cooldownMs: 60_000 });
    await expect(breaker.guard(notFound)).rejects.toThrow('404');
    await expect(breaker.guard(notFound)).rejects.toThrow('404');
    await expect(breaker.guard(notFound)).rejects.toThrow('404');
    // Still closed — the next call reaches the backend instead of fast-failing.
    expect(await breaker.guard(okBackend())).toBe('ok');
  });

  it('other permanent 4xx (400 bad request) do not count either', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60_000 });
    await expect(
      breaker.guard(() => Promise.reject(new LLMError('API request failed: 400 Bad Request', 'openai-compatible'))),
    ).rejects.toThrow('400');
    expect(await breaker.guard(okBackend())).toBe('ok');
  });

  it('consecutive 5xx still open the breaker', async () => {
    const badGateway = () =>
      Promise.reject(new LLMError('API request failed: 502 Bad Gateway', 'openai-compatible'));
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 2, cooldownMs: 60_000 });
    await expect(breaker.guard(badGateway)).rejects.toThrow('502');
    await expect(breaker.guard(badGateway)).rejects.toThrow('502');
    await expect(breaker.guard(okBackend())).rejects.toBeInstanceOf(LlmCircuitOpenError);
  });

  it('consecutive timeouts still open the breaker', async () => {
    const timeout = () =>
      Promise.reject(new LLMError('Request to http://x/v1/chat/completions timed out after 30000ms', 'openai-compatible'));
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 2, cooldownMs: 60_000 });
    await expect(breaker.guard(timeout)).rejects.toThrow('timed out');
    await expect(breaker.guard(timeout)).rejects.toThrow('timed out');
    await expect(breaker.guard(okBackend())).rejects.toBeInstanceOf(LlmCircuitOpenError);
  });

  it('a 404 half-open probe closes the breaker (the backend answered)', async () => {
    const breaker = LlmCircuitBreaker.for(KEY, { threshold: 1, cooldownMs: 60 });
    await expect(breaker.guard(failingBackend())).rejects.toThrow('ECONNREFUSED');
    await new Promise(resolve => setTimeout(resolve, 70));
    await expect(breaker.guard(notFound)).rejects.toThrow('404'); // probe: backend alive
    expect(await breaker.guard(okBackend())).toBe('ok'); // closed, normal traffic
  });
});
