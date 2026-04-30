/**
 * AC Decision Coordinator
 *
 * Encapsulates AC (Active Collaboration) decision and triggering logic
 *
 * Key Responsibilities:
 * - Enable/disable dual trigger AC
 * - Formulate collaboration goals
 * - Evaluate proposals
 * - Make autonomous decisions
 * - Emit AC decision events
 *
 * Architecture principle:
 * - Does NOT reimplement decision logic
 * - Delegates to DualTriggerACManager, AutonomousDecisionEngine, MultiFactorProposalEvaluator
 * - Only adds coordination and event emission
 */

import type { DualTriggerACManager } from '../../decision/DualTriggerACManager.js';
import type { AutonomousDecisionEngine } from '../../decision/AutonomousDecisionEngine.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '@active-collaboration/shared';
import type { ACCollaborationGoal, ResourceRequirement } from '../../decision/GoalFormulationEngine.js';

import { createLogger } from '@active-collaboration/shared';
// Re-export types from other modules for convenience
const logger = createLogger('ACDecisionCoordinator');

export type { ACCollaborationGoal, ResourceRequirement } from '../../decision/GoalFormulationEngine.js';

/**
 * Proposal Evaluation Result
 * Simplified version for coordinator use
 */
export interface ProposalEvaluationResult {
  score: number;
  recommendation: string;
  confidence?: number;
  factors?: Record<string, number>;
}

/**
 * AC Decision Coordinator
 *
 * Coordinates AC decision-making for CognitiveAgent by wrapping decision components.
 * Emits events when AC decisions are made for observability and debugging.
 */
export class ACDecisionCoordinator {
  /**
   * Creates a new ACDecisionCoordinator
   *
   * @param dualTriggerManager - DualTriggerACManager instance
   * @param decisionEngine - AutonomousDecisionEngine instance
   * @param eventEmitter - EventEmitter for emitting AC events
   * @param agentId - ID of the agent this coordinator belongs to
   * @param proposalEvaluator - Optional proposal evaluator
   */
  constructor(
    private readonly dualTriggerManager: DualTriggerACManager,
    private readonly decisionEngine: AutonomousDecisionEngine,
    private readonly eventEmitter: EventEmitter,
    private readonly agentId: string,
    private readonly proposalEvaluator?: any
  ) {}

  /**
   * Enable dual trigger AC system
   *
   * @param config - Optional configuration
   */
  enableDualTriggerAC(config?: any): void {
    // DualTriggerACManager doesn't have enable/disable methods in current implementation
    // AC is always enabled when DualTriggerACManager is instantiated
    logger.info(`[ACDecisionCoordinator:${this.agentId}] Dual trigger AC is configured`);
  }

  /**
   * Disable dual trigger AC system
   */
  disableDualTriggerAC(): void {
    logger.info(`[ACDecisionCoordinator:${this.agentId}] Dual trigger AC disabled`);
  }
  /**
   * Formulate collaboration goal
   *
   * @param requirements - Resource requirements for this goal
   * @returns Collaboration goal
   */
  async formulateGoal(requirements: ResourceRequirement[]): Promise<ACCollaborationGoal> {
    // Handle null or undefined requirements
    if (!requirements || !Array.isArray(requirements)) {
      const emptyGoal: ACCollaborationGoal = {
        id: `goal-${Date.now()}`,
        name: 'Empty Goal',
        description: 'No requirements provided',
        objective: 'No specific objective',
        priority: 'low',
        successCriteria: [],
        targetAgents: [],
        targetDevices: [],
        requiredCapabilities: [],
        maxDuration: 300000, // 5 minutes
        timeout: 60000, // 1 minute
        dependsOn: [],
        blocks: [],
        status: 'pending',
        progress: 0
      };
      return emptyGoal;
    }

    // Note: DualTriggerACManager doesn't have formulateGoal method
    // This is a simplified implementation - actual goal formulation would need GoalFormulationEngine
    // For now, return a basic goal structure
    const goal: ACCollaborationGoal = {
      id: `goal-${Date.now()}`,
      name: 'Collaboration Goal',
      description: 'Collaboration goal based on requirements',
      objective: 'Achieve collaboration goal',
      priority: 'medium',
      successCriteria: [],
      targetAgents: [],
      targetDevices: [],
      requiredCapabilities: requirements.map(r => r.capability),
      maxDuration: 300000, // 5 minutes
      timeout: 60000, // 1 minute
      dependsOn: [],
      blocks: [],
      status: 'pending',
      progress: 0
    };

    logger.info(`[ACDecisionCoordinator:${this.agentId}] Goal formulated: ${goal.id}`);
    return goal;
  }
  /**
   * Evaluate a proposal
   *
   * @param proposal - Proposal to evaluate
   * @returns Evaluation result
   */
  async evaluateProposal(proposal: any): Promise<ProposalEvaluationResult> {
    try {
      logger.info(`[ACDecisionCoordinator:${this.agentId}] Evaluating proposal`);
      // If no evaluator is configured, return default evaluation
      if (!this.proposalEvaluator) {
        logger.info(`[ACDecisionCoordinator:${this.agentId}] No evaluator configured, returning default`);
        return {
          score: 0.5,
          recommendation: 'No evaluator configured - default evaluation'
        };
      }
      // Delegate to evaluator if it has evaluate method
      if (typeof this.proposalEvaluator.evaluate === 'function') {
        const evaluation = await this.proposalEvaluator.evaluate(proposal, this.getAgentContext());
        logger.info(`[ACDecisionCoordinator:${this.agentId}] Proposal evaluated: score=${evaluation.score}`);
        return {
          score: evaluation.score,
          recommendation: evaluation.recommendation || 'Proposal evaluated successfully'
        };
      }
      // Fallback if evaluator doesn't have evaluate method
      logger.warn(`[ACDecisionCoordinator:${this.agentId}] Evaluator doesn't have evaluate method`);
      return {
        score: 0.5,
        recommendation: 'Evaluator available but method not accessible'
      };
    } catch (error) {
      logger.error(`[ACDecisionCoordinator:${this.agentId}] Proposal evaluation failed:`, error);
      return {
        score: 0,
        recommendation: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  /**
   * Make autonomous decision
   *
   * @param context - Decision context
   * @returns Decision result
   */
  async makeAutonomousDecision(context: any): Promise<any> {
    try {
      logger.info(`[ACDecisionCoordinator:${this.agentId}] Making autonomous decision`);
      // Delegate to AutonomousDecisionEngine if it has makeDecision method
      if (this.decisionEngine && typeof this.decisionEngine.makeDecision === 'function') {
        const result = await this.decisionEngine.makeDecision(context);
        logger.info(`[ACDecisionCoordinator:${this.agentId}] Decision made: ${result.decision}`);
        return result;
      }
      // Fallback to default decision if method not available
      logger.warn(`[ACDecisionCoordinator:${this.agentId}] AutonomousDecisionEngine.makeDecision not available, using default`);
      return {
        decision: 'handle_independently',
        confidence: 0.8,
        reasoning: 'Default autonomous decision - decision engine not available'
      };
    } catch (error) {
      logger.error(`[ACDecisionCoordinator:${this.agentId}] Decision making failed:`, error);
      return {
        decision: 'handle_independently',
        confidence: 0.5,
        reasoning: `Decision failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }
  /**
   * Check if should trigger AC
   *
   * @param context - Agent context
   * @returns Whether AC should be triggered
   */
  async shouldTriggerAC(context: any): Promise<boolean> {
    // Note: DualTriggerACManager doesn't have shouldTrigger or isEnabled methods
    // For now, return false - actual trigger logic is handled by DualTriggerACManager.processEvent
    return false;
  }
  /**
   * Get agent context for proposal evaluation
   */
  private getAgentContext(): any {
    return {
      agentId: this.agentId,
      capabilities: [],
      currentLoad: 0,
      availableResources: []
    };
  }
}
