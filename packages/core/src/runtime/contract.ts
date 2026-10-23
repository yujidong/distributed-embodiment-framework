/**
 * Runtime contract layer (L1) — see docs/architecture-runtime.md
 *
 * ROLE: the runtime's TYPE CONTRACT. Pure declarations; the only executable
 * code is the simulation-package loader and the device factory trio (they
 * ARE the contract with that package).
 *
 * LAYERING: L2 (shaping/*) and L3 (EngineRuntime) import from here.
 * This file imports ONLY from sibling core modules and shared/llm packages.
 */

import type { LLMClient, LLMCacheStats } from '@active-collaboration/llm-integration';
import type { CapabilityType, DeviceCapability, LocalizedText } from '@active-collaboration/shared';

import { EventPriority, EventType, type SystemEvent } from '../events/index.js';
import type { AssessorConfig } from '../decision/ACNecessityAssessor.js';
import type { CognitiveDecision } from '../decision/cognitive-decision.js';
import type { DualTriggerConfig } from '../decision/DualTriggerACManager.js';
import type { MetaCognitionCheckpoint } from '../cognition/meta.js';
import type { EnvironmentParamFaceCheckpoint } from '../cognition/world-model.js';
import type { ReputationTrackerJSON } from '../reputation/index.js';
import type { ScenarioAgent, ScenarioDefinition, ScenarioDevice } from '../scenario/index.js';
import type { FlowDefinition, FlowEngineStateExport } from '../flows/index.js';
import type { SemanticOfferRule } from '../service/semantic-offers.js';
import { isReadOnlyCapabilityName } from '../capabilities/read-only.js';
// ---------------------------------------------------------------------------
// Structural views of @active-collaboration/simulation (loaded lazily)
// ---------------------------------------------------------------------------

export interface TimeManagerLike {
  getCurrentTime(): Date;
  jumpTo(targetTime: Date): void;
  stop(): void;
}export interface SpatialManagerLike {
  registerLocation(location: {
    id: string;
    name: string;
    path: string;
    position?: { x: number; y: number; z?: number };
    zoneId?: string;
  }): void;
  setDevicePosition(
    deviceId: string,
    location: string,
    position: { x: number; y: number; z?: number },
    zoneId?: string,
  ): void;
}export interface PhysicsLayerLike {
  getSpatialManager(): SpatialManagerLike;
  /**
   * Building tier (B-A/B-B): register a zone's floor + declared adjacency
   * with the spatial field so cross-floor coupling follows the floor rules,
   * and (B-B) mark outdoor boundary zones / per-zone envelope factors.
   */
  registerZonePhysics?(
    locationKey: string,
    metadata: { floor?: number; adjacentZoneIds?: string[]; outdoor?: boolean; envelopeU?: number },
  ): void;
  /** Building tier (B-A): override the cross-floor flux multiplier. */
  setSlabAttenuation?(value: number): void;
  /** Building tier (B-B): override the indoor↔outdoor envelope flux multiplier. */
  setEnvelopeU?(value: number): void;
  /** Register/replace a device (or virtual-source) physics effect. */
  registerDeviceEffect?(effect: DevicePhysicsEffectLike): void;
  /** Remove all effects of a device/virtual source (a parameter scopes it). */
  unregisterDeviceEffect?(deviceId: string, parameter?: string): void;
  /**
   * Living-worlds P0 checkpoint seam: spatial-field value at a location, or
   * undefined when the field holds no entry for (parameter, location) — the
   * checkpoint captures only entries that actually exist (value-model-backed
   * parameters stay model-driven and are restored via the clock anchor).
   */
  getLocalParameterValue?(parameter: string, location: string): number | undefined;
  /**
   * Living-worlds P0 checkpoint seam: the seeded per-location relaxation
   * baseline, or undefined. Baselines are runtime-mutable (outdoor weather
   * updates, twin-sync pushes) so they ride the checkpoint, not the scenario.
   */
  getLocalParameterBaseline?(parameter: string, location: string): number | undefined;
  /**
   * Living-worlds P0 checkpoint seam: every registered device effect as a
   * plain copy (device control loops mutate `enabled` in place, so the
   * capture must not alias live entries).
   */
  listDeviceEffects?(): DevicePhysicsEffectLike[];
}/** Structural view of the simulation's DevicePhysicsEffect. */
export interface DevicePhysicsEffectLike {
  deviceId: string;
  parameter: string;
  effect: 'heating' | 'cooling' | 'humidity' | 'light' | 'motion' | 'set' | 'pollutant' | 'air_flow' | 'parameter_rate';
  magnitude: number;
  affectedArea: {
    location: string;
    radius: number;
    position?: { x: number; y: number; z?: number };
  };
  falloff?: 'linear' | 'inverse-square' | 'exponential';
  enabled?: boolean;
}export interface PhysicalEnvironmentLike {
  simulate(totalDuration: number, stepSize?: number): number;
  setParameterValue(parameter: string, location: string, value: number | boolean): void;
  getParameterValue(parameter: string, location: string): number | boolean;
  /**
   * Spatial write: set the field at/around a location without touching the
   * global value model (radius in meters, 0 = point write).
   */
  setLocalParameterValue(parameter: string, location: string, value: number | boolean, radius?: number): void;
  /** Seed the per-location environmental baseline (relaxation attractor). */
  setParameterBaseline(parameter: string, location: string, value: number | boolean): void;
  getPhysicsLayer?(): PhysicsLayerLike | undefined;
}interface SimulatedDeviceConfigLike {
  id: string;
  name: string;
  type: string;
  initialState: Record<string, unknown>;
  capabilities: DeviceCapability[];
  behaviors: unknown[];
  location: string;
}/**
 * The structural device surface the runtime drives. SimulatedDevice satisfies
 * it; so does any adapter passed in through `options.deviceFactory` (e.g. the
 * server's HADevice for `hass://` bindings). The full `Device` contract
 * (location/status/metadata/…) is only needed structurally at the
 * EnvironmentCenter/agent boundary, where devices are cast anyway.
 */
export interface RuntimeDevice {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  getState(): Record<string, unknown>;
  /** Device control-loop hook, run once per physics step by the tick loop. */
  onPhysicsTick?(dtSeconds: number): void;
  /**
   * Optional cleanup hook, called by stop() (e.g. a bridge device
   * unsubscribing from its backend connection). Sim devices don't need it.
   */
  dispose?(): void;
  /**
   * Living-worlds P0 checkpoint seam: replace this device's state with a
   * checkpointed one (the inject half of getState()). Absent on adapters
   * whose state is owned externally (e.g. hass:// bridge devices mirror real
   * hardware — their worlds refuse hibernation, so the seam is never needed).
   */
  restoreState?(state: Record<string, unknown>): void;
  /**
   * Living-worlds P0 checkpoint seam: full-fidelity state for checkpoints.
   * Defaults to getState(); a device whose observable state is a ROUNDED
   * view of an internal accumulator (e.g. energy meters write back 2-decimal
   * Wh while the internal sum keeps full precision) overrides this so the
   * checkpoint restores the accumulator exactly — restoreState() re-rounds
   * the observable copy.
   */
  getCheckpointState?(): Record<string, unknown>;
  /**
   * T54 (R6 u4-F1): state paths WRITTEN at least once since construction —
   * the placeholder detector for data reads (a value aggregated straight off
   * never-written scenario initialState is a placeholder, not a measurement).
   * Optional: absent on adapters that cannot say (the read gate then stays
   * silent — honest-unknown instead of a fabricated verdict).
   */
  getWrittenStatePaths?(): string[];
}/**
 * Device construction override: given a scenario device definition, return
 * the runtime device. Called for EVERY device when provided, so a factory
 * must handle `sim://` defs too (see `createSimulatedDevice`).
 */
export type DeviceFactory = (def: ScenarioDevice) => RuntimeDevice;export interface SimulationModule {
  TimeManager: new (config?: { timeScale?: number }) => TimeManagerLike;
  PhysicalEnvironment: new (
    timeManager: TimeManagerLike,
    config?: {
      simDurationSeconds?: number;
      environmentNoise?: boolean;
      /**
       * FEAT-03: opt-in field dynamics for custom zone parameters (scenario
       * `meta.parameterPhysics`), and stage-2 device coupling onto them
       * (scenario `meta.parameterEffects`). Structural mirror of the
       * simulation package's PhysicalEnvironmentConfig fields.
       */
      parameterPhysics?: Record<string, { relaxRatePerSec?: number; relaxToBaseline?: boolean }>;
      parameterEffects?: Array<{
        capability?: string;
        deviceType?: string;
        zoneParameter: string;
        ratePerSec: number;
      }>;
    },
  ) => PhysicalEnvironmentLike;
  SimulatedDevice: new (config: SimulatedDeviceConfigLike) => RuntimeDevice;
}/**
 * Load the simulation package at runtime. Never call this at module top
 * level: the require must happen after core's own module graph is fully
 * initialized (simulation imports core back).
 */
export function loadSimulation(): SimulationModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@active-collaboration/simulation') as SimulationModule;
}// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** EngineRuntime lifecycle states. */
export type EngineRuntimeState = 'created' | 'running' | 'paused' | 'stopped';/**
 * Failure-mode injection profile for one device (P3d). Faults are a
 * runtime/testing concern: they wrap the runtime's device-call seam (a Proxy
 * around the registered device, applied at construction) and NEVER touch
 * SimulatedDevice itself. All fields are optional and combine freely:
 *
 *   - `offline`: every executeCommand fails with 'device offline' and
 *     getState returns the state frozen at fault-set time (the device is
 *     unreachable — no command reaches it, so its state cannot change).
 *   - `failureRate` (0..1): per-command probability of an 'intermittent
 *     failure' error (driven by the runtime's seeded RNG — reproducible via
 *     `EngineRuntimeOptions.faultSeed`).
 *   - `latencyMs`: artificial delay before a command executes (async).
 *   - `staleState`: getState returns the state frozen at fault-set time while
 *     commands still execute (state reporting is stuck, actuation works).
 *
 * Faults live in memory only (never persisted) and are surfaced per device
 * in `getSnapshot()`; transitions emit `device.fault_changed` on the event
 * bus so UIs and episode narrations can see them.
 */
export interface FaultProfile {
  offline?: boolean;
  failureRate?: number;
  latencyMs?: number;
  staleState?: boolean;
}/** Constructor options for EngineRuntime. */
/**
 * Per-function routed LLM clients (see EngineRuntimeOptions.llmFunctionClients).
 * Every slot optional — an absent slot means the call site keeps the agent's
 * own (shared or per-agent) client.
 */
export interface LlmFunctionClients {
  /** AC necessity decisions (initiator lane). */
  decision?: LLMClient;
  /** Proposal-response evaluation (responder lane). */
  eval?: LLMClient;
  /** NL intent parsing. */
  nl?: LLMClient;
}

/**
 * Every real LLM client the runtime options carry — the shared client,
 * per-agent overrides (T-601: null = opt-out, not a client), the triage
 * client, and the per-function routed clients. One wiring pass (trajectory
 * logging, metrics) consumes this so a routed client can never be skipped.
 */
export function collectRuntimeLlmClients(options: {
  llmClient?: LLMClient;
  llmPerAgent?: Record<string, LLMClient | null>;
  triage?: { client?: LLMClient };
  llmFunctionClients?: LlmFunctionClients;
}): LLMClient[] {
  const clients = new Set<LLMClient>();
  if (options.llmClient) clients.add(options.llmClient);
  for (const client of Object.values(options.llmPerAgent ?? {})) {
    if (client != null) clients.add(client);
  }
  if (options.triage?.client) clients.add(options.triage.client);
  const fns = options.llmFunctionClients;
  for (const client of [fns?.decision, fns?.eval, fns?.nl]) {
    if (client != null) clients.add(client);
  }
  return [...clients];
}

/**
 * T118 clock-injection seam: the minimal timer surface the tick loop needs —
 * deliberately shaped like `setTimeout`/`clearTimeout` so the default
 * implementation is a verbatim passthrough (see WALL_TICK_TIMER). A test
 * clock replaces the SCHEDULING of tick fires, never their body: each fire
 * still executes the ordinary `speed` sim-seconds tick, so an explicitly
 * fired timer is indistinguishable from a wall-driven one except for WHO
 * decided the moment.
 */
export interface TickTimer {
  /**
   * Arm one tick fire: run `callback` after `delayMs` (same contract as
   * `setTimeout`, delay clamping included), returning an opaque handle.
   */
  schedule(callback: () => void, delayMs: number): unknown;
  /** Cancel a pending fire (same contract as `clearTimeout`; idempotent). */
  cancel(handle: unknown): void;
}

/**
 * The DEFAULT TickTimer — a verbatim setTimeout/clearTimeout passthrough, so
 * an UNSET tickTimer option arms the tick loop on the process timers exactly
 * as EngineRuntime did before the seam existed (T118: default behavior
 * bit-identical; the seam's rationale lives on EngineRuntimeOptions.tickTimer).
 */
export const WALL_TICK_TIMER: TickTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface EngineRuntimeOptions {
  /** LLM client shared by all agents (unless overridden per agent). */
  llmClient?: LLMClient;
  /**
   * Per-function LLM routing (deployment-level; LLM_DECISION_MODEL /
   * LLM_EVAL_MODEL / LLM_NL_MODEL). Each slot overrides the shared/per-agent
   * client for ONE call-site class:
   *   - decision: AC necessity decisions (initiator lane);
   *   - eval:     proposal-response evaluation (responder lane);
   *   - nl:       NL intent parsing.
   * Absent slots fall through to the agent's own client — the single-backend
   * behavior is unchanged when no routes are configured. Triage has its own
   * `triage` option (its client may be built from the decision route).
   */
  llmFunctionClients?: LlmFunctionClients;
  /**
   * Per-agent LLM client overrides, keyed by agent id. T-601 (R26): a null
   * value is an explicit per-agent opt-out — that agent gets NO client
   * (rule-only by construction) instead of falling through to the shared
   * `llmClient`.
   */
  llmPerAgent?: Record<string, LLMClient | null>;
  /**
   * Directory for trajectory JSONL output (created if missing). When set,
   * a TrajectoryRecorder persists every AC necessity assessment. Ground
   * truth fields are written as 'unknown' — a live runtime has none.
   */
  trajectoryDir?: string;
  /**
   * Living-worlds P0: append to an existing trajectory JSONL instead of
   * truncating it. The resume path reuses the hibernated sim's trajectory
   * directory and must NOT wipe its history ("identity and history intact");
   * every other construction keeps the historical truncate-on-create.
   */
  trajectoryAppend?: boolean;
  /**
   * Living-worlds P2: per-segment size cap for the trajectory segmented log;
   * the active segment rotates at the cap (sealed segments are never
   * rewritten). `<= 0` disables rotation. Default 50MB (below the replay
   * source read cap of 64MB — the T-011 read-cap-coupling lesson).
   */
  trajectorySegmentBytes?: number;
  /** Real-time milliseconds between ticks (default 10, like the runner). */
  tickMs?: number;
  /**
   * T118 clock-injection seam: the scheduler behind the tick loop's
   * self-rescheduling wall timer. The DEFAULT (omitted) arms the loop on the
   * process `setTimeout`/`clearTimeout` — behavior bit-identical to before.
   * A test harness may supply a MANUAL timer so wall time advances the world
   * only when the test explicitly fires it: a running runtime can no longer
   * slip wall ticks into a sensitive window under machine load (the
   * world-hibernate suite's frozen-vs-continuous comparison is the motivating
   * consumer). Pure observability/determinism: no platform path sets this.
   */
  tickTimer?: TickTimer;
  /**
   * T118 clock-anchor discipline pin: fixes the run's WALL anchor (the epoch
   * ms sim-time 0 maps to — the checkpoint's `simStartEpochMs`). Default
   * (omitted) anchors at the TimeManager's construction moment, as before.
   * Two separately constructed runtimes only compare bit-wise when they
   * SHARE this anchor (getSimStartEpochMs's own contract) — sim-time-stamped
   * state (e.g. a sensor's lastReadingAt = round(anchor + simTimeSec))
   * otherwise differs by the construction gap, pure wall-clock luck a test
   * harness pins away by giving both arms the same anchor.
   */
  simStartEpochMs?: number;
  /** Physics configuration: simulated seconds per device effect (default 60). */
  simDurationSeconds?: number;
  /**
   * Automatically initiate AC collaborations when Layer 2 decides to
   * (default true). Set false to record decisions without executing them.
   * A per-agent scenario `decisionPolicy.autoInitiateAC` is the author's
   * default; this option (the operator's contract) overrides it.
   */
  autoInitiateAC?: boolean;
  /**
   * T-050 core-side: actuate agents' OWN bound devices on
   * 'handle_independently' decisions (default true — current behavior).
   * Set false at the sim level for decision-only evaluation runs; a
   * per-agent scenario `decisionPolicy.autoActuateIndependent` is the
   * author's default and this option overrides it. Enforced in
   * DualTriggerACManager (own devices only).
   */
  autoActuateIndependent?: boolean;
  /**
   * Wave A2: AC mode for A/B comparison. 'enabled' (default) = normal AC.
   * 'disabled' = force handle_independently for every assessment (no AC)
   * — agents still actuate their own devices (the "without AC" baseline).
   * 'shadow' = OBSERVE/RECORD ONLY: AC decisions are computed and recorded
   * (decision would-have-initiated notes on the record) but NEITHER AC
   * proposals NOR independent device actuation executes, AND the flow
   * engine is suspended entirely (T-302: flows simply never fire — no run
   * records, no device writes) (T-050: shadow runs must never mutate
   * physics — eval harnesses comparing pre/post runs rely on it; flows are
   * the user's deterministic lane in enabled/advisory modes, but the shadow
   * promise is absolute).
   */
  acMode?: 'enabled' | 'disabled' | 'shadow';
  /**
   * Device construction override (P3a extension point). When provided, it is
   * called for EVERY scenario device — including `sim://` ones, so a partial
   * mapping is not possible (use `createSimulatedDevice` for sim defs). When
   * omitted, every device builds as a SimulatedDevice exactly as before,
   * regardless of its `binding` scheme.
   */
  deviceFactory?: DeviceFactory;
  /**
   * Seed for the fault-injection RNG (P3d). When set, `failureRate` faults
   * are reproducible across runs; when omitted the RNG is seeded from
   * Math.random(). No effect unless faults are injected.
   */
  faultSeed?: number;
  /**
   * Reputation learning (P4-1). The runtime always owns a ReputationTracker
   * fed by collaboration outcomes and device-operation failures; this flag
   * only controls whether partner selection CONSUMES it (default true).
   * Set false for ablation: negotiators fall back to the legacy static
   * reliability term while the tracker keeps recording.
   */
  reputationEnabled?: boolean;
  /**
   * Effect-verification window for temperature-class device commands
   * (Fix-12, R4 陈工 F-15), in SIM seconds. After a heating/cooling/
   * temperature-control command reports executed, the runtime re-reads the
   * zone temperature once this much sim time has passed; if the value did
   * not move in the commanded direction, the responsible agent takes a
   * reputation FAILURE for the device's temperature-class capabilities —
   * "command executed" is not "treatment worked" (8 sim-days of zero
   * cooling had been scored as cooling success). Default 600 (10 sim-min).
   */
  effectCheckWindowSec?: number;
  /**
   * Small-model triage for AC necessity decisions (P4-2). When enabled and a
   * cheap triage client is provided, every LLM-backed agent's assessor first
   * asks the triage model with the same prompt. mode 'shadow' (default)
   * records agreement without changing decisions; 'enforce' lets a trusted
   * triage 'independent' answer skip the big-model call. Default: disabled.
   */
  triage?: {
    enabled: boolean;
    client?: LLMClient;
    mode?: 'shadow' | 'enforce';
    trustIndependent?: boolean;
  };
  /**
   * T-022 (DevLoop R17): bounded degradation policy for LLM-backed AC
   * necessity decisions when the provider fails (dead backend, timeout,
   * gateway 5xx). Behavior:
   *   1. bounded retry — `retryAttempts` extra attempts (default 1) for
   *      TRANSIENT errors only (network, timeout, 429/5xx), linear backoff
   *      `retryBackoffMs` (default 250). Permanent errors (401/404, unknown
   *      model) are never retried.
   *   2. on final failure, `policy`:
   *      - 'rule-fallback' (default): honest degradation — the decision IS
   *        recorded with decisionSource 'rule-llm-down', the provider error
   *        in its reasoning, and the deterministic capability rule's verdict
   *        (independent/defer) as the decision. Never a silent drop.
   *      - 'drop': the assessment re-throws; the event yields no decision
   *        record (T-105's llmErrors counter + trajectory llm-failure
   *        records remain the only trace).
   * The retry loop runs inline in the decision path and never blocks beyond
   * (1 + retryAttempts) provider timeouts plus backoff. Default when the
   * whole option is omitted: 1 retry, 250ms backoff, rule-fallback.
   */
  llmFailure?: {
    retryAttempts?: number;
    retryBackoffMs?: number;
    policy?: 'rule-fallback' | 'drop';
  };
  /**
   * AC necessity assessor system-prompt override (Wave-3a batch evaluation):
   * replaces the assessor's built-in default prompt for EVERY agent, so two
   * runs of the same scenario can A/B the prompt itself. Undefined keeps the
   * built-in default (zero behavior change).
   */
  assessorSystemPrompt?: string;
  /**
   * Collaboration workflow synthesis (P4-3). When enabled, LLM-backed agents
   * plan multi-step AC goals via an LLM-authored WorkflowPlan that is
   * statically validated and deterministically executed (vision 2.6:
   * 模型编写，框架校验，执行器执行). llmClient defaults to the agent's own
   * client when omitted. Default: disabled (zero behavior change).
   */
  workflowSynthesis?: {
    enabled: boolean;
    llmClient?: LLMClient;
  };
  /**
   * User-orchestrated business flows. When provided, the runtime builds a
   * FlowEngine that evaluates these flows on every injected event and every
   * tick; the provider is re-read at each evaluation, so the server can
   * enable/edit flows dynamically by closing over live state. When omitted
   * but the scenario declares `flows`, those (filtered to enabled) are used
   * instead; when neither exists no FlowEngine is built and behavior is
   * exactly as before.
   */
  flowsProvider?: () => FlowDefinition[];
  /**
   * T-051: executability oracle for the flow engine's RUNTIME assignment
   * pass (simulation's isCapabilityExecutable — injected by the server so
   * runtime verdicts match the authoring-time 422s). Omitted = legacy
   * declared-means-executable semantics (core-only consumers).
   */
  isExecutableCapability?: (capabilityName: string) => boolean;
  /**
   * Living-worlds P1: condition-trigger re-evaluation cadence for lazy
   * advance (advanceTo/peekNextDueMoment), in SIM seconds. Default undefined
   * = tick granularity (every tick boundary is a due moment — bit-exact with
   * per-tick stepping; a world with enabled condition-trigger flows gets no
   * laziness, honestly). A coarser value is a POLICY change (design
   * §8.3/§8.4): condition edges may be detected later than a tick-driven run
   * would, so never set it when bit-equality with tick runs is required.
   */
  conditionEvalEverySimSec?: number;
  /**
   * P3: operator-supplied semantic offer rules for the runtime's aggregate
   * (agent-level semantic service) registration, merged OVER the built-in
   * rule table together with the scenario's own `semanticOfferRules`
   * (`mergeOfferRules`: dedupe by semanticType, custom wins). Default
   * (neither source) = built-in rules only. Env-backed runtimes normally
   * need nothing here — the world-layer aggregate sync already derived the
   * rows and the catalog-sync seam mirrors them in (sweeping the runtime's
   * own `aggregate:` registrations in favor of the DB mirror).
   */
  semanticOfferRules?: SemanticOfferRule[];
}/** Input for manual event injection (also the shape of scenario events). */
export interface InjectEventInput {
  /** Event type (e.g. 'temperature-spike'). Maps to a physical parameter. */
  type: string;
  /** Zone the event originates in. */
  zoneId: string;
  /** Physical parameter override (defaults derived from `type`). */
  parameter?: string;
  /** Value override (defaults derived from `type`). */
  value?: number | boolean | string;
  /** Event id (auto-generated when omitted). */
  id?: string;
  /** Severity for event prioritization (default 'medium'). */
  severity?: 'low' | 'medium' | 'high' | 'critical';
  /**
   * Optional capability requirements attached to the event payload (task
   * metadata). The AC necessity assessor prefers these over capability
   * inference; partner selection uses them to find capable agents.
   */
  requiredCapabilities?: string[];
  /**
   * UI-facing narrative carried through the event payload (Wave 6 F5).
   * The web's EventLogPanel prefers this over the terse parameter line.
   * Accepts a plain string (legacy, treated as zh-only) or a `{zh, en}`
   * object for bilingual scenarios.
   */
  humanNarrative?: LocalizedText | string;
  /** Cinematography hints for the web UI (auto-focus + narration overlay). */
  cinematography?: {
    narrationCue?: string;
    playbackRateOverride?: number;
    highlightAgentIds?: string[];
    cameraFocusKind?: 'zone' | 'agent-pair' | 'event-source';
  };
  /** Zone to focus the UI camera on when this event fires. */
  focusZoneId?: string;
  /**
   * T-103 (F-PH21): duration of a zone-scoped physical effect, in SIM
   * seconds. Today only `power-outage`-family events consume it — the
   * runtime forces every electric device in the zone unpowered for the
   * duration (energy freezes, commands fail), then restores them gradually
   * (one device per restore step). Default 300 (5 sim-min) when the event
   * carries no explicit duration.
   */
  durationSec?: number;
}/** Result of an event injection. */
export interface InjectEventResult {
  eventId: string;
  parameter: string;
  value: number | boolean;
  /** Agents the event was delivered to (managing agents of the zone). */
  targetAgentIds: string[];
  /** R103: which fallback level of the PM-ruled chain answered (route audit). */
  routingLevel?: EventRouteLevel;
  /**
   * T-023 (DevLoop R17): true when the injection returned before every
   * managing agent finished processing (the `deliveryDeadlineMs` option
   * bounded the wait). The physical write and flow evaluation are already
   * applied; the LLM decisions land in the snapshot/trajectory
   * asynchronously. Absent = fully delivered.
   */
  decisionPending?: boolean;
}

/**
 * T-023: optional bounds on one injectEvent call. By default the call
 * awaits every managing agent's full decision (historical semantics);
 * `deliveryDeadlineMs` bounds that wait — on expiry the result returns
 * with `decisionPending: true` while the deliveries continue in the
 * background. The physical parameter write, flow evaluation and listener
 * notification always complete synchronously first.
 */
export interface InjectEventOptions {
  deliveryDeadlineMs?: number;
  /** R102: who injected it (display label) — rides the event's audit record. */
  injectedBy?: string;
  /**
   * T33 (R3 u3-F3): WHO injected it as an ACCOUNT id (the server's user id;
   * absent for scenario-scheduled injections) — rides the InjectedEventRecord
   * so the audit row's actor resolves to the real user, not a display label.
   */
  injectedById?: string;
}/**
 * R14 data services (design-data-services.md §3.1): one injected event as
 * reported to `EngineRuntime.onInjectedEvent` listeners. Injections are
 * delivered to managing agents directly (not broadcast on the event bus),
 * so consumers that need an event history (the server's countSince window)
 * subscribe via the listener instead. `simTimeSec` is the sim clock at the
 * injection — window math stays deterministic under replay/speed-up.
 */
export interface InjectedEventRecord {
  /** The ORIGINAL injected type (e.g. 'fall-detected'), pre-mapping. */
  type: string;
  zoneId: string;
  /** The physical parameter the injection resolved to. */
  parameter: string;
  value: number | boolean;
  severity?: string;
  /**
   * R102 route audit: the agents this event was delivered to (the
   * resolveManagingAgentIds answer at injection time — direct managers
   * first, adjacent-zone fallback otherwise).
   */
  targetAgentIds: string[];
  /** R103: which fallback level of the PM-ruled chain answered (route audit). */
  routingLevel?: EventRouteLevel;
  /** R102: the event's own id (sim-time-anchored for runtime injections). */
  eventId: string;
  /** R102: the injector's display label, when the caller identified one. */
  injectedBy?: string;
  /** T33 (R3): the injector's account id when a platform user pulled the trigger (absent = scenario-scheduled). */
  injectedById?: string;
  simTimeSec: number;
}/** One recorded AC necessity decision (ring buffer, newest last). */
export interface RuntimeDecisionRecord {
  agentId: string;
  eventId: string;
  eventType: string;
  decision: string;
  decisionSource: string;
  /**
   * T-024 (DevLoop R17): the model the LLM decision was made with
   * (decisionSource 'llm' only — rule/precheck/triage decisions made no
   * big-model call). Mirrors the trajectory's per-record `model` so
   * snapshot consumers can show which model decided without joining
   * trajectory files.
   */
  llmModel?: string;
  /**
   * T-024-part3 (DevLoop R17): parse-quality marker for decisionSource 'llm'
   * records — 'llm-json' (structured {"decision","reasoning"} parse won) vs
   * 'llm-fsm' (prose keyword scanner recovered the answer). Absent for
   * rule/precheck/triage decisions (no big-model parse happened). Mirrors
   * the trajectory record's field of the same name.
   */
  decisionSubSource?: 'llm-json' | 'llm-fsm';
  /**
   * Why the decision was made (assessment reasoning — e.g. the rule-only
   * "lacks required capabilities… Deferring" line). Surfaced in the console
   * so defer/failure causes are visible without digging server logs.
   */
  reasoning?: string;
  /**
   * R15-D3: machine-readable twin of `reasoning` for rule/precheck
   * decisions — clients localize from code+params instead of matching the
   * English template text. Absent for genuine LLM reasoning.
   */
  reasoningCode?: string;
  /** Interpolation params for the reasoningCode template. */
  reasoningParams?: Record<string, string | number>;
  /**
   * R15-D4: the zone the triggering event belonged to. Server-side truth —
   * previously clients reconstructed it from local trigger hints, which a
   * page refresh lost.
   */
  zoneId?: string;
  /**
   * Mechanism B: the flow this handle_independently decision named
   * ({flowId, params?}). The run-ledger side of the linkage is the run's
   * invokedBy {agentId, eventId?} + triggerKind 'agent' — (agentId,
   * eventId) joins the two streams.
   */
  invokeFlow?: { flowId: string; params?: Record<string, unknown> };
  /**
   * Phase 1 (cognitive architecture §14.1): the structured segments of the
   * full CognitiveDecision — ADDITIVE fields; existing records (binary-era
   * and rule/precheck decisions) simply lack them. The legacy `decision` +
   * `reasoning` above are DERIVED from `actionPlan.primary.action` /
   * `explanation.summary` via deriveLegacyDecision when a cognitive decision
   * exists.
   */
  situation?: CognitiveDecision['situation'];
  actionPlan?: CognitiveDecision['actionPlan'];
  explanation?: CognitiveDecision['explanation'];
  uncertainty?: CognitiveDecision['uncertainty'];
  /**
   * R40-A3（认知架构 §7.5 升级通道）：该决策触发了升级（shouldEscalate
   * 阈值命中或模型主行动词 escalate）。升级 = 只通知不执行——记录如实
   * 标注"本决策没有执行任何动作"。ADDITIVE：旧记录/未升级决策缺省。
   */
  escalated?: boolean;
  /** 升级条件说明（模型 escalationCondition 优先，缺省用阈值命中 reason）。 */
  escalationCondition?: string;
  /**
   * R102 (chen-19): the event's provenance — 'scheduled' (scenario schedule),
   * 'runtime' (sim inject), or 'perception' (the R91 observed-diff lane).
   * Without it, sources were only distinguishable by id naming habits, which
   * the runtime-id collision made fragile.
   */
  eventSource?: 'scheduled' | 'runtime' | 'perception';
  /** R102: key payload of the triggering event (the resolved value). */
  eventValue?: number | boolean;
  /** R102: the event's declared severity, when it carried one. */
  eventSeverity?: string;
  at: string; // ISO timestamp
}/**
 * One collaboration session as seen by one agent (Fix-8). The same
 * collaboration yields one row per participating agent's view — the
 * initiator's row exists from proposal time (status 'pending'), the
 * partner's row appears after it accepts and joins.
 */
export interface RuntimeCollaborationRecord {
  /** Shared collaboration id (the AC config id on both sides). */
  id: string;
  /** Agent whose session view this row is. */
  agentId: string;
  role: 'initiator' | 'participant';
  /** pending | in_progress | active | completed | failed | cancelled */
  status: string;
  type: string;
  initiator: string;
  participants: string[];
  description: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /** true when the session already moved to history (terminal status). */
  history: boolean;
  /**
   * T-036-depth (DevLoop R17): capability-matching candidates excluded from
   * this collaboration's partner selection by the scope-of-practice filter
   * (cannotDeliverClasses ∩ requiredCapabilities), bounded at 10. Present
   * only when at least one such exclusion happened — the console/trajectory
   * then show WHO was blocked and by which class beside the collaboration
   * that DID form, instead of the exclusions dying at the selection seam.
   */
  scopeExclusions?: Array<{ agentId: string; blockedBy: string[] }>;
}
/**
 * Physics level-of-detail tier (DevLoop R30, capacity-planning §3).
 *
 * `observed` (the default — byte-identical to pre-R30 behavior): the world
 * has active observers; physics integrates at dt=1s substeps per tick.
 * `idle`: no observers, due-driven only; the runtime integrates physics in
 * coarser substeps (default dt target 10s — see
 * EngineRuntime.IDLE_PHYSICS_SUBSTEP_SEC). The thermal U·A exchange,
 * field diffusion/relaxation, CO2 emission/ventilation and device energy
 * accumulation are all dt-parameterized, so a 10s step is the same
 * integration, just coarser (first-order error ~O(dt) on a system whose
 * time constants are minutes — invisible at observation granularity).
 *
 * Determinism boundary (design-living-worlds.md §8.4): the OBSERVED tier is
 * the bit-exact reference every lazy/tick equality invariant compares;
 * the IDLE tier is a LOD POLICY — a world that drifted coarse while idle
 * is not bit-comparable with one that ran fine, which is exactly why the
 * P1W wake path (fast-forward) always restores `observed` precision.
 */
export type PhysicsLodTier = 'observed' | 'idle';

/** R103: which fallback level answered an event's routing (route audit). */
export type EventRouteLevel =
  | 'device-presence'
  | 'capability-match'
  | 'managed-zone'
  | 'adjacent-zone'
  | 'none';

/**
 * R98 event observability: the recorded outcome of a scheduled event firing.
 * `effect` is the resolved physical write on success; `error` is the
 * rejection message when the injection threw (previously swallowed by the
 * scheduler's catch-and-log, leaving fired:true with zero trace).
 */
export interface ScheduledEventFireRecord {
  firedAtSimTimeSec: number;
  effect?: { parameter: string; value: number | boolean };
  error?: string;
}

export interface EngineSnapshot {
  runtimeId: string;
  scenarioId: string;
  scenarioName: string;
  state: EngineRuntimeState;
  /** Simulated seconds elapsed since start. */
  simTimeSec: number;
  /** Simulated wall-clock time (ISO). */
  simTime: string;
  /** Sim-seconds advanced per tick. */
  speed: number;
  tickCount: number;
  /**
   * Fix-42b′: wall-clock cost of the most recent auto-run tick (ms).
   * 0 until the auto-run loop has ticked at least once.
   */
  tickWallMs?: number;
  /**
   * T3 (R2, B1-11): the CONFIGURED tick interval (ms) — the denominator's
   * floor of the nominal rate (speed sim-s per tickMs ms).
   */
  tickMs?: number;
  /**
   * T3 (R2, B1-11): the ACTUAL advancement rate (sim-seconds per real
   * second) = speed ÷ (max(tickMs, ceil(tickWallMs×1.2)+1)/1000) — an
   * instantaneous estimate around the last tick; it fluctuates with LLM
   * load and event-loop lag (autoThrottled marks the degraded cadence).
   * Absent unless running with at least one completed tick.
   */
  effectiveSpeedPerSec?: number;
  /**
   * T43 (R4, completing Batch 3 T32): trailing-window advancement rate —
   * Σ sim-seconds ÷ Σ wall-seconds over the last ~60s of auto-run ticks
   * (ring ≤32 samples; pause/resume resets the window so a frozen gap is
   * never counted as advancement time). The schedule-worthy average;
   * `effectiveSpeedPerSec` above is the instantaneous estimate around the
   * last tick and fluctuates with LLM load. Absent unless running with at
   * least two completed tick intervals (honest absence over a fake 0).
   */
  effectiveSpeedWindowPerSec?: number;
  /** T43: wall seconds actually covered by the window samples (≤ ~60s). */
  effectiveSpeedWindowSec?: number;
  /**
   * Fix-42b′: true when the auto-run loop stretched its interval because
   * ticks cost more than ~4× the configured tick budget (tickMs) — the
   * simulation is running degraded (slower than requested) on purpose
   * rather than saturating the host process.
   */
  autoThrottled?: boolean;
  zones: Array<{
    id: string;
    name?: string;
    type?: string;
    /**
     * Current per-zone parameter values — the standard seven ∪ the zone's
     * DECLARED baseline keys (T-304 union, T-061: surfaced so custom
     * quantities are visible, not just condition-evaluable).
     */
    parameters: Record<string, number | boolean>;
    /**
     * T-061: the zone's DECLARED baseline, verbatim, when the zone has one —
     * declared-vs-evaluated side by side makes threshold authoring possible.
     */
    baseline?: Record<string, number | boolean>;
    /**
     * Building tier (B-B): current headcount. Always present (R98): zones
     * that never declared/received occupancy read 0 — an absent field made
     * "event fired but nothing changed" indistinguishable from "field not
     * exposed".
     */
    occupancy: number;
  }>;
  devices: Array<{
    id: string;
    name: string;
    type: string;
    role: string;
    zoneId: string;
    state: Record<string, unknown>;
    /**
     * Commands the device can actually execute — derived live from its
     * declared capabilities + the registered command handlers
     * (SimulatedDevice.getExecutableCommands). Falls back to the declared
     * capability names for devices that cannot introspect (e.g. hass://).
     */
    commands: string[];
    /** Active fault-injection profile, or null when the device is healthy. */
    fault: FaultProfile | null;
  }>;
  agents: Array<{
    id: string;
    name: string;
    capabilities: string[];
    managedZoneIds: string[];
    boundDeviceIds: string[];
    llmEnabled: boolean;
    activeACCount: number;
    eventsProcessed: number;
    activeCollaborations: Array<{ id: string; name: string; status: string }>;
    /** Learned reputation summary (P4-1): pooled score + top capabilities. */
    reputation: {
      overallScore: number;
      totalAttempts: number;
      topCapabilities: Array<{ capability: string; score: number; attempts: number }>;
    };
  }>;
  recentDecisions: RuntimeDecisionRecord[];
  scheduledEvents: Array<{
    id: string;
    type: string;
    zoneId: string;
    atSimTimeSec?: number;
    fired: boolean;
    /**
     * R98 event observability: when the event fired, the sim-time it fired
     * at and what it did — `effect` (the resolved physical write) on
     * success, `error` when the injection was rejected. "fired:true with no
     * trace" is no longer a possible state.
     */
    firedAtSimTimeSec?: number;
    effect?: { parameter: string; value: number | boolean };
    error?: string;
  }>;
  /**
   * R102 (chen-19): runtime-injected events (sim inject / API) — the SAME
   * query face as scheduledEvents. "What has this world been through" is
   * answerable in one snapshot: scheduled + injected, side by side.
   */
  injectedEvents: InjectedEventRecord[];
  /**
   * Phase 8: All published services in the environment (from
   * EnvironmentCenter's service registry). Each entry carries the
   * service id, name, provider agent, capabilities, and device binding.
   */
  services?: Array<{
    id: string;
    name: string;
    providerAgentId: string;
    deviceId?: string;
    capabilities: string[];
    category: string;
    actionType?: string;
  }>;
  /**
   * LLM cost-reduction surface (P4-2). Present only when a shared LLM
   * client cache is enabled and/or small-model triage is active.
   */
  llm?: {
    /** Response-cache stats from the shared LLM client (when caching is on). */
    cache?: LLMCacheStats;
    /**
     * Failed LLM decision calls aggregated across agents (T-105). The
     * failed event produces no decision record, so without this counter a
     * dead backend is invisible in every API surface.
     */
    llmErrors?: number;
    /** Triage metrics aggregated across all agents (when triage is enabled). */
    triage?: {
      mode: 'shadow' | 'enforce';
      model?: string;
      triageCalls: number;
      triageErrors: number;
      agreements: number;
      disagreements: number;
      agreementRate: number | null;
      bigModelCalls: number;
      bigModelCallsSaved: number;
      bigModelCallSaveRate: number;
      avgTriageLatencyMs: number | null;
      avgBigModelLatencyMs: number | null;
      latencyDeltaMs: number | null;
    };
  };
}/** Listener for the engine event stream (backed by the EnvironmentCenter EventManager). */
export type EngineEventListener = (event: SystemEvent) => void;

// ---------------------------------------------------------------------------
// Living-worlds P0: world-state export (checkpoint payload, design §9)
// ---------------------------------------------------------------------------

/** Format version of the engine world-state export (checkpoint compatibility). */
export const ENGINE_WORLD_STATE_VERSION = 2; // v2: + perception baselines (R91)

/** Per-zone world state at a sim-time boundary. */
export interface WorldZoneStateExport {
  /** Current headcount (zones that track occupancy). */
  occupancy?: number;
  /**
   * Spatial-field entries that actually exist for this zone (localized
   * zones): parameter → value + optional runtime-mutated baseline. Value-
   * model-backed parameters deliberately stay OUT — they are restored via
   * `global` (below) or keep riding their (clock-driven) model.
   */
  field?: Record<string, { value: number; baseline?: number }>;
  /**
   * Custom (non-enum, static) parameter values written at runtime — zone-
   * scoped keys of the physics environment's custom store.
   */
  custom?: Record<string, number | boolean>;
  /**
   * Legacy global (no-bounds) parameter reads at export time. The restore
   * diffs these against the freshly reconstructed value models and only
   * writes back deviations — so clock-driven default models (seasonal
   * diurnal cycles) keep evolving while runtime-injected global writes
   * (constant models) are faithfully re-applied.
   */
  global?: Record<string, number | boolean>;
}

/** Per-device world state. */
export interface WorldDeviceStateExport {
  /** The observable device state (fault-frozen state when a fault holds it). */
  state: Record<string, unknown>;
  /** Active fault profile, or null when healthy. */
  fault: FaultProfile | null;
}

/** Per-agent runtime toggles that a fresh construction would lose. */
export interface WorldAgentStateExport {
  /** The master enable switch (runtime setAgentEnabled toggles). */
  enabled: boolean;
  /**
   * R38-P2 (cognition): the agent's bounded cognition state — the event
   * ring and the last cognitive decision — so a resumed run rebuilds the
   * SAME decision-prompt context (record-replay parity). Optional: absent
   * on pre-cognition checkpoints (fresh cognition starts empty).
   * R38-P5 (meta-cognition): + the decision-quality ring + partner trust
   * so the resumed run's META_COGNITION prompt section matches too.
   */
  cognition?: {
    events: Array<{ type: string; zoneId?: string; parameter?: string; value?: number | boolean; simTimeSec: number }>;
    lastDecision: { action: string; outcome: string; atSimTimeSec?: number } | null;
    metaCognition?: MetaCognitionCheckpoint | null;
    /**
     * R40-C3 (cognition): the world-model PARAMETER face — every
     * `location:parameter` the agent observed, keyed with its value + the
     * sim time the face was captured at. Without it a resumed run's legacy
     * projections (`getEnvironmentStateSnapshot()` et al.) start at zero
     * until the next event arrives. Optional: absent on pre-C3 checkpoints
     * (the face honestly starts empty) and when no parameter-face store is
     * wired into the manager.
     */
    environmentParams?: Record<string, EnvironmentParamFaceCheckpoint>;
    /**
     * R40-C2 (cognition): the working-memory DIFF baseline — the previous
     * cognitive round's zone face that `CHANGES_SINCE_LAST_ROUND` (the
     * WORLD_CONTEXT prompt line) diffs against. Without it a resumed run's
     * first round claims "initial perception" and its prompt diverges from
     * the recorded run (record-replay parity). Optional: absent on pre-C2
     * checkpoints (the first resumed round falls back to the honest
     * initial-perception entry) and before the agent's first round.
     */
    previousZoneFace?: Array<{ zoneId: string; parameters: Record<string, number | boolean> }>;
  };
}

/**
 * The engine's complete world state at a sim-time boundary — everything a
 * fresh EngineRuntime built from the SAME scenario needs to continue the run
 * bit-for-bit, excluding the scenario itself (owned by the caller/checkpoint
 * envelope) and audit streams (trajectory/timeline files keep their own
 * history). Pure data: JSON-serializable, no methods, no live references.
 */
export interface EngineWorldStateExport {
  formatVersion: typeof ENGINE_WORLD_STATE_VERSION;
  /** Simulated seconds elapsed (the checkpoint's sim-time boundary). */
  simTimeSec: number;
  /** Sim-seconds per tick at export time. */
  speed: number;
  tickCount: number;
  /**
   * Epoch-ms anchor of the sim clock (construction wall time). Time-
   * dependent default value models (seasonal diurnal cycles) are pure
   * functions of this + simTimeSec — restoring BOTH reproduces their reads.
   */
  simStartEpochMs: number;
  /** Next scheduled-event id counter (`evt-runtime-<n>`), kept collision-free across resume. */
  eventSeq: number;
  /** Fault-RNG state: the resolved seed + number of draws consumed. */
  rng: { seed: number; draws: number };
  zones: Record<string, WorldZoneStateExport>;
  devices: Record<string, WorldDeviceStateExport>;
  /** Registered physics effects (occupancy virtual sources excluded). */
  deviceEffects: DevicePhysicsEffectLike[];
  agents: Record<string, WorldAgentStateExport>;
  /** Learned reputation (P4-1 tracker, sim-clock anchored). */
  reputation: ReputationTrackerJSON | null;
  /** Bounded recent-decision ring (observable via getSnapshot). */
  recentDecisions: RuntimeDecisionRecord[];
  /** collaborationId → capabilities requested (reputation attribution memo). */
  acCapabilities: Record<string, string[]>;
  /** Scheduler state: which scheduled events / occupancy boundaries fired. */
  /** R91/R92 感知基线（棘轮差分状态：key、基线值、上次发射秒、上次值、上次采样秒）。 */
  perception: {
    baselines: ReadonlyArray<readonly [string, number, number, number, number]>;
  };
  scheduler: {
    firedEventIds: string[];
    occupancyFired: string[];
  };
  /** Fix-12 pending before/after temperature rechecks (sim-time due). */
  pendingEffectChecks: Array<{
    agentId: string;
    deviceId: string;
    zoneId: string;
    commandName: string;
    direction: 'up' | 'down';
    before: number;
    dueSimSec: number;
    capabilities: string[];
  }>;
  /**
   * Flow-engine trigger memories (condition edges, cooldowns, one-shot
   * schedule markers, the (prev, cur] window anchor) — null when this
   * runtime runs no flow engine (acMode shadow, no flows declared).
   */
  flowEngine: FlowEngineStateExport | null;
}// ---------------------------------------------------------------------------
// Living-worlds P1: due-moment computation (lazy advance contract, design §8.2)
// ---------------------------------------------------------------------------

/**
 * Which kind of source produced a due moment. Purely descriptive (which
 * source woke the world); the engine executes the SAME tick body
 * (fireDueEvents + flow onTick) at every due moment regardless of kind.
 */
export type DueMomentKind =
  | 'scenario-event' // scenario.events[].atSimTimeSec (incl. observationOnly marking)
  | 'occupancy-schedule' // occupantSchedule arrive/depart boundaries
  | 'flow-schedule' // schedule triggers: one-shot atSimTimeSec + periodic everySimSec crossings
  | 'flow-condition-eval' // condition-trigger re-evaluation cadence (edge semantics)
  | 'flow-cooldown' // cooldownSimSec expiry (re-arm of a suppressed flow)
  | 'effect-check' // Fix-12 pendingEffectChecks[].dueSimSec
  | 'flow-wait' // FEAT-06 pendingFlowWaits[].dueSimSec (run parked on a wait node)
  | 'external'; // caller-registered SIM-clock duty (e.g. server freshness floor, wall-mapped)

/** One computed due moment: an absolute sim-time plus the sources that hit it. */
export interface DueMoment {
  /** Absolute sim-time (seconds) — always strictly greater than the query origin. */
  atSimSec: number;
  kinds: DueMomentKind[];
  /** Human-readable source labels (flow ids, event ids, zone ids) for logs. */
  labels: string[];
}

/**
 * Coarse fast-forward options for `EngineRuntime.advanceTo` — the
 * world-session catch-up of multi-day backlogs. Due-moment fidelity is
 * UNCHANGED (every due fires exactly once at the same sim moment as a
 * per-tick run); only the inter-due PHYSICS integrates at a coarser substep
 * — the idle LOD tier's tradeoff, explicitly chosen per advance.
 */
export interface AdvanceToOptions {
  /**
   * Enable the coarse path: between two due moments the world advances in
   * strides of up to this many sim-seconds (instead of one tick per `speed`
   * sim-seconds). Must exceed the runtime's speed to take effect — smaller
   * values are ignored and the advance stays bit-exact.
   */
  coarseStrideSec?: number;
  /**
   * Coarse physics substep in sim seconds (default IDLE_PHYSICS_SUBSTEP_SEC,
   * the idle tier's battle-tested stride). Larger values buy speed with
   * integration accuracy — treat anything above the default as a documented
   * tolerance tradeoff (the field models are dt-parameterized explicit
   * steps). Env baselines and power-outage transitions still refresh per
   * substep.
   */
  coarseSubstepSec?: number;
}

/**
 * The sim-clock state a due computation reads (design §8.2 source table).
 * Everything here is derivable from the runtime's own state — no wall clock.
 */
export interface DueMomentSources {
  /** Scenario scheduled events (fired ones are skipped). */
  scenarioEvents: Array<{
    id: string;
    atSimTimeSec?: number;
    fired: boolean;
  }>;
  /** Zones with an occupantSchedule (arrive/depart boundaries), plus the
   * runtime's `${zoneId}:${arrive|depart}:${day}` fired-key memory. */
  occupancySchedules: Array<{
    zoneId: string;
    startSimTimeSec: number;
    endSimTimeSec: number;
    repeatDaily?: boolean;
  }>;
  occupancyFiredKeys: string[];
  /**
   * FEAT-07 phase-2 (calendar overlay): zone overlay ENTER/EXIT transition
   * moments (marker key in the same occupancyFiredKeys set — consumed
   * markers are skipped) and the overlay schedules with their governing
   * window (boundary enumeration is clipped to `[windowStart, windowEnd)`).
   */
  occupancyOverlayTransitions?: Array<{ zoneId: string; atSimSec: number; key: string }>;
  occupancyOverlaySchedules?: Array<{
    zoneId: string;
    startSimTimeSec: number;
    endSimTimeSec: number;
    repeatDaily?: boolean;
    windowStartSimSec: number;
    windowEndSimSec: number;
  }>;
  /** Enabled flows (the engine re-reads its provider each computation). */
  flows: Array<{
    id: string;
    enabled: boolean;
    trigger: {
      kind: 'event' | 'condition' | 'schedule';
      atSimTimeSec?: number;
      everySimSec?: number;
      startAtSimTimeSec?: number;
      endAtSimTimeSec?: number;
      /** FEAT-01: daily time-of-day anchor (sim seconds-of-day). */
      atTimeOfDaySec?: number;
      /** FEAT-01: occupancy-relative daily anchor (see FlowTrigger). */
      relativeToOccupancy?: {
        zoneId?: string;
        before: 'arrive' | 'depart';
        offsetSec: number;
      };
      cooldownSimSec?: number;
    };
    /** One-shot schedule markers already consumed (FlowEngine.scheduleFired). */
    scheduleFired?: boolean;
    /** Cooldown memory: sim-sec the current cooldown (if any) expires at. */
    cooldownUntilSimSec?: number;
  }>;
  /** Fix-12 pending before/after temperature rechecks. */
  pendingEffectChecks: Array<{ dueSimSec: number }>;
  /** FEAT-06: runs parked on flow wait nodes (their earliest armed due). */
  pendingFlowWaits?: Array<{ dueSimSec: number }>;
  /**
   * Condition-trigger re-evaluation cadence in sim seconds. Undefined = no
   * enabled condition flows (nothing to evaluate). The bit-exact default is
   * the runtime's tick granularity (every tick boundary is a due moment, so
   * lazy advance equals per-tick stepping); a coarser policy value trades
   * edge-detection latency for laziness (design §8.3/§8.4 — a policy change,
   * versioned, NOT bit-equal to a tick run).
   */
  conditionEvalEverySimSec?: number;
  /**
   * Caller-registered SIM-clock duties (already converted from wall clock by
   * the caller — e.g. the server's terms.read freshness floor mapped through
   * the sim's wall-clock rate).
   */
  externalDueSimSec?: number[];
}

/**
 * Physics substep stride for lazy advance (sim seconds). The integrator's
 * semantics are stride-coupled — device control loops (thermostat hysteresis)
 * and the PM2.5 decay path evaluate per substep, several effect paths
 * hardcode dt=1 — so the bit-exact stride with tick-driven runs is 1s
 * (identical to advanceTick's `Math.round(speed)` substeps of dt =
 * speed/steps at speed 1). Coarser strides are a versioned policy change
 * (design §8.3 "未观测窗口粗化", opt-in, NOT implemented in P1).
 */
export const PHYSICS_SUBSTEP_SEC = 1;

/**
 * Convert a capability name to a DeviceCapability object.
 * Same heuristic as the experiment runner: monitoring-ish → read,
 * control-ish → write, else execute. The read side is the SHARED read-only
 * predicate (capabilities/read-only.ts, BUG-04) — `detect-*` and the
 * get/read/query verb prefixes type as 'read' everywhere now.
 */
export function capabilityNameToDeviceCapability(name: string): DeviceCapability {
  const lower = name.toLowerCase();
  let type: CapabilityType = 'execute';
  if (isReadOnlyCapabilityName(name)) {
    type = 'read';
  } else if (
    lower.includes('control') || lower.includes('adjustment') ||
    lower.includes('setting')
  ) {
    type = 'write';
  }
  return { name, type, parameters: [] };
}/**
 * Build the default `sim://` device for a scenario device definition —
 * exactly the construction EngineRuntime uses when no `deviceFactory` is
 * given. Exported so external factories (e.g. the server's hass:// bridge)
 * can keep sim-bound devices on the identical path instead of replicating
 * these lines.
 */
export function createSimulatedDevice(def: ScenarioDevice): RuntimeDevice {
  const sim = loadSimulation();
  return new sim.SimulatedDevice({
    id: def.id,
    name: def.name,
    type: def.type,
    initialState: {
      zoneId: def.zoneId,
      status: 'active',
      ...def.initialState,
    },
    capabilities: def.capabilities.map(capabilityNameToDeviceCapability),
    behaviors: [],
    location: def.zoneId,
  });
}/**
 * Placeholder LLMClient for agents running without an LLM. Any actual call
 * fails loudly with a descriptive error — rule-only agents resolve every
 * assessment via deterministic rules (ruleOnlyMode) and must never reach an
 * LLM call.
 */
export function createNoLLMClientStub(agentId: string): LLMClient {
  const fail = (method: string) => async (): Promise<never> => {
    throw new Error(
      `EngineRuntime: agent "${agentId}" has no LLMClient (running rule-only) ` +
      `— unexpected LLM call via ${method}()`,
    );
  };
  return {
    chat: fail('chat'),
    quickChat: fail('quickChat'),
    setLoggingCallback: () => undefined,
    setContextProvider: () => undefined,
    getProviderName: () => 'none',
    healthCheck: async () => false,
  } as unknown as LLMClient;
}

/**
 * T-601 (R26): resolve one agent's LLM client. An explicit `llm: null` on the
 * agent definition — or a null `llmPerAgent` entry — is an opt-out: NO
 * client, rule-only by construction, even when a shared `llmClient` exists.
 * Absent keeps the legacy shared fall-through; an entry wins over shared.
 */
export function resolveAgentLlmClient(
  scenario: { agents: Array<{ id: string; llm?: unknown }> },
  options: EngineRuntimeOptions,
  agentId: string,
): LLMClient | undefined {
  const perAgent = options.llmPerAgent?.[agentId];
  if (perAgent !== undefined) return perAgent ?? undefined;
  if (scenario.agents.find(a => a.id === agentId)?.llm === null) return undefined;
  return options.llmClient;
}