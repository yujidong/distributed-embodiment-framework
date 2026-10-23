/**
 * Logging Interceptor
 *
 * Logs all events passing through the pipeline
 * Provides comprehensive event logging
 */

import type { MiddlewareContext, MiddlewareResult } from '../EventMiddleware.js';
import { BaseMiddleware } from '../EventMiddleware.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Logging configuration
 */
const logger = createLogger('LoggingInterceptor');

export interface LoggingConfig {
  /**
   * Whether to log event payload (default: true)
   */
  logPayload?: boolean

  /**
   * Whether to log event metadata (default: false)
   */
  logMetadata?: boolean

  /**
   * Log level (default: 'info')
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'

  /**
   * Event types to exclude from logging
   */
  excludeTypes?: string[]
}

/**
 * Internal logging configuration with required fields
 */
interface InternalLoggingConfig {
  logPayload: boolean;
  logMetadata: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  excludeTypes: string[];
}

/**
 * Logging Interceptor Implementation
 */
export class LoggingInterceptor extends BaseMiddleware {
  private config: InternalLoggingConfig

  constructor(config: LoggingConfig = {}) {
    super('logging-interceptor', 'LoggingInterceptor', 30)
    this.config = {
      logPayload: config.logPayload ?? true,
      logMetadata: config.logMetadata ?? false,
      logLevel: config.logLevel ?? 'info',
      excludeTypes: config.excludeTypes || [],
    }
    logger.info(`Initialized`)
  }

  /**
   * Handle event through logging interceptor
   */
  protected async handleEvent(context: MiddlewareContext): Promise<MiddlewareResult> {
    const { event } = context

    // Check if this event type should be excluded
    if (this.config.excludeTypes.includes(event.type)) {
      return {
        success: true,
        shouldContinue: true
      }
    }

    // Log event
    const logMessage = `[LoggingInterceptor] Event: ${event.type} from ${event.source} (${event.id})`

    switch (this.config.logLevel) {
      case 'debug':
        logger.debug(logMessage)
        break
      case 'warn':
        logger.warn(logMessage)
        break
      case 'error':
        logger.error(logMessage)
        break
      case 'info':
      default:
        logger.info(logMessage)
    }

    // Optionally log payload
    if (this.config.logPayload && event.payload) {
      logger.info(`Payload:`, JSON.stringify(event.payload, null, 2))
    }

    // Optionally log metadata
    if (this.config.logMetadata && event.metadata) {
      logger.info(`Metadata:`, JSON.stringify(event.metadata, null, 2))
    }

    return {
      success: true,
      shouldContinue: true
    }
  }

  /**
   * Add event type to exclude list
   */
  addExcludedType(eventType: string): void {
    if (!this.config.excludeTypes.includes(eventType)) {
      this.config.excludeTypes.push(eventType)
      logger.info(`Added excluded type: ${eventType}`)
    }
  }

  /**
   * Remove event type from exclude list
   */
  removeExcludedType(eventType: string): void {
    const index = this.config.excludeTypes.indexOf(eventType)
    if (index !== -1) {
      this.config.excludeTypes.splice(index, 1)
      logger.info(`Removed excluded type: ${eventType}`)
    }
  }
}
