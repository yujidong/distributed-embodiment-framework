/**
 * Environment Effect Manager
 *
 * Manages how device operations affect physical environment parameters.
 * Listens to DEVICE_OPERATION_EXECUTED events and applies effects through PhysicsLayer.
 *
 * Architecture:
 * Device.executeCommand() → emits DEVICE_OPERATION_EXECUTED event
 * → EnvironmentEffectManager handles event
 * → Registers effect with PhysicsLayer
 * → PhysicalEnvironment parameters change
 */

import type { EventManager } from '@active-collaboration/core';
import { EventType, EventPriority } from '@active-collaboration/shared';
import type { PhysicalEnvironment } from './PhysicalEnvironment.js';
import type { PhysicsLayer } from '../physics/PhysicsLayer.js';
import type {
  EnvironmentEffectDeclaration,
  DeviceLocation,
} from '../devices/types.js';
import { PhysicalParameter } from '../devices/types.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device operation executed event payload (from shared types)
 */
interface DeviceOperationExecutedEvent {
  deviceId: string;
  deviceName?: string;
  commandName: string;
  params?: any;
  result?: any;
  executionTime?: number;
}

/**
 * Environment Effect Manager Options
 */
const logger = createLogger('EnvironmentEffectManager');

export interface EnvironmentEffectManagerOptions {
  eventManager: EventManager;
  physicalEnvironment: PhysicalEnvironment;
  deviceTemplateRegistry: any; // DeviceTemplateRegistry
  deviceGetter?: (deviceId: string) => any; // Optional device getter function
}

/**
 * Active effect tracking
 */
interface ActiveEffect {
  deviceId: string;
  parameter: PhysicalParameter;
  effectType: string;
  timeoutId?: NodeJS.Timeout;
  registeredAt: Date;
}

/**
 * Environment Effect Manager
 *
 * Bridges device operations and physical environment effects.
 * When a device executes a command, this manager checks if the command
 * has declared environment effects and applies them through PhysicsLayer.
 */
export class EnvironmentEffectManager {
  private eventManager: EventManager;
  private physicalEnvironment: PhysicalEnvironment;
  private deviceTemplateRegistry: any;
  private physicsLayer?: PhysicsLayer;
  private subscriptionId?: string;
  private activeEffects: Map<string, ActiveEffect[]> = new Map();
  private enabled: boolean = true;
  private deviceGetter?: (deviceId: string) => any;

  constructor(options: EnvironmentEffectManagerOptions) {
    this.eventManager = options.eventManager;
    this.physicalEnvironment = options.physicalEnvironment;
    this.deviceTemplateRegistry = options.deviceTemplateRegistry;
    this.deviceGetter = options.deviceGetter;

    // Get physics layer from physical environment
    this.physicsLayer = this.physicalEnvironment.getPhysicsLayer();

    if (!this.physicsLayer) {
      logger.warn('PhysicsLayer not available, effects will not be applied');
    }

    logger.info('Initialized');
  }

  /**
   * Start listening for device operation events
   */
  start(): void {
    if (!this.enabled) {
      logger.info('Not enabled, not starting');
      return;
    }

    logger.info('Starting to listen for device operations');

    // Subscribe to DEVICE_OPERATION_EXECUTED events
    this.subscriptionId = this.eventManager.subscribe({
      subscriberId: 'environment-effect-manager',
      eventType: EventType.DEVICE_OPERATION_EXECUTED,
      handler: this.handleOperationExecuted.bind(this),
      priority: EventPriority.NORMAL,
    });

    logger.info('Started listening');
  }

  /**
   * Stop listening for device operation events
   */
  stop(): void {
    logger.info('Stopping');

    if (this.subscriptionId) {
      this.eventManager.unsubscribe(this.subscriptionId);
      this.subscriptionId = undefined;
    }

    // Clean up all active effects
    this.cleanupAllEffects();

    logger.info('Stopped');
  }

  /**
   * Handle device operation executed event
   */
  private async handleOperationExecuted(event: any): Promise<void> {
    if (!this.enabled || !this.physicsLayer) {
      return;
    }

    const payload = event.payload as DeviceOperationExecutedEvent;
    const { deviceId, commandName, params } = payload;

    logger.info(`Device ${deviceId} executed command: ${commandName}`);

    // Get device to find its type and location
    const device = this.getDeviceById(deviceId);
    if (!device) {
      logger.warn(`Device not found: ${deviceId}`);
      return;
    }

    const deviceType = device.type;
    const deviceLocation = this.getDeviceLocation(device);

    // Get device template with effects
    // Try to find template by device type first, then by name
    let template = this.deviceTemplateRegistry.getTemplate(deviceType);

    if (!template) {
      // If not found by name, search through all templates for matching type
      const allTemplates = this.deviceTemplateRegistry.listTemplates();
      logger.info(`Template not found by name '${deviceType}', searching ${allTemplates.length} templates by type...`);
      template = allTemplates.find((t: any) => t.type === deviceType);
      if (template) {
        logger.info(`Found template '${template.name}' with matching type '${deviceType}'`);
      }
    }

    if (!template) {
      logger.info(`No template found for device type: ${deviceType}`);
      return;
    }

    if (!template.environmentEffects || template.environmentEffects.length === 0) {
      logger.info(`Template '${template.name}' has no environment effects declared`);
      return;
    }

    logger.info(`Found template '${template.name}' with ${template.environmentEffects.length} environment effects`);

    // Find matching effects for this command
    const matchingEffects = template.environmentEffects.filter(
      (effectDecl: EnvironmentEffectDeclaration) => {
        // Check if command matches
        if (effectDecl.command !== commandName) {
          return false;
        }

        // Check if condition is met
        if (effectDecl.condition) {
          const conditionMet = this.evaluateCondition(effectDecl.condition, params);
          if (!conditionMet) {
            logger.info(`Condition not met for ${commandName}`);
            return false;
          }
        }

        return true;
      }
    );

    logger.info(`Found ${matchingEffects.length} matching effects`);

    // Apply each matching effect
    for (const effectDecl of matchingEffects) {
      await this.applyEffect(deviceId, deviceLocation, effectDecl);
    }
  }

  /**
   * Apply an environment effect
   */
  private async applyEffect(
    deviceId: string,
    location: DeviceLocation | string,
    effectDecl: EnvironmentEffectDeclaration
  ): Promise<void> {
    const { parameter, effect, magnitude, duration, spatial } = effectDecl;

    logger.info(`Applying ${effect} effect on ${parameter}: magnitude=${magnitude}`);

    const normalizedLocation = this.normalizeLocation(location);

    // Map effect type to PhysicsLayer effect type
    const physicsEffectType = this.mapToPhysicsEffectType(parameter, effect, magnitude);

    if (!physicsEffectType) {
      logger.warn(`Cannot map ${parameter}+${effect} to physics effect`);
      return;
    }

    // Calculate affected area
    const radius = spatial?.radius || 5; // Default 5 meter radius

    // Remove old effect for this device+parameter before registering new one
    // This ensures that "turning off" a light replaces the "on" effect instead of adding to it
    this.physicsLayer!.unregisterDeviceEffect(deviceId, parameter);

    // Register with PhysicsLayer
    this.physicsLayer!.registerDeviceEffect({
      deviceId,
      parameter,
      effect: physicsEffectType,
      magnitude,
      affectedArea: {
        location: typeof normalizedLocation === 'string'
          ? normalizedLocation
          : normalizedLocation.path,
        radius,
      },
      enabled: true,
    });

    logger.info(`Registered physics effect for ${deviceId}`);

    // Remove old active effect tracking for this device+parameter
    this.removeActiveEffect(deviceId, parameter);

    // Track active effect
    this.trackActiveEffect(deviceId, {
      deviceId,
      parameter,
      effectType: physicsEffectType,
      registeredAt: new Date(),
    });

    // Handle effect lifecycle based on type
    if (effect === 'immediate') {
      // Immediate effects: unregister after a short delay (1 second)
      this.scheduleEffectRemoval(deviceId, parameter, 1000);
    } else if (effect === 'gradual' && duration) {
      // Gradual effects: unregister after duration
      const durationMs = duration * 1000;
      this.scheduleEffectRemoval(deviceId, parameter, durationMs);
    }
    // Persistent effects: stay until device turns off or explicitly removed
  }

  /**
   * Map effect declaration to PhysicsLayer effect type
   * Returns 'heating' | 'cooling' | 'humidity' | 'light' | 'motion' | null
   */
  private mapToPhysicsEffectType(
    parameter: PhysicalParameter,
    effect: string,
    magnitude: number
  ): 'heating' | 'cooling' | 'humidity' | 'light' | 'motion' | null {
    // Map parameter+effect to physics effect types
    if (parameter === PhysicalParameter.TEMPERATURE) {
      if (effect === 'gradual' || effect === 'persistent') {
        // Determine heating or cooling based on magnitude sign
        return magnitude > 0 ? 'heating' : 'cooling';
      }
    }

    if (parameter === PhysicalParameter.HUMIDITY) {
      return 'humidity';
    }

    if (parameter === PhysicalParameter.LIGHT) {
      return 'light';
    }

    if (parameter === PhysicalParameter.MOTION || parameter === PhysicalParameter.PRESENCE) {
      return 'motion';
    }

    return null;
  }

  /**
   * Schedule effect removal after timeout
   */
  private scheduleEffectRemoval(
    deviceId: string,
    parameter: PhysicalParameter,
    delayMs: number
  ): void {
    const timeoutId = setTimeout(() => {
      logger.info(`Removing expired effect for ${deviceId}: ${parameter}`);
      this.physicsLayer?.unregisterDeviceEffect(deviceId, parameter);
      this.removeActiveEffect(deviceId, parameter);
    }, delayMs);

    // Track timeout for cleanup
    const effects = this.activeEffects.get(deviceId) || [];
    const effect = effects.find(e => e.parameter === parameter);
    if (effect) {
      effect.timeoutId = timeoutId;
    }
  }

  /**
   * Track active effect
   */
  private trackActiveEffect(deviceId: string, effect: ActiveEffect): void {
    if (!this.activeEffects.has(deviceId)) {
      this.activeEffects.set(deviceId, []);
    }
    this.activeEffects.get(deviceId)!.push(effect);
  }

  /**
   * Remove active effect tracking
   */
  private removeActiveEffect(deviceId: string, parameter: PhysicalParameter): void {
    const effects = this.activeEffects.get(deviceId);
    if (!effects) {
      return;
    }

    const index = effects.findIndex(e => e.parameter === parameter);
    if (index !== -1) {
      effects.splice(index, 1);
    }

    if (effects.length === 0) {
      this.activeEffects.delete(deviceId);
    }
  }

  /**
   * Clean up all active effects
   */
  private cleanupAllEffects(): void {
    logger.info('Cleaning up all active effects');

    for (const [deviceId, effects] of this.activeEffects.entries()) {
      for (const effect of effects) {
        // Clear timeout
        if (effect.timeoutId) {
          clearTimeout(effect.timeoutId);
        }

        // Unregister from physics layer
        this.physicsLayer?.unregisterDeviceEffect(deviceId, effect.parameter);
      }
    }

    this.activeEffects.clear();
  }

  /**
   * Get device by ID
   */
  private getDeviceById(deviceId: string): any {
    if (this.deviceGetter) {
      return this.deviceGetter(deviceId);
    }
    logger.warn(`No device getter available for ${deviceId}`);
    return null;
  }

  /**
   * Get device location
   */
  private getDeviceLocation(device: any): DeviceLocation | string {
    return device.location || 'simulated';
  }

  /**
   * Normalize location to DeviceLocation object
   */
  private normalizeLocation(location: DeviceLocation | string): DeviceLocation {
    if (typeof location === 'string') {
      return { path: location };
    }
    return location;
  }

  /**
   * Evaluate effect condition
   */
  private evaluateCondition(
    condition: any,
    params: any
  ): boolean {
    const { parameter, operator, value } = condition;
    const paramValue = params?.[parameter];

    logger.info(`Evaluating condition:`, {
      parameter,
      operator,
      value,
      paramValue,
      params,
      result: paramValue === value
    });

    switch (operator) {
      case 'eq':
        return paramValue === value;
      case 'ne':
        return paramValue !== value;
      case 'gt':
        return paramValue > value;
      case 'lt':
        return paramValue < value;
      default:
        logger.warn(`Unknown operator: ${operator}`);
        return false;
    }
  }

  /**
   * Enable/disable effect manager
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    logger.info(`${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      enabled: this.enabled,
      activeEffectCount: Array.from(this.activeEffects.values())
        .reduce((sum, effects) => sum + effects.length, 0),
      devicesWithEffects: this.activeEffects.size,
    };
  }
}
