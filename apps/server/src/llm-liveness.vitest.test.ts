/**
 * R74 decision-posture resolver — config presence alone must never claim
 * production: an unconfigured server is the rule harness (TEST-ONLY) and a
 * configured-but-unreachable backend is a DEGRADED posture, not 'llm'.
 */

import { describe, expect, it } from 'vitest';

import { resolveDecisionMode, type LlmLivenessSnapshot } from './llm-liveness.js';

const SNAP_OK: LlmLivenessSnapshot = {
  reachable: true,
  checkedAtMs: 1,
  latencyMs: 5,
  consecutiveFailures: 0,
};

const SNAP_DOWN: LlmLivenessSnapshot = {
  reachable: false,
  checkedAtMs: 1,
  latencyMs: null,
  consecutiveFailures: 3,
  lastError: 'connect ECONNREFUSED 127.0.0.1:8000',
};

describe('resolveDecisionMode (R74)', () => {
  it('reports rule-test when the LLM triple is not configured', () => {
    const posture = resolveDecisionMode({}, undefined);
    expect(posture.mode).toBe('rule-test');
    expect(posture.unconfiguredReason).toBeUndefined();

    const taught = resolveDecisionMode(
      { llmUnconfiguredWarning: 'LLM_BASE_URL missing' },
      undefined,
    );
    expect(taught.mode).toBe('rule-test');
    expect(taught.unconfiguredReason).toBe('LLM_BASE_URL missing');
  });

  it('reports llm when configured and the backend answers', () => {
    expect(resolveDecisionMode({ llmBaseUrl: 'http://x/v1', llmModel: 'm' }, SNAP_OK)).toEqual({
      mode: 'llm',
      model: 'm',
    });
    // No probe result yet (first seconds) — optimistic 'llm', never rule-test.
    expect(
      resolveDecisionMode({ llmBaseUrl: 'http://x/v1', llmModel: 'm' }, undefined).mode,
    ).toBe('llm');
  });

  it('reports llm-unreachable when the configured backend is down', () => {
    const posture = resolveDecisionMode({ llmBaseUrl: 'http://x/v1', llmModel: 'm' }, SNAP_DOWN);
    expect(posture.mode).toBe('llm-unreachable');
    expect(posture.model).toBe('m');
    expect(posture.unreachableDetail).toContain('ECONNREFUSED');
  });
});
