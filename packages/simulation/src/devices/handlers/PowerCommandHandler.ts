/**
 * Power Command Handler
 *
 * Handles power control commands:
 * - turnOn, turnOff, setPower, toggle
 */

import { BaseCommandHandler } from './CommandHandler.js';

/**
 * Power Command Handler
 * Handles device power state commands
 */
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

    switch (cmd) {
      case 'turnon':
      case 'poweron':
        stateUpdate.power = true;
        stateUpdate.status = 'on';
        this.log(`Power ON command executed`);
        break;

      case 'turnoff':
      case 'poweroff':
        stateUpdate.power = false;
        stateUpdate.status = 'off';
        this.log(`Power OFF command executed`);
        break;

      case 'setpower':
        if (params.params?.power !== undefined) {
          stateUpdate.power = params.params.power === true;
          stateUpdate.status = params.params.power === true ? 'on' : 'off';
          this.log(`SetPower command executed: power=${stateUpdate.power}`);
        }
        break;

      case 'toggle':
        // Toggle based on current state
        if (params.currentState?.power !== undefined) {
          stateUpdate.power = !params.currentState.power;
          stateUpdate.status = stateUpdate.power ? 'on' : 'off';
          this.log(`Toggle command executed: power=${stateUpdate.power}`);
        }
        break;
    }

    return stateUpdate;
  }
}
