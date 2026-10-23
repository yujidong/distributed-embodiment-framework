/**
 * Triage Decider (P4-2) — small-model first pass for AC necessity decisions.
 *
 * Given the SAME prompt the ACNecessityAssessor would send to the big model,
 * ask a cheap, fast model first (e.g. a fine-tuned 1.5B decision model).
 * The assessor's policy config decides what to do with the answer:
 *
 * - shadow:  the big model still decides; agreement is recorded only.
 * - enforce: a trusted 'independent' answer short-circuits the big-model
 *            call entirely; 'collaborate' always falls through so expensive
 *            decisions are confirmed by the big model.
 *
 * The decider itself is policy-free: it asks, parses, and reports. Parsing
 * accepts the structured JSON form ({"decision": ..., "reasoning": ...})
 * first, then falls back to the SHARED alias-table prose scanner
 * (utils/decisionVocabulary — the same vocabulary the assessor's parsers
 * accept, T-041). An unparseable/failed triage call returns null — the
 * caller then falls through to the big model (triage must never block a
 * decision).
 */

import { noThinkingTemplateKwargs, type LLMClient } from '@active-collaboration/llm-integration';
import { createLogger } from '@active-collaboration/shared';
import {
  canonicalizeLLMDecision,
  extractDecisionFromProse,
} from '../utils/decisionVocabulary.js';

const logger = createLogger('TriageDecider');

export interface TriageDecision {
  decision: 'collaborate' | 'independent';
  reasoning: string;
  /** Wall-clock latency of the triage call. */
  latencyMs: number;
  /** Raw triage model response text (for logging/trajectory). */
  rawResponse: string;
}

/** Map a canonical decision onto the triage binary, or null when the answer
 *  is not a trusted triage decision ('defer'/'ignore' answers fall through
 *  to the big model — only clear collaborate/independent vocabulary may
 *  short-circuit it). */
function triageBinary(canonical: ReturnType<typeof canonicalizeLLMDecision>):
  'collaborate' | 'independent' | null {
  if (canonical === 'initiate_ac') return 'collaborate';
  if (canonical === 'handle_independently') return 'independent';
  return null;
}

/**
 * Parse a triage response into a decision. Returns null when no decision
 * can be extracted (caller falls through to the big model).
 *
 * T-041: both paths (structured JSON and prose fallback) canonicalize
 * through the SHARED alias table (utils/decisionVocabulary) — the same
 * vocabulary the assessor's parsers accept — so a triage model answering
 * "handle it myself" or "cooperate" is understood identically here.
 */
export function parseTriageDecision(
  text: string,
): { decision: 'collaborate' | 'independent'; reasoning: string } | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Structured JSON path (handles markdown fences and surrounding prose).
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed: unknown = JSON.parse(trimmed.substring(firstBrace, lastBrace + 1));
      const decisionRaw = (parsed as Record<string, unknown>)?.decision;
      if (typeof decisionRaw === 'string') {
        const decision = triageBinary(canonicalizeLLMDecision(decisionRaw));
        if (decision !== null) {
          const reasoningRaw = (parsed as Record<string, unknown>).reasoning;
          return {
            decision,
            reasoning:
              typeof reasoningRaw === 'string' && reasoningRaw.trim().length > 0
                ? reasoningRaw.trim()
                : trimmed.substring(0, 150),
          };
        }
      }
    } catch {
      // Fall through to keyword scan
    }
  }

  // 2. Prose fallback: the SHARED alias-table scanner (first decisive
  //    phrase, negation-aware, think-tag skipping) — one vocabulary with
  //    the assessor's parsers.
  const decision = triageBinary(extractDecisionFromProse(trimmed));
  if (decision === null) return null;
  return { decision, reasoning: trimmed.substring(0, 150) };
}

export class TriageDecider {
  private readonly client: LLMClient;

  constructor(client: LLMClient) {
    this.client = client;
  }

  /**
   * Ask the cheap model for a decision. Returns null on ANY failure
   * (network, timeout, unparseable response) so the caller can fall through
   * to the big model — triage is an optimization, never a blocker.
   *
   * Phase 1 (§14.1): `options` pins the decision-lane sampling policy
   * (temperature 0, R32-A3-sized maxTokens) on the triage endpoint too.
   */
  async decide(
    systemPrompt: string,
    userPrompt: string,
    format?: 'json' | Record<string, unknown>,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<TriageDecision | null> {
    const start = Date.now();
    try {
      const response = await this.client.quickChat(
        userPrompt,
        systemPrompt,
        undefined,
        format,
        // Qwen3 thinking suppression: the triage answer is binary JSON —
        // the think draft is pure latency (LLM_DISABLE_THINKING=0 opts out).
        { ...options, chatTemplateKwargs: noThinkingTemplateKwargs() },
      );
      const latencyMs = Date.now() - start;
      const text = typeof response === 'string' ? response : response.content;
      const parsed = parseTriageDecision(text);
      if (!parsed) {
        logger.warn(`Triage response unparseable (first 80 chars): "${text.substring(0, 80)}"`);
        return null;
      }
      logger.info(`Triage decision: ${parsed.decision} in ${latencyMs}ms`);
      return { ...parsed, latencyMs, rawResponse: text };
    } catch (error) {
      logger.warn('Triage call failed, falling through to big model:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }
}
