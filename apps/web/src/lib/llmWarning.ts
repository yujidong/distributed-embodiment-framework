/**
 * llmWarning localization (R2-UX-05) — the sim registry's runtime-builder
 * emits the rule-only degradation notice as a hardcoded ENGLISH string
 * (apps/server/src/sim-registry/runtime-builder.ts, four templates), and the
 * LlmStatusBar used to render it verbatim as the banner's second line.
 *
 * The wire contract stays unchanged (CLI/API consumers read the same text);
 * the console maps each known template to a localized line. Matching keys on
 * STABLE substrings of the server templates — a server-side reword that no
 * longer contains the marker falls back to the raw text (pre-R2-UX-05
 * behavior), never to a wrong translation.
 *
 * Pure and i18n-aware: strings are read from the global i18next instance at
 * call time (same convention as lib/happeningNow.ts / lib/simStatus.ts).
 */

import i18n from '../i18n/config';

/** Known server templates → simView i18n keys, matched by stable substring. */
const WARNING_MARKERS: ReadonlyArray<{ marker: string; key: string }> = [
  {
    marker: 'LLM preset "llm" was requested',
    key: 'llmWarning.presetRequested',
  },
  {
    marker: 'LLM_BASE_URL is not configured on this server',
    key: 'llmWarning.notConfigured',
  },
  {
    marker: 'This environment has no agents',
    key: 'llmWarning.noAgents',
  },
  {
    marker: 'opts out of LLM decisions',
    key: 'llmWarning.optedOut',
  },
  {
    marker: 'no model is set',
    key: 'llmWarning.noModel',
  },
];

/** Localized degradation notice; the raw text when the template is unknown. */
export function localizedLlmWarning(warning: string): string {
  for (const { marker, key } of WARNING_MARKERS) {
    if (warning.includes(marker)) return i18n.t(`simView:${key}`);
  }
  return warning;
}
