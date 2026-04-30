/**
 * Resource Allocator
 *
 * Handles resource allocation and sharing between agents
 * Ensures proper access control and prevents conflicts
 */

import { ResourceAllocationStatus, ResourceAllocation } from './Resource.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Allocation request
 */
const logger = createLogger('ResourceAllocator');

export interface AllocationRequest {
  resourceId: string;
  requestedBy: string; // Agent ID or user ID
  exclusive?: boolean; // If true, only this requester can use
  duration?: number; // Allocation duration in milliseconds
}

/**
 * Allocation result
 */
export interface AllocationResult {
  success: boolean;
  allocation?: ResourceAllocation;
  error?: string;
}

/**
 * Resource Allocator manages resource allocation and access control
 */
export class ResourceAllocator {
  // Track allocations: resourceId -> allocation
  private allocations: Map<string, ResourceAllocation>;

  constructor() {
    this.allocations = new Map();
    logger.info('Initialized');
  }

  /**
   * Request allocation of a resource
   * @param request - Allocation request
   * @returns Allocation result
   */
  requestAllocation(request: AllocationRequest): AllocationResult {
    logger.info(`Allocation request for ${request.resourceId} by ${request.requestedBy}`
    );

    const existing = this.allocations.get(request.resourceId);

    // Check if resource is already allocated
    if (existing) {
      // Check if existing allocation is exclusive
      if (existing.exclusive && existing.allocatedTo !== request.requestedBy) {
        logger.info(`Allocation denied: Resource is exclusively allocated to ${existing.allocatedTo}`
        );
        return {
          success: false,
          error: `Resource is exclusively allocated to ${existing.allocatedTo}`,
        };
      }

      // Check if existing allocation has expired
      if (existing.expiresAt && existing.expiresAt < new Date()) {
        logger.info(`Existing allocation expired, removing`);
        this.allocations.delete(request.resourceId);
      } else if (existing.allocatedTo !== request.requestedBy) {
        // Resource is shared, add another user
        logger.info(`Resource is shared, adding user`);
        // For simplicity, we don't implement multi-user allocation in MVP
        // In full implementation, we'd track multiple users per resource
      }
    }

    // Create new allocation
    const allocation: ResourceAllocation = {
      resourceId: request.resourceId,
      allocatedTo: request.requestedBy,
      status: ResourceAllocationStatus.ALLOCATED,
      allocatedAt: new Date(),
      exclusive: request.exclusive || false,
    };

    // Set expiration if duration specified
    if (request.duration) {
      allocation.expiresAt = new Date(Date.now() + request.duration);
      logger.info(`Allocation expires at ${allocation.expiresAt.toISOString()}`
      );
    }

    this.allocations.set(request.resourceId, allocation);

    logger.info(`Allocation granted: ${request.resourceId} -> ${request.requestedBy}`);

    return {
      success: true,
      allocation,
    };
  }

  /**
   * Release allocation of a resource
   * @param resourceId - Resource ID to release
   * @param releasedBy - User/agent releasing the resource
   * @returns Success status
   */
  releaseAllocation(resourceId: string, releasedBy: string): boolean {
    logger.info(`Release request for ${resourceId} by ${releasedBy}`);

    const allocation = this.allocations.get(resourceId);

    if (!allocation) {
      logger.info(`No allocation found for ${resourceId}`);
      return false;
    }

    if (allocation.allocatedTo !== releasedBy) {
      logger.info(`Release denied: Resource allocated to ${allocation.allocatedTo}, not ${releasedBy}`
      );
      return false;
    }

    this.allocations.delete(resourceId);
    logger.info(`Allocation released: ${resourceId}`);

    return true;
  }

  /**
   * Get allocation for a resource
   * @param resourceId - Resource ID
   * @returns Allocation or undefined
   */
  getAllocation(resourceId: string): ResourceAllocation | undefined {
    // Check if allocation has expired
    const allocation = this.allocations.get(resourceId);

    if (allocation && allocation.expiresAt && allocation.expiresAt < new Date()) {
      logger.info(`Allocation expired for ${resourceId}`);
      this.allocations.delete(resourceId);
      return undefined;
    }

    return allocation;
  }

  /**
   * Check if a resource is allocated to a specific user/agent
   * @param resourceId - Resource ID
   * @param userId - User/agent ID to check
   * @returns True if allocated to the user
   */
  isAllocatedTo(resourceId: string, userId: string): boolean {
    const allocation = this.getAllocation(resourceId);
    return allocation?.allocatedTo === userId;
  }

  /**
   * Check if a resource is available for allocation
   * @param resourceId - Resource ID
   * @returns True if available
   */
  isAvailable(resourceId: string): boolean {
    const allocation = this.getAllocation(resourceId);

    // No allocation means available
    if (!allocation) {
      return true;
    }

    // Exclusive allocation means not available to others
    if (allocation.exclusive) {
      return false;
    }

    // Non-exclusive allocation means available for sharing
    return true;
  }

  /**
   * Get all allocations for a user/agent
   * @param userId - User/agent ID
   * @returns Array of allocations
   */
  getAllocationsByUser(userId: string): ResourceAllocation[] {
    return Array.from(this.allocations.values()).filter((a) => a.allocatedTo === userId);
  }

  /**
   * Get all active allocations
   * @returns Array of allocations
   */
  getAllAllocations(): ResourceAllocation[] {
    // Clean up expired allocations first
    const now = new Date();
    for (const [resourceId, allocation] of this.allocations) {
      if (allocation.expiresAt && allocation.expiresAt < now) {
        this.allocations.delete(resourceId);
      }
    }

    return Array.from(this.allocations.values());
  }

  /**
   * Get allocation statistics
   * @returns Statistics object
   */
  getStats(): {
    total: number;
    exclusive: number;
    shared: number;
    byUser: Record<string, number>;
  } {
    const allocations = this.getAllAllocations();

    let exclusive = 0;
    const byUser: Record<string, number> = {};

    for (const allocation of allocations) {
      if (allocation.exclusive) {
        exclusive++;
      }

      byUser[allocation.allocatedTo] = (byUser[allocation.allocatedTo] || 0) + 1;
    }

    return {
      total: allocations.length,
      exclusive,
      shared: allocations.length - exclusive,
      byUser,
    };
  }

  /**
   * Clear all allocations
   */
  clear(): void {
    logger.info('Clearing all allocations');
    this.allocations.clear();
  }

  /**
   * Release all allocations for a user/agent
   * @param userId - User/agent ID
   * @returns Number of allocations released
   */
  releaseAllForUser(userId: string): number {
    logger.info(`Releasing all allocations for ${userId}`);

    let count = 0;

    for (const [resourceId, allocation] of this.allocations) {
      if (allocation.allocatedTo === userId) {
        this.allocations.delete(resourceId);
        count++;
      }
    }

    logger.info(`Released ${count} allocations for ${userId}`);

    return count;
  }
}
