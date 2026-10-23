/**
 * Device energy curves (R15-D8) — cumulative Wh per energy-consuming device
 * accumulated from the LIVE snapshot stream, plus the pure echarts option.
 *
 * The engine meters every device's `state.cumulativeEnergyWh` continuously
 * (SimulatedDevice); the console previously surfaced only a single column in
 * the device table. This builds the time dimension: one monotonically
 * growing curve per device (cap ENERGY_CURVE_CAP samples), a per-zone
 * aggregation, and a chart of the top consumers — the panel renders it under
 * the physics curves in the console's right drawer.
 */

import i18n from '../i18n/config';
import type { EngineSnapshot } from '../api/types';
import type { ChartPalette, EChartsCoreOption } from './echarts';

export const ENERGY_CURVE_CAP = 500;
/** At most this many device lines — the rest aggregate into the total. */
export const ENERGY_TOP_DEVICES = 8;

export interface DeviceEnergySeries {
  /** Snapshot identity — a different runtime resets the buffers. */
  runtimeId: string | null;
  /** Last dedupe key (`runtimeId:tick:simTime`); repeats return identity. */
  lastKey: string | null;
  deviceIds: string[];
  deviceNames: Record<string, string>;
  /** deviceId → [simTimeSec, cumulativeWh][] (append order). */
  samples: Record<string, Array<[number, number]>>;
}

export function createDeviceEnergySeries(): DeviceEnergySeries {
  return { runtimeId: null, lastKey: null, deviceIds: [], deviceNames: {}, samples: {} };
}

/** Numeric cumulative meter reading from a device's state, if present. */
function readWh(state: Record<string, unknown>): number | undefined {
  const value = state.cumulativeEnergyWh;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Accumulate one LIVE snapshot; duplicate ticks return the same object. */
export function appendDeviceEnergy(
  series: DeviceEnergySeries,
  snapshot: EngineSnapshot,
): DeviceEnergySeries {
  const key = `${snapshot.runtimeId}:${snapshot.tickCount}:${snapshot.simTimeSec}`;
  if (series.lastKey === key) return series;
  const base = series.runtimeId === snapshot.runtimeId ? series : createDeviceEnergySeries();

  const deviceIds = [...base.deviceIds];
  const deviceNames = { ...base.deviceNames };
  const samples: Record<string, Array<[number, number]>> = { ...base.samples };
  for (const device of snapshot.devices) {
    const wh = readWh(device.state as Record<string, unknown>);
    if (wh === undefined) continue;
    if (!deviceIds.includes(device.id)) {
      deviceIds.push(device.id);
      deviceNames[device.id] = device.name;
      samples[device.id] = [];
    }
    const curve = samples[device.id]!;
    const last = curve[curve.length - 1];
    // The meter only grows; equal readings still advance time (flat segment).
    curve.push([snapshot.simTimeSec, wh]);
    if (last && last[0] === snapshot.simTimeSec) curve.splice(curve.length - 2, 1);
    if (curve.length > ENERGY_CURVE_CAP) curve.splice(0, curve.length - ENERGY_CURVE_CAP);
  }
  return { runtimeId: snapshot.runtimeId, lastKey: key, deviceIds, deviceNames, samples };
}

/** Latest reading per device — the "now" totals behind the chart. */
export function latestWh(series: DeviceEnergySeries): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of series.deviceIds) {
    const curve = series.samples[id]!;
    if (curve.length > 0) out[id] = curve[curve.length - 1]![1];
  }
  return out;
}

/** Aggregate the latest readings per zone (devices carry zoneId in snapshots). */
export function zoneEnergyTotals(
  series: DeviceEnergySeries,
  devices: Array<{ id: string; zoneId: string }>,
): { zoneId: string; wh: number }[] {
  const zoneOf = new Map(devices.map(d => [d.id, d.zoneId]));
  const totals = new Map<string, number>();
  for (const [id, wh] of Object.entries(latestWh(series))) {
    const zoneId = zoneOf.get(id);
    if (zoneId === undefined) continue;
    totals.set(zoneId, (totals.get(zoneId) ?? 0) + wh);
  }
  return [...totals.entries()]
    .map(([zoneId, wh]) => ({ zoneId, wh }))
    .sort((a, b) => b.wh - a.wh);
}

/** Per-device cumulative curves (top consumers) + the dashed total line. */
export function buildEnergyOption(
  palette: ChartPalette,
  series: DeviceEnergySeries,
  devices: Array<{ id: string; name: string }>,
): EChartsCoreOption | null {
  const latest = latestWh(series);
  const ranked = Object.entries(latest).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const nameOf = new Map(devices.map(d => [d.id, d.name]));
  const top = ranked.slice(0, ENERGY_TOP_DEVICES).map(([id]) => id);
  const totalCurve: Array<[number, number]> = [];

  const echartsSeries: Array<Record<string, unknown>> = top.map((id, index) => {
    const curve = series.samples[id] ?? [];
    return {
      type: 'line' as const,
      name: series.deviceNames[id] ?? nameOf.get(id) ?? id,
      showSymbol: false,
      lineStyle: { width: 1.5 },
      itemStyle: { color: palette.series[index % palette.series.length] },
      data: curve,
    };
  });
  // Total = sum across EVERY metered device at each sampled sim time.
  const allTimes = new Set<number>();
  for (const id of series.deviceIds) {
    for (const [t] of series.samples[id] ?? []) allTimes.add(t);
  }
  for (const t of [...allTimes].sort((a, b) => a - b)) {
    let sum = 0;
    let seen = false;
    for (const id of series.deviceIds) {
      const curve = series.samples[id] ?? [];
      // Last reading at or before t (meters are cumulative).
      for (let i = curve.length - 1; i >= 0; i--) {
        if (curve[i]![0] <= t) {
          sum += curve[i]![1];
          seen = true;
          break;
        }
      }
    }
    if (seen) totalCurve.push([t, Math.round(sum * 1000) / 1000]);
  }
  if (totalCurve.length > 0) {
    echartsSeries.push({
      type: 'line' as const,
      name: i18n.t('energy:totalLine'),
      showSymbol: false,
      lineStyle: { width: 2, type: 'dashed' },
      itemStyle: { color: palette.text },
      data: totalCurve,
    });
  }

  const axisLabel = { textStyle: { color: palette.textDim, fontSize: 10 } };
  return {
    backgroundColor: 'transparent',
    grid: { left: 4, right: 4, top: 26, bottom: 4, containLabel: true },
    legend: {
      top: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 3,
      textStyle: { color: palette.textDim, fontSize: 10 },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.panelBg,
      borderColor: palette.border,
      textStyle: { color: palette.text, fontSize: 11 },
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? `${Math.round(value * 100) / 100} Wh` : '-',
    },
    xAxis: {
      type: 'value',
      name: 'sim-s',
      axisLine: { lineStyle: { color: palette.axisLine } },
      axisLabel,
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'Wh',
      nameTextStyle: { color: palette.textDim, fontSize: 10 },
      axisLine: { show: true, lineStyle: { color: palette.series[0] } },
      axisLabel,
      splitLine: { show: true, lineStyle: { color: palette.splitLine, opacity: 0.4 } },
    },
    series: echartsSeries,
  };
}
