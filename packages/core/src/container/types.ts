/**
 * Dependency Injection Types
 *
 * Provides type definitions for the DI container system.
 * Inspired by NestJS and Inversify patterns.
 */

/**
 * Injection token for service registration and retrieval
 */
export type InjectionToken = string | symbol | Function;

/**
 * Factory function for creating service instances
 */
export type Factory<T> = () => T;

/**
 * Service lifetime options
 */
export enum ServiceLifetime {
  /** New instance every time */
  Transient = 'transient',
  /** Single instance shared across all consumers */
  Singleton = 'singleton',
  /** One instance per scope (e.g., per request) */
  Scoped = 'scoped'
}

/**
 * Service registration options for DI container
 */
export interface DIRegistration<T = any> {
  /** Token for registration and retrieval */
  token: InjectionToken;
  /** Factory function to create the instance */
  factory: Factory<T>;
  /** Service lifetime (default: Singleton) */
  lifetime?: ServiceLifetime;
  /** Dependencies that must be resolved first */
  dependencies?: InjectionToken[];
}

/**
 * Module configuration
 */
export interface ModuleConfig {
  /** Module name for debugging */
  name: string;
  /** Services provided by this module */
  providers?: DIRegistration[];
  /** Services exported for other modules */
  exports?: InjectionToken[];
  /** Other modules to import */
  imports?: IModule[];
}

/**
 * Module interface
 */
export interface IModule {
  readonly name: string;
  readonly container: IServiceContainer;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Service container interface
 */
export interface IServiceContainer {
  /**
   * Register a service with the container
   */
  register<T>(registration: DIRegistration<T>): void;

  /**
   * Register multiple services
   */
  registerAll(registrations: DIRegistration[]): void;

  /**
   * Get a service by its token
   */
  get<T>(token: InjectionToken): T;

  /**
   * Check if a service is registered
   */
  has(token: InjectionToken): boolean;

  /**
   * Unregister a service
   */
  unregister(token: InjectionToken): void;

  /**
   * Clear all registrations
   */
  clear(): void;

  /**
   * Get all registered tokens
   */
  getTokens(): InjectionToken[];
}
