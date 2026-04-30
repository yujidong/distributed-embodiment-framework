/**
 * ModelStrategy - Intelligent Model Selection System
 *
 * Automatically selects the best model based on task type, complexity,
 * and available models. Handles fallback and model health monitoring.
 *
 * IMPORTANT: Supports strict mode to fail early instead of silent fallback.
 * - strictMode: true (default) - Throws error when model not available
 * - strictMode: false - Uses fallback silently (legacy behavior)
 */

import {
  TaskType,
  TaskComplexity,
  ModelStrategyConfig,
  TaskMetadata,
  ModelSelection,
  DefaultModelConfigs,
} from './model-config';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ModelStrategy');

/**
 * Error thrown when model selection fails in strict mode
 */
export class ModelSelectionError extends Error {
  constructor(
    message: string,
    public readonly requestedModel: string,
    public readonly availableModels: string[],
    public readonly taskType: TaskType
  ) {
    super(message);
    this.name = 'ModelSelectionError';
  }
}

export class ModelStrategy {
  private config: ModelStrategyConfig;
  private modelHealth: Map<string, boolean> = new Map();
  private modelLoadTime: Map<string, number> = new Map();
  private usageStats: Map<string, { count: number; errors: number }> = new Map();
  private strictMode: boolean;

  constructor(config?: Partial<ModelStrategyConfig> & { strictMode?: boolean }) {
    // Default to OLLAMA configuration
    this.config = {
      ...DefaultModelConfigs.OLLAMA,
      ...config,
      taskModels: {
        ...DefaultModelConfigs.OLLAMA.taskModels,
        ...config?.taskModels,
      },
    };

    // Enable strict mode by default to follow "Fail Early" principle
    this.strictMode = config?.strictMode ?? true;

    logger.info('Initialized with config:', {
      taskModels: this.config.taskModels,
      fallbackCount: this.config.fallbackModels.length,
      strictMode: this.strictMode,
    });
  }

  // ========================================================================
  // Model Selection
  // ========================================================================

  /**
   * Select the best model for a given task
   *
   * In strict mode (default): Throws error if model not available
   * In non-strict mode: Silently uses fallback
   */
  selectModel(taskType: TaskType, complexity?: TaskComplexity): ModelSelection {
    const taskComplexity = complexity ?? this.inferComplexity(taskType);

    // First, try to get the task-specific model
    let model: string = this.getTaskModel(taskType);

    // If complexity-based mapping exists, use it
    if (this.config.complexityMapping) {
      const complexityModel = this.getModelByComplexity(taskComplexity);
      if (complexityModel) {
        model = complexityModel;
      }
    }

    // Check if model is healthy
    let fallback = false;
    if (!this.isModelHealthy(model)) {
      const fallbackModel = this.getFallbackModel(taskType);

      if (!fallbackModel) {
        if (this.strictMode) {
          // In strict mode, throw error instead of silent fallback
          throw new ModelSelectionError(
            `Model ${model} is unhealthy and no fallback available`,
            model,
            this.config.availableModels,
            taskType
          );
        }
        // In non-strict mode, continue with original model even if unhealthy
        logger.warn(`Model ${model} unhealthy and no fallback available, continuing anyway`);
      } else {
        logger.info(`Model ${model} unhealthy, using fallback: ${fallbackModel}`);
        model = fallbackModel;
        fallback = true;
      }
    }

    // Verify model is available
    if (!this.config.availableModels.includes(model) && !this.config.fallbackModels.includes(model)) {
      const firstAvailable = this.getFirstAvailableModel();

      if (!firstAvailable) {
        if (this.strictMode) {
          // In strict mode, throw error instead of silent fallback
          throw new ModelSelectionError(
            `Model ${model} is not available and no fallback is configured. ` +
            `Available models: ${this.config.availableModels.join(', ') || 'None'}. ` +
            `Please ensure at least one model is available in Ollama.`,
            model,
            this.config.availableModels,
            taskType
          );
        }
        // In non-strict mode, continue with configured model even if not in available list
        logger.warn(`Model ${model} not in available list and no fallback, continuing anyway`);
      } else {
        logger.warn(`Model ${model} not available, using fallback: ${firstAvailable}`);
        model = firstAvailable;
        fallback = true;
      }
    }

    const reason = this.buildSelectionReason(taskType, taskComplexity, model, fallback);

    return {
      model,
      reason,
      fallback,
      complexity: taskComplexity,
    };
  }

  /**
   * Select model based on task metadata
   */
  selectModelByMetadata(metadata: TaskMetadata): ModelSelection {
    let complexity = metadata.complexity;

    // Infer complexity from metadata if not provided
    if (!complexity) {
      complexity = this.inferComplexityFromMetadata(metadata);
    }

    return this.selectModel(metadata.type, complexity);
  }

  // ========================================================================
  // Task-Specific Model Selection
  // ========================================================================

  private getTaskModel(taskType: TaskType): string {
    switch (taskType) {
      case TaskType.CONTROL:
        return this.config.taskModels.control;
      case TaskType.PLANNING:
        return this.config.taskModels.planning;
      case TaskType.REASONING:
        return this.config.taskModels.reasoning;
      case TaskType.CODE:
        return this.config.taskModels.code;
      case TaskType.EMBEDDING:
        return this.config.taskModels.embedding;
      case TaskType.CHAT:
        return this.config.taskModels.chat;
      case TaskType.ANALYSIS:
        return this.config.taskModels.analysis;
      case TaskType.SUMMARIZATION:
        return this.config.taskModels.summarization;
      default:
        return this.config.taskModels.chat;
    }
  }

  private getModelByComplexity(complexity: TaskComplexity): string | null {
    if (!this.config.complexityMapping) {
      return null;
    }

    switch (complexity) {
      case TaskComplexity.SIMPLE:
        return this.config.complexityMapping.simple || null;
      case TaskComplexity.MODERATE:
        return this.config.complexityMapping.moderate || null;
      case TaskComplexity.COMPLEX:
        return this.config.complexityMapping.complex || null;
      case TaskComplexity.CRITICAL:
        return this.config.complexityMapping.critical || null;
      default:
        return null;
    }
  }

  // ========================================================================
  // Fallback Logic
  // ========================================================================

  /**
   * Get fallback model for a task type
   *
   * In strict mode: Returns null if no healthy fallback is available
   * In non-strict mode: Returns first fallback even if unhealthy
   */
  private getFallbackModel(_taskType: TaskType): string | null {
    // First try to get a healthy fallback model
    for (const fallback of this.config.fallbackModels) {
      if (this.isModelHealthy(fallback)) {
        return fallback;
      }
    }

    // In strict mode, return null to indicate no fallback available
    if (this.strictMode) {
      return null;
    }

    // Return first fallback as last resort (non-strict mode only)
    return this.config.fallbackModels[0] || this.config.taskModels.chat;
  }

  private getFirstAvailableModel(): string | null {
    // Check task models
    for (const model of Object.values(this.config.taskModels)) {
      if (this.config.availableModels.includes(model) && this.isModelHealthy(model)) {
        return model;
      }
    }

    // Check fallback models
    for (const model of this.config.fallbackModels) {
      if (this.config.availableModels.includes(model) && this.isModelHealthy(model)) {
        return model;
      }
    }

    return null;
  }

  // ========================================================================
  // Complexity Inference
  // ========================================================================

  private inferComplexity(taskType: TaskType): TaskComplexity {
    switch (taskType) {
      case TaskType.CONTROL:
        return TaskComplexity.SIMPLE;
      case TaskType.PLANNING:
      case TaskType.REASONING:
        return TaskComplexity.COMPLEX;
      case TaskType.CODE:
      case TaskType.ANALYSIS:
        return TaskComplexity.MODERATE;
      case TaskType.SUMMARIZATION:
        return TaskComplexity.SIMPLE;
      case TaskType.CHAT:
      case TaskType.EMBEDDING:
      default:
        return TaskComplexity.MODERATE;
    }
  }

  private inferComplexityFromMetadata(metadata: TaskMetadata): TaskComplexity {
    // Explicit complexity
    if (metadata.complexity) {
      return metadata.complexity;
    }

    // Infer from estimated tokens
    if (metadata.estimatedTokens) {
      if (metadata.estimatedTokens < 500) {
        return TaskComplexity.SIMPLE;
      } else if (metadata.estimatedTokens < 2000) {
        return TaskComplexity.MODERATE;
      } else if (metadata.estimatedTokens < 8000) {
        return TaskComplexity.COMPLEX;
      } else {
        return TaskComplexity.CRITICAL;
      }
    }

    // Infer from task requirements
    if (metadata.requiresReasoning) {
      return TaskComplexity.COMPLEX;
    }

    if (metadata.requiresCodeGeneration) {
      return TaskComplexity.MODERATE;
    }

    // Default to task type inference
    return this.inferComplexity(metadata.type);
  }

  // ========================================================================
  // Model Health Management
  // ========================================================================

  /**
   * Update model health status
   */
  setModelHealth(model: string, healthy: boolean): void {
    const wasHealthy = this.modelHealth.get(model);
    this.modelHealth.set(model, healthy);

    if (wasHealthy !== healthy) {
      logger.info(`Model ${model} health changed: ${healthy ? 'HEALTHY' : 'UNHEALTHY'}`);
    }
  }

  /**
   * Check if model is healthy
   */
  isModelHealthy(model: string): boolean {
    const health = this.modelHealth.get(model);
    // Default to healthy if not tracked
    return health === undefined ? true : health;
  }

  /**
   * Mark model as failed (will use fallback)
   */
  markModelFailed(model: string): void {
    this.setModelHealth(model, false);

    // Update error stats
    const stats = this.usageStats.get(model) || { count: 0, errors: 0 };
    stats.errors++;
    this.usageStats.set(model, stats);

    logger.info(`Marked model ${model} as failed (errors: ${stats.errors})`);
  }

  /**
   * Mark model as successful
   */
  markModelSuccess(model: string): void {
    this.setModelHealth(model, true);

    // Update usage stats
    const stats = this.usageStats.get(model) || { count: 0, errors: 0 };
    stats.count++;
    this.usageStats.set(model, stats);
  }

  /**
   * Record model load time
   */
  recordModelLoadTime(model: string, timeMs: number): void {
    this.modelLoadTime.set(model, timeMs);
  }

  // ========================================================================
  // Available Models Management
  // ========================================================================

  /**
   * Update available models list
   */
  setAvailableModels(models: string[]): void {
    this.config.availableModels = models;
    logger.info(`Updated available models (${models.length} total):`, models);

    // Reset health for newly available models
    for (const model of models) {
      if (!this.modelHealth.has(model)) {
        this.modelHealth.set(model, true);
      }
    }
  }

  /**
   * Get available models
   */
  getAvailableModels(): string[] {
    return [...this.config.availableModels];
  }

  /**
   * Check if model is available
   */
  isModelAvailable(model: string): boolean {
    return this.config.availableModels.includes(model);
  }

  // ========================================================================
  // Configuration
  // ========================================================================

  /**
   * Update model for a specific task type
   */
  setTaskModel(taskType: TaskType, model: string): void {
    switch (taskType) {
      case TaskType.CONTROL:
        this.config.taskModels.control = model;
        break;
      case TaskType.PLANNING:
        this.config.taskModels.planning = model;
        break;
      case TaskType.REASONING:
        this.config.taskModels.reasoning = model;
        break;
      case TaskType.CODE:
        this.config.taskModels.code = model;
        break;
      case TaskType.EMBEDDING:
        this.config.taskModels.embedding = model;
        break;
      case TaskType.CHAT:
        this.config.taskModels.chat = model;
        break;
      case TaskType.ANALYSIS:
        this.config.taskModels.analysis = model;
        break;
      case TaskType.SUMMARIZATION:
        this.config.taskModels.summarization = model;
        break;
    }

    logger.info(`Updated ${taskType} model to: ${model}`);
  }

  /**
   * Get current configuration
   */
  getConfig(): ModelStrategyConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<ModelStrategyConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      taskModels: {
        ...this.config.taskModels,
        ...updates.taskModels,
      },
    };
    logger.info('Configuration updated');
  }

  // ========================================================================
  // Statistics and Monitoring
  // ========================================================================

  /**
   * Get usage statistics for all models
   */
  getUsageStats(): Map<string, { count: number; errors: number; errorRate: number }> {
    const stats = new Map<string, { count: number; errors: number; errorRate: number }>();
    for (const [model, data] of this.usageStats) {
      const errorRate = data.count > 0 ? data.errors / data.count : 0;
      stats.set(model, {
        count: data.count,
        errors: data.errors,
        errorRate,
      });
    }
    return stats;
  }

  /**
   * Get model load times
   */
  getModelLoadTimes(): Map<string, number> {
    return new Map(this.modelLoadTime);
  }

  /**
   * Get recommended model for a task (considers performance)
   */
  getRecommendedModel(taskType: TaskType): string {
    const baseModel = this.getTaskModel(taskType);
    const stats = this.getUsageStats();
    const modelStats = stats.get(baseModel);

    // If model has high error rate (>20%), recommend fallback
    if (modelStats && modelStats.errorRate > 0.2) {
      logger.warn(`Model ${baseModel} has high error rate (${(modelStats.errorRate * 100).toFixed(1)}%), recommending fallback`);
      const fallbackModel = this.getFallbackModel(taskType);
      return fallbackModel || baseModel;
    }
    return baseModel;
  }

  // ========================================================================
  // Strict Mode Management
  // ========================================================================

  /**
   * Enable or disable strict mode
   *
   * In strict mode (default): Throws error when model not available
   * In non-strict mode: Uses fallback silently
   */
  setStrictMode(enabled: boolean): void {
    this.strictMode = enabled;
    logger.info(`Strict mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if strict mode is enabled
   */
  isStrictMode(): boolean {
    return this.strictMode;
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  private buildSelectionReason(
    taskType: TaskType,
    complexity: TaskComplexity,
    model: string,
    fallback: boolean
  ): string {
    const parts = [`Task: ${taskType}`, `Complexity: ${complexity}`];
    if (fallback) {
      parts.push('Fallback model');
    }
    parts.push(`Model: ${model}`);
    return parts.join(' | ');
  }

  /**
   * Create a task metadata object
   */
  static createTaskMetadata(
    type: TaskType,
    options?: Partial<TaskMetadata>
  ): TaskMetadata {
    return {
      type,
      ...options,
    };
  }
}

// ============================================================================
// Task Type Helpers
// ============================================================================

/**
 * Helper functions for creating common task metadata
 */
export const TaskHelpers = {
  control: (options?: Partial<TaskMetadata>): TaskMetadata => ({
    type: TaskType.CONTROL,
    complexity: TaskComplexity.SIMPLE,
    ...options,
  }),

  planning: (options?: Partial<TaskMetadata>): TaskMetadata => ({
    type: TaskType.PLANNING,
    complexity: TaskComplexity.COMPLEX,
    requiresReasoning: true,
    ...options,
  }),

  reasoning: (options?: Partial<TaskMetadata>): TaskMetadata => ({
    type: TaskType.REASONING,
    complexity: TaskComplexity.COMPLEX,
    requiresReasoning: true,
    ...options,
  }),

  code: (options?: Partial<TaskMetadata>): TaskMetadata => ({
    type: TaskType.CODE,
    complexity: TaskComplexity.MODERATE,
    requiresCodeGeneration: true,
    ...options,
  }),

  chat: (options?: Partial<TaskMetadata>): TaskMetadata => ({
    type: TaskType.CHAT,
    complexity: TaskComplexity.MODERATE,
    ...options,
  }),

  analysis: (options?: Partial<TaskMetadata>): TaskMetadata => ({
    type: TaskType.ANALYSIS,
    complexity: TaskComplexity.MODERATE,
    ...options,
  }),
};
