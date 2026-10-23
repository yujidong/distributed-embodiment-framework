/**
 * @vitest-environment node
 *
 * P3 end-to-end: scenario-authored semantic service channels —
 *
 *   scenario JSON (agents[].services + semanticOfferRules + capabilitySynonyms)
 *   → importScenarioAsEnvironment
 *   → service_instances rows (declared services as origin='published';
 *     aggregate offers derived under the MERGED rule table)
 *   → environment bridge (rules/synonyms ride mapData back into the scenario)
 *   → P2 catalog-sync seam → live runtime getServices()
 *
 * …plus the runtime/registry side effects: the runtime's OWN `aggregate:`
 * registrations are swept by the seam (the DB mirror stays the single
 * semantic face in env-backed runtimes), and the scenario's synonym groups
 * are registered into the process-level matcher at load.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { capabilityMatches } from '@active-collaboration/core';

import { openDatabase, type EafDatabase } from './db/database.js';
import { EnvironmentStore } from './db/environment-store.js';
import { ServiceStore } from './db/service-store.js';
import { importScenarioAsEnvironment } from './environment-import.js';
import { environmentToScenario } from './environment-bridge.js';
import { SimulationRegistry } from './simulation-registry.js';
import { ServiceCatalogSync } from './sim-registry/service-catalog-sync.js';

const QUIET_RULE = {
  semanticType: 'library-quiet-guard',
  label: '图书馆静音保障',
  description: '噪声监测联动情报板播控提醒，维持阅览区安静。',
  requires: ['noise-monitoring', 'content-display'],
  actuates: ['set-message'],
};

const DECLARED_SERVICE = {
  semanticType: 'night-patrol-campus',
  label: '夜间巡更',
  description: '闭馆后巡更调度（作者直接声明的语义服务）。',
  requires: ['patrol-tracking'],
  actuates: ['patrol-dispatch'],
};

function campusScenario(): Record<string, unknown> {
  return {
    version: '1.0',
    meta: { id: 'p3-campus', name: 'P3 Campus' },
    zones: [{ id: 'zone-a', name: 'Zone A' }],
    devices: [
      {
        id: 'pump-a',
        type: 'water-pump',
        capabilities: ['valve-control', 'water-level-monitoring', 'turn-on'],
        zoneId: 'zone-a',
      },
      {
        id: 'noise-sensor-a',
        type: 'noise-sensor',
        capabilities: ['noise-monitoring'],
        zoneId: 'zone-a',
      },
      {
        id: 'display-a',
        type: 'display',
        capabilities: ['content-display', 'set-message'],
        zoneId: 'zone-a',
      },
    ],
    agents: [
      {
        id: 'steward',
        name: 'Steward',
        capabilities: [],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['pump-a', 'noise-sensor-a', 'display-a'],
        services: [DECLARED_SERVICE],
      },
    ],
    events: [],
    semanticOfferRules: [QUIET_RULE],
    capabilitySynonyms: [['noise-sensing-p3e2e', 'noise-monitoring']],
  };
}

const dbs: EafDatabase[] = [];
const registries: SimulationRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.stopAll();
  for (const db of dbs.splice(0)) db.close();
});

function makeWorld() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const envStore = new EnvironmentStore(db);
  const serviceStore = new ServiceStore(db, envStore);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, created_at)
     VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
  ).run(new Date().toISOString());
  const env = importScenarioAsEnvironment(envStore, campusScenario(), {
    ownerId: 'user-1',
    serviceStore,
  });
  return { db, envStore, serviceStore, env };
}

/** 公开环境导入时声明服务的可见性（跟随环境）。 */
function importDeclaredOnPublicEnv(): string | undefined {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const envStore = new EnvironmentStore(db);
  const serviceStore = new ServiceStore(db, envStore);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, created_at)
     VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
  ).run(new Date().toISOString());
  const env = importScenarioAsEnvironment(envStore, campusScenario(), {
    ownerId: 'user-1',
    serviceStore,
    visibility: 'public',
  });
  return serviceStore.servicesOf(env.id).find(r => r.semantic_type === 'night-patrol-campus')
    ?.visibility;
}

describe('P3 — scenario semantic services end-to-end', () => {
  it('import lands declared services (published) + aggregate rows under merged rules', () => {
    const { serviceStore, env } = makeWorld();
    const rows = serviceStore.servicesOf(env.id);

    // 作者声明的语义服务 → origin='published' 行（members 可见的协作面孔）。
    const declared = rows.find(r => r.semantic_type === 'night-patrol-campus');
    expect(declared).toBeDefined();
    expect(declared!.origin).toBe('published');
    expect(declared!.name).toBe('夜间巡更');
    expect(declared!.visibility).toBe('members');
    expect(declared!.source_device_id).toBeNull();

    // 公开环境导入 → 声明服务跟随环境公开（设备私有、服务公开）；
    // 非公开环境保持 members 默认（上面的断言）。
    const declaredPublic = importDeclaredOnPublicEnv();
    expect(declaredPublic).toBe('public');

    // Aggregate 推导使用合并规则表：内置 drainage-control + 场景自定义规则。
    const aggregateTypes = rows
      .filter(r => r.origin === 'aggregate')
      .map(r => r.semantic_type)
      .sort();
    expect(aggregateTypes).toEqual(['drainage-control', 'library-quiet-guard']);
  });

  it('the bridge carries rules/synonyms back into the scenario (mapData round-trip)', () => {
    const { envStore, env } = makeWorld();
    const scenario = environmentToScenario(
      env,
      envStore.devicesOf(env.id),
      envStore.agentsOf(env.id),
    );
    expect(scenario.semanticOfferRules).toEqual([QUIET_RULE]);
    expect(scenario.capabilitySynonyms).toEqual([['noise-sensing-p3e2e', 'noise-monitoring']]);
    // The runtime matching surface unions the derived semantic types under
    // the SAME merged table (R53 face + scenario vocabulary).
    const steward = scenario.agents.find(a => a.name === 'Steward')!;
    expect(steward.capabilities).toContain('drainage-control');
    expect(steward.capabilities).toContain('library-quiet-guard');
  });

  it('scenario synonyms register into the process-level matcher at import', () => {
    // Unique pair for this test — the shared fixture's group is already
    // registered by earlier tests in this file (process-level registry).
    const { envStore, serviceStore } = (() => {
      const db = openDatabase(':memory:');
      dbs.push(db);
      const envStore = new EnvironmentStore(db);
      const serviceStore = new ServiceStore(db, envStore);
      db.prepare(
        `INSERT INTO users (id, email, password_hash, display_name, created_at)
         VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
      ).run(new Date().toISOString());
      return { envStore, serviceStore };
    })();
    const raw = campusScenario();
    raw.capabilitySynonyms = [['p3e2e-unique-x', 'p3e2e-unique-y']];
    expect(capabilityMatches('p3e2e-unique-x', 'p3e2e-unique-y')).toBe(false);
    importScenarioAsEnvironment(envStore, raw, { ownerId: 'user-1', serviceStore });
    expect(capabilityMatches('p3e2e-unique-x', 'p3e2e-unique-y')).toBe(true);
  });

  it('P2 seam: the live runtime sees declared + aggregate services; its own aggregate: keys are swept', async () => {
    const { envStore, serviceStore, env } = makeWorld();
    const scenario = environmentToScenario(
      env,
      envStore.devicesOf(env.id),
      envStore.agentsOf(env.id),
    );

    const sync = new ServiceCatalogSync({ serviceStore });
    const registry = new SimulationRegistry(
      {}, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, serviceStore, sync,
    );
    registries.push(registry);

    const record = await registry.create(scenario, {}, env.id);
    const registrations = [...record.runtime.getEnvironmentCenter().getServices().values()];

    // 世界层镜像（world: 槽位）：声明服务与 aggregate 行都可见。
    const world = registrations.filter(reg => reg.deviceId?.startsWith('world:') === true);
    const worldTypes = world.map(reg => reg.semanticType).sort();
    expect(worldTypes).toEqual([
      'drainage-control',
      'library-quiet-guard',
      'night-patrol-campus',
    ]);
    const declared = world.find(reg => reg.semanticType === 'night-patrol-campus')!;
    expect(declared.origin).toBe('published');
    const quiet = world.find(reg => reg.semanticType === 'library-quiet-guard')!;
    expect(quiet.origin).toBe('aggregate');

    // 运行时自己在 buildAgent 时注册的 aggregate: 槽位被 seam 清扫——
    // env-backed runtime 里 DB 镜像是唯一的语义面孔（不能两张并存）。
    expect(
      registrations.filter(reg => reg.deviceId?.startsWith('aggregate:') === true),
    ).toHaveLength(0);
  });
});
