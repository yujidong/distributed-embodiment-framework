/**
 * Device-model catalog store — the real-hardware catalog (§11.3)
 *
 * `device_models` holds purchasable, real-world device models (vendor/model,
 * semantic device type, capabilities, simulation physics, free-form specs).
 * Seed rows (`source='seed'`, `status='active'`) ship with the server;
 * community submissions land as `status='pending'` awaiting a future
 * approval flow — only 'active' models are listed and instantiable.
 */

import { randomUUID } from 'node:crypto';

import { isCapabilityExecutable } from '@active-collaboration/simulation';

import type { EafDatabase } from './database.js';
import { parseJsonArray, parseJsonObject } from './environment-store.js';

export type CatalogSource = 'seed' | 'community';
export type CatalogStatus = 'active' | 'pending' | 'rejected';
/** Deployment tier: smart-home ('consumer') vs smart-city gear. */
export type CatalogTier = 'consumer' | 'industrial' | 'municipal';

export interface DeviceModelRow {
  id: string;
  vendor: string;
  model: string;
  name: string;
  device_type: string;
  capabilities_json: string;
  physics_json: string;
  specs_json: string;
  purchase_url: string | null;
  price_cny: number | null;
  source: CatalogSource;
  status: CatalogStatus;
  tier: CatalogTier;
  created_by: string | null;
  created_at: string;
}

export interface CatalogListFilters {
  deviceType?: string;
  vendor?: string;
  tier?: CatalogTier;
  /** Case-insensitive substring matched against name and model. */
  q?: string;
}

export interface CreateDeviceModelInput {
  id?: string;
  vendor: string;
  model: string;
  name: string;
  deviceType: string;
  capabilities: string[];
  physics?: Record<string, unknown>;
  specs?: Record<string, unknown>;
  purchaseUrl?: string | null;
  priceCny?: number | null;
  source: CatalogSource;
  status: CatalogStatus;
  /** Defaults to 'consumer' (schema v3 default). */
  tier?: CatalogTier;
  createdBy?: string | null;
}

export class CatalogStore {
  constructor(private readonly db: EafDatabase) {}

  /** Insert a model. With `ignoreExisting: true` a duplicate id is a no-op. */
  create(input: CreateDeviceModelInput, options: { ignoreExisting?: boolean } = {}): DeviceModelRow {
    const row: DeviceModelRow = {
      id: input.id ?? randomUUID(),
      vendor: input.vendor,
      model: input.model,
      name: input.name,
      device_type: input.deviceType,
      capabilities_json: JSON.stringify(input.capabilities),
      physics_json: JSON.stringify(input.physics ?? {}),
      specs_json: JSON.stringify(input.specs ?? {}),
      purchase_url: input.purchaseUrl ?? null,
      price_cny: input.priceCny ?? null,
      source: input.source,
      status: input.status,
      tier: input.tier ?? 'consumer',
      created_by: input.createdBy ?? null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT ${options.ignoreExisting ? 'OR IGNORE' : ''} INTO device_models
         (id, vendor, model, name, device_type, capabilities_json, physics_json,
          specs_json, purchase_url, price_cny, source, status, tier, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.vendor, row.model, row.name, row.device_type, row.capabilities_json,
        row.physics_json, row.specs_json, row.purchase_url, row.price_cny,
        row.source, row.status, row.tier, row.created_by, row.created_at,
      );
    return row;
  }

  get(id: string): DeviceModelRow | undefined {
    return this.db.prepare('SELECT * FROM device_models WHERE id = ?').get(id) as
      | DeviceModelRow
      | undefined;
  }

  /** List 'active' models, optionally filtered. Ordered by vendor, model. */
  listActive(filters: CatalogListFilters = {}): DeviceModelRow[] {
    let sql = `SELECT * FROM device_models WHERE status = 'active'`;
    const params: string[] = [];
    if (filters.deviceType !== undefined) {
      sql += ' AND device_type = ?';
      params.push(filters.deviceType);
    }
    if (filters.vendor !== undefined) {
      sql += ' AND vendor = ?';
      params.push(filters.vendor);
    }
    if (filters.tier !== undefined) {
      sql += ' AND tier = ?';
      params.push(filters.tier);
    }
    if (filters.q !== undefined) {
      // R15-D5: query ALIAS expansion — a zh keyword like「温度」must find
      // 「温湿度计」(no shared substring) and the English capability
      // (temperature-reading). instr() substring match avoids LIKE
      // wildcard-escaping issues; every expanded term is OR-matched across
      // name/model/device_type/capabilities.
      const terms = expandQuery(filters.q);
      const clauses = terms.map(() =>
        '(instr(lower(name), lower(?)) > 0 OR instr(lower(model), lower(?)) > 0 ' +
        'OR instr(lower(device_type), lower(?)) > 0 OR instr(lower(capabilities_json), lower(?)) > 0)');
      sql += ` AND (${clauses.join(' OR ')})`;
      for (const term of terms) params.push(term, term, term, term);
    }
    sql += ' ORDER BY vendor ASC, model ASC';
    return this.db.prepare(sql).all(...params) as DeviceModelRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM device_models').get() as { n: number }).n;
  }
}

/**
 * R15-D5 search aliases: zh sensor/actuator keywords → sibling spellings and
 * the English capability vocabulary. The raw query always stays in the set;
 * aliases only widen it (OR semantics, never narrow).
 */
const QUERY_ALIASES: Record<string, readonly string[]> = {
  '温度': ['温湿', 'temperature', 'thermometer'],
  '湿度': ['温湿', 'humidity', 'hygrometer'],
  '温湿度': ['temperature', 'humidity'],
  '烟雾': ['烟感', 'smoke'],
  '烟感': ['烟雾', 'smoke'],
  '门磁': ['door'],
  '门锁': ['lock'],
  '插座': ['plug', 'socket'],
  '灯': ['light', 'lighting'],
  '照明': ['light', 'lighting', '灯'],
  '空调': ['hvac', 'air-conditioner', 'fan'],
  '风扇': ['fan'],
  '窗帘': ['curtain', 'blind'],
  '相机': ['camera'],
  '传感器': ['sensor', '传感'],
  '能耗': ['energy', 'meter', '电表'],
  '电表': ['energy', 'meter'],
  '空气质量': ['air', 'pm25', 'co2'],
  // R78-D（R77 F2）：客流词族——用户心智词（人流/客流/人群）映射到设备能力
  // 词表（people-counting / occupancy），目录搜索由此从 0 行变为可达。
  '人流': ['people-counting', 'occupancy', '客流', '人群'],
  '客流': ['people-counting', 'occupancy', '人流', '人群'],
  '人群': ['people-counting', 'occupancy', '客流', '人流'],
  'occupancy': ['people-counting', 'occupancy-monitoring'],
  // R80（FW3 需求榜驱动）：安防词族——摄像头的心智词映射。
  '摄像头': ['camera', 'camera-monitoring', '监控'],
  '监控': ['camera', 'camera-monitoring', '摄像头'],
  '安防': ['camera-monitoring', 'security', '摄像头'],
  // R84（R80-3 残余，API 层复测驱动）：实测仍零命中的常见心智词。别名只
  // 放宽不发明——目录里没有的设备类（门磁/地暖专用机等）保持空结果。
  // 水浸/漏水 → 雷达水位计（water-level-monitoring，市政内涝场景词）。
  '水浸': ['水位', 'water-level', '漏水'],
  '漏水': ['水位', 'water-level', '水浸'],
  '内涝': ['水位', 'water-level', '排水'],
  // 新风/换气 → 目录里最接近的可执行体是空气净化器（air-purification）。
  '新风': ['空气净化', 'air-purification', 'ventilation'],
  '换气': ['空气净化', 'air-purification', '新风'],
  // 地暖/暖气/供暖 → 有 heating 能力的空调（catalog 无独立采暖设备）。
  '地暖': ['heating', '空调', '暖气'],
  '暖气': ['heating', '空调', '地暖'],
  '供暖': ['heating', '空调', '暖气'],
  '制冷': ['cooling', '空调', 'hvac'],
  // 除湿 → 加湿器是目录里唯一的湿度执行体。
  '除湿': ['加湿', 'humidity'],
};

/** The query plus every alias whose keyword the query contains/equals. */
function expandQuery(q: string): string[] {
  const trimmed = q.trim();
  const terms = new Set<string>([trimmed]);
  for (const [keyword, aliases] of Object.entries(QUERY_ALIASES)) {
    if (trimmed.includes(keyword)) {
      for (const alias of aliases) terms.add(alias);
    }
  }
  return [...terms];
}

/**
 * R13 (CB-F09): capabilities of a model that nothing can execute (no
 * registered command handler, not read/query). Derived from the same live
 * contract the flow validation uses, so the catalog never contradicts the
 * 422 an authoring attempt would get. Kept as a separate field — the
 * vocabulary itself stays (it drives service derivation and is honest
 * device-description), but consumers can see which parts won't actuate.
 */
function nonExecutableOf(capabilities: string[]): string[] {
  return capabilities.filter(cap => !isCapabilityExecutable(cap));
}

/** Summary wire shape for list responses (no physics/specs payloads). */
export function modelToSummaryJson(row: DeviceModelRow) {
  const capabilities = parseJsonArray<string>(row.capabilities_json);
  return {
    id: row.id,
    vendor: row.vendor,
    model: row.model,
    name: row.name,
    deviceType: row.device_type,
    capabilities,
    nonExecutableCapabilities: nonExecutableOf(capabilities),
    priceCny: row.price_cny,
    source: row.source,
    tier: row.tier,
  };
}

/** Full wire shape for detail responses. */
export function modelToDetailJson(row: DeviceModelRow) {
  return {
    ...modelToSummaryJson(row),
    physics: parseJsonObject(row.physics_json) ?? {},
    specs: parseJsonObject(row.specs_json) ?? {},
    purchaseUrl: row.purchase_url,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
