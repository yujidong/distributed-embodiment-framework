/**
 * L5 Meta-cognition — Trust Calibration (§7.3).
 *
 * Trust in a collaboration partner = PLATFORM REPUTATION (the service
 * market's shared signal, P4-1 ReputationTracker) blended with this agent's
 * PRIVATE EXPERIENCE (own interactions). The blend is Bayesian-shrinkage
 * shaped: with zero interactions the platform score stands alone; as private
 * evidence accumulates it takes over — an agent that has been burned three
 * times by a high-reputation stranger stops trusting the stranger's badge.
 *
 *   trustScore = w·platformReputation + (1−w)·experienceScore,
 *   w = 1 / (1 + interactionCount / HALF_WEIGHT_INTERACTIONS)
 *
 * experienceScore uses Laplace smoothing ((successes+1)/(count+2)) so a
 * single failed first contact does not pin a partner to 0 forever.
 *
 * `shouldCollaborate` is the recommendation the AC decision consumes
 * ("should I collaborate with THIS partner?"): trustScore ≥ threshold.
 *
 * Pure + bounded: no IO, partner list capped, checkpoint round-trips.
 */

// ============================================================================
// Types
// ============================================================================

/** The trust face for one partner (§7.3 contract). */
export interface PartnerTrust {
  partnerId: string;
  /** Platform reputation (0..1; 0.5 neutral when the platform has no signal). */
  platformReputation: number;
  /** Private experience score (Laplace-smoothed own success rate). */
  experienceScore: number;
  interactionCount: number;
  successfulCollaborations: number;
  failedCollaborations: number;
  /** The blended score (0..1). */
  trustScore: number;
  /** Recommendation: trustScore ≥ threshold. */
  shouldCollaborate: boolean;
}

export interface TrustCalibrationOptions {
  /** Collaboration recommendation threshold (default 0.5). */
  threshold?: number;
  /**
   * Interactions at which platform reputation carries half the weight
   * (default 5 — after ~5 own interactions private experience dominates).
   */
  halfWeightInteractions?: number;
  /** Max distinct partners retained (default 64, drop-oldest-written). */
  maxPartners?: number;
}

/** Bounded per-partner state (checkpoint face). */
interface PartnerRecord {
  partnerId: string;
  interactionCount: number;
  successfulCollaborations: number;
  failedCollaborations: number;
  /** Last platform reputation pushed by the runtime (0.5 neutral default). */
  platformReputation: number;
}

/** Default: collaboration recommended at neutral-or-better trust. */
export const DEFAULT_TRUST_THRESHOLD = 0.5;

/** Default platform-neutral reputation when the runtime pushed none. */
export const NEUTRAL_PLATFORM_REPUTATION = 0.5;

const DEFAULT_HALF_WEIGHT_INTERACTIONS = 5;
const DEFAULT_MAX_PARTNERS = 64;

// ============================================================================
// Store
// ============================================================================

/** Per-agent private trust calibration state (platform reputation injected). */
export class TrustCalibrationStore {
  private readonly threshold: number;
  private readonly halfWeightInteractions: number;
  private readonly maxPartners: number;
  private partners = new Map<string, PartnerRecord>();

  constructor(options: TrustCalibrationOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_TRUST_THRESHOLD;
    this.halfWeightInteractions = options.halfWeightInteractions ?? DEFAULT_HALF_WEIGHT_INTERACTIONS;
    this.maxPartners = options.maxPartners ?? DEFAULT_MAX_PARTNERS;
  }

  /**
   * The runtime (EngineRuntime / ReputationTracker owner) pushes the current
   * platform reputation for a partner. Unknown partners materialize with
   * zero interactions — the platform signal alone is enough to rank them.
   */
  setPlatformReputation(partnerId: string, reputation: number): void {
    if (typeof partnerId !== 'string' || partnerId.length === 0) return;
    const record = this.record(partnerId);
    record.platformReputation = clamp01(reputation);
  }

  /** Record one private interaction outcome with a partner. */
  recordInteraction(partnerId: string, success: boolean): void {
    if (typeof partnerId !== 'string' || partnerId.length === 0) return;
    const record = this.record(partnerId);
    record.interactionCount += 1;
    if (success) record.successfulCollaborations += 1;
    else record.failedCollaborations += 1;
  }

  /** The partner's trust face (computed; unknown partners are neutral). */
  getTrust(partnerId: string): PartnerTrust {
    const record = this.partners.get(partnerId);
    if (record === undefined) {
      return {
        partnerId,
        platformReputation: NEUTRAL_PLATFORM_REPUTATION,
        experienceScore: NEUTRAL_PLATFORM_REPUTATION,
        interactionCount: 0,
        successfulCollaborations: 0,
        failedCollaborations: 0,
        trustScore: NEUTRAL_PLATFORM_REPUTATION,
        shouldCollaborate: NEUTRAL_PLATFORM_REPUTATION >= this.threshold,
      };
    }
    return this.computeTrust(record);
  }

  /** All known partners, deterministic insertion order (prompt/export face). */
  listPartners(): PartnerTrust[] {
    return [...this.partners.values()].map(record => this.computeTrust(record));
  }

  /** Checkpoint face (JSON-serializable). */
  checkpoint(): { partners: Array<Omit<PartnerRecord, never>> } {
    return {
      partners: [...this.partners.values()].map(record => ({ ...record })),
    };
  }

  /** Adopt a checkpoint (replaces state; bounded). */
  restore(checkpoint: { partners: readonly PartnerRecord[] }): void {
    this.partners = new Map();
    for (const raw of checkpoint.partners.slice(0, this.maxPartners)) {
      this.partners.set(raw.partnerId, {
        partnerId: raw.partnerId,
        interactionCount: Math.max(0, Math.floor(raw.interactionCount ?? 0)),
        successfulCollaborations: Math.max(0, Math.floor(raw.successfulCollaborations ?? 0)),
        failedCollaborations: Math.max(0, Math.floor(raw.failedCollaborations ?? 0)),
        platformReputation: clamp01(raw.platformReputation ?? NEUTRAL_PLATFORM_REPUTATION),
      });
    }
  }

  /** Drop everything (agent destroy parity). */
  clear(): void {
    this.partners.clear();
  }

  private record(partnerId: string): PartnerRecord {
    let record = this.partners.get(partnerId);
    if (record === undefined) {
      record = {
        partnerId,
        interactionCount: 0,
        successfulCollaborations: 0,
        failedCollaborations: 0,
        platformReputation: NEUTRAL_PLATFORM_REPUTATION,
      };
      this.partners.set(partnerId, record);
      if (this.partners.size > this.maxPartners) {
        // Drop the OLDEST-inserted partner (Map preserves insertion order).
        const oldest = this.partners.keys().next();
        if (!oldest.done && oldest.value !== partnerId) this.partners.delete(oldest.value);
      }
    }
    return record;
  }

  private computeTrust(record: PartnerRecord): PartnerTrust {
    // Laplace-smoothed private experience: (successes + 1) / (count + 2).
    const experienceScore =
      (record.successfulCollaborations + 1) / (record.interactionCount + 2);
    // Platform weight decays with private evidence (shrinkage): 1 at zero
    // interactions, 1/2 at halfWeightInteractions, → 0 as evidence grows.
    const platformWeight =
      1 / (1 + record.interactionCount / Math.max(1, this.halfWeightInteractions));
    const trustScore = clamp01(
      platformWeight * record.platformReputation + (1 - platformWeight) * experienceScore,
    );
    return {
      partnerId: record.partnerId,
      platformReputation: round3(record.platformReputation),
      experienceScore: round3(experienceScore),
      interactionCount: record.interactionCount,
      successfulCollaborations: record.successfulCollaborations,
      failedCollaborations: record.failedCollaborations,
      trustScore: round3(trustScore),
      shouldCollaborate: trustScore >= this.threshold,
    };
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NEUTRAL_PLATFORM_REPUTATION;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
