/**
 * Decision-Making Types for Autonomous Agent Behavior
 *
 * This module defines types for autonomous decision-making,
 * situation assessment, and collaboration initiation.
 */

import type { SystemEvent } from '@active-collaboration/shared';

/**
 * Situation assessment result from evaluating an event
 */
export interface SituationAssessment {
  /** The event being assessed */
  event: SystemEvent;

  /** Analysis of what the event means */
  eventAnalysis: EventAnalysis;

  /** Agent's own capabilities relevant to this event */
  ownCapabilities: CapabilityAssessment;

  /** Whether collaboration is needed */
  needsCollaboration: boolean;

  /** Required services/capabilities if collaboration is needed */
  requiredServices: ServiceRequirement[];

  /** Confidence in this assessment (0-1) */
  confidence: number;

  /** Reasoning for the assessment */
  reasoning: string;
}

/**
 * Analysis of an event
 */
export interface EventAnalysis {
  /** Event type classification */
  eventType: string;

  /** Event severity (low, medium, high, critical) */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /** Event urgency (0-1) */
  urgency: number;

  /** What the event requires to be handled */
  requirements: string[];

  /** Context from the event payload */
  context: Record<string, any>;

  /** Potential impact if not handled */
  potentialImpact: string;
}

/**
 * Assessment of agent's own capabilities
 */
export interface CapabilityAssessment {
  /** Capabilities the agent has */
  availableCapabilities: string[];

  /** Capabilities relevant to the current event */
  relevantCapabilities: string[];

  /** Capabilities the agent lacks */
  missingCapabilities: string[];

  /** Whether agent can handle the event alone */
  canHandleAlone: boolean;

  /** Quality of handling if done alone (0-1) */
  handlingQuality: number;
}

/**
 * Required service for collaboration
 */
export interface ServiceRequirement {
  /** Service/capability name required */
  serviceName: string;

  /** Why this service is required */
  reason: string;

  /** Priority (high, medium, low) */
  priority: 'high' | 'medium' | 'low';

  /** Required parameters for this service */
  requiredParams?: Record<string, any>;

  /** Estimated duration needed */
  estimatedDuration?: number; // in milliseconds

  /** Alternative services that could also work */
  alternatives?: string[];
}

/**
 * Result from autonomous decision process
 */
export interface DecisionResult {
  /** The decision made */
  decision: 'collaborate' | 'handle_independently' | 'defer' | 'ignore';

  /** Situation assessment that led to this decision */
  assessment: SituationAssessment;

  /** Selected collaboration partners (if collaborate) */
  selectedPartners?: CollaborationPartner[];

  /** Reasoning for the decision */
  reasoning: string;

  /** Confidence in this decision (0-1) */
  confidence: number;

  /** Next actions to take */
  nextActions: string[];
}

/**
 * Selected collaboration partner
 */
export interface CollaborationPartner {
  /** Partner agent ID */
  agentId: string;

  /** Services they provide that are needed */
  services: string[];

  /** Why this partner was selected */
  selectionReason: string;

  /** Estimated cost of collaboration */
  estimatedCost?: number;

  /** Negotiation strategy to use */
  negotiationStrategy?: 'sequential' | 'parallel' | 'auction';
}

/**
 * Configuration for AutonomousDecisionEngine
 */
export interface DecisionEngineConfig {
  /** Whether autonomous decision-making is enabled */
  enabled: boolean;

  /** Confidence threshold for making decisions (0-1) */
  confidenceThreshold: number;

  /** Maximum time to spend on LLM reasoning (ms) */
  maxLLMReasoningTime: number;

  /** Whether to use structured rules before LLM */
  useStructuredRules: boolean;

  /** Maximum number of collaboration partners to consider */
  maxPartners: number;

  /** Cost sensitivity (0=ignore cost, 1=highly cost-sensitive) */
  costSensitivity: number;

  /** Quality sensitivity (0=ignore quality, 1=highly quality-focused) */
  qualitySensitivity: number;

  /** Cost control: Disable automatic LLM processing from events.
   * When false, LLM is ONLY called through explicit task requests.
   * Default: false
   */
  enableAutoLLMProcessing?: boolean;
}

/**
 * Rule for determining severity based on payload field values
 */
export interface SeverityRule {
  /** The payload field to check (supports dot notation for nested fields) */
  field: string;
  /** Comparison operator */
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  /** Value to compare against */
  value: number | string | boolean;
  /** Severity to assign if the rule matches */
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Event pattern for structured decision rules
 */
export interface EventPattern {
  /** Event type pattern (supports wildcards) */
  eventType: string;

  /** Required payload fields (supports dot notation for nested fields, e.g., 'stateChange.property') */
  requiredFields?: string[];

  /** Specific payload field values to match (supports dot notation for nested fields) */
  fieldValues?: Record<string, unknown>;

  /** Severity classification */
  severity?: 'low' | 'medium' | 'high' | 'critical';

  /** Rules for determining severity based on payload field values */
  severityRules?: SeverityRule[];

  /** Urgency score (0-1) */
  urgency?: number;

  /** Required capabilities to handle this event */
  requiredCapabilities?: string[];

  /** Whether this event type typically requires collaboration */
  typicallyRequiresCollaboration: boolean;

  /** Common collaboration partners for this event type */
  commonPartners?: string[];

  /** Reasoning pattern */
  reasoning?: string;
}
