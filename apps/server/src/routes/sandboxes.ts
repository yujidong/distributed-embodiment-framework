/**
 * Sandbox routes — P-C sandbox forks + P2F fork lifecycle
 * (multi-user-simulation-design.md §3 Layer 0, §10; design-living-worlds.md §10)
 *
 * - `POST /api/environments/:id/sandboxes`  fork the environment into an
 *     isolated sandbox (auth; access follows environment READ semantics:
 *     any member, or anyone when the env is public — same gate as running a
 *     simulation from an environment). Body `{ overlays?: string[],
 *     fromCheckpoint?: boolean }` selects which applied inject-scenario
 *     proposals' events the fork keeps (omitted = the world as-is, `[]` =
 *     pure base layer) and whether the fork copies the authoritative
 *     world's CURRENT dynamics (P2F §10.1 便宜 fork — live session exported
 *     at a clean boundary; hibernated/on-disk checkpoint copied verbatim).
 *     Unknown body fields are rejected 400 (T-001: they used to be dropped
 *     silently).
 * - `GET  /api/environments/:id/sandboxes`  list (same read access): the
 *     environment owner sees every sandbox; anyone else sees their own plus
 *     the ones they JOINED (P2F §10.2 visibility).
 * - `POST /api/sandboxes/:id/stop`          sandbox owner or env owner:
 *     stop the runtime, release the registry instance, mark the row stopped
 *     (idempotent).
 * - `GET  /api/sandboxes/:id/members`       the fork's join roster (fork
 *     owner / env owner / members — the roster is who may see the fork).
 * - `POST /api/sandboxes/:id/members`       fork owner or env owner invites
 *     a builder/viewer (§10.2; the invitee must already be an env member).
 * - `DELETE /api/sandboxes/:id/members/:userId`  remove a member (fork/env
 *     owner, or the member themself — leaving is always allowed).
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import {
  getEnvironmentOrThrow,
  requireObjectMutationAccess,
  requireReadAccess,
} from '../env-access.js';
import { ownerRef } from '../env-serializers.js';
import { parseJsonObject, type EnvironmentStore } from '../db/environment-store.js';
import {
  SANDBOX_MEMBER_ROLES,
  type SandboxMemberRole,
  type SandboxRow,
  type SandboxStore,
} from '../db/sandbox-store.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import type { SandboxService } from '../sandbox-service.js';

export interface SandboxRoutesContext {
  envStore: EnvironmentStore;
  sandboxStore: SandboxStore;
  sandboxService: SandboxService;
  userStore: UserStore;
}

interface IdParams {
  id: string;
}

interface MemberParams {
  id: string;
  userId: string;
}

export function registerSandboxRoutes(app: FastifyInstance, ctx: SandboxRoutesContext): void {
  app.post(
    '/api/environments/:id/sandboxes',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireReadAccess(env, ctx.envStore.roleOf(id, user.id));

      const body = (request.body ?? {}) as Record<string, unknown>;
      // T-001 (DevLoop, silent field drop): every field except "overlays"
      // used to vanish — e.g. {name: "stress-test", speed: 10} forked a
      // nameless sandbox at the default pace with zero signal. Reject
      // unknowns with the accepted list (same pattern as POST /api/
      // simulations) so the caller can self-correct. P2F adds
      // "fromCheckpoint" to the accepted list.
      const knownTopLevel = new Set(['overlays', 'fromCheckpoint']);
      const unknownTopLevel = Object.keys(body).filter(key => !knownTopLevel.has(key));
      if (unknownTopLevel.length > 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Unknown top-level body field${unknownTopLevel.length > 1 ? 's' : ''}: ` +
            `${unknownTopLevel.map(k => `"${k}"`).join(', ')}. ` +
            `Accepted: "overlays", "fromCheckpoint". ` +
            'Note: the sandbox simulation starts in state "created" — set pace etc. on it via ' +
            'POST /api/simulations/:id/start {speed}.',
        );
      }
      let overlays: string[] | undefined;
      if (body.overlays !== undefined) {
        if (
          !Array.isArray(body.overlays) ||
          body.overlays.some(item => typeof item !== 'string' || item.length === 0)
        ) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Body field "overlays" must be an array of non-empty proposal id strings',
          );
        }
        overlays = body.overlays as string[];
      }
      // P2F §10.1: the cheap-fork flag — copy the authoritative world's
      // current dynamics instead of re-freezing the static scenario.
      let fromCheckpoint = false;
      if (body.fromCheckpoint !== undefined) {
        if (typeof body.fromCheckpoint !== 'boolean') {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Body field "fromCheckpoint" must be a boolean (true = fork the world\'s current ' +
              'dynamics from its latest checkpoint/live state, design-living-worlds §10.1)',
          );
        }
        fromCheckpoint = body.fromCheckpoint;
      }

      const row = fromCheckpoint
        ? await ctx.sandboxService.forkFromCheckpoint(env, user, overlays)
        : await ctx.sandboxService.fork(env, user, overlays);
      return reply.code(201).send(sandboxToJson(ctx, row));
    },
  );

  app.get(
    '/api/environments/:id/sandboxes',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireReadAccess(env, ctx.envStore.roleOf(id, user.id));

      // The environment owner sees every sandbox. Anyone else sees their own
      // PLUS the forks they joined (P2F §10.2: "对成员可见自己加入的").
      const isOwner = ctx.envStore.roleOf(id, user.id) === 'owner';
      if (isOwner) {
        const rows = ctx.sandboxStore.listForEnv(id);
        return { sandboxes: rows.map(row => sandboxToJson(ctx, row)) };
      }
      const own = ctx.sandboxStore.listForEnv(id, { ownerId: user.id });
      const joined = ctx.sandboxStore.joinedByUserInEnv(id, user.id);
      const seen = new Set(own.map(row => row.id));
      const rows = [...own, ...joined.filter(row => !seen.has(row.id))];
      return { sandboxes: rows.map(row => sandboxToJson(ctx, row)) };
    },
  );

  app.post('/api/sandboxes/:id/stop', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const sandbox = ctx.sandboxService.getOrThrow(id);
    const env = getEnvironmentOrThrow(ctx.envStore, sandbox.env_id);
    requireObjectMutationAccess(ctx.envStore, env, sandbox.owner_id, user, 'sandbox');

    const row = ctx.sandboxService.stop(sandbox);
    return sandboxToJson(ctx, row);
  });

  // -------------------------------------------------------------------------
  // P2F §10.2: membership join routes
  // -------------------------------------------------------------------------

  app.get('/api/sandboxes/:id/members', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const sandbox = ctx.sandboxService.getOrThrow(id);
    requireForkVisibility(ctx, sandbox, user);
    return { members: memberRowsToJson(ctx, sandbox) };
  });

  app.post('/api/sandboxes/:id/members', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const sandbox = ctx.sandboxService.getOrThrow(id);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const knownTopLevel = new Set(['userId', 'role']);
    const unknownTopLevel = Object.keys(body).filter(key => !knownTopLevel.has(key));
    if (unknownTopLevel.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown top-level body field${unknownTopLevel.length > 1 ? 's' : ''}: ` +
          `${unknownTopLevel.map(k => `"${k}"`).join(', ')}. Accepted: "userId", "role".`,
      );
    }
    if (typeof body.userId !== 'string' || body.userId.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "userId" must be a non-empty user id');
    }
    if (
      typeof body.role !== 'string' ||
      !SANDBOX_MEMBER_ROLES.includes(body.role as SandboxMemberRole)
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "role" must be one of ${SANDBOX_MEMBER_ROLES.map(r => `"${r}"`).join(' | ')} ` +
          '(§10.2 reuses the env_members vocabulary; the fork owner role is implicit)',
      );
    }

    ctx.sandboxService.inviteMember(sandbox, user, body.userId, body.role as SandboxMemberRole);
    return reply.code(201).send({ members: memberRowsToJson(ctx, sandbox) });
  });

  app.delete(
    '/api/sandboxes/:id/members/:userId',
    { preHandler: app.authenticate },
    async request => {
      const { id, userId } = request.params as MemberParams;
      const user = request.user!;
      const sandbox = ctx.sandboxService.getOrThrow(id);
      // Self-leave is always allowed; removing someone else needs owner say-so.
      ctx.sandboxService.removeMember(sandbox, user, userId);
      return { members: memberRowsToJson(ctx, sandbox) };
    },
  );
}

/**
 * §10.2 visibility: the fork's roster surface (and the fork-internal reads
 * it gates) is for the fork owner, the env owner, and joined members — an
 * env member who has not joined sees the authoritative world, not forks.
 */
function requireForkVisibility(
  ctx: SandboxRoutesContext,
  sandbox: SandboxRow,
  user: { id: string },
): void {
  if (ctx.sandboxService.roleInFork(sandbox, user.id) !== undefined) return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Sandbox "${sandbox.id}" is a fork context you have not joined — the fork owner ` +
      '(POST /api/sandboxes/:id/members) or the environment owner can invite you ' +
      '(design-living-worlds §10.2: joining is an explicit action)',
  );
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function sandboxToJson(ctx: SandboxRoutesContext, row: SandboxRow) {
  const user = ctx.userStore.findById(row.owner_id);
  return {
    id: row.id,
    envId: row.env_id,
    // R41-F4: make the fork's world-shape EXPLICIT — a sandbox is a
    // simulation of the PARENT environment, not its own environment.
    // Writes addressed to envId (flows/services/agents) land in the
    // authoritative world; experiment inside the sandbox via its
    // simulationId (commands/what-if) or promote via adopt-config.
    parentEnvironmentId: row.env_id,
    owner: ownerRef(user ? toPublicUser(user) : undefined, row.owner_id),
    forkBase: parseJsonObject(row.fork_base_json) ?? {},
    // P2F §10.4: the machine-checkable lineage (fork/env ids, fork moment,
    // policy, checkpoint identity, scenario fingerprint).
    lineage: ctx.sandboxService.lineageOf(row),
    status: row.status,
    simulationId: row.simulation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function memberRowsToJson(ctx: SandboxRoutesContext, sandbox: SandboxRow) {
  const owner = ctx.userStore.findById(sandbox.owner_id);
  return [
    {
      // The fork owner is an implicit roster member with the owner role.
      userId: sandbox.owner_id,
      role: 'owner' as const,
      user: ownerRef(owner ? toPublicUser(owner) : undefined, sandbox.owner_id),
      invitedBy: null,
      createdAt: sandbox.created_at,
    },
    ...ctx.sandboxStore.membersOf(sandbox.id).map(member => {
      const invitedBy = ctx.userStore.findById(member.invited_by);
      return {
        userId: member.user_id,
        role: member.role,
        user: userRefOf(ctx, member.user_id),
        invitedBy: ownerRef(invitedBy ? toPublicUser(invitedBy) : undefined, member.invited_by),
        createdAt: member.created_at,
      };
    }),
  ];
}

function userRefOf(ctx: SandboxRoutesContext, userId: string) {
  const user = ctx.userStore.findById(userId);
  return ownerRef(user ? toPublicUser(user) : undefined, userId);
}
