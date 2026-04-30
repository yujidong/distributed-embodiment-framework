/**
 * CommandBridge
 *
 * Bridges Service execution to Device command execution.
 *
 * Architecture flow:
 *   Service.execute() → CommandBridge → Resource.execute() → Device.executeCommand()
 *
 * When a Service is derived from a Device Resource (e.g., auto-generated services),
 * the CommandBridge routes the service execution to the underlying DeviceResource,
 * which maps the service parameters to device commands and executes them.
 *
 * This is the ONLY way Services should affect Device state.
 */

import { createLogger } from '@active-collaboration/shared';
import type { ResourceManager } from '../resource/ResourceManager.js';
import type { Resource } from '../resource/Resource.js';
import type { ServiceExecutionContext, ServiceExecutionResult } from '../service/Service.js';

const logger = createLogger('CommandBridge');

/**
 * Command bridge configuration
 */
export interface CommandBridgeConfig {
  /** The agent ID that owns this bridge */
  agentId: string;
  /** Resource manager to look up resources */
  resourceManager: ResourceManager;
}

/**
 * Result of a bridged command execution
 */
export interface BridgedCommandResult {
  success: boolean;
  deviceId?: string;
  command?: string;
  result?: unknown;
  error?: string;
}

/**
 * CommandBridge routes Service executions to Device commands
 * through the Resource layer, maintaining the Device/Resource/Service separation.
 *
 * Usage:
 *   const bridge = new CommandBridge({ agentId: 'agent-1', resourceManager });
 *   const result = await bridge.executeServiceAsDeviceCommand('temperature-control', {
 *     serviceId: 'svc-1',
 *     requester: 'agent-2',
 *     timestamp: new Date(),
 *     params: { targetTemperature: 22 },
 *   });
 */
export class CommandBridge {
  private agentId: string;
  private resourceManager: ResourceManager;

  constructor(config: CommandBridgeConfig) {
    this.agentId = config.agentId;
    this.resourceManager = config.resourceManager;
    logger.info(`[CommandBridge] Initialized for agent ${this.agentId}`);
  }

  /**
   * Execute a service request as a device command via the Resource layer.
   *
   * This is the core bridge method. It:
   * 1. Looks up resources that can fulfill the requested capability
   * 2. Selects the best matching resource (location-aware if applicable)
   * 3. Executes the command through the Resource layer
   * 4. Returns the result
   *
   * @param capabilityName - The service/capability to execute (e.g., 'temperature-control')
   * @param context - The service execution context
   * @returns Bridged command result
   */
  async executeServiceAsDeviceCommand(
    capabilityName: string,
    context: ServiceExecutionContext
  ): Promise<BridgedCommandResult> {
    // Input validation
    if (!capabilityName || capabilityName.trim().length === 0) {
      return {
        success: false,
        error: 'Invalid capability name: must be non-empty string',
      };
    }
    if (!context || !context.serviceId) {
      return {
        success: false,
        error: 'Invalid execution context: missing serviceId',
      };
    }

    logger.info(
      `[CommandBridge:${this.agentId}] Bridging service execution: ${capabilityName}`
    );

    // Step 1: Find resources that can fulfill this capability
    const resources = this.resourceManager.getResourcesByCapability(capabilityName);

    if (resources.length === 0) {
      logger.warn(
        `[CommandBridge:${this.agentId}] No resources found for capability: ${capabilityName}`
      );
      return {
        success: false,
        error: `No resources available for capability: ${capabilityName}`,
      };
    }

    // Step 2: Select the best resource (prefer DeviceResource, prefer matching location)
    const resource = this.selectBestResource(resources, context.params);

    if (!resource) {
      return {
        success: false,
        error: `No suitable resource found for: ${capabilityName}`,
      };
    }

    logger.info(
      `[CommandBridge:${this.agentId}] Selected resource: ${resource.id} (${resource.type})`
    );

    // Step 3: Execute through Resource layer
    try {
      const result = await resource.execute(capabilityName, context.params);

      logger.info(
        `[CommandBridge:${this.agentId}] Resource execution ${result.success ? 'succeeded' : 'failed'}: ${resource.id}`
      );

      return {
        success: result.success,
        deviceId: resource.type === 'device' ? resource.id : undefined,
        command: capabilityName,
        result: result.result,
        error: result.error,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[CommandBridge:${this.agentId}] Resource execution error: ${errorMsg}`
      );
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Execute a specific device command by device ID.
   *
   * Use this when you know exactly which device to target (e.g., from a task plan).
   *
   * @param deviceId - The target device ID
   * @param commandName - The device command to execute
   * @param params - Command parameters
   * @returns Bridged command result
   */
  async executeDeviceCommand(
    deviceId: string,
    commandName: string,
    params: Record<string, unknown> = {}
  ): Promise<BridgedCommandResult> {
    if (!deviceId || !commandName) {
      return {
        success: false,
        error: 'Invalid parameters: deviceId and commandName are required',
      };
    }

    logger.info(
      `[CommandBridge:${this.agentId}] Direct device command: ${deviceId} → ${commandName}`
    );

    const resource = this.resourceManager.getResource(deviceId);

    if (!resource) {
      return {
        success: false,
        error: `Resource not found: ${deviceId}`,
      };
    }

    try {
      const result = await resource.execute(commandName, params);

      return {
        success: result.success,
        deviceId,
        command: commandName,
        result: result.result,
        error: result.error,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        deviceId,
        error: errorMsg,
      };
    }
  }

  /**
   * Convert a BridgedCommandResult to a ServiceExecutionResult
   * for compatibility with the Service execution pipeline.
   */
  toServiceExecutionResult(
    bridged: BridgedCommandResult,
    startTime: number
  ): ServiceExecutionResult {
    return {
      success: bridged.success,
      result: bridged.result,
      error: bridged.error,
      executedAt: new Date(),
      executionTime: Date.now() - startTime,
    };
  }

  /**
   * Select the best resource for a given capability and parameters.
   *
   * Selection priority:
   * 1. DeviceResource over other resource types
   * 2. Resources in the same location as the request
   * 3. Available resources over unavailable ones
   */
  private selectBestResource(
    resources: Resource[],
    params: Record<string, unknown>
  ): Resource | null {
    // Prefer DeviceResource type
    const deviceResources = resources.filter(r => r.type === 'device');
    const candidatePool = deviceResources.length > 0 ? deviceResources : resources;

    // Filter to available resources
    const available = candidatePool.filter(r => r.isAvailable());

    if (available.length === 0) {
      return candidatePool[0] || null;
    }

    // Check if params specify a location constraint
    const targetLocation = params.location as string | undefined;
    if (targetLocation) {
      const locationMatch = available.find(r => r.location === targetLocation);
      if (locationMatch) {
        return locationMatch;
      }
    }

    return available[0];
  }
}
