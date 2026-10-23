/**
 * Sprinkler Command Handler (R2-FEAT-11)
 *
 * The sprinkler device template (DeviceTemplateRegistry) declares
 * `set-spray-pattern`, but no handler claimed it specifically — the
 * GenericSetCommandHandler's claim-every-set-* fallback swallowed it, so
 * `{enable:true}` was routed into the battery-charging branch and wrote a
 * semantically wrong `charging` key while reporting success. This handler
 * claims the command ahead of the generic fallback and implements the ONE
 * parameter that actually takes effect: `{pattern}` → state key
 * `sprayPattern`. Any other param shape returns an empty update, so
 * SimulatedDevice's honest no-op failure fires and names the accepted
 * spelling from the COMMAND_PARAMETER_HINTS entry (same pattern as the
 * DisplayContentCommandHandler ahead of GenericSet).
 */

import { BaseCommandHandler, type CommandHandlerExecuteArgs } from './CommandHandler.js';

export class SprinklerCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    return this.normalizeCommand(commandName) === 'setspraypattern';
  }

  execute(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>> {
    const pattern = params.params?.pattern;
    if (typeof pattern === 'string' && pattern.length > 0) {
      this.log(`Setting sprayPattern=${pattern}`);
      return { sprayPattern: pattern };
    }
    // Unknown/absent param → empty update → the device-level no-op failure
    // teaches the accepted spelling instead of faking success.
    return {};
  }
}
