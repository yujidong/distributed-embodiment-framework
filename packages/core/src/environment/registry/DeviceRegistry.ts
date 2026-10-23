/**
 * Device Registry Module
 *
 * Extracted from EnvironmentCenter for Single Responsibility Principle.
 * Handles device registration, tracking, and owner management.
 */

import type { EventManager } from '../../events/EventManager.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '../../events/index.js';
import type { Device, DeviceCapability } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
// Re-export Device type for consumers
const logger = createLogger('DeviceRegistry');

export type { Device, DeviceCapability } from '@active-collaboration/shared';

/**
 * Device registration record
 */
export interface DeviceRegistration {
  device: Device;
  ownerId: string;
  registeredAt: Date;
  environmentAttached?: boolean;
}

/**
 * Device filter options
 */
export interface DeviceFilter {
  type?: string;
  ownerId?: string;
  location?: { x: number; y: number; z: number; radius?: number };
  capabilities?: string[];
}

/**
 * Device Registry - Handles device registration and management
 *
 * This class was extracted from EnvironmentCenter to follow Single Responsibility Principle.
 * It handles:
 * - Device registration and removal
 * - Owner tracking
 * - Device discovery and filtering
 */
export class DeviceRegistry {
  private devices: Map<string, DeviceRegistration> = new Map();
  private ownerDevices: Map<string, Set<string>> = new Map();

  constructor(
    private readonly environmentId: string,
    private readonly eventManager: EventManager,
    private readonly eventEmitter: EventEmitter
  ) {}

  /**
   * Register a device
   */
  registerDevice(device: Device, ownerId: string): DeviceRegistration {
    if (this.devices.has(device.id)) {
      throw new Error(`Device ${device.id} is already registered in this environment`);
    }

    const registration: DeviceRegistration = {
      device,
      ownerId,
      registeredAt: new Date(),
    };

    this.devices.set(device.id, registration);

    // Track device by owner
    if (!this.ownerDevices.has(ownerId)) {
      this.ownerDevices.set(ownerId, new Set());
    }
    this.ownerDevices.get(ownerId)!.add(device.id);

    logger.info(`Registered device: ${device.id} (${device.name}) owned by ${ownerId}`);

    // Emit device registered event
    this.eventEmitter.emit(EventType.DEVICE_REGISTERED, {
      environmentId: this.environmentId,
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      location: device.location,
      ownerId,
      capabilities: device.capabilities?.map(c => c.name) || [],
      timestamp: new Date(),
    });

    return registration;
  }

  /**
   * Unregister a device
   */
  unregisterDevice(deviceId: string): boolean {
    const registration = this.devices.get(deviceId);
    if (!registration) {
      return false;
    }

    this.devices.delete(deviceId);

    // Remove from owner tracking
    const ownerDevices = this.ownerDevices.get(registration.ownerId);
    if (ownerDevices) {
      ownerDevices.delete(deviceId);
      if (ownerDevices.size === 0) {
        this.ownerDevices.delete(registration.ownerId);
      }
    }

    logger.info(`Unregistered device: ${deviceId}`);
    return true;
  }

  /**
   * Get a device by ID
   */
  getDevice(deviceId: string): Device | undefined {
    return this.devices.get(deviceId)?.device;
  }

  /**
   * Get device registration by ID
   */
  getDeviceRegistration(deviceId: string): DeviceRegistration | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Check if device exists
   */
  hasDevice(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /**
   * Get all devices
   */
  getAllDevices(): Device[] {
    return Array.from(this.devices.values()).map(r => r.device);
  }

  /**
   * Get all device registrations
   */
  getAllRegistrations(): DeviceRegistration[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get devices by owner
   */
  getDevicesByOwner(ownerId: string): Device[] {
    const deviceIds = this.ownerDevices.get(ownerId);
    if (!deviceIds) {
      return [];
    }
    return Array.from(deviceIds)
      .map(id => this.devices.get(id)?.device)
      .filter((d): d is Device => d !== undefined);
  }

  /**
   * Get device owner
   */
  getDeviceOwner(deviceId: string): string | undefined {
    return this.devices.get(deviceId)?.ownerId;
  }

  /**
   * Filter devices by criteria
   */
  filterDevices(filter: DeviceFilter): Device[] {
    let devices = this.getAllDevices();

    if (filter.type) {
      devices = devices.filter(d => d.type === filter.type);
    }

    if (filter.ownerId) {
      devices = devices.filter(d => this.getDeviceOwner(d.id) === filter.ownerId);
    }

    if (filter.location) {
      const { x, y, z, radius = 0 } = filter.location;
      devices = devices.filter(d => {
        if (!d.location) return false;
        // Check if location is path property (structured location)
        if (typeof d.location === 'string') {
          return d.location === String(x); // Simple string comparison for path-based locations
        }
        // Otherwise assume it has x, y, z properties
        const loc = d.location as { path: string; position?: { x: number; y: number; z: number } };
        const distance = Math.sqrt(
          Math.pow((loc.position?.x || 0) - x, 2) +
          Math.pow((loc.position?.y || 0) - y, 2) +
          Math.pow((loc.position?.z || 0) - z, 2)
        );
        return distance <= radius;
      });
    }

    if (filter.capabilities && filter.capabilities.length > 0) {
      devices = devices.filter(d => {
        const deviceCaps = d.capabilities?.map(c => c.name.toLowerCase()) || [];
        return filter.capabilities!.some(cap =>
          deviceCaps.some(dc => dc.includes(cap.toLowerCase()))
        );
      });
    }

    return devices;
  }

  /**
   * Get devices by type
   */
  getDevicesByType(type: string): Device[] {
    return this.getAllDevices().filter(d => d.type === type);
  }

  /**
   * Get devices by location
   */
  getDevicesByLocation(location: { x: number; y: number; z: number }, radius?: number): Device[] {
    return this.filterDevices({ location: { ...location, radius } });
  }

  /**
   * Get devices with specific capability
   */
  getDevicesWithCapability(capability: string): Device[] {
    return this.filterDevices({ capabilities: [capability] });
  }

  /**
   * Get device count
   */
  getDeviceCount(): number {
    return this.devices.size;
  }

  /**
   * Get device count by owner
   */
  getDeviceCountByOwner(ownerId: string): number {
    return this.ownerDevices.get(ownerId)?.size || 0;
  }

  /**
   * Get owners list
   */
  getOwners(): string[] {
    return Array.from(this.ownerDevices.keys());
  }

  /**
   * Get devices grouped by owner
   */
  getDevicesGroupedByOwner(): Record<string, Device[]> {
    const result: Record<string, Device[]> = {};
    for (const [ownerId, deviceIds] of this.ownerDevices.entries()) {
      result[ownerId] = Array.from(deviceIds)
        .map(id => this.devices.get(id)?.device)
        .filter((d): d is Device => d !== undefined);
    }
    return result;
  }

  /**
   * Clear all devices
   */
  clearAll(): void {
    this.devices.clear();
    this.ownerDevices.clear();
    logger.info(`Cleared all devices`);
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalDevices: number;
    ownerCount: number;
    devicesByType: Record<string, number>;
    devicesByOwner: Record<string, number>;
  } {
    const devicesByType: Record<string, number> = {};
    const devicesByOwner: Record<string, number> = {};

    for (const registration of this.devices.values()) {
      const type = registration.device.type;
      devicesByType[type] = (devicesByType[type] || 0) + 1;

      const owner = registration.ownerId;
      devicesByOwner[owner] = (devicesByOwner[owner] || 0) + 1;
    }

    return {
      totalDevices: this.devices.size,
      ownerCount: this.ownerDevices.size,
      devicesByType,
      devicesByOwner,
    };
  }
}
