/**
 * Building IR — intermediate representation between building importers and
 * the scenario compiler (design: docs/building-simulation-design.md §5.1).
 *
 * Both importers (B-C IFC, B-D drawing/CV) produce this same shape; the
 * compiler (`building-compiler.ts`) turns it into scenario JSON v1.0 that
 * passes `loadScenarioFile` unchanged — downstream loading, validation and
 * simulation pipelines stay untouched.
 *
 * Coordinates follow the platform convention: meters, y pointing down,
 * origin at the top-left of the floor plan. Every floor keeps its own 2D
 * plan coordinates; vertical coupling is expressed through `connections`,
 * never through 3D geometry.
 */

import type { ZoneBounds } from '../config/types.js';

/** IR metadata. */
export interface BuildingIRMeta {
  /** Human-readable building/project name. */
  name: string;
  /** Floor-to-floor height in meters. Defaults to 3.5 at compile time. */
  storeyHeight?: number;
  /**
   * Source length unit (informational). Importers must normalize all
   * geometry to meters before emitting the IR.
   */
  units?: string;
  description?: string;
}

/** A building in the source model. */
export interface IRBuilding {
  id: string;
  name?: string;
}

/**
 * A storey. `floor` is the platform convention (0 = ground floor); the
 * source elevation (meters) is kept for reference/debugging.
 */
export interface IRFloor {
  buildingId: string;
  floor: number;
  elevation?: number;
  /** B-D only: plan-image underlay for the confirmation UI. */
  planImage?: string;
  scale?: { pixelsPerMeter: number };
}

/** A room/space. Geometry is `bounds` OR `polygon`; the compiler takes the
 * bounding box either way (the physics layer only uses center + radius). */
export interface IRRoom {
  id: string;
  buildingId: string;
  floor: number;
  name?: string;
  bounds?: ZoneBounds;
  polygon?: [number, number][];
  /** Zone type classification (e.g. 'classroom', 'corridor'). */
  type?: string;
  occupancy?: number;
  /**
   * True when the geometry was NOT extracted from the source model but
   * synthesized by the importer's fallback (e.g. storey grid layout) — the
   * confirmation UI should flag these for manual fixing.
   */
  estimated?: boolean;
}

/** How two rooms (or a room and the outdoors) connect. */
export type IRConnectionKind =
  /** Same-floor door between two rooms. */
  | 'door'
  /** Same-floor open passage (no door leaf). */
  | 'open'
  /** Vertical connections — the compiler auto-generates shaft zones. */
  | 'stair'
  | 'elevator'
  | 'shaft'
  /** Room boundary facing the outdoors (window / external door). */
  | 'window-to-outdoor';

export interface IRConnection {
  /** Room id. */
  a: string;
  /**
   * Second room id. Required for every kind except 'window-to-outdoor',
   * where the outdoor side is implicit.
   */
  b?: string;
  kind: IRConnectionKind;
}

/** Per-room envelope (facade) thermal parameter. */
export interface IREnvelopeEntry {
  roomId: string;
  /**
   * U-value semantics, simplified to one scalar per room (0 = hermetic
   * facade, 1 = open to the weather). Maps to `zone.envelopeU`.
   */
  uValue?: number;
}

/** The full intermediate representation (JSON-serializable). */
export interface BuildingIR {
  meta: BuildingIRMeta;
  buildings: IRBuilding[];
  floors: IRFloor[];
  rooms: IRRoom[];
  connections: IRConnection[];
  envelope: IREnvelopeEntry[];
}

/** Axis-aligned bounding box of a polygon; undefined for < 1 point. */
export function polygonBounds(polygon: [number, number][]): ZoneBounds | undefined {
  if (polygon.length === 0) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}
