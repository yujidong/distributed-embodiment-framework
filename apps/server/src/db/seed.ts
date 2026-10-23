/**
 * Public template gallery seeding — system user + bundled template environments
 *
 * Every boot ensures the bundled PUBLIC template environments (the gallery a
 * fresh visitor sees) exist at their current revision, owned by a locked-out
 * system account (`system@eaf.local`, random unguessable password — it cannot
 * log in). Seeding is idempotent per template, mirroring the catalog seed.
 *
 * Template identity is (name, system owner): a template is looked up among
 * SYSTEM-OWNED environments only, so user copies with a colliding name never
 * shadow the gallery (they coexist untouched). A stale system-owned revision
 * — its stored `description` (the revision marker) differs from the file's
 * `meta.description` — is upgraded IN PLACE: deleted (cascading
 * devices/agents/services/flows) and re-imported from the current file.
 *
 * The importer also persists scenario-embedded `flows` (Fix-44a four-channel
 * promise) and derives one service per bound device × capability (W3), so a
 * refreshed template exercises the full current implementation surface:
 * deterministic business flows, physics baselines and demo-playback metadata
 * included.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import bcrypt from 'bcryptjs';

import { localizedText, type LocalizedText } from '@active-collaboration/shared';

import { importScenarioAsEnvironment } from '../environment-import.js';
import type { EnvironmentStore } from './environment-store.js';
import type { FlowStore } from './flow-store.js';
import type { ServiceStore } from './service-store.js';
import type { UserStore } from './user-store.js';

export const SYSTEM_USER_EMAIL = 'system@eaf.local';

/**
 * The bundled public gallery, in display order (starter worlds first, city
 * scale last). Each file lives in config/scenarios and is maintained as
 * current-generation content: demo metadata (tagline/heroEventId/playback
 * rate), embedded deterministic flows and physics baselines.
 */
const TEMPLATE_FILES = [
  // Onboarding + home tier
  'starter-home.json',
  'cross-brand-home.json',
  'suzhou-apartment.json',
  // Building / vertical-domain tier
  'teaching-building.json',
  'community-nursing-home.json',
  'smart-hotel.json',
  'smart-farm.json',
  // City-scale geo tier
  'suzhou-city.json',
  'shenzhen-resilience.json',
  'personal-health.json',
  // Campus tier (assumption-mode seed, large scale)
  'campus-assumed.json',
  // Campus collaboration-stress tier (R41: 21-agent service mesh, 600+ services)
  'campus-collab.json',
  // Resilience city tiers (R44: city-scale service mesh)
  'resilience-city-standard.json',
  'resilience-city-dense.json',
  // Realistic hierarchical city (R45: 61 agents, org-structured, semantic events)
  'shenzhen-realistic.json',
];

/**
 * Published seed offers (W3): city agents explicitly publish cross-owner
 * services beyond what their devices derive. Keyed by agent NAME (instance
 * ids are random per seed); applied only when the template env is created by
 * this call, so seeding stays idempotent.
 */
const SUZHOU_CITY_NAME = '苏州智慧城市（金鸡湖-姑苏示范）';
const PUBLISHED_SEED_SERVICES: Record<
  string,
  Array<{ name: string; semanticType: string; description: string }>
> = {
  国网苏州供电公司: [
    {
      name: '需求响应负荷聚合服务',
      semanticType: 'demand-response-aggregation',
      description:
        '聚合辖区内可调负荷，面向电网调度提供需求响应能力：削峰填谷、负荷预测与可调节容量上报。',
    },
  ],
  苏州应急管理中心: [
    {
      name: '突发事件联动调度服务',
      semanticType: 'emergency-coordination',
      description:
        '面向跨部门突发事件的联动调度：事件上报、资源协调与多 Agent 协作响应编排。',
    },
  ],
  // -------------------------------------------------------------------------
  // Commercial stakeholders (W4 template v2) — real-sector platform/property
  // operators, each publishing one cross-owner service. 滴滴/美团/哈啰 bind
  // no devices (their fleets are virtual), so their offers are UNBACKED by
  // bound-device capability — legitimate brokering, flagged by the W3
  // `unbacked` marker.
  // -------------------------------------------------------------------------
  '滴滴出行（苏州运力中心）': [
    {
      name: '网约车运力调度服务',
      semanticType: 'fleet-dispatch-service',
      description:
        '面向重大活动/突发事件的大面积运力调配：供需预测、运力池调度与重点区域疏散保障。',
    },
  ],
  '美团配送（园区站）': [
    {
      name: '即时配送应急投送服务',
      semanticType: 'emergency-logistics-service',
      description:
        '面向突发事件的应急物资即时投送：骑手运力调度、末端通行协调与最后一公里保障。',
    },
  ],
  特来电充电运营: [
    {
      name: '有序充电调度服务',
      semanticType: 'orderly-charging-service',
      description:
        '需求响应参与者：面向电网削峰的有序充电调度——充电计划编排、充电功率调节与可调负荷聚合上报。',
    },
  ],
  哈啰出行: [
    {
      name: '短驳运力保障服务',
      semanticType: 'micromobility-service',
      description:
        '面向大型活动散场/轨道接驳的两轮短驳运力保障：车辆调度、潮汐运维与电子围栏管理。',
    },
  ],
  万达广场商业物业: [
    {
      name: '商业楼宇需求响应服务',
      semanticType: 'commercial-dr-service',
      description:
        '商业楼宇可调负荷参与电网需求响应：中央空调/照明负荷调节、用电基线核算与响应效果验证。',
    },
  ],
};

/** Minimal logger contract (satisfied by fastify's pino logger). */
export interface SeedLogger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

/**
 * Ensure the bundled template environments exist at their current revision
 * (see TEMPLATE_FILES). Returns the ids of the environments created by this
 * call (empty when every template was already present at its current
 * revision).
 */
export function seedTemplates(
  users: UserStore,
  environments: EnvironmentStore,
  seedDir: string,
  log?: SeedLogger,
  services?: ServiceStore,
  flowStore?: FlowStore,
): string[] {
  const systemUser = ensureSystemUser(users);
  const created: string[] = [];
  for (const file of TEMPLATE_FILES) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(seedDir, file), 'utf-8'));
    } catch (error) {
      log?.warn({ file, err: error }, `Skipping template scenario "${file}" — unreadable`);
      continue;
    }
    const meta = (raw as { meta?: { name?: unknown; description?: unknown } })?.meta;
    // Localized-text union boundary (RC-2 recurrence, 2026-08-16): bundled
    // templates ship `meta.name`/`meta.description` as `{zh, en}` objects.
    // This gate previously required a plain string and silently skipped every
    // bilingual template — none of the geo city worlds seeded on a fresh DB.
    // Normalize with the same zh-CN canonical form environment-import stores,
    // so name lookup and the description revision marker both match.
    const name = localizedText(meta?.name as LocalizedText | string | undefined, 'zh-CN');
    if (name.trim().length === 0) {
      log?.warn({ file }, `Skipping template scenario "${file}" — meta.name missing`);
      continue;
    }
    const description = localizedText(meta?.description as LocalizedText | string | undefined, 'zh-CN');
    // Template identity is (name, system owner): user copies with a
    // colliding name coexist untouched and never shadow the gallery.
    const existing = environments.findEnvironmentByNameAndOwner(name, systemUser.id);
    if (existing !== undefined) {
      if (existing.description === description) continue; // current revision
      log?.info(
        { envId: existing.id, name },
        `Upgrading stale template "${name}" to the current revision`,
      );
      environments.deleteEnvironment(existing.id);
    }
    const env = importScenarioAsEnvironment(environments, raw, {
      ownerId: systemUser.id,
      visibility: 'public',
      ...(services !== undefined ? { serviceStore: services } : {}),
      ...(flowStore !== undefined ? { flowStore } : {}),
    });
    if (services !== undefined && env.name === SUZHOU_CITY_NAME) {
      seedPublishedServices(services, environments, env.id, log);
    }
    log?.info({ envId: env.id, name: env.name }, `Seeded template environment from "${file}"`);
    created.push(env.id);
  }
  return created;
}

/** Find or create the locked-out system account that owns seeded content. */
function ensureSystemUser(users: UserStore): { id: string } {
  return (
    users.findByEmail(SYSTEM_USER_EMAIL) ??
    users.create(
      SYSTEM_USER_EMAIL,
      bcrypt.hashSync(randomBytes(32).toString('hex'), 10),
      'System',
    )
  );
}

/** Attach the curated published offers to the freshly-seeded city agents. */
function seedPublishedServices(
  services: ServiceStore,
  environments: EnvironmentStore,
  envId: string,
  log?: SeedLogger,
): void {
  for (const agent of environments.agentsOf(envId)) {
    const offers = PUBLISHED_SEED_SERVICES[agent.name];
    if (offers === undefined) continue;
    for (const offer of offers) {
      services.createService({
        envId,
        providerAgentId: agent.id,
        name: offer.name,
        semanticType: offer.semanticType,
        description: offer.description,
        origin: 'published',
      });
      log?.info(
        { envId, agentId: agent.id, service: offer.name },
        `Seeded published service "${offer.name}"`,
      );
    }
  }
}
