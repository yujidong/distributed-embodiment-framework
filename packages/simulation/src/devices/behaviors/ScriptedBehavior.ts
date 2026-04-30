/**
 * Scripted Behavior
 *
 * Executes a predefined sequence of state changes
 */

import type { BehaviorConfig } from '../types.js';

/**
 * Script step
 */
export interface ScriptStep {
  state: Record<string, unknown>;
  delay?: number; // milliseconds to wait before next step
  action?: () => void | Promise<void>;
}

/**
 * Scripted behavior configuration
 */
export interface ScriptedBehaviorConfig extends BehaviorConfig {
  type: 'scripted';
  script: ScriptStep[];
  loop?: boolean; // Whether to repeat the script
}

/**
 * Create a scripted behavior
 * @param script - Array of script steps
 * @param loop - Whether to loop the script (default false)
 * @returns BehaviorConfig
 */
export function createScriptedBehavior(
  script: ScriptStep[],
  loop: boolean = false
): BehaviorConfig {
  return {
    type: 'scripted',
    script,
    loop,
  };
}

/**
 * Create a simple on/off script
 * @param propertyName - Property to toggle
 * @param interval - Interval between toggles (ms)
 * @param steps - Number of on/off cycles
 * @returns Script array
 */
export function createToggleScript(
  propertyName: string,
  interval: number,
  steps: number = 10
): ScriptStep[] {
  const script: ScriptStep[] = [];

  for (let i = 0; i < steps; i++) {
    script.push({
      state: { [propertyName]: true },
      delay: interval,
    });
    script.push({
      state: { [propertyName]: false },
      delay: interval,
    });
  }

  return script;
}
