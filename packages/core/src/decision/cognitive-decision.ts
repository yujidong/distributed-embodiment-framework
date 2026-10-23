/**
 * CognitiveDecisionSchema — Phase 1 of the agent cognitive architecture
 * (docs/design-agent-cognitive-architecture.md §11, ratified decision §14.1).
 *
 * This module is the ONE truth (T-051 lesson) for the structured LLM decision
 * contract that replaces the binary `{"decision","reasoning"}` answer:
 *   - the TypeScript contract (`CognitiveDecision`);
 *   - the JSON schema handed to providers for constrained decoding
 *     (`COGNITIVE_DECISION_SCHEMA` — camelCase keys matching the contract),
 *     sourced from the versioned document schemas/decision-v1.json (F0-2:
 *     that file is the single source of truth; this module re-exports the
 *     meta-stripped wire copy);
 *   - the single parser (`parseCognitiveDecision`) every consumer routes
 *     through (assessor big-model path, tests, future replay tooling);
 *   - the backward-compatibility derivation (`deriveLegacyDecision`) that
 *     keeps DualTriggerACManager / EngineRuntime / TrajectoryRecorder and the
 *     three client channels working unchanged — the legacy `decision` field
 *     is now DERIVED from `actionPlan.primary.action`.
 *
 * Parse policy (design §8.3 / §11.2): the DECISION-CRITICAL segment is
 * `actionPlan.primary.action` — when it is missing or outside the vocabulary
 * the parse fails (returns null) and the caller falls back to the legacy
 * binary JSON parser, then the prose FSM scanner (segment-wise degradation,
 * never a silent drop of an unparseable answer). The other segments degrade
 * field-by-field into safe defaults so one malformed field never throws away
 * a valid action choice.
 *
 * Pure contract module: no IO, no clock, no LLM — the single exception is
 * parseCognitiveDecisionForLane reading the LLM_GUIDED_JSON env toggle
 * (configuration, via llm-integration) to pick the checked vs tolerant parse.
 */

import { canonicalizeLLMDecision } from '../utils/decisionVocabulary.js';
import { truncateForStorage } from '../utils/truncate.js';
import { isGuidedJsonEnabled } from '@active-collaboration/llm-integration';
import { DECISION_V1_WIRE_SCHEMA, validateDecisionV1 } from './decision-schema.js';

// ============================================================================
// Contract (L2 situation assessment + L3 action plan / explanation)
// ============================================================================

/** The action vocabulary of the action plan's primary lane. */
export type CognitivePrimaryAction =
  | 'handle_independently'
  | 'initiate_ac'
  | 'defer'
  | 'escalate'
  | 'wait'
  | 'invoke_flow'
  | 'consume_service';

/** Situation classification (design §4.1). */
export type CognitiveSituationType = 'normal' | 'anomaly' | 'emergency' | 'opportunity';

/**
 * R6-E-F07: the consumption target of a `consume_service` decision — the
 * agent names ONE discovered service from the catalog (by id when known,
 * else by the exact serviceName shown on the SHORTLIST/CATALOG lines).
 * Unlike initiate_ac (open matchmaking by capability), this locks the
 * collaboration request to that service's provider. At least one of
 * serviceId/serviceName must be present; the tolerant parser drops the
 * block otherwise (the action then behaves like an un-targeted
 * initiate_ac).
 */
export interface CognitiveServiceTarget {
  serviceId?: string;
  serviceName?: string;
  /** Optional invocation terms (zone, parameters, SLA hints…). */
  terms?: Record<string, unknown>;
}

/** One device command the model named for a handle_independently decision. */
export interface CognitiveDeviceAction {
  deviceId: string;
  command: string;
  /**
   * Display name attached by the RULE lane (device lookup by id) for
   * teaching/audit text — never model vocabulary; the parser does not read
   * it from model output and deviceId remains the binding key.
   */
  deviceName?: string;
  params?: Record<string, unknown>;
}

/**
 * The full structured decision output of the cognitive L2/L3 path. Replaces
 * the binary {decision, reasoning} contract; the legacy fields are derived
 * (see `deriveLegacyDecision`).
 */
export interface CognitiveDecision {
  /** Situation assessment (L2). */
  situation: {
    type: CognitiveSituationType;
    /** 1 (trivial) .. 5 (catastrophic). */
    severity: number;
    affectedZones: string[];
    rootCauseHypothesis: string;
    /** 0..1. */
    confidence: number;
  };
  /** Goal stack (L2) — derived from the agent's assigned goals + emergent. */
  goals: Array<{
    goal: string;
    priority: number;
    deadline?: string;
  }>;
  /** Action plan (L3). */
  actionPlan: {
    primary: {
      action: CognitivePrimaryAction;
      reasoning: string;
      /** For handle_independently: device commands (ride the recommendation bridge). */
      deviceActions?: CognitiveDeviceAction[];
      /** For initiate_ac: proposed collaboration. */
      collaboration?: { partnerCapabilities: string[]; proposedTerms?: Record<string, unknown> };
      /** For invoke_flow. */
      flowId?: string;
      flowParams?: Record<string, unknown>;
      /** For consume_service (R6-E-F07): the locked catalog service. */
      serviceTarget?: CognitiveServiceTarget;
    };
    fallback?: {
      action: string;
      reasoning: string;
    };
    escalationCondition?: string;
  };
  /** Explanation (L3) — human-readable + machine-auditable factors. */
  explanation: {
    summary: string;
    factors: Array<{ name: string; weight: number }>;
    tradeoffs?: string;
    alternativesConsidered?: string[];
  };
  /** Collaboration judgment — `needed` is DERIVED from actionPlan.primary.action. */
  collaboration: {
    /** derived: action === 'initiate_ac' || action === 'consume_service' (single truth, model value overridden). */
    needed: boolean;
    partnerType?: string;
    reasoning?: string;
  };
  /** Uncertainty (L5 preview). */
  uncertainty: {
    /** 0..1. */
    overall: number;
    dataQuality?: number;
    riskFactors?: string[];
  };
}

// ============================================================================
// Constrained-decoding schema (ChatParams.format)
// ============================================================================

/**
 * JSON schema for the cognitive decision call, passed via ChatParams.format.
 * F0-2: the schema DOCUMENT lives in schemas/decision-v1.json (the versioned
 * single source of truth); this is its meta-stripped wire copy, re-exported
 * so every existing import site keeps working unchanged.
 * camelCase keys mirror the TypeScript contract 1:1 — the parser accepts a
 * small set of snake_case aliases (design §11.1 spellings) for providers or
 * fine-tunes trained on the design-doc wire format (only reachable when
 * guided JSON is off; see parseCognitiveDecisionV1Checked).
 */
export const COGNITIVE_DECISION_SCHEMA: Record<string, unknown> = DECISION_V1_WIRE_SCHEMA;

// ============================================================================
// Parser (single oracle — T-051 lesson)
// ============================================================================

/** All accepted primary-action spellings, normalized. */
const ACTION_NORMALIZATION: Readonly<Record<string, CognitivePrimaryAction>> = (() => {
  const table: Record<string, CognitivePrimaryAction> = {
    'handleindependently': 'handle_independently',
    'handleindependent': 'handle_independently',
    'initiateac': 'initiate_ac',
    'initiatecollaboration': 'initiate_ac',
    'defer': 'defer',
    'escalate': 'escalate',
    'wait': 'wait',
    'invokeflow': 'invoke_flow',
    'monitor': 'wait',
    'waitandsee': 'wait',
    'consumeservice': 'consume_service',
    'invokeservice': 'consume_service',
    'requestservice': 'consume_service',
  };
  return table;
})();

/** Normalize a model-supplied action word onto the canonical vocabulary. */
export function canonicalizeCognitiveAction(raw: unknown): CognitivePrimaryAction | null {
  if (typeof raw !== 'string') return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key.length === 0) return null;
  const direct = ACTION_NORMALIZATION[key];
  if (direct !== undefined) return direct;
  // Legacy alias vocabulary (independent/collaborate/yes/no/…) — the binary
  // era's accepted spellings keep working when they appear in an action slot.
  const legacy = canonicalizeLLMDecision(raw);
  if (legacy === 'handle_independently') return 'handle_independently';
  if (legacy === 'initiate_ac') return 'initiate_ac';
  if (legacy === 'defer') return 'defer';
  return null;
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

/**
 * T-106 write-time cap for model text riding storage (trajectory JSONL,
 * decision snapshots, WS pushes). Inputs under the cap stay byte-identical.
 */
function capText(text: string): string {
  return truncateForStorage(text) ?? text;
}

/** Bounded string list — cap count AND per-item length (T-106 discipline). */
function stringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, 16)
    .map(capText);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? capText(value) : undefined;
}

/** Read a record with camelCase first, snake_case (design §11.1) as fallback. */
function pick(record: Record<string, unknown>, camel: string, snake: string): unknown {
  const direct = record[camel];
  if (direct !== undefined) return direct;
  return record[snake];
}

/**
 * Extract a JSON object from raw model text (markdown fences, surrounding
 * prose). Returns null when no plausible object span exists.
 */
function extractJSONObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced !== null) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.substring(first, last + 1);
  return null;
}

/**
 * Parse a CognitiveDecision from raw LLM output. Returns null when the
 * decision-critical segment (`actionPlan.primary.action`, via any accepted
 * spelling) cannot be recovered — the caller then degrades to the legacy
 * binary parser / prose FSM instead of guessing.
 *
 * Segment-wise degradation (§11.2): goals/explanation/collaboration default
 * safely when absent; numeric fields clamp; invalid array entries drop.
 * `collaboration.needed` is ALWAYS the derived value
 * (`action === 'initiate_ac' || action === 'consume_service'`) — the spec
 * makes it a derived field, so a
 * model-supplied contradiction is overridden, not trusted.
 */
export function parseCognitiveDecision(text: string): CognitiveDecision | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const jsonSpan = extractJSONObject(text.trim());
  if (jsonSpan === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSpan);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;

  // --- actionPlan (REQUIRED — the decision-critical segment) ---------------
  const actionPlanRaw = pick(root, 'actionPlan', 'action_plan');
  if (typeof actionPlanRaw !== 'object' || actionPlanRaw === null) return null;
  const actionPlanRecord = actionPlanRaw as Record<string, unknown>;
  const primaryRaw = actionPlanRecord.primary;
  if (typeof primaryRaw !== 'object' || primaryRaw === null) return null;
  const primary = primaryRaw as Record<string, unknown>;

  const action = canonicalizeCognitiveAction(primary.action);
  if (action === null) return null;

  const primaryReasoning = typeof primary.reasoning === 'string'
    ? capText(primary.reasoning.trim())
    : '';

  const deviceActions: CognitiveDeviceAction[] | undefined = Array.isArray(primary.deviceActions)
    ? (primary.deviceActions as unknown[])
        .map((entry): CognitiveDeviceAction | null => {
          if (typeof entry !== 'object' || entry === null) return null;
          const rec = entry as Record<string, unknown>;
          if (typeof rec.deviceId !== 'string' || rec.deviceId.length === 0) return null;
          if (typeof rec.command !== 'string' || rec.command.length === 0) return null;
          const params = typeof rec.params === 'object' && rec.params !== null && !Array.isArray(rec.params)
            ? (rec.params as Record<string, unknown>)
            : undefined;
          return { deviceId: rec.deviceId, command: rec.command, ...(params !== undefined ? { params } : {}) };
        })
        .filter((entry): entry is CognitiveDeviceAction => entry !== null)
        .slice(0, 8) // schema maxItems bound — enforced at parse too
    : undefined;

  const collaborationRaw = primary.collaboration;
  const primaryCollaboration = typeof collaborationRaw === 'object' && collaborationRaw !== null
    ? (collaborationRaw as Record<string, unknown>)
    : undefined;

  let flowId = optionalString(primary.flowId);
  let flowParams = typeof primary.flowParams === 'object' && primary.flowParams !== null && !Array.isArray(primary.flowParams)
    ? (primary.flowParams as Record<string, unknown>)
    : undefined;
  // R40-A4 tolerant recovery: a provider that ignores the constrained format
  // may follow the pre-Phase-1 INVOCABLE_FLOWS wording and put the flow at
  // the ROOT level ({"invokeFlow": {flowId, params}}) instead of
  // actionPlan.primary — without this the named flow is silently dropped.
  // Adopted only when the primary lane carries none.
  if (flowId === undefined) {
    const legacyRoot = pick(root, 'invokeFlow', 'invoke_flow');
    if (typeof legacyRoot === 'object' && legacyRoot !== null) {
      const rec = legacyRoot as Record<string, unknown>;
      const legacyFlowId = optionalString(rec.flowId);
      if (legacyFlowId !== undefined) {
        flowId = legacyFlowId;
        if (flowParams === undefined &&
            typeof rec.params === 'object' && rec.params !== null && !Array.isArray(rec.params)) {
          flowParams = rec.params as Record<string, unknown>;
        }
      }
    }
  }

  // R6-E-F07: the consume_service target (camelCase first, snake_case alias
  // on the non-guided lane). Dropped unless at least one handle is present.
  const serviceTargetRaw = pick(primary, 'serviceTarget', 'service_target');
  let serviceTarget: CognitiveServiceTarget | undefined;
  if (typeof serviceTargetRaw === 'object' && serviceTargetRaw !== null && !Array.isArray(serviceTargetRaw)) {
    const rec = serviceTargetRaw as Record<string, unknown>;
    const serviceId = optionalString(rec.serviceId ?? rec.service_id);
    const serviceName = optionalString(rec.serviceName ?? rec.service_name);
    if (serviceId !== undefined || serviceName !== undefined) {
      serviceTarget = {
        ...(serviceId !== undefined ? { serviceId } : {}),
        ...(serviceName !== undefined ? { serviceName } : {}),
        ...(typeof rec.terms === 'object' && rec.terms !== null && !Array.isArray(rec.terms)
          ? { terms: rec.terms as Record<string, unknown> }
          : {}),
      };
    }
  }

  let fallback: CognitiveDecision['actionPlan']['fallback'];
  const fallbackRaw = actionPlanRecord.fallback;
  if (typeof fallbackRaw === 'object' && fallbackRaw !== null) {
    const rec = fallbackRaw as Record<string, unknown>;
    const fallbackAction = optionalString(rec.action);
    const fallbackReasoning = optionalString(rec.reasoning);
    if (fallbackAction !== undefined) {
      fallback = {
        action: fallbackAction,
        ...(fallbackReasoning !== undefined ? { reasoning: fallbackReasoning } : { reasoning: '' }),
      };
    }
  }

  // --- situation (required by the wire schema; degrade to defaults) --------
  const situationRaw = pick(root, 'situation', 'situation_assessment');
  const situation = typeof situationRaw === 'object' && situationRaw !== null
    ? (situationRaw as Record<string, unknown>)
    : {};
  const situationTypeRaw = situation.type;
  const situationType: CognitiveSituationType =
    situationTypeRaw === 'normal' || situationTypeRaw === 'emergency' || situationTypeRaw === 'opportunity'
      ? situationTypeRaw
      : 'anomaly';

  const severityRaw = situation.severity;
  const severity = typeof severityRaw === 'number' && Number.isFinite(severityRaw)
    ? Math.min(5, Math.max(1, Math.round(severityRaw)))
    : 3;

  // --- goals (bounded at 5, schema maxItems; strings T-106 capped) --------
  const goalsRaw = pick(root, 'goals', 'goal_stack');
  const goals: CognitiveDecision['goals'] = (Array.isArray(goalsRaw) ? (goalsRaw as unknown[]) : [])
    .map((entry): CognitiveDecision['goals'][number] | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.goal !== 'string' || rec.goal.length === 0) return null;
      const priority = typeof rec.priority === 'number' && Number.isFinite(rec.priority)
        ? Math.max(1, Math.round(rec.priority))
        : 1;
      const deadline = optionalString(rec.deadline);
      return { goal: capText(rec.goal), priority, ...(deadline !== undefined ? { deadline } : {}) };
    })
    .filter((entry): entry is CognitiveDecision['goals'][number] => entry !== null)
    .slice(0, 5);

  // --- explanation ---------------------------------------------------------
  const explanationRaw = root.explanation;
  const explanation = typeof explanationRaw === 'object' && explanationRaw !== null
    ? (explanationRaw as Record<string, unknown>)
    : {};
  const summary = typeof explanation.summary === 'string' && explanation.summary.trim().length > 0
    ? capText(explanation.summary.trim())
    : primaryReasoning;
  const factorsRaw = explanation.factors;
  const factors = Array.isArray(factorsRaw)
    ? (factorsRaw as unknown[])
        .map((entry): CognitiveDecision['explanation']['factors'][number] | null => {
          if (typeof entry !== 'object' || entry === null) return null;
          const rec = entry as Record<string, unknown>;
          if (typeof rec.name !== 'string' || rec.name.length === 0) return null;
          const weight = typeof rec.weight === 'number' && Number.isFinite(rec.weight)
            ? Math.min(1, Math.max(0, rec.weight))
            : 0;
          return { name: rec.name, weight };
        })
        .filter((entry): entry is CognitiveDecision['explanation']['factors'][number] => entry !== null)
    : [];
  const tradeoffs = optionalString(explanation.tradeoffs);
  const alternativesConsidered = stringList(explanation.alternativesConsidered);

  // --- collaboration (needed is DERIVED — spec) -----------------------------
  const collabRaw = pick(root, 'collaboration', 'collaboration_judgment');
  const collab = typeof collabRaw === 'object' && collabRaw !== null
    ? (collabRaw as Record<string, unknown>)
    : {};
  const partnerType = optionalString(collab.partnerType) ?? optionalString(collab.partner_type);
  const collabReasoning = optionalString(collab.reasoning);

  // --- uncertainty ---------------------------------------------------------
  const uncertaintyRaw = root.uncertainty;
  const uncertainty = typeof uncertaintyRaw === 'object' && uncertaintyRaw !== null
    ? (uncertaintyRaw as Record<string, unknown>)
    : {};
  const overall = clamp01(
    uncertainty.overall !== undefined ? uncertainty.overall : uncertainty.model_confidence,
    0.5,
  );
  const dataQualityRaw = pick(uncertainty, 'dataQuality', 'data_quality');
  const dataQuality = dataQualityRaw === undefined ? undefined : clamp01(dataQualityRaw, 0.5);
  const riskFactors = stringList(uncertainty.riskFactors ?? uncertainty.risk_factors);

  const escalationCondition = optionalString(actionPlanRecord.escalationCondition ?? actionPlanRecord.escalation_condition);

  return {
    situation: {
      type: situationType,
      severity,
      affectedZones: stringList(situation.affectedZones ?? situation.affected_zones),
      rootCauseHypothesis:
        typeof (situation.rootCauseHypothesis ?? situation.root_cause_hypothesis) === 'string'
          ? capText(String(situation.rootCauseHypothesis ?? situation.root_cause_hypothesis))
          : '',
      confidence: clamp01(situation.confidence, 0.5),
    },
    goals,
    actionPlan: {
      primary: {
        action,
        reasoning: primaryReasoning,
        ...(deviceActions !== undefined && deviceActions.length > 0 ? { deviceActions } : {}),
        ...(primaryCollaboration !== undefined
          ? {
            collaboration: {
              partnerCapabilities: stringList(primaryCollaboration.partnerCapabilities ?? primaryCollaboration.partner_capabilities),
              ...(typeof primaryCollaboration.proposedTerms === 'object' && primaryCollaboration.proposedTerms !== null && !Array.isArray(primaryCollaboration.proposedTerms)
                ? { proposedTerms: primaryCollaboration.proposedTerms as Record<string, unknown> }
                : {}),
            },
          }
          : {}),
        ...(flowId !== undefined ? { flowId } : {}),
        ...(flowParams !== undefined ? { flowParams } : {}),
        ...(serviceTarget !== undefined ? { serviceTarget } : {}),
      },
      ...(fallback !== undefined ? { fallback } : {}),
      ...(escalationCondition !== undefined ? { escalationCondition } : {}),
    },
    explanation: {
      summary,
      factors,
      ...(tradeoffs !== undefined ? { tradeoffs } : {}),
      ...(alternativesConsidered.length > 0 ? { alternativesConsidered } : {}),
    },
    collaboration: {
      // R6-E-F07: consume_service IS a collaboration (locked-target), so the
      // derived flag covers both collaboration-initiating actions.
      needed: action === 'initiate_ac' || action === 'consume_service',
      ...(partnerType !== undefined ? { partnerType } : {}),
      ...(collabReasoning !== undefined ? { reasoning: collabReasoning } : {}),
    },
    uncertainty: {
      overall,
      ...(dataQuality !== undefined ? { dataQuality } : {}),
      ...(riskFactors.length > 0 ? { riskFactors } : {}),
    },
  };
}

// ============================================================================
// F0-2: schema-checked parse (guided-decoding backstop)
// ============================================================================

/**
 * Strict variant of parseCognitiveDecision for lanes that REQUESTED guided
 * JSON decoding (ChatParams.format = COGNITIVE_DECISION_SCHEMA with
 * LLM_GUIDED_JSON on): the decoding layer promises schema-conformant output,
 * so a raw payload violating decision-v1 is a FORMAT failure, not something
 * to silently repair — it is rejected (null + `onReject` with the ajv
 * violations) and the caller degrades to the legacy binary/prose ladder.
 *
 * Contrast with the tolerant parser: a missing-`situation` answer passes
 * parseCognitiveDecision with defaults filled (silent pass); here it is
 * rejected. Use the tolerant parser when guided JSON is off
 * (LLM_GUIDED_JSON=0) — legacy providers/fine-tunes answering snake_case
 * aliases or partial blocks keep working there.
 *
 * Pure: no IO — violations are reported through the `onReject` callback.
 */
export function parseCognitiveDecisionV1Checked(
  text: string,
  onReject?: (errors: string[]) => void,
): CognitiveDecision | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const jsonSpan = extractJSONObject(text.trim());
  if (jsonSpan === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSpan);
  } catch {
    return null;
  }

  const validation = validateDecisionV1(parsed);
  if (!validation.valid) {
    onReject?.(validation.errors);
    return null;
  }
  // A schema-valid payload always parses — the required decision-critical
  // segment (actionPlan.primary.action, enum-constrained) is present.
  return parseCognitiveDecision(text);
}

/**
 * Lane entry point for live decision lanes (assessor big-model, NL
 * command/ask): guided JSON on (LLM_GUIDED_JSON, the default) → the
 * decision-v1 checked parse (schema violations reject loudly); guided off →
 * the tolerant parser, so legacy providers/fine-tunes answering snake_case
 * aliases or partial blocks keep working on the unconstrained wire.
 *
 * NOTE: this one helper reads process.env (via isGuidedJsonEnabled) — the
 * module's only configuration read; everything else stays a pure contract.
 */
export function parseCognitiveDecisionForLane(
  text: string,
  onReject?: (errors: string[]) => void,
): CognitiveDecision | null {
  return isGuidedJsonEnabled()
    ? parseCognitiveDecisionV1Checked(text, onReject)
    : parseCognitiveDecision(text);
}

// ============================================================================
// Backward compatibility (design §11.2 — legacy fields are DERIVED)
// ============================================================================

/** Map a cognitive action onto the canonical legacy decision vocabulary. */
export function cognitiveActionToLegacyDecision(
  action: CognitivePrimaryAction,
): 'handle_independently' | 'initiate_ac' | 'defer' {
  switch (action) {
    case 'initiate_ac':
    case 'consume_service':
      // R6-E-F07: consume_service needs a collaboration handshake (locked to
      // the target service's provider), so the legacy word is initiate_ac.
      return 'initiate_ac';
    case 'defer':
    case 'escalate':
      // escalate maps to defer for now — the legacy vocabulary has no
      // escalate word (Phase 1 scope; decisionVocabulary gains it later).
      return 'defer';
    case 'handle_independently':
    case 'wait':
    case 'invoke_flow':
      return 'handle_independently';
  }
}

/**
 * Derive the legacy {decision, reasoning} pair every existing consumer
 * (DualTriggerACManager, EngineRuntime.recordDecision, TrajectoryRecorder,
 * CLI/OpenAPI/Web snapshots) keeps reading. `reasoning` prefers the
 * explanation summary (the human-readable twin), falling back to the primary
 * lane's own reasoning.
 */
export function deriveLegacyDecision(cd: CognitiveDecision): {
  decision: 'handle_independently' | 'initiate_ac' | 'defer';
  reasoning: string;
} {
  return {
    decision: cognitiveActionToLegacyDecision(cd.actionPlan.primary.action),
    reasoning: cd.explanation.summary || cd.actionPlan.primary.reasoning,
  };
}
