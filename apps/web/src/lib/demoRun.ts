/**
 * Demo-run orchestration (plan-r81 B2 / Fix-39 残余): the pure helpers behind
 * the world view's「演示模式」button and the DemoModeBanner.
 *
 * A demo run starts a FRESH private simulation from a demo-annotated
 * environment (EnvironmentDetail.demo, T-032), plays it at the recommended
 * rate (10× for starter-home), injects the hero event immediately (the engine
 * consumes the scripted duplicate — a manual injection carrying a scripted
 * event id marks it fired), and ends once sim time passes the last scripted
 * event plus a dwell so the recovery tail (空调制冷 → 温度回落) stays visible;
 * the banner then stops the demo simulation so it never lingers as an orphan
 * run (F2).
 */

import type { ScenarioEvent } from '../api/types';

/** One scripted-arc step on the banner's stepper. */
export interface DemoPhase {
  id: string;
  /** Event type — the fallback label when no i18n key matches the id. */
  type: string;
  atSimTimeSec: number;
}

/**
 * Sim-seconds the demo keeps playing past the LAST scripted event, so the
 * actuation tail (AC cooling, temperature settling) is part of the show
 * rather than cutting at the final stimulus.
 */
export const DEMO_END_DWELL_SEC = 240;

/** Fallback playback rate when the demo metadata carries none. */
export const DEMO_DEFAULT_RATE = 10;

/** Scripted arc = events with an atSimTimeSec, sorted by fire time. */
export function demoPhases(events: readonly ScenarioEvent[]): DemoPhase[] {
  return events
    .filter(
      (event): event is ScenarioEvent & { atSimTimeSec: number } =>
        typeof event.atSimTimeSec === 'number',
    )
    .map(event => ({ id: event.id, type: event.type, atSimTimeSec: event.atSimTimeSec }))
    .sort((a, b) => a.atSimTimeSec - b.atSimTimeSec);
}

/** Sim-time at which the demo auto-ends (last scripted event + dwell). */
export function demoEndSimTimeSec(events: readonly ScenarioEvent[]): number {
  const phases = demoPhases(events);
  const last = phases[phases.length - 1];
  return (last?.atSimTimeSec ?? 0) + DEMO_END_DWELL_SEC;
}

/**
 * Index of the phase currently on stage (the first not-yet-fired scripted
 * event); -1 once every scripted event has fired — the recovery tail. An
 * event injected manually at demo start (heroEventId) counts as fired from
 * t=0 even though its scripted atSimTimeSec is still in the future.
 */
export function activeDemoPhaseIndex(
  phases: readonly DemoPhase[],
  simTimeSec: number,
  injectedEventId: string | null,
): number {
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const fired = phase.id === injectedEventId || phase.atSimTimeSec <= simTimeSec;
    if (!fired) return index;
  }
  return -1;
}

/** One playback measurement: sim clock vs wall clock at a snapshot poll. */
export interface DemoRateSample {
  simTimeSec: number;
  atMs: number;
}

/**
 * EMA-smoothed EFFECTIVE playback rate (sim seconds per wall second) from
 * consecutive poll samples. autoThrottle can drag the real rate far below
 * the requested one (600× → ~150× on large worlds) — the banner narrates
 * this measured rate, not the configured promise. Returns the previous
 * estimate when the sample pair is unusable (no sim progress, clock skew).
 */
export function smoothDemoRate(
  prev: number | null,
  from: DemoRateSample,
  to: DemoRateSample,
): number | null {
  const dSim = to.simTimeSec - from.simTimeSec;
  const dWallMs = to.atMs - from.atMs;
  if (dSim <= 0 || dWallMs <= 0) return prev;
  const instant = (dSim * 1000) / dWallMs;
  return prev === null ? instant : prev * 0.6 + instant * 0.4;
}

/** Wall seconds until the arc ends at the measured rate; null when unknown. */
export function demoEtaSeconds(
  endsAtSimTimeSec: number,
  simTimeSec: number,
  rate: number | null,
): number | null {
  if (rate === null || rate <= 0) return null;
  return Math.max(0, Math.ceil((endsAtSimTimeSec - simTimeSec) / rate));
}
