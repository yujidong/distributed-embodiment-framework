/**
 * Threshold Monitor
 *
 * Monitors device parameters against configured thresholds and triggers
 * actions when thresholds are crossed.
 * Part of the Autonomous Operation system.
 *
 * Active Collaboration Theory - Core Property 4: Autonomous Operation
 * - Monitors can detect threshold violations
 * - Supports warning and critical thresholds
 * - Implements hysteresis to prevent rapid state changes
 * - Supports duration requirements for persistent violations
 */

import type { ThresholdMonitorConfig, ThresholdLevel, TriggerAction, ComparisonOperator } from '../config/types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Monitor state levels
 */
const logger = createLogger('ThresholdMonitor');

export type MonitorStateLevel = 'normal' | 'warning' | 'critical';

/**
 * Result of a threshold check
 */
export interface ThresholdCheckResult {
  monitorId: string;
  state: MonitorStateLevel;
  triggered: boolean;
  triggeredLevel?: 'warning' | 'critical';
  previousState?: MonitorStateLevel;
  value?: any;
  timestamp: Date;
}

/**
 * Monitor statistics
 */
export interface MonitorStats {
  totalChecks: number;
  warningTriggerCount: number;
  criticalTriggerCount: number;
  actionExecutionCount: number;
  lastStateChange?: Date;
  lastActionExecuted?: Date;
}

/**
 * Action executor function type
 */
export type ThresholdActionExecutor = (
  action: TriggerAction,
  level: 'warning' | 'critical'
) => Promise<{ success: boolean; action: TriggerAction; error?: string }>;

/**
 * Internal monitor state
 */
interface MonitorState {
  config: ThresholdMonitorConfig;
  currentState: MonitorStateLevel;
  stats: MonitorStats;
  durationStartTime?: Date;
  durationLevel?: 'warning' | 'critical';
  lastValue?: any;
  actionExecutedForCurrentState: boolean;
}

/**
 * Threshold Monitor
 * Manages threshold monitoring and action execution
 */
export class ThresholdMonitor {
  private monitors: Map<string, MonitorState> = new Map();
  private actionExecutor?: ThresholdActionExecutor;

  /**
   * Set the action executor function
   */
  setActionExecutor(executor: ThresholdActionExecutor): void {
    this.actionExecutor = executor;
  }

  /**
   * Add a new threshold monitor
   */
  addMonitor(config: ThresholdMonitorConfig): void {
    if (this.monitors.has(config.id)) {
      throw new Error(`Monitor with id '${config.id}' already exists`);
    }

    this.monitors.set(config.id, {
      config,
      currentState: 'normal',
      stats: {
        totalChecks: 0,
        warningTriggerCount: 0,
        criticalTriggerCount: 0,
        actionExecutionCount: 0,
      },
      actionExecutedForCurrentState: false,
    });
  }

  /**
   * Remove a monitor
   */
  removeMonitor(id: string): boolean {
    return this.monitors.delete(id);
  }

  /**
   * Check if a monitor exists
   */
  hasMonitor(id: string): boolean {
    return this.monitors.has(id);
  }

  /**
   * Check if a monitor is enabled
   */
  isMonitorEnabled(id: string): boolean {
    const state = this.monitors.get(id);
    return state?.config.enabled ?? false;
  }

  /**
   * Enable a monitor
   */
  enableMonitor(id: string): void {
    const state = this.monitors.get(id);
    if (state) {
      state.config.enabled = true;
    }
  }

  /**
   * Disable a monitor
   */
  disableMonitor(id: string): void {
    const state = this.monitors.get(id);
    if (state) {
      state.config.enabled = false;
    }
  }

  /**
   * Get current state of a monitor
   */
  getCurrentState(id: string): MonitorStateLevel {
    const state = this.monitors.get(id);
    return state?.currentState ?? 'normal';
  }

  /**
   * Get all active (enabled) monitors
   */
  getActiveMonitors(): ThresholdMonitorConfig[] {
    const activeMonitors: ThresholdMonitorConfig[] = [];
    for (const state of this.monitors.values()) {
      if (state.config.enabled) {
        activeMonitors.push(state.config);
      }
    }
    return activeMonitors;
  }

  /**
   * Get monitor statistics
   */
  getMonitorStats(id: string): MonitorStats {
    const state = this.monitors.get(id);
    if (!state) {
      return {
        totalChecks: 0,
        warningTriggerCount: 0,
        criticalTriggerCount: 0,
        actionExecutionCount: 0,
      };
    }
    return { ...state.stats };
  }

  /**
   * Check a value against monitor thresholds
   */
  checkValue(monitorId: string, value: any): ThresholdCheckResult {
    const state = this.monitors.get(monitorId);
    if (!state) {
      return {
        monitorId,
        state: 'normal',
        triggered: false,
        timestamp: new Date(),
      };
    }

    state.stats.totalChecks++;
    state.lastValue = value;
    const previousState = state.currentState;

    // Skip if disabled
    if (!state.config.enabled) {
      return {
        monitorId,
        state: 'normal',
        triggered: false,
        previousState,
        value,
        timestamp: new Date(),
      };
    }

    // Determine new state
    const newState = this.determineState(state.config, value, state);

    // Update state
    if (newState !== state.currentState) {
      state.currentState = newState;
      state.stats.lastStateChange = new Date();
      state.actionExecutedForCurrentState = false;

      // Update trigger counts
      if (newState === 'warning') {
        state.stats.warningTriggerCount++;
      } else if (newState === 'critical') {
        state.stats.criticalTriggerCount++;
      }
    }

    const triggered = newState !== 'normal' && newState !== previousState;
    const triggeredLevel = triggered
      ? (newState === 'critical' ? 'critical' : 'warning')
      : undefined;

    return {
      monitorId,
      state: newState,
      triggered,
      triggeredLevel,
      previousState,
      value,
      timestamp: new Date(),
    };
  }

  /**
   * Check value and execute action if threshold crossed
   */
  async checkAndExecute(monitorId: string, value: any): Promise<ThresholdCheckResult> {
    const result = this.checkValue(monitorId, value);
    const state = this.monitors.get(monitorId);

    if (!state || !result.triggered || !result.triggeredLevel) {
      return result;
    }

    // Check if we already executed action for this state
    if (state.actionExecutedForCurrentState) {
      return result;
    }

    // Execute the appropriate action
    const action = result.triggeredLevel === 'critical'
      ? state.config.criticalAction
      : state.config.warningAction;

    if (action && this.actionExecutor) {
      try {
        await this.actionExecutor(action, result.triggeredLevel);
        state.stats.actionExecutionCount++;
        state.stats.lastActionExecuted = new Date();
        state.actionExecutedForCurrentState = true;
      } catch (error) {
        // Log error but don't throw
        logger.error(`Action execution failed for monitor ${monitorId}:`, error);
      }
    }

    return result;
  }

  /**
   * Check all monitors for a specific device
   */
  async checkAllMonitorsForDevice(
    deviceId: string,
    deviceState: Record<string, any>
  ): Promise<ThresholdCheckResult[]> {
    const results: ThresholdCheckResult[] = [];

    for (const [id, state] of this.monitors) {
      if (!state.config.enabled || state.config.deviceId !== deviceId) {
        continue;
      }

      const parameter = state.config.parameter;
      if (parameter in deviceState) {
        const result = await this.checkAndExecute(id, deviceState[parameter]);
        if (result.triggered) {
          results.push(result);
        }
      }
    }

    return results;
  }

  /**
   * Determine the state based on thresholds and current state (for hysteresis)
   */
  private determineState(
    config: ThresholdMonitorConfig,
    value: any,
    state: MonitorState
  ): MonitorStateLevel {
    const { warningThreshold, criticalThreshold, hysteresis } = config;
    const currentState = state.currentState;

    // Check critical threshold first (higher priority)
    if (criticalThreshold && this.isThresholdCrossed(criticalThreshold, value)) {
      // Handle duration requirement
      if (criticalThreshold.duration) {
        if (state.durationLevel !== 'critical' || !state.durationStartTime) {
          state.durationStartTime = new Date();
          state.durationLevel = 'critical';
          return currentState; // Stay in current state until duration met
        }

        const elapsed = Date.now() - state.durationStartTime.getTime();
        if (elapsed < criticalThreshold.duration) {
          return currentState; // Duration not met yet
        }
      }

      state.durationStartTime = undefined;
      state.durationLevel = undefined;
      return 'critical';
    }

    // Check warning threshold
    if (warningThreshold && this.isThresholdCrossed(warningThreshold, value)) {
      // Handle duration requirement
      if (warningThreshold.duration) {
        if (state.durationLevel !== 'warning' || !state.durationStartTime) {
          state.durationStartTime = new Date();
          state.durationLevel = 'warning';
          return currentState; // Stay in current state until duration met
        }

        const elapsed = Date.now() - state.durationStartTime.getTime();
        if (elapsed < warningThreshold.duration) {
          return currentState; // Duration not met yet
        }
      }

      state.durationStartTime = undefined;
      state.durationLevel = undefined;
      return 'warning';
    }

    // Value is within normal range
    // Check hysteresis before returning to normal
    if (hysteresis && currentState !== 'normal') {
      const crossedThreshold = currentState === 'critical'
        ? criticalThreshold
        : warningThreshold;

      if (crossedThreshold && this.isWithinHysteresis(crossedThreshold, value, hysteresis)) {
        return currentState; // Stay in current state due to hysteresis
      }
    }

    // Reset duration tracking when returning to normal
    state.durationStartTime = undefined;
    state.durationLevel = undefined;
    return 'normal';
  }

  /**
   * Check if a threshold is crossed
   */
  private isThresholdCrossed(threshold: ThresholdLevel, value: any): boolean {
    return this.compareValues(value, threshold.operator, threshold.value);
  }

  /**
   * Check if value is within hysteresis range
   */
  private isWithinHysteresis(
    threshold: ThresholdLevel,
    value: any,
    hysteresis: number
  ): boolean {
    const { operator, value: thresholdValue } = threshold;

    switch (operator) {
      case '>':
      case '>=':
        // For "greater than" thresholds, value must drop below (threshold - hysteresis)
        return value > (thresholdValue - hysteresis);

      case '<':
      case '<=':
        // For "less than" thresholds, value must rise above (threshold + hysteresis)
        return value < (thresholdValue + hysteresis);

      default:
        return false;
    }
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
   * Clear all monitors
   */
  clearAllMonitors(): void {
    this.monitors.clear();
  }
}
