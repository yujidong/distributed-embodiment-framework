/**
 * Event Types
 *
 * Shared type definitions for system events.
 * These types are used across packages to ensure consistency.
 */

// --------------------------------------------
// CORE EVENT TYPE DEFINITIONS
// --------------------------------------------

/**
 * Event types in the system
 */
export enum EventType {
  // Device events
  DEVICE_STATE_CHANGE = 'device.state_change',
  DEVICE_STATE_UPDATE = 'device.state_update',  // NEW: Agent-facing device state notification
  DEVICE_REGISTERED = 'device.registered',
  DEVICE_UNREGISTERED = 'device.unregistered',
  DEVICE_ERROR = 'device.error',
  DEVICE_OPERATION_EXECUTED = 'device.operation_executed',

  // Physics events (INTERNAL to simulation - Agents should NOT subscribe to these)
  PHYSICS_TEMPERATURE_CHANGE = 'physics.temperature_change',
  PHYSICS_HUMIDITY_CHANGE = 'physics.humidity_change',
  PHYSICS_AIR_QUALITY_CHANGE = 'physics.air_quality_change',
  PHYSICS_MOTION_DETECTED = 'physics.motion_detected',
  PHYSICS_LIGHT_CHANGE = 'physics.light_change',
  PHYSICS_PRESSURE_CHANGE = 'physics.pressure_change',

  // Agent events
  AGENT_STATE_CHANGE = 'agent.state_change',
  AGENT_REGISTERED = 'agent.registered',
  AGENT_UNREGISTERED = 'agent.unregistered',
  AGENT_TASK_ASSIGNED = 'agent.task_assigned',
  AGENT_TASK_COMPLETED = 'agent.task_completed',
  AGENT_CONTEXT_BUILT = 'agent.context_built',

  // Environment events
  ENVIRONMENT_PARAM_CHANGED = 'environment.param_changed',
  ENVIRONMENT_TIME_ADVANCED = 'environment.time_advanced',

  // Collaboration events
  COLLABORATION_STARTED = 'collaboration.started',
  COLLABORATION_MESSAGE = 'collaboration.message',
  COLLABORATION_PROPOSAL = 'collaboration.proposal',
  COLLABORATION_RESPONSE = 'collaboration.response',
  COLLABORATION_COMPLETED = 'collaboration.completed',

  // Requirement marketplace events
  REQUIREMENT_PUBLISHED = 'requirement.published',
  REQUIREMENT_RESPONSE = 'requirement.response',
  REQUIREMENT_FULFILLED = 'requirement.fulfilled',
  REQUIREMENT_CANCELLED = 'requirement.cancelled',

  // Service execution events
  SERVICE_EXECUTION_REQUEST = 'service.execution_request',
  SERVICE_EXECUTION_RESPONSE = 'service.execution_response',

  // System events
  SYSTEM_ERROR = 'system.error',
  SYSTEM_WARNING = 'system.warning',

  // API trigger events
  THRESHOLD_BREACH = 'threshold.breach',
  SCHEDULED_TASK = 'scheduled.task',
  EMERGENCY = 'emergency',
  CUSTOM = 'custom',
}

/**
 * Event priority levels
 */
export enum EventPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * System event interface
 */
export interface SystemEvent {
  id: string;
  type: EventType;
  source: string;
  timestamp: Date;
  correlationId?: string;
  priority: EventPriority;
  payload: any;
  metadata: Record<string, any>;
}

/**
 * Event filter options
 */
export interface EventFilter {
  source?: string | string[];
  eventType?: EventType | EventType[];
  after?: Date;
  before?: Date;
  minPriority?: EventPriority;
  metadata?: Record<string, any>;
}

/**
 * Event handler function type
 */
export type EventHandler = (event: SystemEvent) => void | Promise<void>;

/**
 * Event subscription
 */
export interface EventSubscription {
  id: string;
  subscriberId: string;
  eventType: EventType | EventType[];
  handler: EventHandler;
  priority?: EventPriority;
  filter?: EventFilter;
  once?: boolean; // If true, unsubscribe after first event
}

/**
 * Event emission options
 */
export interface EmitOptions {
  correlationId?: string;
  delay?: number; // Delay in milliseconds
}

/**
 * Event statistics
 */
export interface EventStats {
  totalEvents: number;
  totalSubscriptions: number;
  eventsByType: Record<string, number>;
  subscriptionsBySubscriber: Record<string, number>;
}

// --------------------------------------------
// DEVICE EVENT PAYLOADS
// --------------------------------------------

/**
 * Device State Update - Agent-facing notification
 *
 * This is the PRIMARY way agents receive device information.
 * It abstracts away simulation/real-world differences, making the system portable.
 *
 * Key characteristics:
 * - Agents ONLY receive these from devices they manage
 * - Works identically in simulation and real deployment
 * - Device interprets raw data and emits meaningful updates
 */
export interface DeviceStateUpdate {
  /** ID of the device sending the update */
  deviceId: string;

  /** Type of device (e.g., 'temperature-sensor', 'hvac-controller') */
  deviceType: string;

  /** Timestamp of the update */
  timestamp: Date;

  /** Location of the device (if applicable) */
  location?: { x: number; y: number; z: number };

  /** The actual state change that the agent cares about */
  stateChange: {
    /** Property that changed (e.g., 'temperature', 'power', 'motion') */
    property: string;

    /** Previous value */
    oldValue: any;

    /** New value */
    newValue: any;

    /** Unit of measurement (e.g., '°C', '%', 'kW', 'boolean') */
    unit?: string;
  };

  /** Context about the change (optional) */
  context?: {
    /** Significance level */
    significance?: 'normal' | 'warning' | 'critical';

    /** Trend direction */
    trend?: 'increasing' | 'decreasing' | 'stable' | 'unknown';

    /** Whether this is an anomaly */
    anomaly?: boolean;

    /** Type of anomaly if detected */
    anomalyType?: string;

    /** Source of the change (simulation, user, device, etc.) */
    source?: string;
  };

  /** Device's current full state (optional, for context) */
  fullState?: Record<string, any>;
}

/**
 * Physics Event - Internal to simulation
 *
 * These events represent raw physics changes in the simulated environment.
 * Devices receive these and convert them to DeviceStateUpdates for agents.
 *
 * CRITICAL: Agents should NEVER subscribe to these events directly!
 * Only Devices should handle PhysicsEvents.
 */
export interface PhysicsEvent {
  /** Type of physics change */
  type: 'temperature_change' | 'humidity_change' | 'air_quality_change' |
        'motion_detected' | 'light_change' | 'pressure_change';

  /** Location where the change occurred */
  location: { x: number; y: number; z: number };

  /** Physical parameter that changed */
  parameter: string;

  /** Previous value */
  oldValue: number;

  /** New value */
  newValue: number;

  /** Timestamp of the change */
  timestamp: Date;

  /** Whether this is an anomalous change */
  isAnomaly?: boolean;

  /** Rate of change (if applicable) */
  rateOfChange?: number;

  /** Cause of the change (if known) */
  cause?: 'natural' | 'device_effect' | 'manual';
}

/**
 * Device state change event payload
 */
export interface DeviceStateChangeEvent {
  deviceId: string;
  deviceName?: string;
  location?: string;
  oldState: Record<string, any>;
  newState: Record<string, any>;
  changedParameters: string[];
}

/**
 * Device registered event payload
 */
export interface DeviceRegisteredEvent {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  location: string;
  capabilities: string[];
}

/**
 * Device error event payload
 */
export interface DeviceErrorEvent {
  deviceId: string;
  error: string;
  context?: any;
}

/**
 * Device operation executed event payload
 * Device operations are low-level hardware commands (distinct from Agent services)
 */
export interface DeviceOperationExecutedEvent {
  deviceId: string;
  deviceName?: string;
  commandName: string;
  params?: any;
  result?: any;
  executionTime?: number;
}

// --------------------------------------------
// AGENT EVENT PAYLOADS
// --------------------------------------------

/**
 * Agent state change event payload
 */
export interface AgentStateChangeEvent {
  agentId: string;
  agentName?: string;
  oldState: string;
  newState: string;
  reason?: string;
}

/**
 * Agent registered event payload
 */
export interface AgentRegisteredEvent {
  agentId: string;
  agentName: string;
  capabilities: string[];
}

/**
 * Agent task assigned event payload
 */
export interface AgentTaskAssignedEvent {
  agentId: string;
  taskId: string;
  taskTitle: string;
  priority: string;
}

/**
 * Agent task completed event payload
 */
export interface AgentTaskCompletedEvent {
  agentId: string;
  taskId: string;
  result: any;
  duration: number;
}

// --------------------------------------------
// ENVIRONMENT EVENT PAYLOADS
// --------------------------------------------

/**
 * Environment parameter changed event payload
 */
export interface EnvironmentParamChangeEvent {
  parameter: string;
  location: string;
  oldValue: number | boolean;
  newValue: number | boolean;
  cause?: 'natural' | 'device_effect' | 'manual';
  deviceId?: string;
}

/**
 * Environment time advanced event payload
 */
export interface EnvironmentTimeAdvancedEvent {
  currentTime: Date;
  timeScale: number;
  delta: number; // Milliseconds advanced
}

// --------------------------------------------
// COLLABORATION EVENT PAYLOADS
// --------------------------------------------

/**
 * Collaboration started event payload
 */
export interface CollaborationStartedEvent {
  collaborationId: string;
  initiator: string;
  participants: string[];
  purpose: string;
  task: string;
}

/**
 * Collaboration message event payload
 */
export interface CollaborationMessageEvent {
  collaborationId?: string;
  fromAgent: string;
  toAgent?: string;
  messageType: string;
  content: string;
  originalMessageId?: string;
}

/**
 * Collaboration completed event payload
 */
export interface CollaborationCompletedEvent {
  collaborationId: string;
  result: any;
  duration: number;
  participantCount: number;
}

// --------------------------------------------
// REQUIREMENT MARKETPLACE EVENT PAYLOADS
// --------------------------------------------

/**
 * Requirement published event payload
 * When an agent publishes a requirement for collaboration
 */
export interface RequirementPublishedEvent {
  requirementId: string;
  publisherId: string;
  publisherName: string;
  requirementType: string; // e.g., 'energy-monitoring', 'hvac-control'
  description: string;
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  expiresAt?: Date;
  context?: any;
}

/**
 * Requirement response event payload
 * When an agent responds to a published requirement
 */
export interface RequirementResponseEvent {
  requirementId: string;
  requirementPublisherId: string;
  responderId: string;
  responderName: string;
  response: 'accept' | 'decline' | 'counter';
  message: string;
  proposedTerms?: any;
}

/**
 * Requirement fulfilled event payload
 * When a published requirement has been fulfilled
 */
export interface RequirementFulfilledEvent {
  requirementId: string;
  publisherId: string;
  fulfillerId: string;
  result: any;
  collaborationId?: string;
}

/**
 * Requirement cancelled event payload
 * When a published requirement is cancelled
 */
export interface RequirementCancelledEvent {
  requirementId: string;
  publisherId: string;
  reason: string;
}

// --------------------------------------------
// SYSTEM EVENT PAYLOADS
// --------------------------------------------

/**
 * System error event payload
 */
export interface SystemErrorEvent {
  error: string;
  stack?: string;
  context?: any;
  component?: string;
}

/**
 * System warning event payload
 */
export interface SystemWarningEvent {
  message: string;
  context?: any;
  component?: string;
}
