/**
 * @vitest-environment node
 *
 * T43 (R4) + T61 (R6, u4-F3): SpeedWindowSampler — the pure trailing-window
 * speed math behind `effectiveSpeedWindowPerSec` / `effectiveSpeedWindowSec`.
 * Injected clock; no engine, no IO.
 *
 * Contract under test:
 * - window mean = Σsim / Σwall over 1-second WALL BUCKETS (math consistency
 *   for contiguous tick cadences — the real runtime shape);
 * - fewer than two buckets → undefined (honest absence over a fake 0);
 * - 10ms tick sequences cover ≥30s of wall (the T61 finding: the old
 *   32-sample ring covered ~0.5s at high tick rates — a "60s avg" lie);
 * - span prunes to ~60s wall, bucket count caps at 60;
 * - reset() drops everything (start/pause episode boundary — a frozen gap
 *   must never count as advancement time).
 */
import { describe, expect, it } from 'vitest';

import {
  SPEED_WINDOW_MAX_BUCKETS,
  SPEED_WINDOW_MS,
  SpeedWindowSampler,
  nominalSimPerWallSec,
} from './speed-window.js';

describe('SpeedWindowSampler (T43/T61)', () => {
  it('computes Σsim/Σwall over a constructed tick sequence', () => {
    const sampler = new SpeedWindowSampler();
    // 3 intervals × 1000ms wall, advancing 60 sim-s per tick → 60 sim-s/s.
    sampler.record(60, 0); // anchor only
    sampler.record(60, 1000);
    sampler.record(60, 2000);
    sampler.record(60, 3000);
    const stats = sampler.stats();
    expect(stats).toBeDefined();
    expect(stats!.perSec).toBeCloseTo(60, 10);
    expect(stats!.windowSec).toBeCloseTo(3, 10);
  });

  it('weights mixed buckets by their wall span (not a plain mean)', () => {
    const sampler = new SpeedWindowSampler();
    sampler.record(10, 0); // anchor
    sampler.record(10, 4000); // bucket 4: 10 sim
    sampler.record(200, 5000); // bucket 5: 200 sim
    const stats = sampler.stats();
    // Σ = 210 sim over buckets 4..5 (2s span) → 105 (a plain interval mean
    // would be ~101; a per-second mean over idle seconds would dilute).
    expect(stats!.perSec).toBeCloseTo(105, 10);
    expect(stats!.windowSec).toBeCloseTo(2, 10);
  });

  it('is undefined before two buckets (fresh start honesty)', () => {
    const sampler = new SpeedWindowSampler();
    expect(sampler.stats()).toBeUndefined();
    sampler.record(30, 0); // anchor
    expect(sampler.stats()).toBeUndefined();
    sampler.record(30, 500); // same wall second as the anchor — 1 bucket
    expect(sampler.stats()).toBeUndefined();
    sampler.record(30, 1000); // second bucket — the window exists from here on
    expect(sampler.stats()).toBeDefined();
  });

  it('is undefined on a zero wall span (clock went nowhere)', () => {
    const sampler = new SpeedWindowSampler();
    sampler.record(30, 1000);
    sampler.record(30, 1000); // same instant → same bucket, still 1
    expect(sampler.stats()).toBeUndefined();
  });

  it('drops samples when the clock steps backwards (Σwall never shrinks)', () => {
    const sampler = new SpeedWindowSampler();
    sampler.record(30, 10_000);
    sampler.record(30, 11_000);
    sampler.record(30, 10_500); // backwards → skipped entirely
    sampler.record(30, 12_000);
    const stats = sampler.stats();
    expect(stats).toBeDefined();
    expect(stats!.windowSec).toBeCloseTo(2, 10);
  });

  it('T61: a 10ms tick sequence covers ≥30s of wall (the old ring covered ~0.5s)', () => {
    const sampler = new SpeedWindowSampler();
    let now = 0;
    sampler.record(1, now); // anchor
    // 30 seconds of 10ms ticks (3000 ticks) — each advancing 1 sim-s. The
    // old 32-sample ring would have covered only ~0.32s of this.
    for (let i = 0; i < 3000; i++) {
      now += 10;
      sampler.record(1, now);
    }
    const stats = sampler.stats()!;
    expect(stats.windowSec).toBeGreaterThanOrEqual(30);
    expect(stats.windowSec).toBeLessThanOrEqual(SPEED_WINDOW_MS / 1000);
    // The mean stays faithful: 1 sim-s per 10ms ≈ 100 sim/s (edge buckets
    // cost at most ~2s of span).
    expect(stats.perSec).toBeGreaterThan(90);
    expect(stats.perSec).toBeLessThanOrEqual(100.5);
  });

  it('prunes the span to the ~60s window, oldest buckets first (contiguous 1s ticks)', () => {
    const sampler = new SpeedWindowSampler();
    // 100 anchors 1s apart, 60 sim-s per tick → steady 60 sim/s; only the
    // buckets inside the last ~60s may survive.
    let now = 0;
    sampler.record(60, now);
    for (let i = 0; i < 100; i++) {
      now += 1000;
      sampler.record(60, now);
    }
    const stats = sampler.stats()!;
    expect(stats.windowSec).toBeLessThanOrEqual(SPEED_WINDOW_MS / 1000);
    expect(stats.windowSec).toBeGreaterThanOrEqual(40);
    expect(stats.perSec).toBeCloseTo(60, 6);
  });

  it('caps the window at 60 buckets even for sub-second ticks', () => {
    const sampler = new SpeedWindowSampler();
    let now = 0;
    sampler.record(10, now);
    // 700 ticks × 100ms = 70s of wall, 10 sim-s per tick → steady 100 sim/s.
    for (let i = 0; i < 700; i++) {
      now += 100;
      sampler.record(10, now);
    }
    expect(sampler.size).toBeLessThanOrEqual(SPEED_WINDOW_MAX_BUCKETS);
    const stats = sampler.stats()!;
    expect(stats.windowSec).toBeLessThanOrEqual(SPEED_WINDOW_MS / 1000);
    // The final bucket is partial (the run stops mid-second) — the mean
    // stays within ~2% of the true 100 sim/s.
    expect(stats.perSec).toBeGreaterThan(97);
    expect(stats.perSec).toBeLessThanOrEqual(100.5);
  });

  it('reset() drops the window (pause/resume episode boundary)', () => {
    const sampler = new SpeedWindowSampler();
    sampler.record(30, 0);
    sampler.record(30, 1000);
    sampler.record(30, 2000);
    expect(sampler.stats()).toBeDefined();
    sampler.reset();
    expect(sampler.stats()).toBeUndefined();
    expect(sampler.size).toBe(0);
    // After reset the next record re-anchors (no sample across the gap).
    sampler.record(30, 999_999);
    expect(sampler.stats()).toBeUndefined();
  });
});

/**
 * T123: the NOMINAL sim-per-wall-second caliber the AC handshake-window
 * floor gate reads — two scheduling semantics, one number. Lazy /
 * world-session worlds set speed = simPerWallSec directly (the host drives
 * advanceTo from the wall clock); classic tick worlds stride `speed`
 * sim-sec per `tickMs` ms, so per wall-second the pace is speed × 1000 /
 * tickMs.
 */
describe('nominalSimPerWallSec (T123)', () => {
  it('lazy / world-session semantics: speed IS sim-sec per wall-sec', () => {
    // world-session.ts starts runtimes via start(rate, { lazy: true }) —
    // the rate flows through unchanged regardless of the tickMs value.
    expect(nominalSimPerWallSec(300, 10, true)).toBe(300);
    expect(nominalSimPerWallSec(1, 10, true)).toBe(1);
    expect(nominalSimPerWallSec(60, 100, true)).toBe(60);
  });

  it('classic tick semantics: speed sim-sec per tickMs ms → ×(1000/tickMs) per wall-sec', () => {
    // Default tickMs=10: speed 1 → 100 sim-s per wall-s; speed 5 → 500.
    expect(nominalSimPerWallSec(1, 10, false)).toBe(100);
    expect(nominalSimPerWallSec(5, 10, false)).toBe(500);
    // A 100ms cadence: speed 5 → 50 sim-s per wall-s.
    expect(nominalSimPerWallSec(5, 100, false)).toBe(50);
  });
});
