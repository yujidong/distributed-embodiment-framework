/**
 * Command Handler Registry
 *
 * Manages command handlers and routes commands to appropriate handlers
 */

import { CommandHandler } from './CommandHandler.js';
import { PowerCommandHandler } from './PowerCommandHandler.js';
import { TemperatureCommandHandler } from './TemperatureCommandHandler.js';
import { GenericSetCommandHandler } from './GenericSetCommandHandler.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Command Handler Registry
 *
 * Manages command handlers and routes commands to appropriate handlers
 */
const logger = createLogger('CommandHandlerRegistry');

export class CommandHandlerRegistry {
  private handlers: CommandHandler[] = [];

  constructor(deviceId: string, deviceType: string) {
    // Register default handlers in priority order
    // More specific handlers should be registered first
    this.handlers = [
      new PowerCommandHandler(deviceId),
      new TemperatureCommandHandler(deviceId),
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
   * Custom handlers are added at the beginning for higher priority
   */
  registerHandler(handler: CommandHandler): void {
    this.handlers.unshift(handler);
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
  processCommand(params: {
    commandName: string;
    params?: any;
    currentState: any;
    deviceType: string;
    deviceId: string;
  }): Partial<Record<string, unknown>> {
    const handler = this.getHandler(params.commandName);

    if (handler) {
      return handler.execute(params);
    }

    logger.info(`No handler found for command: ${params.commandName}`);
    return {};
  }
}
