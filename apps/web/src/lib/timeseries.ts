/**
 * 环境时序缓冲（纯函数）——从 snapshot 流提取各 zone 的环境采样点，
 * 喂给 echarts 折线图；同时从 scheduledEvents 提取已触发事件的
 * markLine 数据。
 *
 * 契约与 lib/replay 的环形缓冲一致：
 * - `appendSnapshot` 对重复尾部（同 tickCount + simTimeSec，REST 轮询与
 *   WS 常投递同一 tick）返回原对象 identity，调用方据此跳过重渲染；
 * - 每个 zone 的采样点 capped（TIMESERIES_CAP），最旧的先丢；
 * - 仿真切换（runtimeId 变化）自动清空重开。
 *
 * x 轴一律是 simTimeSec（仿真秒）。
 */

import type { EngineSnapshot } from '../api/types';

/** 每 zone 采样点上限（≈12 分钟的 1.5s 轮询，与回放缓冲一致）。 */
export const TIMESERIES_CAP = 500;

/** 追踪的环境参数键（snapshot zone.parameters 里的数值键）。 */
export const ENV_METRICS = ['temperature', 'co2', 'humidity', 'occupancy'] as const;
export type EnvMetric = (typeof ENV_METRICS)[number];

/** 一个 zone 在一个仿真时刻的采样（缺失参数不进 values）。 */
export interface EnvSample {
  t: number;
  values: Partial<Record<EnvMetric, number>>;
}

/** 一条事件 markLine：已触发的 scheduled event。 */
export interface EnvMark {
  id: string;
  t: number;
  zoneId: string;
  type: string;
}

export interface EnvTimeseries {
  /** 当前缓冲属于哪个仿真（runtimeId 变化即重置）。 */
  runtimeId: string | null;
  lastTickCount: number;
  lastSimTimeSec: number;
  /** zone 发现顺序（选择器展示顺序）。 */
  zoneIds: string[];
  zoneNames: Record<string, string>;
  /** zoneId → 时序采样（按 t 升序，capped）。 */
  samples: Record<string, EnvSample[]>;
  /** 已触发事件（按发现顺序），用于 markLine。 */
  marks: EnvMark[];
  /** 已收录 mark 的事件 id（去重）。 */
  seenMarkIds: string[];
}

export function createEnvTimeseries(): EnvTimeseries {
  return {
    runtimeId: null,
    lastTickCount: -1,
    lastSimTimeSec: -1,
    zoneIds: [],
    zoneNames: {},
    samples: {},
    marks: [],
    seenMarkIds: [],
  };
}

/**
 * 追加一个 snapshot。重复尾部返回原 identity；runtimeId 不同视为新仿真，
 * 从空缓冲重新开始。
 */
export function appendSnapshot(
  series: EnvTimeseries,
  snapshot: EngineSnapshot,
): EnvTimeseries {
  if (series.runtimeId !== null && series.runtimeId !== snapshot.runtimeId) {
    series = createEnvTimeseries();
  }
  if (
    series.runtimeId === snapshot.runtimeId &&
    series.lastTickCount === snapshot.tickCount &&
    series.lastSimTimeSec === snapshot.simTimeSec
  ) {
    return series;
  }

  const zoneIds = [...series.zoneIds];
  const zoneNames = { ...series.zoneNames };
  const samples: Record<string, EnvSample[]> = { ...series.samples };
  for (const zone of snapshot.zones) {
    if (!zoneIds.includes(zone.id)) zoneIds.push(zone.id);
    if (zone.name) zoneNames[zone.id] = zone.name;
    const values: Partial<Record<EnvMetric, number>> = {};
    for (const metric of ENV_METRICS) {
      const raw = zone.parameters?.[metric];
      if (typeof raw === 'number' && Number.isFinite(raw)) values[metric] = raw;
    }
    const list = [...(samples[zone.id] ?? []), { t: snapshot.simTimeSec, values }];
    samples[zone.id] =
      list.length > TIMESERIES_CAP ? list.slice(list.length - TIMESERIES_CAP) : list;
  }

  // 事件 markLine：新触发的 scheduled event（按 id 去重，跨 snapshot 累积）。
  const seen = new Set(series.seenMarkIds);
  const seenMarkIds = [...series.seenMarkIds];
  const marks = [...series.marks];
  for (const event of snapshot.scheduledEvents) {
    if (!event.fired || event.atSimTimeSec === undefined || seen.has(event.id)) continue;
    seen.add(event.id);
    seenMarkIds.push(event.id);
    marks.push({
      id: event.id,
      t: event.atSimTimeSec,
      zoneId: event.zoneId,
      type: event.type,
    });
  }

  return {
    runtimeId: snapshot.runtimeId,
    lastTickCount: snapshot.tickCount,
    lastSimTimeSec: snapshot.simTimeSec,
    zoneIds,
    zoneNames,
    samples,
    marks,
    seenMarkIds,
  };
}

/** 一个 zone 某参数的 echarts 序列数据：[simTimeSec, value][]（缺值跳过）。 */
export function metricSeries(
  series: EnvTimeseries,
  zoneId: string,
  metric: EnvMetric,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const sample of series.samples[zoneId] ?? []) {
    const value = sample.values[metric];
    if (value !== undefined) out.push([sample.t, value]);
  }
  return out;
}

/**
 * markLine 数据。传 zoneId 时只保留该 zone 的事件，并裁掉已滚出该 zone
 * 采样窗口（早于首个采样点）的 mark，避免线钉在轴边缘。
 */
export function markLinesFor(series: EnvTimeseries, zoneId?: string): EnvMark[] {
  const minT = zoneId
    ? (series.samples[zoneId]?.[0]?.t ?? Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  return series.marks.filter(
    mark => mark.t >= minT && (zoneId === undefined || mark.zoneId === zoneId),
  );
}
