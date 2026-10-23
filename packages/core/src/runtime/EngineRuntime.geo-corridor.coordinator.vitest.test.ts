/**
 * @vitest-environment node
 *
 * R45-P1 integration — the nan-load-gap cross-district dispatch chain on a
 * compact R45-shaped world (docs/devloop-r45-realistic-report.md §2.4):
 *
 *  1. Geo-corridor ranking: among capability-equal substation keepers, the
 *     host zone's keeper ranks first (属地), the declared support corridor
 *     (Bao'an↔Nanshan) ranks above non-adjacent districts (走廊 > 远区) —
 *     the proposal partner ORDER must reflect it.
 *  2. 市级点将 not short-circuited: city-energy (decisionPolicy.role
 *     'coordinator') holding the Nanshan generator is NOT precheck
 *     Type-A'd into handle_independently — the LLM lane decides and the
 *     cross-zone collaboration is actually initiated.
 *  3. Executors keep the deterministic Type-A short-circuit (role absent).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { EventType, type SystemEvent } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

class ScriptedLLMClient {
  static readonly MODEL = 'scripted-model';
  constructor(private readonly answer: string) {}

  getProviderName(): string {
    return 'scripted';
  }

  getModel(): string {
    return ScriptedLLMClient.MODEL;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  setLoggingCallback(_callback: unknown): void {}
  setContextProvider(_provider: unknown): void {}

  async quickChat(): Promise<{ content: string; model: string; usage: Record<string, number> }> {
    return {
      content: this.answer,
      model: ScriptedLLMClient.MODEL,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }

  async chat(params: { messages: Array<{ role: string; content: string }> }) {
    return this.quickChat();
  }
}

/**
 * Compact R45 world: the real corridor (nan↔bao, yan↔bao only) + a far
 * district (luo). city-energy mirrors the real binding — bao generators ×2
 * + the nan generator (the exact R45 §2.4 configuration that used to turn
 * the dispatcher into an executor).
 */
function r45MiniScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'r45-p1-test', name: 'R45 P1 Cross-District Dispatch' },
    zones: [
      { id: 'nan-substation', name: '南山变电站', adjacentZoneIds: ['bao-substation'] },
      { id: 'bao-substation', name: '宝安变电站', adjacentZoneIds: ['nan-substation', 'yan-substation'] },
      { id: 'yan-substation', name: '盐田变电站', adjacentZoneIds: ['bao-substation'] },
      { id: 'luo-substation', name: '罗湖变电站', adjacentZoneIds: [] },
    ],
    devices: [
      { id: 'nan-substation-g1', type: 'generator', capabilities: ['turn-on', 'load-management'], zoneId: 'nan-substation', role: 'actuator' },
      { id: 'bao-substation-g1', type: 'generator', capabilities: ['turn-on', 'load-management'], zoneId: 'bao-substation', role: 'actuator' },
      { id: 'bao-substation-g2', type: 'generator', capabilities: ['turn-on', 'load-management'], zoneId: 'bao-substation', role: 'actuator' },
      { id: 'yan-substation-g1', type: 'generator', capabilities: ['turn-on', 'load-management'], zoneId: 'yan-substation', role: 'actuator' },
      { id: 'luo-substation-g1', type: 'generator', capabilities: ['turn-on', 'load-management'], zoneId: 'luo-substation', role: 'actuator' },
    ],
    agents: [
      {
        id: 'city-energy',
        name: '市电网调度中心',
        capabilities: ['power-monitoring', 'energy-monitoring', 'turn-on', 'turn-off', 'load-management'],
        managesZoneIds: ['nan-substation', 'bao-substation', 'yan-substation', 'luo-substation'],
        boundDeviceIds: ['bao-substation-g1', 'bao-substation-g2', 'nan-substation-g1'],
        // R45-P1: dispatcher, not executor — precheck must NOT Type-A it.
        decisionPolicy: { role: 'coordinator' },
      },
      // ADVERSARIAL registration order: far districts first, corridor and
      // host last — insertion order alone would rank luo > yan > bao > nan,
      // so only the geo-corridor factor can produce the asserted order.
      {
        id: 'luo-substation-keeper',
        name: '罗湖·变电站管家',
        capabilities: ['power-monitoring', 'energy-monitoring', 'turn-on', 'turn-off', 'load-management'],
        managesZoneIds: ['luo-substation'],
        boundDeviceIds: ['luo-substation-g1'],
      },
      {
        id: 'yan-substation-keeper',
        name: '盐田·变电站管家',
        capabilities: ['power-monitoring', 'energy-monitoring', 'turn-on', 'turn-off', 'load-management'],
        managesZoneIds: ['yan-substation'],
        boundDeviceIds: ['yan-substation-g1'],
      },
      {
        id: 'bao-substation-keeper',
        name: '宝安·变电站管家',
        capabilities: ['power-monitoring', 'energy-monitoring', 'turn-on', 'turn-off', 'load-management'],
        managesZoneIds: ['bao-substation'],
        boundDeviceIds: ['bao-substation-g1', 'bao-substation-g2'],
      },
      {
        id: 'nan-substation-keeper',
        name: '南山·变电站管家',
        capabilities: ['power-monitoring', 'energy-monitoring', 'turn-on', 'turn-off', 'load-management'],
        managesZoneIds: ['nan-substation'],
        boundDeviceIds: ['nan-substation-g1'],
      },
    ],
    events: [],
  });
}

const COLLABORATE_JSON = JSON.stringify({
  situation: { type: 'emergency', severity: 4, affectedZones: ['nan-substation'], rootCauseHypothesis: 'load gap after transfer', confidence: 0.85 },
  goals: [{ goal: 'cover the Nanshan load gap', priority: 4 }],
  actionPlan: {
    primary: {
      action: 'initiate_ac',
      reasoning: 'Coordinator dispatch: mobilize corridor support (Bao\'an first).',
      collaboration: { partnerCapabilities: ['power-monitoring', 'turn-on'] },
    },
  },
  explanation: { summary: 'Cross-zone dispatch via the adjacent corridor.', factors: [{ name: 'safety', weight: 0.9 }] },
  collaboration: { needed: true, partnerType: 'substation-keeper', reasoning: 'cross-zone generator support' },
  uncertainty: { overall: 0.2, dataQuality: 0.9 },
});

const runtimes: EngineRuntime[] = [];
const tempDirs: string[] = [];

function makeRuntime(llmAnswer: string): { runtime: EngineRuntime; messages: SystemEvent[] } {
  const trajectoryDir = mkdtempSync(join(tmpdir(), 'engine-r45-p1-test-'));
  tempDirs.push(trajectoryDir);
  const messages: SystemEvent[] = [];
  const runtime = new EngineRuntime(r45MiniScenario(), {
    llmClient: new ScriptedLLMClient(llmAnswer) as unknown as LLMClient,
    trajectoryDir,
  } satisfies EngineRuntimeOptions);
  runtime.subscribe(event => messages.push(event), EventType.COLLABORATION_MESSAGE);
  runtimes.push(runtime);
  return { runtime, messages };
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** The nan-load-gap event (mirrors the committed R45 scenario shape). */
function nanLoadGapEvent() {
  return {
    type: 'power-shortage',
    zoneId: 'nan-substation',
    parameter: 'power',
    value: 0.35,
    severity: 'critical' as const,
    requiredCapabilities: ['power-monitoring', 'turn-on', 'energy-monitoring'],
  };
}

/** Proposal targets from one initiator, in emission (ranked) order. */
async function proposalTargetsFrom(
  messages: SystemEvent[],
  initiatorId: string,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targets = messages
      .filter(e => (e.payload as { type?: string; initiatorId?: string }).type === 'ac-proposal')
      .filter(e => (e.payload as { initiatorId?: string }).initiatorId === initiatorId)
      .map(e => (e.payload as { targetAgentId?: string }).targetAgentId)
      .filter((t): t is string => typeof t === 'string');
    // The broadcast is per-partner; wait until the fan-out settles (no new
    // targets for 250ms) or the deadline hits.
    if (targets.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const settled = messages
        .filter(e => (e.payload as { type?: string; initiatorId?: string }).type === 'ac-proposal')
        .filter(e => (e.payload as { initiatorId?: string }).initiatorId === initiatorId)
        .map(e => (e.payload as { targetAgentId?: string }).targetAgentId)
        .filter((t): t is string => typeof t === 'string');
      if (settled.length === targets.length) return settled;
    }
    if (Date.now() >= deadline) return targets;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe('EngineRuntime — R45-P1 cross-district dispatch (nan-load-gap)', () => {
  it('city-energy is not Type-A short-circuited: the LLM lane decides and initiates the cross-zone AC', async () => {
    const { runtime } = makeRuntime(COLLABORATE_JSON);

    const result = await runtime.injectEvent(nanLoadGapEvent());

    const decision = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'city-energy');
    expect(decision).toBeDefined();
    // The precheck self-handling path is gone for the coordinator: the
    // decision came from the LLM and it dispatches (initiate_ac).
    expect(decision!.decisionSource).toBe('llm');
    expect(decision!.decision).toBe('initiate_ac');
    expect(decision!.reasoningCode).not.toBe('precheck.independent');
  });

  it('executor keepers keep the deterministic Type-A short-circuit (role absent — regression guard)', async () => {
    const { runtime } = makeRuntime(COLLABORATE_JSON);

    const result = await runtime.injectEvent(nanLoadGapEvent());

    const keeper = runtime.getSnapshot().recentDecisions
      .find(d => d.eventId === result.eventId && d.agentId === 'nan-substation-keeper');
    expect(keeper).toBeDefined();
    expect(keeper!.decisionSource).toBe('precheck');
    expect(keeper!.decision).toBe('handle_independently');
    expect(keeper!.reasoningCode).toBe('precheck.independent');
  });

  it('geo-corridor ranking: host keeper first, Bao’an corridor above non-adjacent districts', async () => {
    const { runtime, messages } = makeRuntime(COLLABORATE_JSON);

    await runtime.injectEvent(nanLoadGapEvent());
    const targets = await proposalTargetsFrom(messages, 'city-energy');

    // The dispatch reached partners (市级点将 happened).
    expect(targets.length).toBeGreaterThanOrEqual(2);
    // 属性地: the Nanshan keeper (same zone) is ranked first.
    expect(targets[0]).toBe('nan-substation-keeper');
    // 走廊 > 远区: Bao'an (the declared corridor) is the FIRST cross-zone
    // support, above Yan'tian/Luohu (not adjacent to the event zone).
    expect(targets).toContain('bao-substation-keeper');
    const bao = targets.indexOf('bao-substation-keeper');
    for (const far of ['yan-substation-keeper', 'luo-substation-keeper']) {
      if (targets.includes(far)) {
        expect(bao).toBeLessThan(targets.indexOf(far));
      }
    }
  });
});
