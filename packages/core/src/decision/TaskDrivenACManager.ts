/**
 * Task-Driven AC Manager
 *
 * A paradigm shift from event-driven to task-driven:
 * - BEFORE: Every event -> process -> maybe LLM call (high cost)
* - AFTER: Only explicit Tasks -> LLM analysis (on-demand)
 *
 * Task Sources:
 * 1. User direct input (sendMessage, executeTask)
 * 2. Other Agents (collaboration requests)
 * 3. Environment Monitor Agent (optional - converts env changes to Tasks)
 *
 * Key Principle: LLM is ONLY called when there's a Task to process.
 * No continuous polling. No periodic monitoring.
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../environment/index.js';
import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';
import { ACNecessityAssessor, type AgentContext,
type ACNecessityAssessment, type AssessorConfig } from './ACNecessityAssessor.js';
import { PartnerSelectionNegotiator,type PartnerSelectionResult, type NegotiatorConfig } from './PartnerSelectionNegotiator.js';
import { GoalFormulationEngine,
type GoalFormulationResult,
type ACCollaborationConfig,
type GoalEngineConfig
} from './GoalFormulationEngine.js';
import { createLogger } from '@active-collaboration/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a Task that requires LLM analysis
 */
const logger = createLogger('TaskDrivenACManager');

export interface AgentTask {
  id: string;
  source: 'user' | 'agent' | 'environment';
  sourceId: string; // Who created this task

  // Task content
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  type: 'collaboration_request' | 'action_required' | 'information_query' | 'decision_needed';

  // Task context
  parameters: Record<string, any>;
  requiredCapabilities?: string[];
  deadline?: Date;

  // Metadata
  createdAt: Date;
  expiresAt?: Date;
  status: 'pending' | 'processing' | 'completed' | 'expired';

  // Result (filled after processing)
  result?: TaskResult;
}

/**
 * Result of task processing
 */
export interface TaskResult {
  success: boolean;
  action: 'initiate_ac' | 'handle_independently' | 'defer' | 'reject';
  reasoning: string;
  acConfig?: ACCollaborationConfig;
  error?: string;
}

/**
 * Configuration for TaskDrivenACManager
 */
export interface TaskDrivenConfig {
  // Task queue settings
  maxQueueSize: number;
  taskTimeout: number; // milliseconds

  // Processing settings
  maxConcurrentTasks: number;
  batchSize: number;

  // Layer 2 configuration
  layer2: {
    assessor: Partial<AssessorConfig>;
    negotiator: Partial<NegotiatorConfig>;
    goalEngine: Partial<GoalEngineConfig>;
  };

  // Callbacks
  onTaskCompleted?: (task: AgentTask, result: TaskResult) => void;
  onACInitiated?: (config: ACCollaborationConfig, task: AgentTask) => Promise<void>;
}

const DEFAULT_CONFIG: TaskDrivenConfig = {
  maxQueueSize: 100,
  taskTimeout: 30 * 60 * 1000, // 30 minutes
  maxConcurrentTasks: 3,
  batchSize: 5,
  layer2: {
    assessor: {},
    negotiator: {},
    goalEngine: {},
  },
};

/**
 * Callback when AC is initiated from a task
 */
export type TaskACInitiationCallback = (config: ACCollaborationConfig, task: AgentTask) => Promise<void>;

// ============================================================================
// TaskQueue - Manages pending tasks
// ============================================================================

export class TaskQueue {
  private queue: AgentTask[] = [];
  private maxSize: number;
  private timeout: number;

  constructor(maxSize: number = 100, timeout: number = 30 * 60 * 1000) {
    this.maxSize = maxSize;
    this.timeout = timeout;
  }

  /**
   * Add a task to the queue
   */
  enqueue(task: AgentTask): boolean {
    // Check queue size
    if (this.queue.length >= this.maxSize) {
      logger.warn('[TaskQueue] Queue full, rejecting task:', task.id);
      return false;
    }

    // Check for duplicates
    const existing = this.queue.find(t =>
      t.title === task.title &&
      t.source === task.source &&
      t.status === 'pending'
    );

    if (existing) {
      logger.info('[TaskQueue] Duplicate task, updating priority:', task.id);
      // Update priority if new one is higher
      const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
      if (priorityOrder[task.priority] > priorityOrder[existing.priority]) {
        existing.priority = task.priority;
      }
      return true;
    }

    // Add new task
    task.status = 'pending';
    task.createdAt = new Date();
    task.expiresAt = new Date(Date.now() + this.timeout);

    this.queue.push(task);
    logger.info(`[TaskQueue] Task enqueued: ${task.id} (${task.title})`);

    return true;
  }

  /**
   * Get next task to process
   */
  dequeue(): AgentTask | null {
    // Remove expired tasks
    this.removeExpired();

    // Sort by priority and creation time
    this.queue.sort((a, b) => {
      const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // Get first pending task
    const task = this.queue.find(t => t.status === 'pending');
    if (task) {
      task.status = 'processing';
      return task;
    }

    return null;
  }

  /**
   * Get batch of tasks to process
   */
  dequeueBatch(size: number): AgentTask[] {
    const batch: AgentTask[] = [];
    for (let i = 0; i < size; i++) {
      const task = this.dequeue();
      if (task) {
        batch.push(task);
      } else {
        break;
      }
    }
    return batch;
  }

  /**
   * Mark task as completed
   */
  complete(taskId: string, result: TaskResult): void {
    const task = this.queue.find(t => t.id === taskId);
    if (task) {
      task.status = 'completed';
      task.result = result;
      logger.info(`[TaskQueue] Task completed: ${taskId} -> ${result.action}`);
    }
  }

  /**
   * Remove expired tasks
   */
  private removeExpired(): void {
    const now = new Date();
    const expired = this.queue.filter(t =>
      t.expiresAt && t.expiresAt < now && t.status === 'pending'
    );

    for (const task of expired) {
      task.status = 'expired';
      logger.info(`[TaskQueue] Task expired: ${task.id}`);
    }

    // Remove completed/expired tasks older than 5 minutes
    const cutoff = new Date(now.getTime() - 5 * 60 * 1000);
    this.queue = this.queue.filter(t =>
      t.status === 'pending' || t.status === 'processing' ||
      (t.createdAt > cutoff)
    );
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    expired: number;
  } {
    return {
      total: this.queue.length,
      pending: this.queue.filter(t => t.status === 'pending').length,
      processing: this.queue.filter(t => t.status === 'processing').length,
      completed: this.queue.filter(t => t.status === 'completed').length,
      expired: this.queue.filter(t => t.status === 'expired').length,
    };
  }

  /**
   * Clear all tasks
   */
  clear(): void {
    this.queue = [];
    logger.info('[TaskQueue] Queue cleared');
  }
}

// ============================================================================
// TaskDrivenACManager - Task-driven AC initiation
// ============================================================================

export class TaskDrivenACManager {
  private config: TaskDrivenConfig;
  private agentId: string;
  private agentName: string;
  private agentCapabilities: string[];
  private llmClient: LLMClient;
  private environment: EnvironmentCenter;

  // Task queue
  private taskQueue: TaskQueue;

  // Layer 2 components (only created when needed)
  private acNecessityAssessor: ACNecessityAssessor | null = null;
  private partnerNegotiator: PartnerSelectionNegotiator | null = null;
  private goalEngine: GoalFormulationEngine | null = null;

  // Callbacks
  private onACInitiation: TaskACInitiationCallback;

  // Agent devices
  private agentDevices: Array<{
    deviceId: string;
    type: string;
    capabilities: string[];
  }> = [];

  // Statistics
  private stats = {
    tasksReceived: 0,
    tasksProcessed: 0,
    tasksExpired: 0,
    acInitiated: 0,
    handledIndependently: 0,
    llmCalls: 0,  // Track LLM usage!
  };

  // Processing state
  private isProcessing: boolean = false;
  private processingLock: Promise<void> = Promise.resolve();

  constructor(
    agentId: string,
    agentName: string,
    agentCapabilities: string[],
    llmClient: LLMClient,
    environment: EnvironmentCenter,
    onACInitiation: TaskACInitiationCallback,
    config: Partial<TaskDrivenConfig> = {}
  ) {
    this.agentId = agentId;
    this.agentName = agentName;
    this.agentCapabilities = agentCapabilities;
    this.llmClient = llmClient;
    this.environment = environment;
    this.onACInitiation = onACInitiation;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize task queue
    this.taskQueue = new TaskQueue(
      this.config.maxQueueSize,
      this.config.taskTimeout
    );

    logger.info(`Initialized for agent ${agentName}`);
    logger.info(`Task-driven mode: LLM only called when tasks exist`);
  }

  /**
   * Set agent devices
   */
  setAgentDevices(devices: Array<{
    deviceId: string;
    type: string;
    capabilities: string[];
  }>): void {
    this.agentDevices = devices;
    logger.info(`Agent devices updated: ${devices.length} devices`);
  }

  /**
   * Submit a task for processing
   *
   * This is the MAIN ENTRY POINT for task-driven AC.
   * LLM will ONLY be called when this method is invoked with a task.
   */
  async submitTask(task: Omit<AgentTask, 'id' | 'createdAt' | 'status'>): Promise<TaskResult> {
    const fullTask: AgentTask = {
      ...task,
      id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date(),
      status: 'pending',
    };

    this.stats.tasksReceived++;

    logger.info(`Task submitted: ${fullTask.id}`);
    logger.info(`Task: ${task.title} (source: ${task.source}, priority: ${task.priority})`);

    // Add to queue
    const enqueued = this.taskQueue.enqueue(fullTask);
    if (!enqueued) {
      return {
        success: false,
        action: 'reject',
        reasoning: 'Task queue is full',
      };
    }

    // Process immediately (task-driven, not event-driven)
    return this.processTask(fullTask);
  }

  /**
   * Process a single task
   *
   * This is where LLM is called - ONLY when processing a task.
   */
  private async processTask(task: AgentTask): Promise<TaskResult> {
    logger.info(`Processing task: ${task.id}`);

    try {
      // Initialize Layer 2 components lazily (only when needed)
      this.ensureLayer2Components();

      // Build agent context
      const agentContext = await this.buildAgentContext();

      // Convert task to cluster summary for Layer 2
      const clusterSummary = this.taskToClusterSummary(task);

      // STEP 1: Assess AC necessity using LLM
      this.stats.llmCalls++;
      logger.info(`Calling LLM for task assessment...`);

      const assessment = await this.acNecessityAssessor!.assess(
        clusterSummary,
        agentContext
      );

      logger.info(`Assessment result: ${assessment.decision}`);
      logger.info(`LLM reasoning: ${assessment.llmAssessment.reasoning}`);

      // Handle based on decision
      let result: TaskResult;

      if (assessment.decision === 'initiate_ac') {
        result = await this.initiateAC(assessment, task);
      } else if (assessment.decision === 'handle_independently') {
        result = {
          success: true,
          action: 'handle_independently',
          reasoning: assessment.llmAssessment.reasoning,
        };
        this.stats.handledIndependently++;
      } else if (assessment.decision === 'defer') {
        result = {
          success: true,
          action: 'defer',
          reasoning: assessment.llmAssessment.reasoning,
        };
      } else {
        result = {
          success: true,
          action: 'reject',
          reasoning: assessment.llmAssessment.reasoning,
        };
      }

      // Mark task as completed
      this.taskQueue.complete(task.id, result);
      this.stats.tasksProcessed++;

      // Callback
      if (this.config.onTaskCompleted) {
        this.config.onTaskCompleted(task, result);
      }

      return result;

    } catch (error) {
      logger.error(`Error processing task ${task.id}:`, error);

      const result: TaskResult = {
        success: false,
        action: 'reject',
        reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };

      this.taskQueue.complete(task.id, result);

      return result;
    }
  }

  /**
   * Initiate AC from task
   */
  private async initiateAC(
    assessment: ACNecessityAssessment,
    task: AgentTask
  ): Promise<TaskResult> {
    logger.info(`Initiating AC for task: ${task.title}`);

    if (!this.partnerNegotiator || !this.goalEngine) {
      return {
        success: false,
        action: 'reject',
        reasoning: 'Layer 2 components not available',
      };
    }

    try {
      // Find partners (may call LLM)
      this.stats.llmCalls++;
      const partnerSelection = await this.partnerNegotiator.findPartners(assessment);

      if (partnerSelection.selectedPartners.length === 0) {
        logger.warn('No partners found for AC');
        return {
          success: true,
          action: 'defer',
          reasoning: 'No suitable partners found for collaboration',
        };
      }

      logger.info(`Found ${partnerSelection.selectedPartners.length} partners`);

      // Formulate goals (may call LLM)
      this.stats.llmCalls++;
      const goalFormulation = await this.goalEngine.formulateGoals(
        assessment,
        partnerSelection,
        this.environment
      );

      logger.info(`Goals formulated: ${goalFormulation.primaryGoal.name}`);

      // Create AC config
      const acConfig = goalFormulation.config;

      // Update stats
      this.stats.acInitiated++;

      // Notify via callback
      await this.onACInitiation(acConfig, task);

      logger.info(`AC ${acConfig.id} initiated from task ${task.id}`);

      return {
        success: true,
        action: 'initiate_ac',
        reasoning: `AC initiated: ${goalFormulation.primaryGoal.name}`,
        acConfig,
      };

    } catch (error) {
      logger.error('Error initiating AC:', error);
      return {
        success: false,
        action: 'reject',
        reasoning: `Failed to initiate AC: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Ensure Layer 2 components are initialized
   */
  private ensureLayer2Components(): void {
    if (!this.acNecessityAssessor) {
      this.acNecessityAssessor = new ACNecessityAssessor(
        this.config.layer2.assessor,
        this.llmClient
      );
      logger.info('Layer 2 Assessor initialized (lazy)');
    }

    if (!this.partnerNegotiator) {
      this.partnerNegotiator = new PartnerSelectionNegotiator(
        this.config.layer2.negotiator,
        this.environment,
        this.llmClient
      );
      logger.info('Layer 2 Negotiator initialized (lazy)');
    }

    if (!this.goalEngine) {
      this.goalEngine = new GoalFormulationEngine(
        this.config.layer2.goalEngine,
        this.environment,
        this.llmClient
      );
      logger.info('Layer 2 GoalEngine initialized (lazy)');
    }
  }

  /**
   * Build agent context for Layer 2
   */
  private async buildAgentContext(): Promise<AgentContext> {
    let availableResources;

    if (this.agentDevices.length > 0) {
      availableResources = this.agentDevices;
    } else {
      const devices = this.environment.listDevices();
      availableResources = devices.slice(0, 10).map(d => ({
        deviceId: d.id,
        type: d.type || 'unknown',
        capabilities: (d.capabilities || []).map(c =>
          typeof c === 'string' ? c : c.name || c.type || String(c)
        ),
      }));
    }

    return {
      agentId: this.agentId,
      agentName: this.agentName,
      capabilities: this.agentCapabilities,
      availableResources,
      currentWorkload: 'idle', // Task-driven mode doesn't track continuous workload
      recentCollaborations: [],
      currentCollaborations: 0,
    };
  }

  /**
   * Convert task to cluster summary for Layer 2 processing
   */
  private taskToClusterSummary(task: AgentTask): SpatialClusterSummary {
    const isUrgent = task.priority === 'urgent' || task.priority === 'high';

    return {
      clusterId: task.id,
      region: {
        id: 'task-region',
        center: task.parameters?.location || { x: 0, y: 0 },
        radius: 10,
        type: 'zone',
      },
      timeWindow: new Date().toISOString(),
      significance: isUrgent ? 'high' : 'medium',
      summary: `${task.title}: ${task.description}`,
      findings: [{
        eventType: task.type,
        count: 1,
        trend: 'stable',
        anomaly: isUrgent,
        details: {
          ...task.parameters,
          taskTitle: task.title,
          taskDescription: task.description,
          taskSource: task.source,
          requiredCapabilities: task.requiredCapabilities || [],
        },
      }],
      recommendation: isUrgent ? 'immediate_action' : 'evaluate_with_llm',
    };
  }

  /**
   * Process batch of tasks
   */
  async processBatch(size?: number): Promise<TaskResult[]> {
    const batchSize = size || this.config.batchSize;
    const batch = this.taskQueue.dequeueBatch(batchSize);

    if (batch.length === 0) {
      logger.info('No tasks to process');
      return [];
    }

    logger.info(`Processing batch of ${batch.length} tasks`);

    const results: TaskResult[] = [];
    for (const task of batch) {
      const result = await this.processTask(task);
      results.push(result);
    }

    return results;
  }

  /**
   * Get pending task count
   */
  getPendingTaskCount(): number {
    return this.taskQueue.getStats().pending;
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats & { queueStats: ReturnType<TaskQueue['getStats']> } {
    return {
      ...this.stats,
      queueStats: this.taskQueue.getStats(),
    };
  }

  /**
   * Clear all pending tasks
   */
  clearQueue(): void {
    this.taskQueue.clear();
    logger.info('Task queue cleared');
  }
}

export default TaskDrivenACManager;
