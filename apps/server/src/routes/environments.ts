/**
 * Environment routes — shared-world CRUD, membership, and the world stream
 *
 * - `POST   /api/environments`          create (auth). Body is either
 *     `{name, description?, mapType?, mapData?, visibility?}` for an empty
 *     world, or a full scenario JSON v1.0 document (detected by a `meta` /
 *     `version` field) which is imported: zones baked into map data,
 *     devices/agents expanded into instance rows — one transaction.
 * - `GET    /api/environments`          list my envs + public envs (auth).
 * - `GET    /api/environments/:id`      full detail. Public envs: anyone
 *     (anonymous allowed — PUBLIC read); private envs: members only.
 * - `PATCH  /api/environments/:id`      owner only: name/description/
 *     visibility/mapData/guide (Fix-19: the structured world guide).
 * - `GET    /api/environments/:id/activity` newest-first activity feed
 *     (Fix-19): command_log + proposal lifecycle + agreement lifecycle,
 *     one readable timeline. Same read access as the detail view.
 * - `GET    /api/environments/:id/training-export` NDJSON training-data
 *     export (Fix-22): manifest + decision/collaboration/zone-sample/
 *     device-state/usage/reputation-snapshot records; `?format=sft|dpo`
 *     (Wave-3b) switches the data lines to training views (SFT
 *     instruction/response pairs, DPO chosen/rejected pairs). Owner only;
 *     the export itself is audited in command_log (kind `training-export`).
 * - `DELETE /api/environments/:id`      owner only; cascades members +
 *     instances and stops simulations built from this environment.
 * - `POST   /api/environments/:id/join` public env → join as builder;
 *     private env → 403 unless already a member.
 * - `POST   /api/environments/:id/leave` members leave; the owner cannot
 *     leave (must transfer or delete). Leaving revokes any decision
 *     delegation naming the leaver (T-072).
 * - `GET    /api/environments/:id/delegations` active decision delegations
 *     (T-072, D-1 decide half) — same read gate as members.
 * - `POST   /api/environments/:id/delegations` owner delegates zone-claim
 *     decide rights to ONE member at a time (`{userId|email, zones?:
 *     'all'|[zoneId…]}`; re-grant to the same member refreshes the zone
 *     scope; a different member → 409 teaching revoke-first).
 * - `DELETE /api/environments/:id/delegations/:delegateId` owner revokes
 *     (the delegate is notified; membership removal/leave revokes too).
 * - `GET    /api/environments/:id/members` member list (Fix-4): same read
 *     access as detail; owner/builder members see userId + email, viewers,
 *     non-members and anonymous visitors see a redacted view
 *     (displayName + role only — Fix-13, R5 F-04).
 * - `POST   /api/environments/:id/members` owner invites by `email` or
 *     `userId` with role builder|viewer. Immediate-effect: the invitee is a
 *     member at once and the env appears in their list (no accept step).
 * - `PATCH  /api/environments/:id/members/:userId` owner changes a role
 *     (builder|viewer; the owner role is immutable).
 * - `DELETE /api/environments/:id/members/:userId` owner removes a member;
 *     a member may remove themselves (leave). The owner cannot be removed.
 * - `GET    /api/environments/:id/stream` WebSocket world-change channel
 *     (same read access as detail): `{kind:'world', action, objectType,
 *     object}` on every mutation in the environment, presence frames —
 *     `{kind:'presence', action:'snapshot'|...}` (world-sync.ts), and
 *     governance events — `{kind:'proposal', action, proposalId, actor}`
 *     on every proposal lifecycle transition (Fix-4). T-007 lifecycle: the
 *     stream is receive-only (client data gets a `{kind:'error',
 *     code:'STREAM_READ_ONLY'}` teaching frame), a ping/pong heartbeat
 *     terminates dead peers (presence hygiene), and deleting the
 *     environment closes subscribers with 1001 'environment deleted'
 *     right after the `{kind:'world', action:'deleted'}` frame.
 *
 * All mutations publish a world-change message via WorldSync.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';

import { makeStreamErrorFrame } from '@active-collaboration/shared';
import type { UiLocale } from '@active-collaboration/shared';
import type { AuthUser } from '../auth/index.js';
import type { ChangePipeline } from '../change-pipeline.js';
import { ApiError, errorBody } from '../errors.js';
import {
  VIEWER_NOTICE_KEY,
  duplicateNameWarning,
  notifyMemberAdded,
  parseAssignableRole,
  resolveInviteTarget,
  withWarnings,
  zeroZoneWarning,
} from './environment-shared.js';
import {
  parseImportInvites,
  parseOwnerAssignment,
} from '../environment-import-assignment.js';
import { importScenarioAsEnvironment } from '../environment-import.js';
import { mapMetaForDetail } from '../env-map-conversion.js';
import { t } from '../i18n/index.js';
import { parseGeoMapData, parseGeoPolygon, parseMapEvent } from '../geo.js';
import {
  assertEnvNameLength,
  getEnvironmentOrThrow,
  requireEnvRole,
  requireReadAccess,
} from '../env-access.js';
import {
  agentToJson,
  deviceToJson,
  environmentSummary,
  envGovernancePolicy,
  memberToJson,
  ownerRef,
  serviceToJson,
  zonesOf,
  type OwnerRef,
} from '../env-serializers.js';
import { computationSummaryFor } from './services.js';
import {
  delegationJsonsFor,
  registerDelegationRoutes,
  revokeDelegationsOnMembershipEnd,
} from './delegations.js';
import { projectDeviceJson, type DeviceJsonView } from '../device-privacy.js';
import { deviceOracleFor, deviceViewerOf } from '../device-viewer.js';
import type { HumanReviewThresholds } from '../proposal-human-review-policy.js';
import type {
  EnvironmentRow,
  EnvironmentStore,
  EnvDemoMeta,
  EnvFloorPlan,
  EnvGuide,
  EnvMapData,
  EnvRole,
  EnvVisibility,
  EnvZone,
  ZoneConsentClass,
} from '../db/environment-store.js';
import {
  filterCapabilitySynonyms,
  filterSemanticOfferRules,
  MAP_META_FIELDS,
  parseGuide,
  parseMapData,
  ZONE_CONSENT_CLASSES,
} from '../db/environment-store.js';
import { mergeMapDataPatch } from '../map-data-patch.js';
import {
  parseDerivedServiceVisibilityInput,
  parseGovernanceInput,
} from '../map-data-governance.js';
import type { AgreementStore } from '../db/agreement-store.js';
import type { FlowStore } from '../db/flow-store.js';
import type { CommandLogStore, ProposalStore } from '../db/proposal-store.js';
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  buildActivityFeed,
} from '../activity-feed.js';
import {
  ArrivalDigestCache,
  buildArrivalDigest,
  dailyWindowOf,
} from '../arrival-digest.js';
import { noHistoryView, ReputationStore } from '../db/reputation-store.js';
import type { EnvInviteStore } from '../db/env-invite-store.js';
import type { EnvDelegationStore } from '../db/env-delegation-store.js';
import type { NotificationStore } from '../db/notification-store.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';
import { parseDefaultSimulationIdPatch, type DefaultSimBindingRegistry } from '../env-default-sim-binding.js';
import { buildTrainingExport } from '../training-export.js';
import {
  canSeeService,
  declaredOfferDriftForEnv,
  derivedServiceVisibilityMode,
  unbackedFlagsForEnv,
  type ServiceStore,
} from '../db/service-store.js';
import { toPublicUser, type PublicUser, type UserRow, type UserStore } from '../db/user-store.js';
import type { MetricsCollector } from '../metrics.js';
import { assertQuota, type QuotaConfig } from '../quotas.js';
import type { StreamMessage, WorldSync } from '../world-sync.js';

export interface EnvironmentRoutesContext {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  /** Fix-44a: scenario-embedded flows persist through the import path. */
  flowStore: FlowStore;
  reputationStore: ReputationStore;
  userStore: UserStore;
  worldSync: WorldSync;
  /** Fix-1: unified change recording (command_log + actor-carrying broadcast). */
  pipeline: ChangePipeline;
  /** Fix-19: activity feed sources (command_log + proposals + agreements). */
  commandLogStore: CommandLogStore;
  proposalStore: ProposalStore;
  agreementStore: AgreementStore;
  /** Fix-16 inbox: membership additions notify the added user (member.added). */
  notificationStore: NotificationStore;
  /**
   * T-072 (D-1 decide half): env decision delegations — the owner grants /
   * revokes zone-claim decide rights for one member; the governance block
   * surfaces the active delegation. Optional so minimal test contexts
   * degrade to "no delegations" (fail closed on the decide gate).
   */
  delegationStore?: EnvDelegationStore;
  /**
   * R15-D10: pending invites for not-yet-registered emails — the roster
   * import parks unknown addresses here; registration auto-accepts them.
   */
  inviteStore: EnvInviteStore;
  /** P4-4 quotas (environments_per_user enforced on create). */
  quotas: QuotaConfig;
  /**
   * S1 (Task 3): deployment-level human-review breadth thresholds, surfaced
   * (with any per-env owner override applied) on the env detail's governance
   * block. Optional: tests may omit.
   */
  humanReviewThresholds?: HumanReviewThresholds;
  /**
   * S2 (device privacy): deployment admins (lowercased emails) are full-tier
   * viewers of device detail everywhere. Optional: tests may omit (no admins).
   */
  adminEmails?: string[];
  /** P4-4 metrics (environment stream connection gauge). */
  metrics: MetricsCollector;
  /**
   * T-007: stream heartbeat cadence (ms) — ping on a cycle, one missed pong
   * terminates the socket so a dead peer cannot keep a presence entry (and
   * the ws gauge) alive forever. Shares AGREEMENT_STREAM_HEARTBEAT_MS.
   */
  streamHeartbeatMs: number;
  /** Fix-22: per-simulation trajectory base dir scanned by training-export. */
  trajectoryBaseDir?: string;
  /**
   * P2F (living-worlds §10.4): fork-row lookup for training-export lineage
   * (manifest.forks + window.forkId). Optional: tests may omit (no lineage
   * resolution — exports stay fork-silent, never fabricated).
   */
  sandboxStore?: {
    get(forkId: string): import('../db/sandbox-store.js').SandboxRow | undefined;
    findBySimulationId(simulationId: string): import('../db/sandbox-store.js').SandboxRow | undefined;
  };
  /**
   * Living-worlds P1W: the env-owned authoritative world session — surfaced
   * on the detail (`worldSession`) and pinned by this route's stream
   * (observeOrMaterialize: the stream pins an existing session, and lazily
   * RE-materializes one lost to a hard restart — creation failures stay
   * warn-only so envs that cannot simulate keep their governance stream).
   * Optional: tests may omit.
   */
  worldSessions?: {
    /**
     * R73 (always-on worlds): wake/create the authoritative session — a
     * freshly created environment starts running IMMEDIATELY so the first
     * configured agent responds without anyone pressing 运行仿真.
     */
    onWorldMutation(envId: string, options: { create: boolean }): Promise<void>;
    statusOf(envId: string): {
      status: 'active' | 'idle' | 'hibernated';
      simTimeSec: number;
      simulationId: string;
      /** T-410 (R19): the wall anchor (epoch ms sim-time 0 maps to). */
      simStartEpochMs?: number;
      observers?: number;
      checkpointAtSec?: number;
      hibernatedAt?: string;
      driftWarning?: string[];
    } | undefined;
    observeOrMaterialize(envId: string): Promise<() => void>;
  };
  /** Called before an environment is deleted (stops its simulations). */
  onEnvironmentDeleted?: (envId: string) => void;
  /**
   * T122 (R17-u3/R19-u4): the live simulation registry — validates the
   * PATCH defaultSimulationId binding (exists / this env / not the world
   * session). Optional structurally (minimal harnesses), but a binding
   * write WITHOUT it is refused (an unverifiable reference is not stored).
   */
  registry?: DefaultSimBindingRegistry;
}

interface IdParams {
  id: string;
}

const VISIBILITIES: readonly EnvVisibility[] = ['public', 'private'];


/** Attach an additive `warnings` field only when there is something to say. */


/**
 * T-071: the per-process arrival-digest memo (one frozen briefing per
 * env × viewer × UTC day). Read-model state only — no store, no jobs.
 */
const arrivalDigests = new ArrivalDigestCache();

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  ctx: EnvironmentRoutesContext,
): void {
  // T-007: live world-stream sockets per environment, so deleting the
  // environment can END those streams (broadcast the 'deleted' world frame,
  // then close 1001 'environment deleted') instead of leaving subscribers
  // hanging on a channel that will never carry another message.
  const streamSockets = new Map<string, Set<WebSocket>>();
  const trackStreamSocket = (envId: string, socket: WebSocket): void => {
    let sockets = streamSockets.get(envId);
    if (sockets === undefined) {
      sockets = new Set();
      streamSockets.set(envId, sockets);
    }
    sockets.add(socket);
  };
  const releaseStreamSocket = (envId: string, socket: WebSocket): void => {
    const sockets = streamSockets.get(envId);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) streamSockets.delete(envId);
  };
  const closeStreamsForEnvironment = (envId: string, reason: string): number => {
    const sockets = streamSockets.get(envId);
    if (sockets === undefined) return 0;
    streamSockets.delete(envId);
    let closed = 0;
    for (const socket of sockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, reason);
        } else {
          socket.terminate();
        }
        closed += 1;
      } catch {
        // Already closing/closed — the route's cleanup is idempotent
      }
    }
    return closed;
  };

  app.post('/api/environments', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    /**
     * R75: the SINGLE post-create funnel. Every creation branch (empty-world,
     * scenario import, …) converges here, so the always-on contracts are
     * inherited by construction:
     *   (a) R73 — the authoritative world session starts the moment the
     *       environment exists (agents configured afterwards respond without
     *       anyone pressing 运行仿真; the import branch shipped without this
     *       once and every template world was born dead);
     *   (b) R75 — duplicate-name teaching (same-name worlds are legal but
     *       never silent).
     * Warnings are the branch-specific ones PLUS the funnel's own.
     */
    const finishCreation = (env: EnvironmentRow, warnings: string[]) => {
      if (ctx.worldSessions !== undefined) {
        void ctx.worldSessions.onWorldMutation(env.id, { create: true }).catch(error => {
          app.log.warn(
            `world session auto-start for env ${env.id} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      const sameName = ctx.envStore.countOwnedEnvironmentsWithName(user.id, env.name, env.id);
      if (sameName > 0) warnings.push(duplicateNameWarning(sameName, env.name));
      return reply.code(201).send(withWarnings(buildDetail(ctx, env, user, request.locale), warnings));
    };
    // DevLoop T-301 (boundary honesty): POST /api/environments takes a JSON
    // body — no query parameters are accepted. The R12 eldercare bootstrap
    // sent `?templateId=…` here and the unknown param was silently ignored,
    // 201-ing an EMPTY world that looked like success. Reject at the boundary
    // and teach the documented import flow (same convention as the
    // training-export / eval-runs unknown-param 400s).
    const unknownQuery = Object.keys(request.query as Record<string, unknown>);
    if (unknownQuery.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown query parameter${unknownQuery.length > 1 ? 's' : ''}: ` +
          `${unknownQuery.map(key => `"${key}"`).join(', ')}. ` +
          'POST /api/environments takes a JSON body. ' +
          'To import a scenario template: GET /api/scenario-templates → ' +
          'GET /api/scenario-templates/{id} → POST that scenario JSON as the body.',
      );
    }
    // P4-4 quota: one user may own at most quotas.maxEnvsPerUser environments
    // (applies to both the empty-world and the scenario-import paths).
    assertQuota(
      'environments_per_user',
      ctx.quotas.maxEnvsPerUser,
      ctx.envStore.countEnvironmentsOwnedBy(user.id),
    );
    const body = (request.body ?? {}) as Record<string, unknown>;
    // C3 (R42-B): the optional ownership plan — 'members' declares a
    // claimable multi-stakeholder world (stamped into mapData.governance;
    // claims themselves stay proposal-gated). Closed enum, typo = 400
    // teaching (the standing silent-drop lesson).
    let ownershipPlan: 'importer' | 'members' | undefined;
    if (body.ownershipPlan !== undefined) {
      if (body.ownershipPlan !== 'importer' && body.ownershipPlan !== 'members') {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "ownershipPlan" must be "importer" | "members" — got ${JSON.stringify(body.ownershipPlan)} ` +
          '("members" declares a multi-stakeholder world: members claim unassigned agents/devices through ' +
          'ownership-transfer proposals; "importer" keeps everything on the importer until they hand it over)',
        );
      }
      ownershipPlan = body.ownershipPlan;
    }

    // Import path: a full scenario JSON v1.0 document.
    if (body.meta !== undefined || body.version !== undefined) {
      const visibility = parseVisibility(body.visibility) ?? 'private';
      // R46 (P0-1): import-time membership invites + ownership assignment
      // (资产归属下放). Both resolve against the user store BEFORE the
      // import starts (unknown email / bad regex = loud 400, no wasted
      // world-building); the membership rows and owner handover themselves
      // land inside the import transaction.
      const invites = parseImportInvites(ctx.userStore, body.invites);
      const ownerAssignment = parseOwnerAssignment(ctx.userStore, body.ownerAssignment);
      const env = importScenarioAsEnvironment(ctx.envStore, body, {
        ownerId: user.id,
        visibility,
        // C3 (R42-B): the ownership plan rides the import body ('members'
        // declares a claimable multi-stakeholder world; default 'importer').
        ...(ownershipPlan !== undefined ? { ownershipPlan } : {}),
        serviceStore: ctx.serviceStore,
        // Fix-44a: embedded flows persist as environment flows.
        flowStore: ctx.flowStore,
        // R46 (P0-1): invite + assign in the same transaction.
        invites,
        ...(ownerAssignment !== undefined ? { ownerAssignment } : {}),
      });
      // R46 (P0-1): import-time invites get the same inbox notification +
      // member-change audit rows as a regular invite (the user discovers
      // their new world and the "who added me" trail exists from second
      // zero — "越权做得到、审计看得见").
      for (const invite of invites) {
        if (ctx.envStore.roleOf(env.id, invite.userId) === 'owner') continue; // importer echo
        notifyMemberAdded(ctx, env, invite.userId, user, invite.role, request.locale);
        ctx.pipeline.log({
          envId: env.id,
          actorId: user.id,
          kind: 'member-change',
          payload: { action: 'added', userId: invite.userId, before: null, after: invite.role },
        });
      }
      // T-301: an import that produces zero zones should not read as success
      // (the template carried nothing usable) — warn, don't block.
      const warnings = parseMapData(env).zones.length === 0 ? [zeroZoneWarning(true)] : [];
      // R75: SINGLE post-create funnel — both creation branches converge so
      // a new branch inherits the contracts by construction instead of by
      // remembering (the R75 lesson: this import branch once shipped without
      // the always-on wake, and every template-imported env was born
      // world-less for weeks).
      return finishCreation(env, warnings);
    }

    // Empty-world path.
    // R46 (P0-1): invites/ownerAssignment are scenario-import body fields —
    // an empty world has nothing to assign yet; be loud instead of silent.
    if (body.invites !== undefined || body.ownerAssignment !== undefined) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body fields "invites" and "ownerAssignment" apply to the scenario-import body ' +
        '(a document with meta/version) — an empty world has no imported instances to assign. ' +
        'Invite members after creation: POST /api/environments/{id}/members',
      );
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "name" must be a non-empty string');
    }
    assertEnvNameLength(name);
    const description =
      body.description !== undefined ? requireString(body.description, 'description') : '';
    const mapType = body.mapType !== undefined ? requireString(body.mapType, 'mapType') : 'grid';
    const mapData = body.mapData !== undefined ? parseMapDataInput(body.mapData, mapType) : { zones: [] };
    const visibility = parseVisibility(body.visibility);
    // C3: the ownership plan stamps the empty world too (consistent with the
    // import path — members-plan claims work the same either way).
    if (ownershipPlan === 'members') {
      mapData.governance = { ...mapData.governance, ownershipPlan: 'members' };
    }
    const env = ctx.envStore.createEnvironment({
      name,
      description,
      mapType,
      mapData,
      ownerId: user.id,
      ...(visibility !== undefined ? { visibility } : {}),
    });
    // T-301: a blank canvas is legitimate, but with no builder zone-creation
    // path in the API an empty world dead-ends every bootstrap — warn loudly.
    const warnings = mapData.zones.length === 0 ? [zeroZoneWarning(false)] : [];
    return finishCreation(env, warnings);
  });

  app.get('/api/environments', { preHandler: app.authenticate }, async request => {
    const user = request.user!;
    // R15-D2: default = the caller's worlds only; `?filter=all` opts into the
    // full visible set (mine + every public environment). A deployment's
    // public catalog grows with its community — "mine" is the workbench view.
    const query = request.query as Record<string, unknown>;
    const filter = query.filter;
    if (filter !== undefined && filter !== 'mine' && filter !== 'all') {
      throw new ApiError(400, 'BAD_REQUEST', 'Query "filter" must be "mine" or "all"');
    }
    // D2-F7: unknown query params are a loud 400 (the activity endpoint's
    // convention — this route used to silently swallow ?visibility=public
    // and friends, stranding brand-new users on an empty "mine" list).
    const unknownQuery = Object.keys(query).filter(key => key !== 'filter');
    if (unknownQuery.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown query parameter${unknownQuery.length > 1 ? 's' : ''}: ` +
          `${unknownQuery.map(key => `"${key}"`).join(', ')}. ` +
          'GET /api/environments takes exactly one optional query: ?filter=all ' +
          '(the full visible set — your worlds plus every PUBLIC environment) or ' +
          '?filter=mine (default — only yours).',
      );
    }
    const rows = filter === 'all'
      ? ctx.envStore.listVisibleFor(user.id)
      : ctx.envStore.listMineFor(user.id);
    // D2-F7 companion hint: an empty "mine" with publics available is the
    // #1 new-user dead-end — name the escape hatch instead of an empty [].
    if (rows.length === 0 && filter !== 'all') {
      const publicCount = ctx.envStore.listVisibleFor(user.id).length;
      if (publicCount > 0) {
        return {
          environments: [],
          hint: `You have no environments yet, but ${publicCount} PUBLIC environment(s) ` +
            'are visible on this deployment — re-request with ?filter=all to browse them.',
        };
      }
    }
    const ownerCache = new Map<string, OwnerRef>();
    return {
      environments: rows.map(row => {
        const owner = cachedOwner(ctx, ownerCache, row.owner_id);
        const devices = ctx.envStore.devicesOf(row.id).length;
        const agents = ctx.envStore.agentsOf(row.id).length;
        const zones = zonesOf(row).length;
        return environmentSummary(
          row,
          owner,
          {
            devices,
            agents,
            members: ctx.envStore.membersOf(row.id).length,
            // Fix-13 (R5 F-03): marketplace scale on the list/card — same
            // per-caller visibility rule as the detail view's service list.
            services: visibleServiceCount(ctx, row, row.my_role, user.id),
            zones,
          },
          row.my_role,
          // T-063(c): a dead husk (0 zones/devices/agents) is marked as such
          // in the caller's locale — a newcomer can tell which card is the
          // real world instead of guessing.
          zones === 0 && devices === 0 && agents === 0
            ? t(request.locale, 'chrome.env.emptyWorldCard')
            : undefined,
        );
      }),
    };
  });

  app.get('/api/environments/:id', { preHandler: app.optionalAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);
    const query = request.query as Record<string, unknown>;
    // Fix-43c: `?includeServices=summary` replaces the full service objects
    // with {total, visible} — the derived catalog is static per world state
    // and made up ~74% of the detail payload at campus scale (4.7MB on the
    // 971-zone fixture). Clients fetch the catalog from /services on demand.
    const includeServices = query.includeServices;
    if (includeServices !== undefined && includeServices !== 'summary' && includeServices !== 'full') {
      throw new ApiError(400, 'BAD_REQUEST', 'Query "includeServices" must be "summary" or "full"');
    }
    if (includeServices === 'summary') {
      const detail = buildDetail(ctx, env, request.user, request.locale) as Record<string, unknown>;
      const services = detail.services as Array<{ visibility?: string }>;
      const serviceViewer = {
        userId: request.user?.id ?? null,
        role: request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined,
      };
      const agentById = new Map(ctx.envStore.agentsOf(env.id).map(row => [row.id, row]));
      detail.services = {
        total: services.length,
        visible: ctx.serviceStore.servicesOf(env.id).filter(row => {
          const agent = agentById.get(row.provider_agent_id);
          return agent !== undefined &&
            canSeeService(row.visibility, agent.owner_id, env, serviceViewer, { origin: row.origin });
        }).length,
      };
      return detail;
    }
    return buildDetail(ctx, env, request.user, request.locale);
  });

  // Fix-19: the environment's activity feed — one newest-first timeline
  // aggregated from command_log + proposal lifecycle + agreement lifecycle.
  // Same read access as the detail view (anonymous may read public envs).
  app.get('/api/environments/:id/activity', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as IdParams;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);

    const query = request.query as Record<string, unknown>;
    // T-063(d): the contract paginates by CURSOR (?before), never by offset —
    // a silently ignored ?offset returned the same first page forever
    // (R12 retry: "long histories unreachable via API"). Reject every query
    // param outside {limit, before, kind, actor} and name the documented way
    // to page.
    const knownQuery = new Set(['limit', 'before', 'kind', 'actor']);
    const unknownQuery = Object.keys(query).filter(key => !knownQuery.has(key));
    if (unknownQuery.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown query parameter(s) ${unknownQuery.map(key => `"${key}"`).join(', ')} — ` +
          'this feed pages by cursor: pass ?before=<iso timestamp of the last entry of the ' +
          'previous page> (and optional ?limit, ?kind, ?actor). There is no offset-based paging.',
      );
    }
    let limit = ACTIVITY_DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Query "limit" must be a positive integer');
      }
      limit = Math.min(parsed, ACTIVITY_MAX_LIMIT);
    }

    /**
     * Fix-37: grading export — `GET /api/environments/:id/roster-report`
     * gives the teacher a per-student app inventory for grading:
     * devices created, agents, flows, services published, agreements,
     * simulation commands, and derived-service invokes. Owner-only.
     */
    // Wave-1a (小林 R8 F-16): `?before=<iso>` pages backwards — entries
    // strictly older than the cursor (typically the last entry of the
    // previous page).
    const before = optionalQueryParam(query.before, 'before');
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Query "before" must be an ISO timestamp');
    }
    // T33 (R3 u4-F10): signal filters — ?kind=<command|proposal|agreement|event|flow>
    // and ?actor=<id or display-name substring> (case-insensitive; engine
    // actors match their 'engine:…' id or their 引擎(…) label).
    const kindFilter = optionalQueryParam(query.kind, 'kind');
    if (kindFilter !== undefined &&
        kindFilter !== 'command' && kindFilter !== 'proposal' &&
        kindFilter !== 'agreement' && kindFilter !== 'event' &&
        kindFilter !== 'flow') {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Query "kind" must be one of "command" | "proposal" | "agreement" | "event" | "flow"',
      );
    }
    const actorFilter = optionalQueryParam(query.actor, 'actor')?.toLowerCase();
    // T60 (R6, u3-P2-1): kind/actor filters pass INTO the feed builder and
    // apply BEFORE the limit slice — `?kind=proposal&limit=30` returns
    // min(30, matches), not "whatever survived the unfiltered page".
    const entries = buildActivityFeed(
      {
        commandLogStore: ctx.commandLogStore,
        proposalStore: ctx.proposalStore,
        agreementStore: ctx.agreementStore,
        userStore: ctx.userStore,
        envStore: ctx.envStore,
        serviceStore: ctx.serviceStore,
      },
      env.id,
      limit,
      before,
      // T-308 (FR-F12): the feed is viewer-aware — hidden-service
      // references are redacted for viewers who are not the provider
      // owner, the agreement counterparty, or the env owner.
      { userId: request.user?.id ?? null, envOwnerId: env.owner_id },
      {
        ...(kindFilter !== undefined ? { kind: kindFilter } : {}),
        ...(actorFilter !== undefined ? { actor: actorFilter } : {}),
      },
    );
    return { entries };
  });

  // T-071 (R22, FM-F06): the arrival briefing digest — the arriving
  // stakeholder's "what happened today" without activity-feed archaeology.
  // Same read gate + viewer-aware privacy as the feed; read-model only (no
  // jobs): the FIRST read of a UTC day freezes one digest per viewer (later
  // arrivals the same day get the SAME briefing); ?since=<iso> computes a
  // fresh windowed digest on demand.
  app.get('/api/environments/:id/digest', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as IdParams;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);

    const query = request.query as Record<string, unknown>;
    const unknownQuery = Object.keys(query).filter(key => key !== 'since');
    if (unknownQuery.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown query parameter(s) ${unknownQuery.map(key => `"${key}"`).join(', ')} — ` +
          'the daily digest accepts only ?since=<iso> (a fresh windowed digest instead of the day memo)',
      );
    }

    const stores = {
      commandLogStore: ctx.commandLogStore,
      proposalStore: ctx.proposalStore,
      agreementStore: ctx.agreementStore,
      userStore: ctx.userStore,
      envStore: ctx.envStore,
      serviceStore: ctx.serviceStore,
    };
    const viewer = { userId: request.user?.id ?? null, envOwnerId: env.owner_id };
    const locale = request.locale;

    const sinceParam = optionalQueryParam(query.since, 'since');
    if (sinceParam !== undefined) {
      if (Number.isNaN(Date.parse(sinceParam))) {
        throw new ApiError(400, 'BAD_REQUEST', 'Query "since" must be an ISO timestamp');
      }
      const until = new Date().toISOString();
      return buildArrivalDigest(stores, env.id, viewer, locale, { since: sinceParam, until });
    }

    const nowIso = new Date().toISOString();
    // R5-F07 termination stamp + v60 (R6-E-F08) provider-trouble stamp (retire OR failover-watchdog suspension) ride the memo key — a fresh completion/park expires today's freeze.
    const memoKey = { envId: env.id, viewerKey: request.user?.id ?? 'anonymous', nowIso, terminatedSignal: `${ctx.agreementStore.latestTerminatedAt(env.id) ?? 'none'}|${ctx.agreementStore.latestProviderTroubleAt(env.id) ?? 'none'}` };
    return arrivalDigests.daily(() => buildArrivalDigest(stores, env.id, viewer, locale, dailyWindowOf(nowIso)), memoKey);
  });

  // Fix-22: training data export — 训练场数据出口。决策理由 + 全环境数据
  // （仿真时序/消费计量/声誉）属敏感资产，限定 owner；导出行为落
  // command_log 审计（kind 'training-export'）。响应是 NDJSON 流：第一行
  // manifest（环境快照 + 计数 + 时间窗），之后是统一信封记录
  // （training-export.ts）。
  app.get(
    '/api/environments/:id/training-export',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const query = request.query as Record<string, unknown>;
      // DevLoop T-008（静默丢参）：`?sim=<id>` 这类拼错曾返回 200 + 全环境
      // 数据集——用户以为只导出一个仿真。未知 query 参数一律 400 并给出
      // 接受列表（与 body 侧 /commands、eval-run spec 同一约定）。
      const acceptedQuery = ['simId', 'from', 'to', 'format'];
      const unknownQuery = Object.keys(query).filter(key => !acceptedQuery.includes(key));
      if (unknownQuery.length > 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Unknown query parameter${unknownQuery.length > 1 ? 's' : ''}: ` +
            `${unknownQuery.map(key => `"${key}"`).join(', ')}. ` +
            `Accepted: ${acceptedQuery.map(key => `"${key}"`).join(', ')}. ` +
            'Note: filtering to a single simulation uses "simId".',
        );
      }
      const simId = optionalQueryParam(query.simId, 'simId');
      const from = optionalQueryParam(query.from, 'from');
      const to = optionalQueryParam(query.to, 'to');
      const format = optionalQueryParam(query.format, 'format');
      for (const [field, value] of [['from', from], ['to', to]] as const) {
        if (value !== undefined && Number.isNaN(Date.parse(value))) {
          throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be an ISO timestamp`);
        }
      }
      if (format !== undefined && format !== 'sft' && format !== 'dpo' && format !== 'structured') {
        throw new ApiError(400, 'BAD_REQUEST', 'Query "format" must be one of "sft" | "dpo" | "structured"');
      }

      const result = buildTrainingExport(
        {
          envStore: ctx.envStore,
          agreementStore: ctx.agreementStore,
          reputationStore: ctx.reputationStore,
          serviceStore: ctx.serviceStore,
          ...(ctx.trajectoryBaseDir !== undefined
            ? { trajectoryBaseDir: ctx.trajectoryBaseDir }
            : {}),
          ...(ctx.sandboxStore !== undefined ? { sandboxStore: ctx.sandboxStore } : {}),
        },
        env,
        {
          ...(simId !== undefined ? { simId } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(format !== undefined ? { format } : {}),
        },
      );
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'training-export',
        payload: {
          objectType: 'environment',
          action: 'exported',
          objectId: env.id,
          simId: simId ?? null,
          from: from ?? null,
          to: to ?? null,
          format: format ?? null,
          counts: result.counts,
          total: result.total,
        },
      });
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .send(result.lines.join('\n') + '\n');
    },
  );

  app.patch('/api/environments/:id', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    requireEnvRole(ctx.envStore, id, user, ['owner']);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<EnvironmentStore['updateEnvironment']>[1] = {};
    let touched = false;
    if (body.name !== undefined) {
      const name = requireString(body.name, 'name').trim();
      if (name.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "name" must be a non-empty string');
      }
      assertEnvNameLength(name);
      patch.name = name;
      touched = true;
    }
    if (body.description !== undefined) {
      patch.description = requireString(body.description, 'description');
      touched = true;
    }
    if (body.visibility !== undefined) {
      const visibility = parseVisibility(body.visibility);
      if (!visibility) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "visibility" must be one of ${VISIBILITIES.map(v => `"${v}"`).join(' | ')}`,
        );
      }
      patch.visibility = visibility;
      touched = true;
    }
    if (body.mapData !== undefined) {
      // R5-F01/F04: merge the patch over the stored map data (key-level;
      // unknown keys 400, zones wipe needs confirmClearZones), then run the
      // merged object through the same full validation as a wholesale write.
      const merged = mergeMapDataPatch(body.mapData, env, body.confirmClearZones === true);
      patch.mapData = parseMapDataInput(merged, env.map_type);
      touched = true;
    }
    if (body.guide !== undefined) {
      patch.guide = parseGuideInput(body.guide);
      touched = true;
    }
    if (body.defaultSimulationId !== undefined) {
      // T122 (R17-u3 / R19-u4): the env's default-simulation binding — the
      // validation (exists / this env / not the world session / null clears)
      // lives in env-default-sim-binding.ts. Running is NOT required at bind
      // time; liveness is re-checked at every USE, where a stopped/deleted
      // binding honestly falls back + discloses.
      patch.defaultSimulationId = parseDefaultSimulationIdPatch(
        body.defaultSimulationId,
        env,
        ctx.registry,
      );
      touched = true;
    }
    if (!touched) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body must contain at least one of: name, description, visibility, mapData, guide, defaultSimulationId',
      );
    }

    const updated = ctx.envStore.updateEnvironment(env.id, patch);
    // Fix-1: owner direct edits are audited (env-direct-edit) with the
    // patched fields' before/after values.
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      if (key === 'name') before.name = env.name;
      else if (key === 'description') before.description = env.description;
      else if (key === 'visibility') before.visibility = env.visibility;
      else if (key === 'mapData') before.mapData = parseMapData(env);
      else if (key === 'guide') before.guide = parseGuide(env);
      else if (key === 'defaultSimulationId') before.defaultSimulationId = env.default_simulation_id;
    }
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'env-direct-edit',
      payload: { objectType: 'environment', action: 'updated', objectId: env.id, before, after: patch },
    });
    ctx.pipeline.publish(updated.id, 'updated', 'environment', {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      mapType: updated.map_type,
      visibility: updated.visibility,
      zones: zonesOf(updated),
      updatedAt: updated.updated_at,
    }, user.id);
    // R75: the rename path can mint a duplicate name too — same teaching as
    // the creation funnel (single helper, every mutation path covered).
    const renameWarnings: string[] = [];
    if (patch.name !== undefined) {
      const sameName = ctx.envStore.countOwnedEnvironmentsWithName(user.id, updated.name, updated.id);
      if (sameName > 0) renameWarnings.push(duplicateNameWarning(sameName, updated.name));
    }
    return withWarnings(buildDetail(ctx, updated, user, request.locale), renameWarnings);
  });

  app.delete('/api/environments/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    requireEnvRole(ctx.envStore, env.id, user, ['owner']);

    ctx.onEnvironmentDeleted?.(env.id);
    ctx.envStore.deleteEnvironment(env.id);
    arrivalDigests.dropEnv(env.id);
    ctx.pipeline.publish(env.id, 'deleted', 'environment', { id: env.id }, user.id);
    // T-007: subscribers just heard the world end — close their streams
    // instead of leaving them on a channel that can never change again.
    closeStreamsForEnvironment(env.id, 'environment deleted');
    return reply.code(204).send();
  });

  app.post('/api/environments/:id/join', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);

    const existing = ctx.envStore.roleOf(env.id, user.id);
    if (existing !== undefined) {
      return { envId: env.id, userId: user.id, role: existing, alreadyMember: true };
    }
    if (env.visibility !== 'public') {
      throw new ApiError(
        403,
        'FORBIDDEN',
        `Environment "${env.id}" is private — membership is by owner invitation ` +
        `(POST /api/environments/${env.id}/members)`,
      );
    }
    ctx.envStore.addMember(env.id, user.id, 'builder');
    // R74/F2: joining WAKES the world session (create:false — joining changes
    // no world topology, and the session was created at env birth by R73).
    // The always-on contract: a member who joins and starts building lands
    // in a world that is already simulating, not one waiting for someone to
    // press 运行仿真. A failed wake must never fail the join.
    if (ctx.worldSessions !== undefined) {
      void ctx.worldSessions.onWorldMutation(env.id, { create: false }).catch(() => {});
    }
    return { envId: env.id, userId: user.id, role: 'builder' as EnvRole, alreadyMember: false };
  });

  // R53 (semantic offers): owner-side maintenance — re-run the service
  // derivation sync for EVERY agent of this environment. Picks up newly
  // qualified aggregate offers (and unions their semantic types into the
  // agents' declared capabilities) on worlds imported before the rule
  // table existed; also heals drifted device-derived rows.
  app.post('/api/environments/:id/rederive-services', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    if (ctx.envStore.roleOf(env.id, user.id) !== 'owner') {
      throw new ApiError(403, 'FORBIDDEN', 'Service re-derivation requires the environment owner');
    }
    const summary = { agents: 0, created: 0, updated: 0, deleted: 0 };
    for (const agent of ctx.envStore.agentsOf(env.id)) {
      summary.agents += 1;
      for (const change of ctx.serviceStore.syncDerivedForAgent(agent.id)) {
        summary[change.action] += 1;
      }
    }
    return { envId: env.id, ...summary };
  });

  app.post('/api/environments/:id/leave', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);

    const role = ctx.envStore.roleOf(env.id, user.id);
    if (role === undefined) {
      throw new ApiError(400, 'NOT_A_MEMBER', `You are not a member of environment "${env.id}"`);
    }
    if (role === 'owner') {
      throw new ApiError(
        400,
        'OWNER_CANNOT_LEAVE',
        'The environment owner cannot leave — transfer ownership (not yet implemented) or delete the environment',
      );
    }
    ctx.envStore.removeMember(env.id, user.id);
    // T-072: leaving revokes any decision delegation naming the leaver —
    // an active delegation must always reference a current member.
    revokeDelegationsOnMembershipEnd(ctx, env, user.id, user.id, 'member-left', request.locale);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------------------
  // Member management (Fix-4, RC-4 / P0-1)
  //
  // Invitation is immediate-effect: the invited user becomes a member at once
  // (no invite/accept handshake) and the environment simply appears in their
  // GET /api/environments list. Member JSON is perspective-redacted
  // (memberToJson): owner/builder see userId + email, viewers and outsiders
  // see displayName + role only (Fix-13, R5 F-04).
  // ---------------------------------------------------------------------------

  app.get('/api/environments/:id/members', { preHandler: app.optionalAuth }, async request => {
    const { id } = request.params as IdParams;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
    requireReadAccess(env, role);
    return { members: serializeMembers(ctx, env.id, role) };
  });

  app.post('/api/environments/:id/members', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    requireEnvRole(ctx.envStore, id, user, ['owner']);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const role = parseAssignableRole(body.role);
    const target = resolveInviteTarget(ctx, body);
    if (ctx.envStore.roleOf(env.id, target.id) !== undefined) {
      throw new ApiError(
        409,
        'ALREADY_MEMBER',
        `User "${target.id}" is already a member of environment "${env.id}" — PATCH its role instead`,
      );
    }
    ctx.envStore.addMember(env.id, target.id, role);
    notifyMemberAdded(ctx, env, target.id, user, role, request.locale);
    // T-025: membership mutations are audited ("越权做得到、审计看得见",
    // Fix-9) — actor = who invited, before/after = the membership change.
    ctx.pipeline.log({
      envId: env.id,
      actorId: user.id,
      kind: 'member-change',
      payload: { action: 'added', userId: target.id, before: null, after: role },
    });
    // R74/F2 (same as the public join route): an added member wakes the
    // world session — never a failed-wake-failed-invite.
    if (ctx.worldSessions !== undefined) {
      void ctx.worldSessions.onWorldMutation(env.id, { create: false }).catch(() => {});
    }
    return reply.code(201).send(memberToJson(
      { env_id: env.id, user_id: target.id, role },
      target,
      true, // the owner is a member: full view
    ));
  });

  /**
   * Fix-37: batch roster import — `POST /api/environments/:id/members:batch`
   * with `{ emails: string[], role?: 'builder'|'viewer' }`. A teacher
   * imports a class roster in one call instead of 30 individual invites.
   * R15-D10: emails that don't match a registered user become PENDING
   * INVITES (status 'invited') — the student registers later and lands in
   * the class automatically. Malformed rows alone report 'not_found'.
   */
  app.post(
    '/api/environments/:id/members:batch',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const body = (request.body ?? {}) as { emails?: unknown; role?: unknown };
      if (!Array.isArray(body.emails)) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "emails" must be an array of email strings');
      }
      if (body.emails.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "emails" must not be empty');
      }
      if (body.emails.length > 200) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "emails" is limited to 200 entries per call');
      }
      const role = body.role === undefined ? 'builder' : parseAssignableRole(body.role);

      const results: Array<
        { email: string; status: 'added' | 'already_member' | 'not_found'; userId?: string } |
        { email: string; status: 'invited' }
      > = [];
      let added = 0;
      let skipped = 0;
      let failed = 0;
      let invited = 0;

      for (const rawEmail of body.emails) {
        const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
        if (email.length === 0) {
          results.push({ email: String(rawEmail), status: 'not_found' });
          failed += 1;
          continue;
        }
        const target = ctx.userStore.findByEmail(email);
        if (!target) {
          // R15-D10: unknown email → pending invite, accepted automatically
          // on registration.
          // parseAssignableRole only yields builder|viewer at runtime;
          // its declared EnvRole return needs the narrow here.
          ctx.inviteStore.upsertPending({ envId: env.id, email, role: role as 'builder' | 'viewer', invitedBy: user.id });
          results.push({ email, status: 'invited' });
          invited += 1;
          continue;
        }
        if (ctx.envStore.roleOf(env.id, target.id) !== undefined) {
          results.push({ email, status: 'already_member', userId: target.id });
          skipped += 1;
          continue;
        }
        ctx.envStore.addMember(env.id, target.id, role);
        notifyMemberAdded(ctx, env, target.id, user, role, request.locale);
        // T-025: one audit row per ADDED member (same shape as the single
        // invite; pending invites are not membership mutations yet).
        ctx.pipeline.log({
          envId: env.id,
          actorId: user.id,
          kind: 'member-change',
          payload: { action: 'added', userId: target.id, before: null, after: role },
        });
        results.push({ email, status: 'added', userId: target.id });
        added += 1;
      }

      return reply.code(200).send({
        envId: env.id,
        role,
        summary: { total: results.length, added, skipped, failed, invited },
        results,
      });
    },
  );

  // -------------------------------------------------------------------------
  // R15-D10: pending invites (owner-facing list + revoke)
  // -------------------------------------------------------------------------
  app.get('/api/environments/:id/invites', { preHandler: app.authenticate }, async request => {
    const { id } = request.params as IdParams;
    const user = request.user!;
    const env = getEnvironmentOrThrow(ctx.envStore, id);
    requireEnvRole(ctx.envStore, id, user, ['owner']);
    return {
      invites: ctx.inviteStore.listPendingForEnv(env.id).map(row => ({
        id: row.id,
        email: row.email,
        role: row.role,
        invitedBy: row.invited_by,
        createdAt: row.created_at,
      })),
    };
  });

  app.delete(
    '/api/environments/:id/invites/:inviteId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, inviteId } = request.params as IdParams & { inviteId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);
      if (!ctx.inviteStore.delete(env.id, inviteId)) {
        throw new ApiError(404, 'INVITE_NOT_FOUND', 'No pending invite with this id');
      }
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // T-072 (D-1 decide half): decision delegations live in routes/delegations.ts
  // (split out at the arch-guard size ceiling) — grant/revoke/list for the
  // zone-claims decide right, plus the membership-end cleanup hooks below.
  // -------------------------------------------------------------------------
  registerDelegationRoutes(app, ctx);

  app.patch(
    '/api/environments/:id/members/:userId',
    { preHandler: app.authenticate },
    async request => {
      const { id, userId } = request.params as IdParams & { userId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const role = parseAssignableRole(body.role);
      const current = ctx.envStore.roleOf(env.id, userId);
      if (current === undefined) {
        throw new ApiError(
          404,
          'MEMBER_NOT_FOUND',
          `User "${userId}" is not a member of environment "${env.id}"`,
        );
      }
      if (current === 'owner') {
        throw new ApiError(
          400,
          'OWNER_ROLE_IMMUTABLE',
          'The owner role cannot be changed — ownership transfer is not supported',
        );
      }
      ctx.envStore.updateMemberRole(env.id, userId, role);
      // T-026: the affected member hears about the change from their inbox
      // (was silent — a demoted builder discovered the loss via a 403 on
      // their next action). Promotion and demotion both notify.
      notify(ctx.notificationStore, {
        recipientId: userId,
        actorId: user.id,
        envId: env.id,
        kind: NOTIFICATION_KINDS.memberRoleChanged,
        title: t(request.locale, 'chrome.notif.memberRoleChanged', {
          envName: env.name,
          fromRole: current,
          toRole: role,
        }),
        body: {
          envId: env.id,
          envName: env.name,
          userId,
          before: current,
          after: role,
          changedByName: user.displayName,
        },
        refId: env.id,
      });
      // T-025: role changes are audited with before/after — the demotion
      // "who lost write access, when, by whom" is exactly the dispute the
      // audit trail exists for (EB-F07/F08).
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'member-change',
        payload: { action: 'role-changed', userId, before: current, after: role },
      });
      return memberToJson(
        { env_id: env.id, user_id: userId, role },
        ctx.userStore.findById(userId),
        true,
      );
    },
  );

  app.delete(
    '/api/environments/:id/members/:userId',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id, userId } = request.params as IdParams & { userId: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);

      const current = ctx.envStore.roleOf(env.id, userId);
      if (current === undefined) {
        throw new ApiError(
          404,
          'MEMBER_NOT_FOUND',
          `User "${userId}" is not a member of environment "${env.id}"`,
        );
      }
      // The env owner may remove any member; a member may remove themselves
      // (leave). Everyone else gets 403.
      const callerRole = ctx.envStore.roleOf(env.id, user.id);
      if (callerRole !== 'owner' && user.id !== userId) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the environment owner may remove other members',
        );
      }
      if (current === 'owner') {
        throw new ApiError(
          400,
          'OWNER_CANNOT_LEAVE',
          'The environment owner cannot be removed — delete the environment instead',
        );
      }
      ctx.envStore.removeMember(env.id, userId);
      // T-026: the removed member is notified (self-leave is naturally
      // dropped by the funnel's recipient === actor echo rule).
      notify(ctx.notificationStore, {
        recipientId: userId,
        actorId: user.id,
        envId: env.id,
        kind: NOTIFICATION_KINDS.memberRemoved,
        title: t(request.locale, 'chrome.notif.memberRemoved', { envName: env.name }),
        body: {
          envId: env.id,
          envName: env.name,
          userId,
          removedRole: current,
          removedByName: user.displayName,
        },
        refId: env.id,
      });
      // T-072: membership removal revokes the member's decision delegations
      // (lifecycle honesty — the D-1 v2 trade-off's "what happens to a
      // departed delegate's pending rights" is answered mechanically).
      revokeDelegationsOnMembershipEnd(ctx, env, userId, user.id, 'member-removed', request.locale);
      // T-025: removals are audited (actor = owner, or the member leaving).
      ctx.pipeline.log({
        envId: env.id,
        actorId: user.id,
        kind: 'member-change',
        payload: { action: 'removed', userId, before: current, after: null },
      });
      return reply.code(204).send();
    },
  );

  /**
   * Fix-37: grading export — `GET /api/environments/:id/roster-report`
   * gives the teacher a per-student app inventory for grading:
   * devices created, agents, flows, services published, agreements.
   * Owner-only (it reveals every member's inventory).
   */
  app.get(
    '/api/environments/:id/roster-report',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      requireEnvRole(ctx.envStore, id, user, ['owner']);

      // All members (owner included for completeness).
      const members = ctx.envStore.membersOf(env.id);
      const devices = ctx.envStore.devicesOf(env.id);
      const agents = ctx.envStore.agentsOf(env.id);
      const services = ctx.serviceStore.servicesOf(env.id);
      const flows = ctx.flowStore.listByEnvironment(env.id);

      const entries = members.map(member => {
        const userId = member.user_id;
        const user = ctx.userStore.findById(userId);
        return {
          userId,
          displayName: user?.display_name ?? userId,
          email: user?.email ?? '',
          role: member.role,
          counts: {
            devices: devices.filter(d => d.owner_id === userId).length,
            agents: agents.filter(a => a.owner_id === userId).length,
            flows: flows.filter(f => f.created_by === userId).length,
            services: services.filter(s => s.provider_agent_id !== null &&
              agents.some(a => a.id === s.provider_agent_id && a.owner_id === userId),
            ).length,
          },
          // Per-owner device inventory (name + type, no full state).
          inventory: {
            devices: devices.filter(d => d.owner_id === userId).map(d => ({ id: d.id, name: d.name, type: d.type })),
            agents: agents.filter(a => a.owner_id === userId).map(a => ({ id: a.id, name: a.name })),
            flows: flows.filter(f => f.created_by === userId).map(f => ({ id: f.id, name: f.name, enabled: f.enabled === 1 })),
          },
        };
      });

      // CSV export when `?format=csv`.
      const query = request.query as Record<string, unknown>;
      if (query.format === 'csv') {
        // T-112: one csvCell() helper for EVERY column. Only displayName
        // was quoted before, so a legal comma-email (EMAIL_PATTERN allows
        // them) shifted role and all per-student counts one field left in
        // the teacher's grading sheet. RFC 4180: quote when needed, double
        // embedded quotes, CRLF row separators, and neutralize formula
        // prefixes (= + - @) against CSV injection.
        const csvCell = (value: string | number): string => {
          const text = String(value);
          const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
          return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
        };
        const header =
          'userId,displayName,email,role,devices,agents,flows,services';
        const rows = entries.map(e =>
          [e.userId, e.displayName, e.email, e.role,
           e.counts.devices, e.counts.agents, e.counts.flows, e.counts.services]
            .map(csvCell)
            .join(','),
        );
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="roster-${env.id}.csv"`)
          .send([header, ...rows].join('\r\n') + '\r\n');
      }

      return {
        envId: env.id,
        envName: env.name,
        generatedAt: new Date().toISOString(),
        totalMembers: entries.length,
        entries,
      };
    },
  );

  app.get(
    '/api/environments/:id/stream',
    {
      websocket: true,
      // Auth + access check BEFORE the upgrade: anonymous is allowed for
      // public environments (optionalAuth), private requires membership.
      preValidation: [
        app.optionalAuth,
        async (request: FastifyRequest, reply) => {
          const { id } = request.params as IdParams;
          const env = ctx.envStore.getEnvironment(id);
          if (!env) {
            await reply
              .code(404)
              .send(errorBody('ENVIRONMENT_NOT_FOUND', `Environment "${id}" not found`));
            return;
          }
          const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
          if (env.visibility !== 'public' && role === undefined) {
            await reply
              .code(403)
              .send(errorBody('FORBIDDEN', `Environment "${id}" is private and you are not a member`));
          }
        },
      ],
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const { id } = request.params as IdParams;
      const env = ctx.envStore.getEnvironment(id);
      const role = request.user ? ctx.envStore.roleOf(id, request.user.id) : undefined;
      const viewer = request.user
        ? { id: request.user.id, displayName: request.user.displayName }
        : null;
      // S2 (device privacy): the per-socket device-frame projector (same
      // canonical seam as every REST device surface).
      const deviceViewer = deviceViewerOf(ctx, request.user);
      const ownershipOf = deviceOracleFor(ctx.envStore);
      const sendMessage = (message: StreamMessage): void => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // Service-layer boundary on the wire: service broadcasts are subject
        // to the same visibility rules as the REST reads (a hidden offer must
        // not leak to subscribers who could not GET it — and a granted one
        // must stream to its grantee, T-058b). Deletions carry only `{id}`
        // and always pass.
        if (
          env &&
          !serviceMessageVisibleTo(
            message,
            env,
            { userId: viewer?.id ?? null, role },
            (serviceId, userId) => ctx.serviceStore.hasActiveAccessGrant(serviceId, userId),
          )
        ) {
          return;
        }
        // T-060 (design-consent-semantics.md §6.2): agreement frames are
        // BILATERAL — same per-socket verdict as serviceMessageVisibleTo,
        // mirroring the REST 404 boundary (parties + env owner only). What
        // REST says does not exist, the stream must not rebuild.
        if (env && !agreementMessageVisibleTo(ctx, message, env, viewer?.id ?? null)) {
          return;
        }
        // S2 (device privacy): device world-frames carry the full row view —
        // project them through the same canonical seam per socket (a foreign
        // device's twin-synced telemetry must not ride the stream to members
        // or anonymous subscribers of a public world; deletions carry {id}
        // only and always pass).
        if (
          env &&
          message.kind === 'world' &&
          message.objectType === 'device' &&
          message.action !== 'deleted'
        ) {
          const object = message.object as DeviceJsonView & { initialState?: unknown };
          if (typeof object?.id === 'string') {
            const projected = projectDeviceJson(
              object,
              deviceViewer,
              ownershipOf(object.id),
              typeof object.initialState === 'object' && object.initialState !== null
                ? (object.initialState as Record<string, unknown>)
                : null,
            );
            socket.send(JSON.stringify({ ...message, object: projected }), error => {
              if (error) request.log.warn({ err: error }, 'world stream send failed');
            });
            return;
          }
        }
        socket.send(JSON.stringify(message), error => {
          if (error) request.log.warn({ err: error }, 'world stream send failed');
        });
      };
      const unsubscribe = ctx.worldSync.subscribe(id, sendMessage);
      // P4-4 metrics: gauge of live environment-stream connections.
      ctx.metrics.wsOpened('environment');
      trackStreamSocket(id, socket);
      // Presence: an authenticated viewer joins by identity (first connection
      // broadcasts 'online' to the others), an anonymous one only moves the
      // snapshot counter. The new client then gets the current roster as a
      // private snapshot; its own listener is excluded from the online
      // broadcast so it receives exactly one presence frame on connect.
      const snapshot = ctx.worldSync.joinPresence(id, viewer, { exclude: sendMessage });
      sendMessage(snapshot);

      // T-007: the stream is receive-only — answer client data with a
      // teaching error frame instead of eternal silence (browsers/ws clients
      // never send; this catches confused integrations early).
      socket.on('message', () => {
        sendMessage(makeStreamErrorFrame(
          'STREAM_READ_ONLY',
          'The world stream is receive-only (world/presence/proposal/agreement frames). '
            + 'Mutations go through the REST endpoints, e.g. POST /api/environments/:id/devices '
            + 'or PATCH /api/environments/:id.',
        ));
      });

      // T-007 heartbeat (same policy as the agreement stream, Fix-15): a
      // dead peer keeps its presence entry (user looks online forever) and
      // the ws gauge alive. Ping on a cadence; one missed pong terminates —
      // 'close' fires → cleanup leaves presence.
      let pongReceived = true;
      socket.on('pong', () => {
        pongReceived = true;
      });
      const heartbeat = setInterval(() => {
        if (!pongReceived) {
          socket.terminate();
          return;
        }
        pongReceived = false;
        socket.ping();
      }, ctx.streamHeartbeatMs);
      heartbeat.unref();

      let cleanedUp = false;
      // Living-worlds P1W (§6.1 observation pin): an open world-stream
      // connection pins the authoritative session ACTIVE — and, since the
      // crash-recovery fix, lazily RE-materializes a session lost to a hard
      // restart without a disk checkpoint (creation failures stay warn-only:
      // the stream keeps serving governance frames for envs that carry no
      // world).
      let releaseSessionPin: (() => void) | undefined;
      if (ctx.worldSessions !== undefined) {
        void ctx.worldSessions.observeOrMaterialize(id).then(release => {
          if (cleanedUp) {
            try {
              release();
            } catch {
              /* already gone */
            }
            return;
          }
          releaseSessionPin = release;
        });
      }
      const cleanup = (): void => {
        // 'error' is always followed by 'close' — leave presence only once.
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribe();
        clearInterval(heartbeat);
        ctx.metrics.wsClosed('environment');
        releaseStreamSocket(id, socket);
        ctx.worldSync.leavePresence(id, viewer);
        try {
          releaseSessionPin?.();
        } catch {
          // A pin release must never break stream cleanup.
        }
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
    },
  );
}

// ---------------------------------------------------------------------------
// Detail assembly + body parsing
// ---------------------------------------------------------------------------

/**
 * T-060 (design-consent-semantics.md §6.2): stream-side enforcement of the
 * agreement REST boundary — `{kind:'agreement'}` frames carry only an id, so
 * the row is resolved from the store and delivered only when the subscriber
 * could also GET /api/agreements/:id (party or env owner; anonymous viewers
 * of public environments get nothing). Non-agreement messages always pass.
 */
function agreementMessageVisibleTo(
  ctx: EnvironmentRoutesContext,
  message: StreamMessage,
  env: EnvironmentRow,
  userId: string | null,
): boolean {
  if (message.kind !== 'agreement') return true;
  if (userId === null) return false; // anonymous viewers are never parties
  const agreement = ctx.agreementStore.getAgreement(message.agreementId);
  if (agreement === undefined) {
    // Deleted mid-flight (cascade 'deleted' announcements) — parties of a
    // removed row still learn their loss; treat unknown rows as visible to
    // the env owner only (conservative, never leaks).
    return env.owner_id === userId;
  }
  return (
    agreement.consumer_owner_id === userId ||
    agreement.provider_owner_id === userId ||
    env.owner_id === userId
  );
}

/**
 * Stream-side enforcement of the service visibility boundary: world messages
 * about services are delivered only when the subscriber could also read the
 * service via REST. Non-service messages always pass.
 *
 * T-058b: `grants` is the per-socket access-grant oracle — a hidden offer a
 * subscriber holds an unexpired grant on streams to them too (REST says it
 * is visible; the stream must not rebuild the boundary the REST side opened).
 */
function serviceMessageVisibleTo(
  message: StreamMessage,
  env: EnvironmentRow,
  viewer: { userId: string | null; role: EnvRole | undefined },
  grants?: (serviceId: string, userId: string | null) => boolean,
): boolean {
  if (message.kind !== 'world' || message.objectType !== 'service') return true;
  if (message.action === 'deleted') return true; // deletions carry only {id}
  const object = message.object as {
    id?: unknown;
    visibility?: unknown;
    origin?: unknown;
    provider?: { owner?: { id?: unknown } };
  };
  const visibility = object.visibility;
  const providerOwnerId = object.provider?.owner?.id;
  if (
    (visibility !== 'public' && visibility !== 'members' && visibility !== 'hidden') ||
    typeof providerOwnerId !== 'string'
  ) {
    return true; // unknown shape — do not second-guess the payload
  }
  const serviceId = typeof object.id === 'string' ? object.id : null;
  return canSeeService(visibility, providerOwnerId, env, viewer, {
    accessGrant: serviceId !== null && grants !== undefined
      ? grants(serviceId, viewer.userId)
      : false,
    // T-053: derived demo mode opens members-visible derived frames exactly
    // as the REST list does (the stream must not rebuild a boundary REST
    // opened); unknown origin keeps the strict reading.
    ...(object.origin === 'derived' || object.origin === 'published'
      ? { origin: object.origin }
      : {}),
  });
}

function buildDetail(
  ctx: EnvironmentRoutesContext,
  env: EnvironmentRow,
  viewer: AuthUser | null,
  locale: UiLocale,
) {
  const users = new Map<string, PublicUser>();
  const resolve = (id: string): OwnerRef => {
    if (!users.has(id)) {
      const row = ctx.userStore.findById(id);
      if (row) users.set(id, toPublicUser(row));
    }
    return ownerRef(users.get(id), id);
  };

  // S2 (device privacy): every device-bearing read surface projects through
  // the ONE canonical seam — full for the device owner / env owner / admin,
  // coarse (structure facts + on/off-or-present status, no initialState,
  // scheme-preserved binding) for everyone else, anonymous included.
  const deviceViewer = deviceViewerOf(ctx, viewer);
  const ownershipOf = deviceOracleFor(ctx.envStore);
  const devices = ctx.envStore.devicesOf(env.id).map(row =>
    projectDeviceJson(
      deviceToJson(row, resolve(row.owner_id)) as DeviceJsonView,
      deviceViewer,
      ownershipOf(row.id),
      row.initial_state_json !== null
        ? (JSON.parse(row.initial_state_json) as Record<string, unknown>)
        : null,
    ),
  );
  const agents = ctx.envStore.agentsOf(env.id).map(row => agentToJson(row, resolve(row.owner_id)));
  // R80-FW1: raw device→zone map for the derived services' spatial anchor
  // (zone ids are governance-visible metadata — not device privacy data).
  const deviceZoneById = new Map(
    ctx.envStore.devicesOf(env.id).map(row => [row.id, row.zone_id]),
  );
  // The service layer (W3): the caller sees only the offers its visibility
  // rights allow — public/members/hidden (service-store.ts).
  const serviceRows = ctx.serviceStore.servicesOf(env.id);
  const unbacked = unbackedFlagsForEnv(ctx.envStore, serviceRows);
  // T28 (R3 u3-F1): the declaration-drift markers for capability-minted rows.
  const declarationDrift = declaredOfferDriftForEnv(ctx.envStore, serviceRows);
  const reputationScores = ctx.reputationStore.scoresForEnv(env.id);
  const agentById = new Map(ctx.envStore.agentsOf(env.id).map(row => [row.id, row]));
  const serviceViewer = {
    userId: viewer?.id ?? null,
    role: viewer ? ctx.envStore.roleOf(env.id, viewer.id) : undefined,
  };
  const services = serviceRows
    .filter(row => {
      const agent = agentById.get(row.provider_agent_id);
      return agent !== undefined && canSeeService(
        row.visibility,
        agent.owner_id,
        env,
        serviceViewer,
        // T-058b: an unexpired provider grant opens hidden offers here too.
        { accessGrant: ctx.serviceStore.hasActiveAccessGrant(row.id, serviceViewer.userId), origin: row.origin },
      );
    })
    .map(row => {
      const agent = agentById.get(row.provider_agent_id)!;
      return serviceToJson(
        row,
        { id: agent.id, name: agent.name, owner: resolve(agent.owner_id) },
        unbacked.get(row.id) ?? true,
        reputationScores.get(ReputationStore.key(row.provider_agent_id, row.semantic_type)) ??
          noHistoryView(),
        // R14 Wave-A: a registered computation flips unbacked offers
        // consumable — the env detail is a marketplace surface.
        computationSummaryFor(ctx, row.id),
        // R80-FW1: derived rows resolve their source device's zone here.
        deviceId => deviceZoneById.get(deviceId),
        // 7th/8th slots: usage summary + aggregate backing face — the env
        // detail list stays flag-level on both.
        undefined,
        undefined,
        // T28: the catalog face of declaration drift.
        declarationDrift.get(row.id) === true,
      );
    });
  const members = serializeMembers(ctx, env.id, serviceViewer.role);

  const mapData = parseMapData(env);
  return {
    id: env.id,
    name: env.name,
    description: env.description,
    mapType: env.map_type,
    // Geo map tier: projection origin + default view (null for grid maps).
    mapCenter: mapData.center ?? null,
    mapZoom: mapData.zoom ?? null,
    // Building tiers (B-A/B-B): map-level metadata (storeyHeight,
    // slabAttenuation, envelopeU, occupancy*), each null when the world
    // does not carry it. The field list is canonical (MAP_META_FIELDS).
    ...mapMetaForDetail(mapData),
    // T-032 (EC-F09): demo-playback metadata (tagline / heroEventId /
    // recommendedPlaybackRate / vendorDisclaimer) — imported from the
    // scenario meta and re-emitted by the bridge/replay exports.
    // null = the world carries no demo choreography.
    demo: mapData.demo ?? null,
    // Env-level derived-service visibility mode: the DEFAULT follows the
    // environment — public envs read 'public' (members-visible DERIVED and
    // AGGREGATE services open to anonymous visitors), others 'members'.
    // mapData.derivedServiceVisibility only tightens ('members' retracts;
    // 'public' is inert on non-public envs). Published/hidden never affected.
    derivedServiceVisibility: derivedServiceVisibilityMode(env),
    // Building tier (B-D): per-storey plan-image underlays for the grid map.
    floorPlans: mapData.floorPlans ?? [],
    // P3 (R5-F04): the world's semantic offer rules / capability synonym
    // groups — returned so clients can read-modify-write mapData without
    // losing them (empty arrays when the world carries none).
    semanticOfferRules: mapData.semanticOfferRules ?? [],
    capabilitySynonyms: mapData.capabilitySynonyms ?? [],
    visibility: env.visibility,
    owner: resolve(env.owner_id),
    // Fix-19: the owner's structured world guide (null = none). Readable by
    // everyone who can read the world — it exists for newcomers.
    guide: parseGuide(env),
    // T122 (R17-u3/R19-u4): the owner's default-simulation binding (null =
    // none). The ask/what-if/read default lanes target this sim while it is
    // RUNNING; a stale binding is disclosed + falls back, never a silent
    // world switch. Readable with the world (the disclosure names it too).
    defaultSimulationId: env.default_simulation_id,
    // T-309 (FR-F05) → T-058a: read-only governance policy — who consents to
    // world changes in this environment, DERIVED from the map data: the
    // owner-declared supervised zones always escalate (AI advisory only).
    // S1 (Task 3): plus the effective human-review breadth thresholds.
    // T-072: plus the active zone-claim decision delegations.
    governance: envGovernancePolicy(env, ctx.humanReviewThresholds, delegationJsonsFor(ctx, env.id, resolve)),
    // T-060 (§6.2, D-4 default = offered): the aggregate transparency
    // signal — agreement lifecycles went bilateral (parties + owner only),
    // so the market-temperature crumb returns as a bare count. No parties,
    // no services, no actions: non-attributed by construction.
    agreementTransparency: {
      activeCount: ctx.agreementStore.countActiveOfEnv(env.id),
      note: 'agreement activity is visible to its two parties and the environment owner only — this count is the non-attributed environment-level signal',
    },
    // Fix-19: role-boundary notice, present only in the viewer's perspective.
    // i18n: localized via the request locale (default zh-CN).
    ...(serviceViewer.role === 'viewer' ? { viewerNotice: t(locale, VIEWER_NOTICE_KEY) } : {}),
    zones: mapData.zones,
    events: mapData.events ?? [],
    devices,
    agents,
    services,
    members,
    myRole: viewer ? (ctx.envStore.roleOf(env.id, viewer.id) ?? null) : null,
    // W5: the caller's "我依赖的服务" bookmarks in this env (marketplace
    // stars); anonymous visitors have none.
    mySubscriptions: viewer ? ctx.serviceStore.subscribedServiceIds(viewer.id, env.id) : [],
    // Living-worlds P1W: the env's authoritative world session (its living
    // instance — status/simTime/checkpoint). Absent when the env has no
    // session yet (created on demand by the world-needing lanes).
    ...(ctx.worldSessions !== undefined && ctx.worldSessions.statusOf(env.id) !== undefined
      ? { worldSession: ctx.worldSessions.statusOf(env.id) }
      : {}),
    createdAt: env.created_at,
    updatedAt: env.updated_at,
  };
}

/**
 * Service offers in one environment visible to the caller (Fix-13, R5 F-03):
 * the list endpoint's counts.services. Same rule as the detail view
 * (canSeeService over the provider agent's owner).
 */
function visibleServiceCount(
  ctx: EnvironmentRoutesContext,
  env: EnvironmentRow,
  myRole: EnvRole | null,
  userId: string,
): number {
  const ownerByAgentId = new Map(
    ctx.envStore.agentsOf(env.id).map(agent => [agent.id, agent.owner_id]),
  );
  const viewer = { userId, role: myRole ?? undefined };
  let count = 0;
  for (const row of ctx.serviceStore.servicesOf(env.id)) {
    const providerOwnerId = ownerByAgentId.get(row.provider_agent_id);
    if (
      providerOwnerId !== undefined &&
      canSeeService(
        row.visibility,
        providerOwnerId,
        env,
        viewer,
        // T-058b: unexpired provider grants open hidden offers in the count
        // too (the list and its count must agree). T-053: origin rides along.
        { accessGrant: ctx.serviceStore.hasActiveAccessGrant(row.id, userId), origin: row.origin },
      )
    ) {
      count += 1;
    }
  }
  return count;
}

function cachedOwner(
  ctx: EnvironmentRoutesContext,
  cache: Map<string, OwnerRef>,
  userId: string,
): OwnerRef {
  if (!cache.has(userId)) {
    const row = ctx.userStore.findById(userId);
    cache.set(userId, ownerRef(row ? toPublicUser(row) : undefined, userId));
  }
  return cache.get(userId)!;
}

/**
 * The environment's member list, redacted to the caller's perspective
 * (Fix-4, P1-6; Fix-13, R5 F-04): owner/builder get the full view (userId +
 * email), viewers, non-members and anonymous visitors get displayName + role
 * only. Single conversion point shared by the detail view and GET /members.
 */
function serializeMembers(
  ctx: EnvironmentRoutesContext,
  envId: string,
  viewerRole: EnvRole | undefined,
) {
  const seesContacts = viewerRole === 'owner' || viewerRole === 'builder';
  return ctx.envStore
    .membersOf(envId)
    .map(member => memberToJson(member, ctx.userStore.findById(member.user_id), seesContacts));
}


/** Assignable roles on invite / role change — 'owner' is never assignable. */



function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', `Body field "${field}" must be a string`);
  }
  return value;
}

/** Optional query param: undefined when absent, 400 when empty/non-string. */
function optionalQueryParam(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Query "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a client-supplied guide object (Fix-19): all fields optional
 * text; `roleGuide` is an object of optional per-role strings. `null`
 * clears the guide.
 */
function parseGuideInput(raw: unknown): EnvGuide | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "guide" must be an object or null');
  }
  const input = raw as Record<string, unknown>;
  const guide: EnvGuide = {};
  for (const field of ['purpose', 'zoneGuide', 'serviceMap'] as const) {
    if (input[field] !== undefined) {
      guide[field] = requireString(input[field], `guide.${field}`);
    }
  }
  if (input.roleGuide !== undefined) {
    const roleGuide = input.roleGuide;
    if (typeof roleGuide !== 'object' || roleGuide === null || Array.isArray(roleGuide)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "guide.roleGuide" must be an object');
    }
    const parsed: { builder?: string; viewer?: string } = {};
    for (const role of ['builder', 'viewer'] as const) {
      const value = (roleGuide as Record<string, unknown>)[role];
      if (value !== undefined) {
        parsed[role] = requireString(value, `guide.roleGuide.${role}`);
      }
    }
    guide.roleGuide = parsed;
  }
  return guide;
}

function parseVisibility(value: unknown): EnvVisibility | undefined {
  if (value === undefined) return undefined;
  if (value === 'public' || value === 'private') return value;
  throw new ApiError(
    400,
    'BAD_REQUEST',
    `Body field "visibility" must be one of "public" | "private", got ${JSON.stringify(value)}`,
  );
}

/**
 * Validate a client-supplied mapData object: the zone list (all map types),
 * plus, for the 'geo' map tier, the projection center and per-zone polygons
 * (geo.ts). Scheduled events (`mapData.events`) are validated against the
 * zone list for any map type.
 */
function parseMapDataInput(raw: unknown, mapType: string): EnvMapData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData" must be an object');
  }
  const zonesRaw = (raw as { zones?: unknown }).zones ?? [];
  if (!Array.isArray(zonesRaw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData.zones" must be an array');
  }
  const seen = new Set<string>();
  const zones: EnvZone[] = zonesRaw.map((zone, index) => {
    if (typeof zone !== 'object' || zone === null || typeof (zone as EnvZone).id !== 'string' ||
      (zone as EnvZone).id.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Every mapData.zones entry must have a non-empty string "id"');
    }
    const z = zone as EnvZone;
    if (seen.has(z.id)) {
      throw new ApiError(400, 'BAD_REQUEST', `Duplicate zone id "${z.id}" in mapData.zones`);
    }
    seen.add(z.id);
    if (mapType === 'geo') {
      z.polygon = parseGeoPolygon((zone as { polygon?: unknown }).polygon, `mapData.zones[${index}].polygon`);
    }
    // T-058a: the zone consent class is owner-authored governance metadata —
    // validate the enum so a typo cannot silently fall back to 'standard'
    // (a mistyped 'supervized' ward would keep auto-applying installs).
    if (z.consentClass !== undefined) {
      if (!ZONE_CONSENT_CLASSES.includes(z.consentClass)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `mapData.zones[${index}].consentClass must be one of ` +
            `${ZONE_CONSENT_CLASSES.map(c => `"${c}"`).join(' | ')} — got "${String(z.consentClass)}" ` +
            '(\'supervised\' zones always escalate proposals touching them to the environment owner; ' +
            "'restricted' is reserved for future multi-person consent)",
        );
      }
    }
    // DevLoop AI Explorer finding: partial bounds (e.g. only minX) were
    // silently accepted, breaking the map renderer later. Validate completeness.
    if (z.bounds !== undefined) {
      const b = z.bounds as Record<string, unknown>;
      const required = ['minX', 'maxX', 'minY', 'maxY'];
      const missing = required.filter(key => typeof b[key] !== 'number' || !Number.isFinite(b[key]));
      if (missing.length > 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `mapData.zones[${index}].bounds is incomplete — missing: ${missing.map(f => `"${f}"`).join(', ')}. ` +
            'Bounds require all four numeric fields: minX, maxX, minY, maxY',
        );
      }
      if ((b.minX as number) >= (b.maxX as number) || (b.minY as number) >= (b.maxY as number)) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `mapData.zones[${index}].bounds is degenerate — minX must be < maxX and minY < < maxY`,
        );
      }
    }
    return z;
  });
  const eventsRaw = (raw as { events?: unknown }).events;
  let events: EnvMapData['events'];
  if (eventsRaw !== undefined) {
    if (!Array.isArray(eventsRaw)) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData.events" must be an array');
    }
    events = eventsRaw.map((event, index) => parseMapEvent(event, seen, `mapData.events[${index}]`));
  }
  // Building tiers (B-A/B-B): map-level metadata rides the canonical field
  // list (environment-store.ts), so new meta fields need no change here.
  const meta: Partial<EnvMapData> = {};
  for (const field of MAP_META_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (meta as Record<string, number>)[field] = value;
    }
  }
  // Building tier (B-D): per-storey plan-image underlays.
  const floorPlans = parseFloorPlansInput((raw as { floorPlans?: unknown }).floorPlans);
  // T-032: demo-playback metadata (validated; absent = none).
  const demo = parseDemoInput((raw as { demo?: unknown }).demo);
  // Env-level derived-service visibility knob (validated enum; absent = the
  // env-following default — public envs default 'public', others 'members').
  const derivedServiceVisibility = parseDerivedServiceVisibilityInput(
    (raw as { derivedServiceVisibility?: unknown }).derivedServiceVisibility,
  );
  // S1 (Task 3): owner-authored human-review governance thresholds
  // (validated; absent = deployment defaults). The PATCH route carrying
  // parseMapDataInput is owner-only, so proposals can never arm this.
  const governance = parseGovernanceInput((raw as { governance?: unknown }).governance);
  // P3 (R5-F04): scenario-authored semantic offer rules / capability
  // synonym groups ride the same whitelist — silently dropping them on any
  // mapData PATCH gutted the semantic service layer with no way to write
  // them back. Validation reuses the storage passthrough filters so an
  // entry loadable from map_data_json is always re-writable here.
  const semanticOfferRules = filterSemanticOfferRules(
    (raw as { semanticOfferRules?: unknown }).semanticOfferRules,
  );
  const capabilitySynonyms = filterCapabilitySynonyms(
    (raw as { capabilitySynonyms?: unknown }).capabilitySynonyms,
  );
  const p3Fields: Partial<EnvMapData> = {
    ...(semanticOfferRules !== undefined ? { semanticOfferRules } : {}),
    ...(capabilitySynonyms !== undefined ? { capabilitySynonyms } : {}),
  };
  if (mapType === 'geo') {
    const geo = parseGeoMapData(raw);
    return { zones, center: geo.center, ...(geo.zoom !== undefined ? { zoom: geo.zoom } : {}), ...meta, ...(events !== undefined ? { events } : {}), ...(floorPlans !== undefined ? { floorPlans } : {}), ...(demo !== undefined ? { demo } : {}), ...(derivedServiceVisibility !== undefined ? { derivedServiceVisibility } : {}), ...(governance !== undefined ? { governance } : {}), ...p3Fields };
  }
  return { zones, ...meta, ...(events !== undefined ? { events } : {}), ...(floorPlans !== undefined ? { floorPlans } : {}), ...(demo !== undefined ? { demo } : {}), ...(derivedServiceVisibility !== undefined ? { derivedServiceVisibility } : {}), ...(governance !== undefined ? { governance } : {}), ...p3Fields };
}





/**
 * Validate `mapData.demo` (T-032): the demo-playback metadata block. Known
 * fields with unexpected shapes are REJECTED with a teaching message (the
 * standing silent-drop lesson), unknown sub-fields are ignored so future
 * additions stay loadable.
 */
function parseDemoInput(raw: unknown): EnvDemoMeta | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData.demo" must be an object');
  }
  const demo: EnvDemoMeta = {};
  const block = raw as Record<string, unknown>;
  if (block.tagline !== undefined) {
    const tagline = block.tagline as { zh?: unknown; en?: unknown };
    if (
      typeof tagline !== 'object' || tagline === null ||
      typeof tagline.zh !== 'string' || typeof tagline.en !== 'string'
    ) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "mapData.demo.tagline" must be a {zh, en} object of strings',
      );
    }
    demo.tagline = tagline as EnvDemoMeta['tagline'];
  }
  if (block.heroEventId !== undefined) {
    if (typeof block.heroEventId !== 'string' || block.heroEventId.length === 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "mapData.demo.heroEventId" must be a non-empty string (the event id the demo UI auto-focuses)',
      );
    }
    demo.heroEventId = block.heroEventId;
  }
  if (block.recommendedPlaybackRate !== undefined) {
    const rate = block.recommendedPlaybackRate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "mapData.demo.recommendedPlaybackRate" must be a positive number (1 = real-time)',
      );
    }
    demo.recommendedPlaybackRate = rate;
  }
  if (block.vendorDisclaimer !== undefined) {
    const disclaimer = block.vendorDisclaimer as { zh?: unknown; en?: unknown };
    if (typeof disclaimer === 'string') {
      demo.vendorDisclaimer = disclaimer;
    } else if (
      typeof disclaimer === 'object' && disclaimer !== null &&
      typeof disclaimer.zh === 'string' && typeof disclaimer.en === 'string'
    ) {
      demo.vendorDisclaimer = disclaimer as NonNullable<EnvDemoMeta['vendorDisclaimer']>;
    } else {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "mapData.demo.vendorDisclaimer" must be a string or a {zh, en} object',
      );
    }
  }
  return Object.keys(demo).length > 0 ? demo : undefined;
}

/** Validate mapData.floorPlans entries (B-D plan-image underlays). */
function parseFloorPlansInput(raw: unknown): EnvFloorPlan[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Body field "mapData.floorPlans" must be an array');
  }
  return raw.map((entry, index) => {
    const plan = entry as Partial<EnvFloorPlan>;
    const where = `mapData.floorPlans[${index}]`;
    if (typeof plan !== 'object' || plan === null) {
      throw new ApiError(400, 'BAD_REQUEST', `${where} must be an object`);
    }
    if (typeof plan.floor !== 'number' || !Number.isInteger(plan.floor)) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.floor must be an integer`);
    }
    if (typeof plan.image !== 'string' || plan.image.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.image must be a non-empty string (URL or data URI)`);
    }
    if (
      typeof plan.pixelsPerMeter !== 'number' ||
      !Number.isFinite(plan.pixelsPerMeter) ||
      plan.pixelsPerMeter <= 0
    ) {
      throw new ApiError(400, 'BAD_REQUEST', `${where}.pixelsPerMeter must be a positive number`);
    }
    return {
      ...(typeof plan.buildingId === 'string' && plan.buildingId.length > 0
        ? { buildingId: plan.buildingId }
        : {}),
      floor: plan.floor,
      image: plan.image,
      pixelsPerMeter: plan.pixelsPerMeter,
    };
  });
}
