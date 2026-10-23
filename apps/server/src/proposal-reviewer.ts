/**
 * AI semantic review — P-A keeps the interface only
 * (multi-user-simulation-design.md §5.2)
 *
 * The second approval tier reviews what rules cannot express (semantic
 * plausibility, conflicts with existing overlays). In P-A no LLM call is
 * made: the default reviewer ESCALATES every proposal that passed the rule
 * check to the environment owner. P-B swaps in a real reviewer behind this
 * interface without touching the pipeline.
 */

import type { UiLocale } from '@active-collaboration/shared';

import type { AuthUser } from './auth/index.js';
import type { ProposalKind, ProposalRiskLevel } from './db/proposal-store.js';
import { t } from './i18n/index.js';

export type ReviewOutcome = 'allow' | 'reject' | 'escalate';

export interface ReviewVerdict {
  outcome: ReviewOutcome;
  reason: string;
  /**
   * 'ai' = the semantic reviewer; 'owner' = a human decision (decide API);
   * 'delegate' (T-072) = a human decision by the DELEGATED zone-claims
   * member (same decide API, the delegated right — attribution surfaces
   * distinguish who actually decided);
   * 'zone-claim' = auto-approval via zone stewardship (§5.3, no LLM involved);
   * 'review-timeout-auto-approve' = the review LLM failed/timed out on a
   * LOW-risk proposal that had passed the rule check, so platform policy
   * auto-approved it (auditable; the owner can revert afterwards);
   * 'rule-fallback' (Fix-45d) = no semantic reviewer is AVAILABLE at all
   * (no LLM configured) — low-risk + rule-check-passed proposals follow the
   * same auto-approve policy as the timeout path, everything else escalates;
   * 'injection-guard' (S1/Task 2) = the payload tripped the platform-side
   * prompt-injection detector — the LLM was never asked and the proposal
   * escalates to the owner. Never labels an AI judgment that did not happen.
   */
  source: 'ai' | 'owner' | 'delegate' | 'zone-claim' | 'review-timeout-auto-approve' | 'rule-fallback' | 'injection-guard';
}

export interface ReviewInput {
  envId: string;
  author: AuthUser;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  riskLevel: ProposalRiskLevel;
  /**
   * T-063(e): locale for the CODE-AUTHORED reason strings (captured at
   * submit time like notification titles; defaults zh-CN).
   */
  locale?: UiLocale;
}

export interface ProposalReviewer {
  review(input: ReviewInput): Promise<ReviewVerdict>;
}

/**
 * Default reviewer when no LLM is configured (P-A successor, Fix-45d).
 *
 * Pre-Fix-45d this escalated EVERYTHING with "AI semantic review is not
 * implemented yet" labeled source 'ai' — the R4-era "低风险秒批" experience
 * silently disappeared on LLM-less servers and the label claimed a judgment
 * that never ran. Now it mirrors the Fix-12 timeout semantics:
 *   - LOW-risk proposals that already passed the deterministic rule check
 *     auto-approve (audited source 'rule-fallback'; the owner can revert),
 *     when `autoApproveLowRisk` (PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE, on by
 *     default) allows it;
 *   - everything else escalates to the owner with an honest reason.
 */
export class EscalatingReviewer implements ProposalReviewer {
  constructor(private readonly opts: { autoApproveLowRisk?: boolean } = {}) {}

  review(input: ReviewInput): Promise<ReviewVerdict> {
    const locale = input.locale ?? 'zh-CN';
    if (this.opts.autoApproveLowRisk !== false && input.riskLevel === 'low') {
      return Promise.resolve({
        outcome: 'allow',
        // T-063(e): code-authored governance notes are localized.
        reason: t(locale, 'chrome.governance.reviewerUnavailableAutoApprove'),
        source: 'rule-fallback',
      });
    }
    return Promise.resolve({
      outcome: 'escalate',
      reason: t(locale, 'chrome.governance.reviewerUnavailableEscalate'),
      source: 'rule-fallback',
    });
  }
}
