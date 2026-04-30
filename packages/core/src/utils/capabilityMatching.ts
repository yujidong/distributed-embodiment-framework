/**
 * Shared Capability Matching Utility
 *
 * Single source of truth for semantic capability matching.
 * Used by both ground-truth-calculator.ts and ACNecessityAssessor.ts
 * to ensure consistent capability gap computation.
 */

// ---------------------------------------------------------------------------
// Synonym table
// ---------------------------------------------------------------------------

/**
 * Known capability equivalences. Two capabilities in the same group
 * are considered semantically equivalent.
 */
export const CAPABILITY_SYNONYMS: string[][] = [
  ['temperature-reading', 'temperature-monitoring'],
  ['humidity-reading', 'humidity-monitoring'],
  ['co2-reading', 'co2-monitoring'],
  ['hvac-control', 'temperature-control'],
  ['cooling', 'temperature-control'],
  ['heating', 'temperature-control'],
  ['air-quality-reading', 'air-quality-monitoring'],
  ['air-purification', 'air-quality-control'],
  ['motion-detection', 'presence-detection'],
  ['lighting-control', 'light-control'],
  ['fire-detection', 'fire-suppression'],
  ['emergency-alert', 'alarm'],
  ['water-leak-detection', 'water-shutoff'],
];

// ---------------------------------------------------------------------------
// Matching function
// ---------------------------------------------------------------------------

/**
 * Check if a single agent capability matches a single required capability.
 * Uses bidirectional case-insensitive substring matching + synonym table.
 */
export function capabilityMatches(agentCap: string, requiredCap: string): boolean {
  const a = agentCap.toLowerCase();
  const r = requiredCap.toLowerCase();

  // Exact match
  if (a === r) return true;

  // Bidirectional substring match
  if (a.includes(r) || r.includes(a)) return true;

  // Synonym table match
  for (const group of CAPABILITY_SYNONYMS) {
    const lowerGroup = group.map(s => s.toLowerCase());
    if (lowerGroup.includes(a) && lowerGroup.includes(r)) return true;
  }

  return false;
}

/**
 * Compute capability gap: required capabilities that the agent cannot match.
 * Returns both the gap (unmatched) and matched capabilities.
 */
export function computeCapabilityGap(
  agentCapabilities: string[],
  requiredCapabilities: string[],
): { gap: string[]; matched: string[] } {
  if (requiredCapabilities.length === 0) {
    return { gap: [], matched: [] };
  }

  const matched: string[] = [];
  const gap: string[] = [];

  for (const req of requiredCapabilities) {
    const isMatched = agentCapabilities.some(ac => capabilityMatches(ac, req));
    if (isMatched) {
      matched.push(req);
    } else {
      gap.push(req);
    }
  }

  return { gap, matched };
}

/**
 * Check if an agent has all required capabilities.
 */
export function hasAllCapabilities(
  agentCapabilities: string[],
  requiredCapabilities: string[],
): boolean {
  if (requiredCapabilities.length === 0) return true;
  return requiredCapabilities.every(req =>
    agentCapabilities.some(ac => capabilityMatches(ac, req)),
  );
}
