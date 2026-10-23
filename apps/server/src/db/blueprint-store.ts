/**
 * Blueprint Store (Fix-38) — CRUD + install for App Blueprints.
 *
 * A blueprint is a packed application template: devices + agents + flows
 * with template variables (${zoneId}, ${deviceId:0}) resolved at install
 * time. Built-in blueprints are seeded idempotently on boot; custom ones
 * are user-created. Installation creates all objects atomically (or fails
 * with a clear error listing what was attempted).
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@active-collaboration/shared';

import type { EafDatabase } from './database.js';

const logger = createLogger('BlueprintStore');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlueprintDeviceDef {
  name: string;
  type: string;
  capabilities: string[];
  zoneId: string; // template variable or literal
  initialState?: Record<string, unknown>;
}

export interface BlueprintAgentDef {
  name: string;
  capabilities: string[];
  managesZoneIds: string[];
  boundDeviceIndexes: number[]; // indexes into devices array
}

export interface BlueprintFlowDef {
  name: string;
  enabled: boolean;
  trigger: Record<string, unknown>;
  plan: { goal: string; nodes: Array<Record<string, unknown>> };
}

/**
 * R6-D-S3 (gamification-design.md §3): collaboration-pair metadata — "this
 * card pairs with blueprint X". Pure display/hint data: the install path
 * never reads it, and the definition format (devices/agents/flows +
 * `${zoneId}`) is unchanged.
 */
export interface BlueprintPartnerSuggestion {
  blueprintId: string;
  note?: string;
}

export interface BlueprintDefinition {
  devices: BlueprintDeviceDef[];
  agents: BlueprintAgentDef[];
  flows?: BlueprintFlowDef[];
  partnerSuggestion?: BlueprintPartnerSuggestion;
}

export interface BlueprintRow {
  id: string;
  name: string;
  description: string;
  definition_json: string;
  is_builtin: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Built-in blueprints (seeded on boot, idempotent by id)
// ---------------------------------------------------------------------------

const BUILTIN_BLUEPRINTS: Array<{
  id: string; name: string; description: string; definition: BlueprintDefinition;
}> = [
  {
    id: 'classroom-energy-saver',
    name: '教室节能管家',
    description: '温度传感器 + 空调 + 节能 Agent + 高温自动降温 Flow。装进你的教室，温度超 30°C 自动开空调。',
    definition: {
      devices: [
        { name: '教室温感', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: '${zoneId}' },
        { name: '教室空调', type: 'hvac', capabilities: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'], zoneId: '${zoneId}',
          initialState: { ratedPowerW: 3000, rampRateWPerSec: 500 } },
      ],
      agents: [
        { name: '节能管家', capabilities: ['temperature-monitoring', 'temperature-control'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
      ],
      flows: [
        { name: '高温自动降温', enabled: true,
          trigger: { kind: 'condition', zoneId: '${zoneId}', conditions: [{ path: 'temperature', op: '>', value: 30 }], cooldownSimSec: 300 },
          plan: { goal: '把教室温度降到 26 度', nodes: [{ id: 'n1', capability: 'cooling', params: { targetTemperature: 26 } }] } },
      ],
    },
  },
  {
    id: 'dorm-guardian',
    name: '宿舍守护',
    description: '温度+湿度传感器 + 空调 + 守护 Agent。高温/高湿自动响应，守护宿舍舒适。',
    definition: {
      devices: [
        { name: '宿舍温感', type: 'temperature-sensor', capabilities: ['temperature-reading'], zoneId: '${zoneId}' },
        { name: '宿舍空调', type: 'hvac', capabilities: ['temperature-control', 'cooling', 'heating', 'turn-on', 'turn-off'], zoneId: '${zoneId}',
          initialState: { ratedPowerW: 2000 } },
      ],
      agents: [
        { name: '宿舍守护者', capabilities: ['temperature-monitoring', 'temperature-control'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
      ],
    },
  },
  {
    id: 'corridor-smart-lighting',
    name: '走廊智能照明',
    description: '人体感应 + 智能灯 + Flow：检测到有人自动开灯，无人 5 分钟后自动关。',
    definition: {
      devices: [
        { name: '走廊人体感应', type: 'motion-sensor', capabilities: ['motion-detection'], zoneId: '${zoneId}' },
        { name: '走廊智能灯', type: 'light', capabilities: ['lighting-control', 'brightness-control', 'turn-on', 'turn-off', 'set-brightness'], zoneId: '${zoneId}',
          initialState: { brightness: 80 } },
      ],
      agents: [
        { name: '照明管家', capabilities: ['lighting-control'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
      ],
    },
  },
  // -------------------------------------------------------------------------
  // 深圳韧性场景专属（R13 遗留，R15-F 补齐）：设备类型对齐
  // shenzhen-resilience 的词表（flood-detector / smart-valve / smoke-sensor /
  // air-quality-sensor / light），Flow 节点只用经过验证可执行的
  // capability（turn-on/cooling——与教室蓝图同一词汇）。
  // -------------------------------------------------------------------------
  {
    id: 'sz-flood-drainage',
    name: '易涝点排水哨兵',
    description: '内涝水位计 + 智能排水阀 + 水务值守 Agent + Flow：暴雨湿度超 90% 自动开阀排水。为深圳多雨季节的 CBD / 老城区易涝区而设。',
    definition: {
      devices: [
        { name: '内涝水位计', type: 'flood-detector', capabilities: ['flood-level-detection', 'water-level-reading', 'flood-monitoring'], zoneId: '${zoneId}' },
        { name: '智能排水阀', type: 'smart-valve', capabilities: ['drainage-control', 'turn-on', 'turn-off'], zoneId: '${zoneId}',
          initialState: { ratedPowerW: 1500 } },
      ],
      agents: [
        { name: '水务值守', capabilities: ['flood-monitoring', 'drainage-control'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
      ],
      flows: [
        { name: '暴雨自动排水', enabled: true,
          trigger: { kind: 'condition', zoneId: '${zoneId}', conditions: [{ path: 'humidity', op: '>', value: 90 }], cooldownSimSec: 600 },
          plan: { goal: '开启排水阀降低内涝风险', nodes: [{ id: 'n1', capability: 'turn-on', params: {} }] } },
      ],
    },
  },
  {
    id: 'sz-cbd-air-guard',
    name: 'CBD 空气净化哨兵',
    description: '空气质量传感器 + 空气净化器 + 生态值守 Agent + Flow：CO₂ 超 1000ppm 自动启动净化。适合 CBD 写字楼密集人流区。',
    definition: {
      devices: [
        { name: '空气质量监测', type: 'air-quality-sensor', capabilities: ['air-quality-reading', 'co2-reading', 'pm25-reading'], zoneId: '${zoneId}' },
        { name: '空气净化器', type: 'air-purifier', capabilities: ['air-purification', 'turn-on', 'turn-off'], zoneId: '${zoneId}',
          initialState: { ratedPowerW: 800 } },
      ],
      agents: [
        { name: '生态值守', capabilities: ['air-quality-monitoring', 'air-purification'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
      ],
      flows: [
        { name: 'CO2 超标自动净化', enabled: true,
          trigger: { kind: 'condition', zoneId: '${zoneId}', conditions: [{ path: 'co2', op: '>', value: 1000 }], cooldownSimSec: 300 },
          plan: { goal: '启动净化器把 CO₂ 降回 800ppm 以下', nodes: [{ id: 'n1', capability: 'turn-on', params: {} }] } },
      ],
    },
  },
  {
    id: 'sz-emergency-lighting',
    name: '应急照明套件',
    description: '烟感 + 应急照明灯 + 安防值守 Agent + Flow：检测到烟雾立即点亮应急照明，为历史街区 / 港区夜间疏散预留。',
    definition: {
      devices: [
        // R1 (B1-8): the agent declares fire-monitoring — the sensing device
        // must BACK it (the capability-backing gate now applies to blueprint
        // installs too); a smoke detector detecting smoke IS fire monitoring.
        { name: '烟感探测', type: 'smoke-sensor', capabilities: ['smoke-detection', 'fire-monitoring'], zoneId: '${zoneId}' },
        { name: '应急照明灯', type: 'light', capabilities: ['lighting-control', 'turn-on', 'turn-off', 'set-brightness'], zoneId: '${zoneId}',
          initialState: { brightness: 100 } },
      ],
      agents: [
        { name: '安防值守', capabilities: ['fire-monitoring', 'lighting-control'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0, 1] },
      ],
      flows: [
        { name: '烟雾应急点亮', enabled: true,
          trigger: { kind: 'condition', zoneId: '${zoneId}', conditions: [{ path: 'smoke', op: '>', value: 0.5 }], cooldownSimSec: 120 },
          plan: { goal: '烟雾告警时全亮应急照明', nodes: [{ id: 'n1', capability: 'turn-on', params: {} }] } },
      ],
    },
  },
  // -------------------------------------------------------------------------
  // 协作对卡（R6-D-S3，gamification-design.md §3）：一对互补的卡让 L4
  // 「世界活了」（第一次跨 Agent 协作）在默认路径可达。生产者卡暴露
  // CO₂ 监测服务（派生自传感设备），消费者卡的新风管家只有新风执行能力、
  // 没有监测能力——能力缺口迫使它向监测员发起协作。两卡的
  // partnerSuggestion 互相指向。参照 R5/demo 验证过的真实成功组合
  // （环境监测员 + 新风管家）。两卡都不带 Flow：协作由仿真事件驱动，
  // 不是自闭环。
  // -------------------------------------------------------------------------
  {
    id: 'co2-monitor',
    name: 'CO2 监测员',
    description: 'CO₂ 传感器 + 环境监测 Agent：持续监测空气质量并把 CO₂ 读数暴露为服务。装上「新风管家」配对卡，即构成一对可协作的最小组合。',
    definition: {
      devices: [
        { name: 'CO2 传感器', type: 'air-quality-sensor', capabilities: ['air-quality-reading', 'co2-reading'], zoneId: '${zoneId}' },
      ],
      agents: [
        { name: '环境监测员', capabilities: ['air-quality-monitoring', 'co2-reading'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0] },
      ],
      partnerSuggestion: {
        blueprintId: 'fresh-air-manager',
        note: '与「新风管家」装在同一区域：监测员提供 CO₂ 读数服务，新风管家消费它来决定通风——装齐一对即满足第一次跨 Agent 协作的前置。',
      },
    },
  },
  {
    id: 'fresh-air-manager',
    name: '新风管家',
    description: '新风设备 + 新风调度 Agent：具备通风执行能力，但自己不做监测——需要消费「CO2 监测员」的读数服务来决定何时换气。',
    definition: {
      devices: [
        { name: '新风机', type: 'fresh-air-system', capabilities: ['ventilation-control', 'air-exchange', 'turn-on', 'turn-off'], zoneId: '${zoneId}',
          initialState: { ratedPowerW: 1200 } },
      ],
      agents: [
        { name: '新风管家', capabilities: ['ventilation-control'],
          managesZoneIds: ['${zoneId}'], boundDeviceIndexes: [0] },
      ],
      partnerSuggestion: {
        blueprintId: 'co2-monitor',
        note: '与「CO2 监测员」装在同一区域：新风管家缺少监测能力，会向监测员请求 CO₂ 读数服务——这是第一次真实协作握手的最短路径。',
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class BlueprintStore {
  constructor(private readonly db: EafDatabase) {}

  /** Seed built-in blueprints (idempotent: skip if id already exists). */
  seedBuiltins(): number {
    let added = 0;
    for (const bp of BUILTIN_BLUEPRINTS) {
      const existing = this.getById(bp.id);
      if (existing) continue;
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO blueprints (id, name, description, definition_json, is_builtin, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, NULL, ?, ?)
      `).run(bp.id, bp.name, bp.description, JSON.stringify(bp.definition), now, now);
      added += 1;
    }
    if (added > 0) logger.info(`Seeded ${added} built-in blueprint(s)`);
    return added;
  }

  list(includeCustom: boolean = true): BlueprintRow[] {
    const sql = includeCustom
      ? 'SELECT * FROM blueprints ORDER BY is_builtin DESC, name'
      : 'SELECT * FROM blueprints WHERE is_builtin = 1 ORDER BY name';
    return this.db.prepare(sql).all() as BlueprintRow[];
  }

  getById(id: string): BlueprintRow | undefined {
    return this.db.prepare('SELECT * FROM blueprints WHERE id = ?').get(id) as BlueprintRow | undefined;
  }

  create(input: {
    name: string;
    description?: string;
    definition: BlueprintDefinition;
    createdBy?: string;
  }): BlueprintRow {
    const id = `bp-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO blueprints (id, name, description, definition_json, is_builtin, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).run(id, input.name, input.description ?? '', JSON.stringify(input.definition), input.createdBy ?? null, now, now);
    return this.getById(id)!;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM blueprints WHERE id = ? AND is_builtin = 0').run(id);
    return result.changes > 0;
  }
}
