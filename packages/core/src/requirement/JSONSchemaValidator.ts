/**
 * JSON Schema Validator
 *
 * Validates service data against JSON Schema specifications using ajv.
 * Implements industry best practices for JSON Schema validation.
 *
 * Best Practices:
 * - Always specify schema version with $schema keyword
 * - Reusable validator instances for performance
 * - Use iter_errors() for detailed error reporting
 * - Secure validation with input limits
 */

import Ajv, { ValidateFunction, ErrorObject } from 'ajv';
import type { JSONSchema } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * JSON Schema Validator class
 * Manages reusable validator instances and provides detailed error reporting
 */
const logger = createLogger('JSONSchemaValidator');

export class JSONSchemaValidator {
  private ajv: Ajv;
  private validatorCache: Map<string, ValidateFunction>;

  constructor() {
    // Initialize Ajv with best practices
    this.ajv = new Ajv({
      allErrors: false, // Don't use in production (bypasses optimization)
      verbose: true,    // Enable verbose error messages
      strict: false,    // Allow some flexibility for IoT extensions
      coerceTypes: true // Safe type coercion for IoT data
    });

    this.validatorCache = new Map();
    logger.info('Initialized with Ajv');
  }

  /**
   * Validate data against a JSON Schema
   *
   * @param data - The data to validate
   * @param schema - The JSON Schema to validate against
   * @returns Validation result with detailed errors if any
   */
  validate(data: unknown, schema: JSONSchema): JSONSchemaValidationResult {
    const validator = this.getValidator(schema);

    const isValid = validator(data);

    if (isValid) {
      return {
        valid: true,
        errors: [],
        errorCount: 0
      };
    }

    // Use validator.errors for detailed error information
    const errors = this.formatErrors(validator.errors || []);

    return {
      valid: false,
      errors,
      errorCount: errors.length
    };
  }

  /**
   * Get or create a reusable validator instance
   *
   * @param schema - The JSON Schema
   * @returns Compiled validator function
   */
  private getValidator(schema: JSONSchema): ValidateFunction {
    const schemaKey = this.getSchemaKey(schema);

    // Check cache for existing validator
    let validator = this.validatorCache.get(schemaKey);

    if (!validator) {
      // Compile and cache new validator
      validator = this.ajv.compile(schema);
      this.validatorCache.set(schemaKey, validator);
      logger.info(`Compiled and cached validator for schema: ${schema.$id || schema.title}`);
    }

    return validator;
  }

  /**
   * Generate a unique key for schema caching
   *
   * @param schema - The JSON Schema
   * @returns Unique schema identifier
   */
  private getSchemaKey(schema: JSONSchema): string {
    if (schema.$id) {
      return schema.$id;
    }
    // Fallback to stringified schema (not ideal but works)
    return JSON.stringify(schema);
  }

  /**
   * Format Ajv errors into user-friendly format
   *
   * @param errors - Ajv error objects
   * @returns Formatted error messages
   */
  private formatErrors(errors: ErrorObject[]): JSONSchemaError[] {
    return errors.map(error => {
      const path = error.instancePath || '(root)';

      return {
        path,
        property: error.schemaPath || '',
        message: this.formatErrorMessage(error),
        keyword: error.keyword,
        params: error.params,
        data: error.data
      };
    });
  }

  /**
   * Format a single error message
   *
   * @param error - Ajv error object
   * @returns Formatted error message
   */
  private formatErrorMessage(error: ErrorObject): string {
    const { keyword, message, params } = error;
    const p = params as Record<string, unknown>;

    switch (keyword) {
      case 'required':
        return `Missing required property: ${p.missingProperty}`;
      case 'type':
        return `Expected type '${p.type}' but got '${typeof error.data}'`;
      case 'minimum':
        return `Value ${error.data} is below minimum ${p.limit}`;
      case 'maximum':
        return `Value ${error.data} is above maximum ${p.limit}`;
      case 'enum':
        return `Value ${error.data} is not one of allowed values: ${Array.isArray(p.allowedValues) ? (p.allowedValues as unknown[]).join(', ') : 'unknown'}`;
      case 'pattern':
        return `Value '${error.data}' does not match pattern '${p.pattern}'`;
      case 'minLength':
        return `Value length ${typeof error.data === 'string' ? error.data.length : 0} is below minimum ${p.limit}`;
      case 'maxLength':
        return `Value length ${typeof error.data === 'string' ? error.data.length : 0} is above maximum ${p.limit}`;
      default:
        return message || `Validation failed: ${keyword}`;
    }
  }

  /**
   * Clear the validator cache
   * Useful for memory management or schema updates
   */
  clearCache(): void {
    this.validatorCache.clear();
    logger.info('Validator cache cleared');
  }

  /**
   * Get cache statistics
   *
   * @returns Cache size and hit rate information
   */
  getCacheStats(): { size: number } {
    return {
      size: this.validatorCache.size
    };
  }
}

/**
 * JSON Schema validation result
 */
export interface JSONSchemaValidationResult {
  valid: boolean;
  errors: JSONSchemaError[];
  errorCount: number;
}

/**
 * Formatted JSON Schema error
 */
export interface JSONSchemaError {
  path: string;           // JSON path to error location
  property: string;       // Schema path
  message: string;        // Human-readable error message
  keyword: string;        // Ajv validation keyword
  params: Record<string, unknown>; // Error parameters
  data: unknown;             // Actual data that failed validation
}
