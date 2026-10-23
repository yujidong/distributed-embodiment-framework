/**
 * Collaboration Proposal Handler Types
 *
 * Types for automatic evaluation and handling of incoming collaboration proposals
 */

/**
 * One structured service term of a proposal (R42-A/F3 §7.2).
 *
 * Legacy proposals carried `services: string[]` (names only); new proposals
 * carry structured terms so the responder can match them against its own
 * catalog by semanticType. Plain strings remain accepted everywhere and
 * render name-only (backward compatible).
 */
export interface ProposalServiceTerm {
  name: string;
  /** Semantic type of the requested service (e.g. 'temperature-control'). */
  semanticType?: string;
  /** Optional invocation terms (visibility, SLA, invocation constraints…). */
  terms?: Record<string, unknown>;
}

/**
 * Collaboration proposal interface
 */
export interface CollaborationProposal {
  id: string;
  proposedBy: string;
  proposedTo: string;
  type: string;
  goal: string;
  task?: string;
  description?: string;
  capabilities: string[];
  /**
   * Phase 3 proposal formation type (responder-side copy): the initiator
   * marks 'service-invocation' when the request locks onto a published
   * service (broker lane or a consume_service decision) — the capability
   * fallback lowers its accept threshold for these (pre-confirmed match).
   */
  proposalType?: 'service-invocation' | 'capability-broadcast' | 'service-adaptation';
  /** Structured service terms; legacy string entries stay valid (§7.2). */
  services?: Array<ProposalServiceTerm | string>;
  resources?: any[];
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  validUntil?: Date;
  metadata?: Record<string, any>;
}

/**
 * Proposal evaluation result
 */
export type ProposalDecision = 'accept' | 'reject' | 'counter' | 'defer';

/**
 * R6-C-F03: the trigger-event reference riding a proposal (initiator
 * backfill — factual fields from the L1 cluster, NOT the model's free-text
 * narrative). The responder's ground-truth check uses it to locate the
 * claimed situation in its own observation range.
 */
export interface ProposalTriggerRef {
  /** The environment event type that triggered the AC (cluster events[0].type). */
  triggerEventType?: string;
  /** The shared (agent-independent) source event id. */
  triggerEventId?: string;
  /** The zone the trigger event belongs to (cluster region id). */
  triggerZoneId?: string;
}

/** One digested world event the responder itself observed (world-model ring entry). */
export interface ProposalGroundTruthEvent {
  type: string;
  zoneId?: string;
  parameter?: string;
  value?: number | boolean;
}

/**
 * R6-C-F03: the responder-side ground-truth face — what the EVALUATING agent
 * itself observed about the world, read live at evaluation time (zone-scoped
 * event delivery already gates what could enter it). Optional seam: an
 * unwired handler renders no EVENT GROUND TRUTH section and keeps the legacy
 * behavior (pinned).
 */
export interface ProposalGroundTruthFace {
  /** Zones the responder can observe (managed ∪ bound-device ∪ any zone with readings). */
  observableZoneIds: string[];
  /** Latest observed parameter readings per zone (only zones with data). */
  zoneReadings: Array<{ zoneId: string; parameters: Record<string, number | boolean> }>;
  /** Recently digested world events (the responder's own observation ring). */
  recentEvents?: ProposalGroundTruthEvent[];
}

/**
 * R44-extreme-F1 (plan-r81 D1): audit record of a prompt-budget trim. When
 * the assembled evaluation prompt exceeds the token budget, the footprint-
 * preserving budget mode kicks in and the trim is recorded here — on the
 * ProposalEvaluation AND in responderContext (every handshake answer
 * payload), so the trajectory shows the degradation instead of hiding it.
 */
export interface ProposalPromptTrim {
  /** The budget that was exceeded (tokens). */
  budgetTokens: number;
  /** Estimated tokens of the prompt BEFORE the trim. */
  estimatedTokensBefore: number;
  /** Estimated tokens after footprint-preserving aggregation. */
  estimatedTokensAfter: number;
  /** Devices listed in full (the proposal footprint — never trimmed). */
  devicesListed: number;
  /** Devices collapsed into the aggregate line. */
  devicesAggregated: number;
  /** Services listed in full; collapsed into the aggregate line. */
  servicesListed: number;
  servicesAggregated: number;
}

/**
 * Proposal evaluation result
 */
export interface ProposalEvaluation {
  /** The proposal being evaluated */
  proposal: CollaborationProposal;

  /** Decision on what to do with the proposal */
  decision: ProposalDecision;

  /** Confidence in the decision (0-1) */
  confidence: number;

  /** Reasoning behind the decision */
  reasoning: string;

  /** Benefits of accepting this proposal */
  benefits: string[];

  /** Costs/risks of accepting this proposal */
  costs: string[];

  /** If decision is 'counter', what to counter-propose */
  counterProposal?: {
    modifications: string[];
    reasoning: string;
  };

  /** Estimated resources required */
  resourceRequirements?: {
    computation: number; // 0-1 scale
    memory: number; // 0-1 scale
    time: number; // estimated milliseconds
  };

  /** Timestamp of evaluation */
  evaluatedAt: Date;

  /**
   * R44-extreme-F1 (plan-r81 D1): present when the evaluation prompt
   * exceeded the token budget and the device/service sections were trimmed
   * footprint-preserving. Undefined when the prompt fit — a missing field
   * means NO degradation happened.
   */
  promptTrim?: ProposalPromptTrim;

  /**
   * R5-F10: present ONLY on a capability-fallback evaluation — the error
   * that knocked the LLM out (timeout, provider failure, unparseable
   * output). Rides every handshake answer payload so the trajectory's
   * collaboration-response record shows WHY the LLM did not participate
   * instead of a bare decisionSource 'fallback' (the silent-degradation
   * half of R5-F10). Undefined on genuine LLM evaluations.
   */
  evaluationError?: string;
}

/**
 * Proposal evaluation criteria
 */
export interface EvaluationCriteria {
  /** Minimum benefit threshold (0-1) */
  minBenefitThreshold: number;

  /** Maximum acceptable cost (0-1) */
  maxCostThreshold: number;

  /** Required capabilities (proposal must provide at least one) */
  requiredCapabilities?: string[];

  /** Preferences for partner selection */
  partnerPreferences?: {
    /** Prefer agents we've collaborated with before */
    preferPreviousPartners: boolean;

    /** Minimum reputation/trust score (0-1) */
    minReputation: number;
  };

  /** Resource constraints */
  resourceConstraints?: {
    maxComputationCapacity: number;
    maxMemoryCapacity: number;
    maxTimeAllocation: number;
  };
}

/**
 * Proposal handler configuration
 */
export interface ProposalHandlerConfig {
  /** Whether auto-evaluation is enabled */
  enabled: boolean;

  /** Evaluation criteria */
  criteria: EvaluationCriteria;

  /** Whether to automatically execute accepted proposals */
  autoExecuteAccepted: boolean;

  /** Whether to notify agent of all proposals */
  notifyAllProposals: boolean;

  /** Maximum number of concurrent collaborations */
  maxConcurrentCollaborations: number;

  /**
   * Wall-clock budget (ms) for ONE proposal-evaluation LLM call (Fix-12).
   * Without it a cold/unreachable model burns the provider-level timeout
   * (120s class) before the capability fallback fires, which is
   * why handshake accepts landed ~110-120s after the proposal (R4 小周 F-16).
   * On expiry the evaluation falls back to capability matching. Default 30s.
   */
  llmTimeoutMs?: number;

  /**
   * Suggested delay (ms) before re-evaluating a DEFERRED proposal (Wave-4a).
   * Capped at MAX_DEFER_DELAY_MS (60s) so a defer can never push the answer
   * past the initiator's 120s handshake-timeout backstop. Default 30s.
   */
  deferDelayMs?: number;

  /**
   * R44-extreme-F1 (plan-r81 D1): TOTAL token budget for the evaluation
   * prompt. When the assembled prompt exceeds it, the device/service
   * sections are rebuilt footprint-preserving (proposal-relevant rows kept
   * in full, the rest aggregated) and the trim is logged + recorded on the
   * evaluation. Wins over PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS; default
   * DEFAULT_PROMPT_BUDGET_TOKENS (6000 — leaves ~2K of an 8,192 context for
   * the output reservation).
   */
  promptBudgetTokens?: number;
}

/**
 * LLM-based proposal analysis
 */
export interface LLMProposalAnalysis {
  /** Overall assessment */
  assessment?: string;

  /** Benefits identified */
  benefits: string[];

  /** Costs/risks identified */
  costs: string[];

  /** Recommendation */
  recommendation?: 'accept' | 'reject' | 'counter' | 'defer';

  /** Recommended decision */
  recommendedDecision?: 'accept' | 'reject' | 'counter' | 'defer';

  /** Confidence in recommendation (0-1) */
  confidence?: number;

  /** Suggested modifications if counter-proposing */
  suggestedModifications?: string[];

  /** Counter modifications */
  counterModifications?: string[];

  /** Estimated benefits (0-1) */
  benefitScore: number;

  /** Estimated costs (0-1) */
  costScore: number;

  /** Reasoning */
  reasoning?: string;
}
