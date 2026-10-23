/**
 * Due-moment computation (living-worlds P1, design-living-worlds.md §8.2) —
 * L2 pure shaping.
 *
 * A DUE MOMENT is a sim-time at which the world MUST execute its tick body
 * (fireDueEvents + flow onTick) to behave identically to a per-tick run.
 * Between due moments a lazy run (EngineRuntime.advanceTo) integrates physics
 * at PHYSICS_SUBSTEP_SEC and skips the per-tick body — the laziness saving.
 *
 * SOURCES (all SIM-clock, all derivable from the runtime's own state):
 *   1. scenario scheduled events      — events[].atSimTimeSec, unfired
 *   2. occupantSchedule boundaries    — per-zone arrive/depart per simulated day
 *   3. flow schedule triggers         — one-shot atSimTimeSec + periodic
 *                                       everySimSec crossings (window [start,end])
 *                                       + FEAT-01 daily anchors (atTimeOfDaySec,
 *                                       relativeToOccupancy)
 *   4. flow condition triggers        — re-eval cadence (edge semantics: a
 *                                       condition can rise and fall between
 *                                       evaluations, so the bit-exact cadence
 *                                       is the tick granularity)
 *   5. flow cooldown expiries         — cooldownSimSec re-arm points
 *   6. Fix-12 pending effect checks   — pendingEffectChecks[].dueSimSec
 *   7. external SIM-clock duties      — caller-registered (server maps its
 *                                       wall-clock duties — terms.read
 *                                       freshness floors — through the sim's
 *                                       wall-clock rate before registering)
 *   8. FEAT-06 flow wait runs         — pendingFlowWaits[].dueSimSec (runs
 *                                       parked on wait nodes; a lazy world
 *                                       must wake when the wait expires)
 *
 * EXPLICIT NON-SOURCES (observation-side, wall-clock artifacts — design §8.2
 * marks them "墙钟" rows; they never gate engine advancement):
 *   - zone-sampler cadence (sim-timeline.ts's 200ms wall poll; capture
 *     fidelity, not world evolution — P0 deviation #5)
 *   - WS stream push cadence / batch flush (STREAM_FLUSH_MS)
 *   - terms.read.cadenceSec push rhythm (a DECLARED soft observation bound;
 *     only minFreshnessSec is contractual, and it is registered by the server
 *     as an external due — the engine itself has no wall clock)
 *   - LLM-anything (§16.8: LLM never enters due computation)
 *
 * Injected events are NOT a source: injections execute at the caller's
 * current sim time (the inject route has no atSimTimeSec); drivers that
 * schedule injections by sim time (eval-run-service) own those moments.
 */

import type { DueMoment, DueMomentKind, DueMomentSources, EngineRuntimeState } from '../contract.js';
import type { FlowDefinition } from '../../flows/flow-types.js';

const DAY_SEC = 86400;

/** Smallest strictly-greater candidate from a list, merged into `into`. */
function offer(
  into: Map<number, DueMoment>,
  atSimSec: number,
  kind: DueMomentKind,
  label: string,
): void {
  if (!Number.isFinite(atSimSec)) return;
  const existing = into.get(atSimSec);
  if (existing === undefined) {
    into.set(atSimSec, { atSimSec, kinds: [kind], labels: [label] });
    return;
  }
  if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
  if (!existing.labels.includes(label)) existing.labels.push(label);
}

/** The occupant-schedule sub-shape both the engine and the predictor read. */
export interface OccupancyScheduleLike {
  zoneId: string;
  startSimTimeSec: number;
  endSimTimeSec: number;
  repeatDaily?: boolean;
}

export type OccupancyTransitionKind = 'arrive' | 'depart';

/**
 * The ONE fired-state key format (R21-W2): `${zoneId}:${kind}:${day}` with
 * the day component pinned to 0 for one-shot schedules. Persisted in
 * checkpoints (occupancyFiredKeys) — DO NOT change the format.
 */
export function occupancyBoundaryKey(
  zoneId: string,
  kind: OccupancyTransitionKind,
  repeatDaily: boolean,
  day: number,
): string {
  return `${zoneId}:${kind}:${repeatDaily ? day : 0}`;
}

/**
 * The ONE occupancy-window predicate (R21-W2, Fix-52a): which transitions
 * are due AT `simTimeSec`, given the consumed-boundary memory. Arrive fires
 * at the first tick whose time-of-day ∈ [start, end); depart at the first
 * tick whose time-of-day ≥ end. Execution (EngineRuntime's tick body) and
 * prediction (occupancyBoundaries below) both route through here — the
 * "mirror exactly" comment era is over; there is one semantics.
 */
export function occupancyTransitionsDue(
  sched: OccupancyScheduleLike,
  firedKeys: ReadonlySet<string>,
  simTimeSec: number,
): Array<{ kind: OccupancyTransitionKind; key: string }> {
  const repeat = sched.repeatDaily ?? true;
  const day = Math.floor(simTimeSec / DAY_SEC);
  const timeOfDay = simTimeSec % DAY_SEC;
  const out: Array<{ kind: OccupancyTransitionKind; key: string }> = [];
  const arriveKey = occupancyBoundaryKey(sched.zoneId, 'arrive', repeat, day);
  if (
    timeOfDay >= sched.startSimTimeSec && timeOfDay < sched.endSimTimeSec &&
    !firedKeys.has(arriveKey)
  ) {
    out.push({ kind: 'arrive', key: arriveKey });
  }
  const departKey = occupancyBoundaryKey(sched.zoneId, 'depart', repeat, day);
  if (timeOfDay >= sched.endSimTimeSec && !firedKeys.has(departKey)) {
    out.push({ kind: 'depart', key: departKey });
  }
  return out;
}

/** A zone-declared occupant schedule as scenarios carry it (zoneId comes from the zone). */
export type OccupantScheduleWithCount = Omit<OccupancyScheduleLike, 'zoneId'> & { count: number };

/**
 * FEAT-07 phase-2 (calendar overlay): a zone's TEMPORARY timetable — the
 * overlay schedule replaces the base occupantSchedule inside the absolute
 * sim-time window `[startsAtSimSec, endsAtSimSec)` (exam-week extended
 * library hours); at `endsAtSimSec` the base timetable governs again. The
 * window boundaries are themselves occupancy due moments (a lazy world
 * wakes for them) and each runs the patch catch-up discipline: an
 * in-window arrive corrects the headcount immediately, a past depart is
 * consumed WITHOUT zeroing (last write wins — explicit occupancy events
 * are never stomped).
 */
export interface OccupantScheduleOverlay {
  schedule: OccupantScheduleWithCount;
  /** Absolute sim-second the overlay starts governing (inclusive). */
  startsAtSimSec: number;
  /** Absolute sim-second the overlay stops governing (exclusive; must exceed startsAtSimSec). */
  endsAtSimSec: number;
}

/** The zone occupancy-timetable shape the tick body and the predictor read. */
export interface ZoneOccupancyTimetable {
  id: string;
  occupantSchedule?: OccupantScheduleWithCount;
  occupantScheduleOverlay?: OccupantScheduleOverlay;
}

/** Whether the overlay governs at `simTimeSec` (window `[startsAt, endsAt)`). */
export function overlayActiveAt(overlay: OccupantScheduleOverlay, simTimeSec: number): boolean {
  return simTimeSec >= overlay.startsAtSimSec && simTimeSec < overlay.endsAtSimSec;
}

/** The schedule governing `simTimeSec`: the overlay inside its window, else the base. */
export function effectiveOccupantSchedule(
  zone: { occupantSchedule?: OccupantScheduleWithCount; occupantScheduleOverlay?: OccupantScheduleOverlay },
  simTimeSec: number,
): OccupantScheduleWithCount | undefined {
  const overlay = zone.occupantScheduleOverlay;
  if (
    overlay !== undefined &&
    overlay.endsAtSimSec > overlay.startsAtSimSec &&
    overlayActiveAt(overlay, simTimeSec)
  ) {
    return overlay.schedule;
  }
  return zone.occupantSchedule;
}

/**
 * Overlay transition markers live in the SAME persisted occupancyFiredKeys
 * set as the boundary keys (checkpoints carry them; the `${zoneId}:arrive:`
 * /`${zoneId}:depart:` cleanup never matches this shape, so a base-schedule
 * PATCH does not cancel pending overlay transitions).
 */
export function overlayTransitionKey(
  zoneId: string,
  kind: 'enter' | 'exit',
  atSimSec: number,
): string {
  return `${zoneId}:overlay-${kind}:${atSimSec}`;
}

/** Drop a zone's consumed arrive/depart boundary memory (patch discipline). */
function resetZoneOccupancyKeys(firedKeys: Set<string>, zoneId: string): void {
  for (const key of [...firedKeys]) {
    if (key.startsWith(`${zoneId}:arrive:`) || key.startsWith(`${zoneId}:depart:`)) {
      firedKeys.delete(key);
    }
  }
}

/**
 * The patch catch-up half: consume the schedule's transitions due at
 * `simTimeSec`; an in-window arrive RETURNS its count for the caller to
 * write immediately, a past depart is consumed WITHOUT a write (last write
 * wins — never stomp an explicit occupancy override).
 */
function consumeScheduleCatchUp(
  zoneId: string,
  sched: OccupantScheduleWithCount,
  firedKeys: Set<string>,
  simTimeSec: number,
): number | undefined {
  let arriveCount: number | undefined;
  for (const due of occupancyTransitionsDue({ ...sched, zoneId }, firedKeys, simTimeSec)) {
    firedKeys.add(due.key);
    if (due.kind === 'arrive') arriveCount = sched.count;
  }
  return arriveCount;
}

/**
 * FEAT-07 phase-2 tick-body half: fire a zone's pending overlay ENTER/EXIT
 * transitions at `simTimeSec` (markers consumed once, persisted with the
 * fired keys). Each transition resets the zone's boundary memory and runs
 * the catch-up discipline onto the newly governing schedule; a window the
 * world jumped entirely past consumes both markers and reconciles to the
 * base timetable only.
 */
function applyOverlayTransitions(
  zone: ZoneOccupancyTimetable,
  firedKeys: Set<string>,
  simTimeSec: number,
  write: (zoneId: string, count: number) => void,
): void {
  const overlay = zone.occupantScheduleOverlay;
  if (overlay === undefined) return;
  if (!(overlay.endsAtSimSec > overlay.startsAtSimSec)) return; // defensive: invalid windows never govern
  const enterKey = overlayTransitionKey(zone.id, 'enter', overlay.startsAtSimSec);
  const exitKey = overlayTransitionKey(zone.id, 'exit', overlay.endsAtSimSec);
  if (simTimeSec >= overlay.startsAtSimSec && !firedKeys.has(enterKey)) {
    firedKeys.add(enterKey);
    if (simTimeSec < overlay.endsAtSimSec) {
      resetZoneOccupancyKeys(firedKeys, zone.id);
      const arriveCount = consumeScheduleCatchUp(zone.id, overlay.schedule, firedKeys, simTimeSec);
      if (arriveCount !== undefined) write(zone.id, arriveCount);
    }
  }
  if (simTimeSec >= overlay.endsAtSimSec && !firedKeys.has(exitKey)) {
    firedKeys.add(exitKey);
    resetZoneOccupancyKeys(firedKeys, zone.id);
    const base = zone.occupantSchedule;
    if (base !== undefined) {
      const arriveCount = consumeScheduleCatchUp(zone.id, base, firedKeys, simTimeSec);
      if (arriveCount !== undefined) write(zone.id, arriveCount);
    }
  }
}

/**
 * Fix-52a execution half (T43 extraction — pure): per zone, the occupancy
 * WRITES due at `simTimeSec` — `arrive` → the schedule's count, `depart` → 0.
 * The tick body applies rows verbatim (consume `key`, then write `count`),
 * keeping EngineRuntime write-only over the same predicate the predictor
 * mirrors.
 */
export function occupantScheduleWrites(
  zones: ReadonlyArray<{ id: string; occupantSchedule?: OccupantScheduleWithCount }>,
  firedKeys: ReadonlySet<string>,
  simTimeSec: number,
): Array<{ zoneId: string; count: number; key: string }> {
  const out: Array<{ zoneId: string; count: number; key: string }> = [];
  for (const zone of zones) {
    const sched = zone.occupantSchedule;
    if (!sched) continue;
    for (const due of occupancyTransitionsDue({ ...sched, zoneId: zone.id }, firedKeys, simTimeSec)) {
      out.push({ zoneId: zone.id, count: due.kind === 'arrive' ? sched.count : 0, key: due.key });
    }
  }
  return out;
}

/**
 * Fix-52a tick body (FEAT-07 extraction — pure): apply the due occupancy
 * writes — consume each `key`, then hand the write to the caller (the
 * engine keeps the setZoneOccupancy write itself, guarding unbounded zones).
 * FEAT-07 phase-2: overlay ENTER/EXIT transitions fire first (marker
 * consumption + catch-up onto the newly governing schedule), then the
 * EFFECTIVE schedule's due transitions — inside the window the overlay's
 * boundaries, outside it the base timetable's.
 */
export function applyOccupantScheduleWrites(
  zones: ReadonlyArray<ZoneOccupancyTimetable>,
  firedKeys: Set<string>,
  simTimeSec: number,
  write: (zoneId: string, count: number) => void,
): void {
  for (const zone of zones) {
    applyOverlayTransitions(zone, firedKeys, simTimeSec, write);
    const sched = effectiveOccupantSchedule(zone, simTimeSec);
    if (sched === undefined) continue;
    for (const due of occupancyTransitionsDue({ ...sched, zoneId: zone.id }, firedKeys, simTimeSec)) {
      firedKeys.add(due.key);
      write(zone.id, due.kind === 'arrive' ? sched.count : 0);
    }
  }
}

/**
 * FEAT-07 (pure): install/replace/clear a zone's occupantSchedule on a LIVE
 * world. The zone's consumed-boundary memory is dropped first — keys of the
 * OLD schedule share the `${zoneId}:${kind}:${day}` shape and would
 * otherwise block the new schedule's boundaries.
 *
 * Catch-up semantics (conservative): boundaries already past at patch time
 * are consumed WITHOUT their writes, EXCEPT an in-window arrive whose count
 * is RETURNED for the caller to apply immediately (lazy advance would
 * otherwise hold the old headcount until the depart boundary). A past
 * depart is never replayed: the patch must not stomp an explicit occupancy
 * override (last write wins). `schedule === null` clears the timetable —
 * the current headcount stands (clearing is not an eviction).
 */
export function patchZoneOccupantSchedule(
  zone: { occupantSchedule?: OccupantScheduleWithCount },
  zoneId: string,
  schedule: OccupantScheduleWithCount | null,
  firedKeys: Set<string>,
  simTimeSec: number,
): { arriveCount: number | undefined } {
  resetZoneOccupancyKeys(firedKeys, zoneId);
  if (schedule === null) {
    delete zone.occupantSchedule;
    return { arriveCount: undefined };
  }
  zone.occupantSchedule = { ...schedule };
  return { arriveCount: consumeScheduleCatchUp(zoneId, schedule, firedKeys, simTimeSec) };
}

/** The EngineRuntime surface the FEAT-07 occupantSchedule patch seam needs. */
export interface OccupantSchedulePatchRuntime {
  readonly scenario: {
    zones: Array<{
      id: string;
      occupantSchedule?: OccupantScheduleWithCount;
      occupantScheduleOverlay?: OccupantScheduleOverlay;
    }>;
  };
  getState(): EngineRuntimeState;
  getSimTimeSec(): number;
  getOccupancyScheduleFiredKeys(): Set<string>;
  setZoneOccupancy(zoneId: string, occupancy: number): void;
}

/**
 * FEAT-07 runtime entry (the server's env-level PATCH lane — no environment
 * rebuild): install/replace (`schedule`) or clear (`null`) a zone's
 * occupantSchedule on a live runtime. Catch-up semantics in
 * patchZoneOccupantSchedule; the lazy-advance predictor reads the same
 * zones array, so the next due moment reflects the change. Returns whether
 * the in-window headcount correction fired.
 *
 * FEAT-07 phase-2 (calendar overlay): with `overlay` given (object =
 * install/replace, null = clear) the call carries the zone's RESULTING
 * timetable state — `{schedule, overlay}` — and reconciles the live world:
 * an overlay whose window covers NOW takes over immediately (its enter
 * marker is consumed so the boundary transition does not re-fire, and the
 * in-window arrive corrects the headcount); an overlay cleared while it
 * governed reverts to the base timetable with the same catch-up; a future
 * window waits for its due-moment boundary; an already-expired window is
 * stored with both markers silently consumed (installing history never
 * touches the standing headcount). A base-schedule change in the same call
 * keeps the phase-1 catch-up discipline unless the overlay governs now.
 */
export function updateZoneOccupantSchedule(
  runtime: OccupantSchedulePatchRuntime,
  zoneId: string,
  schedule: OccupantScheduleWithCount | null,
  overlay?: OccupantScheduleOverlay | null,
): { occupancyCorrected: boolean } {
  if (runtime.getState() === 'stopped') {
    throw new Error('updateZoneOccupantSchedule: runtime is stopped');
  }
  const zone = runtime.scenario.zones.find(z => z.id === zoneId);
  if (zone === undefined) {
    throw new Error(`updateZoneOccupantSchedule: unknown zone "${zoneId}"`);
  }
  const firedKeys = runtime.getOccupancyScheduleFiredKeys();
  const now = runtime.getSimTimeSec();
  if (overlay === undefined) {
    // Phase-1 lane (base timetable only) — behavior unchanged.
    const { arriveCount } = patchZoneOccupantSchedule(zone, zoneId, schedule, firedKeys, now);
    if (arriveCount !== undefined) runtime.setZoneOccupancy(zoneId, arriveCount);
    return { occupancyCorrected: arriveCount !== undefined };
  }
  const previousOverlay = zone.occupantScheduleOverlay;
  const previousBase = zone.occupantSchedule;
  if (previousOverlay !== undefined) {
    // Retire the old window's transition markers so its boundaries never
    // fire spuriously after the replace/clear.
    firedKeys.delete(overlayTransitionKey(zoneId, 'enter', previousOverlay.startsAtSimSec));
    firedKeys.delete(overlayTransitionKey(zoneId, 'exit', previousOverlay.endsAtSimSec));
  }
  if (schedule === null) delete zone.occupantSchedule;
  else zone.occupantSchedule = { ...schedule };
  if (overlay === null) delete zone.occupantScheduleOverlay;
  else {
    zone.occupantScheduleOverlay = {
      schedule: { ...overlay.schedule },
      startsAtSimSec: overlay.startsAtSimSec,
      endsAtSimSec: overlay.endsAtSimSec,
    };
  }
  const baseChanged = JSON.stringify(previousBase ?? null) !== JSON.stringify(schedule ?? null);
  const current = zone.occupantScheduleOverlay;
  let arriveCount: number | undefined;
  if (current !== undefined && current.endsAtSimSec > current.startsAtSimSec && overlayActiveAt(current, now)) {
    firedKeys.add(overlayTransitionKey(zoneId, 'enter', current.startsAtSimSec));
    resetZoneOccupancyKeys(firedKeys, zoneId);
    arriveCount = consumeScheduleCatchUp(zoneId, current.schedule, firedKeys, now);
  } else if (current !== undefined && now >= current.endsAtSimSec) {
    firedKeys.add(overlayTransitionKey(zoneId, 'enter', current.startsAtSimSec));
    firedKeys.add(overlayTransitionKey(zoneId, 'exit', current.endsAtSimSec));
    if (baseChanged && zone.occupantSchedule !== undefined) {
      resetZoneOccupancyKeys(firedKeys, zoneId);
      arriveCount = consumeScheduleCatchUp(zoneId, zone.occupantSchedule, firedKeys, now);
    }
  } else if (
    baseChanged ||
    (current === undefined && previousOverlay !== undefined && overlayActiveAt(previousOverlay, now))
  ) {
    // Overlay cleared while it governed → revert to the base timetable now;
    // or the base timetable itself changed while the base governs (no
    // overlay, or a future/expired one) → the phase-1 catch-up on the base.
    resetZoneOccupancyKeys(firedKeys, zoneId);
    if (zone.occupantSchedule !== undefined) {
      arriveCount = consumeScheduleCatchUp(zoneId, zone.occupantSchedule, firedKeys, now);
    }
  }
  if (arriveCount !== undefined) runtime.setZoneOccupancy(zoneId, arriveCount);
  return { occupancyCorrected: arriveCount !== undefined };
}

/**
 * Occupant-schedule boundaries strictly after `fromSimSec`, within
 * `horizonSimSec` (bounded enumeration; the days scanned cap at the horizon,
 * or current+next day when the horizon is infinite — the engine's live loop
 * only ever asks for the FIRST moment). A boundary is a moment where
 * occupancyTransitionsDue (the shared predicate) would fire something NEW
 * for this schedule state — prediction is derived from the execution truth,
 * not mirrored beside it. Fired-key memory lets already-consumed boundaries
 * be skipped (a repeatDaily schedule would otherwise offer the same
 * boundary forever).
 */
export function occupancyBoundaries(
  sched: OccupancyScheduleLike,
  firedKeys: ReadonlySet<string>,
  fromSimSec: number,
  horizonSimSec: number = Number.POSITIVE_INFINITY,
  window?: { startSimSec: number; endSimSec: number },
): Array<{ atSimSec: number; key: string }> {
  const repeat = sched.repeatDaily ?? true;
  // FEAT-07 phase-2: an overlay schedule enumerates only the boundaries
  // inside its governing window `[startSimSec, endSimSec)`.
  const wStart = window?.startSimSec ?? Number.NEGATIVE_INFINITY;
  const wEnd = window?.endSimSec ?? Number.POSITIVE_INFINITY;
  const fromDay = Math.floor(Math.max(fromSimSec, wStart) / DAY_SEC);
  const lastDay = Number.isFinite(horizonSimSec)
    ? Math.floor(Math.min(horizonSimSec, wEnd) / DAY_SEC)
    : Number.isFinite(wEnd)
      ? Math.max(fromDay, Math.floor(wEnd / DAY_SEC))
      : fromDay + 1;
  const out: Array<{ atSimSec: number; key: string }> = [];
  for (let day = repeat ? fromDay : 0; day <= lastDay; day++) {
    for (const [kind, timeOfDay] of [
      ['arrive', sched.startSimTimeSec],
      ['depart', sched.endSimTimeSec],
    ] as const) {
      const atSimSec = day * DAY_SEC + timeOfDay;
      if (atSimSec <= fromSimSec || atSimSec > horizonSimSec) continue;
      if (atSimSec < wStart || atSimSec >= wEnd) continue;
      // Firing gate (the shared predicate): the degenerate-window arrive
      // candidate (end ≤ start) still passes — depart is due at that
      // moment — so the historical "harmless extra evaluation" offer is
      // preserved while every offered boundary is now provably a firing
      // moment of the SAME predicate the tick body runs.
      if (occupancyTransitionsDue(sched, firedKeys, atSimSec).length === 0) continue;
      const key = occupancyBoundaryKey(sched.zoneId, kind, repeat, day);
      if (firedKeys.has(key)) continue;
      out.push({ atSimSec, key });
      // Unbounded asks mean "next" (nextDueMoment) — first entry per stream.
      if (!Number.isFinite(horizonSimSec)) return out;
    }
    if (!repeat) break; // one-shot schedules have day 0 only
  }
  return out;
}

/** The first occupancy boundary strictly after `fromSimSec` (or undefined). */
export function nextOccupancyBoundary(
  sched: OccupancyScheduleLike,
  firedKeys: ReadonlySet<string>,
  fromSimSec: number,
): { atSimSec: number; key: string } | undefined {
  return occupancyBoundaries(sched, firedKeys, fromSimSec)[0];
}

/**
 * Periodic-schedule crossings strictly after `fromSimSec`, mirroring
 * FlowEngine.shouldFireSchedule's (prev, cur] math: every
 * `start + k * every` (k ≥ 0; k ≥ 1 when from ≥ start) bounded by the
 * optional endAtSimTimeSec window and by `horizonSimSec` (bounded
 * enumeration — infinite horizons return at most the first crossing).
 */
export function periodicCrossings(
  trigger: {
    everySimSec?: number;
    startAtSimTimeSec?: number;
    endAtSimTimeSec?: number;
  },
  fromSimSec: number,
  horizonSimSec: number = Number.POSITIVE_INFINITY,
): number[] {
  const every = trigger.everySimSec;
  if (every === undefined || !(every > 0)) return [];
  const start = trigger.startAtSimTimeSec ?? 0;
  const end = trigger.endAtSimTimeSec;
  const effectiveEnd = end !== undefined && end < horizonSimSec ? end : horizonSimSec;
  if (!Number.isFinite(effectiveEnd) && effectiveEnd !== Number.POSITIVE_INFINITY) return [];
  const out: number[] = [];
  const firstK = fromSimSec < start
    ? 0
    : Math.floor((fromSimSec - start) / every) + 1;
  for (let k = firstK; ; k++) {
    const at = start + k * every;
    if (at <= fromSimSec) continue;
    if (at > effectiveEnd) break;
    out.push(at);
    if (!Number.isFinite(horizonSimSec)) break; // unbounded ask → first only
  }
  return out;
}

/** The first periodic crossing strictly after `fromSimSec` (or undefined). */
export function nextPeriodicCrossing(
  trigger: {
    everySimSec?: number;
    startAtSimTimeSec?: number;
    endAtSimTimeSec?: number;
  },
  fromSimSec: number,
): number | undefined {
  return periodicCrossings(trigger, fromSimSec)[0];
}

/**
 * FEAT-01: daily-anchor crossings strictly after `fromSimSec`, mirroring
 * FlowEngine.dueDailyScheduleKeys' (prev, cur] math: `atTimeOfDaySec` fires
 * at every `day*DAY_SEC + atTimeOfDaySec`, and `relativeToOccupancy` fires at
 * `day*DAY_SEC + boundarySec - offsetSec` for each matching occupantSchedule
 * (pinned to relativeToOccupancy.zoneId when declared; repeatDaily: false
 * schedules anchor day 0 only). Bounded enumeration like the other streams:
 * a finite horizon enumerates every crossing within it; an infinite horizon
 * returns at most the FIRST crossing (the "next due" question). Fired-memory
 * skipping stays engine-side (same split as periodicCrossings).
 */
export function dailyScheduleCrossings(
  trigger: {
    atTimeOfDaySec?: number;
    relativeToOccupancy?: {
      zoneId?: string;
      before: 'arrive' | 'depart';
      offsetSec: number;
    };
  },
  occupancySchedules: ReadonlyArray<OccupancyScheduleLike>,
  fromSimSec: number,
  horizonSimSec: number = Number.POSITIVE_INFINITY,
): number[] {
  const bounded = Number.isFinite(horizonSimSec);
  // Unbounded asks scan today+tomorrow — enough to find each stream's first
  // crossing (an anchor fires at least once per day when any source exists).
  const scanEnd = bounded
    ? horizonSimSec
    : (Math.floor(fromSimSec / DAY_SEC) + 2) * DAY_SEC;
  const fromDay = Math.floor(fromSimSec / DAY_SEC);
  const lastDay = Math.floor(scanEnd / DAY_SEC);
  const out: number[] = [];
  const push = (at: number): void => {
    if (at > fromSimSec && at <= horizonSimSec) out.push(at);
  };
  if (trigger.atTimeOfDaySec !== undefined && Number.isFinite(trigger.atTimeOfDaySec)) {
    for (let day = fromDay; day <= lastDay; day++) {
      push(day * DAY_SEC + trigger.atTimeOfDaySec);
    }
  }
  const rel = trigger.relativeToOccupancy;
  if (rel !== undefined && Number.isFinite(rel.offsetSec)) {
    for (const sched of occupancySchedules) {
      if (rel.zoneId !== undefined && sched.zoneId !== rel.zoneId) continue;
      const repeat = sched.repeatDaily ?? true;
      const boundarySec = rel.before === 'arrive' ? sched.startSimTimeSec : sched.endSimTimeSec;
      for (let day = repeat ? fromDay : 0; day <= lastDay; day++) {
        push(day * DAY_SEC + boundarySec - rel.offsetSec);
        if (!repeat) break;
      }
    }
  }
  out.sort((a, b) => a - b);
  return bounded ? out : out.slice(0, 1);
}

/**
 * Compute due moments in `(fromSimSec, horizonSimSec]`, merged by sim-time
 * (several sources hitting the same moment collapse into one entry) and
 * sorted ascending. A FINITE horizon enumerates every moment within it; an
 * infinite horizon (the default) asks each stream for its FIRST moment only
 * (the "next due" question — bounded work even at tick-granularity cadences).
 * Explicit finite collections (scenario events, effect checks, external
 * duties) always enumerate fully. Pure: same inputs → same output, no wall
 * clock, no RNG, no exceptions on malformed input (defensive skips).
 */
export function computeDueMoments(
  sources: DueMomentSources,
  fromSimSec: number,
  horizonSimSec: number = Number.POSITIVE_INFINITY,
): DueMoment[] {
  const moments = new Map<number, DueMoment>();

  // 1. Scenario scheduled events (unfired only; observationOnly events still
  //    need their fired-marker write, so they count).
  for (const event of sources.scenarioEvents) {
    if (event.fired) continue;
    const at = event.atSimTimeSec;
    if (at === undefined || !Number.isFinite(at)) continue;
    if (at > fromSimSec && at <= horizonSimSec) offer(moments, at, 'scenario-event', event.id);
  }

  // 2. Occupant-schedule boundaries.
  const firedKeys = new Set(sources.occupancyFiredKeys);
  for (const sched of sources.occupancySchedules) {
    for (const boundary of occupancyBoundaries(sched, firedKeys, fromSimSec, horizonSimSec)) {
      offer(moments, boundary.atSimSec, 'occupancy-schedule', sched.zoneId);
    }
  }

  // 2b. FEAT-07 phase-2 calendar overlays: the window ENTER/EXIT transitions
  //     themselves (a lazy world must wake when an overlay starts/stops
  //     governing) plus the overlay schedule's in-window boundaries.
  for (const transition of sources.occupancyOverlayTransitions ?? []) {
    if (!Number.isFinite(transition.atSimSec)) continue;
    if (transition.atSimSec <= fromSimSec || transition.atSimSec > horizonSimSec) continue;
    if (firedKeys.has(transition.key)) continue;
    offer(moments, transition.atSimSec, 'occupancy-schedule', transition.zoneId);
  }
  for (const sched of sources.occupancyOverlaySchedules ?? []) {
    for (const boundary of occupancyBoundaries(sched, firedKeys, fromSimSec, horizonSimSec, {
      startSimSec: sched.windowStartSimSec,
      endSimSec: sched.windowEndSimSec,
    })) {
      offer(moments, boundary.atSimSec, 'occupancy-schedule', sched.zoneId);
    }
  }

  // 3-5. Flow triggers (enabled flows only — the engine re-reads its provider
  // so dynamically added/edited flows take effect at the next computation).
  let cadenceOffered = false;
  for (const flow of sources.flows) {
    if (!flow.enabled) continue;
    const trigger = flow.trigger;
    if (trigger.kind === 'schedule') {
      if (
        trigger.atSimTimeSec !== undefined && Number.isFinite(trigger.atSimTimeSec) &&
        !flow.scheduleFired &&
        trigger.atSimTimeSec > fromSimSec && trigger.atSimTimeSec <= horizonSimSec
      ) {
        offer(moments, trigger.atSimTimeSec, 'flow-schedule', flow.id);
      }
      for (const crossing of periodicCrossings(trigger, fromSimSec, horizonSimSec)) {
        offer(moments, crossing, 'flow-schedule', flow.id);
      }
      // FEAT-01: daily anchors (time-of-day / occupancy-relative) are due
      // moments too — lazy advance must wake for them.
      for (const crossing of dailyScheduleCrossings(trigger, sources.occupancySchedules, fromSimSec, horizonSimSec)) {
        offer(moments, crossing, 'flow-schedule', flow.id);
      }
    } else if (trigger.kind === 'condition') {
      // 4. Condition re-eval cadence: ONE stream per computation (not per
      // flow) — the first enabled condition flow pins the tick cadence.
      const cadence = sources.conditionEvalEverySimSec;
      if (!cadenceOffered && cadence !== undefined && cadence > 0) {
        cadenceOffered = true;
        const firstK = Math.floor(fromSimSec / cadence) + 1;
        for (let k = firstK; ; k++) {
          const at = k * cadence;
          if (at > horizonSimSec) break;
          if (at > fromSimSec) {
            offer(moments, at, 'flow-condition-eval', `${flow.id}(cadence)`);
            if (!Number.isFinite(horizonSimSec)) break; // unbounded → first only
          }
        }
      }
      // 5. Cooldown expiry (re-arm): with the bit-exact tick cadence the next
      // evaluation after expiry covers it; listed anyway because a coarser
      // cadence policy must not let a suppressed flow sleep past its re-arm.
      const cooldownUntil = flow.cooldownUntilSimSec;
      if (
        cooldownUntil !== undefined && Number.isFinite(cooldownUntil) &&
        cooldownUntil > fromSimSec && cooldownUntil <= horizonSimSec
      ) {
        offer(moments, cooldownUntil, 'flow-cooldown', flow.id);
      }
    } else if (trigger.kind === 'event') {
      // Event triggers fire ON injections (no sim-time schedule of their
      // own); only their cooldown re-arm is a moment.
      const cooldownUntil = flow.cooldownUntilSimSec;
      if (
        cooldownUntil !== undefined && Number.isFinite(cooldownUntil) &&
        cooldownUntil > fromSimSec && cooldownUntil <= horizonSimSec
      ) {
        offer(moments, cooldownUntil, 'flow-cooldown', flow.id);
      }
    }
  }

  // 6. Fix-12 pending effect checks.
  for (const check of sources.pendingEffectChecks) {
    const at = check.dueSimSec;
    if (!Number.isFinite(at)) continue;
    if (at > fromSimSec && at <= horizonSimSec) {
      offer(moments, at, 'effect-check', `effect-check@${at}`);
    }
  }

  // 7. External SIM-clock duties (caller-registered, already wall-mapped).
  for (const at of sources.externalDueSimSec ?? []) {
    if (!Number.isFinite(at)) continue;
    if (at > fromSimSec && at <= horizonSimSec) offer(moments, at, 'external', `external@${at}`);
  }

  // 8. FEAT-06 flow wait continuations (a lazy world must wake for a parked
  // run whose wait expires, exactly like an effect check).
  for (const wait of sources.pendingFlowWaits ?? []) {
    const at = wait.dueSimSec;
    if (!Number.isFinite(at)) continue;
    if (at > fromSimSec && at <= horizonSimSec) {
      offer(moments, at, 'flow-wait', `flow-wait@${at}`);
    }
  }

  return [...moments.values()].sort((a, b) => a.atSimSec - b.atSimSec);
}

/**
 * The first due moment strictly after `fromSimSec` (or null within the
 * horizon). Computed with an UNBOUNDED ask (each source contributes at most
 * its first candidate under that ask, so this stays O(sources) even with a
 * tick-granularity condition cadence) and then checked against the horizon —
 * if the smallest moment exceeds the horizon, every later one does too.
 */
export function nextDueMoment(
  sources: DueMomentSources,
  fromSimSec: number,
  horizonSimSec: number = Number.POSITIVE_INFINITY,
): DueMoment | null {
  const moments = computeDueMoments(sources, fromSimSec);
  const first = moments.length > 0 ? moments[0]! : null;
  if (first === null || first.atSimSec > horizonSimSec) return null;
  return first;
}

/**
 * R21-W2: the due-source ASSEMBLY, extracted from EngineRuntime (pure —
 * the runtime passes its own state in, the function builds the snapshot).
 * The flows provider is read AT MOST ONCE per call (single-read
 * determinism); provider/engine faults degrade to "no flows" (never throw:
 * a due computation must not take the world down — same tolerance the
 * engine had inline).
 */
export interface DueSourceInputs {
  scenarioEvents: ReadonlyArray<{ id: string; atSimTimeSec?: number; fired: boolean }>;
  /** Scenario zones — occupantSchedule is optional per zone (cast read). */
  zones: ReadonlyArray<{ id: string }>;
  occupancyFiredKeys: Iterable<string>;
  pendingEffectChecks: ReadonlyArray<{ dueSimSec: number }>;
  /** FEAT-06: FlowEngine wait continuations (earliest armed due per parked run). */
  pendingFlowWaits?: ReadonlyArray<{ dueSimSec: number }>;
  /** Live flow definitions (the engine's provider). */
  flows?: () => ReadonlyArray<FlowDefinition>;
  /** FlowEngine.triggerDueState memo source; presence gates the flow lane. */
  triggerDueState?: (
    flows: ReadonlyArray<FlowDefinition>,
  ) => Array<{ id: string; scheduleFired: boolean; cooldownUntilSimSec?: number }>;
  flowEnginePresent: boolean;
  /** Optional policy override for condition re-eval cadence. */
  conditionEvalEverySimSec?: number;
  /** Tick granularity (sim-sec per tick) — the bit-exact default cadence. */
  tickSec: number;
  /** R91 感知节奏等外部 SIM-clock 义务（引擎内部注册的时刻列表）。 */
  externalDueSimSec?: ReadonlyArray<number>;
}

export function buildDueSourcesFrom(inputs: DueSourceInputs): DueMomentSources {
  let flows: DueMomentSources['flows'] = [];
  let hasConditionFlows = false;
  if (inputs.flows !== undefined) {
    try {
      const defs = inputs.flows() ?? [];
      hasConditionFlows = defs.some(f => f.enabled && f.trigger.kind === 'condition');
      if (inputs.flowEnginePresent && inputs.triggerDueState !== undefined) {
        const dueState = new Map(inputs.triggerDueState(defs).map(entry => [entry.id, entry]));
        flows = defs.map(flow => {
          const memo = dueState.get(flow.id);
          return {
            id: flow.id,
            enabled: flow.enabled,
            trigger: flow.trigger,
            ...(memo?.scheduleFired === true ? { scheduleFired: true } : {}),
            ...(memo?.cooldownUntilSimSec !== undefined
              ? { cooldownUntilSimSec: memo.cooldownUntilSimSec }
              : {}),
          };
        });
      }
    } catch {
      flows = []; // provider fault — same tolerance as FlowEngine itself
    }
  }
  return {
    externalDueSimSec: inputs.externalDueSimSec ? [...inputs.externalDueSimSec] : undefined,
    scenarioEvents: inputs.scenarioEvents.map(event => ({
      id: event.id,
      atSimTimeSec: event.atSimTimeSec,
      fired: event.fired,
    })),
    occupancySchedules: inputs.zones.flatMap(zone => {
      const sched = (zone as {
        occupantSchedule?: {
          count: number;
          startSimTimeSec: number;
          endSimTimeSec: number;
          repeatDaily?: boolean;
        };
      }).occupantSchedule;
      if (sched === undefined) return [];
      return [{
        zoneId: zone.id,
        startSimTimeSec: sched.startSimTimeSec,
        endSimTimeSec: sched.endSimTimeSec,
        ...(sched.repeatDaily !== undefined ? { repeatDaily: sched.repeatDaily } : {}),
      }];
    }),
    // FEAT-07 phase-2: overlay windows — transitions (enter/exit moments,
    // marker-gated by the predictor against the fired keys) and the overlay
    // schedules with their governing window for clipped boundary enumeration.
    ...(() => {
      const transitions: NonNullable<DueMomentSources['occupancyOverlayTransitions']> = [];
      const overlaySchedules: NonNullable<DueMomentSources['occupancyOverlaySchedules']> = [];
      for (const zone of inputs.zones) {
        const overlay = (zone as { occupantScheduleOverlay?: OccupantScheduleOverlay })
          .occupantScheduleOverlay;
        if (overlay === undefined) continue;
        transitions.push(
          { zoneId: zone.id, atSimSec: overlay.startsAtSimSec, key: overlayTransitionKey(zone.id, 'enter', overlay.startsAtSimSec) },
          { zoneId: zone.id, atSimSec: overlay.endsAtSimSec, key: overlayTransitionKey(zone.id, 'exit', overlay.endsAtSimSec) },
        );
        overlaySchedules.push({
          zoneId: zone.id,
          startSimTimeSec: overlay.schedule.startSimTimeSec,
          endSimTimeSec: overlay.schedule.endSimTimeSec,
          ...(overlay.schedule.repeatDaily !== undefined ? { repeatDaily: overlay.schedule.repeatDaily } : {}),
          windowStartSimSec: overlay.startsAtSimSec,
          windowEndSimSec: overlay.endsAtSimSec,
        });
      }
      return {
        ...(transitions.length > 0 ? { occupancyOverlayTransitions: transitions } : {}),
        ...(overlaySchedules.length > 0 ? { occupancyOverlaySchedules: overlaySchedules } : {}),
      };
    })(),
    occupancyFiredKeys: [...inputs.occupancyFiredKeys],
    flows,
    pendingEffectChecks: inputs.pendingEffectChecks.map(check => ({ dueSimSec: check.dueSimSec })),
    pendingFlowWaits: (inputs.pendingFlowWaits ?? []).map(wait => ({ dueSimSec: wait.dueSimSec })),
    // Bit-exact default: tick-boundary cadence whenever condition flows
    // exist (skipping an evaluation could miss a rising edge a tick run
    // would have caught); the option coarsens it as an explicit policy.
    ...(hasConditionFlows || inputs.conditionEvalEverySimSec !== undefined
      ? {
          conditionEvalEverySimSec:
            inputs.conditionEvalEverySimSec ?? inputs.tickSec,
        }
      : {}),
  };
}


/**
 * R91 抽取（EngineRuntime 瘦身）：按 occupantSchedule 边界发放人头数。
 * 纯调度计算 + 回调写入；firedKeys 由宿主持有（重启/恢复语义不变）。
 */
export function fireOccupantSchedulesFrom(
  zones: ReadonlyArray<{
    id: string;
    occupantSchedule?: { count: number; startSimTimeSec: number; endSimTimeSec: number; repeatDaily?: boolean };
  }>,
  firedKeys: Set<string>,
  simTimeSec: number,
  apply: (zoneId: string, headcount: number) => void,
): void {
  for (const zone of zones) {
    const sched = zone.occupantSchedule;
    if (!sched) continue;
    for (const due of occupancyTransitionsDue(
      {
        zoneId: zone.id,
        startSimTimeSec: sched.startSimTimeSec,
        endSimTimeSec: sched.endSimTimeSec,
        ...(sched.repeatDaily !== undefined ? { repeatDaily: sched.repeatDaily } : {}),
      },
      firedKeys,
      simTimeSec,
    )) {
      firedKeys.add(due.key);
      apply(zone.id, due.kind === 'arrive' ? sched.count : 0);
    }
  }
}


/** R91 抽取：运行时停止态断言（原 EngineRuntime.assertNotStopped）。 */
export function assertRuntimeNotStopped(
  state: EngineRuntimeState,
  operation: string,
): void {
  if (state === 'stopped') {
    throw new Error(`EngineRuntime.${operation}: runtime is stopped`);
  }
}
