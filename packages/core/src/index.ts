/**
 * Active Collaboration Core Package
 *
 * Core agent and environment center implementation
 */

// Event System
export * from './events/index.js';

// Environment Center Module
export * from './environment/index.js';

// Resource Layer (Bottom)
export * from './resource/index.js';

// Management Layer (Middle)
export * from './management/index.js';

// Service Layer (Top)
export * from './service/index.js';

// Agent Integration
export * from './agent/index.js';

// Configuration Module
export * from './config/index.js';

// Autonomous Module
export * from './autonomous/index.js';

// Trajectory Recording (agent-learning training data)
export * from './trajectory/index.js';

// Scenario Module (versioned scenario JSON schema + loader)
export * from './scenario/index.js';

// Utility Module (capability-matching primitives shared by engine + tooling)
export * from './utils/index.js';

// Capability vocabulary (BUG-04: the single read-only capability predicate —
// authoring oracle, capability typing, dispatch and prompt surfaces share it)
export * from './capabilities/read-only.js';

// Runtime Module (long-running engine core)
export * from './runtime/index.js';

// Reputation Module (service/agent reputation from collaboration history, P4-1)
export * from './reputation/index.js';

// Triage Module (small-model triage for AC decisions, P4-2)
export * from './triage/index.js';

// Prompt-injection sanitizer (S1 cross-tenant defense) — the canonical seam
// for untrusted text entering LLM prompts (decision, handshake, reviewer).
export * from './security/prompt-sanitizer.js';

// Storage primitives (Living-worlds P2 segmented append-only logs)
export * from './storage/index.js';

// Flows Module (user-orchestrated business flows)
export * from './flows/index.js';

// AC execution engine (P4-1: lets platform-side tooling drive real AC runs;
// class-only export to avoid the ACCollaborationConfig name collisions
// between execution, decision, and agent coordinator types)
export { ACExecutor } from './execution/ACExecutor.js';

// Natural-language interface (cognitive architecture Phase 3, value layer
// L1: parse → decide → execute → respond in plain language)
export * from './nl/index.js';

// R6-E-F15: private-experience cross-sim persistence — the cognition barrel
// stays internal (same discipline as the what-if lane above); only the
// versioned snapshot container crosses the package seam (the server's
// experience store + sim seams consume it).
export type { AgentExperienceJSON } from './cognition/meta.js';

// Predictive what-if (cognitive architecture Phase 4, §4.4): the simulation
// engine AS the world model. Targeted exports — the cognition barrel stays
// internal to core; only the prediction lane crosses the package seam (the
// server's /what-if route and the verify-before-act hook consume it).
export {
  WHAT_IF_ABSOLUTE_MAX_DURATION_SEC,
  WHAT_IF_DEFAULT_DURATION_SEC,
  WHAT_IF_MAX_DURATION_SEC,
  WHAT_IF_MAX_METRICS,
  UNMAPPED_WHAT_IF_EXAMPLES,
  WhatIfValidationError,
  describeIntervention,
  normalizeWhatIfScenario,
  parseWhatIfText,
  resolveDeviceMentions,
  runWhatIf,
  // T67 (R6): the shared temperature-equivalence vocabulary — the signing
  // gate's equivalence gate mirrors the parse lane's T2/T48 mapping with it.
  temperatureCommandRank,
  whatIfMaxDurationSecOf,
} from './cognition/predictor.js';
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
} from './cognition/predictor.js';
