/**
 * Microservice Service Implementation
 *
 * Implements Service as a true microservice with:
 * - Business logic code processing
 * - Container isolation abstraction
 * - Rich capability descriptions for LLM
 * - Deployment capabilities
 * - Abstraction from low-level device complexity
 */

import { v4 as uuidv4 } from 'uuid';
import type { ServiceExecutionContext, ServiceExecutionResult, ServiceStats } from './Service.js';
import { BaseAgentService } from './Service.js';
import { ServiceHealthStatus } from './Service.js';
import type { ServiceCapability, OperationType } from './ServiceCapability.js';
import { generateLLMPrompt, generateJSONSpec } from './ServiceCapability.js';
import type { ServiceContainer } from './ServiceContainer.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Microservice configuration
 */
const logger = createLogger('MicroserviceService');

export interface MicroserviceConfig {
  // Identification
  id: string;
  name: string;
  description: string;
  category: string;

  // Owner
  owner: string;
  location: string;

  // Capability description (rich for LLM)
  capability: ServiceCapability;

  // Business logic
  handler: (params: Record<string, unknown>, context: ServiceExecutionContext) => Promise<unknown>;

  // Container configuration
  container?: ServiceContainer;

  // Deployment configuration
  autoDeploy?: boolean;
  replicas?: number;
  resources?: {
    cpu: number;
    memory: number;
  };

  // Service-level constraints
  timeout?: number;
  maxRetries?: number;
}

/**
 * Microservice Service
 *
 * A true microservice implementation that encapsulates business logic
 * and can be deployed independently with container isolation.
 */
export class MicroserviceService extends BaseAgentService {
  private capability: ServiceCapability;
  private handler: (params: Record<string, unknown>, context: ServiceExecutionContext) => Promise<unknown>;
  private container?: ServiceContainer;
  private deployed: boolean;

  // Deployment configuration
  private autoDeploy: boolean;
  private replicas: number;
  private resources?: {
    cpu: number;
    memory: number;
  };

  // Runtime configuration
  private timeout: number;
  private maxRetries: number;

  constructor(config: MicroserviceConfig) {
    // Initialize base service
    super({
      id: config.id,
      name: config.name,
      description: config.description,
      deviceId: `microservice://${config.id}`, // Virtual device ID
      owner: config.owner,
      location: config.location,
      category: config.category,
      isConditional: false, // Microservices are stateless
    });

    logger.info(`[MicroserviceService:${config.id}] Initializing microservice`);

    // Store capability and handler
    this.capability = config.capability;
    this.handler = config.handler;
    this.container = config.container;

    // Deployment config
    this.autoDeploy = config.autoDeploy ?? false;
    this.replicas = config.replicas ?? 1;
    this.resources = config.resources;
    this.deployed = false;

    // Runtime config
    this.timeout = config.timeout ?? 30000; // 30 seconds default
    this.maxRetries = config.maxRetries ?? 3;

    logger.info(`[MicroserviceService:${this.id}] Capability:`, {
      operationType: this.capability.operationType,
      dataFlow: this.capability.dataFlow,
      dataType: this.capability.dataType,
      canDo: this.capability.canDo.length,
      cannotDo: this.capability.cannotDo.length,
    });
  }

  /**
   * Execute the microservice
   * Implements timeout, retry logic, and business logic execution
   */
  async execute(context: ServiceExecutionContext): Promise<ServiceExecutionResult> {
    const startTime = Date.now();

    logger.info(`[MicroserviceService:${this.id}] Executing service`);
    logger.info(`[MicroserviceService:${this.id}] Context:`, {
      requester: context.requester,
      params: Object.keys(context.params),
    });

    // Check if service is healthy
    if (!this.isAvailable()) {
      return {
        success: false,
        error: `Service ${this.id} is not available (health: ${this.health})`,
        executedAt: new Date(),
        executionTime: 0,
      };
    }

    // Check if container is ready (if using container)
    if (this.container && !this.container.isReady()) {
      return {
        success: false,
        error: `Service container for ${this.id} is not ready`,
        executedAt: new Date(),
        executionTime: 0,
      };
    }

    let lastError: string | undefined;
    let attempt = 0;

    // Retry logic
    while (attempt <= this.maxRetries) {
      attempt++;

      try {
        // Execute with timeout
        const result = await this.executeWithTimeout(context);

        const executionTime = Date.now() - startTime;

        // Update statistics
        this.updateStats(result as ServiceExecutionResult, executionTime);

        return {
          success: true,
          result: result,
          executedAt: new Date(),
          executionTime,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        logger.warn(
          `[MicroserviceService:${this.id}] Execution attempt ${attempt} failed:`,
          lastError
        );

        // If this was the last attempt, don't retry
        if (attempt > this.maxRetries) {
          break;
        }

        // Wait before retry (exponential backoff)
        const backoffTime = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms...
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }

    // All retries failed
    const executionTime = Date.now() - startTime;

    // Update statistics
    this.updateStats(
      { success: false, error: lastError, executedAt: new Date(), executionTime },
      executionTime
    );

    // Set health to degraded if too many failures
    if (this.stats.failedExecutions > 10) {
      this.setHealth(ServiceHealthStatus.DEGRADED);
    }

    return {
      success: false,
      error: lastError || 'Service execution failed after retries',
      executedAt: new Date(),
      executionTime,
    };
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout(
    context: ServiceExecutionContext
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Service execution timeout after ${this.timeout}ms`));
      }, this.timeout);

      this.handler
        .call(this, context.params, context)
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Deploy the microservice
   * Starts container if configured
   */
  async deploy(): Promise<boolean> {
    if (this.deployed) {
      logger.info(`[MicroserviceService:${this.id}] Already deployed`);
      return true;
    }

    logger.info(`[MicroserviceService:${this.id}] Deploying microservice`);

    // Deploy container if configured
    if (this.container) {
      const deployed = await this.container.deploy();
      if (!deployed) {
        logger.error(`[MicroserviceService:${this.id}] Failed to deploy container`);
        return false;
      }
    }

    this.deployed = true;
    logger.info(`[MicroserviceService:${this.id}] Deployed successfully`);
    return true;
  }

  /**
   * Undeploy the microservice
   * Stops container if configured
   */
  async undeploy(): Promise<boolean> {
    if (!this.deployed) {
      logger.info(`[MicroserviceService:${this.id}] Not deployed`);
      return true;
    }

    logger.info(`[MicroserviceService:${this.id}] Undeploying microservice`);

    // Stop container if configured
    if (this.container) {
      const stopped = await this.container.stop();
      if (!stopped) {
        logger.error(`[MicroserviceService:${this.id}] Failed to stop container`);
        return false;
      }
    }

    this.deployed = false;
    logger.info(`[MicroserviceService:${this.id}] Undeployed successfully`);
    return true;
  }

  /**
   * Check if microservice is deployed
   */
  isDeployed(): boolean {
    return this.deployed;
  }

  /**
   * Get service capability
   * Returns rich capability description
   */
  getCapability(): ServiceCapability {
    return this.capability;
  }

  /**
   * Get LLM prompt for this service
   * Generates natural language description for LLM decision-making
   */
  getLLMPrompt(): string {
    return generateLLMPrompt(this.capability);
  }

  /**
   * Get JSON specification for LLM
   * Generates structured JSON for LLM consumption
   */
  getJSONSpec(): Record<string, unknown> {
    return {
      ...generateJSONSpec(this.capability),
      id: this.id,
      name: this.name,
      description: this.description,
      owner: this.owner,
      location: this.location,
      deployed: this.deployed,
      health: this.health,
      stats: this.getStats(),
    };
  }

  /**
   * Scale the microservice
   * Adjusts number of replicas
   */
  async scale(replicas: number): Promise<boolean> {
    logger.info(`[MicroserviceService:${this.id}] Scaling to ${replicas} replicas`);

    if (this.container) {
      return await this.container.scale(replicas);
    }

    this.replicas = replicas;
    return true;
  }

  /**
   * Get service stats
   */
  getStats(): ServiceStats & { deployed: boolean; replicas: number } {
    return {
      ...super.getStats(),
      deployed: this.deployed,
      replicas: this.replicas,
    };
  }

  /**
   * Get container info if available
   */
  getContainerInfo(): Record<string, unknown> | undefined {
    if (!this.container) return undefined;

    return {
      type: this.container.getType(),
      ready: this.container.isReady(),
      stats: this.container.getStats(),
    };
  }
}
