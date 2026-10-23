/**
 * @vitest-environment node
 *
 * EngineRuntime reputation learning tests (P4-1, no LLM, no network).
 *
 * Scenario: the same two-zone fixture as the fault-injection suite — a
 * sensor agent in zone A and an actuator agent (hvac-b) in zone B. Covers:
 *   - tracker feeding from COLLABORATION_COMPLETED (payload capabilities,
 *     ac-proposal fallback, unrelated events ignored);
 *   - device-operation failure attribution (fault seam DEVICE_ERROR, manual
 *     DEVICE_OPERATION_EXECUTED, no double counting on faulted devices);
 *   - the public surface: getReputation/setReputation, snapshot summary,
 *     toJSON/fromJSON persistence between runtimes;
 *   - negotiator wiring (tracker attached when Layer 2 exists, detached
 *     under reputationEnabled:false).
 *
 * Every runtime is stop()ed after each test — clean shutdown is part of the
 * contract (vitest must exit without dangling handles).
 */

import { describe, it, expect, afterEach } from 'vitest';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { EventPriority, EventType } from '../events/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';

// ---------------------------------------------------------------------------
// Scenario + helpers (mirrors fault-injection.vitest.test.ts)
// ---------------------------------------------------------------------------

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'reputation-test', name: 'Reputation Test Scenario' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', name: 'Zone B', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(options?: EngineRuntimeOptions): EngineRuntime {
  const runtime = new EngineRuntime(twoZoneScenario(), options);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

/** Publish directly on the runtime's bus (in-package test seam). */
function publish(runtime: EngineRuntime, type: EventType, payload: Record<string, unknown>): void {
  const envCenter = (runtime as unknown as {
    envCenter: { eventManager: { publish: (event: unknown) => void } };
  }).envCenter;
  envCenter.eventManager.publish({
    type,
    source: 'reputation-test',
    payload,
    priority: EventPriority.NORMAL,
    metadata: {},
  });
}

/** Publish a completion event shaped like the ACExecutor's. */
function publishACCompleted(
  runtime: EngineRuntime,
  overrides: Record<string, unknown> = {},
): void {
  publish(runtime, EventType.COLLABORATION_COMPLETED, {
    collaborationId: 'ac-1',
    success: true,
    participants: ['sensor-agent', 'actuator-agent'],
    requiredCapabilities: ['cooling'],
    results: {
      goals: [{ id: 'g1', achieved: true }],
      participants: ['sensor-agent', 'actuator-agent'],
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngineRuntime reputation (P4-1)', () => {
  it('starts empty: snapshot exposes the prior score with zero attempts', () => {
    const runtime = makeRuntime();
    const agent = runtime.getSnapshot().agents.find(a => a.id === 'actuator-agent');
    expect(agent).toBeDefined();
    expect(agent!.reputation.overallScore).toBeCloseTo(0.7, 5);
    expect(agent!.reputation.totalAttempts).toBe(0);
    expect(agent!.reputation.topCapabilities).toEqual([]);

    const cell = runtime.getReputation('actuator-agent', 'cooling');
    expect(Array.isArray(cell)).toBe(false);
    if (!Array.isArray(cell)) {
      expect(cell.score).toBeCloseTo(0.7, 5);
      expect(cell.attempts).toBe(0);
    }
  });

  it('learns from COLLABORATION_COMPLETED: participants × requested capabilities', () => {
    const runtime = makeRuntime();
    publishACCompleted(runtime);

    for (const agentId of ['sensor-agent', 'actuator-agent']) {
      const cell = runtime.getReputation(agentId, 'cooling');
      if (!Array.isArray(cell)) {
        expect(cell.attempts).toBe(1);
        expect(cell.successes).toBe(1);
        // one success → (1 + 3.5)/6 = 0.75
        expect(cell.score).toBeCloseTo(0.75, 5);
      }
    }
  });

  it('classifies partial outcomes (half the goals achieved) as 0.5 weight', () => {
    const runtime = makeRuntime();
    publishACCompleted(runtime, {
      success: false,
      results: {
        goals: [{ id: 'g1', achieved: true }, { id: 'g2', achieved: false }],
        participants: ['actuator-agent'],
      },
      participants: ['actuator-agent'],
    });

    const cell = runtime.getReputation('actuator-agent', 'cooling');
    if (!Array.isArray(cell)) {
      expect(cell.attempts).toBe(1);
      expect(cell.successes).toBeCloseTo(0.5, 5);
      expect(cell.score).toBeCloseTo(4 / 6, 5); // (0.5 + 3.5) / 6
    }
  });

  it('uses capabilities remembered from the ac-proposal when the completion lacks them', () => {
    const runtime = makeRuntime();
    publish(runtime, EventType.COLLABORATION_MESSAGE, {
      type: 'ac-proposal',
      collaborationId: 'ac-9',
      initiatorId: 'sensor-agent',
      targetAgentId: 'actuator-agent',
      requiredCapabilities: ['temperature-control'],
    });
    publish(runtime, EventType.COLLABORATION_COMPLETED, {
      collaborationId: 'ac-9',
      success: false,
      participants: ['actuator-agent'],
      results: { goals: [{ id: 'g1', achieved: false }] },
    });

    const cell = runtime.getReputation('actuator-agent', 'temperature-control');
    if (!Array.isArray(cell)) {
      expect(cell.attempts).toBe(1);
      expect(cell.failures).toBe(1);
    }
  });

  it('ignores unrelated completion events (no collaborationId)', () => {
    const runtime = makeRuntime();
    publish(runtime, EventType.COLLABORATION_COMPLETED, {
      proposalId: 'prop-1',
      status: 'accepted',
      accepted: true,
    });
    expect(runtime.getReputation('sensor-agent')).toEqual([]);
  });

  it('attributes fault-seam device failures to the managing agent × device capabilities', async () => {
    const runtime = makeRuntime();
    runtime.setDeviceFault('hvac-b', { offline: true });

    const result = await runtime.executeDeviceCommand('hvac-b', 'turn-on');
    expect(result.success).toBe(false);

    // The DEVICE_ERROR at the fault seam counts ONE failed attempt per
    // declared hvac-b capability; the DeviceCommandCoordinator's
    // DEVICE_OPERATION_EXECUTED echo (success:false) is skipped for faulted
    // devices — no double counting.
    for (const capability of ['temperature-control', 'cooling', 'turn-on', 'turn-off']) {
      const cell = runtime.getReputation('actuator-agent', capability);
      if (!Array.isArray(cell)) {
        expect(cell.attempts).toBe(1);
        expect(cell.failures).toBe(1);
        expect(cell.score).toBeCloseTo(3.5 / 6, 5);
      }
    }
    // The sensor agent is unaffected.
    expect(runtime.getReputation('sensor-agent')).toEqual([]);
  });

  it('attributes manual device-operation failures (no fault) via DEVICE_OPERATION_EXECUTED', () => {
    const runtime = makeRuntime();
    publish(runtime, EventType.DEVICE_OPERATION_EXECUTED, {
      agentId: 'actuator-agent',
      deviceId: 'hvac-b',
      commandName: 'setTemperature',
      error: 'compressor stuck',
      success: false,
    });

    const cell = runtime.getReputation('actuator-agent', 'cooling');
    if (!Array.isArray(cell)) {
      expect(cell.attempts).toBe(1);
      expect(cell.failures).toBe(1);
    }
  });

  it('persistence seam: setReputation + JSON round-trip into a fresh runtime', () => {
    const runtime = makeRuntime();
    runtime.setReputation('actuator-agent', 'cooling', { attempts: 10, successes: 9 });
    runtime.setReputation('sensor-agent', 'temperature-reading', { attempts: 4, successes: 1 });

    const json = JSON.parse(JSON.stringify(runtime.getReputationJSON()));
    const restored = makeRuntime();
    restored.loadReputationJSON(json);

    const cell = restored.getReputation('actuator-agent', 'cooling');
    if (!Array.isArray(cell)) {
      expect(cell.attempts).toBe(10);
      expect(cell.successes).toBe(9);
      expect(cell.score).toBeCloseTo((9 + 3.5) / 15, 5);
    }
    const breakdown = restored.getReputation('sensor-agent');
    expect(Array.isArray(breakdown)).toBe(true);
    if (Array.isArray(breakdown)) {
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].capability).toBe('temperature-reading');
    }
  });

  it('snapshot summary reflects learned history (top capabilities by attempts)', () => {
    const runtime = makeRuntime();
    publishACCompleted(runtime);
    publishACCompleted(runtime, { collaborationId: 'ac-2' });

    const agent = runtime.getSnapshot().agents.find(a => a.id === 'actuator-agent');
    expect(agent!.reputation.totalAttempts).toBe(2);
    expect(agent!.reputation.topCapabilities[0]).toMatchObject({
      capability: 'cooling',
      attempts: 2,
    });
    expect(agent!.reputation.topCapabilities[0].score).toBeCloseTo((2 + 3.5) / 7, 5);
  });

  it('attaches the tracker to partner negotiators when Layer 2 exists', () => {
    const runtime = makeRuntime({ llmClient: {} as unknown as LLMClient });
    const agents = (runtime as unknown as {
      agents: Map<string, {
        getDualTriggerACManager: () => {
          getPartnerNegotiator: () => { reputationTracker?: unknown } | null;
        } | undefined;
      }>;
      reputation: unknown;
    });
    const negotiator = agents.agents.get('actuator-agent')
      ?.getDualTriggerACManager()?.getPartnerNegotiator();
    expect(negotiator).not.toBeNull();
    expect((negotiator as { reputationTracker?: unknown }).reputationTracker)
      .toBe(agents.reputation);
  });

  it('reputationEnabled:false leaves negotiators unwired (ablation) but still records', () => {
    const runtime = makeRuntime({
      llmClient: {} as unknown as LLMClient,
      reputationEnabled: false,
    });
    const agents = (runtime as unknown as {
      agents: Map<string, {
        getDualTriggerACManager: () => {
          getPartnerNegotiator: () => { reputationTracker?: unknown } | null;
        } | undefined;
      }>;
    });
    const negotiator = agents.agents.get('actuator-agent')
      ?.getDualTriggerACManager()?.getPartnerNegotiator();
    expect((negotiator as { reputationTracker?: unknown } | null)?.reputationTracker ?? null)
      .toBeNull();

    // Recording continues regardless — persistence/ablation data stays valid.
    publishACCompleted(runtime);
    const cell = runtime.getReputation('actuator-agent', 'cooling');
    if (!Array.isArray(cell)) {
      expect(cell.attempts).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // R40-A2: the platform reputation bridge into meta-cognition (§7.3)
  // -------------------------------------------------------------------------

  /** The agent's live meta-cognition partner-trust face. */
  function partnerTrustOf(runtime: EngineRuntime, agentId: string, partnerId: string) {
    return runtime.getAgent(agentId)
      ?.getDualTriggerACManager()?.getMetaCognition()
      ?.buildContext({ capabilities: [], devices: [] })
      .partnerTrust.find(p => p.partnerId === partnerId);
  }

  it('R40-A2: a completed collaboration pushes partner platform reputation into meta-cognition', () => {
    const runtime = makeRuntime();

    // Before: no platform signal → the partner is not even materialized
    // ("无信号 = 中性 0.5" stays honest).
    expect(partnerTrustOf(runtime, 'sensor-agent', 'actuator-agent')).toBeUndefined();

    publishACCompleted(runtime); // 1 success → platform score (1+3.5)/6 = 0.75

    // After: the sensor agent's meta-cognition carries the actuator's platform
    // reputation. Note the agents' OWN COLLABORATION_COMPLETED handling records
    // the private interaction in parallel (interactionCount 1) — the bridge's
    // contribution is the platformReputation field, which now reads 0.75.
    const trust = partnerTrustOf(runtime, 'sensor-agent', 'actuator-agent');
    expect(trust).toBeDefined();
    expect(trust!.platformReputation).toBeCloseTo(0.75, 3);
    expect(trust!.interactionCount).toBe(1); // 私有经历同步记了一次成功
    // 混合分 = 5/6·0.75 + 1/6·(2/3) ≈ 0.736（收缩混合：两边都在场）。
    expect(trust!.trustScore).toBeCloseTo((5 / 6) * 0.75 + (1 / 6) * (2 / 3), 2);
    // The reverse direction too (the actuator sees the sensor).
    expect(partnerTrustOf(runtime, 'actuator-agent', 'sensor-agent')!.platformReputation)
      .toBeCloseTo(0.75, 3);
  });

  it('R40-A2: loadReputationJSON (persisted rows) also feeds the bridge', () => {
    const runtime = makeRuntime();
    runtime.loadReputationJSON({
      version: 1,
      records: [
        // lastAt 取极大值 → 距 now 的 age=0，证据不衰减。
        { agentId: 'actuator-agent', capability: 'cooling', attempts: 10, successes: 2, failures: 8, lastAt: Number.MAX_SAFE_INTEGER },
      ],
    });

    const trust = partnerTrustOf(runtime, 'sensor-agent', 'actuator-agent');
    expect(trust).toBeDefined();
    // (2 + 3.5) / 15 ≈ 0.367 —— 学坏的平台名声如实传入。
    expect(trust!.platformReputation).toBeCloseTo(5.5 / 15, 3);
  });

  it('R40-A2: reputationEnabled:false skips the bridge too (ablation parity)', () => {
    const runtime = makeRuntime({ reputationEnabled: false });
    publishACCompleted(runtime); // tracker records, but the bridge stays off
    // 私有经历照常落（agent 自己的 COLLABORATION_COMPLETED 处理），但平台
    // 分量必须保持中性 0.5——声誉没有泄漏进元认知。
    const trust = partnerTrustOf(runtime, 'sensor-agent', 'actuator-agent');
    expect(trust).toBeDefined();
    expect(trust!.platformReputation).toBe(0.5);
  });
});
