/**
 * Climate Mode Command Handler
 *
 * Handles the declared climate-mode capabilities `cooling` / `heating`:
 * scenario and catalog device definitions declare them as capabilities, so
 * they must be executable commands (declared = executable). Each maps to a
 * mode switch plus power-on, which is what registers the device's physics
 * effect (see SimulatedDevice.createPhysicsEffect — direction comes from
 * state.mode).
 *
 * Fix-44g: also claims `set-mode { mode }` — the FIRST step of core's
 * DeviceResource multi-command expansion (set-mode → turn-on → set-temperature).
 * The expansion chain aborts on the first unclaimed command, so before this
 * alias the shipped flow example ('cooling' capability) could never actuate
 * an HVAC ("Command set-mode not found"). The capability contract stays the
 * single source: every command the resource layer can emit has a handler.
 */

import { BaseCommandHandler } from './CommandHandler.js';

/**
 * T-607 (DevLoop R26, GO26-F02 + HO26-F05): the CLOSED mode enum applies to
 * CLIMATE-family device types only. `set-mode` is claimed by name for every
 * device (registration order: this handler precedes GenericSet), so a
 * purifier's 'turbo' or a tracker's 'track' used to fail with the climate
 * vocabulary while passing executability validation (a handler exists) —
 * authoring/runtime verdict divergence. Non-climate devices now take any
 * non-empty mode string verbatim (generic set-* semantics); climate devices
 * keep the honest cooling|heating|auto teaching.
 */
const CLIMATE_DEVICE_TYPES: ReadonlySet<string> = new Set([
  'hvac', 'thermostat', 'air-conditioner', 'ac',
]);

/**
 * Climate mode command handler for HVAC/thermostat devices
 */
export class ClimateModeCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    const normalized = this.normalizeCommand(commandName);
    return normalized === 'cooling' || normalized === 'heating' || normalized === 'setmode';
  }

  execute(params: {
    commandName: string;
    params?: any;
    currentState: any;
    deviceType: string;
    deviceId: string;
  }): Partial<Record<string, unknown>> {
    const cmd = this.normalizeCommand(params.commandName);
    const isClimate = CLIMATE_DEVICE_TYPES.has((params.deviceType || '').toLowerCase());

    // 'set-mode' carries the mode in params (DeviceResource expansion emits
    // { mode: 'cooling' | 'heating' }); validate it like a declared mode.
    let mode: string;
    if (cmd === 'setmode') {
      if (isClimate) {
        const requested = this.normalizeCommand(String(params.params?.mode ?? ''));
        if (requested !== 'cooling' && requested !== 'heating' && requested !== 'auto') {
          // Unknown mode: no state change; the registry turns this into a
          // failed command with the reason attached.
          throw new Error(
            `set-mode: 'mode' must be one of cooling|heating|auto, got ${JSON.stringify(params.params?.mode)}`,
          );
        }
        mode = requested;
      } else {
        // T-607: non-climate device types — generic set-* semantics: any
        // non-empty mode string lands in state verbatim ('turbo' on a
        // purifier, 'track' on a tracker, 'eco' on a UPS).
        const raw = params.params?.mode;
        if (typeof raw !== 'string' || raw.trim().length === 0) {
          throw new Error(
            `set-mode: 'mode' must be a non-empty string, got ${JSON.stringify(raw)}`,
          );
        }
        // FEAT-02: selecting the 'ventilation' mode starts air exchange —
        // mirror the VentilationCommandHandler's state (power on) so the
        // T-707 air_flow physics effect registers (createPhysicsEffect
        // gates on the powered state).
        if (this.normalizeCommand(raw) === 'ventilation') {
          return { mode: raw, power: true, status: 'on' };
        }
        return { mode: raw };
      }
    } else {
      mode = cmd; // 'cooling' | 'heating'
    }

    const stateUpdate: Record<string, unknown> = {
      mode,
      // Selecting a climate mode means the device should actively reach it:
      // power on (real ACs wake on mode selection) so the physics effect
      // registers and the thermostat control loop engages.
      ...(mode === 'auto' ? {} : { power: true, status: 'on' }),
    };

    // Optional target temperature alongside the mode switch.
    const target = params.params?.target ??
                   params.params?.temperature ??
                   params.params?.targetTemperature;
    if (target !== undefined) {
      stateUpdate.targetTemperature = target;
    }

    this.log(`Climate mode set to ${mode} (device powered on)`);
    return stateUpdate;
  }
}
