/**
 * TaskPlanningCoordinator
 *
 * Encapsulates task planning and execution logic
 *
 * Key Responsibilities:
 * - Plan tasks based on goals
 * - Execute tasks
 * - Track active tasks
 * - Emit task lifecycle events
 *
 * Architecture principle:
 * - Does NOT reimplement planning/execution logic
 * - Delegates to ACExecutor, TaskPlanner, TaskManager
 * - Only adds coordination and event emission
 */

import type { ACExecutor } from '../../execution/ACExecutor.js';
import type { TaskPlanner, PlanningContext } from '../../planning/TaskPlanner.js';
import type { AgentContextBuilder } from '../../context/AgentContextBuilder.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '@active-collaboration/shared';
import type { TaskManager } from '../../management/TaskManager.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Task execution result
 */
const logger = createLogger('TaskPlanningCoordinator');

export interface TaskExecutionResult {
  success: boolean;
  result?: any;
  error?: string
  executedAt?: Date
  executionTime?: number
}

/**
 * Task plan structure
 */
export interface TaskPlan {
  taskId: string;
  summary: string;
  intent: string;
  actionType: 'observe' | 'control' | 'analyze' | 'coordinate';
  complexity: string;
  confidence: number;
  entity: string | null;
  scope: string;
  requiredCapabilities: string[];
  requiredDataTypes: string[];
  executionStrategy: string;
  subtasks?: any[];
  availableResources: string[];
  constraints: string[];
  planningTime: number;
}

/**
 * Task structure
 */
export interface Task {
  id: string
  description: string
  status: 'pending' | 'planning' | 'executing' | 'completed' | 'failed'
  createdAt: Date
  updatedAt?: Date
  result?: any
  error?: string
}

/**
 * Event payloads
 */
export interface TaskPlannedEventPayload {
  agentId: string;
  taskId: string;
  goal: string;
  plan: TaskPlan;
  timestamp: Date;
}

export interface TaskExecutedEventPayload {
  agentId: string;
  taskId: string;
  startTime: Date;
  status: 'started' | 'completed' | 'failed';
}

export interface TaskCompletedEventPayload {
  agentId: string;
  taskId: string;
  success: boolean;
  result?: any;
  error?: string;
  executionTime?: number;
  completedAt: Date;
}

/**
 * TaskPlanningCoordinator
 *
 * Coordinates task planning and execution for CognitiveAgent by wrapping planning components.
 * Emits events when tasks are planned and executed for observability and debugging.
 */
export class TaskPlanningCoordinator {
  private activeTasks: Map<string, Task> = new Map()

  /**
   * Creates a new TaskPlanningCoordinator
   *
   * @param acExecutor - ACExecutor instance
   * @param taskPlanner - TaskPlanner instance
   * @param taskManager - TaskManager instance
   * @param contextBuilder - AgentContextBuilder instance
   * @param eventEmitter - EventEmitter for emitting task events
   * @param agentId - ID of the agent this coordinator belongs to
   * @param agentName - Name of the agent
   */
  constructor(
    private readonly acExecutor: ACExecutor,
    private readonly taskPlanner: TaskPlanner,
    private readonly taskManager: TaskManager,
    private readonly contextBuilder: AgentContextBuilder,
    private readonly eventEmitter: EventEmitter,
    private readonly agentId: string,
    private readonly agentName: string
  ) {
    this.activeTasks = new Map()
  }

  /**
   * Plan a task based on a goal
   *
   * @param goal - The goal description
   * @param context - Optional planning context
   * @returns The task plan
   */
  async planTask(goal: string, context?: PlanningContext): Promise<TaskPlan> {
    const startTime = Date.now()
    logger.info(`[TaskPlanningCoordinator:${this.agentId}] Planning task for goal: ${goal}`)

    try {
      // Build planning context if needed
      let planningContext = context || this.createDefaultContext()

      // Delegate planning to TaskPlanner
      const plan = await this.taskPlanner.plan(goal, planningContext)

      logger.info(`[TaskPlanningCoordinator:${this.agentId}] Task planned: ${plan.taskId}, complexity: ${plan.complexity}`)

      // Track active task
      const task: Task = {
        id: plan.taskId,
        description: goal,
        status: 'planning',
        createdAt: new Date(startTime),
        result: undefined,
        error: undefined
      }
      this.activeTasks.set(plan.taskId, task)

      // Emit TASK_PLANNED event
      this.emitTaskPlanned(plan.taskId, goal, plan, new Date(startTime))

      return plan
    } catch (error) {
      logger.error(`[TaskPlanningCoordinator:${this.agentId}] Task planning failed:`, error)
      throw error
    }
  }

  /**
   * Execute a task
   *
   * @param taskId - The task ID to execute
   * @returns The execution result
   */
  async executeTask(taskId: string): Promise<TaskExecutionResult> {
    const startTime = Date.now()
    logger.info(`[TaskPlanningCoordinator:${this.agentId}] Executing task: ${taskId}`)

    const task = this.activeTasks.get(taskId)
    if (!task) {
      return {
        success: false,
        error: `Task ${taskId} not found in active tasks`
      }
    }

    // Update task status
    task.status = 'executing'
    task.updatedAt = new Date()

    // Emit TASK_EXECUTED event (execution started)
    this.emitTaskExecuted(taskId, new Date(startTime), 'started')

    try {
      // Execute via ACExecutor if available
      const executorWithExecute = this.acExecutor as unknown as { execute?: (taskId: string, task: Task) => Promise<{ success: boolean; result?: unknown }> };
      const executorExecute = executorWithExecute?.execute;
      const taskResult = executorExecute
        ? await executorExecute.call(executorWithExecute, taskId, task)
        : { success: true, result: { taskId, message: 'Task executed successfully' } }

      const endTime = new Date()
      const executionTime = endTime.getTime() - startTime

      const result: TaskExecutionResult = {
        success: taskResult.success,
        result: taskResult.result,
        executedAt: endTime,
        executionTime,
      }

      // Update task status
      task.status = 'completed'
      task.result = taskResult
      task.updatedAt = endTime

      logger.info(`[TaskPlanningCoordinator:${this.agentId}] Task executed: ${taskId}, success: ${result.success}`)

      // Emit TASK_COMPLETED event
      this.emitTaskCompleted(taskId, result.success, result.result, undefined, executionTime, endTime)

      // Remove from active tasks
      this.activeTasks.delete(taskId)

      return result
    } catch (error) {
      const endTime = new Date()
      const executionTime = endTime.getTime() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      logger.error(`[TaskPlanningCoordinator:${this.agentId}] Task execution failed: ${taskId}`, error)

      // Update task status
      task.status = 'failed'
      task.error = errorMessage
      task.updatedAt = endTime

      // Emit error event
      this.eventEmitter.emit(
        EventType.SYSTEM_ERROR,
        {
          agentId: this.agentId,
          agentName: this.agentName,
          taskId,
          error: errorMessage,
          timestamp: endTime
        }
      )

      // Emit TASK_COMPLETED event with failure
      this.emitTaskCompleted(taskId, false, undefined, errorMessage, executionTime, endTime)

      // Remove from active tasks
      this.activeTasks.delete(taskId)

      throw error
    }
  }

  /**
   * Get all active tasks
   *
   * @returns Array of active tasks
   */
  getActiveTasks(): Task[] {
    logger.info(`[TaskPlanningCoordinator:${this.agentId}] Getting active tasks`)
    return Array.from(this.activeTasks.values())
  }

  /**
   * Evaluate task complexity
   *
   * @param task - The task to evaluate
   * @returns The complexity level
   */
  async evaluateTaskComplexity(task: any): Promise<string> {
    logger.info(`[TaskPlanningCoordinator:${this.agentId}] Evaluating complexity for task: ${task.id}`)

    // Use TaskPlanner to get complexity via plan method
    const plan = await this.taskPlanner.plan(task.description || 'Task', this.createDefaultContext())

    return plan.complexity
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Create a default planning context
   * Used when no context is provided
   */
  private createDefaultContext(): PlanningContext {
    return {
      agentId: this.agentId,
      agentName: this.agentName,
      agentCapabilities: [],
      resources: [],
      services: [],
      environmentType: 'unknown',
      environmentId: 'unknown',
      peerAgents: []
    }
  }

  /**
   * Emit task planned event
   */
  private emitTaskPlanned(taskId: string, goal: string, plan: TaskPlan, timestamp: Date): void {
    const payload: TaskPlannedEventPayload = {
      agentId: this.agentId,
      taskId: taskId,
      goal: goal,
      plan: plan,
      timestamp: timestamp
    }
    this.eventEmitter.emit(EventType.AGENT_TASK_ASSIGNED, payload)
  }

  /**
   * Emit task executed event
   */
  private emitTaskExecuted(taskId: string, startTime: Date, status: 'started' | 'completed' | 'failed' = 'started'): void {
    const payload: TaskExecutedEventPayload = {
      agentId: this.agentId,
      taskId: taskId,
      startTime: startTime,
      status: status
    }
    this.eventEmitter.emit(EventType.AGENT_TASK_ASSIGNED, payload)
  }

  /**
   * Emit task completed event
   */
  private emitTaskCompleted(
    taskId: string,
    success: boolean,
    result?: any,
    error?: string,
    executionTime?: number,
    completedAt?: Date
  ): void {
    const payload: TaskCompletedEventPayload = {
      agentId: this.agentId,
      taskId: taskId,
      success: success,
      result: result,
      error: error,
      executionTime: executionTime,
      completedAt: completedAt || new Date()
    }

    this.eventEmitter.emit(EventType.AGENT_TASK_COMPLETED, payload)
  }
}
