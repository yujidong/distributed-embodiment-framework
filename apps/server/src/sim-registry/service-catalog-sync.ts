/**
 * Service catalog sync (P2) — the world-layer service catalog pushed into
 * every env-backed runtime's EnvironmentCenter.
 *
 * The world layer (db/service-store.ts `service_instances`) owns services
 * the runtime never derives on its own: explicit `published` offers,
 * `flow`-backed services (Mechanism D), and `aggregate` semantic offers
 * (R53). Without this seam they are invisible to LLM decision-making — the
 * runtime registry only carries device-derived services. The seam mirrors
 * the RuntimeAttacher shape (see ac-agreement-bridge.ts): SimulationSeams
 * calls `attach(envId, runtime)` for every env-backed runtime (create +
 * resume lanes), and the seam subscribes to the store's catalog-change
 * notifications so later writes (publish / update / delete / visibility)
 * reach already-running runtimes.
 *
 * Design choices:
 * - derived rows are SKIPPED — the runtime derives device services itself
 *   (ResourceCoordinator, origin:'derived'); re-registering them would
 *   duplicate the face.
 * - visibility: `hidden` never enters the runtime; `public` and `members`
 *   both do (a sim agent is an environment participant — the members tier
 *   is its native view). The original tier rides the registration meta.
 * - registration key slot: the deviceId position carries `world:<row id>`,
 *   which can never collide with a device-derived key (`<deviceId>:<name>`)
 *   and keeps same-named rows distinct.
 * - increments are a FULL REBUILD of the env's `world:` registrations in
 *   that runtime (drop old keys, re-register from the current rows), not a
 *   fine diff — `EnvironmentCenter.unregisterService` throws on a missing
 *   key, so deletions are guarded.
 * - P3: the rebuild also sweeps the runtime's OWN `aggregate:`-slotted
 *   registrations (EngineRuntime registers built-in/scenario-rule offers at
 *   agent build time for core-only runs). In an env-backed runtime the DB
 *   rows are authoritative and mirrored under `world:` — leaving both would
 *   double the agent's semantic face.
 * - every persistence fault degrades to an empty catalog for that runtime;
 *   the runtime itself is never broken (same defensive style as the other
 *   SimulationSeams).
 * - reconciliation: attach and every full rebuild end with a mirror-vs-DB
 *   check (missing / extra / attribute drift — repaired with the DB as the
 *   source of truth, warn-logged), and `reconcileAll()` is the defensive
 *   full sweep the SimulationRegistry invokes on a low-frequency (10 min)
 *   timer. O(n) map lookups only — safe on 2600+ row catalogs.
 */

import type { EngineRuntime, EnvironmentCenter, ServiceRegistration } from '@active-collaboration/core';
import type { Service } from '@active-collaboration/shared';

import type { ServiceInstanceRow, ServiceStore } from '../db/service-store.js';
import type { RuntimeAttacher } from './types.js';

/** Synthetic deviceId slot for world-layer registrations (key = `world:<rowId>:<name>`). */
const WORLD_DEVICE_PREFIX = 'world:';

/** P3: EngineRuntime's own aggregate-offer slot (key = `aggregate:<agentId>:<semanticType>:<label>`). */
const AGGREGATE_DEVICE_PREFIX = 'aggregate:';

export function worldDeviceSlot(rowId: string): string {
  return `${WORLD_DEVICE_PREFIX}${rowId}`;
}

export interface ServiceCatalogSyncDeps {
  serviceStore: ServiceStore;
}

export class ServiceCatalogSync implements RuntimeAttacher {
  /** envId → live runtimes currently mirroring that env's catalog. */
  private readonly live = new Map<string, Set<EngineRuntime>>();

  constructor(private readonly deps: ServiceCatalogSyncDeps) {
    // One store subscription for the process: a catalog write rebuilds the
    // env's mirror in every live runtime of that env.
    this.deps.serviceStore.onCatalogChange(envId => this.onCatalogChange(envId));
  }

  /** Mirror the env's catalog into a freshly attached runtime. */
  attach(environmentId: string, runtime: EngineRuntime): void {
    let runtimes = this.live.get(environmentId);
    if (runtimes === undefined) {
      runtimes = new Set();
      this.live.set(environmentId, runtimes);
    }
    runtimes.add(runtime);
    this.rebuildRuntime(environmentId, runtime);
  }

  /**
   * Catalog change entry point (store notification; also directly callable):
   * full rebuild of the env's `world:` registrations in every live runtime.
   * Stopped runtimes are dropped from the live set (their EnvironmentCenter
   * is dead weight; a resumed sim re-attaches through SimulationSeams).
   */
  onCatalogChange(envId: string): void {
    const runtimes = this.live.get(envId);
    if (runtimes === undefined) return;
    for (const runtime of [...runtimes]) {
      if (runtime.getState() === 'stopped') {
        runtimes.delete(runtime);
        continue;
      }
      this.rebuildRuntime(envId, runtime);
    }
    if (runtimes.size === 0) this.live.delete(envId);
  }

  /**
   * Full rebuild of one runtime's mirror: drop every `world:` registration,
   * then re-register from the store's current rows. Any fault (store read,
   * JSON parse, registry throw) degrades to a warn — never breaks the runtime.
   */
  private rebuildRuntime(envId: string, runtime: EngineRuntime): void {
    try {
      const rows = this.deps.serviceStore
        .servicesOf(envId)
        .filter(row => row.origin !== 'derived' && row.visibility !== 'hidden');
      const center = runtime.getEnvironmentCenter();
      // 先摘掉旧的 world: 注册（unregister 对不存在的 key 会 throw，逐个守护）。
      // P3: 同时清掉运行时自己注册的 aggregate: 槽位 —— env-backed runtime 里
      // DB 行（world: 镜像）才是权威，两张面孔不能并存。
      for (const registration of [...center.getServices().values()]) {
        const mirroredSlot =
          registration.deviceId?.startsWith(WORLD_DEVICE_PREFIX) === true ||
          registration.deviceId?.startsWith(AGGREGATE_DEVICE_PREFIX) === true;
        if (!mirroredSlot) continue;
        try {
          center.unregisterService(registration.service.name, registration.deviceId);
        } catch {
          // Already gone — a rebuild must never fail on a stale key.
        }
      }
      for (const row of rows) {
        this.registerRow(center, row);
      }
    } catch (error) {
      console.warn(
        `ServiceCatalogSync: catalog rebuild for env ${envId} failed (runtime unaffected):`,
        error,
      );
    }
    // 对账（attach 与每次全量重建的收口校验）：重建本身是"摘了重挂"，对账
    // 兜底重建途中的部分失败与带外写入，发现不一致以 DB 为准修复。
    this.reconcileRuntime(envId, runtime);
  }

  /**
   * Reconciliation (P-identity): verify one runtime's `world:` mirror against
   * the store's current rows and repair any drift with the DB as the source
   * of truth — missing rows re-registered, stale registrations (FK-cascade
   * leftovers, out-of-band writes) removed, attribute drift (rename /
   * visibility flip / interface change) re-stamped. O(n) map lookups only
   * (one servicesOf read + one registry scan), safe on 2600+ row catalogs.
   * Never throws: faults degrade to a warn, the runtime is untouched.
   */
  private reconcileRuntime(envId: string, runtime: EngineRuntime): void {
    try {
      const rows = this.deps.serviceStore
        .servicesOf(envId)
        .filter(row => row.origin !== 'derived' && row.visibility !== 'hidden');
      const expectedByRowId = new Map(rows.map(row => [row.id, row]));
      const center = runtime.getEnvironmentCenter();
      let missing = 0;
      let extra = 0;
      let drifted = 0;
      const seen = new Set<string>();
      for (const registration of [...center.getServices().values()]) {
        const slot = registration.deviceId;
        if (slot?.startsWith(WORLD_DEVICE_PREFIX) !== true) continue;
        const rowId = slot.slice(WORLD_DEVICE_PREFIX.length);
        const row = expectedByRowId.get(rowId);
        if (row === undefined) {
          // 多出来的镜像：对应 DB 行已不存在（或转 hidden/derived）——摘除。
          this.unregisterQuietly(center, registration);
          extra += 1;
          continue;
        }
        seen.add(rowId);
        if (mirrorDrifted(registration, row)) {
          // 属性漂移（含改名 —— key 含 name，必须先摘旧 key 再挂新 key）。
          this.unregisterQuietly(center, registration);
          this.registerRow(center, row);
          drifted += 1;
        }
      }
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        // 缺失的镜像：DB 行在但运行时没有 —— 补上。
        this.registerRow(center, row);
        missing += 1;
      }
      if (missing + extra + drifted > 0) {
        console.warn(
          `ServiceCatalogSync: reconciled env ${envId} runtime mirror ` +
          `(missing: ${missing}, extra: ${extra}, drifted: ${drifted})`,
        );
      }
    } catch (error) {
      console.warn(
        `ServiceCatalogSync: catalog reconcile for env ${envId} failed (runtime unaffected):`,
        error,
      );
    }
  }

  /**
   * Defensive full reconciliation of EVERY live mirror (periodic sweep — the
   * SimulationRegistry calls this on a low-frequency timer). Stopped runtimes
   * are dropped from the live set, same as onCatalogChange.
   */
  reconcileAll(): void {
    for (const [envId, runtimes] of [...this.live]) {
      for (const runtime of [...runtimes]) {
        if (runtime.getState() === 'stopped') {
          runtimes.delete(runtime);
          continue;
        }
        this.reconcileRuntime(envId, runtime);
      }
      if (runtimes.size === 0) this.live.delete(envId);
    }
  }

  /** registerService helper shared by rebuild + reconcile (one row → one mirror). */
  private registerRow(center: EnvironmentCenter, row: ServiceInstanceRow): void {
    center.registerService(serviceOfRow(row), row.provider_agent_id, worldDeviceSlot(row.id), {
      origin: row.origin,
      semanticType: row.semantic_type,
      summary: row.description,
      visibility: row.visibility,
    });
  }

  /** unregister that never throws — a reconcile must survive a stale key. */
  private unregisterQuietly(center: EnvironmentCenter, registration: ServiceRegistration): void {
    try {
      center.unregisterService(registration.service.name, registration.deviceId);
    } catch {
      // Already gone — a reconcile must never fail on a stale key.
    }
  }
}

/**
 * Does the mirrored registration still match the DB row's projection? Every
 * field the mirror stamps (serviceOfRow + registration meta) is compared;
 * capabilities order is stable (the interface_json action order round-trips).
 */
function mirrorDrifted(registration: ServiceRegistration, row: ServiceInstanceRow): boolean {
  const expected = serviceOfRow(row);
  return (
    registration.service.name !== expected.name ||
    registration.agentId !== row.provider_agent_id ||
    registration.service.category !== expected.category ||
    registration.service.description !== expected.description ||
    registration.semanticType !== row.semantic_type ||
    registration.summary !== row.description ||
    registration.visibility !== row.visibility ||
    registration.origin !== row.origin ||
    (registration.service.capabilities ?? []).join(' ') !== (expected.capabilities ?? []).join(' ')
  );
}

/**
 * Map a world-layer `service_instances` row to a core Service. Discovery
 * paths match on `category` (ServiceBroker) and read it as the semantic
 * type (PartnerSelectionNegotiator's `svc.category`), so the row's
 * semantic_type lands there; the callable surface of `interface_json`
 * (Fix-15 `{actions:[{name, parameters}]}`) becomes capabilities +
 * parameter hints.
 */
function serviceOfRow(row: ServiceInstanceRow): Service {
  const actions = actionsOf(row.interface_json);
  return {
    id: `world-service-${row.id}`,
    name: row.name,
    description: row.description,
    deviceId: worldDeviceSlot(row.id),
    uri: `world://services/${row.id}`,
    httpMethod: 'POST',
    parameters: actions.flatMap(action =>
      Object.keys(action.parameters).map(name => ({ name, type: 'object' as const, required: false })),
    ),
    location: '',
    category: row.semantic_type,
    isConditional: false,
    capabilities: actions.map(action => action.name),
    semanticType: row.semantic_type,
    origin: row.origin,
    summary: row.description,
    providerAgentId: row.provider_agent_id,
  };
}

/** Parse the Fix-15 callable surface; unknown/legacy shapes degrade to none. */
function actionsOf(interfaceJson: string): Array<{ name: string; parameters: Record<string, unknown> }> {
  try {
    const parsed = JSON.parse(interfaceJson) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) return [];
    return parsed.actions.filter(
      (action): action is { name: string; parameters: Record<string, unknown> } =>
        typeof action === 'object' && action !== null &&
        typeof (action as { name?: unknown }).name === 'string' &&
        typeof (action as { parameters?: unknown }).parameters === 'object' &&
        (action as { parameters?: unknown }).parameters !== null,
    );
  } catch {
    return [];
  }
}
