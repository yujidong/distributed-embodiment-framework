/**
 * Generic Set Command Handler
 *
 * Handles generic set-* commands:
 * - set-hvac, set-thermostat, set-light, etc.
 * Maps to appropriate state properties based on device type
 */

import { BaseCommandHandler } from './CommandHandler.js';

/**
 * T-506 (EC24-F03): every param spelling the generic set-* branches
 * recognize. Single-sourced HERE (the handler owns its spellings) and
 * consumed by capability-contract's acceptedParameterNames fallback so the
 * SimulatedDevice no-op failure always names usable params — the R13 lesson
 * (duplicated vocabularies drift) is enforced by a parity test that executes
 * the handler for each listed name.
 */
export const GENERIC_SET_PARAM_NAMES: readonly string[] = [
  'value', 'brightness', 'power', 'speed', 'fanSpeed', 'targetHumidity',
  'target', 'targetTemp', 'mode', 'charging', 'enable', 'rate', 'chargingRate',
  'volume',
];

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

    // Handle set-* commands with 'value' or named parameters.
    // TASK-001 follow-up: `brightness` is a first-class param name (core's
    // DeviceResource emits it), so the brightness-only case must reach
    // handleValueParameter too — the old `value !== undefined` gate made
    // the brightness branch dead code.
    if (params.params?.value !== undefined || params.params?.brightness !== undefined) {
      this.handleValueParameter(params, deviceTypeLower, stateUpdate);
    }

    // Handle set-* commands with specific parameters
    if (params.params?.power !== undefined && 'power' in params.currentState) {
      stateUpdate.power = params.params.power;
      this.log(`Setting power=${params.params.power}`);
    }

    // Handle fan speed (set-fan-speed {speed}) — state properties are
    // created dynamically, mirroring the mode handling below.
    // R13 (CB-F01): the state-property spelling `fanSpeed` is accepted as an
    // alias for the canonical `speed` param — a flow author who wrote
    // params {fanSpeed: 3} (matching the state key the command produces)
    // used to sail through validation and die at run time with
    // "no handler / no effect for command set-fan-speed". Same dual-spelling
    // precedent as brightness/value above (TASK-001).
    // T-711 (R29, F5): setting a fan speed implies power-on — same precedent
    // as set-temperature (TemperatureCommandHandler) and set-mode
    // (ClimateModeCommandHandler). Without this the roof damper ended
    // `power:false, fanSpeed:2`: state written, physics inert. An explicit
    // `power` param in the same command still wins.
    const fanSpeed = params.params?.speed ?? params.params?.fanSpeed;
    if (fanSpeed !== undefined) {
      stateUpdate.fanSpeed = fanSpeed;
      if (params.params?.power === undefined) {
        stateUpdate.power = true;
        stateUpdate.status = 'on';
        this.log(`Setting fanSpeed=${fanSpeed} (device powered on)`);
      } else {
        this.log(`Setting fanSpeed=${fanSpeed} (power=${params.params.power} kept as commanded)`);
      }
    }

    // T-506 (EC24-F03): battery/charging spellings — set-charging
    // {charging}|{enable} (boolean) and {rate}|{chargingRate} (numeric).
    // The generic handler claims EVERY set-*, but no branch recognized the
    // battery params → empty stateUpdate → the honest no-op failure named
    // no usable spelling (plain {value} would have worked; nobody could
    // know). Dynamic state keys (`charging`, `chargingRate`), the exact
    // fanSpeed precedent above.
    const charging = params.params?.charging ?? params.params?.enable;
    if (charging !== undefined) {
      stateUpdate.charging = charging;
      this.log(`Setting charging=${charging}`);
    }
    const chargingRate = params.params?.rate ?? params.params?.chargingRate;
    if (chargingRate !== undefined) {
      stateUpdate.chargingRate = chargingRate;
      this.log(`Setting chargingRate=${chargingRate}`);
    }

    // BUG-06 (library-comfort): set-volume {volume} — the speaker state key
    // is `volume`, but no branch recognized the param, so EVERY spelling
    // no-op'd on speakers (the parity vocabulary above didn't list it either).
    // Dynamic state key, the exact fanSpeed/charging precedent.
    if (params.params?.volume !== undefined) {
      stateUpdate.volume = params.params.volume;
      this.log(`Setting volume=${params.params.volume}`);
    }

    // R13 (CB-F01 same class): set-humidity {targetHumidity} — the parameter
    // hints table documents `targetHumidity`, but only `value` reached this
    // handler for humidity-typed devices, so the documented spelling was a
    // guaranteed no-effect. Accept it for humidity/humidifier devices.
    if (params.params?.targetHumidity !== undefined &&
        (deviceTypeLower.includes('humid') || 'targetHumidity' in params.currentState)) {
      stateUpdate.targetHumidity = params.params.targetHumidity;
      this.log(`Setting targetHumidity=${params.params.targetHumidity}`);
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
    // Light devices: value or brightness -> brightness
    // TASK-001: core's DeviceResource emits {brightness} (not {value}) —
    // accept both spellings, canonical stays brightness.
    // DevLoop (env-bridged devices): environment devices created via the
    // API often carry no initialState, so `brightness` is not yet a state
    // key — create it dynamically (same philosophy as mode/fanSpeed above).
    // The dispatch gate already ensured the device DECLARED the set-brightness
    // capability, so a non-dimmable light never reaches this branch.
    // T-034: display-family devices (billboards, panels, VMS signs) declare
    // set-brightness too — previously the generic fallback found no numeric
    // `target` key and the command was a silent no-op (RF-F07).
    else if (
      deviceTypeLower.includes('light') ||
      deviceTypeLower.includes('lamp') ||
      deviceTypeLower.includes('display') ||
      deviceTypeLower.includes('billboard') ||
      deviceTypeLower.includes('sign') ||
      deviceTypeLower.includes('kiosk') ||
      deviceTypeLower.includes('screen') ||
      deviceTypeLower.includes('panel')
    ) {
      const brightness = params.params?.brightness ?? params.params?.value;
      if (brightness !== undefined) {
        stateUpdate.brightness = brightness;
        this.log(`Set-* for light: setting brightness=${brightness}`);
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
    // Speaker/audio devices: value -> volume (BUG-06 — the generic fallback
    // only hunts a numeric `target*` key, which speakers don't carry, so
    // set-volume {value: 30} used to no-op; same value→named-key precedent
    // as brightness/targetHumidity above).
    else if (deviceTypeLower.includes('speaker') || deviceTypeLower.includes('audio')) {
      stateUpdate.volume = value;
      this.log(`Set-* for speaker: setting volume=${value}`);
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
