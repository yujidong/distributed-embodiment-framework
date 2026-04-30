/**
 * Command Handler Interface
 *
 * Follows Open/Closed Principle:
 * - Open for extension: Add new handlers for new command types
 * - Closed for modification: Don't modify existing handlers
 */


import { createLogger } from '@active-collaboration/shared';
/**
 * Command Handler Interface
 *
 * Each handler is responsible for processing a specific type of command
 * and returning the appropriate state updates.
 */
const logger = createLogger('CommandHandler');

export interface CommandHandler {
  /**
   * Check if this handler can process the command
   * @param commandName - Name of the command to check
   * @returns true if this handler can process the command
   */
  canHandle(commandName: string): boolean;

  /**
   * Execute the command and return state updates
   * @param params - Command parameters including commandName and currentState
   * @returns Partial state update object
   */
  execute(params: {
    commandName: string;
    params?: any;
    currentState: any;
    deviceType: string;
    deviceId: string;
  }): Partial<Record<string, unknown>>;
}

/**
 * Base command handler with common utilities
 */
export abstract class BaseCommandHandler implements CommandHandler {
  constructor(protected deviceId: string) {}

  abstract canHandle(commandName: string): boolean;
  abstract execute(params: {
    commandName: string;
    params?: any;
    currentState: any;
    deviceType: string;
    deviceId: string;
  }): Partial<Record<string, unknown>>;

  /**
   * Normalize command name for consistent matching
   * Removes hyphens and underscores
   */
  protected normalizeCommand(commandName: string): string {
    return commandName.toLowerCase().replace(/[-_]/g, '');
  }

  /**
   * Log command execution
   */
  protected log(message: string): void {
    logger.info(`[CommandHandler:${this.deviceId}] ${message}`);
  }
}
