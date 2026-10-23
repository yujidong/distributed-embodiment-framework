/**
 * FlowEngine — runtime driver for user-orchestrated business flows.
 *
 * One FlowEngine per EngineRuntime. It evaluates flow triggers against
 * injected events (`onEvent`) and sim-time ticks (`onTick`), and executes
 * matched flows through the deterministic PlanExecutor with statically
 * resolved assignments (resolveFlowAssignments) and the own-devices-only
 * node invoker (createFlowNodeInvoker).
 *
 * Trigger semantics:
 *   - event:     fires when an injected event matches every DECLARED
 *                selector (eventType/zoneId/parameter — undeclared = wildcard)
 *                AND all conditions hold against the zone snapshot (the
 *                injected value merged in). Level-triggered: every matching
 *                event fires the flow.
 *   - condition: EDGE-triggered — fires only when the AND of its conditions
 *                transitions from not-true to true between ticks, with an
 *                optional sim-time cooldown suppressing re-fires.
 *   - schedule:  `atSimTimeSec` fires once when sim time reaches it;
 *                `everySimSec` fires whenever the (lastTick, thisTick]
 *                interval crosses a multiple of the period (from
 *                `startAtSimTimeSec`, default 0, until `endAtSimTimeSec`),
 *                at most once per tick even if the tick spans several
 *                periods. FEAT-01 daily anchors: `atTimeOfDaySec` fires once
 *                per sim day at day*86400 + atTimeOfDaySec, and
 *                `relativeToOccupancy` fires once per (zone, boundary, day)
 *                offsetSec BEFORE the occupantSchedule boundary — both use
 *                the same (prev, cur] crossing rule and a per-day fired
 *                memory (checkpointed).
 *
 * Condition snapshots: conditions are evaluated against the envStateReader
 * snapshot (`{ zoneId: { param: value } }`) with the trigger zone's
 * parameters ALSO hoisted to the top level — so both 'temperature > 30'
 * and 'zone-a.temperature > 30' resolve. Unresolvable paths are false
 * (conservative, same as plan-node guards).
 *
 * Execution is serialized through an internal promise chain: concurrent
 * triggers (an event injection and a tick, two events in flight) never run
 * two flows at once, and the fire-and-forget onTick path cannot re-enter.
 * The whole engine NEVER throws — every failure becomes a FLOW_EXECUTED
 * event with status 'failed' and an onRun record.
 *
 * Node lanes (FEAT-05/06): beyond action/delegate/service nodes, a plan may
 * carry NOTIFY nodes (delivered through the host's injected notification
 * lane — honest failure when unwired) and WAIT nodes (a deterministic
 * sim-clock delay: the run executes in waves split at wait nodes, parks as
 * a checkpointable FlowWaitContinuation between waves, and resumes from
 * onTick when the due sim second arrives — a paused world never counts
 * down). A parked run's ledger row lands ONLY when the run finishes; the
 * direct caller gets a non-persisted intermediate record with status
 * 'waiting'.
 *
 * Dynamism: the flowsProvider is re-read at every evaluation, so flows
 * edited/enabled/disabled through the server take effect immediately
 * without rebuilding the engine.
 */

import { randomUUID } from 'node:crypto';

import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import { capabilityMatches } from '../utils/capabilityMatching.js';
import type { ScenarioDefinition } from '../scenario/scenario-types.js';
import { PlanExecutor, type EnvStateReader, type PlanNodeInvocation, type PlanNodeInvoker, type PlanNodeInvokeContext, type PlanNodeResult } from '../workflow/plan-executor.js';
import type { PlanNode, WorkflowPlan } from '../workflow/plan-schema.js';
import {
  describeFlowConditions,
  interpolateFlowInputs,
  resolveFlowRunParams,
  type FlowConditionEvaluation,
  type FlowDefinition,
  type FlowPolicyEnvelope,
} from './flow-types.js';
import {
  FLOW_SERVICE_NODE_ASSIGNEE,
  ownerEligibleForFlowAuthor,
  resolveFlowAssignments,
} from './flow-invoker.js';
import {
  createDelegateDispatchingInvoker,
  type DelegateBudgetDevice,
  type DelegateRunnerDeps,
} from './flow-delegate.js';

// ============================================================================
// Types
// ============================================================================

/** Event payload handed to onEvent (mirrors EngineRuntime's injection input). */
export interface FlowEventInput {
  eventType: string;
  zoneId: string;
  parameter?: string;
  newValue?: unknown;
  severity?: string;
  /**
   * Fix-44f: sim time of the injection, used by the event-trigger cooldown.
   * EngineRuntime always passes its current simTimeSec.
   */
  simTimeSec?: number;
}

export type FlowRunStatus = 'success' | 'partial' | 'failed' | 'waiting';

/**
 * What fired a flow: its own trigger kind, 'manual' for an explicit operator
 * invocation (triggerManually — the flow's own trigger is bypassed), or
 * 'service' for a flow-service agreement invocation (Mechanism D — same
 * bypass semantics as manual, attributed to the invoking agreement by the
 * server's invocation core), or 'agent' for a governed agent decision
 * invocation (Mechanism B — FlowEngine.runAsAgent; the flow must be
 * agent-invocable and the agent inside the author's T-201 scope, and the
 * run is attributed to the deciding agent + event on the ledger).
 */
export type FlowRunTriggerKind = FlowDefinition['trigger']['kind'] | 'manual' | 'service' | 'agent';

/**
 * R6-B-F03 (cross-owner orchestration carrier): the service-node execution
 * seam. A SERVICE node (node.service) never touches the own-devices invoker
 * — it is dispatched to THIS injected lane, which the host (the server)
 * implements as an agreement-mediated invocation: resolve the flow author's
 * ACTIVE agreement on the referenced service, then run the unified
 * invocation core (quota / terms.action / audit / metering — orchestration
 * never bypasses governance). Like every invoker it must not throw; a
 * failure is reported as `{ success: false, error }` with the honest,
 * teaching reason (no active agreement → "sign one first").
 *
 * Omitted (core-only runtimes, legacy scenario sims) = service nodes fail
 * honestly ("no service-invocation lane wired"), never silently skipped.
 */
export type FlowServiceInvoker = (
  node: PlanNode,
  context?: PlanNodeInvokeContext,
) => Promise<PlanNodeInvocation>;

/**
 * FEAT-05 (deterministic notify lane): the notify-node execution seam. A
 * NOTIFY node (node.notify) never touches the own-devices invoker — it is
 * dispatched to THIS injected lane, which the host (the server) implements
 * as an inbox delivery through the environment's notification pipeline
 * (to='agent' resolves the agent's owner user; to='role' resolves every env
 * member with the role; to='owner' resolves the environment owner). Like
 * every invoker it must not throw; a failure is reported as
 * `{ success: false, error }` with the honest, teaching reason (unknown
 * agent, empty role, no pipeline wired). The recipients / notification ids
 * ride `result` so the run ledger shows WHO was reached.
 *
 * Omitted (core-only runtimes, legacy scenario sims) = notify nodes fail
 * honestly ("no notification lane wired"), never silently skipped.
 */
export type FlowNotifyInvoker = (
  node: PlanNode,
  context?: PlanNodeInvokeContext,
) => Promise<PlanNodeInvocation>;

/**
 * Mechanism B: attribution stamped on every agent-triggered run — WHICH
 * agent's decision invoked the flow and (when known) the in-flight event
 * that decision answered, so the run ledger joins back to the decision
 * record stream (agentId + eventId are its natural key).
 */
export interface FlowRunInvocationAttribution {
  agentId: string;
  eventId?: string;
}

/**
 * Mechanism B: the outcome of a governed agent invocation. 'refused' carries
 * the teaching reason (flag off / disabled / unknown flow / out of the
 * author scope) — a refusal is a PRE-RUN gate (no run record lands, same as
 * a disabled manual run); the deciding agent's record carries the reason.
 * 'invoked' always carries a completed run record — which may itself be
 * FAILED (e.g. invalid params honestly failing the inputs oracle, or an
 * unsatisfiable assignment refusing mid-run: the agent DID invoke).
 */
export type AgentFlowInvocationOutcome =
  | { status: 'invoked'; run: FlowRunRecord }
  | { status: 'refused'; reason: string };

/**
 * T-061: what the trigger SAW when it fired — the matched event (for event
 * triggers) and per-condition {path, evaluatedValue, threshold, met} detail
 * (for event/condition triggers with conditions). Attached to every run
 * record and flow.executed event so threshold authoring can compare the
 * evaluated dynamic (custom baseline quantities included) against the
 * declared threshold instead of guessing.
 */
export interface FlowTriggerEvaluation {
  kind: FlowRunTriggerKind;
  zoneId?: string;
  /** Matched injected event (event triggers only). */
  event?: {
    eventType: string;
    zoneId: string;
    parameter?: string;
    newValue?: unknown;
  };
  /** Sim time of the evaluation, when known. */
  simTimeSec?: number;
  /** Per-condition detail; empty for triggers without conditions. */
  conditions: FlowConditionEvaluation[];
}

/**
 * Mechanism C: one budget-exhaustion refusal the envelope escalated. Present
 * on the run record ONLY when the envelope declares onBudgetExhausted:
 * 'escalate' AND at least one delegate node was refused — 'fallback' mode
 * stays silent (each refusal already rides the node's own degraded result
 * with fallbackReason 'budget-exhausted'). Escalation only signals (the host
 * turns this into a notification to the owner); it never modifies the flow.
 */
export interface FlowPolicyEscalation {
  kind: 'budget-exhausted';
  /** The delegate node refused by the envelope. */
  nodeId: string;
  /** Why, in one honest sentence. */
  message: string;
}

/**
 * T1 (R2, u3-F1): one capability-drift annotation on a run. A flow node's
 * execution truth is the assignee's DEVICE capabilities (the own-devices-only
 * invoker never consults the agent's declaration), so revoking a capability
 * DECLARATION does not stop execution — but governance (partner selection,
 * service discovery, scope-of-practice) reads the declaration. When the two
 * disagree, the run is "succeeding on borrowed authority" and MUST say so:
 * execution semantics stay unchanged (the deterministic-execution promise),
 * while the run record and the flow.executed payload carry this annotation so
 * no audit ever mistakes a drifted run for an authorized one. Service nodes
 * (agreement lane, not agent authority), delegate nodes, notify nodes and
 * wait nodes (no node-level capability) never drift.
 */
export interface FlowCapabilityDrift {
  /** The node that executed. */
  nodeId: string;
  /** The capability the node asked for. */
  capability: string;
  /** The agent the node was assigned to. */
  assigneeAgentId: string;
  /** The agent's CURRENT declared capability set (what the check ran against). */
  declaredCapabilities: string[];
}

/**
 * T1 (R2, u3-F1): the ONE capability-drift oracle shared by the runtime run
 * annotation and the server's read-side annotations (flow list / authoring).
 * For every action node with a resolved assignee: does the assignee's CURRENT
 * declared capability set cover node.capability (the same ONE matcher the
 * device/authorization sides use)? Undeclared → a drift entry. Service nodes
 * (agreement lane, not agent authority), delegate nodes, notify nodes and
 * wait nodes (no node-level capability) never drift. `declaredOf` returning undefined = unknown (the
 * agent vanished from the live world) — honestly no annotation rather than a
 * guess. Never throws.
 */
export function computeCapabilityDrift(
  flow: FlowDefinition,
  assignments: ReadonlyMap<string, string>,
  declaredOf: (agentId: string) => readonly string[] | undefined,
): FlowCapabilityDrift[] {
  const drift: FlowCapabilityDrift[] = [];
  for (const node of flow.plan.nodes) {
    if (
      node.service !== undefined ||
      node.delegate !== undefined ||
      node.notify !== undefined ||
      node.wait !== undefined
    ) {
      continue;
    }
    const agentId = assignments.get(node.id);
    if (agentId === undefined || agentId === FLOW_SERVICE_NODE_ASSIGNEE) continue;
    const declared = declaredOf(agentId);
    if (declared === undefined) continue;
    if (declared.some(candidate => capabilityMatches(candidate, node.capability))) continue;
    drift.push({
      nodeId: node.id,
      capability: node.capability,
      assigneeAgentId: agentId,
      declaredCapabilities: [...declared],
    });
  }
  return drift;
}

/** One flow execution, delivered to the onRun callback (JSON-serializable). */export interface FlowRunRecord {
  runId: string;
  flowId: string;
  triggerKind: FlowRunTriggerKind;
  /** T-061: trigger evaluation detail (absent on legacy serialized records). */
  triggerEvaluation?: FlowTriggerEvaluation;
  /**
   * Mechanism D: the run's EFFECTIVE input params (caller values after
   * defaults) when the flow declares an inputs surface or a parameterized
   * entry point fired it. The run trace is auditable against the caller's
   * actual values.
   */
  inputs?: Record<string, unknown>;
  /** Mechanism C: exhaustion escalations (see FlowPolicyEscalation). */
  policyEscalations?: FlowPolicyEscalation[];
  /**
   * T1 (R2, u3-F1): capability-drift annotations — nodes whose capability the
   * assignee does NOT DECLARE (T36 wording: no temporal claim — it may never
   * have been declared; yet it still executed through the bound
   * device). Empty/absent = every node ran within the assignee's declared
   * authority. Present = the run succeeded (or failed) on authority the
   * assignee does not claim — audit-visible degradation, never a status
   * change.
   */
  capabilityDrift?: FlowCapabilityDrift[];
  /** Mechanism B: agent-decision attribution (triggerKind 'agent' runs). */
  invokedBy?: FlowRunInvocationAttribution;
  /**
   * FEAT-06: present ONLY on the intermediate record returned to a direct
   * caller (runDirect) when the run parked on a wait node — the run is not
   * finished; the FINAL record (same runId, terminal status) is emitted
   * through onRun once the last wait resumes and the remaining nodes
   * execute. The parked record is never persisted/published, so the run
   * ledger holds exactly one row per run.
   */
  waiting?: {
    /** Sim time the earliest pending wait resumes at. */
    resumeAtSimSec: number;
    /** Nodes not yet executed (pending waits + their downstream). */
    pendingNodeIds: string[];
  };
  status: FlowRunStatus;
  summary: string;
  nodeResults: Record<string, PlanNodeResult>;
  startedAt: string;
  finishedAt: string;
}

export interface FlowEngineOptions {
  scenario: ScenarioDefinition;
  /** Re-read at every trigger evaluation (dynamic enable/edit). */
  flowsProvider: () => FlowDefinition[];
  agents: ReadonlyMap<string, CognitiveAgent>;
  invoker: PlanNodeInvoker;
  envStateReader: EnvStateReader;
  /** Bus publish seam (EngineRuntime wires it to the EventManager). */
  publish: (type: string, payload: Record<string, unknown>) => void;
  /**
   * T-051 (arch-audit corrective): the executability oracle the AUTHORING
   * pass (server assertFlowValid) validates with — simulation's
   * isCapabilityExecutable. The runtime's own resolveFlowAssignments call
   * used to omit it, so authoring and runtime ambiguity/executability
   * verdicts could DIVERGE: a flow that 422'd at authoring (declared-but-
   * unexecutable capability, or an ambiguity that only exists when
   * non-executable devices are counted) could pass the runtime gate and
   * die mid-run — and vice versa. Injected by the host app (core cannot
   * depend on simulation); omitted = legacy declared-means-executable.
   */
  isExecutableCapability?: (capabilityName: string) => boolean;
  /**
   * Mechanism A (mixed-initiative flows): the delegate runner seam — the ONLY
   * place an LLM may enter flow execution. PlanExecutor stays model-free;
   * delegate nodes are dispatched to runDelegateNode behind this injected
   * invoker composition (EngineRuntime wires llmClientFor from
   * llmPerAgent/llmClient and threads the T-022 llmFailure policy). Flows
   * WITHOUT delegate nodes never touch this path (bit-identical behavior).
   * Omitted = delegate nodes fail honestly ("no delegate runner wired").
   */
  delegateRunner?: DelegateRunnerDeps;
  /**
   * R6-B-F03: the agreement-mediated service-node lane (see
   * FlowServiceInvoker). Flows WITHOUT service nodes never touch this path
   * (bit-identical behavior). Also late-settable via setServiceInvoker —
   * the server wires it post-construction (the registry seam pattern),
   * where the agreement stores exist.
   */
  serviceInvoker?: FlowServiceInvoker;
  /**
   * FEAT-05: the notification-lane notify-node seam (see FlowNotifyInvoker).
   * Flows WITHOUT notify nodes never touch this path (bit-identical
   * behavior). Also late-settable via setNotifyInvoker — the server wires it
   * post-construction (the registry seam pattern), where the notification
   * store exists.
   */
  notifyInvoker?: FlowNotifyInvoker;
  /**
   * T-502 (EC24-F02): budget-device inventory lookup for ACTUATING delegate
   * prompts — per budget deviceId, identity (name/type/zone) plus current
   * state when cheaply available. Wired by EngineRuntime from its live
   * device map; omitted = the pre-T-502 identity-less budget block (advice
   * prompts never consult it).
   */
  budgetDeviceOf?: (deviceId: string) => DelegateBudgetDevice | undefined;
  /**
   * R1 (B1-9 / P-19): the stale-simulation probe. When the UNSAT gate fails
   * a flow against this engine's FROZEN scenario, the host can answer
   * "does it resolve against the CURRENT environment content?" — true means
   * the environment changed after the simulation was created, and the run
   * record's summary says so (FLOW_STALE_SIMULATION guidance, the same
   * diagnosis the manual run lane's 409 carries) instead of a bare UNSAT
   * that sends the operator editing capability declarations. Omitted =
   * legacy bare-refusal summaries (core-only consumers, scenario sims).
   */
  staleFlowProbe?: (flow: FlowDefinition) => boolean;
  /**
   * T1 (R2, u3-F1): the agent-declaration probe — the agent's CURRENT
   * declared capability set, read live (the server wires it from the env
   * store so a revocation made AFTER this simulation was created is still
   * seen; the frozen scenario alone cannot, its declarations froze at sim
   * creation). Omitted = the frozen scenario's declarations are the best
   * known truth (core-only consumers, scenario sims).
   */
  declaredAgentCapabilities?: (agentId: string) => readonly string[] | undefined;
  executor?: PlanExecutor;
  /** Clock for run records (default: real ISO time). */
  now?: () => string;
  onRun?: (record: FlowRunRecord) => void;
}

/** Bus event types (string form; EventType enum values in shared/events). */
export const FLOW_EVENT_TYPES = {
  TRIGGERED: 'flow.triggered',
  EXECUTED: 'flow.executed',
} as const;

/** Sim seconds per day — the FEAT-01 time-of-day anchor unit. */
const DAY_SEC = 86400;

/**
 * FEAT-01: the time-of-day active-window predicate (pure). start ≤ end is a
 * plain [start, end) window; start > end crosses midnight (22:00–06:00 =
 * [79200, 21600]). No window declared = always open.
 */
export function isWithinActiveWindow(
  window: [number, number] | undefined,
  simTimeSec: number,
): boolean {
  if (window === undefined) return true;
  const [start, end] = window;
  const timeOfDay = ((simTimeSec % DAY_SEC) + DAY_SEC) % DAY_SEC;
  return start <= end
    ? timeOfDay >= start && timeOfDay < end
    : timeOfDay >= start || timeOfDay < end;
}

/**
 * FEAT-06: a run parked on a wait node, as plain data (checkpoint payload —
 * a hibernated world resumes its pending waits instead of losing them).
 * Everything needed to rebuild the run's execution lane at the due tick
 * lives here; the flow DEFINITION is re-read from the flowsProvider at
 * resume (same dynamism discipline as triggers — an edited flow resumes in
 * its edited form, a deleted/disabled one fails honestly).
 */
export interface FlowWaitContinuation {
  runId: string;
  flowId: string;
  triggerKind: FlowRunTriggerKind;
  triggerEvaluation?: FlowTriggerEvaluation;
  /** flow.inputs !== undefined at run start (re-interpolate at resume). */
  hadInputs: boolean;
  /** Mechanism C envelope mode at run start (the flow may vanish before resume). */
  escalateOnExhaustion: boolean;
  /** Mechanism D effective run params (present when the run carried any). */
  inputs?: Record<string, unknown>;
  invokedBy?: FlowRunInvocationAttribution;
  startedAt: string;
  capabilityDrift?: FlowCapabilityDrift[];
  policyEscalations: FlowPolicyEscalation[];
  /** Mechanism C budget counter consumed by the waves executed so far. */
  delegationsUsed: number;
  /** Advice outputs promoted so far (delegate.<nodeId>.<key> namespace). */
  delegateOutputs: Record<string, unknown>;
  /** Node results accumulated across the executed waves. */
  results: Record<string, PlanNodeResult>;
  /** Wait nodes armed but not yet due (nodeId → due sim sec). */
  armedWaits: Array<{ nodeId: string; dueSimSec: number }>;
  /** Ids of nodes already executed (including armed wait nodes). */
  executedNodeIds: string[];
}

/**
 * Living-worlds P0: plain-data trigger-state snapshot (checkpoint payload).
 * Map entries as arrays (JSON round-trip safe, insertion order preserved —
 * the fingerprint memories are keyed per flow id, see Fix-44d).
 */
export interface FlowEngineStateExport {
  /** Condition-edge memory: flowId → { trigger fingerprint, last level }. */
  conditionState: Array<[string, { fp: string; value: boolean; falseSince?: number; armed?: boolean }]>;
  /** Cooldown memory: flowId → { trigger fingerprint, fired-at sim sec }. */
  lastFiredAtSimSec: Array<[string, { fp: string; at: number }]>;
  /** One-shot schedule markers: flowId → trigger fingerprint that fired. */
  scheduleFired: Array<[string, string]>;
  /**
   * FEAT-01: daily-anchor fired memory — flowId → { trigger fingerprint,
   * fired keys (`tod:<day>` / `rel:<zoneId>:<arrive|depart>:<day>`) }.
   * Absent in pre-FEAT-01 checkpoints (restore tolerates the gap).
   */
  scheduleDailyFired?: Array<[string, { fp: string; keys: string[] }]>;
  /** Previous tick's sim time (schedule (prev, cur] window anchor). */
  lastTickSimSec: number | undefined;
  /**
   * FEAT-06: runs parked on wait nodes. Absent in pre-FEAT-06 checkpoints
   * (restore tolerates the gap — a world hibernated mid-wait before this
   * field existed simply had no waits to lose).
   */
  waitContinuations?: FlowWaitContinuation[];
}

/** Defensive checkpoint-entry coercion: undefined/null/非数组 → []. */
function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ============================================================================
// FlowEngine
// ============================================================================

export class FlowEngine {
  private readonly scenario: ScenarioDefinition;
  private readonly flowsProvider: () => FlowDefinition[];
  private readonly invoker: PlanNodeInvoker;
  private readonly envStateReader: EnvStateReader;
  private readonly publish: (type: string, payload: Record<string, unknown>) => void;
  private readonly isExecutableCapability?: (capabilityName: string) => boolean;
  private readonly delegateRunner?: DelegateRunnerDeps;
  /** R6-B-F03: late-settable (the registry seam wires it post-construction). */
  private serviceInvoker?: FlowServiceInvoker;
  /** FEAT-05: late-settable (same registry seam pattern). */
  private notifyInvoker?: FlowNotifyInvoker;
  /** FEAT-06: runs parked on wait nodes (at most one entry per runId). */
  private readonly waitContinuations: FlowWaitContinuation[] = [];
  /** R1 (B1-9): late-settable stale probe (see FlowEngineOptions). */
  private staleFlowProbe?: (flow: FlowDefinition) => boolean;
  /** T1 (R2): late-settable declaration probe (see FlowEngineOptions). */
  private declaredAgentCapabilities?: (agentId: string) => readonly string[] | undefined;
  private readonly budgetDeviceOf?: (deviceId: string) => DelegateBudgetDevice | undefined;
  private readonly executor: PlanExecutor;
  private readonly now: () => string;
  private readonly onRun?: (record: FlowRunRecord) => void;

  /** Serial execution chain — runs never overlap (re-entrancy guard). */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Fix-44d: trigger-state memories are keyed by flow id AND the trigger
   * definition's fingerprint. An edit that changes the trigger (e.g. moving a
   * one-shot's atSimTimeSec) re-arms the flow instead of being silently
   * swallowed by stale one-shot/edge memory from the previous definition —
   * the documented "编辑对运行中的仿真即时生效" now holds for state, too.
   */
  /**
   * T-107: the memo carries the re-arm state — `falseSince` is the sim time
   * the predicate's CURRENT false streak began, `armed` is false between a
   * fire and a long-enough false streak (the hysteresisSimC window).
   */
  private readonly conditionState = new Map<
    string,
    { fp: string; value: boolean; falseSince?: number; armed?: boolean }
  >();
  private readonly lastFiredAtSimSec = new Map<string, { fp: string; at: number }>();
  private readonly scheduleFired = new Map<string, string>();
  /**
   * FEAT-01: daily-anchor fired memory (fingerprinted like the other
   * memories — an edited trigger re-arms). Keys: `tod:<day>` for
   * atTimeOfDaySec, `rel:<zoneId>:<arrive|depart>:<day>` for
   * relativeToOccupancy. Pruned to the current day window on each fire.
   */
  private readonly scheduleDailyFired = new Map<string, { fp: string; keys: Set<string> }>();
  /** Previous tick's sim time for schedule crossing detection. */
  private lastTickSimSec: number | undefined;

  /** Stable definition fingerprint for a trigger (plain data; JSON is fine). */
  private static triggerFingerprint(trigger: FlowDefinition['trigger']): string {
    try {
      return JSON.stringify(trigger);
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Living-worlds P0: trigger-state checkpoint seam (design-living-worlds.md
  // §9 — the checkpoint captures flow ENGINE state so a resumed world does not
  // re-fire edges/cooldowns/one-shots that already happened).
  // -------------------------------------------------------------------------

  /**
   * Snapshot the trigger-state memories as plain data. Everything here is
   * deterministic state: the condition-edge memory ({fp, value} per flow),
   * the cooldown memory ({fp, at} in sim seconds), the one-shot schedule
   * firing markers, and the previous-tick sim time that anchors periodic
   * (prev, cur] window crossing — without it a resumed engine treats prev as
   * 0 and refires a period boundary that already fired.
   */
  exportTriggerState(): FlowEngineStateExport {
    return {
      conditionState: [...this.conditionState.entries()],
      lastFiredAtSimSec: [...this.lastFiredAtSimSec.entries()],
      scheduleFired: [...this.scheduleFired.entries()],
      scheduleDailyFired: [...this.scheduleDailyFired.entries()].map(([flowId, memo]) => [
        flowId,
        { fp: memo.fp, keys: [...memo.keys] },
      ]),
      lastTickSimSec: this.lastTickSimSec,
      // FEAT-06: parked wait runs — plain data already; deep-copy so a
      // resumed engine never shares mutable state with the snapshot.
      waitContinuations: this.waitContinuations.map(cont => ({
        ...cont,
        policyEscalations: cont.policyEscalations.map(e => ({ ...e })),
        delegateOutputs: { ...cont.delegateOutputs },
        results: Object.fromEntries(Object.entries(cont.results).map(([k, v]) => [k, { ...v }])),
        armedWaits: cont.armedWaits.map(w => ({ ...w })),
        executedNodeIds: [...cont.executedNodeIds],
        ...(cont.triggerEvaluation !== undefined
          ? { triggerEvaluation: { ...cont.triggerEvaluation, conditions: [...cont.triggerEvaluation.conditions] } }
          : {}),
        ...(cont.inputs !== undefined ? { inputs: { ...cont.inputs } } : {}),
        ...(cont.capabilityDrift !== undefined
          ? { capabilityDrift: cont.capabilityDrift.map(d => ({ ...d, declaredCapabilities: [...d.declaredCapabilities] })) }
          : {}),
        ...(cont.invokedBy !== undefined ? { invokedBy: { ...cont.invokedBy } } : {}),
      })),
    };
  }

  /**
   * Adopt a previously exported trigger state (hibernate → resume). Tolerant
   * of malformed entries (skip, keep fresh) — a checkpoint must never crash a
   * resume; the affected flow simply re-arms (Fix-44d semantics for an edited
   * trigger, the honest degradation for a torn entry).
   */
  restoreTriggerState(state: FlowEngineStateExport | null | undefined): void {
    if (!state) return;
    this.conditionState.clear();
    for (const [flowId, memo] of toArray<FlowEngineStateExport['conditionState'][number]>(state.conditionState)) {
      if (typeof flowId !== 'string' || memo === null || typeof memo !== 'object') continue;
      const fp = (memo as { fp?: unknown }).fp;
      const value = (memo as { value?: unknown }).value;
      if (typeof fp !== 'string' || typeof value !== 'boolean') continue;
      this.conditionState.set(flowId, { fp, value });
    }
    this.lastFiredAtSimSec.clear();
    for (const [flowId, memo] of toArray<FlowEngineStateExport['lastFiredAtSimSec'][number]>(state.lastFiredAtSimSec)) {
      if (typeof flowId !== 'string' || memo === null || typeof memo !== 'object') continue;
      const fp = (memo as { fp?: unknown }).fp;
      const at = (memo as { at?: unknown }).at;
      if (typeof fp !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) continue;
      this.lastFiredAtSimSec.set(flowId, { fp, at });
    }
    this.scheduleFired.clear();
    for (const [flowId, fingerprint] of toArray<FlowEngineStateExport['scheduleFired'][number]>(state.scheduleFired)) {
      if (typeof flowId !== 'string' || typeof fingerprint !== 'string') continue;
      this.scheduleFired.set(flowId, fingerprint);
    }
    this.scheduleDailyFired.clear();
    for (const [flowId, memo] of toArray<NonNullable<FlowEngineStateExport['scheduleDailyFired']>[number]>(state.scheduleDailyFired)) {
      if (typeof flowId !== 'string' || memo === null || typeof memo !== 'object') continue;
      const fp = (memo as { fp?: unknown }).fp;
      const keys = (memo as { keys?: unknown }).keys;
      if (typeof fp !== 'string' || !Array.isArray(keys)) continue;
      this.scheduleDailyFired.set(flowId, {
        fp,
        keys: new Set(keys.filter((key): key is string => typeof key === 'string')),
      });
    }
    this.lastTickSimSec = typeof state.lastTickSimSec === 'number' && Number.isFinite(state.lastTickSimSec)
      ? state.lastTickSimSec
      : undefined;
    // FEAT-06: parked wait runs. Tolerant of malformed entries (skip, keep
    // fresh) — a torn entry degrades to a lost continuation, never a crashed
    // resume. Deduplicated by runId (last writer wins, defensive).
    this.waitContinuations.length = 0;
    for (const cont of toArray<FlowWaitContinuation>(state.waitContinuations)) {
      if (cont === null || typeof cont !== 'object') continue;
      if (typeof cont.runId !== 'string' || typeof cont.flowId !== 'string') continue;
      if (!Array.isArray(cont.armedWaits) || !Array.isArray(cont.executedNodeIds)) continue;
      if (cont.results === null || typeof cont.results !== 'object') continue;
      this.waitContinuations.push({
        ...cont,
        policyEscalations: toArray<FlowPolicyEscalation>(cont.policyEscalations),
        delegationsUsed: typeof cont.delegationsUsed === 'number' ? cont.delegationsUsed : 0,
        delegateOutputs: cont.delegateOutputs ?? {},
        hadInputs: cont.hadInputs === true,
        escalateOnExhaustion: cont.escalateOnExhaustion === true,
      });
    }
  }

  /**
   * Living-worlds P1 (design-living-worlds.md §8.2): due-source view of the
   * trigger memories for due-moment computation. For each CURRENT definition
   * (the flows array is the engine's live provider snapshot, re-read by the
   * caller): whether its one-shot schedule already fired (fingerprint-matched
   * — an edited trigger re-arms, Fix-44d) and, when a cooldown is active, the
   * sim-sec it expires at. Pure read; never mutates the memories.
   */
  triggerDueState(
    flows: ReadonlyArray<Pick<FlowDefinition, 'id' | 'trigger'>>,
  ): Array<{ id: string; scheduleFired: boolean; cooldownUntilSimSec?: number }> {
    return flows.map(flow => {
      const fp = FlowEngine.triggerFingerprint(flow.trigger);
      const firedFor = this.scheduleFired.get(flow.id);
      const scheduleFired = firedFor !== undefined && firedFor === fp;
      let cooldownUntilSimSec: number | undefined;
      const cooldown = (flow.trigger as { cooldownSimSec?: number }).cooldownSimSec ?? 0;
      const lastFired = this.lastFiredAtSimSec.get(flow.id);
      if (cooldown > 0 && lastFired !== undefined && lastFired.fp === fp) {
        cooldownUntilSimSec = lastFired.at + cooldown;
      }
      return { id: flow.id, scheduleFired, ...(cooldownUntilSimSec !== undefined ? { cooldownUntilSimSec } : {}) };
    });
  }

  /**
   * FEAT-06: due sim-secs of the parked wait continuations (a due-moment
   * source for lazy worlds — a world sleeping until the next event/schedule
   * must still wake for a run whose wait expires). Pure read.
   */
  waitDueSimSecs(): number[] {
    const dues: number[] = [];
    for (const cont of this.waitContinuations) {
      if (cont.armedWaits.length === 0) continue;
      const due = Math.min(...cont.armedWaits.map(w => w.dueSimSec));
      if (Number.isFinite(due)) dues.push(due);
    }
    return dues;
  }

  constructor(options: FlowEngineOptions) {
    this.scenario = options.scenario;
    this.flowsProvider = options.flowsProvider;
    this.invoker = options.invoker;
    this.envStateReader = options.envStateReader;
    this.publish = options.publish;
    this.isExecutableCapability = options.isExecutableCapability;
    this.delegateRunner = options.delegateRunner;
    this.serviceInvoker = options.serviceInvoker;
    this.notifyInvoker = options.notifyInvoker;
    this.staleFlowProbe = options.staleFlowProbe;
    this.declaredAgentCapabilities = options.declaredAgentCapabilities;
    this.budgetDeviceOf = options.budgetDeviceOf;
    this.executor = options.executor ?? new PlanExecutor();
    this.now = options.now ?? (() => new Date().toISOString());
    this.onRun = options.onRun;
  }

  /**
   * R6-B-F03: late-binding for the service-node lane (the server's registry
   * seam pattern — agreement stores exist only after construction). The
   * CURRENT value is read per invocation, so flows authored after wiring
   * (and runtimes wired after flows exist) both work.
   */
  setServiceInvoker(invoker: FlowServiceInvoker): void {
    this.serviceInvoker = invoker;
  }

  /**
   * FEAT-05: late-binding for the notify-node lane (the server's registry
   * seam pattern — the notification store exists only after construction).
   * The CURRENT value is read per invocation, so flows authored after wiring
   * (and runtimes wired after flows exist) both work.
   */
  setNotifyInvoker(invoker: FlowNotifyInvoker): void {
    this.notifyInvoker = invoker;
  }

  /**
   * R1 (B1-9): late-binding for the stale-simulation probe — the server
   * wires it post-construction (the registry seam pattern) where the live
   * env store exists. The CURRENT value is read per run, so environment
   * edits after the wiring are seen by the next failed run.
   */
  setStaleFlowProbe(probe: (flow: FlowDefinition) => boolean): void {
    this.staleFlowProbe = probe;
  }

  /**
   * T1 (R2, u3-F1): late-binding for the declaration probe — same registry
   * seam pattern as the stale probe. The CURRENT value is read per run, so
   * a capability revocation after this sim was created annotates the next
   * run (the frozen scenario alone would keep asserting the stale grant).
   */
  setDeclaredAgentCapabilities(
    probe: (agentId: string) => readonly string[] | undefined,
  ): void {
    this.declaredAgentCapabilities = probe;
  }

  /**
   * The one dispatch every flow-lane node invocation goes through: NOTIFY
   * nodes route to the host's notification lane, SERVICE nodes route to the
   * agreement-mediated lane (never the own-devices invoker); everything
   * else runs the composed own-devices invoker. (WAIT nodes never reach
   * here — the run's segmented lane arms them on the sim clock instead.)
   * Never throws — an unwired lane is an honest node failure, not a skip.
   */
  private invokeNode(
    node: PlanNode,
    agentId: string,
    context?: PlanNodeInvokeContext,
  ): Promise<PlanNodeInvocation> {
    if (node.notify !== undefined) {
      const lane = this.notifyInvoker;
      if (lane === undefined) {
        return Promise.resolve({
          success: false,
          error:
            `flow node '${node.id}' notifies '${node.notify.to}' but this runtime has no ` +
            'notification lane wired (env-backed server simulations only) — the node cannot ' +
            'run here; deploy the flow in an environment with the notification pipeline, or drop the node',
        });
      }
      return lane(node, context).catch((error: unknown) => ({
        // Invokers must not throw; defend the seam anyway (a lane fault is an
        // honest node failure, never an engine fault).
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    if (node.service === undefined) {
      return this.invoker(node, agentId, context);
    }
    const lane = this.serviceInvoker;
    if (lane === undefined) {
      const target = node.service.serviceId ?? node.service.semanticType ?? '(untargeted)';
      return Promise.resolve({
        success: false,
        error:
          `flow node '${node.id}' invokes service '${target}' but this runtime has no ` +
          'service-invocation lane wired (env-backed server simulations only) — the node cannot ' +
          'run here; deploy the flow in an environment with the agreement lane, or drop the node',
      });
    }
    return lane(node, context).catch((error: unknown) => ({
      // Invokers must not throw; defend the seam anyway (a lane fault is an
      // honest node failure, never an engine fault).
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  /**
   * Evaluate event-triggered flows against an injected event. Awaits the
   * full execution of every matched flow (serialized through the queue), so
   * the caller (EngineRuntime.injectEvent) can guarantee flows run BEFORE
   * the event is delivered to agents. Never throws.
   */
  async onEvent(input: FlowEventInput): Promise<void> {
    let flows: FlowDefinition[];
    try {
      flows = this.flowsProvider() ?? [];
    } catch {
      return; // Provider fault must never break event injection
    }

    for (const flow of flows) {
      if (!flow.enabled || flow.trigger.kind !== 'event') continue;
      const trigger = flow.trigger;
      if (trigger.eventType !== undefined && trigger.eventType !== input.eventType) continue;
      if (trigger.zoneId !== undefined && trigger.zoneId !== input.zoneId) continue;
      if (trigger.parameter !== undefined && trigger.parameter !== input.parameter) continue;

      // T-061: evaluate WITH detail so the run trace records what each
      // condition saw (evaluated value vs declared threshold).
      const conditionDetail = describeFlowConditions(trigger.conditions, this.buildEventSnapshot(input));
      if (!conditionDetail.every(detail => detail.met)) continue;

      // Fix-44f: optional debounce for event triggers — external feeds
      // (twin-sync, HASS bindings) may inject matching parameter updates at
      // high frequency; without a cooldown one flow would run its whole plan
      // per event. Same sim-time semantics as the condition cooldown.
      const cooldown = trigger.cooldownSimSec ?? 0;
      if (cooldown > 0 && input.simTimeSec !== undefined) {
        const fp = FlowEngine.triggerFingerprint(trigger);
        const fired = this.lastFiredAtSimSec.get(flow.id);
        if (fired !== undefined && fired.fp === fp && input.simTimeSec - fired.at < cooldown) {
          continue; // suppressed by cooldown
        }
        this.lastFiredAtSimSec.set(flow.id, { fp, at: input.simTimeSec });
      }

      const triggerEvaluation: FlowTriggerEvaluation = {
        kind: 'event',
        ...(trigger.zoneId !== undefined ? { zoneId: trigger.zoneId } : { zoneId: input.zoneId }),
        event: {
          eventType: input.eventType,
          zoneId: input.zoneId,
          ...(input.parameter !== undefined ? { parameter: input.parameter } : {}),
          ...(input.newValue !== undefined ? { newValue: input.newValue } : {}),
        },
        ...(input.simTimeSec !== undefined ? { simTimeSec: input.simTimeSec } : {}),
        conditions: conditionDetail,
      };
      await this.enqueue(flow, 'event', triggerEvaluation);
    }
  }

  /**
   * Evaluate condition- and schedule-triggered flows at a sim-time tick.
   * Enqueues matched flows on the serial chain and returns a promise that
   * resolves when THIS tick's matches have executed; callers may await it
   * (tests, step()) or fire-and-forget it (the real-time tick loop) —
   * re-entrancy is impossible either way. Never throws.
   */
  async onTick(simTimeSec: number): Promise<void> {
    const prevTickSimSec = this.lastTickSimSec ?? 0;

    const pending: Array<Promise<unknown>> = [];

    // FEAT-06: resume runs whose wait nodes came due — BEFORE trigger
    // evaluation (a resumed wave may itself change the world the triggers
    // read), through the SAME serial queue (a continuation never overlaps
    // another run). Ticks do not advance while a run is parked: the wait
    // counts SIM seconds, so a paused world never resumes early. Each due
    // continuation is REMOVED from the parked list before enqueueing —
    // continueWaitRun re-parks it when a wait is still armed after its
    // wave, so a continuation is never enqueued twice.
    for (const cont of [...this.waitContinuations]) {
      if (cont.armedWaits.length === 0) continue;
      const due = Math.min(...cont.armedWaits.map(w => w.dueSimSec));
      if (due <= simTimeSec) {
        this.waitContinuations.splice(this.waitContinuations.indexOf(cont), 1);
        pending.push(this.enqueueContinuation(cont, simTimeSec));
      }
    }

    let flows: FlowDefinition[];
    try {
      flows = this.flowsProvider() ?? [];
    } catch {
      // Do NOT advance lastTickSimSec on a failed provider read — the tick
      // window (prev, cur] must stay open so the NEXT successful tick still
      // evaluates the schedule periods this one spanned (a transient store
      // fault used to permanently swallow every crossed schedule window).
      // Due continuations still drain (their own provider read is guarded).
      await Promise.all(pending);
      return;
    }
    // Advance only after a successful read: the windows are evaluated below.
    this.lastTickSimSec = simTimeSec;

    for (const flow of flows) {
      if (!flow.enabled) continue;

      if (flow.trigger.kind === 'condition') {
        const { fire, evaluation } = this.shouldFireCondition(flow, simTimeSec);
        if (fire) {
          pending.push(this.enqueue(flow, 'condition', evaluation));
        }
      } else if (flow.trigger.kind === 'schedule') {
        if (this.shouldFireSchedule(flow, prevTickSimSec, simTimeSec)) {
          pending.push(this.enqueue(flow, 'schedule', {
            kind: 'schedule',
            simTimeSec,
            conditions: [],
          }));
        }
      }
    }
    await Promise.all(pending);
  }

  /**
   * R40-C1 post-write snapshot point: evaluate CONDITION flows against the
   * world AS WRITTEN, before anything else can act on the same parameter.
   * The runtime calls this right after a parameter injection's physical
   * write and BEFORE agent fan-out — the R39 live probe found the agent
   * channel (awaited in the same injection) could clear the parameter
   * before the next onTick ever observed the edge, starving the flow
   * forever (kitchen smoke → rangehood). Shares the SAME evaluator and
   * condition state (edge memory / hysteresis / cooldown) as onTick, so a
   * snapshot fire is never double-counted by the next tick. Schedules are
   * deliberately NOT evaluated here — they own the tick timeline.
   */
  async onConditionPoint(simTimeSec: number): Promise<void> {
    let flows: FlowDefinition[];
    try {
      flows = this.flowsProvider() ?? [];
    } catch {
      return;
    }
    const pending: Array<Promise<unknown>> = [];
    for (const flow of flows) {
      if (!flow.enabled || flow.trigger.kind !== 'condition') continue;
      const { fire, evaluation } = this.shouldFireCondition(flow, simTimeSec);
      if (fire) {
        pending.push(this.enqueue(flow, 'condition', evaluation));
      }
    }
    await Promise.all(pending);
  }

  /**
   * Manually fire one flow by id (the server's operator-triggered run path).
   * The flow's OWN trigger is bypassed — the flow is looked up in the current
   * flowsProvider snapshot and enqueued immediately with triggerKind
   * 'manual'. Disabled flows never fire (same rule as automatic triggers).
   * Returns false when the flow is unknown or disabled; never throws.
   *
   * Mechanism D: `options.params` are the caller's run parameters, validated
   * against the flow's declared inputs surface by the SAME oracle the hosted
   * paths use (resolveFlowRunParams) — a surfaceless flow rejects params with
   * a refused run record (the server pre-validates for a teaching 4xx; this
   * is the engine's own honest gate).
   */
  async triggerManually(
    flowId: string,
    options?: { params?: Record<string, unknown> },
  ): Promise<boolean> {
    return (await this.runDirect(flowId, 'manual', options?.params)) !== null;
  }

  /**
   * Mechanism D: fire one flow by id with an explicit DIRECT trigger kind
   * ('manual' — the operator path; 'service' — a flow-service agreement
   * invocation; 'agent' — a governed agent decision, via runAsAgent) and
   * optional run params. Returns the completed FlowRunRecord
   * (inputs + nodeResults + status) so callers can chain metering to the run
   * ledger id, or null when the flow is unknown or disabled. Never throws.
   */
  async runDirect(
    flowId: string,
    triggerKind: 'manual' | 'service' | 'agent',
    params?: Record<string, unknown>,
    invokedBy?: FlowRunInvocationAttribution,
  ): Promise<FlowRunRecord | null> {
    let flows: FlowDefinition[];
    try {
      flows = this.flowsProvider() ?? [];
    } catch {
      return null; // Provider fault must never break the caller
    }
    const flow = flows.find(candidate => candidate.id === flowId);
    if (!flow || !flow.enabled) return null;
    return await this.enqueue(flow, triggerKind, undefined, params, invokedBy);
  }

  /**
   * Mechanism B (design-mixed-initiative-flows.md §6): execute one flow as a
   * GOVERNED agent action. The gates run BEFORE anything else, in order:
   * unknown agent → unknown/disabled flow → agentInvocable flag → T-201
   * author scope (same-tenant only; cross-tenant reuse is the Mechanism-D
   * flow-service/agreement lane). A refused invocation is a PRE-RUN verdict
   * (no run record) carrying a teaching reason; an accepted one executes
   * with triggerKind 'agent', params through the SAME inputs oracle the
   * manual/service lanes use, the assignment pass (author validation), and
   * — because it converges on runFlow like every other entry point — the
   * Mechanism-C policy envelope bounds it for free. Never throws.
   */
  async runAsAgent(
    flowId: string,
    agentId: string,
    params?: Record<string, unknown>,
    attribution?: { eventId?: string },
  ): Promise<AgentFlowInvocationOutcome> {
    const refused = (reason: string): AgentFlowInvocationOutcome => ({ status: 'refused', reason });
    const agent = this.scenario.agents.find(a => a.id === agentId);
    if (agent === undefined) {
      return refused(
        `agent '${agentId}' does not exist in this scenario — only scenario agents may invoke flows`,
      );
    }
    let flows: FlowDefinition[];
    try {
      flows = this.flowsProvider() ?? [];
    } catch {
      return refused(`the flow provider faulted — agent invocation of '${flowId}' was refused`);
    }
    const flow = flows.find(candidate => candidate.id === flowId);
    if (flow === undefined) {
      const offered = flows
        .filter(f => f.agentInvocable === true && ownerEligibleForFlowAuthor(agent.ownerUserId, f.authorUserId))
        .map(f => f.id);
      return refused(
        `unknown flow '${flowId}' — this agent's invocable flows: ${offered.length > 0 ? offered.join(', ') : '(none)'}`,
      );
    }
    if (!flow.enabled) {
      return refused(`flow '${flowId}' is disabled — enable it before an agent may invoke it`);
    }
    if (flow.agentInvocable !== true) {
      return refused(
        `flow '${flowId}' is not agent-invocable — set agentInvocable: true on the flow ` +
        '(agents may only invoke flows their owner explicitly opted in)',
      );
    }
    if (!ownerEligibleForFlowAuthor(agent.ownerUserId, flow.authorUserId)) {
      return refused(
        `agent '${agentId}' is outside the author scope of flow '${flowId}' (T-201) — ` +
        'agent invocation is same-tenant only; cross-tenant reuse runs through a flow-service ' +
        'agreement (publish the flow as a service and invoke it under an active agreement)',
      );
    }
    const run = await this.runDirect(flowId, 'agent', params, {
      agentId,
      ...(attribution?.eventId !== undefined ? { eventId: attribution.eventId } : {}),
    });
    // runDirect returns null only for unknown/disabled flows — both gated
    // above; a provider race (flow deleted mid-gate) degrades to a refusal.
    if (run === null) {
      return refused(`flow '${flowId}' is no longer runnable (removed or disabled mid-invocation)`);
    }
    return { status: 'invoked', run };
  }

  // ------------------------------------------------------------------------
  // Trigger internals
  // ------------------------------------------------------------------------

  /** Read the environment snapshot defensively (never throws). */
  private readEnv(): Record<string, unknown> {
    try {
      return this.envStateReader() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Snapshot for event-trigger conditions: the reader's snapshot with the
   * injected value merged into the event's zone, and that zone's parameters
   * hoisted to the top level so both 'temperature' and
   * 'zone-a.temperature' paths resolve.
   */
  private buildEventSnapshot(input: FlowEventInput): Record<string, unknown> {
    const env = this.readEnv();
    const zoneParams: Record<string, unknown> = {
      ...((env[input.zoneId] as Record<string, unknown> | undefined) ?? {}),
      ...(input.parameter !== undefined ? { [input.parameter]: input.newValue } : {}),
    };
    return { ...env, [input.zoneId]: zoneParams, ...zoneParams };
  }

  /**
   * Snapshot for condition triggers: the reader's snapshot with the trigger
   * zone's parameters hoisted to the top level (same dual-path rule).
   */
  private buildZoneSnapshot(zoneId: string): Record<string, unknown> {
    const env = this.readEnv();
    const zoneParams = (env[zoneId] as Record<string, unknown> | undefined) ?? {};
    return { ...env, ...zoneParams };
  }

  /**
   * Edge-trigger + cooldown for condition flows. Returns the fire verdict
   * AND the per-condition evaluation (T-061) so the run trace records what
   * the predicate saw, not just that it crossed.
   */
  private shouldFireCondition(
    flow: FlowDefinition,
    simTimeSec: number,
  ): { fire: boolean; evaluation: FlowTriggerEvaluation } {
    const trigger = flow.trigger as Extract<FlowDefinition['trigger'], { kind: 'condition' }>;
    // T-061: evaluate WITH detail (path + evaluatedValue + threshold + met).
    const conditionDetail = describeFlowConditions(trigger.conditions, this.buildZoneSnapshot(trigger.zoneId));
    const evaluation: FlowTriggerEvaluation = {
      kind: 'condition',
      zoneId: trigger.zoneId,
      simTimeSec,
      conditions: conditionDetail,
    };
    const result =
      conditionDetail.every(detail => detail.met) &&
      // FEAT-01: the active window FOLDS INTO the edge predicate — outside
      // the window the trigger reads false, so a predicate already true at
      // window open rises there, and out-of-window noise never fires.
      isWithinActiveWindow(trigger.activeWindowSimSec, simTimeSec);
    // Fix-44d: edge memory keyed by the trigger fingerprint — an edited
    // predicate re-arms (previous state discarded), an unchanged one keeps
    // its edge semantics.
    const fp = FlowEngine.triggerFingerprint(trigger);
    const memo = this.conditionState.get(flow.id);
    const carriesMemo = memo !== undefined && memo.fp === fp;
    const previous = carriesMemo ? memo.value : false;
    // T-107: a flow that never fired (or whose definition just changed) is
    // armed — the hysteresis window gates RE-arming after a fire, never the
    // first edge.
    const hysteresis = trigger.hysteresisSimC ?? 0;
    let armed = carriesMemo ? memo.armed ?? true : true;

    if (!result) {
      // T-107: the false streak re-arms the edge once it outlives the window
      // (window 0 = the historical any-false-re-arms semantics).
      const falseSince = carriesMemo && memo.falseSince !== undefined ? memo.falseSince : simTimeSec;
      if (!armed) {
        const falseDuration = simTimeSec - falseSince;
        if (hysteresis === 0 || falseDuration >= hysteresis) armed = true;
      }
      this.conditionState.set(flow.id, { fp, value: false, falseSince, armed });
      return { fire: false, evaluation };
    }

    // Sparse ticks may skip the ENTIRE false window (dip at t=20, next
    // evaluation true at t=200): judge re-arm from elapsed streak time too.
    if (!armed && hysteresis > 0) {
      const falseSince = carriesMemo ? memo.falseSince : undefined;
      if (falseSince !== undefined && simTimeSec - falseSince >= hysteresis) {
        armed = true;
      }
    }
    // A true evaluation ends any false streak.
    this.conditionState.set(flow.id, { fp, value: true, armed });
    if (previous) return { fire: false, evaluation }; // still true — not an edge
    if (!armed) {
      // T-107 (F10): a dip shorter than the window did not re-arm — this
      // true is a CONTINUATION of the previous episode, not a new trigger
      // (the atrium's 26.01 °C flicker vs a 26 °C guard, 4 retriggers/day).
      return { fire: false, evaluation };
    }

    const cooldown = trigger.cooldownSimSec ?? 0;
    const lastFired = this.lastFiredAtSimSec.get(flow.id);
    if (cooldown > 0 && lastFired !== undefined && lastFired.fp === fp && simTimeSec - lastFired.at < cooldown) {
      return { fire: false, evaluation }; // edge consumed, fire suppressed by cooldown
    }
    this.lastFiredAtSimSec.set(flow.id, { fp, at: simTimeSec });
    // T-107: firing disarms until the next long-enough false streak.
    this.conditionState.set(flow.id, { fp, value: true, armed: false });
    return { fire: true, evaluation };
  }

  /** One-shot + periodic schedule evaluation over (prev, cur]. */
  private shouldFireSchedule(flow: FlowDefinition, prev: number, cur: number): boolean {
    const trigger = flow.trigger as Extract<FlowDefinition['trigger'], { kind: 'schedule' }>;

    // One-shot: fire once per trigger DEFINITION when sim time reaches the
    // target (Fix-44d: fingerprinted — editing atSimTimeSec re-arms a flow
    // whose old target already fired).
    if (trigger.atSimTimeSec !== undefined && cur >= trigger.atSimTimeSec) {
      const fp = FlowEngine.triggerFingerprint(trigger);
      const firedFor = this.scheduleFired.get(flow.id);
      if (firedFor === undefined || firedFor !== fp) {
        this.scheduleFired.set(flow.id, fp);
        return true;
      }
    }

    // Periodic: fire when (prev, cur] crosses start + k*every for some k,
    // within the optional [start, end] window. At most one fire per tick
    // even when a large tick spans several periods.
    if (trigger.everySimSec !== undefined && trigger.everySimSec > 0) {
      const start = trigger.startAtSimTimeSec ?? 0;
      const end = trigger.endAtSimTimeSec;
      if (cur >= start && (end === undefined || prev < end)) {
        const firstK = Math.max(0, Math.floor((prev - start) / trigger.everySimSec) + 1);
        const fireAt = start + firstK * trigger.everySimSec;
        if (fireAt <= cur && (end === undefined || fireAt <= end)) {
          return true;
        }
      }
    }

    // FEAT-01 daily anchors: fire once per (day | zone, boundary, day) when
    // (prev, cur] crosses the anchor moment. Fingerprinted per-day memory —
    // an edited trigger re-arms, and at most one fire per tick is kept (the
    // run's triggerEvaluation carries the tick's simTimeSec either way).
    const dailyKeys = this.dueDailyScheduleKeys(trigger, prev, cur);
    if (dailyKeys.length > 0) {
      const fp = FlowEngine.triggerFingerprint(trigger);
      let memo = this.scheduleDailyFired.get(flow.id);
      if (memo === undefined || memo.fp !== fp) {
        memo = { fp, keys: new Set() };
        this.scheduleDailyFired.set(flow.id, memo);
      }
      const fresh = dailyKeys.filter(key => !memo.keys.has(key));
      if (fresh.length > 0) {
        for (const key of fresh) memo.keys.add(key);
        // Prune keys of days the (prev, cur] window can never reach again —
        // the set stays bounded at one day's worth of boundaries per zone.
        const minDay = Math.floor(prev / DAY_SEC);
        for (const key of memo.keys) {
          const day = Number(key.slice(key.lastIndexOf(':') + 1));
          if (Number.isFinite(day) && day < minDay) memo.keys.delete(key);
        }
        return true;
      }
    }

    return false;
  }

  /**
   * FEAT-01: the daily-anchor fire moments of a schedule trigger inside the
   * (prev, cur] window, as fired-memory keys. `tod:<day>` for
   * atTimeOfDaySec; `rel:<zoneId>:<arrive|depart>:<day>` for each
   * occupantSchedule boundary the relativeToOccupancy anchor matches
   * (scenario zones, pinned to relativeToOccupancy.zoneId when declared;
   * repeatDaily: false schedules anchor day 0 only — mirroring
   * due-moments' occupancy enumeration).
   */
  private dueDailyScheduleKeys(
    trigger: Extract<FlowDefinition['trigger'], { kind: 'schedule' }>,
    prev: number,
    cur: number,
  ): string[] {
    const keys: string[] = [];
    const fromDay = Math.floor(prev / DAY_SEC);
    if (trigger.atTimeOfDaySec !== undefined) {
      for (let day = fromDay; ; day++) {
        const at = day * DAY_SEC + trigger.atTimeOfDaySec;
        if (at > cur) break;
        if (at > prev) keys.push(`tod:${day}`);
      }
    }
    const rel = trigger.relativeToOccupancy;
    if (rel !== undefined) {
      for (const zone of this.scenario.zones) {
        if (rel.zoneId !== undefined && zone.id !== rel.zoneId) continue;
        const sched = zone.occupantSchedule;
        if (sched === undefined) continue;
        const repeat = sched.repeatDaily ?? true;
        const boundarySec = rel.before === 'arrive' ? sched.startSimTimeSec : sched.endSimTimeSec;
        for (let day = repeat ? fromDay : 0; ; day++) {
          const at = day * DAY_SEC + boundarySec - rel.offsetSec;
          if (at > cur) break;
          if (at > prev) keys.push(`rel:${zone.id}:${rel.before}:${day}`);
          if (!repeat) break;
        }
      }
    }
    return keys;
  }

  // ------------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------------

  /**
   * Enqueue one flow run on the serial chain; resolves with the completed
   * run record (or null if the run faulted at the seam) when it finishes.
   */
  private enqueue(
    flow: FlowDefinition,
    triggerKind: FlowRunTriggerKind,
    triggerEvaluation?: FlowTriggerEvaluation,
    runParams?: Record<string, unknown>,
    invokedBy?: FlowRunInvocationAttribution,
  ): Promise<FlowRunRecord | null> {
    const run = this.queue.then(() => this.runFlow(flow, triggerKind, triggerEvaluation, runParams, invokedBy));
    // The chain itself must survive a run fault (runFlow never throws, but
    // defend the invariant at the seam).
    this.queue = run.then(() => undefined, () => undefined);
    return run.then(record => record, () => null);
  }

  /** Execute one flow end to end. NEVER throws. */
  private async runFlow(
    flow: FlowDefinition,
    triggerKind: FlowRunTriggerKind,
    triggerEvaluation?: FlowTriggerEvaluation,
    runParams?: Record<string, unknown>,
    invokedBy?: FlowRunInvocationAttribution,
  ): Promise<FlowRunRecord> {
    // Fix-44b: globally unique run ids. The old `${flow.id}-run-${n}` scheme
    // was per-engine, so a second simulation on the same environment
    // collided with the persisted ledger's PRIMARY KEY (insert swallowed,
    // run lost, manual-run API answered with ANOTHER sim's record).
    const runId = `run-${randomUUID()}`;
    const startedAt = this.now();
    // Mechanism D: run parameters are resolved through the SAME oracle the
    // hosted paths validate with; the effective values (caller after
    // defaults) ride the run record for audit, and the plan copy gets
    // ${input:x} references substituted before execution.
    const carryInputs = flow.inputs !== undefined || runParams !== undefined;
    const { params: effectiveParams, issues: paramIssues } =
      resolveFlowRunParams(flow.inputs, runParams);

    try {
      // 0. Mechanism D run-parameter gate (defense in depth — the server's
      // manual-run route and the flow-service invocation core pre-validate
      // with the same function for a teaching 4xx; a direct engine caller
      // gets the honest refused record instead).
      const paramErrors = paramIssues.filter(i => i.level === 'error');
      if (paramErrors.length > 0) {
        const summary = `flow '${flow.id}' refused: invalid run parameters — ${paramErrors.map(e => e.message).join('; ')}`;
        this.safePublish(FLOW_EVENT_TYPES.EXECUTED, {
          flowId: flow.id, runId, triggerKind, status: 'failed', summary, nodeResults: {},
          ...(triggerEvaluation ? { triggerEvaluation } : {}),
          ...(invokedBy !== undefined ? { invokedBy } : {}),
        });
        return this.emitRun({
          runId, flowId: flow.id, triggerKind,
          ...(triggerEvaluation ? { triggerEvaluation } : {}),
          ...(invokedBy !== undefined ? { invokedBy } : {}),
          ...(carryInputs ? { inputs: effectiveParams } : {}),
          status: 'failed', summary,
          nodeResults: {}, startedAt, finishedAt: this.now(),
        });
      }
      const runFlowDef = flow.inputs !== undefined
        ? interpolateFlowInputs(flow, effectiveParams)
        : flow;

      // 1. Static assignment resolution (the validator's UNSAT gate).
      // T-051: with the oracle injected, this is the SAME pass authoring
      // validates with — runtime verdicts can no longer diverge from the
      // 422s a flow would have gotten at create/PATCH time.
      const { assignments, issues } = resolveFlowAssignments(runFlowDef, this.scenario, {
        ...(this.isExecutableCapability !== undefined
          ? { isExecutableCapability: this.isExecutableCapability }
          : {}),
      });
      const errors = issues.filter(i => i.level === 'error');
      if (errors.length > 0) {
        // R1 (B1-9 / P-19): when the host wired a stale probe and the flow
        // DOES resolve against the current environment content, the failure
        // is the FROZEN SNAPSHOT, not the authoring — say so in the same
        // words the manual run lane's 409 uses, instead of a bare UNSAT
        // that sends the operator editing capability declarations.
        const stale = this.staleFlowProbe !== undefined ? this.staleFlowProbe(runFlowDef) : false;
        const staleNote = stale
          ? ' — FLOW_STALE_SIMULATION: the environment changed after this simulation was created ' +
            '(the flow resolves against the current environment but not this frozen snapshot); ' +
            'recreate the simulation to run this flow'
          : '';
        const summary = `flow '${flow.id}' refused: ${errors.map(e => e.message).join('; ')}${staleNote}`;
        // TASK-003 (DevLoop): populate per-node error details instead of an
        // empty {} — the Explorer's "no hint what went wrong" finding. Each
        // issue carries a nodeId; group messages by node.
        const nodeResults: Record<string, PlanNodeResult> = {};
        for (const e of errors) {
          const nodeId = (e as { nodeId?: string }).nodeId;
          if (nodeId !== undefined) {
            nodeResults[nodeId] = {
              nodeId, status: 'failed' as const, error: e.message, attempts: 0,
            };
          }
        }
        this.safePublish(FLOW_EVENT_TYPES.EXECUTED, {
          flowId: flow.id, runId, triggerKind, status: 'failed', summary, nodeResults,
          ...(triggerEvaluation ? { triggerEvaluation } : {}),
          ...(invokedBy !== undefined ? { invokedBy } : {}),
        });
        return this.emitRun({
          runId, flowId: flow.id, triggerKind,
          ...(triggerEvaluation ? { triggerEvaluation } : {}),
          ...(invokedBy !== undefined ? { invokedBy } : {}),
          ...(carryInputs ? { inputs: effectiveParams } : {}),
          status: 'failed', summary,
          nodeResults, startedAt, finishedAt: this.now(),
        });
      }

      // 2. Announce the run BEFORE executing (observability of in-flight runs).
      this.safePublish(FLOW_EVENT_TYPES.TRIGGERED, { flowId: flow.id, runId, triggerKind });

      // T1 (R2, u3-F1): capability-drift annotation — compare every action
      // node's capability against the assignee's CURRENT declared set. The
      // live probe (when wired) is the whole truth: unknown agent = honestly
      // no annotation, never a frozen-grant guess. Only an UNWIRED probe
      // falls back to the frozen scenario's declarations (core-only
      // consumers). The node still executes (the device capability surface is
      // the execution truth — the deterministic-execution promise is
      // untouched); the annotation is what keeps "succeeded" from being
      // misread as "authorized".
      const declaredOf = (agentId: string): readonly string[] | undefined => {
        if (this.declaredAgentCapabilities !== undefined) {
          return this.declaredAgentCapabilities(agentId);
        }
        return this.scenario.agents.find(a => a.id === agentId)?.capabilities ?? [];
      };
      const capabilityDrift = computeCapabilityDrift(runFlowDef, assignments, declaredOf);
      const driftPayload = capabilityDrift.length > 0 ? { capabilityDrift } : {};

      // 3. Deterministic plan execution. Fix-44c: node-level guards read a
      // reader with the trigger zone's parameters hoisted to the top level —
      // the SAME dual-path rule trigger conditions have always had, so the
      // documented example guard 'humidity > 70' resolves against the
      // trigger zone instead of silently dead-ending.
      // T-312: an EVENT trigger that declares no zoneId of its own still
      // scopes the run to the zone the matched event carried
      // (trigger.zoneId ?? event.zoneId) — zone-scoped invokers then actuate
      // in-zone devices instead of falling back to the whole environment.
      // Mechanism C collector + the advice-output namespace are per-run
      // accumulators the lane closes over — FEAT-06: they ride the wait
      // continuation so a resumed wave keeps the SAME accumulators.
      const policyEscalations: FlowPolicyEscalation[] = [];
      const delegateOutputs: Record<string, unknown> = {};
      const lane = this.buildRunLane({
        flowId: flow.id,
        runId,
        runFlowDef,
        ...(triggerEvaluation ? { triggerEvaluation } : {}),
        policyEscalations,
        delegationsUsed: 0,
        delegateOutputs,
      });

      // FEAT-06: a plan carrying wait nodes executes in SIM-TIME SEGMENTS —
      // waves split at wait nodes, the run parks on the engine's sim clock
      // between waves (deterministic staggering; see executeWaitWave).
      const hasWaitNodes = lane.planNodes.some(n => n.wait !== undefined);
      if (hasWaitNodes) {
        const cont: FlowWaitContinuation = {
          runId,
          flowId: flow.id,
          triggerKind,
          ...(triggerEvaluation ? { triggerEvaluation } : {}),
          hadInputs: flow.inputs !== undefined,
          escalateOnExhaustion: lane.policyEnvelope?.onBudgetExhausted === 'escalate',
          ...(carryInputs ? { inputs: effectiveParams } : {}),
          ...(invokedBy !== undefined ? { invokedBy } : {}),
          startedAt,
          ...(capabilityDrift.length > 0 ? { capabilityDrift } : {}),
          policyEscalations,
          delegationsUsed: 0,
          delegateOutputs,
          results: {},
          armedWaits: [],
          executedNodeIds: [],
        };
        const simTimeSec = triggerEvaluation?.simTimeSec ?? this.lastTickSimSec ?? 0;
        await this.driveWaitWaves(cont, runFlowDef, lane, simTimeSec);
        if (cont.armedWaits.length > 0) {
          // Parked: the FINAL record is emitted when the last wait resumes
          // (continueWaitRun). The direct caller still gets an honest
          // intermediate answer — never persisted, never published, so the
          // ledger holds exactly one row per run.
          this.waitContinuations.push(cont);
          const resumeAtSimSec = Math.min(...cont.armedWaits.map(w => w.dueSimSec));
          const pendingNodeIds = runFlowDef.plan.nodes
            .map(n => n.id)
            .filter(id =>
              !cont.executedNodeIds.includes(id) ||
              cont.armedWaits.some(w => w.nodeId === id),
            );
          return {
            runId, flowId: flow.id, triggerKind,
            ...(triggerEvaluation ? { triggerEvaluation } : {}),
            ...(carryInputs ? { inputs: effectiveParams } : {}),
            ...(invokedBy !== undefined ? { invokedBy } : {}),
            ...driftPayload,
            status: 'waiting',
            summary:
              `flow '${flow.id}' parked on a wait node: ${cont.executedNodeIds.length}/${runFlowDef.plan.nodes.length} ` +
              `nodes executed, resume at sim t=${resumeAtSimSec}s`,
            waiting: { resumeAtSimSec, pendingNodeIds },
            nodeResults: { ...cont.results },
            startedAt, finishedAt: this.now(),
          };
        }
        return this.finalizeWaitRun(cont, driftPayload);
      }

      const plan: WorkflowPlan = {
        id: runId,
        goal: runFlowDef.plan.goal,
        nodes: lane.planNodes,
        metadata: { author: 'manual', createdAt: startedAt },
      };
      const result = await this.executor.execute(plan, assignments, lane.nodeInvoker, lane.guardReader);

      // Mechanism C: surface collected exhaustion refusals as the escalation
      // signal — only in 'escalate' mode (fallback mode stays silent; each
      // refusal already rides its node's degraded result honestly).
      const escalations =
        lane.policyEnvelope?.onBudgetExhausted === 'escalate' && policyEscalations.length > 0
          ? policyEscalations
          : undefined;

      this.safePublish(FLOW_EVENT_TYPES.EXECUTED, {
        flowId: flow.id, runId, triggerKind,
        status: result.status, summary: result.summary, nodeResults: result.nodeResults,
        ...driftPayload,
        ...(triggerEvaluation ? { triggerEvaluation } : {}),
        ...(carryInputs ? { inputs: effectiveParams } : {}),
        ...(escalations !== undefined ? { policyEscalations: escalations } : {}),
        ...(invokedBy !== undefined ? { invokedBy } : {}),
      });
      return this.emitRun({
        runId, flowId: flow.id, triggerKind,
        ...(triggerEvaluation ? { triggerEvaluation } : {}),
        ...(carryInputs ? { inputs: effectiveParams } : {}),
        ...(escalations !== undefined ? { policyEscalations: escalations } : {}),
        ...(invokedBy !== undefined ? { invokedBy } : {}),
        ...driftPayload,
        status: result.status, summary: result.summary, nodeResults: result.nodeResults,
        startedAt, finishedAt: this.now(),
      });
    } catch (error) {
      // NEVER throw across the boundary.
      const summary = `flow '${flow.id}' internal fault: ${error instanceof Error ? error.message : String(error)}`;
      this.safePublish(FLOW_EVENT_TYPES.EXECUTED, {
        flowId: flow.id, runId, triggerKind, status: 'failed', summary, nodeResults: {},
        ...(triggerEvaluation ? { triggerEvaluation } : {}),
        ...(invokedBy !== undefined ? { invokedBy } : {}),
      });
      return this.emitRun({
        runId, flowId: flow.id, triggerKind,
        ...(triggerEvaluation ? { triggerEvaluation } : {}),
        ...(invokedBy !== undefined ? { invokedBy } : {}),
        ...(carryInputs ? { inputs: effectiveParams } : {}),
        status: 'failed', summary,
        nodeResults: {}, startedAt, finishedAt: this.now(),
      });
    }
  }

  // ------------------------------------------------------------------------
  // Run-lane construction + FEAT-06 wait (sim-clock) continuations
  // ------------------------------------------------------------------------

  /**
   * The per-run execution lane (guard reader + node invoker + delegate
   * composition + policy gate), extracted so the INITIAL run and every
   * FEAT-06 resume build the IDENTICAL lane. The accumulators
   * (policyEscalations, delegateOutputs) are caller-owned so a parked run
   * carries them across waves; `delegationsUsed` seeds the Mechanism-C
   * budget counter (0 at run start, the parked value at resume).
   */
  private buildRunLane(args: {
    flowId: string;
    runId: string;
    runFlowDef: FlowDefinition;
    triggerEvaluation?: FlowTriggerEvaluation;
    policyEscalations: FlowPolicyEscalation[];
    delegationsUsed: number;
    delegateOutputs: Record<string, unknown>;
  }): {
    guardReader: EnvStateReader;
    nodeInvoker: PlanNodeInvoker;
    planNodes: PlanNode[];
    policyEnvelope?: FlowPolicyEnvelope;
    policyGate?: { delegationsUsed: number };
  } {
    const { flowId, runId, runFlowDef, triggerEvaluation, policyEscalations, delegateOutputs } = args;
    // Fix-44c: node-level guards read a reader with the trigger zone's
    // parameters hoisted to the top level — the SAME dual-path rule trigger
    // conditions have always had. T-312: an EVENT trigger that declares no
    // zoneId of its own still scopes the run to the zone the matched event
    // carried (trigger.zoneId ?? event.zoneId).
    const triggerZoneId =
      runFlowDef.trigger.kind === 'condition' || runFlowDef.trigger.kind === 'event'
        ? (runFlowDef.trigger.zoneId ??
          (triggerEvaluation?.kind === 'event' ? triggerEvaluation.event?.zoneId : undefined))
        : undefined;

    // Mechanism A: delegate composition (opt-in per flow — a flow with no
    // delegate nodes runs the exact pre-A code path).
    const hasDelegateNodes = runFlowDef.plan.nodes.some(n => n.delegate !== undefined);

    // Mechanism C: the flow's policy envelope, materialized as ONE mutable
    // gate for this lane (thresholds from the definition; the delegation
    // counter seeded from the parked run). Exhaustion refusals are collected
    // for every envelope mode — the node results always carry them — but
    // they surface as policyEscalations (the signal the host turns into an
    // owner notification) only in 'escalate' mode.
    const policyEnvelope = hasDelegateNodes ? runFlowDef.policy : undefined;
    const policyGate =
      policyEnvelope === undefined
        ? undefined
        : {
            ...(policyEnvelope.maxDelegationsPerRun !== undefined
              ? { maxDelegationsPerRun: policyEnvelope.maxDelegationsPerRun }
              : {}),
            ...(policyEnvelope.minConfidenceToActuate !== undefined
              ? { minConfidenceToActuate: policyEnvelope.minConfidenceToActuate }
              : {}),
            ...(policyEnvelope.onBudgetExhausted !== undefined
              ? { onBudgetExhausted: policyEnvelope.onBudgetExhausted }
              : {}),
            delegationsUsed: args.delegationsUsed,
            onDelegationRefused: (nodeId: string, message: string) =>
              policyEscalations.push({ kind: 'budget-exhausted', nodeId, message }),
          };

    // Advice outputs land in a per-run extras namespace the guard reader
    // hoists (delegate.<nodeId>.<key>, design §4.4.5). Guard evaluation
    // happens per node immediately before its invocation, so a delegate's
    // outputs are visible to everything evaluated after it (its dependents
    // by construction; same-wave later nodes see them too — namespaced).
    const hoistDelegateOutputs = (snapshot: Record<string, unknown>): Record<string, unknown> =>
      Object.keys(delegateOutputs).length === 0
        ? snapshot
        : { ...snapshot, ...delegateOutputs };

    let guardReader: EnvStateReader;
    let nodeInvoker: PlanNodeInvoker;
    // R6-B-F03 + FEAT-05: one dispatch for every node — service nodes route
    // to the agreement-mediated lane and notify nodes to the notification
    // lane (with the flow id as consumer-identity key), everything else to
    // the own-devices invoker.
    const dispatch: PlanNodeInvoker = (node, agentId, context) =>
      this.invokeNode(node, agentId, { flowId, ...context });
    if (hasDelegateNodes) {
      guardReader = triggerZoneId === undefined
        ? () => hoistDelegateOutputs(this.readEnv())
        : () => hoistDelegateOutputs(this.buildZoneSnapshot(triggerZoneId));
      nodeInvoker = createDelegateDispatchingInvoker(dispatch, this.delegateRunner, {
        flowId,
        runId,
        ...(triggerZoneId !== undefined ? { zoneId: triggerZoneId } : {}),
        ...(triggerEvaluation !== undefined ? { triggerSummary: triggerEvaluation } : {}),
        envSnapshot: triggerZoneId === undefined
          ? this.readEnv()
          : this.buildZoneSnapshot(triggerZoneId),
        // T-502: the budget-device inventory rides the run context — the
        // actuating prompt renders it; advice prompts never consult it.
        ...(this.budgetDeviceOf !== undefined ? { budgetDeviceOf: this.budgetDeviceOf } : {}),
        onOutputs: (nodeId, outputs) => {
          for (const [key, value] of Object.entries(outputs)) {
            delegateOutputs[`delegate.${nodeId}.${key}`] = value;
          }
        },
        ...(policyGate !== undefined ? { policy: policyGate } : {}),
      });
    } else {
      guardReader = triggerZoneId === undefined
        ? this.envStateReader
        : () => this.buildZoneSnapshot(triggerZoneId);
      // Zone scoping (campus-pilot P0): a zone-triggered run must actuate a
      // device IN the trigger zone. The trigger zone rides along as invocation
      // context; zone-aware invokers (createFlowNodeInvoker) prefer in-zone
      // devices and refuse cross-zone actuation instead of silently cooling
      // the wrong room.
      // T-608 (R26): every flow-lane actuation carries the actor label
      // `flow:<flowId>` into the device audit trail (previously 'unknown').
      const flowActor = `flow:${flowId}`;
      nodeInvoker = triggerZoneId === undefined
        ? (node, agentId) => dispatch(node, agentId, { actor: flowActor })
        : (node, agentId) => dispatch(node, agentId, { zoneId: triggerZoneId, actor: flowActor });
    }

    // Mechanism A fallback: a delegate node with fallback {policy:'node'}
    // degrades by FAILING, and the referenced action node must then run
    // once, out-of-band — exactly the executor's compensate semantics. The
    // rewrite maps the author's fallback field onto that existing machine:
    // the executor runs the fallback node at most once at failure time and
    // excludes it from normal scheduling (no double execution), and the
    // delegate node's authored onFail (if any) is superseded by the
    // fallback declaration (the delegate-specific degradation policy).
    const planNodes: PlanNode[] = hasDelegateNodes
      ? runFlowDef.plan.nodes.map(node =>
          node.delegate?.fallback?.policy === 'node'
            ? { ...node, onFail: { policy: 'compensate' as const, compensateNodeId: node.delegate.fallback.nodeId } }
            : node,
        )
      : runFlowDef.plan.nodes;

    return {
      guardReader,
      nodeInvoker,
      planNodes,
      ...(policyEnvelope !== undefined ? { policyEnvelope } : {}),
      ...(policyGate !== undefined ? { policyGate } : {}),
    };
  }

  /**
   * FEAT-06: drive a wait-carrying run wave by wave until it PARKS (a wait
   * node armed on the sim clock) or nothing remains. Each wave executes
   * every node whose transitive wait-dependencies are all resolved; the
   * loop re-runs after boundary propagation (a skipped/failed wait resolves
   * its dependents without a sim-time wait). Never throws.
   */
  private async driveWaitWaves(
    cont: FlowWaitContinuation,
    runFlowDef: FlowDefinition,
    lane: {
      guardReader: EnvStateReader;
      nodeInvoker: PlanNodeInvoker;
      planNodes: PlanNode[];
      policyGate?: { delegationsUsed: number };
    },
    simTimeSec: number,
  ): Promise<void> {
    const total = runFlowDef.plan.nodes.length;
    // Run waves while progress is possible: a wave executes every node whose
    // transitive wait-dependencies are RESOLVED — armed-but-undue waits do
    // NOT block siblings whose own waits already resolved (staggered
    // branches resume at their own dues inside one run).
    while (cont.executedNodeIds.length < total) {
      const before = cont.executedNodeIds.length;
      await this.executeWaitWave(cont, runFlowDef, lane, simTimeSec);
      if (cont.executedNodeIds.length === before) break; // parked or done
    }
    // Mechanism C: read the budget counter back so a parked run resumes with
    // the consumption its executed waves already spent.
    cont.delegationsUsed = lane.policyGate?.delegationsUsed ?? cont.delegationsUsed;
  }

  /**
   * FEAT-06: execute ONE wave of a wait-carrying run. A node joins the wave
   * when every wait node in its transitive dependency closure is RESOLVED
   * (executed and not armed-unsatisfied). Boundary wait nodes join too —
   * the wave's invoker ARMS them on the sim clock instead of executing
   * (their success result records the schedule: {waitSimSec, dueSimSec};
   * the resume annotates resumedAtSimSec). Cross-wave dependency
   * propagation mirrors PlanExecutor.executeNode's step 1 for deps that
   * executed in an earlier wave (in-segment deps are the executor's own
   * job). Never throws.
   */
  private async executeWaitWave(
    cont: FlowWaitContinuation,
    runFlowDef: FlowDefinition,
    lane: {
      guardReader: EnvStateReader;
      nodeInvoker: PlanNodeInvoker;
      planNodes: PlanNode[];
    },
    simTimeSec: number,
  ): Promise<void> {
    const allNodes = runFlowDef.plan.nodes;
    const byId = new Map(allNodes.map(n => [n.id, n]));
    const executed = new Set(cont.executedNodeIds);

    // Transitive wait-node closure per node (plans are small; recomputed
    // per wave, memoized within one).
    const waitClosure = new Map<string, Set<string>>();
    const closureOf = (id: string): Set<string> => {
      const memo = waitClosure.get(id);
      if (memo !== undefined) return memo;
      const acc = new Set<string>();
      waitClosure.set(id, acc); // cycle guard: validateFlow already rejects cycles
      const node = byId.get(id);
      for (const dep of node?.dependsOn ?? []) {
        const depNode = byId.get(dep);
        if (depNode?.wait !== undefined) acc.add(dep);
        for (const w of closureOf(dep)) acc.add(w);
      }
      return acc;
    };
    const resolvedWait = (id: string): boolean =>
      executed.has(id) && !cont.armedWaits.some(w => w.nodeId === id);

    const eligible: PlanNode[] = [];
    const eligibleIds = new Set<string>();
    for (const node of allNodes) {
      if (executed.has(node.id)) continue;
      if (![...closureOf(node.id)].every(resolvedWait)) continue;
      eligible.push(node);
      eligibleIds.add(node.id);
    }

    // Cross-wave dependency propagation (mirrors the executor's verdicts
    // and messages for deps that executed in an EARLIER wave).
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of [...eligible]) {
        for (const depId of node.dependsOn ?? []) {
          if (eligibleIds.has(depId)) continue; // in-segment: the executor judges
          const dep = cont.results[depId];
          if (dep === undefined) continue;
          if (dep.status === 'failed' || dep.status === 'blocked') {
            cont.results[node.id] = {
              nodeId: node.id, status: 'blocked', attempts: 0,
              error: `dependency '${depId}' ${dep.status}`,
            };
          } else if (dep.status === 'skipped') {
            cont.results[node.id] = {
              nodeId: node.id, status: 'skipped', attempts: 0,
              note: `dependency '${depId}' was skipped`,
            };
          } else {
            continue;
          }
          eligible.splice(eligible.indexOf(node), 1);
          eligibleIds.delete(node.id);
          executed.add(node.id);
          changed = true;
          break;
        }
      }
    }

    // Compensation closure: a node's compensateNodeId target must be
    // AVAILABLE to the same executor call (the executor excludes it from
    // normal scheduling and runs it out-of-band at failure time) — pulling
    // it into the segment keeps single-plan semantics across waves.
    let closureChanged = true;
    while (closureChanged) {
      closureChanged = false;
      for (const node of [...eligible]) {
        const target = node.onFail?.policy === 'compensate' ? node.onFail.compensateNodeId : undefined;
        if (target === undefined || eligibleIds.has(target) || executed.has(target)) continue;
        const targetNode = byId.get(target);
        if (targetNode === undefined) continue;
        eligible.push(targetNode);
        eligibleIds.add(target);
        closureChanged = true;
      }
    }

    if (eligible.length === 0) {
      cont.executedNodeIds = [...executed];
      return;
    }

    // Assignments: the SAME deterministic pass the run start used (T-051
    // oracle included) — a wave never diverges from what the run resolved.
    // Errors here mean the world changed under a parked run: honest
    // per-node failure, never a throw.
    const { assignments, issues } = resolveFlowAssignments(runFlowDef, this.scenario, {
      ...(this.isExecutableCapability !== undefined
        ? { isExecutableCapability: this.isExecutableCapability }
        : {}),
    });
    const errors = issues.filter(i => i.level === 'error');
    if (errors.length > 0) {
      const joined = errors.map(e => e.message).join('; ');
      for (const node of eligible) {
        cont.results[node.id] = { nodeId: node.id, status: 'failed', attempts: 0, error: joined };
        executed.add(node.id);
      }
      cont.executedNodeIds = [...executed];
      return;
    }

    // The wait intercept: a wait node in the segment is ARMED on the sim
    // clock (its success result lands immediately — the ledger records the
    // schedule — and its dependents join a later wave once due).
    const waveInvoker: PlanNodeInvoker = (node, agentId, context) => {
      if (node.wait !== undefined) {
        const dueSimSec = simTimeSec + node.wait.simSec;
        cont.armedWaits.push({ nodeId: node.id, dueSimSec });
        return Promise.resolve({
          success: true,
          result: { waitSimSec: node.wait.simSec, dueSimSec },
        });
      }
      return lane.nodeInvoker(node, agentId, context);
    };

    const segmentPlan: WorkflowPlan = {
      id: cont.runId,
      goal: runFlowDef.plan.goal,
      nodes: lane.planNodes.filter(n => eligibleIds.has(n.id)),
      metadata: { author: 'manual', createdAt: cont.startedAt },
    };
    const result = await this.executor.execute(segmentPlan, assignments, waveInvoker, lane.guardReader);
    for (const [nodeId, nodeResult] of Object.entries(result.nodeResults)) {
      cont.results[nodeId] = nodeResult;
      executed.add(nodeId);
    }
    cont.executedNodeIds = [...executed];
  }

  /**
   * FEAT-06: enqueue a parked run's resume on the SAME serial chain every
   * other run uses (a continuation never overlaps another run). The caller
   * (onTick) has already removed the continuation from the parked list;
   * continueWaitRun re-parks it when a wait is still armed after the wave.
   */
  private enqueueContinuation(
    cont: FlowWaitContinuation,
    simTimeSec: number,
  ): Promise<FlowRunRecord | null> {
    const run = this.queue.then(() => this.continueWaitRun(cont, simTimeSec));
    this.queue = run.then(() => undefined, () => undefined);
    return run.then(record => record, () => null);
  }

  /**
   * FEAT-06: resume a parked run at a tick that reached its earliest armed
   * wait. The flow definition is re-read from the provider (same dynamism
   * discipline as triggers): a deleted/disabled flow fails the run honestly;
   * an edited one resumes in its edited form. NEVER throws.
   */
  private async continueWaitRun(
    cont: FlowWaitContinuation,
    simTimeSec: number,
  ): Promise<FlowRunRecord> {
    try {
      let flows: FlowDefinition[];
      try {
        flows = this.flowsProvider() ?? [];
      } catch {
        flows = [];
      }
      const flow = flows.find(candidate => candidate.id === cont.flowId);
      if (flow === undefined || !flow.enabled) {
        return this.finalizeWaitRun(
          cont,
          {},
          `flow '${cont.flowId}' ${flow === undefined ? 'was removed' : 'is disabled'} while parked ` +
            'on a wait node — the remaining nodes never executed',
        );
      }
      const runFlowDef = cont.hadInputs && cont.inputs !== undefined
        ? interpolateFlowInputs(flow, cont.inputs)
        : flow;

      // Satisfy due waits: annotate the armed result with the resume time
      // (the ledger then shows waitSimSec / dueSimSec / resumedAtSimSec).
      cont.armedWaits = cont.armedWaits.filter(armed => {
        if (armed.dueSimSec > simTimeSec) return true;
        const result = cont.results[armed.nodeId];
        if (result !== undefined) {
          result.result = {
            ...(typeof result.result === 'object' && result.result !== null
              ? (result.result as Record<string, unknown>)
              : {}),
            resumedAtSimSec: simTimeSec,
          };
        }
        return false;
      });

      const lane = this.buildRunLane({
        flowId: cont.flowId,
        runId: cont.runId,
        runFlowDef,
        ...(cont.triggerEvaluation ? { triggerEvaluation: cont.triggerEvaluation } : {}),
        policyEscalations: cont.policyEscalations,
        delegationsUsed: cont.delegationsUsed,
        delegateOutputs: cont.delegateOutputs,
      });
      await this.driveWaitWaves(cont, runFlowDef, lane, simTimeSec);

      if (cont.armedWaits.length > 0) {
        // Still parked (a deeper wait armed, or staggered waits remain).
        this.waitContinuations.push(cont);
        const resumeAtSimSec = Math.min(...cont.armedWaits.map(w => w.dueSimSec));
        const pendingNodeIds = runFlowDef.plan.nodes
          .map(n => n.id)
          .filter(id =>
            !cont.executedNodeIds.includes(id) ||
            cont.armedWaits.some(w => w.nodeId === id),
          );
        return {
          runId: cont.runId,
          flowId: cont.flowId,
          triggerKind: cont.triggerKind,
          ...(cont.triggerEvaluation ? { triggerEvaluation: cont.triggerEvaluation } : {}),
          ...(cont.inputs !== undefined ? { inputs: cont.inputs } : {}),
          ...(cont.invokedBy !== undefined ? { invokedBy: cont.invokedBy } : {}),
          ...(cont.capabilityDrift !== undefined && cont.capabilityDrift.length > 0
            ? { capabilityDrift: cont.capabilityDrift }
            : {}),
          status: 'waiting',
          summary:
            `flow '${cont.flowId}' parked on a wait node: ${cont.executedNodeIds.length}/${runFlowDef.plan.nodes.length} ` +
            `nodes executed, resume at sim t=${resumeAtSimSec}s`,
          waiting: { resumeAtSimSec, pendingNodeIds },
          nodeResults: { ...cont.results },
          startedAt: cont.startedAt,
          finishedAt: this.now(),
        };
      }

      return this.finalizeWaitRun(cont, {
        ...(cont.capabilityDrift !== undefined && cont.capabilityDrift.length > 0
          ? { capabilityDrift: cont.capabilityDrift }
          : {}),
      });
    } catch (error) {
      // NEVER throw across the boundary (mirrors runFlow's seam).
      return this.finalizeWaitRun(
        cont,
        {},
        `flow '${cont.flowId}' internal fault while resuming a wait: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * FEAT-06: emit the FINAL record of a wait-carrying run (success/partial/
   * failed — or a forced failure when the flow vanished mid-wait). Status
   * and summary MIRROR PlanExecutor.finalize over the merged node results —
   * KEEP IN SYNC with plan-executor.ts's finalize.
   */
  private finalizeWaitRun(
    cont: FlowWaitContinuation,
    driftPayload: { capabilityDrift?: FlowCapabilityDrift[] },
    forcedFailureSummary?: string,
  ): FlowRunRecord {
    // Defensive: a forced failure can arrive while the continuation is
    // still listed (it normally is not — onTick spliced it out).
    const parked = this.waitContinuations.indexOf(cont);
    if (parked >= 0) this.waitContinuations.splice(parked, 1);

    const results = Object.values(cont.results);
    const succeeded = results.filter(r => r.status === 'succeeded').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const blocked = results.filter(r => r.status === 'blocked').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const compensatedBy = new Set(
      results
        .filter(r => r.compensationFor !== undefined && r.status === 'succeeded')
        .map(r => r.compensationFor as string),
    );
    const degradedDelivered = results
      .filter(r => r.status === 'failed' && compensatedBy.has(r.nodeId)).length;
    const uncompensatedFailures = failed - degradedDelivered;

    let status: FlowRunStatus;
    if (forcedFailureSummary !== undefined) {
      status = 'failed';
    } else if (uncompensatedFailures === 0 && blocked === 0) {
      status = 'success';
    } else if (succeeded === 0) {
      status = 'failed';
    } else {
      status = 'partial';
    }
    const degradedNote = degradedDelivered > 0
      ? `, ${degradedDelivered} degraded but fallback-delivered`
      : '';
    const total = results.length;
    const summary = forcedFailureSummary !== undefined
      ? `flow '${cont.flowId}' failed: ${forcedFailureSummary}`
      : `plan '${cont.runId}' ${status}: ${succeeded} succeeded, ${skipped} skipped, ` +
        `${uncompensatedFailures} failed, ${blocked} blocked${degradedNote} (${total} nodes)`;

    // Mechanism C: same surfacing rule as the synchronous path (the envelope
    // mode was captured at run start — the flow may be gone by resume).
    const escalations =
      cont.escalateOnExhaustion && cont.policyEscalations.length > 0
        ? cont.policyEscalations
        : undefined;

    this.safePublish(FLOW_EVENT_TYPES.EXECUTED, {
      flowId: cont.flowId, runId: cont.runId, triggerKind: cont.triggerKind,
      status, summary, nodeResults: cont.results,
      ...driftPayload,
      ...(cont.triggerEvaluation ? { triggerEvaluation: cont.triggerEvaluation } : {}),
      ...(cont.inputs !== undefined ? { inputs: cont.inputs } : {}),
      ...(escalations !== undefined ? { policyEscalations: escalations } : {}),
      ...(cont.invokedBy !== undefined ? { invokedBy: cont.invokedBy } : {}),
    });
    return this.emitRun({
      runId: cont.runId,
      flowId: cont.flowId,
      triggerKind: cont.triggerKind,
      ...(cont.triggerEvaluation ? { triggerEvaluation: cont.triggerEvaluation } : {}),
      ...(cont.inputs !== undefined ? { inputs: cont.inputs } : {}),
      ...(escalations !== undefined ? { policyEscalations: escalations } : {}),
      ...(cont.invokedBy !== undefined ? { invokedBy: cont.invokedBy } : {}),
      ...driftPayload,
      status, summary, nodeResults: cont.results,
      startedAt: cont.startedAt, finishedAt: this.now(),
    });
  }

  private safePublish(type: string, payload: Record<string, unknown>): void {
    try {
      this.publish(type, payload);
    } catch {
      // Bus faults must not break the engine
    }
  }

  /** Deliver the run record to listeners; returns the record (never throws). */
  private emitRun(record: FlowRunRecord): FlowRunRecord {
    try {
      this.onRun?.(record);
    } catch {
      // Listener faults must not break the engine
    }
    return record;
  }
}
