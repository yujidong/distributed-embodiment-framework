/**
 * Autonomous AC Trigger System
 *
 * This system enables agents to AUTOMATICALLY decide when to create ACs
 * based on environment conditions, capabilities, and goals.
 *
 * Key Principles:
 * 1. Agents monitor environment continuously
 * 2. Agents detect conditions requiring collaboration
 * 3. Agents AUTOMATICALLY create AC when needed
 * 4. AC execution emerges from agent autonomy
 */

import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { CognitiveAgent } from '../agent/CognitiveAgent.js';
import { CollaborationManager } from '../management/CollaborationManager.js';
import { ACExecutor, ACCollaborationConfig, ACCollaborationGoal } from '../execution/ACExecutor.js';
import { EventType, EventPriority } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * AC Trigger Condition
 * Defines when an agent should automatically create an AC
 */
const logger = createLogger('AutonomousACManager');

export interface ACTriggerCondition {
  id: string;
  name: string;
  description: string;

  // Condition evaluation
  conditionType: 'environment-parameter' | 'device-state' | 'task-complexity' | 'resource-shortage' | 'emergency';
  triggerParameter?: string;  // e.g., 'pm25', 'traffic_flow'
  triggerOperator?: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'exceeds';
  triggerValue?: string | number | boolean;

  // What triggers this condition
  agentCapability: string;  // Capability needed to detect this
  priority: 'low' | 'medium' | 'high' | 'urgent';

  // AC creation template
  requiredCollaborators: string[];  // Agent types needed
  collaborationGoal: string;  // What the AC should achieve
}

/**
 * Autonomous AC Decision Result
 */
export interface AutonomousACDecision {
  shouldCreateAC: boolean;
  reason: string;
  conditionId: string;
  conditionName: string;
  priority: string;
  proposedCollaborators: string[];
  proposedGoals: string[];
}

// ============================================================================
// Smart City AC Trigger Conditions
// Pre-defined conditions that automatically trigger AC creation
// ============================================================================

export const SMART_CITY_AC_TRIGGERS: ACTriggerCondition[] = [
  // ========================================
  // AIR QUALITY TRIGGERS (5 conditions)
  // ========================================
  {
    id: 'trigger-air-quality-pm25-high',
    name: 'High PM2.5 Detected',
    description: 'PM2.5 level exceeds safe threshold, requires coordinated response',
    conditionType: 'environment-parameter',
    triggerParameter: 'pm25',
    triggerOperator: '>',
    triggerValue: 50,
    agentCapability: 'monitor-air-quality',
    priority: 'high',
    requiredCollaborators: ['traffic-controller', 'environmental-specialist'],
    collaborationGoal: 'Reduce air pollution by coordinating traffic reduction and monitoring',
  },
  {
    id: 'trigger-air-quality-aqi-very-high',
    name: 'Very High AQI Alert',
    description: 'AQI exceeds 150, requires urgent multi-agency response',
    conditionType: 'environment-parameter',
    triggerParameter: 'aqi',
    triggerOperator: '>',
    triggerValue: 150,
    agentCapability: 'monitor-air-quality',
    priority: 'urgent',
    requiredCollaborators: ['traffic-controller', 'environmental-specialist', 'public-safety-officer'],
    collaborationGoal: 'Urgent air quality response - reduce emissions and alert public',
  },
  {
    id: 'trigger-air-quality-pollution-spike',
    name: 'Sudden Pollution Spike',
    description: 'Rapid increase in pollution levels detected',
    conditionType: 'environment-parameter',
    triggerParameter: 'pm25_rate_of_change',
    triggerOperator: '>',
    triggerValue: 20,  // Increase of 20 in short time
    agentCapability: 'detect-pollution',
    priority: 'high',
    requiredCollaborators: ['environmental-specialist', 'traffic-controller'],
    collaborationGoal: 'Identify pollution source and coordinate response',
  },

  // ========================================
  // TRAFFIC TRIGGERS (8 conditions)
  // ========================================
  {
    id: 'trigger-traffic-congestion-severe',
    name: 'Severe Traffic Congestion',
    description: 'Traffic flow below threshold for extended period',
    conditionType: 'environment-parameter',
    triggerParameter: 'traffic_flow',
    triggerOperator: '<',
    triggerValue: 20,
    agentCapability: 'detect-congestion',
    priority: 'high',
    requiredCollaborators: ['transportation-coordinator', 'parking-manager'],
    collaborationGoal: 'Reduce congestion by optimizing signals and parking availability',
  },
  {
    id: 'trigger-traffic-incident-detected',
    name: 'Traffic Incident Detected',
    description: 'Accident or obstruction detected on road',
    conditionType: 'device-state',
    triggerParameter: 'incident_status',
    triggerOperator: '==',
    triggerValue: 'active',
    agentCapability: 'detect-incidents',
    priority: 'urgent',
    requiredCollaborators: ['emergency-response-coordinator', 'traffic-controller', 'public-safety-officer'],
    collaborationGoal: 'Coordinate emergency response to traffic incident',
  },
  {
    id: 'trigger-traffic-peak-hour',
    name: 'Peak Hour Traffic',
    description: 'Rush hour traffic patterns detected',
    conditionType: 'environment-parameter',
    triggerParameter: 'vehicle_count',
    triggerOperator: '>',
    triggerValue: 100,
    agentCapability: 'analyze-traffic-patterns',
    priority: 'medium',
    requiredCollaborators: ['traffic-controller', 'transportation-coordinator'],
    collaborationGoal: 'Optimize traffic flow during peak hours',
  },
  {
    id: 'trigger-traffic-emergency-vehicle',
    name: 'Emergency Vehicle in Transit',
    description: 'Emergency vehicle requires right-of-way',
    conditionType: 'device-state',
    triggerParameter: 'emergency_vehicle_detected',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-emergency-vehicles',
    priority: 'urgent',
    requiredCollaborators: ['traffic-controller', 'emergency-response-coordinator'],
    collaborationGoal: 'Clear route for emergency vehicle',
  },

  // ========================================
  // EMERGENCY TRIGGERS (6 conditions)
  // ========================================
  {
    id: 'trigger-emergency-fire',
    name: 'Fire Emergency',
    description: 'Fire detected in city area',
    conditionType: 'device-state',
    triggerParameter: 'fire_alarm_status',
    triggerOperator: '==',
    triggerValue: 'active',
    agentCapability: 'detect-fire',
    priority: 'urgent',
    requiredCollaborators: ['emergency-response-coordinator', 'traffic-controller', 'public-safety-officer', 'smart-city-manager'],
    collaborationGoal: 'Coordinate multi-agency fire response',
  },
  {
    id: 'trigger-emergency-flood',
    name: 'Flood Warning',
    description: 'Flood detected or imminent',
    conditionType: 'environment-parameter',
    triggerParameter: 'water_level',
    triggerOperator: '>',
    triggerValue: 100,  // cm
    agentCapability: 'detect-flood',
    priority: 'urgent',
    requiredCollaborators: ['emergency-response-coordinator', 'water-manager', 'public-safety-officer'],
    collaborationGoal: 'Coordinate flood response and evacuation',
  },
  {
    id: 'trigger-emergency-gunshot',
    name: 'Gunshot Detected',
    description: 'Gunshot detected in area',
    conditionType: 'device-state',
    triggerParameter: 'gunshot_detected',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-threats',
    priority: 'urgent',
    requiredCollaborators: ['public-safety-officer', 'emergency-response-coordinator', 'traffic-controller'],
    collaborationGoal: 'Coordinate immediate response to active shooter situation',
  },

  // ========================================
  // ENERGY TRIGGERS (4 conditions)
  // ========================================
  {
    id: 'trigger-energy-grid-overload',
    name: 'Power Grid Overload',
    description: 'Electric grid approaching capacity',
    conditionType: 'environment-parameter',
    triggerParameter: 'grid_load',
    triggerOperator: '>',
    triggerValue: 90,  // percent
    agentCapability: 'monitor-grid',
    priority: 'high',
    requiredCollaborators: ['energy-manager', 'smart-city-manager'],
    collaborationGoal: 'Reduce load and balance power distribution',
  },
  {
    id: 'trigger-energy-peak-demand',
    name: 'Peak Energy Demand',
    description: 'Unusually high energy demand detected',
    conditionType: 'environment-parameter',
    triggerParameter: 'power_demand',
    triggerOperator: '>',
    triggerValue: 1000,  // MW
    agentCapability: 'detect-peak-demand',
    priority: 'high',
    requiredCollaborators: ['energy-manager', 'traffic-controller'],
    collaborationGoal: 'Manage peak demand through demand response',
  },

  // ========================================
  // SAFETY TRIGGERS (3 conditions)
  // ========================================
  {
    id: 'trigger-safety-crowd-overdensity',
    name: 'Crowd Overdensity Detected',
    description: 'Unsafe crowd density in public space',
    conditionType: 'environment-parameter',
    triggerParameter: 'crowd_density',
    triggerOperator: '>',
    triggerValue: 5,  // people per square meter
    agentCapability: 'monitor-crowds',
    priority: 'high',
    requiredCollaborators: ['public-safety-officer', 'transportation-coordinator'],
    collaborationGoal: 'Manage crowd safety and redirect traffic',
  },
  {
    id: 'trigger-safety-low-visibility',
    name: 'Low Visibility Conditions',
    description: 'Poor visibility due to weather or darkness',
    conditionType: 'environment-parameter',
    triggerParameter: 'visibility',
    triggerOperator: '<',
    triggerValue: 50,  // meters
    agentCapability: 'detect-visibility',
    priority: 'medium',
    requiredCollaborators: ['lighting-controller', 'traffic-controller', 'public-safety-officer'],
    collaborationGoal: 'Improve visibility and safety conditions',
  },

  // ========================================
  // WATER TRIGGERS (2 conditions)
  // ========================================
  {
    id: 'trigger-water-leak',
    name: 'Water Leak Detected',
    description: 'Water leak detected in infrastructure',
    conditionType: 'device-state',
    triggerParameter: 'leak_detected',
    triggerOperator: '==',
    triggerValue: true,
    agentCapability: 'detect-leaks',
    priority: 'high',
    requiredCollaborators: ['water-manager', 'emergency-response-coordinator'],
    collaborationGoal: 'Locate and repair water leak',
  },
  {
    id: 'trigger-water-quality-poor',
    name: 'Poor Water Quality',
    description: 'Water quality below safe standards',
    conditionType: 'environment-parameter',
    triggerParameter: 'water_quality_index',
    triggerOperator: '<',
    triggerValue: 50,
    agentCapability: 'monitor-water-quality',
    priority: 'high',
    requiredCollaborators: ['water-manager', 'environmental-specialist'],
    collaborationGoal: 'Identify contamination source and improve water quality',
  },

  // ========================================
  // WASTE TRIGGERS (2 conditions)
  // ========================================
  {
    id: 'trigger-waste-bin-overflow',
    name: 'Waste Bin Overflow',
    description: 'Multiple waste bins at capacity',
    conditionType: 'device-state',
    triggerParameter: 'bins_full_count',
    triggerOperator: '>',
    triggerValue: 5,  // more than 5 bins full
    agentCapability: 'monitor-waste',
    priority: 'medium',
    requiredCollaborators: ['waste-manager', 'transportation-coordinator'],
    collaborationGoal: 'Optimize collection routes and schedule pickup',
  },
];

// ============================================================================
// Autonomous AC Manager
// ============================================================================

export class AutonomousACManager {
  private triggers: ACTriggerCondition[];
  private collaborationManager: CollaborationManager;
  private acExecutor: ACExecutor;
  private environment: EnvironmentCenter;
  private activeACs: Map<string, ACCollaborationConfig>;

  constructor(environment: EnvironmentCenter) {
    this.environment = environment;
    this.triggers = SMART_CITY_AC_TRIGGERS;
    this.collaborationManager = new CollaborationManager();
    this.acExecutor = new ACExecutor();
    this.activeACs = new Map();

    logger.info('Initialized with triggers:', this.triggers.length);

    // Start continuous monitoring
    this.startContinuousMonitoring();
  }

  /**
   * Start continuous monitoring of environment
   * Agents will AUTOMATICALLY create ACs when triggers are detected
   */
  private startContinuousMonitoring(): void {
    logger.info('Starting continuous AC trigger monitoring...');

    // Monitor environment every 5 seconds
    setInterval(async () => {
      await this.evaluateAllTriggers();
    }, 5000);

    // Also subscribe to environment events
    this.environment.eventManager.subscribe({
      subscriberId: 'autonomous-ac-manager',
      eventType: EventType.DEVICE_STATE_CHANGE,
      handler: async () => {
        await this.evaluateAllTriggers();
      },
      priority: EventPriority.HIGH,
    });

    this.environment.eventManager.subscribe({
      subscriberId: 'autonomous-ac-manager',
      eventType: EventType.ENVIRONMENT_PARAM_CHANGED,
      handler: async () => {
        await this.evaluateAllTriggers();
      },
      priority: EventPriority.HIGH,
    });
  }

  /**
   * Evaluate all trigger conditions
   * Check if any condition is met and should trigger AC creation
   */
  private async evaluateAllTriggers(): Promise<void> {
    for (const trigger of this.triggers) {
      const shouldTrigger = await this.evaluateTrigger(trigger);

      if (shouldTrigger) {
        logger.info(`\n[AutonomousACManager] TRIGGER DETECTED: ${trigger.name}`);
        await this.handleTriggeredAC(trigger);
      }
    }
  }

  /**
   * Evaluate a single trigger condition
   */
  private async evaluateTrigger(trigger: ACTriggerCondition): Promise<boolean> {
    try {
      switch (trigger.conditionType) {
        case 'environment-parameter':
          return await this.evaluateEnvironmentTrigger(trigger);

        case 'device-state':
          return await this.evaluateDeviceStateTrigger(trigger);

        default:
          return false;
      }
    } catch (error) {
      logger.error(`Error evaluating trigger ${trigger.id}:`, error);
      return false;
    }
  }

  /**
   * Evaluate environment parameter trigger
   */
  private async evaluateEnvironmentTrigger(trigger: ACTriggerCondition): Promise<boolean> {
    // Get current environment parameter value
    const physicsEngine = this.environment.getPhysicsEngine?.() as Record<string, unknown> | undefined;
    if (!physicsEngine || typeof physicsEngine.getAllParameters !== 'function') {
      return false;
    }

    const allParams = (physicsEngine.getAllParameters as () => Record<string, unknown>)();
    const currentValue = allParams[trigger.triggerParameter!];

    if (currentValue === undefined || currentValue === null) {
      return false;
    }

    const triggerValue = trigger.triggerValue;
    if (triggerValue === undefined) {
      return false;
    }

    // Convert to numeric value for comparison
    const numericValue = typeof currentValue === 'boolean' ? (currentValue ? 1 : 0) : Number(currentValue);
    const numericTriggerValue = typeof triggerValue === 'boolean' ? (triggerValue ? 1 : 0) : Number(triggerValue);

    // Evaluate condition
    switch (trigger.triggerOperator) {
      case '>':
        return numericValue > numericTriggerValue;
      case '<':
        return numericValue < numericTriggerValue;
      case '>=':
        return numericValue >= numericTriggerValue;
      case '<=':
        return numericValue <= numericTriggerValue;
      case '==':
        return numericValue == numericTriggerValue;
      case '!=':
        return numericValue != numericTriggerValue;
      default:
        return false;
    }
  }

  /**
   * Evaluate device state trigger
   */
  private async evaluateDeviceStateTrigger(trigger: ACTriggerCondition): Promise<boolean> {
    // Check device states for trigger condition
    const devices = this.environment.listDevices();

    const triggerValue = trigger.triggerValue;
    if (triggerValue === undefined) {
      return false;
    }

    // Convert trigger value to number for comparison
    const numericTriggerValue = typeof triggerValue === 'boolean' ? (triggerValue ? 1 : 0) : Number(triggerValue);

    for (const device of devices) {
      const deviceState = (device as unknown as Record<string, unknown>).state as Record<string, unknown> | undefined;
      if (!deviceState) {
        continue;
      }

      const currentValue = deviceState[trigger.triggerParameter!];
      if (currentValue === undefined || currentValue === null) {
        continue;
      }

      // Convert to numeric value for comparison
      const numericValue = typeof currentValue === 'boolean' ? (currentValue ? 1 : 0) : Number(currentValue);

      switch (trigger.triggerOperator) {
        case '>':
          if (numericValue > numericTriggerValue) return true;
          break;
        case '<':
          if (numericValue < numericTriggerValue) return true;
          break;
        case '>=':
          if (numericValue >= numericTriggerValue) return true;
          break;
        case '<=':
          if (numericValue <= numericTriggerValue) return true;
          break;
        case '==':
          if (numericValue == numericTriggerValue) return true;
          break;
        case '!=':
          if (numericValue != numericTriggerValue) return true;
          break;
      }
    }

    return false;
  }

  /**
   * Handle triggered AC
   * AUTOMATICALLY create and execute AC when trigger is detected
   */
  private async handleTriggeredAC(trigger: ACTriggerCondition): Promise<void> {
    try {
      // Find agent that detected this trigger
      const detectingAgent = await this.findAgentWithCapability(trigger.agentCapability);

      if (!detectingAgent) {
        logger.warn(`No agent found with capability: ${trigger.agentCapability}`);
        return;
      }

      logger.info(`Agent ${detectingAgent.name} detected trigger`);
      logger.info(`Priority: ${trigger.priority}`);
      logger.info(`Required collaborators:`, trigger.requiredCollaborators);

      // AUTOMATICALLY create AC
      const acConfig = await this.createACFromTrigger(trigger, detectingAgent);

      if (!acConfig) {
        logger.warn(`Failed to create AC from trigger`);
        return;
      }

      // AUTOMATICALLY execute AC
      logger.info(`*** AUTO-EXECUTING AC: ${acConfig.name} ***`);
      const result = await this.acExecutor.executeCollaboration(acConfig, {
        maxDuration: trigger.priority === 'urgent' ? 300000 : 600000,
        verboseLogging: true,
      });

      // Log result
      logger.info(`\n[AutonomousACManager] AC Execution Result:`);
      logger.info(`  Success: ${result.success}`);
      logger.info(`  Device Operations: ${result.deviceOperations.length}`);
      logger.info(`  Environment Effects: ${result.environmentEffects.length}`);
      logger.info(`  Agent Communications: ${result.agentCommunications.length}`);

    } catch (error) {
      logger.error(`Error handling triggered AC:`, error);
    }
  }

  /**
   * Find agent with specific capability
   */
  private async findAgentWithCapability(capability: string): Promise<CognitiveAgent | null> {
    const agents = this.environment.listAgents();

    for (const agent of agents) {
      if (agent.capabilities && agent.capabilities.some(c => c.toString() === capability)) {
        return agent as unknown as CognitiveAgent;
      }
    }

    return null;
  }

  /**
   * Create AC configuration from trigger
   * AUTOMATICALLY generates AC config based on trigger conditions
   */
  private async createACFromTrigger(
    trigger: ACTriggerCondition,
    detectingAgent: CognitiveAgent
  ): Promise<ACCollaborationConfig | null> {
    try {
      const acId = uuidv4();

      // Find collaborating agents
      const collaborators: CognitiveAgent[] = [];
      for (const agentType of trigger.requiredCollaborators) {
        const agent = await this.findAgentByType(agentType);
        if (agent) {
          collaborators.push(agent);
        }
      }

      if (collaborators.length === 0) {
        logger.warn(`No collaborators found for ${trigger.name}`);
        return null;
      }

      const participantAgentIds = [detectingAgent.id, ...collaborators.map((a) => a.id)];

      // AUTOMATICALLY generate goals based on trigger
      const goals = await this.generateGoalsFromTrigger(trigger, detectingAgent, collaborators);

      const acConfig: ACCollaborationConfig = {
        id: acId,
        name: `[AUTO] ${trigger.name}`,
        description: trigger.description,
        environment: this.environment,
        participantAgentIds,
        collaborationManager: this.collaborationManager,
        goals,
        maxDuration: trigger.priority === 'urgent' ? 300000 : 600000,
      };

      logger.info(`Auto-created AC: ${acConfig.name}`);
      logger.info(`  Participants: ${participantAgentIds.length} agents`);
      logger.info(`  Goals: ${goals.length}`);

      return acConfig;

    } catch (error) {
      logger.error(`Error creating AC from trigger:`, error);
      return null;
    }
  }

  /**
   * Find agent by type/role
   */
  private async findAgentByType(agentType: string): Promise<CognitiveAgent | null> {
    const agents = this.environment.listAgents();

    for (const agent of agents) {
      // Check agent name or metadata for type
      if ((agent as unknown as Record<string, unknown>).type === agentType || ((agent as unknown as Record<string, Record<string, unknown>>).metadata as Record<string, unknown> | undefined)?.role === agentType) {
        return agent as unknown as CognitiveAgent;
      }
      // Check agent name includes type
      if (agent.name.toLowerCase().includes(agentType.toLowerCase())) {
        return agent as unknown as CognitiveAgent;
      }
    }

    return null;
  }

  /**
   * AUTOMATICALLY generate goals from trigger
   * Creates appropriate goals based on trigger conditions
   */
  private async generateGoalsFromTrigger(
    trigger: ACTriggerCondition,
    detectingAgent: CognitiveAgent,
    collaborators: CognitiveAgent[]
  ): Promise<ACCollaborationGoal[]> {
    const goals: ACCollaborationGoal[] = [];

    // Goal 1: Address the trigger condition
    goals.push({
      id: `goal-address-${trigger.id}`,
      description: `Address trigger: ${trigger.name}`,
      targetDevices: [],  // Will be populated based on trigger
      targetAgents: [detectingAgent.id],
      requiredCapabilities: [trigger.agentCapability],
      successCriteria: [
        {
          type: 'environment-parameter',
          target: trigger.triggerParameter || 'unknown',
          condition: `improved == true`,
          operator: '==',
        },
      ],
      priority: trigger.priority,
    });

    // Goal 2: Coordinate with collaborators
    for (const collaborator of collaborators) {
      goals.push({
        id: `goal-coordinate-${collaborator.id}`,
        description: `Coordinate response with ${collaborator.name}`,
        targetDevices: [],
        targetAgents: [collaborator.id],
        requiredCapabilities: collaborator.capabilities || [],
        successCriteria: [
          {
            type: 'task-completion',
            target: 'coordination',
            condition: `completed == true`,
            operator: '==',
          },
        ],
        priority: trigger.priority,
      });
    }

    return goals;
  }

  /**
   * Get all active ACs
   */
  getActiveACs(): ACCollaborationConfig[] {
    return Array.from(this.activeACs.values());
  }

  /**
   * Get AC execution history
   */
  getACHEXecutionHistory() {
    return this.acExecutor.getExecutionHistory();
  }
}

// ============================================================================
// Export
// ============================================================================

export { SMART_CITY_AC_TRIGGERS as AUTO_AC_TRIGGERS };
