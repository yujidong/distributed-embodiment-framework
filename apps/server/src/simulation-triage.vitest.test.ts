/**
 * @vitest-environment node
 *
 * P4-2 server surface tests: options.triage validation + wiring, and the
 * snapshot's `llm` metrics block (cache stats + triage metrics).
 *
 * No LLM server is contacted: LLM clients are constructed lazily and no
 * events are injected, so no LLM call ever fires. `llmBaseUrl` is a dummy
 * URL — it only marks the backend "configured" for the registry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { buildTestServer, createUserScenario } from './test-utils.js';

const DUMMY_LLM_BASE = 'http://127.0.0.1:1/v1'; // unroutable; never contacted

/** Scenario whose agents carry llm blocks → registry builds an LLM client. */
function llmScenario(id: string) {
  return {
    version: '1.0',
    meta: { id, name: 'Triage Lab' },
    zones: [{ id: 'zone-a', adjacentZoneIds: [] }],
    devices: [
      {
        id: 'hvac-a',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'agent-a',
        name: 'Agent A',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
        llm: { provider: 'openai-compatible', model: 'big-model' },
      },
    ],
    events: [],
  };
}

describe('simulation options.triage (P4-2)', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'triage-store-test-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'triage-traj-test-'));
    app = await buildServer({
      userDir,
      trajectoryDir,
      logger: false,
      databasePath: ':memory:',
      llmBaseUrl: DUMMY_LLM_BASE,
    });
    const res = await createUserScenario(app, llmScenario('triage-lab'));
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  async function createSim(options?: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'triage-lab', ...(options !== undefined ? { options } : {}) },
    });
  }

  it('creates a triage-enabled sim: snapshot carries llm.triage (shadow default) + llm.cache', async () => {
    const res = await createSim({ triage: { enabled: true } });
    expect(res.statusCode).toBe(201);
    expect(res.json().llm).toBe('llm');

    const snap = await app.inject({ method: 'GET', url: `/api/simulations/${res.json().id}/snapshot` });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();

    expect(body.llm).toBeDefined();
    expect(body.llm.triage).toMatchObject({
      mode: 'shadow',
      // No explicit triage model → the resolved DECISION model of this run
      // (T-113 semantics: triage rides the same backend + model chain).
      model: 'big-model',
      triageCalls: 0,
      bigModelCallsSaved: 0,
    });
    expect(body.llm.cache).toMatchObject({ hits: 0, misses: 0, hitRate: 0 });
  });

  it('honors explicit triage model + enforce mode', async () => {
    const res = await createSim({ triage: { enabled: true, model: 'my-triage:1b', mode: 'enforce', trustIndependent: false } });
    expect(res.statusCode).toBe(201);

    const snap = await app.inject({ method: 'GET', url: `/api/simulations/${res.json().id}/snapshot` });
    expect(snap.json().llm.triage).toMatchObject({ mode: 'enforce', model: 'my-triage:1b' });
  });

  it('triage enabled:false is accepted and leaves the snapshot without llm.triage', async () => {
    const res = await createSim({ triage: { enabled: false } });
    expect(res.statusCode).toBe(201);

    const snap = await app.inject({ method: 'GET', url: `/api/simulations/${res.json().id}/snapshot` });
    // Cache is still enabled (registry attaches it to every LLM client),
    // but no triage block.
    expect(snap.json().llm?.triage).toBeUndefined();
    expect(snap.json().llm?.cache).toBeDefined();
  });

  it('reports the resolved model name (llmModel) in the create response and sim list', async () => {
    // Usability fix: the console's LLM status bar shows which model the run
    // actually uses — here the scenario agent's own llm.model ('big-model').
    const res = await createSim();
    expect(res.statusCode).toBe(201);
    expect(res.json().llm).toBe('llm');
    expect(res.json().llmModel).toBe('big-model');

    const list = await app.inject({ method: 'GET', url: '/api/simulations' });
    expect(list.statusCode).toBe(200);
    const entry = list.json().simulations.find((sim: { id: string }) => sim.id === res.json().id);
    expect(entry?.llmModel).toBe('big-model');
  });

  it('400s on malformed triage options', async () => {
    const cases: unknown[] = [
      { triage: 'yes' },
      { triage: {} }, // enabled missing
      { triage: { enabled: 'true' } },
      { triage: { enabled: true, mode: 'auto' } },
      { triage: { enabled: true, model: '' } },
      { triage: { enabled: true, trustIndependent: 1 } },
    ];
    for (const options of cases) {
      const res = await createSim(options as Record<string, unknown>);
      expect(res.statusCode, JSON.stringify(options)).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    }
  });

  it('rule-only sims ignore triage silently (no llm block in snapshot)', async () => {
    // No LLM backend configured on a second app → rule-only even with llm
    // blocks. buildTestServer scrubs an ambient LLM_BASE_URL so "no backend"
    // holds regardless of the developer's shell environment.
    const plain = await buildTestServer({
      userDir,
      trajectoryDir,
      logger: false,
      databasePath: ':memory:',
    });
    try {
      const seed = await createUserScenario(plain, llmScenario('triage-lab-2'));
      expect(seed.statusCode).toBe(201);
      const res = await plain.inject({
        method: 'POST',
        url: '/api/simulations',
        payload: { scenarioId: 'triage-lab-2', options: { triage: { enabled: true } } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().llm).toBe('rule-only');

      const snap = await plain.inject({ method: 'GET', url: `/api/simulations/${res.json().id}/snapshot` });
      expect(snap.json().llm).toBeUndefined();
    } finally {
      await plain.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T-113: the triage client honors LLM_PROVIDER
// ---------------------------------------------------------------------------

// Transparent spy on the LLMClient constructor: records (provider, config)
// per construction, delegating to the real class — behavior is unchanged,
// only the provider selection becomes assertable.
const llmClientCtor = vi.hoisted(() => vi.fn());
vi.mock('@active-collaboration/llm-integration', async importOriginal => {
  const actual = await importOriginal<
    typeof import('@active-collaboration/llm-integration')
  >();
  class SpyLLMClient extends actual.LLMClient {
    constructor(...args: ConstructorParameters<typeof actual.LLMClient>) {
      llmClientCtor(args[0], args[1]);
      super(...args);
    }
  }
  return { ...actual, LLMClient: SpyLLMClient };
});

describe('triage client provider selection (T-113)', () => {
  let app: FastifyInstance;
  let userDir: string;
  let trajectoryDir: string;

  beforeEach(async () => {
    llmClientCtor.mockClear();
    userDir = mkdtempSync(join(tmpdir(), 'triage-oc-store-'));
    trajectoryDir = mkdtempSync(join(tmpdir(), 'triage-oc-traj-'));
    app = await buildServer({
      userDir,
      trajectoryDir,
      logger: false,
      databasePath: ':memory:',
      llmProvider: 'openai-compatible',
      llmBaseUrl: 'http://127.0.0.1:1/v1',
      llmModel: 'oc-decision-model',
    });
    const res = await createUserScenario(app, llmScenario('triage-oc-lab'));
    expect(res.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    rmSync(userDir, { recursive: true, force: true });
    rmSync(trajectoryDir, { recursive: true, force: true });
  });

  it('builds the triage client against the openai-compatible /v1 backend', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: {
        scenarioId: 'triage-oc-lab',
        options: { triage: { enabled: true, model: 'oc-triage-model' } },
      },
    });
    expect(res.statusCode).toBe(201);

    const triageCall = llmClientCtor.mock.calls
      .map(([provider, config]) => ({ provider, config }))
      .find(call => call.config?.model === 'oc-triage-model');
    expect(triageCall?.provider).toBe('openai-compatible');
    expect(triageCall?.config?.baseURL).toBe('http://127.0.0.1:1/v1');
    // Only openai-compatible clients were constructed for this sim.
    expect(llmClientCtor.mock.calls.every(([provider]) => provider === 'openai-compatible')).toBe(true);
  });

  it('missing triage model defaults to the resolved decision model', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/simulations',
      payload: { scenarioId: 'triage-oc-lab', options: { triage: { enabled: true } } },
    });
    expect(res.statusCode).toBe(201);

    const snap = await app.inject({ method: 'GET', url: `/api/simulations/${res.json().id}/snapshot` });
    expect(snap.json().llm.triage.model).toBe('oc-decision-model');

    // Both decision + triage clients point at the /v1 backend.
    const ocCalls = llmClientCtor.mock.calls
      .map(([provider, config]) => ({ provider, config }))
      .filter(call => call.provider === 'openai-compatible');
    expect(ocCalls.length).toBeGreaterThanOrEqual(2);
    expect(ocCalls.every(call => call.config?.baseURL === 'http://127.0.0.1:1/v1')).toBe(true);
  });
});
