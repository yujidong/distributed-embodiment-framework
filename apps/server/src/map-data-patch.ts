/**
 * mapData PATCH 的键级合并（R5-F01）与白名单完整性（R5-F04）。
 *
 * PATCH /api/environments/:id 的 mapData 不再是整体替换：补丁未提到的键
 * 保留存量值（教程的 demo 可见性 PATCH 不再抹掉 zones/events/semantic
 * 字段）；出现的键整表/整值替换（zones/events/floorPlans 是读-改-写
 * 列表，单条增删保持可表达——web ZonePanel 的 removeZone 依赖这一
 * 语义）；显式空数组清空该列表。合并发生在校验之前：路由把本模块返回
 * 的合并对象再过一遍 parseMapDataInput 的完整校验（events 对合并后的
 * zone 表校验、geo 规则不变）。
 *
 * 毁世界护栏：会把 zones 从 N>0 清成 0 的补丁需要顶层
 * `confirmClearZones: true`，否则 409 MAP_ZONES_CLEAR_UNCONFIRMED。
 */

import { ApiError } from './errors.js';
import {
  MAP_META_FIELDS,
  parseMapData,
  type EnvironmentRow,
} from './db/environment-store.js';

/**
 * The keys a mapData PATCH understands — whitelist completeness (R5-F04):
 * every key the client sends must be known (silently dropping a typo'd key
 * is how worlds lost their semantic offer rules); unknown keys are a
 * teaching 400 naming the known set. Keep in sync with parseMapDataInput's
 * accepted fields (routes/environments.ts).
 */
const MAP_DATA_PATCH_KEYS: readonly string[] = [
  'zones',
  'events',
  'floorPlans',
  'center',
  'zoom',
  ...MAP_META_FIELDS,
  'demo',
  'derivedServiceVisibility',
  'governance',
  'semanticOfferRules',
  'capabilitySynonyms',
];

/**
 * Merge a client mapData patch over the environment's stored map data and
 * return the MERGED raw object (validation is the caller's job — the route
 * runs it through parseMapDataInput so merged output faces the exact same
 * gauntlet as a full write). Throws:
 * - 400 BAD_REQUEST on a non-object body or unknown keys;
 * - 409 MAP_ZONES_CLEAR_UNCONFIRMED when the merge would wipe the zone
 *   list without top-level `confirmClearZones: true`.
 */
export function mergeMapDataPatch(
  raw: unknown,
  env: EnvironmentRow,
  confirmClearZones: boolean,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData" must be an object');
  }
  const input = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter(key => !MAP_DATA_PATCH_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Unknown mapData field(s) ${unknownKeys.map(key => `"${key}"`).join(', ')} — ` +
        `known fields: ${MAP_DATA_PATCH_KEYS.map(key => `"${key}"`).join(', ')} ` +
        '(a mapData PATCH merges into the stored map data key by key; unknown fields are rejected ' +
        'instead of silently dropped)',
    );
  }
  const existing = parseMapData(env);
  const merged: Record<string, unknown> = { ...existing, ...input };
  if (
    existing.zones.length > 0 &&
    Array.isArray(merged.zones) &&
    (merged.zones as unknown[]).length === 0 &&
    !confirmClearZones
  ) {
    throw new ApiError(
      409,
      'MAP_ZONES_CLEAR_UNCONFIRMED',
      `This PATCH clears all ${existing.zones.length} zone(s) of environment "${env.id}" — ` +
        'every zone reference (devices, scheduled events, proposals) would dangle. ' +
        'Resubmit with top-level "confirmClearZones": true to confirm the wipe.',
      undefined,
      { zoneCount: existing.zones.length, confirmField: 'confirmClearZones' },
    );
  }
  return merged;
}
