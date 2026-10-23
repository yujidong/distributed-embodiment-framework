/**
 * R77-F5 residual (Wave A5) — the stale-proposal sweep.
 *
 * A proposed agreement whose provider never decides used to sit silently
 * forever: the consumer's only moves were polling or the self-serve remind
 * (T-309, 10-minute rate limit). This is the platform-side nudge: a periodic
 * sweep (server.ts wires it like the fork GC — boot run + hourly unref'd
 * interval, NO scheduler framework) finds proposals pending past
 * STALE_PROPOSAL_THRESHOLD_MS (24h) and sends the provider ONE AGGREGATED
 * notification per (provider, env) listing them.
 *
 * Noise control (the inbox is a doorbell, not a metronome):
 * - `dedupeUnread` — while the previous aggregated reminder is unread, no
 *   new one stacks;
 * - after it was read, re-notify at most once per RENOTIFY window (24h),
 *   anchored on the latest reminder of the same (provider, kind, refId).
 *
 * The sweep is system-originated: actor === recipient with allowSelf — the
 * noise rule dropping self-echoes exists for USER actions; here the provider
 * IS the intended audience and no user acted.
 */

import type { AgreementRow, AgreementStore } from './db/agreement-store.js';
import type { NotificationStore } from './db/notification-store.js';
import type { ServiceStore } from './db/service-store.js';
import { DEFAULT_LOCALE, t } from './i18n/index.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';

/** A proposal older than this is "stale". */
export const STALE_PROPOSAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;
/** After a reminder was read, wait at least this long before the next one. */
export const STALE_PROPOSAL_RENOTIFY_MS = 24 * 60 * 60 * 1000;

export interface StaleProposalSweepDeps {
  agreementStore: AgreementStore;
  notificationStore: NotificationStore;
  /** Body enrichment: the stale agreements name their services. */
  serviceStore: ServiceStore;
}

export interface StaleProposalSweepResult {
  /** Proposals past the threshold at sweep time. */
  stale: number;
  /** Aggregated provider reminders actually delivered this run. */
  notified: number;
}

export function sweepStaleProposedAgreements(
  deps: StaleProposalSweepDeps,
  nowMs: number = Date.now(),
): StaleProposalSweepResult {
  const cutoffIso = new Date(nowMs - STALE_PROPOSAL_THRESHOLD_MS).toISOString();
  const stale = deps.agreementStore.staleProposedAgreements(cutoffIso);

  // Aggregate per (provider owner, env): one reminder names every stale
  // proposal of that env instead of one notification each.
  const groups = new Map<string, { providerId: string; envId: string; rows: AgreementRow[] }>();
  for (const row of stale) {
    const key = `${row.provider_owner_id}${row.env_id}`;
    const group = groups.get(key);
    if (group !== undefined) group.rows.push(row);
    else groups.set(key, { providerId: row.provider_owner_id, envId: row.env_id, rows: [row] });
  }

  let notified = 0;
  for (const { providerId, envId, rows } of groups.values()) {
    const refId = `stale-proposals:${envId}`;
    const last = deps.notificationStore.latestOfKind(
      providerId,
      NOTIFICATION_KINDS.agreementProposedStale,
      refId,
    );
    if (last !== undefined && nowMs - Date.parse(last.created_at) < STALE_PROPOSAL_RENOTIFY_MS) {
      continue;
    }
    const delivered = notify(deps.notificationStore, {
      recipientId: providerId,
      actorId: providerId,
      allowSelf: true,
      envId,
      kind: NOTIFICATION_KINDS.agreementProposedStale,
      title: t(DEFAULT_LOCALE, 'chrome.notif.agreementProposedStale', { count: rows.length }),
      body: {
        agreements: rows.map(row => ({
          agreementId: row.id,
          serviceId: row.service_id,
          serviceName: (row.service_id !== null ? deps.serviceStore.getService(row.service_id)?.name : undefined) ?? row.service_id,
          proposedAt: row.created_at,
          waitingHours: Math.floor((nowMs - Date.parse(row.created_at)) / (60 * 60 * 1000)),
        })),
        note: 'no SLA applies — decide via POST /api/agreements/:id/decide (accept | reject), ' +
          'or terminate; the consumer can also nudge you via the 10-minute remind lane',
      },
      refId,
      dedupeUnread: true,
    });
    if (delivered !== null) notified += 1;
  }
  return { stale: stale.length, notified };
}
