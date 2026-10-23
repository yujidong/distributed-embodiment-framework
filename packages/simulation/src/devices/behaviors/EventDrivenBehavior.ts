/**
 * Event-Driven Behavior
 *
 * Executes actions when specific conditions are met
 */

import type { BehaviorConfig } from '../types.js';

/**
 * Event condition
 */
export interface EventCondition {
  property: string;
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte';
  value: any;
}

/**
 * Event-driven behavior configuration
 */
export interface EventDrivenBehaviorConfig extends BehaviorConfig {
  type: 'event-driven';
  conditions: EventCondition[];
  action: () => void | Promise<void>;
}

/**
 * Create an event-driven behavior
 * @param conditions - Conditions to check
 * @param action - Action to execute when conditions are met
 * @returns BehaviorConfig
 */
export function createEventDrivenBehavior(
  conditions: EventCondition[],
  action: () => void | Promise<void>
): BehaviorConfig {
  return {
    type: 'event-driven',
    conditions,
    action,
  };
}

/**
 * Check if conditions are met
 * @param conditions - Conditions to check
 * @param state - Current state
 * @returns True if all conditions are met
 */
export function checkConditions(conditions: EventCondition[], state: any): boolean {
  return conditions.every((condition) => {
    const stateValue = state[condition.property];

    switch (condition.operator) {
      case 'eq':
        return stateValue === condition.value;
      case 'ne':
        return stateValue !== condition.value;
      case 'gt':
        return stateValue > condition.value;
      case 'lt':
        return stateValue < condition.value;
      case 'gte':
        return stateValue >= condition.value;
      case 'lte':
        return stateValue <= condition.value;
      default:
        return false;
    }
  });
}
