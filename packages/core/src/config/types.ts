/**
 * Declarative Configuration Types
 *
 * This module defines the type system for declarative environment configuration.
 * It enables users to define environments, devices, agents, and autonomous behaviors
 * through configuration files (JSON/YAML) instead of code.
 */

// ============================================================
// Core Configuration Types
// ============================================================

/**
 * Root configuration object
 */
export interface DeclarativeConfig {
  version: string;
  metadata?: ConfigMetadata;
  environments: EnvironmentConfig[];
  deviceTemplates?: DeviceTemplateConfig[];
  agentTemplates?: AgentTemplateConfig[];
  autonomousRules?: AutonomousRuleConfig[];
}

/**
 * Configuration metadata
 */
export interface ConfigMetadata {
  name: string;
  description?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
}

// ============================================================
// Environment Configuration
// ============================================================

/**
 * Environment configuration
 */
export interface EnvironmentConfig {
  id: string;
  name: string;
  description?: string;
  type: 'shared' | 'private';
  visibility: 'platform' | 'invite-only' | 'private';

  // Spatial configuration
  bounds?: ZoneBounds;
  zones: ZoneConfig[];

  // Environment parameters (physical properties)
  parameters?: EnvironmentParameterConfig[];

  // Device and agent placements
  devicePlacements: DevicePlacementConfig[];
  agentPlacements: AgentPlacementConfig[];

  // Physics simulation settings
  physics?: PhysicsConfig;
}

/**
 * Zone bounds (3D spatial area)
 */
export interface ZoneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ?: number;
  maxZ?: number;
}

/**
 * Zone configuration
 */
export interface ZoneConfig {
  id: string;
  name: string;
  type: ZoneType;
  parent?: string;  // Parent zone ID
  bounds?: ZoneBounds;
  properties?: Record<string, any>;
}

export type ZoneType =
  | 'building'
  | 'floor'
  | 'room'
  | 'outdoor'
  | 'corridor'
  | 'storage'
  | 'production'
  | 'office'
  | 'lab'
  | 'datacenter'
  | 'custom';

/**
 * Environment parameter configuration
 */
export interface EnvironmentParameterConfig {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'object';
  value: any;
  unit?: string;
  zone?: string;  // If specified, parameter applies to this zone only
}

/**
 * Physics simulation configuration
 */
export interface PhysicsConfig {
  enabled: boolean;
  baseTemperature?: number;
  baseHumidity?: number;
  basePressure?: number;
  timeScale?: number;  // Simulation speed multiplier
  baseTime?: string;   // ISO date string
}

// ============================================================
// Device Configuration
// ============================================================

/**
 * Device template configuration
 */
export interface DeviceTemplateConfig {
  id: string;
  name: string;
  description?: string;
  category: DeviceCategory;
  type: 'sensor' | 'actuator' | 'controller' | 'gateway' | 'composite';

  // Capabilities this device provides
  capabilities: DeviceCapabilityConfig[];

  // Default state
  defaultState: Record<string, any>;

  // Physical properties
  physicalProperties?: DevicePhysicalProperties;

  // Metadata
  manufacturer?: string;
  model?: string;
  version?: string;
  tags?: string[];
}

export type DeviceCategory =
  | 'environmental'
  | 'hvac'
  | 'lighting'
  | 'security'
  | 'power'
  | 'network'
  | 'industrial'
  | 'medical'
  | 'consumer'
  | 'custom';

/**
 * Device capability configuration
 */
export interface DeviceCapabilityConfig {
  name: string;
  type: 'read' | 'control' | 'event' | 'composite';
  description?: string;
  parameters: CapabilityParameterConfig[];
  returns?: CapabilityReturnConfig;
}

/**
 * Capability parameter configuration
 */
export interface CapabilityParameterConfig {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'object' | 'array';
  required: boolean;
  defaultValue?: any;
  min?: number;
  max?: number;
  enum?: string[];
  description?: string;
}

/**
 * Capability return configuration
 */
export interface CapabilityReturnConfig {
  type: 'number' | 'string' | 'boolean' | 'object' | 'array';
  unit?: string;
  description?: string;
}

/**
 * Device physical properties
 */
export interface DevicePhysicalProperties {
  powerConsumption?: number;  // Watts
  responseTime?: number;      // Milliseconds
  accuracy?: number;          // Percentage
  range?: {
    min: number;
    max: number;
    unit: string;
  };
}

/**
 * Device placement configuration (instance)
 */
export interface DevicePlacementConfig {
  // Either use template or inline definition
  templateId?: string;
  inline?: DeviceTemplateConfig;

  instanceName: string;
  zone: string;
  location?: LocationConfig;

  // Override default state
  stateOverrides?: Record<string, any>;

  // Which agent owns this device
  ownerAgent?: string;

  // Metadata
  criticality?: 'critical' | 'high' | 'medium' | 'low';
  tags?: string[];
}

/**
 * 3D location configuration
 */
export interface LocationConfig {
  x: number;
  y: number;
  z?: number;
  path?: string;  // Hierarchical path like "building1/floor2/room3"
}

// ============================================================
// Agent Configuration
// ============================================================

/**
 * Agent template configuration
 */
export interface AgentTemplateConfig {
  id: string;
  name: string;
  description?: string;
  category: AgentCategory;

  // Capabilities this agent type provides
  capabilities: string[];

  // Default behaviors
  defaultBehaviors?: AgentBehaviorConfig[];

  // Autonomous mode defaults
  autonomousMode?: AutonomousModeConfig;

  // Priority for resource conflicts
  priority: 'critical' | 'high' | 'medium' | 'low';

  // LLM configuration
  llmConfig?: AgentLLMConfig;

  // Metadata
  tags?: string[];
}

export type AgentCategory =
  | 'monitor'
  | 'controller'
  | 'coordinator'
  | 'analyzer'
  | 'executor'
  | 'collaborator'
  | 'emergency'
  | 'custom';

/**
 * Agent behavior configuration
 */
export interface AgentBehaviorConfig {
  name: string;
  trigger: string;  // Event or condition
  action: string;   // Action to take
  priority?: number;
  enabled?: boolean;
}

/**
 * Agent LLM configuration
 */
export interface AgentLLMConfig {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Agent placement configuration (instance)
 */
export interface AgentPlacementConfig {
  // Either use template or inline definition
  templateId?: string;
  inline?: AgentTemplateConfig;

  instanceName: string;
  description?: string;

  // Devices assigned to this agent
  devices: string[];  // Device instance names

  // Zone responsibilities
  manages?: string[];  // Zone IDs this agent is responsible for

  // Override capabilities
  capabilitiesOverride?: string[];

  // Autonomous mode configuration
  autonomousMode?: AutonomousModeConfig;

  // Priority override
  priorityOverride?: 'critical' | 'high' | 'medium' | 'low';

  // Organization/owner
  organization?: string;
}

// ============================================================
// Autonomous Mode Configuration
// ============================================================

/**
 * Autonomous mode configuration
 */
export interface AutonomousModeConfig {
  enabled: boolean;

  // Trigger-based autonomous actions
  triggers?: TriggerConfig[];

  // Scheduled periodic checks
  scheduledChecks?: ScheduledCheckConfig[];

  // Threshold-based monitoring
  thresholdMonitors?: ThresholdMonitorConfig[];

  // Event subscriptions
  eventSubscriptions?: EventSubscriptionConfig[];

  // Autonomous behavior constraints
  constraints?: AutonomousConstraintConfig;
}

/**
 * Trigger configuration (event-driven)
 */
export interface TriggerConfig {
  id: string;
  name: string;
  enabled: boolean;

  // Trigger type
  type: TriggerType;

  // Condition expression (JSON Logic or simple comparison)
  condition: ConfigTriggerCondition;

  // Action to execute when triggered
  action: TriggerAction;

  // Cooldown period (prevent rapid re-triggering)
  cooldownMs?: number;

  // Maximum executions (0 = unlimited)
  maxExecutions?: number;
}

export type TriggerType =
  | 'device-state-change'
  | 'environment-parameter'
  | 'time-based'
  | 'event-received'
  | 'threshold-crossed'
  | 'custom';

/**
 * Trigger condition
 */
export interface ConfigTriggerCondition {
  // Simple condition
  deviceId?: string;
  parameter?: string;
  operator?: ComparisonOperator;
  value?: any;

  // Complex condition (JSON Logic)
  logic?: Record<string, any>;

  // Time-based condition
  cron?: string;
  timeRange?: {
    start: string;  // HH:mm
    end: string;    // HH:mm
    days?: number[]; // 0-6, Sunday = 0
  };
}

export type ComparisonOperator =
  | '==' | '!=' | '>' | '<' | '>=' | '<='
  | 'contains' | 'startsWith' | 'endsWith'
  | 'in' | 'notIn';

/**
 * Trigger action
 */
export interface TriggerAction {
  type: 'device-control' | 'agent-request' | 'collaboration' | 'notification' | 'custom';

  // Device control action
  deviceId?: string;
  command?: string;
  params?: Record<string, any>;

  // Agent request action
  targetAgent?: string;
  task?: string;

  // Custom action (LLM-interpreted)
  description?: string;

  // Priority for this action
  priority?: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Scheduled check configuration
 */
export interface ScheduledCheckConfig {
  id: string;
  name: string;
  enabled: boolean;

  // Schedule (either interval or cron)
  interval?: number;  // Milliseconds
  cron?: string;      // Cron expression

  // Task to execute
  task: string;       // Natural language task description

  // Optional conditions
  condition?: ConfigTriggerCondition;
}

/**
 * Threshold monitor configuration
 */
export interface ThresholdMonitorConfig {
  id: string;
  name: string;
  enabled: boolean;

  // What to monitor
  deviceId: string;
  parameter: string;

  // Thresholds
  warningThreshold?: ThresholdLevel;
  criticalThreshold?: ThresholdLevel;

  // Actions
  warningAction?: TriggerAction;
  criticalAction?: TriggerAction;

  // Hysteresis (prevent rapid on/off)
  hysteresis?: number;
}

/**
 * Threshold level definition
 */
export interface ThresholdLevel {
  operator: ComparisonOperator;
  value: number;
  duration?: number;  // Must persist for this duration (ms)
}

/**
 * Event subscription configuration
 */
export interface EventSubscriptionConfig {
  eventType: string;
  filter?: Record<string, any>;
  action: TriggerAction;
}

/**
 * Autonomous constraint configuration
 */
export interface AutonomousConstraintConfig {
  // Maximum actions per time window
  maxActionsPerMinute?: number;
  maxActionsPerHour?: number;

  // Allowed action types
  allowedActionTypes?: string[];

  // Require confirmation for certain actions
  requireConfirmation?: string[];

  // Blackout periods (no autonomous actions)
  blackoutPeriods?: {
    start: string;  // HH:mm
    end: string;    // HH:mm
    days?: number[];
  }[];
}

// ============================================================
// Autonomous Rules (Reusable)
// ============================================================

/**
 * Autonomous rule configuration (reusable rule templates)
 */
export interface AutonomousRuleConfig {
  id: string;
  name: string;
  description?: string;

  // Rule triggers
  triggers: TriggerConfig[];

  // Rule schedules
  scheduledChecks?: ScheduledCheckConfig[];

  // Rule thresholds
  thresholdMonitors?: ThresholdMonitorConfig[];

  // Tags for categorization
  tags?: string[];
}

// ============================================================
// Validation Types
// ============================================================

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
}

export interface ConfigValidationError {
  path: string;
  message: string;
  code: string;
}

export interface ConfigValidationWarning {
  path: string;
  message: string;
  suggestion?: string;
}

// ============================================================
// Apply Result Types
// ============================================================

/**
 * Result of applying configuration
 */
export interface ApplyResult {
  success: boolean;
  environmentId: string;

  created: {
    devices: string[];
    agents: string[];
    services: string[];
    resources: string[];
  };

  errors: Array<{
    type: string;
    message: string;
    details?: any;
  }>;

  warnings: string[];
}

// ============================================================
// Export/Import Types
// ============================================================

/**
 * Export options
 */
export interface ExportOptions {
  format: 'json' | 'yaml';
  includeState?: boolean;     // Include current device states
  includeHistory?: boolean;   // Include historical data
  prettyPrint?: boolean;
}

/**
 * Import options
 */
export interface ImportOptions {
  mode: 'create' | 'replace' | 'merge';
  validateOnly?: boolean;     // Validate without applying
  dryRun?: boolean;           // Simulate without making changes
}

// ============================================================
// Device Config (for ConfigLoader internal use)
// ============================================================

/**
 * Minimal device config interface for creating devices from configuration.
 * This is a subset of the full SimulatedDeviceConfig from @active-collaboration/simulation.
 */
export interface DeviceConfig {
  id?: string;
  name: string;
  type: string;
  templateId?: string;
  initialState: Record<string, any>;
  capabilities: DeviceCapability[];
  behaviors: BehaviorConfig[];
  location?: string | DeviceLocation;
  metadata?: Record<string, any>;
}

/**
 * Device capability for device config
 */
export interface DeviceCapability {
  name: string;
  type: string;
  parameters?: CapabilityParameter[];
}

/**
 * Capability parameter
 */
export interface CapabilityParameter {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'object' | 'array';
  required?: boolean;
  defaultValue?: any;
}

/**
 * Device behavior configuration
 */
export interface BehaviorConfig {
  type: string;
  interval?: number;
  probability?: number;
  conditions?: any[];
  script?: any[];
  [key: string]: any;
}

/**
 * Device location
 */
export interface DeviceLocation {
  path: string;
  x?: number;
  y?: number;
  z?: number;
}
