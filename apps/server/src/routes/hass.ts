/**
 * Home Assistant routes — connection status + entity preview (P3a) and the
 * actuation safety API (P3b):
 *
 * - `GET /api/hass/status`    auth; `{ configured, state, entityCount? }`.
 *                             Never errors on an unconfigured/down HA — it
 *                             REPORTS the state ('unconfigured' /
 *                             'disconnected' / 'connecting' / 'ready').
 * - `GET /api/hass/entities`  auth; the live entity list with the
 *                             capabilities each entity would expose as an
 *                             HADevice (deployment-UI preview). Filters:
 *                             `?domain=` (exact HA domain) and `?q=`
 *                             (substring on entity id / friendly name).
 *                             503 HASS_NOT_CONFIGURED when HASS_URL/HASS_TOKEN
 *                             are unset; 503 HASS_CONNECT_FAILED when HA is
 *                             unreachable.
 *
 * Safety (P3b) — see hass/safety-gate.ts for the evaluation order:
 * - `GET    /api/hass/policies`        auth; every policy (global + env).
 * - `POST   /api/hass/policies`        auth; create. Global policies (no
 *                                      envId) require an ADMIN_EMAILS caller;
 *                                      env-scoped policies require the env
 *                                      OWNER role. Read stays open to any
 *                                      authenticated user (transparency).
 * - `DELETE /api/hass/policies/:id`    auth; same write rule as POST, by the
 *                                      row's own scope.
 * - `GET    /api/hass/pending`         auth; parked commands awaiting a
 *                                      decision (stale ones lazily expired).
 * - `POST   /api/hass/pending/:id/approve`  auth; marks approved, then
 *                                      re-dispatches the command through the
 *                                      normal engine path (gate bypass — the
 *                                      approval IS the decision; E-stop still
 *                                      wins). Response carries the engine's
 *                                      execution result.
 * - `POST   /api/hass/pending/:id/reject`   auth; bins it — never executed.
 * - `GET    /api/hass/audit`           auth; newest-first audit feed,
 *                                      `?entity=&sim=&limit=` (≤200, def. 50).
 * - `GET    /api/hass/estop`           auth; `{ active, by?, at? }`.
 * - `POST   /api/hass/estop`           auth; ANY authenticated user — the
 *                                      button is designed to be easy to hit.
 * - `DELETE /api/hass/estop`           auth; clears it (server log records
 *                                      who cleared).
 *
 * Approve/reject are deliberately open to any authenticated user in v1: the
 * pending queue is the human-in-the-loop console, and the audit trail keeps
 * every decision attributable. Tighter scoping (env-owner-only approvals) is
 * a documented future hardening step.
 *
 * Reverse sync (HIL P1, hass/reverse-sync.ts) — reality → simulation
 * snapshot alignment for hass://-bound devices:
 * - `GET  /api/hass/reverse-sync`            auth; policy + E-stop + the
 *                                            CURRENT drift (stored sim value
 *                                            vs live hass value, no write) +
 *                                            recent alignments — scoped by
 *                                            the device-privacy FULL tier
 *                                            (admin / env owner / device
 *                                            owner).
 * - `PUT  /api/hass/reverse-sync`            auth; set the alignment policy
 *                                            (`disabled` | `manual` | `live`;
 *                                            ADMIN_EMAILS only — the policy
 *                                            is server-wide).
 * - `POST /api/hass/reverse-sync/align-now`  auth; one manual snapshot
 *                                            alignment of every bound device
 *                                            the caller is full-tier on.
 *                                            409 REVERSE_SYNC_DISABLED when
 *                                            the policy is `disabled`, 409
 *                                            ESTOP_ACTIVE while the emergency
 *                                            stop is engaged (same gate as
 *                                            forward actuation).
 *
 * Shadow worlds (HIL P2, hass/shadow-service.ts) — an observation-driven
 * sandbox fork per environment with hass:// bindings:
 * - `POST   /api/environments/:id/shadow`  auth; create the shadow fork
 *                                          (201). Body: `{"refresh": true}`
 *                                          re-forks an existing shadow (200),
 *                                          `{"fromCheckpoint": true}` forks
 *                                          the authoritative world's current
 *                                          dynamics instead of the base
 *                                          layer. FULL tier only (env owner /
 *                                          admin). 409 SHADOW_EXISTS /
 *                                          SHADOW_NO_BOUND_DEVICES.
 * - `GET    /api/environments/:id/shadow`  auth; fork id, sim clock, per-
 *                                          device observation + actuation-
 *                                          discard counters, recent
 *                                          observations with their
 *                                          (predicted, observed) residuals.
 *                                          404 SHADOW_NOT_FOUND.
 * - `DELETE /api/environments/:id/shadow`  auth; stop the fork (204).
 */

import type { FastifyInstance } from 'fastify';

import type { EnvironmentStore } from '../db/environment-store.js';
import { isAdminEmail } from '../auth/admin.js';
import { ApiError } from '../errors.js';
import {
  REVERSE_SYNC_POLICIES,
  type HassReverseSyncService,
  type ReverseSyncPolicy,
} from '../hass/reverse-sync.js';
import type { HASService } from '../hass/service.js';
import {
  POLICY_EFFECTS,
  runApprovedActuation,
  type HassAuditRow,
  type HassPendingRow,
  type HassPolicyRow,
  type HassSafetyGate,
  type PolicyEffect,
} from '../hass/safety-gate.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import type { HassShadowService } from '../hass/shadow-service.js';

export interface HassRoutesContext {
  hass: HASService;
  gate: HassSafetyGate;
  envStore: EnvironmentStore;
  /** Emails (lowercase) allowed to write GLOBAL policies. */
  adminEmails: string[];
  registry: SimulationRegistry;
  /** HIL P1 reverse mapping (snapshot alignment). */
  reverseSync: HassReverseSyncService;
  /** HIL P2 reverse mapping (shadow worlds). */
  shadow: HassShadowService;
}

interface IdParams {
  id: string;
}

export function registerHassRoutes(app: FastifyInstance, ctx: HassRoutesContext): void {
  app.get('/api/hass/status', { preHandler: app.authenticate }, async () => ctx.hass.status());

  app.get('/api/hass/entities', { preHandler: app.authenticate }, async request => {
    const query = request.query as Record<string, unknown>;
    const domain = optionalQueryString(query.domain, 'domain');
    const q = optionalQueryString(query.q, 'q');
    const entities = await ctx.hass.listEntities({
      ...(domain !== undefined ? { domain } : {}),
      ...(q !== undefined ? { q } : {}),
    });
    return { entities };
  });

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  app.get('/api/hass/policies', { preHandler: app.authenticate }, async () => ({
    policies: ctx.gate.listPolicies().map(policyToJson),
  }));

  app.post('/api/hass/policies', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const entityPattern = requireNonEmptyString(body.entityPattern, 'entityPattern');
    const effect = requireEffect(body.effect);
    const envId = body.envId === undefined || body.envId === null
      ? null
      : requireNonEmptyString(body.envId, 'envId');

    requirePolicyWriteAccess(ctx, envId, user.id, user.email);

    const row = ctx.gate.createPolicy({
      envId,
      entityPattern,
      effect,
      createdBy: user.id,
    });
    return reply.code(201).send(policyToJson(row));
  });

  app.delete('/api/hass/policies/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const existing = ctx.gate.getPolicy(id);
    if (!existing) {
      throw new ApiError(404, 'POLICY_NOT_FOUND', `Policy "${id}" not found`);
    }
    requirePolicyWriteAccess(ctx, existing.env_id, user.id, user.email);
    ctx.gate.deletePolicy(id);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Pending confirmations
  // -------------------------------------------------------------------------

  app.get('/api/hass/pending', { preHandler: app.authenticate }, async () => ({
    pending: ctx.gate.listPending().map(pendingToJson),
  }));

  app.post(
    '/api/hass/pending/:id/approve',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const user = request.user!;

      // Pre-checks BEFORE the status flips: a parked command whose sim is
      // gone/stopped cannot be re-dispatched, so it stays actionable instead
      // of being marked approved-but-never-executed.
      const parked = ctx.gate.getPending(id);
      if (!parked) {
        throw new ApiError(404, 'PENDING_NOT_FOUND', `Pending command "${id}" not found`);
      }
      const record = ctx.registry.get(parked.sim_id);
      if (!record) {
        throw new ApiError(
          409,
          'SIMULATION_UNAVAILABLE',
          `Simulation "${parked.sim_id}" is not running in this server process`,
        );
      }
      if (record.runtime.getState() === 'stopped') {
        throw new ApiError(
          409,
          'SIMULATION_STOPPED',
          `Simulation "${parked.sim_id}" is stopped — the parked command cannot execute`,
        );
      }

      const approved = ctx.gate.approve(id, user.id);
      const params = JSON.parse(approved.params_json) as Record<string, unknown>;
      const execution = await runApprovedActuation(approved.id, user.id, () =>
        record.runtime.executeDeviceCommand(
          approved.device_id,
          approved.command_name,
          params,
        ),
      );
      return { ...pendingToJson(approved), execution };
    },
  );

  app.post(
    '/api/hass/pending/:id/reject',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as IdParams;
      const row = ctx.gate.reject(id, request.user!.id);
      return pendingToJson(row);
    },
  );

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  app.get('/api/hass/audit', { preHandler: app.authenticate }, async request => {
    const query = request.query as Record<string, unknown>;
    const entity = optionalQueryString(query.entity, 'entity');
    const sim = optionalQueryString(query.sim, 'sim');
    const limit = query.limit === undefined ? undefined : parseLimit(query.limit);
    const audit = ctx.gate.listAudit({
      ...(entity !== undefined ? { entity } : {}),
      ...(sim !== undefined ? { sim } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { audit: audit.map(auditToJson) };
  });

  // -------------------------------------------------------------------------
  // Emergency stop
  // -------------------------------------------------------------------------

  app.get('/api/hass/estop', { preHandler: app.authenticate }, async () => ctx.gate.estopState());

  app.post('/api/hass/estop', { preHandler: app.authenticate }, async request => {
    const state = ctx.gate.engageEstop(request.user!.id);
    request.log.warn({ userId: request.user!.id }, 'HA emergency stop ENGAGED');
    return state;
  });

  app.delete('/api/hass/estop', { preHandler: app.authenticate }, async request => {
    const state = ctx.gate.clearEstop(request.user!.id);
    request.log.warn({ userId: request.user!.id }, 'HA emergency stop CLEARED');
    return state;
  });

  // -------------------------------------------------------------------------
  // Reverse sync (HIL P1)
  // -------------------------------------------------------------------------

  app.get('/api/hass/reverse-sync', { preHandler: app.authenticate }, async request => {
    const user = request.user!;
    return ctx.reverseSync.statusFor(user.id, isAdminEmail(user.email, ctx.adminEmails));
  });

  app.put('/api/hass/reverse-sync', { preHandler: app.authenticate }, async request => {
    const user = request.user!;
    if (!isAdminEmail(user.email, ctx.adminEmails)) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'The reverse-sync policy is server-wide — only server admins (ADMIN_EMAILS) can change it',
      );
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const policy = requireReverseSyncPolicy(body.policy);
    ctx.reverseSync.setPolicy(policy, user.id);
    return ctx.reverseSync.statusFor(user.id, true);
  });

  app.post(
    '/api/hass/reverse-sync/align-now',
    { preHandler: app.authenticate },
    async request => {
      const user = request.user!;
      return ctx.reverseSync.alignNow(user.id, isAdminEmail(user.email, ctx.adminEmails));
    },
  );

  // -------------------------------------------------------------------------
  // Shadow worlds (HIL P2)
  // -------------------------------------------------------------------------

  app.post('/api/environments/:id/shadow', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    requireShadowAccess(ctx, id, user.id, user.email);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const refresh = optionalBoolean(body.refresh, 'refresh') ?? false;
    const fromCheckpoint = optionalBoolean(body.fromCheckpoint, 'fromCheckpoint') ?? false;
    const status = await ctx.shadow.create(id, user, { refresh, fromCheckpoint });
    return reply.code(refresh ? 200 : 201).send(status);
  });

  app.get('/api/environments/:id/shadow', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    requireShadowAccess(ctx, id, user.id, user.email);
    return ctx.shadow.status(id);
  });

  app.delete('/api/environments/:id/shadow', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    requireShadowAccess(ctx, id, user.id, user.email);
    await ctx.shadow.destroy(id);
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function policyToJson(row: HassPolicyRow) {
  return {
    id: row.id,
    envId: row.env_id,
    entityPattern: row.entity_pattern,
    effect: row.effect,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function pendingToJson(row: HassPendingRow) {
  return {
    id: row.id,
    simId: row.sim_id,
    deviceId: row.device_id,
    entityId: row.entity_id,
    commandName: row.command_name,
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    status: row.status,
  };
}

function auditToJson(row: HassAuditRow) {
  return {
    id: row.id,
    simId: row.sim_id,
    entityId: row.entity_id,
    command: row.command,
    decision: row.decision,
    reason: row.reason,
    userId: row.user_id,
    at: row.at,
  };
}

// ---------------------------------------------------------------------------
// Validation / authz helpers
// ---------------------------------------------------------------------------

/**
 * Write rule: global policies (envId null) → ADMIN_EMAILS callers only;
 * env-scoped policies → the environment's OWNER role. Reading stays open to
 * every authenticated user.
 */
function requirePolicyWriteAccess(
  ctx: HassRoutesContext,
  envId: string | null,
  userId: string,
  userEmail: string,
): void {
  if (envId === null) {
    if (!isAdminEmail(userEmail, ctx.adminEmails)) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Global safety policies can only be written by server admins (ADMIN_EMAILS)',
      );
    }
    return;
  }
  const env = ctx.envStore.getEnvironment(envId);
  if (!env) {
    throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
  }
  if (ctx.envStore.roleOf(envId, userId) !== 'owner') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only the owner of environment "${envId}" can write its safety policies`,
    );
  }
}

/**
 * Shadow-world access (HIL P2): the FULL tier for an environment-scoped
 * resource — a server admin or the environment OWNER. The status carries
 * entity ids and real telemetry of every bound device (原则 B), and
 * create/destroy forks worlds, so members/visitors get neither.
 */
function requireShadowAccess(
  ctx: HassRoutesContext,
  envId: string,
  userId: string,
  userEmail: string,
): void {
  const env = ctx.envStore.getEnvironment(envId);
  if (!env) {
    throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
  }
  if (isAdminEmail(userEmail, ctx.adminEmails)) return;
  if (ctx.envStore.roleOf(envId, userId) !== 'owner') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only the owner of environment "${envId}" (or a server admin) can manage its shadow world`,
    );
  }
}

/** Optional boolean body field: undefined when absent, 400 when non-boolean. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a boolean`);
  }
  return value;
}

function requireEffect(value: unknown): PolicyEffect {  if (typeof value !== 'string' || !POLICY_EFFECTS.includes(value as PolicyEffect)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "effect" must be one of ${POLICY_EFFECTS.map(e => `"${e}"`).join(' | ')}`,
    );
  }
  return value as PolicyEffect;
}

function requireReverseSyncPolicy(value: unknown): ReverseSyncPolicy {
  if (typeof value !== 'string' || !REVERSE_SYNC_POLICIES.includes(value as ReverseSyncPolicy)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "policy" must be one of ${REVERSE_SYNC_POLICIES.map(p => `"${p}"`).join(' | ')}`,
    );
  }
  return value as ReverseSyncPolicy;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

/** Optional query param: undefined when absent, 400 when empty/non-string. */
function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be a non-empty string`);
  }
  return value;
}

function parseLimit(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError(400, 'BAD_REQUEST', 'Query "limit" must be a positive integer');
  }
  return n;
}
