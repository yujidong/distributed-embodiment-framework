/**
 * OSM import lane (UX wave-3) — OpenStreetMap building footprints → scenario
 * JSON draft, via the Overpass API.
 *
 * Generalized from scripts/build-xjtlu-taicang.mjs (which hard-codes one
 * campus way id): here the caller gives a BBOX or a place-name query, every
 * `building=*` way inside becomes one building, `building:levels` drives
 * per-floor zone stacking at the true polygon ring, and the geo map anchors
 * at the centroid of everything found.
 *
 * Failure honesty:
 * - Overpass unreachable / timing out / erroring on every mirror →
 *   `OsmUnavailableError` (route: 503 OSM_IMPORT_UNAVAILABLE).
 * - A successful answer with zero usable building ways →
 *   `OsmNoBuildingsError` (route: 404 OSM_NO_BUILDINGS_FOUND).
 *
 * `fetchImpl` is the test seam — production uses global fetch, tests inject
 * a stub (the suite must never hit the real Overpass).
 */

export class OsmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsmUnavailableError';
  }
}

export class OsmNoBuildingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsmNoBuildingsError';
  }
}

export interface OsmImportInput {
  /** [south, west, north, east] in degrees. */
  bbox?: [number, number, number, number];
  /** Place name resolved through an Overpass area query. */
  query?: string;
}

export interface OsmImportDeps {
  fetchImpl?: typeof fetch;
  mirrors?: string[];
  /** Per-mirror wall-clock budget (default 30s). */
  timeoutMs?: number;
  /** Cap on buildings taken into the draft (default 30). */
  maxBuildings?: number;
}

export interface OsmDraftResult {
  draft: Record<string, unknown>;
  warnings: string[];
}

const DEFAULT_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUILDINGS = 30;
const MAX_LEVELS = 50;
/** Upper bound on the Overpass element budget requested. */
const OUT_LIMIT = 400;

interface OsmElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

/** Build the Overpass QL query for the input. */
export function overpassQueryFor(input: OsmImportInput): string {
  if (input.bbox !== undefined) {
    const [south, west, north, east] = input.bbox;
    return (
      `[out:json][timeout:25];` +
      `(way["building"](${south},${west},${north},${east}););` +
      `out tags geom ${OUT_LIMIT};`
    );
  }
  // Place-name path: resolve the name to an Overpass area, then take the
  // building ways inside it. Quotes/backslashes are rejected by the route.
  const name = input.query!;
  return (
    `[out:json][timeout:25];` +
    `area["name"="${name}"]->.searchArea;` +
    `(way["building"](area.searchArea););` +
    `out tags geom ${OUT_LIMIT};`
  );
}

async function queryOverpass(query: string, deps: OsmImportDeps): Promise<OsmElement[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const mirrors = deps.mirrors ?? DEFAULT_MIRRORS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: Error | undefined;
  for (const mirror of mirrors) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'eaf-osm-import/1.0 (building footprint import)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) {
        lastError = new Error(`overpass ${mirror} answered HTTP ${res.status}`);
        continue; // rate limit / overload on one mirror → try the next
      }
      const body = (await res.json()) as { elements?: OsmElement[] };
      return Array.isArray(body.elements) ? body.elements : [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new OsmUnavailableError(
    `Overpass is unreachable right now (${lastError?.message ?? 'no mirror answered'}). ` +
    'The OSM import lane proxies the public Overpass API — retry in a moment, or import a ' +
    'floor-plan image / IFC file instead.',
  );
}

interface BuildingFootprint {
  wayId: number;
  name: string;
  levels: number;
  /** [lat, lng] ring without the closing duplicate. */
  ring: Array<[number, number]>;
  centroid: { lat: number; lng: number };
  buildingKind?: string;
}

function toFootprints(elements: OsmElement[], warnings: string[]): BuildingFootprint[] {
  const footprints: BuildingFootprint[] = [];
  let skipped = 0;
  for (const element of elements) {
    if (element.type !== 'way' || typeof element.id !== 'number') continue;
    const geometry = element.geometry ?? [];
    if (geometry.length < 4) {
      skipped += 1;
      continue;
    }
    let ring: Array<[number, number]> = geometry.map(p => [p.lat, p.lon]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) ring = ring.slice(0, -1);
    if (ring.length < 3) {
      skipped += 1;
      continue;
    }
    const tags = element.tags ?? {};
    const parsedLevels = Number.parseInt(tags['building:levels'] ?? '', 10);
    const levels = Number.isInteger(parsedLevels) && parsedLevels >= 1
      ? Math.min(parsedLevels, MAX_LEVELS)
      : 1;
    const centroid = {
      lat: ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
      lng: ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
    };
    footprints.push({
      wayId: element.id,
      name: tags.name ?? `OSM way ${element.id}`,
      levels,
      ring,
      centroid,
      ...(typeof tags.building === 'string' && tags.building !== 'yes'
        ? { buildingKind: tags.building }
        : {}),
    });
  }
  if (skipped > 0) {
    warnings.push(`${skipped} building way(s) had unusable geometry and were skipped`);
  }
  return footprints;
}

/** Rough zoom heuristic from the lat/lng span of the imported area. */
function zoomForSpan(spanDeg: number): number {
  if (spanDeg > 0.5) return 12;
  if (spanDeg > 0.1) return 13;
  if (spanDeg > 0.02) return 15;
  return 17;
}

/**
 * Query Overpass and compile the footprints into a scenario JSON draft
 * (NOT persisted — the caller reviews and imports it via POST
 * /api/environments).
 */
export async function buildOsmScenarioDraft(
  input: OsmImportInput,
  deps: OsmImportDeps = {},
): Promise<OsmDraftResult> {
  const warnings: string[] = [];
  const elements = await queryOverpass(overpassQueryFor(input), deps);
  const footprints = toFootprints(elements, warnings);
  if (footprints.length === 0) {
    const where = input.bbox !== undefined
      ? `bbox [${input.bbox.join(', ')}]`
      : `place "${input.query}"`;
    throw new OsmNoBuildingsError(
      `no OpenStreetMap building outlines found for ${where}. ` +
      'The area may have no traced buildings, the bbox may be too small, or the place name ' +
      'did not resolve — widen the area or check openstreetmap.org for coverage.',
    );
  }

  const maxBuildings = deps.maxBuildings ?? DEFAULT_MAX_BUILDINGS;
  const taken = footprints.slice(0, maxBuildings);
  if (footprints.length > taken.length) {
    warnings.push(
      `${footprints.length} buildings found — the draft keeps the first ${taken.length} ` +
      '(narrow the bbox to import a different subset)',
    );
  }

  const zones: unknown[] = [];
  for (const building of taken) {
    const buildingId = `way-${building.wayId}`;
    for (let floor = 0; floor < building.levels; floor++) {
      zones.push({
        id: `${buildingId}-f${floor + 1}`,
        name: `${building.name} · ${floor + 1}F`,
        type: floor === 0 ? 'lobby' : (building.buildingKind ?? 'building'),
        buildingId,
        floor,
        polygon: building.ring,
      });
    }
  }

  const lat0 = taken.reduce((sum, b) => sum + b.centroid.lat, 0) / taken.length;
  const lng0 = taken.reduce((sum, b) => sum + b.centroid.lng, 0) / taken.length;
  const latSpan = Math.max(...taken.map(b => b.centroid.lat)) - Math.min(...taken.map(b => b.centroid.lat));
  const lngSpan = Math.max(...taken.map(b => b.centroid.lng)) - Math.min(...taken.map(b => b.centroid.lng));

  const draft = {
    version: '1.0',
    meta: {
      id: 'osm-import',
      name: `OSM 建筑轮廓导入（${taken.length} 栋）`,
      description:
        // R2-FEAT-09: this text becomes the created environment's
        // user-facing description — product language, no API/POST jargon.
        `来自 OpenStreetMap 的建筑轮廓草案（${taken.length} 栋建筑、${zones.length} 个楼层区域）。` +
        '请在确认前核对区域轮廓与楼层数。',
    },
    map: {
      type: 'geo',
      center: { lat: lat0, lng: lng0 },
      zoom: zoomForSpan(Math.max(latSpan, lngSpan)),
    },
    zones,
    devices: [],
    agents: [],
    events: [],
  };
  return { draft, warnings };
}
