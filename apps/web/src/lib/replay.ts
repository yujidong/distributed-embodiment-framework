/**
 * Timeline replay — client-side ring buffer of snapshots plus the selector
 * that decides what the console renders.
 *
 * Design contract:
 * - The LIVE snapshot slice is never mutated by replay. Poll/WS keep writing
 *   `snapshot`; every accepted snapshot is also appended to `replayBuffer`
 *   (deduped by tickCount+simTimeSec, capped, oldest dropped first).
 * - Replay mode only moves `replayCursor`; `selectRenderedSnapshot` derives
 *   what the map/panels show. Exiting replay makes the selector fall back to
 *   the live snapshot — "snapping back to live" needs no state repair.
 */

import type { EngineSnapshot } from '../api/types';

/** Ring buffer capacity (~500 entries ≈ 12 min of 1.5 s polling). */
export const REPLAY_BUFFER_CAP = 500;

/**
 * Append one snapshot to the buffer. The same array is returned unchanged
 * when the snapshot duplicates the buffer tail (poll + WS often deliver the
 * same tick) so callers can skip re-renders.
 */
export function appendToReplayBuffer(
  buffer: readonly EngineSnapshot[],
  snapshot: EngineSnapshot,
): EngineSnapshot[] {
  const tail = buffer[buffer.length - 1];
  if (tail && tail.tickCount === snapshot.tickCount && tail.simTimeSec === snapshot.simTimeSec) {
    return buffer as EngineSnapshot[];
  }
  const next = [...buffer, snapshot];
  if (next.length > REPLAY_BUFFER_CAP) {
    next.splice(0, next.length - REPLAY_BUFFER_CAP);
  }
  return next;
}

export interface ReplayViewState {
  snapshot: EngineSnapshot | null;
  replayBuffer: EngineSnapshot[];
  /**
   * Client wall-clock receipt time (ms) per buffered snapshot, index-aligned
   * with `replayBuffer` (W8: maps the replay cursor to a wall time so
   * episodes — which are wall-clock-anchored — can be highlighted).
   * Optional: selectors that don't need it accept states without it.
   */
  replayTimes?: number[];
  replayActive: boolean;
  replayCursor: number;
}

/**
 * Append the receipt time for a newly-buffered snapshot. Follows
 * `appendToReplayBuffer`'s contract exactly: pass the buffer BEFORE and
 * AFTER the append — a deduped tail (identical array identity) appends
 * nothing, and the result stays index-aligned when the buffer caps.
 */
export function appendReplayTime(
  times: readonly number[],
  before: readonly EngineSnapshot[],
  after: readonly EngineSnapshot[],
  now: number,
): number[] {
  if (after === before) return times as number[];
  const next = [...times, now];
  // Stay index-aligned with the (possibly capped) buffer.
  return next.slice(next.length - after.length);
}

/**
 * Wall time (ms) the replay cursor points at, or null when not replaying /
 * no timestamp is available (e.g. a buffer restored from an older session).
 */
export function replayCursorTime(state: ReplayViewState): number | null {
  if (!state.replayActive || state.replayBuffer.length === 0) return null;
  const cursor = Math.min(Math.max(state.replayCursor, 0), state.replayBuffer.length - 1);
  return state.replayTimes?.[cursor] ?? null;
}

/**
 * The snapshot the console should render: the buffered entry at the cursor
 * while replaying (cursor clamped into range), the live snapshot otherwise.
 */
export function selectRenderedSnapshot(state: ReplayViewState): EngineSnapshot | null {
  if (!state.replayActive) return state.snapshot;
  if (state.replayBuffer.length === 0) return state.snapshot;
  const cursor = Math.min(Math.max(state.replayCursor, 0), state.replayBuffer.length - 1);
  return state.replayBuffer[cursor] ?? state.snapshot;
}
