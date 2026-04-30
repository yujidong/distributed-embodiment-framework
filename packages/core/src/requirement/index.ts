/**
 * Requirement Validation Module
 *
 * Exports all requirement validation components:
 * - RequirementValidator: Main validation engine
 * - JSONSchemaValidator: JSON Schema validation
 * - TestCaseRunner: Test case execution
 * - ContextValidator: Context validation
 * - SemanticRequirementMatcher: Semantic matching
 * - RequirementSpecRegistry: Requirement specification registry
 */

export { RequirementValidator } from './RequirementValidator.js';
export { JSONSchemaValidator, type JSONSchemaValidationResult, type JSONSchemaError } from './JSONSchemaValidator.js';
export { TestCaseRunner } from './TestCaseRunner.js';
export { ContextValidator, type ContextValidationResult, type DimensionValidationResult, type ContextViolation } from './ContextValidator.js';
export { SemanticRequirementMatcher } from './SemanticRequirementMatcher.js';
export { RequirementSpecRegistry, type RegistryStats } from './RequirementSpecRegistry.js';
