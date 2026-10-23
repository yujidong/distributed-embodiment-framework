/**
 * Zone geometry editing (UX-W2) — pure vertex/bounds operations behind the
 * geo polygon vertex editor (Leaflet handles) and the grid canvas zone drag:
 *
 * - `moveVertex` / `insertVertexAtEdge` / `removeVertexAt` operate on a
 *   [lat, lng] ring; a ring never drops below 3 vertices (removeVertexAt
 *   returns null instead of producing a degenerate zone);
 * - `translateBounds` shifts a grid zone rectangle by a world-unit delta
 *   (the canvas drag moves the whole rect — edge/corner resize stays on the
 *   numeric form for now).
 */

import type { ZoneBounds } from '../api/types';

/** Replace the vertex at `index` (drag). Out-of-range indices are a no-op copy. */
export function moveVertex(
  vertices: readonly [number, number][],
  index: number,
  point: [number, number],
): [number, number][] {
  if (index < 0 || index >= vertices.length) return [...vertices];
  return vertices.map((vertex, i) => (i === index ? point : vertex));
}

/** Midpoint of the edge from `a` to `b`. */
export function edgeMidpoint(
  a: readonly [number, number],
  b: readonly [number, number],
): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Insert the midpoint of edge `edgeIndex` (between vertices[edgeIndex] and
 * the NEXT vertex, wrapping around the ring) as a new vertex.
 */
export function insertVertexAtEdge(
  vertices: readonly [number, number][],
  edgeIndex: number,
): [number, number][] {
  if (vertices.length < 2 || edgeIndex < 0 || edgeIndex >= vertices.length) {
    return [...vertices];
  }
  const next = (edgeIndex + 1) % vertices.length;
  const midpoint = edgeMidpoint(vertices[edgeIndex], vertices[next]);
  return [
    ...vertices.slice(0, edgeIndex + 1),
    midpoint,
    ...vertices.slice(edgeIndex + 1),
  ];
}

/**
 * Remove the vertex at `index`; null when the ring would drop below 3
 * vertices (the min-ring constraint the server enforces with BAD_GEO).
 */
export function removeVertexAt(
  vertices: readonly [number, number][],
  index: number,
): [number, number][] | null {
  if (index < 0 || index >= vertices.length) return [...vertices];
  if (vertices.length <= 3) return null;
  return vertices.filter((_, i) => i !== index);
}

/** Shift a grid zone rectangle by (dx, dy) world units (canvas drag move). */
export function translateBounds(bounds: ZoneBounds, dx: number, dy: number): ZoneBounds {
  return {
    ...bounds,
    minX: bounds.minX + dx,
    maxX: bounds.maxX + dx,
    minY: bounds.minY + dy,
    maxY: bounds.maxY + dy,
  };
}
