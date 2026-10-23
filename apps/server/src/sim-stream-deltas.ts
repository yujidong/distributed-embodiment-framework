/**
 * Sim-stream delta frames (DevLoop R30 Task 4, capacity §3: full world
 * snapshots dominated the observed-world WS bill).
 *
 * The simulation stream (`GET /api/simulations/:id/stream`) used to send a
 * FULL `{kind:'snapshot'}` frame every snapshotEverySimSec — for a
 * 150-device world that is ~1.3KB per cadence tick even when two devices
 * changed. This module adds an additive delta lane:
 *
 *   {kind:'zone-delta',   zoneId, param, oldValue, newValue, simTimeSec}
 *   {kind:'device-delta', deviceId, changedFields, simTimeSec}
 *
 * BACKWARD COMPATIBLE by construction: the full snapshot kind stays (and
 * is still sent) for (a) the initial sync on connect, (b) periodic resync
 * (every STREAM_RESYNC_MS, cadence-aware — see SnapshotDeltaTracker.decide;
 * a client that ignores unknown kinds cannot drift longer than
 * max(STREAM_RESYNC_MS, two cadence sends)), and (c) topology changes /
 * large diffs (ids appear/disappear, or more than half the world changed —
 * the bandwidth crossover where the snapshot is simply smaller). Diffs are
 * computed against the caller's PROJECTED per-subscriber snapshots, so the
 * delta lane exposes exactly what the full snapshot lane exposes (device
 * privacy tiers included) — never more. Monotonic energy counters
 * (cumulative*Wh) are excluded from deltas and ride the full snapshots
 * (R33, Smart F6 — they tick every cadence on every powered device and
 * alone pushed every diff over the crossover).
 *
 * Everything here is pure over JSON-shaped snapshots; no engine imports.
 */

/** A single zone-parameter change (occupancy rides as param 'occupancy'). */
export interface ZoneDeltaFrame {
  kind: 'zone-delta';
  zoneId: string;
  param: string;
  oldValue: number | boolean;
  newValue: number | boolean;
  simTimeSec: number;
}

/** A single device's changed state fields (`from`/`to` per field). */
export interface DeviceDeltaFrame {
  kind: 'device-delta';
  deviceId: string;
  changedFields: Record<string, { from: unknown; to: unknown }>;
  simTimeSec: number;
}

export type SnapshotDeltaFrame = ZoneDeltaFrame | DeviceDeltaFrame;

/** Periodic forced full-snapshot resync (the delta lane's safety net). */
export const STREAM_RESYNC_MS = 30_000;

/**
 * R33 (DevLoop, Smart F6): the resync is CADENCE-AWARE — the window only
 * forces a full when at least one cadence send happened since the last full.
 * At 1x speed the snapshot cadence (60 sim-sec ≈ 60 wall-sec) EXCEEDS the
 * 30s window, so the old pure wall-clock check forced a full on EVERY
 * cadence tick and the delta lane never fired. The drift bound becomes
 * max(STREAM_RESYNC_MS, two cadence sends) — every window still guarantees
 * a full, and slow-cadence worlds get at least one delta opportunity
 * between fulls.
 */

/** Minimum deltas before the snapshot becomes the cheaper frame. */
const MIN_DELTAS_BEFORE_FULL = 8;

/**
 * R33 (Smart F6): monotonic energy meters (cumulativeEnergyWh,
 * cumulativeZoneWh, …) tick on EVERY powered device EVERY cadence — they
 * alone pushed a 16-device world's diff to the crossover every tick (and
 * every device frame carried only the counter). Counters are excluded from
 * DELTA diffs; they stay correct via the full snapshots (initial + resync).
 */
const MONOTONIC_COUNTER_FIELD = /^cumulative\w*Wh$/;

/** The minimal snapshot shape the differ needs (EngineSnapshot fits). */
export interface SnapshotLike {
  simTimeSec: number;
  zones?: Array<{ id: string; parameters?: Record<string, unknown>; occupancy?: number }>;
  devices?: Array<{ id: string; state?: Record<string, unknown>; fault?: unknown }>;
}

/**
 * Diff two snapshots into delta frames. `null` (needs full sync) when the
 * topology changed (zone/device id sets differ) or the diff exceeds the
 * bandwidth crossover — the caller then sends a full snapshot instead.
 */
export function diffSnapshots(
  prev: SnapshotLike | undefined,
  next: SnapshotLike,
): SnapshotDeltaFrame[] | null {
  if (prev === undefined) return null;
  const prevZones = indexBy(prev.zones, z => z.id);
  const nextZones = next.zones ?? [];
  if (prevZones.size !== nextZones.length || nextZones.some(z => !prevZones.has(z.id))) {
    return null;
  }
  const prevDevices = indexBy(prev.devices, d => d.id);
  const nextDevices = next.devices ?? [];
  if (prevDevices.size !== nextDevices.length || nextDevices.some(d => !prevDevices.has(d.id))) {
    return null;
  }

  const frames: SnapshotDeltaFrame[] = [];
  for (const zone of nextZones) {
    const before = prevZones.get(zone.id)!;
    const beforeParams = before.parameters ?? {};
    const afterParams = zone.parameters ?? {};
    const params = new Set([...Object.keys(beforeParams), ...Object.keys(afterParams)]);
    for (const param of params) {
      if (!valueEquals(beforeParams[param], afterParams[param])) {
        frames.push({
          kind: 'zone-delta', zoneId: zone.id, param,
          oldValue: asDeltaValue(beforeParams[param]),
          newValue: asDeltaValue(afterParams[param]),
          simTimeSec: next.simTimeSec,
        });
      }
    }
    if (!valueEquals(before.occupancy, zone.occupancy)) {
      frames.push({
        kind: 'zone-delta', zoneId: zone.id, param: 'occupancy',
        oldValue: before.occupancy ?? 0,
        newValue: zone.occupancy ?? 0,
        simTimeSec: next.simTimeSec,
      });
    }
  }
  for (const device of nextDevices) {
    const before = prevDevices.get(device.id)!;
    const beforeState = before.state ?? {};
    const afterState = device.state ?? {};
    const changedFields: Record<string, { from: unknown; to: unknown }> = {};
    const fields = new Set([...Object.keys(beforeState), ...Object.keys(afterState)]);
    for (const field of fields) {
      // R33 (Smart F6): always-ticking meters never ride the delta lane.
      if (MONOTONIC_COUNTER_FIELD.test(field)) continue;
      if (!valueEquals(beforeState[field], afterState[field])) {
        changedFields[field] = { from: beforeState[field], to: afterState[field] };
      }
    }
    if (!valueEquals(before.fault, device.fault)) {
      changedFields['fault'] = { from: before.fault ?? null, to: device.fault ?? null };
    }
    if (Object.keys(changedFields).length > 0) {
      frames.push({ kind: 'device-delta', deviceId: device.id, changedFields, simTimeSec: next.simTimeSec });
    }
  }

  const entries = nextZones.length + nextDevices.length;
  if (frames.length > Math.max(MIN_DELTAS_BEFORE_FULL, Math.ceil(entries / 2))) {
    return null; // the full snapshot is the smaller (and simpler) frame
  }
  return frames;
}

/** Per-subscriber delta state for one stream socket. */
export class SnapshotDeltaTracker {
  private last?: SnapshotLike;
  private lastFullAtMs: number;
  /** Cadence sends (deltas or fulls) since the last full — the R33 resync gate. */
  private sendsSinceFull = 0;

  constructor(private readonly nowMs: () => number = Date.now) {
    this.lastFullAtMs = nowMs();
  }

  /** The projected snapshot the caller is ABOUT to send in full. */
  sentFull(snapshot: SnapshotLike): void {
    this.last = snapshot;
    this.lastFullAtMs = this.nowMs();
    this.sendsSinceFull = 0;
  }

  /**
   * Decide what the next cadence send should be: 'full' (send the snapshot
   * through the legacy path and call sentFull), or 'deltas' (send each
   * frame as its own message; possibly zero frames when nothing changed).
   *
   * R33 (Smart F6): (a) the resync fires only when the window elapsed AND
   * at least one cadence send happened since the last full — a cadence
   * slower than the window (1x: 60 sim-sec cadence vs 30s resync) still
   * gets delta frames between fulls instead of a forced full every tick;
   * (b) the diff anchors at the last SENT snapshot, so each cadence emits
   * only ITS OWN churn (the old last-full anchoring re-emitted every change
   * since the last full each tick — redundant bytes AND a crossover that
   * tripped on accumulated, not per-cadence, counts). A client that misses
   * or ignores delta frames is still bounded by the resync.
   */
  decide(next: SnapshotLike): { kind: 'full' } | { kind: 'deltas'; frames: SnapshotDeltaFrame[] } {
    if (
      this.nowMs() - this.lastFullAtMs >= STREAM_RESYNC_MS &&
      this.sendsSinceFull >= 1
    ) {
      return { kind: 'full' };
    }
    const frames = diffSnapshots(this.last, next);
    if (frames === null) return { kind: 'full' };
    this.last = next;
    this.sendsSinceFull += 1;
    return { kind: 'deltas', frames };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function indexBy<T>(items: Array<T> | undefined, keyOf: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) map.set(keyOf(item), item);
  return map;
}

/** Structural equality over JSON-shaped leaf values. */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => valueEquals(item, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(k =>
    valueEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Coerce a snapshot leaf to the delta wire type (booleans/numbers). */
function asDeltaValue(value: unknown): number | boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  return value === undefined || value === null ? 0 : Number(value) || 0;
}
