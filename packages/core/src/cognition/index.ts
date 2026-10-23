/**
 * Cognition Module (cognitive architecture L1/L2, Phase 2 — DevLoop R38).
 *
 * The agent's unified world model (§3.1, single source per §14.2), the
 * per-round working memory (§3.4), the rule-based situation assessment
 * (§4.1), the prompt projection the assessor renders, and the context
 * projections that converge the three legacy context builders.
 */

// L1: world model (pure data structure + incremental write face)
export {
  AgentWorldModelStore,
  WORLD_MODEL_EVENT_RING_CAP,
  WORLD_MODEL_PROMPT_EVENT_CAP,
} from './world-model.js';
export type {
  AgentWorldModel,
  EnvironmentParamUpdate,
  WorldModelDevice,
  WorldModelEvent,
  WorldModelGoal,
  WorldModelZone,
} from './world-model.js';

// L1: world-model builder (pure) + goal projection
export {
  buildAgentWorldModel,
  deriveDeviceCommands,
  goalsFromAgentProfile,
} from './world-model-builder.js';
export type {
  WorldModelBuildInput,
  WorldModelDeviceInput,
  WorldModelGoalInput,
  WorldModelZoneInput,
} from './world-model-builder.js';

// L1: working memory (per cognitive round)
export { WorkingMemoryStore, WORKING_MEMORY_CHANGES_CAP, diffWorldModels } from './working-memory.js';
export type { PreviousCognitiveDecision, WorkingMemory } from './working-memory.js';

// L2: situation assessment (rules lane)
export {
  DEFAULT_PARAMETER_RANGES,
  SAFETY_PARAMETER_BOUNDS,
  assessSituation,
} from './situation-assessment.js';
export type { ParameterRange, SituationAssessment, SituationType } from './situation-assessment.js';

// Prompt bridge (world-model projection → assessor prompt)
export { renderCognitionPromptSections } from './prompt-context.js';
export type { AgentCognitionContext } from './prompt-context.js';

// Context projections (the three legacy builders → world model, §14.2)
export {
  buildAgentCognitionContext,
  enrichAgentDevices,
  environmentDevicesFace,
  zoneIdOfLocation,
} from './context-projection.js';
export type {
  BoundDeviceInfo,
  CognitionContextDeps,
  DeviceEnrichmentDeps,
  DeviceResourceLike,
  EnrichedResource,
  LiveDeviceLike,
  ListedDeviceLike,
  WorldModelZoneSource,
} from './context-projection.js';

// L2 prediction (§4.4, Phase 4): what-if over physics forks
export {
  WHAT_IF_ABSOLUTE_MAX_DURATION_SEC,
  WHAT_IF_DEFAULT_DURATION_SEC,
  WHAT_IF_MAX_DURATION_SEC,
  WHAT_IF_MAX_METRICS,
  WhatIfValidationError,
  describeIntervention,
  judgeWhatIf,
  metricKeyOf,
  normalizeWhatIfScenario,
  parseWhatIfText,
  runWhatIf,
  // T67 (R6): the shared temperature-equivalence vocabulary (the signing
  // gate mirrors the parse lane's T2/T48 mapping with it).
  temperatureCommandRank,
  whatIfMaxDurationSecOf,
} from './predictor.js';
export type {
  WhatIfContribution,
  WhatIfDeviceView,
  WhatIfIntervention,
  WhatIfMetric,
  WhatIfResult,
  WhatIfRunOptions,
  WhatIfScenario,
  WhatIfTextParse,
  WhatIfVerdict,
  WhatIfWorldSource,
} from './predictor.js';

// L5 Meta-cognition (§7, Phase 5): decision quality, capability boundary +
// escalation, partner trust, adaptive behavior, and the orchestrator.
export { DecisionQualityTracker, DECISION_QUALITY_RING_CAP } from './decision-quality.js';
export type {
  ActionOutcome,
  ConfidenceBucket,
  DecisionOutcome,
  DecisionQualityMetrics,
  DecisionQualityRecord,
} from './decision-quality.js';
export {
  ESCALATION_PRESSURE_THRESHOLDS,
  ESCALATION_SEVERE_LOW_CONFIDENCE,
  ESCALATION_VIEWER_RISK_FLOOR,
  SAFETY_CRITICAL_MARKERS,
  deriveCapabilityBoundary,
  isSafetyCriticalCapability,
  renderCapabilityBoundary,
  shouldEscalate,
} from './capability-boundary.js';
export type {
  BoundaryDeviceInput,
  CapabilityBoundary,
  CapabilityBoundaryInput,
  EscalationAuthority,
} from './capability-boundary.js';
export { TrustCalibrationStore, DEFAULT_TRUST_THRESHOLD, NEUTRAL_PLATFORM_REPUTATION } from './trust-calibration.js';
export type { PartnerTrust, TrustCalibrationOptions } from './trust-calibration.js';
export { computeAdaptiveBehavior, renderAdaptiveHints } from './adaptive-behavior.js';
export type {
  AdaptiveBehaviorOptions,
  AdaptiveBehaviorPolicy,
  BehaviorStrategy,
} from './adaptive-behavior.js';
export { MetaCognition, deriveIndependentOutcome, renderMetaCognitionPromptSections } from './meta.js';
export type {
  AgentExperienceJSON,
  DecisionObservation,
  MetaCognitionCheckpoint,
  MetaCognitionContext,
  MetaCognitionOptions,
} from './meta.js';
