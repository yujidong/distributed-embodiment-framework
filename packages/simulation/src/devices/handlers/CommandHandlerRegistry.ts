/**
 * Command Handler Registry
 *
 * Manages command handlers and routes commands to appropriate handlers
 */

import { CommandHandler, type CommandHandlerExecuteArgs } from './CommandHandler.js';
import { PowerCommandHandler } from './PowerCommandHandler.js';
import { TemperatureCommandHandler } from './TemperatureCommandHandler.js';
import { ClimateModeCommandHandler } from './ClimateModeCommandHandler.js';
import { SimpleActionCommandHandler } from './SimpleActionCommandHandler.js';
import { DisplayContentCommandHandler } from './DisplayContentCommandHandler.js';
import { SprinklerCommandHandler } from './SprinklerCommandHandler.js';
import { GenericSetCommandHandler } from './GenericSetCommandHandler.js';
import { EmergencyBroadcastCommandHandler, VentilationCommandHandler } from './EmergencyStoryCommandHandler.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Command Handler Registry
 *
 * Manages command handlers and routes commands to appropriate handlers
 */
const logger = createLogger('CommandHandlerRegistry');

/**
 * T-056 (oracle-vs-dispatch parity): handlers registered at RUNTIME via
 * `registerHandler` on ANY registry instance — the ONE shared source the
 * executability oracle (capability-contract.isCapabilityExecutable) also
 * consults. Without it, a custom handler dispatched by a device's registry
 * would be invisible to validation: flows/invokes would 422 on commands the
 * runtime happily executes (or vice versa). Handlers are stateless (the
 * standing instance-sharing pattern), so sharing the objects is safe.
 */
const customCommandHandlers: CommandHandler[] = [];

/** Runtime-registered handlers, newest first (T-056 shared oracle source). */
export function registeredCustomCommandHandlers(): readonly CommandHandler[] {
  return customCommandHandlers;
}

/** Test-only: drop runtime-registered handlers so the canary stays isolated. */
export function _resetCustomCommandHandlersForTests(): void {
  customCommandHandlers.length = 0;
}

export class CommandHandlerRegistry {
  private handlers: CommandHandler[] = [];

  constructor(deviceId: string, deviceType: string) {
    // Register default handlers in priority order
    // More specific handlers should be registered first
    this.handlers = [
      new PowerCommandHandler(deviceId),
      new TemperatureCommandHandler(deviceId),
      new ClimateModeCommandHandler(deviceId),
      // R101: emergency-story actuation (ventilation / emergency-broadcast)
      // — specific capability-name commands, ahead of the verb/generic sets.
      new VentilationCommandHandler(deviceId),
      new EmergencyBroadcastCommandHandler(deviceId),
      new SimpleActionCommandHandler(deviceId),
      // T-034: display content/status commands — MUST precede GenericSet
      // (which would claim any set-* and no-op on set-message/set-content).
      new DisplayContentCommandHandler(deviceId),
      // R2-FEAT-11: sprinkler set-spray-pattern — MUST precede GenericSet
      // (whose charging branch would otherwise misreport {enable:true} as a
      // successful `charging` write on sprinklers).
      new SprinklerCommandHandler(deviceId),
      // GenericSetCommandHandler should be last as it's the most general
      new GenericSetCommandHandler(deviceId),
    ];
  }

  /**
   * Get handler for a command
   * Returns the first handler that can handle the command
   */
  getHandler(commandName: string): CommandHandler | undefined {
    return this.handlers.find(handler => handler.canHandle(commandName));
  }

  /**
   * Register a custom handler
   * Custom handlers are added at the beginning for higher priority.
   * T-056: the registration is ALSO recorded module-level so the
   * executability oracle sees the handler — dispatch and validation share
   * one contract; a new handler can never execute without oracle coverage.
   */
  registerHandler(handler: CommandHandler): void {
    this.handlers.unshift(handler);
    customCommandHandlers.unshift(handler);
  }

  /**
   * Get all registered handlers
   */
  getAllHandlers(): CommandHandler[] {
    return [...this.handlers];
  }

  /**
   * Process a command using registered handlers
   * @returns State updates from the command
   */
  processCommand(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>> {
    const handler = this.getHandler(params.commandName);

    if (handler) {
      return handler.execute(params);
    }

    logger.info(`No handler found for command: ${params.commandName}`);
    return {};
  }
}
