/**
 * Agreement trigger-clause auto-execution (T-035, DevLoop R17; SF-F03)
 * + the auto-reset clause (T-070, DevLoop R22; FM-F05 terms half).
 *
 * An active agreement's structured `terms.trigger` (Wave-4a sub-shape:
 * {eventType?, parameter?, threshold?, zoneId?} — "when <eventType> raises
 * <parameter> past <threshold> in <zoneId>") was contract data only: R12
 * verified nothing ever executed it, so consumers had to invoke manually
 * and "active agreement" did not deliver the promised automation.
 *
 * This module subscribes every environment-backed simulation's injected
 * events (EngineRuntime.onInjectedEvent — the only injection history
 * surface, the sim-event-tally pattern) and, when an injection matches an
 * ACTIVE agreement's trigger, executes the negotiated terms.action through
 * the SAME invocation core as manual invokes (executeAgreementInvocation):
 * metered UsageRecord, settlement receipt, terms-constrained, device-gated,
 * command_log audit attributed to the agreement + the triggering event.
 *
 * T-070 auto-reset: an event-armed actuation used to peg a device
 * indefinitely (the night's floodlight stuck at 100% brightness). When the
 * same terms carry `autoReset` {afterSec | onEvent, action}, a SUCCESSFUL
 * trigger-driven invocation arms ONE pending reset for the agreement:
 * - afterSec: a SIM-time deadline on the armed runtime (afterSec counts
 *   simulated seconds — a simulated night). Enforcement is event-driven
 *   (checked on every injection) PLUS a light wall-clock recheck loop
 *   (250ms while any reset is pending), so a quiet world still resets and
 *   catch-up fast-forwards are honored.
 * - onEvent: the reset fires on the next injected event matching the
 *   clause (e.g. an all-clear event).
 * First-to-fire wins; a NEW trigger fire re-arms (replaces) the pending
 * reset — the countdown restarts. At fire time the agreement row is
 * re-read: suspended/terminated agreements never reset (the arm drops,
 * unmetered). The reset invocation runs through the SAME metered core
 * (usage + receipt + command_log with an `autoReset` marker); it is NOT
 * quota-gated (un-pegging a device is part of the triggering automation,
 * not a new consumer request) but its usage rows count toward future
 * windows like any successful invoke — metered as part of the agreement.
 *
 * Scope (deliberate): event-condition triggers only — no schedules, no
 * re-arm windows beyond the arm-per-fire rule. Pending resets are
 * in-memory (a server restart drops arms; the next trigger re-arms —
 * worlds with trigger+action terms never hibernate, design §5, so the
 * authoritative session is always there to re-arm).
 */

import { type EngineRuntime, type InjectedEventRecord } from '@active-collaboration/core';
import { createLogger } from '@active-collaboration/shared';

import {
  consumptionQuotaStatus,
  executeAgreementInvocation,
  type AgreementInvocationActor,
  type AgreementRoutesContext,
} from './agreements/index.js';
import { contentionsOf } from './agreements/contentions.js';
import { parseTerms, type AgreementRow, type AgreementTerms, type AgreementTrigger } from './db/agreement-store.js';

const logger = createLogger('AgreementTriggerExecutor');

/** Wall cadence of the pending-reset recheck loop (only runs while armed). */
const PENDING_RESET_RECHECK_MS = 250;

/** Does one injected event satisfy one trigger clause? (all given fields must match) */
export function triggerMatches(
  trigger: AgreementTrigger,
  record: InjectedEventRecord,
): boolean {
  if (trigger.eventType !== undefined && trigger.eventType !== record.type) return false;
  if (trigger.zoneId !== undefined && trigger.zoneId !== record.zoneId) return false;
  if (trigger.parameter !== undefined && trigger.parameter !== record.parameter) return false;
  if (trigger.threshold !== undefined) {
    // Threshold semantics: the injection RAISED the parameter to a value at
    // or past the threshold (the post-injection world value). A threshold
    // on a non-numeric injection is not evaluable — no match (honest skip).
    if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return false;
    if (record.value < trigger.threshold) return false;
  }
  return true;
}

/** One armed auto-reset (T-070) — at most one per agreement, replaced on re-trigger. */
interface PendingReset {
  agreementId: string;
  /** The runtime the trigger invocation armed (its sim clock is the deadline's clock). */
  runtime: EngineRuntime;
  simulationId: string;
  /** afterSec mode: sim-time deadline; undefined for onEvent-only arms. */
  dueSimSec?: number;
  /** onEvent mode: the matching clause (empty-object clause matches ANY event). */
  onEvent?: AgreementTrigger;
  /** Attribution: the event whose trigger invocation armed this reset. */
  armedBy: { eventId: string; eventType: string; zoneId?: string };
}

/**
 * T-505 (CB24-F02): the observable view of one pending arm — what the
 * agreement serializer surfaces on `GET /api/agreements/:id` (same
 * visibility as the agreement itself: both parties + env owner). The arm is
 * RUNTIME state: the field is absent when nothing is armed and vanishes
 * with the sim (an honest reflection, not a persistence gap).
 */
export interface ArmedResetView {
  /** The negotiated reset command (resolved from the live terms row). */
  command: string;
  params?: Record<string, unknown>;
  /** afterSec arms only: the sim-time deadline on the armed runtime's clock. */
  dueSimSec?: number;
  /** onEvent arms only: the clause the next injected event must match. */
  onEvent?: AgreementTrigger;
  /** Attribution: the injected event whose trigger invocation armed this. */
  armedByEventId: string;
  armedByEventType: string;
}

export class AgreementTriggerExecutor {
  private readonly pending = new Map<string, PendingReset>();
  /**
   * FEAT-08: runtime → owning SimulationRecord id (attach-time). Env-backed
   * runtimes carry the ENV id as runtime.id, so the usage attribution must
   * come from the attach seam; legacy direct-attach callers fall back to
   * runtime.id.
   */
  private readonly simIds = new WeakMap<EngineRuntime, string>();
  private recheckTimer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: AgreementRoutesContext) {}

  /**
   * Registry creation hook (the agreementBridge/eventTally pattern):
   * subscribe every environment-backed simulation's injected events.
   */
  attach(environmentId: string, runtime: EngineRuntime, simulationId?: string): void {
    if (simulationId !== undefined) this.simIds.set(runtime, simulationId);
    runtime.onInjectedEvent(record => {
      this.evaluate(environmentId, runtime, record).catch(error => {
        // The listener is fire-and-forget — an evaluation failure must
        // never break the injection that triggered it.
        logger.warn(
          `trigger evaluation failed for env ${environmentId} event ${record.type}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  /** The SimulationRecord id for usage attribution (FEAT-08 fallback noted above). */
  private simIdOf(runtime: EngineRuntime): string {
    return this.simIds.get(runtime) ?? runtime.id;
  }

  private async evaluate(
    environmentId: string,
    runtime: EngineRuntime,
    record: InjectedEventRecord,
  ): Promise<void> {
    // Fresh rows per event: status is re-read at fire time, so
    // suspended/terminated agreements never auto-execute. D3 (T-080): a
    // HELD agreement is equally excluded — and an EXPIRED hold is lazily
    // settled HERE (the standing-asks pattern), so a quiet world whose only
    // reader is the trigger executor still un-holds on time.
    const candidates = this.ctx.agreementStore
      .agreementsOfEnv(environmentId)
      .map(row => this.ctx.agreementStore.settleExpiredHold(row))
      .filter(row => row.status === 'active')
      .map(row => ({ row, terms: parseTerms(row.terms_json) }))
      .filter(({ terms }) => terms.trigger !== undefined && terms.action !== undefined);

    // T-070 onEvent resets FIRST (an all-clear event both resets the armed
    // device and may re-trigger another agreement — order stays honest:
    // the reset applies to what was armed before this event).
    for (const [agreementId, arm] of this.pending) {
      if (arm.runtime !== runtime || arm.onEvent === undefined) continue;
      if (!triggerMatches(arm.onEvent, record)) continue;
      this.pending.delete(agreementId);
      await this.fireReset(agreementId, arm);
    }

    for (const { row, terms } of candidates) {
      if (!triggerMatches(terms.trigger!, record)) continue;
      await this.fire(row, terms, runtime, record);
    }
  }

  /**
   * C3 (R25-NF4): the metered trigger-skip row — outcome='failure' +
   * failure_reason on the append-only ledger the consumer reads
   * (GET /api/agreements/:id/usage). The unit follows the agreement's
   * service lane ('flow-run' for flow-services, 'action' otherwise), with
   * terms.meteringUnit as the negotiated override, so the row reads like
   * every other metered invoke of the same contract.
   */
  private meterSkippedTrigger(
    agreement: AgreementRow,
    terms: AgreementTerms,
    action: string,
    reason: string,
    simulationId: string,
  ): void {
    try {
      const service = agreement.service_id !== null
        ? this.ctx.serviceStore.getService(agreement.service_id)
        : undefined;
      const at = new Date().toISOString();
      this.ctx.agreementStore.appendUsage({
        agreementId: agreement.id,
        envId: agreement.env_id,
        consumerAgentId: agreement.consumer_agent_id,
        providerAgentId: agreement.provider_agent_id,
        kind: 'invoke',
        action,
        quantity: 1,
        // UX-05: the agreed metering unit overrides the lane default —
        // same pattern as the invoke core (invoke-lane.ts).
        unit: terms.meteringUnit ?? (service?.origin === 'flow' ? 'flow-run' : 'action'),
        outcome: 'failure',
        effectRef: null,
        failureReason: reason,
        origin: service?.origin ?? null,
        // FEAT-08/UX-04: the skip row carries the same attribution the
        // executed auto-invoke would — the sim it fired in, source
        // 'autoTrigger' (the quota-spent refusal IS the trigger lane).
        simulationId,
        source: 'autoTrigger',
        startedAt: at,
        endedAt: at,
      });
    } catch (error) {
      // Metering must never break the evaluation loop.
      logger.warn(
        `failed to meter the skipped trigger of agreement ${agreement.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async fire(
    agreement: AgreementRow,
    terms: NonNullable<ReturnType<typeof parseTerms>>,
    runtime: EngineRuntime,
    record: InjectedEventRecord,
  ): Promise<void> {
    const action = terms.action!;
    const trigger = terms.trigger!;

    // Quota policy — identical to the manual pre-execution 429: a spent
    // window skips the auto-invoke. Failures and successes below ARE
    // metered by the shared core.
    // C3 (R25-NF4, DevLoop R28): the skip itself is now METERED as an
    // outcome='failure' usage row carrying the reason — before, a trigger
    // that "fired but nothing happened" left the consumer with a server
    // log line they cannot read and no trace in their own ledger. Quota
    // stays intact: countUsageSince counts outcome='success' only. The gate
    // is the shared consumptionQuotaStatus — same window math as the manual
    // lane, by construction.
    const quota = consumptionQuotaStatus(terms, agreement, since =>
      this.ctx.agreementStore.countUsageSince(agreement.id, since),
    );
    if (quota !== null && quota.spent) {
      logger.warn(
        `agreement ${agreement.id} trigger matched (${record.type}@${record.zoneId}) but the ` +
          `quota window is spent (${quota.current}/${quota.limit}) — auto-invoke skipped`,
      );
      this.meterSkippedTrigger(agreement, terms, action.command,
        `quota window spent (${quota.current}/${quota.limit} in the ` +
          `${terms.windowSec as number}s window) — trigger auto-invoke skipped; the window passes before the next fire can meter a success`,
        this.simIdOf(runtime));
      return;
    }

    logger.info(
      `agreement ${agreement.id} trigger matched (${record.type}@${record.zoneId}) — ` +
        `auto-invoking agreed action "${action.command}"`,
    );
    // D1 (T-085, R28): the fire-time contention marks — other ACTIVE
    // agreements whose trigger automation writes the same (deviceId, param).
    // Last-writer-wins stays (deterministic, auditable); the marks ride the
    // command_log payload so the race is visible in the audit trail, with
    // BOTH agreementIds on the row.
    const contentionWith = contentionsOf(this.ctx, agreement)
      .map(({ agreementId, deviceId, param }) => ({ agreementId, deviceId, param }));
    if (contentionWith.length > 0) {
      logger.warn(
        `agreement ${agreement.id} auto-invoke CONTENDED — other active agreement(s) ` +
          contentionWith.map(mark => `${mark.agreementId} (${mark.deviceId}.${mark.param})`).join(', ') +
          ' target the same device-param pair; last writer wins',
      );
    }
    try {
      const outcome = await executeAgreementInvocation(this.ctx, {
        agreement,
        terms,
        runtime,
        simulationId: this.simIdOf(runtime),
        action: action.command,
        ...(action.params !== undefined ? { params: action.params } : {}),
        ...(contentionWith.length > 0 ? { contentionWith } : {}),
        actor: {
          autoTrigger: {
            eventId: `<injected:${record.type}:${record.zoneId}>`,
            eventType: record.type,
            ...(record.zoneId !== undefined ? { zoneId: record.zoneId } : {}),
          },
        },
      });
      if (outcome.success) {
        logger.info(`agreement ${agreement.id} auto-invoke succeeded (${action.command})`);
        // T-070: a successful trigger-driven invocation of the agreed
        // action ARMS the negotiated reset (if any). Replacing an existing
        // arm is the honest semantics — the device was re-actuated, the
        // countdown restarts, and the new arm wins.
        if (terms.autoReset !== undefined) {
          this.armReset(agreement.id, terms.autoReset, runtime, {
            eventId: `<injected:${record.type}:${record.zoneId}>`,
            eventType: record.type,
            ...(record.zoneId !== undefined ? { zoneId: record.zoneId } : {}),
          });
        }
      } else {
        logger.warn(
          `agreement ${agreement.id} auto-invoke failed (${action.command}): ${outcome.error}`,
        );
      }
    } catch (error) {
      // Refusals (device absent in this sim, not executable, …) are honest
      // outcomes of the shared path — logged, never propagated.
      logger.warn(
        `agreement ${agreement.id} auto-invoke refused: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // T-070: the auto-reset machinery
  // ---------------------------------------------------------------------------

  private armReset(
    agreementId: string,
    autoReset: NonNullable<NonNullable<ReturnType<typeof parseTerms>>['autoReset']>,
    runtime: EngineRuntime,
    armedBy: PendingReset['armedBy'],
  ): void {
    this.pending.set(agreementId, {
      agreementId,
      runtime,
      simulationId: this.simIdOf(runtime),
      ...(autoReset.afterSec !== undefined
        ? { dueSimSec: runtime.getSimTimeSec() + autoReset.afterSec }
        : {}),
      ...(autoReset.onEvent !== undefined ? { onEvent: autoReset.onEvent } : {}),
      armedBy,
    });
    this.ensureRecheckLoop();
    logger.info(
      `agreement ${agreementId} auto-reset armed (${autoReset.action.command}` +
      `${autoReset.afterSec !== undefined ? ` after ${autoReset.afterSec}s sim-time` : ''}` +
      `${autoReset.onEvent !== undefined ? ` on ${autoReset.onEvent.eventType ?? 'any event'}` : ''})`,
    );
  }

  /**
   * T-505 (CB24-F02): the observable view of a pending auto-reset arm.
   * Undefined when nothing is armed (the honest "absent field = nothing
   * armed"); the command/params resolve from the LIVE terms row so a
   * re-negotiated clause can never show stale reset data.
   */
  armedResetOf(agreementId: string): ArmedResetView | undefined {
    const arm = this.pending.get(agreementId);
    if (arm === undefined) return undefined;
    const row = this.ctx.agreementStore.getAgreement(agreementId);
    if (row === undefined || row.status !== 'active') return undefined;
    const reset = parseTerms(row.terms_json).autoReset;
    if (reset === undefined) return undefined;
    return {
      command: reset.action.command,
      ...(reset.action.params !== undefined ? { params: reset.action.params } : {}),
      ...(arm.dueSimSec !== undefined ? { dueSimSec: arm.dueSimSec } : {}),
      ...(arm.onEvent !== undefined ? { onEvent: arm.onEvent } : {}),
      armedByEventId: arm.armedBy.eventId,
      armedByEventType: arm.armedBy.eventType,
    };
  }

  /**
   * The light wall-clock recheck (only while resets are pending): fires
   * afterSec arms whose sim deadline has passed. The loop exits when the
   * ledger empties — no idle cost for worlds without armed resets.
   */
  private ensureRecheckLoop(): void {
    if (this.recheckTimer !== undefined) return;
    const tick = (): void => {
      this.recheckTimer = undefined;
      if (this.pending.size === 0) return;
      const due: Array<[string, PendingReset]> = [];
      for (const [agreementId, arm] of this.pending) {
        if (arm.dueSimSec === undefined) continue; // onEvent-only arm
        const runtime = arm.runtime;
        if (runtime.getState() === 'stopped') {
          // The armed sim is gone (stopped/removed) — the deadline's clock
          // no longer exists; drop the arm (the next trigger re-arms on a
          // live runtime).
          this.pending.delete(agreementId);
          logger.info(`agreement ${agreementId} auto-reset dropped — armed simulation stopped`);
          continue;
        }
        if (runtime.getSimTimeSec() >= arm.dueSimSec) due.push([agreementId, arm]);
      }
      for (const [agreementId, arm] of due) {
        this.pending.delete(agreementId);
        void this.fireReset(agreementId, arm).catch(error => {
          logger.warn(
            `auto-reset for agreement ${agreementId} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (this.pending.size > 0) this.ensureRecheckLoop();
    };
    this.recheckTimer = setTimeout(tick, PENDING_RESET_RECHECK_MS);
    this.recheckTimer.unref();
  }

  /**
   * Execute one armed reset through the SAME metered invocation core.
   * Status is re-read at fire time — a suspended/terminated agreement (or
   * one whose terms dropped the clause) never resets: the arm drops
   * silently, unmetered.
   */
  private async fireReset(agreementId: string, arm: PendingReset): Promise<void> {
    const row = this.ctx.agreementStore.getAgreement(agreementId);
    if (row === undefined || row.status !== 'active') {
      logger.info(
        `agreement ${agreementId} auto-reset skipped — agreement is ` +
        `${row === undefined ? 'gone' : row.status} at fire time`,
      );
      return;
    }
    const terms = parseTerms(row.terms_json);
    const reset = terms.autoReset;
    if (reset === undefined) {
      logger.info(`agreement ${agreementId} auto-reset skipped — terms no longer carry the clause`);
      return;
    }
    if (arm.runtime.getState() === 'stopped') {
      logger.info(`agreement ${agreementId} auto-reset skipped — armed simulation stopped`);
      return;
    }
    logger.info(
      `agreement ${agreementId} auto-reset firing (${reset.action.command}) — ` +
      `un-pegging the device armed by ${arm.armedBy.eventType}`,
    );
    try {
      const outcome = await executeAgreementInvocation(this.ctx, {
        agreement: row,
        terms,
        runtime: arm.runtime,
        simulationId: arm.simulationId,
        action: reset.action.command,
        ...(reset.action.params !== undefined ? { params: reset.action.params } : {}),
        actor: this.resetActor(arm),
      });
      if (outcome.success) {
        logger.info(`agreement ${agreementId} auto-reset succeeded (${reset.action.command})`);
      } else {
        logger.warn(
          `agreement ${agreementId} auto-reset failed (${reset.action.command}): ${outcome.error}`,
        );
      }
    } catch (error) {
      // Same honesty as the trigger fire: refusals are logged outcomes.
      logger.warn(
        `agreement ${agreementId} auto-reset refused: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resetActor(arm: PendingReset): AgreementInvocationActor {
    return {
      autoReset: {
        armedByEventId: arm.armedBy.eventId,
        armedByEventType: arm.armedBy.eventType,
        ...(arm.armedBy.zoneId !== undefined ? { zoneId: arm.armedBy.zoneId } : {}),
      },
    };
  }
}
