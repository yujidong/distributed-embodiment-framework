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
  execute(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>>;
}

/**
 * Who invoked the command — the invocation CONTEXT, not a command parameter
 * (R17 params-purity fix for the T-034×T-039 regression: the commands route
 * used to stamp the calling user into `params.actor`, which T-039 then carried
 * verbatim into timeline device-state records, breaking the T-019 replay
 * contract that `params` are the command's pure semantic arguments).
 * Attribution now rides this dedicated field end-to-end: route → runtime →
 * device → handler (audit fields: accessLog.by / lastActionBy / contentSetBy).
 */
export interface CommandInvocationContext {
  /** Display label of the acting principal (user displayName, agent label…). */
  actor?: string;
  /**
   * R102 (eval-chain-caliber): the injection event this command was
   * triggered by, when the caller knows it (AC execution lanes thread the
   * collaboration's triggerEventId). Stamped on DEVICE_OPERATION_EXECUTED
   * so the trajectory receipt attributes the execution to its decision
   * event — the inflight-window fallback ('unattributed') only applies
   * when no explicit id arrives.
   */
  eventId?: string;
}

/** Arguments passed to a command handler's execute (invocation context incl.). */
export interface CommandHandlerExecuteArgs {
  commandName: string;
  /** The command's pure semantic arguments (never identity/metadata). */
  params?: any;
  currentState: any;
  deviceType: string;
  deviceId: string;
  /** T-034 audit identity — invocation context, NOT part of `params`. */
  actor?: string;
  /**
   * T-706: the simulation clock's current time, when a device is attached
   * to a physical environment (grant expiry and other duration semantics
   * must live on SIM time, not wall time). Falls back to wall clock.
   */
  simNow?: Date;
}

/**
 * Base command handler with common utilities
 */
export abstract class BaseCommandHandler implements CommandHandler {
  constructor(protected deviceId: string) {}

  abstract canHandle(commandName: string): boolean;
  abstract execute(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>>;

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

/**
 * TASK-002 (DevLoop): common-sense aliases a new user would type first.
 * Applied in SimulatedDevice.executeCommand before the capability lookup,
 * after normalizeCommand. Keys are normalized (lowercase, no -/_).
 */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  'on': 'turn-on',
  'off': 'turn-off',
  'poweron': 'turn-on',
  'poweroff': 'turn-off',
  'switchon': 'turn-on',
  'switchoff': 'turn-off',
  'lighton': 'turn-on',
  'lightoff': 'turn-off',
  'power': 'toggle',
};

/** Resolve a user-typed command to its canonical handler name. */
export function resolveCommandAlias(commandName: string): string {
  const normalized = commandName.toLowerCase().replace(/[-_]/g, '');
  return COMMAND_ALIASES[normalized] ?? commandName;
}
