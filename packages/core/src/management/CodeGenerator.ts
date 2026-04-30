/**
 * Code Generator
 *
 * Middle layer component for code generation and execution
 * Uses LLM to generate TypeScript code based on requirements
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import { SandboxManager, CodeValidator, PromotionPipeline } from '../autonomous/index.js';
import type { PromotionRequest } from '../autonomous/index.js';
import type { SemanticService } from '../service/SemanticService.js';
import { getSemanticDescription } from '../service/SemanticService.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Code generation request
 * Enhanced with semantic service context for Active Collaboration Theory
 */
const logger = createLogger('CodeGenerator');

export interface CodeGenerationRequest {
  description: string;
  requirements: string[];
  context: {
    availableResources: string[];
    availableServices?: SemanticService[]; // NEW: Semantic service descriptions for Active Collaboration
    environmentInfo: Record<string, unknown>;
    constraints?: string[];
  };
  language?: string; // Default: TypeScript
}

/**
 * Code generation result
 */
export interface CodeGenerationResult {
  success: boolean;
  code?: string;
  language: string;
  explanation?: string;
  error?: string;
  metadata: {
    modelUsed: string;
    tokensUsed?: number;
    generatedAt: Date;
  };
}

/**
 * Code validation result
 */
export interface CodeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Code execution result
 */
export interface CodeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  output?: string;
  executionTime: number;
}

/**
 * Code Generator generates and executes code using LLM
 */
export class CodeGenerator {
  private llmClient: LLMClient;
  private executionHistory: Array<{
    request: CodeGenerationRequest;
    result: CodeGenerationResult;
    timestamp: Date;
  }>;

  // Autonomous components (initialized on demand)
  private sandboxManager?: SandboxManager;
  private codeValidator?: CodeValidator;
  private promotionPipeline?: PromotionPipeline;
  private autonomousEnabled: boolean = false;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
    this.executionHistory = [];
    logger.info('Initialized');
  }

  /**
   * Initialize autonomous development components
   * @param config - Configuration for autonomous components
   */
  initAutonomousComponents(config?: {
    sandbox?: {
      timeout?: number;
      maxMemory?: number;
    };
    autoApproveThreshold?: number;
  }): void {
    logger.info('Initializing autonomous components...');

    // Initialize sandbox manager
    this.sandboxManager = new SandboxManager(
      config?.sandbox,
      this.llmClient
    );

    // Initialize code validator
    this.codeValidator = new CodeValidator(this.llmClient);

    // Initialize promotion pipeline
    this.promotionPipeline = new PromotionPipeline(
      config?.autoApproveThreshold || 85
    );

    this.autonomousEnabled = true;

    logger.info('Autonomous components initialized');
  }

  /**
   * Generate code from description
   * @param request - Code generation request
   * @returns Generated code
   */
  async generateCode(request: CodeGenerationRequest): Promise<CodeGenerationResult> {
    logger.info(`Generating code for: ${request.description}`);

    const startTime = Date.now();

    try {
      // Build prompt for LLM
      const prompt = this.buildCodeGenerationPrompt(request);

      // Call LLM
      const messages = [
        {
          role: 'system' as const,
          content: this.getSystemPrompt(),
        },
        {
          role: 'user' as const,
          content: prompt,
        },
      ];

      const llmResponse = await this.llmClient.chat({ messages });

      // Parse response
      const parsed = this.parseLLMResponse(llmResponse.content);

      const result: CodeGenerationResult = {
        success: true,
        code: parsed.code,
        language: request.language || 'TypeScript',
        explanation: parsed.explanation,
        metadata: {
          modelUsed: llmResponse.model || 'unknown',
          generatedAt: new Date(),
        },
      };

      // Store in history
      this.executionHistory.push({
        request,
        result,
        timestamp: new Date(),
      });

      logger.info(`Code generated successfully in ${Date.now() - startTime}ms`);

      return result;
    } catch (error) {
      logger.error(`Code generation failed:`, error);

      const result: CodeGenerationResult = {
        success: false,
        language: request.language || 'TypeScript',
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          modelUsed: 'unknown',
          generatedAt: new Date(),
        },
      };

      return result;
    }
  }

  /**
   * Validate generated code
   * @param code - Code to validate
   * @returns Validation result
   */
  validateCode(code: string): CodeValidationResult {
    logger.info('Validating code');

    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic syntax checks
    if (!code || code.trim().length === 0) {
      errors.push('Code is empty');
    }

    // Check for dangerous patterns
    const dangerousPatterns = [
      'eval(',
      'exec(',
      'system(',
      'child_process',
      'require("fs")',
      'import("fs")',
      'process.exit',
    ];

    for (const pattern of dangerousPatterns) {
      if (code.includes(pattern)) {
        errors.push(`Dangerous pattern detected: ${pattern}`);
      }
    }

    // Check for required patterns (async function, exports, etc.)
    if (!code.includes('async') && !code.includes('function')) {
      warnings.push('Code does not contain any functions');
    }

    // More sophisticated validation would use TypeScript compiler API
    // For MVP, we do basic checks

    const result: CodeValidationResult = {
      valid: errors.length === 0,
      errors,
      warnings,
    };

    logger.info(`Validation result: ${result.valid ? 'VALID' : 'INVALID'}`);

    return result;
  }

  /**
   * Execute generated code in a sandboxed environment
   * @param code - Code to execute
   * @param context - Execution context (available variables/functions)
   * @returns Execution result
   */
  async executeCode(
    code: string,
    context: Record<string, unknown> = {}
  ): Promise<CodeExecutionResult> {
    logger.info('Executing code');

    const startTime = Date.now();

    try {
      // Create a function from the code
      // Note: This is NOT secure for production. Use proper sandboxing in production.
      const asyncFunction = new Function(
        ...Object.keys(context),
        `
        return (async () => {
          try {
            ${code}
          } catch (error) {
            return { error: error.message };
          }
        })();
        `
      );

      // Execute with context
      const result = await asyncFunction(...Object.values(context));

      const executionTime = Date.now() - startTime;

      // Check if execution returned an error
      if (result && typeof result === 'object' && 'error' in result) {
        logger.error(`Execution error: ${result.error}`);
        return {
          success: false,
          error: result.error,
          executionTime,
        };
      }

      logger.info(`Code executed successfully in ${executionTime}ms`);

      return {
        success: true,
        result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      logger.error(`Code execution failed:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      };
    }
  }

  /**
   * Generate and execute code in one step
   * @param request - Code generation request
   * @param executionContext - Context for code execution
   * @returns Combined result
   */
  async generateAndExecute(
    request: CodeGenerationRequest,
    executionContext: Record<string, unknown> = {}
  ): Promise<{
    generation: CodeGenerationResult;
    validation: CodeValidationResult;
    execution: CodeExecutionResult;
  }> {
    logger.info('Generate and execute workflow');

    // Generate code
    const generation = await this.generateCode(request);

    if (!generation.success || !generation.code) {
      return {
        generation,
        validation: { valid: false, errors: [], warnings: [] },
        execution: {
          success: false,
          error: 'Code generation failed',
          executionTime: 0,
        },
      };
    }

    // Validate code
    const validation = this.validateCode(generation.code);

    if (!validation.valid) {
      return {
        generation,
        validation,
        execution: {
          success: false,
          error: 'Code validation failed',
          executionTime: 0,
        },
      };
    }

    // Execute code
    const execution = await this.executeCode(generation.code, executionContext);

    return {
      generation,
      validation,
      execution,
    };
  }

  /**
   * Get execution history
   * @param limit - Maximum number of entries
   * @returns Execution history
   */
  getHistory(limit?: number): Array<{
    request: CodeGenerationRequest;
    result: CodeGenerationResult;
    timestamp: Date;
  }> {
    const sliceLimit = limit !== undefined ? limit : this.executionHistory.length;
    const history = this.executionHistory.slice(-sliceLimit);
    return history;
  }

  /**
   * Clear execution history
   */
  clearHistory(): void {
    logger.info('Clearing execution history');
    this.executionHistory = [];
  }

  /**
   * Get statistics
   * @returns Statistics object
   */
  getStats(): {
    totalGenerations: number;
    successfulGenerations: number;
    averageExecutionTime: number;
  } {
    const successful = this.executionHistory.filter((h) => h.result.success).length;

    return {
      totalGenerations: this.executionHistory.length,
      successfulGenerations: successful,
      averageExecutionTime: 0, // Would need to track actual execution times
    };
  }

  /**
   * Build prompt for code generation
   * Enhanced: Includes semantic service descriptions for Active Collaboration Theory
   * @param request - Code generation request
   * @returns Prompt string
   */
  private buildCodeGenerationPrompt(request: CodeGenerationRequest): string {
    let prompt = `Generate TypeScript code to accomplish the following task:\n\n`;
    prompt += `Task: ${request.description}\n\n`;

    if (request.requirements.length > 0) {
      prompt += `Requirements:\n`;
      for (const req of request.requirements) {
        prompt += `- ${req}\n`;
      }
      prompt += `\n`;
    }

    // NEW: Include semantic service descriptions for Active Collaboration
    if (request.context.availableServices && request.context.availableServices.length > 0) {
      prompt += `Available Services (with semantic descriptions):\n`;
      for (const service of request.context.availableServices) {
        const semanticDesc = getSemanticDescription(service);
        prompt += `- ${service.id}: ${service.name}\n`;
        prompt += `  Semantic: ${semanticDesc}\n`;
        if (service.ontologyClass) {
          prompt += `  Ontology: ${service.ontologyClass}\n`;
        }
        prompt += `  Capabilities: ${service.description}\n`;
      }
      prompt += `\n`;
    }

    if (request.context.availableResources.length > 0) {
      prompt += `Available Resources:\n`;
      for (const resource of request.context.availableResources) {
        prompt += `- ${resource}\n`;
      }
      prompt += `\n`;
    }

    if (request.context.constraints && request.context.constraints.length > 0) {
      prompt += `Constraints:\n`;
      for (const constraint of request.context.constraints) {
        prompt += `- ${constraint}\n`;
      }
      prompt += `\n`;
    }

    prompt += `Provide your response in the following format:\n\n`;
    prompt += `\`\`\`EXPLANATION\`\`\`\n`;
    prompt += `[Your explanation of the code]\n\n`;
    prompt += `\`\`\`CODE\`\`\`\n`;
    prompt += `[Your TypeScript code here]\n`;
    prompt += `\`\`\`\n`;

    return prompt;
  }

  /**
   * Get system prompt for LLM
   * Enhanced: Emphasizes semantic reasoning for Active Collaboration Theory
   * @returns System prompt
   */
  private getSystemPrompt(): string {
    return `You are an expert TypeScript developer specializing in IoT automation and device control.

Your task is to generate clean, safe, and efficient TypeScript code based on user requirements.

Active Collaboration Context:
- You are operating in an Active Collaboration system where services have semantic self-awareness
- Services are annotated with ontology classes (SSN for sensing, SAREF for actuation)
- Use semantic descriptions to understand service capabilities, not just names
- Leverage semantic compatibility to compose services intelligently
- Anticipate collaboration needs based on semantic context

Guidelines:
- Always use async/await for asynchronous operations
- Include proper error handling
- Add comments for complex logic
- Return results in a structured format
- Never use dangerous operations (eval, exec, system commands, file system access)
- Use the available services and resources provided in the context
- Leverage semantic annotations to make intelligent service composition decisions
- Follow TypeScript best practices

Semantic Service Understanding:
- Services with SSN ontology (ssn:) provide sensing capabilities
- Services with SAREF ontology (saref:) provide actuation capabilities
- Sensing + Actuation services are naturally complementary for collaboration
- Use semantic descriptions to match services to requirements

Response Format:
1. EXPLANATION section: Brief explanation of your approach, including semantic reasoning
2. CODE section: The actual TypeScript code`;
  }

  /**
   * Parse LLM response to extract code and explanation
   * @param response - LLM response content
   * @returns Parsed code and explanation
   */
  private parseLLMResponse(response: string): {
    code: string;
    explanation: string;
  } {
    let explanation = '';
    let code = '';

    // Try to extract sections
    const explanationMatch = response.match(/```EXPLANATION\n([\s\S]+?)\n```/);
    const codeMatch = response.match(/```CODE\n([\s\S]+?)\n```/);

    if (explanationMatch) {
      explanation = explanationMatch[1].trim();
    }

    if (codeMatch) {
      code = codeMatch[1].trim();
    } else {
      // Try other code block formats
      const tsCodeMatch = response.match(/```(?:typescript|ts)?\n([\s\S]+?)\n```/);
      if (tsCodeMatch) {
        code = tsCodeMatch[1].trim();
      } else {
        // No code block found, use entire response as code
        code = response.trim();
      }
    }

    // If still no explanation, generate one
    if (!explanation) {
      explanation = 'Code generated based on requirements.';
    }

    return { code, explanation };
  }

  /**
   * Generate, validate, test, and deploy code (autonomous workflow)
   * @param request - Code generation request
   * @param agentId - Agent ID requesting the code
   * @param executionContext - Context for code execution
   * @returns Complete workflow result
   */
  async generateAndDeploy(
    request: CodeGenerationRequest,
    agentId: string,
    executionContext: Record<string, unknown> = {}
  ): Promise<{
    generation: CodeGenerationResult;
    validation?: import('../autonomous/index.js').ValidationResult;
    sandbox?: import('../autonomous/index.js').SandboxExecutionResult;
    deployment?: PromotionRequest;
    error?: string;
  }> {
    logger.info('Starting autonomous generate-and-deploy workflow...');

    if (!this.autonomousEnabled || !this.sandboxManager || !this.codeValidator || !this.promotionPipeline) {
      return {
        generation: { success: false, error: 'Autonomous components not initialized', language: 'TypeScript', metadata: { modelUsed: 'unknown', generatedAt: new Date() } },
        error: 'Autonomous components not initialized. Call initAutonomousComponents() first.',
      };
    }

    try {
      // Step 1: Generate code
      logger.info('Step 1: Generating code...');
      const generation = await this.generateCode(request);

      if (!generation.success || !generation.code) {
        return {
          generation,
          error: 'Code generation failed',
        };
      }

      logger.info('Code generated successfully');

      // Step 2: Validate code
      logger.info('Step 2: Validating code...');
      const validation = await this.codeValidator.validateCode(generation.code, {
        requirements: request.requirements,
        availableResources: request.context.availableResources,
        constraints: request.context.constraints || [],
      });

      logger.info('Validation complete:', {
        valid: validation.valid,
        score: validation.score,
        errors: validation.errors.length,
        warnings: validation.warnings.length,
      });

      // Step 3: Test in sandbox
      logger.info('Step 3: Testing in sandbox...');
      const sandbox = await this.sandboxManager.executeInSandbox(
        generation.code,
        executionContext
      );

      logger.info('Sandbox test complete:', {
        success: sandbox.success,
        executionTime: sandbox.executionTime,
        violations: sandbox.violations.length,
      });

      // Step 4: Create promotion request
      logger.info('Step 4: Creating promotion request...');
      const promotionRequest = this.promotionPipeline.createRequest(
        agentId,
        generation.code,
        request.requirements,
        validation,
        sandbox
      );

      logger.info('Promotion request created:', promotionRequest.id);

      // Step 5: Try auto-approve
      logger.info('Step 5: Checking auto-approval...');
      const autoDecision = this.promotionPipeline.autoApprove(promotionRequest.id);

      if (autoDecision && autoDecision.approved) {
        logger.info('Code auto-approved!');
        // Deploy to production
        this.promotionPipeline.deployToProduction(promotionRequest.id);
      } else {
        logger.info('Code requires human approval');
        // Request human approval
        await this.promotionPipeline.requestApproval(promotionRequest.id);
      }

      return {
        generation,
        validation,
        sandbox,
        deployment: promotionRequest,
      };
    } catch (error) {
      logger.error('Autonomous workflow failed:', error);

      return {
        generation: { success: false, error: error instanceof Error ? error.message : String(error), language: 'TypeScript', metadata: { modelUsed: 'unknown', generatedAt: new Date() } },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get autonomous components status
   * @returns Status object
   */
  getAutonomousStatus(): {
    enabled: boolean;
    sandboxInitialized: boolean;
    validatorInitialized: boolean;
    pipelineInitialized: boolean;
    pipelineStats?: ReturnType<PromotionPipeline['getStats']>;
    sandboxStats?: ReturnType<SandboxManager['getStats']>;
  } {
    return {
      enabled: this.autonomousEnabled,
      sandboxInitialized: !!this.sandboxManager,
      validatorInitialized: !!this.codeValidator,
      pipelineInitialized: !!this.promotionPipeline,
      pipelineStats: this.promotionPipeline?.getStats(),
      sandboxStats: this.sandboxManager?.getStats(),
    };
  }
}
