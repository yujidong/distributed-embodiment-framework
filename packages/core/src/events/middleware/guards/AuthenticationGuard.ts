/**
 * Authentication Guard
 *
 * Verifies that event sources are authenticated
 * Ensures only authorized sources can publish events
 */

import type { MiddlewareContext } from '../EventMiddleware.js';
import type { MiddlewareResult } from '../EventMiddleware.js';
import { BaseMiddleware } from '../EventMiddleware.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Authentication configuration
 */
const logger = createLogger('AuthenticationGuard');

export interface AuthenticationConfig {
  /**
   * List of authorized source IDs
   */
  authorizedSources: string[];

  /**
   * Whether to allow unauthenticated sources (default: false)
   */
  allowUnauthenticated?: boolean;
}

/**
 * Authentication Guard Implementation
 */
export class AuthenticationGuard extends BaseMiddleware {
  private config: AuthenticationConfig;

  constructor(config: AuthenticationConfig) {
    super('auth-guard', 'AuthenticationGuard', 10);
    this.config = {
      authorizedSources: config.authorizedSources || [],
      allowUnauthenticated: config.allowUnauthenticated || false
    };
    logger.info(`Initialized with ${this.config.authorizedSources.length} authorized sources`);
  }

  protected async handleEvent(context: MiddlewareContext): Promise<MiddlewareResult> {
    const { event } = context;

    // Check if source is authorized
    const isAuthorized = this.config.authorizedSources.includes(event.source);

    if (!isAuthorized && !this.config.allowUnauthenticated) {
      logger.warn('Unauthorized event source: ' + event.source);
      return {
        success: false,
        error: new Error('Unauthorized event source: ' + event.source),
        shouldContinue: false
      };
    }

    return {
      success: true,
      shouldContinue: true
    };
  }
}
