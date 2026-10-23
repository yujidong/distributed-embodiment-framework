/**
 * Reputation display logic (P4-1) — pure, unit-testable helpers.
 *
 * Tiers (chip colors):
 *  - 'insufficient' (gray): fewer than REPUTATION_MIN_USES recorded uses —
 *    the Bayesian score is still mostly the prior, so we don't judge yet.
 *  - 'good' (green): score at/above the prior (0.7) with enough data.
 *  - 'warn' (amber): enough data, score below the prior — this provider
 *    underperforms an unknown one.
 */

import type { AgentReputationSummary, ServiceReputation, WorldService } from '../api/types';
import i18n from '../i18n/config';

/** Minimum recorded uses before a score is shown as judged (chip colors). */
export const REPUTATION_MIN_USES = 3;

/** Score at/above this counts as reliable (equals the engine's prior 0.7). */
export const REPUTATION_GOOD_THRESHOLD = 0.7;

export type ReputationTier = 'good' | 'warn' | 'insufficient';

export interface ReputationView {
  score: number;
  attempts: number;
  successes?: number;
}

export function reputationTier(rep: ReputationView): ReputationTier {
  if (rep.attempts < REPUTATION_MIN_USES) return 'insufficient';
  return rep.score >= REPUTATION_GOOD_THRESHOLD ? 'good' : 'warn';
}

/** '82%' — percentage without decimals. */
export function formatReputationPercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Chip text: percentage with uses, or the insufficient-data marker. */
export function reputationChipLabel(rep: ReputationView): string {
  if (reputationTier(rep) === 'insufficient') return i18n.t('reputationLib:insufficientData');
  return formatReputationPercent(rep.score);
}

/** Chip tooltip: the full track record in one line. */
export function reputationTitle(rep: ReputationView): string {
  const base = rep.successes !== undefined
    ? i18n.t('reputationLib:titleScoreWithSuccess', {
        score: formatReputationPercent(rep.score),
        attempts: rep.attempts,
        successes: rep.successes,
      })
    : i18n.t('reputationLib:titleScore', {
        score: formatReputationPercent(rep.score),
        attempts: rep.attempts,
      });
  return reputationTier(rep) === 'insufficient'
    ? `${base}${i18n.t('reputationLib:insufficientHint', { min: REPUTATION_MIN_USES })}`
    : base;
}

/**
 * Per-capability reputation of an agent, derived from its services (each
 * service's reputation is keyed by (provider, semanticType)). Duplicated
 * semantic types (several devices offering the same capability) collapse —
 * the underlying record is the same one.
 */
export function perCapabilityReputation(
  services: WorldService[],
  agentId: string,
): Array<{ capability: string } & ServiceReputation> {
  const byCapability = new Map<string, ServiceReputation>();
  for (const service of services) {
    if (service.provider.id !== agentId) continue;
    if (byCapability.has(service.semanticType)) continue;
    byCapability.set(service.semanticType, service.reputation);
  }
  return [...byCapability.entries()]
    .map(([capability, rep]) => ({ capability, ...rep }))
    .sort((a, b) => b.attempts - a.attempts);
}

/** Snapshot summary → the view shape the chip helpers consume. */
export function summaryView(summary: AgentReputationSummary): ReputationView {
  return { score: summary.overallScore, attempts: summary.totalAttempts };
}
