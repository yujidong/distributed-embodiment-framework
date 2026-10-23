/**
 * Device Module
 *
 * Provides a unified device abstraction layer for both simulated and real devices.
 * This allows Agent code to be independent of device implementation.
 *
 * Usage:
 * ```typescript
 * import { IDevice, DeviceDriverFactory, SimulatedDeviceDriver } from '@active-collaboration/core/device';
 *
 * // Create a simulated device
 * const simDriver = new SimulatedDeviceDriver(physicalEnvironment);
 * const device = await simDriver.createDevice({
 *   name: 'Temperature Sensor',
 *   type: 'temperature-sensor',
 *   capabilities: [{ name: 'read-temperature', type: 'read' }]
 * });
 *
 * // Or use factory for easy switching
 * const factory = new DeviceDriverFactory();
 * factory.registerDriver('simulated', () => new SimulatedDeviceDriver(env));
 * factory.registerDriver('mqtt', () => new MQTTDeviceDriver(mqttConfig));
 *
 * const driver = factory.getDriver('mqtt');
 * const realDevice = await driver.createDevice({ ... });
 * ```
 */

// Core interfaces
const logger = createLogger('index');

export type { IDevice, DeviceConfig, DeviceExecutionResult, DeviceTypeInfo, SemanticCapability } from './IDevice.js';
export type { DriverStatus } from './DeviceDriver.js';
export { BaseDeviceDriver, DriverType } from './DeviceDriver.js';

// Simulated driver - moved to src/testing/device/SimulatedDeviceDriver.ts
// This is no longer exported from here to avoid simulation dependency in production build
// export { SimulatedDeviceDriver } from './SimulatedDeviceDriver.js';

// Real device drivers
export { RealDeviceDriver } from './RealDeviceDriver.js';
export type { RealDeviceConnection, RealDeviceStatus } from './RealDeviceDriver.js';

export { MQTTDeviceDriver } from './MQTTDeviceDriver.js';
export type { MQTTConnectionOptions, MQTTDeviceConfig } from './MQTTDeviceDriver.js';

export { HTTPDeviceDriver } from './HTTPDeviceDriver.js';
export type { HTTPConnectionOptions, HTTPDeviceConfig, HTTPDeviceEndpoints } from './HTTPDeviceDriver.js';

export { WebSocketDeviceDriver } from './WebSocketDeviceDriver.js';
export type { WebSocketConnectionOptions, WebSocketDeviceConfig } from './WebSocketDeviceDriver.js';

// Re-export commonly used types from shared
export { DeviceStatus, DeviceType } from '@active-collaboration/shared';
export type { DeviceCapability, DeviceLocation, DeviceState, ConnectionInfo } from '@active-collaboration/shared';

// Import types for factory
import type { IDevice, DeviceConfig } from './IDevice.js';
import { BaseDeviceDriver } from './DeviceDriver.js';
// SimulatedDeviceDriver moved to src/testing/device/SimulatedDeviceDriver.ts
// import { SimulatedDeviceDriver } from '../testing/device/SimulatedDeviceDriver.js';
import { MQTTDeviceDriver, type MQTTConnectionOptions } from './MQTTDeviceDriver.js';
import { HTTPDeviceDriver, type HTTPConnectionOptions } from './HTTPDeviceDriver.js';
import { WebSocketDeviceDriver, type WebSocketConnectionOptions } from './WebSocketDeviceDriver.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device Driver Factory
 *
 * Provides a centralized way to create and manage device drivers.
 * Supports runtime switching between simulation and real device drivers.
 */

export type DriverTypeKey = 'simulated' | 'mqtt' | 'http' | 'websocket';
export type DriverFactory = () => BaseDeviceDriver;

export class DeviceDriverFactory {
  private _drivers: Map<DriverTypeKey, DriverFactory> = new Map();
  private _instances: Map<DriverTypeKey, BaseDeviceDriver> = new Map();
  private _activeDriver: DriverTypeKey = 'simulated';

  /**
   * Register a driver factory
   */
  registerDriver(type: DriverTypeKey, factory: DriverFactory): void {
    this._drivers.set(type, factory);
    logger.info(`[DeviceDriverFactory] Registered driver: ${type}`);
  }

  /**
   * Get or create a driver instance
   */
  getDriver(type: DriverTypeKey): BaseDeviceDriver {
    // Return cached instance if available
    if (this._instances.has(type)) {
      return this._instances.get(type)!;
    }

    // Create new instance
    const factory = this._drivers.get(type);
    if (!factory) {
      throw new Error(`Driver not registered: ${type}`);
    }

    const driver = factory();
    this._instances.set(type, driver);
    logger.info(`[DeviceDriverFactory] Created driver instance: ${type}`);

    return driver;
  }

  /**
   * Set the active driver type
   */
  setActiveDriver(type: DriverTypeKey): void {
    if (!this._drivers.has(type)) {
      throw new Error(`Driver not registered: ${type}`);
    }
    this._activeDriver = type;
    logger.info(`[DeviceDriverFactory] Active driver set to: ${type}`);
  }

  /**
   * Get the active driver
   */
  getActiveDriver(): BaseDeviceDriver {
    return this.getDriver(this._activeDriver);
  }

  /**
   * Get the active driver type
   */
  getActiveDriverType(): DriverTypeKey {
    return this._activeDriver;
  }

  /**
   * List registered driver types
   */
  listDrivers(): DriverTypeKey[] {
    return Array.from(this._drivers.keys());
  }

  /**
   * Check if a driver is registered
   */
  hasDriver(type: DriverTypeKey): boolean {
    return this._drivers.has(type);
  }

  /**
   * Create a device using the active driver
   */
  async createDevice(config: DeviceConfig): Promise<IDevice> {
    const driver = this.getActiveDriver();
    return driver.createDevice(config);
  }

  /**
   * Switch between simulation and real device
   * This is the key feature: same Agent code works with both!
   */
  async switchToDeviceType(type: DriverTypeKey): Promise<void> {
    logger.info(`[DeviceDriverFactory] Switching from ${this._activeDriver} to ${type}`);

    // Disconnect old driver if needed
    const oldDriver = this._instances.get(this._activeDriver);
    if (oldDriver && oldDriver.getStatus().connected) {
      await oldDriver.disconnect();
    }

    // Connect new driver
    this.setActiveDriver(type);
    const newDriver = this.getActiveDriver();

    if (!newDriver.getStatus().connected) {
      await newDriver.connect();
    }

    logger.info(`[DeviceDriverFactory] Successfully switched to ${type}`);
  }
}

/**
 * Quick setup helper for common configurations
 */
export function createDeviceDrivers(config: {
  mqtt?: MQTTConnectionOptions;
  http?: HTTPConnectionOptions;
  websocket?: WebSocketConnectionOptions;
}): DeviceDriverFactory {
  const factory = new DeviceDriverFactory();

  // Register MQTT driver
  if (config.mqtt) {
    factory.registerDriver('mqtt', () => new MQTTDeviceDriver(config.mqtt!));
  }

  // Register HTTP driver
  if (config.http) {
    factory.registerDriver('http', () => new HTTPDeviceDriver(config.http!));
  }

  // Register WebSocket driver
  if (config.websocket) {
    factory.registerDriver('websocket', () => new WebSocketDeviceDriver(config.websocket!));
  }

  return factory;
}
