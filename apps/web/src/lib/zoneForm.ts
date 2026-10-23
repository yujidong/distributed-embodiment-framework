/**
 * Zone management logic (W6-2) — pure functions for the 区域管理 panel.
 *
 * There is NO zone CRUD API: zones live inside the environment's
 * `map_data_json`. Adding/removing a zone = read the env detail, modify the
 * zones array, and PATCH /api/environments/:id with a full mapData body
 * (the server REPLACES map_data with whatever is sent, so the assembly here
 * preserves every other key — geo `center`/`zoom` and scheduled `events`).
 *
 * - Grid zones carry rectangular `bounds` (form-validated min < max).
 * - Geo zones carry a drawn `polygon` (>= 3 vertices; the server re-checks
 *   with BAD_GEO 400).
 * - Zone deletion is blocked client-side while devices or scheduled events
 *   still reference the zone (a dead zoneId would strand them; the server
 *   also 400s on dangling event references).
 */

import type { EnvironmentDetail, EnvDemoMeta, EnvRoom, EnvZone, ScenarioEvent, ZoneBounds } from '../api/types';
import i18n from '../i18n/config';

/**
 * Full mapData PATCH body shape (wire keys — mirrors the server's geo.ts).
 * The server replaces map_data WHOLESALE on PATCH, so every key a world may
 * carry must be present in the assembled body or it is silently dropped
 * (demo metadata, floor plans, physics meta, governance…).
 */
export interface MapDataPatch {
  zones: unknown[];
  center?: { lat: number; lng: number };
  zoom?: number;
  events?: unknown[];
  demo?: EnvDemoMeta;
  derivedServiceVisibility?: 'members' | 'public';
  floorPlans?: unknown[];
  governance?: Record<string, unknown>;
  /** Building-tier physics meta (server MAP_META_FIELDS — numbers or absent). */
  storeyHeight?: number;
  slabAttenuation?: number;
  envelopeU?: number;
  occupancyHeatW?: number;
  occupancyCo2Rate?: number;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

export interface BaselineRow {
  key: string;
  value: string;
}

/** Suggested baseline parameter keys (zone environment defaults). */
export const BASELINE_KEY_SUGGESTIONS: readonly string[] = [
  'temperature',
  'humidity',
  'co2',
  'light',
  'pm2_5',
];

export interface ZoneFormFields {
  id: string;
  name: string;
  type: string;
  /** Grid worlds only: bounds inputs (all four required, min < max). */
  minX: string;
  maxX: string;
  minY: string;
  maxY: string;
  /** Optional 3D extent (floor/altitude, meters): both or neither, minZ < maxZ. */
  minZ: string;
  maxZ: string;
  baselineRows: BaselineRow[];
  // ── UX-W2: building tier + governance + rooms + occupancy timetable. ──
  /** Building tier (B-A): owning building id; blank = single-building world. */
  buildingId: string;
  /** Building tier (B-A): storey number (0 = ground); blank = unset. */
  floor: string;
  /** T-058a zone consent class ('' = server default 'standard'). */
  consentClass: '' | 'standard' | 'supervised' | 'restricted';
  /** Adjacency declarations (candidates = the env's OTHER zones). */
  adjacentZoneIds: string[];
  /** B-B per-zone envelope flux multiplier; blank = inherit the map meta. */
  envelopeU: string;
  /** R82 declarative interior rooms (name + optional code; no geometry). */
  roomRows: RoomRow[];
  /** FEAT-07 base occupantSchedule (the runtime overlay stays elsewhere). */
  scheduleEnabled: boolean;
  scheduleCount: string;
  /** Window edges as HH:MM (sim-day clock; 28800 = "08:00"). */
  scheduleStart: string;
  scheduleEnd: string;
  scheduleRepeatDaily: boolean;
}

export interface RoomRow {
  name: string;
  code: string;
}

export function createZoneFormFields(): ZoneFormFields {
  return {
    id: '',
    name: '',
    type: '',
    minX: '',
    maxX: '',
    minY: '',
    maxY: '',
    minZ: '',
    maxZ: '',
    baselineRows: [],
    buildingId: '',
    floor: '',
    consentClass: '',
    adjacentZoneIds: [],
    envelopeU: '',
    roomRows: [],
    scheduleEnabled: false,
    scheduleCount: '',
    scheduleStart: '',
    scheduleEnd: '',
    scheduleRepeatDaily: true,
  };
}

/**
 * Default zone id from a display name: lowercased, runs of non [a-z0-9]
 * collapsed to '-', edges trimmed. Falls back to 'zone' (CJK-only names
 * produce nothing — the user edits the id before saving).
 */
export function slugifyZoneId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'zone';
}

const ZONE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Zone id validation: slug format + uniqueness within the environment. */
export function zoneIdError(id: string, existingZoneIds: ReadonlySet<string>): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  if (id.trim().length === 0) return t('idError.empty');
  if (!ZONE_ID_PATTERN.test(id)) {
    return t('idError.format');
  }
  if (existingZoneIds.has(id)) return t('idError.duplicate', { id });
  return null;
}

/** Bounds inputs: all four finite numbers, min strictly below max. */
export function boundsError(fields: Pick<ZoneFormFields, 'minX' | 'maxX' | 'minY' | 'maxY'>): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const values: Array<[string, string]> = [
    ['minX', fields.minX.trim()],
    ['maxX', fields.maxX.trim()],
    ['minY', fields.minY.trim()],
    ['maxY', fields.maxY.trim()],
  ];
  for (const [label, raw] of values) {
    if (raw.length === 0 || !Number.isFinite(Number(raw))) return t('boundsError.notNumber', { label });
  }
  if (Number(fields.minX) >= Number(fields.maxX)) return t('boundsError.minX');
  if (Number(fields.minY) >= Number(fields.maxY)) return t('boundsError.minY');
  return null;
}

/** Optional z bounds: both-or-neither, finite numbers, minZ strictly below maxZ. */
export function zBoundsError(fields: Pick<ZoneFormFields, 'minZ' | 'maxZ'>): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const minRaw = fields.minZ.trim();
  const maxRaw = fields.maxZ.trim();
  if (minRaw.length === 0 && maxRaw.length === 0) return null;
  if (minRaw.length === 0 || maxRaw.length === 0) return t('zBoundsError.paired');
  if (!Number.isFinite(Number(minRaw)) || !Number.isFinite(Number(maxRaw))) {
    return t('zBoundsError.notNumber');
  }
  if (Number(minRaw) >= Number(maxRaw)) return t('zBoundsError.ordering');
  return null;
}

/** Parse one baseline value: boolean literals, else a finite number. */
export function parseBaselineValue(raw: string): number | boolean | null {
  const text = raw.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.length > 0 && Number.isFinite(Number(text))) return Number(text);
  return null;
}

/** Serialize baseline rows; fully-blank rows are dropped, undefined when empty. */
export function rowsToBaseline(
  rows: readonly BaselineRow[],
): Record<string, number | boolean> | undefined {
  const result: Record<string, number | boolean> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    const value = parseBaselineValue(row.value);
    if (value === null) continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Inverse of rowsToBaseline (UX-10): prefill the baseline editor from a stored baseline. */
export function baselineToRows(
  baseline: Record<string, number | boolean> | undefined,
): BaselineRow[] {
  return Object.entries(baseline ?? {}).map(([key, value]) => ({ key, value: String(value) }));
}

/** Baseline rows validation: a keyed row needs a parseable value; keys unique. */
export function baselineError(rows: readonly BaselineRow[]): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) {
      if (row.value.trim().length > 0) return t('baselineError.keyMissing');
      continue;
    }
    if (parseBaselineValue(row.value) === null) {
      return t('baselineError.valueInvalid', { key });
    }
    if (seen.has(key)) return t('baselineError.duplicate', { key });
    seen.add(key);
  }
  return null;
}

// ---------------------------------------------------------------------------
// UX-W2 extra fields (building tier / consent / rooms / occupant schedule)
// ---------------------------------------------------------------------------

/** Storey input: blank = unset, otherwise an integer (0 = ground, B1 = -1). */
export function floorError(floor: string): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const raw = floor.trim();
  if (raw.length === 0) return null;
  if (!Number.isInteger(Number(raw))) return t('floorError.notInteger');
  return null;
}

/** Envelope flux multiplier: blank = inherit; otherwise a finite number >= 0. */
export function envelopeUError(envelopeU: string): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const raw = envelopeU.trim();
  if (raw.length === 0) return null;
  if (!Number.isFinite(Number(raw)) || Number(raw) < 0) return t('envelopeUError.notNumber');
  return null;
}

/** Adjacency declarations must not reference the zone itself. */
export function adjacentZoneIdsError(
  adjacentZoneIds: readonly string[],
  selfId: string,
): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  if (adjacentZoneIds.includes(selfId)) return t('adjacentError.selfReference');
  return null;
}

/**
 * Parse an HH:MM sim-day clock to seconds (28800 for "08:00"); null when the
 * text is not a valid day clock. The display inverse is simDayClock below.
 */
export function dayClockToSimSec(text: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23) return null;
  return hours * 3600 + minutes * 60;
}

/** Occupant timetable: enabled rows need count >= 0 integer + start < end. */
export function scheduleFormError(
  fields: Pick<
    ZoneFormFields,
    'scheduleEnabled' | 'scheduleCount' | 'scheduleStart' | 'scheduleEnd'
  >,
): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  if (!fields.scheduleEnabled) return null;
  const countRaw = fields.scheduleCount.trim();
  if (countRaw.length === 0 || !Number.isInteger(Number(countRaw)) || Number(countRaw) < 0) {
    return t('scheduleError.count');
  }
  const start = dayClockToSimSec(fields.scheduleStart);
  const end = dayClockToSimSec(fields.scheduleEnd);
  if (start === null || end === null) return t('scheduleError.clock');
  if (start >= end) return t('scheduleError.ordering');
  return null;
}

/** Room rows: fully-blank rows are dropped; a coded row needs a name. */
export function roomRowsError(rows: readonly RoomRow[]): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  for (const row of rows) {
    if (row.name.trim().length === 0 && row.code.trim().length > 0) {
      return t('roomError.nameMissing');
    }
  }
  return null;
}

/** Serialize room rows; fully-blank rows dropped, undefined when empty. */
export function rowsToRooms(rows: readonly RoomRow[]): EnvRoom[] | undefined {
  const rooms: EnvRoom[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length === 0) continue;
    const code = row.code.trim();
    rooms.push(code.length > 0 ? { name, code } : { name });
  }
  return rooms.length > 0 ? rooms : undefined;
}

/** Inverse of rowsToRooms: prefill the room editor from a stored zone. */
export function roomsToRows(rooms: readonly EnvRoom[] | undefined): RoomRow[] {
  return (rooms ?? []).map(room => ({ name: room.name, code: room.code ?? '' }));
}

export interface ZoneFormCtx {
  isGeo: boolean;
  existingZoneIds: ReadonlySet<string>;
  /**
   * UX-W2 edit mode: the zone being edited keeps its own id — the duplicate
   * check excludes it (the id input is disabled in the UI, but a stale set
   * would otherwise flag the unchanged id as a duplicate).
   */
  editingZoneId?: string;
}

/** Inline validation; null when the form may save. */
export function zoneFormError(fields: ZoneFormFields, ctx: ZoneFormCtx): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const otherZoneIds =
    ctx.editingZoneId === undefined
      ? ctx.existingZoneIds
      : new Set([...ctx.existingZoneIds].filter(id => id !== ctx.editingZoneId));
  const idError = zoneIdError(fields.id, otherZoneIds);
  if (idError !== null) return idError;
  if (fields.name.trim().length === 0) return t('nameRequired');
  if (!ctx.isGeo) {
    const error = boundsError(fields);
    if (error !== null) return error;
    const zError = zBoundsError(fields);
    if (zError !== null) return zError;
  }
  const baseError = baselineError(fields.baselineRows);
  if (baseError !== null) return baseError;
  const floorErr = floorError(fields.floor);
  if (floorErr !== null) return floorErr;
  const envelopeErr = envelopeUError(fields.envelopeU);
  if (envelopeErr !== null) return envelopeErr;
  const adjacentErr = adjacentZoneIdsError(fields.adjacentZoneIds, fields.id);
  if (adjacentErr !== null) return adjacentErr;
  const scheduleErr = scheduleFormError(fields);
  if (scheduleErr !== null) return scheduleErr;
  return roomRowsError(fields.roomRows);
}

/**
 * The UX-W2 optional zone attributes shared by both builders — blank inputs
 * drop the key entirely so an untouched form produces the pre-W2 zone shape.
 */
function zoneExtras(fields: ZoneFormFields): Partial<EnvZone> {
  const buildingId = fields.buildingId.trim();
  const floor = fields.floor.trim();
  const envelopeU = fields.envelopeU.trim();
  const rooms = rowsToRooms(fields.roomRows);
  const schedule =
    fields.scheduleEnabled
      ? {
          count: Number(fields.scheduleCount.trim()),
          startSimTimeSec: dayClockToSimSec(fields.scheduleStart) ?? 0,
          endSimTimeSec: dayClockToSimSec(fields.scheduleEnd) ?? 0,
          repeatDaily: fields.scheduleRepeatDaily,
        }
      : undefined;
  return {
    ...(buildingId.length > 0 ? { buildingId } : {}),
    ...(floor.length > 0 ? { floor: Number(floor) } : {}),
    ...(fields.consentClass !== '' ? { consentClass: fields.consentClass } : {}),
    ...(fields.adjacentZoneIds.length > 0
      ? { adjacentZoneIds: [...fields.adjacentZoneIds] }
      : {}),
    ...(envelopeU.length > 0 ? { envelopeU: Number(envelopeU) } : {}),
    ...(rooms !== undefined ? { rooms } : {}),
    ...(schedule !== undefined ? { occupantSchedule: schedule } : {}),
  };
}

/** Assemble a grid zone from the form (assumes validation passed). */
export function buildGridZone(fields: ZoneFormFields): EnvZone {
  const type = fields.type.trim();
  const baseline = rowsToBaseline(fields.baselineRows);
  const bounds: ZoneBounds = {
    minX: Number(fields.minX),
    maxX: Number(fields.maxX),
    minY: Number(fields.minY),
    maxY: Number(fields.maxY),
    ...(fields.minZ.trim().length > 0 && fields.maxZ.trim().length > 0
      ? { minZ: Number(fields.minZ), maxZ: Number(fields.maxZ) }
      : {}),
  };
  return {
    id: fields.id,
    name: fields.name.trim(),
    ...(type.length > 0 ? { type } : {}),
    bounds,
    ...(baseline !== undefined ? { baseline } : {}),
    ...zoneExtras(fields),
  };
}

/** Assemble a geo zone from the form + drawn polygon. */
export function buildGeoZone(
  fields: ZoneFormFields,
  polygon: readonly [number, number][],
): EnvZone {
  const type = fields.type.trim();
  const baseline = rowsToBaseline(fields.baselineRows);
  return {
    id: fields.id,
    name: fields.name.trim(),
    ...(type.length > 0 ? { type } : {}),
    polygon: polygon.map(([lat, lng]) => [lat, lng] as [number, number]),
    ...(baseline !== undefined ? { baseline } : {}),
    ...zoneExtras(fields),
  };
}

/**
 * UX-W2 edit mode: prefill the form from a stored zone (inverse of the
 * builders). Grid bounds/height ride the same inputs; the geo polygon is NOT
 * a form field (vertex editing lives on the map).
 */
export function zoneToFormFields(zone: EnvZone): ZoneFormFields {  const schedule = zone.occupantSchedule;
  return {
    ...createZoneFormFields(),
    id: zone.id,
    name: zone.name ?? '',
    type: zone.type ?? '',
    minX: zone.bounds !== undefined ? String(zone.bounds.minX) : '',
    maxX: zone.bounds !== undefined ? String(zone.bounds.maxX) : '',
    minY: zone.bounds !== undefined ? String(zone.bounds.minY) : '',
    maxY: zone.bounds !== undefined ? String(zone.bounds.maxY) : '',
    minZ: zone.bounds?.minZ !== undefined ? String(zone.bounds.minZ) : '',
    maxZ: zone.bounds?.maxZ !== undefined ? String(zone.bounds.maxZ) : '',
    baselineRows: baselineToRows(zone.baseline),
    buildingId: zone.buildingId ?? '',
    floor: zone.floor !== undefined ? String(zone.floor) : '',
    consentClass: zone.consentClass ?? '',
    adjacentZoneIds: [...(zone.adjacentZoneIds ?? [])].filter(id => id !== zone.id),
    envelopeU: zone.envelopeU !== undefined ? String(zone.envelopeU) : '',
    roomRows: roomsToRows(zone.rooms),
    scheduleEnabled: schedule !== undefined,
    scheduleCount: schedule !== undefined ? String(schedule.count) : '',
    scheduleStart: schedule !== undefined ? simDayClock(schedule.startSimTimeSec) : '',
    scheduleEnd: schedule !== undefined ? simDayClock(schedule.endSimTimeSec) : '',
    scheduleRepeatDaily: schedule?.repeatDaily !== false,
  };
}

/**
 * Keys the zone form manages — everything buildGridZone/buildGeoZone may
 * emit. Edit mode rebuilds a zone from the form, so keys NOT in this list
 * (runtime-owned `occupancy`, the FEAT-07 phase-2 `occupantScheduleOverlay`,
 * future passthrough metadata) must survive an edit verbatim.
 */
const FORM_MANAGED_KEYS: readonly string[] = [
  'id',
  'name',
  'type',
  'bounds',
  'polygon',
  'baseline',
  'buildingId',
  'floor',
  'consentClass',
  'adjacentZoneIds',
  'envelopeU',
  'rooms',
  'occupantSchedule',
];

/**
 * Edit-mode merge: the form-rebuilt zone replaces exactly the form-managed
 * keys of the stored zone; every other stored key rides along (an emptied
 * form field DROPS its key instead of persisting an empty value).
 */
export function mergeZoneEdits(original: EnvZone, built: EnvZone): EnvZone {
  const merged: Record<string, unknown> = { ...original };
  for (const key of FORM_MANAGED_KEYS) delete merged[key];
  return { ...merged, ...built } as EnvZone;
}

// ---------------------------------------------------------------------------
// Geo polygon builder (map drawing)
// ---------------------------------------------------------------------------

/** Vertices closer than this (degrees, ~20 cm) merge — dblclick fires clicks. */
const VERTEX_EPSILON = 2e-6;

function nearSamePoint(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < VERTEX_EPSILON && Math.abs(a[1] - b[1]) < VERTEX_EPSILON;
}

/** Append a vertex; consecutive (near-)duplicates are dropped. */
export function appendPolygonVertex(
  vertices: readonly [number, number][],
  point: [number, number],
): [number, number][] {
  const last = vertices[vertices.length - 1];
  if (last !== undefined && nearSamePoint(last, point)) return [...vertices];
  return [...vertices, point];
}

/** The drawn ring may be finished once it has at least 3 vertices. */
export function canFinishPolygon(vertices: readonly [number, number][]): boolean {
  return vertices.length >= 3;
}

/**
 * Close the ring: a trailing repeat of the first vertex is dropped (the
 * server does the same), and fewer than 3 vertices yields null (not a zone).
 */
export function finishPolygon(
  vertices: readonly [number, number][],
): [number, number][] | null {
  let ring = [...vertices];
  if (ring.length > 1 && nearSamePoint(ring[0], ring[ring.length - 1])) {
    ring = ring.slice(0, -1);
  }
  return ring.length >= 3 ? ring : null;
}

// ---------------------------------------------------------------------------
// mapData assembly (PATCH /api/environments/:id)
// ---------------------------------------------------------------------------

/**
 * The mapData keys that must survive a zones-only edit. The server replaces
 * map_data wholesale, so omitting a key here would silently drop it from the
 * world — the preserved set is EVERY mapData key the detail view surfaces:
 * geo center/zoom, scheduled events, demo metadata (T-032), derived-service
 * demo visibility (T-053), floor plans (B-D), governance, and the building
 * physics meta (MAP_META_FIELDS). The four latter physics fields are on the
 * wire but not yet in the generated contract schema, so they are read
 * defensively.
 */
function preservedMapDataKeys(detail: EnvironmentDetail): Omit<MapDataPatch, 'zones'> {
  const isGeo = detail.mapType === 'geo';
  const physics = detail as EnvironmentDetail & Partial<Record<
    'slabAttenuation' | 'envelopeU' | 'occupancyHeatW' | 'occupancyCo2Rate', number
  >>;
  const physicsPatch: Partial<MapDataPatch> = {};
  if (typeof detail.storeyHeight === 'number') physicsPatch.storeyHeight = detail.storeyHeight;
  if (typeof physics.slabAttenuation === 'number') physicsPatch.slabAttenuation = physics.slabAttenuation;
  if (typeof physics.envelopeU === 'number') physicsPatch.envelopeU = physics.envelopeU;
  if (typeof physics.occupancyHeatW === 'number') physicsPatch.occupancyHeatW = physics.occupancyHeatW;
  if (typeof physics.occupancyCo2Rate === 'number') physicsPatch.occupancyCo2Rate = physics.occupancyCo2Rate;
  return {
    ...(isGeo && detail.mapCenter !== null ? { center: detail.mapCenter } : {}),
    ...(isGeo && detail.mapZoom !== null ? { zoom: detail.mapZoom } : {}),
    ...(detail.events.length > 0 ? { events: detail.events as unknown[] } : {}),
    ...(detail.demo !== null && detail.demo !== undefined ? { demo: detail.demo } : {}),
    ...(detail.derivedServiceVisibility !== undefined
      ? { derivedServiceVisibility: detail.derivedServiceVisibility }
      : {}),
    ...(detail.floorPlans !== null && detail.floorPlans !== undefined && detail.floorPlans.length > 0
      ? { floorPlans: detail.floorPlans as unknown[] }
      : {}),
    ...(detail.governance !== null && detail.governance !== undefined
      ? { governance: detail.governance as unknown as Record<string, unknown> }
      : {}),
    ...physicsPatch,
  };
}

/** Full mapData body with `zone` appended (existing keys preserved). */
export function mapDataWithZone(detail: EnvironmentDetail, zone: EnvZone): MapDataPatch {
  return { ...preservedMapDataKeys(detail), zones: [...detail.zones, zone] };
}

/** Full mapData body with a batch of zones appended (UX-W2 building generator). */
export function mapDataWithZones(detail: EnvironmentDetail, zones: readonly EnvZone[]): MapDataPatch {
  return { ...preservedMapDataKeys(detail), zones: [...detail.zones, ...zones] };
}

/** Full mapData body with the zone removed (existing keys preserved). */
export function mapDataWithoutZone(detail: EnvironmentDetail, zoneId: string): MapDataPatch {
  return {
    ...preservedMapDataKeys(detail),
    zones: detail.zones.filter(zone => zone.id !== zoneId),
  };
}

/**
 * Single-zone replacement (UX-10 baseline editing from the zone detail).
 * The mapData PATCH merges key-by-key server-side (R5-F01), so only the
 * zones list is sent — untouched keys (events, demo, physics meta…) survive
 * without being re-assembled here.
 */
export function mapDataWithUpdatedZone(
  detail: EnvironmentDetail,
  zone: EnvZone,
): Pick<MapDataPatch, 'zones'> {
  return { zones: detail.zones.map(existing => (existing.id === zone.id ? zone : existing)) };
}

/** Scheduled-event list replacement (UX-10 事件剧本) — same key-merge lane. */
export function mapDataWithEvents(events: readonly ScenarioEvent[]): Pick<MapDataPatch, 'events'> {
  return { events: [...events] };
}

/**
 * FEAT-07: HH:MM clock for a sim-day second — the zone detail's
 * occupantSchedule display (28800 → "08:00").
 */
export function simDayClock(simDaySec: number): string {
  const h = Math.floor(simDaySec / 3600);
  const m = Math.floor((simDaySec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * FEAT-07 phase-2: absolute sim seconds as `D<day> HH:MM` — the zone
 * detail's occupantScheduleOverlay window display (86400 → "D1 00:00").
 */
export function simAbsDayClock(simSec: number): string {
  const day = Math.floor(simSec / 86400);
  return `D${day} ${simDayClock(simSec % 86400)}`;
}

/**
 * FEAT-07 phase-2: the calendar overlay's status against the world clock —
 * 'active' inside [startsAtSimSec, endsAtSimSec), 'pending' before,
 * 'expired' at/after the end. Undefined clock (no live session read) →
 * undefined (the row renders the window without a status claim).
 */
export function occupantOverlayStatus(
  overlay: { startsAtSimSec: number; endsAtSimSec: number },
  simTimeSec: number | undefined,
): 'active' | 'pending' | 'expired' | undefined {
  if (simTimeSec === undefined) return undefined;
  if (simTimeSec < overlay.startsAtSimSec) return 'pending';
  if (simTimeSec < overlay.endsAtSimSec) return 'active';
  return 'expired';
}

/**
 * Why a zone may not be deleted yet (null = deletable): devices pointing at
 * it would keep a dead zoneId, and the server rejects mapData whose events
 * reference a missing zone.
 */
export function zoneDeleteBlocker(detail: EnvironmentDetail, zoneId: string): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  const deviceCount = detail.devices.filter(device => device.zoneId === zoneId).length;
  if (deviceCount > 0) {
    return t('deleteBlocker.devices', { count: deviceCount });
  }
  const eventCount = detail.events.filter(event => event.zoneId === zoneId).length;
  if (eventCount > 0) {
    return t('deleteBlocker.events', { count: eventCount });
  }
  return null;
}
