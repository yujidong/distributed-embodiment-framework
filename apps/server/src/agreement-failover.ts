/**
 * R6-E-F08 full failover (data/usertest-r6/track-e-capability.md §3 residual):
 * the unreachable-provider WATCHDOG.
 *
 * The v60 retire semantic covers REMOVED providers (delete → suspended with
 * 'provider-unavailable', never recover). The leftover gap was a provider
 * that is STALE — heartbeats lost, agent row still present: its active
 * agreements stayed active with nobody home, and the world had no janitor
 * for them. This sweep is that janitor:
 *
 * - SUSPEND half: an explicit active agreement whose provider missed
 *   heartbeats past `unreachableMs` (default 5 min ≫ the 90s service-stale
 *   TTL) → suspended with status_reason 'provider-unreachable', both
 *   parties notified, agreement-transition audit + env-stream broadcast.
 * - RECOVER half: the provider heartbeats again → the parked agreement is
 *   terminated (reason 'provider-recovered') and a SUCCESSOR agreement is
 *   born active on identical terms — "re-activation = terminate + re-sign".
 *   The lifecycle gains NO suspended → active edge (TLA transition set zero
 *   expansion, same posture as the v60 retire); quota/usage history stays
 *   on the terminated row.
 *
 * Liveness fact source (server side): the env's authoritative world-session
 * runtime — `sim-<envId>-world-session` → EnvironmentCenter registrations
 * armed with `lastSeenAt` by ServicePublisher heartbeats (runtime agent
 * self-registrations only; world-mirrored rows deliberately carry no
 * heartbeat semantics and never judge). The probe is a SEAM: the sweep
 * itself is a pure function over stores + probe, server.ts wires the probe
 * to the live registry.
 *
 * Honesty boundaries (zero disturbance by construction):
 * - env without a RUNNING world session → probe returns null → no judgment
 *   (a paused/stopped/hibernated world must not mass-suspend its contracts);
 * - an agent with NO heartbeat-tracked registration → null → no judgment
 *   (mirror-only providers are simply outside this mechanism);
 * - retired rows (provider-unavailable) are never touched by the recovery
 *   half — a removed provider stays retired.
 */

import type {
  AgreementRow,
  AgreementStore,
} from './db/agreement-store.js';
import {
  PROVIDER_RECOVERED_REASON,
  PROVIDER_UNREACHABLE_REASON,
} from './db/agreement-store.js';
import type { EnvironmentStore } from './db/environment-store.js';
import type { NotificationStore } from './db/notification-store.js';
import type { ServiceStore } from './db/service-store.js';
import type { ChangePipeline } from './change-pipeline.js';
import { DEFAULT_LOCALE, t } from './i18n/index.js';
import { NOTIFICATION_KINDS, notify } from './notifications.js';

/** A provider silent longer than this is "unreachable" (≫ service-stale TTL). */
export const DEFAULT_FAILOVER_UNREACHABLE_MS = 5 * 60 * 1000;

/**
 * Audit/stream actor for watchdog-originated transitions: no user acted —
 * the platform did. command_log.actor_id has been a plain TEXT column since
 * v22, and the stream's actorRef falls back to the raw id for unknown users,
 * so the sentinel is safe on both planes and self-describing in the record.
 */
export const FAILOVER_ACTOR_ID = 'system';

/**
 * Server-side liveness seam. Returns the freshest heartbeat (ms epoch) of
 * any heartbeat-tracked registration this agent holds in the env's live
 * world-session runtime, or NULL when there is no running session or the
 * agent has no heartbeat-tracked registration — "unknown", never judged.
 */
export interface ProviderLivenessProbe {
  latestHeartbeatMs(envId: string, agentId: string): number | null;
}

export interface ProviderFailoverSweepDeps {
  agreementStore: AgreementStore;
  serviceStore: ServiceStore;
  /** Agent display names for notification bodies. */
  envStore: EnvironmentStore;
  notificationStore: NotificationStore;
  pipeline: ChangePipeline;
  liveness: ProviderLivenessProbe;
  /** Silence past this many ms = unreachable. Default 5 min. */
  unreachableMs?: number;
}

export interface ProviderFailoverSweepResult {
  /** Watch rows evaluated this run (explicit active + watchdog-parked). */
  watched: number;
  /** active → suspended (provider-unreachable) transitions this run. */
  suspended: number;
  /** terminate + re-sign recovery pairs this run. */
  recovered: number;
}

export function sweepProviderFailover(
  deps: ProviderFailoverSweepDeps,
  nowMs: number = Date.now(),
): ProviderFailoverSweepResult {
  const unreachableMs = deps.unreachableMs ?? DEFAULT_FAILOVER_UNREACHABLE_MS;
  const rows = deps.agreementStore.failoverWatchRows();
  let suspended = 0;
  let recovered = 0;

  // One probe per (env, provider agent) per run — heartbeats don't move
  // within a synchronous sweep and the registry read is not free.
  const probeCache = new Map<string, number | null>();
  const probeOf = (envId: string, agentId: string): number | null => {
    const key = `${envId}${agentId}`;
    if (!probeCache.has(key)) {
      probeCache.set(key, deps.liveness.latestHeartbeatMs(envId, agentId));
    }
    return probeCache.get(key) ?? null;
  };

  for (const row of rows) {
    // failoverWatchRows guarantees both non-null.
    const providerAgentId = row.provider_agent_id as string;
    const serviceId = row.service_id as string;
    const last = probeOf(row.env_id, providerAgentId);
    if (last === null) continue; // unknown — never judged
    const silentMs = nowMs - last;

    if (row.status === 'active' && silentMs > unreachableMs) {
      suspendForUnreachable(deps, row, providerAgentId, serviceId, last, silentMs);
      suspended += 1;
    } else if (
      row.status === 'suspended' &&
      row.status_reason === PROVIDER_UNREACHABLE_REASON &&
      silentMs <= unreachableMs
    ) {
      recoverParked(deps, row, providerAgentId, serviceId);
      recovered += 1;
    }
  }
  return { watched: rows.length, suspended, recovered };
}

// ---------------------------------------------------------------------------
// Transition halves
// ---------------------------------------------------------------------------

function suspendForUnreachable(
  deps: ProviderFailoverSweepDeps,
  row: AgreementRow,
  providerAgentId: string,
  serviceId: string,
  lastHeartbeatMs: number,
  silentMs: number,
): void {
  const next = deps.agreementStore.setStatus(row.id, 'suspended', PROVIDER_UNREACHABLE_REASON);
  deps.pipeline.publishAgreement(row.env_id, 'suspended', row.id, FAILOVER_ACTOR_ID);
  deps.pipeline.log({
    envId: row.env_id,
    actorId: FAILOVER_ACTOR_ID,
    kind: 'agreement-transition',
    payload: {
      agreementId: row.id,
      serviceId,
      from: 'active',
      to: 'suspended',
      reason: PROVIDER_UNREACHABLE_REASON,
      providerAgentId,
      lastHeartbeatAt: new Date(lastHeartbeatMs).toISOString(),
      silentMs,
    },
  });
  notifyParties(deps, row, providerAgentId, serviceId, {
    kind: NOTIFICATION_KINDS.agreementProviderUnreachable,
    title: t(DEFAULT_LOCALE, 'chrome.notif.agreementProviderUnreachable'),
    extra: {
      from: 'active',
      status: next.status,
      reason: PROVIDER_UNREACHABLE_REASON,
      lastHeartbeatAt: new Date(lastHeartbeatMs).toISOString(),
      silentMs,
      note: 'recoverable — when the provider heartbeats again the watchdog ' +
        'closes this contract and re-signs a successor on identical terms',
    },
  });
}

function recoverParked(
  deps: ProviderFailoverSweepDeps,
  row: AgreementRow,
  providerAgentId: string,
  serviceId: string,
): void {
  const { terminated, successor } = deps.agreementStore.resignRecoveredAgreement(row);
  deps.pipeline.publishAgreement(row.env_id, 'terminated', terminated.id, FAILOVER_ACTOR_ID);
  deps.pipeline.log({
    envId: row.env_id,
    actorId: FAILOVER_ACTOR_ID,
    kind: 'agreement-transition',
    payload: {
      agreementId: terminated.id,
      serviceId,
      from: 'suspended',
      to: 'terminated',
      reason: PROVIDER_RECOVERED_REASON,
      providerAgentId,
      successorAgreementId: successor.id,
    },
  });
  // 'accepted' is the closest existing stream action for "this agreement is
  // now active" (the action vocabulary has no born-active marker; the audit
  // row above carries the full story).
  deps.pipeline.publishAgreement(row.env_id, 'accepted', successor.id, FAILOVER_ACTOR_ID);
  deps.pipeline.log({
    envId: row.env_id,
    actorId: FAILOVER_ACTOR_ID,
    kind: 'agreement-transition',
    payload: {
      agreementId: successor.id,
      serviceId,
      from: null,
      to: 'active',
      reason: PROVIDER_RECOVERED_REASON,
      providerAgentId,
      supersedesAgreementId: terminated.id,
      terms: JSON.parse(successor.terms_json) as unknown,
    },
  });
  notifyParties(deps, row, providerAgentId, serviceId, {
    kind: NOTIFICATION_KINDS.agreementProviderRecovered,
    title: t(DEFAULT_LOCALE, 'chrome.notif.agreementProviderRecovered'),
    extra: {
      from: 'suspended',
      status: successor.status,
      reason: PROVIDER_RECOVERED_REASON,
      successorAgreementId: successor.id,
    },
  });
}

/** Both owners hear every watchdog transition (unlike the retire's consumer-only doorbell: here the provider owner still exists). */
function notifyParties(
  deps: ProviderFailoverSweepDeps,
  row: AgreementRow,
  providerAgentId: string,
  serviceId: string,
  notice: { kind: string; title: string; extra: Record<string, unknown> },
): void {
  const serviceName = deps.serviceStore.getService(serviceId)?.name ?? null;
  const providerAgentName = deps.envStore.getAgent(providerAgentId)?.name ?? null;
  for (const recipientId of [row.consumer_owner_id, row.provider_owner_id]) {
    notify(deps.notificationStore, {
      recipientId,
      actorId: recipientId,
      allowSelf: true,
      envId: row.env_id,
      kind: notice.kind,
      title: notice.title,
      body: {
        agreementId: row.id,
        serviceId,
        serviceName,
        providerAgentId,
        providerAgentName,
        ...notice.extra,
      },
      refId: row.id,
      // A flapping provider re-parks/re-recovers: one UNREAD notice per
      // (recipient, kind, agreement) at a time — the bell rings again only
      // after the previous one was acknowledged.
      dedupeUnread: true,
    });
  }
}
