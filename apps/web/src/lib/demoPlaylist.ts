/**
 * Demo playlist (R15-B2) — the「应用高光」script a presenter plays with one
 * click.
 *
 * Scenarios authored for demos carry a scripted event sequence (campus:
 * nine `demo-*` events from students-in to overheat recovery; shenzhen: the
 * pacing script). extractDemoEvents finds that sequence; the console player
 * walks it scene by scene (jump → pause → dwell → next), so the audience
 * sees each highlight instead of a fast-forward blur.
 */

import type { ScenarioEvent } from '../api/types';

export interface DemoScene {
  id: string;
  type: string;
  zoneId: string;
  atSimTimeSec: number;
}

/** Minimum script length for the play button to appear. */
export const MIN_DEMO_SCENES = 3;

/**
 * The scenario's demo script, ordered by sim time:
 * 1. events whose id starts with `demo-` (campus convention), when ≥1 exist;
 * 2. otherwise every scheduled event carrying atSimTimeSec (shenzhen's
 *    pacing script has no prefix) — still requires MIN_DEMO_SCENES total.
 */
export function extractDemoEvents(events: readonly ScenarioEvent[]): DemoScene[] {
  const toScene = (event: ScenarioEvent): DemoScene | null => {
    if (typeof event.atSimTimeSec !== 'number') return null;
    return {
      id: event.id,
      type: event.type,
      zoneId: typeof event.zoneId === 'string' ? event.zoneId : '',
      atSimTimeSec: event.atSimTimeSec,
    };
  };
  const demoPrefixed = events
    .filter(event => event.id.startsWith('demo-'))
    .map(toScene)
    .filter((scene): scene is DemoScene => scene !== null);
  const source = demoPrefixed.length > 0
    ? demoPrefixed
    : events.map(toScene).filter((scene): scene is DemoScene => scene !== null);
  return source.sort((a, b) => a.atSimTimeSec - b.atSimTimeSec);
}

/**
 * R2-UX-08: WHY the script cannot play — the console used to collapse every
 * cause into one「剧本时刻已过」tooltip, telling never-scripted worlds the
 * wrong story. 'none' = the scenario carries no timed events at all;
 * 'tooShort' = some, but below MIN_DEMO_SCENES; 'elapsed' = the sim clock
 * already passed the last scene.
 */
export type DemoPlayableState = 'playable' | 'none' | 'tooShort' | 'elapsed';

export function demoPlayableState(
  scenes: readonly DemoScene[],
  simTimeSec: number | undefined,
): DemoPlayableState {
  if (scenes.length === 0) return 'none';
  if (scenes.length < MIN_DEMO_SCENES) return 'tooShort';
  if (typeof simTimeSec !== 'number') return 'elapsed';
  // At least the last scene must still be ahead — a fully elapsed script
  // cannot be replayed into the same run.
  return scenes[scenes.length - 1]!.atSimTimeSec > simTimeSec ? 'playable' : 'elapsed';
}

/** Is the script still playable (its scenes lie in the sim's future)? */
export function demoPlayable(scenes: readonly DemoScene[], simTimeSec: number | undefined): boolean {
  return demoPlayableState(scenes, simTimeSec) === 'playable';
}

/** The scene the player should jump to next given the current sim clock. */
export function nextSceneIndex(
  scenes: readonly DemoScene[],
  simTimeSec: number,
): number {
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i]!.atSimTimeSec > simTimeSec) return i;
  }
  return scenes.length; // all elapsed → finished
}

// ---------------------------------------------------------------------------
// T-114: chunked `step --to`
// ---------------------------------------------------------------------------

/**
 * Client-side cap mirror of the server's EAF_MAX_STEP_TICKS (default 600):
 * one `step --to` beyond it answers 422 STEP_TOO_LARGE, which used to abort
 * the demo player's single big jump (a fresh 1× sim stepping to 28800s).
 */
export const STEP_CHUNK_MAX_TICKS = 600;

/**
 * Plan the intermediate `step --to` targets that walk a sim from
 * `currentSec` to `targetSec` without ever exceeding `maxTicks` ticks per
 * call (the server derives ticks = ceil((to − now) / speed), so each chunk
 * advances at most maxTicks × speed sim-seconds; the last chunk lands
 * exactly on targetSec). Empty when targetSec ≤ currentSec or the inputs
 * are not usable — callers treat that as "nothing to step".
 */
export function planStepChunks(
  targetSec: number,
  currentSec: number,
  speed: number,
  maxTicks: number = STEP_CHUNK_MAX_TICKS,
): number[] {
  if (!Number.isFinite(targetSec) || !Number.isFinite(currentSec)) return [];
  if (!(speed > 0) || !(maxTicks > 0)) return [];
  const targets: number[] = [];
  let current = currentSec;
  for (let guard = 0; guard < 10_000 && current < targetSec; guard++) {
    const next = Math.min(current + maxTicks * speed, targetSec);
    targets.push(next);
    current = next;
  }
  return targets;
}

/**
 * Walk a sim to `targetSec` via successive `step --to` calls, each within
 * the server's per-request tick cap. `stepTo` returns the LANDED sim time
 * (the server may overshoot a target by < speed), which becomes the base
 * for the next chunk — overshoot-tolerant and safe with speed changes
 * mid-walk (re-invoke with the new speed). A non-advancing backend trips
 * the iteration guard instead of looping forever; provider 422s still
 * surface as the last-resort error.
 */
export async function stepToInChunks(
  targetSec: number,
  currentSec: number,
  speed: number,
  stepTo: (targetSec: number) => Promise<number>,
  maxTicks: number = STEP_CHUNK_MAX_TICKS,
  maxIterations: number = 10_000,
): Promise<void> {
  let current = currentSec;
  for (let guard = 0; guard < maxIterations; guard++) {
    const [next] = planStepChunks(targetSec, current, speed, maxTicks);
    if (next === undefined) return;
    current = await stepTo(next);
  }
  throw new Error(`Stepping to ${targetSec}s did not converge — the simulation clock is not advancing`);
}
