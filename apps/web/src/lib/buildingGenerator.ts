/**
 * Building generator (UX-W2) — pure zone-batch assembly behind
 * BuildingGeneratorPanel: 「楼栋 → N 层 × 每层 M zone」.
 *
 * Every generated zone carries the building tier (buildingId + 0-based
 * floor — the platform convention, lib/buildings floorLabeling labels it)
 * plus optional type/baseline/occupantSchedule; adjacency is DECLARED both
 * directions (the field is directed and the server never symmetrizes, R13
 * CB-F06) — same-floor chains link consecutive indices, the cross-floor
 * switch links the same index one storey up/down.
 *
 * Geometry:
 * - grid: floors stack vertically (storeyPitch per band), zones side by
 *   side inside the band — the map renders one storey at a time once floor
 *   metadata exists, so the stacking is a layout convenience, not a
 *   semantic claim;
 * - geo: the rectangular footprint is split into M lng strips and copied
 *   onto every floor (identical outlines across floors — floor is the
 *   discriminator).
 */

import type { EnvZone } from '../api/types';
import i18n from '../i18n/config';
import { slugifyZoneId } from './zoneForm';

export interface BuildingGridLayout {
  originX: number;
  originY: number;
  zoneWidth: number;
  zoneHeight: number;
  gapX: number;
  /** Vertical pitch between storey bands (zone height + inter-floor gap). */
  storeyPitch: number;
}

export interface BuildingGeoFootprint {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface BuildingOccupantTemplate {
  count: number;
  startSimTimeSec: number;
  endSimTimeSec: number;
  repeatDaily?: boolean;
}

export interface BuildingGeneratorConfig {
  buildingId: string;
  floors: number;
  zonesPerFloor: number;
  /** Id pattern with {bldg} {floor} {index} {name} placeholders. */
  namingPattern: string;
  /** Display-name stem ('ward' → ward-1, ward-2…). */
  zoneNamePrefix: string;
  type: string;
  baseline?: Record<string, number | boolean>;
  occupantSchedule?: BuildingOccupantTemplate;
  linkSameFloor: boolean;
  linkAdjacentFloors: boolean;
  grid: BuildingGridLayout;
  /** Geo worlds only; null/undefined on grid worlds. */
  geo?: BuildingGeoFootprint;
}

export const DEFAULT_NAMING_PATTERN = '{bldg}-f{floor}-{name}';

/**
 * R2-UX-24: default geo footprint half-extent (degrees) scaled by the floor
 * count. The legacy fixed ±0.0005° (≈110×95 m) default produced「煎饼」
 * slabs — a 3-storey building (≈10.5 m tall) on a 110 m footprint. Taller
 * buildings keep the full default; the footprint shrinks linearly down to
 * 40% for a single storey.
 */
export function defaultGeoFootprintHalfDeg(floors: number): number {
  const BASE_HALF_DEG = 0.0005;
  const scale = Math.min(1, Math.max(0.4, (Number.isFinite(floors) ? floors : 1) / 6));
  return BASE_HALF_DEG * scale;
}

export const DEFAULT_GRID_LAYOUT: BuildingGridLayout = {
  originX: 0,
  originY: 0,
  zoneWidth: 6,
  zoneHeight: 4,
  gapX: 1,
  storeyPitch: 6,
};

/** The three preset packs (医院 ward / 酒店 guestroom / 办公楼 office). */
export interface BuildingPreset {
  id: 'hospital' | 'hotel' | 'office';
  type: string;
  zoneNamePrefix: string;
  floors: number;
  zonesPerFloor: number;
  baseline: Record<string, number | boolean>;
  occupantSchedule?: BuildingOccupantTemplate;
}

export const BUILDING_PRESETS: readonly BuildingPreset[] = [
  {
    id: 'hospital',
    type: 'ward',
    zoneNamePrefix: 'ward',
    floors: 5,
    zonesPerFloor: 4,
    baseline: { temperature: 24, humidity: 55 },
    occupantSchedule: { count: 6, startSimTimeSec: 8 * 3600, endSimTimeSec: 20 * 3600 },
  },
  {
    id: 'hotel',
    type: 'guestroom',
    zoneNamePrefix: 'room',
    floors: 8,
    zonesPerFloor: 6,
    baseline: { temperature: 25 },
    // 夜间跨午夜的作息在「起 < 止」的日内窗口里不可表达——不设模板。
  },
  {
    id: 'office',
    type: 'office',
    zoneNamePrefix: 'office',
    floors: 6,
    zonesPerFloor: 5,
    baseline: { temperature: 26, co2: 600 },
    occupantSchedule: { count: 8, startSimTimeSec: 9 * 3600, endSimTimeSec: 18 * 3600 },
  },
];

/** Fill the naming pattern's placeholders. */
export function expandNamingPattern(
  pattern: string,
  slot: { bldg: string; floor: number; index: number; name: string },
): string {
  return pattern
    .replaceAll('{bldg}', slot.bldg)
    .replaceAll('{floor}', String(slot.floor))
    .replaceAll('{index}', String(slot.index))
    .replaceAll('{name}', slot.name);
}

/** Generated zone id for one slot (pattern expansion + slug discipline). */
export function generatedZoneId(
  pattern: string,
  slot: { bldg: string; floor: number; index: number; name: string },
): string {
  const expanded = expandNamingPattern(pattern, slot);
  const slug = slugifyZoneId(expanded);
  // R2-FEAT-05: CJK text strips out of the slug (中文 pattern「一号厂房-
  // {name}」→ every floor's「车间-1」collapses onto id「1」→ duplicateInBatch
  // deadlock). The name keeps the原文 (generatedZoneName); the id gets an
  // explicit floor/index discriminator so Chinese patterns still generate.
  if (/[^\x00-\x7f]/.test(expanded)) return `${slug}-f${slot.floor}-${slot.index}`;
  return slug;
}

/**
 * R2-FEAT-05: generated display name for one slot — the naming pattern now
 * applies to names too (previously only ids), with human 1-based
 * {floor}/{index}; a pattern without {floor} gets an explicit「N F」storey
 * prefix so floors stay distinguishable in the zone list.
 */
export function generatedZoneName(
  pattern: string,
  slot: { bldg: string; floor: number; index: number; name: string },
): string {
  const expanded = expandNamingPattern(pattern, {
    bldg: slot.bldg,
    floor: slot.floor + 1,
    index: slot.index + 1,
    name: slot.name,
  });
  return pattern.includes('{floor}') ? expanded : `${slot.floor + 1}F ${expanded}`;
}

/** zone id of (floor, index) — the adjacency pass keys on it. */
function slotId(config: BuildingGeneratorConfig, floor: number, index: number): string {
  return generatedZoneId(config.namingPattern, {
    bldg: config.buildingId,
    floor,
    index,
    name: `${config.zoneNamePrefix}-${index + 1}`,
  });
}

function gridBounds(config: BuildingGeneratorConfig, floor: number, index: number) {
  const { originX, originY, zoneWidth, zoneHeight, gapX, storeyPitch } = config.grid;
  const minX = originX + index * (zoneWidth + gapX);
  const minY = originY + floor * storeyPitch;
  return { minX, maxX: minX + zoneWidth, minY, maxY: minY + zoneHeight };
}

function geoPolygon(config: BuildingGeneratorConfig, index: number): [number, number][] {
  const geo = config.geo!;
  const stripWidth = (geo.maxLng - geo.minLng) / config.zonesPerFloor;
  const lng0 = geo.minLng + index * stripWidth;
  const lng1 = lng0 + stripWidth;
  return [
    [geo.minLat, lng0],
    [geo.maxLat, lng0],
    [geo.maxLat, lng1],
    [geo.minLat, lng1],
  ];
}

/**
 * Assemble the whole batch (assumes buildingGeneratorError passed).
 * Deterministic: same config → same zones.
 */
export function generateBuildingZones(config: BuildingGeneratorConfig): EnvZone[] {
  const isGeo = config.geo !== undefined && config.geo !== null;
  const zones: EnvZone[] = [];
  for (let floor = 0; floor < config.floors; floor += 1) {
    for (let index = 0; index < config.zonesPerFloor; index += 1) {
      const stem = `${config.zoneNamePrefix}-${index + 1}`;
      const name = generatedZoneName(config.namingPattern, {
        bldg: config.buildingId,
        floor,
        index,
        name: stem,
      });
      const adjacentZoneIds = new Set<string>();
      if (config.linkSameFloor) {
        if (index > 0) adjacentZoneIds.add(slotId(config, floor, index - 1));
        if (index < config.zonesPerFloor - 1) adjacentZoneIds.add(slotId(config, floor, index + 1));
      }
      if (config.linkAdjacentFloors) {
        if (floor > 0) adjacentZoneIds.add(slotId(config, floor - 1, index));
        if (floor < config.floors - 1) adjacentZoneIds.add(slotId(config, floor + 1, index));
      }
      const type = config.type.trim();
      zones.push({
        id: slotId(config, floor, index),
        name,
        ...(type.length > 0 ? { type } : {}),
        buildingId: config.buildingId,
        floor,
        ...(isGeo ? { polygon: geoPolygon(config, index) } : { bounds: gridBounds(config, floor, index) }),
        ...(adjacentZoneIds.size > 0 ? { adjacentZoneIds: [...adjacentZoneIds].sort() } : {}),
        ...(config.baseline !== undefined && Object.keys(config.baseline).length > 0
          ? { baseline: { ...config.baseline } }
          : {}),
        ...(config.occupantSchedule !== undefined
          ? {
              occupantSchedule: {
                ...config.occupantSchedule,
                // The wire schema requires the flag (server default = true).
                repeatDaily: config.occupantSchedule.repeatDaily ?? true,
              },
            }
          : {}),
      });
    }
  }
  return zones;
}

/**
 * Batch validation: counts positive integers, building id present, the
 * generated ids unique within the batch and free of the env's existing
 * zones (a collision names the first offender).
 */
export function buildingGeneratorError(
  config: BuildingGeneratorConfig,
  existingZoneIds: ReadonlySet<string>,
): string | null {
  const t = i18n.getFixedT(i18n.language, 'zoneForm');
  if (config.buildingId.trim().length === 0) return t('buildingError.buildingIdRequired');
  if (!Number.isInteger(config.floors) || config.floors < 1) {
    return t('buildingError.floors');
  }
  if (!Number.isInteger(config.zonesPerFloor) || config.zonesPerFloor < 1) {
    return t('buildingError.zonesPerFloor');
  }
  if (config.zoneNamePrefix.trim().length === 0) return t('buildingError.prefixRequired');
  const seen = new Set<string>();
  for (let floor = 0; floor < config.floors; floor += 1) {
    for (let index = 0; index < config.zonesPerFloor; index += 1) {
      const id = slotId(config, floor, index);
      if (seen.has(id)) return t('buildingError.duplicateInBatch', { id });
      seen.add(id);
      if (existingZoneIds.has(id)) return t('buildingError.collidesExisting', { id });
    }
  }
  return null;
}
