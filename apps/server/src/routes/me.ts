/**
 * User-perspective routes (W5) — 世界视角看生态，我的视角看"我有什么 /
 * 我用什么 / 我在参与什么 / 我要构建什么".
 *
 * - `GET /api/me/overview` (auth) — the workbench home payload: per-env
 *   cards (only environments the caller is a MEMBER of) with ownership
 *   counts, subscription counts, the caller's live simulations and their
 *   all-time `simulationCount` (created-ever, any state — the onboarding
 *   "启动过仿真" signal; R6-D-F02: `hasWorldSession` complements it — the
 *   R73 always-on world runs without anyone creating a simulation), plus
 *   flat cross-env lists of the caller's published services and service
 *   subscriptions, plus the Fix-16 `todos` doorbell counts
 *   (pendingProposals / pendingAgreements / unreadNotifications).
 * - `GET /api/environments/:id/deployment` (auth, member) — the caller's
 *   deployment manifest for one environment: agents to run, devices to
 *   procure (joined to the hardware catalog by vendor+device_type; an
 *   ambiguous match leaves the catalog fields null), each device's binding
 *   + deploymentStatus (bridged = hass:// real hardware, simulation-only),
 *   the twin-sync bindings wired to the caller's devices (Fix-18, R7 F-05),
 *   services to offer, services consumed (the caller's subscriptions), and
 *   generated notes.
 * - `PATCH /api/me` (auth) — rename the caller (`{displayName}`; non-empty,
 *   ≤80 chars — Fix-13, R5 F-02: the self-service repair path for a
 *   displayName mangled at registration, e.g. by an encoding mishap).
 *   Returns the updated public user.
 * - `GET/PUT/DELETE /api/me/notification-webhook` (auth) — the caller's
 *   outbound notification webhook (Wave-4b): every notification of theirs is
 *   POSTed to this URL as JSON (full notification payload — sensitive
 *   content included). PUT validates http(s)-only; DELETE clears.
 * - `GET /api/me/quotas` (auth) — P4-4 quota introspection: limit + current
 *   usage per quota (environments owned, fullest owned env's device/agent
 *   counts, live simulations, fullest env's active sandboxes).
 *
 * "Running" simulations are registry entries the caller created on the
 * environment whose runtime state is 'running' or 'paused' (created-but-
 * never-started and stopped runs do not count); anonymous legacy creations
 * carry no creator and belong to no one.
 */

import type { FastifyInstance } from 'fastify';

import { getEnvironmentOrThrow, requireEnvRole } from '../env-access.js';
import { t } from '../i18n/index.js';
import type { UiLocale } from '@active-collaboration/shared';
import type { AgreementStore } from '../db/agreement-store.js';
import type { CatalogStore, DeviceModelRow } from '../db/catalog-store.js';
import type { NotificationStore } from '../db/notification-store.js';
import type { ProposalStore } from '../db/proposal-store.js';
import {
  parseJsonArray,
  type AgentInstanceRow,
  type DeviceInstanceRow,
  type EnvironmentRow,
  type EnvironmentStore,
} from '../db/environment-store.js';
import type { SandboxStore } from '../db/sandbox-store.js';
import type { ServiceInstanceRow, ServiceStore } from '../db/service-store.js';
import { toPublicUser, type UserStore } from '../db/user-store.js';
import { ApiError } from '../errors.js';
import type { QuotaConfig } from '../quotas.js';
import { parseDemandSource, type CapabilityDemandStore } from '../db/capability-demand-store.js';
import type { SimulationRegistry, SimulationSummary } from '../simulation-registry.js';
import type { TwinSyncService } from '../twin-sync.js';

export interface MeRoutesContext {
  envStore: EnvironmentStore;
  serviceStore: ServiceStore;
  userStore: UserStore;
  catalogStore: CatalogStore;
  registry: SimulationRegistry;
  /** P-C: per-env active-sandbox counts (sandboxes_per_user_per_env quota). */
  sandboxStore: SandboxStore;
  /** P4-4 quotas (reported by GET /api/me/quotas). */
  quotas: QuotaConfig;
  /** R80-FW3: capability-demand telemetry sink (see POST /api/me/capability-demand). */
  capabilityDemandStore: CapabilityDemandStore;
  /** Fix-16: the overview's todo counts (owner approvals, provider decides, unread bell). */
  proposalStore: ProposalStore;
  agreementStore: AgreementStore;
  notificationStore: NotificationStore;
  /** Fix-18 (R7 F-05): twin-sync binding summary on the deployment manifest. */
  twinSync: TwinSyncService;
  /**
   * R6-D-F02: world-session presence per env (the R73 always-on world runs
   * WITHOUT anyone creating a simulation, so `simulationCount` never sees
   * it — the overview carries this flag for the onboarding ③ signal).
   * Optional: tests may omit.
   */
  worldSessions?: {
    statusOf(envId: string): { status: 'active' | 'idle' | 'hibernated' } | undefined;
  };
}

/** Registry states counted as "运行中" for the overview/deployment numbers. */
const LIVE_SIM_STATES: ReadonlySet<SimulationSummary['state']> = new Set(['running', 'paused']);

/** displayName length cap for PATCH /api/me (Fix-13). */
const MAX_DISPLAY_NAME_LENGTH = 80;

/** One devicesToDeploy entry: catalog fields only on an unambiguous match. */
interface DeviceToDeploy {
  instanceId: string;
  name: string;
  type: string;
  zoneId: string;
  position: unknown;
  /** Fix-18 (R7 F-05): the deployment binding (sim://… default, hass://<entity> when bridged). */
  binding: string;
  /** Fix-18 (R7 F-05): 'bridged' = wired to real hardware; 'simulation-only' = not yet. */
  deploymentStatus: 'bridged' | 'simulation-only';
  catalogModelId?: string;
  vendor?: string;
  model?: string;
  priceCny?: number;
  purchaseUrl?: string;
}

export function registerMeRoutes(app: FastifyInstance, ctx: MeRoutesContext): void {
  /**
   * Rename the caller (Fix-13, R5 F-02). Registration had no rename path, so
   * a displayName mangled at signup (e.g. an encoding mishap on the client
   * side) was irreversible — this is the self-service repair.
   */
  app.patch('/api/me', { preHandler: app.authenticate }, async request => {
    const userRow = ctx.userStore.findById(request.user!.id);
    if (!userRow) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (displayName.length === 0) {
      throw new ApiError(400, 'INVALID_DISPLAY_NAME', 'Body field "displayName" must be a non-empty string');
    }
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new ApiError(
        400,
        'INVALID_DISPLAY_NAME',
        `Body field "displayName" must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
      );
    }
    return toPublicUser(ctx.userStore.updateDisplayName(userRow.id, displayName));
  });

  /**
   * Outbound notification webhook (Wave-4b): the recipient's endpoint that
   * gets every persisted notification POSTed as JSON (fire-and-forget, 5s
   * timeout, one retry — see notification-webhook.ts). http(s) only: the URL
   * receives the FULL notification payload, so anything else (file:, ftp:…)
   * is rejected outright. Delivery failures never touch the inbox row.
   */
  app.get('/api/me/notification-webhook', { preHandler: app.authenticate }, async request => {
    const userRow = ctx.userStore.findById(request.user!.id);
    if (!userRow) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    return { url: userRow.webhook_url };
  });

  app.put('/api/me/notification-webhook', { preHandler: app.authenticate }, async request => {
    const userRow = ctx.userStore.findById(request.user!.id);
    if (!userRow) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (url.length === 0) {
      throw new ApiError(400, 'INVALID_WEBHOOK_URL', 'Body field "url" must be a non-empty string');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(400, 'INVALID_WEBHOOK_URL', `Webhook url "${url}" is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(
        400,
        'INVALID_WEBHOOK_URL',
        `Webhook url protocol must be http | https, got "${parsed.protocol.slice(0, -1)}"`,
      );
    }
    ctx.userStore.setWebhookUrl(userRow.id, url);
    return { url };
  });

  app.delete('/api/me/notification-webhook', { preHandler: app.authenticate }, async request => {
    const userRow = ctx.userStore.findById(request.user!.id);
    if (!userRow) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
    ctx.userStore.setWebhookUrl(userRow.id, null);
    return { url: null };
  });

  /**
   * Quota introspection (P4-4): each quota with its configured limit and the
   * caller's current usage. For the per-env quotas, `used` is the largest
   * object count across environments the caller OWNS — the binding number
   * for their next create in their fullest world (0 when they own none).
   */
  /**
   * R80-FW3 — capability-demand telemetry sink (auth). One row per
   * (user, env, capability, source); repeats aggregate server-side. The
   * client fires-and-forgets — a failed report must never block the UI.
   */
  app.post('/api/me/capability-demand', { preHandler: app.authenticate }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const capability = typeof body.capability === 'string' ? body.capability.trim().toLowerCase() : '';
    if (capability.length === 0 || capability.length > 100) {
      throw new ApiError(400, 'BAD_REQUEST', 'Body field "capability" must be a 1-100 char string');
    }
    const source = parseDemandSource(body.source);
    if (source === undefined) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body field "source" must be one of "wizard-unbacked-chip" | "wizard-rejected-declaration" | "catalog-zero-hit"',
      );
    }
    const envId = typeof body.envId === 'string' && body.envId.length > 0 ? body.envId : null;
    if (envId !== null && ctx.envStore.getEnvironment(envId) === undefined) {
      throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
    }
    ctx.capabilityDemandStore.record({
      userId: request.user!.id,
      envId,
      capability,
      source,
    });
    return reply.code(204).send();
  });

  app.get('/api/me/quotas', { preHandler: app.authenticate }, async request => {
    const userId = request.user!.id;
    return {
      quotas: {
        environmentsPerUser: {
          limit: ctx.quotas.maxEnvsPerUser,
          used: ctx.envStore.countEnvironmentsOwnedBy(userId),
        },
        devicesPerEnv: {
          limit: ctx.quotas.maxDevicesPerEnv,
          used: ctx.envStore.maxDevicesInOwnedEnvs(userId),
        },
        agentsPerEnv: {
          limit: ctx.quotas.maxAgentsPerEnv,
          used: ctx.envStore.maxAgentsInOwnedEnvs(userId),
        },
        runningSimsPerUser: {
          limit: ctx.quotas.maxRunningSimsPerUser,
          used: ctx.registry.countLiveByUser(userId),
        },
        // P-C: the caller's fullest single environment (active sandboxes).
        sandboxesPerUserPerEnv: {
          limit: ctx.quotas.maxSandboxesPerUserPerEnv,
          used: ctx.sandboxStore.maxActiveForUser(userId),
        },
      },
    };
  });

  app.get('/api/me/overview', { preHandler: app.authenticate }, async request => {
    const authUser = request.user!;
    const userRow = ctx.userStore.findById(authUser.id);
    if (!userRow) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');

    // The user perspective covers environments the caller PARTICIPATES in —
    // public worlds they merely can see are the world view's business.
    const memberships = ctx.envStore.listVisibleFor(authUser.id).filter(row => row.my_role !== null);
    const simulations = ctx.registry.list();
    const subscriptionCounts = ctx.serviceStore.subscriptionCountsByEnv(authUser.id);

    const environments = memberships.map(env => {
      const counts = ownershipCounts(ctx, env.id, authUser.id);
      // R47: a stakeholder's workbench must attach to ANY live sim on their
      // environment, not only ones they created — memberships already holds
      // envs where the caller has a role, so this matches the sim list
      // route's creator-OR-member visibility exactly.
      const liveSims = simulations.filter(
        sim => sim.environmentId === env.id && LIVE_SIM_STATES.has(sim.state),
      );
      // 曾创建过仿真：all states count (created/running/paused/stopped) —
      // the onboarding checklist's "启动过仿真" signal. Anonymous legacy
      // creations carry no creator and belong to no one.
      const simulationCount = simulations.filter(
        sim => sim.environmentId === env.id && sim.createdBy === authUser.id,
      ).length;
      // T63 (R6, u1-F4/u2-F-2-1): the MY- creations figure beside the env-wide
      // one — the workbench row counts every live sim of the environment
      // (others' included, the R47 attach semantics), and without this second
      // figure the two annotations ("env 内全部" vs quota 的 "你创建的")
      // contradicted each other.
      const myLiveSims = simulations.filter(
        sim =>
          sim.environmentId === env.id &&
          sim.createdBy === authUser.id &&
          LIVE_SIM_STATES.has(sim.state),
      );
      return {
        id: env.id,
        name: env.name,
        mapType: env.map_type,
        myRole: env.my_role,
        myAgents: counts.agents,
        myDevices: counts.devices,
        myServices: counts.services,
        mySubscriptions: subscriptionCounts.get(env.id) ?? 0,
        runningSimulations: liveSims.length,
        runningSimulationIds: liveSims.map(sim => sim.id),
        // T63: the caller's own creations among them (running/paused).
        myRunningSimulations: myLiveSims.length,
        simulationCount,
        // R6-D-F02: the R73 always-on world session (any state, hibernated
        // included) — the official-path user "跑过仿真" without ever
        // creating a simulation, which simulationCount cannot see.
        hasWorldSession: ctx.worldSessions?.statusOf(env.id) !== undefined,
        // R2-FEAT-07: my blueprint-installed objects (installed_from
        // lineage) — onboarding ② must not credit template-import content.
        myBlueprintInstalls: counts.blueprintInstalls,
      };
    });

    const envNameById = new Map(memberships.map(env => [env.id, env.name]));
    const myServices = memberships.flatMap(env =>
      servicesOwnedBy(ctx, env.id, authUser.id).map(service => ({
        id: service.id,
        envId: env.id,
        envName: env.name,
        name: service.name,
        semanticType: service.semantic_type,
        origin: service.origin,
      })),
    );
    const mySubscriptions = ctx.serviceStore.subscriptionsOf(authUser.id).map(service => {
      const agent = ctx.envStore.getAgent(service.provider_agent_id);
      const owner = agent ? ctx.userStore.findById(agent.owner_id) : undefined;
      return {
        id: service.id,
        envId: service.env_id,
        envName: envNameById.get(service.env_id) ??
          ctx.envStore.getEnvironment(service.env_id)?.name ??
          service.env_id,
        name: service.name,
        semanticType: service.semantic_type,
        provider: {
          agentId: service.provider_agent_id,
          agentName: agent?.name ?? service.provider_agent_id,
          // Fix-10: the deployment flow needs the owner's id ("找谁签约"),
          // not just a display name.
          ownerId: agent?.owner_id ?? '',
          ownerName: owner?.display_name ?? agent?.owner_id ?? '',
        },
      };
    });

    return {
      user: toPublicUser(userRow),
      environments,
      totals: {
        environments: environments.length,
        myAgents: environments.reduce((sum, env) => sum + env.myAgents, 0),
        myDevices: environments.reduce((sum, env) => sum + env.myDevices, 0),
        myServices: environments.reduce((sum, env) => sum + env.myServices, 0),
        mySubscriptions: environments.reduce((sum, env) => sum + env.mySubscriptions, 0),
        // T63: the workbench figure is ENV-WIDE (every live sim of every
        // environment the caller participates in, others' included — the
        // R47 attach semantics); the my- figure below is the caller's own.
        runningSimulations: environments.reduce((sum, env) => sum + env.runningSimulations, 0),
        myRunningSimulations: environments.reduce((sum, env) => sum + (env.myRunningSimulations ?? 0), 0),
        simulationCount: environments.reduce((sum, env) => sum + env.simulationCount, 0),
      },
      // Fix-16 待办：owner 视角的待批提案（作者走通知收件箱）、provider
      // 视角的待 accept 合约、未读通知数（门铃）。
      todos: {
        pendingProposals: ctx.proposalStore.countEscalatedForEnvOwner(authUser.id),
        pendingAgreements: ctx.agreementStore.countAgreementsAwaitingDecision(authUser.id),
        unreadNotifications: ctx.notificationStore.countUnread(authUser.id),
      },
      myServices,
      mySubscriptions,
    };
  });

  app.get(
    '/api/environments/:id/deployment',
    { preHandler: app.authenticate },
    async request => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const env = getEnvironmentOrThrow(ctx.envStore, id);
      // The manifest is member-only: it is the "我在参与什么" answer, and a
      // public world's visitors have no deployment of their own here.
      requireEnvRole(ctx.envStore, env.id, user, ['owner', 'builder', 'viewer']);

      const myAgents = ctx.envStore.agentsOf(env.id).filter(agent => agent.owner_id === user.id);
      const myDevices = ctx.envStore.devicesOf(env.id).filter(device => device.owner_id === user.id);
      const myServices = servicesOwnedBy(ctx, env.id, user.id);

      const devicesToDeploy: DeviceToDeploy[] = myDevices.map(device => {
        const match = matchCatalogModel(ctx.catalogStore, device);
        const entry: DeviceToDeploy = {
          instanceId: device.id,
          name: device.name,
          type: device.type,
          zoneId: device.zone_id,
          position: device.position_json !== null ? JSON.parse(device.position_json) : null,
          // Fix-18 (R7 F-05): mirror deviceToJson's binding wire form so the
          // manifest tells bridged real hardware apart from sim-only devices.
          binding: device.binding ?? `sim://${device.id}`,
          deploymentStatus: device.binding !== null && device.binding.startsWith('hass://')
            ? 'bridged'
            : 'simulation-only',
        };
        if (match !== undefined) {
          entry.catalogModelId = match.id;
          entry.vendor = match.vendor;
          entry.model = match.model;
          if (match.price_cny !== null) entry.priceCny = match.price_cny;
          if (match.purchase_url !== null) entry.purchaseUrl = match.purchase_url;
        } else if (device.brand !== null) {
          entry.vendor = device.brand;
        }
        return entry;
      });

      // Fix-18 (R7 F-05): twin-sync summary for the caller's own devices —
      // which sensory attributes are wired to a real data source.
      const myDeviceIds = new Set(myDevices.map(device => device.id));
      const syncBindings = ctx.twinSync
        .listBindings(env.id)
        .filter(row => myDeviceIds.has(row.device_instance_id))
        .map(row => ({
          deviceInstanceId: row.device_instance_id,
          attributeKey: row.attribute_key,
          source: row.source,
          status: row.status,
        }));

      const servicesToOffer = myServices.map(service => ({
        id: service.id,
        name: service.name,
        semanticType: service.semantic_type,
        origin: service.origin,
        backedByDeviceIds: backedByDeviceIds(ctx, service),
      }));

      const servicesConsumed = ctx.serviceStore.subscriptionsOf(user.id, env.id).map(service => {
        const agent = ctx.envStore.getAgent(service.provider_agent_id);
        const owner = agent ? ctx.userStore.findById(agent.owner_id) : undefined;
        return {
          id: service.id,
          name: service.name,
          semanticType: service.semantic_type,
          provider: {
            agentId: service.provider_agent_id,
            agentName: agent?.name ?? service.provider_agent_id,
            // Fix-10: the deployment flow needs the owner's id ("找谁签约"),
            // not just a display name.
            ownerId: agent?.owner_id ?? '',
            ownerName: owner?.display_name ?? agent?.owner_id ?? '',
          },
        };
      });

      return {
        environment: { id: env.id, name: env.name },
        myAgents: myAgents.map(agent => ({
          id: agent.id,
          name: agent.name,
          capabilities: parseJsonArray<string>(agent.capabilities_json),
          llm: agent.llm_json !== null ? JSON.parse(agent.llm_json) : null,
        })),
        devicesToDeploy,
        syncBindings,
        servicesToOffer,
        servicesConsumed,
        notes: deploymentNotes(myAgents, myDevices, devicesToDeploy, request.locale),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** Per-env ownership counts for the overview cards. */
function ownershipCounts(
  ctx: MeRoutesContext,
  envId: string,
  userId: string,
): { devices: number; agents: number; services: number; blueprintInstalls: number } {
  const devices = ctx.envStore.devicesOf(envId).filter(device => device.owner_id === userId);
  const agents = ctx.envStore.agentsOf(envId).filter(agent => agent.owner_id === userId);
  const services = servicesOwnedBy(ctx, envId, userId).length;
  // R2-FEAT-07: blueprint lineage (Fix-38 `installed_from`) is the only
  // provenance that separates a deliberate blueprint install from objects a
  // scenario/template import credited to the importer — the onboarding
  // checklist's ②「装蓝图」signal. Template-import rows carry NULL.
  const blueprintInstalls =
    devices.filter(device => device.installed_from !== null).length +
    agents.filter(agent => agent.installed_from !== null).length;
  return { devices: devices.length, agents: agents.length, services, blueprintInstalls };
}

/** Services offered by the user's own agents inside one environment. */
function servicesOwnedBy(
  ctx: MeRoutesContext,
  envId: string,
  userId: string,
): ServiceInstanceRow[] {
  const myAgentIds = new Set(
    ctx.envStore
      .agentsOf(envId)
      .filter(agent => agent.owner_id === userId)
      .map(agent => agent.id),
  );
  return ctx.serviceStore.servicesOf(envId).filter(service => myAgentIds.has(service.provider_agent_id));
}

/**
 * Devices backing a service offer: the source device for derived rows; for
 * published rows, the provider agent's bound devices whose capabilities
 * cover the semantic type (the same rule as the `unbacked` flag).
 */
function backedByDeviceIds(ctx: MeRoutesContext, service: ServiceInstanceRow): string[] {
  if (service.origin === 'derived') {
    return service.source_device_id !== null ? [service.source_device_id] : [];
  }
  const agent = ctx.envStore.getAgent(service.provider_agent_id);
  if (!agent) return [];
  const backed: string[] = [];
  for (const deviceId of parseJsonArray<string>(agent.bound_device_ids_json)) {
    const device = ctx.envStore.getDevice(deviceId);
    if (!device) continue;
    if (parseJsonArray<string>(device.capabilities_json).includes(service.semantic_type)) {
      backed.push(device.id);
    }
  }
  return backed;
}

/**
 * Join a device instance to the hardware catalog. Instances carry no
 * modelId, so the match key is (brand → vendor, type → device_type) over
 * 'active' models; zero or MULTIPLE matches both yield `undefined` (an
 * ambiguous match is worse than none — the manifest leaves catalog fields
 * null and the notes flag it for manual confirmation).
 */
function matchCatalogModel(
  catalogStore: CatalogStore,
  device: DeviceInstanceRow,
): DeviceModelRow | undefined {
  if (device.brand === null) return undefined;
  const matches = catalogStore
    .listActive({ vendor: device.brand, deviceType: device.type });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Generated hints for the manifest reader (Chinese, user-facing). */
function deploymentNotes(
  myAgents: AgentInstanceRow[],
  myDevices: DeviceInstanceRow[],
  devicesToDeploy: DeviceToDeploy[],
  locale: UiLocale,
): string[] {
  const notes: string[] = [];

  const deviceIds = new Set(myDevices.map(device => device.id));
  for (const agent of myAgents) {
    const boundExisting = parseJsonArray<string>(agent.bound_device_ids_json).filter(id =>
      deviceIds.has(id),
    );
    if (boundExisting.length === 0) {
      notes.push(t(locale, 'chrome.manifest.pureSoftwareAgent', { name: agent.name }));
    }
  }

  const matched = devicesToDeploy.filter(device => device.catalogModelId !== undefined);
  if (matched.length > 0) {
    const total = matched.reduce((sum, device) => sum + (device.priceCny ?? 0), 0);
    notes.push(t(locale, 'chrome.manifest.devicesToBuy', { count: matched.length, total }));
  }
  const unmatched = devicesToDeploy.length - matched.length;
  if (unmatched > 0) {
    notes.push(t(locale, 'chrome.manifest.unmatchedDevices', { count: unmatched }));
  }
  // Fix-18 (R7 F-05): deployment progress — bridged devices are already
  // wired to real hardware; the rest are simulation-only so far.
  const bridged = devicesToDeploy.filter(device => device.deploymentStatus === 'bridged');
  if (bridged.length > 0) {
    notes.push(t(locale, 'chrome.manifest.bridgedDevices', { count: bridged.length }));
  }
  if (myAgents.length === 0 && myDevices.length === 0) {
    notes.push(t(locale, 'chrome.manifest.emptyWorldHint'));
  }
  return notes;
}
