/**
 * assessor-derivations — pure code-based derivation helpers for
 * ACNecessityAssessor (arch-guard (a) extraction: the assessor file hit its
 * size ceiling after R2-UX-11; keep derivations here so the ceiling keeps
 * holding). No behavior change — moved verbatim.
 */

import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';

/**
 * Derive urgency from event significance and capability gap.
 * More missing capabilities + higher significance → higher urgency.
 */
export function deriveAssessmentUrgency(
  clusterSummary: SpatialClusterSummary,
  missingCapabilities: string[],
): 'low' | 'medium' | 'high' | 'urgent' {
  const sig = clusterSummary.significance;
  const gapSize = missingCapabilities.length;

  if (sig === 'urgent' || gapSize >= 3) return 'urgent';
  if (sig === 'high' || gapSize >= 2) return 'high';
  if (sig === 'medium' || gapSize >= 1) return 'medium';
  return 'low';
}
