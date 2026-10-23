/**
 * Structured decision reasoning (R15-D3) — localize rule/precheck decisions
 * from their machine-readable code+params instead of pattern-matching the
 * English template sentences. LLM reasoning is free text: no code → the raw
 * string passes through unchanged.
 *
 * The code catalog lives in the `decisionReasoning` i18n namespace, keyed by
 * the codes ACNecessityAssessor's preCheck emits (precheck.*). An unknown
 * code (future server, older client) falls back to the raw text too.
 */

import i18n from '../i18n/config';

export interface ReasoningCarrier {
  reasoning?: string;
  reasoningCode?: string;
  reasoningParams?: Record<string, string | number>;
}

/** Localized reasoning, or the raw English string when no template applies. */
export function localizedReasoning(
  carrier: ReasoningCarrier | null | undefined,
): string | undefined {
  if (!carrier) return undefined;
  if (carrier.reasoningCode !== undefined) {
    const key = `decisionReasoning:${carrier.reasoningCode}`;
    if (i18n.exists(key)) {
      return i18n.t(key, carrier.reasoningParams ?? {}) as string;
    }
  }
  return carrier.reasoning;
}
