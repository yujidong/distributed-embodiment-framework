/**
 * @vitest-environment node
 *
 * FEAT-07 phase-2: calendar overlay (临时作息覆盖) — a zone may carry a
 * TEMPORARY occupantSchedule overlay that replaces the base timetable
 * inside an absolute sim-time window `[startsAtSimSec, endsAtSimSec)` and
 * automatically hands back to the base timetable at the window end.
 *
 *   1. inside the window the OVERLAY schedule's boundaries drive the
 *      headcount; after `endsAtSimSec` the base boundaries govern again
 *      (asserted at the exact boundary moments);
 *   2. the window ENTER/EXIT transitions are due moments — a LAZY world
 *      (advanceTo) wakes for them, with the patch catch-up discipline
 *      (in-window arrive corrects the headcount, a past depart never
 *      zeroes — last write wins);
 *   3. the runtime seam (`updateZoneOccupantSchedule` with the overlay
 *      argument): an overlay covering NOW takes over immediately;
 *      `overlay: null` clears it and reverts to the base timetable
 *      immediately; an already-expired window is stored silently;
 *   4. transition markers live in the checkpointed occupancyFiredKeys set;
 *   5. the scenario loader round-trips the overlay block and rejects a
 *      degenerate window (endsAt <= startsAt).
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile, ScenarioValidationError } from '../scenario/index.js';
import {
  EngineRuntime,
  overlayTransitionKey,
  updateZoneOccupantSchedule,
  type EngineRuntimeOptions,
} from './index.js';

const runtimes: EngineRuntime[] = [];

function track<T extends EngineRuntime>(runtime: T): T {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop()!.stop();
});

const RUN_OPTIONS = {
  faultSeed: 987654321,
  effectCheckWindowSec: 30,
  llmFailure: { retryBackoffMs: 0 },
} satisfies EngineRuntimeOptions;

const BASE = { count: 5, startSimTimeSec: 600, endSimTimeSec: 1200 };
/** Exam-week hours: 40 people, 00:13:20 → 00:25:00 of each overlay day. */
const OVERLAY_SCHEDULE = { count: 40, startSimTimeSec: 800, endSimTimeSec: 1500 };
/** Overlay governs [700, 90000) — two sim days plus a tail. */
const OVERLAY_WINDOW = { startsAtSimSec: 700, endsAtSimSec: 90000 };

function overlayScenario(withOverlay: boolean) {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'occupant-overlay-test', name: 'Occupant Overlay Test' },
    zones: [
      {
        id: 'library',
        name: 'Library',
        adjacentZoneIds: [],
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22 },
        occupantSchedule: { ...BASE },
        ...(withOverlay
          ? {
              occupantScheduleOverlay: {
                schedule: { ...OVERLAY_SCHEDULE },
                ...OVERLAY_WINDOW,
              },
            }
          : {}),
      },
    ],
    devices: [],
    agents: [],
    events: [],
  });
}

describe('FEAT-07 phase-2: calendar overlay — window semantics', () => {
  it('inside the window the overlay boundaries drive the headcount; after endsAt the base timetable governs again', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(overlayScenario(true), RUN_OPTIONS));
    // Base arrive at 600 fires before the window starts.
    await runtime.step(650);
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    // ENTER at 700: the overlay schedule's window-of-day [800,1500) does not
    // cover 700 — catch-up writes nothing, the base's headcount stands.
    await runtime.step(50);
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    // The overlay arrive REPLACES the base timetable from here (the base
    // depart at 1200 is suppressed while the overlay governs).
    await runtime.step(100); // t=800
    expect(runtime.getZoneOccupancy('library')).toBe(40);
    await runtime.step(500); // t=1300 — past the base depart (1200), no zeroing
    expect(runtime.getZoneOccupancy('library')).toBe(40);
    await runtime.step(200); // t=1500 — overlay depart
    expect(runtime.getZoneOccupancy('library')).toBe(0);

    // Day 2 still inside the absolute window: the overlay repeats daily.
    await runtime.step(86400 + 800 - 1500); // t=87200
    expect(runtime.getZoneOccupancy('library')).toBe(40);
    await runtime.step(700); // t=87900 — day-2 overlay depart
    expect(runtime.getZoneOccupancy('library')).toBe(0);

    // EXIT at 90000: base catch-up at time-of-day 3600 — outside the base
    // window [600,1200), the past depart is consumed WITHOUT zeroing.
    await runtime.step(2100); // t=90000
    expect(runtime.getZoneOccupancy('library')).toBe(0);

    // The base timetable resumes: day-3 arrive fires.
    await runtime.step(2 * 86400 + 600 - 90000); // t=173400
    expect(runtime.getZoneOccupancy('library')).toBe(5);
    await runtime.step(600); // day-3 base depart
    expect(runtime.getZoneOccupancy('library')).toBe(0);
  });

  it('ENTER/EXIT are due moments — a lazy advanceTo run wakes for them (same headcount trail)', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(overlayScenario(true), RUN_OPTIONS));

    await runtime.advanceTo(650);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
    // The next due moment is the overlay ENTER transition itself.
    expect(runtime.peekNextDueMoment()!.atSimSec).toBe(700);

    await runtime.advanceTo(700);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
    // Then the overlay schedule's first in-window boundary.
    expect(runtime.peekNextDueMoment()!.atSimSec).toBe(800);

    await runtime.advanceTo(800);
    expect(runtime.getZoneOccupancy('library')).toBe(40);

    // One lazy sweep across the window end: depart boundaries and EXIT all fire.
    await runtime.advanceTo(90000);
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    // The consumed EXIT marker gates the predictor: next is the base's day-3 arrive.
    expect(runtime.peekNextDueMoment()!.atSimSec).toBe(2 * 86400 + 600);

    await runtime.advanceTo(2 * 86400 + 600);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
  });

  it('transition markers ride the checkpointed occupancyFiredKeys set', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(overlayScenario(true), RUN_OPTIONS));
    await runtime.step(800);
    const exported = runtime.exportWorldState();
    const fired = exported.scheduler.occupancyFired as ReadonlyArray<string>;
    expect(fired).toContain(overlayTransitionKey('library', 'enter', 700));
    expect(fired).not.toContain(overlayTransitionKey('library', 'exit', 90000));
  });
});

describe('FEAT-07 phase-2: updateZoneOccupantSchedule overlay lane', () => {
  it('an overlay whose window covers NOW takes over immediately (enter catch-up)', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(overlayScenario(false), RUN_OPTIONS));
    await runtime.step(650); // base window — 5 people
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    const result = updateZoneOccupantSchedule(runtime, 'library', { ...BASE }, {
      schedule: { count: 40, startSimTimeSec: 600, endSimTimeSec: 1500 },
      startsAtSimSec: 600,
      endsAtSimSec: 2000,
    });
    expect(result.occupancyCorrected).toBe(true);
    expect(runtime.getZoneOccupancy('library')).toBe(40);
    expect(runtime.scenario.zones[0]!.occupantScheduleOverlay).toEqual({
      schedule: { count: 40, startSimTimeSec: 600, endSimTimeSec: 1500 },
      startsAtSimSec: 600,
      endsAtSimSec: 2000,
    });

    await runtime.step(850); // t=1500 — overlay depart
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    await runtime.step(500); // t=2000 — EXIT; base past depart consumed, no write
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    // Base resumes tomorrow.
    await runtime.step(86400 + 600 - 2000);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
  });

  it('overlay: null clears an ACTIVE overlay and reverts to the base timetable immediately', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(overlayScenario(false), RUN_OPTIONS));
    await runtime.step(650);
    updateZoneOccupantSchedule(runtime, 'library', { ...BASE }, {
      schedule: { count: 40, startSimTimeSec: 600, endSimTimeSec: 1500 },
      startsAtSimSec: 600,
      endsAtSimSec: 5000,
    });
    expect(runtime.getZoneOccupancy('library')).toBe(40);

    const cleared = updateZoneOccupantSchedule(runtime, 'library', { ...BASE }, null);
    expect(cleared.occupancyCorrected).toBe(true);
    expect(runtime.scenario.zones[0]!.occupantScheduleOverlay).toBeUndefined();
    // Reverted to the base catch-up: in-window arrive rewrites the base count.
    expect(runtime.getZoneOccupancy('library')).toBe(5);
    // The base depart boundary fires normally from here.
    await runtime.step(550); // t=1200
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    // No stale transition fires at the deleted window's end.
    await runtime.step(3850); // t=5000
    expect(runtime.getZoneOccupancy('library')).toBe(0);
  });

  it('a FUTURE window is stored without touching the standing headcount; an EXPIRED one is silently consumed', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(overlayScenario(false), RUN_OPTIONS));
    await runtime.step(650);
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    // Future window: no correction now (baseChanged=false, overlay not governing).
    const future = updateZoneOccupantSchedule(runtime, 'library', { ...BASE }, {
      schedule: { count: 9, startSimTimeSec: 5700, endSimTimeSec: 6300 },
      startsAtSimSec: 6000,
      endsAtSimSec: 9000,
    });
    expect(future.occupancyCorrected).toBe(false);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
    // ...but its ENTER boundary is a due moment, and the overlay replaces the
    // base from startsAt on (base depart at 1200 still fires — pre-window).
    expect(runtime.peekNextDueMoment()!.atSimSec).toBe(1200);
    await runtime.step(6000 - 650); // t=6000 — ENTER (overlay window-of-day covers 6000)
    expect(runtime.getZoneOccupancy('library')).toBe(9);
    await runtime.step(300); // t=6300 — overlay depart
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    await runtime.step(2700); // t=9000 — EXIT at tod 9000 ≥ base end → no write
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    await runtime.step(86400 + 600 - 9000);
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    // Expired window: both markers consumed silently, headcount untouched.
    const expired = updateZoneOccupantSchedule(runtime, 'library', { ...BASE }, {
      schedule: { count: 99, startSimTimeSec: 0, endSimTimeSec: 86400 },
      startsAtSimSec: 100,
      endsAtSimSec: 200,
    });
    expect(expired.occupancyCorrected).toBe(false);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
    expect(runtime.getOccupancyScheduleFiredKeys().has(overlayTransitionKey('library', 'enter', 100))).toBe(true);
    expect(runtime.getOccupancyScheduleFiredKeys().has(overlayTransitionKey('library', 'exit', 200))).toBe(true);
  });
});

describe('FEAT-07 phase-2: scenario loader channel', () => {
  it('the overlay block round-trips the loader onto the scenario zone', () => {
    const scenario = overlayScenario(true);
    expect(scenario.zones[0]!.occupantScheduleOverlay).toEqual({
      schedule: { ...OVERLAY_SCHEDULE },
      ...OVERLAY_WINDOW,
    });
  });

  it('a degenerate window (endsAt <= startsAt) fails validation with a teaching message', () => {
    expect(() =>
      loadScenarioFile({
        version: '1.0',
        meta: { id: 'bad-overlay', name: 'Bad Overlay' },
        zones: [
          {
            id: 'library',
            bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
            occupantScheduleOverlay: {
              schedule: { count: 1, startSimTimeSec: 0, endSimTimeSec: 100 },
              startsAtSimSec: 500,
              endsAtSimSec: 500,
            },
          },
        ],
        devices: [],
        agents: [],
        events: [],
      }),
    ).toThrow(ScenarioValidationError);
    try {
      loadScenarioFile({
        version: '1.0',
        meta: { id: 'bad-overlay', name: 'Bad Overlay' },
        zones: [
          {
            id: 'library',
            bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
            occupantScheduleOverlay: {
              schedule: { count: 1, startSimTimeSec: 0, endSimTimeSec: 100 },
              startsAtSimSec: 500,
              endsAtSimSec: 400,
            },
          },
        ],
        devices: [],
        agents: [],
        events: [],
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/occupantScheduleOverlay\.endsAtSimSec must exceed startsAtSimSec/);
    }
  });
});
