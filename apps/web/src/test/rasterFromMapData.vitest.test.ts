/**
 * UX-W4 runtime rasterizer tests (lib/interior3d/rasterFromMapData):
 * - single polygon zone → rotated perimeter walls, zone-as-room fallback,
 *   top-level width/height, exact direct geo mapping round-trip;
 * - positioned rooms → axis-Voronoi room cells (tiling, non-overlapping);
 * - two bounds zones → door carving on the shared edge, by declared
 *   adjacency OR shared-edge inference (共边), wall emitted once + gap;
 * - zones without polygon AND bounds are skipped; empty floor → null.
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../api/types';
import { latLngToPlanMeters, planToLatLng } from '../lib/interior3d/geoPlan';
import {
  pastelFor,
  rasterFromMapData,
  voronoiRooms,
} from '../lib/interior3d/rasterFromMapData';

const z = (partial: Record<string, unknown>): EnvZone => partial as unknown as EnvZone;

/** ~100m × ~95m square footprint around (31.0, 120.0). */
const SQUARE: Array<[number, number]> = [
  [31.0, 120.0],
  [31.0, 120.001],
  [31.0009, 120.001],
  [31.0009, 120.0],
];

describe('rasterFromMapData — single polygon zone', () => {
  const zone = z({ id: 'bldg-x-f1', name: 'X 楼 1F', buildingId: 'bldg-x', floor: 1, polygon: SQUARE });
  const result = rasterFromMapData([zone], 'bldg-x', 1)!;

  it('builds a raster with rotated perimeter walls and top-level size', () => {
    expect(result).not.toBeNull();
    const { raster } = result;
    expect(raster.walls.length).toBe(4);
    for (const wall of raster.walls) expect(wall).toHaveLength(5); // rot 携带
    expect(raster.width).toBeGreaterThan(80);
    expect(raster.height).toBeGreaterThan(80);
    expect(raster.floor).toHaveLength(1);
    expect(raster.wallHeight).toBe(2.6);
  });

  it('falls back to zone-as-room when no positioned rooms exist', () => {
    const { raster } = result;
    expect(raster.rooms).toHaveLength(1);
    expect(raster.rooms![0].code).toBe('bldg-x-f1');
    expect(raster.rooms![0].zoneId).toBe('bldg-x-f1');
    expect(raster.labels.map(l => l.code)).toContain('bldg-x-f1');
  });

  it('provides an exact direct geo mapping (round-trip)', () => {
    expect(result.geoMapping).not.toBeNull();
    const map = result.geoMapping!;
    const { lat, lng } = planToLatLng(map, 12.3, 45.6);
    const back = latLngToPlanMeters(map, lat, lng);
    expect(back.x).toBeCloseTo(12.3, 6);
    expect(back.z).toBeCloseTo(45.6, 6);
  });

  it('anchors the floor at the origin', () => {
    const { raster } = result;
    const [cx, cz, w, d] = raster.floor[0];
    expect(cx - w / 2).toBeCloseTo(0, 6);
    expect(cz - d / 2).toBeCloseTo(0, 6);
  });
});

describe('rasterFromMapData — positioned rooms subdivide the zone', () => {
  const zone = z({
    id: 'bldg-y-f2',
    name: 'Y 楼 2F',
    buildingId: 'bldg-y',
    floor: 2,
    polygon: SQUARE,
    rooms: [
      { code: 'Y-201', name: '会议室', pos: [0.25, 0.5] },
      { code: 'Y-202', name: '办公', pos: [0.75, 0.5], hours: '9:00-18:00' },
    ],
  });
  const { raster } = rasterFromMapData([zone], 'bldg-y', 2)!;

  it('emits one room + label per positioned room, cells inside the floor', () => {
    expect(raster.rooms).toHaveLength(2);
    const [fx, fz, fw, fd] = raster.floor[0];
    for (const room of raster.rooms!) {
      expect(room.zoneId).toBe('bldg-y-f2');
      for (const [cx, cz, w, d] of room.boxes) {
        expect(cx - w / 2).toBeGreaterThanOrEqual(fx - fw / 2 - 1e-6);
        expect(cx + w / 2).toBeLessThanOrEqual(fx + fw / 2 + 1e-6);
        expect(cz - d / 2).toBeGreaterThanOrEqual(fz - fd / 2 - 1e-6);
      }
    }
    const codes = raster.labels.map(l => l.code);
    expect(codes).toEqual(expect.arrayContaining(['Y-201', 'Y-202']));
    expect(raster.labels.find(l => l.code === 'Y-202')?.hours).toBe('9:00-18:00');
  });

  it('bisects two side-by-side rooms without overlap', () => {
    const a = raster.rooms!.find(r => r.code === 'Y-201')!.boxes[0];
    const b = raster.rooms!.find(r => r.code === 'Y-202')!.boxes[0];
    const aMax = a[0] + a[2] / 2;
    const bMin = b[0] - b[2] / 2;
    expect(aMax).toBeLessThanOrEqual(bMin + 1e-6);
    // 中分线 ≈ 楼层宽度一半
    expect(aMax).toBeCloseTo(raster.width! / 2, 3);
  });
});

describe('rasterFromMapData — bounds zones & door carving', () => {
  const a = z({
    id: 'z-a',
    name: 'A 区',
    buildingId: 'b1',
    floor: 0,
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8 },
    adjacentZoneIds: ['z-b'],
  });
  const b = z({
    id: 'z-b',
    name: 'B 区',
    buildingId: 'b1',
    floor: 0,
    bounds: { minX: 10, maxX: 20, minY: 0, maxY: 8 },
  });

  it('carves a door on the shared edge (declared adjacency)', () => {
    const { raster } = rasterFromMapData([a, b], 'b1', 0)!;
    expect(raster.doors).toHaveLength(1);
    const [dx, dz, dir] = raster.doors![0] as [number, number, 'x' | 'z'];
    expect(dx).toBeCloseTo(10, 6);
    expect(dz).toBeCloseTo(4, 6);
    expect(dir).toBe('z');
    // 门点不落在任何墙盒内（洞口已雕出）
    for (const [cx, cz, w, d] of raster.walls) {
      const inside = Math.abs(dx - cx) < w / 2 - 1e-9 && Math.abs(dz - cz) < d / 2 - 1e-9;
      expect(inside).toBe(false);
    }
    // 共边墙只发一次：x≈10 的竖墙恰好两段（门洞上下）
    const shared = raster.walls.filter(([cx, , w, d]) => Math.abs(cx - 10) < 0.2 && d > w);
    expect(shared).toHaveLength(2);
  });

  it('infers the same door from a shared edge without declared adjacency (共边)', () => {
    const a2 = z({ ...a, adjacentZoneIds: undefined });
    const { raster } = rasterFromMapData([a2, b], 'b1', 0)!;
    expect(raster.doors).toHaveLength(1);
  });

  it('emits no doors between separated zones', () => {
    const far = z({
      id: 'z-c',
      name: 'C 区',
      buildingId: 'b1',
      floor: 0,
      bounds: { minX: 30, maxX: 40, minY: 0, maxY: 8 },
    });
    const { raster } = rasterFromMapData([a, far], 'b1', 0)!;
    expect(raster.doors).toHaveLength(0);
  });

  it('re-anchors multi-zone floors to the origin', () => {
    const off = z({
      id: 'z-d',
      name: 'D 区',
      buildingId: 'b1',
      floor: 0,
      bounds: { minX: 100, maxX: 110, minY: 50, maxY: 58 },
    });
    const { raster } = rasterFromMapData([off], 'b1', 0)!;
    const [cx, cz, w, d] = raster.floor[0];
    expect(cx - w / 2).toBeCloseTo(0, 6);
    expect(cz - d / 2).toBeCloseTo(0, 6);
    expect(raster.width).toBeCloseTo(10, 6);
  });
});

describe('rasterFromMapData — rejection & helpers', () => {
  it('skips zones without polygon AND bounds; null when the floor is empty', () => {
    const bare = z({ id: 'z-bare', buildingId: 'b1', floor: 0 });
    expect(rasterFromMapData([bare], 'b1', 0)).toBeNull();
    expect(rasterFromMapData([], 'b1', 0)).toBeNull();
    const other = z({ id: 'z-o', buildingId: 'b2', floor: 0, bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } });
    expect(rasterFromMapData([other], 'b1', 0)).toBeNull(); // building 不匹配
  });

  it('R2-BUG-01: 无 buildingId 的 zone 规范化（__default__）后可栅格化', () => {
    // starter-home 形态：zone 连 buildingId 都没有；resolveWalkBuilding 第 4
    // 档规范化后 rasterFromMapData 照常产出（含 zone-as-room 标签）。
    const zones = [
      z({ id: 'living-room', name: '客厅', buildingId: '__default__', floor: 0, bounds: { minX: 0, maxX: 6, minY: 0, maxY: 5 } }),
    ];
    const { raster } = rasterFromMapData(zones, '__default__', 0)!;
    expect(raster.walls.length).toBe(4);
    expect(raster.labels[0]).toMatchObject({ code: 'living-room', name: '客厅' });
  });

  it('pastelFor is deterministic and in gamut', () => {
    const c1 = pastelFor('A-301');
    expect(c1).toEqual(pastelFor('A-301'));
    expect(pastelFor('A-301')).not.toEqual(pastelFor('A-302'));
    for (const v of c1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('voronoiRooms tiles the rect without overlap', () => {
    const rect = { minX: 0, maxX: 12, minZ: 0, maxZ: 8 };
    const centers = [
      { x: 3, z: 2 },
      { x: 9, z: 2 },
      { x: 3, z: 6 },
      { x: 9, z: 6 },
    ];
    const cells = voronoiRooms(centers, rect);
    let area = 0;
    for (const c of cells) area += (c.maxX - c.minX) * (c.maxZ - c.minZ);
    expect(area).toBeCloseTo(12 * 8, 6); // 完整铺满 = 互不重叠
    expect(cells[0].maxX).toBeCloseTo(6, 6);
    expect(cells[0].maxZ).toBeCloseTo(4, 6);
  });
});
