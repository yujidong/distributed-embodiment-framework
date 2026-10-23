/**
 * Arrival briefing digest (T-071, DevLoop R22; FM-F06 / async UX).
 *
 * The arriving stakeholder's "reconstruct the day from the activity feed"
 * archaeology (R19 FM finding): every ask had to be re-derived by scrolling
 * the raw feed. This module groups the SAME read-model the feed serves
 * (command_log + proposal lifecycle + agreement lifecycle, viewer-aware
 * privacy rules included) into a compact per-day briefing: the top N events
 * per category (proposals decided, agreements changed, devices installed/
 * operated, world & governance) with per-category counts.
 *
 * READ-MODEL ONLY by design: no scheduled jobs, no new tables. The daily
 * memo (ArrivalDigestCache) freezes ONE digest per (env, viewer, UTC day,
 * termination signal) on FIRST READ — the window is [start of day,
 * first-read moment] and later reads the same day return the SAME digest
 * (generatedAt pinned), so two arrivals never get two divergent briefings
 * for one day. R5-F07: the memo key carries the env's latest terminated
 * agreement stamp, so a newly completed collaboration expires the freeze
 * instead of staying invisible until tomorrow. `?since=<iso>` bypasses the
 * memo and computes a fresh windowed digest on demand.
 */

import type { UiLocale } from '@active-collaboration/shared';

import {
  ACTIVITY_MAX_LIMIT,
  buildActivityFeed,
  HIDDEN_SERVICE_PLACEHOLDER,
  type ActivityEntry,
  type ActivityFeedStores,
  type ActivityFeedViewer,
} from './activity-feed.js';
import { terminatedAgreementOutcome } from './db/agreement-store.js';
import type { ServiceInstanceRow } from './db/service-store.js';
import { t } from './i18n/index.js';

/** Top-N entries surfaced per category (counts stay exact). */
export const DIGEST_CATEGORY_LIMIT = 5;

/** R5-F06: how many completed collaborations the digest surfaces. */
export const DIGEST_COMPLETED_COLLABORATIONS_LIMIT = 5;

export type DigestCategoryKey = 'proposals' | 'agreements' | 'devices' | 'world';

export interface DigestCategory {
  /** Localized label (chrome.digest.*). */
  label: string;
  /** Events in the window (exact). */
  count: number;
  /** The newest DIGEST_CATEGORY_LIMIT entries. */
  entries: ActivityEntry[];
}

/**
 * R5-F06: a terminated agreement as a first-class world OUTCOME — the
 * newcomer-visible "collaboration happened here" record. Participants are
 * named as AGENTS (world-structure data any env reader may see), never as
 * owner identities; hidden services keep the T-308 placeholder for
 * unprivileged viewers.
 */
export interface CompletedCollaborationEntry {
  agreementId: string;
  /** The AC collaboration an ephemeral agreement belonged to; null otherwise. */
  collaborationId: string | null;
  source: 'explicit' | 'ac';
  /** v60: nullable — a retired provider's rows are unlinked, history kept. */
  service: { id: string | null; name: string | null };
  consumer: { agentId: string | null; agentName: string | null };
  provider: { agentId: string | null; agentName: string | null };
  /**
   * The collaboration's result: the shared terminatedAgreementOutcome 口径
   * (R5-F09) — the latest metered usage outcome (success/partial/failure)
   * when one exists; 'cancelled' for a collaboration closed before it was
   * ever in effect (AC without a usage row, Fix-21; or an explicit
   * agreement terminated before it ever reached 'active'); T34 (R3):
   * 'ended-without-delivery' for an explicit agreement that WAS active but
   * metered nothing (the old 'completed' label misstated an undelivered
   * contract as a completed collaboration).
   */
  outcome: string;
  terminatedAt: string;
}

/**
 * v60 (R6-E-F08): an agreement PARKED by its provider agent's removal —
 * suspended with status_reason 'provider-unavailable', unlinked from the
 * gone service/agent rows. ENV-OWNER ONLY: this is the owner's work queue
 * ("this contract lost its provider — terminate it via the existing channel
 * or leave it parked"), not a newcomer showcase, so the section is empty
 * for every other viewer. Ids/names are null where the unlink erased the
 * reference; the consumer side survives and stays named.
 */
export interface ProviderUnavailableAgreementEntry {
  agreementId: string;
  source: 'explicit' | 'ac';
  service: { id: string | null; name: string | null };
  consumer: { agentId: string | null; agentName: string | null };
  provider: { agentId: string | null; agentName: string | null };
  reason: string;
  suspendedAt: string;
  /**
   * R6-E-F08 full failover: lightweight re-contracting leads — up to
   * SUBSTITUTES_LIMIT OTHER providers' services in the same env whose
   * semantic_type matches the lost service's (service_instances match only;
   * no LLM, no liveness scoring). Empty when the reference was unlinked
   * (retired provider) or no semantic twin exists.
   */
  suggestedSubstitutes: SuggestedSubstituteEntry[];
}

/** R6-E-F08 full failover: one re-contracting lead in suggestedSubstitutes. */
export interface SuggestedSubstituteEntry {
  serviceId: string;
  serviceName: string;
  providerAgentId: string;
  providerAgentName: string | null;
}

/** Cap on substitute leads per entry — a hint list, not a marketplace. */
export const SUBSTITUTES_LIMIT = 3;

export interface ArrivalDigest {
  envId: string;
  /** The memo day (UTC YYYY-MM-DD) — also the natural key of the briefing. */
  date: string;
  /** Window start (day start, or the explicit ?since). */
  since: string;
  /** Window end (the first-read moment for the daily memo; now for ?since). */
  until: string;
  /** When this digest was computed (pinned by the daily memo). */
  generatedAt: string;
  /** True when served from the per-day memo (not recomputed). */
  frozen: boolean;
  title: string;
  categories: Record<DigestCategoryKey, DigestCategory>;
  /**
   * R5-F06: the env's most recent completed collaborations (newest first,
   * at most DIGEST_COMPLETED_COLLABORATIONS_LIMIT) — NOT window-bound: a
   * collaboration from before today is still the arrival's best evidence
   * that cooperation happens here.
   */
  completedCollaborations: CompletedCollaborationEntry[];
  /**
   * v60 (R6-E-F08): agreements parked by a provider removal (suspended,
   * reason 'provider-unavailable') — the ENV OWNER's discoverability surface
   * for "a contract lost its provider". Empty for non-owner viewers (the
   * parties already got their doorbell notification; strangers/members have
   * no legitimate read on live bilateral rows).
   */
  providerUnavailableAgreements: ProviderUnavailableAgreementEntry[];
  total: number;
}

/** Categorize one feed entry (honest buckets over the feed's own kinds). */
export function digestCategoryOf(entry: ActivityEntry): DigestCategoryKey {
  if (entry.kind === 'proposal') return 'proposals';
  if (entry.kind === 'agreement') return 'agreements';
  if (entry.objectType === 'device') return 'devices';
  // Everything else is world & governance: member changes, env edits,
  // computation registrations, checkpoint/simulation milestones…
  return 'world';
}

/** Compute the digest for [since, until] from the activity feed read-model. */
export function buildArrivalDigest(
  stores: ActivityFeedStores,
  envId: string,
  viewer: ActivityFeedViewer | undefined,
  locale: UiLocale,
  window: { since: string; until: string },
): ArrivalDigest {
  // The feed is newest-first; over-fetch at the cap so a busy day still
  // fills every category's top-N.
  const entries = buildActivityFeed(stores, envId, ACTIVITY_MAX_LIMIT, undefined, viewer)
    .filter(entry => entry.time >= window.since && entry.time <= window.until);
  const categories: Record<DigestCategoryKey, DigestCategory> = {
    proposals: { label: t(locale, 'chrome.digest.proposals'), count: 0, entries: [] },
    agreements: { label: t(locale, 'chrome.digest.agreements'), count: 0, entries: [] },
    devices: { label: t(locale, 'chrome.digest.devices'), count: 0, entries: [] },
    world: { label: t(locale, 'chrome.digest.world'), count: 0, entries: [] },
  };
  for (const entry of entries) {
    const category = categories[digestCategoryOf(entry)];
    category.count += 1;
    if (category.entries.length < DIGEST_CATEGORY_LIMIT) category.entries.push(entry);
  }
  return {
    envId,
    date: window.since.slice(0, 10),
    since: window.since,
    until: window.until,
    generatedAt: new Date().toISOString(),
    frozen: false,
    title: t(locale, 'chrome.digest.title', { since: window.since }),
    categories,
    completedCollaborations: buildCompletedCollaborations(stores, envId, viewer),
    providerUnavailableAgreements: buildProviderUnavailableAgreements(stores, envId, viewer),
    total: entries.length,
  };
}

/**
 * v60 (R6-E-F08): the env owner's provider-loss work queue. Owner-only by
 * construction — the feed/digest read gates stay untouched and the R5-F08
 * restricted-view 口径 is unaffected (terminated history keeps flowing
 * through completedCollaborations).
 */
function buildProviderUnavailableAgreements(
  stores: ActivityFeedStores,
  envId: string,
  viewer: ActivityFeedViewer | undefined,
): ProviderUnavailableAgreementEntry[] {
  if (viewer === undefined || viewer.userId === null || viewer.userId !== viewer.envOwnerId) {
    return [];
  }
  // R6-E-F08 full failover: the section now covers BOTH parked reasons —
  // removal retirements (provider-unavailable) and watchdog suspensions
  // (provider-unreachable). Snapshot the env catalog once per digest build;
  // substitute matching is pure semantic_type equality over it.
  const catalog = stores.serviceStore.servicesOf(envId);
  return stores.agreementStore.suspendedProviderTroubleOfEnv(envId).map(row => {
    const service = row.service_id !== null ? stores.serviceStore.getService(row.service_id) : undefined;
    const providerAgent =
      row.provider_agent_id !== null ? stores.envStore.getAgent(row.provider_agent_id) : undefined;
    const consumerAgent =
      row.consumer_agent_id !== null ? stores.envStore.getAgent(row.consumer_agent_id) : undefined;
    return {
      agreementId: row.id,
      source: row.source,
      service: { id: row.service_id, name: service?.name ?? null },
      consumer: { agentId: row.consumer_agent_id, agentName: consumerAgent?.name ?? null },
      provider: { agentId: row.provider_agent_id, agentName: providerAgent?.name ?? null },
      reason: row.status_reason ?? 'provider-unavailable',
      suspendedAt: row.updated_at,
      suggestedSubstitutes: suggestedSubstitutesOf(stores, catalog, row.service_id, service?.semantic_type, row.provider_agent_id),
    };
  });
}

/**
 * R6-E-F08 full failover: re-contracting leads for a parked agreement —
 * other providers' services in the same env covering the lost service's
 * semantic type. Deliberately lightweight: a DB-catalog semantic_type match
 * only (no LLM, no liveness scoring — the stale hard gate already keeps a
 * known-dead provider out of NEW signings). Empty for unlinked rows (a
 * retired provider's service reference is gone, nothing to match on).
 */
function suggestedSubstitutesOf(
  stores: ActivityFeedStores,
  catalog: ServiceInstanceRow[],
  lostServiceId: string | null,
  lostSemanticType: string | undefined,
  lostProviderAgentId: string | null,
): SuggestedSubstituteEntry[] {
  if (lostServiceId === null || lostSemanticType === undefined) return [];
  return catalog
    .filter(candidate =>
      candidate.semantic_type === lostSemanticType &&
      candidate.id !== lostServiceId &&
      candidate.provider_agent_id !== lostProviderAgentId)
    .slice(0, SUBSTITUTES_LIMIT)
    .map(candidate => ({
      serviceId: candidate.id,
      serviceName: candidate.name,
      providerAgentId: candidate.provider_agent_id,
      providerAgentName: stores.envStore.getAgent(candidate.provider_agent_id)?.name ?? null,
    }));
}

/**
 * R5-F06: the newest terminated agreements of the env as first-class
 * outcomes — AC ephemeral agreements auto-terminate 30s after their
 * collaboration ends and vanish from the parties' default list; without
 * this section a newcomer sees no trace that cooperation ever happened.
 * The outcome rides the shared terminatedAgreementOutcome 口径 (R5-F09):
 * a completed collaboration appends one usage row (kind='ac') with the
 * classified outcome; a cancelled one terminates WITHOUT a usage row
 * (Fix-21); an explicit agreement that never reached 'active' before
 * termination is 'cancelled' too — it was never in effect.
 */
function buildCompletedCollaborations(
  stores: ActivityFeedStores,
  envId: string,
  viewer: ActivityFeedViewer | undefined,
): CompletedCollaborationEntry[] {
  const terminated = stores.agreementStore
    .agreementsOfEnv(envId)
    .filter(row => row.status === 'terminated')
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .slice(0, DIGEST_COMPLETED_COLLABORATIONS_LIMIT);
  return terminated.map(row => {
    // v60: retired providers leave service_id/provider_agent_id NULL — the
    // history entry survives with null refs instead of 404-ing the digest.
    const service = row.service_id !== null ? stores.serviceStore.getService(row.service_id) : undefined;
    const providerAgent =
      row.provider_agent_id !== null ? stores.envStore.getAgent(row.provider_agent_id) : undefined;
    const consumerAgent =
      row.consumer_agent_id !== null ? stores.envStore.getAgent(row.consumer_agent_id) : undefined;
    const usageOutcome = stores.agreementStore.usageOf(row.id).at(-1)?.outcome;
    // R5-F09: the ONE terminated-outcome 口径 (shared with the F08
    // restricted view) — never-active agreements read 'cancelled', not
    // 'completed'.
    const outcome = terminatedAgreementOutcome(row, usageOutcome);
    // T-308 parity: a hidden service is named (even by id) only for its
    // provider owner, the agreement's parties, and the env owner.
    const hideService =
      service !== undefined &&
      service.visibility === 'hidden' &&
      viewer !== undefined &&
      viewer.userId !== viewer.envOwnerId &&
      viewer.userId !== row.provider_owner_id &&
      viewer.userId !== row.consumer_owner_id;
    return {
      agreementId: row.id,
      collaborationId: row.collaboration_id,
      source: row.source,
      service: hideService
        ? { id: HIDDEN_SERVICE_PLACEHOLDER, name: HIDDEN_SERVICE_PLACEHOLDER }
        : { id: row.service_id, name: service?.name ?? null },
      consumer: { agentId: row.consumer_agent_id, agentName: consumerAgent?.name ?? null },
      provider: { agentId: row.provider_agent_id, agentName: providerAgent?.name ?? null },
      outcome,
      terminatedAt: row.updated_at,
    };
  });
}

/** UTC day start (YYYY-MM-DDTHH:MM:SS.mmmZ) of an ISO instant. */
function utcDayStart(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

/**
 * The per-(env, viewer, day) memo: the FIRST read of a day computes and
 * freezes the digest; later reads the same day return the same view (one
 * briefing per day per member — no divergent recounts for one day). Purely
 * in-memory (read-model discipline): a restart recomputes on the next
 * arrival, which is harmless — the window only shrinks to that moment.
 */
export class ArrivalDigestCache {
  private readonly cache = new Map<string, ArrivalDigest>();

  /**
   * The memoized digest for (env, viewer, today) — computed on first read.
   * R5-F07: the key also carries the env's latest-termination stamp
   * (`terminatedSignal` — AgreementStore.latestTerminatedAt), so a newly
   * terminated agreement expires the frozen memo and the new completed
   * collaboration becomes visible to members who already read today.
   */
  daily(
    compute: () => ArrivalDigest,
    key: { envId: string; viewerKey: string; nowIso: string; terminatedSignal?: string },
  ): ArrivalDigest {
    const day = key.nowIso.slice(0, 10);
    const cacheKey = `${key.envId}|${key.viewerKey}|${day}|${key.terminatedSignal ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return { ...cached, frozen: true };
    const digest = compute();
    this.cache.set(cacheKey, digest);
    return digest;
  }

  /** Test seam / env deletion cascade. */
  dropEnv(envId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${envId}|`)) this.cache.delete(key);
    }
  }
}

/** The daily-memo window: [UTC day start, now]. */
export function dailyWindowOf(nowIso: string): { since: string; until: string } {
  return { since: utcDayStart(nowIso), until: nowIso };
}
