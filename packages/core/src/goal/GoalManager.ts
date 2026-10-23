/**
 * Goal Manager
 *
 * Manages goal lifecycle and execution for agents.
 * Tracks goal progress, status changes, and provides goal-related utilities.
 */

import {
  AgentGoal,
  GoalType,
  GoalPriority,
  GoalStatus,
  GoalEvent,
  GoalStats,
} from './types';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('GoalManager');

/**
 * Manages goal lifecycle and execution
 */


export class GoalManager {
  private goals: Map<string, AgentGoal> = new Map();
  private eventLog: GoalEvent[] = [];
  private agentId: string;
  private experimentLogger: (event: string, data: any) => void;

  constructor(
    agentId: string,
    experimentLogger?: (event: string, data: any) => void
  ) {
    this.agentId = agentId;
    this.experimentLogger = experimentLogger || this.defaultLogger;
  }

  /**
   * Default logger for experiments
   */
  private defaultLogger = (event: string, data: any): void => {
    const timestamp = new Date().toISOString();
    logger.info(`[GoalManager:${this.agentId}] [${timestamp}] ${event}:`, JSON.stringify(data, null, 2));
  };

  /**
   * Log a goal event for experiment tracking
   */
  private logEvent(type: GoalEvent['type'], goal: AgentGoal, reason?: string): void {
    const event: GoalEvent = {
      type,
      goal,
      timestamp: new Date(),
      reason,
    };

    this.eventLog.push(event);

    this.experimentLogger('goal_event', {
      agentId: this.agentId,
      eventType: type,
      goalId: goal.id,
      goalType: goal.type,
      goalPriority: goal.priority,
      goalStatus: goal.status,
      reason,
    });
  }

  // --------------------------------------------
  // GOAL MANAGEMENT
  // --------------------------------------------

  /**
   * Add a new goal
   */
  addGoal(goal: AgentGoal): void {
    if (this.goals.has(goal.id)) {
      this.experimentLogger('goal_add_failed', {
        agentId: this.agentId,
        goalId: goal.id,
        reason: 'Goal already exists',
      });
      return;
    }

    this.goals.set(goal.id, goal);
    this.logEvent('created', goal);

    this.experimentLogger('goal_added', {
      agentId: this.agentId,
      goalId: goal.id,
      goalType: goal.type,
      goalPriority: goal.priority,
      description: goal.description,
    });
  }

  /**
   * Remove a goal
   */
  removeGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return false;
    }

    this.goals.delete(goalId);
    this.logEvent('failed', goal, 'Removed manually');

    return true;
  }

  /**
   * Get a goal by ID
   */
  getGoal(goalId: string): AgentGoal | undefined {
    return this.goals.get(goalId);
  }

  /**
   * Get all goals
   */
  getAllGoals(): AgentGoal[] {
    return Array.from(this.goals.values());
  }

  // --------------------------------------------
  // GOAL STATUS MANAGEMENT
  // --------------------------------------------

  /**
   * Update goal progress
   */
  updateProgress(goalId: string, current: number): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return false;
    }

    const previousStatus = goal.status;

    if (goal.metrics) {
      goal.metrics.current = current;
      goal.metrics.lastUpdated = new Date();
    } else {
      goal.metrics = {
        current,
        lastUpdated: new Date(),
      };
    }

    goal.updatedAt = new Date();

    // Check if goal is achieved
    if (this.isGoalAchieved(goalId)) {
      goal.status = GoalStatus.ACHIEVED;
      this.logEvent('achieved', goal);
    } else if (previousStatus === GoalStatus.PENDING) {
      goal.status = GoalStatus.IN_PROGRESS;
      this.logEvent('updated', goal, 'Progress updated');
    }

    this.experimentLogger('goal_progress', {
      agentId: this.agentId,
      goalId,
      current,
      target: goal.metrics?.target,
      status: goal.status,
    });

    return true;
  }

  /**
   * Activate a pending goal
   */
  activateGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== GoalStatus.PENDING) {
      return false;
    }

    // Check dependencies
    if (goal.dependencies) {
      const unmetDeps = goal.dependencies.filter(depId => {
        const dep = this.goals.get(depId);
        return !dep || dep.status !== GoalStatus.ACHIEVED;
      });

      if (unmetDeps.length > 0) {
        this.experimentLogger('goal_activation_failed', {
          agentId: this.agentId,
          goalId,
          reason: 'Dependencies not met',
          unmetDependencies: unmetDeps,
        });
        return false;
      }
    }

    goal.status = GoalStatus.ACTIVE;
    goal.updatedAt = new Date();
    this.logEvent('activated', goal);

    return true;
  }

  /**
   * Suspend an active goal
   */
  suspendGoal(goalId: string, reason?: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== GoalStatus.ACTIVE && goal.status !== GoalStatus.IN_PROGRESS) {
      return false;
    }

    goal.status = GoalStatus.SUSPENDED;
    goal.updatedAt = new Date();
    this.logEvent('suspended', goal, reason);

    return true;
  }

  /**
   * Mark a goal as failed
   */
  failGoal(goalId: string, reason?: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) {
      return false;
    }

    goal.status = GoalStatus.FAILED;
    goal.updatedAt = new Date();
    this.logEvent('failed', goal, reason);

    return true;
  }

  // --------------------------------------------
  // GOAL QUERIES
  // --------------------------------------------

  /**
   * Check if goal is achieved
   */
  isGoalAchieved(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal || !goal.target || !goal.metrics) {
      return false;
    }

    const { target, metrics } = goal;
    const current = metrics.current;

    if (current === undefined) {
      return false;
    }

    switch (target.operator) {
      case 'eq':
        return current === target.value;
      case 'ne':
        return current !== target.value;
      case 'gt':
        return current > (target.value as number);
      case 'gte':
        return current >= (target.value as number);
      case 'lt':
        return current < (target.value as number);
      case 'lte':
        return current <= (target.value as number);
      case 'range':
        const range = target.value as { min: number; max: number };
        return current >= range.min && current <= range.max;
      default:
        return false;
    }
  }

  /**
   * Get all active goals
   */
  getActiveGoals(): AgentGoal[] {
    return this.getAllGoals().filter(
      g => g.status === GoalStatus.ACTIVE || g.status === GoalStatus.IN_PROGRESS
    );
  }

  /**
   * Get goals by type
   */
  getGoalsByType(type: GoalType): AgentGoal[] {
    return this.getAllGoals().filter(g => g.type === type);
  }

  /**
   * Get goals by priority
   */
  getGoalsByPriority(priority: GoalPriority): AgentGoal[] {
    return this.getAllGoals().filter(g => g.priority === priority);
  }

  /**
   * Get goals by status
   */
  getGoalsByStatus(status: GoalStatus): AgentGoal[] {
    return this.getAllGoals().filter(g => g.status === status);
  }

  /**
   * Get highest priority active goal
   */
  getHighestPriorityGoal(): AgentGoal | undefined {
    const activeGoals = this.getActiveGoals();
    if (activeGoals.length === 0) {
      return undefined;
    }

    const priorityOrder = {
      [GoalPriority.CRITICAL]: 0,
      [GoalPriority.HIGH]: 1,
      [GoalPriority.MEDIUM]: 2,
      [GoalPriority.LOW]: 3,
    };

    return activeGoals.sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    )[0];
  }

  /**
   * Get goals that need attention
   * (active goals with low progress or approaching deadline)
   */
  getGoalsNeedingAttention(): AgentGoal[] {
    const now = new Date();
    return this.getActiveGoals().filter(goal => {
      // Check if approaching deadline
      if (goal.metrics?.deadline) {
        const timeLeft = goal.metrics.deadline.getTime() - now.getTime();
        const hour = 60 * 60 * 1000;
        if (timeLeft < 24 * hour) {
          return true;
        }
      }

      // Check if progress is stuck
      if (goal.metrics?.target !== undefined && goal.metrics?.current !== undefined) {
        const progress = goal.metrics.current / goal.metrics.target;
        if (progress < 0.5) {
          return true;
        }
      }

      return false;
    });
  }

  // --------------------------------------------
  // STATISTICS & LOGGING
  // --------------------------------------------

  /**
   * Get goal statistics
   */
  getStats(): GoalStats {
    const goals = this.getAllGoals();
    const total = goals.length;

    const byStatus = goals.reduce((acc, g) => {
      acc[g.status] = (acc[g.status] || 0) + 1;
      return acc;
    }, {} as Record<GoalStatus, number>);

    const byType = goals.reduce((acc, g) => {
      acc[g.type] = (acc[g.type] || 0) + 1;
      return acc;
    }, {} as Record<GoalType, number>);

    const byPriority = goals.reduce((acc, g) => {
      acc[g.priority] = (acc[g.priority] || 0) + 1;
      return acc;
    }, {} as Record<GoalPriority, number>);

    const now = new Date();
    const averageAge = goals.length > 0
      ? goals.reduce((sum, g) => sum + (now.getTime() - g.createdAt.getTime()), 0) / goals.length / 1000 / 60
      : 0;

    const achieved = byStatus[GoalStatus.ACHIEVED] || 0;
    const failed = byStatus[GoalStatus.FAILED] || 0;
    const achievementRate = (achieved + failed) > 0 ? achieved / (achieved + failed) : 0;

    return {
      total,
      byStatus: byStatus as Record<GoalStatus, number>,
      byType: byType as Record<GoalType, number>,
      byPriority: byPriority as Record<GoalPriority, number>,
      averageAge,
      achievementRate,
    };
  }

  /**
   * Get event log for experiment analysis
   */
  getEventLog(): GoalEvent[] {
    return [...this.eventLog];
  }

  /**
   * Clear event log
   */
  clearEventLog(): void {
    this.eventLog = [];
  }

  /**
   * Export experiment data
   */
  exportExperimentData(): {
    agentId: string;
    stats: GoalStats;
    events: GoalEvent[];
    goals: AgentGoal[];
  } {
    return {
      agentId: this.agentId,
      stats: this.getStats(),
      events: this.getEventLog(),
      goals: this.getAllGoals(),
    };
  }
}
