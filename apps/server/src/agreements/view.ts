/**
 * Agreements service layer — visibility + API serialization (R21-W1
 * extraction from routes/agreements.ts, pure move).
 */

import type { AgreementRoutesContext } from './context.js';
import { aggregateBackingView, resolveBackingDevice } from './backing.js';
import { effectiveTermsOf } from './terms.js';
import {
  parseTerms,
  terminatedAgreementOutcome,
  type AgreementRow,
  type UsageRecordRow,
} from '../db/agreement-store.js';
import {
  declaredOfferDriftOf,
  type ServiceInstanceRow,
} from '../db/service-store.js';
import { parseJsonArray } from '../db/environment-store.js';
import { deviceExecutableCommandNames } from '@active-collaboration/simulation';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { ownerRef, type OwnerRef } from '../env-serializers.js';
import { HIDDEN_SERVICE_PLACEHOLDER } from '../activity-feed.js';
import { ApiError } from '../errors.js';

/**
 * Load an agreement for any party-scoped operation: 404 when unknown or when
 * the caller is neither consumer, provider, nor the env owner — outsiders
 * must not learn that an agreement exists.
 *
 * D3 (T-080): the fetch boundary ALSO settles an expired consumer hold
 * (lazy evaluation — the standing-asks pattern: the status flips back to
 * 'active' on the first read past the deadline, so no lane ever answers
 * with a stale 'held').
 */
export function getVisibleAgreementOrThrow(
  ctx: AgreementRoutesContext,
  id: string,
  userId: string,
): AgreementRow {
  const agreement = ctx.agreementStore.getAgreement(id);
  const env = agreement ? ctx.envStore.getEnvironment(agreement.env_id) : undefined;
  if (
    !agreement || !env ||
    (agreement.consumer_owner_id !== userId &&
      agreement.provider_owner_id !== userId &&
      env.owner_id !== userId)
  ) {
    throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
  }
  return ctx.agreementStore.settleExpiredHold(agreement);
}

/**
 * T6 (R2 u4-F2) + T30 (R3 u2-F-02): the READ lane for get/usage/receipts —
 * the list's visibility, honored end to end. `agreement list --include
 * terminated` shows members every terminated row (R5-F06: completed
 * collaborations are world history) and strangers on a public environment
 * the restricted view (R5-F08) — and since T30, members read NON-PARTY
 * terminated rows as the SAME restricted view on BOTH faces (the list used
 * to serialize them full, bypassing this lane's anonymization: "detail 藏
 * 掉的 owner 身份与条款，list 全给了"). Mutations (decide/counter/suspend/
 * terminate/invoke/reads/stream) stay on getVisibleAgreementOrThrow:
 * party/env-owner only, unchanged. Lifecycle state machine untouched — this
 * is a read-side lane only.
 *
 * - parties + env owner → full view (identical to before);
 * - env member × terminated (non-party) → restricted view — get AND list;
 * - public environment × terminated → restricted view for ANY reader
 *   (authenticated or anonymous — byte-aligned with the list's R5-F08
 *   stranger lane, which is where they got the id);
 * - everything else (member × active, stranger × active/private, unknown
 *   ids) → 404 exactly like before (existence protection for live rows).
 */
export interface AgreementReadView {
  agreement: AgreementRow;
  /** true = serialize via terminatedAgreementRestrictedJson (+ view markers). */
  restricted: boolean;
}

export function getAgreementReadView(
  ctx: AgreementRoutesContext,
  id: string,
  userId: string | undefined,
): AgreementReadView {
  const agreement = ctx.agreementStore.getAgreement(id);
  const env = agreement ? ctx.envStore.getEnvironment(agreement.env_id) : undefined;
  if (!agreement || !env) {
    throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
  }
  if (
    userId !== undefined &&
    (agreement.consumer_owner_id === userId ||
      agreement.provider_owner_id === userId ||
      env.owner_id === userId)
  ) {
    return { agreement: ctx.agreementStore.settleExpiredHold(agreement), restricted: false };
  }
  if (agreement.status === 'terminated') {
    const isMember = userId !== undefined && ctx.envStore.roleOf(env.id, userId) !== undefined;
    if (isMember || env.visibility === 'public') {
      return { agreement, restricted: true };
    }
  }
  throw new ApiError(404, 'AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`);
}

export function ownerRefFor(ctx: { userStore: Pick<UserStore, 'findById'> }, userId: string): OwnerRef {
  const user = ctx.userStore.findById(userId);
  return ownerRef(user ? toPublicUser(user) : undefined, userId);
}

export function agreementToJson(
  ctx: AgreementRoutesContext,
  row: AgreementRow,
  knownService?: ServiceInstanceRow,
) {
  // v60 (R6-E-F08): retired rows carry null service/agent refs — the JSON
  // keeps the nulls (older readers ignore nothing; the contract is honest).
  const service =
    knownService ?? (row.service_id !== null ? ctx.serviceStore.getService(row.service_id) : undefined);
  const providerAgent =
    row.provider_agent_id !== null ? ctx.envStore.getAgent(row.provider_agent_id) : undefined;
  const consumerAgent =
    row.consumer_agent_id !== null ? ctx.envStore.getAgent(row.consumer_agent_id) : undefined;
  // Fix-20 (multi-backing-device disambiguation): expose WHICH device backs
  // the service so stream/invoke consumers know where the data comes from.
  // Unbacked offers resolve to null instead of failing the read.
  //
  // T8 (R2 u2-F2): aggregate offers judge backing through the RULE lane —
  // the SAME judgment as the signing gates (assertAggregateDeliverable) and
  // the invoke lane (resolveBackingDeviceForServiceAction). The legacy
  // literal capability match below can never hit an aggregate's semantic
  // type ("校园空气环境保障" appears verbatim in no device capability list),
  // so every backed aggregate used to render the false "unbacked offer —
  // invokes refuse SERVICE_NOT_BACKED" warning while propose had passed the
  // real gate. `ruleBacking` is undefined for non-aggregate rows, null for
  // a genuinely unbacked aggregate, and the rule view when backed.
  let ruleBacking: ReturnType<typeof aggregateBackingView> | undefined;
  if (service !== undefined && service.origin === 'aggregate') {
    ruleBacking = aggregateBackingView(ctx, service);
  }
  let backingDeviceId: string | null = null;
  if (ruleBacking === undefined) {
    try {
      backingDeviceId = resolveBackingDevice(ctx, row);
    } catch {
      backingDeviceId = null;
    }
  }
  // R98 (simtest-r1 zhao-06): the callable ACTION surface, visible at signing
  // time (propose/counter/accept responses + the detail view) — the backing
  // device's REAL executable commands via the ONE shared oracle
  // (deviceExecutableCommandNames, the same contract the device-detail
  // `commands` field and the invoke gate use). A consumer sees BEFORE the
  // first invoke that the service's semantic type is not itself a command
  // name. null when the offer has no resolvable backing device.
  // T8: aggregates take the rule lane's action face — the exact set the
  // invoke lane resolves per action (union of executable commands across the
  // rule-backed devices under the offer's actuation capabilities).
  let callableActions: string[] | null = null;
  if (ruleBacking !== undefined) {
    callableActions = ruleBacking?.callableActions ?? null;
  } else if (backingDeviceId !== null) {
    const backing = ctx.envStore.getDevice(backingDeviceId);
    if (backing !== undefined) {
      callableActions = deviceExecutableCommandNames(
        parseJsonArray<string>(backing.capabilities_json),
        backing.type,
        backing.binding,
      );
    }
  }
  // T-059 (§5.2): the countered terms display beside the untouched original
  // (both sides see the two versions); effectiveTerms is ALWAYS what would
  // take effect — consumers never re-derive it from status themselves.
  const counteredTerms = row.countered_terms_json !== null
    ? parseTerms(row.countered_terms_json)
    : null;
  const effectiveTerms = effectiveTermsOf(row);
  // T-505 (CB24-F02): a pending autoReset arm, when one exists — what will
  // fire, when (sim-time deadline on the armed runtime's clock), and the
  // event that armed it. Absent field = nothing armed (the arm is runtime
  // state and vanishes with the sim — an honest reflection, not a gap).
  const armedReset = ctx.armedResetView?.(row.id);
  return {
    id: row.id,
    envId: row.env_id,
    serviceId: row.service_id,
    service: service
      ? { id: service.id, name: service.name, semanticType: service.semantic_type }
      : null,
    backingDeviceId,
    // R98: the backing device's real executable commands (null = unbacked).
    callableActions,
    // T8 (R2 u2-F2): aggregate offers carry the RULE-lane backing view (the
    // same judgment as the signing gates + invoke lane) so a backed
    // aggregate never renders the false "unbacked offer" warning again.
    // Absent on non-aggregate rows; null on a genuinely unbacked aggregate
    // (the 409 SERVICE_NOT_BACKED class at sign/invoke time).
    ...(ruleBacking !== undefined ? { backing: ruleBacking } : {}),
    // T28 (R3 u3-F1): DECLARATION drift on the contracted service — the
    // provider agent's declared capabilities do not cover the service's
    // semantic capability (the device still executes; the flow side already
    // warns "succeeding on borrowed authority"). Honest annotation, never a
    // refusal — the lifecycle state machine is untouched. Absent when the
    // declaration covers the capability (re-declare → the marker disappears).
    // BUG-08 ②: the note is TIMELESS ("does not declare", the flow side's
    // T36 wording) — the drifted-from-birth case never declared the
    // capability, so "no longer declares" asserted a withdrawal that never
    // happened.
    ...(service !== undefined && declaredOfferDriftOf(ctx.envStore, service)
      ? {
          declaredByProvider: false as const,
          declarationDrift: {
            capability: service.semantic_type,
            note:
              `provider agent does not declare '${service.semantic_type}' — bound devices still ` +
              'execute it, so the agreement stays invocable; the declaration/governance face has ' +
              'drifted until the capability is re-declared',
          },
        }
      : {}),
    consumerAgentId: row.consumer_agent_id,
    consumerAgentName: consumerAgent?.name ?? null,
    consumer: ownerRefFor(ctx, row.consumer_owner_id),
    providerAgentId: row.provider_agent_id,
    providerAgentName: providerAgent?.name ?? null,
    provider: ownerRefFor(ctx, row.provider_owner_id),
    terms: parseTerms(row.terms_json),
    counteredTerms,
    effectiveTerms,
    // T-052 + R14 + T-059: true when a BINDING structured clause exists in
    // the EFFECTIVE terms — terms.action.command constrains invokes
    // (T-205), terms.read scopes data reads (fields/quota/freshness).
    // Legacy prose-only agreements are UNRESTRICTED — surfaced so
    // providers/consumers see the hole.
    termsEnforced:
      effectiveTerms.action?.command !== undefined ||
      effectiveTerms.read !== undefined,
    status: row.status,
    // v60 (R6-E-F08): WHY a platform event moved the row (only
    // 'provider-unavailable' today — the provider-agent-removed retire);
    // absent on party-driven transitions. Incremental field — older readers
    // ignore it.
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    // T57 (R6, u2-F-2-5): the v59 activation stamp on the read face — WHEN
    // the agreement first went active (never-active rows carry null). The
    // terminated outcome's "ended-without-delivery vs cancelled" judgment
    // keys on this instant; parties could not see it until now.
    activatedAt: row.activated_at,
    // R99 (simtest-r1 wang-07): a terminated agreement is a VISIBLE terminal
    // state for its parties, never a vanished one — the JSON states WHEN it
    // ended and the shared outcome 口径 (terminatedAgreementOutcome: metered
    // outcome wins; AC without usage = cancelled; never-active explicit =
    // cancelled; was-active-then-terminated = completed).
    ...(row.status === 'terminated'
      ? {
          terminatedAt: row.updated_at,
          outcome: terminatedAgreementOutcome(
            row,
            ctx.agreementStore.usageOf(row.id).at(-1)?.outcome,
          ),
        }
      : {}),
    source: row.source,
    collaborationId: row.collaboration_id,
    // D3 (T-080): the hold's wall-clock deadline (provider-visible pause
    // bound; absent when not held). Lazy expiry settles before this renders.
    ...(row.hold_expires_at !== null ? { holdExpiresAt: row.hold_expires_at } : {}),
    ...(armedReset !== undefined ? { armedReset } : {}),
    // T9 (R2 u2-F5/u4-F7): the remind trace — reminders are NOT lifecycle
    // transitions (updated_at is untouched), so the trace rides its own
    // fields; absent = never reminded (honest empty, not a zero).
    ...(row.last_reminded_at !== null
      ? { lastRemindedAt: row.last_reminded_at, remindCount: row.remind_count }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * R5-F08: the RESTRICTED public view of a TERMINATED agreement — served to
 * strangers (anonymous / non-member readers of a PUBLIC environment) and,
 * since T30, to non-party env members on the list lane. Same anonymization
 * 口径 as the arrival digest's completedCollaborations: participants are
 * named as AGENTS only (never owner identities), the outcome rides the
 * shared terminatedAgreementOutcome 口径 (latest usage outcome when metered;
 * 'cancelled' for a collaboration closed before execution — AC without a
 * usage row, or an explicit agreement that never reached 'active'
 * (R5-F09); T34: 'ended-without-delivery' for an explicit agreement that
 * WAS active but metered nothing), and hidden services keep the T-308
 * placeholder. Active agreements NEVER take this lane — they stay
 * party/env-owner only.
 */
export function terminatedAgreementRestrictedJson(
  ctx: AgreementRoutesContext,
  row: AgreementRow,
  viewerUserId: string | null,
) {
  const service = row.service_id !== null ? ctx.serviceStore.getService(row.service_id) : undefined;
  const providerAgent =
    row.provider_agent_id !== null ? ctx.envStore.getAgent(row.provider_agent_id) : undefined;
  const consumerAgent =
    row.consumer_agent_id !== null ? ctx.envStore.getAgent(row.consumer_agent_id) : undefined;
  const env = ctx.envStore.getEnvironment(row.env_id);
  const usageOutcome = ctx.agreementStore.usageOf(row.id).at(-1)?.outcome;
  const outcome = terminatedAgreementOutcome(row, usageOutcome);
  // T-308 parity: a hidden service is named only for its provider owner,
  // the agreement's parties, and the env owner (a stranger never qualifies).
  const hideService =
    service !== undefined &&
    service.visibility === 'hidden' &&
    viewerUserId !== env?.owner_id &&
    viewerUserId !== row.provider_owner_id &&
    viewerUserId !== row.consumer_owner_id;
  return {
    id: row.id,
    envId: row.env_id,
    status: row.status,
    source: row.source,
    collaborationId: row.collaboration_id,
    service: hideService
      ? { id: HIDDEN_SERVICE_PLACEHOLDER, name: HIDDEN_SERVICE_PLACEHOLDER }
      : { id: row.service_id, name: service?.name ?? null },
    consumerAgentId: row.consumer_agent_id,
    consumerAgentName: consumerAgent?.name ?? null,
    providerAgentId: row.provider_agent_id,
    providerAgentName: providerAgent?.name ?? null,
    outcome,
    terminatedAt: row.updated_at,
    // Discriminator so clients can tell the restricted stranger view apart
    // from the full party/member agreement JSON in the same list.
    view: 'restricted' as const,
  };
}

export function usageToJson(row: UsageRecordRow) {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    envId: row.env_id,
    consumerAgentId: row.consumer_agent_id,
    providerAgentId: row.provider_agent_id,
    kind: row.kind,
    action: row.action,
    quantity: row.quantity,
    unit: row.unit,
    outcome: row.outcome,
    // C3 (R25-NF4, DevLoop R28): WHY a failure failed — the trigger lane's
    // consumer previously had to reproduce the command manually to learn it.
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    // v58: the metered service's origin (derived/published/flow/aggregate) —
    // the origin funnel reads the ledger directly now. Absent on pre-v58 rows.
    ...(row.origin !== null ? { origin: row.origin } : {}),
    // FEAT-08 (v66): WHICH simulation metered the row — the world session
    // and a private sim fulfilling the same agreement are distinguishable.
    // Absent on pre-v66 rows and lanes without sim attribution.
    ...(row.simulation_id !== null ? { simulationId: row.simulation_id } : {}),
    // UX-04 (v67): the invoke lane's entry kind (manual/autoTrigger/
    // autoReset); absent on pre-v67 rows and ac/stream/read rows.
    ...(row.source !== null ? { source: row.source } : {}),
    effectRef: row.effect_ref,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
