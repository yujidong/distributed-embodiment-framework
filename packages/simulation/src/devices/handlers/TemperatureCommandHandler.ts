/**
 * Temperature Command Handler
 *
 * Handles temperature control commands:
 * - setTemperature, setTargetTemperature, adjustTemperature
 */

import { BaseCommandHandler } from './CommandHandler.js';

/**
 * Temperature Command Handler
 * Handles temperature control commands for HVAC/thermostat devices
 */
export class TemperatureCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    const normalized = this.normalizeCommand(commandName);
    return [
      'settemperature',
      'settargettemperature',
      'adjusttemperature',
      'settemp',
      'settargettemp',
    ].includes(normalized);
  }

  execute(params: {
    commandName: string;
    params?: any;
    currentState: any;
    deviceType: string;
    deviceId: string;
  }): Partial<Record<string, unknown>> {
    const stateUpdate: Record<string, unknown> = {};
    const cmd = this.normalizeCommand(params.commandName);
    const deviceTypeLower = params.deviceType.toLowerCase();

    switch (cmd) {
      case 'settemperature':
      case 'settargettemperature':
      case 'settemp':
      case 'settargettemp':
        if (params.params?.temperature !== undefined) {
          // Always set targetTemperature — state properties are created dynamically.
          // Prefer targetTemperature, fall back to existing naming convention.
          if ('targetTemp' in params.currentState && !('targetTemperature' in params.currentState)) {
            stateUpdate.targetTemp = params.params.temperature;
          } else {
            stateUpdate.targetTemperature = params.params.temperature;
          }
          this.log(`Temperature set to ${params.params.temperature}°C`);
        } else if (params.params?.value !== undefined) {
          // Handle value parameter — always set targetTemperature
          if ('targetTemp' in params.currentState && !('targetTemperature' in params.currentState)) {
            stateUpdate.targetTemp = params.params.value;
          } else {
            stateUpdate.targetTemperature = params.params.value;
          }
          this.log(`Temperature set to ${params.params.value}°C (via value parameter)`);
        }
        break;

      case 'adjusttemperature':
        if (params.params?.adjustment !== undefined) {
          // Adjust relative to current temperature
          const currentTemp = params.currentState?.targetTemperature ||
                              params.currentState?.targetTemp ||
                              params.currentState?.temperature || 20;

          const newTemp = currentTemp + params.params.adjustment;

          if ('targetTemperature' in params.currentState) {
            stateUpdate.targetTemperature = newTemp;
          } else if ('targetTemp' in params.currentState) {
            stateUpdate.targetTemp = newTemp;
          } else if ('temperature' in params.currentState) {
            stateUpdate.temperature = newTemp;
          }
          this.log(`Temperature adjusted by ${params.params.adjustment}°C to ${newTemp}°C`);
        }
        break;
    }

    return stateUpdate;
  }
}
