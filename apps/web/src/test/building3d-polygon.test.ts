/**
 * R82 guards — the polygon-footprint extrusion layer (geo buildings):
 *  ① polygon zones are SKIPPED by the box path (no double mesh, no fallback
 *     grid placement for real footprints)
 *  ② projection: equirectangular meters around the shared anchor, north →
 *     negative z (the z = south convention of the box path)
 *  ③ floor stacking mirrors the box path (baseY = floor × storey)
 *  ④ multi-building anchor: relative placement preserved (east building
 *     lands at larger x)
 *  ⑤ scene bounds merge both mesh families
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../api/types';
import {
  computeSceneBoundsWithExtrusions,
  computeZoneBoxes,
  computeZoneExtrusions,
} from '../lib/building3d';

function geoZone(partial: Partial<EnvZone> & { id: string; polygon: [number, number][] }): EnvZone {
  return partial as EnvZone;
}

const RING_SQUARE_100M: [number, number][] = [
  [31.484, 121.157],
  [31.484, 121.1581], // ~+0.0011° lng ≈ +104 m east at this latitude
  [31.4849, 121.1581], // ~+0.0009° lat ≈ +99.5 m north
  [31.4849, 121.157],
];

describe('computeZoneExtrusions (R82 geo footprints)', () => {
  it('projects the ring into meters around its centroid, north → -z', () => {
    const [ext] = computeZoneExtrusions([
      geoZone({ id: 'd-f1', name: 'D栋 F1', polygon: RING_SQUARE_100M }),
    ]);
    expect(ext).toBeDefined();
    // ~100 m square, centered on the centroid → ±~52 m on both axes.
    const width = ext.bbox.maxX - ext.bbox.minX;
    const depth = ext.bbox.maxZ - ext.bbox.minZ;
    expect(width).toBeGreaterThan(95);
    expect(width).toBeLessThan(110);
    expect(depth).toBeGreaterThan(95);
    expect(depth).toBeLessThan(110);
    // North edge (max latitude) maps to the MOST NEGATIVE z.
    const northmost = Math.max(...RING_SQUARE_100M.map(p => p[0]));
    const northPoint = ext.points[RING_SQUARE_100M.findIndex(p => p[0] === northmost)];
    expect(northPoint.z).toBeLessThan(ext.bbox.minZ + 1);
  });

  it('stacks by floor exactly like the box path', () => {
    const zones = [0, 1, 2].map(floor =>
      geoZone({ id: `d-f${floor + 1}`, polygon: RING_SQUARE_100M, floor }),
    );
    const exts = computeZoneExtrusions(zones);
    expect(exts.map(e => e.baseY)).toEqual([0, 3.5, 7]);
    expect(exts.every(e => e.height === 3.5)).toBe(true);
  });

  it('polygon zones are skipped by the box path (no slab, no fallback cell)', () => {
    const zones = [
      geoZone({ id: 'poly', polygon: RING_SQUARE_100M, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }),
      geoZone({ id: 'free', name: 'unbounded grid zone', polygon: [] }),
    ];
    const boxes = computeZoneBoxes(zones);
    expect(boxes.map(b => b.zoneId)).toEqual(['free']);
    expect(boxes[0]!.fallback).toBe(true);
  });

  it('multi-building anchor keeps relative placement (east → larger x)', () => {
    const west = RING_SQUARE_100M;
    const east = RING_SQUARE_100M.map(([lat, lng]) => [lat, lng + 0.002] as [number, number]);
    const exts = computeZoneExtrusions([
      geoZone({ id: 'west', polygon: west }),
      geoZone({ id: 'east', polygon: east }),
    ]);
    const westCenter = (exts[0]!.bbox.minX + exts[0]!.bbox.maxX) / 2;
    const eastCenter = (exts[1]!.bbox.minX + exts[1]!.bbox.maxX) / 2;
    // Centroids 0.002° lng apart ≈ 190 m (shared anchor, not per-zone).
    expect(eastCenter - westCenter).toBeGreaterThan(175);
    expect(eastCenter - westCenter).toBeLessThan(205);
  });

  it('scene bounds merge boxes and extrusions', () => {
    const bounds = computeSceneBoundsWithExtrusions(
      [],
      computeZoneExtrusions([geoZone({ id: 'd-f1', polygon: RING_SQUARE_100M, floor: 1 })]),
    );
    expect(bounds).not.toBeNull();
    expect(bounds!.size.y).toBeCloseTo(3.5, 5);
    expect(bounds!.size.x).toBeGreaterThan(95);
  });
});
