/**
 * Decision-delegation routes — T-072 (DevLoop R23,
 * design-consent-semantics.md §3.4 / D-1 decide half)
 *
 * Split out of routes/environments.ts when that file hit its arch-guard
 * size ceiling (the same service-layer split pattern the agreements routes
 * use). The surface:
 *
 * - `GET    /api/environments/:id/delegations`  active delegations
 *     (read gate like the member list — a delegation is governance fact).
 * - `POST   /api/environments/:id/delegations`  owner delegates zone-claim
 *     decide rights to ONE member at a time (`{userId|email, zones?:
 *     'all'|[zoneId…]}`; same-delegate re-grant refreshes the zone scope;
 *     a different member → 409 teaching revoke-first).
 * - `DELETE /api/environments/:id/delegations/:delegateId` owner revokes.
 *
 * Lifecycle honesty: membership removal / self-leave revokes the departing
 * member's delegations (`revokeDelegationsOnMembershipEnd`, exported for
 * the environments routes) — an active delegation always names a current
 * member. Audit: command_log kind `delegation-change`; doorbells:
 * governance.delegation-granted / -revoked (zh/en).
 *
 * The v1 scope boundary is pinned in TWO places (schema CHECK + this
 * route's teaching 400): supervised-zone CONSENT delegation stays
 * owner-only — see design-consent-semantics.md §3.4 for the reasoning.
 */

import type { FastifyInstance } from 'fastify';

import type { UiLocale } from '@active-collaboration/shared';
import { ApiError } from '../errors.js';
import { getEnvironmentOrThrow, requireEnvRole, requireReadAccess } from '../env-access.js';
import { ownerRef } from '../env-serializers.js';
import type { OwnerRef } from '../env-serializers.js';
import {
  delegationZonesOf,
  type EnvDelegationRow,
} from '../db/env-delegation-store.js';
import type { EnvironmentRow } from '../db/environment-store.js';
import { parseMapData } from '../db/environment-store.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';
import { t } from '../i18n/index.js';
import { toPublicUser } from '../db/user-store.js';
import type { EnvironmentRoutesContext } from './environments.js';

interface IdParams {
  id: string;
}

export function registerDelegationRoutes(
  app: FastifyInstance,
  ctx: EnvironmentRoutesContext,
): void {
  app.get(
    '/api/environments/:id/delegations',
    { preHandler: app.optionalAuth },
    async request => {
      const { id } = request.params as IdParams;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
      // Same read gate as the member list — a delegation is governance
      // fact, not a secret.
      requireReadAccess(env, role);
      return {
        delegations: (ctx.delegationStore?.listForEnv(env.id) ?? []).map(row =>
          delegationToJson(ctx, env, row),
        ),
      };
    },
  );

  app.post(
    '/api/environments/:id/delegations',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const body = (request.body ?? {}) as Record<string, unknown>;
      // v1 ships exactly one scope; naming any other value is a teaching
      // 400 (never a silent drop).
      if (body.scope !== undefined && body.scope !== 'zone-claims') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "scope" must be "zone-claims" (the only delegation scope in this version — ` +
          `supervised-zone consent delegation stays owner-only by design)`,
        );
      }
      const target = resolveDelegateTarget(ctx, body);
      if (target.id === env.owner_id) {
        throw new ApiError(
          400,
          'OWNER_CANNOT_BE_DELEGATE',
          'The environment owner already decides everything — delegating to the owner is a no-op',
        );
      }
      if (ctx.envStore.roleOf(env.id, target.id) === undefined) {
        throw new ApiError(
          409,
          'DELEGATION_GRANTEE_NOT_MEMBER',
          `User "${target.id}" is not a member of environment "${env.id}" — add them first ` +
          `(POST /api/environments/${env.id}/members), then delegate`,
        );
      }

      // Zone scope: omitted or 'all' = every zone; otherwise an explicit
      // (non-empty, existing, deduplicated) zone id list.
      let zones: string[] | null = null;
      if (body.zones !== undefined && body.zones !== 'all') {
        if (!Array.isArray(body.zones) || body.zones.length === 0) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Body field "zones" must be "all" or a non-empty array of zone ids',
          );
        }
        const known = new Set(parseMapData(env).zones.map(zone => zone.id));
        const unique: string[] = [];
        for (const raw of body.zones) {
          if (typeof raw !== 'string') {
            throw new ApiError(400, 'BAD_REQUEST', 'Body field "zones" must contain zone id strings');
          }
          if (!known.has(raw)) {
            throw new ApiError(
              400,
              'UNKNOWN_ZONE',
              `Zone "${raw}" does not exist in environment "${env.id}"`,
            );
          }
          if (!unique.includes(raw)) unique.push(raw);
        }
        zones = unique;
      }

      // One delegate per scope at a time: switching delegates requires an
      // explicit revoke first, so the outgoing delegate always gets their
      // revocation notice instead of silently losing the right.
      const existing = ctx.delegationStore?.getActive(env.id, 'zone-claims');
      if (existing !== undefined && existing.delegate_id !== target.id) {
        throw new ApiError(
          409,
          'DELEGATION_ALREADY_GRANTED',
          `Scope "zone-claims" is already delegated to user "${existing.delegate_id}" in environment ` +
          `"${env.id}" — revoke it first (DELETE /api/environments/${env.id}/delegations/${existing.delegate_id}); ` +
          'one delegate per scope at a time',
        );
      }
      const action: 'granted' | 'zones-updated' =
        existing !== undefined && existing.delegate_id === target.id ? 'zones-updated' : 'granted';

      ctx.delegationStore?.grant({
        envId: env.id,
        scope: 'zone-claims',
        delegateId: target.id,
        zones,
        grantedBy: user.id,
      });
      const row = ctx.delegationStore!.getActive(env.id, 'zone-claims')!;
      // The delegate learns the right (and its zone scope) from their inbox.
      notify(ctx.notificationStore, {
        recipientId: target.id,
        actorId: user.id,
        envId: env.id,
        kind: NOTIFICATION_KINDS.governanceDelegationGranted,
        title: t(request.locale, 'chrome.notif.governanceDelegationGranted', {
          envName: env.name,
          zones: zones === null ? 'all zones' : zones.join(', '),
        }),
        body: {
          envId: env.id,
          envName: env.name,
          scope: 'zone-claims',
          zones: zones === null ? 'all' : zones,
          grantedByName: user.displayName,
          replyHint: {
            endpoint: 'POST /api/proposals/{proposalId}/decide',
            allowedDecisions: ['approved', 'rejected'],
            yourMove: true,
          },
        },
        refId: env.id,
      });
      // T-025 lineage: delegation changes are audited like every other
      // governance mutation (actor = the granting owner).
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'delegation-change',
        payload: {
          action,
          scope: 'zone-claims',
          delegateUserId: target.id,
          zones: zones === null ? 'all' : zones,
          before:
            existing === undefined
              ? null
              : { delegateUserId: existing.delegate_id, zones: delegationZonesOf(existing) },
          after: { delegateUserId: target.id, zones: zones === null ? 'all' : zones },
        },
      });
      const json = delegationToJson(ctx, env, row);
      return reply.code(action === 'granted' ? 201 : 200).send(json);
    },
  );

  app.delete(
    '/api/environments/:id/delegations/:delegateId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, delegateId } = request.params as IdParams & { delegateId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const row = ctx.delegationStore?.getActive(env.id, 'zone-claims');
      if (row === undefined || row.delegate_id !== delegateId) {
        throw new ApiError(
          404,
          'DELEGATION_NOT_FOUND',
          `No active "zone-claims" delegation to user "${delegateId}" in environment "${env.id}"`,
        );
      }
      ctx.delegationStore!.revoke(env.id, 'zone-claims', delegateId);
      notifyDelegationRevoked(ctx, env, delegateId, user.id, request.locale, 'owner-revoked');
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'delegation-change',
        payload: {
          action: 'revoked',
          scope: 'zone-claims',
          delegateUserId: delegateId,
          zones: delegationZonesOf(row),
          before: { delegateUserId: delegateId, zones: delegationZonesOf(row) },
          after: null,
          reason: 'owner-revoked',
        },
      });
      return reply.code(204).send();
    },
  );
}

/**
 * Resolve the delegate from `{userId}` / `{email}` (exactly one — the same
 * contract as the members invite target, kept local so this module does not
 * depend on environments.ts's private helper).
 */
function resolveDelegateTarget(
  ctx: EnvironmentRoutesContext,
  body: Record<string, unknown>,
): { id: string; display_name: string } {
  const hasEmail = typeof body.email === 'string' && body.email.trim().length > 0;
  const hasUserId = typeof body.userId === 'string' && body.userId.length > 0;
  if (body.email !== undefined && !hasEmail) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "email" must be a non-empty string');
  }
  if (body.userId !== undefined && !hasUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "userId" must be a non-empty string');
  }
  if (hasEmail === hasUserId) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body must carry exactly one of "email" or "userId"');
  }
  const target = hasEmail
    ? ctx.userStore.findByEmail((body.email as string).trim().toLowerCase())
    : ctx.userStore.findById(body.userId as string);
  if (!target) {
    throw new ApiError(
      404,
      'USER_NOT_FOUND',
      hasEmail
        ? `No registered user with email "${(body.email as string).trim().toLowerCase()}"`
        : `No registered user with id "${body.userId}"`,
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by the environments routes for the governance
// block + membership-end cleanup)
// ---------------------------------------------------------------------------

/** Delegation row → wire shape (delegate/grantedBy expanded to OwnerRefs). */
export function delegationToJson(
  ctx: EnvironmentRoutesContext,
  env: EnvironmentRow,
  row: EnvDelegationRow,
) {
  const ref = (userId: string) => {
    const user = ctx.userStore.findById(userId);
    return ownerRef(user ? toPublicUser(user) : undefined, userId);
  };
  return {
    scope: row.scope,
    delegate: ref(row.delegate_id),
    zones: delegationZonesOf(row),
    grantedBy: ref(row.granted_by),
    grantedAt: row.granted_at,
  };
}

/**
 * buildDetail variant: reuse the caller's already-built user resolver so a
 * delegation does not open a second findById pass per member.
 */
export function delegationJsonsFor(
  ctx: EnvironmentRoutesContext,
  envId: string,
  resolve: (id: string) => OwnerRef,
) {
  return (ctx.delegationStore?.listForEnv(envId) ?? []).map(row => ({
    scope: row.scope,
    delegate: resolve(row.delegate_id),
    zones: delegationZonesOf(row),
    grantedBy: resolve(row.granted_by),
    grantedAt: row.granted_at,
  }));
}

/**
 * The departed delegate is told their decide right lapsed (allowSelf: a
 * self-leave is exactly when the user must still learn the delegation
 * ended — the generic self-echo drop would silence it).
 */
function notifyDelegationRevoked(
  ctx: EnvironmentRoutesContext,
  env: EnvironmentRow,
  delegateId: string,
  actorId: string,
  locale: UiLocale,
  reason: 'owner-revoked' | 'member-removed' | 'member-left',
): void {
  notify(ctx.notificationStore, {
    recipientId: delegateId,
    actorId,
    envId: env.id,
    kind: NOTIFICATION_KINDS.governanceDelegationRevoked,
    title: t(locale, 'chrome.notif.governanceDelegationRevoked', { envName: env.name }),
    body: {
      envId: env.id,
      envName: env.name,
      scope: 'zone-claims',
      reason,
    },
    refId: env.id,
    allowSelf: reason !== 'owner-revoked',
  });
}

/**
 * Membership-end cleanup (T-072): revoke every delegation naming the
 * departing member, notify them, and audit each revocation. A no-op when
 * they held none.
 */
export function revokeDelegationsOnMembershipEnd(
  ctx: EnvironmentRoutesContext,
  env: EnvironmentRow,
  departingUserId: string,
  actorId: string,
  reason: 'member-removed' | 'member-left',
  locale: UiLocale,
): void {
  if (ctx.delegationStore === undefined) return;
  const rows = ctx.delegationStore.listForEnv(env.id).filter(row => row.delegate_id === departingUserId);
  if (rows.length === 0) return;
  ctx.delegationStore.revokeForDelegate(env.id, departingUserId);
  for (const row of rows) {
    ctx.pipeline.log({
      envId: env.id,
      actorId,
      kind: 'delegation-change',
      payload: {
        action: 'revoked',
        scope: row.scope,
        delegateUserId: departingUserId,
        zones: delegationZonesOf(row),
        before: { delegateUserId: departingUserId, zones: delegationZonesOf(row) },
        after: null,
        reason,
      },
    });
  }
  notifyDelegationRevoked(ctx, env, departingUserId, actorId, locale, reason);
}
