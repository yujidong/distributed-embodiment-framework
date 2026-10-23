/**
 * Permission Guard
 *
 * Verifies that event sources have required permissions
 * Checks permission-based access control
 */

import type { MiddlewareContext, MiddlewareResult } from '../EventMiddleware.js';
import { BaseMiddleware } from '../EventMiddleware.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Permission configuration
 */
const logger = createLogger('PermissionGuard');

export interface PermissionConfig {
  /**
   * Map of source to required permissions
   */
  requiredPermissions: Record<string, string[]>;

  /**
   * Default permissions if source not in map (default: [])
   */
  defaultPermissions?: string[];
}

/**
 * Permission Guard Implementation
 */
export class PermissionGuard extends BaseMiddleware {
  private config: PermissionConfig;

  constructor(config: PermissionConfig) {
    super('permission-guard', 'PermissionGuard', 20)
    this.config = config
    logger.info(`Initialized`)
  }

  /**
   * Handle event through permission guard
   */
  protected async handleEvent(context: MiddlewareContext): Promise<MiddlewareResult> {
    const { event } = context

    // Get required permissions for this source
    const requiredPerms = this.config.requiredPermissions[event.source] || this.config.defaultPermissions || []

    // If no permissions required, allow
    if (requiredPerms.length === 0) {
      return {
        success: true,
        shouldContinue: true
      }
    }

    // Check if event has required permissions in metadata
    const eventPermissions = (event.metadata?.permissions as string[]) || []

    for (const perm of requiredPerms) {
      if (!eventPermissions.includes(perm)) {
        logger.warn(`Event ${event.id} missing required permission: ${perm}`)
        return {
          success: false,
          error: new Error(`Missing required permission: ${perm}`),
          shouldContinue: false
        }
      }
    }

    return {
      success: true,
      shouldContinue: true
    }
  }

  /**
   * Add required permission for source
   */
  addRequiredPermission(source: string, permission: string): void {
    if (!this.config.requiredPermissions[source]) {
      this.config.requiredPermissions[source] = []
    }
    if (!this.config.requiredPermissions[source].includes(permission)) {
      this.config.requiredPermissions[source].push(permission)
      logger.info(`Added required permission ${permission} for source ${source}`)
    }
  }

  /**
   * Remove required permission for source
   */
  removeRequiredPermission(source: string, permission: string): void {
    const permissions = this.config.requiredPermissions[source]
    if (permissions) {
      const index = permissions.indexOf(permission)
      if (index !== -1) {
        permissions.splice(index, 1)
        logger.info(`Removed required permission ${permission} for source ${source}`)
      }
    }
  }
}
