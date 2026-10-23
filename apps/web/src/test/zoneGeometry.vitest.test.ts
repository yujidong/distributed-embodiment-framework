/**
 * UX-W2 zone geometry editing tests (lib/zoneGeometry):
 * - vertex move / edge-midpoint insertion / vertex removal with the
 *   min-3 ring constraint (removeVertexAt returns null instead of a
 *   degenerate ring);
 * - grid bounds translation (canvas drag move).
 */

import { describe, expect, it } from 'vitest';

import {
  edgeMidpoint,
  insertVertexAtEdge,
  moveVertex,
  removeVertexAt,
  translateBounds,
} from '../lib/zoneGeometry';

const A: [number, number] = [31.3, 120.6];
const B: [number, number] = [31.31, 120.6];
const C: [number, number] = [31.31, 120.61];
const D: [number, number] = [31.3, 120.61];

describe('moveVertex', () => {
  it('replaces only the addressed vertex', () => {
    const moved: [number, number] = [31.32, 120.62];
    expect(moveVertex([A, B, C], 1, moved)).toEqual([A, moved, C]);
  });

  it('out-of-range indices are a no-op copy', () => {
    expect(moveVertex([A, B, C], 5, A)).toEqual([A, B, C]);
    expect(moveVertex([A, B, C], -1, A)).toEqual([A, B, C]);
  });
});

describe('insertVertexAtEdge', () => {
  it('inserts the edge midpoint after the edge start vertex', () => {
    const [midLat, midLng] = edgeMidpoint(A, C);
    expect(midLat).toBeCloseTo(31.305, 10);
    expect(midLng).toBeCloseTo(120.605, 10);
    const inserted = insertVertexAtEdge([A, B, C], 0);
    expect(inserted).toHaveLength(4);
    expect(inserted[0]).toEqual(A);
    expect(inserted[1]).toEqual(edgeMidpoint(A, B));
    expect(inserted[2]).toEqual(B);
  });

  it('wraps around the ring for the closing edge', () => {
    const inserted = insertVertexAtEdge([A, B, C], 2);
    expect(inserted[3]).toEqual(edgeMidpoint(C, A));
  });

  it('rejects out-of-range edges and degenerate input', () => {
    expect(insertVertexAtEdge([A, B, C], 3)).toEqual([A, B, C]);
    expect(insertVertexAtEdge([A], 0)).toEqual([A]);
  });
});

describe('removeVertexAt', () => {
  it('removes the addressed vertex when the ring stays >= 3', () => {
    expect(removeVertexAt([A, B, C, D], 1)).toEqual([A, C, D]);
  });

  it('refuses to drop a triangle below the min ring (null)', () => {
    expect(removeVertexAt([A, B, C], 0)).toBeNull();
  });

  it('out-of-range indices are a no-op copy', () => {
    expect(removeVertexAt([A, B, C, D], 9)).toEqual([A, B, C, D]);
  });
});

describe('translateBounds', () => {
  it('shifts all four edges, preserving the optional z extent', () => {
    expect(
      translateBounds({ minX: 0, maxX: 6, minY: 0, maxY: 4, minZ: 0, maxZ: 3 }, 2, -1),
    ).toEqual({ minX: 2, maxX: 8, minY: -1, maxY: 3, minZ: 0, maxZ: 3 });
  });
});
