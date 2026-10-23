/**
 * EnvSeriesPanel（LivePanels 环境曲线）——mock lib/echarts 的 useECharts，
 * 断言 option 组装（多 y 轴 / 系列数据 / markLine）与无数据降级渲染；
 * buildEnvSeriesOption 是纯函数，直接断言。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEnvSeriesOption,
  EnvSeriesPanel,
} from '../components/EnvSeriesPanel';
import { useECharts, type ChartPalette } from '../lib/echarts';
import {
  appendSnapshot,
  createEnvTimeseries,
  type EnvTimeseries,
} from '../lib/timeseries';
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
} as ChartPalette;

function makeSeries(): EnvTimeseries {
  let series = createEnvTimeseries();
  for (const [tick, t, temp] of [
    [1, 10, 22],
    [2, 20, 23],
  ] as const) {
    series = appendSnapshot(
      series,
      makeSnapshot({
        tickCount: tick,
        simTimeSec: t,
        zones: [
          { id: 'z1', name: '客厅', parameters: { temperature: temp, co2: 600 + t, humidity: 45 } },
          { id: 'z2', name: '卧室', parameters: { temperature: temp - 2 } },
        ],
        scheduledEvents: [
          { id: 'e1', type: 'temperature-spike', zoneId: 'z1', atSimTimeSec: 15, fired: true },
          { id: 'e2', type: 'smoke-detected', zoneId: 'z2', atSimTimeSec: 18, fired: true },
        ],
      }),
    );
  }
  return series;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('buildEnvSeriesOption', () => {
  it('默认三条系列 + 三个 y 轴（温度左轴，CO₂/湿度右轴）', () => {
    const option = buildEnvSeriesOption(FAKE_PALETTE, makeSeries(), 'z1', false) as any;
    expect(option.series).toHaveLength(3);
    expect(option.yAxis).toHaveLength(3);
    expect(option.yAxis[0].position).toBe('left');
    expect(option.yAxis[1].position).toBe('right');
    expect(option.series[0].data).toEqual([
      [10, 22],
      [20, 23],
    ]);
    // 系列色取自色板（温度红 / CO₂ 紫 / 湿度青）。
    expect(option.series[0].itemStyle.color).toBe('#f2555a');
    expect(option.series[1].itemStyle.color).toBe('#b07cf0');
  });

  it('occupancy toggle 增加第四条系列与第四个 y 轴', () => {
    const series = appendSnapshot(
      makeSeries(),
      makeSnapshot({
        tickCount: 3,
        simTimeSec: 30,
        zones: [{ id: 'z1', parameters: { temperature: 24, occupancy: 3 } }],
      }),
    );
    const option = buildEnvSeriesOption(FAKE_PALETTE, series, 'z1', true) as any;
    expect(option.series).toHaveLength(4);
    expect(option.yAxis).toHaveLength(4);
    expect(option.series[3].name).toBe('Occupancy');
    expect(option.series[3].data).toEqual([[30, 3]]);
  });

  it('已触发事件画 markLine（只含当前 zone 的事件）', () => {
    const option = buildEnvSeriesOption(FAKE_PALETTE, makeSeries(), 'z1', false) as any;
    const markLine = option.series[0].markLine;
    expect(markLine.data).toHaveLength(1);
    expect(markLine.data[0].xAxis).toBe(15);
    expect(markLine.data[0].label.formatter).toBe('temperature-spike');
    expect(markLine.lineStyle.color).toBe('#4cc2ff');
  });
});

describe('EnvSeriesPanel', () => {
  afterEach(() => {
    cleanup();
    useEChartsMock.mockClear();
  });

  it('渲染 zone 选择器（默认第一个 zone）并把 option 交给 useECharts', () => {
    render(<EnvSeriesPanel series={makeSeries()} />);
    const select = screen.getByLabelText('Select zone') as HTMLSelectElement;
    expect(select.value).toBe('z1');
    expect(screen.getByTestId('env-chart-canvas')).toBeTruthy();
    const option = useEChartsMock.mock.calls.at(-1)?.[0] as any;
    expect(option.series[0].data).toEqual([
      [10, 22],
      [20, 23],
    ]);
  });

  it('preferredZoneId（聚焦 agent 的管辖 zone）优先作默认 zone', () => {
    render(<EnvSeriesPanel series={makeSeries()} preferredZoneId="z2" />);
    const select = screen.getByLabelText('Select zone') as HTMLSelectElement;
    expect(select.value).toBe('z2');
    const option = useEChartsMock.mock.calls.at(-1)?.[0] as any;
    expect(option.series[0].data).toEqual([
      [10, 20],
      [20, 21],
    ]);
  });

  it('切换 zone 后重新组装 option', () => {
    render(<EnvSeriesPanel series={makeSeries()} />);
    fireEvent.change(screen.getByLabelText('Select zone'), { target: { value: 'z2' } });
    const option = useEChartsMock.mock.calls.at(-1)?.[0] as any;
    // z2 的湿度全部缺失 → 湿度系列为空。
    expect(option.series[2].data).toEqual([]);
  });

  it('人数 toggle 展开第四条系列', () => {
    render(<EnvSeriesPanel series={makeSeries()} />);
    fireEvent.click(screen.getByLabelText('Occupancy'));
    const option = useEChartsMock.mock.calls.at(-1)?.[0] as any;
    expect(option.series).toHaveLength(4);
  });

  it('无 zone 数据时降级为占位提示（不挂图表）', () => {
    render(<EnvSeriesPanel series={createEnvTimeseries()} />);
    expect(screen.getByText('Waiting for environment data…')).toBeTruthy();
    expect(screen.queryByTestId('env-chart-canvas')).toBeNull();
  });
});
