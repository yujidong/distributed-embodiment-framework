/**
 * R2-BUG-01: resolveWalkBuilding 回落链测试（InteriorWalkPage 楼栋推导的
 * 唯一事实源）——六种 zone 形态 fixture（模板 bounds / 生成器 / OSM polygon /
 * starter-home 无 buildingId / grid / 太仓预烘焙式 positioned rooms）全部
 * 解析出 building；空环境 → null（页面走显式降级页）。
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../api/types';
import {
  WALK_PSEUDO_BUILDING_ID,
  resolveWalkBuilding,
} from '../lib/interior3d/resolveWalkBuilding';
import { rasterFromMapData } from '../lib/interior3d/rasterFromMapData';

const z = (partial: Record<string, unknown>): EnvZone => partial as unknown as EnvZone;

const SQUARE: Array<[number, number]> = [
  [31.0, 120.0],
  [31.0, 120.001],
  [31.0009, 120.001],
  [31.0009, 120.0],
];

describe('resolveWalkBuilding — 回落链', () => {
  it('hinted zone 的 buildingId 优先（第 1 档）', () => {
    const zones = [
      z({ id: 'ward-1f', buildingId: 'inpatient', floor: 0, bounds: { minX: 0, maxX: 40, minY: 0, maxY: 12 } }),
      z({ id: 'other-1f', buildingId: 'clinic', floor: 0, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8 } }),
    ];
    const r = resolveWalkBuilding(zones, 'other-1f')!;
    expect(r.buildingId).toBe('clinic');
    expect(r.floors.map(f => f.zone.id)).toEqual(['other-1f']);
    expect(r.fallbackZoneId).toBeNull();
  });

  it('参数化模板形态（bounds + buildingId，无 positioned rooms）走第 3 档', () => {
    // hospital-ward 展开后的形态
    const zones = [
      z({ id: 'ward-a', buildingId: 'inpatient', floor: 0, bounds: { minX: 0, maxX: 30, minY: 0, maxY: 10 } }),
      z({ id: 'ward-b', buildingId: 'inpatient', floor: 1, bounds: { minX: 0, maxX: 30, minY: 0, maxY: 10 } }),
    ];
    const r = resolveWalkBuilding(zones, null)!;
    expect(r.buildingId).toBe('inpatient');
    expect(r.floors.map(f => f.floor)).toEqual([0, 1]);
  });

  it('楼栋生成器形态（buildingId + 多 floor）解析出整栋楼', () => {
    const zones = [0, 1, 2].map(f =>
      z({ id: `bldg-a-f${f + 1}`, buildingId: 'bldg-a', floor: f, bounds: { minX: 0, maxX: 20, minY: 0, maxY: 12 } }),
    );
    const r = resolveWalkBuilding(zones, null)!;
    expect(r.buildingId).toBe('bldg-a');
    expect(r.floors).toHaveLength(3);
  });

  it('OSM polygon 形态（polygon + buildingId，无 rooms）走第 3 档', () => {
    const zones = [z({ id: 'osm-b1-f1', buildingId: 'osm-b1', floor: 0, polygon: SQUARE })];
    const r = resolveWalkBuilding(zones, null)!;
    expect(r.buildingId).toBe('osm-b1');
  });

  it('positioned rooms 楼优先于裸 buildingId 楼（第 2 档在第 3 档之前）', () => {
    const zones = [
      z({ id: 'bare', buildingId: 'b-bare', floor: 0, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } }),
      z({
        id: 'roomed',
        buildingId: 'b-roomed',
        floor: 0,
        bounds: { minX: 0, maxX: 20, minY: 0, maxY: 10 },
        rooms: [{ code: 'R-101', name: '会议室', pos: [0.5, 0.5] }],
      }),
    ];
    const r = resolveWalkBuilding(zones, null)!;
    expect(r.buildingId).toBe('b-roomed');
  });

  it('starter-home 形态（bounds、无 buildingId）合成伪楼栋并规范化 zones', () => {
    const zones = [
      z({ id: 'living-room', name: '客厅', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 } }),
      z({ id: 'bedroom', name: '卧室', bounds: { minX: 0, maxX: 6, minY: 5, maxY: 9 } }),
      z({ id: 'balcony', name: '阳台', bounds: { minX: 6, maxX: 10, minY: 0, maxY: 5 } }),
    ];
    const r = resolveWalkBuilding(zones, null)!;
    expect(r.buildingId).toBe(WALK_PSEUDO_BUILDING_ID);
    expect(r.floors).toHaveLength(1); // 全部 floor 0 折叠成一层
    for (const zone of r.zones) expect(zone.buildingId).toBe(WALK_PSEUDO_BUILDING_ID);
    // hint 命中伪楼栋内的 zone → 无需 URL 校正
    expect(resolveWalkBuilding(zones, 'bedroom')!.fallbackZoneId).toBeNull();
  });

  it('grid 形态（无 buildingId 无几何）也解析出伪楼栋（栅格化阶段再显式降级）', () => {
    const zones = [z({ id: 'cell-1' }), z({ id: 'cell-2' })];
    const r = resolveWalkBuilding(zones, null)!;
    expect(r.buildingId).toBe(WALK_PSEUDO_BUILDING_ID);
    expect(r.floors).toHaveLength(1);
  });

  it('未知 ?zone= 指向不存在的 zone → fallbackZoneId 指向落点楼第一层', () => {
    const zones = [
      z({ id: 'ward-a', buildingId: 'inpatient', floor: 0, bounds: { minX: 0, maxX: 30, minY: 0, maxY: 10 } }),
    ];
    const r = resolveWalkBuilding(zones, 'ghost-zone')!;
    expect(r.buildingId).toBe('inpatient');
    expect(r.fallbackZoneId).toBe('ward-a');
  });

  it('hinted zone 无 buildingId 而别的楼有 → 回落到有 buildingId 的楼并校正 URL', () => {
    const zones = [
      z({ id: 'lawn', bounds: { minX: 0, maxX: 8, minY: 0, maxY: 8 } }),
      z({ id: 'hall-1f', buildingId: 'b-hall', floor: 0, bounds: { minX: 0, maxX: 12, minY: 0, maxY: 9 } }),
    ];
    const r = resolveWalkBuilding(zones, 'lawn')!;
    expect(r.buildingId).toBe('b-hall');
    expect(r.fallbackZoneId).toBe('hall-1f');
  });

  it('zones 为空 → null（页面显式降级，不再永久 Loading）', () => {
    expect(resolveWalkBuilding([], null)).toBeNull();
  });
});

describe('resolveWalkBuilding → rasterFromMapData 集成', () => {
  it('无 buildingId 的 zone 规范化后可栅格化（starter-home 全链路）', () => {
    const zones = [
      z({ id: 'living-room', name: '客厅', bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 }, adjacentZoneIds: ['bedroom'] }),
      z({ id: 'bedroom', name: '卧室', bounds: { minX: 0, maxX: 6, minY: 5, maxY: 9 } }),
    ];
    const r = resolveWalkBuilding(zones, 'living-room')!;
    const out = rasterFromMapData(r.zones, r.buildingId, r.floors[0].floor);
    expect(out).not.toBeNull();
    // 两个 zone 共边 → 雕门洞；zone-as-room 标签带显示名
    expect(out!.raster.doors).toHaveLength(1);
    expect(out!.raster.labels.map(l => l.name)).toEqual(
      expect.arrayContaining(['客厅', '卧室']),
    );
  });
});
