/**
 * CodeValidator - Code Validation System
 *
 * Validates generated code for syntax, security, semantics, and resource usage.
 * Provides confidence scores and detailed error/warning reports.
 */

import * as ts from 'typescript';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
/**
 * Validation context
 */
const logger = createLogger('CodeValidator');

export interface ValidationContext {
  requirements: string[]; // What the code should do
  availableResources: string[]; // Resources the code can access
  constraints: string[]; // Constraints the code must follow
}

/**
 * Validation error
 */
export interface ValidationError {
  category: 'syntax' | 'security' | 'semantics' | 'resources';
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  column?: number;
  suggestion?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  category: 'performance' | 'maintainability' | 'best-practices';
  message: string;
  suggestion?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  score: number; // 0-100 confidence score
  details: {
    syntaxValid: boolean;
    securityValid: boolean;
    semanticsValid: boolean;
    resourcesValid: boolean;
  };
}

/**
 * Generated test case
 */
export interface GeneratedTest {
  description: string;
  code: string;
  expectedBehavior: string;
}

/**
 * CodeValidator class
 */
export class CodeValidator {
  private llmClient: LLMClient;
  private securityPatterns: Array<{ pattern: RegExp; message: string; severity: 'error' | 'warning' }>;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;

    // Security patterns to check
    this.securityPatterns = [
      { pattern: /eval\s*\(/gi, message: 'Use of eval() is dangerous', severity: 'error' },
      { pattern: /Function\s*\(/gi, message: 'Use of Function constructor is dangerous', severity: 'error' },
      { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/gi, message: 'Child process execution is dangerous', severity: 'error' },
      { pattern: /require\s*\(\s*['"]fs['"]\s*\)/gi, message: 'File system access requires explicit permission', severity: 'warning' },
      { pattern: /process\.exit\s*\(/gi, message: 'Process exit will terminate the agent', severity: 'error' },
      { pattern: /while\s*\(\s*true\s*\)/gi, message: 'Infinite loop detected', severity: 'error' },
      { pattern: /for\s*\(\s*;\s*;\s*\)/gi, message: 'Infinite loop detected', severity: 'error' },
    ];

    logger.info('Initialized');
  }

  /**
   * Validate code comprehensively
   * @param code - Code to validate
   * @param context - Validation context
   * @returns Validation result
   */
  async validateCode(code: string, context: ValidationContext): Promise<ValidationResult> {
    logger.info('Starting comprehensive code validation...');

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const details = {
      syntaxValid: false,
      securityValid: false,
      semanticsValid: false,
      resourcesValid: false,
    };

    // 1. Syntax validation
    logger.info('Validating syntax...');
    const syntaxErrors = await this.validateSyntax(code);
    errors.push(...syntaxErrors);
    details.syntaxValid = syntaxErrors.length === 0;

    // 2. Security validation
    logger.info('Validating security...');
    const securityErrors = this.validateSecurity(code);
    errors.push(...securityErrors);
    details.securityValid = securityErrors.filter(e => e.severity === 'error').length === 0;

    // 3. Semantic validation (using LLM)
    if (context.requirements.length > 0) {
      logger.info('Validating semantics...');
      const semanticErrors = await this.validateSemantics(code, context.requirements, context.availableResources);
      errors.push(...semanticErrors);
      details.semanticsValid = semanticErrors.filter(e => e.severity === 'error').length === 0;
    } else {
      details.semanticsValid = true; // No requirements to validate against
    }

    // 4. Resource validation
    if (context.availableResources.length > 0) {
      logger.info('Validating resource usage...');
      const resourceWarnings = this.validateResources(code, context.availableResources);
      warnings.push(...resourceWarnings);
      details.resourcesValid = true; // Resource issues are warnings, not errors
    } else {
      details.resourcesValid = true;
    }

    // Calculate confidence score
    const score = this.calculateScore(errors, warnings);

    const valid = errors.filter(e => e.severity === 'error').length === 0;

    logger.info('Validation complete:', {
      valid,
      score,
      errorCount: errors.length,
      warningCount: warnings.length,
    });

    return {
      valid,
      errors,
      warnings,
      score,
      details,
    };
  }

  /**
   * Validate TypeScript syntax
   * @param code - Code to validate
   * @returns Syntax errors
   */
  async validateSyntax(code: string): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    try {
      // Create a source file
      const sourceFile = ts.createSourceFile(
        'temp.ts',
        code,
        ts.ScriptTarget.Latest,
        true
      );

      // Check for syntax errors
      const diagnostics = (
        sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics || [];

      for (const diagnostic of diagnostics) {
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
          const position = diagnostic.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start) : { line: 0, character: 0 };

          errors.push({
            category: 'syntax',
            severity: 'error',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            line: position.line + 1,
            column: position.character + 1,
          });
        }
      }

      // Try to compile to catch more errors
      const compilerOptions: ts.CompilerOptions = {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
      };

      const host = ts.createCompilerHost(compilerOptions);
      const program = ts.createProgram(['temp.ts'], compilerOptions, {
        ...host,
        getSourceFile: (fileName) => {
          if (fileName === 'temp.ts') {
            return sourceFile;
          }
          return host.getSourceFile(fileName, ts.ScriptTarget.Latest);
        },
      });

      const emitResult = program.emit();
      const allDiagnostics = ts
        .getPreEmitDiagnostics(program)
        .concat(emitResult.diagnostics);

      for (const diagnostic of allDiagnostics) {
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
          const position = diagnostic.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start) : { line: 0, character: 0 };

          errors.push({
            category: 'syntax',
            severity: 'error',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            line: position.line + 1,
            column: position.character + 1,
          });
        }
      }
    } catch (error) {
      errors.push({
        category: 'syntax',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return errors;
  }

  /**
   * Validate security patterns
   * @param code - Code to validate
   * @returns Security errors
   */
  validateSecurity(code: string): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const { pattern, message, severity } of this.securityPatterns) {
      const matches = code.matchAll(pattern);
      for (const match of matches) {
        if (match.index !== undefined) {
          // Find line and column
          const beforeMatch = code.substring(0, match.index);
          const lines = beforeMatch.split('\n');
          const line = lines.length;
          const column = lines[lines.length - 1].length + 1;

          errors.push({
            category: 'security',
            severity,
            message,
            line,
            column,
            suggestion: severity === 'error' ? 'Remove this dangerous operation' : 'Ensure this operation is safe',
          });
        }
      }
    }

    return errors;
  }

  /**
   * Validate semantics using LLM
   * @param code - Code to validate
   * @param requirements - Requirements the code should meet
   * @param availableResources - Resources available to the code
   * @returns Semantic errors
   */
  async validateSemantics(code: string, requirements: string[], availableResources: string[]): Promise<ValidationError[]> {
    const errors: ValidationError[] = [];

    try {
      const prompt = `You are a code reviewer. Analyze if the following code meets the requirements.

Requirements:
${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Available Resources:
${availableResources.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Code to Review:
\`\`\`typescript
${code}
\`\`\`

Analyze the code and respond in the following JSON format:
{
  "meetsRequirements": boolean,
  "issues": [
    {
      "requirement": string,
      "issue": string,
      "severity": "error" | "warning",
      "suggestion": string
    }
  ],
  "reasoning": string
}`;

      const response = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: 'You are a code reviewer. Respond only in valid JSON format.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Parse LLM response
      let result: any;
      try {
        // Try to extract JSON from response
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          logger.warn('Could not extract JSON from LLM response');
          return [];
        }
      } catch (error) {
        logger.warn('Failed to parse LLM response:', error);
        return [];
      }

      if (result.issues && Array.isArray(result.issues)) {
        for (const issue of result.issues) {
          errors.push({
            category: 'semantics',
            severity: issue.severity || 'warning',
            message: `${issue.requirement}: ${issue.issue}`,
            suggestion: issue.suggestion,
          });
        }
      }

      logger.info('Semantic validation complete:', {
        meetsRequirements: result.meetsRequirements,
        issuesFound: errors.length,
      });
    } catch (error) {
      logger.error('Semantic validation failed:', error);
      // Don't fail validation if LLM is unavailable
    }

    return errors;
  }

  /**
   * Validate resource usage
   * @param code - Code to validate
   * @param availableResources - Resources available to the code
   * @returns Resource warnings
   */
  validateResources(code: string, availableResources: string[]): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    // Check for hardcoded resource IDs that don't match available resources
    const resourcePattern = /['"]([a-zA-Z0-9_-]+)['"]/g;
    const matches = code.matchAll(resourcePattern);

    for (const match of matches) {
      const resourceId = match[1];
      // Check if it looks like a resource ID (contains common patterns)
      if (
        resourceId.includes('device-') ||
        resourceId.includes('agent-') ||
        resourceId.includes('sensor-') ||
        resourceId.includes('hvac-') ||
        resourceId.includes('service-')
      ) {
        if (!availableResources.includes(resourceId)) {
          warnings.push({
            category: 'best-practices',
            message: `Using potentially undefined resource: ${resourceId}`,
            suggestion: `Ensure ${resourceId} is available or use dynamic resource lookup`,
          });
        }
      }
    }

    // Check for inefficient patterns
    if (code.includes('while (') && !code.includes('await')) {
      warnings.push({
        category: 'performance',
        message: 'Busy-wait loop detected without async/await',
        suggestion: 'Use setTimeout or async patterns for non-blocking loops',
      });
    }

    return warnings;
  }

  /**
   * Calculate validation score
   * @param errors - Validation errors
   * @param warnings - Validation warnings
   * @returns Score 0-100
   */
  private calculateScore(errors: ValidationError[], warnings: ValidationWarning[]): number {
    let score = 100;

    // Deduct points for errors
    const errorCount = errors.filter(e => e.severity === 'error').length;
    const warningCount = errors.filter(e => e.severity === 'warning').length;

    score -= errorCount * 25; // Each error deducts 25 points
    score -= warningCount * 10; // Each warning deducts 10 points
    score -= warnings.length * 5; // Each warning deducts 5 points

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Generate test cases for code
   * @param code - Code to generate tests for
   * @returns Generated test cases
   */
  async generateTests(code: string): Promise<GeneratedTest[]> {
    logger.info('Generating test cases...');

    try {
      const prompt = `Generate comprehensive test cases for the following code.

Code:
\`\`\`typescript
${code}
\`\`\`

Generate 3-5 test cases covering:
1. Normal operation
2. Edge cases
3. Error handling

Respond in the following JSON format:
{
  "tests": [
    {
      "description": string,
      "code": string (the test code),
      "expectedBehavior": string
    }
  ]
}`;

      const response = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: 'You are a test case generator. Respond only in valid JSON format.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Parse LLM response
      let result: any;
      try {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          return [];
        }
      } catch (error) {
        logger.warn('Failed to parse test generation response');
        return [];
      }

      return result.tests || [];
    } catch (error) {
      logger.error('Test generation failed:', error);
      return [];
    }
  }
}
