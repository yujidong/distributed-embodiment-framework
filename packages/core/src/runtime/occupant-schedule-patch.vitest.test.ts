/**
 * @vitest-environment node
 *
 * FEAT-07: runtime occupantSchedule patch seam (env-level PATCH lane — no
 * environment rebuild). Covers the due-moments pure logic through a real
 * EngineRuntime:
 *
 *   1. in-window patch corrects the headcount IMMEDIATELY (lazy advance
 *      would otherwise hold the old occupancy until the depart boundary);
 *   2. the zone's consumed-boundary memory is reset — keys of the OLD
 *      schedule must not block the NEW schedule's boundaries;
 *   3. a patch installed OUTSIDE the window consumes the past depart
 *      WITHOUT zeroing (the patch must not stomp an explicit occupancy
 *      override — last write wins); future boundaries fire normally;
 *   4. clearing (null) drops the timetable and leaves headcount untouched;
 *   5. unknown zone / stopped runtime are honest errors.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime, updateZoneOccupantSchedule, type EngineRuntimeOptions } from './index.js';

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

function scheduleScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'occupant-schedule-patch-test', name: 'Occupant Schedule Patch Test' },
    zones: [
      {
        id: 'library',
        name: 'Library',
        adjacentZoneIds: [],
        bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
        baseline: { temperature: 22 },
        occupantSchedule: { count: 5, startSimTimeSec: 600, endSimTimeSec: 1200 },
      },
    ],
    devices: [],
    agents: [],
    events: [],
  });
}

describe('FEAT-07: updateZoneOccupantSchedule runtime seam', () => {
  it('an in-window patch corrects the headcount immediately and resets the old fired keys', async () => {
    const runtime = track(new EngineRuntime(scheduleScenario(), RUN_OPTIONS));
    // Old schedule fires its arrive boundary (600) and depart (1200).
    await runtime.step(1300);
    expect(runtime.getZoneOccupancy('library')).toBe(0);

    // Patch a new schedule whose window COVERS now — the old `arrive:0` key
    // (fired at 600) must not block the new arrive.
    const result = updateZoneOccupantSchedule(runtime, 'library', {
      count: 7,
      startSimTimeSec: 600,
      endSimTimeSec: 1400,
    });
    expect(result.occupancyCorrected).toBe(true);
    expect(runtime.getZoneOccupancy('library')).toBe(7);

    // The NEW depart boundary (1400) fires normally from here.
    await runtime.step(100);
    expect(runtime.getZoneOccupancy('library')).toBe(0);
    // repeatDaily (default): tomorrow's arrive fires again under the new schedule.
    await runtime.step(86400 - 1400 + 600);
    expect(runtime.getZoneOccupancy('library')).toBe(7);
  });

  it('a patch outside the window consumes the past depart WITHOUT zeroing the current headcount', { timeout: 30_000 }, async () => {
    const runtime = track(new EngineRuntime(scheduleScenario(), RUN_OPTIONS));
    await runtime.step(700); // inside the old window — occupancy 5
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    // New schedule whose window is entirely in the past today: the patch
    // does NOT zero the standing headcount (last write wins), but tomorrow
    // the new boundaries take over.
    const result = updateZoneOccupantSchedule(runtime, 'library', {
      count: 3,
      startSimTimeSec: 100,
      endSimTimeSec: 500,
    });
    expect(result.occupancyCorrected).toBe(false);
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    await runtime.step(86400 - 700 + 100); // tomorrow 00:01:40 → arrive
    expect(runtime.getZoneOccupancy('library')).toBe(3);
    await runtime.step(400); // tomorrow's depart (500)
    expect(runtime.getZoneOccupancy('library')).toBe(0);
  });

  it('clearing (null) drops the timetable and leaves the headcount untouched', async () => {
    const runtime = track(new EngineRuntime(scheduleScenario(), RUN_OPTIONS));
    await runtime.step(700);
    expect(runtime.getZoneOccupancy('library')).toBe(5);

    const result = updateZoneOccupantSchedule(runtime, 'library', null);
    expect(result.occupancyCorrected).toBe(false);
    expect(runtime.scenario.zones[0]!.occupantSchedule).toBeUndefined();

    // No boundary ever fires again — the standing headcount is the world's
    // until an explicit occupancy event says otherwise.
    await runtime.step(2000);
    expect(runtime.getZoneOccupancy('library')).toBe(5);
  });

  it('a patched schedule lands on the scenario zones the due-moment predictor reads', async () => {
    const runtime = track(new EngineRuntime(scheduleScenario(), RUN_OPTIONS));
    await runtime.step(300);
    updateZoneOccupantSchedule(runtime, 'library', {
      count: 2,
      startSimTimeSec: 900,
      endSimTimeSec: 1800,
      repeatDaily: false,
    });
    expect(runtime.scenario.zones[0]!.occupantSchedule).toEqual({
      count: 2,
      startSimTimeSec: 900,
      endSimTimeSec: 1800,
      repeatDaily: false,
    });
    // One-shot window still in the future: arrive fires at 900.
    await runtime.step(600);
    expect(runtime.getZoneOccupancy('library')).toBe(2);
    await runtime.step(900);
    expect(runtime.getZoneOccupancy('library')).toBe(0);
  });

  it('unknown zone and stopped runtime are honest errors', async () => {
    const runtime = track(new EngineRuntime(scheduleScenario(), RUN_OPTIONS));
    expect(() =>
      updateZoneOccupantSchedule(runtime, 'nowhere', { count: 1, startSimTimeSec: 0, endSimTimeSec: 10 }),
    ).toThrow(/unknown zone "nowhere"/);
    runtime.stop();
    expect(() =>
      updateZoneOccupantSchedule(runtime, 'library', { count: 1, startSimTimeSec: 0, endSimTimeSec: 10 }),
    ).toThrow(/stopped/);
  });
});
