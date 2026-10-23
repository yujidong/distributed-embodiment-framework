/**
 * R31 SF9 — Geo 覆盖层 diff 描述子（GeoWorldMap 内联更新）：
 *
 * overlay 不再 clearLayers()+全量重建，而是按键驻留 + 差量更新
 * （setStyle / setLatLng / setTooltipContent / setIcon / class 切换）。
 * 这些纯函数产出每层的「期望状态」，是差量决策的全部输入 —— Leaflet
 * 调用本身在组件 effect 里（jsdom 无法实例化 Leaflet 矢量渲染器，真实
 * 浏览器行为）。
 */

import { describe, expect, it } from 'vitest';

import {
  agentIconHtml,
  deviceLayerState,
  deviceTooltipHtml,
  zoneLayerState,
  zoneTooltipHtml,
} from '../components/worldmap/GeoWorldMap';
import { mapColors } from '../lib/theme';

const DARK = mapColors('dark');

describe('zoneLayerState (R31 SF9)', () => {
  it('默认：accent 描边 1.5 / 8% 填充', () => {
    const state = zoneLayerState({ selected: false, focused: false, highlighted: false, colors: DARK });
    expect(state.color).toBe(DARK.accent);
    expect(state.weight).toBe(1.5);
    expect(state.fillOpacity).toBe(0.08);
    expect(state.highlighted).toBe(false);
  });

  it('选中：强描边 + 30% 填充；聚焦：hybrid + 22%；高亮：35%', () => {
    const selected = zoneLayerState({ selected: true, focused: false, highlighted: false, colors: DARK });
    expect(selected.color).toBe(DARK.dangerStrong);
    expect(selected.weight).toBe(3.5);
    expect(selected.fillOpacity).toBe(0.3);

    const focused = zoneLayerState({ selected: false, focused: true, highlighted: false, colors: DARK });
    expect(focused.color).toBe(DARK.hybrid);
    expect(focused.fillColor).toBe(DARK.hybrid);
    expect(focused.fillOpacity).toBe(0.22);

    const highlighted = zoneLayerState({ selected: false, focused: false, highlighted: true, colors: DARK });
    expect(highlighted.fillOpacity).toBe(0.35);
    expect(highlighted.highlighted).toBe(true);
  });
});

describe('zoneTooltipHtml (R31 SF9)', () => {
  it('名称 + 类型 + 实时参数行，HTML 转义', () => {
    const html = zoneTooltipHtml(
      { id: 'z1', name: '教学<A>楼', type: 'teaching' },
      { temperature: 26.5, occupancy: 12 },
    );
    expect(html).toContain('教学&lt;A&gt;楼');
    expect(html).toContain('teaching');
    expect(html).toContain('26.5');
    expect(html).toContain('12');
  });

  it('无快照时只有名称与类型', () => {
    const html = zoneTooltipHtml({ id: 'z1', name: '室外' }, undefined);
    expect(html).toBe('<strong>室外</strong>');
  });
});

describe('deviceLayerState (R31 SF9)', () => {
  it('默认：半径 7 / owner 色描边；选中放大加粗', () => {
    const base = deviceLayerState({
      selected: false, faulted: false, dimmed: false, active: false,
      role: 'actuator', ownerColor: '#ff0000', colors: DARK,
    });
    expect(base.radius).toBe(7);
    expect(base.weight).toBe(2.5);
    expect(base.color).toBe('#ff0000');
    expect(base.opacity).toBe(1);

    const selected = deviceLayerState({
      selected: true, faulted: false, dimmed: false, active: false,
      role: 'actuator', ownerColor: null, colors: DARK,
    });
    expect(selected.radius).toBe(9);
    expect(selected.weight).toBe(3.5);
    expect(selected.color).toBe(DARK.border);
  });

  it('故障：dangerStrong 描边；我的视角：25% 透明度', () => {
    const faulted = deviceLayerState({
      selected: false, faulted: true, dimmed: false, active: false,
      role: 'actuator', ownerColor: null, colors: DARK,
    });
    expect(faulted.color).toBe(DARK.dangerStrong);
    expect(faulted.weight).toBe(3.5);

    const dimmed = deviceLayerState({
      selected: false, faulted: false, dimmed: true, active: false,
      role: 'actuator', ownerColor: null, colors: DARK,
    });
    expect(dimmed.opacity).toBe(0.25);
    expect(dimmed.fillOpacity).toBe(0.25);
  });
});

describe('deviceTooltipHtml (R31 SF9)', () => {
  it('非脱敏：state 摘要 + 故障行', () => {
    const html = deviceTooltipHtml(
      { name: '灯', type: 'light' },
      { state: { power: 30, on: true }, fault: { kind: 'stuck' } as never },
    );
    expect(html).toContain('灯');
    expect(html).toContain('light');
    expect(html).toContain('30');
  });

  it('脱敏（S2 设备隐私）：只给粗状态行', () => {
    const html = deviceTooltipHtml(
      { name: ' чужой灯', type: 'light' },
      { state: {}, stateRedacted: true, status: 'on' },
    );
    expect(html).not.toContain('stateCoarse'); // 已本地化为文案
    expect(html).toContain(' чужой灯');
  });
});

describe('agentIconHtml (R31 SF9)', () => {
  it('选中 / 脱敏 class 与 owner 背景色、首字母', () => {
    const base = agentIconHtml({ name: '小管家', selected: false, dimmed: false, ownerColor: null });
    expect(base).toContain('geo-agent-marker"');
    expect(base).toContain('<span>小</span>');

    const selected = agentIconHtml({ name: '小管家', selected: true, dimmed: false, ownerColor: null });
    expect(selected).toContain('geo-agent-marker--selected');

    const dimmed = agentIconHtml({ name: '小管家', selected: false, dimmed: true, ownerColor: null });
    expect(dimmed).toContain('geo-agent-marker--dimmed');

    const owner = agentIconHtml({ name: '小管家', selected: false, dimmed: false, ownerColor: '#123456' });
    expect(owner).toContain('background:#123456;');
  });
});
