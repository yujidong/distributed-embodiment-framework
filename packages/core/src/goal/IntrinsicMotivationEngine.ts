/**
 * Intrinsic Motivation Engine
 *
 * Generates motivation based on goals and context.
 * Tracks correlation between agent design decisions and AC triggering.
 */

import {
  AgentProfile,
  AgentGoal,
  RoleContext,
  MotivationLevel,
  ActionSuggestion,
  GoalType,
  GoalPriority,
  GoalStatus,
  SituationAssessment,
} from './types';
import { GoalManager } from './GoalManager';

import { createLogger } from '@active-collaboration/shared';
/**
 * AC trigger correlation data
 */
const logger = createLogger('IntrinsicMotivationEngine');

export interface ACTriggerCorrelation {
  timestamp: Date;
  agentId: string;
  motivationLevel: number;
  activeGoalCount: number;
  highestGoalPriority: GoalPriority | null;
  situationUrgency: string;
  suggestedAction: string;
  acTriggered: boolean;
  acType?: string;
  acParticipants?: string[];
  triggerReason?: string;
}

/**
 * Experiment log entry
 */
export interface ExperimentLogEntry {
  timestamp: Date;
  agentId: string;
  category: 'motivation' | 'decision' | 'ac_trigger' | 'goal_update' | 'situation';
  event: string;
  data: Record<string, any>;
}

/**
 * Intrinsic Motivation Engine
 *
 * Calculates when an agent should act based on goals and context.
 */
export class IntrinsicMotivationEngine {
  private profile: AgentProfile;
  private goalManager: GoalManager;
  private agentId: string;
  private experimentLog: ExperimentLogEntry[] = [];
  private acTriggerCorrelations: ACTriggerCorrelation[] = [];

  // Cache for motivation calculations to prevent redundant calls
  private motivationCache: {
    result: MotivationLevel;
    contextHash: string;
    timestamp: number;
  } | null = null;

  // Cache for action suggestions
  private suggestionCache: {
    result: ActionSuggestion | null;
    contextHash: string;
    timestamp: number;
  } | null = null;

  // Cache TTL in milliseconds (default: 200ms - covers typical event burst)
  private cacheTTL: number = 200;

  constructor(
    profile: AgentProfile,
    goalManager: GoalManager,
    private experimentLogger?: (entry: ExperimentLogEntry) => void
  ) {
    this.profile = profile;
    this.goalManager = goalManager;
    this.agentId = profile.id;
  }

  /**
   * Generate a hash of the context for cache key
   * Uses key fields that affect motivation calculation
   */
  private getContextHash(context: RoleContext): string {
    const key = {
      role: context.role,
      goalCount: context.activeGoals?.length || 0,
      goalIds: context.activeGoals?.map(g => g.id).join(','),
      urgency: context.situationAssessment?.urgency,
      resourceCount: context.availableResources?.length || 0,
      lastUpdated: context.lastUpdated?.getTime(),
    };
    return JSON.stringify(key);
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(cacheTimestamp: number): boolean {
    return (Date.now() - cacheTimestamp) < this.cacheTTL;
  }

  /**
   * Clear all caches (call when context significantly changes)
   */
  clearCache(): void {
    this.motivationCache = null;
    this.suggestionCache = null;
  }

  /**
   * Set cache TTL (for testing or performance tuning)
   */
  setCacheTTL(ttlMs: number): void {
    this.cacheTTL = ttlMs;
  }

  /**
   * Log experiment data
   */
  private log(category: ExperimentLogEntry['category'], event: string, data: Record<string, any>): void {
    const entry: ExperimentLogEntry = {
      timestamp: new Date(),
      agentId: this.agentId,
      category,
      event,
      data,
    };

    this.experimentLog.push(entry);

    if (this.experimentLogger) {
      this.experimentLogger(entry);
    } else {
      logger.info(`[MotivationEngine:${this.agentId}] [${category}] ${event}:`, JSON.stringify(data, null, 2));
    }
  }

  /**
   * Log AC trigger correlation
   */
  logACTrigger(
    motivationLevel: MotivationLevel,
    suggestion: ActionSuggestion | null,
    acTriggered: boolean,
    acData?: { type?: string; participants?: string[]; reason?: string }
  ): void {
    const activeGoals = this.goalManager.getActiveGoals();
    const highestPriorityGoal = this.goalManager.getHighestPriorityGoal();

    const correlation: ACTriggerCorrelation = {
      timestamp: new Date(),
      agentId: this.agentId,
      motivationLevel: motivationLevel.overall,
      activeGoalCount: activeGoals.length,
      highestGoalPriority: highestPriorityGoal?.priority || null,
      situationUrgency: 'unknown', // Will be updated when context is available
      suggestedAction: suggestion?.type || 'none',
      acTriggered,
      acType: acData?.type,
      acParticipants: acData?.participants,
      triggerReason: acData?.reason,
    };

    this.acTriggerCorrelations.push(correlation);

    this.log('ac_trigger', acTriggered ? 'ac_triggered' : 'ac_not_triggered', {
      motivationLevel: motivationLevel.overall,
      shouldAct: motivationLevel.shouldAct,
      suggestedAction: suggestion?.type,
      activeGoalCount: activeGoals.length,
      highestPriority: highestPriorityGoal?.priority,
      acType: acData?.type,
      participants: acData?.participants,
    });
  }

  // --------------------------------------------
  // MOTIVATION CALCULATION
  // --------------------------------------------

  /**
   * Calculate current motivation level
   * Uses caching to prevent redundant calculations within short time windows
   */
  calculateMotivation(context: RoleContext): MotivationLevel {
    // Check cache first
    const contextHash = this.getContextHash(context);
    if (this.motivationCache &&
        this.motivationCache.contextHash === contextHash &&
        this.isCacheValid(this.motivationCache.timestamp)) {
      this.log('motivation', 'cache_hit', {
        overall: this.motivationCache.result.overall,
        contextHash,
      });
      return this.motivationCache.result;
    }

    const activeGoals = this.goalManager.getActiveGoals();
    const situation = context.situationAssessment;

    // Base motivation from goal count
    let goalMotivation = 0;
    if (activeGoals.length > 0) {
      // More goals = higher motivation, but with diminishing returns
      goalMotivation = Math.min(1, activeGoals.length * 0.3);

      // Critical goals significantly increase motivation
      const criticalGoals = activeGoals.filter(g => g.priority === GoalPriority.CRITICAL);
      if (criticalGoals.length > 0) {
        goalMotivation = Math.min(1, goalMotivation + 0.4);
      }

      // Goals needing attention increase motivation
      const needsAttention = this.goalManager.getGoalsNeedingAttention();
      if (needsAttention.length > 0) {
        goalMotivation = Math.min(1, goalMotivation + 0.2);
      }
    }

    // Situation urgency affects motivation
    let urgencyMotivation = 0;
    if (situation) {
      switch (situation.urgency) {
        case 'critical':
          urgencyMotivation = 1.0;
          break;
        case 'high':
          urgencyMotivation = 0.7;
          break;
        case 'medium':
          urgencyMotivation = 0.4;
          break;
        case 'low':
          urgencyMotivation = 0.1;
          break;
      }
    }

    // Trait-based adjustment
    const traits = this.profile.traits;
    let traitAdjustment = 0;
    if (traits) {
      // Proactive agents have higher baseline motivation
      traitAdjustment += (traits.proactivity || 0.5) * 0.2;

      // Risk tolerance affects decision to act
      // (handled in shouldAct, not here)
    }

    // Combine factors
    const overall = Math.min(1, (goalMotivation * 0.5) + (urgencyMotivation * 0.3) + traitAdjustment + 0.1);

    // Calculate urgency to act
    const urgency = this.calculateUrgency(activeGoals, situation);

    // Calculate confidence
    const confidence = this.calculateConfidence(context, activeGoals);

    // Should act decision
    const shouldAct = overall >= 0.3 && urgency >= 0.2;

    // Determine reason
    const reason = this.determineMotivationReason(overall, goalMotivation, urgencyMotivation, activeGoals, situation);

    const motivationLevel: MotivationLevel = {
      overall,
      urgency,
      confidence,
      shouldAct,
      reason,
    };

    this.log('motivation', 'calculated', {
      overall,
      urgency,
      confidence,
      shouldAct,
      reason,
      activeGoalCount: activeGoals.length,
      situationUrgency: situation?.urgency,
    });

    // Store in cache
    this.motivationCache = {
      result: motivationLevel,
      contextHash,
      timestamp: Date.now(),
    };

    return motivationLevel;
  }

  /**
   * Calculate urgency to act
   */
  private calculateUrgency(goals: AgentGoal[], situation?: SituationAssessment): number {
    let urgency = 0;

    // Goals approaching deadline
    const now = new Date();
    for (const goal of goals) {
      if (goal.metrics?.deadline) {
        const timeLeft = goal.metrics.deadline.getTime() - now.getTime();
        const hour = 60 * 60 * 1000;

        if (timeLeft < 0) {
          // Overdue
          urgency = Math.max(urgency, 1.0);
        } else if (timeLeft < hour) {
          // Less than 1 hour
          urgency = Math.max(urgency, 0.9);
        } else if (timeLeft < 6 * hour) {
          // Less than 6 hours
          urgency = Math.max(urgency, 0.7);
        } else if (timeLeft < 24 * hour) {
          // Less than 1 day
          urgency = Math.max(urgency, 0.5);
        }
      }

      // Critical priority adds urgency
      if (goal.priority === GoalPriority.CRITICAL) {
        urgency = Math.max(urgency, 0.8);
      }
    }

    // Situation urgency
    if (situation) {
      switch (situation.urgency) {
        case 'critical':
          urgency = Math.max(urgency, 1.0);
          break;
        case 'high':
          urgency = Math.max(urgency, 0.7);
          break;
        case 'medium':
          urgency = Math.max(urgency, 0.4);
          break;
      }
    }

    return urgency;
  }

  /**
   * Calculate confidence in action
   */
  private calculateConfidence(context: RoleContext, goals: AgentGoal[]): number {
    let confidence = 0.5; // Base confidence

    // More resources = higher confidence
    const availableResources = context.availableResources.filter(r => r.available);
    confidence += Math.min(0.2, availableResources.length * 0.05);

    // Past successful experiences increase confidence
    const successCount = context.pastExperiences.filter(e => e.outcome === 'success').length;
    confidence += Math.min(0.2, successCount * 0.02);

    // Clear goals increase confidence
    if (goals.length > 0 && goals.length <= 5) {
      confidence += 0.1;
    }

    // High risk level reduces confidence
    if (context.situationAssessment?.riskLevel === 'high') {
      confidence -= 0.2;
    }

    // Cautious trait reduces confidence
    const cautiousness = this.profile.traits?.cautiousness || 0.5;
    confidence -= (cautiousness - 0.5) * 0.1;

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Determine reason for motivation level
   */
  private determineMotivationReason(
    overall: number,
    goalMotivation: number,
    urgencyMotivation: number,
    goals: AgentGoal[],
    situation?: SituationAssessment
  ): string {
    const factors: string[] = [];

    if (goals.length === 0) {
      return 'No active goals';
    }

    if (goalMotivation > 0.5) {
      factors.push('strong goal alignment');
    }

    if (urgencyMotivation > 0.5) {
      factors.push('urgent situation');
    }

    const criticalGoals = goals.filter(g => g.priority === GoalPriority.CRITICAL);
    if (criticalGoals.length > 0) {
      factors.push(`${criticalGoals.length} critical goal(s)`);
    }

    if (situation?.urgency === 'critical') {
      factors.push('critical situation');
    }

    if (factors.length === 0) {
      return 'Normal operation';
    }

    return factors.join(', ');
  }

  // --------------------------------------------
  // ACTION SUGGESTION
  // --------------------------------------------

  /**
   * Should this agent take action?
   */
  shouldAct(context: RoleContext): boolean {
    const motivation = this.calculateMotivation(context);

    // Risk tolerance affects decision
    const riskTolerance = this.profile.traits?.riskTolerance || 0.5;
    const riskLevel = context.situationAssessment?.riskLevel;

    if (riskLevel === 'high' && riskTolerance < 0.3) {
      // Very cautious agent in high-risk situation
      this.log('decision', 'should_act_blocked', {
        reason: 'high_risk_low_tolerance',
        riskLevel,
        riskTolerance,
      });
      return false;
    }

    this.log('decision', 'should_act_check', {
      shouldAct: motivation.shouldAct,
      overall: motivation.overall,
      urgency: motivation.urgency,
      reason: motivation.reason,
    });

    return motivation.shouldAct;
  }

  /**
   * What action should this agent take?
   * Now considers agent traits for trait-aware action suggestions
   */
  suggestAction(context: RoleContext): ActionSuggestion | null {
    // Check cache first
    const contextHash = this.getContextHash(context);
    if (this.suggestionCache &&
        this.suggestionCache.contextHash === contextHash &&
        this.isCacheValid(this.suggestionCache.timestamp)) {
      this.log('decision', 'suggestion_cache_hit', {
        actionType: this.suggestionCache.result?.type || 'null',
        contextHash,
      });
      return this.suggestionCache.result;
    }

    const motivation = this.calculateMotivation(context);

    if (!motivation.shouldAct) {
      // Cache the null result too
      this.suggestionCache = {
        result: null,
        contextHash,
        timestamp: Date.now(),
      };
      return null;
    }

    const activeGoals = this.goalManager.getActiveGoals();
    const situation = context.situationAssessment;
    const traits = this.profile.traits;

    // Extract trait values with defaults
    const proactivity = traits?.proactivity ?? 0.5;
    const socialPreference = traits?.socialPreference ?? 0.5;
    const cautiousness = traits?.cautiousness ?? 0.5;

    // Determine action type based on goals, context, AND traits
    let actionType: ActionSuggestion['type'] = 'monitor';
    let description = '';
    let relatedGoal: AgentGoal | undefined;

    // Priority: Critical goals first
    const criticalGoals = activeGoals.filter(g => g.priority === GoalPriority.CRITICAL);
    if (criticalGoals.length > 0) {
      relatedGoal = criticalGoals[0];

      if (relatedGoal.type === GoalType.PROTECTION) {
        // TRAIT-AWARE: Collaborative agents prefer to collaborate even for protection
        if (socialPreference > 0.7) {
          actionType = 'collaborate';
          description = `Collaborative protective action: ${relatedGoal.description}`;
        } else {
          actionType = 'act';
          description = `Take immediate protective action: ${relatedGoal.description}`;
        }
      } else if (relatedGoal.type === GoalType.COLLABORATION) {
        actionType = 'collaborate';
        description = `Initiate collaboration for: ${relatedGoal.description}`;
      } else {
        // TRAIT-AWARE: Decide based on traits
        if (socialPreference > 0.6) {
          actionType = 'collaborate';
          description = `Collaborate on critical goal: ${relatedGoal.description}`;
        } else {
          actionType = 'act';
          description = `Act on critical goal: ${relatedGoal.description}`;
        }
      }
    }
    // Check for collaboration opportunities
    else if (situation?.collaborationOpportunity === 'high') {
      const collabGoals = activeGoals.filter(g => g.type === GoalType.COLLABORATION);
      if (collabGoals.length > 0) {
        actionType = 'collaborate';
        description = `Collaboration opportunity: ${collabGoals[0].description}`;
        relatedGoal = collabGoals[0];
      } else if (socialPreference > 0.5) {
        // TRAIT-AWARE: High social preference agents seek collaboration even without explicit collab goals
        actionType = 'collaborate';
        description = `Seek collaboration for better outcome`;
        relatedGoal = activeGoals[0];
      }
    }
    // Check for exploration goals
    else if (activeGoals.some(g => g.type === GoalType.EXPLORATION)) {
      const exploreGoal = activeGoals.find(g => g.type === GoalType.EXPLORATION);
      if (exploreGoal) {
        // TRAIT-AWARE: Low proactivity agents prefer monitoring over exploration
        // TRAIT-AWARE: High social preference agents prefer collaboration over exploration
        if (socialPreference > 0.6) {
          actionType = 'collaborate';
          description = `Collaborative exploration: ${exploreGoal.description}`;
        } else if (proactivity < 0.4) {
          actionType = 'monitor';
          description = `Monitor exploration area: ${exploreGoal.description}`;
        } else {
          actionType = 'explore';
          description = `Explore: ${exploreGoal.description}`;
        }
        relatedGoal = exploreGoal;
      }
    }
    // Default to monitoring or acting on maintenance goals
    else if (activeGoals.length > 0) {
      relatedGoal = activeGoals[0];

      // TRAIT-AWARE: Use traits to decide action type
      if (relatedGoal.type === GoalType.MAINTENANCE) {
        // High proactivity agents act on maintenance goals instead of just monitoring
        if (proactivity > 0.6) {
          actionType = 'act';
          description = `Proactively maintain: ${relatedGoal.description}`;
        } else if (socialPreference > 0.6 && situation?.collaborationOpportunity !== 'none') {
          actionType = 'collaborate';
          description = `Collaborate on maintenance: ${relatedGoal.description}`;
        } else {
          actionType = 'monitor';
          description = `Monitor: ${relatedGoal.description}`;
        }
      } else {
        // For other goal types, consider social preference
        if (socialPreference > 0.6) {
          actionType = 'collaborate';
          description = `Collaborate on: ${relatedGoal.description}`;
        } else {
          actionType = 'act';
          description = `Act on: ${relatedGoal.description}`;
        }
      }
    }
    // No specific goal, wait
    else {
      // TRAIT-AWARE: Even with no goals, traits affect behavior
      if (proactivity > 0.7) {
        actionType = 'explore';
        description = 'Proactively explore for opportunities';
      } else {
        actionType = 'wait';
        description = 'No specific action needed';
      }
    }

    // Generate alternatives
    const alternatives = this.generateAlternatives(context, actionType, activeGoals);

    const suggestion: ActionSuggestion = {
      type: actionType,
      description,
      goalId: relatedGoal?.id,
      priority: relatedGoal?.priority || GoalPriority.MEDIUM,
      expectedOutcome: this.predictOutcome(actionType, relatedGoal),
      requiredResources: this.identifyRequiredResources(actionType, context),
      confidence: motivation.confidence,
      alternatives,
    };

    this.log('decision', 'action_suggested', {
      type: actionType,
      description,
      goalId: relatedGoal?.id,
      priority: relatedGoal?.priority,
      confidence: motivation.confidence,
      traitsUsed: { proactivity, socialPreference, cautiousness },
    });

    // Store in cache
    this.suggestionCache = {
      result: suggestion,
      contextHash,
      timestamp: Date.now(),
    };

    return suggestion;
  }

  /**
   * Generate alternative actions
   */
  private generateAlternatives(
    context: RoleContext,
    primaryAction: ActionSuggestion['type'],
    goals: AgentGoal[]
  ): ActionSuggestion[] {
    const alternatives: ActionSuggestion[] = [];

    // If primary is act, consider waiting or collaborating
    if (primaryAction === 'act') {
      if (context.situationAssessment?.collaborationOpportunity !== 'none') {
        alternatives.push({
          type: 'collaborate',
          description: 'Seek collaboration before acting',
          priority: GoalPriority.MEDIUM,
          confidence: 0.6,
        });
      }

      alternatives.push({
        type: 'monitor',
        description: 'Continue monitoring before acting',
        priority: GoalPriority.LOW,
        confidence: 0.7,
      });
    }

    // If primary is collaborate, consider acting alone
    if (primaryAction === 'collaborate') {
      alternatives.push({
        type: 'act',
        description: 'Act independently',
        priority: GoalPriority.MEDIUM,
        confidence: 0.5,
      });
    }

    return alternatives.slice(0, 2); // Max 2 alternatives
  }

  /**
   * Predict outcome of action
   */
  private predictOutcome(actionType: ActionSuggestion['type'], goal?: AgentGoal): string {
    if (!goal) {
      return 'Unknown outcome';
    }

    switch (actionType) {
      case 'act':
        return `Progress toward: ${goal.description}`;
      case 'collaborate':
        return `Collaborative achievement of: ${goal.description}`;
      case 'monitor':
        return `Maintain awareness of: ${goal.description}`;
      case 'explore':
        return `Discover information related to: ${goal.description}`;
      case 'wait':
        return 'No immediate change';
      default:
        return 'Unknown outcome';
    }
  }

  /**
   * Identify required resources for action
   */
  private identifyRequiredResources(
    actionType: ActionSuggestion['type'],
    context: RoleContext
  ): string[] {
    const resources: string[] = [];

    if (actionType === 'act' || actionType === 'monitor') {
      // Need device resources
      const devices = context.availableResources.filter(r => r.type === 'device' && r.available);
      resources.push(...devices.map(d => d.id));
    }

    if (actionType === 'collaborate') {
      // Need agent resources
      const agents = context.availableResources.filter(r => r.type === 'agent' && r.available);
      resources.push(...agents.map(a => a.id));
    }

    return resources.slice(0, 3); // Max 3 resources
  }

  // --------------------------------------------
  // EXPERIMENT DATA EXPORT
  // --------------------------------------------

  /**
   * Get experiment log
   */
  getExperimentLog(): ExperimentLogEntry[] {
    return [...this.experimentLog];
  }

  /**
   * Get AC trigger correlations
   */
  getACTriggerCorrelations(): ACTriggerCorrelation[] {
    return [...this.acTriggerCorrelations];
  }

  /**
   * Export all experiment data
   */
  exportExperimentData(): {
    agentId: string;
    profile: AgentProfile;
    experimentLog: ExperimentLogEntry[];
    acTriggerCorrelations: ACTriggerCorrelation[];
    goalStats: ReturnType<GoalManager['getStats']>;
  } {
    return {
      agentId: this.agentId,
      profile: this.profile,
      experimentLog: this.experimentLog,
      acTriggerCorrelations: this.acTriggerCorrelations,
      goalStats: this.goalManager.getStats(),
    };
  }

  /**
   * Clear experiment data
   */
  clearExperimentData(): void {
    this.experimentLog = [];
    this.acTriggerCorrelations = [];
  }
}
