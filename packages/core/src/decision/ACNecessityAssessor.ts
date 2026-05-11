/**
 * AC Necessity Assessor - Layer 2 Cognitive Decision
 *
 * This is the first component of Layer 2 in the dual-trigger mechanism.
 * It uses LLM to evaluate spatial cluster summaries and determine:
 * 1. Is Active Collaboration (AC) needed?
 * 2. What type of collaboration is needed?
 * 3. Which agent capabilities are required?
 * 4. What is the urgency level?
 *
 * Only called for clusters that pass Layer 1 filtering (~5% of events).
 */

import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
import { capabilityMatches, hasAllCapabilities } from '../utils/capabilityMatching.js';
import { charNgramJaccard, maxSimilarity, extractEventText } from '../utils/text-similarity.js';
// ============================================================================
// Types
// ============================================================================

/**
 * Agent personality traits that affect decision making
 */
const logger = createLogger('ACNecessityAssessor');

export interface AgentTraits {
  proactivity: number;      // 0-1: How proactive the agent is (higher = more likely to initiate)
  cautiousness: number;     // 0-1: How cautious the agent is (higher = higher threshold for action)
  socialPreference: number; // 0-1: Preference for collaboration (higher = more likely to collaborate)
  riskTolerance: number;    // 0-1: Tolerance for risky situations (higher = more willing to act in uncertainty)
}

/**
 * Motivation suggestion from Role & Goal system
 */
export interface MotivationSuggestion {
  overall: number;          // 0-1: Overall motivation level
  shouldAct: boolean;       // Whether agent should act
  suggestedAction: 'act' | 'collaborate' | 'explore' | 'monitor' | 'wait';
  confidence: number;       // 0-1: Confidence in the suggestion
}

/**
 * Context for the agent making the assessment
 */
export interface AgentContext {
  agentId: string;
  agentName: string;
  capabilities: string[];
  availableResources: {
    deviceId: string;
    type: string;
    capabilities: string[];
    currentState?: any;
    location?: any;
    isOnline?: boolean;
  }[];
  currentWorkload: 'idle' | 'light' | 'moderate' | 'heavy';
  recentCollaborations: string[]; // AC IDs
  currentCollaborations: number;

  // NEW: Agent personality traits for trait-aware decision making
  traits?: AgentTraits;

  // NEW: Motivation suggestion from Role & Goal system
  motivationSuggestion?: MotivationSuggestion;

  // NEW: Agent's own services (from ServiceRegistry)
  ownServices?: Array<{
    name: string;
    capabilities: string[];
    status: string;
  }>;

  // NEW: Environment state parameters
  environmentState?: Record<string, any>;

  // NEW: AC outcome history for feedback (past collaboration results)
  acHistory?: Array<{
    collaborationId: string;
    partners: string[];
    outcome: 'success' | 'partial' | 'failure';
    goalsTotal: number;
    goalsAchieved: number;
    completedAt: Date;
  }>;

  // NEW: Agent's managed zones — which zones this agent is responsible for
  // This is the agent's OWN information, not exposed from other agents
  managedZoneIds?: string[];

  // NEW: Agent's actuator zones — zones where agent has actuators (can physically act)
  // This is a subset of managedZoneIds. An agent may manage a zone (monitoring only)
  // but have no actuators there, meaning it cannot physically affect that zone.
  actuatorZoneIds?: string[];

  // NEW: Adjacent zones — zones adjacent to the agent's managed zones.
  // Used for zone-coverage preCheck to identify propagation-range events.
  adjacentZoneIds?: string[];

  // NEW: Discoverable partner services — services published by other agents
  // via the ServiceRegistry/ServiceBroker. Only includes what agents have
  // explicitly chosen to expose as services (architecture-safe).
  discoverableServices?: Array<{
    serviceName: string;
    capabilities: string[];
    providerAgentId: string;
    location?: string;
  }>;

  // NEW: Ablation flag — when true, filter services to event-zone only
  // and use compact descriptions in the LLM prompt.
  conciseServiceMode?: boolean;

  // NEW: Smart-rules mode — deterministic rules with spatial + service reasoning.
  // When true, preCheck never falls through to LLM; instead applies rule-based
  // collaboration decisions using coverage + service registry information.
  smartRulesMode?: boolean;

  // When true, uses character n-gram Jaccard similarity for capability matching
  // instead of LLM reasoning. A realistic non-LLM baseline using standard IR techniques.
  tfidfBaselineMode?: boolean;

  // NEW: Oracle insight — perfect ground-truth information injected for
  // the oracle baseline condition. Same LLM, same prompt, better data.
  oracleInsight?: {
    coverage: number;
    coverageDescription: string;
    gapCapabilities: string[];
    matchedCapabilities: string[];
    interactionType: string;
    correctDecision: string;
    idealPartners: Array<{
      agentId: string;
      capabilities: string[];
      zoneId: string;
    }>;
    eventZoneId: string;
  };
}

/**
 * LLM-based assessment result
 */
export interface LLMAssessment {
  needsCollaboration: boolean;
  reasoning: string;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  suggestedPartnerTypes: string[];
  requiredCapabilities: string[];
  confidence: number; // 0-1
  estimatedDuration: number; // milliseconds
  potentialRisks: string[];
  /** Full raw LLM response for debugging/analysis */
  rawResponse?: string;
}

/**
 * Complete assessment result
 */
export interface ACNecessityAssessment {
  clusterSummary: SpatialClusterSummary;
  agentContext: AgentContext;
  llmAssessment: LLMAssessment;
  decision: 'initiate_ac' | 'handle_independently' | 'defer' | 'ignore';
  timestamp: Date;

  /** Whether the decision came from preCheck rules or LLM */
  decisionSource: 'precheck' | 'llm';

  // NEW: Task parameters extracted from original event
  taskParameters?: Record<string, any>;
}

/**
 * Configuration for ACNecessityAssessor
 */
export interface AssessorConfig {
  // LLM settings
  llmTimeout: number; // milliseconds
  maxRetries: number;

  // Decision thresholds
  confidenceThreshold: number; // Minimum confidence to initiate AC
  maxWorkloadThreshold: number; // Maximum workload to accept new AC

  // Prompt templates
  systemPrompt: string;
  useStructuredOutput: boolean;
}

const DEFAULT_CONFIG: AssessorConfig = {
  llmTimeout: 5000,
  maxRetries: 2,

  confidenceThreshold: 0.5,
  maxWorkloadThreshold: 3, // Max 3 concurrent collaborations

  systemPrompt: `You are an IoT agent deciding whether to initiate Active Collaboration (AC).
AC means: find and coordinate with OTHER agents who can handle this event.
COLLABORATE = "I will alert and coordinate with capable agents" — NOT "I will do it myself."

Decision rules (apply in order):
1. If ROLE=SENSOR-ONLY → COLLABORATE (you detected this event — OTHER agents must act)
2. If COVERAGE=NONE but you HAVE all required capabilities → COLLABORATE (delegate to agent that can physically reach the zone)
3. If COVERAGE=NONE AND you LACK required capabilities → do NOT collaborate (this event is not your responsibility)
4. If Caps contain ALL required capabilities AND COVERAGE=DIRECT → INDEPENDENT
5. Otherwise → COLLABORATE (you lack something needed, find a partner)

CRITICAL:
- Event severity NEVER changes whether you need collaboration.
- ROLE=SENSOR-ONLY means you detect events. Detection IS your contribution — next step is ALWAYS notify capable agents.
- "Have capabilities but no coverage" means you should delegate to an agent with zone coverage.
- Sensing capabilities (temperature-sensing, motion-sensing) are NOT actuating capabilities.
- AVAILABLE_PARTNERS lists OTHER agents' services you can coordinate with — NOT your capabilities.

Answer COLLABORATE or INDEPENDENT on the first line.
Briefly explain on the next line.`,

  useStructuredOutput: true,
};

// ============================================================================
// ACNecessityAssessor
// ============================================================================

export class ACNecessityAssessor {
  private config: AssessorConfig;
  private llmClient: LLMClient | null = null;

  // Statistics
  private stats = {
    totalAssessments: 0,
    acInitiated: 0,
    handledIndependently: 0,
    deferred: 0,
    ignored: 0,
    llmErrors: 0,
  };

  constructor(
    config: Partial<AssessorConfig>,
    llmClient?: LLMClient
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llmClient = llmClient || null;

    logger.info('Initialized with config:', {
      confidenceThreshold: this.config.confidenceThreshold,
      maxWorkload: this.config.maxWorkloadThreshold,
    });
  }

  /**
   * Set LLM client
   */
  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
    logger.info('LLM client set');
  }

  /**
   * Assess if AC is needed for a cluster summary
   */
  async assess(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): Promise<ACNecessityAssessment> {
    this.stats.totalAssessments++;
    const timestamp = new Date();

    // NEW: Extract task parameters from cluster summary findings
    const taskParameters = this.extractTaskParameters(clusterSummary);

    // Quick rule-based pre-check
    const preCheckResult = this.preCheck(clusterSummary, agentContext);
    if (preCheckResult.decision !== 'needs_llm') {
      this.updateDecisionStats(preCheckResult.decision);

      // Infer capabilities from cluster summary when pre-check decides to initiate AC
      const inferredCapabilities = preCheckResult.decision === 'initiate_ac'
        ? this.inferCapabilitiesFromCluster(clusterSummary)
        : [];
      const inferredPartnerTypes = preCheckResult.decision === 'initiate_ac'
        ? this.inferPartnerTypesFromCluster(clusterSummary)
        : [];

      return {
        clusterSummary,
        agentContext,
        llmAssessment: {
          needsCollaboration: preCheckResult.decision === 'initiate_ac',
          reasoning: preCheckResult.reasoning,
          urgency: clusterSummary.significance,
          suggestedPartnerTypes: inferredPartnerTypes,
          requiredCapabilities: inferredCapabilities,
          confidence: 1.0,
          estimatedDuration: preCheckResult.decision === 'initiate_ac' ? 60000 : 0,
          potentialRisks: preCheckResult.decision === 'initiate_ac'
            ? ['Urgent event requires immediate action']
            : [],
        },
        decision: preCheckResult.decision,
        decisionSource: 'precheck',
        timestamp,
        taskParameters,
      };
    }

    // LLM-based assessment
    try {
      const llmAssessment = await this.performLLMAssessment(clusterSummary, agentContext);
      const decision = this.makeDecision(llmAssessment, agentContext);

      this.updateDecisionStats(decision);

      return {
        clusterSummary,
        agentContext,
        llmAssessment,
        decision,
        decisionSource: 'llm',
        timestamp,
        taskParameters,
      };
    } catch (error: unknown) {
      this.stats.llmErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      // Fail Early: Log with full context and re-throw error instead of returning fallback
      logger.error('LLM assessment failed for cluster', clusterSummary.clusterId, ':', error);
      throw new Error(`[ACNecessityAssessor] LLM assessment failed for cluster ${clusterSummary.clusterId}: ${msg}`);
    }
  }

  /**
   * Pre-check before LLM assessment
   * Now considers agent traits for trait-aware decision making
   */
  private preCheck(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): { decision: ACNecessityAssessment['decision'] | 'needs_llm'; reasoning: string } {
    const traits = agentContext.traits;
    const motivation = agentContext.motivationSuggestion;

    // =====================================
    // STEP 0a: Sensor-only agent check
    // If the agent has NO actuator zones at all, it is a pure sensor agent.
    // Per the formal model (Definition 6): sensor-only agents always initiate_ac
    // because detecting an event IS their contribution — they must notify
    // capable agents for physical action.
    // This handles all sensor-only Type D pairs without LLM involvement.
    // =====================================
    const isSensorOnly = !agentContext.actuatorZoneIds || agentContext.actuatorZoneIds.length === 0;
    if (isSensorOnly) {
      logger.info(`Sensor-only preCheck: ${agentContext.agentId} has no actuators → initiate_ac`);
      return {
        decision: 'initiate_ac',
        reasoning: `Agent ${agentContext.agentId} is a pure sensor agent with no actuator capabilities. Detected event requires notifying capable agents for physical action.`,
      };
    }

    // =====================================
    // STEP 0b: Zone-coverage check (Layer 1 rule)
    // Use ONLY actuatorZoneIds (zones with actuators) for coverage check.
    // Do NOT fallback to managedZoneIds — a sensor-only agent has no physical
    // actuation coverage even if it monitors a zone. This must match the
    // ground truth calculator's Coverage computation which only considers
    // actuator/hybrid devices and their propagation range.
    //
    // IMPORTANT: Must distinguish Type D (coverage=0, gap≠∅) from
    // Type E (coverage=0, gap=∅). Type D correctly defers/ignores,
    // but Type E means the agent HAS all capabilities yet cannot
    // physically reach the event — ground truth expects initiate_ac
    // (delegate to an agent with zone coverage).
    // =====================================
    const coverageZones = agentContext.actuatorZoneIds ?? [];
    if (coverageZones.length > 0) {
      const eventZone = clusterSummary.region.id;
      const hasDirectCoverage = coverageZones.includes(eventZone);

      // IMPORTANT: Both direct and propagation coverage exclude an agent from
      // Type D/E classification. Propagation is computed from ACTUATOR zones
      // (not managed zones), matching ground truth's EffectRange computation.
      // If the agent has either direct or propagation coverage, it's Type B/C
      // (can partially or fully affect the zone) → fall through to LLM.
      // Only agents with NO coverage at all are Type D/E → handled here.
      const hasPropagationCoverage = agentContext.adjacentZoneIds?.includes(eventZone) ?? false;
      if (!hasDirectCoverage && !hasPropagationCoverage) {
        // Agent has NO coverage (neither direct nor propagation) of the event zone.
        // Use requiredCapabilities from event details (ground truth source) if available;
        // fall back to inferred capabilities.
        const explicitCapabilities = clusterSummary.findings[0]?.details?.requiredCapabilities;
        const requiredCapabilities = Array.isArray(explicitCapabilities)
          ? (explicitCapabilities as string[]).map(c => c.toLowerCase())
          : this.inferCapabilitiesFromCluster(clusterSummary);
        const missingCapabilities = requiredCapabilities.filter(cap =>
          !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
        );

        if (missingCapabilities.length === 0) {
          // Type E: Agent has no direct coverage AND no capability gap.
          // This includes both: (1) agent has all required capabilities but no zone coverage,
          // and (2) no capabilities are required (informational events where agent still
          // cannot reach the zone). Ground truth: initiate_ac for all Type E cases.
          logger.info(`Type E preCheck: ${agentContext.agentId} has no direct coverage of ${eventZone} and no capability gap (required: [${requiredCapabilities.join(', ')}]) → initiate_ac`);
          return {
            decision: 'initiate_ac',
            reasoning: `Agent has no direct actuator coverage of zone ${eventZone} (actuator zones: ${coverageZones.join(', ')}). ${requiredCapabilities.length > 0 ? `Has all required capabilities [${requiredCapabilities.join(', ')}] but must delegate.` : 'No specific capabilities required but cannot reach zone — must notify agents with coverage.'}`,
          };
        } else {
          // Type D: Agent has no direct coverage AND lacks capabilities.
          // Ground truth: ignore if severity=low or no required capabilities, else defer.
          const eventSeverity = clusterSummary.findings[0]?.details?.severity
            ?? (clusterSummary.significance === 'urgent' ? 'critical' : clusterSummary.significance);
          const hasRequiredCaps = requiredCapabilities.length > 0;

          if (eventSeverity === 'low' || !hasRequiredCaps) {
            logger.info(`Type D preCheck: event in ${eventZone}, agent actuator zones [${coverageZones.join(',')}], severity=${eventSeverity}, hasRequiredCaps=${hasRequiredCaps}. Ignoring.`);
            return {
              decision: 'ignore',
              reasoning: `Event in zone ${eventZone} is outside agent's actuator coverage (actuator zones: ${coverageZones.join(', ')}). Not relevant to this agent.`,
            };
          } else {
            logger.info(`Type D preCheck: event in ${eventZone}, agent actuator zones [${coverageZones.join(',')}], severity=${eventSeverity}. Deferring.`);
            return {
              decision: 'defer',
              reasoning: `Event in zone ${eventZone} is outside agent's actuator coverage (actuator zones: ${coverageZones.join(', ')}). Deferring to agents with relevant coverage.`,
            };
          }
        }
      }
    }

    // =====================================
    // STEP 0b: Type A preCheck (direct coverage + no capability gap)
    // If the agent has direct actuator coverage in the event zone AND
    // possesses ALL required capabilities, it can handle the event
    // independently without needing collaboration or LLM assessment.
    // This matches the GroundTruthCalculator's Type A classification:
    // Coverage=1 AND Gap=∅ → handle_independently.
    //
    // The capability coverage check is orthogonal to the cluster's
    // severity recommendation — even high-severity events should be
    // handled independently when the agent has everything needed.
    // =====================================
    if (coverageZones.length > 0) {
      const eventZone = clusterSummary.region.id;
      const hasDirectCoverage = coverageZones.includes(eventZone);

      if (hasDirectCoverage) {
        // Use requiredCapabilities from findings details (passed through event metadata)
        // if available; fall back to inferred capabilities.
        const explicitCapabilities = clusterSummary.findings[0]?.details?.requiredCapabilities;
        // Accept empty array (means no capabilities required — e.g., ignore events)
        const requiredCapabilities = Array.isArray(explicitCapabilities)
          ? explicitCapabilities as string[]
          : this.inferCapabilitiesFromCluster(clusterSummary);
        const missingCapabilities = requiredCapabilities.filter(cap =>
          !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
        );

        if (missingCapabilities.length === 0) {
          // Type A: Agent has direct coverage AND no capability gap.
          // This covers both: (1) agent has all required capabilities, and
          // (2) no capabilities are required (routine/normal events).
          logger.info(`Type A preCheck: agent has direct coverage in ${eventZone} and no capability gap (required: [${requiredCapabilities.join(', ')}]). Handling independently.`);
          return {
            decision: 'handle_independently',
            reasoning: `Agent has direct actuator coverage in ${eventZone} and all required capabilities (${requiredCapabilities.length > 0 ? requiredCapabilities.join(', ') : 'none required'}). Can handle this event independently without collaboration.`,
          };
        }
      }
    }

    // Note: Capability gap analysis is provided to the LLM as context
    // (via injectCapabilityGapContext) rather than bypassing the LLM decision.
    // The LLM should make the final collaboration decision based on all
    // available information including its capabilities, spatial context, and
    // event severity.

    // Check if agent is overloaded — use the workload classification from
    // DualTriggerACManager.buildAgentContext() which respects maxConcurrentACs.
    const isUrgent = clusterSummary.significance === 'urgent' ||
                     clusterSummary.significance === 'high';

    if (agentContext.currentWorkload === 'heavy' && !isUrgent) {
      return {
        decision: 'defer',
        reasoning: `Agent at heavy workload, deferring non-urgent event`,
      };
    }

    // NEW: If motivation system strongly suggests collaboration, honor it
    if (motivation?.suggestedAction === 'collaborate' && motivation.overall > 0.6) {
      return {
        decision: 'initiate_ac',
        reasoning: `Motivation engine suggests collaboration (motivation=${motivation.overall.toFixed(2)})`,
      };
    }

    // Check cluster significance
    if (clusterSummary.recommendation === 'ignore') {
      return {
        decision: 'ignore',
        reasoning: 'Cluster marked as ignorable by Layer 1',
      };
    }

    if (clusterSummary.recommendation === 'monitor') {
      // Proactive agents may want to evaluate further
      if (traits && traits.proactivity > 0.7) {
        return {
          decision: 'needs_llm',
          reasoning: 'Proactive agent wants to evaluate monitored event further',
        };
      }
      return {
        decision: 'defer',
        reasoning: 'Cluster marked for monitoring only',
      };
    }

    // Immediate action needed - let the LLM decide the appropriate response.
    // The LLM should evaluate whether to collaborate, handle independently, or defer
    // based on the full context including capabilities, spatial awareness, and severity.
    // Previously this short-circuited to initiate_ac for urgent events, bypassing
    // the LLM entirely. The LLM provides richer context for partner selection
    // and goal formulation, which is essential for execution-phase evaluation.
    if (clusterSummary.recommendation === 'immediate_action') {
      logger.info(`immediate_action recommendation: deferring to LLM for context-rich decision`);
      // Fall through to LLM assessment
    }

    // Smart-rules mode: deterministic rules without LLM fallback.
    // Uses spatial coverage + service registry to make collaboration decisions.
    if (agentContext.smartRulesMode) {
      const requiredCapabilities = this.inferCapabilitiesFromCluster(clusterSummary);
      const missingCapabilities = requiredCapabilities.filter(cap =>
        !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
      );
      const hasPartnerServices = (agentContext.discoverableServices?.length ?? 0) > 0;

      if (missingCapabilities.length > 0 && hasPartnerServices) {
        // Agent lacks capabilities but partners are available → collaborate
        logger.info(`Smart-rules: agent lacks [${missingCapabilities.join(',')}] but partners available → initiate_ac`);
        return {
          decision: 'initiate_ac',
          reasoning: `Agent lacks required capabilities [${missingCapabilities.join(', ')}] but partner services are available. Initiating collaboration.`,
        };
      } else if (missingCapabilities.length > 0) {
        // Agent lacks capabilities but no partners → handle independently (best effort)
        logger.info(`Smart-rules: agent lacks [${missingCapabilities.join(',')}] and no partners → handle_independently`);
        return {
          decision: 'handle_independently',
          reasoning: `Agent lacks capabilities [${missingCapabilities.join(', ')}] and no partner services available. Handling independently.`,
        };
      } else {
        // Agent has all capabilities → handle independently
        logger.info(`Smart-rules: agent has all capabilities → handle_independently`);
        return {
          decision: 'handle_independently',
          reasoning: `Agent has all required capabilities. Handling independently.`,
        };
      }
    }

    // TF-IDF baseline mode: character n-gram Jaccard similarity for capability matching.
    // A realistic non-LLM baseline using standard IR techniques. Uses the same raw
    // information as full-AC (agent capabilities, partner service capabilities) but
    // processes it through text similarity rather than LLM reasoning.
    if (agentContext.tfidfBaselineMode) {
      const eventText = extractEventText(clusterSummary);

      // Compute similarity between event text and agent's own capabilities
      const selfSim = maxSimilarity(eventText, agentContext.capabilities);

      // Compute similarity between event text and partner service capabilities
      const partnerCaps = (agentContext.discoverableServices ?? [])
        .flatMap(s => s.capabilities);
      const partnerSim = maxSimilarity(eventText, partnerCaps);

      // Decision threshold: controls the balance between false positives and
      // false negatives. At 0.25, partial matches (e.g., "temperature" ≈
      // "temperature-monitoring") pass, but the system cannot distinguish
      // monitoring from control — a realistic limitation of text similarity.
      const THRESHOLD = 0.25;

      if (selfSim > THRESHOLD) {
        logger.info(`TF-IDF baseline: event="${eventText}" selfSim=${selfSim.toFixed(3)} > ${THRESHOLD} → handle_independently`);
        return {
          decision: 'handle_independently',
          reasoning: `Text similarity match (score=${selfSim.toFixed(3)}) with own capabilities. Handling independently.`,
        };
      } else if (partnerSim > THRESHOLD && (agentContext.discoverableServices?.length ?? 0) > 0) {
        logger.info(`TF-IDF baseline: event="${eventText}" selfSim=${selfSim.toFixed(3)}, partnerSim=${partnerSim.toFixed(3)} → initiate_ac`);
        return {
          decision: 'initiate_ac',
          reasoning: `No capability match (self=${selfSim.toFixed(3)}) but partner match (score=${partnerSim.toFixed(3)}). Initiating collaboration.`,
        };
      } else {
        logger.info(`TF-IDF baseline: event="${eventText}" selfSim=${selfSim.toFixed(3)}, partnerSim=${partnerSim.toFixed(3)} → handle_independently (no match)`);
        return {
          decision: 'handle_independently',
          reasoning: `No significant text similarity match (self=${selfSim.toFixed(3)}, partner=${partnerSim.toFixed(3)}). Handling independently.`,
        };
      }
    }

    // Needs LLM evaluation
    return {
      decision: 'needs_llm',
      reasoning: 'Cluster requires LLM-based assessment',
    };
  }

  /**
   * Check if agent has required capabilities
   */
  private hasRequiredCapabilities(agentContext: AgentContext, clusterSummary: SpatialClusterSummary): boolean {
    const requiredCapabilities = this.inferCapabilitiesFromCluster(clusterSummary);
    if (requiredCapabilities.length === 0) return true;

    return requiredCapabilities.every(cap =>
      agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
    );
  }

  /**
   * Infer required capabilities from cluster summary
   * Maps event types to required capabilities for handling them
   */
  private inferCapabilitiesFromCluster(clusterSummary: SpatialClusterSummary): string[] {
    const capabilities: Set<string> = new Set();

    // Analyze findings to infer capabilities
    for (const finding of clusterSummary.findings) {
      // Safety check: eventType may be undefined
      const eventType = (finding.eventType || '').toLowerCase();

      // Check payload details for parameter-specific capabilities.
      // The eventType may be generic (e.g., ENVIRONMENT_PARAM_CHANGED),
      // but the details contain the actual parameter type (e.g., 'temperature').
      const details = finding.details as Record<string, unknown> | undefined;
      const parameter = (details?.parameter as string || '').toLowerCase();
      const detailsEventType = (details?.eventType as string || '').toLowerCase();

      // Temperature-related events (check both eventType and details)
      const isTemperatureEvent = eventType.includes('temperature') || eventType.includes('temp')
        || parameter === 'temperature'
        || detailsEventType.includes('temperature');

      if (isTemperatureEvent) {
        if (finding.anomaly || finding.trend === 'increasing') {
          capabilities.add('cooling');
          capabilities.add('temperature-control');
        } else if (finding.trend === 'decreasing') {
          capabilities.add('heating');
          capabilities.add('temperature-control');
        }
      }

      // Humidity-related events (check both eventType and details)
      const isHumidityEvent = eventType.includes('humidity') || eventType.includes('moisture')
        || parameter === 'humidity';

      if (isHumidityEvent) {
        if (finding.anomaly || finding.trend === 'increasing') {
          capabilities.add('dehumidifier-control');
        } else if (finding.trend === 'decreasing') {
          capabilities.add('humidifier-control');
        }
        capabilities.add('humidity-control');
      }

      // Motion/security events
      if (eventType.includes('motion') || eventType.includes('movement') || eventType.includes('security')) {
        capabilities.add('monitoring');
        capabilities.add('security');
      }

      // Device state events — infer from context
      if (eventType.includes('device') || eventType.includes('state')) {
        const details = finding.details as Record<string, unknown> | undefined;
        const stateChange = details?.stateChange as { property?: string } | undefined;

        if (stateChange?.property === 'temperature'
            || details?.temperature !== undefined
            || (finding as Record<string, unknown>).temperature !== undefined) {
          // Temperature-specific: infer temperature/HVAC capabilities
          capabilities.add('temperature-control');
          capabilities.add('hvac-control');
        } else {
          // Generic device control
          capabilities.add('device-control');
          capabilities.add('actuation');
        }
      }

      // Power/energy events
      if (eventType.includes('power') || eventType.includes('energy') || eventType.includes('electric')) {
        capabilities.add('power-management');
        capabilities.add('device-control');
      }

      // Light/illumination events
      if (eventType.includes('light') || eventType.includes('illumination') || eventType.includes('brightness')) {
        capabilities.add('lighting-control');
      }

      // Only add emergency-response for anomalies that are NOT temperature,
      // humidity, or light related (those have specific capabilities above).
      if (finding.anomaly && !isTemperatureEvent && !isHumidityEvent
          && !eventType.includes('light') && parameter !== 'light') {
        capabilities.add('emergency-response');
        capabilities.add('monitoring');
      }
    }

    // Also check summary for additional context
    const summary = clusterSummary.summary.toLowerCase();
    if (summary.includes('temperature') && (summary.includes('high') || summary.includes('breach'))) {
      capabilities.add('cooling');
      capabilities.add('temperature-control');
    }
    if (summary.includes('urgent') || summary.includes('critical')) {
      capabilities.add('emergency-response');
    }

    // NEW: Check finding details (task payload) for capability hints
    for (const finding of clusterSummary.findings) {
      const details = finding.details;
      if (details) {
        // First, check if requiredCapabilities is explicitly defined in the task
        // This is the most reliable source of capability requirements
        if (details.requiredCapabilities && Array.isArray(details.requiredCapabilities)) {
          for (const cap of details.requiredCapabilities) {
            if (typeof cap === 'string') {
              capabilities.add(cap.toLowerCase());
              logger.info(`Added required capability from task: ${cap.toLowerCase()}`);
            }
          }
        }

        const taskTitle = (details.taskTitle || '').toLowerCase();
        const taskDescription = (details.taskDescription || details.description || '').toLowerCase();
        const combined = `${taskTitle} ${taskDescription}`;

        // Temperature-related tasks
        if (combined.includes('temperature') || combined.includes('temp') || combined.includes('thermostat')) {
          capabilities.add('temperature-control');
          capabilities.add('hvac-control');
          capabilities.add('climate-control');
        }

        // Light-related tasks
        if (combined.includes('light') || combined.includes('brightness') || combined.includes('illumination')) {
          capabilities.add('lighting-control');
          capabilities.add('light-control');
          capabilities.add('actuator-control');
        }

        // Humidity-related tasks
        if (combined.includes('humidity') || combined.includes('moisture')) {
          capabilities.add('humidity-control');
        }

        // Motion/security tasks
        if (combined.includes('motion') || combined.includes('security') || combined.includes('movement')) {
          capabilities.add('monitoring');
          capabilities.add('security');
        }

        // Device control tasks
        if (combined.includes('device') || combined.includes('control') || combined.includes('adjust')) {
          capabilities.add('device-control');
          capabilities.add('actuation');
        }
      }
    }

    // Ensure at least some capability is returned for urgent events
    if (capabilities.size === 0 && clusterSummary.significance === 'urgent') {
      capabilities.add('emergency-response');
      capabilities.add('monitoring');
    }

    const result = Array.from(capabilities);
    logger.info(`Inferred capabilities from cluster: ${result.join(', ')}`);
    return result;
  }

  /**
   * Infer partner agent types from cluster summary
   */
  private inferPartnerTypesFromCluster(clusterSummary: SpatialClusterSummary): string[] {
    const partnerTypes: Set<string> = new Set();

    // Analyze findings to infer partner types
    for (const finding of clusterSummary.findings) {
      // Safety check: eventType may be undefined
      const eventType = (finding.eventType || '').toLowerCase();

      if (eventType.includes('temperature') || eventType.includes('temp')) {
        partnerTypes.add('climate-control-agent');
        partnerTypes.add('temperature-monitor-agent');
      }

      if (eventType.includes('humidity') || eventType.includes('moisture')) {
        partnerTypes.add('humidity-control-agent');
      }

      if (eventType.includes('motion') || eventType.includes('security')) {
        partnerTypes.add('security-agent');
        partnerTypes.add('surveillance-agent');
      }

      if (eventType.includes('device')) {
        partnerTypes.add('device-manager-agent');
      }

      if (finding.anomaly) {
        partnerTypes.add('emergency-response-agent');
      }
    }

    // Default partner types for urgent events
    if (partnerTypes.size === 0 && clusterSummary.significance === 'urgent') {
      partnerTypes.add('cognitive-agent');
    }

    const result = Array.from(partnerTypes);
    logger.info(`Inferred partner types from cluster: ${result.join(', ')}`);
    return result;
  }

  /**
   * Extract task parameters from cluster summary findings
   * This preserves parameters from the original event payload
   */
  private extractTaskParameters(clusterSummary: SpatialClusterSummary): Record<string, any> | undefined {
    const params: Record<string, any> = {};

    // Check findings for task details
    for (const finding of clusterSummary.findings) {
      if (finding.details) {
        // Handle nested parameters object
        if (finding.details.parameters) {
          // Extract from nested parameters object
          Object.assign(params, finding.details.parameters);
        } else {
          // Merge details directly if not nested
          Object.assign(params, finding.details);
        }
      }
    }

    // Also check the raw summary for embedded parameters (fallback)
    const summary = clusterSummary.summary;
    if (summary.includes('targetTemp') || summary.includes('targetTemperature')) {
      const tempMatch = summary.match(/targetTemp(?:erature)?[:\s]*(\d+)/i);
      if (tempMatch) {
        params.targetTemp = parseInt(tempMatch[1], 10);
      }
    }

    if (Object.keys(params).length > 0) {
      logger.info(`Extracted task parameters:`, params);
      return params;
    }

    return undefined;
  }

  /**
   * Extract task information from cluster summary
   */
  private extractTaskInfoFromCluster(clusterSummary: SpatialClusterSummary): {
    title: string;
    description: string;
    type: string;
    priority: string;
    capabilities: string[];
  } {
    const info: {
      title: string;
      description: string;
      type: string;
      priority: string;
      capabilities: string[];
    } = {
      title: '',
      description: '',
      type: '',
      priority: '',
      capabilities: [],
    };

    // Try to extract from findings first
    if (clusterSummary.findings?.length > 0) {
      const firstFinding = clusterSummary.findings[0];
      const details = firstFinding.details || {};
      info.title = details.taskTitle || details.title || '';
      info.description = details.taskDescription || details.description || '';
      info.type = details.taskType || details.type || '';
      info.priority = details.priority || details.severity || '';
      info.capabilities = details.requiredCapabilities || [];
    }

    // If no title from first finding, try subsequent findings
    if (!info.title && clusterSummary.findings?.length > 1) {
      for (let i = 1; i < clusterSummary.findings.length; i++) {
        const finding = clusterSummary.findings[i];
        const details = finding.details || {};
        if (details.taskTitle || details.title) {
          info.title = details.taskTitle || details.title || info.title;
          info.description = details.taskDescription || details.description || info.description;
          info.type = details.taskType || details.type || info.type;
          info.priority = details.priority || details.severity || info.priority;
          info.capabilities = details.requiredCapabilities || info.capabilities;
          break;
        }
      }
    }

    // Try to extract from summary
    if (!info.title) {
      const summaryMatch = clusterSummary.summary?.match(/task[=:]\s*([^,]+)/);
      if (summaryMatch) {
        info.title = summaryMatch[1] || info.title;
        info.description = summaryMatch[2] || info.description;
      }
    }

    return info;
  }

  /**
   * Perform LLM-based assessment
   */
  private async performLLMAssessment(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): Promise<LLMAssessment> {
    if (!this.llmClient) {
      throw new Error('LLM client not available');
    }

    const prompt = this.buildPrompt(clusterSummary, agentContext);

    const response = await this.llmClient.quickChat(prompt, this.config.systemPrompt);
    const responseText = typeof response === 'string' ? response : response.content;

    return this.parseLLMResponse(responseText, clusterSummary, agentContext);
  }

  /**
   * Build prompt for LLM
   */
  private buildPrompt(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): string {
    // Compact managed zones (agent's own information — Resource layer)
    const zonesInfo = agentContext.managedZoneIds?.length
      ? ` | Zones=[${agentContext.managedZoneIds.join(',')}]`
      : '';

    // Physical coverage info: distinguish actuator zones from managed zones
    const actuatorZonesInfo = agentContext.actuatorZoneIds?.length
      ? `\nACTUATORS: [${agentContext.actuatorZoneIds.join(',')}] (zones where you can physically act)`
      : '';

    // Sensor-only status indicator for LLM context
    const isSensorOnly = !agentContext.actuatorZoneIds || agentContext.actuatorZoneIds.length === 0;
    const sensorOnlyInfo = isSensorOnly
      ? '\nROLE: SENSOR-ONLY → You detect events and alert capable agents. Always COLLABORATE.'
      : '';

    // Coverage status: explicit relationship between event zone and agent's physical reach
    const eventZone = clusterSummary.region.id;
    const hasActuatorInZone = agentContext.actuatorZoneIds?.includes(eventZone);
    const hasAdjacentCoverage = agentContext.adjacentZoneIds?.includes(eventZone);
    const coverageInfo = isSensorOnly
      ? '\nCOVERAGE: NONE → Delegate to AVAILABLE_PARTNERS who have actuators.'
      : agentContext.actuatorZoneIds !== undefined
        ? `\nCOVERAGE: ${hasActuatorInZone ? 'DIRECT' : hasAdjacentCoverage ? 'PROPAGATION' : 'NONE'} — ${hasActuatorInZone ? 'You have actuators in this zone.' : hasAdjacentCoverage ? 'You can affect this zone via physical propagation from adjacent zones.' : `You CANNOT physically reach this zone (your actuator zones: [${agentContext.actuatorZoneIds.join(',')}]). Check EVENT_NEEDS: if your Caps match, COLLABORATE to delegate. If you lack those Caps, this is not your responsibility.`}`
        : '';

    // Build service information — handle concise-service ablation mode
    let servicesInfo: string;
    if (agentContext.conciseServiceMode) {
      // Concise mode: filter to services with location matching event zone,
      // use compact format (name only, no capabilities list).
      const allSvcs = agentContext.discoverableServices ?? [];
      const filteredSvcs = allSvcs.filter(s => s.location === eventZone);
      logger.info(`[ACNecessityAssessor] conciseServiceMode: ${allSvcs.length} total services, ${filteredSvcs.length} in event zone ${eventZone}`);
      servicesInfo = filteredSvcs.length > 0
        ? `AVAILABLE_PARTNERS: ${filteredSvcs.length} (other agents you can collaborate with): ${filteredSvcs.map(s => s.serviceName).join(',')}`
        : 'AVAILABLE_PARTNERS: 0 (no other agents nearby)';
    } else {
      servicesInfo = agentContext.discoverableServices?.length
        ? `AVAILABLE_PARTNERS (other agents' services, NOT yours): ${agentContext.discoverableServices.map(s => `${s.serviceName}(${s.capabilities.join(',')})`).join(', ')}`
        : 'AVAILABLE_PARTNERS: 0 (no other agents available)';
    }

    // Required capabilities for this event (from cluster analysis)
    const eventNeeds = this.inferCapabilitiesFromCluster(clusterSummary);
    const needsInfo = eventNeeds.length > 0
      ? `\nEVENT_NEEDS: [${eventNeeds.join(', ')}] — compare with your Caps above`
      : '';

    return `AGENT: ${agentContext.agentName} | Caps=[${agentContext.capabilities.join(',')}]${zonesInfo}
EVENT: Zone=${clusterSummary.region.id} | ${clusterSummary.summary}${needsInfo}
${actuatorZonesInfo}${sensorOnlyInfo}${coverageInfo}
${servicesInfo}
${this.buildOracleSection(agentContext)}Should this agent initiate collaboration?
DECISION:`;
  }

  /**
   * Build oracle insight section for the prompt.
   * When oracle mode is active, injects perfect ground-truth information
   * about coverage, gap, and ideal partners into the LLM prompt.
   * Returns empty string when oracle mode is not active.
   */
  private buildOracleSection(agentContext: AgentContext): string {
    if (!agentContext.oracleInsight) return '';

    const oi = agentContext.oracleInsight;
    const gapStr = oi.gapCapabilities.length > 0
      ? `GAP=[${oi.gapCapabilities.join(', ')}]`
      : 'GAP=[]';
    const partnersStr = oi.idealPartners.length > 0
      ? ` | Partners: ${oi.idealPartners.map(p => `${p.agentId}(${p.capabilities.join(',')}@${p.zoneId})`).join('; ')}`
      : ' | No partners needed';

    return `ORACLE: ${oi.coverageDescription} | ${gapStr} | Type=${oi.interactionType}${partnersStr}
`;
  }

  /**
   * Parse LLM response into structured assessment.
   *
   * Supports compact format: {"c":bool,"r":"reason"}
   * All other fields (urgency, capabilities, partner types) are derived from
   * the cluster summary and agent context — NOT from the LLM response.
   * This keeps LLM output to ~5-10 tokens.
   */
  private parseLLMResponse(
    response: string,
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext,
  ): LLMAssessment {
    try {
      if (!response || typeof response !== 'string') {
        throw new Error('No response or invalid response from LLM');
      }

      const rawResponse = response;
      let needsCollaboration: boolean;
      let reasoning: string;

      // Finite State Machine parser — scans from beginning of response.
      // States: IDLE → DECISION_PREFIX → YES/NO → DONE
      // The FSM looks for the first decisive "yes"/"no"/"collaborate"/"independent"
      // that appears at the start of the response or after a clear prefix like "DECISION:".
      const text = response.trim();
      needsCollaboration = this.extractDecisionFSM(text);

      // Everything after the first line is reasoning
      const firstNewline = text.indexOf('\n');
      reasoning = firstNewline >= 0
        ? text.substring(firstNewline + 1).trim()
        : text;
      if (reasoning.length === 0) reasoning = text.substring(0, 150);

      logger.info(`parseLLMResponse: FSM decision: needsCollaboration=${needsCollaboration}, first 80 chars: "${text.substring(0, 80)}"`);

      // Derive required capabilities from cluster (not from LLM)
      const requiredCapabilities = this.inferCapabilitiesFromCluster(clusterSummary);

      // Derive urgency from event significance + capability gap
      const missingCapabilities = requiredCapabilities.filter(cap =>
        !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
      );
      const urgency = this.deriveUrgency(clusterSummary, missingCapabilities);

      // Derive suggested partner types from discoverable services
      const suggestedPartnerTypes = this.derivePartnerTypes(
        missingCapabilities, agentContext,
      );

      return {
        needsCollaboration,
        reasoning,
        urgency,
        suggestedPartnerTypes,
        requiredCapabilities,
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
        rawResponse,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse LLM response:', error);
      throw new Error(`[ACNecessityAssessor] Failed to parse LLM response: ${msg}. Response was: ${(response || '').substring(0, 200)}`);
    }
  }

  /**
   * Finite State Machine parser — scans from beginning of LLM response.
   *
   * States: IDLE → PREFIX → DECISIVE → DONE
   *
   * The FSM scans character-by-character from the start, looking for the first
   * decisive keyword (COLLABORATE, INDEPENDENT, YES, NO) that appears at the
   * beginning of the response or after a clear prefix like "DECISION:".
   *
   * Crucially, it does NOT match keywords inside negations — e.g. it will NOT
   * match "collaborate" inside "does not need to initiate collaboration".
   */
  private extractDecisionFSM(text: string): boolean {
    // FSM states as constants (TypeScript doesn't allow enum inside functions)
    const STATE_IDLE = 0;
    const STATE_PREFIX = 1;
    const STATE_DONE = 2;

    const len = text.length;
    let state = STATE_IDLE;
    let i = 0;

    // Positive keywords → collaborate = true
    const POSITIVE = ['collaborate', 'yes'];
    // Negative keywords → collaborate = false
    const NEGATIVE = ['independent', 'no'];

    /**
     * Try to match any of `keywords` at position `pos` (case-insensitive).
     * Returns the matched keyword or null.
     */
    const tryMatch = (pos: number, keywords: string[]): string | null => {
      const slice = text.slice(pos).toLowerCase();
      for (const kw of keywords) {
        if (slice.startsWith(kw)) {
          // Ensure the match ends at a word boundary (not a substring of a longer word)
          const end = pos + kw.length;
          if (end < len) {
            const nextChar = text[end];
            if (/[a-z]/i.test(nextChar)) continue; // not a word boundary
          }
          return kw;
        }
      }
      return null;
    };

    while (i < len && state !== STATE_DONE) {
      const ch = text[i];

      switch (state) {
        case STATE_IDLE: {
          // Skip whitespace and common prefix tokens ("DECISION:", "<think...", etc.)
          if (/\s/.test(ch)) { i++; break; }

          // Skip "DECISION:" prefix
          const lowerSlice = text.slice(i).toLowerCase();
          if (lowerSlice.startsWith('decision')) {
            // Jump past "decision" and any following colon/whitespace
            i += 'decision'.length;
            while (i < len && /[:\s]/.test(text[i])) i++;
            state = STATE_PREFIX;
            break;
          }

          // Skip "<think...>reasoning</think...>" blocks (qwen models output reasoning in XML tags)
          if (ch === '<') {
            if (lowerSlice.startsWith('<think')) {
              // Skip entire <think...>...</think...> block
              const closeIdx = text.indexOf('</think', i);
              if (closeIdx >= 0) {
                const tagEnd = text.indexOf('>', closeIdx);
                i = tagEnd >= 0 ? tagEnd + 1 : len;
              } else {
                // No closing tag — skip to end of opening tag
                const openEnd = text.indexOf('>', i);
                i = openEnd >= 0 ? openEnd + 1 : len;
              }
              break;
            }
            // Skip any other XML tag (e.g. <reasoning>)
            const tagEnd = text.indexOf('>', i);
            if (tagEnd >= 0) {
              i = tagEnd + 1;
              break;
            }
          }

          // Try positive/negative keyword match at this position
          const posMatch = tryMatch(i, POSITIVE);
          if (posMatch) {
            logger.info(`FSM [IDLE→DONE]: matched positive "${posMatch}" at pos ${i}`);
            return true; // collaborate
          }
          const negMatch = tryMatch(i, NEGATIVE);
          if (negMatch) {
            logger.info(`FSM [IDLE→DONE]: matched negative "${negMatch}" at pos ${i}`);
            return false; // independent
          }

          // Non-whitespace, non-keyword → skip this "word" (advance to next whitespace)
          while (i < len && !/\s/.test(text[i])) i++;
          break;
        }

        case STATE_PREFIX: {
          // After "DECISION:" — skip whitespace, then look for the decisive word
          if (/\s/.test(ch)) { i++; break; }

          // Try positive/negative keyword match
          const posMatch = tryMatch(i, POSITIVE);
          if (posMatch) {
            logger.info(`FSM [PREFIX→DONE]: matched positive "${posMatch}" at pos ${i}`);
            return true;
          }
          const negMatch = tryMatch(i, NEGATIVE);
          if (negMatch) {
            logger.info(`FSM [PREFIX→DONE]: matched negative "${negMatch}" at pos ${i}`);
            return false;
          }

          // Unexpected word after DECISION: — skip and keep looking
          while (i < len && !/\s/.test(text[i])) i++;
          state = STATE_IDLE; // reset to look for next decisive word
          break;
        }

        default:
          i++;
      }
    }

    // Fallback: full-text scan as last resort
    logger.warn(`FSM: no decisive keyword found in first pass, doing full-text fallback. First 100 chars: "${text.substring(0, 100)}"`);

    // Count positive vs negative keyword occurrences
    const lower = text.toLowerCase();
    let posCount = 0;
    let negCount = 0;
    for (const kw of POSITIVE) {
      // Count only at word boundaries
      const regex = new RegExp(`\\b${kw}\\b`, 'gi');
      const matches = lower.match(regex);
      if (matches) posCount += matches.length;
    }
    for (const kw of NEGATIVE) {
      const regex = new RegExp(`\\b${kw}\\b`, 'gi');
      const matches = lower.match(regex);
      if (matches) negCount += matches.length;
    }

    if (posCount > negCount) {
      logger.info(`FSM fallback: positive wins (${posCount} vs ${negCount})`);
      return true;
    }
    if (negCount > posCount) {
      logger.info(`FSM fallback: negative wins (${negCount} vs ${posCount})`);
      return false;
    }

    // Tie or nothing found — default to collaborate (safety-first)
    logger.warn(`FSM fallback: tie or no keywords found. Defaulting to collaborate (safety-first).`);
    return true;
  }

  /**
   * Make final decision based on LLM assessment and agent traits
   *
   * This method integrates:
   * 1. LLM assessment (event significance, urgency, etc.)
   * 2. Agent personality traits (proactivity, cautiousness, socialPreference, riskTolerance)
   * 3. Motivation suggestion from Role & Goal system
   */
  private makeDecision(
    llmAssessment: LLMAssessment,
    agentContext: AgentContext
  ): ACNecessityAssessment['decision'] {
    const traits = agentContext.traits;
    const motivation = agentContext.motivationSuggestion;

    // =====================================
    // STEP 1: Calculate trait-adjusted confidence threshold
    // =====================================
    let adjustedThreshold = this.config.confidenceThreshold; // Default: 0.7

    if (traits) {
      // Cautious agents require higher confidence
      // cautiousness 0.8 -> threshold += 0.1
      // cautiousness 0.2 -> threshold -= 0.05
      const cautiousnessAdjustment = (traits.cautiousness - 0.5) * 0.2;
      adjustedThreshold += cautiousnessAdjustment;

      // Risk-tolerant agents can act with lower confidence in risky situations
      if (llmAssessment.potentialRisks.length > 0) {
        const riskAdjustment = (traits.riskTolerance - 0.5) * 0.15;
        adjustedThreshold -= riskAdjustment;
      }

      // Proactive agents are more willing to initiate
      // proactivity 0.8 -> threshold -= 0.05
      // proactivity 0.2 -> threshold += 0.05
      const proactivityAdjustment = (0.5 - traits.proactivity) * 0.1;
      adjustedThreshold += proactivityAdjustment;

      logger.info(`Trait-adjusted threshold: ${adjustedThreshold.toFixed(2)} (base: ${this.config.confidenceThreshold})`);
    }

    // =====================================
    // STEP 2: Check confidence threshold (trait-adjusted)
    // =====================================
    if (llmAssessment.confidence < adjustedThreshold) {
      logger.info(`Confidence ${llmAssessment.confidence.toFixed(2)} < threshold ${adjustedThreshold.toFixed(2)}, deferring`);
      return 'defer';
    }

    // =====================================
    // STEP 3: Integrate motivation from Role & Goal system
    // =====================================
    if (motivation) {
      // If Role & Goal system says don't act, respect it unless urgency is high
      if (!motivation.shouldAct && llmAssessment.urgency !== 'urgent' && llmAssessment.urgency !== 'high') {
        logger.info(`Role & Goal system says don't act, deferring`);
        return 'defer';
      }

      // If Role & Goal system suggests collaborate and LLM agrees, boost collaboration likelihood
      if (motivation.suggestedAction === 'collaborate' && llmAssessment.needsCollaboration) {
        logger.info(`Role & Goal system confirms collaboration need`);
      }

      // If Role & Goal system suggests act but LLM says collaborate, consider both
      if (motivation.suggestedAction === 'act' && llmAssessment.needsCollaboration) {
        // Check if agent has capabilities to act independently
        const hasCapabilities = llmAssessment.requiredCapabilities.every(
          cap => agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
        );
        if (hasCapabilities && traits && traits.socialPreference < 0.4) {
          // Low social preference agent may prefer to act alone
          logger.info(`Low social preference agent prefers independent action`);
          return 'handle_independently';
        }
      }
    }

    // =====================================
    // STEP 4: Check if collaboration is needed
    // =====================================
    if (!llmAssessment.needsCollaboration) {
      // Check if agent can handle independently
      const hasCapabilities = llmAssessment.requiredCapabilities.every(
        cap => agentContext.capabilities.some(ac => ac.toLowerCase().includes(cap.toLowerCase()))
      );

      // Collaborative agents may seek collaboration even when not strictly needed
      if (!hasCapabilities && traits && traits.socialPreference > 0.6) {
        logger.info(`High social preference agent seeking collaboration despite capability`);
        // This will trigger initiate_ac path below if workload allows
      } else {
        return hasCapabilities ? 'handle_independently' : 'ignore';
      }
    }

    // =====================================
    // STEP 5: Social preference affects collaboration decision
    // =====================================
    if (traits && llmAssessment.needsCollaboration) {
      // Very low social preference may prefer to avoid collaboration
      if (traits.socialPreference < 0.2 && llmAssessment.urgency !== 'urgent') {
        logger.info(`Very low social preference, handling independently if possible`);
        const hasCapabilities = llmAssessment.requiredCapabilities.every(
          cap => agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
        );
        if (hasCapabilities) {
          return 'handle_independently';
        }
      }
    }

    // =====================================
    // STEP 6: Check workload
    // =====================================
    if (agentContext.currentWorkload === 'heavy') {
      return 'defer';
    }

    logger.info(`Decision: initiate_ac`);
    return 'initiate_ac';
  }

  /**
   * Update decision statistics
   */
  private updateDecisionStats(decision: ACNecessityAssessment['decision']): void {
    switch (decision) {
      case 'initiate_ac':
        this.stats.acInitiated++;
        break;
      case 'handle_independently':
        this.stats.handledIndependently++;
        break;
      case 'defer':
        this.stats.deferred++;
        break;
      case 'ignore':
        this.stats.ignored++;
        break;
    }
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Get AC initiation rate
   */
  getACInitiationRate(): number {
    if (this.stats.totalAssessments === 0) return 0;
    return (this.stats.acInitiated / this.stats.totalAssessments) * 100;
  }

  // -----------------------------------------------------------------------
  // Code-based derivation helpers (replacing LLM-generated fields)
  // -----------------------------------------------------------------------

  /**
   * Derive urgency from event significance and capability gap.
   * More missing capabilities + higher significance → higher urgency.
   */
  private deriveUrgency(
    clusterSummary: SpatialClusterSummary,
    missingCapabilities: string[],
  ): 'low' | 'medium' | 'high' | 'urgent' {
    const sig = clusterSummary.significance;
    const gapSize = missingCapabilities.length;

    if (sig === 'urgent' || gapSize >= 3) return 'urgent';
    if (sig === 'high' || gapSize >= 2) return 'high';
    if (sig === 'medium' || gapSize >= 1) return 'medium';
    return 'low';
  }

  /**
   * Derive suggested partner types from discoverable services.
   * Finds partner agents whose services match the missing capabilities.
   */
  private derivePartnerTypes(
    missingCapabilities: string[],
    agentContext: AgentContext,
  ): string[] {
    if (missingCapabilities.length === 0 || !agentContext.discoverableServices?.length) {
      return [];
    }

    const partnerIds = new Set<string>();
    for (const missing of missingCapabilities) {
      for (const svc of agentContext.discoverableServices) {
        if (svc.capabilities.some(c =>
          c.toLowerCase().includes(missing.toLowerCase()) ||
          missing.toLowerCase().includes(c.toLowerCase()),
        )) {
          partnerIds.add(svc.providerAgentId);
        }
      }
    }
    return Array.from(partnerIds);
  }
}

export default ACNecessityAssessor;
