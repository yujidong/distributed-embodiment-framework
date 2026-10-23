/**
 * WebSocket stream message handling — parsing and snapshot freshness.
 *
 * The REST snapshot poll remains the ground truth; stream snapshots enrich it
 * but must never REGRESS the store (a stale WS snapshot arriving after a
 * fresher REST poll would otherwise flicker the UI backwards). `tickCount`
 * is the engine's monotonic version counter, `simTimeSec` the tie-break.
 */

import type {
  DeviceDeltaFrame,
  EngineSnapshot,
  StreamMessage,
  SystemEventDto,
  ZoneDeltaFrame,
} from '../api/types';

/**
 * Parse one raw WS message into a typed StreamMessage. Returns null for
 * anything malformed — a bad frame must not kill the stream.
 *
 * R31 SF10: the delta lane's zone-delta/device-delta frames arrive FLAT
 * (each frame is its own message, no `data` wrapper — see
 * apps/server/src/sim-stream-deltas.ts); they are validated in place and
 * normalized into the wrapper so consumers see one uniform shape. A client
 * that ignores them cannot drift longer than the server's 30s resync.
 */
export function parseStreamMessage(raw: unknown): StreamMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as { kind?: unknown; data?: unknown };
  if (message.kind === 'snapshot' && isSnapshotLike(message.data)) {
    return { kind: 'snapshot', data: message.data };
  }
  if (message.kind === 'event' && Array.isArray(message.data)) {
    const events = message.data.filter(isEventLike);
    return events.length > 0 ? { kind: 'event', data: events } : null;
  }
  if (message.kind === 'zone-delta' && isZoneDeltaLike(raw)) {
    return { kind: 'zone-delta', data: raw };
  }
  if (message.kind === 'device-delta' && isDeviceDeltaLike(raw)) {
    return { kind: 'device-delta', data: raw };
  }
  return null;
}

function isSnapshotLike(data: unknown): data is EngineSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const s = data as Partial<EngineSnapshot>;
  return (
    typeof s.runtimeId === 'string' &&
    typeof s.simTimeSec === 'number' &&
    typeof s.tickCount === 'number' &&
    Array.isArray(s.zones) &&
    Array.isArray(s.devices) &&
    Array.isArray(s.agents)
  );
}

function isEventLike(data: unknown): data is SystemEventDto {
  if (typeof data !== 'object' || data === null) return false;
  const e = data as Partial<SystemEventDto>;
  return typeof e.id === 'string' && typeof e.type === 'string';
}

function isZoneDeltaLike(raw: unknown): raw is ZoneDeltaFrame {
  const frame = raw as Partial<ZoneDeltaFrame>;
  return (
    typeof frame.zoneId === 'string' &&
    typeof frame.param === 'string' &&
    isDeltaValue(frame.oldValue) &&
    isDeltaValue(frame.newValue) &&
    typeof frame.simTimeSec === 'number'
  );
}

function isDeviceDeltaLike(raw: unknown): raw is DeviceDeltaFrame {
  const frame = raw as Partial<DeviceDeltaFrame>;
  return (
    typeof frame.deviceId === 'string' &&
    typeof frame.simTimeSec === 'number' &&
    typeof frame.changedFields === 'object' &&
    frame.changedFields !== null &&
    !Array.isArray(frame.changedFields)
  );
}

function isDeltaValue(value: unknown): value is number | boolean {
  return typeof value === 'number' || typeof value === 'boolean';
}

/**
 * True when `incoming` is strictly newer than `current` (or there is no
 * current snapshot). Equal versions are NOT fresher — applying them would be
 * a redundant render.
 */
export function isSnapshotFresher(
  incoming: Pick<EngineSnapshot, 'tickCount' | 'simTimeSec'>,
  current: Pick<EngineSnapshot, 'tickCount' | 'simTimeSec'> | null,
): boolean {
  if (!current) return true;
  if (incoming.tickCount !== current.tickCount) {
    return incoming.tickCount > current.tickCount;
  }
  return incoming.simTimeSec > current.simTimeSec;
}
