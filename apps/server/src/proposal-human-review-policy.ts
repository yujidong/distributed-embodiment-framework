/**
 * High-risk proposal human-review policy (DevLoop S1, Task 3).
 *
 * A rule-level risk classification the OWNER can tune: beyond the existing
 * hard markers (hass:// bindings, oversized device/zone batches, supervised
 * zones, zone claims, cross-party agreement cascades, S1 prompt-injection
 * trips), these breadth classes force HUMAN review (owner escalation) when
 * armed:
 *
 * - `maxAgentsPerProposal` — install-agents breadth ("delegate-like
 *   breadth": one proposal installing an agent FLEET). Flows do NOT ride
 *   the proposal pipeline (routes/flows.ts: "user state, not governed world
 *   structure" — builders create/edit directly), so flow-node breadth has
 *   no proposal lane; agent-fleet breadth is the delegation-blast-radius
 *   class that DOES ride one.
 * - `maxEventsPerProposal` — inject-scenario event breadth (one proposal
 *   baking a large scheduled-event overlay into the shared world).
 * - `maxZonesTouched` — cross-zone access breadth: a single proposal whose
 *   consent footprint spans more zones than the threshold (zone-claim
 *   itself always escalates already, §5.3).
 *
 * The policy is deliberately a CONSERVATIVE ALLOW-LIST of what still
 * auto-applies. A proposal may only auto-apply when ALL of:
 *   rule check passed, low risk, no force-escalate marker (hass://,
 *   oversized batch, supervised zone, zone claim, cross-party cascade),
 *   no prompt-injection markers (always on — never a knob, S1/Task 2),
 *   and within every armed breadth threshold here.
 *
 * Resolution order: the ENVIRONMENT OWNER's per-env knob wins (owner-only
 * PATCH mapData `governance.humanReview` — same authoring lane as zone
 * consentClass, design-consent-semantics.md §3.1 "owner-authored governance
 * metadata"), falling back to the deployment env vars
 * (PROPOSAL_HUMAN_REVIEW_MAX_AGENTS / _MAX_EVENTS / _MAX_ZONES_TOUCHED).
 *
 * DEFAULT = current behavior plus the injection-detector trips (Task 2):
 * all three thresholds ship at 0 (class disarmed); the injection gate is
 * always-on and not configurable from here.
 */

import type { ProposalKind } from './db/proposal-store.js';
import { parseMapData, type EnvironmentRow } from './db/environment-store.js';
import { proposalConsentFootprint, type RuleCheckResult } from './proposal-rules.js';

/** Breadth thresholds; 0 = class disarmed (default). */
export interface HumanReviewThresholds {
  /** Max agents one install-agents proposal may create before human review. */
  maxAgentsPerProposal: number;
  /** Max events one inject-scenario proposal may bake before human review. */
  maxEventsPerProposal: number;
  /** Max distinct zones one proposal may touch before human review. */
  maxZonesTouched: number;
}

export const DEFAULT_HUMAN_REVIEW_THRESHOLDS: HumanReviewThresholds = {
  maxAgentsPerProposal: 0,
  maxEventsPerProposal: 0,
  maxZonesTouched: 0,
};

/** The per-env override block: mapData.governance.humanReview (owner-only). */
export interface EnvGovernanceHumanReview {
  maxAgentsPerProposal?: number;
  maxEventsPerProposal?: number;
  maxZonesTouched?: number;
}

/**
 * Effective thresholds for one environment: per-field owner override over
 * the deployment defaults. Unknown/negative per-env values are ignored
 * (mapData validation rejects them at PATCH time; this read stays total).
 */
export function resolveHumanReviewThresholds(
  env: EnvironmentRow | undefined,
  deployment: HumanReviewThresholds = DEFAULT_HUMAN_REVIEW_THRESHOLDS,
): HumanReviewThresholds {
  const resolved: HumanReviewThresholds = { ...deployment };
  if (env === undefined) return resolved;
  const override = (parseMapData(env).governance as
    | { humanReview?: Partial<EnvGovernanceHumanReview> }
    | undefined)?.humanReview;
  if (override === undefined) return resolved;
  const take = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
  resolved.maxAgentsPerProposal = take(override.maxAgentsPerProposal, resolved.maxAgentsPerProposal);
  resolved.maxEventsPerProposal = take(override.maxEventsPerProposal, resolved.maxEventsPerProposal);
  resolved.maxZonesTouched = take(override.maxZonesTouched, resolved.maxZonesTouched);
  return resolved;
}

/**
 * Apply the breadth classes to one rule-check result. OR-composed with the
 * earlier force-escalate markers; each class names itself (T-302 lesson).
 * Pure over `result` (mutates only the rule verdict fields, like
 * checkZoneConsent); never blocks, never rejects — breadth forces HUMAN
 * review, it does not forbid the change.
 */
export function applyHumanReviewPolicy(
  kind: ProposalKind,
  payload: Record<string, unknown>,
  check: RuleCheckResult,
  thresholds: HumanReviewThresholds,
): void {
  const reasons: string[] = [];

  if (
    thresholds.maxAgentsPerProposal > 0 &&
    kind === 'install-agents' &&
    check.agents.length > thresholds.maxAgentsPerProposal
  ) {
    reasons.push(
      `installs ${check.agents.length} agents at once (> ${thresholds.maxAgentsPerProposal}; ` +
      'delegate-like breadth — the environment owner must review)',
    );
  }

  if (
    thresholds.maxEventsPerProposal > 0 &&
    kind === 'inject-scenario' &&
    check.events.length > thresholds.maxEventsPerProposal
  ) {
    reasons.push(
      `bakes ${check.events.length} scheduled events at once (> ${thresholds.maxEventsPerProposal}; ` +
      'overlay breadth — the environment owner must review)',
    );
  }

  if (thresholds.maxZonesTouched > 0) {
    const zonesTouched = proposalConsentFootprint(kind, check, payload).length;
    if (zonesTouched > thresholds.maxZonesTouched) {
      reasons.push(
        `touches ${zonesTouched} zones at once (> ${thresholds.maxZonesTouched}; cross-zone ` +
        'access breadth — the environment owner must review)',
      );
    }
  }

  if (reasons.length === 0) return;
  const reason = `human-review policy (${reasons.join('; ')})`;
  const prior = check.escalateReason;
  check.riskLevel = 'high';
  check.forceEscalate = true;
  check.escalateReason = prior !== undefined ? `${prior}; ${reason}` : reason;
}
