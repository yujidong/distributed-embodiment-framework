/**
 * @vitest-environment node
 *
 * Living-worlds P1 driver unit tests (design-living-worlds.md §8) — the
 * due-driven scheduler's wake semantics, exercised against a scripted mock
 * runtime so wall timing stays fast and deterministic:
 *
 * - T-410 wall anchor: a sleep CANCELLED early by wakeNow() (arrival /
 *   rebuild / resume nudge — simulation-registry startLazyRuntime wakes on
 *   every one) must re-evaluate the due set and the wall anchor instead of
 *   advancing to the stale target. The old loop advanced to the pre-sleep
 *   target on ANY wake — a world created at wall 0 with a due at sim 600
 *   (rate 60) jumped there in ~8ms instead of after the mapped 10s.
 * - Generation guard: a rebuild stops the driver BEFORE the runtime
 *   (stopRecord ordering), so `stopped` landing mid-flight marks the whole
 *   iteration stale — no advance from a cancelled sleep, no post-advance
 *   hook from a superseded generation.
 */

import { describe, expect, it } from 'vitest';

import type { EngineRuntime } from '@active-collaboration/core';

import { startLazyDriver } from './lazy-driver.js';

interface MockRuntime {
  state: 'created' | 'running' | 'paused' | 'stopped';
  speed: number;
  simTimeSec: number;
  nextDue: number | undefined;
  advanceCalls: number[];
  advanceResolver?: () => void;
}

/**
 * The driver's whole runtime surface: state/speed/simTime getters, the due
 * peek, and advanceTo. advanceTo records its target; when the test installs
 * an in-flight gate it stays pending until the test releases it.
 */
function mockRuntime(inFlightAdvance = false): MockRuntime & EngineRuntime {
  const mock: MockRuntime = {
    state: 'running',
    speed: 60,
    simTimeSec: 0,
    nextDue: undefined,
    advanceCalls: [],
    getState() { return this.state; },
    getSpeed() { return this.speed; },
    getSimTimeSec() { return this.simTimeSec; },
    peekNextDueMoment() {
      return this.nextDue === undefined ? null : { atSimSec: this.nextDue };
    },
    advanceTo(target: number) {
      this.advanceCalls.push(target);
      if (inFlightAdvance) {
        return new Promise<void>(resolve => {
          this.advanceResolver = () => {
            this.simTimeSec = target;
            resolve();
          };
        });
      }
      this.simTimeSec = target;
      return Promise.resolve();
    },
  } as MockRuntime;
  return mock as MockRuntime & EngineRuntime;
}

/** Poll until the predicate holds (bounded) — real-timer driver tests. */
async function until(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

const wallNap = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('lazy-driver: wake semantics (T-410 wall anchor)', () => {
  it(
    'a wakeNow mid-sleep re-evaluates instead of advancing to the stale target',
    { timeout: 10_000 },
    async () => {
      // Rate 60 sim-sec per wall-sec (speed 60 × tickMs 1000); a due at sim
      // 600 maps to a 10s wall sleep — far beyond this test's runtime.
      const runtime = mockRuntime();
      runtime.nextDue = 600;
      const driver = startLazyDriver({ runtime, tickMs: 1000, recheckWallMs: 25 });
      try {
        // Let the driver settle into the stride sleep, then nudge it the way
        // startLazyRuntime does on every arrival/rebuild.
        await wallNap(80);
        driver.wakeNow();
        runtime.nextDue = undefined; // the re-evaluated due set is empty
        const overshot = await wallNap(200).then(() => runtime.advanceCalls.length > 0);
        expect(overshot).toBe(false); // no advance past the wall anchor
        expect(runtime.getSimTimeSec()).toBe(0);
      } finally {
        driver.stop();
      }
    },
  );

  it(
    'a timer-completed sleep still advances at the wall-mapped moment',
    { timeout: 10_000 },
    async () => {
      // Due at sim 3 with rate 60 → 50ms wall sleep: the mapping itself is
      // untouched, only the early-wake path changes.
      const runtime = mockRuntime();
      runtime.nextDue = 3;
      const driver = startLazyDriver({ runtime, tickMs: 1000, recheckWallMs: 25 });
      try {
        const advanced = await until(() => runtime.advanceCalls.length > 0, 2_000);
        expect(advanced).toBe(true);
        expect(runtime.advanceCalls[0]).toBe(3);
      } finally {
        driver.stop();
      }
    },
  );
});

describe('lazy-driver: generation guard (rebuild vs in-flight advance)', () => {
  it(
    'a sleep cancelled by stop() (the rebuild swap order) never advances',
    { timeout: 10_000 },
    async () => {
      const runtime = mockRuntime();
      runtime.nextDue = 600; // 10s wall sleep
      const driver = startLazyDriver({ runtime, tickMs: 1000, recheckWallMs: 25 });
      await wallNap(80);
      // stopRecord ordering: the driver goes first, then the runtime.
      driver.stop();
      runtime.state = 'stopped';
      await wallNap(200);
      expect(runtime.advanceCalls).toEqual([]);
      expect(runtime.getSimTimeSec()).toBe(0);
    },
  );

  it(
    'an advance in flight when the generation ends performs no post-advance work',
    { timeout: 10_000 },
    async () => {
      const runtime = mockRuntime(true); // advanceTo stays pending until released
      runtime.nextDue = 3; // 50ms wall sleep → the driver enters advanceTo
      let afterAdvanceCalls = 0;
      const driver = startLazyDriver({
        runtime,
        tickMs: 1000,
        recheckWallMs: 25,
        afterAdvance: () => {
          afterAdvanceCalls++;
        },
      });
      const entered = await until(() => runtime.advanceCalls.length > 0, 2_000);
      expect(entered).toBe(true);
      // The rebuild swap lands mid-advance: driver stopped first, then the
      // runtime; the in-flight advance resolves afterwards (stale generation).
      driver.stop();
      runtime.state = 'stopped';
      runtime.advanceResolver!();
      await wallNap(100);
      expect(afterAdvanceCalls).toBe(0);
    },
  );
});
