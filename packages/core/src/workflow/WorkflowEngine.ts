/**
 * Workflow Engine - Business Process Execution
 *
 * Executes predefined workflows for agents with step-by-step processing,
 * error handling, retry logic, and persistence in memory.
 */

import {
  WorkflowDefinition,
  WorkflowContext,
  WorkflowResult,
  WorkflowStatus,
  StepType,
  WorkflowLog,
  ActionHandler,
  WorkflowStep,
} from './types';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@active-collaboration/shared';
/**
 * WorkflowEngine - Executes business workflows
 */
const logger = createLogger('WorkflowEngine');

export class WorkflowEngine {
  // Workflow storage
  private workflows: Map<string, WorkflowDefinition> = new Map();

  // Active executions
  private executions: Map<string, WorkflowContext> = new Map();

  // Action handlers registry
  private actionHandlers: Map<string, ActionHandler> = new Map();

  // Event handlers
  private stepCompleteHandler?: (executionId: string, stepId: string, result: any) => void;
  private workflowCompleteHandler?: (executionId: string, result: WorkflowResult) => void;
  private workflowErrorHandler?: (executionId: string, error: Error) => void;

  constructor() {
    logger.info('Initialized');
  }

  // ========================================================================
  // Workflow Management
  // ========================================================================

  /**
   * Define a new workflow
   */
  defineWorkflow(spec: Omit<WorkflowDefinition, 'id' | 'version'>): WorkflowDefinition {
    const workflow: WorkflowDefinition = {
      ...spec,
      id: this.generateId('workflow'),
      version: '1.0.0',
      metadata: {
        ...spec.metadata,
        createdAt: spec.metadata?.createdAt ?? Date.now(),
        updatedAt: spec.metadata?.updatedAt ?? Date.now(),
        tags: spec.metadata?.tags ?? [],
      },
    };

    this.validateWorkflow(workflow);

    this.workflows.set(workflow.id, workflow);
    logger.info(`Defined workflow: ${workflow.name} (${workflow.id})`);

    return workflow;
  }

  /**
   * Get workflow by ID
   */
  getWorkflow(workflowId: string): WorkflowDefinition | null {
    return this.workflows.get(workflowId) || null;
  }

  /**
   * Get workflow by name
   */
  getWorkflowByName(name: string): WorkflowDefinition | null {
    for (const workflow of this.workflows.values()) {
      if (workflow.name === name) {
        return workflow;
      }
    }
    return null;
  }

  /**
   * List all workflows
   */
  listWorkflows(type?: string): WorkflowDefinition[] {
    const workflows = Array.from(this.workflows.values());

    if (type) {
      return workflows.filter((w) => w.type === type);
    }

    return workflows;
  }

  /**
   * Update workflow
   */
  updateWorkflow(workflowId: string, updates: Partial<WorkflowDefinition>): void {
    const workflow = this.workflows.get(workflowId);

    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const updated = {
      ...workflow,
      ...updates,
      id: workflow.id, // Preserve ID
      metadata: {
        ...workflow.metadata,
        ...updates.metadata,
        updatedAt: Date.now(),
      },
    };

    this.validateWorkflow(updated);
    this.workflows.set(workflowId, updated);

    logger.info(`Updated workflow: ${workflowId}`);
  }

  /**
   * Delete workflow
   */
  deleteWorkflow(workflowId: string): void {
    if (!this.workflows.delete(workflowId)) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    logger.info(`Deleted workflow: ${workflowId}`);
  }

  // ========================================================================
  // Workflow Execution
  // ========================================================================

  /**
   * Execute a workflow
   */
  async execute(
    workflowId: string,
    input: Record<string, any>,
    options?: {
      executionId?: string;
      timeout?: number;
    }
  ): Promise<WorkflowResult> {
    const workflow = this.getWorkflow(workflowId);

    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const executionId = options?.executionId || this.generateId('exec');
    const startTime = Date.now();

    // Initialize execution context
    const context: WorkflowContext = {
      workflowId,
      executionId,
      input,
      output: {},
      variables: { ...input },
      status: WorkflowStatus.RUNNING,
      startedAt: startTime,
      stepsExecuted: [],
      stepsSkipped: [],
      logs: [],
    };

    this.executions.set(executionId, context);
    this.log(context, 'info', `Starting workflow execution: ${workflow.name}`);

    try {
      // Execute steps
      const result = await this.executeSteps(context, workflow, startTime);

      // Update context
      context.status = result.success ? WorkflowStatus.COMPLETED : WorkflowStatus.FAILED;
      context.completedAt = Date.now();
      context.output = result.output;

      // Update workflow stats
      this.updateWorkflowStats(workflow.id, result.success, result.executionTime);

      this.log(context, 'info', `Workflow ${result.success ? 'completed' : 'failed'} in ${result.executionTime}ms`);

      const workflowResult: WorkflowResult = {
        success: result.success,
        output: result.output,
        context,
        executionTime: result.executionTime,
        stepsExecuted: result.stepsExecuted,
        error: result.error,
      };

      // Trigger completion event
      if (this.workflowCompleteHandler) {
        this.workflowCompleteHandler(executionId, workflowResult);
      }

      return workflowResult;
    } catch (error) {
      const executionTime = Date.now() - startTime;

      context.status = WorkflowStatus.FAILED;
      context.completedAt = Date.now();
      context.error = error as Error;

      this.log(context, 'error', `Workflow failed: ${error}`);

      const workflowResult: WorkflowResult = {
        success: false,
        output: {},
        context,
        executionTime,
        stepsExecuted: context.stepsExecuted.length,
        error: error as Error,
      };

      // Trigger error event
      if (this.workflowErrorHandler) {
        this.workflowErrorHandler(executionId, error as Error);
      }

      return workflowResult;
    }
  }

  /**
   * Execute workflow steps
   */
  private async executeSteps(
    context: WorkflowContext,
    workflow: WorkflowDefinition,
    startTime: number
  ): Promise<WorkflowResult> {
    const steps = workflow.steps;
    let output: Record<string, any> = {};

    for (const step of steps) {
      // Check if workflow was cancelled
      if (context.status === WorkflowStatus.CANCELLED) {
        this.log(context, 'info', 'Workflow cancelled');
        return {
          success: false,
          output: context.output,
          context,
          executionTime: Date.now() - startTime,
          stepsExecuted: context.stepsExecuted.length
        };
      }

      try {
        const stepResult = await this.executeStep(context, step);

        // Store step output in variables
        if (stepResult) {
          context.variables[step.id] = stepResult;
          output = { ...output, ...stepResult };
        }

        context.stepsExecuted.push(step.id);

        // Trigger step complete event
        if (this.stepCompleteHandler) {
          this.stepCompleteHandler(context.executionId, step.id, stepResult);
        }

        // Check if step has next steps
        if (step.nextSteps && step.nextSteps.length > 0) {
          // For now, continue with next step in array
          // More complex branching can be implemented here
        }
      } catch (error) {
        this.log(context, 'error', `Step ${step.id} failed: ${error}`);

        // Handle error based on step configuration
        if (step.errorHandling === 'continue') {
          context.stepsSkipped.push(step.id);
          continue;
        } else if (step.errorHandling === 'retry' && step.retryCount && step.retryCount > 0) {
          // Retry logic
          let retries = 0;
          let success = false;

          while (retries < step.retryCount && !success) {
            retries++;
            this.log(context, 'info', `Retrying step ${step.id} (attempt ${retries})`);

            try {
              const result = await this.executeStep(context, step);
              context.variables[step.id] = result;
              output = { ...output, ...result };
              success = true;
            } catch (retryError) {
              this.log(context, 'warn', `Retry ${retries} failed for step ${step.id}`);
            }
          }

          if (!success && step.required !== false) {
            throw error;
          }
        } else if (step.required !== false) {
          throw error;
        } else {
          context.stepsSkipped.push(step.id);
        }
      }
    }

    context.output = output;
    return {
      success: true,
      output,
      context,
      executionTime: Date.now() - startTime,
      stepsExecuted: context.stepsExecuted.length
    };
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    this.log(context, 'info', `Executing step: ${step.name} (${step.type})`);

    switch (step.type) {
      case StepType.ACTION:
        return await this.executeAction(context, step);

      case StepType.CONDITION:
        return await this.executeCondition(context, step);

      case StepType.LOOP:
        return await this.executeLoop(context, step);

      case StepType.PARALLEL:
        return await this.executeParallel(context, step);

      case StepType.DELAY:
        return await this.executeDelay(context, step);

      case StepType.INPUT:
        return await this.executeInput(context, step);

      case StepType.OUTPUT:
        return await this.executeOutput(context, step);

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  /**
   * Execute action step
   */
  private async executeAction(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    const handler = this.actionHandlers.get(step.action);

    if (!handler) {
      throw new Error(`No handler registered for action: ${step.action}`);
    }

    const startTime = Date.now();

    // Check timeout
    const timeout = step.timeoutMs || 30000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Action timeout')), timeout);
    });

    const result = await Promise.race([
      handler(context, step),
      timeoutPromise,
    ]) as Record<string, any>;

    const duration = Date.now() - startTime;
    this.log(context, 'debug', `Action completed in ${duration}ms`);

    return result;
  }

  /**
   * Execute condition step
   */
  private async executeCondition(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    if (!step.condition) {
      throw new Error('Condition step requires a condition expression');
    }

    // Simple condition evaluation (can be extended with proper expression parser)
    const result = this.evaluateCondition(context, step.condition);

    this.log(context, 'debug', `Condition evaluated: ${result}`);

    return { conditionResult: result };
  }

  /**
   * Execute loop step
   */
  private async executeLoop(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    const iterations = step.loopCount || 1;
    const results: any[] = [];

    for (let i = 0; i < iterations; i++) {
      this.log(context, 'debug', `Loop iteration ${i + 1}/${iterations}`);

      // Execute action for each iteration
      const loopStep: WorkflowStep = {
        ...step,
        id: `${step.id}_iter_${i}`,
        parameters: { ...step.parameters, iteration: i },
      };

      const result = await this.executeAction(context, loopStep);
      results.push(result);
    }

    return { loopResults: results };
  }

  /**
   * Execute parallel steps
   */
  private async executeParallel(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    if (!step.nextSteps || step.nextSteps.length === 0) {
      throw new Error('Parallel step requires nextSteps');
    }

    this.log(context, 'info', `Executing ${step.nextSteps.length} steps in parallel`);

    const promises = step.nextSteps.map(async (stepId) => {
      const workflow = this.getWorkflow(context.workflowId);
      if (!workflow) throw new Error('Workflow not found');

      const nextStep = workflow.steps.find((s) => s.id === stepId);
      if (!nextStep) throw new Error(`Step ${stepId} not found`);

      return await this.executeStep(context, nextStep);
    });

    const results = await Promise.all(promises);

    return { parallelResults: results };
  }

  /**
   * Execute delay step
   */
  private async executeDelay(
    _context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    const delay = step.delayMs || 1000;

    await new Promise((resolve) => setTimeout(resolve, delay));

    return { delayed: true };
  }

  /**
   * Execute input step
   */
  private async executeInput(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    // For now, input is provided in the initial context
    // Can be extended to request user input
    return { input: context.input[step.action] };
  }

  /**
   * Execute output step
   */
  private async executeOutput(
    context: WorkflowContext,
    step: WorkflowStep
  ): Promise<Record<string, any>> {
    const output = context.variables[step.action];

    this.log(context, 'info', `Output: ${JSON.stringify(output)}`);

    return { output };
  }

  // ========================================================================
  // Action Handlers
  // ========================================================================

  /**
   * Register an action handler
   */
  registerAction(action: string, handler: ActionHandler): void {
    this.actionHandlers.set(action, handler);
    logger.info(`Registered action handler: ${action}`);
  }

  /**
   * Unregister an action handler
   */
  unregisterAction(action: string): void {
    this.actionHandlers.delete(action);
    logger.info(`Unregistered action handler: ${action}`);
  }

  // ========================================================================
  // Event Handlers
  // ========================================================================

  /**
   * Set step complete event handler
   */
  onStepComplete(handler: (executionId: string, stepId: string, result: any) => void): void {
    this.stepCompleteHandler = handler;
  }

  /**
   * Set workflow complete event handler
   */
  onWorkflowComplete(handler: (executionId: string, result: WorkflowResult) => void): void {
    this.workflowCompleteHandler = handler;
  }

  /**
   * Set workflow error event handler
   */
  onWorkflowError(handler: (executionId: string, error: Error) => void): void {
    this.workflowErrorHandler = handler;
  }

  // ========================================================================
  // Execution Management
  // ========================================================================

  /**
   * Get execution context
   */
  getExecution(executionId: string): WorkflowContext | null {
    return this.executions.get(executionId) || null;
  }

  /**
   * Cancel an execution
   */
  cancelExecution(executionId: string): void {
    const context = this.executions.get(executionId);

    if (!context) {
      throw new Error(`Execution ${executionId} not found`);
    }

    context.status = WorkflowStatus.CANCELLED;
    this.log(context, 'info', 'Execution cancelled');
  }

  /**
   * Get all active executions
   */
  getActiveExecutions(): WorkflowContext[] {
    return Array.from(this.executions.values()).filter(
      (e) => e.status === WorkflowStatus.RUNNING || e.status === WorkflowStatus.PAUSED
    );
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Validate workflow definition
   */
  private validateWorkflow(workflow: WorkflowDefinition): void {
    if (!workflow.name || !workflow.description) {
      throw new Error('Workflow must have name and description');
    }

    if (!workflow.steps || workflow.steps.length === 0) {
      throw new Error('Workflow must have at least one step');
    }

    // Validate step IDs are unique
    const stepIds = new Set<string>();
    for (const step of workflow.steps) {
      if (stepIds.has(step.id)) {
        throw new Error(`Duplicate step ID: ${step.id}`);
      }
      stepIds.add(step.id);
    }

    // Validate nextSteps references
    for (const step of workflow.steps) {
      if (step.nextSteps) {
        for (const nextId of step.nextSteps) {
          if (!stepIds.has(nextId)) {
            throw new Error(`Step ${step.id} references unknown next step: ${nextId}`);
          }
        }
      }
    }
  }

  /**
   * Evaluate condition expression
   */
  private evaluateCondition(context: WorkflowContext, condition: string): boolean {
    // Simple variable substitution and evaluation
    // For production, use a proper expression parser

    try {
      // Replace variables in condition
      let evalCondition = condition;
      for (const [key, value] of Object.entries(context.variables)) {
        evalCondition = evalCondition.replace(new RegExp(`\\$${key}`, 'g'), String(value));
      }

      // Simple comparison evaluation
      // This is a basic implementation - for production, use a proper expression parser
      if (evalCondition.includes('==')) {
        const [left, right] = evalCondition.split('==');
        return left.trim() === right.trim();
      }

      if (evalCondition.includes('>')) {
        const [left, right] = evalCondition.split('>');
        return parseFloat(left.trim()) > parseFloat(right.trim());
      }

      if (evalCondition.includes('<')) {
        const [left, right] = evalCondition.split('<');
        return parseFloat(left.trim()) < parseFloat(right.trim());
      }

      // Default to true
      return true;
    } catch (error) {
      logger.error(`Condition evaluation error: ${error}`);
      return false;
    }
  }

  /**
   * Log to workflow context
   */
  private log(context: WorkflowContext, level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: any): void {
    const log: WorkflowLog = {
      timestamp: Date.now(),
      level,
      message,
      data,
    };

    context.logs.push(log);
    logger.info(`[${context.executionId}] [${level.toUpperCase()}] ${message}`, data || '');
  }

  /**
   * Update workflow statistics
   */
  private updateWorkflowStats(workflowId: string, success: boolean, duration: number): void {
    const workflow = this.workflows.get(workflowId);

    if (!workflow) return;

    const stats = workflow.metadata;
    stats.executionCount = (stats.executionCount || 0) + 1;

    if (success) {
      const successCount = stats.successRate ? stats.successRate * (stats.executionCount - 1) : 0;
      stats.successRate = (successCount + 1) / stats.executionCount;
    } else {
      const successCount = stats.successRate ? stats.successRate * (stats.executionCount - 1) : 0;
      stats.successRate = successCount / stats.executionCount;
    }

    // Update average duration
    const currentAvg = stats.averageDuration || 0;
    stats.averageDuration = (currentAvg * (stats.executionCount - 1) + duration) / stats.executionCount;
  }

  /**
   * Generate unique ID
   */
  private generateId(prefix: string): string {
    return `${prefix}_${uuidv4().substring(0, 8)}`;
  }

  // ========================================================================
  // Import/Export
  // ========================================================================

  /**
   * Export all workflows
   */
  exportWorkflows(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  /**
   * Import workflows
   */
  importWorkflows(workflows: WorkflowDefinition[]): void {
    for (const workflow of workflows) {
      this.defineWorkflow(workflow);
    }

    logger.info(`Imported ${workflows.length} workflows`);
  }
}
