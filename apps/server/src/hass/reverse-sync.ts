/**
 * HassReverseSyncService — HIL reverse mapping P1: snapshot alignment
 * (design-hil-reverse-mapping.md §2-P1)
 *
 * Reality → simulation backflow for devices bound to real Home Assistant
 * entities (`device_instances.binding = 'hass://<entity-id>'`). The HA state
 * is treated as the device's PHYSICAL TRUTH SOURCE; alignment writes it into
 * the environment base layer (the device row's stored state — the same truth
 * twin-sync maintains and environmentToScenario feeds to new sims as their
 * initial state). Running simulations are deliberately NOT retro-patched
 * (原则 A: the aligned value is the boundary condition the NEXT sim/sandbox
 * fork starts from).
 *
 * Alignment policy (singleton row, hass_reverse_sync_state):
 * - `disabled` — no subscriptions, align-now rejected (409);
 * - `manual`   — (DEFAULT, safe) alignment only on an explicit API trigger;
 * - `live`     — state_changed pushes on bound entities align the device
 *                (per-device throttle, `liveMinIntervalMs`).
 *
 * Every alignment WRITE goes through the world-mutation channel and lands in
 * command_log as kind 'hass-reverse-sync' with the drift it applied
 * ({deviceId, entityId, trigger, changes:[{key,before,after}]}) — the drift
 * record is the raw material the P3 calibration loop will consume. GET
 * status additionally reports the CURRENT drift (stored sim value vs live
 * hass value) without writing anything.
 *
 * Safety interlock: the SAME emergency stop as forward actuation — while
 * the P3b E-stop is engaged, live alignment skips every write and align-now
 * fails 409 ESTOP_ACTIVE.
 *
 * Privacy (原则 B): status/drift/alignment views and manual align-now are
 * scoped by the device-privacy FULL tier (admin / env owner / device
 * owner — deviceDetailTier, the single truth): telemetry and entity ids
 * never leak to other members or public-env visitors. Live (system)
 * alignment covers every bound device and broadcasts exactly like twin-sync
 * (system-driven frame, no actor).
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@active-collaboration/shared';

import type { ChangePipeline } from '../change-pipeline.js';
import type { EafDatabase } from '../db/database.js';
import {
  parseJsonObject,
  type DeviceInstanceRow,
  type EnvironmentStore,
} from '../db/environment-store.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { deviceDetailTier } from '../device-privacy.js';
import { deviceToJson, ownerRef } from '../env-serializers.js';
import { ApiError } from '../errors.js';
import type { WorldSync } from '../world-sync.js';
import type { HAWebSocketConnection, HassEntityState } from './connection.js';
import type { HassSafetyGate } from './safety-gate.js';
import type { HASService } from './service.js';

const logger = createLogger('HassReverseSyncService');

export const REVERSE_SYNC_POLICIES = ['disabled', 'manual', 'live'] as const;
export type ReverseSyncPolicy = (typeof REVERSE_SYNC_POLICIES)[number];

export const REVERSE_SYNC_COMMAND_KIND = 'hass-reverse-sync';
/** command_log actor for system-driven (live) alignment writes. */
export const REVERSE_SYNC_SYSTEM_ACTOR = 'hass-reverse-sync';

/** command_log payload change entry + status drift entry share this shape. */
export interface ReverseSyncChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface ReverseSyncAlignment {
  id: string;
  at: string;
  trigger: 'manual' | 'live';
  actorId: string;
  envId: string;
  deviceId: string;
  entityId: string;
  changes: ReverseSyncChange[];
}

export interface ReverseSyncDriftEntry {
  envId: string;
  deviceId: string;
  deviceName: string;
  entityId: string;
  key: string;
  simValue: unknown;
  hassValue: unknown;
}

export interface ReverseSyncStatus {
  policy: ReverseSyncPolicy;
  estopActive: boolean;
  hass: { configured: boolean; state: string };
  /** Bound (hass://) devices in the caller's visible environments. */
  boundDevices: number;
  /** Current drift (no write), visible envs only. */
  drift: ReverseSyncDriftEntry[];
  /** Newest first, visible envs only (in-memory ring of this process). */
  recentAlignments: ReverseSyncAlignment[];
}

export interface ReverseSyncAlignResult {
  trigger: 'manual' | 'live';
  /** Devices whose stored state changed. */
  alignedDevices: number;
  /** Bound devices already matching reality. */
  unchangedDevices: number;
  alignments: ReverseSyncAlignment[];
}

interface HassReverseSyncServiceDeps {
  db: EafDatabase;
  hass: HASService;
  gate: HassSafetyGate;
  envStore: EnvironmentStore;
  userStore: UserStore;
  worldSync: WorldSync;
  /** command_log audit tail; optional so bare/test contexts still align. */
  pipeline?: ChangePipeline;
  /** Per-device minimum interval between LIVE alignment writes (def. 1s). */
  liveMinIntervalMs?: number;
  /** Subscription reconcile cadence while policy is 'live' (def. 15s). */
  reconcileIntervalMs?: number;
  /** In-memory recent-alignment ring size (def. 20). */
  recentLimit?: number;
}

interface ReverseSyncStateRow {
  id: number;
  policy: ReverseSyncPolicy;
  updated_by: string | null;
  updated_at: string | null;
}

/** HA attribute keys that are entity metadata, never physical state. */
const NON_STATE_ATTRIBUTES = new Set(['friendly_name']);

export class HassReverseSyncService {
  private readonly db: EafDatabase;
  private readonly hass: HASService;
  private readonly gate: HassSafetyGate;
  private readonly envStore: EnvironmentStore;
  private readonly userStore: UserStore;
  private readonly worldSync: WorldSync;
  private readonly pipeline?: ChangePipeline;
  private readonly liveMinIntervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly recentLimit: number;

  /** entityId → unsubscribe (live policy only). */
  private readonly subscriptions = new Map<string, () => void>();
  /** deviceId → wall-ms of the last LIVE alignment write (throttle). */
  private readonly lastLiveAlignAt = new Map<string, number>();
  /** deviceId → trailing-edge timer for a push that arrived mid-throttle. */
  private readonly liveTrailingTimers = new Map<string, NodeJS.Timeout>();
  private readonly recent: ReverseSyncAlignment[] = [];
  private reconcileTimer?: NodeJS.Timeout;

  constructor(deps: HassReverseSyncServiceDeps) {
    this.db = deps.db;
    this.hass = deps.hass;
    this.gate = deps.gate;
    this.envStore = deps.envStore;
    this.userStore = deps.userStore;
    this.worldSync = deps.worldSync;
    this.pipeline = deps.pipeline;
    this.liveMinIntervalMs = deps.liveMinIntervalMs ?? 1_000;
    this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 15_000;
    this.recentLimit = deps.recentLimit ?? 20;
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  getPolicy(): ReverseSyncPolicy {
    const row = this.db
      .prepare('SELECT policy FROM hass_reverse_sync_state WHERE id = 1')
      .get() as { policy: ReverseSyncPolicy } | undefined;
    return row?.policy ?? 'manual';
  }

  /**
   * Persist a new policy and (un)start the live machinery to match.
   * The caller (route) enforces admin-only writes.
   */
  setPolicy(policy: ReverseSyncPolicy, userId: string): ReverseSyncPolicy {
    this.db
      .prepare('UPDATE hass_reverse_sync_state SET policy = ?, updated_by = ?, updated_at = ? WHERE id = 1')
      .run(policy, userId, new Date().toISOString());
    if (policy === 'live') {
      this.startLive();
    } else {
      this.stopLive();
    }
    return policy;
  }

  // -------------------------------------------------------------------------
  // Status / drift
  // -------------------------------------------------------------------------

  /**
   * Error-tolerant status for GET /api/hass/reverse-sync: reports (never
   * throws on) an unconfigured/unreachable HA — drift is simply empty then.
   * Device visibility follows the device-privacy FULL tier (原则 B: admin /
   * env owner / device owner) — telemetry and entity ids never leak to
   * other members or public-env visitors.
   */
  async statusFor(userId: string, isAdmin = false): Promise<ReverseSyncStatus> {
    const bound = this.boundDevices().filter(entry =>
      this.fullTier(entry.device, userId, isAdmin),
    );
    const hassStatus = this.hass.status();
    return {
      policy: this.getPolicy(),
      estopActive: this.gate.estopState().active,
      hass: { configured: hassStatus.configured, state: hassStatus.state },
      boundDevices: bound.length,
      drift: await this.computeDrift(bound),
      recentAlignments: this.recent.filter(a =>
        this.alignmentVisible(a, userId, isAdmin),
      ),
    };
  }

  /** Recent-alignment visibility: same full-tier rule, per recorded device. */
  private alignmentVisible(
    alignment: ReverseSyncAlignment,
    userId: string,
    isAdmin: boolean,
  ): boolean {
    const device = this.envStore.getDevice(alignment.deviceId);
    if (device) return this.fullTier(device, userId, isAdmin);
    // Deleted device: only the env owner / an admin still sees its history.
    if (isAdmin) return true;
    const env = this.envStore.getEnvironment(alignment.envId);
    return env?.owner_id === userId;
  }

  /**
   * Current drift for the given bound devices: stored sim value vs live hass
   * value per state key. Best effort — an unreachable HA yields no drift
   * (the status route reports the connection state alongside).
   */
  private async computeDrift(
    bound: { device: DeviceInstanceRow; entityId: string }[],
  ): Promise<ReverseSyncDriftEntry[]> {
    if (bound.length === 0 || !this.hass.isConfigured()) return [];
    let connection: HAWebSocketConnection;
    try {
      connection = await this.hass.ensureReady();
    } catch {
      return []; // unreachable — status.hass.state says so
    }
    const drift: ReverseSyncDriftEntry[] = [];
    for (const { device, entityId } of bound) {
      const entity = connection.getEntity(entityId);
      if (!entity) continue;
      const stored = parseJsonObject(device.initial_state_json) ?? {};
      for (const [key, hassValue] of Object.entries(hassStateView(entity))) {
        const simValue = stored[key];
        if (!scalarEqual(simValue, hassValue)) {
          drift.push({
            envId: device.env_id,
            deviceId: device.id,
            deviceName: device.name,
            entityId,
            key,
            simValue: simValue ?? null,
            hassValue,
          });
        }
      }
    }
    return drift;
  }

  // -------------------------------------------------------------------------
  // Alignment
  // -------------------------------------------------------------------------

  /**
   * Manual snapshot alignment (POST align-now): aligns every hass://-bound
   * device the caller holds the FULL privacy tier on (device owner / env
   * owner / admin). Policy 'disabled' rejects (409); an engaged E-stop
   * rejects (409) — the reverse channel rides the same gate as forward
   * actuation.
   */
  async alignNow(userId: string, isAdmin = false): Promise<ReverseSyncAlignResult> {
    if (this.getPolicy() === 'disabled') {
      throw new ApiError(
        409,
        'REVERSE_SYNC_DISABLED',
        'Reverse sync is disabled — set the policy to "manual" or "live" first',
      );
    }
    if (this.gate.estopState().active) {
      throw new ApiError(
        409,
        'ESTOP_ACTIVE',
        'Reverse sync blocked: emergency stop active',
      );
    }
    const bound = this.boundDevices().filter(entry =>
      this.fullTier(entry.device, userId, isAdmin),
    );
    const connection = await this.hass.ensureReady(); // 503s when unconfigured/unreachable
    return this.alignDevices(bound, connection, 'manual', userId);
  }

  /**
   * The shared alignment write path (manual trigger + live pushes). For each
   * device: diff stored state vs the live entity view; when anything drifted,
   * merge the hass view into the stored state (last-write-wins), broadcast
   * the device update, and audit ONE command_log row carrying the applied
   * drift. No drift → no write, no log row.
   */
  private alignDevices(
    bound: { device: DeviceInstanceRow; entityId: string }[],
    connection: HAWebSocketConnection,
    trigger: 'manual' | 'live',
    actorId: string,
  ): ReverseSyncAlignResult {
    const alignments: ReverseSyncAlignment[] = [];
    let unchanged = 0;

    for (const { device, entityId } of bound) {
      const entity = connection.getEntity(entityId);
      if (!entity) {
        unchanged += 1; // unknown entity — nothing to align from
        continue;
      }
      const view = hassStateView(entity);
      const stored = parseJsonObject(device.initial_state_json) ?? {};
      const changes: ReverseSyncChange[] = [];
      for (const [key, after] of Object.entries(view)) {
        const before = stored[key];
        if (!scalarEqual(before, after)) {
          changes.push({ key, before: before ?? null, after });
        }
      }
      if (changes.length === 0) {
        unchanged += 1;
        continue;
      }

      const next = { ...stored, ...view };
      const row = this.envStore.updateDevice(device.id, { initialState: next });
      const alignment: ReverseSyncAlignment = {
        id: randomUUID(),
        at: new Date().toISOString(),
        trigger,
        actorId,
        envId: device.env_id,
        deviceId: device.id,
        entityId,
        changes,
      };
      this.publishAligned(row, trigger, actorId);
      this.audit(alignment);
      this.remember(alignment);
      alignments.push(alignment);
    }

    return {
      trigger,
      alignedDevices: alignments.length,
      unchangedDevices: unchanged,
      alignments,
    };
  }

  /** world-sync broadcast: user-attributed for manual, system frame for live. */
  private publishAligned(row: DeviceInstanceRow, trigger: 'manual' | 'live', actorId: string): void {
    const json = deviceToJson(row, this.ownerRefFor(row.owner_id));
    if (trigger === 'manual' && this.pipeline) {
      this.pipeline.publish(row.env_id, 'updated', 'device', json, actorId);
    } else {
      // Same shape as twin-sync's system-driven write (no actor).
      this.worldSync.publish(row.env_id, 'updated', 'device', json);
    }
  }

  /** command_log audit — one row per aligned device, drift in the payload. */
  private audit(alignment: ReverseSyncAlignment): void {
    if (!this.pipeline) return;
    try {
      this.pipeline.log({
        envId: alignment.envId,
        actorId: alignment.actorId,
        kind: REVERSE_SYNC_COMMAND_KIND,
        payload: {
          deviceId: alignment.deviceId,
          entityId: alignment.entityId,
          trigger: alignment.trigger,
          changes: alignment.changes,
        },
        simTime: null,
      });
    } catch (error) {
      // The audit tail must never break the alignment write itself.
      logger.warn(`reverse-sync audit failed for device ${alignment.deviceId}: ${(error as Error).message}`);
    }
  }

  private remember(alignment: ReverseSyncAlignment): void {
    this.recent.unshift(alignment);
    if (this.recent.length > this.recentLimit) this.recent.length = this.recentLimit;
  }

  // -------------------------------------------------------------------------
  // Live mode (state_changed → align)
  // -------------------------------------------------------------------------

  /** Server boot hook: start live subscriptions when the stored policy says so. */
  start(): void {
    if (this.getPolicy() === 'live') this.startLive();
  }

  private startLive(): void {
    void this.reconcile();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
  }

  private stopLive(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    for (const timer of this.liveTrailingTimers.values()) clearTimeout(timer);
    this.liveTrailingTimers.clear();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.lastLiveAlignAt.clear();
  }

  /**
   * Reconcile subscriptions with the current bound-device set: subscribe new
   * entities, drop entities no longer bound. Best effort — an unreachable HA
   * leaves the set empty; the next tick retries.
   */
  private async reconcile(): Promise<void> {
    const wanted = new Map<string, string>(); // entityId → deviceId
    for (const { device, entityId } of this.boundDevices()) {
      wanted.set(entityId, device.id);
    }
    for (const [entityId, unsubscribe] of [...this.subscriptions]) {
      if (!wanted.has(entityId)) {
        unsubscribe();
        this.subscriptions.delete(entityId);
      }
    }
    const missing = [...wanted.keys()].filter(entityId => !this.subscriptions.has(entityId));
    if (missing.length === 0 || !this.hass.isConfigured()) return;
    let connection: HAWebSocketConnection;
    try {
      connection = await this.hass.ensureReady();
    } catch (error) {
      logger.warn(`reverse-sync live reconcile: HA unreachable (${(error as Error).message})`);
      return;
    }
    for (const entityId of missing) {
      if (!connection.getEntity(entityId)) {
        logger.warn(`reverse-sync: bound entity "${entityId}" not found in Home Assistant`);
        continue;
      }
      const deviceId = wanted.get(entityId)!;
      this.subscriptions.set(
        entityId,
        connection.onEntityState(entityId, state => this.onLiveState(deviceId, entityId, state)),
      );
    }
  }

  /**
   * One pushed state → throttled live alignment of the bound device. The
   * throttle is TRAILING-EDGE: a push that arrives mid-interval schedules
   * one alignment for the interval end (latest state wins — a leading-edge
   * drop could pin the sim to a stale value for the whole storm).
   */
  private onLiveState(deviceId: string, entityId: string, _state: HassEntityState): void {
    void _state;
    // The binding may have been removed/changed since the subscription.
    const device = this.envStore.getDevice(deviceId);
    if (!device || device.binding !== `hass://${entityId}`) {
      this.subscriptions.get(entityId)?.();
      this.subscriptions.delete(entityId);
      return;
    }
    // Same gate as forward actuation: E-stop freezes the reverse channel too.
    if (this.gate.estopState().active) return;
    const now = Date.now();
    const last = this.lastLiveAlignAt.get(deviceId);
    if (last !== undefined && now - last < this.liveMinIntervalMs) {
      if (!this.liveTrailingTimers.has(deviceId)) {
        const timer = setTimeout(
          () => {
            this.liveTrailingTimers.delete(deviceId);
            this.liveAlign(deviceId, entityId);
          },
          this.liveMinIntervalMs - (now - last),
        );
        timer.unref?.();
        this.liveTrailingTimers.set(deviceId, timer);
      }
      return;
    }
    this.liveAlign(deviceId, entityId);
  }

  /** The actual live alignment attempt (immediate or trailing-edge). */
  private liveAlign(deviceId: string, entityId: string): void {
    if (this.gate.estopState().active) return; // re-check at fire time
    const device = this.envStore.getDevice(deviceId);
    if (!device || device.binding !== `hass://${entityId}`) return;
    const connection = this.hassConnection();
    if (!connection) return;
    const result = this.alignDevices(
      [{ device, entityId }],
      connection,
      'live',
      REVERSE_SYNC_SYSTEM_ACTOR,
    );
    if (result.alignedDevices > 0) this.lastLiveAlignAt.set(deviceId, Date.now());
  }

  /** The shared connection when it is already ready (live pushes never connect). */
  private hassConnection(): HAWebSocketConnection | undefined {
    return this.hass.peekReadyConnection();
  }

  /** Server shutdown hook. */
  close(): void {
    this.stopLive();
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Every hass://-bound device row, server-wide, with its entity id. */
  private boundDevices(): { device: DeviceInstanceRow; entityId: string }[] {
    const rows = this.db
      .prepare(`SELECT * FROM device_instances WHERE binding LIKE 'hass://%'`)
      .all() as DeviceInstanceRow[];
    return rows.map(device => ({ device, entityId: device.binding!.slice('hass://'.length) }));
  }

  /**
   * The device-privacy FULL tier for one device row: admin, the environment
   * owner, or the device owner (deviceDetailTier — the single truth).
   */
  private fullTier(device: DeviceInstanceRow, userId: string, isAdmin: boolean): boolean {
    const env = this.envStore.getEnvironment(device.env_id);
    return deviceDetailTier(
      { userId, isAdmin },
      { ownerId: device.owner_id, envOwnerId: env?.owner_id ?? null },
    ) === 'full';
  }

  private ownerRefFor(userId: string) {
    const user = this.userStore.findById(userId);
    return ownerRef(user ? toPublicUser(user) : undefined, userId);
  }
}

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

/**
 * The physical-state view of one HA entity: scalar attributes (minus entity
 * metadata like friendly_name) plus the main `state` (numeric-coerced, the
 * same coercion twin-sync applies to sensor readings) and a derived `power`
 * boolean. Lists/maps (hvac_modes, presets) are NOT physical state and stay
 * out of the aligned snapshot.
 */
export function hassStateView(entity: HassEntityState): Record<string, number | boolean | string> {
  const view: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(entity.attributes)) {
    if (NON_STATE_ATTRIBUTES.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) view[key] = value;
    else if (typeof value === 'boolean') view[key] = value;
    else if (typeof value === 'string') view[key] = value;
  }
  const raw = entity.state;
  const numeric = Number(raw);
  view.state = raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw;
  view.power = raw === 'on';
  return view;
}

/** Drift comparison: numbers compare with a small epsilon (HA float noise). */
function scalarEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return a === b;
}
