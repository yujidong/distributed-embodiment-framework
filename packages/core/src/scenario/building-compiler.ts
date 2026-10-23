/**
 * Building IR compiler — `BuildingIR → scenario JSON v1.0`
 * (design: docs/building-simulation-design.md §5.1).
 *
 * Mapping rules:
 * - room → zone; rectangles keep their bounds, polygons collapse to their
 *   bounding box (the physics layer only uses zone center + radius in v1).
 * - door/open connections → same-floor adjacency (written once per zone
 *   pair; the loader auto-symmetrizes anyway).
 * - stair/elevator/shaft connections → cross-floor shaft zones: rooms in a
 *   shaft group keep their own zones, missing intermediate floors get an
 *   auto-generated shaft zone, and consecutive floors are chained through
 *   explicit adjacency (one floor apart, so the loader's floor-jump warning
 *   never fires).
 * - window-to-outdoor connections → a single auto-generated
 *   `type: 'outdoor'` zone; each flagged room becomes adjacent to it.
 * - envelope entries → `zone.envelopeU`.
 *
 * The compiled document is run through `loadScenarioFile` before being
 * returned, so a successful compile is guaranteed loadable downstream.
 */

import type { ZoneBounds } from '../config/types.js';
import { polygonBounds, type BuildingIR, type IRConnection, type IRRoom } from './building-ir.js';
import { loadScenarioFile } from './scenario-loader.js';

/** Error thrown for structurally invalid IR (dangling references, …). */
export class BuildingCompileError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Building IR compilation failed:\n${issues.map(i => `  - ${i}`).join('\n')}`);
    this.name = 'BuildingCompileError';
    this.issues = issues;
  }
}

export interface CompileOptions {
  /** Scenario id; defaults to a kebab-case slug of `ir.meta.name`. */
  scenarioId?: string;
  description?: string;
}

interface OutZone {
  id: string;
  name?: string;
  type?: string;
  buildingId?: string;
  floor?: number;
  bounds?: ZoneBounds;
  occupancy?: number;
  envelopeU?: number;
  adjacentZoneIds?: string[];
}

/** Raw scenario JSON v1.0 as emitted by the compiler (pre-normalization). */
export interface CompiledScenarioFile {
  version: '1.0';
  meta: {
    id: string;
    name: string;
    description?: string;
    storeyHeight?: number;
  };
  /**
   * Non-validated sidecar (like the geo tier's `map` block): per-floor plan
   * image underlays from IR floors that carry `planImage` + `scale`. The
   * scenario loader drops it; the environment importer recovers it into
   * `map_data.floorPlans` (B-D).
   */
  map?: {
    floorPlans: Array<{
      buildingId?: string;
      floor: number;
      image: string;
      pixelsPerMeter: number;
    }>;
  };
  zones: OutZone[];
  devices: unknown[];
  agents: unknown[];
  events: unknown[];
}

const SHAFT_KINDS = new Set(['stair', 'elevator', 'shaft']);
const SHAFT_ZONE_TYPE: Record<string, string> = {
  stair: 'stairwell',
  elevator: 'elevator',
  shaft: 'shaft',
};
const DEFAULT_STOREY_HEIGHT = 3.5;

/**
 * Compile a Building IR into scenario JSON v1.0. The result is validated
 * with `loadScenarioFile` before returning.
 *
 * @throws BuildingCompileError for invalid IR input.
 * @throws ScenarioValidationError when the compiled output fails scenario
 *   validation (indicates a compiler bug or out-of-range IR values such as
 *   `envelopeU > 1`).
 */
export function compileBuildingIR(ir: BuildingIR, options: CompileOptions = {}): CompiledScenarioFile {
  const issues: string[] = [];
  const rooms = ir.rooms ?? [];
  const connections = ir.connections ?? [];

  const roomById = new Map<string, IRRoom>();
  if (rooms.length === 0) {
    // An empty IR would compile into a scenario that fails loadScenarioFile
    // (zones: minItems 1) with a raw ScenarioValidationError — surface it as
    // a user-facing compile issue instead (usability F-06: stack-face).
    issues.push(
      'the IR contains no rooms — nothing to compile ' +
      '(check the importer warnings: spaces may have failed to map to storeys)',
    );
  }
  rooms.forEach((room, i) => {
    if (!room.id) issues.push(`rooms[${i}]: missing id`);
    else if (roomById.has(room.id)) issues.push(`rooms[${i}]: duplicate id "${room.id}"`);
    else roomById.set(room.id, room);
    if (room.floor === undefined) issues.push(`rooms[${i}] ("${room.id}"): missing floor`);
    if (!room.bounds && !room.polygon) {
      issues.push(`rooms[${i}] ("${room.id}"): no geometry (needs bounds or polygon)`);
    }
  });

  connections.forEach((connection, i) => {
    if (!roomById.has(connection.a)) {
      issues.push(`connections[${i}]: a references unknown room "${connection.a}"`);
    }
    if (connection.kind === 'window-to-outdoor') return;
    if (!connection.b) {
      issues.push(`connections[${i}] (kind "${connection.kind}"): missing b`);
    } else if (!roomById.has(connection.b)) {
      issues.push(`connections[${i}]: b references unknown room "${connection.b}"`);
    }
  });

  (ir.envelope ?? []).forEach((entry, i) => {
    if (!roomById.has(entry.roomId)) {
      issues.push(`envelope[${i}]: references unknown room "${entry.roomId}"`);
    }
  });

  if (issues.length > 0) throw new BuildingCompileError(issues);

  // --- zones from rooms -----------------------------------------------------
  const zones = new Map<string, OutZone>();
  const adjacency = new Map<string, Set<string>>();
  /** Bidirectional link — both zones list each other explicitly. */
  const link = (a: string, b: string) => {
    if (a === b) return;
    for (const [from, to] of [[a, b], [b, a]] as const) {
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from)!.add(to);
    }
  };

  for (const room of rooms) {
    const bounds = room.bounds ?? polygonBounds(room.polygon ?? []);
    const zone: OutZone = { id: room.id };
    if (room.name !== undefined) zone.name = room.name;
    if (room.type !== undefined) zone.type = room.type;
    zone.buildingId = room.buildingId;
    zone.floor = room.floor;
    zone.bounds = bounds;
    if (room.occupancy !== undefined) zone.occupancy = room.occupancy;
    zones.set(room.id, zone);
  }

  // --- same-floor connections -------------------------------------------------
  for (const connection of connections) {
    if (connection.kind === 'door' || connection.kind === 'open') {
      link(connection.a, connection.b!);
    }
  }

  // --- shaft connections (cross-floor) -----------------------------------------
  for (const group of shaftGroups(connections, roomById)) {
    const floors = [...group.floors.keys()].sort((a, b) => a - b);
    if (floors.length === 0) continue;
    const spanMin = floors[0];
    const spanMax = floors[floors.length - 1];
    const template = group.rooms.find(room => room.bounds || room.polygon);
    const templateBounds = template ? template.bounds ?? polygonBounds(template.polygon ?? []) : undefined;

    // Representative zone per floor: the shaft room itself when present,
    // otherwise an auto-generated shaft zone.
    const zoneByFloor = new Map<number, string>();
    for (let floor = spanMin; floor <= spanMax; floor++) {
      const room = group.floors.get(floor);
      if (room) {
        zoneByFloor.set(floor, room.id);
        continue;
      }
      const id = uniqueId(`${group.kind}-f${floor}`, zones);
      const zone: OutZone = {
        id,
        name: `${SHAFT_ZONE_TYPE[group.kind]} (F${floor})`,
        type: SHAFT_ZONE_TYPE[group.kind],
        buildingId: group.buildingId,
        floor,
        ...(templateBounds ? { bounds: { ...templateBounds } } : {}),
      };
      zones.set(id, zone);
      zoneByFloor.set(floor, id);
    }
    for (let floor = spanMin; floor < spanMax; floor++) {
      link(zoneByFloor.get(floor)!, zoneByFloor.get(floor + 1)!);
    }
  }

  // --- outdoor zone --------------------------------------------------------------
  const outdoorRooms = connections
    .filter(connection => connection.kind === 'window-to-outdoor')
    .map(connection => connection.a);
  if (outdoorRooms.length > 0) {
    const outdoorId = uniqueId('outdoor', zones);
    const outdoorZone: OutZone = {
      id: outdoorId,
      name: '室外 / Outdoor',
      type: 'outdoor',
    };
    const overall = overallBounds([...zones.values()]);
    if (overall) {
      outdoorZone.bounds = {
        minX: overall.maxX + 4,
        maxX: overall.maxX + 12,
        minY: overall.minY,
        maxY: overall.maxY,
      };
    }
    zones.set(outdoorId, outdoorZone);
    for (const roomId of new Set(outdoorRooms)) {
      link(roomId, outdoorId);
    }
  }

  // --- envelope --------------------------------------------------------------------
  for (const entry of ir.envelope ?? []) {
    if (entry.uValue !== undefined) {
      zones.get(entry.roomId)!.envelopeU = entry.uValue;
    }
  }

  // --- assemble -----------------------------------------------------------------------
  const outZones = [...zones.values()].map(zone => {
    const neighbors = adjacency.get(zone.id);
    // link() is called once per pair but adjacency is symmetric in effect:
    // emit both directions explicitly for readability (the loader's
    // auto-symmetrize dedupes anyway).
    return neighbors && neighbors.size > 0
      ? { ...zone, adjacentZoneIds: [...neighbors].sort() }
      : zone;
  });

  const scenario: CompiledScenarioFile = {
    version: '1.0',
    meta: {
      id: options.scenarioId ?? slugify(ir.meta.name) ?? 'imported-building',
      name: ir.meta.name,
      description:
        options.description ??
        ir.meta.description ??
        `Auto-generated from Building IR "${ir.meta.name}" — review zone boxes and adjacency before use.`,
      storeyHeight: ir.meta.storeyHeight ?? DEFAULT_STOREY_HEIGHT,
    },
    zones: outZones,
    devices: [],
    agents: [],
    events: [],
  };

  // B-D: per-floor plan-image underlays ride the non-validated `map` block.
  const floorPlans = (ir.floors ?? [])
    .filter(
      floor =>
        typeof floor.planImage === 'string' &&
        floor.planImage.length > 0 &&
        floor.scale !== undefined &&
        Number.isFinite(floor.scale.pixelsPerMeter) &&
        floor.scale.pixelsPerMeter > 0,
    )
    .map(floor => ({
      ...(floor.buildingId !== undefined ? { buildingId: floor.buildingId } : {}),
      floor: floor.floor,
      image: floor.planImage!,
      pixelsPerMeter: floor.scale!.pixelsPerMeter,
    }));
  if (floorPlans.length > 0) {
    scenario.map = { floorPlans };
  }

  // Contract: compiled output must pass full scenario validation.
  loadScenarioFile(scenario);
  return scenario;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ShaftGroup {
  kind: 'stair' | 'elevator' | 'shaft';
  buildingId: string;
  rooms: IRRoom[];
  /** floor → room on that floor (first one wins). */
  floors: Map<number, IRRoom>;
}

/**
 * Union-find over rooms joined by stair/elevator/shaft connections. Each
 * returned group shares one kind and one building (mixed-kind or
 * cross-building groups are split).
 */
function shaftGroups(connections: IRConnection[], roomById: Map<string, IRRoom>): ShaftGroup[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  const shaftConnections = connections.filter(c => SHAFT_KINDS.has(c.kind) && c.b);
  for (const c of shaftConnections) {
    if (!parent.has(c.a)) parent.set(c.a, c.a);
    if (!parent.has(c.b!)) parent.set(c.b!, c.b!);
    union(c.a, c.b!);
  }

  const groups = new Map<string, ShaftGroup>();
  for (const c of shaftConnections) {
    const room = roomById.get(c.a)!;
    const kind = c.kind as ShaftGroup['kind'];
    const key = `${find(c.a)}::${kind}::${room.buildingId}`;
    if (!groups.has(key)) {
      groups.set(key, { kind, buildingId: room.buildingId, rooms: [], floors: new Map() });
    }
    const group = groups.get(key)!;
    for (const memberId of [c.a, c.b!]) {
      const member = roomById.get(memberId)!;
      if (!group.rooms.includes(member)) {
        group.rooms.push(member);
        if (!group.floors.has(member.floor)) group.floors.set(member.floor, member);
      }
    }
  }
  return [...groups.values()];
}

function overallBounds(zones: OutZone[]): ZoneBounds | undefined {
  let result: ZoneBounds | undefined;
  for (const zone of zones) {
    if (!zone.bounds) continue;
    result = result
      ? {
          minX: Math.min(result.minX, zone.bounds.minX),
          maxX: Math.max(result.maxX, zone.bounds.maxX),
          minY: Math.min(result.minY, zone.bounds.minY),
          maxY: Math.max(result.maxY, zone.bounds.maxY),
        }
      : { ...zone.bounds };
  }
  return result;
}

function uniqueId(base: string, zones: Map<string, OutZone>): string {
  if (!zones.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!zones.has(candidate)) return candidate;
  }
}

/** kebab-case slug; undefined when nothing usable remains. */
function slugify(text: string): string | undefined {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : undefined;
}
