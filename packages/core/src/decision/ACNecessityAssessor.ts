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
import { isTransientLLMError, runWithLLMAgentContext, noThinkingTemplateKwargs, type LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
import { capabilityMatches, hasAllCapabilities } from '../utils/capabilityMatching.js';
import { PartnerSummaryIndex, type ServiceOrigin } from './partner-summaries.js';
import { buildServiceCatalogDigest, renderCatalogStatsLine, renderShortlistLine } from './service-catalog-digest.js';
import { deriveAssessmentUrgency } from './assessor-derivations.js';
import type { InvocableFlowOffering } from '../flows/flow-types.js';
import {
  canonicalizeLLMDecision,
  extractDecisionFromProse,
  type CanonicalLLMDecision,
} from '../utils/decisionVocabulary.js';
import {
  COGNITIVE_DECISION_SCHEMA,
  cognitiveActionToLegacyDecision,
  parseCognitiveDecisionForLane,
  type CognitiveDecision,
} from './cognitive-decision.js';
import {
  AC_DECISION_MAX_TOKENS,
  AC_DECISION_SCHEMA,
  BINARY_OUTPUT_INSTRUCTION,
  COGNITIVE_DECISION_MAX_TOKENS,
  COORDINATOR_ROLE_INSTRUCTION,
  DECISION_TEMPERATURE,
  PROSE_ANSWER_INSTRUCTION,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from './assessor-prompts.js';
import {
  inferCapabilitiesFromCluster,
  inferPartnerTypesFromCluster,
} from './inference-tables.js';
import { charNgramJaccard, maxSimilarity, extractEventText } from '../utils/text-similarity.js';
import { shouldPassThroughPrecheck, extractDeclaredRequiredCapabilities, declaredOrInferredRequirements, initiatorRequestFace, modelOrInferredCapabilities, ruleOnlyVerdict } from './assessor-passthrough.js';
import { truncateForStorage } from '../utils/truncate.js';
import { untrustedBlock, untrustedJsonBlock } from '../security/prompt-sanitizer.js';
import { isSensorStyleCapability } from './rule-actuation-planner.js';
import { TriageDecider, type TriageDecision } from '../triage/TriageDecider.js';
import { renderCognitionPromptSections, type AgentCognitionContext } from '../cognition/prompt-context.js';
import { renderMetaCognitionPromptSections, type MetaCognitionContext } from '../cognition/meta.js';
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
    /** Provenance + declared semantic type (world-layer) — offers rank ahead (R45-P4). */
    origin?: ServiceOrigin;
    semanticType?: string;
    stale?: boolean; // Liveness: provider missed its heartbeat window — annotated/demoted in the digest
  }>;

  // NEW: Ablation flag — when true, filter services to event-zone only
  // and use compact descriptions in the LLM prompt.
  conciseServiceMode?: boolean;

  // NEW: Smart-rules mode — deterministic rules with spatial + service reasoning.
  // When true, preCheck never falls through to LLM; instead applies rule-based
  // collaboration decisions using coverage + service registry information.
  smartRulesMode?: boolean;

  // NEW: Rule-only mode — the agent runs WITHOUT any LLM (none configured).
  // preCheck decisions are stamped 'rule' and a needs_llm outcome falls back
  // to a deterministic capability-based rule instead of an LLM call.
  ruleOnlyMode?: boolean;

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

  /**
   * Mechanism B (agent-invocable flows): the HONEST tool listing — ONLY the
   * flows this agent may actually invoke reach the prompt (the runtime
   * computes it with the same oracle the engine gate uses). The model may
   * name one in its JSON answer via invokeFlow {flowId, params}; anything
   * else it names is refused at the gate with teaching.
   */
  invocableFlows?: InvocableFlowOffering[];

  /**
   * Phase 2 (cognitive architecture §3/§4.1): the unified world-model
   * projection — current AgentWorldModel, pre-computed situation
   * assessment and the working-memory round (previous decision + outcome).
   * OPTIONAL: absent on legacy/embedded contexts, and the prompt is then
   * byte-identical to the pre-Phase-2 shape (pinned by the slim-prompt
   * tests). When present, buildPrompt renders SITUATION / RECENT_EVENTS /
   * PREVIOUS_DECISION from this single source instead of ad-hoc context.
   */
  cognition?: AgentCognitionContext;

  /**
   * Phase 5 (cognitive architecture §7): the meta-cognition projection —
   * live capability boundary (strong/weak/must-escalate), partner trust
   * ranking, decision-quality calibration summary and adaptive-behavior
   * hints. OPTIONAL: absent (no MetaCognition injected) → the prompt is
   * byte-identical to the pre-Phase-5 shape (additive layer, pinned).
   */
  metaCognition?: MetaCognitionContext;

  /**
   * R43-B/lever-b (training loop v5 §9.5): precheck Type-A pass-through
   * policy. Type-A events (direct actuator coverage × no capability gap —
   * ground truth handle_independently) are normally short-circuited BEFORE
   * the LLM (STEP 0b 'precheck.independent'), which structurally starves the
   * LLM lane of real GT-A×LLM handle samples. This policy lets a controlled
   * fraction of those events fall through to the LLM decision path:
   * - 'off' (default / absent): current behavior — Type-A short-circuits,
   *   zero LLM cost, records stay decisionSource='precheck'.
   * - 'sample': pass through with probability `rate` (default 0.3).
   * - 'all': pass every Type-A event through.
   * A passed-through decision runs the normal LLM path (decisionSource='llm',
   * reasoningCode 'llm.precheck_passthrough' on the record for counting);
   * ground truth is UNCHANGED (Type-A's correct answer is still
   * handle_independently) so the label-consistency gate keeps honest pairs.
   * Data-production tool — never enable broadly online (it converts the
   * cheapest deterministic path into an LLM call).
   */
  precheckPassThrough?: {
    mode: 'off' | 'sample' | 'all';
    /** 'sample' mode pass probability p, clamped to [0,1]; default 0.3. */
    rate?: number;
  };

  /**
   * R45-P1 (F4): dispatcher role — a 'coordinator' (municipal center;
   * bound devices are representative reach, not an execution mandate) is
   * never Type-A short-circuited; the LLM lane decides. Absent = executor.
   */
  decisionRole?: 'coordinator';
}

/**
 * LLM-based assessment result
 */
export interface LLMAssessment {
  needsCollaboration: boolean;
  /**
   * T-041: the model's answer, canonicalized at PARSE time through the
   * shared alias table (utils/decisionVocabulary — one truth for the
   * structured JSON path, the FSM fallback and the triage parser). The old
   * boolean collapse lost defer/ignore vocabulary entirely and forced the
   * final fork to re-derive the decision from a hardcoded keyword table.
   * `needsCollaboration` remains as the derived boolean
   * (`llmDecision === 'initiate_ac'`) for existing consumers.
   */
  llmDecision?: CanonicalLLMDecision;
  /**
   * T-024-part3 (DevLoop R17): PARSE-QUALITY marker for LLM decisions —
   * 'llm-json' when the structured {"decision","reasoning"} JSON parse
   * succeeded (the provider honored `format`), 'llm-fsm' when the prose FSM
   * keyword scanner had to recover the answer. Only set on decisionSource
   * 'llm' records; consumers use it to measure provider structured-output
   * compliance (a fleet drifting to 'llm-fsm' means prompts/format support
   * regressed) and to weight parse-confidence in eval reports.
   */
  decisionSubSource?: 'llm-json' | 'llm-fsm';
  /**
   * T-041: the AUTHOR-DECLARED event requirements
   * (`findings[].details.requiredCapabilities`, lowercased). This is the
   * ONLY list that may downgrade an `independent` answer to `defer` — the
   * inferred keyword table (inferCapabilitiesFromCluster) is a capability
   * HINT for prompts/partner search, never a verdict.
   */
  declaredRequiredCapabilities?: string[];
  reasoning: string;
  /**
   * R15-D3: machine-readable twin of `reasoning` for rule/precheck
   * decisions. The English template sentence stays as the audit copy;
   * clients localize from code+params instead of pattern-matching text.
   * Absent for genuine LLM reasoning (free text, nothing to template).
   */
  reasoningCode?: string;
  /** Interpolation params for the reasoningCode template (strings/numbers). */
  reasoningParams?: Record<string, string | number>;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  suggestedPartnerTypes: string[];
  /** The collaboration request face: the model's partnerCapabilities when
   * named, else the deterministic gap needs on initiate_ac
   * (initiatorRequestFace); the parse-time face otherwise. */
  requiredCapabilities: string[];
  confidence: number; // 0-1
  estimatedDuration: number; // milliseconds
  potentialRisks: string[];
  /**
   * Mechanism B: the flow the model named for THIS event —
   * {"flowId", "params"} — parsed from the structured JSON answer. Only
   * honored on handle_independently decisions, and only flows on the
   * agent's offered listing pass the gate (FlowEngine.runAsAgent).
   */
  invokeFlow?: { flowId: string; params?: Record<string, unknown> };
  /**
   * Phase 1: the full CognitiveDecision when the cognitive JSON parse won
   * (decisionSubSource 'llm-json'). Legacy binary/prose answers leave it
   * unset. `llmDecision`/`needsCollaboration`/`reasoning` are the DERIVED
   * legacy view of this object (deriveLegacyDecision).
   */
  cognitiveDecision?: CognitiveDecision;
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

  /** Whether the decision came from preCheck rules, deterministic rule-only
   *  fallback (no LLM configured), triage, the big LLM, or — T-022 — the
   *  rule fallback AFTER an LLM provider failure (bounded retries exhausted
   *  or permanent error; reasoning names the provider error). */
  decisionSource: 'precheck' | 'rule' | 'llm' | 'triage' | 'rule-llm-down';

  /**
   * Mechanism B: the flow invocation the decision carries (parsed from the model's answer; surfaced from LLMAssessment for the decision record).
   */
  invokeFlow?: { flowId: string; params?: Record<string, unknown> };

  /**
   * Phase 1 (cognitive architecture §14.1): the FULL structured decision the
   * model produced — situation assessment, goal stack, action plan
   * (incl. deviceActions / collaboration / flowId), explanation, derived
   * collaboration flag and uncertainty. Present ONLY when the cognitive JSON
   * parse succeeded (decisionSubSource 'llm-json'); legacy answers (binary
   * JSON / prose) carry the derived fields only. The legacy `decision` +
   * `reasoning` on the assessment are DERIVED from this via
   * deriveLegacyDecision — existing consumers are unchanged.
   */
  cognitiveDecision?: CognitiveDecision;

  /** R40-A3（§7.5 升级通道）：触发升级 = 只通知不执行（事件/记录标注的来源）。 */
  escalated?: boolean;
  /** 升级条件：模型 escalationCondition 优先，缺省用阈值命中 reason。 */
  escalationCondition?: string;

  // NEW: Task parameters extracted from original event
  taskParameters?: Record<string, any>;
}

/**
 * Small-model triage policy (P4-2).
 *
 * When enabled, the assessor first asks a cheap model (e.g. a fine-tuned
 * 1.5B decision model) with the SAME prompt it would send the big model.
 *
 * - mode 'shadow':  the big model always decides; the triage answer is only
 *   compared against it (agreement metrics). NO behavior change.
 * - mode 'enforce': a triage answer of 'independent' with trustIndependent
 *   (default true) short-circuits the big-model call — the assessment is
 *   answered from triage (decisionSource 'triage'). A triage answer of
 *   'collaborate' ALWAYS falls through to the big model: expensive
 *   collaboration decisions are confirmed by the big model.
 *   trustIndependent: false disables the short-circuit (enforce mode then
 *   behaves like shadow while still recording metrics).
 *
 * A failed/unparseable triage call always falls through to the big model.
 */
export interface TriageConfig {
  enabled: boolean;
  /** Second, cheap LLM client (separate from the assessor's big-model client). */
  client?: LLMClient;
  mode: 'shadow' | 'enforce';
  /** Default true: in enforce mode, trust triage 'independent' answers. */
  trustIndependent?: boolean;
}

/**
 * Triage metrics exposed by the assessor (P4-2).
 */
export interface TriageMetrics {
  enabled: boolean;
  mode: 'shadow' | 'enforce';
  /** Triage decisions successfully obtained from the cheap model. */
  triageCalls: number;
  /** Triage calls that failed or were unparseable (fell through to big model). */
  triageErrors: number;
  /** Big-model decisions that matched / contradicted the triage decision. */
  agreements: number;
  disagreements: number;
  /** agreements / (agreements + disagreements); null when no comparisons yet. */
  agreementRate: number | null;
  /** Big-model calls actually made after a successful triage decision. */
  bigModelCalls: number;
  /** Big-model calls skipped because enforce mode trusted a triage 'independent'. */
  bigModelCallsSaved: number;
  /** saved / (saved + bigModelCalls); 0 when nothing triaged. */
  bigModelCallSaveRate: number;
  avgTriageLatencyMs: number | null;
  avgBigModelLatencyMs: number | null;
  /** avgBigModelLatencyMs - avgTriageLatencyMs (per-call saving when skipped). */
  latencyDeltaMs: number | null;
}

/**
 * Configuration for ACNecessityAssessor
 */
export interface AssessorConfig {
  // LLM settings
  llmTimeout: number; // milliseconds
  /**
   * T-022 (DevLoop R17): bounded retries for TRANSIENT provider errors only
   * (network refused/reset, timeout, DNS, 429/5xx gateway) before the
   * failure policy engages. 0 = single attempt. Permanent errors (401/404,
   * unknown model) are never retried.
   */
  maxRetries: number;
  /**
   * T-022: backoff between retry attempts, in ms (linear: attempt × value).
   * Keep small — the retry loop runs inline in the decision path and must
   * never block the sim loop beyond the provider's own timeout.
   */
  llmRetryBackoffMs: number;
  /**
   * T-022: what happens when the LLM call fails (after retries):
   * - 'rule-fallback' (default): honest degradation — the decision IS made,
   *   by the deterministic capability rule, with decisionSource
   *   'rule-llm-down' and the provider error in the reasoning. The agent
   *   falls back exactly where a ruleOnlyMode agent would.
   * - 'drop': re-throw (pre-T-022 behavior) — the event produces NO decision
   *   record; only the T-105 llmErrors counter and the trajectory
   *   'llm-failure' record observe it.
   */
  llmFailurePolicy: 'rule-fallback' | 'drop';

  // Decision thresholds
  confidenceThreshold: number; // Minimum confidence to initiate AC
  maxWorkloadThreshold: number; // Maximum workload to accept new AC

  // Prompt templates
  systemPrompt: string;
  useStructuredOutput: boolean;

  // P4-2: small-model triage (default undefined = disabled, zero behavior change)
  triage?: TriageConfig;
}

const DEFAULT_CONFIG: AssessorConfig = {
  llmTimeout: 5000,
  maxRetries: 1,
  llmRetryBackoffMs: 250,
  llmFailurePolicy: 'rule-fallback',

  confidenceThreshold: 0.5,
  maxWorkloadThreshold: 3, // Max 3 concurrent collaborations

  // R32-A1: compressed preamble. Same rule order and the same load-bearing
  // distinctions (sensor-only, coverage-vs-capability, sensing ≠ actuating,
  // partners ≠ own caps) at roughly half the tokens; the full prose lives in
  // git history (pre-R32) if a decision regression ever needs diffing.
  systemPrompt: `You are an IoT agent deciding whether to initiate Active Collaboration (AC).
COLLABORATE = alert and coordinate with OTHER capable agents — NOT doing it yourself.

Rules (apply in order):
1. ROLE=SENSOR-ONLY → COLLABORATE (you detect; others act).
2. COVERAGE=NONE but you have all EVENT_NEEDS caps → COLLABORATE (delegate to an agent with zone coverage).
3. COVERAGE=NONE and you lack EVENT_NEEDS caps → do NOT collaborate (not your responsibility).
4. All EVENT_NEEDS caps + COVERAGE=DIRECT → INDEPENDENT.
5. Otherwise → COLLABORATE (you lack something; find a partner).

CRITICAL: severity NEVER changes the collaborate verdict; sensing caps (e.g. temperature-sensing, motion-sensing) are NOT actuating caps; AVAILABLE_PARTNERS lists OTHER agents' services, NOT your capabilities.

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
  private triageDecider: TriageDecider | null = null;

  // Statistics
  private stats = {
    totalAssessments: 0,
    acInitiated: 0,
    handledIndependently: 0,
    deferred: 0,
    ignored: 0,
    llmErrors: 0,
  };

  // P4-2 triage counters (rates computed in getTriageMetrics)
  private triageStats = {
    triageCalls: 0,
    triageErrors: 0,
    agreements: 0,
    disagreements: 0,
    bigModelCalls: 0,
    bigModelCallsSaved: 0,
    totalTriageLatencyMs: 0,
    totalBigModelLatencyMs: 0,
  };

  /**
   * R32-A2: per-agent partner-summary index (compact summaries + capability
   * ranking, cached on the service-topology signature — see
   * decision/partner-summaries.ts).
   */
  private readonly partnerIndex = new PartnerSummaryIndex();

  /**
   * R43-B/lever-b: sampling source for precheckPassThrough 'sample' mode.
   * Math.random in production; overridable for deterministic tests.
   */
  private precheckSampler: () => number = Math.random;

  /** Test seam: deterministic draw source for the 'sample' pass-through mode. */
  setPrecheckPassThroughSampler(sampler: () => number): void {
    this.precheckSampler = sampler;
  }

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
    // R43-B/lever-b: a controlled Type-A pass-through falls through to the
    // LLM lane (see AgentContext.precheckPassThrough). Everything else —
    // including Type-A when the policy is off — short-circuits as before.
    const typeAPassThrough = this.shouldPassThroughTypeA(preCheckResult, agentContext);
    if (preCheckResult.decision !== 'needs_llm' && !typeAPassThrough) {
      this.updateDecisionStats(preCheckResult.decision);

      // Request face aligned with the LLM lane (initiatorRequestFace): a
      // precheck initiate_ac carries the event's gap needs (declared ∪
      // inferred minus own coverage), not the raw keyword table; an empty
      // gap stays empty — the bridge's skip is the honest outcome.
      const inferredCapabilities = initiatorRequestFace(
        preCheckResult.decision,
        undefined,
        clusterSummary,
        agentContext.capabilities,
      ) ?? [];
      const inferredPartnerTypes = preCheckResult.decision === 'initiate_ac'
        ? inferPartnerTypesFromCluster(clusterSummary)
        : [];

      return {
        clusterSummary,
        agentContext,
        llmAssessment: {
          needsCollaboration: preCheckResult.decision === 'initiate_ac',
          reasoning: preCheckResult.reasoning,
          // R15-D3: structured twin so clients can localize rule decisions.
          ...(preCheckResult.reasoningCode !== undefined
            ? { reasoningCode: preCheckResult.reasoningCode }
            : {}),
          ...(preCheckResult.reasoningParams !== undefined
            ? { reasoningParams: preCheckResult.reasoningParams }
            : {}),
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
        decisionSource: agentContext.ruleOnlyMode ? 'rule' : 'precheck',
        timestamp,
        taskParameters,
      };
    }

    // Rule-only fallback (no LLM configured): a needs_llm outcome is
    // resolved by the deterministic capability rule (ruleOnlyVerdict).
    if (agentContext.ruleOnlyMode) {
      const rule = ruleOnlyVerdict(clusterSummary, agentContext.capabilities);
      logger.info(`Rule-only assessment for cluster ${clusterSummary.clusterId}: ${rule.decision}`);
      this.updateDecisionStats(rule.decision);
      return {
        clusterSummary,
        agentContext,
        llmAssessment: {
          needsCollaboration: false,
          reasoning: rule.reasoning,
          reasoningCode: rule.reasoningCode,
          reasoningParams: rule.reasoningParams,
          urgency: clusterSummary.significance,
          suggestedPartnerTypes: [],
          requiredCapabilities: rule.requiredCapabilities,
          confidence: 0.6,
          estimatedDuration: 0,
          potentialRisks: [],
        },
        decision: rule.decision,
        decisionSource: 'rule',
        timestamp,
        taskParameters,
      };
    }

    // LLM-based assessment — T-022 bounded degradation policy:
    //   1. bounded retry (transient provider errors only, linear backoff);
    //   2. on final failure, the configured policy: 'rule-fallback' (default)
    //      records a DEGRADED rule decision naming the provider error —
    //      never a silent drop; 'drop' re-throws (the event yields no
    //      decision record; T-105 observability still counts it).
    const maxAttempts = 1 + Math.max(0, this.config.maxRetries);
    let llmFailure: unknown;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsMade = attempt;
      try {
        // Per-agent marker for LLM-call logging: the runtime-level
        // contextProvider carries only the in-flight eventId — wrap the LLM
        // lane (big model + triage, both run inside performLLMAssessment) so
        // a failed/timed-out call is attributed to THIS agent instead of
        // landing as llm-failure agentId 'unknown'.
        const { assessment: llmAssessment, source } = await runWithLLMAgentContext(
          { agentId: agentContext.agentId, agentName: agentContext.agentName },
          () => this.performLLMAssessment(clusterSummary, agentContext),
        );
        if (typeAPassThrough && llmAssessment.reasoningCode === undefined) {
          // R43-B/lever-b observability: mark real GT-A×LLM records so data
          // production can count them precisely (unknown codes fall back to
          // the raw reasoning text in every localizedReasoning consumer).
          llmAssessment.reasoningCode = 'llm.precheck_passthrough';
          llmAssessment.reasoningParams = { mode: agentContext.precheckPassThrough?.mode ?? 'sample' };
        }
        const decision = this.makeDecision(llmAssessment, agentContext);

        // Deterministic request face (initiatorRequestFace): a model-omitted
        // initiate_ac carries the event's gap needs; empty gap stays empty.
        const requestFace = initiatorRequestFace(
          decision,
          llmAssessment.cognitiveDecision?.actionPlan.primary.collaboration?.partnerCapabilities,
          clusterSummary,
          agentContext.capabilities,
        );
        if (requestFace !== undefined) {
          llmAssessment.requiredCapabilities = requestFace;
        }

        this.updateDecisionStats(decision);

        return {
          clusterSummary,
          agentContext,
          llmAssessment,
          decision,
          decisionSource: source,
          timestamp,
          taskParameters,
          // Mechanism B: surface the named flow onto the decision record
          // verbatim (execution gating happens downstream — the manager
          // only honors it on handle_independently decisions).
          ...(llmAssessment.invokeFlow !== undefined
            ? { invokeFlow: llmAssessment.invokeFlow }
            : {}),
          // Phase 1: the full CognitiveDecision rides the assessment for
          // decision records / trajectory / training export.
          ...(llmAssessment.cognitiveDecision !== undefined
            ? { cognitiveDecision: llmAssessment.cognitiveDecision }
            : {}),
        };
      } catch (error: unknown) {
        llmFailure = error;
        const transient = isTransientLLMError(error);
        if (attempt < maxAttempts && transient) {
          const backoffMs = this.config.llmRetryBackoffMs * attempt;
          logger.warn(
            `LLM assessment attempt ${attempt}/${maxAttempts} failed (transient) for cluster ` +
            `${clusterSummary.clusterId}: ${error instanceof Error ? error.message : String(error)} ` +
            `— retrying in ${backoffMs}ms`,
          );
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        break;
      }
    }

    // Final failure (transient exhausted or permanent).
    this.stats.llmErrors++;
    const failureMsg = llmFailure instanceof Error ? llmFailure.message : String(llmFailure);
    logger.error(
      `LLM assessment failed for cluster ${clusterSummary.clusterId} after ` +
      `${attemptsMade} attempt(s):`, llmFailure,
    );
    if (this.config.llmFailurePolicy === 'drop') {
      throw new Error(
        `[ACNecessityAssessor] LLM assessment failed for cluster ${clusterSummary.clusterId}: ${failureMsg}`,
      );
    }

    // Honest degradation: the SAME deterministic capability rule a
    // rule-only agent would apply, on the record with the failure named.
    // R35: gap against the declared face (declaredOrInferredRequirements).
    const requiredCapabilities = declaredOrInferredRequirements(clusterSummary);
    const missingCapabilities = requiredCapabilities.filter(cap =>
      !agentContext.capabilities.some(ac => capabilityMatches(ac, cap)),
    );
    const degradedDecision: ACNecessityAssessment['decision'] =
      missingCapabilities.length === 0 ? 'handle_independently' : 'defer';
    const degradedReasoning =
      `LLM provider failed after ${attemptsMade} attempt(s): ${failureMsg} — ` +
      `degraded to the deterministic capability rule ` +
      `(missing: [${missingCapabilities.join(', ') || 'none'}]).`;
    logger.info(
      `Degraded rule assessment (LLM down) for cluster ${clusterSummary.clusterId}: ${degradedDecision}`,
    );
    this.updateDecisionStats(degradedDecision);
    return {
      clusterSummary,
      agentContext,
      llmAssessment: {
        needsCollaboration: false,
        reasoning: degradedReasoning,
        // R15-D3 structured twin naming the degradation explicitly.
        reasoningCode: 'rule.llm_down',
        reasoningParams: {
          attempts: attemptsMade,
          missing: missingCapabilities.join(', ') || 'none',
        },
        urgency: clusterSummary.significance,
        suggestedPartnerTypes: [],
        requiredCapabilities,
        confidence: 0.5,
        estimatedDuration: 0,
        potentialRisks: ['decision made without LLM evaluation — provider was down'],
      },
      decision: degradedDecision,
      decisionSource: 'rule-llm-down',
      timestamp,
      taskParameters,
    };
  }

  /**
   * R43-B/lever-b: the Type-A pass-through gate. True ONLY when
   * (1) the pre-check verdict is the Type-A short-circuit
   *     (reasoningCode 'precheck.independent' — direct actuator coverage ×
   *     Gap=∅ → handle_independently),
   * (2) the agent carries a pass-through policy ('sample'/'all'), and
   * (3) the LLM lane can actually run (an LLM client is configured and the
   *     agent is not rule-only — otherwise the "pass-through" would only
   *     hit the degraded rule fallback and pollute records).
   * 'sample' mode draws from `precheckSampler` (Math.random in production;
   * a deterministic seam for tests) against the configured rate (default
   * 0.3, clamped to [0,1]).
   */
  private shouldPassThroughTypeA(
    preCheckResult: {
      decision: ACNecessityAssessment['decision'] | 'needs_llm';
      reasoning: string;
      reasoningCode?: string;
    },
    agentContext: AgentContext,
  ): boolean {
    return shouldPassThroughPrecheck(
      preCheckResult.reasoningCode,
      agentContext.precheckPassThrough,
      agentContext.ruleOnlyMode !== true && this.llmClient !== null,
      this.precheckSampler(),
    );
  }

  /**
   * Pre-check before LLM assessment
   * Now considers agent traits for trait-aware decision making
   */
  private preCheck(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): {
    decision: ACNecessityAssessment['decision'] | 'needs_llm';
    reasoning: string;
    reasoningCode?: string;
    reasoningParams?: Record<string, string | number>;
  } {
    const traits = agentContext.traits;
    const motivation = agentContext.motivationSuggestion;

    // =====================================
    // STEP 0a: Sensor-only agent check
    // If the agent has NO actuator zones at all, it is a pure sensor agent.
    // Per the formal model (Definition 6): sensor-only agents always initiate_ac
    // because detecting an event IS their contribution — they must notify
    // capable agents for physical action.
    //
    // Wave A1 domain-relevance gate: a sensor-only agent should only
    // auto-initiate for events in its own domain. If the event requires
    // capabilities the agent doesn't have at all (e.g., meteo-bureau
    // seeing a chem-fire event that needs smoke-detection), the agent
    // should NOT auto-initiate — let the zone-coverage + LLM path decide
    // so the right domain expert (env-protection-bureau) can claim first.
    // =====================================
    const isSensorOnly = !agentContext.actuatorZoneIds || agentContext.actuatorZoneIds.length === 0;
    if (isSensorOnly) {
      // Check domain relevance: does this agent's capabilities overlap
      // the event's requiredCapabilities?
      const explicitReqCaps = clusterSummary.findings[0]?.details?.requiredCapabilities;
      const reqCaps: string[] = Array.isArray(explicitReqCaps)
        ? (explicitReqCaps as string[]).map(c => c.toLowerCase())
        : [];
      // Require ≥2 capability matches to be considered domain-relevant.
      // This prevents agents with only generic capabilities (e.g.,
      // emergency-alert which is on almost every agent and appears in
      // almost every event) from auto-initiating for events outside
      // their actual domain.
      const matchCount = reqCaps.filter(req =>
        agentContext.capabilities.some(ac => capabilityMatches(ac, req)),
      ).length;
      const hasDomainRelevance = reqCaps.length === 0 || matchCount >= 2;

      if (hasDomainRelevance) {
        logger.info(`Sensor-only preCheck: ${agentContext.agentId} has domain relevance for this event → initiate_ac`);
        return {
          decision: 'initiate_ac',
          reasoning: `Agent ${agentContext.agentId} is a pure sensor agent with domain-relevant capabilities for this event. Detected event requires notifying capable agents for physical action.`,
          reasoningCode: 'precheck.sensor_notify',
          reasoningParams: { agent: agentContext.agentId },
        };
      } else {
        // Sensor-only agent but NOT in this event's domain — fall through
        // to zone-coverage + LLM path. A more relevant agent (e.g., the
        // one that owns smoke-detection for a fire event) should initiate.
        logger.info(`Sensor-only preCheck: ${agentContext.agentId} has NO domain relevance (capabilities don't match requiredCapabilities) → deferring to LLM/zone-coverage path`);
      }
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
          : inferCapabilitiesFromCluster(clusterSummary);
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
            reasoningCode: 'precheck.no_coverage_delegate',
            reasoningParams: {
              zone: eventZone,
              coverageZones: coverageZones.join(', '),
              required: requiredCapabilities.join(', '),
            },
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
              reasoningCode: 'precheck.no_coverage_ignore',
              reasoningParams: { zone: eventZone, coverageZones: coverageZones.join(', ') },
            };
          } else {
            logger.info(`Type D preCheck: event in ${eventZone}, agent actuator zones [${coverageZones.join(',')}], severity=${eventSeverity}. Deferring.`);
            return {
              decision: 'defer',
              reasoning: `Event in zone ${eventZone} is outside agent's actuator coverage (actuator zones: ${coverageZones.join(', ')}). Deferring to agents with relevant coverage.`,
              reasoningCode: 'precheck.no_coverage_defer',
              // R100: the gap list rides the record — a defer is auditable.
              reasoningParams: { zone: eventZone, coverageZones: coverageZones.join(', '), required: requiredCapabilities.join(', ') },
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
          : inferCapabilitiesFromCluster(clusterSummary);
        const missingCapabilities = requiredCapabilities.filter(cap =>
          !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
        );

        if (missingCapabilities.length === 0) {
          // R45-P1 (F4): a coordinator is never Type-A short-circuited —
          // its bound devices are representative reach; the LLM lane
          // decides (cross-zone dispatch stays possible).
          if (agentContext.decisionRole === 'coordinator') {
            logger.info(`Type A preCheck: ${agentContext.agentId} covers ${eventZone}, no gap, role=coordinator → LLM lane (dispatcher, not executor).`);
          } else {
            // Type A: Agent has direct coverage AND no capability gap
            // ((1) all required capabilities, or (2) none required).
            logger.info(`Type A preCheck: agent has direct coverage in ${eventZone} and no capability gap (required: [${requiredCapabilities.join(', ')}]). Handling independently.`);
            return {
              decision: 'handle_independently',
              reasoning: `Agent has direct actuator coverage in ${eventZone} and all required capabilities (${requiredCapabilities.length > 0 ? requiredCapabilities.join(', ') : 'none required'}). Can handle this event independently without collaboration.`,
              reasoningCode: 'precheck.independent',
              // R2-UX-11: an empty `required` used to interpolate into the
              // i18n template as「（）」— flag the no-requirements case via the
              // i18next context slot so clients can pick a dedicated
              // `_none` template (falling back to the base key when missing).
              reasoningParams: {
                zone: eventZone,
                required: requiredCapabilities.join(', '),
                ...(requiredCapabilities.length === 0 ? { context: 'none' } : {}),
              },
            };
          }
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
        reasoningCode: 'precheck.workload_defer',
      };
    }

    // NEW: If motivation system strongly suggests collaboration, honor it
    if (motivation?.suggestedAction === 'collaborate' && motivation.overall > 0.6) {
      return {
        decision: 'initiate_ac',
        reasoning: `Motivation engine suggests collaboration (motivation=${motivation.overall.toFixed(2)})`,
        reasoningCode: 'precheck.motivation_collaborate',
        reasoningParams: { score: Number(motivation.overall.toFixed(2)) },
      };
    }

    // Check cluster significance
    if (clusterSummary.recommendation === 'ignore') {
      return {
        decision: 'ignore',
        reasoning: 'Cluster marked as ignorable by Layer 1',
        reasoningCode: 'precheck.cluster_ignore',
      };
    }

    if (clusterSummary.recommendation === 'monitor') {
      // Proactive agents may want to evaluate further
      if (traits && traits.proactivity > 0.7) {
        return {
          decision: 'needs_llm',
          reasoning: 'Proactive agent wants to evaluate monitored event further',
          reasoningCode: 'precheck.cluster_monitor_proactive',
        };
      }
      return {
        decision: 'defer',
        reasoning: 'Cluster marked for monitoring only',
        reasoningCode: 'precheck.cluster_monitor',
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
      const requiredCapabilities = inferCapabilitiesFromCluster(clusterSummary);
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
   * T-041: author-declared requirements the agent cannot satisfy, computed
   * with the shared synonym-aware matcher against the T-202-enriched
   * surface (declared ∪ own-device-derived capabilities). ONLY this list
   * may downgrade an 'independent' answer to 'defer' — the inferred
   * keyword table (inferCapabilitiesFromCluster) annotates prompts and
   * partner search, never verdicts.
   */
  private missingDeclaredCapabilities(
    llmAssessment: LLMAssessment,
    agentContext: AgentContext,
  ): string[] {
    const declared = llmAssessment.declaredRequiredCapabilities ?? [];
    return declared.filter(cap =>
      !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
    );
  }

  /** True when the author declared NO requirement the agent lacks. */
  private hasDeclaredCapabilityGap(
    llmAssessment: LLMAssessment,
    agentContext: AgentContext,
  ): boolean {
    return this.missingDeclaredCapabilities(llmAssessment, agentContext).length > 0;
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
   * Perform LLM-based assessment.
   *
   * P4-2 triage flow (when config.triage.enabled and a triage client is set):
   *   1. Ask the cheap model with the SAME prompt/schema first.
   *   2. enforce mode + triage says 'independent' + trustIndependent → answer
   *      from triage, skipping the big-model call (decisionSource 'triage').
   *   3. Otherwise call the big model; when a triage decision exists, record
   *      agreement + latency metrics. shadow mode NEVER changes the decision.
   *   4. Triage failure/unparseable → straight to the big model, as before.
   */
  private async performLLMAssessment(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): Promise<{ assessment: LLMAssessment; source: 'llm' | 'triage' }> {
    if (!this.llmClient) {
      throw new Error('LLM client not available');
    }

    const prompt = this.buildPrompt(clusterSummary, agentContext);

    // When structured output is enabled, swap the prose answer instruction for
    // a JSON one and pass a JSON schema for constrained decoding. Providers that
    // ignore `format` may still answer prose — parseLLMResponse falls back to
    // the FSM keyword parser in that case.
    const useStructured = this.config.useStructuredOutput;
    // Phase 1 (§14.1): the BIG model answers the full CognitiveDecisionSchema
    // (COGNITIVE_DECISION_SCHEMA, temperature 0). The TRIAGE lane keeps the
    // NARROW binary question (§11.3) — the fine-tuned small decision model
    // was trained on that shape and must not see the prompt change.
    const systemPrompt = useStructured
      ? this.getStructuredSystemPrompt()
      : this.config.systemPrompt;
    const format = useStructured ? COGNITIVE_DECISION_SCHEMA : undefined;

    const triageSystemPrompt = useStructured
      ? this.getBinaryStructuredSystemPrompt()
      : this.config.systemPrompt;
    const triageFormat = useStructured ? AC_DECISION_SCHEMA : undefined;

    // P4-2: cheap-model triage pass (null when disabled/failed).
    const triageOutcome = await this.runTriage(triageSystemPrompt, prompt, triageFormat);

    if (triageOutcome && this.shouldEnforceTriage(triageOutcome)) {
      this.triageStats.bigModelCallsSaved++;
      this.logTriageOutcome(triageOutcome, undefined, systemPrompt, prompt, agentContext);
      logger.info(`Triage enforce: 'independent' trusted — big-model call skipped (${triageOutcome.latencyMs}ms triage latency)`);
      return {
        assessment: this.buildTriageAssessment(triageOutcome, clusterSummary, agentContext),
        source: 'triage',
      };
    }

    const bigStart = Date.now();
    // R32-A3: generation cap sized to the answer. The JSON-constrained
    // decision is ~63 tokens measured (capacity-planning §1: 46–63 out);
    // 256 gives 4x headroom for the one-or-two-sentence reasoning + an
    // optional invokeFlow object. The provider default (num_predict 4096)
    // forced the backend to reserve KV cache for a generation that can
    // never approach that length.
    // Phase 1: the cognitive schema output is budgeted 250–450 tokens
    // (§11.3; R44 measured p50 161–231) → COGNITIVE_DECISION_MAX_TOKENS
    // (1024 — covers the budget plus verbose non-thinking JSON payloads
    // (R5-F13), 2x below the old 2048); temperature pinned to 0 (§14.1).
    const response = await this.llmClient.quickChat(
      prompt,
      systemPrompt,
      undefined,
      format,
      // Qwen3 thinking suppression: guided-JSON output — the think draft is
      // pure latency (LLM_DISABLE_THINKING=0 opts out for A/B).
      { maxTokens: COGNITIVE_DECISION_MAX_TOKENS, temperature: DECISION_TEMPERATURE,
        chatTemplateKwargs: noThinkingTemplateKwargs() },
    );
    const bigLatencyMs = Date.now() - bigStart;
    const responseText = typeof response === 'string' ? response : response.content;

    const assessment = this.parseLLMResponse(responseText, clusterSummary, agentContext);

    if (triageOutcome) {
      const agreed = assessment.needsCollaboration === (triageOutcome.decision === 'collaborate');
      if (agreed) this.triageStats.agreements++;
      else this.triageStats.disagreements++;
      this.triageStats.bigModelCalls++;
      this.triageStats.totalBigModelLatencyMs += bigLatencyMs;
      this.logTriageOutcome(triageOutcome, agreed, systemPrompt, prompt, agentContext);
      logger.info(`Triage ${this.config.triage?.mode}: triage=${triageOutcome.decision}, big=${assessment.needsCollaboration ? 'collaborate' : 'independent'}, agreed=${agreed}`);
    }

    return { assessment, source: 'llm' };
  }

  /**
   * Run the triage pass when configured. Returns null when triage is
   * disabled, has no client, or the triage call failed/was unparseable.
   */
  private async runTriage(
    systemPrompt: string,
    prompt: string,
    format: Record<string, unknown> | undefined,
  ): Promise<TriageDecision | null> {
    const triage = this.config.triage;
    if (!triage?.enabled || !triage.client) return null;

    if (!this.triageDecider) {
      this.triageDecider = new TriageDecider(triage.client);
    }

    // Binary lane keeps the R32-A3 sized cap (answer ≈ 63 tokens) and the
    // Phase-1 temperature-0 decision policy (§14.1 applies to the triage
    // decision endpoint too — it IS a decision path).
    const outcome = await this.triageDecider.decide(systemPrompt, prompt, format, {
      maxTokens: AC_DECISION_MAX_TOKENS,
      temperature: DECISION_TEMPERATURE,
    });
    if (!outcome) {
      this.triageStats.triageErrors++;
      return null;
    }
    this.triageStats.triageCalls++;
    this.triageStats.totalTriageLatencyMs += outcome.latencyMs;
    return outcome;
  }

  /**
   * Enforce-mode short-circuit rule: only a triage 'independent' answer that
   * the policy trusts may skip the big model. 'collaborate' ALWAYS falls
   * through (expensive decisions get big-model confirmation).
   */
  private shouldEnforceTriage(outcome: TriageDecision): boolean {
    const triage = this.config.triage;
    if (!triage || triage.mode !== 'enforce') return false;
    if (outcome.decision !== 'independent') return false;
    return triage.trustIndependent ?? true;
  }

  /**
   * Build an LLMAssessment from a trusted triage 'independent' decision.
   * Derived fields (capabilities, urgency, partner types) come from the same
   * code paths as parseLLMResponse so downstream logic sees identical shapes.
   * T-041: carries the canonicalized decision + author-declared requirements
   * so makeDecision's independent→defer fork behaves exactly as it does for
   * big-model answers.
   */
  private buildTriageAssessment(
    outcome: TriageDecision,
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext,
  ): LLMAssessment {
    const requiredCapabilities = inferCapabilitiesFromCluster(clusterSummary);
    const missingCapabilities = requiredCapabilities.filter(cap =>
      !agentContext.capabilities.some(ac => capabilityMatches(ac, cap))
    );
    const needsCollaboration = outcome.decision === 'collaborate';
    return {
      needsCollaboration,
      llmDecision: needsCollaboration ? 'initiate_ac' : 'handle_independently',
      declaredRequiredCapabilities: extractDeclaredRequiredCapabilities(clusterSummary),
      reasoning: `[triage] ${outcome.reasoning}`,
      urgency: this.deriveUrgency(clusterSummary, missingCapabilities),
      suggestedPartnerTypes: this.derivePartnerTypes(missingCapabilities, agentContext),
      requiredCapabilities,
      confidence: 0.8,
      estimatedDuration: 60000,
      potentialRisks: [],
      rawResponse: outcome.rawResponse,
    };
  }

  /**
   * Record the triage outcome through the triage client's logging callback
   * (when it has one). The entry carries context.triage additively so
   * trajectory/token accounting sees every triage call exactly once —
   * including enforce-mode skips where no big-model log entry exists.
   * Logging must never break decision-making: all errors are swallowed.
   */
  private logTriageOutcome(
    outcome: TriageDecision,
    agreed: boolean | undefined,
    systemPrompt: string,
    prompt: string,
    agentContext: AgentContext,
  ): void {
    const client = this.config.triage?.client as
      | (LLMClient & { emitLog?: (entry: Record<string, unknown>) => void; getModel?: () => string })
      | undefined;
    if (!client || typeof client.emitLog !== 'function') return;
    try {
      client.emitLog({
        systemPrompt,
        userPrompt: prompt,
        response: outcome.rawResponse,
        durationMs: outcome.latencyMs,
        model: typeof client.getModel === 'function' ? client.getModel() : undefined,
        success: true,
        context: {
          agentId: agentContext.agentId,
          agentName: agentContext.agentName,
          interactionType: 'ac_decision_triage',
          decisionContext: 'ac_necessity',
          triage: { decision: outcome.decision, agreed, latencyMs: outcome.latencyMs },
        },
      });
    } catch {
      // Logging must never break decisions
    }
  }

  /**
   * Triage metrics (P4-2). Undefined when triage is not enabled.
   */
  getTriageMetrics(): TriageMetrics | undefined {
    const triage = this.config.triage;
    if (!triage?.enabled) return undefined;

    const s = this.triageStats;
    const comparisons = s.agreements + s.disagreements;
    const triagedDecisions = s.bigModelCalls + s.bigModelCallsSaved;
    const avgTriage = s.triageCalls > 0 ? s.totalTriageLatencyMs / s.triageCalls : null;
    const avgBig = s.bigModelCalls > 0 ? s.totalBigModelLatencyMs / s.bigModelCalls : null;

    return {
      enabled: true,
      mode: triage.mode,
      triageCalls: s.triageCalls,
      triageErrors: s.triageErrors,
      agreements: s.agreements,
      disagreements: s.disagreements,
      agreementRate: comparisons > 0 ? s.agreements / comparisons : null,
      bigModelCalls: s.bigModelCalls,
      bigModelCallsSaved: s.bigModelCallsSaved,
      bigModelCallSaveRate: triagedDecisions > 0 ? s.bigModelCallsSaved / triagedDecisions : 0,
      avgTriageLatencyMs: avgTriage,
      avgBigModelLatencyMs: avgBig,
      latencyDeltaMs: avgTriage !== null && avgBig !== null ? avgBig - avgTriage : null,
    };
  }

  /**
   * System prompt for structured output: replaces the prose answer instruction
   * from the default prompt, or appends the JSON instruction to custom prompts.
   *
   * Phase 1: this is the COGNITIVE instruction (full CognitiveDecisionSchema).
   */
  private getStructuredSystemPrompt(): string {
    if (this.config.systemPrompt.includes(PROSE_ANSWER_INSTRUCTION)) {
      return this.config.systemPrompt.replace(PROSE_ANSWER_INSTRUCTION, STRUCTURED_OUTPUT_INSTRUCTION);
    }
    return `${this.config.systemPrompt}\n\n${STRUCTURED_OUTPUT_INSTRUCTION}`;
  }

  /**
   * The BINARY structured system prompt (pre-Phase-1 contract) for the triage
   * small-model lane — the narrow question stays byte-compatible with what
   * the fine-tuned decision models were trained on (§11.3: triage unchanged).
   */
  private getBinaryStructuredSystemPrompt(): string {
    if (this.config.systemPrompt.includes(PROSE_ANSWER_INSTRUCTION)) {
      return this.config.systemPrompt.replace(PROSE_ANSWER_INSTRUCTION, BINARY_OUTPUT_INSTRUCTION);
    }
    return `${this.config.systemPrompt}\n\n${BINARY_OUTPUT_INSTRUCTION}`;
  }

  /**
   * R32-A2 observability: partner-summary cache counters (for tests/metrics).
   */
  getPartnerCacheStats(): { recomputes: number; reuses: number } {
    return this.partnerIndex.getStats();
  }

  /**
   * Build prompt for LLM
   */
  private buildPrompt(
    clusterSummary: SpatialClusterSummary,
    agentContext: AgentContext
  ): string {
    // R32-A1: compact managed-zone presence (count, not the ID list — the
    // campus stewards manage 50+ zones, ~300 tokens of pure IDs). The
    // COVERAGE line below already states the event-zone relationship.
    const zonesInfo = agentContext.managedZoneIds?.length
      ? ` | Zones=${agentContext.managedZoneIds.length}`
      : '';

    // R32-A1: actuator-zone presence as a count for the same reason.
    const actuatorCount = agentContext.actuatorZoneIds?.length ?? 0;
    const actuatorZonesInfo = actuatorCount > 0
      ? `\nACTUATORS: ${actuatorCount} zone(s) where you can physically act`
      : '';

    // Sensor-only status indicator for LLM context
    const isSensorOnly = !agentContext.actuatorZoneIds || agentContext.actuatorZoneIds.length === 0;
    const sensorOnlyInfo = isSensorOnly
      ? '\nROLE: SENSOR-ONLY → You detect events and alert capable agents. Always COLLABORATE.'
      : '';

    // R45-P1: dispatcher role — coordinators dispatch (see
    // COORDINATOR_ROLE_INSTRUCTION).
    const coordinatorInfo = agentContext.decisionRole === 'coordinator' ? COORDINATOR_ROLE_INSTRUCTION : '';

    // Coverage status: explicit relationship between event zone and agent's physical reach
    const eventZone = clusterSummary.region.id;
    const hasActuatorInZone = agentContext.actuatorZoneIds?.includes(eventZone);
    const hasAdjacentCoverage = agentContext.adjacentZoneIds?.includes(eventZone);
    // R32-A1: the NONE case no longer inlines the full actuator-zone ID list
    // (count given above); the rule-2/rule-3 fork needs the verdict, not the roster.
    const coverageInfo = isSensorOnly
      ? '\nCOVERAGE: NONE → Delegate to AVAILABLE_PARTNERS who have actuators.'
      : agentContext.actuatorZoneIds !== undefined
        ? `\nCOVERAGE: ${hasActuatorInZone ? 'DIRECT' : hasAdjacentCoverage ? 'PROPAGATION' : 'NONE'} — ${hasActuatorInZone ? 'You have actuators in this zone.' : hasAdjacentCoverage ? 'You can affect this zone via physical propagation from adjacent zones.' : 'You CANNOT physically reach this zone. Check EVENT_NEEDS: if your Caps match, COLLABORATE to delegate. If you lack those Caps, this is not your responsibility.'}`
        : '';

    // Required capabilities for this event.
    //
    // R35 label-alignment fix (bundled with §14.1): the EVENT_NEEDS line
    // renders the AUTHOR-DECLARED requiredCapabilities — the SAME list the
    // ground-truth calculator (deriveDecisionGroundTruth) scores against.
    // The previous INFERRED rendering (inferCapabilitiesFromCluster) showed
    // gaps the declared face does not carry, so the correct verdict
    // contradicted the visible evidence — the measured 63.4% prompt-agreement
    // ceiling (data/devloop/round35/scaling-report.md). With nothing declared
    // the line says so honestly (ground truth computes Gap=∅ there too).
    // Inferred needs remain a HINT for partner ranking below — never the
    // rendered requirement line.
    const declaredNeeds = extractDeclaredRequiredCapabilities(clusterSummary);
    const eventNeeds = inferCapabilitiesFromCluster(clusterSummary);

    // Build service information — handle concise-service ablation mode.
    // S1: partner service names/capabilities are OTHER tenants' authored
    // text — they ride the canonical untrusted-block sanitizer, never raw.
    //
    // R32-A1: the DEFAULT (non-ablation) path lists only the TOP-K partners
    // by capability/zone relevance to THIS event (compact form:
    // name + semanticType + zone), not the full registry listing. The full
    // listing was the 3.4k-token hot-path dominator (capacity-planning §1);
    // partner selection for an initiated AC happens downstream from the FULL
    // registry (CapabilityRelaxer/ContractNet), never from this prompt.
    //
    // R45-P4: the non-ablation path renders a structured catalog DIGEST — a
    // one-line per-domain stats row (offers marked) plus the top-K shortlist
    // (LLM_PARTNER_TOP_K, default 8; signable offers rank ahead at equal gap
    // relevance). Same determinism/honesty guarantees as R32, higher density.
    let servicesInfo: string;
    if (agentContext.conciseServiceMode) {
      // Concise mode (ablation): filter to services with location matching
      // event zone, use compact format (name only, no capabilities list).
      const allSvcs = agentContext.discoverableServices ?? [];
      const filteredSvcs = allSvcs.filter(s => s.location === eventZone);
      logger.info(`[ACNecessityAssessor] conciseServiceMode: ${allSvcs.length} total services, ${filteredSvcs.length} in event zone ${eventZone}`);
      servicesInfo = filteredSvcs.length > 0
        ? `AVAILABLE_PARTNERS: ${filteredSvcs.length} (other agents you can collaborate with): ${untrustedBlock('partner-services', filteredSvcs.map(s => s.serviceName).join(','))}`
        : 'AVAILABLE_PARTNERS: 0 (no other agents nearby)';
    } else if (agentContext.discoverableServices?.length) {
      const allSummaries = this.partnerIndex.summariesFor(agentContext);
      const digest = buildServiceCatalogDigest(allSummaries, declaredNeeds, eventNeeds, eventZone, agentContext.capabilities);
      if (digest.gapNeeds.length > 0 && !digest.hasGapMatch) {
        // Honest-empty: NO discovered service covers the agent's gap. Saying
        // so explicitly beats exhibiting irrelevant partners under a "by
        // relevance" label — the decision rules (rule 5: lacking something →
        // collaborate) still apply, and downstream partner search runs on the
        // full registry anyway. Gap needs are tenant-authored text → the
        // listing rides the S1 sanitizer like every other partner line.
        servicesInfo =
          `AVAILABLE_PARTNERS: 0 of ${digest.total} services cover this event's needs ` +
          `(you lack: ${untrustedBlock('partner-gap', digest.gapNeeds.join(', '))})`;
      } else {
        // Tenant-authored names/labels ride the S1 sanitizer; two single-line
        // blocks (untrustedBlock collapses embedded newlines by default).
        servicesInfo =
          `AVAILABLE_PARTNERS: ${digest.total} services in catalog (other agents' services, NOT yours):\n` +
          `${untrustedBlock('partner-catalog', renderCatalogStatsLine(digest))}\n` +
          untrustedBlock('partner-services', renderShortlistLine(digest));
      }
    } else {
      servicesInfo = 'AVAILABLE_PARTNERS: 0 (no other agents available)';
    }

    // R35: DECLARED face rendered (see comment above); "none declared" is
    // explicit — the rules below then read it as Gap=∅, matching ground truth.
    const needsInfo = declaredNeeds.length > 0
      ? `\nEVENT_NEEDS: ${untrustedBlock('event-needs', declaredNeeds.join(', '))} — compare with your Caps above`
      : '\nEVENT_NEEDS: none declared (the event states no capability requirements — treat your Caps as complete)';

    // S1: the event summary/zone/needs are tenant-authored world data — the
    // canonical sanitizer frames them as UNTRUSTED literal blocks so an
    // injection payload in an event narrative can never read as instructions
    // to the deciding model.
    const eventInfo = untrustedBlock(
      'event-summary',
      `Zone=${clusterSummary.region.id} | ${clusterSummary.summary}`,
    );

    // Mechanism B (agent-invocable flows): the HONEST tool listing — only
    // flows this agent may actually invoke (the runtime computes the list
    // with the same oracle the engine gate uses). Flow names/descriptions
    // are tenant-authored text, so the listing rides the S1 sanitizer. The
    // block (and therefore the model's ability to name a flow) exists ONLY
    // when something is offerable — agents without offerings see the exact
    // pre-B prompt.
    const offerings = agentContext.invocableFlows ?? [];
    let flowsInfo = '';
    if (offerings.length > 0) {
      const described = offerings
        .map(flow => {
          const params = (flow.inputs ?? [])
            .map(input => `${input.name}:${input.type}${input.required === true && input.default === undefined ? ' (required)' : ''}`)
            .join(', ');
          return `${flow.flowId} [${flow.name}${params.length > 0 ? `; params: ${params}` : '; no params'}]`;
        })
        .join('; ');
      flowsInfo =
        `\nINVOCABLE_FLOWS (your owner's standardized procedures you may run as your independent handling): ` +
        `${untrustedBlock('invocable-flows', described)}\n` +
        // R40-A4: the wording must match the STRUCTURED_OUTPUT_INSTRUCTION
        // encoding — actionPlan.primary.action="invoke_flow" with
        // flowId/flowParams. The pre-Phase-1 root-level "invokeFlow" key
        // taught providers that ignore the constrained format to emit an
        // encoding the parser dropped (silent flow loss).
        `If one of these fits, set actionPlan.primary.action to "invoke_flow" with its flowId (and flowParams for declared inputs; ` +
        'params must satisfy each declared type; omit optional ones you do not need). Never invent a flowId that is not listed.';
    }

    // R37-F2: the agent's OWN device inventory — the exact ids/commands the
    // cognitive deviceActions lane validates against (see below).
    const devicesInfo = this.buildOwnDevicesInventory(agentContext);

    // Phase 2: the unified world-model projection (SITUATION / RECENT_EVENTS
    // / PREVIOUS_DECISION). '' when no cognition context is attached — the
    // prompt stays byte-identical on the legacy path.
    const cognitionInfo = agentContext.cognition !== undefined
      ? renderCognitionPromptSections(agentContext.cognition)
      : '';

    // Phase 5: the meta-cognition projection (capability boundary / partner
    // trust / calibration + adaptive hints). Same additive rule as above.
    const metaCognitionInfo = agentContext.metaCognition !== undefined
      ? renderMetaCognitionPromptSections(agentContext.metaCognition)
      : '';

    return `AGENT: ${agentContext.agentName} | Caps=[${agentContext.capabilities.join(',')}]${zonesInfo}
EVENT: ${eventInfo}${needsInfo}
${actuatorZonesInfo}${sensorOnlyInfo}${coordinatorInfo}${coverageInfo}${devicesInfo}${cognitionInfo}${metaCognitionInfo}
${servicesInfo}${flowsInfo}
${this.buildOracleSection(agentContext)}Should this agent initiate collaboration?
DECISION:`;
  }

  /**
   * R37-F2 (validation finding F2): the OWN-device inventory for the decision
   * prompt — the exact deviceId/command surface the cognitive deviceActions
   * bridge validates against (DualTriggerACManager builds the bridge budget
   * from the SAME agentDevices this context's availableResources derive
   * from). Before this block the model literally could not know a valid
   * deviceId, so actionPlan.primary.deviceActions was unanswerable — 6/6 live
   * LLM decisions in R37 P1 emitted none.
   *
   * Mirrors the T-502 budget-device inventory (flow-delegate): per device —
   * exact deviceId, type, zone, key current state (primitives only, capped),
   * and the actuation commands (the device's non-sensor-style capabilities,
   * lowercased — the SAME surface the bridge's allowedCommands uses). Rendered
   * as an S1 untrusted world-data block exactly like every other data
   * listing; sensor-only agents (no actuation commands) see NO block — their
   * prompt stays byte-identical to the pre-F2 shape.
   */
  private buildOwnDevicesInventory(agentContext: AgentContext): string {
    const MAX_DEVICES = 10;
    const MAX_STATE_KEYS = 12;

    const zoneOf = (location: unknown): string | undefined => {
      if (typeof location === 'string' && location.length > 0) return location;
      if (typeof location === 'object' && location !== null) {
        const rec = location as Record<string, unknown>;
        const zone = rec.zoneId ?? rec.path;
        if (typeof zone === 'string' && zone.length > 0) return zone;
      }
      return undefined;
    };

    const inventory: Array<Record<string, unknown>> = [];
    for (const device of agentContext.availableResources ?? []) {
      if (typeof device?.deviceId !== 'string' || device.deviceId.length === 0) continue;
      // The bridge validates commands against the device's capabilities
      // (lowercased); read-style caps are never valid actuation commands
      // (isSensorStyleCapability — the same predicate the deterministic
      // planner uses), so only the actuation surface is listed.
      const commands = [...new Set(
        (Array.isArray(device.capabilities) ? device.capabilities : [])
          .map(cap => typeof cap === 'string' ? cap.toLowerCase() : '')
          .filter(cap => cap.length > 0 && !isSensorStyleCapability(cap)),
      )];
      if (commands.length === 0) continue; // pure sensor device — nothing to command

      const state: Record<string, unknown> = {};
      const rawState = device.currentState;
      if (typeof rawState === 'object' && rawState !== null) {
        for (const [key, value] of Object.entries(rawState)) {
          if (Object.keys(state).length >= MAX_STATE_KEYS) break;
          if (
            value === null ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            state[key] = value;
          }
        }
      }

      inventory.push({
        deviceId: device.deviceId,
        type: typeof device.type === 'string' ? device.type : 'unknown',
        ...(zoneOf(device.location) !== undefined ? { zone: zoneOf(device.location) } : {}),
        ...(device.isOnline === false ? { offline: true } : {}),
        ...(Object.keys(state).length > 0 ? { state } : {}),
        commands,
      });
      if (inventory.length >= MAX_DEVICES) break;
    }

    if (inventory.length === 0) return '';

    return (
      `\nMY_DEVICES (your OWN bound devices — for handle_independently, deviceActions may ONLY name these ` +
      `exact deviceIds and 'commands' values):\n` +
      untrustedJsonBlock('own-devices', inventory)
    );
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
   * T-041: the answer is canonicalized through the shared alias table
   * (utils/decisionVocabulary) on BOTH paths — the structured JSON parser
   * and the prose FSM fallback — so the model's decision survives parsing
   * (`llmDecision`) instead of collapsing to a boolean. `needsCollaboration`
   * is the derived boolean (`llmDecision === 'initiate_ac'`).
   *
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
      let llmDecision: CanonicalLLMDecision;
      let reasoning: string;

      const text = response.trim();

      const cognitive = this.config.useStructuredOutput
        // F0-2: the lane gate — guided JSON on → decision-v1 checked parse
        // (violations reject loudly onto the ladder); off → tolerant parse.
        ? parseCognitiveDecisionForLane(text, errors => logger.warn(`decision-v1 violation under guided JSON — degrading to the legacy ladder: ${errors.join('; ')}`))
        : null;

      // Structured-output path: when enabled, try to parse the response
      // as {"decision": "<alias>", "reasoning": "..."} (the BINARY legacy
      // contract). Any failure (no JSON, invalid JSON, unknown vocabulary)
      // falls back to the prose scanner below — e.g. when the provider
      // ignores `format`.
      const structured = cognitive === null && this.config.useStructuredOutput
        ? this.parseStructuredDecision(text)
        : null;

      // T-024-part3: which parser won rides the assessment so downstream
      // records can tell structured-output compliance from FSM recovery.
      let decisionSubSource: 'llm-json' | 'llm-fsm';
      // Mechanism B: a named flow rides along ONLY from a structured JSON
      // answer (the FSM prose scanner cannot express params reliably).
      let invokeFlow: LLMAssessment['invokeFlow'];
      // Phase 1: the full cognitive decision rides along when its parse won.
      let cognitiveDecision: CognitiveDecision | undefined;
      if (cognitive !== null) {
        llmDecision = cognitiveActionToLegacyDecision(cognitive.actionPlan.primary.action);
        reasoning = cognitive.explanation.summary || cognitive.actionPlan.primary.reasoning;
        if (reasoning.length === 0) reasoning = text.substring(0, 150);
        decisionSubSource = 'llm-json';
        cognitiveDecision = cognitive;
        // Mechanism B rides the cognitive actionPlan when the model named a
        // flow (gate unchanged: downstream honors it only on
        // handle_independently decisions against the offered listing).
        if (
          cognitive.actionPlan.primary.action === 'invoke_flow' &&
          cognitive.actionPlan.primary.flowId !== undefined
        ) {
          invokeFlow = {
            flowId: cognitive.actionPlan.primary.flowId,
            ...(cognitive.actionPlan.primary.flowParams !== undefined
              ? { params: cognitive.actionPlan.primary.flowParams }
              : {}),
          };
        }
        logger.info(`parseLLMResponse: cognitive JSON decision: ${llmDecision} (action=${cognitive.actionPlan.primary.action})`);
      } else if (structured) {
        llmDecision = structured.decision;
        reasoning = structured.reasoning;
        decisionSubSource = 'llm-json';
        invokeFlow = structured.invokeFlow;
        logger.info(`parseLLMResponse: structured JSON decision: ${llmDecision}`);
      } else {
        // Prose FSM scanner — first decisive alias phrase in the response
        // (any casing/punctuation variant, negation-aware), same vocabulary
        // as the structured path. One truth for the accepted answers.
        llmDecision = this.extractDecisionFSM(text);
        decisionSubSource = 'llm-fsm';

        // Everything after the first line is reasoning
        const firstNewline = text.indexOf('\n');
        reasoning = firstNewline >= 0
          ? text.substring(firstNewline + 1).trim()
          : text;
        if (reasoning.length === 0) reasoning = text.substring(0, 150);

        logger.info(`parseLLMResponse: FSM decision: ${llmDecision}, first 80 chars: "${text.substring(0, 80)}"`);
      }

      const needsCollaboration = llmDecision === 'initiate_ac';

      // T-041: the AUTHOR-DECLARED event requirements — the only list that
      // may downgrade an 'independent' answer to 'defer' in makeDecision.
      const declaredRequiredCapabilities = extractDeclaredRequiredCapabilities(clusterSummary);

      // Inferred requirements (keyword hints) — prompt context + partner
      // search only; NEVER a verdict over the model's answer. The model's
      // OWN collaboration block wins as the request face when it named one;
      // a model-omitted initiate_ac face is rewritten in assess()
      // (initiatorRequestFace).
      const requiredCapabilities = modelOrInferredCapabilities(
        cognitive?.actionPlan.primary.collaboration?.partnerCapabilities,
        clusterSummary,
      );

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
        llmDecision,
        decisionSubSource,
        declaredRequiredCapabilities,
        ...(invokeFlow !== undefined ? { invokeFlow } : {}),
        ...(cognitiveDecision !== undefined ? { cognitiveDecision } : {}),
        // T-106: cap stored LLM text at write time — reasoning/rawResponse
        // ride snapshots, WS pushes and trajectory JSONL; short answers stay
        // byte-identical.
        reasoning: truncateForStorage(reasoning),
        urgency,
        suggestedPartnerTypes,
        requiredCapabilities,
        confidence: 0.8,
        estimatedDuration: 60000,
        potentialRisks: [],
        rawResponse: truncateForStorage(rawResponse),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to parse LLM response:', error);
      throw new Error(`[ACNecessityAssessor] Failed to parse LLM response: ${msg}. Response was: ${(response || '').substring(0, 200)}`);
    }
  }



  /**
   * Try to parse a structured decision from the LLM response.
   *
   * Expects a JSON object of the form:
   *   {"decision": "<decision alias>", "reasoning": "..."}
   * and — Mechanism B — an OPTIONAL {"invokeFlow": {"flowId", "params"}}
   * when the prompt listed invocable flows.
   *
   * T-041: the `decision` string is canonicalized through the shared alias
   * table (any casing/punctuation variant, e.g. "Handle-It-Myself" or
   * "cooperate"), so the structured and prose paths accept exactly the same
   * vocabulary. Returns null on ANY failure of the DECISION fields (no JSON
   * found, JSON.parse error, missing or unknown `decision` value) so the
   * caller can fall back to the prose scanner. A malformed invokeFlow does
   * NOT fail the parse — the decision stands, and the malformed invocation
   * is dropped with a note in the reasoning (honest, never silent).
   */
  private parseStructuredDecision(
    text: string
  ): {
    decision: CanonicalLLMDecision;
    reasoning: string;
    invokeFlow?: { flowId: string; params?: Record<string, unknown> };
  } | null {
    try {
      const parsed: unknown = JSON.parse(this.extractJSON(text));
      if (typeof parsed !== 'object' || parsed === null) return null;

      const record = parsed as Record<string, unknown>;
      const decisionRaw = record.decision;
      if (typeof decisionRaw !== 'string') return null;
      const decision = canonicalizeLLMDecision(decisionRaw);
      if (decision === null) return null;

      const reasoningRaw = record.reasoning;
      let reasoning = typeof reasoningRaw === 'string' && reasoningRaw.trim().length > 0
        ? reasoningRaw.trim()
        : text.substring(0, 150);

      // Mechanism B: accept a well-formed invokeFlow; anything else present
      // under the key is dropped WITH a note (the standing silent-drop trap,
      // inverted for model output).
      let invokeFlow: { flowId: string; params?: Record<string, unknown> } | undefined;
      if (record.invokeFlow !== undefined) {
        const raw = record.invokeFlow;
        const flowId = (raw as { flowId?: unknown } | null)?.flowId;
        const rawParams = (raw as { params?: unknown } | null)?.params;
        if (
          typeof raw === 'object' && raw !== null && typeof flowId === 'string' && flowId.length > 0 &&
          (rawParams === undefined || (typeof rawParams === 'object' && rawParams !== null && !Array.isArray(rawParams)))
        ) {
          invokeFlow = {
            flowId,
            ...(rawParams !== undefined ? { params: rawParams as Record<string, unknown> } : {}),
          };
        } else {
          reasoning += ' [invokeFlow ignored: malformed — expected {flowId: string, params?: object}]';
        }
      }

      return { decision, reasoning, ...(invokeFlow !== undefined ? { invokeFlow } : {}) };
    } catch (error) {
      logger.warn(`parseStructuredDecision: JSON path failed, falling back to FSM parser: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Extract JSON from LLM response (handles markdown code blocks).
   * Minimal local replica of the helper used in
   * CollaborationProposalHandler (private there, so not importable).
   */
  private extractJSON(content: string): string {
    // Check if content contains markdown code blocks
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    // Check if content starts with { but has extra text
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return content.substring(firstBrace, lastBrace + 1);
    }

    // Return as-is if no patterns found
    return content.trim();
  }

  /**
   * Prose decision scanner (formerly a hand-rolled FSM).
   *
   * T-041: delegates to the shared alias-table scanner
   * (utils/decisionVocabulary.extractDecisionFromProse) — the SAME
   * vocabulary the structured JSON path and the triage parser accept, so
   * the accepted answers can never drift between paths. The scanner finds
   * the first decisive phrase (any casing/punctuation variant) while
   * skipping "DECISION:"-style prefixes, <think> reasoning blocks and XML
   * markup, and does NOT match phrases inside negations ("cannot handle it
   * myself" is not an answer).
   *
   * Safety-first default preserved from the old FSM: when no decisive phrase
   * exists, answer initiate_ac (collaborate) — an unparseable answer must
   * not silently drop a potentially urgent event.
   */
  private extractDecisionFSM(text: string): CanonicalLLMDecision {
    const decision = extractDecisionFromProse(text);
    if (decision !== null) {
      logger.info(`FSM: matched decisive phrase → ${decision}`);
      return decision;
    }

    logger.warn(`FSM: no decisive phrase found, defaulting to initiate_ac (safety-first). First 100 chars: "${text.substring(0, 100)}"`);
    return 'initiate_ac';
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
        // Check if agent has capabilities to act independently — against the
        // AUTHOR-DECLARED requirements only (T-041: the inferred keyword
        // table is a hint, never a verdict).
        if (!this.hasDeclaredCapabilityGap(llmAssessment, agentContext) && traits && traits.socialPreference < 0.4) {
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
      // T-041: the model's answer survives parsing (`llmDecision`). The
      // alias vocabulary can express defer/ignore directly — honor those
      // verbatim. The remaining case is 'handle_independently' (and the
      // legacy uncanonicalized boolean path, treated the same).
      if (llmAssessment.llmDecision === 'ignore') {
        logger.info('LLM explicitly answered ignore (not this agent\'s responsibility)');
        return 'ignore';
      }
      if (llmAssessment.llmDecision === 'defer') {
        logger.info('LLM explicitly answered defer (needs help / escalate)');
        return 'defer';
      }

      // T-041: the independent→defer downgrade fires ONLY when the AUTHOR
      // declared `payload.requiredCapabilities` the agent cannot satisfy
      // from its (T-202-enriched: declared ∪ own-device-derived) capability
      // surface. The hardcoded inferCapabilitiesFromCluster keyword table
      // used to decide this fork and mislabeled EVERY custom event type
      // (e.g. 'footfall-spike' "required" emergency-response → every honest
      // 'independent' answer was stored as defer). A custom event with NO
      // declared requirements defaults to handle_independently — the agent
      // knows its own devices.
      const missing = this.missingDeclaredCapabilities(llmAssessment, agentContext);

      // Collaborative agents may seek collaboration on a DECLARED gap even
      // when not strictly needed
      if (missing.length > 0 && traits && traits.socialPreference > 0.6) {
        logger.info(`High social preference agent seeking collaboration despite capability`);
        // This will trigger initiate_ac path below if workload allows
      } else if (missing.length > 0) {
        // Honest reason on the record: WHY the independent answer was downgraded.
        const note = `[deferred: event declares requiredCapabilities this agent cannot satisfy: ${missing.join(', ')}]`;
        llmAssessment.reasoning = llmAssessment.reasoning && llmAssessment.reasoning.length > 0
          ? `${llmAssessment.reasoning} ${note}`
          : note;
        logger.info(`Independent answer downgraded to defer: declared gaps [${missing.join(', ')}]`);
        return 'defer';
      } else {
        return 'handle_independently';
      }
    }

    // =====================================
    // STEP 5: Social preference affects collaboration decision
    // =====================================
    if (traits && llmAssessment.needsCollaboration) {
      // Very low social preference may prefer to avoid collaboration
      if (traits.socialPreference < 0.2 && llmAssessment.urgency !== 'urgent') {
        logger.info(`Very low social preference, handling independently if possible`);
        if (!this.hasDeclaredCapabilityGap(llmAssessment, agentContext)) {
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

  private deriveUrgency(
    clusterSummary: SpatialClusterSummary,
    missingCapabilities: string[],
  ): 'low' | 'medium' | 'high' | 'urgent' {
    // Moved to ./assessor-derivations.ts (arch-guard size ceiling) — thin delegate.
    return deriveAssessmentUrgency(clusterSummary, missingCapabilities);
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
