/**
 * Share routes (R15-B1) — anonymous read-only replay links.
 *
 * - `POST /api/environments/:id/replay-shares` (auth + env read access)
 *   Freezes the same replay the POST …/replays endpoint builds (observation
 *   window → scenario JSON, including the Fix-14 sim timeline events) behind
 *   an unguessable id. Visibility boundary mirrors the anonymous env-detail
 *   rule: only PUBLIC environments can be shared — a private env's data
 *   must never be reachable without membership, link or not.
 *   Body: `{ from, to, name?, description?, expiresInDays? }`.
 *   T-108: the env owner is notified (`share.created`) and the mint is
 *   audited in command_log (`share-create`).
 *
 * - `GET /api/environments/:id/replay-shares` (auth, owner only, T-108) —
 *   the discovery surface for live anonymous links on this environment.
 *
 * - `DELETE /api/environments/:id/replay-shares/:shareId` (auth, owner
 *   only, T-108) — revocation, the recall lever; audited as `share-revoke`.
 *
 * - `GET /api/shares/:shareId` (public — the whole point: judges on demo
 *   day have no account) → `{ id, name, description, envName, createdAt,
 *   expiresAt, scenario }`, 404 when unknown or expired, 410 SHARE_REVOKED
 *   after the owner revoked it.
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import { getEnvironmentOrThrow, requireEnvRole, requireReadAccess } from '../env-access.js';
import { t } from '../i18n/index.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';
import type { ChangePipeline } from '../change-pipeline.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { NotificationStore } from '../db/notification-store.js';
import type { ReplayShareStore } from '../db/replay-share-store.js';
import type { ReplayService, ReplayWindowInput } from '../replay-service.js';

export interface ShareRoutesContext {
  envStore: EnvironmentStore;
  replayService: ReplayService;
  shareStore: ReplayShareStore;
  /** T-108: mint/revoke reach the env owner's inbox. */
  notificationStore: NotificationStore;
  /** T-108: share-create / share-revoke audit rows. */
  pipeline: ChangePipeline;
}

const MAX_EXPIRES_DAYS = 365;

/** Allowed body keys for share creation (T-107 strict validation). */
const SHARE_BODY_KEYS = ['from', 'to', 'name', 'description', 'expiresInDays'] as const;

/**
 * T-107: reject unknown body keys. A typo like "expiresInDay" used to be
 * silently dropped — on the field controlling how long private world data
 * stays anonymously reachable — and the share minted with the 30-day
 * default. Name the unknown key (and the closest rename) instead.
 */
function assertKnownShareBodyKeys(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (!(SHARE_BODY_KEYS as readonly string[]).includes(key)) {
      const hint = key === 'expiresInDay' ? ' — did you mean "expiresInDays"?' : '';
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "${key}" is not accepted here (allowed: ${SHARE_BODY_KEYS.join(', ')})${hint}`,
      );
    }
  }
}

interface IdParams {
  id: string;
}

export function registerShareRoutes(app: FastifyInstance, ctx: ShareRoutesContext): void {
  app.post(
    '/api/environments/:id/replay-shares',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireReadAccess(env, ctx.envStore.roleOf(id, user.id));

      // B1 visibility rule, aligned with anonymous env detail: shares of a
      // private environment are rejected outright (403), not "created but
      // hidden" — an explicit failure teaches the operator to publish first.
      if (env.visibility !== 'public') {
        throw new ApiError(
          403,
          'ENV_NOT_PUBLIC',
          'Replay shares require a public environment — a private environment\'s data must not be reachable anonymously. ' +
            'Set the environment to public first if you want to share a replay link.',
        );
      }

      const body = (request.body ?? {}) as Record<string, unknown>;
      assertKnownShareBodyKeys(body);
      const from = requireIso(body.from, 'from');
      const to = requireIso(body.to, 'to');
      let expiresInDays = 30;
      if (body.expiresInDays !== undefined) {
        if (
          typeof body.expiresInDays !== 'number' || !Number.isInteger(body.expiresInDays) ||
          body.expiresInDays < 1 || body.expiresInDays > MAX_EXPIRES_DAYS
        ) {
          throw new ApiError(
            400, 'BAD_REQUEST',
            `Body field "expiresInDays" must be an integer 1..${MAX_EXPIRES_DAYS}`,
          );
        }
        expiresInDays = body.expiresInDays;
      }

      const input: ReplayWindowInput = {
        from,
        to,
        ...(typeof body.name === 'string' && body.name.trim().length > 0
          ? { name: body.name.trim() }
          : {}),
        ...(typeof body.description === 'string' && body.description.trim().length > 0
          ? { description: body.description.trim() }
          : {}),
      };
      // S2 (device privacy): the share bakes at the MINTER's tier — an
      // anonymous link minted by a non-owner carries no foreign device
      // telemetry (replay-service redacts by viewer; the env owner mints
      // full-fidelity replays).
      const { definition, report } = await ctx.replayService.buildReplay(env, input, { userId: user.id });
      const share = ctx.shareStore.create({
        environmentId: env.id,
        environmentName: env.name,
        name: input.name ?? env.name,
        description: input.description ?? '',
        scenarioJson: JSON.stringify(definition),
        eventCount: report.eventCount,
        createdBy: user.id,
        expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
      });

      // T-108: the owner must be able to DISCOVER that an anonymous link to
      // their world's history exists (self-echo is dropped by the funnel —
      // the minting owner already knows), and the mint is auditable.
      notify(ctx.notificationStore, {
        recipientId: env.owner_id,
        actorId: user.id,
        envId: env.id,
        kind: NOTIFICATION_KINDS.shareCreated,
        title: t(request.locale, 'chrome.notif.shareCreated', { envName: env.name }),
        body: {
          shareId: share.id,
          name: share.name,
          expiresAt: share.expires_at,
          createdBy: user.id,
          window: { from: input.from, to: input.to },
        },
        refId: share.id,
      });
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'share-create',
        payload: {
          shareId: share.id,
          name: share.name,
          expiresAt: share.expires_at,
          eventCount: report.eventCount,
        },
      });

      return reply.code(201).send({
        shareId: share.id,
        // Relative — the caller knows its own origin (and the server may sit
        // behind a proxy whose Host header would lie about it).
        sharePath: `/share/${share.id}`,
        expiresAt: share.expires_at,
        report,
      });
    },
  );

  // T-108: owner-visible list of live shares — the discovery surface for
  // anonymous links minted on this environment (by the owner OR by any
  // authenticated reader of a public env).
  app.get(
    '/api/environments/:id/replay-shares',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const shares = ctx.shareStore.listForEnv(id, 100).map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        envName: row.env_name,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        eventCount: row.event_count,
        createdBy: row.created_by,
      }));
      return { envId: env.id, shares };
    },
  );

  // T-108: owner-only revocation — the recall lever for an anonymous link.
  // Revoked shares tombstone (not delete): anonymous readers get 410, a
  // deliberate recall, instead of the 404 of a never-existing link.
  app.delete(
    '/api/environments/:id/replay-shares/:shareId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, shareId } = request.params as IdParams & { shareId: string };
      const user = request.user!;
      getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      if (!ctx.shareStore.revoke(id, shareId)) {
        throw new ApiError(
          404,
          'SHARE_NOT_FOUND',
          `No live share "${shareId}" on this environment (unknown id, other env, or already revoked/expired)`,
        );
      }
      ctx.pipeline.log({
        envId: id,
        actorId: user.id,
        kind: 'share-revoke',
        payload: { shareId },
      });
      return reply.code(204).send();
    },
  );

  // The anonymous viewer endpoint — no auth scope on purpose.
  app.get('/api/shares/:shareId', async request => {
    const { shareId } = request.params as { shareId: string };
    const row = ctx.shareStore.peek(shareId);
    if (row === undefined) {
      throw new ApiError(404, 'SHARE_NOT_FOUND', 'This share link does not exist or has expired');
    }
    if (row.revoked_at !== null) {
      throw new ApiError(
        410,
        'SHARE_REVOKED',
        'This share link was revoked by the environment owner and is no longer available',
      );
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      ctx.shareStore.delete(shareId); // lazy prune, same as get()
      throw new ApiError(404, 'SHARE_NOT_FOUND', 'This share link does not exist or has expired');
    }
    const share = row;
    return {
      id: share.id,
      name: share.name,
      description: share.description,
      envName: share.env_name,
      environmentId: share.env_id,
      createdAt: share.created_at,
      expiresAt: share.expires_at,
      eventCount: share.event_count,
      scenario: JSON.parse(share.scenario_json),
    };
  });
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an ISO timestamp`);
  }
  return value;
}
