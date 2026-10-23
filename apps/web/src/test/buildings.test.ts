/**
 * buildings（W4 楼栋 chip 分组）——buildingId 去重/排序/空值过滤与
 * 楼栋 zone 过滤；R97 增加 defaultActiveFloor（平面视图默认楼层）用例。
 */

import { describe, expect, it } from 'vitest';

import { defaultActiveFloor, floorLabeling, listBuildings, zoneIdsInBuilding } from '../lib/buildings';

describe('listBuildings', () => {
  it('returns distinct building ids sorted', () => {
    const zones = [
      { id: 'z1', buildingId: 'TB1' },
      { id: 'z2', buildingId: 'DORM1' },
      { id: 'z3', buildingId: 'TB1' },
      { id: 'z4', buildingId: 'LIB1' },
    ];
    expect(listBuildings(zones)).toEqual(['DORM1', 'LIB1', 'TB1']);
  });

  it('skips zones without a buildingId (and blank ones)', () => {
    const zones = [
      { id: 'z1' },
      { id: 'z2', buildingId: '  ' },
      { id: 'z3', buildingId: 'TB1' },
    ];
    expect(listBuildings(zones)).toEqual(['TB1']);
  });

  it('returns [] when no zone carries building metadata', () => {
    expect(listBuildings([{ id: 'z1' }, { id: 'z2' }])).toEqual([]);
    expect(listBuildings([])).toEqual([]);
  });
});

describe('zoneIdsInBuilding', () => {
  const zones = [
    { id: 'z1', buildingId: 'TB1' },
    { id: 'z2', buildingId: 'TB1' },
    { id: 'z3', buildingId: 'DORM1' },
    { id: 'z4' },
  ];

  it('collects exactly the zones of the given building', () => {
    expect(zoneIdsInBuilding(zones, 'TB1')).toEqual(new Set(['z1', 'z2']));
  });

  it('returns an empty set for an unknown building', () => {
    expect(zoneIdsInBuilding(zones, 'NOPE').size).toBe(0);
  });
});

describe('defaultActiveFloor (R97)', () => {
  it('picks the storey with the most zones, not the lowest (basement) one', () => {
    // bldg with a B1: B1 has 2 zones, 1F has 19 — default must be 1F(0)
    const zones = [
      ...Array.from({ length: 2 }, () => ({ floor: -1 })),
      ...Array.from({ length: 19 }, () => ({ floor: 0 })),
      ...Array.from({ length: 12 }, () => ({ floor: 1 })),
    ];
    expect(defaultActiveFloor(zones, [-1, 0, 1])).toBe(0);
  });

  it('breaks count ties towards the ground floor', () => {
    const zones = [
      ...Array.from({ length: 5 }, () => ({ floor: -1 })),
      ...Array.from({ length: 5 }, () => ({ floor: 0 })),
      ...Array.from({ length: 5 }, () => ({ floor: 2 })),
    ];
    expect(defaultActiveFloor(zones, [-1, 0, 2])).toBe(0);
  });

  it('treats zones without floor metadata as ground (0)', () => {
    const zones = [{}, { floor: 1 }, {}];
    expect(defaultActiveFloor(zones, [0, 1])).toBe(0);
  });
});

describe('floorLabeling (R101: ONE floor grouping/labeling source)', () => {
  it('0-based model (design doc): indoor floor 0 → 1F, floor 1 → 2F, B1 stays', () => {
    const zones = [
      { floor: -1, type: 'storage' },
      { floor: 0, type: 'lobby' },
      { floor: 0, type: 'classroom' },
      { floor: 1, type: 'office' },
      { floor: 3, type: 'office' },
    ];
    const labeling = floorLabeling(zones, '楼外');
    expect(labeling.outdoorGround).toBe(false);
    expect(labeling.label(-1)).toBe('B1');
    expect(labeling.label(0)).toBe('1F');
    expect(labeling.label(1)).toBe('2F');
    expect(labeling.label(3)).toBe('4F');
  });

  it('AIoT 实验楼 convention (the bug): outdoor ground at 0 + 1-based indoor — 1F=一层, 2F=二层, outdoor=楼外, NO phantom 3F', () => {
    // The exact lab-env shape: 一层×4 (floor 1), 二层×3 (floor 2), 楼外广场 (floor 0).
    const zones = [
      { floor: 1, type: 'lobby' },
      { floor: 1, type: 'corridor' },
      { floor: 1, type: 'classroom' },
      { floor: 1, type: 'classroom' },
      { floor: 2, type: 'corridor' },
      { floor: 2, type: 'office' },
      { floor: 2, type: 'meeting' },
      { floor: 0, type: 'outdoor' },
    ];
    const labeling = floorLabeling(zones, '楼外');
    expect(labeling.outdoorGround).toBe(true);
    expect(labeling.label(0)).toBe('楼外');
    expect(labeling.label(1)).toBe('1F'); // 一层大厅标 1F（曾经错标 2F）
    expect(labeling.label(2)).toBe('2F'); // 二层标 2F（曾经错标 3F）
  });

  it('mixed ground storey (outdoor + indoor both at floor 0) keeps the 0-based model', () => {
    const zones = [
      { floor: 0, type: 'outdoor' },
      { floor: 0, type: 'lobby' },
      { floor: 1, type: 'office' },
    ];
    const labeling = floorLabeling(zones, '楼外');
    expect(labeling.outdoorGround).toBe(false);
    expect(labeling.label(0)).toBe('1F');
    expect(labeling.label(1)).toBe('2F');
  });

  it('outdoor-only ground with nothing above it is NOT the 1-based convention', () => {
    const labeling = floorLabeling([{ floor: 0, type: 'outdoor' }], '楼外');
    expect(labeling.outdoorGround).toBe(false);
    expect(labeling.label(0)).toBe('1F');
  });
});
