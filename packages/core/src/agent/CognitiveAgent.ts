/**
 * Cognitive Agent (Refactored Version)
 *
 * Uses coordinators to delegate responsibilities
 * Includes all core functionality: AC decision, task execution, context management
 *
 * Architecture:
 * - Device Layer: Executes commands (turnOn, setTemperature)
 * - Resource Layer: Maps semantic capabilities to device commands
 * - Service Layer: Agent-exposed functionality to other agents
 */

import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { LLMClient, ChatParams } from '@active-collaboration/llm-integration';
import type { Device, Service } from '@active-collaboration/shared';

// Resource Layer
import { ResourceManager, ResourceAllocator } from '../resource/index.js';

// Management Layer
import {
  TaskManager,
  DialogueManager,
  CodeGenerator,
  DeploymentManager,
  WorkflowEngine,
  CollaborationManager,
  CollaborationPriority,
  ACState,
  MessageType,
  MessagePriority,
} from '../management/index.js';

// Service Layer
import { ServiceRegistry, ServicePublisher, ServiceBroker } from '../service/index.js';

// Event System
import { EventManager, EventEmitter, EventType, EventPriority, type SystemEvent } from '../events/index.js';

// Coordinators (Phase 1 Refactoring)
import { ResourceCoordinator } from './coordinators/ResourceCoordinator.js';
import { CollaborationCoordinator } from './coordinators/CollaborationCoordinator.js';
import { ServiceExecutionCoordinator } from './coordinators/ServiceExecutionCoordinator.js';
import { DeviceCommandCoordinator } from './coordinators/DeviceCommandCoordinator.js';
import { ACDecisionCoordinator } from './coordinators/ACDecisionCoordinator.js';
import { TaskPlanningCoordinator } from './coordinators/TaskPlanningCoordinator.js';
import { ContextManagementCoordinator } from './coordinators/ContextManagementCoordinator.js';

// AC Decision System
import { DualTriggerACManager, type DualTriggerConfig, type DualTriggerResult } from '../decision/DualTriggerACManager.js';
import { AutonomousDecisionEngine } from '../decision/AutonomousDecisionEngine.js';
import type { ACCollaborationConfig, ACCollaborationGoal, ResourceRequirement } from '../decision/GoalFormulationEngine.js';
import type { AgentProfile } from '../goal/types.js';
import { IntrinsicMotivationEngine } from '../goal/IntrinsicMotivationEngine.js';
import { GoalManager } from '../goal/GoalManager.js';
import type { RoleContext, MotivationLevel, ActionSuggestion } from '../goal/types.js';
import { AgentRoleType } from '../goal/types.js';

// Task Execution System
import { ACExecutor } from '../execution/ACExecutor.js';

// Proposal System
import {
  MultiFactorProposalEvaluator,
  ScoreBasedProposalSelector,
  ServiceLifecycleManager,
  type IProposalEvaluator,
  type IProposalSelector,
} from '../proposal/index.js';
import { CollaborationProposalHandler } from '../proposal/CollaborationProposalHandler.js';

// Context System
import { AgentContextBuilder, type FullAgentContext, type AgentInfo, type DeviceStateInfo, type PeerAgentInfo } from '../context/index.js';

// Planning System
import { TaskPlanner, TaskComplexity, type TaskPlan, type PlanningContext } from '../planning/index.js';

// Workflow System
import { CollaborationWorkflowEngine } from '../workflow/CollaborationWorkflow.js';

// Requirement System
import { RequirementValidator } from '../requirement/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Agent Status
 */
const logger = createLogger('CognitiveAgent');

export enum AgentStatus {
  INITIALIZING = 'initializing',
  IDLE = 'idle',
  BUSY = 'busy',
  ERROR = 'error',
  STOPPED = 'stopped',
}

/**
 * Agent configuration
 */
export interface CognitiveAgentConfig {
  id: string;
  name: string;
  description: string;
  owner: string;
  environment: EnvironmentCenter;
  llmClient: LLMClient;
  capabilities?: string[];
  metadata?: Record<string, any>;
  agentProfile?: AgentProfile;
  dualTriggerConfig?: Partial<DualTriggerConfig>;
}

/**
 * Cognitive Agent
 *
 * Uses coordinator pattern for better maintainability
 * All responsibilities delegated to specialized coordinators
 */
export class CognitiveAgent {
  // Basic properties
  public readonly id: string;
  public name: string;
  public description: string;
  public readonly type = 'cognitive';
  public status: AgentStatus;
  public readonly capabilities: string[];
  public readonly metadata: Record<string, any>;

  // Event System
  public eventManager: EventManager;
  public eventEmitter: EventEmitter;

  // Resource Layer
  public resourceManager: ResourceManager;
  public resourceAllocator: ResourceAllocator;

  // Management Layer
  public taskManager: TaskManager;
  public dialogueManager: DialogueManager;
  public codeGenerator: CodeGenerator;
  public deploymentManager: DeploymentManager;
  public workflowEngine: WorkflowEngine;
  public collaborationManager: CollaborationManager;

  // Service Layer
  public serviceRegistry: ServiceRegistry;
  public servicePublisher: ServicePublisher;
  public serviceBroker: ServiceBroker;

  // Coordinators (Phase 1 Refactoring)
  private resourceCoordinator: ResourceCoordinator;
  private collaborationCoordinator: CollaborationCoordinator;
  private serviceExecutionCoordinator!: ServiceExecutionCoordinator;
  private deviceCommandCoordinator!: DeviceCommandCoordinator;
  private acDecisionCoordinator!: ACDecisionCoordinator;
  private taskPlanningCoordinator!: TaskPlanningCoordinator;
  private contextManagementCoordinator!: ContextManagementCoordinator;

  // AC Decision System
  private dualTriggerACManager?: DualTriggerACManager;
  private dualTriggerEnabled: boolean = false;
  private eventSubscriptionIds: string[] = [];
  // Environment state snapshot (built from ENVIRONMENT_PARAM_CHANGED events)
  private environmentStateSnapshot: Map<string, { value: number | boolean; location: string; timestamp: Date }> = new Map();
  public autonomousDecisionEngine?: AutonomousDecisionEngine;
  private autonomousDecisionsEnabled: boolean = false;

  // Task Execution System
  private acExecutor?: ACExecutor;

  // Planning System
  public taskPlanner: TaskPlanner;

  // Workflow System
  public collaborationWorkflowEngine: CollaborationWorkflowEngine;
  private activeWorkflowId?: string;

  // Requirement System
  public requirementValidator: RequirementValidator;

  // Agent Profile (goal/role system)
  public agentProfile?: AgentProfile;

  // Motivation System
  private motivationEngine?: IntrinsicMotivationEngine;
  private goalManager?: GoalManager;

  // Proposal Handler - Autonomous AC Participation
  public proposalHandler?: CollaborationProposalHandler;

  // Participation Status Tracking
  private participationStatus: Map<string, {
    collaborationId: string;
    role: string;
    capabilities: string[];
    joinedAt: Date;
    status: 'active' | 'withdrawn' | 'completed';
  }> = new Map();

  // Context
  private environment: EnvironmentCenter;
  private llmClient: LLMClient;
  private owner: string;

  constructor(config: CognitiveAgentConfig) {
    logger.info(`[CognitiveAgent:${config.id}] Initializing agent: ${config.name}`);

    // Basic properties
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.status = AgentStatus.INITIALIZING;
    this.capabilities = config.capabilities || ['task-execution', 'code-generation', 'collaboration'];
    this.metadata = config.metadata || {};
    this.owner = config.owner;
    this.environment = config.environment;
    this.llmClient = config.llmClient;
    this.agentProfile = config.agentProfile;

    // Initialize Motivation System if profile provided
    if (config.agentProfile) {
      this.goalManager = new GoalManager(config.id);
      this.motivationEngine = new IntrinsicMotivationEngine(config.agentProfile, this.goalManager);
      logger.info(`[CognitiveAgent:${this.id}] Motivation engine initialized`);
    }

    // Initialize Event System
    this.eventManager = config.environment.eventManager || new EventManager(1000);
    this.eventEmitter = new EventEmitter(this.eventManager, this.id);

    // Emit agent registered event
    this.eventEmitter.emit(EventType.AGENT_REGISTERED, {
      agentId: this.id,
      agentName: this.name,
      capabilities: this.capabilities,
    });

    // Initialize Resource Layer
    this.resourceManager = new ResourceManager();
    this.resourceAllocator = new ResourceAllocator();

    // Initialize Management Layer
    this.taskManager = new TaskManager();
    this.dialogueManager = new DialogueManager();
    this.codeGenerator = new CodeGenerator(this.llmClient);
    this.deploymentManager = new DeploymentManager();
    this.workflowEngine = new WorkflowEngine();
    this.collaborationManager = new CollaborationManager();

    // Initialize Service Layer
    this.serviceRegistry = new ServiceRegistry(this.id);
    this.servicePublisher = new ServicePublisher();
    this.serviceBroker = new ServiceBroker(this.environment);

    // Initialize Coordinators (Phase 1 Refactoring)
    this.resourceCoordinator = new ResourceCoordinator(
      this.resourceManager,
      this.servicePublisher,
      this.serviceRegistry,
      this.environment,
      this.id,
      this.capabilities
    );

    this.collaborationCoordinator = new CollaborationCoordinator(
      this.collaborationManager,
      this.dialogueManager,
      this.eventEmitter,
      this.environment,
      this.id,
      this.name,
      this.capabilities,
      (status: AgentStatus) => { this.status = status; }
    );

    // Initialize AC Decision System components
    this.dualTriggerACManager = new DualTriggerACManager(
      this.id,
      this.name,
      this.capabilities,
      this.llmClient,
      this.environment,
      async (acConfig: ACCollaborationConfig, result: DualTriggerResult) => {
        // Delegate to CollaborationCoordinator for AC initiation
        await this.collaborationCoordinator.handleAutonomousACInitiation(acConfig, result);
      },
      config.dualTriggerConfig ?? {}
    );
    this.autonomousDecisionEngine = new AutonomousDecisionEngine({
      llmClient: this.llmClient,
      environment: this.environment,
      agentId: this.id,
      agentName: this.name,
      agentCapabilities: this.capabilities
    });
    // Auto-enable dual trigger AC (default behavior for autonomous agents)
    this.dualTriggerEnabled = true;
    const proposalEvaluator = new MultiFactorProposalEvaluator(this.llmClient);

    // Initialize Task Execution System components
    this.acExecutor = new ACExecutor();
    this.taskPlanner = new TaskPlanner(this.llmClient);

    // Initialize Context System components
    const agentInfo: AgentInfo = {
      id: this.id,
      name: this.name,
      description: this.description,
      capabilities: this.capabilities,
      metadata: this.metadata,
      status: this.status,
    };
    const contextBuilder = new AgentContextBuilder(
      agentInfo,
      this.resourceManager,
      this.serviceRegistry,
      this.environment,
      this.owner
    );

    // Initialize Workflow System
    this.collaborationWorkflowEngine = new CollaborationWorkflowEngine(this.serviceBroker);

    // Initialize Requirement System
    this.requirementValidator = new RequirementValidator();

    // Initialize new Coordinators
    // Service Layer - handles cross-agent service requests
    this.serviceExecutionCoordinator = new ServiceExecutionCoordinator(
      this.serviceBroker,
      this.serviceRegistry,
      this.environment,
      this.eventEmitter,
      this.id
    );

    // Device Layer - handles device commands
    this.deviceCommandCoordinator = new DeviceCommandCoordinator(
      this.resourceManager,
      this.eventEmitter,
      this.id
    );

    this.acDecisionCoordinator = new ACDecisionCoordinator(
      this.dualTriggerACManager,
      this.autonomousDecisionEngine,
      this.eventEmitter,
      this.id,
      proposalEvaluator
    );

    this.taskPlanningCoordinator = new TaskPlanningCoordinator(
      this.acExecutor,
      this.taskPlanner,
      this.taskManager,
      contextBuilder,
      this.eventEmitter,
      this.id,
      this.name
    );

    this.contextManagementCoordinator = new ContextManagementCoordinator(
      contextBuilder,
      this.eventEmitter,
      this.id,
      agentInfo
    );

    // Initialize CollaborationProposalHandler for autonomous AC participation
    const proposalHandlerConfig = {
      enabled: true,
      criteria: {
        minBenefitThreshold: 0.5,
        maxCostThreshold: 0.7,
      },
      autoExecuteAccepted: true,
      notifyAllProposals: false,
      maxConcurrentCollaborations: 5,
    };

    this.proposalHandler = new CollaborationProposalHandler({
      llmClient: this.llmClient,
      environment: this.environment,
      agentId: this.id,
      agentName: this.name,
      agentCapabilities: this.capabilities,
      config: proposalHandlerConfig,
    });

    // Set agent reference so handler can call joinCollaboration() on acceptance
    this.proposalHandler.setAgent(this);

    logger.info(`[CognitiveAgent:${this.id}] CollaborationProposalHandler initialized`);

    // Register with environment
    this.environment.registerAgent(this as unknown as Record<string, unknown> & { id: string; name: string }, this.owner);

    logger.info(`[CognitiveAgent:${this.id}] Agent initialized with all coordinators`);
    this.status = AgentStatus.IDLE;
  }

  // ==================== Lifecycle Management ====================

  /**
   * Start the agent
   */
  start(): void {
    logger.info(`[CognitiveAgent:${this.id}] Starting agent`);
    this.status = AgentStatus.IDLE;

    // Start CollaborationProposalHandler to listen for proposals
    if (this.proposalHandler) {
      this.proposalHandler.start();
      logger.info(`[CognitiveAgent:${this.id}] ProposalHandler started`);
    }

    logger.info(`[CognitiveAgent:${this.id}] Agent started`);
  }

  /**
   * Stop the agent and release all resources
   */
  stop(): void {
    logger.info(`[CognitiveAgent:${this.id}] Stopping agent`);

    // Stop CollaborationProposalHandler
    if (this.proposalHandler) {
      this.proposalHandler.stop();
      logger.info(`[CognitiveAgent:${this.id}] ProposalHandler stopped`);
    }

    // Unsubscribe from all event subscriptions to prevent memory leaks
    if (this.eventManager && this.eventSubscriptionIds.length > 0) {
      for (const subId of this.eventSubscriptionIds) {
        try {
          this.eventManager.unsubscribe(subId);
        } catch {
          // Subscription may no longer exist
        }
      }
      this.eventSubscriptionIds = [];
      logger.info(`[CognitiveAgent:${this.id}] Event subscriptions cleaned up`);
    }

    // Also use unsubscribeAll as a safety net to catch any subscriptions
    // that might not be tracked in eventSubscriptionIds
    if (this.eventManager) {
      try {
        this.eventManager.unsubscribeAll(this.id);
      } catch {
        // EventManager may not support this method
      }
    }

    // Clear internal Maps to release memory
    this.environmentStateSnapshot.clear();
    this.participationStatus.clear();
    logger.info(`[CognitiveAgent:${this.id}] Internal maps cleared`);

    // Destroy DualTriggerACManager to release its subscriptions and internal state
    if (this.dualTriggerACManager) {
      this.dualTriggerACManager.destroy();
      logger.info(`[CognitiveAgent:${this.id}] DualTriggerACManager destroyed`);
    }

    // Clear ServicePublisher heartbeats to prevent lingering timers
    if (this.servicePublisher) {
      this.servicePublisher.clear();
      logger.info(`[CognitiveAgent:${this.id}] ServicePublisher cleared`);
    }

    this.status = AgentStatus.STOPPED;
    logger.info(`[CognitiveAgent:${this.id}] Agent stopped`);
  }

  // ==================== Device/Resource Management (Delegated to ResourceCoordinator) ====================

  /**
   * Assign devices to this agent
   * Delegates to ResourceCoordinator
   */
  assignDevices(devices: Device[], owner: string): void {
    logger.info(`[CognitiveAgent:${this.id}] Assigning ${devices.length} devices`);
    this.resourceCoordinator.assignDevices(devices, owner);
    logger.info(`[CognitiveAgent:${this.id}] Devices assigned. Total: ${this.resourceManager.getCount()}`);

    // Sync device info to DualTriggerACManager so AC decisions use agent's actual devices
    if (this.dualTriggerACManager) {
      const deviceInfos = this.resourceManager.getAllResources().map(r => ({
        deviceId: r.id,
        type: r.getMetadata?.()?.type || 'unknown',
        capabilities: r.getCapabilities().map(c => c.name || String(c)),
      }));
      this.dualTriggerACManager.setAgentDevices(deviceInfos);
    }

    // Re-subscribe to events now that we have devices (adds device event subscriptions)
    if (this.eventManager) {
      this.setEventManager(this.eventManager);
    }
  }

  /**
   * Register a device by ID
   * Looks up the device in the environment and assigns it to this agent
   */
  registerDevice(deviceId: string): void {
    logger.info(`[CognitiveAgent:${this.id}] Registering device: ${deviceId}`);
    const device = this.environment.getDevice(deviceId);
    if (device) {
      this.assignDevices([device], this.owner);
    } else {
      logger.warn(`[CognitiveAgent:${this.id}] Device ${deviceId} not found in environment`);
    }
  }

  // ==================== Collaboration Management (Delegated to CollaborationCoordinator) ====================

  /**
   * Withdraw from a collaboration
   * Delegates to CollaborationCoordinator
   */
  async withdrawFromCollaboration(
    collaborationId: string,
    reason: string,
    gracefulPeriod?: number
  ): Promise<{ success: boolean; withdrawalId?: string; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Withdrawing from collaboration ${collaborationId}`);
    return this.collaborationCoordinator.withdrawFromCollaboration(
      collaborationId,
      reason,
      gracefulPeriod
    );
  }

  /**
   * Propose dissolution of a collaboration
   * Delegates to CollaborationCoordinator
   */
  async proposeDissolution(
    collaborationId: string,
    reason: string,
    voteThreshold?: number
  ): Promise<{ success: boolean; proposalId?: string; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Proposing dissolution of collaboration ${collaborationId}`);
    return this.collaborationCoordinator.proposeDissolution(
      collaborationId,
      reason,
      voteThreshold
    );
  }

  /**
   * Vote on dissolution of a collaboration
   * Delegates to CollaborationCoordinator
   */
  async voteOnDissolution(
    proposalId: string,
    vote: boolean,
    reason?: string
  ): Promise<{ success: boolean; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Voting ${vote ? 'YES' : 'NO'} on dissolution ${proposalId}`);
    if (reason) {
      logger.info(`[CognitiveAgent:${this.id}] Reason: ${reason}`);
    }
    return this.collaborationCoordinator.voteOnDissolution(proposalId, vote);
  }

  /**
   * Get active collaborations
   */
  getActiveCollaborations(): Array<{ id: string; name: string; status: string }> {
    const sessions = this.collaborationManager.getActiveSessions(this.id);
    return sessions.map(session => ({
      id: session.id,
      name: session.description || 'Unnamed Collaboration',
      status: session.status,
    }));
  }

  // ==================== Service Execution ====================

  /**
   * Execute a command on a device
   * Device Layer operation - executes basic device commands
   */
  async executeDeviceCommand(
    deviceId: string,
    commandName: string,
    params?: any
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Executing command ${commandName} on device ${deviceId}`);

    try {
      // Delegate to DeviceCommandCoordinator (Device Layer)
      const result = await this.deviceCommandCoordinator.executeCommand(
        deviceId,
        commandName,
        params
      );
      return result;
    } catch (error) {
      logger.error(`[CognitiveAgent:${this.id}] Command execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }


  /**
   * Execute a capability on a device resource
   * Resource Layer operation - executes semantic capabilities on device resources
   *
   * Architecture:
   * - Agent owns Device Resources (wrappers around Devices)
   * - Resource provides semantic capability mapping to device commands
   * - Examples: 'air-purification' → 'set-mode', 'hvac' → 'set-temperature'
   * - This is NOT a Service operation! Services are Agent-level abstractions.
   *
   * @param deviceId - The device ID
   * @param capability - Semantic capability name (e.g., 'air-purification', 'temperature-control')
   * @param parameters - Optional execution parameters
   * @returns Execution result
   */
  async executeDeviceCapability(
    deviceId: string,
    capability: string,
    parameters: Record<string, any> = {}
  ): Promise<{
    success: boolean;
    result?: any;
    error?: string;
  }> {
    logger.info(`[CognitiveAgent:${this.id}] Executing capability '${capability}' on device resource ${deviceId}`);

    try {
      // Get the resource from ResourceManager
      const resource = this.resourceManager.getResource(deviceId);
      if (!resource) {
        const error = `Device ${deviceId} not found in agent resources`;
        logger.error(`[CognitiveAgent:${this.id}] ${error}`);
        return { success: false, error };
      }

      // Execute semantic capability through Resource layer
      // Resource will map semantic capability to device command
      const result = await resource.execute(capability, parameters);

      logger.info(`[CognitiveAgent:${this.id}] Capability execution result:`, result.success ? 'SUCCESS' : 'FAILED');

      return {
        success: result.success,
        result: result.result,
        error: result.error,
      };
    } catch (error) {
      logger.error(`[CognitiveAgent:${this.id}] Capability execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Request a service from another agent
   * Simplified implementation for TempCognitiveAgent
   */
  async requestService(
    targetAgentId: string,
    serviceId: string,
    parameters?: any
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Requesting service ${serviceId} from agent ${targetAgentId}`);

    try {
      // Delegate to ServiceExecutionCoordinator
      const result = await this.serviceExecutionCoordinator.requestService(
        targetAgentId,
        serviceId,
        parameters
      );
      return result;
    } catch (error) {
      logger.error(`[CognitiveAgent:${this.id}] Service request failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Observe environment parameters
   */
  async observeEnvironment(parameterNames: string[] = []): Promise<Record<string, any>> {
    logger.info(`[CognitiveAgent:${this.id}] Observing environment parameters: ${parameterNames.join(', ')}`);

    const observations: Record<string, any> = {};

    // Get observations from environment
    for (const paramName of parameterNames) {
      const value = await this.environment.getParameter(paramName);
      if (value !== undefined) {
        observations[paramName] = value;
      }
    }

    logger.info(`[CognitiveAgent:${this.id}] Observations:`, observations);
    return observations;
  }

  // ==================== Event Handling ====================

  /**
   * Set the environment's EventManager and subscribe to events
   * Called by EnvironmentCenter during agent registration
   */
  setEventManager(eventManager: EventManager): void {
    logger.info(`[CognitiveAgent:${this.id}] Setting EventManager and subscribing to events`);

    // Unsubscribe from existing subscriptions first to avoid duplicates
    for (const subId of this.eventSubscriptionIds) {
      try {
        eventManager.unsubscribe(subId);
      } catch {
        // Subscription may no longer exist
      }
    }
    this.eventSubscriptionIds = [];

    // Device-related event types - only subscribe if agent has devices assigned
    const deviceEventTypes = [
      EventType.DEVICE_STATE_CHANGE,
      EventType.DEVICE_STATE_UPDATE,
    ];

    // Non-device event types - always subscribe
    const generalEventTypes = [
      EventType.AGENT_TASK_ASSIGNED,
      EventType.ENVIRONMENT_PARAM_CHANGED,
      EventType.COLLABORATION_MESSAGE,
      EventType.COLLABORATION_PROPOSAL,
      EventType.COLLABORATION_STARTED,
      EventType.COLLABORATION_COMPLETED,
    ];

    const hasDevices = this.resourceManager.getCount() > 0;
    const eventTypesToSubscribe = hasDevices
      ? [...deviceEventTypes, ...generalEventTypes]
      : generalEventTypes;

    for (const eventType of eventTypesToSubscribe) {
      const subId = eventManager.subscribe({
        subscriberId: this.id,
        eventType,
        handler: async (event: SystemEvent) => {
          try {
            await this.handleEvent(event);
          } catch (error) {
            logger.error(`[CognitiveAgent:${this.id}] Error handling event ${event.type}:`, error);
          }
        },
      });
      this.eventSubscriptionIds.push(subId);
    }

    logger.info(`[CognitiveAgent:${this.id}] Subscribed to ${eventTypesToSubscribe.length} event types (devices: ${hasDevices})`);
  }

  /**
   * Handle incoming event
   * Routes events through the DualTriggerACManager for AC decision-making
   */
  async handleEvent(event: SystemEvent): Promise<void> {
    logger.info(`[CognitiveAgent:${this.id}] Handling event: ${event.type}`);

    // Note: Do NOT re-emit via eventEmitter.emit() here as that would
    // re-publish to EventManager causing an infinite loop.

    // Maintain environment state snapshot from ENVIRONMENT_PARAM_CHANGED events
    // This snapshot grows with unique location:parameter combinations.
    // Old entries are overwritten when the same location:parameter changes,
    // preventing unbounded growth for typical IoT scenarios.
    if (event.type === EventType.ENVIRONMENT_PARAM_CHANGED) {
      const payload = event.payload;
      if (payload?.parameter && payload?.location !== undefined) {
        this.environmentStateSnapshot.set(
          `${payload.location}:${payload.parameter}`,
          { value: payload.newValue, location: payload.location, timestamp: event.timestamp }
        );
      }
    }

    // Feedback bridge: Record collaboration outcomes into DualTriggerACManager.
    // CognitiveAgent owns the subscription (not DualTriggerACManager) to avoid
    // the architecture violation where DualTriggerACManager directly subscribed
    // to CollaborationManager's EventManager.
    if (event.type === EventType.COLLABORATION_COMPLETED) {
      if (this.dualTriggerACManager) {
        try {
          this.dualTriggerACManager.recordCollaborationOutcome(event.payload);
          logger.info(`[CognitiveAgent:${this.id}] Recorded collaboration outcome via feedback bridge`);
        } catch (error) {
          logger.error(`[CognitiveAgent:${this.id}] Error recording collaboration outcome:`, error);
        }
      }
    }

    // Route through DualTriggerACManager if enabled
    // Only route ENVIRONMENT_PARAM_CHANGED events — these are the only events
    // that represent real-world physical changes requiring AC decisions.
    // Collaboration system events (STARTED, COMPLETED, MESSAGE) are NOT
    // environmental triggers and must NOT enter the dual-trigger pipeline,
    // otherwise they cause cascading spurious AC initiations with zone="unknown".
    const isEnvironmentalTrigger = event.type === EventType.ENVIRONMENT_PARAM_CHANGED;

    if (this.dualTriggerACManager && this.dualTriggerEnabled && isEnvironmentalTrigger) {
      try {
        const result = await this.dualTriggerACManager.processEvent(event);
        logger.info(`[CognitiveAgent:${this.id}] DualTrigger result: path=${result.path}`);
      } catch (error) {
        logger.error(`[CognitiveAgent:${this.id}] DualTrigger processing error:`, error);
      }
    }

    logger.info(`[CognitiveAgent:${this.id}] Event handled`);
  }

  /**
   * Get environment state snapshot as a readonly array.
   * Returns entries from the internal snapshot built from ENVIRONMENT_PARAM_CHANGED events.
   * Each entry contains key, value, location, and timestamp.
   */
  getEnvironmentStateSnapshot(): ReadonlyArray<{
    key: string;
    value: number | boolean;
    location: string;
    timestamp: Date;
  }> {
    return Array.from(this.environmentStateSnapshot.entries()).map(([key, val]) => ({
      key,
      value: val.value,
      location: val.location,
      timestamp: val.timestamp,
    }));
  }

  /**
   * Get whether dual-trigger AC is enabled
   */
  getDualTriggerEnabled(): boolean {
    return this.dualTriggerEnabled;
  }

  /**
   * Get current environment state from snapshot
   * Built from ENVIRONMENT_PARAM_CHANGED events received by this agent
   */
  getEnvironmentState(parameter?: string, location?: string): Record<string, unknown> {
    if (parameter && location) {
      const entry = this.environmentStateSnapshot.get(`${location}:${parameter}`);
      return entry ? { value: entry.value, timestamp: entry.timestamp } : {};
    }
    const result: Record<string, unknown> = {};
    for (const [key, val] of this.environmentStateSnapshot) {
      result[key] = val;
    }
    return result;
  }

  // ==================== Communication ====================

  /**
   * Communicate with another agent
   */
  async communicateWithAgent(
    targetAgentId: string,
    message: string,
    messageType: MessageType = MessageType.NOTIFICATION,
    priority: MessagePriority = MessagePriority.NORMAL
  ): Promise<void> {
    logger.info(`[CognitiveAgent:${this.id}] Communicating with agent ${targetAgentId}`);

    this.dialogueManager.sendMessage(
      this.id,
      targetAgentId,
      messageType,
      'Agent Communication',
      message,
      { priority }
    );

    logger.info(`[CognitiveAgent:${this.id}] Message sent`);
  }

  // ==================== Metadata Management ====================

  /**
   * Get agent statistics
   */
  getStats(): {
    status: string;
    deviceCount: number;
    serviceCount: number;
    collaborationCount: number;
  } {
    return {
      status: this.status,
      deviceCount: this.resourceManager.getCount(),
      serviceCount: this.serviceRegistry.getServiceCount(),
      collaborationCount: this.getActiveCollaborations().length,
    };
  }

  /**
   * Get agent information
   */
  getInfo(): {
    id: string;
    name: string;
    description: string;
    type: string;
    status: string;
    capabilities: string[];
    owner: string;
  } {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      type: this.type,
      status: this.status,
      capabilities: this.capabilities,
      owner: this.owner,
    };
  }

  /**
   * Update agent name
   */
  updateName(name: string): void {
    logger.info(`[CognitiveAgent:${this.id}] Updating name to: ${name}`);
    this.name = name;
  }

  /**
   * Update agent metadata
   */
  updateMetadata(updates: Record<string, any>): void {
    logger.info(`[CognitiveAgent:${this.id}] Updating metadata`);
    Object.assign(this.metadata, updates);
  }

  // ==================== Motivation & Goal System ====================

  /**
   * Get current motivation level
   * Uses IntrinsicMotivationEngine to calculate based on profile and context
   */
  async getCurrentMotivation(): Promise<MotivationLevel> {
    if (!this.motivationEngine || !this.agentProfile) {
      return {
        overall: 0.5,
        urgency: 0,
        confidence: 0.5,
        shouldAct: false,
        reason: 'No motivation engine configured',
      };
    }

    const context = this.buildRoleContext();
    return this.motivationEngine.calculateMotivation(context);
  }

  /**
   * Check if agent should act on an event
   * Evaluates motivation and context to determine action necessity
   */
  async shouldActOnEvent(event: SystemEvent): Promise<boolean> {
    if (!this.motivationEngine || !this.agentProfile) {
      // Default: act on high-priority events
      return event.priority === 'urgent' || event.priority === 'high';
    }

    const motivation = await this.getCurrentMotivation();
    return motivation.shouldAct || motivation.overall > 0.6;
  }

  /**
   * Get action suggestion
   * Uses IntrinsicMotivationEngine to suggest the best action
   */
  async getActionSuggestion(): Promise<ActionSuggestion | null> {
    if (!this.motivationEngine || !this.agentProfile) {
      return null;
    }

    const context = this.buildRoleContext();
    return this.motivationEngine.suggestAction(context);
  }

  /**
   * Build RoleContext for motivation engine
   */
  private buildRoleContext(): RoleContext {
    return {
      role: this.agentProfile?.role || AgentRoleType.GENERAL,
      profile: this.agentProfile!,
      availableResources: [],
      knownCapabilities: this.capabilities,
      activeGoals: this.agentProfile?.primaryGoals || [],
      pastExperiences: [],
      lastUpdated: new Date(),
    };
  }

  /**
   * Export experiment data for benchmarking and analysis
   * Returns motivation engine logs, AC trigger correlations, and goal history
   */
  exportExperimentData(): Record<string, any> {
    return {
      agentId: this.id,
      agentName: this.name,
      agentProfile: this.agentProfile,
      stats: this.getStats(),
      dualTriggerStats: this.getDualTriggerStats(),
      motivationEngine: this.motivationEngine?.getExperimentLog?.() || [],
      acTriggerCorrelations: this.motivationEngine?.getACTriggerCorrelations?.() || [],
      goalHistory: this.goalManager?.getAllGoals?.() || [],
      activeCollaborations: this.getActiveCollaborations(),
      exportedAt: new Date(),
    };
  }


  // ==================== AC Decision System (Delegated to ACDecisionCoordinator) ====================

  /**
   * Enable autonomous decisions
   * Enables the autonomous decision engine for agent self-governance
   */
  enableAutonomousDecisions(config?: {
    confidenceThreshold?: number;
    maxConcurrentTasks?: number;
    learningEnabled?: boolean;
    enableAutoLLMProcessing?: boolean;
  }): void {
    logger.info(`[CognitiveAgent:${this.id}] Enabling autonomous decisions`);
    this.autonomousDecisionsEnabled = true;

    // Configure AutonomousDecisionEngine if available
    if (this.autonomousDecisionEngine && config) {
      const engineConfig: Record<string, unknown> = {};
      if (config.confidenceThreshold !== undefined) {
        engineConfig.confidenceThreshold = config.confidenceThreshold;
      }
      if (config.enableAutoLLMProcessing !== undefined) {
        engineConfig.enableAutoLLMProcessing = config.enableAutoLLMProcessing;
      }
      if (Object.keys(engineConfig).length > 0) {
        this.autonomousDecisionEngine.updateConfig(engineConfig);
      }
      logger.info(`[CognitiveAgent:${this.id}] Autonomous decision engine configured`);
    }
  }

  /**
   * Disable autonomous decisions
   * Disables autonomous decision-making capabilities
   */
  disableAutonomousDecisions(): void {
    logger.info(`[CognitiveAgent:${this.id}] Disabling autonomous decisions`);
    this.autonomousDecisionsEnabled = false;
  }

  /**
   * Check if autonomous decisions are enabled
   */
  isAutonomousDecisionsEnabled(): boolean {
    return this.autonomousDecisionsEnabled;
  }

  // ==================== AC Decision System (Delegated to ACDecisionCoordinator) ====================

  /**
   * Enable dual trigger AC
   * Delegates to ACDecisionCoordinator
   */
  enableDualTriggerAC(config?: DualTriggerConfig): void {
    logger.info(`[CognitiveAgent:${this.id}] Enabling dual trigger AC`);
    this.dualTriggerEnabled = true;
    this.acDecisionCoordinator.enableDualTriggerAC(config);
  }

  /**
   * Formulate AC collaboration goal
   * Delegates to ACDecisionCoordinator
   */
  async formulateGoal(requirements: ResourceRequirement[]): Promise<ACCollaborationGoal> {
    logger.info(`[CognitiveAgent:${this.id}] Formulating AC goal`);
    return this.acDecisionCoordinator.formulateGoal(requirements);
  }

  /**
   * Evaluate collaboration proposal
   * Delegates to ACDecisionCoordinator
   */
  async evaluateProposal(proposal: Record<string, unknown>): Promise<{score: number; recommendation: string}> {
    logger.info(`[CognitiveAgent:${this.id}] Evaluating proposal`);
    return this.acDecisionCoordinator.evaluateProposal(proposal);
  }

  /**
   * Check if should trigger AC
   * Delegates to ACDecisionCoordinator
   */
  async shouldTriggerAC(context: Record<string, unknown>): Promise<boolean> {
    logger.info(`[CognitiveAgent:${this.id}] Checking if should trigger AC`);
    return this.acDecisionCoordinator.shouldTriggerAC(context);
  }

  /**
   * Get the DualTriggerACManager instance
   * Used for accessing AC triggering stats and status
   */
  getDualTriggerACManager(): DualTriggerACManager | undefined {
    return this.dualTriggerACManager;
  }

  /**
   * Get dual trigger AC statistics
   * Returns stats from the DualTriggerACManager
   */
  getDualTriggerStats(): {
    totalEventsProcessed: number;
    filteredByLayer1: number;
    passedToLayer2: number;
    acDecisionMade: number;
    acInitiated: number;
    handledIndependently: number;
    deferred: number;
  } {
    if (!this.dualTriggerACManager) {
      return {
        totalEventsProcessed: 0,
        filteredByLayer1: 0,
        passedToLayer2: 0,
        acDecisionMade: 0,
        acInitiated: 0,
        handledIndependently: 0,
        deferred: 0,
      };
    }
    return this.dualTriggerACManager.getStats();
  }

  // ==================== Task Execution System (Delegated to TaskPlanningCoordinator) ====================

  /**
   * Execute a task
   * Delegates to TaskPlanningCoordinator
   */
  async executeTask(taskId: string): Promise<any> {
    logger.info(`[CognitiveAgent:${this.id}] Executing task: ${taskId}`);
    return this.taskPlanningCoordinator.executeTask(taskId);
  }

  /**
   * Plan a task
   * Delegates to TaskPlanningCoordinator
   */
  async planTask(goal: string, context?: PlanningContext): Promise<any> {
    logger.info(`[CognitiveAgent:${this.id}] Planning task for goal: ${goal}`);
    return this.taskPlanningCoordinator.planTask(goal, context);
  }

  /**
   * Get active tasks
   * Delegates to TaskPlanningCoordinator
   */
  getActiveTasks(): any[] {
    return this.taskPlanningCoordinator.getActiveTasks();
  }

  /**
   * Evaluate task complexity
   * Delegates to TaskPlanningCoordinator
   */
  async evaluateTaskComplexity(task: any): Promise<any> {
    logger.info(`[CognitiveAgent:${this.id}] Evaluating task complexity`);
    return this.taskPlanningCoordinator.evaluateTaskComplexity(task);
  }

  /**
   * Process a high-level request string through the planning and execution pipeline.
   * This is the primary entry point for external callers (e.g., simulation, API)
   * to submit natural language requests to the agent.
   *
   * Delegates to TaskPlanner for planning and then executes the resulting plan.
   */
  async processRequest(
    request: string,
    context: Record<string, any> = {}
  ): Promise<{
    success: boolean;
    response: string;
    result?: any;
    actionsTaken?: Array<{
      deviceId: string;
      action: string;
      result: any;
    }>;
  }> {
    logger.info(`[CognitiveAgent:${this.id}] Processing request: ${request.substring(0, 100)}...`);

    this.status = AgentStatus.BUSY;

    try {
      // Build context for planning
      const fullContext = await this.contextManagementCoordinator.buildFullContext();

      const planningContext: PlanningContext = {
        agentId: this.id,
        agentName: this.name,
        agentCapabilities: this.capabilities,
        resources: fullContext.resources.map((r: DeviceStateInfo) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          capabilities: r.capabilities,
          location: r.location
        })),
        environmentType: fullContext.environment.type,
        peerAgents: fullContext.peerAgents.map((a: PeerAgentInfo) => ({
          id: a.id,
          name: a.name,
          capabilities: a.capabilities
        })),
        acContext: {
          availableAgents: fullContext.peerAgents.map((a: PeerAgentInfo) => ({
            id: a.id,
            name: a.name,
            capabilities: a.capabilities
          })),
          collaborationEnabled: true
        },
        fullContext: fullContext
      };

      // Plan the task
      const taskPlan = await this.taskPlanner.plan(request, planningContext);

      // If plan requires collaboration, trigger AC flow
      if (taskPlan.executionStrategy === 'collaborative' && this.acDecisionCoordinator) {
        logger.info(`[CognitiveAgent:${this.id}] Plan requires collaboration, triggering AC...`);
      }

      // Execute subtasks
      const actionsTaken: Array<{
        deviceId: string;
        action: string;
        result: any;
      }> = [];

      if (taskPlan.subtasks && Array.isArray(taskPlan.subtasks)) {
        for (const subtask of taskPlan.subtasks) {
          try {
            const result = await this.executeDeviceCommand(subtask.id, subtask.description, {});
            actionsTaken.push({
              deviceId: subtask.id,
              action: subtask.description,
              result: result
            });
          } catch (actionError: unknown) {
            logger.warn(`[CognitiveAgent:${this.id}] Subtask failed: ${actionError instanceof Error ? actionError.message : String(actionError)}`);
            actionsTaken.push({
              deviceId: subtask.id,
              action: subtask.description,
              result: { error: actionError instanceof Error ? actionError.message : String(actionError) }
            });
          }
        }
      }

      this.status = AgentStatus.IDLE;

      return {
        success: true,
        response: taskPlan.summary || taskPlan.reasoningTrace || `Processed: ${request}`,
        result: taskPlan,
        actionsTaken: actionsTaken.length > 0 ? actionsTaken : undefined,
      };
    } catch (error: unknown) {
      this.status = AgentStatus.IDLE;
      logger.error(`[CognitiveAgent:${this.id}] processRequest error: ${error instanceof Error ? error.message : String(error)}`);
      return {
        success: false,
        response: `Error processing request: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ==================== Context Management (Delegated to ContextManagementCoordinator) ====================

  /**
   * Build full context
   * Delegates to ContextManagementCoordinator
   */
  async buildContext(): Promise<FullAgentContext> {
    logger.info(`[CognitiveAgent:${this.id}] Building full context`);
    return this.contextManagementCoordinator.buildFullContext();
  }

  /**
   * Get agent info
   * Delegates to ContextManagementCoordinator
   */
  getAgentInfo(): AgentInfo {
    return this.contextManagementCoordinator.getAgentInfo();
  }

  // ==================== Autonomous AC Participation ====================

  /**
   * Join an Active Collaboration autonomously
   *
   * CRITICAL ARCHITECTURE PRINCIPLE:
   * - Agent makes INDEPENDENT decision to join
   * - CollaborationManager is NOTIFIED, not requesting
   * - This method is called AFTER agent has evaluated and accepted proposal
   *
   * @param collaborationId - ID of the collaboration to join
   * @param options - Participation options (role, capabilities, etc.)
   * @returns Result of join operation
   */
  async joinCollaboration(
    collaborationId: string,
    options: {
      role: string;
      capabilities?: string[];
      metadata?: Record<string, any>;
    },
    externalCollaborationManager?: CollaborationManager
  ): Promise<{
    success: boolean;
    collaborationId: string;
    role: string;
    error?: string;
  }> {
    logger.info(`[CognitiveAgent:${this.id}] Autonomously joining collaboration ${collaborationId}`);
    logger.info(`[CognitiveAgent:${this.id}] Role: ${options.role}`);

    try {
      // Track participation status
      const participation = {
        collaborationId,
        role: options.role,
        capabilities: options.capabilities || this.capabilities,
        joinedAt: new Date(),
        status: 'active' as const,
      };

      this.participationStatus.set(collaborationId, participation);

      // Notify CollaborationManager that agent has joined
      // NOTE: Agent notifies CM, CM doesn't control agent
      // If an external CM is provided (e.g., from the collaboration initiator), use it;
      // otherwise fall back to the agent's own internal CM.
      const cm = externalCollaborationManager || this.collaborationManager;

      // Check if the session exists; if not, create it with the specified collaborationId
      // This happens when an agent accepts a proposal for a collaboration that
      // was initiated by another agent and the session ID is from the proposal.
      let session = cm.getSession(collaborationId);
      if (!session) {
        // Include both the initiator (from proposal metadata) and this agent as initial participants
        const initiatorId = options.metadata?.proposedBy || this.id;
        const initialParticipants = initiatorId === this.id
          ? [this.id]
          : [initiatorId, this.id];

        logger.info(`[CognitiveAgent:${this.id}] Session ${collaborationId} not found, creating new session`);
        session = cm.createSessionWithId(
          collaborationId,
          'service-composition',
          initialParticipants,
          initiatorId,
          CollaborationPriority.HIGH,
          options.metadata?.proposalId
            ? `Collaboration from proposal ${options.metadata.proposalId}`
            : `Active Collaboration ${collaborationId}`,
          [],
        );

        // Track AC state lifecycle for the new session
        await cm.trackACState(collaborationId, ACState.CREATED, 'Session created by joining agent');
        await cm.trackACState(collaborationId, ACState.INITIALIZING, 'Agent joining collaboration');

        // Publish COLLABORATION_STARTED event so other agents/listeners know
        this.eventEmitter.emit(EventType.COLLABORATION_STARTED, {
          acId: collaborationId,
          sessionId: collaborationId,
          collaborationId: collaborationId,
          initiatorId,
          participants: initialParticipants,
        });
      }

      const addResult = cm.addParticipant(collaborationId, this.id, {
        role: options.role,
        capabilities: participation.capabilities,
        joinedAt: participation.joinedAt,
      });

      if (!addResult.success) {
        logger.warn(`[CognitiveAgent:${this.id}] Failed to add participant to CM: ${addResult.error}`);
      }

      logger.info(`[CognitiveAgent:${this.id}] Successfully joined collaboration ${collaborationId}`);

      return {
        success: true,
        collaborationId,
        role: options.role,
      };
    } catch (error) {
      logger.error(`[CognitiveAgent:${this.id}] Failed to join collaboration:`, error);
      return {
        success: false,
        collaborationId,
        role: options.role,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get participation status for a collaboration
   *
   * @param collaborationId - Collaboration ID to query
   * @returns Participation status or undefined if not participating
   */
  getParticipationStatus(collaborationId: string): {
    collaborationId: string;
    role: string;
    capabilities: string[];
    joinedAt: Date;
    status: 'active' | 'withdrawn' | 'completed';
  } | undefined {
    return this.participationStatus.get(collaborationId);
  }

  /**
   * Get all active participations
   *
   * @returns Array of active participation statuses
   */
  getActiveParticipations(): Array<{
    collaborationId: string;
    role: string;
    capabilities: string[];
    joinedAt: Date;
    status: 'active' | 'withdrawn' | 'completed';
  }> {
    return Array.from(this.participationStatus.values()).filter(
      (p) => p.status === 'active'
    );
  }

  /**
   * Leave a collaboration
   *
   * @param collaborationId - Collaboration to leave
   * @param reason - Reason for leaving
   */
  async leaveCollaboration(
    collaborationId: string,
    reason: string
  ): Promise<{ success: boolean; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Leaving collaboration ${collaborationId}`);
    logger.info(`[CognitiveAgent:${this.id}] Reason: ${reason}`);

    const participation = this.participationStatus.get(collaborationId);
    if (!participation) {
      return {
        success: false,
        error: 'Not participating in this collaboration',
      };
    }

    // Update participation status
    participation.status = 'withdrawn';

    // Use existing withdraw mechanism
    const result = await this.withdrawFromCollaboration(collaborationId, reason);

    return {
      success: result.success,
      error: result.error,
    };
  }
}
