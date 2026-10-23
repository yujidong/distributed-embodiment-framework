/**
 * Zone visuals (V1) — zone category classification, heat-fill color scale,
 * comfort badge variant, and the defensive comfort/occupancy readers, plus
 * the energy formatter (A3) and door-gap geometry.
 */

import { describe, expect, it } from 'vitest';

import { formatEnergyWh } from '../lib/format';
import {
  classifyZone,
  comfortBadgeVariant,
  HEAT_TEMP_MAX,
  HEAT_TEMP_MIN,
  readOccupancy,
  readZoneComfort,
  temperatureHeatColor,
  zoneHeatFill,
} from '../lib/zoneVisual';
import { computeDoorGaps, type ZoneFrame } from '../components/worldmap/layout';

describe('classifyZone', () => {
  it('matches Chinese and English keywords in name or type', () => {
    expect(classifyZone({ name: '教学楼101教室' })).toBe('classroom');
    expect(classifyZone({ name: 'Room 201', type: 'classroom' })).toBe('classroom');
    expect(classifyZone({ name: '宿舍3号楼' })).toBe('dormitory');
    expect(classifyZone({ name: 'Dormitory A' })).toBe('dormitory');
    expect(classifyZone({ name: '二层走廊' })).toBe('corridor');
    expect(classifyZone({ name: '楼梯间B' })).toBe('stairwell');
    expect(classifyZone({ name: '图书馆' })).toBe('library');
    expect(classifyZone({ name: '室外广场' })).toBe('outdoor');
    expect(classifyZone({ type: 'outdoor' })).toBe('outdoor');
  });

  it('de-emphasizes circulation zones before venue keywords', () => {
    expect(classifyZone({ name: '图书馆走廊' })).toBe('corridor');
  });

  it('classifies medical and commercial zones (R15-D9)', () => {
    expect(classifyZone({ name: '二号病房' })).toBe('medical');
    expect(classifyZone({ name: '护理站' })).toBe('medical');
    expect(classifyZone({ type: 'clinic' })).toBe('medical');
    expect(classifyZone({ name: 'Nursing Room 3' })).toBe('medical');
    // UX-W2: the shop/retail vocabulary moved from outdoor to the new
    // commercial family; 街道/street alone stays outdoor.
    expect(classifyZone({ name: '沿街商铺' })).toBe('commercial');
    expect(classifyZone({ name: '门店A' })).toBe('commercial');
    expect(classifyZone({ type: 'retail' })).toBe('commercial');
  });

  it('matches the UX-W2 medical vocabulary (English ids and Chinese names)', () => {
    expect(classifyZone({ name: 'Ward 5B' })).toBe('medical');
    expect(classifyZone({ name: 'ICU-3' })).toBe('medical');
    expect(classifyZone({ type: 'pharmacy' })).toBe('medical');
    expect(classifyZone({ name: 'Consulting Room 2' })).toBe('medical');
    expect(classifyZone({ name: '门诊诊室' })).toBe('medical');
    expect(classifyZone({ name: '急诊大厅' })).toBe('medical');
    expect(classifyZone({ name: '第二手术室' })).toBe('medical');
    expect(classifyZone({ name: '中心药房' })).toBe('medical');
  });

  it('matches the UX-W2 industrial vocabulary (English ids and Chinese names)', () => {
    expect(classifyZone({ type: 'workshop' })).toBe('industrial');
    expect(classifyZone({ name: 'Warehouse East' })).toBe('industrial');
    expect(classifyZone({ name: 'Assembly Line 1' })).toBe('industrial');
    expect(classifyZone({ name: 'factory-floor' })).toBe('industrial');
    expect(classifyZone({ name: 'Power Plant' })).toBe('industrial');
    expect(classifyZone({ name: '一号车间' })).toBe('industrial');
    expect(classifyZone({ name: '立体仓库' })).toBe('industrial');
    expect(classifyZone({ name: '产线A段' })).toBe('industrial');
    expect(classifyZone({ name: '主厂房' })).toBe('industrial');
  });

  it('matches the UX-W2 commercial vocabulary (English ids and Chinese names)', () => {
    expect(classifyZone({ name: 'mall-atrium' })).toBe('commercial');
    expect(classifyZone({ name: 'FoodCourt L2' })).toBe('commercial');
    expect(classifyZone({ type: 'shop' })).toBe('commercial');
    expect(classifyZone({ name: '商场中庭' })).toBe('commercial');
    expect(classifyZone({ name: '美食广场' })).toBe('commercial');
    expect(classifyZone({ name: '营业厅' })).toBe('commercial');
  });

  it('keeps campus words on their original categories (no UX-W2 regression)', () => {
    expect(classifyZone({ name: '教学楼101教室' })).toBe('classroom');
    expect(classifyZone({ name: '宿舍3号楼' })).toBe('dormitory');
    expect(classifyZone({ name: '二层走廊' })).toBe('corridor');
    expect(classifyZone({ name: '图书馆' })).toBe('library');
    expect(classifyZone({ name: '室外广场' })).toBe('outdoor');
    expect(classifyZone({ name: '设备间' })).toBe('other');
  });

  it('prefers industrial over commercial for workshop (shop substring)', () => {
    expect(classifyZone({ name: 'Workshop 7' })).toBe('industrial');
  });

  it('falls back to "other" for unrecognized and empty zones', () => {
    expect(classifyZone({ name: '设备间' })).toBe('other');
    expect(classifyZone({})).toBe('other');
  });
});

describe('temperatureHeatColor', () => {
  it('spans cold blue to hot red over the configured range', () => {
    expect(temperatureHeatColor(HEAT_TEMP_MIN)).toBe('hsla(215, 80%, 55%, 0.32)');
    expect(temperatureHeatColor(HEAT_TEMP_MAX)).toBe('hsla(10, 80%, 55%, 0.32)');
  });

  it('clamps out-of-range temperatures to the scale endpoints', () => {
    expect(temperatureHeatColor(-20)).toBe(temperatureHeatColor(HEAT_TEMP_MIN));
    expect(temperatureHeatColor(99)).toBe(temperatureHeatColor(HEAT_TEMP_MAX));
  });
});

describe('comfortBadgeVariant', () => {
  it('maps the three runtime levels to ok/warn/danger', () => {
    expect(comfortBadgeVariant('comfortable')).toBe('ok');
    expect(comfortBadgeVariant('slightly_uncomfortable')).toBe('warn');
    expect(comfortBadgeVariant('uncomfortable')).toBe('danger');
  });

  it('never crashes on unknown levels (warns)', () => {
    expect(comfortBadgeVariant('surprising')).toBe('warn');
    expect(comfortBadgeVariant(undefined)).toBe('warn');
  });
});

describe('readZoneComfort', () => {
  it('extracts a well-formed comfort sub-object', () => {
    expect(
      readZoneComfort({
        temperature: 24,
        comfort: { pmv: 0.3, ppd: 6.5, sensation: 'neutral', comfortLevel: 'comfortable' },
      }),
    ).toEqual({ pmv: 0.3, ppd: 6.5, sensation: 'neutral', comfortLevel: 'comfortable' });
  });

  it('returns null for missing or malformed comfort data', () => {
    expect(readZoneComfort(undefined)).toBeNull();
    expect(readZoneComfort({})).toBeNull();
    expect(readZoneComfort({ comfort: 'neutral' })).toBeNull();
    expect(readZoneComfort({ comfort: { pmv: 'warm', ppd: 5 } })).toBeNull();
  });
});

describe('zoneHeatFill', () => {
  it('prefers the temperature scale when a numeric temperature exists', () => {
    expect(zoneHeatFill({ temperature: 23 })).toBe(temperatureHeatColor(23));
  });

  it('falls back to the comfort tint without a temperature', () => {
    const fill = zoneHeatFill({
      comfort: { pmv: 2, ppd: 80, sensation: 'hot', comfortLevel: 'uncomfortable' },
    });
    expect(fill).toBe('hsla(0, 75%, 55%, 0.30)');
  });

  it('returns null without live data (map keeps the neutral look)', () => {
    expect(zoneHeatFill(undefined)).toBeNull();
    expect(zoneHeatFill({ humidity: 50 })).toBeNull();
  });
});

describe('readOccupancy', () => {
  it('reads finite numbers only', () => {
    expect(readOccupancy({ occupancy: 12 })).toBe(12);
    expect(readOccupancy({ occupancy: 'many' })).toBeNull();
    expect(readOccupancy(undefined)).toBeNull();
  });
});

describe('formatEnergyWh', () => {
  it('formats sub-kWh values as Wh', () => {
    expect(formatEnergyWh(0)).toBe('0 Wh');
    expect(formatEnergyWh(512.4)).toBe('512 Wh');
  });

  it('formats kWh values with two decimals', () => {
    expect(formatEnergyWh(1000)).toBe('1.00 kWh');
    expect(formatEnergyWh(12_345)).toBe('12.35 kWh');
  });

  it('renders missing values as --', () => {
    expect(formatEnergyWh(undefined)).toBe('--');
    expect(formatEnergyWh(null)).toBe('--');
    expect(formatEnergyWh(Number.NaN)).toBe('--');
  });
});

describe('computeDoorGaps', () => {
  const frames = new Map<string, ZoneFrame>([
    ['a', { x: 0, y: 0, width: 100, height: 100 }],
    ['b', { x: 100, y: 0, width: 100, height: 100 }],
    ['c', { x: 400, y: 400, width: 100, height: 100 }],
  ]);

  it('draws one vertical door on the shared wall of touching zones', () => {
    const gaps = computeDoorGaps(
      [{ id: 'a', adjacentZoneIds: ['b'] }, { id: 'b', adjacentZoneIds: ['a'] }],
      frames,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].orientation).toBe('vertical');
    // Centered on the shared edge (x=100) and on the y overlap.
    expect(gaps[0].x + gaps[0].width / 2).toBe(100);
    expect(gaps[0].y + gaps[0].height / 2).toBe(50);
  });

  it('draws a horizontal door for vertically stacked zones', () => {
    const stacked = new Map<string, ZoneFrame>([
      ['a', { x: 0, y: 0, width: 100, height: 100 }],
      ['b', { x: 0, y: 100, width: 100, height: 100 }],
    ]);
    const gaps = computeDoorGaps([{ id: 'a', adjacentZoneIds: ['b'] }], stacked);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].orientation).toBe('horizontal');
    expect(gaps[0].y + gaps[0].height / 2).toBe(100);
  });

  it('skips disjoint pairs (dashed edge fallback stays)', () => {
    expect(computeDoorGaps([{ id: 'a', adjacentZoneIds: ['c'] }], frames)).toHaveLength(0);
  });

  it('skips containment (one zone inside another is not a wall opening)', () => {
    const nested = new Map<string, ZoneFrame>([
      ['outer', { x: 0, y: 0, width: 200, height: 200 }],
      ['inner', { x: 50, y: 50, width: 50, height: 50 }],
    ]);
    expect(
      computeDoorGaps([{ id: 'outer', adjacentZoneIds: ['inner'] }], nested),
    ).toHaveLength(0);
  });

  it('dedupes pairs declared from both sides', () => {
    const gaps = computeDoorGaps(
      [{ id: 'a', adjacentZoneIds: ['b'] }, { id: 'b', adjacentZoneIds: ['a'] }],
      frames,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].id).toBe('door-a::b');
  });
});
