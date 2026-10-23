/**
 * @vitest-environment node
 *
 * P2: service catalog sync — the world-layer service catalog
 * (service_instances rows with origin published/flow/aggregate) pushed into
 * every env-backed runtime's EnvironmentCenter, so the in-core discovery
 * paths (ServiceBroker / DualTriggerACManager / PartnerSelectionNegotiator)
 * see world-layer services with zero changes of their own.
 *
 * Covered here:
 * - seam unit: attach mirrors the right rows with the right meta, skips
 *   derived, filters hidden, degrades on store faults;
 * - incremental: catalog writes rebuild the live runtime's mirror
 *   (publish / visibility flip / unpublish), stopped runtimes are dropped;
 * - store: ServiceStore fires catalog-change notifications on its write
 *   methods (real in-memory DB);
 * - integration: a real env-backed runtime (SimulationRegistry.create with
 *   an environmentId) reflects a publish through getServices() — no LLM run.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  EnvironmentCenter,
  type EngineRuntime,
  type ScenarioDefinition,
} from '@active-collaboration/core';

import { openDatabase, type EafDatabase } from '../db/database.js';
import { EnvironmentStore } from '../db/environment-store.js';
import { ServiceStore, type ServiceInstanceRow } from '../db/service-store.js';
import { SimulationRegistry } from '../simulation-registry.js';
import { ServiceCatalogSync } from './service-catalog-sync.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function serviceRow(overrides: Partial<ServiceInstanceRow>): ServiceInstanceRow {
  return {
    id: 'svc-1',
    env_id: 'env-1',
    provider_agent_id: 'agent-a',
    name: '夜间制冷',
    semantic_type: 'temperature-control',
    description: '夏季夜间制冷服务',
    interface_json: JSON.stringify({
      actions: [{ name: 'set-temperature', parameters: { value: { type: 'number' } } }],
    }),
    origin: 'published',
    source_device_id: null,
    source_flow_id: null,
    visibility: 'public',
    zone_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ServiceInstanceRow;
}

function makeCenter(): EnvironmentCenter {
  return new EnvironmentCenter({ id: 'env-1', name: 'Env 1', createdBy: 'user-1' });
}

function makeRuntime(center: EnvironmentCenter, state = 'running') {
  const runtime = {
    getEnvironmentCenter: () => center,
    getState: () => state,
  } as unknown as EngineRuntime;
  return {
    runtime,
    stop: () => {
      (runtime as { getState: () => string }).getState = () => 'stopped';
    },
  };
}

/** Fake store: rows array is shared/mutable so tests drive catalog changes. */
function makeFakeStore(rows: ServiceInstanceRow[]) {
  const listeners = new Set<(envId: string) => void>();
  const store = {
    servicesOf: (envId: string) => rows.filter(row => row.env_id === envId),
    onCatalogChange: (listener: (envId: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ServiceStore;
  return {
    store,
    notify: (envId: string) => {
      for (const listener of listeners) listener(envId);
    },
  };
}

function worldRegistrations(center: EnvironmentCenter) {
  return [...center.getServices().entries()].filter(([key]) => key.startsWith('world:'));
}

// ---------------------------------------------------------------------------
// Seam unit tests
// ---------------------------------------------------------------------------

describe('ServiceCatalogSync — attach mirroring', () => {
  it('mirrors published/flow/aggregate rows with provenance meta; skips derived; filters hidden', () => {
    const rows = [
      serviceRow({ id: 'svc-pub', origin: 'published', visibility: 'public' }),
      serviceRow({ id: 'svc-mem', name: '新风', semantic_type: 'ventilation', visibility: 'members' }),
      serviceRow({ id: 'svc-flow', name: '巡检流', origin: 'flow', visibility: 'members' }),
      serviceRow({ id: 'svc-agg', name: '温控聚合', origin: 'aggregate', visibility: 'public' }),
      serviceRow({ id: 'svc-hidden', name: '私密服务', visibility: 'hidden' }),
      serviceRow({ id: 'svc-derived', name: '设备派生', origin: 'derived' }),
    ];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);

    new ServiceCatalogSync({ serviceStore: store }).attach('env-1', runtime);

    const mirrored = worldRegistrations(center);
    expect(mirrored.map(([key]) => key).sort()).toEqual([
      'world:svc-agg:温控聚合',
      'world:svc-flow:巡检流',
      'world:svc-mem:新风',
      'world:svc-pub:夜间制冷',
    ]);

    const [, pub] = mirrored.find(([key]) => key === 'world:svc-pub:夜间制冷')!;
    expect(pub.agentId).toBe('agent-a');
    expect(pub.deviceId).toBe('world:svc-pub');
    expect(pub.origin).toBe('published');
    expect(pub.semanticType).toBe('temperature-control');
    expect(pub.summary).toBe('夏季夜间制冷服务');
    expect(pub.visibility).toBe('public');
    // Discovery-facing Service shape: category carries the semantic type,
    // the Fix-15 callable surface becomes capabilities + parameter hints.
    expect(pub.service.category).toBe('temperature-control');
    expect(pub.service.providerAgentId).toBe('agent-a');
    expect(pub.service.capabilities).toEqual(['set-temperature']);
    expect(pub.service.parameters).toEqual([{ name: 'value', type: 'object', required: false }]);

    const [, agg] = mirrored.find(([key]) => key === 'world:svc-agg:温控聚合')!;
    expect(agg.origin).toBe('aggregate');
    const [, flow] = mirrored.find(([key]) => key === 'world:svc-flow:巡检流')!;
    expect(flow.origin).toBe('flow');
    // members tier enters the runtime with its tier preserved in meta.
    const [, mem] = mirrored.find(([key]) => key === 'world:svc-mem:新风')!;
    expect(mem.visibility).toBe('members');
  });

  it('store faults degrade to an empty mirror — attach never throws', () => {
    const store = {
      servicesOf: () => {
        throw new Error('db gone');
      },
      onCatalogChange: () => () => {},
    } as unknown as ServiceStore;
    const center = makeCenter();

    expect(() =>
      new ServiceCatalogSync({ serviceStore: store }).attach('env-1', makeRuntime(center).runtime),
    ).not.toThrow();
    expect(worldRegistrations(center)).toHaveLength(0);
  });
});

describe('ServiceCatalogSync — incremental rebuild', () => {
  it('publish / visibility flip / unpublish rebuild the live runtime mirror', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store, notify } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    new ServiceCatalogSync({ serviceStore: store }).attach('env-1', runtime);

    expect(worldRegistrations(center).map(([key]) => key)).toEqual(['world:svc-1:夜间制冷']);

    // Publish a second offer → the mirror picks it up on notify.
    rows.push(serviceRow({ id: 'svc-2', name: '新风', semantic_type: 'ventilation' }));
    notify('env-1');
    expect(worldRegistrations(center).map(([key]) => key).sort()).toEqual([
      'world:svc-1:夜间制冷',
      'world:svc-2:新风',
    ]);

    // Visibility flip to hidden → the service leaves the runtime.
    rows[0]!.visibility = 'hidden';
    notify('env-1');
    expect(worldRegistrations(center).map(([key]) => key)).toEqual(['world:svc-2:新风']);

    // Unpublish (row deleted) → the key is gone (safe delete, no throw).
    rows.splice(1, 1);
    notify('env-1');
    expect(worldRegistrations(center)).toHaveLength(0);
  });

  it('a change notify while the mirror already holds world: keys survives unregister misses', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store, notify } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    new ServiceCatalogSync({ serviceStore: store }).attach('env-1', runtime);

    // Remove the mirrored key out of band, then notify: the rebuild's
    // delete of the now-missing key must not throw, and re-registration wins.
    center.unregisterService('夜间制冷', 'world:svc-1');
    expect(() => notify('env-1')).not.toThrow();
    expect(worldRegistrations(center).map(([key]) => key)).toEqual(['world:svc-1:夜间制冷']);
  });

  it('stopped runtimes are dropped from the live set and no longer rebuilt', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store, notify } = makeFakeStore(rows);
    const center = makeCenter();
    const handle = makeRuntime(center);
    new ServiceCatalogSync({ serviceStore: store }).attach('env-1', handle.runtime);
    expect(worldRegistrations(center)).toHaveLength(1);

    handle.stop();
    rows.push(serviceRow({ id: 'svc-2', name: '新风' }));
    notify('env-1');
    // The dead runtime's center keeps its last mirror (no rebuild ran).
    expect(worldRegistrations(center).map(([key]) => key)).toEqual(['world:svc-1:夜间制冷']);
  });
});

// ---------------------------------------------------------------------------
// Store-side notifications (real in-memory DB)
// ---------------------------------------------------------------------------

describe('ServiceStore — catalog change notifications', () => {
  const dbs: EafDatabase[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function makeStores() {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const envStore = new EnvironmentStore(db);
    const serviceStore = new ServiceStore(db, envStore);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
    ).run(new Date().toISOString());
    const env = envStore.createEnvironment({ name: 'World', ownerId: 'user-1' });
    const agent = envStore.createAgent({
      envId: env.id,
      ownerId: 'user-1',
      name: 'Provider',
      capabilities: ['temperature-control'],
    });
    return { db, envStore, serviceStore, env, agent };
  }

  it('create / update / delete / restore each fire one notification with the env id', () => {
    const { serviceStore, env, agent } = makeStores();
    const seen: string[] = [];
    serviceStore.onCatalogChange(envId => seen.push(envId));

    const row = serviceStore.createService({
      envId: env.id,
      providerAgentId: agent.id,
      name: '夜间制冷',
      semanticType: 'temperature-control',
      origin: 'published',
      visibility: 'public',
    });
    serviceStore.updateService(row.id, { visibility: 'hidden' });
    serviceStore.deleteService(row.id);
    serviceStore.restoreService(row);

    expect(seen).toEqual([env.id, env.id, env.id, env.id]);
  });

  it('deleting a non-existent service is a silent no-op (no notification)', () => {
    const { serviceStore } = makeStores();
    const seen: string[] = [];
    serviceStore.onCatalogChange(envId => seen.push(envId));
    serviceStore.deleteService('no-such-service');
    expect(seen).toEqual([]);
  });

  it('a throwing listener never breaks the write path', () => {
    const { serviceStore, env, agent } = makeStores();
    serviceStore.onCatalogChange(() => {
      throw new Error('listener boom');
    });
    expect(() =>
      serviceStore.createService({
        envId: env.id,
        providerAgentId: agent.id,
        name: '夜间制冷',
        semanticType: 'temperature-control',
        origin: 'published',
      }),
    ).not.toThrow();
  });

  it('agent-delete FK cascade + explicit notifyCatalogChange converges the live mirror', () => {
    const { envStore, serviceStore, env, agent } = makeStores();
    serviceStore.createService({
      envId: env.id,
      providerAgentId: agent.id,
      name: '夜间制冷',
      semanticType: 'temperature-control',
      origin: 'published',
      visibility: 'public',
    });
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    new ServiceCatalogSync({ serviceStore }).attach(env.id, runtime);
    expect(worldRegistrations(center)).toHaveLength(1);

    // The FK cascade removes the row without any store write method — the
    // delete routes / proposal apply paths notify explicitly afterwards
    // (routes/env-objects.ts, proposal-service.ts).
    envStore.deleteAgent(agent.id);
    expect(worldRegistrations(center)).toHaveLength(1); // stale until notified
    serviceStore.notifyCatalogChange(env.id);
    expect(worldRegistrations(center)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: real env-backed runtime reflects publishes via getServices()
// ---------------------------------------------------------------------------

describe('ServiceCatalogSync — env-backed runtime integration', () => {
  const registries: SimulationRegistry[] = [];
  const dbs: EafDatabase[] = [];

  afterEach(() => {
    for (const registry of registries.splice(0)) registry.stopAll();
    for (const db of dbs.splice(0)) db.close();
  });

  function itScenario(): ScenarioDefinition {
    return {
      version: '1.0',
      meta: { id: 'catalog-sync-it', name: 'Catalog Sync IT' },
      zones: [
        {
          id: 'zone-a',
          name: 'Zone A',
          bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
          baseline: { temperature: 22 },
        },
      ],
      devices: [],
      agents: [
        {
          id: 'agent-a',
          name: 'Agent A',
          capabilities: ['temperature-monitoring'],
          managesZoneIds: ['zone-a'],
          boundDeviceIds: [],
        },
      ],
      events: [],
    } as unknown as ScenarioDefinition;
  }

  it('a published world-layer service lands in the live runtime EnvironmentCenter', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const envStore = new EnvironmentStore(db);
    const serviceStore = new ServiceStore(db, envStore);
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, created_at)
       VALUES ('user-1', 'u1@t.test', 'x', 'U1', ?)`,
    ).run(new Date().toISOString());
    const env = envStore.createEnvironment({ name: 'World', ownerId: 'user-1' });
    const provider = envStore.createAgent({
      envId: env.id,
      ownerId: 'user-1',
      name: 'Provider',
      capabilities: ['temperature-control'],
    });

    const sync = new ServiceCatalogSync({ serviceStore });
    const registry = new SimulationRegistry(
      {}, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, serviceStore, sync,
    );
    registries.push(registry);

    const record = await registry.create(itScenario(), {}, env.id);
    const center = record.runtime.getEnvironmentCenter();
    const worldRegs = () =>
      [...center.getServices().values()].filter(reg => reg.deviceId?.startsWith('world:') === true);
    expect(worldRegs()).toHaveLength(0);

    // Publish → the store notification rebuilds the mirror synchronously.
    const published = serviceStore.createService({
      envId: env.id,
      providerAgentId: provider.id,
      name: '夜间制冷',
      semanticType: 'temperature-control',
      description: '夏季夜间制冷服务',
      origin: 'published',
      visibility: 'public',
    });
    const after = worldRegs();
    expect(after).toHaveLength(1);
    expect(after[0]!.service.name).toBe('夜间制冷');
    expect(after[0]!.agentId).toBe(provider.id);
    expect(after[0]!.origin).toBe('published');
    expect(after[0]!.semanticType).toBe('temperature-control');

    // Hide it → the runtime loses the service.
    serviceStore.updateService(published.id, { visibility: 'hidden' });
    expect(worldRegs()).toHaveLength(0);
  });
});
