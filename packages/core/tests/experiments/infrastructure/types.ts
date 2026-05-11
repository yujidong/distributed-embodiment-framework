/**
 * Paper Experiment Infrastructure Types
 *
 * Sprint P13: Defines all paper-specific experiment types for the Active
 * Collaboration IoT framework. These types support experiments addressing
 * research questions RQ1-RQ4:
 *   - RQ1: World model effectiveness (accuracy of zone-based spatial reasoning)
 *   - RQ2: Autonomous collaboration (initiation, partner selection, formation)
 *   - RQ3: Efficiency (two-layer filtering, LLM token usage, wall-clock time)
 *   - RQ4: Robustness (graceful degradation under device/agent/communication failures)
 *
 * These are pure type definitions with no external imports.
 */

// ---------------------------------------------------------------------------
// Literal union types
// ---------------------------------------------------------------------------

/** The physical scale of the simulated environment. */
export type ScenarioType =
  | 'single-room'
  | 'apartment'
  | 'campus'
  | 'factory'
  | 'hospital'
  | 'smart-city';

/** Experimental condition / treatment applied during a trial iteration. */
export type ExperimentCondition =
  | 'full-ac'
  | 'vague-spatial'
  | 'no-propagation'
  | 'no-service'
  | 'central-planner'
  | 'random-planner'
  | 'always-collaborate'
  | 'never-collaborate'
  | 'rule-only'
  | 'oracle'
  | 'coverage-aware'    // Physical coverage info only (no services, no propagation)
  | 'concise-service'   // Filtered services (event-zone only) with compact descriptions
  | 'dual-trigger'      // Layer 1 rules + Layer 2 LLM (dual-trigger architecture)
  | 'smart-rules'       // Deterministic rules with spatial + service reasoning (no LLM)
  | 'tfidf-baseline'   // Character n-gram Jaccard similarity for capability matching (no LLM)
  | 'layer1-enabled';   // Layer 1 active with severity-escalation classifier

/** Type of failure injected for RQ4 robustness experiments. */
export type RobustnessFailureType =
  | 'device-unresponsive'
  | 'agent-withdrawal'
  | 'communication-timeout';

/** The four possible collaboration decisions an agent can make. */
export type CollaborationDecision =
  | 'initiate_ac'
  | 'handle_independently'
  | 'defer'
  | 'ignore';

/** Event origin category for realistic event routing. */
export type EventCategory = 'device-originated' | 'agent-directed';

// ---------------------------------------------------------------------------
// Ground Truth Calculator types (V5)
// ---------------------------------------------------------------------------

/**
 * Interaction type for an (Agent, Event) pair per V5 Definition 7.
 * Classifies the physical relationship between an agent and an event.
 *
 * Type A: Agent has all capabilities AND event is in agent's actuator zone
 * Type B: Agent lacks capabilities AND event is in agent's actuator zone
 * Type C: Agent lacks capabilities AND event is in propagation range (δ)
 * Type D: Agent lacks capabilities AND event is outside agent's range
 * Type E: Agent has all capabilities AND event is outside agent's range
 */
export type AgentEventType = 'A' | 'B' | 'C' | 'D' | 'E';

/** Coverage level for an agent relative to an event location. */
export type CoverageLevel = 1 | 0.5 | 0;

/** Ground truth for a single (Agent, Event) pair, computed from the formal model. */
export interface AgentEventGroundTruth {
  /** The agent being evaluated. */
  agentId: string;

  /** The event being evaluated. */
  eventId: string;

  /** Zones where this agent has actuators (direct physical action capability). */
  actuatorZones: string[];

  /** Coverage(A, e): 1 = direct, 0.5 = propagation (δ), 0 = none. */
  coverage: CoverageLevel;

  /** Gap(A, e): capabilities required by the event that the agent lacks. */
  gap: string[];

  /** Type(A, e): interaction type per Definition 7. */
  type: AgentEventType;

  /** Decision*(A, e): the correct decision for this agent on this event. */
  correctDecision: CollaborationDecision;

  /** Capabilities the agent has that match the event requirements. */
  matchedCapabilities: string[];

  /** Whether the agent has any actuators covering the event zone. */
  hasDirectCoverage: boolean;

  /** Whether the event zone is reachable via effect propagation from agent's actuators. */
  hasPropagationCoverage: boolean;
}

// ---------------------------------------------------------------------------
// Experiment configuration
// ---------------------------------------------------------------------------

/**
 * Top-level configuration for a single paper experiment run.
 * Captures the research question, scenario, condition, and execution
 * parameters needed to reproduce the experiment.
 */
export interface PaperExperimentConfig {
  /** Unique identifier for this experiment (e.g. "rq1-single-room-full-ac"). */
  id: string;

  /** Human-readable experiment name. */
  name: string;

  /** The research question this experiment addresses. */
  rq: 'RQ1' | 'RQ2' | 'RQ3' | 'RQ4' | 'RQ5';

  /** Scale of the simulated environment. */
  scenario: ScenarioType;

  /** Experimental condition / treatment. */
  condition: ExperimentCondition;

  /** Number of independent iterations to run. */
  iterations: number;

  /** LLM model identifier used for assessment and reasoning. */
  llmModel: string;

  /** Maximum wall-clock time per iteration before forced termination (ms). */
  timeoutMs: number;

  /**
   * Statistical significance threshold (alpha). Used primarily for RQ3
   * efficiency comparisons between the two-layer filter and baseline approaches.
   */
  significanceThreshold?: number;

  /**
   * Type of failure to inject for RQ4 robustness experiments.
   * Only applicable when rq is 'RQ4'.
   */
  failureType?: RobustnessFailureType;

  /**
   * When true, ALL agents evaluate every event (not just the primary agent).
   * Ground truth is computed per-agent using the GroundTruthCalculator,
   * producing one EventResult per (Agent, Event) pair. This enables
   * the Type × Condition interaction matrix analysis for RQ2.
   */
  multiAgentEval?: boolean;

  /**
   * When true AND multiAgentEval is true, routes device-originated events
   * only to agents that manage the event's zone (via managesZoneIds).
   * This eliminates artificial Type D inflation from broadcast delivery.
   * When false, all agents receive all events (legacy behavior).
   * Defaults to true.
   */
  realisticRouting?: boolean;

  /**
   * When true, the experiment also evaluates the execution phase
   * (partner selection → goal formulation → device execution →
   * physical environment change). Populates executionPhase in
   * EventResult and executionMetrics in PaperExperimentResult.
   */
  executionPhaseEval?: boolean;

  /**
   * Simulated duration (in seconds) that each device command execution covers.
   * Controls how much simulated time passes per physics effect — higher values
   * produce larger environment changes per command (e.g., 300s = 5 minutes of
   * cooling). Default: 60 (1 minute).
   */
  simDurationSeconds?: number;

  /**
   * When true, skip AC execution (device control + physics simulation) and
   * only collect decision-level metrics (accuracy, tokens, timing, type-wise
   * breakdown). The agent still receives events, makes AC necessity assessments
   * (LLM calls happen normally), and DECIDES whether to initiate AC — but the
   * actual collaboration execution (ACExecutor Phase 2–4) is skipped.
   *
   * This is ~50x faster than full execution mode because the physics simulation
   * is the dominant time cost (~46 min/iter with physics vs ~1 min without).
   *
   * Execution-phase metrics (goalAchievementRate, envEffectAccuracy) will not
   * be populated in decisionOnly mode. Use full execution mode (Block D) for
   * those metrics.
   */
  decisionOnly?: boolean;

  /**
   * Pre-built LLM client to use instead of creating one from Ollama.
   * When provided, the PaperExperimentRunner skips initializeLLM() and
   * uses this client directly. This enables API-based providers (DeepSeek,
   * OpenAI, etc.) to be used in paper experiments.
   */
  llmClient?: import('@active-collaboration/llm-integration').LLMClient;
}

// ---------------------------------------------------------------------------
// Per-event result
// ---------------------------------------------------------------------------

/**
 * Result captured for a single test event within an experiment iteration.
 * Contains the agent's decision, selected partner information, quality
 * metrics, timing breakdown, and ground-truth comparison.
 */
export interface EventResult {
  /** Identifier of the test event. */
  eventId: string;

  /** The zone in which this event occurred. */
  eventZoneId: string;

  /** The collaboration decision made by the primary agent. */
  decisionMade: CollaborationDecision;

  /** Where the decision came from: preCheck rules, LLM assessment, condition override, or Layer 1 filter. */
  decisionSource?: 'precheck' | 'llm' | 'override' | 'layer1-filter';

  /** ID of the partner agent selected, if collaboration was initiated. */
  selectedPartnerAgentId?: string;

  /** IDs of devices assigned to the partner, if applicable. */
  selectedPartnerDeviceIds?: string[];

  /** Capabilities the agent determined were needed for this event. */
  requestedCapabilities?: string[];

  /** Verbatim LLM reasoning trace for the decision. */
  llmReasoning?: string;

  // -- Quality metrics --

  /** How accurately the agent targeted the correct zone (0-1). */
  zoneTargetingAccuracy: number;

  /** Appropriateness of the selected capabilities for the event (0-1). */
  capabilityAppropriateness: number;

  /** Number of adjacent-zone side effects the agent was aware of (0-3). */
  sideEffectAwareness: number;

  /** Whether the proposed action is physically plausible (0-1). */
  physicalPlausibility: number;

  /** Whether the agent made the correct collaboration decision overall. */
  correctDecision: boolean;

  // -- Timing --

  /** Time taken for the Layer 2 LLM assessment phase (ms). */
  assessmentTimeMs: number;

  /** Time taken for partner formation, if collaboration was initiated (ms). */
  formationTimeMs?: number;

  /** Time taken for action execution after decision (ms). */
  executionTimeMs?: number;

  // -- Outcome --

  /** Whether the event's goal was ultimately achieved. */
  goalAchieved?: boolean;

  // -- Multi-agent fields (when multiAgentEval is true) --

  /** The agent that made this decision (for multi-agent evaluation). */
  agentId?: string;

  /** Ground truth interaction type for this (Agent, Event) pair. */
  interactionType?: AgentEventType;

  /** Ground truth coverage level for this (Agent, Event) pair. */
  coverage?: CoverageLevel;

  /** Ground truth gap for this (Agent, Event) pair. */
  gapCapabilities?: string[];

  /** The event category that produced this evaluation. */
  eventCategory?: EventCategory;

  /** Whether this agent was a managing agent or a collaboration partner. */
  evaluationRole?: 'managing' | 'partner';

  // -- Execution phase fields (when executionPhaseEval is true) --

  /** Execution-phase result for this event (partner selection, goal, device ops, env effects). */
  executionPhase?: ExecutionPhaseResult;
}

// ---------------------------------------------------------------------------
// Aggregated experiment result
// ---------------------------------------------------------------------------

/**
 * Aggregated result for a single iteration of a paper experiment.
 * Combines the configuration, per-event results, aggregate quality scores,
 * collaboration statistics, efficiency metrics, and raw dual-trigger data.
 */
export interface PaperExperimentResult {
  /** The experiment configuration that produced this result. */
  config: PaperExperimentConfig;

  /** Zero-based iteration index. */
  iteration: number;

  /** ISO 8601 timestamp of when the iteration completed. */
  timestamp: string;

  /** Per-event results in the order they were processed. */
  events: EventResult[];

  /** Aggregate decision-quality means across all events. */
  decisionQuality: {
    /** Mean zoneTargetingAccuracy. */
    meanZoneTargetingAccuracy: number;

    /** Mean capabilityAppropriateness. */
    meanCapabilityAppropriateness: number;

    /** Mean sideEffectAwareness. */
    meanSideEffectAwareness: number;

    /** Mean physicalPlausibility. */
    meanPhysicalPlausibility: number;

    /** Fraction of events with correctDecision === true. */
    meanCorrectDecisionRate: number;
  };

  /** Collaboration-level statistics. */
  collaboration: {
    /** Fraction of events where the agent initiated collaboration. */
    initiationRate: number;

    /** Fraction of initiated collaborations that successfully formed. */
    formationSuccessRate: number;

    /** Fraction of events where the goal was achieved. */
    goalAchievementRate: number;

    /**
     * Fraction of events where the system achieved the best possible
     * outcome (correct decision, minimal overhead). Omitted when not
     * applicable.
     */
    optimalPerformanceRatio?: number;
  };

  /** Efficiency and resource-usage metrics. */
  efficiency: {
    /** Total number of events processed in this iteration. */
    totalEvents: number;

    /** Number of events filtered out by Layer 1 (rule-based). */
    layer1Filtered: number;

    /** Fraction of events handled entirely by Layer 1 (no LLM call). */
    layer1FilterRate: number;

    /** Total number of LLM API calls made during this iteration. */
    llmCallCount: number;

    /** Total token count across all LLM calls. */
    totalTokens: number;

    /** Prompt tokens consumed across all LLM calls. */
    promptTokens: number;

    /** Completion tokens produced across all LLM calls. */
    completionTokens: number;

    /** Average assessment time across all Layer 2 events (ms). */
    avgAssessmentTimeMs: number;

    /** Total wall-clock time for this iteration (ms). */
    totalWallTimeMs: number;
  };

  /** Robustness metrics — only populated when rq is 'RQ4'. */
  robustness?: {
    /** Type of failure injected. */
    failureType: RobustnessFailureType;

    /** Number of events where the system handled the failure gracefully. */
    gracefulDegradationCount: number;

    /** Fraction of events handled gracefully under failure conditions. */
    gracefulDegradationRate: number;

    /** Whether the system remained operational after failure (0-1). */
    systemAvailability: number;

    /** Average time to detect and adapt to the failure (ms). */
    avgRecoveryTimeMs: number;
  };

  /**
   * Raw statistics from the dual-trigger evaluation, used for
   * reconstructing detailed trigger-level analyses without re-running
   * the experiment.
   */
  rawDualTriggerStats: Record<string, unknown>;

  /** Classification metrics (precision/recall/F1). Computed when scenario events are available. */
  classification?: ClassificationMetrics;

  /**
   * Execution-phase metrics — only populated when config.executionPhaseEval is true.
   * Captures partner selection accuracy, goal achievement, and physical environment effects.
   */
  executionMetrics?: ExecutionMetrics;
}

// ---------------------------------------------------------------------------
// Execution phase types (RQ5)
// ---------------------------------------------------------------------------

/**
 * Per-event execution-phase result.
 * Captures what happened after the collaboration decision through the
 * partner selection → goal formulation → device execution → physical
 * environment change chain.
 */
export interface ExecutionPhaseResult {
  /** The event this execution phase belongs to. */
  eventId: string;

  // -- Partner selection --
  /** Whether partner selection succeeded (found at least one partner). */
  partnerSelectionSuccess: boolean;
  /** IDs of selected partner agents. */
  selectedPartnerIds: string[];

  // -- Goal formulation --
  /** Whether goal formulation produced valid goals. */
  goalFormulationSuccess: boolean;
  /** Number of goals formulated. */
  goalsFormulated: number;

  // -- Execution --
  /** Whether the AC executor ran to completion (not timed out). */
  executionCompleted: boolean;
  /** Whether execution reported success. */
  executionSuccess: boolean;
  /** Fraction of goals that were achieved (0-1). */
  goalAchievementRate: number;
  /** Number of device operations performed. */
  deviceOperationCount: number;
  /** Whether a change was observed in the physical environment. */
  environmentEffectsObserved: boolean;
  /** Parameter changes observed in the environment. */
  parameterChanges: Array<{
    parameter: string;
    zone: string;
    beforeValue: number | boolean;
    afterValue: number | boolean;
  }>;

  // -- Timing --
  /** Time from initiateAC to execution completion (ms). */
  executionTimeMs: number;
  /** Total end-to-end time from event injection to environment change (ms). */
  totalLatencyMs: number;

  // -- Ground truth comparison --
  /** Whether the correct partner was selected (when correctPartnerId is defined). */
  correctPartnerSelected: boolean;
  /** Whether the expected outcome was achieved. */
  expectedOutcomeAchieved: boolean;
  /** How close the environment change was to the expected outcome (0-1). */
  environmentAccuracy: number;
}

/**
 * Aggregate execution metrics across all events in an experiment iteration.
 */
export interface ExecutionMetrics {
  /** Number of events where initiate_ac was decided. */
  acInitiatedCount: number;
  /** Number of events where execution completed. */
  executionCompletedCount: number;

  /** Fraction of initiate_ac events where partners were found. */
  partnerSelectionRate: number;
  /** Fraction of events where the correct partner was selected. */
  partnerAccuracy: number;
  /** Fraction of formulated goals that were achieved. */
  goalAchievementRate: number;
  /** Fraction of events where execution reported success. */
  executionSuccessRate: number;
  /** Fraction of events where the expected outcome was achieved. */
  outcomeAchievementRate: number;
  /** Mean environment accuracy across events. */
  meanEnvironmentAccuracy: number;
  /** Mean execution time (ms). */
  meanExecutionTimeMs: number;
  /** Mean total latency from event to environment change (ms). */
  meanTotalLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Scenario definition types
// ---------------------------------------------------------------------------

/** Axis-aligned rectangular zone bounds. */
export interface ZoneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A zone within the simulated environment. */
export interface ZoneDef {
  /** Unique zone identifier. */
  id: string;

  /** Human-readable zone name. */
  name: string;

  /** Axis-aligned bounding rectangle. */
  bounds: ZoneBounds;

  /** Physical dimensions of the zone (width and height in meters). */
  dimensions?: { widthM: number; heightM: number };

  /**
   * IDs of zones that share a boundary or overlap. Used to evaluate
   * side-effect awareness -- the agent should reason about how actions
   * in this zone affect adjacent zones.
   */
  adjacentZoneIds: string[];

  /**
   * Zone type classification for device deployment generation.
   * When set, the zone-device-generator can auto-generate a standard
   * set of devices appropriate for this zone type.
   */
  zoneType?: string;
}

/** Position in 3D space. */
export interface Position3D {
  x: number;
  y: number;
  z: number;
}

/** Position in 2D space. */
export interface Position2D {
  x: number;
  y: number;
}

/** An IoT device placed within the simulated environment. */
export interface DeviceDef {
  /** Unique device identifier. */
  id: string;

  /** Human-readable device name. */
  name: string;

  /** Whether the device is a sensor, actuator, or hybrid. */
  type: 'sensor' | 'actuator' | 'hybrid';

  /** Device sub-type (e.g., 'temperature', 'hvac', 'motion'). */
  subType?: string;

  /** The zone this device is located in. */
  zoneId: string;

  /** Precise 3D location of the device. */
  location: Position3D;

  /** Capabilities offered by this device (e.g., "temperature-reading", "hvac-control"). */
  capabilities: string[];

  /** ID of the agent that installed / owns this device. */
  installedBy?: string;
}

/** An autonomous agent participating in the scenario. */
export interface AgentDef {
  /** Unique agent identifier. */
  id: string;

  /** Human-readable agent name. */
  name?: string;

  /** The stakeholder or entity this agent represents. */
  owner: string;

  /** Capabilities this agent can provide through its managed devices. */
  capabilities: string[];

  /** IDs of zones this agent is responsible for. */
  managesZoneIds: string[];

  /**
   * IDs of devices this agent directly manages. Omitted when the agent
   * does not manage any specific devices (e.g. a purely advisory agent).
   */
  managesDeviceIds?: string[];
}

/** Expected outcome parameter for ground-truth validation. */
export interface ExpectedOutcome {
  /** The parameter being affected (e.g. "temperature", "lightLevel"). */
  parameter: string;

  /** Where the outcome should be observed (zone ID). */
  location: string;

  /**
   * The expected value after the action completes. If omitted, only the
   * direction of change is validated via shouldChange.
   */
  targetValue?: number;

  /** Acceptable deviation from targetValue. */
  tolerance?: number;

  /** Whether the parameter is expected to change at all. */
  shouldChange: boolean;

  /**
   * Validation mode:
   * - 'environment_parameter' (default): Check physical environment parameter change.
   * - 'task_completion': Check that the agent executed device operations,
   *   regardless of whether a physical parameter changed. Used for non-physical
   *   abstract parameters (security, energy, maintenance) that cannot be
   *   validated through physics simulation.
   */
  validationMode?: 'environment_parameter' | 'task_completion';
}

/** A test event injected into the scenario for the agent to handle. */
export interface TestEventDef {
  /** Unique event identifier. */
  id: string;

  /** Event type (e.g. "temperature-rise", "motion-detected"). */
  type: string;

  /** The zone where the event originates. */
  zoneId: string;

  /** Precise 2D location of the event. */
  location: Position2D;

  /** Additional event-specific data. */
  payload: Record<string, unknown>;

  /** Severity level for event prioritization. */
  severity?: 'low' | 'medium' | 'high' | 'critical';

  /** Event origin category for realistic event routing. Defaults to 'device-originated'. */
  eventCategory?: EventCategory;

  // -- Ground truth for automated evaluation --

  /** Whether this event genuinely requires cross-agent collaboration. */
  requiresCollaboration: boolean;

  /** The capabilities required to handle this event. */
  requiredCapabilities: string[];

  /** The correct collaboration decision for this event. */
  correctDecision: CollaborationDecision;

  /**
   * ID of the agent that should be selected as partner.
   * Undefined when collaboration is not required or when any suitable
   * partner is acceptable.
   */
  correctPartnerId?: string;

  /**
   * Capabilities the correct partner agent should possess.
   * Undefined when collaboration is not required.
   */
  correctPartnerCapabilities?: string[];

  /**
   * Expected propagation effects the agent should be aware of.
   * Present when the event occurs in or near zones where physical
   * effects propagate across boundaries.
   */
  propagationAwareness?: {
    sourceZoneId: string;
    affectedZoneIds: string[];
    reason: string;
  };

  /** Expected measurable outcomes after correct handling. */
  expectedOutcome: ExpectedOutcome;
}

/**
 * Full definition of a test scenario, including its zones, devices,
 * agents, and the sequence of events the agent(s) must handle.
 */
export interface ScenarioDefinition {
  /** Unique identifier matching the ScenarioType. */
  id: ScenarioType;

  /** The type / scale of this scenario. */
  type: ScenarioType;

  /** Human-readable scenario name. */
  name: string;

  /** Description of what the scenario exercises. */
  description: string;

  /** Zones in the environment. */
  zones: ZoneDef[];

  /** IoT devices deployed in the environment. */
  devices: DeviceDef[];

  /** Autonomous agents present in the environment. */
  agents: AgentDef[];

  /** Test events to inject in order. */
  events: TestEventDef[];
}

// ---------------------------------------------------------------------------
// Baseline planner assignment
// ---------------------------------------------------------------------------

/** A single agent-to-device task assignment for baseline planners. */
export interface AgentTaskAssignment {
  /** The agent assigned to the task. */
  agentId: string;

  /** The device the agent should use. */
  deviceId: string;

  /** The capability to exercise on the device. */
  capability: string;

  /** Natural-language description of the task. */
  task: string;
}

/**
 * A pre-planned assignment produced by a baseline planner (central,
 * random, or rule-only). Used to compare against the autonomous
 * collaboration approach.
 */
export interface PlannedAssignment {
  /** Agent-to-device task assignments. */
  agentAssignments: AgentTaskAssignment[];

  /** Number of ground-truth goals this assignment is expected to satisfy. */
  expectedGoals: number;

  /** Whether this assignment achieves the theoretical optimum. */
  isOptimal: boolean;
}

// ---------------------------------------------------------------------------
// Classification metrics (precision / recall / F1)
// ---------------------------------------------------------------------------

/** The set of collaboration decision classes for classification metrics. */
export const COLLABORATION_DECISIONS: readonly CollaborationDecision[] = [
  'initiate_ac',
  'handle_independently',
  'defer',
  'ignore',
] as const;

/** Per-class precision, recall, and F1. */
export interface PerClassMetrics {
  className: CollaborationDecision;
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  support: number;
}

/** Binary classification metrics for a single threshold decision. */
export interface BinaryClassificationMetrics {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  support: number;
}

/** Full 4x4 confusion matrix indexed by COLLABORATION_DECISIONS order. */
export type ConfusionMatrix = number[][];

/** Partner selection metrics (only for events requiring collaboration). */
export interface PartnerSelectionMetrics {
  partnerPrecision: number;
  partnerRecall: number;
  partnerF1: number;
  support: number;
}

/** Capability matching metrics. */
export interface CapabilityMatchMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

/** Aggregate classification metrics for a paper experiment iteration. */
export interface ClassificationMetrics {
  perClass: PerClassMetrics[];
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  collaborationTriggerF1: BinaryClassificationMetrics;
  confusionMatrix: ConfusionMatrix;
  partnerSelection: PartnerSelectionMetrics;
  capabilityMatch: CapabilityMatchMetrics;
}

// ---------------------------------------------------------------------------
// Type-wise metrics (V5 Phase 4)
// ---------------------------------------------------------------------------

/**
 * Metrics computed for a single interaction type (A-E).
 * Groups EventResults by their ground-truth AgentEventType and computes
 * per-type quality and decision accuracy.
 */
export interface TypeWiseMetrics {
  /** The interaction type these metrics cover. */
  type: AgentEventType;

  /** Number of (Agent, Event) pairs of this type. */
  support: number;

  /** Fraction of pairs where the agent made the correct decision. */
  decisionAccuracy: number;

  /** Mean zoneTargetingAccuracy for this type. */
  meanZoneTargetingAccuracy: number;

  /** Mean capabilityAppropriateness for this type. */
  meanCapabilityAppropriateness: number;

  /** Mean physicalPlausibility for this type. */
  meanPhysicalPlausibility: number;

  /**
   * Per-decision breakdown: for each CollaborationDecision, how many
   * pairs of this type chose that decision vs the ground truth.
   */
  decisionBreakdown: Record<CollaborationDecision, { predicted: number; correct: number }>;

  /**
   * Binary F1 for the "correct trigger" task within this type:
   * did the agent initiate_ac when it should have (Types B, C, E)
   * vs. did it correctly not initiate for Types A, D.
   */
  triggerF1: number;
}

/**
 * Full set of type-wise metrics, indexed by AgentEventType.
 * Types with zero support are still included with zeroed metrics.
 */
export type TypeWiseMetricsMap = Record<AgentEventType, TypeWiseMetrics>;

/**
 * Cross-scenario aggregated type-wise metrics.
 * Merges multiple TypeWiseMetricsMap results by support-weighted averaging.
 */
export interface AggregatedTypeWiseMetrics {
  /** Per-type metrics merged across scenarios/conditions. */
  byType: TypeWiseMetricsMap;

  /** Number of distinct results that were merged. */
  mergedCount: number;

  /** Total support across all types. */
  totalSupport: number;
}

// ---------------------------------------------------------------------------
// Filter efficiency metrics (Phase 7)
// ---------------------------------------------------------------------------

/**
 * Metrics for the dual-layer filter architecture (Layer 1 rule-based + Layer 2 LLM).
 * Measures how effectively Layer 1 reduces LLM load without sacrificing decision quality.
 */
export interface FilterMetrics {
  /** Total number of events evaluated. */
  totalEvents: number;

  /** Number of events handled entirely by Layer 1 (rule-based, no LLM call). */
  layer1Handled: number;

  /** Fraction of events handled by Layer 1. */
  layer1FilterRate: number;

  /** Number of Layer 1 decisions that were correct. */
  layer1Correct: number;

  /**
   * Layer 1 precision: fraction of Layer 1 decisions that were correct.
   * High precision means Layer 1 reliably makes the right call without LLM.
   */
  layer1Precision: number;

  /**
   * Layer 1 false negative rate: fraction of events that Layer 1 should have
   * escalated to LLM (because the rule-based decision was wrong) but didn't.
   * Lower is better — a high FN rate means Layer 1 is making wrong decisions
   * that the LLM would have caught.
   */
  layer1FalseNegativeRate: number;

  /** Number of events escalated to Layer 2 (LLM). */
  layer2Handled: number;

  /** Number of Layer 2 decisions that were correct. */
  layer2Correct: number;

  /** Layer 2 accuracy: correct decisions among LLM-evaluated events. */
  layer2Accuracy: number;

  /**
   * Token savings compared to an all-LLM baseline.
   * Computed as: 1 - (actualTokens / estimatedAllLlmTokens).
   * The all-LLM estimate assumes every event would cost the same average
   * tokens as the Layer 2 events.
   */
  tokenSavingsRate: number;

  /** Actual total tokens used by the dual-layer approach. */
  actualTokens: number;

  /**
   * Estimated tokens if ALL events had been sent to the LLM.
   * Calculated as: layer2AvgTokensPerEvent * totalEvents.
   */
  estimatedAllLlmTokens: number;
}
