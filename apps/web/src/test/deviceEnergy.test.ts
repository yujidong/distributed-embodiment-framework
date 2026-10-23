/**
 * Device-energy curves (R15-D8): accumulation from the live snapshot stream
 * (dedupe, runtime reset, cap), zone totals, and the chart option shape.
 * Pure functions — no rendering.
 */

import { describe, expect, it } from 'vitest';

import type { EngineSnapshot } from '../api/types';
import {
  appendDeviceEnergy,
  buildEnergyOption,
  createDeviceEnergySeries,
  latestWh,
  zoneEnergyTotals,
} from '../lib/deviceEnergy';

function snap(
  runtimeId: string,
  tick: number,
  t: number,
  devices: Array<{ id: string; name: string; zoneId: string; wh: number | null }>,
): EngineSnapshot {
  return {
    runtimeId,
    tickCount: tick,
    simTimeSec: t,
    devices: devices.map(d => ({
      id: d.id,
      name: d.name,
      zoneId: d.zoneId,
      state: d.wh === null ? {} : { cumulativeEnergyWh: d.wh },
    })),
  } as unknown as EngineSnapshot;
}

const DEVICES = [
  { id: 'hvac-1', name: 'HVAC 1', zoneId: 'z-a', wh: 10 },
  { id: 'hvac-2', name: 'HVAC 2', zoneId: 'z-a', wh: 5 },
  { id: 'sensor-1', name: 'Sensor', zoneId: 'z-b', wh: null }, // no meter
];

describe('appendDeviceEnergy', () => {
  it('accumulates per-device curves and dedupes repeat ticks', () => {
    let series = createDeviceEnergySeries();
    series = appendDeviceEnergy(series, snap('r1', 1, 10, DEVICES));
    series = appendDeviceEnergy(series, snap('r1', 1, 10, DEVICES)); // dedupe
    series = appendDeviceEnergy(series, snap('r1', 2, 20, [
      { ...DEVICES[0]!, wh: 12 },
      DEVICES[1]!,
      DEVICES[2]!,
    ]));
    expect(series.deviceIds).toEqual(['hvac-1', 'hvac-2']); // sensor unmetered
    expect(series.samples['hvac-1']).toEqual([[10, 10], [20, 12]]);
    // Equal readings still advance time — a flat segment (meter idle).
    expect(series.samples['hvac-2']).toEqual([[10, 5], [20, 5]]);
    expect(latestWh(series)).toEqual({ 'hvac-1': 12, 'hvac-2': 5 });
  });

  it('resets when the runtime changes', () => {
    let series = createDeviceEnergySeries();
    series = appendDeviceEnergy(series, snap('r1', 1, 10, DEVICES));
    series = appendDeviceEnergy(series, snap('r2', 1, 5, DEVICES));
    expect(series.samples['hvac-1']).toEqual([[5, 10]]); // fresh buffer
  });
});

describe('zoneEnergyTotals', () => {
  it('sums the latest readings per zone, unmetered devices ignored', () => {
    let series = createDeviceEnergySeries();
    series = appendDeviceEnergy(series, snap('r1', 2, 20, [
      { ...DEVICES[0]!, wh: 12 },
      { ...DEVICES[1]!, wh: 3 },
      DEVICES[2]!,
    ]));
    const devices = DEVICES.map(d => ({ id: d.id, zoneId: d.zoneId }));
    expect(zoneEnergyTotals(series, devices)).toEqual([{ zoneId: 'z-a', wh: 15 }]);
  });
});

describe('buildEnergyOption', () => {
  it('builds per-device lines plus the dashed total line', () => {
    let series = createDeviceEnergySeries();
    series = appendDeviceEnergy(series, snap('r1', 1, 10, DEVICES));
    series = appendDeviceEnergy(series, snap('r1', 2, 20, [
      { ...DEVICES[0]!, wh: 11 },
      DEVICES[1]!,
      DEVICES[2]!,
    ]));
    const option = buildEnergyOption(
      {
        text: '#fff', textDim: '#aaa', border: '#333', panelBg: '#111',
        axisLine: '#444', splitLine: '#555', series: ['#1f77b4', '#ff7f0e'],
      } as never,
      series,
      DEVICES.map(d => ({ id: d.id, name: d.name })),
    );
    expect(option).not.toBeNull();
    const lines = (option as { series: Array<{ name: string; data: Array<[number, number]> }> }).series;
    expect(lines.map(l => l.name)).toEqual(['HVAC 1', 'HVAC 2', 'Total']);
    expect(lines[2]!.data).toEqual([[10, 15], [20, 16]]); // sums at each t
  });

  it('returns null with no metered devices', () => {
    const series = createDeviceEnergySeries();
    expect(buildEnergyOption({} as never, series, [])).toBeNull();
  });
});
