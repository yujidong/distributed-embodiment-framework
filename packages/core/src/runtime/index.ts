/**
 * Runtime Module — long-running engine core
 *
 * Public surface: `EngineRuntime` plus its option/snapshot/event types.
 * Build one from a `ScenarioDefinition` (see the scenario module), then
 * drive it with start/pause/resume/step, inject events, and consume
 * snapshots + the event stream.
 */

export {
  EngineRuntime,
  createSimulatedDevice,
  type EngineRuntimeOptions,
  type EngineRuntimeState,
  type FaultProfile,
  type InjectEventInput,
  type InjectEventOptions,
  type InjectEventResult,
  type InjectedEventRecord,
  type EngineSnapshot,
  type PhysicsLodTier,
  type RuntimeDecisionRecord,
  type RuntimeCollaborationRecord,
  type EngineEventListener,
  type RuntimeDevice,
  type DeviceFactory,
} from './EngineRuntime.js';

// Living-worlds P0 (design-living-worlds.md §9): checkpoint world state —
// the versioned payload EngineRuntime.exportWorldState()/restoreWorldState()
// move across the hibernate/resume boundary.
export {
  ENGINE_WORLD_STATE_VERSION,
  type EngineWorldStateExport,
  type WorldAgentStateExport,
  type WorldDeviceStateExport,
  type WorldZoneStateExport,
  // Per-function LLM routing (deployment-level model routes).
  type LlmFunctionClients,
  // T118 clock-injection seam (the tick loop's scheduler contract).
  type TickTimer,
} from './contract.js';

// Living-worlds P1 (design-living-worlds.md §8): due-moment computation —
// the lazy-advance contract. Pure functions live in shaping/due-moments.ts
// (re-exported through EngineRuntime's shaping barrel); peekNextDueMoment /
// advanceTo on EngineRuntime consume them.
export {
  PHYSICS_SUBSTEP_SEC,
  // BUG-04: the capability-name typing helper — exported so the simulation
  // parity suite can assert it reads the shared read-only predicate.
  capabilityNameToDeviceCapability,
  type AdvanceToOptions,
  type DueMoment,
  type DueMomentKind,
  type DueMomentSources,
} from './contract.js';
export {
  IDLE_PHYSICS_SUBSTEP_SEC,
  IDLE_CONDITION_EVAL_EVERY_TICKS,
  IDLE_ENV_BASELINE_EVERY_TICKS,
  PhysicsLodController,
  physicsSubstepCount,
} from './shaping/lod.js';
export {
  applyOccupantScheduleWrites,
  computeDueMoments,
  effectiveOccupantSchedule,
  nextDueMoment,
  nextOccupancyBoundary,
  nextPeriodicCrossing,
  overlayActiveAt,
  overlayTransitionKey,
  patchZoneOccupantSchedule,
  updateZoneOccupantSchedule,
  type OccupantScheduleOverlay,
  type OccupantSchedulePatchRuntime,
  type OccupantScheduleWithCount,
  type ZoneOccupancyTimetable,
} from './shaping/due-moments.js';
// T54 (R6 u4-F1): the standard zone-parameter set — the server's computation
// register warning keys its "two faces" advisory on it (a device metric path
// sharing a name with a zone parameter is the cross-face trap).
export { SNAPSHOT_PARAMETERS } from './shaping/world.js';
