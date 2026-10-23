/**
 * Service Container - Dependency Injection Implementation
 *
 * A lightweight DI container inspired by NestJS patterns.
 * Supports singleton, transient, and scoped service lifetimes.
 */

import {
  IServiceContainer,
  DIRegistration,
  ServiceLifetime,
  InjectionToken,
  Factory
} from './types';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ServiceContainer');

/**
 * Internal service record
 */
interface ServiceRecord<T = any> {
  factory: Factory<T>;
  lifetime: ServiceLifetime;
  instance?: T;
  dependencies: InjectionToken[];
}

/**
 * Service Container Implementation
 *
 * @example
 * ```typescript
 * const container = new ServiceContainer();
 *
 * // Register services
 * container.register({
 *   token: 'config',
 *   factory: () => new ConfigService(),
 *   lifetime: ServiceLifetime.SINGLETON
 * });
 *
 * // Get services
 * const config = container.get<ConfigService>('config');
 * ```
 */


export class ServiceContainer implements IServiceContainer {
  private services = new Map<InjectionToken, ServiceRecord>();
  private resolving = new Set<InjectionToken>();

  constructor(private parent?: ServiceContainer) {}

  /**
   * Register a service
   */
  register<T>(registration: DIRegistration<T>): this {
    const token = registration.token;

    if (this.services.has(token)) {
      logger.warn(`Service "${String(token)}" already registered, overwriting`);
    }

    this.services.set(token, {
      factory: registration.factory,
      lifetime: registration.lifetime ?? ServiceLifetime.Singleton,
      dependencies: registration.dependencies ?? [],
    });

    return this;
  }

  /**
   * Register multiple services
   */
  registerAll(registrations: DIRegistration[]): this {
    for (const reg of registrations) {
      this.register(reg);
    }
    return this;
  }

  /**
   * Get a service by its token
   */
  get<T>(token: InjectionToken): T {
    // Check for circular dependency
    if (this.resolving.has(token)) {
      throw new Error(
        `[ServiceContainer] Circular dependency detected while resolving "${String(token)}"`
      );
    }

    // Check local services first
    const record = this.services.get(token);

    if (record) {
      return this.resolveService<T>(token, record);
    }

    // Check parent container
    if (this.parent) {
      return this.parent.get<T>(token);
    }

    throw new Error(`[ServiceContainer] Service "${String(token)}" not found`);
  }

  /**
   * Try to get a service, returns undefined if not found
   */
  tryGet<T>(token: InjectionToken): T | undefined {
    try {
      return this.get<T>(token);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a service from its record
   */
  private resolveService<T>(token: InjectionToken, record: ServiceRecord): T {
    // Return cached singleton instance
    if (record.lifetime === ServiceLifetime.Singleton && record.instance !== undefined) {
      return record.instance as T;
    }

    // Mark as resolving to detect circular dependencies
    this.resolving.add(token);

    try {
      // Resolve dependencies first
      for (const dep of record.dependencies) {
        this.get(dep);
      }

      // Create instance
      const instance = record.factory();

      // Cache singleton
      if (record.lifetime === ServiceLifetime.Singleton) {
        record.instance = instance;
      }

      return instance;
    } finally {
      this.resolving.delete(token);
    }
  }

  /**
   * Check if a service is registered
   */
  has(token: InjectionToken): boolean {
    return this.services.has(token) || (this.parent?.has(token) ?? false);
  }

  /**
   * Unregister a service
   */
  unregister(token: InjectionToken): void {
    this.services.delete(token);
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.services.clear();
  }

  /**
   * Get all registered tokens
   */
  getTokens(): InjectionToken[] {
    const tokens = [...this.services.keys()];
    if (this.parent) {
      tokens.push(...this.parent.getTokens());
    }
    return tokens;
  }

  /**
   * Create a child container (for scoped services)
   */
  createChild(): ServiceContainer {
    return new ServiceContainer(this);
  }

  /**
   * Get container statistics
   */
  getStats(): { serviceCount: number; tokens: string[] } {
    const tokens = this.getTokens().map(t => String(t));
    return {
      serviceCount: tokens.length,
      tokens,
    };
  }
}
