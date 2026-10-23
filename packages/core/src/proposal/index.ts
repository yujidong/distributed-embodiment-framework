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

// R6-B-F02: provider-side fulfillment gate (multi-hop delegation, hop budget).
export {
  assessFulfillment,
  fulfillmentGap,
  hopContextOf,
  DownstreamDelegator,
  DEFAULT_MAX_HOP_DEPTH,
  DEFAULT_DELEGATION_TIMEOUT_MS,
} from './fulfillment-gate.js';
export type {
  FulfillmentGateConfig,
  FulfillmentRecord,
  FulfillmentVerdict,
  HopContext,
  DownstreamTarget,
} from './fulfillment-gate.js';
