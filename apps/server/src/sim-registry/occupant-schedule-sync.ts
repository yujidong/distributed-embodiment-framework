/**
 * Occupant-schedule sync (FEAT-07) — env-level occupantSchedule PATCHes
 * pushed into every env-backed runtime, no environment rebuild.
 *
 * Same mirror discipline as service-catalog-sync.ts: SimulationSeams calls
 * `attach(envId, runtime)` for every env-backed runtime (create + resume
 * lanes — the authoritative world session AND private env-backed sims), and
 * the PATCH route calls `applyZoneSchedule` to land the change in every
 * live runtime of that env. Attach needs no snapshot work: a freshly built
 * runtime's scenario already carries the env's current schedules (the
 * environment bridge reads the same map_data the PATCH writes).
 *
 * Design choices:
 * - stopped runtimes are dropped from the live set (a resumed sim
 *   re-attaches through SimulationSeams with the DB truth).
 * - a runtime that does not contain the zone (instance-scoped private sim,
 *   Fix-43e zone pruning) is skipped with a warn — the PATCH is about the
 *   ENV's zone; a scoped sim honestly has nothing to update.
 * - every per-runtime fault degrades to a warn; the route's DB write is
 *   already the durable truth (the next materialize picks it up).
 */

import { updateZoneOccupantSchedule, type EngineRuntime, type OccupantScheduleOverlay, type OccupantScheduleWithCount } from '@active-collaboration/core';

import type { RuntimeAttacher } from './types.js';

export class OccupantScheduleSync implements RuntimeAttacher {
  /** envId → live runtimes currently running that env's world. */
  private readonly live = new Map<string, Set<EngineRuntime>>();

  attach(environmentId: string, runtime: EngineRuntime): void {
    let runtimes = this.live.get(environmentId);
    if (runtimes === undefined) {
      runtimes = new Set();
      this.live.set(environmentId, runtimes);
    }
    runtimes.add(runtime);
  }

  /**
   * Land one zone's schedule change (null = clear) in every live runtime of
   * the env. Returns how many runtimes took the update (the route surfaces
   * this so a PATCH with no live session honestly reports 0 — the DB write
   * still governs the next materialize).
   *
   * FEAT-07 phase-2 (calendar overlay): when `overlay` is given (object =
   * install/replace, null = clear) the call pushes the zone's RESULTING
   * timetable state `{schedule, overlay}` and the core seam reconciles the
   * live world (an overlay covering NOW takes over immediately; a cleared
   * overlay reverts to the base timetable immediately; a future window
   * waits for its due-moment boundary).
   */
  applyZoneSchedule(
    envId: string,
    zoneId: string,
    schedule: OccupantScheduleWithCount | null,
    overlay?: OccupantScheduleOverlay | null,
  ): number {
    const runtimes = this.live.get(envId);
    if (runtimes === undefined) return 0;
    let applied = 0;
    for (const runtime of [...runtimes]) {
      if (runtime.getState() === 'stopped') {
        runtimes.delete(runtime);
        continue;
      }
      try {
        updateZoneOccupantSchedule(runtime, zoneId, schedule, overlay);
        applied += 1;
      } catch (error) {
        console.warn(
          `OccupantScheduleSync: schedule patch for zone "${zoneId}" in env ${envId} ` +
          `skipped one runtime (runtime unaffected):`,
          error,
        );
      }
    }
    if (runtimes.size === 0) this.live.delete(envId);
    return applied;
  }
}
