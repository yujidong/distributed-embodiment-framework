/**
 * ReplayTimeline（ReplayBar echarts 时间轴）——deriveReplayTimeline /
 * buildReplayTimelineOption 纯函数断言；组件层 mock lib/echarts，验证
 * option 组装与「点击散点/折线 → 移动回放游标」的双向同步方向。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioEvent } from '../api/types';
import {
  buildReplayTimelineOption,
  deriveReplayTimeline,
  ReplayTimeline,
} from '../components/ReplayTimeline';
import { useECharts, type ChartPalette } from '../lib/echarts';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';

vi.mock('../lib/echarts', () => ({
  useECharts: vi.fn(() => () => undefined),
  chartPalette: () => ({
    text: '#fff',
    textDim: '#999',
    axisLine: '#333',
    splitLine: '#333',
    panelBg: '#111',
    border: '#333',
    accent: '#4cc2ff',
    ok: '#3fb950',
    danger: '#f2555a',
    actuator: '#f5a524',
    series: ['#f2555a', '#b07cf0', '#2dd4bf', '#4cc2ff', '#f5a524', '#3fb950'],
  }),
}));

const useEChartsMock = vi.mocked(useECharts);

const FAKE_PALETTE = {
  series: ['#f2555a', '#b07cf0', '#2dd4bf', '#4cc2ff', '#f5a524', '#3fb950'],
  accent: '#4cc2ff',
  actuator: '#f5a524',
  panelBg: '#111',
  border: '#333',
  text: '#fff',
} as ChartPalette;

/* eslint-disable @typescript-eslint/no-explicit-any */

function bufferSnapshot(tick: number, simTimeSec: number, temperature: number | null) {
  return makeSnapshot({
    tickCount: tick,
    simTimeSec,
    zones:
      temperature === null
        ? [{ id: 'z1', parameters: {} }]
        : [{ id: 'z1', parameters: { temperature } }],
  });
}

const replayEvent = (id: string, type: string, atSimTimeSec?: number): ScenarioEvent => ({
  id,
  type,
  zoneId: 'z1',
  ...(atSimTimeSec !== undefined ? { atSimTimeSec } : {}),
});

describe('deriveReplayTimeline', () => {
  it('取首个带温度的 zone 作面积背景，x 与缓冲下标对齐', () => {
    const data = deriveReplayTimeline(
      [bufferSnapshot(0, 0, 20), bufferSnapshot(1, 5, 21), bufferSnapshot(2, 10, null)],
      [],
    );
    expect(data.zoneId).toBe('z1');
    expect(data.simTimes).toEqual([0, 5, 10]);
    expect(data.temperatures).toEqual([20, 21, null]);
  });

  it('sim-decision / device-state 事件映射到最近缓冲下标；zone-sample 不进散点', () => {
    const data = deriveReplayTimeline(
      [bufferSnapshot(0, 0, 20), bufferSnapshot(1, 10, 21), bufferSnapshot(2, 20, 22)],
      [
        replayEvent('d1', 'sim-decision', 12),
        replayEvent('s1', 'device-state', 19),
        replayEvent('z1', 'zone-sample', 15),
        replayEvent('o1', 'other-event', 3),
      ],
    );
    expect(data.events).toEqual([
      { index: 1, type: 'sim-decision', atSimTimeSec: 12 },
      { index: 2, type: 'device-state', atSimTimeSec: 19 },
    ]);
  });
});

describe('buildReplayTimelineOption', () => {
  const data = deriveReplayTimeline(
    [bufferSnapshot(0, 0, 20), bufferSnapshot(1, 10, 25)],
    [replayEvent('d1', 'sim-decision', 9), replayEvent('s1', 'device-state', 11)],
  );

  it('温度面积背景 + 事件散点 + 游标 markLine', () => {
    const option = buildReplayTimelineOption(FAKE_PALETTE, data, 1) as any;
    const [line, scatter] = option.series;
    expect(line.type).toBe('line');
    expect(line.areaStyle).toBeDefined();
    expect(line.data).toEqual([
      [0, 20],
      [1, 25],
    ]);
    expect(line.markLine.data).toEqual([{ xAxis: 1 }]);
    expect(line.markLine.label.formatter).toBe('t=10s');
    expect(scatter.type).toBe('scatter');
    expect(scatter.data).toHaveLength(2);
    // 散点落在曲线高度上；决策 = accent，设备状态 = actuator。
    expect(scatter.data[0].value).toEqual([1, 25]);
    expect(scatter.data[0].itemStyle.color).toBe('#4cc2ff');
    expect(scatter.data[1].itemStyle.color).toBe('#f5a524');
  });
});

describe('ReplayTimeline component', () => {
  afterEach(() => {
    cleanup();
    useEChartsMock.mockClear();
  });

  function seedStore(cursor: number) {
    useAppStore.setState({
      replayBuffer: [bufferSnapshot(0, 0, 20), bufferSnapshot(1, 10, 21), bufferSnapshot(2, 20, 22)],
      replayCursor: cursor,
      replayActive: true,
    });
  }

  it('缓冲不足 2 条时不渲染', () => {
    useAppStore.setState({ replayBuffer: [bufferSnapshot(0, 0, 20)], replayCursor: 0 });
    const { container } = render(<ReplayTimeline events={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('点击散点跳转到事件时间点；点击折线 seek 到该下标', () => {
    seedStore(0);
    render(<ReplayTimeline events={[replayEvent('d1', 'sim-decision', 20)]} />);
    expect(screen.getByTestId('replay-timeline-canvas')).toBeTruthy();
    const onClick = useEChartsMock.mock.calls.at(-1)?.[2];
    expect(typeof onClick).toBe('function');

    onClick?.({ seriesIndex: 1, dataIndex: 0 }); // 散点：d1 映射到下标 2
    expect(useAppStore.getState().replayCursor).toBe(2);

    onClick?.({ seriesIndex: 0, dataIndex: 1 }); // 折线：dataIndex 即缓冲下标
    expect(useAppStore.getState().replayCursor).toBe(1);
  });

  it('游标变化重建 option（markLine 跟随）', () => {
    seedStore(0);
    const { rerender } = render(<ReplayTimeline events={[]} />);
    let option = useEChartsMock.mock.calls.at(-1)?.[0] as any;
    expect(option.series[0].markLine.data).toEqual([{ xAxis: 0 }]);

    useAppStore.getState().setReplayCursor(2);
    rerender(<ReplayTimeline events={[]} />);
    option = useEChartsMock.mock.calls.at(-1)?.[0] as any;
    expect(option.series[0].markLine.data).toEqual([{ xAxis: 2 }]);
  });
});
