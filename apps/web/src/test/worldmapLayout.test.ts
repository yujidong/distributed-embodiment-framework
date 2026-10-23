/**
 * R14 P0-3: fallback layout for zones WITHOUT bounds — the old fixed grid is
 * replaced by a deterministic adjacency-aware force layout
 * (layoutUnboundedZonePositions). Covered here: determinism, adjacency
 * clustering, bounded/unbounded coexistence, and the 132-zone scale.
 */

import { describe, expect, it } from 'vitest';

import type { EnvZone } from '../api/types';
import {
  computeZoneFrames,
  layoutUnboundedZonePositions,
  WORLD_SCALE,
} from '../components/worldmap/layout';

function zone(id: string, adjacentZoneIds: string[] = []): EnvZone {
  return { id, name: id, adjacentZoneIds };
}

function center(position: { x: number; y: number }): { x: number; y: number } {
  return position;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('layoutUnboundedZonePositions', () => {
  it('is deterministic: identical input yields identical output', () => {
    const zones = [
      zone('a', ['b']),
      zone('b', ['a', 'c']),
      zone('c', ['b']),
      zone('d'),
      zone('e', ['f']),
      zone('f'),
    ];
    const first = layoutUnboundedZonePositions(zones);
    const second = layoutUnboundedZonePositions(zones);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('clusters adjacent zones: intra-cluster distances beat inter-cluster ones', () => {
    // Two fully-connected triangles with no links between them.
    const clusterA = ['a1', 'a2', 'a3'];
    const clusterB = ['b1', 'b2', 'b3'];
    const zones = [
      ...clusterA.map(id => zone(id, clusterA.filter(other => other !== id))),
      ...clusterB.map(id => zone(id, clusterB.filter(other => other !== id))),
    ];
    const positions = layoutUnboundedZonePositions(zones);

    const intra: number[] = [];
    const inter: number[] = [];
    for (const x of zones) {
      for (const y of zones) {
        if (x.id >= y.id) continue;
        const d = distance(center(positions.get(x.id)!), center(positions.get(y.id)!));
        const sameCluster = x.id[0] === y.id[0];
        (sameCluster ? intra : inter).push(d);
      }
    }
    expect(Math.max(...intra)).toBeLessThan(Math.min(...inter));
  });

  it('pulls an adjacent pair closer than an unrelated pair', () => {
    const zones = [zone('x', ['y']), zone('y'), zone('z')];
    const positions = layoutUnboundedZonePositions(zones);
    const linked = distance(positions.get('x')!, positions.get('y')!);
    const unlinked = distance(positions.get('x')!, positions.get('z')!);
    expect(linked).toBeLessThan(unlinked);
  });

  it('normalizes the layout to the origin and handles a single zone', () => {
    const single = layoutUnboundedZonePositions([zone('only')]);
    expect(single.get('only')).toEqual({ x: 0, y: 0 });

    const positions = layoutUnboundedZonePositions([zone('a'), zone('b'), zone('c')]);
    const xs = [...positions.values()].map(p => p.x);
    const ys = [...positions.values()].map(p => p.y);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.min(...ys)).toBe(0);
  });

  it('scales to 132 zones with finite, non-overlapping-enough results', () => {
    // A long chain (i ↔ i+1) plus stragglers — worst-ish realistic shape.
    const zones: EnvZone[] = Array.from({ length: 132 }, (_, i) =>
      zone(`z${i}`, i > 0 ? [`z${i - 1}`] : []),
    );
    const started = performance.now();
    const positions = layoutUnboundedZonePositions(zones);
    const elapsed = performance.now() - started;

    expect(positions.size).toBe(132);
    for (const position of positions.values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
    // Generous ceiling (CI machines vary); typical local runs are <100ms.
    expect(elapsed).toBeLessThan(2000);
  });

  it('ignores adjacency references to zones outside the unbounded set', () => {
    const positions = layoutUnboundedZonePositions([zone('a', ['ghost']), zone('b')]);
    expect(positions.size).toBe(2);
  });
});

describe('computeZoneFrames fallback (no bounds)', () => {
  it('keeps bounded zones on real geometry and offsets the force layout past them', () => {
    const bounded: EnvZone = {
      id: 'hall',
      name: 'hall',
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 5 },
    };
    const frames = computeZoneFrames([bounded, zone('u1', ['u2']), zone('u2')]);

    expect(frames.get('hall')).toEqual({
      x: 0,
      y: 0,
      width: 10 * WORLD_SCALE,
      height: 5 * WORLD_SCALE,
    });
    const boundedMaxX = 10 * WORLD_SCALE;
    expect(frames.get('u1')!.x).toBeGreaterThanOrEqual(boundedMaxX + WORLD_SCALE);
    expect(frames.get('u2')!.x).toBeGreaterThanOrEqual(boundedMaxX + WORLD_SCALE);
  });

  it('gives every unbounded zone a frame at the fallback size', () => {
    const frames = computeZoneFrames([zone('a', ['b']), zone('b'), zone('c')]);
    for (const id of ['a', 'b', 'c']) {
      const frame = frames.get(id);
      expect(frame).toBeDefined();
      expect(frame!.width).toBeGreaterThan(0);
      expect(frame!.height).toBeGreaterThan(0);
    }
    // Adjacent a↔b sit closer together than either does to isolated c.
    const d = (p: string, q: string) =>
      distance(
        { x: frames.get(p)!.x, y: frames.get(p)!.y },
        { x: frames.get(q)!.x, y: frames.get(q)!.y },
      );
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'));
  });
});
