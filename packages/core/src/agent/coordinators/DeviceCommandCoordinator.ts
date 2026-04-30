/**
 * Device Command Coordinator
 *
 * Handles device command execution at the Device Layer
 *
 * Key Responsibilities:
 * - Execute commands on devices
 * - Manage device state
 * - Emit device operation events
 * - Handle command timeouts
 *
 * Architecture principle:
 * - Device Layer: Executes commands (NOT services!)
 * - Commands are basic operations: turnOn, turnOff, setTemperature, etc.
 * - Services are higher-level abstractions that may or may not use devices
 */

import type { ResourceManager } from '../../resource/ResourceManager.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '@active-collaboration/shared';
import type { Device } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device Command Result
 */
const logger = createLogger('DeviceCommandCoordinator');

export interface DeviceCommandResult {
  success: boolean;
  result?: any;
  error?: string;
  executionTime?: number;
}

/**
 * Device Command Coordinator
 *
 * Handles device command execution at the Device Layer
 */
export class DeviceCommandCoordinator {
  constructor(
    private readonly resourceManager: ResourceManager,
    private readonly eventEmitter: EventEmitter,
    private readonly agentId: string
  ) {}

  /**
   * Execute a command on a device
   *
   * @param deviceId - The device ID
   * @param commandName - The command name (e.g., 'turnOn', 'setTemperature')
   * @param params - Optional command parameters
   * @param timeout - Optional timeout in milliseconds (default: 5000ms)
   * @returns Command execution result
   */
  async executeCommand(
    deviceId: string,
    commandName: string,
    params?: any,
    timeout: number = 5000
  ): Promise<DeviceCommandResult> {
    const startTime = Date.now();

    logger.info(`[DeviceCommandCoordinator:${this.agentId}] Executing command ${commandName} on device ${deviceId}`);

    try {
      // 1. Get device from ResourceManager
      const allDevices = this.resourceManager.getAllDevices();
      const device = allDevices.find(d => d.id === deviceId);

      if (!device) {
        return {
          success: false,
          error: `Device ${deviceId} not found`,
        };
      }

      // 2. Execute command on device with timeout
      const result = await Promise.race([
        this.executeCommandOnDevice(device, commandName, params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Command execution timed out after ${timeout}ms`)), timeout)
        )
      ]) as Promise<never>;

      const executionTime = Date.now() - startTime;

      // 3. Emit DEVICE_OPERATION_EXECUTED event
      this.eventEmitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
        agentId: this.agentId,
        deviceId,
        commandName,
        result,
        executionTime,
      });

      return {
        success: true,
        result,
        executionTime,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      logger.error(`[DeviceCommandCoordinator:${this.agentId}] Command execution failed:`, error);

      // Emit error event
      this.eventEmitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
        agentId: this.agentId,
        deviceId,
        commandName,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
        success: false,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime,
      };
    }
  }

  /**
   * Execute command on device (internal helper)
   *
   * @param device - The device
   * @param commandName - The command name
   * @param params - Optional command parameters
   * @returns Command execution result
   */
  private async executeCommandOnDevice(
    device: Device,
    commandName: string,
    params?: any
  ): Promise<any> {
    // Check if device is actually a SimulatedDevice with executeCommand method
    const deviceWithCommand = device as unknown as { executeCommand?: (commandName: string, params?: unknown) => Promise<unknown> };

    if (deviceWithCommand.executeCommand && typeof deviceWithCommand.executeCommand === 'function') {
      return await deviceWithCommand.executeCommand(commandName, params);
    }

    throw new Error(`Device ${device.id} does not support command execution`);
  }

  /**
   * Get all available devices
   *
   * @returns Array of devices
   */
  getAllDevices(): Device[] {
    return this.resourceManager.getAllDevices();
  }

  /**
   * Get device by ID
   *
   * @param deviceId - Device ID
   * @returns Device if found, undefined otherwise
   */
  getDevice(deviceId: string): Device | undefined {
    const allDevices = this.resourceManager.getAllDevices();
    return allDevices.find(d => d.id === deviceId);
  }
}
