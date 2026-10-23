/**
 * ReplayTimeline — ReplayBar 控制条上方的 echarts 时间轴：
 *
 * - 回放环形缓冲（lib/replay，store replayBuffer）里首个带 temperature 的
 *   zone 的温度曲线作面积背景，x = 缓冲下标（与原生 range 滑块对齐）；
 * - 烘焙进回放场景的 sim-decision / device-state 事件（atSimTimeSec →
 *   最近的缓冲下标）作散点，点击跳转到该时间点；点折线同样 seek；
 * - 当前播放位置画一条 markLine，随游标移动。
 *
 * 数据推导 `deriveReplayTimeline` 与 option 组装 `buildReplayTimelineOption`
 * 都是纯函数（可单测）；原生滑块保留为 a11y / 兜底，两者经 store 的
 * replayCursor 双向同步。
 */

import { useCallback, useMemo } from 'react';

import type { EngineSnapshot, ScenarioEvent } from '../api/types';
import i18n from '../i18n/config';
import { useAppStore } from '../store/useAppStore';
import {
  chartPalette,
  useECharts,
  type ChartPalette,
  type EChartClickParams,
  type EChartsCoreOption,
} from '../lib/echarts';
import { isReplayEventType } from '../lib/replayEvents';

/** 时间轴上打一个散点的事件类型（Fix-14 烘焙的回放事件；zone-sample 进曲线）。 */
const SCATTER_EVENT_TYPES = new Set(['sim-decision', 'device-state']);

export interface ReplayTimelineEvent {
  /** 事件映射到的缓冲下标。 */
  index: number;
  type: string;
  atSimTimeSec: number;
}

export interface ReplayTimelineData {
  /** 温度曲线取自哪个 zone（无温度数据时为 null）。 */
  zoneId: string | null;
  /** 每缓冲下标的仿真秒（tooltip 用）。 */
  simTimes: number[];
  /** 每缓冲下标的温度（缺失为 null，保留下标对齐）。 */
  temperatures: Array<number | null>;
  events: ReplayTimelineEvent[];
}

/** 事件颜色：决策 = accent，设备状态 = actuator（与散点 datum 的 itemStyle 配合）。 */
export function replayEventColor(palette: ChartPalette, type: string): string {
  return type === 'device-state' ? palette.actuator : palette.accent;
}

export function deriveReplayTimeline(
  buffer: readonly EngineSnapshot[],
  events: readonly ScenarioEvent[],
): ReplayTimelineData {
  const simTimes = buffer.map(snapshot => snapshot.simTimeSec);

  // 温度曲线：第一个（按首个 snapshot 的 zone 顺序）出现过数值温度的 zone。
  let zoneId: string | null = null;
  outer: for (const zone of buffer[0]?.zones ?? []) {
    for (const snapshot of buffer) {
      const z = snapshot.zones.find(item => item.id === zone.id);
      if (typeof z?.parameters?.temperature === 'number') {
        zoneId = zone.id;
        break outer;
      }
    }
  }

  const temperatures = buffer.map(snapshot => {
    if (!zoneId) return null;
    const zone = snapshot.zones.find(item => item.id === zoneId);
    const value = zone?.parameters?.temperature;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });

  // 事件散点：atSimTimeSec → 最近的缓冲下标（缓冲按 simTimeSec 升序）。
  const timelineEvents: ReplayTimelineEvent[] = [];
  for (const event of events) {
    if (!SCATTER_EVENT_TYPES.has(event.type) || !isReplayEventType(event.type)) continue;
    if (typeof event.atSimTimeSec !== 'number' || simTimes.length === 0) continue;
    let best = 0;
    for (let i = 1; i < simTimes.length; i += 1) {
      if (Math.abs(simTimes[i] - event.atSimTimeSec) < Math.abs(simTimes[best] - event.atSimTimeSec)) {
        best = i;
      }
    }
    timelineEvents.push({ index: best, type: event.type, atSimTimeSec: event.atSimTimeSec });
  }

  return { zoneId, simTimes, temperatures, events: timelineEvents };
}

export function buildReplayTimelineOption(
  palette: ChartPalette,
  data: ReplayTimelineData,
  cursor: number,
): EChartsCoreOption {
  const maxIndex = Math.max(data.simTimes.length - 1, 1);
  const lineColor = palette.series[0];
  // 散点落在温度曲线高度上（无温度数据时落底）。
  const fallbackY = data.temperatures.find(t => t !== null) ?? 0;
  const eventAt = (index: number) => data.events.filter(e => e.index === index);
  // Pure function: read translations from the global i18next instance so the
  // chart text tracks the active UI language without a React hook context.
  const t = i18n.getFixedT(i18n.language, 'replay');

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 6, right: 6, top: 8, bottom: 2 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.panelBg,
      borderColor: palette.border,
      textStyle: { color: palette.text, fontSize: 11 },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { value?: [number, number | null] } | undefined;
        const index = first?.value?.[0];
        if (typeof index !== 'number') return '';
        const lines = [`t=${data.simTimes[index] ?? index}s`];
        const temp = data.temperatures[index];
        if (temp !== null && temp !== undefined) {
          lines.push(t('tooltipTemp', { value: Math.round(temp * 10) / 10 }));
        }
        for (const event of eventAt(index)) lines.push(event.type);
        return lines.join('<br/>');
      },
    },
    xAxis: { type: 'value', min: 0, max: maxIndex, show: false },
    yAxis: { type: 'value', show: false, scale: true },
    series: [
      {
        type: 'line',
        name: t('seriesTemp'),
        data: data.temperatures.map((value, index) => [index, value]),
        showSymbol: false,
        silent: false,
        lineStyle: { width: 1, color: lineColor },
        itemStyle: { color: lineColor },
        areaStyle: { color: lineColor, opacity: 0.18 },
        markLine: {
          silent: true,
          symbol: 'none',
          animation: false,
          lineStyle: { color: palette.accent, width: 1.5 },
          label: {
            color: palette.accent,
            fontSize: 10,
            formatter: `t=${data.simTimes[cursor] ?? 0}s`,
            position: 'insideEndTop',
          },
          data: [{ xAxis: cursor }],
        },
      },
      {
        type: 'scatter',
        name: t('seriesEvents'),
        data: data.events.map(event => ({
          value: [event.index, data.temperatures[event.index] ?? fallbackY],
          itemStyle: { color: replayEventColor(palette, event.type) },
        })),
        symbolSize: 9,
        z: 3,
      },
    ],
  };
}

export interface ReplayTimelineProps {
  /** 场景事件（含烘焙的 sim-decision / device-state 回放事件）。 */
  events: readonly ScenarioEvent[];
}

export function ReplayTimeline({ events }: ReplayTimelineProps) {
  const theme = useAppStore(s => s.theme);
  const buffer = useAppStore(s => s.replayBuffer);
  const cursor = useAppStore(s => s.replayCursor);
  const setReplayCursor = useAppStore(s => s.setReplayCursor);

  const data = useMemo(() => deriveReplayTimeline(buffer, events), [buffer, events]);
  const option = useMemo(
    () => buildReplayTimelineOption(chartPalette(theme), data, cursor),
    [theme, data, cursor],
  );

  // 点击散点跳到事件时间点；点击折线 seek 到该下标。store 的
  // setReplayCursor 自带 clamp，滑块随 cursor 同步。
  const handleClick = useCallback(
    (params: EChartClickParams) => {
      if (typeof params.dataIndex !== 'number') return;
      if (params.seriesIndex === 1) {
        const event = data.events[params.dataIndex];
        if (event) setReplayCursor(event.index);
      } else {
        setReplayCursor(params.dataIndex);
      }
    },
    [data, setReplayCursor],
  );

  const chartRef = useECharts(option, theme, handleClick);

  if (buffer.length < 2) return null;
  return (
    <div className="replay-timeline">
      <div ref={chartRef} className="replay-timeline__canvas" data-testid="replay-timeline-canvas" />
    </div>
  );
}
