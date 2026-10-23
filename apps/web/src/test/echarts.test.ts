/**
 * chartPalette（lib/echarts）——色板从 mapColors 派生，跟随主题切换，
 * 亮色下坐标轴/文字色取自亮色 token（可读性由 theme.ts 的双主题色保证）。
 */

import { describe, expect, it } from 'vitest';

import { chartPalette } from '../lib/echarts';
import { mapColors } from '../lib/theme';

describe('chartPalette', () => {
  it('坐标轴 / 文字 / 系列色全部来自 mapColors', () => {
    const dark = chartPalette('dark');
    const colors = mapColors('dark');
    expect(dark.text).toBe(colors.text);
    expect(dark.textDim).toBe(colors.textDim);
    expect(dark.axisLine).toBe(colors.border);
    expect(dark.splitLine).toBe(colors.border);
    expect(dark.series.slice(0, 4)).toEqual([
      dark.warm,
      colors.hybrid,
      colors.sensor,
      colors.accent,
    ]);
    // G5: 系列色与语义色分离——首色（温度）不再是 danger 红。
    expect(dark.series).not.toContain(colors.danger);
    expect(dark.warm).not.toBe(colors.danger);
  });

  it('主题切换得到不同色板（亮色文字/坐标轴走亮色 token）', () => {
    const dark = chartPalette('dark');
    const light = chartPalette('light');
    expect(light.text).not.toBe(dark.text);
    expect(light.axisLine).not.toBe(dark.axisLine);
    expect(light.text).toBe(mapColors('light').text);
    expect(light.warm).not.toBe(dark.warm);
    expect(light.series[0]).toBe(light.warm);
  });
});
