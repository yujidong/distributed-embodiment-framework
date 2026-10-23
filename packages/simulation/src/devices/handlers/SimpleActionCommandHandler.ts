/**
 * Simple Action Command Handler
 *
 * Handles the common binary/verb commands that device templates declare as
 * capabilities: open/close, lock/unlock, activate/deactivate, stop,
 * play-alert. "Declared = executable": each maps to a direct state update
 * (state properties are created dynamically, mirroring the mode handling in
 * GenericSetCommandHandler).
 *
 * T-034 (DevLoop R17): lock/unlock/grant-temporary-access are SECURE-STATE
 * commands, not plain verb toggles — they carry a who/when audit trail
 * (`accessLog` ring + lastLockTime/lastUnlockTime/lastActionBy, and
 * temporaryGrants for access grants), so a lockdown flow's effect is
 * inspectable on the device state instead of a bare `locked` bit. The actor
 * comes from the INVOCATION CONTEXT (execute-args `actor`, R17 params-purity
 * fix: the commands route passes the calling user there; flows/agents may
 * pass their own label the same way) — it is NOT a command param, so
 * `params` stays the command's pure semantic arguments; 'unknown' is the
 * honest default when the dispatch layer cannot attribute the command.
 */

import { BaseCommandHandler, type CommandHandlerExecuteArgs } from './CommandHandler.js';

/** Verb → state update mapping (single source for this handler). */
const SIMPLE_ACTION_STATE: Record<string, Record<string, unknown>> = {
  open: { open: true, closed: false },
  close: { open: false, closed: true },
  stop: { running: false, status: 'stopped' },
  activate: { active: true, status: 'active' },
  deactivate: { active: false, status: 'inactive' },
  playalert: { alert: true, playing: true },
};

/** Secure-state commands with who/when audit (T-034). */
const SECURE_ACTIONS = new Set(['lock', 'unlock', 'granttemporaryaccess']);

/** Bounded append: keep the newest `cap` entries (lessons.md T-011 cap discipline). */
function appendBounded<T>(existing: unknown, entry: T, cap: number): T[] {
  const list = Array.isArray(existing) ? [...(existing as T[])] : [];
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
  return list;
}

/**
 * The acting principal of a command, when the dispatch layer provided one.
 * R17 params-purity: read from the invocation context ONLY (`actor` on the
 * execute args) — never out of the command's semantic params.
 */
function actorOf(args: Pick<CommandHandlerExecuteArgs, 'actor'>): string {
  return typeof args.actor === 'string' && args.actor.length > 0 ? args.actor : 'unknown';
}

/** Descriptive label for one access-log entry. */
function logAction(action: string): string {
  if (action === 'granttemporaryaccess') return 'grant-temporary-access';
  return action;
}

/**
 * Simple action command handler (open/close/lock/unlock/activate/…)
 */
export class SimpleActionCommandHandler extends BaseCommandHandler {
  canHandle(commandName: string): boolean {
    const normalized = this.normalizeCommand(commandName);
    return normalized in SIMPLE_ACTION_STATE || SECURE_ACTIONS.has(normalized);
  }

  execute(params: CommandHandlerExecuteArgs): Partial<Record<string, unknown>> {
    const action = this.normalizeCommand(params.commandName);
    if (SECURE_ACTIONS.has(action)) {
      const stateUpdate = this.secureStateUpdate(action, params);
      this.log(`Secure action ${logAction(action)} by ${stateUpdate.lastActionBy ?? 'unknown'}`);
      return stateUpdate;
    }
    const stateUpdate = { ...SIMPLE_ACTION_STATE[action] };
    // T-408 (R19 NW-F02): lock-family devices keep the collapsed two-state
    // contract the seed vocabulary already assumes (zw-door-lock ships
    // initialState.locked) — close MEANS locked, open MEANS unlocked.
    // Without it a lockdown wrote {open:false, closed:true} and left the
    // seed's `locked:false` untouched — split-brain for anything watching
    // `locked` (snapshot evidence: {locked:false, open:false, closed:true}).
    if (typeof params.deviceType === 'string' && params.deviceType.toLowerCase().includes('lock')) {
      if (action === 'close') stateUpdate.locked = true;
      else if (action === 'open') stateUpdate.locked = false;
    }
    this.log(`Action ${action} → ${JSON.stringify(stateUpdate)}`);
    return stateUpdate;
  }

  /**
   * T-034 secure-state effect model: the locked/unlocked transition plus a
   * who/when audit ring (capped at 20 entries), the precise timestamps of
   * the last lock/unlock, and temporary-access grants as their own list.
   *
   * T-706 (F-PH16): grant-temporary-access accepts `durationMin` (minutes,
   * the command vocabulary's canonical spelling) and `durationSec`. The
   * grant stores `durationSec` plus `expiresAt` on the SIM clock (args
   * .simNow — the device's TimeManager, which the runtime advances with
   * sim time; wall-clock fallback when no environment is attached).
   * SimulatedDevice.enforceGrantExpiry relocks the lock and stamps an
   * `auto-relock` accessLog entry once `expiresAt` passes.
   */
  private secureStateUpdate(
    action: string,
    args: Pick<CommandHandlerExecuteArgs, 'params' | 'currentState' | 'actor' | 'simNow'>,
  ): Record<string, unknown> {
    const at = new Date().toISOString();
    const by = actorOf(args);
    const commandParams = (args.params ?? {}) as Record<string, unknown>;

    if (action === 'granttemporaryaccess') {
      // durationMin (minutes) is the primary spelling; durationSec wins only
      // when no durationMin was given. A grant without a duration never
      // expires (manual relock required) — unchanged legacy semantics.
      const durationMin = commandParams.durationMin;
      const durationSec = typeof durationMin === 'number' && Number.isFinite(durationMin) && durationMin > 0
        ? durationMin * 60
        : (typeof commandParams.durationSec === 'number' && Number.isFinite(commandParams.durationSec)
            ? commandParams.durationSec
            : undefined);
      const now = args.simNow ?? new Date();
      const grant = {
        ...(typeof commandParams.to === 'string' && commandParams.to.length > 0
          ? { to: commandParams.to }
          : {}),
        ...(durationSec !== undefined && durationSec > 0
          ? {
              durationSec,
              expiresAt: new Date(now.getTime() + durationSec * 1000).toISOString(),
            }
          : {}),
        grantedAt: at,
        by,
      };
      return {
        temporaryGrants: appendBounded(args.currentState?.temporaryGrants, grant, 10),
        lastActionBy: by,
        accessLog: appendBounded(
          args.currentState?.accessLog,
          { action: logAction(action), at, by },
          20,
        ),
      };
    }

    return {
      locked: action === 'lock',
      ...(action === 'lock'
        ? { lastLockTime: at }
        : { lastUnlockTime: at }),
      lastActionBy: by,
      accessLog: appendBounded(
        args.currentState?.accessLog,
        { action: logAction(action), at, by },
        20,
      ),
    };
  }
}
