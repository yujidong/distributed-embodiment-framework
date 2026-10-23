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
      // Declared capability alias: scenario/device templates declare
      // 'temperature-control' as a capability; it IS the set-temperature
      // command (same mapping as core's DeviceResource).
      'temperaturecontrol',
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
      case 'temperaturecontrol': {
        // Accept temperature / value / targetTemperature / target spellings.
        const newTarget = params.params?.temperature ??
                          params.params?.value ??
                          params.params?.targetTemperature ??
                          params.params?.target;
        if (newTarget !== undefined) {
          // Always set targetTemperature — state properties are created dynamically.
          // Prefer targetTemperature, fall back to existing naming convention.
          if ('targetTemp' in params.currentState && !('targetTemperature' in params.currentState)) {
            stateUpdate.targetTemp = newTarget;
          } else {
            stateUpdate.targetTemperature = newTarget;
          }
          // Setting a target means the device should actively reach it:
          // power on (real thermostats/ACs wake on set-temperature).
          stateUpdate.power = true;
          stateUpdate.status = 'on';
          this.log(`Temperature set to ${newTarget}°C (device powered on)`);
        }
        break;
      }

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
