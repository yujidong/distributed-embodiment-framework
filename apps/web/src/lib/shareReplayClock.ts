/**
 * Share-page replay clock (UX-W5 子任务 C) — pure client-side playback model
 * for the anonymous share view.
 *
 * A replay share has no live simulation; the frozen scenario's events carry
 * `atSimTimeSec` stamps. This module turns them into a sim-time timeline and
 * a tick reducer the ShareReplayControls drive with a wall-clock interval:
 *
 * - buildShareReplayTimeline: events with a finite sim time, sorted ascending;
 * - tickShareReplay: advance the position by dt × rate × speed, clamping at
 *   the window end and auto-pausing there (pause = playing:false, so resume
 *   is just flipping the flag back);
 * - activeReplayIndex: the CURRENT timeline item at a position (the last one
 *   whose sim time the playback has reached) — the page highlights that row
 *   and flashes its zone on the 2D map;
 * - shareReplayProgress: 0..1 fill of the progress bar.
 *
 * 1× is NOT real time (a 1-hour window would take an hour to watch): the base
 * rate compresses the whole window into BASE_PLAYBACK_SEC wall seconds, and
 * 4×/16× multiply that.
 */

import type { ScenarioEvent } from '../api/types';

export type ShareReplaySpeed = 1 | 4 | 16;

/** Wall seconds a full window takes at 1×. */
export const SHARE_REPLAY_BASE_SEC = 60;

export interface ShareReplayItem {
  event: ScenarioEvent;
  atSimTimeSec: number;
}

export interface ShareReplayTimeline {
  /** Sim-time ascending (stable for ties). */
  items: ShareReplayItem[];
  startSec: number;
  endSec: number;
}

export interface ShareReplayState {
  /** Absolute sim-time position within [startSec, endSec]. */
  positionSec: number;
  playing: boolean;
  speed: ShareReplaySpeed;
}

/** Keep only sim-time-stamped events, sorted ascending (stable for ties). */
export function buildShareReplayTimeline(events: readonly ScenarioEvent[]): ShareReplayTimeline {
  const items: ShareReplayItem[] = [];
  for (const event of events) {
    const at = event.atSimTimeSec;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    items.push({ event, atSimTimeSec: at });
  }
  items.sort((a, b) => a.atSimTimeSec - b.atSimTimeSec);
  return {
    items,
    startSec: items[0]?.atSimTimeSec ?? 0,
    endSec: items[items.length - 1]?.atSimTimeSec ?? 0,
  };
}

/** Sim seconds per wall second at 1× — the whole window in BASE_PLAYBACK_SEC. */
export function shareReplayRate(timeline: ShareReplayTimeline): number {
  const duration = timeline.endSec - timeline.startSec;
  return duration > 0 ? duration / SHARE_REPLAY_BASE_SEC : 1;
}

export function initialShareReplayState(timeline: ShareReplayTimeline): ShareReplayState {
  return { positionSec: timeline.startSec, playing: true, speed: 1 };
}

/**
 * One playback tick. A paused state never moves (pause/resume is a pure flag
 * flip); reaching the window end clamps the position and auto-pauses.
 */
export function tickShareReplay(
  state: ShareReplayState,
  timeline: ShareReplayTimeline,
  dtWallMs: number,
): ShareReplayState {
  if (!state.playing || dtWallMs <= 0 || timeline.items.length === 0) return state;
  const next = state.positionSec + (dtWallMs / 1000) * shareReplayRate(timeline) * state.speed;
  if (next >= timeline.endSec) {
    return { ...state, positionSec: timeline.endSec, playing: false };
  }
  return { ...state, positionSec: next };
}

/**
 * Index of the CURRENT timeline item at a position — the last one whose sim
 * time has been reached; -1 before the first item (or on an empty timeline).
 */
export function activeReplayIndex(timeline: ShareReplayTimeline, positionSec: number): number {
  let active = -1;
  for (let i = 0; i < timeline.items.length; i += 1) {
    if (timeline.items[i]!.atSimTimeSec <= positionSec) active = i;
    else break;
  }
  return active;
}

/** 0..1 fill of the progress bar at a position (zero-duration window → 1). */
export function shareReplayProgress(timeline: ShareReplayTimeline, positionSec: number): number {
  const duration = timeline.endSec - timeline.startSec;
  if (duration <= 0) return timeline.items.length > 0 ? 1 : 0;
  const ratio = (positionSec - timeline.startSec) / duration;
  return Math.min(1, Math.max(0, ratio));
}

export function isShareReplayFinished(timeline: ShareReplayTimeline, positionSec: number): boolean {
  return timeline.items.length > 0 && positionSec >= timeline.endSec;
}

/**
 * The zone to flash on the 2D map for the current item (undefined when the
 * item carries no zone — nothing on the map to locate then).
 */
export function replayFlashZoneId(
  timeline: ShareReplayTimeline,
  activeIndex: number,
): string | undefined {
  const zoneId = activeIndex >= 0 ? timeline.items[activeIndex]?.event.zoneId : undefined;
  return typeof zoneId === 'string' && zoneId.length > 0 ? zoneId : undefined;
}
