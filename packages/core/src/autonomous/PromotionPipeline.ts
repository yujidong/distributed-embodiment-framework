/**
 * PromotionPipeline - Code Promotion Workflow
 *
 * Manages the lifecycle of generated code from sandbox to production.
 * Implements stage-based promotion with human approval gates.
 */

import type { ValidationResult } from './CodeValidator.js';
import type { SandboxExecutionResult } from './SandboxManager.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Promotion stages
 */
const logger = createLogger('PromotionPipeline');

export enum PromotionStage {
  GENERATED = 'generated', // Code has been generated
  VALIDATED = 'validated', // Code has passed validation
  SANDBOX_TESTED = 'sandbox_tested', // Code has been tested in sandbox
  PENDING_APPROVAL = 'pending_approval', // Awaiting human approval
  APPROVED = 'approved', // Approved for deployment
  DEPLOYED = 'deployed', // Deployed to production
  REJECTED = 'rejected', // Rejected
}

/**
 * Promotion request
 */
export interface PromotionRequest {
  id: string;
  agentId: string;
  code: string;
  requirements: string[];
  validation: ValidationResult;
  sandboxResult?: SandboxExecutionResult;
  currentStage: PromotionStage;
  stageHistory: StageTransition[];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, any>;
}

/**
 * Stage transition
 */
export interface StageTransition {
  stage: PromotionStage;
  timestamp: Date;
  reason?: string;
  actor?: 'system' | 'human' | 'agent';
}

/**
 * Promotion decision
 */
export interface PromotionDecision {
  approved: boolean;
  reason: string;
  autoApproved: boolean;
  confidence: number; // 0-100
  timestamp: Date;
  reviewer?: string;
}

/**
 * PromotionPipeline class
 */
export class PromotionPipeline {
  private requests: Map<string, PromotionRequest>;
  private autoApproveThreshold: number; // Score above which auto-approval is allowed
  private requestCounter: number;

  constructor(autoApproveThreshold: number = 85) {
    this.requests = new Map();
    this.autoApproveThreshold = autoApproveThreshold;
    this.requestCounter = 0;

    logger.info('Initialized with auto-approve threshold:', autoApproveThreshold);
  }

  /**
   * Create a new promotion request
   * @param agentId - Agent generating the code
   * @param code - Generated code
   * @param requirements - Requirements the code should meet
   * @param validation - Validation result
   * @param sandboxResult - Sandbox execution result
   * @returns Promotion request
   */
  createRequest(
    agentId: string,
    code: string,
    requirements: string[],
    validation: ValidationResult,
    sandboxResult?: SandboxExecutionResult
  ): PromotionRequest {
    const requestId = `promo_${Date.now()}_${++this.requestCounter}`;
    const now = new Date();

    // Determine initial stage
    let initialStage = PromotionStage.GENERATED;
    if (validation.valid) {
      initialStage = PromotionStage.VALIDATED;
      if (sandboxResult && sandboxResult.success) {
        initialStage = PromotionStage.SANDBOX_TESTED;
      }
    }

    const request: PromotionRequest = {
      id: requestId,
      agentId,
      code,
      requirements,
      validation,
      sandboxResult,
      currentStage: initialStage,
      stageHistory: [
        {
          stage: initialStage,
          timestamp: now,
          actor: 'system',
          reason: 'Request created',
        },
      ],
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    this.requests.set(requestId, request);

    logger.info(`Request ${requestId} created at stage: ${initialStage}`);

    return request;
  }

  /**
   * Advance request to next stage
   * @param requestId - Request ID
   * @param stage - Target stage
   * @param reason - Reason for transition
   * @param actor - Who triggered the transition
   * @returns Success status
   */
  advanceToStage(
    requestId: string,
    stage: PromotionStage,
    reason?: string,
    actor: 'system' | 'human' | 'agent' = 'system'
  ): boolean {
    const request = this.requests.get(requestId);
    if (!request) {
      logger.warn(`Request ${requestId} not found`);
      return false;
    }

    // Validate stage transition
    if (!this.isValidTransition(request.currentStage, stage)) {
      logger.warn(`Invalid stage transition: ${request.currentStage} -> ${stage}`
      );
      return false;
    }

    // Update stage
    request.currentStage = stage;
    request.stageHistory.push({
      stage,
      timestamp: new Date(),
      reason,
      actor,
    });
    request.updatedAt = new Date();

    this.requests.set(requestId, request);

    logger.info(`Request ${requestId} advanced to: ${stage}`);

    return true;
  }

  /**
   * Request human approval for a promotion request
   * @param requestId - Request ID
   * @returns Promotion decision (auto-approved if applicable)
   */
  async requestApproval(requestId: string): Promise<PromotionDecision> {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    logger.info(`Requesting approval for ${requestId}`);

    // Check if auto-approval is possible
    const autoDecision = this.autoApprove(requestId);
    if (autoDecision) {
      return autoDecision;
    }

    // Move to pending approval stage
    this.advanceToStage(requestId, PromotionStage.PENDING_APPROVAL, 'Awaiting human approval', 'system');

    // Return pending decision
    return {
      approved: false,
      reason: 'Pending human approval',
      autoApproved: false,
      confidence: request.validation.score,
      timestamp: new Date(),
    };
  }

  /**
   * Submit human approval decision
   * @param requestId - Request ID
   * @param decision - Approval decision
   */
  submitApproval(requestId: string, decision: Omit<PromotionDecision, 'timestamp'>): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    const fullDecision: PromotionDecision = {
      ...decision,
      timestamp: new Date(),
    };

    logger.info(`Approval decision for ${requestId}:`, decision.approved);

    if (decision.approved) {
      this.advanceToStage(
        requestId,
        PromotionStage.APPROVED,
        decision.reason,
        'human'
      );
    } else {
      this.advanceToStage(
        requestId,
        PromotionStage.REJECTED,
        decision.reason,
        'human'
      );
    }

    // Store decision in metadata
    request.metadata.approvalDecision = fullDecision;
    this.requests.set(requestId, request);
  }

  /**
   * Attempt auto-approval based on validation score
   * @param requestId - Request ID
   * @returns Approval decision if auto-approvable, null otherwise
   */
  autoApprove(requestId: string): PromotionDecision | null {
    const request = this.requests.get(requestId);
    if (!request) {
      return null;
    }

    const score = request.validation.score;

    // Check if score meets auto-approve threshold
    if (score >= this.autoApproveThreshold) {
      // Additional checks
      if (!request.validation.valid) {
        logger.info(`Score ${score} meets threshold but validation failed`);
        return null;
      }

      if (request.sandboxResult && !request.sandboxResult.success) {
        logger.info(`Score ${score} meets threshold but sandbox test failed`);
        return null;
      }

      // Auto-approve
      const decision: PromotionDecision = {
        approved: true,
        reason: `Auto-approved: validation score ${score} >= ${this.autoApproveThreshold}`,
        autoApproved: true,
        confidence: score,
        timestamp: new Date(),
      };

      logger.info(`Auto-approving request ${requestId} with score ${score}`);

      this.advanceToStage(requestId, PromotionStage.APPROVED, decision.reason, 'system');

      // Store decision
      request.metadata.approvalDecision = decision;
      this.requests.set(requestId, request);

      return decision;
    }

    logger.info(`Score ${score} below auto-approve threshold ${this.autoApproveThreshold}`);
    return null;
  }

  /**
   * Deploy code to production
   * @param requestId - Request ID
   * @returns Deployed code
   */
  deployToProduction(requestId: string): { success: boolean; code?: string; error?: string } {
    const request = this.requests.get(requestId);
    if (!request) {
      return {
        success: false,
        error: `Request ${requestId} not found`,
      };
    }

    if (request.currentStage !== PromotionStage.APPROVED) {
      return {
        success: false,
        error: `Request not approved (current stage: ${request.currentStage})`,
      };
    }

    logger.info(`Deploying request ${requestId} to production`);

    // In a real system, this would deploy the code to the production environment
    // For now, we'll just mark it as deployed
    this.advanceToStage(requestId, PromotionStage.DEPLOYED, 'Deployed to production', 'system');

    return {
      success: true,
      code: request.code,
    };
  }

  /**
   * Get request by ID
   * @param requestId - Request ID
   * @returns Request or undefined
   */
  getRequest(requestId: string): PromotionRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Get all requests
   * @param agentId - Optional agent ID filter
   * @param stage - Optional stage filter
   * @returns Array of requests
   */
  getRequests(agentId?: string, stage?: PromotionStage): PromotionRequest[] {
    let requests = Array.from(this.requests.values());

    if (agentId) {
      requests = requests.filter(r => r.agentId === agentId);
    }

    if (stage) {
      requests = requests.filter(r => r.currentStage === stage);
    }

    return requests.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get pipeline statistics
   * @returns Statistics object
   */
  getStats(): {
    totalRequests: number;
    requestsByStage: Record<string, number>;
    autoApprovalRate: number;
    rejectionRate: number;
  } {
    const requests = Array.from(this.requests.values());
    const total = requests.length;

    const byStage: Record<string, number> = {};
    for (const stage of Object.values(PromotionStage)) {
      byStage[stage] = requests.filter(r => r.currentStage === stage).length;
    }

    const autoApproved = requests.filter(
      r => r.metadata.approvalDecision?.autoApproved === true
    ).length;
    const rejected = requests.filter(r => r.currentStage === PromotionStage.REJECTED).length;

    return {
      totalRequests: total,
      requestsByStage: byStage,
      autoApprovalRate: total > 0 ? (autoApproved / total) * 100 : 0,
      rejectionRate: total > 0 ? (rejected / total) * 100 : 0,
    };
  }

  /**
   * Update auto-approve threshold
   * @param threshold - New threshold (0-100)
   */
  updateAutoApproveThreshold(threshold: number): void {
    if (threshold < 0 || threshold > 100) {
      throw new Error('Threshold must be between 0 and 100');
    }

    this.autoApproveThreshold = threshold;
    logger.info(`Auto-approve threshold updated to: ${threshold}`);
  }

  /**
   * Validate stage transition
   * @param from - Current stage
   * @param to - Target stage
   * @returns Valid transition status
   */
  private isValidTransition(from: PromotionStage, to: PromotionStage): boolean {
    const validTransitions: Record<PromotionStage, PromotionStage[]> = {
      [PromotionStage.GENERATED]: [PromotionStage.VALIDATED, PromotionStage.REJECTED],
      [PromotionStage.VALIDATED]: [PromotionStage.SANDBOX_TESTED, PromotionStage.REJECTED],
      [PromotionStage.SANDBOX_TESTED]: [PromotionStage.PENDING_APPROVAL, PromotionStage.REJECTED],
      [PromotionStage.PENDING_APPROVAL]: [PromotionStage.APPROVED, PromotionStage.REJECTED],
      [PromotionStage.APPROVED]: [PromotionStage.DEPLOYED],
      [PromotionStage.DEPLOYED]: [],
      [PromotionStage.REJECTED]: [],
    };

    return validTransitions[from]?.includes(to) || false;
  }
}
