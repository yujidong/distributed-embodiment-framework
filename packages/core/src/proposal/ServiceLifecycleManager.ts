/**
 * Service Lifecycle Manager
 *
 * Manages the lifecycle of dynamically created services
 * using strategy pattern for extensibility
 */

import type {
  IServiceLifecycleStrategy,
  ServiceExecutionContext,
  ServiceCreationContext
} from './interfaces.js';
import { LifecycleAction } from './interfaces.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Service Lifecycle Manager
 * Delegates to appropriate strategy based on service metadata
 */
const logger = createLogger('ServiceLifecycleManager');

export class ServiceLifecycleManager {
  private strategies: Map<string, IServiceLifecycleStrategy>;
  private defaultStrategy: string;

  constructor() {
    this.strategies = new Map();

    // Register built-in strategies
    this.registerStrategy('temporary', new TemporaryServiceStrategy());
    this.registerStrategy('persistent', new PersistentServiceStrategy());
    this.registerStrategy('usage-based', new UsageBasedServiceStrategy(5));
    this.registerStrategy('promote-on-use', new PromoteOnUseStrategy(3));

    this.defaultStrategy = 'temporary';
    logger.info('Initialized with strategies:', Array.from(this.strategies.keys()));
  }

  /**
   * Register a new lifecycle strategy
   */
  registerStrategy(name: string, strategy: IServiceLifecycleStrategy): void {
    this.strategies.set(name, strategy);
    logger.info(`Registered strategy: ${name}`);
  }

  /**
   * Set the default strategy
   */
  setDefaultStrategy(name: string): void {
    if (!this.strategies.has(name)) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    this.defaultStrategy = name;
    logger.info(`Default strategy set to: ${name}`);
  }

  /**
   * Handle post-execution lifecycle decision
   */
  async afterExecution(
    serviceId: string,
    executionContext: ServiceExecutionContext
  ): Promise<LifecycleAction> {
    const strategyName = executionContext.strategy || this.defaultStrategy;
    const strategy = this.strategies.get(strategyName);

    if (!strategy) {
      logger.warn(`Unknown strategy: ${strategyName}, using default`);
      const defaultStrategy = this.strategies.get(this.defaultStrategy)!;
      return defaultStrategy.afterExecution(serviceId, executionContext);
    }

    logger.info(`Using strategy '${strategyName}' for service ${serviceId}`);
    return strategy.afterExecution(serviceId, executionContext);
  }

  /**
   * Handle service creation
   */
  onCreation(serviceId: string, creationContext: ServiceCreationContext): void {
    const strategy = this.strategies.get(this.defaultStrategy);
    if (strategy && strategy.onCreation) {
      strategy.onCreation(serviceId, creationContext);
    }
  }
}

/**
 * Strategy: Delete service after AC completes
 */
export class TemporaryServiceStrategy implements IServiceLifecycleStrategy {
  afterExecution(
    serviceId: string,
    executionContext: ServiceExecutionContext
  ): LifecycleAction {
    logger.info(`[TemporaryStrategy] Deleting temporary service: ${serviceId}`);
    return LifecycleAction.DELETE;
  }
}

/**
 * Strategy: Keep service forever
 */
export class PersistentServiceStrategy implements IServiceLifecycleStrategy {
  afterExecution(
    serviceId: string,
    executionContext: ServiceExecutionContext
  ): LifecycleAction {
    logger.info(`[PersistentStrategy] Keeping persistent service: ${serviceId}`);
    return LifecycleAction.KEEP;
  }
}

/**
 * Strategy: Delete after N uses
 */
export class UsageBasedServiceStrategy implements IServiceLifecycleStrategy {
  private usageCount: Map<string, number> = new Map();
  private maxUses: number;

  constructor(maxUses: number = 5) {
    this.maxUses = maxUses;
    logger.info(`[UsageBasedStrategy] Initialized with maxUses=${maxUses}`);
  }

  afterExecution(
    serviceId: string,
    executionContext: ServiceExecutionContext
  ): LifecycleAction {
    const currentCount = this.usageCount.get(serviceId) || 0;
    const newCount = currentCount + 1;
    this.usageCount.set(serviceId, newCount);

    logger.info(`[UsageBasedStrategy] Service ${serviceId} used ${newCount}/${this.maxUses} times`);

    if (newCount >= this.maxUses) {
      logger.info(`[UsageBasedStrategy] Service ${serviceId} reached max uses, deleting`);
      return LifecycleAction.DELETE;
    }

    return LifecycleAction.KEEP;
  }
}

/**
 * Strategy: Promote to permanent after N successful uses
 */
export class PromoteOnUseStrategy implements IServiceLifecycleStrategy {
  private usageCount: Map<string, number> = new Map();
  private promoteThreshold: number;

  constructor(promoteThreshold: number = 3) {
    this.promoteThreshold = promoteThreshold;
    logger.info(`[PromoteOnUseStrategy] Initialized with promoteThreshold=${promoteThreshold}`);
  }

  afterExecution(
    serviceId: string,
    executionContext: ServiceExecutionContext
  ): LifecycleAction {
    // Only count successful executions
    if (!executionContext.executionSuccess) {
      logger.info(`[PromoteOnUseStrategy] Service ${serviceId} execution failed, not counting`);
      return LifecycleAction.KEEP;
    }

    const currentCount = this.usageCount.get(serviceId) || 0;
    const newCount = currentCount + 1;
    this.usageCount.set(serviceId, newCount);

    logger.info(`[PromoteOnUseStrategy] Service ${serviceId} used ${newCount}/${this.promoteThreshold} times`);

    if (newCount >= this.promoteThreshold) {
      logger.info(`[PromoteOnUseStrategy] Promoting service ${serviceId} to permanent!`);
      return LifecycleAction.PROMOTE_TO_PERMANENT;
    }

    return LifecycleAction.KEEP;
  }
}
