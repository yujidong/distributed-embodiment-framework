/**
 * ContractNetProtocol — FIPA Contract Net (FIPA00029) helper.
 *
 * Phase 6: Implements the bid-collection + ranking logic for the
 * 'best-of-n' collaboration mode. The initiator broadcasts a Call-
 * For-Proposals (cfp); each candidate evaluates and returns a bid;
 * the initiator picks the best bid and sends accept-proposal to the
 * winner, reject-proposal to the rest.
 *
 * This module is stateless — it provides the ranking + selection
 * primitives. The session management (sending events, tracking timers)
 * lives in CollaborationCoordinator.
 */

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ContractNetProtocol');

/**
 * A bid from a candidate partner responding to a cfp.
 */
export interface PartnerBid {
  agentId: string;
  agentName: string;
  /** Overall quality score 0-1 (higher = better). */
  score: number;
  /** Sub-scores for transparency + logging. */
  capabilityScore: number;
  workloadScore: number;
  reliabilityScore: number;
  proximityScore: number;
  /** Human-readable justification for the bid. */
  reasoning: string;
  /** Estimated time to complete (ms). */
  estimatedDuration?: number;
}

/**
 * Collaboration mode — determines how the initiator converges
 * after sending proposals/cfps to N candidates.
 */
export type CollaborationMode =
  | 'first-accept'    // Current default: execute as soon as ≥1 accepts
  | 'best-of-n'       // Contract Net: collect all bids, pick the best
  | 'all-accept'      // All partners must accept (safety-critical)
  | 'quorum';         // At least minAccept partners must accept

/**
 * Default collaboration mode for backward compatibility.
 */
export const DEFAULT_COLLABORATION_MODE: CollaborationMode = 'first-accept';

/**
 * Select the best partner from a set of accepting partners using
 * bid scores. Returns the winner's agentId and a sorted ranking
 * for logging/UI.
 *
 * Ranking factors (matching PartnerSelectionNegotiator weights):
 * - capabilityScore: 0.4 (how many required capabilities matched)
 * - workloadScore:   0.25 (idle > light > moderate > heavy)
 * - reliabilityScore: 0.2 (reputation / past outcomes)
 * - proximityScore:  0.15 (spatial distance)
 */
export function selectBestPartner(
  bids: PartnerBid[],
): { winner: PartnerBid | undefined; ranking: PartnerBid[] } {
  if (bids.length === 0) {
    return { winner: undefined, ranking: [] };
  }

  // Sort by overall score descending.
  const ranking = [...bids].sort((a, b) => b.score - a.score);
  const winner = ranking[0];

  logger.info(
    `Contract Net winner: ${winner?.agentId} (score=${winner?.score.toFixed(3)})` +
    ` from ${bids.length} bids: ${ranking.map(b => `${b.agentId}=${b.score.toFixed(2)}`).join(', ')}`,
  );

  return { winner, ranking };
}

/**
 * Compute an overall bid score from sub-scores using the same
 * weights as PartnerSelectionNegotiator (capability 40%, workload 25%,
 * reliability 20%, proximity 15%).
 */
export function computeBidScore(
  capabilityScore: number,
  workloadScore: number,
  reliabilityScore: number,
  proximityScore: number,
): number {
  return (
    capabilityScore * 0.4 +
    workloadScore * 0.25 +
    reliabilityScore * 0.2 +
    proximityScore * 0.15
  );
}

/**
 * Check if a quorum of acceptances has been reached.
 */
export function isQuorumReached(
  acceptedCount: number,
  totalRequired: number,
): boolean {
  return acceptedCount >= totalRequired;
}
