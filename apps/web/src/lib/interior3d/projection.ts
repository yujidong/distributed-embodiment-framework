/**
 * Interior walk-mode geometry (R82 phase 1) — pure math, no Babylon.
 *
 * Converts the geo-tier zone data (footprint polygon + declarative rooms
 * with normalized pos) into local-meter geometry for the first-person
 * interior scene:
 *
 * - axis convention mirrors the existing three.js 3D view: x = east,
 *   z = south, y = up (equirectangular projection around the footprint
 *   centroid, shared-anchor style of building3d.ts);
 * - `pos` [u, v] is normalized to the plan image, which we treat as
 *   coincident with the footprint bbox (the guide's plans are to-scale
 *   and centered the same way the OSM footprint is).
 */

import type { EnvRoom, EnvZone } from '../../api/types';

export interface Vec2 {
  x: number;
  z: number;
}

/** Meters per degree at the equator, matching building3d.ts. */
const METERS_PER_DEG_LAT = 110540;

/** A positioned room in local floor meters. */
export interface LocalRoom {
  code: string;
  name: string;
  hours?: string;
  x: number;
  z: number;
}

export interface FootprintBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Equirectangular projection of a [lat, lng] ring around its own centroid. */
export function projectPolygon(polygon: Array<[number, number]>): Vec2[] {
  const lat0 = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const lng0 = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
  const metersPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return polygon.map(([lat, lng]) => ({
    x: (lng - lng0) * metersPerDegLng,
    z: -(lat - lat0) * METERS_PER_DEG_LAT,
  }));
}

export function footprintBounds(points: readonly Vec2[]): FootprintBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

export interface InteriorFloorData {
  /** Projected outline (closed ring implied), local meters. */
  outline: Vec2[];
  bounds: FootprintBounds;
  rooms: LocalRoom[];
}

/**
 * Zone (+ optional deep-link room hint) → walkable floor geometry. Rooms
 * without `pos` are skipped (no placement is known); `codeHint` picks the
 * spawn room and does not filter the room set.
 */
export function buildInteriorFloor(zone: EnvZone): InteriorFloorData | null {
  if (!zone.polygon || zone.polygon.length < 3) return null;
  const outline = projectPolygon(zone.polygon);
  const bounds = footprintBounds(outline);
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanZ = bounds.maxZ - bounds.minZ || 1;
  const rooms: LocalRoom[] = [];
  for (const room of zone.rooms ?? []) {
    if (!isPositioned(room)) continue;
    rooms.push({
      code: room.code ?? room.name,
      name: room.name,
      ...(room.hours !== undefined ? { hours: room.hours } : {}),
      x: bounds.minX + room.pos[0] * spanX,
      z: bounds.minZ + room.pos[1] * spanZ,
    });
  }
  return { outline, bounds, rooms };
}

function isPositioned(room: EnvRoom): room is EnvRoom & { pos: [number, number] } {
  return (
    Array.isArray(room.pos) &&
    room.pos.length === 2 &&
    room.pos.every(n => typeof n === 'number' && Number.isFinite(n))
  );
}

export interface Spawn {
  position: Vec2;
  /** Y rotation (radians) so the camera faces the footprint center. */
  yaw: number;
}

/**
 * Even-odd point-in-polygon on the projected outline. Plan-derived room
 * positions can land slightly outside the OSM footprint (plan margin
 * error) — a spawn outside the walls would stare at brick.
 */
export function pointInPolygon(p: Vec2, outline: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i];
    const b = outline[j];
    const crosses = a.z > p.z !== b.z > p.z;
    if (
      crosses &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Spawn pose fallback chain (concave footprints can put the bbox center in
 * a void — e.g. the gap between D's two wings): hinted room if inside →
 * bbox center if inside → first positioned room that is inside → average
 * of the outline vertices (inside for star-shaped rings like ours). Faces
 * the bbox center so the first view sweeps the whole floor.
 */
export function spawnPose(
  data: InteriorFloorData,
  codeHint?: string,
): Spawn {
  const center = {
    x: (data.bounds.minX + data.bounds.maxX) / 2,
    z: (data.bounds.minZ + data.bounds.maxZ) / 2,
  };
  const inside = (p: Vec2) => pointInPolygon(p, data.outline);
  // stand 1.5m from a room's marker toward the center — never inside the
  // 0.5m pylon box itself (camera would render the box from within).
  const near = (room: { x: number; z: number }): Vec2 => {
    const dx = center.x - room.x;
    const dz = center.z - room.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: room.x + (dx / len) * 1.5, z: room.z + (dz / len) * 1.5 };
  };
  const room = codeHint ? data.rooms.find(r => r.code === codeHint) : undefined;
  const candidate = room ? near(room) : center;
  const firstInsideRoom = data.rooms.find(r => inside({ x: r.x, z: r.z }));
  const vertexAvg = {
    x: data.outline.reduce((s, p) => s + p.x, 0) / data.outline.length,
    z: data.outline.reduce((s, p) => s + p.z, 0) / data.outline.length,
  };
  const position = inside(candidate)
    ? candidate
    : inside(center)
      ? center
      : firstInsideRoom
        ? near(firstInsideRoom)
        : vertexAvg;
  const yaw = Math.atan2(center.x - position.x, center.z - position.z);
  return { position, yaw };
}

/** Perimeter wall segments (thin boxes) from the projected outline. */
export interface WallSegment {
  cx: number;
  cz: number;
  yaw: number;
  length: number;
}

export function wallSegments(outline: readonly Vec2[], closed = true): WallSegment[] {
  const segments: WallSegment[] = [];
  const pts = closed ? [...outline, outline[0]] : [...outline];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) continue;
    segments.push({
      cx: (a.x + b.x) / 2,
      cz: (a.z + b.z) / 2,
      yaw: Math.atan2(dx, dz),
      length,
    });
  }
  return segments;
}
