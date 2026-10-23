/**
 * Ad-hoc device create/edit form logic (W6-2) — pure functions so the
 * sidebar form component stays thin and the wire shape is unit-testable.
 *
 * The same form state drives creation (POST /api/environments/:id/devices)
 * and editing (PATCH /api/devices/:id):
 *
 * - Position semantics differ by map tier: grid worlds take optional x/y
 *   inputs (both blank = auto-arrange on the canvas); geo worlds take a
 *   map-picked `{lat, lng}` point supplied by the store's device-pick arming
 *   (no point picked = zone-centroid fallback).
 * - On PATCH, cleared brand / initialState / grid position are sent as null
 *   so the server actually clears them; a geo edit without a fresh map pick
 *   OMITS position (keeps the current one).
 * - Capability (and name) changes trigger the server's derived-service
 *   resync — the form shows the note when capabilities differ from the
 *   device's current set.
 */

import type {
  CreateDeviceInput,
  PatchDeviceInput,
  WorldDevice,
} from '../api/types';
import i18n from '../i18n/config';
import type { LatLng } from './geo';

export interface DeviceFormFields {
  name: string;
  type: string;
  brand: string;
  capabilities: string[];
  zoneId: string;
  /** Grid worlds only: optional position inputs (blank = auto-arrange). */
  posX: string;
  posY: string;
  /** Collapsed JSON editor (optional, validated as a plain object). */
  initialStateJson: string;
  initialStateOpen: boolean;
}

export function createDeviceFormFields(zoneId: string): DeviceFormFields {
  return {
    name: '',
    type: '',
    brand: '',
    capabilities: [],
    zoneId,
    posX: '',
    posY: '',
    initialStateJson: '',
    initialStateOpen: false,
  };
}

function readGridCoord(position: Record<string, unknown> | null, key: 'x' | 'y'): string {
  const value = position?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** Prefill the form from an existing device (edit mode). */
export function deviceFormFieldsFromDevice(device: WorldDevice): DeviceFormFields {
  return {
    name: device.name,
    type: device.type,
    brand: device.brand ?? '',
    capabilities: [...device.capabilities],
    zoneId: device.zoneId,
    posX: readGridCoord(device.position, 'x'),
    posY: readGridCoord(device.position, 'y'),
    initialStateJson:
      device.initialState && Object.keys(device.initialState).length > 0
        ? JSON.stringify(device.initialState, null, 2)
        : '',
    initialStateOpen: false,
  };
}

/**
 * Device-type vocabulary for the suggestion chips: union of the catalog's
 * device_types and the types already present in this environment.
 */
export function deviceTypeVocabulary(input: {
  devices: ReadonlyArray<Pick<WorldDevice, 'type'>>;
  catalogDeviceTypes?: readonly string[];
}): string[] {
  const all = new Set<string>();
  for (const device of input.devices) all.add(device.type);
  for (const type of input.catalogDeviceTypes ?? []) all.add(type);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** Parse the initial-state JSON: empty is fine; otherwise a plain object. */
export function parseInitialStateJson(
  json: string,
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (json.trim().length === 0) return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface DeviceFormCtx {
  isGeo: boolean;
  zoneIds: ReadonlySet<string>;
}

/** Grid position inputs: both blank (auto) or both finite numbers. */
function gridPositionError(fields: DeviceFormFields): string | null {
  const x = fields.posX.trim();
  const y = fields.posY.trim();
  if (x.length === 0 && y.length === 0) return null;
  if (x.length === 0 || y.length === 0) return i18n.t('deviceFormLib:posBothOrNeither');
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    return i18n.t('deviceFormLib:posNumeric');
  }
  return null;
}

/** Inline validation; null when the form may submit. */
export function deviceFormError(fields: DeviceFormFields, ctx: DeviceFormCtx): string | null {
  if (fields.name.trim().length === 0) return i18n.t('deviceFormLib:nameRequired');
  if (fields.type.trim().length === 0) return i18n.t('deviceFormLib:typeRequired');
  if (fields.capabilities.length === 0) return i18n.t('deviceFormLib:capabilitiesRequired');
  if (fields.zoneId.length === 0) return i18n.t('deviceFormLib:zoneRequired');
  if (!ctx.zoneIds.has(fields.zoneId)) return i18n.t('deviceFormLib:zoneMissing');
  if (!ctx.isGeo) {
    const positionError = gridPositionError(fields);
    if (positionError !== null) return positionError;
  }
  if (!parseInitialStateJson(fields.initialStateJson).ok) {
    return i18n.t('deviceFormLib:initialStateJson');
  }
  return null;
}

/** True when the edited capabilities differ from the device's current set. */
export function capabilitiesChanged(
  device: Pick<WorldDevice, 'capabilities'>,
  fields: Pick<DeviceFormFields, 'capabilities'>,
): boolean {
  if (device.capabilities.length !== fields.capabilities.length) return true;
  const next = new Set(fields.capabilities);
  return device.capabilities.some(capability => !next.has(capability));
}

interface PositionCtx {
  isGeo: boolean;
  /** Map-picked geo point (null when the user did not pick one). */
  geoPoint: LatLng | null;
}

function gridPosition(fields: DeviceFormFields): Record<string, unknown> | undefined {
  const x = fields.posX.trim();
  const y = fields.posY.trim();
  if (x.length === 0 || y.length === 0) return undefined;
  return { x: Number(x), y: Number(y) };
}

/** POST body for creation (optional fields omitted when empty/unpicked). */
export function buildCreateDevicePayload(
  fields: DeviceFormFields,
  ctx: PositionCtx,
): CreateDeviceInput {
  const brand = fields.brand.trim();
  const initialState = parseInitialStateJson(fields.initialStateJson);
  const position = ctx.isGeo
    ? ctx.geoPoint !== null
      ? ({ lat: ctx.geoPoint.lat, lng: ctx.geoPoint.lng } as Record<string, unknown>)
      : undefined
    : gridPosition(fields);
  return {
    name: fields.name.trim(),
    type: fields.type.trim(),
    capabilities: fields.capabilities,
    zoneId: fields.zoneId,
    ...(brand.length > 0 ? { brand } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(initialState.ok && initialState.value !== undefined
      ? { initialState: initialState.value }
      : {}),
  };
}

/**
 * PATCH body for editing: blank brand / initialState / grid position are
 * sent as null so they are cleared server-side; a geo edit without a fresh
 * map pick omits position entirely (keeps the current one).
 */
export function buildPatchDevicePayload(
  fields: DeviceFormFields,
  ctx: PositionCtx,
): PatchDeviceInput {
  const brand = fields.brand.trim();
  const initialState = parseInitialStateJson(fields.initialStateJson);
  let position: Record<string, unknown> | null | undefined;
  if (ctx.isGeo) {
    position =
      ctx.geoPoint !== null
        ? ({ lat: ctx.geoPoint.lat, lng: ctx.geoPoint.lng } as Record<string, unknown>)
        : undefined;
  } else {
    position = gridPosition(fields) ?? null;
  }
  return {
    name: fields.name.trim(),
    type: fields.type.trim(),
    brand: brand.length > 0 ? brand : null,
    capabilities: fields.capabilities,
    zoneId: fields.zoneId,
    ...(position !== undefined ? { position } : {}),
    initialState: initialState.ok ? (initialState.value ?? null) : null,
  };
}
