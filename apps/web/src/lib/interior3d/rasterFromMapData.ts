/**
 * Runtime rasterizer (UX-W4) — the raster path's second data provider.
 *
 * Pre-baked plan rasters (`/interior/bldg-*.json`) only exist for the
 * Taicang guide buildings; every other environment fell back to the
 * polygon stub (no devices, no deploy, no rooms). This module synthesizes
 * an EQUIVALENT RasterInterior from environment map_data so the full
 * raster feature set (room tints / furniture kits / door language / light
 * strips / deploy ghost / device sync) works on any environment:
 *
 * - floor zones = zones with matching buildingId + floor (one zone per
 *   storey in the building tier; grid maps may have several);
 * - walls: zone perimeter — polygon edges become ROTATED boxes (5th tuple
 *   element, same convention as wallCleanup's curve pass; rasterPath
 *   passes pre-rotated boxes through untouched), bounds zones become four
 *   axis boxes;
 * - doors: carved where two floor zones connect — declared adjacency
 *   (adjacentZoneIds, either direction) OR a shared edge (共边推断,
 *   overlap ≥ 1.4 m) — the shared wall is split around a 1.2 m gap and a
 *   door marker (with orientation) is emitted;
 * - rooms: positioned zone.rooms (normalized pos) subdivide the zone rect
 *   by axis-aligned Voronoi (bisector clipping — deterministic, tiling,
 *   non-overlapping); a zone without positioned rooms becomes one big
 *   room itself so labels / search / presence anchors still work;
 * - geoMapping: single-polygon-zone floors get an exact direct frame
 *   (plan meters = footprint-frame meters re-anchored at the bbox corner)
 *   so deploy placement round-trips; bounds-only / multi-zone floors get
 *   null and the page honestly disables deploy.
 *
 * Pure geometry, no Babylon — the caller caches by zone-structure
 * signature and rebuilds only on structural edits.
 */

import type { EnvZone } from '../../api/types';
import type { RasterInterior } from '../../components/interior/types';
import { footprintFrame, type PlanGeoMapping } from './geoPlan';
import { projectPolygon } from './projection';

export interface RuntimeRasterResult {
  raster: RasterInterior;
  /** Direct geo↔plan mapping (single polygon zone), else null. */
  geoMapping: PlanGeoMapping | null;
}

const WALL_T = 0.24;
/** Two rects share an edge when their boundaries sit within this gap. */
const EDGE_TOL = 0.3;
/** Minimum shared-edge overlap (m) that reads as a connection, not a touch. */
const MIN_SHARED = 1.4;
/** Carved door gap (m) — matches the pre-baked door-leaf language (~0.92). */
const DOOR_W = 1.2;

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface FloorZone {
  zone: EnvZone;
  rect: Rect;
  /** Projected polygon ring (zone-frame meters) when the zone has one. */
  ring: Array<{ x: number; z: number }> | null;
}

/** Deterministic pastel from a room code (same discipline as the guide palette). */
export function pastelFor(key: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  // hsl → rgb, s = 0.45, l = 0.78 (pastel band)
  const s = 0.45;
  const l = 0.78;
  const q = l + s - l * s; // l ≥ 0.5 branch
  const p = 2 * l - q;
  const chan = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [chan(hue + 1 / 3), chan(hue), chan(hue - 1 / 3)];
}

function zoneRect(zone: EnvZone): { rect: Rect; ring: FloorZone['ring'] } | null {
  if (zone.polygon && zone.polygon.length >= 3) {
    const ring = projectPolygon(zone.polygon);
    const rect = rectOfPoints(ring);
    return rect ? { rect, ring } : null;
  }
  const b = zone.bounds;
  if (
    b &&
    [b.minX, b.maxX, b.minY, b.maxY].every(n => typeof n === 'number' && Number.isFinite(n)) &&
    b.maxX - b.minX >= 1 &&
    b.maxY - b.minY >= 1
  ) {
    return { rect: { minX: b.minX, maxX: b.maxX, minZ: b.minY, maxZ: b.maxY }, ring: null };
  }
  return null;
}

function rectOfPoints(pts: ReadonlyArray<{ x: number; z: number }>): Rect | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  if (!Number.isFinite(minX) || maxX - minX < 1 || maxZ - minZ < 1) return null;
  return { minX, maxX, minZ, maxZ };
}

interface Edge {
  /** 'x' = wall runs along x (constant z); 'z' = wall runs along z. */
  axis: 'x' | 'z';
  at: number;
  lo: number;
  hi: number;
}

function rectEdges(r: Rect): Edge[] {
  return [
    { axis: 'x', at: r.minZ, lo: r.minX, hi: r.maxX },
    { axis: 'x', at: r.maxZ, lo: r.minX, hi: r.maxX },
    { axis: 'z', at: r.minX, lo: r.minZ, hi: r.maxZ },
    { axis: 'z', at: r.maxX, lo: r.minZ, hi: r.maxZ },
  ];
}

/** Shared boundary between two rects (edge coincidence + overlap). */
function sharedEdge(a: Rect, b: Rect): { aEdge: Edge; overlap: [number, number] } | null {
  const pairs: Array<[Edge, Edge, 'x' | 'z']> = [
    // a.east / b.west and a.west / b.east are constant-x walls (run along z)
    [{ axis: 'z', at: a.maxX, lo: a.minZ, hi: a.maxZ }, { axis: 'z', at: b.minX, lo: b.minZ, hi: b.maxZ }, 'z'],
    [{ axis: 'z', at: a.minX, lo: a.minZ, hi: a.maxZ }, { axis: 'z', at: b.maxX, lo: b.minZ, hi: b.maxZ }, 'z'],
    [{ axis: 'x', at: a.maxZ, lo: a.minX, hi: a.maxX }, { axis: 'x', at: b.minZ, lo: b.minX, hi: b.maxX }, 'x'],
    [{ axis: 'x', at: a.minZ, lo: a.minX, hi: a.maxX }, { axis: 'x', at: b.maxZ, lo: b.minX, hi: b.maxX }, 'x'],
  ];
  for (const [ea, eb] of pairs) {
    if (Math.abs(ea.at - eb.at) > EDGE_TOL) continue;
    const lo = Math.max(ea.lo, eb.lo);
    const hi = Math.min(ea.hi, eb.hi);
    if (hi - lo >= MIN_SHARED) return { aEdge: ea, overlap: [lo, hi] };
  }
  return null;
}

/** Emit a wall (possibly split around a door gap) as axis boxes. */
function emitEdge(
  out: Array<[number, number, number, number]>,
  edge: Edge,
  doorAt: number | null,
): void {
  const spans: Array<[number, number]> = [];
  if (doorAt === null) {
    spans.push([edge.lo, edge.hi]);
  } else {
    spans.push([edge.lo, doorAt - DOOR_W / 2], [doorAt + DOOR_W / 2, edge.hi]);
  }
  for (const [lo, hi] of spans) {
    const len = hi - lo;
    if (len < 0.3) continue;
    const mid = (lo + hi) / 2;
    if (edge.axis === 'x') out.push([mid, edge.at, len, WALL_T]);
    else out.push([edge.at, mid, WALL_T, len]);
  }
}

/** Axis-aligned Voronoi: bisector-clipped rects tiling `rect` around the room centers. */
export function voronoiRooms(
  centers: ReadonlyArray<{ x: number; z: number }>,
  rect: Rect,
): Rect[] {
  return centers.map(c => {
    let minX = rect.minX;
    let maxX = rect.maxX;
    let minZ = rect.minZ;
    let maxZ = rect.maxZ;
    for (const o of centers) {
      if (o === c) continue;
      if (o.x < c.x - 1e-9) minX = Math.max(minX, (c.x + o.x) / 2);
      else if (o.x > c.x + 1e-9) maxX = Math.min(maxX, (c.x + o.x) / 2);
      if (o.z < c.z - 1e-9) minZ = Math.max(minZ, (c.z + o.z) / 2);
      else if (o.z > c.z + 1e-9) maxZ = Math.min(maxZ, (c.z + o.z) / 2);
    }
    return { minX, maxX, minZ, maxZ };
  });
}

/**
 * zones + buildingId + floor → a RasterInterior the raster path renders
 * with its full feature set. Null when no zone carries usable geometry
 * (the page then shows its explicit degrade UI).
 */
export function rasterFromMapData(
  zones: readonly EnvZone[],
  buildingId: string,
  floor: number,
): RuntimeRasterResult | null {
  const floorZones: FloorZone[] = [];
  for (const zone of zones) {
    if (zone.buildingId !== buildingId) continue;
    if ((zone.floor ?? 0) !== floor) continue;
    const geom = zoneRect(zone);
    if (geom) floorZones.push({ zone, rect: geom.rect, ring: geom.ring });
  }
  if (floorZones.length === 0) return null;

  // Global re-anchor: the whole floor's min corner sits at (0, 0).
  let gMinX = Infinity;
  let gMinZ = Infinity;
  let gMaxX = -Infinity;
  let gMaxZ = -Infinity;
  for (const f of floorZones) {
    gMinX = Math.min(gMinX, f.rect.minX);
    gMinZ = Math.min(gMinZ, f.rect.minZ);
    gMaxX = Math.max(gMaxX, f.rect.maxX);
    gMaxZ = Math.max(gMaxZ, f.rect.maxZ);
  }
  const shift = (r: Rect): Rect => ({
    minX: r.minX - gMinX,
    maxX: r.maxX - gMinX,
    minZ: r.minZ - gMinZ,
    maxZ: r.maxZ - gMinZ,
  });
  const rects = floorZones.map(f => shift(f.rect));
  const width = gMaxX - gMinX;
  const height = gMaxZ - gMinZ;

  const walls: RasterInterior['walls'] = [];
  const doors: NonNullable<RasterInterior['doors']> = [];

  const singlePolygon =
    floorZones.length === 1 && floorZones[0].ring !== null ? floorZones[0] : null;

  if (singlePolygon && singlePolygon.ring) {
    // Polygon perimeter as rotated boxes (rasterPath passes them through).
    const ring = singlePolygon.ring.map(p => ({ x: p.x - gMinX, z: p.z - gMinZ }));
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      walls.push([(a.x + b.x) / 2, (a.z + b.z) / 2, len, WALL_T, Math.atan2(dz, dx)]);
    }
  } else {
    // Rect perimeter walls; shared edges emitted once (by the lower index),
    // carved with a door when the zones connect (declared or inferred).
    const shared = new Map<string, { doorAt: number; skip: boolean }>();
    for (let i = 0; i < floorZones.length; i++) {
      for (let j = i + 1; j < floorZones.length; j++) {
        const hit = sharedEdge(rects[i], rects[j]);
        if (!hit) continue;
        // 门洞 = 声明邻接（adjacentZoneIds）或共边推断——能定位门洞的前提
        // 本来就是共边，共边即连接证据，一律开门。
        const doorAt = (hit.overlap[0] + hit.overlap[1]) / 2;
        shared.set(`${i}:${hit.aEdge.axis}:${hit.aEdge.at.toFixed(2)}`, { doorAt, skip: false });
        shared.set(`${j}:${hit.aEdge.axis}:${hit.aEdge.at.toFixed(2)}`, { doorAt, skip: true });
        const dx = hit.aEdge.axis === 'x' ? doorAt : hit.aEdge.at;
        const dz = hit.aEdge.axis === 'x' ? hit.aEdge.at : doorAt;
        doors.push([dx, dz, hit.aEdge.axis]);
      }
    }
    for (let i = 0; i < floorZones.length; i++) {
      for (const edge of rectEdges(rects[i])) {
        const key = `${i}:${edge.axis}:${edge.at.toFixed(2)}`;
        const s = shared.get(key);
        if (s?.skip) continue; // 对侧已发（含门洞）
        emitEdge(walls as Array<[number, number, number, number]>, edge, s?.doorAt ?? null);
      }
    }
  }

  // Rooms + labels + floor plates.
  const rooms: NonNullable<RasterInterior['rooms']> = [];
  const labels: RasterInterior['labels'] = [];
  const floorBoxes: RasterInterior['floor'] = rects.map(r => [
    (r.minX + r.maxX) / 2,
    (r.minZ + r.maxZ) / 2,
    r.maxX - r.minX,
    r.maxZ - r.minZ,
  ]);

  for (let i = 0; i < floorZones.length; i++) {
    const { zone } = floorZones[i];
    const rect = rects[i];
    const spanX = rect.maxX - rect.minX;
    const spanZ = rect.maxZ - rect.minZ;
    const positioned = (zone.rooms ?? []).filter(
      r =>
        Array.isArray(r.pos) &&
        r.pos.length === 2 &&
        r.pos.every(n => typeof n === 'number' && Number.isFinite(n)),
    );
    if (positioned.length === 0) {
      // Zone-as-room: labels/search/presence anchors still work.
      const cx = (rect.minX + rect.maxX) / 2;
      const cz = (rect.minZ + rect.maxZ) / 2;
      rooms.push({
        code: zone.id,
        name: zone.name ?? zone.id,
        color: pastelFor(zone.id),
        boxes: [[cx, cz, spanX, spanZ]],
        zoneId: zone.id,
      });
      labels.push({ code: zone.id, name: zone.name ?? zone.id, x: cx, z: cz });
      continue;
    }
    const centers = positioned.map(r => ({
      x: rect.minX + (r.pos as number[])[0] * spanX,
      z: rect.minZ + (r.pos as number[])[1] * spanZ,
    }));
    const cells = voronoiRooms(centers, rect);
    for (let k = 0; k < positioned.length; k++) {
      const room = positioned[k];
      const cell = cells[k];
      const code = room.code ?? room.name;
      const w = cell.maxX - cell.minX;
      const d = cell.maxZ - cell.minZ;
      if (w < 0.4 || d < 0.4) continue; // 重合 pos 的退化格
      const cx = (cell.minX + cell.maxX) / 2;
      const cz = (cell.minZ + cell.maxZ) / 2;
      rooms.push({
        code,
        name: room.name,
        color: pastelFor(code),
        boxes: [[cx, cz, w, d]],
        zoneId: zone.id,
      });
      labels.push({
        code,
        name: room.name,
        ...(room.hours !== undefined ? { hours: room.hours } : {}),
        x: centers[k].x,
        z: centers[k].z,
      });
    }
  }

  // Direct geo mapping: exact only for the single-polygon-zone floor (the
  // anchor is that zone's own footprint mins).
  let geoMapping: PlanGeoMapping | null = null;
  if (singlePolygon && singlePolygon.zone.polygon) {
    const polygon = singlePolygon.zone.polygon;
    const frame = footprintFrame(polygon);
    const ring = projectPolygon(polygon);
    let minXm = Infinity;
    let minZm = Infinity;
    for (const p of ring) {
      minXm = Math.min(minXm, p.x);
      minZm = Math.min(minZm, p.z);
    }
    geoMapping = {
      bbox: { x: [0, 0], y: [0, 0] },
      mpp: 1,
      frame,
      direct: { minXm, minZm },
    };
  }

  return {
    raster: {
      walls,
      floor: floorBoxes,
      wallHeight: 2.6,
      labels,
      rooms,
      doors,
      width,
      height,
    },
    geoMapping,
  };
}
