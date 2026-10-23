/**
 * Display Content Command Handler (T-034, DevLoop R17)
 *
 * Effect model for display-family commands: the catalog advertises
 * show-message / show-content / display-message / set-message / set-content
 * / show-schedule / update-status on display panels, billboards and
 * variable-message signs — until now every one of them either dispatched to
 * no handler at all or hit GenericSetCommandHandler's no-op `set-*` branch,
 * so "switch displays to promo content" was inexpressible (RF-F07/SF-F10:
 * retail/security scenarios degraded to power toggles).
 *
 * The effect model is a device-state content field: `content` (the text or
 * payload being shown) + `contentUpdatedAt` (when it changed), rendered by
 * the console's generic device-state table. Parameter spellings follow the
 * standing dual-spelling precedent: content | message | text | value (and
 * schedule for show-schedule). update-status writes the panel's `status`.
 */

import { BaseCommandHandler, type CommandHandlerExecuteArgs } from './CommandHandler.js';

/** Content-bearing command names (normalized, `-`/`_` stripped). */
const CONTENT_COMMANDS = new Set([
  'setmessage',
  'setcontent',
  'showmessage',
  'showcontent',
  'displaymessage',
  'displaycontent',
  'showschedule',
  'updateschedule',
]);

/** The display panel's own status update. */
const STATUS_COMMANDS = new Set(['updatestatus']);

/** Extract the content payload from the accepted parameter spellings. */
function contentOf(params: Record<string, unknown> | undefined, command: string): string | undefined {
  const scheduleCommand = command === 'showschedule' || command === 'updateschedule';
  const candidates = scheduleCommand
    ? [params?.schedule, params?.content, params?.message, params?.text, params?.value]
    : [params?.content, params?.message, params?.text, params?.value];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
  }
  return undefined;
}

/**
 * Display content command handler (set-message / show-content /
 * display-message / show-schedule / update-status).
 */
export class DisplayContentCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    const normalized = this.normalizeCommand(commandName);
    return CONTENT_COMMANDS.has(normalized) || STATUS_COMMANDS.has(normalized);
  }

  execute(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>> {
    const command = this.normalizeCommand(params.commandName);

    if (STATUS_COMMANDS.has(command)) {
      const status = params.params?.status ?? params.params?.value;
      if (status === undefined) {
        throw new Error('update-status: missing parameter "status" (the state to display)');
      }
      this.log(`Display status → ${String(status)}`);
      return { status: typeof status === 'string' ? status : String(status) };
    }

    const content = contentOf(params.params, command);
    if (content === undefined) {
      throw new Error(
        `${params.commandName}: missing content — pass params {content} (accepted spellings: content, message, text${command === 'showschedule' || command === 'updateschedule' ? ', schedule' : ''}, value)`,
      );
    }

    const stateUpdate: Record<string, unknown> = {
      content,
      contentUpdatedAt: new Date().toISOString(),
    };
    // T-034 audit: who set the content, when the dispatch layer knows.
    // R17 params-purity: the actor rides the invocation context (execute-args
    // `actor`), NOT the command's semantic params.
    const actor = params.actor;
    if (typeof actor === 'string' && actor.length > 0) {
      stateUpdate.contentSetBy = actor;
    }
    this.log(`Display content set (${content.length} chars)`);
    return stateUpdate;
  }
}
