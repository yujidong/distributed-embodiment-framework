/**
 * Trigger Engine
 *
 * Evaluates event-driven triggers and executes actions when conditions match.
 * Part of the Autonomous Operation system.
 *
 * Active Collaboration Theory - Core Property 4: Autonomous Operation
 * - Agents can operate autonomously based on triggers
 * - Triggers evaluate conditions and execute actions
 * - Supports cooldown and execution limits
 */

import type { TriggerConfig, TriggerAction, ConfigTriggerCondition, ComparisonOperator } from '../config/types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Trigger evaluation context
 */
const logger = createLogger('TriggerEngine');

export interface TriggerContext {
  agentId: string;
  environmentId: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

/**
 * Event to evaluate against triggers
 */
export interface TriggerEvent {
  type: string;
  source: string;
  timestamp: Date;
  data: Record<string, any>;
}

/**
 * Result of trigger evaluation
 */
export interface TriggerResult {
  triggerId: string;
  triggered: boolean;
  action?: TriggerAction;
  reason?: string;
  executionTime?: number;
}

/**
 * Trigger execution statistics
 */
export interface TriggerStats {
  totalEvaluations: number;
  successfulTriggers: number;
  failedTriggers: number;
  lastTriggered?: Date;
  lastError?: string;
}

/**
 * Action executor function type
 */
export type ActionExecutor = (
  action: TriggerAction,
  context: TriggerContext
) => Promise<{ success: boolean; action: TriggerAction; error?: string }>;

/**
 * Internal trigger state
 */
interface TriggerState {
  config: TriggerConfig;
  executionCount: number;
  lastTriggered?: Date;
  stats: TriggerStats;
}

/**
 * Trigger Engine
 * Manages trigger registration, evaluation, and action execution
 */
export class TriggerEngine {
  private triggers: Map<string, TriggerState> = new Map();
  private actionExecutor?: ActionExecutor;
  private stateStore?: import('./TriggerStateStore.js').TriggerStateStore;

  /**
   * Set the action executor function
   */
  setActionExecutor(executor: ActionExecutor): void {
    this.actionExecutor = executor;
  }

  /**
   * Set the state store for persistence
   */
  setStateStore(store: import('./TriggerStateStore.js').TriggerStateStore): void {
    this.stateStore = store;
  }

  /**
   * Register a new trigger
   */
  async registerTrigger(config: TriggerConfig): Promise<void> {
    if (this.triggers.has(config.id)) {
      throw new Error(`Trigger with id '${config.id}' already exists`);
    }

    const triggerState: TriggerState = {
      config,
      executionCount: 0,
      stats: {
        totalEvaluations: 0,
        successfulTriggers: 0,
        failedTriggers: 0,
      },
    };

    if (this.stateStore) {
      const persistedState = await this.stateStore.getTriggerState(config.id);
      if (persistedState) {
        triggerState.executionCount = persistedState.executionCount;
        triggerState.lastTriggered = persistedState.lastTriggered;
      }
    }

    this.triggers.set(config.id, triggerState);
  }

  /**
   * Unregister a trigger
   */
  unregisterTrigger(id: string): boolean {
    return this.triggers.delete(id);
  }

  /**
   * Check if a trigger exists
   */
  hasTrigger(id: string): boolean {
    return this.triggers.has(id);
  }

  /**
   * Check if a trigger is enabled
   */
  isTriggerEnabled(id: string): boolean {
    const state = this.triggers.get(id);
    return state?.config.enabled ?? false;
  }

  /**
   * Enable a trigger
   */
  enableTrigger(id: string): void {
    const state = this.triggers.get(id);
    if (state) {
      state.config.enabled = true;
    }
  }

  /**
   * Disable a trigger
   */
  disableTrigger(id: string): void {
    const state = this.triggers.get(id);
    if (state) {
      state.config.enabled = false;
    }
  }

  /**
   * Get all active (enabled) triggers
   */
  getActiveTriggers(): TriggerConfig[] {
    const activeTriggers: TriggerConfig[] = [];
    for (const state of this.triggers.values()) {
      if (state.config.enabled) {
        activeTriggers.push(state.config);
      }
    }
    return activeTriggers;
  }

  /**
   * Get trigger statistics
   */
  getTriggerStats(id: string): TriggerStats {
    const state = this.triggers.get(id);
    if (!state) {
      return {
        totalEvaluations: 0,
        successfulTriggers: 0,
        failedTriggers: 0,
      };
    }
    return { ...state.stats };
  }

  /**
   * Evaluate an event against all triggers
   */
  async evaluateEvent(event: TriggerEvent): Promise<TriggerResult[]> {
    const results: TriggerResult[] = [];

    for (const [id, state] of this.triggers) {
      if (!state.config.enabled) {
        continue;
      }

      const result = await this.evaluateTrigger(state, event);
      if (result.triggered) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Evaluate a single trigger against an event
   */
  private async evaluateTrigger(
    state: TriggerState,
    event: TriggerEvent
  ): Promise<TriggerResult> {
    const config = state.config;
    const startTime = Date.now();

    state.stats.totalEvaluations++;

    // Check if trigger matches event source
    if (config.condition.deviceId && config.condition.deviceId !== event.source) {
      return {
        triggerId: config.id,
        triggered: false,
        reason: 'Event source does not match trigger device',
      };
    }

    // Evaluate condition
    const conditionMet = this.evaluateCondition(config.condition, event.data);
    if (!conditionMet) {
      return {
        triggerId: config.id,
        triggered: false,
        reason: 'Condition not met',
      };
    }

    // Check cooldown
    if (config.cooldownMs && state.lastTriggered) {
      const timeSinceLastTrigger = Date.now() - state.lastTriggered.getTime();
      if (timeSinceLastTrigger < config.cooldownMs) {
        return {
          triggerId: config.id,
          triggered: false,
          reason: 'Cooldown period active',
        };
      }
    }

    // Check max executions
    if (config.maxExecutions && state.executionCount >= config.maxExecutions) {
      return {
        triggerId: config.id,
        triggered: false,
        reason: 'Maximum executions reached',
      };
    }

    // Execute action
    if (this.actionExecutor) {
      try {
        const context: TriggerContext = {
          agentId: 'autonomous',
          environmentId: 'default',
          timestamp: new Date(),
        };

        await this.actionExecutor(config.action, context);

        state.executionCount++;
        state.lastTriggered = new Date();
        state.stats.successfulTriggers++;
        state.stats.lastTriggered = state.lastTriggered;

        await this.persistTriggerState(state);
        await this.recordHistory(state.config.id, true, Date.now() - startTime);

        return {
          triggerId: config.id,
          triggered: true,
          action: config.action,
          executionTime: Date.now() - startTime,
        };
      } catch (error) {
        state.stats.failedTriggers++;
        state.stats.lastError = error instanceof Error ? error.message : String(error);

        return {
          triggerId: config.id,
          triggered: false,
          reason: `Action execution failed: ${state.stats.lastError}`,
        };
      }
    }

    // No action executor configured
    state.executionCount++;
    state.lastTriggered = new Date();
    state.stats.successfulTriggers++;

    await this.persistTriggerState(state);
    await this.recordHistory(state.config.id, true, Date.now() - startTime);

    return {
      triggerId: config.id,
      triggered: true,
      action: config.action,
      executionTime: Date.now() - startTime,
    };
  }

  /**
   * Evaluate a condition against data
   */
  evaluateCondition(condition: ConfigTriggerCondition, data: Record<string, any>): boolean {
    // If using logic expression, delegate to logic evaluator
    if (condition.logic) {
      return this.evaluateLogicCondition(condition.logic, data);
    }

    // Simple condition evaluation
    const { parameter, operator, value } = condition;

    if (!parameter || operator === undefined || value === undefined) {
      // Condition is incomplete, check if deviceId matches at least
      return true;
    }

    const actualValue = data[parameter];

    if (actualValue === undefined) {
      return false;
    }

    return this.compareValues(actualValue, operator, value);
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

  /**
   * Evaluate JSON Logic condition
   */
  private evaluateLogicCondition(logic: Record<string, any>, data: Record<string, any>): boolean {
    // Basic JSON Logic implementation
    // Supports: { "==": [var, value] }, { ">": [var, value] }, etc.
    // And: { "and": [...] }, Or: { "or": [...] }

    const operators = Object.keys(logic);
    if (operators.length === 0) {
      return true;
    }

    const op = operators[0];
    const args = logic[op];

    switch (op) {
      case 'and':
        return Array.isArray(args) && args.every((arg: any) => this.evaluateLogicCondition(arg, data));

      case 'or':
        return Array.isArray(args) && args.some((arg: any) => this.evaluateLogicCondition(arg, data));

      case 'not':
        return !this.evaluateLogicCondition(args, data);

      case '==':
      case '!=':
      case '>':
      case '<':
      case '>=':
      case '<=':
        if (Array.isArray(args) && args.length >= 2) {
          const varPath = args[0];
          const value = args[1];
          const actualValue = this.resolveVar(varPath, data);
          return this.compareValues(actualValue, op as ComparisonOperator, value);
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Resolve variable path in data
   */
  private resolveVar(varSpec: any, data: Record<string, any>): any {
    if (typeof varSpec === 'object' && varSpec.var) {
      const path = varSpec.var;
      const parts = path.split('.');
      let value = data;
      for (const part of parts) {
        if (value === undefined || value === null) {
          return undefined;
        }
        value = value[part];
      }
      return value;
    }
    return varSpec;
  }

  /**
   * Clear all triggers
   */
  clearAllTriggers(): void {
    this.triggers.clear();
  }

  private async persistTriggerState(state: TriggerState): Promise<void> {
    if (!this.stateStore) return;
    try {
      await this.stateStore.saveTriggerState({
        triggerId: state.config.id,
        executionCount: state.executionCount,
        lastTriggered: state.lastTriggered,
        enabled: state.config.enabled,
        metadata: {},
      });
    } catch (error) {
      logger.error(`Failed to persist state for ${state.config.id}:`, error);
    }
  }

  private async recordHistory(triggerId: string, triggered: boolean, executionTime: number): Promise<void> {
    if (!this.stateStore) return;
    try {
      await this.stateStore.recordExecution({
        id: `exec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        triggerId,
        timestamp: new Date(),
        triggered,
        executionTime,
      });
    } catch (error) {
      logger.error(`Failed to record history for ${triggerId}:`, error);
    }
  }
}
