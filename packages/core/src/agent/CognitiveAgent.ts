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
import { runWithLLMAgentContext } from '@active-collaboration/llm-integration';
import type { LlmFunctionClients } from '../runtime/contract.js';
import type { AgentFlowInvocationOutcome, InvocableFlowOffering } from '../flows/index.js';
import { executableCommandPath } from '../flows/index.js';
import type { Device, Service } from '@active-collaboration/shared';

// Natural-language interface (cognitive architecture Phase 3)
import {
  buildErrorFallbackDecision,
  NLDeviceGateError,
  runNLAsk,
  runNLCommand,
  type NLAskResult,
  type NLCommandResult,
  type NLDeviceView,
  type NLInteractionTrace,
  type NLRunOptions,
  type NLSeam,
  type NLZoneView,
} from '../nl/index.js';
import { isSensorStyleCapability } from '../decision/rule-actuation-planner.js';

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
import type { ACCollaborationConfig, ACCollaborationGoal, ResourceRequirement } from '../decision/GoalFormulationEngine.js';
import type { AgentProfile } from '../goal/types.js';
import { IntrinsicMotivationEngine } from '../goal/IntrinsicMotivationEngine.js';
import { GoalManager } from '../goal/GoalManager.js';
import type { RoleContext, MotivationLevel, ActionSuggestion } from '../goal/types.js';

// Phase 2 (cognitive architecture): the L1 world-model write face + the
// owner-goal projection feeding the manager's goal stack.
import { AgentWorldModelStore } from '../cognition/world-model.js';
import { goalsFromAgentProfile } from '../cognition/world-model-builder.js';
import { MetaCognition, buildMetaCognitionSummary, type AgentMetaCognitionSummary } from '../cognition/meta.js';
import { AgentRoleType } from '../goal/types.js';

// Task Execution System
import { ACExecutor, type ACExecutionOptions } from '../execution/ACExecutor.js';

// Proposal System
import {
  MultiFactorProposalEvaluator,
  ScoreBasedProposalSelector,
  ServiceLifecycleManager,
  type IProposalEvaluator,
  type IProposalSelector,
} from '../proposal/index.js';
import { CollaborationProposalHandler } from '../proposal/CollaborationProposalHandler.js';
import type { ProposalGroundTruthFace } from '../types/proposal-handler.js';

// Context System
import { AgentContextBuilder, type FullAgentContext, type AgentInfo } from '../context/index.js';

// Planning System
import { TaskPlanner, type PlanningContext } from '../planning/index.js';

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
  /**
   * P4-3: collaboration workflow synthesis. When enabled, multi-step AC goals
   * are planned by an LLM-authored WorkflowPlan (statically validated,
   * deterministically executed) instead of the legacy fake-planning path.
   * llmClient defaults to this agent's own client when omitted.
   */
  workflowSynthesis?: { enabled: boolean; llmClient?: LLMClient };
  /**
   * Per-function routed LLM clients (deployment-level model routing). Each
   * slot overrides `llmClient` for ONE call-site class: decision (AC
   * necessity), eval (proposal-response evaluation), nl (NL intent parsing).
   * Counter-offers, planning and workflow synthesis keep `llmClient`.
   */
  llmFunctionClients?: LlmFunctionClients;
  /**
   * R101 (P0): the host's executability oracle (the SAME predicate invoke
   * gates / flow validation / device details read — the server wires
   * CommandHandlerRegistry's isCapabilityExecutable). When present, the
   * agent's NL device views list only commands that really dispatch.
   */
  isCommandExecutable?: (capabilityName: string) => boolean;
  /**
   * T123: the world's current nominal sim-per-wall-second rate, read LIVE
   * (per handshake) — feeds the AC handshake-window real-time floor gate.
   * Absent = rate unknown, the floor never engages (default behavior).
   */
  simRateProvider?: () => number;
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
  // Phase 2 (cognition §3.1): the structured L1 write face — the legacy
  // environmentStateSnapshot Map is now a PROJECTION of this store (the
  // getters below are behavior-pinned; see context-builder-pins tests).
  private readonly worldModelStore = new AgentWorldModelStore();

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
  /** Per-function routed clients (absent slots fall through to llmClient). */
  private readonly llmFunctionClients?: LlmFunctionClients;
  /** R101: the host's executability oracle (see CognitiveAgentConfig). */
  private readonly isCommandExecutable?: (capabilityName: string) => boolean;
  /** T123: live world-rate seam for the handshake-window floor gate. */
  private readonly simRateProvider?: () => number;
  private owner: string;
  private readonly workflowSynthesis?: { enabled: boolean; llmClient?: LLMClient };

  /**
   * Fix-12: evaluation-LLM budget for the proposal handler, from
   * AC_PROPOSAL_EVAL_LLM_TIMEOUT_MS (invalid/absent → handler default).
   */
  private static evalLlmTimeoutFromEnv(): number | undefined {
    const raw = process.env.AC_PROPOSAL_EVAL_LLM_TIMEOUT_MS;
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

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
    this.llmFunctionClients = config.llmFunctionClients;
    this.isCommandExecutable = config.isCommandExecutable;
    this.simRateProvider = config.simRateProvider;
    this.agentProfile = config.agentProfile;
    this.workflowSynthesis = config.workflowSynthesis;

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
      this.capabilities,
      this.name
    );

    this.collaborationCoordinator = new CollaborationCoordinator(
      this.collaborationManager,
      this.dialogueManager,
      this.eventEmitter,
      this.environment,
      this.id,
      this.name,
      this.capabilities,
      (status: AgentStatus) => { this.status = status; },
      // Wave-4a: lets the initiator evaluate partner counter-proposals with
      // the agent's own LLM (without it counters are rejected by rule).
      // T123: live world-rate seam — the coordinator reads it per handshake
      // to decide whether the real-time response floor engages.
      { llmClient: this.llmClient, simRateProvider: this.simRateProvider }
    );

    // Initialize AC Decision System components
    this.dualTriggerACManager = new DualTriggerACManager(
      this.id,
      this.name,
      this.capabilities,
      // Per-function routing: the decision call site follows the routed
      // decision client when the deployment configures one.
      this.llmFunctionClients?.decision ?? this.llmClient,
      this.environment,
      async (acConfig: ACCollaborationConfig, result: DualTriggerResult) => {
        // Delegate to CollaborationCoordinator for AC initiation
        await this.collaborationCoordinator.handleAutonomousACInitiation(acConfig, result, this.buildACExecutionOptions());
      },
      {
        // Rule-only actuation path: lets the AC manager issue deterministic
        // device commands when no LLM is configured (unused otherwise).
        commandExecutor: (deviceId: string, commandName: string, params?: Record<string, unknown>) =>
          this.executeDeviceCommand(deviceId, commandName, params),
        ...(config.dualTriggerConfig ?? {}),
      }
    );
    // Phase 2 (cognition §4.2): owner-assigned goals (AgentProfile) + the
    // scope-of-practice exclusions (T-036) ride the manager into the world
    // model's goal stack / scope face.
    const cannotDeliverClasses = Array.isArray(this.metadata?.cannotDeliverClasses)
      ? (this.metadata.cannotDeliverClasses as unknown[]).filter((c): c is string => typeof c === 'string')
      : undefined;
    this.dualTriggerACManager.setAgentGoals(
      goalsFromAgentProfile(config.agentProfile),
      cannotDeliverClasses,
    );
    // Phase 5 (cognition §7): the agent's meta-cognition — decision-quality
    // tracking, capability-boundary awareness, partner trust calibration and
    // adaptive behavior. Owned HERE (agent-level state), consumed by the
    // manager (prompt context + outcome reconciliation) and checkpointed
    // through the manager's cognition checkpoint face.
    this.dualTriggerACManager.setMetaCognition(new MetaCognition({ agentId: this.id }));
    // R40-C3: the agent's world-model parameter face rides the manager's
    // cognition checkpoint — without this binding, resume starts the legacy
    // environment projections (getEnvironmentStateSnapshot) from zero until
    // the next event arrives (checkpoint drift).
    this.dualTriggerACManager.setEnvironmentParamFaceStore(this.worldModelStore);
    // Auto-enable dual trigger AC (default behavior for autonomous agents)
    this.dualTriggerEnabled = true;

    // Phase 2: Wire the agent's ServiceBroker into the PartnerSelectionNegotiator
    // so partner selection queries published services first (Scenario A),
    // falling back to capability broadcast (Scenario B) when no services match.
    this.dualTriggerACManager.getPartnerNegotiator()?.setServiceBroker(this.serviceBroker);
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
      // Fix-12: per-call budget for the proposal-evaluation LLM. A cold or
      // unreachable model otherwise burns the provider timeout (historically
      // 120s) before the fallback fires, stalling every handshake ~2 min
      // (R4 小周 F-16). Overridable via AC_PROPOSAL_EVAL_LLM_TIMEOUT_MS.
      llmTimeoutMs: CognitiveAgent.evalLlmTimeoutFromEnv(),
    };

    this.proposalHandler = new CollaborationProposalHandler({
      // Per-function routing: the evaluation call site follows the routed
      // eval client when the deployment configures one.
      llmClient: this.llmFunctionClients?.eval ?? this.llmClient,
      environment: this.environment,
      agentId: this.id,
      agentName: this.name,
      agentCapabilities: this.capabilities,
      config: proposalHandlerConfig,
      // T-202: live bound-device surface — read at evaluation time (devices
      // are assigned after construction), so the handshake prompt and the
      // capability fallback reflect what the agent's devices deliver.
      deviceSurface: () => this.getDeviceSurface(),
      // R6-C-F03: live ground-truth surface — the responder's own
      // observations (zone readings + observable zones + event ring), so the
      // evaluation can verify a claimed emergency against the physical world
      // instead of taking the initiator's narrative on faith.
      groundTruthSurface: () => this.getProposalGroundTruthFace(),
    });

    // Set agent reference so handler can call joinCollaboration() on acceptance
    this.proposalHandler.setAgent(this);

    logger.info(`[CognitiveAgent:${this.id}] CollaborationProposalHandler initialized`);

    // Register with environment
    this.environment.registerAgent(this as unknown as Record<string, unknown> & { id: string; name: string }, this.owner);

    logger.info(`[CognitiveAgent:${this.id}] Agent initialized with all coordinators`);
    this.status = AgentStatus.IDLE;
  }

  /**
   * P4-3: build AC execution options for the workflow-synthesis path.
   * Returns undefined when synthesis is disabled (default) — the executor
   * then takes the legacy path unchanged.
   */
  private buildACExecutionOptions(): ACExecutionOptions | undefined {
    if (!this.workflowSynthesis?.enabled) return undefined;
    return {
      useWorkflowSynthesis: true,
      workflowSynthesis: { llmClient: this.workflowSynthesis.llmClient ?? this.llmClient },
    };
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
    this.worldModelStore.clear();
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
  /**
   * T-202: the agent's CURRENT bound-device surface (id, name, capabilities,
   * zone) read live from the resource manager. The single source feeding the
   * proposal handler's handshake prompt/fallback and the AC manager's device
   * sync — declared capabilities alone are a thin view of deliverability.
   * R44-extreme-F1: also carries the device TYPE when known — the proposal
   * handler's prompt-budget aggregate line reports the trimmed tail's type
   * mix ("backup-generator×8, hvac×12").
   */
  getDeviceSurface(): Array<{ id: string; name: string; capabilities: string[]; zoneId?: string; type?: string }> {
    return this.resourceManager.getAllResources().map(r => {
      const state = r.getState?.() as Record<string, unknown> | undefined;
      const location = state?.location;
      const name = typeof state?.deviceName === 'string' ? state.deviceName : r.id;
      const type = r.getMetadata?.()?.type;
      return {
        id: r.id,
        name,
        capabilities: r.getCapabilities().map(c => c.name || String(c)),
        ...(typeof location === 'string' ? { zoneId: location } : {}),
        ...(typeof type === 'string' && type.length > 0 ? { type } : {}),
      };
    });
  }

  /**
   * R6-C-F03: the agent's OWN observation face for proposal ground-truth
   * checks — observable zones (managed ∪ bound-device ∪ any zone with
   * readings), the world-model parameter projection (latest readings per
   * zone), and the digested event ring. Zone-scoped event delivery already
   * gates what could enter these stores, so the face is exactly "what this
   * responder can independently verify". Read live at evaluation time.
   */
  getProposalGroundTruthFace(): ProposalGroundTruthFace {
    const zoneReadings = this.worldModelStore.zoneParameterProjection();
    const observable = new Set<string>(zoneReadings.map(z => z.zoneId));
    const managedZoneIds = this.metadata?.managedZoneIds;
    if (Array.isArray(managedZoneIds)) {
      for (const zoneId of managedZoneIds) {
        if (typeof zoneId === 'string' && zoneId.length > 0) observable.add(zoneId);
      }
    }
    for (const device of this.getDeviceSurface()) {
      if (device.zoneId !== undefined && device.zoneId.length > 0) observable.add(device.zoneId);
    }
    const recentEvents = (this.dualTriggerACManager?.getCognitionCheckpoint().events ?? [])
      .map(e => ({
        type: e.type,
        ...(e.zoneId !== undefined ? { zoneId: e.zoneId } : {}),
        ...(e.parameter !== undefined ? { parameter: e.parameter } : {}),
        ...(e.value !== undefined ? { value: e.value } : {}),
      }));
    return {
      observableZoneIds: [...observable],
      zoneReadings,
      recentEvents,
    };
  }

  /**
   * R42-A/F3 §7.1: live provider for this agent's OWN service catalog
   * (derived + published rows). The server's service store injects it per
   * runtime (EngineRuntime.setAgentServiceSurface → seams); nothing in core
   * owns the catalog. Read at handshake-evaluation time, never at wiring
   * time — services are minted while the world runs.
   */
  private myServicesProvider?: () => Array<{ name: string; semanticType: string; visibility?: string; origin?: string }>;

  /**
   * R42-A/F3 §7.1: the proposal handler's `listMyServices` seam target —
   * called through the ProposalHandlerAgent interface so the handshake
   * prompt can show "YOUR SERVICES (what you expose to others)". Returns
   * an empty face until a provider is wired (legacy/embedded runtimes).
   */
  setMyServicesProvider(
    provider: (() => Array<{ name: string; semanticType: string; visibility?: string; origin?: string }>) | undefined,
  ): void {
    this.myServicesProvider = provider;
  }

  /** R42-A/F3 §7.1: the agent's current service face (see setMyServicesProvider). */
  listMyServices(): Array<{ name: string; semanticType: string; visibility?: string; origin?: string }> {
    try {
      return this.myServicesProvider?.() ?? [];
    } catch {
      return []; // provider faults degrade to "no services known"
    }
  }

  assignDevices(devices: Device[], owner: string): void {
    logger.info(`[CognitiveAgent:${this.id}] Assigning ${devices.length} devices`);
    this.resourceCoordinator.assignDevices(devices, owner);
    logger.info(`[CognitiveAgent:${this.id}] Devices assigned. Total: ${this.resourceManager.getCount()}`);

    // Sync device info to DualTriggerACManager so AC decisions use agent's actual devices
    if (this.dualTriggerACManager) {
      this.dualTriggerACManager.setAgentDevices(this.getDeviceSurface().map(d => ({
        deviceId: d.id,
        type: this.resourceManager.getResource(d.id)?.getMetadata?.()?.type || 'unknown',
        capabilities: d.capabilities,
        // Zone scoping for rule-only actuation (device location = zoneId for sim devices)
        ...(d.zoneId !== undefined ? { zoneId: d.zoneId } : {}),
      })));
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
   * BUG-07: cancel every pending AC handshake with an explicit reason —
   * called by the runtime before teardown (stop / world-session rebuild) so
   * the cancel lands on the trajectory instead of dying with the old event
   * bus. Delegates to CollaborationCoordinator; returns the number cancelled.
   */
  cancelPendingACHandshakes(reason: string): number {
    return this.collaborationCoordinator.cancelPendingHandshakes(reason);
  }

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

  /**
   * All collaboration sessions involving this agent (Fix-8): active ones
   * (including handshake-PENDING) plus completed/failed/cancelled history.
   * Powers the runtime collaboration query endpoint — the accepting
   * partner's view is only visible through ITS OWN manager, so the runtime
   * must ask every agent.
   */
  getCollaborationSessions(): {
    active: Array<{
      id: string; type: string; initiator: string; participants: string[];
      status: string; priority: string; description: string;
      createdAt: Date; updatedAt: Date;
      scopeExclusions?: Array<{ agentId: string; blockedBy: string[] }>;
    }>;
    completed: Array<{
      id: string; type: string; initiator: string; participants: string[];
      status: string; priority: string; description: string;
      createdAt: Date; updatedAt: Date;
      scopeExclusions?: Array<{ agentId: string; blockedBy: string[] }>;
    }>;
  } {
    const { active, completed } = this.collaborationManager.getAllSessions(this.id);
    const map = (
      s: {
        id: string; type: string; initiator: string; participants: string[];
        status: string; priority: string; description: string;
        createdAt: Date; updatedAt: Date;
        scopeExclusions?: Array<{ agentId: string; blockedBy: string[] }>;
      },
      useParticipation: boolean,
    ) => ({
      id: s.id,
      type: s.type,
      initiator: s.initiator,
      participants: [...s.participants],
      // Partner-side view (Fix-8): the partner's LOCAL session stays
      // 'pending' (nothing drives its lifecycle on this side), which would
      // misreport a collaboration the agent already accepted and joined —
      // report its participation status instead. History rows keep their
      // terminal status.
      status: useParticipation && s.initiator !== this.id
        ? (this.participationStatus.get(s.id)?.status ?? s.status)
        : s.status,
      priority: s.priority,
      description: s.description,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      // T-036-depth: honest scope-of-practice exclusions ride the session row.
      ...(s.scopeExclusions !== undefined ? { scopeExclusions: s.scopeExclusions } : {}),
    });
    return {
      active: active.map(s => map(s, true)),
      completed: completed.map(s => map(s, false)),
    };
  }

  // ==================== Service Execution ====================

  /**
   * Execute a command on a device
   * Device Layer operation - executes basic device commands
   *
   * @param options.actor - Invocation-context actor (R17 params-purity fix:
   *   attribution rides the context, never params — the device stamps it on
   *   secure-state audit fields and the DEVICE_OPERATION_EXECUTED event).
   *   T-712 (R29, F9): when no actor is supplied, the agent attributes
   *   itself (`agent:<agentId>`) — mirroring the flow lane's `flow:<flowId>`
   *   (T-608) — so device audit trails (lock accessLog, display contentSetBy)
   *   never fall back to 'unknown' on the auto-actuation lane.
   */
  async executeDeviceCommand(
    deviceId: string,
    commandName: string,
    params?: any,
    options: { actor?: string } = {},
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    logger.info(`[CognitiveAgent:${this.id}] Executing command ${commandName} on device ${deviceId}`);

    // T-712: explicit actor wins (user display name, agreement label, flow
    // id); only an unlabeled invocation defaults to the agent itself.
    const effectiveOptions = options.actor !== undefined && options.actor.length > 0
      ? options
      : { ...options, actor: `agent:${this.id}` };

    try {
      // Delegate to DeviceCommandCoordinator (Device Layer)
      const result = await this.deviceCommandCoordinator.executeCommand(
        deviceId,
        commandName,
        params,
        effectiveOptions
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
   * @param invocationContext - T-608 (R26): optional actor label for the
   *   device audit trail ({actor: 'flow:<flowId>'} on the flow lane). Never
   *   merged into `parameters` (R17 params purity). T-712 (R29, F9): an
   *   unlabeled invocation (e.g. the AC auto-actuation lane, which passes no
   *   context) defaults to `agent:<agentId>` — same mirroring as
   *   executeDeviceCommand, so audit trails never say 'unknown'.
   * @returns Execution result
   */
  async executeDeviceCapability(
    deviceId: string,
    capability: string,
    parameters: Record<string, any> = {},
    invocationContext?: { actor?: string; eventId?: string },
  ): Promise<{
    success: boolean;
    result?: any;
    error?: string;
  }> {
    logger.info(`[CognitiveAgent:${this.id}] Executing capability '${capability}' on device resource ${deviceId}`);

    // T-712: explicit actor wins (flow:<flowId>, user label); only an
    // unlabeled invocation defaults to the agent itself.
    const effectiveContext =
      invocationContext?.actor !== undefined && invocationContext.actor.length > 0
        ? invocationContext
        : { ...invocationContext, actor: `agent:${this.id}` };

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
      const result = await resource.execute(capability, parameters, effectiveContext);

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

    // Maintain the world model's parameter face from ENVIRONMENT_PARAM_CHANGED
    // events (Phase 2: the structured write face — the legacy snapshot is a
    // projection; same guard as before: parameter present + location known).
    if (event.type === EventType.ENVIRONMENT_PARAM_CHANGED) {
      const payload = event.payload;
      if (payload?.parameter && payload?.location !== undefined) {
        this.worldModelStore.applyEnvironmentParamChanged({
          location: String(payload.location),
          parameter: String(payload.parameter),
          newValue: payload.newValue,
          timestamp: event.timestamp,
        });
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
        // R91 感知源（source='perception'）只走 L1 规则 + 世界模型消化：
        // 连续感知不进 L2/LLM 评估器（其墙钟重试会破坏确定性），且
        // record-replay 的提示词逐位不变量得以保持。
        if (event.payload?.source === 'perception') {
          this.dualTriggerACManager.perceiveEvent(event);
        } else {
          const result = await this.dualTriggerACManager.processEvent(event);
          logger.info(`[CognitiveAgent:${this.id}] DualTrigger result: path=${result.path}`);
        }
      } catch (error) {
        logger.error(`[CognitiveAgent:${this.id}] DualTrigger processing error:`, error);
      }
    }

    logger.info(`[CognitiveAgent:${this.id}] Event handled`);
  }

  /**
   * Get environment state snapshot as a readonly array (LEGACY projection
   * of the world-model store — behavior-pinned). Each entry contains key,
   * value, location, and timestamp.
   */
  getEnvironmentStateSnapshot(): ReadonlyArray<{
    key: string;
    value: number | boolean;
    location: string;
    timestamp: Date;
  }> {
    return this.worldModelStore.projectEnvironmentSnapshot();
  }

  /**
   * Get whether dual-trigger AC is enabled
   */
  getDualTriggerEnabled(): boolean {
    return this.dualTriggerEnabled;
  }

  /**
   * Get current environment state from snapshot (LEGACY projection of the
   * world-model store — behavior-pinned).
   * Built from ENVIRONMENT_PARAM_CHANGED events received by this agent
   */
  getEnvironmentState(parameter?: string, location?: string): Record<string, unknown> {
    return this.worldModelStore.projectEnvironmentState(parameter, location);
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
    // R40-C2 (design §7.1): the decision-quality metrics ride the export —
    // projected through the SAME B2 summary face the eval report uses
    // (honest nulls until outcomes reconcile), never re-derived here.
    const metaSummary = this.getMetaCognitionSummary();
    return {
      agentId: this.id,
      agentName: this.name,
      agentProfile: this.agentProfile,
      stats: this.getStats(),
      dualTriggerStats: this.getDualTriggerStats(),
      decisionQuality: {
        calibrationScore: metaSummary.calibrationScore,
        successRate: metaSummary.successRate,
        decisionCount: metaSummary.decisionCount,
        evaluatedDecisions: metaSummary.evaluatedDecisions,
      },
      motivationEngine: this.motivationEngine?.getExperimentLog?.() || [],
      acTriggerCorrelations: this.motivationEngine?.getACTriggerCorrelations?.() || [],
      goalHistory: this.goalManager?.getAllGoals?.() || [],
      activeCollaborations: this.getActiveCollaborations(),
      exportedAt: new Date(),
    };
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
   * R40-B2 (§7 exposure face): the read-only per-agent meta-cognition
   * summary for the eval report — calibration/success from the
   * decision-quality ring, trust partners from the calibration store, and
   * the capability boundary derived LIVE from the same T-202 surface +
   * T-036 scope-of-practice inputs the prompt face uses. Never throws and
   * never fabricates: absent state or un-reconciled outcomes project to
   * nulls with a note (cognition/meta.buildMetaCognitionSummary).
   */
  getMetaCognitionSummary(): AgentMetaCognitionSummary {
    const devices = this.getDeviceSurface().map(device => ({
      deviceId: device.id,
      capabilities: device.capabilities,
      online: this.resourceManager.getResource(device.id)?.isAvailable() ?? true,
    }));
    const scopeOfPractice = Array.isArray(this.metadata?.cannotDeliverClasses)
      ? (this.metadata!.cannotDeliverClasses as unknown[]).filter(
          (c): c is string => typeof c === 'string',
        )
      : undefined;
    return {
      ...buildMetaCognitionSummary({
        agentId: this.id,
        boundary: {
          capabilities: Array.from(new Set([
            ...this.capabilities,
            ...devices.flatMap(device => device.capabilities),
          ])),
          devices,
          ...(scopeOfPractice !== undefined ? { scopeOfPractice } : {}),
        },
        meta: this.dualTriggerACManager?.getMetaCognition(),
      }),
      agentName: this.name,
    };
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

  // ==================== Natural Language Interface (cognitive architecture Phase 3) ====================

  /**
   * Wall-clock bound for the NL lane's LLM round-trips (intent parse +
   * decision). Mirrors the assessor's timeout discipline: the HTTP request
   * behind a route must never hang on a dead provider.
   *
   * NL_LLM_TIMEOUT_MS (seconds) overrides the default: a shared single-GPU
   * vLLM can easily run p95 30-60s under sim load, and a caller-side abort
   * still counts as a backend failure for the circuit breaker — two 12s
   * aborts would open the breaker and degrade EVERY LLM decision for the
   * cooldown window, not just the NL lane.
   */
  private static readonly NL_LLM_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.NL_LLM_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000 : 12_000;
  })();

  /**
   * NL 交互可观测埋点（训练数据缺口修复）：EngineRuntime 在装配时挂到
   * TrajectoryRecorder.recordNLInteraction；交互结束时触发一次，
   * recorder 按 agentId 认领本次交互的 LLM 调用（prompt/rawResponse）。
   */
  private nlInteractionListener?: (trace: NLInteractionTrace) => void;

  // R6-E-F09: the NL lane's flow face (wired post-construction by
  // EngineRuntime.assembleFlows — the SAME agentInvocableFlowOfferings
  // provider and FlowEngine.runAsAgent lane the decision lane's Mechanism-B
  // wiring uses; both absent on flow-less runtimes).
  private nlInvocableFlowsProvider?: () => readonly InvocableFlowOffering[];
  private nlFlowInvoker?: (flowId: string, params?: Record<string, unknown>) => Promise<AgentFlowInvocationOutcome>;

  /**
   * R6-E-F09: wire the NL lane's invocable-flow listing + governed
   * invocation lane. Called by the runtime alongside the decision lane's
   * setInvocableFlowsProvider/setAgentFlowInvoker — one source, one gates.
   */
  setNLFlowLane(
    provider: () => readonly InvocableFlowOffering[],
    invoker: (flowId: string, params?: Record<string, unknown>) => Promise<AgentFlowInvocationOutcome>,
  ): void {
    this.nlInvocableFlowsProvider = provider;
    this.nlFlowInvoker = invoker;
  }

  setNLInteractionListener(listener: ((trace: NLInteractionTrace) => void) | undefined): void {
    this.nlInteractionListener = listener;
  }

  /** 防御性触发：监听器故障绝不打破 NL 响应。 */
  private emitNLTrace(trace: Omit<NLInteractionTrace, 'agentId' | 'agentName'>): void {
    if (this.nlInteractionListener === undefined) return;
    try {
      this.nlInteractionListener({ agentId: this.id, agentName: this.name, ...trace });
    } catch (error) {
      logger.warn(`[CognitiveAgent:${this.id}] NL interaction listener failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The agent's own device view for the NL seam — the SAME MY_DEVICES
   * surface the assessor prompt renders (id, name, type, zone, state, and
   * the actuation command list with sensor-style caps excluded), so what
   * the NL model is shown and what the bridge validates can never drift.
   */
  private buildNLDeviceViews(): NLDeviceView[] {
    return this.getDeviceSurface().map(device => {
      const resource = this.resourceManager.getResource(device.id);
      const state = resource?.getState?.() as Record<string, unknown> | undefined;
      // R101 (zhao-12/zhao-16): prefer the device's REAL type from state —
      // the resource metadata type is the generic 'device' for sim-backed
      // devices, which made the type-word matcher (空调 → hvac) blind to
      // the agent's OWN bound devices in type-driven resolution.
      const stateType = state?.deviceType;
      const type = typeof stateType === 'string' && stateType.length > 0
        ? stateType
        : resource?.getMetadata?.()?.type;
      const commands = [...new Set(
        this.executableCommandsOf(device, type)
          .filter(cap => cap.length > 0 && !isSensorStyleCapability(cap)),
      )];
      const boundedState: Record<string, unknown> | undefined = (() => {
        if (typeof state !== 'object' || state === null) return undefined;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(state)) {
          if (Object.keys(out).length >= 12) break;
          if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value;
          }
        }
        return Object.keys(out).length > 0 ? out : undefined;
      })();
      const online = state?.online !== false && state?.connected !== false;
      return {
        deviceId: device.id,
        name: device.name,
        type: typeof type === 'string' && type.length > 0 ? type : 'unknown',
        ...(device.zoneId !== undefined ? { zoneId: device.zoneId } : {}),
        online,
        commands,
        ...(boundedState !== undefined ? { state: boundedState } : {}),
      };
    });
  }

  /**
   * R101 (P0, chen-15): the device's actuation command list, derived through
   * the ONE executability contract (core's executableCommandPath + the
   * host-injected oracle, the same surface invoke gates / flow validation /
   * device details read). Without an injected oracle the legacy
   * declared-names behavior stands unchanged. With it, dead marketing
   * names never reach the MY_DEVICES prompt block — an agent cannot claim
   * its device "clearly supports" a command nothing executes.
   */
  private executableCommandsOf(
    device: { id: string; name: string; capabilities: string[]; zoneId?: string },
    deviceType: string | undefined,
  ): string[] {
    if (this.isCommandExecutable === undefined) {
      return device.capabilities.map(cap => cap.toLowerCase());
    }
    const names = new Set<string>();
    for (const capability of device.capabilities) {
      const path = executableCommandPath(
        {
          id: device.id,
          name: device.name,
          type: deviceType ?? '',
          role: 'hybrid',
          capabilities: [...device.capabilities],
          zoneId: device.zoneId ?? '',
          binding: `sim://${device.id}`,
        },
        capability,
        this.isCommandExecutable,
      );
      if (path !== null) for (const name of path) names.add(name);
    }
    return [...names];
  }

  /**
   * The agent's own MY_DEVICES view, PUBLIC for the platform's Phase-4
   * what-if lane (the /what-if route parses "what if I turn off X" against
   * exactly the surface the NL + delegate lanes validate against — one
   * truth, no second matcher). Structural superset of WhatIfDeviceView.
   */
  getNLDeviceViews(): readonly NLDeviceView[] {
    return this.buildNLDeviceViews();
  }

  // -------------------------------------------------------------------------
  // R99: conversational zone context for NL follow-ups — 「lab-101 温度多少？」
  // →「那湿度呢？」 must stay on lab-101. Zone-level counterpart of the
  // device-level resolution the command lane already gets from its budget.
  // -------------------------------------------------------------------------

  private nlContextZoneId: string | undefined;
  private nlContextZoneAtMs = 0;
  /** Follow-up inheritance window; older context falls back to the full jurisdiction. */
  private static readonly NL_CONTEXT_ZONE_TTL_MS = 10 * 60 * 1000;

  private nlFreshContextZoneId(): string | undefined {
    if (this.nlContextZoneId === undefined) return undefined;
    return Date.now() - this.nlContextZoneAtMs < CognitiveAgent.NL_CONTEXT_ZONE_TTL_MS
      ? this.nlContextZoneId
      : undefined;
  }

  private noteNLContextZone(zoneId: string | undefined): void {
    if (zoneId === undefined) return;
    this.nlContextZoneId = zoneId;
    this.nlContextZoneAtMs = Date.now();
  }

  /**
   * Build the NL seam: own device views, the caller-provided zone view (the
   * runtime knows scenario zones + live parameter values; the default
   * derives zones from device locations only — honest, never invented), and
   * an LLM chat function BOUNDED by a wall-clock abort. Rule-only agents
   * (provider "none") get no chat seam — the pipeline runs rules end to end.
   * `verifyWhatIf` (Phase 4) is PLATFORM-provided: forks of the live world
   * are a platform-owned lane (§13.2 — the agent proposes, the platform
   * simulates), so the route injects it per call rather than the agent
   * owning simulation machinery.
   */
  private buildNLSeam(options: { zones?: NLZoneView[]; verifyWhatIf?: NLSeam['verifyWhatIf']; assertDeviceCommand?: NLSeam['assertDeviceCommand'] }): NLSeam {
    const devices = this.buildNLDeviceViews();
    const zones: NLZoneView[] = options.zones !== undefined && options.zones.length > 0
      ? options.zones
      : [...new Set(devices.map(d => d.zoneId).filter((z): z is string => z !== undefined))]
          .map(zoneId => ({ zoneId }));
    const providerName = this.llmClient.getProviderName?.();
    const llmEnabled = typeof providerName === 'string' && providerName !== 'none';
    // R46-P0 (zone routing): the agent's jurisdiction — the runtime stamps
    // metadata.managedZoneIds (managesZoneIds ∪ bound-device zones). The NL
    // parser prefers these when resolving zone references, so a district
    // keeper's colloquial "南山变电站" lands on ITS nan-* zone instead of the
    // first bao-* zone in a global listing. Agents without a resolved
    // jurisdiction simply match globally (previous behavior).
    const managedZoneIds = Array.isArray(this.metadata?.managedZoneIds)
      ? this.metadata.managedZoneIds
        .filter((z: unknown): z is string => typeof z === 'string' && z.length > 0)
        .slice(0, 32)
      : undefined;
    // R46-P0 companion: a caller's zone view can be a bounded WINDOW over a
    // large world (the route snapshots the first N zones) — an agent whose
    // jurisdiction falls outside that window would then never see its own
    // zones and every reference re-routed to the first same-kind zone inside
    // the window. The agent's OWN zones are part of its view by definition:
    // inject the missing ones (display name from the runtime's stamp when
    // present — colloquial zh references text-match the name, never a bare
    // latin id; no parameters — honest "no readings yet", never invented).
    const viewZones = [...zones];
    if (managedZoneIds !== undefined && managedZoneIds.length > 0) {
      const rawNames = this.metadata?.managedZoneNames;
      const names =
        rawNames !== null && typeof rawNames === 'object' && !Array.isArray(rawNames)
          ? rawNames as Record<string, unknown>
          : {};
      const known = new Set(viewZones.map(z => z.zoneId));
      for (const zoneId of managedZoneIds) {
        if (viewZones.length >= 64) break;
        if (known.has(zoneId)) continue;
        known.add(zoneId);
        const name = names[zoneId];
        viewZones.push(
          typeof name === 'string' && name.length > 0 ? { zoneId, name } : { zoneId },
        );
      }
    }
    return {
      agent: {
        agentId: this.id,
        agentName: this.name,
        capabilities: this.capabilities,
        status: this.status,
        ...(managedZoneIds !== undefined && managedZoneIds.length > 0 ? { managedZoneIds } : {}),
      },
      devices,
      zones: viewZones,
      ...(llmEnabled
        ? {
            llmChat: async (params: ChatParams): Promise<string> => {
              // Per-function routing: NL intent parsing follows the routed
              // nl client when the deployment configures one.
              const nlClient = this.llmFunctionClients?.nl ?? this.llmClient;
              // T-022 归因：NL 道是 agent 的异步入口（路由直调，无事件在
              // 飞），包上 agent 上下文，logging callback（trajectory
              // recorder / llm-failure 账本）才能按 agentId 认领这些调用。
              const response = await runWithLLMAgentContext(
                { agentId: this.id, agentName: this.name },
                () => nlClient.chat({
                  ...params,
                  signal: AbortSignal.timeout(CognitiveAgent.NL_LLM_TIMEOUT_MS),
                }),
              );
              return response.content;
            },
          }
        : {}),
      executeDeviceCommand: (deviceId, command, params, execOptions) =>
        this.executeDeviceCommand(deviceId, command, params, { actor: execOptions.actor }),
      // R6-E-F09: the honest invocable-flow listing + the governed
      // invocation lane (wired by EngineRuntime from the SAME
      // agentInvocableFlowOfferings / FlowEngine.runAsAgent pair the
      // decision lane uses — see setNLFlowLane). Unwired → no listing and
      // no lane; the NL pipeline refuses invoke_flow decisions honestly
      // instead of hallucinating a match.
      ...(this.nlInvocableFlowsProvider !== undefined
        ? { invocableFlows: this.nlInvocableFlowsProvider }
        : {}),
      ...(this.nlFlowInvoker !== undefined
        ? { invokeFlow: this.nlFlowInvoker }
        : {}),
      ...(options.verifyWhatIf !== undefined ? { verifyWhatIf: options.verifyWhatIf } : {}),
      ...(options.assertDeviceCommand !== undefined ? { assertDeviceCommand: options.assertDeviceCommand } : {}),
    };
  }

  /**
   * Process a natural-language COMMAND: parse → decide (cognitive contract)
   * → execute (validated device actions) → respond in plain language.
   * Emergency markers escalate immediately; never throws — failures land in
   * the honest-accounting fields of the result. ONE exception (R46C-P0-A):
   * a platform device-ownership gate denial re-throws its original error —
   * a permission failure is a request-level failure, not pipeline
   * degradation, so the transport layer can answer with its own 4xx.
   */
  async processNaturalLanguageCommand(
    text: string,
    options: { zones?: NLZoneView[]; verifyWhatIf?: NLSeam['verifyWhatIf']; assertDeviceCommand?: NLSeam['assertDeviceCommand'] } & NLRunOptions = {},
  ): Promise<NLCommandResult> {
    logger.info(`[CognitiveAgent:${this.id}] NL command: ${String(text).slice(0, 120)}`);
    const { zones, verifyWhatIf, assertDeviceCommand, ...runOptions } = options;
    try {
      const result = await runNLCommand(
        this.buildNLSeam({
          ...(zones !== undefined ? { zones } : {}),
          ...(verifyWhatIf !== undefined ? { verifyWhatIf } : {}),
          ...(assertDeviceCommand !== undefined ? { assertDeviceCommand } : {}),
        }),
        text,
        runOptions,
      );
      // R99: a command that acted on a device anchors the conversation's
      // zone (a following 「那湿度呢？」 reads that room).
      const actedDeviceId = result.executionResult.actions[0]?.deviceId;
      if (actedDeviceId !== undefined) {
        this.noteNLContextZone(this.getDeviceSurface().find(d => d.id === actedDeviceId)?.zoneId);
      }
      this.emitNLTrace({
        lane: 'command',
        text: String(text),
        intentAction: result.intent.action,
        parseSource: result.intent.parseSource,
        decision: result.cognitiveDecision.actionPlan.primary.action,
        decisionSource: result.decisionSource,
        reasoning: result.cognitiveDecision.explanation.summary,
        executedCommands: result.executionResult.actions.length,
        success: result.executionResult.success,
        // R6-E-F09: invoke_flow 的执行回执随 nl-interaction 记录落账。
        ...(result.executionResult.flowInvocation !== undefined
          ? { flowInvocation: result.executionResult.flowInvocation }
          : {}),
      });
      return result;
    } catch (error: unknown) {
      // R46C-P0-A: a device-ownership gate denial propagates as-is (the
      // server lane's ApiError 403 must reach the HTTP status line, not the
      // generic honest-failure result).
      if (error instanceof NLDeviceGateError) throw error.denial;
      logger.error(`[CognitiveAgent:${this.id}] NL command error: ${error instanceof Error ? error.message : String(error)}`);
      // Honest failure result — the operator gets an explanation, never a hang.
      const decision = buildErrorFallbackDecision(
        error instanceof Error ? error.message : String(error),
      );
      this.emitNLTrace({
        lane: 'command',
        text: String(text),
        intentAction: 'unknown',
        parseSource: 'rules',
        decision: decision.actionPlan.primary.action,
        decisionSource: 'rules',
        reasoning: decision.explanation.summary,
        executedCommands: 0,
        success: false,
      });
      return {
        agentId: this.id,
        intent: { action: 'unknown', rawText: String(text).slice(0, 2000), parseSource: 'rules', notes: [`pipeline error: ${error instanceof Error ? error.message : String(error)}`] },
        cognitiveDecision: decision,
        decisionSource: 'rules',
        executionResult: { success: false, message: 'pipeline error', actions: [] },
        naturalLanguageResponse: 'I could not process that command — please rephrase it or check the server logs.',
      };
    }
  }

  /**
   * Answer a natural-language QUESTION from the agent's own view. Read-only
   * by construction: the ask lane has NO device-execution path. Status
   * questions answer from live zone/device data; explanatory questions get a
   * read-only situation assessment.
   */
  async answerNaturalLanguageQuestion(
    text: string,
    options: { zones?: NLZoneView[]; mentionZones?: readonly NLZoneView[] } = {},
  ): Promise<NLAskResult> {
    logger.info(`[CognitiveAgent:${this.id}] NL question: ${String(text).slice(0, 120)}`);
    try {
      // R99: pass the conversation's zone so a zone-less follow-up inherits
      // it; an explicitly named zone (result.intent.targetZones) re-anchors.
      const contextZoneId = this.nlFreshContextZoneId();
      const result = await runNLAsk(this.buildNLSeam(options), text, {
        ...(contextZoneId !== undefined ? { contextZoneId } : {}),
        // T105 (R17): the world-wide mention-resolution surface — the parse's
        // targetZones resolve foreign building mentions too (the server's
        // jurisdiction disclosure consumes the same resolved zones).
        ...(options.mentionZones !== undefined ? { mentionZones: options.mentionZones } : {}),
      });
      this.noteNLContextZone(result.intent.targetZones?.[0]);
      const assessment = result.data.assessment;
      this.emitNLTrace({
        lane: 'ask',
        text: String(text),
        intentAction: result.intent.action,
        parseSource: result.intent.parseSource,
        decision: assessment?.actionPlan.primary.action ?? result.intent.action,
        decisionSource: assessment !== undefined ? 'llm' : 'rules',
        ...(assessment !== undefined ? { reasoning: assessment.explanation.summary } : {}),
      });
      return result;
    } catch (error: unknown) {
      logger.error(`[CognitiveAgent:${this.id}] NL question error: ${error instanceof Error ? error.message : String(error)}`);
      this.emitNLTrace({
        lane: 'ask',
        text: String(text),
        intentAction: 'unknown',
        parseSource: 'rules',
        decision: 'unknown',
        decisionSource: 'rules',
        success: false,
      });
      return {
        agentId: this.id,
        intent: { action: 'unknown', rawText: String(text).slice(0, 2000), parseSource: 'rules', notes: [`pipeline error: ${error instanceof Error ? error.message : String(error)}`] },
        data: {},
        naturalLanguageResponse: "I couldn't answer that right now — please try again.",
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
