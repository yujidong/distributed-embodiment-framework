/**
 * 环境时序缓冲（lib/timeseries）：追加 / 去重 / 容量 / 序列输出 /
 * markLine 提取 / 仿真切换重置。
 */

import { describe, expect, it } from 'vitest';

import {
  appendSnapshot,
  createEnvTimeseries,
  markLinesFor,
  metricSeries,
  TIMESERIES_CAP,
} from '../lib/timeseries';
import { makeSnapshot } from './fixtures';

function snap(
  tick: number,
  simTimeSec: number,
  zones: Array<{ id: string; name?: string; parameters: Record<string, number | boolean> }>,
  scheduledEvents: Array<{ id: string; type: string; zoneId: string; atSimTimeSec?: number; fired: boolean }> = [],
  runtimeId = 'sim-1',
) {
  return makeSnapshot({
    runtimeId,
    tickCount: tick,
    simTimeSec,
    zones: zones.map(z => ({ id: z.id, name: z.name, parameters: z.parameters })),
    scheduledEvents,
  });
}

describe('appendSnapshot', () => {
  it('按 zone 提取温度/CO₂/湿度/人数采样点（simTimeSec 为 x）', () => {
    let series = createEnvTimeseries();
    series = appendSnapshot(
      series,
      snap(1, 10, [{ id: 'z1', name: '客厅', parameters: { temperature: 22, co2: 600, humidity: 45, occupancy: 2 } }]),
    );
    series = appendSnapshot(
      series,
      snap(2, 20, [{ id: 'z1', name: '客厅', parameters: { temperature: 23, co2: 650, humidity: 46, occupancy: 3 } }]),
    );
    expect(series.zoneIds).toEqual(['z1']);
    expect(series.zoneNames.z1).toBe('客厅');
    expect(metricSeries(series, 'z1', 'temperature')).toEqual([
      [10, 22],
      [20, 23],
    ]);
    expect(metricSeries(series, 'z1', 'co2')).toEqual([
      [10, 600],
      [20, 650],
    ]);
    expect(metricSeries(series, 'z1', 'occupancy')).toEqual([
      [10, 2],
      [20, 3],
    ]);
  });

  it('跳过缺失与非数值参数（布尔 smoke 不进曲线）', () => {
    let series = createEnvTimeseries();
    series = appendSnapshot(
      series,
      snap(1, 10, [{ id: 'z1', parameters: { temperature: 22, smoke: true } }]),
    );
    series = appendSnapshot(series, snap(2, 20, [{ id: 'z1', parameters: { co2: 700 } }]));
    expect(metricSeries(series, 'z1', 'temperature')).toEqual([[10, 22]]);
    expect(metricSeries(series, 'z1', 'humidity')).toEqual([]);
    expect(metricSeries(series, 'z1', 'co2')).toEqual([[20, 700]]);
    expect(metricSeries(series, 'missing-zone', 'temperature')).toEqual([]);
  });

  it('重复尾部（同 tick + simTime）返回原 identity', () => {
    const first = appendSnapshot(
      createEnvTimeseries(),
      snap(1, 10, [{ id: 'z1', parameters: { temperature: 22 } }]),
    );
    const again = appendSnapshot(first, snap(1, 10, [{ id: 'z1', parameters: { temperature: 99 } }]));
    expect(again).toBe(first);
    expect(metricSeries(again, 'z1', 'temperature')).toEqual([[10, 22]]);
  });

  it('超出容量丢最旧采样点', () => {
    let series = createEnvTimeseries();
    for (let tick = 1; tick <= TIMESERIES_CAP + 5; tick += 1) {
      series = appendSnapshot(
        series,
        snap(tick, tick, [{ id: 'z1', parameters: { temperature: tick } }]),
      );
    }
    const temps = metricSeries(series, 'z1', 'temperature');
    expect(temps).toHaveLength(TIMESERIES_CAP);
    expect(temps[0]).toEqual([6, 6]);
    expect(temps[temps.length - 1]).toEqual([TIMESERIES_CAP + 5, TIMESERIES_CAP + 5]);
  });

  it('runtimeId 变化（换仿真）清空重开', () => {
    let series = createEnvTimeseries();
    series = appendSnapshot(series, snap(1, 10, [{ id: 'z1', parameters: { temperature: 22 } }]));
    series = appendSnapshot(
      series,
      snap(1, 0, [{ id: 'z2', parameters: { humidity: 50 } }], [], 'sim-2'),
    );
    expect(series.runtimeId).toBe('sim-2');
    expect(series.zoneIds).toEqual(['z2']);
    expect(metricSeries(series, 'z1', 'temperature')).toEqual([]);
  });
});

describe('markLinesFor', () => {
  const fired = [
    { id: 'e1', type: 'temperature-spike', zoneId: 'z1', atSimTimeSec: 15, fired: true },
    { id: 'e2', type: 'smoke-detected', zoneId: 'z2', atSimTimeSec: 25, fired: true },
  ];

  it('从已触发的 scheduledEvents 提取 markLine（按 id 跨 snapshot 去重）', () => {
    let series = createEnvTimeseries();
    series = appendSnapshot(series, snap(1, 10, [{ id: 'z1', parameters: {} }], fired));
    // 同一批事件在下一个 snapshot 里仍是 fired —— 不应重复收录。
    series = appendSnapshot(series, snap(2, 20, [{ id: 'z1', parameters: {} }], fired));
    expect(series.marks.map(m => m.id)).toEqual(['e1', 'e2']);
    expect(series.marks[0]).toMatchObject({ t: 15, zoneId: 'z1', type: 'temperature-spike' });
  });

  it('忽略未触发或无 atSimTimeSec 的事件', () => {
    const series = appendSnapshot(
      createEnvTimeseries(),
      snap(1, 10, [{ id: 'z1', parameters: {} }], [
        { id: 'e3', type: 'x', zoneId: 'z1', atSimTimeSec: 30, fired: false },
        { id: 'e4', type: 'manual', zoneId: 'z1', fired: true },
      ]),
    );
    expect(series.marks).toEqual([]);
  });

  it('按 zone 过滤，并裁掉滚出采样窗口的 mark', () => {
    let series = createEnvTimeseries();
    // e0 在 t=1 触发，但 z1 的采样从 t=10 才开始（缓冲已裁掉更早的点）。
    series = appendSnapshot(
      series,
      snap(0, 1, [], [{ id: 'e0', type: 'old', zoneId: 'z1', atSimTimeSec: 1, fired: true }]),
    );
    series = appendSnapshot(series, snap(1, 10, [{ id: 'z1', parameters: {} }], fired));
    expect(markLinesFor(series, 'z1').map(m => m.id)).toEqual(['e1']);
    expect(markLinesFor(series, 'z2').map(m => m.id)).toEqual(['e2']);
    expect(markLinesFor(series).map(m => m.id)).toEqual(['e0', 'e1', 'e2']);
  });
});
