/**
 * @vitest-environment node
 *
 * Per-function LLM model routing tests (server side).
 *
 * Covers: loadConfig parsing/validation of LLM_DECISION_MODEL /
 * LLM_EVAL_MODEL / LLM_NL_MODEL (bare name vs model@baseURL vs invalid),
 * SimRuntimeBuilder construction of the routed function clients (model,
 * baseURL, per-route deployedModel normalization/strict), the triage lane
 * following the decision route, the proposal reviewer's NL-route wiring,
 * and the /api/health decision-posture route summary.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ScenarioDefinition } from '@active-collaboration/core';

import { loadConfig, type ServerConfig } from './config.js';
import { SimRuntimeBuilder } from './sim-registry/runtime-builder.js';
import { resolveDecisionMode } from './llm-liveness.js';
import { selectProposalReviewer } from './server.js';

/**
 * A real local HTTP server standing in for the routed vLLM instance — the
 * workspace-built llm-integration dist is external to vitest's module graph,
 * so a cross-fetch module mock cannot intercept it; a loopback mock server
 * observes the actual wire request (path + body) instead.
 */
async function withMockVllm(
  hit: { url?: string; body?: Record<string, unknown> },
  fn: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      hit.url = req.url;
      hit.body = JSON.parse(raw) as Record<string, unknown>;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1704067200,
        model: 'ac-decision-v6',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig — per-function model routes', () => {
  it('no route envs → llmRoutes undefined (single-backend behavior)', () => {
    expect(loadConfig({}).llmRoutes).toBeUndefined();
  });

  it('bare model names parse onto the main backend', () => {
    const config = loadConfig({
      LLM_DECISION_MODEL: 'ac-decision-v6',
      LLM_EVAL_MODEL: 'qwen3-8b-eval',
      LLM_NL_MODEL: 'qwen3-8b-nl',
    });
    expect(config.llmRoutes).toEqual({
      decision: { model: 'ac-decision-v6' },
      eval: { model: 'qwen3-8b-eval' },
      nl: { model: 'qwen3-8b-nl' },
    });
  });

  it('model@baseURL pins a function to another vLLM instance', () => {
    const config = loadConfig({
      LLM_DECISION_MODEL: 'ac-decision-v6@http://127.0.0.1:8001/v1',
    });
    expect(config.llmRoutes?.decision).toEqual({
      model: 'ac-decision-v6',
      baseURL: 'http://127.0.0.1:8001/v1',
    });
  });

  it('malformed route values are boot issues naming the knob', () => {
    expect(() => loadConfig({ LLM_DECISION_MODEL: 'ac-decision-v6@not-a-url' }))
      .toThrow(/LLM_DECISION_MODEL/);
    expect(() => loadConfig({ LLM_EVAL_MODEL: 'has space' })).toThrow(/LLM_EVAL_MODEL/);
    expect(() => loadConfig({ LLM_NL_MODEL: '@http://127.0.0.1:8001/v1' })).toThrow(/LLM_NL_MODEL/);
  });

  it('empty route values count as unset', () => {
    expect(loadConfig({ LLM_DECISION_MODEL: '' }).llmRoutes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SimRuntimeBuilder — routed function clients
// ---------------------------------------------------------------------------

function scenarioOf(agents: Array<Record<string, unknown>>): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'w-routes', name: 'Routes world' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [],
    events: [],
    agents: agents as unknown as ScenarioDefinition['agents'],
  };
}

function builderWithRoutes(llmRoutes?: import('@active-collaboration/llm-integration').LlmModelRoutes): SimRuntimeBuilder {
  return new SimRuntimeBuilder(
    {
      llmProvider: 'openai-compatible',
      llmBaseUrl: 'http://localhost:8000/v1',
      llmModel: 'qwen3-27b',
      ...(llmRoutes !== undefined ? { llmRoutes } : {}),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

function baseURLOf(client: import('@active-collaboration/llm-integration').LLMClient): string | undefined {
  return (client.getProvider().getConfig() as { baseURL?: string }).baseURL;
}

describe('SimRuntimeBuilder — per-function routed clients', () => {
  afterEach(() => {
    delete process.env.LLM_MODEL_STRICT;
  });

  it('no routes → no function clients (legacy single client)', async () => {
    const builder = builderWithRoutes();
    const { llm } = await builder.build({
      id: 'sim-routes-0',
      scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
      options: {},
    });
    expect(llm.functionClients).toBeUndefined();
  });

  it('each route builds a client with its own model and backend', async () => {
    const builder = builderWithRoutes({
      decision: { model: 'ac-decision-v6', baseURL: 'http://127.0.0.1:8001/v1' },
      eval: { model: 'qwen3-8b-eval' },
      nl: { model: 'qwen3-8b-nl' },
    });
    const { llm } = await builder.build({
      id: 'sim-routes-1',
      scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
      options: {},
    });
    const fns = llm.functionClients;
    expect(fns?.decision?.getModel()).toBe('ac-decision-v6');
    expect(baseURLOf(fns!.decision!)).toBe('http://127.0.0.1:8001/v1');
    // Bare-name routes reuse the main LLM_BASE_URL.
    expect(fns?.eval?.getModel()).toBe('qwen3-8b-eval');
    expect(baseURLOf(fns!.eval!)).toBe('http://localhost:8000/v1');
    expect(fns?.nl?.getModel()).toBe('qwen3-8b-nl');
    // The shared client is untouched (LLM_MODEL).
    expect(llm.client?.getModel()).toBe('qwen3-27b');
  });

  it('per-route normalization: a mismatching request model is rewritten to the ROUTE model', async () => {
    const hit: { url?: string; body?: Record<string, unknown> } = {};
    await withMockVllm(hit, async routeBaseURL => {
      const builder = builderWithRoutes({
        decision: { model: 'ac-decision-v6', baseURL: routeBaseURL },
      });
      const { llm } = await builder.build({
        id: 'sim-routes-2',
        scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
        options: {},
      });
      const response = await llm.functionClients!.decision!.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'qwen3-27b',
      });
      expect(response.content).toBe('ok');
    });
    // The call went to the ROUTE's own vLLM instance, model rewritten to
    // the route model (per-route deployedModel normalization).
    expect(hit.url).toMatch(/\/v1\/chat\/completions$/);
    expect(hit.body?.model).toBe('ac-decision-v6');
  });

  it('LLM_MODEL_STRICT=1 applies per route: each routed client rejects mismatches', async () => {
    process.env.LLM_MODEL_STRICT = '1';
    const builder = builderWithRoutes({
      decision: { model: 'ac-decision-v6' },
      eval: { model: 'qwen3-8b-eval' },
    });
    const { llm } = await builder.build({
      id: 'sim-routes-3',
      scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
      options: {},
    });
    // Strict mode throws BEFORE any provider call (no backend needed here).
    await expect(
      llm.functionClients!.decision!.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'qwen3-27b',
      }),
    ).rejects.toThrow(/model not found/);
    await expect(
      llm.functionClients!.eval!.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'qwen3-27b',
      }),
    ).rejects.toThrow(/model not found/);
  });

  it('the triage lane follows the decision route when no triage model is set', async () => {
    const builder = builderWithRoutes({
      decision: { model: 'ac-decision-v6' },
    });
    const { runtime } = await builder.build({
      id: 'sim-routes-4',
      scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
      options: { triage: { enabled: true } },
    });
    expect(runtime.getSnapshot().llm?.triage?.model).toBe('ac-decision-v6');
  });

  it('an explicit LLM_TRIAGE_MODEL still wins over the decision route', async () => {
    const builder = new SimRuntimeBuilder(
      {
        llmProvider: 'openai-compatible',
        llmBaseUrl: 'http://localhost:8000/v1',
        llmModel: 'qwen3-27b',
        llmTriageModel: 'ac-decision-15b-v2',
        llmRoutes: { decision: { model: 'ac-decision-v6' } },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const { runtime } = await builder.build({
      id: 'sim-routes-5',
      scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
      options: { triage: { enabled: true } },
    });
    expect(runtime.getSnapshot().llm?.triage?.model).toBe('ac-decision-15b-v2');
  });
});

// ---------------------------------------------------------------------------
// T134 (R20-F, u1-F1) — EAF_AC_HANDSHAKE_FAST_LANE (default OFF, bit-parity)
// ---------------------------------------------------------------------------

import { getLLMQueueStats, getFastLaneQueueStats } from '@active-collaboration/llm-integration';
import { handshakeFastLaneFromEnv } from './sim-registry/runtime-builder.js';

describe('SimRuntimeBuilder — EAF_AC_HANDSHAKE_FAST_LANE (default off, zero drift)', () => {
  afterEach(() => {
    delete process.env.EAF_AC_HANDSHAKE_FAST_LANE;
  });

  it('the env parse is a boolean gate: unset/off → false; 1/true/on/yes → false-ish spellings accepted', () => {
    delete process.env.EAF_AC_HANDSHAKE_FAST_LANE;
    expect(handshakeFastLaneFromEnv()).toBe(false);
    process.env.EAF_AC_HANDSHAKE_FAST_LANE = '0';
    expect(handshakeFastLaneFromEnv()).toBe(false);
    process.env.EAF_AC_HANDSHAKE_FAST_LANE = 'off';
    expect(handshakeFastLaneFromEnv()).toBe(false);
    for (const on of ['1', 'true', 'on', 'yes', 'YES']) {
      process.env.EAF_AC_HANDSHAKE_FAST_LANE = on;
      expect(handshakeFastLaneFromEnv()).toBe(true);
    }
  });

  it('DEFAULT OFF: the eval-route client still admits to the GLOBAL queue (bit-parity with the pre-T134 wiring)', async () => {
    const hit: { url?: string; body?: Record<string, unknown> } = {};
    await withMockVllm(hit, async baseURL => {
      const builder = builderWithRoutes({ eval: { model: 'qwen3-8b-eval' } });
      // Point the shared backend at the mock so the call actually completes.
      (builder as unknown as { llmEnv: { llmBaseUrl: string } }).llmEnv.llmBaseUrl = baseURL;
      const { llm } = await builder.build({
        id: 'sim-fastlane-off',
        scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
        options: {},
      });
      const fastBefore = getFastLaneQueueStats().waitCount;
      const globalBefore = getLLMQueueStats().waitCount;
      await llm.functionClients!.eval!.chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(getFastLaneQueueStats().waitCount).toBe(fastBefore);
      expect(getLLMQueueStats().waitCount).toBe(globalBefore + 1);
    });
  });

  it('ON: the eval client admits to the FAST lane; a decision-routed client keeps its own lane either way', async () => {
    process.env.EAF_AC_HANDSHAKE_FAST_LANE = '1';
    const hit: { url?: string; body?: Record<string, unknown> } = {};
    await withMockVllm(hit, async baseURL => {
      const builder = builderWithRoutes({ eval: { model: 'qwen3-8b-eval' } });
      (builder as unknown as { llmEnv: { llmBaseUrl: string } }).llmEnv.llmBaseUrl = baseURL;
      const { llm } = await builder.build({
        id: 'sim-fastlane-on',
        scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
        options: {},
      });
      const fastBefore = getFastLaneQueueStats().waitCount;
      const globalBefore = getLLMQueueStats().waitCount;
      await llm.functionClients!.eval!.chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(getFastLaneQueueStats().waitCount).toBe(fastBefore + 1);
      expect(getLLMQueueStats().waitCount).toBe(globalBefore);
      // The route model is untouched by the lane flag.
      expect(llm.functionClients!.eval!.getModel()).toBe('qwen3-8b-eval');
    });
  });

  it('ON with NO eval route: a DEDICATED handshake-eval client is minted (model = LLM_MODEL) on the fast lane; shared client untouched', async () => {
    process.env.EAF_AC_HANDSHAKE_FAST_LANE = '1';
    const hit: { url?: string; body?: Record<string, unknown> } = {};
    await withMockVllm(hit, async baseURL => {
      const builder = builderWithRoutes(undefined);
      (builder as unknown as { llmEnv: { llmBaseUrl: string } }).llmEnv.llmBaseUrl = baseURL;
      const { llm } = await builder.build({
        id: 'sim-fastlane-no-route',
        scenario: scenarioOf([{ id: 'a-1', name: 'A', capabilities: [] }]),
        options: {},
      });
      // Previously undefined (no routes) — the knob mints ONLY the eval client.
      expect(llm.functionClients?.decision).toBeUndefined();
      expect(llm.functionClients?.nl).toBeUndefined();
      expect(llm.functionClients?.eval?.getModel()).toBe('qwen3-27b');
      const fastBefore = getFastLaneQueueStats().waitCount;
      const globalBefore = getLLMQueueStats().waitCount;
      await llm.functionClients!.eval!.chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(getFastLaneQueueStats().waitCount).toBe(fastBefore + 1);
      expect(getLLMQueueStats().waitCount).toBe(globalBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// Proposal reviewer — NL route
// ---------------------------------------------------------------------------

function reviewerConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    ...loadConfig({}),
    proposalReviewer: 'auto',
    proposalReviewLlmTimeoutMs: 60_000,
    proposalReviewTimeoutAutoApprove: true,
    ...overrides,
  } as ServerConfig;
}

describe('selectProposalReviewer — NL route wiring', () => {
  it('an NL route with @baseURL configures the reviewer without LLM_BASE_URL', () => {
    const reviewer = selectProposalReviewer(
      reviewerConfig({ llmRoutes: { nl: { model: 'qwen3-8b-nl', baseURL: 'http://127.0.0.1:8002/v1' } } }),
      {} as never,
      { warn: () => {} },
    );
    expect(reviewer).toBeDefined();
  });

  it('no backend and no route → no reviewer (legacy)', () => {
    const warn = vi.fn();
    const reviewer = selectProposalReviewer(reviewerConfig({}), {} as never, { warn });
    expect(reviewer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /api/health decision posture — route summary
// ---------------------------------------------------------------------------

describe('resolveDecisionMode — route summary', () => {
  it('exposes the route table in canonical string form on the llm posture', () => {
    const posture = resolveDecisionMode({
      llmBaseUrl: 'http://localhost:8000/v1',
      llmModel: 'qwen3-27b',
      llmRoutes: {
        decision: { model: 'ac-decision-v6', baseURL: 'http://127.0.0.1:8001/v1' },
        eval: { model: 'qwen3-8b-eval' },
      },
    });
    expect(posture.mode).toBe('llm');
    expect(posture.routes).toEqual({
      decision: 'ac-decision-v6@http://127.0.0.1:8001/v1',
      eval: 'qwen3-8b-eval',
    });
  });

  it('the route summary rides the rule-test posture too (config truth)', () => {
    const posture = resolveDecisionMode({
      llmRoutes: { nl: { model: 'qwen3-8b-nl' } },
    });
    expect(posture.mode).toBe('rule-test');
    expect(posture.routes).toEqual({ nl: 'qwen3-8b-nl' });
  });

  it('no routes → no routes key (legacy wire shape)', () => {
    const posture = resolveDecisionMode({
      llmBaseUrl: 'http://localhost:8000/v1',
      llmModel: 'qwen3-27b',
    });
    expect('routes' in posture).toBe(false);
  });
});
