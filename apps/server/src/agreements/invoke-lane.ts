/**
 * Agreements service layer — the invocation execution core (R21-W1
 * extraction from routes/agreements.ts, pure move).
 *
 * T-035 (DevLoop R17): everything past auth/targeting/quota that makes an
 * invocation REAL — backing-device resolution, terms.action enforcement
 * (T-205), the device-executable gate (T-303), synchronous execution through
 * the provider agent's own device, command_log audit, usage metering,
 * reputation scoring, settlement receipts and the env-stream announcement.
 *
 * Two callers run the EXACT same path so their metering/attribution can
 * never drift:
 * - the manual route (consumer POST /api/agreements/:id/invocations), and
 * - the agreement-trigger executor (agreement-trigger-executor.ts), which
 *   auto-executes terms.action when an active agreement's terms.trigger
 *   matches an injected event (SF-F03: "active agreement" finally delivers
 *   the promised automation, attributed to the agreement).
 */

import {
  multiCommandNamesForDeviceType,
  resolveFlowRunParams,
} from '@active-collaboration/core';
import { deviceExecutableCommandNames, validateCommandParams } from '@active-collaboration/simulation';
import type { UiLocale } from '@active-collaboration/shared';

import type { AgreementRoutesContext } from './context.js';
import { resolveBackingDeviceForAction } from './backing.js';
import {
  type AgreementRow,
  type AgreementTerms,
  type UsageRecordRow,
  type UsageSource,
} from '../db/agreement-store.js';
import { parseJsonArray } from '../db/environment-store.js';
import { flowRowToDefinition, type FlowRow } from '../db/flow-store.js';
import type { ServiceInstanceRow } from '../db/service-store.js';
import { ApiError } from '../errors.js';
import { t } from '../i18n/index.js';
import { NOTIFICATION_KINDS, notify } from '../notifications.js';
import type { SimulationRecord } from '../simulation-registry.js';

export interface AgreementInvocationActor {
  /** Manual invokes: the consuming user (command_log actor + notifications). */
  userId?: string;
  /** Locale for notification text (manual: request locale; auto: default). */
  locale?: UiLocale;
  /** T-035: present when an injected event fired the agreement's trigger. */
  autoTrigger?: { eventId: string; eventType: string; zoneId?: string };
  /**
   * T-070: present when this invocation IS the auto-reset — the trigger
   * automation's scheduled/evented revert of its own actuation. The reset
   * rides the SAME metered path (usage row + receipt + command_log) and is
   * exempt from the terms.ACTION allowance (it enforces the negotiated
   * terms.autoReset.action clause instead — the provider accepted that
   * clause by accepting the terms).
   */
  autoReset?: {
    /** The event whose trigger invocation armed this reset. */
    armedByEventType: string;
    armedByEventId: string;
    zoneId?: string;
  };
}

export interface AgreementInvocationOutcome {
  success: boolean;
  result?: unknown;
  error?: string;
  /** Device invokes: the commanded device. Flow-service invokes: null. */
  deviceId: string | null;
  effectiveParams: Record<string, unknown>;
  termsEnforced: boolean;
  usage: UsageRecordRow;
  receiptId: string | null;
  /**
   * Mechanism D: present on flow-service invokes — the delivered flow run
   * (runId chains to the flow_runs ledger via the UsageRecord's effectRef).
   * FEAT-06: 'waiting' is a real terminal-for-now state (wait nodes pause
   * the DAG) — the wire type admits it; the success/metering semantics
   * above (status==='success' only) are unchanged.
   */
  flowRun?: {
    flowId: string;
    runId: string;
    status: 'success' | 'partial' | 'failed' | 'waiting';
    triggerKind: string;
    inputs: Record<string, unknown> | undefined;
    nodeResults: Record<string, unknown>;
  };
}

/**
 * UX-04 (v67): the usage row's source dimension from the invocation actor —
 * a reset actor outranks a trigger actor (a reset IS the trigger
 * automation's un-peg, never a fresh fire), anything else is the manual
 * lane. FEAT-08 (v66): the simulation id rides alongside (the invoke
 * core's target sim).
 */
export function usageSourceOfActor(actor: AgreementInvocationActor): UsageSource {
  return actor.autoReset !== undefined ? 'autoReset' : actor.autoTrigger !== undefined ? 'autoTrigger' : 'manual';
}

/**
 * C3 (R25-NF4, DevLoop R28): the metered refusal row — an invocation that
 * never reached execution still lands in the append-only ledger with
 * outcome='failure' AND the reason. The trigger lane (agreement-trigger-
 * executor) swallows the thrown ApiError into a log line the consumer
 * cannot read; the usage row is the observable surface they DO read
 * (GET /api/agreements/:id/usage), so the cause rides it. Quota semantics
 * unchanged: countUsageSince counts outcome='success' only.
 */
function appendRefusalUsage(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  action: string,
  unit: 'action' | 'flow-run',
  reason: string,
  attribution: { simulationId: string; source: UsageSource },
): void {
  const refusedAt = new Date().toISOString();
  ctx.agreementStore.appendUsage({
    agreementId: agreement.id,
    envId: agreement.env_id,
    consumerAgentId: agreement.consumer_agent_id,
    providerAgentId: agreement.provider_agent_id,
    kind: 'invoke',
    action,
    quantity: 1,
    unit,
    outcome: 'failure',
    effectRef: null,
    failureReason: reason,
    // v58: the origin dimension rides every metered row (snapshot of the
    // hit service's service_instances.origin; null when the row is gone).
    origin: (agreement.service_id !== null ? ctx.serviceStore.getService(agreement.service_id) : undefined)?.origin ?? null,
    simulationId: attribution.simulationId,
    source: attribution.source,
    startedAt: refusedAt,
    endedAt: refusedAt,
  });
}

/**
 * T-109: consumer-side probing errors (vocabulary/capability probes) never
 * count against the provider — neither in reputation nor in the provider
 * notification lane.
 */
function isConsumerProbingError(error: string | undefined): boolean {
  return error !== undefined &&
    /not found|missing required parameter|does not have capability/i.test(error);
}

/**
 * R101 (trust-visibility, zhao-17): score ONE metered invoke outcome for an
 * EXPLICIT agreement — success and failure both count attempts/successes
 * (the design's Phase-2 promise "invoke 失败记提供方 failure" was never
 * wired for the explicit lane; the PM's round-4 ruling extends it to
 * successes). AC-sourced agreements are SKIPPED: the runtime's Fix-12
 * reputation pipeline covers AC (scoring here too would double-count).
 */
function scoreExplicitInvokeOutcome(
  ctx: AgreementRoutesContext,
  agreement: AgreementRow,
  success: boolean,
  error?: string,
): void {
  if (agreement.source === 'ac') return;
  if (!success && isConsumerProbingError(error)) return;
  const service = agreement.service_id !== null
    ? ctx.serviceStore.getService(agreement.service_id)
    : undefined;
  if (service === undefined || agreement.provider_agent_id === null) return;
  ctx.reputationStore.recordOutcome(
    agreement.env_id,
    agreement.provider_agent_id,
    service.semantic_type,
    success,
  );
}

export async function executeAgreementInvocation(
  ctx: AgreementRoutesContext,
  opts: {
    agreement: AgreementRow;
    terms: AgreementTerms;
    runtime: SimulationRecord['runtime'];
    simulationId: string;
    action: string;
    params?: Record<string, unknown>;
    actor: AgreementInvocationActor;
    /**
     * D1 (T-085, R28): the contended pairs computed by the trigger executor
     * at fire time — OTHER active agreements whose automation writes the
     * same (deviceId, param). Rides the command_log payload (both
     * agreementIds visible: this row's own agreementId + each mark's).
     * Manual invokes leave it unset (the consumer chose to act with the
     * contention already warned at accept/detail).
     */
    contentionWith?: Array<{ agreementId: string; deviceId: string; param: string }>;
  },
): Promise<AgreementInvocationOutcome> {
  // Mechanism D (design §5.1): an origin='flow' service invokes a FLOW RUN in
  // the provider's context, not a device command — the T-201 flow-author
  // scoping (resolveFlowAssignments) is the entire security model, and the
  // SAME metering/receipt/attribution tail applies (unit 'flow-run',
  // effectRef = the run id). Branch before any device resolution.
  const flowService = opts.agreement.service_id !== null
    ? ctx.serviceStore.getService(opts.agreement.service_id)
    : undefined;
  if (flowService !== undefined && flowService.origin === 'flow' && flowService.source_flow_id !== null) {
    return executeFlowAgreementInvocation(ctx, opts, flowService);
  }
  const { agreement, terms, runtime, action, actor } = opts;
  const deviceId = resolveBackingDeviceForAction(ctx, agreement, action);
  const deviceState = (): Record<string, unknown> | null =>
    runtime.getSnapshot().devices.find(device => device.id === deviceId)?.state ?? null;
  if (deviceState() === null) {
    // C3: the 409's reason rides the ledger — in the trigger lane this
    // refusal was invisible (a swallowed ApiError + server log); the manual
    // lane still throws the same 409 below. Metered, never quota-burning.
    // R84 (R44-F2 teach-back): the user-facing 409 names the device — a bare
    // UUID backing id is unreadable in the city tier (F0-3 红线同族）。The
    // ledger reason keeps the exact id (machine channel).
    const deviceName = ((): string | undefined => {
      try {
        return ctx.envStore.getDevice(deviceId)?.name;
      } catch {
        return undefined;
      }
    })();
    const absentReason =
      `backing device "${deviceId}" is not present in the running simulation ` +
      `(agreement "${agreement.id}")`;
    appendRefusalUsage(ctx, agreement, action, 'action', absentReason, {
      simulationId: opts.simulationId,
      source: usageSourceOfActor(actor),
    });
    // R101: a provider-side delivery failure (backing device missing) scores
    // for explicit agreements — see scoreExplicitInvokeOutcome.
    scoreExplicitInvokeOutcome(ctx, agreement, false);
    throw new ApiError(
      409,
      'SERVICE_NOT_BACKED',
      `The backing device ${deviceName !== undefined ? `"${deviceName}" ` : ''}of agreement "${agreement.id}" is not present in the running simulation`,
    );
  }
  const before = deviceState();

  // T-070: which ACTION clause governs this invocation. A reset invocation
  // (actor.autoReset) enforces the negotiated terms.autoReset.action; every
  // other invocation enforces terms.action. Both are BINDING merge-overrides:
  // the caller cannot widen keys the negotiated clause constrains.
  const governedAction = actor.autoReset !== undefined
    ? terms.autoReset?.action
    : terms.action;
  const governedClauseName = actor.autoReset !== undefined ? 'terms.autoReset.action' : 'terms.action';

  // T-205 terms.action.params: the negotiated params MERGE-OVERRIDE the
  // caller's for the constrained keys — the consumer cannot widen the
  // agreed clause, and the provider's constraints survive omission.
  const effectiveParams: Record<string, unknown> = {
    ...(opts.params ?? {}),
    ...(governedAction?.params ?? {}),
  };

  // T-205 terms.action enforcement: the structured clause is BINDING —
  // the invoke's action must be the governed command (or, when the agreed
  // command is a device-type multi-command like 'lighting-control', one
  // of its expanded commands). Anything else is 422 quoting the clause.
  const agreedCommand = governedAction?.command;
  let termsAllowance: string[] | null = null;
  if (agreedCommand !== undefined) {
    const deviceRow = ctx.envStore.getDevice(deviceId);
    const expansion = deviceRow !== undefined
      ? multiCommandNamesForDeviceType(agreedCommand, deviceRow.type)
      : null;
    termsAllowance = expansion !== null
      ? [agreedCommand, ...expansion]
      : [agreedCommand];
    if (!termsAllowance.includes(action)) {
      throw new ApiError(
        422,
        'AGREEMENT_TERMS_VIOLATION',
        `Agreement "${agreement.id}" ${governedClauseName} allows only "${agreedCommand}"` +
          (expansion !== null ? ` (or its expansion: ${expansion.join(', ')})` : '') +
          ` — the requested action "${action}" is outside the negotiated scope`,
        undefined,
        { agreedCommand, requestedAction: action },
      );
    }
  }

  // T-303 (EN-F06) device gate — ADDITIVE to terms enforcement: the
  // requested action must be executable by the BACKING DEVICE itself. The
  // executable set is the ONE shared oracle (deviceExecutableCommandNames —
  // the same contract the device-detail `commands` field, flow validation
  // and the T-074 surface tests use: literal handler-backed capabilities +
  // semantic mappings + multi-command expansions the runtime ACTUALLY
  // honors) UNION the live snapshot's commands and the negotiated terms
  // allowance. R98 (simtest-r1 wang-03): the gate previously added the
  // semantic/expansion names UNCONDITIONALLY — a capability with no
  // dispatch route made the gate teach 'trigger-alert' while the device
  // answered 'not found / no executable commands' one step later. hass-bound
  // devices are real hardware: the sim registry cannot speak for their
  // command surface — exempt.
  const deviceRowForGate = ctx.envStore.getDevice(deviceId);
  if (
    deviceRowForGate !== undefined &&
    (deviceRowForGate.binding ?? '').startsWith('hass://') === false
  ) {
    const snapshotDevice = runtime.getSnapshot().devices
      .find(device => device.id === deviceId);
    const executable = new Set<string>(snapshotDevice?.commands ?? []);
    const declaredCaps = parseJsonArray<string>(deviceRowForGate.capabilities_json);
    for (const name of deviceExecutableCommandNames(
      declaredCaps,
      deviceRowForGate.type,
      deviceRowForGate.binding,
    )) {
      executable.add(name);
    }
    if (termsAllowance !== null) {
      for (const name of termsAllowance) executable.add(name);
    }
    if (executable.size > 0 && !executable.has(action)) {
      const teaching = `'${action}' is not executable on backing device '${deviceRowForGate.name}' — ` +
        `it responds to: ${[...executable].join(', ')}`;
      // R103 (zhao-23, 44g 纪律): an action OUTSIDE the negotiated/executable
      // surface is a CONSUMER-side error — never metered as a failure row,
      // never scored against the provider's reputation (this supersedes the
      // R101 metering+scoring of this refusal; provider-side failures —
      // backing absent, execution rejection — stay metered and scored).
      // The 422 teaching is unchanged.
      throw new ApiError(
        422,
        'DEVICE_COMMAND_NOT_EXECUTABLE',
        teaching,
        undefined,
        { deviceId, requestedAction: action, executableCommands: [...executable] },
      );
    }
  }

  // Synchronous execution: the runtime routes the command through the
  // provider agent to its own device (EngineRuntime.executeDeviceCommand).
  // Invocation-context actor (R17 params-purity): manual invokes act as the
  // consuming user; trigger-driven (T-035) and reset (T-070) invokes act as
  // the agreement's automation — dedicated labels, so device-state audit
  // trails (lock accessLog, display contentSetBy) attribute honestly
  // WITHOUT polluting the command's semantic params.
  //
  // R102 (wang-17): the parameter-VALUE gate — same shared schema the
  // device dispatch enforces (validateCommandParams on the R101
  // capability→handler truth chain). A known param with the wrong
  // type/range/enum refuses BEFORE execution: no state write, a metered
  // failure (never a success — the T-303 refusal's exact shape), and a 422
  // naming the parameter, the expectation, and what was received.
  const paramValidation = validateCommandParams(action, effectiveParams, deviceRowForGate?.type);
  if (paramValidation.violation !== undefined) {
    const reason = `invalid params for '${action}': ${paramValidation.violation}`;
    // R103 (zhao-23, 44g 纪律): invalid params are a CONSUMER-side error —
    // like the not-executable refusal above, never metered and never scored
    // against the provider (the R101/wang-17 lane's failure-row + scoring is
    // superseded). The 422 naming the parameter is unchanged.
    throw new ApiError(
      422,
      'INVALID_PARAMS',
      reason +
        (paramValidation.dropped.length > 0
          ? ` (unrecognized params would be dropped: ${paramValidation.dropped.join(', ')})`
          : ''),
      undefined,
      { action, violation: paramValidation.violation },
    );
  }
  const invocationActor = actor.userId !== undefined
    ? ctx.userStore.findById(actor.userId)?.display_name ?? actor.userId
    : actor.autoReset !== undefined
      ? `agreement:${agreement.id}:auto-reset`
      : `agreement:${agreement.id}`;
  const startedAt = new Date().toISOString();
  const outcome = await runtime.executeDeviceCommand(deviceId, action, effectiveParams, {
    actor: invocationActor,
  });
  const endedAt = new Date().toISOString();

  // Flatten the engine's double-wrap: a coordinator-level success:false, or
  // a device-level failure inside a coordinator success, both mean the
  // invocation failed.
  let success = outcome.success;
  let error: string | undefined = outcome.success ? undefined : (outcome.error ?? 'command failed');
  let result: unknown = outcome.result;
  if (outcome.success) {
    const inner = unwrapDeviceFailure(outcome);
    if (inner !== null) {
      success = false;
      error = inner.error;
      result = undefined;
    }
  }

  // Audit + metering: executed commands land in command_log (the
  // replay-consumable device-command shape, tagged with the agreement) —
  // its entry id is the UsageRecord's effectRef.
  //
  // T-035 attribution: a trigger-driven invocation acts on the CONSUMER's
  // behalf (the trigger clause is the consumer's negotiated automation),
  // so the audit actor is the consumer owner, and the payload names the
  // agreement + the triggering event.
  const auditActorId = actor.userId ?? agreement.consumer_owner_id;
  let effectRef: string | null = null;
  if (success) {
    const logRow = ctx.pipeline.log({
      envId: agreement.env_id,
      actorId: auditActorId,
      kind: 'device-command',
      payload: {
        deviceId,
        commandName: action,
        ...(Object.keys(effectiveParams).length > 0 ? { params: effectiveParams } : {}),
        agreementId: agreement.id,
        ...(actor.autoTrigger !== undefined
          ? {
              autoTrigger: {
                eventId: actor.autoTrigger.eventId,
                eventType: actor.autoTrigger.eventType,
                ...(actor.autoTrigger.zoneId !== undefined ? { zoneId: actor.autoTrigger.zoneId } : {}),
              },
            }
          : {}),
        // T-070: the reset names the event whose trigger invocation armed it
        // — the audit trail reads "motion armed it, the clause un-pegged it".
        ...(actor.autoReset !== undefined
          ? {
              autoReset: {
                armedByEventId: actor.autoReset.armedByEventId,
                armedByEventType: actor.autoReset.armedByEventType,
                ...(actor.autoReset.zoneId !== undefined ? { zoneId: actor.autoReset.zoneId } : {}),
              },
            }
          : {}),
        // D1 (T-085, R28): the contention this trigger-driven invocation
        // races — the other active agreement(s) writing the same
        // (deviceId, param). Both agreementIds are visible on the row
        // (this payload's agreementId + each mark's).
        ...(opts.contentionWith !== undefined && opts.contentionWith.length > 0
          ? { contentionWith: opts.contentionWith }
          : {}),
        before,
        after: deviceState(),
      },
      simTime: runtime.getSimTimeSec(),
    });
    effectRef = String(logRow.id);
  }
  const usage = ctx.agreementStore.appendUsage({
    agreementId: agreement.id,
    envId: agreement.env_id,
    consumerAgentId: agreement.consumer_agent_id,
    providerAgentId: agreement.provider_agent_id,
    kind: 'invoke',
    action,
    quantity: 1,
    // UX-05: the agreed metering unit lands on the ledger — same override
    // pattern as the read lane (read-delivery.ts).
    unit: terms.meteringUnit ?? 'action',
    outcome: success ? 'success' : 'failure',
    effectRef,
    // C3 (R25-NF4): the executed-but-failed case (device rejected the
    // command — param vocabulary, wrong state…) finally names WHY in the
    // ledger the consumer reads.
    failureReason: success ? null : (error ?? 'command failed'),
    origin: (agreement.service_id !== null ? ctx.serviceStore.getService(agreement.service_id) : undefined)?.origin ?? null,
    // FEAT-08/UX-04: the metering carries WHICH sim ran it and through
    // which lane (manual / trigger automation / auto-reset).
    simulationId: opts.simulationId,
    source: usageSourceOfActor(actor),
    startedAt,
    endedAt,
  });
  // Phase 2 (§5) + R101 (trust-visibility): score the metered outcome for
  // EXPLICIT agreements — success AND failure both count
  // attempts/successes (the PM's round-4 ruling: the design's "invoke 失败
  // 记提供方 failure" was never wired for the explicit lane). AC-sourced
  // agreements skip: the runtime's Fix-12 pipeline covers those (no double
  // accounting). Consumer-side probing errors stay excluded.
  scoreExplicitInvokeOutcome(ctx, agreement, success, error);
  const consumerError = !success && isConsumerProbingError(error);
  const receipt = await ctx.settlement.settle({
    agreementId: agreement.id,
    envId: agreement.env_id,
    terms,
    usageRecords: [usage],
  });

  // Fix-16: every invoke is announced on the env stream; a FAILED invoke
  // also pings the provider's owner (dedupeUnread caps the inbox).
  ctx.pipeline.publishAgreement(agreement.env_id, 'invoked', agreement.id, auditActorId);
  if (!success && !consumerError) {
    notify(ctx.notificationStore, {
      recipientId: agreement.provider_owner_id,
      actorId: auditActorId,
      envId: agreement.env_id,
      kind: NOTIFICATION_KINDS.agreementInvokeFailed,
      title: t(actor.locale ?? 'zh-CN', 'chrome.notif.agreementInvokeFailed'),
      body: {
        agreementId: agreement.id,
        serviceId: agreement.service_id,
        action,
        error: error ?? 'command failed',
      },
      refId: agreement.id,
      dedupeUnread: true,
    });
  }

  return {
    success,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    deviceId,
    effectiveParams,
    // T-070: a reset invocation enforces the autoReset clause — the
    // termsEnforced flag stays honest for both lanes.
    termsEnforced: agreedCommand !== undefined,
    usage,
    receiptId: receipt?.id ?? null,
  };
}

/**
 * Mechanism D (design-mixed-initiative-flows.md §5.1/§5.3): the flow-service
 * invocation lane, sharing the invocation tail with device invokes — quota is
 * checked by the CALLERS (manual route / trigger executor, both before this),
 * metering here is kind='invoke', quantity=1, **unit='flow-run'** (per-run
 * pricing: one run is the atomic commercial deliverable; node-count is an
 * implementation detail the contract must not reprice), effectRef = the flow
 * run id (chains the receipt to the flow_runs ledger where the per-node
 * traces, incl. DelegateNodeOutcome, live).
 *
 * Gates, in order:
 * 1. the action must be 'run' — the ONLY action a flow-service performs
 *    (T-205's clause shape specialized: terms.action.command is 'run').
 * 2. the backing flow must exist, be enabled, and still DECLARE its inputs
 *    surface — else 409 FLOW_NOT_RUNNABLE (same code as the manual lane).
 * 3. effective params (T-205 merge-override under terms.action.params) are
 *    validated by resolveFlowRunParams — the SAME oracle the manual-run
 *    route, the engine, and the interface generation use; violations are
 *    metered outcome='failure' (audit completeness; quota untouched — the
 *    T-205 "failures never count" rule) and 422 FLOW_PARAMS_INVALID with
 *    teaching issues.
 * 4. execution runs the flow in the target simulation's FlowEngine via
 *    runDirect(triggerKind 'service') — the PROVIDER's context: nodes act on
 *    the flow author's own agents/devices under resolveFlowAssignments
 *    (T-201 = zero new permissions; zone containment carries over).
 *
 * Success semantics: status==='success' only — 'partial'/'failed' runs are
 * metered failures (the delivery did not fully land), keeping quota
 * successes-only like every other lane.
 */
async function executeFlowAgreementInvocation(
  ctx: AgreementRoutesContext,
  opts: {
    agreement: AgreementRow;
    terms: AgreementTerms;
    runtime: SimulationRecord['runtime'];
    simulationId: string;
    action: string;
    params?: Record<string, unknown>;
    actor: AgreementInvocationActor;
  },
  service: ServiceInstanceRow,
): Promise<AgreementInvocationOutcome> {
  const { agreement, terms, runtime, action, actor } = opts;
  if (action !== 'run') {
    throw new ApiError(
      422,
      'AGREEMENT_TERMS_VIOLATION',
      `Agreement "${agreement.id}" backs a flow-service — its only action is "run" ` +
        `(the deterministic DAG executes as one unit); the requested action "${action}" ` +
        'does not exist on this contract',
      undefined,
      { agreedCommand: 'run', requestedAction: action },
    );
  }

  let flow: FlowRow;
  try {
    flow = requireRunnableFlow(ctx, service);
  } catch (error) {
    // C3: the pre-run 409 (flow gone/disabled/inputs dropped) also rides
    // the ledger — the trigger lane swallows the throw into a log line.
    appendRefusalUsage(
      ctx, agreement, 'run', 'flow-run',
      error instanceof ApiError ? error.message : String(error),
      { simulationId: opts.simulationId, source: usageSourceOfActor(actor) },
    );
    throw error;
  }
  const flowDef = flowRowToDefinition(flow, ctx.envStore.getEnvironment(agreement.env_id)?.owner_id);
  // FEAT-06: a flow carrying WAIT nodes finishes ASYNCHRONOUSLY (the run
  // parks on the sim clock and completes at a later tick) — the flow-service
  // contract is synchronous (metering/reputation/the receipt chain the
  // COMPLETED run). Refuse BEFORE execution with the teaching move, metered
  // as a pre-run refusal like the gates above.
  if (flowDef.plan.nodes.some(node => node.wait !== undefined)) {
    const error = new ApiError(
      409,
      'FLOW_RUN_ASYNC',
      `Flow "${flow.name}" (${flow.id}) carries wait nodes — it finishes asynchronously on the sim ` +
        'clock, but a flow-service invocation is synchronous (metering and the receipt chain the ' +
        'completed run); remove the wait nodes from the published flow (staggering belongs to the ' +
        "CONSUMER's own orchestration) and re-publish",
    );
    appendRefusalUsage(
      ctx, agreement, 'run', 'flow-run', error.message,
      { simulationId: opts.simulationId, source: usageSourceOfActor(actor) },
    );
    throw error;
  }
  // T-070 (DevLoop R33, Care F1): which ACTION clause governs this invocation
  // — the DEVICE lane's distinction, mirrored here. A reset invocation
  // (actor.autoReset) enforces the negotiated terms.autoReset.action; every
  // other invocation enforces terms.action. Without this, the MAIN action's
  // params merge-override the RESET's: a negotiated `{shedPct:0}` reset ran
  // as `{shedPct:15}` (the trigger's value) — the reset fired, was metered
  // SUCCESS, cleared the arm, and silently did NOT restore the shed level.
  const governedAction = actor.autoReset !== undefined
    ? terms.autoReset?.action
    : terms.action;
  const governedClauseName = actor.autoReset !== undefined ? 'terms.autoReset.action' : 'terms.action';
  // T-205 merge-override: the governed clause's negotiated params constrain
  // the caller's keys (the caller cannot widen the agreed clause).
  const effectiveParams: Record<string, unknown> = {
    ...(opts.params ?? {}),
    ...(governedAction?.params ?? {}),
  };
  const { params: validatedParams, issues: paramIssues } =
    resolveFlowRunParams(flowDef.inputs, effectiveParams);
  const paramErrors = paramIssues.filter(issue => issue.level === 'error');
  if (paramErrors.length > 0) {
    // Consumer-side error: metered for audit, no receipt, no quota burn, no
    // reputation scoring (the provider delivered nothing wrong). C3: the
    // first issue rides the usage row (failure_reason).
    appendRefusalUsage(
      ctx, agreement, 'run', 'flow-run',
      `flow "${flow.name}" rejected the run parameters: ${paramErrors[0].message}`,
      { simulationId: opts.simulationId, source: usageSourceOfActor(actor) },
    );
    throw new ApiError(
      422,
      'FLOW_PARAMS_INVALID',
      `Flow "${flow.name}" rejected the run parameters: ${paramErrors[0].message}`,
      paramErrors.map(issue => issue.message),
      { issues: paramErrors, flowId: flow.id },
    );
  }

  const flowEngine = runtime.getFlowEngine();
  if (flowEngine === null) {
    appendRefusalUsage(
      ctx, agreement, 'run', 'flow-run',
      "the target simulation's flow engine is absent or suspended (shadow simulations never execute flows)",
      { simulationId: opts.simulationId, source: usageSourceOfActor(actor) },
    );
    throw new ApiError(
      409,
      'FLOW_NOT_RUNNABLE',
      `The target simulation's flow engine is absent or suspended (shadow simulations never ` +
        `execute flows — T-302) — flow-service invocation requires a sim with live flow execution`,
    );
  }

  const startedAt = new Date().toISOString();
  const record = await flowEngine.runDirect(flow.id, 'service', validatedParams);
  const endedAt = new Date().toISOString();
  if (record === null) {
    // Unknown or disabled at RUN time (the world changed since publish) —
    // the manual lane's own 409 shape, metered as a failed attempt (C3: the
    // reason rides the row).
    appendRefusalUsage(
      ctx, agreement, 'run', 'flow-run',
      `flow "${flow.name}" (${flow.id}) is unknown or disabled in the running simulation`,
      { simulationId: opts.simulationId, source: usageSourceOfActor(actor) },
    );
    throw new ApiError(
      409,
      'FLOW_NOT_RUNNABLE',
      `Flow "${flow.name}" (${flow.id}) is unknown or disabled in the running simulation — ` +
        'the flow may have been disabled after the service was published; re-enable it or re-publish',
    );
  }

  const success = record.status === 'success';
  const error = success ? undefined :
    `flow run ${record.status}: ${record.summary}`;

  // Audit: one command_log row per invocation names the agreement, the flow,
  // and the run — the per-node traces (with deviceId attribution and any
  // DelegateNodeOutcome) live in the flow_runs ledger this row points at.
  const auditActorId = actor.userId ?? agreement.consumer_owner_id;
  if (success) {
    ctx.pipeline.log({
      envId: agreement.env_id,
      actorId: auditActorId,
      kind: 'flow-service-run',
      payload: {
        serviceId: service.id,
        flowId: flow.id,
        runId: record.runId,
        agreementId: agreement.id,
        simulationId: opts.simulationId,
        status: record.status,
        ...(Object.keys(validatedParams).length > 0 ? { params: validatedParams } : {}),
        ...(actor.autoTrigger !== undefined
          ? {
              autoTrigger: {
                eventId: actor.autoTrigger.eventId,
                eventType: actor.autoTrigger.eventType,
                ...(actor.autoTrigger.zoneId !== undefined ? { zoneId: actor.autoTrigger.zoneId } : {}),
              },
            }
          : {}),
        // T-070: the reset names the event whose trigger invocation armed it
        // (the device lane's audit marker, mirrored for flow-service runs).
        ...(actor.autoReset !== undefined
          ? {
              autoReset: {
                armedByEventId: actor.autoReset.armedByEventId,
                armedByEventType: actor.autoReset.armedByEventType,
                ...(actor.autoReset.zoneId !== undefined ? { zoneId: actor.autoReset.zoneId } : {}),
              },
              governedClause: governedClauseName,
            }
          : {}),
      },
      simTime: runtime.getSimTimeSec(),
    });
  }

  // Metering: per-run, effectRef chains to the run ledger. C3: a partial or
  // failed run names WHY (status + summary — budget exhaustion, node
  // failure…) on the usage row.
  const usage = ctx.agreementStore.appendUsage({
    agreementId: agreement.id,
    envId: agreement.env_id,
    consumerAgentId: agreement.consumer_agent_id,
    providerAgentId: agreement.provider_agent_id,
    kind: 'invoke',
    action: 'run',
    quantity: 1,
    unit: 'flow-run',
    outcome: success ? 'success' : 'failure',
    effectRef: record.runId,
    failureReason: success ? null : (error ?? 'flow run failed'),
    origin: service.origin,
    // FEAT-08/UX-04: same attribution as the device lane.
    simulationId: opts.simulationId,
    source: usageSourceOfActor(actor),
    startedAt,
    endedAt,
  });
  // Phase 2 (§5) reputation: a failed/partial run is a provider delivery
  // failure for the service's semantic type (consumer probing errors never
  // reach here — params were validated above).
  if (!success && agreement.provider_agent_id !== null) {
    ctx.reputationStore.recordFailure(
      agreement.env_id,
      agreement.provider_agent_id,
      service.semantic_type,
    );
  }
  const receipt = await ctx.settlement.settle({
    agreementId: agreement.id,
    envId: agreement.env_id,
    terms,
    usageRecords: [usage],
  });

  ctx.pipeline.publishAgreement(agreement.env_id, 'invoked', agreement.id, auditActorId);
  if (!success) {
    notify(ctx.notificationStore, {
      recipientId: agreement.provider_owner_id,
      actorId: auditActorId,
      envId: agreement.env_id,
      kind: NOTIFICATION_KINDS.agreementInvokeFailed,
      title: t(actor.locale ?? 'zh-CN', 'chrome.notif.agreementInvokeFailed'),
      body: {
        agreementId: agreement.id,
        serviceId: agreement.service_id,
        action: 'run',
        error: error ?? 'flow run failed',
      },
      refId: agreement.id,
      dedupeUnread: true,
    });
  }

  return {
    success,
    ...(error !== undefined ? { error } : {}),
    deviceId: null,
    effectiveParams: validatedParams,
    // T-070: a reset invocation enforces the autoReset clause — the
    // termsEnforced flag stays honest for both lanes (device AND flow).
    termsEnforced: governedAction?.command !== undefined,
    usage,
    receiptId: receipt?.id ?? null,
    flowRun: {
      flowId: flow.id,
      runId: record.runId,
      status: record.status,
      triggerKind: record.triggerKind,
      inputs: record.inputs,
      nodeResults: record.nodeResults as Record<string, unknown>,
    },
  };
}

/**
 * The flow-service run gate: the backing flow must exist, be enabled, and
 * still declare its inputs surface. 409 FLOW_NOT_RUNNABLE — the manual run
 * lane's code, so every "cannot run this flow" answer speaks one language.
 */
export function requireRunnableFlow(
  ctx: AgreementRoutesContext,
  service: ServiceInstanceRow,
): FlowRow {
  if (ctx.flowStore === undefined) {
    throw new ApiError(
      500,
      'INTERNAL',
      'Flow store unavailable — flow-service invocation is not wired in this deployment',
    );
  }
  const flow = ctx.flowStore.getById(service.source_flow_id!);
  const env = ctx.envStore.getEnvironment(service.env_id);
  if (!flow || !env || flow.environment_id !== env.id || flow.enabled !== 1 || flow.inputs_json === null) {
    throw new ApiError(
      409,
      'FLOW_NOT_RUNNABLE',
      `Service "${service.name}" is not runnable — its backing flow ` +
        `${!flow ? `"${service.source_flow_id}" no longer exists` : `"${flow.name}" is ${flow.enabled !== 1 ? 'disabled' : 'missing its inputs surface'}`}. ` +
        'The provider must re-enable/re-publish the flow (consumers: the agreement stands, ' +
        'termination stays bilateral)',
    );
  }
  return flow;
}

/** Flatten the engine's double-wrapped device failure (mirrors routes/simulations.ts). */
export function unwrapDeviceFailure(outcome: unknown): { error: string } | null {
  if (typeof outcome !== 'object' || outcome === null) return null;
  const deviceResult = (outcome as { result?: unknown }).result;
  if (typeof deviceResult !== 'object' || deviceResult === null) return null;
  const failure = deviceResult as { success?: unknown; error?: unknown };
  if (failure.success !== false || typeof failure.error !== 'string') return null;
  return { error: failure.error };
}
