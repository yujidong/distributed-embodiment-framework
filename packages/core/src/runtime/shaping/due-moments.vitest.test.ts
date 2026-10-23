/**
 * @vitest-environment node
 *
 * Living-worlds P1 (design-living-worlds.md §8.2): due-moment computation —
 * pure source-table tests. Every source kind produces its moment; fired
 * memories skip; horizons bound; same-time moments merge; the occupancy and
 * periodic-crossing math mirrors the runtime's firing semantics exactly
 * (fireOccupantSchedules / FlowEngine.shouldFireSchedule).
 */

import { describe, it, expect } from 'vitest';

import {
  computeDueMoments,
  dailyScheduleCrossings,
  nextDueMoment,
  nextOccupancyBoundary,
  nextPeriodicCrossing,
} from './due-moments.js';
import type { DueMomentSources } from '../contract.js';

const DAY = 86400;function emptySources(overrides: Partial<DueMomentSources> = {}): DueMomentSources {
  return {
    scenarioEvents: [],
    occupancySchedules: [],
    occupancyFiredKeys: [],
    flows: [],
    pendingEffectChecks: [],
    ...overrides,
  };
}

describe('computeDueMoments: source table', () => {
  it('scenario events: unfired only, within horizon', () => {
    const sources = emptySources({
      scenarioEvents: [
        { id: 'a', atSimTimeSec: 30, fired: false },
        { id: 'b', atSimTimeSec: 10, fired: true }, // fired → skipped
        { id: 'c', atSimTimeSec: 90, fired: false },
        { id: 'd', fired: false }, // no schedule → skipped
      ],
    });
    const moments = computeDueMoments(sources, 0);
    expect(moments.map(m => [m.atSimSec, m.kinds])).toEqual([
      [30, ['scenario-event']],
      [90, ['scenario-event']],
    ]);
    // horizon cuts the tail
    expect(computeDueMoments(sources, 0, 50).map(m => m.atSimSec)).toEqual([30]);
    // strictly-greater origin
    expect(nextDueMoment(sources, 30)!.atSimSec).toBe(90);
  });

  it('occupancy schedules: arrive/depart boundaries per day, fired keys skipped', () => {
    const sched = { zoneId: 'hall', startSimTimeSec: 600, endSimTimeSec: 2400, repeatDaily: true };
    // Day 0 fresh (finite horizon): arrive at 600, depart at 2400.
    expect(computeDueMoments(emptySources({ occupancySchedules: [sched] }), 0, 3000)
      .map(m => m.atSimSec)).toEqual([600, 2400]);
    // Unbounded ask = first moment only (the nextDueMoment question).
    expect(computeDueMoments(emptySources({ occupancySchedules: [sched] }), 0)
      .map(m => m.atSimSec)).toEqual([600]);
    // Mid-window: arrive (day 0) fired → next is day-0 depart.
    expect(nextOccupancyBoundary(sched, new Set(['hall:arrive:0']), 700)).toEqual({
      atSimSec: 2400,
      key: 'hall:depart:0',
    });
    // Past day-0 depart: next is day-1 arrive.
    expect(nextOccupancyBoundary(sched, new Set(['hall:arrive:0', 'hall:depart:0']), 3000)!.atSimSec)
      .toBe(DAY + 600);
    // Non-repeat: nothing after day 0's boundaries.
    const once = { ...sched, repeatDaily: false };
    expect(nextOccupancyBoundary(once, new Set(['hall:arrive:0', 'hall:depart:0']), 3000)).toBeUndefined();
    // A from mid-window BEFORE the arrive fired (restored mid-window, unfired
    // memory) still gets the depart boundary — never sleeps past a fire.
    expect(nextOccupancyBoundary(sched, new Set(), 700)!.atSimSec).toBe(2400);
  });

  it('flow schedules: one-shot unfired only + periodic (prev, cur] crossings', () => {
    const sources = emptySources({
      flows: [
        { id: 'once', enabled: true, trigger: { kind: 'schedule', atSimTimeSec: 100 } },
        { id: 'once-fired', enabled: true, trigger: { kind: 'schedule', atSimTimeSec: 50 }, scheduleFired: true },
        { id: 'periodic', enabled: true, trigger: { kind: 'schedule', everySimSec: 300 } },
        { id: 'windowed', enabled: true, trigger: { kind: 'schedule', everySimSec: 60, startAtSimTimeSec: 500, endAtSimTimeSec: 700 } },
        { id: 'disabled', enabled: false, trigger: { kind: 'schedule', atSimTimeSec: 20 } },
      ],
    });
    expect(computeDueMoments(sources, 0, 800).map(m => m.atSimSec)).toEqual([
      100, // one-shot (the fired one at 50 is skipped)
      300, // periodic first crossing
      500, // windowed start = its first boundary
      560, 600, 620, 680, // windowed crossings + periodic 600
    ]);
    // Past the window end: periodic only.
    expect(computeDueMoments(sources, 700, 1000).map(m => m.atSimSec)).toEqual([900]);
  });

  it('nextPeriodicCrossing mirrors FlowEngine.shouldFireSchedule window math', () => {
    expect(nextPeriodicCrossing({ everySimSec: 300 }, 0)).toBe(300);
    expect(nextPeriodicCrossing({ everySimSec: 300 }, 300)).toBe(600); // strictly after
    expect(nextPeriodicCrossing({ everySimSec: 300 }, 301)).toBe(600);
    expect(nextPeriodicCrossing({ everySimSec: 300, startAtSimTimeSec: 1000 }, 0)).toBe(1000);
    expect(nextPeriodicCrossing({ everySimSec: 300, endAtSimTimeSec: 700 }, 700)).toBeUndefined();
    // Next crossing (900) is past the end (700) → none remains.
    expect(nextPeriodicCrossing({ everySimSec: 300, endAtSimTimeSec: 710 }, 650)).toBeUndefined();
    expect(nextPeriodicCrossing({ everySimSec: 60, startAtSimTimeSec: 500, endAtSimTimeSec: 700 }, 500)).toBe(560);
    expect(nextPeriodicCrossing({ everySimSec: 0 }, 0)).toBeUndefined();
    expect(nextPeriodicCrossing({}, 0)).toBeUndefined();
  });

  it('condition flows: one cadence moment per computation, not per flow', () => {
    const sources = emptySources({
      flows: [
        {
          id: 'c1', enabled: true,
          trigger: { kind: 'condition', zoneId: 'z', conditions: [], cooldownSimSec: 100 },
          cooldownUntilSimSec: 100, // fired at 0 + 100 cooldown
        },
        { id: 'c2', enabled: true, trigger: { kind: 'condition', zoneId: 'z', conditions: [] } },
      ],
      conditionEvalEverySimSec: 60,
    });
    // Cooldown re-arm at 100 (not a cadence multiple — its own moment).
    const moments = computeDueMoments(sources, 0, 200);
    expect(moments.map(m => m.atSimSec)).toEqual([60, 100, 120, 180]);
    expect(moments.find(m => m.atSimSec === 100)!.kinds).toEqual(['flow-cooldown']);
    expect(moments.find(m => m.atSimSec === 120)!.kinds).toEqual(['flow-condition-eval']);
    // Without a cadence, only the cooldown moment exists.
    const noCadence = emptySources({
      flows: [sources.flows[0]!],
    });
    expect(computeDueMoments(noCadence, 0).map(m => m.atSimSec)).toEqual([100]);
  });

  it('effect checks and external duties; same-time sources merge', () => {
    const sources = emptySources({
      scenarioEvents: [{ id: 'evt', atSimTimeSec: 40, fired: false }],
      pendingEffectChecks: [{ dueSimSec: 40 }, { dueSimSec: 90 }],
      externalDueSimSec: [40, 200],
    });
    const moments = computeDueMoments(sources, 0);
    expect(moments).toEqual([
      { atSimSec: 40, kinds: ['scenario-event', 'effect-check', 'external'], labels: ['evt', 'effect-check@40', 'external@40'] },
      { atSimSec: 90, kinds: ['effect-check'], labels: ['effect-check@90'] },
      { atSimSec: 200, kinds: ['external'], labels: ['external@200'] },
    ]);
  });

  it('FEAT-06: parked flow waits are a due source (a lazy world wakes for the resume)', () => {
    const sources = emptySources({
      pendingFlowWaits: [{ dueSimSec: 400 }, { dueSimSec: 250 }],
    });
    expect(computeDueMoments(sources, 0).map(m => [m.atSimSec, m.kinds])).toEqual([
      [250, ['flow-wait']],
      [400, ['flow-wait']],
    ]);
    // Past the first due: only the later one remains; malformed entries skip.
    expect(nextDueMoment(emptySources({ pendingFlowWaits: [{ dueSimSec: 250 }, { dueSimSec: Number.NaN }] }), 100)!
      .atSimSec).toBe(250);
    expect(nextDueMoment(sources, 300)!.atSimSec).toBe(400);
  });

  it('empty state: no due moment anywhere', () => {
    expect(nextDueMoment(emptySources(), 0)).toBeNull();
    expect(computeDueMoments(emptySources(), 0)).toEqual([]);
  });
});

describe('FEAT-01: daily schedule anchors as due moments', () => {
  it('atTimeOfDaySec: daily crossings, bounded and unbounded asks', () => {
    const sources = emptySources({
      flows: [
        { id: 'bedtime', enabled: true, trigger: { kind: 'schedule', atTimeOfDaySec: 84600 } },
        { id: 'disabled', enabled: false, trigger: { kind: 'schedule', atTimeOfDaySec: 100 } },
      ],
    });
    // Finite horizon: every daily anchor within it (23:30 day 0/1/2).
    expect(computeDueMoments(sources, 0, 2 * DAY + 90000).map(m => [m.atSimSec, m.kinds])).toEqual([
      [84600, ['flow-schedule']],
      [DAY + 84600, ['flow-schedule']],
      [2 * DAY + 84600, ['flow-schedule']],
    ]);
    // Unbounded ask: the FIRST crossing only (the nextDueMoment question).
    expect(computeDueMoments(sources, 0).map(m => m.atSimSec)).toEqual([84600]);
    // Strictly-greater origin: mid-day asks land on the next day's anchor.
    expect(nextDueMoment(sources, 84600)!.atSimSec).toBe(DAY + 84600);
    expect(nextDueMoment(sources, 50000)!.atSimSec).toBe(84600);
  });

  it('dailyScheduleCrossings mirrors FlowEngine dueDailyScheduleKeys (prev, cur] math', () => {
    // tod anchor 84600, from 80000: day-0 anchor is strictly after from.
    expect(dailyScheduleCrossings({ atTimeOfDaySec: 84600 }, [], 80000, 90000)).toEqual([84600]);
    // Anchor exactly AT from is excluded ((prev, cur] semantics).
    expect(dailyScheduleCrossings({ atTimeOfDaySec: 84600 }, [], 84600, 90000)).toEqual([]);
    expect(dailyScheduleCrossings({ atTimeOfDaySec: 84600 }, [], 84600, DAY + 84600)).toEqual([DAY + 84600]);
    // Horizon bounds the enumeration.
    expect(dailyScheduleCrossings({ atTimeOfDaySec: 84600 }, [], 0, 80000)).toEqual([]);
  });

  it('relativeToOccupancy: boundary minus offset, per matching zone, repeatDaily honored', () => {
    const schedules = [
      { zoneId: 'lib', startSimTimeSec: 28800, endSimTimeSec: 64800, repeatDaily: true },
      { zoneId: 'pop-up', startSimTimeSec: 32400, endSimTimeSec: 61200, repeatDaily: false },
    ];
    // 到馆前 30 分钟预冷: arrive 28800 - 1800 = 27000 (07:30), daily.
    const trigger = { relativeToOccupancy: { before: 'arrive' as const, offsetSec: 1800 } };
    expect(dailyScheduleCrossings(trigger, schedules, 0, DAY)).toEqual([
      27000,        // lib day 0
      30600,        // pop-up day 0 (32400 - 1800)
    ]);
    // Day 1: only the repeatDaily zone anchors again.
    expect(dailyScheduleCrossings(trigger, schedules, 40000, 2 * DAY)).toEqual([DAY + 27000]);
    // zoneId pin narrows the source zones.
    expect(
      dailyScheduleCrossings(
        { relativeToOccupancy: { zoneId: 'lib', before: 'arrive', offsetSec: 1800 } },
        schedules, 0, DAY,
      ),
    ).toEqual([27000]);
    // depart anchors read endSimTimeSec.
    expect(
      dailyScheduleCrossings(
        { relativeToOccupancy: { zoneId: 'lib', before: 'depart', offsetSec: 600 } },
        schedules, 0, DAY,
      ),
    ).toEqual([64200]);
    // An offset larger than the boundary shifts the anchor into the previous
    // day's hours: day 0's anchor is negative (never offered), day 1's lands
    // at 75200 (= 86400 + 28800 - 40000) INSIDE day 0 — the (prev, cur] rule
    // engine-side agrees, so the flow does fire "the evening before".
    expect(
      dailyScheduleCrossings(
        { relativeToOccupancy: { zoneId: 'lib', before: 'arrive', offsetSec: 40000 } },
        schedules, 0, DAY,
      ),
    ).toEqual([75200]);
    expect(
      dailyScheduleCrossings(
        { relativeToOccupancy: { zoneId: 'lib', before: 'arrive', offsetSec: 40000 } },
        schedules, 75200, DAY,
      ),
    ).toEqual([]);
  });

  it('computeDueMoments offers occupancy-relative flow anchors from the same schedule table', () => {
    const sources = emptySources({
      occupancySchedules: [
        { zoneId: 'lib', startSimTimeSec: 28800, endSimTimeSec: 64800, repeatDaily: true },
      ],
      flows: [
        {
          id: 'precool', enabled: true,
          trigger: {
            kind: 'schedule',
            relativeToOccupancy: { zoneId: 'lib', before: 'arrive', offsetSec: 1800 },
          },
        },
      ],
    });
    // The occupancy boundaries themselves (28800/64800) AND the flow anchor (27000).
    expect(computeDueMoments(sources, 0, DAY).map(m => m.atSimSec)).toEqual([27000, 28800, 64800]);
    const anchor = computeDueMoments(sources, 0, DAY).find(m => m.atSimSec === 27000)!;
    expect(anchor.kinds).toEqual(['flow-schedule']);
    expect(anchor.labels).toEqual(['precool']);
  });
});
