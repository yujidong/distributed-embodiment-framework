/**
 * State Interpolator
 *
 * Provides smooth interpolation between physics updates.
 * Handles linear interpolation and exponential smoothing for realistic sensor readings.
 */

import type { PhysicalParameter, DeviceLocation } from '../devices/types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * State snapshot at a specific time
 */
const logger = createLogger('StateInterpolator');

export interface StateSnapshot {
  value: number | boolean;
  timestamp: Date;
  velocity?: number; // Rate of change (for extrapolation)
}

/**
 * Interpolation configuration
 */
export interface InterpolationConfig {
  enableLinearInterpolation?: boolean;
  enableExponentialSmoothing?: boolean;
  smoothingFactor?: number; // 0-1, where lower = more smoothing
  maxExtrapolationTime?: number; // Maximum time to extrapolate beyond last snapshot (ms)
}

/**
 * State history for a location and parameter
 */
export interface StateHistory {
  location: string;
  parameter: PhysicalParameter;
  snapshots: StateSnapshot[];
  maxHistorySize: number;
}

/**
 * State Interpolator Class
 *
 * Maintains state history and provides interpolated values between physics updates.
 */
export class StateInterpolator {
  private stateHistory: Map<string, StateHistory>; // Key: "location:parameter"
  private config: Required<InterpolationConfig>;

  constructor(config: InterpolationConfig = {}) {
    // Default configuration values
    const defaults = {
      enableLinearInterpolation: true,
      enableExponentialSmoothing: false,
      smoothingFactor: 0.3, // 30% new value, 70% old value (moderate smoothing)
      maxExtrapolationTime: 5000, // 5 seconds max extrapolation
    };

    this.config = {
      enableLinearInterpolation: config.enableLinearInterpolation ?? defaults.enableLinearInterpolation,
      enableExponentialSmoothing: config.enableExponentialSmoothing ?? defaults.enableExponentialSmoothing,
      smoothingFactor: config.smoothingFactor ?? defaults.smoothingFactor,
      maxExtrapolationTime: config.maxExtrapolationTime ?? defaults.maxExtrapolationTime,
    };
    this.stateHistory = new Map();

    logger.info('Initialized with config:', this.config);
  }

  /**
   * Record a state snapshot for interpolation
   * @param location - Device location
   * @param parameter - Physical parameter
   * @param value - Parameter value
   * @param timestamp - Snapshot timestamp (default: current time)
   * @param velocity - Rate of change (optional, for extrapolation)
   */
  recordState(
    location: DeviceLocation | string,
    parameter: PhysicalParameter,
    value: number | boolean,
    timestamp?: Date,
    velocity?: number
  ): void {
    const locationStr = this.normalizeLocation(location);
    const key = `${locationStr}:${parameter}`;
    const snapshotTime = timestamp || new Date();

    // Get or create state history
    let history = this.stateHistory.get(key);
    if (!history) {
      history = {
        location: locationStr,
        parameter,
        snapshots: [],
        maxHistorySize: 10, // Keep last 10 snapshots
      };
      this.stateHistory.set(key, history);
    }

    // Add snapshot
    const snapshot: StateSnapshot = {
      value,
      timestamp: snapshotTime,
      velocity,
    };
    history.snapshots.push(snapshot);

    // Trim history if needed
    if (history.snapshots.length > history.maxHistorySize) {
      history.snapshots = history.snapshots.slice(-history.maxHistorySize);
    }

    // Calculate velocity if not provided
    if (velocity === undefined && history.snapshots.length >= 2) {
      const prev = history.snapshots[history.snapshots.length - 2];
      const curr = history.snapshots[history.snapshots.length - 1];

      if (
        typeof curr.value === 'number' &&
        typeof prev.value === 'number' &&
        curr.timestamp !== prev.timestamp
      ) {
        const timeDiff = (curr.timestamp.getTime() - prev.timestamp.getTime()) / 1000; // seconds
        if (timeDiff > 0) {
          curr.velocity = (curr.value - prev.value) / timeDiff;
        }
      }
    }

    logger.info(`Recorded state: ${key} = ${value} at ${snapshotTime.toISOString()}`);
  }

  /**
   * Get interpolated value for a location and parameter at a specific time
   * @param location - Device location
   * @param parameter - Physical parameter
   * @param targetTime - Target time for interpolation (default: current time)
   * @returns Interpolated value or null if no history available
   */
  interpolate(
    location: DeviceLocation | string,
    parameter: PhysicalParameter,
    targetTime?: Date
  ): number | boolean | null {
    const locationStr = this.normalizeLocation(location);
    const key = `${locationStr}:${parameter}`;
    const time = targetTime || new Date();

    const history = this.stateHistory.get(key);
    if (!history || history.snapshots.length === 0) {
      logger.warn(`No history for ${key}`);
      return null;
    }

    // If only one snapshot, return it
    if (history.snapshots.length === 1) {
      return history.snapshots[0].value;
    }

    // Find surrounding snapshots
    const beforeIndex = this.findSnapshotBefore(history, time);
    const afterIndex = this.findSnapshotAfter(history, time);

    // Exact match found
    if (beforeIndex === afterIndex && beforeIndex !== -1) {
      return history.snapshots[beforeIndex].value;
    }

    // Both before and after snapshots exist - interpolate
    if (beforeIndex !== -1 && afterIndex !== -1) {
      const before = history.snapshots[beforeIndex];
      const after = history.snapshots[afterIndex];

      if (this.config.enableLinearInterpolation && typeof before.value === 'number' && typeof after.value === 'number') {
        return this.linearInterpolate(before.value, after.value, this.calculateProgress(before.timestamp, after.timestamp, time));
      } else {
        // No interpolation, return closest value
        return before.value;
      }
    }

    // Only before snapshot exists - extrapolate
    if (beforeIndex !== -1) {
      const snapshot = history.snapshots[beforeIndex];
      const timeDiff = time.getTime() - snapshot.timestamp.getTime();

      if (timeDiff > this.config.maxExtrapolationTime) {
        logger.warn(`Extrapolation time exceeded for ${key}`);
        return snapshot.value;
      }

      if (this.config.enableLinearInterpolation && typeof snapshot.value === 'number' && snapshot.velocity !== undefined) {
        const extrapolatedValue = snapshot.value + snapshot.velocity * (timeDiff / 1000);
        logger.info(`Extrapolating ${key}: ${snapshot.value} -> ${extrapolatedValue}`);
        return extrapolatedValue;
      }

      return snapshot.value;
    }

    // Only after snapshot exists - future time, return it
    if (afterIndex !== -1) {
      return history.snapshots[afterIndex].value;
    }

    logger.warn(`Unable to interpolate ${key}`);
    return null;
  }

  /**
   * Apply exponential smoothing to a value
   * @param location - Device location
   * @param parameter - Physical parameter
   * @param newValue - New value to smooth
   * @returns Smoothed value
   */
  applySmoothing(
    location: DeviceLocation | string,
    parameter: PhysicalParameter,
    newValue: number
  ): number {
    if (!this.config.enableExponentialSmoothing) {
      return newValue;
    }

    const locationStr = this.normalizeLocation(location);
    const key = `${locationStr}:${parameter}`;

    const history = this.stateHistory.get(key);
    if (!history || history.snapshots.length === 0) {
      return newValue;
    }

    const lastValue = history.snapshots[history.snapshots.length - 1].value;

    if (typeof lastValue !== 'number') {
      return newValue;
    }

    // Exponential smoothing: smoothed = α * new + (1 - α) * old
    const smoothedValue = this.exponentialSmooth(lastValue, newValue, this.config.smoothingFactor);

    logger.info(`Smoothed ${key}: ${lastValue} + ${newValue} -> ${smoothedValue}`);

    return smoothedValue;
  }

  /**
   * Get state history for a location and parameter
   * @param location - Device location
   * @param parameter - Physical parameter
   * @returns State history or null
   */
  getHistory(location: DeviceLocation | string, parameter: PhysicalParameter): StateHistory | null {
    const locationStr = this.normalizeLocation(location);
    const key = `${locationStr}:${parameter}`;
    return this.stateHistory.get(key) || null;
  }

  /**
   * Clear state history for a location and parameter
   * @param location - Device location
   * @param parameter - Physical parameter
   */
  clearHistory(location: DeviceLocation | string, parameter: PhysicalParameter): void {
    const locationStr = this.normalizeLocation(location);
    const key = `${locationStr}:${parameter}`;
    this.stateHistory.delete(key);
    logger.info(`Cleared history for ${key}`);
  }

  /**
   * Clear all state history
   */
  clearAllHistory(): void {
    this.stateHistory.clear();
    logger.info('Cleared all history');
  }

  /**
   * Get statistics about state history
   */
  getStats(): {
    totalTrackedStates: number;
    totalSnapshots: number;
    averageSnapshotsPerState: number;
  } {
    const totalTrackedStates = this.stateHistory.size;
    const totalSnapshots = Array.from(this.stateHistory.values()).reduce((sum, h) => sum + h.snapshots.length, 0);
    const averageSnapshotsPerState = totalTrackedStates > 0 ? totalSnapshots / totalTrackedStates : 0;

    return {
      totalTrackedStates,
      totalSnapshots,
      averageSnapshotsPerState,
    };
  }

  /**
   * Normalize location to string
   */
  private normalizeLocation(location: DeviceLocation | string): string {
    if (typeof location === 'string') {
      return location;
    }
    return location?.path || 'unknown';
  }

  /**
   * Linear interpolation between two values
   * @param value1 - First value
   * @param value2 - Second value
   * @param t - Progress (0-1)
   * @returns Interpolated value
   */
  private linearInterpolate(value1: number, value2: number, t: number): number {
    return value1 + (value2 - value1) * t;
  }

  /**
   * Exponential smoothing
   * @param oldValue - Old value
   * @param newValue - New value
   * @param alpha - Smoothing factor (0-1)
   * @returns Smoothed value
   */
  private exponentialSmooth(oldValue: number, newValue: number, alpha: number): number {
    return alpha * newValue + (1 - alpha) * oldValue;
  }

  /**
   * Calculate progress between two timestamps
   * @param before - Before timestamp
   * @param after - After timestamp
   * @param current - Current timestamp
   * @returns Progress (0-1)
   */
  private calculateProgress(before: Date, after: Date, current: Date): number {
    const beforeTime = before.getTime();
    const afterTime = after.getTime();
    const currentTime = current.getTime();

    if (afterTime === beforeTime) {
      return 0;
    }

    const t = (currentTime - beforeTime) / (afterTime - beforeTime);
    return Math.max(0, Math.min(1, t)); // Clamp to [0, 1]
  }

  /**
   * Find snapshot before or at target time
   */
  private findSnapshotBefore(history: StateHistory, time: Date): number {
    for (let i = history.snapshots.length - 1; i >= 0; i--) {
      if (history.snapshots[i].timestamp <= time) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Find snapshot after or at target time
   */
  private findSnapshotAfter(history: StateHistory, time: Date): number {
    for (let i = 0; i < history.snapshots.length; i++) {
      if (history.snapshots[i].timestamp >= time) {
        return i;
      }
    }
    return -1;
  }
}
