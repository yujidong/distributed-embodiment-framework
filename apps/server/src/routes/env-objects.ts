/**
 * World-object routes — device and agent instances inside environments
 *
 * Fix-1 (unified change pipeline, multi-user-simulation-design.md §4.1):
 * structural changes to the shared world are GOVERNED. The old "builder
 * edits directly" behavior is gone:
 *
 * - `POST   /api/environments/:id/devices`  owner: creates directly
 *     (audited as `env-direct-edit` in command_log). builder: the call is
 *     converted into an `install-devices` proposal and the PROPOSAL is
 *     returned (201) — the device lands only if the pipeline approves it.
 * - `PATCH  /api/devices/:id`               env owner: edits directly
 *     (audited). builder patching THEIR OWN device: converted into a
 *     `modify-object` proposal (201, R98) — the change lands only if the
 *     pipeline approves it. Patching someone else's device stays a 403.
 * - `DELETE /api/devices/:id`               env owner: deletes directly
 *     (audited). builder deleting THEIR OWN device: converted into a
 *     `remove-devices` proposal (201, Fix-7); anything else is 403.
 * - `POST   /api/environments/:id/agents`   owner: creates directly
 *     (audited). builder: converted into an `install-agents` proposal
 *     (201, Fix-7) — the agent lands only if the pipeline approves it.
 * - `POST   /api/environments/:id/zones`    owner: creates directly
 *     (audited, same validation). builder: converted into an
 *     `install-zones` proposal (201, T-055) — the zones land only if the
 *     pipeline approves it (low risk: AI review; apply merges them into
 *     mapData, revert removes them while still empty).
 * - `PATCH  /api/agents/:id`                env owner: any field (audited).
 *     R5-F03: the AGENT's owner may directly patch pure decision config
 *     (llm / decisionPolicy / enabled, audited); structural fields stay
 *     on the modify-object proposal lane.
 *     T-715 alias: PATCH /api/environments/:id/agents/:agentId (same core,
 *     env-scoped AGENT_NOT_FOUND teaching 404).
 * - `DELETE /api/agents/:id`                env owner only (audited).
 *
 * Every mutation publishes a world-change message (WorldSync) carrying the
 * actor so subscribers of `/api/environments/:id/stream` see edits — and
 * who made them — in real time (last-write-wins + broadcast,
 * product_design.md §11.6).
 */

import type { FastifyInstance } from 'fastify';

import type { AuthUser } from '../auth/index.js';

import type { ChangePipeline } from '../change-pipeline.js';
import { ApiError } from '../errors.js';
import {
  getEnvironmentOrThrow,
  requireAgentPatchAccess,
  requireBuilderOrOwner,
  requireDirectEditAccess,
  requireReadAccess,
} from '../env-access.js';
import { validateDevicePositionForEnv } from '../geo.js';
import { agentToJson, deviceToJson, ownerRef, serviceToJson, zonesOf } from '../env-serializers.js';
import {
  parseJsonArray,
  parseJsonObject,
  parseMapData,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvironmentStore,
} from '../db/environment-store.js';
import { projectDeviceJson, type DeviceJsonView } from '../device-privacy.js';
import { deviceOracleFor, deviceViewerOf } from '../device-viewer.js';
import {
  unbackedFlagsForEnv,
  type DerivedSyncChange,
  type ServiceStore,
} from '../db/service-store.js';
import {
  ownerRefFor,
  publishServiceChanges,
  syncDerivedForAgentWithNotices,
  syncDerivedForDeviceWithNotices,
} from '../service-derivation-sync.js';
import {
  PROVIDER_UNAVAILABLE_REASON,
  type AgreementStore,
} from '../db/agreement-store.js';
import { noHistoryView, type ReputationStore } from '../db/reputation-store.js';
import type { CommandLogStore } from '../db/proposal-store.js';
import { notify, NOTIFICATION_KINDS } from '../notifications.js';
import type { NotificationStore } from '../db/notification-store.js';
import type { StandingAskMatchDeps } from '../standing-asks.js';
import { t } from '../i18n/index.js';
import type { UiLocale } from '@active-collaboration/shared';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import type { ProposalService } from '../proposal-service.js';
import { assertQuota, type QuotaConfig } from '../quotas.js';
import type { SimulationRegistry } from '../simulation-registry.js';
import { isCapabilityExecutable } from '@active-collaboration/simulation';

import { checkCapabilityBacking, deviceAgentBindingHint, validateProposedZones } from '../proposal-rules.js';
import { proposalToJson } from './proposals.js';

/** command_log kind for owner direct structural edits (Fix-1). */
export const ENV_DIRECT_EDIT_KIND = 'env-direct-edit';

export interface EnvObjectRoutesContext {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  reputationStore: ReputationStore;
  userStore: UserStore;
  /** Fix-10: proposal serialization reads back created ids from the apply entry. */
  commandLogStore: CommandLogStore;
  /** Fix-1: unified change recording (command_log + actor-carrying broadcast). */
  pipeline: ChangePipeline;
  /** Fix-1: builder device-creations are converted into proposals. */
  proposalService: ProposalService;
  /** P4-4 quotas (devices_per_env / agents_per_env enforced on create). */
  quotas: QuotaConfig;
  /** Agent 启停（migration v21）：enabled 切换同步到本环境运行中的仿真。 */
  registry: SimulationRegistry;
  /**
   * S2 (device privacy): deployment admins are full-tier device viewers.
   * Optional: tests may omit (no admins).
   */
  adminEmails?: string[];
  /**
   * T-403 (R19): owner-direct PATCH derivation syncs notify consumers of
   * agreements destroyed by row regeneration (same helper the proposal
   * service uses). Optional — minimal contexts degrade to no notices.
   * v60 (R6-E-F08): also the retire lane of DELETE /api/agents/:id (the
   * provider's agreements are suspended/rejected/terminated + unlinked, not
   * cascade-destroyed).
   */
  agreementStore?: AgreementStore;
  notificationStore?: NotificationStore;
  /**
   * T-069 (R23): when present, derivation-sync CREATED services run the
   * standing-ask matcher (需求板) — optional so minimal contexts skip it.
   */
  standingAsks?: StandingAskMatchDeps;
  /**
   * R5-F12 (drill visibility): the deployment's pinned model (LLM_MODEL) —
   * threaded into agent responses as `effectiveModel` so callers see the
   * model actually served after request-time normalization. Optional:
   * minimal contexts omit the field.
   */
  deployedLlmModel?: string;
}

interface IdParams {
  id: string;
}

export function registerEnvObjectRoutes(app: FastifyInstance, ctx: EnvObjectRoutesContext): void {
  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  // T-038 (R11 RF-F06): the devices list GET — the POST-only path forced API
  // users to pull the whole environment detail just to enumerate devices.
  // Same read gate as the detail view (anonymous may read public envs).
  // S2 (device privacy): projected through the canonical seam — full for the
  // device owner / env owner / admin, coarse for everyone else.
  app.get(
    '/api/environments/:id/devices',
    { preHandler: app.optionalAuth },
    async request => {
      const { id } = request.params as IdParams;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
      requireReadAccess(env, role);
      const viewer = deviceViewerOf(ctx, request.user);
      const ownershipOf = deviceOracleFor(ctx.envStore);
      return {
        devices: ctx.envStore.devicesOf(env.id).map(row =>
          projectDeviceJson(
            deviceToJson(row, ownerRefFor(ctx, row.owner_id)) as DeviceJsonView,
            viewer,
            ownershipOf(row.id),
            parseJsonObject(row.initial_state_json),
          ),
        ),
      };
    },
  );

  // T-038 (R11 FF-F02): single-device fetch — the path only had PATCH/DELETE,
  // so there was no way to read one device without filtering the whole env.
  app.get('/api/devices/:id', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as IdParams;
    const device = getDeviceOrThrow(ctx.envStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, device.env_id);
    const role = request.user ? ctx.envStore.roleOf(env.id, request.user.id) : undefined;
    requireReadAccess(env, role);
    return projectDeviceJson(
      deviceToJson(device, ownerRefFor(ctx, device.owner_id)) as DeviceJsonView,
      deviceViewerOf(ctx, request.user),
      deviceOracleFor(ctx.envStore)(device.id),
      parseJsonObject(device.initial_state_json),
    );
  });

  app.post(
    '/api/environments/:id/devices',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = requireBuilderOrOwner(ctx.envStore, id, user);
      // P4-4 quota: devices per environment.
      assertQuota('devices_per_env', ctx.quotas.maxDevicesPerEnv, ctx.envStore.countDevicesIn(id));

      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = requireNonEmptyString(body.name, 'name');
      const type = requireNonEmptyString(body.type, 'type');
      const capabilities = requireStringArray(body.capabilities, 'capabilities');
      const zoneId = requireNonEmptyString(body.zoneId, 'zoneId');
      requireZone(env, zoneId);
      const brand = optionalString(body.brand, 'brand');
      const position = optionalObject(body.position, 'position');
      validateDevicePositionForEnv(env.map_type, position);
      const initialState = optionalObject(body.initialState, 'initialState');
      // Fix-18 (R7 F-01): the deployment binding is part of the create. It
      // rides the proposal pipeline like every other field — a hass://
      // binding makes the rule check force-escalate to the owner (same gate
      // as a modify-object rebind), never silently dropped.
      const binding = body.binding !== undefined ? optionalBinding(body.binding) : undefined;

      // Fix-1: a builder's create is a structural change to the SHARED world
      // — it is converted into an install-devices proposal (same payload
      // shape as the direct call) and the proposal is what comes back.
      if (role !== 'owner') {
        const proposal = await ctx.proposalService.submit(env, user, 'install-devices', {
          devices: [
            {
              name,
              type,
              ...(brand !== undefined ? { brand } : {}),
              capabilities,
              zoneId,
              ...(position !== undefined ? { position } : {}),
              ...(initialState !== undefined ? { initialState } : {}),
              ...(binding !== undefined && binding !== null ? { binding } : {}),
            },
          ],
        }, request.locale);
        // R100: the governed path warns too — a builder declaring
        // handler-less capabilities used to hear nothing until every invoke
        // failed (the owner-create path has warned since TASK-002).
        const warnings = capabilityWarnings(capabilities);
        const json = proposalToJson(ctx, proposal);
        return reply.code(201).send(warnings.length > 0 ? { ...json, warnings } : json);
      }

      let row = ctx.envStore.createDevice({
        envId: id,
        ownerId: user.id,
        name,
        type,
        ...(brand !== undefined ? { brand } : {}),
        capabilities,
        zoneId,
        ...(position !== undefined ? { position } : {}),
        ...(initialState !== undefined ? { initialState } : {}),
      });
      if (binding !== undefined && binding !== null) {
        row = ctx.envStore.updateDevice(row.id, { binding });
      }
      const json = deviceToJson(row, ownerRefFor(ctx, row.owner_id));
      logDirectEdit(ctx, env.id, user.id, {
        objectType: 'device',
        action: 'created',
        objectId: row.id,
        before: null,
        after: json,
      });
      ctx.pipeline.publish(id, 'created', 'device', json, user.id);
      // TASK-002: warn when declared capabilities have no command handler —
      // the #1 new-user trap was devices that silently can't do anything.
      // C2 (R25-NF3, DevLoop R28): + the derived-service binding hint — a
      // freshly created device has no bound agent and publishes nothing
      // until one binds it (the R25 provider story: device applied, no
      // service, no hint).
      const warnings = [
        ...capabilityWarnings(capabilities),
        ...(capabilities.length > 0 ? [deviceAgentBindingHint(name)] : []),
      ];
      if (warnings.length > 0) return reply.code(201).send({ ...json, warnings });
      return reply.code(201).send(json);
    },
  );

  app.patch('/api/devices/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const existing = getDeviceOrThrow(ctx.envStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    const beforeJson = deviceToJson(existing, ownerRefFor(ctx, existing.owner_id));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<EnvironmentStore['updateDevice']>[1] = {};
    if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
    if (body.type !== undefined) patch.type = requireNonEmptyString(body.type, 'type');
    if (body.brand !== undefined) patch.brand = optionalString(body.brand, 'brand') ?? null;
    if (body.capabilities !== undefined) {
      patch.capabilities = requireStringArray(body.capabilities, 'capabilities');
    }
    if (body.zoneId !== undefined) {
      const zoneId = requireNonEmptyString(body.zoneId, 'zoneId');
      requireZone(env, zoneId);
      patch.zoneId = zoneId;
    }
    if (body.position !== undefined) {
      const position = optionalObject(body.position, 'position') ?? null;
      validateDevicePositionForEnv(env.map_type, position);
      patch.position = position;
    }
    if (body.initialState !== undefined) {
      patch.initialState = optionalObject(body.initialState, 'initialState') ?? null;
    }
    if (body.binding !== undefined) {
      // P3b deployment binding: hass://<entity-id> for real actuation, null
      // (or a sim:// URI) to return to simulation. Takes effect on the NEXT
      // simulation created from this environment — running sims are built
      // already and are unaffected. Entity existence is validated at
      // sim-create time (400 HASS_UNKNOWN_ENTITY), not here.
      patch.binding = optionalBinding(body.binding);
    }
    // T-021: explicit sensor/actuator/hybrid role (null resets to capability
    // inference). Interactive editing keeps parity with the scenario-import
    // declaration lane.
    if (body.role !== undefined) {
      if (body.role === null) {
        patch.role = null;
      } else if (
        body.role !== 'sensor' && body.role !== 'actuator' && body.role !== 'hybrid'
      ) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "role" must be one of sensor | actuator | hybrid (or null to reset ' +
            'to capability inference)',
        );
      } else {
        patch.role = body.role;
      }
    }

    // Fix-1: direct edits are owner-only; builders use the proposal pipeline.
    // R98 (simtest-r1 li-01/li-03, P0): a builder patching THEIR OWN device
    // rides the SAME conversion device add/rm already take — the call becomes
    // a modify-object proposal (201; rule check + AI review, auto-apply or
    // owner approval) instead of a dead-end 403. The modify-object rule
    // checker validates the patch (note: 'role' is owner-direct only today —
    // a proposal carrying it is rule-rejected with the supported list).
    if (
      existing.owner_id === user.id &&
      ctx.envStore.roleOf(env.id, user.id) === 'builder'
    ) {
      if (Object.keys(patch).length === 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body must name at least one patchable field (name, type, brand, capabilities, ' +
            'zoneId, position, initialState, binding, role)',
        );
      }
      const proposal = await ctx.proposalService.submit(env, user, 'modify-object', {
        targetId: id,
        patch,
      }, request.locale);
      return reply.code(201).send(proposalToJson(ctx, proposal));
    }
    requireDirectEditAccess(env, user, 'device');

    const row = ctx.envStore.updateDevice(id, patch);
    const json = deviceToJson(row, ownerRefFor(ctx, row.owner_id));
    logDirectEdit(ctx, env.id, user.id, {
      objectType: 'device',
      action: 'updated',
      objectId: id,
      before: beforeJson,
      after: json,
    });
    ctx.pipeline.publish(env.id, 'updated', 'device', json, user.id);
    // Derivation sync: capability changes (and renames) refresh the derived
    // services of every agent bound to this device. T-403: run through the
    // honesty wrapper — agreements riding a regenerated-away row cascade-
    // delete; their consumers get the doorbell + successor hints.
    if (patch.capabilities !== undefined || patch.name !== undefined) {
      publishServiceChanges(ctx, env.id, syncDerivedForDeviceWithNotices(ctx, id, user.id), user.id);
    }
    return json;
  });

  app.delete('/api/devices/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const existing = getDeviceOrThrow(ctx.envStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);

    // Fix-7: a builder deleting THEIR OWN device is a governed structural
    // change — the call is converted into a remove-devices proposal (the
    // pipeline approves it; agent-bound devices are rejected by the rule
    // checker). Deleting someone else's device stays a hard 403.
    if (existing.owner_id === user.id && ctx.envStore.roleOf(env.id, user.id) === 'builder') {
      const proposal = await ctx.proposalService.submit(env, user, 'remove-devices', {
        deviceIds: [id],
      }, request.locale);
      return reply.code(201).send(proposalToJson(ctx, proposal));
    }
    // Fix-1: direct edits are owner-only; builders use the proposal pipeline.
    requireDirectEditAccess(env, user, 'device');
    const beforeJson = deviceToJson(existing, ownerRefFor(ctx, existing.owner_id));

    // Derived services sourced from this device go first (world-sync needs
    // their ids; the derivation sync is the authority, not the FK SET NULL).
    publishServiceChanges(ctx, env.id, ctx.serviceStore.deleteDerivedForDevice(id), user.id);
    ctx.envStore.deleteDevice(id);
    // The FK cascade removes any remaining service rows sourced from this
    // device without touching the store write methods — notify explicitly so
    // the live-runtime world: mirror converges (service-catalog-sync).
    ctx.serviceStore.notifyCatalogChange(env.id);
    logDirectEdit(ctx, env.id, user.id, {
      objectType: 'device',
      action: 'deleted',
      objectId: id,
      before: beforeJson,
      after: null,
    });
    ctx.pipeline.publish(env.id, 'deleted', 'device', { id }, user.id);
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Zones (T-055: governed zone creation — the R12 dead-lock fix)
  // -------------------------------------------------------------------------

  // NF2702 (DevLoop R28, T-038 read-surface parity): the zones list GET —
  // the POST-only path left API users filtering the whole env detail just to
  // enumerate zones. Same read gate as the detail view (anonymous may read
  // public envs); rows identical to the detail's zones array (zonesOf).
  app.get(
    '/api/environments/:id/zones',
    { preHandler: app.optionalAuth },
    async request => {
      const { id } = request.params as IdParams;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
      requireReadAccess(env, role);
      return { zones: zonesOf(env) };
    },
  );

  app.post(
    '/api/environments/:id/zones',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = requireBuilderOrOwner(ctx.envStore, id, user);

      const body = (request.body ?? {}) as Record<string, unknown>;
      // Single-zone body, mirroring the devices route's one-object-per-call
      // shape; batch creation goes through POST /proposals directly.
      const zoneId = requireNonEmptyString(body.id, 'id');
      const zone: Record<string, unknown> = { id: zoneId };
      if (body.name !== undefined) zone.name = requireNonEmptyString(body.name, 'name');
      if (body.type !== undefined) zone.type = requireNonEmptyString(body.type, 'type');
      if (body.bounds !== undefined) zone.bounds = optionalObject(body.bounds, 'bounds');
      if (body.polygon !== undefined) zone.polygon = body.polygon;
      if (body.adjacentZoneIds !== undefined) {
        zone.adjacentZoneIds = requireStringArray(body.adjacentZoneIds, 'adjacentZoneIds');
      }
      if (body.baseline !== undefined) zone.baseline = optionalObject(body.baseline, 'baseline');
      // R15 (CP-F01/DB-F01/FR15-F01): consentClass is OWNER-authored
      // governance metadata — arming it must never ride the proposal
      // pipeline. A builder sending it gets a teaching rejection instead of
      // the silent drop that left ward-101 unguarded all round (the exact
      // FR-F05 replay).
      if (body.consentClass !== undefined) {
        if (typeof body.consentClass !== 'string') {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Body field "consentClass" must be one of "standard" | "supervised" | "restricted"',
          );
        }
        if (role !== 'owner') {
          throw new ApiError(
            400,
            'CONSENT_CLASS_NOT_PROPOSABLE',
            `Body field "consentClass" ("${body.consentClass}") cannot ride a builder zone ` +
              'creation — zone consent classes are owner-authored governance metadata ' +
              '(design-consent-semantics.md §3.1). Submit the zone without it; after the owner ' +
              'approves, they can arm it via PATCH /api/environments/{id} (mapData) — or create ' +
              'the zone themselves with consentClass on this same endpoint',
          );
        }
        zone.consentClass = body.consentClass;
      }

      // T-055: a builder's zone create is a structural change to the SHARED
      // world — converted into an install-zones proposal (same payload shape
      // as the direct call) and the proposal is what comes back. The rule
      // check teaches id/bounds/adjacency/quota issues on rejection.
      if (role !== 'owner') {
        const proposal = await ctx.proposalService.submit(env, user, 'install-zones', {
          zones: [zone],
        }, request.locale);
        return reply.code(201).send(proposalToJson(ctx, proposal));
      }

      // Owner: the SAME validation the rule check runs (one validator, two
      // approval tiers — no drift), then the immediate mapData merge. R15:
      // consentClass rides along (enum-validated inside the shared
      // validator, same list as the mapData PATCH path).
      const verdict = validateProposedZones(env, [zone], ctx.quotas.maxZonesPerEnv, {
        allowConsentClass: true,
      });
      if (verdict.issues.length > 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Zone "${zoneId}" failed validation: ${verdict.issues.join('; ')}`,
          verdict.issues,
        );
      }
      const mapData = parseMapData(env);
      const updated = ctx.envStore.updateEnvironment(id, {
        mapData: { ...mapData, zones: [...mapData.zones, ...verdict.zones] },
      });
      const created = verdict.zones[0]!;
      logDirectEdit(ctx, env.id, user.id, {
        objectType: 'environment',
        action: 'created',
        objectId: zoneId,
        before: null,
        after: created,
      });
      // Same broadcast shape as the owner's PATCH mapData path.
      ctx.pipeline.publish(id, 'updated', 'environment', {
        id: updated.id,
        name: updated.name,
        mapType: updated.map_type,
        zones: zonesOf(updated),
        updatedAt: updated.updated_at,
      }, user.id);
      return reply.code(201).send(created);
    },
  );

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  // NF2702 (DevLoop R28, T-038 read-surface parity): the agents list GET —
  // same read gate as the detail view (anonymous may read public envs);
  // rows identical to the detail's agents array (agentToJson, owner ref
  // included). Useful for pagination at campus scale where the env detail
  // is the heaviest payload on the wire.
  app.get(
    '/api/environments/:id/agents',
    { preHandler: app.optionalAuth },
    async request => {
      const { id } = request.params as IdParams;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
      requireReadAccess(env, role);
      return {
        agents: ctx.envStore.agentsOf(env.id).map(row =>
          agentToJson(row, ownerRefFor(ctx, row.owner_id), ctx.deployedLlmModel),
        ),
      };
    },
  );

  app.post(
    '/api/environments/:id/agents',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const role = requireBuilderOrOwner(ctx.envStore, id, user);
      // P4-4 quota: agents per environment.
      assertQuota('agents_per_env', ctx.quotas.maxAgentsPerEnv, ctx.envStore.countAgentsIn(id));

      const body = (request.body ?? {}) as Record<string, unknown>;
      const name = requireNonEmptyString(body.name, 'name');
      const capabilities = requireStringArray(body.capabilities, 'capabilities');
      const boundDeviceIds = optionalStringArray(body.boundDeviceIds, 'boundDeviceIds') ?? [];
      const managedZoneIds = optionalStringArray(body.managedZoneIds, 'managedZoneIds') ?? [];
      const llm = parseAgentLlm(body.llm);
      // T-051: per-agent decision policy (author's actuation defaults).
      const decisionPolicy = parseAgentDecisionPolicy(body.decisionPolicy);
      // R15 (FR15-F02): install-time default visibility for FUTURE derived
      // services — a vitals agent can be born hidden instead of
      // members-visible until a later hide PATCH (the live-round leak
      // window). Closed enum; typos are named, never dropped.
      if (
        body.derivedServiceVisibility !== undefined &&
        body.derivedServiceVisibility !== 'members' &&
        body.derivedServiceVisibility !== 'hidden'
      ) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "derivedServiceVisibility" must be one of "members" | "hidden" — got ` +
            `${JSON.stringify(body.derivedServiceVisibility)} ('hidden' derives future services ` +
          'hidden from the first moment; absent keeps the members default, and per-service ' +
          'PATCH visibility still overrides on surviving rows)',
        );
      }
      const derivedServiceVisibility = body.derivedServiceVisibility as 'members' | 'hidden' | undefined;
      // T-604 (R26, HO26-F01): scope-of-practice blocklist accepted at
      // birth (same semantics as the PATCH lane — null/[] clears).
      let cannotDeliverClasses: string[] | null | undefined = undefined;
      if (body.cannotDeliverClasses !== undefined) {
        if (body.cannotDeliverClasses === null) {
          cannotDeliverClasses = null;
        } else if (
          !Array.isArray(body.cannotDeliverClasses) ||
          body.cannotDeliverClasses.some(c => typeof c !== 'string' || c.trim().length === 0)
        ) {
          throw new ApiError(
            400,
            'BAD_REQUEST',
            'Body field "cannotDeliverClasses" must be an array of non-empty strings (or null to clear)',
          );
        } else {
          cannotDeliverClasses = body.cannotDeliverClasses as string[];
        }
      }

      // Fix-7: a builder's create is a structural change to the SHARED world
      // — it is converted into an install-agents proposal (same payload shape
      // as the direct call) and the proposal is what comes back. Device
      // existence/ownership (设备私有) is enforced by the rule checker.
      if (role !== 'owner') {
        const proposal = await ctx.proposalService.submit(env, user, 'install-agents', {
          agents: [
            {
              name,
              capabilities,
              boundDeviceIds,
              managedZoneIds,
              ...(llm !== undefined ? { llm } : {}),
              ...(cannotDeliverClasses !== undefined ? { cannotDeliverClasses } : {}),
              ...(decisionPolicy !== undefined ? { decisionPolicy } : {}),
              ...(derivedServiceVisibility !== undefined ? { derivedServiceVisibility } : {}),
            },
          ],
        }, request.locale);
        return reply.code(201).send(proposalToJson(ctx, proposal));
      }

      requireDevicesInEnv(ctx, env, boundDeviceIds);

      // T-206 capability honesty (owner-direct create): declared capabilities
      // must be provided by the bound devices — same matcher as the flow
      // runtime (deviceProvides), same teaching error as the proposal path.
      // hass://-bound devices are exempt (real hardware).
      {
        const backingIssues: string[] = [];
        checkCapabilityBacking(
          capabilities,
          boundDeviceIds.map(deviceId => ctx.envStore.getDevice(deviceId)!).filter(row => row !== undefined),
          'capabilities',
          backingIssues,
        );
        if (backingIssues.length > 0) {
          throw new ApiError(422, 'AGENT_CAPABILITIES_UNBACKED', backingIssues[0], backingIssues);
        }
      }

      const row = ctx.envStore.createAgent({
        envId: id,
        ownerId: user.id,
        name,
        capabilities,
        boundDeviceIds,
        managedZoneIds,
        ...(llm !== undefined ? { llm } : {}),
        ...(cannotDeliverClasses !== undefined ? { cannotDeliverClasses } : {}),
        ...(decisionPolicy !== undefined ? { decisionPolicy } : {}),
        ...(derivedServiceVisibility !== undefined ? { derivedServiceVisibility } : {}),
      });
      const json = agentToJson(row, ownerRefFor(ctx, row.owner_id), ctx.deployedLlmModel);
      logDirectEdit(ctx, env.id, user.id, {
        objectType: 'agent',
        action: 'created',
        objectId: row.id,
        before: null,
        after: json,
      });
      ctx.pipeline.publish(id, 'created', 'agent', json, user.id);
      // Derivation: one service per (bound device × capability).
      publishServiceChanges(ctx, id, ctx.serviceStore.syncDerivedForAgent(row.id), user.id);
      return reply.code(201).send(json);
    },
  );

  app.patch('/api/agents/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const existing = getAgentOrThrow(ctx.envStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    return applyAgentPatch(ctx, env, existing, user, (request.body ?? {}) as Record<string, unknown>);
  });

  // T-715 (R29, F-PH25): the env-scoped alias of PATCH /api/agents/:id — the
  // sibling subpaths (/services, /reputation) live under this prefix, so the
  // R29 physics tester reasonably reached for it and got ROUTE_NOT_FOUND.
  // Same handler core (owner-only direct edit, audited); the env scoping adds
  // an AGENT_NOT_FOUND teaching 404 when the agent belongs to another env.
  app.patch(
    '/api/environments/:id/agents/:agentId',
    { preHandler: app.authenticate },
    async request => {
      const { id, agentId } = request.params as { id: string; agentId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      const existing = ctx.envStore.getAgent(agentId);
      if (!existing || existing.env_id !== env.id) {
        throw new ApiError(
          404,
          'AGENT_NOT_FOUND',
          `Agent "${agentId}" does not exist in environment "${env.id}"`,
        );
      }
      return applyAgentPatch(ctx, env, existing, user, (request.body ?? {}) as Record<string, unknown>);
    },
  );

  app.delete('/api/agents/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const existing = getAgentOrThrow(ctx.envStore, id);
    const env = getEnvironmentOrThrow(ctx.envStore, existing.env_id);
    // T-209: a builder removing THEIR OWN agent is a governed lifecycle
    // change — the call is converted into a remove-agents proposal (the
    // pipeline approves it; the rule checker rejects foreign agents).
    // Removing someone else's agent stays a hard 403.
    if (existing.owner_id === user.id && ctx.envStore.roleOf(env.id, user.id) === 'builder') {
      const proposal = await ctx.proposalService.submit(env, user, 'remove-agents', {
        agentIds: [id],
      }, request.locale);
      return reply.code(201).send(proposalToJson(ctx, proposal));
    }
    // Fix-1: direct edits are owner-only; builders use the proposal pipeline.
    requireDirectEditAccess(env, user, 'agent');
    const beforeJson = agentToJson(existing, ownerRefFor(ctx, existing.owner_id));

    // Services cascade in the database; collect ids first so subscribers see
    // the removals (derived + published alike).
    const serviceIds = ctx.serviceStore.servicesOfAgent(id).map(row => row.id);
    // v60 (R6-E-F08): RETIRE the provider's agreements BEFORE the row delete —
    // active/held → suspended, pending offers → rejected, ephemeral AC →
    // terminated (status_reason 'provider-unavailable'), then unlinked so the
    // FK cascades delete nothing: the ledger (terminated history + append-only
    // usage/receipts) survives the provider's removal. Snapshot the display
    // names first — the unlink below erases the references for good.
    const preRetire = ctx.agreementStore?.agreementsOfProviderAgent(id) ?? [];
    const serviceNameOf = new Map(
      preRetire.map(row => [
        row.id,
        row.service_id !== null
          ? (ctx.serviceStore.getService(row.service_id)?.name ?? null)
          : null,
      ] as const),
    );
    const retired = ctx.agreementStore?.retireProviderAgreements(id) ?? [];
    ctx.envStore.deleteAgent(id);
    // The FK cascade removes the agent's service rows without touching the
    // store write methods — notify explicitly so the live-runtime world:
    // mirror converges (service-catalog-sync).
    ctx.serviceStore.notifyCatalogChange(env.id);
    // v60: each retired agreement lands the SAME honesty footprint a
    // party-driven transition would — consumer doorbell, env-stream
    // broadcast, agreement-transition audit row (T-025/T-049 parity).
    for (const { row, from } of retired) {
      // retireProviderAgreements only ever lands suspended/rejected/
      // terminated — all valid stream actions (AgreementStatus is wider).
      ctx.pipeline.publishAgreement(
        env.id,
        row.status as 'suspended' | 'rejected' | 'terminated',
        row.id,
        user.id,
      );
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'agreement-transition',
        payload: {
          agreementId: row.id,
          serviceId: preRetire.find(pre => pre.id === row.id)?.service_id ?? null,
          from,
          to: row.status,
          reason: PROVIDER_UNAVAILABLE_REASON,
          providerAgentId: id,
        },
      });
      if (ctx.notificationStore !== undefined) {
        notify(ctx.notificationStore, {
          recipientId: row.consumer_owner_id,
          actorId: user.id,
          envId: env.id,
          kind: NOTIFICATION_KINDS.agreementProviderRemoved,
          title: t(request.locale, 'chrome.notif.agreementProviderRemoved'),
          body: {
            agreementId: row.id,
            serviceId: preRetire.find(pre => pre.id === row.id)?.service_id ?? null,
            serviceName: serviceNameOf.get(row.id) ?? null,
            providerAgentId: id,
            providerAgentName: existing.name,
            from,
            status: row.status,
            reason: PROVIDER_UNAVAILABLE_REASON,
          },
          refId: row.id,
        });
      }
    }
    logDirectEdit(ctx, env.id, user.id, {
      objectType: 'agent',
      action: 'deleted',
      objectId: id,
      before: beforeJson,
      after: null,
    });
    ctx.pipeline.publish(env.id, 'deleted', 'agent', { id }, user.id);
    for (const serviceId of serviceIds) {
      ctx.pipeline.publish(env.id, 'deleted', 'service', { id: serviceId }, user.id);
    }
    return reply.code(204).send();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeviceOrThrow(store: EnvironmentStore, id: string): DeviceInstanceRow {
  const row = store.getDevice(id);
  if (!row) throw new ApiError(404, 'DEVICE_NOT_FOUND', `Device "${id}" not found`);
  return row;
}

function getAgentOrThrow(store: EnvironmentStore, id: string): AgentInstanceRow {
  const row = store.getAgent(id);
  if (!row) throw new ApiError(404, 'AGENT_NOT_FOUND', `Agent "${id}" not found`);
  return row;
}

/**
 * PATCH /api/agents/:id and its env-scoped alias (T-715) share this core:
 * owner-only direct edit (Fix-1), T-021/T-051 patchable fields, T-206
 * capability backing, command-log audit, world broadcast, derivation sync
 * (T-403) and enabled → live-sim sync (migration v21).
 */
async function applyAgentPatch(
  ctx: EnvObjectRoutesContext,
  env: EnvironmentRow,
  existing: AgentInstanceRow,
  user: AuthUser,
  body: Record<string, unknown>,
): Promise<ReturnType<typeof agentToJson>> {
  // Fix-1: direct edits are owner-only; builders use the proposal pipeline.
  // R5-F03: ONE exception — the agent's owner may directly patch its pure
  // decision configuration (llm / decisionPolicy / enabled); the body is
  // part of the gate, so parse/validation still runs only after access.
  requireAgentPatchAccess(env, existing, user, body);
  const beforeJson = agentToJson(existing, ownerRefFor(ctx, existing.owner_id));

  const patch: Parameters<EnvironmentStore['updateAgent']>[1] = {};
  if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
  if (body.capabilities !== undefined) {
    patch.capabilities = requireStringArray(body.capabilities, 'capabilities');
  }
  if (body.boundDeviceIds !== undefined) {
    const boundDeviceIds = optionalStringArray(body.boundDeviceIds, 'boundDeviceIds') ?? [];
    requireDevicesInEnv(ctx, env, boundDeviceIds);
    patch.boundDeviceIds = boundDeviceIds;
  }
  if (body.managedZoneIds !== undefined) {
    patch.managedZoneIds = optionalStringArray(body.managedZoneIds, 'managedZoneIds') ?? [];
  }
  if (body.llm !== undefined) patch.llm = parseAgentLlm(body.llm) ?? null;
  if (body.enabled !== undefined) patch.enabled = requireBoolean(body.enabled, 'enabled');
  // T-021: scope-of-practice blocklist joins the patchable fields (null or
  // [] clears to no restriction). Interactive editing keeps parity with the
  // scenario-import declaration lane.
  if (body.cannotDeliverClasses !== undefined) {
    if (body.cannotDeliverClasses === null) {
      patch.cannotDeliverClasses = null;
    } else {
      patch.cannotDeliverClasses = requireStringArray(
        body.cannotDeliverClasses,
        'cannotDeliverClasses',
      );
    }
  }
  // T-051: the decision policy joins the patchable fields (null clears).
  if (body.decisionPolicy !== undefined) {
    patch.decisionPolicy = parseAgentDecisionPolicy(body.decisionPolicy) ?? null;
  }

  // T-206 capability honesty (owner-direct patch): when capabilities or
  // bindings change, the RESULTING declaration must stay backed by the
  // resulting bound devices (same matcher + exemptions as every other
  // agent-authoring path).
  if (patch.capabilities !== undefined || patch.boundDeviceIds !== undefined) {
    const nextCapabilities = patch.capabilities ?? parseJsonArray<string>(existing.capabilities_json);
    const nextBoundIds = patch.boundDeviceIds ?? parseJsonArray<string>(existing.bound_device_ids_json);
    const backingIssues: string[] = [];
    checkCapabilityBacking(
      nextCapabilities,
      nextBoundIds.map(deviceId => ctx.envStore.getDevice(deviceId)!).filter(row => row !== undefined),
      'capabilities',
      backingIssues,
    );
    if (backingIssues.length > 0) {
      throw new ApiError(422, 'AGENT_CAPABILITIES_UNBACKED', backingIssues[0], backingIssues);
    }
  }

  const row = ctx.envStore.updateAgent(existing.id, patch);
  // R5-F12: the response carries effectiveModel (post-normalization actual
  // model) so a drill operator PATCHing llm.model sees the rewrite at once.
  const json = agentToJson(row, ownerRefFor(ctx, row.owner_id), ctx.deployedLlmModel);
  logDirectEdit(ctx, env.id, user.id, {
    objectType: 'agent',
    action: 'updated',
    objectId: existing.id,
    before: beforeJson,
    after: json,
  });
  ctx.pipeline.publish(env.id, 'updated', 'agent', json, user.id);
  // Derivation sync: rebinding devices adds/removes derived services.
  // T-403: same honesty wrapper as the device PATCH (unbound-device rows
  // regenerate away and take their agreements with them).
  if (patch.boundDeviceIds !== undefined) {
    publishServiceChanges(ctx, env.id, syncDerivedForAgentWithNotices(ctx, existing.id, user.id), user.id);
  }
  // Agent 启停（migration v21）：enabled 切换立即同步到本环境存活中的仿真
  //（running/paused/created 均可 setAgentEnabled；新仿真经 environment-bridge
  // 的 ScenarioAgent.enabled 透传，无需此处处理）。
  if (patch.enabled !== undefined) {
    const active = ctx.registry.activeForEnvironment(env.id);
    if (active) {
      try {
        active.runtime.setAgentEnabled(existing.id, patch.enabled);
      } catch {
        // Runtime built before this agent existed — the stored flag wins
        // for the NEXT simulation; never fail the PATCH on sync.
      }
    }
  }
  return json;
}

/**
 * Record an owner direct edit in the command log (Fix-1): kind
 * `env-direct-edit`, before/after carry the object JSON (null at the
 * created/deleted end).
 */
function logDirectEdit(
  ctx: EnvObjectRoutesContext,
  envId: string,
  actorId: string,
  entry: {
    objectType: 'device' | 'agent' | 'environment';
    action: 'created' | 'updated' | 'deleted';
    objectId?: string;
    before: unknown;
    after: unknown;
  },
): void {
  ctx.pipeline.log({
    envId,
    actorId,
    kind: ENV_DIRECT_EDIT_KIND,
    payload: entry,
  });
}

/** zoneId must reference a zone baked into the environment's map data. */
function requireZone(env: EnvironmentRow, zoneId: string): void {
  if (!zonesOf(env).some(zone => zone.id === zoneId)) {
    throw new ApiError(
      400,
      'UNKNOWN_ZONE',
      `Zone "${zoneId}" does not exist in environment "${env.id}"`,
    );
  }
}

/** Every bound device id must reference a device instance in THIS environment. */
function requireDevicesInEnv(
  ctx: EnvObjectRoutesContext,
  env: EnvironmentRow,
  deviceIds: string[],
): void {
  for (const deviceId of deviceIds) {
    const device = ctx.envStore.getDevice(deviceId);
    if (!device || device.env_id !== env.id) {
      throw new ApiError(
        404,
        'DEVICE_NOT_FOUND',
        `Device "${deviceId}" does not exist in environment "${env.id}"`,
      );
    }
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a boolean`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requireStringArray(value, field);
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * DevLoop (validation gap): the env API used to accept any object as an
 * agent `llm` block, but the scenario schema requires {provider, model} —
 * a malformed block only surfaced at simulation time as
 * ENVIRONMENT_INVALID "agents[n].llm: must have required property
 * 'provider'", long after the author thought they had configured LLM
 * reasoning. Validate the shape at write time, at the source.
 */
function parseAgentLlm(value: unknown): Record<string, unknown> | null | undefined {
  // T-601 (R26): an explicit llm:null is the per-agent rule-only opt-out —
  // honored at birth (create) and on PATCH (clears to explicit opt-out).
  if (value === null) return null;
  const llm = optionalObject(value, 'llm');
  if (llm === undefined) return undefined;
  const provider = llm.provider;
  const model = llm.model;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "llm.provider" must be a non-empty string (e.g. "openai-compatible") — the llm block shape is {provider, model, params?}',
    );
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "llm.model" must be a non-empty string (e.g. the served model name) — the llm block shape is {provider, model, params?}',
    );
  }
  if (llm.params !== undefined && (typeof llm.params !== 'object' || llm.params === null || Array.isArray(llm.params))) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "llm.params" must be an object');
  }
  return llm;
}

/** Device binding URI: hass://<entity-id> or sim://…; null resets to sim. */
function optionalBinding(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(sim|hass):\/\/\S+$/.test(value)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "binding" must be a sim:// or hass:// URI (or null to reset to sim)',
    );
  }
  return value;
}

/**
 * T-051: the per-agent decision policy — closed shape
 * { role?, autoActuateIndependent?, autoInitiateAC?, precheckPassThrough?,
 *   precheckPassThroughRate? } (R43-B/lever-b adds the Type-A pass-through
 * pair; R45-P1 adds the coordinator role — the core loader whitelists the
 * same fields). null (or absent → undefined) clears to the runtime-wide
 * defaults; an empty object is rejected with the accepted keys so a policy
 * write always carries meaning.
 */
const DECISION_POLICY_KEYS = [
  'role',
  'autoActuateIndependent',
  'autoInitiateAC',
  'precheckPassThrough',
  'precheckPassThroughRate',
] as const;

export function parseAgentDecisionPolicy(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'Body field "decisionPolicy" must be an object { role?, autoActuateIndependent?, autoInitiateAC?, precheckPassThrough?, precheckPassThroughRate? } (or null to clear)',
    );
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(DECISION_POLICY_KEYS as readonly string[]).includes(key)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Body field "decisionPolicy.${key}" is not a known policy field (allowed: ${DECISION_POLICY_KEYS.join(', ')})`,
      );
    }
  }
  for (const key of DECISION_POLICY_KEYS) {
    const field = input[key];
    if (field === undefined) continue;
    if (key === 'precheckPassThrough') {
      if (field !== 'off' && field !== 'sample' && field !== 'all') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "decisionPolicy.precheckPassThrough" must be one of "off" | "sample" | "all" — got ${JSON.stringify(field)} (R43-B: data-production flag — Type-A precheck events fall through to the LLM lane)`,
        );
      }
    } else if (key === 'precheckPassThroughRate') {
      if (typeof field !== 'number' || !Number.isFinite(field) || field < 0 || field > 1) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body field "decisionPolicy.precheckPassThroughRate" must be a number in [0, 1] (probability p for precheckPassThrough=\'sample\'; default 0.3)',
        );
      }
    } else if (key === 'role') {
      // R45-P1: dispatcher role — precheck never Type-A short-circuits a
      // coordinator into self-handling (cross-zone dispatch stays possible).
      if (field !== 'coordinator') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "decisionPolicy.role" must be "coordinator" — got ${JSON.stringify(field)} (R45-P1: dispatcher — bound devices are representative reach, not an execution mandate)`,
        );
      }
    } else if (typeof field !== 'boolean') {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "decisionPolicy.${key}" must be a boolean`);
    }
  }
  if (Object.keys(input).length === 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Body field "decisionPolicy" must carry at least one of ${DECISION_POLICY_KEYS.join(', ')} (or be null to clear)`,
    );
  }
  return input;
}

/**
 * TASK-002 (DevLoop): warn when capabilities have no registered command
 * handler. Read-type capabilities (sensing/monitoring) are legitimate
 * without handlers; actuator-sounding names that nothing can execute are
 * the new-user trap. Non-blocking (hass:// and custom vocabularies exist).
 */
function capabilityWarnings(capabilities: string[]): string[] {
  const warnings: string[] = [];
  for (const cap of capabilities) {
    const lower = cap.toLowerCase();
    // Read/query capabilities are fine without handlers
    if (/(reading|sensing|monitoring|detection|status)/.test(lower)) continue;
    // Known handler families — these have real command handlers
    if (isCapabilityExecutable(cap)) continue;
    warnings.push(
      `capability "${cap}" has no registered command handler — the device will not respond to it. ` +
      'Common executable capabilities: turn-on, turn-off, toggle, set-power, set-temperature, set-brightness, cooling, heating, set-mode, open, close',
    );
  }
  return warnings;
}
