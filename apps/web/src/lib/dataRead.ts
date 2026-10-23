/**
 * Data-read helpers (T-066 surface 3) — pure computations behind the read
 * panel. The server stays authoritative for quota enforcement (429
 * QUOTA_EXCEEDED); the meter here mirrors its counting rules exactly so the
 * UI's "used so far" matches what the next POST /reads will be judged by:
 *
 * - the read budget counts kind='read' rows with outcome='success' only
 *   (T-307 by-kind budgeting; failed reads never burn quota);
 * - sliding windows start at now - windowSec; fixed windows tumble from the
 *   agreement's updatedAt anchor (readWindowStartIso semantics, R14 §5.3).
 */

import type { Agreement, AgreementTerms, UsageRecord } from '../api/types';

export interface ReadQuotaMeter {
  used: number;
  limit: number;
  windowSec: number;
  /** ISO timestamp the current window started at (meter is advisory). */
  windowStartIso: string;
}

/**
 * The read clause the reads lane enforces — from the effective terms
 * (countered state judges by the counter-offer; accepted counters copy in).
 */
export function readTermsOf(agreement: Agreement): AgreementTerms['read'] {
  if (agreement.effectiveTerms?.read !== undefined) return agreement.effectiveTerms.read;
  if (agreement.status === 'countered' && agreement.counteredTerms?.read !== undefined) {
    return agreement.counteredTerms.read;
  }
  return agreement.terms.read;
}

/** Consumer + active + a terms.read clause → the read panel applies. */
export function canReadAgreement(agreement: Agreement, userId: string | null): boolean {
  return (
    userId !== null &&
    agreement.consumer.id === userId &&
    agreement.status === 'active' &&
    readTermsOf(agreement) !== undefined
  );
}

/**
 * Count the reads the server's quota check will count. Returns null when the
 * terms carry no read quota (unlimited — no meter to show).
 */
export function readQuotaMeter(
  usage: readonly UsageRecord[],
  read: NonNullable<AgreementTerms['read']>,
  windowKind: AgreementTerms['windowKind'],
  /** Fixed-window anchor: the agreement's updatedAt (server contract). */
  anchoredAtIso: string,
  nowMs: number = Date.now(),
): ReadQuotaMeter | null {
  if (read.quotaPerWindow === undefined || read.windowSec === undefined) return null;
  const windowMs = read.windowSec * 1000;
  let windowStartMs: number;
  if (windowKind === 'fixed') {
    const anchorMs = Date.parse(anchoredAtIso);
    const elapsed = Math.max(0, nowMs - anchorMs);
    windowStartMs = anchorMs + Math.floor(elapsed / windowMs) * windowMs;
  } else {
    windowStartMs = nowMs - windowMs;
  }
  const windowStartIso = new Date(windowStartMs).toISOString();
  const used = usage.filter(
    record =>
      record.kind === 'read' &&
      record.outcome === 'success' &&
      Date.parse(record.startedAt) >= windowStartMs,
  ).length;
  return { used, limit: read.quotaPerWindow, windowSec: read.windowSec, windowStartIso };
}
