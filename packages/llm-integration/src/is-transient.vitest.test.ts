/**
 * @vitest-environment node
 *
 * T-022 (DevLoop R17): provider-error classification for bounded-retry
 * policies. The R10 dead-LLM failure mode (ED-F01: every LLM-needing event
 * silently produced no decision) must classify as TRANSIENT so the decision
 * path retries and then degrades honestly; permanent errors must not waste
 * retries.
 */

import { describe, expect, it } from 'vitest';

import { isTransientLLMError, LLMError } from './types';

describe('isTransientLLMError (T-022)', () => {
  it.each([
    ['dead port ECONNREFUSED (the R10 ED-F01 signature)',
      new LLMError('Failed to complete chat request: connect ECONNREFUSED 127.0.0.1:1', 'openai-compatible',
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))],
    ['connection reset', new LLMError('Failed to complete chat request: read ECONNRESET', 'openai-compatible')],
    ['DNS failure', new LLMError('fetch failed: getaddrinfo ENOTFOUND llm.internal', 'openai-compatible')],
    ['provider timeout via AbortSignal', new LLMError('Failed to complete chat request: The user aborted a request.', 'openai-compatible')],
    ['timeout wording', new LLMError('request timed out after 30000ms', 'openai-compatible')],
    ['gateway 502', new LLMError('API request failed: 502 Bad Gateway', 'openai-compatible')],
    ['overload 429', new LLMError('API request failed: 429 Too Many Requests', 'openai-compatible')],
    ['service unavailable 503', new LLMError('API request failed: 503 Service Unavailable', 'openai-compatible')],
    ['plain network error', new Error('fetch failed')],
  ])('classifies %s as transient', (_name, error) => {
    expect(isTransientLLMError(error)).toBe(true);
  });

  it.each([
    ['unauthorized 401', new LLMError('API request failed: 401 Unauthorized', 'openai-compatible')],
    ['unknown model 404', new LLMError('API request failed: 404 Not Found', 'openai-compatible')],
    ['bad request 400', new LLMError('API request failed: 400 Bad Request', 'openai-compatible')],
    ['model not found wording', new LLMError('model "x" not found, try pulling it first', 'openai-compatible')],
    ['invalid api key', new LLMError('invalid API key provided', 'openai-compatible')],
  ])('classifies %s as permanent (no retry)', (_name, error) => {
    expect(isTransientLLMError(error)).toBe(false);
  });

  it('inspects the cause chain (providers wrap the fetch error)', () => {
    const wrapped = new LLMError('Failed to complete chat request', 'openai-compatible',
      new Error('outer', { cause: new TypeError('fetch failed: ECONNREFUSED') }));
    expect(isTransientLLMError(wrapped)).toBe(true);
  });

  it('unclassifiable errors default to transient (never re-silence a dead port)', () => {
    expect(isTransientLLMError(new Error('weird backend day'))).toBe(true);
    expect(isTransientLLMError('a plain string')).toBe(true);
    expect(isTransientLLMError(undefined)).toBe(true);
  });
});
