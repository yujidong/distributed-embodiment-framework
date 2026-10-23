/**
 * @vitest-environment node
 *
 * T-601 (DevLoop R26): per-agent `llm: null` survives the SERVER half of the
 * four-link chain that used to drop it:
 *
 *   (1) store  — llm:null persists as the JSON string 'null' (explicit),
 *                distinct from SQL NULL (never authored);
 *   (2) bridge — the 'null' row bridges to scenario `llm: null` (and a
 *                never-authored row omits the key entirely);
 *   (3) builder — wantsLLM counts every agent that did not explicitly opt
 *                out (R5-F02: an UNDECLARED llm block defaults to the
 *                shared client; only an all-null world — every agent
 *                llm:null — reads the rule-only warning; a mixed world
 *                builds the shared client).
 *
 * The runtime link (4) is pinned in core's EngineRuntime.llm-null suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { environmentToScenario } from './environment-bridge.js';
import { SimRuntimeBuilder } from './sim-registry/runtime-builder.js';
import {
  auth,
  makeTestApp,
  registerUser,
  type TestAppContext,
  type TestUser,
} from './test-utils.js';
import type { ScenarioDefinition } from '@active-collaboration/core';

describe('T-601 — per-agent llm:null (server links)', () => {
  let ctx: TestAppContext;
  let owner: TestUser;
  let envId: string;

  beforeEach(async () => {
    ctx = await makeTestApp();
    owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'LLM Null Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    envId = created.json().id;
  });

  // app.close() → onClose → db.close(): without this the in-memory
  // better-sqlite3 handle leaks into worker-thread teardown, where the
  // native addon's env cleanup can access-violate (0xC0000005) and take
  // down the whole threads-pool runner.
  afterEach(async () => {
    await ctx?.cleanup();
  });

  async function createAgent(payload: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/agents`,
      headers: auth(owner.token),
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; llm: unknown };
  }

  it('link 1 (store): explicit null persists as "null", absent stays SQL NULL, block persists as JSON', async () => {
    const explicitNull = await createAgent({ name: 'Explicit Null', capabilities: [], llm: null });
    const absent = await createAgent({ name: 'Absent', capabilities: [] });
    const block = await createAgent({
      name: 'Block',
      capabilities: [],
      llm: { provider: 'openai-compatible', model: 'm' },
    });

    const store = ctx.app.envStore;
    expect(store.getAgent(explicitNull.id)!.llm_json).toBe('null');
    expect(store.getAgent(absent.id)!.llm_json).toBeNull();
    expect(JSON.parse(store.getAgent(block.id)!.llm_json!)).toEqual({
      provider: 'openai-compatible',
      model: 'm',
    });

    // env GET is honest for the explicit opt-out (llm: null).
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(detail.statusCode).toBe(200);
    expect(
      (detail.json().agents as Array<{ id: string; llm: unknown }>).find(a => a.id === explicitNull.id)!.llm,
    ).toBeNull();

    // PATCH lane: clearing an existing block to null persists as explicit.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${block.id}`,
      headers: auth(owner.token),
      payload: { llm: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().llm).toBeNull();
    expect(store.getAgent(block.id)!.llm_json).toBe('null');

    // An untouched PATCH leaves the stored value alone (absent stays absent).
    const renamed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${absent.id}`,
      headers: auth(owner.token),
      payload: { name: 'Absent Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(store.getAgent(absent.id)!.llm_json).toBeNull();
  });

  it('link 2 (bridge): "null" row → scenario llm:null; SQL NULL row → key omitted', async () => {
    const explicitNull = await createAgent({ name: 'Explicit Null', capabilities: [], llm: null });
    const absent = await createAgent({ name: 'Absent', capabilities: [] });

    const env = ctx.app.envStore.getEnvironment(envId)!;
    const scenario = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );

    const nullAgent = scenario.agents.find(a => a.id === explicitNull.id)!;
    const absentAgent = scenario.agents.find(a => a.id === absent.id)!;
    expect(nullAgent.llm).toBeNull();
    // Absent bridges as undefined (the loader always materializes the key) —
    // the runtime fall-through treats it as "no opt-out".
    expect(absentAgent.llm).toBeUndefined();
  });

  it('link 3 (builder): wantsLLM counts only non-null blocks — all-null world degrades with the Fix-45b warning, mixed world builds the client', () => {
    const builder = new SimRuntimeBuilder(
      { llmProvider: 'openai-compatible', llmBaseUrl: 'http://localhost:8000/v1' },
      undefined,
      undefined,
      undefined,
      undefined,
    );

    const base = {
      version: '1.0' as const,
      meta: { id: 'w', name: 'w' },
      zones: [{ id: 'zone-a', name: 'Zone A' }],
      devices: [],
      events: [],
    };
    const allNull = {
      ...base,
      agents: [
        { id: 'a1', name: 'A1', capabilities: [], llm: null },
      ],
    } as unknown as Parameters<SimRuntimeBuilder['build']>[0]['scenario'];
    const allNullResolution = builder.resolveLLM(allNull, 'auto');
    expect(allNullResolution.mode).toBe('rule-only');
    // R5-F02: the all-null world is the remaining rule-only landing — every
    // agent EXPLICITLY opted out, and the warning says so.
    expect(allNullResolution.warning).toContain('opts out');

    const mixed = {
      ...base,
      agents: [
        { id: 'a1', name: 'A1', capabilities: [], llm: null },
        { id: 'a2', name: 'A2', capabilities: [], llm: { provider: 'openai-compatible', model: 'm2' } },
      ],
    } as unknown as Parameters<SimRuntimeBuilder['build']>[0]['scenario'];
    const mixedResolution = builder.resolveLLM(mixed, 'auto');
    expect(mixedResolution.mode).toBe('llm');
    expect(mixedResolution.client).toBeDefined();
    expect(mixedResolution.model).toBe('m2');
  });

  it('modify-object llm:null round-trips through DB → env GET → rebuilt scenario (acceptance)', async () => {
    const agent = await createAgent({
      name: 'Patch Target',
      capabilities: [],
      llm: { provider: 'openai-compatible', model: 'm' },
    });

    const proposal = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/proposals`,
      headers: auth(owner.token),
      payload: {
        kind: 'modify-object',
        title: 'Opt out of LLM',
        payload: { targetId: agent.id, patch: { llm: null } },
      },
    });
    expect(proposal.statusCode).toBe(201);
    const created = proposal.json();
    expect(created.status).not.toBe('rejected');

    // Apply (owner decide lane; low-risk modify-object may already be
    // applied — either way, drive it to applied).
    let current = created;
    if (current.status !== 'applied') {
      const decided = await ctx.app.inject({
        method: 'POST',
        url: `/api/proposals/${current.id}/decide`,
        headers: auth(owner.token),
        payload: { decision: 'approved' },
      });
      expect(decided.statusCode).toBe(200);
      current = decided.json();
    }
    expect(current.status).toBe('applied');

    // DB: explicit.
    expect(ctx.app.envStore.getAgent(agent.id)!.llm_json).toBe('null');

    // env GET: honest null.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/environments/${envId}`,
      headers: auth(owner.token),
    });
    expect(
      (detail.json().agents as Array<{ id: string; llm: unknown }>).find(a => a.id === agent.id)!.llm,
    ).toBeNull();

    // Rebuilt sim scenario: the opt-out survives (this is the value the
    // runtime's buildAgent reads — llmEnabled false by construction).
    const env = ctx.app.envStore.getEnvironment(envId)!;
    const scenario: ScenarioDefinition = environmentToScenario(
      env,
      ctx.app.envStore.devicesOf(envId),
      ctx.app.envStore.agentsOf(envId),
    );
    expect(scenario.agents.find(a => a.id === agent.id)!.llm).toBeNull();
  });
});
