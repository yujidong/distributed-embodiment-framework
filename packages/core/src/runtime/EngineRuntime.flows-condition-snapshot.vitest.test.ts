/**
 * EngineRuntime — post-write condition evaluation (R40-C1).
 *
 * The R39 live probe's starvation finding: an injected parameter write was
 * only observed by condition flows at the NEXT onTick — after the agent
 * channel (awaited in the same injection) had the chance to act on the very
 * same parameter. When an agent's response clears the parameter (kitchen
 * smoke → rangehood), the condition's edge is never observed and the flow
 * starves forever.
 *
 * The fix: a post-write snapshot point — condition flows evaluate right
 * after the physical write and BEFORE agent fan-out (same evaluator, same
 * edge/hysteresis/cooldown state as onTick). These tests characterize the
 * new contract:
 * 1. a threshold-crossing injection fires the condition flow AT the
 *    injection (deterministically, no tick required);
 * 2. the fired flow does not double-fire at the next tick (shared state);
 * 3. a below-threshold injection fires nothing and stays armed.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FlowDefinition } from '../flows/index.js';
import type { FlowRunRecord } from '../flows/index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

function scenarioJSON(flows: FlowDefinition[]): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { id: 'runtime-condition-snapshot-test', name: 'Runtime Condition Snapshot Test' },
    zones: [
      { id: 'kitchen', name: '厨房', adjacentZoneIds: [], baseline: { smoke: 0.05 } },
    ],
    devices: [
      {
        id: 'rangehood', type: 'range-hood',
        capabilities: ['turn-on', 'turn-off'], zoneId: 'kitchen',
      },
    ],
    agents: [
      {
        id: 'kitchen-agent', name: 'Kitchen Agent',
        capabilities: ['turn-on'],
        managesZoneIds: ['kitchen'], boundDeviceIds: ['rangehood'],
      },
    ],
    events: [],
    flows,
  };
}

function smokeExhaustFlow(): FlowDefinition {
  return {
    id: 'kitchen-smoke-exhaust',
    name: '厨房烟雾自动排风',
    enabled: true,
    trigger: {
      kind: 'condition',
      zoneId: 'kitchen',
      conditions: [{ path: 'smoke', op: '>', value: 0.45 }],
      cooldownSimSec: 300,
    },
    plan: {
      goal: '排掉厨房烟雾',
      nodes: [{ id: 'n1', capability: 'turn-on', deviceId: 'rangehood' }],
    },
  } as FlowDefinition;
}

const runtimes: EngineRuntime[] = [];

function makeRuntime(flows: FlowDefinition[]): EngineRuntime {
  const runtime = new EngineRuntime(loadScenarioFile(scenarioJSON(flows)));
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) {
    runtimes.pop()!.stop();
  }
});

describe('EngineRuntime — post-write condition evaluation (R40-C1)', () => {
  it('a threshold-crossing injection fires the condition flow AT the injection (R99 starvation counterexample)', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([smokeExhaustFlow()]);
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'smoke-detected', zoneId: 'kitchen', value: 0.75, severity: 'critical' });

    // Pre-fix this is 0 — the condition only evaluated at the next onTick,
    // by which time the agent channel may have cleared the parameter.
    expect(flowRuns).toHaveLength(1);
    expect(flowRuns[0].triggerKind).toBe('condition');
    expect(flowRuns[0].flowId).toBe('kitchen-smoke-exhaust');
  });

  it('the snapshot fire is not double-counted at the next tick (shared edge/cooldown state)', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([smokeExhaustFlow()]);
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'smoke-detected', zoneId: 'kitchen', value: 0.75, severity: 'critical' });
    await runtime.step(1);
    // Still exactly one run — the snapshot point and onTick share the same
    // condition state (edge memory + cooldown).
    expect(flowRuns).toHaveLength(1);
  });

  it('a below-threshold injection fires nothing and stays armed', async () => {
    const flowRuns: FlowRunRecord[] = [];
    const runtime = makeRuntime([smokeExhaustFlow()]);
    runtime.onFlowRun(record => flowRuns.push(record));

    await runtime.injectEvent({ type: 'smoke-detected', zoneId: 'kitchen', value: 0.2, severity: 'low' });
    expect(flowRuns).toHaveLength(0);

    // Armed: the NEXT crossing (above threshold) fires — the earlier
    // below-threshold observation seeded the edge memory with false.
    await runtime.injectEvent({ type: 'smoke-detected', zoneId: 'kitchen', value: 0.6, severity: 'medium' });
    expect(flowRuns).toHaveLength(1);
  });
});
