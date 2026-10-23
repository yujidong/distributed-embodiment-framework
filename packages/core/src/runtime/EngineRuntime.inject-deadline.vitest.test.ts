/**
 * @vitest-environment node
 *
 * T-023 (DevLoop R17) — bounded event-injection delivery.
 *
 * `injectEvent(input, { deliveryDeadlineMs })` bounds the agent-delivery
 * wait: the physical write, flow evaluation and listeners are applied
 * synchronously, but the HTTP-facing caller gets an honest
 * `decisionPending: true` result past the bound while the LLM decisions
 * land in the snapshot asynchronously (the alternative — holding the route
 * for the full per-agent LLM latency — blocked for 20+ s on real runs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import type { LLMClient } from '@active-collaboration/llm-integration';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

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

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inject-deadline-'));
  tempDirs.push(dir);
  return dir;
}

/** Mock LLM whose chat() takes a real timer — the slow-decision stand-in. */
class SlowMockLLMClient {
  static readonly MODEL = 'slow-mock-model';

  private async delayed(): Promise<{ content: string; model: string; usage?: unknown }> {
    await new Promise(resolve => setTimeout(resolve, 80));
    return {
      content: JSON.stringify({ decision: 'independent', reasoning: 'slow but deliberate' }),
      model: SlowMockLLMClient.MODEL,
    };
  }

  // The assessor may call either entrypoint (see EngineRuntime.vitest
  // MockLLMClient) — both take the same real-timer delay.
  async chat(): Promise<{ content: string; model: string; usage?: unknown }> {
    return this.delayed();
  }

  async quickChat(): Promise<{ content: string; model: string; usage?: unknown }> {
    return this.delayed();
  }

  emitLog(): void { /* unused */ }
  setLoggingCallback(): void { /* unused */ }
  setContextProvider(): void { /* unused */ }
  getProviderName(): string { return 'mock'; }
  getModel(): string { return SlowMockLLMClient.MODEL; }
  async healthCheck(): Promise<boolean> { return true; }
}

function scenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'inject-deadline-test', name: 'Inject Deadline Test' },
    zones: [
      { id: 'zone-a', name: 'Zone A', adjacentZoneIds: [] },
    ],
    devices: [
      { id: 'temp-sensor-a', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: 'zone-a' },
      { id: 'fan-a', type: 'ceiling-fan', capabilities: ['ventilation', 'turn-on', 'turn-off'], zoneId: 'zone-a' },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        // Ventilation-only actuator agent: it HAS actuator coverage of
        // zone-a (so the sensor-only auto-initiate path is skipped) but NOT
        // the temperature capabilities the event needs — the precheck falls
        // through to the LLM assessment, which the SlowMockLLMClient delays.
        capabilities: ['ventilation'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a', 'fan-a'],
      },
    ],
    events: [],
  });
}

function makeRuntime(llm: LLMClient): EngineRuntime {
  const runtime = new EngineRuntime(scenario(), {
    llmClient: llm,
    trajectoryDir: makeTempDir(),
    autoInitiateAC: false,
  });
  runtimes.push(runtime);
  return runtime;
}

describe('EngineRuntime.injectEvent delivery deadline (T-023)', () => {
  it('returns decisionPending past the bound while the decision lands later', async () => {
    const runtime = makeRuntime(new SlowMockLLMClient() as unknown as LLMClient);

    const result = await runtime.injectEvent(
      {
        type: 'temperature-spike',
        zoneId: 'zone-a',
        parameter: 'temperature',
        value: 35,
        // Explicit requirements the ventilation-only agent cannot cover —
        // the precheck falls through to the (delayed) LLM assessment, which
        // is exactly the slow-decision case the deadline bounds.
        requiredCapabilities: ['temperature-control', 'emergency-response'],
      },
      { deliveryDeadlineMs: 10 },
    );

    // The honest early result: the physical write is applied, the eventId
    // and target agents are known, and the decision is explicitly pending.
    expect(result.decisionPending).toBe(true);
    expect(result.parameter).toBe('temperature');
    expect(result.value).toBe(35);
    expect(result.targetAgentIds).toEqual(['sensor-agent']);
    expect(runtime.getSnapshot().zones.find(z => z.id === 'zone-a')?.parameters.temperature)
      .toBe(35);

    // The delivery continues in the background — the decision eventually
    // lands in the snapshot (and inflightEventId correlation was cleaned).
    await new Promise(resolve => setTimeout(resolve, 200));
    const decisions = runtime.getSnapshot().recentDecisions
      .filter(d => d.agentId === 'sensor-agent');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0]!.eventId).toBe(result.eventId);
    // No unhandled rejection leaked: the runtime is still usable.
    await runtime.step(1);
  });

  it('no deadline (default): waits for the full delivery, no decisionPending flag', async () => {
    const runtime = makeRuntime(new SlowMockLLMClient() as unknown as LLMClient);

    const result = await runtime.injectEvent({
      type: 'temperature-spike',
      zoneId: 'zone-a',
      parameter: 'temperature',
      value: 34,
    });

    expect(result.decisionPending).toBeUndefined();
    expect(result.targetAgentIds).toEqual(['sensor-agent']);
    expect(runtime.getSnapshot().recentDecisions
      .filter(d => d.agentId === 'sensor-agent' && d.eventId === result.eventId).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('a deadline larger than the delivery behaves like the awaited path', async () => {
    const runtime = makeRuntime(new SlowMockLLMClient() as unknown as LLMClient);

    const result = await runtime.injectEvent(
      { type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 33 },
      { deliveryDeadlineMs: 5_000 },
    );

    expect(result.decisionPending).toBeUndefined();
    expect(runtime.getSnapshot().recentDecisions.length).toBeGreaterThanOrEqual(1);
  });
});
