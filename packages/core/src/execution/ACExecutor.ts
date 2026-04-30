/**
 * AC Executor - Active Collaboration Execution Engine
 *
 * This is the CORE engine that makes Active Collaborations ACTUALLY WORK.
 * It executes multi-agent collaborations with real device control and environment effects.
 *
 * Key responsibilities:
 * 1. Initialize and coordinate participant agents
 * 2. Execute collaboration goals through agent coordination
 * 3. Make agents control devices to affect environment
 * 4. Track execution progress and results
 * 5. Monitor and log the entire execution process
 */

import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import type { Device } from '@active-collaboration/shared';
import { CollaborationManager, ACState } from '../management/CollaborationManager.js';
import { ServiceBroker } from '../service/ServiceBroker.js';
import { MessageType, MessagePriority } from '../management/DialogueManager.js';
import { TaskPriority, TaskStatus } from '../management/TaskManager.js';
import { EventType, EventPriority } from '../events/index.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * AC Collaboration Configuration
 * Defines what the collaboration should accomplish
 */
const logger = createLogger('ACExecutor');

export interface ACCollaborationConfig {
  id: string;
  name: string;
  description: string;
  environment: EnvironmentCenter;

  // Participant agents
  participantAgentIds: string[];
  collaborationManager: CollaborationManager;

  // Goals and tasks
  goals: ACCollaborationGoal[];

  // Optional constraints
  maxDuration?: number; // milliseconds
  timeout?: number; // milliseconds per task
}

/**
 * AC Collaboration Goal
 * A specific goal the collaboration should achieve
 */
export interface ACCollaborationGoal {
  id: string;
  description: string;
  targetDevices: string[]; // Device IDs involved
  targetAgents: string[]; // Agent IDs responsible
  requiredCapabilities: string[];
  successCriteria: ACCSuccessCriterion[];
  priority: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * AC Success Criterion
 * Defines when a goal is considered achieved
 */
export interface ACCSuccessCriterion {
  id?: string;
  type: 'device-state' | 'environment-parameter' | 'task-completion' | 'time-bound' | 'metric-threshold' | 'custom';
  target: string; // device ID, parameter name, or custom identifier
  condition: string; // e.g., "state == 'on'", "temperature < 25", "count >= 5"
  threshold?: number; // Optional numeric threshold
  operator?: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'exists';
  deadline?: Date; // Optional deadline for time-bound criteria
}

/**
 * AC Execution Result
 * The complete outcome of an AC execution
 */
export interface ACExecutionResult {
  collaborationId: string;
  success: boolean;
  finalState: ACState;
  startTime: Date;
  endTime: Date;
  duration: number;

  // Goals achievement
  goalsAchieved: string[];
  goalsFailed: string[];
  goalsInProgress: string[];

  // Device operations performed
  deviceOperations: ACDeviceOperation[];

  // Environment effects observed
  environmentEffects: ACEnvironmentEffect[];

  // Agent communications
  agentCommunications: ACAgentCommunication[];

  // Tasks executed
  tasksExecuted: string[];

  // Predicted vs actual physical effects
  predictions: ACPrediction[];

  // Phase 2.5: Monitor results (feedback-controlled physics simulation)
  monitorResult?: ACMonitorResult;

  // Final status
  status: string;
  reason?: string;
}

/**
 * AC Device Operation
 * Records a single device control operation
 */
export interface ACDeviceOperation {
  id: string;
  timestamp: Date;
  agentId: string;
  agentName: string;
  deviceId: string;
  deviceName: string;
  service: string;
  parameters: Record<string, any>;
  result?: any;
  success: boolean;
  error?: string;
}

/**
 * AC Environment Effect
 * Records an environment parameter change
 */
export interface ACEnvironmentEffect {
  id: string;
  timestamp: Date;
  deviceId: string;
  deviceName: string;
  parameter: string; // e.g., 'temperature', 'traffic_flow', 'air_quality'
  previousValue: any;
  newValue: any;
  change: any;
  effectMagnitude: number; // How much the parameter changed
}

/**
 * AC Agent Communication
 * Records agent-to-agent communication
 */
export interface ACAgentCommunication {
  id: string;
  timestamp: Date;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  type: string;
  subject: string;
  content: string;
}

/**
 * AC Prediction - Records predicted vs actual physical effect for a goal
 */
export interface ACPrediction {
  goalId: string;
  /** The parameter being predicted (e.g., 'temperature', 'air_quality') */
  parameter: string;
  /** Location/zone of the prediction */
  location: string;
  /** The value the agent/system expected (from success criteria threshold) */
  predictedValue: number;
  /** The actual value after execution (from environment or device state) */
  actualValue: number;
  /** Whether the prediction was accurate within tolerance */
  accurate: boolean;
  /** The tolerance used for comparison */
  tolerance: number;
}

/**
 * AC Execution Options
 */
export interface ACExecutionOptions {
  maxDuration?: number; // Maximum execution time (ms)
  taskTimeout?: number; // Timeout per task (ms)
  verboseLogging?: boolean; // Enable detailed logging
  monitorInterval?: number; // Progress check interval (ms)
  simulationStepSize?: number; // Duration per physics step in seconds (default: 1.0)
  simulationSettleSteps?: number; // Extra settling steps after goal achievement (default: 5)
}

/**
 * Phase 2.5 Monitor: Per-goal monitoring result
 * Records which agent observed the environment and whether the goal was achieved.
 */
export interface ACMonitorGoalResult {
  goalId: string;
  parameter: string;
  location: string;
  targetValue: number;
  achieved: boolean;
  finalValue?: number;
  achievedAtSeconds?: number;
  /** Observer Agent ID — the agent that monitored this goal */
  observerAgentId: string;
  /** How the observation was done: 'own-resource' | 'partner-service' | 'environment-center' */
  observationSource: string;
}

/**
 * Phase 2.5 Monitor: Complete feedback monitoring result
 * Part of the AC lifecycle closed-loop control.
 */
export interface ACMonitorResult {
  /** Whether all environment-parameter goals were achieved during monitoring */
  goalsAchieved: boolean;
  /** Per-goal monitoring details */
  goalResults: ACMonitorGoalResult[];
  /** Total simulated seconds elapsed */
  totalSimulatedSeconds: number;
  /** Whether the monitor phase was skipped (no PhysicalEnvironment) */
  skipped: boolean;
  skipReason?: string;
}

// ============================================================================
// Task Planning Types (Three-Phase Resource Matching)
// ============================================================================

/**
 * Task Requirement - What a task needs to be completed
 */
export interface TaskRequirement {
  id: string;
  capabilityType: string;
  description: string;
  semanticTags: string[];
  expectedParameters?: Record<string, {
    type: string;
    required: boolean;
    description?: string;
  }>;
  // NEW: Actual parameter values from the task
  parameterValues?: Record<string, any>;
  qosRequirements?: {
    maxLatency?: number;
    minReliability?: number;
    locationConstraint?: string;
  };
  priority: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * AC Operation - A single executable operation
 */
export interface ACOperation {
  id: string;
  taskId: string;

  // Operation source
  source: 'self-resource' | 'external-service' | 'dynamic-service';

  // For self-resource operations
  resourceOperation?: {
    resourceId: string;
    resourceName: string;
    capability: string;
    parameters: Record<string, any>;
  };

  // For external/dynamic service operations
  serviceOperation?: {
    agentId: string;
    agentName: string;
    serviceId: string;
    serviceName: string;
    parameters: Record<string, any>;
  };

  // Dynamic parameters (from previous operation results)
  dynamicParameters?: Record<string, {
    fromOperationId: string;
    resultPath: string;
  }>;

  // Execution condition
  condition?: string;

  // Status
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

/**
 * AC Execution Phase - A group of operations
 */
export interface ACExecutionPhase {
  id: string;
  name: string;
  description: string;

  // Operations in this phase
  operations: ACOperation[];

  // Phase execution mode
  executionMode: 'sequential' | 'parallel' | 'conditional';

  // Pre-condition for this phase
  preCondition?: string;

  // Data flow
  inputFrom?: string[];
  outputTo?: string[];

  // Status
  status: 'pending' | 'executing' | 'completed' | 'failed';
}

/**
 * Capability Request - Request for capabilities from other agents
 */
export interface CapabilityRequest {
  id: string;
  type: 'capability-request';

  requester: {
    agentId: string;
    agentName: string;
  };

  requirements: TaskRequirement[];

  context: {
    goalId: string;
    goalDescription: string;
    urgency: 'low' | 'medium' | 'high' | 'critical';
    deadline?: Date;
    location?: string;
  };

  status: 'pending' | 'partial' | 'fulfilled' | 'expired';

  createdAt: Date;
  expiresAt: Date;
}

/**
 * Capability Response - Response to a capability request
 */
export interface CapabilityResponse {
  requestId: string;
  responder: {
    agentId: string;
    agentName: string;
  };

  responseType: 'can-provide-immediately' | 'can-develop' | 'cannot-provide';

  // If can provide immediately
  existingService?: {
    serviceId: string;
    serviceName: string;
    capabilities: string[];
  };

  // If can develop new service
  developmentPlan?: {
    estimatedTimeMs: number;
    proposedService: {
      name: string;
      description: string;
      capabilities: string[];
    };
  };

  // Negotiation terms
  negotiation?: {
    conditions?: string[];
    limitations?: string[];
  };

  respondedAt: Date;
}

/**
 * AC Execution Plan - Complete plan for achieving a goal
 */
export interface ACExecutionPlan {
  goalId: string;
  goalDescription: string;
  agentId: string;

  // Task requirements analysis
  requirements: TaskRequirement[];

  // Execution phases
  phases: ACExecutionPhase[];

  // Orchestration configuration
  orchestration: {
    mode: 'sequential' | 'parallel' | 'pipeline';
    dependencies: Array<{
      from: string;
      to: string;
      type: 'data' | 'success';
    }>;
  };

  // Service requests needed
  serviceRequests: CapabilityRequest[];

  // Plan status
  status: 'draft' | 'ready' | 'executing' | 'completed' | 'failed';

  createdAt: Date;
}

// ============================================================================
// AC Executor Class
// ============================================================================

/**
 * AC Executor - Executes Active Collaborations
 *
 * This is the MAIN execution engine that makes ACs work end-to-end.
 * It coordinates agents, devices, and environment to achieve collaboration goals.
 */
export class ACExecutor {
  private executions: Map<string, ACExecutionResult>;
  private executionHistory: ACExecutionResult[];

  constructor() {
    this.executions = new Map();
    this.executionHistory = [];
    logger.info('Initialized - AC Execution Engine ready');
  }

  /**
   * Execute an Active Collaboration
   * This is the MAIN method that makes ACs work
   *
   * @param config - AC collaboration configuration
   * @param options - Execution options
   * @returns Complete execution result
   */
  async executeCollaboration(
    config: ACCollaborationConfig,
    options: ACExecutionOptions = {}
  ): Promise<ACExecutionResult> {
    const startTime = new Date();
    logger.info('\n' + '='.repeat(80));
    logger.info(`EXECUTING AC: ${config.name}`);
    logger.info(`ID: ${config.id}`);
    logger.info(`Goals: ${config.goals.length}`);
    logger.info(`Participants: ${config.participantAgentIds.length} agents`);
    logger.info(`Max Duration: ${options.maxDuration || 'unlimited'}ms`);
    logger.info('='.repeat(80) + '\n');

    // Initialize execution result
    const result: ACExecutionResult = {
      collaborationId: config.id,
      success: false,
      finalState: ACState.CREATED,
      startTime,
      endTime: new Date(),
      duration: 0,
      goalsAchieved: [],
      goalsFailed: [],
      goalsInProgress: [],
      deviceOperations: [],
      environmentEffects: [],
      agentCommunications: [],
      tasksExecuted: [],
      predictions: [],
      status: 'initializing',
    };

    try {
      // Phase 1: Initialize AC
      await this.executePhase1_Initialize(config, result);

      // Phase 2: Execute goals
      await this.executePhase2_ExecuteGoals(config, result, options);

      // Phase 2.5: Monitor with feedback control (CLOSED-LOOP AC)
      await this.executePhase2_5_Monitor(config, result, options);

      // Phase 3: Verify results
      await this.executePhase3_VerifyResults(config, result);

      // Phase 4: Complete
      await this.executePhase4_Complete(config, result);

    } catch (error) {
      logger.error(`ERROR during execution:`, error);
      result.status = 'error';
      result.reason = error instanceof Error ? error.message : String(error);
      result.finalState = ACState.FAILED;

      // Track failed state
      await config.collaborationManager.trackACState(config.id, ACState.FAILED, result.reason);
    }

    // Finalize result
    result.endTime = new Date();
    result.duration = result.endTime.getTime() - result.startTime.getTime();

    // Store result
    this.executions.set(config.id, result);
    this.executionHistory.push(result);

    // Print summary
    this.printExecutionSummary(result);

    return result;
  }

  /**
   * Phase 1: Initialize AC
   * - Track state as INITIALIZING
   * - Verify all participants exist and are ready
   * - Set up agent participation
   * - Track state as READY
   */
  private async executePhase1_Initialize(
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<void> {
    logger.info('\n[ACExecutor] Phase 1: INITIALIZING AC');

    // Track state
    await config.collaborationManager.trackACState(config.id, ACState.INITIALIZING, 'Starting AC initialization');
    result.finalState = ACState.INITIALIZING;

    // Get participant agents
    const agents = await this.getParticipantAgents(config);
    logger.info(`Found ${agents.length} participant agents`);

    // Verify all agents are ready
    for (const agent of agents) {
      logger.info(`- ${agent.name} (${agent.id}): ${agent.status}`);

      if (agent.status !== 'idle') {
        logger.warn(`WARNING: Agent ${agent.name} is not IDLE (status: ${agent.status})`);
      }

      // Subscribe agent to AC events
      this.subscribeAgentToCollaboration(agent, config);
    }

    // Track state as READY
    await config.collaborationManager.trackACState(config.id, ACState.READY, 'All agents initialized');
    result.finalState = ACState.READY;
    result.status = 'ready';

    logger.info(`Phase 1 COMPLETE: AC ready for execution\n`);
  }

  /**
   * Phase 2: Execute Goals
   * - Track state as RUNNING
   * - For each goal, coordinate agents to achieve it
   * - Agents control devices, observe environment
   * - Record all operations and effects
   */
  private async executePhase2_ExecuteGoals(
    config: ACCollaborationConfig,
    result: ACExecutionResult,
    options: ACExecutionOptions
  ): Promise<void> {
    logger.info('\n[ACExecutor] Phase 2: EXECUTING GOALS');

    // Track state as RUNNING
    await config.collaborationManager.trackACState(config.id, ACState.RUNNING, 'Executing collaboration goals');
    result.finalState = ACState.RUNNING;
    result.status = 'running';

    const agents = await this.getParticipantAgents(config);

    // Execute goals in priority order
    const sortedGoals = [...config.goals].sort((a, b) => {
      const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    for (const goal of sortedGoals) {
      logger.info(`\n[ACExecutor] Processing goal: ${goal.description}`);
      logger.info(`Priority: ${goal.priority}`);
      logger.info(`Target devices: ${goal.targetDevices.length}`);
      logger.info(`Target agents: ${goal.targetAgents.length}`);

      result.goalsInProgress.push(goal.id);

      // Execute goal
      const goalAchieved = await this.executeGoal(goal, config, agents, result, options);

      if (goalAchieved) {
        result.goalsAchieved.push(goal.id);
        logger.info(`GOAL ACHIEVED: ${goal.description}`);
      } else {
        result.goalsFailed.push(goal.id);
        logger.info(`GOAL FAILED: ${goal.description}`);
      }
    }

    logger.info(`\n[ACExecutor] Phase 2 COMPLETE: ${result.goalsAchieved.length}/${config.goals.length} goals achieved\n`);
  }

  /**
   * Execute a single goal
   * Coordinates agents to achieve the goal
   */
  private async executeGoal(
    goal: ACCollaborationGoal,
    config: ACCollaborationConfig,
    agents: CognitiveAgent[],
    result: ACExecutionResult,
    options: ACExecutionOptions
  ): Promise<boolean> {
    logger.info(`Executing goal: ${goal.description}`);

    // Get target agents
    const targetAgents = agents.filter((a) => goal.targetAgents.includes(a.id));
    logger.info(`Assigned agents: ${targetAgents.map((a) => a.name).join(', ')}`);

    // Get target devices
    const targetDevices = await this.getTargetDevices(config, goal);
    logger.info(`Target devices: ${targetDevices.map((d) => d.name).join(', ')}`);

    // Step 1: Agents communicate to plan
    await this.coordinateAgentCommunication(targetAgents, goal, result);

    // Step 2: Agents execute tasks on devices
    for (const agent of targetAgents) {
      await this.executeAgentTasks(agent, goal, targetDevices, config, result, options);
    }

    // Step 3: Verify success criteria
    const success = await this.verifySuccessCriteria(goal, config, result);

    return success;
  }

  /**
   * Coordinate agent communication for goal planning
   */
  private async coordinateAgentCommunication(
    agents: CognitiveAgent[],
    goal: ACCollaborationGoal,
    result: ACExecutionResult
  ): Promise<void> {
    logger.info(`Coordinating agent communication for goal planning`);

    // Agents communicate via DialogueManager
    // This is where multi-agent collaboration happens

    for (let i = 0; i < agents.length; i++) {
      const fromAgent = agents[i];
      for (let j = i + 1; j < agents.length; j++) {
        const toAgent = agents[j];

        // Send planning message
        const message = fromAgent.dialogueManager.sendMessage(
          fromAgent.id,
          toAgent.id,
          MessageType.REQUEST,
          `Planning for goal: ${goal.description}`,
          `We need to collaborate to achieve: ${goal.description}. I can help with ${goal.requiredCapabilities.join(', ')}.`,
          { priority: MessagePriority.HIGH, metadata: { goalId: goal.id } }
        );

        // Record communication
        result.agentCommunications.push({
          id: uuidv4(),
          timestamp: new Date(),
          fromAgentId: fromAgent.id,
          fromAgentName: fromAgent.name,
          toAgentId: toAgent.id,
          toAgentName: toAgent.name,
          type: 'request',
          subject: message.subject,
          content: message.content,
        });

        logger.info(`${fromAgent.name} -> ${toAgent.name}: Planning message sent`);
      }
    }
  }

  /**
   * Execute agent tasks on devices
   * This is where agents actually control devices
   *
   * ARCHITECTURE: Agent gets resources from its own ResourceManager,
   * NOT from external device lists. This respects resource ownership.
   *
   * Uses Three-Phase Resource Matching:
   * Phase 1: Match with own resources
   * Phase 2: Match with existing external services
   * Phase 3: Request capabilities from other agents
   */
  private async executeAgentTasks(
    agent: CognitiveAgent,
    goal: ACCollaborationGoal,
    _devices: Device[],  // Ignored - Agent uses its own resources
    config: ACCollaborationConfig,
    result: ACExecutionResult,
    options: ACExecutionOptions
  ): Promise<void> {
    logger.info(`${agent.name}: Executing tasks using three-phase resource matching`);

    // Mark options as intentionally unused for now
    void options;
    void _devices;  // Not used - Agent uses its own resources

    // Create a task for this agent
    const task = agent.taskManager.createTask(
      `Achieve goal: ${goal.description}`,
      goal.description,
      { priority: goal.priority === 'urgent' ? TaskPriority.URGENT : TaskPriority.HIGH }
    );

    result.tasksExecuted.push(task.id);

    // Use the new three-phase planning approach
    try {
      // Get available services from other agents (Phase 2 input)
      const availableServices = await this.getAvailableServices(config, agent.id);

      // Create execution plan using three-phase matching
      const plan = await this.planExecution(goal, agent, availableServices, config.environment);

      // Log plan details
      logger.info(`${agent.name}: Execution plan created`);
      logger.info(`${agent.name}: Requirements: ${plan.requirements.length}`);
      logger.info(`${agent.name}: Phases: ${plan.phases.length}`);
      logger.info(`${agent.name}: Service requests: ${plan.serviceRequests.length}`);

      // Send capability requests if needed (Phase 3)
      for (const request of plan.serviceRequests) {
        await this.broadcastCapabilityRequest(request, config, agent);
      }

      // Execute the plan
      const success = await this.executePlan(plan, agent, result);

      // Update task status
      task.status = success ? TaskStatus.COMPLETED : TaskStatus.FAILED;
      task.completedAt = new Date();

      if (success) {
        logger.info(`${agent.name}: Goal "${goal.description}" completed successfully`);
      } else {
        logger.warn(`${agent.name}: Goal "${goal.description}" execution had failures`);
      }

    } catch (error) {
      logger.error(`${agent.name}: Error in three-phase execution:`, error);
      task.status = TaskStatus.FAILED;

      // Fallback to legacy execution
      logger.info(`${agent.name}: Falling back to legacy execution`);
      await this.executeAgentTasksLegacy(agent, goal, config, result);
    }
  }

  /**
   * Get available services from other agents in the collaboration
   */
  private async getAvailableServices(
    config: ACCollaborationConfig,
    excludeAgentId: string
  ): Promise<any[]> {
    const services: any[] = [];

    for (const agentId of config.participantAgentIds) {
      if (agentId === excludeAgentId) continue;

      const agent = await config.environment.getAgent(agentId);
      if (agent) {
        const agentServices = (agent as unknown as CognitiveAgent).serviceRegistry?.getAllServices() || [];
        for (const service of agentServices) {
          services.push({
            providerId: agentId,
            providerName: (agent as unknown as CognitiveAgent).name,
            serviceId: service.id,
            serviceName: service.name,
            capabilities: service.capabilities || [service.name],
          });
        }
      }
    }

    return services;
  }

  /**
   * Broadcast capability request to other agents
   */
  private async broadcastCapabilityRequest(
    request: CapabilityRequest,
    config: ACCollaborationConfig,
    _agent: CognitiveAgent
  ): Promise<void> {
    logger.info(`Broadcasting capability request: ${request.id}`);

    // Publish the request via MessageBroker
    const messageBroker = config.environment.messageBroker;
    if (messageBroker) {
      for (const agentId of config.participantAgentIds) {
        if (agentId === request.requester.agentId) continue;

        await messageBroker.sendMessage(
          request.requester.agentId,
          agentId,
          MessageType.REQUEST,
          'Capability Request',
          JSON.stringify(request),
          { priority: MessagePriority.HIGH }
        );
      }

      logger.info(`Capability request broadcast to ${config.participantAgentIds.length - 1} agents`);
    }
  }

  /**
   * Legacy execution method (fallback)
   */
  private async executeAgentTasksLegacy(
    agent: CognitiveAgent,
    goal: ACCollaborationGoal,
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<void> {
    // ARCHITECTURE (Sprint 13): Use ServiceBroker pattern instead of direct resourceManager access
    // Discover services from environment and filter by providerAgentId
    const selfServices = this.getSelfServices(agent, config.environment);
    logger.info(`${agent.name}: Has ${selfServices.length} self-services available (legacy mode)`);

    // Create a task for this agent
    const task = agent.taskManager.createTask(
      `Achieve goal (legacy): ${goal.description}`,
      goal.description,
      { priority: goal.priority === 'urgent' ? TaskPriority.URGENT : TaskPriority.HIGH }
    );

    result.tasksExecuted.push(task.id);

    // Find services that can fulfill the goal's required capabilities
    for (const capability of goal.requiredCapabilities) {
      for (const service of selfServices) {
        const serviceCapabilities = service.getCapabilities?.() || [];
        const hasCapability = serviceCapabilities.some((cap: string) =>
          this.shouldExecuteService({ name: cap, category: service.category }, goal)
        );

        if (hasCapability) {
          logger.info(`${agent.name}: Using service ${service.name} for capability ${capability}`);

          // Get device from service if available
          const deviceId = service.deviceId;
          const underlyingDevice = deviceId ? await config.environment.getDevice(deviceId) : null;

          if (underlyingDevice) {
            // Execute on actual device
            await this.executeDeviceCapability(agent, underlyingDevice, capability, config, result);
          } else {
            // Execute as non-device service
            await this.executeResourceService(agent, service, capability, config, result);
          }

          break; // Move to next capability
        }
      }
    }

    // Mark task as completed
    task.status = TaskStatus.COMPLETED;
    task.completedAt = new Date();
  }

  /**
   * Execute a non-device resource service
   */
  private async executeResourceService(
    agent: CognitiveAgent,
    resource: any,
    capability: any,
    _config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<void> {
    logger.info(`${agent.name}: Executing resource service ${capability.name || capability}`);

    const operation: ACDeviceOperation = {
      id: uuidv4(),
      timestamp: new Date(),
      agentId: agent.id,
      agentName: agent.name,
      deviceId: (resource as unknown as Record<string, unknown>).id as string || 'unknown',
      deviceName: (resource as unknown as Record<string, unknown>).name as string || 'Resource',
      service: capability.name || String(capability),
      parameters: {},
      success: true,
    };

    result.deviceOperations.push(operation);
  }

  /**
   * Determine if a capability should be executed for a goal
   */
  private shouldExecuteCapability(capability: any, goal: ACCollaborationGoal): boolean {
    const capName = (capability.name || String(capability)).toLowerCase();

    for (const reqCap of goal.requiredCapabilities) {
      if (capName.includes(reqCap.toLowerCase()) || reqCap.toLowerCase().includes(capName)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Determine if a service should be executed for a goal
   */
  private shouldExecuteService(service: any, goal: ACCollaborationGoal): boolean {
    // Simple heuristic: if service name relates to goal
    const serviceName = service.name?.toLowerCase() || '';

    for (const capability of goal.requiredCapabilities) {
      if (serviceName.includes(capability.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * Execute a semantic capability on a device resource
   * This is where devices are ACTUALLY controlled through semantic capabilities
   * ARCHITECTURE: Uses Agent's resources, not EnvironmentCenter
   */
  private async executeDeviceCapability(
    agent: CognitiveAgent,
    device: Device,
    capabilityName: string,
    _config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<void> {
    logger.info(`${agent.name}: Executing capability ${capabilityName} on device ${device.name}`);

    try {
      // ARCHITECTURE-CORRECT: Execute via Agent's resource, not EnvironmentCenter
      // The Agent owns the resources and executes through them
      const capabilityResult = await agent.executeDeviceCapability(device.id, capabilityName, {
        agentId: agent.id,
        timestamp: new Date(),
      });

      // Record initial state for effect tracking
      const initialState = { ...(capabilityResult?.result?.previousState || {}) };

      // Record device operation
      const operation: ACDeviceOperation = {
        id: uuidv4(),
        timestamp: new Date(),
        agentId: agent.id,
        agentName: agent.name,
        deviceId: device.id,
        deviceName: device.name,
        service: capabilityName,
        parameters: {},
        result: capabilityResult,
        success: capabilityResult.success,
      };

      result.deviceOperations.push(operation);

      // Record environment effect
      const newState = { ...(capabilityResult?.result?.newState || capabilityResult?.result || {}) };
      const effect = this.calculateEnvironmentEffect(device, initialState, newState);
      if (effect) {
        result.environmentEffects.push(effect);
      }

      logger.info(`Service executed successfully`);
      logger.info(`Result:`, capabilityResult);

    } catch (error) {
      logger.error(`Service execution FAILED:`, error);

      const operation: ACDeviceOperation = {
        id: uuidv4(),
        timestamp: new Date(),
        agentId: agent.id,
        agentName: agent.name,
        deviceId: device.id,
        deviceName: device.name,
        service: capabilityName,
        parameters: {},
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };

      result.deviceOperations.push(operation);
    }
  }

  /**
   * Calculate environment effect from device state change
   */
  private calculateEnvironmentEffect(
    device: Device,
    initialState: any,
    newState: any
  ): ACEnvironmentEffect | null {
    // Find what changed
    for (const key of Object.keys(newState)) {
      if (initialState[key] !== newState[key]) {
        return {
          id: uuidv4(),
          timestamp: new Date(),
          deviceId: device.id,
          deviceName: device.name,
          parameter: key,
          previousValue: initialState[key],
          newValue: newState[key],
          change: newState[key] - initialState[key] || newState[key],
          effectMagnitude: Math.abs((newState[key] - initialState[key]) || 0),
        };
      }
    }

    return null;
  }

  /**
   * Extract predicted vs actual values from goals' success criteria.
   * Compares the threshold/operator from each criterion with the actual environment value.
   */
  private extractPredictions(
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): ACPrediction[] {
    const predictions: ACPrediction[] = [];
    const tolerance = 2.0; // Default tolerance for prediction accuracy

    for (const goal of config.goals) {
      for (const criterion of goal.successCriteria) {
        // Only extract predictions for numeric criteria with thresholds
        if (criterion.threshold === undefined || criterion.threshold === null) continue;

        // Find the actual value from environment effects
        let actualValue: number | undefined;

        // Try to get from environment parameters first
        if (config.environment) {
          const params = config.environment.getParameters?.() || {};
          actualValue = params[criterion.target];
        }

        // Fall back to recorded environment effects
        if (actualValue === undefined) {
          const effect = result.environmentEffects.find(e => e.parameter === criterion.target);
          if (effect) {
            actualValue = Number(effect.newValue);
          }
        }

        // Only create prediction if we have an actual value
        if (actualValue === undefined || isNaN(actualValue)) continue;

        // Determine the expected target value from the criterion
        const predictedValue = criterion.threshold;

        // Determine location from target device or criterion target
        const location = criterion.target;

        // Check accuracy: is the actual value on the correct side of the threshold?
        let accurate = false;
        switch (criterion.operator) {
          case '>': accurate = actualValue > predictedValue; break;
          case '<': accurate = actualValue < predictedValue; break;
          case '>=': accurate = actualValue >= predictedValue; break;
          case '<=': accurate = actualValue <= predictedValue; break;
          case '==': accurate = Math.abs(actualValue - predictedValue) <= tolerance; break;
          case '!=': accurate = actualValue !== predictedValue; break;
          default:
            // If no operator, check if actual is within tolerance of predicted
            accurate = Math.abs(actualValue - predictedValue) <= tolerance;
        }

        predictions.push({
          goalId: goal.id,
          parameter: criterion.target,
          location,
          predictedValue,
          actualValue,
          accurate,
          tolerance,
        });

        logger.info(`Prediction: goal=${goal.id}, param=${criterion.target}, predicted=${predictedValue}, actual=${actualValue}, accurate=${accurate}`);
      }
    }

    return predictions;
  }

  /**
   * Verify success criteria
   */
  private async verifySuccessCriteria(
    goal: ACCollaborationGoal,
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<boolean> {
    logger.info(`Verifying success criteria for goal: ${goal.description}`);

    let allCriteriaMet = true;

    for (const criterion of goal.successCriteria) {
      const met = await this.verifyCriterion(criterion, config, result);

      if (met) {
        logger.info(`Criterion MET: ${criterion.type} - ${criterion.target}`);
      } else {
        logger.info(`Criterion NOT MET: ${criterion.type} - ${criterion.target}`);
        allCriteriaMet = false;
      }
    }

    return allCriteriaMet;
  }

  /**
   * Verify a single success criterion
   */
  private async verifyCriterion(
    criterion: ACCSuccessCriterion,
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<boolean> {
    // Normalize type name (convert underscores to hyphens)
    const normalizedType = criterion.type.replace(/_/g, '-');

    switch (normalizedType) {
      case 'device-state':
        // Check if device is in expected state
        const device = await config.environment.getDevice(criterion.target);
        if (!device) return false;

        // Simple state check - get device state from service result
        const deviceOperation = result.deviceOperations.find((op) => op.deviceId === device.id);
        const deviceState = deviceOperation?.result?.newState || deviceOperation?.result || {};
        const deviceStateMatches = this.evaluateCondition(deviceState, criterion.condition);
        return deviceStateMatches;

      case 'environment-parameter': {
        // Priority 1: Read actual environment state from EnvironmentCenter (independent verification)
        const currentParams = config.environment.getParameters?.() || {};
        const actualValue = currentParams[criterion.target];

        if (actualValue !== undefined && actualValue !== null) {
          const paramMatches = this.evaluateCondition(actualValue, criterion.condition);
          logger.info(`Environment parameter '${criterion.target}' verified: actual=${actualValue}, match=${paramMatches}`);
          return paramMatches;
        }

        // Priority 2: Fallback to recorded effects from execution
        const effect = result.environmentEffects.find((e) => e.parameter === criterion.target);
        if (effect) {
          const paramMatches = this.evaluateCondition(effect.newValue, criterion.condition);
          logger.info(`Environment parameter '${criterion.target}' verified from recorded effect: value=${effect.newValue}, match=${paramMatches}`);
          return paramMatches;
        }

        // No data available - do NOT assume success
        logger.warn(`Cannot verify environment parameter '${criterion.target}' - no data available`);
        return false;
      }

      case 'task-completion':
        // Check if task was executed
        // Consider it met if either tasks were executed OR device operations were performed
        if (result.tasksExecuted.length > 0) {
          return true;
        }
        // Also check if any device operations were performed (they represent task execution)
        if (result.deviceOperations.length > 0) {
          logger.info(`No explicit tasks, but device operations performed - considering task completion met`);
          return true;
        }
        return false;

      case 'time-bound':
        // Check if deadline was met
        if (criterion.deadline && result.endTime) {
          return new Date(result.endTime) <= new Date(criterion.deadline);
        }
        return true; // If no deadline specified, consider it met

      case 'metric-threshold':
        // Check if metric meets threshold
        if (criterion.threshold !== undefined && criterion.operator) {
          // Look for the metric in device operations or environment effects
          const metricValue = result.deviceOperations[0]?.result?.metrics?.[criterion.target]
            || result.environmentEffects.find(e => e.parameter === criterion.target)?.newValue;

          if (metricValue !== undefined) {
            switch (criterion.operator) {
              case '>': return metricValue > criterion.threshold;
              case '<': return metricValue < criterion.threshold;
              case '>=': return metricValue >= criterion.threshold;
              case '<=': return metricValue <= criterion.threshold;
              case '==': return metricValue === criterion.threshold;
              case '!=': return metricValue !== criterion.threshold;
            }
          }
        }
        return false;

      default:
        logger.info(`Unknown criterion type: ${criterion.type} (normalized: ${normalizedType})`);
        return false;
    }
  }

  /**
   * Evaluate a condition against a value
   */
  private evaluateCondition(value: any, condition: string): boolean {
    // Simple condition evaluation
    // In production, this would be more sophisticated

    try {
      // Handle basic comparisons
      if (condition.includes('==')) {
        const [, actual] = condition.split('==').map((s) => s.trim().replace(/['"]/g, ''));
        return String(value) === actual;
      }

      if (condition.includes('!=')) {
        const [, actual] = condition.split('!=').map((s) => s.trim().replace(/['"]/g, ''));
        return String(value) !== actual;
      }

      if (condition.includes('>')) {
        const [, threshold] = condition.split('>').map((s) => s.trim());
        return Number(value) > Number(threshold);
      }

      if (condition.includes('<')) {
        const [, threshold] = condition.split('<').map((s) => s.trim());
        return Number(value) < Number(threshold);
      }

      // Default: check if value matches condition
      return String(value) === condition;
    } catch (error) {
      logger.warn(`Condition evaluation error:`, error);
      return false;
    }
  }

  /**
   * Phase 2.5: Monitor — Closed-loop feedback control
   *
   * After device commands are sent (Phase 2), this phase monitors the
   * environment parameters and runs feedback-controlled physics simulation.
   *
   * The Observer agent (determined by which agent has read-capability devices
   * in the target zone) monitors the environment. When the goal is achieved,
   * all device effects are stopped — this is the closed-loop AC advantage.
   *
   * The monitoring stays within the same AC session. Only if the closed loop
   * cannot be completed within this AC would a new AC be needed (future work).
   */
  private async executePhase2_5_Monitor(
    config: ACCollaborationConfig,
    result: ACExecutionResult,
    options: ACExecutionOptions
  ): Promise<void> {
    logger.info('\n[ACExecutor] Phase 2.5: MONITORING (Closed-Loop Feedback Control)');

    // Check if PhysicalEnvironment is available for simulation
    if (!config.environment.physicalEnvironment) {
      logger.info('[ACExecutor] Phase 2.5: No PhysicalEnvironment — skipping monitor phase');
      result.monitorResult = {
        goalsAchieved: false,
        goalResults: [],
        totalSimulatedSeconds: 0,
        skipped: true,
        skipReason: 'No PhysicalEnvironment attached to EnvironmentCenter',
      };
      return;
    }

    // Check if runFeedbackSimulation is available
    const env = config.environment as unknown as {
      runFeedbackSimulation: (
        goal: Record<string, unknown>,
        totalDuration?: number,
        stepSize?: number,
        settleSteps?: number,
      ) => { stepsExecuted: number; goalAchieved: boolean; achievedAtStep?: number; achievedAtSeconds?: number; finalValue?: number } | undefined;
    };

    if (typeof env.runFeedbackSimulation !== 'function') {
      logger.info('[ACExecutor] Phase 2.5: EnvironmentCenter.runFeedbackSimulation not available — skipping');
      result.monitorResult = {
        goalsAchieved: false,
        goalResults: [],
        totalSimulatedSeconds: 0,
        skipped: true,
        skipReason: 'EnvironmentCenter does not support runFeedbackSimulation',
      };
      return;
    }

    const goalResults: ACMonitorGoalResult[] = [];
    let totalSimulatedSeconds = 0;

    for (const goal of config.goals) {
      // Determine Observer for this goal
      const observer = this.determineObserver(goal, config);
      logger.info(`Goal "${goal.description}": Observer=${observer.observerAgentId} via ${observer.observationSource}`);

      // Extract monitor goals from success criteria
      const monitorGoals = this.extractMonitorGoals(goal, config);

      if (monitorGoals.length === 0) {
        const criteriaTypes = goal.successCriteria.map(c => c.type);
        logger.info(`Goal "${goal.description}": No monitorable environment-parameter criteria (types: [${criteriaTypes.join(', ')}])`);
        continue;
      }

      // Run feedback simulation for each extracted monitor goal
      for (const mg of monitorGoals) {
        const simResult = env.runFeedbackSimulation(
          {
            parameter: mg.parameter,
            location: mg.location,
            targetValue: mg.targetValue,
            tolerance: mg.tolerance,
            direction: mg.direction,
          } as unknown as Record<string, unknown>,
          options.maxDuration ? Math.ceil(options.maxDuration / 1000) : 600,
          options.simulationStepSize ?? 1.0,
          options.simulationSettleSteps ?? 5,
        );

        if (simResult) {
          totalSimulatedSeconds += simResult.stepsExecuted * (options.simulationStepSize ?? 1.0);

          goalResults.push({
            goalId: goal.id,
            parameter: mg.parameter,
            location: mg.location,
            targetValue: mg.targetValue,
            achieved: simResult.goalAchieved,
            finalValue: simResult.finalValue,
            achievedAtSeconds: simResult.achievedAtSeconds,
            observerAgentId: observer.observerAgentId,
            observationSource: observer.observationSource,
          });

          logger.info(
            `Monitor result: param=${mg.parameter}@${mg.location}, ` +
            `achieved=${simResult.goalAchieved}, ` +
            `final=${simResult.finalValue?.toFixed(2) ?? 'N/A'}, ` +
            `target=${mg.targetValue}`,
          );

          // If Observer ≠ executor, generate inter-agent communication
          // within this AC session (not a new AC)
          const executors = goal.targetAgents.filter(a => a !== observer.observerAgentId);
          if (executors.length > 0 && simResult.goalAchieved) {
            for (const executorId of executors) {
              result.agentCommunications.push({
                id: uuidv4(),
                timestamp: new Date(),
                fromAgentId: observer.observerAgentId,
                fromAgentName: observer.observerAgentId,
                toAgentId: executorId,
                toAgentName: executorId,
                type: 'feedback',
                subject: `Goal achieved: ${mg.parameter}@${mg.location} reached ${simResult.finalValue?.toFixed(1)}`,
                content: `Observed ${mg.parameter} at ${simResult.finalValue?.toFixed(1)} (target: ${mg.targetValue}). ` +
                  `Device effects have been stopped.`,
              });
            }
          }
        }
      }
    }

    const allAchieved = goalResults.length > 0 && goalResults.every(g => g.achieved);
    result.monitorResult = {
      goalsAchieved: allAchieved,
      goalResults,
      totalSimulatedSeconds,
      skipped: false,
    };

    logger.info(`\n[ACExecutor] Phase 2.5 COMPLETE: ${goalResults.filter(g => g.achieved).length}/${goalResults.length} monitor goals achieved\n`);
  }

  /**
   * Determine which Agent acts as Observer for a goal.
   *
   * Strategy:
   * 1. Check if initiator (first participant) has read-capability devices in the target zone
   * 2. Check if executor agents have read-capability devices
   * 3. Fallback to EnvironmentCenter parameter reading
   */
  private determineObserver(
    goal: ACCollaborationGoal,
    config: ACCollaborationConfig
  ): { observerAgentId: string; observationSource: string } {
    // Try each participant agent to find one with read-capability devices
    for (const agentId of config.participantAgentIds) {
      const hasReadCapability = goal.targetDevices.some(deviceId => {
        // Check if this agent has this device with a read-type capability
        // We look at the agent's resources via environment
        return goal.successCriteria.some(c =>
          c.type === 'environment-parameter' &&
          (agentId === config.participantAgentIds[0]) // Simplified: initiator likely has sensors
        );
      });

      if (hasReadCapability) {
        return {
          observerAgentId: agentId,
          observationSource: 'own-resource',
        };
      }
    }

    // Check if any target agent has read capability
    for (const agentId of goal.targetAgents) {
      if (config.participantAgentIds.includes(agentId)) {
        return {
          observerAgentId: agentId,
          observationSource: 'own-resource',
        };
      }
    }

    // Fallback: use initiator as observer via EnvironmentCenter
    return {
      observerAgentId: config.participantAgentIds[0],
      observationSource: 'environment-center',
    };
  }

  /**
   * Extract monitor goals from an AC goal's success criteria.
   *
   * Converts environment-parameter criteria into simulation goals
   * that can be fed to PhysicalEnvironment.simulateWithFeedback().
   */
  private extractMonitorGoals(
    goal: ACCollaborationGoal,
    config: ACCollaborationConfig
  ): Array<{
    parameter: string;
    location: string;
    targetValue: number;
    tolerance: number;
    direction: 'below' | 'above';
  }> {
    const monitorGoals: Array<{
      parameter: string;
      location: string;
      targetValue: number;
      tolerance: number;
      direction: 'below' | 'above';
    }> = [];

    for (const criterion of goal.successCriteria) {
      const normalizedType = criterion.type.replace(/_/g, '-');

      if (normalizedType !== 'environment-parameter') continue;

      // Try to extract numeric target from threshold or condition
      let targetValue: number | undefined;
      let direction: 'below' | 'above' = 'below';
      let parameter = criterion.target;

      // Method 1: Direct threshold
      if (criterion.threshold !== undefined && criterion.threshold !== null) {
        targetValue = criterion.threshold;
        switch (criterion.operator) {
          case '<': case '<=': direction = 'below'; break;
          case '>': case '>=': direction = 'above'; break;
          default: direction = 'below';
        }
      }

      // Method 2: Parse condition string (e.g., "temperature < 25")
      if (targetValue === undefined && criterion.condition) {
        const parsed = this.parseConditionForTarget(criterion.condition);
        if (parsed) {
          targetValue = parsed.targetValue;
          direction = parsed.direction;
          if (parsed.parameter && parameter === 'environment.param_changed') {
            parameter = parsed.parameter;
          }
        }
      }

      // Method 3: If target looks like a generic placeholder and no condition parsed,
      // try to infer from goal description
      if (targetValue === undefined) {
        const inferred = this.inferTargetFromGoalDescription(goal.description);
        if (inferred) {
          targetValue = inferred.targetValue;
          direction = inferred.direction;
          if (inferred.parameter && (parameter === 'environment.param_changed' || parameter === 'environment')) {
            parameter = inferred.parameter;
          }
        }
      }

      if (targetValue === undefined) continue;

      // Determine location from target devices
      let location = 'default';
      for (const deviceId of goal.targetDevices) {
        const device = config.environment.getDevice(deviceId);
        if (device) {
          const deviceLocation = device.location;
          if (typeof deviceLocation === 'string' && deviceLocation) {
            location = deviceLocation;
            break;
          }
          if (deviceLocation && typeof deviceLocation === 'object') {
            const loc = (deviceLocation as Record<string, unknown>).path as string | undefined;
            if (loc) {
              location = loc;
              break;
            }
          }
        }
      }

      monitorGoals.push({
        parameter,
        location,
        targetValue,
        tolerance: 2.0,
        direction,
      });
    }

    return monitorGoals;
  }

  /**
   * Parse condition string for numeric target.
   * Examples: "temperature < 25" → { parameter: 'temperature', targetValue: 25, direction: 'below' }
   */
  private parseConditionForTarget(condition: string): { parameter: string; targetValue: number; direction: 'below' | 'above' } | undefined {
    // Match patterns like: "temperature < 25", "humidity >= 40", "temp == 24"
    const match = condition.match(/(\w+)\s*(<|<=|>|>=|==)\s*(\d+\.?\d*)/);
    if (match) {
      const parameter = match[1];
      const operator = match[2];
      const targetValue = parseFloat(match[3]);
      const direction = (operator === '<' || operator === '<=') ? 'below' : 'above';
      return { parameter, targetValue, direction };
    }

    // Match patterns like: "< 25", ">= 40"
    const simpleMatch = condition.match(/^(<|<=|>|>=|==)\s*(\d+\.?\d*)$/);
    if (simpleMatch) {
      const operator = simpleMatch[1];
      const targetValue = parseFloat(simpleMatch[2]);
      const direction = (operator === '<' || operator === '<=') ? 'below' : 'above';
      return { parameter: '', targetValue, direction };
    }

    return undefined;
  }

  /**
   * Infer target value from goal description.
   * Looks for temperature/humidity targets in the description text.
   */
  private inferTargetFromGoalDescription(description: string): { parameter: string; targetValue: number; direction: 'below' | 'above' } | undefined {
    // Look for cooling patterns: "reduce temperature to X", "cool to X"
    const coolMatch = description.match(/(?:cool|reduce|lower|temperature\s+to)\s+(\d+\.?\d*)/i);
    if (coolMatch) {
      return { parameter: 'temperature', targetValue: parseFloat(coolMatch[1]), direction: 'below' };
    }

    // Look for heating patterns: "heat to X", "warm to X"
    const heatMatch = description.match(/(?:heat|warm|increase|raise)\s+(?:temperature\s+)?(?:to\s+)?(\d+\.?\d*)/i);
    if (heatMatch) {
      return { parameter: 'temperature', targetValue: parseFloat(heatMatch[1]), direction: 'above' };
    }

    // Look for generic "to X°C" or "to X°" patterns
    const degreeMatch = description.match(/to\s+(\d+\.?\d*)\s*°?C/i);
    if (degreeMatch) {
      return { parameter: 'temperature', targetValue: parseFloat(degreeMatch[1]), direction: 'below' };
    }

    return undefined;
  }

  /**
   * Phase 3: Verify Results
   * - Check all goals achieved
   * - Verify environment effects
   * - Track state as COMPLETING
   */
  private async executePhase3_VerifyResults(
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<void> {
    logger.info('\n[ACExecutor] Phase 3: VERIFYING RESULTS');

    await config.collaborationManager.trackACState(config.id, ACState.COMPLETING, 'Verifying collaboration results');
    result.finalState = ACState.COMPLETING;

    logger.info(`Goals achieved: ${result.goalsAchieved.length}/${config.goals.length}`);
    logger.info(`Device operations: ${result.deviceOperations.length}`);
    logger.info(`Environment effects: ${result.environmentEffects.length}`);
    logger.info(`Agent communications: ${result.agentCommunications.length}`);
    logger.info(`Tasks executed: ${result.tasksExecuted.length}`);

    // Extract predicted vs actual values for each goal's success criteria
    result.predictions = this.extractPredictions(config, result);

    // Use Phase 2.5 monitor results to update goal achievement
    if (result.monitorResult && !result.monitorResult.skipped) {
      logger.info(`Monitor phase: ${result.monitorResult.goalResults.filter(g => g.achieved).length}/${result.monitorResult.goalResults.length} goals achieved`);

      // Promote monitor-achieved goals to goalsAchieved
      for (const goalResult of result.monitorResult.goalResults) {
        if (goalResult.achieved && !result.goalsAchieved.includes(goalResult.goalId)) {
          // Move from failed to achieved
          result.goalsFailed = result.goalsFailed.filter(id => id !== goalResult.goalId);
          if (!result.goalsAchieved.includes(goalResult.goalId)) {
            result.goalsAchieved.push(goalResult.goalId);
          }
          logger.info(`Goal ${goalResult.goalId} promoted to ACHIEVED via monitor (param=${goalResult.parameter}, final=${goalResult.finalValue?.toFixed(2)})`);
        }
      }
    }

    // Determine success (after monitor results have been applied)
    const allGoalsAchieved = result.goalsAchieved.length === config.goals.length;
    const hasDeviceOperations = result.deviceOperations.length > 0;
    result.success = allGoalsAchieved && hasDeviceOperations;

    logger.info(`Verification ${result.success ? 'PASSED' : 'FAILED'}\n`);
  }

  /**
   * Phase 4: Complete
   * - Track final state
   * - Clean up
   */
  private async executePhase4_Complete(
    config: ACCollaborationConfig,
    result: ACExecutionResult
  ): Promise<void> {
    logger.info('\n[ACExecutor] Phase 4: COMPLETING AC');

    const finalState = result.success ? ACState.COMPLETED : ACState.FAILED;
    const reason = result.success ? 'Collaboration completed successfully' : 'Collaboration did not achieve all goals';

    await config.collaborationManager.trackACState(config.id, finalState, reason);
    result.finalState = finalState;
    result.status = result.success ? 'completed' : 'failed';
    result.reason = reason;

    logger.info(`AC completed with state: ${finalState}`);
    logger.info(`Reason: ${reason}\n`);
  }

  // ========================================================================
  // Helper Methods
  // ========================================================================

  /**
   * Get participant agents from configuration
   */
  private async getParticipantAgents(config: ACCollaborationConfig): Promise<CognitiveAgent[]> {
    const agents: CognitiveAgent[] = [];

    for (const agentId of config.participantAgentIds) {
      const agent = await config.environment.getAgent(agentId);
      if (agent) {
        agents.push(agent as unknown as CognitiveAgent);
      } else {
        logger.error(`Agent not found: ${agentId}`);
      }
    }

    return agents;
  }

  /**
   * Get target devices for a goal
   */
  private async getTargetDevices(
    config: ACCollaborationConfig,
    goal: ACCollaborationGoal
  ): Promise<Device[]> {
    const devices: Device[] = [];

    for (const deviceId of goal.targetDevices) {
      const device = await config.environment.getDevice(deviceId);
      if (device) {
        devices.push(device);
      } else {
        logger.error(`Device not found: ${deviceId}`);
      }
    }

    return devices;
  }

  /**
   * Subscribe agent to collaboration events
   */
  private subscribeAgentToCollaboration(agent: CognitiveAgent, _config: ACCollaborationConfig): void {
    // Agent subscribes to collaboration events via its event system
    agent.eventManager.subscribe({
      subscriberId: agent.id,
      eventType: EventType.COLLABORATION_MESSAGE,
      handler: (data: unknown) => {
        logger.info(`${agent.name} received collaboration message:`, data);
      },
      priority: EventPriority.NORMAL,
    });

    agent.eventManager.subscribe({
      subscriberId: agent.id,
      eventType: EventType.DEVICE_OPERATION_EXECUTED,
      handler: (data: unknown) => {
        logger.info(`${agent.name} executed device operation:`, data);
      },
      priority: EventPriority.NORMAL,
    });
  }

  /**
   * Print execution summary
   */
  private printExecutionSummary(result: ACExecutionResult): void {
    logger.info('\n' + '='.repeat(80));
    logger.info('EXECUTION SUMMARY');
    logger.info('='.repeat(80));
    logger.info(`Collaboration ID: ${result.collaborationId}`);
    logger.info(`Success: ${result.success ? 'YES' : 'NO'}`);
    logger.info(`Final State: ${result.finalState}`);
    logger.info(`Duration: ${result.duration}ms`);
    logger.info(`Status: ${result.status}`);
    if (result.reason) {
      logger.info(`Reason: ${result.reason}`);
    }
    logger.info('');
    logger.info(`Goals Achieved: ${result.goalsAchieved.length}`);
    logger.info(`Goals Failed: ${result.goalsFailed.length}`);
    logger.info(`Goals In Progress: ${result.goalsInProgress.length}`);
    logger.info('');
    logger.info(`Device Operations: ${result.deviceOperations.length}`);
    logger.info(`Environment Effects: ${result.environmentEffects.length}`);
    logger.info(`Agent Communications: ${result.agentCommunications.length}`);
    logger.info(`Tasks Executed: ${result.tasksExecuted.length}`);
    if (result.predictions.length > 0) {
      const accurateCount = result.predictions.filter(p => p.accurate).length;
      logger.info(`Predictions: ${accurateCount}/${result.predictions.length} accurate`);
      for (const pred of result.predictions) {
        logger.info(`  - ${pred.parameter}: predicted=${pred.predictedValue}, actual=${pred.actualValue}, accurate=${pred.accurate}`);
      }
    }
    logger.info('='.repeat(80) + '\n');
  }

  /**
   * Get execution result by collaboration ID
   */
  getExecutionResult(collaborationId: string): ACExecutionResult | undefined {
    return this.executions.get(collaborationId);
  }

  /**
   * Get all execution history
   */
  getExecutionHistory(): ACExecutionResult[] {
    return [...this.executionHistory];
  }

  /**
   * Clear execution history
   */
  clearHistory(): void {
    this.executionHistory = [];
    logger.info('Execution history cleared');
  }

  // ========================================================================
  // Three-Phase Resource Matching Methods
  // ========================================================================

  /**
   * Plan execution for an agent to achieve a goal
   * Implements the three-phase resource matching strategy
   */
  async planExecution(
    goal: ACCollaborationGoal,
    agent: CognitiveAgent,
    availableServices: any[] = [],
    environment?: EnvironmentCenter
  ): Promise<ACExecutionPlan> {
    logger.info(`Planning execution for goal: ${goal.description}`);
    logger.info(`Agent: ${agent.name}`);

    // Step 1: Analyze requirements from goal
    const requirements = this.analyzeRequirements(goal);
    logger.info(`Analyzed ${requirements.length} task requirements`);

    // Step 2: Phase 1 - Match self resources
    const selfMatch = this.matchSelfResources(requirements, agent, environment);
    logger.info(`Phase 1: Matched ${selfMatch.matched.length} with own resources, ${selfMatch.unmatched.length} unmatched`);

    // Step 3: Phase 2 - Match external services
    const serviceMatch = this.matchExternalServices(selfMatch.unmatched, availableServices);
    logger.info(`Phase 2: Matched ${serviceMatch.matched.length} with existing services, ${serviceMatch.unmatched.length} still unmatched`);

    // Step 4: Phase 3 - Create capability requests for unmatched requirements
    const capabilityRequests: CapabilityRequest[] = [];
    if (serviceMatch.unmatched.length > 0) {
      logger.info(`Phase 3: Creating capability requests for ${serviceMatch.unmatched.length} requirements`);
      const request = this.createCapabilityRequest(serviceMatch.unmatched, goal, agent);
      capabilityRequests.push(request);
    }

    // Step 5: Build execution phases
    const phases = this.buildExecutionPhases(
      selfMatch.operations,
      serviceMatch.operations,
      goal
    );

    // Step 6: Build orchestration
    const orchestration = this.buildOrchestration(phases);

    const plan: ACExecutionPlan = {
      goalId: goal.id,
      goalDescription: goal.description,
      agentId: agent.id,
      requirements,
      phases,
      orchestration,
      serviceRequests: capabilityRequests,
      status: 'draft',
      createdAt: new Date(),
    };

    logger.info(`Execution plan created with ${phases.length} phases`);
    return plan;
  }

  /**
   * Analyze goal to extract task requirements
   */
  private analyzeRequirements(goal: ACCollaborationGoal): TaskRequirement[] {
    const requirements: TaskRequirement[] = [];

    // Map goal priority to requirement priority
    const priorityMap: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
      'low': 'low',
      'medium': 'medium',
      'high': 'high',
      'urgent': 'critical'
    };

    // NEW: Extract task parameters from goal
    const goalParams = (goal as unknown as Record<string, unknown>).parameters as Record<string, unknown> | undefined;
    logger.info(`Goal parameters:`, goalParams);

    for (const capability of goal.requiredCapabilities) {
      // NEW: Build expectedParameters from goal parameters
      const expectedParameters = this.buildExpectedParameters(capability, goalParams);

      // NEW: Map parameter values based on capability type
      const parameterValues = this.buildParameterValues(capability, goalParams);

      requirements.push({
        id: uuidv4(),
        capabilityType: capability,
        description: `Requires ${capability} capability`,
        semanticTags: this.extractSemanticTags(capability),
        priority: priorityMap[goal.priority] || 'medium',
        // NEW: Include expected parameters from goal
        expectedParameters,
        // NEW: Include actual parameter values
        parameterValues,
      });
    }

    return requirements;
  }

  /**
   * Build expected parameters for a capability based on goal parameters
   */
  private buildExpectedParameters(
    capability: string,
    goalParams?: Record<string, any>
  ): Record<string, { type: string; required: boolean; description?: string }> | undefined {
    if (!goalParams || Object.keys(goalParams).length === 0) {
      return undefined;
    }

    const cap = capability.toLowerCase();
    const params: Record<string, { type: string; required: boolean; description?: string }> = {};

    // Map goal parameters to expected parameters based on capability type
    if (cap.includes('temperature') || cap.includes('climate') || cap.includes('hvac')) {
      if (goalParams.targetTemp !== undefined) {
        params.temperature = {
          type: 'number',
          required: true,
          description: 'Target temperature in Celsius',
        };
      }
      if (goalParams.targetTemperature !== undefined) {
        params.temperature = {
          type: 'number',
          required: true,
          description: 'Target temperature in Celsius',
        };
      }
    }

    if (cap.includes('light') || cap.includes('illumination')) {
      if (goalParams.brightness !== undefined) {
        params.brightness = {
          type: 'number',
          required: false,
          description: 'Brightness level (0-100)',
        };
      }
      if (goalParams.state !== undefined) {
        params.state = {
          type: 'string',
          required: true,
          description: 'Light state (on/off)',
        };
      }
    }

    // Pass through any other parameters
    for (const [key, value] of Object.entries(goalParams)) {
      if (!params[key]) {
        params[key] = {
          type: typeof value,
          required: false,
          description: `Task parameter: ${key}`,
        };
      }
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  /**
   * Build actual parameter values for a capability based on goal parameters
   */
  private buildParameterValues(
    capability: string,
    goalParams?: Record<string, any>
  ): Record<string, any> | undefined {
    if (!goalParams || Object.keys(goalParams).length === 0) {
      return undefined;
    }

    const cap = capability.toLowerCase();
    const params: Record<string, any> = {};

    // Map goal parameters to command parameters based on capability type
    // IMPORTANT: Use 'target' for set-target-temperature command (device expects this)
    if (cap.includes('temperature') || cap.includes('climate') || cap.includes('hvac')) {
      // Temperature control parameters
      // Map targetTemp/targetTemperature to 'target' for set-target-temperature command
      if (goalParams.targetTemp !== undefined) {
        params.target = goalParams.targetTemp;
      }
      if (goalParams.targetTemperature !== undefined) {
        params.target = goalParams.targetTemperature;
      }
    }

    if (cap.includes('light') || cap.includes('illumination')) {
      // Light control parameters
      if (goalParams.brightness !== undefined) {
        params.brightness = goalParams.brightness;
      }
      if (goalParams.state !== undefined) {
        params.state = goalParams.state;
      }
    }

    // Pass through any other parameters that might be relevant
    for (const [key, value] of Object.entries(goalParams)) {
      if (!params[key]) {
        params[key] = value;
      }
    }

    logger.info(`Built parameter values for ${capability}:`, params);
    return Object.keys(params).length > 0 ? params : undefined;
  }

  /**
   * Extract semantic tags from capability name
   */
  private extractSemanticTags(capability: string): string[] {
    const tags: string[] = [];
    const cap = capability.toLowerCase();

    // Environment related
    if (cap.includes('air') || cap.includes('environment')) {
      tags.push('environment', 'air-quality');
    }
    if (cap.includes('traffic')) {
      tags.push('traffic', 'control');
    }
    if (cap.includes('temperature') || cap.includes('climate')) {
      tags.push('environment', 'climate');
    }
    if (cap.includes('emergency') || cap.includes('alert')) {
      tags.push('emergency', 'public-safety');
    }
    if (cap.includes('monitor') || cap.includes('detect')) {
      tags.push('monitoring', 'sensing');
    }
    if (cap.includes('control') || cap.includes('set')) {
      tags.push('control', 'actuation');
    }

    return tags.length > 0 ? tags : [capability];
  }

  /**
   * Get services provided by the agent itself using ServiceBroker pattern
   *
   * ARCHITECTURE (Sprint 13): This method implements the ServiceBroker pattern
   * to discover services from the environment and filter by providerAgentId.
   * This replaces direct access to agent.resourceManager.getAllResources().
   *
   * @param agent - The agent whose services we want to discover
   * @param environment - The environment center (optional, uses agent's environment if not provided)
   * @returns Array of services provided by this agent
   */
  private getSelfServices(agent: CognitiveAgent, environment?: EnvironmentCenter): any[] {
    // Use provided environment or try to get from agent's serviceBroker
    const env = environment || (agent.serviceBroker as unknown as Record<string, unknown>).environment as EnvironmentCenter | undefined;

    if (!env) {
      logger.warn(`Cannot discover self-services: no environment available for agent ${agent.name}`);
      return [];
    }

    // Discover all services from environment
    const allServices = env.discoverServices({});
    logger.info(`getSelfServices: discovered ${allServices.length} total services in environment`);

    // Also check agent's own resource manager for device IDs
    const agentDeviceIds = new Set(
      agent.resourceManager.getAllResources().map(r => r.id)
    );
    logger.info(`getSelfServices: agent ${agent.name} has ${agentDeviceIds.size} devices in resource manager`);

    // Filter services that are provided by this agent
    const selfServices = allServices.filter((service: any) => {
      // Method 1: AgentService with getProviderInfo()
      const providerInfo = service.getProviderInfo?.();
      if (providerInfo) {
        const isSelfService = providerInfo.providerAgentId === agent.id;
        if (isSelfService) {
          logger.info(`Found self-service via providerInfo: ${service.name}`);
        }
        return isSelfService;
      }

      // Method 2: Plain Service — match by deviceId against agent's resources
      const serviceDeviceId = (service as any).deviceId;
      if (serviceDeviceId && agentDeviceIds.has(serviceDeviceId)) {
        logger.info(`Found self-service via deviceId match: ${service.name} (device: ${serviceDeviceId})`);
        return true;
      }

      // Method 3: Check service ID pattern (service-{deviceId})
      if (service.id && service.id.startsWith('service-')) {
        const deviceId = service.id.replace('service-', '');
        if (agentDeviceIds.has(deviceId)) {
          logger.info(`Found self-service via service ID pattern: ${service.name}`);
          return true;
        }
      }

      return false;
    });

    // Wrap plain Service objects with getCapabilities/getProviderInfo if missing
    const wrappedServices = selfServices.map((service: any) => {
      if (service.getCapabilities && typeof service.getCapabilities === 'function') {
        return service;
      }
      // Add getCapabilities method to plain Service objects
      return {
        ...service,
        getCapabilities: () => service.capabilities || [],
        getProviderInfo: () => ({
          providerAgentId: agent.id,
          providerAgentName: agent.name,
        }),
        name: service.name,
        deviceId: service.deviceId,
      };
    });

    logger.info(`getSelfServices: found ${wrappedServices.length} self-services for agent ${agent.name}`);
    return wrappedServices;
  }

  /**
   * Phase 1: Match requirements with agent's own resources
   *
   * ARCHITECTURE (Sprint 13): Uses ServiceBroker pattern instead of direct
   * resourceManager.getAllResources() access. This maintains architecture
   * consistency with Sprint 10 (ServiceBroker) and Sprint 11 (CollaborationWorkflow).
   *
   * Instead of directly accessing agent's resources, we discover services
   * from the environment and filter by providerAgentId to find self-services.
   */
  private matchSelfResources(
    requirements: TaskRequirement[],
    agent: CognitiveAgent,
    environment?: EnvironmentCenter
  ): { matched: TaskRequirement[]; unmatched: TaskRequirement[]; operations: ACOperation[] } {
    const matched: TaskRequirement[] = [];
    const unmatched: TaskRequirement[] = [];
    const operations: ACOperation[] = [];

    // ARCHITECTURE (Sprint 13): Use ServiceBroker pattern - discover services from environment
    // and filter by providerAgentId to find self-services
    // This replaces direct access to agent.resourceManager.getAllResources()
    const selfServices = this.getSelfServices(agent, environment);
    logger.info(`matchSelfResources: discovered ${selfServices.length} self-services via ServiceBroker pattern`);

    for (const requirement of requirements) {
      let found = false;

      // Iterate over self-services discovered via ServiceBroker pattern
      // Match against the UNDERLYING DEVICE's capabilities, not the service's
      // combined capabilities (which include agent-derived ones that may not
      // reflect actual device functionality).
      for (const service of selfServices) {
        const serviceDeviceId = (service as any).deviceId;
        const device = serviceDeviceId ? agent.resourceManager.getResource(serviceDeviceId) : null;

        // Get capabilities from the actual device, not the service wrapper
        let matchCapabilities: string[];
        if (device) {
          const devCaps = device.getCapabilities?.() || [];
          matchCapabilities = devCaps.map((c: any) => c.name || String(c));
        } else {
          // Fallback: use service capabilities if device not found
          matchCapabilities = service.getCapabilities?.() || [];
        }

        logger.info(`Checking service ${service.name} (device caps: [${matchCapabilities.join(',')}]) against requirement: ${requirement.capabilityType}`);

        const hasCapability = matchCapabilities.some((cap: string) => {
          const capLower = cap.toLowerCase();
          const reqType = requirement.capabilityType.toLowerCase();

          const matchResult = capLower.includes(reqType) ||
                 reqType.includes(capLower) ||
                 requirement.semanticTags.some(tag =>
                   capLower.includes(tag.toLowerCase()) ||
                   tag.toLowerCase().includes(capLower)
                 );

          if (matchResult) {
            logger.info(`MATCH: capability '${cap}' matches requirement '${reqType}'`);
          }

          return matchResult;
        });

        if (hasCapability) {
          matched.push(requirement);
          // Use deviceId (actual resource ID) not serviceId for resource lookup
          const deviceId = (service as any).deviceId || service.id?.replace('service-', '') || service.id;
          operations.push({
            id: uuidv4(),
            taskId: requirement.id,
            source: 'self-resource',
            resourceOperation: {
              resourceId: deviceId,
              resourceName: service.name,
              capability: requirement.capabilityType,
              parameters: this.inferParameters(requirement),
            },
            status: 'pending',
          });
          found = true;
          break;
        }
      }

      if (!found) {
        unmatched.push(requirement);
      }
    }

    return { matched, unmatched, operations };
  }

  /**
   * Phase 2: Match remaining requirements with available external services
   */
  private matchExternalServices(
    requirements: TaskRequirement[],
    availableServices: any[]
  ): { matched: TaskRequirement[]; unmatched: TaskRequirement[]; operations: ACOperation[] } {
    const matched: TaskRequirement[] = [];
    const unmatched: TaskRequirement[] = [];
    const operations: ACOperation[] = [];

    for (const requirement of requirements) {
      let found = false;

      for (const service of availableServices) {
        const serviceCaps = service.capabilities || [];
        const hasCapability = serviceCaps.some((cap: string) => {
          const capLower = cap.toLowerCase();
          const reqType = requirement.capabilityType.toLowerCase();

          return capLower.includes(reqType) ||
                 reqType.includes(capLower) ||
                 requirement.semanticTags.some(tag =>
                   capLower.includes(tag.toLowerCase())
                 );
        });

        if (hasCapability) {
          matched.push(requirement);
          operations.push({
            id: uuidv4(),
            taskId: requirement.id,
            source: 'external-service',
            serviceOperation: {
              agentId: service.providerId,
              agentName: service.providerName,
              serviceId: service.serviceId,
              serviceName: service.serviceName,
              parameters: this.inferParameters(requirement),
            },
            status: 'pending',
          });
          found = true;
          break;
        }
      }

      if (!found) {
        unmatched.push(requirement);
      }
    }

    return { matched, unmatched, operations };
  }

  /**
   * Phase 3: Create capability request for unmatched requirements
   */
  private createCapabilityRequest(
    unmatched: TaskRequirement[],
    goal: ACCollaborationGoal,
    agent: CognitiveAgent
  ): CapabilityRequest {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60000); // 1 minute expiry

    return {
      id: uuidv4(),
      type: 'capability-request',
      requester: {
        agentId: agent.id,
        agentName: agent.name,
      },
      requirements: unmatched,
      context: {
        goalId: goal.id,
        goalDescription: goal.description,
        urgency: goal.priority === 'urgent' ? 'critical' : goal.priority,
      },
      status: 'pending',
      createdAt: now,
      expiresAt,
    };
  }

  /**
   * Build execution phases from operations
   */
  private buildExecutionPhases(
    selfOperations: ACOperation[],
    serviceOperations: ACOperation[],
    _goal: ACCollaborationGoal
  ): ACExecutionPhase[] {
    const phases: ACExecutionPhase[] = [];

    // Phase 1: Self-resource operations (can execute immediately)
    if (selfOperations.length > 0) {
      phases.push({
        id: uuidv4(),
        name: 'Self-Resource Execution',
        description: 'Execute operations using own resources',
        operations: selfOperations,
        executionMode: 'parallel',
        status: 'pending',
      });
    }

    // Phase 2: External service operations (require coordination)
    if (serviceOperations.length > 0) {
      phases.push({
        id: uuidv4(),
        name: 'External Service Coordination',
        description: 'Execute operations via external services',
        operations: serviceOperations,
        executionMode: 'parallel',
        status: 'pending',
      });
    }

    return phases;
  }

  /**
   * Build orchestration configuration
   */
  private buildOrchestration(phases: ACExecutionPhase[]): ACExecutionPlan['orchestration'] {
    const dependencies: Array<{ from: string; to: string; type: 'data' | 'success' }> = [];

    // Create sequential dependencies between phases
    for (let i = 0; i < phases.length - 1; i++) {
      dependencies.push({
        from: phases[i].id,
        to: phases[i + 1].id,
        type: 'success',
      });
    }

    return {
      mode: phases.length > 1 ? 'sequential' : 'parallel',
      dependencies,
    };
  }

  /**
   * Infer parameters for a requirement
   * Now prioritizes actual parameter values from the task over defaults
   */
  private inferParameters(requirement: TaskRequirement): Record<string, any> {
    // NEW: First check if we have actual parameter values from the task
    if (requirement.parameterValues && Object.keys(requirement.parameterValues).length > 0) {
      logger.info(`Using task parameter values for ${requirement.capabilityType}:`, requirement.parameterValues);
      return { ...requirement.parameterValues };
    }

    // Fallback to default parameters based on capability type
    const params: Record<string, any> = {};
    const capType = requirement.capabilityType.toLowerCase();

    if (capType.includes('power') || capType.includes('level')) {
      params.level = 100; // Default to maximum
    }
    if (capType.includes('mode')) {
      params.mode = 'auto';
    }
    if (capType.includes('temperature')) {
      params.temperature = 25;
    }
    // Cooling/heating: set mode so DeviceResource.resolveMultiCommand works
    if (capType.includes('cooling') || capType === 'cool') {
      params.mode = 'cooling';
      params.target = 24; // Default comfortable target
    }
    if (capType.includes('heating') || capType === 'heat') {
      params.mode = 'heating';
      params.target = 22;
    }
    // Humidity control
    if (capType.includes('humidity-control') || capType.includes('dehumidif')) {
      params.mode = 'dehumidify';
      params.target = 50; // Default target humidity
    }

    logger.info(`Using default parameters for ${requirement.capabilityType}:`, params);
    return params;
  }

  /**
   * Execute an execution plan
   */
  async executePlan(
    plan: ACExecutionPlan,
    agent: CognitiveAgent,
    result: ACExecutionResult
  ): Promise<boolean> {
    logger.info(`Executing plan for goal: ${plan.goalDescription}`);
    plan.status = 'executing';

    let allSuccess = true;

    for (const phase of plan.phases) {
      logger.info(`Executing phase: ${phase.name}`);
      phase.status = 'executing';

      // Execute operations based on mode
      if (phase.executionMode === 'parallel') {
        const results = await Promise.all(
          phase.operations.map(op => this.executeOperation(op, agent, result))
        );
        allSuccess = allSuccess && results.every(r => r);
      } else {
        for (const operation of phase.operations) {
          const success = await this.executeOperation(operation, agent, result);
          allSuccess = allSuccess && success;
          if (!success && phase.executionMode === 'sequential') {
            break; // Stop on first failure in sequential mode
          }
        }
      }

      phase.status = allSuccess ? 'completed' : 'failed';
    }

    plan.status = allSuccess ? 'completed' : 'failed';
    return allSuccess;
  }

  /**
   * Execute a single operation
   */
  private async executeOperation(
    operation: ACOperation,
    agent: CognitiveAgent,
    result: ACExecutionResult
  ): Promise<boolean> {
    logger.info(`Executing operation: ${operation.id}`);
    operation.status = 'executing';

    try {
      if (operation.source === 'self-resource' && operation.resourceOperation) {
        // Execute on own resource
        const resource = agent.resourceManager.getResource(operation.resourceOperation.resourceId);
        if (resource) {
          const execResult = await resource.execute(
            operation.resourceOperation.capability,
            operation.resourceOperation.parameters
          );

          operation.result = execResult;
          operation.status = execResult.success ? 'completed' : 'failed';

          // Record operation
          result.deviceOperations.push({
            id: uuidv4(),
            timestamp: new Date(),
            agentId: agent.id,
            agentName: agent.name,
            deviceId: operation.resourceOperation.resourceId,
            deviceName: operation.resourceOperation.resourceName,
            service: operation.resourceOperation.capability,
            parameters: operation.resourceOperation.parameters,
            result: execResult,
            success: execResult.success,
          });

          return execResult.success;
        }
      } else if (operation.source === 'external-service' && operation.serviceOperation) {
        // Request external service
        const serviceResult = await agent.requestService(
          operation.serviceOperation.agentId,
          operation.serviceOperation.serviceId,
          operation.serviceOperation.parameters
        );

        operation.result = serviceResult;
        operation.status = serviceResult.success ? 'completed' : 'failed';

        // Record operation
        result.deviceOperations.push({
          id: uuidv4(),
          timestamp: new Date(),
          agentId: agent.id,
          agentName: agent.name,
          deviceId: operation.serviceOperation.serviceId,
          deviceName: operation.serviceOperation.serviceName,
          service: operation.serviceOperation.serviceName,
          parameters: operation.serviceOperation.parameters,
          result: serviceResult,
          success: serviceResult.success,
        });

        return serviceResult.success;
      }

      operation.status = 'failed';
      operation.error = 'Unknown operation source';
      return false;
    } catch (error) {
      operation.status = 'failed';
      operation.error = error instanceof Error ? error.message : String(error);
      logger.error(`Operation failed:`, operation.error);
      return false;
    }
  }
}
