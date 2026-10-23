/**
 * @vitest-environment node
 *
 * R37-F3 (validation F3): per-agent `llm.model` is WIRED on the world-session
 * path. Agents declare `llm: {provider, model}` but every decision ran on the
 * server-default model — `resolveAgentLlmClient` only honored `llmPerAgent`
 * (which no server code populated) or `llm: null`.
 *
 * The fix populates the T-601 `llmPerAgent` seam in SimRuntimeBuilder.build:
 * a dedicated client per DISTINCT declared model (cache + instrumented like
 * the shared one); `llm: null` agents stay rule-only; agents on the shared
 * model keep the legacy fall-through. Verified through the built runtime's
 * per-agent model capture (the same map recentDecisions.llmModel reads).
 */

import { describe, expect, it } from 'vitest';

import { setLogSink } from '@active-collaboration/shared';

import { SimRuntimeBuilder } from './sim-registry/runtime-builder.js';
import type { ScenarioDefinition } from '@active-collaboration/core';

function scenarioOf(agents: Array<Record<string, unknown>>): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'w-f3', name: 'F3 world' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [],
    events: [],
    agents: agents as unknown as ScenarioDefinition['agents'],
  };
}

function builderWith(llmModel?: string): SimRuntimeBuilder {
  return new SimRuntimeBuilder(
    {
      llmProvider: 'openai-compatible',
      llmBaseUrl: 'http://localhost:8000/v1',
      ...(llmModel !== undefined ? { llmModel } : {}),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

describe('R37-F3 — per-agent llm.model (server)', () => {
  it('a declared llm.model wins for that agent; others keep the shared default', async () => {
    const builder = builderWith('ac-decision-v4:latest');
    const { runtime, llm } = await builder.build({
      id: 'sim-f3-1',
      scenario: scenarioOf([
        { id: 'a-declared', name: 'Declared', capabilities: [], llm: { provider: 'openai-compatible', model: 'qwen3-vl:8b' } },
        { id: 'a-block-no-model', name: 'Block No Model', capabilities: [], llm: { provider: 'openai-compatible' } },
        { id: 'a-null', name: 'Null', capabilities: [], llm: null },
        { id: 'a-absent', name: 'Absent', capabilities: [] },
      ]),
      options: {},
    });

    // The shared resolution still reports the server default.
    expect(llm.model).toBe('ac-decision-v4:latest');
    // The agent that declared its own model decides ON it (the F3 fix).
    expect(runtime.getAgentLlmModel('a-declared')).toBe('qwen3-vl:8b');
    // llm block without a model → shared default (legacy fall-through).
    expect(runtime.getAgentLlmModel('a-block-no-model')).toBe('ac-decision-v4:latest');
    // llm: null → rule-only, no model.
    expect(runtime.getAgentLlmModel('a-null')).toBeUndefined();
    // No llm key at all → shared default (legacy fall-through).
    expect(runtime.getAgentLlmModel('a-absent')).toBe('ac-decision-v4:latest');
  });

  it('an explicit create-time llmModel shapes the shared default, not a declared llm.model', async () => {
    const builder = builderWith('ac-decision-v4:latest');
    const { runtime, llm } = await builder.build({
      id: 'sim-f3-2',
      scenario: scenarioOf([
        { id: 'a-declared', name: 'Declared', capabilities: [], llm: { provider: 'openai-compatible', model: 'qwen3-vl:8b' } },
        { id: 'a-shared', name: 'Shared', capabilities: [], llm: { provider: 'openai-compatible' } },
      ]),
      options: { llmModel: 'llama3:8b' },
    });

    // Operator override changes the shared client…
    expect(llm.model).toBe('llama3:8b');
    expect(runtime.getAgentLlmModel('a-shared')).toBe('llama3:8b');
    // …but the author's per-agent declaration is the more specific choice.
    expect(runtime.getAgentLlmModel('a-declared')).toBe('qwen3-vl:8b');
  });

  it('agents declaring the SAME model share one client; empty-string models degrade to shared', async () => {
    const builder = builderWith('ac-decision-v4:latest');
    const { runtime } = await builder.build({
      id: 'sim-f3-3',
      scenario: scenarioOf([
        { id: 'a-x', name: 'X', capabilities: [], llm: { provider: 'openai-compatible', model: 'qwen3-vl:8b' } },
        { id: 'a-y', name: 'Y', capabilities: [], llm: { provider: 'openai-compatible', model: ' qwen3-vl:8b ' } },
        { id: 'a-empty', name: 'Empty', capabilities: [], llm: { provider: 'openai-compatible', model: '' } },
      ]),
      options: {},
    });

    expect(runtime.getAgentLlmModel('a-x')).toBe('qwen3-vl:8b');
    // Trimmed equality → the dedicated client serves both (same model value).
    expect(runtime.getAgentLlmModel('a-y')).toBe('qwen3-vl:8b');
    // Empty-string model is NOT a declaration — shared default.
    expect(runtime.getAgentLlmModel('a-empty')).toBe('ac-decision-v4:latest');
  });

  it('no declared models and no null agents → legacy resolution unchanged (no llmPerAgent)', async () => {
    const builder = builderWith('ac-decision-v4:latest');
    const { runtime, llm } = await builder.build({
      id: 'sim-f3-4',
      scenario: scenarioOf([
        { id: 'a-1', name: 'A1', capabilities: [], llm: { provider: 'openai-compatible' } },
        { id: 'a-2', name: 'A2', capabilities: [] },
      ]),
      options: {},
    });

    expect(llm.model).toBe('ac-decision-v4:latest');
    expect(runtime.getAgentLlmModel('a-1')).toBe('ac-decision-v4:latest');
    expect(runtime.getAgentLlmModel('a-2')).toBe('ac-decision-v4:latest');
  });

  it('R5-F12: declared-model drift warns ONCE per (agent, declared, deployed) combo', async () => {
    const warnLines: string[] = [];
    setLogSink((level, message) => {
      if (level === 'warn') warnLines.push(message);
    });
    try {
      const builder = builderWith('ac-decision-v4:latest');
      const scenario = () => scenarioOf([
        { id: 'a-drift-f12', name: 'Drift', capabilities: [], llm: { provider: 'openai-compatible', model: 'stale-ollama:7b' } },
        // Declared == deployed → no drift, no warn.
        { id: 'a-nodrift-f12', name: 'NoDrift', capabilities: [], llm: { provider: 'openai-compatible', model: 'ac-decision-v4:latest' } },
      ]);
      await builder.build({ id: 'sim-f12-1', scenario: scenario(), options: {} });
      // A rebuild (resume / env-session re-assembly) must NOT re-warn.
      await builder.build({ id: 'sim-f12-2', scenario: scenario(), options: {} });

      const driftWarns = warnLines.filter(
        line => line.includes('Model drift normalized') && line.includes('a-drift-f12'),
      );
      expect(driftWarns).toHaveLength(1);
      expect(driftWarns[0]).toContain('stale-ollama:7b');
      expect(driftWarns[0]).toContain('ac-decision-v4:latest');
      expect(driftWarns[0]).toContain('LLM_MODEL_STRICT');
      expect(warnLines.filter(line => line.includes('a-nodrift-f12'))).toHaveLength(0);
    } finally {
      setLogSink(null);
    }
  });

  it('R5-F12: no LLM_MODEL pinned → no normalization, no drift warn', async () => {
    const warnLines: string[] = [];
    setLogSink((level, message) => {
      if (level === 'warn') warnLines.push(message);
    });
    try {
      const builder = new SimRuntimeBuilder(
        { llmProvider: 'openai-compatible', llmBaseUrl: 'http://localhost:8000/v1' },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      await builder.build({
        id: 'sim-f12-3',
        scenario: scenarioOf([
          { id: 'a-free-f12', name: 'Free', capabilities: [], llm: { provider: 'openai-compatible', model: 'any-model:1b' } },
        ]),
        options: {},
      });
      expect(warnLines.filter(line => line.includes('a-free-f12'))).toHaveLength(0);
    } finally {
      setLogSink(null);
    }
  });
});
