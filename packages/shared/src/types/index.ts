// ============================================
// ACTIVE COLLABORATION IOT FRAMEWORK
// Core Type Definitions
// ============================================

// --------------------------------------------
// USER TYPES
// --------------------------------------------

/**
 * Represents a user in the system
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name?: string;
  created_at: Date;
  updated_at: Date;
}

// --------------------------------------------
// DEVICE TYPES
// --------------------------------------------

/**
 * Device location - can be a simple string or structured object with path and coordinates
 * When using object form, path is required for consistent access
 */
export type DeviceLocation = string | {
  path: string;  // Required when using object form
  position?: {
    x: number;
    y: number;
    z: number;
  };
  metadata?: Record<string, any>;
  [key: string]: any; // Allow additional properties for flexibility
};

/**
 * Represents a physical or virtual IoT device
 */
export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  template?: string; // Device template identifier
  location: DeviceLocation;
  status: DeviceStatus;
  capabilities: DeviceCapability[];
  services: Service[];
  metadata: DeviceMetadata;
  connectionInfo: ConnectionInfo;
  lastHeartbeat: Date;
}

export enum DeviceType {
  SENSOR = 'sensor',
  ACTUATOR = 'actuator',
  CONTROLLER = 'controller',
  HYBRID = 'hybrid',
}

export enum DeviceStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  ERROR = 'error',
  MAINTENANCE = 'maintenance',
}

export interface DeviceCapability {
  name: string;
  type: CapabilityType;
  parameters: ParameterDefinition[];
  returnType?: string;
}

export type CapabilityType = 'read' | 'write' | 'execute';

export interface ParameterDefinition {
  name: string;
  type: ParameterType;
  required: boolean;
  description?: string;
  defaultValue?: any;
  validation?: ValidationRule;
}

export type ParameterType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface ValidationRule {
  min?: number;
  max?: number;
  pattern?: string;
  enum?: any[];
}

export interface DeviceMetadata {
  manufacturer?: string;
  model?: string;
  version?: string;
  firmware?: string;
  installDate?: Date;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
  environmentId?: string;
  properties?: Record<string, any>;
}

export interface ConnectionInfo {
  protocol: ConnectionProtocol;
  endpoint: string;
  port?: number;
  credentials?: AuthenticationCredentials;
}

export type ConnectionProtocol = 'http' | 'https' | 'mqtt' | 'coap' | 'websocket';

export interface AuthenticationCredentials {
  type: AuthType;
  token?: string;
  username?: string;
  password?: string;
  apiKey?: string;
}

export type AuthType = 'none' | 'basic' | 'bearer' | 'api-key' | 'oauth2';

// --------------------------------------------
// SERVICE TYPES
// --------------------------------------------

/**
 * Represents a callable operation on a device
 */
export interface Service {
  id: string;
  name: string;
  description: string;
  deviceId: string;
  uri: string;
  httpMethod: HTTPMethod;
  parameters: ParameterDefinition[];
  location: DeviceLocation;
  category: string;
  isConditional: boolean;
  conditions?: ServiceCondition[];
  // Service capability metadata for automatic matching
  actionType?: 'observe' | 'control' | 'both'; // What the service does
  capabilities?: string[]; // Specific capabilities (e.g., ['read-temperature', 'set-temperature'])

  // Requirement specification reference
  requirementSpecId?: string;

  // Validation timestamps
  lastValidatedAt?: Date;

  // Compliance tracking
  complianceHistory?: ServiceComplianceRecord[];

  // Provider Agent Information (Sprint 9)
  // These fields enable services to carry provider information, avoiding
  // architecture violations where components access agents' private ResourceManagers
  providerAgentId?: string; // ID of the agent providing this service
  providerAgentName?: string; // Name of the provider agent
  providerCapabilities?: string[]; // Capabilities of the provider agent
}

/**
 * Service compliance record for tracking validation history
 */
export interface ServiceComplianceRecord {
  validationId: string;
  timestamp: Date;
  outcome: 'full-compliance' | 'partial-compliance' | 'non-compliance' | 'validation-error';
  score: number; // 0-1
  requirementVersion: string;
}

export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ServiceCondition {
  parameter: string;
  operator: ComparisonOperator;
  value: any;
}

export type ComparisonOperator = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains';

// --------------------------------------------
// ENVIRONMENT TYPES
// --------------------------------------------

/**
 * Represents a collection of devices and their context
 */
export interface Environment {
  id: string;
  name: string;
  description: string;
  devices: Device[];
  agents: CognitiveAgent[];
  context: EnvironmentContext;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentContext {
  location: string;
  type: EnvironmentType;
  properties: Record<string, any>;
  constraints: EnvironmentConstraint[];
}

export type EnvironmentType = 'home' | 'office' | 'industrial' | 'outdoor' | 'laboratory';

export interface EnvironmentConstraint {
  type: ConstraintType;
  description: string;
  rule: string;
  priority: number;
}

export type ConstraintType = 'temporal' | 'spatial' | 'resource' | 'safety';

// --------------------------------------------
// AGENT TYPES
// --------------------------------------------

/**
 * Represents an AI-powered decision-making entity
 */
export interface CognitiveAgent {
  id: string;
  name: string;
  type: AgentType;
  role: AgentRole;
  device: Device;
  llmConfig: LLMConfiguration;
  capabilities: AgentCapability[];
  state: AgentState;
  dialogues: Dialogue[];
  resources: Resource[];
}

export enum AgentType {
  REQUESTER = 'requester',
  COLLABORATOR = 'collaborator',
  CONTRACTOR = 'contractor',
  ORCHESTRATOR = 'orchestrator',
}

export enum AgentRole {
  INITIATOR = 'initiator',
  RESPONDER = 'responder',
  COORDINATOR = 'coordinator',
  EXECUTOR = 'executor',
}

export interface LLMConfiguration {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  endpoint?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export type LLMProvider = 'openai' | 'anthropic' | 'azure' | 'huggingface' | 'local' | 'custom';

export interface AgentCapability {
  type: AgentCapabilityType;
  description: string;
  enabled: boolean;
}

export type AgentCapabilityType = 'cognition' | 'communication' | 'execution' | 'coordination';

export enum AgentState {
  IDLE = 'idle',
  OBSERVING = 'observing',
  PLANNING = 'planning',
  NEGOTIATING = 'negotiating',
  CONTRACTING = 'contracting',
  EXECUTING = 'executing',
  VALIDATING = 'validating',
}

// --------------------------------------------
// TASK TYPES
// --------------------------------------------

/**
 * Represents a unit of work to be executed
 */
export interface Task {
  id: string;
  command: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  assignee?: string;
  dependencies: string[];
  subTasks: Task[];
  context: TaskContext;
  result?: TaskResult;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export enum TaskType {
  INITIATION = 'initiation',
  NEGOTIATION = 'negotiation',
  CONTRACTING = 'contracting',
  EXECUTION = 'execution',
  VALIDATION = 'validation',
}

export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked',
}

export interface TaskContext {
  userCommand: string;
  availableServices: Service[];
  availableAgents: CognitiveAgent[];
  environmentId: string;
  parameters: Record<string, any>;
}

export interface TaskResult {
  success: boolean;
  output: any;
  error?: string;
  executionTime: number;
  logs: ExecutionLog[];
}

export interface ExecutionLog {
  timestamp: Date;
  level: LogLevel;
  message: string;
  metadata?: Record<string, any>;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

// --------------------------------------------
// COLLABORATION TYPES
// --------------------------------------------

/**
 * Represents a collaborative session between agents
 */
export interface ActiveCollaboration {
  id: string;
  name: string;
  description: string;
  requesterAgent: CognitiveAgent;
  collaboratorAgents: CognitiveAgent[];
  task: Task;
  phase: CollaborationPhase;
  contract?: ServiceContract;
  messages: CollaborationMessage[];
  createdAt: Date;
  status: CollaborationStatus;
}

export enum CollaborationPhase {
  INITIATION = 'initiation',
  FORMING = 'forming',
  NEGOTIATION = 'negotiation',
  CONTRACTING = 'contracting',
  EXECUTION = 'execution',
  VALIDATION = 'validation',
  COMPLETION = 'completion',
}

export enum CollaborationStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface ServiceContract {
  id: string;
  services: ServiceChain[];
  terms: ContractTerms;
  status: ContractStatus;
  agreedAt?: Date;
}

export enum ContractStatus {
  PROPOSED = 'proposed',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  FULFILLED = 'fulfilled',
}

export interface ServiceChain {
  rootService: ServiceExecution;
  conditionalChains: ConditionalChain[];
}

export interface ServiceExecution {
  service: Service;
  parameters: Record<string, any>;
  triggeredServices: ServiceExecution[];
}

export interface ConditionalChain {
  condition: string;
  services: ServiceExecution[];
}

export interface ContractTerms {
  resources: ResourceAllocation[];
  timeline: Timeline;
  qualityOfService: QualityOfService;
  compensation?: Compensation;
}

export interface ResourceAllocation {
  resourceId: string;
  amount: number;
  duration: number;
  exclusivity: boolean;
}

export interface Timeline {
  startTime: Date;
  endTime: Date;
  deadline?: Date;
  milestones: Milestone[];
}

export interface Milestone {
  name: string;
  deadline: Date;
  status: MilestoneStatus;
}

export type MilestoneStatus = 'pending' | 'completed' | 'missed';

export interface QualityOfService {
  availability: number;
  responseTime: number;
  reliability: number;
}

export interface Compensation {
  type: CompensationType;
  amount?: number;
  description: string;
}

export type CompensationType = 'monetary' | 'service-exchange' | 'resource-share';

export interface CollaborationMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  content: any;
  timestamp: Date;
}

export enum MessageType {
  PROPOSAL = 'proposal',
  ACCEPTANCE = 'acceptance',
  REJECTION = 'rejection',
  QUERY = 'query',
  RESPONSE = 'response',
  NOTIFICATION = 'notification',
}

// --------------------------------------------
// DIALOGUE TYPES
// --------------------------------------------

/**
 * Represents LLM conversation history
 */
export interface Dialogue {
  id: string;
  messages: DialogueMessage[];
  context: DialogueContext;
  summary?: string;
}

export interface DialogueMessage {
  role: DialogueRole;
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export type DialogueRole = 'system' | 'user' | 'assistant';

export interface DialogueContext {
  taskId?: string;
  collaborationId?: string;
  environmentId: string;
  variables: Record<string, any>;
}

// --------------------------------------------
// RESOURCE TYPES
// --------------------------------------------

/**
 * Represents allocatable resources
 */
export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  template: ResourceTemplate;
  location: string;
  url: string;
  parameters: Record<string, any>;
  availability: ResourceAvailability;
  quota?: Quota;
  accessPolicy?: AccessPolicy;
}

export enum ResourceType {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  SHARED = 'shared',
}

export interface ResourceTemplate {
  id: string;
  type: string;
  schema: Record<string, any>;
  defaults: Record<string, any>;
}

export interface ResourceAvailability {
  available: boolean;
  capacity: number;
  utilized: number;
  reserved: number;
}

export interface Quota {
  limit: number;
  used: number;
  resetInterval: ResetInterval;
  lastReset: Date;
}

export type ResetInterval = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface AccessPolicy {
  id: string;
  rules: AccessRule[];
  priority: number;
}

export interface AccessRule {
  principal: string;
  permissions: Permission[];
  conditions: string[];
}

export interface Permission {
  action: string;
  granted: boolean;
}

// --------------------------------------------
// LLM TYPES
// --------------------------------------------

/**
 * LLM Query and Response structures
 */
export interface LLMQuery {
  id: string;
  type: LLMQueryType;
  prompt: string;
  context: any;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export enum LLMQueryType {
  CHECK_SERVICE = 'check_service',
  BREAKDOWN_TASK = 'breakdown_task',
  CODE_GENERATION = 'code_generation',
  EVALUATE_RESPONSES = 'evaluate_responses',
  PLAN_SERVICE = 'plan_service',
  VALIDATE = 'validate',
  CUSTOM = 'custom',
}

export interface LLMResponse {
  id: string;
  queryId: string;
  success: boolean;
  content: any;
  error?: string;
  usage?: TokenUsage;
  timestamp: Date;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// --------------------------------------------
// SIMULATION TYPES
// --------------------------------------------

/**
 * Simulation-specific types for IoT device simulation
 */
export interface SimulationConfig {
  environmentId: string;
  devices: SimulatedDeviceConfig[];
  scenario: TestScenario;
  speedMultiplier: number;
  dataGeneration: DataGenerationConfig;
}

export interface SimulatedDeviceConfig {
  deviceTemplate: Device;
  behavior: BehaviorPattern;
  state: DeviceState;
}

export interface BehaviorPattern {
  type: BehaviorType;
  interval?: number;
  probability?: number;
  script?: string;
}

export type BehaviorType = 'periodic' | 'event-driven' | 'random' | 'scripted';

export interface DeviceState {
  current: Record<string, any>;
  history: StateTransition[];
}

export interface StateTransition {
  from: Record<string, any>;
  to: Record<string, any>;
  timestamp: Date;
  trigger?: string;
}

export interface DataGenerationConfig {
  enableRealisticData: boolean;
  dataPatterns: string[];
  noiseLevel: number;
}

// --------------------------------------------
// EXPERIMENT/SCENARIO TYPES
// --------------------------------------------

/**
 * Test scenario definitions for the research framework
 */
export interface TestScenario {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  setup: ScenarioSetup;
  execution: ScenarioExecution;
  validation: ScenarioValidation;
}

export enum ScenarioCategory {
  SMART_HOME = 'smart_home',
  ENERGY_MANAGEMENT = 'energy_management',
  EMERGENCY_RESPONSE = 'emergency_response',
  MULTI_DEVICE_SYNC = 'multi_device_sync',
}

export interface ScenarioSetup {
  devices: Device[];
  agents: CognitiveAgent[];
  initialConditions: Record<string, any>;
}

export interface ScenarioExecution {
  steps: ExecutionStep[];
  expectedFlow: string[];
}

export interface ExecutionStep {
  order: number;
  action: string;
  target: string;
  expectedOutcome: string;
}

export interface ScenarioValidation {
  successCriteria: ValidationCriterion[];
  performanceMetrics: PerformanceMetric[];
}

export interface ValidationCriterion {
  name: string;
  type: CriterionType;
  expected: any;
  tolerance?: number;
}

export type CriterionType = 'boolean' | 'threshold' | 'comparison';

export interface PerformanceMetric {
  name: string;
  unit: string;
  target: number;
  actual?: number;
}

// --------------------------------------------
// EXPERIMENT RECORD TYPES
// --------------------------------------------

/**
 * Records for tracking experiments and decision processes
 */
export interface ExperimentRecord {
  experimentId: string;
  scenarioId: string;
  timestamp: Date;
  config: ExperimentConfig;
  execution: ExperimentExecution;
  llmInteractions: LLMInteractionSummary;
  decisions: DecisionRecord[];
  outcome: ExperimentOutcome;
}

export interface ExperimentConfig {
  llmModel: string;
  context: Record<string, any>;
  environment: EnvironmentState;
  userRequest: string;
}

export interface EnvironmentState {
  time: string;
  context: Record<string, any>;
  devices: Device[];
}

export interface ExperimentExecution {
  phases: PhaseRecord[];
  totalDuration: number;
  success: boolean;
  errors: ErrorRecord[];
}

export interface PhaseRecord {
  name: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  output: any;
}

export interface ErrorRecord {
  timestamp: Date;
  phase: string;
  message: string;
  stack?: string;
  recoverable: boolean;
}

export interface LLMInteractionSummary {
  totalCalls: number;
  totalTokens: number;
  calls: LLMCallRecord[];
}

export interface LLMCallRecord {
  timestamp: Date;
  queryType: LLMQueryType;
  prompt: string;
  context: Record<string, any>;
  response: string;
  parsed: any;
  model: string;
  tokens: TokenUsage;
  duration: number;
}

export interface DecisionRecord {
  timestamp: Date;
  decisionPoint: string;
  options: DecisionOption[];
  selected: DecisionOption;
  reasoning: string;
  confidence: number;
  alternatives?: string[];
}

export interface DecisionOption {
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  expectedOutcome: string;
}

export interface ExperimentOutcome {
  finalState: Record<string, any>;
  userFeedback?: string;
  metrics: ProcessMetrics;
}

export interface ProcessMetrics {
  environmentCompleteness: number;
  semanticUnderstanding: number;
  serviceDiscovery: number;
  taskPlanning: number;
  executionCompleteness: number;
  errorHandling: number;
  responseTime: number;
}

// --------------------------------------------
// WEB SOCKET TYPES
// --------------------------------------------

/**
 * WebSocket event types for real-time updates
 */
export interface WebSocketEvent {
  type: WebSocketEventType;
  payload: any;
  timestamp: Date;
}

export enum WebSocketEventType {
  DEVICE_STATE_CHANGE = 'device_state_change',
  TASK_STATUS_UPDATE = 'task_status_update',
  COLLABORATION_MESSAGE = 'collaboration_message',
  AGENT_STATE_CHANGE = 'agent_state_change',
  SERVICE_EXECUTED = 'service_executed',
  ERROR_OCCURRED = 'error_occurred',
  SIMULATION_UPDATE = 'simulation_update',
  ENVIRONMENT_UPDATED = 'environment_updated',
}

// --------------------------------------------
// UTILITY TYPES
// --------------------------------------------

/**
 * Partial update type for immutable updates
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Extract promise return type
 */
export type AsyncReturnType<T extends (...args: any) => Promise<any>> = T extends (
  ...args: any
) => Promise<infer R>
  ? R
  : any;

/**
 * Make specific properties required
 */
export type RequiredProps<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Make specific properties optional
 */
export type OptionalProps<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// --------------------------------------------
// EVENT TYPES
// --------------------------------------------

// Export event-specific types
export * from './events.js';

// --------------------------------------------
// PHYSICS TYPES
// --------------------------------------------

// Export physics-related types
export * from './physics.js';

// --------------------------------------------
// SPATIAL TYPES
// --------------------------------------------

// Export spatial-related types
export * from './spatial.js';

// --------------------------------------------
// REQUIREMENT SPECIFICATION TYPES
// --------------------------------------------

// Export requirement specification types
export * from './requirement-spec.js';
export * from './semantic-requirement.js';
export * from './environment-config.js';