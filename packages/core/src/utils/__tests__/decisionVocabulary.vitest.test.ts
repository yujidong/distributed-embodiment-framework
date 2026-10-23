/**
 * T-041 (R11 corrective) — canonical LLM-decision vocabulary.
 *
 * ONE alias table governs what counts as handle_independently /
 * initiate_ac / defer / ignore for the structured JSON parser, the prose
 * FSM fallback and the triage parser. These tests pin the vocabulary
 * itself (any casing/punctuation variant) and the prose scanner's
 * prefix/negation/markup rules.
 */

import { describe, it, expect } from 'vitest';
import {
  DECISION_ALIASES,
  MAX_DECISION_ALIAS_TOKENS,
  canonicalizeLLMDecision,
  extractDecisionFromProse,
  normalizeDecisionPhrase,
} from '../decisionVocabulary.js';

describe('decisionVocabulary — canonicalizeLLMDecision', () => {
  it('maps ≥6 handle_independently spellings (incl. casing/punctuation variants)', () => {
    for (const answer of [
      'independent',
      'INDEPENDENT',
      'independently',
      'act-independently',
      'act_independently',
      'Handle-It-Myself',
      'handle it myself',
      'HANDLE IT MYSELF',
      'do-it-myself',
      'self-handle',
      'by myself',
      'on my own',
      'solo',
      'no', // answer to the yes/no form of the prompt question
    ]) {
      expect(canonicalizeLLMDecision(answer)).toBe('handle_independently');
    }
  });

  it('maps ≥6 collaborate spellings', () => {
    for (const answer of [
      'collaborate',
      'Collaborate',
      'collaboration',
      'cooperate',
      'co-operation',
      'work-together',
      'work with others',
      'partner',
      'team up',
      'initiate ac',
      'AC',
      'yes',
    ]) {
      expect(canonicalizeLLMDecision(answer)).toBe('initiate_ac');
    }
  });

  it('maps ≥6 defer spellings', () => {
    for (const answer of [
      'defer',
      'DEFER',
      'deferred',
      'escalate',
      'escalation',
      'need-help',
      'need help',
      'wait and see',
      'not now',
      'hand off',
    ]) {
      expect(canonicalizeLLMDecision(answer)).toBe('defer');
    }
  });

  it('maps ≥6 ignore spellings', () => {
    for (const answer of [
      'ignore',
      'Ignore',
      'ignored',
      'skip',
      'skipping',
      'disregard',
      'not-mine',
      'not my responsibility',
      'out of scope',
    ]) {
      expect(canonicalizeLLMDecision(answer)).toBe('ignore');
    }
  });

  it('returns null for unknown/empty phrases', () => {
    expect(canonicalizeLLMDecision('maybe')).toBeNull();
    expect(canonicalizeLLMDecision('')).toBeNull();
    expect(canonicalizeLLMDecision('   ')).toBeNull();
    // @ts-expect-error runtime guard against non-strings
    expect(canonicalizeLLMDecision(42)).toBeNull();
  });

  it('the table itself cannot drift into ambiguity', () => {
    // No alias may normalize to TWO different canonical decisions (the
    // module throws at import time on that). Same-decision duplicates
    // (e.g. 'hand off' vs 'handoff') are benign.
    const seen = new Map<string, string>();
    for (const [canonical, aliases] of Object.entries(DECISION_ALIASES)) {
      for (const alias of aliases) {
        const key = normalizeDecisionPhrase(alias);
        const existing = seen.get(key);
        expect(existing === undefined || existing === canonical,
          `alias "${alias}" maps to both "${existing}" and "${canonical}"`).toBe(true);
        seen.set(key, canonical);
      }
    }
    expect(seen.size).toBeGreaterThan(40);
    // The FSM's n-gram width covers the longest phrase.
    expect(MAX_DECISION_ALIAS_TOKENS).toBeGreaterThanOrEqual(4);
  });
});

describe('decisionVocabulary — extractDecisionFromProse', () => {
  it('finds the first decisive phrase after a DECISION: prefix (prose path)', () => {
    expect(extractDecisionFromProse('DECISION: independent\nMy HVAC covers this.')).toBe('handle_independently');
    expect(extractDecisionFromProse('Decision: handle-it-myself\nbecause I can')).toBe('handle_independently');
    expect(extractDecisionFromProse('DECISION: cooperate\npartner up')).toBe('initiate_ac');
  });

  it('finds aliases in structured-ish JSON leftovers and markdown', () => {
    expect(extractDecisionFromProse('**INDEPENDENT** — I will act alone.')).toBe('handle_independently');
    expect(extractDecisionFromProse('Sure! I would say "work-together".')).toBe('initiate_ac');
  });

  it('skips <think> reasoning blocks (qwen-style) before the answer', () => {
    const text = '<think>the event mentions collaboration but let me reason... temperature fine</think>\nindependent';
    expect(extractDecisionFromProse(text)).toBe('handle_independently');
  });

  it('does not match decisive phrases inside negations', () => {
    // "cannot handle it myself" is NOT an independent answer; the scanner
    // keeps looking and finds the honest answer afterwards.
    expect(extractDecisionFromProse('I cannot handle it myself — escalate this'))
      .toBe('defer');
    expect(extractDecisionFromProse('not able to collaborate, sorry')).toBeNull();
  });

  it('multi-word aliases win over their shorter prefixes', () => {
    expect(extractDecisionFromProse('no need for collaboration')).toBe('handle_independently');
    expect(extractDecisionFromProse('no need to collaborate, I got this')).toBe('handle_independently');
  });

  it('returns null when nothing decisive exists', () => {
    expect(extractDecisionFromProse('the weather is nice today')).toBeNull();
    expect(extractDecisionFromProse('')).toBeNull();
  });

  it('earliest phrase wins between competing vocabularies', () => {
    // Old triage-parser parity: earliest decisive word decides.
    expect(extractDecisionFromProse('I will collaborate, not stay independent')).toBe('initiate_ac');
    expect(extractDecisionFromProse('INDEPENDENT — no collaboration needed')).toBe('handle_independently');
  });
});
