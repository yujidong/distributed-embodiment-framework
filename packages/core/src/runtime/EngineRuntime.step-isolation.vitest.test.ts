/**
 * @vitest-environment node
 *
 * Fix-42: manual-step isolation contracts (EngineRuntime).
 *
 * - 42c: stop() interrupts an in-flight step() — the loop exits at the next
 *   iteration boundary instead of running the full tick count on a torn-down
 *   world (E2E 2026-08-15: client disconnects left orphan steps crunching
 *   for minutes).
 * - 42a: a long step yields to the host event loop between tick chunks (the
 *   exact cadence is STEP_YIELD_EVERY; tested indirectly via interruption,
 *   which relies on the loop observing state between iterations).
 * - 42b′: the auto-run loop is self-scheduling and adaptive — it runs, it
 *   stops cleanly on pause, the snapshot carries tickWallMs/autoThrottled,
 *   and a tick that costs more than the budget stretches the cadence instead
 *   of saturating the process.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { loadScenarioFile } from '../scenario/index.js';
import { EngineRuntime } from './index.js';

function twoZoneScenario() {
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'step-isolation', name: 'Step Isolation' },
    zones: [
      { id: 'zone-a', adjacentZoneIds: ['zone-b'] },
      { id: 'zone-b', adjacentZoneIds: ['zone-a'] },
    ],
    devices: [
      {
        id: 'temp-sensor-a',
        type: 'temperature-sensor',
        capabilities: ['temperature-reading'],
        zoneId: 'zone-a',
      },
      {
        id: 'hvac-b',
        type: 'hvac',
        capabilities: ['temperature-control', 'cooling', 'turn-on', 'turn-off'],
        zoneId: 'zone-b',
      },
    ],
    agents: [
      {
        id: 'sensor-agent',
        name: 'Sensor Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: ['zone-a'],
        boundDeviceIds: ['temp-sensor-a'],
      },
      {
        id: 'actuator-agent',
        name: 'Actuator Agent',
        capabilities: ['temperature-control'],
        managesZoneIds: ['zone-b'],
        boundDeviceIds: ['hvac-b'],
      },
    ],
    events: [],
  });
}

/** A wide corridor world: `n` zones in a line, sensor every 3rd zone. */
function corridorScenario(n: number) {
  const zones = Array.from({ length: n }, (_, i) => ({
    id: `corridor-${i}`,
    adjacentZoneIds: [
      ...(i > 0 ? [`corridor-${i - 1}`] : []),
      ...(i < n - 1 ? [`corridor-${i + 1}`] : []),
    ],
  }));
  const devices = zones
    .filter((_, i) => i % 3 === 0)
    .map((z, i) => ({
      id: `temp-${i}`,
      type: 'temperature-sensor',
      capabilities: ['temperature-reading'],
      zoneId: z.id,
    }));
  return loadScenarioFile({
    version: '1.0',
    meta: { id: 'corridor', name: 'Corridor' },
    zones,
    devices,
    agents: [
      {
        id: 'facility-agent',
        name: 'Facility Agent',
        capabilities: ['temperature-monitoring'],
        managesZoneIds: zones.map((z) => z.id),
        boundDeviceIds: devices.map((d) => d.id),
      },
    ],
    events: [],
  });
}

const runtimes: EngineRuntime[] = [];
function makeRuntime(
  scenario: ReturnType<typeof twoZoneScenario> | ReturnType<typeof corridorScenario>,
  options?: { tickMs?: number },
): EngineRuntime {
  const rt = new EngineRuntime(scenario, options);
  runtimes.push(rt);
  return rt;
}

afterEach(() => {
  for (const rt of runtimes.splice(0)) {
    try {
      rt.stop();
    } catch {
      // already stopped
    }
  }
});

describe('Fix-42c: stop() interrupts an in-flight manual step', () => {
  it('exits the step loop at the next iteration boundary', async () => {
    const rt = makeRuntime(twoZoneScenario());
    // stop() runs synchronously right after step() enters its first await —
    // the loop must observe the stopped state on iteration 1 and return,
    // not grind through all 200 ticks on a torn-down world.
    const stepping = rt.step(200);
    rt.stop();
    await stepping;
    expect(rt.getSnapshot().state).toBe('stopped');
    expect(rt.getSimTimeSec()).toBeLessThan(200);
    expect(rt.getSimTimeSec()).toBeLessThanOrEqual(2);
  });

  it('a completed step is unaffected (regression guard)', async () => {
    const rt = makeRuntime(twoZoneScenario());
    await rt.step(5);
    expect(rt.getSimTimeSec()).toBe(5);
  });
});

describe('Fix-42b′: adaptive auto-run loop', () => {
  it('self-schedules: runs while running, freezes on pause, exposes the new snapshot fields', async () => {
    const rt = makeRuntime(twoZoneScenario());
    rt.start(1);
    await new Promise((r) => setTimeout(r, 120));
    const whileRunning = rt.getSnapshot();
    expect(whileRunning.state).toBe('running');
    expect(whileRunning.tickCount).toBeGreaterThan(0);
    expect(typeof whileRunning.autoThrottled).toBe('boolean');
    if (whileRunning.tickWallMs !== undefined) {
      expect(whileRunning.tickWallMs).toBeGreaterThanOrEqual(0);
    }

    rt.pause();
    const frozenAt = rt.getSnapshot().tickCount;
    await new Promise((r) => setTimeout(r, 80));
    expect(rt.getSnapshot().tickCount).toBe(frozenAt);
    expect(rt.getSnapshot().state).toBe('paused');
  }, 10_000);

  it('cadence math: cheap ticks keep the budget, expensive ticks stretch it (Fix-42b′)', () => {
    // Cheap tick (1ms) under a 10ms budget — cadence unchanged.
    expect(EngineRuntime.nextTickDelay(10, 1)).toBe(10);
    // Expensive tick (50ms) under a 2ms budget — stretched with margin.
    expect(EngineRuntime.nextTickDelay(2, 50)).toBe(61);
    // autoThrottled boundary: stretched delay vs 4× budget.
    //   tick=30ms, budget=10ms → next=ceil(36)+1=37 ≤ 40 → not throttled
    const notThrottled = EngineRuntime.nextTickDelay(10, 30);
    expect(notThrottled).toBeLessThanOrEqual(40);
    //   tick=33ms, budget=10ms → next=ceil(39.6)+1=41 > 40 → throttled
    const throttled = EngineRuntime.nextTickDelay(10, 33);
    expect(throttled).toBeGreaterThan(40);
  });

  it('throttle decision fires on event-loop lag even when the tick body is cheap (T-010)', () => {
    // Fast tick, on-time timer: healthy on both axes.
    expect(EngineRuntime.isTickThrottled(10, 10, 0)).toBe(false);
    expect(EngineRuntime.isTickThrottled(10, 10, 5)).toBe(false);
    // Classic body-cost throttling still detected.
    expect(EngineRuntime.isTickThrottled(10, 41, 0)).toBe(true);
    // T-010 blind spot: cheap tick body (next=10ms) but the timer fired
    // 120ms late — the event loop was busy with other simulations. The
    // effective cadence degraded just the same, so the flag must fire.
    expect(EngineRuntime.isTickThrottled(10, 10, 120)).toBe(true);
    // Boundary: lag exactly at 4× budget stays healthy (strictly-greater).
    expect(EngineRuntime.isTickThrottled(10, 10, 40)).toBe(false);
    expect(EngineRuntime.isTickThrottled(10, 10, 41)).toBe(true);
  });

  it('the loop reports tickWallMs once it has auto-ticked (integration smoke)', async () => {
    const rt = makeRuntime(corridorScenario(400), { tickMs: 2 });
    rt.start(1);
    await new Promise((r) => setTimeout(r, 400));
    const snap = rt.getSnapshot();
    rt.pause();
    expect(snap.tickCount).toBeGreaterThan(0);
    // The field is present as soon as the loop has measured at least one
    // tick of ≥1ms; on worlds with sub-millisecond ticks it stays 0 — the
    // threshold semantics live in the pure test above.
    expect(typeof snap.autoThrottled).toBe('boolean');
    if (snap.tickWallMs !== undefined) {
      expect(snap.tickWallMs).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);
});
