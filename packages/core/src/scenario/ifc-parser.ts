/**
 * IFC importer — IFC (STEP text) file → Building IR
 * (design: docs/building-simulation-design.md §5.2, phase B-C).
 *
 * Parsing goes through web-ifc (WASM build of IfcOpenShell), used in
 * attribute-only mode: the entity graph (`GetLine`) is traversed directly,
 * no mesh geometry is generated. Extracted:
 *
 * - `IfcBuildingStorey` → floors (sorted by Elevation; the elevation delta
 *   gives `meta.storeyHeight`, default 3.5 m).
 * - `IfcRelContainedInSpatialStructure` → space→storey mapping.
 * - `IfcSpace` → rooms (Name/LongName; footprint from the `IfcBoundingBox`
 *   representation item, offset by the space's IfcLocalPlacement chain —
 *   axis directions are ignored, only translations accumulate).
 * - `IfcRelSpaceBoundary` → connections: two spaces sharing one `IfcDoor`
 *   → 'door'; a space bounded by an `IfcWindow` or an EXTERNAL door →
 *   'window-to-outdoor'; element-less VIRTUAL boundaries sharing one
 *   connection geometry → 'open'.
 *
 * Graceful degradation: spaces without a bounding box get a synthesized
 * grid cell inside their storey and are flagged `estimated: true` for the
 * confirmation UI. Stair/elevator/shaft connections are NOT derived from
 * IFC yet (left empty for the confirmation UI). Material-layer U-values are
 * not extracted (envelope stays empty).
 *
 * web-ifc is loaded lazily on first use so importing this module costs
 * nothing for consumers that never parse IFC.
 */

import type { ZoneBounds } from '../config/types.js';
import type {
  BuildingIR,
  IRBuilding,
  IRConnection,
  IRFloor,
  IRRoom,
} from './building-ir.js';

/** Error thrown for unreadable / structurally unusable IFC input. */
export class IfcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IfcParseError';
  }
}

export interface ParseIfcOptions {
  /** Overrides the IR/scenario name (defaults to project or building name). */
  name?: string;
}

export interface IfcImportResult {
  ir: BuildingIR;
  /** Non-fatal issues (skipped spaces, estimated geometry, …). */
  warnings: string[];
}

const DEFAULT_STOREY_HEIGHT = 3.5;
/** Fallback cell size for spaces without extractable geometry. */
const FALLBACK_CELL_W = 8;
const FALLBACK_CELL_H = 6;

type WebIfc = typeof import('web-ifc');
type IfcAPIInstance = InstanceType<WebIfc['IfcAPI']>;

let sharedApi: Promise<{ module: WebIfc; api: IfcAPIInstance }> | undefined;

/** Lazily load web-ifc and initialize its WASM runtime (once per process). */
function loadApi(): Promise<{ module: WebIfc; api: IfcAPIInstance }> {
  sharedApi ??= (async () => {
    let module: WebIfc;
    try {
      module = await import('web-ifc');
    } catch (error) {
      throw new IfcParseError(
        'web-ifc is not available — install it in @active-collaboration/core ' +
        `(${(error as Error).message})`,
      );
    }
    const api = new module.IfcAPI();
    try {
      await api.Init();
    } catch (error) {
      throw new IfcParseError(`web-ifc WASM runtime failed to initialize: ${(error as Error).message}`);
    }
    return { module, api };
  })();
  return sharedApi;
}

/**
 * Parse IFC STEP text into a Building IR.
 *
 * @throws IfcParseError for non-STEP input, unreadable files, or models
 *   without any IfcBuildingStorey (floors cannot be derived).
 */
export async function parseIfcToIR(
  input: string | Uint8Array,
  options: ParseIfcOptions = {},
): Promise<IfcImportResult> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (!head.includes('ISO-10303-21')) {
    throw new IfcParseError(
      'not an IFC STEP file: missing "ISO-10303-21;" header ' +
      '(IFC must be supplied as STEP text, not IFCXML/ifcZIP)',
    );
  }

  const { module: ifc, api } = await loadApi();
  let modelID: number;
  try {
    modelID = api.OpenModel(bytes);
  } catch (error) {
    throw new IfcParseError(`web-ifc could not parse the file: ${(error as Error).message}`);
  }

  const warnings: string[] = [];
  try {
    return parseModel(ifc, api, modelID, options, warnings);
  } finally {
    try {
      api.CloseModel(modelID);
    } catch {
      // best-effort close; the WASM module stays alive for the next model
    }
  }
}

// ---------------------------------------------------------------------------
// Model traversal
// ---------------------------------------------------------------------------

function parseModel(
  ifc: WebIfc,
  api: IfcAPIInstance,
  modelID: number,
  options: ParseIfcOptions,
  warnings: string[],
): IfcImportResult {
  const getLine = (expressID: number, flatten = false): any => api.GetLine(modelID, expressID, flatten);
  const lineIdsOf = (type: number): number[] => {
    const vector = api.GetLineIDsWithType(modelID, type);
    const ids: number[] = [];
    for (let i = 0; i < vector.size(); i++) ids.push(vector.get(i));
    return ids;
  };

  // --- storeys → floors -----------------------------------------------------
  interface StoreyInfo { expressID: number; name?: string; elevation?: number }
  const storeys: StoreyInfo[] = lineIdsOf(ifc.IFCBUILDINGSTOREY).map(expressID => {
    const line = getLine(expressID);
    return {
      expressID,
      name: unwrapString(line.LongName) ?? unwrapString(line.Name),
      elevation: unwrapNumber(line.Elevation),
    };
  });
  if (storeys.length === 0) {
    throw new IfcParseError(
      'no IfcBuildingStorey found — floors cannot be derived. ' +
      'If this is a valid IFC file it may use a spatial structure this importer does not understand yet.',
    );
  }
  storeys.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  const floorOfStorey = new Map<number, number>();
  storeys.forEach((storey, index) => floorOfStorey.set(storey.expressID, index));

  let storeyHeight = DEFAULT_STOREY_HEIGHT;
  for (let i = 1; i < storeys.length; i++) {
    const prev = storeys[i - 1].elevation;
    const curr = storeys[i].elevation;
    if (prev !== undefined && curr !== undefined && curr - prev > 0.01) {
      storeyHeight = round3(curr - prev);
      break;
    }
  }

  // --- buildings --------------------------------------------------------------
  const buildings: IRBuilding[] = [];
  const buildingIdByExpress = new Map<number, string>();
  for (const expressID of lineIdsOf(ifc.IFCBUILDING)) {
    const line = getLine(expressID);
    const name = unwrapString(line.LongName) ?? unwrapString(line.Name);
    const id = slugify(name ?? '') ?? `building-${buildings.length + 1}`;
    buildingIdByExpress.set(expressID, id);
    buildings.push({ id, ...(name ? { name } : {}) });
  }
  if (buildings.length === 0) {
    buildings.push({ id: 'building' });
    warnings.push('no IfcBuilding found — synthesized a single building "building"');
  }

  // storey → building via IfcRelAggregates (RelatingObject = building).
  const buildingOfStorey = new Map<number, string>();
  for (const expressID of lineIdsOf(ifc.IFCRELAGGREGATES)) {
    const line = getLine(expressID);
    const relating = unwrapRef(line.RelatingObject);
    const buildingId = relating !== undefined ? buildingIdByExpress.get(relating) : undefined;
    if (!buildingId) continue;
    for (const related of asArray(line.RelatedObjects)) {
      const storeyId = unwrapRef(related);
      if (storeyId !== undefined && floorOfStorey.has(storeyId)) {
        buildingOfStorey.set(storeyId, buildingId);
      }
    }
  }
  const defaultBuildingId = buildings[0].id;

  const floors: IRFloor[] = storeys.map((storey, index) => ({
    buildingId: buildingOfStorey.get(storey.expressID) ?? defaultBuildingId,
    floor: index,
    ...(storey.elevation !== undefined ? { elevation: storey.elevation } : {}),
  }));

  // --- spaces → rooms -----------------------------------------------------------
  interface SpaceInfo { expressID: number; name?: string; bounds?: ZoneBounds }
  const spaces = new Map<number, SpaceInfo>();
  for (const expressID of lineIdsOf(ifc.IFCSPACE)) {
    const line = getLine(expressID);
    spaces.set(expressID, {
      expressID,
      name: unwrapString(line.LongName) ?? unwrapString(line.Name),
      bounds: spaceFootprint(ifc, getLine, line, warnings, expressID),
    });
  }

  // space → storey via IfcRelContainedInSpatialStructure.
  const storeyOfSpace = new Map<number, number>();
  for (const expressID of lineIdsOf(ifc.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const line = getLine(expressID);
    const relating = unwrapRef(line.RelatingStructure);
    if (relating === undefined || !floorOfStorey.has(relating)) continue;
    for (const related of asArray(line.RelatedElements)) {
      const spaceId = unwrapRef(related);
      if (spaceId !== undefined && spaces.has(spaceId)) {
        storeyOfSpace.set(spaceId, relating);
      }
    }
  }

  const rooms: IRRoom[] = [];
  const usedRoomIds = new Set<string>();
  const roomIdOfSpace = new Map<number, string>();
  const missingByFloor = new Map<number, SpaceInfo[]>();

  for (const space of spaces.values()) {
    const storeyId = storeyOfSpace.get(space.expressID);
    if (storeyId === undefined) {
      warnings.push(
        `space "${space.name ?? space.expressID}" is not contained in any storey — skipped`,
      );
      continue;
    }
    const floor = floorOfStorey.get(storeyId)!;
    const base = slugify(space.name ?? '') ?? `space-${space.expressID}`;
    let id = `${base}-f${floor}`;
    if (usedRoomIds.has(id)) id = `${id}-${space.expressID}`;
    usedRoomIds.add(id);
    roomIdOfSpace.set(space.expressID, id);

    const room: IRRoom = {
      id,
      buildingId: buildingOfStorey.get(storeyId) ?? defaultBuildingId,
      floor,
      ...(space.name ? { name: space.name } : {}),
      type: 'room',
    };
    if (space.bounds) {
      room.bounds = space.bounds;
    } else {
      if (!missingByFloor.has(floor)) missingByFloor.set(floor, []);
      missingByFloor.get(floor)!.push(space);
      room.estimated = true;
    }
    rooms.push(room);
  }

  // Fallback geometry: grid layout per storey for spaces without a footprint.
  for (const [floor, missing] of missingByFloor) {
    const cols = Math.ceil(Math.sqrt(missing.length));
    missing.forEach((space, index) => {
      const room = rooms.find(r => r.id === roomIdOfSpace.get(space.expressID))!;
      const col = index % cols;
      const row = Math.floor(index / cols);
      room.bounds = {
        minX: col * FALLBACK_CELL_W,
        maxX: (col + 1) * FALLBACK_CELL_W,
        minY: row * FALLBACK_CELL_H,
        maxY: (row + 1) * FALLBACK_CELL_H,
      };
    });
    warnings.push(
      `floor ${floor}: ${missing.length} space(s) without extractable geometry — ` +
      `assigned fallback grid cells (${FALLBACK_CELL_W}×${FALLBACK_CELL_H} m), marked estimated`,
    );
  }

  // --- connections (IfcRelSpaceBoundary) -----------------------------------------
  const doorIds = new Set(lineIdsOf(ifc.IFCDOOR));
  const windowIds = new Set(lineIdsOf(ifc.IFCWINDOW));
  const connections: IRConnection[] = [];
  const seenConnection = new Set<string>();
  const pushConnection = (a: string, b: string | undefined, kind: IRConnection['kind']) => {
    const key = [kind, ...(b ? [a, b].sort() : [a])].join('|');
    if (seenConnection.has(key)) return;
    seenConnection.add(key);
    connections.push(b !== undefined ? { a, b, kind } : { a, kind });
  };

  interface BoundaryGroup { spaces: Set<number>; externals: Set<number> }
  const groupsByElement = new Map<number, BoundaryGroup>();
  const virtualGroups = new Map<number, BoundaryGroup>();
  for (const expressID of lineIdsOf(ifc.IFCRELSPACEBOUNDARY)) {
    const line = getLine(expressID);
    const space = unwrapRef(line.RelatingSpace);
    if (space === undefined || !roomIdOfSpace.has(space)) continue;
    const element = unwrapRef(line.RelatedBuildingElement);
    const external = unwrapEnum(line.InternalOrExternalBoundary) === 'EXTERNAL';
    let group: BoundaryGroup | undefined;
    if (element !== undefined) {
      if (!groupsByElement.has(element)) groupsByElement.set(element, { spaces: new Set(), externals: new Set() });
      group = groupsByElement.get(element)!;
    } else if (unwrapEnum(line.PhysicalOrVirtualBoundary) === 'VIRTUAL') {
      const geometry = unwrapRef(line.ConnectionGeometry);
      if (geometry === undefined) continue;
      if (!virtualGroups.has(geometry)) virtualGroups.set(geometry, { spaces: new Set(), externals: new Set() });
      group = virtualGroups.get(geometry)!;
    }
    if (!group) continue;
    group.spaces.add(space);
    if (external) group.externals.add(space);
  }

  for (const [element, group] of groupsByElement) {
    const roomIds = [...group.spaces].map(id => roomIdOfSpace.get(id)!);
    if (doorIds.has(element)) {
      if (roomIds.length >= 2) {
        for (let i = 0; i < roomIds.length; i++) {
          for (let j = i + 1; j < roomIds.length; j++) {
            pushConnection(roomIds[i], roomIds[j], 'door');
          }
        }
      } else if (group.externals.size > 0) {
        pushConnection(roomIds[0], undefined, 'window-to-outdoor');
      } else {
        warnings.push(`door #${element} bounds only one interior space — no connection emitted`);
      }
    } else if (windowIds.has(element)) {
      for (const roomId of roomIds) pushConnection(roomId, undefined, 'window-to-outdoor');
    }
    // Other elements (walls, …) carry no adjacency semantics in v1.
  }
  for (const group of virtualGroups.values()) {
    const roomIds = [...group.spaces].map(id => roomIdOfSpace.get(id)!);
    if (roomIds.length >= 2) {
      for (let i = 0; i < roomIds.length; i++) {
        for (let j = i + 1; j < roomIds.length; j++) {
          pushConnection(roomIds[i], roomIds[j], 'open');
        }
      }
    }
  }

  // --- assemble ---------------------------------------------------------------------
  const projectName = firstName(ifc, lineIdsOf, getLine);
  const ir: BuildingIR = {
    meta: {
      name: options.name ?? projectName ?? buildings[0].name ?? 'IFC import',
      storeyHeight,
      units: 'm',
      description:
        'Imported from IFC via web-ifc (attribute-only). Verify estimated rooms ' +
        'and add stair/shaft connections in the confirmation step.',
    },
    buildings,
    floors,
    rooms,
    connections,
    envelope: [],
  };
  if (rooms.length === 0) {
    warnings.push('no IfcSpace could be mapped to a storey — the IR contains no rooms');
  }
  return { ir, warnings };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Extract a space's 2D footprint: first IfcBoundingBox representation item,
 * offset by the accumulated translations of the space's IfcLocalPlacement
 * chain (axis directions ignored). Undefined when no bounding box exists.
 */
function spaceFootprint(
  ifc: WebIfc,
  getLine: (expressID: number, flatten?: boolean) => any,
  spaceLine: any,
  warnings: string[],
  expressID: number,
): ZoneBounds | undefined {
  const representationRef = unwrapRef(spaceLine.Representation);
  if (representationRef === undefined) return undefined;

  let box: any;
  try {
    const representation = getLine(representationRef, true);
    for (const shape of asArray(representation?.Representations)) {
      box = asArray(shape?.Items).find((item: any) => item?.type === ifc.IFCBOUNDINGBOX);
      if (box) break;
    }
  } catch (error) {
    warnings.push(`space #${expressID}: failed to read representation (${(error as Error).message})`);
    return undefined;
  }
  if (!box) return undefined;

  const corner = asArray(box.Corner?.Coordinates).map(unwrapNumber);
  const xDim = unwrapNumber(box.XDim);
  const yDim = unwrapNumber(box.YDim);
  if (corner.length < 2 || corner[0] === undefined || corner[1] === undefined || !xDim || !yDim) {
    return undefined;
  }

  const offset = placementOffset(getLine, spaceLine.ObjectPlacement);
  const minX = round3(corner[0] + offset.x);
  const minY = round3(corner[1] + offset.y);
  return { minX, maxX: round3(minX + xDim), minY, maxY: round3(minY + yDim) };
}

/** Accumulated x/y translation of an IfcLocalPlacement chain (max 8 levels). */
function placementOffset(
  getLine: (expressID: number, flatten?: boolean) => any,
  placementLine: any,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current = placementLine;
  for (let depth = 0; depth < 8 && current; depth++) {
    const ref = typeof current === 'object' && current.value !== undefined ? unwrapRef(current) : undefined;
    const line = ref !== undefined ? getLine(ref) : current;
    if (!line || typeof line !== 'object') break;
    const axisRef = unwrapRef(line.RelativePlacement);
    const axis = axisRef !== undefined ? getLine(axisRef) : undefined;
    const pointRef = axis ? unwrapRef(axis.Location) : undefined;
    const point = pointRef !== undefined ? getLine(pointRef) : undefined;
    const coords = asArray(point?.Coordinates).map(unwrapNumber);
    x += coords[0] ?? 0;
    y += coords[1] ?? 0;
    const nextRef = unwrapRef(line.PlacementRelTo);
    if (nextRef === undefined) break;
    current = getLine(nextRef);
  }
  return { x, y };
}

// ---------------------------------------------------------------------------
// Attribute unwrappers (web-ifc flattened/unflattened shapes)
// ---------------------------------------------------------------------------

function unwrapString(value: any): string | undefined {
  if (value && typeof value.value === 'string') return value.value;
  return undefined;
}

function unwrapNumber(value: any): number | undefined {
  if (value && typeof value._representationValue === 'number') return value._representationValue;
  if (typeof value === 'number') return value;
  return undefined;
}

/** expressID of an entity reference (`{value: <id>, type: REF}`). */
function unwrapRef(value: any): number | undefined {
  if (value && typeof value.value === 'number' && value.type === 5) return value.value;
  if (value && typeof value.expressID === 'number') return value.expressID;
  return undefined;
}

function unwrapEnum(value: any): string | undefined {
  if (value && typeof value.value === 'string') return value.value;
  return undefined;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function firstName(
  ifc: WebIfc,
  lineIdsOf: (type: number) => number[],
  getLine: (expressID: number) => any,
): string | undefined {
  const projects = lineIdsOf(ifc.IFCPROJECT);
  if (projects.length === 0) return undefined;
  const line = getLine(projects[0]);
  return unwrapString(line.LongName) ?? unwrapString(line.Name);
}

function slugify(text: string): string | undefined {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : undefined;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
