/**
 * Module System
 *
 * Inspired by NestJS module pattern.
 * Modules group related services and define their exports.
 */

import { ServiceContainer } from './ServiceContainer';
import { IModule, ModuleConfig, DIRegistration, InjectionToken, ServiceLifetime } from './types';

/**
 * Base Module class
 *
 * @example
 * ```typescript
 * class CoreModule extends BaseModule {
 *   constructor() {
 *     super({
 *       name: 'CoreModule',
 *       providers: [
 *         { token: TOKEN_EVENT_MANAGER, factory: () => new EventManager() }
 *       ],
 *       exports: [TOKEN_EVENT_MANAGER]
 *     });
 *   }
 * }
 * ```
 */
export abstract class BaseModule implements IModule {
  readonly name: string;
  readonly container: ServiceContainer;
  private initialized = false;

  constructor(protected config: ModuleConfig) {
    this.name = config.name;
    this.container = new ServiceContainer();
  }

  /**
   * Get module configuration (for subclass access)
   */
  getConfig(): ModuleConfig {
    return this.config;
  }

  /**
   * Initialize the module
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize imported modules first
    if (this.config.imports) {
      for (const module of this.config.imports) {
        await module.initialize();
        // Import exported services from child module
        if (module instanceof BaseModule) {
          const moduleConfig = module.getConfig();
          if (moduleConfig.exports) {
            for (const token of moduleConfig.exports) {
              const service = module.container.get(token);
              this.container.register({
                token,
                factory: () => service,
              });
            }
          }
        }
      }
    }

    // Register providers
    if (this.config.providers) {
      this.container.registerAll(this.config.providers);
    }

    this.initialized = true;
  }

  /**
   * Destroy the module and cleanup resources
   */
  async destroy(): Promise<void> {
    this.container.clear();
    this.initialized = false;
  }

  /**
   * Check if module is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Module Builder - fluent API for creating modules
 *
 * @example
 * ```typescript
 * const coreModule = ModuleBuilder.create('CoreModule')
 *   .provide(TOKEN_EVENT_MANAGER, () => new EventManager())
 *   .provide(TOKEN_RESOURCE_MANAGER, () => new ResourceManager())
 *   .export(TOKEN_EVENT_MANAGER)
 *   .export(TOKEN_RESOURCE_MANAGER)
 *   .build();
 * ```
 */
export class ModuleBuilder {
  private config: ModuleConfig;

  private constructor(name: string) {
    this.config = {
      name,
      providers: [],
      exports: [],
      imports: [],
    };
  }

  /**
   * Create a new module builder
   */
  static create(name: string): ModuleBuilder {
    return new ModuleBuilder(name);
  }

  /**
   * Add a provider
   */
  provide(token: InjectionToken, factory: () => any, lifetime?: 'singleton' | 'transient'): this {
    this.config.providers!.push({
      token,
      factory,
      lifetime: lifetime === 'transient' ? ServiceLifetime.Transient : ServiceLifetime.Singleton,
    });
    return this;
  }

  /**
   * Export a service
   */
  export(token: InjectionToken): this {
    this.config.exports!.push(token);
    return this;
  }

  /**
   * Import another module
   */
  import(module: IModule): this {
    this.config.imports!.push(module);
    return this;
  }

  /**
   * Build the module
   */
  build(): IModule {
    const self = this;
    const container = new ServiceContainer();
    let initialized = false;

    // Create module instance
    const module: IModule = {
      name: self.config.name,
      container,
      initialize: async () => {
        if (initialized) return;

        // Initialize imports first
        if (self.config.imports) {
          for (const importedModule of self.config.imports) {
            await importedModule.initialize();
            // Import exported services if it's a BaseModule
            if (importedModule instanceof BaseModule) {
              const moduleConfig = (importedModule as BaseModule).getConfig();
              if (moduleConfig.exports) {
                for (const token of moduleConfig.exports) {
                  const service = importedModule.container.get(token);
                  container.register({
                    token,
                    factory: () => service,
                  });
                }
              }
            }
          }
        }

        // Register providers
        if (self.config.providers) {
          container.registerAll(self.config.providers);
        }

        initialized = true;
      },
      destroy: async () => {
        container.clear();
        initialized = false;
      },
    };

    return module;
  }
}
