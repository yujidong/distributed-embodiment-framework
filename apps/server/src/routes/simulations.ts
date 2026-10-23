/**
 * Simulation routes — EngineRuntime lifecycle, event injection, device
 * commands, and the WebSocket state stream
 *
 * REST:
 * - `POST /api/simulations`                 create; 201 `{ id, scenarioId, state, llm }`.
 *                                           Body carries exactly one of
 *                                           `scenarioId` (legacy file store,
 *                                           open) or `environmentId` (P2a
 *                                           bridge: the environment record is
 *                                           converted to a ScenarioDefinition;
 *                                           snapshot scenarioId/name come from
 *                                           the env; access = public env or
 *                                           member).
 * - `GET  /api/simulations`                 list `{ id, scenarioId, state, simTimeSec, llm }`
 *                                           — VISIBILITY (Fix-47): admin sees
 *                                           everything; anyone else sees only
 *                                           sims they created, sims of
 *                                           environments they are a member
 *                                           of, and creator-less legacy sims
 *                                           (transition semantics). Optional
 *                                           `?environmentId=` narrows the
 *                                           list to one environment — allowed
 *                                           when the caller may read that
 *                                           environment (member or public);
 *                                           403 on a private env they are not
 *                                           a member of, 404 on an unknown
 *                                           env id.
 * - Lifecycle ops (start/pause/resume/stop/step, fault writes, event
 *   injection): the sim's CREATOR, an owner/builder of its environment, or
 *   an admin (ADMIN_EMAILS) — everyone else is 403 (Fix-47). Creator-less
 *   simulations (anonymous creations carry no createdBy) stay operable by
 *   anyone: they belong to no one, so there is nobody to authorize against
 *   (transition semantics, mirroring the /commands rule). Body-less ops
 *   tolerate an empty JSON body — a `Content-Type: application/json` header
 *   with no payload no longer fails with FST_ERR_CTP_EMPTY_JSON_BODY.
 * - By-id READS (snapshot/trajectory/timeline/collaborations/eval-report/
 *   faults/stream) follow the sim's ENVIRONMENT read gate (T-015): a sim of
 *   a PUBLIC environment is readable by anyone (anonymous included — same
 *   rule as the environment detail), a sim of a PRIVATE environment
 *   requires membership; the creator and admins always pass. Legacy
 *   scenario-store sims keep the transition semantics (creator-less open,
 *   creator-owned creator-only) — coherent with what the Fix-47 list shows.
 * - `GET  /api/simulations/:id/snapshot`    full EngineSnapshot
 * - `GET  /api/simulations/:id/trajectory`  parsed trajectory records (W8):
 *                                           `{ records: TrajectoryRecord[] }`,
 *                                           optional `?eventId=`/`?agentId=`
 *                                           filters; ≤500 latest records per
 *                                           call; `{ records: [] }` when the
 *                                           sim records nothing (rule-only) —
 *                                           then with a `note` pointing at
 *                                           /timeline (T-005)
 * - `GET  /api/simulations/:id/timeline`    sim-side timeline (T-005):
 *                                           `{ records: SimTimelineRecord[] }`
 *                                           — zone-parameter samples +
 *                                           device state changes from
 *                                           `<trajectoryDir>/sim-timeline.jsonl`
 *                                           (≤500 latest records); the data
 *                                           /trajectory cannot show for
 *                                           rule-only runs
 * - `GET  /api/simulations/:id/collaborations`  AC collaborations (Fix-8):
 *                                           `{ collaborations: [...] }`, one
 *                                           row per (collaboration, agent-
 *                                           view) with status (pending /
 *                                           in_progress / completed /
 *                                           cancelled / failed); optional
 *                                           `?agentId=`/`?status=` filters.
 *                                           Handshake: pending resolves when
 *                                           all partners respond or the 120s
 *                                           handshake timeout cancels it.
 * - `POST /api/simulations/:id/start`       body `{ speed? }` (sim-s per tick)
 * - `POST /api/simulations/:id/pause`       idempotent; world sessions 409
 *                                           (WORLD_SESSION_PAUSE_UNSUPPORTED,
 *                                           see simulations-world-session.ts)
 * - `POST /api/simulations/:id/resume`      idempotent
 * - `POST /api/simulations/:id/stop`        stops the runtime; the record
 *                                           STAYS in the registry, so
 *                                           list/snapshot keep working on
 *                                           stopped simulations
 * - `POST /api/simulations/:id/step`        body `{ n? }` manual ticks
 * - `GET  /api/simulations/:id/eval-report` decision-quality metrics (Fix-22
 *                                           评估钩子): event/decision counts
 *                                           (decisionSource distribution),
 *                                           handshake success rate, Fix-12
 *                                           effect-recheck pass rate, and a
 *                                           reputation summary — pure
 *                                           aggregation over trajectory +
 *                                           reputation data (source
 *                                           'registry'). Wave-3a: a registry
 *                                           miss (post-restart) rebuilds the
 *                                           same metrics from the on-disk
 *                                           trajectory dir (source 'disk';
 *                                           registry-only state degrades
 *                                           honestly, see notes).
 * - `POST /api/simulations/:id/events`      body = injectEvent input;
 *                                           returns InjectEventResult.
 *                                           Env-backed sims: viewers are 403
 *                                           (read-only, Fix-13 — same gate as
 *                                           /commands).
 * - `POST /api/simulations/:id/commands`    body `{ deviceId, commandName,
 *                                           params? }`; AUTHENTICATED (Fix-1):
 *                                           env-backed sims require env
 *                                           membership; viewers are 403
 *                                           (read-only, Fix-4); legacy sims
 *                                           require the creator. A PRIVATE
 *                                           simulation is an isolated
 *                                           rehearsal sandbox (Fix-9, R4-P1)
 *                                           — but R46 (P0-2) adds the ORG
 *                                           BOUNDARY: members may drive the
 *                                           importer-owned devices (shared
 *                                           sandbox) and their OWN devices;
 *                                           ANOTHER member's device is 403
 *                                           with a teaching message (the
 *                                           sanctioned lanes: an active
 *                                           agreement on the managing agent's
 *                                           service, or an ownership-transfer
 *                                           proposal). Hard exception:
 *                                           a device bound to `hass://`
 *                                           bridges to real hardware, so only
 *                                           the device OWNER may command it
 *                                           (403 otherwise). T-401 (R19): the
 *                                           authoritative WORLD SESSION
 *                                           (envSession) writes back for real,
 *                                           so it gates STRICTER — by device
 *                                           ownership: the device owner, the
 *                                           env owner,
 *                                           an admin, or an unowned device
 *                                           only; everyone else gets a 403
 *                                           pointing at the sanctioned
 *                                           cross-tenant lane (agreement +
 *                                           POST /api/agreements/:id/
 *                                           invocations).
 *                                           Success
 *                                           returns the engine's
 *                                           `{ success, result? }` and — for
 *                                           env-backed sims — is audited in
 *                                           command_log as `device-command`
 *                                           ({deviceId, commandName, before,
 *                                           after}, replay-consumable).
 *                                           Request-level failures are 4xx:
 *                                           unknown device 404 DEVICE_NOT_FOUND,
 *                                           device with no managing agent 409
 *                                           DEVICE_NOT_MANAGED, unknown command
 *                                           400 UNKNOWN_COMMAND; EXECUTION
 *                                           failures (device offline, HA
 *                                           errors) stay a single-layer
 *                                           200 `{ success:false, error }`.
 *                                           P3b: a hass:// command parked by
 *                                           the safety gate returns **202**
 *                                           `{ …, pending: true, pendingId }`
 *                                           instead of 200.
 * - `GET    /api/simulations/:id/faults`    map of active fault profiles
 *                                           (P3d failure-mode injection)
 * - `PUT    /api/simulations/:id/faults/:deviceId`    body = FaultProfile
 *                                           (`{ offline?, failureRate?,
 *                                           latencyMs?, staleState? }`);
 *                                           returns `{ deviceId, fault }`
 * - `DELETE /api/simulations/:id/faults/:deviceId`    clear (idempotent);
 *                                           returns `{ deviceId, fault: null }`
 *
 * WebSocket:
 * - `GET /api/simulations/:id/stream`       upgrade; unknown id → 404 before
 *   the upgrade (preValidation). On connect an immediate snapshot is sent,
 *   then engine events batched at most every 100 ms (≤10 msg/s) and a fresh
 *   snapshot every `snapshotEverySimSec` simulated seconds. Messages are
 *   `{ kind: 'snapshot', data: EngineSnapshot }` or
 *   `{ kind: 'event', data: SystemEvent[] }` (batch — injected events reach
 *   the bus only through their downstream effects; see EngineRuntime).
 *   T-007 lifecycle: the stream is receive-only — a client that sends data
 *   gets a `{kind:'error', code:'STREAM_READ_ONLY'}` teaching frame back.
 *   When the simulation stops (any stop path, including stopAndRemove and
 *   the registry's retention prune) subscribers first receive a final
 *   snapshot with `state:'stopped'`, then the socket closes with
 *   1001 'simulation stopped' — a stopped sim never leaves the stream
 *   silently open. A ping/pong heartbeat (STREAM_HEARTBEAT_MS) terminates
 *   dead peers so they cannot hold sockets/gauges open forever.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';

// T80 (R9, u2-F1): the sim command lane speaks the ONE command-equivalence
// vocabulary — the same module the agent NL execution filter, the what-if
// fork gate (predictor) and the snapshot `commands` face already speak.
import {
  EventType,
  resolveCommandEquivalence,
  type FaultProfile,
  type InjectEventInput,
  type SystemEvent,
} from '@active-collaboration/core';

import type { ChangePipeline } from '../change-pipeline.js';
import type { AuthUser } from '../auth/index.js';
import { isAdminEmail } from '../auth/admin.js';
import { requireReadAccess } from '../env-access.js';
import {
  deviceDetailTier,
  projectDeviceStateRecord,
  projectSnapshotDevice,
  type DeviceViewer,
  type SnapshotDeviceView,
} from '../device-privacy.js';
import { deviceOracleFor, deviceViewerOf } from '../device-viewer.js';
import { environmentServiceWarnings, environmentToScenario } from '../environment-bridge.js';
import { assertDeviceCommandGates } from '../device-command-gates.js';
import {
  flattenCommandSuccess,
  pendingConfirmationId,
  unwrapDeviceFailure,
} from '../device-command-outcome.js';
import { parseJsonArray, type EnvironmentStore, type EnvRole } from '../db/environment-store.js';
import type { AgreementStore } from '../db/agreement-store.js';
import { assertWorldSessionPausable, hibernateWithSessionAdoption, resumeWorldSessionIfAny, startWorldSessionIfAny, stopWorldSessionIfAny } from './simulations-world-session.js';
import type { ReputationStore } from '../db/reputation-store.js';
import type { SandboxStore } from '../db/sandbox-store.js';
import type { ServiceStore } from '../db/service-store.js';
import type { UserStore } from '../db/user-store.js';
import { ApiError, errorBody } from '../errors.js';
import {
  aggregateEvalRecords,
  EVAL_REPORT_MAX_RECORDS,
  loadDiskEvalReport,
  reconcileMetaAgents,
} from '../eval-report.js';
import { runWithActuationUser } from '../hass/safety-gate.js';
import { AgreementStreamSessions } from '../agreement-stream-sessions.js';
import {
  emptyTrajectoryNote,
  optionalQueryString,
  parseCreateOptions,
} from './simulation-create-options.js';
// R21-W1 split: the shared body parsers / error formatters live in
// simulation-parse.ts; re-export the two publics external-invoke.ts imports
// from here so its import path stays put.
import {
  describeNumber,
  mapEngineError,
  parseFaultProfile,
  parseInjectEventInput,
  speedEcho,
} from './simulation-parse.js';

export { mapEngineError, parseInjectEventInput };
import type { MetricsCollector } from '../metrics.js';
import { assertQuota, type QuotaConfig } from '../quotas.js';
import type { ScenarioStore } from '../scenario-store.js';
import {
  LLM_PRESETS,
  type CreateSimulationOptions,
  type HibernatedSimulationRecord,
  type SimulationRecord,
  type SimulationRegistry,
  type SimulationSummary,
} from '../simulation-registry.js';
import { readTrajectoryDirRecords, readTrajectoryDirRecordsCounted, readTrajectoryRecords, readTrajectoryRecordsCounted, TRAJECTORY_RECORD_CAP } from '../trajectory-store.js';
import { readSimTimelineRecords, recordStepZoneSamples, SIM_TIMELINE_RECORD_CAP, type SimTimelineRecord } from '../sim-timeline.js';
import { SnapshotDeltaTracker, type SnapshotLike } from '../sim-stream-deltas.js';
import { readSimTimelineWithRollups, readTrajectoryWithRollups } from '../sim-registry/timeline-compactor.js';

export interface SimulationRoutesContext {
  registry: SimulationRegistry;
  store: ScenarioStore;
  envStore?: EnvironmentStore;
  serviceStore?: ServiceStore;
  /**
   * P2F (living-worlds §10.2): resolves fork membership for sandbox sims —
   * a joined builder/viewer reads the fork's world surfaces, a builder may
   * operate them. Optional so degenerate harnesses keep compiling (absent →
   * the fork gates degrade to the creator rule).
   */
  sandboxStore?: SandboxStore;
  /**
   * T-401 (DevLoop R19): resolves the device owner's display name for the
   * world-session command-gate's teaching 403. Optional for parity with the
   * other optional stores (tests may omit it — the gate then falls back to
   * the raw owner id).
   */
  userStore?: UserStore;
  /**
   * R46 (P0-2): the device-command org boundary's agreement carve-out — an
   * ACTIVE agreement whose consumer is the caller and whose provider agent
   * manages the device authorizes commanding it on env-backed sims (the
   * sanctioned cross-org lane for the rehearsal channel). Optional so
   * degenerate harnesses keep compiling (absent → the carve-out fail-closes).
   */
  agreementStore?: AgreementStore;
  /**
   * Fix-1: unified change recording. Required for device commands on
   * env-backed sims to land in command_log (replay-consumable).
   */
  pipeline?: ChangePipeline;
  /**
   * Wave-3a: per-simulation trajectory base dir — enables the eval-report
   * disk fallback (registry miss → rebuild from `<dir>/<simId>/`).
   */
  trajectoryBaseDir?: string;
  /** Wave-3a: reputation rows for the eval-report disk fallback. */
  reputationStore?: ReputationStore;
  /**
   * R2-BUG-04: world-session wake/catch-up seams for the generic sim routes.
   * The authoritative session (`record.envSession === true`) is wall-mapped
   * and lazy — these routes must not treat a frozen lazy clock as "running":
   * - the sim STREAM pins the session (observeOrMaterialize) so watching it
   *   wakes + fast-forwards the world, same as the env world stream;
   * - POST /start and POST /events route through targetFor (bounded catch-up)
   *   so the response/event lands at the wall-mapped now instead of the
   *   frozen moment.
   * Structural (duck-typed) so degenerate harnesses keep compiling; absent →
   * legacy behavior unchanged.
   */
  worldSessions?: {
    observeOrMaterialize(envId: string): Promise<() => void>;
    targetFor(envId: string): Promise<SimulationRecord | undefined>;
  };
  /** Snapshot cadence for the WebSocket stream, in simulated seconds. */
  snapshotEverySimSec: number;
  /**
   * T-007: stream heartbeat cadence (ms) — ping on a cycle, one missed pong
   * terminates the socket so a dead peer cannot hold a stream open forever.
   * Shares AGREEMENT_STREAM_HEARTBEAT_MS with the agreement stream.
   */
  streamHeartbeatMs: number;
  /** P4-4 quotas (running_sims_per_user enforced on create). */
  quotas: QuotaConfig;
  /** P4-4 metrics (simulation stream connection gauge). */
  metrics: MetricsCollector;
  /** Fix-42b: per-request cap on manual step ticks (EAF_MAX_STEP_TICKS). */
  maxStepTicks: number;
  /**
   * T-023: wall-clock bound on the agent-delivery wait of POST
   * /simulations/:id/events (EAF_EVENT_DELIVERY_DEADLINE_MS; 0 disables).
   * Past the bound the route returns 202 with decisionPending:true.
   */
  eventDeliveryDeadlineMs: number;
  /**
   * Fix-47: lowercase ADMIN_EMAILS — admins see every simulation in the list
   * and may control any simulation.
   */
  adminEmails: string[];
}

interface IdParams {
  id: string;
}

interface FaultParams {
  id: string;
  deviceId: string;
}

/** Event-batch flush cadence → a client receives at most ~10 messages/sec. */
const STREAM_FLUSH_MS = 100;

export function registerSimulationRoutes(
  app: FastifyInstance,
  ctx: SimulationRoutesContext,
): void {
  // T-007: live simulation-stream sockets keyed by sim id, so EVERY stop
  // path (stop / stopAndRemove / stopAndRemoveForEnvironment / stopAll /
  // retention prune) can end the stream deterministically — final snapshot,
  // then close(1001 'simulation stopped'). Without this a stopped runtime
  // leaves the socket open in permanent silence (the client cannot tell a
  // stopped sim from a dead connection). Same registry the agreement stream
  // uses for the identical Wave-6 problem.
  const streamSessions = new AgreementStreamSessions();
  ctx.registry.onSimulationStopped(record => {
    // S2 (device privacy): the terminal snapshot rides as an OBJECT — each
    // socket serializes it with its viewer-aware serializer, so the last
    // frame projects foreign devices exactly like every live frame did.
    streamSessions.closeForSimulation(
      record.id,
      { kind: 'snapshot', data: record.runtime.getSnapshot() },
    );
  });

  // optionalAuth comes from the legacy scope hook (server.ts); this route
  // only READS request.user for the environmentId access check.
  app.post('/api/simulations', async (request, reply) => {
    const body = (request.body ?? {}) as {
      scenarioId?: unknown;
      environmentId?: unknown;
      options?: unknown;
    };
    const hasScenarioId = typeof body.scenarioId === 'string' && body.scenarioId.length > 0;
    const hasEnvironmentId = typeof body.environmentId === 'string' && body.environmentId.length > 0;
    if (hasScenarioId === hasEnvironmentId) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Body must carry exactly one of "scenarioId" or "environmentId" (non-empty string)',
      );
    }
    // DevLoop (silent field drop): top-level unknown fields used to vanish —
    // the classic "I asked for speed:10 and got speed:1". Reject with the
    // accepted list + where speed actually lives, mirroring the options-key
    // rejection in parseCreateOptions.
    const knownTopLevel = new Set(['scenarioId', 'environmentId', 'zoneIds', 'options']);
    const unknownTopLevel = Object.keys(body).filter(key => !knownTopLevel.has(key));
    if (unknownTopLevel.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown top-level body field${unknownTopLevel.length > 1 ? 's' : ''}: ${unknownTopLevel.map(k => `"${k}"`).join(', ')}. ` +
          `Accepted: ${[...knownTopLevel].map(k => `"${k}"`).join(', ')}. ` +
          'Note: speed is set at start time (POST /api/simulations/:id/start {speed}), and can also be changed on pause/resume (POST /api/simulations/:id/resume {speed}).',
      );
    }
    const options = parseCreateOptions(body.options);

    // P4-4 quota: at most quotas.maxRunningSimsPerUser live (running/paused)
    // simulations per creator. Anonymous legacy creations carry no creator
    // and are not attributable, so they are not quota-checked.
    if (request.user) {
      assertQuota(
        'running_sims_per_user',
        ctx.quotas.maxRunningSimsPerUser,
        ctx.registry.countLiveByUser(request.user.id),
      );
    }

    let record;
    try {
      if (hasScenarioId) {
        const scenarioId = body.scenarioId as string;
        const stored = ctx.store.get(scenarioId);
        if (!stored) {
          throw new ApiError(404, 'SCENARIO_NOT_FOUND', `Scenario "${scenarioId}" not found`);
        }
        record = await ctx.registry.create(stored.definition, options, undefined, request.user?.id);
      } else {
        // P2a bridge: environment record → ScenarioDefinition. Access rule:
        // public environment, or any member (viewers may run demos).
        if (!ctx.envStore) {
          throw new ApiError(400, 'BAD_REQUEST', 'environmentId is not supported by this server');
        }
        const environmentId = body.environmentId as string;
        const env = ctx.envStore.getEnvironment(environmentId);
        if (!env) {
          throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${environmentId}" not found`);
        }
        const role = request.user ? ctx.envStore.roleOf(env.id, request.user.id) : undefined;
        if (env.visibility !== 'public' && role === undefined) {
          throw new ApiError(
            403,
            'FORBIDDEN',
            `Environment "${environmentId}" is private and you are not a member`,
          );
        }
        // Fix-43e: optional instance scope — `zoneIds: [...]` prunes the
        // bridged world to those zones (MMO "instance scoping"; a student's
        // sim of their claimed rooms costs like a standalone small world
        // instead of the full campus).
        const zoneIdsRaw = (body as { zoneIds?: unknown }).zoneIds;
        let zoneIds: string[] | undefined;
        if (zoneIdsRaw !== undefined) {
          if (!Array.isArray(zoneIdsRaw) || zoneIdsRaw.some(z => typeof z !== 'string')) {
            throw new ApiError(400, 'BAD_REQUEST', 'Body field "zoneIds" must be an array of zone id strings');
          }
          zoneIds = zoneIdsRaw as string[];
        }
        const scenario = environmentToScenario(
          env,
          ctx.envStore.devicesOf(env.id),
          ctx.envStore.agentsOf(env.id),
          ...(zoneIds !== undefined ? [{ zoneIds }] : []),
        );
        // Service-layer consistency (W3): warn about offers backed by no
        // bound device — brokering is legitimate, so never blocked.
        if (ctx.serviceStore) {
          const unbacked = environmentServiceWarnings(ctx.serviceStore, env);
          if (unbacked.length > 0) {
            request.log.warn(
              { environmentId: env.id, unbackedServices: unbacked },
              `${unbacked.length} service(s) in environment "${env.id}" are not backed by any bound device`,
            );
          }
        }
        record = await ctx.registry.create(scenario, options, env.id, request.user?.id, env.owner_id);
      }
    } catch (error) {
      throw mapEngineError(error);
    }
    return reply.code(201).send({
      id: record.id,
      scenarioId: record.scenarioId,
      ...(record.environmentId !== undefined ? { environmentId: record.environmentId } : {}),
      state: record.runtime.getState(),
      llm: record.llm,
      ...(record.llmModel !== undefined ? { llmModel: record.llmModel } : {}),
      ...(record.llmWarning !== undefined ? { llmWarning: record.llmWarning } : {}),
      scheduling: record.scheduling,
    });
  });

  // Fix-47 (越权修复): the list is scoped to the caller — it used to return
  // EVERY user's simulations and silently ignore ?environmentId=. Now:
  // - admin (ADMIN_EMAILS) sees everything;
  // - anyone else sees sims they created, sims of environments they are a
  //   member of, and creator-less legacy sims (transition semantics — an
  //   anonymous legacy creation belongs to no one);
  // - ?environmentId= narrows to one environment and requires read access to
  //   it (member or public env; admin bypasses) — 403 on a private env the
  //   caller is not a member of, 404 on an unknown env id.
  //
  // C5 (T-087, HO26-F06 — DevLoop R28): the list now ALSO surfaces each
  // env's authoritative world session marked `platformOwned: true` — the
  // deterministic `sim-<envId>-world-session` id was addressable but
  // invisible here (the R26 finding). Same visibility rule as every other
  // env-backed sim (members; the session is NOT creator-owned).
  app.get('/api/simulations', async request => {
    const query = request.query as Record<string, unknown>;
    // UX-03: unknown query params are a loud 400 (the T-063 convention) —
    // silent ignores stranded callers filtering by a param this route never
    // read. `envId` survives as a one-off compatibility alias for
    // `environmentId` (deprecation warn, response body unchanged); both given
    // and disagreeing is a teaching 400.
    const knownQuery = new Set(['environmentId', 'envId']);
    const unknownQuery = Object.keys(query).filter(key => !knownQuery.has(key));
    if (unknownQuery.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown query parameter${unknownQuery.length > 1 ? 's' : ''}: ` +
          `${unknownQuery.map(key => `"${key}"`).join(', ')}. ` +
          'GET /api/simulations takes exactly one optional query: ' +
          '?environmentId=<env id> (narrow the list to one environment).',
      );
    }
    const envIdAlias = optionalQueryString(query.envId, 'envId');
    let environmentId = optionalQueryString(query.environmentId, 'environmentId');
    if (envIdAlias !== undefined) {
      if (environmentId !== undefined && environmentId !== envIdAlias) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Query parameters "envId" and "environmentId" name different environments — ' +
            'pass only ?environmentId=<env id> ("envId" is a deprecated alias).',
        );
      }
      request.log.warn(
        { envId: envIdAlias },
        'GET /api/simulations: query "envId" is a deprecated alias — use "environmentId"',
      );
      environmentId = envIdAlias;
    }
    const user = request.user;
    const all = ctx.registry.listIncludingEnvSessions();

    // T52 (R6, u1-F6): the roster carries the creator's DISPLAY NAME beside
    // the id — a bare createdBy uuid told the other members nothing about
    // whose sim each row is (the "whose sim is which" workaround was one
    // me/overview probe per row). Read-only enrichment; absent createdBy →
    // absent name (legacy anonymous creations stay anonymous).
    const creatorNames = new Map<string, string>();
    const creatorNameOf = (createdBy: string | undefined): string | undefined => {
      if (createdBy === undefined) return undefined;
      if (!creatorNames.has(createdBy)) {
        creatorNames.set(createdBy, ctx.userStore?.findById(createdBy)?.display_name ?? createdBy);
      }
      return creatorNames.get(createdBy);
    };
    const withCreatorNames = (sims: ReturnType<typeof ctx.registry.listIncludingEnvSessions>) =>
      sims.map(sim => {
        const creatorName = creatorNameOf(sim.createdBy);
        return creatorName !== undefined ? { ...sim, creatorName } : sim;
      });

    if (environmentId !== undefined) {
      if (!ctx.envStore) {
        throw new ApiError(400, 'BAD_REQUEST', 'environmentId is not supported by this server');
      }
      const env = ctx.envStore.getEnvironment(environmentId);
      if (!env) {
        throw new ApiError(404, 'ENVIRONMENT_NOT_FOUND', `Environment "${environmentId}" not found`);
      }
      if (!isAdmin(ctx, user)) {
        const role = user ? ctx.envStore.roleOf(env.id, user.id) : undefined;
        requireReadAccess(env, role);
      }
      return { simulations: withCreatorNames(all.filter(sim => sim.environmentId === environmentId)) };
    }

    if (isAdmin(ctx, user)) return { simulations: withCreatorNames(all) };
    return { simulations: withCreatorNames(all.filter(sim => isVisibleSummary(ctx, sim, user))) };
  });

  app.get('/api/simulations/:id/snapshot', async request => {
    const { id } = request.params as IdParams;
    // Living-worlds P0: a hibernated sim has no runtime — a teaching 409, not
    // a misleading 404 (the world exists, frozen in its checkpoint).
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationReadAccess(ctx, record, request.user);
    const snapshot = record.runtime.getSnapshot();
    // Fix-45b: the snapshot carries the LLM context too (mode/model/warning)
    // so the UI's LlmStatusBar and API consumers see the same story the
    // create/list responses tell — no separate lookup needed.
    // S2 (device privacy): env-backed sims (incl. the authoritative world
    // session) project their device entries through the canonical seam —
    // members see coarse (identity + on/off-or-present) for foreign devices;
    // readings/parameter payloads are service-layer data. Pure scenario sims
    // have no tenant devices and pass through untouched.
    const projected = projectSnapshotForViewer(ctx, record, request.user, snapshot);
    return {
      ...projected,
      llmMode: record.llm,
      ...(record.llmModel !== undefined ? { llmModel: record.llmModel } : {}),
      ...(record.llmWarning !== undefined ? { llmWarning: record.llmWarning } : {}),
    };
  });

  app.get('/api/simulations/:id/trajectory', async request => {
    const { id } = request.params as IdParams;
    // Living-worlds P0: a hibernated sim's DECISION history stays readable —
    // the trajectory log is on disk under the checkpoint; only the runtime
    // is gone. P2: the log is size-segmented — the dir read stitches legacy
    // file + segments transparently.
    const hibernated = ctx.registry.getHibernated(id);
    if (hibernated !== undefined) {
      assertHibernatedReadAccess(ctx, hibernated, request.user);
      const read = await readTrajectoryWithRollups(hibernated.trajectoryDir, TRAJECTORY_RECORD_CAP);
      if (read.records.length === 0) {
        return { records: read.records, note: emptyTrajectoryNote(id) };
      }
      return trajectoryGrainBody(read);
    }
    const record = ctx.registry.getOrThrow(id);
    assertSimulationReadAccess(ctx, record, request.user);
    const query = request.query as Record<string, unknown>;
    const eventId = optionalQueryString(query.eventId, 'eventId');
    const agentId = optionalQueryString(query.agentId, 'agentId');
    // null = recording off for this sim (created before W8, or a registry
    // without a trajectory base dir) — defined as "no records".
    const filePath = record.runtime.getTrajectoryFilePath();
    if (filePath === null) {
      return {
        records: [] as Awaited<ReturnType<typeof readTrajectoryRecords>>,
        note: emptyTrajectoryNote(id),
      };
    }
    // P2: prefer the whole dir (all segments + legacy file); the single-file
    // path would only ever see the ACTIVE segment. record.trajectoryDir is
    // set whenever the recorder exists (default base dir or explicit
    // options.trajectoryDir override). Queries with filters stay raw-only
    // (rollup aggregates cannot answer eventId/agentId filters honestly).
    if (eventId !== undefined || agentId !== undefined) {
      // R81-D2 (R44-extreme-F2): counted read — totalCount/truncated expose the cap.
      const filter = {
        ...(eventId !== undefined ? { eventId } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
      };
      const counted = record.trajectoryDir !== undefined
        ? await readTrajectoryDirRecordsCounted(record.trajectoryDir, filter)
        : await readTrajectoryRecordsCounted(filePath, filter);
      if (counted.records.length === 0) return { records: counted.records, note: emptyTrajectoryNote(id) };
      return {
        records: counted.records,
        grain: 'raw',
        totalCount: counted.totalCount,
        ...(counted.totalCount > counted.records.length ? { truncated: true } : {}),
      };
    }
    const read = record.trajectoryDir !== undefined
      ? await readTrajectoryWithRollups(record.trajectoryDir, TRAJECTORY_RECORD_CAP)
      : await (async () => {
          const c = await readTrajectoryRecordsCounted(filePath, { cap: TRAJECTORY_RECORD_CAP });
          return {
            records: c.records as unknown[],
            grain: 'raw' as const,
            rawCount: c.records.length,
            rollupCount: 0,
            rollupFiles: [] as string[],
            totalRawCount: c.totalCount,
          };
        })();
    if (read.records.length === 0) return { records: read.records, note: emptyTrajectoryNote(id) };
    return trajectoryGrainBody(read);
  });

  // T-005: the sim-side timeline — zone-parameter samples + device state
  // changes from `<trajectoryDir>/sim-timeline/` (P2 segmented). /trajectory
  // carries only agent decisions and is EMPTY for rule-only sims; this is
  // where the physical timeline of the run lives (Fix-14 capture,
  // replay-source data). Living-worlds P2: reads prefer RAW records and fall
  // back to minute-grain ROLLUPS for history older than the raw window —
  // `grain` labels which served (rollup records carry kind 'rollup-1m').
  // Registry-scoped like /snapshot: a post-restart registry miss is 404 (the
  // eval-report route owns the disk-fallback rebuild). sims without a
  // trajectory dir (recording off / legacy scenario sims) answer an honest
  // `{ records: [] }` with a note.
  app.get('/api/simulations/:id/timeline', async request => {
    const { id } = request.params as IdParams;
    // Living-worlds P0: a hibernated sim's sim-timeline stays readable —
    // the segmented log lives on disk next to the checkpoint.
    const hibernated = ctx.registry.getHibernated(id);
    if (hibernated !== undefined) {
      assertHibernatedReadAccess(ctx, hibernated, request.user);
      const read = await readSimTimelineWithRollups(hibernated.trajectoryDir, SIM_TIMELINE_RECORD_CAP);
      return timelineResponse(ctx, hibernated, request.user, read);
    }
    const record = ctx.registry.getOrThrow(id);
    assertSimulationReadAccess(ctx, record, request.user);
    if (record.trajectoryDir === undefined) {
      return {
        records: [] as Awaited<ReturnType<typeof readSimTimelineRecords>>,
        note: 'No trajectory recording for this simulation — the sim-side timeline (zone samples + device state changes) is captured only for simulations with a trajectory directory',
      };
    }
    const read = await readSimTimelineWithRollups(record.trajectoryDir, SIM_TIMELINE_RECORD_CAP);
    return timelineResponse(ctx, record, request.user, read);
  });

  // Fix-8: AC collaboration query. One row per (collaboration, agent-view):
  // the initiator's row exists from proposal time (status 'pending'), the
  // accepting partner's row appears after it joins; terminal sessions
  // (completed/failed/cancelled) come from history. Handshake semantics: a
  // proposal stays 'pending' until every requested partner responds or the
  // handshake timeout (120s) elapses — then it is cancelled.
  app.get('/api/simulations/:id/collaborations', async request => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationReadAccess(ctx, record, request.user);
    const query = request.query as Record<string, unknown>;
    const agentId = optionalQueryString(query.agentId, 'agentId');
    const status = optionalQueryString(query.status, 'status');
    let collaborations = record.runtime.getCollaborations();
    if (agentId !== undefined) {
      collaborations = collaborations.filter(c => c.agentId === agentId);
    }
    if (status !== undefined) {
      collaborations = collaborations.filter(c => c.status === status);
    }
    return { collaborations };
  });

  // Fix-22 (评估钩子): decision-quality metrics for a finished (or live)
  // simulation — pure aggregation over the trajectory JSONL and the runtime's
  // reputation tracker (Fix-12 effect rechecks land there); no new execution
  // path. Read-only, same open access as /trajectory. Wave-3a: a registry
  // miss falls back to rebuilding from the on-disk trajectory dir (source
  // 'disk'; registry-only fields degrade honestly, see eval-report.ts).
  app.get('/api/simulations/:id/eval-report', async request => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.get(id);
    if (!record) {
      if (ctx.trajectoryBaseDir === undefined) {
        throw new ApiError(404, 'SIMULATION_NOT_FOUND', `Simulation "${id}" not found`);
      }
      const disk = await loadDiskEvalReport(
        {
          trajectoryBaseDir: ctx.trajectoryBaseDir,
          ...(ctx.reputationStore !== undefined ? { reputationStore: ctx.reputationStore } : {}),
        },
        id,
      );
      if (!disk) {
        throw new ApiError(404, 'SIMULATION_NOT_FOUND', `Simulation "${id}" not found`);
      }
      // T-015: the disk fallback follows the same env read gate as the
      // registry path — an unguessable simId must not resurrect a private
      // env's metrics after a restart.
      assertDiskEvalReportReadAccess(ctx, disk, request.user);
      return disk;
    }
    assertSimulationReadAccess(ctx, record, request.user);
    const filePath = record.runtime.getTrajectoryFilePath();
    // P2: dir read stitches every segment (the single filePath would only
    // see the active one); the null check stays the "recording off" signal.
    const records =
      filePath === null
        ? []
        : record.trajectoryDir !== undefined
          ? await readTrajectoryDirRecords(record.trajectoryDir, { cap: EVAL_REPORT_MAX_RECORDS })
          : await readTrajectoryRecords(filePath, { cap: EVAL_REPORT_MAX_RECORDS });

    const metrics = aggregateEvalRecords(records, record.runtime.getReputationJSON().records);
    return {
      simId: record.id,
      scenarioId: record.scenarioId,
      ...(record.environmentId !== undefined ? { environmentId: record.environmentId } : {}),
      source: 'registry',
      state: record.runtime.getState(),
      simTimeSec: record.runtime.getSimTimeSec(),
      // R100: R40-B2 face; registry-only. T29 (R3, PM ruling): the face is
      // FIXED to the tracker's ALL-HISTORY window — rows are never
      // overwritten by this report's window values; the window rides
      // windowDecisionCount / window / smallSample instead (decisions panel
      // = report window; the two are different sources, never additive).
      metaAgents: reconcileMetaAgents(
        record.runtime.getMetaCognitionSummaries(),
        metrics.decisions.perAgent,
        // R103 (chen-21): deleted/missing agents render as "已删除 Agent
        // (短 id)", never a bare UUID in the eval face.
        agentId => ctx.envStore?.getAgent(agentId)?.name,
      ),
      ...metrics,
    };
  });

  app.post('/api/simulations/:id/start', async request => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    const runtime = record.runtime;
    const speed = (request.body as { speed?: unknown } | undefined)?.speed;
    if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0)) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "speed" must be a number > 0, got ${describeNumber(speed)}`);
    }
    // TASK-016 (DevLoop): /start is the ONLY transition into 'live' (created→running;
    // resume is paused→running with no net change). The create-time check counts
    // only running|paused, so parallel creates all pass — enforcement here closes
    // the gap. Keep this check SYNCHRONOUSLY adjacent to start() — no await in
    // between — so concurrent starts serialize under Node's event loop and the
    // limit is exact. Count by creator (the quota belongs to the creator even
    // when an env owner/builder starts the sim).
    if (runtime.getState() === 'created' && record.createdBy !== undefined) {
      assertQuota('running_sims_per_user', ctx.quotas.maxRunningSimsPerUser,
        ctx.registry.countLiveByUser(record.createdBy));
    }
    // R2-BUG-04: /start on the authoritative world session routes to the
    // session service (wake + bounded catch-up to wall-now) — a bare
    // runtime.start() on the running lazy runtime was a fake 200
    // ({state:'running'} while the clock sat frozen). Non-sessions unchanged.
    const sessionStarted = await startWorldSessionIfAny(app, record, speed);
    if (sessionStarted !== undefined) {
      return { ...sessionStarted, ...speedEcho(record) };
    }
    try {
      // Living-worlds P1: lazy sims enter 'running' WITHOUT the tick timer —
      // the registry's due-moment driver owns advancement (wake it now so
      // the first due moment is evaluated immediately, not at the next
      // recheck poll).
      if (record.scheduling === 'lazy') {
        runtime.start(speed, { lazy: true });
        ctx.registry.wakeLazyDriver(id);
      } else {
        runtime.start(speed);
      }
    } catch (error) {
      throw mapEngineError(error);
    }
    return { id, state: runtime.getState(), ...speedEcho(record) };
  });

  app.post('/api/simulations/:id/pause', async request => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    assertWorldSessionPausable(record);
    const runtime = record.runtime;
    runtime.pause(); // no-op unless running
    return { id, state: runtime.getState() };
  });

  // Living-worlds P0 (design-living-worlds.md §9): freeze the world into a
  // versioned checkpoint under the sim's trajectory dir and release the
  // runtime — zero timers, zero subscriptions, zero heap. SIM_CLOCK sims
  // only; real-device (hass://) surfaces are refused with a teaching
  // message (obligation worlds stay HOT). The sim id, history and timeline
  // continue at resume (POST /:id/resume).
  app.post('/api/simulations/:id/hibernate', async request => {
    const { id } = request.params as IdParams;
    // Idempotent: an already-hibernated sim returns its existing freeze.
    const already = ctx.registry.getHibernated(id);
    if (already !== undefined) {
      assertHibernatedControl(ctx, already, request.user);
      return {
        id,
        state: 'hibernated' as const,
        simTimeSec: already.checkpoint.simTimeSec,
        hibernatedAt: already.hibernatedAt,
        checkpoint: already.checkpoint,
      };
    }
    const record = ctx.registry.getOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    // R6-A-F01: freezing a WORLD SESSION here adopts the freeze into the
    // WorldSessionService too (hibernated view + checkpoint metadata on the
    // env detail, docs/deployment.md §6) — see simulations-world-session.ts.
    const hibernated = await hibernateWithSessionAdoption(app, ctx.registry, record);
    return {
      id,
      state: 'hibernated' as const,
      simTimeSec: hibernated.checkpoint.simTimeSec,
      hibernatedAt: hibernated.hibernatedAt,
      checkpoint: hibernated.checkpoint,
    };
  });

  app.post('/api/simulations/:id/resume', async request => {
    const { id } = request.params as IdParams;
    // Body contract is shared by both resume flavors (see below).
    const speed = (request.body as { speed?: unknown } | undefined)?.speed;
    if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0)) {
      throw new ApiError(400, 'BAD_REQUEST', `Body field "speed" must be a number > 0, got ${describeNumber(speed)}`);
    }
    // Living-worlds P0: hibernated → running. Rebuild the runtime from the
    // checkpoint (same sim id, history appended, deterministic world state)
    // and start it at the checkpointed (or requested) speed. Quota: a
    // hibernated sim stopped counting when it froze; resuming is a return to
    // live state, so it re-enters the same running_sims_per_user budget a
    // fresh /start would (TASK-016's gap-closing, applied to the new path).
    const hibernated = ctx.registry.getHibernated(id);
    if (hibernated !== undefined) {
      assertHibernatedControl(ctx, hibernated, request.user);
        // R37-F1: a HIBERNATED WORLD SESSION wakes on CURRENT env rows via the world-session service.
      const session = await resumeWorldSessionIfAny(app, hibernated);
      if (session !== undefined) return session;
      if (hibernated.createdBy !== undefined) {
        assertQuota('running_sims_per_user', ctx.quotas.maxRunningSimsPerUser,
          ctx.registry.countLiveByUser(hibernated.createdBy));
      }
      const record = await ctx.registry.resumeHibernated(id, {
        ...(speed !== undefined ? { speed } : {}),
      });
      return { id, state: record.runtime.getState(), simTimeSec: record.runtime.getSimTimeSec(), ...speedEcho(record) };
    }
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    const runtime = record.runtime;
    // DevLoop (silent field drop): /resume used to ignore its body entirely —
    // `{speed: 4}` vanished without a trace. Accept the same optional speed
    // contract as /start (validated identically) so pace can be retargeted
    // while the sim is frozen.
    // T43: a RUNNING sim with an explicit speed retargets in place — speed
    // is a property, not a lifecycle transition (no pause detour, no *-mbt
    // edge), and the response says so instead of silently dropping it.
    let speedRetargeted = false;
    try {
      if (speed !== undefined && runtime.getState() === 'running') {
        runtime.retargetSpeed(speed);
        speedRetargeted = true;
      } else {
        runtime.resume(speed); // no-op unless paused; lazy mode is sticky
      }
      // Living-worlds P1: a lazy sim's driver re-evaluates its due set at
      // once on resume (not at the next recheck poll).
      if (record.scheduling === 'lazy') {
        ctx.registry.wakeLazyDriver(id);
      }
    } catch (error) {
      // Engine bounds (e.g. speed > MAX_SPEED) map to a 400 like /start.
      throw mapEngineError(error);
    }
    return {
      id,
      state: runtime.getState(),
      ...speedEcho(record),
      ...(speedRetargeted ? { speedRetargeted: true as const, speed } : {}),
    };
  });

  app.post('/api/simulations/:id/stop', async request => {
    const { id } = request.params as IdParams;
    // Living-worlds P0: stopping a hibernated sim discards it (record +
    // registry-managed disk) — a frozen world has no runtime to stop, and
    // "stopped" is final either way.
    const hibernated = ctx.registry.getHibernated(id);
    if (hibernated !== undefined) {
      assertHibernatedControl(ctx, hibernated, request.user);
      ctx.registry.discardHibernated(id);
      return { id, state: 'stopped' as const };
    }
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    // R37-F1: /stop on the world session routes to FREEZE semantics (a plain
    // stop leaves a husk wedged behind WORLD_SESSION_EXISTS); others unchanged.
    const session = await stopWorldSessionIfAny(app, ctx.registry, record);
    if (session !== undefined) return session;
    // registry.stop persists learned reputation (env-backed sims, P4-1),
    // then stops the runtime; idempotent, record stays queryable afterwards.
    ctx.registry.stop(id);
    return { id, state: record.runtime.getState() };
  });

  app.post('/api/simulations/:id/step', async request => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    const runtime = record.runtime;
    const body = (request.body ?? {}) as { n?: unknown; toSimTimeSec?: unknown };
    // S1 (strict body): unknown fields are rejected 400 instead of being
    // silently dropped — {"ticks": 100} used to return 200 while stepping
    // exactly 1 tick, teaching the caller a lie. Same contract as
    // POST /api/environments and the eval-runs parser: the error names the
    // rejected fields AND the accepted ones.
    const stepUnknownFields = Object.keys(body as Record<string, unknown>)
      .filter(key => key !== 'n' && key !== 'toSimTimeSec');
    if (stepUnknownFields.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Unknown step field${stepUnknownFields.length > 1 ? 's' : ''}: ` +
          `${stepUnknownFields.map(f => `"${f}"`).join(', ')}. ` +
          'Accepted fields: "n" (tick count, default 1) or "toSimTimeSec" (absolute sim-time target) — ' +
          'unknown fields are rejected, never silently dropped',
      );
    }
    let n: number;
    if (body.toSimTimeSec !== undefined) {
      // Fix-10: advance to an absolute simulation time. Mutually exclusive
      // with `n`; the tick count is derived from the runtime's speed (sim
      // seconds per tick), so the landing point may overshoot the target by
      // less than one speed step.
      if (body.n !== undefined) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          'Body fields "n" and "toSimTimeSec" are mutually exclusive',
        );
      }
      const target = body.toSimTimeSec;
      if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "toSimTimeSec" must be a finite number > 0, got ${describeNumber(target)}`,
        );
      }
      const current = runtime.getSimTimeSec();
      if (target <= current) {
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `Body field "toSimTimeSec" (${target}) must be greater than the current simTimeSec (${current})`,
        );
      }
      n = Math.ceil((target - current) / runtime.getSnapshot().speed);
    } else {
      const raw = body.n ?? 1;
      if (!Number.isInteger(raw) || (raw as number) < 1) {
        throw new ApiError(400, 'BAD_REQUEST', `Body field "n" must be a positive integer, got ${JSON.stringify(raw)}`);
      }
      n = raw as number;
    }
    // Fix-42b: one oversized step request must not monopolize the host
    // (E2E 2026-08-15: a single large step froze the whole API ≥465s). The
    // engine yields between tick chunks, and this cap bounds the batch.
    if (n > ctx.maxStepTicks) {
      const projected = Math.round(n * runtime.getSnapshot().speed);
      throw new ApiError(
        422,
        'STEP_TOO_LARGE',
        `Refusing to run ${n} ticks (~${projected} sim-s) in one request: the per-request cap is ` +
          `${ctx.maxStepTicks} ticks. Step in chunks of ≤${ctx.maxStepTicks} — chunked stepping keeps ` +
          `the API responsive while advancing the same total time` +
          (record.envSession === true
            ? ` — or express the catch-up DESTINATION directly with {"toSimTimeSec": <target>} ` +
              '(world sessions are wall-anchored; naming the target beats counting ticks)'
            : '') +
          ' — or have the operator raise EAF_MAX_STEP_TICKS.',
      );
    }
    try {
      await runtime.step(n);
    } catch (error) {
      throw mapEngineError(error);
    }
    // T-101 (DevLoop R32, F-PH23): the wall-clock zone sampler cannot fire
    // while paused — a stepped sim advanced sim time (physics moved) with no
    // zone-sample landing in the timeline. Drive the manual sampler lane
    // (cadence-gated internally; sims without a sampler are a no-op).
    recordStepZoneSamples(id);
    // T-507 (EC24-F07/F08) teaching, world sessions only: `n` counts TICKS
    // (n × speed sim-s, per-request capped) while toSimTimeSec names the
    // catch-up TARGET — at low compression rates a large n is a small
    // sim-time jump, and the wall-anchored clock keeps running between
    // calls. Verified in-dev (R24): stepping is monotone and never clamped
    // by the wall anchor — the felt divergence is these semantics, so they
    // ride the response. `n`-as-ticks itself is the shared step contract
    // (WONT_FIX ruling) and is unchanged.
    return {
      id, state: runtime.getState(), simTimeSec: runtime.getSimTimeSec(),
      ...(record.envSession === true
        ? {
            stepSemantics: {
              n: `ticks: ${n} × ${runtime.getSnapshot().speed} sim-s per tick ` +
                `(per-request cap ${ctx.maxStepTicks} ticks) — n is NOT sim-seconds`,
              toSimTimeSec: 'the absolute catch-up target in sim-s — preferred for large jumps',
              liveClock: 'this world session is wall-anchored: sim time also advances between your calls',
            },
          }
        : {}),
    };
  });

  app.post('/api/simulations/:id/events', async (request, reply) => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.getLiveOrThrow(id);
    // Fix-13 (R5 F-05): injecting an event mutates simulation state just like
    // a device command, so the Fix-4 rule applies here too — viewers are
    // read-only end to end and get the same 403 as /commands. (This route
    // stays on the legacy optionalAuth scope; only the viewer role is gated.)
    if (record.environmentId !== undefined && ctx.envStore && request.user) {
      assertNotViewer(
        record.environmentId,
        ctx.envStore.roleOf(record.environmentId, request.user.id),
        'event injection requires role "builder" | "owner"',
      );
    }
    // Fix-47: same control gate as the lifecycle ops — a stranger (or an
    // anonymous caller) must not inject events into somebody else's sim.
    assertSimulationControl(ctx, record, request.user);
    const runtime = record.runtime;
    const input = parseInjectEventInput(request.body);
    // R2-BUG-04: injecting into the wall-mapped world session used to land
    // the event at the FROZEN lazy clock (200 while sim time never advanced)
    // — route the arrival through the session service first (wake + catch up
    // to wall-now, bounded by the T129 sync cap; a longer backlog keeps
    // fast-forwarding in the background). Warn-only degrade: when the session
    // service is unavailable the legacy direct injection still runs.
    if (record.envSession === true && record.environmentId !== undefined && ctx.worldSessions !== undefined) {
      await ctx.worldSessions.targetFor(record.environmentId);
    }
    // T66i (R6, u3-P3-5): an event type this world never declared (and no
    // scheduled/sim event ever used) is broadcast verbatim — the physics
    // derives defaults and the bus carries it — but "照单全收" used to look
    // like a recognized type. The 202/200 response now says so honestly.
    // Behavior unchanged; only the echo names the guess.
    const declaredTypes = new Set<string>([
      ...record.scenario.events.map(event => event.type),
    ]);
    const unrecognizedType = !declaredTypes.has(input.type);
    try {
      // T-023: bound the agent-delivery wait (EAF_EVENT_DELIVERY_DEADLINE_MS,
      // default 10s; 0 disables) — the physical write and flow evaluation
      // are already applied when the bound fires, so 202 decisionPending is
      // the honest answer instead of holding the HTTP request (and its
      // connection) for the full multi-second LLM decision latency.
      const result = await runtime.injectEvent(input, {
        ...(ctx.eventDeliveryDeadlineMs > 0
          ? { deliveryDeadlineMs: ctx.eventDeliveryDeadlineMs }
          : {}),
        // R102: the injector's display label rides the event's audit record.
        // Anonymous injection (legacy non-env sims, no auth) is honestly
        // 'anonymous' — request.user is null (not undefined) on this route.
        injectedBy: request.user
          ? ctx.userStore?.findById(request.user.id)?.display_name ?? request.user.id
          : 'anonymous',
        // T33 (R3 u3-F3): the injector's ACCOUNT id — the audit row's actor
        // must resolve to the real user in the activity feed, not a label.
        ...(request.user ? { injectedById: request.user.id } : {}),
      });
      const warning = unrecognizedType
        ? `未识别的事件类型 "${input.type}"：本世界的场景未声明该类型——已按原样广播（物理默认值已推导）。`
        : undefined;
      if (result.decisionPending) {
        return reply.code(202).send(warning !== undefined ? { ...result, warning } : result);
      }
      return warning !== undefined ? { ...result, warning } : result;
    } catch (error) {
      throw mapEngineError(error);
    }
  });

  // Fix-1: device commands are authenticated and authorized (anonymous →
  // 401; see the access check inside the handler), executed commands on
  // env-backed sims are audited in command_log as `device-command`.
  app.post(
    '/api/simulations/:id/commands',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as IdParams;
      const user = request.user!;
      const record = ctx.registry.getLiveOrThrow(id);
      const runtime = record.runtime;

      // Access (Fix-1 + Fix-4): an environment-backed simulation follows the
      // environment's membership — owner/builder may control its devices;
      // viewers are READ-ONLY end to end (Fix-4): they may create and watch
      // simulations but every write, including device commands, is 403. A
      // legacy scenario sim belongs to its creator; creator-less legacy sims
      // stay usable by any authenticated user (transition semantics).
      // T-401 (R19): admins bypass the membership rule — the world-session
      // ownership gate (device-command-gates.ts) deliberately admits admins
      // (isAdmin parity with every other control surface). R46 (P0-2): that
      // Fix-47 admin override ("may control any simulation") now also covers
      // the creator-only rule — an admin commanding a device on somebody
      // else's env-backed sim used to fall into the else-if and 403.
      if (record.environmentId !== undefined && ctx.envStore && !isAdmin(ctx, user)) {
        const role = ctx.envStore.roleOf(record.environmentId, user.id);
        if (role === undefined) {
          throw new ApiError(
            403,
            'FORBIDDEN',
            `Environment "${record.environmentId}" requires membership to control its devices`,
          );
        }
        assertNotViewer(
          record.environmentId,
          role,
          'device commands require role "builder" | "owner"',
        );
      } else if (
        !isAdmin(ctx, user) &&
        record.createdBy !== undefined &&
        record.createdBy !== user.id
      ) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'Only the simulation creator may send device commands to it',
        );
      }

      const body = (request.body ?? {}) as {
        deviceId?: unknown;
        commandName?: unknown;
        params?: unknown;
      };
      if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "deviceId" must be a non-empty string');
      }
      if (typeof body.commandName !== 'string' || body.commandName.length === 0) {
        // TASK-004: catch the common rename trap before the generic error.
        if (typeof (body as Record<string, unknown>).command === 'string') {
          throw new ApiError(
            400, 'BAD_REQUEST',
            'Body field "command" is not recognized — did you mean "commandName"?',
          );
        }
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "commandName" must be a non-empty string');
      }
      if (body.params !== undefined &&
        (typeof body.params !== 'object' || body.params === null || Array.isArray(body.params))) {
        throw new ApiError(400, 'BAD_REQUEST', 'Body field "params" must be an object when provided');
      }
      // TASK-004: catch payload→params rename trap.
      // T-001 (DevLoop): `args` is another common name for `params` — without
      // the hint the command would run with NO parameters (set-brightness
      // without a level silently no-ops) instead of telling the caller.
      if (body.params === undefined) {
        for (const alias of ['payload', 'args']) {
          const aliasValue = (body as Record<string, unknown>)[alias];
          if (typeof aliasValue === 'object' && aliasValue !== null) {
            throw new ApiError(
              400, 'BAD_REQUEST',
              `Body field "${alias}" is not recognized — did you mean "params"?`,
            );
          }
        }
      }
      const deviceId = body.deviceId;
      const commandName = body.commandName;
      const params = body.params as Record<string, unknown> | undefined;


      // Ownership gates (Fix-9 hass://, T-401 world-session, R46 P0-2 org
      // boundary) — split out at the arch-guard size ceiling; see
      // device-command-gates.ts for the semantics and their deliberate
      // order. Admins skip gates 2–3 (Fix-47) but never gate 1 (real
      // hardware has no admin override).
      // R49: a DENIED cross-org attempt is audited before the 403 — the
      // trust loop (governance + reputation) needs the negative samples
      // too, and an owner reviewing "who tried to touch my devices" is a
      // governance surface, not just an error path.
      try {
        assertDeviceCommandGates(ctx, record, user, deviceId, isAdmin(ctx, user));
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 403) {
          if (record.environmentId !== undefined && ctx.pipeline) {
            ctx.pipeline.log({
              envId: record.environmentId,
              actorId: user.id,
              kind: 'device-command-denied',
              payload: { deviceId, commandName, reason: error.message },
              simTime: runtime.getSimTimeSec(),
            });
          }
        }
        throw error;
      }

      // T80 (R9, u2-F1): the sim command lane runs the ONE command-equivalence
      // judgment — `resolveCommandEquivalence` against the device's executable
      // face (the snapshot `commands` list, the same "declared = executable"
      // vocabulary the agent NL filter, the what-if fork gate and the Web UI
      // device console already speak). A command that is neither verbatim on
      // the face nor resolves to a face member (temperature-family ask on a
      // temperature-setting face) is NOT supported by this device: reject with
      // the UNKNOWN_COMMAND family error, audit the refusal, and never
      // dispatch. The old path admitted any handler-claimed spelling
      // ('temperature-control' on a monitoring-only sensor), executed it, and
      // dressed the sensor reading up as a control result — a fake success.
      const deviceFace = runtime.getSnapshot().devices.find(device => device.id === deviceId)?.commands;
      // An unknown device skips this gate entirely — it must keep reaching the
      // engine path's honest 404 DEVICE_NOT_FOUND / 409 DEVICE_NOT_MANAGED
      // split (the fix-1 semantics the tests pin), not a 400 about commands.
      if (deviceFace !== undefined && resolveCommandEquivalence(commandName, deviceFace) === undefined) {
        // Failure metering (R49 negative samples): the refused attempt lands
        // in the audit lane as a denial — the same kind the ownership gates
        // use — so "who tried what on my device" stays answerable.
        if (record.environmentId !== undefined && ctx.pipeline) {
          ctx.pipeline.log({
            envId: record.environmentId,
            actorId: user.id,
            kind: 'device-command-denied',
            payload: {
              deviceId,
              commandName,
              reason: `command "${commandName}" is not on the device's executable face`,
            },
            simTime: runtime.getSimTimeSec(),
          });
        }
        throw new ApiError(
          400,
          'UNKNOWN_COMMAND',
          `Device "${deviceId}" does not expose command "${commandName}" — its command surface: ` +
            (deviceFace.length > 0
              ? deviceFace.join(', ')
              : '(none — its declared capabilities match no command handler)'),
        );
      }

      const deviceExists = (): boolean =>
        runtime.getSnapshot().devices.some(device => device.id === deviceId);
      const deviceState = (): Record<string, unknown> | null =>
        runtime.getSnapshot().devices.find(device => device.id === deviceId)?.state ?? null;
      const before = deviceState();

      try {
        // P3b: attach the caller's identity so the safety gate records WHO
        // asked (engine-initiated actuation stays user-less). A 'confirm'
        // decision surfaces as 202 + pendingId — a parked command is NOT an
        // error and must be distinguishable from an executed one.
        //
        // T-034 + R17 params-purity fix: the same identity rides the
        // invocation CONTEXT (`options.actor`), NOT `params` — the T-034 wave
        // stamped it into params.actor for lock/display audit (accessLog.by,
        // contentSetBy), which T-039 then carried verbatim into timeline
        // device-state records, breaking the T-019 replay contract that
        // params are the command's pure semantic arguments. Attribution now
        // flows route → runtime → device → handler as dedicated context and
        // lands on the timeline record's top-level `actor` field.
        const outcome = await runWithActuationUser(user.id, () =>
          runtime.executeDeviceCommand(deviceId, commandName, params, { actor: user.displayName }),
        );
        const pendingId = pendingConfirmationId(outcome);
        if (pendingId !== undefined) {
          // 202 soft-block: NOT the S3 success path — the parked command's
          // device-level outcome is success:false (distinguishable from an
          // executed command), so this body keeps the engine's shape plus
          // the pending markers (hass-safety tests pin it).
          return reply.code(202).send({ ...outcome, pending: true, pendingId });
        }

        // T70 (R8, u1-F2): the coordinator now surfaces the DEVICE-level
        // verdict at its own level — a failed command arrives here as
        // `{success:false, result:{success:false, error, result?:{code}}}`
        // instead of hiding behind a top-level success. The device-failure
        // mapping (unknown command → 400 UNKNOWN_COMMAND, other device
        // failures → single-layer `{success:false, error, code?}`) must run
        // BEFORE the request-level heuristics below: the device's own
        // "Command … not found" message would otherwise be mistaken for a
        // missing DEVICE (404), and the gate's `code` markers (POLICY_DENIED
        // / RATE_LIMITED / ESTOP_ACTIVE) would be dropped.
        const deviceFailure = unwrapDeviceFailure(outcome);
        if (deviceFailure !== null) {
          if (/Command .+ not found/.test(deviceFailure.error)) {
            throw new ApiError(
              400,
              'UNKNOWN_COMMAND',
              `Device "${deviceId}" has no command "${commandName}"`,
            );
          }
          return {
            success: false,
            error: deviceFailure.error,
            ...(deviceFailure.code !== undefined ? { code: deviceFailure.code } : {}),
          };
        }

        // Fix-1 error semantics: request-level failures are 4xx with the
        // standard error envelope; EXECUTION failures (fault injection, HA
        // backend errors) stay a 200 with a SINGLE-layer
        // `{ success:false, error }` (the engine's old double-wrap
        // `{success:true, result:{success:false}}` is flattened here).
        if (!outcome.success) {
          const message = outcome.error ?? 'command failed';
          if (message.includes('No agent manages device')) {
            // Same engine message covers two distinct cases — split them.
            if (deviceExists()) {
              // Fix-18 (R7 F-03): split further — the world may have gained a
              // managing agent AFTER this simulation was created. A sim is a
              // frozen snapshot of creation time, so the fix is recreating
              // the simulation, not binding another agent.
              const managedInWorldNow =
                record.environmentId !== undefined &&
                ctx.envStore !== undefined &&
                ctx.envStore
                  .agentsOf(record.environmentId)
                  .some(agent => parseJsonArray<string>(agent.bound_device_ids_json).includes(deviceId));
              if (managedInWorldNow) {
                throw new ApiError(
                  409,
                  'DEVICE_NOT_MANAGED',
                  `Device "${deviceId}" is managed by an agent in the environment now, but this ` +
                  'simulation is a frozen snapshot of the world at creation time — ' +
                  'recreate the simulation to pick up agents added afterwards',
                );
              }
              throw new ApiError(
                409,
                'DEVICE_NOT_MANAGED',
                `Device "${deviceId}" exists but no agent manages it — bind it to an agent first`,
              );
            }
            throw new ApiError(404, 'DEVICE_NOT_FOUND', `Device "${deviceId}" not found in simulation "${id}"`);
          }
          if (message.includes('not found')) {
            throw new ApiError(404, 'DEVICE_NOT_FOUND', message);
          }
          return { success: false, error: message };
        }

        // Fix-1: executed commands on env-backed sims land in command_log in
        // the replay-consumable shape (replay-service.ts DEVICE_COMMAND_KIND).
        if (record.environmentId !== undefined && ctx.pipeline) {
          ctx.pipeline.log({
            envId: record.environmentId,
            actorId: user.id,
            kind: 'device-command',
            payload: {
              deviceId,
              commandName,
              ...(params !== undefined ? { params } : {}),
              before,
              after: deviceState(),
            },
            simTime: runtime.getSimTimeSec(),
          });
        }
        // S3 (breaking, ratified response contract): the success body is the
        // engine's INNER device result flattened to the top level — ONE
        // `success: true` layer, symmetric with the single-layer failure
        // envelope above. The old double wrap
        // `{success:true, result:{success:true, result:<payload>}}` is gone.
        return flattenCommandSuccess(outcome);
      } catch (error) {
        throw mapEngineError(error);
      }
    },
  );

  app.get('/api/simulations/:id/faults', async request => {
    const { id } = request.params as IdParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationReadAccess(ctx, record, request.user);
    return { faults: record.runtime.listDeviceFaults() };
  });

  app.put('/api/simulations/:id/faults/:deviceId', async request => {
    const { id, deviceId } = request.params as FaultParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    const runtime = record.runtime;
    const profile = parseFaultProfile(request.body);
    try {
      runtime.setDeviceFault(deviceId, profile);
    } catch (error) {
      throw mapEngineError(error);
    }
    return { deviceId, fault: runtime.getDeviceFault(deviceId) };
  });

  app.delete('/api/simulations/:id/faults/:deviceId', async request => {
    const { id, deviceId } = request.params as FaultParams;
    const record = ctx.registry.getLiveOrThrow(id);
    assertSimulationControl(ctx, record, request.user);
    const runtime = record.runtime;
    try {
      runtime.setDeviceFault(deviceId, null); // idempotent: clearing twice is fine
    } catch (error) {
      throw mapEngineError(error);
    }
    return { deviceId, fault: null };
  });

  app.get(
    '/api/simulations/:id/stream',
    {
      websocket: true,
      // Reject unknown simulations with a normal 404 BEFORE the upgrade;
      // T-015: gate the stream with the SAME read rule as the REST by-id
      // channels — a private env's sim stream must not be the one bypass
      // left open (403 before the upgrade, same as the REST 403s).
      preValidation: async (request, reply) => {
        const { id } = request.params as IdParams;
        const record = ctx.registry.get(id);
        if (!record) {
          await reply
            .code(404)
            .send(errorBody('SIMULATION_NOT_FOUND', `Simulation "${id}" not found`));
          return;
        }
        try {
          assertSimulationReadAccess(ctx, record, request.user);
        } catch (error) {
          if (error instanceof ApiError) {
            await reply.code(error.statusCode).send(errorBody(error.code, error.message));
            return;
          }
          throw error;
        }
      },
    },
    (socket: WebSocket, request: FastifyRequest) => {
      const { id } = request.params as IdParams;
      const record = ctx.registry.get(id);
      if (!record) {
        socket.close(1008, 'simulation not found');
        return;
      }
      // P4-4 metrics: gauge of live simulation-stream connections.
      ctx.metrics.wsOpened('simulation');
      let gaugeClosed = false;
      // R2-BUG-04: watching the authoritative world session through the sim
      // stream is an ARRIVAL — pin the session ACTIVE (wake + catch-up to
      // wall-now), same as the env world stream does. Without this the
      // console stared at the frozen lazy clock forever: the stream used to
      // never touch the WorldSessionService.
      let releaseSessionPin: (() => void) | undefined;
      const closeGauge = (): void => {
        if (gaugeClosed) return;
        gaugeClosed = true;
        ctx.metrics.wsClosed('simulation');
        streamSessions.release(id, socket);
        try {
          releaseSessionPin?.();
        } catch {
          // A pin release must never break stream cleanup.
        }
      };
      socket.on('close', closeGauge);
      socket.on('error', closeGauge);
      if (record.envSession === true && record.environmentId !== undefined && ctx.worldSessions !== undefined) {
        void ctx.worldSessions.observeOrMaterialize(record.environmentId).then(release => {
          if (gaugeClosed) {
            try {
              release();
            } catch {
              /* session already gone */
            }
            return;
          }
          releaseSessionPin = release;
        });
      }
      // S2 (device privacy): the stream delivers the SAME view as the REST
      // snapshot — device entries and device-event payloads project through
      // the canonical seam per socket (foreign readings never ride a frame,
      // including the terminal snapshot on stop).
      const projector = streamProjectorFor(ctx, record, request.user);
      attachStream(socket, record.runtime, ctx.snapshotEverySimSec, ctx.streamHeartbeatMs, request.log, projector);
      streamSessions.track(
        id,
        socket,
        projector === undefined
          ? undefined
          : message => {
              const frame = message as { kind?: string; data?: unknown };
              return JSON.stringify(
                frame !== null && typeof frame === 'object' && frame.kind === 'snapshot'
                  ? { ...frame, data: projector.snapshot(frame.data) }
                  : message,
              );
            },
      );
      // T-007: a client arriving at an ALREADY-stopped sim still gets its
      // snapshot (state:'stopped') — then the stream ends the same way a
      // stop-during-subscription would, instead of sitting silent forever.
      if (record.runtime.getState() === 'stopped') {
        socket.close(1001, 'simulation stopped');
      }
    },
  );
}

// ---------------------------------------------------------------------------
// WebSocket stream
// ---------------------------------------------------------------------------

type StreamRuntime = {
  getSnapshot(): unknown;
  getSimTimeSec(): number;
  subscribe(listener: (event: SystemEvent) => void): () => void;
};

/**
 * S2 (device privacy): per-socket frame projector. `snapshot` is applied to
 * whole snapshot payloads; `event` to each engine event in a batch.
 */
export interface StreamProjector {
  snapshot: (data: unknown) => unknown;
  event: (event: SystemEvent) => SystemEvent;
}

export function attachStream(
  socket: WebSocket,
  runtime: StreamRuntime,
  snapshotEverySimSec: number,
  heartbeatMs: number,
  log: { warn: (obj: unknown, msg: string) => void },
  project?: StreamProjector,
): void {
  const send = (message: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message), error => {
      if (error) log.warn({ err: error }, 'stream send failed');
    });
  };
  // R30 Task 4: per-subscriber delta tracking — cadence ticks send additive
  // zone-delta/device-delta frames instead of full snapshots (full snapshot
  // stays for the initial sync, the 30s resync, topology changes, and large
  // diffs; sim-stream-deltas.ts owns the wire shapes + crossover rules).
  const deltaTracker = new SnapshotDeltaTracker();
  const projectSnapshot = (): SnapshotLike =>
    project
      ? project.snapshot(runtime.getSnapshot()) as SnapshotLike
      : runtime.getSnapshot() as SnapshotLike;
  const sendSnapshot = (): void => {
    const snapshot = projectSnapshot();
    send({ kind: 'snapshot', data: snapshot });
    deltaTracker.sentFull(snapshot);
  };

  // Initial state so a client never connects to silence.
  sendSnapshot();

  const pendingEvents: SystemEvent[] = [];
  const unsubscribe = runtime.subscribe(event => {
    pendingEvents.push(event);
  });

  let lastSnapshotSimTime = runtime.getSimTimeSec();
  const flush = setInterval(() => {
    if (pendingEvents.length > 0) {
      const batch = pendingEvents.splice(0, pendingEvents.length);
      send({ kind: 'event', data: project ? batch.map(project.event) : batch });
    }
    const simTimeSec = runtime.getSimTimeSec();
    if (simTimeSec - lastSnapshotSimTime >= snapshotEverySimSec) {
      lastSnapshotSimTime = simTimeSec;
      const snapshot = projectSnapshot();
      const decision = deltaTracker.decide(snapshot);
      if (decision.kind === 'full') {
        send({ kind: 'snapshot', data: snapshot });
        deltaTracker.sentFull(snapshot);
      } else {
        for (const frame of decision.frames) send(frame);
      }
    }
  }, STREAM_FLUSH_MS);

  // T-007: the stream is receive-only. A client that talks to it used to get
  // eternal silence — now it gets one teaching error frame per message (the
  // stream itself stays open; browsers/ws clients never need to send).
  socket.on('message', () => {
    send({
      kind: 'error',
      code: 'STREAM_READ_ONLY',
      message: 'The simulation stream is receive-only (snapshots + event batches). '
        + 'To act on the simulation use the REST endpoints: '
        + 'POST /api/simulations/:id/start|pause|resume|stop, /events, /commands.',
    });
  });

  // T-007 heartbeat (same policy as the agreement stream, Fix-15): a peer
  // that dies without a FIN (killed CLI wrapper, dropped WiFi) would
  // otherwise keep this socket, its subscription and the ws gauge alive
  // forever. Ping on a cadence; one missed pong terminates the socket,
  // which fires 'close' → cleanup below.
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
  }, heartbeatMs);
  heartbeat.unref();

  const cleanup = (): void => {
    clearInterval(flush);
    clearInterval(heartbeat);
    unsubscribe();
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Access control (Fix-47 越权修复)
// ---------------------------------------------------------------------------

/** ADMIN_EMAILS membership — the ONE truth (auth/admin.ts, R21-W3). */
function isAdmin(ctx: SimulationRoutesContext, user: AuthUser | null): boolean {
  return user !== null && isAdminEmail(user.email, ctx.adminEmails);
}

/** Fix-4 (R21-W4, audit §3.5): the ONE viewer-role read-only gate (was 4 inline 403s). */
function assertNotViewer(
  environmentId: string,
  role: EnvRole | undefined,
  whatRequiresBuilder: string,
): void {
  if (role === 'viewer') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Role "viewer" in environment "${environmentId}" is read-only — ` + whatRequiresBuilder,
    );
  }
}

// ---------------------------------------------------------------------------
// S2 (device privacy): per-viewer projection of simulation read surfaces
// ---------------------------------------------------------------------------

/** Minimal record shape the projectors need (live + hibernated both fit). */
interface DeviceBearingRecord {
  environmentId?: string;
  /** S2: fork marker — reads project like env-linked sims. */
  sourceEnvId?: string;
}

function isEnvLinked(record: DeviceBearingRecord): boolean {
  return record.environmentId !== undefined || record.sourceEnvId !== undefined;
}

/**
 * The tier oracle for one sim read: resolves each snapshot/timeline device's
 * ownership from the env rows (device ids are globally unique, so this works
 * for env-backed sims AND creator-private forks whose ids were frozen at
 * fork time). Undefined oracle = pure scenario sim (no tenant semantics —
 * projection is a no-op).
 */
function deviceTierOracleFor(
  ctx: SimulationRoutesContext,
  record: DeviceBearingRecord,
  user: AuthUser | null,
): ((deviceId: string) => 'full' | 'coarse') | undefined {
  if (!isEnvLinked(record) || ctx.envStore === undefined) return undefined;
  const viewer = deviceViewerOf(ctx, user); // audit §3.4: the ONE assembly helpers
  const ownershipOf = deviceOracleFor(ctx.envStore);
  return deviceId => deviceDetailTier(viewer, ownershipOf(deviceId));
}

/** Project an EngineSnapshot's device entries for the viewer (pure clone). */
function projectSnapshotForViewer<T extends { devices?: unknown[] }>(
  ctx: SimulationRoutesContext,
  record: DeviceBearingRecord,
  user: AuthUser | null,
  snapshot: T,
): T {
  const tierOf = deviceTierOracleFor(ctx, record, user);
  if (tierOf === undefined || !Array.isArray(snapshot.devices)) return snapshot;
  const devices = snapshot.devices.map(device => {
    const entry = device as SnapshotDeviceView;
    if (typeof entry?.id !== 'string') return device;
    return tierOf(entry.id) === 'full'
      ? device
      : projectSnapshotDevice(entry, { userId: user?.id ?? null }, undefined);
  });
  return { ...snapshot, devices };
}

/**
 * Project sim-timeline records for the viewer: device-state records of
 * foreign devices keep their history marker (device/service/sim-time) with
 * params/result stripped + `redacted: true`; zone-sample records are world
 * ambient truth and pass through unchanged.
 */
function projectTimelineForViewer(
  ctx: SimulationRoutesContext,
  record: DeviceBearingRecord,
  user: AuthUser | null,
  records: SimTimelineRecord[],
): SimTimelineRecord[] {
  const tierOf = deviceTierOracleFor(ctx, record, user);
  if (tierOf === undefined) return records;
  const viewer: DeviceViewer = { userId: user?.id ?? null };
  return records.map(record => {
    if (record.kind !== 'device-state') return record;
    return tierOf(record.deviceId) === 'full'
      ? record
      : projectDeviceStateRecord(record, viewer, undefined);
  });
}

/**
 * Living-worlds P2: shape a grain-aware trajectory read into the
 * /trajectory response body — records plus the honest `grain` label; a note
 * explains decision-count rollups when they served older history.
 * R81-D2 (R44-extreme-F2): `totalCount` is every RAW record on disk;
 * `truncated: true` marks that the interactive cap dropped raw history.
 */
function trajectoryGrainBody(
  read: { records: unknown[]; grain: string; rawCount: number; rollupCount: number; totalRawCount?: number },
): { records: unknown[]; grain: string; note?: string; totalCount?: number; truncated?: boolean } {
  const body: { records: unknown[]; grain: string; note?: string; totalCount?: number; truncated?: boolean } =
    { records: read.records, grain: read.grain };
  if (read.totalRawCount !== undefined) {
    body.totalCount = read.totalRawCount;
    if (read.totalRawCount > read.rawCount) body.truncated = true;
  }
  if (read.rollupCount > 0) {
    body.note =
      `Decision history beyond the raw window (${read.rawCount} raw record(s) kept) is served as ` +
      `minute-grain rollups (${read.rollupCount} aggregate record(s), kind "rollup-1m" source ` +
      '"decisions") — counts by source/outcome, not individual decisions';
  }
  return body;
}

/**
 * Living-worlds P2: shape the grain-aware timeline read into the /timeline
 * response. RAW records (zone-sample / device-state) go through the viewer
 * projection as before; minute-grain ROLLUP records (kind 'rollup-1m' —
 * per-minute min/max/avg/last aggregates and device change counts) carry no
 * raw telemetry payloads (params/result are never aggregated into them), so
 * they ride along unprojected, clearly labeled by kind. `grain` tells the
 * consumer which source served the tail; a note explains it when rollups
 * participated.
 */
function timelineResponse(
  ctx: SimulationRoutesContext,
  record: DeviceBearingRecord,
  user: AuthUser | null,
  read: { records: unknown[]; grain: string; rawCount: number; rollupCount: number },
): { records: unknown[]; grain: string; note?: string } {
  const raw: SimTimelineRecord[] = [];
  const rollups: unknown[] = [];
  for (const item of read.records) {
    if (
      typeof item === 'object' && item !== null &&
      (item as { kind?: unknown }).kind === 'rollup-1m'
    ) {
      rollups.push(item);
    } else {
      raw.push(item as SimTimelineRecord);
    }
  }
  const records = [...rollups, ...projectTimelineForViewer(ctx, record, user, raw)];
  const body: { records: unknown[]; grain: string; note?: string } = { records, grain: read.grain };
  if (read.rollupCount > 0) {
    body.note =
      `History beyond the raw window (${read.rawCount} raw record(s) kept) is served as ` +
      `minute-grain rollups (${read.rollupCount} aggregate record(s), kind "rollup-1m") — ` +
      'per-minute min/max/avg/last aggregates, not raw samples';
  }
  return body;
}

/** Device-bearing engine event types (payloads carry readings/params). */
const DEVICE_PAYLOAD_EVENT_TYPES = new Set<string>([
  EventType.DEVICE_STATE_CHANGE,
  EventType.DEVICE_STATE_UPDATE,
  EventType.DEVICE_OPERATION_EXECUTED,
]);

/** The WS stream projector: snapshots + device-payload events per socket. */
function streamProjectorFor(
  ctx: SimulationRoutesContext,
  record: DeviceBearingRecord,
  user: AuthUser | null,
): StreamProjector | undefined {
  const tierOf = deviceTierOracleFor(ctx, record, user);
  if (tierOf === undefined) return undefined;
  return {
    snapshot: data => projectSnapshotForViewer(ctx, record, user, data as { devices?: unknown[] }),
    event: event => {
      if (!DEVICE_PAYLOAD_EVENT_TYPES.has(event.type)) return event;
      const payload = event.payload as { deviceId?: unknown } | undefined;
      if (typeof payload?.deviceId !== 'string') return event;
      if (tierOf(payload.deviceId) === 'full') return event;
      return {
        ...event,
        payload: {
          deviceId: payload.deviceId,
          redacted: true,
          note: 'device detail is only delivered through the service layer (agreements / access grants)',
        },
      };
    },
  };
}

/**
 * List visibility for one simulation summary (Fix-47): the caller's own
 * sims, sims of environments the caller is a member of, and creator-less
 * legacy sims (transition semantics — an anonymous legacy creation belongs
 * to no one). Env-backed sims are visible to the env's members regardless of
 * who created them; admins short-circuit at the call site.
 */
function isVisibleSummary(
  ctx: SimulationRoutesContext,
  sim: SimulationSummary,
  user: AuthUser | null,
): boolean {
  if (user !== null && sim.createdBy === user.id) return true;
  if (sim.environmentId !== undefined) {
    return (
      user !== null &&
      ctx.envStore !== undefined &&
      ctx.envStore.roleOf(sim.environmentId, user.id) !== undefined
    );
  }
  return sim.createdBy === undefined;
}

/**
 * T-015: read gate for EVERY by-id simulation read channel
 * (snapshot/trajectory/timeline/collaborations/eval-report/faults/stream).
 * Pre-fix these endpoints checked only EXISTENCE — a stranger (or an
 * anonymous caller) could read a PRIVATE environment's simulation by id
 * while the Fix-47 list correctly hid it. Coherent rule:
 *
 * - admins and the sim's creator always pass;
 * - an env-backed sim follows its ENVIRONMENT's read gate
 *   (canReadEnvironment: public = anonymous OK, private = member) —
 *   members who created a sim on an env they could read keep access even
 *   if their membership later changes, and a public teaching env's sims
 *   stay anonymously watchable, matching the env detail itself;
 * - legacy scenario sims keep the Fix-47 transition semantics: creator-less
 *   (anonymous creations) stay open, creator-owned ones are creator-only.
 */
function assertSimulationReadAccess(
  ctx: SimulationRoutesContext,
  record: SimulationRecord,
  user: AuthUser | null,
): void {
  if (isAdmin(ctx, user)) return;
  if (user !== null && record.createdBy === user.id) return;
  if (record.environmentId !== undefined && ctx.envStore) {
    const env = ctx.envStore.getEnvironment(record.environmentId);
    if (env !== undefined) {
      // Same gate as every other env read surface (env-access.ts).
      requireReadAccess(
        env,
        user !== null ? ctx.envStore.roleOf(env.id, user.id) : undefined,
      );
      return;
    }
    // Environment deleted while a registry record lingers (retention race):
    // fall through to the creator-based rule — nothing left to authorize
    // against except attribution.
  }
  // P2F §10.2: a SANDBOX sim's world surfaces (snapshot/timeline/stream…)
  // are readable by the fork owner (creator rule above), the env owner, and
  // JOINED members — a viewer member reads, an env member who never joined
  // does not (fork contexts are opt-in, §10.2's visibility model).
  if (user !== null && forkMemberRole(ctx, record, user.id) !== undefined) return;
  if (record.createdBy === undefined) return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Simulation "${record.id}" belongs to ${record.environmentId !== undefined ? 'a private environment you are not a member of' : 'another user'} — ` +
      'by-id simulation reads require being the creator, an admin, or (for environment-backed sims) ' +
      'read access to the environment. The simulation list (GET /api/simulations) shows exactly the simulations you may read.',
  );
}

/**
 * T-015: read gate for the DISK eval-report fallback (registry miss after a
 * restart). The on-disk report carries the sim's environmentId (from
 * sim-timeline records) — when present and resolvable, apply the same env
 * read gate as the registry path. Reports without an environmentId (legacy
 * scenario sims, timeline-less runs) cannot be attributed and keep the
 * creator-less transition semantics.
 */
function assertDiskEvalReportReadAccess(
  ctx: SimulationRoutesContext,
  report: { environmentId?: string },
  user: AuthUser | null,
): void {
  if (isAdmin(ctx, user)) return;
  if (report.environmentId === undefined || !ctx.envStore) return;
  const env = ctx.envStore.getEnvironment(report.environmentId);
  if (env === undefined) return;
  requireReadAccess(
    env,
    user !== null ? ctx.envStore.roleOf(env.id, user.id) : undefined,
  );
}

/**
 * Control gate for the mutating ops (start/pause/resume/stop/step, fault
 * writes, event injection — /commands keeps its own Fix-1/Fix-4 gate).
 * Allowed: the sim's creator, an owner/builder of its environment, or an
 * admin. A viewer who is not the creator gets the read-only 403 in their own
 * terms (Fix-46 style). Creator-less sims (createdBy undefined — anonymous
 * creations) stay operable by anyone: they belong to no one, so there is no
 * identity to authorize against (transition semantics, mirroring /commands).
 */
function assertSimulationControl(
  ctx: SimulationRoutesContext,
  record: SimulationRecord,
  user: AuthUser | null,
): void {
  if (isAdmin(ctx, user)) return;
  // Living-worlds P1W: the authoritative world session belongs to the
  // ENVIRONMENT, not to any user — only owner/builders may act on it
  // (viewers were gated by the route-level check above; the creator-less
  // legacy allowance does NOT apply to the shared world).
  if (record.envSession === true) {
    if (record.environmentId !== undefined && ctx.envStore && user !== null) {
      const role = ctx.envStore.roleOf(record.environmentId, user.id);
      if (role === 'owner' || role === 'builder') return;
    }
    throw new ApiError(
      403,
      'FORBIDDEN',
      `Simulation "${record.id}" is the environment's authoritative world session — acting on it ` +
      'requires role "builder" | "owner" in the environment (join the environment first)',
    );
  }
  if (user !== null && record.createdBy === user.id) return;
  if (record.createdBy === undefined) return;
  if (record.environmentId !== undefined && ctx.envStore && user !== null) {
    const role = ctx.envStore.roleOf(record.environmentId, user.id);
    if (role === 'owner' || role === 'builder') return;
    assertNotViewer(
      record.environmentId,
      role,
      'controlling a simulation requires role "builder" | "owner" (or being its creator)',
    );
  }
  // P2F §10.2: a JOINED BUILDER may operate the fork's world (inject/run);
  // viewer members stay read-only in their own terms.
  if (user !== null && forkMemberRole(ctx, record, user.id) === 'builder') return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Only the simulation creator, an owner/builder of its environment, or an admin ` +
      `may control simulation "${record.id}"`,
  );
}

/**
 * P2F (living-worlds §10.2): the acting user's membership role on the fork
 * owning this sim — 'owner' for the fork owner (implicit) or the env owner,
 * 'builder' | 'viewer' for joined members, undefined for everyone else
 * (including the teaching fallback when no sandboxStore is wired). Fork sims
 * carry an explicit forkId (§10.4); non-fork sims resolve undefined.
 */
function forkMemberRole(
  ctx: SimulationRoutesContext,
  record: Pick<SimulationRecord, 'forkId' | 'environmentId'>,
  userId: string,
): 'owner' | 'builder' | 'viewer' | undefined {
  if (ctx.sandboxStore === undefined || record.forkId === undefined) return undefined;
  const sandbox = ctx.sandboxStore.get(record.forkId);
  if (sandbox === undefined) return undefined;
  if (sandbox.owner_id === userId) return 'owner';
  if (ctx.envStore !== undefined) {
    const env = ctx.envStore.getEnvironment(sandbox.env_id);
    if (env?.owner_id === userId) return 'owner';
  }
  return ctx.sandboxStore.memberOf(sandbox.id, userId)?.role;
}

// ---------------------------------------------------------------------------
// Living-worlds P0: hibernated-sim gates (the runtime is gone; identity,
// environment and creator survive in the lightweight record)
// ---------------------------------------------------------------------------

/**
 * Read gate for a HIBERNATED sim's still-servable surfaces (/trajectory,
 * /timeline — frozen history on disk). Same rule as assertSimulationReadAccess
 * (T-015), applied to the hibernated record's fields.
 */
function assertHibernatedReadAccess(
  ctx: SimulationRoutesContext,
  hibernated: HibernatedSimulationRecord,
  user: AuthUser | null,
): void {
  if (isAdmin(ctx, user)) return;
  if (user !== null && hibernated.createdBy === user.id) return;
  if (hibernated.environmentId !== undefined && ctx.envStore) {
    const env = ctx.envStore.getEnvironment(hibernated.environmentId);
    if (env !== undefined) {
      requireReadAccess(
        env,
        user !== null ? ctx.envStore.roleOf(env.id, user.id) : undefined,
      );
      return;
    }
  }
  // P2F §10.2: a hibernated fork's frozen history is readable by its members.
  if (user !== null && forkMemberRole(ctx, hibernated, user.id) !== undefined) return;
  if (hibernated.createdBy === undefined) return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Simulation "${hibernated.id}" is hibernated and belongs to ` +
      `${hibernated.environmentId !== undefined ? 'a private environment you are not a member of' : 'another user'} — ` +
      'its frozen history is readable by the creator, an admin, or members of its environment.',
  );
}

/**
 * Control gate for hibernated-sim ops (resume, re-hibernate, stop-discard):
 * the sim's creator, an owner/builder of its environment, or an admin —
 * the same rule as assertSimulationControl, on the hibernated fields.
 */
function assertHibernatedControl(
  ctx: SimulationRoutesContext,
  hibernated: HibernatedSimulationRecord,
  user: AuthUser | null,
): void {
  if (isAdmin(ctx, user)) return;
  if (user !== null && hibernated.createdBy === user.id) return;
  if (hibernated.createdBy === undefined) return;
  if (hibernated.environmentId !== undefined && ctx.envStore && user !== null) {
    const role = ctx.envStore.roleOf(hibernated.environmentId, user.id);
    if (role === 'owner' || role === 'builder') return;
    assertNotViewer(
      hibernated.environmentId,
      role,
      'resuming or discarding a hibernated simulation requires role "builder" | "owner" (or being its creator)',
    );
  }
  // P2F §10.2: joined builders may resume a hibernated fork.
  if (user !== null && forkMemberRole(ctx, hibernated, user.id) === 'builder') return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    `Only the simulation creator, an owner/builder of its environment, or an admin ` +
    `may resume or discard hibernated simulation "${hibernated.id}"`,
  );
}

