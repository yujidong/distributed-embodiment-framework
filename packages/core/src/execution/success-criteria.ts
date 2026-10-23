/**
 * AC success-criteria condition helpers (R102 arch-guard extraction from
 * ACExecutor.ts — behavior verbatim): the legacy condition-string
 * evaluation, the condition→(parameter, target, direction) parse, and the
 * goal-description target inference used by the Monitor/Verify phases.
 * Logger stays — execution/ is not the L2 pure layer (that purity guard is
 * scoped to runtime/shaping).
 */

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ACSuccessCriteria');

/** Legacy condition-string evaluation ("a == b", "x > 25", …). */
export function evaluateCondition(value: unknown, condition: string): boolean {
  // Simple condition evaluation
  // In production, this would be more sophisticated

  try {
    // Handle basic comparisons
    if (condition.includes('==')) {
      const [, actual] = condition.split('==').map((s) => s.trim().replace(/['"]/g, ''));
      return String(value) === actual;
    }

    if (condition.includes('!=')) {
      const [, actual] = condition.split('!=').map((s) => s.trim().replace(/['"]/g, ''));
      return String(value) !== actual;
    }

    if (condition.includes('>')) {
      const [, threshold] = condition.split('>').map((s) => s.trim());
      return Number(value) > Number(threshold);
    }

    if (condition.includes('<')) {
      const [, threshold] = condition.split('<').map((s) => s.trim());
      return Number(value) < Number(threshold);
    }

    // Default: check if value matches condition
    return String(value) === condition;
  } catch (error) {
    logger.warn(`Condition evaluation error:`, error);
    return false;
  }
}

/** Match patterns like: "temperature < 25", "humidity >= 40", "temp == 24". */
export function parseConditionForTarget(
  condition: string,
): { parameter: string; targetValue: number; direction: 'below' | 'above' } | undefined {
  const match = condition.match(/(\w+)\s*(<|<=|>|>=|==)\s*(\d+\.?\d*)/);
  if (match) {
    const parameter = match[1];
    const operator = match[2];
    const targetValue = parseFloat(match[3]);
    const direction = (operator === '<' || operator === '<=') ? 'below' : 'above';
    return { parameter, targetValue, direction };
  }

  // Match patterns like: "< 25", ">= 40"
  const simpleMatch = condition.match(/^(<|<=|>|>=|==)\s*(\d+\.?\d*)$/);
  if (simpleMatch) {
    const operator = simpleMatch[1];
    const targetValue = parseFloat(simpleMatch[2]);
    const direction = (operator === '<' || operator === '<=') ? 'below' : 'above';
    return { parameter: '', targetValue, direction };
  }

  return undefined;
}

/**
 * Infer target value from goal description.
 * Looks for temperature/humidity targets in the description text.
 */
export function inferTargetFromGoalDescription(
  description: string,
): { parameter: string; targetValue: number; direction: 'below' | 'above' } | undefined {
  // Look for cooling patterns: "reduce temperature to X", "cool to X"
  const coolMatch = description.match(/(?:cool|reduce|lower|temperature\s+to)\s+(\d+\.?\d*)/i);
  if (coolMatch) {
    return { parameter: 'temperature', targetValue: parseFloat(coolMatch[1]), direction: 'below' };
  }

  // Look for heating patterns: "heat to X", "warm to X"
  const heatMatch = description.match(/(?:heat|warm|increase|raise)\s+(?:temperature\s+)?(?:to\s+)?(\d+\.?\d*)/i);
  if (heatMatch) {
    return { parameter: 'temperature', targetValue: parseFloat(heatMatch[1]), direction: 'above' };
  }

  // Look for generic "to X°C" or "to X°" patterns
  const degreeMatch = description.match(/to\s+(\d+\.?\d*)\s*°?C/i);
  if (degreeMatch) {
    return { parameter: 'temperature', targetValue: parseFloat(degreeMatch[1]), direction: 'below' };
  }

  return undefined;
}
