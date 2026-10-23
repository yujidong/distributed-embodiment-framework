/**
 * Notification kinds + the shared emit helper (Fix-16)
 *
 * One funnel for every producer (proposal pipeline, agreement routes, AC
 * bridge) so the noise-control rules live in exactly one place:
 *
 * - 自己触发的事件不通知自己 — recipient === actor → dropped (the actor
 *   already saw the synchronous response / made the call);
 * - `dedupeUnread` for repeatable events — at most one UNREAD notification
 *   per (recipient, kind, refId); a new one may land once the user read the
 *   previous (the bell rings again only after it was acknowledged).
 */

import type { NotificationRow, NotificationStore } from './db/notification-store.js';

/** Wire shape: `body` is the parsed JSON detail object (never a string). R21-W5: moved from the route file. */
export function notificationToJson(row: NotificationRow) {
  let body: unknown = {};
  try {
    body = JSON.parse(row.body_json);
  } catch {
    // Corruption must never break the inbox — fall back to the raw text.
    body = row.body_json;
  }
  return {
    id: row.id,
    envId: row.env_id,
    kind: row.kind,
    title: row.title,
    body,
    refId: row.ref_id,
    repeatCount: row.repeat_count,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export const NOTIFICATION_KINDS = {
  proposalEscalated: 'proposal.escalated',
  /**
   * R33 (DevLoop, Care F2): the AUTHOR nudged the decider about a still-
   * escalated proposal (POST /api/proposals/:id/remind — supervised-zone
   * builders used to sit blocked with no polite pressure channel; same
   * rate limit semantics as the agreement remind).
   */
  proposalReminded: 'proposal.reminded',
  proposalRejected: 'proposal.rejected',
  proposalApplied: 'proposal.applied',
  proposalReverted: 'proposal.reverted',
  /**
   * T-004: an AUTO-applied proposal (rule-fallback / zone-claim autonomy /
   * review-timeout auto-approve — no human verdict) also reaches the
   * environment owner, whose world changed without their approval.
   */
  proposalAutoApplied: 'proposal.auto_applied',
  /**
   * T-072 (D-1 decide half): the proposal was decided by the DELEGATED
   * zone-claims member and applied — the owner's world changed through a
   * right they granted (body carries decidedById/decidedVia).
   */
  proposalDelegateApplied: 'proposal.delegate-applied',
  agreementProposed: 'agreement.proposed',
  /**
   * T-309 (DevLoop R12, FR-F07): the consumer nudged the provider about a
   * still-proposed agreement (POST /api/agreements/:id/remind — a nudge,
   * not pressure; rate-limited server-side to one per 10 minutes since the
   * proposal or the last reminder).
   */
  agreementReminded: 'agreement.reminded',
  /**
   * R77-F5 residual (Wave A5): the periodic stale-proposal sweep found
   * proposals sitting unanswered past 24h — one AGGREGATED reminder per
   * (provider, env) listing the stale agreements, re-notified at most once
   * per 24h (see agreement-stale.ts).
   */
  agreementProposedStale: 'agreement.proposed-stale',
  agreementAccepted: 'agreement.accepted',
  agreementRejected: 'agreement.rejected',
  agreementSuspended: 'agreement.suspended',
  /**
   * D3 (DevLoop R28, T-080): the consumer HELD the agreement — a bounded
   * consumption pause (auto-trigger + manual invokes suspended for that
   * agreement only; quota untouched). Body carries durationSec +
   * holdExpiresAt so the provider knows the why and the until.
   */
  agreementHeld: 'agreement.held',
  /** D3: the consumer resumed the held agreement (or it auto-expired lazily on a read; this kind fires only on the explicit DELETE). */
  agreementResumed: 'agreement.resumed',
  agreementTerminated: 'agreement.terminated',
  agreementInvokeFailed: 'agreement.invoke-failed',
  /**
   * T-049: the agreement was DESTROYED by a cascade (its provider agent was
   * removed) — not a lifecycle transition either party chose.
   */
  agreementProviderRemoved: 'agreement.provider-removed',
  /**
   * R6-E-F08 full failover (agreement-failover.ts): the watchdog suspended
   * the agreement — its provider agent missed heartbeats past the failover
   * threshold. RECOVERABLE (unlike provider-removed): both parties are
   * notified, and a heartbeat comeback triggers the terminate + re-sign
   * recovery (agreement.provider-recovered).
   */
  agreementProviderUnreachable: 'agreement.provider-unreachable',
  /**
   * R6-E-F08 full failover: the unreachable provider heartbeats again — the
   * parked agreement was terminated (provider-recovered) and a successor
   * re-signed on identical terms (body carries successorAgreementId).
   */
  agreementProviderRecovered: 'agreement.provider-recovered',
  /**
   * T-403 (DevLoop R19, NW-F03): the agreement was DESTROYED because a
   * device capability change regenerated the derived service it contracted
   * (FK cascade) — not a lifecycle transition either party chose. The
   * notification body carries successor semantic types from the same sync
   * so the consumer can re-contract.
   */
  agreementDerivedRegenerated: 'agreement.derived-regenerated',
  /**
   * R14 Wave-A (design-data-services.md §7): the provider revoked the
   * computation a data agreement delivers on. The agreement is NOT
   * terminated (that stays bilateral) — reads turn 409
   * COMPUTATION_UNREGISTERED, push sockets close at their next trigger.
   */
  agreementComputeDropped: 'agreement.compute-dropped',
  /**
   * R14 Wave-B (design-consent-semantics.md §5.3): the provider countered a
   * proposed agreement with new terms — the decide right passes to the
   * CONSUMER (replyHint on the notification body names the endpoint).
   */
  agreementCountered: 'agreement.countered',
  /**
   * R14 Wave-B (§4.2): an env member requested access to a hidden service.
   * Bilateral data transaction — no SLA, the remind channel is the only
   * nudge; explicit rejection (provider DELETE) or silence are both valid.
   */
  serviceAccessRequested: 'service.access-requested',
  /** §4.2: the provider granted (or extended) access — the door is open. */
  serviceAccessGranted: 'service.access-granted',
  /** §4.1: the provider revoked the grant — canSee falls back to 404 now. */
  serviceAccessRevoked: 'service.access-revoked',
  /** §4.2: the requester's rate-limited nudge on a pending access request. */
  serviceAccessReminded: 'service.access-request-reminded',
  /**
   * T-069 (DevLoop R23, R19 NW-F04): a service just appeared that matches
   * the recipient's standing ask (需求板) — the async-market cold-start
   * bridge ("when you publish X, I want Y" is now expressible). Body names
   * the ask + the matched service + provider; when the ask had autoPropose
   * the body also carries the pre-filled agreement id (or the honest skip
   * reason).
   */
  askMatched: 'ask.matched',
  /**
   * T-504 (DevLoop R24, EC24-F05): the PROVIDER-side half of a match —
   * the recipient's own publish just satisfied a standing ask (before this,
   * the provider's only signal was the board row vanishing). ONE-SHOT event
   * tied to their own action; this is NOT the §11.5-rejected reverse
   * subscription (no standing listener, no ask-arrival push). Body carries
   * the ask + asker + autoPropose result; replyHint is the decide lane when
   * a pre-filled proposal landed, else points at the board (the asker's
   * move). refId = the ask id.
   */
  askMatchedProvider: 'ask.matched-provider',
  collaborationAccepted: 'collaboration.accepted',
  collaborationRejected: 'collaboration.rejected',
  /** Membership: a user was added to an environment (invite / batch import). */
  memberAdded: 'member.added',
  /**
   * T15 (R2, u3-F4): the invited email REGISTERED and auto-joined via the
   * pending-invite lane (R15-D10) — the OWNER hears it too (the joiner gets
   * the plain member.added row; this one is the owner's mirror).
   */
  memberJoined: 'member.joined',
  /**
   * T-026 (R10 EB-F07): a member's role changed (promotion or demotion) —
   * the affected user learns it from their inbox instead of a surprise 403
   * on their next action.
   */
  memberRoleChanged: 'member.role_changed',
  /** T-026 (R10 EB-F07): a member was removed from an environment. */
  memberRemoved: 'member.removed',
  /**
   * T-108: an anonymous replay share was minted on the (public)
   * environment — the owner must be able to discover links to their
   * world's history and revoke them.
   */
  shareCreated: 'share.created',
  /**
   * T-072 (DevLoop R23, D-1 decide half): the env owner delegated zone-claim
   * decision rights to this member (or refreshed the delegated zone scope) —
   * the delegate learns they can now decide escalated zone-claim proposals.
   */
  governanceDelegationGranted: 'governance.delegation-granted',
  /**
   * T-072: the delegation was revoked — by the owner, or because the
   * delegate left/was removed from the environment (lifecycle honesty: an
   * active delegation always names a current member).
   */
  governanceDelegationRevoked: 'governance.delegation-revoked',
  /**
   * Phase 3 (cognitive architecture §7.5 — escalation is an honest ask for
   * help): an agent escalated to the env owner. Today's producer is the NL
   * emergency lane (POST /api/agents/:id/command with life-safety text —
   * immediate escalation, decisions bypassed, no device actions).
   */
  agentEscalated: 'agent.escalated',
  /**
   * FEAT-05 (deterministic notify lane): a flow NOTIFY node delivered its
   * message ({to: 'agent'|'role'|'owner', target?, message}) through this
   * pipeline — the "通知到人" deterministic-lane carrier (previously
   * approximated by speaker play-alert).
   */
  flowNotification: 'flow.notification',
} as const;

export interface NotifyInput {
  recipientId: string;
  /** Who caused the event; the recipient never gets their own echo. */
  actorId: string;
  envId: string;
  kind: string;
  title: string;
  body?: Record<string, unknown>;
  refId?: string | null;
  /** Repeatable events: skip while an unread twin exists. */
  dedupeUnread?: boolean;
  /**
   * Fix-18 (R7 F-16): deliver even when recipient === actor. Proposal
   * VERDICTS (applied/rejected) need this — on auto-decided paths (AI allow,
   * zone-claim autonomy, review-timeout auto-approve) the pipeline records
   * the submit call's actor (the author), but the decision was the
   * platform's, and the author must hear it.
   */
  allowSelf?: boolean;
}

/**
 * T39→T59: the per-item OBJECT summary an applied-class digest carries
 * ("装了什么 / 改了哪个 agent 的什么"), derived from the proposal payload.
 * Undefined when the payload shape is not summarizable — the item still
 * carries proposalId + kind (honest absence, never a fabricated label).
 * (The T39 wall-clock bucket coalescer was superseded in T59 by the store's
 * env-level aggregation — see NotificationStore.ENV_AGGREGATED_KINDS.)
 */
export function proposalObjectSummary(
  kind: string,
  payload: Record<string, unknown>,
): string | undefined {
  const namesOf = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const names = value
      .map(row => {
        if (typeof row === 'string') return row;
        if (typeof row === 'object' && row !== null) {
          const record = row as Record<string, unknown>;
          for (const key of ['name', 'type', 'id']) {
            if (typeof record[key] === 'string') return record[key] as string;
          }
        }
        return undefined;
      })
      .filter((name): name is string => typeof name === 'string');
    return names;
  };
  const label = (what: string, names: string[] | undefined): string | undefined => {
    if (names === undefined || names.length === 0) return undefined;
    return `${what} ${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`;
  };
  switch (kind) {
    case 'install-devices':
      return label('安装设备', namesOf(payload.devices));
    case 'remove-devices':
      return label('移除设备', namesOf(payload.deviceIds ?? payload.ids));
    case 'install-agents':
      return label('安装 Agent', namesOf(payload.agents));
    case 'remove-agents':
      return label('移除 Agent', namesOf(payload.agentIds ?? payload.ids));
    case 'install-zones':
      return label('新增分区', namesOf(payload.zones));
    case 'modify-object': {
      const targetId = typeof payload.targetId === 'string' ? payload.targetId : undefined;
      if (targetId === undefined) return undefined;
      const patchKeys = typeof payload.patch === 'object' && payload.patch !== null
        ? Object.keys(payload.patch as Record<string, unknown>).slice(0, 3).join('/')
        : undefined;
      return `修改 ${targetId}${patchKeys !== undefined ? `（${patchKeys}）` : ''}`;
    }
    default:
      return undefined;
  }
}

/** Emit one notification, or null when a noise-control rule dropped it. */
export function notify(store: NotificationStore, input: NotifyInput): NotificationRow | null {
  if (input.recipientId === input.actorId && input.allowSelf !== true) return null;
  if (
    input.dedupeUnread === true &&
    input.refId != null &&
    store.hasUnread(input.recipientId, input.kind, input.refId)
  ) {
    return null;
  }
  return store.create({
    userId: input.recipientId,
    envId: input.envId,
    kind: input.kind,
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.refId !== undefined ? { refId: input.refId } : {}),
  });
}
