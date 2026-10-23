/**
 * Agent Role & Goal System
 *
 * This module provides intrinsic motivation and autonomous behavior for agents.
 */

// Types
export * from './types';

// Core Components
export { GoalManager } from './GoalManager';
export { IntrinsicMotivationEngine } from './IntrinsicMotivationEngine';
export { RoleContextManager } from './RoleContextManager';
export { AgentProfileFactory } from './AgentProfileFactory';

// Re-export commonly used types for convenience
export type {
  AgentGoal,
  AgentProfile,
  AgentTraits,
  RoleContext,
  SituationAssessment,
  ResourceInfo,
  Experience,
  MotivationLevel,
  ActionSuggestion,
  GoalEvent,
  GoalStats,
} from './types';

export {
  GoalType,
  GoalPriority,
  GoalStatus,
  AgentRoleType,
} from './types';

// Experiment data types
export type {
  ACTriggerCorrelation,
  ExperimentLogEntry,
} from './IntrinsicMotivationEngine';
