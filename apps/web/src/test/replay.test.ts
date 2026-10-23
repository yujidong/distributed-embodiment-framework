/**
 * Timeline replay: ring buffer append/dedup/cap semantics and the
 * selectRenderedSnapshot selector that switches the console between the
 * live snapshot and the buffered snapshot at the replay cursor.
 */

import { describe, expect, it } from 'vitest';

import {
  appendReplayTime,
  appendToReplayBuffer,
  REPLAY_BUFFER_CAP,
  replayCursorTime,
  selectRenderedSnapshot,
} from '../lib/replay';
import { makeSnapshot } from './fixtures';

describe('appendToReplayBuffer', () => {
  it('appends distinct snapshots in order', () => {
    let buffer = appendToReplayBuffer([], makeSnapshot({ tickCount: 1 }));
    buffer = appendToReplayBuffer(buffer, makeSnapshot({ tickCount: 2 }));
    expect(buffer.map(s => s.tickCount)).toEqual([1, 2]);
  });

  it('dedupes a repeat of the buffer tail (same tick + simTime)', () => {
    const first = appendToReplayBuffer([], makeSnapshot({ tickCount: 1, simTimeSec: 1 }));
    const second = appendToReplayBuffer(first, makeSnapshot({ tickCount: 1, simTimeSec: 1 }));
    expect(second).toBe(first); // unchanged identity → callers can skip renders
    expect(second).toHaveLength(1);
  });

  it('caps the buffer, dropping the oldest entries', () => {
    let buffer = appendToReplayBuffer([], makeSnapshot({ tickCount: 0 }));
    for (let tick = 1; tick <= REPLAY_BUFFER_CAP + 10; tick++) {
      buffer = appendToReplayBuffer(buffer, makeSnapshot({ tickCount: tick }));
    }
    expect(buffer).toHaveLength(REPLAY_BUFFER_CAP);
    expect(buffer[0].tickCount).toBe(11);
    expect(buffer[buffer.length - 1].tickCount).toBe(REPLAY_BUFFER_CAP + 10);
  });
});

describe('selectRenderedSnapshot', () => {
  const live = makeSnapshot({ tickCount: 99, simTimeSec: 99 });
  const buffered = [0, 1, 2].map(t => makeSnapshot({ tickCount: t, simTimeSec: t * 5 }));

  it('returns the live snapshot when replay is off', () => {
    expect(
      selectRenderedSnapshot({ snapshot: live, replayBuffer: buffered, replayActive: false, replayCursor: 0 }),
    ).toBe(live);
  });

  it('returns the buffered snapshot at the cursor while replaying', () => {
    const rendered = selectRenderedSnapshot({
      snapshot: live,
      replayBuffer: buffered,
      replayActive: true,
      replayCursor: 1,
    });
    expect(rendered?.tickCount).toBe(1);
    expect(rendered?.simTimeSec).toBe(5);
  });

  it('clamps an out-of-range cursor instead of crashing', () => {
    const rendered = selectRenderedSnapshot({
      snapshot: live,
      replayBuffer: buffered,
      replayActive: true,
      replayCursor: 999,
    });
    expect(rendered?.tickCount).toBe(2);
  });

  it('falls back to live when the buffer is empty', () => {
    expect(
      selectRenderedSnapshot({ snapshot: live, replayBuffer: [], replayActive: true, replayCursor: 0 }),
    ).toBe(live);
  });
});

describe('appendReplayTime + replayCursorTime (W8 episode highlight)', () => {
  it('appends one timestamp per accepted snapshot, staying index-aligned', () => {
    const one = appendToReplayBuffer([], makeSnapshot({ tickCount: 1 }));
    let times = appendReplayTime([], [], one, 1000);
    const two = appendToReplayBuffer(one, makeSnapshot({ tickCount: 2 }));
    times = appendReplayTime(times, one, two, 2000);
    expect(times).toEqual([1000, 2000]);
  });

  it('appends nothing when the buffer dedupes the tail (identity unchanged)', () => {
    const first = appendToReplayBuffer([], makeSnapshot({ tickCount: 1, simTimeSec: 1 }));
    const times = appendReplayTime([], [], first, 1000);
    const deduped = appendToReplayBuffer(first, makeSnapshot({ tickCount: 1, simTimeSec: 1 }));
    expect(appendReplayTime(times, first, deduped, 2000)).toBe(times);
  });

  it('drops oldest timestamps when the buffer caps', () => {
    let buffer = appendToReplayBuffer([], makeSnapshot({ tickCount: 0 }));
    let times = appendReplayTime([], [], buffer, 0);
    for (let tick = 1; tick <= REPLAY_BUFFER_CAP + 10; tick += 1) {
      const before = buffer;
      buffer = appendToReplayBuffer(buffer, makeSnapshot({ tickCount: tick }));
      times = appendReplayTime(times, before, buffer, tick);
    }
    expect(times).toHaveLength(REPLAY_BUFFER_CAP);
    expect(times[0]).toBe(11);
  });

  it('maps the cursor to a wall time only while replaying', () => {
    const state = {
      snapshot: null,
      replayBuffer: [makeSnapshot({ tickCount: 1 }), makeSnapshot({ tickCount: 2 })],
      replayTimes: [1000, 2000],
      replayActive: true,
      replayCursor: 1,
    };
    expect(replayCursorTime(state)).toBe(2000);
    expect(replayCursorTime({ ...state, replayActive: false })).toBeNull();
    expect(replayCursorTime({ ...state, replayCursor: 999 })).toBe(2000); // clamped
    expect(replayCursorTime({ ...state, replayTimes: [] })).toBeNull();
  });
});
