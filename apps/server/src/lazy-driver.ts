/**
 * Lazy simulation driver (living-worlds P1, design-living-worlds.md §8) —
 * due-driven advancement for sims created with `scheduling: 'lazy'`.
 *
 * Where a 'tick' sim runs a fixed-interval wall timer (scheduleNextTick:
 * every tickMs a tick of `speed` sim-seconds), a lazy sim keeps NO engine
 * timer: the runtime runs in due-driven mode (EngineRuntime.start(…, {lazy:
 * true}) — no tick timer) and THIS driver decides when the world moves:
 *
 *   1. compute the next due moment from the runtime's own state
 *      (EngineRuntime.peekNextDueMoment — design §8.2 source table);
 *   2. map it to a WALL deadline through the sim's own rate
 *      (sim-sec per wall-sec = speed × 1000 / tickMs — the same wall moment
 *      a tick-driven run would have reached it);
 *   3. sleep until the earliest of that deadline, the terms.read freshness
 *      floor (§8.5 — an active data-read agreement must never let the world
 *      freeze longer than minFreshnessSec of wall time; the server maps the
 *      wall floor to sim seconds before registering it), and the fairness
 *      chunk cap;
 *   4. EngineRuntime.advanceTo(the mapped sim moment) — executes ONLY the
 *      due moments in between (bit-identical to tick-driven advancement;
 *      see EngineRuntime.advanceTo), then sleeps again.
 *
 * Between due moments the driver does NO engine work — no physics, no tick
 * bodies, no snapshots. The only recurring activity is the cheap due-set
 * recheck (default every 1s of wall time): the flowsProvider is re-read on
 * every computation, so a flow edited/added at runtime takes effect at the
 * next recheck instead of sleeping until a stale next-due hours away. This
 * is a scheduler poll, not an engine heartbeat.
 *
 * Wall-clock artifacts are deliberately NOT wake sources (design §8.2's
 * 墙钟 rows are observation-side): the zone sampler keeps its own wall poll,
 * WS push cadence is unaffected, and terms.read.cadenceSec (a DECLARED soft
 * push rhythm) never gates advancement — only minFreshnessSec is
 * contractual and wired here.
 */

import type { EngineRuntime } from '@active-collaboration/core';

import type { AgreementStore } from './db/agreement-store.js';

/** Default recheck cadence for dynamic due sources (flows edited at runtime). */
export const LAZY_RECHECK_WALL_MS = 1000;
/** Default fairness chunk: one advanceTo call spans at most this many sim-sec. */
export const LAZY_MAX_STRIDE_SIM_SEC = 3600;

export interface LazyDriverOptions {
  runtime: EngineRuntime;
  /** Wall milliseconds per tick — the sim's own cadence (wall↔sim mapping). */
  tickMs: number;
  /**
   * Fairness chunk cap in sim seconds (default 3600). advanceTo yields
   * between substep chunks internally; this additionally bounds one call so
   * a far-away due moment (e.g. next sim-day) advances in slices.
   */
  maxStrideSimSec?: number;
  /** Due-set recheck cadence in wall ms (default 1000). */
  recheckWallMs?: number;
  /**
   * terms.read freshness floor provider (§8.5): the TIGHTEST active
   * minFreshnessSec (wall seconds) for the sim's environment, or undefined
   * when no active data-read agreement carries one. Registered as an
   * external due: the world wakes at least that often, so an agreement's
   * fresh-lane evaluation never reads a world frozen past the contract.
   */
  freshnessFloorSec?: () => number | undefined;
  /**
   * Living-worlds P1W: invoked after every successful advanceTo this driver
   * performed (dues AND floor wakes). The authoritative world session uses it
   * to recompute stale cached data frames (§8.5's "死线前必有求值覆写帧缓存"
   * becomes platform-guaranteed) — the hook must never throw upward: guard it
   * in the provider.
   */
  afterAdvance?: () => void;
}

export interface LazyDriverHandle {
  /** Stop the driver (clears the pending timer; the loop exits). Idempotent. */
  stop(): void;
  /** Cancel the current sleep and re-evaluate the due set immediately. */
  wakeNow(): void;
}

/**
 * Living-worlds P1 (design §8.5): the TIGHTEST terms.read freshness floor of
 * an environment's ACTIVE data-read agreements, in wall seconds — the number
 * the lazy scheduler must not sleep past. Agreements without terms.read (or
 * without minFreshnessSec) carry no floor; parse faults and store faults
 * degrade to undefined (never throw: the scheduler must stay alive).
 */
export function lazyFreshnessFloorSecForEnv(
  agreementStore: AgreementStore,
): (environmentId: string) => number | undefined {
  return (environmentId: string): number | undefined => {
    try {
      let floorSec: number | undefined;
      for (const agreement of agreementStore.agreementsOfEnv(environmentId)) {
        if (agreement.status !== 'active') continue;
        let terms: { read?: { minFreshnessSec?: unknown } };
        try {
          terms = JSON.parse(agreement.terms_json) as { read?: { minFreshnessSec?: unknown } };
        } catch {
          continue; // malformed terms never gate scheduling
        }
        const value = terms.read?.minFreshnessSec;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        floorSec = floorSec === undefined ? value : Math.min(floorSec, value);
      }
      return floorSec;
    } catch {
      return undefined;
    }
  };
}

/**
 * Start the lazy driver for one simulation. Safe to call on a runtime in any
 * live state — the loop only advances while the runtime is 'running'; a
 * created/paused runtime just gets the cheap recheck poll until it runs.
 */
export function startLazyDriver(options: LazyDriverOptions): LazyDriverHandle {
  const { runtime, tickMs } = options;
  const maxStrideSimSec = options.maxStrideSimSec ?? LAZY_MAX_STRIDE_SIM_SEC;
  const recheckWallMs = options.recheckWallMs ?? LAZY_RECHECK_WALL_MS;

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let wakeNow: (() => void) | undefined;

  /**
   * Sleep for `ms` wall milliseconds. Resolves true when the sleep was
   * CANCELLED early (wakeNow / stop), false when the timer ran out — the
   * stride sleep below must tell the two apart (T-410, see there).
   */
  const sleep = (ms: number): Promise<boolean> =>
    new Promise(resolve => {
      wakeNow = () => resolve(true);
      timer = setTimeout(() => {
        timer = undefined;
        resolve(false);
      }, Math.max(0, ms));
      timer.unref();
    });

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        if (runtime.getState() !== 'running') {
          await sleep(recheckWallMs); // created/paused — cheap poll, no engine work
          continue;
        }
        // Getters only (a full snapshot can throw mid-teardown and is far
        // more work than the two numbers the mapping needs).
        const simRate = (runtime.getSpeed() * 1000) / Math.max(1, tickMs); // sim-sec per wall-sec
        const simTime = runtime.getSimTimeSec();

        // Due moments from the runtime's own state; the freshness floor
        // (wall) mapped to sim seconds through the same rate a tick run
        // would use.
        let targetSimSec: number | undefined = runtime.peekNextDueMoment()?.atSimSec;
        const floorSec = options.freshnessFloorSec?.();
        if (floorSec !== undefined && floorSec > 0) {
          const floorSimSec = simTime + floorSec * simRate;
          targetSimSec = targetSimSec === undefined
            ? floorSimSec
            : Math.min(targetSimSec, floorSimSec);
        }
        if (targetSimSec === undefined || targetSimSec <= simTime) {
          await sleep(recheckWallMs); // nothing due anywhere — recheck poll only
          continue;
        }

        // Sleep to the wall moment a tick-driven run would reach the
        // (chunked) target, then advance — the sim never depends on wall
        // drift, the mapping only decides WHEN the work happens.
        const stride = Math.min(targetSimSec - simTime, maxStrideSimSec);
        // T-410: an EARLY wake (wakeNow — arrival / rebuild / resume nudge)
        // cancels this sleep's target: the due set and the wall anchor are
        // re-evaluated from scratch on the next iteration. Advancing to the
        // stale target anyway would run the world ahead of its wall mapping
        // (the target was mapped from a wall moment that has not arrived).
        const wokenEarly = await sleep((stride / simRate) * 1000);
        if (wokenEarly || stopped || runtime.getState() !== 'running') continue;

        const now = runtime.getSimTimeSec();
        const stopAt = Math.min(simTime + stride, targetSimSec);
        if (stopAt > now) {
          await runtime.advanceTo(stopAt);
          // Generation guard: a rebuild/stop lands on the driver BEFORE the
          // runtime goes away (stopRecord stops drivers first), so `stopped`
          // set mid-advance means this iteration's generation is over — the
          // engine aborts the stride at the next substep (Fix-42c) and the
          // stale generation performs no post-advance work.
          if (stopped) continue;
          if (options.afterAdvance !== undefined) {
            try {
              options.afterAdvance();
            } catch {
              // The hook must never take the scheduler down.
            }
          }
        }
      } catch (error) {
        // A concurrent manual /step may have landed past the target, or the
        // runtime stopped mid-sleep — one bad iteration must never kill the
        // driver. Log and re-evaluate.
        if (!stopped && runtime.getState() !== 'stopped') {
          console.warn(
            `lazy-driver: iteration failed (non-fatal, will re-evaluate): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          await sleep(recheckWallMs);
        }
      }
    }
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      wakeNow?.();
    },
    wakeNow(): void {
      wakeNow?.();
    },
  };
}
