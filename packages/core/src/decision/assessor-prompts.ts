/**
 * Assessor prompt contracts (R21 file-budget ratchet; extracted from
 * ACNecessityAssessor.ts in Phase 1 of the cognitive architecture).
 *
 * Pure constants only — the answer instructions, the constrained-decoding
 * schemas and the generation-cap/sampling policy the assessor's decision
 * lanes use. No logic, no IO.
 *
 * Phase 1 (§14.1): the BIG model answers the full CognitiveDecisionSchema;
 * the BINARY contract survives on the triage (small model) lane only
 * (§11.3 — the fine-tuned decision model keeps the narrow question it was
 * trained on), and as the parse-fallback shape for providers that ignore
 * `format`.
 */

/**
 * Prose answer instruction used in the default system prompt.
 * Replaced by STRUCTURED_OUTPUT_INSTRUCTION when useStructuredOutput is on.
 */
export const PROSE_ANSWER_INSTRUCTION = `Answer COLLABORATE or INDEPENDENT on the first line.
Briefly explain on the next line.`;

/**
 * R45-P1: dispatcher role line for the decision prompt — rendered only for
 * AgentContext.decisionRole 'coordinator' (municipal/regional centers).
 * Even when the coordinator holds devices in the event zone, its job is to
 * dispatch the responsible zone's executors (and cross-zone support when
 * the local zone cannot cover), not to execute itself.
 */
export const COORDINATOR_ROLE_INSTRUCTION =
  '\nROLE: COORDINATOR → You dispatch. Even if you hold devices in the event zone, prefer initiating collaboration that mobilizes the responsible zone\'s executors (and cross-zone support when the local zone cannot cover) over handling it yourself.';

/**
 * Answer instruction appended (or swapped in) when useStructuredOutput is on.
 *
 * Phase 1 (cognitive architecture §11/§14.1): the BIG model is now asked for
 * the full CognitiveDecisionSchema — situation assessment, goal stack, action
 * plan (with optional deviceActions/collaboration/flowId), explanation,
 * collaboration judgment and uncertainty. The binary {decision, reasoning}
 * contract survives only on the triage (small model) lane and as a parse
 * fallback for providers that ignore `format`.
 */
export const STRUCTURED_OUTPUT_INSTRUCTION = `Answer with a single JSON object and nothing else (no markdown, no extra text):
{"situation": {"type": "normal"|"anomaly"|"emergency"|"opportunity", "severity": 1-5, "affectedZones": ["zone-ids"], "rootCauseHypothesis": "string", "confidence": 0.0-1.0},
 "goals": [{"goal": "string", "priority": 1-5, "deadline": "optional string"}],
 "actionPlan": {"primary": {"action": "handle_independently"|"initiate_ac"|"defer"|"escalate"|"wait"|"invoke_flow"|"consume_service", "reasoning": "string",
               "deviceActions": [{"deviceId": "your-own-device-id from MY_DEVICES", "command": "one of that device's commands", "params": {}}],
               "collaboration": {"partnerCapabilities": ["caps you need from partners"]},
               "serviceTarget": {"serviceName": "exact name from the SHORTLIST/CATALOG lines", "serviceId": "id when known", "terms": {}},
               "flowId": "id from INVOCABLE_FLOWS", "flowParams": {}},
              "fallback": {"action": "string", "reasoning": "string"},
              "escalationCondition": "string"},
 "explanation": {"summary": "one or two sentences", "factors": [{"name": "safety|comfort|energy|cost|reputation|opportunity", "weight": 0.0-1.0}], "tradeoffs": "string", "alternativesConsidered": ["string"]},
 "collaboration": {"needed": true|false, "partnerType": "string", "reasoning": "string"},
 "uncertainty": {"overall": 0.0-1.0, "dataQuality": 0.0-1.0, "riskFactors": ["string"]}}
Rules: "action" must be exactly one of the seven words. "initiate_ac" only when you cannot handle this alone and need OPEN matchmaking (you know the capabilities you lack, not who provides them). "consume_service" when you already know WHICH listed service you need — it locks the request to that service's provider; always pair it with "serviceTarget" naming a service from AVAILABLE_PARTNERS (never invent one). "deviceActions" only with handle_independently and only your OWN devices (when MY_DEVICES is listed, copy its exact deviceId and command values). "flowId" only from INVOCABLE_FLOWS. Keep every string under 40 words.`;

/**
 * The BINARY answer instruction (pre-Phase-1 contract) — kept verbatim for the
 * small-model triage lane (P4-2): the design keeps triage's question NARROW
 * ("is this normal?") so the fine-tuned 1.5B decision model keeps answering
 * the shape it was trained on; only the big model produces the full schema.
 */
export const BINARY_OUTPUT_INSTRUCTION = `Answer with a single JSON object and nothing else (no markdown, no extra text):
{"decision": "collaborate" | "independent", "reasoning": "<one or two sentences>"}
(Only those two decision words are requested; common aliases such as cooperate / work-together / handle-it-myself / do-it-myself / defer / escalate / ignore are also understood.)`;

/**
 * JSON schema for constrained decoding of the AC necessity decision,
 * passed to the LLM provider via ChatParams.format. Mechanism B: the
 * optional invokeFlow key (only meaningful when the prompt listed
 * invocable flows; the gate refuses anything not on the listing).
 *
 * Phase 1: this BINARY schema is now used ONLY by the triage lane; the big
 * model receives COGNITIVE_DECISION_SCHEMA (cognitive-decision.ts).
 */
export const AC_DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['collaborate', 'independent'] },
    reasoning: { type: 'string' },
    invokeFlow: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['flowId'],
    },
  },
  required: ['decision', 'reasoning'],
};

/**
 * R32-A3: num_predict/maxTokens for the BINARY (triage) decision call.
 * Outputs measure 46–63 tokens (JSON-constrained); 256 = 4x headroom.
 */
export const AC_DECISION_MAX_TOKENS = 256;

/**
 * Phase 1: generation cap for the full CognitiveDecision call. The design
 * (§11.3) budgets the structured output at 250–450 tokens — ~5–8x the binary
 * answer; R44 city measurements put completionTokens at p50 161–231 with the
 * only 2048-cap hit being a pathological runaway. 512 covers the whole
 * design budget (450) with headroom while capping the worst-case decode 2x
 * lower than the old 2048 — the generation cap bounds tail latency and
 * queue occupancy on the 27B initiator lane. NOTE: on thinking backends
 * without a server-side reasoning parser the <think> draft shares this
 * budget — deploy with --reasoning-parser (docs/deployment.md) so a long
 * draft cannot starve the answer. R5-F13: 512 proved too tight when a
 * non-thinking model moves its reasoning INTO the JSON payload (verbose
 * reasoning fields + pretty-printed JSON hit the cap and truncate →
 * jsonRate collapse); 1024 restores the jsonRate while still bounding
 * runaway decodes.
 */
export const COGNITIVE_DECISION_MAX_TOKENS = 1024;

/**
 * Phase 1 (§14.1 / R35 recommendation #2): decision endpoints sample at
 * temperature 0 — no sampling variance on the verdict path.
 */
export const DECISION_TEMPERATURE = 0;
