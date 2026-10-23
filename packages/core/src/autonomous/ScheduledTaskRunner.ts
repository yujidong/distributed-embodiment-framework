/**
 * Scheduled Task Runner
 *
 * Manages scheduled task execution based on intervals or cron expressions.
 * Part of the Autonomous Operation system.
 *
 * Active Collaboration Theory - Core Property 4: Autonomous Operation
 * - Agents can schedule periodic tasks
 * - Supports interval-based and cron-based scheduling
 * - Supports conditional execution
 */

import type { ScheduledCheckConfig, ConfigTriggerCondition, ComparisonOperator } from '../config/types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Result of task execution
 */
const logger = createLogger('ScheduledTaskRunner');

export interface ScheduledTaskResult {
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * Task execution statistics
 */
export interface TaskStats {
  executionCount: number;
  successCount: number;
  failureCount: number;
  lastExecutionTime?: Date;
  lastResult?: any;
  lastError?: string;
}

/**
 * Task context provided to executor
 */
export interface TaskContext {
  agentId?: string;
  environmentId?: string;
  timestamp: Date;
  [key: string]: any;
}

/**
 * Task executor function type
 */
export type TaskExecutor = (
  task: string,
  context: TaskContext
) => Promise<ScheduledTaskResult>;

/**
 * Context provider function type
 */
export type ContextProvider = () => Promise<TaskContext>;

/**
 * Internal scheduled task state
 */
interface ScheduledTaskState {
  config: ScheduledCheckConfig;
  timerId?: ReturnType<typeof setInterval>;
  nextExecutionTime?: Date;
  stats: TaskStats;
}

/**
 * Scheduled Task Runner
 * Manages task scheduling and execution
 */
export class ScheduledTaskRunner {
  private tasks: Map<string, ScheduledTaskState> = new Map();
  private taskExecutor?: TaskExecutor;
  private contextProvider?: ContextProvider;

  /**
   * Set the task executor function
   */
  setTaskExecutor(executor: TaskExecutor): void {
    this.taskExecutor = executor;
  }

  /**
   * Set the context provider function
   */
  setContextProvider(provider: ContextProvider): void {
    this.contextProvider = provider;
  }

  /**
   * Schedule a new task
   */
  scheduleTask(config: ScheduledCheckConfig): void {
    if (this.tasks.has(config.id)) {
      throw new Error(`Task with id '${config.id}' already exists`);
    }

    const state: ScheduledTaskState = {
      config,
      stats: {
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };

    this.tasks.set(config.id, state);

    // Start if enabled
    if (config.enabled) {
      this.startTask(config.id);
    }
  }

  /**
   * Cancel a scheduled task
   */
  cancelTask(id: string): boolean {
    const state = this.tasks.get(id);
    if (!state) {
      return false;
    }

    this.stopTaskTimer(id);
    this.tasks.delete(id);
    return true;
  }

  /**
   * Check if a task exists
   */
  hasTask(id: string): boolean {
    return this.tasks.has(id);
  }

  /**
   * Check if a task is enabled
   */
  isTaskEnabled(id: string): boolean {
    const state = this.tasks.get(id);
    return state?.config.enabled ?? false;
  }

  /**
   * Check if a task is currently running (has active timer)
   */
  isTaskRunning(id: string): boolean {
    const state = this.tasks.get(id);
    return state?.timerId !== undefined;
  }

  /**
   * Enable a task
   */
  enableTask(id: string): void {
    const state = this.tasks.get(id);
    if (state && !state.config.enabled) {
      state.config.enabled = true;
      this.startTask(id);
    }
  }

  /**
   * Disable a task
   */
  disableTask(id: string): void {
    const state = this.tasks.get(id);
    if (state && state.config.enabled) {
      state.config.enabled = false;
      this.stopTaskTimer(id);
    }
  }

  /**
   * Get all active (enabled) tasks
   */
  getActiveTasks(): ScheduledCheckConfig[] {
    const activeTasks: ScheduledCheckConfig[] = [];
    for (const state of this.tasks.values()) {
      if (state.config.enabled) {
        activeTasks.push(state.config);
      }
    }
    return activeTasks;
  }

  /**
   * Get task statistics
   */
  getTaskStats(id: string): TaskStats {
    const state = this.tasks.get(id);
    if (!state) {
      return {
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
      };
    }
    return { ...state.stats };
  }

  /**
   * Get next execution time for a task
   */
  getNextExecutionTime(id: string): Date | undefined {
    const state = this.tasks.get(id);
    if (!state || !state.config.enabled) {
      return undefined;
    }
    return state.nextExecutionTime;
  }

  /**
   * Execute a task immediately
   */
  async executeNow(id: string): Promise<ScheduledTaskResult> {
    const state = this.tasks.get(id);
    if (!state) {
      throw new Error(`Task '${id}' not found`);
    }

    return this.executeTask(state);
  }

  /**
   * Stop all scheduled tasks
   */
  stopAll(): void {
    for (const id of this.tasks.keys()) {
      this.stopTaskTimer(id);
    }
  }

  /**
   * Start a task's timer
   */
  private startTask(id: string): void {
    const state = this.tasks.get(id);
    if (!state || !state.config.enabled) {
      return;
    }

    // Stop existing timer if any
    this.stopTaskTimer(id);

    const interval = state.config.interval;
    if (!interval) {
      return;
    }

    // Calculate next execution time
    state.nextExecutionTime = new Date(Date.now() + interval);

    // Set up interval timer
    state.timerId = setInterval(async () => {
      await this.executeTask(state);

      // Update next execution time
      if (state.config.enabled && state.config.interval) {
        state.nextExecutionTime = new Date(Date.now() + state.config.interval);
      }
    }, interval);
  }

  /**
   * Stop a task's timer
   */
  private stopTaskTimer(id: string): void {
    const state = this.tasks.get(id);
    if (state?.timerId) {
      clearInterval(state.timerId);
      state.timerId = undefined;
      state.nextExecutionTime = undefined;
    }
  }

  /**
   * Execute a task
   */
  private async executeTask(state: ScheduledTaskState): Promise<ScheduledTaskResult> {
    const config = state.config;

    // Get context
    let context: TaskContext = {
      timestamp: new Date(),
    };

    if (this.contextProvider) {
      try {
        const providedContext = await this.contextProvider();
        context = { ...context, ...providedContext };
      } catch (error) {
        logger.error('Context provider failed:', error);
      }
    }

    // Check condition if specified
    if (config.condition) {
      const conditionMet = this.evaluateCondition(config.condition, context);
      if (!conditionMet) {
        return { success: true, result: 'Condition not met, skipped' };
      }
    }

    // Execute the task
    state.stats.executionCount++;
    state.stats.lastExecutionTime = new Date();

    if (!this.taskExecutor) {
      return { success: false, error: 'No task executor configured' };
    }

    try {
      const result = await this.taskExecutor(config.task, context);
      state.stats.successCount++;
      state.stats.lastResult = result.result;
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      state.stats.failureCount++;
      state.stats.lastError = errorMessage;
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Evaluate a condition against context
   */
  private evaluateCondition(condition: ConfigTriggerCondition, context: TaskContext): boolean {
    const { parameter, operator, value } = condition;

    if (!parameter || operator === undefined || value === undefined) {
      return true;
    }

    const actualValue = this.resolveValue(parameter, context);
    if (actualValue === undefined) {
      return false;
    }

    return this.compareValues(actualValue, operator, value);
  }

  /**
   * Resolve a parameter path to a value
   */
  private resolveValue(path: string, context: TaskContext): any {
    const parts = path.split('.');
    let value: any = context;

    for (const part of parts) {
      if (value === undefined || value === null) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Compare values using operator
   */
  private compareValues(actual: any, operator: ComparisonOperator, expected: any): boolean {
    switch (operator) {
      case '==':
        return actual === expected;

      case '!=':
        return actual !== expected;

      case '>':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected;

      case '<':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected;

      case '>=':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;

      case '<=':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;

      case 'contains':
        return String(actual).includes(String(expected));

      case 'startsWith':
        return String(actual).startsWith(String(expected));

      case 'endsWith':
        return String(actual).endsWith(String(expected));

      case 'in':
        return Array.isArray(expected) && expected.includes(actual);

      case 'notIn':
        return Array.isArray(expected) && !expected.includes(actual);

      default:
        return false;
    }
  }
}
