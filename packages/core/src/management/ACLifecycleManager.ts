/**
 * AC Lifecycle Manager
 *
 * Manages the complete lifecycle of Active Collaboration (AC):
 * 1. Trigger Phase - AC initiated, * 2. Formation Phase - Partners respond and agree
 * 3. Execution Phase - Coordinated action execution
 * 4. Monitoring Phase - Progress tracking and adaptation
 * 5. Termination Phase - Cleanup and reporting
 *
 * Integrates with CollaborationManager for state tracking
 * and provides comprehensive lifecycle management.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ACCollaborationConfig, ACCollaborationGoal } from '../decision/GoalFormulationEngine.js';
import type { CollaborationManager } from './CollaborationManager.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * AC Lifecycle phases
 */
const logger = createLogger('ACLifecycleManager');

export enum ACLifecyclePhase {
  TRIGGER = 'trigger',
  FORMATION = 'formation',
  EXECUTION = 'execution',
  MONITORING = 'monitoring',
  TERMINATION = 'termination',
}

/**
 * State for each lifecycle phase
 */
export interface PhaseState {
  trigger?: {
    proposalId: string;
    broadcastAt: Date;
    recipientCount: number;
  };
  formation?: {
    responses: CollaborationResponse[];
    acceptedPartners: string[];
    rejectedPartners: string[];
    finalConfig?: ACCollaborationConfig;
    formationComplete: boolean;
  };
  execution?: {
    currentGoalId: string;
    completedGoals: string[];
    failedGoals: string[];
    deviceOperations: ACDeviceOperation[];
    agentCommunications: ACAgentCommunication[];
  };
  monitoring?: {
    anomalies: AnomalyDetection[];
    adaptations: AdaptationAction[];
    healthChecks: HealthCheckResult[];
  };
  termination?: {
    reason: string;
    finalState: 'success' | 'partial' | 'failure' | 'cancelled';
    report: ACTerminationReport;
    cleanupComplete: boolean;
  };
}

/**
 * Collaboration response from partner
 */
export interface CollaborationResponse {
  agentId: string;
  agentName: string;
  response: 'accept' | 'reject' | 'negotiate' | 'timeout';
  timestamp: Date;
  reasoning?: string;
  proposedCapabilities?: string[];
}

/**
 * Device operation during AC
 */
export interface ACDeviceOperation {
  id: string;
  deviceId: string;
  operation: string;
  parameters: Record<string, any>;
  result: 'success' | 'failure' | 'pending';
  timestamp: Date;
  executedBy: string; // Agent ID
}

/**
 * Agent communication during AC
 */
export interface ACAgentCommunication {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  messageType: string;
  content: string;
  timestamp: Date;
}

/**
 * Anomaly detection during execution
 */
export interface AnomalyDetection {
  id: string;
  timestamp: Date;
  type: 'device_failure' | 'partner_unresponsive' | 'goal_blocked' | 'resource_conflict' | 'timeout' | 'external_interference';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affectedComponents: string[];
  suggestedActions: string[];
  resolved: boolean;
}

/**
 * Adaptation action taken during monitoring
 */
export interface AdaptationAction {
  id: string;
  anomalyId: string;
  action: 'request_additional_partners' | 'modify_goals' | 'rollback_operations' | 'emergency_termination' | 'escalate';
  reasoning: string;
  executedAt: Date;
  result: 'success' | 'failure' | 'pending';
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  timestamp: Date;
  participantHealth: {
    agentId: string;
    status: 'healthy' | 'degraded' | 'unresponsive';
    lastHeartbeat: Date;
  }[];
  resourceHealth: {
    resourceId: string;
    status: 'available' | 'busy' | 'offline';
  }[];
}

/**
 * Termination report
 */
export interface ACTerminationReport {
  collaborationId: string;
  terminationType: 'success' | 'partial' | 'failure' | 'cancelled';

  // Summary
  summary: {
    duration: number;
    goalsAchieved: number;
    goalsTotal: number;
    participants: number;
    deviceOperations: number;
    environmentEffects: number;
  };

  // Detailed results
  goalResults: {
    goalId: string;
    description: string;
    achieved: boolean;
    reason?: string;
  }[];

  // Lessons learned
  lessonsLearned: string[];

  // Recommendations for future
  recommendations: string[];

  // Participant performance
  participantPerformance: {
    agentId: string;
    agentName: string;
    contribution: 'excellent' | 'good' | 'adequate' | 'poor';
    reliability: number;
    responsiveness: number;
  }[];

  // Metrics
  metrics: {
    totalMessages: number;
    totalOperations: number;
    averageResponseTime: number;
    successRate: number;
  };
}

/**
 * Complete AC lifecycle state
 */
export interface ACLifecycleState {
  collaborationId: string;
  config: ACCollaborationConfig;

  currentPhase: ACLifecyclePhase;
  phaseState: PhaseState;

  phaseTimestamps: Map<ACLifecyclePhase, Date>;
  createdAt: Date;
  updatedAt: Date;

  overallStatus: 'created' | 'forming' | 'running' | 'completing' | 'completed' | 'failed' | 'cancelled';
}

/**
 * Configuration for ACLifecycleManager
 */
export interface LifecycleManagerConfig {
  // Phase timeouts
  triggerTimeout: number; // Max time to get responses
  executionTimeout: number; // Max time for execution
  monitoringInterval: number; // Health check frequency

  // Thresholds
  minPartnersRequired: number;
  maxRetries: number;

  // Health check settings
  healthCheckEnabled: boolean;
  heartbeatTimeout: number;

  // Adaptation settings
  autoAdaptEnabled: boolean;
  adaptationThreshold: number; // Anomaly severity to trigger adaptation
}

const DEFAULT_CONFIG: LifecycleManagerConfig = {
  triggerTimeout: 30000, // 30 seconds
  executionTimeout: 300000, // 5 minutes
  monitoringInterval: 5000, // 5 seconds

  minPartnersRequired: 1,
  maxRetries: 3,

  healthCheckEnabled: true,
  heartbeatTimeout: 10000, // 10 seconds

  autoAdaptEnabled: true,
  adaptationThreshold: 3, // Severity score threshold
};

// ============================================================================
// ACLifecycleManager
// ============================================================================

export class ACLifecycleManager {
  private config: LifecycleManagerConfig;
  private collaborationManager: CollaborationManager;
  private environmentCenter?: EnvironmentCenter;

  // Active AC sessions
  private activeSessions: Map<string, ACLifecycleState> = new Map();

  // Monitoring intervals
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();

  // Statistics
  private stats = {
    totalACs: 0,
    successfulACs: 0,
    failedACs: 0,
    cancelledACs: 0,
    totalDuration: 0,
    averagePartners: 0,
  };

  constructor(
    collaborationManager: CollaborationManager,
    config: Partial<LifecycleManagerConfig> = {},
    environmentCenter?: EnvironmentCenter
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.collaborationManager = collaborationManager;
    this.environmentCenter = environmentCenter;

    logger.info('Initialized');
  }

  /**
   * Start new AC lifecycle
   */
  async startAC(config: ACCollaborationConfig): Promise<string> {
    const collaborationId = config.id;
    this.stats.totalACs++;

    // Create initial state
    const state: ACLifecycleState = {
      collaborationId,
      config,
      currentPhase: ACLifecyclePhase.TRIGGER,
      phaseState: {
        trigger: {
          proposalId: uuidv4(),
          broadcastAt: new Date(),
          recipientCount: config.participantAgentIds.length,
        },
      },
      phaseTimestamps: new Map([[ACLifecyclePhase.TRIGGER, new Date()]]),
      createdAt: new Date(),
      updatedAt: new Date(),
      overallStatus: 'created',
    };

    this.activeSessions.set(collaborationId, state);

    logger.info(`Started AC ${collaborationId} with ${config.participantAgentIds.length} participants`);

    // Transition to formation phase
    await this.transitionToPhase(collaborationId, ACLifecyclePhase.FORMATION);

    return collaborationId;
  }

  /**
   * Transition to next phase
   */
  private async transitionToPhase(
    collaborationId: string,
    newPhase: ACLifecyclePhase
  ): Promise<void> {
    const state = this.activeSessions.get(collaborationId);
    if (!state) {
      throw new Error(`AC ${collaborationId} not found`);
    }

    const oldPhase = state.currentPhase;
    logger.info(`AC ${collaborationId} transitioning from ${oldPhase} to ${newPhase}`);

    // Record timestamp
    state.phaseTimestamps.set(newPhase, new Date());
    state.currentPhase = newPhase;
    state.updatedAt = new Date();

    // Initialize phase state if needed
    if (!state.phaseState[newPhase]) {
      // Initialize with appropriate empty state for the phase
      switch (newPhase) {
        case ACLifecyclePhase.TRIGGER:
          state.phaseState[newPhase] = {
            proposalId: '',
            broadcastAt: new Date(),
            recipientCount: 0,
          };
          break;
        case ACLifecyclePhase.FORMATION:
          state.phaseState[newPhase] = {
            responses: [],
            acceptedPartners: [],
            rejectedPartners: [],
            formationComplete: false,
          };
          break;
        case ACLifecyclePhase.EXECUTION:
          state.phaseState[newPhase] = {
            currentGoalId: '',
            completedGoals: [],
            failedGoals: [],
            deviceOperations: [],
            agentCommunications: [],
          };
          break;
        case ACLifecyclePhase.MONITORING:
          state.phaseState[newPhase] = {
            anomalies: [],
            adaptations: [],
            healthChecks: [],
          };
          break;
        case ACLifecyclePhase.TERMINATION:
          state.phaseState[newPhase] = {
            reason: '',
            finalState: 'success',
            report: {} as unknown as ACTerminationReport,
            cleanupComplete: false,
          };
          break;
      }
    }

    // Execute phase-specific logic
    switch (newPhase) {
      case ACLifecyclePhase.FORMATION:
        await this.executeFormationPhase(state);
        break;
      case ACLifecyclePhase.EXECUTION:
        await this.executeExecutionPhase(state);
        break;
      case ACLifecyclePhase.MONITORING:
        await this.startMonitoring(state);
        break;
      case ACLifecyclePhase.TERMINATION:
        await this.executeTerminationPhase(state);
        break;
    }

    // Update CollaborationManager state
    await this.collaborationManager.trackACState(collaborationId, newPhase as unknown as import('./CollaborationManager.js').ACState, `Transitioned from ${oldPhase} to ${newPhase}`);
  }

  /**
   * Execute formation phase
   */
  private async executeFormationPhase(state: ACLifecycleState): Promise<void> {
    const config = state.config;
    state.overallStatus = 'forming';

    // Initialize formation state
    state.phaseState.formation = {
      responses: [],
      acceptedPartners: [],
      rejectedPartners: [],
      formationComplete: false,
    };

    // Set timeout for formation
    setTimeout(async () => {
      const currentState = this.activeSessions.get(state.collaborationId);
      if (currentState && currentState.currentPhase === ACLifecyclePhase.FORMATION) {
        // Check if we have enough partners
        const accepted = currentState.phaseState.formation?.acceptedPartners || [];
        if (accepted.length >= this.config.minPartnersRequired) {
          await this.completeFormation(state.collaborationId);
        } else {
          await this.terminateAC(state.collaborationId, 'Insufficient partners', 'cancelled');
        }
      }
    }, this.config.triggerTimeout);
  }

  /**
   * Record partner response
   */
  async recordPartnerResponse(
    collaborationId: string,
    response: CollaborationResponse
  ): Promise<void> {
    const state = this.activeSessions.get(collaborationId);
    if (!state || state.currentPhase !== ACLifecyclePhase.FORMATION) {
      throw new Error('Invalid collaboration or phase');
    }

    const formation = state.phaseState.formation!;
    formation.responses.push(response);

    if (response.response === 'accept') {
      formation.acceptedPartners.push(response.agentId);
      logger.info(`Partner ${response.agentName} accepted AC ${collaborationId}`);
    } else if (response.response === 'reject') {
      formation.rejectedPartners.push(response.agentId);
      logger.info(`Partner ${response.agentName} rejected AC ${collaborationId}`);
    }

    state.updatedAt = new Date();

    // Check if all responses received
    const totalResponses = formation.responses.length;
    const expectedResponses = state.config.participantAgentIds.length - 1; // Exclude initiator

    if (totalResponses >= expectedResponses) {
      await this.completeFormation(collaborationId);
    }
  }

  /**
   * Complete formation phase
   */
  private async completeFormation(collaborationId: string): Promise<void> {
    const state = this.activeSessions.get(collaborationId);
    if (!state) return;

    const formation = state.phaseState.formation!;
    formation.formationComplete = true;

    if (formation.acceptedPartners.length >= this.config.minPartnersRequired) {
      // Transition to execution
      await this.transitionToPhase(collaborationId, ACLifecyclePhase.EXECUTION);
    } else {
      // Not enough partners, cancel
      await this.terminateAC(
        collaborationId,
        `Only ${formation.acceptedPartners.length} partners accepted, need ${this.config.minPartnersRequired}`,
        'cancelled'
      );
    }
  }

  /**
   * Execute execution phase
   */
  private async executeExecutionPhase(state: ACLifecycleState): Promise<void> {
    state.overallStatus = 'running';

    // Initialize execution state
    state.phaseState.execution = {
      currentGoalId: state.config.goals[0]?.id || '',
      completedGoals: [],
      failedGoals: [],
      deviceOperations: [],
      agentCommunications: [],
    };

    logger.info(`AC ${state.collaborationId} entering execution phase`);

    // Start monitoring
    await this.transitionToPhase(state.collaborationId, ACLifecyclePhase.MONITORING);

    // Execute goals
    await this.executeGoals(state);
  }

  /**
   * Execute goals sequentially
   */
  private async executeGoals(state: ACLifecycleState): Promise<void> {
    const goals = state.config.goals;
    const execution = state.phaseState.execution!;

    for (const goal of goals) {
      execution.currentGoalId = goal.id;

      logger.info(`Executing goal: ${goal.name}`);

      try {
        // Execute goal (would call ACExecutor in production)
        const success = await this.executeGoal(state, goal);

        if (success) {
          execution.completedGoals.push(goal.id);
          goal.status = 'completed';
          goal.progress = 100;
        } else {
          execution.failedGoals.push(goal.id);
          goal.status = 'failed';
        }
      } catch (error) {
        logger.error(`Goal ${goal.name} failed:`, error);
        execution.failedGoals.push(goal.id);
        goal.status = 'failed';
      }

      state.updatedAt = new Date();
    }

    // Check if all goals completed
    const allCompleted = execution.completedGoals.length === goals.length;
    const someCompleted = execution.completedGoals.length > 0;

    if (allCompleted) {
      await this.terminateAC(state.collaborationId, 'All goals achieved', 'success');
    } else if (someCompleted) {
      await this.terminateAC(state.collaborationId, 'Some goals achieved', 'partial');
    } else {
      await this.terminateAC(state.collaborationId, 'All goals failed', 'failure');
    }
  }

  /**
   * Execute single goal
   */
  private async executeGoal(state: ACLifecycleState, goal: ACCollaborationGoal): Promise<boolean> {
    // This would integrate with ACExecutor for actual execution
    // For now, simulate success
    goal.status = 'in_progress';
    goal.progress = 50;

    // Simulate execution time
    await new Promise(resolve => setTimeout(resolve, 1000));

    return true;
  }

  /**
   * Start monitoring phase
   */
  private async startMonitoring(state: ACLifecycleState): Promise<void> {
    if (!this.config.healthCheckEnabled) return;

    state.phaseState.monitoring = {
      anomalies: [],
      adaptations: [],
      healthChecks: [],
    };

    // Start periodic health checks
    const intervalId = setInterval(
      () => this.performHealthCheck(state.collaborationId),
      this.config.monitoringInterval
    );

    this.monitoringIntervals.set(state.collaborationId, intervalId);
  }

  /**
   * Perform health check
   */
  private async performHealthCheck(collaborationId: string): Promise<void> {
    const state = this.activeSessions.get(collaborationId);
    if (!state || state.currentPhase !== ACLifecyclePhase.MONITORING) {
      const interval = this.monitoringIntervals.get(collaborationId);
      if (interval) {
        clearInterval(interval);
        this.monitoringIntervals.delete(collaborationId);
      }
      return;
    }

    const monitoring = state.phaseState.monitoring!;
    const healthCheck: HealthCheckResult = {
      timestamp: new Date(),
      participantHealth: [],
      resourceHealth: [],
    };

    // Check participant health
    for (const agentId of state.config.participantAgentIds) {
      // Would check actual agent status in production
      healthCheck.participantHealth.push({
        agentId,
        status: 'healthy',
        lastHeartbeat: new Date(),
      });
    }

    monitoring.healthChecks.push(healthCheck);

    // Detect anomalies
    await this.detectAnomalies(state);
  }

  /**
   * Detect anomalies during execution
   */
  private async detectAnomalies(state: ACLifecycleState): Promise<void> {
    const monitoring = state.phaseState.monitoring!;

    // Check for unresponsive participants
    const lastHealthCheck = monitoring.healthChecks[monitoring.healthChecks.length - 1];
    if (lastHealthCheck) {
      for (const health of lastHealthCheck.participantHealth) {
        if (health.status === 'unresponsive') {
          const anomaly: AnomalyDetection = {
            id: uuidv4(),
            timestamp: new Date(),
            type: 'partner_unresponsive',
            severity: 'high',
            description: `Partner ${health.agentId} is unresponsive`,
            affectedComponents: [health.agentId],
            suggestedActions: ['Request replacement partner', 'Redistribute tasks'],
            resolved: false,
          };

          monitoring.anomalies.push(anomaly);

          if (this.config.autoAdaptEnabled) {
            await this.handleAnomaly(state, anomaly);
          }
        }
      }
    }
  }

  /**
   * Handle detected anomaly
   */
  private async handleAnomaly(state: ACLifecycleState, anomaly: AnomalyDetection): Promise<void> {
    const monitoring = state.phaseState.monitoring!;

    const adaptation: AdaptationAction = {
      id: uuidv4(),
      anomalyId: anomaly.id,
      action: anomaly.severity === 'critical' ? 'emergency_termination' : 'escalate',
      reasoning: `Handling ${anomaly.type} with severity ${anomaly.severity}`,
      executedAt: new Date(),
      result: 'success',
    };

    monitoring.adaptations.push(adaptation);
    anomaly.resolved = true;

    logger.info(`Adaptation action taken: ${adaptation.action}`);

    if (adaptation.action === 'emergency_termination') {
      await this.terminateAC(state.collaborationId, 'Emergency termination due to critical anomaly', 'failure');
    }
  }

  /**
   * Execute termination phase
   */
  private async executeTerminationPhase(state: ACLifecycleState): Promise<void> {
    // Stop monitoring
    const interval = this.monitoringIntervals.get(state.collaborationId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(state.collaborationId);
    }

    // Generate report
    const report = this.generateTerminationReport(state);

    state.phaseState.termination = {
      reason: report.summary.goalsAchieved === report.summary.goalsTotal ? 'All goals achieved' : 'Terminated',
      finalState: report.terminationType,
      report,
      cleanupComplete: true,
    };

    // Update statistics
    const duration = Date.now() - state.createdAt.getTime();
    this.stats.totalDuration += duration;

    switch (report.terminationType) {
      case 'success':
        this.stats.successfulACs++;
        break;
      case 'failure':
        this.stats.failedACs++;
        break;
      case 'cancelled':
        this.stats.cancelledACs++;
        break;
    }

    logger.info(`AC ${state.collaborationId} terminated: ${report.terminationType}`);
  }

  /**
   * Terminate AC
   */
  async terminateAC(
    collaborationId: string,
    reason: string,
    finalState: 'success' | 'partial' | 'failure' | 'cancelled'
  ): Promise<ACTerminationReport> {
    const state = this.activeSessions.get(collaborationId);
    if (!state) {
      throw new Error(`AC ${collaborationId} not found`);
    }

    state.overallStatus = finalState === 'success' ? 'completed' :
                        finalState === 'partial' ? 'completed' :
                        finalState === 'failure' ? 'failed' : 'cancelled';

    await this.transitionToPhase(collaborationId, ACLifecyclePhase.TERMINATION);

    return state.phaseState.termination?.report!;
  }

  /**
   * Generate termination report
   */
  private generateTerminationReport(state: ACLifecycleState): ACTerminationReport {
    const execution = state.phaseState.execution;
    const goals = state.config.goals;

    const goalsAchieved = execution?.completedGoals.length || 0;
    const goalsTotal = goals.length;

    const terminationType: 'success' | 'partial' | 'failure' | 'cancelled' =
      goalsAchieved === goalsTotal ? 'success' :
      goalsAchieved > 0 ? 'partial' :
      'failure';

    const duration = Date.now() - state.createdAt.getTime();

    return {
      collaborationId: state.collaborationId,
      terminationType,

      summary: {
        duration,
        goalsAchieved,
        goalsTotal,
        participants: state.config.participantAgentIds.length,
        deviceOperations: execution?.deviceOperations.length || 0,
        environmentEffects: 0, // Would be tracked in production
      },

      goalResults: goals.map(goal => ({
        goalId: goal.id,
        description: goal.description,
        achieved: goal.status === 'completed',
        reason: goal.status === 'failed' ? 'Execution failed' : undefined,
      })),

      lessonsLearned: [
        'Monitor partner responsiveness closely',
        'Have fallback partners available',
      ],

      recommendations: [
        'Improve partner selection algorithm',
        'Add more robust error handling',
      ],

      participantPerformance: state.config.participantAgentIds.map(agentId => ({
        agentId,
        agentName: `Agent-${agentId.slice(0, 8)}`,
        contribution: 'good',
        reliability: 0.8,
        responsiveness: 0.9,
      })),

      metrics: {
        totalMessages: execution?.agentCommunications.length || 0,
        totalOperations: execution?.deviceOperations.length || 0,
        averageResponseTime: 1000,
        successRate: goalsTotal > 0 ? goalsAchieved / goalsTotal : 0,
      },
    };
  }

  /**
   * Get AC state
   */
  getACState(collaborationId: string): ACLifecycleState | undefined {
    return this.activeSessions.get(collaborationId);
  }

  /**
   * Get all active ACs
   */
  getActiveACs(): ACLifecycleState[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }
}

export default ACLifecycleManager;
