/**
 * Collaboration Proposal Handler Types
 *
 * Types for automatic evaluation and handling of incoming collaboration proposals
 */

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
  services?: any[];
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
