/**
 * Share replay clock (UX-W5 子任务 C): the pure playback model behind the
 * share page's replay bar — timeline assembly, wall-clock tick advancement,
 * current-item highlighting, progress fill and pause/resume semantics.
 */

import { describe, expect, it } from 'vitest';

import type { ScenarioEvent } from '../api/types';
import {
  activeReplayIndex,
  buildShareReplayTimeline,
  initialShareReplayState,
  isShareReplayFinished,
  replayFlashZoneId,
  SHARE_REPLAY_BASE_SEC,
  shareReplayProgress,
  shareReplayRate,
  tickShareReplay,
  type ShareReplayState,
} from '../lib/shareReplayClock';

function ev(id: string, atSimTimeSec?: number, zoneId = 'z-a'): ScenarioEvent {
  return {
    id,
    type: 'sim-decision',
    zoneId,
    ...(atSimTimeSec !== undefined ? { atSimTimeSec } : {}),
    details: {},
  };
}

describe('buildShareReplayTimeline', () => {
  it('keeps sim-time-stamped events, sorted ascending (stable for ties)', () => {
    const timeline = buildShareReplayTimeline([
      ev('b', 30),
      ev('a', 10),
      ev('untimed'),
      ev('c1', 20),
      ev('c2', 20),
      ev('nan', Number.NaN),
    ]);
    expect(timeline.items.map(item => item.event.id)).toEqual(['a', 'c1', 'c2', 'b']);
    expect(timeline.startSec).toBe(10);
    expect(timeline.endSec).toBe(30);
  });

  it('handles an empty/untimed-only event list', () => {
    const timeline = buildShareReplayTimeline([ev('x'), ev('y')]);
    expect(timeline.items).toEqual([]);
    expect(timeline.startSec).toBe(0);
    expect(timeline.endSec).toBe(0);
  });
});

describe('shareReplayRate', () => {
  it('compresses the whole window into the base playback length at 1×', () => {
    const timeline = buildShareReplayTimeline([ev('a', 0), ev('b', 600)]);
    expect(shareReplayRate(timeline)).toBe(600 / SHARE_REPLAY_BASE_SEC); // 10 sim-s per wall-s
  });

  it('falls back to 1 for a zero-duration window', () => {
    const timeline = buildShareReplayTimeline([ev('a', 5), ev('b', 5)]);
    expect(shareReplayRate(timeline)).toBe(1);
  });
});

describe('tickShareReplay (回放时钟推进 / 暂停恢复)', () => {
  const timeline = buildShareReplayTimeline([ev('a', 0), ev('b', 600)]); // rate 10

  it('advances the position by dt × rate × speed while playing', () => {
    const state: ShareReplayState = { positionSec: 0, playing: true, speed: 1 };
    expect(tickShareReplay(state, timeline, 1000).positionSec).toBe(10);
    expect(tickShareReplay(state, timeline, 1000).playing).toBe(true);
    // 4× 与 16× 倍速。
    expect(tickShareReplay({ ...state, speed: 4 }, timeline, 1000).positionSec).toBe(40);
    expect(tickShareReplay({ ...state, speed: 16 }, timeline, 1000).positionSec).toBe(160);
  });

  it('clamps at the window end and auto-pauses there', () => {
    const state: ShareReplayState = { positionSec: 590, playing: true, speed: 1 };
    const next = tickShareReplay(state, timeline, 5000);
    expect(next.positionSec).toBe(600);
    expect(next.playing).toBe(false);
    expect(isShareReplayFinished(timeline, next.positionSec)).toBe(true);
  });

  it('never moves a paused state; resuming is a pure flag flip', () => {
    const paused: ShareReplayState = { positionSec: 100, playing: false, speed: 4 };
    expect(tickShareReplay(paused, timeline, 1000)).toBe(paused); // 暂停：位置不动
    const resumed = tickShareReplay({ ...paused, playing: true }, timeline, 1000);
    expect(resumed.positionSec).toBe(140); // 恢复：从暂停点继续
    expect(resumed.playing).toBe(true);
  });

  it('ignores non-positive ticks and empty timelines', () => {
    const state: ShareReplayState = { positionSec: 50, playing: true, speed: 1 };
    expect(tickShareReplay(state, timeline, 0)).toBe(state);
    const empty = buildShareReplayTimeline([]);
    expect(tickShareReplay(state, empty, 1000)).toBe(state);
  });
});

describe('activeReplayIndex (当前条目高亮)', () => {
  const timeline = buildShareReplayTimeline([ev('a', 0), ev('b', 10), ev('c', 20)]);

  it('is -1 before the first item', () => {
    expect(activeReplayIndex(timeline, -1)).toBe(-1);
  });

  it('points at the last item whose sim time the playback has reached', () => {
    expect(activeReplayIndex(timeline, 0)).toBe(0);
    expect(activeReplayIndex(timeline, 9.9)).toBe(0);
    expect(activeReplayIndex(timeline, 10)).toBe(1);
    expect(activeReplayIndex(timeline, 999)).toBe(2);
  });

  it('feeds the zone flash from the current item', () => {
    expect(replayFlashZoneId(timeline, 1)).toBe('z-a');
    expect(replayFlashZoneId(timeline, -1)).toBeUndefined();
    const zoneless = buildShareReplayTimeline([
      { id: 'x', type: 'sim-decision', zoneId: '', atSimTimeSec: 0, details: {} },
    ]);
    expect(replayFlashZoneId(zoneless, 0)).toBeUndefined();
  });
});

describe('shareReplayProgress (进度条)', () => {
  const timeline = buildShareReplayTimeline([ev('a', 100), ev('b', 200)]);

  it('is 0 at the window start, 1 at the end, linear in between', () => {
    expect(shareReplayProgress(timeline, 100)).toBe(0);
    expect(shareReplayProgress(timeline, 150)).toBe(0.5);
    expect(shareReplayProgress(timeline, 200)).toBe(1);
  });

  it('clamps out-of-window positions and tolerates zero-duration windows', () => {
    expect(shareReplayProgress(timeline, 0)).toBe(0);
    expect(shareReplayProgress(timeline, 999)).toBe(1);
    const point = buildShareReplayTimeline([ev('a', 5)]);
    expect(shareReplayProgress(point, 5)).toBe(1);
    expect(shareReplayProgress(buildShareReplayTimeline([]), 0)).toBe(0);
  });
});

describe('initialShareReplayState', () => {
  it('starts playing from the window start at 1×', () => {
    const timeline = buildShareReplayTimeline([ev('a', 42), ev('b', 100)]);
    expect(initialShareReplayState(timeline)).toEqual({
      positionSec: 42,
      playing: true,
      speed: 1,
    });
  });
});
