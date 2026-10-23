/**
 * Per-function model route parsing tests (LLM_DECISION_MODEL /
 * LLM_EVAL_MODEL / LLM_NL_MODEL values).
 *
 * A route is a bare model name (served by the main LLM_BASE_URL) or
 * `model@http(s)://…` pinning the function to another vLLM instance.
 * Malformed values parse to null so loadConfig can report them at boot.
 */

import { describe, it, expect } from 'vitest';
import { parseModelRoute, formatModelRoute } from './model-route';

describe('parseModelRoute', () => {
  it('bare model name → main-backend route', () => {
    expect(parseModelRoute('ac-decision-v6')).toEqual({ model: 'ac-decision-v6' });
  });

  it('model@baseURL → route pinned to another vLLM instance', () => {
    expect(parseModelRoute('ac-decision-v6@http://127.0.0.1:8001/v1')).toEqual({
      model: 'ac-decision-v6',
      baseURL: 'http://127.0.0.1:8001/v1',
    });
  });

  it('https baseURL is accepted', () => {
    expect(parseModelRoute('qwen3-8b@https://llm.internal/v1')).toEqual({
      model: 'qwen3-8b',
      baseURL: 'https://llm.internal/v1',
    });
  });

  it('surrounding whitespace is trimmed', () => {
    expect(parseModelRoute('  ac-decision-v6 @ http://127.0.0.1:8001/v1 ')).toEqual({
      model: 'ac-decision-v6',
      baseURL: 'http://127.0.0.1:8001/v1',
    });
  });

  it('org/model names (slash) are fine', () => {
    expect(parseModelRoute('Qwen/Qwen3-8B')).toEqual({ model: 'Qwen/Qwen3-8B' });
  });

  it('empty / whitespace-only values are invalid', () => {
    expect(parseModelRoute('')).toBeNull();
    expect(parseModelRoute('   ')).toBeNull();
  });

  it('model names with whitespace are invalid', () => {
    expect(parseModelRoute('ac decision v6')).toBeNull();
    expect(parseModelRoute('ac decision@http://127.0.0.1:8001/v1')).toBeNull();
  });

  it('@ with an empty side is invalid', () => {
    expect(parseModelRoute('@http://127.0.0.1:8001/v1')).toBeNull();
    expect(parseModelRoute('ac-decision-v6@')).toBeNull();
  });

  it('@ with a non-URL right side is invalid', () => {
    expect(parseModelRoute('ac-decision-v6@not-a-url')).toBeNull();
  });

  it('@ with a non-http(s) scheme is invalid', () => {
    expect(parseModelRoute('ac-decision-v6@ftp://127.0.0.1/v1')).toBeNull();
  });
});

describe('formatModelRoute', () => {
  it('round-trips both shapes', () => {
    expect(formatModelRoute({ model: 'ac-decision-v6' })).toBe('ac-decision-v6');
    expect(formatModelRoute({ model: 'ac-decision-v6', baseURL: 'http://127.0.0.1:8001/v1' }))
      .toBe('ac-decision-v6@http://127.0.0.1:8001/v1');
  });
});
