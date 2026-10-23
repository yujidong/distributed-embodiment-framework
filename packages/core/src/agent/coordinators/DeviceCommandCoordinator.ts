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
   * @param params - Optional command parameters (PURE semantic arguments)
   * @param options - Execution options: timeout (ms, default 5000) and the
   *   invocation-context actor (R17 params-purity fix: attribution rides the
   *   context, never params — the device stamps it on audit state and on the
   *   DEVICE_OPERATION_EXECUTED event)
   * @returns Command execution result
   */
  async executeCommand(
    deviceId: string,
    commandName: string,
    params?: any,
    options: { timeout?: number; actor?: string } = {},
  ): Promise<DeviceCommandResult> {
    const { timeout = 5000, actor } = options;
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
        this.executeCommandOnDevice(device, commandName, params, actor),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Command execution timed out after ${timeout}ms`)), timeout)
        )
      ]) as Promise<never>;

      const executionTime = Date.now() - startTime;

      // T70 (R8, u1-F2): the DEVICE-level verdict IS the verdict. A
      // SimulatedDevice reports an unknown command / missing params /
      // no-op handler as a result object ({success:false, error}) — it does
      // not throw. The old code treated "did not throw" as success, so a
      // device-level failure was masked behind top-level success:true, an
      // executed count and an `executed` audit row: the execution face, the
      // verification face and the capability face told three different
      // stories about the same command. Never again a fake success.
      const deviceResult = result as { success?: unknown; error?: unknown } | null | undefined;
      if (deviceResult !== null && typeof deviceResult === 'object' && deviceResult.success === false) {
        const message =
          typeof deviceResult.error === 'string' && deviceResult.error.length > 0
            ? deviceResult.error
            : 'device reported command failure (no error message)';
        logger.warn(
          `[DeviceCommandCoordinator:${this.agentId}] Command ${commandName} on ${deviceId} FAILED at the device: ${message}`,
        );
        // Echo WITH the result object: the audit dedupe filters on
        // `result.success === false`, so a failed command can never land an
        // `executed` row (the device's own failure emission is filtered by
        // the same predicate — see sim-registry seams Fix-44h/T45).
        this.eventEmitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
          agentId: this.agentId,
          deviceId,
          commandName,
          params,
          result,
          executionTime,
          success: false,
          ...(actor !== undefined ? { actor } : {}),
        });
        return {
          success: false,
          result,
          error: message,
          executionTime,
        };
      }

      // 3. Emit DEVICE_OPERATION_EXECUTED event
      // `params` included (Fix-12) so runtime-level effect verification can
      // derive the intended direction of temperature-class commands
      // (setTemperature target) instead of only seeing that a command ran.
      // `actor` (R17 params-purity) rides alongside: who invoked, WITHOUT
      // polluting params — timeline/replay consumers read it as context.
      this.eventEmitter.emit(EventType.DEVICE_OPERATION_EXECUTED, {
        agentId: this.agentId,
        deviceId,
        commandName,
        params,
        result,
        executionTime,
        ...(actor !== undefined ? { actor } : {}),
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
        ...(actor !== undefined ? { actor } : {}),
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
   * @param actor - Optional invocation-context actor (audit attribution)
   * @returns Device execution result
   */
  private async executeCommandOnDevice(
    device: Device,
    commandName: string,
    params?: any,
    actor?: string
  ): Promise<any> {
    // Check if device is actually a SimulatedDevice with executeCommand method
    // (structural cast — core does not depend on the simulation package; the
    // third argument is the R17 invocation context `{actor}`.)
    const deviceWithCommand = device as unknown as {
      executeCommand?: (
        commandName: string,
        params?: unknown,
        context?: { actor?: string }
      ) => Promise<unknown>;
    };

    if (deviceWithCommand.executeCommand && typeof deviceWithCommand.executeCommand === 'function') {
      return await deviceWithCommand.executeCommand(commandName, params, actor !== undefined ? { actor } : undefined);
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
