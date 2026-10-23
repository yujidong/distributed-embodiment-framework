/**
 * Geo map tier (product_design.md §11.4) — city-scale real geography.
 *
 * A geo environment's `map_data` carries real coordinates:
 *
 * ```
 * {
 *   center: { lat, lng },            // projection origin + default view
 *   zoom?: number,                   // default Leaflet zoom (1..19)
 *   zones: [{ id, name?, type?, polygon: [[lat, lng], ...] (>= 3), baseline? }],
 *   events?: [...]                   // scheduled events baked into the world
 * }
 * ```
 *
 * Device `position` in a geo environment is `{ lat, lng }`.
 *
 * The engine (EngineRuntime/SpatialField) works in METERS, so the bridge
 * projects lat/lng onto a local tangent plane with the equirectangular
 * approximation around the environment center:
 *
 * ```
 * x = (lng - center.lng) * METERS_PER_DEG_LAT * cos(center.lat)   // east
 * y = (center.lat - lat) * METERS_PER_DEG_LAT                     // SOUTH
 * ```
 *
 * `y` points south so the projected grid-style views keep the platform's
 * screen convention (y down = north up on screen). The same constants and
 * formula live in apps/web/src/lib/geo.ts — keep them in sync.
 *
 * Zone adjacency is DERIVED (not stored) from polygon geometry: two zones
 * are adjacent when their polygon boundaries come within
 * `ADJACENCY_TOLERANCE_M` meters of each other — boundary crossing/touching
 * is distance 0, so intersecting or shared-edge polygons are adjacent, and
 * hand-drawn district polygons with small gaps still connect. One zone
 * fully containing another also counts.
 */

import { ApiError } from './errors.js';
import type { EnvGeoCenter, EnvMapData, EnvMapEvent, EnvZone } from './db/environment-store.js';

/** Meters per degree of latitude (spherical-earth approximation). */
export const METERS_PER_DEG_LAT = 111320;

/**
 * Two zone polygons whose boundaries are closer than this are treated as
 * adjacent. Hand-drawn district polygons are rough; 500 m absorbs drawing
 * error at city scale without bridging genuinely separated districts.
 */
export const ADJACENCY_TOLERANCE_M = 500;

/** Zoom bounds accepted for the default view. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 19;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Project a lat/lng onto local meters around `center` (see file header). */
export function projectToMeters(
  center: EnvGeoCenter,
  lat: number,
  lng: number,
): { x: number; y: number } {
  const latRad = (center.lat * Math.PI) / 180;
  return {
    x: (lng - center.lng) * METERS_PER_DEG_LAT * Math.cos(latRad),
    y: (center.lat - lat) * METERS_PER_DEG_LAT,
  };
}

/** Bounding box of a polygon in projected meters (zone bounds for the engine). */
export function polygonBboxMeters(
  center: EnvGeoCenter,
  polygon: readonly (readonly [number, number])[],
): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lat, lng] of polygon) {
    const { x, y } = projectToMeters(center, lat, lng);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/** Mean of the polygon vertices (good enough for device placement). */
export function polygonCentroid(
  polygon: readonly (readonly [number, number])[],
): EnvGeoCenter {
  let lat = 0;
  let lng = 0;
  for (const [la, ln] of polygon) {
    lat += la;
    lng += ln;
  }
  return { lat: lat / polygon.length, lng: lng / polygon.length };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkLat(lat: unknown, path: string): asserts lat is number {
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) {
    throw new ApiError(400, 'BAD_GEO', `${path} must be a latitude in -90..90`);
  }
}

function checkLng(lng: unknown, path: string): asserts lng is number {
  if (!isFiniteNumber(lng) || lng < -180 || lng > 180) {
    throw new ApiError(400, 'BAD_GEO', `${path} must be a longitude in -180..180`);
  }
}

/** Validate a `{lat, lng}` object; returns it narrowed. */
export function parseGeoCenter(raw: unknown, path: string): EnvGeoCenter {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_GEO', `${path} must be an object {lat, lng}`);
  }
  const { lat, lng } = raw as Record<string, unknown>;
  checkLat(lat, `${path}.lat`);
  checkLng(lng, `${path}.lng`);
  return { lat, lng };
}

/**
 * Minimum ring area in square degrees (~1 m² at mid latitudes: 1° lat ≈
 * 111 km, 1° lng ≈ 95 km at 31°N, so 1e-10 deg² ≈ 1 m²). The shoelace sum
 * is computed on coordinates shifted to the first vertex, keeping float
 * error ~1e-24 deg², so this epsilon only rejects genuinely degenerate
 * rings (collinear, spiked, or backtracking) — never a hand-drawn zone.
 */
const MIN_RING_AREA_DEG2 = 1e-10;

/** Shoelace area in square degrees, computed relative to the first vertex. */
function ringAreaDeg2(points: readonly (readonly [number, number])[]): number {
  const [lat0, lng0] = points[0];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [latA, lngA] = points[i];
    const [latB, lngB] = points[(i + 1) % points.length];
    sum += (latA - lat0) * (lngB - lng0) - (latB - lat0) * (lngA - lng0);
  }
  return Math.abs(sum) / 2;
}

/**
 * Strict-crossing self-intersection check over ring edges, O(n²) (rings are
 * hand-drawn, n < 100). Adjacent edges share a vertex by construction and
 * are skipped; collinear overlaps do not count as crossings (the area and
 * duplicate-vertex checks catch the degenerate cases they produce).
 * Degree space is fine: the meter projection is affine, so segment
 * incidence is identical in either space.
 */
function ringSelfIntersects(points: readonly (readonly [number, number])[]): boolean {
  const n = points.length;
  const seg = (i: number) => {
    const [latA, lngA] = points[i];
    const [latB, lngB] = points[(i + 1) % n];
    return [{ x: lngA, y: latA }, { x: lngB, y: latB }];
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip edges adjacent in the ring (shared endpoint is not a crossing).
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const [a1, a2] = seg(i);
      const [b1, b2] = seg(j);
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * Validate a zone polygon: an array of >= 3 `[lat, lng]` points. A repeated
 * closing point (first == last) is accepted and dropped — any valid ring is
 * "closed-ring-able". Beyond a non-degenerate bbox, the ring must have
 * non-zero shoelace area, no repeated (non-closing) vertices, and no
 * self-crossing edges — degenerate rings reach Babylon's ExtrudePolygon
 * triangulation in the web viewer and render unpredictably.
 */
export function parseGeoPolygon(raw: unknown, path: string): [number, number][] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_GEO', `${path} must be an array of [lat, lng] points`);
  }
  let points = raw.map((point, i) => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new ApiError(400, 'BAD_GEO', `${path}[${i}] must be a [lat, lng] pair`);
    }
    checkLat(point[0], `${path}[${i}][0]`);
    checkLng(point[1], `${path}[${i}][1]`);
    return [point[0], point[1]] as [number, number];
  });
  if (
    points.length > 1 &&
    points[0][0] === points[points.length - 1][0] &&
    points[0][1] === points[points.length - 1][1]
  ) {
    points = points.slice(0, -1);
  }
  if (points.length < 3) {
    throw new ApiError(400, 'BAD_GEO', `${path} must have at least 3 points`);
  }
  const lats = points.map(p => p[0]);
  const lngs = points.map(p => p[1]);
  if (Math.max(...lats) === Math.min(...lats) || Math.max(...lngs) === Math.min(...lngs)) {
    throw new ApiError(400, 'BAD_GEO', `${path} is degenerate (zero-area)`);
  }
  if (new Set(points.map(([lat, lng]) => `${lat},${lng}`)).size !== points.length) {
    throw new ApiError(400, 'BAD_GEO', `${path} repeats a vertex (duplicate point in ring)`);
  }
  if (ringAreaDeg2(points) < MIN_RING_AREA_DEG2) {
    throw new ApiError(400, 'BAD_GEO', `${path} is degenerate (zero-area ring)`);
  }
  if (ringSelfIntersects(points)) {
    throw new ApiError(400, 'BAD_GEO', `${path} self-intersects (crossed ring)`);
  }
  return points;
}

/** Validate a scheduled event baked into map data (mirrors scenario events). */
export function parseMapEvent(raw: unknown, zoneIds: ReadonlySet<string>, path: string): EnvMapEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', `${path} must be an object`);
  }
  const event = raw as Record<string, unknown>;
  for (const field of ['id', 'type', 'zoneId'] as const) {
    if (typeof event[field] !== 'string' || (event[field] as string).length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${path}.${field} must be a non-empty string`);
    }
  }
  if (!zoneIds.has(event.zoneId as string)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `${path}.zoneId references unknown zone "${event.zoneId as string}"`,
    );
  }
  if (event.parameter !== undefined && typeof event.parameter !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.parameter must be a string`);
  }
  if (
    event.value !== undefined &&
    typeof event.value !== 'number' &&
    typeof event.value !== 'boolean' &&
    typeof event.value !== 'string'
  ) {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.value must be a number | boolean | string`);
  }
  if (event.atSimTimeSec !== undefined && (!isFiniteNumber(event.atSimTimeSec) || event.atSimTimeSec < 0)) {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.atSimTimeSec must be a number >= 0`);
  }
  if (
    event.severity !== undefined &&
    !['low', 'medium', 'high', 'critical'].includes(event.severity as string)
  ) {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.severity must be low | medium | high | critical`);
  }
  if (
    event.requiredCapabilities !== undefined &&
    (!Array.isArray(event.requiredCapabilities) ||
      event.requiredCapabilities.some(c => typeof c !== 'string'))
  ) {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.requiredCapabilities must be a string array`);
  }
  return event as unknown as EnvMapEvent;
}

/**
 * Validate the geo-specific parts of map data (center + zone polygons).
 * Zone id/shape checks shared with grid stay in the route layer.
 */
export function parseGeoMapData(raw: unknown): Required<Pick<EnvMapData, 'center'>> &
  Pick<EnvMapData, 'zoom'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_GEO', 'mapData must be an object');
  }
  const data = raw as Record<string, unknown>;
  const center = parseGeoCenter(data.center, 'mapData.center');
  let zoom: number | undefined;
  if (data.zoom !== undefined) {
    if (!isFiniteNumber(data.zoom) || data.zoom < MIN_ZOOM || data.zoom > MAX_ZOOM) {
      throw new ApiError(400, 'BAD_GEO', `mapData.zoom must be a number in ${MIN_ZOOM}..${MAX_ZOOM}`);
    }
    zoom = data.zoom;
  }
  return { center, ...(zoom !== undefined ? { zoom } : {}) };
}

/**
 * Device-position validation for the device create/patch/instantiate paths:
 * geo environments require `{lat, lng}`; other map types keep free-form
 * positions (no-op).
 */
export function validateDevicePositionForEnv(
  mapType: string,
  position: Record<string, unknown> | null | undefined,
): void {
  if (mapType !== 'geo' || position == null) return;
  parseGeoCenter(position, 'position');
}

// ---------------------------------------------------------------------------
// Adjacency (derived, see file header)
// ---------------------------------------------------------------------------

interface ProjectedPolygon {
  id: string;
  points: { x: number; y: number }[];
}

function pointToSegmentDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function ccw(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): boolean {
  const d1 = ccw(b1, b2, a1);
  const d2 = ccw(b1, b2, a2);
  const d3 = ccw(a1, a2, b1);
  const d4 = ccw(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentDistance(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointToSegmentDistance(a1, b1, b2),
    pointToSegmentDistance(a2, b1, b2),
    pointToSegmentDistance(b1, a1, a2),
    pointToSegmentDistance(b2, a1, a2),
  );
}

/** Ray-casting point-in-polygon over projected points. */
export function pointInPolygon(
  lat: number,
  lng: number,
  polygon: readonly (readonly [number, number])[],
): boolean {
  // Ray cast in degree space; the projection is affine so containment is
  // identical in either space.
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    if (
      lngI > lng !== lngJ > lng &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Minimum distance between two polygons' boundaries (0 when crossing). */
function polygonBoundaryDistance(a: ProjectedPolygon, b: ProjectedPolygon): number {
  let min = Infinity;
  for (let i = 0; i < a.points.length; i++) {
    const a1 = a.points[i];
    const a2 = a.points[(i + 1) % a.points.length];
    for (let j = 0; j < b.points.length; j++) {
      const b1 = b.points[j];
      const b2 = b.points[(j + 1) % b.points.length];
      min = Math.min(min, segmentDistance(a1, a2, b1, b2));
      if (min === 0) return 0;
    }
  }
  return min;
}

/**
 * Derive zone adjacency from polygon geometry (see file header). Zones
 * without a polygon get an empty adjacency list.
 */
export function deriveGeoAdjacency(
  zones: readonly EnvZone[],
  center: EnvGeoCenter,
  toleranceM: number = ADJACENCY_TOLERANCE_M,
): Map<string, string[]> {
  const polygons: ProjectedPolygon[] = [];
  for (const zone of zones) {
    if (!zone.polygon || zone.polygon.length < 3) continue;
    polygons.push({
      id: zone.id,
      points: zone.polygon.map(([lat, lng]) => projectToMeters(center, lat, lng)),
    });
  }
  const adjacency = new Map<string, string[]>(polygons.map(p => [p.id, []]));
  for (let i = 0; i < polygons.length; i++) {
    for (let j = i + 1; j < polygons.length; j++) {
      const a = polygons[i];
      const b = polygons[j];
      const contained =
        pointInPolygon(zones[i].polygon![0][0], zones[i].polygon![0][1], zones[j].polygon!) ||
        pointInPolygon(zones[j].polygon![0][0], zones[j].polygon![0][1], zones[i].polygon!);
      if (contained || polygonBoundaryDistance(a, b) <= toleranceM) {
        adjacency.get(a.id)!.push(b.id);
        adjacency.get(b.id)!.push(a.id);
      }
    }
  }
  return adjacency;
}

/** Read the geo center of a geo environment's map data, or throw 400. */
export function requireGeoCenter(mapData: EnvMapData, envId: string): EnvGeoCenter {
  if (!mapData.center) {
    throw new ApiError(
      400,
      'ENVIRONMENT_INVALID',
      `Geo environment "${envId}" has no map center in its map data`,
    );
  }
  return mapData.center;
}
