/**
 * @vitest-environment node
 *
 * Service catalog reconciliation + rename-stable identity.
 *
 * Covers:
 * - reconcile: a runtime mirror missing rows / holding extra registrations /
 *   carrying attribute drift converges to the DB rows (DB is the source of
 *   truth) with a warn, on reconcileAll AND on the attach/rebuild lanes;
 * - rename continuity (world face): a device PATCH name keeps the derived
 *   rows' ids stable (identity = (source_device_id, semantic_type)), updates
 *   their display names, and leaves no orphan rows;
 * - performance smoke: a 3000-row catalog reconciles in O(n) (well under
 *   100ms — no per-row queries).
 */

import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EnvironmentCenter,
  type EngineRuntime,
} from '@active-collaboration/core';
import type { Service } from '@active-collaboration/shared';

import type { ServiceInstanceRow, ServiceStore } from '../db/service-store.js';
import { auth, makeTestApp, registerUser } from '../test-utils.js';
import { ServiceCatalogSync } from './service-catalog-sync.js';

// ---------------------------------------------------------------------------
// Seam fixtures (same shape as service-catalog-sync.vitest.test.ts)
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
  return { runtime };
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

function worldKeys(center: EnvironmentCenter): string[] {
  return [...center.getServices().keys()].filter(key => key.startsWith('world:'));
}

function ghostService(name: string, slot: string): Service {
  return {
    id: `world-service-${slot}`,
    name,
    description: 'out-of-band registration',
    deviceId: slot,
    uri: `world://services/${slot}`,
    httpMethod: 'POST',
    parameters: [],
    location: '',
    category: 'ghost',
    isConditional: false,
  } as Service;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('ServiceCatalogSync — reconcile', () => {
  it('repairs a mirror row deleted out of band (missing → re-registered, DB wins)', () => {
    const rows = [serviceRow({ id: 'svc-1' }), serviceRow({ id: 'svc-2', name: '新风', semantic_type: 'ventilation' })];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    const sync = new ServiceCatalogSync({ serviceStore: store });
    sync.attach('env-1', runtime);
    expect(worldKeys(center)).toHaveLength(2);

    // 带外删除一行镜像（对账前 notify 不会来 —— 模拟漂移窗口）。
    center.unregisterService('夜间制冷', 'world:svc-1');
    expect(worldKeys(center)).toHaveLength(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sync.reconcileAll();
    expect(worldKeys(center).sort()).toEqual(['world:svc-1:夜间制冷', 'world:svc-2:新风']);
    expect(warn.mock.calls.flat().join(' ')).toContain('missing: 1');
    warn.mockRestore();
  });

  it('removes an extra mirror registration that has no DB row', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    const sync = new ServiceCatalogSync({ serviceStore: store });
    sync.attach('env-1', runtime);

    // 带外多挂一个 world: 注册（FK 级联残留/异常时序的等价物）。
    center.registerService(ghostService('幽灵服务', 'world:ghost'), 'agent-a', 'world:ghost', {
      origin: 'published',
    });
    expect(worldKeys(center)).toHaveLength(2);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sync.reconcileAll();
    expect(worldKeys(center)).toEqual(['world:svc-1:夜间制冷']);
    expect(warn.mock.calls.flat().join(' ')).toContain('extra: 1');
    warn.mockRestore();
  });

  it('fixes attribute drift — a row rename re-keys the mirror to the new name', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    const sync = new ServiceCatalogSync({ serviceStore: store });
    sync.attach('env-1', runtime);

    // DB 行改名但 notify 丢失：镜像仍是旧名字（key 含 name → 属性漂移）。
    rows[0]!.name = '全天制冷';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sync.reconcileAll();
    expect(worldKeys(center)).toEqual(['world:svc-1:全天制冷']);
    expect(center.getServices().get('world:svc-1:全天制冷')!.service.name).toBe('全天制冷');
    expect(warn.mock.calls.flat().join(' ')).toContain('drifted: 1');
    warn.mockRestore();
  });

  it('a converged mirror reconciles silently (no warn, no churn)', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    const sync = new ServiceCatalogSync({ serviceStore: store });
    sync.attach('env-1', runtime);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = center.getServices().get('world:svc-1:夜间制冷');
    sync.reconcileAll();
    expect(warn).not.toHaveBeenCalled();
    // Same registration object — no unregister/register churn on a clean pass.
    expect(center.getServices().get('world:svc-1:夜间制冷')).toBe(before);
    warn.mockRestore();
  });

  it('the attach lane converges pre-existing drift in the runtime', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    // 运行时先于 attach 带外持有一个无 DB 行的 world: 注册。
    center.registerService(ghostService('幽灵服务', 'world:ghost'), 'agent-a', 'world:ghost', {
      origin: 'published',
    });
    const sync = new ServiceCatalogSync({ serviceStore: store });
    // attach = 全量重建（摘掉幽灵注册）+ 对账校验 —— 收口后镜像与 DB 一致。
    sync.attach('env-1', makeRuntime(center).runtime);
    expect(worldKeys(center)).toEqual(['world:svc-1:夜间制冷']);
  });

  it('reconcileAll drops stopped runtimes and leaves their centers untouched', () => {
    const rows = [serviceRow({ id: 'svc-1' })];
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const handle = {
      state: 'running',
      runtime: undefined as unknown as EngineRuntime,
    };
    handle.runtime = {
      getEnvironmentCenter: () => center,
      getState: () => handle.state,
    } as unknown as EngineRuntime;
    const sync = new ServiceCatalogSync({ serviceStore: store });
    sync.attach('env-1', handle.runtime);
    center.unregisterService('夜间制冷', 'world:svc-1');

    handle.state = 'stopped';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sync.reconcileAll();
    // Stopped runtime: no repair, no warn — the resumed sim re-attaches.
    expect(worldKeys(center)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Performance smoke — 3000-row catalog, O(n) reconcile
// ---------------------------------------------------------------------------

describe('ServiceCatalogSync — reconcile performance smoke', () => {
  it('3000 mirrored rows reconcile well under 100ms (map lookups, no per-row queries)', () => {
    const rows = Array.from({ length: 3000 }, (_, i) =>
      serviceRow({ id: `svc-${i}`, name: `服务-${i}` }),
    );
    const { store } = makeFakeStore(rows);
    const center = makeCenter();
    const { runtime } = makeRuntime(center);
    const sync = new ServiceCatalogSync({ serviceStore: store });
    sync.attach('env-1', runtime);
    expect(worldKeys(center)).toHaveLength(3000);

    const started = performance.now();
    sync.reconcileAll();
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Rename continuity (world face) — device PATCH name keeps derived identity
// ---------------------------------------------------------------------------

describe('derived service identity — device rename continuity (world face)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('PATCH /api/devices/:id name keeps row ids, updates names, leaves no orphans', async () => {
    const ctx = await makeTestApp();
    cleanups.push(ctx.cleanup);
    const owner = await registerUser(ctx.app, { displayName: 'Owner' });
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/environments',
      headers: auth(owner.token),
      payload: {
        name: 'Rename Lab',
        visibility: 'public',
        mapData: { zones: [{ id: 'zone-a' }] },
      },
    });
    expect(created.statusCode).toBe(201);
    const envId = created.json().id as string;

    const deviceRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/devices`,
      headers: auth(owner.token),
      payload: { name: '旧走廊灯', type: 'light', capabilities: ['turn-on', 'turn-off'], zoneId: 'zone-a' },
    });
    expect(deviceRes.statusCode).toBe(201);
    const device = deviceRes.json() as { id: string };
    const agent = ctx.app.envStore.createAgent({
      envId,
      ownerId: owner.id,
      name: 'Agent',
      capabilities: [],
      boundDeviceIds: [device.id],
    });
    ctx.app.serviceStore.syncDerivedForAgent(agent.id);
    const before = ctx.app.serviceStore
      .servicesOfAgent(agent.id)
      .filter(row => row.origin === 'derived');
    expect(before.length).toBeGreaterThan(0);
    expect(before.every(row => row.name.startsWith('旧走廊灯:'))).toBe(true);

    // The rename goes through the real PATCH route (which runs the
    // derivation sync for every agent bound to the device).
    const patchRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/devices/${device.id}`,
      headers: auth(owner.token),
      payload: { name: '新走廊灯' },
    });
    expect(patchRes.statusCode).toBe(200);

    const after = ctx.app.serviceStore
      .servicesOfAgent(agent.id)
      .filter(row => row.origin === 'derived');
    // Identity continuity: same row set (ids unchanged), same count — the
    // derivation key is (source_device_id, semantic_type), never the name.
    expect(after.map(row => row.id).sort()).toEqual(before.map(row => row.id).sort());
    expect(after).toHaveLength(before.length);
    // Display names follow the rename; no orphan rows under the old name.
    expect(after.every(row => row.name.startsWith('新走廊灯:'))).toBe(true);
    expect(after.some(row => row.name.includes('旧走廊灯'))).toBe(false);
  });
});
