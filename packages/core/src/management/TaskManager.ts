/**
 * Task Manager
 *
 * Middle layer component for task decomposition and execution
 * Handles task planning, delegation, and monitoring
 */

import { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
/**
 * Task priority
 */
const logger = createLogger('TaskManager');

export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Task status
 */
export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * Task definition
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedTo?: string; // Agent ID
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  deadline?: Date;
  dependencies: string[]; // Task IDs that must complete first
  subtasks: Task[];
  result?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
}

/**
 * Task execution context
 */
export interface TaskExecutionContext {
  taskId: string;
  resources: string[]; // Available resource IDs
  agents: string[]; // Available agent IDs
  environment: string; // Environment center ID
  params: Record<string, unknown>;
}

/**
 * Task execution result
 */
export interface TaskExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  completedSubtasks: string[];
  failedSubtasks: string[];
}

/**
 * SubTask interface for LLM-based decomposition
 */
export interface SubTask {
  description: string;
  estimatedDuration?: number;
  requiredCapabilities?: string[];
  dependencies?: string[];
}

/**
 * Task Manager handles task decomposition and execution
 */
export class TaskManager {
  private tasks: Map<string, Task>;
  private taskCounter: number;
  private llmClient?: LLMClient;

  constructor(llmClient?: LLMClient) {
    this.tasks = new Map();
    this.taskCounter = 0;
    this.llmClient = llmClient;
    logger.info('Initialized' + (llmClient ? ' with LLM client' : ''));
  }

  /**
   * Create a new task
   * @param title - Task title
   * @param description - Task description
   * @param options - Task options
   * @returns Created task
   */
  createTask(
    title: string,
    description: string,
    options: {
      priority?: TaskPriority;
      deadline?: Date;
      dependencies?: string[];
      subtasks?: Omit<Task, 'id' | 'createdAt' | 'status' | 'subtasks'>[];
      metadata?: Record<string, unknown>;
    } = {}
  ): Task {
    const task: Task = {
      id: this.generateTaskId(),
      title,
      description,
      priority: options.priority || TaskPriority.MEDIUM,
      status: TaskStatus.PENDING,
      createdAt: new Date(),
      dependencies: options.dependencies || [],
      subtasks: (options.subtasks || []).map((st) => ({
        ...st,
        id: this.generateTaskId(),
        status: TaskStatus.PENDING,
        createdAt: new Date(),
        subtasks: [],
      })),
      metadata: options.metadata || {},
    };

    if (options.deadline) {
      task.deadline = options.deadline;
    }

    this.tasks.set(task.id, task);

    logger.info(`Task created: ${task.id} - ${task.title}`);

    return task;
  }

  /**
   * Decompose a complex task into subtasks
   * Uses LLM to break down tasks
   * @param taskId - Task ID to decompose
   * @param _context - Execution context (unused in MVP)
   * @returns Array of subtasks
   */
  async decomposeTask(
    taskId: string,
    _context: TaskExecutionContext
  ): Promise<Task[]> {
    logger.info(`Decomposing task: ${taskId}`);

    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error(`Task not found: ${taskId}`);
      return [];
    }

    // For now, create simple subtasks based on task description
    // In full implementation, this would use LLM to intelligently decompose

    const subtasks: Task[] = [];

    // Example decomposition logic
    if (task.description.toLowerCase().includes('and')) {
      // Split by "and" for simple decomposition
      const parts = task.description.split(/\s+and\s+/i);

      for (const part of parts) {
        const subtask = this.createTask(
          `${task.title} - Part ${subtasks.length + 1}`,
          part.trim(),
          {
            priority: task.priority,
            metadata: { parentTask: taskId },
          }
        );
        subtasks.push(subtask);
      }
    }

    task.subtasks = subtasks;

    logger.info(`Task decomposed into ${subtasks.length} subtasks`);

    return subtasks;
  }

  /**
   * Decompose a complex task using LLM
   * Uses LLM to intelligently break down complex tasks into subtasks
   * @param taskId - Task ID to decompose
   * @param context - Execution context (provides available capabilities)
   * @param useLLM - Whether to use LLM (default: true)
   * @returns Array of subtasks
   */
  async decomposeTaskComplex(
    taskId: string,
    context: TaskExecutionContext,
    useLLM: boolean = true
  ): Promise<Task[]> {
    logger.info(`Decomposing task with ${useLLM ? 'LLM' : 'simple'} method: ${taskId}`);

    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error(`Task not found: ${taskId}`);
      return [];
    }

    // If LLM not requested or not available, fall back to simple decomposition
    if (!useLLM || !this.llmClient) {
      logger.info(`Using simple decomposition (LLM ${!useLLM ? 'not requested' : 'not available'})`);
      return this.decomposeTask(taskId, context);
    }

    try {
      // Build LLM prompt
      const prompt = this.buildDecompositionPrompt(task, context);

      // Call LLM
      logger.info(`Calling LLM for task decomposition...`);
      const response = await this.llmClient.chat({
        messages: [
          {
            role: 'system',
            content: 'You are a task planning expert. Break down complex tasks into clear, actionable subtasks. Always respond with valid JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        maxTokens: 2000,
        temperature: 0.3,
      });

      // Parse LLM response
      const content = response.content || '';
      logger.info(`LLM response received: ${content.substring(0, 200)}...`);

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`Could not extract JSON from LLM response, falling back to simple decomposition`);
        return this.decomposeTask(taskId, context);
      }

      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      // Validate response structure
      if (!parsed.subtasks || !Array.isArray(parsed.subtasks)) {
        logger.warn(`Invalid LLM response structure, falling back to simple decomposition`);
        return this.decomposeTask(taskId, context);
      }

      // Create Task objects from LLM subtasks
      const subtasks: Task[] = [];
      for (let i = 0; i < parsed.subtasks.length; i++) {
        const st: Record<string, unknown> = parsed.subtasks[i];
        const subtask = this.createTask(
          `${task.title} - Subtask ${i + 1}`,
          (st.description || st.task || `Subtask ${i + 1}`) as string,
          {
            priority: task.priority,
            dependencies: (st.dependencies || []) as string[],
            metadata: {
              parentTask: taskId,
              estimatedDuration: st.estimatedDuration,
              requiredCapabilities: st.requiredCapabilities || [],
            },
          }
        );
        subtasks.push(subtask);
      }

      task.subtasks = subtasks;
      logger.info(`Task decomposed into ${subtasks.length} subtasks using LLM`);

      return subtasks;
    } catch (error) {
      logger.error(`LLM decomposition failed:`, error);
      logger.info(`Falling back to simple decomposition`);
      return this.decomposeTask(taskId, context);
    }
  }

  /**
   * Build prompt for LLM-based task decomposition
   * @param task - Task to decompose
   * @param context - Execution context
   * @returns Prompt string
   */
  private buildDecompositionPrompt(task: Task, context: TaskExecutionContext): string {
    return `You are a task decomposition expert. Please break down the following task into clear, actionable subtasks.

**Task to Decompose:**
Title: ${task.title}
Description: ${task.description}
Priority: ${task.priority}

**Available Resources:**
${context.resources.length > 0 ? context.resources.map((r, i) => `${i + 1}. ${r}`).join('\n') : 'No specific resources listed'}

**Available Agents:**
${context.agents.length > 0 ? context.agents.map((a, i) => `${i + 1}. ${a}`).join('\n') : 'No specific agents listed'}

**Instructions:**
1. Break the task into 3-7 clear, sequential subtasks
2. Each subtask should be specific and actionable
3. Estimate duration for each subtask (in seconds)
4. List required capabilities for each subtask (e.g., "device_control", "environment_observation", "llm_reasoning")
5. Identify dependencies between subtasks (which subtasks must complete before others)

**Output Format (JSON):**
\`\`\`json
{
  "subtasks": [
    {
      "description": "Clear description of what this subtask accomplishes",
      "estimatedDuration": 300,
      "requiredCapabilities": ["capability1", "capability2"],
      "dependencies": []
    }
  ]
}
\`\`\`

Please decompose the task now.`;
  }

  /**
   * Assign a task to an agent
   * @param taskId - Task ID
   * @param agentId - Agent ID to assign to
   * @returns True if assigned successfully
   */
  assignTask(taskId: string, agentId: string): boolean {
    logger.info(`Assigning task ${taskId} to agent ${agentId}`);

    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error(`Task not found: ${taskId}`);
      return false;
    }

    // Check dependencies
    if (!this.areDependenciesMet(task)) {
      logger.info(`Task dependencies not met for ${taskId}`);
      return false;
    }

    task.assignedTo = agentId;
    task.status = TaskStatus.IN_PROGRESS;
    task.startedAt = new Date();

    logger.info(`Task assigned: ${taskId} -> ${agentId}`);

    return true;
  }

  /**
   * Complete a task
   * @param taskId - Task ID
   * @param result - Task result
   * @returns True if completed successfully
   */
  completeTask(taskId: string, result?: unknown): boolean {
    logger.info(`Completing task: ${taskId}`);

    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error(`Task not found: ${taskId}`);
      return false;
    }

    task.status = TaskStatus.COMPLETED;
    task.completedAt = new Date();
    task.result = result;

    logger.info(`Task completed: ${taskId}`);

    return true;
  }

  /**
   * Fail a task
   * @param taskId - Task ID
   * @param error - Error message
   * @returns True if failed successfully
   */
  failTask(taskId: string, error: string): boolean {
    logger.info(`Failing task: ${taskId} - ${error}`);

    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error(`Task not found: ${taskId}`);
      return false;
    }

    task.status = TaskStatus.FAILED;
    task.completedAt = new Date();
    task.error = error;

    logger.info(`Task failed: ${taskId}`);

    return true;
  }

  /**
   * Cancel a task
   * @param taskId - Task ID
   * @returns True if cancelled successfully
   */
  cancelTask(taskId: string): boolean {
    logger.info(`Cancelling task: ${taskId}`);

    const task = this.tasks.get(taskId);
    if (!task) {
      logger.error(`Task not found: ${taskId}`);
      return false;
    }

    if (task.status === TaskStatus.COMPLETED) {
      logger.info(`Cannot cancel completed task: ${taskId}`);
      return false;
    }

    task.status = TaskStatus.CANCELLED;

    logger.info(`Task cancelled: ${taskId}`);

    return true;
  }

  /**
   * Get a task by ID
   * @param taskId - Task ID
   * @returns Task or undefined
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   * @returns Array of all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   * @param status - Task status
   * @returns Array of tasks with the status
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter((t) => t.status === status);
  }

  /**
   * Get tasks by agent
   * @param agentId - Agent ID
   * @returns Array of tasks assigned to the agent
   */
  getTasksByAgent(agentId: string): Task[] {
    return this.getAllTasks().filter((t) => t.assignedTo === agentId);
  }

  /**
   * Get pending tasks ordered by priority
   * @returns Array of pending tasks
   */
  getPendingTasks(): Task[] {
    return this.getTasksByStatus(TaskStatus.PENDING).sort((a, b) => {
      const priorityOrder = {
        [TaskPriority.URGENT]: 0,
        [TaskPriority.HIGH]: 1,
        [TaskPriority.MEDIUM]: 2,
        [TaskPriority.LOW]: 3,
      };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Check if task dependencies are met
   * @param task - Task to check
   * @returns True if dependencies are met
   */
  private areDependenciesMet(task: Task): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== TaskStatus.COMPLETED) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get task statistics
   * @returns Statistics object
   */
  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    overdue: number;
  } {
    const tasks = this.getAllTasks();

    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    let overdue = 0;
    const now = new Date();

    for (const task of tasks) {
      // Count by status
      byStatus[task.status] = (byStatus[task.status] || 0) + 1;

      // Count by priority
      byPriority[task.priority] = (byPriority[task.priority] || 0) + 1;

      // Count overdue
      if (
        task.deadline &&
        task.status !== TaskStatus.COMPLETED &&
        task.deadline < now
      ) {
        overdue++;
      }
    }

    return {
      total: tasks.length,
      byStatus,
      byPriority,
      overdue,
    };
  }

  /**
   * Clear all tasks
   */
  clear(): void {
    logger.info('Clearing all tasks');
    this.tasks.clear();
  }

  /**
   * Generate unique task ID
   * @returns Task ID
   */
  private generateTaskId(): string {
    return `task-${++this.taskCounter}-${Date.now()}`;
  }
}
