/**
 * echarts 手搓封装（项目惯例：不引 echarts-for-react，与 Leaflet 的
 * GeoWorldMap wrapper 一致）。
 *
 * - 按需注册模块（Line/Scatter + Grid/Tooltip/MarkLine/Legend + Canvas），
 *   控制打包体积；
 * - `useECharts` 返回 callback ref：容器挂载时 init，ResizeObserver 驱动
 *   resize，卸载 dispose；主题切换时 dispose + 重建（echarts 无法原地换
 *   色板，只能重建后重设 option）；
 * - `chartPalette(theme)` 从 lib/theme 的 mapColors 派生坐标轴 / 分割线 /
 *   文字 / 系列色——TS 侧颜色事实源不变，图表跟随主题切换。
 */

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

import { mapColors, type ThemeName } from './theme';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type { EChartsCoreOption };
export type EChartsInstance = ReturnType<typeof echarts.init>;

/** 主题化图表色板（坐标轴 / 文字 / 系列色全部来自 mapColors）。 */
export interface ChartPalette {
  text: string;
  textDim: string;
  axisLine: string;
  splitLine: string;
  panelBg: string;
  border: string;
  accent: string;
  ok: string;
  danger: string;
  actuator: string;
  /**
   * G5: 温度的专用暖色——系列色与语义色（danger 红）分离，温度曲线不再
   * 与「危险」同色。
   */
  warm: string;
  /**
   * 系列色。环境曲线按 temperature / co2 / humidity / occupancy 顺序取
   * 前四色（暖橙 / 紫 / 青 / 蓝），其余为兜底循环色。
   */
  series: string[];
}

/** G5: 温度专用暖色（双主题各一，独立于语义色 token）。 */
const SERIES_WARM: Record<ThemeName, string> = {
  dark: '#fb923c',
  light: '#ea580c',
};

export function chartPalette(theme: ThemeName): ChartPalette {
  const c = mapColors(theme);
  return {
    text: c.text,
    textDim: c.textDim,
    axisLine: c.border,
    splitLine: c.border,
    panelBg: c.bgPanel,
    border: c.border,
    accent: c.accent,
    ok: c.ok,
    danger: c.danger,
    actuator: c.actuator,
    warm: SERIES_WARM[theme],
    series: [SERIES_WARM[theme], c.hybrid, c.sensor, c.accent, c.actuator, c.ok],
  };
}

/** echarts click 事件参数里组件侧用到的子集（防御性：字段都可能缺）。 */
export interface EChartClickParams {
  seriesIndex?: number;
  dataIndex?: number;
}

/**
 * 挂载一个 echarts 实例到返回的 callback ref 上。
 *
 * - `option` 为 null 时只挂载空实例（容器可无数据时先渲染占位）；
 * - option 变化走 `setOption(option, { notMerge: true })` 全量替换，
 *   调用方负责组装完整 option；
 * - `theme` 变化销毁重建（取新色板）；`onClick` 始终指向最新闭包。
 */
export function useECharts(
  option: EChartsCoreOption | null,
  theme: ThemeName,
  onClick?: (params: EChartClickParams) => void,
): (el: HTMLDivElement | null) => void {
  // callback ref + state：容器条件渲染（无数据占位）时也能在挂载后 init。
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    chart.on('click', params => clickRef.current?.(params as EChartClickParams));
    // jsdom（测试环境）没有 ResizeObserver —— 防御性跳过。
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => chart.resize())
        : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [el, theme]);

  useEffect(() => {
    if (option && chartRef.current) {
      chartRef.current.setOption(option, { notMerge: true });
    }
  }, [el, theme, option]);

  return setEl;
}
