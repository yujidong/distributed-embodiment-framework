/**
 * Zone position picker geometry (UX-W4) — pure conversions between zone
 * coordinates and normalized 0–100 plan space, shared by the read-only
 * ZoneFloorPlan and the interactive ZonePositionPicker embedded in
 * DeviceForm.
 *
 * Plan space: u runs along lng/x, v from the north/min-y edge (matching
 * ZoneFloorPlan's R82 normalization). Grid device positions are persisted in
 * world units (zone-bounds space, see worldmap/layout.ts), so a plan click
 * maps back as x = minX + u/100 · spanX; geo positions are {lat, lng}
 * normalized to the polygon bbox.
 */

import type { EnvZone } from '../api/types';
import type { LatLng } from './geo';

/** A point in normalized 0–100 plan space. */
export interface PlanPoint {
  u: number;
  v: number;
}

/** A grid-world position in world units. */
export interface GridPoint {
  x: number;
  y: number;
}

function clampPlan(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Zone footprint outline in normalized 0–100 plan space: geo polygon
 * normalized to its bbox (max-lat maps to v=0), grid bounds → the full
 * rect. Null when the zone has neither polygon nor bounds.
 */
export function planOutline(zone: EnvZone): Array<[number, number]> | null {
  if (zone.polygon && zone.polygon.length >= 3) {
    const lats = zone.polygon.map(p => p[0]);
    const lngs = zone.polygon.map(p => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const spanLat = maxLat - minLat || 1;
    const minLng = Math.min(...lngs);
    const spanLng = Math.max(...lngs) - minLng || 1;
    return zone.polygon.map(
      ([lat, lng]) =>
        [((lng - minLng) / spanLng) * 100, ((maxLat - lat) / spanLat) * 100] as [number, number],
    );
  }
  if (zone.bounds) {
    return [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
  }
  return null;
}

/** Grid world-unit point → plan space (null without zone bounds). */
export function gridToPlan(zone: EnvZone, point: GridPoint): PlanPoint | null {
  const bounds = zone.bounds;
  if (!bounds) return null;
  const spanX = bounds.maxX - bounds.minX || 1;
  const spanY = bounds.maxY - bounds.minY || 1;
  return {
    u: ((point.x - bounds.minX) / spanX) * 100,
    v: ((point.y - bounds.minY) / spanY) * 100,
  };
}

/** Plan-space click → grid world units, clamped inside the bounds. */
export function planToGrid(zone: EnvZone, point: PlanPoint): GridPoint | null {
  const bounds = zone.bounds;
  if (!bounds) return null;
  const u = clampPlan(point.u);
  const v = clampPlan(point.v);
  return {
    x: bounds.minX + (u / 100) * (bounds.maxX - bounds.minX),
    y: bounds.minY + (v / 100) * (bounds.maxY - bounds.minY),
  };
}

/** Geo lat/lng → plan space (null without a polygon; north edge → v=0). */
export function geoToPlan(zone: EnvZone, point: LatLng): PlanPoint | null {
  const polygon = zone.polygon;
  if (!polygon || polygon.length < 3) return null;
  const lats = polygon.map(p => p[0]);
  const lngs = polygon.map(p => p[1]);
  const maxLat = Math.max(...lats);
  const spanLat = maxLat - Math.min(...lats) || 1;
  const minLng = Math.min(...lngs);
  const spanLng = Math.max(...lngs) - minLng || 1;
  return {
    u: ((point.lng - minLng) / spanLng) * 100,
    v: ((maxLat - point.lat) / spanLat) * 100,
  };
}
