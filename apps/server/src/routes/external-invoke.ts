/**
 * External service invocation channel (R55) — opening the ecosystem.
 *
 * POST /api/services/:id/invoke
 * GET  /api/services/:id/openapi.json
 *
 * The agreement lane (POST /api/agreements/:id/invocations) stays the
 * canonical CROSS-ORGANIZATION consumption path (terms/quota/metering).
 * This channel exists so the OUTSIDE world — an existing company service,
 * a script, another platform — can consume an environment's services over
 * plain HTTP with a classic credential:
 *
 * - the provider agent's owner (or env owner/admin) invokes their OWN
 *   service directly — device effect, audited, no agreement needed;
 * - anyone else (JWT user or API key) with an ACTIVE agreement on the
 *   service is delegated to the agreement invocation path — the SAME
 *   metering/quota/reputation tail as the canonical lane;
 * - anyone else gets a 403 that teaches the agreement lane.
 *
 * API keys (`Authorization: Bearer eak_…` or `X-API-Key: eak_…`, see
 * routes/api-keys.ts) resolve to their owning user; a key scoped to one
 * service cannot invoke another.
 *
 * The OpenAPI fragment turns a service into a first-class REST artifact:
 * its interface.actions become a documented POST operation importable by
 * Swagger UI / Postman / code generators.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { executeAgreementInvocation } from '../agreements/invoke-lane.js';
import type { AgreementRoutesContext } from '../agreements/context.js';
import { resolveBackingDeviceForServiceAction } from '../agreements/backing.js';
import { canSeeService } from '../db/service-store.js';
import type { ServiceStore, ServiceInstanceRow } from '../db/service-store.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import type { AgreementStore } from '../db/agreement-store.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import type { SimulationRecord } from '../sim-registry/types.js';
import type { UserStore } from '../db/user-store.js';
import type { ChangePipeline } from '../change-pipeline.js';
import { ApiError } from '../errors.js';
import { canReadEnvironment } from '../env-access.js';
import { mapEngineError, parseInjectEventInput } from './simulations.js';
import { isAdminEmail } from '../auth/admin.js';

export interface ExternalInvokeContext {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  agreementStore: AgreementStore;
  userStore: UserStore;
  pipeline: ChangePipeline;
  registry: SimulationRegistry;
  /** World-session targeting (the authoritative shared-world sim). */
  worldSessions?: { targetFor(envId: string): Promise<SimulationRecord | undefined> };
  adminEmails: string[];
  /**
   * R55: agreement-lane delegation reuses the SAME context the canonical
   * route runs with (metering, settlement, reputation, notifications —
   * the tail must not drift between the two entry points).
   */
  agreementRoutes: AgreementRoutesContext;
  /** R56: webhook event delivery wait bound (T-023 parity). */
  eventDeliveryDeadlineMs: number;
}

interface ScopedRequest extends FastifyRequest {
  apiKeyScope?: { envId: string; serviceId: string | null };
}

export function registerExternalInvokeRoutes(app: FastifyInstance, ctx: ExternalInvokeContext): void {
  app.post('/api/services/:id/invoke', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const service = ctx.serviceStore.getService(id);
    if (service === undefined) {
      throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
    }

    // API-key scope: a key narrowed to one service may only invoke that one.
    const scope = (request as ScopedRequest).apiKeyScope;
    if (scope !== undefined) {
      if (scope.envId !== service.env_id || (scope.serviceId !== null && scope.serviceId !== service.id)) {
        throw new ApiError(
          403,
          'API_KEY_SCOPE',
          `This API key is scoped to ${scope.serviceId !== null ? `service ${scope.serviceId}` : `environment ${scope.envId}`} — it cannot invoke service ${service.id}`,
        );
      }
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const action = typeof body.action === 'string' && body.action.length > 0 ? body.action : '';
    if (action.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "action" must be a non-empty string (see the service interface)');
    }
    if (body.params !== undefined && (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "params" must be an object when provided');
    }
    const params = body.params as Record<string, unknown> | undefined;
    const simulationId = typeof body.simulationId === 'string' && body.simulationId.length > 0
      ? body.simulationId
      : undefined;

    // Authorization: own service → direct; active agreement → delegate; else teach.
    const providerAgent = ctx.envStore.getAgent(service.provider_agent_id);
    const envOwner = ctx.envStore.getEnvironment(service.env_id)?.owner_id;
    const admin = isAdminEmail(user.email, ctx.adminEmails);
    const ownsService =
      admin ||
      (providerAgent !== undefined && providerAgent.owner_id === user.id) ||
      envOwner === user.id;

    if (!ownsService) {
      // Delegate to the caller's ACTIVE agreement on this exact service —
      // the metered tail is identical to the canonical lane.
      const active = ctx.agreementStore
        .agreementsOfEnv(service.env_id)
        .find(agreement =>
          agreement.service_id === service.id &&
          agreement.status === 'active' &&
          agreement.consumer_owner_id === user.id);
      if (active === undefined) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          `Service "${service.name}" belongs to another organization — invoke it through an active agreement: ` +
          'propose one (POST /api/services/{id}/agreements), have the provider accept ' +
          '(POST /api/agreements/{agreementId}/decide), then invoke here or via the canonical lane ' +
          '(POST /api/agreements/{agreementId}/invocations). The service provider may also mint you an ' +
          'API key scoped to this service (POST /api/environments/{envId}/api-keys).',
        );
      }
      const record = await resolveRuntime(ctx, service, simulationId, user.id);
      const outcome = await executeAgreementInvocation(ctx.agreementRoutes, {
        agreement: active,
        terms: JSON.parse(active.terms_json ?? '{}') as Record<string, never>,
        runtime: record.runtime,
        simulationId: record.id,
        action,
        ...(params !== undefined ? { params } : {}),
        actor: { userId: user.id },
      });
      return reply.code(200).send({ lane: 'agreement', agreementId: active.id, ...outcome as object });
    }

    // Direct execution (own service). Flow services stay on the agreement
    // lane for now (their execution model is a metered flow run).
    if (service.origin === 'flow') {
      throw new ApiError(
        409,
        'FLOW_SERVICE_LANE',
        `Service "${service.name}" is flow-backed — flow runs are executed through the agreement lane ` +
        '(POST /api/agreements/:id/invocations) so the run is metered and attributable',
      );
    }

    const record = await resolveRuntime(ctx, service, simulationId, user.id);
    const runtime = record.runtime;
    const deviceId = resolveBackingDeviceForServiceAction(ctx as never, service, action);
    const present = runtime.getSnapshot().devices.some(device => device.id === deviceId);
    if (!present) {
      throw new ApiError(
        409,
        'SERVICE_NOT_BACKED',
        `The backing device of service "${service.name}" is not present in the running simulation ` +
        '— restart the simulation or pass body.simulationId of one that carries it',
      );
    }
    const before = runtime.getSnapshot().devices.find(device => device.id === deviceId)?.state ?? null;
    const invocationActor = `service-invoke:${user.displayName ?? user.id}`;
    const outcome = await runtime.executeDeviceCommand(deviceId, action, params ?? {}, {
      actor: invocationActor,
    });
    const after = runtime.getSnapshot().devices.find(device => device.id === deviceId)?.state ?? null;

    // Audit: same replay-consumable shape as the other command lanes, with
    // the lane visible in the payload.
    ctx.pipeline.log({
      envId: service.env_id,
      actorId: user.id,
      kind: 'device-command',
      payload: {
        deviceId,
        commandName: action,
        ...(params !== undefined ? { params } : {}),
        lane: 'service-direct-invoke',
        serviceId: service.id,
        before,
        after,
      },
      simTime: runtime.getSimTimeSec(),
    });

    const success = outcome.success === true;
    return reply.code(success ? 200 : 502).send({
      lane: 'direct',
      serviceId: service.id,
      deviceId,
      action,
      success,
      ...(success ? {} : { error: outcome.error ?? 'command failed' }),
      result: outcome.result ?? null,
    });
  });

  app.get('/api/services/:id/openapi.json', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as { id: string };
    const service = ctx.serviceStore.getService(id);
    if (service === undefined) {
      throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
    }
    // Visibility gate — same rule as the service detail read.
    const env = ctx.envStore.getEnvironment(service.env_id)!;
    const viewer = { userId: request.user?.id ?? null, role: request.user ? ctx.envStore.roleOf(env.id, request.user.id) : undefined };
    const providerAgent = ctx.envStore.getAgent(service.provider_agent_id);
    if (
      !canSeeService(service.visibility, providerAgent?.owner_id ?? '', env, viewer, {
        accessGrant: false,
        origin: service.origin,
      }) &&
      request.user !== null &&
      !canReadEnvironment(env, viewer.role)
    ) {
      throw new ApiError(403, 'FORBIDDEN', `Service "${service.name}" is not visible to you`);
    }
    return openApiFragmentOf(service, request.protocol + '://' + (request.headers.host ?? 'localhost:8100'));
  });

  // R56 — the INBOUND channel: an external system pushes an event into the
  // world. Same parser, same runtime lane as the canonical
  // POST /api/simulations/:id/events (one contract); the credential is an
  // API key scoped to the environment (service-scoped keys are refused —
  // they are for their one service, not for world writes).
  app.post('/api/environments/:id/webhook-events', { preHandler: app.authenticate }, async (request, reply) => {
    const { id: envId } = request.params as { id: string };
    const user = request.user!;
    const env = ctx.envStore.getEnvironment(envId);
    if (env === undefined) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    }
    const scope = (request as ScopedRequest).apiKeyScope;
    if (scope !== undefined) {
      if (scope.envId !== envId) {
        throw new ApiError(
          403,
          'API_KEY_SCOPE',
          `This API key is scoped to environment ${scope.envId} — it cannot push events into ${envId}`,
        );
      }
      if (scope.serviceId !== null) {
        throw new ApiError(
          403,
          'API_KEY_SCOPE',
          'This API key is scoped to a single SERVICE — event pushes need an environment-scoped key',
        );
      }
    }
    const role = ctx.envStore.roleOf(envId, user.id);
    if (role !== 'owner' && role !== 'builder') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        `Webhook event pushes require role "builder" | "owner" in environment "${env.name}" — ` +
        'mint an environment-scoped API key for the external system (POST /api/environments/{envId}/api-keys)',
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const simulationId = typeof body.simulationId === 'string' && body.simulationId.length > 0
      ? body.simulationId
      : undefined;
    const record = await resolveRuntime(ctx, { env_id: envId } as never, simulationId, user.id);
    const input = parseInjectEventInput(body);
    try {
      // T-023 parity: the physical write + flow evaluation are applied when
      // the bound fires; 202 decisionPending is the honest external answer.
      const result = await record.runtime.injectEvent(input, {
        ...(ctx.eventDeliveryDeadlineMs > 0
          ? { deliveryDeadlineMs: ctx.eventDeliveryDeadlineMs }
          : {}),
      });
      ctx.pipeline.log({
        envId,
        actorId: user.id,
        kind: 'webhook-event',
        payload: {
          simulationId: record.id,
          eventId: result.eventId,
          type: input.type,
          zoneId: input.zoneId,
          lane: scope !== undefined ? 'api-key' : 'jwt',
        },
        simTime: record.runtime.getSimTimeSec(),
      });
      if (result.decisionPending) {
        return reply.code(202).send(result);
      }
      return result;
    } catch (error) {
      throw mapEngineError(error);
    }
  });
}

/** Resolve the sim an external call targets: explicit id → world session →
 * the env's active sim → 409 teaching. Shared by invoke + webhook events. */
export async function resolveRuntime(
  ctx: ExternalInvokeContext,
  service: ServiceInstanceRow,
  simulationId: string | undefined,
  userId: string,
): Promise<SimulationRecord> {
  if (simulationId !== undefined) {
    const record = ctx.registry.getLiveOrThrow(simulationId);
    if (record.environmentId !== service.env_id) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Simulation "${simulationId}" does not run environment ${service.env_id}`,
      );
    }
    return record;
  }
  const session = await ctx.worldSessions?.targetFor(service.env_id);
  if (session !== undefined) return session;
  throw new ApiError(
    409,
    'NO_TARGET_SIMULATION',
    `No running simulation to invoke into for environment ${service.env_id} ` +
      '— start one (POST /api/simulations + /start), or pass body.simulationId explicitly',
  );
}

/** The per-service OpenAPI 3.1 fragment: interface.actions → one POST. */
function openApiFragmentOf(service: ServiceInstanceRow, baseUrl: string): Record<string, unknown> {
  const iface = JSON.parse(service.interface_json || '{}') as {
    actions?: Array<{ name: string; parameters?: Record<string, unknown> }>;
  };
  const actions = iface.actions ?? [];
  const actionNames = actions.map(entry => entry.name);
  const paramSchemas: Record<string, unknown> = {};
  for (const entry of actions) {
    if (entry.parameters !== undefined && Object.keys(entry.parameters).length > 0) {
      paramSchemas[entry.name] = { type: 'object', properties: entry.parameters };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: `${service.name} (EAF service)`,
      version: '1.0.0',
      description:
        `${service.description || service.semantic_type}\n\n` +
        'An Embodied Agent Framework service: POST /api/services/{id}/invoke executes ' +
        'an action on the provider agent\'s device with real world effect. ' +
        'Authenticate as a platform user (Bearer JWT) or with an API key ' +
        '(Bearer eak_… / X-API-Key) minted via POST /api/environments/{envId}/api-keys. ' +
        'Cross-organization use requires an active agreement.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      [`/api/services/${service.id}/invoke`]: {
        post: {
          operationId: `invoke_${service.semantic_type}`,
          summary: `Invoke ${service.name}`,
          security: [{ ApiKeyAuth: [] }, { bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action'],
                  properties: {
                    action: { type: 'string', enum: actionNames.length > 0 ? actionNames : undefined },
                    params: {
                      oneOf: [
                        { type: 'object' },
                        ...(Object.keys(paramSchemas).length > 0 ? Object.values(paramSchemas) : []),
                      ],
                    },
                    simulationId: { type: 'string', description: 'Optional: target a specific running simulation' },
                  },
                },
                examples: Object.fromEntries(
                  actions.map(entry => [
                    entry.name,
                    {
                      value: {
                        action: entry.name,
                        ...(Object.keys(entry.parameters ?? {}).length > 0
                          ? { params: Object.fromEntries(Object.keys(entry.parameters!).map(key => [key, null])) }
                          : {}),
                      },
                    },
                  ]),
                ),
              },
            },
          },
          responses: {
            '200': { description: 'Executed (direct lane) or metered agreement invocation' },
            '403': { description: 'Cross-organization invoke without an active agreement (the body teaches the lane)' },
            '409': { description: 'No backing device / no target simulation / flow-service lane' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}
