/**
 * Governance routes — proposals, owner decisions, and the command log
 * (multi-user-simulation-design.md §10, P-A slice)
 *
 * - `POST /api/environments/:id/proposals`   builder+ submits a proposal
 *     (four kinds; lands rejected / escalated / applied per the pipeline).
 * - `GET  /api/environments/:id/proposals`   members (owner/builder/viewer)
 *     see ALL proposals of the env — governance fact, not secret (T-404,
 *     R19); strangers keep the author-scoped view (own submissions only);
 *     `?status=` filters.
 * - `GET  /api/proposals/:id`                single-proposal read (T-404,
 *     CC-F05) — same env read gate as the list; returns proposalToJson.
 * - `POST /api/proposals/:id/decide`         env owner decides an ESCALATED
 *     proposal (`{decision: 'approved'|'rejected', reason?}`). T-072
 *     (D-1 decide half): the active zone-claims DELEGATE may additionally
 *     decide ESCALATED zone-claim proposals inside their delegated zones —
 *     attribution distinguishes the decider (aiReview.source='delegate',
 *     reviewerId, command_log payload.decidedVia). Everything else stays
 *     owner-only with a teaching 403 naming the delegation surface.
 * - `POST /api/proposals/:id/remind`         R33 (Care F2): the AUTHOR's
 *     rate-limited nudge (10-min window, agreement-remind semantics) on a
 *     still-ESCALATED proposal — one proposal.reminded notification to the
 *     decider (env owner + the covering zone-claims delegate for claims).
 * - `POST /api/proposals/:id/revert`         proposal author or env owner
 *     reverts an APPLIED proposal (inverse of the apply entry).
 * - `GET  /api/environments/:id/command-log` member audit query (`?limit=`,
 *     `?kind=`): the owner sees everything; other members see a scoped view —
 *     entries they acted on, plus `device-command` entries targeting their
 *     own devices (Fix-9, R4-P1).
 */

import type { FastifyInstance } from 'fastify';

import type { AuthUser } from '../auth/index.js';
import { ApiError } from '../errors.js';
import { t } from '../i18n/index.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';
import type { NotificationStore } from '../db/notification-store.js';
import {
  getEnvironmentOrThrow,
  requireBuilderOrOwner,
  requireEnvRole,
  requireObjectMutationAccess,
  requireReadAccess,
} from '../env-access.js';
import { ownerRef } from '../env-serializers.js';
import { parseJsonObject, type EnvironmentStore } from '../db/environment-store.js';
import {
  delegationCoversZone,
  delegationZonesOf,
  type EnvDelegationRow,
  type EnvDelegationStore,
} from '../db/env-delegation-store.js';
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type CommandLogRow,
  type CommandLogStore,
  type ProposalRow,
  type ProposalStatus,
  type ProposalStore,
} from '../db/proposal-store.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { assertAdoptConfigArtifactTypes } from '../proposal-rules.js';
import type { ProposalService } from '../proposal-service.js';

export interface ProposalRoutesContext {
  envStore: EnvironmentStore;
  proposalStore: ProposalStore;
  commandLogStore: CommandLogStore;
  proposalService: ProposalService;
  userStore: UserStore;
  /**
   * R33 (Care F2): the escalated-proposal remind lane's doorbell (and its
   * rate-limit anchor — the window reads the last emitted notification).
   */
  notificationStore: NotificationStore;
  /**
   * T-072 (D-1 decide half): the zone-claim decide gate consults the active
   * delegation. Optional for minimal test contexts — absent means "no
   * delegations", so deciding stays owner-only (fail closed).
   */
  delegationStore?: EnvDelegationStore;
}

interface IdParams {
  id: string;
}

const COMMAND_LOG_DEFAULT_LIMIT = 100;
const COMMAND_LOG_MAX_LIMIT = 500;

/**
 * R33 (Care F2): the escalated-proposal remind rate limit — same window and
 * anchor semantics as the agreement remind (T-309): one nudge per 10
 * minutes at most, anchored at proposal CREATION or the last reminder.
 */
const PROPOSAL_REMIND_WINDOW_MS = 10 * 60 * 1000;

export function registerProposalRoutes(app: FastifyInstance, ctx: ProposalRoutesContext): void {
  app.post(
    '/api/environments/:id/proposals',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireBuilderOrOwner(ctx.envStore, id, user);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const kind = body.kind;
      if (typeof kind !== 'string' || !PROPOSAL_KINDS.includes(kind as ProposalRow['kind'])) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "kind" must be one of ${PROPOSAL_KINDS.map(k => `"${k}"`).join(' | ')}`,
        );
      }
      const payload = body.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "payload" must be an object');
      }
      // P2F §11.3 blacklist gate: adopt-config artifacts outside the
      // whitelist (world-state dumps, observation fabrication, reputation,
      // agreement states, member/quota changes) are a CATEGORY ERROR, not a
      // proposal to negotiate — refused at submission with the whitelist and
      // the never-promotable classes named (the rule check re-verifies).
      if (kind === 'adopt-config') {
        assertAdoptConfigArtifactTypes(payload);
      }

      const row = await ctx.proposalService.submit(
        env,
        user,
        kind as ProposalRow['kind'],
        payload as Record<string, unknown>,
        request.locale,
      );
      return reply.code(201).send(proposalToJson(ctx, row));
    },
  );

  app.get(
    '/api/environments/:id/proposals',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      // T-026 (R10 EB-F06): the same read gate as every sibling endpoint —
      // a stranger on a PRIVATE env gets the teachable 403, not a
      // misleading "empty env" 200 [].
      const role = ctx.envStore.roleOf(id, user.id);
      requireReadAccess(env, role);

      const query = request.query as Record<string, unknown>;
      let status: ProposalStatus | undefined;
      if (query.status !== undefined) {
        if (
          typeof query.status !== 'string' ||
          !PROPOSAL_STATUSES.includes(query.status as ProposalStatus)
        ) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            `Query "status" must be one of ${PROPOSAL_STATUSES.map(s => `"${s}"`).join(' | ')}`,
          );
        }
        status = query.status as ProposalStatus;
      }

      // The environment owner sees every proposal (Fix-47-era behavior).
      // T-404 (DevLoop R19, FM-F01/NW-F06): MEMBERS see every proposal too —
      // the activity feed already broadcasts proposal submissions + actors,
      // and proposal content is governance fact, not secret. The affected
      // party of a zone-claim can finally SEE the ask and encode a position
      // (deciding stays owner-only — design-consent-semantics §5.3).
      // Strangers keep the author-scoped view (their own submissions only).
      // T-072 (D-1 decide half): each row is decorated with `youCanDecide` —
      // the member's list marks what THEY may decide (owner: every escalated
      // proposal; an active zone-claims delegate: escalated zone-claims
      // inside their delegated zones; everyone else: nothing).
      const rows = ctx.proposalStore.listForEnv(id, {
        ...(status !== undefined ? { status } : {}),
        ...(role === undefined ? { authorId: user.id } : {}),
      });
      return {
        proposals: rows.map(row => ({
          ...proposalToJson(ctx, row),
          youCanDecide: viewerCanDecide(ctx, env, row, user.id),
        })),
      };
    },
  );

  // T-404 (DevLoop R19, CC-F05): single-proposal read — decided-proposal
  // archaeology no longer requires scraping the activity feed. Same read
  // gate as the list (env read access: members always, strangers only on
  // public envs; private env strangers get the teachable 403).
  app.get('/api/proposals/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const proposal = ctx.proposalService.getOrThrow(id);
    const env = getEnvironmentOrThrow(ctx.envStore, proposal.env_id);
    requireReadAccess(env, ctx.envStore.roleOf(env.id, user.id));
    // T-072: same decidable-by-me mark as the list (the single read is where
    // a delegate inspects the claim before deciding).
    return {
      ...proposalToJson(ctx, proposal),
      youCanDecide: viewerCanDecide(ctx, env, proposal, user.id),
    };
  });

  app.post('/api/proposals/:id/decide', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const proposal = ctx.proposalService.getOrThrow(id);
    const env = getEnvironmentOrThrow(ctx.envStore, proposal.env_id);
    // T-072 (D-1 decide half): the owner decides everything as before; an
    // active zone-claims DELEGATE may additionally decide escalated
    // zone-claim proposals inside their delegated zones. Every refusal
    // teaches where the right actually lives.
    const decidedVia = requireDecideAccess(ctx, env, proposal, user);

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "decision" must be "approved" | "rejected"');
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "reason" must be a string');
    }

    const row = await ctx.proposalService.decide(
      proposal,
      user,
      body.decision,
      body.reason as string | undefined,
      request.locale,
      decidedVia,
    );
    return proposalToJson(ctx, row);
  });

  // R33 (DevLoop, Care F2): the blocked builder's nudge — an ESCALATED
  // proposal in a supervised zone used to sit indefinitely with no polite
  // pressure channel (agreements and access requests both had one; the
  // lane that most needs it did not). Mirrors the agreement remind (T-309)
  // exactly: ONE proposal.reminded notification to the DECIDER (the
  // environment owner — plus the active zone-claims delegate for a covered
  // zone-claim, mirroring the escalation's own dual delivery), rate-limited
  // to ≥10 minutes since the proposal CREATION or the last reminder
  // (429 with retry-after + the C6/T-088 anchor naming). A nudge, not
  // pressure: no state change, no expiry.
  app.post('/api/proposals/:id/remind', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const proposal = ctx.proposalService.getOrThrow(id);
    const env = getEnvironmentOrThrow(ctx.envStore, proposal.env_id);
    requireReadAccess(env, ctx.envStore.roleOf(env.id, user.id));
    if (proposal.author_id !== user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the proposal author may remind — the decision sits with the environment owner ' +
          '(or, for a delegated zone-claim, the zone-claims delegate); they were notified at escalation time',
      );
    }
    if (proposal.status !== 'escalated') {
      throw new ApiError(
        409,
        'PROPOSAL_NOT_ESCALATED',
        `Proposal "${id}" is ${proposal.status} — reminders apply to escalated proposals only ` +
          '(proposals awaiting the owner\'s explicit consent; everything else is decided by the pipeline instantly)',
      );
    }
    const recipientId = env.owner_id;
    const lastReminder = ctx.notificationStore.latestOfKind(
      recipientId,
      NOTIFICATION_KINDS.proposalReminded,
      proposal.id,
    );
    const anchorMs = lastReminder !== undefined
      ? new Date(lastReminder.created_at).getTime()
      : new Date(proposal.created_at).getTime();
    const elapsedMs = Date.now() - anchorMs;
    if (elapsedMs < PROPOSAL_REMIND_WINDOW_MS) {
      const retryAfterSec = Math.ceil((PROPOSAL_REMIND_WINDOW_MS - elapsedMs) / 1000);
      // C6/T-088 anchor naming (same as the agreement remind): the exact
      // earliest remind time + WHICH anchor the window used.
      const anchoredAt = new Date(anchorMs).toISOString();
      const earliestAt = new Date(anchorMs + PROPOSAL_REMIND_WINDOW_MS).toISOString();
      const anchorNote = lastReminder !== undefined
        ? 'a reminder was already sent recently'
        : 'no reminder has been sent yet, but the rate window starts at PROPOSAL CREATION, not at your first remind';
      throw new ApiError(
        429,
        'REMIND_RATE_LIMITED',
        `Proposal "${id}": ${anchorNote} — the earliest you may remind is ${earliestAt} ` +
          `(${anchoredAt} + ${PROPOSAL_REMIND_WINDOW_MS / 60000} min window; ~${retryAfterSec}s from now)`,
        undefined,
        { retryAfterSec, earliestAt, anchoredAt },
      );
    }
    const ruleCheck = parseJsonObject(proposal.rule_check_json);
    const escalateReason =
      typeof ruleCheck?.escalateReason === 'string' ? ruleCheck.escalateReason : undefined;
    const delivered = notify(ctx.notificationStore, {
      recipientId,
      actorId: user.id,
      envId: proposal.env_id,
      kind: NOTIFICATION_KINDS.proposalReminded,
      title: t(request.locale, 'chrome.notif.proposalReminded'),
      body: {
        proposalId: proposal.id,
        proposalKind: proposal.kind,
        authorName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
        // Care F2's visibility note: the nudge carries WHY the proposal is
        // waiting (the supervised-zone consent gate) so the decider sees the
        // gate, not just the ping.
        ...(escalateReason !== undefined ? { escalateReason } : {}),
        // T-059 pattern: the DECIDER's notification names their move.
        replyHint: {
          endpoint: `POST /api/proposals/${proposal.id}/decide`,
          allowedDecisions: ['approved', 'rejected'],
          yourMove: true,
        },
      },
      refId: proposal.id,
      dedupeUnread: true,
    });
    // T-072 mirror: an escalated zone-claim inside an active delegated
    // scope also reaches the delegate (they can decide it — the escalation
    // notification landed on their desk too). Rides the SAME remind action;
    // the rate window above anchors on the owner's notification.
    let delegateReminded = false;
    const delegation = ctx.delegationStore?.getActive(proposal.env_id, 'zone-claims');
    const zoneId = parseJsonObject(proposal.payload_json)?.zoneId;
    if (
      proposal.kind === 'zone-claim' &&
      delegation !== undefined &&
      delegation.delegate_id !== env.owner_id &&
      delegation.delegate_id !== user.id &&
      typeof zoneId === 'string' &&
      delegationCoversZone(delegation, zoneId)
    ) {
      const delegateDelivery = notify(ctx.notificationStore, {
        recipientId: delegation.delegate_id,
        actorId: user.id,
        envId: proposal.env_id,
        kind: NOTIFICATION_KINDS.proposalReminded,
        title: t(request.locale, 'chrome.notif.proposalReminded'),
        body: {
          proposalId: proposal.id,
          proposalKind: proposal.kind,
          delegatedToYou: true,
          replyHint: {
            endpoint: `POST /api/proposals/${proposal.id}/decide`,
            allowedDecisions: ['approved', 'rejected'],
            yourMove: true,
          },
        },
        refId: proposal.id,
        dedupeUnread: true,
      });
      delegateReminded = delegateDelivery !== null;
    }
    return reply.code(200).send({
      proposalId: proposal.id,
      status: proposal.status,
      reminded: delivered !== null,
      ...(delivered === null ? { note: 'notification dropped by a noise-control rule (e.g. owner === author)' } : {}),
      ...(delegateReminded ? { delegateReminded } : {}),
    });
  });

  app.post('/api/proposals/:id/revert', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const proposal = ctx.proposalService.getOrThrow(id);
    const env = getEnvironmentOrThrow(ctx.envStore, proposal.env_id);
    requireObjectMutationAccess(ctx.envStore, env, proposal.author_id, user, 'proposal');

    const row = await ctx.proposalService.revert(proposal, user, request.locale);
    return proposalToJson(ctx, row);
  });

  app.get(
    '/api/environments/:id/command-log',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      getEnvironmentOrThrow(ctx.envStore, id);
      // Fix-9 (R4-P1): every member may audit — the owner sees the full log,
      // other members a scoped view ("越权做得到、审计看得见").
      const role = requireEnvRole(ctx.envStore, id, user, ['owner', 'builder', 'viewer']);

      const query = request.query as Record<string, unknown>;
      let limit = COMMAND_LOG_DEFAULT_LIMIT;
      if (query.limit !== undefined) {
        const parsed = Number(query.limit);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new ApiError(400, 'BAD_REQUEST', 'Query "limit" must be a positive integer');
        }
        limit = Math.min(parsed, COMMAND_LOG_MAX_LIMIT);
      }
      const kind = typeof query.kind === 'string' ? query.kind : undefined;

      const rows = ctx.commandLogStore.listForEnv(id, {
        limit,
        ...(kind !== undefined ? { kind } : {}),
      });
      // Non-owner scoping happens AFTER the SQL limit (a member may get fewer
      // than `limit` rows) — visible = acted by me, or a device-command on a
      // device I own (so a device owner can always see who commanded it).
      const visible =
        role === 'owner' ? rows : rows.filter(row => isVisibleToMember(ctx, row, user.id));
      return { entries: visible.map(row => commandLogToJson(ctx, row)) };
    },
  );
}

/**
 * Fix-9 member-scoped visibility: the member's own actions, plus
 * `device-command` entries whose target device belongs to the member.
 */
function isVisibleToMember(
  ctx: ProposalRoutesContext,
  row: CommandLogRow,
  userId: string,
): boolean {
  if (row.actor_id === userId) return true;
  if (row.kind !== 'device-command') return false;
  const payload = parseJsonObject(row.payload_json);
  const deviceId = payload?.deviceId;
  if (typeof deviceId !== 'string') return false;
  return ctx.envStore.getDevice(deviceId)?.owner_id === userId;
}

// ---------------------------------------------------------------------------
// T-072 (D-1 decide half): the decide gate + the member's decidable-by-me mark
// ---------------------------------------------------------------------------

/**
 * Who may call POST /api/proposals/:id/decide: the environment owner
 * (everything, always — delegation never takes the owner's right away), or
 * the active zone-claims DELEGATE for escalated zone-claim proposals inside
 * their delegated zone scope. Every refusal is a TEACHING 403 that names
 * where the right actually lives — the delegation surface, the zone scope,
 * or the scope boundary for non-zone-claim kinds.
 */
function requireDecideAccess(
  ctx: ProposalRoutesContext,
  env: ReturnType<typeof getEnvironmentOrThrow>,
  proposal: ProposalRow,
  user: AuthUser,
): 'owner' | 'delegate' {
  const role = ctx.envStore.roleOf(env.id, user.id);
  if (role === 'owner') return 'owner';

  // Fix-46-style role context, so the refusal names the caller's situation
  // instead of a bare "requires owner".
  const memberNote =
    role === 'viewer'
      ? ' — you have the viewer (read-only) role in this environment'
      : role === undefined
        ? ' — you are not a member of this environment; join it or ask the owner for access'
        : '';
  const delegation = ctx.delegationStore?.getActive(env.id, 'zone-claims');

  if (proposal.kind === 'zone-claim') {
    if (delegation === undefined) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        `Deciding proposals is reserved for the environment owner${memberNote}. ` +
        `The owner may delegate zone-claim decisions to one member: ` +
        `POST /api/environments/${env.id}/delegations {userId, zones: 'all' | [zoneId, ...]}`,
      );
    }
    if (delegation.delegate_id !== user.id) {
      const delegate = ctx.userStore.findById(delegation.delegate_id);
      throw new ApiError(
        403,
        'FORBIDDEN',
        `zone-claim decisions in this environment are delegated to ` +
        `"${delegate?.display_name ?? delegation.delegate_id}" — only the environment owner ` +
        `or that delegate may decide this proposal`,
      );
    }
    const zoneId = parseJsonObject(proposal.payload_json)?.zoneId;
    if (typeof zoneId !== 'string' || !delegationCoversZone(delegation, zoneId)) {
      const covered = delegationZonesOf(delegation);
      throw new ApiError(
        403,
        'FORBIDDEN',
        `This claim is for zone "${typeof zoneId === 'string' ? zoneId : '?'}" — your delegation ` +
          `covers ${covered === 'all' ? 'all zones' : covered.map(z => `"${z}"`).join(', ')}; ` +
          `out-of-scope zone-claims stay with the environment owner ` +
          `(they can widen the scope with another grant)`,
      );
    }
    // T-602 (R26, SC26-F05): conflict-of-interest gate — the delegate may not
    // decide their OWN org's claim (author == decider). Self-dealing returns
    // to the §5.3 default (zone claims require environment-owner approval);
    // third-party claims stay decidable by the delegate.
    if (proposal.author_id === user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        `You authored this claim — a delegate cannot decide their own org's proposal ` +
        `(conflict of interest). It stays with the environment owner, who granted your ` +
        `delegation and can decide it, revert it, or revoke the delegation`,
      );
    }
    return 'delegate';
  }

  // Every other kind stays owner-only; when the caller IS the delegate, the
  // refusal names the scope boundary instead of hiding the delegation.
  if (delegation !== undefined && delegation.delegate_id === user.id) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only the environment owner may decide a "${proposal.kind}" proposal — your delegation in ` +
      `this environment covers zone-claim proposals only (scope "zone-claims"); decision ` +
      `delegation does not extend to other proposal kinds`,
    );
  }
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Deciding proposals is reserved for the environment owner${memberNote}`,
  );
}

/**
 * The list/read decoration (T-072): may THIS viewer decide the proposal
 * right now? Owner: every escalated proposal. Active zone-claims delegate:
 * escalated zone-claims inside their delegated zones. Everyone else (and
 * every non-escalated status): false.
 */
export function viewerCanDecide(
  ctx: ProposalRoutesContext,
  env: ReturnType<typeof getEnvironmentOrThrow>,
  proposal: ProposalRow,
  viewerId: string,
): boolean {
  if (proposal.status !== 'escalated') return false;
  const role = ctx.envStore.roleOf(env.id, viewerId);
  if (role === 'owner') return true;
  if (proposal.kind !== 'zone-claim') return false;
  // T-602 (R26): self-authored claims are never delegate-decidable.
  if (proposal.author_id === viewerId) return false;
  const delegation: EnvDelegationRow | undefined = ctx.delegationStore?.getActive(env.id, 'zone-claims');
  if (delegation === undefined || delegation.delegate_id !== viewerId) return false;
  const zoneId = parseJsonObject(proposal.payload_json)?.zoneId;
  return typeof zoneId === 'string' && delegationCoversZone(delegation, zoneId);
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/**
 * Shared proposal serializer — also used by the env-object routes, which
 * answer a builder's direct-edit call with the auto-submitted proposal
 * (Fix-1 unified change pipeline).
 *
 * Fix-10: an APPLIED proposal carries `createdIds` — the ids of the objects
 * its apply created, read back from the apply entry's after-payload so the
 * builder flow does not need a follow-up list call.
 */
export function proposalToJson(
  ctx: Pick<ProposalRoutesContext, 'userStore' | 'commandLogStore'>,
  row: ProposalRow,
) {
  const createdIds = createdIdsFor(ctx, row);
  // T-077: the zone-claim rationale surfaces as a first-class field so the
  // deciding owner's view does not have to dig into payload.
  const rationale = row.kind === 'zone-claim'
    ? (parseJsonObject(row.payload_json)?.rationale as string | undefined)
    : undefined;
  return {
    id: row.id,
    envId: row.env_id,
    kind: row.kind,
    payload: parseJsonObject(row.payload_json) ?? {},
    riskLevel: row.risk_level,
    status: row.status,
    ruleCheck: parseJsonObject(row.rule_check_json),
    aiReview: parseJsonObject(row.ai_review_json),
    author: userRef(ctx, row.author_id),
    reviewerId: row.reviewer_id,
    ...(typeof rationale === 'string' ? { rationale } : {}),
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    appliedAt: row.applied_at,
    expiresAt: row.expires_at,
    ...(createdIds !== undefined ? { createdIds } : {}),
  };
}

/**
 * Ids of the objects an applied proposal created (install-devices →
 * `devices`, install-agents → `agents`, inject-scenario → possibly both),
 * recovered from the apply entry's after-payload. Only non-empty keys
 * appear; the whole field is omitted when the proposal was not applied, has
 * no apply entry, or the entry does not parse (never a 500).
 */
function createdIdsFor(
  ctx: Pick<ProposalRoutesContext, 'commandLogStore'>,
  row: ProposalRow,
): { devices?: string[]; agents?: string[]; zones?: string[]; flows?: string[] } | undefined {
  if (row.status !== 'applied') return undefined;
  try {
    const entry = ctx.commandLogStore.findApplyEntry(row.id, row.kind);
    if (!entry) return undefined;
    const after = (JSON.parse(entry.payload_json) as { after?: unknown }).after;
    if (typeof after !== 'object' || after === null) return undefined;
    const idsOf = (key: 'devices' | 'agents' | 'zones' | 'flows'): string[] => {
      const list = (after as Record<string, unknown>)[key];
      if (!Array.isArray(list)) return [];
      return list
        .map(item =>
          typeof item === 'object' && item !== null
            ? (item as { id?: unknown }).id
            : undefined,
        )
        .filter((id): id is string => typeof id === 'string');
    };
    const devices = idsOf('devices');
    const agents = idsOf('agents');
    const zones = idsOf('zones');
    const flows = idsOf('flows');
    if (devices.length === 0 && agents.length === 0 && zones.length === 0 && flows.length === 0) {
      return undefined;
    }
    return {
      ...(devices.length > 0 ? { devices } : {}),
      ...(agents.length > 0 ? { agents } : {}),
      ...(zones.length > 0 ? { zones } : {}),
      ...(flows.length > 0 ? { flows } : {}),
    };
  } catch {
    return undefined;
  }
}

function commandLogToJson(ctx: ProposalRoutesContext, row: CommandLogRow) {
  return {
    id: row.id,
    envId: row.env_id,
    actor: userRef(ctx, row.actor_id),
    proposalId: row.proposal_id,
    kind: row.kind,
    payload: parseJsonObject(row.payload_json) ?? {},
    simTime: row.sim_time,
    wallTime: row.wall_time,
  };
}

function userRef(ctx: Pick<ProposalRoutesContext, 'userStore'>, userId: string) {
  const user = ctx.userStore.findById(userId);
  return ownerRef(user ? toPublicUser(user) : undefined, userId);
}
