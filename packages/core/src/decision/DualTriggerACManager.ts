/**
 * Dual-Trigger AC Manager
 *
 * Integrates Layer 1 (event filtering) and Layer 2 (cognitive decision)
 * for autonomous AC (Active Collaboration) triggering.
 *
 * Key Principle: AC is triggered autonomously by the agent, NOT manually defined.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    High-Frequency Events                         │
 * └────────────────────────────┬────────────────────────────────────┘
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ LAYER 1: Non-LLM Event Filtering (95% filtered)                 │
 * │  - SpatialTemporalClusterEngine: Grid-based spatial clustering  │
 * │  - SpatialClusterSummarizer: Generate summaries                 │
 * │  - TriggerConditionEvaluator: Rule-based AC need detection      │
 * └────────────────────────────┬────────────────────────────────────┘
 *                              │ ~5% pass to Layer 2
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ LAYER 2: LLM Cognitive Decision                                  │
 * │  - ACNecessityAssessor: Is AC needed?                            │
 * │  - PartnerSelectionNegotiator: Find best partners                │
 * │  - GoalFormulationEngine: Define collaboration goals             │
 * └────────────────────────────┬────────────────────────────────────┘
 *                              │
 *                              ▼
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
import { EventContextNormalizer, type NormalizedEventContext } from '../context/EventContextNormalizer.js';
import { ACContextBuilder, createACContextBuilder, type ACDecisionContext } from '../context/ACContextBuilder.js';

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
import { ACNecessityAssessor, type AgentContext, type ACNecessityAssessment, type AssessorConfig } from './ACNecessityAssessor.js';
import { PartnerSelectionNegotiator, type PartnerSelectionResult, type NegotiatorConfig } from './PartnerSelectionNegotiator.js';
import { GoalFormulationEngine, type GoalFormulationResult, type ACCollaborationConfig, type GoalEngineConfig } from './GoalFormulationEngine.js';

import { createLogger, EventType, EventPriority } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for DualTriggerACManager
 */
const logger = createLogger('DualTriggerACManager');

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
  adjacentZoneIds?: string[];        // Zones adjacent to agent's managed zones (for zone-coverage preCheck)
  actuatorZoneIds?: string[];        // Zones where agent has actuator/hybrid devices (for coverage distinction)

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

// ---------------------------------------------------------------------------
// Vague zone descriptions for ablation experiments (vague-spatial condition)
// Maps precise zone identifiers to generic descriptions that preserve spatial
// relationships without revealing specific zone purposes.
// ---------------------------------------------------------------------------

const VAGUE_ZONE_MAP: Record<string, string> = {
  'living-room': 'common-area',
  'bedroom': 'private-room-a',
  'kitchen': 'utility-area',
  'bathroom': 'wet-room',
  'server-room': 'technical-room',
  'entrance-hall': 'transit-zone-a',
  'home-office': 'work-area',
  'balcony': 'exterior-zone',
  'utility-room': 'service-room',
  'garage': 'storage-zone',
  'corridor': 'transit-zone-b',
  'room-1': 'zone-a',
};

function vagueZoneDescription(zoneId: string): string {
  return VAGUE_ZONE_MAP[zoneId] ?? `zone-${zoneId.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`;
}

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

/**
 * Create a minimal SpatialRegion for urgent events
 */
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
    region: createUrgentRegion(),
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
  private agentDevices: Array<{
    deviceId: string;
    type: string;
    capabilities: string[];
  }> = [];

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

  /**
   * Get the list of agent-assigned devices.
   * Returns a readonly array of device info objects that were set via setAgentDevices().
   */
  getAgentDevices(): ReadonlyArray<{
    deviceId: string;
    type: string;
    capabilities: string[];
  }> {
    return this.agentDevices;
  }

  /**
   * Set agent-assigned devices
   *
   * These are devices the agent can actually use (assigned via CognitiveAgent.assignDevices()).
   * CRITICAL: These are the agent's internal resources, NOT visible to other agents.
   * This is essential for GoalFormulationEngine to identify target devices for AC execution.
   *
   * Architecture Note: Devices are the agent's internal resources.
   * Other agents can only see Services, NOT devices.
   *
   * @param devices - Array of device info objects
   */
  setAgentDevices(devices: Array<{
    deviceId: string;
    type: string;
    capabilities: string[];
  }>): void {
    this.agentDevices = devices;
    logger.info(`Agent devices updated: ${devices.length} devices`);
    if (devices.length > 0) {
      logger.info(`Device IDs: ${devices.map(d => d.deviceId).join(', ')}`);
    }
  }

  /**
   * Initialize Layer 1 and Layer 2 components
   */
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

    // Initialize Layer 2
    if (this.config.enableLayer2) {
      this.acNecessityAssessor = new ACNecessityAssessor(
        this.config.layer2.assessor,
        this.llmClient
      );

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

      logger.info('Layer 2 components initialized');
    }
  }

  /**
   * Process an incoming event through the dual-trigger pipeline
   */
  async processEvent(event: SystemEvent): Promise<DualTriggerResult> {
    const startTime = Date.now();
    this.stats.totalEventsProcessed++;

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
    const isUrgent = this.isUrgentEvent(event);
    if (isUrgent && this.acNecessityAssessor) {
      logger.info(`[DualTriggerACManager:${this.agentId}] Urgent event detected, bypassing Layer 1`);
      const agentContext = await this.buildAgentContext();
      const clusterSummary = this.eventToClusterSummary(event);
      this.injectOracleInsight(agentContext, event.id);

      const assessment = await this.acNecessityAssessor.assess(clusterSummary, agentContext);

      return this.processAssessmentResult(assessment, startTime, event);
    }

    // Ablation: Skip Layer 1 (spatiotemporal clustering) if disabled
    if (this.config.disableSpatiotemporal && this.acNecessityAssessor) {
      logger.info(`[DualTriggerACManager:${this.agentId}] Spatiotemporal disabled (ablation), processing directly through Layer 2`);
      const agentContext = await this.buildAgentContext();
      const clusterSummary = this.eventToClusterSummary(event);
      this.injectOracleInsight(agentContext, event.id);
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

  /**
   * Check if an event is urgent and should bypass Layer 1
   *
   * Uses EventContextNormalizer for consistent severity detection across
   * various payload formats (flat, nested-context, mixed).
   */

  /**
   * Inject oracle insight into the agent context when oracleMode is active.
   * Calls the oracleDataProvider callback to retrieve perfect ground-truth
   * information for the current (Agent, Event) pair.
   */
  private injectOracleInsight(agentContext: AgentContext, eventId: string): void {
    if (!this.config.oracleMode || !this.config.oracleDataProvider) return;

    const oracleInsight = this.config.oracleDataProvider(eventId);
    if (oracleInsight) {
      (agentContext as any).oracleInsight = oracleInsight;
      logger.info(`[DualTriggerACManager:${this.agentId}] Oracle insight injected for event ${eventId}: coverage=${oracleInsight.coverage}, type=${oracleInsight.interactionType}`);
    }
  }

  private isUrgentEvent(event: SystemEvent): boolean {
    const payload: EventPayload = event.payload;
    if (!payload) {
      logger.info(`[DualTriggerACManager:${this.agentId}] isUrgentEvent: No payload, not urgent`);
      return false;
    }

    // Use EventContextNormalizer for unified context access
    const normalizer = new EventContextNormalizer();
    const normalized = normalizer.normalizeQuick(event);

    // Log normalized context for debugging
    logger.info(`[DualTriggerACManager:${this.agentId}] isUrgentEvent checking:`, {
      normalizedSeverity: normalized.severity,
      isUrgent: normalized.isUrgent,
      isEmergency: normalized.isEmergency,
      eventPriority: event.priority,
      originalFormat: normalizer.normalize(event).originalFormat,
    });

    // Check normalized urgency
    if (normalized.isUrgent) {
      logger.info(`[DualTriggerACManager:${this.agentId}] URGENT: normalized.severity=${normalized.severity}`);
      return true;
    }

    // Check for emergency flag (additional safety check)
    if (normalized.isEmergency) {
      logger.info(`[DualTriggerACManager:${this.agentId}] URGENT: emergency detected`);
      return true;
    }

    // Check for high temperature (domain-specific rule)
    const tempValue = payload.temperature || payload.stateChange?.newValue;
    if (typeof tempValue === 'number' && tempValue > 30) {
      logger.info(`[DualTriggerACManager:${this.agentId}] URGENT: temperature=${tempValue} > 30`);
      return true;
    }

    // Check for poor air quality (domain-specific rule)
    if (typeof payload.aqi === 'number' && payload.aqi > 100) {
      logger.info(`[DualTriggerACManager:${this.agentId}] URGENT: aqi=${payload.aqi} > 100`);
      return true;
    }

    // Check for high event priority (URGENT or HIGH)
    if (event.priority === 'urgent' || event.priority === 'high') {
      logger.info(`[DualTriggerACManager:${this.agentId}] URGENT: event.priority=${event.priority}`);
      return true;
    }

    // Normal periodic readings should not be urgent
    if (normalized.temporalContext.isPeriodic) {
      logger.info(`[DualTriggerACManager:${this.agentId}] Not urgent: periodic event`);
      return false;
    }

    logger.info(`[DualTriggerACManager:${this.agentId}] Not urgent: no urgency indicators matched`);
    return false;
  }

  /**
   * Process Layer 2 decision after Layer 1 filtering
   */
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
        const payload = (originalEvent as any).payload || {};
        const isUrgent = payload.severity === 'high' || payload.severity === 'urgent'
          || payload.severity === 'critical' || payload.breach === true;

        // Override recommendation from event severity (matches eventToClusterSummary)
        adjustedSummary.recommendation = isUrgent ? 'immediate_action' : 'evaluate_with_llm';

        // Override significance from event severity (matches eventToClusterSummary)
        adjustedSummary.significance = isUrgent ? 'high' : 'medium';
      }

      // Step 1: Assess AC necessity using LLM
      const assessment = await this.acNecessityAssessor.assess(
        adjustedSummary,
        agentContext
      );

      logger.info(`Assessment result:`, {
        decision: assessment.decision,
        needsCollaboration: assessment.llmAssessment.needsCollaboration,
        confidence: assessment.llmAssessment.confidence.toFixed(2),
      });

      // Track decision distribution, timing, and confidence
      const decisionKey = assessment.decision || 'ignore';
      this.stats.layer2DecisionDistribution[decisionKey] = (this.stats.layer2DecisionDistribution[decisionKey] || 0) + 1;
      this.stats.totalAssessmentTimeMs += Date.now() - layer2StartTime;
      this.stats.assessmentCount++;
      if (assessment.llmAssessment?.confidence !== undefined) {
        this.stats.totalConfidence += assessment.llmAssessment.confidence;
        this.stats.confidenceCount++;
      }

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
        logger.info(`Agent will handle independently`);
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

  /**
   * Initiate AC based on assessment
   */
  private async initiateAC(
    assessment: ACNecessityAssessment,
    layer1Result: Layer1Result
  ): Promise<void> {
    logger.info(`Initiating AC for: ${assessment.llmAssessment.reasoning}`);

    if (!this.partnerNegotiator || !this.goalEngine) {
      logger.error('Layer 2 components not available for AC initiation');
      return;
    }

    try {
      // Step 2: Find partners
      const partnerSelection = await this.partnerNegotiator.findPartners(assessment);

      if (partnerSelection.selectedPartners.length === 0) {
        logger.warn('No partners found for AC');
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
    const clusterSummary = this.aggregatedEventToClusterSummary(event);

    const assessment = await this.acNecessityAssessor.assess(clusterSummary, agentContext);

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

    // Call assessment callback if registered
    if (this.assessmentCallback && event) {
      try {
        this.assessmentCallback(assessment, event);
      } catch (err) {
        logger.error(`[DualTriggerACManager:${this.agentId}] Assessment callback error:`, err);
      }
    }

    if (assessment.decision === 'initiate_ac') {
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

  /**
   * Build agent context for Layer 2
   *
   * Public so that tests can verify the context built from agent-assigned devices.
   */
  async buildAgentContext(): Promise<AgentContext> {
    // CRITICAL: Use agent-assigned devices, NOT environment devices
    // Devices are agent's internal resources, NOT visible to other agents
    let availableResources;

    if (this.agentDevices.length > 0) {
      // Get detailed device states from ResourceManager
      const resourceManager = this.resourceManager;
      availableResources = this.agentDevices.map(deviceInfo => {
        const resource = resourceManager?.getResource(deviceInfo.deviceId);
        return {
          deviceId: deviceInfo.deviceId,
          type: deviceInfo.type,
          capabilities: deviceInfo.capabilities,
          currentState: resource ? resource.getState() : {},
          location: this.config.disablePhysicalContext ? undefined : (resource ? resource.getLocation() : undefined),
          isOnline: resource ? resource.isAvailable() : true,
        };
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
      availableResources = devices.slice(0, 10).map(d => ({
        deviceId: d.id,
        type: d.type || 'unknown',
        capabilities: (d.capabilities || []).map(c => typeof c === 'string' ? c : c.name || c.type || String(c)),
        currentState: d.state || {},
        location: this.config.disablePhysicalContext ? undefined : d.location,
        isOnline: d.status === 'online',
      }));
      logger.info(`No agent devices set, using environment devices (${availableResources.length} devices)`);
    }

    // Get services from ServiceRegistry
    const serviceRegistry = this.serviceRegistry;
    const ownServices = serviceRegistry?.getOwnServices() || [];

    // Discover partner services from EnvironmentCenter (Service layer — architecture-safe)
    // Only exposes what other agents have explicitly published as services.
    // Ablation: strip discoverable services for text-only condition
    let discoverableServices: Array<{
      serviceName: string;
      capabilities: string[];
      providerAgentId: string;
      location?: string;
    }> = [];

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
        const physicalEnv = this.environment.physicalEnvironment;
        if (physicalEnv && typeof (physicalEnv as any).getZone === 'function') {
          for (const zoneId of managedZoneIds) {
            const zone = (physicalEnv as any).getZone(zoneId);
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

    return {
      agentId: this.agentId,
      agentName: this.agentName,
      capabilities: this.agentCapabilities,
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
      // Ablation flag for concise service mode
      conciseServiceMode: this.config.conciseServiceMode ?? false,
      // Smart-rules mode: deterministic rules with spatial + service reasoning (no LLM)
      smartRulesMode: this.config.smartRulesMode ?? false,
      tfidfBaselineMode: this.config.tfidfBaselineMode ?? false,
    };
    if (this.config.conciseServiceMode) {
      logger.info(`[DualTriggerACManager:${this.agentId}] conciseServiceMode enabled — services will be filtered to event-zone only`);
    }
  }

  /**
   * Convert SystemEvent to SpatialClusterSummary (for direct Layer 2 processing)
   */
  private eventToClusterSummary(event: SystemEvent): SpatialClusterSummary {
    const payload = event.payload || {};

    // Determine significance based on payload data
    const isUrgent = payload.severity === 'high' || payload.severity === 'urgent' || payload.severity === 'critical' || payload.breach === true;
    const significance: 'low' | 'medium' | 'high' | 'urgent' = isUrgent ? 'high' : 'medium';

    // Build summary that includes urgent event details
    const summaryParts = [`Event ${event.type} from ${event.source}`];
    if (payload.temperature !== undefined) {
      summaryParts.push(`temperature=${payload.temperature}`);
    }
    if (payload.threshold !== undefined) {
      summaryParts.push(`threshold=${payload.threshold}`);
    }
    if (payload.breach !== undefined) {
      summaryParts.push(`breach=${payload.breach}`);
    }
    if (payload.severity !== undefined) {
      summaryParts.push(`severity=${payload.severity}`);
    }

    // Extract zoneId from multiple sources to avoid 'unknown' fallback
    const extractedZoneId = (payload as any).zoneId
      || (event.metadata as any)?.zoneId;

    if (!extractedZoneId) {
      logger.warn(
        `[DualTriggerACManager:${this.agentId}] zoneId missing in event payload and metadata. ` +
        `eventId=${event.id}, type=${event.type}, source=${event.source}`,
      );
    }

    const zoneId = extractedZoneId || 'unknown';

    return {
      clusterId: `event-${event.id}`,
      region: {
        id: this.config.useVagueSpatial
          ? vagueZoneDescription(zoneId)
          : zoneId,
        center: payload.location || payload.coordinates || { x: 0, y: 0 },
        radius: 10,
        type: 'zone',
      },
      timeWindow: new Date().toISOString(),
      significance,
      summary: summaryParts.join(', '),
      findings: [{
        eventType: event.type,
        count: 1,
        trend: payload.trend || (isUrgent ? 'increasing' : 'stable'),
        anomaly: isUrgent,
        // CRITICAL: Include both payload and metadata for task parameters
        details: {
          ...payload,
          ...(event.metadata || {}),
        },
      }],
      recommendation: isUrgent ? 'immediate_action' : 'evaluate_with_llm',
    };
  }

  /**
   * Convert AggregatedEvent to SpatialClusterSummary
   */
  private aggregatedEventToClusterSummary(event: AggregatedEvent): SpatialClusterSummary {
    return {
      clusterId: `agg-${event.id}`,
      region: {
        id: 'unknown',
        center: { x: 0, y: 0 },
        radius: 10,
        type: 'zone',
      },
      timeWindow: `${event.firstOccurrence.toISOString()} - ${event.lastOccurrence.toISOString()}`,
      significance: event.significance,
      summary: `${event.count} events of type ${event.eventType}`,
      findings: [{
        eventType: event.eventType,
        count: event.count,
        trend: 'stable',
        anomaly: event.significance === 'high',
      }],
      recommendation: event.significance === 'high' ? 'immediate_action' : 'evaluate_with_llm',
    };
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
   * Set assessment callback for external monitoring
   * Called when AC necessity assessment completes
   */
  setAssessmentCallback(callback: (assessment: ACNecessityAssessment, event: SystemEvent) => void): void {
    this.assessmentCallback = callback;
    logger.info(`[DualTriggerACManager:${this.agentId}] Assessment callback set`);
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
}

export default DualTriggerACManager;
