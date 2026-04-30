/**
 * Event Pipeline
 *
 * Executes middleware chain in order for event processing
 * Supports guards, interceptors, transformers
 */

import type { SystemEvent } from '../EventManager.js';
import type { EventSubscription } from '../EventManager.js';
import type { EventMiddleware, MiddlewareContext, MiddlewareResult } from './EventMiddleware.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Pipeline configuration
 */
const logger = createLogger('EventPipeline');

export interface PipelineConfig {
  middlewares: EventMiddleware[];
  stopOnError: boolean;
  timeout: number;
}

/**
 * Pipeline execution result
 */
export interface PipelineResult {
  success: boolean;
  results: MiddlewareResult[];
  finalEvent?: SystemEvent;
  errors: Error[];
  executionTime: number;
}

/**
 * Event Pipeline Implementation
 *
 * Executes middleware chain in order for event processing
 */
export class EventPipeline {
  private middlewares: EventMiddleware[] = [];
  private config: PipelineConfig;

  constructor(config?: Partial<PipelineConfig>) {
    this.middlewares = [];
    this.config = {
      middlewares: [],
      stopOnError: true,
      timeout: 30000,
      ...config
    };
    logger.info('Initialized with ' + this.middlewares.length + ' middlewares');
  }

  /**
   * Add middleware to pipeline
   */
  addMiddleware(middleware: EventMiddleware): void {
    // Check if middleware with same ID already exists
    if (this.middlewares.some(m => m.id === middleware.id)) {
      logger.warn('Middleware ' + middleware.id + ' already exists');
      return;
    }

    this.middlewares.push(middleware);

    // Sort by priority (higher = earlier execution)
    this.middlewares.sort((a, b) => b.priority - a.priority);

    logger.info('Added middleware: ' + middleware.name + ' (priority: ' + middleware.priority + ')');
  }

  /**
   * Remove middleware from pipeline
   */
  removeMiddleware(middlewareId: string): boolean {
    const index = this.middlewares.findIndex(m => m.id === middlewareId);
    if (index === -1) {
      return false;
    }
    this.middlewares.splice(index, 1);
    logger.info('Removed middleware: ' + middlewareId);
    return true;
  }

  /**
   * Execute pipeline for event
   */
  async execute(event: SystemEvent): Promise<PipelineResult> {
    const startTime = Date.now();
    const results: MiddlewareResult[] = [];
    const errors: Error[] = [];
    let currentEvent = event;

    for (const middleware of this.middlewares) {
      const context: MiddlewareContext = {
        event: currentEvent,
        timestamp: new Date()
      };

      try {
        const result = await middleware.process(context);

        // Track if event was modified
        if (result.modified && result.modifiedEvent) {
          currentEvent = result.modifiedEvent;
        }

        results.push(result);

        // If middleware failed, stopOnError: stop execution
        if (!result.success && this.config.stopOnError) {
          logger.warn('Middleware ' + middleware.name + ' failed, stopping pipeline');
          break;
        }
      } catch (error) {
        const errorResult: MiddlewareResult = {
          success: false,
          error: error as Error,
          shouldContinue: false
        };
        results.push(errorResult);
        errors.push(error as Error);

        if (this.config.stopOnError) {
          break;
        }
      }
    }

    const executionTime = Date.now() - startTime;

    logger.info('Pipeline completed in ' + executionTime + 'ms with ' + results.length + ' results');

    return {
      success: errors.length === 0 && results.every(r => r.success),
      results,
      finalEvent: currentEvent,
      errors,
      executionTime
    };
  }

  /**
   * Get pipeline statistics
   */
  getStats(): {
    middlewareCount: number;
    middlewares: string[];
  } {
    return {
      middlewareCount: this.middlewares.length,
      middlewares: this.middlewares.map(m => m.name)
    };
  }

  /**
   * Clear all middlewares
   */
  clear(): void {
    this.middlewares = [];
    logger.info('Cleared all middlewares');
  }
}
