/**
 * Dual-Trigger AC Manager
 *
 * Integrates Layer 1 (event filtering) and Layer 2 (cognitive decision)
 * for autonomous AC (Active Collaboration) triggering.
 *
 * Key Principle: AC is triggered autonomously by the agent, NOT manually defined.
 *
 * Architecture:
 * │                    High-Frequency Events                         │
 * │ LAYER 1: Non-LLM Event Filtering (95% filtered)                 │
 * │  - SpatialTemporalClusterEngine: Grid-based spatial clustering  │
 * │  - SpatialClusterSummarizer: Generate summaries                 │
 * │  - TriggerConditionEvaluator: Rule-based AC need detection      │
 * └────────────────────────────┬────────────────────────────────────┘
 *                              │ ~5% pass to Layer 2
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ LAYER 2: LLM Cognitive Decision                                  │
 * │  - ACNecessityAssessor: Is AC needed?                            │
 * │  - PartnerSelectionNegotiator: Find best partners                │
 * │  - GoalFormulationEngine: Define collaboration goals             │
 * └────────────────────────────┬────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ AUTONOMOUS AC INITIATION                                         │
 * │  - Agent decides to initiate AC                                  │
 * │  - Sends proposals to selected partners                          │
 * │  - No manual workflow definition                                 │
 * └─────────────────────────────────────────────────────────────────┘
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SystemEvent } from '../events/EventManager.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import { ACContextBuilder, createACContextBuilder, type ACDecisionContext } from '../context/ACContextBuilder.js';
import {
  buildAgentCognitionContext,
  enrichAgentDevices,
  environmentDevicesFace,
  type WorldModelZoneSource,
} from '../cognition/context-projection.js';
import { AgentWorldModelStore, WORLD_MODEL_EVENT_RING_CAP, type EnvironmentParamFaceCheckpoint, type WorldModelEvent } from '../cognition/world-model.js';
import { WorkingMemoryStore, type CognitionCheckpoint } from '../cognition/working-memory.js';
import type { WorldModelGoalInput } from '../cognition/world-model-builder.js';
import { MetaCognition, type MetaCognitionCheckpoint } from '../cognition/meta.js';
import { evaluateDecisionEscalation } from '../cognition/capability-boundary.js';
import {
  aggregatedEventToClusterSummary,
  eventSeverityOf,
  eventToClusterSummary as shapeClusterSummary,
  extractSharedEventId,
  isUrgentSystemEvent,
  vagueZoneDescription,
} from './event-cluster-summary.js';

// ============================================================================
// Type Definitions for Event Payloads
// ============================================================================

/**
 * Event payload interface for temperature-related events
 */
interface TemperatureEventPayload {
  temperature?: number;
  threshold?: number;
  breach?: boolean;
  severity?: 'low' | 'medium' | 'high' | 'urgent' | 'critical';
  stateChange?: {
    newValue: number;
  };
  aqi?: number;
  trend?: 'increasing' | 'decreasing' | 'stable';
  location?: { x: number; y: number; z: number };
  coordinates?: { x: number; y: number; z: number };
  metadata?: Record<string, any>;
}

/**
 * Event payload interface for device state updates
 */
interface DeviceStatePayload {
  deviceId?: string;
  deviceType?: string;
  stateChange?: {
    property: string;
    oldValue: any;
    newValue: any;
    unit?: string;
  };
  fullState?: Record<string, any>;
  location?: { x: number; y: number; z: number };
  status?: 'online' | 'offline' | 'error';
}

/**
 * Event payload interface for physics events
 */
interface PhysicsEventPayload {
  parameter: string;
  oldValue: number;
  newValue: number;
  location?: { x: number; y: number; z: number };
  isAnomaly?: boolean;
  rateOfChange?: number;
}

/**
 * Combined event payload type for DualTriggerACManager
 */
type EventPayload = TemperatureEventPayload & DeviceStatePayload & PhysicsEventPayload & Record<string, any>;

// Layer 1 components
import {
  EnhancedEventProcessor,
  type EnhancedEventProcessorConfig,
  type Layer1Result,
} from '../events/EnhancedEventProcessor.js';
import type { RuleContext, AggregatedEvent } from '../events/EventProcessor.js';
import type { SpatialRegion, SpatialClusterSummary, SpatialCluster, TemporalWindow } from '../events/SpatialTemporalClusterEngine.js';
import type { TriggerEvaluationResult } from '../events/TriggerConditionEvaluator.js';

// Layer 2 components
import { ACNecessityAssessor, type AgentContext, type ACNecessityAssessment, type AssessorConfig, type TriageMetrics } from './ACNecessityAssessor.js';
import { InitiatorCoordinator } from './InitiatorCoordinator.js';
import { resolveLockedService, lockedServiceSelection } from './consume-service.js';
import { PartnerSelectionNegotiator, type PartnerSelectionResult, type NegotiatorConfig } from './PartnerSelectionNegotiator.js';
import { GoalFormulationEngine, type GoalFormulationResult, type ACCollaborationConfig, type GoalEngineConfig } from './GoalFormulationEngine.js';

import { createLogger, EventType, EventPriority } from '@active-collaboration/shared';
import { capabilityMatches } from '../utils/capabilityMatching.js';
import type { AgentFlowInvocationOutcome, InvocableFlowOffering } from '../flows/index.js';
import { planIndependentDeviceActions, type PlannerDeviceInfo } from './rule-actuation-planner.js';
import { annotateIndependentActuationNote, applyPrecheckHonestyGate as evaluatePrecheckHonestyGate, type SemanticOfferRule } from './independent-actuation-honesty.js';
import { isZeroIntersectionAudience, extractDeclaredRequiredCapabilities } from './assessor-passthrough.js';
import { runIndependentHandling, runRuleActions, type IndependentHandlingSeam } from './independent-handling.js';
// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for DualTriggerACManager
 */
const logger = createLogger('DualTriggerACManager');

/**
 * FEAT-10: capacity of the self-handled event id set (insertion-ordered,
 * oldest evicted) — a long world session must not grow it unboundedly.
 */
const SELF_HANDLED_EVENT_IDS_CAP = 256;

export interface DualTriggerConfig {
  // Layer 1 configuration
  layer1: Partial<EnhancedEventProcessorConfig>;

  // Layer 2 configuration
  layer2: {
    assessor: Partial<AssessorConfig>;
    negotiator: Partial<NegotiatorConfig>;
    goalEngine: Partial<GoalEngineConfig>;
  };

  // Global settings
  enableLayer1: boolean;
  enableLayer2: boolean;
  autoInitiateAC: boolean; // Automatically initiate AC when Layer 2 decides
  maxConcurrentACs: number;
  maxHistorySize: number; // Maximum number of AC history entries to retain

  // Ablation experiment flags (all default false = all features enabled)
  disableSpatiotemporal?: boolean;   // Skip Layer 1 spatial clustering, all events go directly to Layer 2
  disablePhysicalContext?: boolean;  // Exclude device locations and environment parameters from agent context
  disableACHistory?: boolean;        // Exclude AC history from agent context
  disableEffectPropagation?: boolean; // Exclude effect propagation data (radii, falloff, zone spread) from agent context
  useVagueSpatial?: boolean;         // Replace precise zone IDs with vague descriptions in agent context
  disableServiceDiscovery?: boolean; // Hide partner service information from agent context
  oracleMode?: boolean;              // Inject perfect ground truth information into agent context
  conciseServiceMode?: boolean;      // Filter services to event-zone only, compact descriptions
  smartRulesMode?: boolean;          // Deterministic rules with spatial + service reasoning (no LLM fallback)
  tfidfBaselineMode?: boolean;      // Character n-gram Jaccard similarity for capability matching (no LLM)

  /**
   * Rule-only operation (no LLM configured for this agent). The Layer-2
   * assessor still runs, but every assessment is resolved by deterministic
   * rules (decisionSource 'rule'): preCheck coverage/capability rules first,
   * a capability-gap fallback where preCheck would otherwise need the LLM.
   * 'handle_independently' decisions are ACTED ON via commandExecutor
   * (rule-based event → device-command mapping); AC initiation is skipped
   * (partner negotiation needs an LLM).
   */
  ruleOnly?: boolean;
  /**
   * Wave A2: AC mode for A/B comparison demos.
   * - 'enabled' (default): normal AC behavior.
   * - 'disabled': force every assessment to 'handle_independently'.
   *   No proposals sent, no collaboration initiated. Agents STILL actuate
   *   their own devices — that IS the "without AC" baseline arm.
   * - 'shadow': OBSERVE/RECORD ONLY (T-050). AC decisions are computed and
   *   recorded — an initiate_ac decision is annotated "would have
   *   initiated" and recorded as handle_independently — but NOTHING
   *   executes: no proposals AND no independent device actuation. Shadow
   *   runs never mutate physics, so eval harnesss can diff pre/post runs
   *   safely.
   */
  acMode?: 'enabled' | 'disabled' | 'shadow';
  /**
   * Device command executor used by the rule-only actuation path. Typically
   * bound to the owning agent's executeDeviceCommand. Without it, rule-only
   * decisions are recorded but not actuated.
   */
  commandExecutor?: (
    deviceId: string,
    commandName: string,
    params?: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string } | unknown>;
  /**
   * Mechanism B (agent-invocable flows): the governed flow-invocation lane.
   * A handle_independently decision carrying invokeFlow {flowId, params}
   * executes through this seam (EngineRuntime binds it to the flow
   * engine's runAsAgent — flag gate, T-201 same-tenant gate, the inputs
   * oracle, triggerKind 'agent' ledger attribution). Without it, a named
   * flow is refused ON THE RECORD and the deterministic device commands
   * still run (honest degradation to today's behavior).
   */
  flowInvoker?: (
    flowId: string,
    params?: Record<string, unknown>,
  ) => Promise<AgentFlowInvocationOutcome>;
  /**
   * T-204: actuate the agent's own devices on 'handle_independently'
   * decisions in ANY mode (previously rule-only only), so LLM-mode agents
   * act instead of just advising. Default ON for simulations; eval
   * harnesses can disable it (decision-only runs). Skipped automatically
   * when autoInitiateAC is false or no commandExecutor is wired.
   *
   * T-050: this is now a scenario/sim-level option — resolved at runtime
   * construction as EngineRuntimeOptions.autoActuateIndependent (operator)
   * > ScenarioAgent.decisionPolicy.autoActuateIndependent (author) >
   * default true (previous behavior).
   */
  autoActuateIndependent?: boolean;
  adjacentZoneIds?: string[];        // Zones adjacent to agent's managed zones (for zone-coverage preCheck)
  actuatorZoneIds?: string[];        // Zones where agent has actuator/hybrid devices (for coverage distinction)
  // BUG-01: the MERGED semantic-offer table (built-in ∪ scenario rules —
  // the signing/invoke gates' source), injected by shaping/agents.ts; the
  // planner resolves aggregate-type requirements through a rule's actuates
  // backing. Absent → the planner's built-in table applies.
  semanticOfferRules?: readonly SemanticOfferRule[];

  /**
   * R43-B/lever-b (training loop v5 §9.5): precheck Type-A pass-through
   * policy — a controlled fraction of Type-A events (direct coverage × no
   * gap, GT handle_independently) skips the deterministic short-circuit and
   * runs the normal LLM decision path instead, producing real GT-A×LLM
   * handle samples for the v5.x training loop. Resolved from
   * ScenarioAgent.decisionPolicy.precheckPassThrough (agent-level author
   * config); absent/'off' = current behavior. Data-production tool — see
   * AgentContext.precheckPassThrough for the full contract.
   */
  precheckPassThrough?: {
    mode: 'off' | 'sample' | 'all';
    rate?: number;
  };

  /**
   * R45-P1 (F4): dispatcher role — 'coordinator' agents (municipal centers
   * with representative bound devices) are never Type-A short-circuited;
   * the LLM lane decides (cross-zone dispatch stays possible). Resolved
   * from ScenarioAgent.decisionPolicy.role; absent = executor (default).
   */
  decisionRole?: 'coordinator';

  /**
   * Oracle data provider callback. When oracleMode is true, this function
   * is called with the event ID to retrieve perfect ground-truth insight
   * for the current (Agent, Event) pair. Returns undefined when no oracle
   * data is available.
   */
  oracleDataProvider?: (eventId: string) => {
    coverage: number;
    coverageDescription: string;
    gapCapabilities: string[];
    matchedCapabilities: string[];
    interactionType: string;
    correctDecision: string;
    idealPartners: Array<{ agentId: string; capabilities: string[]; zoneId: string }>;
    eventZoneId: string;
  } | undefined;
}

// Vague zone descriptions + the event→cluster-summary shaping moved to
// event-cluster-summary.ts (R38-P2 file-budget ratchet; verbatim behavior).

const DEFAULT_CONFIG: DualTriggerConfig = {
  layer1: {
    enableSpatialClustering: true,
    enableDualTrigger: true,
    clusterEngine: {
      minEventsPerCluster: 1, // Allow single events to trigger AC
    },
    evaluator: {
      evaluateWithLLMScore: 5, // Lower threshold to allow single events to trigger Layer 2
    },
  },
  layer2: {
    assessor: {},
    negotiator: {},
    goalEngine: {},
  },
  enableLayer1: true,
  enableLayer2: true,
  autoInitiateAC: true,
  maxConcurrentACs: 5,
  maxHistorySize: 20,
};

/**
 * Result of dual-trigger processing
 */
export interface DualTriggerResult {
  // Processing path
  path: 'filtered_layer1' | 'deferred' | 'handled_independently' | 'ac_initiated';

  // Layer 1 result (if applicable)
  layer1Result?: Layer1Result;

  // Layer 2 result (if applicable)
  layer2Result?: {
    assessment: ACNecessityAssessment;
    partnerSelection?: PartnerSelectionResult;
    goalFormulation?: GoalFormulationResult;
  };

  // AC config (if AC was initiated)
  acConfig?: ACCollaborationConfig;

  // Statistics
  stats: {
    processingTime: number;
    layerUsed: 1 | 2;
    eventsFiltered: number;
  };
}

/**
 * Callback when AC is autonomously initiated
 */
export type ACInitiationCallback = (config: ACCollaborationConfig, result: DualTriggerResult) => Promise<void>;

// ============================================================================
// Helper Functions for Type-Safe Object Creation
// ============================================================================

/** Fallback region for urgent events whose summary carries none. */
function createUrgentRegion(): SpatialRegion {
  return {
    id: 'urgent-region',
    center: { x: 0, y: 0 },
    radius: 0,
    type: 'zone',
  };
}

/**
 * Create a minimal Layer1Result for urgent events that bypass Layer 1
 */
function createUrgentLayer1Result(
  summary: SpatialClusterSummary,
  startTime: number
): Layer1Result {
  const now = new Date();
  const cluster: SpatialCluster = {
    id: `urgent-${Date.now()}`,
    // Use the summary's REAL region (the event's zone id, shaped by
    // event-cluster-summary) — the synthetic 'urgent-region' sentinel must
    // never leak into trigger faces (AC proposals / agreement terms carry
    // this id as the trigger zone; 'urgent-region' matches no env zone and
    // poisons same-zone preference + cross-zone labeling downstream).
    region: summary.region ?? createUrgentRegion(),
    temporalWindow: {
      start: new Date(startTime),
      end: now,
      duration: now.getTime() - startTime,
    },
    events: [],
    statistics: {
      eventCount: 1,
      eventTypes: new Map(),
      significanceScore: 90,
      trend: 'increasing',
    },
    patterns: [],
    significance: 'high',
    requiresLLMEvaluation: true,
  };

  const evaluation: TriggerEvaluationResult = {
    needsEvaluation: true,
    urgency: 'high',
    matchedTriggers: [],
    reasoning: 'Urgent event bypassed Layer 1',
    recommendation: 'immediate_action',
  };

  return {
    cluster,
    summary,
    evaluation,
    needsLayer2: true,
  };
}

// ============================================================================
// DualTriggerACManager
// ============================================================================

// Type definitions for external dependencies
interface Device {
  id: string;
  name: string;
  type: string;
  capabilities: string[] | Array<{ name: string; type: string }>;
  location: string | { path: string; position?: { x: number; y: number; z: number } };
  status: 'online' | 'offline' | 'error' | 'maintenance';
}

interface DeviceWithState extends Device {
  state?: Record<string, any>;
}

/** Device info the agent reports to the AC manager (agent-internal resource; the planner's device shape). */
type AgentDeviceInfo = PlannerDeviceInfo;

interface ResourceManager {
  getResource(deviceId: string): { getState(): Record<string, any>; getLocation(): { x: number; y: number; z: number } | undefined; isAvailable(): boolean } | undefined;
}

interface ServiceRegistry {
  getOwnServices(): Array<{ name: string; capabilities: string[]; status: string }>;
}

export class DualTriggerACManager {
  private config: DualTriggerConfig;
  private agentId: string;
  private agentName: string;
  private agentCapabilities: string[];
  private llmClient: LLMClient;
  private environment: EnvironmentCenter;

  // External dependencies - these should be injected via constructor
  private resourceManager?: ResourceManager;
  private serviceRegistry?: ServiceRegistry;

  // Layer 1 components
  private layer1Processor: EnhancedEventProcessor | null = null;

  // Layer 2 components
  private acNecessityAssessor: ACNecessityAssessor | null = null;
  private partnerNegotiator: PartnerSelectionNegotiator | null = null;
  private goalEngine: GoalFormulationEngine | null = null;

  // Callbacks
  private onACInitiation: ACInitiationCallback;

  // Statistics
  private stats = {
    totalEventsProcessed: 0,
    filteredByLayer1: 0,
    passedToLayer2: 0,
    acDecisionMade: 0,  // AC triggering decision made (initiate_ac)
    acInitiated: 0,     // AC successfully initiated with partners
    handledIndependently: 0,
    deferred: 0,
    // FEAT-09 (dorm-life D8): events whose audience check short-circuited
    // the initiate evaluation (zero capability intersection — observe-only).
    observeOnly: 0,

    // Enhanced statistics for paper experiments
    layer2DecisionDistribution: {
      initiate_ac: 0,
      handle_independently: 0,
      defer: 0,
      ignore: 0,
    } as Record<string, number>,
    totalAssessmentTimeMs: 0,
    assessmentCount: 0,
    totalConfidence: 0,
    confidenceCount: 0,
  };

  // Assessment callback for external monitoring
  private assessmentCallback?: (assessment: ACNecessityAssessment, event: SystemEvent) => void;

  /**
   * Optional runtime-wide coordinator that dedupes competing initiations
   * across agents managing the same zone. Set by EngineRuntime after the
   * CognitiveAgent is constructed. When set, this manager will call
   * `tryClaim` before committing to `initiate_ac` — losing the race
   * demotes the decision to `defer`.
   */
  private initiatorCoordinator?: InitiatorCoordinator;

  /**
   * FEAT-10 (dorm-life D11): shared event ids this agent already HANDLED
   * independently with real device commands dispatched. Bounded insertion-
   * ordered set (oldest evicted at capacity). The responder lane reads it
   * via hasSelfHandledEvent to reject proposals that would double-actuate
   * the same devices — robust to claim races (an earlier initiator holding
   * the coordinator claim does not erase the fact that this agent already
   * actuated on the event).
   */
  private readonly selfHandledEventIds = new Set<string>();

  // Current AC sessions
  private activeACs: Map<string, ACCollaborationConfig> = new Map();

  // AC outcome history for feedback (past collaboration results)
  private acHistory: Array<{
    collaborationId: string;
    partners: string[];
    outcome: 'success' | 'partial' | 'failure';
    goalsTotal: number;
    goalsAchieved: number;
    completedAt: Date;
  }> = [];

  // Agent-assigned devices (devices the agent can actually use)
  // CRITICAL: These are the agent's internal resources, NOT visible to other agents
  // Provided by the agent via setAgentDevices()
  private agentDevices: AgentDeviceInfo[] = [];

  // Mechanism B: the invocable-flows listing provider (set post-construction
  // by the runtime — see setInvocableFlowsProvider).
  private invocableFlowsProvider?: () => InvocableFlowOffering[];

  // Phase 2 (cognition): live zone face provider (EngineRuntime wires it),
  // the bounded event ring feeding the world model, per-round working memory,
  // and the owner-assigned goal stack / scope-of-practice (CognitiveAgent).
  private worldModelProvider?: () => WorldModelZoneSource | undefined;
  private readonly cognitionEvents = new AgentWorldModelStore();
  private readonly workingMemory = new WorkingMemoryStore();
  private agentGoals: readonly WorldModelGoalInput[] = [];
  private scopeOfPractice?: string[];

  // Phase 5 (cognition §7): OPTIONAL meta-cognition (self-assessment,
  // capability boundary, partner trust, adaptive behavior). Absent → the
  // decision pipeline and prompt stay byte-identical (additive layer).
  private metaCognition?: MetaCognition;

  // R40-C3: the agent's world-model parameter-face store (CognitiveAgent
  // wires its own in) — checkpointed so resumed legacy projections do not
  // start from zero. Absent → no parameter face rides the checkpoint.
  private environmentParamFaceStore?: AgentWorldModelStore;

  // Feedback loop subscription ID
  private feedbackSubscriptionId: string | null = null;

  constructor(
    agentId: string,
    agentName: string,
    agentCapabilities: string[],
    llmClient: LLMClient,
    environment: EnvironmentCenter,
    onACInitiation: ACInitiationCallback,
    config: Partial<DualTriggerConfig> = {}
  ) {
    this.agentId = agentId;
    this.agentName = agentName;
    this.agentCapabilities = agentCapabilities;
    this.llmClient = llmClient;
    this.environment = environment;
    this.onACInitiation = onACInitiation;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Log ablation flags if any are active
    if (this.config.disableSpatiotemporal || this.config.disablePhysicalContext || this.config.disableACHistory || this.config.disableEffectPropagation) {
      logger.info(`[DualTriggerACManager:${this.agentId}] Ablation flags active:`, {
        disableSpatiotemporal: this.config.disableSpatiotemporal,
        disablePhysicalContext: this.config.disablePhysicalContext,
        disableACHistory: this.config.disableACHistory,
        disableEffectPropagation: this.config.disableEffectPropagation,
      });
    }

    this.initializeComponents();

    logger.info(`Initialized for agent ${agentName}`, {
      layer1Enabled: this.config.enableLayer1,
      layer2Enabled: this.config.enableLayer2,
      autoInitiate: this.config.autoInitiateAC,
    });
  }

  /** Agent-assigned devices (readonly; set via setAgentDevices). */
  getAgentDevices(): ReadonlyArray<AgentDeviceInfo> {
    return this.agentDevices;
  }

  /**
   * Set agent-assigned devices — what the agent can actually use (assigned
   * via CognitiveAgent.assignDevices()). CRITICAL: internal resources, NOT
   * visible to other agents (others see Services only); GoalFormulationEngine
   * reads this to identify target devices for AC execution.
   */
  setAgentDevices(devices: AgentDeviceInfo[]): void {
    this.agentDevices = devices;
    logger.info(`Agent devices updated: ${devices.length} devices`);
    if (devices.length > 0) {
      logger.info(`Device IDs: ${devices.map(d => d.deviceId).join(', ')}`);
    }
  }

  /**
   * Mechanism B: the invocable-flows listing provider — exactly what the
   * prompt may offer (re-read per decision; absent → no offerings).
   */
  setInvocableFlowsProvider(provider: () => InvocableFlowOffering[]): void {
    this.invocableFlowsProvider = provider;
  }

  /**
   * Phase 2 (cognition): live zone-source provider (sim clock + visible
   * zones), bound by EngineRuntime; absent → world model without zones.
   */
  setWorldModelProvider(provider: () => WorldModelZoneSource | undefined): void {
    this.worldModelProvider = provider;
  }

  /**
   * Phase 2 (cognition): owner-assigned goal stack inputs (projected from
   * AgentProfile.primaryGoals) + scope-of-practice (T-036 cannotDeliver).
   */
  setAgentGoals(goals: readonly WorldModelGoalInput[], scopeOfPractice?: string[]): void {
    this.agentGoals = goals;
    this.scopeOfPractice = scopeOfPractice;
  }

  /** Phase 5 (cognition §7): inject the agent's meta-cognition state. */
  setMetaCognition(meta: MetaCognition): void {
    this.metaCognition = meta;
  }

  /** R40-C3: bind the agent's parameter-face store (same assembly pattern as setMetaCognition). */
  setEnvironmentParamFaceStore(store: AgentWorldModelStore): void {
    this.environmentParamFaceStore = store;
  }

  /** R40-A2：暴露 meta-cognition 给运行时声誉桥（negotiator setReputationTracker 同款装配模式）。 */
  getMetaCognition(): MetaCognition | undefined {
    return this.metaCognition;
  }

  /**
   * Phase 2 (cognition): the checkpoint face — bounded event ring + last
   * cognitive decision (world-state export/restore; record-replay parity).
   * Phase 5: + the meta-cognition state (quality ring + partner trust) so a
   * resumed run's META_COGNITION prompt section matches the recorded run.
   * R40-C3: + the parameter face (observed `location:parameter` keys) so
   * resumed legacy environment projections do not start from zero; the
   * capture's sim time stamps every entry (the store has no sim seam).
   * R40-C2: + the working-memory diff baseline (previous round's zone face)
   * so a resumed run's first CHANGES_SINCE_LAST_ROUND matches the recorded
   * run's prompt instead of claiming "initial perception".
   */
  getCognitionCheckpoint(): CognitionCheckpoint {
    return {
      events: this.cognitionEvents.recentEvents(WORLD_MODEL_EVENT_RING_CAP),
      lastDecision: this.workingMemory.peekLastDecision() ?? null,
      metaCognition: this.metaCognition?.checkpoint() ?? null,
      ...(this.environmentParamFaceStore === undefined ? {} : {
        environmentParams: this.environmentParamFaceStore.exportParameterFace(
          this.worldModelProvider?.()?.simTimeSec ?? 0,
        ),
      }),
      ...(this.workingMemory.peekPreviousZoneFace() !== undefined ? {
        previousZoneFace: this.workingMemory.peekPreviousZoneFace(),
      } : {}),
    };
  }

  /** Adopt a checkpointed cognition state (resumed runs). */
  restoreCognitionCheckpoint(checkpoint: CognitionCheckpoint): void {
    this.cognitionEvents.clear();
    for (const event of checkpoint.events) {
      this.cognitionEvents.recordEvent(event);
    }
    this.workingMemory.restoreDecision(checkpoint.lastDecision ?? undefined);
    this.metaCognition?.restore(checkpoint.metaCognition ?? undefined);
    // R40-C3: absent face (pre-C3 checkpoint) → honest no-op, empty start.
    this.environmentParamFaceStore?.restoreParameterFace(checkpoint.environmentParams);
    // R40-C2: absent face (pre-C2 checkpoint) → first resumed round diff
    // falls back to "initial perception" (honest, matches the era's prompt).
    this.workingMemory.restorePreviousZoneFace(checkpoint.previousZoneFace);
  }

  /**
   * Mechanism B: the governed invocation seam — the runtime binds it to
   * FlowEngine.runAsAgent post-construction (the config-level flowInvoker
   * field is the equivalent seam for embedders with a lane already in hand).
   */
  setAgentFlowInvoker(invoke: NonNullable<DualTriggerConfig['flowInvoker']>): void {
    this.config.flowInvoker = invoke;
  }

  /** Initialize Layer 1 and Layer 2 components. */
  private initializeComponents(): void {
    // Initialize Layer 1
    if (this.config.enableLayer1) {
      const context: RuleContext = {
        agentId: this.agentId,
        agentCapabilities: this.agentCapabilities,
        deviceStates: new Map(),
        recentEvents: [],
        thresholds: new Map(),
      };

      this.layer1Processor = new EnhancedEventProcessor(
        this.config.layer1,
        context,
        async (layer1Result: Layer1Result) => {
          await this.processLayer2Decision(layer1Result);
        },
        async (event: AggregatedEvent) => {
          // Fallback for simple aggregation mode
          await this.processSimpleEvent(event);
        }
      );

      logger.info('Layer 1 components initialized');
    }

    // Initialize Layer 2. Rule-only mode keeps the assessor (decisions are
    // resolved by deterministic rules, never by the LLM) but skips the
    // LLM-backed negotiation/goal components.
    if (this.config.enableLayer2 || this.config.ruleOnly) {
      this.acNecessityAssessor = new ACNecessityAssessor(
        this.config.layer2.assessor,
        this.config.ruleOnly ? undefined : this.llmClient
      );

      if (!this.config.ruleOnly) {
        this.partnerNegotiator = new PartnerSelectionNegotiator(
          this.config.layer2.negotiator,
          this.environment,
          this.llmClient
        );

        this.goalEngine = new GoalFormulationEngine(
          this.config.layer2.goalEngine,
          this.environment,
          this.llmClient
        );
      }

      logger.info('Layer 2 components initialized', { ruleOnly: this.config.ruleOnly ?? false });
    }
  }

  /**
   * Process an incoming event through the dual-trigger pipeline
   */
  /** R91 感知通路：连续感知只走 L1 规则（确定性无 LLM）——L2 评估器的墙钟重试会破坏 lazy/record-replay 的位精确不变量。 */
  perceiveEvent(event: SystemEvent): void {
    this.stats.totalEventsProcessed++;
    this.digestEventForWorldModel(event);
    if (this.layer1Processor) this.layer1Processor.processEvent(event);
  }

  async processEvent(event: SystemEvent): Promise<DualTriggerResult> {
    const startTime = Date.now();
    this.stats.totalEventsProcessed++;
    this.digestEventForWorldModel(event);

    // Auto-start feedback listening on first event processing
    if (!this.feedbackSubscriptionId) {
      this.startFeedbackListening();
    }

    logger.info(`[DualTriggerACManager:${this.agentId}] Processing event: ${event.type} from ${event.source}`);

    // Check if at max concurrent ACs
    if (this.activeACs.size >= this.config.maxConcurrentACs) {
      this.stats.deferred++;
      logger.info(`[DualTriggerACManager:${this.agentId}] At max concurrent ACs, deferring`);
      return {
        path: 'deferred',
        stats: {
          processingTime: Date.now() - startTime,
          layerUsed: 1,
          eventsFiltered: 1,
        },
      };
    }

    // Check if event is urgent - bypass Layer 1 for urgent events
    const isUrgent = isUrgentSystemEvent(
      event,
      (message, meta) => logger.info(`[DualTriggerACManager:${this.agentId}] ${message}`, meta as object | undefined),
    );
    if (isUrgent && this.acNecessityAssessor) {
      logger.info(`[DualTriggerACManager:${this.agentId}] Urgent event detected, bypassing Layer 1`);
      const agentContext = await this.buildAgentContext();
      const clusterSummary = this.eventToClusterSummary(event);
      this.injectOracleInsight(agentContext, event.id);

      // FEAT-09: zero-intersection audiences observe only (no assessment, no record).
      if (this.isObserveOnlyAudience(clusterSummary, agentContext)) {
        return this.observeOnlyResult(startTime);
      }

      const assessment = await this.acNecessityAssessor.assess(clusterSummary, agentContext);

      return this.processAssessmentResult(assessment, startTime, event);
    }

    // Ablation: Skip Layer 1 (spatiotemporal clustering) if disabled
    if (this.config.disableSpatiotemporal && this.acNecessityAssessor) {
      logger.info(`[DualTriggerACManager:${this.agentId}] Spatiotemporal disabled (ablation), processing directly through Layer 2`);
      const agentContext = await this.buildAgentContext();
      const clusterSummary = this.eventToClusterSummary(event);
      this.injectOracleInsight(agentContext, event.id);

      // FEAT-09: zero-intersection audiences observe only (no assessment, no record).
      if (this.isObserveOnlyAudience(clusterSummary, agentContext)) {
        return this.observeOnlyResult(startTime);
      }

      const assessment = await this.acNecessityAssessor.assess(clusterSummary, agentContext);
      return this.processAssessmentResult(assessment, startTime, event);
    }

    // Process through Layer 1
    if (this.layer1Processor) {
      this.layer1Processor.processEvent(event);

      // Layer 1 will call processLayer2Decision if needed
      // For now, return a placeholder (actual result comes via callback)
      return {
        path: 'filtered_layer1',
        stats: {
          processingTime: Date.now() - startTime,
          layerUsed: 1,
          eventsFiltered: 1,
        },
      };
    }

    // No Layer 1 - process directly with Layer 2
    if (this.acNecessityAssessor) {
      const agentContext = await this.buildAgentContext();
      const clusterSummary = this.eventToClusterSummary(event);
      this.injectOracleInsight(agentContext, event.id);

      // FEAT-09: zero-intersection audiences observe only (no assessment, no record).
      if (this.isObserveOnlyAudience(clusterSummary, agentContext)) {
        return this.observeOnlyResult(startTime);
      }

      const assessment = await this.acNecessityAssessor.assess(clusterSummary, agentContext);

      return this.processAssessmentResult(assessment, startTime, event);
    }

    // No processing available
    return {
      path: 'deferred',
      stats: {
        processingTime: Date.now() - startTime,
        layerUsed: 1,
        eventsFiltered: 0,
      },
    };
  }

  /** Inject oracle insight (oracleMode ground truth) into the agent context. */
  private injectOracleInsight(agentContext: AgentContext, eventId: string): void {
    if (!this.config.oracleMode || !this.config.oracleDataProvider) return;

    const oracleInsight = this.config.oracleDataProvider(eventId);
    if (oracleInsight) {
      agentContext.oracleInsight = oracleInsight;
      logger.info(`[DualTriggerACManager:${this.agentId}] Oracle insight injected for event ${eventId}: coverage=${oracleInsight.coverage}, type=${oracleInsight.interactionType}`);
    }
  }

  /** Process the Layer 2 decision after Layer 1 filtering. */
  private async processLayer2Decision(layer1Result: Layer1Result): Promise<void> {
    logger.info(`Processing Layer 2 decision for cluster ${layer1Result.cluster.id}`);

    if (!this.acNecessityAssessor) {
      logger.warn('Layer 2 not available');
      return;
    }

    this.stats.passedToLayer2++;

    try {
      // Build agent context
      const agentContext = await this.buildAgentContext();
      const layer2StartTime = Date.now();

      // CRITICAL: Override summary fields to match what eventToClusterSummary()
      // would produce in the direct Layer 2 path. The SpatialClusterSummarizer
      // generates different recommendation and significance values based on
      // cluster statistics, which may not reflect the actual event severity.
      // This mismatch causes incorrect preCheck decisions in ACNecessityAssessor.
      const adjustedSummary = { ...layer1Result.summary };
      if (layer1Result.evaluation.needsEvaluation && layer1Result.cluster.events.length > 0) {
        const originalEvent = layer1Result.cluster.events[0];
        const payload: EventPayload = originalEvent.payload || {};
        const isUrgent = payload.severity === 'high' || payload.severity === 'urgent'
          || payload.severity === 'critical' || payload.breach === true;

        // Override recommendation from event severity (matches eventToClusterSummary)
        adjustedSummary.recommendation = isUrgent ? 'immediate_action' : 'evaluate_with_llm';

        // Override significance from event severity (matches eventToClusterSummary)
        adjustedSummary.significance = isUrgent ? 'high' : 'medium';

        // T-203: the summarizer's generic cluster text also drops the
        // original event type/parameter/value — prepend the same context
        // eventToClusterSummary now emits so the LLM prompt stays
        // parameter-aware on the clustered path too.
        const originType = typeof payload.eventType === 'string' ? payload.eventType : originalEvent.type;
        const contextParts = [`Event ${originType} from ${originalEvent.source}`];
        if (payload.parameter !== undefined) contextParts.push(`parameter=${String(payload.parameter)}`);
        if (payload.newValue !== undefined) contextParts.push(`newValue=${String(payload.newValue)}`);
        if (payload.severity !== undefined) contextParts.push(`severity=${String(payload.severity)}`);
        adjustedSummary.summary = `${contextParts.join(', ')}; cluster: ${adjustedSummary.summary}`;
      }

      // Step 1: Assess AC necessity using LLM
      // FEAT-09: zero-intersection audiences observe only (no assessment, no record).
      if (this.isObserveOnlyAudience(adjustedSummary, agentContext)) {
        return;
      }

      const assessment = await this.acNecessityAssessor.assess(
        adjustedSummary,
        agentContext
      );

      logger.info(`Assessment result:`, {
        decision: assessment.decision,
        needsCollaboration: assessment.llmAssessment.needsCollaboration,
        confidence: assessment.llmAssessment.confidence.toFixed(2),
      });

      // BUG-01 honesty gate BEFORE the distribution tally (clustered path).
      this.applyPrecheckHonestyGate(assessment);

      // Track decision distribution, timing, and confidence
      const decisionKey = assessment.decision || 'ignore';
      this.stats.layer2DecisionDistribution[decisionKey] = (this.stats.layer2DecisionDistribution[decisionKey] || 0) + 1;
      this.stats.totalAssessmentTimeMs += Date.now() - layer2StartTime;
      this.stats.assessmentCount++;
      if (assessment.llmAssessment?.confidence !== undefined) {
        this.stats.totalConfidence += assessment.llmAssessment.confidence;
        this.stats.confidenceCount++;
      }

      // Make a no-op "handle_independently" visible BEFORE the decision is
      // recorded: the campus pilot showed precheck decisions claiming
      // "direct actuator coverage, handling independently" with null
      // commands and no hint that nothing would ever actuate.
      this.annotateIndependentActuation(assessment);
      // R40-A3：先评估升级再落账（升级 = 执行阻断，quality tracker 不记假成功）。
      // R45-P0：以 cluster 代表事件的**真实 severity** 为 risk 的权威档位。
      evaluateDecisionEscalation(assessment, eventSeverityOf(layer1Result.cluster.events[0]));
      this.noteCognitiveDecision(assessment);

      // Notify assessment callback (used by experiments to track decisions)
      if (this.assessmentCallback) {
        const originalEvent = layer1Result.cluster.events.length > 0
          ? layer1Result.cluster.events[0]
          : undefined;
        if (originalEvent) {
          try {
            this.assessmentCallback(assessment, originalEvent);
          } catch (err) {
            logger.error(`[DualTriggerACManager:${this.agentId}] Assessment callback error:`, err);
          }
        }
      }

      // R40-A3：升级 = 只通知不执行（决策与事件已在 callback 落账）。
      if (this.escalatedOnly(assessment)) return;

      // Step 2: Handle based on assessment decision
      if (assessment.decision === 'initiate_ac') {
        // Track AC decision made (regardless of partner availability)
        this.stats.acDecisionMade++;

        // When autoInitiateAC is false, record the decision but skip execution.
        // This is used by decisionOnly mode to capture LLM decision metrics
        // without the expensive physics simulation.
        if (!this.config.autoInitiateAC) {
          logger.info(`[DualTriggerACManager:${this.agentId}] AC decision: initiate_ac — but autoInitiateAC is false, skipping execution`);
        } else {
          await this.initiateAC(assessment, layer1Result);
        }
      } else if (assessment.decision === 'handle_independently') {
        this.stats.handledIndependently++;
        logger.info('Agent will handle independently');
        // Mechanism B: a named invocable flow IS the handling when honored;
        // then the Phase-1 cognitive deviceActions lane; a refusal of both
        // degrades to the deterministic device commands.
        const dispatched = await this.executeIndependentHandling(assessment);
        // FEAT-10: a REAL self-handling (commands dispatched) registers the
        // event claim — later initiators for the same event defer.
        this.claimSelfHandledEvent(layer1Result.cluster.events[0], dispatched);
      } else if (assessment.decision === 'defer') {
        this.stats.deferred++;
        logger.info(`Decision deferred`);
      } else {
        this.stats.filteredByLayer1++;
        logger.info(`Event ignored`);
      }
    } catch (error) {
      logger.error('Error in Layer 2 processing:', error);
    }
  }

  /** R6-E-F07: consume_service (serviceTarget) locks selection to the target provider (unresolvable → null = recorded defer); else open negotiation with Phase-7 relaxation retry. */
  private async selectPartnersFor(assessment: ACNecessityAssessment): Promise<PartnerSelectionResult | null> {
    const serviceTarget = assessment.cognitiveDecision?.actionPlan.primary.serviceTarget;
    if (serviceTarget !== undefined) {
      const resolved = resolveLockedService(this.environment, this.agentId, serviceTarget);
      if (resolved === null) {
        logger.warn(`[DualTriggerACManager:${this.agentId}] consume_service target not resolvable (serviceId=${serviceTarget.serviceId ?? '-'}, serviceName=${serviceTarget.serviceName ?? '-'}) — deferring`);
        return null;
      }
      logger.info(`[DualTriggerACManager:${this.agentId}] consume_service locked to ${resolved.serviceName} (${resolved.serviceId}) of ${resolved.providerAgentName}`);
      return lockedServiceSelection(this.agentId, this.agentName, resolved, serviceTarget.terms);
    }
    return this.partnerNegotiator!.findPartnersWithRelaxation(assessment);
  }

  /**
   * Initiate AC based on assessment
   */
  private async initiateAC(
    assessment: ACNecessityAssessment,
    layer1Result: Layer1Result
  ): Promise<void> {
    logger.info(`Initiating AC for: ${assessment.llmAssessment.reasoning}`);

    if (!this.partnerNegotiator || !this.goalEngine) {
      if (this.config.ruleOnly) {
        logger.info(`[DualTriggerACManager:${this.agentId}] Rule-only: AC initiation skipped (partner negotiation requires an LLM)`);
      } else {
        logger.error('Layer 2 components not available for AC initiation');
      }
      return;
    }

    try {
      // Step 2: Find partners (R6-E-F07: a consume_service decision locks the
      // target service's provider instead of open matchmaking — see selectPartnersFor).
      const partnerSelection = await this.selectPartnersFor(assessment);

      if (partnerSelection === null || partnerSelection.selectedPartners.length === 0) {
        logger.warn('No partners found for AC (even after capability relaxation)');
        this.stats.deferred++;
        return;
      }

      logger.info(`Found ${partnerSelection.selectedPartners.length} partners:`,
        partnerSelection.selectedPartners.map(p => p.agentName));

      // Step 3: Formulate goals
      const goalFormulation = await this.goalEngine.formulateGoals(
        assessment,
        partnerSelection,
        this.environment
      );

      logger.info(`Goals formulated:`, {
        complexity: goalFormulation.estimatedComplexity,
        primaryGoal: goalFormulation.primaryGoal.name,
        subGoals: goalFormulation.subGoals.length,
        risks: goalFormulation.risks.length,
      });

      // Step 4: Create AC config
      const acConfig = goalFormulation.config;

      // Store active AC
      this.activeACs.set(acConfig.id, acConfig);

      // Step 5: Notify via callback
      this.stats.acInitiated++;

      const result: DualTriggerResult = {
        path: 'ac_initiated',
        layer1Result,
        layer2Result: {
          assessment,
          partnerSelection,
          goalFormulation,
        },
        acConfig,
        stats: {
          processingTime: Date.now() - assessment.timestamp.getTime(),
          layerUsed: 2,
          eventsFiltered: 0,
        },
      };

      await this.onACInitiation(acConfig, result);

      logger.info(`AC ${acConfig.id} initiated autonomously`);
    } catch (error) {
      logger.error('Error initiating AC:', error);
    }
  }

  /**
   * Process simple event (fallback mode)
   */
  private async processSimpleEvent(event: AggregatedEvent): Promise<void> {
    logger.info(`Processing simple event: ${event.eventType}`);
    this.stats.passedToLayer2++;

    if (!this.acNecessityAssessor) {
      return;
    }

    const agentContext = await this.buildAgentContext();
    const clusterSummary = aggregatedEventToClusterSummary(event);

    // FEAT-09: zero-intersection audiences observe only (no assessment, no record).
    if (this.isObserveOnlyAudience(clusterSummary, agentContext)) {
      return;
    }

    const assessment = await this.acNecessityAssessor.assess(clusterSummary, agentContext);

    // BUG-01 honesty gate (simple path, same rule).
    this.applyPrecheckHonestyGate(assessment);

    if (assessment.decision === 'initiate_ac') {
      // Need to create a minimal Layer1Result
      const layer1Result: Layer1Result = {
        cluster: {
          id: `simple-${Date.now()}`,
          region: clusterSummary.region,
          temporalWindow: {
            start: event.firstOccurrence,
            end: event.lastOccurrence,
            duration: event.lastOccurrence.getTime() - event.firstOccurrence.getTime(),
          },
          events: [],
          statistics: {
            eventCount: event.count,
            eventTypes: new Map([[event.eventType, event.count]]),
            significanceScore: 50,
            trend: 'stable',
          },
          patterns: [],
          significance: 'medium',
          requiresLLMEvaluation: true,
        },
        summary: clusterSummary,
        evaluation: {
          needsEvaluation: true,
          urgency: 'medium',
          matchedTriggers: [],
          reasoning: 'Passed through simple aggregation',
          recommendation: 'evaluate_with_llm',
        },
        needsLayer2: true,
      };

      if (!this.config.autoInitiateAC) {
        logger.info(`[DualTriggerACManager:${this.agentId}] AC decision: initiate_ac (simple) — but autoInitiateAC is false, skipping execution`);
      } else {
        await this.initiateAC(assessment, layer1Result);
      }
    }
  }

  /**
   * Process assessment result and return DualTriggerResult
   */
  private async processAssessmentResult(
    assessment: ACNecessityAssessment,
    startTime: number,
    event?: SystemEvent
  ): Promise<DualTriggerResult> {
    logger.info(`[DualTriggerACManager:${this.agentId}] Assessment result: decision=${assessment.decision}`);
    logger.info(`[DualTriggerACManager:${this.agentId}] Assessment reasoning: ${assessment.llmAssessment?.reasoning || 'N/A'}`);
    logger.info(`[DualTriggerACManager:${this.agentId}] Assessment confidence: ${assessment.llmAssessment?.confidence || 'N/A'}`);

    // BUG-01 honesty gate BEFORE the distribution tally (same as clustered).
    this.applyPrecheckHonestyGate(assessment);

    // ===========================================================
    // Primary-initiator dedup (InitiatorCoordinator) — FEAT-10②:
    // consulted BEFORE the decision is recorded. Pre-fix the tally,
    // noteCognitiveDecision and the assessment callback all ran before
    // tryClaim, so a coordinator-DENIED initiation was recorded as
    // initiate_ac — a handshake that never happened (eval-report then
    // attributed it to no-partner/abandoned). A deny now converts the
    // decision to defer with the deny named on the record; a granted
    // claim rides through to the initiate_ac branch below. The
    // coordinator key is the shared event id (metadata.eventId, falling
    // back to the unsuffixed event.id). acMode disabled/shadow never
    // claims — those modes convert the decision below without executing
    // (T-050 semantics preserved).
    // ===========================================================
    if (
      assessment.decision === 'initiate_ac'
      && (this.config.acMode ?? 'enabled') === 'enabled'
      && this.initiatorCoordinator !== undefined
      && event !== undefined
    ) {
      const sharedEventId = extractSharedEventId(event);
      if (!this.initiatorCoordinator.tryClaim(sharedEventId, this.agentId)) {
        const primary = this.initiatorCoordinator.getPrimaryInitiator(sharedEventId);
        logger.info(
          `[DualTriggerACManager:${this.agentId}] AC initiation deferred for event ${sharedEventId} — primary initiator is ${primary ?? '?'}`,
        );
        assessment.decision = 'defer';
        const denyNote =
          `[initiator-coordinator deny: event ${sharedEventId} is already claimed ` +
          `by primary initiator ${primary ?? '?'} — initiation deferred, recorded as defer]`;
        if (assessment.llmAssessment !== undefined) {
          assessment.llmAssessment.reasoning = assessment.llmAssessment.reasoning
            ? `${assessment.llmAssessment.reasoning} ${denyNote}`
            : denyNote;
        }
      }
    }

    // Track decision distribution
    const decisionKey = assessment.decision || 'ignore';
    this.stats.layer2DecisionDistribution[decisionKey] = (this.stats.layer2DecisionDistribution[decisionKey] || 0) + 1;

    // Track assessment timing
    const assessmentTimeMs = Date.now() - startTime;
    this.stats.totalAssessmentTimeMs += assessmentTimeMs;
    this.stats.assessmentCount++;

    // Track confidence
    if (assessment.llmAssessment?.confidence !== undefined) {
      this.stats.totalConfidence += assessment.llmAssessment.confidence;
      this.stats.confidenceCount++;
    }

    // Same visibility rule as the clustered path: annotate no-actuation
    // independent decisions before they are recorded (see below).
    this.annotateIndependentActuation(assessment);
    // R40-A3：先评估升级再落账（同 clustered 路径；R45-P0：真实 severity 权威档）。
    evaluateDecisionEscalation(assessment, eventSeverityOf(event));
    this.noteCognitiveDecision(assessment);

    // Call assessment callback if registered
    if (this.assessmentCallback && event) {
      try {
        this.assessmentCallback(assessment, event);
      } catch (err) {
        logger.error(`[DualTriggerACManager:${this.agentId}] Assessment callback error:`, err);
      }
    }

    // R40-A3：升级 = 只通知不执行——defer 收束（标注已随 callback 进决策
    // 记录与 AGENT_ESCALATION 事件）。
    if (this.escalatedOnly(assessment)) {
      return {
        path: 'deferred',
        layer2Result: { assessment },
        stats: { processingTime: Date.now() - startTime, layerUsed: 2, eventsFiltered: 0 },
      };
    }

    // ============================================================
    // Wave A2: A/B comparison mode enforcement.
    // T-050: 'shadow' = OBSERVE/RECORD ONLY — the would-be initiation is
    // annotated on the record and NOTHING executes (canActuateIndependently
    // suppresses independent actuation for the same mode). 'disabled'
    // forces the no-AC baseline where own-device actuation still runs.
    // ============================================================
    const acMode = this.config.acMode ?? 'enabled';
    if ((acMode === 'disabled' || acMode === 'shadow') && assessment.decision === 'initiate_ac') {
      if (acMode === 'shadow') {
        logger.info(`[DualTriggerACManager:${this.agentId}] AC SHADOW: would initiate AC "${assessment.llmAssessment?.reasoning ?? ''}" but recording only — no AC execution, no device actuation`);
        // Auditable on the decision record: what WOULD have run and why
        // nothing did (shadow = observe/record only).
        const note = '[ac-shadow: would initiate AC — recorded for analysis only, not executed; device actuation suppressed]';
        if (assessment.llmAssessment !== undefined) {
          assessment.llmAssessment.reasoning = assessment.llmAssessment.reasoning
            ? `${assessment.llmAssessment.reasoning} ${note}`
            : note;
        }
      } else {
        logger.info(`[DualTriggerACManager:${this.agentId}] AC DISABLED: forcing handle_independently`);
      }
      // Override decision to handle_independently for both 'disabled' and 'shadow'.
      // The difference: 'shadow' logs what would have happened (above); 'disabled'
      // just silently forces independent action.
      assessment.decision = 'handle_independently';
      // decisionSource is typed as 'triage'|'precheck'|'rule'|'llm'; use
      // 'rule' for the override since it's the closest deterministic source.
      assessment.decisionSource = 'rule';
    }

    if (assessment.decision === 'initiate_ac') {
      // The primary-initiator claim was already consulted above (before the
      // decision was recorded) — a surviving initiate_ac either holds the
      // claim or runs without a coordinator.
      logger.info(`[DualTriggerACManager:${this.agentId}] AC initiation recommended, proceeding with AC setup...`);

      // Track AC decision made (regardless of partner availability)
      this.stats.acDecisionMade++;

      // Create a minimal Layer1Result for urgent events using type-safe helper
      const layer1Result = createUrgentLayer1Result(assessment.clusterSummary, startTime);

      // When autoInitiateAC is false, record the decision but skip execution.
      if (!this.config.autoInitiateAC) {
        logger.info(`[DualTriggerACManager:${this.agentId}] AC decision: initiate_ac (urgent) — but autoInitiateAC is false, skipping execution`);
      } else {
        await this.initiateAC(assessment, layer1Result);
      }

      return {
        path: 'ac_initiated',
        layer1Result,
        layer2Result: { assessment },
        stats: { processingTime: Date.now() - startTime, layerUsed: 2, eventsFiltered: 0 },
      };
    }

    if (assessment.decision === 'handle_independently') {
      logger.info(`[DualTriggerACManager:${this.agentId}] Agent will handle independently`);
      this.stats.handledIndependently++;
      // Mechanism B first (a named invocable flow replaces device
      // improvisation); then the Phase-1 cognitive deviceActions lane (the
      // model's structured commands, bridge-validated); the deterministic
      // rule path remains the fallback.
      const dispatched = await this.executeIndependentHandling(assessment);
      // FEAT-10: a REAL self-handling (commands dispatched) registers the
      // event claim — later initiators for the same event defer.
      this.claimSelfHandledEvent(event, dispatched);
      return {
        path: 'handled_independently',
        layer2Result: {
          assessment,
        },
        stats: {
          processingTime: Date.now() - startTime,
          layerUsed: 2,
          eventsFiltered: 0,
        },
      };
    }

    logger.info(`[DualTriggerACManager:${this.agentId}] Assessment deferred, decision: ${assessment.decision}`);
    this.stats.deferred++;
    return {
      path: 'deferred',
      layer2Result: {
        assessment,
      },
      stats: {
        processingTime: Date.now() - startTime,
        layerUsed: 2,
        eventsFiltered: 0,
      },
    };
  }

  /** Visibility for "decided but did nothing" — pure logic in independent-actuation-honesty.ts (R21 budget). */
  private annotateIndependentActuation(assessment: ACNecessityAssessment): void {
    annotateIndependentActuationNote({
      assessment,
      agentDevices: this.agentDevices,
      offerRules: this.config.semanticOfferRules,
      canActuate: this.canActuateIndependently(),
      blockReason: this.independentActuationBlockReason(),
    });
  }

  /** BUG-01 honesty gate — pure logic in independent-actuation-honesty.ts (R21 budget). */
  private applyPrecheckHonestyGate(assessment: ACNecessityAssessment): void {
    const eventZone = evaluatePrecheckHonestyGate({
      assessment,
      agentDevices: this.agentDevices,
      offerRules: this.config.semanticOfferRules,
      canActuate: this.canActuateIndependently(),
    });
    if (eventZone !== undefined) {
      logger.warn(
        `[DualTriggerACManager:${this.agentId}] precheck Type-A handle_independently has NO actuation backing in ${eventZone} ` +
        `(planner produced 0 commands) — converted to Type-E initiate_ac (BUG-01 honesty gate)`,
      );
    }
  }

  /**
   * FEAT-09 (dorm-life D8): audience ≠ initiation eligibility. An audience
   * member whose own capability surface (declared ∪ bound-device — the same
   * T-202 surface agentContext.capabilities carries) has ZERO intersection
   * with the event's requirements is observe-only: it saw the event (the
   * world-model ring was already fed in processEvent/perceiveEvent) but
   * never enters the initiate evaluation — no assessment, no decision
   * record, one observeOnly stat. The matching verdict is pure
   * (assessor-passthrough.isZeroIntersectionAudience, the same
   * computeGapNeeds semantics the partner shortlist ranks against).
   *
   * Exemptions (the gate targets FUNCTIONALLY-mismatched audiences, not the
   * zone's own responders):
   *  1. coordinator-role agents initiate as DISPATCHERS, not executors
   *     (same exemption as the Type-A precheck);
   *  2. agents with DIRECT ACTUATOR COVERAGE of the event zone — Type B/C
   *     territory: the LLM lane decides delegation, and the escalation
   *     channel (R40-A3, a safety feature) must not be silenced for a
   *     high-severity event the local actuator agent lacks the exact
   *     declared capability for;
   *  3. sensor-only agents (no actuator zones) when the event DECLARES NO
   *     requirements — detection IS their contribution (formal model
   *     Def. 6, the sensor-notify pattern), and the precheck's own STEP-0a
   *     domain-relevance gate already governs their over-initiation. A
   *     DECLARED requirements face gates them like anyone else (R103: the
   *     security officer initiating grid-load ACs).
   */
  private isObserveOnlyAudience(clusterSummary: SpatialClusterSummary, agentContext: AgentContext): boolean {
    if (agentContext.decisionRole === 'coordinator') return false;
    const actuatorZones = agentContext.actuatorZoneIds ?? [];
    if (actuatorZones.includes(clusterSummary.region.id)) return false; // exemption 2
    if (actuatorZones.length === 0
        && extractDeclaredRequiredCapabilities(clusterSummary).length === 0) {
      return false; // exemption 3
    }
    const observeOnly = isZeroIntersectionAudience(clusterSummary, agentContext.capabilities);
    if (observeOnly) {
      this.stats.observeOnly++;
      logger.info(
        `[DualTriggerACManager:${this.agentId}] observe-only audience for event in ${clusterSummary.region.id}: ` +
        `zero intersection between the event requirements and the own capability surface — skipping the initiate evaluation`,
      );
    }
    return observeOnly;
  }

  /** FEAT-09: the observe-only short-circuit result (no Layer-2 decision recorded). */
  private observeOnlyResult(startTime: number): DualTriggerResult {
    return {
      path: 'deferred',
      stats: { processingTime: Date.now() - startTime, layerUsed: 2, eventsFiltered: 0 },
    };
  }

  /**
   * T-204: whether a 'handle_independently' decision actuates the agent's
   * own devices. Requires a wired commandExecutor; honors the
   * decision-only eval switch (autoInitiateAC === false) and the
   * autoActuateIndependent opt-out. Own-devices only — the planner below
   * exclusively emits commands for this agent's bound devices, so there is
   * no cross-agent/cross-tenant path.
   *
   * T-050: acMode 'shadow' is OBSERVE/RECORD ONLY — no device actuation
   * (and no AC execution, see processAssessmentResult). The mode is read
   * HERE because this is the single gate every independent actuation path
   * (clustered, urgent, simple-event) already consults.
   */
  private canActuateIndependently(): boolean {
    return this.independentActuationBlockReason() === undefined;
  }

  /**
   * T-302 (EO-F09): the gate check extracted with its reason — each branch
   * that suppresses actuation names ITSELF so the decision record carries
   * the OPERATIVE cause instead of a 4-way disjunction the operator must
   * guess from. Check order mirrors the original canActuateIndependently.
   */
  private independentActuationBlockReason(): string | undefined {
    if (this.config.commandExecutor === undefined) {
      return 'no command executor is wired to this agent';
    }
    if (this.config.autoInitiateAC === false) {
      return 'decision-only evaluation (autoInitiateAC=false)';
    }
    if (this.config.autoActuateIndependent === false) {
      return 'autoActuateIndependent=false (actuation opt-out)';
    }
    if ((this.config.acMode ?? 'enabled') === 'shadow') {
      return 'acMode=shadow (observe/record only — never mutates physics)';
    }
    return undefined;
  }

  /** The lane seam handed to independent-handling.ts (verbatim extraction — R21 budget). */
  private independentHandlingSeam(): IndependentHandlingSeam {
    return {
      agentId: this.agentId,
      agentDevices: this.agentDevices,
      commandExecutor: this.config.commandExecutor,
      flowInvoker: this.config.flowInvoker,
      semanticOfferRules: this.config.semanticOfferRules,
      actuationBlockReason: () => this.independentActuationBlockReason(),
    };
  }

  /**
   * Run the independent-handling lanes (Mechanism-B flow → cognitive
   * deviceActions → rule planning) and report the dispatched command count
   * (lane logic in independent-handling.ts). FEAT-10: the caller claims the
   * event when the count is > 0 — a REAL self-handling registers the claim.
   */
  private executeIndependentHandling(assessment: ACNecessityAssessment): Promise<number> {
    return runIndependentHandling(this.independentHandlingSeam(), assessment);
  }

  /**
   * FEAT-10 (dorm-life D11): a self-handling that actually dispatched device
   * commands registers "this event is being handled":
   *  1. claim the event in the InitiatorCoordinator, so a LATER would-be
   *     initiator for the same event defers instead of double-actuating the
   *     same devices (the duty officer's spontaneous ventilation used to be
   *     followed by an AC turn-on of the same fan);
   *  2. record the shared event id locally (bounded set) so the responder
   *     lane can reject proposals for an event this agent already handled
   *     (see hasSelfHandledEvent) — robust to claim races.
   */
  private claimSelfHandledEvent(event: SystemEvent | undefined, dispatched: number): void {
    if (dispatched <= 0 || event === undefined) return;
    const sharedEventId = extractSharedEventId(event);
    if (sharedEventId.length === 0) return;
    if (!this.selfHandledEventIds.has(sharedEventId)) {
      if (this.selfHandledEventIds.size >= SELF_HANDLED_EVENT_IDS_CAP) {
        const oldest = this.selfHandledEventIds.values().next().value;
        if (oldest !== undefined) this.selfHandledEventIds.delete(oldest);
      }
      this.selfHandledEventIds.add(sharedEventId);
    }
    if (this.initiatorCoordinator !== undefined) {
      this.initiatorCoordinator.tryClaim(sharedEventId, this.agentId);
      logger.info(
        `[DualTriggerACManager:${this.agentId}] claimed event ${sharedEventId} after independent handling (${dispatched} command(s) dispatched)`,
      );
    }
  }

  /**
   * FEAT-10: did THIS agent already handle the given (shared) event id
   * independently — with real device commands dispatched? The responder
   * lane consults this to reject proposals that would double-actuate.
   */
  hasSelfHandledEvent(eventId: string): boolean {
    return this.selfHandledEventIds.has(eventId);
  }

  /** Execute the planned rule actions via the configured command executor (lane logic in independent-handling.ts). */
  private executeRuleActions(assessment: ACNecessityAssessment): Promise<number> {
    return runRuleActions(this.independentHandlingSeam(), assessment);
  }

  /**
   * Build agent context for Layer 2
   *
   * Public so that tests can verify the context built from agent-assigned devices.
   */
  async buildAgentContext(): Promise<AgentContext> {
    // CRITICAL: Use agent-assigned devices, NOT environment devices
    // Devices are agent's internal resources, NOT visible to other agents
    // Phase 2: the R37-F2 live enrichment now lives in ONE place
    // (cognition/context-projection.enrichAgentDevices) feeding both the
    // legacy availableResources face AND the world-model device face.
    let availableResources;

    if (this.agentDevices.length > 0) {
      availableResources = enrichAgentDevices(this.agentDevices, {
        resourceManager: this.resourceManager,
        environment: this.environment,
        disablePhysicalContext: this.config.disablePhysicalContext,
      });
      logger.info(`Using agent-assigned devices (${availableResources.length} devices)`);
    } else {
      // Enhanced fallback with full device information
      let devices: DeviceWithState[] = [];
      try {
        devices = this.environment?.listDevices?.() || [];
      } catch (error) {
        logger.error(`[DualTriggerACManager:${this.agentId}] Failed to list environment devices:`, error);
        throw error;
      }
      availableResources = environmentDevicesFace(devices, this.config.disablePhysicalContext);
      logger.info(`No agent devices set, using environment devices (${availableResources.length} devices)`);
    }

    // Get services from ServiceRegistry
    const serviceRegistry = this.serviceRegistry;
    const ownServices = serviceRegistry?.getOwnServices() || [];

    // Discover partner services from EnvironmentCenter (Service layer — architecture-safe)
    // Only exposes what other agents have explicitly published as services.
    // Ablation: strip discoverable services for text-only condition
    // Element type = AgentContext['discoverableServices'] (single source — carries origin/semanticType, R45-P4).
    let discoverableServices: NonNullable<AgentContext['discoverableServices']> = [];

    if (!this.config.disablePhysicalContext) {
      try {
        const allRegistrations = this.environment.getServices?.();
        if (allRegistrations) {
          for (const [, reg] of allRegistrations) {
            // Filter out own services — only include other agents' published services
            if (reg.agentId !== this.agentId) {
              const svc = reg.service;
              discoverableServices.push({
                serviceName: svc.name,
                capabilities: svc.capabilities || [],
                providerAgentId: reg.agentId,
                location: typeof svc.location === 'string' ? svc.location : undefined,
                origin: reg.origin,
                semanticType: reg.semanticType,
                // Liveness: heartbeat-stale services stay visible but flagged (digest demotes + annotates)
                ...(this.environment.isRegistrationStale?.(reg) === true ? { stale: true } : {}),
              });
            }
          }
        }
      } catch (error) {
        logger.warn(`[DualTriggerACManager:${this.agentId}] Service discovery failed:`, error);
      }
    }

    // Extract managed zone IDs from own published services' locations (Resource layer — own info)
    const managedZoneIds = new Set<string>();
    try {
      const allRegistrations = this.environment.getServices?.();
      if (allRegistrations) {
        for (const [, reg] of allRegistrations) {
          if (reg.agentId === this.agentId && typeof reg.service.location === 'string') {
            managedZoneIds.add(reg.service.location);
          }
        }
      }
    } catch {
      // Service registry may not be available
    }

    // Extract actuator zone IDs — zones where agent has actuator/hybrid devices
    // This is distinct from managedZoneIds (which includes sensor-only zones).
    // Priority: config-injected > computed from agentDevices
    const actuatorZoneIds = new Set<string>();
    if (this.config.actuatorZoneIds && this.config.actuatorZoneIds.length > 0) {
      for (const zid of this.config.actuatorZoneIds) {
        actuatorZoneIds.add(zid);
      }
    } else {
      // Fallback: compute from agent devices
      for (const deviceInfo of this.agentDevices) {
        if (deviceInfo.type === 'actuator' || deviceInfo.type === 'hybrid') {
          // Try to get zone from device capabilities or naming convention
          // Note: agentDevices don't have direct zoneId, so this fallback
          // relies on the experiment runner injecting actuatorZoneIds via config
          logger.debug(`[DualTriggerACManager:${this.agentId}] No actuatorZoneIds in config, device ${deviceInfo.deviceId} zone unknown`);
        }
      }
    }

    // Compute adjacent zones from managed zones (for zone-coverage preCheck)
    // Priority: config-injected > computed from PhysicalEnvironment
    const adjacentZoneIds = new Set<string>();
    if (this.config.adjacentZoneIds && this.config.adjacentZoneIds.length > 0) {
      for (const adjId of this.config.adjacentZoneIds) {
        adjacentZoneIds.add(adjId);
      }
    } else {
      try {
        // Duck-typed zone lookup: PhysicalEnvironment optionally exposes
        // getZone(); declared structurally to avoid an `as any` cast.
        const physicalEnv = this.environment.physicalEnvironment as unknown as {
          getZone?: (zoneId: string) => { adjacentZoneIds?: string[] } | undefined;
        } | undefined;
        if (physicalEnv && typeof physicalEnv.getZone === 'function') {
          for (const zoneId of managedZoneIds) {
            const zone = physicalEnv.getZone(zoneId);
            if (zone?.adjacentZoneIds) {
              for (const adjId of zone.adjacentZoneIds) {
                adjacentZoneIds.add(adjId);
              }
            }
          }
        }
      } catch {
        // Physical environment may not be available or lack zone info
      }
    }

    // Get environment parameters from EnvironmentCenter (indirect access, no physics dependency)
    // getParameters() may be undefined if EnvironmentCenter has no physical environment backing
    let environmentState: Record<string, any> = {};
    if (!this.config.disablePhysicalContext) {
      try {
        environmentState = this.environment.getParameters?.() || {};
      } catch (error) {
        logger.warn(`[DualTriggerACManager:${this.agentId}] Failed to get environment parameters:`, error);
      }
    }

    // Ablation: strip effect propagation data when disabled
    if (this.config.disableEffectPropagation) {
      const propagationKeys = ['propagation', 'radiationRadius', 'falloff', 'zoneSpread', 'heatPropagation', 'effectRadius'];
      for (const key of Object.keys(environmentState)) {
        if (propagationKeys.some((pk) => key.toLowerCase().includes(pk.toLowerCase()))) {
          delete environmentState[key];
        }
      }
    }

    // Determine workload based on active ACs and configured max concurrency
    const maxACs = this.config.maxConcurrentACs || 3;
    const acCount = this.activeACs.size;
    const workload = acCount >= maxACs ? 'heavy' :
                     acCount >= Math.floor(maxACs * 0.6) ? 'moderate' :
                     acCount >= 1 ? 'light' : 'idle';

    // Ablation: disableServiceDiscovery — hide partner service information
    const finalDiscoverableServices = this.config.disableServiceDiscovery
      ? []
      : discoverableServices;

    // Ablation: useVagueSpatial — replace precise zone IDs with vague descriptions
    let finalManagedZoneIds = Array.from(managedZoneIds);
    if (this.config.useVagueSpatial) {
      finalManagedZoneIds = finalManagedZoneIds.map(id => vagueZoneDescription(id));
    }

    // T-202 capability honesty: the decision surface is the DECLARED list
    // UNION the live device-derived capabilities (computed from the same
    // availableResources read above, not captured at construction). An agent
    // whose declared list is thin but whose bound devices deliver the goods
    // used to answer "no cooling capability" in every LLM prompt (HF-F05).
    const capabilitySurface = Array.from(new Set([
      ...this.agentCapabilities,
      ...availableResources.flatMap(r => r.capabilities ?? []),
    ]));

    // Mechanism B: the honest flow listing (provider faults hide the
    // listing — a broken provider must not break the decision path).
    let invocableFlows: InvocableFlowOffering[] | undefined;
    if (this.invocableFlowsProvider !== undefined) {
      try {
        invocableFlows = this.invocableFlowsProvider();
      } catch (error) {
        logger.warn(`[DualTriggerACManager:${this.agentId}] Invocable-flows provider failed:`, error);
      }
    }

    // Phase 2 (§14.2): the unified world-model projection — built from the
    // SAME availableResources/capabilitySurface the legacy fields carry
    // (single source), the zone provider, the event ring and the goal stack.
    // Attached AFTER every legacy field is resolved; provider/assessment
    // faults degrade to no cognition context, never break the decision path.
    let cognition;
    try {
      cognition = buildAgentCognitionContext({
        agentId: this.agentId,
        capabilities: capabilitySurface,
        ...(this.scopeOfPractice !== undefined ? { scopeOfPractice: this.scopeOfPractice } : {}),
        availableResources,
        ...(this.worldModelProvider !== undefined ? { zoneSource: this.worldModelProvider() } : {}),
        goals: this.agentGoals,
        events: this.cognitionEvents.recentEvents(WORLD_MODEL_EVENT_RING_CAP),
        fallbackSimTimeSec: Math.round(Date.now() / 1000),
        workingMemoryStore: this.workingMemory,
      });
    } catch (error) {
      logger.warn(`[DualTriggerACManager:${this.agentId}] World-model build failed (continuing without cognition context):`, error);
    }

    // Phase 5 (§7): the meta-cognition projection — live capability boundary
    // (bound devices + T-202 surface + T-036 scope), partner trust and
    // adaptive hints, from the SAME resources the legacy fields carry.
    // Absent meta → no field, prompt unchanged; faults degrade, never throw.
    let metaCognitionContext;
    if (this.metaCognition !== undefined) {
      try {
        metaCognitionContext = this.metaCognition.buildContext({
          capabilities: capabilitySurface,
          devices: availableResources.map(resource => ({
            deviceId: resource.deviceId,
            capabilities: resource.capabilities ?? [],
            online: resource.isOnline !== false,
          })),
          ...(this.scopeOfPractice !== undefined ? { scopeOfPractice: this.scopeOfPractice } : {}),
        });
      } catch (error) {
        logger.warn(`[DualTriggerACManager:${this.agentId}] Meta-cognition build failed (continuing without):`, error);
      }
    }

    return {
      agentId: this.agentId,
      agentName: this.agentName,
      capabilities: capabilitySurface,
      availableResources,
      ownServices: ownServices.map((s: any) => ({
        name: s.name,
        capabilities: s.capabilities,
        status: s.status,
      })),
      environmentState,
      currentWorkload: workload,
      recentCollaborations: Array.from(this.activeACs.keys()),
      currentCollaborations: this.activeACs.size,
      acHistory: this.config.disableACHistory ? [] : this.acHistory,
      // Own zone info extracted from published service locations (Resource layer)
      managedZoneIds: finalManagedZoneIds,
      // Actuator zones — where agent can physically act (subset of managedZoneIds)
      actuatorZoneIds: this.config.useVagueSpatial
        ? Array.from(actuatorZoneIds).map(id => vagueZoneDescription(id))
        : Array.from(actuatorZoneIds),
      // Adjacent zones for zone-coverage preCheck (propagation range)
      adjacentZoneIds: Array.from(adjacentZoneIds),
      // Partner services discovered via ServiceRegistry (Service layer — architecture-safe)
      discoverableServices: finalDiscoverableServices,
      // Mechanism B: the flows this agent may invoke (honest listing).
      ...(invocableFlows !== undefined && invocableFlows.length > 0 ? { invocableFlows } : {}),
      // Phase 2: the world-model projection (SITUATION/RECENT_EVENTS/
      // PREVIOUS_DECISION render from it; absent → legacy prompt shape).
      ...(cognition !== undefined ? { cognition } : {}),
      // Phase 5: the meta-cognition projection (META_COGNITION renders from
      // it; absent → legacy prompt shape, byte-identical).
      ...(metaCognitionContext !== undefined ? { metaCognition: metaCognitionContext } : {}),
      // Ablation flag for concise service mode
      conciseServiceMode: this.config.conciseServiceMode ?? false,
      // Smart-rules mode: deterministic rules with spatial + service reasoning (no LLM)
      smartRulesMode: this.config.smartRulesMode ?? false,
      tfidfBaselineMode: this.config.tfidfBaselineMode ?? false,
      // Rule-only mode: no LLM configured — decisions resolve via rules only
      ruleOnlyMode: this.config.ruleOnly ?? false,
      // R43-B/lever-b: precheck Type-A pass-through policy (absent = off,
      // current behavior). Copied — downstream must never mutate our config.
      ...(this.config.precheckPassThrough !== undefined
        ? { precheckPassThrough: { ...this.config.precheckPassThrough } }
        : {}),
      // R45-P1: dispatcher role (absent = executor, current behavior).
      ...(this.config.decisionRole !== undefined ? { decisionRole: this.config.decisionRole } : {}),
    };
    if (this.config.conciseServiceMode) {
      logger.info(`[DualTriggerACManager:${this.agentId}] conciseServiceMode enabled — services will be filtered to event-zone only`);
    }
  }

  /**
   * Phase 2 (§3.1): digest an event into the bounded world-model ring
   * (drop-oldest; sim time from the zone source, else store fallback).
   */
  private digestEventForWorldModel(event: SystemEvent): void {
    try {
      const payload = event.payload as Record<string, unknown> | undefined;
      const zoneId = typeof payload?.zoneId === 'string' ? payload.zoneId
        : typeof payload?.location === 'string' ? payload.location : undefined;
      const parameter = typeof payload?.parameter === 'string' ? payload.parameter : undefined;
      const value = payload?.newValue ?? payload?.value;
      const simTimeSec = this.worldModelProvider?.()?.simTimeSec;
      const originType = typeof payload?.eventType === 'string' ? payload.eventType : event.type;
      const record: Omit<WorldModelEvent, 'simTimeSec'> & { simTimeSec?: number } = {
        type: originType,
        ...(zoneId !== undefined ? { zoneId } : {}),
        ...(parameter !== undefined ? { parameter } : {}),
        ...(typeof value === 'number' || typeof value === 'boolean' ? { value } : {}),
        ...(simTimeSec !== undefined ? { simTimeSec } : {}),
      };
      this.cognitionEvents.recordEvent(record);
    } catch {
      /* the ring must never break event processing */
    }
  }

  /**
   * Phase 2 (§3.4): record the cognitive decision + outcome into working
   * memory so the NEXT round's prompt carries PREVIOUS_DECISION.
   * Phase 5 (§7.1): the same funnel feeds the decision-quality tracker —
   * confidence + the deterministic v1 outcome signal (see cognition/meta).
   */
  private noteCognitiveDecision(assessment: ACNecessityAssessment): void {
    const simTimeSec = this.worldModelProvider?.()?.simTimeSec;
    const outcomes: Record<string, string> = {
      initiate_ac: 'ac-initiated',
      handle_independently: 'handled-independently',
      defer: 'deferred',
      ignore: 'ignored',
    };
    this.workingMemory.recordDecision({
      action: assessment.decision,
      outcome: outcomes[assessment.decision] ?? assessment.decision,
      ...(simTimeSec !== undefined ? { atSimTimeSec: simTimeSec } : {}),
    });
    // R40-A3：升级 = 只通知不执行——被升级的决策在 quality tracker 里按
    // "policy-blocked" 记（outcome 'unknown'，不是失败也不是成功）。
    const actuationBlockedReason = assessment.escalated === true
      ? 'escalated to owner (notify-only — nothing executes)'
      : this.independentActuationBlockReason();
    this.metaCognition?.noteAssessment({
      action: assessment.decision,
      // The MODEL's self-reported confidence wins (uncertainty.overall);
      // llmAssessment.confidence is a hardcoded legacy placeholder on the
      // cognitive path, rule paths carry their own deterministic values.
      confidence: assessment.cognitiveDecision?.uncertainty.overall
        ?? assessment.llmAssessment?.confidence
        ?? 0.5,
      ...(assessment.decisionSource !== undefined ? { decisionSource: assessment.decisionSource } : {}),
      ...(simTimeSec !== undefined ? { atSimTimeSec: simTimeSec } : {}),
      ...(actuationBlockedReason !== undefined ? { actuationBlockedReason } : {}),
      hasCognitiveDeviceActions:
        (assessment.cognitiveDecision?.actionPlan.primary.deviceActions?.length ?? 0) > 0,
      hasInvokeFlow: assessment.invokeFlow !== undefined,
      plannedCommandCount: planIndependentDeviceActions(assessment, this.agentDevices, this.config.semanticOfferRules).actions.length,
    });
  }

  /**
   * R40-A3（§7.5 升级通道）：升级收束。评估逻辑（严重度×置信×能力边界，
   * shouldEscalate 阈值）是 cognition/capability-boundary 的纯函数；命中时
   * 它已标注 assessment.escalated + escalationCondition，这里只负责"升级 =
   * 只通知不执行"的执行面：true ⇒ 调用方跳过一切执行分支（设备命令 /
   * flow / AC 发起），统计按 deferred 收束。
   */
  private escalatedOnly(assessment: ACNecessityAssessment): boolean {
    if (assessment.escalated !== true) return false;
    // R43-A: escalation suppresses autonomy but NOT an explicit initiate_ac
    // (the agent asking for partner support is the SAFE high-severity response).
    if (assessment.decision === 'initiate_ac') {
      logger.info(`[DualTriggerACManager:${this.agentId}] Escalated initiate_ac — collaboration proceeds`);
      return false;
    }
    this.stats.deferred++;
    logger.info(`[DualTriggerACManager:${this.agentId}] Escalated decision — no execution lanes run`);
    return true;
  }

  /** Direct Layer-2 conversion (pure shaping lives in event-cluster-summary.ts). */
  private eventToClusterSummary(event: SystemEvent): SpatialClusterSummary {
    return shapeClusterSummary(
      event,
      this.config.useVagueSpatial,
      (message: string) => logger.warn(`[DualTriggerACManager:${this.agentId}] ${message}`),
    );
  }

  /**
   * Mark an AC as completed
   */
  completeAC(acId: string): void {
    this.activeACs.delete(acId);
    logger.info(`AC ${acId} completed`);
  }

  /**
   * Start listening for AC completion events (feedback loop).
   * Called by CognitiveAgent or standalone usage.
   * Enables DualTriggerACManager to directly receive COLLABORATION_COMPLETED events.
   */
  startFeedbackListening(): void {
    if (this.feedbackSubscriptionId) return; // Already listening
    if (!this.environment?.eventManager) return;

    this.feedbackSubscriptionId = this.environment.eventManager.subscribe({
      subscriberId: `${this.agentId}-ac-feedback`,
      eventType: EventType.COLLABORATION_COMPLETED,
      handler: (event: SystemEvent) => {
        try {
          this.recordCollaborationOutcome(event.payload);
        } catch (error) {
          logger.error(`[DualTriggerACManager:${this.agentId}] Error recording outcome from event:`, error);
        }
      },
      priority: EventPriority.NORMAL,
    });
    logger.info(`[DualTriggerACManager:${this.agentId}] Feedback listening started`);
  }

  /**
   * Stop listening for AC completion events.
   */
  stopFeedbackListening(): void {
    if (this.feedbackSubscriptionId && this.environment?.eventManager) {
      this.environment.eventManager.unsubscribe(this.feedbackSubscriptionId);
      this.feedbackSubscriptionId = null;
    }
  }

  /**
   * Record a collaboration outcome for feedback in future decisions.
   *
   * Architecture: CognitiveAgent subscribes to COLLABORATION_COMPLETED events
   * and calls this method to maintain proper layer separation. DualTriggerACManager
   * does NOT subscribe to EventManager directly.
   *
   * @param payload - Collaboration completion data
   */
  recordCollaborationOutcome(payload: {
    collaborationId: string;
    success?: boolean;
    results?: { goals?: Array<{ achieved?: boolean }>; participants?: string[] };
    goals?: Array<{ achieved?: boolean }> | number;
    participants?: string[];
  }): void {
    if (!payload.collaborationId) {
      throw new Error(`[DualTriggerACManager:${this.agentId}] recordCollaborationOutcome: collaborationId is required`);
    }

    // Determine outcome from the event payload
    const success = payload.success !== false;
    const goals = payload.results?.goals || payload.goals || [];
    const goalsTotal = Array.isArray(goals) ? goals.length : (typeof goals === 'number' ? goals : 1);
    const goalsAchieved = Array.isArray(goals)
      ? goals.filter((g: { achieved?: boolean }) => g.achieved === true).length
      : (success ? goalsTotal : 0);

    // Determine outcome classification
    let outcome: 'success' | 'partial' | 'failure';
    if (success && goalsAchieved === goalsTotal && goalsTotal > 0) {
      outcome = 'success';
    } else if (goalsAchieved > 0) {
      outcome = 'partial';
    } else {
      outcome = success ? 'success' : 'failure';
    }

    // Extract partners from the event payload
    const partners: string[] = payload.participants || payload.results?.participants || [];

    const entry = {
      collaborationId: payload.collaborationId,
      partners,
      outcome,
      goalsTotal,
      goalsAchieved,
      completedAt: new Date(),
    };

    this.acHistory.push(entry);

    // Trim to max size
    if (this.acHistory.length > this.config.maxHistorySize) {
      this.acHistory = this.acHistory.slice(-this.config.maxHistorySize);
    }

    logger.info(`[DualTriggerACManager:${this.agentId}] Recorded AC completion: ${payload.collaborationId} (${outcome})`);

    // Phase 5 (§7.1/§7.3): resolve the pending initiate_ac decision in the
    // quality tracker (FIFO) and update every partner's private trust.
    this.metaCognition?.recordCollaborationOutcome(outcome, partners);

    // Remove from active ACs if still tracked
    this.activeACs.delete(payload.collaborationId);
  }

  /**
   * Get AC outcome history (for testing and external access)
   */
  getACHistory(): Array<{
    collaborationId: string;
    partners: string[];
    outcome: 'success' | 'partial' | 'failure';
    goalsTotal: number;
    goalsAchieved: number;
    completedAt: Date;
  }> {
    return [...this.acHistory];
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats & {
    layer1Stats?: Record<string, number>;
    layer2Stats?: {
      assessor: Record<string, number> | undefined;
      negotiator: Record<string, number> | undefined;
      goalEngine: Record<string, number> | undefined;
    };
    // P4-2 triage metrics (undefined when triage is disabled)
    triage?: TriageMetrics;
    // Computed metrics
    layer1FilterRate?: number;
    avgAssessmentTimeMs?: number;
    avgConfidence?: number;
  } {
    return {
      ...this.stats,
      layer1Stats: this.layer1Processor?.getStats(),
      layer2Stats: {
        assessor: this.acNecessityAssessor?.getStats(),
        negotiator: this.partnerNegotiator?.getStats(),
        goalEngine: this.goalEngine?.getStats(),
      },
      triage: this.acNecessityAssessor?.getTriageMetrics(),
      // Computed metrics
      layer1FilterRate: this.stats.totalEventsProcessed > 0
        ? this.stats.filteredByLayer1 / this.stats.totalEventsProcessed
        : 0,
      avgAssessmentTimeMs: this.stats.assessmentCount > 0
        ? this.stats.totalAssessmentTimeMs / this.stats.assessmentCount
        : 0,
      avgConfidence: this.stats.confidenceCount > 0
        ? this.stats.totalConfidence / this.stats.confidenceCount
        : 0,
    };
  }

  /**
   * P4-2: triage metrics from the AC necessity assessor (undefined when
   * triage is disabled).
   */
  getTriageMetrics(): TriageMetrics | undefined {
    return this.acNecessityAssessor?.getTriageMetrics();
  }

  /**
   * T-105: failed LLM decision calls. The assessor counts a failure and
   * re-throws — the event then produces no decision record, so this counter
   * (aggregated per sim in the engine snapshot) is the only API-visible
   * trace of a dead backend.
   */
  getLLMErrorCount(): number {
    return this.acNecessityAssessor?.getStats().llmErrors ?? 0;
  }

  /**
   * Set assessment callback for external monitoring
   * Called when AC necessity assessment completes
   */
  setAssessmentCallback(callback: (assessment: ACNecessityAssessment, event: SystemEvent) => void): void {
    this.assessmentCallback = callback;
    logger.info(`[DualTriggerACManager:${this.agentId}] Assessment callback set`);
  }

  /**
   * Inject the runtime-wide InitiatorCoordinator. When set, this manager
   * will consult the coordinator before committing to `initiate_ac`. The
   * first agent to claim an event becomes the primary initiator; others
   * that receive the same event defer. See InitiatorCoordinator for the
   * dedup semantics.
   */
  setInitiatorCoordinator(coordinator: InitiatorCoordinator): void {
    this.initiatorCoordinator = coordinator;
  }

  /**
   * Update context (e.g., when device states change)
   */
  updateContext(updates: Partial<RuleContext>): void {
    if (this.layer1Processor) {
      this.layer1Processor.updateContext(updates);
    }
  }

  /**
   * Stop all processing
   */
  stop(): void {
    if (this.layer1Processor) {
      this.layer1Processor.stop();
    }
    logger.info('Stopped', this.getStats());
  }

  /**
   * Destroy all resources and cleanup subscriptions.
   * Call this when the owning agent is permanently removed.
   */
  destroy(): void {
    // Stop Layer 1 processing
    if (this.layer1Processor) {
      this.layer1Processor.stop();
    }

    // Unsubscribe feedback listener from EventManager
    if (this.feedbackSubscriptionId && this.environment?.eventManager) {
      try {
        this.environment.eventManager.unsubscribe(this.feedbackSubscriptionId);
      } catch {
        // Subscription may no longer exist
      }
      this.feedbackSubscriptionId = null;
    }

    // Clear all internal state
    this.activeACs.clear();
    this.acHistory = [];
    this.agentDevices = [];
    this.cognitionEvents.clear();
    this.workingMemory.clear();

    // Null out heavy components to allow GC
    this.layer1Processor = null;
    this.acNecessityAssessor = null;
    this.partnerNegotiator = null;
    this.goalEngine = null;

    logger.info(`[DualTriggerACManager:${this.agentId}] Destroyed and resources released`);
  }

  /**
   * Force flush pending data
   */
  flush(): void {
    if (this.layer1Processor) {
      this.layer1Processor.flush();
    }
  }

  /**
   * Get active AC configurations
   */
  getActiveACs(): ACCollaborationConfig[] {
    return Array.from(this.activeACs.values());
  }

  /**
   * The Layer-2 partner negotiator, or null when Layer 2 is disabled.
   * Exposed so the EngineRuntime can attach the shared ReputationTracker
   * (P4-1) without the AC manager knowing about reputation.
   */
  getPartnerNegotiator(): PartnerSelectionNegotiator | null {
    return this.partnerNegotiator;
  }
}

export default DualTriggerACManager;
