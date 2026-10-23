/**
 * decision-schema — F0-2 (docs/plan-r84-verification-framework.md Wave F0-2):
 * the six-block agent decision contract as a VERSIONED JSON Schema document
 * plus its validator.
 *
 * `schemas/decision-v1.json` is the SINGLE source of truth:
 *   - `DECISION_V1_WIRE_SCHEMA` (meta keywords stripped) is what
 *     `COGNITIVE_DECISION_SCHEMA` re-exports for constrained decoding — the
 *     exact schema handed to vLLM guided JSON (`response_format:
 *     {type:'json_schema', ...}`);
 *   - `validateDecisionV1` is the server-side backstop: when guided decoding
 *     was requested, a response violating the schema means the backend broke
 *     the decoding-layer promise, so the checked parser
 *     (`parseCognitiveDecisionV1Checked`) REJECTS it onto the legacy
 *     degradation ladder instead of silently repairing it;
 *   - the rule-fallback lanes (nl-orchestrator's deterministic decision
 *     builders) validate their constructed output against the same schema,
 *     so downstream consumers ALWAYS see a legal shape.
 *
 * ajv is already a core dependency (requirement/JSONSchemaValidator); the
 * document's `version` keyword needs strictSchema off (non-standard keyword,
 * carried for human/tooling readability — never sent to the backend).
 */

import Ajv from 'ajv';
import decisionV1Document from './schemas/decision-v1.json';

/** Version marker of the active decision schema document (file name twin). */
export const DECISION_SCHEMA_VERSION = 'v1' as const;

/**
 * Meta keywords that document the schema FILE but must not ride the wire:
 * vLLM's guided-decoding backends (xgrammar/outlines) compile the schema they
 * receive; keeping the wire copy to pure validation keywords avoids depending
 * on a backend's tolerance for $-keywords.
 */
const DOCUMENT_META_KEYS = new Set(['$schema', '$id', 'title', 'version', 'description']);

/**
 * The wire copy of decision-v1 — what COGNITIVE_DECISION_SCHEMA re-exports
 * and what reaches `response_format.json_schema.schema`.
 */
export const DECISION_V1_WIRE_SCHEMA: Record<string, unknown> = Object.fromEntries(
  Object.entries(decisionV1Document).filter(([key]) => !DOCUMENT_META_KEYS.has(key)),
);

const ajv = new Ajv({ allErrors: true, strictSchema: false });
const validateFn = ajv.compile(decisionV1Document);

export interface DecisionV1Validation {
  valid: boolean;
  /**
   * Human-readable violations, e.g.
   * "decision-v1: must have required property 'situation'" — empty when valid.
   */
  errors: string[];
}

/**
 * Validate a raw decision payload (the parsed JSON object, BEFORE the
 * tolerant field-by-field repair) against decision-v1. Pure: no IO, no throw.
 */
export function validateDecisionV1(payload: unknown): DecisionV1Validation {
  if (validateFn(payload) === true) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validateFn.errors ?? []).map(issue => {
      // ajv's additionalProperties error does not name the offending key in
      // `message` — surface it from params so violations are actionable.
      const extra = issue.keyword === 'additionalProperties'
        && typeof (issue.params as { additionalProperty?: unknown }).additionalProperty === 'string'
        ? ` ('${(issue.params as { additionalProperty: string }).additionalProperty}')`
        : '';
      return `decision-v1${issue.instancePath !== '' ? ` ${issue.instancePath}` : ''}: ${issue.message ?? 'invalid'}${extra}`;
    }),
  };
}
