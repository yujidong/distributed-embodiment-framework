/**
 * Zone-level physics LOD controller (DevLoop R30, docs/capacity-planning.md
 * §3) — L2 pure state machine, no engine references.
 *
 * The engine's tick loop asks this controller HOW to integrate each stride:
 *
 *   OBSERVED (default — byte-identical to pre-R30): every stride integrates
 *   immediately, Math.round(stride) substeps of dt = stride/steps (dt=1 on
 *   the integer tick grid at any integer speed).
 *
 *   IDLE (no observers, due-driven): strides ACCUMULATE as pending sim-time
 *   and integrate only when a full coarse batch (IDLE_PHYSICS_SUBSTEP_SEC)
 *   is banked — a due-driven idle world with per-tick dues pays ONE 10s
 *   integration per 10 ticks instead of ten 1s integrations (~10× fewer
 *   physics steps; every field model is dt-parameterized, so the batch is
 *   the same integration, coarser). Flush points (tier switch, checkpoint
 *   export, read surfaces) drain the banked remainder — observers never see
 *   stale physics; idle DUE bodies deliberately may lag by at most one
 *   coarse substep (the LOD tradeoff).
 *
 * Determinism boundary (design-living-worlds.md §8.4): the observed tier is
 * the bit-exact reference; the idle tier is a LOD POLICY — cross-tier
 * comparisons are explicitly not bit-exact (which is why the P1W wake path
 * fast-forwards at observed precision).
 */

import type { PhysicsLodTier } from '../contract.js';

/** The idle-tier coarse integration stride (sim seconds per substep). */
export const IDLE_PHYSICS_SUBSTEP_SEC = 10;

/**
 * R30 Task 3 (multi-rate): at the idle tier, ENVIRONMENT-parameter drives
 * (the outdoor sinusoid + PV daylight baselines) refresh every Nth tick —
 * hour-scale sinusoids are invisible to a 5-tick granularity. Observed
 * tier: every tick (unchanged).
 */
export const IDLE_ENV_BASELINE_EVERY_TICKS = 5;

/**
 * R30 Task 3 (multi-rate): at the idle tier, condition-flow re-evaluation
 * rides a coarser due grid — N × tick instead of every tick boundary.
 * Design §8.3 sanctions coarser condition cadence as an explicit policy
 * (edges may be detected later than a tick run would); the idle LOD tier
 * IS that policy, and an arriving observer's catch-up reverts to the
 * bit-exact tick grid from that moment. This is the dominant idle-density
 * lever: a condition-flow world's engine steps drop ~N×.
 */
export const IDLE_CONDITION_EVAL_EVERY_TICKS = 10;

/**
 * Pure substep math for one integration pass. Observed: the exact pre-R30
 * formula. Idle: ceil(total/batch) substeps of dt ≈ IDLE_PHYSICS_SUBSTEP_SEC.
 */
export function physicsSubstepCount(totalSec: number, tier: PhysicsLodTier): number {
  if (tier === 'idle') {
    return Math.max(1, Math.ceil(totalSec / IDLE_PHYSICS_SUBSTEP_SEC));
  }
  return Math.max(1, Math.round(totalSec));
}

/** Pure batch planner: how many seconds integrate NOW, how many stay banked. */
export function planIdleBatch(pendingSec: number, strideSec: number): { integrateNow: number; pending: number } {
  const pending = pendingSec + strideSec;
  if (pending >= IDLE_PHYSICS_SUBSTEP_SEC) {
    return { integrateNow: pending, pending: 0 };
  }
  return { integrateNow: 0, pending };
}

/**
 * The per-runtime LOD state (tier + banked pending seconds + step counter).
 * The engine owns the actual substep execution; this class only decides
 * WHEN and HOW COARSE — every method is pure bookkeeping.
 */
export class PhysicsLodController {
  private tier: PhysicsLodTier = 'observed';
  private pendingSec = 0;
  private stepCount = 0;

  /** The current tier (observed by default — pre-R30 behavior). */
  getTier(): PhysicsLodTier {
    return this.tier;
  }

  /**
   * Switch tiers (pure state change — callers flush takePending() FIRST, at
   * the OLD tier's stride, because banked idle seconds were idle seconds).
   */
  switchTier(tier: PhysicsLodTier): void {
    this.tier = tier;
  }

  /**
   * Account one stride at the current tier. Returns the seconds to integrate
   * immediately (the full banked batch at idle, the stride itself at
   * observed — the engine runs its substep loop on the return value).
   */
  accountStride(strideSec: number): number {
    if (this.tier === 'observed') return strideSec;
    const plan = planIdleBatch(this.pendingSec, strideSec);
    this.pendingSec = plan.pending;
    return plan.integrateNow;
  }

  /**
   * Drain banked pending seconds (tier switch, checkpoint export, read
   * surfaces). 0 at the observed tier or when nothing is banked.
   */
  takePending(): number {
    if (this.tier !== 'idle' || this.pendingSec <= 0) return 0;
    const flush = this.pendingSec;
    this.pendingSec = 0;
    return flush;
  }

  /** Count one executed physics substep (measurement gauge only). */
  noteStep(): void {
    this.stepCount++;
  }

  /** Physics substeps executed since construction (measurement gauge). */
  getStepCount(): number {
    return this.stepCount;
  }
}
