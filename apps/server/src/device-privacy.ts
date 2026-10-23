/**
 * Device privacy view-model (DevLoop S2) — the ONE canonical projection seam
 *
 * Owner-ratified model (docs/design-consent-semantics.md §10, S2 status
 * note): devices are visible to members as OBJECTS — existence + coarse
 * status (name/type/zone/owner/capabilities + on/off-or-presence) — but
 * detailed state/telemetry (sensor readings, parameter payloads) is only
 * accessible via the service layer under grants/agreements. T-401 (R19)
 * already closed direct CONTROL; this module closes the READ side at every
 * world surface.
 *
 * The tier rule (single truth, no per-site ad-hoc redaction):
 *
 *   full   ⇔ viewer is an admin, the environment owner, or the device owner
 *   coarse ⇔ everyone else (members, viewers, anonymous visitors of public
 *            environments, and — for fork sims — even the fork creator,
 *            whose fork runs full physics but READS through this seam)
 *
 * Coarse is a projection, never an omission: the device stays listed with
 * its world-structure facts (id/name/type/brand/zone/position/capabilities/
 * commands/role/owner/createdAt) plus an honestly-derived coarse status.
 * Hidden in coarse: initialState / runtime state (sensor readings, parameter
 * payloads) and the hass:// binding's external entity id (scheme preserved).
 *
 * NOT redacted anywhere (deliberate, world-ambient truth per the design):
 * zone parameters (zone physics is shared world state — design-data-services
 * §2 "原始观测私有，聚合公开"), device names/positions (world structure),
 * and capability/command surfaces (actuation is separately gated).
 */

import type { DeviceInstanceRow } from './db/environment-store.js';

/** Who is looking at a device-bearing surface. */
export interface DeviceViewer {
  /** Authenticated user id; null = anonymous. Anonymous is never full-tier. */
  userId: string | null;
  /** Deployment admin (ADMIN_EMAILS) — full tier everywhere. */
  isAdmin?: boolean;
}

/** The owner facts a redaction site resolves for one device row. */
export interface DeviceOwnership {
  /** The device row's owner (device rows carry a NOT NULL owner_id). */
  ownerId: string;
  /** Owner of the environment the device lives in (null = unresolvable). */
  envOwnerId: string | null;
}

/**
 * The single tier decision. `ownership === undefined` means the device id
 * could not be resolved to an env row at all — callers pass that ONLY for
 * env-linked surfaces (env-backed sims and forks), where an unresolvable id
 * was a tenant row that has since been deleted; deletion does not
 * declassify, so the answer is coarse. Pure-scenario surfaces (devices
 * authored inside a shared scenario definition) never call this — they have
 * no tenant semantics.
 */
export function deviceDetailTier(
  viewer: DeviceViewer,
  ownership: DeviceOwnership | undefined,
): 'full' | 'coarse' {
  if (viewer.isAdmin === true) return 'full';
  if (viewer.userId === null) return 'coarse';
  if (ownership === undefined) return 'coarse';
  if (ownership.envOwnerId !== null && ownership.envOwnerId === viewer.userId) return 'full';
  if (ownership.ownerId === viewer.userId) return 'full';
  return 'coarse';
}

/**
 * Coarse status the physics can honestly expose. Mirrors the simulation's
 * own powered-predicate (SimulatedDevice: `state.power === true ||
 * state.status === 'on' | 'active'`) — a device that exposes none of those
 * signals (pure sensors) reports 'present': existence without on/off claim.
 */
export function coarseDeviceStatus(
  state: Record<string, unknown> | null | undefined,
): 'on' | 'off' | 'present' {
  if (state === null || state === undefined) return 'present';
  if (state.power === true) return 'on';
  if (state.status === 'on' || state.status === 'active') return 'on';
  if (state.power === false) return 'off';
  return 'present';
}

// ---------------------------------------------------------------------------
// Wire-shape projections (input = the exact JSON the surface already builds;
// output = the viewer's projection — full tier passes through byte-identical)
// ---------------------------------------------------------------------------

/** The env-row device wire shape (env-serializers.deviceToJson output). */
export type DeviceJsonView = Record<string, unknown> & { id: string; binding?: string };

/**
 * Project a device-row wire shape for the viewer. Full tier: the object is
 * returned UNCHANGED (no field churn on the 99% owner path). Coarse tier:
 * initialState (authored AND twin-synced telemetry — the sync worker merges
 * observed values into it) is dropped, the hass:// binding keeps only its
 * scheme (the external entity id is not world structure), and the coarse
 * status + an explicit visibility marker are added.
 */
export function projectDeviceJson(
  json: DeviceJsonView,
  viewer: DeviceViewer,
  ownership: DeviceOwnership | undefined,
  /** Pre-parsed initialState (callers have the row at hand); default: json.initialState. */
  initialState?: Record<string, unknown> | null,
): DeviceJsonView {
  if (deviceDetailTier(viewer, ownership) === 'full') return json;
  const source = initialState !== undefined
    ? initialState
    : (json.initialState as Record<string, unknown> | null | undefined);
  const binding = typeof json.binding === 'string' ? json.binding : undefined;
  const { initialState: _hidden, ...coarse } = json;
  return {
    ...coarse,
    ...(binding !== undefined && binding.startsWith('hass://')
      ? { binding: 'hass://redacted' }
      : {}),
    stateVisibility: 'coarse',
    status: coarseDeviceStatus(source),
  };
}

/** One device entry of a runtime snapshot (EngineSnapshot.devices element). */
export interface SnapshotDeviceView {
  id: string;
  name: string;
  type: string;
  role: string;
  zoneId: string;
  state: Record<string, unknown>;
  commands: string[];
  fault: unknown;
  [key: string]: unknown;
}

/**
 * Project a runtime-snapshot device entry. Coarse tier keeps identity,
 * classification, placement, executable commands and fault health (a
 * "device is faulted" marker is coarse status, not telemetry) but empties
 * `state` — sensor readings and parameter payloads are service-layer data —
 * and states why via `stateRedacted: true` + the derived coarse status.
 */
export function projectSnapshotDevice<T extends SnapshotDeviceView>(
  device: T,
  viewer: DeviceViewer,
  ownership: DeviceOwnership | undefined,
): T | (Omit<T, 'state'> & { state: Record<string, unknown>; status: string; stateRedacted: boolean }) {
  if (deviceDetailTier(viewer, ownership) === 'full') return device;
  return {
    ...device,
    state: {},
    status: coarseDeviceStatus(device.state),
    stateRedacted: true,
  };
}

/** A sim-timeline `device-state` record (sim-timeline.DeviceStateRecord). */
export interface DeviceStateRecordView {
  kind: 'device-state';
  deviceId: string;
}

/**
 * Project a timeline device-state record. Honest choice: the RECORD STAYS
 * (that a device changed state at sim-time T via service S is world history,
 * not telemetry) with `params`/`result` stripped and `redacted: true` —
 * omitting the record entirely would silently falsify the physical timeline.
 */
export function projectDeviceStateRecord<T extends DeviceStateRecordView>(
  record: T & { params?: unknown; result?: unknown },
  viewer: DeviceViewer,
  ownership: DeviceOwnership | undefined,
): T {
  if (deviceDetailTier(viewer, ownership) === 'full') return record;
  const { params: _p, result: _r, ...coarse } = record;
  return { ...coarse, redacted: true } as unknown as T;
}

// ---------------------------------------------------------------------------
// Ownership oracle — how read sites resolve DeviceOwnership for a device id
// ---------------------------------------------------------------------------

/**
 * Builds the per-request ownership oracle from the environment store. Device
 * ids are globally unique rows, so one lookup answers BOTH the device owner
 * and (via the row's env) the env owner — this works identically for
 * env-backed sims and creator-private forks (whose device ids are the env
 * row ids frozen at fork time).
 */
export function deviceOwnershipOracle(
  getDevice: (deviceId: string) => DeviceInstanceRow | undefined,
  getEnvironmentOwnerId: (envId: string) => string | null,
): (deviceId: string) => DeviceOwnership | undefined {
  const cache = new Map<string, DeviceOwnership | undefined>();
  return deviceId => {
    if (cache.has(deviceId)) return cache.get(deviceId);
    const row = getDevice(deviceId);
    const resolved: DeviceOwnership | undefined = row === undefined
      ? undefined
      : { ownerId: row.owner_id, envOwnerId: getEnvironmentOwnerId(row.env_id) };
    cache.set(deviceId, resolved);
    return resolved;
  };
}
