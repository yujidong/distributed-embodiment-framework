/**
 * Dependency Injection Container
 *
 * A lightweight DI system inspired by NestJS.
 *
 * @example
 * ```typescript
 * import { ServiceContainer, ServiceLifetime } from './container';
 *
 * // Create container
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

// Types
export * from './types';

// Container
export { ServiceContainer } from './ServiceContainer';

// Tokens
export * from './InjectionTokens';

// Module
export { BaseModule, ModuleBuilder } from './Module';
