/**
 * Device Resource
 *
 * Adapts a Device to the Resource interface
 * This allows Cognitive Agents to work with devices through a unified abstraction
 */

import type { Device, DeviceCapability } from '@active-collaboration/shared';
import {
  BaseResource,
  ResourceCapability,
  ResourceExecutionResult,
  ResourceState,
} from './Resource.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('DeviceResource');

/**
 * Device Resource wraps a Device and implements Resource interface
 */


export class DeviceResource extends BaseResource {
  private device: Device;

  constructor(device: Device, owner: string) {
    // Determine category from device type
    const category = determineDeviceCategory(device.type);

    // Convert device capabilities to resource capabilities (with semantic inference)
    const capabilities = convertCapabilities(device.capabilities, device.type);

    super({
      id: device.id,
      name: device.name,
      type: 'device',
      location: device.location,
      category,
      capabilities,
      owner,
      tags: [device.type, category], // Auto-generate tags from type and category
    });

    this.device = device;

    logger.info(
      `[DeviceResource:${this.id}] Wrapped device: ${device.name} (${device.type})`
    );
  }

  /**
   * Get current device state
   */
  getState(): ResourceState {
    // Devices don't expose state directly in the Device interface
    // We return device metadata as state
    return {
      deviceId: this.device.id,
      deviceName: this.device.name,
      deviceType: this.device.type,
      status: this.device.status,
      location: this.device.location,
      capabilities: this.device.capabilities.length,
      services: this.device.services?.length || 0,
    };
  }

  /**
   * Execute a device capability (command)
   * Handles both semantic capabilities and device commands.
   *
   * For HVAC/thermostat devices, semantic capabilities like "cooling" or
   * "heating" are expanded into a multi-command sequence:
   *   set-mode → turn-on → set-temperature
   */
  async execute(
    capabilityName: string,
    params?: any
  ): Promise<ResourceExecutionResult> {
    logger.info(
      `[DeviceResource:${this.id}] Executing capability: ${capabilityName}`,
      params || ''
    );

    try {
      // Check if this is a multi-command semantic capability for HVAC/thermostat
      const multiCmd = this.resolveMultiCommand(capabilityName, params);
      if (multiCmd) {
        return await this.executeMultiCommand(multiCmd);
      }

      // Map semantic capabilities to device commands
      const deviceCommand = this.mapSemanticToCommand(capabilityName);
      logger.info(`[DeviceResource:${this.id}] Mapped to command: ${deviceCommand}`);

      // Verify the device has this capability
      const hasCapability = this.device.capabilities.some(
        cap => cap.name === deviceCommand || cap.name.toLowerCase().includes(deviceCommand.toLowerCase())
      );

      if (!hasCapability) {
        // Try to find a similar capability
        const alternativeCommand = this.findAlternativeCommand(capabilityName);
        if (alternativeCommand) {
          logger.info(`[DeviceResource:${this.id}] Using alternative command: ${alternativeCommand}`);
          return this.executeCommand(alternativeCommand, params);
        }

        return {
          success: false,
          error: `Device ${this.id} does not have capability: ${deviceCommand}`,
          timestamp: new Date(),
        };
      }

      return this.executeCommand(deviceCommand, params);
    } catch (error) {
      logger.error(`[DeviceResource:${this.id}] Execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };
    }
  }

  /**
   * Resolve a semantic capability into a multi-command sequence.
   * Returns null if not applicable (single-command path used instead).
   *
   * Extended to handle non-HVAC actuator types (dehumidifier, smart-light,
   * exhaust-fan, humidifier, air-purifier) which all need 'turn-on' to
   * set power=true for physics effects to activate.
   */
  private resolveMultiCommand(
    capabilityName: string,
    params?: any,
  ): Array<{ command: string; params?: any }> | null {
    const cap = capabilityName.toLowerCase();
    const deviceType = this.device.type.toLowerCase();

    // --- HVAC/thermostat/climate types ---
    const isHvacType = deviceType.includes('hvac') || deviceType.includes('thermostat') || deviceType.includes('climate');

    if (isHvacType) {
      // Determine mode from capability name
      let mode: string | undefined;
      if (cap.includes('cool') || cap === 'cooling') {
        mode = 'cooling';
      } else if (cap.includes('heat') || cap === 'heating') {
        mode = 'heating';
      }

      // Only expand into multi-command if we have a directional mode
      if (mode) {
        const commands: Array<{ command: string; params?: any }> = [];

        // Step 1: Set mode
        commands.push({ command: 'set-mode', params: { mode } });

        // Step 2: Turn on
        commands.push({ command: 'turn-on', params: {} });

        // Step 3: Set target temperature
        const targetTemp = params?.target ?? params?.targetTemperature ?? params?.temperature;
        if (targetTemp !== undefined) {
          commands.push({ command: 'set-temperature', params: { temperature: targetTemp } });
        }

        logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
        return commands;
      }
      return null;
    }

    // --- Dehumidifier ---
    if (deviceType.includes('dehumidifier')) {
      if (cap.includes('humidity-control') || cap.includes('dehumidif') || cap.includes('environment')) {
        const commands = [
          { command: 'set-mode', params: { mode: 'auto' } },
          { command: 'turn-on', params: {} },
        ];
        logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
        return commands;
      }
    }

    // --- Smart-light / Lamp ---
    if (deviceType.includes('light') || deviceType.includes('lamp')) {
      if (cap.includes('lighting-control') || cap.includes('smart-home') || cap.includes('environment')) {
        const brightness = params?.brightness ?? 100;
        const commands = [
          { command: 'turn-on', params: {} },
          { command: 'set-brightness', params: { brightness } },
        ];
        logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
        return commands;
      }
    }

    // --- Exhaust-fan ---
    if (deviceType.includes('exhaust')) {
      if (cap.includes('ventilation') || cap.includes('humidity-control') || cap.includes('environment')) {
        const commands = [
          { command: 'turn-on', params: {} },
        ];
        logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
        return commands;
      }
    }

    // --- Humidifier ---
    if (deviceType.includes('humidifier') && !deviceType.includes('de-')) {
      if (cap.includes('humidity-control') || cap.includes('environment')) {
        const commands = [
          { command: 'set-mode', params: { mode: 'auto' } },
          { command: 'turn-on', params: {} },
        ];
        logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
        return commands;
      }
    }

    // --- Air-purifier ---
    if (deviceType.includes('purifier')) {
      if (cap.includes('air-purification') || cap.includes('reduce-pollution') || cap.includes('control-air') || cap.includes('environment')) {
        const commands = [
          { command: 'set-mode', params: { mode: 'auto' } },
          { command: 'turn-on', params: {} },
        ];
        logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
        return commands;
      }
    }

    return null;
  }

  /**
   * Execute a sequence of commands on the device.
   * Each command is sent in order; if any fails, the sequence stops.
   */
  private async executeMultiCommand(
    commands: Array<{ command: string; params?: any }>,
  ): Promise<ResourceExecutionResult> {
    let lastResult: ResourceExecutionResult = { success: true, timestamp: new Date() };

    for (const { command, params } of commands) {
      logger.info(`[DeviceResource:${this.id}] Multi-command step: ${command}`);
      const result = await this.executeCommand(command, params);
      if (!result.success) {
        logger.warn(`[DeviceResource:${this.id}] Multi-command step '${command}' failed: ${result.error}`);
        return result;
      }
      lastResult = result;
    }

    return lastResult;
  }

  /**
   * Execute a command on the underlying device
   */
  private async executeCommand(commandName: string, params?: any): Promise<ResourceExecutionResult> {
    if ('executeCommand' in this.device && typeof this.device.executeCommand === 'function') {
      const result = await (this.device as unknown as { executeCommand: (commandName: string, params?: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }> }).executeCommand(commandName, params);
      logger.info(`[DeviceResource:${this.id}] Execution completed:`, result);

      return {
        success: result.success,
        result: result.result,
        error: result.error,
        timestamp: new Date(),
      };
    }

    return {
      success: false,
      error: `Device does not support direct execution.`,
      timestamp: new Date(),
    };
  }

  /**
   * Find an alternative command based on available capabilities
   */
  private findAlternativeCommand(capabilityName: string): string | null {
    const cap = capabilityName.toLowerCase();
    const availableCaps = this.device.capabilities.map(c => c.name.toLowerCase());

    // For any capability, try to find a matching one
    for (const availCap of availableCaps) {
      if (availCap.includes(cap) || cap.includes(availCap)) {
        return this.device.capabilities.find(c => c.name.toLowerCase() === availCap)?.name || null;
      }
    }

    // Semantic mapping fallbacks based on capability type
    if (cap.includes('control') || cap.includes('set')) {
      // Find any 'set' or 'control' capability
      const controlCap = availableCaps.find(c => c.includes('set') || c.includes('control'));
      if (controlCap) {
        return this.device.capabilities.find(c => c.name.toLowerCase() === controlCap)?.name || null;
      }
    }

    if (cap.includes('monitor') || cap.includes('read') || cap.includes('get')) {
      // Find any 'read' or 'get' capability
      const readCap = availableCaps.find(c => c.includes('read') || c.includes('get'));
      if (readCap) {
        return this.device.capabilities.find(c => c.name.toLowerCase() === readCap)?.name || null;
      }
    }

    // Return the first available capability as last resort
    if (this.device.capabilities.length > 0) {
      return this.device.capabilities[0].name;
    }

    return null;
  }

  /**
   * Map semantic capabilities to actual device commands
   * This bridges the gap between high-level task requirements and device operations
   *
   * IMPORTANT: Ordering matters — more specific patterns MUST come before generic ones.
   * For actuator devices, actuator patterns are checked first (e.g., 'humidity-control'
   * before generic 'humidity'). For sensor devices, only sensor patterns are checked.
   */
  private mapSemanticToCommand(capabilityName: string): string {
    const cap = capabilityName.toLowerCase();
    const deviceType = this.device.type.toLowerCase();

    // Determine if this is an actuator device type
    const isActuatorType = [
      'hvac', 'thermostat', 'climate', 'dehumidifier', 'humidifier',
      'heater', 'radiator', 'light', 'lamp', 'exhaust', 'purifier',
      'air-conditioner', 'ac', 'smart-plug', 'speaker',
    ].some(t => deviceType.includes(t));

    // --- ACTUATOR patterns (specific before generic) ---
    // These must be checked before generic sensor patterns to avoid
    // e.g., 'humidity-control' matching 'humidity' → 'read-humidity'
    if (isActuatorType) {
      if (cap.includes('humidity-control') || cap.includes('dehumidif')) return 'set-mode';
      if (cap.includes('humidif') && !cap.includes('de-')) return 'set-mode';
      if (cap.includes('lighting-control') || cap.includes('smart-home')) return 'turn-on';
      if (cap.includes('ventilation') || cap.includes('exhaust')) return 'turn-on';
      if (cap.includes('air-purification') || cap.includes('reduce-pollution') || cap.includes('control-air')) return 'set-mode';
      // HVAC-specific (cooling/heating usually handled by resolveMultiCommand, this is fallback)
      if (cap.includes('hvac') || cap.includes('climate-control') || cap.includes('temperature-control')) return 'set-temperature';
      if (cap.includes('cooling') || cap.includes('cool')) return 'set-temperature';
      if (cap.includes('heating') || cap.includes('heat')) return 'set-temperature';
      // Generic 'environment' on actuator → turn-on
      if (cap.includes('environment')) return 'turn-on';
    }

    // --- SENSOR patterns ---
    if (cap.includes('air-quality') || cap.includes('monitor-air')) return 'read-aqi';
    if (cap.includes('temperature') || cap.includes('monitor-temperature')) return 'read-temperature';
    if (cap.includes('humidity') || cap.includes('monitor-humidity')) return 'read-humidity';

    // --- GENERIC patterns (non-device-specific) ---
    if (cap.includes('environment')) return 'read-aqi';
    if (cap.includes('control-traffic') || cap.includes('control-signals') || cap.includes('traffic')) return 'set-signal';
    if (cap.includes('display') || cap.includes('vms') || cap.includes('alert')) return 'set-message';
    if (cap.includes('emergency') || cap.includes('public-safety')) return 'trigger-alert';
    if (cap.includes('detect') || cap.includes('monitor')) return 'get-status';

    // Default: try the capability name as-is
    return capabilityName;
  }

  /**
   * Check if device is available
   */
  isAvailable(): boolean {
    return this.device.status === 'online';
  }

  /**
   * Get the underlying device
   */
  getDevice(): Device {
    return this.device;
  }

  /**
   * Update device reference
   */
  updateDevice(device: Device): void {
    logger.info(`[DeviceResource:${this.id}] Updating device reference`);
    this.device = device;
  }
}

/**
 * Determine device category from device type
 */
function determineDeviceCategory(deviceType: string): string {
  const type = deviceType.toLowerCase();

  if (type.includes('sensor') || type.includes('temperature') || type.includes('humidity')) {
    return 'sensor';
  }

  if (
    type.includes('switch') ||
    type.includes('light') ||
    type.includes('lock') ||
    type.includes('actuator')
  ) {
    return 'actuator';
  }

  if (type.includes('thermostat') || type.includes('controller')) {
    return 'controller';
  }

  return 'general';
}

/**
 * Semantic capability mapping
 * Maps device types to high-level semantic capabilities
 */
const DEVICE_TYPE_TO_SEMANTIC_CAPABILITIES: Record<string, string[]> = {
  // Air quality devices
  'air-quality-sensor': ['monitor-air-quality', 'detect-pollution', 'environment', 'air-quality'],
  'air-purifier': ['air-purification', 'reduce-pollution', 'environment', 'control-air-quality'],

  // Traffic devices
  'traffic-light-controller': ['control-traffic', 'traffic', 'optimize-flow', 'control-signals'],
  'traffic-sensor': ['monitor-traffic', 'traffic', 'detect-congestion'],
  'variable-message-sign': ['display-alerts', 'public-safety', 'vms', 'emergency'],

  // Environmental sensors
  'temperature-sensor': ['monitor-temperature', 'environment', 'climate'],
  'humidity-sensor': ['monitor-humidity', 'environment', 'climate'],
  'seismic-sensor': ['monitor-seismic', 'emergency', 'detect-earthquake'],
  'water-sensor': ['monitor-water', 'environment', 'detect-flooding'],
  'flood-barrier': ['flood-control', 'emergency', 'protect-infrastructure'],

  // HVAC systems
  'hvac-controller': ['climate-control', 'environment', 'temperature-control', 'hvac'],
  'heater': ['heating', 'environment', 'temperature-control'],
  'cooling-station': ['cooling', 'environment', 'temperature-control'],
  'thermostat': ['climate-control', 'environment', 'temperature-control', 'hvac-control', 'hvac'],

  // Emergency devices
  'emergency-call-box': ['emergency-response', 'emergency', 'public-safety'],
  'smoke-detector': ['detect-fire', 'emergency', 'public-safety'],

  // Energy devices
  'smart-meter': ['monitor-energy', 'energy', 'grid-management'],
  'grid-monitor': ['monitor-grid', 'energy', 'detect-outage'],
};

/**
 * Infer semantic capabilities from device type
 */
function inferSemanticCapabilities(deviceType: string): string[] {
  const type = deviceType.toLowerCase();

  // Direct match
  if (DEVICE_TYPE_TO_SEMANTIC_CAPABILITIES[type]) {
    return DEVICE_TYPE_TO_SEMANTIC_CAPABILITIES[type];
  }

  // Partial match
  for (const [key, caps] of Object.entries(DEVICE_TYPE_TO_SEMANTIC_CAPABILITIES)) {
    if (type.includes(key) || key.includes(type)) {
      return caps;
    }
  }

  // Default: infer from type keywords
  const inferred: string[] = [];
  if (type.includes('sensor')) inferred.push('monitoring', 'sensing');
  if (type.includes('controller')) inferred.push('control');
  if (type.includes('emergency') || type.includes('alarm')) inferred.push('emergency', 'public-safety');
  if (type.includes('traffic')) inferred.push('traffic');
  if (type.includes('air')) inferred.push('environment', 'air-quality');
  if (type.includes('water')) inferred.push('environment', 'water');

  return inferred.length > 0 ? inferred : ['general'];
}

/**
 * Convert device capabilities to resource capabilities
 * Now includes semantic capabilities inferred from device type
 */
function convertCapabilities(deviceCaps: DeviceCapability[], deviceType: string): ResourceCapability[] {
  // Start with original device capabilities
  const capabilities: ResourceCapability[] = (deviceCaps || []).map((cap) => ({
    name: cap.name,
    type: cap.type as string,
    description: `${cap.type} capability`,
    parameters: cap.parameters || [],
  }));

  // Add semantic capabilities inferred from device type
  const semanticCaps = inferSemanticCapabilities(deviceType);
  for (const semCap of semanticCaps) {
    // Check if not already present
    if (!capabilities.some(c => c.name === semCap)) {
      capabilities.push({
        name: semCap,
        type: 'semantic',
        description: `Semantic capability: ${semCap}`,
        parameters: [],
      });
    }
  }

  return capabilities;
}
