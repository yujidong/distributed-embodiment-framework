/**
 * HassShadowService — HIL reverse mapping P2: shadow worlds
 * (design-hil-reverse-mapping.md §2-P2)
 *
 * A SHADOW of an environment is a sandbox fork (P2F §10 infrastructure —
 * quota/lineage/expiry/sweep/env-delete cascade all reused via
 * SandboxService) whose physics are driven by the REAL observation stream:
 * state_changed pushes of the env's hass://-bound entities advance the
 * fork's sim clock (wall-anchored, 1:1) and write the observed state into
 * the fork — the physical field for sensor-class entities (through
 * EngineRuntime.updateZoneBaseline, the EXISTING boundary-condition
 * channel weather feeds and twin-sync use — never injectEvent, so no flow
 * triggers and no agent fanout) and the device state via the
 * checkpoint-restore seam (RuntimeDevice.restoreState on the raw device
 * the fork's deviceFactory kept — silent, no events/timeline rows). The
 * authoritative world is never touched (原则 A: contamination happens only
 * inside the fork). Zero core changes: every write channel is a
 * pre-existing public seam.
 *
 * Fork source: the environment BASE LAYER (static fork — the same truth
 * twin-sync maintains and P1 snapshot alignment keeps converged to
 * reality); `fromCheckpoint: true` opts into the P2F cheap fork of the
 * authoritative world session's current dynamics.
 *
 * Wall→sim anchor: the shadow keeps its OWN anchor (fork moment:
 * anchorWallMs ↔ runtime simTimeSec), independent of the source world's
 * simPerWallSec. An observation stamped observedAtWallMs maps to
 * `anchorSimSec + (observedAtWallMs - anchorWallMs)/1000`; while the fork
 * is paused (its normal state) the service advanceTo()s that target before
 * writing, so model physics evolve BETWEEN observations and the pre-write
 * read is the model's PREDICTION — the (predicted, observed) pairs are the
 * residual sequence P3's calibration loop will consume. If an operator
 * starts the fork ticking (what-if), writes land at the current sim time.
 *
 * Safety (§5): the shadow can NEVER actuate the real world — by
 * CONSTRUCTION, not by gate: the fork scenario rewrites every hass://
 * binding to sim://, so the runtime contains no HADevice at all. On top of
 * that the deviceFactory wraps formerly-hass-bound devices in a discard
 * Proxy: any actuation attempt (agent / HTTP / what-if / flow — all paths
 * converge on device.executeCommand) throws and is COUNTED
 * (actuationDiscarded), the same explicit-failure discipline as the
 * entity-map allowlist. Live observation writes ride the P3b E-stop as
 * the reverse channel does (pushes dropped while engaged).
 *
 * Privacy (原则 B): create/status/destroy are FULL-tier operations
 * (admin / environment owner) — the status carries entity ids and real
 * telemetry of every bound device.
 *
 * Lifecycle: DELETE (or refresh) stops the fork through SandboxService
 * (row marked stopped, runtime torn down). Shadow state is IN-MEMORY:
 * after a process restart the fork row may linger, so boot calls
 * reapOrphanShadowForks() which marks stopped every shadow-stamped row
 * (fork_base policy.shadow === true) whose registry sim is gone.
 */

import { randomUUID } from 'node:crypto';

import {
  createSimulatedDevice,
  type RuntimeDevice,
  type ScenarioDefinition,
} from '@active-collaboration/core';
import { createLogger } from '@active-collaboration/shared';

import type { AuthUser } from '../auth/index.js';
import type {
  DeviceInstanceRow,
  EnvironmentStore,
} from '../db/environment-store.js';
import type { SandboxStore } from '../db/sandbox-store.js';
import { ApiError } from '../errors.js';
import type { SandboxService } from '../sandbox-service.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import type { HAWebSocketConnection, HassEntityState } from './connection.js';
import { hassStateView } from './reverse-sync.js';
import type { HassSafetyGate } from './safety-gate.js';
import type { HASService } from './service.js';

const logger = createLogger('HassShadowService');

/** fork_base policy marker — boot reaps orphan rows carrying it. */
export const SHADOW_FORK_POLICY_MARKER = 'shadow';

/** One applied observation (recent ring + the residual entries it found). */
export interface HassShadowObservation {
  id: string;
  at: string;
  deviceId: string;
  deviceName: string;
  entityId: string;
  /** Sim time of the shadow world at the write. */
  simTimeSec: number;
  /** Pre-write model prediction vs observed value, per drifted key. */
  changes: { key: string; predicted: unknown; observed: unknown }[];
}

export interface HassShadowDeviceStatus {
  deviceId: string;
  deviceName: string;
  entityId: string;
  observations: number;
  discardedCommands: number;
}

export interface HassShadowStatus {
  envId: string;
  sandboxId: string;
  simulationId: string;
  state: string;
  simTimeSec: number;
  fromCheckpoint: boolean;
  createdBy: string;
  createdAt: string;
  /** The shadow's own wall↔sim anchor (fork moment). */
  anchor: { wallMs: number; simTimeSec: number };
  estopActive: boolean;
  hass: { configured: boolean; state: string };
  boundDevices: HassShadowDeviceStatus[];
  observationCount: number;
  discardedCommandCount: number;
  lastObservationAt: string | null;
  /** Newest first (in-memory ring of this process). */
  recentObservations: HassShadowObservation[];
}

interface HassShadowServiceDeps {
  hass: HASService;
  gate: HassSafetyGate;
  envStore: EnvironmentStore;
  sandboxService: SandboxService;
  sandboxStore: SandboxStore;
  registry: SimulationRegistry;
  /** Per-device minimum interval between observation writes (def. 1s). */
  liveMinIntervalMs?: number;
  /** Subscription reconcile cadence (def. 15s). */
  reconcileIntervalMs?: number;
  /** In-memory recent-observation ring size (def. 20). */
  recentLimit?: number;
}

interface ShadowEntry {
  envId: string;
  sandboxId: string;
  simulationId: string;
  createdBy: string;
  createdAt: string;
  fromCheckpoint: boolean;
  anchorWallMs: number;
  anchorSimSec: number;
  /** entityId → unsubscribe. */
  subscriptions: Map<string, () => void>;
  /** deviceId → wall-ms of the last observation write (throttle). */
  lastApplyAt: Map<string, number>;
  /** deviceId → trailing-edge timer for a push that arrived mid-throttle. */
  trailingTimers: Map<string, NodeJS.Timeout>;
  /** Serialized observation writes (advanceTo is async + forward-only). */
  applyQueue: Promise<void>;
  observationCount: number;
  lastObservationAt: string | null;
  /** deviceId → observations applied. */
  observationsByDevice: Map<string, number>;
  /** deviceId → actuation attempts discarded (shared with the factory closure). */
  discardsByDevice: Map<string, number>;
  /** deviceId → the RAW runtime device (observation writes via restoreState). */
  rawDevices: Map<string, RuntimeDevice>;
  recent: HassShadowObservation[];
}

/** sensor/binary_sensor device_class → physical-field parameter. */
const DEVICE_CLASS_FIELD_PARAMETERS: Record<string, string> = {
  temperature: 'temperature',
  humidity: 'humidity',
  co2: 'co2',
  pm25: 'pm2_5',
  illuminance: 'light',
};

export class HassShadowService {
  private readonly hass: HASService;
  private readonly gate: HassSafetyGate;
  private readonly envStore: EnvironmentStore;
  private readonly sandboxService: SandboxService;
  private readonly sandboxStore: SandboxStore;
  private readonly registry: SimulationRegistry;
  private readonly liveMinIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly recentLimit: number;

  private readonly shadows = new Map<string, ShadowEntry>();
  private reconcileTimer?: NodeJS.Timeout;

  constructor(deps: HassShadowServiceDeps) {
    this.hass = deps.hass;
    this.gate = deps.gate;
    this.envStore = deps.envStore;
    this.sandboxService = deps.sandboxService;
    this.sandboxStore = deps.sandboxStore;
    this.registry = deps.registry;
    this.liveMinIntervalMs = deps.liveMinIntervalMs ?? 1_000;
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 15_000;
    this.recentLimit = deps.recentLimit ?? 20;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the env's shadow fork (or re-fork it with `refresh: true`). The
   * route has already authorized the caller (FULL tier); the fork row is
   * owned by them, so the standard sandbox quota applies honestly.
   */
  async create(
    envId: string,
    user: AuthUser,
    options: { refresh?: boolean; fromCheckpoint?: boolean } = {},
  ): Promise<HassShadowStatus> {
    const env = this.envStore.getEnvironment(envId);
    if (!env) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    }
    if (this.shadows.has(envId)) {
      if (options.refresh !== true) {
        throw new ApiError(
          409,
          'SHADOW_EXISTS',
          `Environment "${envId}" already has a shadow world — pass {"refresh": true} to ` +
            're-fork it from the current environment state, or DELETE it first',
        );
      }
      await this.destroy(envId);
    }
    const bound = this.boundDevicesOf(envId);
    if (bound.length === 0) {
      throw new ApiError(
        409,
        'SHADOW_NO_BOUND_DEVICES',
        `Environment "${envId}" has no hass://-bound devices — a shadow world is driven by ` +
          'real observations; bind a real device first (device binding "hass://<entity-id>")',
      );
    }

    // Actuation-discard counters + raw device refs exist BEFORE the fork:
    // the deviceFactory fires during the registry build inside
    // SandboxService.fork. Both are shared with the shadow entry created
    // after the fork (the raw refs are the observation write channel —
    // RuntimeDevice.restoreState, the checkpoint seam).
    const boundIds = new Set(bound.map(({ device }) => device.id));
    const discardsByDevice = new Map<string, number>();
    const rawDevices = new Map<string, RuntimeDevice>();
    const hooks = {
      // Safety by construction: the shadow world contains NO HADevice —
      // every hass:// binding becomes sim://, so no code path inside the
      // fork can reach the real Home Assistant.
      transformScenario: (scenario: ScenarioDefinition): ScenarioDefinition => ({
        ...scenario,
        devices: scenario.devices.map(device =>
          boundIds.has(device.id) && device.binding.startsWith('hass://')
            ? { ...device, binding: `sim://${device.id}` }
            : device,
        ),
      }),
      createOptions: {
        deviceFactory: (def: ScenarioDefinition['devices'][number]): RuntimeDevice => {
          const device = createSimulatedDevice(def);
          if (!boundIds.has(def.id)) return device;
          rawDevices.set(def.id, device);
          return shadowDiscardProxy(device, () => {
            discardsByDevice.set(def.id, (discardsByDevice.get(def.id) ?? 0) + 1);
          });
        },
      },
      policyExtra: { [SHADOW_FORK_POLICY_MARKER]: true },
    };

    const sandbox = options.fromCheckpoint === true
      ? await this.sandboxService.forkFromCheckpoint(env, user, undefined, hooks)
      : await this.sandboxService.fork(env, user, undefined, hooks);
    const record = sandbox.simulation_id !== null
      ? this.registry.get(sandbox.simulation_id)
      : undefined;
    if (!record) {
      throw new ApiError(500, 'SHADOW_FORK_FAILED', 'Shadow fork did not register a simulation');
    }
    // 'paused', not 'created': the sandbox retention sweep reclaims
    // never-started forks — a shadow is long-lived by design. Advancement
    // is observation-driven (advanceTo), so no tick timer ever runs.
    record.runtime.start(1);
    record.runtime.pause();

    const entry: ShadowEntry = {
      envId,
      sandboxId: sandbox.id,
      simulationId: record.id,
      createdBy: user.id,
      createdAt: sandbox.created_at,
      fromCheckpoint: options.fromCheckpoint === true,
      anchorWallMs: Date.now(),
      anchorSimSec: record.runtime.getSimTimeSec(),
      subscriptions: new Map(),
      lastApplyAt: new Map(),
      trailingTimers: new Map(),
      applyQueue: Promise.resolve(),
      observationCount: 0,
      lastObservationAt: null,
      observationsByDevice: new Map(),
      discardsByDevice,
      rawDevices,
      recent: [],
    };
    this.shadows.set(envId, entry);
    await this.reconcileEntry(entry);
    this.ensureReconcileTimer();
    logger.info(
      `shadow world created for env ${envId}: fork ${sandbox.id} (sim ${record.id}, ` +
      `${bound.length} hass-bound device(s), fromCheckpoint=${entry.fromCheckpoint})`,
    );
    return this.statusOf(entry);
  }

  /** Status of the env's shadow (404 when none / when the fork is gone). */
  status(envId: string): HassShadowStatus {
    const entry = this.shadows.get(envId);
    if (!entry) throw this.notFound(envId);
    if (!this.liveRecord(entry)) {
      // The fork is gone (env deletion cascade, sandbox stop, sweep) —
      // self-heal the in-memory entry and report honestly.
      this.teardownEntry(entry);
      throw this.notFound(envId);
    }
    return this.statusOf(entry);
  }

  /** Destroy the env's shadow: unsubscribe + stop the fork (idempotent row). */
  async destroy(envId: string): Promise<void> {
    const entry = this.shadows.get(envId);
    if (!entry) throw this.notFound(envId);
    const sandbox = this.sandboxStore.get(entry.sandboxId);
    if (sandbox) this.sandboxService.stop(sandbox);
    this.teardownEntry(entry);
    logger.info(`shadow world destroyed for env ${envId} (fork ${entry.sandboxId})`);
  }

  private notFound(envId: string): ApiError {
    return new ApiError(
      404,
      'SHADOW_NOT_FOUND',
      `Environment "${envId}" has no shadow world — create one with POST /api/environments/:id/shadow`,
    );
  }

  /** Unsubscribe + drop the in-memory entry (fork teardown happens elsewhere). */
  private teardownEntry(entry: ShadowEntry): void {
    for (const timer of entry.trailingTimers.values()) clearTimeout(timer);
    entry.trailingTimers.clear();
    for (const unsubscribe of entry.subscriptions.values()) unsubscribe();
    entry.subscriptions.clear();
    this.shadows.delete(entry.envId);
  }

  private liveRecord(entry: ShadowEntry) {
    return this.registry.get(entry.simulationId);
  }

  // -------------------------------------------------------------------------
  // Observation stream (state_changed → shadow writes)
  // -------------------------------------------------------------------------

  /** Server boot hook: reap orphan shadow rows + arm the reconcile timer. */
  start(): void {
    this.reapOrphanShadowForks();
    this.ensureReconcileTimer();
  }

  /**
   * Process-restart hygiene: shadow forks are in-memory, so a shadow row
   * whose registry sim is gone is an orphan — mark it stopped (releasing
   * the quota slot) instead of letting it linger until the age sweep.
   */
  reapOrphanShadowForks(): { reaped: number } {
    let reaped = 0;
    for (const row of this.sandboxStore.listActive()) {
      let policy: Record<string, unknown> | undefined;
      try {
        policy = (JSON.parse(row.fork_base_json) as { policy?: Record<string, unknown> }).policy;
      } catch {
        continue; // unparseable lineage — not ours to reap
      }
      if (policy?.[SHADOW_FORK_POLICY_MARKER] !== true) continue;
      if (row.simulation_id !== null && this.registry.get(row.simulation_id) !== undefined) {
        continue; // a live shadow of this process
      }
      try {
        this.sandboxService.stop(row);
        reaped += 1;
      } catch (error) {
        logger.warn(`orphan shadow fork ${row.id} could not be stopped: ${(error as Error).message}`);
      }
    }
    if (reaped > 0) logger.info(`reaped ${reaped} orphan shadow fork row(s)`);
    return { reaped };
  }

  private ensureReconcileTimer(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  /** Reconcile every live shadow's subscriptions + self-heal dead forks. */
  private async reconcile(): Promise<void> {
    for (const entry of [...this.shadows.values()]) {
      if (!this.liveRecord(entry)) {
        this.teardownEntry(entry);
        continue;
      }
      await this.reconcileEntry(entry);
    }
  }

  /**
   * Reconcile one shadow's subscriptions with the env's current bound
   * devices (bindings may change while the shadow lives). Best effort — an
   * unreachable HA leaves the set empty; the next tick retries.
   */
  private async reconcileEntry(entry: ShadowEntry): Promise<void> {
    const wanted = new Map<string, string>(); // entityId → deviceId
    for (const { device, entityId } of this.boundDevicesOf(entry.envId)) {
      wanted.set(entityId, device.id);
    }
    for (const [entityId, unsubscribe] of [...entry.subscriptions]) {
      if (!wanted.has(entityId)) {
        unsubscribe();
        entry.subscriptions.delete(entityId);
      }
    }
    const missing = [...wanted.keys()].filter(entityId => !entry.subscriptions.has(entityId));
    if (missing.length === 0 || !this.hass.isConfigured()) return;
    let connection: HAWebSocketConnection;
    try {
      connection = await this.hass.ensureReady();
    } catch (error) {
      logger.warn(`shadow ${entry.envId}: HA unreachable (${(error as Error).message})`);
      return;
    }
    for (const entityId of missing) {
      if (!connection.getEntity(entityId)) {
        logger.warn(`shadow ${entry.envId}: bound entity "${entityId}" not found in Home Assistant`);
        continue;
      }
      const deviceId = wanted.get(entityId)!;
      entry.subscriptions.set(
        entityId,
        connection.onEntityState(entityId, state => this.onLiveState(entry, deviceId, entityId, state)),
      );
    }
  }

  /**
   * One pushed state → throttled observation write. Same TRAILING-EDGE
   * throttle shape as P1 live alignment: a push mid-interval schedules one
   * write for the interval end (latest state wins).
   */
  private onLiveState(
    entry: ShadowEntry,
    deviceId: string,
    entityId: string,
    _state: HassEntityState,
  ): void {
    void _state;
    // The binding may have been removed/changed since the subscription.
    const device = this.envStore.getDevice(deviceId);
    if (!device || device.binding !== `hass://${entityId}`) {
      entry.subscriptions.get(entityId)?.();
      entry.subscriptions.delete(entityId);
      return;
    }
    // Same gate as forward actuation + P1 reverse sync: E-stop freezes the
    // observation channel too (pushes dropped, not queued).
    if (this.gate.estopState().active) return;
    const now = Date.now();
    const last = entry.lastApplyAt.get(deviceId);
    if (last !== undefined && now - last < this.liveMinIntervalMs) {
      if (!entry.trailingTimers.has(deviceId)) {
        const timer = setTimeout(
          () => {
            entry.trailingTimers.delete(deviceId);
            this.applyObservation(entry, deviceId, entityId);
          },
          this.liveMinIntervalMs - (now - last),
        );
        timer.unref?.();
        entry.trailingTimers.set(deviceId, timer);
      }
      return;
    }
    this.applyObservation(entry, deviceId, entityId);
  }

  /** Queue one observation write (serialized per shadow — advanceTo is forward-only). */
  private applyObservation(entry: ShadowEntry, deviceId: string, entityId: string): void {
    if (this.gate.estopState().active) return; // re-check at fire time
    const device = this.envStore.getDevice(deviceId);
    if (!device || device.binding !== `hass://${entityId}`) return;
    const connection = this.hass.peekReadyConnection();
    if (!connection) return;
    const entity = connection.getEntity(entityId);
    if (!entity) return;
    const view = hassStateView(entity);
    const observedAtWallMs = Date.parse(entity.last_updated ?? entity.last_changed) || Date.now();
    const fieldParameter = fieldParameterOf(entityId, entity);
    entry.lastApplyAt.set(deviceId, Date.now());
    entry.applyQueue = entry.applyQueue
      .then(() => this.applyQueued(entry, device, entityId, view, observedAtWallMs, fieldParameter))
      .catch(error => {
        logger.warn(`shadow ${entry.envId}: observation write failed: ${(error as Error).message}`);
      });
  }

  /**
   * The observation write itself: advance the shadow's clock to the
   * observation's sim moment (model physics evolve BETWEEN observations),
   * read the model's prediction (the residual pair), then write the
   * observed truth — device state via the restore seam, plus the physical
   * field for sensor-class entities (so the next physics tick samples
   * reality).
   */
  private async applyQueued(
    entry: ShadowEntry,
    device: DeviceInstanceRow,
    entityId: string,
    view: Record<string, number | boolean | string>,
    observedAtWallMs: number,
    fieldParameter: string | undefined,
  ): Promise<void> {
    const record = this.liveRecord(entry);
    if (!record) {
      this.teardownEntry(entry);
      return;
    }
    const runtime = record.runtime;
    if (runtime.getState() !== 'running') {
      const target = entry.anchorSimSec + Math.max(0, (observedAtWallMs - entry.anchorWallMs) / 1000);
      if (target > runtime.getSimTimeSec() + 1e-9) {
        await runtime.advanceTo(target);
      }
    }
    // Residual: the model's prediction BEFORE the write vs the observation.
    const predicted = runtime.getSnapshot().devices.find(d => d.id === device.id)?.state;
    const changes: HassShadowObservation['changes'] = [];
    for (const [key, observed] of Object.entries(view)) {
      const before = predicted?.[key];
      if (!scalarEqual(before, observed)) {
        changes.push({ key, predicted: before ?? null, observed });
      }
    }
    // Device-state half: merge the observed keys onto the shadow device's
    // current state via the checkpoint restore seam (restoreState — silent:
    // no events, no timeline rows, no agent fanout). The raw ref was kept
    // by the deviceFactory at fork build.
    const raw = entry.rawDevices.get(device.id);
    if (typeof raw?.restoreState === 'function') {
      raw.restoreState({ ...raw.getState(), ...view });
    }
    // Field half: sensor-class entities also drive the physical field of
    // their zone through the EXISTING boundary-condition channel
    // (EngineRuntime.updateZoneBaseline — the same channel weather feeds
    // and twin-sync use; bounded zones get baseline + a current-value point
    // write). Reality is a boundary condition the shadow absorbs, never an
    // injectEvent (no flow triggers, no agent fanout).
    if (fieldParameter !== undefined && typeof view.state === 'number' && device.zone_id !== null) {
      runtime.updateZoneBaseline(device.zone_id, fieldParameter, view.state);
    }
    entry.observationCount += 1;
    entry.observationsByDevice.set(device.id, (entry.observationsByDevice.get(device.id) ?? 0) + 1);
    entry.lastObservationAt = new Date().toISOString();
    entry.recent.unshift({
      id: randomUUID(),
      at: entry.lastObservationAt,
      deviceId: device.id,
      deviceName: device.name,
      entityId,
      simTimeSec: runtime.getSimTimeSec(),
      changes,
    });
    if (entry.recent.length > this.recentLimit) entry.recent.length = this.recentLimit;
  }

  /** Server shutdown hook: subscriptions + timers only (forks die with the process). */
  close(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    for (const entry of [...this.shadows.values()]) this.teardownEntry(entry);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private statusOf(entry: ShadowEntry): HassShadowStatus {
    const record = this.liveRecord(entry);
    const hassStatus = this.hass.status();
    const bound = this.boundDevicesOf(entry.envId);
    return {
      envId: entry.envId,
      sandboxId: entry.sandboxId,
      simulationId: entry.simulationId,
      state: record?.runtime.getState() ?? 'gone',
      simTimeSec: record?.runtime.getSimTimeSec() ?? entry.anchorSimSec,
      fromCheckpoint: entry.fromCheckpoint,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt,
      anchor: { wallMs: entry.anchorWallMs, simTimeSec: entry.anchorSimSec },
      estopActive: this.gate.estopState().active,
      hass: { configured: hassStatus.configured, state: hassStatus.state },
      boundDevices: bound.map(({ device, entityId }) => ({
        deviceId: device.id,
        deviceName: device.name,
        entityId,
        observations: entry.observationsByDevice.get(device.id) ?? 0,
        discardedCommands: entry.discardsByDevice.get(device.id) ?? 0,
      })),
      observationCount: entry.observationCount,
      discardedCommandCount: [...entry.discardsByDevice.values()].reduce((sum, n) => sum + n, 0),
      lastObservationAt: entry.lastObservationAt,
      recentObservations: [...entry.recent],
    };
  }

  /** The env's hass://-bound device rows, with entity ids. */
  private boundDevicesOf(envId: string): { device: DeviceInstanceRow; entityId: string }[] {
    return this.envStore
      .devicesOf(envId)
      .filter(device => device.binding?.startsWith('hass://'))
      .map(device => ({ device, entityId: device.binding!.slice('hass://'.length) }));
  }
}

// ---------------------------------------------------------------------------
// Actuation discard (shadow safety, observability half)
// ---------------------------------------------------------------------------

/**
 * Wrap a shadow fork's formerly-hass-bound device so EVERY actuation path
 * (agent coordinator, HTTP commands route, what-if, flows — they all
 * converge on device.executeCommand) is discarded and counted. Mirrors the
 * DeviceFaultSeam contract: the error is THROWN so the coordinator's catch
 * path reports `{ success: false, error }` — explicit failure, never a
 * silent success (the entity-map discipline). The REAL safety invariant is
 * upstream: the fork scenario carries no hass:// binding at all.
 */
export function shadowDiscardProxy(device: RuntimeDevice, onDiscard: () => void): RuntimeDevice {
  return new Proxy(device, {
    get(target, prop, _receiver) {
      if (prop === 'executeCommand') {
        return (commandName: string) => {
          onDiscard();
          return Promise.reject(new Error(
            `shadow world: actuation "${commandName}" on a hass-bound device was discarded — ` +
            'a shadow is an observation-only fork (use sim:// devices to test actuation policies)',
          ));
        };
      }
      // Bind methods to the RAW target so private state and internal
      // `this` calls never see the Proxy (the fault-seam pattern).
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RuntimeDevice;
}

/** sensor-class entity → the physical-field parameter its reading drives. */
function fieldParameterOf(entityId: string, entity: HassEntityState | undefined): string | undefined {
  const domain = entityId.slice(0, entityId.indexOf('.'));
  if (domain !== 'sensor' && domain !== 'binary_sensor') return undefined;
  const deviceClass = entity?.attributes.device_class;
  return typeof deviceClass === 'string'
    ? DEVICE_CLASS_FIELD_PARAMETERS[deviceClass]
    : undefined;
}

/** Residual comparison: numbers compare with a small epsilon (HA float noise). */
function scalarEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return a === b;
}
