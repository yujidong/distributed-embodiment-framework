/**
 * Simulated Environment
 *
 * Manages a collection of simulated devices
 */

import type { SimulatedDevice } from '../devices/SimulatedDevice.js';
import { SimulatedDevice as SimulatedDeviceClass } from '../devices/SimulatedDevice.js';
import { TimeManager } from './TimeManager.js';
import { PhysicalEnvironment } from './PhysicalEnvironment.js';
import type { SimulatedEnvironmentConfig } from '../devices/types.js';
import type { EventManager } from '@active-collaboration/core';

import { createLogger } from '@active-collaboration/shared';
/**
 * Simulated environment for device testing
 */
const logger = createLogger('SimulatedEnvironment');

export class SimulatedEnvironment {
  public readonly name: string;
  private devices: Map<string, SimulatedDevice>;
  private timeManager: TimeManager;
  private physicalEnvironment?: PhysicalEnvironment;
  private eventManager?: EventManager; // EventManager from @active-collaboration/core

  constructor(config: SimulatedEnvironmentConfig) {
    this.name = config.name;
    this.devices = new Map();
    this.timeManager = new TimeManager({ timeScale: config.timeScale });

    logger.info(`[SimulatedEnvironment:${this.name}] Initialized`);

    // Create physical environment if enabled (default: true)
    if (config.enablePhysicalModel !== false) {
      this.physicalEnvironment = new PhysicalEnvironment(this.timeManager, config.physicalConfig);
      logger.info(`[SimulatedEnvironment:${this.name}] PhysicalEnvironment created`);
    }
  }

  /**
   * Add a device to the environment
   * @param device - Device to add
   */
  addDevice(device: SimulatedDevice): void {
    logger.info(`[SimulatedEnvironment:${this.name}] Adding device: ${device.name}`);
    this.devices.set(device.id, device);

    // Attach physical environment if available
    if (this.physicalEnvironment) {
      if (device instanceof SimulatedDeviceClass) {
        device.setPhysicalEnvironment(this.physicalEnvironment);
        logger.info(`[SimulatedEnvironment:${this.name}] PhysicalEnvironment attached to device: ${device.name}`);
      }
    }

    // Attach event manager if available
    if (this.eventManager) {
      if (device instanceof SimulatedDeviceClass) {
        device.setEventManager(this.eventManager);
        logger.info(`[SimulatedEnvironment:${this.name}] EventManager attached to device: ${device.name}`);
      }
    }
  }

  /**
   * Remove a device from the environment
   * @param deviceId - Device ID to remove
   */
  removeDevice(deviceId: string): void {
    logger.info(`[SimulatedEnvironment:${this.name}] Removing device: ${deviceId}`);

    const device = this.devices.get(deviceId);
    if (device) {
      device.dispose();
      this.devices.delete(deviceId);
    }
  }

  /**
   * Get a device by ID
   * @param deviceId - Device ID
   * @returns Device or undefined
   */
  getDevice(deviceId: string): SimulatedDevice | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Get all devices
   * @returns Array of all devices
   */
  getAllDevices(): SimulatedDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Start time simulation
   */
  startTimeSimulation(): void {
    logger.info(`[SimulatedEnvironment:${this.name}] Starting time simulation`);
    this.timeManager.start();
  }

  /**
   * Stop time simulation
   */
  stopTimeSimulation(): void {
    logger.info(`[SimulatedEnvironment:${this.name}] Stopping time simulation`);
    this.timeManager.stop();
  }

  /**
   * Get time manager
   * @returns Time manager instance
   */
  getTimeManager(): TimeManager {
    return this.timeManager;
  }

  /**
   * Get physical environment
   * @returns Physical environment instance or undefined
   */
  getPhysicalEnvironment(): PhysicalEnvironment | undefined {
    return this.physicalEnvironment;
  }

  /**
   * Set event manager for devices to emit events
   * @param eventManager - Event manager instance
   */
  setEventManager(eventManager: EventManager): void {
    this.eventManager = eventManager;
    logger.info(`[SimulatedEnvironment:${this.name}] EventManager attached`);

    // Attach event manager to all existing devices
    for (const device of this.devices.values()) {
      if (device instanceof SimulatedDeviceClass) {
        device.setEventManager(eventManager);
      }
    }
  }

  /**
   * Get environment statistics
   * @returns Statistics object
   */
  getStats(): {
    name: string;
    deviceCount: number;
    currentTime: Date;
    timeScale: number;
  } {
    return {
      name: this.name,
      deviceCount: this.devices.size,
      currentTime: this.timeManager.getCurrentTime(),
      timeScale: this.timeManager.getTimeScale(),
    };
  }

  /**
   * Dispose all devices and stop time simulation
   */
  dispose(): void {
    logger.info(`[SimulatedEnvironment:${this.name}] Disposing environment`);

    for (const device of this.devices.values()) {
      device.dispose();
    }

    this.devices.clear();
    this.timeManager.dispose();
  }
}
