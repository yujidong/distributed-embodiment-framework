/**
 * Agent Context Module
 *
 * Provides complete context building functionality for LLM decision-making
 */

export {
  AgentContextBuilder,
  createContextBuilder,
  type FullAgentContext,
  type AgentInfo,
  type DeviceStateInfo,
  type ServiceInfo,
  type PeerAgentInfo,
  type EnvironmentState,
} from './AgentContextBuilder.js';

export {
  EventContextNormalizer,
  normalizeEvent,
  getEventSeverity,
  isEventUrgent,
  type NormalizedEventContext,
  type NormalizationResult,
  type NormalizedSeverity,
  type NormalizedTrend,
} from './EventContextNormalizer.js';
