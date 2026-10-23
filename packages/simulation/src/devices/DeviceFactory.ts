/**
 * Device Factory
 *
 * Factory for creating simulated devices with predefined configurations
 */

import { v4 as uuidv4 } from 'uuid';
import { SimulatedDevice } from '../devices/SimulatedDevice';
import type { SimulatedDeviceConfig, BehaviorConfig } from '../devices/types';
import { BehaviorType } from '../devices/types';
import type { DeviceCapability, CapabilityType, ParameterType } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Standard getStatus capability for all devices
 */
const getStatusCapability: DeviceCapability = {
  name: 'getStatus',
  type: 'read' as CapabilityType,
  parameters: [],
};

/**
 * Device factory for creating simulated devices
 */
const logger = createLogger('DeviceFactory');

export class DeviceFactory {
  /**
   * Create a simulated device from configuration
   * @param config - Device configuration
   * @returns Simulated device instance
   */
  static createDevice(config: SimulatedDeviceConfig): SimulatedDevice {
    const deviceId = config.id || uuidv4();

    // Ensure all devices have getStatus capability
    const capabilities = [...(config.capabilities || [])];
    if (!capabilities.find(c => c.name === 'getStatus')) {
      capabilities.push(getStatusCapability);
    }

    const deviceConfig: SimulatedDeviceConfig = {
      ...config,
      id: deviceId,
      capabilities,
    };

    logger.info(`Creating device: ${deviceConfig.name} (${deviceConfig.type})`);

    return new SimulatedDevice(deviceConfig);
  }

  /**
   * Create a simple sensor device
   * @param name - Device name
   * @param sensorType - Type of sensor (temperature, humidity, etc.)
   * @param options - Additional options
   * @returns Simulated sensor device
   */
  static createSensor(
    name: string,
    sensorType: string,
    options: {
      location?: string;
      updateInterval?: number;
      initialValue?: any;
    } = {}
  ): SimulatedDevice {
    const {
      location = 'simulated',
      updateInterval = 5000,
      initialValue = 0,
    } = options;

    const capabilities: DeviceCapability[] = [
      {
        name: 'read',
        type: 'read' as CapabilityType,
        parameters: [],
      },
      {
        name: `read-${sensorType}`,
        type: 'read' as CapabilityType,
        parameters: [],
      },
      getStatusCapability, // Add standard getStatus
    ];

    logger.info(`createSensor: Creating sensor with capabilities:`, capabilities.map(c => c.name));

    const behaviors: BehaviorConfig[] = [
      {
        type: BehaviorType.PERIODIC,
        interval: updateInterval,
      },
    ];

    return this.createDevice({
      name,
      type: 'sensor',
      initialState: {
        [sensorType]: initialValue,
        unit: this.getUnitForSensor(sensorType),
      },
      capabilities,
      behaviors,
      location,
      metadata: {
        sensorType,
        simulated: true,
      },
    });
  }

  /**
   * Create a simple actuator device (switch, light, etc.)
   * @param name - Device name
   * @param actuatorType - Type of actuator
   * @param options - Additional options
   * @returns Simulated actuator device
   */
  static createActuator(
    name: string,
    actuatorType: string,
    options: {
      location?: string;
      initialState?: boolean;
    } = {}
  ): SimulatedDevice {
    const {
      location = 'simulated',
      initialState = false,
    } = options;

    const capabilities: DeviceCapability[] = [
      {
        name: `get-${actuatorType}-state`,
        type: 'read' as CapabilityType,
        parameters: [],
      },
      {
        name: `set-${actuatorType}`,
        type: 'write' as CapabilityType,
        parameters: [
          {
            name: 'value',
            type: 'boolean' as ParameterType,
            required: true,
            description: `Turn ${actuatorType} on or off`,
          },
        ],
      },
      getStatusCapability, // Add standard getStatus
    ];

    return this.createDevice({
      name,
      type: 'actuator',
      initialState: {
        [actuatorType]: initialState,
      },
      capabilities,
      behaviors: [],
      location,
      metadata: {
        actuatorType,
        simulated: true,
      },
    });
  }

  /**
   * Create a thermostat device
   * @param name - Device name
   * @param options - Additional options
   * @returns Simulated thermostat
   */
  static createThermostat(
    name: string,
    options: {
      location?: string;
      initialTemp?: number;
      initialTarget?: number;
    } = {}
  ): SimulatedDevice {
    const {
      location = 'simulated',
      initialTemp = 22,
      initialTarget = 22,
    } = options;

    const capabilities: DeviceCapability[] = [
      {
        name: 'read-temperature',
        type: 'read' as CapabilityType,
        parameters: [],
      },
      {
        name: 'set-target-temperature',
        type: 'write' as CapabilityType,
        parameters: [
          {
            name: 'target',
            type: 'number' as ParameterType,
            required: true,
            description: 'Target temperature',
          },
        ],
      },
      {
        name: 'get-mode',
        type: 'read' as CapabilityType,
        parameters: [],
      },
      {
        name: 'set-mode',
        type: 'write' as CapabilityType,
        parameters: [
          {
            name: 'mode',
            type: 'string' as ParameterType,
            required: true,
            description: 'Mode: heating, cooling, or off',
          },
        ],
      },
      getStatusCapability, // Add standard getStatus
    ];

    return this.createDevice({
      name,
      type: 'thermostat',
      initialState: {
        temperature: initialTemp,
        targetTemperature: initialTarget,
        mode: 'off',
        unit: '°C',
      },
      capabilities,
      behaviors: [
        {
          type: BehaviorType.PERIODIC,
          interval: 10000, // Update every 10 seconds
        },
      ],
      location,
      metadata: {
        deviceType: 'thermostat',
        simulated: true,
      },
    });
  }

  /**
   * Create a light device
   * @param name - Device name
   * @param options - Additional options
   * @returns Simulated light
   */
  static createLight(
    name: string,
    options: {
      location?: string;
      initialState?: boolean;
      brightness?: number;
    } = {}
  ): SimulatedDevice {
    const {
      location = 'simulated',
      initialState = false,
      brightness = 100,
    } = options;

    const capabilities: DeviceCapability[] = [
      {
        name: 'get-state',
        type: 'read' as CapabilityType,
        parameters: [],
      },
      {
        name: 'set-state',
        type: 'write' as CapabilityType,
        parameters: [
          {
            name: 'on',
            type: 'boolean' as ParameterType,
            required: true,
          },
        ],
      },
      {
        name: 'set-brightness',
        type: 'write' as CapabilityType,
        parameters: [
          {
            name: 'brightness',
            type: 'number' as ParameterType,
            required: true,
            description: 'Brightness level (0-100)',
          },
        ],
      },
    ];

    return this.createDevice({
      name,
      type: 'light',
      initialState: {
        on: initialState,
        brightness,
      },
      capabilities,
      behaviors: [],
      location,
      metadata: {
        deviceType: 'light',
        simulated: true,
      },
    });
  }

  /**
   * Get unit for sensor type
   * @param sensorType - Type of sensor
   * @returns Unit string
   */
  private static getUnitForSensor(sensorType: string): string {
    const units: Record<string, string> = {
      temperature: '°C',
      humidity: '%',
      pressure: 'hPa',
      light: 'lux',
      motion: 'detected',
      co2: 'ppm',
    };

    return units[sensorType] || '';
  }
}
