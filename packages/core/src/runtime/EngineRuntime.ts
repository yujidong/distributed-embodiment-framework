/**
 * EngineRuntime — long-running engine instance built from a scenario
 *
 * Turns the engine from one-shot experiment runs into a service core:
 * one `EngineRuntime` owns a simulated world (PhysicalEnvironment +
 * EnvironmentCenter + SimulatedDevices + CognitiveAgents) and exposes a
 * controllable tick loop, manual/scheduled event injection, JSON state
 * snapshots, and an event-stream subscription API.
 *
 * World construction mirrors the experiment runner's `setupIteration()`
 * (packages/core/tests/experiments/infrastructure/paper-experiment-runner.ts):
 * TimeManager + PhysicalEnvironment wrapped in an EnvironmentCenter, one
 * device per scenario device (SimulatedDevice by default; any adapter via the
 * `deviceFactory` option — e.g. the server's HADevice for hass:// bindings),
 * one CognitiveAgent per scenario agent with a per-agent DualTriggerConfig
 * (adjacent/actuator zone sets computed from the agent's actuator devices).
 * Event injection mirrors the runner's routed mode: set the physical
 * parameter, then deliver an
 * ENVIRONMENT_PARAM_CHANGED SystemEvent to the managing agents directly
 * (targeted `handleEvent`, not a bus broadcast).
 *
 * Spatial behavior: zones with `bounds` are spatially real. Their baselines
 * and event injections are LOCALIZED writes at the zone center (radius =
 * half the zone diagonal) into the physics layer's per-location field; the
 * field then propagates (diffusion), relaxes toward per-zone baselines, and
 * is clamped to physical ranges. `getSnapshot()` samples the field per
 * zone, so zones legitimately differ. Zones without bounds keep the legacy
 * global value-model behavior (one zone-agnostic value per parameter).
 * Each physics step, the tick loop also runs every device's control loop
 * (e.g. HVAC thermostat hysteresis) — scheduling only; control policy lives
 * in the device layer, field math in the physics layer.
 *
 * Simulation-package coupling: `@active-collaboration/simulation` already
 * depends on `@active-collaboration/core`, so core cannot import it
 * statically (that would create a project-reference cycle and break the
 * shared → llm-integration → core → simulation build order). The runtime
 * therefore loads the simulation package lazily via `require()` and types
 * the pieces it uses structurally below.
 *
 * LLM: agents receive a constructor-injected LLMClient (`llmClient` for all,
 * or `llmPerAgent` for specific agents). Agents without a client run with
 * Layer-2 disabled (rule-only dual-trigger config, mirroring the runner's
 * 'rule-only' condition) and the engine still fully works.
 *
 * Shutdown: `stop()` clears the tick interval, unsubscribes stream
 * listeners, and stops every agent (which unsubscribes its event
 * subscriptions and destroys its DualTriggerACManager). No dangling handles.
 */

import type { LLMClient, LLMCacheStats } from '@active-collaboration/llm-integration';
import type { Device, DeviceCapability, CapabilityType, LocalizedText } from '@active-collaboration/shared';
import { createLogger, localizedText } from '@active-collaboration/shared';

import { CognitiveAgent } from '../agent/CognitiveAgent.js';
import { AgentPerceptionModule } from './agent-perception.js';
import type { AgentExperienceJSON, AgentMetaCognitionSummary } from '../cognition/meta.js';
import { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import { EventPriority, EventType, type SystemEvent } from '../events/index.js';
import { AgentProfileFactory } from '../goal/index.js';
import { TrajectoryRecorder } from '../trajectory/index.js';
import type { ACNecessityAssessment, AssessorConfig } from '../decision/ACNecessityAssessor.js';
import type { DualTriggerConfig } from '../decision/DualTriggerACManager.js';
import { InitiatorCoordinator } from '../decision/InitiatorCoordinator.js';
import { inferNeedsForEventType } from '../decision/inference-tables.js';
import {
  ReputationTracker,
  type ReputationTrackerJSON,
  type ReputationTrackerLoadJSON,
  type ScoredReputation,
} from '../reputation/index.js';
import { CollaborationStatus } from '../management/CollaborationManager.js';
import type { ScenarioAgent, ScenarioDefinition, ScenarioDevice } from '../scenario/index.js';
import {
  FlowEngine,
  agentInvocableFlowOfferings,
  createBudgetDeviceLookup,
  createFlowNodeInvoker,
  type FlowDefinition,
  type FlowNotifyInvoker,
  type FlowRunRecord,
  type FlowServiceInvoker,
} from '../flows/index.js';

import type {
  DevicePhysicsEffectLike,
  DueMoment,
  DueMomentSources,
  EngineEventListener,
  EngineRuntimeOptions,
  EngineRuntimeState,
  EngineSnapshot,
  FaultProfile,
  InjectEventInput,
  InjectEventOptions,
  InjectEventResult,
  InjectedEventRecord,
  PhysicalEnvironmentLike,
  PhysicsLodTier,
  RuntimeCollaborationRecord,
  RuntimeDecisionRecord,
  RuntimeDevice,
  ScheduledEventFireRecord,
  TimeManagerLike,
} from './contract.js';
import {
  capabilityNameToDeviceCapability,
  createNoLLMClientStub, resolveAgentLlmClient,
  createSimulatedDevice,
  loadSimulation,
  WALL_TICK_TIMER,
} from './contract.js';
import {
  DEFAULT_STOREY_HEIGHT_M,
  EVENT_TYPE_DEFAULTS,
  MAX_RECENT_DECISIONS,
  STEP_YIELD_EVERY,
  IDLE_CONDITION_EVAL_EVERY_TICKS,
  IDLE_ENV_BASELINE_EVERY_TICKS,
  IDLE_PHYSICS_SUBSTEP_SEC,
  PhysicsLodController, registerAggregateOffers,
  applyEventPhysicalWrite,
  assertEventValueWritable,
  buildAgentDualTriggerConfig,
  buildWorldModelProvider, wireDecisionSeams,
  buildCollaborationRows,
  buildDecisionRecord,
  buildDueSourcesFrom,
  buildEngineSnapshot,
  buildInjectedEventPayload,
  buildInjectedSystemEvent,
  deliverInjectedEvent,
  buildWorldStateExport,
  buildZoneEnvSnapshot,
  computeDueMoments,
  coerceEventValue,
  createTrajectoryRecorder,
  deriveDecisionGroundTruth,
  driveEnvironmentBaselines,
  extractRecordEventId,
  extractRecordZoneId,
  feedReputationFromCompletion,
  buildAgentEscalationEvent,
  isEffectEffective,
  nextDueMoment,
  normalizeFaultProfile,
  notifyFlowsOfEvent,
  applyOccupantScheduleWrites,
  parseCollabCompletedAction,
  parseCollabMessageAction,
  parseDeviceOperationAction,
  planWorldStateRestore,
  pushPlatformReputation,
  recordHandshakeToTrajectory,
  reportInjectedEvent,
  resolveEffectCheck,
  resolveHumanNarrative, wireNLInteractionTrace, parameterPhysicsConfig,
  wireAgentFlowLanes,
  wireDeviceExecutionTrajectory,
  resolveInjection,
  resolveManagingAgentIds, eventAudienceResolver,
  managedZoneNamesOf, nominalSimPerWallSec,
  agentBoundDevices,
  agentManagedZoneIds,
  scheduledFireRecord,
  severityToPriority,
  SpeedWindowSampler,
  type SnapshotTriageMetrics,
  type ZoneComfortSource,
  zoneCenter,
  zonePhysicsRegistration,
  zoneWriteRadius,
} from './shaping/index.js';
import { mergeOfferRules } from '../service/semantic-offers.js';
import { ENGINE_WORLD_STATE_VERSION, collectRuntimeLlmClients, type AdvanceToOptions, type EngineWorldStateExport } from './contract.js';
import { cancelPendingACHandshakes, finalizeCollaborationSessions } from './collaboration-lifecycle.js';
import { DeviceFaultSeam } from './fault-seam.js';
import {
  applyAgentExperience,
  collectAgentExperience,
  loadReputationInto,
  reputationCellFace,
} from './persistence-seams.js';
import {
  PowerOutageState,
  maybeBeginPowerOutage,
} from './power-outage.js';
import {
  applyPowerOutages as applyPowerOutagesImpl,
  flushIdlePhysics as flushIdlePhysicsImpl,
  integrateCoarseStride,
  runPhysicsSubsteps as runPhysicsSubstepsImpl,
  type PhysicsIntegrationSeams,
} from './physics-integration.js';
import {
  fireDueScenarioEvents,
  fireOccupantScheduleWrites,
  runTickBody,
  type TickLoopSeams,
} from './tick-loop.js';
import {
  setZoneOccupancy as setZoneOccupancyImpl,
  updateZoneBaseline as updateZoneBaselineImpl,
  type ZoneStateSeams,
} from './shaping/zone-state.js';
// Public surface re-export (runtime/index.ts imports these from here).
export {
  createSimulatedDevice,
  type DeviceFactory,
  type EngineEventListener,
  type EngineRuntimeOptions,
  type EngineRuntimeState,
  type EngineSnapshot,
  type FaultProfile,
  type InjectEventInput,
  type InjectEventOptions,
  type InjectEventResult,
  type InjectedEventRecord,
  type PhysicsLodTier,
  type AdvanceToOptions,
  type RuntimeCollaborationRecord,
  type RuntimeDecisionRecord,
  type RuntimeDevice,
} from './contract.js';

const logger = createLogger('EngineRuntime');
// L1 contract: ./contract.ts; L2 shaping: ./shaping/ (architecture-runtime.md).

export class EngineRuntime {
  readonly id: string;
  readonly scenario: ScenarioDefinition;

  private readonly tickMs: number;
  private readonly autoInitiateAC: boolean;
  private readonly acMode: NonNullable<EngineRuntimeOptions['acMode']>;

  private state: EngineRuntimeState = 'created';
  private speed = 1;
  private tickCount = 0;
  private simTimeSec = 0;
  // 架构轮：这三个字段在 assembleWorld() 中赋值（构造器第一调用）；去掉 readonly 使方法级赋值合法（等价语义：构造路径内只赋一次）。
  private simStartTime!: Date;
  private tickHandle?: unknown;
  private readonly tickTimer;
  private tickInProgress = false;
  // Fix-42b′: wall cost of the most recent auto-run tick + the throttle flag, surfaced through getSnapshot() so operators can see the degraded cadence.
  private lastTickWallMs = 0;
  private autoThrottled = false;
  // T43: trailing-window speed sampler (Σsim/Σwall ~60s, shaping/speed-window); reset on start/pause.
  private readonly speedWindow = new SpeedWindowSampler();

  private timeManager!: TimeManagerLike;
  private physicalEnv!: PhysicalEnvironmentLike;
  private readonly envCenter: EnvironmentCenter;
  private readonly agents = new Map<string, CognitiveAgent>();
  // R91 感知状态：棘轮基线（key `${zoneId}:${param}`）+ 上次扫描仿真时刻。
  // Agent 是具身的：世界状态连续变化由运行时按 cadence 差分化为感知刺激
  // （ENVIRONMENT_PARAM_CHANGED），不再依赖外部"事件"投喂。
  readonly perception = new AgentPerceptionModule(() => this.perceptionWorld);

  // R91 感知世界切面：私有运行时状态的最小只读聚合（结构化满足
  // agent-perception 的 PerceptionWorld，避免扩张引擎文件）
  get perceptionWorld(): import('./agent-perception.js').PerceptionWorld {
    return {
      id: this.id,
      simTimeSec: this.simTimeSec,
      simStartEpochMs: this.simStartTime.getTime(),
      scenario: this.scenario,
      isAgentEnabled: id => this.isAgentEnabled(id),
      physicalEnv: this.physicalEnv,
      agents: this.agents,
      resolveManagingAgents: zoneId => this.resolveManagingAgents(zoneId),
    };
  }

  /** R92 感知入口：差分世界状态、投递刺激给管理 Agent；返回本次刺激。
   *  宿主（世界会话驱动器）按 cadence 调用 —— 感知是观察侧，不进 tick 调度。 */
  scanAndDeliverPerception(): Promise<import('./agent-perception.js').PerceptionStimulus[]> {
    return this.perception.scanAndDeliver();
  }
  private readonly devices: RuntimeDevice[] = [];
  private readonly devicesById = new Map<string, RuntimeDevice>();
  private readonly agentRuntimeInfo = new Map<string, {
    managedZoneIds: string[];
    boundDeviceIds: string[];
    llmEnabled: boolean;
    /**
     * Master enable switch (ScenarioAgent.enabled, default true). Disabled
     * agents receive no injected events and are excluded from partner
     * selection (via agent metadata); runtime-toggleable via setAgentEnabled.
     */
    enabled: boolean;
  }>();

  private readonly firedEventIds = new Set<string>();
  /** R98: per-event fire outcome (effect/error, built by scheduledFireRecord) for snapshot.scheduledEvents. In-memory only (checkpoint keeps the fired flags, not the details — follow-up). */
  private readonly firedEventDetails = new Map<string, ScheduledEventFireRecord>();
  /** R102: recent runtime-injected events — the snapshot's injectedEvents face (capped ring). */
  private readonly injectedEventLog: InjectedEventRecord[] = [];
  private eventSeq = 0;
  private eventNonce?: string; // R102: instance nonce — runtime ids stay unique across world rebuilds.

  /**
   * T-024: the LLM model each agent decides with (per-agent client
   * override, else the shared client; absent for rule-only agents). Feeds
   * recentDecisions' `llmModel` so snapshot consumers can attribute
   * decisions to a model without joining trajectory files.
   */
  private readonly agentLlmModels = new Map<string, string>();

  // Building tier (B-B): current headcount per zone (zones that declared
  // `occupancy` or received an occupancy event). Drives the per-zone
  // occupancy effect sources registered with the physics layer.
  private readonly zoneOccupancy = new Map<string, number>();
  // T-606 (R26): injection-written parameter names feed the snapshot union.
  private readonly injectedParameterNames = new Set<string>();
  private readonly recentDecisions: RuntimeDecisionRecord[] = [];
  private readonly listenerSubIds: string[] = [];
  private listenerSeq = 0;
  private inflightEventId: string | undefined;

  // Fault injection (P3d): R21-W2 — all fault state + logic lives in the
  // DeviceFaultSeam (fault-seam.ts); devices are wrapped there at
  // construction so EVERY command path observes injected faults.
  private readonly faultSeam: DeviceFaultSeam;

  // T-103 (F-PH21): zone-scoped power-outage envelopes (state machine in
  // power-outage.ts); commands to cut-off devices fail at the fault seam.
  private readonly powerOutages = new PowerOutageState();

  // Reputation learning (P4-1): one tracker per runtime, shared by every
  // agent's partner negotiator; fed by COLLABORATION_COMPLETED outcomes and
  // attributable device-operation failures. Clock = SIM time (TimeManager),
  // so the score's recency decay follows simulated, not wall, time.
  private readonly reputation: ReputationTracker;
  private readonly reputationSubIds: string[] = [];
  /** R40-A2：声誉消费面总开关（negotiator 装配与元认知声誉桥共用；ablation 时都不接）。 */
  private readonly reputationEnabled: boolean;
  /** collaborationId → capabilities requested by that AC (learned from
   * ac-proposal messages; fallback when the completion event lacks them). */
  private readonly acCapabilities = new Map<string, string[]>();

  // Effect verification (Fix-12): pending before/after temperature rechecks
  // for temperature-class commands, keyed by nothing — a small FIFO scanned
  // each tick; entries are due in SIM time so step()/start() both drive them.
  private readonly effectCheckWindowSec: number;
  private readonly pendingEffectChecks: Array<{
    agentId: string;
    deviceId: string;
    zoneId: string;
    commandName: string;
    direction: 'up' | 'down';
    before: number;
    dueSimSec: number;
    capabilities: string[];
  }> = [];

  private trajectoryRecorder: TrajectoryRecorder | null = null;

  // P4-2: triage option + shared LLM client (for snapshot llm metrics).
  private readonly triageOption?: EngineRuntimeOptions['triage'];
  private readonly sharedLlmClient?: LLMClient;
  // P4-3: workflow synthesis option (threaded to LLM-backed agents only).
  private readonly workflowSynthesisOption?: EngineRuntimeOptions['workflowSynthesis'];
  // T-022: bounded degradation policy for LLM-backed decisions.
  private readonly llmFailureOption?: EngineRuntimeOptions['llmFailure'];
  // BUG-01: operator option offer rules (merged with the scenario's at the
  // GT seam so the ground-truth backing check reads the same table the
  // actuation planner was configured with).
  private readonly offerRulesOption?: EngineRuntimeOptions['semanticOfferRules'];

  // User-orchestrated flows: built only when a flowsProvider is given or
  // the scenario declares flows. Null on legacy paths — behavior unchanged.
  private flowEngine: FlowEngine | null = null;
  /**
   * Living-worlds P1: the SAME provider the FlowEngine evaluates against
   * (kept for due-moment computation — dynamic enable/edit must reach the
   * due scheduler too). Undefined iff flowEngine is null.
   */
  private flowsProviderRef?: () => FlowDefinition[];
  private readonly flowRunListeners: Array<(record: FlowRunRecord) => void> = [];

  /**
   * Living-worlds P1: when true, start()/resume() enter 'running' WITHOUT the
   * wall-clock tick timer — advancement is due-driven (advanceTo, called by
   * the host's lazy scheduler; the design's WARM semantics).
   */
  private lazyTimerMode = false;

  /**
   * Living-worlds P1: how many full tick BODIES (fireDueEvents + flow onTick)
   * executed — the laziness gauge. A per-tick run of T sim-sec at speed 1
   * counts T; a lazy advanceTo(T) counts only its due moments (+1 for the
   * target landing). Physics substeps are NOT reduced (dt=1 stride keeps
   * bit-equality — see PHYSICS_SUBSTEP_SEC).
   */
  private tickBodyCount = 0;

  /** Living-worlds P1: condition-trigger re-eval cadence override (policy). */
  private readonly conditionEvalEverySimSec?: number;

  /** R30 (LOD): tier + idle batch bank + step gauge (pure: shaping/lod.ts). */
  private readonly lod = new PhysicsLodController();

  /**
   * True while a COARSE advanceTo runs (AdvanceToOptions.coarseStrideSec):
   * the due grid coarsens the condition-eval cadence to the same §8.3 policy
   * the idle tier rides (IDLE_CONDITION_EVAL_EVERY_TICKS × tick).
   */
  private coarseAdvanceActive = false;

  /**
   * R14 data services (design-data-services.md §3.1): listeners for injected
   * events. Injections are delivered to managing agents DIRECTLY (routed
   * mode) — they never appear on the event bus, so a bus subscription cannot
   * see them. The server's per-sim event tally subscribes here; same guarded
   * fan-out shape as flowRunListeners.
   */
  private readonly injectedEventListeners: Array<(record: InjectedEventRecord) => void> = [];

  /**
   * Runtime-wide primary-initiator dedup. When multiple agents manage the
   * same zone, only the first to claim an event becomes the primary
   * initiator; others defer so they don't emit competing proposals.
   */
  private readonly initiatorCoordinator: InitiatorCoordinator;

  /**
   * Build the world once: environment, devices, agents, registries.
   * The tick loop does not start until `start()` (or `step()`) is called.
   */
  constructor(scenario: ScenarioDefinition, options: EngineRuntimeOptions = {}) {
    this.scenario = scenario;
    this.id = `runtime-${scenario.meta.id}`;
    this.tickMs = options.tickMs ?? 10;
    this.tickTimer = options.tickTimer ?? WALL_TICK_TIMER;
    this.autoInitiateAC = options.autoInitiateAC ?? true;
    this.acMode = options.acMode ?? 'enabled';
    this.effectCheckWindowSec = options.effectCheckWindowSec ?? 600;
    this.faultSeam = new DeviceFaultSeam(options.faultSeed ?? DeviceFaultSeam.randomSeed(), {
      // Bus narration of fault-caused failures (device.error) — emitted at
      // the seam so every command path's episode log shows WHY it failed.
      narrateCommandFailure: (device, commandName, error, profile) => {
        this.envCenter.eventManager.publish({
          type: EventType.DEVICE_ERROR,
          source: `engine-runtime:${this.id}`,
          priority: EventPriority.HIGH,
          payload: {
            deviceId: device.id,
            deviceName: device.name,
            commandName,
            error,
            fault: { ...profile },
          },
          metadata: { eventType: 'device.error', faultInjected: true },
        });
      },
    }, {
      // T-103 (F-PH21): an ACTIVE outage cuts the device off — commands fail
      // like offline faults (checked at dispatch on every command path).
      isUnpowered: deviceId => this.powerOutages.isDeviceCutOff(deviceId, this.simTimeSec),
    });
    this.triageOption = options.triage;
    this.sharedLlmClient = options.llmClient;
    this.workflowSynthesisOption = options.workflowSynthesis;
    this.llmFailureOption = options.llmFailure;
    this.offerRulesOption = options.semanticOfferRules;
    this.conditionEvalEverySimSec = options.conditionEvalEverySimSec;
    this.initiatorCoordinator = new InitiatorCoordinator();

    // World assembly: physics environment, zone geometry, baselines, occupancy.
    this.assembleWorld(scenario, options);

    // 2. EnvironmentCenter
    this.envCenter = new EnvironmentCenter({
      id: this.id,
      name: localizedText(scenario.meta.name, 'zh-CN'),
      createdBy: 'engine-runtime',
      createdAt: new Date(),
      updatedAt: new Date(),
      physicalEnvironment: this.physicalEnv as unknown as Record<string, unknown>,
    });

    // 3. Devices (factory or SimulatedDevice; fault-wrapped + zone-placed).
    this.assembleDevices(scenario, options);

    // 4. Trajectory recording (optional sink) — pure assembly in shaping
    // (createTrajectoryRecorder: T-014 model attribution + append/segment
    // options; T-601 null llmPerAgent entries are not clients).
    this.trajectoryRecorder = createTrajectoryRecorder(scenario, options);

    // 5. Agents (one CognitiveAgent per scenario agent)
    for (const agentDef of scenario.agents) {
      this.buildAgent(agentDef, options);
    }

    // 5a. R91 感知基线：构造即扫描一次，让 perceptionState 记住"世界被
    //     外部改变之前"的样子 —— 否则注入前的漂移会被基线初始化吞掉。
    void this.perception.scanAndDeliver(); // 感知基线初始化（t=0：只记基线）

    // 5b. Reputation learning (P4-1): tracker on the sim clock, attached to
    //     every agent's partner negotiator (unless disabled for ablation),
    //     fed by collaboration/device-failure events on the bus.
    this.reputation = new ReputationTracker(
      {},
      () => this.timeManager.getCurrentTime().getTime(),
    );
    this.reputationEnabled = options.reputationEnabled !== false;
    this.initReputation(options);

    // 5c + 6: Flow engine wiring + LLM trajectory logging.
    this.assembleFlows(scenario, options);
    this.assembleLlmLogging(options);
    // R6-E-F10 (step 6b): device-command execution receipts → trajectory (shaping/device-execution).
    this.listenerSubIds.push(wireDeviceExecutionTrajectory({
      eventManager: this.envCenter.eventManager, runtimeId: this.id, recorder: this.trajectoryRecorder,
      inflightEventId: () => this.inflightEventId, managingAgentOf: d => [...this.agentRuntimeInfo.entries()].find(([, i]) => i.boundDeviceIds.includes(d))?.[0],
    }));

    logger.info(
      `EngineRuntime "${this.id}" built: ${scenario.zones.length} zones, ` +
      `${this.devices.length} devices, ${this.agents.size} agents`,
    );
  }

  // -------------------------------------------------------------------------
  // Assembly phases (constructor decomposition — each is a pure assembly
  // step over the scenario + options, mutating only the fields it owns)
  // -------------------------------------------------------------------------

  /**
   * World assembly (constructor steps 1–1d): TimeManager, PhysicalEnvironment,
   * zone geometry registration, baseline seeding, and initial occupancy.
   * Everything here is a silent initial condition — no agent events fire.
   */
  private assembleWorld(scenario: ScenarioDefinition, options: EngineRuntimeOptions): void {
    const sim = loadSimulation();

    // TimeManager + PhysicalEnvironment (runner construction pattern); the TimeManager is never
    // started as a real-time clock; the runtime advances simulated time deterministically per tick via jumpTo(). T118: simStartEpochMs pins the wall anchor (contract.ts); absent = the construction moment.
    this.timeManager = new sim.TimeManager({ timeScale: 1, ...(options.simStartEpochMs !== undefined ? { startTime: new Date(options.simStartEpochMs) } : {}) });
    this.simStartTime = this.timeManager.getCurrentTime();
    this.physicalEnv = new sim.PhysicalEnvironment(this.timeManager, {
      simDurationSeconds: options.simDurationSeconds ?? 60,
      // World noise is opt-in (scenario meta); a fresh world is deterministic (P1-7).
      environmentNoise: scenario.meta.environmentNoise === true,
      ...parameterPhysicsConfig(scenario.meta), // FEAT-03 custom-parameter dynamics + coupling
    });

    // Zone geometry: localized writes, diffusion, and device effects get
    // real coordinates (zones without bounds keep legacy global behavior).
    this.registerZoneGeometry();

    // Per-zone baseline conditions (silent — no agent events).
    this.seedZoneBaselines();

    // Per-zone occupancy effect sources (B-B, silent initial headcount).
    for (const zone of scenario.zones) {
      if (zone.occupancy !== undefined) {
        this.setZoneOccupancy(zone.id, zone.occupancy);
      }
    }
  }

  /**
   * Device assembly (constructor step 3): create each scenario device via
   * the factory (P3a hass://) or SimulatedDevice, fault-wrap it (P3d), and
   * place it at its zone's center for physics.
   */
  private assembleDevices(scenario: ScenarioDefinition, options: EngineRuntimeOptions): void {
    for (const deviceDef of scenario.devices) {
      const rawDevice = options.deviceFactory
        ? options.deviceFactory(deviceDef)
        : createSimulatedDevice(deviceDef);
      // The fault-aware Proxy is what gets registered everywhere, so EVERY
      // command path observes injected faults (P3d).
      const device = this.faultSeam.wrap(rawDevice);
      this.envCenter.registerDevice(device as unknown as Device, 'engine-runtime');
      this.devices.push(device);
      this.devicesById.set(deviceDef.id, device);

      // Place at the zone center so physics effects emanate from real
      // coordinates instead of (0,0).
      const zone = scenario.zones.find(z => z.id === deviceDef.zoneId);
      const center = zone
        ? zoneCenter(zone, scenario.meta.storeyHeight ?? DEFAULT_STOREY_HEIGHT_M)
        : undefined;
      if (zone && center) {
        this.physicalEnv.getPhysicsLayer?.()?.getSpatialManager()
          .setDevicePosition(deviceDef.id, zone.id, center, zone.id);
      }
    }
  }

  /**
   * Flow engine assembly (constructor step 5c): an explicit flowsProvider
   * wins; otherwise the scenario's own enabled flows drive the engine.
   * Fix-44e zone-scoped invoker; env-state via the same read path as
   * getSnapshot(); run records fan out to listeners.
   */
  private assembleFlows(scenario: ScenarioDefinition, options: EngineRuntimeOptions): void {
    // DevLoop T-302 (shadow invariant, EO-F03): "shadow 仿真永不改变物理状态"
    // is ABSOLUTE and covers BOTH actuation lanes. The agent lane is already
    // gated in DualTriggerACManager; suspending the flow engine here means
    // flows simply never fire in shadow runs — no run records, no device
    // writes, and deliberately NO fabricated would-have-run records.
    if (this.acMode === 'shadow') {
      logger.info(
        `[${this.id}] acMode=shadow: flow engine suspended — flows never execute in shadow simulations`,
      );
      return;
    }
    const flowsProvider = options.flowsProvider ??
      (scenario.flows !== undefined ? () => (scenario.flows ?? []).filter(f => f.enabled) : undefined);
    if (flowsProvider === undefined) return;
    // Living-worlds P1: due-moment computation re-reads the same provider.
    this.flowsProviderRef = flowsProvider;
    // T-502: zone lookup shared by the node invoker + the budget inventory.
    const zoneOfDevice = (deviceId: string) => scenario.devices.find(d => d.id === deviceId)?.zoneId;
    this.flowEngine = new FlowEngine({
      scenario,
      flowsProvider,
      // T-051: keep the runtime assignment pass on the same executability
      // oracle the authoring validation uses (see FlowEngineOptions).
      ...(options.isExecutableCapability !== undefined
        ? { isExecutableCapability: options.isExecutableCapability }
        : {}),
      // Mechanism A: the delegate runner seam — the only LLM entry into flow
      // execution (PlanExecutor stays model-free). Client lookup mirrors
      // buildAgent (llmPerAgent > shared llmClient); T-022 llmFailure threads
      // through; T-050 precedence gates delegate actuation (judgment still
      // recorded when the sim/agent policy opts out).
      delegateRunner: {
        llmClientFor: agentId => resolveAgentLlmClient(scenario, options, agentId),
        ...(options.llmFailure !== undefined ? { llmFailure: options.llmFailure } : {}),
        isEnabledAgent: id => this.isAgentEnabled(id),
        autoActuateIndependentFor: agentId => {
          const agentDef = scenario.agents.find(a => a.id === agentId);
          return options.autoActuateIndependent
            ?? agentDef?.decisionPolicy?.autoActuateIndependent
            ?? true;
        },
      },
      agents: this.agents,
      invoker: createFlowNodeInvoker(this.agents, id => this.isAgentEnabled(id), zoneOfDevice),
      // T-502 (EC24-F02): live budget-device inventory for actuating delegate prompts.
      budgetDeviceOf: createBudgetDeviceLookup(id => this.devicesById.get(id), zoneOfDevice),
      envStateReader: () => this.readZoneEnvSnapshot(),
      publish: (type, payload) => {
        this.envCenter.eventManager.publish({
          type: type as EventType,
          source: `engine-runtime:${this.id}`,
          priority: EventPriority.NORMAL,
          payload,
          metadata: { eventType: type },
        });
      },
      onRun: record => {
        for (const listener of this.flowRunListeners) {
          try {
            listener(record);
          } catch (error) {
            logger.warn(`Flow run listener failed (non-fatal): ${(error as Error).message}`);
          }
        }
      },
    });

    wireAgentFlowLanes({
      agents: this.agents, flowsProvider, scenario, inflightEventId: () => this.inflightEventId,
      invokeAsAgent: (flowId, agentId, params, eventId) => this.flowEngine!.runAsAgent(flowId, agentId, params, { eventId }),
    });
  }

  /**
   * LLM trajectory logging assembly (constructor step 6): wire one logging
   * callback per unique real client into the trajectory recorder (P4-2
   * triage client included).
   */
  private assembleLlmLogging(options: EngineRuntimeOptions): void {
    if (!this.trajectoryRecorder) return;

    // Shared + per-agent + triage + per-function routed clients (one
    // collection seam — a routed client can never be skipped).
    for (const client of collectRuntimeLlmClients(options)) {
      client.setLoggingCallback(params => {
        this.trajectoryRecorder?.recordLLMCall(params);
      });
      client.setContextProvider(() => ({ eventId: this.inflightEventId }));
    }
  }

  // -------------------------------------------------------------------------
  // Tick loop control
  // -------------------------------------------------------------------------

  /**
   * Start the tick loop. `speed` is simulated seconds advanced per tick
   * (default 1; tick interval is `tickMs` real milliseconds). Calling start
   * while already running just updates the speed.
   * Living-worlds P1: `options.lazy` enters 'running' WITHOUT the wall-clock
   * tick timer — the host's due-moment scheduler drives advancement via
   * advanceTo (design §8: between due moments the world needs no ticks). The
   * mode is sticky: pause()/resume() keep it.
   * DevLoop (DoS guard): each tick executes `Math.round(speed)` physics
   * substeps, so speed directly multiplies per-tick CPU cost. An unbounded
   * value (`{"speed": 1e9}` was accepted) saturated the host's event loop
   * for minutes — one bad request wedged the whole server. Bounded at
   * MAX_SPEED (10k sim-s/tick ≈ 2.7 sim-hours per real second).
   */
  start(speed = 1, options: { lazy?: boolean } = {}): void {
    this.assertNotStopped('start');
    EngineRuntime.assertSpeedValue(speed, 'start',
      ' (larger values multiply the per-tick physics substeps and starve the process)');
    if (options.lazy === true) this.lazyTimerMode = true;
    this.speed = speed;
    this.state = 'running';
    this.speedWindow.reset(); // fresh window per running episode
    if (this.tickHandle !== undefined) return;
    if (this.lazyTimerMode) {
      logger.info(`EngineRuntime running due-driven (lazy, speed=${speed} sim-s/tick — no tick timer)`);
      return;
    }
    this.scheduleNextTick(this.tickMs);
    logger.info(`EngineRuntime started (speed=${speed} sim-s/tick, tick=${this.tickMs}ms)`);
  }

  /**
   * Fix-42b′: self-scheduling tick loop. After each tick the next delay is
   * `max(tickMs, lastTickWallMs × 1.2 + 1)` — a tick that costs more than the
   * configured budget stretches the interval instead of the loop running
   * back-to-back and saturating the host process. `autoThrottled` in the
   * snapshot marks the degraded cadence.
   * DevLoop T-010: the flag also fires on event-loop LAG. The original
   * decision only looked at the tick's own body cost, so a runtime sharing
   * one busy event loop with many concurrent simulations ticked at a
   * fraction of its configured cadence while reporting
   * `autoThrottled: false` — 15 campus sims at speed 5 collapsed to 8% of
   * the configured rate with the gauge still green. A timer that fires
   * materially after its deadline (other sims' ticks, request storms,
   * snapshot serialization) is cadence degradation the body-cost number
   * cannot see.
   */
  private scheduleNextTick(delayMs: number): void {
    const timeoutMs = Math.max(0, delayMs);
    const deadlineMs = Date.now() + timeoutMs;
    this.tickHandle = this.tickTimer.schedule(() => {
      void (async () => {
        if (this.state !== 'running') return;
        const fireLagMs = Math.max(0, Date.now() - deadlineMs);
        const startedAt = Date.now();
        await this.tick();
        this.lastTickWallMs = Date.now() - startedAt;
        this.speedWindow.record(this.speed); // T43: one window sample per completed tick
        if (this.state !== 'running') return;
        const nextDelay = EngineRuntime.nextTickDelay(this.tickMs, this.lastTickWallMs);
        this.autoThrottled = EngineRuntime.isTickThrottled(this.tickMs, nextDelay, fireLagMs);
        this.scheduleNextTick(nextDelay);
      })();
    }, timeoutMs);
  }

  /**
   * Fix-42b′ cadence math (pure, for tests): the next delay is the
   * configured budget, or the last tick's wall cost × 1.2 + 1ms margin —
   * whichever is larger.
   */
  static nextTickDelay(tickMs: number, tickWallMs: number): number {
    return Math.max(tickMs, Math.ceil(tickWallMs * 1.2) + 1);
  }

  /**
   * Throttle decision (pure, for tests): the cadence is degraded when the
   * stretched next delay OR the late-fire lag exceeds 4× the budget (T-010:
   * the lag term catches event-loop contention the body cost cannot see).
   */
  static isTickThrottled(tickMs: number, nextDelayMs: number, fireLagMs: number): boolean {
    const threshold = tickMs * 4;
    return nextDelayMs > threshold || fireLagMs > threshold;
  }

  /** Pause the tick loop (sim time freezes; state is preserved). */
  pause(): void {
    if (this.state !== 'running') return;
    if (this.tickHandle !== undefined) {
      this.tickTimer.cancel(this.tickHandle);
      this.tickHandle = undefined;
    }
    this.state = 'paused';
    this.speedWindow.reset(); // samples never span a frozen gap (T43)
    logger.info('EngineRuntime paused');
  }

  /** DevLoop (DoS guard): upper bound on sim-seconds per tick (see start). */
  static readonly MAX_SPEED = 10_000;

  /** Shared speed bounds for start/resume/retargetSpeed (tests match the message). */
  static assertSpeedValue(speed: number, op: string, note = ''): void {
    if (!(speed > 0) || speed > EngineRuntime.MAX_SPEED) {
      throw new Error(`EngineRuntime.${op}: speed must be > 0 and <= ${EngineRuntime.MAX_SPEED} sim-s per tick${note}, got ${speed}`);
    }
  }

  /**
   * Resume a paused runtime. Without an argument the last configured speed
   * is reused; `resume(speed)` also retargets the speed in the same
   * transition (the natural moment to change pace — the sim is frozen).
   */
  resume(speed?: number): void {
    if (this.state !== 'paused') return;
    if (speed !== undefined) EngineRuntime.assertSpeedValue(speed, 'resume');
    this.tickHandle = undefined; // start() re-creates the interval
    this.start(speed ?? this.speed);
  }

  /** T43: retarget a live runtime's speed without the pause detour — a pure
   * property change, no lifecycle transition (*-mbt sets unchanged); validation
   * matches resume and the next tick strides at the new pace. */
  retargetSpeed(speed: number): void {
    this.assertNotStopped('retargetSpeed');
    EngineRuntime.assertSpeedValue(speed, 'retargetSpeed');
    this.speed = speed;
  }

  /** Advance the world `n` ticks synchronously (default 1), firing any
   * scheduled events that come due. Works in 'created' and 'paused' states
   * for manual stepping; throws after stop().
   */
  async step(n = 1): Promise<void> {
    this.assertNotStopped('step');
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`EngineRuntime.step: n must be a positive integer, got ${n}`);
    }
    for (let i = 0; i < n; i++) {
      // Fix-42c: stop() interrupts an in-flight manual step — the loop exits
      // gracefully at the next iteration boundary instead of running to the
      // requested tick count on a torn-down world.
      if (this.state === 'stopped') return;
      this.advanceTickBy(this.speed);
      await this.fireDueEvents();
      // Flow triggers tied to sim time (condition edges, schedules) evaluate
      // after the physics step and scheduled-event injections, so they read
      // the fully-updated world. Awaited for deterministic manual stepping.
      if (this.flowEngine) await this.flowEngine.onTick(this.simTimeSec);
      this.tickBodyCount++;
      // R91 感知：随 tick 体差分世界状态并投递给管理 Agent（观察侧，不改调度）
      // Fix-42a: yield between tick chunks (see STEP_YIELD_EVERY).
      if ((i + 1) % STEP_YIELD_EVERY === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Living-worlds P1: due moments + lazy advance (design §8)
  // -------------------------------------------------------------------------

  /**
   * Build the due-source snapshot from the runtime's OWN state (design §8.2
   * — no wall clock anywhere in here). R21-W2: the assembly lives in
   * shaping (buildDueSourcesFrom — pure); this is the state hand-off.
   */
  private buildDueSources(): DueMomentSources {
    // R30 Task 3: at idle, the condition-eval grid coarsens to
    // IDLE_CONDITION_EVAL_EVERY_TICKS × tick (§8.3 policy; observed-tier
    // catch-up reverts to the bit-exact grid; explicit policy wins). A coarse
    // advanceTo rides the same policy for its duration.
    const conditionEvalEverySimSec = this.conditionEvalEverySimSec ??
      (this.lod.getTier() === 'idle' || this.coarseAdvanceActive
        ? IDLE_CONDITION_EVAL_EVERY_TICKS * this.speed
        : undefined);
    return buildDueSourcesFrom({
      scenarioEvents: this.scenario.events.map(event => ({
        id: event.id,
        atSimTimeSec: event.atSimTimeSec,
        fired: this.firedEventIds.has(event.id),
      })),
      zones: this.scenario.zones,
      occupancyFiredKeys: this.occupancyScheduleFired,
      pendingEffectChecks: this.pendingEffectChecks,
      ...(this.flowsProviderRef !== undefined ? { flows: this.flowsProviderRef } : {}),
      ...(this.flowEngine !== null
        ? {
            flowEnginePresent: true as const,
            triggerDueState: (defs: ReadonlyArray<FlowDefinition>) =>
              this.flowEngine!.triggerDueState(defs),
            // FEAT-06: runs parked on wait nodes are a due source — a lazy
            // world must wake when the earliest armed wait expires.
            pendingFlowWaits: this.flowEngine.waitDueSimSecs().map(dueSimSec => ({ dueSimSec })),
          }
        : { flowEnginePresent: false }),
      ...(conditionEvalEverySimSec !== undefined
        ? { conditionEvalEverySimSec }
        : {}),
      tickSec: this.speed,
      // R91 感知节奏：世界按 cadence 醒来感知（与 per-tick 扫描时刻逐位一致）
    });
  }

  /**
   * Living-worlds P1: the next due moment strictly after the current sim
   * time, computed from the runtime's own state (§8.2 source table — pure,
   * no wall clock). Null when nothing is due within the horizon. Host lazy
   * schedulers use this to decide when to wake the world.
   */
  peekNextDueMoment(horizonSimSec?: number): DueMoment | null {
    this.assertNotStopped('peekNextDueMoment');
    return nextDueMoment(
      this.buildDueSources(),
      this.simTimeSec,
      horizonSimSec ?? Number.POSITIVE_INFINITY,
    );
  }

  /** Living-worlds P1: every due moment in (from, to] — tests/inspection. */
  peekDueMoments(fromSimSec: number, toSimSec: number): DueMoment[] {
    this.assertNotStopped('peekDueMoments');
    return computeDueMoments(this.buildDueSources(), fromSimSec, toSimSec);
  }

  /** Living-worlds P1: full tick bodies executed so far (the laziness gauge). */
  getTickBodyCount(): number {
    return this.tickBodyCount;
  }

  /** Living-worlds P1: whether start() entered due-driven (timer-less) mode. */
  isLazyAdvance(): boolean {
    return this.lazyTimerMode;
  }

  /** R30 (LOD): set the physics tier (semantics: shaping/lod.ts). Tier flips ride the P1W observer pins; banked idle seconds integrate at the idle stride first. */
  setLodTier(tier: PhysicsLodTier): void {
    const flush = this.lod.takePending();
    if (flush > 0) this.runPhysicsSubsteps(flush);
    this.lod.switchTier(tier);
    logger.info(`EngineRuntime "${this.id}" physics LOD tier → ${tier}`);
  }

  getLodTier(): PhysicsLodTier {
    return this.lod.getTier();
  }

  getPhysicsStepCount(): number {
    return this.lod.getStepCount();
  }

  /**
   * Living-worlds P1 (§8.3): advance to an ABSOLUTE sim time by executing
   * ONLY the due moments in (now, target] (the lazy-run counterpart of
   * per-tick stepping). Determinism: dt=1 substeps + tick body at every due
   * moment AND at the target, so advanceTo(T) == stepping to T (P1
   * invariant #2; condition-trigger flows keep the tick grid as cadence).
   * Chunked advanceTo(a→b)+advanceTo(b→c) == advanceTo(a→c).
   *
   * COARSE FAST-FORWARD (world-session catch-up of multi-day backlogs,
   * AdvanceToOptions.coarseStrideSec > speed): due-moment segmentation and
   * the tick bodies are UNCHANGED — every due fires exactly once at the same
   * sim moment as a per-tick run (the equivalence arm's substance: 懒世界
   * 醒来的时刻与持续运行相同). Only the PHYSICS between two dues integrates
   * coarser: strides of up to coarseStrideSec sim-seconds, each integrated
   * with ceil(stride/coarseSubstepSec) substeps of dt ≈ coarseSubstepSec
   * (default the idle tier's IDLE_PHYSICS_SUBSTEP_SEC), with env baselines
   * and power-outage transitions refreshed per substep. The result is NOT
   * bit-exact against a per-tick run — a documented LOD tolerance of the
   * same category as the idle tier (shaping/lod.ts), per §8.4's determinism
   * boundary. Condition-flow re-evaluation rides the sanctioned §8.3 10×
   * grid during a coarse advance (same policy as the idle tier).
   */
  async advanceTo(targetSimTimeSec: number, options?: AdvanceToOptions): Promise<void> {
    this.assertNotStopped('advanceTo');
    if (!Number.isFinite(targetSimTimeSec)) {
      throw new Error(`EngineRuntime.advanceTo: targetSimTimeSec must be a finite number, got ${targetSimTimeSec}`);
    }
    if (targetSimTimeSec <= this.simTimeSec) {
      throw new Error(
        `EngineRuntime.advanceTo: targetSimTimeSec (${targetSimTimeSec}) must be greater than the ` +
        `current simTimeSec (${this.simTimeSec}) — advance moves forward only`,
      );
    }
    const coarseStrideSec = options?.coarseStrideSec;
    const coarse = coarseStrideSec !== undefined && coarseStrideSec > this.speed;
    const coarseSubstepSec =
      options?.coarseSubstepSec !== undefined && options.coarseSubstepSec > 0
        ? options.coarseSubstepSec
        : IDLE_PHYSICS_SUBSTEP_SEC;
    if (coarse) this.coarseAdvanceActive = true;
    let substepsSinceYield = 0;
    try {
      while (this.simTimeSec < targetSimTimeSec - 1e-9) {
        if (this.state === 'stopped') return; // Fix-42c: stop() interrupts
        const due = this.peekNextDueMoment(targetSimTimeSec);
        const stop = due === null
          ? targetSimTimeSec
          : Math.min(due.atSimSec, targetSimTimeSec);
        // Physics: tick-sized chunks identical to a per-tick run (or coarse
        // strides under the fast-forward option), plus a smaller final chunk
        // to land EXACTLY on the due moment / target.
        while (this.simTimeSec < stop - 1e-9) {
          const stride = Math.min(coarse ? coarseStrideSec : this.speed, stop - this.simTimeSec);
          if (coarse) {
            this.advanceCoarseStrideBy(stride, coarseSubstepSec);
          } else {
            this.advanceTickBy(stride);
          }
          substepsSinceYield++;
          // Fix-42a: yield between tick chunks so one large advance cannot
          // monopolize the event loop.
          if (substepsSinceYield % STEP_YIELD_EVERY === 0) {
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        }
        // Tick body at every segment end (due moment or target): fires due
        // events, resolves effect checks, evaluates flow triggers, and pins
        // the flow engine's (prev, cur] window anchor at the visited time.
        await this.fireDueEvents();
        if (this.flowEngine) await this.flowEngine.onTick(this.simTimeSec);
        this.tickBodyCount++;
        // R91 感知：随 tick 体差分世界状态并投递给管理 Agent（观察侧，不改调度）
      }
    } finally {
      this.coarseAdvanceActive = false;
    }
  }

  /**
   * Shut the runtime down: clear the tick interval, unsubscribe stream
   * listeners, stop every agent, and finalize trajectory recording.
   * Idempotent; the runtime cannot be restarted afterwards.
   */
  stop(): void {
    if (this.state === 'stopped') return;

    // BUG-07: narrate every pending AC handshake as an explicit ac-cancelled
    // BEFORE the bus subscribers and the trajectory recorder are released —
    // pre-fix the waiter was orphaned with the dead eventManager and never
    // landed on the trajectory (see collaboration-lifecycle.ts).
    this.cancelPendingACHandshakes('runtime-stopped');

    if (this.tickHandle !== undefined) {
      this.tickTimer.cancel(this.tickHandle);
      this.tickHandle = undefined;
    }

    for (const subId of this.listenerSubIds) {
      try {
        this.envCenter.eventManager.unsubscribe(subId);
      } catch {
        // Subscription may already be gone
      }
    }
    this.listenerSubIds.length = 0;

    for (const subId of this.reputationSubIds) {
      try {
        this.envCenter.eventManager.unsubscribe(subId);
      } catch {
        // Subscription may already be gone
      }
    }
    this.reputationSubIds.length = 0;

    for (const agent of this.agents.values()) {
      try {
        agent.stop();
      } catch (error) {
        logger.warn(`Failed to stop agent ${agent.id}: ${(error as Error).message}`);
      }
    }

    // Release device-level resources (no-op for sim devices; bridge devices
    // e.g. unsubscribe from their backend connection).
    for (const device of this.devices) {
      try {
        device.dispose?.();
      } catch (error) {
        logger.warn(`Failed to dispose device ${device.id} (non-fatal): ${(error as Error).message}`);
      }
    }

    // The TimeManager was never started as a real-time clock; stop() is
    // called defensively and is safe (it only clears its own interval).
    try {
      this.timeManager.stop();
    } catch {
      // Never started
    }

    this.trajectoryRecorder?.finalize();
    this.state = 'stopped';
    logger.info('EngineRuntime stopped');
  }

  /** BUG-07: see runtime/collaboration-lifecycle.ts (cancel before stop()). */
  cancelPendingACHandshakes(reason: string): number {
    return cancelPendingACHandshakes(this.agents.values(), reason);
  }

  // -------------------------------------------------------------------------
  // Event injection
  // -------------------------------------------------------------------------

  /**
   * Inject an event into a zone: set the physical parameter in the
   * environment, then deliver an ENVIRONMENT_PARAM_CHANGED SystemEvent to
   * the zone's managing agents (targeted delivery, mirroring the runner's
   * routed mode — the event is not broadcast on the bus, so only managing
   * agents process it). Resolves after the target agents have processed it.
   *
   * T-023: `options.deliveryDeadlineMs` bounds the agent-delivery wait —
   * on expiry the result carries `decisionPending: true` (the physical
   * write, flow evaluation and listeners are already applied) while the
   * deliveries finish in the background. Default: wait for all agents.
   */
  async injectEvent(
    input: InjectEventInput,
    options?: InjectEventOptions,
  ): Promise<InjectEventResult> {
    this.assertNotStopped('injectEvent');

    const zone = this.scenario.zones.find(z => z.id === input.zoneId);
    if (!zone) {
      throw new Error(`EngineRuntime.injectEvent: unknown zone "${input.zoneId}"`);
    }

    // B2 demo mode: a manual injection carrying a SCRIPTED event's id consumes
    // that scheduled event — fireDueEvents skips ids already in firedEventIds,
    // so injecting the hero event early (demo playback) does not double-fire
    // when sim time later reaches its atSimTimeSec. Unknown ids are harmless
    // (the set is only ever consulted against scenario event ids).
    if (typeof input.id === 'string' && input.id.length > 0) {
      this.firedEventIds.add(input.id);
    }

    // L2 events shaping: resolve, R98 guard + physical write (shaping/events.ts).
    const { parameter, value } = resolveInjection(input, coerceEventValue);
    assertEventValueWritable(input, parameter, value);

    // T-606: the name joins the snapshot union the moment it is written
    // (occupancy is not a field parameter).
    if (parameter !== 'occupancy') this.injectedParameterNames.add(parameter);

    applyEventPhysicalWrite({
      input,
      zone,
      parameter,
      value,
      physicalEnv: this.physicalEnv,
      setZoneOccupancy: (zoneId, occupancy) => this.setZoneOccupancy(zoneId, occupancy),
      updateZoneBaseline: (zoneId, param, next) => this.updateZoneBaseline(zoneId, param, next),
    });

    // 1a. T-103 (F-PH21): a power-outage event cuts the zone's devices (runtime/power-outage.ts).
    maybeBeginPowerOutage({
      type: input.type,
      zoneId: input.zoneId,
      simTimeSec: this.simTimeSec,
      ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
      scenarioDevices: this.scenario.devices,
      deviceStateOf: id => {
        try {
          return this.devicesById.get(id)?.getState() as Record<string, unknown> | undefined;
        } catch {
          return undefined;
        }
      },
      outages: this.powerOutages,
      apply: () => this.applyPowerOutages(),
    });

    // R14 data services: report the injection to listeners (event-history
    // tally) AFTER the physical write (a recompute they trigger must see the
    // post-event world) and BEFORE anything the injection CAUSES — the flow
    // evaluation below fans out to device commands, and an audit row that
    // lands after the actions it caused reads as time travel (T45, u3 F7).
    // R102: routing + id BEFORE the audit record — the audience rides the trace; the id's
    // sim-time anchor + instance nonce make rebuild re-issuing impossible (chen-19); the level rides the audit (R103 chain).
    const audience = eventAudienceResolver({ agents: this.scenario.agents, zones: this.scenario.zones, devices: this.scenario.devices, agentInfo: this.agentRuntimeInfo, eventNeedsOf: inferNeedsForEventType })(input.zoneId, input.type);
    const targetAgentIds = audience.agentIds;
    const eventId = input.id ??
      `evt-runtime-s${this.simTimeSec}-${++this.eventSeq}-${(this.eventNonce ??= Math.random().toString(36).slice(2, 6))}`;
    reportInjectedEvent({
      input,
      parameter,
      value,
      targetAgentIds,
      routingLevel: audience.level,
      eventId,
      ...(options?.injectedBy !== undefined ? { injectedBy: options.injectedBy } : {}), ...(options?.injectedById !== undefined ? { injectedById: options.injectedById } : {}),
      simTimeSec: this.simTimeSec,
      log: this.injectedEventLog,
      listeners: this.injectedEventListeners,
      warn: message => logger.warn(message),
    });

    // 1b. Event-triggered flows evaluate AFTER the write, BEFORE agents see it (shaping/events.ts).
    await notifyFlowsOfEvent({
      flowEngine: this.flowEngine,
      input,
      parameter,
      value,
      simTimeSec: this.simTimeSec,
    });

    // 2. Deliver the event to managing agents（R91 抽取到 shaping：
    //    deliverInjectedEvent —— 行为逐行保持）
    const eventPayload = buildInjectedEventPayload(input, eventId, { parameter, value });

    this.inflightEventId = eventId;
    const { decisionPending, backgroundError } = await deliverInjectedEvent({
      eventId,
      originType: input.type,
      eventPayload,
      severity: input.severity,
      runtimeId: this.id,
      targetAgentIds,
      agents: this.agents,
      markInflight: () => { this.inflightEventId = eventId; },
      clearInflight: () => {
        if (this.inflightEventId === eventId) this.inflightEventId = undefined;
      },
      ...(options?.deliveryDeadlineMs !== undefined
        ? { deliveryDeadlineMs: options.deliveryDeadlineMs }
        : {}),
    });

    if (targetAgentIds.length === 0) {
      logger.warn(`injectEvent: no managing agents for zone "${input.zoneId}"`);
    }
    if (backgroundError !== undefined) {
      logger.warn(`injectEvent: ${backgroundError}`);
    }

    return {
      eventId,
      parameter,
      value,
      targetAgentIds,
      routingLevel: audience.level,
      ...(decisionPending ? { decisionPending: true as const } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Zone state (building tier, B-B) — implementation: shaping/zone-state.ts
  // -------------------------------------------------------------------------

  /** Lazy seams for the zone-state segment (shaping/zone-state.ts). */
  private zoneStateSeams(): ZoneStateSeams {
    return {
      zones: this.scenario.zones as unknown as ZoneStateSeams['zones'], meta: this.scenario.meta,
      zoneOccupancy: this.zoneOccupancy, physicalEnv: this.physicalEnv as unknown as ZoneStateSeams['physicalEnv'],
      assertNotStopped: op => this.assertNotStopped(op),
    };
  }

  /**
   * Set the current headcount of a zone (B-B occupancy model). Registers
   * (or replaces) the zone's occupancy effect sources with the physics
   * layer — a virtual EffectSource at the zone center contributing
   * `occupancy × occupancyHeatW` sensible heat and
   * `occupancy × occupancyCo2Rate` CO2 emission — following the same
   * mount path as device effects. Zero headcount removes the sources.
   */
  setZoneOccupancy(zoneId: string, occupancy: number): void {
    setZoneOccupancyImpl(this.zoneStateSeams(), zoneId, occupancy);
  }

  /** Current headcount of a zone (0 when never set), or undefined for unknown zones. */
  getZoneOccupancy(zoneId: string): number | undefined {
    if (!this.scenario.zones.some(z => z.id === zoneId)) return undefined;
    return this.zoneOccupancy.get(zoneId) ?? 0;
  }

  /** FEAT-07: consumed boundary memory (by reference) for the due-moments occupantSchedule patch seam. */
  getOccupancyScheduleFiredKeys(): Set<string> { return this.occupancyScheduleFired; }

  // -------------------------------------------------------------------------
  // Agent enable/disable (master switch)
  // -------------------------------------------------------------------------

  /**
   * Toggle an agent's master enable switch at runtime. A disabled agent
   * receives no further injected events and is filtered out of partner
   * selection (its `metadata.enabled` flag is what the negotiator reads);
   * collaborations already in progress run to completion naturally.
   */
  setAgentEnabled(agentId: string, enabled: boolean): void {
    this.assertNotStopped('setAgentEnabled');
    const info = this.agentRuntimeInfo.get(agentId);
    if (!info) {
      throw new Error(`EngineRuntime.setAgentEnabled: unknown agent "${agentId}"`);
    }
    info.enabled = enabled;
    const agent = this.agents.get(agentId);
    try {
      agent?.updateMetadata({ enabled });
    } catch (error) {
      logger.warn(`setAgentEnabled: metadata update failed for ${agentId} (non-fatal): ${(error as Error).message}`);
    }
    logger.info(`Agent "${agentId}" ${enabled ? 'enabled' : 'disabled'}`);
  }

  /** Whether an agent currently receives events / is partner-eligible. */
  isAgentEnabled(agentId: string): boolean {
    return this.agentRuntimeInfo.get(agentId)?.enabled !== false;
  }

  // -------------------------------------------------------------------------
  // User-orchestrated flows
  // -------------------------------------------------------------------------

  /**
   * Subscribe to flow run records (one per flow execution, delivered after
   * the run finishes). Returns an unsubscribe function. Without a
   * FlowEngine (legacy scenarios, no flows) listeners simply never fire.
   */
  onFlowRun(listener: (record: FlowRunRecord) => void): () => void {
    this.flowRunListeners.push(listener);
    return () => {
      const index = this.flowRunListeners.indexOf(listener);
      if (index >= 0) this.flowRunListeners.splice(index, 1);
    };
  }

  /**
   * R14 data services: subscribe to injected events (one record per
   * successful injectEvent, delivered AFTER the physical write + flow
   * evaluation, before agent fan-out). Injections are routed to managing
   * agents directly and never ride the bus — this listener is the only
   * external surface that sees them as a history. Returns an unsubscribe
   * function; listener errors are swallowed (non-fatal, onFlowRun pattern).
   */
  onInjectedEvent(listener: (record: InjectedEventRecord) => void): () => void {
    this.injectedEventListeners.push(listener);
    return () => {
      const index = this.injectedEventListeners.indexOf(listener);
      if (index >= 0) this.injectedEventListeners.splice(index, 1);
    };
  }

  /** The flow engine, or null when no flows are configured. */
  getFlowEngine(): FlowEngine | null {
    return this.flowEngine;
  }

  /** R6-B-F03: attach the agreement-mediated service-node lane (no-op without a flow engine). */
  setFlowServiceInvoker(invoker: FlowServiceInvoker): void {
    this.flowEngine?.setServiceInvoker(invoker);
  }

  /** FEAT-05: attach the host notification lane for notify nodes (no-op without a flow engine). */
  setFlowNotifyInvoker(invoker: FlowNotifyInvoker): void {
    this.flowEngine?.setNotifyInvoker(invoker);
  }

  /**
   * Flow-condition environment snapshot (the getSnapshot() read path shaped as
   * `{ zoneId: { param: value } }` with occupancy merged in; never throws).
   */
  private readZoneEnvSnapshot(): Record<string, unknown> {
    // L2 snapshot shaping (occupancy + NFR-1 comfort merged in).
    const physicsLayer = this.physicalEnv.getPhysicsLayer?.() as ZoneComfortSource | undefined;
    return buildZoneEnvSnapshot(this.scenario.zones, {
      getParameterValue: (parameter, zoneId) => {
        try {
          return this.physicalEnv.getParameterValue(parameter, zoneId);
        } catch {
          return undefined;
        }
      },
      injectedParameterNames: this.injectedParameterNames,
      zoneOccupancy: this.zoneOccupancy,
      comfort: physicsLayer,
    });
  }

  /** B-B: externally driven baseline update (weather feeds, twin-sync pushes). */
  updateZoneBaseline(zoneId: string, parameter: string, value: number | boolean): void {
    updateZoneBaselineImpl(this.zoneStateSeams(), zoneId, parameter, value);
  }

  // -------------------------------------------------------------------------
  // Device control
  // -------------------------------------------------------------------------

  /**
   * Execute a command on a device through its managing agent (Device Layer
   * path). Returns the agent's execution result.
   *
   * @param options.actor - Invocation-context actor (R17 params-purity fix:
   *   who invoked the command, threaded to the device WITHOUT polluting
   *   `params` — secure-state audit fields and the DEVICE_OPERATION_EXECUTED
   *   event carry it as dedicated context).
   */
  /**
   * R42-C gate 3: hypothetical command execution for WHAT-IF forks —
   * bypasses the managing-agent lookup entirely. A what-if runs on a
   * throwaway headless fork with every agent disabled: demanding an
   * agent binding there rejected commands on devices whose manager lives
   * only in the env's newer rows (the D2-F4 class). The fault-wrap Proxy
   * still applies (injected faults behave in predictions), and the actor
   * is stamped 'what-if' for audit.
   */
  async executeHypotheticalDeviceCommand(
    deviceId: string,
    commandName: string,
    params?: Record<string, unknown>,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    this.assertNotStopped('executeHypotheticalDeviceCommand');
    const device = this.devicesById.get(deviceId);
    if (device === undefined) {
      return { success: false, error: `No device "${deviceId}" in this world` };
    }
    const deviceWithCommand = device as unknown as {
      executeCommand?: (commandName: string, params?: unknown, context?: { actor?: string }) => Promise<unknown>;
    };
    if (typeof deviceWithCommand.executeCommand !== 'function') {
      return { success: false, error: `Device "${deviceId}" does not support command execution` };
    }
    try {
      const result = await deviceWithCommand.executeCommand(commandName, params, { actor: 'what-if' });
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async executeDeviceCommand(
    deviceId: string,
    commandName: string,
    params?: Record<string, unknown>,
    options: { actor?: string } = {},
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    this.assertNotStopped('executeDeviceCommand');

    const ownerEntry = [...this.agentRuntimeInfo.entries()]
      .find(([, info]) => info.boundDeviceIds.includes(deviceId));
    if (!ownerEntry) {
      return { success: false, error: `No agent manages device "${deviceId}"` };
    }
    const agent = this.agents.get(ownerEntry[0]);
    if (!agent) {
      return { success: false, error: `Managing agent "${ownerEntry[0]}" not found` };
    }
    return agent.executeDeviceCommand(deviceId, commandName, params, options);
  }

  // -------------------------------------------------------------------------
  // Failure-mode injection (P3d)
  // -------------------------------------------------------------------------

  /**
   * Set (or replace) the fault profile of a device; pass null to clear it.
   * Faults are runtime-level and never persisted. Transitions emit
   * `device.fault_changed { deviceId, profile }` on the event bus
   * (profile = null on clear); re-applying an identical profile is a no-op.
   */
  setDeviceFault(deviceId: string, profile: FaultProfile | null): void {
    this.assertNotStopped('setDeviceFault');
    const device = this.devicesById.get(deviceId);
    if (!device) {
      throw new Error(`EngineRuntime.setDeviceFault: unknown device "${deviceId}"`);
    }

    const previous = this.faultSeam.rawProfile(deviceId) ?? null;
    if (profile === null) {
      if (previous === null) return; // no transition
    } else {
      const normalized = normalizeFaultProfile(profile, deviceId);
      if (previous !== null && JSON.stringify(previous) === JSON.stringify(normalized)) {
        return; // no transition
      }
    }
    this.faultSeam.applyProfile(deviceId, profile, () => device.getState());

    const emittedProfile = profile === null ? null : { ...(this.faultSeam.rawProfile(deviceId) ?? {}) };
    this.envCenter.eventManager.publish({
      type: EventType.DEVICE_FAULT_CHANGED,
      source: `engine-runtime:${this.id}`,
      priority: EventPriority.NORMAL,
      payload: { deviceId, profile: emittedProfile },
      metadata: { eventType: 'device.fault_changed' },
    });
    logger.info(`Fault ${profile === null ? 'cleared' : 'set'} for device "${deviceId}": ${JSON.stringify(emittedProfile)}`);
  }

  /** Active fault profile of a device, or null when healthy/unknown. */
  getDeviceFault(deviceId: string): FaultProfile | null {
    return this.faultSeam.profileOf(deviceId);
  }

  /**
   * T54 (R6 u4-F1): state paths written since construction — the data-read
   * lane's placeholder oracle. Undefined when the device cannot say
   * (honest-unknown: the read gate stays silent, no fabricated verdict).
   */
  getDeviceWrittenPaths(deviceId: string): string[] | undefined {
    const device = this.devicesById.get(deviceId);
    if (!device || typeof device.getWrittenStatePaths !== 'function') return undefined;
    try {
      return device.getWrittenStatePaths();
    } catch {
      return undefined;
    }
  }

  /** All active fault profiles, keyed by device id. */
  listDeviceFaults(): Record<string, FaultProfile> {
    return this.faultSeam.allProfiles();
  }

  // -------------------------------------------------------------------------
  // Reputation (P4-1)
  // -------------------------------------------------------------------------

  /**
   * Learned reputation of an agent. With `capability`: the single
   * (agent, capability) cell with its decayed score (prior-filled zeros
   * when there is no history). Without: the full per-capability breakdown,
   * most-attempted first.
   */
  getReputation(agentId: string, capability?: string): ScoredReputation | ScoredReputation[] {
    if (capability !== undefined) {
      // T71: cell projection extracted to persistence-seams.ts (file budget).
      return reputationCellFace(agentId, capability,
        this.reputation.getRecord(agentId, capability),
        this.reputation.score(agentId, capability));
    }
    return this.reputation.getAgentReputation(agentId);
  }

  // Seed/override one reputation cell directly (persistence load path and tests).
  setReputation(
    agentId: string,
    capability: string,
    data: { attempts: number; successes: number; failures?: number; lastAt?: number },
  ): void {
    this.reputation.setRecord(agentId, capability, data);
  }

  // P4-1 tracker persistence seams (server saves per env; pure logic in persistence-seams.ts).
  getReputationJSON(): ReputationTrackerJSON {
    return this.reputation.toJSON();
  }
  loadReputationJSON(json: ReputationTrackerLoadJSON | undefined | null): void {
    loadReputationInto(this.agents.values(), this.reputation, this.reputationEnabled, json);
  }

  // R6-E-F15 private-experience persistence seams (pure logic in persistence-seams.ts).
  getAgentExperienceJSON(): AgentExperienceJSON {
    return collectAgentExperience(this.agents);
  }
  loadAgentExperienceJSON(json: AgentExperienceJSON | undefined | null): void {
    applyAgentExperience(this.agents, json);
  }

  // -------------------------------------------------------------------------
  // Snapshot + event stream
  // -------------------------------------------------------------------------

  /** JSON-safe whole-world snapshot: sim time, zones, devices, agents, recent decisions, scheduled events. */
  getSnapshot(): EngineSnapshot {
    // R30 (LOD): reads never serve stale physics (no-op at observed).
    this.flushIdlePhysics();
    // Fix-31 slice 2: collect the raw materials, delegate the shaping to the
    // pure builders in shaping (behavior identical to the in-class code).
    const triageMetrics: SnapshotTriageMetrics[] = [];
    let llmErrors = 0;
    if (this.triageOption?.enabled && this.triageOption.client) {
      for (const agent of this.agents.values()) {
        const m = agent.getDualTriggerACManager()?.getTriageMetrics();
        if (m) triageMetrics.push(m);
      }
    }
    // T-105: failed LLM decision calls across agents (assessor counts them
    // before re-throwing) — snapshot-visible so a dead backend is observable.
    for (const agent of this.agents.values()) {
      llmErrors += agent.getDualTriggerACManager()?.getLLMErrorCount() ?? 0;
    }
    return buildEngineSnapshot({
      runtimeId: this.id,
      scenario: this.scenario,
      state: this.state,
      simTimeSec: this.simTimeSec,
      simTimeIso: this.timeManager.getCurrentTime().toISOString(),
      speed: this.speed,
      tickMs: this.tickMs,
      tickCount: this.tickCount,
      lastTickWallMs: this.lastTickWallMs,
      autoThrottled: this.autoThrottled,
      // T43: window rate only while running (paused worlds show honest "—").
      ...(this.state === 'running' ? { speedWindow: this.speedWindow.stats() } : {}),
      getParameterValue: (parameter, zoneId) => {
        try {
          return this.physicalEnv.getParameterValue(parameter, zoneId);
        } catch {
          return undefined;
        }
      },
      injectedParameterNames: this.injectedParameterNames,
      zoneOccupancy: this.zoneOccupancy,
      devicesById: this.devicesById,
      getDeviceFault: id => this.getDeviceFault(id),
      agents: this.agents,
      agentRuntimeInfo: this.agentRuntimeInfo,
      reputationSummarize: agentId => this.reputation.summarize(agentId),
      recentDecisions: this.recentDecisions,
      firedEventIds: this.firedEventIds,
      firedEventDetails: this.firedEventDetails,
      injectedEvents: this.injectedEventLog,
      serviceRegistrations: this.envCenter.getServices(),
      llmCache: this.sharedLlmClient?.getCache?.() ?? null,
      llmErrors,
      triage: this.triageOption?.enabled && this.triageOption.client
        ? {
            mode: this.triageOption.mode ?? 'shadow',
            model: this.triageOption.client.getModel?.(),
            metrics: triageMetrics,
          }
        : null,
    });
  }

  /**
   * Subscribe to the engine event stream (all events flowing through the
   * EnvironmentCenter EventManager: device state changes, agent lifecycle,
   * collaboration events). Pass `types` to filter. Returns an unsubscribe
   * function; subscriptions are also cleaned up by stop().
   *
   * Note: injected scenario events are delivered directly to managing agents
   * (not via the bus), so they appear here only through their downstream
   * effects (device state changes, collaboration events). Use
   * `getSnapshot().recentDecisions` for the decision stream.
   */
  subscribe(
    listener: EngineEventListener,
    types?: EventType | EventType[],
  ): () => void {
    const subId = this.envCenter.eventManager.subscribe({
      subscriberId: `engine-runtime-listener-${this.id}-${++this.listenerSeq}`,
      eventType: types ?? (Object.values(EventType) as EventType[]),
      handler: async (event: SystemEvent) => {
        listener(event);
      },
    });
    this.listenerSubIds.push(subId);

    return () => {
      try {
        this.envCenter.eventManager.unsubscribe(subId);
      } catch {
        // Already gone
      }
      const index = this.listenerSubIds.indexOf(subId);
      if (index >= 0) this.listenerSubIds.splice(index, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Current lifecycle state. */
  getState(): EngineRuntimeState {
    return this.state;
  }

  /** Simulated seconds elapsed (advanced by start/step ticks). */
  getSimTimeSec(): number {
    return this.simTimeSec;
  }

  /** Sim-seconds advanced per tick (the current speed). */
  getSpeed(): number {
    return this.speed;
  }

  /**
   * Living-worlds P1W: the run's WALL anchor — the epoch ms sim-time 0 maps
   * to (set at construction, adopted from checkpoints on restore). Hosts of
   * wall-anchored authoritative sessions map wall-now to a sim target through
   * this anchor; every two-runtime equality comparison must share it (the
   * clock-anchor discipline, P1's debugging round).
   */
  getSimStartEpochMs(): number {
    return this.simStartTime.getTime();
  }

  /** Path of the trajectory JSONL file, or null when recording is off. */
  getTrajectoryFilePath(): string | null {
    return this.trajectoryRecorder?.filePath ?? null;
  }

  // -------------------------------------------------------------------------
  // Living-worlds P0: world-state export / restore (checkpoint seam)
  // -------------------------------------------------------------------------

  /**
   * Export the complete world state at a sim-time boundary (capture rules:
   * shaping/world-state.ts). Timers are never captured; their schedules
   * are. Call on a PAUSED (or created) runtime — see awaitQuiescent.
   */
  exportWorldState(): EngineWorldStateExport {
    this.assertNotStopped('exportWorldState');
    // R30: a checkpoint freezes a physics-current world.
    this.flushIdlePhysics();
    return buildWorldStateExport({
      scenario: this.scenario,
      clock: {
        simTimeSec: this.simTimeSec,
        speed: this.speed,
        tickCount: this.tickCount,
        simStartEpochMs: this.simStartTime.getTime(),
        eventSeq: this.eventSeq,
      },
      rng: this.faultSeam.rngState(),
      getParameterValue: (parameter, zoneId) => {
        try {
          return this.physicalEnv.getParameterValue(parameter, zoneId);
        } catch {
          return undefined;
        }
      },
      zoneOccupancy: this.zoneOccupancy,
      physicsLayer: this.physicalEnv.getPhysicsLayer?.(),
      devices: [...this.devicesById.entries()].map(([id, device]) => ({
        id,
        getState: () => device.getState(),
        getCheckpointState: device.getCheckpointState?.bind(device),
        fault: this.getDeviceFault(id),
      })),
      agents: [...this.agentRuntimeInfo.entries()].map(([id, info]) => ({
        id,
        enabled: info.enabled,
        cognition: this.agents.get(id)?.getDualTriggerACManager()?.getCognitionCheckpoint(),
      })),
      reputation: this.getReputationJSON(),
      recentDecisions: this.recentDecisions,
      acCapabilities: this.acCapabilities,
      scheduler: {
        firedEventIds: this.firedEventIds,
        occupancyFired: this.occupancyScheduleFired,
      },
      perception: { baselines: this.perception.exportState() },
      pendingEffectChecks: this.pendingEffectChecks,
      flowEngine: this.flowEngine?.exportTriggerState() ?? null,
    });
  }

  /**
   * Adopt a checkpointed world state (only a FRESHLY CREATED runtime — a
   * started one has diverging history). Clock anchor first (the plan's
   * global value-model diff reads through it), then zones, devices, faults,
   * effects, agent toggles+cognition, learned state, scheduler, fault RNG.
   * Drift warnings are logged, never thrown.
   */
  restoreWorldState(world: EngineWorldStateExport): void {
    this.assertNotStopped('restoreWorldState');
    if (world.formatVersion !== ENGINE_WORLD_STATE_VERSION) {
      throw new Error(
        `EngineRuntime.restoreWorldState: unsupported world-state format version ` +
        `${JSON.stringify(world.formatVersion)} (expected ${ENGINE_WORLD_STATE_VERSION})`,
      );
    }
    if (this.state !== 'created') {
      throw new Error(
        `EngineRuntime.restoreWorldState: only a freshly created runtime can adopt a ` +
        `checkpoint (current state "${this.state}") — build a new runtime from the same ` +
        'scenario and restore before start()',
      );
    }

    // 1. Clock anchor: every later read (and the global-model diff) goes
    //    through simStartEpochMs + simTimeSec.
    this.simTimeSec = world.simTimeSec;
    this.speed = world.speed;
    this.tickCount = world.tickCount;
    this.simStartTime = new Date(world.simStartEpochMs);
    this.eventSeq = world.eventSeq;
    this.timeManager.jumpTo(new Date(this.simStartTime.getTime() + this.simTimeSec * 1000));

    const plan = planWorldStateRestore(world, {
      scenario: this.scenario,
      deviceIds: new Set(this.devicesById.keys()),
      agentIds: new Set(this.agentRuntimeInfo.keys()),
      readParameter: (parameter, zoneId) => {
        try {
          return this.physicalEnv.getParameterValue(parameter, zoneId);
        } catch {
          return undefined;
        }
      },
    });

    // 2. Zone state, in dependency order: baselines (seed value+attractor)
    //    → field values (point writes) → custom statics → occupancy effect
    //    sources → global model deviations.
    for (const write of plan.fieldBaselines) {
      this.physicalEnv.setParameterBaseline(write.parameter, write.zoneId, write.value);
    }
    for (const write of plan.fieldValues) {
      this.physicalEnv.setLocalParameterValue(write.parameter, write.zoneId, write.value, 0);
    }
    for (const write of plan.customWrites) {
      this.physicalEnv.setLocalParameterValue(write.parameter, write.zoneId, write.value);
    }
    for (const restore of plan.occupancyWrites) {
      this.setZoneOccupancy(restore.zoneId, restore.count);
    }
    for (const write of plan.globalWrites) {
      this.physicalEnv.setParameterValue(write.parameter, write.zoneId, write.value);
    }

    // 3. Devices: state first, then faults (offline/staleState freezes the
    //    state as of the freeze moment — the restored state IS that moment).
    for (const restore of plan.deviceRestores) {
      const device = this.devicesById.get(restore.deviceId);
      if (device?.restoreState) {
        device.restoreState(restore.state);
      } else {
        logger.warn(
          `restoreWorldState: device "${restore.deviceId}" has no restoreState seam — ` +
          'construction initial state kept',
        );
      }
    }
    for (const write of plan.faultWrites) {
      this.setDeviceFault(write.deviceId, write.fault);
    }

    // 4. Physics effects: the device control-loop's registered effect state
    //    (magnitude + enabled) lives in the physics layer, not the devices.
    const physicsLayer = this.physicalEnv.getPhysicsLayer?.();
    for (const effect of plan.effectRegisters) {
      physicsLayer?.registerDeviceEffect?.(effect);
    }

    // 5. Agents: enabled=true is the construction default — only disables ride.
    //    R38-P2: cognition checkpoints (event ring + last decision) restore
    //    the decision-prompt context so resumed runs replay identically.
    for (const agentId of plan.agentDisables) {
      this.setAgentEnabled(agentId, false);
    }
    for (const { agentId, cognition } of plan.agentCognition) {
      this.agents.get(agentId)?.getDualTriggerACManager()?.restoreCognitionCheckpoint(cognition);
    }

    // 6. Learned state (reputation, decision ring, AC capability memos).
    this.loadReputationJSON(world.reputation);
    for (const record of world.recentDecisions) {
      this.recentDecisions.push(record);
      if (this.recentDecisions.length > MAX_RECENT_DECISIONS) {
        this.recentDecisions.shift();
      }
    }
    this.acCapabilities.clear();
    for (const [collaborationId, capabilities] of Object.entries(world.acCapabilities)) {
      this.acCapabilities.set(collaborationId, [...capabilities]);
    }

    // 7. Scheduler state — due moments, never wall-clock timers.
    this.firedEventIds.clear();
    for (const eventId of world.scheduler.firedEventIds) this.firedEventIds.add(eventId);
    this.occupancyScheduleFired.clear();
    for (const key of world.scheduler.occupancyFired) this.occupancyScheduleFired.add(key);
    this.pendingEffectChecks.push(...world.pendingEffectChecks);

    // 7b. Flow-engine trigger memories (edges, cooldowns, one-shots, the
    //     (prev, cur] window anchor) — losing them double-fires boundaries.
    this.flowEngine?.restoreTriggerState(world.flowEngine);

    // 8. Fault RNG: same seed, fast-forwarded the same number of draws.
    this.faultSeam.restoreRng(world.rng.seed, world.rng.draws);

    if (plan.warnings.length > 0) {
      logger.warn(
        `restoreWorldState: ${plan.warnings.length} checkpoint-drift warning(s): ` +
        plan.warnings.join('; '),
      );
    }
    logger.info(
      `restoreWorldState: adopted checkpoint at simTime ${this.simTimeSec}s ` +
      `(${plan.fieldValues.length} field values, ${plan.deviceRestores.length} devices, ` +
      `${plan.effectRegisters.length} effects)`,
    );
    // R91 感知基线随恢复重置：恢复后的世界是新真相（重建不产生刺激）
    this.perception.adopt(world.perception.baselines);
  }

  /**
   * Living-worlds P0: wait until no tick is mid-flight and no injected event
   * is still being delivered — the clean sim-time boundary hibernate exports
   * its checkpoint at. pause() clears the tick TIMER, but an already-started
   * tick body (or a deadline-returned 202 delivery, T-023) keeps running to
   * completion asynchronously; exporting before that lands a checkpoint that
   * misses world mutations the run's own audit trail records.
   * @returns true when quiescent, false on timeout (the caller proceeds —
   * the resume path's tail replay covers late decision records).
   */
  async awaitQuiescent(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!this.tickInProgress && this.inflightEventId === undefined) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Build and register one CognitiveAgent (runner construction pattern). */
  private buildAgent(agentDef: ScenarioAgent, options: EngineRuntimeOptions): void {    const managedDevices = agentBoundDevices(this.scenario.devices, agentDef);
    const managedZoneIds = agentManagedZoneIds(agentDef, managedDevices);

    const llmClient = resolveAgentLlmClient(this.scenario, options, agentDef.id);
    const llmEnabled = llmClient !== undefined;
    // T-024: remember the deciding model for recentDecisions.llmModel
    // (mock/stub clients without getModel() simply leave it unset).
    if (llmEnabled && typeof (llmClient as { getModel?: unknown }).getModel === 'function') {
      const model = (llmClient as { getModel: () => string }).getModel();
      if (typeof model === 'string' && model.length > 0) {
        this.agentLlmModels.set(agentDef.id, model);
      }
    }

    // Fix-31 slice 4: config assembly lives in shaping (rule-only when no
    // LLM, triage + system-prompt assessor overrides). T-050: actuation
    // toggles resolve operator > scenario decisionPolicy > default true;
    // shadow-mode suppression is enforced where acMode is read (manager).
    const agentDecisionPolicy = agentDef.decisionPolicy;
    const { dualTriggerConfig } = buildAgentDualTriggerConfig({
      agentDef,
      managedDevices,
      zones: this.scenario.zones,
      autoInitiateAC: options.autoInitiateAC
        ?? agentDecisionPolicy?.autoInitiateAC
        ?? this.autoInitiateAC,
      autoActuateIndependent: options.autoActuateIndependent
        ?? agentDecisionPolicy?.autoActuateIndependent
        ?? true,
      ...(this.acMode !== undefined ? { acMode: this.acMode } : {}),
      llmEnabled,
      ...(options.assessorSystemPrompt !== undefined
        ? { assessorSystemPrompt: options.assessorSystemPrompt }
        : {}),
      triage: this.triageOption,
      llmFailure: this.llmFailureOption,
      scenarioOfferRules: this.scenario.semanticOfferRules,
      optionOfferRules: options.semanticOfferRules,
    });

    const profile = AgentProfileFactory.createBalancedAgent();
    profile.id = agentDef.id;

    const agent = new CognitiveAgent({
      id: agentDef.id,
      name: agentDef.name,
      description: `Agent "${agentDef.name}" of scenario ${this.scenario.meta.id}`,
      owner: 'engine-runtime',
      environment: this.envCenter,
      llmClient: llmClient ?? createNoLLMClientStub(agentDef.id),
      // Per-function routing (documented on the option): routed clients
      // override the agent's own client for their call-site class.
      llmFunctionClients: options.llmFunctionClients,
      capabilities: agentDef.capabilities,
      agentProfile: profile,
      dualTriggerConfig,
      // R101 (P0): the executability oracle reaches the agent's NL device
      // views — the agent's "my devices support X" claims read the same
      // truth as the invoke/flow/signing gates.
      ...(options.isExecutableCapability !== undefined
        ? { isCommandExecutable: options.isExecutableCapability }
        : {}),
      // T123: live world-rate seam for the AC handshake-window floor gate (lazy → speed; tick → ×1000/tickMs).
      simRateProvider: () => nominalSimPerWallSec(this.speed, this.tickMs, this.lazyTimerMode),
      // Scope-of-practice (A3): cannotDeliverClasses filters partner
      // selection (regulatory authority). Master enable switch: negotiator
      // filters metadata.enabled === false; routing uses agentRuntimeInfo.
      // R45-P1: managedZoneIds feeds geo-corridor ranking; R46-P0:
      // managedZoneNames rebuilds a jurisdiction zone view (shaping/agents).
      metadata: {
        cannotDeliverClasses: agentDef.cannotDeliverClasses ?? [],
        enabled: agentDef.enabled !== false,
        managedZoneIds,
        managedZoneNames: managedZoneNamesOf(this.scenario.zones, managedZoneIds),
      },
      // P4-3: workflow synthesis — LLM-backed agents only; the synthesis
      // client defaults to the agent's own LLM client.
      ...(llmEnabled && this.workflowSynthesisOption?.enabled
        ? {
            workflowSynthesis: {
              enabled: true,
              llmClient: this.workflowSynthesisOption.llmClient ?? llmClient,
            },
          }
        : {}),
    });

    this.envCenter.registerAgent(
      agent as unknown as Record<string, unknown> & { id: string; name: string },
      'engine-runtime',
    );

    if (managedDevices.length > 0) {
      const deviceObjs = managedDevices
        .map(d => this.devicesById.get(d.id))
        .filter((d): d is RuntimeDevice => d !== undefined);
      agent.assignDevices(deviceObjs as unknown as Device[], 'engine-runtime');
    }
    registerAggregateOffers(this.envCenter, agentDef, managedDevices, this.scenario.semanticOfferRules, options.semanticOfferRules);

    agent.getDualTriggerACManager()?.setAssessmentCallback((assessment, event) => {
      this.recordDecision(agentDef.id, assessment, event);
    });
    wireNLInteractionTrace(agent, this.trajectoryRecorder); // NL 意图道埋点（shaping/nl-trace）
    // 决策缝（shaping/decision-seams）：发起去重 coordinator + FEAT-10 应答车道拒「已自处置同一事件」。
    wireDecisionSeams(agent, this.initiatorCoordinator);
    // R45-P1: world zone topology for the negotiator's geo-corridor ranking.
    agent.getDualTriggerACManager()?.getPartnerNegotiator()?.setZoneTopology(this.scenario.zones);
    // R38-P2: live zone source (managed + adjacent, snapshot parameters).
    agent.getDualTriggerACManager()?.setWorldModelProvider(buildWorldModelProvider({
      managedZoneIds: id => this.agentRuntimeInfo.get(id)?.managedZoneIds,
      zoneDefs: this.scenario.zones,
      getParameterValue: (parameter, zoneId) => { try { return this.physicalEnv.getParameterValue(parameter, zoneId); } catch { return undefined; } },
      simTimeSec: () => this.simTimeSec, simStartEpochMs: () => this.simStartTime.getTime(),
    }, agentDef.id));

    // Start the agent (Fix-8): starts its CollaborationProposalHandler
    // (shared-bus subscription) — without it no AC proposal is ever seen.
    agent.start();

    this.agents.set(agentDef.id, agent);
    this.agentRuntimeInfo.set(agentDef.id, {
      managedZoneIds,
      boundDeviceIds: managedDevices.map(d => d.id),
      llmEnabled,
      enabled: agentDef.enabled !== false,
    });
  }

  /**
   * Agents that should receive an event originating in a zone: direct
   * managers first; when none exist, agents managing adjacent zones
   * (runner fallback semantics). Selection: shaping/agents.ts
   * (resolveManagingAgentIds).
   */
  private resolveManagingAgents(zoneId: string): string[] {
    return resolveManagingAgentIds(
      this.scenario.agents,
      zid => this.scenario.zones.find(z => z.id === zid),
      agentId => this.agentRuntimeInfo.get(agentId)?.managedZoneIds,
      agentId => this.agentRuntimeInfo.get(agentId)?.enabled !== false,
      zoneId,
    );
  }

  /** R37-F3: the model one agent's decisions run on (llmPerAgent entry > shared client, captured at build); undefined when rule-only. */
  getAgentLlmModel(agentId: string): string | undefined {
    return this.agentLlmModels.get(agentId);
  }

  /**
   * Phase 3 (NL interface): one live agent by id — the seam routes like
   * POST /api/agents/:id/command use to reach the running CognitiveAgent
   * (its own device lanes, its own LLM seam) without going through events.
   */
  getAgent(agentId: string): CognitiveAgent | undefined {
    return this.agents.get(agentId);
  }

  /** P2 (world catalog sync): the center the server's catalog-sync seam mirrors world-layer services into. */
  getEnvironmentCenter(): EnvironmentCenter { return this.envCenter; }

  /** Record an AC necessity assessment (decision stream + trajectory sink). */
  private recordDecision(agentId: string, assessment: ACNecessityAssessment, event: SystemEvent): void {
    const eventId = extractRecordEventId(event);

    // Fix-31 slice 5: shaping in shaping/. T-024: LLM decisions carry the deciding model.
    // R102: provenance (scheduled | perception | runtime — chen-19 traceability).
    const eventSource = this.scenario.events.some(e => e.id === eventId)
      ? 'scheduled' as const
      : event.source === 'agent-perception' ? 'perception' as const : 'runtime' as const;
    this.recentDecisions.push(buildDecisionRecord(
      agentId,
      assessment,
      event,
      this.agentLlmModels.get(agentId),
      eventSource,
    ));
    if (this.recentDecisions.length > MAX_RECENT_DECISIONS) {
      this.recentDecisions.shift();
    }

    // Trajectory sink: record the assessment and immediately report the
    // outcome so the record is written through. T-014: ground truth is
    // derived from the formal model (Coverage × Gap → Type A–E) instead of
    // a hard-coded 'unknown' — deterministic decisions can now score, and
    // pairs without a derivable truth are marked unscored (correct: null).
    if (this.trajectoryRecorder) {
      this.trajectoryRecorder.recordAssessment(agentId, assessment, event);
      this.trajectoryRecorder.recordOutcome({
        eventId,
        agentId,
        // BUG-01: the agent's own devices + the merged offer table let the
        // truth demote a backing-less Type-A to Type-E — the same check the
        // manager's honesty gate ran before recording this decision.
        groundTruth: deriveDecisionGroundTruth(
          assessment.agentContext,
          event,
          this.agents.get(agentId)?.getDualTriggerACManager()?.getAgentDevices(),
          mergeOfferRules([...(this.scenario.semanticOfferRules ?? []), ...(this.offerRulesOption ?? [])]),
        ),
      });
    }

    // R40-A3（§7.5 升级通道）：被升级的决策在世界事件流上广播
    // AGENT_ESCALATION——订阅方（server 通知桥）据此通知环境 owner。
    const escalation = buildAgentEscalationEvent(
      this.id, agentId, eventId, event, assessment, extractRecordZoneId(event),
    );
    if (escalation !== null) this.envCenter.eventManager.publish(escalation);
  }

  // -------------------------------------------------------------------------
  // Reputation internals (P4-1)
  // -------------------------------------------------------------------------

  /**
   * Wire reputation learning: attach the shared tracker to every agent's
   * partner negotiator (unless disabled for ablation) and subscribe to the
   * bus events the tracker learns from. Update paths:
   *
   * 1. COLLABORATION_COMPLETED — outcome classified from the payload
   *    (success / partial / failure = 1 / 0.5 / 0), attributed to every
   *    participating agent × every capability the AC requested. Capabilities
   *    come from the completion payload itself (ACExecutor), falling back
   *    to the ac-proposal message seen for that collaborationId.
   * 2. Device-operation failures attributable to an agent — DEVICE_ERROR
   *    (emitted at the fault seam for EVERY command path) and
   *    DEVICE_OPERATION_EXECUTED with success=false (manual command path).
   *    Attribution choice: the failing device's managing agent
   *    (boundDeviceIds), falling back to the commanding agentId in the
   *    payload; the device's declared capability names are the keys. A
   *    manual failure on a faulted device is counted once (at the seam) —
   *    the DEVICE_OPERATION_EXECUTED echo is skipped for faulted devices.
   */
  private initReputation(options: EngineRuntimeOptions): void {
    if (options.reputationEnabled !== false) {
      for (const agent of this.agents.values()) {
        agent.getDualTriggerACManager()?.getPartnerNegotiator()?.setReputationTracker(this.reputation);
      }
      // R40-A2：装配时喂一次基线（持久声誉行由 loadReputationJSON 到达后再同步）。
      pushPlatformReputation(this.agents.values(), this.reputation, this.reputationEnabled);
    }

    const subscribe = (eventType: EventType, handler: (event: SystemEvent) => void): void => {
      const subId = this.envCenter.eventManager.subscribe({
        subscriberId: `engine-runtime-reputation-${this.id}`,
        eventType,
        handler: (event: SystemEvent) => {
          try {
            handler(event);
          } catch (error) {
            logger.warn(`Reputation update failed for ${eventType} (non-fatal): ${(error as Error).message}`);
          }
        },
      });
      this.reputationSubIds.push(subId);
    };

    subscribe(EventType.COLLABORATION_MESSAGE, event => {
      // Fix-31 slice 6: payload routing lives in shaping.
      const action = parseCollabMessageAction(event.payload);
      if (action.kind === 'rememberCapabilities') {
        this.rememberAcCapabilities(action.collaborationId, action.requiredCapabilities);
      }
      // Fix-8: persist AC handshake outcomes (accept / reject / cancel) to
      // the trajectory so BOTH sides of a collaboration are auditable.
      this.recordHandshakeToTrajectory(event);
      // Fix-15 (F-23): an initiator-side cancel ends the collaboration for
      // EVERY agent — the coordinator only updates its own manager.
      if (action.kind === 'cancel') {
        finalizeCollaborationSessions(this.agents.values(), action.collaborationId, CollaborationStatus.CANCELLED);
      }
    });

    subscribe(EventType.COLLABORATION_COMPLETED, event => {
      this.onReputationCollaborationCompleted(event);
      // Fix-15 (F-23): the execution pipeline emits completion, but nothing
      // drove the participating agents' sessions to a terminal status —
      // the collaborations view kept showing in-progress/active rows while
      // the consumption layer (ephemeral agreements) had already terminated
      // on the same event. Write the terminal state back to every agent.
      const action = parseCollabCompletedAction(event.payload);
      if (action.kind === 'finalize') {
        finalizeCollaborationSessions(
          this.agents.values(),
          action.collaborationId,
          action.failed ? CollaborationStatus.FAILED : CollaborationStatus.COMPLETED,
        );
      }
    });

    subscribe(EventType.DEVICE_ERROR, event => {
      const payload = event.payload as { deviceId?: unknown } | undefined;
      if (typeof payload?.deviceId === 'string') {
        this.attributeDeviceFailure(payload.deviceId, undefined);
      }
    });

    subscribe(EventType.DEVICE_OPERATION_EXECUTED, event => {
      // Fix-31 slice 6: routing decision lives in shaping.
      const action = parseDeviceOperationAction(
        event.payload,
        deviceId => this.faultSeam.has(deviceId),
      );
      if (action.kind === 'recheck') {
        this.registerTemperatureEffectCheck(action.payload as { deviceId: string });
      } else if (action.kind === 'attribute') {
        this.attributeDeviceFailure(action.deviceId, action.agentId);
      }
    });
  }

  /**
   * Classify a COLLABORATION_COMPLETED event and feed the tracker (pure
   * shaping lives in shaping/events.ts). R40-A2：协作完成 = 声誉桥刷新时机
   * （理由见 pushPlatformReputation 的文档）。
   */
  private onReputationCollaborationCompleted(event: SystemEvent): void {
    feedReputationFromCompletion(event, this.reputation, this.acCapabilities);
    pushPlatformReputation(this.agents.values(), this.reputation, this.reputationEnabled);
  }

  /** Remember an AC's requested capabilities until its completion arrives. */
  private rememberAcCapabilities(collaborationId: string, capabilities: unknown): void {
    if (!Array.isArray(capabilities)) return;
    const caps = capabilities.filter((c): c is string => typeof c === 'string' && c.length > 0);
    if (caps.length === 0) return;
    if (this.acCapabilities.size >= 500 && !this.acCapabilities.has(collaborationId)) {
      const oldest = this.acCapabilities.keys().next().value;
      if (oldest !== undefined) this.acCapabilities.delete(oldest);
    }
    this.acCapabilities.set(collaborationId, caps);
  }

  /**
   * Fix-8: persist AC handshake outcomes to the trajectory. Partner
   * accept/reject responses ('join-response' / 'reject') and initiator-side
   * cancels ('ac-cancelled', all-rejected or handshake timeout) become
   * 'collaboration-response' records, so BOTH sides of a collaboration are
   * auditable — previously only the initiator's assessment was recorded.
   *
   * Wave-4a: the negotiation steps are recorded too — 'counter' / 'defer'
   * answers and the initiator's counter rejection (as a 'reject' of the
   * countering partner) — so the trajectory reflects the full negotiation
   * instead of only the final outcome.
   */
  private recordHandshakeToTrajectory(event: SystemEvent): void {
    if (!this.trajectoryRecorder) return;
    // Fix-31 slice 3: pure shaping lives in shaping.
    recordHandshakeToTrajectory(this.trajectoryRecorder, event, this.inflightEventId);
  }

  /**
   * Fix-8: collaboration sessions across ALL agents, one row per
   * (collaboration, agent-view). Pending sessions exist only in the
   * initiator's manager until a partner accepts; the partner's view appears
   * in ITS manager after joining. Completed/failed/cancelled sessions come
   * from each manager's history (`history: true`).
   */
  getCollaborations(): RuntimeCollaborationRecord[] {
    // Fix-31 slice 3: pure shaping lives in shaping.
    return buildCollaborationRows(this.agents.values());
  }

  /**
   * R40-B2 (§7 exposure): per-agent meta-cognition summaries — the eval
   * report's agents[] face (calibration, capability boundary, trust).
   * Read-only projection over the live agents (CognitiveAgent owns the
   * derivation); insertion order, one row per scenario agent.
   */
  getMetaCognitionSummaries(): AgentMetaCognitionSummary[] {
    return [...this.agents.values()].map(agent => agent.getMetaCognitionSummary());
  }

  /**
   * Count one failed attempt against the agent answerable for a device
   * (its managing agent, else the commanding one) on each of the device's
   * declared capability names.
   */
  private attributeDeviceFailure(deviceId: string, agentIdHint?: string): void {
    const agentId = agentIdHint ??
      [...this.agentRuntimeInfo.entries()]
        .find(([, info]) => info.boundDeviceIds.includes(deviceId))?.[0];
    if (!agentId) return;
    const deviceDef = this.scenario.devices.find(d => d.id === deviceId);
    for (const capability of deviceDef?.capabilities ?? []) {
      this.reputation.recordAttempt(agentId, capability, 0);
    }
  }

  /**
   * Fix-12 (R4 陈工 F-15): schedule a before/after temperature recheck for a
   * successfully executed temperature-class command. Deliberately narrow —
   * only heating/cooling/temperature commands with a determinable intended
   * direction are registered; every other command keeps the old semantics.
   *
   * Direction sources: 'cool' in the command name → down, 'heat' → up;
   * temperature/setpoint commands take the target from the command params
   * (`targetTemperature` / `temperature` / `setpoint` / `value`). Without a
   * direction there is nothing honest to verify, so nothing is registered.
   */
  private registerTemperatureEffectCheck(payload: {
    deviceId: string;
    agentId?: unknown;
    commandName?: unknown;
    params?: unknown;
  }): void {
    const deviceDef = this.scenario.devices.find(d => d.id === payload.deviceId);
    const zoneId = deviceDef?.zoneId;
    if (!deviceDef || !zoneId) return;

    const before = this.physicalEnv.getParameterValue('temperature', zoneId);
    // Fix-31 slice 5: eligibility + direction resolution lives in shaping.
    const resolved = resolveEffectCheck({
      commandName: payload.commandName,
      params: payload.params,
      before,
      deviceCapabilities: deviceDef.capabilities,
    });
    if (!resolved || typeof before !== 'number') return;
    const { direction, capabilities } = resolved;
    const commandName = payload.commandName as string;

    const agentId = (typeof payload.agentId === 'string' ? payload.agentId : undefined) ??
      [...this.agentRuntimeInfo.entries()]
        .find(([, info]) => info.boundDeviceIds.includes(payload.deviceId))?.[0];
    if (!agentId) return;

    this.pendingEffectChecks.push({
      agentId,
      deviceId: payload.deviceId,
      zoneId,
      commandName,
      direction,
      before,
      dueSimSec: this.simTimeSec + this.effectCheckWindowSec,
      capabilities,
    });
  }

  /**
   * Fix-12: resolve due effect rechecks (SIM-time driven, called from the
   * tick loop alongside fireDueEvents). A command whose zone temperature did
   * not move in the commanded direction within the window records a
   * reputation FAILURE per temperature-class capability of the device —
   * "command executed" ≠ "treatment worked".
   */
  private processDueEffectChecks(): void {
    if (this.pendingEffectChecks.length === 0) return;
    const EPSILON_C = 0.05;
    for (let i = this.pendingEffectChecks.length - 1; i >= 0; i--) {
      const check = this.pendingEffectChecks[i];
      if (check.dueSimSec > this.simTimeSec) continue;
      this.pendingEffectChecks.splice(i, 1);

      const after = this.physicalEnv.getParameterValue('temperature', check.zoneId);
      if (typeof after !== 'number') continue;
      if (isEffectEffective(check, after, EPSILON_C)) continue;

      for (const capability of check.capabilities) {
        this.reputation.recordAttempt(check.agentId, capability, 0);
      }
      logger.info(
        `Effect check FAILED: "${check.commandName}" on ${check.deviceId} produced no ` +
        `${check.direction === 'down' ? 'cooling' : 'heating'} effect in zone ${check.zoneId} ` +
        `(${check.before.toFixed(2)}°C → ${after.toFixed(2)}°C within ${this.effectCheckWindowSec}s sim); ` +
        `recorded reputation failure for ${check.agentId} × [${check.capabilities.join(', ')}]`,
      );
    }
  }
  /**
   * Register every bounded zone's center as a spatial location with the
   * physics layer's spatial manager. This gives the field real geometry:
   * localized writes land at zone centers, diffusion exchanges between
   * nearby zone centers, and snapshots sample per-zone field state.
   *
   * Building tier (B-A): centers carry `z = floor × storeyHeight`, and each
   * zone's floor + declared adjacency is registered with the field so
   * cross-floor coupling follows the slab rules (same-floor 2D distance;
   * declared shaft zones only, attenuated). The scenario-level slab
   * attenuation override (meta.slabAttenuation) is applied here too.
   *
   * Building tier (B-B): `type: 'outdoor'` zones are registered as outdoor
   * boundaries (no distance-based coupling; one-way envelope exchange with
   * declared neighbors), and per-zone / scenario-level envelope factors
   * (zone.envelopeU, meta.envelopeU) are applied here too.
   */
  private registerZoneGeometry(): void {
    const physicsLayer = this.physicalEnv.getPhysicsLayer?.();
    const spatialManager = physicsLayer?.getSpatialManager();
    if (!physicsLayer || !spatialManager) return;

    const storeyHeight = this.scenario.meta.storeyHeight ?? DEFAULT_STOREY_HEIGHT_M;
    if (this.scenario.meta.slabAttenuation !== undefined) {
      physicsLayer.setSlabAttenuation?.(this.scenario.meta.slabAttenuation);
    }
    if (this.scenario.meta.envelopeU !== undefined) {
      physicsLayer.setEnvelopeU?.(this.scenario.meta.envelopeU);
    }

    for (const zone of this.scenario.zones) {
      // RC-5 calibration: zone air volume → per-zone thermal mass in the
      // physics layer (replaces the global 100 m³ constant for bounded
      // zones). Bounds are 2D floor area; height comes from storeyHeight.
      // Fix-31 slice 5: per-zone registration metadata lives in shaping.
      physicsLayer.registerZonePhysics?.(zone.id, zonePhysicsRegistration(zone, storeyHeight));
      const center = zoneCenter(zone, storeyHeight);
      if (!center) continue;
      spatialManager.registerLocation({
        id: zone.id,
        name: zone.name ?? zone.id,
        path: zone.id,
        position: center,
        zoneId: zone.id,
      });
    }
  }

  /**
   * Seed scenario zone baselines into the physical environment at build
   * time. This runs BEFORE the tick loop starts and does NOT deliver events
   * to agents — baselines are initial conditions, not incidents, so they
   * must never trigger AC decisions (which scheduled `atSimTimeSec: 0`
   * events would).
   *
   * Every zone seeds its baseline into the spatial FIELD per-zone (point
   * write, radius 0 — one zone never spills into its neighbors), as both
   * the current field value and the relaxation attractor. R99
   * (chen-08/zhao-08): bounds-less zones previously took a legacy global
   * last-write-wins value-model write, collapsing every bounds-less zone
   * onto ONE shared value ("all rooms show identical parameters") — the
   * field holds per-location state honestly even without geometry.
   */
  private seedZoneBaselines(): void {
    for (const zone of this.scenario.zones) {
      if (!zone.baseline) continue;
      for (const [parameter, value] of Object.entries(zone.baseline)) {
        this.physicalEnv.setParameterBaseline(parameter, zone.id, value);
      }
    }
  }

  /**
   * Advance the world one tick: sim time + environment drives + physics.
   * R30 (LOD/multi-rate, shaping/lod.ts): at idle, strides bank into coarse
   * physics batches, env drives refresh every 5th tick, the due grid
   * coarsens 10×; observed is byte-identical to pre-R30.
   */
  private advanceTickBy(strideSec: number): void {
    this.simTimeSec += strideSec;
    this.tickCount++;
    this.timeManager.jumpTo(new Date(this.simStartTime.getTime() + this.simTimeSec * 1000));

    // NFR-2 + T-704 drives (shaping/world); R30: at idle they refresh every
    // IDLE_ENV_BASELINE_EVERY_TICKS-th tick (observed: every tick).
    const idleEnvTick = this.lod.getTier() === 'idle' &&
      this.tickCount % IDLE_ENV_BASELINE_EVERY_TICKS !== 0;
    if (!idleEnvTick) {
      driveEnvironmentBaselines(this.scenario.zones, this.simTimeSec, (parameter, zoneId, value) => {
        try { this.physicalEnv.setParameterBaseline(parameter, zoneId, value); } catch { /* no bounds */ }
      });
    }

    const integrate = this.lod.accountStride(strideSec);
    // T-103: sim-time-driven cut-offs/restores apply BEFORE device ticks.
    this.applyPowerOutages();
    if (integrate > 0) this.runPhysicsSubsteps(integrate);
  }

  /**
   * Coarse fast-forward stride (advanceTo's AdvanceToOptions path): sim time
   * jumps the whole stride at once; the field integration runs at the coarse
   * substep (dt ≈ substepSec) with env baselines and power-outage transitions
   * refreshed per substep — the idle LOD tier's tradeoff, explicitly chosen
   * by the caller for inter-due physics only. Never banks into the LOD
   * controller (each stride integrates fully, so due-adjacent physics is
   * never deferred past the due moment).
   */
  private advanceCoarseStrideBy(strideSec: number, substepSec: number): void {
    this.simTimeSec += strideSec;
    this.tickCount++;
    this.timeManager.jumpTo(new Date(this.simStartTime.getTime() + this.simTimeSec * 1000));
    const strideStartSec = this.simTimeSec - strideSec;
    integrateCoarseStride(this.physicsSeams(), strideSec, substepSec, strideStartSec);
  }

  /** Lazy seams for the physics-integration segment (physics-integration.ts). */
  private physicsSeamsCache?: PhysicsIntegrationSeams;
  private physicsSeams(): PhysicsIntegrationSeams {
    return (this.physicsSeamsCache ??= {
      devices: this.devices,
      physicalEnv: this.physicalEnv as unknown as PhysicsIntegrationSeams['physicalEnv'],
      lod: this.lod,
      scenarioZones: this.scenario.zones,
      powerOutages: this.powerOutages,
      getDeviceState: id => {
        const device = this.devicesById.get(id);
        try {
          return device?.getState() as Record<string, unknown> | undefined;
        } catch {
          return undefined;
        }
      },
      publishOutage: p => {
        this.envCenter.eventManager.publish({
          type: EventType.DEVICE_STATE_CHANGE,
          source: `engine-runtime:${this.id}`,
          priority: EventPriority.NORMAL,
          payload: { deviceId: p.deviceId, power: p.power, reason: p.reason, zoneId: p.zoneId },
          metadata: { eventType: 'device.power' },
        });
      },
    });
  }

  /** T-103 (F-PH21): apply the outage state machine's transitions (pure application lives in power-outage.ts). */
  private applyPowerOutages(atSimSec: number = this.simTimeSec): void {
    applyPowerOutagesImpl(this.physicsSeams(), atSimSec);
  }

  /** R30 (LOD): integrate idle-banked seconds (tier switch / checkpoint export / read surfaces). */
  private flushIdlePhysics(): void {
    flushIdlePhysicsImpl(this.physicsSeams());
  }

  /** Integrate `totalSec` of physics — see physics-integration.ts (extracted). */
  private runPhysicsSubsteps(
    totalSec: number,
    options?: { substepSec?: number; beforeSubstep?: (atSimSec: number, dt: number) => void; substepStartSec?: number },
  ): void {
    runPhysicsSubstepsImpl(this.physicsSeams(), totalSec, options);
  }

  /** Lazy seams for the tick-loop segment (tick-loop.ts). */
  private tickLoopSeams(): TickLoopSeams {
    return {
      speed: this.speed, simTimeSec: this.simTimeSec,
      scenarioEvents: this.scenario.events, scenarioZones: this.scenario.zones,
      firedEventIds: this.firedEventIds, firedEventDetails: this.firedEventDetails,
      occupancyScheduleFired: this.occupancyScheduleFired, flowEngine: this.flowEngine ?? undefined,
      advanceTickBy: stride => this.advanceTickBy(stride),
      processDueEffectChecks: () => this.processDueEffectChecks(),
      fireOccupantSchedules: () => this.fireOccupantSchedules(),
      injectEvent: event => this.injectEvent(event),
      setZoneOccupancy: (zoneId, count) => this.setZoneOccupancy(zoneId, count),
    };
  }

  /** Tick-loop body with a re-entrancy guard (a slow tick never overlaps). */
  private async tick(): Promise<void> {
    await runTickBody(this.tickLoopSeams(), () => this.tickInProgress,
      value => { this.tickInProgress = value; }, () => { this.tickBodyCount++; });
  }

  /** Inject scheduled scenario events whose sim-time has come due. */
  private async fireDueEvents(): Promise<void> {
    await fireDueScenarioEvents(this.tickLoopSeams());
  }

  /** Fix-52a: per-(zone, day) occupancy schedule state. */
  private readonly occupancyScheduleFired = new Set<string>();

  /** Fix-52a: setZoneOccupancy at schedule boundaries — due/keys shape is the shaping truth (due-moments), writes only here. */
  private fireOccupantSchedules(): void {
    fireOccupantScheduleWrites(this.tickLoopSeams());
  }

  private assertNotStopped(operation: string): void {
    if (this.state === 'stopped') {
      throw new Error(`EngineRuntime.${operation}: runtime is stopped`);
    }
  }
}
