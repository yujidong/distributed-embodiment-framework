/**
 * Collaboration Coordinator
 *
 * Extracted from CognitiveAgent lines 551-786, 3915-4115, 5765-5979
 *
 * Responsibilities:
 * - Autonomous AC initiation
 * - AC proposal handling
 * - AC session execution
 * - AC withdrawal
 * - AC dissolution
 */

import type { CollaborationManager } from '../../management/CollaborationManager.js';
import type { DialogueManager } from '../../management/DialogueManager.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import { EventType } from '../../events/index.js';
import { CollaborationPriority } from '../../management/CollaborationManager.js';
import type { DualTriggerResult } from '../../decision/DualTriggerACManager.js';
import { ACExecutor } from '../../execution/ACExecutor.js';
import type { ACCollaborationConfig as ExecutorCollaborationConfig } from '../../execution/ACExecutor.js';
import { AgentStatus } from '../CognitiveAgent.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * AC Collaboration Configuration
 * Simplified interface for collaboration coordinator
 */
const logger = createLogger('CollaborationCoordinator');

export interface ACCollaborationConfig {
  id: string;
  name: string;
  description: string;
  priority: string;
  participantAgentIds: string[];
  requiredResources: any[];
  goals: any[];
  maxDuration?: number;
  timeout?: number;
}

/**
 * Collaboration Coordinator
 *
 * Coordinates collaboration session management for CognitiveAgent
 */
export class CollaborationCoordinator {
  constructor(
    private collaborationManager: CollaborationManager,
    private dialogueManager: DialogueManager,
    private eventEmitter: EventEmitter,
    private environment: EnvironmentCenter,
    private agentId: string,
    private agentName: string,
    private agentCapabilities: string[],
    private setStatus: (status: AgentStatus) => void
  ) {}

  /**
   * Handle autonomous AC initiation
   * Extracted from CognitiveAgent.handleAutonomousACInitiation() (lines 551-786)
   */
  async handleAutonomousACInitiation(
    acConfig: ACCollaborationConfig,
    result: DualTriggerResult
  ): Promise<void> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Autonomously initiating AC: ${acConfig.name}`);
    logger.info(`[CollaborationCoordinator:${this.agentId}] AC Reason: ${acConfig.description}`);
    logger.info(`[CollaborationCoordinator:${this.agentId}] Partners: ${acConfig.participantAgentIds.join(', ')}`);

    // Update agent status
    this.setStatus(AgentStatus.BUSY);

    // Create collaboration session FIRST so we have a session ID
    const session = this.collaborationManager.createSession(
      'service-composition',
      [this.agentId, ...acConfig.participantAgentIds],
      this.agentId,
      this.mapPriority(acConfig.priority),
      acConfig.description,
      this.extractResourceIds(acConfig.requiredResources)
    );

    logger.info(`[CollaborationCoordinator:${this.agentId}] AC ${acConfig.id} autonomously initiated - Session: ${session.id}`);

    // Emit AC initiation event with BOTH acConfig.id and session.id
    // Listeners can use sessionId to look up the session in CollaborationManager
    this.eventEmitter.emit(EventType.COLLABORATION_STARTED, {
      acId: acConfig.id,
      sessionId: session.id,
      acName: acConfig.name,
      initiatorId: this.agentId,
      participantIds: acConfig.participantAgentIds,
      priority: acConfig.priority,
      goals: acConfig.goals.map(g => g.name),
      triggerReason: acConfig.description,
      autonomous: true,
    });

    // Send collaboration proposals to selected partners (skip self)
    for (const partnerId of acConfig.participantAgentIds) {
      if (partnerId === this.agentId) {
        logger.info(`[CollaborationCoordinator:${this.agentId}] Skipping self-proposal`);
        continue;
      }
      logger.info(`[CollaborationCoordinator:${this.agentId}] Sending proposal to agent ${partnerId}`);

      // Extract resource IDs from AC config
      const resourceIds: string[] = [];
      for (const r of acConfig.requiredResources) {
        if (typeof r === 'string') {
          resourceIds.push(r);
        } else if (r && typeof r === 'object' && 'id' in r) {
          resourceIds.push((r as { id: string }).id);
        }
      }

      const proposal = this.dialogueManager.proposeCollaboration(
        this.agentId,
        partnerId,
        acConfig.name,
        acConfig.description,
        resourceIds,
        {
          priority: acConfig.priority,
          urgency: acConfig.priority,
          acConfig: acConfig, // Include full AC config
        }
      );

      logger.info(`[CollaborationCoordinator:${this.agentId}] Proposal created: ${proposal.id}`);

      // Also publish proposal via EventManager so partner agents'
      // CollaborationProposalHandler can receive and process it
      this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
        type: 'ac-proposal',
        collaborationId: acConfig.id,
        collaborationName: acConfig.name,
        initiatorId: this.agentId,
        targetAgentId: partnerId,
        description: acConfig.description,
        requiredCapabilities: acConfig.goals.flatMap((g: any) =>
          g.requiredCapabilities?.map((rc: any) => rc.capability) || []
        ).filter(Boolean),
        priority: acConfig.priority,
        task: {
          description: acConfig.description,
        },
        metadata: {
          proposalId: proposal.id,
          acConfigId: acConfig.id,
        },
      });
    }

    // Execute collaboration using ACExecutor
    logger.info(`[CollaborationCoordinator:${this.agentId}] Now executing AC goals using ACExecutor...`);
    try {
      const executor = new ACExecutor();

      // Convert GoalFormulationEngine.ACCollaborationConfig to ACExecutor.ACCollaborationConfig
      // Note: Using type assertion due to minor interface differences (underscore vs hyphen naming)
      const executorConfig = {
        id: acConfig.id,
        name: acConfig.name,
        description: acConfig.description,
        environment: this.environment,
        participantAgentIds: acConfig.participantAgentIds,
        collaborationManager: this.collaborationManager,
        goals: acConfig.goals,
        maxDuration: acConfig.maxDuration,
        timeout: acConfig.timeout,
      } as unknown as ExecutorCollaborationConfig;

      await executor.executeCollaboration(executorConfig);

      logger.info(`[CollaborationCoordinator:${this.agentId}] AC execution completed successfully`);

      // Update agent status back to IDLE
      this.setStatus(AgentStatus.IDLE);

    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] AC execution failed:`, error);

      // Update agent status to ERROR
      this.setStatus(AgentStatus.ERROR);

      throw error;
    }
  }

  /**
   * Withdraw from an active collaboration
   * Agent autonomously decides to leave an AC
   * Extracted from CognitiveAgent.withdrawFromCollaboration() (lines 5778-5839)
   */
  async withdrawFromCollaboration(
    collaborationId: string,
    reason: string,
    gracefulPeriod?: number
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Requesting withdrawal from AC ${collaborationId}`);
    logger.info(`  Reason: ${reason}`);

    try {
      // Create withdrawal request
      const request = this.collaborationManager.requestWithdrawal({
        collaborationId,
        agentId: this.agentId,
        agentName: this.agentName,
        reason,
        gracefulPeriod,
      });

      logger.info(`[CollaborationCoordinator:${this.agentId}] Withdrawal request created: ${request.id}`);
      logger.info(`  Graceful period: ${request.gracefulPeriod}ms`);

      // If graceful period is set, schedule the actual withdrawal
      if (request.gracefulPeriod > 0) {
        setTimeout(async () => {
          logger.info(`[CollaborationCoordinator:${this.agentId}] Graceful period ended, processing withdrawal...`);
          await this.collaborationManager.processWithdrawal(request.id);
        }, request.gracefulPeriod);
      } else {
        // Immediate withdrawal
        await this.collaborationManager.processWithdrawal(request.id);
      }

      return {
        success: true,
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Withdrawal failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Propose dissolution of a collaboration
   * Extracted from CognitiveAgent.proposeDissolution() (lines 5847-5917)
   */
  async proposeDissolution(
    collaborationId: string,
    reason: string,
    voteThreshold?: number
  ): Promise<{
    success: boolean;
    proposalId?: string;
    error?: string;
  }> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Proposing dissolution of ${collaborationId}`);
    logger.info(`  Reason: ${reason}`);

    // Check if agent is in this collaboration
    const sessions = this.collaborationManager.getActiveSessions(this.agentId);
    const session = sessions.find(s => s.id === collaborationId);

    if (!session) {
      return {
        success: false,
        error: `Agent ${this.agentId} is not in collaboration ${collaborationId}`,
      };
    }

    try {
      const proposal = this.collaborationManager.proposeDissolution({
        collaborationId,
        proposerId: this.agentId,
        proposerName: this.agentName,
        reason,
        voteThreshold,
      });

      if (!proposal) {
        return {
          success: false,
          error: 'Failed to create dissolution proposal',
        };
      }

      logger.info(`[CollaborationCoordinator:${this.agentId}] Dissolution proposal created: ${proposal.id}`);

      return {
        success: true,
        proposalId: proposal.id,
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Dissolution proposal failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Vote on dissolution proposal
   * Extracted from CognitiveAgent.voteOnDissolution() (lines 5921-5978)
   */
  async voteOnDissolution(
    proposalId: string,
    vote: boolean
  ): Promise<{
    success: boolean;
    result?: 'approved' | 'rejected' | 'pending';
    error?: string;
  }> {
    logger.info(`[CollaborationCoordinator:${this.agentId}] Voting on dissolution ${proposalId}: ${vote ? 'YES' : 'NO'}`);

    try {
      const result = this.collaborationManager.voteOnDissolution({
        proposalId,
        agentId: this.agentId,
        vote,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      logger.info(`[CollaborationCoordinator:${this.agentId}] Vote recorded. Current result: ${result.result}`);

      return {
        success: true,
        result: result.result,
      };
    } catch (error) {
      logger.error(`[CollaborationCoordinator:${this.agentId}] Vote failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get active collaborations
   * Extracted from CognitiveAgent.getActiveCollaborations() (lines 5963-5978)
   */
  getActiveCollaborations(): any[] {
    const sessions = this.collaborationManager.getActiveSessions(this.agentId);
    logger.info(`[CollaborationCoordinator:${this.agentId}] Active collaborations: ${sessions.length}`);
    return sessions;
  }

  /**
   * Extract resource IDs from AC config
   */
  private extractResourceIds(resources: any[]): string[] {
    const resourceIds: string[] = [];

    for (const r of resources) {
      if (typeof r === 'string') {
        resourceIds.push(r);
      } else if (r && typeof r === 'object' && 'id' in r) {
        resourceIds.push((r as { id: string }).id);
      }
    }

    return resourceIds;
  }

  /**
   * Map AC priority to CollaborationManager priority
   */
  private mapPriority(priority: string): CollaborationPriority {
    if (priority === 'urgent') return CollaborationPriority.CRITICAL;
    if (priority === 'high') return CollaborationPriority.HIGH;
    return CollaborationPriority.NORMAL;
  }
}
