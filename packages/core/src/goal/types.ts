/**
 * Agent Role & Goal System Types
 *
 * This module provides intrinsic motivation and autonomous behavior for agents.
 * Instead of just reacting to external events, agents have internal goals
 * that guide their behavior and decision-making.
 */

// --------------------------------------------
// GOAL TYPES
// --------------------------------------------

/**
 * Types of goals an agent can have
 */
export enum GoalType {
  /** Maintain a certain state (e.g., temperature in range) */
  MAINTENANCE = 'maintenance',

  /** Achieve a specific outcome (e.g., complete a task) */
  ACHIEVEMENT = 'achievement',

  /** Protect from negative outcomes (e.g., prevent overheating) */
  PROTECTION = 'protection',

  /** Acquire new information or capability */
  EXPLORATION = 'exploration',

  /** Collaborate with other agents */
  COLLABORATION = 'collaboration',
}

/**
 * Priority levels for goals
 */
export enum GoalPriority {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

/**
 * Status of a goal
 */
export enum GoalStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  IN_PROGRESS = 'in_progress',
  ACHIEVED = 'achieved',
  FAILED = 'failed',
  SUSPENDED = 'suspended',
}

/**
 * Defines a specific goal that agent wants to achieve
 */
export interface AgentGoal {
  /** Unique identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** Type of goal */
  type: GoalType;

  /** Priority level */
  priority: GoalPriority;

  /** Measurable target (optional) */
  target?: {
    property: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'range';
    value: number | string | boolean | { min: number; max: number };
  };

  /** Progress metrics */
  metrics?: {
    current?: number;
    target?: number;
    unit?: string;
    deadline?: Date;
    lastUpdated?: Date;
  };

  /** Current status */
  status: GoalStatus;

  /** Other goals this depends on */
  dependencies?: string[];

  /** Sub-goals */
  subGoals?: AgentGoal[];

  /** Context-specific constraints */
  constraints?: Record<string, any>;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

// --------------------------------------------
// AGENT ROLE TYPES
// --------------------------------------------

/**
 * Predefined agent roles
 */
export enum AgentRoleType {
  /** Monitors and maintains environmental parameters */
  ENVIRONMENT_MONITOR = 'environment-monitor',

  /** Controls HVAC, lighting, etc. */
  CLIMATE_CONTROLLER = 'climate-controller',

  /** Handles security sensors and alerts */
  SECURITY_GUARD = 'security-guard',

  /** Coordinates multiple agents */
  COORDINATOR = 'coordinator',

  /** Optimizes energy usage */
  ENERGY_OPTIMIZER = 'energy-optimizer',

  /** General purpose agent */
  GENERAL = 'general',
}

/**
 * Behavioral traits that affect decision-making
 */
export interface AgentTraits {
  /** How cautious the agent is (0-1, higher = more conservative) */
  cautiousness?: number;

  /** How proactive the agent is (0-1, higher = more proactive) */
  proactivity?: number;

  /** Social preference (0 = loner, 1 = collaborative) */
  socialPreference?: number;

  /** Areas of expertise */
  expertise?: string[];

  /** Types of agents this agent prefers to work with */
  preferredPartners?: string[];

  /** Risk tolerance (0-1, higher = more risk-tolerant) */
  riskTolerance?: number;

  /** Learning rate (0-1, higher = faster adaptation) */
  learningRate?: number;
}

/**
 * Defines who the agent is and what its role is
 */
export interface AgentProfile {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Role type */
  role: AgentRoleType;

  /** Role description */
  description: string;

  /** Capabilities this agent has */
  capabilities: string[];

  /** Primary goals - what this agent intrinsically wants to achieve */
  primaryGoals: AgentGoal[];

  /** Secondary goals - optional supporting objectives */
  secondaryGoals?: AgentGoal[];

  /** Behavioral traits */
  traits?: AgentTraits;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

// --------------------------------------------
// CONTEXT TYPES
// --------------------------------------------

/**
 * Situation assessment for context awareness
 */
export interface SituationAssessment {
  /** Urgency level */
  urgency: 'low' | 'medium' | 'high' | 'critical';

  /** Complexity of the situation */
  complexity: 'simple' | 'moderate' | 'complex';

  /** Risk level */
  riskLevel: 'low' | 'medium' | 'high';

  /** Opportunity for collaboration */
  collaborationOpportunity?: 'none' | 'low' | 'medium' | 'high';

  /** Key factors affecting the situation */
  keyFactors?: string[];

  /** Recommended actions (optional) */
  recommendedActions?: string[];
}

/**
 * Resource availability
 */
export interface ResourceInfo {
  /** Resource ID */
  id: string;

  /** Resource type */
  type: 'device' | 'service' | 'agent' | 'external';

  /** Whether the resource is available */
  available: boolean;

  /** Resource capabilities */
  capabilities?: string[];

  /** Resource location (if applicable) */
  location?: { x: number; y: number; z: number };
}

/**
 * Past experience record
 */
export interface Experience {
  /** When it happened */
  timestamp: Date;

  /** What type of event/action */
  type: string;

  /** What was the context */
  context: Record<string, any>;

  /** What action was taken */
  action: string;

  /** What was the outcome */
  outcome: 'success' | 'failure' | 'partial';

  /** What was learned */
  lesson?: string;
}

/**
 * Maintains agent's understanding of its role and current situation
 */
export interface RoleContext {
  /** Role information */
  role: AgentRoleType;

  /** Agent profile */
  profile: AgentProfile;

  /** Current situation assessment */
  situationAssessment?: SituationAssessment;

  /** Available resources */
  availableResources: ResourceInfo[];

  /** Known capabilities of other agents */
  knownCapabilities: string[];

  /** Current active goals */
  activeGoals: AgentGoal[];

  /** Historical context */
  pastExperiences: Experience[];

  /** Last update timestamp */
  lastUpdated: Date;
}

// --------------------------------------------
// MOTIVATION TYPES
// --------------------------------------------

/**
 * Motivation level assessment
 */
export interface MotivationLevel {
  /** Overall motivation score (0-1) */
  overall: number;

  /** Urgency to act (0-1) */
  urgency: number;

  /** Confidence in action (0-1) */
  confidence: number;

  /** Whether agent should act now */
  shouldAct: boolean;

  /** Reason for motivation level */
  reason: string;
}

/**
 * Action suggestion from motivation engine
 */
export interface ActionSuggestion {
  /** Suggested action type */
  type: 'monitor' | 'act' | 'collaborate' | 'explore' | 'wait';

  /** Action description */
  description: string;

  /** Related goal */
  goalId?: string;

  /** Priority of this action */
  priority: GoalPriority;

  /** Expected outcome */
  expectedOutcome?: string;

  /** Resources needed */
  requiredResources?: string[];

  /** Confidence in this suggestion */
  confidence: number;

  /** Alternative actions */
  alternatives?: ActionSuggestion[];
}

// --------------------------------------------
// GOAL MANAGER TYPES
// --------------------------------------------

/**
 * Goal update event
 */
export interface GoalEvent {
  type: 'created' | 'updated' | 'achieved' | 'failed' | 'suspended' | 'activated';
  goal: AgentGoal;
  timestamp: Date;
  reason?: string;
}

/**
 * Goal manager statistics
 */
export interface GoalStats {
  total: number;
  byStatus: Record<GoalStatus, number>;
  byType: Record<GoalType, number>;
  byPriority: Record<GoalPriority, number>;
  averageAge: number;
  achievementRate: number;
}
