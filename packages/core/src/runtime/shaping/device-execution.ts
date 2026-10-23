/**
 * Device-execution trajectory wiring — pure shaping (L2), see docs/architecture-runtime.md
 *
 * R6-E-F10: device-command execution receipts land in the trajectory. Before
 * this the trajectory carried only the decision's PLAN face
 * (actionPlan.deviceActions) — execution and its result were the largest
 * observability blind spot (the live path's goalAchieved was structurally
 * absent; the distillation/eval "decision → execution → world-feedback"
 * chain broke at the execution link). One 'device-execution' record per
 * command — success AND failure — carrying deviceId/command/params/result/
 * executionTime/actor plus the eventId of the injection event in flight
 * when the command was decision-triggered ('unattributed' for NL/manual).
 *
 * T-102: one command lands on the bus TWICE — the device's own
 * DEVICE_OPERATION_EXECUTED emission (richest: deviceName + result wrapper)
 * and the DeviceCommandCoordinator echo ~2ms later (carries the commanding
 * agentId). Both normalize to the same dedupeKey; first arrival wins.
 *
 * Pure wiring: no engine state of its own beyond the dedupe map, no IO.
 */

import { EventType, type SystemEvent } from '../../events/index.js';

/** The recorder face this wiring needs (avoids importing L3). */
export interface DeviceExecRecorderLike {
  recordDeviceExecution(entry: {
    agentId: string;
    eventId?: string;
    deviceId: string;
    deviceName?: string;
    command: string;
    params?: unknown;
    success: boolean;
    result?: unknown;
    error?: string;
    executionTime?: number;
    actor?: string;
  }): unknown;
}

/** The bus face this wiring needs (avoids importing the EventManager). */
export interface DeviceExecEventManagerLike {
  subscribe(subscription: {
    subscriberId: string;
    eventType: EventType;
    handler: (event: SystemEvent) => void;
  }): string;
}

/**
 * A DEVICE_OPERATION_EXECUTED payload normalized into a trajectory execution
 * receipt. Returns null for payloads that are not device-command receipts.
 */
export interface DeviceExecutionReceipt {
  deviceId: string;
  deviceName?: string;
  command: string;
  params?: unknown;
  success: boolean;
  /** The device's result VALUE (unwrapped from the ExecutionResult envelope). */
  result?: unknown;
  error?: string;
  executionTime?: number;
  actor?: string;
  /** The commanding agent when the emission carries it (coordinator echo). */
  agentId?: string;
  /**
   * R102: the decision event the command was triggered by — stamped by the
   * device from the invocation context (AC lanes thread the collaboration's
   * triggerEventId). Preferred over the inflight-window fallback.
   */
  eventId?: string;
  /** T-102: one command's two emissions share this key — first arrival wins. */
  dedupeKey: string;
}

export function deviceExecutionReceiptOf(payload: unknown): DeviceExecutionReceipt | null {
  const p = payload as {
    deviceId?: unknown;
    deviceName?: unknown;
    commandName?: unknown;
    params?: unknown;
    result?: { success?: unknown; result?: unknown; error?: unknown; executionTime?: unknown } | unknown;
    success?: unknown;
    error?: unknown;
    executionTime?: unknown;
    actor?: unknown;
    agentId?: unknown;
  } | undefined;
  if (typeof p?.deviceId !== 'string' || p.deviceId.length === 0) return null;
  if (typeof p.commandName !== 'string' || p.commandName.length === 0) return null;
  const resultWrapper = (p.result !== null && typeof p.result === 'object' ? p.result : undefined) as
    | { success?: unknown; result?: unknown; error?: unknown; executionTime?: unknown }
    | undefined;
  // Success resolution: the coordinator's error path stamps top-level
  // success:false/error; every other emission carries the device's
  // ExecutionResult wrapper whose `success` is the verdict.
  const success = typeof p.success === 'boolean'
    ? p.success
    : resultWrapper?.success !== false && p.error === undefined;
  const error = typeof p.error === 'string'
    ? p.error
    : typeof resultWrapper?.error === 'string'
      ? resultWrapper.error
      : undefined;
  const executionTime = typeof p.executionTime === 'number'
    ? p.executionTime
    : typeof resultWrapper?.executionTime === 'number'
      ? resultWrapper.executionTime
      : undefined;
  let paramsKey = '';
  try {
    paramsKey = p.params === undefined ? '' : JSON.stringify(p.params) ?? '';
  } catch {
    paramsKey = '';
  }
  return {
    deviceId: p.deviceId,
    ...(typeof p.deviceName === 'string' ? { deviceName: p.deviceName } : {}),
    command: p.commandName,
    ...(p.params !== undefined ? { params: p.params } : {}),
    success,
    ...(resultWrapper?.result !== undefined ? { result: resultWrapper.result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(executionTime !== undefined ? { executionTime } : {}),
    ...(typeof p.actor === 'string' && p.actor.length > 0 ? { actor: p.actor } : {}),
    ...(typeof p.agentId === 'string' && p.agentId.length > 0 ? { agentId: p.agentId } : {}),
    ...(typeof (p as { eventId?: unknown }).eventId === 'string' && ((p as { eventId?: unknown }).eventId as string).length > 0
      ? { eventId: (p as { eventId?: unknown }).eventId as string }
      : {}),
    dedupeKey: `${p.deviceId}|${p.commandName}|${paramsKey}|${success}`,
  };
}

/**
 * Subscribe DEVICE_OPERATION_EXECUTED and write one trajectory receipt per
 * device command. Returns the subscription id (the caller owns cleanup).
 * No-op (subscribes nothing) when no recorder is wired — returns ''.
 *
 * Attribution: the commanding agent when the emission carries one
 * (coordinator echo), else `managingAgentOf` (the reputation attribution
 * rule), else 'unknown'. The invocation-context actor rides the record so
 * flow-triggered ('engine:flow:<flowId>') and user-triggered ('user:<id>')
 * commands stay distinguishable from decision-triggered ones.
 *
 * Dedupe (T-102): keyed by (device|command|params|success); first arrival
 * wins — a repeat inside the WALL-CLOCK window is the coordinator echo and
 * is dropped. Wall-clock, not sim time: two identical operator commands in
 * a PAUSED world must both record.
 */
export function wireDeviceExecutionTrajectory(seams: {
  eventManager: DeviceExecEventManagerLike;
  runtimeId: string;
  recorder: DeviceExecRecorderLike | null;
  /** The injection event currently in flight (decision correlation). */
  inflightEventId: () => string | undefined;
  /** Managing-agent fallback (boundDeviceIds), the reputation rule. */
  managingAgentOf: (deviceId: string) => string | undefined;
  /** Echo window in wall-clock ms (default 2000 — the echo is ~2ms). */
  dedupeWindowMs?: number;
}): string {
  const { recorder } = seams;
  if (recorder === null) return '';
  const windowMs = seams.dedupeWindowMs ?? 2000;
  const seen = new Map<string, number>();
  return seams.eventManager.subscribe({
    subscriberId: `engine-runtime-device-exec-trajectory-${seams.runtimeId}`,
    eventType: EventType.DEVICE_OPERATION_EXECUTED,
    handler: (event: SystemEvent) => {
      try {
        const receipt = deviceExecutionReceiptOf(event.payload);
        if (receipt === null) return;
        const now = Date.now();
        const last = seen.get(receipt.dedupeKey);
        if (last !== undefined && now - last < windowMs) return; // T-102: the echo
        if (seen.size > 512) seen.clear();
        seen.set(receipt.dedupeKey, now);
        // R102: an event id stamped from the invocation context (AC lanes'
        // threaded triggerEventId) wins over the inflight-window fallback —
        //履约 executions land long after the window closed.
        const eventId = receipt.eventId ?? seams.inflightEventId();
        recorder.recordDeviceExecution({
          agentId: receipt.agentId ?? seams.managingAgentOf(receipt.deviceId) ?? 'unknown',
          ...(eventId !== undefined ? { eventId } : {}),
          deviceId: receipt.deviceId,
          ...(receipt.deviceName !== undefined ? { deviceName: receipt.deviceName } : {}),
          command: receipt.command,
          ...(receipt.params !== undefined ? { params: receipt.params } : {}),
          success: receipt.success,
          ...(receipt.result !== undefined ? { result: receipt.result } : {}),
          ...(receipt.error !== undefined ? { error: receipt.error } : {}),
          ...(receipt.executionTime !== undefined ? { executionTime: receipt.executionTime } : {}),
          ...(receipt.actor !== undefined ? { actor: receipt.actor } : {}),
        });
      } catch {
        // A trajectory sink failure must never break the runtime's bus.
      }
    },
  });
}
