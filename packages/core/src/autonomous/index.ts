/**
 * Autonomous Development Module
 *
 * Provides tools for autonomous code generation, validation, and deployment.
 */

// SandboxManager - Isolated code execution
export {
  SandboxManager,
  type SandboxConfig,
  type SandboxExecutionResult,
  type ExecutionHistoryEntry,
} from './SandboxManager.js';

// CodeValidator - Code validation
export {
  CodeValidator,
  type ValidationContext,
  type ValidationError,
  type ValidationWarning,
  type ValidationResult,
  type GeneratedTest,
} from './CodeValidator.js';

// PromotionPipeline - Code promotion workflow
export {
  PromotionPipeline,
  PromotionStage,
  type PromotionRequest,
  type StageTransition,
  type PromotionDecision,
} from './PromotionPipeline.js';

// ACTriggerMonitor - Automatic AC triggering
export {
  ACTriggerMonitor,
  SMART_CITY_AC_TRIGGERS,
  type ACTriggerCondition,
  type TriggeredAC,
} from './ACTriggerMonitor.js';

// TriggerEngine - Event-driven trigger evaluation
export {
  TriggerEngine,
  type TriggerContext,
  type TriggerEvent,
  type TriggerResult,
  type TriggerStats,
  type ActionExecutor,
} from './TriggerEngine.js';

// ThresholdMonitor - Threshold-based parameter monitoring
export {
  ThresholdMonitor,
  type MonitorStateLevel,
  type ThresholdCheckResult,
  type MonitorStats,
  type ThresholdActionExecutor,
} from './ThresholdMonitor.js';

// ScheduledTaskRunner - Scheduled task execution
export {
  ScheduledTaskRunner,
  type ScheduledTaskResult,
  type TaskStats,
  type TaskContext,
  type TaskExecutor,
  type ContextProvider,
} from './ScheduledTaskRunner.js';

