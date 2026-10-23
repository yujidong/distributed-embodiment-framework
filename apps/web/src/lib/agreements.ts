/**
 * Agreement display helpers (Fix-11 / Fix-17) — status labels, the per-role
 * action gates mirroring the server's lifecycle rules, and a one-line terms
 * summary. Pure and defensive; the server stays authoritative (a stale row
 * just earns a 409 toast).
 *
 * i18n: pure-function module — strings are read from the global i18next
 * instance via `i18n.t` at call time so language switches propagate without
 * reassignment.
 */

import type { Agreement, AgreementStatus, AgreementTerms } from '../api/types';
import i18n from '../i18n/config';

export function agreementStatusLabel(status: AgreementStatus): string {
  return i18n.t(`agreementsLib:status${status.charAt(0).toUpperCase()}${status.slice(1)}`);
}

/**
 * Decide (accept/reject): the right follows the state (T-059, §5.1) —
 * proposed → the PROVIDER decides the consumer's proposal; countered → the
 * CONSUMER decides the provider's counter-offer (accept = the countered
 * terms become the contract).
 */
export function canDecide(agreement: Agreement, userId: string | null): boolean {
  if (userId === null) return false;
  if (agreement.status === 'proposed') return agreement.provider.id === userId;
  if (agreement.status === 'countered') return agreement.consumer.id === userId;
  return false;
}

/** Who holds the decide right in the current state (null = nobody/waiting). */
export function deciderSide(agreement: Agreement): 'provider' | 'consumer' | null {
  if (agreement.status === 'proposed') return 'provider';
  if (agreement.status === 'countered') return 'consumer';
  return null;
}

/** Provider-only: counter a PROPOSED agreement with a complete terms object. */
export function canCounter(agreement: Agreement, userId: string | null): boolean {
  return (
    userId !== null &&
    agreement.provider.id === userId &&
    agreement.status === 'proposed'
  );
}

/**
 * The waiting side may remind the decider (T-309; T-059 §5.4 symmetric):
 * proposed → the CONSUMER waits on the provider; countered → the PROVIDER
 * waits on the consumer.
 */
export function canRemind(agreement: Agreement, userId: string | null): boolean {
  if (userId === null) return false;
  const decider = deciderSide(agreement);
  if (decider === 'provider') return agreement.consumer.id === userId;
  if (decider === 'consumer') return agreement.provider.id === userId;
  return false;
}

/** Provider-only: suspend an active agreement. */
export function canSuspend(agreement: Agreement, userId: string | null): boolean {
  return (
    userId !== null && agreement.provider.id === userId && agreement.status === 'active'
  );
}

/** Either party: terminate from proposed / active / suspended. */
export function canTerminate(agreement: Agreement, userId: string | null): boolean {
  if (userId === null) return false;
  const isParty =
    agreement.consumer.id === userId || agreement.provider.id === userId;
  return (
    isParty &&
    agreement.status !== 'rejected' &&
    agreement.status !== 'terminated'
  );
}

/** Consumer-only: invoke an active agreement. */
export function canInvoke(agreement: Agreement, userId: string | null): boolean {
  return (
    userId !== null && agreement.consumer.id === userId && agreement.status === 'active'
  );
}

/** One-line terms summary; empty terms render as 不限（默认）. */
export function summarizeTerms(terms: AgreementTerms): string {
  const parts: string[] = [];
  if (terms.quotaPerWindow !== undefined) {
    const unit = terms.meteringUnit ? i18n.t('agreementsLib:termsUnit', { unit: terms.meteringUnit }) : '';
    const window = terms.windowSec !== undefined ? i18n.t('agreementsLib:termsWindow', { sec: terms.windowSec }) : '';
    parts.push(
      i18n.t('agreementsLib:termsQuota', { quota: terms.quotaPerWindow, unit, window }),
    );
  }
  if (terms.pricePerUnit !== undefined) {
    const unit = terms.priceUnit ? i18n.t('agreementsLib:termsUnitPrefix', { unit: terms.priceUnit }) : '';
    parts.push(i18n.t('agreementsLib:termsPrice', { price: terms.pricePerUnit, unit }));
  }
  if (terms.notes) parts.push(terms.notes);
  return parts.length > 0 ? parts.join(i18n.t('llmMetricsLib:separator')) : i18n.t('agreementsLib:termsDefault');
}

/** Counterparty label for a list row ("对方：小B（提供方）"). */
export function counterpartyLabel(agreement: Agreement, userId: string | null): string {
  if (userId !== null && agreement.consumer.id === userId) {
    return `${agreement.provider.displayName}${i18n.t('agreementsLib:counterpartyProviderSuffix')}`;
  }
  if (userId !== null && agreement.provider.id === userId) {
    return `${agreement.consumer.displayName}${i18n.t('agreementsLib:counterpartyConsumerSuffix')}`;
  }
  return `${agreement.consumer.displayName} → ${agreement.provider.displayName}`;
}

/**
 * R2-UX-09: does a terms object carry a BINDING structured clause — the same
 * 口径 as the server's termsEnforced (agreements/view.ts: action.command
 * constrains invokes, read scopes data reads). Used to layer the「未设结构
 * 化条款」badge copy (a counter-offer carrying structured clauses is a
 * different story from a plain prose-only contract).
 */
export function hasStructuredTerms(terms: AgreementTerms | null | undefined): boolean {
  if (terms === null || terms === undefined) return false;
  return terms.action?.command !== undefined || terms.read !== undefined;
}

/**
 * R2-FEAT-03: the unified inbox ordering for agreement lists —「待裁决置顶 +
 * 时间倒序」: rows awaiting MY decide first, then everything else, each group
 * newest-first (createdAt DESC, id tiebreak for stable order). The server
 * list stays created_at ASC (CLI/台账 口径不动); this is the web inbox lane.
 */
export function sortAgreementsForInbox(
  agreements: readonly Agreement[],
  userId: string | null,
): Agreement[] {
  return [...agreements].sort((a, b) => {
    const aDecide = canDecide(a, userId) ? 0 : 1;
    const bDecide = canDecide(b, userId) ? 0 : 1;
    if (aDecide !== bDecide) return aDecide - bDecide;
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

/**
 * R2-FEAT-03: merge the provider/consumer mailboxes without doubles — an
 * agreement where I'm BOTH parties arrives in both lists and used to render
 * twice (duplicate React keys included). First occurrence wins.
 */
export function dedupeAgreementsById(agreements: readonly Agreement[]): Agreement[] {
  const seen = new Set<string>();
  const out: Agreement[] = [];
  for (const agreement of agreements) {
    if (seen.has(agreement.id)) continue;
    seen.add(agreement.id);
    out.push(agreement);
  }
  return out;
}

/** R2-FEAT-03: short id fragment so look-alike rows stay distinguishable. */
export function shortAgreementId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

/**
 * T-059: the terms that ARE (or, while countered, WILL BE) enforced —
 * `effectiveTerms` when the server sent it, otherwise computed from status.
 */
export function effectiveTermsOf(agreement: Agreement): AgreementTerms {
  if (agreement.effectiveTerms !== undefined) return agreement.effectiveTerms;
  if (agreement.status === 'countered' && agreement.counteredTerms != null) {
    return agreement.counteredTerms;
  }
  return agreement.terms;
}

/** One human-readable clause of a terms diff (T-059 §5.3). */
export interface TermsDiffLine {
  key: string;
  change: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

function renderTermsValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * A structured clause-level diff of two terms objects — which clauses were
 * added / removed / changed; nested clause objects (action/read/trigger)
 * compare by JSON, scalars render verbatim. Mirrors the server's
 * counter-notification termsDiff so the detail view and the notification
 * tell the same story.
 */
export function termsDiffLines(
  original: AgreementTerms,
  countered: AgreementTerms,
): TermsDiffLine[] {
  const lines: TermsDiffLine[] = [];
  const keys = new Set([...Object.keys(original), ...Object.keys(countered)]);
  for (const key of keys) {
    const before = (original as Record<string, unknown>)[key];
    const after = (countered as Record<string, unknown>)[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before === undefined) {
      lines.push({ key, change: 'added', after: renderTermsValue(after) });
    } else if (after === undefined) {
      lines.push({ key, change: 'removed', before: renderTermsValue(before) });
    } else {
      lines.push({
        key,
        change: 'changed',
        before: renderTermsValue(before),
        after: renderTermsValue(after),
      });
    }
  }
  return lines;
}
