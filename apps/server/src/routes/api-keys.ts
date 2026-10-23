/**
 * API-key routes — external-caller credential management (R55).
 *
 * POST   /api/environments/:id/api-keys   create (member of the env); the
 *                                        plaintext secret appears exactly
 *                                        once, in the 201 response
 * GET    /api/environments/:id/api-keys   list own keys (no secrets)
 * DELETE /api/api-keys/:id                revoke
 *
 * A key acts as its owning user, narrowed to the env (and optionally to a
 * single service). The intended consumer is anything OUTSIDE the platform:
 * an existing company service, a script, another platform's agent.
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import type { ApiKeyStore } from '../db/api-key-store.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { ServiceStore } from '../db/service-store.js';

export interface ApiKeyRoutesContext {
  apiKeyStore: ApiKeyStore;
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
}

export function registerApiKeyRoutes(app: FastifyInstance, ctx: ApiKeyRoutesContext): void {
  app.post('/api/environments/:id/api-keys', { preHandler: app.authenticate }, async (request, reply) => {
    const { id: envId } = request.params as { id: string };
    const user = request.user!;
    const env = ctx.envStore.getEnvironment(envId);
    if (!env) throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    if (ctx.envStore.roleOf(envId, user.id) === undefined) {
      throw new ApiError(403, 'FORBIDDEN', 'API keys may only be created by environment members');
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' && body.name.trim().length > 0
      ? body.name.trim().slice(0, 80)
      : '';
    if (name.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "name" must be a non-empty string (the key\'s display name)');
    }
    let serviceId: string | null = null;
    if (body.serviceId !== undefined) {
      if (typeof body.serviceId !== 'string' || body.serviceId.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "serviceId" must be a non-empty string when provided');
      }
      const service = ctx.serviceStore.getService(body.serviceId);
      if (service === undefined || service.env_id !== envId) {
        throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${body.serviceId}" does not exist in environment "${envId}"`);
      }
      serviceId = service.id;
    }
    let ttlDays: number | null = null;
    if (body.ttlDays !== undefined) {
      if (typeof body.ttlDays !== 'number' || !Number.isInteger(body.ttlDays) || body.ttlDays < 1 || body.ttlDays > 3650) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "ttlDays" must be an integer 1–3650 when provided');
      }
      ttlDays = body.ttlDays;
    }

    const { row, plaintext } = ctx.apiKeyStore.createKey({
      userId: user.id,
      envId,
      serviceId,
      name,
      ttlDays,
    });
    return reply.code(201).send({
      id: row.id,
      name: row.name,
      envId: row.env_id,
      serviceId: row.service_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      // The ONLY time the secret is visible — store it now, it is never
      // recoverable from the platform again (SHA-256 at rest).
      key: plaintext,
    });
  });

  app.get('/api/environments/:id/api-keys', { preHandler: app.authenticate }, async request => {
    const { id: envId } = request.params as { id: string };
    const user = request.user!;
    if (ctx.envStore.getEnvironment(envId) === undefined) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    }
    if (ctx.envStore.roleOf(envId, user.id) === undefined) {
      throw new ApiError(403, 'FORBIDDEN', 'API keys are visible to environment members only');
    }
    return {
      keys: ctx.apiKeyStore.listKeys(user.id, envId).map(row => ({
        id: row.id,
        name: row.name,
        envId: row.env_id,
        serviceId: row.service_id,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      })),
    };
  });

  app.delete('/api/api-keys/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    if (!ctx.apiKeyStore.revokeKey(id, user.id)) {
      throw new ApiError(404, 'API_KEY_NOT_FOUND', `No revocable API key "${id}" owned by you`);
    }
    return reply.code(204).send();
  });
}
