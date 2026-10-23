/**
 * Zone visuals — pure helpers behind the world-map semantic layer (V1):
 *
 * - `classifyZone` infers a display category (classroom / dormitory / corridor
 *   / stairwell / library / medical / industrial / commercial / outdoor
 *   / other) from the zone's name + type, so
 *   the map can tint zones by function (corridors/stairwells de-emphasized);
 * - `temperatureHeatColor` maps °C to a translucent blue→red heat fill;
 * - `zoneHeatFill` picks the live fill for a zone rectangle (temperature
 *   scale preferred, comfort-level tint as fallback; null without live data);
 * - `readZoneComfort` defensively extracts the runtime comfort sub-object
 *   (NFR-1 PMV/PPD, see EngineRuntime) from the scalar parameter record;
 * - `comfortBadgeVariant` maps comfortLevel to the badge semantics
 *   (ok / warn / danger) shared with `.badge--*` styles.
 */

export type ZoneCategory =
  | 'classroom'
  | 'dormitory'
  | 'corridor'
  | 'stairwell'
  | 'library'
  | 'medical'
  | 'industrial'
  | 'commercial'
  | 'outdoor'
  | 'other';

/** First match wins; corridors/stairwells precede library so「图书馆走廊」弱化。 */
const CATEGORY_PATTERNS: ReadonlyArray<readonly [ZoneCategory, RegExp]> = [
  ['classroom', /教室|课堂|classroom|lecture|seminar/i],
  ['dormitory', /宿舍|寝室|dorm/i],
  ['corridor', /走廊|过道|corridor|hallway|aisle/i],
  ['stairwell', /楼梯|stair/i],
  ['library', /图书馆|阅览|library|reading/i],
  // R15-D9 + UX-W2: hospital vocabulary widened (ICU / 急诊 / 手术室 / 诊室…).
  ['medical', /医院|诊所|病房|护理|药房|诊室|急诊|手术室|medical|clinic|ward|icu|nursing|pharmacy|consulting/i],
  // UX-W2: industrial family — precedes commercial so「workshop」hits
  // industrial instead of commercial's `shop`.
  ['industrial', /车间|仓库|产线|厂房|workshop|warehouse|assembly|factory|plant/i],
  // UX-W2: commercial gets its own family — the shop/retail/street-store
  // vocabulary moved out of 'outdoor' (R15-D9 stopgap) now that the family
  // exists; 街道/street stays outdoor.
  ['commercial', /商铺|门店|中庭|美食|商场|营业厅|retail|atrium|foodcourt|mall|shop|store|commercial/i],
  ['outdoor', /室外|户外|操场|广场|庭院|街道|outdoor|outside|yard|plaza|street/i],
];

/** Infer the display category from a zone's type and name (bilingual keywords). */
export function classifyZone(zone: { name?: string; type?: string }): ZoneCategory {
  const haystack = `${zone.type ?? ''} ${zone.name ?? ''}`;
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(haystack)) return category;
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Heat fill
// ---------------------------------------------------------------------------

/** °C range spanned by the heat scale (keep the CSS legend gradient in sync). */
export const HEAT_TEMP_MIN = 14;
export const HEAT_TEMP_MAX = 32;
/** Legend mid tick (the scale's midpoint). */
export const HEAT_TEMP_MID = 23;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** °C → translucent heat fill (cold blue → hot red); alpha keeps labels readable. */
export function temperatureHeatColor(tempC: number): string {
  const t = clamp((tempC - HEAT_TEMP_MIN) / (HEAT_TEMP_MAX - HEAT_TEMP_MIN), 0, 1);
  const hue = Math.round(215 - t * 205); // 215 cold blue → 10 hot red
  return `hsla(${hue}, 80%, 55%, 0.32)`;
}

/** Runtime comfort sub-object embedded in zone parameters (NFR-1). */
export interface ZoneComfort {
  pmv: number;
  ppd: number;
  sensation: string;
  comfortLevel: string;
}

/** Defensive read: returns null unless pmv/ppd are real numbers. */
export function readZoneComfort(parameters: Record<string, unknown> | undefined): ZoneComfort | null {
  const raw = parameters?.comfort;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.pmv !== 'number' || !Number.isFinite(record.pmv)) return null;
  if (typeof record.ppd !== 'number' || !Number.isFinite(record.ppd)) return null;
  return {
    pmv: record.pmv,
    ppd: record.ppd,
    sensation: typeof record.sensation === 'string' ? record.sensation : '',
    comfortLevel: typeof record.comfortLevel === 'string' ? record.comfortLevel : '',
  };
}

/** Badge semantics for a comfortLevel string (unknown levels warn, never crash). */
export type ComfortVariant = 'ok' | 'warn' | 'danger';

export function comfortBadgeVariant(comfortLevel: string | undefined): ComfortVariant {
  switch (comfortLevel) {
    case 'comfortable':
      return 'ok';
    case 'uncomfortable':
      return 'danger';
    default:
      return 'warn';
  }
}

/** Translucent tint by comfort level (fallback heat fill when no temperature). */
export function comfortHeatColor(comfortLevel: string | undefined): string {
  switch (comfortBadgeVariant(comfortLevel)) {
    case 'ok':
      return 'hsla(145, 60%, 45%, 0.26)';
    case 'danger':
      return 'hsla(0, 75%, 55%, 0.30)';
    default:
      return 'hsla(45, 90%, 50%, 0.28)';
  }
}

/**
 * Live heat fill for a zone rectangle: temperature scale when a numeric
 * `temperature` parameter exists, comfort tint otherwise; null (keep the
 * neutral category look) without live data.
 */
export function zoneHeatFill(parameters: Record<string, unknown> | undefined): string | null {
  const temperature = parameters?.temperature;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    return temperatureHeatColor(temperature);
  }
  const comfort = readZoneComfort(parameters);
  return comfort ? comfortHeatColor(comfort.comfortLevel) : null;
}

/** Live occupancy count (people) for the in-room chip; null when unavailable. */
export function readOccupancy(parameters: Record<string, unknown> | undefined): number | null {
  const occupancy = parameters?.occupancy;
  return typeof occupancy === 'number' && Number.isFinite(occupancy) ? occupancy : null;
}
