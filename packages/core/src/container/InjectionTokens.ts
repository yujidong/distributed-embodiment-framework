/**
 * Injection Tokens
 *
 * Central definition of all service injection tokens.
 * Using string tokens for simplicity and debugging.
 */

// ============================================================================
// Core Services
// ============================================================================

/** Event Manager - handles system-wide events */
export const TOKEN_EVENT_MANAGER = 'EventManager';

/** Event Emitter - for emitting events */
export const TOKEN_EVENT_EMITTER = 'EventEmitter';

/** Context Builder - builds agent context */
export const TOKEN_CONTEXT_BUILDER = 'ContextBuilder';

/** Message Broker - inter-agent communication */
export const TOKEN_MESSAGE_BROKER = 'MessageBroker';

// ============================================================================
// Resource Services
// ============================================================================

/** Resource Manager - manages agent resources */
export const TOKEN_RESOURCE_MANAGER = 'ResourceManager';

/** Resource Allocator - allocates resources to tasks */
export const TOKEN_RESOURCE_ALLOCATOR = 'ResourceAllocator';

// ============================================================================
// Task Services
// ============================================================================

/** Task Manager - manages task lifecycle */
export const TOKEN_TASK_MANAGER = 'TaskManager';

/** Task Planner - plans task execution */
export const TOKEN_TASK_PLANNER = 'TaskPlanner';

// ============================================================================
// Service Layer
// ============================================================================

/** Service Registry - registry of available services */
export const TOKEN_SERVICE_REGISTRY = 'ServiceRegistry';

/** Service Publisher - publishes agent services */
export const TOKEN_SERVICE_PUBLISHER = 'ServicePublisher';

/** Service Broker - brokers service requests */
export const TOKEN_SERVICE_BROKER = 'ServiceBroker';

// ============================================================================
// Collaboration Services
// ============================================================================

/** Collaboration Manager - manages AC sessions */
export const TOKEN_COLLABORATION_MANAGER = 'CollaborationManager';

/** Collaboration Coordinator - coordinates agent collaboration */
export const TOKEN_COLLABORATION_COORDINATOR = 'CollaborationCoordinator';

/** Proposal Manager - manages collaboration proposals */
export const TOKEN_PROPOSAL_MANAGER = 'ProposalManager';

/** Partner Selector - selects collaboration partners */
export const TOKEN_PARTNER_SELECTOR = 'PartnerSelector';

// ============================================================================
// Execution Services
// ============================================================================

/** Device Executor - executes device commands */
export const TOKEN_DEVICE_EXECUTOR = 'DeviceExecutor';

/** Service Composer - composes complex services */
export const TOKEN_SERVICE_COMPOSER = 'ServiceComposer';

/** Operation Orchestrator - orchestrates operations */
export const TOKEN_OPERATION_ORCHESTRATOR = 'OperationOrchestrator';

// ============================================================================
// Communication Services
// ============================================================================

/** Message Handler - handles incoming messages */
export const TOKEN_MESSAGE_HANDLER = 'MessageHandler';

/** Negotiation Engine - handles negotiations */
export const TOKEN_NEGOTIATION_ENGINE = 'NegotiationEngine';

// ============================================================================
// Capability Services
// ============================================================================

/** Service Discovery - discovers available services */
export const TOKEN_SERVICE_DISCOVERY = 'ServiceDiscovery';

/** Capability Matcher - matches capabilities to requirements */
export const TOKEN_CAPABILITY_MATCHER = 'CapabilityMatcher';

/** Resource Coordinator - coordinates device/resource management */
export const TOKEN_RESOURCE_COORDINATOR = 'ResourceCoordinator';

/** Service Execution Coordinator - coordinates service execution */
export const TOKEN_SERVICE_EXECUTION_COORDINATOR = 'ServiceExecutionCoordinator';

// ============================================================================
// LLM Services
// ============================================================================

/** LLM Client - communicates with LLM */
export const TOKEN_LLM_CLIENT = 'LLMClient';

// ============================================================================
// Environment Services
// ============================================================================

/** Environment Center - manages environment */
export const TOKEN_ENVIRONMENT_CENTER = 'EnvironmentCenter';

/** Physics Integration - integrates with physics simulation */
export const TOKEN_PHYSICS_INTEGRATION = 'PhysicsIntegration';

/** Member Manager - manages environment members */
export const TOKEN_MEMBER_MANAGER = 'MemberManager';

/** Device Registry - registry of devices */
export const TOKEN_DEVICE_REGISTRY = 'DeviceRegistry';

/** Agent Registry - registry of agents */
export const TOKEN_AGENT_REGISTRY = 'AgentRegistry';

// ============================================================================
// Decision Services
// ============================================================================

/** Autonomous Decision Engine - makes autonomous decisions */
export const TOKEN_AUTONOMOUS_DECISION_ENGINE = 'AutonomousDecisionEngine';

/** Goal Formulation Engine - formulates agent goals */
export const TOKEN_GOAL_FORMULATION_ENGINE = 'GoalFormulationEngine';

/** AC Necessity Assessor - assesses AC necessity */
export const TOKEN_AC_NECESSITY_ASSESSOR = 'ACNecessityAssessor';

// ============================================================================
// Code Generation Services
// ============================================================================

/** Code Generator - generates service code */
export const TOKEN_CODE_GENERATOR = 'CodeGenerator';

/** Deployment Manager - manages deployments */
export const TOKEN_DEPLOYMENT_MANAGER = 'DeploymentManager';

// ============================================================================
// Workflow Services
// ============================================================================

/** Workflow Engine - executes workflows */
export const TOKEN_WORKFLOW_ENGINE = 'WorkflowEngine';

/** Collaboration Workflow Engine - executes collaboration workflows */
export const TOKEN_COLLABORATION_WORKFLOW_ENGINE = 'CollaborationWorkflowEngine';

// ============================================================================
// Configuration Services
// ============================================================================

/** Configuration - application configuration */
export const TOKEN_CONFIG = 'Config';

/** Logger - logging service */
export const TOKEN_LOGGER = 'Logger';

// ============================================================================
// Validation Services
// ============================================================================

/** Requirement Validator - validates requirements */
export const TOKEN_REQUIREMENT_VALIDATOR = 'RequirementValidator';

/** Service Validator - validates services */
export const TOKEN_SERVICE_VALIDATOR = 'ServiceValidator';

// ============================================================================
// All Tokens Array (for iteration)
// ============================================================================

export const ALL_TOKENS = [
  // Core
  TOKEN_EVENT_MANAGER,
  TOKEN_EVENT_EMITTER,
  TOKEN_MESSAGE_BROKER,
  // Resource
  TOKEN_RESOURCE_MANAGER,
  TOKEN_RESOURCE_ALLOCATOR,
  // Task
  TOKEN_TASK_MANAGER,
  TOKEN_TASK_PLANNER,
  // Service
  TOKEN_SERVICE_REGISTRY,
  TOKEN_SERVICE_PUBLISHER,
  TOKEN_SERVICE_BROKER,
  // Collaboration
  TOKEN_COLLABORATION_MANAGER,
  TOKEN_COLLABORATION_COORDINATOR,
  TOKEN_PROPOSAL_MANAGER,
  TOKEN_PARTNER_SELECTOR,
  // Execution
  TOKEN_DEVICE_EXECUTOR,
  TOKEN_SERVICE_COMPOSER,
  TOKEN_OPERATION_ORCHESTRATOR,
  // Communication
  TOKEN_MESSAGE_HANDLER,
  TOKEN_NEGOTIATION_ENGINE,
  // Capability
  TOKEN_SERVICE_DISCOVERY,
  TOKEN_CAPABILITY_MATCHER,
  // LLM
  TOKEN_LLM_CLIENT,
  TOKEN_CONTEXT_BUILDER,
  // Environment
  TOKEN_ENVIRONMENT_CENTER,
  TOKEN_PHYSICS_INTEGRATION,
  TOKEN_MEMBER_MANAGER,
  TOKEN_DEVICE_REGISTRY,
  TOKEN_AGENT_REGISTRY,
  // Decision
  TOKEN_AUTONOMOUS_DECISION_ENGINE,
  TOKEN_GOAL_FORMULATION_ENGINE,
  TOKEN_AC_NECESSITY_ASSESSOR,
  // Code Gen
  TOKEN_CODE_GENERATOR,
  TOKEN_DEPLOYMENT_MANAGER,
  // Workflow
  TOKEN_WORKFLOW_ENGINE,
  TOKEN_COLLABORATION_WORKFLOW_ENGINE,
  // Config
  TOKEN_CONFIG,
  TOKEN_LOGGER,
  // Validation
  TOKEN_REQUIREMENT_VALIDATOR,
  TOKEN_SERVICE_VALIDATOR,
] as const;
