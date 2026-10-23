/**
 * Proposal Evaluation and Selection Interfaces
 *
 * Extensible architecture for Phase 5 Global Proposal workflow
 */

/**
 * Global proposal request sent from coordinator to all agents
 */
export interface GlobalProposalRequest {
  proposalId: string;
  fromAgent: string;
  task: {
    type: string;
    description: string;
    requirements: {
      capabilities: string[];
      constraints?: Record<string, unknown>;
    };
  };
  terms: {
    contractType: 'new-service-creation' | 'service-collaboration';
    duration: number;
    priority: 'normal' | 'high' | 'urgent';
  };
}

/**
 * Context about the evaluating agent
 */
export interface AgentContext {
  agentId: string;
  capabilities: string[];
  resources: Resource[];
  currentLoad: number;  // 0-1 (0 = idle, 1 = overloaded)
  historicalPerformance?: {
    completedTasks: number;
    averageQuality: number;  // 0-1
    averageTime: number;     // milliseconds
  };
}

/**
 * Resource interface (simplified for proposal context)
 */
export interface Resource {
  id: string;
  type: string;
  category?: string;
  capabilities?: string[];
}

/**
 * Result of proposal evaluation
 */
export interface ProposalEvaluationResult {
  /** Overall score (0-1) */
  score: number;

  /** Decision: accept, reject, or negotiate */
  decision: 'accept' | 'reject' | 'negotiate';

  /** Detailed breakdown of factors */
  factors: EvaluationFactors;

  /** If decision is 'negotiate', provide counter-proposal */
  counterProposal?: CounterProposal;

  /** Human-readable explanation */
  reason: string;
}

/**
 * Evaluation factors breakdown
 */
export interface EvaluationFactors {
  capabilityMatch: number;      // 0-1
  resourceAvailability: number;  // 0-1
  currentLoad: number;           // 0-1
  serviceComplexity: number;     // 0-1
  requirementCompliance: number;  // 0-1 - NEW: Requirement specification compliance
  estimatedCompletionTime: number; // milliseconds
  confidence: number;            // 0-1
}

/**
 * Counter-proposal for negotiation
 * (Interface designed for future use)
 */
export interface CounterProposal {
  message: string;
  canHandle: string[];
  cannotHandle: string[];
  alternativeProposals?: string[];
}

/**
 * Wrapper for evaluation response with metadata
 */
export interface ProposalEvaluationResponse extends ProposalEvaluationResult {
  proposalId: string;
  fromAgent: string;
  receivedAt: Date;
}

/**
 * Service lifecycle actions
 */
export enum LifecycleAction {
  /** Delete the service immediately */
  DELETE = 'delete',

  /** Keep the service for future use */
  KEEP = 'keep',

  /** Promote to permanent service (persist across sessions) */
  PROMOTE_TO_PERMANENT = 'promote',

  /** Archive (stop but keep metadata) */
  ARCHIVE = 'archive',

  /** Extend TTL (for usage-based policies) */
  EXTEND_TTL = 'extend'
}

/**
 * Context about service execution
 */
export interface ServiceExecutionContext {
  serviceId: string;
  acId: string;
  executionSuccess: boolean;
  executionTime: number;
  executionQuality: number;  // 0-1
  timestamp: Date;
  strategy?: string;  // Lifecycle strategy to use
}

/**
 * Context about service creation
 */
export interface ServiceCreationContext {
  serviceId: string;
  createdBy: string;
  creationReason: string;
  taskType: string;
  estimatedLifetime?: number;
}

/**
 * Proposal Evaluator Interface
 * Evaluates whether an agent should accept a global proposal
 */
export interface IProposalEvaluator {
  evaluate(
    proposal: GlobalProposalRequest,
    agentContext: AgentContext
  ): Promise<ProposalEvaluationResult>;
}

/**
 * Proposal Selector Interface
 * Selects the best proposal from multiple accepted responses
 */
export interface IProposalSelector {
  select(responses: ProposalEvaluationResponse[]): ProposalEvaluationResponse | null;
}

/**
 * Service Lifecycle Strategy Interface
 * Manages the lifecycle of dynamically created services
 */
export interface IServiceLifecycleStrategy {
  afterExecution(
    serviceId: string,
    executionContext: ServiceExecutionContext
  ): LifecycleAction | Promise<LifecycleAction>;

  onCreation?(serviceId: string, creationContext: ServiceCreationContext): void;
}
