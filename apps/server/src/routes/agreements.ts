/**
 * Agreement routes — the service consumption chain (Fix-11,
 * service-consumption-design.md §3–§4, Phase 1)
 *
 * R21-W1: this file is the HTTP SHAPE ONLY. Terms resolution/validation,
 * sim targeting, read delivery, stream invocation, backing-device
 * resolution and serialization live in the service layer
 * (`apps/server/src/agreements/` — terms/targeting/backing/view/
 * read-delivery/invoke-lane/stream-invocation), following the
 * proposal-service house pattern. The HTTP-level suites are the contract
 * and pass UNCHANGED across the extraction.
 *
 * - `POST /api/services/:id/agreements`   consumer proposes an agreement on a
 *     visible service offer. Governance note: an agreement is a BILATERAL
 *     contract, not a world-structure change — it does NOT go through the
 *     proposal pipeline, in any environment (builders included).
 * - `GET  /api/agreements?envId=&role=&status=&include=`   agreements the caller is a
 *     party to (consumer / provider owner) plus, for the env owner, all of
 *     the env's agreements. `envId` is required; `role` narrows the
 *     perspective, `status` filters the lifecycle state. R5-F06:
 *     `include=terminated` opens the env's TERMINATED agreements to env
 *     members (completed collaborations as world history) — T30 (R3): as
 *     the RESTRICTED view for non-party members, the SAME shape `agreement
 *     get` answers that reader (the list used to bypass the anonymization);
 *     the default view is unchanged. R5-F08: on a PUBLIC environment the
 *     same `include=terminated` lane is open to strangers (anonymous /
 *     non-member readers) as a RESTRICTED view — participants as agents,
 *     service name, outcome, time; no owner identities, hidden services
 *     keep the T-308 placeholder. Active agreements stay member-only.
 * - `GET  /api/agreements/:id`   one agreement by id (Wave-1a, 陈工 R8) —
 *     same visibility as the list (both parties + env owner); invisible
 *     agreements answer 404 exactly like unknown ids.
 * - `POST /api/agreements/:id/decide`     provider owner accepts (→ active)
 *     or rejects (→ rejected) a proposed agreement. T-059 (R14): when the
 *     agreement is `countered`, the CONSUMER decides instead (accept = the
 *     countered terms become the contract).
 * - `POST /api/agreements/:id/counter`    provider owner counters a proposal
 *     with full new terms (T-059, design-consent-semantics.md §5) — depth 1,
 *     the decide right passes to the consumer.
 * - `POST /api/agreements/:id/suspend`    provider owner suspends an active
 *     agreement.
 * - `POST /api/agreements/:id/terminate`  either party terminates (from
 *     proposed, active or suspended).
 * - `POST /api/agreements/:id/invocations`  invoke consumption (§3.2.1):
 *     consumer only, active agreements only. The action is routed to the
 *     provider agent, which commands ITS OWN backing device inside the env's
 *     RUNNING simulation (device-privacy principle intact — no direct device
 *     channel). No running simulation → 409 SIMULATION_NOT_RUNNING. Every
 *     invoke appends a UsageRecord (kind=invoke, quantity=1, unit=action)
 *     and settles the batch through the SettlementProvider (§3.4; Null by
 *     default → archived receipt). Quota terms (Fix-20, §6 Phase 2): when
 *     `quotaPerWindow`+`windowSec` are both set, an invoke beyond the
 *     window budget answers 429 QUOTA_EXCEEDED before executing; the window
 *     is sliding by default, or tumbling from the agreement's activation
 *     with `windowKind: 'fixed'` (Wave-6).
 * - `GET  /api/agreements/:id/usage`      append-only metering evidence,
 *     readable by both parties and the env owner (§3.3).
 * - `GET  /api/agreements/:id/receipts`   settlement receipts (§3.4), same
 *     visibility as usage.
 * - `GET  /api/agreements/:id/stream`     stream consumption (§3.2.2,
 *     Phase 2): WebSocket pushing the backing device's observation changes
 *     (DEVICE_STATE_CHANGE on the bus, filtered by agreement). Requires an
 *     active agreement AND a running simulation — otherwise the upgrade is
 *     rejected with 409 AGREEMENT_NOT_ACTIVE / SIMULATION_NOT_RUNNING.
 *     `?params=a,b` (Fix-20) narrows the push to frames where one of the
 *     listed parameters changed; the agreement payload carries
 *     `backingDeviceId` so consumers know which device the data comes from.
 *     Metered as ONE UsageRecord per session (kind='stream', quantity =
 *     pushed message count, unit='message') appended when the socket closes.
 *     A ping/pong heartbeat (AGREEMENT_STREAM_HEARTBEAT_MS, Fix-15 F-21)
 *     terminates dead peers — a killed client that never sent a close frame
 *     is still metered. When the hosting simulation stops, the server closes
 *     the session itself (close frame 1001 via AgreementStreamSessions,
 *     Wave-6) so the stream is metered at stop time instead of heartbeating
 *     on until the client disconnects.
 *
 * Phase 2 (§5) reputation hook: a FAILED invoke scores the provider agent's
 * reputation for the service's semantic type (successes stay with Fix-12's
 * effect recheck — no double accounting). AC-handshake consumption lands
 * ephemeral agreements (source='ac') via ac-agreement-bridge.ts.
 *
 * Visibility: only the two parties and the env owner ever see an agreement —
 * to everyone else it answers 404 exactly like an unknown id.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';

import {
  agreementToJson,
  assertBackingUnambiguous,
  assertDeliverableAtSigning,
  assertFlowServiceTerms,
  assertReadClauseWithinSchema,
  backingDeviceDriftOf,
  consumptionQuotaStatus,
  deliverRead,
  effectiveTermsOf,
  executeAgreementInvocation,
  getAgreementReadView,
  getProposableServiceOrThrow,
  getVisibleAgreementOrThrow,
  parseStreamParamFilter,
  parseTermsBody,
  resolveBackingDevice,
  CONSUMPTION_TARGET_RETRY_AFTER_SEC,
  CONSUMPTION_TARGET_WAIT_LIMIT_MS,
  raceConsumptionTargeting,
  resolveConsumptionTargetSimForLane,
  runAgreementStreamSession,
  assessProviderDeliverability,
  summarizeTerms,
  terminatedAgreementRestrictedJson,
  termsDiff,
  usageToJson,
  withContentions,
  contentionSummaryOfEnv,
  type AgreementRoutesContext,
} from '../agreements/index.js';
import {
  AGREEMENT_STATUSES,
  AgreementStore,
  parseTerms,
  terminatedAgreementOutcome,
  type AgreementRow,
  type AgreementStatus,
} from '../db/agreement-store.js';
import { unbackedFlagsForEnv } from '../db/service-store.js';
import { ApiError, errorBody } from '../errors.js';
import { t } from '../i18n/index.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';

interface ServiceParams {
  id: string;
}

interface AgreementParams {
  id: string;
}

/**
 * R99 (simtest-r1 wang-07): an operation refused because the agreement is
 * not active must say the TERMINATION FACT for terminated rows — when it
 * ended and with what outcome (the shared terminatedAgreementOutcome 口径)
 * — never a bare status word that reads like "not found".
 */
function notActiveTeaching(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  tail: string,
): string {
  if (agreement.status === 'terminated') {
    const outcome = terminatedAgreementOutcome(
      agreement,
      ctx.agreementStore.usageOf(agreement.id).at(-1)?.outcome,
    );
    return `Agreement "${agreement.id}" was terminated at ${agreement.updated_at} (outcome: ${outcome}) — ${tail}`;
  }
  return `Agreement "${agreement.id}" is ${agreement.status} — ${tail}`;
}

/** R102: max length of a party-provided decision reason. */
const DECISION_REASON_MAX_LENGTH = 500;

/**
 * R102: the optional free-text reason a party attaches to reject/suspend/
 * terminate. Trimmed, length-capped; undefined when absent (the column
 * keeps its v60 semantics — party acts without a reason stay NULL, and the
 * display layers render "未记录原因" instead of a blank).
 */
function parseDecisionReason(body: Record<string, unknown>): string | undefined {
  if (body.reason === undefined || body.reason === null) return undefined;
  if (typeof body.reason !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "reason" must be a string when provided');
  }
  const reason = body.reason.trim();
  if (reason.length === 0) return undefined;
  if (reason.length > DECISION_REASON_MAX_LENGTH) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "reason" is capped at ${DECISION_REASON_MAX_LENGTH} characters`,
    );
  }
  return reason;
}

/** T-309: reminder rate limit — one nudge per 10 minutes at most. */
const REMIND_WINDOW_MS = 10 * 60 * 1000;

export function registerAgreementRoutes(app: FastifyInstance, ctx: AgreementRoutesContext): void {

  // -------------------------------------------------------------------------
  // Propose (consumer)
  // -------------------------------------------------------------------------

  app.post('/api/services/:id/agreements', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getProposableServiceOrThrow(ctx, id, user.id);
    const env = ctx.envStore.getEnvironment(service.env_id)!;
    const providerAgent = ctx.envStore.getAgent(service.provider_agent_id)!;
    // T-306 (EN-F07): earliest teaching point — refuse to contract on an
    // ambiguously-backed published service instead of letting invoke/stream
    // silently first-match an arbitrary device later.
    assertBackingUnambiguous(ctx, service);
    // T-310 (EN-F11/FR-F04): an agreement on an UNBACKED service is a
    // contract that can never deliver — invoke/stream already 409
    // SERVICE_NOT_BACKED. Refuse at the boundary with the bookmark remedy;
    // subscription stays the legitimate way to follow such an offer.
    // R14 Wave-A (design-data-services.md §8): a registered ComputationSpec
    // flips the service consumable — the data lanes (reads/stream data
    // frames) deliver, so the propose gate opens. Unbacked WITHOUT a
    // computation keeps the full T-310 boundary; existing proposed-unbacked
    // rows keep their read paths (no data migration).
    const unbacked = (unbackedFlagsForEnv(ctx.envStore, [service]).get(service.id) ?? true) === true;
    const hasComputation = ctx.serviceStore.computationOf(service.id) !== undefined;
    // T31 (R3 u2-F-04): AGGREGATE offers are excluded here — since the
    // unbacked flag now runs the same rule-lane judgment as the signing
    // gates, an unbacked aggregate must answer with the gate's own teaching
    // (assertAggregateDeliverable below: missing rule vs missing actuation
    // capabilities + the bound-device remedy), not this generic
    // subscribe/computation note.
    if (unbacked && !hasComputation && service.origin !== 'aggregate') {
      throw new ApiError(
        409,
        'SERVICE_NOT_BACKED',
        `Service "${service.name}" has no backing device — nothing can be delivered ` +
          // T-063(b): the bookmark route is PUT (a POST here answers 405) —
          // the stale "POST" prose sent consumers to a 405.
          'through invoke/stream yet; subscribe to follow it (PUT /api/services/:id/subscribe ' +
          'stays the bookmark), or wait for the provider to register a computation ' +
          '(POST /api/services/:id/computation) that makes it a readable data service',
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const terms = parseTermsBody(body.terms);

    // Mechanism D: on a flow-service the structured action clause is the
    // contract's delivery shape — command MUST be 'run' and any constrained
    // params must satisfy the flow's inputs surface (the earliest-boundary
    // lesson: a runtime 422 the consumer cannot act on is worse than a
    // propose-time teaching error). The SAME gate runs on counter-offers.
    assertFlowServiceTerms(ctx, service, terms);

    // R14 Wave-A (§8): on a computation-backed data service, terms.read.fields
    // is a dataSchema subset — validated at the EARLIEST boundary (T-306
    // lesson: a runtime 409 the consumer cannot act on is worse than a
    // propose-time 400 naming the fields). A read clause on a service WITHOUT
    // a computation is equally refused (nothing readable to scope).
    // T-059: the SAME validation runs on counter-offers (identical closed
    // schema — extracted so the two boundaries cannot drift).
    const computation = ctx.serviceStore.computationOf(service.id);
    assertReadClauseWithinSchema(service, computation, terms);

    // R6-B-F01 / R6-C-F02 (T-310 earliest boundary): deliverability is
    // checked at SIGNING, not first invoke - an aggregate offer with an
    // empty executable backing 409s here (SERVICE_NOT_BACKED), and a
    // terms.targetZoneId the provider can never physically reach 422s
    // (SERVICE_ZONE_UNREACHABLE). Runtime drift after signing stays with
    // the invoke-lane gates.
    assertDeliverableAtSigning(ctx, service, terms);

    let consumerAgentId: string | null = null;
    if (body.consumerAgentId !== undefined) {
      if (typeof body.consumerAgentId !== 'string' || body.consumerAgentId.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "consumerAgentId" must be a non-empty string');
      }
      const agent = ctx.envStore.getAgent(body.consumerAgentId);
      if (!agent || agent.env_id !== env.id) {
        throw new ApiError(
          404,
          'AGENT_NOT_FOUND',
          `Agent "${body.consumerAgentId}" does not exist in environment "${env.id}"`,
        );
      }
      if (agent.owner_id !== user.id) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'The consumer agent of an agreement must be an agent you own',
        );
      }
      consumerAgentId = agent.id;
    }

    const row = ctx.agreementStore.createAgreement({
      envId: env.id,
      serviceId: service.id,
      consumerAgentId,
      consumerOwnerId: user.id,
      providerAgentId: providerAgent.id,
      providerOwnerId: providerAgent.owner_id,
      terms,
    });
    // Fix-16: ping the provider's owner (有待 accept) + announce on the env stream.
    // Wave-1a (陈工 R8): the body names WHO is ringing (consumerName) and
    // digests the terms, so the provider can triage without a second query.
    // Incremental fields only — older readers ignore them.
    notify(ctx.notificationStore, {
      recipientId: row.provider_owner_id,
      actorId: user.id,
      envId: env.id,
      kind: NOTIFICATION_KINDS.agreementProposed,
      title: t(request.locale, 'chrome.notif.agreementProposed'),
      body: {
        agreementId: row.id,
        serviceId: service.id,
        serviceName: service.name,
        status: 'proposed',
        consumerName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
        termsSummary: summarizeTerms(terms, request.locale),
        // T-059 (§5.3): machine-readable reply affordance — the notification
        // names WHERE the decision goes; it is an action hint, not a message
        // channel.
        replyHint: {
          endpoint: `POST /api/agreements/${row.id}/decide`,
          allowedDecisions: ['accept', 'reject'],
          yourMove: true,
        },
      },
      refId: row.id,
    });
    ctx.pipeline.publishAgreement(env.id, 'proposed', row.id, user.id);
    // T-025: the agreement lifecycle is the governance surface most likely
    // to be disputed — every transition lands a command_log row (actor =
    // who acted, from/to = the state change; terms only on propose/counter
    // where new terms enter the world).
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: {
        agreementId: row.id,
        serviceId: service.id,
        from: null,
        to: 'proposed',
        terms: JSON.parse(row.terms_json) as unknown,
      },
    });
    // §8 存量兼容：在数据服务上 propose 而不带 read 条款——建议而非强制
    // （warning 提示，200/201 体携带；read 条款是消费方划定 fields/quota/
    // freshness 边界的唯一途径）。
    const warnings: string[] = [];
    if (computation !== undefined && terms.read === undefined) {
      warnings.push(
        'this is a data service (a registered computation backs it) but the terms carry no read clause — ' +
          'consider terms.read { fields, quotaPerWindow, windowSec, minFreshnessSec } to scope fields, ' +
          'budget reads and bound freshness; without it reads are unrestricted',
      );
    }
    return reply.code(201).send({
      ...agreementToJson(ctx, row, service),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });

  // -------------------------------------------------------------------------
  // List (parties + env owner)
  // -------------------------------------------------------------------------

  app.get('/api/agreements', { preHandler: app.optionalAuth }, async request => {
    // optionalAuth leaves request.user NULL (not undefined) when no
    // credential is presented — normalize so the stranger lanes below can
    // rely on `undefined`.
    const user = request.user ?? undefined;
    const query = request.query as Record<string, unknown>;
    const envId = requireQueryString(query.envId, 'envId');
    const role = optionalQueryString(query.role, 'role');
    const status = optionalQueryString(query.status, 'status');
    const include = optionalQueryString(query.include, 'include');
    if (role !== undefined && role !== 'consumer' && role !== 'provider') {
      throw new ApiError(400, 'BAD_REQUEST', 'Query "role" must be "consumer" | "provider"');
    }
    if (status !== undefined && !AGREEMENT_STATUSES.includes(status as AgreementStatus)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Query "status" must be one of ${AGREEMENT_STATUSES.map(s => `"${s}"`).join(' | ')}`,
      );
    }
    // R5-F06: ?include=terminated opens the env's TERMINATED agreements to
    // its members (completed collaborations are world history, not a live
    // bilateral transaction) — T30: as the RESTRICTED view for non-party
    // members, field-for-field the same JSON the get route answers them.
    // Default (no param) keeps the strict party/env-owner view byte-identical.
    if (include !== undefined && include !== 'terminated') {
      throw new ApiError(400, 'BAD_REQUEST', 'Query "include" must be "terminated"');
    }

    const env = ctx.envStore.getEnvironment(envId);
    if (!env) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    }
    // R5-F08: anonymous readers are admitted ONLY to a PUBLIC environment's
    // ?include=terminated lane (restricted view below); every other
    // anonymous call keeps the old authenticate behavior (401).
    if (user === undefined && (env.visibility !== 'public' || include !== 'terminated')) {
      throw new ApiError(
        401,
        'UNAUTHORIZED',
        'Authentication required — only ?include=terminated on a public environment is readable anonymously',
      );
    }
    const isMember = user !== undefined && ctx.envStore.roleOf(env.id, user.id) !== undefined;

    const rows = ctx.agreementStore
      .agreementsOfEnv(env.id)
      .map(row => ctx.agreementStore.settleExpiredHold(row)); // D3 lazy expiry

    const fullView = rows
      .filter(row => {
        if (user === undefined) return false;
        const isConsumer = row.consumer_owner_id === user.id;
        const isProvider = row.provider_owner_id === user.id;
        const isEnvOwner = env.owner_id === user.id;
        if (role === 'consumer') return isConsumer;
        if (role === 'provider') return isProvider;
        // T30 (R3 u2-F-02): a non-party MEMBER no longer lands terminated
        // rows in the FULL view — the list used to bypass the get lane's
        // restricted view right here (owner displayName / terms leaked to
        // members on the very rows `agreement get` anonymizes). They read
        // the SAME restricted shape the get answers (restrictedView below).
        return isConsumer || isProvider || isEnvOwner;
      })
      .filter(row => status === undefined || row.status === status);

    // R5-F08 + T30 (PM ruling: 非当事方成员两侧同受限): the RESTRICTED
    // terminated lane — strangers/anonymous readers of a PUBLIC environment
    // (unchanged), PLUS env members on terminated rows they are not a party
    // of (role-less queries only; role-filtered lists keep their
    // party-scoped semantics). Participants as agents, service name,
    // outcome, time — no owner identities, no terms; field-for-field the
    // same JSON the detail route answers for the same reader.
    const fullViewIds = new Set(fullView.map(row => row.id));
    const restrictedView = include === 'terminated' && role === undefined
      ? rows.filter(
          row =>
            row.status === 'terminated' &&
            !fullViewIds.has(row.id) &&
            (status === undefined || row.status === status) &&
            (isMember || env.visibility === 'public'),
        )
      : [];

    // R99 (simtest-r1 wang-07): terminated rows leave the DEFAULT list by
    // design (the ?include=terminated lane), but a platform-auto-terminated
    // agreement (AC ephemeral completion) must still be DISCOVERABLE by its
    // parties — their own newest terminated rows ride every list response
    // as a small section (full party view incl. terminatedAt/outcome).
    const recentlyTerminated = user === undefined
      ? []
      : rows
          .filter(
            row =>
              row.status === 'terminated' &&
              (row.consumer_owner_id === user.id ||
                row.provider_owner_id === user.id ||
                env.owner_id === user.id),
          )
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
          .slice(0, 5)
          .map(row => agreementToJson(ctx, row));

    // UX-16 (pm-dev-backlog, energy-carbon D7): the list used to hide the
    // D1 contention fact the detail GET exposes via withContentions — a
    // contended contract was invisible until opened. One env-wide pass
    // attaches a {count, pairs} summary to each contending FULL-view row
    // (restricted rows stay lean — strangers get no automation topology).
    const contentionSummaries = contentionSummaryOfEnv(ctx, env.id);

    return {
      agreements: [
        ...fullView.map(row => {
          const json = agreementToJson(ctx, row);
          const summary = contentionSummaries.get(row.id);
          return summary !== undefined ? { ...json, contentionSummary: summary } : json;
        }),
        ...restrictedView.map(row => terminatedAgreementRestrictedJson(ctx, row, user?.id ?? null)),
      ],
      recentlyTerminated,
    };
  });

  // -------------------------------------------------------------------------
  // Get one (Wave-1a, 陈工 R8) — the list's visibility, end to end (T6,
  // R2 u4-F2): parties + env owner read the full view; a terminated row is
  // world history, so env members (R5-F06) and — on a public environment —
  // any reader (R5-F08's list lane is where they got the id) read the
  // RESTRICTED view instead of a bare 404. Live rows keep existence
  // protection: member/stranger × non-terminated → 404, unchanged.
  // -------------------------------------------------------------------------

  app.get('/api/agreements/:id', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as AgreementParams;
    // optionalAuth leaves request.user NULL (not undefined) — normalize so
    // the anonymous terminated lane below can rely on `undefined`.
    const user = request.user ?? undefined;
    const view = getAgreementReadView(ctx, id, user?.id);
    if (view.restricted) {
      return terminatedAgreementRestrictedJson(ctx, view.agreement, user?.id ?? null);
    }
    const agreement = view.agreement;
    // C4 (T-086, RT26-F05): the pre-flight drift hint — the backing device
    // absent from sims the consumer may target is visible BEFORE the failed
    // invoke round-trip. Computed from the CONSUMER's perspective (the only
    // party that invokes), whatever party reads the detail.
    const drift = backingDeviceDriftOf(ctx, agreement, agreement.consumer_owner_id);
    // D1 (T-085, R28): the contended device-param warning — other ACTIVE
    // agreements whose trigger automation writes the same (deviceId, param).
    // Detect + warn, never block (last-writer-wins stays; the warning is the
    // remedy). Absent when the agreement contends nothing.
    return withContentions(
      ctx,
      agreement,
      drift === undefined
        ? agreementToJson(ctx, agreement)
        : { ...agreementToJson(ctx, agreement), backingDeviceDrift: drift },
    );
  });

  // -------------------------------------------------------------------------
  // Lifecycle transitions
  // -------------------------------------------------------------------------

  app.post('/api/agreements/:id/decide', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.decision !== 'accept' && body.decision !== 'reject') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "decision" must be "accept" | "reject"');
    }

    // T-059 (design-consent-semantics.md §5.1): the decide right follows the
    // state — proposed → PROVIDER decides (the pre-existing semantics,
    // byte-identical); countered → the CONSUMER decides the provider's
    // counter-offer (accept = the countered terms become the contract).
    if (agreement.status === 'countered') {
      if (agreement.consumer_owner_id !== user.id) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'The ball is in the consumer\'s court — only the consumer may decide a countered agreement; ' +
            'the provider may wait, remind (POST /api/agreements/:id/remind, 10-minute rate limit), or terminate',
        );
      }
      // Accept copies the countered terms INTO the contract (one column for
      // every enforcement path); reject is terminal on the original proposal.
      // R6-B-F01 / R6-C-F02: the counter-ACCEPT re-runs the signing gates on
      // the countered terms against the CURRENT world - the last boundary
      // before the agreement goes active (the world may have drifted since
      // the counter).
      if (body.decision === 'accept' && agreement.service_id !== null) {
        const gatedService = ctx.serviceStore.getService(agreement.service_id);
        if (gatedService !== undefined) {
          assertDeliverableAtSigning(ctx, gatedService, effectiveTermsOf(agreement));
        }
      }
      // T24 (R3): the counter-ACCEPT lands the consumer's optional reason
      // too — the same R102 channel the counter-reject already used (the
      // two decide outcomes of a countered agreement now speak one language).
      const counterReason = parseDecisionReason(body) ?? null;
      const next = body.decision === 'accept'
        ? ctx.agreementStore.acceptCounter(id, counterReason)
        : ctx.agreementStore.setStatus(id, 'rejected', counterReason);
      // Living-worlds P1W: counter-accepts carry the same freshness
      // obligation trigger as direct accepts.
      if (next.status === 'active') {
        void ctx.worldSessions?.noteFreshnessObligation(next.env_id).catch(() => {});
      }
      notify(ctx.notificationStore, {
        recipientId: next.provider_owner_id,
        actorId: user.id,
        envId: next.env_id,
        kind: body.decision === 'accept'
          ? NOTIFICATION_KINDS.agreementAccepted
          : NOTIFICATION_KINDS.agreementRejected,
        title: t(
          request.locale,
          body.decision === 'accept' ? 'chrome.notif.agreementAccepted' : 'chrome.notif.agreementRejected',
        ),
        body: {
          agreementId: next.id,
          serviceId: next.service_id,
          status: next.status,
          decidedWhat: body.decision === 'accept' ? 'counter-offer' : 'counter-offer (rejected)',
          // R102: the party's decision reason reaches the other side.
          // T24: the counter-ACCEPT reason rides it too.
          ...(counterReason !== null ? { reason: counterReason } : {}),
        },
        refId: next.id,
      });
      ctx.pipeline.publishAgreement(next.env_id, body.decision === 'accept' ? 'accepted' : 'rejected', id, user.id);
      // T-025: audit row (consumer deciding the counter-offer).
      ctx.pipeline.log({
        envId: next.env_id,
        actorId: user.id,
        kind: 'agreement-transition',
        payload: {
          agreementId: next.id,
          serviceId: next.service_id,
          from: 'countered',
          to: next.status,
          decision: body.decision,
          decidedWhat: 'counter-offer',
        },
      });
      // C4 (T-086): the counter-ACCEPT response carries the drift hint too
      // (the consumer becomes the invoker the moment their accept lands).
      // D1 (T-085, R28): and the contention warning — the accept is the
      // moment a second automation on the same (deviceId, param) goes live.
      const counterDrift = next.status === 'active'
        ? backingDeviceDriftOf(ctx, next, next.consumer_owner_id)
        : undefined;
      return withContentions(
        ctx,
        next,
        counterDrift === undefined
          ? agreementToJson(ctx, next)
          : { ...agreementToJson(ctx, next), backingDeviceDrift: counterDrift },
      );
    }

    if (agreement.provider_owner_id !== user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the provider (the service\'s provider agent owner) may decide an agreement',
      );
    }
    if (agreement.status !== 'proposed') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_PROPOSED',
        `Agreement "${id}" is ${agreement.status} — only proposed agreements can be decided`,
      );
    }
    // §3.1: the design's `accepted` state is transient — accept lands active.
    // R6-B-F01 / R6-C-F02: same signing gates as propose - the world may
    // have drifted since the proposal; accept is the last boundary before
    // the agreement enters active.
    if (body.decision === 'accept' && agreement.service_id !== null) {
      const gatedService = ctx.serviceStore.getService(agreement.service_id);
      if (gatedService !== undefined) {
        assertDeliverableAtSigning(ctx, gatedService, parseTerms(agreement.terms_json));
      }
    }
    const next = ctx.agreementStore.setStatus(
      id,
      body.decision === 'accept' ? 'active' : 'rejected',
      // R102 (wang-18): the provider's reject may carry a reason — it lands
      // in statusReason, the other side's notification and agreement get.
      // T24 (R3 u1-F1/u2-F-10): ACCEPT carries it too — help promised
      // "--reason writes the decision reason into statusReason" for the
      // accept side as well, but this branch hardcoded null for accepts and
      // the promise read as a bare null on both get faces. One converged
      // lane: every party decide lands the optional reason.
      parseDecisionReason(body) ?? null,
    );
    // Living-worlds P1W (the "first due moment" creation trigger): an
    // accepted data-read agreement with a minFreshnessSec floor installs a
    // standing wall obligation — ensure the authoritative world exists to
    // honor it (fire-and-forget: the decide itself must not fail over it).
    if (next.status === 'active') {
      void ctx.worldSessions?.noteFreshnessObligation(next.env_id).catch(() => {});
    }
    // Fix-16: the consumer learns the verdict without polling.
    // R77-F5 residual (Wave A5): on ACCEPT the notification also carries the
    // explicit "callable now" state — before this, the consumer saw "accepted"
    // but nothing in the inbox said the service may be INVOKED from now on.
    notify(ctx.notificationStore, {
      recipientId: next.consumer_owner_id,
      actorId: user.id,
      envId: next.env_id,
      kind: body.decision === 'accept'
        ? NOTIFICATION_KINDS.agreementAccepted
        : NOTIFICATION_KINDS.agreementRejected,
      title: t(
        request.locale,
        body.decision === 'accept' ? 'chrome.notif.agreementAccepted' : 'chrome.notif.agreementRejected',
      ),
      body: {
        agreementId: next.id,
        serviceId: next.service_id,
        status: next.status,
        // R102: the party's reject reason reaches the consumer's inbox.
        ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
        ...(body.decision === 'accept'
          ? {
              callable: true,
              serviceName: (next.service_id !== null ? ctx.serviceStore.getService(next.service_id)?.name : undefined) ?? next.service_id,
              note: 'the agreement is ACTIVE — you may invoke the service now ' +
                '(POST /api/services/:id/invoke, or POST /api/agreements/:id/invocations for the metered lane)',
            }
          : {}),
      },
      refId: next.id,
    });
    ctx.pipeline.publishAgreement(next.env_id, body.decision === 'accept' ? 'accepted' : 'rejected', id, user.id);
    // T-025: audit row (provider deciding the original proposal).
    ctx.pipeline.log({
      envId: next.env_id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: {
        agreementId: next.id,
        serviceId: next.service_id,
        from: 'proposed',
        to: next.status,
        decision: body.decision,
        ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
      },
    });
    // C4 (T-086, RT26-F05): the ACCEPT response pre-flights the drift the
    // consumer would otherwise learn as a 409 on their first invoke — the
    // backing device may be absent from the long-lived sims they target
    // (a frozen world predating a late install). Consumer perspective: the
    // consumer is the party that invokes.
    // D1 (T-085, R28): the accept response also carries the CONTENTION
    // warning — the accept is exactly the moment a second (third, …)
    // automation targeting the same (deviceId, param) goes live, and the
    // decider should see the race they are entering before it fires.
    const acceptDrift = next.status === 'active'
      ? backingDeviceDriftOf(ctx, next, next.consumer_owner_id)
      : undefined;
    return withContentions(
      ctx,
      next,
      acceptDrift === undefined
        ? agreementToJson(ctx, next)
        : { ...agreementToJson(ctx, next), backingDeviceDrift: acceptDrift },
    );
  });

  // -------------------------------------------------------------------------
  // Counter-offer (T-059, design-consent-semantics.md §5) — the provider's
  // answer to a proposal with FULL new terms. Depth 1: only proposed →
  // countered, once; re-negotiation = terminate + re-propose. The decide
  // right passes to the consumer.
  // -------------------------------------------------------------------------

  app.post('/api/agreements/:id/counter', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.provider_owner_id !== user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the provider (the service\'s provider agent owner) may counter an agreement',
      );
    }
    if (agreement.status !== 'proposed') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_PROPOSED',
        `Agreement "${id}" is ${agreement.status} — counter-offers apply to proposed agreements only ` +
          '(one round: after a counter, the consumer decides; renegotiation means terminate + re-propose)',
      );
    }

    // Same closed-schema validation as propose (§5.1) — the counter is a
    // complete terms object, and it may UNILATERALLY ADD structured clauses:
    // countering a prose-only proposal with terms.action.command / terms.read
    // is the provider's entry into tightening a legacy contract (EN-F14).
    const body = (request.body ?? {}) as Record<string, unknown>;
    const terms = parseTermsBody(body.terms);
    const service = agreement.service_id !== null
      ? ctx.serviceStore.getService(agreement.service_id)
      : undefined;
    if (service) {
      // Mechanism D: the flow-service terms gate runs on counters too —
      // 'run' command + params within the flow's inputs surface.
      assertFlowServiceTerms(ctx, service, terms);
      assertReadClauseWithinSchema(service, ctx.serviceStore.computationOf(service.id), terms);
      // R6-B-F01 / R6-C-F02: a counter may ADD the clauses the gates
      // read (terms.targetZoneId / terms.action) - same boundary.
      assertDeliverableAtSigning(ctx, service, terms);
    }
    // A counter identical to the original carries no information — 400.
    if (JSON.stringify(terms) === agreement.terms_json) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'The counter-offer terms are identical to the proposal — a counter must CHANGE something ' +
          '(adjust quota/price/fields, add a structured clause, or narrow the notes)',
      );
    }

    const next = ctx.agreementStore.counter(id, terms);
    // §5.3: the consumer learns its move from the notification — the summary
    // of the new terms plus a compact diff against the original, and the
    // machine-readable replyHint.
    notify(ctx.notificationStore, {
      recipientId: next.consumer_owner_id,
      actorId: user.id,
      envId: next.env_id,
      kind: NOTIFICATION_KINDS.agreementCountered,
      title: t(request.locale, 'chrome.notif.agreementCountered'),
      body: {
        agreementId: next.id,
        serviceId: next.service_id,
        status: 'countered',
        counteredTermsSummary: summarizeTerms(terms, request.locale),
        termsDiff: termsDiff(parseTerms(agreement.terms_json), terms),
        replyHint: {
          endpoint: `POST /api/agreements/${next.id}/decide`,
          allowedDecisions: ['accept', 'reject'],
          yourMove: true,
        },
      },
      refId: next.id,
    });
    ctx.pipeline.publishAgreement(next.env_id, 'countered', id, user.id);
    // T-025: audit row — the counter's terms are part of the record (they
    // become the contract when the consumer accepts).
    ctx.pipeline.log({
      envId: next.env_id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: {
        agreementId: next.id,
        serviceId: next.service_id,
        from: 'proposed',
        to: 'countered',
        decision: 'counter',
        counteredTerms: terms,
      },
    });
    return agreementToJson(ctx, next);
  });

  // T-309 (DevLoop R12, FR-F07): the demand-side nudge — a consumer whose
  // proposal sits unanswered has exactly one move today: poll. Remind sends
  // ONE `agreement.reminded` notification to the DECIDER (a nudge, not
  // pressure — no state change), rate-limited to ≥10 minutes since the
  // proposal or the last reminder (429 with retry-after semantics).
  //
  // T-059 (§5.4): the channel is SYMMETRIC — the nudge follows the decide
  // right. proposed → the consumer reminds the provider; countered → the
  // PROVIDER reminds the consumer (the counter-offer is on their table).
  app.post('/api/agreements/:id/remind', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    const isCounterTurn = agreement.status === 'countered';
    const expectedRemider = isCounterTurn ? agreement.provider_owner_id : agreement.consumer_owner_id;
    const recipientId = isCounterTurn ? agreement.consumer_owner_id : agreement.provider_owner_id;
    if (user.id !== expectedRemider) {
      const whose = isCounterTurn
        ? 'the counter-offer sits with the CONSUMER — only the provider may remind now'
        : 'the proposal sits with the PROVIDER — only the consumer may remind now';
      throw new ApiError(
        403,
        'FORBIDDEN',
        `Only the waiting side may remind about an agreement (${whose})`,
      );
    }
    if (agreement.status !== 'proposed' && agreement.status !== 'countered') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_PROPOSED',
        `Agreement "${id}" is ${agreement.status} — reminders apply to proposed and countered agreements only`,
      );
    }
    const lastReminder = ctx.notificationStore.latestOfKind(
      recipientId,
      NOTIFICATION_KINDS.agreementReminded,
      agreement.id,
    );
    const anchorMs = lastReminder !== undefined
      ? new Date(lastReminder.created_at).getTime()
      : new Date(agreement.created_at).getTime();
    const elapsedMs = Date.now() - anchorMs;
    if (elapsedMs < REMIND_WINDOW_MS) {
      const retryAfterSec = Math.ceil((REMIND_WINDOW_MS - elapsedMs) / 1000);
      // C6 (T-088, RT26-F06 — DevLoop R28): state the EXACT earliest remind
      // time, not just the delta — a retry-after seconds counter made the
      // first remind after a fresh proposal read like an arbitrary wait;
      // the window anchor (creation or last reminder) is now explicit.
      const anchoredAt = new Date(anchorMs).toISOString();
      const earliestAt = new Date(anchorMs + REMIND_WINDOW_MS).toISOString();
      // R13 (IB-F09): name the anchor the window actually used — a
      // first-ever remind ~3 min after proposing used to read as "already
      // reminded recently", implying a history that does not exist.
      const anchorNote = lastReminder !== undefined
        ? 'a reminder was already sent recently'
        : 'no reminder has been sent yet, but the rate window starts at PROPOSAL CREATION, not at your first remind';
      throw new ApiError(
        429,
        'REMIND_RATE_LIMITED',
        `Agreement "${id}": ${anchorNote} — the earliest you may remind is ${earliestAt} ` +
          `(${anchoredAt} + ${REMIND_WINDOW_MS / 60000} min window; ~${retryAfterSec}s from now)`,
        undefined,
        { retryAfterSec, earliestAt, anchoredAt },
      );
    }
    const delivered = notify(ctx.notificationStore, {
      recipientId,
      actorId: user.id,
      envId: agreement.env_id,
      kind: NOTIFICATION_KINDS.agreementReminded,
      title: t(request.locale, 'chrome.notif.agreementReminded'),
      body: {
        agreementId: agreement.id,
        serviceId: agreement.service_id,
        consumerName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
        ...(isCounterTurn ? { about: 'counter-offer awaiting the consumer\'s decision' } : {}),
        // T-059: the DECIDER's notification names their move.
        replyHint: {
          endpoint: `POST /api/agreements/${agreement.id}/decide`,
          allowedDecisions: ['accept', 'reject'],
          yourMove: true,
        },
      },
      refId: agreement.id,
    });
    // T9 (R2, u2-F5/u4-F7): the remind TRACE on the row — reminders are not
    // lifecycle transitions (updated_at untouched), but they must be
    // observable: get/list now render "已提醒 N 次，最近 <时刻>" from these
    // fields.
    const reminded = ctx.agreementStore.markReminded(agreement.id, new Date().toISOString());

    // T9: the agent PROVIDER's deterministic decision lane. A proposed
    // agreement whose provider is an agent gets ONE deliverability verdict
    // at remind time — the same judgment as the signing gates (R6-B-F01):
    // fully deliverable → accept, clearly not → reject with reason,
    // cannot judge (retired rows) → stays proposed (honest hold). Human
    // providers keep deciding themselves; countered rows belong to the
    // consumer. No timeout expiry, no LLM — pure rules (see
    // agreements/provider-decision.ts).
    let autoDecision: { decision: 'accept' | 'reject'; reason?: string } | undefined;
    if (agreement.status === 'proposed' && agreement.provider_agent_id !== null) {
      const verdict = assessProviderDeliverability(ctx, agreement);
      if (verdict.action === 'accept' || verdict.action === 'reject') {
        const decision = verdict.action;
        const next = ctx.agreementStore.setStatus(
          agreement.id,
          decision === 'accept' ? 'active' : 'rejected',
          decision === 'reject' ? verdict.reason : null,
        );
        if (next.status === 'active') {
          void ctx.worldSessions?.noteFreshnessObligation(next.env_id).catch(() => {});
        }
        notify(ctx.notificationStore, {
          recipientId: next.consumer_owner_id,
          actorId: agreement.provider_owner_id,
          envId: next.env_id,
          kind: decision === 'accept'
            ? NOTIFICATION_KINDS.agreementAccepted
            : NOTIFICATION_KINDS.agreementRejected,
          title: t(
            request.locale,
            decision === 'accept' ? 'chrome.notif.agreementAccepted' : 'chrome.notif.agreementRejected',
          ),
          body: {
            agreementId: next.id,
            serviceId: next.service_id,
            status: next.status,
            decidedBy: 'provider-agent (deterministic deliverability assessment)',
            ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
            ...(decision === 'accept'
              ? {
                  callable: true,
                  serviceName: (next.service_id !== null ? ctx.serviceStore.getService(next.service_id)?.name : undefined) ?? next.service_id,
                }
              : {}),
          },
          refId: next.id,
        });
        ctx.pipeline.publishAgreement(
          next.env_id,
          decision === 'accept' ? 'accepted' : 'rejected',
          agreement.id,
          agreement.provider_owner_id,
        );
        // T-025: audit row — the auto decision is a first-class transition
        // with its actor marker (decidedBy), same kind as a party decision.
        ctx.pipeline.log({
          envId: next.env_id,
          actorId: agreement.provider_owner_id,
          kind: 'agreement-transition',
          payload: {
            agreementId: next.id,
            serviceId: next.service_id,
            from: 'proposed',
            to: next.status,
            decision,
            decidedBy: 'provider-agent:auto',
            trigger: 'agreement.remind',
            ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
          },
        });
        autoDecision = {
          decision,
          ...(verdict.action === 'reject' ? { reason: verdict.reason } : {}),
        };
      }
    }
    return reply.code(200).send({
      agreementId: reminded.id,
      // The post-lane status: the auto decision may have moved the row off
      // `proposed` in this same request — the echo must not lie about it.
      status: autoDecision !== undefined
        ? (autoDecision.decision === 'accept' ? 'active' : 'rejected')
        : reminded.status,
      reminded: delivered !== null,
      // T9: the remind trace, echoed on the response (dual-face with
      // agreement get/list).
      remindCount: reminded.remind_count,
      lastRemindedAt: reminded.last_reminded_at,
      ...(delivered === null ? { note: 'notification dropped by a noise-control rule (e.g. provider === consumer)' } : {}),
      ...(autoDecision !== undefined ? { autoDecision } : {}),
    });
  });

  app.post('/api/agreements/:id/suspend', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.provider_owner_id !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the provider may suspend an agreement');
    }
    if (agreement.status !== 'active') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_ACTIVE',
        notActiveTeaching(ctx, agreement, 'only active agreements can be suspended'),
      );
    }
    const next = ctx.agreementStore.setStatus(
      id,
      'suspended',
      // R102 (wang-18): an optional reason rides the suspension.
      parseDecisionReason((request.body ?? {}) as Record<string, unknown>) ?? null,
    );
    // Fix-16: the consumer learns the suspension without polling.
    notify(ctx.notificationStore, {
      recipientId: next.consumer_owner_id,
      actorId: user.id,
      envId: next.env_id,
      kind: NOTIFICATION_KINDS.agreementSuspended,
      title: t(request.locale, 'chrome.notif.agreementSuspended'),
      body: {
        agreementId: next.id,
        serviceId: next.service_id,
        status: 'suspended',
        ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
      },
      refId: next.id,
    });
    ctx.pipeline.publishAgreement(next.env_id, 'suspended', id, user.id);
    // T-025: audit row.
    ctx.pipeline.log({
      envId: next.env_id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: {
        agreementId: next.id,
        serviceId: next.service_id,
        from: 'active',
        to: 'suspended',
        ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
      },
    });
    // R99 (zhao-09): suspend is IRREVERSIBLE by design (no suspended→active
    // edge — TLA 迁移集合零扩张) but read as a reversible pair with resume.
    // The action response says so explicitly (machine-readable marker +
    // human note); the reversible pause is the consumer's hold.
    return {
      ...agreementToJson(ctx, next),
      irreversible: true,
      note:
        'suspend 不可恢复——合约将保持 suspended 直到 terminate（之后可重新签约）；' +
        '需要"暂停-恢复"语义时请使用 consumer 的 hold（hold 过期自动恢复 active）。' +
        'Suspend is irreversible by design: the agreement stays suspended until terminate; ' +
        'the reversible pause is the consumer hold.',
    };
  });

  // -------------------------------------------------------------------------
  // D3 (DevLoop R28, T-080): consumer hold — the bounded circuit breaker.
  //
  // POST /api/agreements/:id/hold {durationSec ≤ 3600} by the CONSUMER:
  // suspends auto-trigger execution AND manual invokes for THAT agreement
  // only; status 'held' is provider-visible; the hold auto-expires (lazy
  // evaluation at read/trigger boundaries — no resident timer); quota is
  // untouched (nothing executes, nothing burns). DELETE …/hold resumes.
  // Data lanes (reads/streams) keep delivering — the ruling suspends the
  // ACTUATION lanes only. Terminate stays terminal (held is non-terminal).
  // -------------------------------------------------------------------------

  app.post('/api/agreements/:id/hold', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.consumer_owner_id !== user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the consumer may hold an agreement — the hold is the consumer\'s circuit breaker ' +
          '(the provider suspends with POST /api/agreements/:id/suspend)',
      );
    }
    if (agreement.status !== 'active') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_ACTIVE',
        notActiveTeaching(ctx, agreement, 'only active agreements can be held'),
      );
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (
      typeof body.durationSec !== 'number' || !Number.isInteger(body.durationSec) ||
      body.durationSec < 1
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "durationSec" must be an integer ≥ 1 (how long the hold lasts, in seconds)',
      );
    }
    if (body.durationSec > AgreementStore.HOLD_MAX_SEC) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "durationSec" is ${body.durationSec}s — the hold ceiling is ` +
          `${AgreementStore.HOLD_MAX_SEC}s (the pause is bounded by design so it can never become ` +
          'a permanent free tier; hold again to extend, or terminate if the relationship is over)',
      );
    }
    const holdExpiresAt = new Date(Date.now() + body.durationSec * 1000).toISOString();
    const next = ctx.agreementStore.hold(id, holdExpiresAt);
    // The provider learns the pause without polling (their delivery lane
    // just went quiet — they need the why and the until).
    notify(ctx.notificationStore, {
      recipientId: next.provider_owner_id,
      actorId: user.id,
      envId: next.env_id,
      kind: NOTIFICATION_KINDS.agreementHeld,
      title: t(request.locale, 'chrome.notif.agreementHeld'),
      body: {
        agreementId: next.id,
        serviceId: next.service_id,
        status: 'held',
        durationSec: body.durationSec,
        holdExpiresAt,
        consumerName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
      },
      refId: next.id,
    });
    ctx.pipeline.publishAgreement(next.env_id, 'held', id, user.id);
    // T-025: audit row (the pause is a lifecycle transition parties may dispute).
    ctx.pipeline.log({
      envId: next.env_id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: {
        agreementId: next.id,
        serviceId: next.service_id,
        from: 'active',
        to: 'held',
        durationSec: body.durationSec,
        holdExpiresAt,
      },
    });
    return agreementToJson(ctx, next);
  });

  app.delete('/api/agreements/:id/hold', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.consumer_owner_id !== user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the consumer may resume a held agreement (the hold is theirs)',
      );
    }
    if (agreement.status !== 'held') {
      // R99 (zhao-09): for a SUSPENDED agreement the error must name the way
      // forward — suspend has no resume edge by design (TLA 迁移集合零扩张);
      // the reversible pause is the consumer's hold.
      throw new ApiError(
        409,
        'AGREEMENT_NOT_HELD',
        `Agreement "${id}" is ${agreement.status} — only held agreements can be resumed ` +
          '(an expired hold has already flipped back to active by itself)' +
          (agreement.status === 'suspended'
            ? '. 注意：provider 的 suspend 是不可逆的（设计上没有 suspended→active 恢复边）——' +
              '该合约的去向是 terminate（之后可重新签约）；需要"暂停-恢复"语义时，' +
              '请使用 consumer 的 hold（hold 过期自动恢复 active）'
            : ''),
      );
    }
    const next = ctx.agreementStore.resume(id);
    notify(ctx.notificationStore, {
      recipientId: next.provider_owner_id,
      actorId: user.id,
      envId: next.env_id,
      kind: NOTIFICATION_KINDS.agreementResumed,
      title: t(request.locale, 'chrome.notif.agreementResumed'),
      body: { agreementId: next.id, serviceId: next.service_id, status: 'active' },
      refId: next.id,
    });
    ctx.pipeline.publishAgreement(next.env_id, 'resumed', id, user.id);
    ctx.pipeline.log({
      envId: next.env_id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: { agreementId: next.id, serviceId: next.service_id, from: 'held', to: 'active' },
    });
    return agreementToJson(ctx, next);
  });

  app.post('/api/agreements/:id/terminate', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    // v60 (R6-E-F08): the ENV OWNER joins the terminate right — the closer of
    // last resort for provider-unavailable rows (a suspended agreement whose
    // provider agent is gone still needs a human reachable end; the env owner
    // is the only actor who sees every retired row via the digest). Same
    // existing edge (any non-terminal → terminated), wider actor set only.
    const env = ctx.envStore.getEnvironment(agreement.env_id);
    const isEnvOwner = env !== undefined && env.owner_id === user.id;
    const isParty =
      agreement.consumer_owner_id === user.id || agreement.provider_owner_id === user.id;
    if (!isParty && !isEnvOwner) {
      throw new ApiError(403, 'FORBIDDEN', 'Only a party of the agreement (or the env owner) may terminate it');
    }
    if (agreement.status === 'rejected' || agreement.status === 'terminated') {
      throw new ApiError(
        409,
        'AGREEMENT_TERMINAL',
        `Agreement "${id}" is already ${agreement.status}`,
      );
    }
    const next = ctx.agreementStore.setStatus(
      id,
      'terminated',
      // R102 (wang-18): an optional reason rides the termination.
      parseDecisionReason((request.body ?? {}) as Record<string, unknown>) ?? null,
    );
    // Fix-16: the OTHER party learns the termination (the actor already knows).
    // v60: an env-owner termination is NEITHER party's act — both parties
    // learn it.
    const recipients = isParty
      ? [next.consumer_owner_id === user.id ? next.provider_owner_id : next.consumer_owner_id]
      : [next.consumer_owner_id, next.provider_owner_id];
    for (const recipientId of recipients) {
      notify(ctx.notificationStore, {
        recipientId,
        actorId: user.id,
        envId: next.env_id,
        kind: NOTIFICATION_KINDS.agreementTerminated,
        // T75 (R8, u3-F4): the title speaks the SAME attribution the audit
        // row carries — an env-owner termination is neither party's act, so
        // "已 by the other party" would contradict the audit actor (the two
        // faces must never tell two stories about one event).
        title: isParty
          ? t(request.locale, 'chrome.notif.agreementTerminated')
          : t(request.locale, 'chrome.notif.agreementTerminatedByEnvOwner'),
        body: {
          agreementId: next.id,
          serviceId: next.service_id,
          status: 'terminated',
          terminatedBy: isParty ? 'party' : 'env-owner',
          // T75 (R8, u3-F4): the actor identity rides the SAME notification —
          // the title, the body and the audit row all speak one attribution.
          terminatedByName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
          ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
        },
        refId: next.id,
      });
    }
    ctx.pipeline.publishAgreement(next.env_id, 'terminated', id, user.id);
    // T-025: audit row (bilateral: either party may terminate).
    ctx.pipeline.log({
      envId: next.env_id,
      actorId: user.id,
      kind: 'agreement-transition',
      payload: {
        agreementId: next.id,
        serviceId: next.service_id,
        from: agreement.status,
        to: 'terminated',
        ...(next.status_reason !== null ? { reason: next.status_reason } : {}),
      },
    });
    return agreementToJson(ctx, next);
  });

  // -------------------------------------------------------------------------
  // Invoke consumption (§3.2.1)
  // -------------------------------------------------------------------------

  // T128 (R20-u2 F1): the invoke lane's honest wait floor. The route awaits
  // the provider agent's decision synchronously; a slow/cold LLM window used
  // to blow through the public gateway's 100s (bare 504, no teaching, usage
  // looked lost). 90s answers the platform envelope BEFORE the gateway kills
  // the request; the execution keeps running server-side and lands its
  // metering when it completes.
  const INVOKE_DECISION_WAIT_LIMIT_MS = 90_000;
  /** How soon the 503 teaches the caller to re-check `agreement usage`. */
  const INVOKE_DECISION_RETRY_AFTER_SEC = 30;

  app.post('/api/agreements/:id/invocations', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.consumer_owner_id !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the consumer may invoke an agreement');
    }
    // D3 (T-080): a HELD agreement refuses manual invokes with its own
    // teaching code — AGREEMENT_NOT_ACTIVE would hide the resume move the
    // consumer themselves controls (the hold is theirs; DELETE …/hold ends
    // it, or it expires by itself at holdExpiresAt).
    if (agreement.status === 'held') {
      throw new ApiError(
        409,
        'AGREEMENT_HELD',
        `Agreement "${id}" is held by the consumer until ` +
          `${agreement.hold_expires_at ?? '(no deadline recorded)'} — manual invokes are suspended ` +
          'for this agreement only. Resume it yourself (DELETE /api/agreements/:id/hold) or wait ' +
          'for the hold to expire; auto-trigger execution is suspended for the same window and ' +
          'quota does not burn while held',
      );
    }
    if (agreement.status !== 'active') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_ACTIVE',
        notActiveTeaching(ctx, agreement, 'invocations require an active agreement'),
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const action = requireNonEmptyString(body.action, 'action');
    if (body.params !== undefined &&
        (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "params" must be an object when provided');
    }
    const params = body.params as Record<string, unknown> | undefined;
    // T-205 sim targeting: the invoke may name the simulation it targets.
    if (body.simulationId !== undefined &&
        (typeof body.simulationId !== 'string' || body.simulationId.length === 0)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "simulationId" must be a non-empty string when provided');
    }
    const simulationId = body.simulationId as string | undefined;

    const terms = parseTerms(agreement.terms_json);

    // Quota enforcement (§6 Phase 2, Fix-20): when the terms carry BOTH
    // quotaPerWindow and windowSec, the current window may hold at most
    // quotaPerWindow consumption acts — over the limit the invoke is
    // rejected before any execution or metering. windowKind (Wave-6):
    // 'sliding' (default) = the last windowSec seconds; 'fixed' = tumbling
    // windows anchored at the agreement's (re)activation (updated_at —
    // invoke requires active, so updated_at IS when it went active).
    // Missing terms mean "unlimited" (principle 6). T-205: the count is
    // delivered-consumption only (countUsageSince filters outcome=
    // 'success') — probes and failures are metered but cannot burn quota.
    // The gate itself is shared with the trigger lane
    // (consumptionQuotaStatus) so the two can never drift.
    const quota = consumptionQuotaStatus(terms, agreement, since =>
      ctx.agreementStore.countUsageSince(agreement.id, since),
    );
    if (quota?.spent === true) {
      throw new ApiError(
        429,
        'QUOTA_EXCEEDED',
        `Agreement "${id}" quota exceeded: ${quota.current}/${quota.limit} ` +
          `invocations in the current ${terms.windowSec as number}s window — retry after the window passes`,
        undefined,
        { quota: 'agreement_consumption_per_window', limit: quota.limit, current: quota.current },
      );
    }

    // World-layer invoke semantics (Phase 1): the provider agent exists in
    // the simulation runtime, so execution happens inside the env's RUNNING
    // simulation — there is no world-layer device channel (device-privacy
    // principle). No running sim → a clear 409 telling the caller to start one.
    //
    // T-205/T-052/T-311 sim targeting: ONE shared contract for every
    // consumption lane — explicit body.simulationId must be a RUNNING sim of
    // THIS environment the caller may target; cross-tenant explicit
    // targeting → 403. The env owner's sims stay targetable: the
    // teaching-world flow is a consumer invoking into the owner's demo
    // simulation.
    //
    // T-501 (CB24-F01): the invoke lane joins the session-aware targeting
    // the read/stream lanes already use. With NO simulationId the env's
    // AUTHORITATIVE WORLD SESSION is the default target (created on demand,
    // materialized to wall-now) — manual invokes and trigger-driven
    // consumption now execute in the same world instead of splitting the
    // story across a throwaway private sim. An explicit
    // `sim-<envId>-world-session` id resolves identically (the session is
    // platform-created — never foreign). A private per-user sim remains an
    // explicit opt-in with the T-052 ownership rules intact; when the
    // session cannot exist the legacy lanes answer honestly below. The
    // targeting await itself lives INSIDE the T128/T129 race below (T129:
    // the r21 outage parked callers exactly here, unreachable by any 503).

    // T-035: the execution core (device resolution → terms/device gates →
    // metered execute → receipt/audit) is SHARED with the agreement-trigger
    // executor — manual invokes and automatic trigger clauses run the exact
    // same path, so metering/attribution can never drift between them.
    //
    // T128 (R20-u2 F1): the invoke awaits the provider agent's decision
    // SYNCHRONOUSLY — in a slow/cold LLM window that wait blew straight
    // through the public gateway's 100s and the caller saw a bare 504 with
    // zero platform teaching (and no idea the work was still running). The
    // honest floor: hold the connection at most INVOKE_DECISION_WAIT_LIMIT_MS
    // (90s — deliberately under the gateway's 100s), then answer 503
    // INVOKE_DECISION_PENDING + retryAfterSec and let the execution FINISH in
    // the background: its usage row (+ receipt) lands when the decision
    // completes, so the caller reconciles via `agreement usage` instead of
    // re-invoking (a re-invoke would execute the action twice).
    //
    // T129 (R21-F1): the floor now covers the WHOLE lane — targeting first
    // (resolveConsumptionTargetSimForLane: the world-session wake/catch-up
    // that used to sit OUTSIDE the race, where the r21 outage parked callers
    // past the gateway kill with the T128 503 unreachable), then the
    // decision + execution. A pending answer names where it is honestly:
    // still targeting → CONSUMPTION_TARGET_PENDING; past targeting (the
    // provider deciding) → INVOKE_DECISION_PENDING unchanged.
    const waitLimitMs = ctx.invokeDecisionWaitMs ?? INVOKE_DECISION_WAIT_LIMIT_MS;
    let lanePhase: 'targeting' | 'execution' = 'targeting';
    const execution = (async () => {
      const record = await resolveConsumptionTargetSimForLane(
        ctx, agreement, user.id, simulationId, 'invocations',
        { preferSession: true },
      );
      lanePhase = 'execution';
      const outcome = await executeAgreementInvocation(ctx, {
        agreement,
        terms,
        runtime: record.runtime,
        simulationId: record.id,
        action,
        params,
        actor: { userId: user.id, locale: request.locale },
      });
      return { targetSimId: record.id, outcome };
    })();
    let waitTimer: NodeJS.Timeout | undefined;
    const decisionPending = new Promise<'pending'>(resolve => {
      waitTimer = setTimeout(() => resolve('pending'), waitLimitMs);
      waitTimer.unref?.();
    });
    const raced = await Promise.race([execution, decisionPending]);
    clearTimeout(waitTimer);
    if (raced === 'pending') {
      // Detached continuation: never an unhandled rejection. The metering
      // tail (usage + receipt + audit) belongs to THIS invocation and lands
      // whenever the decision completes — the 503 is a waiting-room answer,
      // not a cancellation.
      void execution.catch(error => {
        request.log.warn(
          { err: error, agreementId: agreement.id },
          'agreement invoke: background execution failed after the 503 decision-pending answer',
        );
      });
      reply.header('retry-after', String(INVOKE_DECISION_RETRY_AFTER_SEC));
      if (lanePhase === 'targeting') {
        throw new ApiError(
          503,
          'CONSUMPTION_TARGET_PENDING',
          `The invocation's world targeting is still pending — the environment's authoritative ` +
            'world session is being woken / caught up to wall-now (a world that fell behind keeps ' +
            'catching up server-side; nothing is truncated or skipped). This invocation has waited ' +
            `${Math.round(waitLimitMs / 1000)}s on the connection, this endpoint's honest wait floor ` +
            '(the gateway kills longer waits at ~100s with a bare 504). The invocation KEEPS RUNNING ' +
            'server-side: its usage row and receipt land when targeting and execution complete — check ' +
            `\`eaf agreement usage ${agreement.id}\` (GET /api/agreements/${agreement.id}/usage) in a moment ` +
            'instead of re-invoking (a re-invoke would execute the action twice). ' +
            '本次调用的世界定向仍在进行（权威 world session 唤醒/追平中；落后较多的世界会在服务端继续追平，' +
            '不会截断或跳变）——本次调用不会丢：定向与执行完成后计量正常落账，' +
            `请稍后用 \`eaf agreement usage ${agreement.id}\` 查询结果，不要重复 invoke（会重复执行动作）。`,
          undefined,
          { retryAfterSec: INVOKE_DECISION_RETRY_AFTER_SEC },
        );
      }
      throw new ApiError(
        503,
        'INVOKE_DECISION_PENDING',
        `The provider's agent is still deciding — this invocation has waited ` +
          `${Math.round(waitLimitMs / 1000)}s on the connection, this endpoint's honest wait floor ` +
          '(the gateway kills longer waits at ~100s with a bare 504). The invocation KEEPS RUNNING ' +
          'server-side: its usage row and receipt land when the decision completes — check ' +
          `\`eaf agreement usage ${agreement.id}\` (GET /api/agreements/${agreement.id}/usage) in a moment ` +
          'instead of re-invoking (a re-invoke would execute the action twice). ' +
          '提供方 agent 的决策仍在进行——本次调用不会丢：决策完成后计量正常落账，' +
          `请稍后用 \`eaf agreement usage ${agreement.id}\` 查询结果，不要重复 invoke（会重复执行动作）。`,
        undefined,
        { retryAfterSec: INVOKE_DECISION_RETRY_AFTER_SEC },
      );
    }
    const { targetSimId, outcome } = raced;

    return {
      agreementId: agreement.id,
      simulationId: targetSimId,
      deviceId: outcome.deviceId,
      action,
      success: outcome.success,
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      // T-205 (SF-F05): echo WHAT WAS APPLIED — the action and the
      // post-terms-merge params sent to the device — alongside the physics
      // result, so "value: 50.37" no longer masquerades as the commanded
      // brightness 100. Mechanism D: a flow-service invoke names the flow
      // run instead of a device.
      applied: outcome.flowRun !== undefined
        ? {
            action,
            params: outcome.effectiveParams,
            flow: outcome.flowRun,
          }
        : {
            action,
            params: outcome.effectiveParams,
            deviceId: outcome.deviceId,
          },
      // T-052: legacy (prose-only) agreements carry no structured action
      // clause, so the invoke scope is UNRESTRICTED — consumers see that
      // explicitly instead of inferring it from the terms' silence.
      termsEnforced: outcome.termsEnforced,
      usage: usageToJson(outcome.usage),
      receiptId: outcome.receiptId,
    };
  });

  // -------------------------------------------------------------------------
  // Data-read consumption (R14 Wave-A, design-data-services.md §4–§7) — the
  // pull lane on computation-backed services.
  // -------------------------------------------------------------------------

  app.post('/api/agreements/:id/reads', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.consumer_owner_id !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the consumer may read an agreement');
    }
    if (agreement.status !== 'active') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_ACTIVE',
        notActiveTeaching(ctx, agreement, 'data reads require an active agreement'),
      );
    }
    return deliverRead(ctx, agreement, (request.body ?? {}) as Record<string, unknown>, 'recompute');
  });

  app.get('/api/agreements/:id/reads/latest', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user!;
    const agreement = getVisibleAgreementOrThrow(ctx, id, user.id);
    if (agreement.consumer_owner_id !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the consumer may read an agreement');
    }
    if (agreement.status !== 'active') {
      throw new ApiError(
        409,
        'AGREEMENT_NOT_ACTIVE',
        notActiveTeaching(ctx, agreement, 'data reads require an active agreement'),
      );
    }
    return deliverRead(ctx, agreement, {}, 'latest');
  });

  // -------------------------------------------------------------------------
  // Metering + settlement reads (T6): parties + env owner see the full
  // ledger; terminated rows also open to env members and — on a public
  // environment — any reader, as the same restricted view the list serves
  // (usage rows are agent-level: consumer/provider agent ids, no owner
  // identities). Live rows keep party/env-owner-only visibility.
  // -------------------------------------------------------------------------

  app.get('/api/agreements/:id/usage', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user ?? undefined;
    const view = getAgreementReadView(ctx, id, user?.id);
    const usage = ctx.agreementStore.usageOf(view.agreement.id).map(usageToJson);
    if (view.restricted) return { usage, view: 'restricted' };
    return { usage };
  });

  app.get('/api/agreements/:id/receipts', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as AgreementParams;
    const user = request.user ?? undefined;
    const view = getAgreementReadView(ctx, id, user?.id);
    const receipts = await ctx.settlement.receipts(view.agreement.id);
    if (view.restricted) return { receipts, view: 'restricted' };
    return { receipts };
  });

  // -------------------------------------------------------------------------
  // Stream consumption (§3.2.2, Phase 2)
  // -------------------------------------------------------------------------

  app.get(
    '/api/agreements/:id/stream',
    {
      websocket: true,
      // Auth + visibility + preconditions BEFORE the upgrade, with plain
      // HTTP error bodies: unknown/invisible → 404; not active → 409;
      // no running simulation → 409 (rejected, not parked — simple and
      // explicit: the caller starts a sim and reconnects).
      preValidation: [
        app.authenticate,
        async (request: FastifyRequest, reply) => {
          const { id } = request.params as AgreementParams;
          const user = request.user!;
          const agreement = ctx.agreementStore.getAgreement(id);
          const env = agreement ? ctx.envStore.getEnvironment(agreement.env_id) : undefined;
          if (
            !agreement || !env ||
            (agreement.consumer_owner_id !== user.id &&
              agreement.provider_owner_id !== user.id &&
              env.owner_id !== user.id)
          ) {
            await reply.code(404).send(errorBody('AGREEMENT_NOT_FOUND', `Agreement "${id}" not found`));
            return;
          }
          if (agreement.status !== 'active') {
            await reply.code(409).send(errorBody(
              'AGREEMENT_NOT_ACTIVE',
              notActiveTeaching(ctx, agreement, 'streams require an active agreement'),
            ));
            return;
          }
          // T-311: sim targeting mirrors the invoke contract (explicit
          // ?simulationId, ambiguity 409 with candidates, ownership).
          // Living-worlds P1W: computation-backed streams prefer the env's
          // authoritative world session (the data lane's authoritative
          // frame); device-observation streams prefer an EXISTING session
          // but never create one (device observation stays a sim-scoped
          // contract).
          // T129 (R21-F1): the upgrade handshake gets the same honest
          // targeting floor — a stalled session wake/catch-up used to park
          // the WS upgrade past the gateway kill too. Past the floor: 503
          // CONSUMPTION_TARGET_PENDING (+ Retry-After), the targeting keeps
          // completing server-side, the client reconnects.
          try {
            const streamTargetWaitMs = ctx.consumptionTargetWaitMs ?? CONSUMPTION_TARGET_WAIT_LIMIT_MS;
            await raceConsumptionTargeting(
              streamTargetWaitMs,
              () => new ApiError(
                503,
                'CONSUMPTION_TARGET_PENDING',
                `This stream's world targeting is still pending — the environment's authoritative ` +
                  'world session is being woken / caught up to wall-now. The upgrade handshake has ' +
                  `waited ${Math.round(streamTargetWaitMs / 1000)}s, this endpoint's honest wait floor ` +
                  '(the gateway kills longer waits at ~100s with a bare 504). Reconnect in a moment; ' +
                  'the targeting keeps completing server-side. ' +
                  '本次流订阅的世界定向仍在进行（权威 world session 唤醒/追平中）——稍后重连即可，定向会在服务端继续完成。',
                undefined,
                { retryAfterSec: CONSUMPTION_TARGET_RETRY_AFTER_SEC },
              ),
              () => resolveConsumptionTargetSimForLane(
                ctx, agreement, user.id,
                optionalQueryString((request.query as Record<string, unknown>).simulationId, 'simulationId'),
                'streams',
                { preferSession: (agreement.service_id !== null ? ctx.serviceStore.computationOf(agreement.service_id) : undefined) !== undefined },
              ),
            );
          } catch (error) {
            if (error instanceof ApiError) {
              // T129: a pending-503 carries retryAfterSec in the body AND the
              // Retry-After header (same envelope as the HTTP lanes).
              if (error.details?.retryAfterSec !== undefined) {
                reply.header('retry-after', String(error.details.retryAfterSec));
              }
              await reply.code(error.statusCode).send(
                errorBody(error.code, error.message, error.issues, error.details),
              );
              return;
            }
            throw error;
          }
          // R14 Wave-A: a computation-backed service streams DATA FRAMES —
          // there is no backing device to observe, and ?params (a device
          // observation filter) has no meaning on the data lane (terms.read.
          // fields is its scoping mechanism). Teaching 400 instead of a
          // silently ignored filter.
          const computation = agreement.service_id !== null
            ? ctx.serviceStore.computationOf(agreement.service_id)
            : undefined;
          if (computation !== undefined) {
            if ((request.query as Record<string, unknown>).params !== undefined) {
              await reply.code(400).send(errorBody(
                'BAD_REQUEST',
                'This agreement delivers a data service (a registered computation) — ?params filters device ' +
                  'observations, not data frames; the frame scope is terms.read.fields, and the push triggers ' +
                  "are the computation's inputs (drop ?params to subscribe)",
              ));
              return;
            }
            return;
          }
          // Mechanism D: a flow-service delivers discrete RUNS, not a
          // telemetry observable — there is nothing to stream. Teach the
          // consumer the invoke lane instead of failing the upgrade deeper.
          const streamService = agreement.service_id !== null
            ? ctx.serviceStore.getService(agreement.service_id)
            : undefined;
          if (streamService !== undefined && streamService.origin === 'flow') {
            await reply.code(409).send(errorBody(
              'SERVICE_NOT_STREAMABLE',
              'This agreement delivers a flow-service (discrete deterministic runs) — streams push device ' +
                'telemetry. Invoke instead: POST /api/agreements/' + agreement.id + '/invocations ' +
                '{ "action": "run", "params": { ... } } (the flow run ledger /api/flows/:id/runs carries the traces)',
            ));
            return;
          }
          try {
            resolveBackingDevice(ctx, agreement);
          } catch (error) {
            if (error instanceof ApiError) {
              await reply.code(error.statusCode).send(errorBody(error.code, error.message));
              return;
            }
            throw error;
          }
          // Fix-20: optional parameter-level filter (?params=temperature,co2)
          // — validated before the upgrade like every other precondition.
          try {
            parseStreamParamFilter((request.query as Record<string, unknown>).params);
          } catch (error) {
            if (error instanceof ApiError) {
              await reply.code(error.statusCode).send(errorBody(error.code, error.message));
              return;
            }
            throw error;
          }
        },
      ],
    },
    async (socket: WebSocket, request: FastifyRequest) => {
      const { id } = request.params as AgreementParams;
      const query = request.query as Record<string, unknown>;
      await runAgreementStreamSession(ctx, socket, {
        agreementId: id,
        userId: request.user!.id,
        simulationId: optionalQueryString(query.simulationId, 'simulationId'),
        paramFilter: parseStreamParamFilter(query.params),
        log: request.log,
      });
    },
  );
}

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be a non-empty string`);
  }
  return value;
}

function requireQueryString(value: unknown, field: string): string {
  const parsed = optionalQueryString(value, field);
  if (parsed === undefined) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" is required`);
  }
  return parsed;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}
