/**
 * Sim status header derivation (W7) — the "is it even running?" answer.
 *
 * Pure and wall-clock driven: the component supplies `now` (a 1s ticker) so
 * the readouts visibly tick between polls. Guidance-chip text is sourced from
 * the global i18next instance (`simStatus` namespace) so it tracks the active
 * UI language; the component re-renders on language change and the next tick
 * picks up the new bundle. Three outputs:
 *
 * - activity age: seconds since the last visible activity (latest of
 *   recentDecisions / event-log entries — i.e. stream event frames), bucketed
 *   green <10s, amber <60s, red beyond (`activityTone`);
 * - guidance chip: the running-quiet explanation. Precedence:
 *   stream down (danger) > created (info) > running-quiet with a pending
 *   scheduled event (info) > running-quiet with nothing pending (warn).
 *   "Quiet" means no activity for QUIET_GUIDANCE_SEC wall seconds, measured
 *   from `consoleOpenedAt` when nothing has ever happened (so a freshly
 *   started sim gets a grace period instead of an instant warning);
 * - `formatSimTime`: mm:ss under an hour, hh:mm:ss beyond.
 */

import type { EngineRuntimeState, ScheduledEventStatus } from '../api/types';
import i18n from '../i18n/config';

export type ActivityTone = 'fresh' | 'stale' | 'quiet';
export type GuidanceTone = 'info' | 'warn' | 'danger';

export interface GuidanceChip {
  tone: GuidanceTone;
  text: string;
}

export interface SimStatusInput {
  state: EngineRuntimeState | null;
  simTimeSec: number;
  /** Event-stream health ('down' overrides everything else). */
  streamStatus: string;
  /** Wall ms of the latest visible activity, null when none seen yet. */
  lastActivityAt: number | null;
  /** Earliest unfired scheduled event ahead of simTime (sim seconds). */
  nextScheduledAtSec: number | null;
  /** Wall ms when the console attached (quiet-period grace baseline). */
  consoleOpenedAt: number;
  /** Wall ms now. */
  now: number;
}

export interface SimStatus {
  /** Seconds since the last activity; null when nothing seen yet. */
  activityAgeSec: number | null;
  activityTone: ActivityTone;
  guidance: GuidanceChip | null;
}

export const ACTIVITY_FRESH_SEC = 10;
export const ACTIVITY_STALE_SEC = 60;
export const QUIET_GUIDANCE_SEC = 15;

export function activityToneOf(ageSec: number): ActivityTone {
  if (ageSec < ACTIVITY_FRESH_SEC) return 'fresh';
  if (ageSec < ACTIVITY_STALE_SEC) return 'stale';
  return 'quiet';
}

export function deriveSimStatus(input: SimStatusInput): SimStatus {
  const activityAgeSec =
    input.lastActivityAt === null
      ? null
      : Math.max(0, Math.floor((input.now - input.lastActivityAt) / 1000));
  const activityTone = activityToneOf(
    activityAgeSec ?? Math.max(0, (input.now - input.consoleOpenedAt) / 1000),
  );

  return { activityAgeSec, activityTone, guidance: guidanceOf(input) };
}

function guidanceOf(input: SimStatusInput): GuidanceChip | null {
  const t = i18n.getFixedT(i18n.language, 'simStatus');
  if (input.streamStatus === 'down') {
    return { tone: 'danger', text: t('streamDown') };
  }
  if (input.state === 'created') {
    return { tone: 'info', text: t('created') };
  }
  if (input.state !== 'running') return null;

  const quietSince = input.lastActivityAt ?? input.consoleOpenedAt;
  const quietSec = (input.now - quietSince) / 1000;
  if (quietSec <= QUIET_GUIDANCE_SEC) return null;

  if (input.nextScheduledAtSec !== null) {
    const remaining = Math.max(0, Math.round(input.nextScheduledAtSec - input.simTimeSec));
    return {
      tone: 'info',
      text: t('waitingForScheduled', { next: input.nextScheduledAtSec, remaining }),
    };
  }
  return { tone: 'warn', text: t('quietNoActivity') };
}

/** Earliest unfired scheduled event strictly ahead of the current sim time. */
export function nextScheduledEventSec(
  events: readonly ScheduledEventStatus[],
  simTimeSec: number,
): number | null {
  let best: number | null = null;
  for (const event of events) {
    if (event.fired || event.atSimTimeSec === undefined) continue;
    if (event.atSimTimeSec <= simTimeSec) continue;
    if (best === null || event.atSimTimeSec < best) best = event.atSimTimeSec;
  }
  return best;
}

/** mm:ss under an hour, hh:mm:ss beyond (always zero-padded). */
export function formatSimTime(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${mm}:${ss}`;
  return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
}
