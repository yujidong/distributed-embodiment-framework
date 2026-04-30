/**
 * Role Context Manager
 *
 * Manages the agent's understanding of its role and current situation.
 * Provides situation assessment and context updates.
 */

import {
  AgentProfile,
  AgentRoleType,
  RoleContext,
  SituationAssessment,
  ResourceInfo,
  Experience,
  GoalPriority,
} from './types';
import { GoalManager } from './GoalManager';

import { createLogger } from '@active-collaboration/shared';
/**
 * Situation assessment parameters
 */
const logger = createLogger('RoleContextManager');

export interface SituationInput {
  /** Event or change that triggered assessment */
  trigger?: string;

  /** Current device states */
  deviceStates?: Map<string, any>;

  /** Environment parameters */
  environmentParams?: Record<string, any>;

  /** Known issues or alerts */
  alerts?: Array<{ source: string; severity: string; message: string }>;

  /** Available other agents */
  nearbyAgents?: string[];
}

/**
 * Role Context Manager
 *
 * Tracks and updates agent's context for decision-making.
 */
export class RoleContextManager {
  private context: RoleContext;
  private agentId: string;
  private experimentLogger: (event: string, data: any) => void;

  constructor(
    profile: AgentProfile,
    private goalManager: GoalManager,
    experimentLogger?: (event: string, data: any) => void
  ) {
    this.agentId = profile.id;
    this.experimentLogger = experimentLogger || this.defaultLogger;

    this.context = {
      role: profile.role,
      profile,
      situationAssessment: undefined,
      availableResources: [],
      knownCapabilities: [],
      activeGoals: [],
      pastExperiences: [],
      lastUpdated: new Date(),
    };

    this.log('context_created', {
      role: profile.role,
      primaryGoalCount: profile.primaryGoals.length,
    });
  }

  /**
   * Default logger
   */
  private defaultLogger = (event: string, data: any): void => {
    const timestamp = new Date().toISOString();
    logger.info(`[RoleContext:${this.agentId}] [${timestamp}] ${event}:`, JSON.stringify(data, null, 2));
  };

  /**
   * Log event
   */
  private log(event: string, data: any): void {
    this.experimentLogger('role_context', { event, agentId: this.agentId, ...data });
  }

  // --------------------------------------------
  // CONTEXT MANAGEMENT
  // --------------------------------------------

  /**
   * Get current context
   */
  getContext(): RoleContext {
    return { ...this.context };
  }

  /**
   * Update context with new information
   */
  updateContext(input: SituationInput): void {
    // Update active goals from goal manager
    this.context.activeGoals = this.goalManager.getActiveGoals();

    // Perform situation assessment
    this.context.situationAssessment = this.assessSituation(input);

    // Update timestamp
    this.context.lastUpdated = new Date();

    this.log('context_updated', {
      activeGoalCount: this.context.activeGoals.length,
      urgency: this.context.situationAssessment?.urgency,
      complexity: this.context.situationAssessment?.complexity,
    });
  }

  /**
   * Assess current situation
   */
  assessSituation(input: SituationInput): SituationAssessment {
    let urgency: SituationAssessment['urgency'] = 'low';
    let complexity: SituationAssessment['complexity'] = 'simple';
    let riskLevel: SituationAssessment['riskLevel'] = 'low';
    let collaborationOpportunity: SituationAssessment['collaborationOpportunity'] = 'none';
    const keyFactors: string[] = [];
    const recommendedActions: string[] = [];

    // Check alerts
    if (input.alerts && input.alerts.length > 0) {
      const criticalAlerts = input.alerts.filter(a => a.severity === 'critical');
      const highAlerts = input.alerts.filter(a => a.severity === 'high');

      if (criticalAlerts.length > 0) {
        urgency = 'critical';
        riskLevel = 'high';
        keyFactors.push(`${criticalAlerts.length} critical alert(s)`);
      } else if (highAlerts.length > 0) {
        urgency = 'high';
        riskLevel = 'medium';
        keyFactors.push(`${highAlerts.length} high priority alert(s)`);
      }
    }

    // Check goal status
    const goalsNeedingAttention = this.goalManager.getGoalsNeedingAttention();
    if (goalsNeedingAttention.length > 0) {
      keyFactors.push(`${goalsNeedingAttention.length} goal(s) need attention`);

      const criticalGoals = goalsNeedingAttention.filter(g => g.priority === GoalPriority.CRITICAL);
      if (criticalGoals.length > 0) {
        urgency = 'critical';
      }
    }

    // Check device states
    if (input.deviceStates) {
      const anomalousDevices = this.findAnomalousDevices(input.deviceStates);
      if (anomalousDevices.length > 0) {
        keyFactors.push(`${anomalousDevices.length} anomalous device(s)`);
        complexity = anomalousDevices.length > 2 ? 'complex' : 'moderate';
      }
    }

    // Check environment parameters
    if (input.environmentParams) {
      const outOfRange = this.findOutOfRangeParams(input.environmentParams);
      if (outOfRange.length > 0) {
        keyFactors.push(`${outOfRange.length} parameter(s) out of range`);
        recommendedActions.push('Adjust environment parameters');
      }
    }

    // Check collaboration opportunities
    if (input.nearbyAgents && input.nearbyAgents.length > 0) {
      const collabGoals = this.context.activeGoals.filter(g => g.type === 'collaboration');
      if (collabGoals.length > 0) {
        collaborationOpportunity = 'high';
        recommendedActions.push('Consider collaboration with nearby agents');
      } else if (complexity === 'complex') {
        collaborationOpportunity = 'medium';
        recommendedActions.push('Complex situation - collaboration may help');
      }
    }

    // Determine recommended actions based on assessment
    if (urgency === 'critical') {
      recommendedActions.unshift('Take immediate action');
    } else if (urgency === 'high') {
      recommendedActions.unshift('Prioritize action');
    }

    const assessment: SituationAssessment = {
      urgency,
      complexity,
      riskLevel,
      collaborationOpportunity,
      keyFactors,
      recommendedActions: recommendedActions.slice(0, 3),
    };

    this.log('situation_assessed', {
      urgency,
      complexity,
      riskLevel,
      collaborationOpportunity,
      keyFactorCount: keyFactors.length,
    });

    return assessment;
  }

  /**
   * Find devices with anomalous states
   */
  private findAnomalousDevices(deviceStates: Map<string, any>): string[] {
    const anomalous: string[] = [];

    deviceStates.forEach((state, deviceId) => {
      if (state.anomaly === true || state.status === 'error' || state.status === 'warning') {
        anomalous.push(deviceId);
      }
    });

    return anomalous;
  }

  /**
   * Find parameters outside expected ranges
   */
  private findOutOfRangeParams(params: Record<string, any>): string[] {
    const outOfRange: string[] = [];

    // Define expected ranges for common parameters
    const expectedRanges: Record<string, { min: number; max: number }> = {
      temperature: { min: 15, max: 30 },
      humidity: { min: 20, max: 80 },
      airQuality: { min: 0, max: 100 },
      pressure: { min: 900, max: 1100 },
    };

    Object.entries(params).forEach(([key, value]) => {
      if (typeof value === 'number' && expectedRanges[key]) {
        const range = expectedRanges[key];
        if (value < range.min || value > range.max) {
          outOfRange.push(key);
        }
      }
    });

    return outOfRange;
  }

  // --------------------------------------------
  // RESOURCE MANAGEMENT
  // --------------------------------------------

  /**
   * Update available resources
   */
  updateResources(resources: ResourceInfo[]): void {
    this.context.availableResources = resources;
    this.context.lastUpdated = new Date();

    this.log('resources_updated', {
      resourceCount: resources.length,
      availableCount: resources.filter(r => r.available).length,
    });
  }

  /**
   * Add a resource
   */
  addResource(resource: ResourceInfo): void {
    const existing = this.context.availableResources.findIndex(r => r.id === resource.id);
    if (existing >= 0) {
      this.context.availableResources[existing] = resource;
    } else {
      this.context.availableResources.push(resource);
    }
    this.context.lastUpdated = new Date();
  }

  /**
   * Remove a resource
   */
  removeResource(resourceId: string): void {
    this.context.availableResources = this.context.availableResources.filter(r => r.id !== resourceId);
    this.context.lastUpdated = new Date();
  }

  /**
   * Get available resources
   */
  getAvailableResources(): ResourceInfo[] {
    return this.context.availableResources.filter(r => r.available);
  }

  // --------------------------------------------
  // CAPABILITY TRACKING
  // --------------------------------------------

  /**
   * Update known capabilities
   */
  updateKnownCapabilities(capabilities: string[]): void {
    this.context.knownCapabilities = [...new Set([...this.context.knownCapabilities, ...capabilities])];
    this.context.lastUpdated = new Date();
  }

  /**
   * Get known capabilities
   */
  getKnownCapabilities(): string[] {
    return [...this.context.knownCapabilities];
  }

  // --------------------------------------------
  // EXPERIENCE TRACKING
  // --------------------------------------------

  /**
   * Add an experience
   */
  addExperience(experience: Experience): void {
    this.context.pastExperiences.push(experience);

    // Keep only last 100 experiences
    if (this.context.pastExperiences.length > 100) {
      this.context.pastExperiences = this.context.pastExperiences.slice(-100);
    }

    this.context.lastUpdated = new Date();

    this.log('experience_added', {
      type: experience.type,
      outcome: experience.outcome,
      lesson: experience.lesson,
    });
  }

  /**
   * Get recent experiences
   */
  getRecentExperiences(count: number = 10): Experience[] {
    return this.context.pastExperiences.slice(-count);
  }

  /**
   * Get experiences by outcome
   */
  getExperiencesByOutcome(outcome: Experience['outcome']): Experience[] {
    return this.context.pastExperiences.filter(e => e.outcome === outcome);
  }

  // --------------------------------------------
  // EXPERIMENT DATA EXPORT
  // --------------------------------------------

  /**
   * Export context data for experiments
   */
  exportContextData(): {
    agentId: string;
    role: AgentRoleType;
    activeGoalCount: number;
    resourceCount: number;
    experienceCount: number;
    currentAssessment: SituationAssessment | undefined;
  } {
    return {
      agentId: this.agentId,
      role: this.context.role,
      activeGoalCount: this.context.activeGoals.length,
      resourceCount: this.context.availableResources.length,
      experienceCount: this.context.pastExperiences.length,
      currentAssessment: this.context.situationAssessment,
    };
  }
}
