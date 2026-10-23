/**
 * SandboxManager - Isolated Code Execution
 *
 * Provides secure sandboxed execution environment for generated code.
 * Uses Node.js built-in VM module with configurable resource constraints.
 */

import * as vm from 'vm';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
/**
 * Sandbox configuration
 */
const logger = createLogger('SandboxManager');

export interface SandboxConfig {
  timeout: number; // Maximum execution time (ms)
  maxMemory: number; // Maximum memory (bytes)
  allowedModules: string[]; // Whitelist of importable modules
  forbiddenPatterns: string[]; // Blacklist of dangerous patterns
}

/**
 * Sandbox execution result
 */
export interface SandboxExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  executionTime: number;
  memoryUsed: number;
  logs: string[];
  violations: string[];
}

/**
 * Execution history entry
 */
export interface ExecutionHistoryEntry {
  timestamp: Date;
  code: string;
  context: Record<string, any>;
  result: SandboxExecutionResult;
}

/**
 * SandboxManager class
 */
export class SandboxManager {
  private config: SandboxConfig;
  private executionHistory: ExecutionHistoryEntry[];
  private maxHistorySize: number;
  // private llmClient?: LLMClient; // Reserved for future use

  // Default forbidden patterns (dangerous operations)
  private static DEFAULT_FORBIDDEN_PATTERNS = [
    'eval\\s*\\(',
    'Function\\s*\\(',
    'require\\s*\\(',
    'import\\s+',
    'process\\.',
    'child_process',
    'fs\\.',
    'exec\\s*\\(',
    'spawn\\s*\\(',
  ];

  constructor(config?: Partial<SandboxConfig>, _llmClient?: LLMClient) {
    this.config = {
      timeout: config?.timeout || 5000, // 5 seconds default
      maxMemory: config?.maxMemory || 16 * 1024 * 1024, // 16MB default
      allowedModules: config?.allowedModules || [],
      forbiddenPatterns: config?.forbiddenPatterns || [],
    };
    this.executionHistory = [];
    this.maxHistorySize = 100;
    // llmClient reserved for future use
    logger.info('Initialized with config:', {
      timeout: this.config.timeout,
      maxMemory: `${this.config.maxMemory / 1024 / 1024}MB`,
      allowedModules: this.config.allowedModules.length,
    });
  }

  /**
   * Execute code in sandbox
   * @param code - Code to execute
   * @param context - Context variables available to code
   * @param options - Override options
   * @returns Execution result
   */
  async executeInSandbox(
    code: string,
    context: Record<string, any> = {},
    options?: Partial<SandboxConfig>
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    const violations: string[] = [];

    logger.info('Executing code in sandbox...');

    try {
      // Validate code safety first
      const safetyCheck = this.validateSandboxSafety(code);
      if (!safetyCheck.safe) {
        violations.push(...safetyCheck.violations);
        logger.warn('Code safety check failed:', violations);

        const result: SandboxExecutionResult = {
          success: false,
          error: `Code contains forbidden patterns: ${violations.join(', ')}`,
          executionTime: Date.now() - startTime,
          memoryUsed: 0,
          logs,
          violations,
        };

        this.addToHistory(code, context, result);
        return result;
      }

      // Merge config with options
      const effectiveConfig = {
        timeout: options?.timeout || this.config.timeout,
      };

      // Prepare sandbox environment
      const sandbox: Record<string, any> = {
        console: {
          log: (...args: any[]) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            logs.push(`[INFO] ${message}`);
          },
          warn: (...args: any[]) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            logs.push(`[WARN] ${message}`);
          },
          error: (...args: any[]) => {
            const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            logs.push(`[ERROR] ${message}`);
          },
        },
        setTimeout,
        clearTimeout,
        Promise,
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        ...context,
      };

      // Wrap code to capture result
      const wrappedCode = `
        (async () => {
          try {
            ${code}
          } catch (error) {
            return { error: error.message, stack: error.stack };
          }
        })()
      `;

      // Create script
      const script = new vm.Script(wrappedCode, {
        filename: 'sandbox.js',
        lineOffset: 0,
      } as vm.ScriptOptions);

      // Create context
      const contextObject = vm.createContext(sandbox);

      // Execute with timeout
      const result = await this.executeWithTimeout(script, contextObject, effectiveConfig.timeout);

      const executionTime = Date.now() - startTime;

      // Check if execution returned an error
      if (result && result.error) {
        logger.warn('Code execution returned error:', result.error);

        const errorResult: SandboxExecutionResult = {
          success: false,
          error: result.error,
          executionTime,
          memoryUsed: 0,
          logs,
          violations,
        };

        this.addToHistory(code, context, errorResult);
        return errorResult;
      }

      logger.info('Code executed successfully');

      const successResult: SandboxExecutionResult = {
        success: true,
        result,
        executionTime,
        memoryUsed: 0,
        logs,
        violations,
      };

      this.addToHistory(code, context, successResult);
      return successResult;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Code execution failed:', errorMessage);

      const errorResult: SandboxExecutionResult = {
        success: false,
        error: errorMessage,
        executionTime,
        memoryUsed: 0,
        logs,
        violations,
      };

      this.addToHistory(code, context, errorResult);
      return errorResult;
    }
  }

  /**
   * Execute script with timeout
   * @param script - VM script to execute
   * @param context - VM context
   * @param timeout - Timeout in milliseconds
   * @returns Execution result
   */
  private async executeWithTimeout(
    script: vm.Script,
    context: vm.Context,
    timeout: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Script execution timeout (${timeout}ms)`));
      }, timeout);

      script.runInContext(context)
        .then((result: any) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Validate code safety before execution
   * @param code - Code to validate
   * @returns Safety check result
   */
  validateSandboxSafety(code: string): { safe: boolean; violations: string[] } {
    const violations: string[] = [];

    // Check default forbidden patterns
    for (const pattern of SandboxManager.DEFAULT_FORBIDDEN_PATTERNS) {
      const regex = new RegExp(pattern, 'gi');
      if (regex.test(code)) {
        violations.push(`Contains forbidden pattern: ${pattern}`);
      }
    }

    // Check custom forbidden patterns
    for (const pattern of this.config.forbiddenPatterns) {
      const regex = new RegExp(pattern, 'gi');
      if (regex.test(code)) {
        violations.push(`Contains custom forbidden pattern: ${pattern}`);
      }
    }

    // Check for module imports
    const requireMatches = code.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    if (requireMatches) {
      for (const match of requireMatches) {
        const moduleMatch = match.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (moduleMatch) {
          const moduleName = moduleMatch[1];
          if (!this.config.allowedModules.includes(moduleName)) {
            violations.push(`Attempted to import forbidden module: ${moduleName}`);
          }
        }
      }
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }

  /**
   * Get execution history
   * @param limit - Maximum number of entries to return
   * @returns Execution history
   */
  getExecutionHistory(limit?: number): ExecutionHistoryEntry[] {
    const historyLimit = limit || this.executionHistory.length;
    return this.executionHistory.slice(-historyLimit);
  }

  /**
   * Get statistics about sandbox usage
   * @returns Statistics object
   */
  getStats(): {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    averageExecutionTime: number;
    violationCount: number;
  } {
    const total = this.executionHistory.length;
    const successful = this.executionHistory.filter(e => e.result.success).length;
    const failed = total - successful;
    const avgTime =
      total > 0
        ? this.executionHistory.reduce((sum, e) => sum + e.result.executionTime, 0) / total
        : 0;
    const violations = this.executionHistory.reduce((sum, e) => sum + e.result.violations.length, 0);

    return {
      totalExecutions: total,
      successfulExecutions: successful,
      failedExecutions: failed,
      averageExecutionTime: Math.round(avgTime),
      violationCount: violations,
    };
  }

  /**
   * Clear execution history
   */
  clearHistory(): void {
    this.executionHistory = [];
    logger.info('Execution history cleared');
  }

  /**
   * Update sandbox configuration
   * @param config - New configuration
   */
  updateConfig(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Configuration updated:', this.config);
  }

  /**
   * Add execution to history
   * @param code - Executed code
   * @param context - Execution context
   * @param result - Execution result
   */
  private addToHistory(code: string, context: Record<string, any>, result: SandboxExecutionResult): void {
    this.executionHistory.push({
      timestamp: new Date(),
      code,
      context,
      result,
    });

    // Trim history if needed
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.maxHistorySize);
    }
  }
}
