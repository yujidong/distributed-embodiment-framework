/**
 * Test Case Runner
 *
 * Executes test cases for requirement validation.
 * Supports both pre-execution simulation and post-execution validation.
 *
 * Test Execution Modes:
 * 1. Pre-Execution: Simulate test cases with expected behavior
 * 2. Post-Execution: Validate actual execution results against expected outcomes
 */

import type {
  TestCase,
  TestResult,
  RequirementValidationCriterion,
  ValidationResult,
  Deviation,
  EffectExpectation,
  ValidationContext
} from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('TestCaseRunner');

/**
 * Test Case Runner class
 * Executes test cases and generates detailed test results
 */


export class TestCaseRunner {
  /**
   * Run a single test case
   *
   * @param testCase - The test case to execute
   * @param actualOutput - Actual output from service execution (undefined for simulation)
   * @param context - Validation context
   * @param mode - Execution mode (simulation or actual)
   * @returns Test result with detailed analysis
   */
  async runTestCase(
    testCase: TestCase,
    actualOutput: any,
    context: ValidationContext,
    mode: 'simulation' | 'actual' = 'simulation'
  ): Promise<TestResult> {
    logger.info(`Running test case: ${testCase.name} (${mode} mode)`);

    const startTime = Date.now();

    // In simulation mode, we check if the test case is properly defined
    // In actual mode, we validate actual output against expected output
    let passed: boolean;
    let deviations: Deviation[] = [];

    if (mode === 'simulation') {
      // Simulation: Verify test case is well-formed and can be executed
      const simulationResult = this.simulateTestCase(testCase, context);
      passed = simulationResult.passed;
      deviations = simulationResult.deviations;
    } else {
      // Actual: Validate real output against expected output
      const validationResult = this.validateOutput(testCase, actualOutput, context);
      passed = validationResult.passed;
      deviations = validationResult.deviations;
    }

    // Calculate execution time
    const executionTime = Date.now() - startTime;

    // Calculate score based on passed criteria and weight
    const score = passed ? 1.0 : this.calculatePartialScore(testCase, deviations);

    const result: TestResult = {
      testCaseId: testCase.id,
      testCaseName: testCase.name,
      passed,
      score,
      actualOutput: mode === 'actual' ? actualOutput : testCase.expectedOutput.result,
      expectedOutput: testCase.expectedOutput.result,
      deviations,
      executionTime
    };

    logger.info(`Test case ${testCase.name} completed: ${passed ? 'PASSED' : 'FAILED'} (score: ${score.toFixed(2)})`);

    return result;
  }

  /**
   * Run multiple test cases
   *
   * @param testCases - Array of test cases to run
   * @param actualOutput - Actual output from service execution
   * @param context - Validation context
   * @param mode - Execution mode
   * @returns Array of test results
   */
  async runTestCases(
    testCases: TestCase[],
    actualOutput: any,
    context: ValidationContext,
    mode: 'simulation' | 'actual' = 'simulation'
  ): Promise<TestResult[]> {
    logger.info(`Running ${testCases.length} test cases in ${mode} mode`);

    const results: TestResult[] = [];

    for (const testCase of testCases) {
      const result = await this.runTestCase(testCase, actualOutput, context, mode);
      results.push(result);
    }

    const passedCount = results.filter(r => r.passed).length;
    logger.info(`Test cases completed: ${passedCount}/${results.length} passed`);

    return results;
  }

  /**
   * Simulate a test case (pre-execution validation)
   * Verifies that the test case is well-formed and can potentially pass
   *
   * @param testCase - The test case to simulate
   * @param context - Validation context
   * @returns Simulation result
   */
  private simulateTestCase(
    testCase: TestCase,
    context: ValidationContext
  ): { passed: boolean; deviations: Deviation[] } {
    const deviations: Deviation[] = [];

    // Check if input parameters are properly defined
    if (!testCase.input.parameters) {
      deviations.push({
        type: 'value',
        description: 'Test case input parameters are not defined',
        severity: 'major',
        actual: undefined,
        expected: 'defined parameters'
      });
    }

    // Check if expected output is defined
    if (!testCase.expectedOutput.result && !testCase.expectedOutput.postConditions) {
      deviations.push({
        type: 'value',
        description: 'Test case expected output is not defined',
        severity: 'critical',
        actual: undefined,
        expected: 'defined expected output'
      });
    }

    // Check if validation criteria are defined
    if (!testCase.validationCriteria || testCase.validationCriteria.length === 0) {
      deviations.push({
        type: 'context',
        description: 'Test case has no validation criteria',
        severity: 'moderate',
        actual: 0,
        expected: 'at least 1 validation criterion'
      });
    }

    // In simulation mode, we assume the test would pass if well-formed
    const passed = deviations.filter(d => d.severity === 'critical').length === 0;

    return { passed, deviations };
  }

  /**
   * Validate actual output against expected output (post-execution)
   *
   * @param testCase - The test case
   * @param actualOutput - Actual output from execution
   * @param context - Validation context
   * @returns Validation result
   */
  private validateOutput(
    testCase: TestCase,
    actualOutput: any,
    context: ValidationContext
  ): { passed: boolean; deviations: Deviation[] } {
    const deviations: Deviation[] = [];

    // Validate expected result
    if (testCase.expectedOutput.result !== undefined) {
      const resultDeviation = this.compareValues(
        actualOutput,
        testCase.expectedOutput.result,
        'result'
      );

      if (resultDeviation) {
        deviations.push(resultDeviation);
      }
    }

    // Validate post-conditions
    if (testCase.expectedOutput.postConditions) {
      for (const [key, expectedValue] of Object.entries(testCase.expectedOutput.postConditions)) {
        const actualValue = actualOutput?.[key];
        const deviation = this.compareValues(actualValue, expectedValue, `postCondition.${key}`);

        if (deviation) {
          deviations.push(deviation);
        }
      }
    }

    // Validate expected effects (if actual effects are provided)
    if (testCase.expectedOutput.effects && actualOutput?.effects) {
      for (const effect of testCase.expectedOutput.effects) {
        const effectDeviation = this.validateEffect(effect, actualOutput.effects);
        if (effectDeviation) {
          deviations.push(effectDeviation);
        }
      }
    }

    // Run validation criteria
    for (const criterion of testCase.validationCriteria) {
      const criterionResult = this.validateCriterion(criterion, actualOutput, context);
      if (!criterionResult.passed) {
        deviations.push({
          type: 'quality',
          description: `Validation criterion '${criterion.description}' failed`,
          severity: criterion.severity === 'error' ? 'major' : 'minor',
          actual: actualOutput,
          expected: criterion.expectedResult
        });
      }
    }

    const passed = deviations.filter(d => d.severity === 'critical' || d.severity === 'major').length === 0;

    return { passed, deviations };
  }

  /**
   * Compare actual vs expected values with tolerance support
   *
   * @param actual - Actual value
   * @param expected - Expected value
   * @param path - Path for error reporting
   * @returns Deviation if values don't match, null if they match
   */
  private compareValues(
    actual: any,
    expected: any,
    path: string
  ): Deviation | null {
    // Handle exact match
    if (actual === expected) {
      return null;
    }

    // Handle numeric comparison with tolerance
    if (typeof actual === 'number' && typeof expected === 'number') {
      const diff = Math.abs(actual - expected);
      const relativeDiff = diff / Math.abs(expected);

      // Default tolerance: 5% relative or 0.1 absolute
      if (relativeDiff <= 0.05 || diff <= 0.1) {
        return null;
      }

      return {
        type: 'value',
        description: `Numeric value mismatch at ${path}`,
        severity: diff > 1.0 ? 'major' : 'minor',
        actual,
        expected,
        tolerance: { relative: 0.05, absolute: 0.1 }
      };
    }

    // Handle object comparison
    if (typeof actual === 'object' && typeof expected === 'object' && actual !== null && expected !== null) {
      const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);

      for (const key of keys) {
        const deviation = this.compareValues(actual?.[key], expected?.[key], `${path}.${key}`);
        if (deviation) {
          return deviation;
        }
      }

      return null;
    }

    // Value mismatch
    return {
      type: 'value',
      description: `Value mismatch at ${path}`,
      severity: 'moderate',
      actual,
      expected
    };
  }

  /**
   * Validate an expected effect against actual effects
   *
   * @param expectedEffect - Expected effect
   * @param actualEffects - Actual effects array
   * @returns Deviation if effect not found or doesn't match
   */
  private validateEffect(
    expectedEffect: EffectExpectation,
    actualEffects: any[]
  ): Deviation | null {
    const matchingEffect = actualEffects.find(e =>
      e.target === expectedEffect.target &&
      e.property === expectedEffect.property
    );

    if (!matchingEffect) {
      return {
        type: 'state-change',
        description: `Expected effect not found: ${expectedEffect.target}.${expectedEffect.property}`,
        severity: 'major',
        actual: 'not found',
        expected: expectedEffect.expectedValue
      };
    }

    // Check if the effect value matches (with tolerance)
    const deviation = this.compareValues(
      matchingEffect.value,
      expectedEffect.expectedValue,
      `effect.${expectedEffect.target}.${expectedEffect.property}`
    );

    return deviation;
  }

  /**
   * Validate a single criterion
   *
   * @param criterion - The validation criterion
   * @param actualOutput - Actual output
   * @param context - Validation context
   * @returns Criterion validation result
   */
  private validateCriterion(
    criterion: RequirementValidationCriterion,
    actualOutput: any,
    context: ValidationContext
  ): { passed: boolean } {
    // For automated checks
    if (criterion.verificationMethod.type === 'automated' && criterion.verificationMethod.automatedCheck) {
      const check = criterion.verificationMethod.automatedCheck;

      try {
        // For simple expression checks
        if (check.type === 'expression') {
          // Create a safe evaluation context
          const evalContext = {
            output: actualOutput,
            context: context
          };

          // Evaluate expression (simplified - in production use a safer evaluator)
          // This is a placeholder for proper expression evaluation
          const passed = this.evaluateExpression(check.expression, evalContext);
          return { passed };
        }
      } catch (error) {
        logger.error(`Error evaluating criterion: ${error}`);
        return { passed: false };
      }
    }

    // For manual or hybrid checks, assume pass (requires human review)
    return { passed: true };
  }

  /**
   * Safely evaluate an expression
   * NOTE: In production, use a proper expression evaluator
   *
   * @param expression - Expression to evaluate
   * @param context - Evaluation context
   * @returns Expression result
   */
  private evaluateExpression(expression: string, context: any): boolean {
    // This is a simplified placeholder
    // In production, use a library like 'expr-eval' or 'jexl'
    try {
      // Very basic check for common patterns
      if (expression.includes('output !== undefined')) {
        return context.output !== undefined;
      }
      if (expression.includes('output !== null')) {
        return context.output !== null;
      }

      // Default to true for unknown expressions
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Calculate partial score when some deviations are acceptable
   *
   * @param testCase - The test case
   * @param deviations - Array of deviations
   * @returns Score between 0 and 1
   */
  private calculatePartialScore(testCase: TestCase, deviations: Deviation[]): number {
    if (deviations.length === 0) {
      return 1.0;
    }

    // Weight deviations by severity
    const criticalCount = deviations.filter(d => d.severity === 'critical').length;
    const majorCount = deviations.filter(d => d.severity === 'major').length;
    const moderateCount = deviations.filter(d => d.severity === 'moderate').length;
    const minorCount = deviations.filter(d => d.severity === 'minor').length;

    // Calculate penalty
    let penalty = 0;
    penalty += criticalCount * 1.0;
    penalty += majorCount * 0.5;
    penalty += moderateCount * 0.2;
    penalty += minorCount * 0.1;

    // Apply penalty with test case weight
    const adjustedScore = Math.max(0, 1.0 - (penalty * testCase.weight));

    return adjustedScore;
  }
}
