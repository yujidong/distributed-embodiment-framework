/**
 * Physics Integration Module
 *
 * Extracted from EnvironmentCenter for Single Responsibility Principle.
 * Handles physical environment synchronization and device effects.
 */

import type { EventManager } from '../../events/EventManager.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '../../events/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Physical parameter types
 */
const logger = createLogger('PhysicsIntegration');

export enum PhysicalParameter {
  TEMPERATURE = 'temperature',
  HUMIDITY = 'humidity',
  PRESSURE = 'pressure',
  LIGHT = 'light',
  SOUND = 'sound',
  AIR_QUALITY = 'air_quality',
  MOTION = 'motion',
  OCCUPANCY = 'occupancy',
}

/**
 * Effect type
 */
export type EffectType = 'point' | 'area' | 'gradient';

/**
 * Device effect configuration
 */
export interface DeviceEffectConfig {
  deviceId: string;
  parameter: PhysicalParameter | string;
  location: { x: number; y: number; z: number };
  type: EffectType;
  intensity: number;
  radius?: number;
  decay?: number;
  enabled?: boolean;
}

/**
 * Device-to-environment mapping
 */
export interface DeviceEnvironmentMapping {
  id: string;
  deviceId: string;
  deviceOutput: string;
  environmentParameter: string;
  transform?: 'direct' | 'inverse' | 'scaled';
  scaleFactor?: number;
  offset?: number;
  enabled: boolean;
}

/**
 * Physics Integration - Handles physical environment synchronization
 *
 * This class was extracted from EnvironmentCenter to follow Single Responsibility Principle.
 * It handles:
 * - Physical environment synchronization
 * - Device effect registration
 * - Device-to-environment mappings
 */
export class PhysicsIntegration {
  private deviceMappings: Map<string, DeviceEnvironmentMapping[]> = new Map();
  private registeredEffects: Map<string, DeviceEffectConfig> = new Map();

  constructor(
    private readonly environmentId: string,
    private readonly eventManager: EventManager,
    private readonly eventEmitter: EventEmitter,
    private physicalEnvironment?: any
  ) {}

  /**
   * Set physical environment
   */
  setPhysicalEnvironment(physicalEnvironment: any): void {
    this.physicalEnvironment = physicalEnvironment;
    logger.info(`Physical environment ${physicalEnvironment ? 'attached' : 'detached'}`);
  }

  /**
   * Check if physical environment is available
   */
  hasPhysicalEnvironment(): boolean {
    return this.physicalEnvironment !== undefined;
  }

  /**
   * Add device-to-environment mapping
   */
  addDeviceMapping(mapping: Omit<DeviceEnvironmentMapping, 'id'>): DeviceEnvironmentMapping {
    const mappingId = `mapping-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const fullMapping: DeviceEnvironmentMapping = {
      ...mapping,
      id: mappingId,
    };

    if (!this.deviceMappings.has(mapping.deviceId)) {
      this.deviceMappings.set(mapping.deviceId, []);
    }

    // Check for existing mapping with same deviceOutput
    const mappings = this.deviceMappings.get(mapping.deviceId)!;
    const existingIndex = mappings.findIndex(m => m.deviceOutput === mapping.deviceOutput);

    if (existingIndex !== -1) {
      mappings[existingIndex] = fullMapping;
    } else {
      mappings.push(fullMapping);
    }

    logger.info(`Added mapping: ${mapping.deviceId}.${mapping.deviceOutput} -> ${mapping.environmentParameter}`
    );

    return fullMapping;
  }

  /**
   * Get device mappings
   */
  getDeviceMappings(deviceId?: string): DeviceEnvironmentMapping[] {
    if (deviceId) {
      return this.deviceMappings.get(deviceId) || [];
    }

    // Return all mappings flattened
    const all: DeviceEnvironmentMapping[] = [];
    for (const mappings of this.deviceMappings.values()) {
      all.push(...mappings);
    }
    return all;
  }

  /**
   * Remove device mapping
   */
  removeDeviceMapping(mappingId: string): boolean {
    for (const [deviceId, mappings] of this.deviceMappings.entries()) {
      const index = mappings.findIndex(m => m.id === mappingId);
      if (index !== -1) {
        mappings.splice(index, 1);
        logger.info(`Removed mapping: ${mappingId}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Update device mapping
   */
  updateDeviceMapping(mappingId: string, updates: Partial<DeviceEnvironmentMapping>): boolean {
    for (const mappings of this.deviceMappings.values()) {
      const mapping = mappings.find(m => m.id === mappingId);
      if (mapping) {
        Object.assign(mapping, updates);
        logger.info(`Updated mapping: ${mappingId}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Process device state change and update environment parameters
   */
  processDeviceStateChange(
    deviceId: string,
    newState: Record<string, any>,
    setParameter: (key: string, value: any) => void
  ): void {
    const mappings = this.deviceMappings.get(deviceId);
    if (!mappings || mappings.length === 0) {
      return; // No mappings for this device
    }

    logger.info(`Processing state change for device ${deviceId}`);

    // Process each active mapping
    for (const mapping of mappings) {
      if (!mapping.enabled) {
        continue; // Skip disabled mappings
      }

      const deviceValue = newState[mapping.deviceOutput];
      if (deviceValue === undefined) {
        logger.info(`Device output ${mapping.deviceOutput} not found in state`);
        continue;
      }

      // Apply transformation
      let environmentValue = deviceValue;

      switch (mapping.transform) {
        case 'inverse':
          environmentValue = -deviceValue;
          break;
        case 'scaled':
          if (mapping.scaleFactor !== undefined) {
            environmentValue = deviceValue * mapping.scaleFactor;
          }
          if (mapping.offset !== undefined) {
            environmentValue += mapping.offset;
          }
          break;
        case 'direct':
        default:
          // Direct mapping, no transformation
          break;
      }

      // Update environment parameter via callback
      setParameter(mapping.environmentParameter, environmentValue);

      logger.info(`Updated parameter ${mapping.environmentParameter}: ${environmentValue} (from device ${deviceId}.${mapping.deviceOutput})`
      );
    }
  }

  /**
   * Register device effect with PhysicalEnvironment
   */
  registerDeviceEffect(
    deviceId: string,
    parameter: PhysicalParameter | string,
    config: {
      type: EffectType;
      intensity: number;
      radius?: number;
      decay?: number;
    },
    deviceGetter: (deviceId: string) => { location?: { x: number; y: number; z: number } } | undefined
  ): boolean {
    if (!this.physicalEnvironment) {
      logger.info(`No physical environment attached, cannot register device effect`);
      return false;
    }

    const device = deviceGetter(deviceId);
    if (!device) {
      logger.error(`Device ${deviceId} not found`);
      return false;
    }

    if (!device.location) {
      logger.error(`Device ${deviceId} has no location, cannot register effect`);
      return false;
    }

    try {
      const effectId = `${deviceId}-${parameter}`;

      this.physicalEnvironment.registerDeviceEffect({
        deviceId,
        parameter: parameter as PhysicalParameter,
        location: device.location,
        ...config,
      });

      // Track registered effect
      this.registeredEffects.set(effectId, {
        deviceId,
        parameter: parameter as PhysicalParameter,
        location: device.location,
        ...config,
      });

      logger.info(`Registered device effect: ${deviceId} affects ${parameter}`);
      return true;
    } catch (error) {
      logger.error(`Failed to register device effect:`, error);
      return false;
    }
  }

  /**
   * Unregister device effect
   */
  unregisterDeviceEffect(deviceId: string, parameter?: PhysicalParameter | string): boolean {
    if (!this.physicalEnvironment) {
      return false;
    }

    try {
      if (parameter) {
        const effectId = `${deviceId}-${parameter}`;
        this.registeredEffects.delete(effectId);
        this.physicalEnvironment.unregisterDeviceEffect(deviceId, parameter as PhysicalParameter);
      } else {
        // Remove all effects for this device
        for (const [effectId, effect] of this.registeredEffects.entries()) {
          if (effect.deviceId === deviceId) {
            this.registeredEffects.delete(effectId);
          }
        }
        this.physicalEnvironment.unregisterDeviceEffect(deviceId);
      }

      logger.info(`Unregistered device effect: ${deviceId}${parameter ? ` for ${parameter}` : ''}`
      );
      return true;
    } catch (error) {
      logger.error(`Failed to unregister device effect:`, error);
      return false;
    }
  }

  /**
   * Sync environment parameters from PhysicalEnvironment
   */
  syncFromPhysicalEnvironment(
    devices: Array<{ id: string; location?: { x: number; y: number; z: number }; capabilities?: any[] }>,
    setParameter?: (key: string, value: any) => void
  ): void {
    if (!this.physicalEnvironment) {
      logger.info(`No physical environment attached, skipping sync`);
    return;
    }

    logger.info(`Syncing parameters from physical environment`);

    for (const device of devices) {
      if (!device.location) {
        continue; // Skip devices without location
      }

      // Sync all available parameters
      const paramsToSync = Object.keys(device.capabilities || {});

      for (const param of paramsToSync) {
        try {
          const value = this.physicalEnvironment.getParameterValue(param, device.location);
          if (setParameter) {
            setParameter(param, value);
            logger.info(`Synced ${param} = ${value} for device ${device.id}`);
          }
        } catch (error) {
          logger.warn(`Failed to sync ${param} for device ${device.id}:`, error);
        }
      }
    }
  }

  /**
   * Start physics simulation
   */
  startSimulation(): boolean {
    if (!this.physicalEnvironment) {
      logger.info(`No physical environment attached, cannot start simulation`);
      return false;
    }

    try {
      this.physicalEnvironment.startPhysicsSimulation();
      logger.info(`Physics simulation started`);
      return true;
    } catch (error) {
      logger.error(`Failed to start physics simulation:`, error);
      return false;
    }
  }

  /**
   * Stop physics simulation
   */
  stopSimulation(): boolean {
    if (!this.physicalEnvironment) {
      return false;
    }

    try {
      this.physicalEnvironment.stopPhysicsSimulation();
      logger.info(`Physics simulation stopped`);
      return true;
    } catch (error) {
      logger.error(`Failed to stop physics simulation:`, error);
      return false;
    }
  }

  /**
   * Get physics engine
   */
  getPhysicsEngine(): any {
    if (this.physicalEnvironment && typeof this.physicalEnvironment.getPhysicsEngine === 'function') {
      return this.physicalEnvironment.getPhysicsEngine();
    }
    return undefined;
  }

  /**
   * Get registered effects
   */
  getRegisteredEffects(): DeviceEffectConfig[] {
    return Array.from(this.registeredEffects.values());
  }

  /**
   * Get integration statistics
   */
  getStats(): {
    hasPhysicalEnvironment: boolean;
    mappingCount: number;
    effectCount: number;
    simulationRunning: boolean;
  } {
    return {
      hasPhysicalEnvironment: this.hasPhysicalEnvironment(),
      mappingCount: this.getDeviceMappings().length,
      effectCount: this.registeredEffects.size,
      simulationRunning: this.hasPhysicalEnvironment() && this.physicalEnvironment?.isSimulationRunning?.() || false,
    };
  }
}
