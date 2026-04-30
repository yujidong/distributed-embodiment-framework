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
 */

// Core Decision Engine
export { AutonomousDecisionEngine } from './AutonomousDecisionEngine.js';

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
} from './ACNecessityAssessor.js';

export { PartnerSelectionNegotiator } from './PartnerSelectionNegotiator.js';
export type {
  PartnerCandidate,
  CollaborationRequirement,
  CollaborationProposal,
  CollaborationResponse,
  PartnerSelectionResult,
  NegotiatorConfig,
} from './PartnerSelectionNegotiator.js';

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
