/**
 * @vitest-environment node
 *
 * T-601 (DevLoop R26, HO26-F03 + SC26-F01): per-agent `llm: null` is an
 * explicit rule-only opt-out. Mixed world (one llm agent + one authored-null
 * agent + one absent-llm agent) with a SHARED llmClient:
 *
 *   - the null agent gets NO client (llmEnabled false, rule decisions,
 *     zero LLM trajectory rows);
 *   - the absent-llm agent keeps the legacy shared fall-through;
 *   - the llm-block agent keeps the shared client.
 *
 * The four-link drop chain this pins: loader (schema accepts null) →
 * buildAgent (null yields no client BEFORE the shared fallback) → trajectory
 * attribution. The server-side links (store 'null' JSON, bridge, wantsLLM)
 * are pinned in apps/server/src/agent-llm-null.vitest.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

/** Mock client that counts calls — the shared client must serve only the
 * agents that did NOT opt out. */
class CountingLLMClient {
  readonly calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  getProviderName(): string {
    return 'mock';
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  setLoggingCallback(_callback: unknown): void {
    // No-op.
  }

  setContextProvider(_provider: unknown): void {
    // No-op.
  }

  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    this.calls.push(params);
    return {
      content: JSON.stringify({ decision: 'collaborate', reasoning: 'mock' }),
      model: 'mock-model',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

function mixedWorld() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'llm-null-test', name: 'LLM Null Test Scenario' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-a',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'null-agent',
        name: 'Null Agent',
        capabilities: ['temperature-control', 'cooling'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
        // The explicit opt-out under test.
        llm: null,
      },
      {
        id: 'block-agent',
        name: 'Block Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
        llm: { provider: 'openai-compatible', model: 'some-model' },
      },
      {
        id: 'absent-agent',
        name: 'Absent Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('T-601 — per-agent llm:null honored (mixed worlds)', () => {
  it('loader + schema accept llm:null and keep it explicit', () => {
    const scenario = mixedWorld();
    const nullAgent = scenario.agents.find(a => a.id === 'null-agent')!;
    const blockAgent = scenario.agents.find(a => a.id === 'block-agent')!;
    const absentAgent = scenario.agents.find(a => a.id === 'absent-agent')!;
    expect(nullAgent.llm).toBeNull();
    expect(blockAgent.llm).toMatchObject({ provider: 'openai-compatible', model: 'some-model' });
    expect(absentAgent.llm).toBeUndefined();
  });

  it('shared client world: null agent gets NO client, absent keeps the fall-through, block stays on', async () => {
    const trajectoryDir = mkdtempSync(join(tmpdir(), 'llm-null-test-'));
    tempDirs.push(trajectoryDir);
    const shared = new CountingLLMClient();
    const runtime = new EngineRuntime(mixedWorld(), {
      llmClient: shared as unknown as LLMClient,
      trajectoryDir,
    });
    runtimes.push(runtime);

    const agentInfo = new Map(
      runtime.getSnapshot().agents.map(a => [a.id, a] as const),
    );
    // Link 4 of the drop chain: the shared fallback must NOT reach the
    // explicit-null agent.
    expect(agentInfo.get('null-agent')!.llmEnabled).toBe(false);
    expect(agentInfo.get('block-agent')!.llmEnabled).toBe(true);
    // Legacy behavior preserved: absent still falls through to the shared
    // client (only the explicit opt-out is new).
    expect(agentInfo.get('absent-agent')!.llmEnabled).toBe(true);

    // Behavioral half: the null agent decides by rule — never by llm — and
    // leaves zero LLM-attributed trajectory rows, even though the shared
    // client serves the other agents.
    const result = await runtime.injectEvent({
      type: 'heat-wave',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 39,
      severity: 'high',
    });
    await runtime.awaitQuiescent(5000);

    const decisions = runtime.getSnapshot().recentDecisions;
    const nullDecision = decisions.find(d => d.agentId === 'null-agent');
    expect(nullDecision).toBeDefined();
    expect(nullDecision!.decisionSource).not.toBe('llm');

    const lines = readFileSync(runtime.getTrajectoryFilePath()!, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const nullLlmRows = lines.filter(
      l => l.agentId === 'null-agent' && l.decisionSource === 'llm',
    );
    expect(nullLlmRows).toHaveLength(0);
    // The shared client did serve the world (the non-opted-out agents).
    expect(shared.calls.length).toBeGreaterThan(0);
    expect(result.eventId).toBeDefined();
  });

  it('llmPerAgent null entry also opts out (no shared fallback for that agent)', () => {
    const scenario = mixedWorld();
    const runtime = new EngineRuntime(scenario, {
      llmClient: new CountingLLMClient() as unknown as LLMClient,
      llmPerAgent: { 'absent-agent': null },
    });
    runtimes.push(runtime);
    const agentInfo = new Map(
      runtime.getSnapshot().agents.map(a => [a.id, a] as const),
    );
    expect(agentInfo.get('absent-agent')!.llmEnabled).toBe(false);
    expect(agentInfo.get('block-agent')!.llmEnabled).toBe(true);
  });
});
