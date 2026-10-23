/**
 * Reputation Module — service/agent reputation from collaboration history (P4-1)
 *
 * Public surface: `ReputationTracker` (per (agentId, capability) Bayesian
 * success-rate cells with recency decay), the pure scoring helpers
 * (`computeReputationScore`, `classifyCollaborationOutcome` — reused by the
 * server's read side), and the record/config/JSON types forming the
 * persistence seam.
 */

export {
  ReputationTracker,
  computeReputationScore,
  classifyCollaborationOutcome,
  integerizeReputationEvents,
  OUTCOME_WEIGHTS,
  DEFAULT_REPUTATION_CONFIG,
  type ReputationOutcome,
  type ReputationRecord,
  type ScoredReputation,
  type ReputationConfig,
  type ReputationTrackerJSON,
  type ReputationTrackerLoadJSON,
  type ReputationRecordLoad,
} from './ReputationTracker.js';
