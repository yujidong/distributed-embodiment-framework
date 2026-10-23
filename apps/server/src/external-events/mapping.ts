/**
 * External event stream mapping — pure functions (R58).
 *
 * A source's `mapping` turns a fetched payload into world events with
 * small `{field}` templates (v1 deliberately has no JSONPath dependency):
 *
 *   {
 *     "itemsPath": "data.alerts",     // dot path to the item array; omit
 *                                     // when the payload IS the array
 *     "type":       "{alertType}",    // event type (required)
 *     "zoneId":     "yan-hub",        // static or templated (required)
 *     "parameter":  "wind_speed",     // optional physical parameter
 *     "value":      "{wind}",         // number|boolean|string coerced
 *     "severity":   "{level}",        // low|medium|high|critical
 *     "description":"{text}",
 *     "dedupeBy":   "{id}"            // key template; absent → item hash
 *   }
 *
 * Missing templated fields SKIP the item (counted, never fatal) so one
 * malformed upstream record cannot stall a feed.
 */

import { createHash } from 'node:crypto';

export interface EventSourceMapping {
  itemsPath?: string;
  type?: string;
  zoneId?: string;
  parameter?: string;
  value?: string;
  severity?: string;
  description?: string;
  dedupeBy?: string;
  /** Extra capability requirements for the produced events. */
  requiredCapabilities?: string[];
}

export interface MappedEvent {
  dedupeKey: string;
  type: string;
  zoneId: string;
  parameter?: string;
  value?: number | boolean | string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  description?: string;
  requiredCapabilities?: string[];
}

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/** Resolve a dot path ('data.alerts') into the item list. A plain OBJECT at
 * the path wraps into a single item (R60: real APIs like Open-Meteo return
 * one current-conditions object, not an array). */
export function itemsOf(payload: unknown, itemsPath?: string): unknown[] {
  let cursor: unknown = payload;
  if (itemsPath !== undefined && itemsPath.length > 0) {
    for (const segment of itemsPath.split('.').filter(part => part.length > 0)) {
      if (typeof cursor !== 'object' || cursor === null) return [];
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  if (Array.isArray(cursor)) return cursor;
  if (typeof cursor === 'object' && cursor !== null) return [cursor];
  return [];
}

/** Fill a `{field}` or `{nested.field}` template from an item; null when a
 * field is missing. Nested paths (R60: USGS GeoJSON keeps values under
 * `properties`) walk the same dot notation. */
export function fillTemplate(template: string, item: Record<string, unknown>): string | null {
  const filled = template.replace(/\{([\w.]+)\}/g, (_, field: string) => {
    let cursor: unknown = item;
    for (const segment of field.split('.')) {
      if (typeof cursor !== 'object' || cursor === null) { cursor = undefined; break; }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor === undefined || cursor === null ? `\u0000MISSING:${field}` : String(cursor);
  });
  return filled.includes('\u0000MISSING:') ? null : filled;
}

function coerceValue(raw: string): number | boolean | string {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** Map a fetched payload into dedupable world events. Pure; never throws. */
export function mapPayload(
  payload: unknown,
  mapping: EventSourceMapping,
): { events: MappedEvent[]; skipped: number; errors: string[] } {
  const events: MappedEvent[] = [];
  const errors: string[] = [];
  let skipped = 0;
  for (const raw of itemsOf(payload, mapping.itemsPath)) {
    if (typeof raw !== 'object' || raw === null) { skipped += 1; continue; }
    const item = raw as Record<string, unknown>;

    const type = mapping.type !== undefined ? fillTemplate(mapping.type, item) : undefined;
    const zoneId = mapping.zoneId !== undefined ? fillTemplate(mapping.zoneId, item) : undefined;
    if (type === null || type === undefined || type.length === 0 || zoneId === null || zoneId === undefined || zoneId.length === 0) {
      skipped += 1;
      errors.push(`item missing type/zoneId fields (${JSON.stringify(raw).slice(0, 80)})`);
      continue;
    }

    const parameter = mapping.parameter !== undefined ? fillTemplate(mapping.parameter, item) : undefined;
    const valueRaw = mapping.value !== undefined ? fillTemplate(mapping.value, item) : undefined;
    const severityRaw = mapping.severity !== undefined ? fillTemplate(mapping.severity, item) : undefined;
    const description = mapping.description !== undefined ? fillTemplate(mapping.description, item) : undefined;
    const dedupeRaw = mapping.dedupeBy !== undefined ? fillTemplate(mapping.dedupeBy, item) : null;

    events.push({
      dedupeKey: dedupeRaw ?? createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24),
      type,
      zoneId,
      ...(parameter !== null && parameter !== undefined ? { parameter } : {}),
      ...(valueRaw !== null && valueRaw !== undefined ? { value: coerceValue(valueRaw) } : {}),
      ...(severityRaw !== null && severityRaw !== undefined && SEVERITIES.has(severityRaw)
        ? { severity: severityRaw as MappedEvent['severity'] }
        : {}),
      ...(description !== null && description !== undefined ? { description } : {}),
      ...(mapping.requiredCapabilities !== undefined && mapping.requiredCapabilities.length > 0
        ? { requiredCapabilities: [...mapping.requiredCapabilities] }
        : {}),
    });
  }
  return { events, skipped, errors };
}
