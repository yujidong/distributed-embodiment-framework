/**
 * Resource Manager
 *
 * Manages all resources in the system
 * Provides resource discovery and LLM specification generation
 */

import type { Device } from '@active-collaboration/shared';
import { Resource, ResourceState, ResourceMetadata } from './Resource.js';
import { DeviceResource } from './DeviceResource.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Resource filter criteria
 */
const logger = createLogger('ResourceManager');

export interface ResourceFilter {
  type?: string;
  category?: string;
  location?: string;
  tags?: string[];
  available?: boolean;
  owner?: string;
}

/**
 * Resource Manager manages all resources and provides discovery
 */
export class ResourceManager {
  private resources: Map<string, Resource>;
  private devices: Map<string, Device>; // Track original devices

  constructor() {
    this.resources = new Map();
    this.devices = new Map();
    logger.info('Initialized');
  }

  /**
   * Register a device as a resource
   * @param device - Device to register
   * @param owner - User ID who owns this device
   */
  registerDevice(device: Device, owner: string): void {
    logger.info(`Registering device: ${device.name} (${device.id})`);

    // Create device resource wrapper
    const resource = new DeviceResource(device, owner);

    // Store resource and device
    this.resources.set(device.id, resource);
    this.devices.set(device.id, device);

    logger.info(`Device registered as resource: ${device.id}`);
  }

  /**
   * Unregister a device
   * @param deviceId - Device ID to unregister
   */
  unregisterDevice(deviceId: string): void {
    logger.info(`Unregistering device: ${deviceId}`);

    this.resources.delete(deviceId);
    this.devices.delete(deviceId);

    logger.info(`Device unregistered: ${deviceId}`);
  }

  /**
   * Get a resource by ID
   * @param resourceId - Resource ID
   * @returns Resource or undefined
   */
  getResource(resourceId: string): Resource | undefined {
    return this.resources.get(resourceId);
  }

  /**
   * Get all resources
   * @returns Array of all resources
   */
  getAllResources(): Resource[] {
    return Array.from(this.resources.values());
  }

  /**
   * Get all devices registered in this manager
   * @returns Array of all devices
   */
  getAllDevices(): Device[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get total resource count
   * @returns Number of resources managed by this manager
   */
  getResourceCount(): number {
    return this.resources.size;
  }

  /**
   * Get resources by owner
   * @param owner - Owner user ID
   * @returns Array of resources owned by the user
   */
  getResourcesByOwner(owner: string): Resource[] {
    return this.getAllResources().filter((r) => r.owner === owner);
  }

  /**
   * Find resources by filter criteria
   * @param filter - Filter criteria
   * @returns Array of matching resources
   */
  findResources(filter: ResourceFilter): Resource[] {
    logger.info('Finding resources with filter:', filter);

    let results = this.getAllResources();

    if (filter.type) {
      results = results.filter((r) => r.type === filter.type);
    }

    if (filter.category) {
      results = results.filter((r) => r.category === filter.category);
    }

    if (filter.location) {
      results = results.filter((r) => r.location === filter.location);
    }

    if (filter.tags && filter.tags.length > 0) {
      results = results.filter((r) =>
        filter.tags!.some((tag) => r.tags.includes(tag))
      );
    }

    if (filter.available !== undefined) {
      results = results.filter((r) => r.isAvailable() === filter.available);
    }

    if (filter.owner) {
      results = results.filter((r) => r.owner === filter.owner);
    }

    logger.info(`Found ${results.length} resources matching filter`);

    return results;
  }

  /**
   * Get resources by location
   * @param location - Location to search
   * @returns Resources in the location
   */
  getResourcesByLocation(location: string): Resource[] {
    return this.findResources({ location });
  }

  /**
   * Get resources by category
   * @param category - Category to filter
   * @returns Resources in the category
   */
  getResourcesByCategory(category: string): Resource[] {
    return this.findResources({ category });
  }

  /**
   * Get resources that have a specific capability
   * @param capabilityName - Capability name to search for
   * @returns Array of resources that have the specified capability
   */
  getResourcesByCapability(capabilityName: string): Resource[] {
    const lowerCap = capabilityName.toLowerCase();
    return this.getAllResources().filter((r) =>
      r.getCapabilities().some(
        (c) =>
          c.name.toLowerCase() === lowerCap ||
          c.name.toLowerCase().includes(lowerCap) ||
          lowerCap.includes(c.name.toLowerCase())
      )
    );
  }

  /**
   * Get all resource metadata
   * @returns Array of resource metadata
   */
  getAllMetadata(): ResourceMetadata[] {
    return this.getAllResources().map((r) => r.getMetadata());
  }

  /**
   * Get all resource states
   * @returns Map of resource ID to state
   */
  getAllStates(): Map<string, ResourceState> {
    const states = new Map<string, ResourceState>();

    for (const [id, resource] of this.resources) {
      states.set(id, resource.getState());
    }

    return states;
  }

  /**
   * Get LLM specification for all resources
   * Returns a structured description for LLM consumption
   * @returns LLM specification string
   */
  getLLMSpec(): string {
    const resources = this.getAllResources();

    if (resources.length === 0) {
      return 'No resources available.';
    }

    // Group resources by category
    const byCategory = new Map<string, Resource[]>();
    for (const resource of resources) {
      if (!byCategory.has(resource.category)) {
        byCategory.set(resource.category, []);
      }
      byCategory.get(resource.category)!.push(resource);
    }

    // Build specification
    let spec = `# Available Resources (${resources.length} total)\n\n`;

    for (const [category, categoryResources] of byCategory) {
      spec += `## ${category.charAt(0).toUpperCase() + category.slice(1)}s (${
        categoryResources.length
      })\n\n`;

      for (const resource of categoryResources) {
        spec += resource.getLLMSpec() + '\n\n';
      }
    }

    return spec;
  }

  /**
   * Get LLM specification for specific resources
   * @param resourceIds - Resource IDs to include
   * @returns LLM specification string
   */
  getLLMSpecForResources(resourceIds: string[]): string {
    const resources = resourceIds
      .map((id) => this.resources.get(id))
      .filter((r): r is Resource => r !== undefined);

    if (resources.length === 0) {
      return 'No resources found.';
    }

    let spec = `# Selected Resources (${resources.length} total)\n\n`;

    for (const resource of resources) {
      spec += resource.getLLMSpec() + '\n\n';
    }

    return spec;
  }

  /**
   * Get resource statistics
   * @returns Statistics object
   */
  getStats(): {
    total: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
    byLocation: Record<string, number>;
    available: number;
  } {
    const resources = this.getAllResources();

    const byType: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byLocation: Record<string, number> = {};
    let available = 0;

    for (const resource of resources) {
      // Count by type
      byType[resource.type] = (byType[resource.type] || 0) + 1;

      // Count by category
      byCategory[resource.category] = (byCategory[resource.category] || 0) + 1;

      // Count by location (convert to string if object)
      const locationKey = typeof resource.location === 'string'
        ? resource.location
        : (resource.location.path || JSON.stringify(resource.location));
      byLocation[locationKey] = (byLocation[locationKey] || 0) + 1;

      // Count available
      if (resource.isAvailable()) {
        available++;
      }
    }

    return {
      total: resources.length,
      byType,
      byCategory,
      byLocation,
      available,
    };
  }

  /**
   * Clear all resources
   */
  clear(): void {
    logger.info('Clearing all resources');
    this.resources.clear();
    this.devices.clear();
  }

  /**
   * Get resource count
   * @returns Number of resources
   */
  getCount(): number {
    return this.resources.size;
  }
}
