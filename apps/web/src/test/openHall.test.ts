/**
 * Open-hall detection tests (R97): basement parking levels extract with no
 * rooms/floor plates and a "wall" set that is really dense drawing
 * line-work (74~84% envelope coverage). The raster path falls back to a
 * perimeter envelope for those floors; normal storeys must not trigger it.
 */

import { describe, expect, it } from 'vitest';

import { isOpenHallRaster, wallEnvelope, OPEN_HALL_COVERAGE } from '../components/interior/openHall';
import type { WallBox } from '../components/interior/wallCleanup';

/** Dense parking-bay line grid (like bldg-j-b1): fat overlapping strips
 *  every 2m — the extractor double-draws bay lines, real coverage ~84%. */
function parkingGrid(width: number, depth: number): WallBox[] {
  const walls: WallBox[] = [];
  for (let x = 1; x < width; x += 2) walls.push([x, depth / 2, 1.2, depth]);
  for (let z = 1; z < depth; z += 2) walls.push([width / 2, z, width, 1.2]);
  return walls;
}

/** Normal storey: thin perimeter + a few partitions (~5% coverage). */
function normalWalls(width: number, depth: number): WallBox[] {
  return [
    [width / 2, 0.1, width, 0.2],
    [width / 2, depth - 0.1, width, 0.2],
    [0.1, depth / 2, 0.2, depth],
    [width - 0.1, depth / 2, 0.2, depth],
    [width / 2, depth / 2, width * 0.6, 0.2],
    [width / 3, depth / 2, 0.2, depth * 0.4],
  ];
}

describe('wallEnvelope', () => {
  it('returns the axis-aligned bbox of the wall boxes', () => {
    const env = wallEnvelope([[5, 5, 2, 4], [10, 8, 4, 2]]);
    expect(env).toEqual({ minX: 4, maxX: 12, minZ: 3, maxZ: 9 });
  });

  it('returns null for empty input', () => {
    expect(wallEnvelope([])).toBeNull();
  });
});

describe('isOpenHallRaster', () => {
  it('flags a room-less floor whose walls pack the envelope (B1 parking)', () => {
    const walls = parkingGrid(48, 31);
    const env = wallEnvelope(walls)!;
    const area = walls.reduce((a, [, , w, d]) => a + w * d, 0);
    const coverage = area / ((env.maxX - env.minX) * (env.maxZ - env.minZ));
    expect(coverage).toBeGreaterThan(OPEN_HALL_COVERAGE);
    expect(isOpenHallRaster({ walls, floor: [] })).toBe(true);
  });

  it('does not flag a normal storey (sparse partitions)', () => {
    expect(isOpenHallRaster({ walls: normalWalls(100, 80), floor: [] })).toBe(false);
  });

  it('does not flag floors that carry room or plate data', () => {
    const walls = parkingGrid(48, 31);
    expect(isOpenHallRaster({ walls, floor: [], rooms: [{}] })).toBe(false);
    expect(isOpenHallRaster({ walls, floor: [[10, 10, 4, 4]] })).toBe(false);
  });

  it('does not flag an empty floor (no walls at all)', () => {
    expect(isOpenHallRaster({ walls: [], floor: [] })).toBe(false);
  });
});
