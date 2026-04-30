/**
 * Model Health Monitoring
 *
 * Monitors model availability, performance, and health status.
 * Provides automated model discovery and health checking.
 */

import { OllamaProvider } from './providers/ollama';
import { ModelStrategy } from './ModelStrategy';
import { TaskType } from './model-config';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ModelHealthMonitor');

export interface ModelHealthStatus {
  model: string;
  available: boolean;
  healthy: boolean;
  loadTime?: number;
  lastCheck: number;
  errorCount: number;
  successCount: number;
}

export interface ModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
  digest?: string;
}

/**
 * ModelHealthMonitor - Tracks model health and availability
 */
export class ModelHealthMonitor {
  private strategy: ModelStrategy;
  private provider: OllamaProvider;
  private healthChecks: Map<string, ModelHealthStatus> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private checkIntervalMs: number = 60000; // 1 minute default

  constructor(strategy: ModelStrategy, provider: OllamaProvider) {
    this.strategy = strategy;
    this.provider = provider;
  }

  // ========================================================================
  // Model Discovery
  // ========================================================================

  /**
   * Discover available models from Ollama
   */
  async discoverModels(): Promise<ModelInfo[]> {
    logger.info('Discovering available models...');

    try {
      const response = await fetch(`${this.provider['baseURL']}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Failed to discover models: ${response.status}`);
      }

      const data = await response.json();
      const models: ModelInfo[] = (data.models || []).map((m: any) => ({
        name: m.name,
        size: m.size,
        modifiedAt: m.modified_at,
        digest: m.digest,
      }));

      const modelNames = models.map((m) => m.name);
      logger.info(`Discovered ${models.length} models:`, modelNames);

      // Update strategy with available models
      this.strategy.setAvailableModels(modelNames);

      // Initialize health status for new models
      for (const model of models) {
        if (!this.healthChecks.has(model.name)) {
          this.healthChecks.set(model.name, {
            model: model.name,
            available: true,
            healthy: true,
            lastCheck: Date.now(),
            errorCount: 0,
            successCount: 0,
          });
        }
      }

      return models;
    } catch (error) {
      logger.error('Model discovery failed:', error);
      return [];
    }
  }

  // ========================================================================
  // Health Checking
  // ========================================================================

  /**
   * Health check a specific model
   */
  async checkModelHealth(model: string): Promise<ModelHealthStatus> {
    logger.info(`Checking health of ${model}...`);

    const startTime = Date.now();
    const status = this.healthChecks.get(model) || {
      model,
      available: false,
      healthy: false,
      lastCheck: Date.now(),
      errorCount: 0,
      successCount: 0,
    };

    try {
      // Try to generate a simple completion
      const response = await fetch(`${this.provider['baseURL']}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'test',
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const loadTime = Date.now() - startTime;

      if (response.ok) {
        status.available = true;
        status.healthy = true;
        status.loadTime = loadTime;
        status.successCount++;
        status.lastCheck = Date.now();

        this.strategy.setModelHealth(model, true);
        this.strategy.recordModelLoadTime(model, loadTime);

        logger.info(`Model ${model} is healthy (${loadTime}ms)`);
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      status.available = false;
      status.healthy = false;
      status.errorCount++;
      status.lastCheck = Date.now();

      this.strategy.setModelHealth(model, false);
      this.strategy.markModelFailed(model);

      logger.error(`Model ${model} health check failed:`, error);
    }

    this.healthChecks.set(model, status);
    return status;
  }

  /**
   * Health check all configured models
   */
  async checkAllModels(): Promise<ModelHealthStatus[]> {
    logger.info('Checking health of all configured models...');

    const models = this.strategy.getAvailableModels();
    const statusPromises = models.map((model) => this.checkModelHealth(model));

    const statuses = await Promise.all(statusPromises);

    // Log summary
    const healthy = statuses.filter((s) => s.healthy).length;
    const unhealthy = statuses.length - healthy;

    logger.info(`Health check complete: ${healthy} healthy, ${unhealthy} unhealthy`);

    return statuses;
  }

  /**
   * Get health status for a specific model
   */
  getModelHealth(model: string): ModelHealthStatus | undefined {
    return this.healthChecks.get(model);
  }

  /**
   * Get health status for all models
   */
  getAllModelHealth(): Map<string, ModelHealthStatus> {
    return new Map(this.healthChecks);
  }

  // ========================================================================
  // Automated Monitoring
  // ========================================================================

  /**
   * Start automated health checking
   */
  startMonitoring(intervalMs: number = 60000): void {
    if (this.checkInterval) {
      logger.warn('Monitoring already active');
      return;
    }

    this.checkIntervalMs = intervalMs;

    // Initial check
    this.checkAllModels().catch((err) => logger.error('Monitoring check failed:', err));

    // Schedule recurring checks
    this.checkInterval = setInterval(() => {
      this.checkAllModels().catch((err) => logger.error('Monitoring check failed:', err));
    }, this.checkIntervalMs);

    logger.info(`Started automated monitoring (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop automated monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('Stopped automated monitoring');
    }
  }

  /**
   * Get monitoring status
   */
  isMonitoring(): boolean {
    return this.checkInterval !== null;
  }

  // ========================================================================
  // Statistics and Reporting
  // ========================================================================

  /**
   * Get health summary
   */
  getHealthSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    averageLoadTime: number;
    models: ModelHealthStatus[];
  } {
    const statuses = Array.from(this.healthChecks.values());
    const healthy = statuses.filter((s) => s.healthy).length;
    const unhealthy = statuses.length - healthy;

    const loadTimes = statuses
      .filter((s) => s.loadTime !== undefined)
      .map((s) => s.loadTime!);
    const averageLoadTime =
      loadTimes.length > 0
        ? loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length
        : 0;

    return {
      total: statuses.length,
      healthy,
      unhealthy,
      averageLoadTime,
      models: statuses,
    };
  }

  /**
   * Get recommended models for each task type
   */
  getRecommendations(): Map<string, string> {
    const recommendations = new Map<string, string>();

    const taskTypes = [
      'control',
      'planning',
      'reasoning',
      'code',
      'embedding',
      'chat',
      'analysis',
      'summarization',
    ];

    for (const taskType of taskTypes) {
      const model = this.strategy.getRecommendedModel(taskType as TaskType);
      recommendations.set(taskType, model);
    }

    return recommendations;
  }

  /**
   * Get models sorted by performance (load time)
   */
  getModelsByPerformance(): ModelHealthStatus[] {
    return Array.from(this.healthChecks.values())
      .filter((s) => s.loadTime !== undefined && s.healthy)
      .sort((a, b) => (a.loadTime || 0) - (b.loadTime || 0));
  }

  /**
   * Get models sorted by reliability (success rate)
   */
  getModelsByReliability(): ModelHealthStatus[] {
    return Array.from(this.healthChecks.values())
      .filter((s) => s.successCount + s.errorCount > 0)
      .sort((a, b) => {
        const aRate = a.successCount / (a.successCount + a.errorCount);
        const bRate = b.successCount / (b.successCount + b.errorCount);
        return bRate - aRate;
      });
  }
}

// ============================================================================
// Health Check Utilities
// ============================================================================

/**
 * Quick health check for a single model
 */
export async function quickHealthCheck(
  provider: OllamaProvider,
  model: string
): Promise<boolean> {
  try {
    const response = await fetch(`${provider['baseURL']}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    const models = data.models || [];
    return models.some((m: any) => m.name === model);
  } catch {
    return false;
  }
}

/**
 * Check if multiple models are available
 */
export async function checkModelsAvailable(
  provider: OllamaProvider,
  models: string[]
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  for (const model of models) {
    const available = await quickHealthCheck(provider, model);
    results.set(model, available);
  }

  return results;
}
