/**
 * Event shaping — injection resolution, payload building, subscription parsers — pure shaping (L2), see docs/architecture-runtime.md
 *
 * Deterministic, no engine state, no I/O. Types come from ../contract.js.
 */
import { classifyCollaborationOutcome } from '../../reputation/index.js';
import type {
  EngineSnapshot,
  EventRouteLevel,
  InjectedEventRecord,
  InjectEventInput,
  PhysicalEnvironmentLike,
  ScheduledEventFireRecord,
} from '../contract.js';
import { EventPriority, EventType, type SystemEvent } from '../../events/index.js';
import {
  BOOLEAN_FIELD_FLAGS,
  EVENT_TYPE_DEFAULTS,
  NUMERIC_EVENT_PARAMETERS,
  resolveHumanNarrative,
  severityToPriority,
  zoneCenter,
  zoneWriteRadius,
} from './world.js';
import { MAX_SNAPSHOT_INJECTED_EVENTS } from './snapshot.js';

// ---------------------------------------------------------------------------

/** Resolve an injected event's parameter/value (defaults table + coercion). */
export function resolveInjection(
  input: InjectEventInput,
  coerce: (value: number | boolean | string, type: string) => number | boolean,
): { parameter: string; value: number | boolean } {
  const defaults = EVENT_TYPE_DEFAULTS[input.type];
  const parameter = input.parameter ?? defaults?.parameter ?? input.type;
  const value = coerce(input.value ?? defaults?.value ?? true, input.type);
  return { parameter, value };
}

/**
 * R98: a boolean write to a NUMERIC physical parameter is always a
 * misdeclaration (typically the `?? true` fallback for an event declared
 * without a value) — `true` used to land as 1 (°C/ppm/…) and silently
 * corrupt the world (chen-03: a "noon heat" event froze the building at
 * 1 °C). Reject with a teaching error; motion/smoke flags and custom flag
 * parameters keep their boolean semantics.
 */
export function assertEventValueWritable(
  input: InjectEventInput,
  parameter: string,
  value: number | boolean,
): void {
  if (typeof value === 'boolean' && NUMERIC_EVENT_PARAMETERS.has(parameter)) {
    throw new Error(
      `EngineRuntime.injectEvent: event "${input.id ?? input.type}" (type "${input.type}") resolved ` +
      `boolean value ${value} for numeric parameter "${parameter}" — declare an explicit numeric value`,
    );
  }
}

/** Structural zone face the physical write needs (ScenarioZone-compatible). */
export interface EventWriteZone {
  type?: string;
  floor?: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  baseline?: Record<string, number | boolean>;
}

/**
 * Set the physical parameter for an injected event (R98 extraction from
 * EngineRuntime.injectEvent — behavior verbatim):
 * - occupancy drives the zone's occupancy effect sources (not a field
 *   parameter), via the runtime's seam (it validates the zone);
 * - outdoor zones WITH bounds are boundary conditions — the event updates
 *   the zone's relaxation baseline (a plain spike would just relax back);
 * - zones WITH bounds get a LOCALIZED write at the zone center (the
 *   disturbance spreads only through field diffusion/spillover; T-708:
 *   diffusing pollutants are point writes);
 * - R98 (chen-03): a bounds-less zone still gets a ZONE-SCOPED numeric
 *   write — the legacy global override pinned EVERY zone at the value
 *   forever (min=max constant model, no relaxation: the whole building
 *   "froze"). The spatial field holds per-location values without
 *   geometry; seeding the zone's declared baseline as the relaxation
 *   attractor lets the disturbance decay back instead of freezing.
 *   R99 (chen-08): boolean field flags (motion/smoke) take the same path —
 *   the field stores them 1/0 and relaxes them back to the background
 *   (smoke clears at the field's smoke relaxation rate), instead of a
 *   global flag write that never clears;
 * - everything else (outdoor bounds-less, custom flag parameters, no
 *   physics layer) keeps the legacy global write (runner semantics).
 */
export function applyEventPhysicalWrite(args: {
  input: InjectEventInput;
  zone: EventWriteZone;
  parameter: string;
  value: number | boolean;
  physicalEnv: PhysicalEnvironmentLike;
  setZoneOccupancy: (zoneId: string, occupancy: number) => void;
  updateZoneBaseline: (zoneId: string, parameter: string, value: number | boolean) => void;
}): void {
  const { input, zone, parameter, value, physicalEnv } = args;
  if (parameter === 'occupancy') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `EngineRuntime.injectEvent: occupancy events require a numeric headcount, got "${String(input.value)}"`,
      );
    }
    args.setZoneOccupancy(input.zoneId, value);
  } else if (zone.type === 'outdoor' && zoneCenter(zone) !== undefined) {
    args.updateZoneBaseline(input.zoneId, parameter, value);
  } else if (zoneCenter(zone) !== undefined) {
    physicalEnv.setLocalParameterValue(parameter, input.zoneId, value, zoneWriteRadius(zone, parameter));
  } else if (zone.type !== 'outdoor' && physicalEnv.getPhysicsLayer?.() !== undefined &&
             (typeof value === 'number' || BOOLEAN_FIELD_FLAGS.has(parameter))) {
    const baseline = zone.baseline?.[parameter];
    if (typeof baseline === 'number') {
      physicalEnv.setParameterBaseline(parameter, input.zoneId, baseline);
    }
    physicalEnv.setLocalParameterValue(parameter, input.zoneId, value, 0);
  } else {
    physicalEnv.setParameterValue(parameter, input.zoneId, value);
  }
}

/**
 * R98 event observability: the per-event fire outcome recorded by the
 * scheduler — the resolved effect on success, the rejection message on
 * failure (previously swallowed by the scheduler's catch-and-log, leaving
 * fired:true with zero trace).
 */
export function scheduledFireRecord(
  firedAtSimTimeSec: number,
  result?: { parameter: string; value: number | boolean },
  error?: unknown,
): ScheduledEventFireRecord {
  return result !== undefined
    ? { firedAtSimTimeSec, effect: { parameter: result.parameter, value: result.value } }
    : { firedAtSimTimeSec, error: (error as Error).message };
}/**
 * The shared payload of an injected event (per-agent SystemEvents carry it
 * verbatim). Shape is part of the contract: severity/requiredCapabilities
 * drive the assessor, humanNarrative/cinematography/focusZoneId drive the UI.
 */
export function buildInjectedEventPayload(
  input: InjectEventInput,
  eventId: string,
  resolved: { parameter: string; value: number | boolean },
): Record<string, unknown> {
  return {
    parameter: resolved.parameter,
    location: input.zoneId,
    zoneId: input.zoneId,
    newValue: resolved.value,
    eventId,
    eventType: input.type,
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.requiredCapabilities !== undefined
      ? { requiredCapabilities: [...input.requiredCapabilities] }
      : {}),
    ...resolveHumanNarrative(input.humanNarrative),
    ...(input.cinematography ? { cinematography: input.cinematography } : {}),
    ...(input.focusZoneId ? { focusZoneId: input.focusZoneId } : {}),
  };
}/** One managing agent's SystemEvent for an injected event (Wave A1 fan-out). */
export function buildInjectedSystemEvent(args: {
  eventId: string;
  agentId: string;
  runtimeId: string;
  eventType: EventType;
  /** The ORIGINAL scenario/injected event type (metadata.eventType). */
  originType: string;
  payload: Record<string, unknown>;
  severity?: string;
}): SystemEvent {
  return {
    id: `${args.eventId}:${args.agentId}`,
    type: args.eventType,
    source: `engine-runtime:${args.runtimeId}`,
    timestamp: new Date(),
    payload: args.payload,
    priority: severityToPriority(args.severity),
    metadata: { eventId: args.eventId, eventType: args.originType },
  };
}/** What a COLLABORATION_MESSAGE event asks the runtime to do. */
export type CollabMessageAction =
  | { kind: 'none' }
  | { kind: 'rememberCapabilities'; collaborationId: string; requiredCapabilities: unknown }
  | { kind: 'cancel'; collaborationId: string };/** Parse a COLLABORATION_MESSAGE payload (ac-proposal / ac-cancelled). */
export function parseCollabMessageAction(payload: unknown): CollabMessageAction {
  const p = payload as { type?: string; collaborationId?: unknown; requiredCapabilities?: unknown } | undefined;
  if (!p || typeof p.collaborationId !== 'string') return { kind: 'none' };
  if (p.type === 'ac-proposal') {
    return { kind: 'rememberCapabilities', collaborationId: p.collaborationId, requiredCapabilities: p.requiredCapabilities };
  }
  if (p.type === 'ac-cancelled') {
    return { kind: 'cancel', collaborationId: p.collaborationId };
  }
  return { kind: 'none' };
}/** What a COLLABORATION_COMPLETED event asks the runtime to do. */
export type CollabCompletedAction =
  | { kind: 'none' }
  | { kind: 'finalize'; collaborationId: string; failed: boolean };/** Parse a COLLABORATION_COMPLETED payload into the finalization request. */
export function parseCollabCompletedAction(payload: unknown): CollabCompletedAction {
  const p = payload as Parameters<typeof classifyCollaborationOutcome>[0] & { collaborationId?: unknown } | undefined;
  if (!p || typeof p.collaborationId !== 'string') return { kind: 'none' };
  // Same outcome classification as the reputation tracker (success / partial
  // / failure): only a true failure fails the session; partial completes.
  return {
    kind: 'finalize',
    collaborationId: p.collaborationId,
    failed: classifyCollaborationOutcome(p) === 'failure',
  };
}/** What a DEVICE_OPERATION_EXECUTED event asks the runtime to do. */
export type DeviceOperationAction =
  | { kind: 'skip' }
  | { kind: 'recheck'; deviceId: string; payload: Record<string, unknown> }
  | { kind: 'attribute'; deviceId: string; agentId?: string };/** Parse a DEVICE_OPERATION_EXECUTED payload into the routing decision. */
export function parseDeviceOperationAction(
  payload: unknown,
  isFaulted: (deviceId: string) => boolean,
): DeviceOperationAction {
  const p = payload as {
    deviceId?: unknown;
    agentId?: unknown;
    success?: unknown;
    error?: unknown;
  } | undefined;
  if (typeof p?.deviceId !== 'string') return { kind: 'skip' };
  const failed = p.success === false || p.error !== undefined;
  if (!failed) {
    // Fix-12: a SUCCESSFUL temperature-class command is not yet a successful
    // treatment — schedule the before/after zone recheck.
    return { kind: 'recheck', deviceId: p.deviceId, payload: p as Record<string, unknown> };
  }
  // A fault-caused failure was already counted at the seam (DEVICE_ERROR).
  if (isFaulted(p.deviceId)) return { kind: 'skip' };
  return {
    kind: 'attribute',
    deviceId: p.deviceId,
    agentId: typeof p.agentId === 'string' ? p.agentId : undefined,
  };
}
/**
 * R30 extraction (from EngineRuntime.coerceEventValue — identical
 * semantics): coerce a scenario event value to the number|boolean physics
 * expects. Strings parse as numbers or throw a teaching error naming the
 * event type.
 */
export function coerceEventValue(
  value: number | boolean | string,
  eventType: string,
): number | boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) return numeric;
  throw new Error(
    `EngineRuntime.injectEvent: value "${value}" for event type "${eventType}" ` +
    `is not numeric; physical parameters accept numbers or booleans only`,
  );
}

/**
 * R40-A3（认知架构 §7.5 升级通道）：把一条被升级的决策整成 AGENT_ESCALATION
 * 总线事件（发布方式对齐 DEVICE_ERROR 等）。升级 = 只通知不执行：payload
 * 只携带说明性数据（严重度/置信/原因/zone），不带任何设备命令。未升级的
 * assessment 返回 null（调用方免判断）。
 */
export function buildAgentEscalationEvent(
  runtimeId: string,
  agentId: string,
  eventId: string,
  event: { type: string; metadata?: Record<string, unknown> },
  assessment: {
    decision: string;
    escalated?: boolean;
    escalationCondition?: string;
    cognitiveDecision?: { situation: { severity: number }; uncertainty: { overall: number } };
  },
  zoneId: string | undefined,
): Omit<SystemEvent, 'id' | 'timestamp'> | null {
  if (assessment.escalated !== true) return null;
  const eventType = (event.metadata?.eventType as string | undefined) ?? event.type;
  return {
    type: EventType.AGENT_ESCALATION,
    source: `engine-runtime:${runtimeId}`,
    priority: EventPriority.HIGH,
    payload: {
      agentId,
      eventId,
      eventType,
      decision: assessment.decision,
      severity: assessment.cognitiveDecision?.situation.severity,
      confidence: assessment.cognitiveDecision?.uncertainty.overall,
      reason: assessment.escalationCondition,
      ...(zoneId !== undefined ? { zoneId } : {}),
    },
    metadata: {
      eventType: 'agent.escalation',
      ...(zoneId !== undefined ? { zoneId } : {}),
    },
  };
}

/**
 * R40-A2 尺寸整理（verbatim move from EngineRuntime.onReputationCollaboration
 * Completed）：分类一条 COLLABORATION_COMPLETED 并喂给声誉 tracker。无关的
 * completion 事件（无 collaborationId）与缺 participants/capabilities 的
 * 直接跳过；ac-proposal 记住的能力作 fallback，用后即删。
 */
export function feedReputationFromCompletion(
  event: SystemEvent,
  reputation: {
    recordCollaborationOutcome: (input: {
      participants: string[];
      capabilities: string[];
      outcome: ReturnType<typeof classifyCollaborationOutcome>;
    }) => void;
  },
  acCapabilities: Map<string, string[]>,
): void {
  const payload = event.payload as {
    collaborationId?: unknown;
    success?: boolean;
    participants?: unknown;
    requiredCapabilities?: unknown;
    results?: { goals?: Array<{ achieved?: boolean }>; participants?: unknown };
    goals?: Array<{ achieved?: boolean }> | number;
  } | undefined;
  // Unrelated completion events (e.g. ResourceNegotiator) carry no
  // collaborationId — they are not AC outcomes.
  if (!payload || typeof payload.collaborationId !== 'string') return;

  const outcome = classifyCollaborationOutcome(payload);
  const participants = Array.isArray(payload.participants)
    ? payload.participants.filter((p): p is string => typeof p === 'string')
    : Array.isArray(payload.results?.participants)
      ? (payload.results.participants as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
  const capabilities = Array.isArray(payload.requiredCapabilities)
    ? payload.requiredCapabilities.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : acCapabilities.get(payload.collaborationId) ?? [];
  acCapabilities.delete(payload.collaborationId);

  if (participants.length === 0 || capabilities.length === 0) return;
  reputation.recordCollaborationOutcome({ participants, capabilities, outcome });
}


/**
 * injectEvent 的审计段（R102 抽取，行为逐行保持）：构造注入记录（路由答案 +
 * 事件 id + 注入者随记录落账）、推入运行时注入日志（环形，封顶
 * MAX_SNAPSHOT_INJECTED_EVENTS——快照 injectedEvents 面的数据源）、通知全部
 * 监听者（R14 事件 tally）。监听者异常吞掉（不阻断注入，onFlowRun 惯例）。
 * 返回记录（调用方如需）。确定性、无引擎状态、无 IO。
 */
export function reportInjectedEvent(args: {
  input: InjectEventInput;
  parameter: string;
  value: number | boolean;
  targetAgentIds: readonly string[];
  /** R103: which fallback level of the PM-ruled chain answered (route audit). */
  routingLevel?: EventRouteLevel;
  eventId: string;
  injectedBy?: string;
  /** T33 (R3): the injector's account id (absent = scenario-scheduled). */
  injectedById?: string;
  simTimeSec: number;
  log: InjectedEventRecord[];
  listeners: ReadonlyArray<(record: InjectedEventRecord) => void>;
  /** Listener-failure warn seam (L2 purity: no logger in shaping). */
  warn: (message: string) => void;
}): InjectedEventRecord {
  const record: InjectedEventRecord = {
    type: args.input.type,
    zoneId: args.input.zoneId,
    parameter: args.parameter,
    value: args.value,
    ...(args.input.severity !== undefined ? { severity: args.input.severity } : {}),
    targetAgentIds: [...args.targetAgentIds],
    ...(args.routingLevel !== undefined ? { routingLevel: args.routingLevel } : {}),
    eventId: args.eventId,
    ...(args.injectedBy !== undefined ? { injectedBy: args.injectedBy } : {}),
    ...(args.injectedById !== undefined ? { injectedById: args.injectedById } : {}),
    simTimeSec: args.simTimeSec,
  };
  args.log.push(record);
  if (args.log.length > MAX_SNAPSHOT_INJECTED_EVENTS) args.log.shift();
  for (const listener of args.listeners) {
    try {
      listener(record);
    } catch (error) {
      args.warn(`Injected-event listener failed (non-fatal): ${(error as Error).message}`);
    }
  }
  return record;
}

/**
 * injectEvent 的 flow 通知段（R102 抽取，行为逐行保持）：事件触发的 flow
 * 在物理写之后、agent 看到事件之前求值（flow 的 actuation 先落地，agent 的
 * AC 决策读到其作用）；onConditionPoint 让条件在 agent 清场前读到写入
 * （R40-C1/R99）。await 保持确定性手动步进。
 */
export async function notifyFlowsOfEvent(args: {
  flowEngine: {
    onEvent(event: {
      eventType: string;
      zoneId: string;
      parameter: string;
      newValue: number | boolean;
      severity?: string;
      simTimeSec: number;
    }): Promise<void>;
    onConditionPoint(simTimeSec: number): Promise<void>;
  } | null;
  input: InjectEventInput;
  parameter: string;
  value: number | boolean;
  simTimeSec: number;
}): Promise<void> {
  if (!args.flowEngine) return;
  await args.flowEngine.onEvent({
    eventType: args.input.type,
    zoneId: args.input.zoneId,
    parameter: args.parameter,
    newValue: args.value,
    severity: args.input.severity,
    simTimeSec: args.simTimeSec,
  });
  await args.flowEngine.onConditionPoint(args.simTimeSec);
}

/**
 * injectEvent 的投递段（R91 抽取，行为逐行保持）：并发 fan-out 给全部
 * 管理 Agent（Wave A1），可选截止竞争 —— 截止先到而投递未完时返回
 * decisionPending，投递在后台继续。
 */
export async function deliverInjectedEvent(args: {
  eventId: string;
  originType: string;
  eventPayload: Record<string, unknown>;
  severity?: string;
  runtimeId: string;
  targetAgentIds: readonly string[];
  agents: ReadonlyMap<string, { handleEvent(event: SystemEvent): Promise<void> }>;
  markInflight: () => void;
  clearInflight: () => void;
  deliveryDeadlineMs?: number;
}): Promise<{ decisionPending: boolean; backgroundError?: string }> {
  args.markInflight();
  let deliveriesSettled = false;
  const deliveries: Promise<void> = (async () => {
    try {
      // Wave A1: 并发投递（顺序 fan-out 会让首个 scenario agent 抢占判定，
      // 见 EngineRuntime 注释）。
      await Promise.all(args.targetAgentIds.map(agentId => {
        const agent = args.agents.get(agentId);
        if (!agent) return Promise.resolve();
        return agent.handleEvent(buildInjectedSystemEvent({
          eventId: args.eventId,
          agentId,
          runtimeId: args.runtimeId,
          eventType: EventType.ENVIRONMENT_PARAM_CHANGED,
          originType: args.originType,
          payload: args.eventPayload,
          severity: args.severity,
        }));
      }));
    } finally {
      deliveriesSettled = true;
    }
  })();

  const deadlineMs = args.deliveryDeadlineMs;
  if (deadlineMs !== undefined && Number.isFinite(deadlineMs) && deadlineMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    const bounded = await Promise.race([
      deliveries.then(() => 'delivered' as const),
      new Promise<'pending'>(resolve => {
        timer = setTimeout(() => resolve('pending'), deadlineMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (bounded === 'pending' && !deliveriesSettled) {
      deliveries.then(args.clearInflight, (error: unknown) => {
        args.clearInflight();
      });
      return {
        decisionPending: true,
        backgroundError: `background agent delivery pending after deadline for event ${args.eventId}`,
      };
    }
  }

  try {
    await deliveries;
  } finally {
    args.clearInflight();
  }
  return { decisionPending: false };
}
