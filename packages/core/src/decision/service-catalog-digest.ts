/**
 * Service-catalog digest for the AC-necessity prompt (R45-P4).
 *
 * The slim prompt (R32) showed only the top-3 partner lines and nothing else
 * about the catalog — the model had no idea what ELSE existed (is there a
 * drainage offer? any lighting at all?). This module pre-processes the full
 * discoverable-service catalog into a structured digest with high information
 * density:
 *
 *   1. CATALOG stats line — per-semanticType/domain grouped counts, so the
 *      whole 60+ service catalog costs one line; signable offers (origin
 *      aggregate/published) are counted and marked separately because they
 *      are CONTRACTABLE RESULTS, not raw device commands.
 *   2. SHORTLIST line — the top-K most gap-relevant partners (rankPartners
 *      semantics, offers weighted ahead at equal relevance), zone kept inline.
 *   3. Gap honesty — when NOTHING in the catalog covers the agent's gap, the
 *      digest says so (hasGapMatch=false) and the caller renders the honest
 *      "0 of N cover this event's needs" line instead of exhibiting
 *      irrelevant partners under a "by relevance" label.
 *
 * Pure module: no I/O, no clocks — deterministic for identical inputs, which
 * is what keeps the LLM response-cache key stable. Caching is inherited from
 * PartnerSummaryIndex (topology signature covers origin/semanticType): the
 * digest itself is a pure function of the cached summaries plus the per-event
 * needs/zone, so it is recomputed per event at trivial cost.
 */

import {
  isOfferOrigin,
  partnerTopK,
  rankPartners,
  type PartnerSummary,
  type RankedPartner,
} from './partner-summaries.js';

/** Grouped per-domain count: label = semanticType, offers = signable subset. */
export interface CatalogDomainCount {
  label: string;
  count: number;
  offers: number;
}

/** The structured catalog digest rendered into the AC-necessity prompt. */
export interface ServiceCatalogDigest {
  /** Total services in the agent's discoverable view. */
  total: number;
  /** Signable offers (origin aggregate/published) within `total`. */
  offerCount: number;
  /** Shortlist budget actually used. */
  topK: number;
  /** Per-semanticType counts, sorted count-desc then label-asc (deterministic). */
  domains: CatalogDomainCount[];
  /** Top-K partners by gap relevance (rankPartners semantics, offer bonus applied). */
  shortlist: RankedPartner[];
  /** Event needs the deciding agent cannot satisfy itself. */
  gapNeeds: string[];
  /** Whether ANY catalog service covers a gap need (honesty gate). */
  hasGapMatch: boolean;
}

/**
 * Build the catalog digest from the agent's partner summaries and the event's
 * capability needs. Ranking/gap semantics are exactly rankPartners — this
 * function only adds the grouped statistics on top.
 */
export function buildServiceCatalogDigest(
  summaries: readonly PartnerSummary[],
  declaredNeeds: readonly string[],
  inferredNeeds: readonly string[],
  eventZone: string,
  agentCapabilities: readonly string[],
  opts?: { topK?: number },
): ServiceCatalogDigest {
  const topK = opts?.topK ?? partnerTopK();
  const { top, gapNeeds, hasGapMatch } = rankPartners(
    summaries,
    declaredNeeds,
    inferredNeeds,
    eventZone,
    agentCapabilities,
    topK,
  );

  const groups = new Map<string, { count: number; offers: number }>();
  let offerCount = 0;
  for (const s of summaries) {
    const offer = isOfferOrigin(s.origin);
    if (offer) offerCount++;
    const g = groups.get(s.semanticType) ?? { count: 0, offers: 0 };
    g.count++;
    if (offer) g.offers++;
    groups.set(s.semanticType, g);
  }
  const domains: CatalogDomainCount[] = [...groups.entries()]
    .map(([label, g]) => ({ label, count: g.count, offers: g.offers }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { total: summaries.length, offerCount, topK, domains, shortlist: top, gapNeeds, hasGapMatch };
}

/**
 * One-line grouped stats, e.g.
 *   `CATALOG: 62 services (9 signable offers) — 24 hvac, 18 lighting, 9 drainage-control(offer)`
 * A group is marked `(offer)` when at least one of its services is a signable
 * offer. Deterministic: domains are pre-sorted by buildServiceCatalogDigest.
 */
export function renderCatalogStatsLine(digest: ServiceCatalogDigest): string {
  const groups = digest.domains
    .map(d => `${d.count} ${d.label}${d.offers > 0 ? '(offer)' : ''}`)
    .join(', ');
  const offersNote = digest.offerCount > 0
    ? ` (${digest.offerCount} signable offer${digest.offerCount === 1 ? '' : 's'})`
    : '';
  return `CATALOG: ${digest.total} services${offersNote} — ${groups}`;
}

/**
 * One-line gap-relevance shortlist, entries in the R32 compact form
 * `name(matchedNeed|semanticType@zone)` with a `,offer` marker on signable
 * offers and a `,stale` marker on heartbeat-stale services (provider missed
 * its liveness window — a dead-provider hint, ranked below live partners at
 * equal gap relevance), e.g.
 *   `SHORTLIST: top 3 of 62 by relevance: campus-drainage(drainage-control@zone-a,offer), ac-1(cooling@zone-a), light-2(lighting-control@zone-b,stale)`
 */
export function renderShortlistLine(digest: ServiceCatalogDigest): string {
  const listed = digest.shortlist
    .map(s =>
      `${s.serviceName}(${s.matchedNeed ?? s.semanticType}${s.zone ? `@${s.zone}` : ''}${isOfferOrigin(s.origin) ? ',offer' : ''}${s.stale === true ? ',stale' : ''})`,
    )
    .join(', ');
  return `SHORTLIST: top ${digest.shortlist.length} of ${digest.total} by relevance (offer = signable result): ${listed}`;
}
