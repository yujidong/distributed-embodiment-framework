/**
 * Per-function model routing (deployment-level).
 *
 * The platform historically serves every LLM call site from ONE backend
 * (LLM_BASE_URL + LLM_MODEL). Per-function routes let a deployment point
 * individual call-site classes at a different model — or a different vLLM
 * instance entirely — without touching scenario JSON:
 *
 *   LLM_DECISION_MODEL  AC necessity decisions + triage
 *   LLM_EVAL_MODEL      proposal-response evaluation
 *   LLM_NL_MODEL        NL intent parsing + proposal review
 *
 * A route value has two shapes:
 *   'ac-decision-v6'                          model on the main LLM_BASE_URL
 *   'ac-decision-v6@http://127.0.0.1:8001/v1' model on ANOTHER vLLM instance
 *
 * Every route is optional; an unset route falls back to LLM_MODEL (behavior
 * identical to the single-backend deployment).
 */

/** One parsed route: a model name, optionally pinned to its own base URL. */
export interface ModelRoute {
  model: string;
  /** Route-specific backend; absent = the main LLM_BASE_URL. */
  baseURL?: string;
}

/**
 * The deployment's per-function route table. All slots optional — an absent
 * slot means "use the shared client / LLM_MODEL", the pre-routing behavior.
 */
export interface LlmModelRoutes {
  /** AC necessity decisions (initiator lane) + small-model triage. */
  decision?: ModelRoute;
  /** Proposal-response evaluation (responder lane). */
  eval?: ModelRoute;
  /** NL intent parsing + LLM proposal review. */
  nl?: ModelRoute;
}

/**
 * Parse a route value. Returns null on ANY malformation (empty model, model
 * containing whitespace, a '@' whose right side is not a valid http(s) URL)
 * so config validation can report every bad knob at boot.
 */
export function parseModelRoute(raw: string): ModelRoute | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const at = trimmed.indexOf('@');
  if (at === -1) {
    if (/\s/.test(trimmed)) return null;
    return { model: trimmed };
  }
  const model = trimmed.slice(0, at).trim();
  const baseURL = trimmed.slice(at + 1).trim();
  if (model.length === 0 || /\s/.test(model) || baseURL.length === 0) return null;
  try {
    const parsed = new URL(baseURL);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { model, baseURL };
}

/** The canonical string form of a route (health/config echo). */
export function formatModelRoute(route: ModelRoute): string {
  return route.baseURL !== undefined ? `${route.model}@${route.baseURL}` : route.model;
}
