/**
 * Collaboration Proposal Handler
 *
 * Automatically evaluates and responds to incoming collaboration proposals.
 * Uses LLM-based cost-benefit analysis to decide whether to accept, reject, or counter-propose.
 */

import type {
  CollaborationProposal,
  ProposalDecision,
  ProposalEvaluation,
  ProposalHandlerConfig,
  LLMProposalAnalysis,
  ProposalServiceTerm,
  ProposalPromptTrim,
  ProposalGroundTruthFace,
} from '../types/proposal-handler.js';
import { runWithLLMAgentContext, noThinkingTemplateKwargs, type LLMClient } from '@active-collaboration/llm-integration';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import { capabilityMatches } from '../utils/capabilityMatching.js';
import { untrustedBlock } from '../security/prompt-sanitizer.js';
import {
  assessProposalGroundTruth,
  renderGroundTruthSection,
  triggerRefOf,
  type ProposalGroundTruthCheck,
} from './ground-truth.js';
import {
  assessFulfillment,
  hopContextOf,
  DownstreamDelegator,
  DEFAULT_MAX_HOP_DEPTH,
  DEFAULT_DELEGATION_TIMEOUT_MS,
  type FulfillmentGateConfig,
  type FulfillmentRecord,
} from './fulfillment-gate.js';
import type { SystemEvent } from '@active-collaboration/shared';
import { EventType, EventPriority } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
const logger = createLogger('CollaborationProposalHandler');

/**
 * Default wall-clock budget for one proposal-evaluation LLM call (Fix-12).
 * Far below the provider-level request timeout (120s class), so
 * a cold/unreachable model degrades to the capability fallback quickly
 * instead of stalling every handshake ~2 minutes (R4 小周 F-16).
 */
export const DEFAULT_EVAL_LLM_TIMEOUT_MS = 30_000;

/**
 * R5-F10: constrained-decoding schema for the evaluation verdict
 * (ChatParams.format, the F0-2 guided-JSON channel — vLLM maps it onto
 * guided decoding; LLM_GUIDED_JSON=0 / guidedJson:false omits it and the
 * extractJSON backstop below stays the only parser). Pre-fix this lane sent
 * a FREE-FORM request: a thinking/large model (qwen3.8-27b) filled the 500
 * maxTokens with reasoning, got truncated mid-draft and returned
 * unparseable content — EVERY evaluation degraded to the capability
 * fallback while the decision lane (guided, decision-v1) kept a 100% json
 * rate. The schema mirrors the JSON the prompt asks for; temperature is
 * pinned 0 like every other decision endpoint (R35: no sampling on
 * decision lanes).
 */
export const PROPOSAL_EVAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    benefitScore: { type: 'number' },
    costScore: { type: 'number' },
    benefits: { type: 'array', items: { type: 'string' } },
    costs: { type: 'array', items: { type: 'string' } },
    recommendedDecision: { type: 'string', enum: ['accept', 'reject', 'counter', 'defer'] },
    reasoning: { type: 'string' },
    counterModifications: { type: 'array', items: { type: 'string' } },
  },
  required: ['benefitScore', 'costScore', 'benefits', 'costs', 'recommendedDecision', 'reasoning'],
};

/**
 * R44-insane: above this bound-device count the YOUR DEVICES prompt section
 * switches from "list everything" to RELEVANCE FILTERING — a district
 * manager bound to all 150 facility devices put the FULL device inventory
 * into the evaluation prompt (15,885 tok + 500 out > 16,384 max_model_len)
 * and every one of its handshakes failed with a 400. Below the threshold
 * the exhaustive list stays (small agents lose nothing).
 */
export const DEVICE_LIST_FILTER_THRESHOLD = 30;

/**
 * R44-insane: how many devices the filtered YOUR DEVICES section lists
 * (best capability matches first). Capabilities NOT shown per-device still
 * reach the prompt twice — the YOUR PROFILE surface line (declared ∪ all
 * device capabilities) and the hidden devices' capability-union summary —
 * so relevance filtering never loses capability information.
 */
export const DEVICE_LIST_MAX_SHOWN = 20;

/**
 * R44-colossal: above this own-service count the YOUR SERVICES prompt section
 * switches from "list everything" to RELEVANCE FILTERING — a district manager
 * anchoring one device per facility (titanic: 250 facilities → 859 derived
 * services) rendered its FULL catalog into the evaluation prompt (~10K tok),
 * which on top of the (already filtered) device section pushed the whole
 * prompt past 16,384 max_model_len: mega-shelter-open 400'd all 6 district
 * managers in one batch. Below the threshold the exhaustive list stays.
 */
export const SERVICE_LIST_FILTER_THRESHOLD = 30;

/**
 * R44-colossal: how many services the filtered YOUR SERVICES section lists
 * (best semanticType matches first). The hidden services' semanticType union
 * rides the summary line, so the agent still sees WHAT it can productize —
 * relevance filtering, not lossy truncation.
 */
export const SERVICE_LIST_MAX_SHOWN = 20;

/**
 * R44-extreme-F1 (plan-r81 D1): TOTAL token budget for the evaluation prompt.
 * The count-based relevance filters above bound the device/service SECTIONS,
 * but nothing bounded the WHOLE prompt — on the extreme tier the district
 * steward's evaluation prompt reached ≥7,693 input tokens, and +500 reserved
 * output crossed vLLM's 8,192 max_model_len: every one of the six district
 * stewards 400'd in the same batch and degraded to the capability fallback.
 * The budget leaves ~2K of an 8,192 context for the output reservation and
 * template slack. Override via PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS or
 * config.promptBudgetTokens (config wins; sibling of the
 * AC_PROPOSAL_EVAL_LLM_TIMEOUT_MS wall-clock budget).
 */
export const DEFAULT_PROMPT_BUDGET_TOKENS = 6_000;

/**
 * Rough prompt-token estimate (no tokenizer dependency): CJK characters
 * count ~1 token each, everything else ~4 chars/token. Matches the qwen
 * tokenizer closely enough for a budget check — the headroom in
 * DEFAULT_PROMPT_BUDGET_TOKENS absorbs the error.
 */
export function estimatePromptTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/**
 * Defer re-evaluation delay (Wave-4a): how long the responder waits before
 * re-evaluating a deferred proposal. Wall-clock, like the evaluation budget
 * and the initiator's 120s handshake backstop; the cap keeps a defer from
 * pushing the final answer past that backstop.
 */
export const DEFAULT_DEFER_DELAY_MS = 30_000;
export const MAX_DEFER_DELAY_MS = 60_000;

/**
 * Where a proposal/handshake decision came from: the responder's LLM, the
 * capability fallback (LLM unavailable), or a deterministic rule (e.g. the
 * initiator rejecting a counter it cannot evaluate, Wave-4a).
 */
export type ProposalEvaluationSource = 'llm' | 'fallback' | 'rule';

/** Re-export so handler consumers get the trim record type from one place. */
export type { ProposalPromptTrim } from '../types/proposal-handler.js';

/** One bound-device row of the live device surface (T-202). */
export interface ProposalDeviceFace {
  id: string;
  name: string;
  capabilities: string[];
  zoneId?: string;
  /**
   * R44-extreme-F1: device type (e.g. 'backup-generator'), when the provider
   * knows it — used only by the budget-mode aggregate line ("type mix").
   */
  type?: string;
}

export interface CollaborationProposalHandlerOptions {
  llmClient: LLMClient;
  environment: EnvironmentCenter;
  agentId: string;
  agentName: string;
  agentCapabilities: string[];
  config: ProposalHandlerConfig;
  /**
   * T-202 live device surface: the agent's bound devices (id, name,
   * capabilities, zone) read at EVALUATION time — devices may be assigned
   * after construction, and the declared capability list alone is a thin
   * (sometimes empty) view of what the agent can actually deliver. Used to
   * enrich the LLM prompt ("YOUR DEVICES:") and the capability fallback.
   */
  deviceSurface?: () => ProposalDeviceFace[];
  /**
   * R6-C-F03 live ground-truth surface: what THIS responder itself observed
   * about the world (observable zones, per-zone readings, recent events),
   * read at EVALUATION time. When wired, the LLM prompt gains an EVENT
   * GROUND TRUTH section + a GROUND-TRUTH CHECK criterion, and the
   * capability fallback refuses to auto-accept proposals whose claimed
   * emergency contradicts those observations. Unwired seam = legacy behavior
   * (no section, no rule change — pinned by the pre-F03 tests).
   */
  groundTruthSurface?: () => ProposalGroundTruthFace;
  /**
   * R6-B-F02: the provider-side fulfillment decision point (see
   * proposal/fulfillment-gate.ts). When enabled, an accept is GATED on a
   * deliverability check of the proposal's required capabilities against the
   * live capability surface: full coverage accepts as before; a gap either
   * rejects honestly or delegates hop-(n+1) to a discovered covering service
   * (bounded handshake wait; hop budget DEFAULT_MAX_HOP_DEPTH). Default OFF
   * — legacy accept-without-gate behavior stays byte-identical.
   */
  fulfillmentGate?: FulfillmentGateConfig;
}

/** One row of the responder's own service catalog (R42-A/F3 §7.1). */
export interface ProposalHandlerServiceFace {
  name: string;
  semanticType: string;
  visibility?: string;
  /**
   * P5: service origin (derived/published/flow/aggregate) when the seam
   * knows it — rides the handshake trajectory for the service-origin funnel.
   */
  origin?: string;
}

/**
 * Interface for the agent that the handler can call back to.
 * This avoids a direct dependency on CognitiveAgent, preventing circular imports.
 */
export interface ProposalHandlerAgent {
  joinCollaboration(
    collaborationId: string,
    options: {
      role: string;
      capabilities?: string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<{
    success: boolean;
    collaborationId: string;
    role: string;
    error?: string;
  }>;
  /**
   * R42-A/F3 (§7.1): the agent's own service catalog — derived + published
   * rows it exposes to others, read LIVE at evaluation time (services are
   * minted after construction). Optional: an agent (or test double) without
   * the seam simply renders "YOUR SERVICES: none" and keeps the legacy
   * behavior. Wired server-side from serviceStore.servicesOf(envId).
   */
  listMyServices?: () => Array<ProposalHandlerServiceFace>;
}

/**
 * Handles incoming collaboration proposals autonomously
 */
export class CollaborationProposalHandler {
  private llmClient: LLMClient;
  private environment: EnvironmentCenter;
  private agentId: string;
  private agentName: string;
  private agentCapabilities: string[];
  private config: ProposalHandlerConfig;
  private readonly llmTimeoutMs: number;
  /** T-202: lazy bound-device surface (see options.deviceSurface). */
  private readonly deviceSurface?: () => ProposalDeviceFace[];
  /** R6-C-F03: lazy ground-truth surface (see options.groundTruthSurface). */
  private readonly groundTruthSurface?: () => ProposalGroundTruthFace;
  /** R6-B-F02: fulfillment gate config (see options.fulfillmentGate). */
  private readonly fulfillmentGate?: FulfillmentGateConfig;

  /**
   * FEAT-10 (dorm-life D11): runtime-wired "did I already self-handle this
   * event" check (the EngineRuntime binds the owning agent's
   * DualTriggerACManager.hasSelfHandledEvent). Unwired seam → no check
   * (legacy behavior).
   */
  private selfHandledEventCheck?: (eventId: string) => boolean;

  /**
   * R44-extreme-F1: audit record of the LAST evaluation's prompt-budget
   * trim (undefined when the prompt fit the budget). Reset at the start of
   * every evaluateProposal; copied onto the ProposalEvaluation and into
   * responderContext so the trim is visible in the trajectory.
   */
  private lastPromptTrim?: ProposalPromptTrim;

  // Reference to the owning agent for joining collaborations
  private agent?: ProposalHandlerAgent;

  // Track collaboration history
  private collaborationHistory: Map<string, Date[]> = new Map();
  private activeCollaborations: Set<string> = new Set();

  // Event subscriptions (can subscribe to multiple event types)
  private subscriptionIds: string[] = [];

  // Wave-4a: pending defer re-evaluations (proposalId → timer) and the set of
  // proposals already deferred once — a second defer converts to a reject so
  // the handshake always converges.
  private deferTimers: Map<string, NodeJS.Timeout> = new Map();
  private deferredProposals: Set<string> = new Set();

  constructor(options: CollaborationProposalHandlerOptions) {
    this.llmClient = options.llmClient;
    this.environment = options.environment;
    this.agentId = options.agentId;
    this.agentName = options.agentName;
    this.agentCapabilities = options.agentCapabilities;
    this.config = options.config;
    this.deviceSurface = options.deviceSurface;
    this.groundTruthSurface = options.groundTruthSurface;
    this.fulfillmentGate = options.fulfillmentGate;
    this.llmTimeoutMs = options.config.llmTimeoutMs ?? DEFAULT_EVAL_LLM_TIMEOUT_MS;

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Initialized with config:`, {
      enabled: this.config.enabled,
      autoExecute: this.config.autoExecuteAccepted,
      maxConcurrent: this.config.maxConcurrentCollaborations,
    });
  }

  /**
   * Set the agent reference for joining collaborations.
   * Called after construction to avoid circular dependency issues.
   */
  setAgent(agent: ProposalHandlerAgent): void {
    this.agent = agent;
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Agent reference set`);
  }

  /**
   * FEAT-10 (dorm-life D11): wire the self-handling knowledge (the runtime
   * binds the owning agent's DualTriggerACManager.hasSelfHandledEvent —
   * post-construction, same assembly pattern as the manager's
   * setInitiatorCoordinator). When set, BOTH evaluation lanes reject a
   * proposal whose trigger event this agent already handled independently
   * — accepting would double-actuate the same devices.
   */
  setSelfHandledEventCheck(check: (eventId: string) => boolean): void {
    this.selfHandledEventCheck = check;
  }

  /**
   * FEAT-10 (dorm-life D11): the self-handling reject. When the proposal's
   * factual trigger event id (the initiator's L1 backfill, same extraction
   * as the ground-truth check) names an event THIS agent already handled
   * independently — real device commands dispatched, not a bare decision —
   * accepting would double-actuate the same devices (the duty officer's
   * spontaneous ventilation followed by an AC turn-on of the same fan).
   * Deterministic, consulted by BOTH lanes before any other judgment.
   * Unwired seam or no triggerEventId on the proposal → no check (legacy).
   */
  private selfHandlingRejection(proposal: CollaborationProposal): ProposalEvaluation | undefined {
    if (this.selfHandledEventCheck === undefined) return undefined;
    const triggerEventId = triggerRefOf(proposal).triggerEventId;
    if (triggerEventId === undefined || !this.selfHandledEventCheck(triggerEventId)) return undefined;
    return {
      proposal,
      decision: 'reject',
      confidence: 0.95,
      reasoning:
        `Self-handling rejection: I already handled trigger event '${triggerEventId}' ` +
        `independently (device commands dispatched) — accepting this collaboration ` +
        `would double-actuate the same devices`,
      benefits: [],
      costs: ['Duplicate handling of an event I already actuated on'],
      evaluatedAt: new Date(),
    };
  }

  /**
   * T-202: the agent's CURRENT bound devices (defensive read — provider
   * faults degrade to "no devices known", never throw).
   */
  private currentDevices(): ProposalDeviceFace[] {
    if (this.deviceSurface === undefined) return [];
    try {
      return this.deviceSurface() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * R44-extreme-F1 (plan-r81 D1): the evaluation prompt's TOTAL token
   * budget — config.promptBudgetTokens wins, then the
   * PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS env (sibling of
   * AC_PROPOSAL_EVAL_LLM_TIMEOUT_MS), then DEFAULT_PROMPT_BUDGET_TOKENS.
   * Resolved lazily so tests and live env changes take effect per call.
   */
  private promptBudgetTokens(): number {
    const configured = this.config.promptBudgetTokens;
    if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    const raw = process.env.PROPOSAL_REVIEW_PROMPT_BUDGET_TOKENS;
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_PROMPT_BUDGET_TOKENS;
  }

  /**
   * T-202: the real capability surface — declared capabilities UNION the
   * bound devices' capabilities, computed LIVE. The declared list alone
   * made participants reject proposals they could actually deliver (FF-F05:
   * "no cooling capability" from an agent whose HVAC device cools the zone).
   */
  private capabilitySurface(): string[] {
    return Array.from(new Set([
      ...this.agentCapabilities,
      ...this.currentDevices().flatMap(d => d.capabilities),
    ]));
  }

  /**
   * R42-A/F3 §7.1: the agent's CURRENT own service catalog (defensive read
   * through the agent seam — provider faults degrade to "no services known",
   * never throw). Unwired seam (no setAgent / no listMyServices) = empty.
   */
  private currentMyServices(): Array<ProposalHandlerServiceFace> {
    try {
      return this.agent?.listMyServices?.() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * R6-C-F03: the proposal's ground-truth check against THIS responder's own
   * observations (defensive read — provider faults degrade to "unverifiable",
   * never throw). Undefined when the seam is unwired (legacy behavior).
   * Shared by the LLM lane (prompt section + criterion 7) and the capability
   * fallback (contradiction gate) so both lanes judge the same evidence.
   */
  private groundTruthCheck(proposal: CollaborationProposal): ProposalGroundTruthCheck | undefined {
    if (this.groundTruthSurface === undefined) return undefined;
    let face: ProposalGroundTruthFace | undefined;
    try {
      face = this.groundTruthSurface() ?? undefined;
    } catch {
      face = undefined;
    }
    const text = `${proposal.goal ?? ''} ${proposal.task ?? ''} ${proposal.description ?? ''}`;
    return assessProposalGroundTruth(triggerRefOf(proposal), face, text);
  }

  /**
   * R42-A/F3 §7.2: render the proposal's requested services for the prompt.
   * Structured terms render `name[semanticType]` (+visibility when stated);
   * legacy plain strings render name-only (backward compatible).
   */
  private renderRequestedServices(proposal: CollaborationProposal): string {
    const services = proposal.services ?? [];
    if (services.length === 0) return 'none';
    return services
      .map(s => {
        if (typeof s === 'string') return s;
        if (s && typeof s === 'object' && typeof (s as ProposalServiceTerm).name === 'string') {
          const term = s as ProposalServiceTerm;
          const sem = typeof term.semanticType === 'string' && term.semanticType.length > 0
            ? `[${term.semanticType}]`
            : '';
          const vis = term.terms && typeof (term.terms as Record<string, unknown>).visibility === 'string'
            ? `{${String((term.terms as Record<string, unknown>).visibility)}}`
            : '';
          return `${term.name}${sem}${vis}`;
        }
        return String(s);
      })
      .join(', ');
  }

  /**
   * T-202: context attached to every handshake answer so the trajectory
   * record shows WHAT the responder could deliver when it answered (the
   * pre-fix records hard-coded capabilities: [] / partnerServices: []).
   * R42-A/F3: the service face rides along too — the trajectory shows the
   * catalog the responder saw when it answered.
   * P5 (R44-extreme-F3): `initiatorAgentId` carries the REAL initiator from
   * the proposal being answered — pre-fix the record only knew the
   * responder (agentId + providerAgentId both self), so undirected
   * collaboration edges deduped to zero.
   */
  private responderContext(proposal?: CollaborationProposal): Record<string, unknown> {
    return {
      providerAgentId: this.agentId,
      ...(proposal?.proposedBy !== undefined ? { initiatorAgentId: proposal.proposedBy } : {}),
      capabilities: this.capabilitySurface(),
      devices: this.currentDevices().map(d => ({
        id: d.id,
        name: d.name,
        capabilities: d.capabilities,
        ...(d.zoneId !== undefined ? { zoneId: d.zoneId } : {}),
      })),
      myServices: this.currentMyServices(),
      // R44-extreme-F1: when the last evaluation's prompt had to be trimmed
      // to fit the token budget, the trim record rides every handshake
      // answer (accept/reject/counter/defer) — degradation stays visible.
      ...(this.lastPromptTrim !== undefined ? { promptTrim: this.lastPromptTrim } : {}),
    };
  }

  /**
   * Start listening for collaboration proposals
   *
   * Subscribes to both COLLABORATION_PROPOSAL and COLLABORATION_MESSAGE events
   * because proposals may arrive through either channel:
   * - COLLABORATION_PROPOSAL: formal typed proposals with CollaborationProposal shape
   * - COLLABORATION_MESSAGE: informal proposals with payload.type 'ac-proposal' or 'proposal'
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Not enabled, not starting`);
      return;
    }

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Starting to listen for proposals`);

    const handler = this.handleCollaborationProposal.bind(this);

    // Subscribe to formal collaboration proposal events
    const proposalSubId = this.environment.eventManager.subscribe({
      subscriberId: `${this.agentId}-proposal`,
      eventType: EventType.COLLABORATION_PROPOSAL,
      handler,
      priority: EventPriority.NORMAL,
    });
    this.subscriptionIds.push(proposalSubId);

    // Also subscribe to collaboration message events (informal proposals)
    // Many agents send proposals as COLLABORATION_MESSAGE with payload.type 'ac-proposal' or 'proposal'
    const messageSubId = this.environment.eventManager.subscribe({
      subscriberId: `${this.agentId}-message`,
      eventType: EventType.COLLABORATION_MESSAGE,
      handler,
      priority: EventPriority.NORMAL,
    });
    this.subscriptionIds.push(messageSubId);

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Subscribed to COLLABORATION_PROPOSAL and COLLABORATION_MESSAGE events`);
  }

  /**
   * Stop listening for collaboration proposals
   */
  stop(): void {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Stopping`);

    for (const subId of this.subscriptionIds) {
      this.environment.eventManager.unsubscribe(subId);
    }
    this.subscriptionIds = [];

    // Wave-4a: cancel pending defer re-evaluations so no answer is published
    // after the handler is torn down.
    for (const timer of this.deferTimers.values()) {
      clearTimeout(timer);
    }
    this.deferTimers.clear();
    this.deferredProposals.clear();
  }

  /**
   * Handle incoming collaboration proposal event
   *
   * Handles proposals arriving through both COLLABORATION_PROPOSAL and
   * COLLABORATION_MESSAGE event types. Normalizes different payload formats
   * into a consistent CollaborationProposal object.
   */
  private async handleCollaborationProposal(event: SystemEvent): Promise<void> {
    // Wave-4a: the initiator's answer to OUR counter-proposal is not a fresh
    // proposal — handle it before normalization (which would drop it).
    const payloadRecord = event.payload as Record<string, unknown> | undefined;
    if (payloadRecord?.type === 'counter-response') {
      await this.handleCounterResponse(payloadRecord);
      return;
    }

    // Normalize the event payload into a CollaborationProposal
    const proposal = this.normalizeProposal(event);

    // Check if this proposal is for me
    if (!proposal || proposal.proposedTo !== this.agentId) {
      return;
    }

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Received proposal from ${proposal.proposedBy}`);

    try {
      // Evaluate the proposal
      const evaluation = await this.evaluateProposal(proposal);

      logger.info(`[CollaborationProposalHandler:${this.agentId}] Evaluation:`, {
        decision: evaluation.decision,
        confidence: evaluation.confidence.toFixed(2),
        reasoning: evaluation.reasoning,
      });

      // R45-P1: the R44-dense-F2 capability cross-check (rule override of LLM
      // reject/defer) is REMOVED. R45 measured the rule lane accepting
      // 158/158 — including overrides of legitimate LLM rejections for
      // workload ("Maximum concurrent collaborations…") and relevance, which
      // drove accept precision down to 46% (docs/devloop-r45-realistic-report.md
      // §2.2/F1). An explicit LLM judgment (reject/defer/counter) is now
      // RESPECTED: the deterministic capability rule only decides when the
      // LLM cannot — the 'fallback' path in the catch block below (LLM
      // error/timeout/unparseable output), labelled 'fallback'.

      // Act on the decision, passing event payload for additional context (e.g., collaborationId)
      await this.actOnProposal(evaluation, event.payload, 'llm');
    } catch (error) {
      // If LLM analysis fails (error, timeout, unparseable output), fall back
      // to capability-based evaluation. This is NOT a silent fallback -- we
      // log the full error, make an explicit TIGHTENED decision (Fix-12:
      // empty/under-matched requirements reject instead of rubber-stamping),
      // label the outcome 'fallback' so the trajectory shows the LLM did
      // not participate, and (R5-F10) carry the error itself on the answer
      // payload so the handshake record says WHY the LLM was unavailable.
      logger.error(`[CollaborationProposalHandler:${this.agentId}] Proposal evaluation failed, using capability-based fallback:`, error);

      const evaluation = this.evaluateByCapabilities(proposal);
      evaluation.evaluationError = error instanceof Error ? error.message : String(error);
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Capability-based evaluation:`, {
        decision: evaluation.decision,
        confidence: evaluation.confidence.toFixed(2),
        reasoning: evaluation.reasoning,
      });

      await this.actOnProposal(evaluation, event.payload, 'fallback');
    }
  }

  /**
   * Evaluate a proposal using only capability matching (no LLM)
   *
   * Used as a fallback when LLM analysis is unavailable. The agent still
   * makes an autonomous decision based on capability alignment.
   *
   * Fix-12 (R4 小周 F-15) tightened rules — the fallback may not rubber-stamp:
   * - EMPTY required capabilities → reject. "0/0 matched" used to accept at
   *   the 0.5 default, letting semantically absurd pairings through (an
   *   elderly-care agent accepting a grid load-shedding collaboration).
   * - match ratio < 0.5 → reject, with the match detail in the reasoning.
   */
  private evaluateByCapabilities(proposal: CollaborationProposal): ProposalEvaluation {
    // FEAT-10: the self-handling reject gates the fallback lane too — same
    // verdict as the LLM lane (one trigger event, one handler).
    const selfHandled = this.selfHandlingRejection(proposal);
    if (selfHandled !== undefined) return selfHandled;

    // R6-C-F03: ground-truth gate — before ANY capability rubber-stamping.
    // When the responder's own observations contradict the proposal's claimed
    // emergency (the F03 hallucination signature: occupancy event narrated as
    // "CO2 breach" while every observed reading is in range), the fallback may
    // NOT auto-accept — it rejects and names the contradiction. Unverifiable /
    // missing-reading cases pass through untouched (observing nothing is not
    // grounds for rejection). Unwired seam → no check at all (legacy).
    const groundTruth = this.groundTruthCheck(proposal);
    if (groundTruth?.status === 'contradiction') {
      return {
        proposal,
        decision: 'reject',
        confidence: 0.9,
        reasoning:
          `Ground-truth rejection: the proposal claims an emergency ` +
          `(trigger ${groundTruth.ref.triggerEventType ?? 'unknown'} in zone ` +
          `${groundTruth.ref.triggerZoneId ?? 'unknown'}), but my own observations show every ` +
          `readable parameter there within its expected range — the claimed situation ` +
          `contradicts the physical world I can see`,
        benefits: [],
        costs: ['Claimed emergency contradicts my own sensor observations of the trigger zone'],
        evaluatedAt: new Date(),
      };
    }

    // Check capability alignment using the shared semantic matcher (same
    // one PartnerSelectionNegotiator uses — bidirectional substring +
    // CAPABILITY_SYNONYMS equivalence groups, Wave 1 A2). T-202: matched
    // against the ENRICHED surface (declared ∪ device-derived), so the
    // fallback agrees with what the agent's devices actually deliver.
    const surface = this.capabilitySurface();
    const requiredCaps = proposal.capabilities || [];
    const matchedCaps = requiredCaps.filter(cap =>
      surface.some(agentCap => capabilityMatches(agentCap, cap))
    );

    // No stated requirements: without the LLM there is no semantic judgment.
    // Defer (not reject) so the initiator has time to re-negotiate or find
    // other partners — a hard reject here was the top source of spurious
    // "collaboration failed" entries in the demo (Wave 6 F5 fix).
    if (requiredCaps.length === 0) {
      return {
        proposal,
        decision: 'defer',
        confidence: 0.3,
        reasoning:
          'Capability-based defer: proposal states no required capabilities ' +
          'and LLM evaluation is unavailable — deferring to give the initiator ' +
          'time to clarify or find other partners',
        benefits: [],
        costs: ['Unverifiable proposal: no required capabilities stated'],
        evaluatedAt: new Date(),
      };
    }

    const capabilityMatch = matchedCaps.length / requiredCaps.length;

    // Phase 3 + 5: Adjust accept threshold based on proposalType.
    // - service-invocation: initiator found published service → 0.3 (pre-confirmed)
    // - service-adaptation: no service published but responder may improvise → 0.3
    //   (the responder's device resources may be able to handle the request even
    //   without a formal service publication; the ACExecutor routes execution
    //   through the agent's ResourceManager directly)
    // - capability-broadcast (default): standard 0.5 threshold
    const proposalType = (proposal as unknown as Record<string, unknown>).proposalType as string | undefined;
    const acceptThreshold = (proposalType === 'service-invocation' || proposalType === 'service-adaptation') ? 0.3 : 0.5;

    const decision: ProposalDecision = capabilityMatch >= acceptThreshold ? 'accept' : 'reject';
    const reasoning = capabilityMatch >= acceptThreshold
      ? `Capability-based acceptance (${proposalType ?? 'broadcast'}): ${matchedCaps.length}/${requiredCaps.length} matched (threshold ${acceptThreshold})`
      : `Capability-based rejection (${proposalType ?? 'broadcast'}): only ${matchedCaps.length}/${requiredCaps.length} matched (threshold ${acceptThreshold})` +
        (matchedCaps.length > 0 ? ` (${matchedCaps.join(', ')})` : '') +
        `; missing: ${requiredCaps.filter(c => !matchedCaps.includes(c)).join(', ')}`;

    return {
      proposal,
      decision,
      confidence: capabilityMatch,
      reasoning,
      benefits: capabilityMatch >= 0.5
        ? [`Capability match: ${matchedCaps.join(', ')}`]
        : [],
      costs: capabilityMatch < 0.5
        ? [`Missing capabilities: ${requiredCaps.filter(c => !matchedCaps.includes(c)).join(', ')}`]
        : [],
      evaluatedAt: new Date(),
    };
  }

  /**
   * Normalize event payload into a CollaborationProposal
   *
   * Handles two formats:
   * 1. Formal: event.payload.proposal is a CollaborationProposal (COLLABORATION_PROPOSAL events)
   * 2. Informal: event.payload itself contains proposal fields (COLLABORATION_MESSAGE events)
   */
  private normalizeProposal(event: SystemEvent): CollaborationProposal | null {
    const payload = event.payload;

    if (!payload) {
      return null;
    }

    // Check if this is an informal proposal via COLLABORATION_MESSAGE
    const payloadRecord = payload as Record<string, unknown>;
    const payloadType = payloadRecord.type as string;
    if (payloadType === 'ac-proposal' || payloadType === 'proposal') {
      const p = payloadRecord;
      return {
        id: (p.collaborationId || p.id || `informal-${Date.now()}`) as string,
        proposedBy: (p.initiatorId || p.proposedBy || event.source) as string,
        proposedTo: (p.targetAgentId || p.proposedTo || this.agentId) as string,
        type: (p.type || 'collaboration-invitation') as string,
        goal: (p.collaborationName || p.description || p.goal || 'Active Collaboration') as string,
        task: (p.task as Record<string, unknown>)?.description as string || p.task as string,
        description: p.description as string,
        capabilities: (p.requiredCapabilities || p.capabilities || []) as string[],
        // R6-E-F07: locked service-invocation typing rides the informal lane too.
        proposalType: p.proposalType as CollaborationProposal['proposalType'],
        // R42-A/F3 §7.2: structured terms ride through; legacy strings stay.
        services: p.services as Array<ProposalServiceTerm | string> | undefined,
        resources: p.resources as string[] | undefined,
        priority: p.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
        validUntil: p.validUntil as Date | undefined,
        metadata: {
          ...((p.metadata || {}) as Record<string, unknown>),
          collaborationId: p.collaborationId as string,
          // R6-B-F02: multi-hop fulfillment chain metadata (hop depth, parent
          // and root collaboration ids) — the fulfillment gate reads these to
          // bound delegation depth; the trajectory distinguishes hop-1/hop-2.
          ...(typeof p.hop === 'number' && Number.isFinite(p.hop) ? { hop: p.hop } : {}),
          ...(typeof p.parentCollaborationId === 'string' && p.parentCollaborationId.length > 0
            ? { parentCollaborationId: p.parentCollaborationId }
            : {}),
          ...(typeof p.rootCollaborationId === 'string' && p.rootCollaborationId.length > 0
            ? { rootCollaborationId: p.rootCollaborationId }
            : {}),
          // R6-C-F03: the initiator's factual trigger-event backfill (R81-D2)
          // rides into the evaluation — the responder's ground-truth check
          // locates the claimed situation by zone/type, not by trusting the
          // free-text description.
          ...(typeof p.triggerEventType === 'string' && p.triggerEventType.length > 0
            ? { triggerEventType: p.triggerEventType }
            : {}),
          ...(typeof p.triggerEventId === 'string' && p.triggerEventId.length > 0
            ? { triggerEventId: p.triggerEventId }
            : {}),
          ...(typeof p.triggerZoneId === 'string' && p.triggerZoneId.length > 0
            ? { triggerZoneId: p.triggerZoneId }
            : {}),
        },
      };
    }

    // Formal proposal: event.payload.proposal is a CollaborationProposal.
    // Restricted to COLLABORATION_PROPOSAL events (Fix-8): COLLABORATION_MESSAGE
    // responses (join-response / reject / defer) ALSO carry a `proposal`
    // field — treating those as fresh proposals makes the handler evaluate
    // its own responses and publish accept/reject in an infinite loop.
    if (event.type !== EventType.COLLABORATION_PROPOSAL) {
      return null;
    }
    const proposal = (payloadRecord.proposal as CollaborationProposal | undefined);
    if (proposal && proposal.proposedTo) {
      return proposal;
    }

    return null;
  }

  /**
   * Evaluate a collaboration proposal
   */
  async evaluateProposal(proposal: CollaborationProposal): Promise<ProposalEvaluation> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Evaluating proposal from ${proposal.proposedBy}`);

    // R44-extreme-F1: a fresh evaluation starts with no trim record — a
    // stale one from a previous proposal must never leak into this answer.
    this.lastPromptTrim = undefined;

    // FEAT-10: self-handling reject BEFORE the LLM lane — no evaluation
    // call is spent on an event this agent already actuated on.
    const selfHandled = this.selfHandlingRejection(proposal);
    if (selfHandled !== undefined) return selfHandled;

    // Check if we can accept more collaborations
    if (this.activeCollaborations.size >= this.config.maxConcurrentCollaborations) {
      return {
        proposal,
        decision: 'reject',
        confidence: 1.0,
        reasoning: 'Maximum concurrent collaborations reached',
        benefits: [],
        costs: ['Resource limit exceeded'],
        evaluatedAt: new Date(),
      };
    }

    // Use LLM to analyze the proposal
    const analysis = await this.analyzeWithLLM(proposal);

    // Apply decision criteria
    const decision = this.makeDecision(analysis, proposal);

    const evaluation: ProposalEvaluation = {
      proposal,
      decision: decision.decision,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      benefits: analysis.benefits,
      costs: analysis.costs,
      counterProposal: decision.counterProposal as { modifications: string[]; reasoning: string } | undefined,
      resourceRequirements: this.estimateResourceRequirements(analysis),
      evaluatedAt: new Date(),
      // R44-extreme-F1: the prompt-budget trim record (undefined when the
      // prompt fit) — visible evaluation metadata, not a silent degradation.
      ...(this.lastPromptTrim !== undefined ? { promptTrim: this.lastPromptTrim } : {}),
    };

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Evaluation complete:`, {
      decision: evaluation.decision,
      benefits: evaluation.benefits.length,
      costs: evaluation.costs.length,
      confidence: evaluation.confidence.toFixed(2),
    });

    return evaluation;
  }

  /**
   * R44-insane: render the YOUR DEVICES prompt section. ≤30 bound devices:
   * the exhaustive list. Above: relevance-filtered — devices whose
   * capabilities match the proposal's requiredCapabilities (`capabilityMatches`,
   * the same semantic matcher the capability fallback uses) rank first, the
   * top 20 are listed, and the remainder collapses to one summary line
   * carrying the hidden devices' capability union, so the agent still sees
   * WHAT it can do even when the per-device list is filtered. This is
   * relevance selection, not lossy truncation: the complete surface stays in
   * the YOUR PROFILE line above the section.
   */
  private renderDeviceSection(proposal: CollaborationProposal): string {
    const devices = this.currentDevices();
    if (devices.length === 0) return 'YOUR DEVICES: none bound';
    if (devices.length <= DEVICE_LIST_FILTER_THRESHOLD) {
      return 'YOUR DEVICES:\n' + devices.map(d => this.renderDeviceLine(d)).join('\n');
    }

    const required = proposal.capabilities ?? [];
    // R44-extreme-F1: footprint-aware ranking — devices the proposal names
    // (zone/id/name in the text) rank ahead of pure inventory noise, so the
    // top-N cut keeps what THIS proposal touches even when the budget mode
    // is not engaged. (Capability matches are footprint members too; the
    // boost only reorders, it never excludes.)
    const inFootprint = this.deviceFootprint(proposal);
    const ranked = devices
      .map((device, index) => ({
        device,
        index,
        relevance: (inFootprint(device) ? 1_000 : 0) + required.filter(req =>
          device.capabilities.some(cap => capabilityMatches(cap, req)),
        ).length,
      }))
      // Most relevant first; original order breaks ties (deterministic).
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index);

    const lines = ranked.slice(0, DEVICE_LIST_MAX_SHOWN).map(({ device }) => this.renderDeviceLine(device));
    const hidden = ranked.slice(DEVICE_LIST_MAX_SHOWN);
    if (hidden.length > 0) {
      const hiddenCapabilities = new Set<string>();
      for (const { device } of hidden) {
        for (const cap of device.capabilities) hiddenCapabilities.add(cap);
      }
      lines.push(
        `- …and ${hidden.length} more (filter by capability; their capabilities: ` +
          `${[...hiddenCapabilities].join(', ') || 'none'} — full surface in YOUR PROFILE)`,
      );
    }
    return 'YOUR DEVICES:\n' + lines.join('\n');
  }

  /**
   * R44-colossal: render the YOUR SERVICES prompt section. ≤30 own services:
   * the exhaustive catalog. Above: relevance-filtered — services whose
   * semanticType matches the proposal's requiredCapabilities or requested
   * service terms (`capabilityMatches`, the same word-root/synonym matcher
   * used elsewhere in this handler) rank first, the top 20 are listed, and
   * the remainder collapses to one summary line carrying the hidden
   * services' semanticType union. Structural twin of renderDeviceSection
   * (R44-insane): the titanic tier showed the service catalog is the second
   * linear-in-facilities prompt carrier after the device list.
   */
  private renderServiceSection(proposal: CollaborationProposal): string {
    const services = this.currentMyServices();
    if (services.length === 0) return 'YOUR SERVICES: none';
    const renderLine = (s: ProposalHandlerServiceFace): string =>
      `- ${s.name}[${s.semanticType}]${s.visibility !== undefined ? ` (${s.visibility})` : ''}`;
    if (services.length <= SERVICE_LIST_FILTER_THRESHOLD) {
      return 'YOUR SERVICES (what you expose to others):\n' + services.map(renderLine).join('\n');
    }

    // Relevance queries: the proposal's required capabilities plus its
    // requested service terms (structured semanticType, falling back to the
    // name for legacy strings).
    const requested = (proposal.services ?? [])
      .map(s => typeof s === 'string'
        ? s
        : ((s as ProposalServiceTerm).semanticType || (s as ProposalServiceTerm).name))
      .filter((q): q is string => typeof q === 'string' && q.length > 0);
    const queries = [...(proposal.capabilities ?? []), ...requested];

    // R44-extreme-F1: footprint-aware ranking — services the proposal text
    // names rank ahead of catalog noise (structural twin of the device
    // section; the boost reorders, never excludes).
    const proposalText = `${proposal.goal ?? ''} ${proposal.task ?? ''} ${proposal.description ?? ''}`.toLowerCase();
    const ranked = services
      .map((service, index) => ({
        service,
        index,
        relevance:
          (service.name.length > 0 && proposalText.includes(service.name.toLowerCase()) ? 1_000 : 0) +
          queries.filter(q =>
            capabilityMatches(service.semanticType, q) || capabilityMatches(service.name, q),
          ).length,
      }))
      // Most relevant first; original order breaks ties (deterministic).
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index);

    const lines = ranked.slice(0, SERVICE_LIST_MAX_SHOWN).map(({ service }) => renderLine(service));
    const hidden = ranked.slice(SERVICE_LIST_MAX_SHOWN);
    if (hidden.length > 0) {
      const hiddenTypes = new Set<string>();
      for (const { service } of hidden) hiddenTypes.add(service.semanticType);
      lines.push(
        `- …and ${hidden.length} more (filter by semanticType; their types: ` +
          `${[...hiddenTypes].join(', ') || 'none'})`,
      );
    }
    return 'YOUR SERVICES (what you expose to others):\n' + lines.join('\n');
  }

  /** One YOUR DEVICES line (shared by the normal and budget renderers). */
  private renderDeviceLine(d: ProposalDeviceFace): string {
    return `- ${d.name} (${d.id})${d.zoneId !== undefined ? ` in zone ${d.zoneId}` : ''}: ${d.capabilities.join(', ') || 'no capabilities'}`;
  }

  /**
   * R44-extreme-F1: the proposal FOOTPRINT on the device surface — devices
   * this proposal actually touches. A device is in the footprint when its
   * capabilities match a required capability (the same semantic matcher the
   * capability fallback uses), or its zone / id / name is mentioned in the
   * proposal text. Footprint devices are NEVER trimmed by the prompt budget.
   */
  private deviceFootprint(proposal: CollaborationProposal): (d: ProposalDeviceFace) => boolean {
    const required = proposal.capabilities ?? [];
    const text = `${proposal.goal ?? ''} ${proposal.task ?? ''} ${proposal.description ?? ''}`.toLowerCase();
    return (d: ProposalDeviceFace): boolean =>
      required.some(req => d.capabilities.some(cap => capabilityMatches(cap, req))) ||
      (d.zoneId !== undefined && d.zoneId.length > 0 && text.includes(d.zoneId.toLowerCase())) ||
      (d.id.length > 0 && text.includes(d.id.toLowerCase())) ||
      (d.name.length > 0 && text.includes(d.name.toLowerCase()));
  }

  /**
   * R44-extreme-F1 (plan-r81 D1): BUDGET-MODE YOUR DEVICES section, used
   * only when the assembled prompt exceeds promptBudgetTokens. Every
   * footprint device is listed in full (never trimmed); everything else
   * collapses into ONE aggregate line carrying the type mix and the hidden
   * capability union — the agent keeps WHAT it can do, the per-device
   * inventory of the irrelevant tail is what gets summarized.
   */
  private renderDeviceSectionBudget(proposal: CollaborationProposal): {
    section: string; listed: number; aggregated: number;
  } {
    const devices = this.currentDevices();
    if (devices.length === 0) return { section: 'YOUR DEVICES: none bound', listed: 0, aggregated: 0 };
    const inFootprint = this.deviceFootprint(proposal);
    const footprint = devices.filter(inFootprint);
    const rest = devices.filter(d => !inFootprint(d));

    const lines = footprint.map(d => this.renderDeviceLine(d));
    if (rest.length > 0) {
      // Type mix of the aggregated tail (only when the surface carries
      // types — unwired providers fall back to the capability union alone).
      const typeCounts = new Map<string, number>();
      const hiddenCapabilities = new Set<string>();
      for (const d of rest) {
        if (d.type !== undefined && d.type.length > 0) {
          typeCounts.set(d.type, (typeCounts.get(d.type) ?? 0) + 1);
        }
        for (const cap of d.capabilities) hiddenCapabilities.add(cap);
      }
      const typeMix = typeCounts.size > 0
        ? `type mix: ${[...typeCounts.entries()].map(([type, count]) => `${type}×${count}`).join(', ')}; `
        : '';
      lines.push(
        `- …and ${rest.length} more devices (${typeMix}their capabilities: ` +
          `${[...hiddenCapabilities].join(', ') || 'none'} — full surface in YOUR PROFILE)`,
      );
    }
    return {
      section: 'YOUR DEVICES (proposal-relevant shown in full; rest aggregated):\n' + lines.join('\n'),
      listed: footprint.length,
      aggregated: rest.length,
    };
  }

  /**
   * R44-extreme-F1 (plan-r81 D1): BUDGET-MODE YOUR SERVICES section —
   * structural twin of renderDeviceSectionBudget. Services matching the
   * proposal's required capabilities / requested terms / text are listed in
   * full; the rest collapses into one aggregate line with the semanticType
   * union.
   */
  private renderServiceSectionBudget(proposal: CollaborationProposal): {
    section: string; listed: number; aggregated: number;
  } {
    const services = this.currentMyServices();
    if (services.length === 0) return { section: 'YOUR SERVICES: none', listed: 0, aggregated: 0 };
    const renderLine = (s: ProposalHandlerServiceFace): string =>
      `- ${s.name}[${s.semanticType}]${s.visibility !== undefined ? ` (${s.visibility})` : ''}`;

    const requested = (proposal.services ?? [])
      .map(s => typeof s === 'string'
        ? s
        : ((s as ProposalServiceTerm).semanticType || (s as ProposalServiceTerm).name))
      .filter((q): q is string => typeof q === 'string' && q.length > 0);
    const queries = [...(proposal.capabilities ?? []), ...requested];
    const text = `${proposal.goal ?? ''} ${proposal.task ?? ''} ${proposal.description ?? ''}`.toLowerCase();
    const inFootprint = (s: ProposalHandlerServiceFace): boolean =>
      queries.some(q => capabilityMatches(s.semanticType, q) || capabilityMatches(s.name, q)) ||
      (s.name.length > 0 && text.includes(s.name.toLowerCase()));

    const footprint = services.filter(inFootprint);
    const rest = services.filter(s => !inFootprint(s));
    const lines = footprint.map(renderLine);
    if (rest.length > 0) {
      const hiddenTypes = new Set<string>();
      for (const s of rest) hiddenTypes.add(s.semanticType);
      lines.push(
        `- …and ${rest.length} more services (their types: ${[...hiddenTypes].join(', ') || 'none'})`,
      );
    }
    return {
      section: 'YOUR SERVICES (what you expose to others; proposal-relevant shown in full, rest aggregated):\n' + lines.join('\n'),
      listed: footprint.length,
      aggregated: rest.length,
    };
  }

  /**
   * Use LLM to analyze a proposal
   */
  private async analyzeWithLLM(proposal: CollaborationProposal): Promise<LLMProposalAnalysis> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Using LLM to analyze proposal...`);

    try {
      const previousCollabs = this.collaborationHistory.get(proposal.proposedBy)?.length || 0;

      // Natural language prompt format instead of pipe-separated format.
      // T-202: the profile shows the REAL capability surface (declared ∪
      // bound devices, live) plus a YOUR DEVICES section — the participant
      // can verify it can actually deliver the requested service before
      // answering (creation-time declared lists made participants reject
      // proposals their own devices could deliver).
      // R42-A/F3 §7.1: a YOUR SERVICES section shows the agent's own
      // derived/published catalog — without it the 631-service grid never
      // enters the accept/reject decision path (A1: 18 rejects : 3 accepts).
      const surface = this.capabilitySurface();
      // R44-insane: relevance-filtered above DEVICE_LIST_FILTER_THRESHOLD —
      // the district-manager 150-device inventory is why the evaluation
      // prompt topped 16K tokens; the agent only needs the devices that can
      // do THIS proposal's work (plus the capability summary of the rest).
      let deviceSection = this.renderDeviceSection(proposal);
      // R44-colossal: relevance-filtered above SERVICE_LIST_FILTER_THRESHOLD —
      // the titanic tier's 6/6 district-manager 400s were the FULL 859-service
      // catalog (~10K tok) rendered here; the responder only needs the services
      // matching THIS proposal (plus the semanticType union of the rest).
      let servicesSection = this.renderServiceSection(proposal);

      // R6-C-F03: EVENT GROUND TRUTH — the trigger event's real state in the
      // RESPONDER's own observation range (zone readings vs expected ranges),
      // so a hallucinated emergency ("CO2 breach" over a lunch-rush occupancy
      // event) meets contradictory evidence at evaluation time instead of
      // being taken on the initiator's word. Undefined when the seam is
      // unwired → the prompt stays byte-identical to the pre-F03 shape.
      const groundTruth = this.groundTruthCheck(proposal);
      const groundTruthSection = groundTruth !== undefined
        ? renderGroundTruthSection(groundTruth)
        : undefined;

      const assemblePrompt = (devices: string, services: string): string => `COLLABORATION PROPOSAL EVALUATION

YOUR PROFILE:
- Agent: ${this.agentName}
- Capabilities (declared + device-derived): ${surface.join(', ') || 'none'}
${devices}
${services}
- Current Workload: ${this.activeCollaborations.size}/${this.config.maxConcurrentCollaborations} collaborations
- Active Collaborations: ${Array.from(this.activeCollaborations).join(', ')}

PROPOSAL DETAILS:
- From: ${untrustedBlock('proposal-from', proposal.proposedBy)}
- Trust Level: ${previousCollabs > 0 ? `High (${previousCollabs} previous collaborations)` : 'Unknown (first collaboration)'}
- Task: ${untrustedBlock('proposal-task', proposal.task)}
- Requested Capabilities: ${untrustedBlock('proposal-capabilities', proposal.capabilities?.join(', ') || 'none stated')}
- Services Requested: ${untrustedBlock('proposal-services', this.renderRequestedServices(proposal))}
- Description: ${untrustedBlock('proposal-description', proposal.description || 'No description')}
${groundTruthSection !== undefined ? `\n${groundTruthSection}\n` : ''}
EVALUATION CRITERIA:
1. CAPABILITY ALIGNMENT: Can YOUR DEVICES above deliver the requested capabilities?
2. BENEFIT ANALYSIS: Value gained from this collaboration
3. COST ANALYSIS: Resource consumption, time commitment, risks
4. WORKLOAD IMPACT: Effect on existing commitments
5. TRUST FACTOR: Partner's reliability and past performance
6. SERVICE MATCH: if the requested services match YOUR SERVICES above (semanticType), that is strong evidence for ACCEPT — you have productized exactly this.
${groundTruthSection !== undefined ? `7. GROUND-TRUTH CHECK: the EVENT GROUND TRUTH section above is what YOUR OWN sensors show. If the proposal claims an emergency or anomaly that contradicts those observations (e.g. it claims a CO2 breach while your CO2 reading for that zone is within the normal range), REJECT and name the contradiction in "reasoning". If the section says the event is outside your observation range or readings are missing, you CANNOT verify the claim — do NOT reject for that reason alone; weigh the other criteria normally.\n` : ''}
DECISION OPTIONS:
- ACCEPT: Benefits clearly outweigh costs
- REJECT: Costs too high or misaligned
- COUNTER: Acceptable with modifications
- DEFER: Need more information

Respond in JSON:
{
  "benefitScore": 0.0-1.0,
  "costScore": 0.0-1.0,
  "benefits": ["specific benefit 1", "specific benefit 2"],
  "costs": ["specific cost 1", "specific cost 2"],
  "recommendedDecision": "accept|reject|counter|defer",
  "reasoning": "detailed explanation",
  "counterModifications": ["modification 1", "modification 2"]
}`;

      let prompt = assemblePrompt(deviceSection, servicesSection);

      // R44-extreme-F1 (plan-r81 D1): TOTAL prompt budget. The section-level
      // count filters above are heuristics — they do not know the context
      // ceiling (extreme tier: vLLM max_model_len 8,192; the 75-device
      // district steward's prompt hit ≥7,693 input tok and 400'd with the
      // 500-token output reservation). When the assembled prompt exceeds the
      // budget, rebuild the device/service sections in budget mode: the
      // proposal FOOTPRINT (devices/services this proposal touches) is
      // listed in full and NEVER trimmed, the rest collapses into aggregate
      // lines. The trim is logged and recorded — never silent.
      const budgetTokens = this.promptBudgetTokens();
      const estimatedBefore = estimatePromptTokens(prompt);
      if (estimatedBefore > budgetTokens) {
        const budgetDevices = this.renderDeviceSectionBudget(proposal);
        const budgetServices = this.renderServiceSectionBudget(proposal);
        const budgetPrompt = assemblePrompt(budgetDevices.section, budgetServices.section);
        const estimatedBudget = estimatePromptTokens(budgetPrompt);
        if (estimatedBudget < estimatedBefore) {
          deviceSection = budgetDevices.section;
          servicesSection = budgetServices.section;
          prompt = budgetPrompt;
        }
        // Else: the footprint alone is LARGER than the count-filtered
        // sections (e.g. the proposal names a zone containing the whole
        // inventory — mega-shelter-open). The footprint may not be trimmed,
        // so the smaller count-filtered prompt is the better send.
        const estimatedAfter = estimatePromptTokens(prompt);
        this.lastPromptTrim = {
          budgetTokens,
          estimatedTokensBefore: estimatedBefore,
          estimatedTokensAfter: estimatedAfter,
          devicesListed: budgetDevices.listed,
          devicesAggregated: budgetDevices.aggregated,
          servicesListed: budgetServices.listed,
          servicesAggregated: budgetServices.aggregated,
        };
        logger.warn(
          `[CollaborationProposalHandler:${this.agentId}] evaluation prompt over budget ` +
          `(~${estimatedBefore} > ${budgetTokens} tok) — footprint-preserving trim: ` +
          `${budgetDevices.listed} devices listed / ${budgetDevices.aggregated} aggregated, ` +
          `${budgetServices.listed} services listed / ${budgetServices.aggregated} aggregated ` +
          `(now ~${estimatedAfter} tok${prompt === budgetPrompt ? '' : ', kept count-filtered sections: footprint larger than the filter'})`,
        );
        if (estimatedAfter > budgetTokens) {
          // The footprint alone overflows the budget — it must stay whole
          // (trimming it would blind the evaluation to the proposal's own
          // targets), so this is logged loud and sent as-is.
          logger.warn(
            `[CollaborationProposalHandler:${this.agentId}] evaluation prompt STILL over budget ` +
            `after trim (~${estimatedAfter} > ${budgetTokens} tok): the proposal footprint alone ` +
            `exceeds the budget — sending the smallest prompt with the footprint ranked first ` +
            `rather than dropping relevant devices`,
          );
        }
      }

      // R5-F10: guided JSON + temperature 0 (decision-lane conventions —
      // free-form output from a large/thinking model was unparseable and
      // silently degraded every evaluation to the capability fallback) and
      // a caller-owned AbortSignal so an over-budget call is CANCELLED, not
      // orphaned (T-023 pattern, same as the server's LLMReviewer).
      // Per-agent marker for LLM-call logging: this evaluation runs on the
      // responder lane's ASYNC path, which carries no agent context — wrap
      // the call so a timeout/failure is attributed to THIS responder
      // instead of landing as llm-failure agentId 'unknown'.
      const response = await runWithLLMAgentContext(
        { agentId: this.agentId, agentName: this.agentName },
        () => this.withTimeout(signal => this.llmClient.chat({
          messages: [{ role: 'user', content: prompt }],
          // 500 → 768: non-thinking models put their reasoning into the
          // guided-JSON reasoning fields; the observed truncation point
          // (~570 tokens) clipped valid evaluations mid-string (same
          // failure family as R5-F13 on the decision lane).
          maxTokens: 768,
          temperature: 0,
          format: PROPOSAL_EVAL_SCHEMA,
          // Qwen3 thinking suppression: the output is guided JSON — the
          // think draft is pure latency (LLM_DISABLE_THINKING=0 opts out).
          chatTemplateKwargs: noThinkingTemplateKwargs(),
          signal,
        })),
      );

      // Extract JSON from response (handle markdown code blocks)
      const cleanedContent = this.extractJSON(response.content);
      const analysis = JSON.parse(cleanedContent);

      return {
        benefitScore: analysis.benefitScore || 0.5,
        costScore: analysis.costScore || 0.5,
        benefits: analysis.benefits || [],
        costs: analysis.costs || [],
        recommendedDecision: analysis.recommendedDecision || 'defer',
        reasoning: analysis.reasoning || 'Analysis failed',
        counterModifications: analysis.counterModifications,
      };
    } catch (error: unknown) {
      // Fail Early: Log with full context and throw error instead of returning default value
      logger.error(`[CollaborationProposalHandler:${this.agentId}] LLM analysis failed for proposal ${proposal.id} from ${proposal.proposedBy}:`, error);
      throw new Error(`[${this.agentName}] analyzeWithLLM failed for proposal ${proposal.id} from ${proposal.proposedBy}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Race the evaluation LLM call against its own wall-clock budget (Fix-12).
   * The call path is already event-driven; this budget is what makes the
   * handshake RESPONSE event-driven in practice — a hung/cold model can no
   * longer hold the answer until the provider-level timeout (~120s class)
   * fires. The timer never leaks, and expiry throws so the caller
   * degrades to the capability fallback.
   *
   * R5-F10: the budget is an AbortSignal TOO (T-023 pattern, mirroring the
   * server's LLMReviewer.withTimeout). Pre-fix the race ORPHANED the
   * underlying request: it kept burning a queue slot until the provider
   * timeout, and — worse — when it eventually completed the client's
   * logging callback recorded a SUCCESS, so a 100%-timeout lane produced
   * zero llm-failure trajectory records and zero eval-report llmFailures
   * (the silent-degradation half of R5-F10). With the abort, the timed-out
   * call fails at the client, which logs success:false — the
   * TrajectoryRecorder writes its usual 'llm-failure' record (T-022 honest
   * degradation) and the queue slot frees immediately. The race stays as
   * the outer bound for clients that ignore the signal.
   */
  private async withTimeout<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        start(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`proposal evaluation LLM timed out after ${this.llmTimeoutMs}ms`));
          }, this.llmTimeoutMs);
          // Do not keep the process alive solely for an evaluation budget.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Make final decision based on analysis and criteria
   */
  private makeDecision(
    analysis: LLMProposalAnalysis,
    proposal: CollaborationProposal
  ): { decision: ProposalDecision; confidence: number; reasoning: string; counterProposal?: Record<string, unknown> } {
    const criteria = this.config.criteria;

    // Calculate confidence based on benefit/cost ratio
    const ratio = analysis.benefitScore / (analysis.costScore + 0.01);
    const confidence = Math.min(1.0, ratio);

    // Check if proposal meets minimum criteria
    const meetsBenefitThreshold = analysis.benefitScore >= criteria.minBenefitThreshold;
    const withinCostLimit = analysis.costScore <= criteria.maxCostThreshold;

    // Check if we've collaborated with this partner before
    const previousCollabs = this.collaborationHistory.get(proposal.proposedBy)?.length || 0;
    const trustedPartner = previousCollabs > 0;

    let decision: ProposalDecision;
    let reasoning = analysis.reasoning;

    // Decision logic
    if (meetsBenefitThreshold && withinCostLimit) {
      decision = 'accept';
      reasoning += analysis.benefits.length > 0 ? `. Benefits: ${analysis.benefits.join(', ')}` : '';
    } else if (analysis.benefitScore > criteria.minBenefitThreshold * 0.8) {
      // Close to threshold, consider counter-proposal
      decision = analysis.recommendedDecision === 'counter' ? 'counter' : 'defer';
      reasoning += '. Needs negotiation.';
    } else {
      decision = 'reject';
      reasoning += `. Costs: ${analysis.costs.join(', ')}`;
    }

    return {
      decision,
      confidence,
      reasoning: reasoning || 'No reasoning provided',
      counterProposal: decision === 'counter'
        ? {
            modifications: analysis.counterModifications || [],
            reasoning: 'Counter-proposal based on analysis',
          }
        : undefined,
    };
  }

  /**
   * Estimate resource requirements for a collaboration
   */
  private estimateResourceRequirements(analysis: LLMProposalAnalysis) {
    return {
      computation: analysis.costScore * 0.5, // Estimate
      memory: analysis.costScore * 0.3, // Estimate
      time: analysis.costScore * 10000, // Estimate in ms
    };
  }

  /**
   * Act on a proposal decision
   *
   * @param evaluation - The evaluation result
   * @param eventPayload - The original event payload (for additional context like collaborationId)
   */
  private async actOnProposal(
    evaluation: ProposalEvaluation,
    eventPayload?: Record<string, unknown>,
    evaluationSource: ProposalEvaluationSource = 'llm',
  ): Promise<void> {
    const { proposal, decision } = evaluation;

    switch (decision) {
      case 'accept':
        await this.acceptWithFulfillmentGate(proposal, evaluation, eventPayload, evaluationSource);
        break;

      case 'reject':
        await this.rejectProposal(proposal, evaluation, evaluationSource);
        break;

      case 'counter':
        await this.counterProposal(proposal, evaluation, evaluationSource);
        break;

      case 'defer':
        this.deferProposal(proposal, evaluation, eventPayload, evaluationSource);
        break;
    }
  }

  /**
   * Handle the initiator's answer to a counter-proposal we sent (Wave-4a).
   *
   * - accept → the handshake is on under the COUNTER's conditions: join the
   *   collaboration and publish the regular join-response accept, so the
   *   initiator's tracker, the trajectory and the agreement bridge all see
   *   the same accept shape as a direct accept. The initiator's evaluation
   *   source ('llm' | 'rule') is passed through — it made this decision.
   * - reject → the initiator already counts us as declined; nothing to do.
   */
  private async handleCounterResponse(payload: Record<string, unknown>): Promise<void> {
    if (payload.targetAgentId !== this.agentId) return;

    if (payload.acDecision !== 'accept') {
      logger.info(
        `[CollaborationProposalHandler:${this.agentId}] Counter-proposal for ${String(payload.collaborationId)} ` +
        `rejected by initiator: ${String(payload.reason ?? 'no reason')}`,
      );
      return;
    }

    const proposal = payload.proposal as CollaborationProposal | undefined;
    if (!proposal) {
      logger.warn(
        `[CollaborationProposalHandler:${this.agentId}] Counter-response accept without the original proposal — cannot join`,
      );
      return;
    }

    logger.info(
      `[CollaborationProposalHandler:${this.agentId}] Counter-proposal accepted by initiator — joining ${String(payload.collaborationId)}`,
    );
    const evaluationSource: ProposalEvaluationSource = payload.evaluationSource === 'rule' ? 'rule' : 'llm';
    const evaluation: ProposalEvaluation = {
      proposal,
      decision: 'accept',
      confidence: 1,
      reasoning: `Counter-proposal accepted by initiator: ${String(payload.reason ?? 'conditions agreed')}`,
      benefits: [],
      costs: [],
      evaluatedAt: new Date(),
    };
    await this.acceptProposal(proposal, evaluation, payload, evaluationSource);
  }

  /**
   * Defer the decision on a proposal (Wave-4a): publish a 'defer' answer so
   * the initiator keeps the handshake pending, then re-evaluate after the
   * suggested delay (config.deferDelayMs, capped at MAX_DEFER_DELAY_MS).
   * One defer per proposal — a proposal that still evaluates to 'defer' on
   * re-evaluation is rejected, so the handshake always converges (and the
   * initiator's 120s timeout remains the final backstop).
   */
  private deferProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation,
    eventPayload?: Record<string, unknown>,
    evaluationSource: ProposalEvaluationSource = 'llm',
  ): void {
    const collaborationId =
      proposal.metadata?.collaborationId ??
      (eventPayload as Record<string, unknown> | undefined)?.collaborationId as string | undefined;

    // Second defer → reject: deferring must not become an indefinite stall.
    if (this.deferredProposals.has(proposal.id)) {
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Proposal ${proposal.id} still undecided after defer — rejecting`);
      void this.rejectProposal(proposal, {
        ...evaluation,
        decision: 'reject',
        reasoning: `${evaluation.reasoning} (still undecided after defer — rejected)`,
      }, evaluationSource);
      return;
    }
    this.deferredProposals.add(proposal.id);

    const deferMs = Math.min(this.config.deferDelayMs ?? DEFAULT_DEFER_DELAY_MS, MAX_DEFER_DELAY_MS);
    logger.info(
      `[CollaborationProposalHandler:${this.agentId}] Deferring decision on proposal ${proposal.id} ` +
      `(re-evaluation in ${deferMs}ms)`,
    );

    // Publish the defer answer. Mirrors the accept/reject payload shape
    // (Fix-8) so the initiator's tracker and trajectory can correlate it.
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'defer',
        acDecision: 'defer',
        agentId: this.agentId,
        collaborationId,
        proposal,
        reason: evaluation.reasoning,
        evaluationSource,
        // R5-F10: why the LLM did not participate (fallback answers only).
        ...(evaluation.evaluationError !== undefined ? { evaluationError: evaluation.evaluationError } : {}),
        deferMs,
        // T-202: what the responder can actually deliver (trajectory context)
        responderContext: this.responderContext(proposal),
      },
      metadata: {},
    });

    const timer = setTimeout(() => {
      this.deferTimers.delete(proposal.id);
      void this.reevaluateAfterDefer(proposal, eventPayload).catch(error => {
        logger.error(`[CollaborationProposalHandler:${this.agentId}] Defer re-evaluation failed:`, error);
      });
    }, deferMs);
    // Do not keep the process alive solely for a deferred answer.
    timer.unref?.();
    this.deferTimers.set(proposal.id, timer);
  }

  /**
   * Re-evaluate a deferred proposal when its delay elapses (Wave-4a). Runs
   * the same LLM-first evaluation as the initial pass; the initiator's
   * handshake timeout still bounds the total wait.
   */
  private async reevaluateAfterDefer(
    proposal: CollaborationProposal,
    eventPayload?: Record<string, unknown>,
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Re-evaluating deferred proposal ${proposal.id}`);
    try {
      const evaluation = await this.evaluateProposal(proposal);
      await this.actOnProposal(evaluation, eventPayload, 'llm');
    } catch (error) {
      logger.error(
        `[CollaborationProposalHandler:${this.agentId}] Defer re-evaluation LLM failed, using capability-based fallback:`,
        error,
      );
      const evaluation = this.evaluateByCapabilities(proposal);
      // R5-F10: same honest-degradation trace as the initial pass.
      evaluation.evaluationError = error instanceof Error ? error.message : String(error);
      await this.actOnProposal(evaluation, eventPayload, 'fallback');
    }
  }

  /**
   * R6-B-F02: the accept path's fulfillment decision point (opt-in via
   * options.fulfillmentGate; see proposal/fulfillment-gate.ts for the full
   * semantics). Disabled → the legacy accept runs byte-identical. Enabled:
   * the provider checks its LIVE capability surface against the promised
   * capabilities BEFORE signing — full coverage fulfills directly; a gap is
   * either delegated hop-(n+1) (locked downstream handshake, bounded wait)
   * or rejected honestly (hop budget exhausted / no covering service /
   * downstream declined). The verdict record rides the accept/reject payload
   * (`fulfillment`) so the trajectory shows the hop depth and the parent
   * chain instead of a bare answer.
   */
  private async acceptWithFulfillmentGate(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation,
    eventPayload: Record<string, unknown> | undefined,
    evaluationSource: ProposalEvaluationSource,
  ): Promise<void> {
    if (this.fulfillmentGate?.enabled !== true) {
      await this.acceptProposal(proposal, evaluation, eventPayload, evaluationSource);
      return;
    }

    const maxHopDepth = this.fulfillmentGate.maxHopDepth ?? DEFAULT_MAX_HOP_DEPTH;
    const delegator = new DownstreamDelegator(this.environment, this.agentId);
    const verdict = assessFulfillment(
      proposal,
      this.capabilitySurface(),
      { maxHopDepth },
      gap => delegator.findDownstreamTarget(gap, [this.agentId, proposal.proposedBy]),
    );

    if (verdict.action === 'fulfill') {
      await this.acceptProposal(proposal, evaluation, eventPayload, evaluationSource, verdict.record);
      return;
    }

    if (verdict.action === 'reject') {
      logger.warn(`[CollaborationProposalHandler:${this.agentId}] Fulfillment gate rejects proposal ${proposal.id}: ${verdict.record.reason}`);
      await this.rejectProposal(proposal, {
        ...evaluation,
        decision: 'reject',
        reasoning: verdict.record.reason,
      }, evaluationSource, verdict.record);
      return;
    }

    // delegate: run the hop-(n+1) handshake, then answer hop-n from its outcome.
    const hopCtx = hopContextOf(proposal);
    const parentCollaborationId =
      proposal.metadata?.collaborationId ??
      (eventPayload as Record<string, unknown> | undefined)?.collaborationId as string | undefined ??
      proposal.id;
    logger.info(
      `[CollaborationProposalHandler:${this.agentId}] Fulfillment gate: ${verdict.record.reason}`,
    );
    const outcome = await delegator.delegate(
      verdict.target,
      hopCtx,
      parentCollaborationId,
      proposal.goal ?? proposal.description ?? 'fulfillment support',
      this.fulfillmentGate.delegationTimeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
    );

    if (outcome.outcome === 'accepted') {
      const record: FulfillmentRecord = {
        ...verdict.record,
        mode: 'delegated',
        reason: `${verdict.record.reason} — downstream handshake accepted (${outcome.collaborationId})`,
        downstream: {
          collaborationId: outcome.collaborationId,
          providerAgentId: verdict.target.providerAgentId,
          serviceId: verdict.target.serviceId,
          serviceName: verdict.target.serviceName,
        },
      };
      await this.acceptProposal(proposal, evaluation, eventPayload, evaluationSource, record);
      return;
    }

    // The downstream handshake failed — honest exit, NEVER a hang: hop-n is
    // rejected with both the gap and the downstream failure named, so the
    // initiator's existing all-rejected/timeout cancel semantics take over.
    const record: FulfillmentRecord = {
      ...verdict.record,
      mode: 'reject',
      reason:
        `Honest exit: downstream delegation for [${verdict.record.missingCapabilities.join(', ')}] ` +
        `failed (${outcome.reason}) — cannot fulfill the promise`,
    };
    logger.warn(`[CollaborationProposalHandler:${this.agentId}] Fulfillment gate rejects proposal ${proposal.id} after failed delegation: ${outcome.reason}`);
    await this.rejectProposal(proposal, {
      ...evaluation,
      decision: 'reject',
      reasoning: record.reason,
    }, evaluationSource, record);
  }

  /**
   * Accept a collaboration proposal
   *
   * @param proposal - The accepted proposal
   * @param evaluation - The evaluation result
   * @param eventPayload - Original event payload for additional context (collaborationId, etc.)
   * @param fulfillment - R6-B-F02 fulfillment-gate verdict record (undefined = gate off)
   */
  private async acceptProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation,
    eventPayload?: Record<string, unknown>,
    evaluationSource: ProposalEvaluationSource = 'llm',
    fulfillment?: FulfillmentRecord,
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Accepting proposal from ${proposal.proposedBy}`);

    // Record collaboration
    if (!this.collaborationHistory.has(proposal.proposedBy)) {
      this.collaborationHistory.set(proposal.proposedBy, []);
    }
    this.collaborationHistory.get(proposal.proposedBy)!.push(new Date());
    this.activeCollaborations.add(proposal.id);

    // Determine the collaborationId from multiple possible sources:
    // 1. proposal.metadata.collaborationId (set during normalization for informal proposals)
    // 2. (proposal as unknown as Record<string, unknown>).collaborationId (if present on the proposal object)
    // 3. eventPayload.collaborationId (for COLLABORATION_MESSAGE events)
    const collaborationId =
      proposal.metadata?.collaborationId ??
      (proposal as unknown as Record<string, unknown>).collaborationId as string ??
      (eventPayload as Record<string, unknown> | undefined)?.collaborationId as string;

    // Publish acceptance event with all relevant data
    // Uses 'join-response' type so listeners can identify this as a response to a collaboration proposal
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'join-response',
        acDecision: 'accept',
        proposal: proposal,
        evaluation: evaluation,
        agentId: this.agentId,
        collaborationId: collaborationId,
        decision: 'accept',
        reason: evaluation.reasoning,
        evaluationSource,
        // R5-F10: why the LLM did not participate (fallback answers only).
        ...(evaluation.evaluationError !== undefined ? { evaluationError: evaluation.evaluationError } : {}),
        // T-202: what the responder can actually deliver (trajectory context)
        responderContext: this.responderContext(proposal),
        // R6-B-F02: the fulfillment-gate verdict (hop depth, delegation
        // backing) — the trajectory distinguishes hop-1/hop-2 accepts.
        ...(fulfillment !== undefined ? { fulfillment } : {}),
      },
      metadata: {},
    });

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Published acceptance for proposal ${proposal.id}`);

    // Join the collaboration session autonomously
    if (collaborationId && this.agent) {
      logger.info(`[CollaborationProposalHandler:${this.agentId}] Joining collaboration ${collaborationId}`);

      const joinResult = await this.agent.joinCollaboration(collaborationId, {
        role: 'participant',
        // T-202: join with the real surface (declared ∪ device-derived)
        capabilities: this.capabilitySurface(),
        metadata: {
          proposalId: proposal.id,
          proposedBy: proposal.proposedBy,
          evaluationConfidence: evaluation.confidence,
          evaluationReasoning: evaluation.reasoning,
        },
      });

      if (joinResult.success) {
        logger.info(`[CollaborationProposalHandler:${this.agentId}] Successfully joined collaboration ${collaborationId}`);
      } else {
        logger.error(
          `[CollaborationProposalHandler:${this.agentId}] Failed to join collaboration ${collaborationId}: ${joinResult.error}`
        );
      }
    } else if (!collaborationId) {
      logger.warn(
        `[CollaborationProposalHandler:${this.agentId}] No collaborationId found in proposal ${proposal.id}, cannot join session`
      );
    } else if (!this.agent) {
      logger.warn(
        `[CollaborationProposalHandler:${this.agentId}] No agent reference set, cannot join collaboration ${collaborationId}. Call setAgent() first.`
      );
    }

    // If auto-execute is enabled, integrate external services
    if (this.config.autoExecuteAccepted) {
      await this.integrateExternalServices(proposal, evaluation);
    }
  }

  /**
   * Reject a collaboration proposal
   */
  private async rejectProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation,
    evaluationSource: ProposalEvaluationSource = 'llm',
    fulfillment?: FulfillmentRecord,
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Rejecting proposal from ${proposal.proposedBy}`);

    // Publish rejection event. Mirrors the accept payload shape (Fix-8):
    // collaborationId + agentId + acDecision let the initiator's handshake
    // tracker and trajectory recorders correlate the response.
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'reject',
        acDecision: 'reject',
        agentId: this.agentId,
        collaborationId: proposal.metadata?.collaborationId,
        proposal: proposal,
        reason: evaluation.reasoning,
        evaluationSource,
        // R5-F10: why the LLM did not participate (fallback answers only).
        ...(evaluation.evaluationError !== undefined ? { evaluationError: evaluation.evaluationError } : {}),
        // T-202: what the responder could have delivered (trajectory context)
        responderContext: this.responderContext(proposal),
        // R6-B-F02: present on fulfillment-gate rejections (honest exit:
        // missing capabilities + hop context named).
        ...(fulfillment !== undefined ? { fulfillment } : {}),
      },
      metadata: {},
    });

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Published rejection for proposal ${proposal.id}`);
  }

  /**
   * Send a counter-proposal
   *
   * Wave-4a: the payload now mirrors the accept/reject shape (Fix-8) —
   * collaborationId + agentId + acDecision + evaluationSource — so the
   * initiator's handshake tracker can correlate it and answer with a
   * 'counter-response' (accept → handshake on under the counter's
   * conditions; reject → handshake cancelled). One round only: a second
   * counter is treated as a rejection by the initiator.
   */
  private async counterProposal(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation,
    evaluationSource: ProposalEvaluationSource = 'llm',
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Sending counter-proposal to ${proposal.proposedBy}`);

    // Publish counter-proposal event
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'counter',
        acDecision: 'counter',
        agentId: this.agentId,
        collaborationId: proposal.metadata?.collaborationId,
        originalProposal: proposal,
        counterProposal: evaluation.counterProposal,
        reason: evaluation.reasoning,
        evaluationSource,
        // R5-F10: why the LLM did not participate (fallback answers only).
        ...(evaluation.evaluationError !== undefined ? { evaluationError: evaluation.evaluationError } : {}),
        // T-202: what the responder can actually deliver (trajectory context)
        responderContext: this.responderContext(proposal),
      },
      metadata: {},
    });

    logger.info(`[CollaborationProposalHandler:${this.agentId}] Published counter-proposal for ${proposal.id}`);
  }

  /**
   * Integrate external services from accepted proposal (Fix-49 phase 3).
   *
   * Pre-fix this was a stub ("For now, just log") — the partner's derived
   * services were never actually registered into the agent's resource layer,
   * so AC execution had no cross-owner service consumption path. Now the
   * partner's declared capabilities are registered as EXTERNAL resources
   * (via the environment's ServiceBroker): the accepting agent's Phase 2
   * (matchExternalServices) can find and invoke them during plan execution,
   * routing device actions through the device owner's agent — the same
   * semantics as the server's agreement/invoke path.
   */
  private async integrateExternalServices(
    proposal: CollaborationProposal,
    evaluation: ProposalEvaluation
  ): Promise<void> {
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Integrating external services from ${proposal.proposedBy}`);

    const services = proposal.services ?? [];
    if (services.length === 0 && proposal.capabilities.length === 0) {
      logger.info(`[CollaborationProposalHandler:${this.agentId}] No services or capabilities to integrate`);
      return;
    }

    // Discover the partner's actual services from the environment's service
    // registry — this is the same discovery the three-phase matching's
    // Phase 2 uses, so whatever we register here IS what execution finds.
    try {
      // Discover the partner's services from the environment's service
      // registry — broad discovery, then filter by the partner's provider
      // id (the ServiceQuery interface doesn't carry providerAgentId).
      const allServices = this.environment.discoverServices({});
      const partnerServices = allServices.filter(svc => {
        const provider = (svc as { getProviderInfo?: () => { providerAgentId?: string } }).getProviderInfo?.();
        return provider?.providerAgentId === proposal.proposedBy;
      });

      // R42-A/F3 §7.2: services may be structured terms ({name, semanticType})
      // or legacy plain strings — the mention check accepts both.
      const requestedNames = services
        .map(s => (typeof s === 'string' ? s : (s as ProposalServiceTerm)?.name))
        .filter((n): n is string => typeof n === 'string');

      const integrated: string[] = [];
      for (const service of partnerServices) {
        // Only integrate services the proposal actually mentions (or whose
        // capabilities match) — we don't want to pull in the partner's
        // entire catalog, just what this collaboration needs.
        const svcCaps = (service as { getCapabilities?: () => string[]; capabilities?: string[] });
        const caps = svcCaps.getCapabilities?.() ?? svcCaps.capabilities ?? [];
        const relevant = proposal.capabilities.some(pc =>
          caps.some(c => c.toLowerCase().includes(pc.toLowerCase()) || pc.toLowerCase().includes(c.toLowerCase()))
        ) || requestedNames.includes(service.name);

        if (relevant) {
          integrated.push(service.name);
          // The resource is already in the environment's service registry;
          // Phase 2 (matchExternalServices) discovers it there via the
          // ServiceBroker — no separate registration needed. The integration
          // is that this agent now ACCEPTS the partner's services as
          // legitimate external resources for this collaboration.
        }
      }

      logger.info(
        `[CollaborationProposalHandler:${this.agentId}] Integrated ${integrated.length} service(s) from ${proposal.proposedBy}: ${integrated.join(', ')}`,
      );
    } catch (error) {
      logger.warn(
        `[CollaborationProposalHandler:${this.agentId}] Service discovery for integration failed (non-fatal):`,
        error,
      );
    }

    // Publish integration event. NOTE (Fix-8): this must NOT reuse
    // ENVIRONMENT_PARAM_CHANGED — agents process that type as a fresh
    // environment event, so an accept would re-trigger AC assessments and
    // cause an initiation storm.
    this.environment.eventManager.publish({
      type: EventType.COLLABORATION_MESSAGE,
      source: this.agentId,
      priority: EventPriority.NORMAL,
      payload: {
        type: 'services-integrated',
        partner: proposal.proposedBy,
        services: proposal.services,
        // Fix-49 phase 3: signal that execution may now route through the
        // partner's services (Phase 2 matching).
        capabilities: proposal.capabilities,
      },
      metadata: {},
    });
  }

  /**
   * Extract JSON from LLM response (handles markdown code blocks)
   */
  private extractJSON(content: string): string {
    // Check if content contains markdown code blocks
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    // Check if content starts with { but has extra text
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return content.substring(firstBrace, lastBrace + 1);
    }

    // Return as-is if no patterns found
    return content.trim();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ProposalHandlerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info(`[CollaborationProposalHandler:${this.agentId}] Config updated`);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      activeCollaborations: this.activeCollaborations.size,
      totalCollaborations: Array.from(this.collaborationHistory.values()).reduce(
        (sum, dates) => sum + dates.length,
        0
      ),
      uniquePartners: this.collaborationHistory.size,
    };
  }
}
