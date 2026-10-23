/**
 * @vitest-environment node
 *
 * Server configuration tests (currently: the Fix-12 proposal-review LLM
 * budget, R5-P1-1; the log-governance knobs LOG_LEVEL /
 * EAF_LOG_MODULE_LEVELS / LOG_FILE / LOG_MAX_SIZE / LOG_MAX_FILES).
 * loadConfig is pure in its env argument, so these run without touching
 * process.env.
 */

import { describe, expect, it, vi } from 'vitest';

import { LoggerLevel } from '@active-collaboration/shared';

import { DEV_JWT_SECRET, loadConfig } from './config.js';

describe('loadConfig — JWT_SECRET production enforcement (S3, Task 1)', () => {
  it('dev boots keep the zero-config default (unset JWT_SECRET is fine)', () => {
    const config = loadConfig({});
    expect(config.jwtSecretIsDefault).toBe(true);
    expect(config.jwtSecret).toBe(DEV_JWT_SECRET);
    expect(config.strictEnv).toBe(false);
  });

  it('NODE_ENV=test alone stays zero-config (the vitest default path)', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.jwtSecretIsDefault).toBe(true);
    expect(config.strictEnv).toBe(false);
  });

  it('refuses to boot in production mode without JWT_SECRET (teaching error)', () => {
    let message = '';
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('openssl rand -hex 32');
    expect(message).toContain('NODE_ENV=production');
  });

  it('refuses when JWT_SECRET was set to the literal development default', () => {
    // Someone copied the public dev key into .env — same known-key risk.
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET })).toThrow(/JWT_SECRET/);
    expect(loadConfig({ JWT_SECRET: DEV_JWT_SECRET }).jwtSecretIsDefault).toBe(true);
  });

  it('EAF_STRICT_ENV=1 forces the same refusal outside NODE_ENV=production', () => {
    expect(() => loadConfig({ EAF_STRICT_ENV: '1' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'development', EAF_STRICT_ENV: 'true' })).toThrow(/JWT_SECRET/);
    // Disabled spellings keep the lax behavior.
    expect(loadConfig({ EAF_STRICT_ENV: '0' }).strictEnv).toBe(false);
    expect(loadConfig({ EAF_STRICT_ENV: 'false' }).strictEnv).toBe(false);
  });

  it('boots with JWT_SECRET set in production mode', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'a'.repeat(64),
    });
    expect(config.strictEnv).toBe(true);
    expect(config.jwtSecretIsDefault).toBe(false);
    expect(config.jwtSecret).toBe('a'.repeat(64));
  });
});

describe('loadConfig — RATE_LIMIT_AUTH_PER_MIN (Fix-13, widened 10 → 30)', () => {
  it('defaults to 30 req/min when the variable is unset', () => {
    expect(loadConfig({}).rateLimitAuthPerMin).toBe(30);
  });

  it('honours an explicit operator override', () => {
    expect(loadConfig({ RATE_LIMIT_AUTH_PER_MIN: '60' }).rateLimitAuthPerMin).toBe(60);
  });

  it('rejects a non-positive / non-numeric value (fail fast)', () => {
    expect(() => loadConfig({ RATE_LIMIT_AUTH_PER_MIN: 'abc' })).toThrow();
    expect(() => loadConfig({ RATE_LIMIT_AUTH_PER_MIN: '0' })).toThrow();
  });
});

describe('loadConfig — RATE_LIMIT_SESSION_PER_MIN (R76-F1, session bucket split from auth)', () => {
  it('defaults to 300 req/min when the variable is unset', () => {
    expect(loadConfig({}).rateLimitSessionPerMin).toBe(300);
  });

  it('honours an explicit operator override', () => {
    expect(loadConfig({ RATE_LIMIT_SESSION_PER_MIN: '60' }).rateLimitSessionPerMin).toBe(60);
  });

  it('rejects a non-positive / non-numeric value (fail fast)', () => {
    expect(() => loadConfig({ RATE_LIMIT_SESSION_PER_MIN: 'abc' })).toThrow();
    expect(() => loadConfig({ RATE_LIMIT_SESSION_PER_MIN: '0' })).toThrow();
  });
});

describe('loadConfig — PROPOSAL_REVIEW_LLM_TIMEOUT_MS (Fix-12)', () => {
  it('defaults to 60s when the variable is unset', () => {
    const config = loadConfig({});
    expect(config.proposalReviewLlmTimeoutMs).toBe(60_000);
  });

  it('honours an explicit operator override', () => {
    const config = loadConfig({ PROPOSAL_REVIEW_LLM_TIMEOUT_MS: '120000' });
    expect(config.proposalReviewLlmTimeoutMs).toBe(120_000);
  });

  it('rejects a non-positive / non-numeric value (fail fast, like the other budgets)', () => {
    expect(() => loadConfig({ PROPOSAL_REVIEW_LLM_TIMEOUT_MS: 'abc' })).toThrow();
    expect(() => loadConfig({ PROPOSAL_REVIEW_LLM_TIMEOUT_MS: '0' })).toThrow();
  });
});

describe('loadConfig — PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE (Fix-12 policy)', () => {
  it('defaults to true (platform policy: low-risk timeout auto-approve)', () => {
    expect(loadConfig({}).proposalReviewTimeoutAutoApprove).toBe(true);
  });

  it("'false' restores pure escalate-on-failure", () => {
    expect(loadConfig({ PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE: 'false' }).proposalReviewTimeoutAutoApprove).toBe(false);
    expect(loadConfig({ PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE: '0' }).proposalReviewTimeoutAutoApprove).toBe(false);
  });

  it('any other value keeps the policy on', () => {
    expect(loadConfig({ PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE: 'true' }).proposalReviewTimeoutAutoApprove).toBe(true);
  });
});

describe('loadConfig — LOG_LEVEL (Tier-1 master switch)', () => {
  it("defaults to 'info' when the variable is unset", () => {
    expect(loadConfig({}).logLevel).toBe('info');
  });

  it('accepts every documented level (case-insensitive)', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'silent']) {
      expect(loadConfig({ LOG_LEVEL: level }).logLevel).toBe(level);
    }
    expect(loadConfig({ LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
  });

  it('rejects an unknown level (fail fast, like the other enums)', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/Invalid LOG_LEVEL/);
  });
});

describe('loadConfig — EAF_LOG_MODULE_LEVELS (JSON, fault-tolerant)', () => {
  it('is undefined when the variable is unset', () => {
    expect(loadConfig({}).logModuleLevels).toBeUndefined();
  });

  it('parses a valid JSON object into LoggerLevel enums', () => {
    const config = loadConfig({
      EAF_LOG_MODULE_LEVELS: '{"PhysicsLayer":"warn","CognitiveAgent":"debug"}',
    });
    expect(config.logModuleLevels).toEqual({
      PhysicsLayer: LoggerLevel.WARN,
      CognitiveAgent: LoggerLevel.DEBUG,
    });
  });

  it('degrades to undefined + one warn on malformed JSON (never throws)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig({ EAF_LOG_MODULE_LEVELS: '{not json' }).logModuleLevels).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('EAF_LOG_MODULE_LEVELS');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('degrades to undefined + one warn on a wrong-shaped or wrong-level value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig({ EAF_LOG_MODULE_LEVELS: '["PhysicsLayer"]' }).logModuleLevels).toBeUndefined();
      expect(loadConfig({ EAF_LOG_MODULE_LEVELS: '{"PhysicsLayer":"chatty"}' }).logModuleLevels).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('loadConfig — LOG_FILE / LOG_MAX_SIZE / LOG_MAX_FILES (file tee + rotation)', () => {
  it('keeps pure stdout by default (no logFile, 10MB / 5 generations)', () => {
    const config = loadConfig({});
    expect(config.logFile).toBeUndefined();
    expect(config.logMaxSize).toBe(10 * 1024 * 1024);
    expect(config.logMaxFiles).toBe(5);
  });

  it('honours an explicit LOG_FILE and rotation overrides', () => {
    const config = loadConfig({ LOG_FILE: '/var/log/eaf/app.log', LOG_MAX_SIZE: '2097152', LOG_MAX_FILES: '3' });
    expect(config.logFile).toBe('/var/log/eaf/app.log');
    expect(config.logMaxSize).toBe(2 * 1024 * 1024);
    expect(config.logMaxFiles).toBe(3);
  });

  it('accepts KB/MB suffixes for LOG_MAX_SIZE', () => {
    expect(loadConfig({ LOG_MAX_SIZE: '512KB' }).logMaxSize).toBe(512 * 1024);
    expect(loadConfig({ LOG_MAX_SIZE: '50mb' }).logMaxSize).toBe(50 * 1024 * 1024);
  });

  it('rejects a non-size LOG_MAX_SIZE (fail fast)', () => {
    expect(() => loadConfig({ LOG_MAX_SIZE: 'lots' })).toThrow(/byte-size/);
    expect(() => loadConfig({ LOG_MAX_SIZE: '0' })).toThrow(/byte-size/);
  });
});

describe('loadConfig — startup self-check aggregation (R15-A4)', () => {
  it('reports EVERY invalid variable in one error, not first-only', () => {
    let message = '';
    try {
      loadConfig({ RATE_LIMIT_AUTH_PER_MIN: 'abc', LOG_LEVEL: 'verbose', LOG_MAX_SIZE: 'lots' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('3 issues');
    expect(message).toContain('RATE_LIMIT_AUTH_PER_MIN');
    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('LOG_MAX_SIZE');
  });

  it('validates values that historically exploded only at use time', () => {
    // LLM_MAX_CONCURRENT was parsed inside llm-integration with parseInt —
    // 'abc' silently produced NaN and a broken queue.
    expect(() => loadConfig({ LLM_MAX_CONCURRENT: 'abc' })).toThrow(/LLM_MAX_CONCURRENT/);
    expect(() => loadConfig({ LLM_MAX_CONCURRENT: '0' })).toThrow(/LLM_MAX_CONCURRENT/);
    // Non-URL LLM_BASE_URL used to surface as fetch errors mid-simulation.
    expect(() => loadConfig({ LLM_BASE_URL: 'not a url' })).toThrow(/LLM_BASE_URL/);
    expect(() => loadConfig({ HASS_URL: 'ftp://x' })).toThrow(/HASS_URL/);
    // Valid values pass the same checks.
    expect(loadConfig({ LLM_MAX_CONCURRENT: '8', LLM_BASE_URL: 'http://127.0.0.1:8000/v1' }).port).toBe(8100);
  });

  it('treats empty strings as unset (falls back) instead of failing', () => {
    const config = loadConfig({ PORT: '', LOG_LEVEL: '', RATE_LIMIT_AUTH_PER_MIN: '' });
    expect(config.port).toBe(8100);
    expect(config.logLevel).toBe('info');
    expect(config.rateLimitAuthPerMin).toBe(30);
  });

  it('keeps the settlement-provider guard self-explaining', () => {
    expect(() => loadConfig({ SETTLEMENT_PROVIDER: 'stripe' })).toThrow(/only "null" is available/);
  });
});

describe('loadConfig — LLM service layer (R15-C1/C2)', () => {
  it('defaults to the openai-compatible provider with concurrency 3', () => {
    const config = loadConfig({});
    expect(config.llmProvider).toBe('openai-compatible');
    expect(config.llmMaxConcurrent).toBe(3);
    // R44-B: an incomplete backend config is a WARNING, not a boot error —
    // the server runs rule-only and teaches at startup.
    expect(config.llmUnconfiguredWarning).toMatch(/LLM_BASE_URL/);
  });

  it('accepts the openai-compatible triple', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://127.0.0.1:8000/v1',
      LLM_API_KEY: 'sk-x',
      LLM_MODEL: 'qwen3-32b',
      LLM_MAX_CONCURRENT: '8',
    });
    expect(config.llmProvider).toBe('openai-compatible');
    expect(config.llmBaseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(config.llmApiKey).toBe('sk-x');
    expect(config.llmModel).toBe('qwen3-32b');
    expect(config.llmMaxConcurrent).toBe(8);
  });

  it('teaches (warns, not throws) when the backend triple is incomplete', () => {
    const config = loadConfig({ LLM_PROVIDER: 'openai-compatible' });
    expect(config.llmUnconfiguredWarning).toMatch(/LLM_BASE_URL/);
    const noModel = loadConfig({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://127.0.0.1:8000/v1',
    });
    expect(noModel.llmUnconfiguredWarning).toMatch(/LLM_MODEL/);
    const complete = loadConfig({
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'http://127.0.0.1:8000/v1',
      LLM_MODEL: 'qwen3-32b',
    });
    expect(complete.llmUnconfiguredWarning).toBeUndefined();
  });

  it('rejects an unknown provider value', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic' })).toThrow(/LLM_PROVIDER/);
    // R44-B: the ollama backend was removed — the value now fails loudly.
    expect(() => loadConfig({ LLM_PROVIDER: 'ollama' })).toThrow(/LLM_PROVIDER.*R44-B/s);
  });

  it("S-vLLM (R20): 'vllm' is an alias for 'openai-compatible'", () => {
    const config = loadConfig({
      LLM_PROVIDER: 'vllm',
      LLM_BASE_URL: 'http://127.0.0.1:8000/v1',
      LLM_MODEL: 'qwen3-8b',
    });
    expect(config.llmUnconfiguredWarning).toBeUndefined();
    // Canonicalized — downstream (registry, triage T-113, reviewer) only
    // ever sees 'openai-compatible'.
    expect(config.llmProvider).toBe('openai-compatible');
  });

  it('S-vLLM (R20): LLM_TIMEOUT_MS is optional, validated when set', () => {
    // Unset → undefined: each provider keeps its own default budget.
    expect(loadConfig({}).llmTimeoutMs).toBeUndefined();
    expect(loadConfig({ LLM_TIMEOUT_MS: '120000' }).llmTimeoutMs).toBe(120000);
    expect(() => loadConfig({ LLM_TIMEOUT_MS: 'soon' })).toThrow(/LLM_TIMEOUT_MS/);
    expect(() => loadConfig({ LLM_TIMEOUT_MS: '0' })).toThrow(/LLM_TIMEOUT_MS/);
  });
});

describe('loadConfig — EAF_MAX_BODY_BYTES (T-111)', () => {
  it('defaults to 32MB when the variable is unset', () => {
    expect(loadConfig({}).maxBodyBytes).toBe(32 * 1024 * 1024);
  });

  it('honours an explicit operator override', () => {
    expect(loadConfig({ EAF_MAX_BODY_BYTES: '1048576' }).maxBodyBytes).toBe(1024 * 1024);
  });

  it('rejects a non-positive / non-numeric value (fail fast)', () => {
    expect(() => loadConfig({ EAF_MAX_BODY_BYTES: 'abc' })).toThrow();
    expect(() => loadConfig({ EAF_MAX_BODY_BYTES: '0' })).toThrow();
  });
});
