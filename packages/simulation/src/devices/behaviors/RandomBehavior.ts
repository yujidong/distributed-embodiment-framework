/**
 * Random Behavior
 *
 * Executes actions randomly with a given probability
 */

import type { BehaviorConfig } from '../types.js';

/**
 * Random behavior configuration
 */
export interface RandomBehaviorConfig extends BehaviorConfig {
  type: 'random';
  probability: number; // 0-1
  checkInterval?: number; // milliseconds, default 1000
  action: () => void | Promise<void>;
}

/**
 * Create a random behavior
 * @param probability - Probability of execution (0-1)
 * @param action - Action to execute
 * @param checkInterval - How often to check (default 1000ms)
 * @returns BehaviorConfig
 */
export function createRandomBehavior(
  probability: number,
  action: () => void | Promise<void>,
  checkInterval: number = 1000
): BehaviorConfig {
  return {
    type: 'random',
    probability,
    checkInterval,
    action,
  };
}
