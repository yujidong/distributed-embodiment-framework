/**
 * External event source routes (R58) — the subscription registry.
 *
 * POST   /api/environments/:id/event-sources        register (member)
 * GET    /api/environments/:id/event-sources        list (+ health)
 * PATCH  /api/event-sources/:id                     edit (interval/mapping/enabled…)
 * DELETE /api/event-sources/:id                     remove
 * POST   /api/event-sources/:id/poll-now            manual poll (test/sos)
 *
 * The background poller picks sources up by interval; poll-now runs the
 * same pollOnce for immediate feedback.
 */

import type { FastifyInstance } from 'fastify';

import { ApiError } from '../errors.js';
import type { ExternalEventSourceStore } from '../external-events/source-store.js';
import { pollOnce, type PollerContext } from '../external-events/poller.js';
import type { EnvironmentStore } from '../db/environment-store.js';

export interface EventSourceRoutesContext extends PollerContext {
  envStore: EnvironmentStore;
  sources: ExternalEventSourceStore;
}

function publicView(row: {
  id: string; env_id: string; name: string; url: string; poll_interval_sec: number;
  enabled: number; last_poll_at: string | null; last_status: string | null;
  last_error: string | null; last_injected: number; created_at: string;
  mapping_json: string;
}) {
  let mapping: unknown = {};
  try { mapping = JSON.parse(row.mapping_json); } catch { /* keep {} */ }
  return {
    id: row.id, envId: row.env_id, name: row.name, url: row.url,
    pollIntervalSec: row.poll_interval_sec, enabled: row.enabled === 1,
    mapping, lastPollAt: row.last_poll_at, lastStatus: row.last_status,
    lastError: row.last_error, lastInjected: row.last_injected, createdAt: row.created_at,
  };
}

export function registerEventSourceRoutes(app: FastifyInstance, ctx: EventSourceRoutesContext): void {
  app.post('/api/environments/:id/event-sources', { preHandler: app.authenticate }, async (request, reply) => {
    const { id: envId } = request.params as { id: string };
    const user = request.user!;
    const env = ctx.envStore.getEnvironment(envId);
    if (env === undefined) throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    const role = ctx.envStore.roleOf(envId, user.id);
    if (role !== 'owner' && role !== 'builder') {
      throw new ApiError(403, 'FORBIDDEN', 'Event sources are managed by environment builders/owners');
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim().slice(0, 80) : '';
    if (name.length === 0) throw new ApiError(400, 'BAD_REQUEST', 'Body field "name" must be a non-empty string');
    let url: URL;
    if (typeof body.url !== 'string' || body.url.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "url" must be a non-empty string');
    }
    try {
      url = new URL(body.url);
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "url" is not a valid URL: ${body.url}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "url" must be http(s)');
    }
    const pollIntervalSec = body.pollIntervalSec === undefined ? 60 : body.pollIntervalSec;
    if (typeof pollIntervalSec !== 'number' || !Number.isInteger(pollIntervalSec) || pollIntervalSec < 10 || pollIntervalSec > 86_400) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "pollIntervalSec" must be an integer 10–86400');
    }
    if (body.authHeaders !== undefined && (typeof body.authHeaders !== 'object' || body.authHeaders === null || Array.isArray(body.authHeaders))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "authHeaders" must be an object (header name → value) when provided');
    }
    if (body.mapping !== undefined && (typeof body.mapping !== 'object' || body.mapping === null || Array.isArray(body.mapping))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapping" must be an object when provided');
    }
    const row = ctx.sources.createSource({
      envId,
      name,
      url: url.toString(),
      pollIntervalSec,
      authHeaders: (body.authHeaders as Record<string, string> | undefined) ?? {},
      mapping: (body.mapping as Record<string, unknown> | undefined) ?? {},
    });
    return reply.code(201).send(publicView(row));
  });

  app.get('/api/environments/:id/event-sources', { preHandler: app.authenticate }, async request => {
    const { id: envId } = request.params as { id: string };
    const user = request.user!;
    if (ctx.envStore.getEnvironment(envId) === undefined) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    }
    if (ctx.envStore.roleOf(envId, user.id) === undefined) {
      throw new ApiError(403, 'FORBIDDEN', 'Event sources are visible to environment members only');
    }
    return { sources: ctx.sources.sourcesOfEnv(envId).map(publicView) };
  });

  app.patch('/api/event-sources/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const existing = ctx.sources.getSource(id);
    if (existing === undefined) throw new ApiError(404, 'EVENT_SOURCE_NOT_FOUND', `Event source "${id}" not found`);
    if (ctx.envStore.roleOf(existing.env_id, user.id) === undefined) {
      throw new ApiError(403, 'FORBIDDEN', 'Event sources are managed by environment members');
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<ExternalEventSourceStore['updateSource']>[1] = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "name" must be a non-empty string');
      }
      patch.name = body.name.trim().slice(0, 80);
    }
    if (body.url !== undefined) {
      if (typeof body.url !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'Body field "url" must be a string');
      try {
        const parsed = new URL(body.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
        patch.url = parsed.toString();
      } catch {
        throw new ApiError(400, 'BAD_REQUEST', `Body field "url" is not a valid http(s) URL: ${body.url}`);
      }
    }
    if (body.pollIntervalSec !== undefined) {
      if (typeof body.pollIntervalSec !== 'number' || !Number.isInteger(body.pollIntervalSec) || body.pollIntervalSec < 10 || body.pollIntervalSec > 86_400) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "pollIntervalSec" must be an integer 10–86400');
      }
      patch.poll_interval_sec = body.pollIntervalSec;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'BAD_REQUEST', 'Body field "enabled" must be a boolean');
      patch.enabled = body.enabled ? 1 : 0;
    }
    if (body.mapping !== undefined) {
      if (typeof body.mapping !== 'object' || body.mapping === null || Array.isArray(body.mapping)) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapping" must be an object');
      }
      patch.mapping_json = JSON.stringify(body.mapping);
    }
    ctx.sources.updateSource(id, patch);
    return publicView(ctx.sources.getSource(id)!);
  });

  app.delete('/api/event-sources/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const existing = ctx.sources.getSource(id);
    if (existing === undefined || ctx.envStore.roleOf(existing.env_id, user.id) === undefined) {
      throw new ApiError(404, 'EVENT_SOURCE_NOT_FOUND', `No event source "${id}" you may delete`);
    }
    ctx.sources.deleteSource(id);
    return reply.code(204).send();
  });

  app.post('/api/event-sources/:id/poll-now', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const existing = ctx.sources.getSource(id);
    if (existing === undefined) throw new ApiError(404, 'EVENT_SOURCE_NOT_FOUND', `Event source "${id}" not found`);
    if (ctx.envStore.roleOf(existing.env_id, user.id) === undefined) {
      throw new ApiError(403, 'FORBIDDEN', 'Event sources are managed by environment members');
    }
    const result = await pollOnce(ctx, existing);
    return { ...result, source: publicView(ctx.sources.getSource(id)!) };
  });
}
