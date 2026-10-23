/**
 * Spatial Manager
 *
 * Manages spatial zones and locations for IoT simulation.
 * Provides coordinate-based device positioning and spatial queries.
 */

import { SpatialUtils, Zone, SpatialLocation, Coordinate2D, Coordinate3D, DistanceMethod } from './SpatialUtils.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device position in space
 */
const logger = createLogger('SpatialManager');

export interface DevicePosition {
  deviceId: string;
  location: string;
  position: Coordinate2D | Coordinate3D;
  zoneId?: string;
}

/**
 * Spatial Manager Class
 */
export class SpatialManager {
  private zones: Map<string, Zone>;
  private locations: Map<string, SpatialLocation>;
  private devicePositions: Map<string, DevicePosition>;

  constructor() {
    this.zones = new Map();
    this.locations = new Map();
    this.devicePositions = new Map();
    logger.info('Initialized');
  }

  /**
   * Register a zone
   * @param zone - Zone to register
   */
  registerZone(zone: Zone): void {
    this.zones.set(zone.id, zone);
    logger.info(`Registered zone: ${zone.name} (${zone.id})`);
  }

  /**
   * Get a zone by ID
   * @param zoneId - Zone ID
   * @returns Zone or undefined
   */
  getZone(zoneId: string): Zone | undefined {
    return this.zones.get(zoneId);
  }

  /**
   * Get all zones
   * @returns Array of all zones
   */
  getAllZones(): Zone[] {
    return Array.from(this.zones.values());
  }

  /**
   * Register a location with spatial position
   * @param location - Location to register
   */
  registerLocation(location: SpatialLocation): void {
    this.locations.set(location.id, location);
    logger.info(`Registered location: ${location.name} (${location.id})`);
  }

  /**
   * Get a location by ID
   * @param locationId - Location ID
   * @returns Location or undefined
   */
  getLocation(locationId: string): SpatialLocation | undefined {
    return this.locations.get(locationId);
  }

  /**
   * Get location by path
   * @param path - Location path
   * @returns Location or undefined
   */
  getLocationByPath(path: string): SpatialLocation | undefined {
    for (const location of this.locations.values()) {
      if (location.path === path) {
        return location;
      }
    }
    return undefined;
  }

  /**
   * List all registered locations
   * @returns Array of all locations
   */
  listLocations(): SpatialLocation[] {
    return Array.from(this.locations.values());
  }

  /**
   * Set device position
   * @param deviceId - Device ID
   * @param location - Location path
   * @param position - Spatial position
   * @param zoneId - Optional zone ID
   */
  setDevicePosition(
    deviceId: string,
    location: string,
    position: Coordinate2D | Coordinate3D,
    zoneId?: string
  ): void {
    this.devicePositions.set(deviceId, {
      deviceId,
      location,
      position,
      zoneId,
    });
    logger.info(`Set device ${deviceId} position at`, position);
  }

  /**
   * Get device position
   * @param deviceId - Device ID
   * @returns Device position or undefined
   */
  getDevicePosition(deviceId: string): DevicePosition | undefined {
    return this.devicePositions.get(deviceId);
  }

  /**
   * Remove device position
   * @param deviceId - Device ID
   */
  removeDevicePosition(deviceId: string): void {
    this.devicePositions.delete(deviceId);
    logger.info(`Removed device ${deviceId} position`);
  }

  /**
   * Calculate distance between two devices
   * @param deviceId1 - First device ID
   * @param deviceId2 - Second device ID
   * @param method - Distance calculation method
   * @returns Distance or -1 if positions not found
   */
  getDistanceBetweenDevices(
    deviceId1: string,
    deviceId2: string,
    method: DistanceMethod = DistanceMethod.EUCLIDEAN
  ): number {
    const pos1 = this.devicePositions.get(deviceId1);
    const pos2 = this.devicePositions.get(deviceId2);

    if (!pos1 || !pos2) {
      logger.warn(`Cannot calculate distance: device positions not found`);
      return -1;
    }

    return SpatialUtils.distance(pos1.position, pos2.position, method);
  }

  /**
   * Find devices within radius of a point
   * @param position - Center position
   * @param radius - Search radius
   * @returns Array of device positions within radius
   */
  findDevicesNearby(
    position: Coordinate2D | Coordinate3D,
    radius: number
  ): DevicePosition[] {
    const nearby: DevicePosition[] = [];

    for (const devicePos of this.devicePositions.values()) {
      const distance = SpatialUtils.distance(position, devicePos.position);
      if (distance <= radius) {
        nearby.push(devicePos);
      }
    }

    return nearby;
  }

  /**
   * Find devices in a zone
   * @param zoneId - Zone ID
   * @returns Array of device positions in zone
   */
  findDevicesInZone(zoneId: string): DevicePosition[] {
    const inZone: DevicePosition[] = [];

    for (const devicePos of this.devicePositions.values()) {
      if (devicePos.zoneId === zoneId) {
        inZone.push(devicePos);
      }
    }

    return inZone;
  }

  /**
   * Get zone for a location
   * @param locationId - Location ID
   * @returns Zone or undefined
   */
  getZoneForLocation(locationId: string): Zone | undefined {
    const location = this.locations.get(locationId);
    if (!location || !location.zoneId) {
      return undefined;
    }

    return this.zones.get(location.zoneId);
  }

  /**
   * Calculate effect strength at a point based on source position and falloff
   * @param sourcePosition - Source position
   * @param targetPosition - Target position
   * @param magnitude - Effect magnitude at source
   * @param radius - Effect radius
   * @param falloffType - Falloff type
   * @returns Effect strength at target position
   */
  calculateEffectStrength(
    sourcePosition: Coordinate2D | Coordinate3D,
    targetPosition: Coordinate2D | Coordinate3D,
    magnitude: number,
    radius: number,
    falloffType: 'linear' | 'inverse-square' | 'exponential' = 'linear'
  ): number {
    const distance = SpatialUtils.distance(sourcePosition, targetPosition);
    const falloff = SpatialUtils.calculateFalloff(distance, radius, falloffType);
    return magnitude * falloff;
  }

  /**
   * Get statistics
   */
  getStats(): {
    zoneCount: number;
    locationCount: number;
    devicePositionCount: number;
  } {
    return {
      zoneCount: this.zones.size,
      locationCount: this.locations.size,
      devicePositionCount: this.devicePositions.size,
    };
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.zones.clear();
    this.locations.clear();
    this.devicePositions.clear();
    logger.info('Cleared all data');
  }
}
