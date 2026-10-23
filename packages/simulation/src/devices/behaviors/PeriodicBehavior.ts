/**
 * Periodic Behavior
 *
 * Executes actions at regular intervals
 */

import type { BehaviorConfig } from '../types.js';

/**
 * Periodic behavior configuration
 */
export interface PeriodicBehaviorConfig extends BehaviorConfig {
  type: 'periodic';
  interval: number; // milliseconds
  action: () => void | Promise<void>;
}

/**
 * Create a periodic behavior
 * @param config - Behavior configuration
 * @returns BehaviorConfig
 */
export function createPeriodicBehavior(
  interval: number,
  action: () => void | Promise<void>
): BehaviorConfig {
  return {
    type: 'periodic',
    interval,
    action,
  };
}
