/**
 * buildServer — Fastify factory for the simulation API server
 *
 * Wires the scenario store + simulation registry into the routes, installs
 * the consistent `{ error: { code, message, issues? } }` error shape, and
 * registers an `onClose` hook that stops every EngineRuntime — so
 * `app.close()` (tests, graceful shutdown) leaves no running tick loops.
 *
 * P2a adds the multi-user layer: SQLite (users / environments / instances,
 * seeded from the bundled demo scenarios on first boot), JWT auth, the
 * `/api/environments*` + world-object routes, and the environment→scenario
 * bridge for `POST /api/simulations { environmentId }`.
 *
 * P3a adds the Home Assistant bridge: the shared HASService (`/api/hass/*`,
 * auth-required) and `hass://` scenario bindings resolved to HADevice
 * adapters through the registry (503 HASS_NOT_CONFIGURED when unconfigured).
 *
 * P3c adds production packaging: the built web console (`apps/web/dist`,
 * WEB_DIST) is served at `/` with an SPA fallback in the not-found handler,
 * so API + frontend run as one process.
 *
 * P4-4 adds platform hardening: in-process rate limiting (rate-limit.ts,
 * off when `rateLimitEnabled` is false), usage quotas threaded into the
 * create routes (quotas.ts), and the metrics collector behind /api/metrics +
 * /api/admin/observability (metrics.ts, routes/observability.ts).
 *
 * P-A (multi-user-simulation-design.md) adds the governance kernel: the
 * proposals + command_log tables, the rule-check/reviewer pipeline
 * (proposal-rules.ts, proposal-reviewer.ts, proposal-service.ts), and the
 * `/api/environments/:id/proposals`, `/api/proposals/:id/*`, command-log
 * routes (routes/proposals.ts). P-B adds the LLM semantic reviewer
 * (proposal-llm-reviewer.ts, selected via PROPOSAL_REVIEWER) and zone-claim
 * autonomy (zone_claims table, db/zone-claim-store.ts). P-C adds sandbox
 * forks (sandboxes table, sandbox-service.ts, routes/sandboxes.ts):
 * isolated in-memory worlds forked from an environment's base layer.
 * P-D adds twin sync (observations + sync_bindings tables, db/sync-store.ts,
 * twin-sync.ts, routes/twin-sync.ts): real-world perception data flows into
 * the base layer — hass: subscriptions and manual pushes become observations
 * that update device state (throttled) and broadcast over WorldSync.
 * P-E adds replay (replay-service.ts, routes/replays.ts): a wall-clock time
 * window of observations + command_log entries converts into a scenario
 * JSON v1.0 (environment snapshot + replay events), downloadable or saved
 * into the user scenario store.
 *
 * Fix-11 adds the service consumption chain (service-consumption-design.md
 * §3, Phase 1): service_agreements / usage_records / settlement_receipts
 * tables (migration v14), the agreement lifecycle + invoke routes
 * (routes/agreements.ts), and the SettlementProvider SPI (settlement.ts)
 * assembled via SETTLEMENT_PROVIDER (Null by default — no amounts).
 *
 * Wave-3a adds the batch-evaluation runner (roadmap Wave 3 "AI 训练场"):
 * the eval_runs table (migration v19), the serial in-process executor
 * (eval-run-service.ts) with per-run LLM model/prompt overrides, the
 * routes (routes/eval-runs.ts), and the eval-report disk fallback
 * (eval-report.ts) that keeps GET /api/simulations/:id/eval-report working
 * after a restart.
 *
 * Log governance slice: buildServer runs setupLogging (logging.ts) from the
 * resolved config — LOG_LEVEL drives the shared logger + pino, the known
 * per-tick simulation modules are suppressed to WARN by default (Tier 2,
 * lifted by LOG_LEVEL=debug, overridable via EAF_LOG_MODULE_LEVELS), and
 * LOG_FILE tees both pipelines into a rotating file (log-file.ts) while
 * keeping stdout.
 *
 * AUTH TRANSITION STATE: the new `/api/auth/*` and `/api/environments*`
 * routes require authentication (except public environment reads), while
 * the LEGACY `/api/scenarios*` reads and `/api/simulations*` routes stay
 * OPEN (optionalAuth only) so the current credential-less frontend keeps
 * working — with two exceptions: `POST /api/simulations/:id/commands`
 * mutates the world, so it requires authentication and env membership /
 * creator identity (Fix-1), and the legacy scenario WRITES
 * (POST/PUT/DELETE /api/scenarios) require authentication since Fix-6
 * (anonymous disk writes were an open hole; the deprecated read side stays
 * anonymous for the frontend list page). The rest of the split is
 * deliberate and temporary — legacy routes gain real auth in a later slice.
 *
 * The registry, stores, and database are exposed as decorators
 * (`app.simulations`, `app.scenarioStore`, `app.envStore`, `app.userStore`,
 * `app.db`) for tests and embedded use.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
// R32-C: response compression (dependency shipped with Lane C's ETag work
// but was never registered — the plugin landed in package.json only).
import fastifyCompress from '@fastify/compress';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LLMCache, LLMClient, setLLMMaxConcurrent } from '@active-collaboration/llm-integration';

// R1 (B1-9): the stale-simulation probe reuses the manual lane's exact
// frozen-vs-current assignment comparison.
import { isCapabilityExecutable } from '@active-collaboration/simulation';
import { resolveFlowAssignments, type TickTimer } from '@active-collaboration/core';
import {
  createVisionClientFromEnv,
  NLImportError,
  type NLImportChatClient,
  type VisionChatClient,
} from '@active-collaboration/core/scenario';

import { registerAuth } from './auth/index.js';
import { ApiKeyStore } from './db/api-key-store.js';
import { AgreementStreamSessions } from './agreement-stream-sessions.js';
import type { AgreementRoutesContext } from './agreements/index.js';
import { readSourceProbeTargetOf } from './agreements/targeting.js';
import { ChangePipeline } from './change-pipeline.js';
import { DEV_JWT_SECRET, loadConfig, type ServerConfig } from './config.js';
import { setupLogging } from './logging.js';
import { AcAgreementBridge } from './ac-agreement-bridge.js';
import { ServiceCatalogSync } from './sim-registry/service-catalog-sync.js';
import { OccupantScheduleSync } from './sim-registry/occupant-schedule-sync.js';
import { AgentEscalationBridge } from './agent-escalation-bridge.js';
import { FlowNotifyNodeExecutor } from './flow-notify-node-executor.js';
import { FlowServiceNodeExecutor } from './flow-service-node-executor.js';
import { SimEventTallies } from './sim-event-tally.js';
import { createNotificationWebhookDispatcher } from './notification-webhook.js';
import { AgreementStore } from './db/agreement-store.js';
import { sweepStaleProposedAgreements } from './agreement-stale.js';
import {
  sweepProviderFailover,
  type ProviderLivenessProbe,
} from './agreement-failover.js';
import { lazyFreshnessFloorSecForEnv } from './lazy-driver.js';
import { BlueprintStore } from './db/blueprint-store.js';
import { ReplayShareStore } from './db/replay-share-store.js';
import { EnvInviteStore } from './db/env-invite-store.js';
import { PlatformInviteStore } from './db/platform-invite-store.js';
import { seedCatalogModels } from './db/catalog-seed.js';
import { CatalogStore } from './db/catalog-store.js';
import { openDatabase, type EafDatabase } from './db/database.js';
import { EnvironmentStore } from './db/environment-store.js';
import { EvalRunStore } from './db/eval-run-store.js';
import { FlowStore } from './db/flow-store.js';
import { NotificationStore } from './db/notification-store.js';
import { CommandLogStore, ProposalStore } from './db/proposal-store.js';
import { AgentExperienceStore } from './db/experience-store.js';
import { ReputationStore } from './db/reputation-store.js';
import { SandboxStore } from './db/sandbox-store.js';
import { seedTemplates, SYSTEM_USER_EMAIL } from './db/seed.js';
import { ServiceStore } from './db/service-store.js';
import { StandingAskStore } from './db/standing-ask-store.js';
import { ObservationStore, SyncBindingStore } from './db/sync-store.js';
import { UserStore } from './db/user-store.js';
import { ZoneClaimStore } from './db/zone-claim-store.js';
import { EnvDelegationStore } from './db/env-delegation-store.js';
import { ApiError, errorBody } from './errors.js';
import { EvalRunService } from './eval-run-service.js';
import { HassSafetyGate } from './hass/safety-gate.js';
import { HASService } from './hass/service.js';
import { registerI18n } from './i18n/plugin.js';
import { DEFAULT_LOCALE, t } from './i18n/index.js';
import { notify, NOTIFICATION_KINDS } from './notifications.js';
import { MetricsCollector, metricsRouteClass, instrumentLLMClient, type LlmTokenUsage } from './metrics.js';
import { LLMReviewer } from './proposal-llm-reviewer.js';
import { EscalatingReviewer, type ProposalReviewer } from './proposal-reviewer.js';
import { ProposalService } from './proposal-service.js';
import { registerRateLimit } from './rate-limit.js';
import { ReplayService } from './replay-service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAgentNLRoutes } from './routes/agent-nl.js';
import { AgreementTriggerExecutor } from './agreement-trigger-executor.js';
import { registerAgreementRoutes } from './routes/agreements.js';
import { makeStaleFrameRecomputer, readSourceWritabilityOf } from './frame-evaluator.js';
import { LlmLivenessProbe, resolveDecisionMode } from './llm-liveness.js';
import { CapabilityDemandStore } from './db/capability-demand-store.js';
import { WorldSessionService } from './world-session.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerDocsRoutes, sendDocsPage, sendOpenApiJson, sendOpenApiYaml } from './routes/docs.js';
import { registerEnvObjectRoutes } from './routes/env-objects.js';
import { registerEnvironmentRoutes } from './routes/environments.js';
import { registerOccupantScheduleRoutes } from './routes/occupant-schedule.js';
import { registerEvalRunRoutes } from './routes/eval-runs.js';
import { registerFlowRoutes } from './routes/flows.js';
import { registerBlueprintRoutes } from './routes/blueprints.js';
import { registerHassRoutes } from './routes/hass.js';
import { registerMeRoutes } from './routes/me.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerExternalInvokeRoutes } from './routes/external-invoke.js';
import { registerEventSourceRoutes } from './routes/event-sources.js';
import { ExternalEventSourceStore } from './external-events/source-store.js';
import { startPoller } from './external-events/poller.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerQuestRoutes } from './routes/quests.js';
import { registerReplayRoutes } from './routes/replays.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerSandboxRoutes } from './routes/sandboxes.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerScenarioTemplateRoutes } from './routes/scenario-templates.js';
import { registerDeviceTemplateRoutes } from './routes/device-templates.js';
import { registerEnvironmentImportRoutes } from './routes/environment-imports.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerSimulationRoutes } from './routes/simulations.js';
import { registerTwinSyncRoutes } from './routes/twin-sync.js';
import { SandboxService, worldSessionSimIdOf } from './sandbox-service.js';
import { worldSessionCheckpointPath } from './world-checkpoint.js';
import { ScenarioStore } from './scenario-store.js';
import { NullSettlementProvider, type SettlementProvider } from './settlement.js';
import { cleanupOldTrajectories, SimulationRegistry } from './simulation-registry.js';
import type { SimulationRecord } from './simulation-registry.js';
import { sweepTrajectoryBaseDir } from './sim-registry/timeline-compactor.js';
import { environmentToScenario } from './environment-bridge.js';
import { registerStaticWeb, frontendNotBuiltNote } from './static-web.js';
import { TwinSyncService } from './twin-sync.js';
import { HassReverseSyncService } from './hass/reverse-sync.js';
import { HassShadowService } from './hass/shadow-service.js';
import { WorldSync } from './world-sync.js';

declare module 'fastify' {
  interface FastifyInstance {
    scenarioStore: ScenarioStore;
    simulations: SimulationRegistry;
    db: EafDatabase;
    userStore: UserStore;
    envStore: EnvironmentStore;
    serviceStore: ServiceStore;
    reputationStore: ReputationStore;
    /** R6-E-F15: private-experience persistence (learned meta-cognition). */
    experienceStore: AgentExperienceStore;
    catalogStore: CatalogStore;
    worldSync: WorldSync;
    /** P-A governance kernel: proposal state machine + command log. */
    proposalStore: ProposalStore;
    commandLogStore: CommandLogStore;
    proposalService: ProposalService;
    /** P-B §5.3: zone stewardship grants (zone-claim autonomy). */
    zoneClaimStore: ZoneClaimStore;
    /** T-072 (D-1 decide half): zone-claim decision delegations, per env. */
    delegationStore: EnvDelegationStore;
    /** P-C: sandbox forks (Layer-0 isolated worlds). */
    sandboxStore: SandboxStore;
    sandboxService: SandboxService;
    /** Wave-3a: batch evaluation jobs. */
    evalRunStore: EvalRunStore;
    evalRunService: EvalRunService;
    /** P-D: twin sync (real-world perception → base layer). */
    observationStore: ObservationStore;
    syncBindingStore: SyncBindingStore;
    twinSync: TwinSyncService;
    /** P-E: time-window → scenario replay conversion. */
    replayService: ReplayService;
    /** Fix-11: service consumption — agreements, usage records, receipts. */
    agreementStore: AgreementStore;
    /** T-069 (R23): standing asks (需求板) on future counterpart assets. */
    standingAskStore: StandingAskStore;
    /** Living-worlds P1W: per-env authoritative world sessions. */
    worldSessions: WorldSessionService;
    /** User-orchestrated business flows (core flows module, migration v21). */
    flowStore: FlowStore;
    /** Fix-16: the persistent notification inbox (门铃). */
    notificationStore: NotificationStore;
    /** Fix-11 §3.4: settlement SPI (NullSettlementProvider by default). */
    settlement: SettlementProvider;
    hass: HASService;
    hassGate: HassSafetyGate;
    /** HIL P1: reality → base-layer snapshot alignment (hass:// devices). */
    hassReverseSync: HassReverseSyncService;
    /** HIL P2: observation-driven shadow forks (hass:// environments). */
    hassShadow: HassShadowService;
    /** P4-4 observability counters (also feeding /api/metrics). */
    metrics: MetricsCollector;
    /**
     * S4: present only when built with config.deferBootSeeds (the production
     * entrypoint) — runs the idempotent boot seeds; index.ts invokes it
     * after a successful listen so EADDRINUSE fails before any seed write.
     */
    runBootSeeds?: () => void;
  }
}

export interface BuildServerOptions extends Partial<ServerConfig> {
  /**
   * Fastify logger option; `false` silences logs (tests). Default: derived
   * from config — LOG_LEVEL for the pino level, plus a tee stream into
   * LOG_FILE when that is set (see logging.ts).
   */
  logger?: boolean | Record<string, unknown>;
  /**
   * Living-worlds P1W: the idle grace before a hibernate evaluation may run.
   * (The world-session rate knob lives on ServerConfig since T-073 —
   * EAF_WORLD_SESSION_SIM_PER_WALL_SEC — and flows here through Partial<
   * ServerConfig>.)
   */
  worldSessionIdleGraceMs?: number;
  /**
   * T118 clock-injection seam (pure test observability): replaces the tick
   * loop's WALL timer on every simulation runtime this server builds —
   * wall time then advances a running world only when the test explicitly
   * fires the timer. UNSET in every production path: runtimes schedule ticks
   * on the process timers exactly as before the seam existed (additive,
   * default behavior bit-identical). This is the user-sim layer's clock (the
   * world-session layer already has `WorldSessionDeps.nowMs`); the
   * world-hibernate suite injects here because its sims are ordinary
   * POST /api/simulations records whose resumed runtime briefly runs on the
   * wall timer between /resume and /pause.
   */
  simulationTickTimer?: TickTimer;
  /**
   * T118 clock-anchor discipline (pure test determinism): pins every
   * runtime's WALL anchor (checkpoint `simStartEpochMs`) so separately
   * constructed runtimes share one anchor and compare bit-wise — sim-time
   * stamps (a sensor's lastReadingAt) stop depending on the construction
   * gap. UNSET in production: runtimes anchor at their construction moment
   * exactly as before the seam existed.
   */
  simulationSimStartEpochMs?: number;
  /**
   * T128 (R20-u2 F1): the invoke lane's honest wait floor (ms) — how long
   * POST /api/agreements/:id/invocations holds the HTTP connection before
   * answering 503 INVOKE_DECISION_PENDING while the execution finishes in
   * the background. UNSET in production: the route applies its 90_000 ms
   * default (under the public gateway's 100s kill). Tests inject a small
   * value to exercise the 503 shape without waiting 90s.
   */
  invokeDecisionWaitMs?: number;
  /**
   * T129 (R21-F1): the world-session layer's clock (WorldSessionDeps.nowMs)
   * — pure test seam, the same discipline as simulationTickTimer above.
   * The world session's catch-up target is `((now − anchorMs)/1000) × rate`;
   * shifting this clock forward is how a harness constructs the
   * "world hours behind wall" state (a giant catch-up) deterministically.
   * UNSET in production: the service reads Date.now exactly as before.
   */
  worldSessionNowMs?: () => number;
  /**
   * T129 (R21-F1): the world-session catch-up sync-wait cap (ms) — how long
   * ensureCaughtUp waits on the catch-up before the advance finishes on the
   * background chain. UNSET in production: the 10_000 ms default. Test seam:
   * suites inject a small value to exercise the detach quickly.
   */
  worldSessionCatchUpSyncWaitMs?: number;
  /**
   * T129 (R21-F1): the consumption lanes' honest targeting wait floor (ms) —
   * threaded into AgreementRoutesContext.consumptionTargetWaitMs (read lane
   * + stream upgrade). UNSET in production: the 90_000 ms default (under the
   * gateway's ~100s kill).
   */
  consumptionTargetWaitMs?: number;
  /**
   * UX wave-3 (import lanes): the floorplan lane's vision chat client — a
   * client or a factory; a throwing factory means "no vision backend
   * configured" (503 FLOORPLAN_VISION_UNAVAILABLE). UNSET in production:
   * the route builds one from EAF_VISION_* env vars (falling back to the
   * main LLM_BASE_URL). Pure test seam — suites never call a real LLM.
   */
  floorplanVisionClient?: VisionChatClient | (() => VisionChatClient);
  /**
   * UX wave-5 (NL import lane): the NL lane's text chat client — a client or
   * a factory; a throwing factory means "no LLM backend configured" (503
   * NL_IMPORT_UNAVAILABLE). UNSET in production: the route builds one from
   * the NL function route (LLM_NL_MODEL) or the main LLM_BASE_URL+LLM_MODEL
   * deployment. Pure test seam — suites never call a real LLM.
   */
  nlImportClient?: NLImportChatClient | (() => NLImportChatClient);
  /**
   * UX wave-3 (import lanes): Overpass fetch seam for POST
   * /api/environments/import-osm. UNSET in production (global fetch); tests
   * inject a stub — the suite must never hit the real Overpass API.
   */
  overpassFetch?: typeof fetch;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const { logger, ...configOverrides } = options;
  const config: ServerConfig = { ...loadConfig(), ...dropUndefined(configOverrides) };
  // S3 (Task 1): an explicit jwtSecret override (test harnesses inject
  // secrets) must carry its own provenance — the env-derived
  // jwtSecretIsDefault flag would otherwise contradict the merged value and
  // the boot log would misreport which key is in use.
  if (options.jwtSecret !== undefined && options.jwtSecretIsDefault === undefined) {
    config.jwtSecretIsDefault = options.jwtSecret === DEV_JWT_SECRET;
  }

  // Three-tier logging setup (logging.ts): LOG_LEVEL drives the shared
  // logger + pino, known per-tick modules are suppressed to WARN by default,
  // and LOG_FILE tees everything into a rotating file alongside stdout.
  const logging = setupLogging(config);

  const app = Fastify({
    logger:
      logger === false ? false : typeof logger === 'object' && logger !== null ? logger : logging.fastifyLogger,
    // T-111: Fastify's 1MiB default rejected real replay-window scenario
    // imports with a raw framework error — raise it and map the rejection
    // into the platform envelope (error handler below).
    bodyLimit: config.maxBodyBytes,
  });

  await app.register(fastifyWebsocket);

  // F6: a client that unconditionally sends Content-Type: application/json
  // with an EMPTY body (typical for DELETE) used to 400 with a raw
  // FST_ERR_CTP_EMPTY_JSON_BODY on every route outside the T-409 tolerant
  // scopes (services/agreements/simulations). Register the same tolerant
  // parser at the ROOT so all routes inherit it — Fastify refuses a
  // same-name parser in a child scope once the root has one, so the three
  // former scoped registrations are removed. Routes that REQUIRE a body
  // keep their field validation (empty body → their teaching 400, not a
  // framework error).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, tolerantJsonParser);

  // R32-C (production readiness): gzip/brotli for JSON bodies over ~1KB —
  // snapshots and timeline payloads are the big lanes (the web already
  // consumes them via WS deltas when live; REST consumers get the bytes cut).
  await app.register(fastifyCompress, { global: true, threshold: 1024 });

  // R32-C: security headers (helmet-equivalent, no extra dependency) + the
  // opt-in CORS allow-list. Applied to EVERY response incl. static assets.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-DNS-Prefetch-Control', 'off');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.contentSecurityPolicy) {
      // Console-compatible: same-origin scripts/styles (Vite bundle),
      // inline styles (chart libraries), data: images, same-origin + ws
      // connections (the live world streams).
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; " +
          "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; " +
          "base-uri 'self'; frame-ancestors 'none'",
      );
    }
    if (config.hsts) {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  });

  if (config.corsOrigins.length > 0) {
    // R32-C: explicit-origin CORS for cross-origin API consumers (the same-
    // origin console needs none of this). Credentials allowed so the JWT
    // header works cross-origin; preflight answered at the hook.
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !config.corsOrigins.includes(origin)) return;
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-eaf-instance-token');
        reply.header('Access-Control-Max-Age', '600');
        return reply.code(204).send();
      }
    });
  }

  // S3 (Task 1): the boot log ALWAYS states which JWT key is in use — a
  // deployment silently running on the built-in development default must be
  // visible in the first log lines (strict mode refuses that boot outright;
  // this line covers every non-strict boot, including unlabelled production
  // ones). Never log the secret itself — only its provenance.
  if (config.jwtSecretIsDefault) {
    app.log.warn(
      'JWT auth key: the BUILT-IN DEVELOPMENT default is in use (JWT_SECRET not set) — ' +
        'anyone who reads the public source tree can forge auth tokens. Set JWT_SECRET ' +
        '(32+ random bytes, e.g. `openssl rand -hex 32`) and restart; strict mode ' +
        '(NODE_ENV=production / EAF_STRICT_ENV=1) refuses to boot in this state.',
    );
  } else {
    app.log.info('JWT auth key: operator-provided JWT_SECRET is in use');
  }

  // P4-4: process-wide observability counters (HTTP counts hook + error ring
  // below; WS gauges in the stream handlers; LLM tokens via the registry).
  const metrics = new MetricsCollector();

  // R15-C1: apply the validated concurrency limit to the live global LLM
  // queue (the module-load env read is only the pre-config default).
  setLLMMaxConcurrent(config.llmMaxConcurrent);

  // Persistence: SQLite (WAL) + first-boot seed of the demo environments.
  const db = openDatabase(config.databasePath);
  const userStore = new UserStore(db);
  const apiKeyStore = new ApiKeyStore(db);
  const eventSourceStore = new ExternalEventSourceStore(db);
  const envStore = new EnvironmentStore(db);
  // R100: the agreement store constructs before the service store so the
  // service-row delete choke point can retire + unlink agreements first.
  const agreementStore = new AgreementStore(db);
  const serviceStore = new ServiceStore(db, envStore, agreementStore);
  const reputationStore = new ReputationStore(db);
  // R102 (trust-ledger-consistency): one ledger — reconcile reputation rows
  // from the metered usage at boot (self-healing, MAX-merge idempotent).
  // Heals the pre-R101 scoring gap (metered but never scored, e.g. zhao-20's
  // 6-failure broadcast service) so no service keeps "attempts 0" with a
  // non-empty usage summary. Never blocks boot.
  try {
    const reconciled = reputationStore.reconcileFromMeteredUsage();
    if (reconciled > 0) {
      console.warn(`reputation: reconciled ${reconciled} (agent, capability) cells from metered usage (R102)`);
    }
  } catch (error) {
    console.warn('reputation usage-reconcile failed (non-fatal):', error);
  }
  // R6-E-F15: private-experience persistence (learned meta-cognition, v61).
  const experienceStore = new AgentExperienceStore(db);
  // User-orchestrated business flows (migration v21).
  const flowStore = new FlowStore(db);
  // Fix-38: App Blueprints — one-click application templates (migration v23).
  const blueprintStore = new BlueprintStore(db);
  const replayShareStore = new ReplayShareStore(db);
  // R15-D10: pending invites for not-yet-registered emails.
  const envInviteStore = new EnvInviteStore(db);
  // Alpha capacity gating (schema v57): platform registration invites. When
  // the gate is ON but NO usable invite exists, boot mints one for the first
  // ADMIN_EMAILS entry and logs the plaintext code — an invite-only server
  // with zero codes is an operator deadlock (nobody can register the first
  // account), so the seed is the critical line of defense. The code lands in
  // the startup log once; admins mint further codes via /api/admin/invites.
  const platformInviteStore = new PlatformInviteStore(db);
  if (config.inviteOnly && !platformInviteStore.hasUsableInvite()) {
    const seedOwner = config.adminEmails[0] ?? 'system-bootstrap';
    const seeded = platformInviteStore.create({ maxUses: 1, createdBy: seedOwner });
    app.log.warn(
      `invite-only registration is ON (EAF_INVITE_ONLY) and no usable invite existed — ` +
        `bootstrap invite minted for ${seedOwner}: ${seeded.code} ` +
        `(single use; mint more via POST /api/admin/invites or \`eaf admin invites create\`)`,
    );
    if (config.adminEmails.length === 0) {
      app.log.warn(
        'invite-only registration is ON but ADMIN_EMAILS is empty — the bootstrap invite works, ' +
          'but nobody can mint further codes until ADMIN_EMAILS is configured',
      );
    }
  }
  // Fix-16: the persistent notification inbox (门铃).
  const notificationStore = new NotificationStore(db);
  // Wave-4b: outbound webhooks — every persisted notification is also POSTed
  // to the recipient's configured webhook (fire-and-forget, one retry).
  notificationStore.onCreated = createNotificationWebhookDispatcher({
    userStore,
    warn: message => app.log.warn(message),
  });
  const standingAskStore = new StandingAskStore(db);
  // Real-hardware device catalog (§11.3): the curated models are seeded by
  // runBootSeeds below.
  const catalogStore = new CatalogStore(db);

  // S4 (boot ordering): the blueprint/template/catalog seed WRITES are
  // bundled here so the production entrypoint (index.ts, via
  // config.deferBootSeeds) can run them only AFTER a successful listen — an
  // EADDRINUSE boot then fails fast without touching the database. All
  // three seeds are idempotent per boot:
  // - blueprintStore.seedBuiltins() (Fix-38 app blueprints, migration v23);
  // - seedTemplates — the public template gallery (all tiers, unified):
  //   idempotent per-template ensure on EVERY boot — existing databases pick
  //   up new templates, and a stale system-owned revision is upgraded in
  //   place (db/seed.ts). The flowStore wiring persists scenario-embedded
  //   flows (Fix-44a four-channel promise: bundled templates exercise the
  //   deterministic-flow surface too);
  // - seedCatalogModels — the curated real-hardware device models.
  // Tests (build + inject, never listen) keep the immediate default, so
  // their seed semantics are unchanged.
  const runBootSeeds = (): void => {
    blueprintStore.seedBuiltins();
    seedTemplates(userStore, envStore, config.seedDir, app.log, serviceStore, flowStore);
    seedCatalogModels(catalogStore, userStore.findByEmail(SYSTEM_USER_EMAIL)?.id ?? null, app.log);
  };
  if (config.deferBootSeeds === true) {
    app.decorate('runBootSeeds', runBootSeeds);
  } else {
    runBootSeeds();
  }

  const store = new ScenarioStore(config.seedDir, config.userDir, app.log);
  // Home Assistant bridge (P3a): one shared service; the connection opens
  // lazily on first use and only when HASS_URL/HASS_TOKEN are both set.
  // P3b: every actuation the bridge performs passes through the safety gate
  // (policies / pending confirmations / rate limits / E-stop / audit).
  const hassGate = new HassSafetyGate(db, {
    defaultPolicy: config.hassDefaultPolicy,
    rateLimitPerMin: config.hassRateLimitPerMin,
  });
  const hass = new HASService({
    ...(config.hassUrl !== undefined ? { url: config.hassUrl } : {}),
    ...(config.hassToken !== undefined ? { token: config.hassToken } : {}),
    gate: hassGate,
  });
  // Fix-11 Phase 2 (§3.1 implicit path): AC handshakes land ephemeral
  // agreements — the bridge subscribes each env-backed runtime's event bus.
  const agreementBridge = config.acEphemeralAgreements
    ? new AcAgreementBridge({ envStore, serviceStore, agreementStore, notificationStore })
    : undefined;
  // P2: the world service catalog push-sync — every env-backed runtime's
  // EnvironmentCenter mirrors the env's published/flow/aggregate services
  // (attach-time snapshot + live rebuild on catalog writes), so the LLM
  // discovery paths see the world-layer catalog unchanged.
  const serviceCatalogSync = new ServiceCatalogSync({ serviceStore });
  // FEAT-07: env-level occupantSchedule PATCH push-sync — every env-backed
  // runtime registers itself (world session + private env-backed sims, same
  // coverage as the catalog sync) so schedule PATCHes land live.
  const occupantScheduleSync = new OccupantScheduleSync();
  // R14 Wave-A (design-data-services.md §3.1): per-sim injected-event tally
  // — the countSince window data service computations evaluate against.
  const simEventTallies = new SimEventTallies();
  // Fix-1 (§4.1 unified change pipeline): the shared tail of every world
  // mutation — command_log append + actor-carrying WorldSync broadcast.
  // Fix-44h: declared BEFORE the registry so engine-issued device commands
  // can be audited from simulation creation.
  const worldSync = new WorldSync();
  const commandLogStore = new CommandLogStore(db);
  // Living-worlds P1W: the env-owned authoritative world sessions — created
  // AFTER the pipeline is known (the change pipeline's world-mutation hook
  // wakes them) but the pipeline itself is constructed with a late-bound
  // wake (the service does not exist yet at pipeline construction time).
  let worldSessions: WorldSessionService | undefined;
  const changePipeline = new ChangePipeline({
    commandLogStore,
    worldSync,
    userStore,
    // T-037 semantics: world-mutating governance lands in the authoritative
    // world (proposal applies may CREATE the session; direct edits refresh
    // an existing one). Fire-and-forget — the audit tail never waits.
    // R37-F1: the rejection is LOGGED, never silently swallowed — the
    // validation's "rebuild silently failed or was bypassed" left no trace.
    onWorldMutation: (envId, options) => {
      void worldSessions?.onWorldMutation(envId, options).catch(error => {
        app.log.warn(
          `world mutation landing for env ${envId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  });
  // T-069 (R23): the standing-ask 需求板 matcher deps — assembled once,
  // shared by all three service-'created' seams (explicit publish in
  // routes/services.ts, owner direct edits, governed applies through
  // publishServiceChanges). Swallowed matcher errors surface as warn logs;
  // the publish lane itself must never fail.
  const standingAskMatcher = {
    envStore,
    serviceStore,
    standingAskStore,
    userStore,
    agreementStore,
    notificationStore,
    pipeline: changePipeline,
    flowStore,
    onMatchError: (error: unknown) =>
      app.log.warn(`standing-ask matching failed (publish unaffected): ${String(error)}`),
  };
  // R74: probe the configured LLM backend in the background (30s cadence,
  // immediate first probe) — the /api/health decision posture reads this.
  const llmLiveness =
    config.llmBaseUrl !== undefined
      ? new LlmLivenessProbe({
          baseURL: config.llmBaseUrl,
          ...(config.llmApiKey !== undefined ? { apiKey: config.llmApiKey } : {}),
          // F4-4: fault-injection harnesses shorten the cadence/threshold via
          // LLM_LIVENESS_INTERVAL_MS / LLM_LIVENESS_FAILURE_THRESHOLD so a
          // backend kill/recover flips the posture within seconds.
          ...(config.llmLivenessIntervalMs !== undefined ? { intervalMs: config.llmLivenessIntervalMs } : {}),
          ...(config.llmLivenessFailureThreshold !== undefined
            ? { failureThreshold: config.llmLivenessFailureThreshold }
            : {}),
        })
      : undefined;
  llmLiveness?.start();
  app.addHook('onClose', async () => {
    llmLiveness?.stop();
  });

  // R80-FW3: capability-demand telemetry — one store, two consumers (the
  // POST sink on /me routes, the top-N on admin observability).
  const capabilityDemandStore = new CapabilityDemandStore(db);
  const registry = new SimulationRegistry(
    {
      ...(config.llmTriageModel !== undefined ? { llmTriageModel: config.llmTriageModel } : {}),
      ...(config.llmCachePath !== undefined ? { llmCachePath: config.llmCachePath } : {}),
      // R15-C2: backend selection + the openai-compatible triple.
      llmProvider: config.llmProvider,
      ...(config.llmBaseUrl !== undefined ? { llmBaseUrl: config.llmBaseUrl } : {}),
      ...(config.llmApiKey !== undefined ? { llmApiKey: config.llmApiKey } : {}),
      ...(config.llmModel !== undefined ? { llmModel: config.llmModel } : {}),
      ...(config.llmTimeoutMs !== undefined ? { llmTimeoutMs: config.llmTimeoutMs } : {}),
      // Per-function model routing (LLM_DECISION_MODEL / LLM_EVAL_MODEL /
      // LLM_NL_MODEL) — parsed + validated by loadConfig.
      ...(config.llmRoutes !== undefined ? { llmRoutes: config.llmRoutes } : {}),
      // T-022: bounded degradation policy for LLM-backed decisions.
      llmDecisionFailure: {
        retryAttempts: config.llmDecisionRetries,
        retryBackoffMs: config.llmDecisionRetryBackoffMs,
        policy: config.llmDecisionFailurePolicy,
      },
    },
    config.trajectoryDir,
    hass,
    reputationStore,
    // P4-4: LLM token usage of every client the registry builds flows into
    // the metrics collector (chat() instrumentation, see metrics.ts).
    usage => metrics.recordLlmTokens(usage),
    // R15-A3: the same wrap also feeds chat latency (queue wait included).
    (durationMs, success) => metrics.recordLlmChat(durationMs, success),
    agreementBridge,
    config.zoneSampleEverySimSec,
    // User-orchestrated flows: env-backed sims get a live flowsProvider +
    // the flow_runs ledger (see SimulationRegistry).
    flowStore,
    // Fix-44h: engine-issued device commands land in command_log.
    changePipeline,
    // T-011: per-file cap threaded into every sim-timeline append.
    config.simTimelineMaxBytes,
    // R14 Wave-A: per-sim injected-event tally (countSince window for
    // ComputationSpec evaluation).
    simEventTallies,
    // (agreementTrigger is wired post-construction via setAgreementTrigger.)
    undefined,
    // Living-worlds P1 (design §8.5): terms.read freshness floors for lazy
    // sims — the TIGHTEST active data-read agreement's minFreshnessSec per
    // env. The lazy driver registers it as an external due (wall-mapped), so
    // a lazy sim with an active data-read agreement never freezes past the
    // freshness contract. Agreements without terms.read carry no floor.
    { floorSecForEnv: lazyFreshnessFloorSecForEnv(agreementStore) },
    // Living-worlds P2: per-segment cap of the decision trajectory
    // segmented log (EAF_TRAJECTORY_SEGMENT_BYTES, default 50MB).
    config.trajectorySegmentBytes,
    // Living-worlds P2: raw rollup window (EAF_ROLLUP_WINDOW_DAYS, default
    // 7 days; 0 disables) — threads into the sim-timeline on-rotation hook.
    config.rollupWindowDays * 24 * 60 * 60 * 1000,
    // R42-A/F3 §7.1: the env service catalog wires each agent's
    // `listMyServices` seam (AC responder prompt "YOUR SERVICES").
    serviceStore,
    // P2: world service catalog push-sync into env-backed runtimes.
    serviceCatalogSync,
    // R6-E-F15: private-experience persistence (learned meta-cognition).
    experienceStore,
    // FEAT-07: env-level occupantSchedule PATCH push-sync (constructed above
    // with the other push-sync seams; also handed to the route below).
    occupantScheduleSync,
  );
  // R1 (B1-9 / P-19): auto-triggered flow runs on a STALE simulation now say
  // so — the probe answers "does the failed flow resolve against the env's
  // CURRENT bridged scenario?" per call (same frozen-vs-current comparison
  // the manual run lane's 409 FLOW_STALE_SIMULATION performs).
  registry.setFlowStaleProbeForEnv(environmentId => {
    return flow => {
      const env = envStore.getEnvironment(environmentId);
      if (env === undefined) return false;
      try {
        const current = environmentToScenario(env, envStore.devicesOf(environmentId), envStore.agentsOf(environmentId));
        return resolveFlowAssignments(flow, current, {
          isExecutableCapability: isCapabilityExecutable,
        }).issues.every(issue => issue.level !== 'error');
      } catch {
        return false;
      }
    };
  });
  // T1 (R2, u3-F1): flow runs carry the capability-drift annotation — the
  // probe reads each agent's CURRENT declared capabilities from the env store
  // per run, so revoking a declaration (agent PATCH) annotates the next run
  // of every live simulation (the frozen scenario alone would keep asserting
  // the stale grant). Unknown agent → undefined = honestly no annotation.
  registry.setDeclaredCapabilitiesForEnv(environmentId => agentId => {
    const row = envStore.agentsOf(environmentId).find(agent => agent.id === agentId);
    if (row === undefined) return undefined;
    try {
      const parsed = JSON.parse(row.capabilities_json) as unknown;
      return Array.isArray(parsed) && parsed.every(c => typeof c === 'string') ? parsed : [];
    } catch {
      return [];
    }
  });
  // T118 clock-injection seam (test observability only): when a harness
  // supplies simulationTickTimer, every runtime this server builds schedules
  // its tick loop through it instead of the process wall timers. Unset in
  // production — the registry's default (setTimeout/clearTimeout) is
  // bit-identical to the pre-seam behavior.
  if (options.simulationTickTimer !== undefined) {
    registry.setTickTimer(options.simulationTickTimer);
  }
  // T118 clock-anchor discipline (test determinism only): a supplied
  // simulationSimStartEpochMs pins every runtime's wall anchor so separately
  // constructed runtimes share it (bit-wise two-arm comparisons). Unset in
  // production — anchor at the construction moment, as before.
  if (options.simulationSimStartEpochMs !== undefined) {
    registry.pinSimStartEpochMs(options.simulationSimStartEpochMs);
  }
  // Living-worlds P1W (design-living-worlds.md §4.3): the authoritative
  // world session service — one env-owned living instance per environment,
  // created on demand (data reads/streams with no explicit simulationId,
  // freshness-obligating agreement activations, world-changing proposal
  // applies), WALL-anchored at wall-rate (1 sim-sec per wall-sec baseline;
  // the reserved speed knob), due-driven between arrivals, hibernating when
  // unobserved and obligation-free, fast-forwarding on the next arrival.
  worldSessions = new WorldSessionService({
    registry,
    // "sim owns dynamics, env owns topology" (§9): every (re)build and every
    // wake bridges the env's CURRENT rows.
    scenarioOfEnv: envId => {
      const env = envStore.getEnvironment(envId);
      if (env === undefined) {
        throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${envId}" not found`);
      }
      return environmentToScenario(env, envStore.devicesOf(envId), envStore.agentsOf(envId));
    },
    envOwnerIdOf: envId => envStore.getEnvironment(envId)?.owner_id,
    // Obligation worlds never hibernate (§5): real-device surfaces and
    // active actuation-obligation agreements (terms.trigger + terms.action —
    // the T-035 auto-execution contract).
    obligationsOf: envId => ({
      hassBound: envStore.devicesOf(envId).some(
        device => device.binding !== null && device.binding.startsWith('hass://'),
      ),
      actuationAgreement: agreementStore.agreementsOfEnv(envId).some(row => {
        if (row.status !== 'active') return false;
        try {
          const terms = JSON.parse(row.terms_json) as { trigger?: unknown; action?: unknown };
          return terms.trigger !== undefined && terms.action !== undefined;
        } catch {
          return false;
        }
      }),
    }),
    freshnessFloorSecForEnv: lazyFreshnessFloorSecForEnv(agreementStore),
    // §8.5's platform half: after every session advance, cached frames the
    // minFreshnessSec deadline is about to violate are recomputed against
    // the session (evaluateDataFrameNow — the SAME evaluation reads use).
    recomputeStaleFrames: makeStaleFrameRecomputer({
      envStore,
      serviceStore,
      agreementStore,
      simEventTallies,
    }),
    onStatusChange: (envId, view) => worldSync.publishWorldSession(envId, view),
    // S3 (Task 3): lazy rebind — an arrival for an env with no in-memory
    // session checks for a checkpoint a previous process hibernated before
    // materializing a fresh world (see the boot scan below for the eager
    // half of the recovery).
    findHibernatedCheckpoint: envId => {
      const path = worldSessionCheckpointPath(config.trajectoryDir, envId);
      return existsSync(path) ? path : undefined;
    },
    ...(options.worldSessionSimPerWallSec !== undefined
      ? { simPerWallSec: options.worldSessionSimPerWallSec }
      : {}),
    // T129 (R21-F1) test seam: injectable clock for the catch-up target
    // arithmetic (see BuildServerOptions.worldSessionNowMs). Absent in
    // production — Date.now, byte-identical to the pre-seam behavior.
    ...(options.worldSessionNowMs !== undefined ? { nowMs: options.worldSessionNowMs } : {}),
    // T129 (R21-F1): the catch-up sync-wait cap (ensureCaughtUp stops
    // waiting after it; the advance finishes on the background chain).
    // Absent in production — the 10_000 ms default.
    ...(options.worldSessionCatchUpSyncWaitMs !== undefined
      ? { catchUpSyncWaitMs: options.worldSessionCatchUpSyncWaitMs }
      : {}),
    // 分层追平（粗精度快进）旋钮 — EAF_WORLD_SESSION_CATCHUP_* 经
    // ServerConfig 流入；缺省在 world-session.ts。
    ...(options.worldSessionCatchUpCoarseMinGapSimSec !== undefined
      ? { catchUpCoarseMinGapSimSec: options.worldSessionCatchUpCoarseMinGapSimSec }
      : {}),
    ...(options.worldSessionCatchUpPreciseTailSimSec !== undefined
      ? { catchUpPreciseTailSimSec: options.worldSessionCatchUpPreciseTailSimSec }
      : {}),
    ...(options.worldSessionCatchUpCoarseStrideSimSec !== undefined
      ? { catchUpCoarseStrideSimSec: options.worldSessionCatchUpCoarseStrideSimSec }
      : {}),
    ...(options.worldSessionCatchUpCoarseSubstepSimSec !== undefined
      ? { catchUpCoarseSubstepSimSec: options.worldSessionCatchUpCoarseSubstepSimSec }
      : {}),
    // R73: "永远运行下去" — the user's directive. World sessions must never
    // hibernate; a world that stops is a world that betrays its builders.
    // The idleGraceMs → Infinity (via Number.MAX_SAFE_INTEGER) ensures the
    // hibernate sweep never fires.
    idleGraceMs: Number.MAX_SAFE_INTEGER,
  });
  // Wave-6 (Fix-11/15 遗留): agreement stream sessions are tracked per
  // hosting simulation; when a simulation stops, its sessions get a close
  // frame so the stream is metered immediately instead of ping/ponging on
  // forever until the client disconnects.
  const agreementStreamSessions = new AgreementStreamSessions();
  registry.onSimulationStopped(record => {
    // P1W polish: the authoritative session's hosted streams close with a
    // teaching reason — the world continues (fast-forward on reconnect),
    // it did not "stop" in the terminal sense.
    agreementStreamSessions.closeForSimulation(
      record.id,
      undefined,
      record.envSession === true
        ? { reason: 'world session hibernated/reloaded — reconnect fast-forwards to now' }
        : {},
    );
  });
  // R14 Wave-A: a stopped sim's event tally is dropped with it (the cached
  // frame is the honest fallback — §7).
  registry.onSimulationStopped(record => simEventTallies.detach(record.id));
  // P4-4: usage quotas, threaded into the create routes.
  const quotas = {
    maxEnvsPerUser: config.quotaMaxEnvsPerUser,
    maxDevicesPerEnv: config.quotaMaxDevicesPerEnv,
    maxAgentsPerEnv: config.quotaMaxAgentsPerEnv,
    maxZonesPerEnv: config.quotaMaxZonesPerEnv,
    maxRunningSimsPerUser: config.quotaMaxRunningSimsPerUser,
    maxSandboxesPerUserPerEnv: config.quotaMaxSandboxesPerUserPerEnv,
  };
  // P-A governance kernel (multi-user-simulation-design.md §4): proposals +
  // command log stores, and the pipeline service (rule check → reviewer →
  // apply/revert). P-B adds the zone-claim store (§5.3 autonomy) and the
  // reviewer selection: the LLM semantic reviewer when configured, the P-A
  // escalate-everything reviewer otherwise.
  const proposalStore = new ProposalStore(db);
  // commandLogStore + changePipeline moved BEFORE the registry (Fix-44h);
  // the declarations above are the single instances.
  const zoneClaimStore = new ZoneClaimStore(db);
  // T-072 (D-1 decide half): env decision delegations (v1 scope:
  // 'zone-claims') — the owner may hand the decide right for zone-claim
  // proposals to one member at a time, per env.
  const delegationStore = new EnvDelegationStore(db);
  // P-C sandbox forks (§3 Layer 0) + Wave-3a eval runs: constructed BEFORE
  // the proposal service — P2F §11 wires them into the adopt-config rule
  // check (sourceFork lineage + evidence verification).
  const sandboxStore = new SandboxStore(db);
  const evalRunStore = new EvalRunStore(db);
  evalRunStore.failInterrupted();
  // T-024 (ED-F11): the reviewer's LLM client joins the shared response
  // cache + the metrics sinks (review token/latency now accounted).
  const reviewer = selectProposalReviewer(config, envStore, app.log, {
    cache: registry.getLlmCache(),
    onUsage: usage => metrics.recordLlmTokens(usage),
    onLatency: (durationMs, success) => metrics.recordLlmChat(durationMs, success),
  });
  const proposalService = new ProposalService({
    envStore,
    catalogStore,
    proposalStore,
    commandLogStore,
    userStore,
    serviceStore,
    reputationStore,
    pipeline: changePipeline,
    quotas,
    zoneClaimStore,
    // T-072 (D-1 decide half): an escalated zone-claim also notifies the
    // active delegate, and a delegate-decided apply reaches the owner.
    delegationStore,
    notificationStore,
    flowStore,
    // P2F §11: adopt-config sourceFork lineage + evidence checks.
    sandboxStore,
    evalRunStore,
    // S1 (Task 3): deployment human-review breadth thresholds (per-env
    // owner override wins inside the rule check).
    humanReviewThresholds: {
      maxAgentsPerProposal: config.proposalHumanReviewMaxAgents,
      maxEventsPerProposal: config.proposalHumanReviewMaxEvents,
      maxZonesTouched: config.proposalHumanReviewMaxZonesTouched,
    },
    // T-049: remove-agents cascade honesty — apply snapshots/notifies the
    // FK-destroyed agreements, revert restores them by id, and the rule
    // check warns with agreement/subscription counts.
    agreementStore,
    // T-069 (R23): derivation-sync CREATED services match standing asks.
    standingAsks: standingAskMatcher,
    ...(reviewer !== undefined
      ? { reviewer }
      : {
          // Fix-45d: the no-LLM fallback reviewer follows the same
          // low-risk auto-approve policy as the timeout path.
          reviewer: new EscalatingReviewer({
            autoApproveLowRisk: config.proposalReviewTimeoutAutoApprove,
          }),
        }),
  });
  // P-C sandbox forks (§3 Layer 0): isolated per-user worlds forked from an
  // environment's base layer (+ selected applied overlays). sandboxStore is
  // declared above (before the proposal service — P2F §11 wiring).
  const sandboxService = new SandboxService({
    envStore,
    proposalStore,
    sandboxStore,
    registry,
    quotas,
    // P2F §10.1: the cheap fork's cross-process fallback — a checkpoint a
    // previous process left on disk (same path contract as the session
    // service's lazy rebind).
    findSessionCheckpoint: envId => {
      const path = worldSessionCheckpointPath(config.trajectoryDir, envId);
      return existsSync(path) ? path : undefined;
    },
    // P2F §10.3: the retention knob, stamped per-row as expires_at.
    forkMaxAgeMs: config.forkMaxAgeDays * 24 * 60 * 60 * 1000,
  });
  // Wave-3a batch evaluation: the serial in-process runner. evalRunStore is
  // declared above (its failInterrupted boot sweep ran there already).
  const evalRunService = new EvalRunService({
    registry,
    envStore,
    evalRunStore,
    pipeline: changePipeline,
    perRunTimeoutMs: config.evalRunTimeoutMs,
  });
  // P-D twin sync (§6): real-world perception → base layer. Observations
  // always land in the time series; the device-row update + broadcast is
  // throttled per binding. hass: bindings subscribe through the shared HA
  // connection and degrade to status 'unavailable' when HA is unreachable.
  const observationStore = new ObservationStore(db);
  const syncBindingStore = new SyncBindingStore(db);
  const twinSync = new TwinSyncService({
    envStore,
    observationStore,
    syncBindingStore,
    userStore,
    worldSync,
    hass,
  });
  // HIL reverse mapping P1 (design-hil-reverse-mapping.md §2-P1): snapshot
  // alignment of hass://-bound device state from reality into the base
  // layer. Shares the HA connection + E-stop with the forward path; every
  // alignment write rides the change pipeline (command_log 'hass-reverse-sync').
  const hassReverseSync = new HassReverseSyncService({
    db,
    hass,
    gate: hassGate,
    envStore,
    userStore,
    worldSync,
    pipeline: changePipeline,
  });
  // HIL reverse mapping P2 (design-hil-reverse-mapping.md §2-P2): shadow
  // worlds — an observation-driven sandbox fork per env with hass://
  // bindings. Reuses the sandbox infrastructure (quota/lineage/sweep); the
  // fork can never actuate the real world (bindings rewritten to sim://).
  const hassShadow = new HassShadowService({
    hass,
    gate: hassGate,
    envStore,
    sandboxService,
    sandboxStore,
    registry,
  });
  // P-E replay (§7): wall-clock 时间窗 → scenario JSON 的离线转换工具。
  // T-020: flowStore 注入 —— 回放产物携带环境的 flows（四通道闭环的导出侧）。
  const replayService = new ReplayService({
    envStore,
    observationStore,
    commandLogStore,
    syncBindingStore,
    trajectoryBaseDir: config.trajectoryDir,
    flowStore,
    // P2F §10.4: replay lineage — baked fork records resolve to rows.
    sandboxStore,
  });
  // Fix-11 (service-consumption-design.md §3): the service
  // consumption chain — agreements + append-only usage metering, with the
  // settlement SPI assembled here (SETTLEMENT_PROVIDER; only the Null
  // provider ships in this distribution — no amounts, settle archives).
  const settlement = selectSettlementProvider(config, agreementStore);
  // T-035: one context object shared by the agreement routes AND the
  // trigger executor (agreementRoutesCtx below) — the manual and automatic
  // invocation lanes can never drift apart. (Typed so T-505's late-bound
  // armedResetView assignment below type-checks.)
  const agreementRoutesCtx: AgreementRoutesContext = {
    envStore,
    serviceStore,
    agreementStore,
    userStore,
    registry,
    pipeline: changePipeline,
    settlement,
    reputationStore,
    notificationStore,
    streamHeartbeatMs: config.agreementStreamHeartbeatMs,
    streamSessions: agreementStreamSessions,
    // R14 Wave-A: the countSince window for ComputationSpec evaluation.
    simEventTallies,
    // Living-worlds P1W: the authoritative world session (data lanes
    // default-target it; the trigger executor rides its runtime).
    worldSessions,
    // Mechanism D: flow-service invocation + propose-time terms gates.
    flowStore,
    // T128 (R20-u2 F1): the invoke lane's honest wait floor — 503 +
    // retryAfterSec past it, execution finishes in the background. Default
    // 90s (under the gateway's 100s kill); tests inject a small value via
    // BuildServerOptions.
    ...(options.invokeDecisionWaitMs !== undefined
      ? { invokeDecisionWaitMs: options.invokeDecisionWaitMs }
      : {}),
    // T129 (R21-F1): the consumption lanes' honest targeting wait floor —
    // read lane + stream upgrade (the invoke lane covers targeting under its
    // invokeDecisionWaitMs race). Default 90s; tests inject a small value.
    ...(options.consumptionTargetWaitMs !== undefined
      ? { consumptionTargetWaitMs: options.consumptionTargetWaitMs }
      : {}),
  };

  app.decorate('scenarioStore', store);
  app.decorate('simulations', registry);
  app.decorate('db', db);
  app.decorate('userStore', userStore);
  app.decorate('envStore', envStore);
  app.decorate('serviceStore', serviceStore);
  app.decorate('reputationStore', reputationStore);
  app.decorate('experienceStore', experienceStore);
  app.decorate('catalogStore', catalogStore);
  app.decorate('worldSync', worldSync);
  app.decorate('proposalStore', proposalStore);
  app.decorate('commandLogStore', commandLogStore);
  app.decorate('proposalService', proposalService);
  app.decorate('zoneClaimStore', zoneClaimStore);
  app.decorate('delegationStore', delegationStore);
  app.decorate('sandboxStore', sandboxStore);
  app.decorate('sandboxService', sandboxService);
  app.decorate('evalRunStore', evalRunStore);
  app.decorate('evalRunService', evalRunService);
  app.decorate('observationStore', observationStore);
  app.decorate('syncBindingStore', syncBindingStore);
  app.decorate('twinSync', twinSync);
  app.decorate('replayService', replayService);
  app.decorate('agreementStore', agreementStore);
  app.decorate('standingAskStore', standingAskStore);
  app.decorate('worldSessions', worldSessions!);
  app.decorate('flowStore', flowStore);
  app.decorate('notificationStore', notificationStore);
  app.decorate('settlement', settlement);
  app.decorate('hass', hass);
  app.decorate('hassGate', hassGate);
  app.decorate('hassReverseSync', hassReverseSync);
  app.decorate('hassShadow', hassShadow);
  app.decorate('metrics', metrics);

  // P4-4: in-process fixed-window rate limiting (no-op when disabled — the
  // test harness runs disabled, RATE_LIMIT_ENABLED=false does the same).
  registerRateLimit(app, {
    enabled: config.rateLimitEnabled,
    authPerMin: config.rateLimitAuthPerMin,
    sessionPerMin: config.rateLimitSessionPerMin,
    writePerMin: config.rateLimitWritePerMin,
    globalPerMin: config.rateLimitGlobalPerMin,
  });

  // P4-4: count every completed request by route class × status.
  app.addHook('onResponse', async (request, reply) => {
    metrics.recordHttpRequest(metricsRouteClass(request.url), reply.statusCode);
  });

  await registerAuth(app, { jwtSecret: config.jwtSecret, userStore, apiKeyStore });
  registerApiKeyRoutes(app, { apiKeyStore, envStore, serviceStore });
  registerExternalInvokeRoutes(app, {
    envStore, serviceStore, agreementStore, userStore, pipeline: changePipeline, registry,
    adminEmails: config.adminEmails, worldSessions, agreementRoutes: agreementRoutesCtx,
    eventDeliveryDeadlineMs: config.eventDeliveryDeadlineMs,
  });
  registerEventSourceRoutes(app, {
    envStore, sources: eventSourceStore, registry, worldSessions, pipeline: changePipeline,
  });
  // Keep the poller's stop handle — discarding it leaked the interval past
  // app.close() (the onClose hook below now stops it with everything else).
  let stopEventSourcePoller: (() => void) | undefined;
  if (process.env.EAF_EVENT_SOURCE_POLLING !== 'off') {
    const poller = startPoller(
      { sources: eventSourceStore, registry, worldSessions, pipeline: changePipeline },
      20,
    );
    stopEventSourcePoller = poller.stop;
  }

  // i18n: decorate `request.locale` (Accept-Language / ?lang=) for every
  // subsequent route. Hooks run before route handlers, so registration here
  // (after auth, before routes) covers all user-facing endpoints + WS streams.
  await registerI18n(app);

  registerAuthRoutes(app, {
    userStore,
    adminEmails: config.adminEmails,
    // Alpha capacity gating (EAF_INVITE_ONLY, schema v57).
    inviteOnly: config.inviteOnly,
    inviteStore: platformInviteStore,
    db,
    // R15-D10: accept every pending class invite the moment the invited
    // email registers — membership lands without re-importing the roster.
    onRegistered: ({ userId, email }) => {
      for (const invite of envInviteStore.pendingForEmail(email)) {
        try {
          envStore.addMember(invite.env_id, userId, invite.role);
          envInviteStore.markAccepted(invite.id);
          // T15 (R2, u3-F4): registration auto-join used to be SILENT — the
          // new user's first `notifications list` read 0 unread while the env
          // had quietly appeared. Mirror the registered-member add path
          // (notifyMemberAdded + T-025 audit) for the invite-lane joiner,
          // and give the inviting owner a member.joined mirror.
          const env = envStore.getEnvironment(invite.env_id);
          const inviter =
            invite.invited_by !== null ? userStore.findById(invite.invited_by) : undefined;
          if (env !== undefined) {
            notify(notificationStore, {
              recipientId: userId,
              actorId: inviter?.id ?? userId,
              envId: env.id,
              kind: NOTIFICATION_KINDS.memberAdded,
              title: t(DEFAULT_LOCALE, 'chrome.notif.memberAdded', { envName: env.name }),
              body: {
                envId: env.id,
                envName: env.name,
                role: invite.role,
                inviterName: inviter?.display_name ?? 'the environment owner',
                via: 'registration',
              },
              refId: env.id,
            });
            if (inviter !== undefined) {
              notify(notificationStore, {
                recipientId: inviter.id,
                actorId: userId,
                envId: env.id,
                kind: NOTIFICATION_KINDS.memberJoined,
                title: t(DEFAULT_LOCALE, 'chrome.notif.memberJoined', { email, envName: env.name }),
                body: { envId: env.id, envName: env.name, email, role: invite.role },
                refId: env.id,
              });
            }
            changePipeline.log({
              envId: env.id,
              actorId: inviter?.id ?? userId,
              kind: 'member-change',
              // T-025 shape: actor = the registration (invite redeemed),
              // before/after = the membership change.
              payload: { action: 'added', userId, before: null, after: invite.role, via: 'registration' },
            });
          }
        } catch (error) {
          app.log.warn(`invite acceptance for ${email} in env ${invite.env_id} failed: ${error}`);
        }
      }
    },
  });
  registerHassRoutes(app, {
    hass,
    gate: hassGate,
    envStore,
    adminEmails: config.adminEmails,
    registry,
    reverseSync: hassReverseSync,
    shadow: hassShadow,
  });
  registerEnvironmentRoutes(app, {
    inviteStore: envInviteStore,
    envStore,
    serviceStore,
    flowStore,
    reputationStore,
    userStore,
    worldSync,
    pipeline: changePipeline,
    // R73 (always-on worlds): the env creation handler wakes the env's
    // authoritative world session the moment the environment exists.
    worldSessions,
    // T122: the PATCH defaultSimulationId binding validates against the
    // live registry (exists / this env / not the world session).
    registry,
    commandLogStore,
    proposalStore,
    agreementStore,
    notificationStore,
    // T-072 (D-1 decide half): decision delegations surface on the env
    // detail's governance block + the delegation routes below.
    delegationStore,
    quotas,
    metrics,
    // S1 (Task 3): deployment human-review thresholds for the governance
    // surface (per-env owner overrides applied inside envGovernancePolicy).
    humanReviewThresholds: {
      maxAgentsPerProposal: config.proposalHumanReviewMaxAgents,
      maxEventsPerProposal: config.proposalHumanReviewMaxEvents,
      maxZonesTouched: config.proposalHumanReviewMaxZonesTouched,
    },
    // T-007: world-stream dead-peer heartbeat (shared cadence with the
    // agreement stream).
    streamHeartbeatMs: config.agreementStreamHeartbeatMs,
    // Fix-22: training-export scans per-sim trajectory dirs.
    trajectoryBaseDir: config.trajectoryDir,
    // P2F §10.4: training-export lineage (manifest.forks + window.forkId).
    sandboxStore,
    // S2 (device privacy): deployment admins are full-tier device viewers on
    // the env detail + the world stream's device frames.
    adminEmails: config.adminEmails,
    // Cascade: stop sandbox forks FIRST (their runtimes are not
    // environment-backed, so stopAndRemoveForEnvironment misses them), then
    // the environment-backed simulations; the rows cascade in the database.
    // P-D: also drop the environment's hass: sync subscriptions.
    // P1W: drop the authoritative world session state (its record/checkpoint
    // cascade with the registry's env sweep).
    onEnvironmentDeleted: envId => {
      twinSync.deactivateForEnv(envId);
      sandboxService.stopAllForEnvironment(envId);
      worldSessions?.dropForEnv(envId);
      registry.stopAndRemoveForEnvironment(envId);
    },
  });
  // FEAT-07: env-level occupantSchedule PATCH (runtime lane, no rebuild) —
  // split out of environments.ts at the arch-guard size ceiling.
  registerOccupantScheduleRoutes(app, {
    envStore,
    pipeline: changePipeline,
    occupantScheduleSync,
  });
  // R6-D-M1: the L1-L6 quest-state read model (split from environments.ts
  // for the arch-guard size ceiling).
  registerQuestRoutes(app, {
    envStore,
    agreementStore,
    flowStore,
    trajectoryBaseDir: config.trajectoryDir,
  });
  registerEnvObjectRoutes(app, {
    envStore,
    serviceStore,
    reputationStore,
    userStore,
    commandLogStore,
    pipeline: changePipeline,
    proposalService,
    quotas,
    registry,
    // T-403 (R19): owner-direct PATCH derivation syncs notify consumers of
    // cascade-destroyed agreements.
    agreementStore,
    notificationStore,
    // S2 (device privacy): deployment admins are full-tier device viewers.
    adminEmails: config.adminEmails,
    // T-069 (R23): derivation-sync CREATED services match standing asks.
    standingAsks: standingAskMatcher,
    // R5-F12: agent responses expose effectiveModel (post-normalization).
    ...(config.llmModel !== undefined ? { deployedLlmModel: config.llmModel } : {}),
  });
  registerFlowRoutes(app, {
    envStore,
    flowStore,
    registry,
    pipeline: changePipeline,
    // Mechanism D: flow edits refresh flow-service interfaces (best-effort).
    serviceStore,
    // UX-16: authoring warnings name contending active agreements too.
    agreementStore,
  });
  registerBlueprintRoutes(app, { blueprintStore, envStore, db, agreementStore, serviceStore });
  // Onboarding: built-in scenario templates (read-only, from the seed dir).
  registerScenarioTemplateRoutes(app, { templateDir: config.seedDir, log: app.log });
  // UX wave-3: the built-in device-template catalog (simulation registry).
  registerDeviceTemplateRoutes(app);
  // UX wave-3: import DRAFT lanes (floorplan vision / IFC / OSM). Nothing
  // persists — drafts are reviewed, then imported via POST /api/environments.
  registerEnvironmentImportRoutes(app, {
    visionClientFactory: () => {
      if (options.floorplanVisionClient !== undefined) {
        return typeof options.floorplanVisionClient === 'function'
          ? options.floorplanVisionClient()
          : options.floorplanVisionClient;
      }
      return createVisionClientFromEnv(process.env, {
        // A deployment that configures only the main backend (LLM_BASE_URL)
        // gets one shot at it — if the served model is text-only the
        // recognition call fails honestly (502, provider/model named).
        ...(process.env.EAF_VISION_BASE_URL === undefined && config.llmBaseUrl !== undefined
          ? { baseURL: config.llmBaseUrl }
          : {}),
      });
    },
    // UX wave-5 (NL import lane): the NL function route (LLM_NL_MODEL) wins;
    // otherwise the main deployment. A route with @baseURL pins its own
    // (keyless) vLLM instance — same discipline as the proposal reviewer.
    nlClientFactory: () => {
      if (options.nlImportClient !== undefined) {
        return typeof options.nlImportClient === 'function'
          ? options.nlImportClient()
          : options.nlImportClient;
      }
      const nlRoute = config.llmRoutes?.nl;
      const baseURL = nlRoute?.baseURL ?? config.llmBaseUrl;
      const model = nlRoute?.model ?? config.llmModel;
      if (baseURL === undefined || model === undefined) {
        throw new NLImportError(
          'no LLM backend configured — set LLM_BASE_URL + LLM_MODEL, or an ' +
          'LLM_NL_MODEL route (bare model name or model@http(s)://…)',
        );
      }
      return new LLMClient('openai-compatible', {
        baseURL,
        model,
        // The main deployment's apiKey is only sent to the main backend — a
        // route @baseURL is another vLLM instance (keyless by convention).
        ...(nlRoute?.baseURL !== undefined
          ? {}
          : config.llmApiKey !== undefined
            ? { apiKey: config.llmApiKey }
            : {}),
        // Per-route normalization pins the route model (LLM_MODEL_STRICT
        // applies per route).
        ...(nlRoute !== undefined ? { deployedModel: nlRoute.model } : {}),
        ...(config.llmTimeoutMs !== undefined ? { timeout: config.llmTimeoutMs } : {}),
      });
    },
    ...(options.overpassFetch !== undefined ? { overpassFetch: options.overpassFetch } : {}),
  });
  registerProposalRoutes(app, { envStore, proposalStore, commandLogStore, proposalService, userStore, notificationStore, delegationStore });
  registerSandboxRoutes(app, { envStore, sandboxStore, sandboxService, userStore });
  registerEvalRunRoutes(app, { envStore, evalRunStore, evalRunService });
  registerReplayRoutes(app, { envStore, replayService, scenarioStore: store });
  // R15-B1: anonymous read-only replay share links (+ T-108 lifecycle:
  // owner list/revoke, mint notification, share-create/revoke audit rows).
  registerShareRoutes(app, {
    envStore,
    replayService,
    shareStore: replayShareStore,
    notificationStore,
    pipeline: changePipeline,
  });
  registerTwinSyncRoutes(app, { envStore, observationStore, twinSync });
  // T-409 (DevLoop R19, CC-F06): the tolerant empty-JSON parser used to be
  // registered ONLY inside the encapsulated simulation-routes scope —
  // body-optional endpoints elsewhere (agreements remind/reads, services
  // subscribe) still failed with a raw FST_ERR_CTP_EMPTY_JSON_BODY when an
  // API client sent Content-Type: application/json with an EMPTY body.
  // F6: the parser moved to the ROOT (see the fastifyWebsocket registration
  // above — Fastify refuses a same-name parser in a child scope once the
  // root has one); these scopes inherit it. Routes that REQUIRE a body keep
  // their own field validation — the empty body now yields their teaching
  // field error instead of a framework error.
  app.register(async tolerantServices => {
    registerServiceRoutes(tolerantServices, {
      envStore,
      serviceStore,
      reputationStore,
      userStore,
      pipeline: changePipeline,
      // R14 Wave-A: computation revocation notifies active data agreements'
      // parties (agreement.compute-dropped).
      agreementStore,
      notificationStore,
      // Mechanism D: flow-service publish validation + interface generation.
      flowStore,
      // T-067 (R16): test-deployment grant-expiry probe (default off).
      allowGrantTimeControl: config.allowGrantTimeControl,
      // T-069 (R23): the ask board + publish-event matching.
      standingAskStore,
      // T84 (R10, u1-F3): the read-source writability judge — resolved per
      // request and per VIEWER (T86, R11 u1-F1) through the SAME adjudication
      // the read default lane speaks: the viewer's own running sim when she
      // has exactly one, else the authoritative world session when LIVE. The
      // old "any running sim, session second" probe named worlds the consumer
      // could never read (u1: another member's sim while her default read
      // fell to the world session) — the promise and the read behavior have
      // one decision table again. T91 (R13, u2-F1): the world-selection table
      // itself moved into readSourceProbeTargetOf (agreements/targeting.ts) —
      // own-sim ABSENT and AMBIGUOUS both fall through to the LIVE session
      // (the r13 replay: with several own sims the probe fell silent while
      // the read lane's fallback world was perfectly judgeable), and the
      // "a GET never creates/wakes a session" honest-unknown boundary is the
      // function's own contract, unit-tested beside readDefaultWorldChoiceOf.
      readSourceWritabilityJudgeOf: (envId, viewerId) => {
        const target = readSourceProbeTargetOf(
          { envStore, registry, worldSessions },
          envId,
          viewerId ?? undefined,
        );
        if (target === undefined) return undefined;
        const { record, probedLane } = target;
        return service =>
          readSourceWritabilityOf(
            { envStore, serviceStore, simEventTallies },
            service,
            record,
            probedLane,
          );
      },
    });
  });
  app.register(async tolerantAgreements => {
    // Empty-body tolerance inherited from the ROOT parser (F6).
    registerAgreementRoutes(tolerantAgreements, agreementRoutesCtx);
  });

  // T-035 (DevLoop R17): agreement trigger-clause auto-execution. The
  // executor shares this exact context with the manual invoke route —
  // auto-fired terms.action runs the same metered/receipted/audited path.
  const agreementTriggerExecutor = new AgreementTriggerExecutor(agreementRoutesCtx);
  registry.setAgreementTrigger(agreementTriggerExecutor);
  // T-505 (CB24-F02): the agreement view surfaces pending autoReset arms
  // (late-bound exactly like the executor registration above).
  agreementRoutesCtx.armedResetView = agreementId =>
    agreementTriggerExecutor.armedResetOf(agreementId);
  // Mechanism C (mixed-initiative flows §7): policy-envelope exhaustion
  // escalations become notifications to the ENV OWNER (escalate.toRole —
  // the owner can edit any flow, so the signal reaches someone who can
  // act). Escalation only signals: the run record + node results stay the
  // audit truth; the notification is best-effort and never modifies the
  // flow. Late-assigned exactly like the T-035 trigger above.
  registry.setFlowPolicyEscalationSink(({ record, environmentId }) => {
    const env = envStore.getEnvironment(environmentId);
    if (env === undefined) return; // deleted env — nothing to signal
    const flowName = flowStore.getById(record.flowId)?.name ?? record.flowId;
    notificationStore.create({
      userId: env.owner_id,
      envId: environmentId,
      kind: 'flow-policy-escalation',
      title: `Flow policy envelope exhausted: ${flowName}`,
      body: {
        flowId: record.flowId,
        runId: record.runId,
        flowName,
        status: record.status,
        triggerKind: record.triggerKind,
        escalations: record.policyEscalations,
      },
      refId: record.runId,
    });
  });
  // R40-A3（认知架构 §7.5 升级通道）：agent 升级事件（AGENT_ESCALATION，
  // 高严重度 × 低置信 × 能力边界外，只通知不执行）→ 环境 owner 的
  // agent.escalated 通知。Late-assigned 同上——server 监听开始前不存在
  // 任何 simulation，晚赋值不漏挂。
  registry.setAgentEscalationBridge(new AgentEscalationBridge({ envStore, notificationStore }));
  // FEAT-05（确定性通知车道）：flow notify 节点（{to:'agent'|'role'|'owner',
  // target?, message}）→ 环境通知管道。Late-assigned 同上——server 监听开始
  // 前不存在任何 simulation，晚赋值不漏挂。
  registry.setFlowNotifyExecutor(new FlowNotifyNodeExecutor({ envStore, notificationStore, flowStore }));
  // R6-B-F03（跨租户编排车道）：flow service 节点（{serviceId|semanticType,
  // action?}）→ 合约中介的统一 invocation 核心（executeAgreementInvocation，
  // 与手动 invoke / trigger auto-exec 同一条计量/审计道）。Late-assigned 同上
  // ——共享 agreementRoutesCtx（server.ts:1012 装配），晚赋值不漏挂。
  registry.setFlowServiceExecutor(new FlowServiceNodeExecutor(agreementRoutesCtx));
  registerCatalogRoutes(app, {
    catalogStore,
    envStore,
    userStore,
    commandLogStore,
    pipeline: changePipeline,
    proposalService,
    quotas,
  });
  // The user perspective (W5): workbench overview + deployment manifest.
  registerMeRoutes(app, {
    envStore,
    serviceStore,
    userStore,
    catalogStore,
    registry,
    sandboxStore,
    quotas,
    proposalStore,
    agreementStore,
    notificationStore,
    twinSync,
    capabilityDemandStore,
    worldSessions,
  });
  // Fix-16: the notification inbox (pull-only; live events stay on the stream).
  registerNotificationRoutes(app, { notificationStore, agreementStore });
  // P4-4: Prometheus metrics + the admin observability summary.
  registerObservabilityRoutes(app, {
    metrics,
    registry,
    userStore,
    envStore,
    worldSync,
    databasePath: config.databasePath,
    adminEmails: config.adminEmails,
    // R74: decision posture resolved LIVE — 'llm' only when the LLM backend
    // is fully configured AND the liveness probe sees it answering; a
    // configured-but-dead backend is 'llm-unreachable' (never a silent
    // production claim); unconfigured is the rule harness, TEST-ONLY.
    decisionMode: () =>
      resolveDecisionMode(config, llmLiveness?.snapshot()),
    capabilityDemand: capabilityDemandStore,
    // Alpha capacity gating: /api/health exposes the flag so the web register
    // form knows to require an invite code (EAF_INVITE_ONLY, schema v57).
    inviteOnly: config.inviteOnly,
  });
  // R15-A2: operator data-safety actions (consistent live backup) + alpha
  // capacity gating (platform invites, schema v57).
  registerAdminRoutes(app, {
    db,
    databasePath: config.databasePath,
    adminEmails: config.adminEmails,
    inviteStore: platformInviteStore,
    userStore,
  });
  // The OpenAPI contract + docs page: public, no auth (a contract behind
  // auth is useless to programmatic consumers).
  registerDocsRoutes(app);

  // Production frontend (P3c): serve the built web console at `/` with SPA
  // fallback; degrades to a JSON note when the dist hasn't been built.
  const spaIndex = registerStaticWeb(app, config.webDist);

  // LEGACY routes (P0/P1): stay OPEN during the P2a transition. They are
  // mounted in a scope whose only hook is `optionalAuth` — it attaches an
  // identity when a token is present but never rejects, so the current
  // credential-less frontend keeps working. NB: NOT awaited — awaiting a
  // register() call boots the instance immediately, which would freeze the
  // error handler installed below out of the booted contexts.
  app.register(async legacy => {
    legacy.addHook('onRequest', app.optionalAuth);
    registerScenarioRoutes(legacy, store);
    // Fix-47: the simulation routes sit in an encapsulated context; the
    // tolerant empty-JSON parser they relied on moved to the ROOT (F6) —
    // stop/pause/resume are body-less actions, and an empty JSON body parses
    // as `undefined` (same as sending no content-type at all).
    legacy.register(async simRoutes => {
      // Phase 3 (cognitive architecture): natural-language agent interface.
      // Mounted beside the simulation routes (same tolerant JSON parsing for
      // body-less mistakes; auth enforced per-route — these mutate worlds).
      registerAgentNLRoutes(simRoutes, {
        registry,
        envStore,
        commandLogStore,
        notificationStore,
        adminEmails: config.adminEmails,
        // R46C-P0-A: the NL command lane's device-ownership gates — same
        // stores as the sim command route (teaching 403 names + the active-
        // agreement carve-out oracle).
        userStore,
        agreementStore,
        // R78 病灶 A：越权指名教学 pass 的服务名录（只读）。
        serviceStore,
        // T92 (R13, u1-F1): the restart-teaching judgment — the env's world
        // session is the sim surface that survives a restart; its presence
        // turns a bare pre-restart-id NOT_FOUND into an honest explanation.
        worldSessions,
        // T95 (R14, u1-F1): the DISK half of the judgment — a checkpoint a
        // previous process left proves the env's world survived even BEFORE
        // the first touch lazily rebinds the session view (u1's "restart,
        // then first ask" shape: bare NOT_FOUND, no teaching).
        worldSessionCheckpointProbe: envId => existsSync(worldSessionCheckpointPath(config.trajectoryDir, envId)),
      });
      registerSimulationRoutes(simRoutes, {
        registry,
        store,
        envStore,
        serviceStore,
        // R2-BUG-04: world-session wake/catch-up seams — the sim stream pins
        // the session, /start and /events route through targetFor.
        worldSessions,
        // P2F §10.2: fork membership gates for sandbox sims (joined
        // builders/viewers read + operate the fork's world surfaces).
        sandboxStore,
        // T-401 (R19): device-owner display names for the world-session
        // command gate's teaching 403.
        userStore,
        // R46 (P0-2): the device-command org boundary's agreement carve-out
        // (an active consumer agreement on the provider agent managing the
        // device admits the consumer on env-backed sims).
        agreementStore,
        pipeline: changePipeline,
        // Wave-3a: eval-report disk fallback after restart.
        trajectoryBaseDir: config.trajectoryDir,
        reputationStore,
        snapshotEverySimSec: config.snapshotEverySimSec,
        // T-007: simulation-stream dead-peer heartbeat (shared cadence with
        // the agreement stream).
        streamHeartbeatMs: config.agreementStreamHeartbeatMs,
        quotas,
        metrics,
        // Fix-42b: bound each manual step request (EAF_MAX_STEP_TICKS).
        maxStepTicks: config.maxStepTicks,
        // T-023: bound the event-injection agent-delivery wait
        // (EAF_EVENT_DELIVERY_DEADLINE_MS; 0 disables).
        eventDeliveryDeadlineMs: config.eventDeliveryDeadlineMs,
        // Fix-47: admin override for simulation visibility/control.
        adminEmails: config.adminEmails,
      });
    });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        metrics.recordError({
          method: request.method,
          url: request.url,
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
        });
      }
      // T129 (R21-F1): a pending-503 carries retryAfterSec BOTH in the body
      // and as the standard Retry-After header — one envelope for every lane
      // (the invoke route set the header itself pre-T129; the read lane's
      // ApiError is thrown deep in deliverRead, so the handler owns it).
      if (error.details?.retryAfterSec !== undefined) {
        reply.header('retry-after', String(error.details.retryAfterSec));
      }
      return reply
        .code(error.statusCode)
        .send(errorBody(error.code, error.message, error.issues, error.details));
    }
    // Fastify-generated errors (body parsing, bad content types, …) carry a
    // statusCode; anything else is an unexpected 500.
    const withStatus = error as { statusCode?: unknown; code?: unknown; message?: string };
    // T-111: oversized bodies must fail in the platform envelope with a
    // teaching message, not Fastify's raw FST_ERR_CTP_BODY_TOO_LARGE.
    if (withStatus.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const limitMb = Math.round(config.maxBodyBytes / (1024 * 1024));
      return reply.code(413).send(errorBody(
        'REQUEST_BODY_TOO_LARGE',
        `Request body exceeds the ${limitMb}MB limit (EAF_MAX_BODY_BYTES). ` +
          'For scenario/replay imports: narrow the replay window (from/to), ' +
          'or bake fewer events before exporting — then retry; raise ' +
          'EAF_MAX_BODY_BYTES knowingly for genuinely larger documents.',
        undefined,
        { limitBytes: config.maxBodyBytes },
      ));
    }
    // R13 (CB-F08): Content-Length vs actual body byte mismatch surfaces as
    // a raw Fastify code; clients (especially shells that mangle multibyte
    // UTF-8) see an internal-looking failure. Same envelope treatment as
    // T-111 — platform code, cause, and what to redo.
    if (withStatus.code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH') {
      return reply.code(400).send(errorBody(
        'CONTENT_LENGTH_MISMATCH',
        'Request body byte count does not match its Content-Length header — the body was ' +
          'truncated or mangled in transit (a shell or proxy re-encoding multibyte UTF-8 is the ' +
          'usual cause). Re-send the request with the exact bytes (write the JSON to a file and ' +
          'use --data-binary @file, or let the HTTP client compute Content-Length itself)',
      ));
    }
    const statusCode = typeof withStatus.statusCode === 'number' ? withStatus.statusCode : 500;
    const code = typeof withStatus.code === 'string'
      ? withStatus.code
      : statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
    if (statusCode >= 500) {
      request.log.error(error);
      metrics.recordError({
        method: request.method,
        url: request.url,
        statusCode,
        code,
        message: withStatus.message ?? 'Internal error',
      });
    }
    return reply.code(statusCode).send(errorBody(code, withStatus.message ?? 'Internal error'));
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    // SPA fallback (P3c): the web console switches views client-side, so any
    // non-API GET that matched no file is a view — hand it index.html.
    // /api/* misses keep the JSON 404 contract.
    if (request.method === 'GET' && !request.url.startsWith('/api')) {
      // R1 (B1-7 / P-02): the contract aliases are REAL files at the root —
      // serve the same cached content as /api/openapi.yaml and /api/docs;
      // they must never fall into the SPA fallback (a 200-HTML "contract"
      // is exactly how all four R1 testers were misled). Independent of the
      // web dist: the contract exists even when the console does not.
      if (path === '/openapi.yaml') return sendOpenApiYaml(reply);
      if (path === '/openapi.json') return sendOpenApiJson(reply);
      if (path === '/docs') return sendDocsPage(request, reply);
      if (spaIndex !== null) {
        // A file-looking miss (a path extension, or an explicit yaml/json
        // accept) is a typo or a programmatic fetch — an honest 404 teaches
        // the path is wrong; index.html would mask it with a 200.
        const lastSegment = path.slice(path.lastIndexOf('/') + 1);
        const accept = String(request.headers.accept ?? '');
        const looksLikeFile =
          /\.[A-Za-z0-9]+$/.test(lastSegment) ||
          /\btext\/yaml\b/.test(accept) ||
          /^\s*application\/json\b/.test(accept);
        if (looksLikeFile) {
          return reply
            .code(404)
            .send(errorBody('ROUTE_NOT_FOUND', `${request.method} ${request.url} not found`));
        }
        return reply.header('content-type', 'text/html; charset=utf-8').send(spaIndex);
      }
    }
    // Dist missing (P3c): `/` gets a friendly note instead of a bare 404.
    // Deliberately NOT a registered route, so the OpenAPI route
    // reconciliation (which sees the no-dist test app) stays exact.
    if (spaIndex === null && request.method === 'GET' && path === '/') {
      return reply.send(frontendNotBuiltNote());
    }
    return reply
      .code(404)
      .send(errorBody('ROUTE_NOT_FOUND', `${request.method} ${request.url} not found`));
  });

  // Graceful shutdown: closing the server stops every simulation runtime
  // (clears tick loops, stream subscriptions, agents), drops the twin-sync
  // HA subscriptions, closes the shared HA connection, and closes the
  // database handle. P1W: the world session service releases its demotion
  // timers first (its runtimes die with stopAll; hibernated session
  // checkpoints stay on disk for the next process / P2F forks).
  app.addHook('onClose', async () => {
    worldSessions?.close();
    stopEventSourcePoller?.(); // stop the external-event-source poll interval
    clearInterval(forkSweepTimer); // S3 (Task 2): stop the fork-retention sweep
    if (rollupSweepTimer !== undefined) {
      clearInterval(rollupSweepTimer); // Living-worlds P2: stop the compactor sweep
    }
    registry.stopAll();
    twinSync.close();
    hassReverseSync.close();
    hassShadow.close();
    hass.close();
    db.close();
    // Flush + close the LOG_FILE rotating destination, if one was opened.
    try {
      logging.rotatingLog?.end();
    } catch {
      // Already closed / never opened — shutdown must not fail on logging.
    }
  });

  // P-D boot recovery: re-activate hass: sync bindings stored by previous
  // runs (best effort — failures mark the binding 'unavailable', never
  // block startup).
  void twinSync.activateAllStored();

  // HIL P1 boot: when the stored reverse-sync policy is 'live', start the
  // bound-entity subscriptions (best effort, reconcile retries while down).
  hassReverseSync.start();

  // HIL P2 boot: reap shadow-fork rows orphaned by a previous process
  // (shadow state is in-memory; the fork's registry sim died with it).
  hassShadow.start();

  // T-011 trajectory disk GC: boot sweep of stale simulation dirs. Records
  // are in-memory, so every dir under trajectoryDir at boot is an orphan of
  // a previous process; dirs whose newest file is older than the retention
  // window (EAF_TRAJECTORY_MAX_AGE_DAYS, default 7; 0 disables) are removed.
  // Best effort — a failed sweep never blocks startup.
  if (config.trajectoryMaxAgeDays > 0) {
    try {
      const { removed, kept } = cleanupOldTrajectories(
        config.trajectoryDir,
        config.trajectoryMaxAgeDays * 24 * 60 * 60 * 1000,
      );
      if (removed > 0) {
        app.log.info(
          `trajectory GC: removed ${removed} stale simulation dir(s), kept ${kept} ` +
          `within the ${config.trajectoryMaxAgeDays}-day retention window`,
        );
      }
    } catch (error) {
      app.log.warn(`trajectory GC sweep failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Living-worlds P2: timeline rollup compactor — boot sweep AFTER the
  // T-011 dir sweep (dirs about to die by retention do not waste a rollup)
  // and a periodic pass (EAF_ROLLUP_SWEEP_SEC, default 1h; 0 = boot +
  // on-rotation hooks only). Sealed segments older than the raw window
  // (EAF_ROLLUP_WINDOW_DAYS, default 7; 0 disables) compact to minute-grain
  // rollups, then the raw is deleted (crash-safe ordering). Best effort — a
  // failed sweep never blocks startup.
  const runRollupSweep = (): void => {
    if (config.rollupWindowDays <= 0) return;
    try {
      const result = sweepTrajectoryBaseDir(config.trajectoryDir, {
        rollupWindowMs: config.rollupWindowDays * 24 * 60 * 60 * 1000,
      });
      if (result.rolledSegments > 0 || result.deletedRawFiles > 0) {
        app.log.info(
          `timeline compactor: rolled ${result.rolledSegments} segment(s) into ` +
          `${result.rollupFilesWritten} rollup file(s) (~${Math.round(result.rollupBytes / 1024)}KB), ` +
          `deleted ${result.deletedRawFiles} raw file(s) ` +
          `(~${Math.round(result.rawBytesDeleted / (1024 * 1024))}MB) across ${result.sweptDirs} sim dir(s)`,
        );
      }
    } catch (error) {
      app.log.warn(`timeline compactor sweep failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  runRollupSweep();
  let rollupSweepTimer: NodeJS.Timeout | undefined;
  if (config.rollupSweepSec > 0) {
    rollupSweepTimer = setInterval(runRollupSweep, config.rollupSweepSec * 1000);
    rollupSweepTimer.unref();
  }

  // S3 (Task 2): sandbox-fork retention (EAF_FORK_MAX_AGE_DAYS, default 7).
  // Runs once at boot (right after the T-011 sweep — together they bound the
  // fork footprint: rows + sims + dirs) and hourly afterwards. Sweeping only
  // ever stops sandbox rows the platform itself created (never environments,
  // never non-sandbox sims — see SandboxService.sweepStaleForks).
  const runForkSweep = (): void => {
    if (config.forkMaxAgeDays <= 0) return;
    try {
      const { swept, kept } = sandboxService.sweepStaleForks({
        maxAgeMs: config.forkMaxAgeDays * 24 * 60 * 60 * 1000,
      });
      if (swept > 0) {
        app.log.info(
          `fork GC: swept ${swept} stale sandbox fork(s) (stopped + registry sim + trajectory dir), ` +
            `${kept} active within the ${config.forkMaxAgeDays}-day retention window`,
        );
      }
    } catch (error) {
      app.log.warn(`fork GC sweep failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  runForkSweep();
  const forkSweepTimer = setInterval(runForkSweep, 60 * 60 * 1000);
  forkSweepTimer.unref();

  // R77-F5 residual (Wave A5): stale-proposal nudger — proposals pending past
  // 24h earn the provider ONE aggregated reminder per env (at most one per
  // 24h; see agreement-stale.ts for the noise rules). Same posture as the
  // fork GC: boot run + hourly unref'd interval, best-effort — a failed
  // sweep never blocks startup and never breaks the decide lane.
  const runStaleProposalSweep = (): void => {
    try {
      const { stale, notified } = sweepStaleProposedAgreements({
        agreementStore,
        notificationStore,
        serviceStore,
      });
      if (notified > 0) {
        app.log.info(
          `stale-proposal sweep: ${stale} proposal(s) pending >24h, ${notified} provider reminder(s) sent`,
        );
      }
    } catch (error) {
      app.log.warn(`stale-proposal sweep failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  runStaleProposalSweep();
  const staleProposalTimer = setInterval(runStaleProposalSweep, 60 * 60 * 1000);
  staleProposalTimer.unref();

  // R6-E-F08 full failover (agreement-failover.ts): the unreachable-provider
  // watchdog. Liveness fact source: the env's authoritative world-session
  // runtime (`sim-<envId>-world-session`) — EnvironmentCenter registrations
  // armed with lastSeenAt by ServicePublisher heartbeats. World-mirrored
  // rows carry no heartbeat semantics, and an env WITHOUT a running session
  // yields null (unknown → never judged): a paused/hibernated world must not
  // mass-suspend its contracts. Same posture as the sweeps above: boot run +
  // unref'd interval, best-effort — a failed sweep never blocks startup.
  const failoverLivenessProbe: ProviderLivenessProbe = {
    latestHeartbeatMs(envId, agentId) {
      const record = registry.get(worldSessionSimIdOf(envId));
      if (record === undefined || record.runtime.getState() !== 'running') return null;
      let latest: number | null = null;
      for (const registration of record.runtime.getEnvironmentCenter().getServices().values()) {
        if (registration.agentId !== agentId || registration.lastSeenAt === undefined) continue;
        const ms = registration.lastSeenAt.getTime();
        if (latest === null || ms > latest) latest = ms;
      }
      return latest;
    },
  };
  const runFailoverSweep = (): void => {
    try {
      const { watched, suspended, recovered } = sweepProviderFailover(
        {
          agreementStore,
          serviceStore,
          envStore,
          notificationStore,
          pipeline: changePipeline,
          liveness: failoverLivenessProbe,
          unreachableMs: config.agreementFailoverUnreachableMs,
        },
      );
      if (suspended > 0 || recovered > 0) {
        app.log.info(
          `provider-failover sweep: ${watched} watched, ${suspended} parked (provider-unreachable), ${recovered} recovered (terminate + re-sign)`,
        );
      }
    } catch (error) {
      app.log.warn(`provider-failover sweep failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  runFailoverSweep();
  const failoverTimer = setInterval(runFailoverSweep, config.agreementFailoverScanIntervalMs);
  failoverTimer.unref();

  // S3 (Task 3): cross-process world-session resume — the P1W deferred gap.
  // Hibernated world sessions were registry-memory only; a restart lost them
  // while their checkpoints stayed on disk. Eager half of the recovery: scan
  // the trajectory dir for `sim-<envId>-world-session/checkpoint.json` (the
  // deterministic session id makes them identifiable per env), adopt each as
  // a lightweight hibernated record, and surface `worldSession: hibernated`
  // with the checkpoint metadata. The next arrival wakes it through the
  // normal P1W path (current-topology rebuild + drift notes + fast-forward).
  // The lazy half (findHibernatedCheckpoint above) covers envs the scan
  // missed or checkpoints written after boot by other means.
  // Ordering: AFTER the T-011 sweep, so checkpoints older than the retention
  // window are honestly reaped instead of rebound to stale worlds; envs that
  // no longer exist are skipped (their dirs age out through T-011 too).
  {
    let rebound = 0;
    const skipped: string[] = [];
    const reboundEnvIds: string[] = [];
    const bareWorldIds: string[] = [];
    try {
      for (const entry of readdirSync(config.trajectoryDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = /^sim-(.+)-world-session$/.exec(entry.name);
        if (match === null) continue;
        const envId = match[1]!;
        const env = envStore.getEnvironment(envId);
        if (env === undefined) {
          skipped.push(envId);
          continue; // env deleted while the server was down — nothing to resume into
        }
        const checkpointPath = worldSessionCheckpointPath(config.trajectoryDir, envId);
        if (!existsSync(checkpointPath)) {
          // R76 (always-on completion): a trajectory dir WITHOUT a checkpoint
          // means the world was RUNNING when the process died (a deliberate
          // stop/freezes writes a checkpoint first) — the old scan skipped
          // it, so hard-killed worlds never came back. Resurrect from the
          // env rows (current topology) instead of a frozen checkpoint.
          bareWorldIds.push(envId);
          continue;
        }
        try {
          const adopted = registry.adoptHibernatedCheckpoint(checkpointPath, {
            environmentOwnerId: env.owner_id,
          });
          if (adopted !== undefined) {
            worldSessions.adoptHibernated(envId, adopted);
            reboundEnvIds.push(envId);
            rebound += 1;
          }
        } catch (error) {
          // Corrupt/foreign-version checkpoint: teaching error logged, one
          // per file — recovery must never block the boot.
          app.log.warn(
            `world session recovery: checkpoint ${checkpointPath} not adoptable ` +
              `(${error instanceof Error ? error.message : error}) — the env will materialize a fresh world on next arrival`,
          );
        }
      }
    } catch (error) {
      // A missing/unreadable trajectory dir = nothing to recover (fresh
      // installs never create it until the first sim) — same convention as
      // the T-011 sweep; anything else is worth a warn but never fatal.
      const code = (error as { code?: unknown }).code;
      if (code !== 'ENOENT') {
        app.log.warn(
          `world session recovery scan failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    // F7: the eager wake must also run when NOTHING was checkpointed — the
    // old `rebound > 0` gate swallowed the all-hard-killed case (every world
    // was running, none had a checkpoint), so those worlds never came back.
    if (rebound > 0 || bareWorldIds.length > 0) {
      app.log.info(
        `world session recovery: rebound ${rebound} checkpointed + ${bareWorldIds.length} hard-kill ` +
          'world session(s) (eagerly waking them — worlds never sleep across restarts)' +
          (skipped.length > 0 ? `; skipped ${skipped.length} whose environment no longer exists` : ''),
      );
      // R74c + R76: the always-on contract — a server restart must NOT
      // silently stop the worlds and wait for an arrival. Wake every
      // recovered session (checkpointed AND hard-kill survivors) through the
      // same mutation path an arrival uses (per-env serialized;
      // fire-and-forget so boot never blocks on catch-up), failures logged.
      for (const envId of [...reboundEnvIds, ...bareWorldIds]) {
        void worldSessions
          .onWorldMutation(envId, { create: true })
          .catch((error: unknown) => {
            app.log.warn(
              `world session eager wake for env ${envId} failed: ` +
                `${error instanceof Error ? error.message : String(error)} — it will wake on the next arrival`,
            );
          });
      }
    }
  }

  return app;
}

/**
 * Fix-47 (F6: root-wide since then): JSON parser that treats an EMPTY body
 * as `undefined` instead of failing with FST_ERR_CTP_EMPTY_JSON_BODY —
 * body-less actions (stop/pause/resume, DELETE) must tolerate clients that
 * always send `Content-Type: application/json`. Non-empty bodies parse
 * exactly like the default parser; malformed JSON stays a 400.
 */
function tolerantJsonParser(
  _request: FastifyRequest,
  body: string | Buffer,
  done: (error: Error | null, result?: unknown) => void,
): void {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  if (text.trim().length === 0) {
    done(null, undefined);
    return;
  }
  try {
    done(null, JSON.parse(text));
  } catch (error) {
    (error as { statusCode?: number }).statusCode = 400;
    done(error as Error);
  }
}

/** Drop undefined values so Partial overrides never erase config defaults. */
function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * P-B reviewer selection (§5.2): the LLM semantic reviewer when the
 * OpenAI-compatible backend is configured (PROPOSAL_REVIEWER=auto|llm),
 * undefined otherwise — the service then falls back to the P-A
 * escalate-everything reviewer. Per-call LLM failures degrade to `escalate`
 * inside LLMReviewer itself.
 *
 * T-024 (DevLoop R17): the reviewer's client joins the same observability +
 * cache surfaces as the simulation clients (ED-F11) — review token usage
 * and latency flow into the metrics collector, and the shared response
 * cache serves identical review prompts instead of re-billing them on
 * every resubmission. Exported for the instrumentation unit test.
 */
export function selectProposalReviewer(
  config: ServerConfig,
  envStore: EnvironmentStore,
  log: { warn: (msg: string) => void },
  observability?: {
    cache?: LLMCache;
    onUsage?: (usage: LlmTokenUsage) => void;
    onLatency?: (durationMs: number, success: boolean) => void;
  },
): ProposalReviewer | undefined {
  // R44-B: one backend — "the LLM is configured" means the
  // openai-compatible triple is set (the provider constructor requires a
  // model, so the reviewer needs both LLM_BASE_URL and a model).
  // Per-function routing: proposal review belongs to the NL route
  // (LLM_NL_MODEL); an explicit LLM_REVIEW_MODEL still wins for the model
  // name. A route with @baseURL makes the reviewer configured even without
  // LLM_BASE_URL (its calls pin the route's own vLLM instance).
  const nlRoute = config.llmRoutes?.nl;
  const useNlRoute = config.llmReviewModel === undefined && nlRoute !== undefined;
  const reviewModel = config.llmReviewModel ?? nlRoute?.model ?? config.llmModel;
  const reviewBaseUrl = useNlRoute ? nlRoute.baseURL ?? config.llmBaseUrl : config.llmBaseUrl;
  const llmConfigured = reviewBaseUrl !== undefined && reviewModel !== undefined;
  const wantsLlm =
    config.proposalReviewer === 'llm' || (config.proposalReviewer === 'auto' && llmConfigured);
  if (!wantsLlm) return undefined;
  if (!llmConfigured) {
    log.warn(
      'PROPOSAL_REVIEWER=llm requires a configured LLM backend (LLM_BASE_URL plus LLM_MODEL, ' +
        'LLM_REVIEW_MODEL, or an LLM_NL_MODEL route with its own @baseURL) ' +
        '— falling back to the escalate-everything reviewer',
    );
    return undefined;
  }
  const llm = new LLMClient('openai-compatible', {
    baseURL: reviewBaseUrl,
    // The main deployment's apiKey is only sent to the main backend — a
    // route @baseURL is another vLLM instance (keyless by convention).
    ...(useNlRoute && nlRoute?.baseURL !== undefined
      ? {}
      : config.llmApiKey !== undefined
        ? { apiKey: config.llmApiKey }
        : {}),
    model: reviewModel,
    // Per-route normalization: requests naming another model are rewritten
    // to the NL-route model (LLM_MODEL_STRICT=1 errors instead).
    ...(useNlRoute && nlRoute !== undefined ? { deployedModel: nlRoute.model } : {}),
    // S-vLLM (R20): keep the review client's provider timeout in step
    // with LLM_TIMEOUT_MS when set (default 30s otherwise).
    ...(config.llmTimeoutMs !== undefined ? { timeout: config.llmTimeoutMs } : {}),
  });
  // T-024: same instrumentation + cache as the registry's sim clients.
  if (observability?.cache !== undefined) llm.enableCache(observability.cache);
  if (observability?.onUsage !== undefined || observability?.onLatency !== undefined) {
    instrumentLLMClient(
      llm,
      observability.onUsage ?? (() => {}),
      observability.onLatency,
    );
  }
  // Fix-12: the per-call review budget is operator-configurable
  // (PROPOSAL_REVIEW_LLM_TIMEOUT_MS, default 60s), and the timeout/failure
  // policy too (PROPOSAL_REVIEW_TIMEOUT_AUTO_APPROVE, default on: low-risk
  // proposals auto-approve with an audit marker; off = pure escalate).
  return new LLMReviewer({
    llm,
    envStore,
    timeoutMs: config.proposalReviewLlmTimeoutMs,
    timeoutAutoApprove: config.proposalReviewTimeoutAutoApprove,
  });
}

/**
 * Fix-11 §3.4 settlement assembly: config.settlementProvider is validated at
 * load time ('null' is the only value this distribution accepts), so this is
 * a straight constructor call — the seam external providers plug into.
 */
function selectSettlementProvider(
  config: ServerConfig,
  agreementStore: AgreementStore,
): SettlementProvider {
  void config; // 'null' is the only accepted value today (see config.ts)
  return new NullSettlementProvider(agreementStore);
}
