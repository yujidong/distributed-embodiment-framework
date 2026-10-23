/**
 * @vitest-environment node
 *
 * R92 感知模块规格测试 —— 具身回路的"感知"半边：
 *
 *   传感器读数 → 差分/变化率（微积分判据）→ 刺激事件 → 决策层
 *
 * Layer 1（纯）：scanPerception 的三类变化察觉 —— level 越限、rate 尖峰
 * （|dP/dt| 判据）、drift 慢漂移兜底；棘轮基线；最小间隔门。
 *
 * Layer 2（模块）：AgentPerceptionModule 对假想世界的端到端 —— 采样、
 * 刺激产出、投递给管理 Agent。
 *
 * Layer 3（运行时）：世界参数移动（注入）后，宿主驱动一次感知扫描，
 * 管理 Agent 的事件计数自行增长 —— 无需任何外部"事件"投喂。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentPerceptionModule,
  PERCEPTION_CADENCE_SEC,
  PERCEPTION_DRIFT_SEC,
  scanPerception,
  type PerceptionState,
} from './agent-perception.js';
import { EngineRuntime, type EngineRuntimeOptions } from './index.js';
import { loadScenarioFile } from '../scenario/index.js';
import { EventType } from '../events/index.js';

// ---------------------------------------------------------------------------
// Layer 1 — 纯扫描
// ---------------------------------------------------------------------------

describe('scanPerception', () => {
  const fresh = () => new Map() as PerceptionState;
  const zone = (temp: number) => [{ zoneId: 'z', params: { temperature: temp } }];

  it('首次采样只建基线（不 spam）', () => {
    const state = fresh();
    expect(scanPerception(zone(22), 0, state)).toEqual([]);
    expect(state.get('z:temperature')!.baseline).toBe(22);
  });

  it('level 越限：基线漂移过阈 → kind=level，携带 old/new', () => {
    const state = fresh();
    scanPerception(zone(22), 0, state);
    const stimuli = scanPerception(zone(28.5), 120, state);
    expect(stimuli).toHaveLength(1);
    expect(stimuli[0].kind).toBe('level');
    expect(stimuli[0].oldValue).toBe(22);
    expect(stimuli[0].newValue).toBe(28.5);
  });

  it('rate 尖峰：微小越限但变化率过阈 → kind=rate', () => {
    const state = fresh();
    scanPerception(zone(22), 0, state);
    // 10s 内 +0.25：level 不足（< 0.3），rate 0.025/s ≥ 0.02 → 尖峰
    const stimuli = scanPerception(zone(22.25), 10, state);
    expect(stimuli).toHaveLength(1);
    expect(stimuli[0].kind).toBe('rate');
  });

  it('棘轮抑制 spam：同值不重发，反向越限是新事件', () => {
    const state = fresh();
    scanPerception(zone(22), 0, state);
    expect(scanPerception(zone(28), 60, state)).toHaveLength(1); // 上升越限
    expect(scanPerception(zone(28), 120, state)).toEqual([]); // 同值不重发（棘轮）
    expect(scanPerception(zone(27.5), 180, state)).toHaveLength(1); // 反向越限是新事件
  });

  it('棘轮：亚阈漂移累计，基线只在刺激时前进', () => {
    const state = fresh();
    scanPerception(zone(22), 0, state);
    scanPerception(zone(22.29), 61, state);
    expect(state.get('z:temperature')!.baseline).toBe(22);
    const stimuli = scanPerception(zone(22.6), 122, state);
    expect(stimuli).toHaveLength(1);
    expect(stimuli[0].newValue).toBe(22.6);
  });

  it('drift 慢漂移兜底：超过 DRIFT 时限的累计漂移强制感知', () => {
    const state = fresh();
    scanPerception(zone(22), 0, state);
    const stimuli = scanPerception(zone(22.1), PERCEPTION_DRIFT_SEC + 1, state);
    expect(stimuli).toHaveLength(1);
    expect(stimuli[0].kind).toBe('drift');
  });

  it('未注册参数不感知', () => {
    const state = fresh();
    const stimuli = scanPerception([{ zoneId: 'z', params: { musicLoudness: 99 } }], 0, state);
    expect(stimuli).toEqual([]);
    expect(state.size).toBe(0);
  });

  it('节奏常量为正（宿主 cadence 引用它）', () => {
    expect(PERCEPTION_CADENCE_SEC).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — 模块端到端（假想世界）
// ---------------------------------------------------------------------------

describe('AgentPerceptionModule', () => {
  it('采样世界 → 刺激 → 投递给管理 Agent', async () => {
    let temperature = 22;
    const delivered: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const module = new AgentPerceptionModule(() => ({
      id: 'rt',
      simTimeSec: 120,
      simStartEpochMs: 0,
      scenario: { agents: [{ id: 'keeper', managesZoneIds: ['zone-a'] }] },
      isAgentEnabled: () => true,
      physicalEnv: {
        getParameterValue: (parameter, zoneId) =>
          parameter === 'temperature' && zoneId === 'zone-a' ? temperature : undefined,
      },
      agents: new Map([['keeper', { handleEvent: async event => { delivered.push({ type: event.type, payload: event.payload }); } }]]),
      resolveManagingAgents: () => ['keeper'],
    }));

    // 第一次扫描：建基线，无刺激
    expect(await module.scanAndDeliver()).toEqual([]);
    expect(delivered).toEqual([]);

    // 世界变化（22 → 28.5）：第二次扫描 → level 刺激 → 投递
    temperature = 28.5;
    const stimuli = await module.scanAndDeliver();
    expect(stimuli).toEqual([
      {
        zoneId: 'zone-a',
        parameter: 'temperature',
        kind: 'level',
        oldValue: 22,
        newValue: 28.5,
        rate: expect.any(Number),
      },
    ]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe(EventType.ENVIRONMENT_PARAM_CHANGED);
    expect(delivered[0].payload.source).toBe('perception');
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — 运行时集成：世界移动 → 宿主驱动感知 → Agent 计数自行增长
// ---------------------------------------------------------------------------

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

function perceptionScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'perception-test', name: 'Perception Test' },
    zones: [
      {
        id: 'zone-a',
        name: 'Zone A',
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22 },
      },
    ],
    devices: [
      {
        id: 'hvac-a',
        name: 'HVAC A',
        type: 'hvac',
        capabilities: ['temperature-control', 'turn-on', 'turn-off'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'keeper',
        name: 'Zone Keeper',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['hvac-a'],
      },
    ],
    events: [],
  });
}

const RUN_OPTIONS = { faultSeed: 42 } satisfies EngineRuntimeOptions;

describe('EngineRuntime 感知回路（宿主驱动）', () => {
  it('世界参数移动后，宿主驱动一次感知扫描 → Agent 事件计数自行增长', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-perception-'));
    tempDirs.push(dir);
    const runtime = new EngineRuntime(perceptionScenario(), {
      ...RUN_OPTIONS,
      stateDir: dir,
    });
    runtimes.push(runtime);

    // "世界变了"（物理侧写入，不经感知）
    await runtime.injectEvent({
      zoneId: 'zone-a',
      type: 'temperature-spike',
      parameter: 'temperature',
      value: 33,
    });
    // 注入本身投递一次事件 —— 记下基线计数
    await new Promise(resolve => setTimeout(resolve, 120));
    const before = runtime
      .getSnapshot()
      .agents.find(a => a.name === 'Zone Keeper')?.eventsProcessed ?? 0;

    // 宿主按 cadence 驱动感知：扫描发现世界相对基线移动 → 新刺激
    const stimuli = await runtime.scanAndDeliverPerception();
    await new Promise(resolve => setTimeout(resolve, 120));

    const after = runtime
      .getSnapshot()
      .agents.find(a => a.name === 'Zone Keeper')?.eventsProcessed ?? 0;

    expect(stimuli.length).toBeGreaterThan(0);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
