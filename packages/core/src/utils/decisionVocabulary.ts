/**
 * Canonical LLM decision vocabulary (T-041, R11 corrective).
 *
 * ONE alias table for mapping a model's free-form decision answer to the
 * canonical assessment decision enum (`ACNecessityAssessment['decision']`).
 * Both parsers of the AC necessity assessor (structured JSON + FSM keyword
 * fallback) AND the small-model triage parser route through this table —
 * a single truth, so the accepted vocabulary can never drift between paths
 * (standing lesson: duplicated dispatch logic always drifts).
 *
 * Casing, spacing, hyphens, underscores and punctuation are ignored:
 * "Handle-It-Myself", "handle_it_myself" and "HANDLE IT MYSELF" all map to
 * `handle_independently`.
 *
 * Semantics note: `defer` is the honest "I cannot/should not complete this
 * alone and the capability fork agrees" answer (defer/escalate/need-help),
 * while `ignore` is an explicit "not my responsibility" (ignore/skip/
 * not-mine). The binary prompt contract only ever asks
 * "collaborate | independent", so `yes`/`no` are accepted as answers to that
 * question and map onto collaborate/independent respectively.
 */

/** The canonical decision enum the assessor records. */
export type CanonicalLLMDecision =
  | 'handle_independently'
  | 'initiate_ac'
  | 'defer'
  | 'ignore';

/**
 * Accepted spellings per canonical decision. Keys are matched after
 * `normalizeDecisionPhrase` (lowercase, non-alphanumerics stripped), so any
 * casing/punctuation variant of these phrases maps identically.
 */
export const DECISION_ALIASES: Readonly<Record<CanonicalLLMDecision, readonly string[]>> = {
  handle_independently: [
    'independent',
    'independently',
    'handle independently',
    'handle it myself',
    'handle it alone',
    'handle alone',
    'do it myself',
    'act independently',
    'act alone',
    'self handle',
    'myself',
    'alone',
    'solo',
    'by myself',
    'on my own',
    // Answers to the yes/no form of the prompt question.
    'no',
    'no collaboration',
    'no need for collaboration',
    'no thanks',
  ],
  initiate_ac: [
    'collaborate',
    'collaboration',
    'collaboratively',
    'cooperate',
    'cooperation',
    'work together',
    'work with others',
    'partner',
    'partnership',
    'team up',
    'team',
    'ac',
    'initiate ac',
    'initiate collaboration',
    'active collaboration',
    // Answers to the yes/no form of the prompt question.
    'yes',
  ],
  defer: [
    'defer',
    'deferred',
    'defer it',
    'escalate',
    'escalation',
    'escalate it',
    'need help',
    'needs help',
    'wait',
    'wait and see',
    'later',
    'postpone',
    'not now',
    'not yet',
    'hand off',
    'handoff',
    'human review',
  ],
  ignore: [
    'ignore',
    'ignored',
    'skip',
    'skipping',
    'disregard',
    'not mine',
    'not my responsibility',
    'not my event',
    'not relevant',
    'irrelevant',
    'out of scope',
    'not applicable',
  ],
};

/** Longest alias phrase in tokens (drives the FSM's n-gram width). */
export const MAX_DECISION_ALIAS_TOKENS = Math.max(
  ...Object.values(DECISION_ALIASES).flat().map(phrase => phrase.split(/\s+/).length),
);

/** Normalize a decision phrase: lowercase + strip all non-alphanumerics. */
export function normalizeDecisionPhrase(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const DECISION_ALIAS_LOOKUP: ReadonlyMap<string, CanonicalLLMDecision> = (() => {
  const map = new Map<string, CanonicalLLMDecision>();
  for (const [canonical, aliases] of Object.entries(DECISION_ALIASES) as Array<
    [CanonicalLLMDecision, readonly string[]]
  >) {
    for (const alias of aliases) {
      const key = normalizeDecisionPhrase(alias);
      const existing = map.get(key);
      if (existing !== undefined && existing !== canonical) {
        // Guard against the table itself drifting into ambiguity.
        throw new Error(
          `[decisionVocabulary] alias "${alias}" maps to both "${existing}" and "${canonical}"`,
        );
      }
      map.set(key, canonical);
    }
  }
  return map;
})();

/**
 * Canonicalize one decision phrase (any casing/punctuation variant).
 * Returns null when the phrase is not in the vocabulary.
 */
export function canonicalizeLLMDecision(raw: string): CanonicalLLMDecision | null {
  if (typeof raw !== 'string') return null;
  const key = normalizeDecisionPhrase(raw);
  if (key.length === 0) return null;
  return DECISION_ALIAS_LOOKUP.get(key) ?? null;
}

/**
 * Canonicalize a phrase that may carry surrounding punctuation/whitespace
 * (a raw LLM token stream slice). Alias for `canonicalizeLLMDecision`
 * kept for readability at FSM call sites.
 */
export function canonicalPhrase(phrase: string): CanonicalLLMDecision | null {
  return canonicalizeLLMDecision(phrase);
}

// ---------------------------------------------------------------------------
// Prose scanner (the old assessor FSM, generalized over the alias table)
// ---------------------------------------------------------------------------

/**
 * Negation tokens: a decisive phrase whose first token is preceded by one of
 * these (within the previous 3 tokens — covers "not able to collaborate")
 * is NOT treated as an answer. The old FSM avoided negations by luck of its
 * substring check; this makes the rule explicit and shared.
 */
const NEGATOR_TOKENS = new Set([
  'not', 'cannot', 'cant', 'dont', 'wont', 'never', 'unable',
  'couldnt', 'wouldnt', 'shouldnt',
]);

/** Strip <think>…</think> reasoning blocks and any other XML-ish tags. */
function stripMarkupTags(text: string): string {
  return text
    .replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>/gi, ' ')
    .replace(/<think[^>]*>[\s\S]*$/i, ' ') // unclosed block → nothing decisive after
    .replace(/<[^>]*>/g, ' ');
}

/**
 * Try to match an alias phrase (longest first) starting at token `index`.
 * Returns the canonical decision, or null when no alias starts here (or the
 * match is negated — the caller keeps scanning).
 */
function matchPhraseAt(tokens: string[], index: number): CanonicalLLMDecision | null {
  for (let n = MAX_DECISION_ALIAS_TOKENS; n >= 1; n--) {
    if (index + n > tokens.length) continue;
    const phrase = normalizeDecisionPhrase(tokens.slice(index, index + n).join(' '));
    const canonical = DECISION_ALIAS_LOOKUP.get(phrase);
    if (canonical === undefined) continue;
    const negated = tokens
      .slice(Math.max(0, index - 3), index)
      .some(prev => NEGATOR_TOKENS.has(normalizeDecisionPhrase(prev)));
    if (negated) return null; // negated phrase — not an answer, keep scanning
    return canonical;
  }
  return null;
}

/**
 * Scan free-form LLM prose for the FIRST decisive decision phrase (any
 * casing/punctuation variant of the alias table), the way the assessor's
 * keyword FSM always did — but over the shared vocabulary, so the
 * structured JSON path, the prose fallback and the triage parser accept
 * exactly the same answers. "DECISION:"-style prefixes, think tags and
 * XML markup are skipped naturally (they are not aliases).
 *
 * Returns null when no decisive phrase exists — callers apply their own
 * safety-first default (the assessor: initiate_ac; triage: fall through
 * to the big model).
 */
export function extractDecisionFromProse(text: string): CanonicalLLMDecision | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const tokens = stripMarkupTags(text).split(/\s+/).filter(t => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const decision = matchPhraseAt(tokens, i);
    if (decision !== null) return decision;
  }
  return null;
}
