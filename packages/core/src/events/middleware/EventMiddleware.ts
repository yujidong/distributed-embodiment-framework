/**
 * Event Middleware Interface
 *
 * Provides middleware pattern for event processing pipeline
 * Supports guards, interceptors, and transformers
 */

import type { SystemEvent } from '../EventManager.js';
import type { EventSubscription } from '../EventManager.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Middleware execution context
 */
const logger = createLogger('EventMiddleware');

export interface MiddlewareContext {
  event: SystemEvent;
  subscription?: EventSubscription;
  timestamp: Date;
  abort?: () => void;
  next?: EventMiddleware | null;
}

/**
 * Middleware execution result
 */
export interface MiddlewareResult {
  success: boolean;
  modified?: boolean;
  modifiedEvent?: SystemEvent;
  error?: Error;
  shouldContinue?: boolean;
}

/**
 * Event Middleware Interface
 */
export interface EventMiddleware {
  /**
   * Unique identifier for the middleware
   */
  readonly id: string;

  /**
   * Middleware name for logging
   */
  readonly name: string;

  /**
   * Middleware priority (higher = earlier execution)
   */
  readonly priority: number;

  /**
   * Process event
   */
  process(context: MiddlewareContext): Promise<MiddlewareResult>;
}

/**
 * Base Middleware Abstract Class
 *
 * Provides common functionality for all middleware
 */
export abstract class BaseMiddleware implements EventMiddleware {
  public readonly id: string;
  public readonly name: string;
  public readonly priority: number;

  protected constructor(id: string, name: string, priority: number = 10) {
    this.id = id;
    this.name = name;
    this.priority = priority;
  }

  /**
   * Process event with error handling
   */
  async process(context: MiddlewareContext): Promise<MiddlewareResult> {
    try {
      return await this.handleEvent(context);
    } catch (error) {
      logger.error(`[BaseMiddleware:${this.name}] Error processing event:`, error);
      return {
        success: false,
        error: error as Error,
        shouldContinue: false,
      };
    }
  }

  /**
   * Abstract method to be implemented by subclasses
   */
  protected abstract handleEvent(context: MiddlewareContext): Promise<MiddlewareResult>;
}
