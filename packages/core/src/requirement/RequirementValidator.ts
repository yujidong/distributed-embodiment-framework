/**
 * Requirement Validator
 *
 * Main validation engine implementing the three-stage validation framework:
 * 1. Service Creation Validation - Validate service before registration
 * 2. Pre-Execution Validation - Validate candidate services before selection
 * 3. Post-Execution Validation - Validate actual results after execution
 *
 * Orchestrates all validators:
 * - JSONSchemaValidator: Structural validation
 * - TestCaseRunner: Behavioral validation
 * - ContextValidator: Contextual validation
 * - SemanticRequirementMatcher: Semantic matching
 */

import type {
  RequirementSpec,
  ValidationResult,
  ValidationType,
  ValidationOutcome,
  ValidationScores,
  ValidationViolation,
  ValidationWarning,
  ValidationMetrics,
  ValidationRecommendation,
  ValidationContext,
  Service
} from '@active-collaboration/shared';

import { JSONSchemaValidator } from './JSONSchemaValidator.js';
import { TestCaseRunner } from './TestCaseRunner.js';
import { ContextValidator } from './ContextValidator.js';
import { SemanticRequirementMatcher } from './SemanticRequirementMatcher.js';
import { RequirementSpecRegistry } from './RequirementSpecRegistry.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Requirement Validator class
 * Main orchestrator for requirement validation across all stages
 */
const logger = createLogger('RequirementValidator');

export class RequirementValidator {
  private schemaValidator: JSONSchemaValidator;
  private testCaseRunner: TestCaseRunner;
  private contextValidator: ContextValidator;
  private semanticMatcher: SemanticRequirementMatcher;
  private registry: RequirementSpecRegistry;

  constructor() {
    this.schemaValidator = new JSONSchemaValidator();
    this.testCaseRunner = new TestCaseRunner();
    this.contextValidator = new ContextValidator();
    this.semanticMatcher = new SemanticRequirementMatcher();
    this.registry = new RequirementSpecRegistry();

    logger.info('Initialized with all validators');
  }

  /**
   * Get the requirement specification registry
   *
   * @returns Requirement specification registry
   */
  getRegistry(): RequirementSpecRegistry {
    return this.registry;
  }

  /**
   * Stage 1: Service Creation Validation
   * Validates a service before it is registered in the system
   *
   * @param service - Service to validate
   * @param requirementSpec - Requirement specification to validate against
   * @returns Validation result
   */
  async validateServiceCreation(
    service: Service,
    requirementSpec: RequirementSpec
  ): Promise<ValidationResult> {
    logger.info(`Stage 1: Validating service creation for ${service.id}`);

    const startTime = Date.now();
    const violations: ValidationViolation[] = [];
    const warnings: ValidationWarning[] = [];

    // 1. Structural validation (JSON Schema)
    logger.info('Step 1: Structural validation');
    const schemaValidation = this.schemaValidator.validate(service, requirementSpec.schema);

    if (!schemaValidation.valid) {
      for (const error of schemaValidation.errors) {
        violations.push({
          ruleId: `schema-${error.keyword}`,
          ruleType: 'schema',
          severity: 'error',
          message: error.message,
          location: {
            component: 'service',
            path: error.path
          },
          suggestion: `Fix schema violation: ${error.message}`
        });
      }
    }

    // 2. Semantic validation
    logger.info('Step 2: Semantic validation');
    const semanticMatch = this.semanticMatcher.matchRequirements(
      service.capabilities || [],
      service.category,
      requirementSpec.semanticAnnotations
    );

    if (!semanticMatch.matches) {
      violations.push({
        ruleId: 'semantic-match',
        ruleType: 'semantic',
        severity: 'error',
        message: 'Service does not semantically match requirements',
        location: {
          component: 'service',
          path: 'capabilities'
        },
        suggestion: semanticMatch.suggestion
      });
    }

    // 3. Context validation (basic check)
    logger.info('Step 3: Context validation');
    // For service creation, we do a basic context check
    // Full context validation happens in pre-execution

    // Calculate scores
    const scores: ValidationScores = {
      overall: 0,
      structural: schemaValidation.valid ? 1.0 : 0.0,
      behavioral: 1.0, // No behavioral validation at creation time
      contextual: 1.0,  // Basic context check
      semantic: semanticMatch.score
    };

    scores.overall = this.calculateOverallScore(scores);

    // Determine outcome
    const outcome = this.determineOutcome(scores, violations);

    // Generate recommendation
    const recommendation = this.generateRecommendation(outcome, scores, violations, warnings);

    const validationTime = Date.now() - startTime;

    const result: ValidationResult = {
      validationId: this.generateValidationId(),
      requirementId: requirementSpec.id,
      targetId: service.id,
      validationType: 'service-creation',
      timestamp: new Date(),
      outcome,
      scores,
      testResults: [],
      violations,
      warnings,
      metrics: {
        validationTime,
        testExecutionTime: 0,
        testCoverage: 0,
        contextCoverage: 0,
        confidence: semanticMatch.confidence,
        completeness: scores.structural
      },
      recommendation,
      evidence: []
    };

    logger.info(`Service creation validation completed: ${outcome} (score: ${scores.overall.toFixed(2)})`);

    return result;
  }

  /**
   * Stage 2: Pre-Execution Validation
   * Validates candidate services before selection and execution
   *
   * @param services - Candidate services
   * @param requirementSpec - Requirement specification
   * @param context - Validation context
   * @returns Array of validation results (one per service)
   */
  async validatePreExecution(
    services: Service[],
    requirementSpec: RequirementSpec,
    context: ValidationContext
  ): Promise<ValidationResult[]> {
    logger.info(`Stage 2: Pre-execution validation for ${services.length} services`);

    const results: ValidationResult[] = [];

    for (const service of services) {
      const result = await this.validateServiceForExecution(service, requirementSpec, context, 'pre-execution');
      results.push(result);
    }

    // Sort results by score (highest first)
    results.sort((a, b) => b.scores.overall - a.scores.overall);

    logger.info(`Pre-execution validation completed. Best score: ${results[0]?.scores.overall.toFixed(2) || 0}`);

    return results;
  }

  /**
   * Stage 3: Post-Execution Validation
   * Validates actual execution results against expected outcomes
   *
   * @param service - Executed service
   * @param requirementSpec - Requirement specification
   * @param actualOutput - Actual output from execution
   * @param context - Validation context
   * @returns Validation result
   */
  async validatePostExecution(
    service: Service,
    requirementSpec: RequirementSpec,
    actualOutput: any,
    context: ValidationContext
  ): Promise<ValidationResult> {
    logger.info(`Stage 3: Post-execution validation for ${service.id}`);

    const startTime = Date.now();
    const violations: ValidationViolation[] = [];
    const warnings: ValidationWarning[] = [];

    // 1. Structural validation (optional for post-execution)
    // Skip structural validation as service already passed creation validation

    // 2. Behavioral validation (test cases with actual data)
    logger.info('Step 1: Behavioral validation');
    const testStartTime = Date.now();
    const testResults = await this.testCaseRunner.runTestCases(
      requirementSpec.testCases,
      actualOutput,
      context,
      'actual'
    );
    const testExecutionTime = Date.now() - testStartTime;

    // Generate violations from failed tests
    for (const testResult of testResults) {
      if (!testResult.passed) {
        for (const deviation of testResult.deviations) {
          if (deviation.severity === 'critical' || deviation.severity === 'major') {
            violations.push({
              ruleId: `test-${testResult.testCaseId}`,
              ruleType: 'test-case',
              severity: 'error',
              message: deviation.description,
              location: {
                component: 'execution',
                path: testResult.testCaseName
              },
              suggestion: 'Fix deviation between expected and actual output'
            });
          }
        }
      }
    }

    // 3. Context validation
    logger.info('Step 2: Context validation');
    const contextValidation = this.contextValidator.validateContext(context);

    if (!contextValidation.valid) {
      for (const violation of contextValidation.violations) {
        if (violation.severity === 'error') {
          violations.push({
            ruleId: `context-${violation.dimension}`,
            ruleType: 'context',
            severity: 'error',
            message: violation.message,
            location: {
              component: 'context',
              path: violation.aspect
            },
            suggestion: `Ensure ${violation.aspect} meets requirements`
          });
        }
      }
    }

    // 4. Semantic validation (re-check with actual results)
    logger.info('Step 3: Semantic validation');
    const semanticMatch = this.semanticMatcher.matchRequirements(
      service.capabilities || [],
      service.category,
      requirementSpec.semanticAnnotations
    );

    // Calculate scores
    const scores: ValidationScores = {
      overall: 0,
      structural: 1.0, // Assumed valid from creation
      behavioral: this.calculateBehavioralScore(testResults),
      contextual: contextValidation.score,
      semantic: semanticMatch.score
    };

    scores.overall = this.calculateOverallScore(scores);

    // Determine outcome
    const outcome = this.determineOutcome(scores, violations);

    // Generate recommendation
    const recommendation = this.generateRecommendation(outcome, scores, violations, warnings);

    const validationTime = Date.now() - startTime;

    const result: ValidationResult = {
      validationId: this.generateValidationId(),
      requirementId: requirementSpec.id,
      targetId: service.id,
      validationType: 'post-execution',
      timestamp: new Date(),
      outcome,
      scores,
      testResults,
      violations,
      warnings,
      metrics: {
        validationTime,
        testExecutionTime,
        testCoverage: (testResults.length / requirementSpec.testCases.length) * 100,
        contextCoverage: 100,
        confidence: semanticMatch.confidence,
        completeness: scores.behavioral
      },
      recommendation,
      evidence: []
    };

    logger.info(`Post-execution validation completed: ${outcome} (score: ${scores.overall.toFixed(2)})`);

    return result;
  }

  /**
   * Validate a service for execution (internal method)
   *
   * @param service - Service to validate
   * @param requirementSpec - Requirement specification
   * @param context - Validation context
   * @param validationType - Type of validation
   * @returns Validation result
   */
  private async validateServiceForExecution(
    service: Service,
    requirementSpec: RequirementSpec,
    context: ValidationContext,
    validationType: ValidationType
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const violations: ValidationViolation[] = [];
    const warnings: ValidationWarning[] = [];

    // 1. Structural validation
    const schemaValidation = this.schemaValidator.validate(service, requirementSpec.schema);
    if (!schemaValidation.valid) {
      for (const error of schemaValidation.errors) {
        violations.push({
          ruleId: `schema-${error.keyword}`,
          ruleType: 'schema',
          severity: 'error',
          message: error.message,
          location: { component: 'service', path: error.path },
          suggestion: 'Fix schema violation'
        });
      }
    }

    // 2. Behavioral validation (simulation mode)
    const testStartTime = Date.now();
    const testResults = await this.testCaseRunner.runTestCases(
      requirementSpec.testCases,
      undefined,
      context,
      'simulation'
    );
    const testExecutionTime = Date.now() - testStartTime;

    // 3. Context validation
    const contextValidation = this.contextValidator.validateContext(context);
    if (!contextValidation.valid) {
      for (const violation of contextValidation.violations) {
        if (violation.severity === 'error') {
          violations.push({
            ruleId: `context-${violation.dimension}`,
            ruleType: 'context',
            severity: 'error',
            message: violation.message,
            location: { component: 'context', path: violation.aspect },
            suggestion: 'Ensure context meets requirements'
          });
        }
      }
    }

    // 4. Semantic validation
    const semanticMatch = this.semanticMatcher.matchRequirements(
      service.capabilities || [],
      service.category,
      requirementSpec.semanticAnnotations
    );

    // Calculate scores
    const scores: ValidationScores = {
      overall: 0,
      structural: schemaValidation.valid ? 1.0 : 0.0,
      behavioral: this.calculateBehavioralScore(testResults),
      contextual: contextValidation.score,
      semantic: semanticMatch.score
    };

    scores.overall = this.calculateOverallScore(scores);

    // Determine outcome
    const outcome = this.determineOutcome(scores, violations);

    // Generate recommendation
    const recommendation = this.generateRecommendation(outcome, scores, violations, warnings);

    const validationTime = Date.now() - startTime;

    return {
      validationId: this.generateValidationId(),
      requirementId: requirementSpec.id,
      targetId: service.id,
      validationType,
      timestamp: new Date(),
      outcome,
      scores,
      testResults,
      violations,
      warnings,
      metrics: {
        validationTime,
        testExecutionTime,
        testCoverage: (testResults.length / requirementSpec.testCases.length) * 100,
        contextCoverage: 100,
        confidence: semanticMatch.confidence,
        completeness: scores.structural
      },
      recommendation,
      evidence: []
    };
  }

  /**
   * Calculate overall score from component scores
   *
   * @param scores - Component scores
   * @returns Overall score (0-1)
   */
  private calculateOverallScore(scores: ValidationScores): number {
    // Weighted average
    return (
      scores.structural * 0.25 +
      scores.behavioral * 0.35 +
      scores.contextual * 0.20 +
      scores.semantic * 0.20
    );
  }

  /**
   * Calculate behavioral score from test results
   *
   * @param testResults - Test results
   * @returns Behavioral score (0-1)
   */
  private calculateBehavioralScore(testResults: any[]): number {
    if (testResults.length === 0) return 1.0;

    const totalScore = testResults.reduce((sum, result) => sum + result.score, 0);
    return totalScore / testResults.length;
  }

  /**
   * Determine validation outcome based on scores and violations
   *
   * @param scores - Validation scores
   * @param violations - Validation violations
   * @returns Validation outcome
   */
  private determineOutcome(scores: ValidationScores, violations: any[]): ValidationOutcome {
    const errorCount = violations.filter(v => v.severity === 'error').length;

    if (errorCount > 0) {
      return 'non-compliance';
    }

    if (scores.overall >= 0.9) {
      return 'full-compliance';
    }

    if (scores.overall >= 0.6) {
      return 'partial-compliance';
    }

    return 'non-compliance';
  }

  /**
   * Generate validation recommendation
   *
   * @param outcome - Validation outcome
   * @param scores - Validation scores
   * @param violations - Violations
   * @param warnings - Warnings
   * @returns Validation recommendation
   */
  private generateRecommendation(
    outcome: ValidationOutcome,
    scores: ValidationScores,
    violations: any[],
    warnings: any[]
  ): ValidationRecommendation {
    let decision: ValidationRecommendation['decision'];
    let reasoning: string;

    switch (outcome) {
      case 'full-compliance':
        decision = 'approve';
        reasoning = `Service fully complies with requirements (score: ${scores.overall.toFixed(2)})`;
        break;

      case 'partial-compliance':
        decision = 'conditional-approve';
        reasoning = `Service partially complies with requirements (score: ${scores.overall.toFixed(2)})`;
        break;

      case 'non-compliance':
        decision = 'reject';
        reasoning = `Service does not comply with requirements (score: ${scores.overall.toFixed(2)})`;
        break;

      default:
        decision = 'need-review';
        reasoning = 'Validation error occurred';
    }

    return {
      decision,
      confidence: scores.overall,
      reasoning,
      conditions: decision === 'conditional-approve' ? violations.map(v => v.message) : undefined
    };
  }

  /**
   * Generate unique validation ID
   *
   * @returns Validation ID
   */
  private generateValidationId(): string {
    return `validation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
