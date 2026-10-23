/**
 * TrajectoryRecorder — per-(event, agent) decision trajectory persistence
 *
 * Closes the loop state → action → outcome for agent-learning research:
 * every AC necessity assessment produced while an experiment event is in
 * flight is joined with (a) the LLM call that produced it (prompt, raw
 * response, tokens, latency) and (b) the outcome the experiment runner
 * computes (ground-truth decision + interaction type, goal achievement),
 * then persisted as one JSONL record per (event, agent) assessment.
 *
 * Output (Living-worlds P2, SIZE-SEGMENTED): records append to
 * `{outputDir}/{condition}-iter{N}-{scenario}-{model}/segment-<n>.jsonl`
 * (model name sanitized for the filesystem — `:`/`/` are not valid in
 * Windows file names); the active segment rotates at `segmentMaxBytes`
 * (default 50MB — below the replay source read cap of 64MB, so every
 * segment stays a replayable source). One logical log per experiment
 * iteration; readers stitch segments (see server trajectory-store).
 * A pre-P2 single file `{base}.jsonl` in the same dir is APPENDED AFTER
 * (read as the oldest segment) — migration is structural. Sealed segments
 * are never rewritten; the T-011 cap discipline (write-time bound, amortized
 * rotation) carries over from sim-timeline.
 *
 * Write strategy: WRITE-THROUGH. Each completed record is appended to the
 * JSONL segment as soon as its outcome is known, so a crash/timeout mid-run
 * loses at most the in-flight event rather than a whole iteration buffer.
 * Volume is small (a handful of records per event), so per-record appends
 * are cheap. `finalize()` only clears in-memory join state.
 *
 * Correlation: LLM-call logs carry `context.eventId` (set by the runner via
 * LLMClient.setContextProvider while an event is in flight) and are joined
 * to assessments by (agentId, eventId). When eventId is absent the recorder
 * falls back to agentId + nearest timestamp.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { SystemEvent } from '@active-collaboration/shared';
import type { ACNecessityAssessment } from '../decision/ACNecessityAssessor.js';
import type { CognitiveDecision } from '../decision/cognitive-decision.js';
import {
  appendSegmentedLine,
  appendTargetPath,
  listRawFiles,
  segmentedLogOf,
  type SegmentedLogPaths,
} from '../storage/segmented-log.js';
import { truncateForStorage } from '../utils/truncate.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of a single LLM-call log entry, mirroring the parameter object of
 * LLMLoggingCallback in @active-collaboration/llm-integration (declared
 * structurally here so core does not depend on that package's internals).
 */
export interface TrajectoryLLMCall {
  systemPrompt?: string;
  userPrompt: string;
  response: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  model?: string;
  success: boolean;
  errorMessage?: string;
  context?: {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
    decisionResult?: unknown;
    eventId?: string;
  };
}

/** T-054 write-time caps for collaboration-response context lists. */
export const MAX_CONTEXT_PARTNER_SERVICES = 50;
export const MAX_CONTEXT_DEVICES = 20;

/**
 * R81-D2 (R44-F4): opening line of the responder's proposal-evaluation
 * prompt (CollaborationProposalHandler.analyzeWithLLM) — the write-time
 * marker that joins a handshake answer to the LLM call that produced it.
 */
export const PROPOSAL_EVALUATION_PROMPT_MARKER = 'COLLABORATION PROPOSAL EVALUATION';

/**
 * NL 意图道（command-parser / nl-orchestrator）prompt 的公共标记：意图
 * 解析与决策/评估两类 prompt 的 user 消息都含 `NL_COMMAND`。决策类
 * prompt 另含 `PARSED_INTENT`（buildDecisionPrompt），用于区分 stage。
 */
export const NL_PROMPT_MARKER = 'NL_COMMAND';
export const NL_DECISION_STAGE_MARKER = 'PARSED_INTENT';

/** recordNLInteraction 单次交互最多认领的 NL 调用数（正常为 ≤2：解析 + 决策）。 */
export const MAX_NL_CALLS_PER_INTERACTION = 4;

/** Ground truth + outcome for one (agent, event) pair, supplied by the runner. */
export interface TrajectoryOutcome {
  eventId: string;
  agentId: string;
  groundTruth: {
    correctDecision: string;
    interactionType: string;
  };
  goalAchieved?: boolean;
}

/** One trajectory record: state → action → outcome for one (event, agent). */
export interface TrajectoryRecord {
  recordedAt: string;
  scenario: string;
  condition: string;
  iteration: number;
  eventId: string;
  agentId: string;
  /**
   * Record kind. 'assessment' (default when absent) is a Layer-2 AC
   * necessity assessment; 'collaboration-response' is an AC handshake
   * record (a partner's accept/reject, or the initiator-side cancel when
   * the handshake times out or is rejected by everyone); 'llm-failure' is
   * a write-through record for a FAILED LLM call (T-105) — the decision it
   * was made for is dropped, so no assessment/outcome will ever claim it;
   * 'nl-interaction' is a server-side natural-language command/ask
   * interaction (command-parser / nl-orchestrator) — one record per NL
   * LLM call (intent-parse + decision stages), plus a prompt-less record
   * for rule-only interactions; 'device-execution' (R6-E-F10) is a device
   * command execution receipt (success/failure, result, timing) closing
   * the decision → execution → world-feedback chain.
   */
  kind?: 'assessment' | 'collaboration-response' | 'llm-failure' | 'nl-interaction' | 'device-execution';
  /**
   * R6-E-F10: 设备命令执行回执（kind 'device-execution' 记录）：
   * deviceId/command/params/result（截断 JSON 字符串）/success/error/
   * executionTime/actor。actor 区分触发源（'engine:agent:<id>' /
   * 'engine:flow:<flowId>' / 'user:<id>' …），eventId 关联触发它的决策事件。
   */
  deviceExecution?: {
    deviceId: string;
    deviceName?: string;
    command: string;
    /** 截断后的 JSON 字符串（T-106 写时口径）。 */
    params?: string;
    success: boolean;
    /** 截断后的 JSON 字符串（设备结果值）。 */
    result?: string;
    error?: string;
    executionTime?: number;
    actor?: string;
  };
  /**
   * NL 交互元数据（kind 'nl-interaction' 记录）：操作者原文（写时截断）、
   * 解析出的意图与最终结果。stage 'intent' = 意图解析调用的记录，
   * 'decision' = 决策/评估调用的记录，'rules' = 无 LLM 调用的纯规则交互。
   */
  nl?: {
    lane: 'command' | 'ask';
    stage: 'intent' | 'decision' | 'rules';
    text: string;
    intentAction: string;
    parseSource: string;
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
  };
  /**
   * Provider/evaluation error message — set on 'llm-failure' records, and
   * (R5-F10) on 'collaboration-response' records whose decisionSource is
   * 'fallback', carrying the error that knocked the evaluation LLM out.
   */
  errorMessage?: string;
  /** AC collaboration id — set on 'collaboration-response' records. */
  collaborationId?: string;
  /**
   * Human-readable rationale for the decision. For assessments this is the
   * assessor's reasoning (LLM or preCheck/rule); for collaboration
   * responses it is the responder's evaluation reasoning.
   */
  reasoning?: string;
  /**
   * R15-D3: structured twin of `reasoning` for rule/precheck decisions
   * (code + interpolation params) so replay consumers can localize.
   */
  reasoningCode?: string;
  reasoningParams?: Record<string, string | number>;
  /** Compact agent-context summary (capabilities, zones, partner services). */
  context: {
    capabilities: string[];
    managedZoneIds?: string[];
    actuatorZoneIds?: string[];
    partnerServices: Array<{
      serviceName: string;
      capabilities: string[];
      providerAgentId: string;
    }>;
    partnerServicesTotal: number;
    /**
     * T-054: the responder's bound devices at answer time — the honest
     * actuation surface behind an accept/reject (collaboration-response
     * records; bounded at write time, see MAX_CONTEXT_DEVICES).
     */
    devices?: Array<{
      id: string;
      name: string;
      capabilities: string[];
      zoneId?: string;
    }>;
    /** T-054: the answering provider agent id (collaboration-response records). */
    providerAgentId?: string;
    /**
     * P5 (R44-extreme-F3): the collaboration's REAL initiator
     * (collaboration-response records) — pre-fix the record was self-only
     * (agentId = providerAgentId = responder), so undirected collaboration
     * edges deduped to zero.
     */
    initiatorAgentId?: string;
    /**
     * P5: the capabilities the answered proposal requested
     * (collaboration-response records) — the funnel joins them against the
     * responder's service face to attribute semantic-service hits.
     */
    requestedCapabilities?: string[];
    /**
     * R42-A/F3 §7.1: the responder's OWN service face at answer time
     * (collaboration-response records; bounded at write time).
     */
    myServices?: Array<{
      name: string;
      semanticType: string;
      visibility?: string;
      /** P5: service origin (derived/published/flow/aggregate) when known. */
      origin?: string;
    }>;
  };
  /** Prompt seen by the model, when an LLM call was matched. */
  prompt?: {
    systemPrompt?: string;
    userPrompt: string;
  };
  /** Verbatim model response (from the assessment, else the call log). */
  rawResponse?: string;
  decision: string;
  decisionSource: string;
  /**
   * T-024-part3 (DevLoop R17): parse-quality marker for decisionSource 'llm'
   * records — 'llm-json' (structured JSON parse won) vs 'llm-fsm' (prose
   * keyword-scanner recovery). Lets eval reports measure structured-output
   * compliance per model/provider instead of only seeing the final decision.
   */
  decisionSubSource?: 'llm-json' | 'llm-fsm';
  /**
   * Phase 1 (cognitive architecture §14.1): the FULL CognitiveDecision the
   * model produced (situation / goals / actionPlan / explanation /
   * collaboration / uncertainty) — the training-data upgrade from binary
   * labels to structured multi-field labels. Present only when the
   * cognitive JSON parse won; the legacy decision/reasoning fields above
   * are its DERIVED view (deriveLegacyDecision) so old consumers and the
   * label join keep working unchanged.
   */
  cognitiveDecision?: CognitiveDecision;
  /**
   * R40-A3（认知架构 §7.5 升级通道）：该决策触发了升级（只通知不执行——
   * 通知 owner，任何设备命令都不发）。ADDITIVE：未升级/旧记录缺省。
   */
  escalated?: boolean;
  /** 升级条件说明（模型 escalationCondition 优先，缺省用阈值命中 reason）。 */
  escalationCondition?: string;
  groundTruth: {
    correctDecision: string;
    interactionType: string;
  };
  /**
   * Whether the decision matched the ground-truth correctDecision. `null`
   * when the run had no ground truth for the pair (correctDecision
   * 'unknown') — unscored, not a wrong answer.
   */
  correct: boolean | null;
  goalAchieved?: boolean;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
}

export interface TrajectoryRecorderOptions {
  /** Directory the segmented JSONL log is written to (created if missing). */
  outputDir: string;
  condition: string;
  scenario: string;
  /** Iteration number, used in the log's base name (`-iter{N}-`). */
  iteration: number;
  /** Configured model name (sanitized into the base name). */
  model?: string;
  /** Cap on partner services embedded per record (rest is counted). */
  maxPartnerServices?: number;
  /**
   * Living-worlds P0: append to an existing log instead of truncating it.
   * The resume path reuses the hibernated sim's trajectory directory — its
   * history must survive the wake ("identity and history intact"). Default
   * false keeps the one-log-per-run truncate semantics.
   */
  append?: boolean;
  /**
   * Living-worlds P2: per-segment size cap; the active segment rotates when
   * it is at the cap (sealed segments are never rewritten). `<= 0` disables
   * rotation. Default DEFAULT_TRAJECTORY_SEGMENT_BYTES (50MB — below the
   * replay source read cap, the T-011 read-cap-coupling lesson).
   */
  segmentMaxBytes?: number;
}

/** Default per-segment cap (P2): 50MB, below the 64MB replay read cap. */
export const DEFAULT_TRAJECTORY_SEGMENT_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal join state
// ---------------------------------------------------------------------------

interface LLMCallEntry {
  call: TrajectoryLLMCall;
  /** Wall-clock ms when the log arrived (for nearest-timestamp fallback). */
  loggedAt: number;
  consumed: boolean;
}

interface PendingAssessment {
  assessment: ACNecessityAssessment;
  eventId: string;
  agentId: string;
  assessedAt: number;
}

// ---------------------------------------------------------------------------
// TrajectoryRecorder
// ---------------------------------------------------------------------------

export class TrajectoryRecorder {
  /**
   * Path of the ACTIVE segment (the append target; rotates over the run).
   * Post-P2 this is a segment file inside `{outputDir}/{base}/` — consumers
   * that need the WHOLE log should read the directory (stitched), not this
   * single path. Null-free by construction once the recorder exists.
   */
  readonly filePath: string;
  private readonly log: SegmentedLogPaths;
  private readonly segmentMaxBytes: number;
  private readonly condition: string;
  private readonly scenario: string;
  private readonly iteration: number;
  private readonly maxPartnerServices: number;

  private llmCalls: LLMCallEntry[] = [];
  private pending = new Map<string, PendingAssessment>();
  private recordCount = 0;

  constructor(options: TrajectoryRecorderOptions) {
    this.condition = options.condition;
    this.scenario = options.scenario;
    this.iteration = options.iteration;
    this.maxPartnerServices = options.maxPartnerServices ?? 10;
    this.segmentMaxBytes = options.segmentMaxBytes ?? DEFAULT_TRAJECTORY_SEGMENT_BYTES;

    const modelSlug = (options.model ?? 'unknown').replace(/[:/\\]/g, '-');
    const baseName =
      `${options.condition}-iter${options.iteration}-${options.scenario}-${modelSlug}`;
    this.log = segmentedLogOf(options.outputDir, baseName);

    mkdirSync(options.outputDir, { recursive: true });
    const rawFiles = listRawFiles(this.log);
    if (options.append === true && rawFiles.length > 0) {
      // Living-worlds P0 resume: the log already carries the hibernated
      // sim's decision history — count its records (legacy file + segments)
      // and keep appending to the newest segment.
      this.recordCount = rawFiles.reduce((sum, file) => sum + countJsonlRecords(file), 0);
    } else {
      // Truncate: one log per iteration, recreated on (re)run. Wipes the
      // segment dir (segments + stale rollups of the previous run of this
      // iteration) and any pre-P2 single file of the same base name.
      rmSync(this.log.segmentDir, { recursive: true, force: true });
      rmSync(this.log.legacyFile, { force: true });
    }
    this.filePath = this.activePath();
  }

  /** Number of records written so far (plus any resumed history). */
  get size(): number {
    return this.recordCount;
  }

  /** Path the next append will land on (the active segment, rotating). */
  private activePath(): string {
    return appendTargetPath(this.log);
  }

  /**
   * Write-through append of one serialized record with segment rotation
   * (all three record lanes funnel through here — one rotation point).
   */
  private appendLine(line: string): void {
    appendSegmentedLine(this.log, line, this.segmentMaxBytes);
  }

  /**
   * Consume one LLM-call log (from LLMClient.setLoggingCallback).
   * Called as an ADDITIONAL consumer alongside the runner's token accounting.
   */
  recordLLMCall(call: TrajectoryLLMCall): void {
    if (call.success === false) {
      // T-105: a failed call will never be matched by an assessment
      // outcome (the decision it was made for is dropped) — write it
      // through immediately instead of holding it in the pool forever.
      this.appendLLMFailureRecord(call);
      return;
    }
    this.llmCalls.push({ call, loggedAt: Date.now(), consumed: false });
  }

  /**
   * Write one 'llm-failure' record: prompt, error message and timing of the
   * failed call, correlated by whatever context the client provided.
   */
  private appendLLMFailureRecord(call: TrajectoryLLMCall): void {
    const record: TrajectoryRecord = {
      recordedAt: new Date().toISOString(),
      scenario: this.scenario,
      condition: this.condition,
      iteration: this.iteration,
      eventId: call.context?.eventId ?? 'unattributed',
      agentId: call.context?.agentId ?? 'unknown',
      kind: 'llm-failure',
      context: {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
      },
      prompt: {
        systemPrompt: call.systemPrompt,
        userPrompt: call.userPrompt,
      },
      decision: 'error',
      decisionSource: 'llm-error',
      errorMessage: call.errorMessage,
      // No ground truth exists for a call that never produced a decision.
      groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
      correct: null,
      model: call.model,
      durationMs: call.durationMs,
    };

    this.appendLine(JSON.stringify(record));
    this.recordCount++;
  }

  /**
   * Capture an assessment (from DualTriggerACManager.setAssessmentCallback).
   * Held until the runner reports the outcome for the same (agent, event).
   */
  recordAssessment(
    agentId: string,
    assessment: ACNecessityAssessment,
    event: SystemEvent,
  ): void {
    const eventId = TrajectoryRecorder.extractEventId(event);
    if (!eventId) return; // cannot correlate without an experiment event id
    this.pending.set(this.key(agentId, eventId), {
      assessment,
      eventId,
      agentId,
      assessedAt: Date.now(),
    });
  }

  /**
   * Report the outcome for one (agent, event). Assembles the full record
   * (assessment + matched LLM call + outcome) and appends it to the JSONL
   * file immediately (write-through).
   *
   * No-op when no assessment is pending for the pair — e.g. events filtered
   * by Layer 1 never reach Layer 2 and intentionally produce no record.
   */
  recordOutcome(outcome: TrajectoryOutcome): void {
    const key = this.key(outcome.agentId, outcome.eventId);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);

    const { assessment } = pending;
    // preCheck/rule decisions never made an LLM call — do not consume one
    // from the pool (it would steal the call belonging to another agent's
    // LLM record and misattribute that call's model to this decision).
    const llmCall = assessment.decisionSource === 'precheck' || assessment.decisionSource === 'rule'
      ? undefined
      : this.matchLLMCall(
          outcome.agentId,
          outcome.eventId,
          pending.assessedAt,
          assessment.agentContext?.agentName,
        );
    const agentContext = assessment.agentContext;
    const services = agentContext.discoverableServices ?? [];

    const record: TrajectoryRecord = {
      recordedAt: new Date().toISOString(),
      scenario: this.scenario,
      condition: this.condition,
      iteration: this.iteration,
      eventId: outcome.eventId,
      agentId: outcome.agentId,
      context: {
        capabilities: [...(agentContext.capabilities ?? [])],
        managedZoneIds: agentContext.managedZoneIds
          ? [...agentContext.managedZoneIds]
          : undefined,
        actuatorZoneIds: agentContext.actuatorZoneIds
          ? [...agentContext.actuatorZoneIds]
          : undefined,
        partnerServices: services.slice(0, this.maxPartnerServices).map(s => ({
          serviceName: s.serviceName,
          capabilities: [...s.capabilities],
          providerAgentId: s.providerAgentId,
        })),
        partnerServicesTotal: services.length,
      },
      prompt: llmCall
        ? {
            systemPrompt: llmCall.call.systemPrompt,
            userPrompt: llmCall.call.userPrompt,
          }
        : undefined,
      // T-106: the assessor caps its own rawResponse, but the call-log
      // fallback here carries the verbatim backend answer — cap it too.
      rawResponse: assessment.llmAssessment?.rawResponse ??
        truncateForStorage(llmCall?.call.response),
      decision: assessment.decision,
      decisionSource: assessment.decisionSource,
      // T-024-part3: parse-quality marker rides the JSONL beside its decision
      // (llm assessments only — the assessor never sets it elsewhere).
      decisionSubSource: assessment.llmAssessment?.decisionSubSource,
      // Phase 1 (§14.1): the full structured decision rides the trajectory —
      // the training export's format=structured consumes this directly.
      // The cognitive text fields ride the same T-106 write-time caps as
      // reasoning (parseCognitiveDecision keeps strings bounded by contract).
      ...(assessment.cognitiveDecision !== undefined
        ? { cognitiveDecision: assessment.cognitiveDecision }
        : {}),
      // R40-A3（§7.5 升级通道）：升级标注随 JSONL 落账（训练/回放侧可见
      // "该决策升级给了 owner，有意未执行"）。
      ...(assessment.escalated === true ? { escalated: true } : {}),
      ...(assessment.escalationCondition !== undefined
        ? { escalationCondition: assessment.escalationCondition }
        : {}),
      // Reasoning is recorded for EVERY decision source — preCheck/rule
      // decisions carry no prompt/rawResponse, so without this their
      // rationale was unauditable (Fix-8). R15-D3: the structured twin rides
      // along for the same records.
      reasoning: assessment.llmAssessment?.reasoning,
      reasoningCode: assessment.llmAssessment?.reasoningCode,
      reasoningParams: assessment.llmAssessment?.reasoningParams,
      groundTruth: outcome.groundTruth,
      // Unscored pairs (no ground truth — correctDecision 'unknown') are
      // null, never a false "wrong" verdict (T-014: 45/45 correct:false).
      correct: outcome.groundTruth.correctDecision === 'unknown'
        ? null
        : assessment.decision === outcome.groundTruth.correctDecision,
      goalAchieved: outcome.goalAchieved,
      model: llmCall?.call.model,
      promptTokens: llmCall?.call.promptTokens,
      completionTokens: llmCall?.call.completionTokens,
      durationMs: llmCall?.call.durationMs,
    };

    this.appendLine(JSON.stringify(record));
    this.recordCount++;
  }

  /**
   * Record one AC handshake event (Fix-8): a partner's accept/reject of a
   * collaboration proposal, or the initiator-side cancel when the handshake
   * fails (all partners rejected, or the response timeout elapsed).
   *
   * Wave-4a: the negotiation steps that now converge into the handshake are
   * recorded too — a partner's 'counter'/'defer' answers, and the
   * initiator's rejection of a counter (recorded as a 'reject' of that
   * partner). A counter ACCEPT is not recorded separately: the responder's
   * join-response accept follows and records the closing 'accept'.
   *
   * Written through immediately, like assessment records. The record is
   * correlated by `collaborationId`; `eventId` carries the originating
   * injection id when known so trajectory queries by event still find it.
   */
  recordCollaborationResponse(entry: {
    collaborationId: string;
    agentId: string;
    decision: 'accept' | 'reject' | 'cancelled' | 'counter' | 'defer';
    decisionSource: 'llm' | 'rule' | 'fallback' | 'timeout' | 'aborted';
    reasoning?: string;
    eventId?: string;
    model?: string;
    /**
     * R5-F10: on a 'fallback' answer, the error that knocked the LLM out
     * (evaluation timeout, provider failure, unparseable output) — carried
     * onto the record's errorMessage so the degradation is attributable
     * instead of a bare decisionSource 'fallback'.
     */
    errorMessage?: string;
    /**
     * T-202: the responder's real context at answer time (capability
     * surface + partner services + provider agent). Empty lists only when
     * genuinely unknown — the pre-fix hard-coded `capabilities: []` made
     * every handshake record look like it happened in a vacuum (FF-F05).
     */
    context?: {
      capabilities?: string[];
      partnerServices?: Array<{
        serviceName: string;
        capabilities: string[];
        providerAgentId: string;
      }>;
      /**
       * T-054: the responder's bound devices at answer time — carried into
       * the record (bounded) instead of dropped.
       */
      devices?: Array<{
        id: string;
        name: string;
        capabilities: string[];
        zoneId?: string;
      }>;
      providerAgentId?: string;
      /**
       * P5 (R44-extreme-F3): the collaboration's real initiator (from the
       * answered proposal).
       */
      initiatorAgentId?: string;
      /**
       * P5: the capabilities the answered proposal requested (bounded
       * upstream at parse time).
       */
      requestedCapabilities?: string[];
      /**
       * R42-A/F3 §7.1: the responder's OWN service face at answer time
       * (bounded like devices) — the catalog the accept/reject saw.
       */
      myServices?: Array<{
        name: string;
        semanticType: string;
        visibility?: string;
        /** P5: service origin when the seam knows it. */
        origin?: string;
      }>;
    };
  }): void {
    // T-054 write-time caps (the standing lesson): the lists ride every
    // record forever, so bound them at the write — totals keep the honest
    // count even when the visible list is truncated.
    const allPartnerServices = entry.context?.partnerServices ?? [];
    const partnerServices = allPartnerServices.slice(0, MAX_CONTEXT_PARTNER_SERVICES);
    const devices = entry.context?.devices?.slice(0, MAX_CONTEXT_DEVICES) ?? [];
    const myServices = entry.context?.myServices?.slice(0, MAX_CONTEXT_PARTNER_SERVICES) ?? [];
    // R81-D2 (R44-F4): an 'llm'-sourced answer consumed a proposal-EVALUATION
    // call — claim it from the pool so the record carries the call's prompt,
    // raw response, actual model and durationMs like assessment records do
    // (the responder's call logs right before its answer publishes).
    // rule/fallback/timeout answers made no call — never consume one (it
    // would steal another agent's call).
    const llmCall = entry.decisionSource === 'llm'
      ? this.matchProposalEvaluationCall()
      : undefined;
    const record: TrajectoryRecord = {
      recordedAt: new Date().toISOString(),
      scenario: this.scenario,
      condition: this.condition,
      iteration: this.iteration,
      eventId: entry.eventId ?? entry.collaborationId,
      agentId: entry.agentId,
      kind: 'collaboration-response',
      collaborationId: entry.collaborationId,
      context: {
        capabilities: entry.context?.capabilities ?? [],
        partnerServices,
        partnerServicesTotal: allPartnerServices.length,
        ...(devices.length > 0 ? { devices } : {}),
        ...(entry.context?.providerAgentId !== undefined
          ? { providerAgentId: entry.context.providerAgentId }
          : {}),
        ...(entry.context?.initiatorAgentId !== undefined
          ? { initiatorAgentId: entry.context.initiatorAgentId }
          : {}),
        ...(entry.context?.requestedCapabilities !== undefined &&
            entry.context.requestedCapabilities.length > 0
          ? { requestedCapabilities: [...entry.context.requestedCapabilities] }
          : {}),
        ...(myServices.length > 0 ? { myServices } : {}),
      },
      decision: entry.decision,
      decisionSource: entry.decisionSource,
      reasoning: entry.reasoning,
      // R81-D2 完成（训练数据缺口修复）：匹配到的评估调用把 prompt 与
      // rawResponse 也落账——与决策道记录同构。原 R81-D2 只复制
      // model/durationMs，join 到的调用体被丢弃，responder 道因此结构性
      // 缺 prompt（蒸馏实测 461/646 条 noPrompt）。
      ...(llmCall !== undefined
        ? {
            prompt: {
              systemPrompt: llmCall.call.systemPrompt,
              userPrompt: llmCall.call.userPrompt,
            },
            // T-106 同一写时截断口径（与决策道的 call-log fallback 一致）。
            rawResponse: truncateForStorage(llmCall.call.response),
          }
        : {}),
      // R5-F10: why the LLM did not participate (fallback answers only).
      ...(entry.errorMessage !== undefined ? { errorMessage: entry.errorMessage } : {}),
      groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
      // Handshake responses carry no ground truth — unscored (null), not wrong.
      correct: null,
      model: entry.model ?? llmCall?.call.model,
      // R81-D2 (R44-F4): the evaluation call's latency — without it the
      // trajectory could only ledger-count answers, never attribute time.
      durationMs: llmCall?.call.durationMs,
    };

    this.appendLine(JSON.stringify(record));
    this.recordCount++;
  }

  /**
   * NL 意图道埋点（训练数据缺口修复；T-022 精神：所有 LLM 调用可观测）：
   * server 侧一次 NL 交互（POST /api/agents/:id/command | /ask →
   * command-parser / nl-orchestrator）落 trajectory。
   *
   * 交互内的 NL LLM 调用（意图解析 + 决策/评估，经 logging callback 进
   * 池、带 context.agentId）逐条认领：每次调用写一条 kind
   * 'nl-interaction' 记录，携带该调用的 prompt/rawResponse/tokens/
   * latency，stage 区分 'intent'（解析）与 'decision'（决策/评估）——
   * 两条都是合法训练对（原文+设备面 → 意图 JSON；意图+上下文 → 认知
   * 决策）。纯规则交互（emergency/help/status 短路、rule-only agent、
   * LLM 全挂）没有调用可认领，写一条无 prompt 的 stage 'rules' 诚实
   * 记录（解析结果仍可见，与 assessment 的 rule/precheck 记录同精神）。
   *
   * NL 是用户驱动低频道，写通过、无结算等待。
   */
  recordNLInteraction(entry: {
    agentId: string;
    agentName?: string;
    lane: 'command' | 'ask';
    /** 操作者原文（写时按存储口径截断；路由侧已限 2000 字符）。 */
    text: string;
    /** 解析出的意图动作（NLCommandIntent.action）。 */
    intentAction: string;
    /** 意图解析来源（'llm' | 'rules' | 'rules-llm-down'）。 */
    parseSource: string;
    /** 最终认知决策的 primary action（ask 道无决策时为意图动作）。 */
    decision: string;
    /** 决策来源（'llm' | 'rules' | 'emergency' | 'ask' …）。 */
    decisionSource: string;
    /** 决策/解释摘要（decision-stage 与 rules 记录的 reasoning）。 */
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
  }): void {
    const calls = this.claimNLCalls(entry.agentId);
    const text = truncateForStorage(entry.text) ?? '';
    const nlBase = {
      lane: entry.lane,
      text,
      intentAction: entry.intentAction,
      parseSource: entry.parseSource,
      ...(entry.executedCommands !== undefined ? { executedCommands: entry.executedCommands } : {}),
      ...(entry.success !== undefined ? { success: entry.success } : {}),
      ...(entry.flowInvocation !== undefined
        ? {
            flowInvocation: {
              flowId: entry.flowInvocation.flowId,
              status: entry.flowInvocation.status,
              ...(entry.flowInvocation.runId !== undefined ? { runId: entry.flowInvocation.runId } : {}),
              ...(entry.flowInvocation.runStatus !== undefined ? { runStatus: entry.flowInvocation.runStatus } : {}),
              ...(entry.flowInvocation.reason !== undefined
                ? { reason: truncateForStorage(entry.flowInvocation.reason, 512)! }
                : {}),
            },
          }
        : {}),
    };
    const baseRecord = {
      recordedAt: new Date().toISOString(),
      scenario: this.scenario,
      condition: this.condition,
      iteration: this.iteration,
      agentId: entry.agentId,
      kind: 'nl-interaction' as const,
      context: {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
      },
      // NL 交互无 ground truth —— 不评分（null），与握手记录同口径。
      groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
      correct: null,
    };

    if (calls.length === 0) {
      const record: TrajectoryRecord = {
        ...baseRecord,
        eventId: this.nlEventId(),
        nl: { ...nlBase, stage: 'rules' },
        decision: entry.decision,
        decisionSource: entry.decisionSource,
        reasoning: entry.reasoning,
      };
      this.appendLine(JSON.stringify(record));
      this.recordCount++;
      return;
    }

    for (const { call } of calls) {
      const stage = call.userPrompt.includes(NL_DECISION_STAGE_MARKER) ? 'decision' as const : 'intent' as const;
      const record: TrajectoryRecord = {
        ...baseRecord,
        eventId: this.nlEventId(),
        nl: { ...nlBase, stage },
        prompt: {
          systemPrompt: call.systemPrompt,
          userPrompt: call.userPrompt,
        },
        // T-106 同一写时截断口径。
        rawResponse: truncateForStorage(call.response),
        decision: stage === 'intent' ? entry.intentAction : entry.decision,
        decisionSource: stage === 'intent' ? entry.parseSource : entry.decisionSource,
        ...(stage !== 'intent' && entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
        // R6-C-F04: a rules-llm-down intent with a CLAIMED call means the
        // LLM call succeeded at transport but its answer was unusable
        // (unparseable) — a degraded LLM call the write-through llm-failure
        // ledger never sees (that ledger only covers call failures, and a
        // failed call is never pooled/claimed). Tag it like R5-F14's
        // collaboration-response errorMessage so eval-report's llmFailures
        // covers the NL lane too.
        ...(stage === 'intent' && entry.parseSource === 'rules-llm-down'
          ? { errorMessage: 'LLM intent parse degraded to rules (rules-llm-down) — the call returned an unusable answer' }
          : {}),
        model: call.model,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        durationMs: call.durationMs,
      };
      this.appendLine(JSON.stringify(record));
      this.recordCount++;
    }
  }

  /** NL 记录的相关 id（无实验事件可归 —— 用户驱动道）。 */
  private nlEventId(): string {
    return `nl-${Date.now().toString(36)}-${this.recordCount}`;
  }

  /**
   * R6-E-F10：设备命令执行回执落 trajectory —— 关闭"决策→执行→世界反馈"
   * 链路上最大的可观测盲区（此前只有决策的计划面，live 路径 goalAchieved
   * 恒缺）。EngineRuntime 订阅 DEVICE_OPERATION_EXECUTED，每条命令（成功
   * 或失败）写一条 kind 'device-execution' 记录，携带
   * deviceId/command/params/result/executionTime/actor 与可归的 eventId
   * （决策触发的命令在事件在飞时执行，eventId 即触发它的注入事件；NL/
   * 手动道无事件可归，标 'unattributed'）。T-102 去重在调用方（同一命令
   * 的设备自发 emission + coordinator echo 只记首达）。写通过，无结算
   * 等待；params/result 按 T-106 存储口径截断。
   */
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
  }): void {
    const jsonField = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      try {
        return truncateForStorage(JSON.stringify(value) ?? '', 4096);
      } catch {
        return truncateForStorage(String(value), 4096);
      }
    };
    const record: TrajectoryRecord = {
      recordedAt: new Date().toISOString(),
      scenario: this.scenario,
      condition: this.condition,
      iteration: this.iteration,
      eventId: entry.eventId ?? 'unattributed',
      agentId: entry.agentId,
      kind: 'device-execution',
      context: {
        capabilities: [],
        partnerServices: [],
        partnerServicesTotal: 0,
      },
      deviceExecution: {
        deviceId: entry.deviceId,
        ...(entry.deviceName !== undefined ? { deviceName: entry.deviceName } : {}),
        command: entry.command,
        ...(jsonField(entry.params) !== undefined ? { params: jsonField(entry.params)! } : {}),
        success: entry.success,
        ...(jsonField(entry.result) !== undefined ? { result: jsonField(entry.result)! } : {}),
        ...(entry.error !== undefined ? { error: truncateForStorage(entry.error, 2048)! } : {}),
        ...(entry.executionTime !== undefined ? { executionTime: entry.executionTime } : {}),
        ...(entry.actor !== undefined ? { actor: entry.actor } : {}),
      },
      decision: entry.success ? 'executed' : 'failed',
      decisionSource: entry.actor ?? 'engine',
      // 执行回执无 ground truth —— 不评分（null），与握手/NL 记录同口径。
      groundTruth: { correctDecision: 'unknown', interactionType: 'unknown' },
      correct: null,
    };
    this.appendLine(JSON.stringify(record));
    this.recordCount++;
  }

  /**
   * End-of-iteration housekeeping: clears join state so unmatched LLM calls
   * or assessments (e.g. noise-triggered ones) never leak into the next
   * iteration's matching. Records are already on disk (write-through).
   */
  finalize(): { filePath: string; recordCount: number } {
    this.llmCalls = [];
    this.pending.clear();
    return { filePath: this.filePath, recordCount: this.recordCount };
  }

  // -------------------------------------------------------------------------
  // Correlation helpers
  // -------------------------------------------------------------------------

  private key(agentId: string, eventId: string): string {
    return `${agentId}::${eventId}`;
  }

  /**
   * Join an assessment to its LLM call:
   *   1. Unconsumed calls tagged with the same context.eventId — prefer an
   *      exact context.agentId match; then the `AGENT: <name>` marker the
   *      assessor's prompt builder emits (compared against the assessing
   *      agent's name); else nearest in time.
   *   2. Fallback: unconsumed calls without eventId but with a matching
   *      context.agentId, nearest in time to the assessment.
   */
  private matchLLMCall(
    agentId: string,
    eventId: string,
    assessedAt: number,
    agentName?: string,
  ): LLMCallEntry | undefined {
    const byEvent = this.llmCalls.filter(
      e => !e.consumed && e.call.context?.eventId === eventId,
    );
    let chosen =
      byEvent.find(e => e.call.context?.agentId === agentId) ??
      this.byPromptAgentName(byEvent, agentName) ??
      this.nearest(byEvent, assessedAt);

    if (!chosen) {
      const byAgent = this.llmCalls.filter(
        e =>
          !e.consumed &&
          e.call.context?.eventId === undefined &&
          e.call.context?.agentId === agentId,
      );
      chosen = this.nearest(byAgent, assessedAt);
    }

    if (chosen) chosen.consumed = true;
    return chosen;
  }

  /**
   * 认领一次 NL 交互的 LLM 调用：池中未消费、context.agentId 属于该
   * agent、userPrompt 带 NL 标记的调用（意图解析 + 决策/评估，正常 ≤2
   * 条，上限 MAX_NL_CALLS_PER_INTERACTION 防池泄漏）。按 loggedAt 升序
   * 返回（JSONL 里先解析后决策，与调用顺序一致）。标记 consumed，防止
   * 被后续 assessment/handshake 的 join 误认领（NL 决策 prompt 与
   * 评估道共享 `AGENT: <name>` 前缀族）。
   */
  private claimNLCalls(agentId: string): LLMCallEntry[] {
    const matched = this.llmCalls.filter(
      e =>
        !e.consumed &&
        e.call.context?.agentId === agentId &&
        e.call.userPrompt.includes(NL_PROMPT_MARKER),
    );
    matched.sort((a, b) => a.loggedAt - b.loggedAt);
    const claimed = matched.slice(-MAX_NL_CALLS_PER_INTERACTION);
    for (const entry of claimed) entry.consumed = true;
    return claimed;
  }

  /**
   * R81-D2 (R44-F4): claim the responder's proposal-EVALUATION call for a
   * handshake record. The evaluation prompt (CollaborationProposalHandler)
   * is the only call family opening with the COLLABORATION PROPOSAL
   * EVALUATION marker; the call completes (and logs) immediately before its
   * accept/reject/counter/defer answer publishes, so the newest unconsumed
   * marked call is this answer's. Marked consumed so it can never be
   * double-attributed to a later assessment or response.
   */
  private matchProposalEvaluationCall(): LLMCallEntry | undefined {
    let best: LLMCallEntry | undefined;
    for (const entry of this.llmCalls) {
      if (entry.consumed) continue;
      if (!entry.call.userPrompt.startsWith(PROPOSAL_EVALUATION_PROMPT_MARKER)) continue;
      if (best === undefined || entry.loggedAt >= best.loggedAt) best = entry;
    }
    if (best !== undefined) best.consumed = true;
    return best;
  }

  /**
   * The ACNecessityAssessor prompt starts with `AGENT: <agentName> | ...`.
   * When several agents share one eventId, this identifies which call belongs
   * to which agent. Returns undefined when the marker is absent (callers fall
   * back to timestamp proximity).
   */
  private byPromptAgentName(
    entries: LLMCallEntry[],
    agentName?: string,
  ): LLMCallEntry | undefined {
    if (!agentName) return undefined;
    return entries.find(e => {
      const match = /^AGENT:\s*([^|\n]+)/m.exec(e.call.userPrompt);
      return match !== null && match[1].trim() === agentName;
    });
  }

  private nearest(entries: LLMCallEntry[], ts: number): LLMCallEntry | undefined {
    let best: LLMCallEntry | undefined;
    let bestDelta = Infinity;
    for (const entry of entries) {
      const delta = Math.abs(entry.loggedAt - ts);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = entry;
      }
    }
    return best;
  }

  /**
   * Extract the experiment event id from the SystemEvent delivered to the
   * assessment callback. The runner stamps it into both metadata and payload.
   */
  private static extractEventId(event: SystemEvent): string | undefined {
    const fromMetadata = event.metadata?.eventId;
    if (typeof fromMetadata === 'string' && fromMetadata.length > 0) return fromMetadata;
    const payload = event.payload as { eventId?: unknown } | undefined;
    if (payload && typeof payload.eventId === 'string' && payload.eventId.length > 0) {
      return payload.eventId;
    }
    return undefined;
  }
}

/**
 * Living-worlds P0: count complete JSONL records in an existing trajectory
 * file so an appended-to recorder reports an honest size (crash-truncated
 * half lines and blank tails do not count).
 */
function countJsonlRecords(filePath: string): number {
  try {
    let count = 0;
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        JSON.parse(line);
        count += 1;
      } catch {
        // half-written trailing line from a crash — not a record
      }
    }
    return count;
  } catch {
    return 0;
  }
}
