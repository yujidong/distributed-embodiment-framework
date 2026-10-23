/**
 * Campus 3D (Babylon renderer) — pure view-model layer behind
 * `components/campus/CampusScene.tsx`. Engine-free (no three.js / Babylon
 * imports) so the mapping is unit-testable under jsdom.
 *
 * - Re-exports the projection / extrusion / palette plumbing from
 *   `lib/building3d.ts` — that file stays the single source of truth for
 *   WGS-84→meter mapping, floor stacking and the category palette; do NOT
 *   duplicate it here;
 * - `groupZonesByBuilding` — EnvZone list → per-building floor stacks.
 *   Polygon floors of one building that share the same footprint ring are
 *   deduplicated (campus scenarios like Taicang repeat the identical outline
 *   on every storey — extruding each zone would stack N coplanar slabs);
 * - `arcPoseFromPose` / `arcPoseOffset` — convert the shared
 *   `initialCameraPose` into ArcRotateCamera alpha/beta/radius/target
 *   (Babylon: position = target + r·(cosα·sinβ, cosβ, sinα·sinβ));
 * - `campusGroundPlan` — ground disc radius, an optional ring-road marker
 *   and deterministic greenery placements from a hash seed (stable across
 *   reloads; no Math.random in the renderer);
 * - `hslaToRgb` — parses the hsla() heat fills from `lib/zoneVisual` into
 *   0..1 rgb triples for Babylon materials (THREE.Color parsed CSS strings;
 *   Babylon Color3 does not);
 * - device/agent placement (`devicePlacements`, `agentPlacements`) — the
 *   GeoWorldMap semantics ported to scene meters: persisted lat/lng projects
 *   against the SAME anchor as the building footprints
 *   (`computePolygonAnchor` + `projectGeoPoint`), otherwise the zone
 *   centroid; co-anchored markers fan out on a sunflower spiral;
 * - `collabEdgesFromSnapshot` — advisory AC edges from the snapshot's
 *   per-agent `activeCollaborations` (agents sharing one collaboration id
 *   get an edge; forming states render dashed, running states solid);
 * - `deviceMarkerKind` / `deviceMarkerColorHex` — role → low-poly shape /
 *   semantic color (mirrors the 2D `roleColor` palette), fault/offline
 *   overrides for the live status channel.
 */

import type { EnvZone } from '../api/types';
import {
  computePolygonAnchor,
  computeZoneBoxes,
  computeZoneExtrusions,
  hasPolygonFootprint,
  metersPerDegree,
  resolveStoreyHeight,
  type CameraPose,
  type ComputeZoneBoxesOptions,
  type SceneBounds,
  type Vec3,
  type ZoneBox,
  type ZoneExtrusion,
} from './building3d';
import type { WorldModelAgent, WorldModelDevice } from './worldModel';

export {
  DEFAULT_STOREY_HEIGHT,
  LABEL_ALL_THRESHOLD,
  ZONE_CATEGORY_COLORS,
  computePolygonAnchor,
  computeSceneBoundsWithExtrusions,
  computeZoneBoxes,
  computeZoneExtrusions,
  hasPolygonFootprint,
  initialCameraPose,
  metersPerDegree,
  resolveStoreyHeight,
} from './building3d';
export type {
  CameraPose,
  ComputeZoneBoxesOptions,
  SceneBounds,
  Vec3,
  ZoneBox,
  ZoneExtrusion,
} from './building3d';

// ---------------------------------------------------------------------------
// Building aggregation
// ---------------------------------------------------------------------------

/** One storey of one building: deduped footprint slabs + bbox/fallback boxes. */
export interface CampusFloorSlab {
  floor: number;
  /** Footprint extrusions (polygon zones), deduped by identical ring. */
  extrusions: ZoneExtrusion[];
  /** bbox / fallback-placed zone boxes (non-polygon zones). */
  boxes: ZoneBox[];
}

export interface CampusBuilding {
  /** zone.buildingId, or a synthesized `__solo__:<zoneId>` when absent. */
  buildingId: string;
  /** Display name: common zone-name prefix, else buildingId / zone name. */
  name: string;
  /** Floors ascending by floor index. */
  floors: CampusFloorSlab[];
  /** Highest floor index present (label/cap placement). */
  maxFloor: number;
  /** Horizontal bbox center in scene meters (x = east, z = south). */
  centroid: { x: number; z: number };
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Zones without a buildingId get a stable per-zone key (never merged). */
const SOLO_PREFIX = '__solo__:';

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Longest common prefix of zone names, trailing separators/digits trimmed —
 * 「A栋-101」「A栋-102」 →「A栋」. Returns '' when there is no usable stem.
 */
function commonNamePrefix(names: readonly string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (prefix.length > 0 && !name.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) return '';
  }
  return prefix.replace(/[\s\-_—·:：0-9]+$/u, '').trim();
}

function buildingDisplayName(key: string, names: readonly string[]): string {
  if (key.startsWith(SOLO_PREFIX)) return names[0] ?? key;
  const prefix = commonNamePrefix(names);
  return prefix.length >= 2 ? prefix : key;
}

/** Footprint ring fingerprint for the per-(building, floor) dedupe. */
function ringKeyOf(ext: ZoneExtrusion): string {
  // toFixed renders NaN as "NaN", which would fingerprint unrelated dirty
  // rings identically and falsely dedupe them — tag non-finite coordinates
  // with their vertex index so two dirty rings never collide.
  return ext.points
    .map((p, i) => {
      const x = Number.isFinite(p.x) ? p.x.toFixed(2) : `bad-x${i}`;
      const z = Number.isFinite(p.z) ? p.z.toFixed(2) : `bad-z${i}`;
      return `${x},${z}`;
    })
    .join('|');
}

/**
 * EnvZone list → per-building stacks. Groups by `buildingId`; zones without
 * one stay solo (a world that never declares buildingIds degrades to one
 * pseudo-building per zone, same spatial layout as the flat view).
 */
export function groupZonesByBuilding(
  zones: readonly EnvZone[],
  options: ComputeZoneBoxesOptions = {},
): CampusBuilding[] {
  const boxes = computeZoneBoxes(zones, options);
  const extrusions = computeZoneExtrusions(zones, options);

  interface Group {
    key: string;
    names: string[];
    floors: Map<number, CampusFloorSlab>;
    /** Rings already placed per floor (dedupe identical outlines). */
    seenRings: Map<number, Set<string>>;
  }
  const groups = new Map<string, Group>();
  const groupFor = (buildingId: string | null, zoneId: string): Group => {
    const key = buildingId ?? `${SOLO_PREFIX}${zoneId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, names: [], floors: new Map(), seenRings: new Map() };
      groups.set(key, group);
    }
    return group;
  };
  const slabFor = (group: Group, floor: number): CampusFloorSlab => {
    let slab = group.floors.get(floor);
    if (!slab) {
      slab = { floor, extrusions: [], boxes: [] };
      group.floors.set(floor, slab);
    }
    return slab;
  };

  for (const ext of extrusions) {
    const group = groupFor(ext.buildingId, ext.zoneId);
    group.names.push(ext.name);
    let seen = group.seenRings.get(ext.floor);
    if (!seen) {
      seen = new Set();
      group.seenRings.set(ext.floor, seen);
    }
    const ringKey = ringKeyOf(ext);
    if (seen.has(ringKey)) continue;
    seen.add(ringKey);
    slabFor(group, ext.floor).extrusions.push(ext);
  }
  for (const box of boxes) {
    const group = groupFor(box.buildingId, box.zoneId);
    group.names.push(box.name);
    slabFor(group, box.floor).boxes.push(box);
  }

  return [...groups.values()].map(group => {
    const floors = [...group.floors.values()].sort((a, b) => a.floor - b.floor);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const slab of floors) {
      for (const ext of slab.extrusions) {
        minX = Math.min(minX, ext.bbox.minX);
        maxX = Math.max(maxX, ext.bbox.maxX);
        minZ = Math.min(minZ, ext.bbox.minZ);
        maxZ = Math.max(maxZ, ext.bbox.maxZ);
      }
      for (const box of slab.boxes) {
        minX = Math.min(minX, box.position.x - box.size.x / 2);
        maxX = Math.max(maxX, box.position.x + box.size.x / 2);
        minZ = Math.min(minZ, box.position.z - box.size.z / 2);
        maxZ = Math.max(maxZ, box.position.z + box.size.z / 2);
      }
    }
    const bbox = { minX, maxX, minZ, maxZ };
    return {
      buildingId: group.key,
      name: buildingDisplayName(group.key, group.names),
      floors,
      maxFloor: floors.length > 0 ? floors[floors.length - 1].floor : 0,
      centroid: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
      bbox,
    };
  });
}

// ---------------------------------------------------------------------------
// Camera pose
// ---------------------------------------------------------------------------

export interface ArcPose {
  alpha: number;
  beta: number;
  radius: number;
  target: Vec3;
}

/** Keep beta off the poles so ArcRotateCamera never flips. */
const BETA_EPSILON = 0.05;

/**
 * three.js-style position/target pose → ArcRotateCamera spherical pose.
 * Babylon mapping (arcRotateCamera `_getViewMatrix`):
 * position = target + radius · (cos α·sin β, cos β, sin α·sin β).
 */
export function arcPoseFromPose(pose: CameraPose): ArcPose {
  const dx = pose.position.x - pose.target.x;
  const dy = pose.position.y - pose.target.y;
  const dz = pose.position.z - pose.target.z;
  const radius = Math.max(Math.hypot(dx, dy, dz), 1);
  const beta = Math.acos(clampNumber(dy / radius, -1, 1));
  return {
    alpha: Math.atan2(dz, dx),
    beta: clampNumber(beta, BETA_EPSILON, Math.PI - BETA_EPSILON),
    radius,
    target: { ...pose.target },
  };
}

/** Forward Babylon mapping (offset from target) — roundtrip helper for tests. */
export function arcPoseOffset(pose: ArcPose): Vec3 {
  return {
    x: pose.radius * Math.cos(pose.alpha) * Math.sin(pose.beta),
    y: pose.radius * Math.cos(pose.beta),
    z: pose.radius * Math.sin(pose.alpha) * Math.sin(pose.beta),
  };
}

// ---------------------------------------------------------------------------
// Ground plan (deterministic greenery / ring road)
// ---------------------------------------------------------------------------

export interface CampusTreeSpot {
  x: number;
  z: number;
  /** Uniform scale multiplier on the base tree (~0.8–1.5). */
  scale: number;
  /** Y rotation in radians (varies the low-poly silhouette). */
  rotation: number;
}

export interface CampusGroundPlan {
  center: { x: number; z: number };
  /** Ground disc radius in meters. */
  radius: number;
  /** Ring-road marker (null for tiny scenes where it would swallow the buildings). */
  roadRing: { innerRadius: number; outerRadius: number } | null;
  trees: CampusTreeSpot[];
}

/** FNV-1a string hash → uint32 seed. */
export function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 PRNG — small, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Whole-scene ground layout: a disc ~1.8× the scene radius, an optional ring
 * road just past the building cluster, and trees scattered in the band
 * between road and rim. Deterministic for a given (bounds, buildings, seed);
 * trees keep 2 m clear of every building bbox.
 */
export function campusGroundPlan(
  bounds: SceneBounds,
  buildings: readonly CampusBuilding[] = [],
  seed = 'campus3d',
): CampusGroundPlan {
  const sceneRadius = Math.max(bounds.radius, 8);
  const radius = sceneRadius * 1.8;
  const center = { x: bounds.center.x, z: bounds.center.z };
  const rng = mulberry32(hashSeed(seed));

  const roadRing =
    sceneRadius >= 20
      ? { innerRadius: sceneRadius * 1.12, outerRadius: sceneRadius * 1.24 }
      : null;

  const treeBandMin = (roadRing ? roadRing.outerRadius : sceneRadius * 1.05) + 2;
  const treeBandMax = Math.max(radius - 4, treeBandMin + 1);
  const treeCount = Math.round(clampNumber(sceneRadius * 1.1, 12, 80));
  const trees: CampusTreeSpot[] = [];
  let guard = 0;
  while (trees.length < treeCount && guard < treeCount * 20) {
    guard++;
    const angle = rng() * Math.PI * 2;
    const distance = treeBandMin + rng() * (treeBandMax - treeBandMin);
    const x = center.x + Math.cos(angle) * distance;
    const z = center.z + Math.sin(angle) * distance;
    const scale = 0.8 + rng() * 0.7;
    const rotation = rng() * Math.PI * 2;
    const insideBuilding = buildings.some(
      building =>
        Number.isFinite(building.bbox.minX) &&
        x >= building.bbox.minX - 2 &&
        x <= building.bbox.maxX + 2 &&
        z >= building.bbox.minZ - 2 &&
        z <= building.bbox.maxZ + 2,
    );
    if (insideBuilding) continue;
    trees.push({ x, z, scale, rotation });
  }

  return { center, radius, roadRing, trees };
}

// ---------------------------------------------------------------------------
// Heat color parsing
// ---------------------------------------------------------------------------

/**
 * Parse an `hsl(a)(h, s%, l%[, a])` fill (zoneVisual heat overlay) into a
 * 0..1 rgb triple; alpha is dropped (materials stay opaque, the renderer
 * tints the whole slab instead). Returns null for non-hsl input.
 */
export function hslaToRgb(css: string): { r: number; g: number; b: number } | null {
  const match = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(css.trim());
  if (!match) return null;
  const hDeg = parseFloat(match[1]);
  const sPct = parseFloat(match[2]);
  const lPct = parseFloat(match[3]);
  // The regex admits degenerate captures like "." (parseFloat → NaN); a
  // non-finite channel must read as non-hsl input (null), not a NaN triple.
  if (!Number.isFinite(hDeg) || !Number.isFinite(sPct) || !Number.isFinite(lPct)) return null;
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = clampNumber(sPct / 100, 0, 1);
  const l = clampNumber(lPct / 100, 0, 1);
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number): number => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: channel(1 / 3), g: channel(0), b: channel(-1 / 3) };
}

// ---------------------------------------------------------------------------
// Geo projection for markers (same mapping as the footprint extrusions)
// ---------------------------------------------------------------------------

export interface GeoAnchor {
  lat: number;
  lng: number;
}

/**
 * Project one WGS-84 point into scene meters around the shared anchor — the
 * exact mapping `computeZoneExtrusions` applies to footprint rings (x = east,
 * z = south), so lat/lng markers land on the buildings they belong to.
 */
export function projectGeoPoint(
  anchor: GeoAnchor,
  lat: number,
  lng: number,
): { x: number; z: number } {
  const scale = metersPerDegree(anchor.lat);
  return {
    x: (lng - anchor.lng) * scale.east,
    z: -(lat - anchor.lat) * scale.north,
  };
}

/**
 * Inverse of `projectGeoPoint` (scene meters → WGS-84) — placement/drag
 * interactions raycast the 3D ground and report the picked point back to the
 * page's geo state machine as lat/lng.
 */
export function unprojectGeoPoint(anchor: GeoAnchor, x: number, z: number): GeoAnchor {
  const scale = metersPerDegree(anchor.lat);
  return {
    lat: anchor.lat - z / scale.north,
    lng: anchor.lng + x / scale.east,
  };
}

/** Top surface (y) of the slab a zone occupies (floor stack + slab height). */
export function zoneSlabTop(zone: EnvZone | undefined, storeyHeight: number): number {
  const floor = zone?.floor ?? 0;
  const bounds = zone?.bounds;
  const hasZ =
    bounds !== undefined &&
    typeof bounds.minZ === 'number' &&
    typeof bounds.maxZ === 'number' &&
    bounds.maxZ > bounds.minZ;
  return floor * storeyHeight + (hasZ ? bounds.maxZ! : storeyHeight);
}

/** Zone centroid in scene meters: projected polygon centroid, else bounds center. */
export function zoneCentroidMeters(
  zone: EnvZone | undefined,
  anchor: GeoAnchor | null,
): { x: number; z: number } | null {
  if (!zone) return null;
  if (anchor && Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
    // Vertex mean — same convention as building3d's polygonCentroidOf. A
    // dirty ring (NaN / string vertices) yields a non-finite centroid: fall
    // through to bounds instead of poisoning the whole marker batch.
    const lat = zone.polygon.reduce((sum, p) => sum + p[0], 0) / zone.polygon.length;
    const lng = zone.polygon.reduce((sum, p) => sum + p[1], 0) / zone.polygon.length;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return projectGeoPoint(anchor, lat, lng);
  }
  if (zone.bounds) {
    return {
      x: (zone.bounds.minX + zone.bounds.maxX) / 2,
      z: (zone.bounds.minY + zone.bounds.maxY) / 2,
    };
  }
  return null;
}

/**
 * Sunflower-spiral offset for co-anchored markers (k = 0 keeps the anchor).
 * `maxRadiusM` clamps the spiral radius — the golden angle keeps advancing,
 * so overflow markers spread along the clamped ring instead of flying past
 * the building footprint (unclamped, k=100 × 1.6 m unit = 16 m off anchor).
 */
export function sunflowerOffset(
  k: number,
  unitM: number,
  maxRadiusM = Infinity,
): { dx: number; dz: number } {
  if (k <= 0) return { dx: 0, dz: 0 };
  const radius = Math.min(unitM * Math.sqrt(k), maxRadiusM);
  const angle = k * 2.399_963; // golden angle (radians), same as lib/geo fanOutCoAnchored
  return { dx: Math.cos(angle) * radius, dz: Math.sin(angle) * radius };
}

/**
 * Fan-out radius cap for a zone: 0.4 × the half diagonal of its footprint
 * (projected polygon bbox, else bounds), floored at two fan-out units so
 * even a tiny zone fits its first ring. A dirty footprint (NaN extents)
 * degenerates to the floor — never NaN.
 */
function zoneFanOutCapM(zone: EnvZone | undefined, anchor: GeoAnchor | null, unitM: number): number {
  let halfDiag = NaN;
  if (zone && anchor && hasPolygonFootprint(zone)) {
    const xs = zone.polygon!.map(([lat, lng]) => projectGeoPoint(anchor, lat, lng).x);
    const zs = zone.polygon!.map(([lat, lng]) => projectGeoPoint(anchor, lat, lng).z);
    halfDiag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
  } else if (zone?.bounds) {
    halfDiag =
      Math.hypot(zone.bounds.maxX - zone.bounds.minX, zone.bounds.maxY - zone.bounds.minY) / 2;
  }
  return Number.isFinite(halfDiag) ? Math.max(halfDiag * 0.4, unitM * 2) : unitM * 2;
}

// ---------------------------------------------------------------------------
// Visual tuning + alert channel (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Saturate a hex color toward its own hue (S channel × (1+amount)) — the
 * campus visual pass lifts the category palette ~15% so slabs read against
 * the cold-grey ground. Greys (S=0) pass through unchanged.
 */
export function saturateHex(hex: number, amount: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return hex;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  const rgb = hslaToRgb(
    `hsl(${hue}, ${clampNumber(saturation * (1 + amount), 0, 1) * 100}%, ${lightness * 100}%)`,
  )!;
  return (
    (Math.round(rgb.r * 255) << 16) | (Math.round(rgb.g * 255) << 8) | Math.round(rgb.b * 255)
  );
}

/**
 * Alert threshold: the heat scale tops out at 32 °C (zoneVisual HEAT_TEMP_MAX),
 * so 35 °C is unambiguously critical; smoke is a BOOLEAN channel in scenario
 * events (true = detected) with numeric readings accepted defensively. The
 * numeric smoke threshold is calibrated against the engine's smoke model
 * (packages/simulation SpatialField: relaxation 0.010/s ≈ 69 s half-life,
 * diffusion 0.02/s spreads an injection across neighbouring zones): an
 * injected 0.55 peaks at only ~0.14 in the zone reading and decays within
 * seconds at demo timescales, so 0.5 never fired. 0.08 — about half the
 * measured peak — catches the demo hero event without tripping on noise.
 */
export const ZONE_ALERT_TEMP_C = 35;
export const ZONE_ALERT_SMOKE = 0.08;

/** 'critical' when the zone's live parameters cross a severe threshold. */
export function zoneAlertLevel(
  parameters: Record<string, unknown> | undefined,
): 'critical' | null {
  if (!parameters) return null;
  const temperature = parameters.temperature;
  if (
    typeof temperature === 'number' &&
    Number.isFinite(temperature) &&
    temperature >= ZONE_ALERT_TEMP_C
  ) {
    return 'critical';
  }
  const smoke = parameters.smoke;
  if (smoke === true || (typeof smoke === 'number' && smoke >= ZONE_ALERT_SMOKE)) {
    return 'critical';
  }
  return null;
}

/** Snapshot zones → the set of zone ids currently in a critical state. */
export function alertingZoneIds(
  zones: ReadonlyArray<{ id: string; parameters?: Record<string, unknown> }>,
): Set<string> {
  const ids = new Set<string>();
  for (const zone of zones) {
    if (zoneAlertLevel(zone.parameters)) ids.add(zone.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Device markers
// ---------------------------------------------------------------------------

/** Marker hover distance above the slab the device's zone occupies. */
export const DEVICE_HOVER_M = 1.0;
/** Co-anchored device fan-out unit (meters). */
export const DEVICE_FAN_OUT_M = 1.6;

export interface CampusDevicePlacement {
  id: string;
  name: string;
  type: string;
  role: string;
  zoneId: string;
  /** Marker anchor in scene meters (x = east, y = up, z = south). */
  position: Vec3;
  /** True when no persisted position existed (zone-centroid fallback). */
  centroidFallback: boolean;
}

/**
 * WorldModelDevice list → marker anchors. Priority mirrors GeoWorldMap:
 * persisted lat/lng (projected against the shared anchor) → persisted builder
 * position (already world meters; y→z as in computeZoneBoxes) → zone
 * centroid. Co-anchored markers fan out on a sunflower spiral so a zone's
 * sensor pack does not collapse into one dot. Devices whose zone has no
 * geometry at all are skipped (honest absence, same as the 2D maps).
 *
 * Height: markers hover above the ROOFTOP of the device's building (highest
 * slab top across the zone's buildingId group) — slab-top-per-zone buried
 * low-floor markers inside the opaque stack (measured: floor-1 device at
 * 4.5 m under a 7 m roof). Zones without a buildingId fall back to their own
 * slab top.
 */
export function devicePlacements(
  devices: readonly WorldModelDevice[],
  zones: readonly EnvZone[],
  options: { storeyHeight?: number | null; anchor?: GeoAnchor | null } = {},
): CampusDevicePlacement[] {
  const sh = resolveStoreyHeight(options.storeyHeight);
  const anchor = options.anchor === undefined ? computePolygonAnchor(zones) : options.anchor;
  const zoneById = new Map(zones.map(zone => [zone.id, zone]));

  // Rooftop per building: highest slab top among the building's zones.
  const rooftopByBuilding = new Map<string, number>();
  for (const zone of zones) {
    if (!zone.buildingId) continue;
    const top = zoneSlabTop(zone, sh);
    rooftopByBuilding.set(
      zone.buildingId,
      Math.max(rooftopByBuilding.get(zone.buildingId) ?? 0, top),
    );
  }
  const markerTop = (zone: EnvZone | undefined): number =>
    (zone?.buildingId ? rooftopByBuilding.get(zone.buildingId) : undefined) ??
    zoneSlabTop(zone, sh);

  const indexByAnchor = new Map<string, number>();
  const placements: CampusDevicePlacement[] = [];
  for (const device of devices) {
    const zone = zoneById.get(device.zoneId);
    let base: { x: number; z: number } | null = null;
    let centroidFallback = false;
    if (
      device.latLng &&
      anchor &&
      Number.isFinite(device.latLng.lat) &&
      Number.isFinite(device.latLng.lng)
    ) {
      base = projectGeoPoint(anchor, device.latLng.lat, device.latLng.lng);
    } else if (
      device.position &&
      typeof device.position.x === 'number' &&
      Number.isFinite(device.position.x) &&
      typeof device.position.y === 'number' &&
      Number.isFinite(device.position.y)
    ) {
      base = { x: device.position.x, z: device.position.y };
    } else {
      // Zone-centroid fallback — also the fail-safe for corrupt persisted
      // coordinates (string / NaN), matching GeoWorldMap's readLatLng
      // semantics where an unreadable position means "unplaced".
      base = zoneCentroidMeters(zone, anchor);
      centroidFallback = true;
    }
    // A non-finite base (dirty zone polygon) must not reach the shared
    // thin-instance matrices — one NaN placement poisons the whole batch.
    if (!base || !Number.isFinite(base.x) || !Number.isFinite(base.z)) continue;
    const key = `${base.x.toFixed(1)}:${base.z.toFixed(1)}`;
    const k = indexByAnchor.get(key) ?? 0;
    indexByAnchor.set(key, k + 1);
    const { dx, dz } = sunflowerOffset(
      k,
      DEVICE_FAN_OUT_M,
      zoneFanOutCapM(zone, anchor, DEVICE_FAN_OUT_M),
    );
    placements.push({
      id: device.id,
      name: device.name,
      type: device.type,
      role: device.role,
      zoneId: device.zoneId,
      position: { x: base.x + dx, y: markerTop(zone) + DEVICE_HOVER_M, z: base.z + dz },
      centroidFallback,
    });
  }
  return placements;
}

/** Low-poly marker shape per device role (thin-instance group). */
export type DeviceMarkerKind = 'sphere' | 'box' | 'disc';

export function deviceMarkerKind(role: string): DeviceMarkerKind {
  if (role === 'sensor') return 'sphere';
  if (role === 'actuator') return 'box';
  return 'disc'; // hybrid / unknown
}

/**
 * Role colors mirror the 2D `roleColor` palette (lib/theme, LIGHT theme —
 * the campus scene is always light); fault / offline are the live-status
 * overrides from the snapshot channel.
 */
export const DEVICE_ROLE_COLORS: Record<string, number> = {
  sensor: 0x0d9488,
  actuator: 0xb45309,
  hybrid: 0x7c3aed,
  other: 0x525c6b,
};
/** Fault injection active (--danger, light theme). */
export const DEVICE_FAULT_COLOR = 0xcf222e;
/** Coarse status reports the device off — dimmed grey. */
export const DEVICE_OFF_COLOR = 0x9aa3b0;

export function deviceMarkerColorHex(input: {
  role: string;
  fault?: boolean;
  status?: string;
}): number {
  if (input.fault) return DEVICE_FAULT_COLOR;
  if (input.status === 'off') return DEVICE_OFF_COLOR;
  return DEVICE_ROLE_COLORS[input.role] ?? DEVICE_ROLE_COLORS.other;
}

// ---------------------------------------------------------------------------
// Agent avatars
// ---------------------------------------------------------------------------

/** Avatar lift above the anchor surface (capsule center). */
export const AGENT_FLOAT_M = 1.6;
/** Co-anchored agent fan-out unit (meters). */
export const AGENT_FAN_OUT_M = 3.0;

export interface CampusAgentPlacement {
  id: string;
  name: string;
  position: Vec3;
  managedZoneIds: string[];
  boundDeviceIds: string[];
}

/**
 * WorldModelAgent list → avatar anchors, porting GeoWorldMap's agentLatLng
 * priority to scene meters: centroid of bound-device positions → centroid of
 * managed-zone centroids → `fallback` (scene center). Height is the first
 * managed zone's mid-storey (楼层中点). Co-anchored avatars fan out like
 * devices.
 */
export function agentPlacements(
  agents: readonly WorldModelAgent[],
  devicePositionById: ReadonlyMap<string, Vec3>,
  zones: readonly EnvZone[],
  options: {
    storeyHeight?: number | null;
    anchor?: GeoAnchor | null;
    fallback?: { x: number; z: number };
  } = {},
): CampusAgentPlacement[] {
  const sh = resolveStoreyHeight(options.storeyHeight);
  const anchor = options.anchor === undefined ? computePolygonAnchor(zones) : options.anchor;
  const zoneById = new Map(zones.map(zone => [zone.id, zone]));

  const indexByAnchor = new Map<string, number>();
  const placements: CampusAgentPlacement[] = [];
  for (const agent of agents) {
    const managedZones = agent.managedZoneIds
      .map(zoneId => zoneById.get(zoneId))
      .filter((zone): zone is EnvZone => zone !== undefined);
    const devicePoints = agent.boundDeviceIds
      .map(id => devicePositionById.get(id))
      .filter((p): p is Vec3 => p !== undefined);
    const zonePoints = managedZones
      .map(zone => zoneCentroidMeters(zone, anchor))
      .filter((p): p is { x: number; z: number } => p !== null);
    const points: Array<{ x: number; z: number }> =
      devicePoints.length > 0 ? devicePoints : zonePoints;
    const base =
      points.length > 0
        ? {
            x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
            z: points.reduce((sum, p) => sum + p.z, 0) / points.length,
          }
        : options.fallback;
    if (!base || !Number.isFinite(base.x) || !Number.isFinite(base.z)) continue;
    const key = `${base.x.toFixed(1)}:${base.z.toFixed(1)}`;
    const k = indexByAnchor.get(key) ?? 0;
    indexByAnchor.set(key, k + 1);
    // Clamp the spiral to the largest managed zone's footprint so a crowded
    // anchor never throws avatars past the building (no zones → no clamp).
    const caps = managedZones.map(zone => zoneFanOutCapM(zone, anchor, AGENT_FAN_OUT_M));
    const { dx, dz } = sunflowerOffset(
      k,
      AGENT_FAN_OUT_M,
      caps.length > 0 ? Math.max(...caps) : Infinity,
    );
    const midHeight =
      managedZones.length > 0
        ? (managedZones[0].floor ?? 0) * sh + sh / 2
        : AGENT_FLOAT_M;
    placements.push({
      id: agent.id,
      name: agent.name,
      position: { x: base.x + dx, y: midHeight, z: base.z + dz },
      managedZoneIds: agent.managedZoneIds,
      boundDeviceIds: agent.boundDeviceIds,
    });
  }
  return placements;
}

// ---------------------------------------------------------------------------
// Collaboration edges (advisory, from the snapshot's per-agent AC list)
// ---------------------------------------------------------------------------

export type CampusCollabStatus = 'forming' | 'running';

export interface CampusCollabEdge {
  key: string;
  from: string;
  to: string;
  status: CampusCollabStatus;
  name?: string;
}

const AC_FORMING_STATES = new Set(['initializing', 'forming']);
const AC_RUNNING_STATES = new Set(['ready', 'running', 'completing']);

interface SnapshotCollabCarrier {
  id: string;
  activeCollaborations?: ReadonlyArray<{ id?: string; name?: string; status?: string }>;
}

/**
 * Snapshot agents → agent↔agent edges: agents listing the same active
 * collaboration id get one edge per pair. Status mapping mirrors
 * lib/collabGraph (initializing/forming → forming dashed; ready/running/
 * completing → running solid); terminal states drop the edge. The snapshot
 * view is advisory (Fix-10) — good enough for a live overlay, and the poll
 * cadence bounds the lag.
 */
export function collabEdgesFromSnapshot(
  agents: readonly SnapshotCollabCarrier[],
): CampusCollabEdge[] {
  const byCollab = new Map<string, { ids: string[]; status: CampusCollabStatus; name?: string }>();
  for (const agent of agents) {
    for (const ac of agent.activeCollaborations ?? []) {
      if (!ac.id) continue;
      const raw = (ac.status ?? '').toLowerCase();
      const status: CampusCollabStatus | null = AC_RUNNING_STATES.has(raw)
        ? 'running'
        : AC_FORMING_STATES.has(raw) || raw === ''
          ? 'forming'
          : null; // terminal — drop
      if (!status) continue;
      let rec = byCollab.get(ac.id);
      if (!rec) {
        rec = { ids: [], status, ...(ac.name ? { name: ac.name } : {}) };
        byCollab.set(ac.id, rec);
      }
      if (!rec.ids.includes(agent.id)) rec.ids.push(agent.id);
      if (status === 'running') rec.status = 'running';
    }
  }
  const edges: CampusCollabEdge[] = [];
  for (const [collabId, rec] of byCollab) {
    for (let i = 0; i < rec.ids.length; i++) {
      for (let j = i + 1; j < rec.ids.length; j++) {
        edges.push({
          key: `${collabId}:${rec.ids[i]}->${rec.ids[j]}`,
          from: rec.ids[i],
          to: rec.ids[j],
          status: rec.status,
          ...(rec.name ? { name: rec.name } : {}),
        });
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Campus↔walk traversal + floor-aware placement (UX-W4)
// ---------------------------------------------------------------------------

/**
 * 「进入室内」落点 zone：同楼栋（zone.buildingId 精确匹配）中 floor 最小
 * 的 zone —— 从校园点楼体进入室内一律落在 1F 门厅语义上，geo/grid 世界
 * 同一规则。无同楼 zone（包括被点 zone 本身没有 buildingId 的 solo 楼）
 * 回落到被点的 zone 本身。
 */
export function buildingEntryZoneId(
  zones: readonly EnvZone[],
  buildingId: string,
  fallbackZoneId: string,
): string {
  let best: EnvZone | undefined;
  for (const zone of zones) {
    if (zone.buildingId !== buildingId) continue;
    if (best === undefined || (zone.floor ?? 0) < (best.floor ?? 0)) best = zone;
  }
  return best?.id ?? fallbackZoneId;
}

/**
 * 楼层感知放置的 raycast 水平面高度（scene meters）：所选楼层的站立面 —
 * floor 0 即地平面（与既有地平面 raycast 完全一致，退化自然），floor N
 * 为第 N 层楼面 = 第 N-1 层 slab 的顶面（slab 堆叠见 computeZoneBoxes：
 * 第 F 层 slab 占 [F·sh, (F+1)·sh)）。ghost 在平面之上再抬 0.4 m。
 */
export function placementFloorY(floor: number, storeyHeight: number): number {
  return floor * storeyHeight;
}
