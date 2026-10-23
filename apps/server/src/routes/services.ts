/**
 * Service routes — the cross-owner visibility boundary (W3)
 *
 * - `GET    /api/environments/:id/services`           list the env's service
 *     offers, filtered by the caller's visibility rights (public → anyone
 *     who may read the env, members → members, hidden → provider owner + env
 *     owner). Query filters: semanticType / provider / origin / q (Fix-20
 *     full-text + Wave-1a CJK matching: Latin tokens are case-insensitive
 *     substrings, CJK tokens match as in-order character subsequences over
 *     name/description/semantic type, composable with the exact filters).
 * - `POST   /api/environments/:id/agents/:agentId/services`
 *     publish an explicit offer (agent owner or env owner; origin='published').
 * - `PATCH  /api/services/:id`  published: full edit by the agent/env owner;
 *     derived: visibility toggle only (anything else → 409).
 * - `DELETE /api/services/:id`  published only (derived → 409 — they are
 *     managed by the derivation sync).
 * - `GET    /api/services/:id`  one offer by id (Fix-10), same visibility
 *     boundary as the list: invisible offers answer 404 like unknown ids.
 * - `PUT    /api/services/:id/subscribe` / `DELETE /api/services/:id/subscribe`
 *     (W5) personal "我依赖的服务" bookmarks — idempotent; invisible offers
 *     answer 404 like unknown ids. A POST here is a common wrong guess and
 *     answers 405 + `Allow: PUT, DELETE` instead of a bare 404 (Fix-10).
 * - `GET    /api/environments/:id/agents/:agentId/reputation`
 *     (P4-1) the agent's learned per-capability track record in this env.
 * - `POST   /api/environments/:id/asks` / `GET …/asks` /
 *     `DELETE …/asks/:askId` — the standing-ask 需求板 (T-069, R19 NW-F04,
 *     design-data-services.md §11): a member's persisted demand for a
 *     FUTURE counterpart asset. Member-only surface (not on the world
 *     stream); service 'created' events match open asks → ask.matched
 *     notification (+ optional pre-filled PROPOSED agreement).
 *
 * Service payloads carry `reputation {score, attempts, successes}` — the
 * learned track record of (provider agent × semantic type).
 *
 * Every mutation publishes a world-change message (objectType 'service') so
 * the marketplace updates live.
 */

import type { FastifyInstance } from 'fastify';

import { ownerEligibleForFlowAuthor, SNAPSHOT_PARAMETERS } from '@active-collaboration/core';

import type { ChangePipeline } from '../change-pipeline.js';
import {
  COUNT_ACTIVE_BOOLEAN_KEYS,
  parseComputationSpec,
  type ComputationMetric,
  type DeviceMetric,
  type EventMetric,
} from '../computation-evaluator.js';
import { environmentToScenario } from '../environment-bridge.js';
import { ApiError, errorBody } from '../errors.js';
import {
  canReadEnvironment,
  getEnvironmentOrThrow,
  requireEnvRole,
  requireObjectMutationAccess,
  requireReadAccess,
} from '../env-access.js';
import {
  ownerRef,
  serviceToJson,
  type OwnerRef,
  type ServiceComputationSummary,
} from '../env-serializers.js';
import type { AgreementStore } from '../db/agreement-store.js';
import type { EnvironmentStore } from '../db/environment-store.js';
import { flowRowToDefinition, FlowStore, type FlowRow } from '../db/flow-store.js';
import {
  noHistoryView,
  ReputationStore,
  type ReputationScoreView,
} from '../db/reputation-store.js';
import { serviceSignabilityOf } from '../agreements/backing.js';
import type { ReadSourceWritabilityFace } from '../frame-evaluator.js';
import {
  aggregateBackingMissing,
  aggregateRuleBackingView,
  canSeeService,
  declaredOfferDriftForEnv,
  declaredOfferDriftOf,
  flowServiceInterface,
  unbackedFlagsForEnv,
  type AccessGrantRow,
  type AccessRequestRow,
  type ServiceInstanceRow,
  type ServiceOrigin,
  type ServiceStore,
  type ServiceVisibility,
} from '../db/service-store.js';
import { parseJsonArray, parseJsonObject, parseMapData, type AgentInstanceRow, type EnvironmentRow } from '../db/environment-store.js';
import { isAutoMintedSpec } from '../db/service-computation-store.js';
import type { NotificationStore } from '../db/notification-store.js';
import type { StandingAskRow, StandingAskStore } from '../db/standing-ask-store.js';
import {
  assertAskQuota,
  existingMatchesForAsk,
  existingMatchesNote,
  matchStandingAsksForNewService,
  parseAskBody,
  standingAskToJson,
  ZONE_MATCHABILITY_NOTE,
} from '../standing-asks.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';
import { t } from '../i18n/index.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';

export interface ServiceRoutesContext {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  reputationStore: ReputationStore;
  userStore: UserStore;
  /** Fix-1: world-change broadcasts carry the acting user. */
  pipeline: ChangePipeline;
  /**
   * R14 Wave-A: computation revocation must notify the parties of ACTIVE
   * data agreements (agreement.compute-dropped) — the services route owns
   * the revoke endpoint, so it needs both stores.
   */
  agreementStore: AgreementStore;
  notificationStore: NotificationStore;
  /**
   * T-069 (R23): the standing-ask 需求板 — publish events match open asks
   * (ask.matched notification + optional pre-filled proposal).
   */
  standingAskStore: StandingAskStore;
  /**
   * T84 (R10, u1-F3): the read-source writability judge factory — resolves
   * the env's live world ONCE per request through the READ DEFAULT lane's
   * own adjudication (T86, R11 u1-F1): the VIEWER's own running sim when she
   * has exactly one, else the authoritative world session when live — never
   * another member's sim (u1: the probe judged a world her reads could never
   * target). Undefined result = nothing honest to claim (no live world for
   * the viewer's default read lane / oracle silent); the field itself is
   * optional so degenerate harnesses omit it.
   */
  readSourceWritabilityJudgeOf?: (
    envId: string,
    viewerId: string | null,
  ) => ((service: ServiceInstanceRow) => ReadSourceWritabilityFace | undefined) | undefined;
  /**
   * Mechanism D: the publish lane for origin='flow' services validates the
   * backing flow (exists / enabled / has a declared inputs surface /
   * provider agent inside the flow author's T-201 scope) and generates the
   * interface FROM the surface. Optional only so degenerate harnesses can
   * omit it — the flow publish path refuses loudly when absent.
   */
  flowStore?: FlowStore;
  /**
   * T-067 (R16): TEST-DEPLOYMENT INFRA — gates PATCH access-grants expiry
   * probing (EAF_ALLOW_GRANT_TIME_CONTROL=1, default off). Grant durations
   * are provider-decided (1-day floor), so expiry is otherwise untestable
   * inside a round window; the flag never changes production floors.
   */
  allowGrantTimeControl?: boolean;
}

interface EnvParams {
  id: string;
}

interface AgentServicesParams {
  id: string;
  agentId: string;
}

interface ServiceParams {
  id: string;
}

const SERVICE_VISIBILITIES: readonly ServiceVisibility[] = ['public', 'members', 'hidden'];
const SERVICE_ORIGINS: readonly ServiceOrigin[] = ['derived', 'published', 'flow', 'aggregate'];

export function registerServiceRoutes(app: FastifyInstance, ctx: ServiceRoutesContext): void {
  app.get('/api/environments/:id/services', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as EnvParams;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);

    const query = request.query as Record<string, unknown>;
    const semanticType = optionalQueryString(query.semanticType, 'semanticType');
    const provider = optionalQueryString(query.provider, 'provider');
    const origin = optionalQueryString(query.origin, 'origin');
    const q = optionalQueryString(query.q, 'q');
    if (origin !== undefined && !SERVICE_ORIGINS.includes(origin as ServiceOrigin)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Query "origin" must be one of ${SERVICE_ORIGINS.map(o => `"${o}"`).join(' | ')}`,
      );
    }

    const viewer = { userId: request.user?.id ?? null, role };
    const services = ctx.serviceStore.servicesOf(id);
    // T84: one live-world resolution per list request — the per-service
    // read-source probe reuses it (a GET never creates a world). T86: the
    // world is the VIEWER's default read target, not any running sim.
    const judge = ctx.readSourceWritabilityJudgeOf?.(env.id, viewer.userId);
    // R80-FW1: device→zone map for the derived services' spatial anchor.
    const deviceZoneById = new Map(
      ctx.envStore.devicesOf(id).map(row => [row.id, row.zone_id]),
    );
    const unbacked = unbackedFlagsForEnv(ctx.envStore, services);
    // T28 (R3 u3-F1): declaration-drift markers for capability-minted rows.
    const declarationDrift = declaredOfferDriftForEnv(ctx.envStore, services);
    const reputationScores = ctx.reputationStore.scoresForEnv(id);
    const ownerCache = new Map<string, OwnerRef>();
    // R101 (②): one grouped query for every visible row's履约摘要.
    const usageSummaries = ctx.agreementStore.usageSummariesForEnv(
      env.id,
      new Date(Date.now() - USAGE_SUMMARY_WINDOW_DAYS * 86_400_000).toISOString(),
    );

    return {
      services: services
        .filter(row => {
          if (semanticType !== undefined && row.semantic_type !== semanticType) return false;
          if (provider !== undefined && row.provider_agent_id !== provider) return false;
          if (origin !== undefined && row.origin !== origin) return false;
          if (
            q !== undefined &&
            !matchesServiceQuery([row.name, row.description, row.semantic_type], q)
          ) {
            return false;
          }
          const agent = ctx.envStore.getAgent(row.provider_agent_id);
          return agent !== undefined && canSeeService(row.visibility, agent.owner_id, env, viewer,
            // T-058b: an unexpired provider grant opens hidden offers.
            // T-053: origin rides along so demo-mode public envs can open
            // members-visible DERIVED rows to anonymous visitors.
            { accessGrant: ctx.serviceStore.hasActiveAccessGrant(row.id, viewer.userId), origin: row.origin });
        })
        .map(row => {
          const json = serviceToJson(
            row,
            providerRefFor(ctx, row.provider_agent_id, ownerCache),
            unbacked.get(row.id) ?? true,
            reputationScores.get(ReputationStore.key(row.provider_agent_id, row.semantic_type)) ??
              noHistoryView(),
            computationSummaryFor(ctx, row.id),
            // R80-FW1: derived rows resolve their source device's zone.
            deviceId => deviceZoneById.get(deviceId),
            // R101 (②): the stranger-verifiable履约摘要 per row.
            (() => {
              const summary = usageSummaries.get(row.id);
              return summary === undefined
                ? undefined
                : {
                    windowDays: USAGE_SUMMARY_WINDOW_DAYS,
                    ...summary,
                    // R102: same差额 accounting as the detail lane.
                    other: Math.max(
                      0,
                      summary.invocations - summary.succeeded - summary.failed - summary.partial,
                    ),
                    successRate: summary.invocations > 0
                      ? summary.succeeded / summary.invocations
                      : null,
                  };
            })(),
            // 8th slot = the aggregate backing face (list stays flag-level).
            undefined,
            // T28: the catalog face of declaration drift.
            declarationDrift.get(row.id) === true,
          );
          // T62 (R6, u4-F5) + T68a (R7, u2-F-5): the signing gates' verdict,
          // visible at list time (aggregate rows judge the RULE lane;
          // undefined only for flow rows). T84: the read-source probe
          // overlays never-writable computations (verdict flips
          // backed→ambiguous + readSource face).
          const signability = serviceSignabilityOf(
            ctx.envStore,
            row,
            judge?.(row),
          );
          return signability !== undefined ? { ...json, signability } : json;
        }),
    };
  });

  app.post(
    '/api/environments/:id/agents/:agentId/services',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, agentId } = request.params as AgentServicesParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const agent = ctx.envStore.getAgent(agentId);
      if (!agent || agent.env_id !== env.id) {
        throw new ApiError(
          404,
          'AGENT_NOT_FOUND',
          `Agent "${agentId}" does not exist in environment "${env.id}"`,
        );
      }
      requireObjectMutationAccess(ctx.envStore, env, agent.owner_id, user, 'agent');

      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = requireNonEmptyString(body.name, 'name');
      const semanticType = requireNonEmptyString(body.semanticType, 'semanticType');
      const description = body.description !== undefined ? requireString(body.description, 'description') : '';
      const visibility = parseServiceVisibility(body.visibility) ?? 'public';
      // D2 (T-079, §11.2(6) amended): providers of published/flow services
      // MAY declare a zoneId — governance-visible in the publish payload and
      // the service JSON, honored by the standing-ask matcher exactly as
      // derived services honor their source device's zone. Undeclared stays
      // zone-less (matches zone-less asks only). Closed schema: an unknown
      // zone is a teaching 400 (the earliest boundary).
      let zoneId: string | null = null;
      if (body.zoneId !== undefined) {
        if (typeof body.zoneId !== 'string' || body.zoneId.length === 0) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Body field "zoneId" must be a non-empty string when provided (a zone of this environment, ' +
              'declaring where the offer operates — zone-pinned standing asks can then match it)',
          );
        }
        const zones = parseMapData(env).zones;
        if (!zones.some(zone => zone.id === body.zoneId)) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            `Body field "zoneId" names no zone of this environment: "${body.zoneId}" — ` +
              `zones are: ${zones.map(zone => `"${zone.id}"`).join(', ') || '(none — drop zoneId to publish zone-less)'}`,
          );
        }
        zoneId = body.zoneId;
      }

      // Mechanism D (design §5.3): `backing: {kind:'flow', flowId}` publishes
      // a FLOW-SERVICE — origin 'flow', interface generated from the flow's
      // declared inputs surface, provider agent gated by the flow's T-201
      // author scope. Everything else stays the device/published path.
      const backing = parseBacking(body.backing);
      // R80-1: the same-provider duplicate advisory — computed once for both
      // publish lanes, NON-BLOCKING (teach, don't refuse): the R80 probe
      // showed one agent can re-publish its own semantic type endlessly and
      // silently dilute the marketplace. The 201 carries `warnings` naming
      // the existing offers so the publisher confirms intent.
      const duplicateWarnings = duplicateServiceWarnings(ctx, env.id, agent.id, agent.name, semanticType);
      if (backing?.kind === 'flow') {
        if (body.interface !== undefined) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'A flow-service\'s interface is GENERATED from the flow\'s inputs surface — drop "interface" ' +
              'and edit the flow (PATCH /api/flows/:id {inputs}) instead',
          );
        }
        const flow = requirePublishableFlow(ctx, env, agent.id, backing.flowId);
        const row = ctx.serviceStore.createService({
          envId: env.id,
          providerAgentId: agent.id,
          name,
          semanticType,
          description,
          interface: flowServiceInterface(flowRowToDefinition(flow, env.owner_id)),
          origin: 'flow',
          sourceFlowId: flow.id,
          visibility,
          zoneId,
        });
        const json = serviceToJson(
          row,
          providerRefFor(ctx, agent.id, new Map()),
          isUnbacked(ctx, row),
          reputationForService(ctx, row),
        );
        ctx.pipeline.publish(env.id, 'created', 'service', json, user.id);
        // T-069: a NEW service (published + flow origins) claims matching
        // standing asks — best-effort lane, never breaks the publish.
        matchStandingAsksForNewService(ctx, row, user.id, request.locale);
        return reply.code(201).send({
          ...json,
          ...(duplicateWarnings.length > 0 ? { warnings: duplicateWarnings } : {}),
        });
      }

      const iface = body.interface !== undefined ? requireObject(body.interface, 'interface') : {};
      const row = ctx.serviceStore.createService({
        envId: env.id,
        providerAgentId: agent.id,
        name,
        semanticType,
        description,
        interface: iface,
        origin: 'published',
        visibility,
        zoneId,
      });
      const json = serviceToJson(
        row,
        providerRefFor(ctx, agent.id, new Map()),
        isUnbacked(ctx, row),
        reputationForService(ctx, row),
        undefined,
        undefined,
        undefined,
        undefined,
        // T53: a published offer of a capability the agent never declared is
        // drifted FROM BIRTH — the 201 says so immediately (same face as
        // list/get after the publish).
        declaredOfferDriftOf(ctx.envStore, row),
      );
      ctx.pipeline.publish(env.id, 'created', 'service', json, user.id);
      // T-069: same matching seam as the flow-service branch above.
      matchStandingAsksForNewService(ctx, row, user.id, request.locale);
      return reply.code(201).send({
        ...json,
        ...(duplicateWarnings.length > 0 ? { warnings: duplicateWarnings } : {}),
      });
    },
  );

  /**
   * Fix-10: one offer by id (the CLI `service get` backend). Same visibility
   * boundary as the env list — an offer the caller may not SEE is a 404
   * exactly like an unknown id. Anonymous callers may read public offers of
   * public environments.
   */
  app.get('/api/services/:id', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as ServiceParams;
    const row = getVisibleServiceOrThrow(ctx, id, request.user?.id ?? null);
    const json = serviceToJson(
      row,
      providerRefFor(ctx, row.provider_agent_id, new Map()),
      isUnbacked(ctx, row),
      reputationForService(ctx, row),
      computationSummaryFor(ctx, row.id),
      undefined,
      // R101 (②): the stranger-verifiable履约摘要 (aggregate, same-source
      // as the parties' usage rows).
      usageSummaryFor(ctx, row.id),
      // T31 (R3 u2-F-04): the aggregate rule-lane backing face — the SAME
      // judgment as the signing gates, so "can this be delivered?" reads
      // one answer on the detail page and at propose.
      aggregateBackingFaceFor(ctx, row),
      // T28 (R3 u3-F1): the declaration-drift marker for this row.
      declaredOfferDriftOf(ctx.envStore, row),
    );
    // T62 (R6, u4-F5) + T68a (R7, u2-F-5): the signing gates' verdict on the
    // detail face (aggregate rows judge the RULE lane; undefined only for
    // flow rows). T84: the read-source probe overlays never-writable
    // computations (verdict flips backed→ambiguous + readSource face).
    // T86: the probe world follows the VIEWER's default read lane.
    const judge = ctx.readSourceWritabilityJudgeOf?.(row.env_id, request.user?.id ?? null);
    const signability = serviceSignabilityOf(ctx.envStore, row, judge?.(row));
    return signability !== undefined ? { ...json, signability } : json;
  });

  app.patch('/api/services/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const existing = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    const agent = ctx.envStore.getAgent(existing.provider_agent_id);
    requireObjectMutationAccess(ctx.envStore, env, agent?.owner_id ?? '', user, 'service');

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<ServiceStore['updateService']>[1] = {};
    if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
    if (body.semanticType !== undefined) {
      patch.semanticType = requireNonEmptyString(body.semanticType, 'semanticType');
    }
    if (body.description !== undefined) {
      patch.description = requireString(body.description, 'description');
    }
    if (body.interface !== undefined) patch.interface = requireObject(body.interface, 'interface');
    if (body.visibility !== undefined) patch.visibility = parseServiceVisibility(body.visibility);

    // Derived rows are managed by the derivation sync: visibility only.
    if (existing.origin === 'derived' && Object.keys(patch).some(key => key !== 'visibility')) {
      throw new ApiError(
        409,
        'SERVICE_DERIVED_READONLY',
        'Derived services are managed from the provider agent\'s device bindings — only their visibility may be changed',
      );
    }
    // Mechanism D: a flow-service's interface is GENERATED from the backing
    // flow's inputs surface (and refreshed when the flow changes) — a manual
    // interface PATCH would drift from the contract the invoke path enforces.
    if (existing.origin === 'flow' && patch.interface !== undefined) {
      throw new ApiError(
        409,
        'SERVICE_FLOW_MANAGED',
        'A flow-service\'s interface is generated from the backing flow\'s inputs surface — edit the flow ' +
          '(PATCH /api/flows/:id {inputs}); name/description/semanticType/visibility may be patched here',
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body must contain at least one of: name, semanticType, description, interface, visibility',
      );
    }

    const row = ctx.serviceStore.updateService(id, patch);
    const json = serviceToJson(
      row,
      providerRefFor(ctx, row.provider_agent_id, new Map()),
      isUnbacked(ctx, row),
      reputationForService(ctx, row),
      computationSummaryFor(ctx, row.id),
    );
    ctx.pipeline.publish(env.id, 'updated', 'service', json, user.id);
    return json;
  });

  app.delete('/api/services/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const existing = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    const agent = ctx.envStore.getAgent(existing.provider_agent_id);
    requireObjectMutationAccess(ctx.envStore, env, agent?.owner_id ?? '', user, 'service');

    if (existing.origin === 'derived') {
      throw new ApiError(
        409,
        'SERVICE_DERIVED_READONLY',
        'Derived services are managed from the provider agent\'s device bindings — unbind the device instead',
      );
    }
    // Mechanism D: origin='flow' rows ARE deletable (unpublish) — the flow
    // itself cascades them on DELETE /api/flows/:id; deleting the row here is
    // the provider's manual unpublish.
    ctx.serviceStore.deleteService(id);
    ctx.pipeline.publish(env.id, 'deleted', 'service', { id }, user.id);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Computations (R14 Wave-A, design-data-services.md §4/§8) — the provider
  // registers a declarative ComputationSpec on a PUBLISHED service; presence
  // flips an unbacked offer consumable (read/push lanes deliver frames).
  // ---------------------------------------------------------------------------

  app.post('/api/services/:id/computation', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const existing = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    const agent = ctx.envStore.getAgent(existing.provider_agent_id);
    requireObjectMutationAccess(ctx.envStore, env, agent?.owner_id ?? '', user, 'service');

    if (existing.origin === 'derived') {
      // D4 (DevLoop R28, T-081): the auto-mint lane — when the source
      // device had readable parameters at derivation time, the platform
      // auto-registered a minimal device-aggregate spec, and the provider
      // MAY override it here (the explicit registration REPLACES the mint;
      // devices/scope are still validated below). A derived service with NO
      // auto-mint (device without readable params) keeps the boundary.
      const stored = ctx.serviceStore.computationOf(existing.id);
      if (stored === undefined || !isAutoMintedSpec(stored)) {
        throw new ApiError(
          409,
          'SERVICE_DERIVED_READONLY',
          'Computation specs belong to published data services — this derived service has no auto-minted read lane to override ' +
            '(its source device declares no readable numeric parameters, so the platform minted nothing). ' +
            'For a PER-BED data product, publish a per-bed service (POST /api/environments/:envId/agents/:agentId/services, visibility "hidden") ' +
            'and register a computation on it with inputs.devices scoping exactly that bed\'s device',
        );
      }
    }

    // Closed-schema validation (unknown keys named at every level).
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { spec, asNames, schemaVersion, warnings: specWarnings } = parseComputationSpec(body);

    // T-075 (R22, CC-F04): the world-aware half of the countActive guidance.
    // The parse layer warns on the bare 'active' default; HERE the bound
    // devices' actual tracked keys (initialState ∪ the boolean spellings the
    // power commands maintain) decide — a countActive path none of the
    // selected devices tracks would plausibly read zero forever. Non-blocking
    // (the T-406 warning pattern): free-form state keys stay permissive.
    const countActiveWarnings = countActiveStateKeyWarnings(ctx, agent, spec.devices, spec.metrics);
    // T54 (R6, u4-F1): the "two faces" advisory — a device metric whose state
    // path shares a name with a ZONE parameter (power is the classic: the
    // zone face is physics-maintained, the device face may hold a static
    // scenario initial value forever) is the exact shape that produced
    // COMPUTATION_DEVICE_STATE_UNWRITTEN refusals downstream. Warn at
    // registration; never refuse.
    const twoFacesWarnings = deviceZoneTwoFacesWarnings(ctx, env.id, agent, spec.devices, spec.metrics);
    // T78 (R8, u4-P1-3): a countSince metric on an event type this world
    // never declares produces "plausibly legal" ghost metrics — zero forever
    // unless someone happens to inject that type. The SAME declaration-table
    // oracle the inject lane and the flow trigger checks speak; a
    // non-blocking warning at registration (the type stays legal — someone
    // may wire the injection later), never a refusal.
    const ghostEventWarnings = ghostEventTypeWarnings(ctx, env, spec.metrics);
    const warnings = [...specWarnings, ...countActiveWarnings, ...twoFacesWarnings, ...ghostEventWarnings];

    // T-065 (R16, CP-F10): the provider-owned privacy guard. A spec that
    // declares inputs.devices may read ONLY devices bound to the provider
    // agent — the provider is the data fiduciary and cannot scope a foreign
    // or unowned device (the other resident's watch is exactly the leak the
    // per-bed lane exists to prevent). Refused with the provider's real
    // options named (design principle: the error teaches the next step).
    if (spec.devices !== undefined) {
      const boundIds = agent !== undefined
        ? parseJsonArray<string>(agent.bound_device_ids_json)
        : [];
      const bound = new Set(boundIds);
      const invalid = spec.devices.filter(deviceId => !bound.has(deviceId));
      if (invalid.length > 0) {
        const boundNames = boundIds.map(deviceId => {
          const device = ctx.envStore.getDevice(deviceId);
          return device === undefined ? deviceId : `${deviceId} (${device.name})`;
        });
        throw new ApiError(
          409,
          'DEVICE_SCOPE_INVALID',
          `inputs.devices names device(s) not bound to the provider agent "${agent?.name ?? existing.provider_agent_id}": ${invalid.map(id => `"${id}"`).join(', ')} — ` +
            'a computation may only read the provider\'s own bound devices. Bound devices: ' +
            (boundNames.length > 0 ? boundNames.join(', ') : '(none — bind devices to the provider agent first)'),
          undefined,
          { requestedDevices: spec.devices, boundDevices: boundIds, invalidDevices: invalid },
        );
      }
    }

    // interface.dataSchema: carried on the service interface (same request or
    // previously PATCHed in). Merged, never clobbered: the provider can add
    // dataSchema/excludes without losing an existing interface block.
    const currentInterface = JSON.parse(existing.interface_json) as Record<string, unknown>;
    const interfacePatch = body.interface;
    if (interfacePatch !== undefined && (typeof interfacePatch !== 'object' || interfacePatch === null || Array.isArray(interfacePatch))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "interface" must be an object when provided');
    }
    const nextInterface: Record<string, unknown> = { ...currentInterface };
    if (interfacePatch !== undefined) {
      Object.assign(nextInterface, interfacePatch as Record<string, unknown>);
    }
    if (spec.excludes !== undefined) {
      nextInterface.excludes = spec.excludes;
    }
    const dataSchemaError = dataSchemaMismatch(nextInterface.dataSchema, asNames);
    if (dataSchemaError !== null) {
      throw new ApiError(
        400,
        'DATA_SCHEMA_MISMATCH',
        `interface.dataSchema must describe exactly the computation's output fields (${asNames.join(', ')}) — ${dataSchemaError}`,
        undefined,
        { expectedFields: asNames },
      );
    }

    const row = interfacePatch !== undefined || spec.excludes !== undefined
      ? ctx.serviceStore.updateService(id, { interface: nextInterface })
      : existing;
    ctx.serviceStore.registerComputation({
      serviceId: id,
      kind: spec.kind,
      specJson: JSON.stringify(spec),
      schemaVersion,
      registeredBy: user.id,
    });
    // T81 (R8, u2-F4): re-registration is an ATOMIC spec swap. (1) Drop the
    // cached frame — a frame computed by the OLD spec must never be served
    // after the new spec lands ("provider fixed it, --latest still reports
    // the old error"); the next --latest recomputes from the new spec.
    // (2) Notify the live-runtime mirror — the register route used to be the
    // ONE catalog write that never notified (delete/apply do), so a live
    // sim's computation mirror could hold the old spec until an unrelated
    // write refreshed it.
    ctx.serviceStore.invalidateFramesOf(id);
    ctx.serviceStore.notifyCatalogChange(env.id);
    const json = serviceToJson(
      row,
      providerRefFor(ctx, row.provider_agent_id, new Map()),
      isUnbacked(ctx, row),
      reputationForService(ctx, row),
      computationSummaryFor(ctx, row.id),
    );
    ctx.pipeline.publish(env.id, 'updated', 'service', json, user.id);
    // T-025: a registered computation flips the service consumable and opens
    // the data lanes — the registration is audited (spec summary, not the
    // full spec: the computation endpoint serves the verbatim copy).
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'computation-change',
      payload: {
        objectType: 'service',
        action: 'registered',
        objectId: id,
        computationKind: spec.kind,
        schemaVersion,
      },
    });
    return reply.code(201).send({
      ...json,
      // T-406 (R19) + T-075 (R22): non-blocking registration hints (a
      // qualified device path that looks like the flow-condition syntax; a
      // countActive state key the bound devices do not track).
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });

  /** The registered computation spec (or null) — same visibility as the service. */
  app.get('/api/services/:id/computation', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as ServiceParams;
    const service = getVisibleServiceOrThrow(ctx, id, request.user?.id ?? null);
    const row = ctx.serviceStore.computationOf(service.id);
    if (row === undefined) return { computation: null };
    // T81 (R9, u2-F2): the ghost-event-type warning REPLAYS on the get face,
    // recomputed against the CURRENT world — a provider who missed the
    // registration-time warning (or registered via a face that dropped it)
    // no longer carries a ghost metric invisibly. Non-blocking, same oracle
    // (ghostEventTypeWarnings) as the register lane.
    let ghostWarnings: string[] = [];
    try {
      const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
      const spec = JSON.parse(row.spec_json) as { metrics?: ComputationMetric[] };
      ghostWarnings = ghostEventTypeWarnings(ctx, env, spec.metrics ?? []);
    } catch {
      ghostWarnings = []; // no declaration table reachable — nothing honest to claim
    }
    return {
      computation: {
        kind: row.kind,
        schemaVersion: row.schema_version,
        registeredBy: row.registered_by,
        registeredAt: row.registered_at,
        spec: JSON.parse(row.spec_json) as unknown,
        ...(ghostWarnings.length > 0 ? { warnings: ghostWarnings } : {}),
      },
    };
  });

  /**
   * Revoke the computation: `consumable` flips back (unbacked offers return
   * to T-310 semantics). ACTIVE data agreements are NOT silently terminated
   * (§7): both parties get `agreement.compute-dropped`; reads turn
   * 409 COMPUTATION_UNREGISTERED and open push sockets close at their next
   * recompute trigger — terminating stays a bilateral decision.
   */
  app.delete('/api/services/:id/computation', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const existing = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    const agent = ctx.envStore.getAgent(existing.provider_agent_id);
    requireObjectMutationAccess(ctx.envStore, env, agent?.owner_id ?? '', user, 'service');

    if (!ctx.serviceStore.revokeComputation(id)) {
      throw new ApiError(
        404,
        'COMPUTATION_NOT_REGISTERED',
        `Service "${id}" has no registered computation to revoke`,
      );
    }
    // T81: a revoked spec invalidates its cached frame the same way a swapped
    // one does (the read lane refuses COMPUTATION_UNREGISTERED before the
    // cache is ever consulted — this keeps the cache store consistent, not
    // the read verdict). Same notification discipline as register: the mirror
    // must learn the computation is gone.
    ctx.serviceStore.invalidateFramesOf(id);
    ctx.serviceStore.notifyCatalogChange(env.id);
    // §7: ping every ACTIVE agreement's parties — the deliverable they
    // contracted for just disappeared; the contract itself is theirs to end.
    // R15 (CP-F11): allowSelf — the design promises EACH PARTY one
    // notification ("双方各收到一条"); the funnel's recipient===actor echo
    // rule was dropping the revoking provider's copy, and on a
    // self-agreement (consumer==provider==actor) BOTH copies — the round's
    // live DELETE produced zero notifications for the party holding both
    // roles. The provider's copy is signal, not noise: it names WHICH active
    // agreements the revoke hit (the synchronous 200 only names the service).
    for (const agreement of ctx.agreementStore.agreementsOfEnv(env.id)) {
      if (agreement.service_id !== id || agreement.status !== 'active') continue;
      for (const recipientId of [...new Set([agreement.consumer_owner_id, agreement.provider_owner_id])]) {
        notify(ctx.notificationStore, {
          recipientId,
          actorId: user.id,
          envId: env.id,
          kind: NOTIFICATION_KINDS.agreementComputeDropped,
          title: t(request.locale, 'chrome.notif.agreementComputeDropped'),
          body: {
            agreementId: agreement.id,
            serviceId: id,
            serviceName: existing.name,
            note: 'reads now answer 409 COMPUTATION_UNREGISTERED — terminate the agreement or wait for the provider to re-register',
          },
          refId: agreement.id,
          dedupeUnread: true,
          allowSelf: true,
        });
      }
    }
    const json = serviceToJson(
      existing,
      providerRefFor(ctx, existing.provider_agent_id, new Map()),
      isUnbacked(ctx, existing),
      reputationForService(ctx, existing),
    );
    ctx.pipeline.publish(env.id, 'updated', 'service', json, user.id);
    // T-025: the revoke is audited with the active-agreement count it hit.
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'computation-change',
      payload: {
        objectType: 'service',
        action: 'revoked',
        objectId: id,
        activeAgreementsNotified: ctx.agreementStore.agreementsOfEnv(env.id)
          .filter(row => row.service_id === id && row.status === 'active').length,
      },
    });
    return reply.code(200).send(json);
  });

  // ---------------------------------------------------------------------------
  // Access requests + grants (T-058b, design-consent-semantics.md §4) — the
  // per-data-subject authorization lane on HIDDEN services. A bilateral data
  // transaction (requester ↔ provider owner), deliberately NOT the proposal
  // pipeline: no world-structure change happens. The grant is the DOOR
  // (canSee opens list/GET/propose); the agreement remains the CONTRACT
  // (terms.read.fields / quota / freshness scope what a granted viewer may
  // consume). No SLA on requests — the remind channel (10-min rate limit,
  // T-309 pattern) is the only nudge.
  // ---------------------------------------------------------------------------

  app.post('/api/services/:id/access-requests', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    // Membership is the floor: outsiders neither request nor learn the
    // service exists (404, no existence leak — FR-F03 boundary).
    const role = ctx.envStore.roleOf(env.id, user.id);
    if (role === undefined) {
      throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
    }
    if (service.visibility !== 'hidden') {
      throw new ApiError(
        409,
        'SERVICE_NOT_HIDDEN',
        `Service "${service.name}" is ${service.visibility} — it is already visible to you; ` +
          'access requests exist to open HIDDEN services (visibility=hidden) per person and period',
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const purpose = body.purpose !== undefined ? requireNonEmptyString(body.purpose, 'purpose') : '';
    let durationDays: number | null = null;
    if (body.durationDays !== undefined) {
      if (
        typeof body.durationDays !== 'number' || !Number.isInteger(body.durationDays) ||
        body.durationDays <= 0
      ) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "durationDays" must be a positive integer (days)');
      }
      durationDays = body.durationDays;
    }

    const row = ctx.serviceStore.createAccessRequest({
      serviceId: service.id,
      requesterId: user.id,
      purpose,
      durationDays,
    });
    // §4.2: notify the provider owner only (D-5 default: bilateral —
    // re-publicizing the data transaction would fight §6's bilateralization).
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    if (agent) {
      notify(ctx.notificationStore, {
        recipientId: agent.owner_id,
        actorId: user.id,
        envId: env.id,
        kind: NOTIFICATION_KINDS.serviceAccessRequested,
        title: t(request.locale, 'chrome.notif.serviceAccessRequested'),
        body: {
          requestId: row.id,
          serviceId: service.id,
          serviceName: service.name,
          requesterName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
          purpose,
          ...(durationDays !== null ? { durationDays } : {}),
          note: 'grant via POST /api/services/:id/access-grants { requestId, expiresAt } — or leave it (no SLA); DELETE the request to reject explicitly',
        },
        refId: row.id,
      });
    }
    return reply.code(201).send(accessRequestToJson(ctx, row));
  });

  /** The provider-side queue (and the requester's own history of this service). */
  app.get('/api/services/:id/access-requests', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    requireProviderAccess(ctx, service, env, user, 'access requests');
    return {
      requests: ctx.serviceStore.accessRequestsOf(service.id).map(row => accessRequestToJson(ctx, row)),
    };
  });

  /** Withdraw (requester) or explicitly reject (provider owner / env owner). */
  app.delete('/api/services/:id/access-requests/:requestId', { preHandler: app.authenticate }, async (request, reply) => {
    const { id, requestId } = request.params as ServiceParams & { requestId: string };
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    const row = ctx.serviceStore.accessRequest(requestId);
    if (!row || row.service_id !== service.id) {
      throw new ApiError(404, 'ACCESS_REQUEST_NOT_FOUND', `Access request "${requestId}" not found`);
    }
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    const isProvider = agent !== undefined &&
      (agent.owner_id === user.id || env.owner_id === user.id);
    if (row.requester_id !== user.id && !isProvider) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Only the requester (withdraw) or the provider (explicit reject) may close an access request',
      );
    }
    if (row.status !== 'pending') {
      throw new ApiError(
        409,
        'ACCESS_REQUEST_NOT_PENDING',
        `Access request "${requestId}" is already ${row.status} — only pending requests can be closed`,
      );
    }
    const closed = ctx.serviceStore.closeAccessRequest(requestId, row.requester_id === user.id ? 'withdrawn' : 'rejected');
    return reply.code(200).send(accessRequestToJson(ctx, closed));
  });

  /**
   * §4.2: the requester's nudge on a pending request — the same rate limit
   * as agreement remind (one per 10 minutes, anchored at request creation or
   * the last reminder; R13's anchor-naming applies).
   */
  app.post('/api/services/:id/access-requests/:requestId/remind', { preHandler: app.authenticate }, async (request, reply) => {
    const { id, requestId } = request.params as ServiceParams & { requestId: string };
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    const row = ctx.serviceStore.accessRequest(requestId);
    if (!row || row.service_id !== service.id) {
      throw new ApiError(404, 'ACCESS_REQUEST_NOT_FOUND', `Access request "${requestId}" not found`);
    }
    if (row.requester_id !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the requester may remind about an access request');
    }
    if (row.status !== 'pending') {
      throw new ApiError(
        409,
        'ACCESS_REQUEST_NOT_PENDING',
        `Access request "${requestId}" is ${row.status} — reminders apply to pending requests only`,
      );
    }
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    if (!agent) {
      throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
    }
    const lastReminder = ctx.notificationStore.latestOfKind(
      agent.owner_id,
      NOTIFICATION_KINDS.serviceAccessReminded,
      row.id,
    );
    const anchorMs = lastReminder !== undefined
      ? new Date(lastReminder.created_at).getTime()
      : new Date(row.created_at).getTime();
    const elapsedMs = Date.now() - anchorMs;
    if (elapsedMs < REMIND_WINDOW_MS) {
      const retryAfterSec = Math.ceil((REMIND_WINDOW_MS - elapsedMs) / 1000);
      const anchorNote = lastReminder !== undefined
        ? 'a reminder was already sent recently'
        : 'no reminder has been sent yet, but the rate window starts at REQUEST CREATION, not at your first remind';
      throw new ApiError(
        429,
        'REMIND_RATE_LIMITED',
        `Access request "${requestId}": ${anchorNote} — retry in ~${retryAfterSec}s ` +
          '(reminders are rate-limited to one per 10 minutes, anchored at the later of request creation and the last reminder)',
        undefined,
        { retryAfterSec },
      );
    }
    const delivered = notify(ctx.notificationStore, {
      recipientId: agent.owner_id,
      actorId: user.id,
      envId: env.id,
      kind: NOTIFICATION_KINDS.serviceAccessReminded,
      title: t(request.locale, 'chrome.notif.serviceAccessReminded'),
      body: {
        requestId: row.id,
        serviceId: service.id,
        serviceName: service.name,
        requesterName: ctx.userStore.findById(user.id)?.display_name ?? user.id,
        note: 'no SLA applies to access requests — grant via POST /api/services/:id/access-grants or DELETE the request to reject',
      },
      refId: row.id,
    });
    return reply.code(200).send({
      requestId: row.id,
      status: row.status,
      reminded: delivered !== null,
      ...(delivered === null ? { note: 'notification dropped by a noise-control rule (e.g. provider === requester)' } : {}),
    });
  });

  /** Grant (or extend) access — provider agent owner or env owner (§4.1). */
  app.post('/api/services/:id/access-grants', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    requireObjectMutationAccess(ctx.envStore, env, agent?.owner_id ?? '', user, 'service');
    if (service.visibility !== 'hidden') {
      throw new ApiError(
        409,
        'SERVICE_NOT_HIDDEN',
        `Service "${service.name}" is ${service.visibility} — access grants exist to open HIDDEN services per person and period`,
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    // expiresAt is REQUIRED: a grant is never permanent by default (§4.1).
    if (body.expiresAt === undefined) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "expiresAt" is required (ISO timestamp, in the future) — grants always carry an expiry',
      );
    }
    if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "expiresAt" must be an ISO timestamp');
    }
    if (Date.parse(body.expiresAt) <= Date.now()) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "expiresAt" must be in the future');
    }

    let granteeUserId: string | undefined;
    let requestRow: AccessRequestRow | undefined;
    if (body.requestId !== undefined) {
      if (typeof body.requestId !== 'string' || body.requestId.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "requestId" must be a non-empty string when provided');
      }
      requestRow = ctx.serviceStore.accessRequest(body.requestId);
      if (!requestRow || requestRow.service_id !== service.id) {
        throw new ApiError(404, 'ACCESS_REQUEST_NOT_FOUND', `Access request "${body.requestId}" not found`);
      }
      if (requestRow.status !== 'pending') {
        throw new ApiError(
          409,
          'ACCESS_REQUEST_NOT_PENDING',
          `Access request "${body.requestId}" is already ${requestRow.status} — grant directly with body.userId instead`,
        );
      }
      granteeUserId = requestRow.requester_id;
    } else {
      granteeUserId = requireNonEmptyString(body.userId, 'userId');
    }
    const grantee = ctx.userStore.findById(granteeUserId);
    if (!grantee) {
      throw new ApiError(404, 'USER_NOT_FOUND', `User "${granteeUserId}" not found`);
    }
    // Grants open visibility for env MEMBERS (§4.1): a grant to a
    // non-member is a dead row — refuse it with the remedy.
    if (ctx.envStore.roleOf(env.id, grantee.id) === undefined) {
      throw new ApiError(
        400,
        'GRANTEE_NOT_MEMBER',
        `User "${grantee.display_name}" is not a member of environment "${env.id}" — access grants open hidden services for members; add them first`,
      );
    }
    const basis = body.basis !== undefined ? requireString(body.basis, 'basis') : null;
    const dataSubject = parseDataSubject(body.dataSubject);

    const row = ctx.serviceStore.grantAccess({
      serviceId: service.id,
      granteeUserId: grantee.id,
      grantedBy: user.id,
      expiresAt: body.expiresAt as string,
      basis,
      dataSubject,
      requestId: requestRow?.id ?? null,
    });
    if (requestRow !== undefined) {
      ctx.serviceStore.closeAccessRequest(requestRow.id, 'granted');
    }
    notify(ctx.notificationStore, {
      recipientId: grantee.id,
      actorId: user.id,
      envId: env.id,
      kind: NOTIFICATION_KINDS.serviceAccessGranted,
      title: t(request.locale, 'chrome.notif.serviceAccessGranted'),
      body: {
        grantId: row.id,
        serviceId: service.id,
        serviceName: service.name,
        expiresAt: row.expires_at,
        ...(basis !== null ? { basis } : {}),
        note: 'the service is now visible to you (list/GET/propose agreement) until the expiry — propose terms.read { fields, quotaPerWindow, windowSec } to scope consumption',
      },
      refId: row.id,
    });
    // T-025: consent boundaries are audited — a repeat POST (extension)
    // lands another row with the new expiry, so the grant ledger's history
    // is reconstructable from command_log alone.
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'access-grant',
      payload: {
        objectType: 'service',
        action: 'granted',
        objectId: service.id,
        granteeUserId: grantee.id,
        expiresAt: row.expires_at,
        ...(basis !== null ? { basis } : {}),
        ...(dataSubject !== null ? { dataSubject } : {}),
        ...(requestRow !== undefined ? { requestId: requestRow.id } : {}),
      },
    });
    return reply.code(201).send(accessGrantToJson(ctx, row));
  });

  /** The provider-side grant ledger (audit: who was let in, until when, on what basis). */
  app.get('/api/services/:id/access-grants', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    requireProviderAccess(ctx, service, env, user, 'access grants');
    return { grants: ctx.serviceStore.grantsOf(service.id).map(row => accessGrantToJson(ctx, row)) };
  });

  /** Revoke — canSee falls back to 404 immediately (§4.1). */
  app.delete('/api/services/:id/access-grants/:userId', { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId } = request.params as ServiceParams & { userId: string };
    const user = request.user!;
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    const agent = ctx.envStore.getAgent(service.provider_agent_id);
    requireObjectMutationAccess(ctx.envStore, env, agent?.owner_id ?? '', user, 'service');

    // T-025: capture the grant's before-state for the audit row (expiry the
    // revoke cut short; null when already lapsed past).
    const revokedGrant = ctx.serviceStore.grantOf(service.id, userId);
    if (!ctx.serviceStore.revokeAccess(service.id, userId)) {
      throw new ApiError(404, 'ACCESS_GRANT_NOT_FOUND', `No access grant on service "${id}" for user "${userId}"`);
    }
    notify(ctx.notificationStore, {
      recipientId: userId,
      actorId: user.id,
      envId: env.id,
      kind: NOTIFICATION_KINDS.serviceAccessRevoked,
      title: t(request.locale, 'chrome.notif.serviceAccessRevoked'),
      body: {
        serviceId: service.id,
        serviceName: service.name,
        note: 'the service answers 404 for you again; active agreements keep their status but reads answer 409 ACCESS_GRANT_REVOKED (metered) — termination stays bilateral',
      },
      refId: service.id,
    });
    // T-025: the recall lever is audited with the before-state.
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'access-grant',
      payload: {
        objectType: 'service',
        action: 'revoked',
        objectId: service.id,
        granteeUserId: userId,
        ...(revokedGrant !== undefined ? { before: { expiresAt: revokedGrant.expires_at } } : {}),
        after: null,
      },
    });
    return reply.code(204).send();
  });

  /**
   * T-067 (R16): TEST-DEPLOYMENT INFRA — the grant-expiry boundary probe.
   * Grant durations are provider-decided (expiresAt is required to be in
   * the future at grant time), so natural expiry cannot be observed inside
   * a round window. This env-owner-only, flag-gated, SHORTEN-ONLY route
   * collapses the boundary into seconds so both halves are testable:
   * expired grant → GET service 404 for the grantee, and active-agreement
   * reads → 409 ACCESS_GRANT_REVOKED (the deliverRead consent door checks
   * hasActiveAccessGrant on every read). Inert unless
   * EAF_ALLOW_GRANT_TIME_CONTROL=1; extensions keep riding the grant lane
   * (POST access-grants upserts = extension); no notification — natural
   * expiry is silent by design and the probe must not differ from it.
   */
  app.patch('/api/services/:id/access-grants/:userId', { preHandler: app.authenticate }, async (request, reply) => {
    const { id, userId } = request.params as ServiceParams & { userId: string };
    const user = request.user!;
    if (ctx.allowGrantTimeControl !== true) {
      throw new ApiError(
        403,
        'TEST_INFRA_DISABLED',
        'Grant expiry time control is TEST-DEPLOYMENT infra — start the server with EAF_ALLOW_GRANT_TIME_CONTROL=1 to expose it. ' +
          'Production grant floors are unchanged: expiry still arrives naturally, extensions ride POST /api/services/:id/access-grants',
      );
    }
    const service = getServiceOrThrow(ctx.serviceStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, service.env_id);
    // The probe is an env-OWNER admin action (stronger than the provider
    // owner check on grant/revoke): the route rewrites a consent boundary
    // for test purposes, so the deployment's owner owns it.
    if (env.owner_id !== user.id) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        'Grant expiry time control is reserved to the environment owner (test-deployment infra)',
      );
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key !== 'expiresAt') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "${key}" is not a known field (allowed: expiresAt) — the probe shortens one grant's expiry, nothing else`,
        );
      }
    }
    if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "expiresAt" must be an ISO timestamp (typically now or slightly before it, to expire the grant immediately)',
      );
    }
    const existing = ctx.serviceStore.grantOf(service.id, userId);
    if (existing === undefined) {
      throw new ApiError(
        404,
        'ACCESS_GRANT_NOT_FOUND',
        `No access grant on service "${service.id}" for user "${userId}"`,
      );
    }
    // Shorten-only: the probe must never become a hidden extension lane.
    if (Date.parse(body.expiresAt) > Date.parse(existing.expires_at)) {
      throw new ApiError(
        409,
        'GRANT_EXPIRY_NOT_SHORTER',
        `The probe may only SHORTEN a grant's expiry (${existing.expires_at} → ${body.expiresAt} would extend it) — ` +
          'extensions ride the grant lane: POST /api/services/:id/access-grants (a repeat grant extends)',
      );
    }
    const row = ctx.serviceStore.shortenGrantExpiry(service.id, userId, body.expiresAt)!;
    return reply.code(200).send(accessGrantToJson(ctx, row));
  });

  // ---------------------------------------------------------------------------
  // Subscriptions (W5) — "我依赖的服务" bookmarks
  //
  // Subscribe/unsubscribe are personal state, not world state: no world-sync
  // broadcast. Both verbs are idempotent, and a service the caller may not
  // SEE (hidden others' offers) answers 404 exactly like an unknown id — the
  // bookmark API never leaks an offer's existence.
  // ---------------------------------------------------------------------------

  app.put('/api/services/:id/subscribe', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getSubscribableServiceOrThrow(ctx, id, user);
    const subscription = ctx.serviceStore.subscribe(user.id, service);
    return reply.code(subscription.alreadySubscribed ? 200 : 201).send({
      serviceId: subscription.serviceId,
      userId: subscription.userId,
      envId: subscription.envId,
      createdAt: subscription.createdAt,
      alreadySubscribed: subscription.alreadySubscribed,
    });
  });

  app.delete('/api/services/:id/subscribe', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as ServiceParams;
    const user = request.user!;
    const service = getSubscribableServiceOrThrow(ctx, id, user);
    ctx.serviceStore.unsubscribe(user.id, service.id);
    return reply.code(204).send();
  });

  // Fix-10: POST here is a common wrong guess (the other bookmark APIs use
  // POST bodies). Answer a real 405 with an Allow header instead of letting
  // it fall through to Fastify's 404 ROUTE_NOT_FOUND, which read as "the
  // endpoint does not exist".
  app.post('/api/services/:id/subscribe', async (_request, reply) =>
    reply
      .code(405)
      .header('Allow', 'PUT, DELETE')
      .send(
        errorBody(
          'METHOD_NOT_ALLOWED',
          'Method Not Allowed — use PUT to subscribe or DELETE to unsubscribe',
        ),
      ),
  );

  // ---------------------------------------------------------------------------
  // Reputation (P4-1) — an agent's learned track record in this environment
  // ---------------------------------------------------------------------------

  app.get(
    '/api/environments/:id/agents/:agentId/reputation',
    { preHandler: app.optionalAuth },
    async request => {
      const { id, agentId } = request.params as AgentServicesParams;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
      requireReadAccess(env, role);

      const agent = ctx.envStore.getAgent(agentId);
      if (!agent || agent.env_id !== env.id) {
        throw new ApiError(
          404,
          'AGENT_NOT_FOUND',
          `Agent "${agentId}" does not exist in environment "${env.id}"`,
        );
      }

      const rows = ctx.reputationStore.rowsForAgent(env.id, agent.id);
      return {
        agentId: agent.id,
        envId: env.id,
        overallScore: ctx.reputationStore.overallForAgent(env.id, agent.id),
        totalAttempts: rows.reduce((sum, row) => sum + row.attempts, 0),
        capabilities: rows.map(row => ({
          capability: row.capability,
          score: ctx.reputationStore.scoreFor(env.id, agent.id, row.capability)!.score,
          attempts: row.attempts,
          successes: row.successes,
          failures: row.failures,
          lastAt: row.last_at,
        })),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Standing asks — the 需求板 (T-069, design-data-services.md §11)
  // ---------------------------------------------------------------------------

  app.post('/api/environments/:id/asks', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as EnvParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    // design §11.2(3): owners + builders may ask (viewer is read-only — the
    // same role gate as every other mutation surface).
    requireEnvRole(ctx.envStore, env.id, user, ['owner', 'builder']);
    const parsed = parseAskBody(
      env,
      request.body ?? {},
      new Date(),
    );
    assertAskQuota(ctx.standingAskStore, env.id, user.id);
    const row = ctx.standingAskStore.create({
      envId: env.id,
      askerId: user.id,
      semanticType: parsed.semanticType,
      zoneId: parsed.zoneId,
      desiredTerms: parsed.desiredTerms as Record<string, unknown>,
      note: parsed.note,
      autoPropose: parsed.autoPropose,
      expiresAt: parsed.expiresAt,
    });
    // R25-NF2 (C1, DevLoop R28): the positive path teaches too — (a) a
    // zone-pinned ask names its derived-only matchability, (b) satisfiers
    // that ALREADY exist are listed (the same matching logic, evaluated at
    // creation) so the ask cannot sit open beside a service that fulfills
    // it waiting for a future mint. Read-only preview: no claim, no
    // notification — single-match semantics untouched.
    const existingMatches = existingMatchesForAsk(ctx, env.id, user.id, parsed);
    return reply.code(201).send({
      ...serializeAsk(ctx, row),
      ...(parsed.zoneId !== null || existingMatches.length > 0
        ? {
            matchPreview: {
              ...(parsed.zoneId !== null ? { zoneMatchability: ZONE_MATCHABILITY_NOTE } : {}),
              ...(existingMatches.length > 0
                ? {
                    existingMatches,
                    note: existingMatchesNote(existingMatches.length),
                  }
                : {}),
            },
          }
        : {}),
    });
  });

  /**
   * The board: MEMBER-ONLY (design §11.2(2)) — asks carry member intent +
   * contact surface, they are not world structure, so even a public
   * environment's board stays behind membership. `?status=` selects the
   * slice: `open` (default — everyone's open asks), `mine` (the caller's
   * asks in every status), `all` (open of others + every status of mine).
   */
  app.get('/api/environments/:id/asks', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as EnvParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = ctx.envStore.roleOf(env.id, user.id);
    if (role === undefined) {
      throw new ApiError(
        403,
        'FORBIDDEN',
        `The standing-ask board of environment "${env.id}" is member-only — ` +
          'asks carry member demand and contact surface, not world structure',
      );
    }
    const query = request.query as Record<string, unknown>;
    const status = typeof query.status === 'string' ? query.status : 'open';
    if (!['open', 'mine', 'all'].includes(status)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Query "status" must be one of "open" | "mine" | "all" (got "${status}")`,
      );
    }
    const rows =
      status === 'open'
        ? ctx.standingAskStore.listForEnv(env.id, ['open'])
        : status === 'mine'
          ? ctx.standingAskStore.listForEnv(env.id, ['open', 'matched', 'withdrawn', 'expired'])
              .filter(row => row.asker_id === user.id)
          : ctx.standingAskStore
              .listForEnv(env.id, ['open', 'matched', 'withdrawn', 'expired'])
              .filter(row => row.asker_id === user.id || row.status === 'open');
    return { asks: rows.map(row => serializeAsk(ctx, row)) };
  });

  /** design §11.2(9): the asker's withdraw — matched asks already consumed their one match. */
  app.delete(
    '/api/environments/:id/asks/:askId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, askId } = request.params as { id: string; askId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, env.id, user, ['owner', 'builder']);
      const row = ctx.standingAskStore.get(askId);
      if (!row || row.env_id !== env.id) {
        throw new ApiError(404, 'ASK_NOT_FOUND', `Standing ask "${askId}" not found in environment "${env.id}"`);
      }
      if (row.asker_id !== user.id) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the asker may withdraw a standing ask (the board entry is the asker\'s demand, not a shared object)',
        );
      }
      const withdrawn = ctx.standingAskStore.withdraw(askId);
      if (withdrawn === undefined) {
        throw new ApiError(
          409,
          'ASK_NOT_OPEN',
          `Standing ask "${askId}" is already ${row.status} — a matched ask consumed its single match ` +
            '(re-ask with POST /api/environments/:id/asks if the need persists)',
        );
      }
      return reply.code(200).send(serializeAsk(ctx, withdrawn));
    },
  );
}

function serializeAsk(ctx: ServiceRoutesContext, row: StandingAskRow) {
  const asker = ctx.userStore.findById(row.asker_id);
  return standingAskToJson(row, {
    id: row.asker_id,
    displayName: asker?.display_name ?? row.asker_id,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fix-20 (F-09) + Wave-1a (R8 小新 F-02 / 小林 F-15) marketplace search.
 *
 * Pure substring never matches "温度" → "温湿度计" (the two characters are
 * not adjacent, so even bigram containment fails: 温湿度计's bigrams are
 * 温湿/湿度/度计). The minimal relaxation that covers both: a CJK query
 * token matches when all its characters appear IN ORDER in the candidate
 * text (subsequence); Latin/digit tokens keep Fix-20's case-insensitive
 * substring semantics. Every whitespace-separated token must hit at least
 * one of the candidate fields (name / description / semantic type).
 */
const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff]/;

function matchesServiceQuery(fields: string[], q: string): boolean {
  const lowered = fields.map(field => field.toLowerCase());
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(token => token.length > 0)
    .every(token =>
      lowered.some(text =>
        isCjkToken(token) ? containsSubsequence(text, token) : text.includes(token),
      ),
    );
}

function isCjkToken(token: string): boolean {
  return [...token].every(char => CJK_CHAR.test(char));
}

function containsSubsequence(text: string, needle: string): boolean {
  let i = 0;
  for (const char of text) {
    if (char === needle[i]) {
      i += 1;
      if (i === needle.length) return true;
    }
  }
  return i === needle.length;
}

function getServiceOrThrow(store: ServiceStore, id: string) {
  const row = store.getService(id);
  if (!row) throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
  return row;
}

/**
 * Load a service for reading or subscription: 404 when unknown, when its
 * environment is gone, or when the caller lacks read access to the
 * environment / visibility rights on the offer (hidden others' services are
 * indistinguishable from unknown ids). `userId` is null for anonymous
 * callers (public offers of public environments stay visible to them).
 */
function getVisibleServiceOrThrow(
  ctx: ServiceRoutesContext,
  id: string,
  userId: string | null,
): ServiceInstanceRow {
  const service = ctx.serviceStore.getService(id);
  const env = service ? ctx.envStore.getEnvironment(service.env_id) : undefined;
  const agent = service ? ctx.envStore.getAgent(service.provider_agent_id) : undefined;
  if (!service || !env || !agent) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
  }
  const role = userId !== null ? ctx.envStore.roleOf(env.id, userId) : undefined;
  const visible =
    canReadEnvironment(env, role) &&
    canSeeService(
      service.visibility,
      agent.owner_id,
      env,
      { userId, role },
      // T-058b: an unexpired provider grant opens hidden offers (the door;
      // the agreement stays the contract). T-053: origin rides along for
      // the derived demo-visibility mode.
      { accessGrant: ctx.serviceStore.hasActiveAccessGrant(service.id, userId), origin: service.origin },
    );
  if (!visible) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service "${id}" not found`);
  }
  return service;
}

function getSubscribableServiceOrThrow(
  ctx: ServiceRoutesContext,
  id: string,
  user: { id: string },
): ServiceInstanceRow {
  return getVisibleServiceOrThrow(ctx, id, user.id);
}

function ownerRefFor(ctx: ServiceRoutesContext, cache: Map<string, OwnerRef>, userId: string): OwnerRef {
  if (!cache.has(userId)) {
    const user = ctx.userStore.findById(userId);
    cache.set(userId, ownerRef(user ? toPublicUser(user) : undefined, userId));
  }
  return cache.get(userId)!;
}

function providerRefFor(
  ctx: ServiceRoutesContext,
  agentId: string,
  cache: Map<string, OwnerRef>,
): { id: string; name: string; owner: OwnerRef } {
  const agent = ctx.envStore.getAgent(agentId);
  if (!agent) {
    return { id: agentId, name: agentId, owner: { id: '', displayName: '' } };
  }
  return { id: agent.id, name: agent.name, owner: ownerRefFor(ctx, cache, agent.owner_id) };
}

function isUnbacked(ctx: ServiceRoutesContext, row: { id: string }): boolean {
  return unbackedFlagsForEnv(ctx.envStore, [ctx.serviceStore.getService(row.id)!]).get(row.id) ?? true;
}

/**
 * T31 (R3 u2-F-04): the detail-page backing face for an AGGREGATE offer —
 * the rule view when backed, the missing-what diagnosis when not. Undefined
 * for non-aggregate rows (their backing stays the literal device lane).
 */
function aggregateBackingFaceFor(
  ctx: ServiceRoutesContext,
  row: ServiceInstanceRow,
): { backing: ReturnType<typeof aggregateRuleBackingView>; missing?: ReturnType<typeof aggregateBackingMissing> } | undefined {
  if (row.origin !== 'aggregate') return undefined;
  const backing = aggregateRuleBackingView(ctx.envStore, row);
  if (backing !== null) return { backing };
  return { backing: null, missing: aggregateBackingMissing(ctx.envStore, row) };
}

/**
 * R14 Wave-A: the wire summary of a registered computation (refreshSec from
 * the stored spec — the market's freshness anchor). Undefined when the
 * service has none; callers pass it to serviceToJson for the consumable
 * verdict (`!unbacked || computation`).
 */
export function computationSummaryFor(
  ctx: Pick<ServiceRoutesContext, 'serviceStore'>,
  serviceId: string,
): ServiceComputationSummary | undefined {
  const row = ctx.serviceStore.computationOf(serviceId);
  if (row === undefined) return undefined;
  let refreshSec = 60;
  try {
    const parsed = JSON.parse(row.spec_json) as { refreshSec?: unknown };
    if (typeof parsed.refreshSec === 'number' && Number.isFinite(parsed.refreshSec) && parsed.refreshSec > 0) {
      refreshSec = parsed.refreshSec;
    }
  } catch {
    // stored spec unreadable — the summary degrades to the default anchor
  }
  return {
    kind: row.kind,
    refreshSec,
    schemaVersion: row.schema_version,
    registeredAt: row.registered_at,
    // D4 (T-081): the governance-visible mint marker.
    ...(isAutoMintedSpec(row) ? { autoMinted: true } : {}),
  };
}

/**
 * §9 registration invariant: interface.dataSchema describes EXACTLY the
 * computation's output fields (`as` names) — consumers program against the
 * schema, so a drift between them is a contract break caught at
 * registration, not at read time. Returns a teaching error or null.
 */
export function dataSchemaMismatch(dataSchema: unknown, asNames: string[]): string | null {
  if (
    typeof dataSchema !== 'object' || dataSchema === null || Array.isArray(dataSchema)
  ) {
    return 'it is missing (add interface: { dataSchema: { fields: [...] } } to this request, or PATCH the service first)';
  }
  const fields = (dataSchema as { fields?: unknown }).fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    return 'its "fields" array is missing or empty';
  }
  const seen: string[] = [];
  for (const field of fields) {
    if (
      typeof field !== 'object' || field === null ||
      typeof (field as { name?: unknown }).name !== 'string'
    ) {
      return 'every field needs a string "name"';
    }
    if (
      'type' in (field as Record<string, unknown>) &&
      !['number', 'integer', 'boolean', 'string'].includes(
        String((field as Record<string, unknown>).type),
      )
    ) {
      return `field "${(field as { name: string }).name}" has a type outside number|integer|boolean|string`;
    }
    seen.push((field as { name: string }).name);
  }
  const missing = asNames.filter(name => !seen.includes(name));
  const extra = seen.filter(name => !asNames.includes(name));
  if (missing.length > 0) return `missing field(s): ${missing.join(', ')}`;
  if (extra.length > 0) return `unexpected field(s): ${extra.join(', ')}`;
  return null;
}

/** Reputation of (provider agent × semantic type) for a service row (P4-1). */
function reputationForService(
  ctx: ServiceRoutesContext,
  row: { env_id: string; provider_agent_id: string; semantic_type: string },
): ReputationScoreView {
  return (
    ctx.reputationStore.scoreFor(row.env_id, row.provider_agent_id, row.semantic_type) ??
    noHistoryView()
  );
}

/** R101 (trust-visibility ②): the rolling履约摘要 window in days. */
const USAGE_SUMMARY_WINDOW_DAYS = 30;

/** R101: one service's stranger-safe usage summary (aggregate, no party data). */
function usageSummaryFor(
  ctx: ServiceRoutesContext,
  serviceId: string,
): {
  windowDays: number;
  invocations: number;
  succeeded: number;
  failed: number;
  partial: number;
  other: number;
  successRate: number | null;
} {
  const sinceIso = new Date(Date.now() - USAGE_SUMMARY_WINDOW_DAYS * 86_400_000).toISOString();
  const summary = ctx.agreementStore.usageSummaryForService(serviceId, sinceIso);
  return {
    windowDays: USAGE_SUMMARY_WINDOW_DAYS,
    ...summary,
    // R102: 差额类别有名有姓——invocations = succeeded + failed + partial
    // (AC 部分达成) + other (历史/其他口径行)，不再是沉默的差额。
    other: Math.max(0, summary.invocations - summary.succeeded - summary.failed - summary.partial),
    successRate: summary.invocations > 0 ? summary.succeeded / summary.invocations : null,
  };
}

function parseServiceVisibility(value: unknown): ServiceVisibility | undefined {
  if (value === undefined) return undefined;
  if (SERVICE_VISIBILITIES.includes(value as ServiceVisibility)) {
    return value as ServiceVisibility;
  }
  throw new ApiError(
    400,
    'BAD_REQUEST',
    `Field "visibility" must be one of ${SERVICE_VISIBILITIES.map(v => `"${v}"`).join(' | ')}`,
  );
}

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * R80-1 (DevLoop R80, duplicate-publish probe): the non-blocking duplicate
 * advisory. Same PROVIDER AGENT + same semantic type already listed in this
 * environment → the 201 carries one warning naming the existing offers (the
 * T-406 warnings pattern: free-form English hint strings, never an error).
 * Cross-provider overlap is legitimate competition and stays silent.
 */
function duplicateServiceWarnings(
  ctx: ServiceRoutesContext,
  envId: string,
  providerAgentId: string,
  providerName: string,
  semanticType: string,
): string[] {
  const existing = ctx.serviceStore
    .servicesOf(envId)
    .filter(row => row.provider_agent_id === providerAgentId && row.semantic_type === semanticType);
  if (existing.length === 0) return [];
  const names = existing.slice(0, 3).map(row => `"${row.name}"`).join(', ');
  const extra = existing.length > 3 ? ` (+${existing.length - 3} more)` : '';
  return [
    `Agent "${providerName}" already offers ${existing.length} service(s) of semantic type "${semanticType}" ` +
      `in this environment: ${names}${extra} — publishing another is allowed, but duplicate offers dilute the ` +
      'marketplace; confirm this is intentional (or PATCH/DELETE the existing offer instead)',
  ];
}

// ---------------------------------------------------------------------------
// T-058b helpers (access requests + grants)
// ---------------------------------------------------------------------------

/** T-309 pattern: one nudge per 10 minutes at most (§4.2 reuses it). */
const REMIND_WINDOW_MS = 10 * 60 * 1000;

/**
 * Provider-side read of the request/grant queues: the provider agent's owner
 * or the env owner (the two roles allowed to answer). Everyone else —
 * including members who merely see a hidden service via their own grant —
 * gets a plain 404 (the queue is the provider's business).
 */
function requireProviderAccess(
  ctx: ServiceRoutesContext,
  service: ServiceInstanceRow,
  env: { id: string; owner_id: string },
  user: { id: string },
  noun: string,
): void {
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  const isProvider = agent !== undefined && (agent.owner_id === user.id || env.owner_id === user.id);
  if (!isProvider) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Only the provider agent's owner or the environment owner may read ${noun} of service "${service.id}"`,
    );
  }
}

function accessRequestToJson(ctx: ServiceRoutesContext, row: AccessRequestRow) {
  const requester = ctx.userStore.findById(row.requester_id);
  return {
    id: row.id,
    serviceId: row.service_id,
    requesterId: row.requester_id,
    requesterName: requester?.display_name ?? row.requester_id,
    purpose: row.purpose,
    durationDays: row.duration_days,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function accessGrantToJson(ctx: ServiceRoutesContext, row: AccessGrantRow) {
  const grantee = ctx.userStore.findById(row.grantee_user_id);
  const grantedBy = ctx.userStore.findById(row.granted_by);
  let dataSubject: unknown = null;
  if (row.data_subject_json !== null) {
    try {
      dataSubject = JSON.parse(row.data_subject_json);
    } catch {
      dataSubject = null; // corrupted label degrades to absent, never 500s
    }
  }
  return {
    id: row.id,
    serviceId: row.service_id,
    granteeUserId: row.grantee_user_id,
    granteeName: grantee?.display_name ?? row.grantee_user_id,
    grantedBy: grantedBy?.display_name ?? row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    basis: row.basis,
    dataSubject,
    requestId: row.request_id,
  };
}

/**
 * §4.3 declarative data-subject label — closed shape { ref, consentBasis? }.
 * Provider-owned honesty: the platform does not verify real-world
 * relationships ("family of resident 101-2" is a declaration, not a fact we
 * can check); the label exists for audit and future policy enforcement.
 */
function parseDataSubject(raw: unknown): { ref: string; consentBasis?: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "dataSubject" must be an object { ref, consentBasis? } (or null)');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'ref' && key !== 'consentBasis') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "dataSubject.${key}" is not a known label field (allowed: ref, consentBasis)`,
      );
    }
  }
  if (typeof input.ref !== 'string' || input.ref.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "dataSubject.ref" must be a non-empty string (the data subject this service/grant concerns)');
  }
  if (input.consentBasis !== undefined && typeof input.consentBasis !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "dataSubject.consentBasis" must be a string when provided');
  }
  return {
    ref: input.ref.trim(),
    ...(input.consentBasis !== undefined ? { consentBasis: input.consentBasis as string } : {}),
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a string`);
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mechanism D — flow-service publish gates (design §5.3)
// ---------------------------------------------------------------------------

/** `backing: {kind:'flow', flowId}` — the flow-service publish selector. */
function parseBacking(raw: unknown): { kind: 'flow'; flowId: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "backing" must be an object { kind: "flow", flowId } when provided',
    );
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'kind' && key !== 'flowId') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "backing.${key}" is not a known backing field (allowed: kind, flowId)`,
      );
    }
  }
  if (input.kind !== 'flow') {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "backing.kind" must be "flow" (device-backed offers use the default path — omit "backing")`,
    );
  }
  if (typeof input.flowId !== 'string' || input.flowId.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "backing.flowId" must be a non-empty string');
  }
  return { kind: 'flow', flowId: input.flowId };
}

/**
 * The publish-time oracle for a backing flow (T-306 lesson — earliest
 * boundary): the flow must exist in THIS environment, be enabled, and carry
 * a DECLARED inputs surface (an empty array is a valid zero-arg signature;
 * undefined = pre-D flow with no surface, unpublishable). The provider
 * agent must sit inside the flow author's T-201 scope — the SAME oracle the
 * engine's assignment pass enforces at run time (`ownerEligibleForFlowAuthor`
 * wraps `agentEligibleForAuthor`), so a publishable provider can never
 * drift from an executable one.
 */
function requirePublishableFlow(
  ctx: ServiceRoutesContext,
  env: { id: string; owner_id: string },
  providerAgentId: string,
  flowId: string,
): FlowRow {
  if (ctx.flowStore === undefined) {
    throw new ApiError(
      500,
      'INTERNAL',
      'Flow store unavailable — flow-service publishing is not wired in this deployment',
    );
  }
  const flow = ctx.flowStore.getById(flowId);
  if (!flow || flow.environment_id !== env.id) {
    throw new ApiError(
      404,
      'FLOW_NOT_FOUND',
      `Flow "${flowId}" does not exist in environment "${env.id}" — a flow-service is backed by a flow of the SAME environment`,
    );
  }
  if (flow.enabled !== 1) {
    throw new ApiError(
      409,
      'FLOW_NOT_RUNNABLE',
      `Flow "${flow.name}" (${flow.id}) is disabled — enable it first (PATCH /api/flows/${flow.id} {enabled:true}); a disabled flow cannot back a deliverable service`,
    );
  }
  if (flow.inputs_json === null) {
    throw new ApiError(
      422,
      'FLOW_INPUTS_REQUIRED',
      `Flow "${flow.name}" (${flow.id}) declares no inputs surface — publish requires one so the service ` +
        'interface is a contract; PATCH the flow with inputs: [] (zero-arg) or inputs: [{name, type, ...}] first',
    );
  }
  const agent = ctx.envStore.getAgent(providerAgentId)!;
  // T-201 server stamping convention (routes/flows.ts): the env owner IS the
  // unnamed author; any other created_by is the explicit author principal.
  const authorUserId =
    flow.created_by !== null && flow.created_by !== env.owner_id ? flow.created_by : undefined;
  if (!ownerEligibleForFlowAuthor(agent.owner_id, authorUserId)) {
    throw new ApiError(
      422,
      'SERVICE_BACKING_INVALID',
      `Provider agent "${agent.name}" (owner ${agent.owner_id}) is outside flow "${flow.name}"'s ` +
        `author scope (T-201: flow authors may only publish services fronted by their own agents — ` +
        `the flow runs in the PROVIDER's context, so authorship is the security model). ` +
        'Pick an agent owned by the flow author, or have the author re-create the flow',
    );
  }
  return flow;
}

/**
 * T-075 (R22, CC-F04): the world-aware countActive guidance. For every
 * countActive metric, the effective state key (metric.path ?? the 'active'
 * default) must be a key the SELECTED devices plausibly track — their
 * initialState keys ∪ the boolean spellings the power commands maintain
 * (power/on/powered). A key nobody tracks plausibly counts zero forever
 * (the finding: nobody ever writes 'active'). Non-blocking warnings (the
 * T-406 pattern): free-form state keys stay permissive, and actuation can
 * add keys later that initialState never declared.
 */
function countActiveStateKeyWarnings(
  ctx: ServiceRoutesContext,
  agent: AgentInstanceRow | undefined,
  scopedDevices: string[] | undefined,
  metrics: ComputationMetric[],
): string[] {
  // Type note: DeviceMetric['fn'] is the DeviceFn UNION, so an
  // Extract<…, {fn: 'countActive'}> literal narrows to never — the runtime
  // predicate is the narrowing, the type is the whole device-metric shape.
  const countActiveMetrics = metrics.filter(
    (metric): metric is DeviceMetric =>
      metric.source === 'device' && metric.fn === 'countActive',
  );
  if (countActiveMetrics.length === 0) return [];

  const boundIds = agent !== undefined ? parseJsonArray<string>(agent.bound_device_ids_json) : [];
  const selected = scopedDevices ?? boundIds;
  const tracked = new Set<string>(COUNT_ACTIVE_BOOLEAN_KEYS);
  for (const deviceId of selected) {
    const device = ctx.envStore.getDevice(deviceId);
    if (device === undefined) continue;
    for (const key of Object.keys(parseJsonObject(device.initial_state_json) ?? {})) {
      tracked.add(key);
    }
  }

  const warnings: string[] = [];
  for (const metric of countActiveMetrics) {
    const key = metric.path ?? 'active';
    if (tracked.has(key)) continue;
    warnings.push(
      `metrics[${countActiveMetrics.indexOf(metric)}] (countActive on "${metric.capability}") reads state key ` +
      `"${key}", which none of the ${selected.length} selected device(s) track — their tracked keys are ` +
      `${[...tracked].map(name => `"${name}"`).join(', ') || '(none)'}. ` +
      'The count will read 0 forever unless a command handler writes that key; ' +
      '"power" is the universal boolean the turn-on/turn-off commands maintain.',
    );
  }
  return warnings;
}

/**
 * T54 (R6, u4-F1): the world-aware "two faces" advisory. A device VALUE
 * metric (avg/min/max) whose state path shares a name with a ZONE parameter
 * (the standard snapshot set ∪ this world's declared zone baselines) reads
 * TWO different faces that drift apart: the zone face is physics-maintained
 * while the device face only moves when a command/tick effect writes it — a
 * scenario-declared initialState (e.g. `power: 0` on a meter) sits there
 * forever and reads as a fabricated measurement (u4's 电表: device 0 vs zone
 * 500 W). Non-blocking (the T-406 pattern) — the read gate
 * (COMPUTATION_DEVICE_STATE_UNWRITTEN) is the enforcement, this warning is
 * the early heads-up at registration time.
 */
/**
 * T78 (R8, u4-P1-3): the computation face of the ghost-event-type oracle —
 * an event metric (`countSince`) naming a type the env's scenario never
 * declares would read zero forever while looking like a legitimate series.
 * Declared types come from the env's bridged scenario — the SAME table the
 * inject lane checks (one oracle, every face). Non-blocking warnings; a
 * world that cannot bridge has no declaration table and stays permissive.
 */
function ghostEventTypeWarnings(
  ctx: ServiceRoutesContext,
  env: EnvironmentRow,
  metrics: ComputationMetric[],
): string[] {
  const eventMetrics = metrics.filter(
    (metric): metric is EventMetric => metric.source === 'event',
  );
  if (eventMetrics.length === 0) return [];
  let declared: Set<string>;
  try {
    const scenario = environmentToScenario(
      env,
      ctx.envStore.devicesOf(env.id),
      ctx.envStore.agentsOf(env.id),
    );
    declared = new Set(scenario.events.map(event => event.type));
  } catch {
    return []; // no declaration table reachable — nothing honest to claim
  }
  const warnings: string[] = [];
  for (const metric of eventMetrics) {
    if (declared.has(metric.eventType)) continue;
    warnings.push(
      `unrecognized event type "${metric.eventType}" (metric "${metric.as}"): this world's scenario never declares it — ` +
        'the metric will read 0 unless that type is injected at runtime (POST /api/simulations/:id/events); ' +
        `this world declares: ${[...declared].slice(0, 8).join(', ') || '(no events declared)'}`,
    );
  }
  return warnings;
}

function deviceZoneTwoFacesWarnings(
  ctx: ServiceRoutesContext,
  envId: string,
  agent: AgentInstanceRow | undefined,
  scopedDevices: string[] | undefined,
  metrics: ComputationMetric[],
): string[] {
  const valueMetrics = metrics.filter(
    (metric): metric is DeviceMetric =>
      metric.source === 'device' && typeof metric.path === 'string' &&
      (metric.fn === 'avg' || metric.fn === 'min' || metric.fn === 'max'),
  );
  if (valueMetrics.length === 0) return [];

  const zoneParameterNames = new Set<string>(SNAPSHOT_PARAMETERS);
  try {
    const env = ctx.envStore.getEnvironment(envId);
    if (env !== undefined) {
      for (const zone of parseMapData(env).zones) {
        for (const name of Object.keys(zone.baseline ?? {})) zoneParameterNames.add(name);
      }
    }
  } catch {
    // map-less envs keep just the standard set
  }

  const warnings: string[] = [];
  for (const metric of valueMetrics) {
    const path = metric.path as string;
    if (!zoneParameterNames.has(path)) continue;
    warnings.push(
      `metrics[${metrics.indexOf(metric)}] (avg/min/max on "${metric.capability}" state path "${path}") shares its ` +
      `name with a ZONE parameter — this world maintains "${path}" on the zone face, while the device-state ` +
      'face only moves when a command or tick effect writes it. If the devices never write that path, reads ' +
      `refuse with COMPUTATION_DEVICE_STATE_UNWRITTEN (placeholder, not measurement). Prefer a source:"zone" ` +
      'metric over the zone parameter, or make the device physics write the state path.',
    );
  }
  return warnings;
}
