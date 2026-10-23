/**
 * Simulation Registry — lifecycle of in-memory EngineRuntime instances
 *
 * One registry entry per running (or stopped) simulation. Entries are
 * created through `POST /api/simulations` and are NEVER removed implicitly:
 * a stopped simulation stays queryable (list + snapshot) until process
 * shutdown, so clients can inspect a finished run. `stopAll()` is invoked
 * from the server's onClose hook during graceful shutdown.
 *
 * R21-W4 decomposition: this file is the thin COORDINATOR (CRUD + queries +
 * lifecycle orchestration). The concerns it delegates to:
 * - `sim-registry/runtime-builder.ts` — LLM/triage/hass/flows runtime
 *   assembly (one build path for create + every resume/rebuild lane);
 * - `sim-registry/seams.ts` — post-construction server seams (flow ledger,
 *   command audit, reputation, tally, triggers, sim-timeline);
 * - `sim-registry/records.ts` — record/checkpoint/summary shaping (the
 *   hibernate/resume identity contract);
 * - `sim-registry/trajectory-gc.ts` — trajectory disk GC (T-011).
 * All consumer-facing exports are re-exported below, so import paths and
 * semantics are unchanged (pure move; the world, hibernate, lazy and
 * session suites are the acceptance contract).
 *
 * Trajectory capture (W8): with a `trajectoryBaseDir`, every new simulation
 * records its (event, agent) trajectory JSONL to
 * `<trajectoryBaseDir>/<simId>/` unless the create call overrides it with an
 * explicit `options.trajectoryDir`. Disk growth is bounded per-file
 * (sim-timeline cap) and per-dir (record teardown + boot sweep — see
 * sim-registry/trajectory-gc.ts).
 *
 * Home Assistant bindings (P3a): scenarios with `hass://` device bindings
 * build their runtime through a HADevice-adapter deviceFactory on the
 * shared HASService connection (503 HASS_NOT_CONFIGURED / 400
 * HASS_UNKNOWN_ENTITY at build time; sim://-only scenarios never touch the
 * hass path).
 */

import {
  EngineRuntime,
  type EngineRuntimeState,
  type FlowDefinition,
  type FlowRunRecord,
  type ScenarioDefinition,
  type TickTimer,
} from '@active-collaboration/core';
import { LLMCache, type LLMCacheStats } from '@active-collaboration/llm-integration';

import { ApiError } from './errors.js';
import type { ChangePipeline } from './change-pipeline.js';
import type { FlowStore } from './db/flow-store.js';
import type { ReputationStore } from './db/reputation-store.js';
import type { AgentExperienceStore } from './db/experience-store.js';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import type { HASService } from './hass/service.js';
import type { LlmTokenUsage } from './metrics.js';
import { startLazyDriver, type LazyDriverHandle } from './lazy-driver.js';
import { closeSimTimelineWriter, DEFAULT_SIM_TIMELINE_MAX_BYTES } from './sim-timeline.js';
import { readWorldCheckpoint, writeWorldCheckpoint, type WorldCheckpointFile } from './world-checkpoint.js';
import { SimRuntimeBuilder, type LlmEnv } from './sim-registry/runtime-builder.js';
import { SimulationSeams } from './sim-registry/seams.js';
import {
  adoptedRecordFrom,
  hibernateCheckpoint,
  hibernatedRecordFrom,
  hibernatedSummaryOf,
  liveSummaryOf,
  newRecordOf,
  rebuiltRecordOf,
  resumedRecordOf,
} from './sim-registry/records.js';
import {
  cleanupOldTrajectories,
  deleteTrajectoryDir as deleteTrajectoryDirUnder,
  lastDiskActivityMs as lastDiskActivityMsUnder,
} from './sim-registry/trajectory-gc.js';
import type {
  CreateSimulationOptions,
  EventTallySeam,
  HibernatedSimulationRecord,
  LlmResolution,
  RuntimeAttacher,
  SimulationRecord,
  SimulationSummary,
} from './sim-registry/types.js';

export {
  LLM_PRESETS,
  SIMULATION_SCHEDULINGS,
  type CreateSimulationOptions,
  type HibernatedSimulationRecord,
  type LLMPreset,
  type SimulationRecord,
  type SimulationScheduling,
  type SimulationSummary,
} from './sim-registry/types.js';
export { DEFAULT_TRIAGE_MODEL } from './sim-registry/runtime-builder.js';
export { cleanupOldTrajectories } from './sim-registry/trajectory-gc.js';

export class SimulationRegistry {
  private readonly records = new Map<string, SimulationRecord>();
  /**
   * Living-worlds P0: hibernated sims — no runtime, just identity +
   * checkpoint metadata + the plain data resume needs. A sim id lives in
   * exactly ONE of the two maps at any time.
   */
  private readonly hibernatedRecords = new Map<string, HibernatedSimulationRecord>();
  private seq = 0;

  /**
   * Shared LLM response cache (P4-2): one cache for every simulation client
   * this registry builds — repeated sim runs re-issue identical prompts, so
   * cross-simulation hits are free wins. SQLite-backed when llmCachePath is
   * configured, in-memory otherwise.
   */
  private readonly llmCache: LLMCache;

  private readonly builder: SimRuntimeBuilder;
  private readonly seams: SimulationSeams;

  /**
   * Periodic full reconciliation of the service-catalog mirrors (defensive,
   * low-frequency — the push lane converges on every catalog write; this
   * timer catches what writes never see: FK-cascade windows, out-of-band
   * registry writes, partial-rebuild faults). Started only when the catalog
   * seam provides reconcileAll; unref'd so it never holds the process open,
   * cleared by stopAll (server shutdown + test teardown).
   */
  private static readonly CATALOG_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
  private catalogReconcileTimer?: NodeJS.Timeout;

  /**
   * T-024: expose the shared cache so NON-simulation clients the server
   * builds (the proposal-review LLM client) join the same response cache —
   * identical review prompts are served from cache instead of re-billed.
   */
  getLlmCache(): LLMCache {
    return this.llmCache;
  }

  /**
   * T-035: post-construction wiring for the agreement trigger executor —
   * its full context (settlement, stream sessions) is assembled after the
   * registry, and no simulation can exist before the server listens, so a
   * late assignment misses nothing.
   */
  /**
   * R40-A3（认知架构 §7.5 升级通道）：agent 升级事件 → env owner 通知桥，
   * late-assigned（与 T-035 agreement trigger 同款：通知 store 在 registry
   * 之后装配；server 监听开始前不存在任何 simulation，晚赋值不漏挂）。
   */
  private agentEscalationBridge?: RuntimeAttacher;

  /**
   * FEAT-05: flow NOTIFY-node executor (deterministic notify lane) —
   * late-assigned like the T-035 agreement trigger (the notification store
   * assembles after the registry; no simulation can exist before the server
   * listens).
   */
  private flowNotifyExecutor?: RuntimeAttacher;

  /**
   * R6-B-F03: flow SERVICE-node executor (agreement-mediated cross-owner
   * orchestration lane) — late-assigned like the T-035 agreement trigger
   * (the agreement context assembles after the registry; no simulation can
   * exist before the server listens).
   */
  private flowServiceExecutor?: RuntimeAttacher;

  setAgreementTrigger(attacher: RuntimeAttacher): void {
    this.agreementTrigger = attacher;
  }

  /** R40-A3：挂载 agent 升级通知桥（见字段注释）。 */
  setAgentEscalationBridge(attacher: RuntimeAttacher): void {
    this.agentEscalationBridge = attacher;
  }

  /** FEAT-05：挂载 flow notify 节点执行器（见字段注释）。 */
  setFlowNotifyExecutor(attacher: RuntimeAttacher): void {
    this.flowNotifyExecutor = attacher;
  }

  /** R6-B-F03：挂载 flow service 节点执行器（见字段注释）。 */
  setFlowServiceExecutor(attacher: RuntimeAttacher): void {
    this.flowServiceExecutor = attacher;
  }

  /**
   * Mechanism C (mixed-initiative flows §7): escalation delivery for
   * policy-envelope exhaustion — late-assigned exactly like the T-035
   * agreement trigger (the notification store and env lookup assemble after
   * the registry; no simulation can exist before the server listens).
   */
  setFlowPolicyEscalationSink(
    sink: (escalation: { record: FlowRunRecord; environmentId: string }) => void,
  ): void {
    this.seams.setFlowPolicyEscalationSink(sink);
  }

  constructor(
    private readonly llmEnv: LlmEnv = {},
    /**
     * Base directory for per-simulation trajectory capture (W8). When set,
     * every created simulation records to `<trajectoryBaseDir>/<simId>/`
     * unless the caller passes an explicit `options.trajectoryDir`.
     */
    private readonly trajectoryBaseDir?: string,
    /** Shared Home Assistant service (P3a); consulted only for hass:// bindings. */
    hass?: HASService,
    /**
     * Reputation persistence (P4-1). When set, environment-backed
     * simulations load their env's `agent_reputation` rows into the
     * runtime's tracker at start and persist the tracker back on every
     * COLLABORATION_COMPLETED and on stop. Legacy scenario sims
     * (no environmentId) keep reputation in memory only.
     */
    reputationStore?: ReputationStore,
    /**
     * Token-usage sink (P4-4 observability): when set, every LLM client this
     * registry builds (shared decision client + triage client) gets its
     * chat() wrapped so prompt/completion tokens accumulate process-wide.
     */
    tokenUsageSink?: (usage: LlmTokenUsage) => void,
    /**
     * Latency sink (R15-A3): same wrap, but records each chat call's
     * end-to-end duration (queue wait included) and success flag so the
     * observability endpoints can report p50/p95/p99 LLM latency.
     */
    llmLatencySink?: (durationMs: number, success: boolean) => void,
    /**
     * AC ephemeral agreements (Fix-11 Phase 2): when set, every
     * environment-backed simulation gets the bridge attached so AC handshakes
     * land metered ephemeral agreements. Legacy scenario sims are skipped.
     */
    private readonly agreementBridge?: RuntimeAttacher,
    /**
     * Zone-parameter sampling cadence in simulated seconds (Fix-14 replay
     * timeline). Environment-backed sims with a trajectory dir get a sampler
     * appending `zone-sample` records to `<trajectoryDir>/sim-timeline.jsonl`.
     */
    private readonly zoneSampleEverySimSec: number = 60,
    /**
     * User-orchestrated business flows. When set, environment-backed
     * simulations get a `flowsProvider` re-reading the env's ENABLED flows at
     * every trigger evaluation (API edits/toggles take effect immediately),
     * and every flow execution lands in the `flow_runs` ledger via the
     * runtime's onFlowRun listener. Legacy scenario sims keep core behavior
     * (scenario-declared flows only, no ledger).
     */
    private readonly flowStore?: FlowStore,
    /**
     * Fix-44h: when set, engine-issued device commands (agent decisions,
     * flow invocations) land in command_log with a synthetic actor —
     * the audit trail covers every device action.
     */
    private readonly commandLogPipeline?: ChangePipeline,
    /**
     * Per-file cap for each simulation's sim-timeline.jsonl (T-011 disk GC).
     * Threaded into every sim-timeline append this registry makes; see
     * sim-timeline.ts for the trim semantics.
     */
    private readonly simTimelineMaxBytes: number = DEFAULT_SIM_TIMELINE_MAX_BYTES,
    /**
     * R14 Wave-A (design-data-services.md): per-sim injected-event tally —
     * the countSince window for ComputationSpec evaluation. Attached to
     * every environment-backed sim at creation (injections never ride the
     * bus; onInjectedEvent is the only history surface). Living-worlds P0:
     * the ring rides the checkpoint (eventsOf at hibernate, reseed at
     * resume) so countSince windows span the freeze.
     */
    private readonly eventTally?: EventTallySeam,
    /**
     * T-035 (DevLoop R17): agreement trigger-clause auto-execution — every
     * env-backed sim's injected events are matched against the env's ACTIVE
     * agreements' terms.trigger, and matches execute terms.action through
     * the same metered invocation path as manual invokes.
     */
    private agreementTrigger?: RuntimeAttacher,
    /**
     * Living-worlds P1 (design §8.5): terms.read freshness floors for lazy
     * sims — given an environment id, the TIGHTEST active data-read
     * agreement's terms.read.minFreshnessSec (wall seconds), or undefined
     * when none carries one. The lazy driver registers it as an external due
     * (wall-mapped through the sim's rate) so the world never freezes past
     * an active freshness contract. server.ts wires this over the agreement
     * store; the registry itself never touches agreements.
     */
    private readonly lazyFreshness?: { floorSecForEnv(environmentId: string): number | undefined },
    /**
     * Living-worlds P2: per-segment size cap for each sim's decision
     * trajectory segmented log (EAF_TRAJECTORY_SEGMENT_BYTES, default 50MB
     * — below the replay source read cap). Threaded into every runtime the
     * registry builds.
     */
    private readonly trajectorySegmentBytes?: number,
    /**
     * Living-worlds P2: raw retention window (ms) for the timeline rollup
     * compactor (EAF_ROLLUP_WINDOW_DAYS, default 7 days). 0 disables
     * compaction (raw kept until dir-level retention). Threads into the
     * sim-timeline on-rotation hook.
     */
    private readonly timelineRollupWindowMs: number = 0,
    /**
     * R42-A/F3 §7.1: the env service catalog. When set, every
     * environment-backed sim wires each agent's `listMyServices` seam to
     * its serviceStore rows so the AC responder's handshake prompt carries
     * "YOUR SERVICES" (service semantics into the decision path).
     */
    private readonly serviceStore?: import('./db/service-store.js').ServiceStore,
    /**
     * P2: the world service catalog push-sync (server.ts constructs one over
     * the shared serviceStore, agreementBridge-style). When set, every
     * env-backed runtime's EnvironmentCenter mirrors the env's
     * published/flow/aggregate services, rebuilt live on catalog writes.
     */
    serviceCatalogSync?: RuntimeAttacher,
    /**
     * R6-E-F15: private-experience persistence (learned meta-cognition:
     * decision-quality ring + private partner trust). When set,
     * environment-backed simulations load their env's `agent_experiences`
     * snapshots into the agents' meta-cognition at start and persist them
     * back on every COLLABORATION_COMPLETED and on stop/hibernate — the
     * same discipline as P4-1 reputation (rehydrating skips the load —
     * the checkpoint's cognition is the truth; forks/sandboxes have no env
     * backing and never write back).
     */
    experienceStore?: AgentExperienceStore,
    /**
     * FEAT-07: env-level occupantSchedule PATCH push-sync (server.ts
     * constructs one and also hands it to the route). When set, every
     * env-backed runtime registers itself so schedule PATCHes land live,
     * no environment rebuild.
     */
    occupantScheduleSync?: RuntimeAttacher,
  ) {
    this.llmCache = new LLMCache(
      llmEnv.llmCachePath ? { persistPath: llmEnv.llmCachePath } : {},
    );
    this.builder = new SimRuntimeBuilder(
      llmEnv,
      hass,
      flowStore,
      this.llmCache,
      tokenUsageSink,
      llmLatencySink,
    );
    this.seams = new SimulationSeams({
      flowStore,
      commandLogPipeline,
      reputationStore,
      experienceStore,
      agreementBridge,
      eventTally,
      serviceStore: this.serviceStore,
      serviceCatalogSync,
      occupantScheduleSync,
      zoneSampleEverySimSec,
      simTimelineMaxBytes,
      rollupWindowMs: this.timelineRollupWindowMs,
    });
    if (serviceCatalogSync?.reconcileAll !== undefined) {
      this.catalogReconcileTimer = setInterval(() => {
        try {
          serviceCatalogSync.reconcileAll!();
        } catch (error) {
          console.warn('SimulationRegistry: periodic catalog reconcile failed:', error);
        }
      }, SimulationRegistry.CATALOG_RECONCILE_INTERVAL_MS);
      this.catalogReconcileTimer.unref();
    }
  }

  /** Build an EngineRuntime for a scenario and register it. */
  async create(
    scenario: ScenarioDefinition,
    options: CreateSimulationOptions = {},
    environmentId?: string,
    createdBy?: string,
    /** T-201: env owner id — flow authorship stamping (see FlowStore.listEnabled). */
    environmentOwnerId?: string,
    /**
     * S2 (device privacy): the SOURCE env of a creator-private fork — marks
     * the sim's reads for the privacy seam WITHOUT any env-backing behavior.
     */
    sourceEnvId?: string,
    /** P2F §10: the owning sandbox row id (explicit lineage key, §10.4). */
    forkId?: string,
  ): Promise<SimulationRecord> {
    // The id is needed BEFORE the runtime is constructed: the default
    // trajectory directory is namespaced by sim id.
    const id = `sim-${scenario.meta.id}-${Date.now().toString(36)}-${++this.seq}`;

    const trajectoryDir = options.trajectoryDir ??
      (this.trajectoryBaseDir !== undefined ? join(this.trajectoryBaseDir, id) : undefined);

    const built = await this.buildRuntime({
      id,
      scenario,
      options,
      environmentId,
      environmentOwnerId,
      ...(trajectoryDir !== undefined ? { trajectoryDir } : {}),
    });
    const record = newRecordOf({
      id,
      scenario,
      options,
      runtime: built.runtime,
      llm: built.llm,
      environmentId,
      environmentOwnerId,
      sourceEnvId,
      forkId,
      createdBy,
      ...(trajectoryDir !== undefined ? { trajectoryDir } : {}),
    });
    this.records.set(id, record);
    this.attachSeams(record);
    // Living-worlds P1: lazy sims get their due-moment driver at creation —
    // it idles (cheap recheck poll, zero engine work) until /start flips the
    // runtime to running in due-driven mode.
    if (record.scheduling === 'lazy') {
      this.ensureLazyDriver(record);
    }
    return record;
  }

  /**
   * Living-worlds P1W (design-living-worlds.md §4.3): create the
   * environment's AUTHORITATIVE world session — a registry record like any
   * sim (so every server seam — flow ledger, command audit, reputation,
   * event tally, agreement triggers, sim-timeline — attaches for free), but
   * env-owned: no creator, a deterministic id (`sim-<envId>-world-session`,
   * so its per-env trajectory/timeline dir is stable), lazy scheduling with a
   * 1000ms tick cadence so speed 1 == wall-rate (1 sim-sec per wall-sec, the
   * WALL mapping decision). NOT exposed through POST /api/simulations —
   * only the WorldSessionService creates sessions.
   */
  async createEnvSession(args: {
    envId: string;
    scenario: ScenarioDefinition;
    envOwnerId?: string;
    onAdvance?: () => void;
  }): Promise<SimulationRecord> {
    const id = `sim-${args.envId}-world-session`;
    if (this.records.has(id) || this.hibernatedRecords.has(id)) {
      throw new ApiError(
        409,
        'WORLD_SESSION_EXISTS',
        `Environment "${args.envId}" already has a world session (${id})`,
      );
    }
    const options: CreateSimulationOptions = { scheduling: 'lazy', tickMs: 1000 };
    const trajectoryDir = this.trajectoryBaseDir !== undefined
      ? join(this.trajectoryBaseDir, id)
      : undefined;

    const built = await this.buildRuntime({
      id,
      scenario: args.scenario,
      options,
      environmentId: args.envId,
      ...(args.envOwnerId !== undefined ? { environmentOwnerId: args.envOwnerId } : {}),
      ...(trajectoryDir !== undefined ? { trajectoryDir } : {}),
    });
    const record = newRecordOf({
      id,
      scenario: args.scenario,
      options,
      runtime: built.runtime,
      llm: built.llm,
      environmentId: args.envId,
      environmentOwnerId: args.envOwnerId,
      envSession: true,
      ...(trajectoryDir !== undefined ? { trajectoryDir } : {}),
    });
    this.records.set(id, record);
    this.attachSeams(record);
    if (args.onAdvance !== undefined) this.advanceHooks.set(id, args.onAdvance);
    this.ensureLazyDriver(record);
    return record;
  }

  /**
   * Living-worlds P1W: resume a HIBERNATED authoritative session — like
   * resumeHibernated, but the runtime is rebuilt from the caller-supplied
   * (CURRENT env-rows) scenario instead of the checkpoint's frozen copy:
   * "sim owns dynamics, env owns topology" (design §9 — schema drift during
   * the empty window resolves to current topology). The returned record is
   * restored + re-seamed but NOT started — the session service starts it
   * (lazy) and fast-forwards to the wall-mapped now.
   */
  async resumeEnvSession(
    id: string,
    scenario: ScenarioDefinition,
  ): Promise<SimulationRecord> {
    const hibernated = this.hibernatedRecords.get(id);
    if (hibernated === undefined) {
      throw new ApiError(404, 'SIMULATION_NOT_HIBERNATED', `Simulation "${id}" is not hibernated`);
    }
    const checkpoint: WorldCheckpointFile = readWorldCheckpoint(hibernated.checkpoint.path);

    const built = await this.buildRuntime({
      id: hibernated.id,
      scenario, // CURRENT env topology (drift resolved by the caller)
      options: hibernated.createOptions,
      environmentId: hibernated.environmentId,
      ...(hibernated.environmentOwnerId !== undefined
        ? { environmentOwnerId: hibernated.environmentOwnerId }
        : {}),
      trajectoryDir: hibernated.trajectoryDir,
      trajectoryAppend: true, // history continues — never truncate
    });
    built.runtime.restoreWorldState(checkpoint.world);

    const record = resumedRecordOf(hibernated, built, { scenario, envSession: true });
    this.records.set(record.id, record);
    this.attachSeams(record, { rehydrating: true });
    this.eventTally?.reseed?.(record.id, built.runtime, checkpoint.eventTally);
    this.hibernatedRecords.delete(record.id);
    return record;
  }

  /**
   * Living-worlds P1W (T-037 semantics): rebuild a LIVE session's runtime
   * from the CURRENT env topology — pause at a clean boundary, export the
   * dynamics, build a fresh runtime from the new scenario, restore, swap the
   * record (same id, same trajectory dir, history appended), re-attach every
   * seam, re-seed the tally ring. The old runtime is STOPPED (T-013-clean
   * release) — stop listeners close hosted stream sockets; the session
   * service treats observers as pins that survive the swap (clients
   * reconnect). Returns the new record, NOT started — the caller starts it
   * lazy and catches up to wall-now.
   */
  async rebuildLiveSession(id: string, scenario: ScenarioDefinition): Promise<SimulationRecord> {
    const old = this.getOrThrow(id);
    if (old.envSession !== true) {
      throw new ApiError(
        400,
        'NOT_A_WORLD_SESSION',
        `Simulation "${id}" is not an authoritative world session`,
      );
    }
    // Clean boundary: no advance mid-flight, no event mid-delivery.
    old.runtime.pause();
    await old.runtime.awaitQuiescent(10_000);
    const world = old.runtime.exportWorldState();
    const tally = this.eventTally?.eventsOf?.(id) ?? [];

    const built = await this.buildRuntime({
      id: old.id,
      scenario,
      options: old.createOptions,
      environmentId: old.environmentId,
      ...(old.environmentOwnerId !== undefined
        ? { environmentOwnerId: old.environmentOwnerId }
        : {}),
      trajectoryDir: old.trajectoryDir,
      trajectoryAppend: true,
    });
    built.runtime.restoreWorldState(world);

    // BUG-07: narrate every pending AC handshake on the OLD runtime as an
    // explicit ac-cancelled (reason 'runtime-rebuild') BEFORE the swap —
    // pre-fix the handshake waiters were orphaned with the old eventManager
    // and died silently (the eval funnel's unexplained
    // abandoned-before-response). The shared trajectory dir is append-mode,
    // so the cancels land in the same history the new runtime continues.
    // EngineRuntime.stop() cancels whatever remains with 'runtime-stopped'.
    old.runtime.cancelPendingACHandshakes('runtime-rebuild');

    // Release the old runtime (drivers first — nothing may schedule onto a
    // runtime that is about to go away). Hosted streams close; pins survive.
    this.stopRecord(old);

    const record = rebuiltRecordOf(old, built, scenario);
    this.records.set(record.id, record);
    this.attachSeams(record, { rehydrating: true });
    this.eventTally?.reseed?.(record.id, built.runtime, tally);
    return record;
  }

  /**
   * Living-worlds P1W: start (or keep) a session runtime in lazy mode and
   * (re)attach its due driver — the tail of wake/rebuild; the caller then
   * fast-forwards. No-op-safe on an already-running runtime.
   */
  startLazyRuntime(record: SimulationRecord, speed: number): void {
    if (record.runtime.getState() !== 'running') {
      record.runtime.start(speed, { lazy: true });
    }
    this.ensureLazyDriver(record).wakeNow();
  }

  /**
   * P2F (design-living-worlds.md §10.1, create-from-checkpoint): snapshot a
   * LIVE authoritative world session's dynamics WITHOUT stopping it — the
   * pause → awaitQuiescent → export → resume dance rebuildLiveSession uses
   * for its swap, minus the swap. The lazy driver (if attached) is
   * pause-aware: while paused it only cheap-polls. Returns the engine world
   * export + the server-side tally ring (the same pair a checkpoint file
   * carries) — the cheap fork's copy source.
   */
  async exportLiveSessionWorld(
    id: string,
    options: { quiesceTimeoutMs?: number } = {},
  ): Promise<{ world: ReturnType<EngineRuntime['exportWorldState']>; eventTally: WorldCheckpointFile['eventTally'] }> {
    const record = this.getLiveOrThrow(id);
    if (record.runtime.getState() === 'stopped') {
      throw new ApiError(
        409,
        'SIM_ALREADY_STOPPED',
        `Simulation "${id}" is already stopped — a stopped world has no live dynamics to fork. ` +
        'Create the fork from its on-disk checkpoint instead, or from the frozen scenario.',
      );
    }
    const wasRunning = record.runtime.getState() === 'running';
    record.runtime.pause();
    await record.runtime.awaitQuiescent(options.quiesceTimeoutMs ?? 10_000);
    try {
      const world = record.runtime.exportWorldState();
      const eventTally = this.eventTally?.eventsOf?.(id) ?? [];
      return { world, eventTally };
    } finally {
      // Resume only what we paused (a 'created'/already-paused runtime stays
      // as it was). resume() keeps the lazy mode sticky — the driver (still
      // attached) picks the world back up on its next poll.
      if (wasRunning) record.runtime.resume();
    }
  }

  /**
   * P2F (§10.1 便宜 fork): build a PRIVATE fork runtime seeded from a copied
   * world state — the same restore logic resumeEnvSession uses (dynamics
   * from the export/checkpoint, topology from the CALLER's scenario = the
   * env's CURRENT rows), but into a FRESH sim id with no env backing: the
   * fork is a one-way copy (§1) that never writes back. The returned record
   * is NOT started — the operator starts it like any sandbox sim
   * (POST /api/simulations/:id/start {speed}).
   */
  async createForkFromWorldState(args: {
    scenario: ScenarioDefinition;
    world: WorldCheckpointFile['world'];
    eventTally?: WorldCheckpointFile['eventTally'];
    sourceEnvId: string;
    forkId: string;
    createdBy?: string;
    /**
     * HIL P2 (shadow forks): engine create options for the fork build
     * (e.g. a deviceFactory); defaults to plain sandbox semantics.
     */
    options?: CreateSimulationOptions;
  }): Promise<SimulationRecord> {
    const id = `sim-${args.scenario.meta.id}-fork-${Date.now().toString(36)}-${++this.seq}`;
    const trajectoryDir = this.trajectoryBaseDir !== undefined
      ? join(this.trajectoryBaseDir, id)
      : undefined;

    const options = args.options ?? {}; // sandbox semantics: tick scheduling, operator-paced
    const built = await this.buildRuntime({
      id,
      scenario: args.scenario,
      options,
      ...(trajectoryDir !== undefined ? { trajectoryDir } : {}),
    });
    built.runtime.restoreWorldState(args.world);

    const record = newRecordOf({
      id,
      scenario: args.scenario,
      options,
      runtime: built.runtime,
      llm: built.llm,
      sourceEnvId: args.sourceEnvId,
      forkId: args.forkId,
      ...(args.createdBy !== undefined ? { createdBy: args.createdBy } : {}),
      ...(trajectoryDir !== undefined ? { trajectoryDir } : {}),
    });
    this.records.set(id, record);
    this.attachSeams(record);
    // countSince windows span the copy: seed the fork's ring from the copied
    // tally so injected-event counts continue, not restart.
    if (args.eventTally !== undefined && args.eventTally.length > 0) {
      this.eventTally?.reseed?.(id, built.runtime, args.eventTally);
    }
    return record;
  }

  /**
   * Living-worlds P1: the due-moment driver of a lazy sim (one per sim id,
   * idempotent). Started at creation for lazy sims and re-attached by
   * resumeHibernated; stopped on every stop path (stopRecord).
   */
  private readonly lazyDrivers = new Map<string, LazyDriverHandle>();

  private ensureLazyDriver(record: SimulationRecord): LazyDriverHandle {
    const existing = this.lazyDrivers.get(record.id);
    if (existing !== undefined) return existing;
    const driver = startLazyDriver({
      runtime: record.runtime,
      // The wall↔sim mapping uses the sim's own cadence: createOptions.tickMs
      // when given, else the engine's default (10ms, EngineRuntime ctor).
      tickMs: record.createOptions.tickMs ?? 10,
      ...(record.environmentId !== undefined && this.lazyFreshness !== undefined
        ? {
            freshnessFloorSec: () => {
              try {
                return this.lazyFreshness?.floorSecForEnv(record.environmentId!);
              } catch {
                return undefined; // store faults never break the scheduler
              }
            },
          }
        : {}),
      // Living-worlds P1W: the authoritative session's post-advance hook
      // (stale-frame recompute). Fire-and-forget safety lives in the driver.
      ...(this.advanceHooks.has(record.id)
        ? { afterAdvance: () => this.advanceHooks.get(record.id)?.() }
        : {}),
    });
    this.lazyDrivers.set(record.id, driver);
    return driver;
  }

  /**
   * Living-worlds P1W: post-advance hooks per sim id (the authoritative
   * session registers one to recompute stale cached data frames after every
   * due/floor wake). Keyed by sim id so resume/rebuild keep the hook.
   */
  private readonly advanceHooks = new Map<string, () => void>();

  /** Shared runtime assembly (delegation — see sim-registry/runtime-builder.ts). */
  private async buildRuntime(args: {
    id: string;
    scenario: ScenarioDefinition;
    options: CreateSimulationOptions;
    environmentId?: string;
    environmentOwnerId?: string;
    trajectoryDir?: string;
    trajectoryAppend?: boolean;
  }): Promise<{ runtime: EngineRuntime; llm: LlmResolution }> {
    // Living-worlds P2: the trajectory segment cap threads into every build
    // lane (create + resume/rebuild) — one knob, one default.
    return this.builder.build({
      ...args,
      ...(this.trajectorySegmentBytes !== undefined
        ? { trajectorySegmentBytes: this.trajectorySegmentBytes }
        : {}),
      // T118: thread the (optional) injected tick timer / pinned wall anchor
      // into every build lane.
      ...(this.tickTimerSeam !== undefined ? { tickTimer: this.tickTimerSeam } : {}),
      ...(this.simStartEpochMsPin !== undefined
        ? { simStartEpochMs: this.simStartEpochMsPin }
        : {}),
    }).then(built => {
      // R1 (B1-9 / P-19): env-backed sims get the stale-simulation probe —
      // when an AUTO-triggered flow UNSATs against the frozen snapshot but
      // resolves against the CURRENT environment, the run record's reason
      // carries the FLOW_STALE_SIMULATION guidance (same diagnosis the
      // manual run lane's 409 gives) instead of a bare UNSAT. Wired via the
      // runtime's existing getFlowEngine() accessor (no runtime surface
      // growth — the EngineRuntime file sits at its size ceiling).
      if (args.environmentId !== undefined && this.flowStaleProbeForEnv !== undefined) {
        const probe = this.flowStaleProbeForEnv(args.environmentId);
        if (probe !== undefined) built.runtime.getFlowEngine()?.setStaleFlowProbe(probe);
      }
      // T1 (R2, u3-F1): env-backed sims get the declaration probe — each
      // agent's CURRENT declared capabilities, re-read from the env store on
      // every run, so a capability revocation made AFTER this sim was created
      // still annotates the run (capabilityDrift) instead of silently
      // succeeding on the frozen snapshot's stale grant.
      if (args.environmentId !== undefined && this.declaredCapabilitiesForEnv !== undefined) {
        const probe = this.declaredCapabilitiesForEnv(args.environmentId);
        if (probe !== undefined) built.runtime.getFlowEngine()?.setDeclaredAgentCapabilities(probe);
      }
      return built;
    });
  }

  /**
   * R1 (B1-9): wire the stale-probe factory (post-construction seam — the
   * env store lives in the server composition, not here). Given an env id,
   * the factory returns the probe "does this flow resolve against the env's
   * CURRENT bridged scenario?" (re-reading the env on each call), or
   * undefined when the env is gone / cannot bridge.
   */
  setFlowStaleProbeForEnv(
    factory: (environmentId: string) => ((flow: FlowDefinition) => boolean) | undefined,
  ): void {
    this.flowStaleProbeForEnv = factory;
  }

  private flowStaleProbeForEnv?: (environmentId: string) => ((flow: FlowDefinition) => boolean) | undefined;

  /**
   * T1 (R2, u3-F1): wire the declaration-probe factory (same seam pattern as
   * the stale probe). Given an env id, the factory returns
   * `agentId → the agent's CURRENT declared capabilities | undefined`
   * (undefined agent = unknown, honestly no annotation), or undefined when
   * the factory is not wired (core-only harnesses).
   */
  setDeclaredCapabilitiesForEnv(
    factory: (environmentId: string) => ((agentId: string) => readonly string[] | undefined) | undefined,
  ): void {
    this.declaredCapabilitiesForEnv = factory;
  }

  private declaredCapabilitiesForEnv?:
    (environmentId: string) => ((agentId: string) => readonly string[] | undefined) | undefined;

  /**
   * T118 clock-injection seam: replace the tick loop's WALL timer for every
   * runtime this registry builds (create + every resume/rebuild lane — all
   * assemble through buildRuntime). Test observability only: with the seam
   * unset (every production path) runtimes schedule ticks on the process
   * timers exactly as before. Same late-assignment discipline as the
   * agreement-trigger seam — server.ts wires it right after construction.
   */
  setTickTimer(timer: TickTimer): void {
    this.tickTimerSeam = timer;
  }

  private tickTimerSeam?: TickTimer;

  /**
   * T118 clock-anchor discipline: PIN every runtime's wall anchor
   * (getSimStartEpochMs / checkpoint `simStartEpochMs`) so separately
   * constructed runtimes share one anchor — the precondition for the
   * bit-wise two-arm equality comparisons ("every two-runtime equality
   * comparison must share it" — getSimStartEpochMs's own contract). Tests
   * only; unset (anchor at construction) in every production path.
   */
  pinSimStartEpochMs(epochMs: number): void {
    this.simStartEpochMsPin = epochMs;
  }

  private simStartEpochMsPin?: number;

  /** Shared seam attachment (delegation — see sim-registry/seams.ts). */
  private attachSeams(
    record: SimulationRecord,
    options: { rehydrating?: boolean } = {},
  ): void {
    this.seams.attach(record, {
      ...options,
      agreementTrigger: this.agreementTrigger,
      agentEscalationBridge: this.agentEscalationBridge,
      flowNotifyExecutor: this.flowNotifyExecutor,
      flowServiceExecutor: this.flowServiceExecutor,
    });
  }

  get(id: string): SimulationRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Stop listeners (Wave-6, Fix-11/15 遗留): notified after a runtime actually
   * transitions to stopped on ANY stop path (stop / stopAndRemove /
   * stopAndRemoveForEnvironment / stopAll). The agreement stream route uses
   * this to close the sessions the simulation hosted — otherwise those
   * sockets keep heartbeating with no observations ever arriving again, and
   * the stream session is metered only when the client hangs up.
   */
  private readonly stopListeners = new Set<(record: SimulationRecord) => void>();

  onSimulationStopped(listener: (record: SimulationRecord) => void): void {
    this.stopListeners.add(listener);
  }

  /** Stop one runtime and notify the stop listeners (unless already stopped). */
  private stopRecord(record: SimulationRecord): void {
    // Living-worlds P1: the lazy driver goes first — nothing may schedule
    // work onto a runtime that is about to be released.
    const driver = this.lazyDrivers.get(record.id);
    if (driver !== undefined) {
      driver.stop();
      this.lazyDrivers.delete(record.id);
    }
    if (record.runtime.getState() === 'stopped') return;
    record.runtime.stop();
    // R30 Task 5: drain + retire the sim's batched timeline writer AFTER
    // the runtime stops (no more records can arrive) — the graceful
    // shutdown contract for the batch lane.
    closeSimTimelineWriter(record.id);
    for (const listener of this.stopListeners) {
      try {
        listener(record);
      } catch {
        // A listener must never break the stop path
      }
    }
  }

  /**
   * Living-worlds P1: nudge a lazy sim's driver to re-evaluate its due set
   * immediately (used by /start and /resume so the world reacts at once
   * instead of at the next recheck poll). No-op for tick sims and sims with
   * no driver attached.
   */
  wakeLazyDriver(id: string): void {
    this.lazyDrivers.get(id)?.wakeNow();
  }

  /**
   * The most recently created RUNNING simulation built from an environment
   * (Fix-11 invoke execution: world-layer service invocations execute inside
   * the env's live simulation runtime). Undefined when the env has no
   * running simulation — created/paused/stopped runtimes do not count.
   * Living-worlds P1W: the env's authoritative session is NOT a per-user sim
   * — it is targeted through the WorldSessionService, never through the
   * user-sim lanes.
   */
  runningForEnvironment(environmentId: string): SimulationRecord | undefined {
    let latest: SimulationRecord | undefined;
    for (const record of this.records.values()) {
      if (record.environmentId !== environmentId) continue;
      if (record.envSession === true) continue;
      if (record.runtime.getState() !== 'running') continue;
      latest = record; // Map iteration is insertion order — last match is newest
    }
    return latest;
  }

  /**
   * T-205: EVERY running simulation of an environment (insertion order).
   * Agreement invocations must target one sim explicitly when several are
   * running — the old newest-wins pick silently landed the invocation in
   * another tenant's simulation (SF-F04/FF-F08). P1W: authoritative sessions
   * excluded (see runningForEnvironment).
   */
  runningAllForEnvironment(environmentId: string): SimulationRecord[] {
    const running: SimulationRecord[] = [];
    for (const record of this.records.values()) {
      if (record.environmentId !== environmentId) continue;
      if (record.envSession === true) continue;
      if (record.runtime.getState() !== 'running') continue;
      running.push(record);
    }
    return running;
  }

  /**
   * The most recently created NON-STOPPED simulation built from an
   * environment (running, paused, or created-not-yet-started). Used by the
   * agent enable/disable sync (PATCH /api/agents/:id) — setAgentEnabled
   * works on any live runtime, and a toggle landing between creation and
   * start must not be lost. P1W: sessions excluded (agent toggles ride env
   * rows into the next session rebuild instead).
   */
  activeForEnvironment(environmentId: string): SimulationRecord | undefined {
    let latest: SimulationRecord | undefined;
    for (const record of this.records.values()) {
      if (record.environmentId !== environmentId) continue;
      if (record.envSession === true) continue;
      if (record.runtime.getState() === 'stopped') continue;
      latest = record; // Map iteration is insertion order — last match is newest
    }
    return latest;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Look up a simulation or throw the standard 404. */
  getOrThrow(id: string): SimulationRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new ApiError(404, 'SIMULATION_NOT_FOUND', `Simulation "${id}" not found`);
    }
    return record;
  }

  /**
   * Living-worlds P0: a LIVE record or a teaching 409 — a hibernated sim
   * exists but has no runtime, so runtime-touching routes must explain
   * (resume first) instead of a misleading 404.
   */
  getLiveOrThrow(id: string): SimulationRecord {
    const record = this.records.get(id);
    if (record !== undefined) return record;
    if (this.hibernatedRecords.has(id)) {
      throw new ApiError(
        409,
        'SIM_HIBERNATED',
        `Simulation "${id}" is hibernated — its world is frozen in a checkpoint and has no ` +
          'live runtime. Resume it first (POST /api/simulations/' + id + '/resume) to interact with it again.',
      );
    }
    throw new ApiError(404, 'SIMULATION_NOT_FOUND', `Simulation "${id}" not found`);
  }

  /** Living-worlds P0: the hibernated record of a sim, if it is hibernated. */
  getHibernated(id: string): HibernatedSimulationRecord | undefined {
    return this.hibernatedRecords.get(id);
  }

  /**
   * Living-worlds P0 (design-living-worlds.md §9): hibernate one simulation —
   * freeze the world into a checkpoint and release the runtime (zero timers,
   * zero subscriptions, zero heap; T-013 proved stop() releases cleanly).
   *
   * SIM_CLOCK surfaces only: a scenario with `hass://` bindings mirrors real
   * hardware — its world has real-time obligations and stays HOT (refused
   * with a teaching message; stop() remains the teardown path).
   *
   * The freeze happens at a CLEAN sim-time boundary: pause() clears the tick
   * timer, awaitQuiescent() waits out an in-flight tick body / event
   * delivery, and only then is the world exported.
   */
  async hibernate(
    id: string,
    options: { quiesceTimeoutMs?: number } = {},
  ): Promise<HibernatedSimulationRecord> {
    const record = this.getOrThrow(id);
    if (record.scenario.devices.some(d => d.binding.startsWith('hass://'))) {
      throw new ApiError(
        409,
        'REAL_DEVICE_SURFACE',
        `Simulation "${id}" binds real devices (hass://) — its world mirrors live hardware ` +
        'and must stay hot; it cannot be hibernated. Real-device surfaces keep their ' +
        'obligations (never spin down); stop it with POST /api/simulations/' + id + '/stop ' +
        'when you are done.',
      );
    }
    if (record.runtime.getState() === 'stopped') {
      throw new ApiError(
        409,
        'SIM_ALREADY_STOPPED',
        `Simulation "${id}" is already stopped — a stopped runtime cannot hibernate. ` +
        'Stopped sims stay queryable but are final; create a new simulation to run again.',
      );
    }
    if (record.trajectoryDir === undefined) {
      throw new ApiError(
        409,
        'NO_TRAJECTORY_DIR',
        `Simulation "${id}" records nowhere on disk — a checkpoint needs a trajectory dir ` +
        'to live in (hibernation without durable state is just stop()). Configure the ' +
        'server trajectory base dir (EAF_TRAJECTORY_DIR) or create the simulation with ' +
        'options.trajectoryDir.',
      );
    }

    // Clean boundary: no tick mid-flight, no event mid-delivery.
    record.runtime.pause();
    await record.runtime.awaitQuiescent(options.quiesceTimeoutMs ?? 10_000);

    const checkpoint = hibernateCheckpoint(
      record,
      record.runtime.exportWorldState(),
      // The tally ring is server-side state the engine export cannot see —
      // countSince windows must span the boundary (data services).
      this.eventTally?.eventsOf?.(record.id) ?? [],
    );
    const metadata = writeWorldCheckpoint(record.trajectoryDir, checkpoint);

    // Persist learned reputation (env-backed, same as stop) BEFORE release.
    if (record.environmentId !== undefined) {
      this.seams.persistReputation(record.environmentId, record.runtime);
      // R6-E-F15: private experience rides out with the same discipline.
      this.seams.persistExperiences(record.environmentId, record.runtime);
    }
    // T-013-clean release: stop() clears timers/subscriptions/samplers and
    // notifies the stop listeners (agreement stream sessions close).
    this.stopRecord(record);

    const hibernated = hibernatedRecordFrom(record, metadata);
    this.records.delete(record.id);
    this.hibernatedRecords.set(record.id, hibernated);
    return hibernated;
  }

  /**
   * Living-worlds P0: resume a hibernated simulation — rebuild the runtime
   * from the checkpoint (same sim id, same trajectory dir, history appended,
   * NOT truncated), adopt the frozen world state, and continue running at
   * the checkpointed speed. Deterministic by construction: the engine
   * replays due moments (scheduler sets, pending effect checks, flow
   * trigger memories) and re-seeds the fault RNG; nothing depends on
   * wall-clock accidents.
   */
  async resumeHibernated(
    id: string,
    options: { speed?: number } = {},
  ): Promise<SimulationRecord> {
    const hibernated = this.hibernatedRecords.get(id);
    if (hibernated === undefined) {
      throw new ApiError(404, 'SIMULATION_NOT_HIBERNATED', `Simulation "${id}" is not hibernated`);
    }
    const checkpoint: WorldCheckpointFile = readWorldCheckpoint(hibernated.checkpoint.path);

    const built = await this.buildRuntime({
      id: hibernated.id,
      scenario: checkpoint.scenario, // the checkpoint's copy is the frozen truth
      options: hibernated.createOptions,
      ...(hibernated.environmentId !== undefined ? { environmentId: hibernated.environmentId } : {}),
      ...(hibernated.environmentOwnerId !== undefined ? { environmentOwnerId: hibernated.environmentOwnerId } : {}),
      trajectoryDir: hibernated.trajectoryDir,
      trajectoryAppend: true, // history continues — never truncate
    });
    built.runtime.restoreWorldState(checkpoint.world);

    const record = resumedRecordOf(hibernated, built, {
      scenario: checkpoint.scenario,
      // R37-F1: the generic /resume of a HIBERNATED WORLD SESSION keeps the
      // envSession marker — the deterministic id convention is the truth
      // here (createEnvSession owns it). Losing the marker made every later
      // session operation refuse the record (NOT_A_WORLD_SESSION) and the
      // world-session service wedge behind it (validation F1).
      envSession:
        hibernated.environmentId !== undefined &&
        hibernated.id === `sim-${hibernated.environmentId}-world-session`,
    });
    this.records.set(record.id, record);
    this.attachSeams(record, { rehydrating: true });
    // countSince windows span the boundary: re-attach the tally to the NEW
    // runtime with the checkpointed ring seeded back in.
    this.eventTally?.reseed?.(record.id, built.runtime, checkpoint.eventTally);
    this.hibernatedRecords.delete(record.id);

    if (record.scheduling === 'lazy') {
      // Due-driven resume: no tick timer; the driver (re-attached after the
      // stop at hibernate) advances from the checkpoint's sim-time.
      record.runtime.start(options.speed ?? checkpoint.world.speed, { lazy: true });
      this.ensureLazyDriver(record).wakeNow();
    } else {
      record.runtime.start(options.speed ?? checkpoint.world.speed);
    }
    return record;
  }

  /**
   * Living-worlds P0: discard a hibernated simulation (the /stop semantics
   * for a frozen world) — drop the record and its registry-managed disk.
   */
  discardHibernated(id: string): void {
    const hibernated = this.hibernatedRecords.get(id);
    if (hibernated === undefined) return;
    this.hibernatedRecords.delete(id);
    this.advanceHooks.delete(id);
    this.deleteTrajectoryDir(id);
  }

  /**
   * S3 (Task 3): cross-process resume — adopt an on-disk world checkpoint
   * written by a PREVIOUS process as a lightweight hibernated record (no
   * runtime, no timers; identity + checkpoint metadata + the plain data the
   * wake path needs). The existing P1W machinery then takes over: the next
   * arrival wakes the record (resumeEnvSession rebuilds from CURRENT env
   * topology, drift machinery included) and fast-forwards to wall-now.
   *
   * Teaching errors from readWorldCheckpoint (corrupt / foreign version)
   * propagate — the boot scan catches and warns per checkpoint, never
   * blocking startup. Returns undefined when the sim id is already known
   * (live or hibernated) so the scan is idempotent.
   */
  adoptHibernatedCheckpoint(
    path: string,
    args: { environmentOwnerId?: string } = {},
  ): { record: HibernatedSimulationRecord; simStartEpochMs: number } | undefined {
    const checkpoint = readWorldCheckpoint(path);
    if (this.records.has(checkpoint.simId) || this.hibernatedRecords.has(checkpoint.simId)) {
      return undefined;
    }
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      // Unreadable size — the metadata reports 0; the wake path re-reads the
      // file itself and fails loudly if it is actually gone.
    }
    const record = adoptedRecordFrom(path, bytes, checkpoint, args);
    this.hibernatedRecords.set(record.id, record);
    return { record, simStartEpochMs: checkpoint.world.simStartEpochMs };
  }

  list(): SimulationSummary[] {
    const summaries: SimulationSummary[] = [...this.records.values()]
      // P1W: the env-owned authoritative session is surfaced through the
      // environment detail (`worldSession`) + its own status views, not the
      // per-user simulation list.
      .filter(record => record.envSession !== true)
      .map(liveSummaryOf);
    // Living-worlds P0: hibernated sims appear with state 'hibernated' and
    // their checkpoint metadata (frozen sim time, bytes, path). P1W: the
    // env-owned session stays off the per-user list here too.
    for (const hibernated of this.hibernatedRecords.values()) {
      if (
        hibernated.environmentId !== undefined &&
        hibernated.id === `sim-${hibernated.environmentId}-world-session`
      ) {
        continue; // the authoritative session — surfaced via env detail
      }
      summaries.push(hibernatedSummaryOf(hibernated));
    }
    return summaries;
  }

  /**
   * C5 (T-087, HO26-F06 — DevLoop R28): the per-user list PLUS every env's
   * authoritative world session (live or hibernated), each marked
   * `platformOwned: true`. `list()` keeps its session-free contract (the
   * /me dashboard and quota lanes); GET /api/simulations uses this so the
   * `sim-<envId>-world-session` id is finally DISCOVERABLE where consumers
   * look for sim ids — addressable-but-invisible was the R26 finding. The
   * session rows follow the same environment read gate the route already
   * applies (members see it; per-user isolation semantics unchanged).
   */
  listIncludingEnvSessions(): SimulationSummary[] {
    // T82 (R9, u3-F1): session rows carry `kind: 'world-session'` beside
    // platformOwned — the roster face (and any API consumer) can label the
    // row as the env's authoritative session, not just "platform-owned".
    const summaries: SimulationSummary[] = [...this.records.values()]
      .filter(record => record.envSession === true)
      .map(record => ({
        ...liveSummaryOf(record),
        platformOwned: true as const,
        kind: 'world-session' as const,
      }));
    for (const hibernated of this.hibernatedRecords.values()) {
      if (
        hibernated.environmentId !== undefined &&
        hibernated.id === `sim-${hibernated.environmentId}-world-session`
      ) {
        summaries.push({
          ...hibernatedSummaryOf(hibernated),
          platformOwned: true as const,
          kind: 'world-session' as const,
        });
      }
    }
    return [...this.list(), ...summaries];
  }

  /**
   * Live (running or paused) simulations created by one user — the
   * running_sims_per_user quota usage (P4-4). Mirrors the workbench's
   * LIVE_SIM_STATES; anonymous creations belong to no one.
   */
  countLiveByUser(userId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.createdBy !== userId) continue;
      const state = record.runtime.getState();
      if (state === 'running' || state === 'paused') count += 1;
    }
    return count;
  }

  /** Simulation counts grouped by runtime state (P4-4 observability). */
  countsByState(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of this.records.values()) {
      const state = record.runtime.getState();
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Phase 3 (NL interface): every LIVE simulation whose runtime contains the
   * given agent id — the resolution lane behind POST /api/agents/:id/command
   * and /ask. Agent ids are unique per scenario, but the same environment can
   * run in several sims at once (private forks + the world session), so the
   * route disambiguates with the caller's body `simId` when more than one
   * match exists.
   *
   * T52 (R6, u1-F6/F5): a STOPPED sim is not a candidate — its runtime
   * object still sits in the registry map, and counting it made every
   * ask/what-if eat a 409 naming sims that refuse every command
   * ("已停 sim 仍算 live"; executeDeviceCommand asserts not-stopped and
   * fails there). 'created' (built but never started) and 'paused' runtimes
   * CAN still execute device commands, so the candidate set here is
   * everything-but-stopped — deliberately wider than the quota's
   * running/paused resource count (countLiveByUser).
   */
  findLiveRecordsByAgent(agentId: string): SimulationRecord[] {
    const matches: SimulationRecord[] = [];
    for (const record of this.records.values()) {
      if (record.runtime.getState() === 'stopped') continue;
      if (record.runtime.getAgent(agentId) !== undefined) matches.push(record);
    }
    return matches;
  }

  /**
   * T98 (R15, u4-F1): every LIVE (everything-but-stopped, the same candidate
   * caliber findLiveRecordsByAgent speaks) record — the NL seam's short-id
   * prefix scan iterates these. A snapshot on purpose: the caller resolves
   * prefixes against the runtimes' own agent id lists in one pass.
   */
  liveRecords(): SimulationRecord[] {
    const live: SimulationRecord[] = [];
    for (const record of this.records.values()) {
      if (record.runtime.getState() !== 'stopped') live.push(record);
    }
    return live;
  }

  /** Shared LLM response-cache stats (P4-2 cache, surfaced by P4-4 metrics). */
  llmCacheStats(): LLMCacheStats {
    return this.llmCache.getStats();
  }

  /**
   * Triage counters summed across every registered simulation (P4-4
   * observability). Reads each runtime's snapshot llm.triage block; sims
   * whose snapshot is unavailable (e.g. mid-teardown) are skipped.
   */
  triageTotals(): {
    triageCalls: number;
    triageErrors: number;
    agreements: number;
    disagreements: number;
    bigModelCalls: number;
    bigModelCallsSaved: number;
  } {
    const totals = {
      triageCalls: 0,
      triageErrors: 0,
      agreements: 0,
      disagreements: 0,
      bigModelCalls: 0,
      bigModelCallsSaved: 0,
    };
    for (const record of this.records.values()) {
      try {
        const triage = record.runtime.getSnapshot().llm?.triage;
        if (!triage) continue;
        totals.triageCalls += triage.triageCalls;
        totals.triageErrors += triage.triageErrors;
        totals.agreements += triage.agreements;
        totals.disagreements += triage.disagreements;
        totals.bigModelCalls += triage.bigModelCalls;
        totals.bigModelCallsSaved += triage.bigModelCallsSaved;
      } catch {
        // Snapshot unavailable for this record — skip it
      }
    }
    return totals;
  }

  /**
   * Per-simulation runtime health (R15-A3 observability): tick cost, throttle
   * flag and agent activity for every registered simulation. The soak probe
   * (R15-A1) samples this to prove tick cost does not drift over a long run
   * and that agents keep processing events (F-24 regression guard). Sims
   * whose snapshot is unavailable (mid-teardown) are skipped.
   */
  runtimeHealth(): Array<{
    id: string;
    scenarioId: string;
    environmentId?: string;
    state: EngineRuntimeState;
    simTimeSec: number;
    tickCount: number;
    tickWallMs?: number;
    autoThrottled?: boolean;
    /** Sum over agents — events pushed through the decision layer. */
    agentEventsProcessed: number;
    /** Sum over agents — collaborations currently in flight. */
    activeACCount: number;
    /** Length of the bounded recent-decision ring — decision liveness. */
    recentDecisionCount: number;
  }> {
    const entries: ReturnType<SimulationRegistry['runtimeHealth']> = [];
    for (const record of this.records.values()) {
      try {
        const snapshot = record.runtime.getSnapshot();
        entries.push({
          id: record.id,
          scenarioId: record.scenarioId,
          ...(record.environmentId !== undefined ? { environmentId: record.environmentId } : {}),
          state: snapshot.state,
          simTimeSec: snapshot.simTimeSec,
          tickCount: snapshot.tickCount,
          ...(snapshot.tickWallMs !== undefined ? { tickWallMs: snapshot.tickWallMs } : {}),
          ...(snapshot.autoThrottled !== undefined ? { autoThrottled: snapshot.autoThrottled } : {}),
          agentEventsProcessed: snapshot.agents.reduce((sum, agent) => sum + agent.eventsProcessed, 0),
          activeACCount: snapshot.agents.reduce((sum, agent) => sum + agent.activeACCount, 0),
          recentDecisionCount: snapshot.recentDecisions.length,
        });
      } catch {
        // Snapshot unavailable for this record — skip it
      }
    }
    return entries;
  }

  /**
   * Stop AND remove every runtime built from an environment (called before
   * the environment row is deleted — the world no longer exists, so its
   * simulations are not kept queryable).
   */
  stopAndRemoveForEnvironment(environmentId: string): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.environmentId !== environmentId) continue;
      try {
        this.stopRecord(record);
      } catch {
        // Already stopped or half-built — remove anyway
      }
      this.records.delete(id);
      this.advanceHooks.delete(id);
      this.deleteTrajectoryDir(id); // T-011: the record is gone, so is its disk
      removed += 1;
    }
    // Living-worlds P0: the environment's hibernated worlds die with it too
    // (env deletion cascades — the checkpoint has no env to resume into).
    for (const [id, hibernated] of this.hibernatedRecords) {
      if (hibernated.environmentId !== environmentId) continue;
      this.hibernatedRecords.delete(id);
      this.deleteTrajectoryDir(id);
      removed += 1;
    }
    return removed;
  }

  /**
   * Stop one simulation (idempotent; the record stays queryable). Persists
   * learned reputation + private experience first for environment-backed
   * sims (P4-1 / R6-E-F15).
   */
  stop(id: string): void {
    const record = this.getOrThrow(id);
    if (record.environmentId !== undefined) {
      this.seams.persistReputation(record.environmentId, record.runtime);
      this.seams.persistExperiences(record.environmentId, record.runtime);
    }
    this.stopRecord(record);
    this.pruneStoppedRecords();
  }

  /**
   * DevLoop: 'created' and 'stopped' sims accumulate without bound — only
   * running|paused count toward the quota, and stop() keeps records
   * queryable. Prune the OLDEST stopped records beyond a retention cap so
   * the registry doesn't grow indefinitely in long-lived server processes.
   * Called opportunistically after each stop(); idempotent. T-011: a pruned
   * record also loses its trajectory dir — the record (and with it every
   * route that could read the dir) is gone, so the disk follows.
   */
  private static readonly MAX_STOPPED_RECORDS = 50;
  private pruneStoppedRecords(): void {
    const stopped: Array<[string, SimulationRecord]> = [];
    for (const [id, record] of this.records) {
      if (record.runtime.getState() === 'stopped') stopped.push([id, record]);
    }
    if (stopped.length <= SimulationRegistry.MAX_STOPPED_RECORDS) return;
    // Sort by creation time ascending (oldest first), remove the excess.
    stopped.sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
    const excess = stopped.length - SimulationRegistry.MAX_STOPPED_RECORDS;
    for (let i = 0; i < excess; i++) {
      const id = stopped[i]![0];
      this.records.delete(id);
      this.deleteTrajectoryDir(id);
    }
  }

  /**
   * Stop one simulation AND remove its record (P-C sandbox teardown).
   * Unlike stop(), the record is NOT kept queryable — a stopped sandbox is
   * gone. Idempotent: an unknown id is a no-op.
   */
  stopAndRemove(id: string): void {
    // Living-worlds P0: a hibernated sim discards (record + disk) — there is
    // no runtime to stop.
    if (this.hibernatedRecords.has(id)) {
      this.discardHibernated(id);
      return;
    }
    const record = this.records.get(id);
    if (!record) return;
    if (record.environmentId !== undefined) {
      this.seams.persistReputation(record.environmentId, record.runtime);
      this.seams.persistExperiences(record.environmentId, record.runtime);
    }
    try {
      this.stopRecord(record);
    } catch {
      // Already stopped or half-built — remove anyway
    }
    this.records.delete(id);
    this.deleteTrajectoryDir(id); // T-011: sandbox teardown takes its disk too
  }

  /** Stop every runtime (idempotent per runtime). Used on server shutdown. */
  stopAll(): void {
    if (this.catalogReconcileTimer !== undefined) {
      clearInterval(this.catalogReconcileTimer);
      this.catalogReconcileTimer = undefined;
    }
    for (const record of this.records.values()) {
      try {
        if (record.environmentId !== undefined) {
          this.seams.persistReputation(record.environmentId, record.runtime);
          this.seams.persistExperiences(record.environmentId, record.runtime);
        }
        this.stopRecord(record);
      } catch {
        // Already stopped or half-built — keep stopping the rest
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** T-011 disk GC delegation (see sim-registry/trajectory-gc.ts). */
  private deleteTrajectoryDir(simId: string): void {
    deleteTrajectoryDirUnder(this.trajectoryBaseDir, simId);
  }

  /** S3 (Task 2) fork-activity signal (see sim-registry/trajectory-gc.ts). */
  lastDiskActivityMs(simId: string): number {
    return lastDiskActivityMsUnder(this.trajectoryBaseDir, simId);
  }
}
