/**
 * Proposal Handler Module
 */

export { CollaborationProposalHandler } from './CollaborationProposalHandler.js';
export type {
  ProposalDecision,
  ProposalEvaluation,
  EvaluationCriteria,
  ProposalHandlerConfig,
} from '../types/proposal-handler.js';

// Phase 5: Global Proposal Evaluation and Selection
export * from './interfaces.js';
export { MultiFactorProposalEvaluator } from './MultiFactorProposalEvaluator.js';
export { ScoreBasedProposalSelector } from './ScoreBasedProposalSelector.js';
export {
  ServiceLifecycleManager,
  TemporaryServiceStrategy,
  PersistentServiceStrategy,
  UsageBasedServiceStrategy,
  PromoteOnUseStrategy
} from './ServiceLifecycleManager.js';
