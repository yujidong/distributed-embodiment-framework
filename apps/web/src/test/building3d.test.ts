/**
 * building3d (V3 trial) — pure geometry tests; the three.js component itself
 * needs WebGL and is only covered by tsc.
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../api/types';
import type { ZoneBox } from '../lib/building3d';
import {
  DEFAULT_STOREY_HEIGHT,
  LABEL_ALL_THRESHOLD,
  ZONE_CATEGORY_COLORS,
  computeSceneBounds,
  computeZoneBoxes,
  initialCameraPose,
  resolveStoreyHeight,
} from '../lib/building3d';

function zone(partial: Partial<EnvZone> & { id: string }): EnvZone {
  return { ...partial };
}

/** Ground-plane distance between two fallback boxes (meters). */
function dist(a: ZoneBox, b: ZoneBox): number {
  return Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
}

describe('resolveStoreyHeight', () => {
  it('passes a positive finite value through', () => {
    expect(resolveStoreyHeight(3)).toBe(3);
  });

  it('falls back to 3.5 m for null / undefined / invalid values', () => {
    expect(resolveStoreyHeight(null)).toBe(DEFAULT_STOREY_HEIGHT);
    expect(resolveStoreyHeight(undefined)).toBe(DEFAULT_STOREY_HEIGHT);
    expect(resolveStoreyHeight(0)).toBe(DEFAULT_STOREY_HEIGHT);
    expect(resolveStoreyHeight(-2)).toBe(DEFAULT_STOREY_HEIGHT);
    expect(resolveStoreyHeight(Number.NaN)).toBe(DEFAULT_STOREY_HEIGHT);
  });
});

describe('computeZoneBoxes', () => {
  it('extrudes a bounded zone: center, size and floor stacking in three.js axes', () => {
    const [box] = computeZoneBoxes(
      [
        zone({
          id: 'z1',
          name: '101 教室',
          floor: 2,
          bounds: { minX: 10, maxX: 18, minY: 4, maxY: 12 },
        }),
      ],
      { storeyHeight: 3.5 },
    );
    expect(box.position).toEqual({ x: 14, y: 2 * 3.5 + 3.5 / 2, z: 8 });
    expect(box.size).toEqual({ x: 8, y: 3.5, z: 8 });
    expect(box.fallback).toBe(false);
    // 教室 → classroom category + accent hex, matching the 2D palette.
    expect(box.category).toBe('classroom');
    expect(box.color).toBe(ZONE_CATEGORY_COLORS.classroom);
  });

  it('defaults a missing floor to the ground storey', () => {
    const [box] = computeZoneBoxes([
      zone({ id: 'z1', bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5 } }),
    ]);
    expect(box.floor).toBe(0);
    expect(box.position.y).toBe(DEFAULT_STOREY_HEIGHT / 2);
  });

  it('honours explicit bounds minZ/maxZ over a full storey', () => {
    const [box] = computeZoneBoxes(
      [
        zone({
          id: 'z1',
          floor: 1,
          bounds: { minX: 0, maxX: 5, minY: 0, maxY: 5, minZ: 0.5, maxZ: 2 },
        }),
      ],
      { storeyHeight: 4 },
    );
    expect(box.size.y).toBe(1.5);
    expect(box.position.y).toBeCloseTo(4 + 0.5 + 0.75);
  });

  it('force-places unbounded zones past the bounded area and flags them (R15-E3)', () => {
    const boxes = computeZoneBoxes(
      [
        zone({ id: 'bounded', bounds: { minX: 0, maxX: 20, minY: 0, maxY: 10 } }),
        // Two adjacency clusters: 1↔2 linked, 3 alone — the shared force
        // layout (same as the 2D map) should keep 1 and 2 closer together
        // than either is to 3.
        zone({ id: 'loose-1', adjacentZoneIds: ['loose-2'] }),
        zone({ id: 'loose-2', adjacentZoneIds: ['loose-1'] }),
        zone({ id: 'loose-3' }),
      ],
      { storeyHeight: 3 },
    );
    const byId = new Map(boxes.map(box => [box.zoneId, box]));
    const loose1 = byId.get('loose-1')!;
    expect(loose1.fallback).toBe(true);
    // Cluster origin starts past boundedMaxX (20) + margin.
    expect(loose1.position.x).toBeGreaterThan(20);
    expect(loose1.size).toEqual({ x: 8, y: 3, z: 8 });
    // Adjacency clustering survives the px→meter scale: the linked pair is
    // closer to each other than to the unlinked zone (either axis counts).
    const d12 = dist(loose1, byId.get('loose-2')!);
    const d13 = dist(loose1, byId.get('loose-3')!);
    const d23 = dist(byId.get('loose-2')!, byId.get('loose-3')!);
    expect(d12).toBeLessThan(d13);
    expect(d12).toBeLessThan(d23);
    // Boxes never overlap: pairwise center distance covers the 8m cell.
    for (const [a, b] of [
      [loose1, byId.get('loose-2')!],
      [loose1, byId.get('loose-3')!],
      [byId.get('loose-2')!, byId.get('loose-3')!],
    ] as const) {
      expect(dist(a, b)).toBeGreaterThanOrEqual(8 * 0.9);
    }
  });

  it('keeps the input order in the output', () => {
    const boxes = computeZoneBoxes([
      zone({ id: 'a', bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }),
      zone({ id: 'b' }),
      zone({ id: 'c' }),
    ]);
    expect(boxes.map(box => box.zoneId)).toEqual(['a', 'b', 'c']);
  });

  it('overlays the heat fill when live parameters carry a temperature', () => {
    const [hot, plain] = computeZoneBoxes(
      [
        zone({ id: 'hot', bounds: { minX: 0, maxX: 4, minY: 0, maxY: 4 } }),
        zone({ id: 'plain', bounds: { minX: 10, maxX: 14, minY: 0, maxY: 4 } }),
      ],
      { parametersById: new Map([['hot', { temperature: 30 }]]) },
    );
    expect(hot.heatColor).toMatch(/^hsla\(/);
    expect(plain.heatColor).toBeNull();
  });

  it('de-emphasizes circulation categories with the grey palette entry', () => {
    const [corridor] = computeZoneBoxes([
      zone({ id: 'z1', name: '二层走廊', bounds: { minX: 0, maxX: 4, minY: 0, maxY: 4 } }),
    ]);
    expect(corridor.category).toBe('corridor');
    expect(corridor.color).toBe(ZONE_CATEGORY_COLORS.corridor);
  });
});

describe('computeSceneBounds / initialCameraPose', () => {
  it('returns null for an empty world', () => {
    expect(computeSceneBounds([])).toBeNull();
  });

  it('bounds all boxes and poses the camera outside the scene looking at its center', () => {
    const boxes = computeZoneBoxes(
      [
        zone({ id: 'z1', floor: 0, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } }),
        zone({ id: 'z2', floor: 1, bounds: { minX: 10, maxX: 20, minY: 0, maxY: 10 } }),
      ],
      { storeyHeight: 3 },
    );
    const bounds = computeSceneBounds(boxes)!;
    expect(bounds.center.x).toBe(10);
    expect(bounds.center.z).toBe(5);
    expect(bounds.size).toEqual({ x: 20, y: 6, z: 10 });
    expect(bounds.radius).toBeGreaterThan(0);

    const pose = initialCameraPose(bounds);
    expect(pose.target).toEqual(bounds.center);
    // Camera offset from the center, elevated (positive y), beyond the radius.
    const offset = Math.hypot(
      pose.position.x - bounds.center.x,
      pose.position.y - bounds.center.y,
      pose.position.z - bounds.center.z,
    );
    expect(pose.position.y).toBeGreaterThan(bounds.center.y);
    expect(offset).toBeGreaterThan(bounds.radius);
  });

  it('clamps the distance for tiny scenes so they stay readable', () => {
    const [box] = computeZoneBoxes([
      zone({ id: 'z1', bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 } }),
    ]);
    const pose = initialCameraPose(computeSceneBounds([box])!);
    const offset = Math.hypot(
      pose.position.x - pose.target.x,
      pose.position.y - pose.target.y,
      pose.position.z - pose.target.z,
    );
    expect(offset).toBeGreaterThanOrEqual(8); // distance floor (12) keeps tiny scenes readable
  });
});

describe('LABEL_ALL_THRESHOLD', () => {
  it('stays well below the campus zone count (132 labels would blur)', () => {
    expect(LABEL_ALL_THRESHOLD).toBeLessThan(132);
  });
});
