/**
 * Qwen3 thinking suppression (chat_template_kwargs.enable_thinking).
 *
 * Qwen3-class models served by vLLM generate a <think> draft before the
 * answer; on the 27B the draft is the latency head of every decision call
 * (measured ~14.5s for a decision whose answer body is ~200 tokens), and the
 * platform strips think blocks client-side anyway (strip-think.ts). vLLM
 * honors `chat_template_kwargs: {enable_thinking: false}` by rendering the
 * prompt with the Qwen3 no-think template, suppressing the draft entirely.
 *
 * Scope: the STRUCTURED-OUTPUT decision lanes only (AC necessity decision,
 * proposal evaluation, triage) — their output is guided JSON, so the
 * thinking draft is pure waste there. Free-form lanes (NL intent, proposal
 * review, counter-offers) keep the default template.
 *
 * LLM_DISABLE_THINKING (default ON) is the A/B escape hatch: set
 * LLM_DISABLE_THINKING=0 (or 'false'/'off') to stop sending the kwarg.
 *
 * Applicability: `chat_template_kwargs` is a vLLM request extension. vLLM
 * tolerates unknown request fields, so non-Qwen models on vLLM are
 * unaffected; backends with strict request validation may reject it — in
 * that case set LLM_DISABLE_THINKING=0.
 */

/** Environment variable governing thinking suppression. */
export const DISABLE_THINKING_ENV = 'LLM_DISABLE_THINKING';

/**
 * Whether structured-output lanes suppress Qwen3 thinking. Default ON;
 * disabled by LLM_DISABLE_THINKING ∈ {'0', 'false', 'off'} (case-insensitive).
 */
export function isThinkingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DISABLE_THINKING_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

/**
 * The ChatParams.chatTemplateKwargs value for a structured-output call:
 * `{ enable_thinking: false }` while suppression is on, `undefined` when the
 * operator turned it off (the provider then omits the field entirely).
 */
export function noThinkingTemplateKwargs(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  return isThinkingDisabled(env) ? { enable_thinking: false } : undefined;
}
