/**
 * Power Command Handler
 *
 * Handles power control commands:
 * - turnOn, turnOff, setPower, toggle
 *
 * TASK-001 (DevLoop): fixes fake-success and contradictory state —
 * - toggle on a fresh device (no `power` in state) defaults to ON
 * - set-power without the `power` param throws (missing-param error)
 * - every branch that writes `power` also writes `on` when the device
 *   tracks an `on` field, so {status, on, power} never disagree
 * - R13 (CB-F04): `powered` (a common initialState spelling) is synced the
 *   same way when tracked, so actuation never leaves it stale
 */

import { BaseCommandHandler } from './CommandHandler.js';

export class PowerCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    const normalized = this.normalizeCommand(commandName);
    return [
      'turnon',
      'turnoff',
      'setpower',
      'toggle',
      'poweron',
      'poweroff',
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
    // The device may spell its on/off field as `on` (light-style) or `power`
    // (plug-style). We write both when both are tracked.
    // R13 (CB-F04): `powered` (a common initialState key, e.g. the round-13
    // PA speaker carried {powered:false}) is a third tracked spelling —
    // actuation left it stale at false while power/status said on, giving
    // observability consumers two contradictory truths. Same rule: write it
    // when the device tracks it.
    const tracksOn = 'on' in params.currentState;
    const tracksPower = 'power' in params.currentState;
    const tracksPowered = 'powered' in params.currentState;

    const setPower = (value: boolean): void => {
      stateUpdate.power = value;
      stateUpdate.status = value ? 'on' : 'off';
      if (tracksOn || tracksPower) stateUpdate.on = value;
      if (tracksPowered) stateUpdate.powered = value;
    };

    switch (cmd) {
      case 'turnon':
      case 'poweron':
        setPower(true);
        this.log(`Power ON command executed`);
        break;

      case 'turnoff':
      case 'poweroff':
        setPower(false);
        this.log(`Power OFF command executed`);
        break;

      case 'setpower':
        if (params.params?.power === undefined) {
          throw new Error('set-power: missing required parameter "power" (expected true or false)');
        }
        setPower(params.params.power === true);
        this.log(`SetPower command executed: power=${stateUpdate.power}`);
        break;

      case 'toggle':
        // Toggle based on current state; a fresh device (no `power` yet)
        // defaults to OFF → toggles ON (TASK-001: was a silent no-op).
        const current =
          params.currentState?.power ?? params.currentState?.on ?? params.currentState?.powered ?? false;
        setPower(!current);
        this.log(`Toggle command executed: power=${stateUpdate.power}`);
        break;
    }

    return stateUpdate;
  }
}
