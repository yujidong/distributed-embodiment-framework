/**
 * F0-2 (docs/plan-r84-verification-framework.md Wave F0-2): guided JSON
 * decoding toggle.
 *
 * Decision lanes ask for constrained decoding by passing a JSON schema as
 * ChatParams.format; OpenAI-compatible providers (vLLM ≥ 0.5, incl. 0.23)
 * honor it via the OpenAI-style `response_format: {type:'json_schema',
 * json_schema:{...}}` request field, which vLLM maps onto its guided-decoding
 * backends (xgrammar/outlines — the served evolution of the older
 * `guided_json` extra field).
 *
 * LLM_GUIDED_JSON (default ON) is the operational escape hatch: set
 * LLM_GUIDED_JSON=0 (or 'false'/'off') to stop sending `response_format`
 * entirely when a backend rejects the field. Server-side schema validation
 * (decision-v1) remains as the backstop in that mode; the strict checked
 * parser keys off the same toggle, so legacy tolerant parsing is restored
 * together with the unconstrained wire.
 */

/** Environment variable governing guided JSON requests. */
export const GUIDED_JSON_ENV = 'LLM_GUIDED_JSON';

/**
 * Whether guided JSON (`response_format`) may be sent. Default ON; disabled
 * by LLM_GUIDED_JSON ∈ {'0', 'false', 'off'} (case-insensitive).
 */
export function isGuidedJsonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[GUIDED_JSON_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}
