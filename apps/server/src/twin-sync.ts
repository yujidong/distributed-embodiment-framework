/**
 * TwinSyncService — real-world perception → base layer sync pipeline (P-D,
 * multi-user-simulation-design.md §2 principle 2, §6, §11)
 *
 * Data sources:
 * - `hass:<entity_id>` — a subscription on the shared HA connection's live
 *   entity cache (hass/connection.ts `onEntityState`); state_changed pushes
 *   become observations.
 * - `manual` — external campus systems (weather, schedules…) POST values
 *   through `POST /api/environments/:id/observations`.
 *
 * Write semantics (§6 drift handling — synced values WIN):
 * - EVERY observation is appended to the `observations` time series
 *   (throttling never drops rows — replay needs full resolution);
 * - at most once per binding.min_interval_sec, the value is also applied to
 *   the device instance row — the observed attribute is merged into its
 *   stored state (last-write-wins) and broadcast on the environment's
 *   world-sync channel as a device `updated` message. Running simulations
 *   are NOT retro-patched; the synced state is the boundary condition the
 *   NEXT sim/sandbox fork starts from (§3: the base layer is the mirror of
 *   truth, sims snapshot it).
 *
 * Safety boundary (§2: 仿真 → 现实永远过闸): this pipeline only ever writes
 * sensory attributes. Bindings are validated against the device instance's
 * capabilities with the core loader's classifyCapability — the attribute key
 * must correspond to a read-class (monitoring/reading) capability, so no
 * actuator control attribute is reachable through sync.
 *
 * Unavailable HA: a `hass:` binding on a server without a reachable HA
 * connection is CREATED but flipped to status 'unavailable' — never a crash,
 * never a rejected binding (§11 P-D acceptance).
 */

import { classifyCapability } from '@active-collaboration/core';
import { createLogger } from '@active-collaboration/shared';

import { ApiError } from './errors.js';
import { deviceToJson, ownerRef } from './env-serializers.js';
import {
  parseJsonArray,
  parseJsonObject,
  type DeviceInstanceRow,
  type EnvironmentStore,
} from './db/environment-store.js';
import {
  DEFAULT_MIN_INTERVAL_SEC,
  type ObservationRow,
  type ObservationStore,
  type SyncBindingInput,
  type SyncBindingRow,
  type SyncBindingStore,
} from './db/sync-store.js';
import { toPublicUser, type UserStore } from './db/user-store.js';
import type { HASService } from './hass/service.js';
import type { HassEntityState } from './hass/connection.js';
import type { WorldSync } from './world-sync.js';

const logger = createLogger('TwinSyncService');

/** Observation values are JSON scalars — numbers, booleans, strings. */
export type ObservationValue = number | boolean | string;

export interface TwinSyncServiceDeps {
  envStore: EnvironmentStore;
  observationStore: ObservationStore;
  syncBindingStore: SyncBindingStore;
  userStore: UserStore;
  worldSync: WorldSync;
  hass: HASService;
}

export interface IngestResult {
  observation: ObservationRow;
  /** True when the value was also applied to the device row + broadcast. */
  applied: boolean;
}

export const HASS_SOURCE_PATTERN = /^hass:[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

export function isHassSource(source: string): boolean {
  return HASS_SOURCE_PATTERN.test(source);
}

export class TwinSyncService {
  private readonly envStore: EnvironmentStore;
  private readonly observationStore: ObservationStore;
  private readonly syncBindingStore: SyncBindingStore;
  private readonly userStore: UserStore;
  private readonly worldSync: WorldSync;
  private readonly hass: HASService;

  /** bindingId → unsubscribe from the HA entity cache. */
  private readonly hassSubscriptions = new Map<string, () => void>();
  /** bindingId → wall-ms of the last APPLIED observation (throttle). */
  private readonly lastAppliedAt = new Map<string, number>();

  /** Injectable clock (ms epoch) — tests override it to exercise throttling. */
  public now: () => number = () => Date.now();

  constructor(deps: TwinSyncServiceDeps) {
    this.envStore = deps.envStore;
    this.observationStore = deps.observationStore;
    this.syncBindingStore = deps.syncBindingStore;
    this.userStore = deps.userStore;
    this.worldSync = deps.worldSync;
    this.hass = deps.hass;
  }

  // -------------------------------------------------------------------------
  // Bindings
  // -------------------------------------------------------------------------

  /**
   * Replace an environment's whole binding set (PUT semantics). Validates
   * every entry first — one bad entry rejects the whole set, nothing is
   * written. hass: bindings are activated before returning so the response
   * reflects their final status.
   */
  async replaceBindings(
    envId: string,
    createdBy: string,
    inputs: SyncBindingInput[],
  ): Promise<SyncBindingRow[]> {
    const seen = new Set<string>();
    for (const input of inputs) {
      const device = this.envStore.getDevice(input.deviceInstanceId);
      if (!device || device.env_id !== envId) {
        throw new ApiError(
          404,
          'DEVICE_NOT_FOUND',
          `Device "${input.deviceInstanceId}" does not exist in environment "${envId}"`,
        );
      }
      assertSensoryAttribute(device, input.attributeKey);
      const dedupeKey = `${input.deviceInstanceId}${input.attributeKey}`;
      if (seen.has(dedupeKey)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Duplicate binding for device "${input.deviceInstanceId}" attribute "${input.attributeKey}"`,
        );
      }
      seen.add(dedupeKey);
    }

    this.deactivateForEnv(envId);
    const rows = this.syncBindingStore.replaceForEnv(envId, createdBy, inputs);
    for (const row of rows) {
      if (isHassSource(row.source)) {
        await this.activate(row);
      }
    }
    return rows.map(row => this.syncBindingStore.get(row.id) ?? row);
  }

  listBindings(envId: string): SyncBindingRow[] {
    return this.syncBindingStore.listForEnv(envId);
  }

  /** Server boot: re-activate every stored hass: binding (best effort). */
  async activateAllStored(): Promise<void> {
    for (const binding of this.syncBindingStore.listHassBindings()) {
      await this.activate(binding);
    }
  }

  // -------------------------------------------------------------------------
  // Observation ingestion
  // -------------------------------------------------------------------------

  /**
   * Manual push path (POST route): the binding must exist and be 'manual' —
   * the binding is what declares the attribute pushable at all.
   */
  ingestManual(
    envId: string,
    deviceInstanceId: string,
    attributeKey: string,
    value: ObservationValue,
    simTime?: number | null,
  ): IngestResult {
    const binding = this.syncBindingStore.findFor(envId, deviceInstanceId, attributeKey);
    if (!binding || binding.source !== 'manual') {
      throw new ApiError(
        404,
        'SYNC_BINDING_NOT_FOUND',
        `No manual sync binding for device "${deviceInstanceId}" attribute "${attributeKey}" ` +
          `in environment "${envId}"`,
      );
    }
    return this.recordObservation(binding, value, simTime ?? null);
  }

  /**
   * Core write path: the observation ALWAYS lands in the time series; the
   * device-row update + broadcast is throttled to one per min_interval_sec.
   */
  recordObservation(
    binding: SyncBindingRow,
    value: ObservationValue,
    simTime: number | null = null,
  ): IngestResult {
    const observation = this.observationStore.append({
      envId: binding.env_id,
      entityId: binding.device_instance_id,
      key: binding.attribute_key,
      value,
      simTime,
    });

    const nowMs = this.now();
    const last = this.lastAppliedAt.get(binding.id);
    const intervalMs = Math.max(0, binding.min_interval_sec) * 1000;
    if (last !== undefined && nowMs - last < intervalMs) {
      return { observation, applied: false };
    }

    if (this.applyToDevice(binding, value)) {
      this.lastAppliedAt.set(binding.id, nowMs);
      return { observation, applied: true };
    }
    return { observation, applied: false };
  }

  // -------------------------------------------------------------------------
  // hass: subscription lifecycle
  // -------------------------------------------------------------------------

  /**
   * Best-effort activation of one hass: binding. Any failure (HA not
   * configured, connect failed, unknown entity) flips the binding to
   * 'unavailable' — it is never thrown, never crashes the pipeline.
   */
  private async activate(binding: SyncBindingRow): Promise<void> {
    if (!this.hass.isConfigured()) {
      this.syncBindingStore.setStatus(binding.id, 'unavailable');
      return;
    }
    const entityId = binding.source.slice('hass:'.length);
    try {
      const connection = await this.hass.ensureReady();
      if (!connection.getEntity(entityId)) {
        logger.warn(
          `Sync binding ${binding.id}: hass entity "${entityId}" not found — marked unavailable`,
        );
        this.syncBindingStore.setStatus(binding.id, 'unavailable');
        return;
      }
      const unsubscribe = connection.onEntityState(entityId, state =>
        this.onHassState(binding, state),
      );
      this.hassSubscriptions.set(binding.id, unsubscribe);
      this.syncBindingStore.setStatus(binding.id, 'active');
    } catch (error) {
      logger.warn(`Sync binding ${binding.id} unavailable: ${(error as Error).message}`);
      this.syncBindingStore.setStatus(binding.id, 'unavailable');
    }
  }

  /** One HA state_changed push → observation (value extraction + ingest). */
  private onHassState(binding: SyncBindingRow, state: HassEntityState): void {
    // The binding may have been replaced while a subscription was in flight.
    if (this.syncBindingStore.get(binding.id) === undefined) {
      this.hassSubscriptions.get(binding.id)?.();
      this.hassSubscriptions.delete(binding.id);
      return;
    }
    const value = extractHassValue(state, binding.attribute_key);
    if (value === undefined) return; // attribute absent from this update
    try {
      this.recordObservation(binding, value);
    } catch (error) {
      logger.warn(`Sync observation failed for binding ${binding.id}: ${(error as Error).message}`);
    }
  }

  /** Unsubscribe every hass: binding of one environment (replace/delete). */
  deactivateForEnv(envId: string): void {
    for (const binding of this.syncBindingStore.listForEnv(envId)) {
      this.hassSubscriptions.get(binding.id)?.();
      this.hassSubscriptions.delete(binding.id);
      this.lastAppliedAt.delete(binding.id);
    }
  }

  /** Server shutdown: drop every subscription (the HA connection closes too). */
  close(): void {
    for (const unsubscribe of this.hassSubscriptions.values()) {
      unsubscribe();
    }
    this.hassSubscriptions.clear();
    this.lastAppliedAt.clear();
  }

  // -------------------------------------------------------------------------
  // State application
  // -------------------------------------------------------------------------

  /**
   * Merge the observed value into the device row's stored state and
   * broadcast the update. The environment's device state is the base layer's
   * current truth: environmentToScenario feeds it to new sims as their
   * initial state, so a synced value becomes the boundary condition the next
   * fork starts from. Returns false when the device row is gone.
   */
  private applyToDevice(binding: SyncBindingRow, value: ObservationValue): boolean {
    const device = this.envStore.getDevice(binding.device_instance_id);
    if (!device) return false;
    const state = parseJsonObject(device.initial_state_json) ?? {};
    state[binding.attribute_key] = value;
    const row = this.envStore.updateDevice(device.id, { initialState: state });
    this.worldSync.publish(
      binding.env_id,
      'updated',
      'device',
      deviceToJson(row, this.ownerRefFor(row.owner_id)),
    );
    return true;
  }

  private ownerRefFor(userId: string) {
    const user = this.userStore.findById(userId);
    return ownerRef(user ? toPublicUser(user) : undefined, userId);
  }
}

// ---------------------------------------------------------------------------
// Validation + value extraction
// ---------------------------------------------------------------------------

/**
 * Safety boundary: the attribute must be backed by a READ-class capability
 * of the device instance (classifyCapability — the same heuristic the
 * scenario loader uses to infer sensor roles). Matching: the capability name
 * contains the attribute key, or the key contains the capability's stem
 * (name minus its reading/sensing/monitoring/detection suffix), so
 * 'temperature' matches 'temperature-reading' but not 'temperature-control'.
 */
export function assertSensoryAttribute(device: DeviceInstanceRow, attributeKey: string): void {
  const key = attributeKey.toLowerCase();
  const readCapabilities = parseJsonArray<string>(device.capabilities_json).filter(
    capability => classifyCapability(capability) === 'read',
  );
  const matches = readCapabilities.some(capability => {
    const lower = capability.toLowerCase();
    const stem = lower.replace(/-(reading|sensing|monitoring|detection)$/, '');
    return lower.includes(key) || (stem.length > 0 && key.includes(stem));
  });
  if (!matches) {
    throw new ApiError(
      400,
      'SYNC_BINDING_NOT_SENSORY',
      `Attribute "${attributeKey}" is not a sensory (read-class) attribute of device ` +
        `"${device.name}" — sync bindings may only target perception attributes, ` +
        `never actuator control attributes`,
    );
  }
}

/** Parse + validate one binding input entry from the PUT body. */
export function parseBindingInput(raw: unknown, index: number): SyncBindingInput {
  const path = `bindings[${index}]`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', `${path} must be an object`);
  }
  const entry = raw as Record<string, unknown>;

  const deviceInstanceId = entry.deviceInstanceId;
  if (typeof deviceInstanceId !== 'string' || deviceInstanceId.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.deviceInstanceId must be a non-empty string`);
  }
  const attributeKey = entry.attributeKey;
  if (typeof attributeKey !== 'string' || attributeKey.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `${path}.attributeKey must be a non-empty string`);
  }
  const source = entry.source;
  if (source !== 'manual' && (typeof source !== 'string' || !isHassSource(source))) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `${path}.source must be "manual" or a "hass:<entity_id>" source`,
    );
  }
  let minIntervalSec: number | undefined;
  if (entry.minIntervalSec !== undefined) {
    const value = entry.minIntervalSec;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${path}.minIntervalSec must be a number >= 0`);
    }
    minIntervalSec = value;
  }
  return {
    deviceInstanceId: deviceInstanceId.trim(),
    attributeKey: attributeKey.trim(),
    source: source as string,
    ...(minIntervalSec !== undefined ? { minIntervalSec } : { minIntervalSec: DEFAULT_MIN_INTERVAL_SEC }),
  };
}

/**
 * Pull the observed value out of an HA entity state for one attribute key.
 * A named attribute wins when present; otherwise the entity's MAIN state is
 * the reading (typical for sensor.* entities, whose value lives in `state`
 * while `attributes` only carries device_class/units). Numeric strings are
 * coerced ('21.5' → 21.5); anything non-scalar is skipped.
 */
function extractHassValue(state: HassEntityState, attributeKey: string): ObservationValue | undefined {
  const fromAttributes = state.attributes[attributeKey];
  const raw = fromAttributes !== undefined ? fromAttributes : state.state;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    // HA state strings are numeric for most sensors ('21.5') — coerce.
    const numeric = Number(raw);
    return raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw;
  }
  return undefined;
}
