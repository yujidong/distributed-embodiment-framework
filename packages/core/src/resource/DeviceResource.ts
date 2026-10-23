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

// ---------------------------------------------------------------------------
// Pure device-type semantics (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Multi-command expansion plan for a capability on a device TYPE, or null
 * when the single-command path applies. Extracted pure (T-002): flow
 * validation needs the same WHEN-to-expand decision to tell whether a flow
 * node capability is executable at runtime (e.g. 'lighting-control' on a
 * light expands to turn-on + set-brightness even though no command handler
 * is registered for the literal name) — validation and execution MUST agree,
 * otherwise flows validate but die mid-run.
 *
 * Handles non-HVAC actuator types (dehumidifier, smart-light, exhaust-fan,
 * humidifier, air-purifier) which all need 'turn-on' to set power=true for
 * physics effects to activate. T-408 adds the lock family: 'access-control'
 * on a lock-family type expands to the secure 'lock' command and
 * 'remote-access-grant' to the audited 'grant-temporary-access'.
 */
export function multiCommandNamesForDeviceType(
  capabilityName: string,
  deviceType: string,
): readonly string[] | null {
  const cap = capabilityName.toLowerCase();
  const type = deviceType.toLowerCase();

  // --- Lock family (T-408, R19 NW-F02) ---
  // A lock-family device (type contains 'lock') dispatches its
  // access-control class of capabilities through the SECURE-STATE commands
  // (SimpleActionCommandHandler: lock/unlock/grant-temporary-access with
  // the who/when audit trail). 'access-control' is the SECURE default — a
  // lockdown — and the grant lane maps to the audited temporary-access
  // command. 'lock'/'unlock' authored DIRECTLY are handler-backed names
  // and take the single-command path when declared. Single-element
  // expansions are the exhaust-fan precedent (['turn-on']); a lock can
  // never expand to BOTH lock and unlock — the sequence would end
  // unlocked.
  if (type.includes('lock')) {
    if (cap.includes('access-control') || cap === 'lock-control') return ['lock'];
    if (cap.includes('remote-access-grant') || cap.includes('grant-temporary-access')) {
      return ['grant-temporary-access'];
    }
  }

  // --- HVAC/thermostat/climate types ---
  // Only expand when the capability carries a directional mode (cool/heat).
  const isHvacType = type.includes('hvac') || type.includes('thermostat') || type.includes('climate');
  if (isHvacType) {
    const hasMode = (cap.includes('cool') || cap === 'cooling') ||
      (cap.includes('heat') || cap === 'heating');
    return hasMode ? ['set-mode', 'turn-on', 'set-temperature'] : null;
  }

  // --- Dehumidifier ---
  if (type.includes('dehumidifier') &&
      (cap.includes('humidity-control') || cap.includes('dehumidif') || cap.includes('environment'))) {
    return ['set-mode', 'turn-on'];
  }

  // --- Smart-light / Lamp ---
  if ((type.includes('light') || type.includes('lamp')) &&
      (cap.includes('lighting-control') || cap.includes('smart-home') || cap.includes('environment'))) {
    return ['turn-on', 'set-brightness'];
  }

  // --- Exhaust-fan ---
  if (type.includes('exhaust') &&
      (cap.includes('ventilation') || cap.includes('humidity-control') || cap.includes('environment'))) {
    return ['turn-on'];
  }

  // --- Humidifier (not de-humidifier) ---
  if (type.includes('humidifier') && !type.includes('de-') &&
      (cap.includes('humidity-control') || cap.includes('environment'))) {
    return ['set-mode', 'turn-on'];
  }

  // --- Air-purifier ---
  if (type.includes('purifier') &&
      (cap.includes('air-purification') || cap.includes('reduce-pollution') ||
        cap.includes('control-air') || cap.includes('environment'))) {
    return ['set-mode', 'turn-on'];
  }

  return null;
}

/**
 * The single device command a semantic capability maps to for a device TYPE
 * (DeviceResource.mapSemanticToCommand, extracted pure for T-002 flow
 * validation). Returns the capability name AS-IS when no pattern applies —
 * the device then receives the capability name directly as the command.
 *
 * IMPORTANT: Ordering matters — more specific patterns MUST come before
 * generic ones. For actuator devices, actuator patterns are checked first
 * (e.g., 'humidity-control' before generic 'humidity'). For sensor devices,
 * only sensor patterns are checked.
 */
export function semanticCommandForDeviceType(capabilityName: string, deviceType: string): string {
  const cap = capabilityName.toLowerCase();
  const type = deviceType.toLowerCase();

  // Determine if this is an actuator device type
  const isActuatorType = [
    'hvac', 'thermostat', 'climate', 'dehumidifier', 'humidifier',
    'heater', 'radiator', 'light', 'lamp', 'exhaust', 'purifier',
    'air-conditioner', 'ac', 'smart-plug', 'speaker',
  ].some(t => type.includes(t));

  // --- ACTUATOR patterns (specific before generic) ---
  // These must be checked before generic sensor patterns to avoid
  // e.g., 'humidity-control' matching 'humidity' → 'read-humidity'
  if (isActuatorType) {
    if (cap.includes('humidity-control') || cap.includes('dehumidif')) return 'set-mode';
    if (cap.includes('humidif') && !cap.includes('de-')) return 'set-mode';
    if (cap.includes('lighting-control') || cap.includes('smart-home')) return 'turn-on';
    if (cap.includes('ventilation') || cap.includes('exhaust')) return 'turn-on';
    if (cap.includes('air-purification') || cap.includes('reduce-pollution') || cap.includes('control-air')) return 'set-mode';
    // HVAC-specific (cooling/heating usually handled by multi-command expansion, this is fallback)
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
 * Device Resource wraps a Device and implements Resource interface
 */


export class DeviceResource extends BaseResource {
  /**
   * Comfort target (°C, inside the usual 24–26 band) applied when an HVAC
   * cooling/heating actuation carries no explicit setpoint (Fix-8).
   */
  static readonly DEFAULT_COMFORT_TARGET_C = 24;

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
    params?: any,
    invocationContext?: { actor?: string },
  ): Promise<ResourceExecutionResult> {
    logger.info(
      `[DeviceResource:${this.id}] Executing capability: ${capabilityName}`,
      params || ''
    );

    try {
      // Check if this is a multi-command semantic capability for HVAC/thermostat
      const multiCmd = this.resolveMultiCommand(capabilityName, params);
      if (multiCmd) {
        return await this.executeMultiCommand(multiCmd, invocationContext);
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
          return this.executeCommand(alternativeCommand, params, invocationContext);
        }

        return {
          success: false,
          error: `Device ${this.id} does not have capability: ${deviceCommand}`,
          timestamp: new Date(),
        };
      }

      return this.executeCommand(deviceCommand, params, invocationContext);
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
   * The WHEN-to-expand decision lives in the pure helper
   * multiCommandNamesForDeviceType (shared with flow validation — T-002);
   * this method only attaches params to the plan it returns.
   */
  private resolveMultiCommand(
    capabilityName: string,
    params?: any,
  ): Array<{ command: string; params?: any }> | null {
    const names = multiCommandNamesForDeviceType(capabilityName, this.device.type);
    if (names === null) return null;

    const cap = capabilityName.toLowerCase();
    const commands = names.map((command): { command: string; params?: any } => {
      if (command === 'set-mode') {
        // HVAC plans carry a directional mode derived from the capability;
        // every other expansion type runs 'auto'.
        const mode = cap.includes('cool') || cap === 'cooling'
          ? 'cooling'
          : cap.includes('heat') || cap === 'heating'
            ? 'heating'
            : 'auto';
        return { command, params: { mode } };
      }
      if (command === 'set-temperature') {
        // When the caller provides none, fall back to the comfort default
        // (Fix-8): an HVAC running cooling/heating WITHOUT a setpoint is
        // formally correct but physically inert — the physics layer only
        // cools/heats toward a target temperature.
        const targetTemp = params?.target ?? params?.targetTemperature ?? params?.temperature
          ?? DeviceResource.DEFAULT_COMFORT_TARGET_C;
        return { command, params: { temperature: targetTemp } };
      }
      if (command === 'set-brightness') {
        return { command, params: { brightness: params?.brightness ?? 100 } };
      }
      return { command, params: {} }; // turn-on
    });

    logger.info(`[DeviceResource:${this.id}] Expanded '${capabilityName}' into ${commands.length} commands: ${commands.map(c => c.command).join(' → ')}`);
    return commands;
  }

  /**
   * Execute a sequence of commands on the device.
   * Each command is sent in order; if any fails, the sequence stops.
   */
  private async executeMultiCommand(
    commands: Array<{ command: string; params?: any }>,
    invocationContext?: { actor?: string },
  ): Promise<ResourceExecutionResult> {
    let lastResult: ResourceExecutionResult = { success: true, timestamp: new Date() };

    for (const { command, params } of commands) {
      logger.info(`[DeviceResource:${this.id}] Multi-command step: ${command}`);
      const result = await this.executeCommand(command, params, invocationContext);
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
  private async executeCommand(
    commandName: string,
    params?: any,
    invocationContext?: { actor?: string },
  ): Promise<ResourceExecutionResult> {
    if ('executeCommand' in this.device && typeof this.device.executeCommand === 'function') {
      // T-608 (R26): the actor label rides as invocation context (3rd arg)
      // — SimulatedDevice stamps it on DEVICE_OPERATION_EXECUTED and the
      // handler audit trail; params stay pure (R17).
      const result = await (this.device as unknown as { executeCommand: (commandName: string, params?: Record<string, unknown>, context?: { actor?: string }) => Promise<{ success: boolean; result?: unknown; error?: string }> }).executeCommand(commandName, params, invocationContext);
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
   * Map semantic capabilities to actual device commands.
   * Pure logic lives in semanticCommandForDeviceType (shared with flow
   * validation — T-002); see that function for the pattern-ordering rules.
   */
  private mapSemanticToCommand(capabilityName: string): string {
    return semanticCommandForDeviceType(capabilityName, this.device.type);
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
