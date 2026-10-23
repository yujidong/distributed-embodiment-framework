/**
 * World session service (living-worlds P1W, design-living-worlds.md §4.3/§6/§9)
 *
 * The authoritative world session — the environment's own living instance.
 * Every environment can have AT MOST one; it is created ON DEMAND (the first
 * arrival that needs the world's "now": a data read / data stream with no
 * explicit simulationId, an agreement activation that installs a freshness
 * obligation), and never through the public create-simulation route.
 *
 * Lifecycle (design §9):
 *
 *   ACTIVE     observers > 0 (live WS subscriptions on the session, in-flight
 *              reads, open env world-stream connections when a session
 *              exists). The runtime is running in LAZY mode and MATERIALIZES
 *              the world to wall-now on every arrival (醒来即追平).
 *   IDLE       no observers; due-driven only (P1 machinery — between due
 *              moments the session costs nothing but the driver's recheck
 *              poll). Entered after a grace period; may hibernate.
 *   HIBERNATED no observers + no near dues + no obligations: checkpoint
 *              written (P0 machinery), runtime released. The next arrival
 *              restores + FAST-FORWARDS (§6.3).
 *
 * Obligation worlds NEVER hibernate (design §5): environments with hass://
 * bound devices (real-device surfaces) or active actuation-obligation
 * agreements (terms.trigger + terms.action, the T-035 auto-execution
 * contract). Environments with an active terms.read.minFreshnessSec floor
 * also stay resident (IDLE) — the freshness contract is a standing wall
 * obligation (§8.5).
 *
 * WALL MAPPING DECISION (the question P1 flagged): the authoritative session
 * is WALL-ANCHORED at WALL-RATE — 1 sim-sec per wall-sec at speed 1. The
 * session runtime is created with `tickMs: 1000` + lazy scheduling, so the
 * driver's mapping (speed × 1000 / tickMs) equals the speed knob verbatim:
 * speed 1 == wall-rate, speed N == N sim-sec per wall-sec (the reserved
 * knob). This is NOT the per-user tick default (tickMs 10 ⇒ speed 1 ==
 * 100× wall): the authoritative world's "now" must track the wall clock
 * because its dues are scheduled against the world's own timeline while
 * users arrive and leave on wall time (§5.1: 世界的"现在"就是墙上的现在).
 *
 * Fast-forward (§6.3, the P0-named seam): hibernated session + arrival =
 * read checkpoint (dynamics) + rebuild topology from CURRENT env rows
 * (schema drift resolves to current topology with a teaching warning —
 * T-037 semantics) + advanceTo(wall-mapped now) — executing every due
 * moment in the window EXACTLY ONCE (P1's advanceTo) + recompute stale
 * cached data frames. Between dues the empty window costs nothing; the
 * first arrival pays once.
 *
 * This module is deliberately store-free: the server injects narrow ports
 * (scenario provider, obligation predicate, freshness floor, frame
 * recompute) so the lifecycle logic is unit-testable without Fastify.
 */

import type { EngineRuntimeState, ScenarioDefinition } from '@active-collaboration/core';

import { createLogger } from '@active-collaboration/shared';

import { ApiError } from './errors.js';
import type { SimulationRecord, SimulationRegistry } from './simulation-registry.js';
import { readWorldCheckpoint } from './world-checkpoint.js';

const logger = createLogger('WorldSession');

/** Session lifecycle states (design §9's HOT/WARM/HIBERNATED, P1W naming). */
export type WorldSessionStatus = 'active' | 'idle' | 'hibernated';

/** The `worldSession` block on the env detail + the stream status frames. */
export interface WorldSessionStatusView {
  status: WorldSessionStatus;
  simTimeSec: number;
  simulationId: string;
  /**
   * T-073 (R22): the session's time-compression knob — sim-seconds per
   * wall-second (default 1 = wall-rate). Carried in ALL states so clients
   * can map sim deadlines to wall moments (EAF_WORLD_SESSION_SIM_PER_WALL_SEC).
   */
  simPerWallSec: number;
  /**
   * T-410 (R19, NW-F08): the WALL anchor — the epoch ms sim-time 0 maps
   * to. Wall-aligned scheduling (a "3AM sweep" = anchor + 3*3600*1000 −
   * simTimeSec*1000/rate) no longer needs a now−simTime sample with ±s
   * error. Carried in ALL states: hibernated views keep the checkpoint's
   * anchor (the wake path restores the same value — restoreWorldState
   * adopts it), so the mapping never jumps across a hibernate boundary.
   */
  simStartEpochMs?: number;
  /**
   * T82 (R9, u3-F1): the session RUNTIME's state — the SAME word the sim
   * roster and the AGENT_AMBIGUOUS candidates speak ('running'/'paused'/…;
   * 'hibernated' when the runtime is released). The session's own `status`
   * above is the ATTENTION lifecycle (observers pin it 'active'; unobserved
   * worlds demote to 'idle' while the runtime keeps advancing — never a
   * "not running" verdict). Carrying both kills the three-face split where
   * AGENT_AMBIGUOUS said "running" and `env session status` said "idle"
   * about the same moment.
   */
  state?: EngineRuntimeState | 'hibernated';
  /** Present while live: named observer pins (streams, in-flight reads). */
  observers?: number;
  /** Present when hibernated: the checkpoint's sim-time boundary. */
  checkpointAtSec?: number;
  /** Present when hibernated: freeze stamp (ISO). */
  hibernatedAt?: string;
  /**
   * R6-A-F02: the wall moment the displayed `simTimeSec` corresponds to
   * (ISO) — wall-anchor arithmetic (simStartEpochMs + simTimeSec ×
   * 1000/simPerWallSec), NOT the read time, so two reads of a frozen
   * display agree bit-wise. An idle world's display only advances on
   * catch-up arrivals: a lagging asOf tells observers "frozen display,
   * live world" apart from "world stopped". A hibernated view's asOf is
   * the freeze stamp itself.
   */
  asOf?: string;
  /** Present while the env schema drifted across a hibernate/wake boundary. */
  driftWarning?: string[];
  /**
   * 分层追平进行中（粗精度快进，T129 后台链仍在跑）：追平目标、当前 sim
   * 时间与所处层（coarse=远旧区段粗推 / precise=近段全精度）。additive —
   * 仅在追平活跃时出现；调用方据 `currentSimSec/targetSimSec` 渲染进度。
   */
  catchUpProgress?: {
    targetSimSec: number;
    currentSimSec: number;
    phase: 'coarse' | 'precise';
    startedAt: string;
  };
}

export interface WorldSessionDeps {
  registry: SimulationRegistry;
  /** Bridge the env's CURRENT rows to a scenario (env owns topology). May throw. */
  scenarioOfEnv: (envId: string) => ScenarioDefinition;
  envOwnerIdOf: (envId: string) => string | undefined;
  /**
   * Obligation predicates (design §5): worlds that never spin down. Both are
   * re-read at every hibernate evaluation.
   */
  obligationsOf: (envId: string) => { hassBound: boolean; actuationAgreement: boolean };
  /** The TIGHTEST active terms.read.minFreshnessSec for the env (§8.5). */
  freshnessFloorSecForEnv?: (envId: string) => number | undefined;
  /**
   * Recompute stale cached data frames after an advance (the platform-side
   * half of the minFreshnessSec deadline). Never throws upward.
   */
  recomputeStaleFrames?: (envId: string, record: SimulationRecord) => void;
  /** Status transition broadcast (the env world stream). */
  onStatusChange?: (envId: string, view: WorldSessionStatusView) => void;
  /** Clock (injectable for deterministic tests; default real time). */
  nowMs?: () => number;
  /**
   * WALL-RATE: sim-seconds per wall-second (default 1 — the mapping
   * decision above; the reserved speed knob).
   */
  simPerWallSec?: number;
  /** Idle grace before a hibernate evaluation may run (default 60s). */
  idleGraceMs?: number;
  /**
   * Hibernate horizon in SIM seconds: a world with a due moment within this
   * horizon of its own timeline stays resident (default 3600).
   */
  hibernateHorizonSimSec?: number;
  /**
   * Attach the lazy due-driver to session runtimes (default true). The
   * equivalence test drives advancement itself with an injected clock.
   */
  attachDriver?: boolean;
  /**
   * Test seam (the clock-anchor discipline): invoked with each freshly
   * created session record BEFORE it is started — the equivalence test
   * restores a t=0 world export here so both comparison arms share
   * simStartEpochMs (never compare separately constructed worlds bit-wise).
   */
  onSessionCreated?: (record: SimulationRecord) => Promise<void> | void;
  /**
   * S3 (Task 3): locate a world-session checkpoint a PREVIOUS process left
   * on disk for this env (`<trajectoryDir>/sim-<envId>-world-session/
   * checkpoint.json`), or undefined. Consulted by the LAZY-REBIND path when
   * no in-memory session exists — the arrival then wakes the checkpoint
   * (history intact) instead of materializing a fresh world at t=0.
   */
  findHibernatedCheckpoint?: (envId: string) => string | undefined;
  /**
   * T129 (R21-F1): how long `ensureCaughtUp` waits synchronously on the
   * catch-up before the advance finishes in the background (default
   * CATCH_UP_SYNC_WAIT_MS). Injectable so suites exercise the detach with
   * a small value.
   */
  catchUpSyncWaitMs?: number;
  /**
   * 分层追平（粗精度快进）四个旋钮，全部可注入（缺省见同名常量）：
   * - catchUpCoarseMinGapSimSec：缺口超过该值才启用粗推层（默认 1 天）；
   * - catchUpPreciseTailSimSec：追平目标之前保持全精度的近段（默认 1 小时）
   *   ——到达的观察者读到的最近历史与逐 tick 运行逐位一致；
   * - catchUpCoarseStrideSimSec：远旧区段两个 due 时刻之间的最大步长
   *   （默认 3600）；
   * - catchUpCoarseSubstepSimSec：粗推物理子步 dt（默认 30s——idle 层
   *   验证过的 10s 的 3×，实测容差见 docs/lifecycles/world-session.md；
   *   调大是文档化的容差权衡）。
   * 速率目标的调节手段就是 stride/substep 这对旋钮（默认远旧段实测
   * ≥1000 sim-sec/s，见 docs/lifecycles/world-session.md）。
   */
  catchUpCoarseMinGapSimSec?: number;
  catchUpPreciseTailSimSec?: number;
  catchUpCoarseStrideSimSec?: number;
  catchUpCoarseSubstepSimSec?: number;
}

/** One fairness chunk of a fast-forward (mirrors the lazy driver's cap). */
const FAST_FORWARD_CHUNK_SIM_SEC = 3600;

/**
 * T129 (R21-F1): how long `ensureCaughtUp` may SYNCHRONOUSLY wait on the
 * catch-up before letting it finish in the background. The r20/r21 outage
 * shape: a world hours behind wall (93-partition campus, wall-rate) needs
 * tens of thousands of sim-seconds fast-forwarded; every consumption-lane
 * caller awaited that whole advance behind the per-env FIFO, so the public
 * gateway answered a bare 504 while the platform looked dead (active=0 —
 * rule-lane agents never touch the LLM). The catch-up itself is honest and
 * must COMPLETE (the world never lies, never jumps): past this cap the
 * caller gets the live record while the advance keeps running detached.
 * Healthy arrivals (gap ≪ cap) still get a fully-caught-up world, exactly
 * as before the cap existed. 10s ≪ the routes' 90s consumption wait floor.
 */
const CATCH_UP_SYNC_WAIT_MS = 10_000;

/** Serialize-queue waits past this are WARNed with the duration (T129 observability). */
const SERIALIZE_QUEUE_WARN_MS = 1_000;

/** Catch-up progress lines every this many chunks when the advance is long. */
const CATCH_UP_PROGRESS_EVERY_CHUNKS = 12;

/**
 * 分层追平（粗精度快进）缺省旋钮。缺口超过 COARSE_MIN_GAP 时，目标之前
 * PRECISE_TAIL 以外的远旧区段用粗精度快进（core advanceTo 的
 * coarseStrideSec/coarseSubstepSec 通道）：due 时刻逐一如实触发，只有
 * 两个 due 之间的物理大步长推进——等价臂的实质（懒世界醒来的时刻与持续
 * 运行相同）不变，粗推段的物理读数容差文档化在
 * docs/lifecycles/world-session.md。
 */
const CATCH_UP_COARSE_MIN_GAP_SIM_SEC = 86_400; // 1 天积压才启用粗推层
const CATCH_UP_PRECISE_TAIL_SIM_SEC = 3_600; // 最近 1 小时保持全精度
const CATCH_UP_COARSE_STRIDE_SIM_SEC = 3_600; // 远旧段两个 due 之间最大 1 sim-时/步
// 粗物理子步缺省 30s：idle 层验证过的 10s 的 3×——实测（scripts/
// catchup-coarse-bench.mjs，1 天逐 2h 检查点）最大瞬态温度偏差 ≤0.01°C、
// 24-zone 7.5 天全程温度有界，速率约为 dt=10 的 2.7×；调大是文档化的
// 容差权衡（显式 dt 参数化场模型）。
const CATCH_UP_COARSE_SUBSTEP_SIM_SEC = 30;

interface SessionState {
  envId: string;
  simId: string;
  status: WorldSessionStatus;
  /** Named observer pins: WS streams, in-flight reads, env stream sockets. */
  observers: number;
  demotionTimer?: NodeJS.Timeout;
  hibernatedAt?: string;
  checkpointAtSec?: number;
  /** T-410: the wall anchor captured at hibernate (the checkpoint's own). */
  simStartEpochMs?: number;
  driftWarning?: string[];
  /** 追平进行中（T129 后台链）：视图透出为 catchUpProgress。 */
  catchUp?: { targetSimSec: number; phase: 'coarse' | 'precise'; startedAt: string };
}

/** Teaching-grade drift notes between the checkpoint's topology and now. */
export function scenarioDriftNotes(
  before: ScenarioDefinition,
  after: ScenarioDefinition,
): string[] {
  const notes: string[] = [];
  const zoneIds = (s: ScenarioDefinition) => s.zones.map(z => z.id);
  const deviceKey = (d: { id: string; type: string; binding?: string }) =>
    `${d.id}:${d.type}:${d.binding ?? ''}`;
  const agentIds = (s: ScenarioDefinition) => s.agents.map(a => a.id);
  const eventIds = (s: ScenarioDefinition) => s.events.map(e => e.id);

  const diff = (beforeList: string[], afterList: string[], noun: string): void => {
    const added = afterList.filter(id => !beforeList.includes(id));
    const removed = beforeList.filter(id => !afterList.includes(id));
    for (const id of added) notes.push(`${noun} "${id}" was added to the environment while the world was away`);
    for (const id of removed) notes.push(`${noun} "${id}" was removed from the environment while the world was away`);
  };
  diff(zoneIds(before), zoneIds(after), 'zone');
  diff(
    before.devices.map(deviceKey),
    after.devices.map(deviceKey),
    'device',
  );
  diff(agentIds(before), agentIds(after), 'agent');
  diff(eventIds(before), eventIds(after), 'scheduled event');
  return notes;
}

export class WorldSessionService {
  private readonly sessions = new Map<string, SessionState>();
  /** Per-env operation serialization (wake/rebuild/hibernate never overlap). */
  private readonly ops = new Map<string, Promise<unknown>>();
  /**
   * T129: per-env BACKGROUND catch-up chain — the potentially-unbounded
   * fast-forward runs here, OUTSIDE the ops chain, so a giant advance can
   * never head-of-line-block wake/rebuild/observe/targeting again (the r21
   * outage shape: the queue head was a hours-long catch-up and every later
   * op waited it out). Callers wait at most catchUpSyncWaitMs via
   * `awaitCatchUp`; the advance itself always completes.
   */
  private readonly catchUps = new Map<string, Promise<void>>();
  /** A background catch-up is queued (not yet started) — coalesces storms. */
  private readonly catchUpQueued = new Set<string>();
  private readonly catchUpSyncWaitMs: number;
  private readonly catchUpCoarseMinGapSimSec: number;
  private readonly catchUpPreciseTailSimSec: number;
  private readonly catchUpCoarseStrideSimSec: number;
  private readonly catchUpCoarseSubstepSimSec: number;
  private readonly rate: number;
  private readonly graceMs: number;
  private readonly horizonSimSec: number;
  private closed = false;

  constructor(private readonly deps: WorldSessionDeps) {
    this.rate = deps.simPerWallSec ?? 1;
    this.graceMs = deps.idleGraceMs ?? 60_000;
    this.horizonSimSec = deps.hibernateHorizonSimSec ?? 3600;
    this.catchUpSyncWaitMs = deps.catchUpSyncWaitMs ?? CATCH_UP_SYNC_WAIT_MS;
    this.catchUpCoarseMinGapSimSec = deps.catchUpCoarseMinGapSimSec ?? CATCH_UP_COARSE_MIN_GAP_SIM_SEC;
    this.catchUpPreciseTailSimSec = deps.catchUpPreciseTailSimSec ?? CATCH_UP_PRECISE_TAIL_SIM_SEC;
    this.catchUpCoarseStrideSimSec = deps.catchUpCoarseStrideSimSec ?? CATCH_UP_COARSE_STRIDE_SIM_SEC;
    this.catchUpCoarseSubstepSimSec = deps.catchUpCoarseSubstepSimSec ?? CATCH_UP_COARSE_SUBSTEP_SIM_SEC;
  }

  // -------------------------------------------------------------------------
  // Status surface
  // -------------------------------------------------------------------------

  /** The env detail's `worldSession` block (undefined when no session). */
  statusOf(envId: string): WorldSessionStatusView | undefined {
    const state = this.sessions.get(envId);
    if (state === undefined) return undefined;
    return this.viewOf(state);
  }

  private viewOf(state: SessionState): WorldSessionStatusView {
    const record = this.deps.registry.get(state.simId);
    if (record === undefined) {
      // Hibernated (or mid-transition): the registry record is the checkpoint.
      // simTimeSec is frozen at the checkpoint — asOf is the freeze stamp.
      return {
        status: state.status,
        // T82: hibernated = the runtime is released — the one status where
        // the attention word and the runtime word agree.
        state: 'hibernated' as const,
        simTimeSec: state.checkpointAtSec ?? 0,
        simulationId: state.simId,
        simPerWallSec: this.rate,
        asOf: state.hibernatedAt ?? new Date((this.deps.nowMs ?? Date.now)()).toISOString(),
        ...(state.simStartEpochMs !== undefined ? { simStartEpochMs: state.simStartEpochMs } : {}),
        ...(state.status === 'hibernated'
          ? {
              checkpointAtSec: state.checkpointAtSec,
              hibernatedAt: state.hibernatedAt,
            }
          : {}),
        ...(state.driftWarning !== undefined ? { driftWarning: state.driftWarning } : {}),
      };
    }
    const simTimeSec = record.runtime.getSimTimeSec();
    const simStartEpochMs = record.runtime.getSimStartEpochMs();
    return {
      status: state.status,
      // T82: the runtime-state caliber (see the interface note) — one word
      // across AGENT_AMBIGUOUS / sim list / this face.
      state: record.runtime.getState(),
      simTimeSec,
      simulationId: state.simId,
      simPerWallSec: this.rate,
      // R6-A-F02: the wall moment the DISPLAYED sim time belongs to (wall-
      // anchor arithmetic, deterministic for a frozen display — two reads of
      // an idle world between catch-ups agree bit-wise). A lagging asOf marks
      // the display as a last-catch-up snapshot, not a stopped world.
      asOf: new Date(simStartEpochMs + (simTimeSec * 1000) / this.rate).toISOString(),
      // T-410: the live runtime's own anchor (the wake path restores the
      // checkpoint's value into the rebuilt runtime — view never jumps).
      simStartEpochMs,
      ...(state.status !== 'hibernated' ? { observers: state.observers } : {}),
      ...(state.status === 'hibernated'
        ? { checkpointAtSec: state.checkpointAtSec, hibernatedAt: state.hibernatedAt }
        : {}),
      ...(state.driftWarning !== undefined ? { driftWarning: state.driftWarning } : {}),
      ...(state.catchUp !== undefined
        ? {
            catchUpProgress: {
              targetSimSec: state.catchUp.targetSimSec,
              currentSimSec: simTimeSec,
              phase: state.catchUp.phase,
              startedAt: state.catchUp.startedAt,
            },
          }
        : {}),
    };
  }

  private publish(state: SessionState): void {
    try {
      this.deps.onStatusChange?.(state.envId, this.viewOf(state));
    } catch (error) {
      logger.warn(`status broadcast for ${state.envId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Creation / wake / observation (the arrival paths)
  // -------------------------------------------------------------------------

  /**
   * The session's live record after ENSURING it exists and is caught up to
   * wall-now — the targeting entry point for reads/streams with no explicit
   * simulationId (the session is the default target). Undefined when the env
   * cannot carry a session (invalid scenario, store fault) — callers fall
   * back to the legacy resolution.
   */
  async targetFor(envId: string): Promise<SimulationRecord | undefined> {
    try {
      return await this.serialize(envId, () => this.ensureCaughtUp(envId));
    } catch (error) {
      logger.warn(
        `world session for env ${envId} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Observe: an ARRIVAL. Ensures + wakes + materializes the world to
   * wall-now, counts an observer pin, flips ACTIVE, and returns the release
   * function (the LAST release schedules the idle demotion sweep).
   */
  async observe(envId: string): Promise<() => void> {
    await this.serialize(envId, () => this.ensureCaughtUp(envId));
    const state = this.sessions.get(envId)!;
    state.observers += 1;
    if (state.status !== 'active') {
      state.status = 'active';
      this.clearDemotion(state);
      this.applyLodTier(state);
      this.publish(state);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.sessions.get(envId);
      if (current === undefined || current !== state) return;
      state.observers = Math.max(0, state.observers - 1);
      if (state.observers === 0 && state.status === 'active') {
        state.status = 'idle';
        this.applyLodTier(state);
        this.publish(state);
        this.scheduleHibernateSweep(state);
      }
    };
  }

  /**
   * Pin used by the env world stream (a governance stream that predates
   * sessions and must keep serving session-less/empty envs). When a session
   * exists it is awakened, materialized and pinned ACTIVE for the
   * connection's lifetime.
   *
   * Crash recovery (hard restart without a disk checkpoint loses the
   * in-memory session, and a continuously-observed world never writes one):
   * an observing stream lazily RE-MATERIALIZES the world from the env's
   * current rows — observe() → ensureCaughtUp already prefers a disk
   * checkpoint over a fresh t=0 world, so the rebind wins when present.
   * Creation failures (unsimulatable env, closed service) stay warn-only
   * and yield a no-op release: the stream keeps serving governance frames.
   */
  async observeOrMaterialize(envId: string): Promise<() => void> {
    try {
      return await this.observe(envId);
    } catch (error) {
      // Warn-only: unsimulatable envs (0 zones), a closed service, or a
      // failed wake must never break the governance stream — it serves
      // frames for envs that carry no world too.
      logger.warn(
        `world session lazy materialize for env ${envId} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return () => {};
    }
  }

  /**
   * Governance world-change hook (T-037 semantics, the change-pipeline
   * single funnel): a proposal APPLY creates the session (a deliberate
   * world-changing governance act — the brief's "first governance action");
   * a direct owner edit refreshes an EXISTING session — and, since R82, a
   * session-less env RETRIES creation on any world mutation. The hook only
   * fires on world-mutating changes, so every invocation is itself the
   * topology-change signal worth a retry: an env whose birth-time creation
   * failed (R73 waking a blank 0-zone world fails ENVIRONMENT_INVALID by
   * design) heals here the moment the rows become simulatable, instead of
   * staying dead forever behind "no session, create=false". Failures stay
   * on the warn-only path — a world edit never fails because the world
   * could not (yet) simulate. Live sessions rebuild their topology from the
   * new rows and land the effects at wall-now.
   *
   * R37-F1 hardening (validation F1: owner-direct env edits while a session
   * exists "never appeared in the runtime"): a failed catch-up no longer
   * skips the rebuild silently — each stage is attempted independently and
   * every failure is LOUD (the caller in server.ts no longer swallows
   * either); a husk record under the deterministic session id (a stopped or
   * generically-resumed remnant) is discarded instead of wedging the env
   * behind WORLD_SESSION_EXISTS.
   */
  async onWorldMutation(envId: string, options: { create: boolean }): Promise<void> {
    logger.info(`world mutation[${envId}]: entered (create=${options.create})`);
    await this.serialize(envId, async () => {
      const state = this.sessions.get(envId);
      if (state === undefined) {
        if (this.closed) {
          logger.info(`world mutation[${envId}]: no session, closed=true — returning`);
          return;
        }
        logger.info(`world mutation[${envId}]: creating session (create=${options.create})`);
        try {
          await this.createSessionDiscardingHusk(envId);
        } catch (error) {
          logger.warn(
            `world session creation for env ${envId} after a governance change failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      // Catch-up first (wake if hibernated, self-heal stopped husks) — but a
      // failed catch-up must not skip the topology rebuild: the rebuild is
      // the point of this hook, and the record may be perfectly healthy.
      try {
        await this.ensureCaughtUp(envId);
      } catch (error) {
        logger.warn(
          `catch-up before world-change rebuild for env ${envId} failed ` +
            `(attempting the rebuild directly): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        const scenario = this.deps.scenarioOfEnv(envId);
        const rebuilt = await this.deps.registry.rebuildLiveSession(state.simId, scenario);
        this.startSessionRuntime(rebuilt);
        // T129: bounded — the advance finishes on the background chain (this
        // hook runs on the ops FIFO; an unbounded advance here would stall
        // governance applies exactly like it stalled the consumption lanes).
        await this.awaitCatchUp(state);
      } catch (error) {
        // A governance action must never fail because the world could not
        // rebuild — env rows are already the durable truth.
        logger.warn(
          `session rebuild for env ${envId} after world change failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  /**
   * Agreement activation (the "first due moment" creation trigger): an
   * accepted data-read agreement with a minFreshnessSec floor installs a
   * standing wall obligation — the world must exist to honor it. The floor
   * then keeps the session IDLE-resident (never hibernates past it).
   */
  async noteFreshnessObligation(envId: string): Promise<void> {
    const floor = this.deps.freshnessFloorSecForEnv?.(envId);
    if (floor === undefined || floor <= 0) return;
    await this.serialize(envId, () => this.ensureCaughtUp(envId));
  }

  // -------------------------------------------------------------------------
  // Cross-process resume (S3, Task 3)
  // -------------------------------------------------------------------------

  /**
   * Rebind a hibernated session ADOPTED from an on-disk checkpoint left by a
   * previous process (registry.adoptHibernatedCheckpoint): register the
   * lightweight state entry in HIBERNATED status so the env detail surfaces
   * `worldSession` with the checkpoint metadata and the next arrival wakes
   * through the normal P1W path (current-topology rebuild, drift notes,
   * fast-forward). No-op when this env already has a session. Never touches
   * a live or in-flight state.
   */
  adoptHibernated(
    envId: string,
    adopted: { record: { id: string; hibernatedAt: string; checkpoint: { simTimeSec: number } }; simStartEpochMs: number },
  ): WorldSessionStatusView | undefined {
    if (this.sessions.has(envId)) return undefined;
    const state: SessionState = {
      envId,
      simId: adopted.record.id,
      status: 'hibernated',
      observers: 0,
      hibernatedAt: adopted.record.hibernatedAt,
      checkpointAtSec: adopted.record.checkpoint.simTimeSec,
      // T-410: the checkpoint's own wall anchor — the wake path restores the
      // same value into the rebuilt runtime, so the mapping never jumps.
      simStartEpochMs: adopted.simStartEpochMs,
    };
    this.sessions.set(envId, state);
    this.publish(state);
    return this.viewOf(state);
  }

  /**
   * R37-F1: an EXTERNAL hibernate of the env's session sim — POST /stop on
   * the world session routes to FREEZE semantics (checkpoint + release, the
   * design §9 HIBERNATED state) so the world stays re-creatable from its
   * checkpoint + current env rows instead of leaving a stopped husk that
   * used to wedge the env behind WORLD_SESSION_EXISTS. Registers/refreshes
   * the in-memory state so the next arrival wakes through the normal path
   * (current topology, drift notes, fast-forward).
   */
  adoptExternalHibernate(
    envId: string,
    hibernated: { record: { id: string; hibernatedAt: string; checkpoint: { simTimeSec: number } }; simStartEpochMs: number },
  ): void {
    const state = this.sessions.get(envId);
    if (state !== undefined) {
      state.status = 'hibernated';
      state.observers = 0;
      state.hibernatedAt = hibernated.record.hibernatedAt;
      state.checkpointAtSec = hibernated.record.checkpoint.simTimeSec;
      state.simStartEpochMs = hibernated.simStartEpochMs;
      this.clearDemotion(state);
      this.publish(state);
      return;
    }
    this.adoptHibernated(envId, hibernated);
  }

  /**
   * Lazy rebind: an arrival for an env with NO in-memory session consults
   * findHibernatedCheckpoint BEFORE materializing fresh — a checkpoint on
   * disk means a previous process hibernated this world, and its history
   * (sim-time, fired dues, trajectory) continues rather than restarting.
   * Corrupt/unreadable checkpoints degrade to a fresh session (warned).
   */
  private async tryRebindFromDisk(envId: string): Promise<SessionState | undefined> {
    const path = this.deps.findHibernatedCheckpoint?.(envId);
    if (path === undefined) return undefined;
    try {
      const adopted = this.deps.registry.adoptHibernatedCheckpoint(path, {
        environmentOwnerId: this.deps.envOwnerIdOf(envId),
      });
      if (adopted === undefined) return undefined;
      this.adoptHibernated(envId, adopted);
      return this.sessions.get(envId);
    } catch (error) {
      logger.warn(
        `world session checkpoint for env ${envId} could not be adopted ` +
          `(${error instanceof Error ? error.message : String(error)}) — materializing a fresh world`,
      );
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Internals: ensure / wake / catch-up / hibernate
  // -------------------------------------------------------------------------

  private async serialize<T>(envId: string, op: () => Promise<T>): Promise<T> {
    const enqueuedAtMs = Date.now();
    const prior = this.ops.get(envId) ?? Promise.resolve();
    // T129 observability: a long per-env queue wait is exactly the r21
    // outage's user-visible symptom (every call slow, no clue where it
    // waited). Name the wait — the op itself logs its own duration.
    const runOp = (): Promise<T> => {
      const queuedMs = Date.now() - enqueuedAtMs;
      if (queuedMs > SERIALIZE_QUEUE_WARN_MS) {
        logger.warn(
          `world session ops[${envId}]: this operation waited ${queuedMs}ms in the per-env ` +
            'queue behind a long-running operation (wake / rebuild / create)',
        );
      }
      return op();
    };
    const next = prior.then(runOp, runOp);
    this.ops.set(envId, next);
    try {
      return await next;
    } finally {
      if (this.ops.get(envId) === next) this.ops.delete(envId);
    }
  }

  /** Ensure the session exists, is live, and materialized to wall-now. */
  private async ensureCaughtUp(envId: string): Promise<SimulationRecord> {
    if (this.closed) throw new ApiError(503, 'WORLD_SESSION_CLOSED', 'The world session service is shut down');
    let state = this.sessions.get(envId);
    if (state === undefined) {
      // S3 (Task 3): a checkpoint on disk from a previous process wins over
      // a fresh world — the arrival wakes the hibernated history instead.
      const rebindStartedMs = Date.now();
      state = await this.tryRebindFromDisk(envId);
      if (state !== undefined) {
        // T129 observability: the lazy-rebind leg is one of the awaits the
        // r21 hang hid behind — every stage now names its duration.
        logger.info(
          `world session[${envId}]: lazy-rebind from disk checkpoint took ${Date.now() - rebindStartedMs}ms`,
        );
      }
    }
    if (state === undefined) state = await this.createSessionDiscardingHusk(envId);
    if (state.status === 'hibernated') {
      if (this.deps.registry.getHibernated(state.simId) !== undefined) {
        const wakeStartedMs = Date.now();
        await this.wakeHibernated(state);
        logger.info(
          `world session[${envId}]: wake from hibernated checkpoint took ${Date.now() - wakeStartedMs}ms`,
        );
      } else {
        // R37-F1: STALE hibernated marker — the checkpoint record is gone
        // but a LIVE record sits under the same id (someone woke the
        // session through the GENERIC /resume route, which rebuilds from
        // the checkpoint's FROZEN scenario, or discarded the checkpoint
        // out-of-band). Adopt the live record and REBUILD its topology from
        // the CURRENT env rows (the wake contract: env owns topology)
        // instead of recreating into a WORLD_SESSION_EXISTS wedge.
        const live = this.deps.registry.get(state.simId);
        if (live === undefined || live.runtime.getState() === 'stopped') {
          // Neither a checkpoint nor a usable record — discard any husk and
          // materialize a fresh world from the env's current rows.
          this.clearDemotion(state);
          this.sessions.delete(envId);
          this.deps.registry.stopAndRemove(state.simId);
          state = await this.createSessionDiscardingHusk(envId);
        } else {
          state.status = 'idle'; // observers (if any) flip it ACTIVE right after
          delete state.hibernatedAt;
          delete state.checkpointAtSec;
          this.publish(state);
          try {
            const scenario = this.deps.scenarioOfEnv(envId);
            const rebuilt = await this.deps.registry.rebuildLiveSession(state.simId, scenario);
            this.startSessionRuntime(rebuilt);
          } catch (error) {
            // Honest degradation: keep serving the live record (old
            // topology) with the failure named — the next mutation retries.
            logger.warn(
              `stale-hibernated adoption rebuild for env ${envId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    let record = this.deps.registry.get(state.simId);
    if (
      record === undefined &&
      this.deps.registry.getHibernated(state.simId) !== undefined
    ) {
      // Hibernated out-of-band (someone POSTed /hibernate on the session
      // sim id): adopt the checkpoint and wake through the normal path.
      state.status = 'hibernated';
      state.hibernatedAt = this.deps.registry.getHibernated(state.simId)!.hibernatedAt;
      state.checkpointAtSec = this.deps.registry.getHibernated(state.simId)!.checkpoint.simTimeSec;
      await this.wakeHibernated(state);
      record = this.deps.registry.get(state.simId);
    }
    if (record === undefined || record.runtime.getState() === 'stopped') {
      // The record vanished or was stopped out-of-band (someone POSTed /stop
      // on the session sim id) — discard the husk and materialize a fresh
      // world from the env's current rows (the durable truth).
      this.clearDemotion(state);
      this.sessions.delete(envId);
      this.deps.registry.stopAndRemove(state.simId);
      state = await this.createSession(envId);
      record = this.deps.registry.get(state.simId)!;
    }
    this.startSessionRuntime(record);
    // T129 (R21-F1): the catch-up is potentially unbounded (a world hours
    // behind wall must fast-forward tens of thousands of sim-seconds). It
    // runs on the per-env BACKGROUND chain (never the ops FIFO — it can no
    // longer head-of-line-block the next arrival); the caller waits at most
    // catchUpSyncWaitMs. The advance itself always completes — the world
    // never lies, never jumps; only the CALLER's synchronous wait is capped.
    await this.awaitCatchUp(state);
    this.applyLodTier(state);
    return record;
  }

  // -------------------------------------------------------------------------
  // T129: background catch-up chain (the r21 head-of-line unblock)
  // -------------------------------------------------------------------------

  /**
   * Chain a catch-up onto the per-env BACKGROUND chain and wait for it (or
   * the chain tail) at most catchUpSyncWaitMs. Coalescing: at most one
   * PENDING catch-up per env — a storm of arrivals while one advance runs
   * chains a single follow-up, which re-reads the wall target when it starts.
   */
  private async awaitCatchUp(state: SessionState): Promise<void> {
    this.scheduleCatchUp(state.envId);
    const pending = this.catchUps.get(state.envId);
    if (pending === undefined || this.catchUpSyncWaitMs <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.catchUpSyncWaitMs);
        timer.unref?.();
        pending.then(resolve, resolve);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private scheduleCatchUp(envId: string): void {
    if (this.catchUpQueued.has(envId)) return;
    this.catchUpQueued.add(envId);
    const prior = this.catchUps.get(envId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined) // the previous advance's failure never blocks the next
      .then(() => {
        this.catchUpQueued.delete(envId);
        if (this.closed) return;
        const current = this.sessions.get(envId);
        if (current === undefined) return;
        return this.catchUp(current);
      })
      .catch(error => {
        // Background continuation: never an unhandled rejection. The next
        // arrival re-schedules and retries honestly.
        logger.warn(
          `world session catch-up[${envId}] failed in the background: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.catchUps.set(envId, next);
  }

  /**
   * R30 (LOD): sync the runtime's physics tier to the session's observation
   * state — ACTIVE (observers pinned) runs full-precision dt=1 physics; IDLE
   * (no observers, due-driven drift) runs the coarse 10s substep. No-op when
   * hibernated or the record is gone (a fresh runtime on the wake path gets
   * its tier from the ensureCaughtUp tail / next observe()).
   */
  private applyLodTier(state: SessionState): void {
    if (state.status === 'hibernated') return;
    const record = this.deps.registry.get(state.simId);
    if (record === undefined || record.runtime.getState() === 'stopped') return;
    record.runtime.setLodTier(state.status === 'active' ? 'observed' : 'idle');
  }

  /**
   * Start (or keep) a session runtime in lazy mode — with the due driver
   * unless the test harness drives advancement itself (attachDriver: false).
   */
  private startSessionRuntime(record: SimulationRecord): void {
    if (this.deps.attachDriver !== false) {
      this.deps.registry.startLazyRuntime(record, this.rate);
    } else if (record.runtime.getState() !== 'running') {
      record.runtime.start(this.rate, { lazy: true });
    }
  }

  private async createSession(envId: string): Promise<SessionState> {
    logger.info(`world session create[${envId}]: building runtime from env rows`);
    const scenario = this.deps.scenarioOfEnv(envId); // may throw (invalid env)
    await this.deps.registry.createEnvSession({
      envId,
      scenario,
      ...(this.deps.envOwnerIdOf(envId) !== undefined
        ? { envOwnerId: this.deps.envOwnerIdOf(envId) }
        : {}),
      ...(this.deps.recomputeStaleFrames !== undefined
        ? {
            onAdvance: () => {
              const state = this.sessions.get(envId);
              const record = state !== undefined ? this.deps.registry.get(state.simId) : undefined;
              if (state !== undefined && record !== undefined) {
                try {
                  this.deps.recomputeStaleFrames?.(envId, record);
                } catch {
                  // The hook must never take the scheduler down.
                }
                // R91/R92 感知：世界每推进一次，感知模块差分一次环境状态，
                // 把变化（越限/尖峰/慢漂移）转译成刺激事件投递给管理 Agent。
                try {
                  void record.runtime.scanAndDeliverPerception().catch(() => undefined);
                } catch {
                  // 同上：感知故障绝不拖垮调度器。
                }
              }
            },
          }
        : {}),
    });
    const state: SessionState = {
      envId,
      simId: `sim-${envId}-world-session`,
      status: 'idle',
      observers: 0,
    };
    this.sessions.set(envId, state);
    logger.info(`world session create[${envId}]: runtime built; adopting anchor`);
    const record = this.deps.registry.get(state.simId)!;
    // Test seam: adopt an anchor/world BEFORE the runtime starts (the
    // clock-anchor discipline for two-runtime comparisons).
    await this.deps.onSessionCreated?.(record);
    this.startSessionRuntime(record);
    this.publish(state);
    this.scheduleHibernateSweep(state);
    return state;
  }

  /**
   * R37-F1: createSession that refuses to wedge. A husk record under the
   * deterministic session id (a STOPPED remnant of the world session, or a
   * generically-resumed one the in-memory state lost track of) makes
   * createEnvSession throw WORLD_SESSION_EXISTS — which used to abort every
   * later arrival and governance apply for the env (validation F1's
   * "no removal endpoint" trap). On that specific error the husk is
   * discarded (stopAndRemove) and the create retried ONCE.
   */
  private async createSessionDiscardingHusk(envId: string): Promise<SessionState> {
    try {
      return await this.createSession(envId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'WORLD_SESSION_EXISTS') throw error;
      const simId = `sim-${envId}-world-session`;
      logger.warn(
        `world session create for env ${envId} hit a husk record (${simId}) — discarding it and retrying once`,
      );
      this.deps.registry.stopAndRemove(simId);
      return await this.createSession(envId);
    }
  }

  /**
   * Wake a HIBERNATED session and FAST-FORWARD (design §6.3): restore the
   * checkpoint's dynamics into a runtime rebuilt from the env's CURRENT rows
   * (drift → teaching warning), then advanceTo the wall-mapped now over the
   * due set of the empty window — every due fires exactly once (the
   * checkpoint carries the fired markers).
   */
  private async wakeHibernated(state: SessionState): Promise<void> {
    const hibernated = this.deps.registry.getHibernated(state.simId);
    if (hibernated === undefined) {
      // Checkpoint record lost (stop raced us) — recreate from scratch.
      this.sessions.delete(state.envId);
      await this.createSessionDiscardingHusk(state.envId);
      return;
    }
    const checkpoint = readWorldCheckpoint(hibernated.checkpoint.path);
    const scenario = this.deps.scenarioOfEnv(state.envId);
    state.driftWarning = scenarioDriftNotes(checkpoint.scenario, scenario);
    if (state.driftWarning.length > 0) {
      logger.warn(
        `world session ${state.simId} schema drift across the hibernate boundary: ` +
          state.driftWarning.join('; '),
      );
    }
    const record = await this.deps.registry.resumeEnvSession(state.simId, scenario);
    state.status = 'idle'; // observers (if any) flip it ACTIVE right after
    delete state.hibernatedAt;
    delete state.checkpointAtSec;
    this.publish(state);
    this.startSessionRuntime(record);
  }

  /**
   * Materialize the world to the WALL-MAPPED now (醒来即追平): the target is
   * computed from the runtime's own clock anchor — the same anchor every
   * equality comparison must share. Fairness-chunked (chunked advanceTo is
   * equivalent to one-shot, P1 invariant #2).
   *
   * T129 (R21-F1): this is the one await that used to be unbounded — the
   * r20/r21 outage's exact seat (a world hours behind wall fast-forwards
   * tens of thousands of sim-sec while every consumption-lane caller sat on
   * the per-env FIFO behind it). Hardening, world semantics unchanged:
   * - the advance still runs to the FULL target (never truncated, never
   *   jumped) — only the CALLER's synchronous wait is capped (awaitCatchUp);
   * - chunks yield the event loop between advances (a long advance no
   *   longer starves timers/IO);
   * - each chunk re-validates the record (a concurrent rebuild/wake/stop
   *   swaps or removes it — the loop adopts the fresh record or bails);
   * - start/progress/completion are logged with durations, so a slow or
   *   stuck advance names itself in the logs.
   */
  private async catchUp(state: SessionState): Promise<void> {
    let record = this.deps.registry.get(state.simId);
    if (record === undefined || record.runtime.getState() === 'stopped') return;
    const now = (this.deps.nowMs ?? Date.now)();
    const anchorMs = record.runtime.getSimStartEpochMs();
    const target = ((now - anchorMs) / 1000) * this.rate;
    let current = record.runtime.getSimTimeSec();
    if (target <= current + 1e-9) {
      this.deps.recomputeStaleFrames?.(state.envId, record);
      return;
    }
    // T129 observability: a gap over one fairness chunk IS the r21 shape —
    // name the size before paying it (healthy sub-chunk catch-ups stay
    // silent: 健康道不得变话痨).
    const startedMs = Date.now();
    const gapSec = target - current;
    if (gapSec > FAST_FORWARD_CHUNK_SIM_SEC) {
      logger.warn(
        `world session catch-up[${state.envId}]: the world is ${Math.round(gapSec)} sim-sec behind wall ` +
          `(sim ${current.toFixed(0)} → ${target.toFixed(0)}) — fast-forwarding; ` +
          'consumption callers stop waiting after the sync cap while this finishes in the background',
      );
    }
    // R30 (LOD): the catch-up fast-forward runs at FULL precision for the
    // NEAR tail regardless of the tier the world drifted at while idle —
    // 醒来即追平 is the one advance whose result an arriving observer reads
    // as ground truth, and the P1W equivalence arms compare it against
    // continuously-observed runs. Restored to the steady-state tier in the
    // finally. The FAR-OLD tier below relaxes only the inter-due physics
    // (coarse strides); due moments fire exactly as at full precision (core
    // advanceTo coarse option) — the分层追平 contract.
    record.runtime.setLodTier('observed');
    // 分层计划：远旧区段（目标前 preciseTail 以外）粗推，近段全精度。
    const coarseBoundary = target - this.catchUpPreciseTailSimSec;
    const useCoarse =
      gapSec > this.catchUpCoarseMinGapSimSec &&
      current < coarseBoundary - 1e-9 &&
      this.catchUpCoarseStrideSimSec > this.rate;
    if (useCoarse) {
      logger.warn(
        `world session catch-up[${state.envId}]: layered fast-forward — coarse ` +
          `${Math.round(coarseBoundary - current)} sim-sec (stride ≤${this.catchUpCoarseStrideSimSec}s, ` +
          `dt≈${this.catchUpCoarseSubstepSimSec}s) then precise tail ${this.catchUpPreciseTailSimSec} sim-sec; ` +
          'due moments fire exactly as at full precision, only inter-due physics is coarser',
      );
    }
    state.catchUp = {
      targetSimSec: target,
      phase: useCoarse ? 'coarse' : 'precise',
      startedAt: new Date().toISOString(),
    };
    let chunks = 0;
    let coarseSec = 0;
    let coarseMs = 0;
    let preciseSec = 0;
    let preciseMs = 0;
    try {
      while (current < target - 1e-9) {
        // Per-chunk revalidation: a concurrent wake/rebuild/stop may have
        // swapped or removed the record — adopt the fresh one or bail (the
        // arrival that caused it schedules its own catch-up).
        const fresh = this.deps.registry.get(state.simId);
        if (fresh === undefined || fresh.runtime.getState() === 'stopped') return;
        record = fresh;
        const coarseNow = useCoarse && current < coarseBoundary - 1e-9;
        const stop = coarseNow
          ? Math.min(current + FAST_FORWARD_CHUNK_SIM_SEC, coarseBoundary)
          : Math.min(current + FAST_FORWARD_CHUNK_SIM_SEC, target);
        state.catchUp.phase = coarseNow ? 'coarse' : 'precise';
        const legStartedMs = Date.now();
        if (coarseNow) {
          await record.runtime.advanceTo(stop, {
            coarseStrideSec: this.catchUpCoarseStrideSimSec,
            coarseSubstepSec: this.catchUpCoarseSubstepSimSec,
          });
        } else {
          await record.runtime.advanceTo(stop);
        }
        const legMs = Date.now() - legStartedMs;
        const advanced = record.runtime.getSimTimeSec() - current;
        if (coarseNow) {
          coarseSec += advanced;
          coarseMs += legMs;
        } else {
          preciseSec += advanced;
          preciseMs += legMs;
        }
        chunks += 1;
        current = record.runtime.getSimTimeSec();
        if (chunks % CATCH_UP_PROGRESS_EVERY_CHUNKS === 0) {
          logger.info(
            `world session catch-up[${state.envId}]: ${Math.round(current)}/${Math.round(target)} sim-sec ` +
              `(${coarseNow ? 'coarse' : 'precise'} leg, ${chunks} chunks, ${Date.now() - startedMs}ms)`,
          );
        }
        // Yield between chunks: a giant advance must not starve the event
        // loop (timers, IO, the very HTTP caller that may still be waiting).
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally {
      delete state.catchUp;
      this.applyLodTier(state);
    }
    if (chunks >= CATCH_UP_PROGRESS_EVERY_CHUNKS || gapSec > FAST_FORWARD_CHUNK_SIM_SEC) {
      const layered =
        coarseSec > 0
          ? ` — coarse ${Math.round(coarseSec)} sim-sec in ${coarseMs}ms ` +
            `(${Math.round((coarseSec / Math.max(coarseMs, 1)) * 1000)} sim-sec/s), ` +
            `precise ${Math.round(preciseSec)} sim-sec in ${preciseMs}ms`
          : '';
      logger.info(
        `world session catch-up[${state.envId}]: complete — ${chunks} chunk(s), ` +
          `${Math.round(gapSec)} sim-sec in ${Date.now() - startedMs}ms${layered}`,
      );
    }
    this.deps.recomputeStaleFrames?.(state.envId, record);
  }

  // -------------------------------------------------------------------------
  // Demotion (IDLE → HIBERNATED)
  // -------------------------------------------------------------------------

  private clearDemotion(state: SessionState): void {
    if (state.demotionTimer !== undefined) {
      clearTimeout(state.demotionTimer);
      delete state.demotionTimer;
    }
  }

  private scheduleHibernateSweep(_state: SessionState): void {
    // R73 "永远运行下去": hibernation disabled. Worlds stay ACTIVE forever —
    // the user's explicit directive. This stub replaces the demotion sweep.
  }

  /**
   * Obligation rule (design §5): worlds with real-device surfaces or active
   * actuation obligations NEVER spin down; a freshness floor is a standing
   * wall obligation (stay IDLE-resident — the driver wakes at the floor).
   */
  private hibernateIfEligible(state: SessionState): Promise<void> {
    if (state.status !== 'idle' || state.observers > 0 || this.closed) {
      return Promise.resolve();
    }
    const record = this.deps.registry.get(state.simId);
    if (record === undefined || record.runtime.getState() === 'stopped') {
      return Promise.resolve();
    }
    try {
      const obligations = this.deps.obligationsOf(state.envId);
      if (obligations.hassBound || obligations.actuationAgreement) return Promise.resolve();
    } catch {
      return Promise.resolve(); // predicate faults never hibernate
    }
    const floor = this.deps.freshnessFloorSecForEnv?.(state.envId);
    if (floor !== undefined && floor > 0) return Promise.resolve();
    // Near dues on the world's own timeline → stay resident (design §9 IDLE).
    try {
      const due = record.runtime.peekNextDueMoment(this.horizonSimSec);
      if (due !== null) return Promise.resolve();
    } catch {
      return Promise.resolve();
    }
    return this.deps.registry
      .hibernate(state.simId)
      .then(hibernated => {
        state.status = 'hibernated';
        state.hibernatedAt = hibernated.hibernatedAt;
        state.checkpointAtSec = hibernated.checkpoint.simTimeSec;
        // T-410: keep the wall anchor in the hibernated view — the
        // checkpoint exported from THIS runtime carries the same value, so
        // the wake path (restoreWorldState adopts it) never shifts it.
        state.simStartEpochMs = record.runtime.getSimStartEpochMs();
        this.publish(state);
      })
      .catch(error => {
        // REAL_DEVICE_SURFACE and friends: stay resident and log — the next
        // arrival re-evaluates (no auto-reschedule: a persistent refusal
        // must not become a retry loop).
        logger.warn(
          `world session ${state.simId} could not hibernate (${error instanceof Error ? error.message : String(error)}) — staying resident`,
        );
      });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Env deletion cascade: drop the state (the registry cascades records). */
  dropForEnv(envId: string): void {
    const state = this.sessions.get(envId);
    if (state === undefined) return;
    this.clearDemotion(state);
    this.sessions.delete(envId);
  }

  /** Server shutdown: clear timers. Runtimes are stopped by stopAll(). */
  close(): void {
    this.closed = true;
    for (const state of this.sessions.values()) this.clearDemotion(state);
    this.sessions.clear();
    // T129: queued background catch-ups observe `closed` when they start; a
    // queued marker must not survive the close (the chain tail no-ops).
    this.catchUpQueued.clear();
  }
}
