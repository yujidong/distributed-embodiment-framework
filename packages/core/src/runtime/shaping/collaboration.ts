/**
 * Collaboration records — decisions, handshake trajectory, cross-agent views — pure shaping (L2), see docs/architecture-runtime.md
 *
 * Deterministic, no engine state, no I/O. Types come from ../contract.js.
 */

import type {
  EngineSnapshot,
  RuntimeCollaborationRecord,
  RuntimeDecisionRecord,
} from '../contract.js';
import type { SystemEvent } from '../../events/index.js';
import { capabilityMatches } from '../../utils/capabilityMatching.js';
import { hasActuationBacking, type PlannerDeviceInfo } from '../../decision/rule-actuation-planner.js';
import type { SemanticOfferRule } from '../../service/semantic-offers.js';
import type { CognitiveDecision } from '../../decision/cognitive-decision.js';

// ---------------------------------------------------------------------------

/** Structural TrajectoryRecorder surface the handshake writer needs. */
export interface HandshakeRecorderLike {
  recordCollaborationResponse(input: {
    collaborationId: string;
    agentId: string;
    decision: string;
    decisionSource: string;
    reasoning?: string;
    eventId?: string;
    /**
     * R5-F10: on a 'fallback' answer, the error that knocked the LLM out —
     * carried onto the trajectory record's errorMessage so the degradation
     * says WHY, not just THAT.
     */
    errorMessage?: string;
    /**
     * T-202: responder context carried on the answer event, when present.
     * T-054: devices ride along — the responder's bound actuation surface
     * (bounded downstream at write time).
     */
    context?: {
      capabilities?: string[];
      partnerServices?: Array<{
        serviceName: string;
        capabilities: string[];
        providerAgentId: string;
      }>;
      devices?: Array<{
        id: string;
        name: string;
        capabilities: string[];
        zoneId?: string;
      }>;
      providerAgentId?: string;
      /**
       * P5 (R44-extreme-F3): the collaboration's REAL initiator (from the
       * answered proposal) — pre-fix records only knew the responder, so
       * collaboration edges deduped to zero.
       */
      initiatorAgentId?: string;
      /**
       * P5: the capabilities the answered proposal requested — lets the
       * funnel attribute the handshake to the services it targeted.
       */
      requestedCapabilities?: string[];
      /** R42-A/F3 §7.1: the responder's own service face at answer time. */
      myServices?: Array<{
        name: string;
        semanticType: string;
        visibility?: string;
        /** P5: service origin (derived/published/flow/aggregate) when known. */
        origin?: string;
      }>;
    };
  }): unknown;
}/**
 * Fix-8: persist AC handshake outcomes (accept / reject / counter / defer /
 * cancel) as 'collaboration-response' trajectory records, so BOTH sides of a
 * collaboration are auditable. Wave-4a: the negotiation steps are recorded
 * too. Pure shaping over the event payload; no-op without a recorder.
 */
/**
 * T-054: validate the responderContext.devices payload into the record
 * shape — array of {id, name, capabilities, zoneId?}. Returns undefined for
 * anything malformed (the record then honestly omits devices).
 */
function parseResponderDevices(raw: unknown): Array<{
  id: string;
  name: string;
  capabilities: string[];
  zoneId?: string;
}> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const devices: Array<{ id: string; name: string; capabilities: string[]; zoneId?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const device = entry as {
      id?: unknown;
      name?: unknown;
      capabilities?: unknown;
      zoneId?: unknown;
    };
    if (
      typeof device.id !== 'string' || typeof device.name !== 'string' ||
      !Array.isArray(device.capabilities) ||
      !device.capabilities.every((c): c is string => typeof c === 'string')
    ) {
      return undefined;
    }
    devices.push({
      id: device.id,
      name: device.name,
      capabilities: device.capabilities,
      ...(typeof device.zoneId === 'string' ? { zoneId: device.zoneId } : {}),
    });
  }
  return devices;
}

/**
 * R42-A/F3 §7.1: validate the responderContext.myServices payload into the
 * record shape — array of {name, semanticType, visibility?}. Returns
 * undefined for anything malformed (the record then honestly omits it).
 */
function parseResponderMyServices(raw: unknown): Array<{
  name: string;
  semanticType: string;
  visibility?: string;
  origin?: string;
}> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const services: Array<{ name: string; semanticType: string; visibility?: string; origin?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const service = entry as {
      name?: unknown;
      semanticType?: unknown;
      visibility?: unknown;
      origin?: unknown;
    };
    if (
      typeof service.name !== 'string' || typeof service.semanticType !== 'string'
    ) {
      return undefined;
    }
    services.push({
      name: service.name,
      semanticType: service.semanticType,
      ...(typeof service.visibility === 'string' ? { visibility: service.visibility } : {}),
      // P5: origin rides along when the seam knows it (server store rows).
      ...(typeof service.origin === 'string' ? { origin: service.origin } : {}),
    });
  }
  return services;
}

/**
 * R81-D2 (R44-F4): per-recorder collaborationId → source eventId memory.
 * Keyed by the recorder (one per EngineRuntime) so each runtime keeps its
 * own scope and the entries die with it — WeakMap instead of an engine
 * field because EngineRuntime sits at its arch-guard size ceiling.
 */
const handshakeEventIdsByRecorder = new WeakMap<HandshakeRecorderLike, Map<string, string>>();

/** P5: write-time cap for requestedCapabilities on handshake records. */
const MAX_CONTEXT_REQUESTED_CAPABILITIES = 20;

/**
 * R81-D2 (R44-F4): resolve the event id a COLLABORATION_MESSAGE's handshake
 * record should attribute to — and, on 'ac-proposal', REMEMBER it. The
 * proposal goes out while its triggering event is still in flight (delivery
 * is awaited), carrying either its own `triggerEventId` backfill (broadcast-
 * derived events) or the runtime's inflight id; the ASYNC answers
 * (join-response / reject / counter / defer / cancel) arrive after delivery
 * completion cleared the inflight marker and would otherwise fall back to
 * the synthetic collaboration UUID (extreme tier: 57% of responses missed
 * per-event attribution). `seen` is bounded (500-entry LRU, one per live
 * collaboration). Pure shaping: no engine state beyond the passed map.
 */
export function resolveHandshakeEventId(
  seen: Map<string, string>,
  rawPayload: unknown,
  inflightEventId: string | undefined,
): string | undefined {
  const payload = rawPayload as {
    type?: unknown;
    collaborationId?: unknown;
    triggerEventId?: unknown;
  } | undefined;
  if (payload?.type === 'ac-proposal' && typeof payload.collaborationId === 'string') {
    const triggerEventId =
      typeof payload.triggerEventId === 'string' && payload.triggerEventId.length > 0
        ? payload.triggerEventId
        : inflightEventId;
    if (triggerEventId !== undefined) {
      if (seen.size >= 500 && !seen.has(payload.collaborationId)) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.set(payload.collaborationId, triggerEventId);
    }
  }
  const remembered = typeof payload?.collaborationId === 'string'
    ? seen.get(payload.collaborationId)
    : undefined;
  return inflightEventId ?? remembered;
}

export function recordHandshakeToTrajectory(
  recorder: HandshakeRecorderLike,
  event: SystemEvent,
  inflightEventId: string | undefined,
): void {  const payload = event.payload as {
    type?: string;
    acDecision?: string;
    agentId?: string;
    targetAgentId?: string;
    collaborationId?: string;
    reason?: string;
    evaluationSource?: string;
    /** R5-F10: the LLM failure behind a 'fallback' answer, when known. */
    evaluationError?: string;
    outcome?: string;
    responderContext?: {
      capabilities?: unknown;
      devices?: unknown;
      providerAgentId?: unknown;
      /** P5 (R44-extreme-F3): the collaboration's real initiator. */
      initiatorAgentId?: unknown;
      /** R42-A/F3 §7.1: the responder's own service face at answer time. */
      myServices?: unknown;
    };
    /** P5: the answered proposal rides accept/reject/counter/defer payloads. */
    proposal?: {
      capabilities?: unknown;
    };

  } | undefined;
  if (!payload || typeof payload.collaborationId !== 'string') return;

  // R81-D2 (R44-F4): resolve (and, on ac-proposal, remember) the REAL source
  // event id — async answers arrive after the runtime's inflight window.
  let seen = handshakeEventIdsByRecorder.get(recorder);
  if (seen === undefined) {
    seen = new Map<string, string>();
    handshakeEventIdsByRecorder.set(recorder, seen);
  }
  const sourceEventId = resolveHandshakeEventId(seen, payload, inflightEventId);

  // Fix-12: the responder labels its evaluation path ('llm' when the
  // accept/reject came from the agent's LLM, 'fallback' when the LLM was
  // unavailable and the tightened capability rule decided). Pass it
  // through so the trajectory shows whether the LLM actually participated.
  const decisionSource = payload.evaluationSource === 'fallback' ? 'fallback'
    : payload.evaluationSource === 'rule' ? 'rule'
      : 'llm';

  // R5-F10: the error behind a fallback answer (timeout, provider failure,
  // unparseable output) rides the record — a bare 'fallback' label was the
  // silent-degradation half of the incident.
  const evaluationError = typeof payload.evaluationError === 'string' && payload.evaluationError.length > 0
    ? payload.evaluationError
    : undefined;

  // T-202: the responder attaches its real capability surface to the answer
  // (CollaborationProposalHandler.responderContext) — shape it into the
  // trajectory context so handshake records stop hard-coding empties.
  const responderContext = payload.responderContext;
  const capabilities = Array.isArray(responderContext?.capabilities) &&
      responderContext.capabilities.every((c): c is string => typeof c === 'string')
    ? responderContext.capabilities
    : undefined;
  const providerAgentId = typeof responderContext?.providerAgentId === 'string'
    ? responderContext.providerAgentId
    : undefined;
  // P5 (R44-extreme-F3): the real initiator — with it the (initiator,
  // responder) edge is reconstructible; pre-fix the record was self-only.
  const initiatorAgentId = typeof responderContext?.initiatorAgentId === 'string'
    ? responderContext.initiatorAgentId
    : undefined;
  // P5: the capabilities the answered proposal requested (bounded at parse —
  // they ride every answer record forever).
  const requestedCapabilities = Array.isArray(payload.proposal?.capabilities)
    ? payload.proposal.capabilities
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .slice(0, MAX_CONTEXT_REQUESTED_CAPABILITIES)
    : undefined;
  // T-054: carry the responder's bound devices (the honest actuation surface
  // behind the answer) instead of dropping them — validate structurally, and
  // never let a malformed entry break the handshake record.
  const devices = parseResponderDevices(responderContext?.devices);
  // R42-A/F3 §7.1: the responder's own service face (name[semanticType]) —
  // same structural validation as devices, same honest-omission on garbage.
  const myServices = parseResponderMyServices(responderContext?.myServices);
  const context = capabilities !== undefined || providerAgentId !== undefined || devices !== undefined || myServices !== undefined || initiatorAgentId !== undefined || (requestedCapabilities !== undefined && requestedCapabilities.length > 0)
    ? {
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(providerAgentId !== undefined ? { providerAgentId } : {}),
        ...(initiatorAgentId !== undefined ? { initiatorAgentId } : {}),
        ...(requestedCapabilities !== undefined && requestedCapabilities.length > 0
          ? { requestedCapabilities }
          : {}),
        ...(devices !== undefined ? { devices } : {}),
        ...(myServices !== undefined ? { myServices } : {}),
      }
    : undefined;

  if (payload.type === 'join-response' && payload.acDecision === 'accept') {
    recorder.recordCollaborationResponse({
      collaborationId: payload.collaborationId,
      agentId: payload.agentId ?? event.source,
      decision: 'accept',
      decisionSource,
      reasoning: payload.reason,
      eventId: sourceEventId,
      ...(evaluationError !== undefined ? { errorMessage: evaluationError } : {}),
      context,
    });
  } else if (payload.type === 'counter-response' && payload.acDecision === 'reject') {
    // Wave-4a: the initiator rejected the counter — the partner counts as
    // declined; attribute the reject to the countering partner. A counter
    // ACCEPT is not recorded here: the responder's join-response accept
    // follows and records the closing 'accept'.
    recorder.recordCollaborationResponse({
      collaborationId: payload.collaborationId,
      agentId: typeof payload.targetAgentId === 'string' ? payload.targetAgentId : (payload.agentId ?? event.source),
      decision: 'reject',
      decisionSource,
      reasoning: payload.reason !== undefined ? `counter-proposal rejected: ${payload.reason}` : 'counter-proposal rejected',
      eventId: sourceEventId,
      ...(evaluationError !== undefined ? { errorMessage: evaluationError } : {}),
      context,
    });
  } else if (payload.type === 'reject' || payload.acDecision === 'reject') {
    recorder.recordCollaborationResponse({
      collaborationId: payload.collaborationId,
      agentId: payload.agentId ?? event.source,
      decision: 'reject',
      decisionSource,
      reasoning: payload.reason,
      eventId: sourceEventId,
      ...(evaluationError !== undefined ? { errorMessage: evaluationError } : {}),
      context,
    });
  } else if (payload.type === 'counter' || payload.acDecision === 'counter') {
    // Wave-4a: the partner's counter-proposal — negotiation in progress.
    recorder.recordCollaborationResponse({
      collaborationId: payload.collaborationId,
      agentId: payload.agentId ?? event.source,
      decision: 'counter',
      decisionSource,
      reasoning: payload.reason,
      eventId: sourceEventId,
      ...(evaluationError !== undefined ? { errorMessage: evaluationError } : {}),
      context,
    });
  } else if (payload.type === 'defer' || payload.acDecision === 'defer') {
    // Wave-4a: the partner deferred — it will re-evaluate and answer later.
    recorder.recordCollaborationResponse({
      collaborationId: payload.collaborationId,
      agentId: payload.agentId ?? event.source,
      decision: 'defer',
      decisionSource,
      reasoning: payload.reason,
      eventId: sourceEventId,
      ...(evaluationError !== undefined ? { errorMessage: evaluationError } : {}),
      context,
    });
  } else if (payload.type === 'ac-cancelled') {
    recorder.recordCollaborationResponse({
      collaborationId: payload.collaborationId,
      agentId: payload.agentId ?? event.source,
      decision: 'cancelled',
      // BUG-07: a teardown cancel (runtime rebuild/hibernate/stop) carries
      // outcome 'aborted' and gets its own marker so the eval funnel buckets
      // it apart from both a coordinator timeout and a silent death.
      decisionSource: payload.outcome === 'timeout' ? 'timeout' : payload.outcome === 'aborted' ? 'aborted' : 'rule',
      reasoning: payload.reason,
      eventId: sourceEventId,
    });
  }
}/** One collaboration session as an agent's manager stores it. */
export interface CollaborationSessionRow {
  id: string;
  initiator: string;
  status: string;
  type: string;
  participants: string[];
  description: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * T-036-depth (DevLoop R17): capability-matching candidates excluded from
   * this session's partner selection by scope-of-practice (bounded at the
   * coordinator). Copied through to the runtime record so the console shows
   * honest exclusions beside the collaboration that formed.
   */
  scopeExclusions?: Array<{ agentId: string; blockedBy: string[] }>;
}/** Structural agent surface the collaborations view needs. */
export interface CollaborationAgentLike {
  id: string;
  getCollaborationSessions(): {
    active: CollaborationSessionRow[];
    completed: CollaborationSessionRow[];
  };
}/**
 * Fix-8: collaboration sessions across ALL agents, one row per
 * (collaboration, agent-view). Pure shaping over per-agent session stores.
 */
export function buildCollaborationRows(
  agents: Iterable<CollaborationAgentLike>,
): RuntimeCollaborationRecord[] {
  const rows: RuntimeCollaborationRecord[] = [];
  for (const agent of agents) {
    let sessions: CollaborationAgentLike['getCollaborationSessions'] extends () => infer R ? R : never;
    try {
      sessions = agent.getCollaborationSessions();
    } catch {
      continue; // Agent introspection unavailable
    }
    const pushRows = (
      list: CollaborationSessionRow[],
      history: boolean,
    ): void => {
      for (const s of list) {
        rows.push({
          id: s.id,
          agentId: agent.id,
          role: s.initiator === agent.id ? 'initiator' : 'participant',
          status: s.status,
          type: s.type,
          initiator: s.initiator,
          // Fix-10 (R4 F-18): the row already names the initiator — drop it
          // from participants and dedupe the rest (session stores may list
          // the initiator or repeat an id).
          participants: [...new Set(s.participants.filter(p => p !== s.initiator))],
          description: s.description,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          history,
          // T-036-depth: honest scope-of-practice exclusions ride the row.
          ...(s.scopeExclusions !== undefined ? { scopeExclusions: s.scopeExclusions } : {}),
        });
      }
    };
    pushRows(sessions.active, false);
    pushRows(sessions.completed, true);
  }
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return rows;
}// ---------------------------------------------------------------------------
// Decision-record / effect-check / zone-geometry shaping (Fix-31 slice 5)
// ---------------------------------------------------------------------------

/** Event-id extraction (metadata first, then payload) — snapshot records. */
export function extractRecordEventId(event: SystemEvent): string {
  const fromMetadata = event.metadata?.eventId;
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) return fromMetadata;
  const payload = event.payload as { eventId?: unknown } | undefined;
  if (payload && typeof payload.eventId === 'string' && payload.eventId.length > 0) {
    return payload.eventId;
  }
  return event.id;
}/** R15-D4: the zone a system event belongs to (metadata, then payload). */
export function extractRecordZoneId(event: SystemEvent): string | undefined {
  const fromMetadata = event.metadata?.zoneId;
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) return fromMetadata;
  const payload = event.payload as { zoneId?: unknown; zone?: unknown } | undefined;
  if (payload && typeof payload.zoneId === 'string' && payload.zoneId.length > 0) {
    return payload.zoneId;
  }
  if (payload && typeof payload.zone === 'string' && payload.zone.length > 0) {
    return payload.zone;
  }
  return undefined;
}/** Shape one AC assessment into a RuntimeDecisionRecord (Fix-8 ring). */
export function buildDecisionRecord(
  agentId: string,
  assessment: {
    decision: string;
    decisionSource: string;
    llmAssessment?: {
      reasoning?: string;
      reasoningCode?: string;
      reasoningParams?: Record<string, string | number>;
      decisionSubSource?: 'llm-json' | 'llm-fsm';
    };
    /** Mechanism B: the flow a handle_independently decision named. */
    invokeFlow?: { flowId: string; params?: Record<string, unknown> };
    /**
     * Phase 1 (§14.1): the full structured decision when the cognitive JSON
     * parse won — its four auditable segments ride the record additively.
     */
    cognitiveDecision?: CognitiveDecision;
    /** R40-A3（§7.5 升级通道）：升级标注（只通知不执行的决策）。 */
    escalated?: boolean;
    escalationCondition?: string;
  },
  event: SystemEvent,
  /** T-024: the deciding model — attached to decisionSource 'llm' records. */
  llmModel?: string,
  /** R102: the event's provenance ('scheduled' | 'runtime' | 'perception'). */
  eventSource?: RuntimeDecisionRecord['eventSource'],
): RuntimeDecisionRecord {
  const zoneId = extractRecordZoneId(event);
  const cognitive = assessment.cognitiveDecision;
  return {
    agentId,
    eventId: extractRecordEventId(event),
    eventType: (event.metadata?.eventType as string | undefined) ?? event.type,
    decision: assessment.decision,
    decisionSource: assessment.decisionSource,
    // T-024: mirror the trajectory's per-record model so snapshot consumers
    // can attribute decisions to a model without joining trajectory files.
    // Only genuine 'llm' decisions carry it — rule/precheck/triage made no
    // big-model call (the trajectory's matched-call logic agrees).
    ...(llmModel !== undefined && assessment.decisionSource === 'llm'
      ? { llmModel }
      : {}),
    // T-024-part3: parse-quality marker — which parser won the LLM answer
    // (structured JSON vs prose FSM). The assessor only sets it on the LLM
    // path, so it self-guards against rule/precheck/triage records.
    ...(assessment.llmAssessment?.decisionSubSource !== undefined &&
        assessment.decisionSource === 'llm'
      ? { decisionSubSource: assessment.llmAssessment.decisionSubSource }
      : {}),
    ...(assessment.llmAssessment?.reasoning
      ? { reasoning: assessment.llmAssessment.reasoning }
      : {}),
    // R15-D3: the structured twin rides along whenever the rule layer set it.
    ...(assessment.llmAssessment?.reasoningCode !== undefined
      ? { reasoningCode: assessment.llmAssessment.reasoningCode }
      : {}),
    ...(assessment.llmAssessment?.reasoningParams !== undefined
      ? { reasoningParams: assessment.llmAssessment.reasoningParams }
      : {}),
    // Mechanism B: the named flow rides the decision record (run-ledger
    // linkage via the run's invokedBy + triggerKind 'agent').
    ...(assessment.invokeFlow !== undefined ? { invokeFlow: assessment.invokeFlow } : {}),
    // Phase 1 (§14.1): the cognitive segments ride the record ADDITIVELY —
    // legacy consumers keep reading the derived decision/reasoning fields,
    // new consumers (decision panel, training export) see the full schema.
    ...(cognitive !== undefined ? { situation: cognitive.situation } : {}),
    ...(cognitive !== undefined ? { actionPlan: cognitive.actionPlan } : {}),
    ...(cognitive !== undefined ? { explanation: cognitive.explanation } : {}),
    ...(cognitive !== undefined ? { uncertainty: cognitive.uncertainty } : {}),
    // R40-A3: the escalation mark rides the record (notify-only decisions are
    // auditable as "deliberately executed nothing").
    ...(assessment.escalated === true ? { escalated: true } : {}),
    ...(assessment.escalationCondition !== undefined ? { escalationCondition: assessment.escalationCondition } : {}),
    // R15-D4: the event's zone, server-side truth.
    ...(zoneId !== undefined ? { zoneId } : {}),
    // R102: event provenance + key payload — no reverse-engineering from
    // eventId naming habits (which the runtime-id collision made fragile).
    ...(eventSource !== undefined ? { eventSource } : {}),
    ...((event.payload as Record<string, unknown> | undefined)?.newValue !== undefined
      ? { eventValue: (event.payload as Record<string, unknown>).newValue as number | boolean }
      : {}),
    ...(((event.payload as Record<string, unknown> | undefined)?.severity ?? event.metadata?.severity) !== undefined
      ? { eventSeverity: ((event.payload as Record<string, unknown>)?.severity ?? event.metadata?.severity) as string }
      : {}),
    at: new Date().toISOString(),
  };
}

/**
 * T-014: deterministic ground truth for one (agent, event) pair, mirroring
 * the formal model the precheck implements (PAPER_DESIGN_V5 Definitions
 * 3–7: Coverage, Gap, interaction Type A–E, Decision) — the same factors
 * the experiment runner's GroundTruthCalculator scores against, derived
 * here from the assessment's own agent context plus the event payload.
 * Returns 'unknown' fields when the event's zone cannot be determined;
 * the trajectory recorder then marks the decision unscored (null).
 */
export function deriveDecisionGroundTruth(
  agentContext: {
    capabilities?: readonly string[];
    actuatorZoneIds?: readonly string[];
    adjacentZoneIds?: readonly string[];
  },
  event: SystemEvent,
  // BUG-01: the agent's OWN bound devices + the merged offer table — when
  // supplied, a declared Type-A (coverage × no gap) is demoted to Type-E
  // unless some own device can physically ACT on this event (the same
  // structural backing check the honesty gate runs, so a converted decision
  // and the recorded truth can never disagree). Legacy callers omit both
  // and get the pre-BUG-01 coverage/gap truth.
  ownDevices?: readonly PlannerDeviceInfo[],
  offerRules?: readonly SemanticOfferRule[],
): { correctDecision: string; interactionType: string } {
  const zoneId = extractRecordZoneId(event);
  if (zoneId === undefined) {
    return { correctDecision: 'unknown', interactionType: 'unknown' };
  }

  const payload = event.payload as {
    severity?: unknown;
    requiredCapabilities?: unknown;
    parameter?: unknown;
    eventType?: unknown;
  } | undefined;
  // Only 'low' ever changes the derived decision (Type C defer / Type D
  // ignore); absent severity behaves as the 'medium' default.
  const isLowSeverity = payload?.severity === 'low';
  const required = Array.isArray(payload?.requiredCapabilities)
    ? (payload!.requiredCapabilities as unknown[])
        .filter((c): c is string => typeof c === 'string')
    : [];

  const actuatorZones = agentContext.actuatorZoneIds ?? [];
  const capabilities = agentContext.capabilities ?? [];
  const hasGap = required.some(req =>
    !capabilities.some(ac => capabilityMatches(ac, req)),
  );
  const directCoverage = actuatorZones.includes(zoneId);
  const propagationCoverage =
    !directCoverage && (agentContext.adjacentZoneIds ?? []).includes(zoneId);

  // Definition 7 (Type) + Definition 6 (Decision):
  //   A coverage>0 ∧ Gap=∅ → handle_independently
  //   B direct ∧ Gap≠∅     → initiate_ac
  //   C propagation ∧ Gap≠∅ → defer (low severity) else initiate_ac
  //   D no coverage ∧ Gap≠∅ → sensor-only notifies (initiate_ac); actuator
  //     agents defer significant events, ignore trivial ones
  //   E no coverage ∧ Gap=∅ → initiate_ac (delegate to a covered agent)
  if (directCoverage || propagationCoverage) {
    if (!hasGap) {
      // BUG-01: declared DIRECT coverage is not enough — when the caller
      // supplies the agent's own devices, Type-A additionally requires a
      // device that can act on THIS event (planner-twin structural check;
      // the same premise the precheck.independent short-circuit and the
      // honesty gate use, so propagation-coverage truth is untouched).
      // Coverage without backing is honestly Type-E: delegate.
      if (directCoverage && ownDevices !== undefined && !hasActuationBacking({
        parameter: typeof payload?.parameter === 'string' ? payload.parameter.toLowerCase() : undefined,
        eventType: String(typeof payload?.eventType === 'string' ? payload.eventType : event.type ?? '').toLowerCase(),
        requiredCapabilities: required,
        eventZoneId: zoneId,
        devices: ownDevices,
        ...(offerRules !== undefined ? { offerRules } : {}),
      })) {
        return { correctDecision: 'initiate_ac', interactionType: 'E' };
      }
      return { correctDecision: 'handle_independently', interactionType: 'A' };
    }
    if (directCoverage) return { correctDecision: 'initiate_ac', interactionType: 'B' };
    return isLowSeverity
      ? { correctDecision: 'defer', interactionType: 'C' }
      : { correctDecision: 'initiate_ac', interactionType: 'C' };
  }
  if (hasGap) {
    if (actuatorZones.length === 0) {
      return { correctDecision: 'initiate_ac', interactionType: 'D' };
    }
    return isLowSeverity
      ? { correctDecision: 'ignore', interactionType: 'D' }
      : { correctDecision: 'defer', interactionType: 'D' };
  }
  return { correctDecision: 'initiate_ac', interactionType: 'E' };
}