/**
 * Open-hall detection (R97) — pure helpers behind the raster path's
 * basement fallback.
 *
 * Basement parking levels extract with NO room regions and a "wall" set
 * that is really dense drawing line-work (parking bays read as walls):
 * measured 74~84% envelope coverage on bldg-j-b1 / bldg-f-b1 vs 3~6% on
 * normal storeys. Detect that shape so the raster path can drop the junk
 * walls and fall back to a perimeter envelope + generic floor instead of
 * rendering a sea of 0.9m grid walls.
 */

import type { WallBox } from './wallCleanup';

export interface WallEnvelope {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Axis-aligned envelope of the wall boxes (null when empty). */
export function wallEnvelope(walls: readonly WallBox[]): WallEnvelope | null {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [cx, cz, w, d] of walls) {
    minX = Math.min(minX, cx - w / 2); maxX = Math.max(maxX, cx + w / 2);
    minZ = Math.min(minZ, cz - d / 2); maxZ = Math.max(maxZ, cz + d / 2);
  }
  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}

/** Coverage above which "walls" are treated as drawing line-work noise. */
export const OPEN_HALL_COVERAGE = 0.4;

interface OpenHallRasterShape {
  walls: readonly WallBox[];
  floor: readonly unknown[];
  rooms?: readonly unknown[];
}

/** True when the raster floor is an open hall: no room/plate data at all
 *  and the wall boxes pack the envelope (line-work, not partitions). */
export function isOpenHallRaster(raster: OpenHallRasterShape): boolean {
  if ((raster.rooms ?? []).length > 0 || raster.floor.length > 0) return false;
  const envelope = wallEnvelope(raster.walls);
  if (!envelope) return false;
  const envelopeArea = (envelope.maxX - envelope.minX) * (envelope.maxZ - envelope.minZ);
  if (envelopeArea <= 0) return false;
  let wallArea = 0;
  for (const [, , w, d] of raster.walls) wallArea += w * d;
  return wallArea / envelopeArea > OPEN_HALL_COVERAGE;
}
