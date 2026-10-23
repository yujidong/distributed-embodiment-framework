/**
 * T43 (R4, completing Batch 3 T32's server half): trailing-window
 * effective-speed sampler — pure math (L2 shaping), injectable clock.
 *
 * T61 (R6, u4-F3): the sampler aggregates into ONE-SECOND wall-clock
 * BUCKETS (Σ sim-seconds per wall second, ≤ SPEED_WINDOW_MAX_BUCKETS
 * buckets). The previous per-tick ring (32 samples) bounded MEMORY, not
 * span: at high tick rates (10–20ms ticks) 32 samples covered ~0.5s of wall
 * clock, so the "60s avg" label was really a half-second snapshot — measured
 * −23% off the schedule rate. With 1s buckets the SPEED_WINDOW_MS span is
 * the actual constraint and the window covers ≥30s under any tick cadence.
 * `getSnapshot()` projects the result as `effectiveSpeedWindowPerSec` — the
 * schedule-worthy AVERAGE the instantaneous `effectiveSpeedPerSec`
 * (last-tick-only) fluctuates around. No engine imports, no IO: the runtime
 * owns when to record/reset (pause resets — the wall gap across a frozen
 * sim is not advancement time), this module only owns the arithmetic.
 */

/** Bucket size: one wall-clock second per bucket. */
export const SPEED_WINDOW_BUCKET_MS = 1000;

/** Bucket capacity — ≤60 buckets = the window span bounds memory too. */
export const SPEED_WINDOW_MAX_BUCKETS = 60;

/** Wall-clock span the window aims to cover (the "60s avg" consumers see). */
export const SPEED_WINDOW_MS = 60_000;

/**
 * T123: the NOMINAL sim-seconds per wall-second a runtime advances at — the
 * rate caliber the AC handshake-window floor gate reads. Two scheduling
 * semantics, one number:
 * - lazy / world-session (`lazy: true`, `world-session.ts` drives
 *   `advanceTo` from the wall clock): `speed` IS sim-sec per wall-sec —
 *   the host advances the world by `rate × elapsed wall` on wake;
 * - classic tick loop: `speed` sim-sec per `tickMs` ms, so per wall-second
 *   the world strides `speed × 1000 / tickMs` sim-sec.
 * Pure math (L2 shaping, injectable nothing) so the gate semantics are
 * directly testable and EngineRuntime keeps only a one-line delegate
 * (arch-guard: EngineRuntime sits at its size ceiling).
 */
export function nominalSimPerWallSec(speed: number, tickMs: number, lazy: boolean): number {
  return lazy ? speed : (speed * 1000) / tickMs;
}

/** Projection handed to the snapshot builder (both fields defined). */
export interface SpeedWindowStats {
  /** Σ sim-seconds ÷ Σ wall-seconds over the retained buckets. */
  perSec: number;
  /** Wall seconds actually covered by the retained buckets (≤ window). */
  windowSec: number;
}

export class SpeedWindowSampler {
  /** Σ sim-seconds keyed by wall second (floor(nowMs / 1000)). */
  private readonly buckets = new Map<number, number>();
  private lastWallMs: number | null = null;

  /**
   * Record one completed tick that advanced `simAdvancedSec` sim-seconds at
   * wall time `nowMs`. The first call after a reset only ANCHORS the clock
   * (a lone interval is the noisy last-tick estimate the window exists to
   * smooth) — `stats()` stays undefined until two BUCKETS exist.
   */
  record(simAdvancedSec: number, nowMs: number = Date.now()): void {
    if (this.lastWallMs !== null) {
      // Clock went backwards (host NTP etc.) — skip the sample: Σwall must
      // never shrink, and a negative interval is not advancement time.
      if (nowMs >= this.lastWallMs) {
        const second = Math.floor(nowMs / SPEED_WINDOW_BUCKET_MS);
        this.buckets.set(second, (this.buckets.get(second) ?? 0) + simAdvancedSec);
        this.prune();
      }
    }
    this.lastWallMs = nowMs;
  }

  /**
   * Σsim/Σwall over the window; undefined with <2 buckets (fewer than two
   * wall seconds of observation is the noisy last-tick shape the window
   * exists to smooth) — honest absence over a fake 0.
   */
  stats(): SpeedWindowStats | undefined {
    if (this.buckets.size < 2) return undefined;
    let simSec = 0;
    for (const value of this.buckets.values()) simSec += value;
    let first = Number.MAX_SAFE_INTEGER;
    let last = Number.MIN_SAFE_INTEGER;
    for (const second of this.buckets.keys()) {
      if (second < first) first = second;
      if (second > last) last = second;
    }
    const windowSec = last - first + 1;
    if (windowSec <= 0) return undefined;
    return { perSec: simSec / windowSec, windowSec };
  }

  /** Drop the window (start/pause/resume episode boundary — no samples cross a frozen gap). */
  reset(): void {
    this.buckets.clear();
    this.lastWallMs = null;
  }

  /** Retained bucket count (test/observability seam). */
  get size(): number {
    return this.buckets.size;
  }

  /** Evict the OLDEST bucket while the count or the covered span exceeds the window. */
  private prune(): void {
    while (this.buckets.size > SPEED_WINDOW_MAX_BUCKETS) {
      this.deleteOldest();
    }
    for (;;) {
      let first = Number.MAX_SAFE_INTEGER;
      let last = Number.MIN_SAFE_INTEGER;
      for (const second of this.buckets.keys()) {
        if (second < first) first = second;
        if (second > last) last = second;
      }
      if (this.buckets.size <= 1 || (last - first + 1) * SPEED_WINDOW_BUCKET_MS <= SPEED_WINDOW_MS) {
        break;
      }
      this.deleteOldest();
    }
  }

  private deleteOldest(): void {
    let oldest = Number.MAX_SAFE_INTEGER;
    for (const second of this.buckets.keys()) {
      if (second < oldest) oldest = second;
    }
    if (oldest !== Number.MAX_SAFE_INTEGER) this.buckets.delete(oldest);
  }
}
