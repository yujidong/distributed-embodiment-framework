/**
 * Natural-language interface types — Phase 3 of the agent cognitive
 * architecture (docs/design-agent-cognitive-architecture.md §12 Phase 3,
 * value layer L1: "humans command agents in plain language, agents respond
 * in plain language").
 *
 * Three contracts live here:
 * - `NLCommandIntent` — what the operator asked for, parsed out of raw text
 *   (command-parser.ts produces it);
 * - the AGENT VIEW types (`NLDeviceView` / `NLZoneView` / `NLAgentView`) —
 *   the bounded, JSON-safe projection of the agent's own world the NL lane
 *   is allowed to reason over (own devices only — the same MY_DEVICES
 *   surface the assessor prompt renders; zones carry per-parameter values);
 * - the RESULT types (`NLCommandResult` / `NLAskResult`) — the full
 *   four-stage pipeline output (intent → cognitive decision → execution →
 *   natural-language response) the server route serializes verbatim.
 *
 * Pure types module: no logic, no IO.
 */

import type { ChatParams } from '@active-collaboration/llm-integration';

import type { CognitiveDecision } from '../decision/cognitive-decision.js';
import type { WhatIfIntervention, WhatIfResult } from '../cognition/predictor.js';
import type { AgentFlowInvocationOutcome, InvocableFlowOffering } from '../flows/index.js';

// ============================================================================
// Intent
// ============================================================================

/** The closed action vocabulary of the NL command lane. */
export type NLCommandAction =
  | 'set_parameter'
  | 'run_flow'
  | 'get_status'
  | 'optimize'
  | 'emergency'
  | 'help'
  | 'unknown';

export type NLCommandPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * R103 (zhao-24): a self-contradictory command segment, detected
 * deterministically from the raw text ("调到18度" + "保持温度完全不变",
 * "打开空调" + "保持空调关闭"). The orchestrator refuses the contradicted
 * segment and DECLARES the conflict — never a silent subset execution.
 */
export interface NLCommandContradiction {
  /** parameter-hold: set-to-value vs keep-unchanged; toggle-hold: open vs keep-closed (or vice versa). */
  kind: 'parameter-hold' | 'toggle-hold';
  /** Machine-readable description of the conflicting pair. */
  detail: string;
}

/**
 * A parsed natural-language command. Target zones/devices are ALWAYS
 * resolved against the agent's own view (validated ids only — an LLM-named
 * id that is not in the inventory is dropped and recorded in `notes`,
 * never guessed onto a device the agent does not own).
 */
export interface NLCommandIntent {
  action: NLCommandAction;
  /**
   * Resolved zone ids (validated against the lane's zone surface). The ask
   * lane's surface is the WORLD-WIDE zone list the caller hands the parse
   * (`mentionZones`) — T105 (R17): the jurisdiction disclosure consumes THESE
   * resolved zones ∩ the agent's jurisdiction, never a second raw-text
   * matcher, so the answer reads the jurisdiction view while the intent still
   * carries (and the disclosure names) the foreign zones the question truly
   * resolved to.
   */
  targetZones?: string[];
  /**
   * T105/T106 (R17): the zone mentions resolved against the WORLD-WIDE
   * mention surface (`runNLAsk` options.mentionZones) — the jurisdiction
   * disclosure's judgment input. Present (possibly EMPTY) only when the
   * caller supplied a mention surface: EMPTY + a zone noun in `rawText`
   * (「Z栋」) = the question NAMED a zone that resolved to nothing (the
   * 「未能定位」 disclosure); foreign ids here are exactly the
   * out-of-jurisdiction disclosure's targets. Absent = no mention surface was
   * provided (the answer view was the only resolution surface; consumers fall
   * back to `targetZones`).
   */
  worldMentions?: string[];
  /** Resolved device ids (validated against NLDeviceView[].deviceId). */
  targetDevices?: string[];
  /** Named parameter targets, e.g. { temperature: 22 }. */
  targetParameters?: Record<string, number>;
  /** Free-form duration phrase, e.g. "for 2 hours". */
  duration?: string;
  priority?: NLCommandPriority;
  /**
   * R84 (R44-F2 residual): a COLLECTIVE/set target was recognized in the
   * raw text ("把我区全部排水阀打开", "open all the lights") and
   * `targetDevices` is the deterministic expansion of it — the zone scope
   * (explicit zone or the agent's managed zones for 「我区」) intersected
   * with a capability-kind filter. `matched: 0` is the teaching case: the
   * operator named a device KIND the agent has none of in scope — the
   * pipeline answers with what it CAN operate there, never a silent no-op.
   */
  collective?: {
    /** The capability-kind word the operator used (e.g. 排水阀, lights). */
    word: string;
    /** How many in-scope own devices the kind filter matched. */
    matched: number;
  };
  /** The operator's original words (sanitized at the seam — see parser). */
  rawText: string;
  /** Honest accounting: rules | llm | rules-llm-down (which lane parsed it). */
  parseSource: 'rules' | 'llm' | 'rules-llm-down';
  /**
   * Parse notes (dropped/unresolvable targets, sanitizer hits) — surfaced to
   * the caller so nothing is silently discarded (platform honesty contract).
   */
  notes?: string[];
  /** R103 (zhao-24): self-contradictory segments, set by the parser on BOTH lanes. */
  contradictions?: NLCommandContradiction[];
}

// ============================================================================
// Agent view (what the NL lane may see — own devices + managed zones)
// ============================================================================

/** One of the agent's OWN bound devices, projected for the NL lane. */
export interface NLDeviceView {
  deviceId: string;
  name: string;
  type: string;
  zoneId?: string;
  online: boolean;
  /** The device's actuation command surface (sensor-style caps excluded). */
  commands: readonly string[];
  /** Key current state primitives (setpoint, mode, power…), bounded. */
  state?: Record<string, unknown>;
  /**
   * T2 (R2, u1-F1): the device's LITERAL dispatch face when the host has it
   * (the runtime snapshot's own command list). The broader `commands` may be
   * EXPANDED through semantic mappings — right for prose matching, wrong for
   * equivalence gates. Absent = `commands` is the face.
   */
  rawCommands?: readonly string[];
}

/** One zone with its latest parameter values (the NL world view). */
export interface NLZoneView {
  zoneId: string;
  name?: string;
  /** Latest parameter values, e.g. { temperature: 29.3, occupancy: 18 }. */
  parameters?: Record<string, number | boolean>;
}

/** The agent's own identity/status projection. */
export interface NLAgentView {
  agentId: string;
  agentName: string;
  capabilities: readonly string[];
  status: string;
  /**
   * R46-P0 (zone routing): the agent's JURISDICTION — zones it is
   * responsible for (`managesZoneIds` ∪ its bound devices' zones, as the
   * runtime resolves them). The parser prefers these when resolving zone
   * references (a 南山 keeper told "南山变电站" must route to the nan-*
   * substation, never fall through to the first bao-* zone in a global
   * listing). Optional: agents without a resolved jurisdiction keep the
   * previous global-matching behavior.
   */
  managedZoneIds?: readonly string[];
}

/**
 * The seam the NL pipeline runs against. Built by the agent (CognitiveAgent)
 * or a route from live runtime state; every IO (LLM chat, device execution)
 * rides these functions so the orchestrator stays testable and never reaches
 * around the agent's own lanes.
 */
export interface NLSeam {
  agent: NLAgentView;
  devices: readonly NLDeviceView[];
  zones: readonly NLZoneView[];
  /**
   * LLM chat seam (constrained-decoding capable). Absent for rule-only
   * agents — the pipeline then runs the deterministic rule lane end to end.
   * Returns the model's text content; errors propagate to the caller's
   * degradation ladder (rules-llm-down).
   */
  llmChat?: (params: ChatParams) => Promise<string>;
  /**
   * Device execution seam — the agent's own DeviceCommandCoordinator lane.
   * `actor` rides device audit trails (T-608/T-712 conventions).
   */
  executeDeviceCommand: (
    deviceId: string,
    command: string,
    params: Record<string, unknown> | undefined,
    options: { actor: string },
  ) => Promise<{ success: boolean; result?: unknown; error?: string }>;
  /**
   * VERIFY-BEFORE-ACT seam (cognitive architecture Phase 4, §4.4 + §5.6
   * verification path): the PLATFORM runs the would-be device command on a
   * private fork of the live world and returns the prediction. Absent (or
   * returning null) = no verification lane: execution proceeds exactly as
   * before (the check degrades honestly, never silently blocks). A
   * 'degradation' verdict BLOCKS the batch — the LLM proposes, the
   * simulation verifies (the fallback plan is to not act).
   */
  verifyWhatIf?: (intervention: WhatIfIntervention) => Promise<WhatIfResult | null>;
  /**
   * R46C-P0-A: platform-injected DEVICE-OWNERSHIP gate. The NL channel's
   * final device targets are only known here — in the decision's
   * deviceActions or bridged out of the prose — so the boundary runs at the
   * EXECUTION layer, once per device that is about to be commanded. The
   * gate MAY THROW to deny; a denial is a REQUEST-LEVEL failure (the same
   * semantics as the direct simulation-command channel), NOT pipeline
   * degradation — it propagates out to the caller wrapped in
   * NLDeviceGateError instead of landing in the honest-failure result.
   * Absent = no gate (rule-only lane, tests, single-owner worlds).
   */
  assertDeviceCommand?: (deviceId: string) => void;
  /**
   * R6-E-F09: the HONEST invocable-flow listing for this agent — the SAME
   * source the decision lane's INVOCABLE_FLOWS prompt section reads
   * (agentInvocableFlowOfferings, runAsAgent's gate oracle). The NL decision
   * prompt renders it verbatim and the flowId validation checks against it,
   * so the model can neither invent a flowId nor be told a flow exists when
   * it does not. Absent → the prompt carries no flow section and every
   * invoke_flow decision is refused honestly.
   */
  invocableFlows?: () => readonly InvocableFlowOffering[];
  /**
   * R6-E-F09: the governed flow-invocation lane — FlowEngine.runAsAgent
   * (flag + T-201 tenant + inputs oracle gates), the SAME path the decision
   * lane's invoke_flow takes. Absent → no invocation lane is wired; an
   * invoke_flow decision degrades to an honest refusal, never a fake success.
   */
  invokeFlow?: (
    flowId: string,
    params?: Record<string, unknown>,
  ) => Promise<AgentFlowInvocationOutcome>;
}

// ============================================================================
// Execution + pipeline results
// ============================================================================

/** One executed (or attempted) device action. */
export interface NLExecutedAction {
  deviceId: string;
  /** R51: operator-facing name — the reply line reads this, not the id. */
  deviceName?: string;
  command: string;
  params?: Record<string, unknown>;
  success: boolean;
  error?: string;
}

/** What actually happened when the decision's action plan ran. */
export interface NLExecutionResult {
  success: boolean;
  message?: string;
  actions: NLExecutedAction[];
  /**
   * R46-P0 (execution honesty): true when the pipeline expected device
   * execution but NOTHING ran (decision wait/defer/escalate, or an
   * execution round that produced zero commands). `success` then reads
   * false — a machine consumer must never mistake a no-op for a fulfilled
   * command (the R46 false-positive pattern: success:true, actions:[]).
   */
  executedNothing?: boolean;
  /** Bridge rejections (teaching reasons) — never silently dropped. */
  rejected?: Array<{ deviceId?: string; command?: string; reason: string }>;
  /** Values clamped into device-safe ranges (recorded, never silent). */
  clamped?: string[];
  /**
   * VERIFY-BEFORE-ACT outcome (Phase 4): present when the verification seam
   * ran before execution — carries the verdict ('degradation' blocked the
   * batch) or marks the attempt unverified (lane failure — honest note).
   */
  verification?: {
    verdict: 'improvement' | 'degradation' | 'neutral' | 'inconclusive' | 'unverified';
    explanation: string;
  };
  /**
   * R6-E-F09: the outcome of an invoke_flow decision — present when the
   * decision's primary action was 'invoke_flow'. 'invoked' carries the run
   * id/status (the run itself may be FAILED — the agent DID invoke);
   * 'refused' carries the gate's teaching reason (unknown/uninvocable flow,
   * no lane wired). A hallucinated flowId lands here as 'refused' — never
   * reported as a match.
   */
  flowInvocation?: {
    flowId: string;
    status: 'invoked' | 'refused';
    runId?: string;
    runStatus?: string;
    reason?: string;
  };
}

/** The full POST /api/agents/:id/command payload (intent→decision→exec→NL). */
export interface NLCommandResult {
  agentId: string;
  intent: NLCommandIntent;
  cognitiveDecision: CognitiveDecision;
  /** Which lane produced the decision: llm | rules | emergency. */
  decisionSource: 'llm' | 'rules' | 'emergency';
  executionResult: NLExecutionResult;
  naturalLanguageResponse: string;
}

/** Structured answer data for the /ask lane (questions never actuate). */
export interface NLAskData {
  /** Populated for status questions: per-zone parameter values. */
  zones?: Array<{ zoneId: string; name?: string; parameters: Record<string, number | boolean> }>;
  /** Populated for status questions: own-device snapshots. */
  devices?: Array<{ deviceId: string; name: string; online: boolean; state?: Record<string, unknown> }>;
  /**
   * Populated for explanatory questions: a READ-ONLY situation assessment
   * (the same CognitiveDecision contract, its action plan ignored).
   */
  assessment?: CognitiveDecision;
}

/** The full POST /api/agents/:id/ask payload. */
export interface NLAskResult {
  agentId: string;
  /** The question kind the parser resolved (get_status | help | unknown…). */
  intent: NLCommandIntent;
  data: NLAskData;
  naturalLanguageResponse: string;
}

/**
 * 一次 NL 交互的可观测摘要（trajectory 埋点用）：agent 在交互结束时发给
 * 监听器（EngineRuntime 接到 TrajectoryRecorder.recordNLInteraction），
 * recorder 再按 agentId 认领本次交互的 LLM 调用（prompt/rawResponse）。
 */
export interface NLInteractionTrace {
  agentId: string;
  agentName?: string;
  lane: 'command' | 'ask';
  /** 操作者原文。 */
  text: string;
  intentAction: string;
  parseSource: string;
  /** 最终认知决策的 primary action（ask 道无评估时为意图动作）。 */
  decision: string;
  decisionSource: string;
  reasoning?: string;
  executedCommands?: number;
  success?: boolean;
  /** R6-E-F09: invoke_flow 决策的执行回执（invoked/refused + runId/原因）。 */
  flowInvocation?: {
    flowId: string;
    status: string;
    runId?: string;
    runStatus?: string;
    reason?: string;
  };
}
