/**
 * Emergency-story command handlers (R101 P0, chen-15): `ventilation` and
 * `emergency-broadcast` — the two actuation capabilities devices really
 * declare (fresh-air units, PA speakers) that dispatched to NOTHING
 * ("no handler / no effect"), the third recurrence of the
 * capability→handler gap (wang-03 → R100-signing-gate → here). The T-056
 * "dead marketing name" stance is deliberately superseded for these two:
 * they are the emergency narrative's key actions — trimming the
 * declarations would gut the story, so the handlers now exist.
 */

import { BaseCommandHandler, type CommandHandlerExecuteArgs } from './CommandHandler.js';

/**
 * `ventilation` — start air exchange. The state marks the unit as actively
 * ventilating; the PHYSICAL effect (T-707 `air_flow`: zone CO2 decays
 * toward outdoor ppm while the unit runs, plus mild humidity relief) is
 * registered by SimulatedDevice.createPhysicsEffect for this command, and
 * `turn-off` unregisters it through the standard effect-disable path.
 */
export class VentilationCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    return this.normalizeCommand(commandName) === 'ventilation';
  }

  execute(_params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>> {
    this.log('Ventilation started (air exchange)');
    return { power: true, status: 'on', mode: 'ventilation' };
  }
}

/**
 * `emergency-broadcast` — raise an alert on this device. The state
 * transition IS the effect: the attached EventManager publishes the
 * alert as a device state change on the environment bus, so agents in
 * the zone are notified. Accepts an optional `message` param (recorded
 * on the device for audit); `stop` / `turn-off` clears the alert.
 */
export class EmergencyBroadcastCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    return this.normalizeCommand(commandName) === 'emergencybroadcast';
  }

  execute(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>> {
    const message = typeof (params.params as Record<string, unknown> | undefined)?.message === 'string'
      ? (params.params as Record<string, unknown>).message as string
      : undefined;
    const at = (params.simNow ?? new Date()).toISOString();
    const by = typeof params.actor === 'string' && params.actor.length > 0 ? params.actor : 'unknown';
    this.log(`Emergency broadcast raised${message !== undefined ? `: ${message}` : ''}`);
    return {
      alert: true,
      broadcasting: true,
      power: true,
      status: 'on',
      lastBroadcast: {
        ...(message !== undefined ? { message } : {}),
        at,
        by,
      },
    };
  }
}
