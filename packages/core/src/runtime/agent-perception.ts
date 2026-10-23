/**
 * AgentPerceptionModule — 具身 Agent 的专用感知模块（R92）。
 *
 * 架构立场（embodied-agent）：LLM 做决策，不做感知。真实世界没有"事件"，
 * 只有连续演化的状态；感知的职责是接入传感器读数、察觉**变化**（微积分
 * 判据：越限 / 变化率 / 慢漂移），把变化转译成语义刺激事件，交给决策层。
 *
 *   传感器（physicalEnv 读数）
 *     → 感知模块（差分 + 变化率 + 棘轮基线，仿真时钟驱动）
 *     → 刺激事件（ENVIRONMENT_PARAM_CHANGED，kind=level|rate|drift）
 *     → L1 规则（确定性响应）/ L2 LLM（需要判断力的协作决策）
 *
 * 三类变化察觉（借自机器人/具身智能的监控器分层）：
 * - level  越限：相对基线的绝对变化量过阈（慢而大的变化）
 * - rate   尖峰：|dP/dt| 过阈（快速变化，先于越限被察觉；事件升级 HIGH 优先级）
 * - drift  慢漂移：棘轮基线的累计漂移超过时限未感知（兜底重发）
 *
 * 分布式语义：每个 Agent 只感知自己管理的 zone（本地传感器范围），模块
 * 状态（棘轮基线 + 扫描时基）可随世界检查点迁移（adopt/exportBaselines）。
 *
 * 确定性：所有时刻均为仿真时钟派生；宿主（世界会话驱动器）按 cadence
 * 调用 scanAndDeliver —— 感知是观察侧，从不改变引擎的 tick 调度，因此
 * lazy advance / record-replay 的位精确不变量不受影响。
 */

import { EventPriority, EventType, type SystemEvent } from '../events/index.js';

export interface PerceptionParamPolicy {
  /** level 越限：相对基线的绝对变化量阈值。 */
  delta: number;
  /** rate 尖峰：|dP/dt| 阈值（单位/仿真秒）。 */
  spikeRate: number;
}

/** 感知参数目录：楼宇管家关心的物理量与变化判据。 */
export const PERCEPTION_PARAMS: Readonly<Record<string, PerceptionParamPolicy>> = {
  temperature: { delta: 0.3, spikeRate: 0.02 },
  co2: { delta: 40, spikeRate: 2 },
  humidity: { delta: 3, spikeRate: 0.2 },
  light: { delta: 80, spikeRate: 5 },
  occupancy: { delta: 1, spikeRate: 0.2 },
  smoke: { delta: 5, spikeRate: 0.5 },
  pm2_5: { delta: 8, spikeRate: 1 },
};

/** 感知扫描节奏（仿真秒，宿主 cadence 的建议值）。 */
export const PERCEPTION_CADENCE_SEC = 60;
/** 慢漂移兜底：基线棘轮累计超过该仿真秒未感知，强制以 drift 发出。 */
export const PERCEPTION_DRIFT_SEC = 600;

export type PerceptionStimulusKind = 'level' | 'rate' | 'drift';

export interface PerceptionStimulus {
  zoneId: string;
  parameter: string;
  kind: PerceptionStimulusKind;
  /** 触发时的基线值（上次刺激值）。 */
  oldValue: number;
  /** 当前值。 */
  newValue: number;
  /** 观测变化率（单位/仿真秒，跨最近两次采样）。 */
  rate: number;
}

interface Entry {
  baseline: number;
  lastEmitSimSec: number;
  lastValue: number;
  lastSimSec: number;
}

export type PerceptionState = Map<string, Entry>;

export interface PerceptionZoneSample {
  zoneId: string;
  params: Record<string, number>;
}

/** 运行时世界切面：感知需要的最小只读视图。 */
export interface PerceptionWorld {
  id: string;
  simTimeSec: number;
  /** 仿真起始墙钟 —— 刺激事件时间戳由仿真时钟派生（跨运行逐位一致）。 */
  simStartEpochMs: number;
  scenario: { agents: ReadonlyArray<{ id: string; managesZoneIds?: readonly string[] }> };
  isAgentEnabled(agentId: string): boolean;
  physicalEnv: { getParameterValue(parameter: string, zoneId: string): unknown };
  agents: ReadonlyMap<string, { handleEvent(event: SystemEvent): Promise<void> }>;
  resolveManagingAgents(zoneId: string): string[];
}

/** 纯扫描：差分 + 变化率判据 → 刺激列表（无副作用，便于规格测试）。 */
export function scanPerception(
  samples: readonly PerceptionZoneSample[],
  simSec: number,
  state: PerceptionState,
): PerceptionStimulus[] {
  const stimuli: PerceptionStimulus[] = [];
  for (const sample of samples) {
    for (const [param, rawValue] of Object.entries(sample.params)) {
      const policy = PERCEPTION_PARAMS[param];
      if (!policy || !Number.isFinite(rawValue)) continue;
      const key = `${sample.zoneId}:${param}`;
      const prev = state.get(key);
      if (!prev) {
        // 首次采样：只建基线（新世界不 spam 感知）
        state.set(key, { baseline: rawValue, lastEmitSimSec: simSec, lastValue: rawValue, lastSimSec: simSec });
        continue;
      }
      const dt = simSec - prev.lastSimSec;
      const rate = dt > 0 ? (rawValue - prev.lastValue) / dt : 0;
      const drift = Math.abs(rawValue - prev.baseline);
      const sinceEmit = simSec - prev.lastEmitSimSec;
      let kind: PerceptionStimulusKind | null = null;
      if (sinceEmit >= PERCEPTION_DRIFT_SEC && drift > 0) kind = 'drift';
      else if (drift >= policy.delta) kind = 'level';
      else if (dt >= 5 && Math.abs(rate) >= policy.spikeRate) kind = 'rate';
      if (kind === null) continue;
      stimuli.push({
        zoneId: sample.zoneId,
        parameter: param,
        kind,
        oldValue: prev.baseline,
        newValue: rawValue,
        rate,
      });
      state.set(key, { baseline: rawValue, lastEmitSimSec: simSec, lastValue: rawValue, lastSimSec: simSec });
    }
  }
  return stimuli;
}

/**
 * 感知模块：宿主（世界会话驱动器）按 cadence 调用 scanAndDeliver ——
 * 差分世界状态、产生刺激事件、投递给管理 Agent。投递失败不阻断感知
 * （下一轮扫描会重新差分出该变化）；是否升级 L2/LLM 由决策层判据决定。
 */
export class AgentPerceptionModule {
  private state: PerceptionState = new Map();

  constructor(private readonly world: () => PerceptionWorld) {}

  /** 差分世界参数并投递刺激；返回本次产生的刺激（宿主可记录/观测）。 */
  async scanAndDeliver(): Promise<PerceptionStimulus[]> {
    const world = this.world();
    const samples: PerceptionZoneSample[] = [];
    const zoneIds = new Set<string>();
    for (const def of world.scenario.agents) {
      if (!world.isAgentEnabled(def.id)) continue;
      for (const zid of def.managesZoneIds ?? []) zoneIds.add(zid);
    }
    for (const zoneId of zoneIds) {
      const params: Record<string, number> = {};
      for (const param of Object.keys(PERCEPTION_PARAMS)) {
        try {
          const value = world.physicalEnv.getParameterValue(param, zoneId);
          if (typeof value === 'number' && Number.isFinite(value)) params[param] = value;
        } catch {
          /* 该 zone 不支持该参数 —— 跳过 */
        }
      }
      samples.push({ zoneId, params });
    }

    const stimuli = scanPerception(samples, world.simTimeSec, this.state);
    for (const stim of stimuli) {
      const eventId = `perception:${stim.zoneId}:${stim.parameter}:${stim.kind}:${world.simTimeSec.toFixed(0)}`;
      for (const agentId of world.resolveManagingAgents(stim.zoneId)) {
        const agent = world.agents.get(agentId);
        if (!agent) continue;
        const event: SystemEvent = {
          id: `${eventId}:${agentId}`,
          type: EventType.ENVIRONMENT_PARAM_CHANGED,
          source: 'agent-perception',
          timestamp: new Date(world.simStartEpochMs + world.simTimeSec * 1000),
          payload: {
            parameter: stim.parameter,
            location: stim.zoneId,
            zoneId: stim.zoneId,
            oldValue: stim.oldValue,
            newValue: stim.newValue,
            kind: stim.kind,
            rate: stim.rate,
            eventId,
            source: 'perception',
          },
          priority: stim.kind === 'rate' ? EventPriority.HIGH : EventPriority.NORMAL,
          metadata: { eventId, eventType: 'perception' },
        };
        void agent.handleEvent(event).catch(() => undefined);
      }
    }
    return stimuli;
  }

  /** 世界检查点迁移：采用恢复的感知基线（含扫描时基）。 */
  adopt(
    baselines: ReadonlyArray<readonly [string, number, number, number, number]> | ReadonlyArray<readonly [string, number, number]>,
  ): void {
    this.state.clear();
    for (const entry of baselines) {
      const [key, baseline, lastEmitSimSec, lastValue, lastSimSec] = entry as unknown as [
        string,
        number,
        number,
        number?,
        number?,
      ];
      this.state.set(key, {
        baseline,
        lastEmitSimSec,
        lastValue: lastValue ?? baseline,
        lastSimSec: lastSimSec ?? lastEmitSimSec,
      });
    }
  }

  /** 世界检查点导出：感知基线（供 EngineWorldStateExport.perception）。 */
  exportState(): Array<[string, number, number, number, number]> {
    return [...this.state].map(([key, e]) => [
      key,
      e.baseline,
      e.lastEmitSimSec,
      e.lastValue,
      e.lastSimSec,
    ]);
  }
}
