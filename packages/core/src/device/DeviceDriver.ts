/**
 * Device Driver Abstraction
 *
 * Provides a factory pattern for creating devices.
 * Supports both simulated and real device drivers.
 *
 * Usage:
 * ```typescript
 * // Create simulated device
 * const simDriver = new SimulatedDeviceDriver(physicalEnvironment);
 * const tempSensor = simDriver.createDevice({
 *   name: 'Living Room Temperature',
 *   type: 'temperature-sensor',
 *   capabilities: [{ name: 'read-temperature', type: 'read' }]
 * });
 *
 * // Switch to real device (same config, different driver)
 * const realDriver = new RealDeviceDriver(mqttClient);
 * const realSensor = realDriver.createDevice({ ... });
 * ```
 */

import type { IDevice, DeviceConfig, DeviceTypeInfo } from './IDevice.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device driver types
 */
const logger = createLogger('DeviceDriver');

export enum DriverType {
  SIMULATED = 'simulated',
  REAL = 'real',
}

/**
 * Driver status
 */
export interface DriverStatus {
  type: DriverType;
  connected: boolean;
  deviceCount: number;
  lastActivity: Date;
  errors: string[];
}

/**
 * Base interface for device drivers
 */
export interface IDeviceDriver {
  /**
   * Driver type (simulated or real)
   */
  readonly type: DriverType;

  /**
   * Create a device from configuration
   * @param config - Device configuration
   * @returns Created device instance
   */
  createDevice(config: DeviceConfig): Promise<IDevice>;

  /**
   * Get a device by ID
   * @param deviceId - Device identifier
   * @returns Device instance or undefined
   */
  getDevice(deviceId: string): IDevice | undefined;

  /**
   * Get all devices managed by this driver
   */
  getAllDevices(): IDevice[];

  /**
   * Remove a device
   * @param deviceId - Device identifier
   */
  removeDevice(deviceId: string): void;

  /**
   * Connect the driver (for real devices, this establishes connection)
   */
  connect(): Promise<void>;

  /**
   * Disconnect the driver
   */
  disconnect(): Promise<void>;

  /**
   * Get driver status
   */
  getStatus(): DriverStatus;

  /**
   * Get supported device types for this driver
   */
  getSupportedTypes(): DeviceTypeInfo[];
}

/**
 * Abstract base class for device drivers
 * Implements common functionality, subclasses provide specific implementations
 */
export abstract class BaseDeviceDriver implements IDeviceDriver {
  protected devices: Map<string, IDevice> = new Map();
  protected _connected: boolean = false;
  protected errors: string[] = [];
  protected lastActivity: Date = new Date();

  readonly type: DriverType;

  constructor(type: DriverType) {
    this.type = type;
  }

  /**
   * Create a device from configuration
   * Template method - subclasses must implement
   */
  abstract createDevice(config: DeviceConfig): Promise<IDevice>;

  /**
   * Get a device by ID
   */
  getDevice(deviceId: string): IDevice | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Get all devices
   */
  getAllDevices(): IDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Remove a device
   */
  removeDevice(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) {
      this.devices.delete(deviceId);
      logger.info(`[${this.type}Driver] Removed device: ${deviceId}`);
    }
  }

  /**
   * Connect the driver
   */
  async connect(): Promise<void> {
    this._connected = true;
    this.lastActivity = new Date();
    logger.info(`[${this.type}Driver] Connected`);
  }

  /**
   * Disconnect the driver
   */
  async disconnect(): Promise<void> {
    this._connected = false;
    this.devices.clear();
    logger.info(`[${this.type}Driver] Disconnected`);
  }

  /**
   * Get driver status
   */
  getStatus(): DriverStatus {
    return {
      type: this.type,
      connected: this._connected,
      deviceCount: this.devices.size,
      lastActivity: this.lastActivity,
      errors: [...this.errors],
    };
  }

  /**
   * Register a device internally
   */
  protected registerDevice(device: IDevice): void {
    this.devices.set(device.id, device);
    this.lastActivity = new Date();
    logger.info(`[${this.type}Driver] Registered device: ${device.id} (${device.name})`);
  }

  /**
   * Record an error
   */
  protected recordError(error: string): void {
    this.errors.push(error);
    // Keep only last 100 errors
    if (this.errors.length > 100) {
      this.errors.shift();
    }
  }

  /**
   * Get supported device types (default implementation)
   */
  getSupportedTypes(): DeviceTypeInfo[] {
    return [];
  }
}
