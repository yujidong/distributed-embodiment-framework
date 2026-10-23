/**
 * LLM client preset → i18n key mappings, shared by the simulation-start
 * controls (WorldViewPage header). Keys live in the `world` namespace.
 */

import type { LlmClientPreset } from '../api/types';

export const LLM_OPTION_KEYS: Record<LlmClientPreset, string> = {
  none: 'llmOptionNone',
  auto: 'llmOptionAuto',
  llm: 'llmOptionLlm',
};

/** Short consequence note shown under the select for the chosen preset. */
export const LLM_HINT_KEYS: Record<LlmClientPreset, string> = {
  none: 'llmHintNone',
  auto: 'llmHintAuto',
  llm: 'llmHintLlm',
};
