/**
 * Environment Registry - manages all environment centers
 */

import type { EnvironmentCenterData } from './types.js';
import { EnvironmentCenter } from './EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Environment Registry class
 * Singleton that manages all environment centers in the system
 */
const logger = createLogger('EnvironmentRegistry');

export class EnvironmentRegistry {
  private static instance: EnvironmentRegistry | undefined;
  private centers: Map<string, EnvironmentCenter>;

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {
    this.centers = new Map();
    logger.info('Initialized');
  }

  /**
   * Get the singleton instance of EnvironmentRegistry
   * @returns The singleton instance
   */
  static getInstance(): EnvironmentRegistry {
    if (!EnvironmentRegistry.instance) {
      EnvironmentRegistry.instance = new EnvironmentRegistry();
      logger.info('Created new singleton instance');
    }
    return EnvironmentRegistry.instance;
  }

  /**
   * Register a new environment center
   * @param data - Environment center data
   * @returns Created environment center
   */
  register(data: EnvironmentCenterData): EnvironmentCenter {
    logger.info(`Registering environment center: ${data.id}, total before: ${this.centers.size}`);

    if (this.centers.has(data.id)) {
      logger.info(`Environment center already exists: ${data.id}`);
      throw new Error(`Environment center ${data.id} already registered`);
    }

    const center = new EnvironmentCenter(data);
    this.centers.set(data.id, center);

    logger.info(`Environment center registered: ${data.id}, total after: ${this.centers.size}`);
    return center;
  }

  /**
   * Get an environment center by ID
   * @param id - Environment center ID
   * @returns Environment center or undefined
   */
  get(id: string): EnvironmentCenter | undefined {
    const center = this.centers.get(id);
    logger.info(`Getting center ${id}: ${center ? 'found' : 'not found'}`);
    return center;
  }

  /**
   * Alias for get() - used by CrossCenterRouter
   * @param id - Environment center ID
   * @returns Environment center or undefined
   */
  getCenter(id: string): EnvironmentCenter | undefined {
    return this.get(id);
  }

  /**
   * Get all environment centers created by a specific user
   * @param userId - User ID
   * @returns Array of environment centers
   */
  getByCreator(userId: string): EnvironmentCenter[] {
    const centers = Array.from(this.centers.values()).filter(
      (center) => center.createdBy === userId
    );
    logger.info(`Found ${centers.length} centers created by: ${userId}`);
    return centers;
  }

  /**
   * Get all shared (platform-level) environment centers
   * @returns Array of shared environment centers
   */
  getSharedEnvironments(): EnvironmentCenter[] {
    const centers = Array.from(this.centers.values()).filter(
      (center) => center.environmentType === 'shared'
    );
    logger.info(`Found ${centers.length} shared environments`);
    return centers;
  }

  /**
   * Get all environments where user is a member
   * @param userId - User ID
   * @returns Array of environment centers
   */
  getEnvironmentsByMember(userId: string): EnvironmentCenter[] {
    const centers = Array.from(this.centers.values()).filter(
      (center) => center.isMember(userId)
    );
    logger.info(`Found ${centers.length} environments where user ${userId} is a member`);
    return centers;
  }

  /**
   * Get all environments visible to a user
   * Includes: platform shared + created by user + member of
   * @param userId - User ID
   * @returns Array of environment centers
   */
  getVisibleEnvironments(userId: string): EnvironmentCenter[] {
    logger.info(`Getting visible environments for user ${userId}, total in registry: ${this.centers.size}`);
    const visible: EnvironmentCenter[] = [];

    for (const center of this.centers.values()) {
      // Platform-level shared environments
      if (center.visibility === 'platform' && center.environmentType === 'shared') {
        visible.push(center);
        continue;
      }

      // Environments created by user or where user is a member
      if (center.createdBy === userId || center.isMember(userId)) {
        visible.push(center);
      }
    }

    logger.info(`Found ${visible.length} environments visible to user ${userId}`);
    return visible;
  }

  /**
   * List all environment centers
   * @returns Array of all environment centers
   */
  listAll(): EnvironmentCenter[] {
    const centers = Array.from(this.centers.values());
    logger.info(`Listing all centers: ${centers.length} total`);
    return centers;
  }

  /**
   * Update an environment center
   * @param id - Environment center ID
   * @param updates - Fields to update
   * @returns Updated environment center or undefined
   */
  update(
    id: string,
    updates: Partial<Pick<EnvironmentCenterData, 'name' | 'description'>>
  ): EnvironmentCenter | undefined {
    logger.info(`Updating center: ${id}`);

    const center = this.centers.get(id);
    if (!center) {
      logger.info(`Center not found: ${id}`);
      return undefined;
    }

    center.update(updates);
    logger.info(`Center updated: ${id}`);
    return center;
  }

  /**
   * Delete an environment center
   * @param id - Environment center ID
   * @returns True if deleted
   */
  delete(id: string): boolean {
    logger.info(`Deleting center: ${id}`);

    const deleted = this.centers.delete(id);
    logger.info(`Center ${deleted ? 'deleted' : 'not found'}: ${id}`);
    return deleted;
  }

  /**
   * Check if an environment center exists
   * @param id - Environment center ID
   * @returns True if exists
   */
  has(id: string): boolean {
    return this.centers.has(id);
  }

  /**
   * Get count of all environment centers
   * @returns Number of environment centers
   */
  count(): number {
    return this.centers.size;
  }

  /**
   * Clear all environment centers (use with caution!)
   */
  clear(): void {
    logger.info(`Clearing all centers (${this.centers.size} total)`);
    this.centers.clear();
  }
}

// Export singleton instance using getInstance() to ensure single instance
export const environmentRegistry = EnvironmentRegistry.getInstance();
