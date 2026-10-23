/**
 * Service Interface
 *
 * Top layer abstraction for exposing agent capabilities
 * Services are registered in Environment Center for discovery and invocation
 */

import type { Service as SharedService, HTTPMethod, ParameterDefinition } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Service execution context
 */
const logger = createLogger('Service');

export interface ServiceExecutionContext {
  serviceId: string;
  requester: string; // Agent or user ID
  timestamp: Date;
  params: Record<string, unknown>;
}

/**
 * Service execution result
 */
export interface ServiceExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  executedAt: Date;
  executionTime: number; // milliseconds
}

/**
 * Service health status
 */
export enum ServiceHealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
}

/**
 * Agent service interface
 * Extends the shared Service interface with agent-specific functionality
 */
export interface AgentService extends SharedService {
  /**
   * Execute the service
   * @param context - Execution context
   * @returns Execution result
   */
  execute(context: ServiceExecutionContext): Promise<ServiceExecutionResult>;

  /**
   * Get service health status
   * @returns Health status
   */
  getHealth(): ServiceHealthStatus;

  /**
   * Get service statistics
   * @returns Statistics object
   */
  getStats(): ServiceStats;

  /**
   * Check if service is available
   * @returns True if available
   */
  isAvailable(): boolean;

  /**
   * Get the owner (agent ID)
   * @returns Agent ID
   */
  getOwner(): string;

  /**
   * Get provider agent information (Sprint 9)
   * Returns information about the agent providing this service
   * @returns Provider info object
   */
  getProviderInfo(): ProviderInfo;
}

/**
 * Provider agent information (Sprint 9)
 * Contains information about the agent providing the service
 */
export interface ProviderInfo {
  /** ID of the provider agent */
  providerAgentId?: string;
  /** Name of the provider agent */
  providerAgentName?: string;
  /** Capabilities of the provider agent */
  providerCapabilities?: string[];
}

/**
 * Service statistics
 */
export interface ServiceStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTime: number;
  lastExecution?: Date;
  lastError?: string;
}

/**
 * Base agent service class
 * Provides common functionality for all agent services
 */
export abstract class BaseAgentService implements AgentService {
  public readonly id: string;
  public name: string;
  public readonly deviceId: string;
  public readonly uri: string;
  public readonly httpMethod: HTTPMethod;
  public readonly parameters: ParameterDefinition[];
  public readonly location: string;
  public readonly category: string;
  public readonly isConditional: boolean;
  public readonly description: string;

  protected owner: string;
  protected health: ServiceHealthStatus;
  protected stats: ServiceStats;

  // Sprint 9: Provider info fields
  protected _providerAgentId?: string;
  protected _providerAgentName?: string;
  protected _providerCapabilities?: string[];

  constructor(config: {
    id: string;
    name: string;
    description: string;
    deviceId: string;
    owner: string;
    location: string;
    category: string;
    uri?: string;
    httpMethod?: HTTPMethod;
    parameters?: ParameterDefinition[];
    isConditional?: boolean;
    // Sprint 9: Provider info
    providerAgentId?: string;
    providerAgentName?: string;
    providerCapabilities?: string[];
  }) {
    logger.info(`[BaseAgentService:${config.id}] Initializing service: ${config.name}`);

    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.deviceId = config.deviceId;
    this.owner = config.owner;
    this.location = config.location;
    this.category = config.category;
    this.uri = config.uri || `agent://${config.owner}/services/${config.id}`;
    this.httpMethod = config.httpMethod || 'POST';
    this.parameters = config.parameters || [];
    this.isConditional = config.isConditional || false;
    this.health = ServiceHealthStatus.HEALTHY;
    this.stats = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageExecutionTime: 0,
    };

    // Sprint 9: Initialize provider info
    this._providerAgentId = config.providerAgentId;
    this._providerAgentName = config.providerAgentName;
    this._providerCapabilities = config.providerCapabilities;

    logger.info(`[BaseAgentService:${this.id}] Service initialized`);
  }

  /**
   * Execute the service (must be implemented by subclasses)
   */
  abstract execute(context: ServiceExecutionContext): Promise<ServiceExecutionResult>;

  /**
   * Get service health
   */
  getHealth(): ServiceHealthStatus {
    return this.health;
  }

  /**
   * Set service health
   */
  setHealth(health: ServiceHealthStatus): void {
    logger.info(`[BaseAgentService:${this.id}] Health changed: ${this.health} -> ${health}`);
    this.health = health;
  }

  /**
   * Get service statistics
   */
  getStats(): ServiceStats {
    return { ...this.stats };
  }

  /**
   * Check if service is available
   */
  isAvailable(): boolean {
    return this.health === ServiceHealthStatus.HEALTHY;
  }

  /**
   * Get service owner
   */
  getOwner(): string {
    return this.owner;
  }

  /**
   * Update statistics after execution
   * @param result - Execution result
   * @param executionTime - Execution time in milliseconds
   */
  protected updateStats(result: ServiceExecutionResult, executionTime: number): void {
    this.stats.totalExecutions++;
    this.stats.lastExecution = new Date();

    if (result.success) {
      this.stats.successfulExecutions++;
    } else {
      this.stats.failedExecutions++;
      this.stats.lastError = result.error;
    }

    // Update average execution time
    const totalTime = this.stats.averageExecutionTime * (this.stats.totalExecutions - 1) + executionTime;
    this.stats.averageExecutionTime = totalTime / this.stats.totalExecutions;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    logger.info(`[BaseAgentService:${this.id}] Resetting statistics`);
    this.stats = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageExecutionTime: 0,
    };
  }

  /**
   * Get provider agent information (Sprint 9)
   * Returns information about the agent providing this service
   */
  getProviderInfo(): ProviderInfo {
    return {
      providerAgentId: this._providerAgentId,
      providerAgentName: this._providerAgentName,
      providerCapabilities: this._providerCapabilities,
    };
  }
}
