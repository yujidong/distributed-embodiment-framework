/**
 * Partner summary ranking + cache for the slim AC-necessity prompt (R32-A1/A2,
 * extended by R45-P4).
 *
 * The per-event hot-path prompt used to carry the ENTIRE discovered service
 * list (62 services on the campus world ≈ 2.5k tokens of the measured
 * 3443-token prompt — docs/capacity-planning.md §1). This module derives the
 * compact summaries (name + semanticType + zone + origin) and selects the TOP
 * few partners by relevance to the deciding agent's capability GAP, with a
 * per-agent cache invalidated by the service-topology signature.
 *
 * R45-P4: the topology signature now covers origin/semanticType (world-layer
 * offer sync changes must force a recompute), ranking gives signable offers
 * (origin aggregate/published) a bounded bonus, and the top-K budget is
 * configurable via LLM_PARTNER_TOP_K (default 8 — the P4 digest carries the
 * full-catalog stats line, so a wider shortlist no longer costs the full
 * listing).
 *
 * Pure module: no I/O, no clocks — deterministic for identical inputs, which
 * is what keeps the LLM response-cache key stable (A4). The only environment
 * read is the LLM_PARTNER_TOP_K config, constant within a process.
 */

import { capabilityMatches, capabilitySynonymGroups } from '../utils/capabilityMatching.js';
import type { AgentContext } from './ACNecessityAssessor.js';

/**
 * How a catalog service came to exist. Mirrors the world-layer ServiceOrigin
 * (ServiceRegistrationMeta['origin'] in environment/types.ts) — redeclared
 * here so the decision layer does not import the environment module.
 */
export type ServiceOrigin = 'derived' | 'published' | 'flow' | 'aggregate';

/** Default partners shown in the prompt shortlist (top-N by event relevance). */
export const DEFAULT_TOP_PARTNER_LIMIT = 8;

/**
 * Top-K partner budget for the prompt shortlist — `LLM_PARTNER_TOP_K` env
 * override, default DEFAULT_TOP_PARTNER_LIMIT. Read lazily (at selection
 * time) so tests can override per case; constant within a process run, so
 * prompt determinism is unaffected.
 */
export function partnerTopK(): number {
  const raw = process.env.LLM_PARTNER_TOP_K;
  if (raw === undefined) return DEFAULT_TOP_PARTNER_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOP_PARTNER_LIMIT;
}

/**
 * Ranking bonus for signable offers (origin aggregate/published). An offer is
 * a CONTRACTABLE RESULT, not a raw device command — at equal gap relevance it
 * is the better collaboration target, so it ranks ahead. Bounded on purpose:
 * the same weight as a substring gap match (4) and above the zone-proximity
 * bonus (3), but far below a domain-level gap match (14) — relevance to the
 * agent's gap stays the dominant signal. Affects RANKING ONLY: gap verdicts
 * keep capabilityMatches as the single source of truth.
 */
export const OFFER_RANK_BONUS = 4;

/** Signable-offer origins (world-layer semantic offers / published services). */
export function isOfferOrigin(origin: ServiceOrigin | undefined): boolean {
  return origin === 'aggregate' || origin === 'published';
}

/**
 * Compact per-service summary used by the slim AC prompt.
 */
export interface PartnerSummary {
  serviceName: string;
  /** Declared semanticType when published, else first capability (fallback descriptor when no need matches). */
  semanticType: string;
  /** Service location (zone id) when published. */
  zone?: string;
  /** Provenance — signable offers (aggregate/published) get a ranking bonus. */
  origin?: ServiceOrigin;
  /**
   * Liveness: the provider missed its heartbeat window. Stale partners rank
   * BELOW live ones at equal gap relevance and are annotated in the
   * SHORTLIST line — visible (the model may still reason about them) but
   * honestly flagged.
   */
  stale?: boolean;
  capabilities: readonly string[];
  providerAgentId: string;
}

/** A ranked partner carrying the gap need it matched (the WHY of its rank). */
export type RankedPartner = PartnerSummary & { matchedNeed?: string };

/**
 * The agent's capability GAP for one event: the union of the author-declared
 * and keyword-inferred needs this agent cannot satisfy from its own
 * capability surface. This is the single truth for "what would this agent
 * collaborate for" — rankPartners/selectRelevant rank partners against it,
 * and the ACNecessityAssessor's initiator-side fallback fills an omitted
 * proposal `requiredCapabilities` from it (the model decides WHETHER to
 * collaborate; this computation determines WHAT is honestly missing).
 */
export function computeGapNeeds(
  declaredNeeds: readonly string[],
  inferredNeeds: readonly string[],
  agentCapabilities: readonly string[],
): string[] {
  const allNeeds = Array.from(new Set([...declaredNeeds, ...inferredNeeds]));
  return allNeeds.filter(need =>
    !agentCapabilities.some(ac => capabilityMatches(ac, need)),
  );
}

/**
 * Tiered match strength for RANKING (not a verdict — capabilityMatches stays
 * the single truth for gap decisions):
 *   2 = exact or synonym-table match (the strong, domain-level signal)
 *   1 = substring-only match (e.g. "temperature-monitoring" ⊃ "monitoring" —
 *       generic and fires on almost every service, so it must never outrank
 *       a domain match)
 *   0 = no match
 *
 * The synonym lane reads capabilitySynonymGroups() — built-ins PLUS
 * scenario-registered extension groups (P3) — so scenario-specific
 * equivalences rank exactly as strongly as built-in ones.
 */
export function matchStrength(serviceCap: string, need: string): 0 | 1 | 2 {
  const s = serviceCap.toLowerCase();
  const n = need.toLowerCase();
  if (s === n) return 2;
  for (const group of capabilitySynonymGroups()) {
    const g = group.map(x => x.toLowerCase());
    if (g.includes(s) && g.includes(n)) return 2;
  }
  if (s.includes(n) || n.includes(s)) return 1;
  return 0;
}

/**
 * Cheap non-cryptographic hash (djb2) for topology signatures — used only as
 * a Map cache key, never for security.
 */
function djb2Hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Strip the publishDeviceAsService " Service" suffix → the device name. */
function deviceNameOfService(serviceName: string): string {
  return serviceName.replace(/\s+service$/i, '');
}

/**
 * Rank partner summaries by relevance to THIS event and keep the top-K.
 * The dominant signal is coverage of the agent's CAPABILITY GAP — the needs
 * this agent cannot satisfy itself are exactly what it would collaborate for.
 * Synonym/exact matches always outrank generic substring matches, a partner
 * located in the event zone gets a proximity bonus, a signable offer
 * (origin aggregate/published) gets the bounded OFFER_RANK_BONUS, and ties
 * break alphabetically so the selection — and therefore the prompt, and
 * therefore the LLM response cache key — is deterministic for identical
 * semantic inputs.
 *
 * `hasGapMatch` reports whether ANY service covers a gap need: when the
 * gap is uncoverable, the caller must say so honestly instead of
 * exhibiting irrelevant partners under a "by relevance" label (measured:
 * a fire event in an HVAC-only world made the model rationalize
 * 'independent' when shown 3 air conditioners as the "relevant" partners).
 *
 * Free function (no index state) so the P4 catalog digest can rank with the
 * exact same semantics; the PartnerSummaryIndex method below delegates here.
 */
export function rankPartners(
  summaries: readonly PartnerSummary[],
  declaredNeeds: readonly string[],
  inferredNeeds: readonly string[],
  eventZone: string,
  agentCapabilities: readonly string[],
  topK: number = partnerTopK(),
): { top: RankedPartner[]; gapNeeds: string[]; hasGapMatch: boolean } {
  const allNeeds = Array.from(new Set([...declaredNeeds, ...inferredNeeds]));
  const gapNeeds = computeGapNeeds(declaredNeeds, inferredNeeds, agentCapabilities);
  const coveredNeeds = allNeeds.filter(need => !gapNeeds.includes(need));

  let anyGapMatch = false;
  const scored = summaries.map(svc => {
    let score = 0;
    let gapScore = 0;
    let bestStrength = 0;
    let matchedNeed: string | undefined;
    for (const need of gapNeeds) {
      for (const cap of svc.capabilities) {
        const strength = matchStrength(cap, need);
        if (strength === 0) continue;
        score += strength === 2 ? 14 : 4;
        gapScore += strength;
        anyGapMatch = true;
        if (strength > bestStrength || (strength === bestStrength && matchedNeed === undefined)) {
          bestStrength = strength;
          matchedNeed = need;
        }
      }
    }
    for (const need of coveredNeeds) {
      for (const cap of svc.capabilities) {
        const strength = matchStrength(cap, need);
        if (strength > 0) score += strength === 2 ? 3 : 1;
      }
    }
    if (svc.zone === eventZone) score += 3;
    // Offer bonus lives in `score` (the tie-break lane), NEVER in gapScore:
    // a signable offer outranks a raw device service at equal gap relevance
    // but can never outrank a genuinely more gap-relevant partner.
    if (isOfferOrigin(svc.origin)) score += OFFER_RANK_BONUS;
    return { svc, score, gapScore, matchedNeed };
  });
  scored.sort((a, b) =>
    b.gapScore - a.gapScore
    // Liveness demotion: at equal gap relevance a LIVE partner always ranks
    // ahead of a stale one (the stale flag never erases a genuine gap match —
    // gapScore stays the dominant signal).
    || Number(a.svc.stale ?? false) - Number(b.svc.stale ?? false)
    || b.score - a.score
    || a.svc.serviceName.localeCompare(b.svc.serviceName)
    || a.svc.providerAgentId.localeCompare(b.svc.providerAgentId),
  );
  const top = scored.slice(0, topK).map(x => ({
    ...x.svc,
    ...(x.matchedNeed !== undefined ? { matchedNeed: x.matchedNeed } : {}),
  }));
  return { top, gapNeeds, hasGapMatch: anyGapMatch };
}

/**
 * Per-agent partner-summary index with topology-signature invalidation.
 *
 * The signature covers every (provider, name, location, origin, semanticType)
 * tuple of the discoverable-services list the caller just read from the
 * registry — any topology change (publish/unpublish/relocate, or a world-layer
 * re-sync flipping origin/semanticType) changes the signature and forces a
 * recompute; an unchanged topology reuses the cached summaries.
 * Keyed by agentId because each agent sees a different (own-services-
 * excluded) view of the registry.
 */
export class PartnerSummaryIndex {
  private readonly cache = new Map<string, { topologySignature: string; summaries: PartnerSummary[] }>();
  private recomputes = 0;
  private reuses = 0;

  /** Compact summaries for the agent's current view (cached per topology). */
  summariesFor(agentContext: AgentContext): PartnerSummary[] {
    const services = agentContext.discoverableServices ?? [];
    if (services.length === 0) return [];

    const signature = djb2Hash(
      services
        .map(s =>
          `${s.providerAgentId}|${s.serviceName}|${s.location ?? ''}|${s.origin ?? ''}|${s.semanticType ?? ''}|${s.stale === true ? 'stale' : ''}`,
        )
        .sort()
        .join(';'),
    );

    const cached = this.cache.get(agentContext.agentId);
    if (cached && cached.topologySignature === signature) {
      this.reuses++;
      return cached.summaries;
    }

    const summaries: PartnerSummary[] = services.map(s => ({
      serviceName: deviceNameOfService(s.serviceName),
      semanticType: (s.semanticType ?? s.capabilities[0] ?? 'general').toLowerCase(),
      zone: s.location,
      ...(s.origin !== undefined ? { origin: s.origin } : {}),
      ...(s.stale === true ? { stale: true } : {}),
      capabilities: s.capabilities.map(c => c.toLowerCase()),
      providerAgentId: s.providerAgentId,
    }));
    this.cache.set(agentContext.agentId, { topologySignature: signature, summaries });
    this.recomputes++;
    return summaries;
  }

  /** Ranked top-K for THIS event — delegates to rankPartners (same semantics). */
  selectRelevant(
    summaries: PartnerSummary[],
    declaredNeeds: string[],
    inferredNeeds: string[],
    eventZone: string,
    agentCapabilities: readonly string[],
    topK: number = partnerTopK(),
  ): { top: RankedPartner[]; gapNeeds: string[]; hasGapMatch: boolean } {
    return rankPartners(summaries, declaredNeeds, inferredNeeds, eventZone, agentCapabilities, topK);
  }

  /** Cache observability (tests/metrics). */
  getStats(): { recomputes: number; reuses: number } {
    return { recomputes: this.recomputes, reuses: this.reuses };
  }
}
