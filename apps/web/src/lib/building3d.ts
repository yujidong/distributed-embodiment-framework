/**
 * Building 3D geometry — pure zone→3D mapping, engine-free so it stays
 * unit-testable under jsdom (no WebGL). It was written for the retired
 * three.js Building3DView and is now the shared math behind the Babylon
 * campus renderer (`components/campus/`, via `lib/campus3d.ts`):
 *
 * - `resolveStoreyHeight` — world `storeyHeight` (EnvironmentDetail, B-A) with
 *   a 3.5 m fallback when the world does not carry one;
 * - `computeZoneBoxes` — EnvZone (+ optional live parameters) → an extruded
 *   box: world meters mapped to 3D axes (x = east, y = up, z = south,
 *   since world y points down = planar south), stacked by `floor` and grouped
 *   implicitly by world coordinates (buildings stay spatially separate);
 *   zones without `bounds` fall back to a tidy grid past the bounded area
 *   (mirrors `worldmap/layout.ts`) and are flagged `fallback`; geo zones
 *   carrying a `polygon` are SKIPPED here (their true footprint renders via
 *   `computeZoneExtrusions` instead of a bbox slab);
 * - `computeZoneExtrusions` — polygon zones (geo tier) → projected
 *   footprint rings in the SAME axes (x = east, z = south) around a
 *   shared anchor (mean of polygon centroids, so multiple buildings keep
 *   their real relative placement), stacked by `floor` — the campus renderer
 *   extrudes these with Babylon's ExtrudePolygon. Outdoor envelope zones and
 *   rings with non-finite vertices are skipped (same exclusion as the box
 *   path; a dirty ring must not poison the shared anchor with NaN);
 * - `ZONE_CATEGORY_COLORS` — hex palette mirroring the `zone-node--cat-*`
 *   tints in styles.css, so the 3D view matches the 2D semantic layer;
 * - `computeSceneBounds` / `initialCameraPose` — whole-scene bounding box and
 *   a sane opening camera position (converted to an ArcRotate pose by
 *   `lib/campus3d.ts`).
 */

import type { EnvZone } from '../api/types';
import {
  FALLBACK_GAP_PX,
  FALLBACK_ZONE_W_PX,
  layoutUnboundedZonePositions,
} from '../components/worldmap/layout';
import { classifyZone, zoneHeatFill, type ZoneCategory } from './zoneVisual';

/** Campus scenarios use 3.5 m; worlds without `storeyHeight` fall back here. */
export const DEFAULT_STOREY_HEIGHT = 3.5;

/**
 * Floor-to-floor height in meters. Rejects non-positive / non-finite values
 * defensively (the contract allows `storeyHeight: null`).
 */
export function resolveStoreyHeight(storeyHeight: number | null | undefined): number {
  return typeof storeyHeight === 'number' && Number.isFinite(storeyHeight) && storeyHeight > 0
    ? storeyHeight
    : DEFAULT_STOREY_HEIGHT;
}

/**
 * Category base colors (hex) mirroring the 2D `zone-node--cat-*` palette:
 * accent=classroom, hybrid=dormitory, sensor=library, ok=outdoor, dim greys
 * for circulation (corridor/stairwell) and uncategorized zones.
 */
export const ZONE_CATEGORY_COLORS: Record<ZoneCategory, number> = {
  classroom: 0x4cc2ff,
  dormitory: 0xb07cf0,
  library: 0x2dd4bf,
  // R15-D9: medical zones — warm amber, mirroring --warn in the 2D palette.
  medical: 0xe8a13c,
  // UX-W2: industrial — actuator orange; commercial — pink (both mirror the
  // 2D `zone-node--cat-*` tints added in the same wave).
  industrial: 0xe06c2b,
  commercial: 0xf27ab5,
  outdoor: 0x3fb950,
  corridor: 0x6b7686,
  stairwell: 0x6b7686,
  other: 0x8b95a3,
};

/** Above this many floor SLABS (Σ building floors, not zones), per-box labels are skipped (hover/select only). */
export const LABEL_ALL_THRESHOLD = 40;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ZoneBox {
  zoneId: string;
  name: string;
  category: ZoneCategory;
  /** Box center in world meters, three.js axes (x = east, y = up, z = south). */
  position: Vec3;
  /** Box extents in meters (x width / y height / z depth). */
  size: Vec3;
  /** Category base color (hex); heat overlay wins when present. */
  color: number;
  /** CSS hsl(a) heat fill from live parameters (THREE.Color parses it); null = category look. */
  heatColor: string | null;
  floor: number;
  buildingId: string | null;
  /** True when the zone had no bounds and was grid-placed past the bounded area. */
  fallback: boolean;
}

// Fallback placement for unbounded zones — R15-E3: positions come from the
// shared force layout (worldmap/layout.ts); only the box size and spacing
// are 3D-specific, in meters.
const FALLBACK_CELL = 8;
const FALLBACK_GAP = 4;
/** Horizontal gap between the bounded area and the fallback cluster. */
const FALLBACK_MARGIN = 10;

export interface ComputeZoneBoxesOptions {
  storeyHeight?: number | null;
  /** Live zone parameters keyed by zone id (snapshot heat overlay). */
  parametersById?: ReadonlyMap<string, Record<string, unknown> | undefined>;
}

/**
 * EnvZone list → extruded boxes. World x/y (y down = south) maps to three.js
 * x/z with y up; a zone's box spans `floor * storeyHeight` upward. Zones with
 * explicit `bounds.minZ/maxZ` use that height instead of a full storey.
 */
export function computeZoneBoxes(
  zones: readonly EnvZone[],
  options: ComputeZoneBoxesOptions = {},
): ZoneBox[] {
  const storeyHeight = resolveStoreyHeight(options.storeyHeight);

  // Bounded zones keep their real-world geometry; track the right edge so
  // unbounded zones can be parked in a tidy grid past it. Outdoor envelope
  // zones (校园室外 spanning the whole campus) are skipped — extruded, they
  // become a giant slab that dwarfs the actual buildings.
  const boxes = new Map<string, ZoneBox>();
  let boundedMaxX = 0;
  for (const zone of zones) {
    const bounds = zone.bounds;
    if (!bounds) continue;
    // Geo footprint zone — renders as a true-shape extrusion, not a bbox
    // slab (see computeZoneExtrusions); skipping here avoids double meshes.
    if (hasPolygonFootprint(zone)) continue;
    if (classifyZone(zone) === 'outdoor') continue;
    const floor = zone.floor ?? 0;
    const width = Math.max(bounds.maxX - bounds.minX, 0.1);
    const depth = Math.max(bounds.maxY - bounds.minY, 0.1);
    const hasZ =
      typeof bounds.minZ === 'number' &&
      typeof bounds.maxZ === 'number' &&
      bounds.maxZ > bounds.minZ;
    const height = hasZ ? bounds.maxZ! - bounds.minZ! : storeyHeight;
    const baseY = floor * storeyHeight + (hasZ ? bounds.minZ! : 0);
    boxes.set(zone.id, {
      zoneId: zone.id,
      name: zone.name ?? zone.id,
      category: classifyZone(zone),
      position: {
        x: bounds.minX + width / 2,
        y: baseY + height / 2,
        z: bounds.minY + depth / 2,
      },
      size: { x: width, y: height, z: depth },
      color: ZONE_CATEGORY_COLORS[classifyZone(zone)],
      heatColor: zoneHeatFill(options.parametersById?.get(zone.id)),
      floor,
      buildingId: zone.buildingId ?? null,
      fallback: false,
    });
    boundedMaxX = Math.max(boundedMaxX, bounds.maxX);
  }

  // Unbounded zones: the SAME adjacency-aware force layout the 2D map uses
  // (R15-E3 — the old 3-column grid made the same env arrange differently
  // between views). Positions come back in layout pixels; a uniform scale
  // keeps the neighbourhood clustering while fitting 3D's coarser cells.
  const unbounded = zones.filter(
    zone => !boxes.has(zone.id) && !hasPolygonFootprint(zone) && classifyZone(zone) !== 'outdoor',
  );
  const positions = layoutUnboundedZonePositions(unbounded);
  const gridOriginX = boundedMaxX > 0 ? boundedMaxX + FALLBACK_MARGIN : 0;
  const scale = (FALLBACK_CELL + FALLBACK_GAP) / (FALLBACK_ZONE_W_PX + FALLBACK_GAP_PX);
  for (const zone of unbounded) {
    const pos = positions.get(zone.id) ?? { x: 0, y: 0 };
    const floor = zone.floor ?? 0;
    const category = classifyZone(zone);
    boxes.set(zone.id, {
      zoneId: zone.id,
      name: zone.name ?? zone.id,
      category,
      position: {
        x: gridOriginX + pos.x * scale,
        y: floor * storeyHeight + storeyHeight / 2,
        z: pos.y * scale,
      },
      size: { x: FALLBACK_CELL, y: storeyHeight, z: FALLBACK_CELL },
      color: ZONE_CATEGORY_COLORS[category],
      heatColor: zoneHeatFill(options.parametersById?.get(zone.id)),
      floor,
      buildingId: zone.buildingId ?? null,
      fallback: true,
    });
  }

  return zones
    .map(zone => boxes.get(zone.id))
    .filter((box): box is ZoneBox => box !== undefined);
}

/** True when the zone carries a geo footprint ring worth extruding. */
export function hasPolygonFootprint(zone: EnvZone): boolean {
  return Array.isArray(zone.polygon) && zone.polygon.length >= 3;
}

/**
 * True when every vertex of the zone's polygon is a finite numeric lat/lng.
 * Server-side validation catches most dirty rings, but the web layer must
 * fail safe: one NaN / string coordinate would otherwise poison the shared
 * scene anchor, every projected bbox and the camera pose with NaN.
 */
function hasFinitePolygon(zone: EnvZone): boolean {
  if (!hasPolygonFootprint(zone)) return false;
  return zone.polygon!.every(
    p =>
      typeof p[0] === 'number' &&
      Number.isFinite(p[0]) &&
      typeof p[1] === 'number' &&
      Number.isFinite(p[1]),
  );
}

export interface ZoneExtrusion {
  zoneId: string;
  name: string;
  category: ZoneCategory;
  /**
   * Footprint ring in three.js planar axes (x = east, z = south — the same
   * convention as ZoneBox), projected around the shared scene anchor. Open
   * ring (last point ≠ first): three.js Shape closes it implicitly.
   */
  points: Array<{ x: number; z: number }>;
  /** Bottom of the extrusion in meters (floor × storey height). */
  baseY: number;
  /** Extrusion height in meters (one storey; bounds minZ/maxZ override). */
  height: number;
  color: number;
  heatColor: string | null;
  floor: number;
  buildingId: string | null;
  /** Planar bbox of the projected ring (camera fitting; Y spans base→top). */
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Equirectangular meters-per-degree at the anchor latitude (WGS-84). */
export function metersPerDegree(lat0: number): { east: number; north: number } {
  return { east: 111_320 * Math.cos((lat0 * Math.PI) / 180), north: 110_540 };
}

/**
 * Shared geo anchor for the whole scene: mean of the polygon centroids
 * (vertex means). `computeZoneExtrusions` projects all rings around this
 * one anchor so several buildings keep their true relative placement; the
 * campus renderer also projects device/agent lat/lng against it, so the two
 * coordinate systems coincide exactly. Null when no zone carries a polygon.
 */
export function computePolygonAnchor(
  zones: readonly EnvZone[],
): { lat: number; lng: number } | null {
  const polygonZones = zones.filter(hasFinitePolygon);
  if (polygonZones.length === 0) return null;
  const centroids = polygonZones.map(zone => polygonCentroidOf(zone.polygon!));
  return {
    lat: centroids.reduce((sum, c) => sum + c.lat, 0) / centroids.length,
    lng: centroids.reduce((sum, c) => sum + c.lng, 0) / centroids.length,
  };
}

/**
 * Polygon zones → footprint extrusions. All rings project around ONE anchor
 * (the mean of the polygon centroids) so several buildings keep their true
 * relative placement; a single-building world degenerates to its own
 * centroid. Floor stacking mirrors the box path (floor × storey height;
 * bounds minZ/maxZ override the height when present).
 */
export function computeZoneExtrusions(
  zones: readonly EnvZone[],
  options: ComputeZoneBoxesOptions = {},
): ZoneExtrusion[] {
  // Outdoor envelope zones (校园室外 spanning the whole campus) are skipped
  // for the same reason as in computeZoneBoxes: extruded, they become a
  // giant slab that buries every ground floor and hijacks ground clicks.
  // Dirty polygons (NaN / non-numeric vertices) are skipped too — fail-safe,
  // not fail-deadly: the zone does not render, but the shared anchor, the
  // other buildings' bboxes and the camera pose stay finite.
  const polygonZones = zones.filter(
    zone => hasFinitePolygon(zone) && classifyZone(zone) !== 'outdoor',
  );
  if (polygonZones.length === 0) return [];
  const storeyHeight = resolveStoreyHeight(options.storeyHeight);

  const anchor = computePolygonAnchor(zones)!;
  const { lat: lat0, lng: lng0 } = anchor;
  const scale = metersPerDegree(lat0);

  return polygonZones.map(zone => {
    const ring = zone.polygon!.map(([lat, lng]) => ({
      x: (lng - lng0) * scale.east,
      // North-positive latitude maps to negative z (three.js z = south),
      // matching the box path's world-y-down convention.
      z: -(lat - lat0) * scale.north,
    }));
    const xs = ring.map(p => p.x);
    const zs = ring.map(p => p.z);
    const bounds = zone.bounds;
    const hasZ =
      bounds !== undefined &&
      typeof bounds.minZ === 'number' &&
      typeof bounds.maxZ === 'number' &&
      bounds.maxZ > bounds.minZ;
    const floor = zone.floor ?? 0;
    const height = hasZ ? bounds!.maxZ! - bounds!.minZ! : storeyHeight;
    const baseY = floor * storeyHeight + (hasZ ? bounds!.minZ! : 0);
    return {
      zoneId: zone.id,
      name: zone.name ?? zone.id,
      category: classifyZone(zone),
      points: ring,
      baseY,
      height,
      color: ZONE_CATEGORY_COLORS[classifyZone(zone)],
      heatColor: zoneHeatFill(options.parametersById?.get(zone.id)),
      floor,
      buildingId: zone.buildingId ?? null,
      bbox: {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
      },
    };
  });
}

function polygonCentroidOf(polygon: ReadonlyArray<readonly [number, number]>): {
  lat: number;
  lng: number;
} {
  // Vertex mean — placement anchor only (not area centroid); matches the
  // server's polygonCentroid convention (geo.ts, "good enough for devices").
  const lat = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length;
  const lng = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
  return { lat, lng };
}

/**
 * Scene bounds over boxes AND extrusions (the view merges both mesh families
 * into one camera fit). Returns null for an empty world.
 */
export function computeSceneBoundsWithExtrusions(
  boxes: readonly ZoneBox[],
  extrusions: readonly ZoneExtrusion[],
): SceneBounds | null {
  if (boxes.length === 0 && extrusions.length === 0) return null;
  const pseudoBoxes: ZoneBox[] = [...boxes];
  for (const ext of extrusions) {
    pseudoBoxes.push({
      zoneId: ext.zoneId,
      name: ext.name,
      category: ext.category,
      position: {
        x: (ext.bbox.minX + ext.bbox.maxX) / 2,
        y: ext.baseY + ext.height / 2,
        z: (ext.bbox.minZ + ext.bbox.maxZ) / 2,
      },
      size: {
        x: ext.bbox.maxX - ext.bbox.minX,
        y: ext.height,
        z: ext.bbox.maxZ - ext.bbox.minZ,
      },
      color: ext.color,
      heatColor: ext.heatColor,
      floor: ext.floor,
      buildingId: ext.buildingId,
      fallback: false,
    });
  }
  return computeSceneBounds(pseudoBoxes);
}

export interface SceneBounds {
  center: Vec3;
  size: Vec3;
  /** Half the diagonal — handy for camera distance. */
  radius: number;
}

/** Whole-scene bounding box over all zone boxes; null for an empty world. */
export function computeSceneBounds(boxes: readonly ZoneBox[]): SceneBounds | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.position.x - box.size.x / 2);
    maxX = Math.max(maxX, box.position.x + box.size.x / 2);
    minY = Math.min(minY, box.position.y - box.size.y / 2);
    maxY = Math.max(maxY, box.position.y + box.size.y / 2);
    minZ = Math.min(minZ, box.position.z - box.size.z / 2);
    maxZ = Math.max(maxZ, box.position.z + box.size.z / 2);
  }
  const size = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    size,
    radius: Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2) / 2,
  };
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

/**
 * Opening camera pose: southeast-elevated diagonal view of the whole scene.
 * The distance fits the scene's PROJECTED vertical extent, not its raw 3D
 * diameter: the elevated opening view foreshortens the ground diagonal by
 * sin θ while the skyline keeps cos θ. Fitting the raw diagonal
 * (radius / tan(fov/2) ≈ 2.6× radius) framed the bounding SPHERE's empty
 * vertical space — a wide flat campus (Taicang: radius ~550 m) opened at
 * ~1430 m, past fogStart, where 80 m slabs shrank to sub-pixel specks washed
 * into the fog color. Fitting the projected extent lands a flat scene at
 * ~1.6× radius instead, and a 15% margin keeps the silhouette off the frame
 * edge. The distance floor keeps tiny worlds readable.
 */
export function initialCameraPose(bounds: SceneBounds, fov = 0.8): CameraPose {
  const length = Math.sqrt(1 ** 2 + 0.7 ** 2 + 1 ** 2);
  const direction = { x: 1 / length, y: 0.7 / length, z: 1 / length };
  const sinElevation = direction.y;
  const cosElevation = Math.hypot(direction.x, direction.z);
  const projectedExtent =
    Math.hypot(bounds.size.x, bounds.size.z) * sinElevation + bounds.size.y * cosElevation;
  const distance = Math.max((projectedExtent / (2 * Math.tan(fov / 2))) * 1.15, 12);
  return {
    position: {
      x: bounds.center.x + direction.x * distance,
      y: bounds.center.y + direction.y * distance,
      z: bounds.center.z + direction.z * distance,
    },
    target: { ...bounds.center },
  };
}
