/**
 * Text Similarity Utilities for TF-IDF Baseline
 *
 * Implements character n-gram Jaccard similarity for short text comparison.
 * Used by the TF-IDF baseline condition to match event parameters with
 * agent/partner capabilities without LLM reasoning.
 *
 * Design choice: character n-grams (trigrams) are used instead of word-level
 * TF-IDF because IoT capability names are short (1-3 words), where word-level
 * approaches degenerate into exact match. Character n-grams capture subword
 * patterns that reflect partial semantic overlap:
 *   "cooling" vs "temperature-control" → moderate overlap ("coo", "ool")
 *   "temperature-monitoring" vs "temperature-control" → high overlap (false positive)
 *   "smoke" vs "fire-suppression" → low overlap (false negative)
 */

import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';

// ---------------------------------------------------------------------------
// Character n-gram Jaccard similarity
// ---------------------------------------------------------------------------

/**
 * Generate character n-grams from a normalized string.
 * Normalizes by lowercasing and collapsing whitespace.
 */
function charNgrams(text: string, n: number = 3): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const ngrams = new Set<string>();
  for (let i = 0; i <= normalized.length - n; i++) {
    ngrams.add(normalized.substring(i, i + n));
  }
  return ngrams;
}

/**
 * Compute Jaccard similarity between two strings using character n-grams.
 * Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Returns 0 if both strings are shorter than n characters.
 */
export function charNgramJaccard(text1: string, text2: string, n: number = 3): number {
  const ngrams1 = charNgrams(text1, n);
  const ngrams2 = charNgrams(text2, n);

  if (ngrams1.size === 0 && ngrams2.size === 0) return 0;

  let intersection = 0;
  for (const ng of ngrams1) {
    if (ngrams2.has(ng)) intersection++;
  }

  const union = ngrams1.size + ngrams2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Max similarity against a capability list
// ---------------------------------------------------------------------------

/**
 * Compute the maximum character n-gram Jaccard similarity between an event
 * text and a list of capabilities. Returns the highest similarity score
 * across all capabilities.
 */
export function maxSimilarity(eventText: string, capabilities: string[]): number {
  if (capabilities.length === 0) return 0;
  let max = 0;
  for (const cap of capabilities) {
    const sim = charNgramJaccard(eventText, cap);
    if (sim > max) max = sim;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Event text extraction
// ---------------------------------------------------------------------------

/**
 * Extract a text representation from a SpatialClusterSummary for similarity
 * matching. Combines event parameter, event type, and finding details into
 * a single string that captures the event's semantic content.
 */
export function extractEventText(clusterSummary: SpatialClusterSummary): string {
  const parts: string[] = [];

  for (const finding of clusterSummary.findings) {
    const eventType = (finding.eventType || '').toLowerCase();
    const details = finding.details as Record<string, unknown> | undefined;
    const parameter = (details?.parameter as string || '').toLowerCase();

    if (parameter) parts.push(parameter);
    if (eventType && !eventType.includes('environment')) {
      // Skip generic event types like ENVIRONMENT_PARAM_CHANGED
      parts.push(eventType);
    }
  }

  // Deduplicate and join
  const unique = [...new Set(parts)];
  return unique.join(' ');
}
