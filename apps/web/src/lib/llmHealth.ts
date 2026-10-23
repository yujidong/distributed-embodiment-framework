/**
 * LLM chip runtime health (R2-FEAT-10) — the console ControlBar LLM badge
 * used to reflect only the sim's DECLARED creation-time mode ('llm' /
 * 'rule-only'): a dead provider left it cheerfully reading「LLM: llm」.
 * The public /api/health decision posture (R74) knows the RUNTIME truth —
 * 'llm-unreachable' means the configured backend is not answering and every
 * decision is degrading to the rule harness.
 *
 * Pure derivation, unit-tested; the component owns the polling.
 */

import type { PublicHealth } from '../api/types';

export type LlmChipHealth = 'healthy' | 'down' | 'unknown';

/**
 * Chip health for a sim whose declared mode is `declared`, given the server
 * decision posture (null = health not polled yet / unreachable server —
 * render the declared chip, no opinion).
 */
export function llmChipHealth(
  declared: 'llm' | 'rule-only',
  posture: PublicHealth['decision']['mode'] | null,
): LlmChipHealth {
  if (posture === null) return 'unknown';
  // Only an LLM-mode sim on an unreachable backend is a contradiction worth
  // a loud chip; rule-only sims are unaffected by provider health, and a
  // rule-test server is already labeled by the declared chip.
  if (declared === 'llm' && posture === 'llm-unreachable') return 'down';
  return 'healthy';
}
