/**
 * Decision Module - Autonomous Decision-Making for Agents
 *
 * Contains two AC (Active Collaboration) triggering approaches:
 *
 * 1. Task-Driven AC (RECOMMENDED):
 *    - AC is triggered by explicit tasks from users/agents
 *    - LLM analyzes task complexity and capability requirements
 *    - More controlled and predictable behavior
 *
 * 2. Dual-Trigger AC (ENVIRONMENT-DRIVEN):
 *    - Layer 1: Non-LLM event filtering (95% filtered without LLM)
 *    - Layer 2: LLM cognitive decision for the remaining 5%
 *    - AC is triggered autonomously based on environmental events
 *
 * Key Principle: Agent decides autonomously whether to collaborate!
 *
 * R40-C2: the AutonomousDecisionEngine (the pre-Phase-2 standalone decision
 * lane) was retired — DualTriggerACManager's cognitive pipeline owns decisions.
 */

// Task-Driven AC System (Primary approach)
export { TaskACAnalyzer } from './TaskACAnalyzer.js';
export type {
  TaskInfo,
  ACAnalysisResult,
  ACAgentContext,
  TaskACAnalyzerConfig,
} from './TaskACAnalyzer.js';

// Layer 2: Cognitive Decision Components
export { ACNecessityAssessor } from './ACNecessityAssessor.js';
export type {
  AgentContext,
  LLMAssessment,
  ACNecessityAssessment,
  AssessorConfig,
  TriageConfig,
  TriageMetrics,
} from './ACNecessityAssessor.js';

// Phase 1 (cognitive architecture §14.1): the structured decision contract
// that replaces the binary LLM output — one truth for schema/parse/derivation.
export {
  COGNITIVE_DECISION_SCHEMA,
  parseCognitiveDecision,
  parseCognitiveDecisionV1Checked,
  parseCognitiveDecisionForLane,
  deriveLegacyDecision,
  cognitiveActionToLegacyDecision,
  canonicalizeCognitiveAction,
} from './cognitive-decision.js';
export type {
  CognitiveDecision,
  CognitivePrimaryAction,
  CognitiveSituationType,
  CognitiveDeviceAction,
  CognitiveServiceTarget,
} from './cognitive-decision.js';

// R6-E-F07: consume_service — locked-target service consumption lane.
export { resolveLockedService, lockedServiceSelection } from './consume-service.js';
export type { ResolvedServiceTarget } from './consume-service.js';

// F0-2: the versioned decision schema document (single source of truth) +
// its validator — the wire schema above derives from schemas/decision-v1.json.
export {
  DECISION_SCHEMA_VERSION,
  DECISION_V1_WIRE_SCHEMA,
  validateDecisionV1,
} from './decision-schema.js';
export type { DecisionV1Validation } from './decision-schema.js';

export { PartnerSelectionNegotiator } from './PartnerSelectionNegotiator.js';
export type {
  PartnerCandidate,
  CollaborationRequirement,
  CollaborationProposal,
  CollaborationResponse,
  PartnerSelectionResult,
  NegotiatorConfig,
} from './PartnerSelectionNegotiator.js';

// Phase 6: Contract Net Protocol (FIPA00029) — bid collection + ranking.
export {
  selectBestPartner,
  computeBidScore,
  isQuorumReached,
  DEFAULT_COLLABORATION_MODE,
  type PartnerBid,
  type CollaborationMode,
} from './ContractNetProtocol.js';

// Phase 7: Capability relaxation for fallback search.
export { CapabilityRelaxer } from './CapabilityRelaxer.js';

export { GoalFormulationEngine } from './GoalFormulationEngine.js';
export type {
  ACCollaborationGoal,
  ACCSuccessCriterion,
  ResourceRequirement,
  ACCollaborationConfig,
  GoalFormulationResult,
  GoalEngineConfig,
} from './GoalFormulationEngine.js';

// Dual-Trigger AC Manager - Integrates Layer 1 + Layer 2
export { DualTriggerACManager } from './DualTriggerACManager.js';
export type {
  DualTriggerConfig,
  DualTriggerResult,
  ACInitiationCallback,
} from './DualTriggerACManager.js';

// Task-Driven AC Manager - Task-based LLM invocation (RECOMMENDED)
export { TaskDrivenACManager, TaskQueue } from './TaskDrivenACManager.js';
export type {
  AgentTask,
  TaskResult,
  TaskDrivenConfig,
  TaskACInitiationCallback
} from './TaskDrivenACManager.js';
