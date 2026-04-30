/**
 * Generic Set Command Handler
 *
 * Handles generic set-* commands:
 * - set-hvac, set-thermostat, set-light, etc.
 * Maps to appropriate state properties based on device type
 */

import { BaseCommandHandler } from './CommandHandler.js';

/**
 * Generic Set Command Handler
 * Handles set-* commands for various device types
 */
export class GenericSetCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    const normalized = this.normalizeCommand(commandName);
    // Handles any set-* or set_* command
    return normalized.startsWith('set');
  }

  execute(params: {
    commandName: string;
    params?: any;
    currentState: any;
    deviceType: string;
    deviceId: string;
  }): Partial<Record<string, unknown>> {
    const stateUpdate: Record<string, unknown> = {};
    const deviceTypeLower = (params.deviceType || '').toLowerCase();

    // Handle set-* commands with 'value' parameter
    if (params.params?.value !== undefined) {
      this.handleValueParameter(params, deviceTypeLower, stateUpdate);
    }

    // Handle set-* commands with specific parameters
    if (params.params?.power !== undefined && 'power' in params.currentState) {
      stateUpdate.power = params.params.power;
      this.log(`Setting power=${params.params.power}`);
    }

    // Handle target temperature for thermostat/HVAC devices
    if (deviceTypeLower.includes('thermostat') ||
        deviceTypeLower.includes('hvac') ||
        deviceTypeLower.includes('climate')) {
      this.handleThermostatParams(params, stateUpdate);
    }

    return stateUpdate;
  }

  /**
   * Handle 'value' parameter based on device type
   */
  private handleValueParameter(
    params: any,
    deviceTypeLower: string,
    stateUpdate: Record<string, unknown>
  ): void {
    const value = params.params.value;

    // HVAC devices: value -> targetTemp
    if (deviceTypeLower.includes('hvac') ||
        deviceTypeLower.includes('thermostat') ||
        deviceTypeLower.includes('climate')) {
      if ('targetTemp' in params.currentState) {
        stateUpdate.targetTemp = value;
        this.log(`Set-* for HVAC: setting targetTemp=${value}`);
      } else if ('temperature' in params.currentState) {
        stateUpdate.temperature = value;
        this.log(`Set-* for HVAC: setting temperature=${value}`);
      }
    }
    // Light devices: value -> brightness
    else if (deviceTypeLower.includes('light') || deviceTypeLower.includes('lamp')) {
      if ('brightness' in params.currentState) {
        stateUpdate.brightness = value;
        this.log(`Set-* for light: setting brightness=${value}`);
      }
    }
    // Humidity devices: value -> targetHumidity
    else if (deviceTypeLower.includes('humidity') || deviceTypeLower.includes('humidifier')) {
      if ('targetHumidity' in params.currentState) {
        stateUpdate.targetHumidity = value;
        this.log(`Set-* for humidity: setting targetHumidity=${value}`);
      } else if ('humidity' in params.currentState) {
        stateUpdate.humidity = value;
        this.log(`Set-* for humidity: setting humidity=${value}`);
      }
    }
    // Fallback: Try to find a numeric state property to update
    else {
      this.handleGenericValue(params, value, stateUpdate);
    }
  }

  /**
   * Handle thermostat-specific parameters
   */
  private handleThermostatParams(
    params: any,
    stateUpdate: Record<string, unknown>
  ): void {
    // Handle target parameter — always set; state properties are created dynamically
    if (params.params?.target !== undefined) {
      stateUpdate.targetTemperature = params.params.target;
      this.log(`Setting targetTemperature=${params.params.target}`);
    }

    // Handle targetTemp parameter
    if (params.params?.targetTemp !== undefined) {
      stateUpdate.targetTemperature = params.params.targetTemp;
      this.log(`Setting targetTemperature=${params.params.targetTemp}`);
    }

    // Handle mode parameter for HVAC devices
    // Always set mode when provided — the device state gains properties
    // dynamically as commands are executed (initial state may not include all fields).
    if (params.params?.mode !== undefined) {
      stateUpdate.mode = params.params.mode;
      this.log(`Setting mode=${params.params.mode}`);
    }
  }

  /**
   * Handle generic value fallback
   */
  private handleGenericValue(
    params: any,
    value: any,
    stateUpdate: Record<string, unknown>
  ): void {
    // Try to find a numeric target property
    const stateKeys = Object.keys(params.currentState);
    for (const key of stateKeys) {
      const val = params.currentState[key];
      if (typeof val === 'number' && key.toLowerCase().includes('target')) {
        stateUpdate[key] = value;
        this.log(`Matched set-* generic, setting ${key}=${value}`);
        break;
      }
    }

    // If no target property found, use 'value' if it exists
    if (Object.keys(stateUpdate).length === 0 && 'value' in params.currentState) {
      stateUpdate.value = value;
      this.log(`Setting value=${value}`);
    }
  }
}
