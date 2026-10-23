/**
 * 分层追平（粗精度快进）— world-session catch-up 的两层计划：
 *
 *   缺口 > catchUpCoarseMinGapSimSec（默认 1 天）时，目标前
 *   catchUpPreciseTailSimSec（默认 1 小时）以外的远旧区段走 core
 *   advanceTo 的 coarse 通道（大步长 + 粗物理子步），近段保持 observed
 *   全精度。due 时刻逐一如实触发是 core 层钉住的等价臂实质
 *   （EngineRuntime.coarse-advance.vitest.test.ts）；本文件钉 SERVICE 层：
 *
 *   (a) 3 天积压：分层追平落到目标、due 序列（事件 id+时刻、flow 运行
 *       时刻、occupancy）与「粗推禁用」对照组逐一相符，物理子步数 ≫4×
 *       缩减，温度读数在文档化容差内；
 *   (b) catchUpProgress 透出：后台追平进行中 statusOf 带
 *       catchUpProgress（coarse → precise 相位），完成后消失；
 *   (c) min-gap 闸门：缺口低于阈值时粗推层不启用（全程全精度，物理
 *       子步数 ≈ 缺口）。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScenarioDefinition } from '@active-collaboration/core';
import type { FlowRunRecord } from '@active-collaboration/core';

import { SimulationRegistry } from './simulation-registry.js';
import type { SimulationRecord } from './simulation-registry.js';
import { WorldSessionService } from './world-session.js';
import type { WorldSessionDeps } from './world-session.js';

const DAY = 86_400;
const RATE = 60; // sim-sec per wall-sec（注入时钟，墙钟不走）

const tempDirs: string[] = [];
const registries: SimulationRegistry[] = [];
const services: WorldSessionService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const registry of registries.splice(0)) registry.stopAll();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 多天 due 密度：每日 occupancy 边界 + 周期/日锚 flow + 跨日事件。 */
function backlogScenario(): ScenarioDefinition {
  return {
    version: '1.0',
    meta: { id: 'catchup-coarse', name: 'Catch-up Coarse Lab' },
    zones: [
      {
        id: 'zone-a', name: 'Zone A',
        adjacentZoneIds: ['zone-b'],
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22, humidity: 45 },
      },
      {
        id: 'zone-b', name: 'Zone B',
        adjacentZoneIds: ['zone-a'],
        bounds: { minX: 12, maxX: 22, minY: 0, maxY: 10 },
        baseline: { temperature: 22 },
        occupantSchedule: { count: 8, startSimTimeSec: 600, endSimTimeSec: 2400 },
      },
    ],
    devices: [
      {
        id: 'temp-sensor-a', name: 'Sensor A', type: 'temperature-sensor',
        capabilities: ['temperature-reading'], zoneId: 'zone-a', binding: 'sim://temp-sensor-a',
      },
      {
        id: 'hvac-b', name: 'HVAC B', type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off', 'set-temperature'],
        zoneId: 'zone-b', binding: 'sim://hvac-b',
      },
    ],
    agents: [{
      id: 'lab-agent', name: 'Lab Agent', capabilities: ['temperature-monitoring', 'temperature-control'],
      managesZoneIds: ['zone-b'], boundDeviceIds: ['hvac-b'],
    }],
    events: [
      { id: 'evt-d0', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 33, atSimTimeSec: 50 },
      { id: 'evt-d2', type: 'temperature-spike', zoneId: 'zone-a', parameter: 'temperature', value: 31, atSimTimeSec: 2 * DAY + 100 },
    ],
    flows: [
      {
        id: 'flow-periodic', name: 'Periodic cooling', enabled: true,
        trigger: { kind: 'schedule', everySimSec: 600 },
        plan: { goal: 'Cool zone B', nodes: [{ id: 'cool', capability: 'cooling' }] },
      },
      {
        id: 'flow-tod', name: 'Daily at 1500', enabled: true,
        trigger: { kind: 'schedule', atTimeOfDaySec: 1500 },
        plan: { goal: 'Daily cool', nodes: [{ id: 'cool', capability: 'cooling' }] },
      },
    ],
  } as unknown as ScenarioDefinition;
}

function makeArm(
  envId: string,
  nowRef: { now: number },
  deps: Partial<WorldSessionDeps>,
  onSessionCreated?: (record: SimulationRecord) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'world-session-coarse-'));
  tempDirs.push(dir);
  const registry = new SimulationRegistry({}, dir);
  registries.push(registry);
  const service = new WorldSessionService({
    registry,
    scenarioOfEnv: () => backlogScenario(),
    envOwnerIdOf: () => undefined,
    obligationsOf: () => ({ hassBound: false, actuationAgreement: false }),
    nowMs: () => nowRef.now,
    simPerWallSec: RATE,
    attachDriver: false,
    idleGraceMs: 60_000,
    ...(onSessionCreated !== undefined ? { onSessionCreated } : {}),
    ...deps,
  });
  services.push(service);
  return { registry, service, simId: `sim-${envId}-world-session` };
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return predicate();
}

describe('world session 分层追平（粗精度快进）', () => {
  it('(a) 3 天积压：分层追平与全程全精度对照组的 due 序列逐一相符，物理子步 ≫4× 缩减', { timeout: 300_000 }, async () => {
    const TARGET = 3 * DAY;
    // 对照组先行：min-gap 拉到不可能，粗推层不启用 —— catch-up 全程
    // observed 全精度（R30 既有语义）。catchUpSyncWaitMs 拉高让 targetFor
    // 同步等完整个追平（默认 10s 上限会让 3 天全精度追平进后台链）。
    const nowPrecise = { now: 0 };
    const preciseArm = makeArm('env-precise', nowPrecise, {
      catchUpCoarseMinGapSimSec: Number.MAX_SAFE_INTEGER,
      catchUpSyncWaitMs: 300_000,
    });
    await preciseArm.service.observe('env-precise');
    const preciseRecord = preciseArm.registry.get(preciseArm.simId)!;
    const anchor = preciseRecord.runtime.getSimStartEpochMs();
    const t0 = JSON.parse(JSON.stringify(preciseRecord.runtime.exportWorldState()));
    const preciseFlows: FlowRunRecord[] = [];
    preciseRecord.runtime.onFlowRun(record => preciseFlows.push(record));
    nowPrecise.now = anchor + (TARGET / RATE) * 1000;
    await preciseArm.service.targetFor('env-precise');
    expect(preciseRecord.runtime.getSimTimeSec()).toBe(TARGET);

    // 分层组：共享同一 t=0 锚（P1 时钟锚纪律），默认旋钮 —— 3 天缺口
    // 触发粗推层（目标前 3600s 尾部保持全精度）。
    const nowCoarse = { now: 0 };
    const coarseArm = makeArm('env-coarse', nowCoarse, { catchUpSyncWaitMs: 300_000 }, record => {
      record.runtime.restoreWorldState(t0);
    });
    await coarseArm.service.observe('env-coarse');
    const coarseRecord = coarseArm.registry.get(coarseArm.simId)!;
    expect(coarseRecord.runtime.getSimStartEpochMs()).toBe(anchor);
    const coarseFlows: FlowRunRecord[] = [];
    coarseRecord.runtime.onFlowRun(record => coarseFlows.push(record));
    nowCoarse.now = anchor + (TARGET / RATE) * 1000;
    await coarseArm.service.targetFor('env-coarse');
    expect(coarseRecord.runtime.getSimTimeSec()).toBe(TARGET);

    // due 保真：事件 id + 触发时刻逐一相符。
    const firedOf = (record: SimulationRecord) =>
      record.runtime.getSnapshot().scheduledEvents
        .filter(e => e.fired)
        .map(e => ({ id: e.id, at: e.firedAtSimTimeSec }));
    expect(firedOf(coarseRecord)).toEqual(firedOf(preciseRecord));
    expect(firedOf(coarseRecord)).toEqual([
      { id: 'evt-d0', at: 50 },
      { id: 'evt-d2', at: 2 * DAY + 100 },
    ]);

    // flow 运行序列（flowId + 触发时刻）逐一相符：周期 flow 3 天 × 144 次
    // + 日锚 3 次（actuation 带出的 effect-check due 若发散会挪动后续运行）。
    const flowProjection = (runs: FlowRunRecord[]) =>
      runs.map(run => ({ flowId: run.flowId, at: run.triggerEvaluation?.simTimeSec, status: run.status }));
    expect(flowProjection(coarseFlows)).toEqual(flowProjection(preciseFlows));
    expect(preciseFlows.filter(r => r.flowId === 'flow-periodic').length).toBe(432);
    expect(preciseFlows.filter(r => r.flowId === 'flow-tod').length).toBe(3);

    // occupancy 边界逐日触发（终点在 depart 之后 → 0）。
    expect(coarseRecord.runtime.getSnapshot().zones.find(z => z.id === 'zone-b')?.occupancy).toBe(0);
    expect(preciseRecord.runtime.getSnapshot().zones.find(z => z.id === 'zone-b')?.occupancy).toBe(0);

    // 物理子步：对照组 ≈ 缺口（dt=1），分层组 ≈ 粗段/10 + 精尾（≥8× 缩减）。
    const preciseSteps = preciseRecord.runtime.getPhysicsStepCount();
    const coarseSteps = coarseRecord.runtime.getPhysicsStepCount();
    expect(preciseSteps).toBeGreaterThanOrEqual(TARGET - 1000);
    expect(coarseSteps).toBeLessThanOrEqual(Math.ceil(preciseSteps / 8));

    // 容差：温度读数非逐位一致，但在文档化界限内（§8.4 LOD 类）。
    const tempOf = (record: SimulationRecord) =>
      (record.runtime.getSnapshot().zones.find(z => z.id === 'zone-a')?.parameters as Record<string, number>)
        .temperature;
    expect(Math.abs(tempOf(coarseRecord) - tempOf(preciseRecord))).toBeLessThan(0.5);
  });

  it('(b) 后台追平进行中 statusOf 透出 catchUpProgress（coarse 相位），完成后消失', { timeout: 120_000 }, async () => {
    const TARGET = 30 * DAY; // 足够大，追平必然越过同步上限进后台
    const now = { now: 0 };
    const arm = makeArm('env-progress', now, { catchUpSyncWaitMs: 50 });
    await arm.service.observe('env-progress');
    const record = arm.registry.get(arm.simId)!;
    const anchor = record.runtime.getSimStartEpochMs();
    now.now = anchor + (TARGET / RATE) * 1000;

    await arm.service.targetFor('env-progress'); // 50ms 同步上限后返回
    // 后台链仍在跑：视图带 catchUpProgress（相位 coarse，currentSimSec 前进）。
    const seen = await until(() => {
      const progress = arm.service.statusOf('env-progress')?.catchUpProgress;
      return progress !== undefined && progress.phase === 'coarse' && progress.targetSimSec === TARGET;
    }, 10_000);
    expect(seen).toBe(true);
    const progress = arm.service.statusOf('env-progress')!.catchUpProgress!;
    expect(progress.currentSimSec).toBeGreaterThan(0);
    expect(progress.currentSimSec).toBeLessThan(TARGET);

    // 追平完成：进度消失，世界落在目标。
    expect(await until(() => record.runtime.getSimTimeSec() >= TARGET, 90_000)).toBe(true);
    expect(await until(() => arm.service.statusOf('env-progress')?.catchUpProgress === undefined, 10_000))
      .toBe(true);
  });

  it('(c) 缺口低于 min-gap 阈值时粗推层不启用（全程全精度）', { timeout: 120_000 }, async () => {
    const TARGET = 2 * DAY;
    const now = { now: 0 };
    const arm = makeArm('env-gate', now, {
      catchUpCoarseMinGapSimSec: 200_000,
      catchUpSyncWaitMs: 120_000,
    });
    await arm.service.observe('env-gate');
    const record = arm.registry.get(arm.simId)!;
    const anchor = record.runtime.getSimStartEpochMs();
    now.now = anchor + (TARGET / RATE) * 1000;
    await arm.service.targetFor('env-gate');
    expect(record.runtime.getSimTimeSec()).toBe(TARGET);
    // 全精度：物理子步 ≈ 缺口（dt=1），due 照常触发（evt-d2 在 2*DAY+100，
    // 目标之外不触发）。
    expect(record.runtime.getPhysicsStepCount()).toBeGreaterThanOrEqual(TARGET - 1000);
    const fired = record.runtime.getSnapshot().scheduledEvents.filter(e => e.fired).map(e => e.id);
    expect(fired).toEqual(['evt-d0']);
  });
});
