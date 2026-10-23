/**
 * Stream message handling: parseStreamMessage rejects malformed frames, and
 * the store's applyStreamSnapshot applies WS snapshots only when they are
 * strictly fresher than the current (REST ground-truth) snapshot — a stale
 * WS frame must never regress the console.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { isSnapshotFresher, parseStreamMessage } from '../lib/stream';
import { useAppStore } from '../store/useAppStore';
import { makeSnapshot } from './fixtures';

describe('parseStreamMessage', () => {
  it('parses a snapshot message', () => {
    const data = makeSnapshot({ tickCount: 7 });
    expect(parseStreamMessage({ kind: 'snapshot', data })).toEqual({ kind: 'snapshot', data });
  });

  it('parses an event batch and drops malformed entries', () => {
    const result = parseStreamMessage({
      kind: 'event',
      data: [{ id: 'e1', type: 'device.state_change' }, { nope: true }, null],
    });
    expect(result).toEqual({
      kind: 'event',
      data: [{ id: 'e1', type: 'device.state_change' }],
    });
  });

  it('returns null for malformed frames', () => {
    expect(parseStreamMessage(null)).toBeNull();
    expect(parseStreamMessage('hello')).toBeNull();
    expect(parseStreamMessage({ kind: 'snapshot', data: { partial: true } })).toBeNull();
    expect(parseStreamMessage({ kind: 'event', data: 'not-an-array' })).toBeNull();
    expect(parseStreamMessage({ kind: 'unknown', data: {} })).toBeNull();
  });
});

describe('isSnapshotFresher', () => {
  it('accepts anything when there is no current snapshot', () => {
    expect(isSnapshotFresher({ tickCount: 0, simTimeSec: 0 }, null)).toBe(true);
  });

  it('compares by tickCount first, then simTimeSec', () => {
    expect(isSnapshotFresher({ tickCount: 2, simTimeSec: 0 }, { tickCount: 1, simTimeSec: 9 })).toBe(true);
    expect(isSnapshotFresher({ tickCount: 1, simTimeSec: 9 }, { tickCount: 2, simTimeSec: 0 })).toBe(false);
    expect(isSnapshotFresher({ tickCount: 2, simTimeSec: 5 }, { tickCount: 2, simTimeSec: 4 })).toBe(true);
    expect(isSnapshotFresher({ tickCount: 2, simTimeSec: 4 }, { tickCount: 2, simTimeSec: 4 })).toBe(false);
  });
});

describe('store applyStreamSnapshot (WS reducer ordering)', () => {
  beforeEach(() => {
    useAppStore.setState({ snapshot: null, replayBuffer: [], replayActive: false, replayCursor: 0 });
  });

  it('applies a fresher WS snapshot and records it in the replay buffer', () => {
    const store = useAppStore.getState();
    store.setSnapshot(makeSnapshot({ tickCount: 10, simTimeSec: 10 }));
    useAppStore.getState().applyStreamSnapshot(makeSnapshot({ tickCount: 11, simTimeSec: 11 }));
    expect(useAppStore.getState().snapshot?.tickCount).toBe(11);
    expect(useAppStore.getState().replayBuffer.map(s => s.tickCount)).toEqual([10, 11]);
  });

  it('ignores a stale WS snapshot arriving after a fresher REST poll', () => {
    useAppStore.getState().setSnapshot(makeSnapshot({ tickCount: 10, simTimeSec: 10 }));
    useAppStore.getState().applyStreamSnapshot(makeSnapshot({ tickCount: 8, simTimeSec: 8 }));
    expect(useAppStore.getState().snapshot?.tickCount).toBe(10);
    expect(useAppStore.getState().replayBuffer).toHaveLength(1);
  });

  it('ignores an equal-version duplicate', () => {
    useAppStore.getState().setSnapshot(makeSnapshot({ tickCount: 5, simTimeSec: 5 }));
    useAppStore.getState().applyStreamSnapshot(makeSnapshot({ tickCount: 5, simTimeSec: 5 }));
    expect(useAppStore.getState().replayBuffer).toHaveLength(1);
  });
});
