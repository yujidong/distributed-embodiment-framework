/**
 * Goal Formulation Engine - Layer 2 Cognitive Decision
 *
 * Creates well-defined collaboration goals from:
 * 1. AC Necessity Assessment
 * 2. Partner Selection results
 * 3. Collaboration Proposal
 *
 * Goals include:
 * - Clear objective statements
 * - Success criteria
 * - Required resources
 * - Time constraints
 * - Priority classification
 */

import { v4 as uuidv4 } from 'uuid';
import type { ACNecessityAssessment } from './ACNecessityAssessor.js';
import type { PartnerSelectionResult, CollaborationProposal } from './PartnerSelectionNegotiator.js';
import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Collaboration goal definition
 */
const logger = createLogger('GoalFormulationEngine');

export interface ACCollaborationGoal {
  id: string;
  name: string;
  description: string;

  // What needs to be achieved
  objective: string;
  successCriteria: ACCSuccessCriterion[];

  // Who is involved
  targetAgents: string[];
  targetDevices: string[];
  requiredCapabilities: string[];

  // Task parameters from original event/goal
  parameters?: Record<string, any>;

  // Constraints
  priority: 'low' | 'medium' | 'high' | 'urgent';
  maxDuration: number; // milliseconds
  timeout: number; // milliseconds per task

  // Dependencies
  dependsOn: string[]; // Other goal IDs
  blocks: string[]; // Goals that depend on this one

  // Status
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: number; // 0-100
}

/**
 * Success criterion for a goal
 */
export interface ACCSuccessCriterion {
  id: string;
  type: 'device_state' | 'environment_parameter' | 'task_completion' | 'time_bound' | 'metric_threshold';
  target: string; // Device ID, parameter name, or metric
  condition: string; // Comparison or state description
  threshold?: number;
  operator?: '>' | '<' | '>=' | '<=' | '==' | '!=';
  deadline?: Date;
}

/**
 * Resource requirement for goals
 */
export interface ResourceRequirement {
  type: 'device' | 'agent' | 'service' | 'external';
  id: string;
  capability: string;
  required: boolean;
  estimatedUsage: number; // Percentage of resource capacity
}

/**
 * Complete AC configuration
 */
export interface ACCollaborationConfig {
  id: string;
  name: string;
  description: string;

  // Goals
  goals: ACCollaborationGoal[];

  // Participants
  initiatorId: string;
  participantAgentIds: string[];
  requiredResources: ResourceRequirement[];

  // Context
  triggerCluster: SpatialClusterSummary;
  assessment: ACNecessityAssessment;
  proposal: CollaborationProposal;

  // Constraints
  maxDuration: number;
  timeout: number;
  priority: 'low' | 'medium' | 'high' | 'urgent';

  // Environment
  environment?: EnvironmentCenter;
}

/**
 * Goal formulation result
 */
export interface GoalFormulationResult {
  config: ACCollaborationConfig;
  primaryGoal: ACCollaborationGoal;
  subGoals: ACCollaborationGoal[];
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  estimatedDuration: number;
  risks: string[];
}

/**
 * Configuration for GoalFormulationEngine
 */
export interface GoalEngineConfig {
  // Goal settings
  defaultTimeout: number;
  maxGoalsPerAC: number;
  maxGoalDepth: number; // Max dependency chain length

  // Time estimation
  baseTaskDuration: number; // milliseconds
  communicationOverhead: number; // percentage

  // Complexity thresholds
  simpleThreshold: number; // Number of devices/agents
  complexThreshold: number;
}

const DEFAULT_CONFIG: GoalEngineConfig = {
  defaultTimeout: 30000,
  maxGoalsPerAC: 10,
  maxGoalDepth: 3,

  baseTaskDuration: 5000,
  communicationOverhead: 0.2,

  simpleThreshold: 3,
  complexThreshold: 7,
};

// ============================================================================
// GoalFormulationEngine
// ============================================================================

export class GoalFormulationEngine {
  private config: GoalEngineConfig;
  private environmentCenter: EnvironmentCenter | null = null;
  private llmClient: any;

  // Statistics
  private stats = {
    totalFormulations: 0,
    goalsCreated: 0,
    simpleGoals: 0,
    moderateGoals: 0,
    complexGoals: 0,
  };

  constructor(
    config: Partial<GoalEngineConfig> = {},
    environmentCenter?: EnvironmentCenter,
    llmClient?: any
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.environmentCenter = environmentCenter || null;
    this.llmClient = llmClient;

    logger.info('Initialized');
  }

  /**
   * Formulate goals from assessment and partner selection
   */
  async formulateGoals(
    assessment: ACNecessityAssessment,
    partnerSelection: PartnerSelectionResult,
    environment?: EnvironmentCenter
  ): Promise<GoalFormulationResult> {
    this.stats.totalFormulations++;

    // Create AC configuration ID
    const acId = uuidv4();

    const envToUse = environment || this.environmentCenter || undefined;

    // Formulate primary goal
    const primaryGoal = await this.formulatePrimaryGoal(
      assessment,
      partnerSelection,
      acId,
      envToUse
    );

    // Formulate sub-goals if needed
    const subGoals = await this.formulateSubGoals(
      assessment,
      partnerSelection,
      primaryGoal,
      acId
    );

    // Create full configuration
    // IMPORTANT: Include initiator in participantAgentIds so they can execute tasks
    // even when no partners are available (single-agent mode)
    const config: ACCollaborationConfig = {
      id: acId,
      name: this.generateACName(assessment, partnerSelection),
      description: assessment.llmAssessment.reasoning,
      goals: [primaryGoal, ...subGoals],
      initiatorId: assessment.agentContext.agentId,
      participantAgentIds: [
        assessment.agentContext.agentId, // Always include initiator
        ...partnerSelection.selectedPartners.map(p => p.agentId),
      ],
      requiredResources: this.identifyResources(assessment, partnerSelection, envToUse),
      triggerCluster: assessment.clusterSummary,
      assessment,
      proposal: partnerSelection.proposal,
      maxDuration: assessment.llmAssessment.estimatedDuration || 120000,
      timeout: this.config.defaultTimeout,
      priority: assessment.llmAssessment.urgency,
      environment: envToUse,
    };

    // Update statistics
    this.stats.goalsCreated += config.goals.length;

    // Estimate complexity
    const complexity = this.estimateComplexity(config);
    switch (complexity) {
      case 'simple':
        this.stats.simpleGoals++;
        break;
      case 'moderate':
        this.stats.moderateGoals++;
        break;
      case 'complex':
        this.stats.complexGoals++;
        break;
    }

    return {
      config,
      primaryGoal,
      subGoals,
      estimatedComplexity: complexity,
      estimatedDuration: this.estimateDuration(config),
      risks: this.identifyRisks(config, assessment),
    };
  }

  /**
   * Formulate primary goal
   */
  private async formulatePrimaryGoal(
    assessment: ACNecessityAssessment,
    partnerSelection: PartnerSelectionResult,
    acId: string,
    environment?: EnvironmentCenter
  ): Promise<ACCollaborationGoal> {
    // Generate goal name and description
    const goalName = this.generateGoalName(assessment);
    const objective = this.generateObjective(assessment);
    const successCriteria = this.generateSuccessCriteria(assessment);

    return {
      id: `goal-${acId}-primary`,
      name: goalName,
      description: assessment.llmAssessment.reasoning,
      objective,
      successCriteria,
      targetAgents: [
        assessment.agentContext.agentId,
        ...partnerSelection.selectedPartners.map(p => p.agentId),
      ],
      targetDevices: this.identifyTargetDevices(assessment, environment),
      requiredCapabilities: assessment.llmAssessment.requiredCapabilities,
      // NEW: Pass through task parameters from assessment
      parameters: assessment.taskParameters,
      priority: assessment.llmAssessment.urgency,
      maxDuration: assessment.llmAssessment.estimatedDuration || 120000,
      timeout: this.config.defaultTimeout,
      dependsOn: [],
      blocks: [],
      status: 'pending',
      progress: 0,
    };
  }

  /**
   * Formulate sub-goals for complex collaborations
   */
  private async formulateSubGoals(
    assessment: ACNecessityAssessment,
    partnerSelection: PartnerSelectionResult,
    primaryGoal: ACCollaborationGoal,
    acId: string
  ): Promise<ACCollaborationGoal[]> {
    const subGoals: ACCollaborationGoal[] = [];

    // Create sub-goals based on required capabilities
    const capabilities = assessment.llmAssessment.requiredCapabilities;

    // Group partners by capability
    for (let i = 0; i < Math.min(capabilities.length, this.config.maxGoalsPerAC - 1); i++) {
      const capability = capabilities[i];
      const relevantPartners = partnerSelection.selectedPartners.filter(
        p => p.capabilities.some(cap => cap.toLowerCase().includes(capability.toLowerCase()))
      );

      if (relevantPartners.length === 0) continue;

      const subGoal: ACCollaborationGoal = {
        id: `goal-${acId}-sub-${i}`,
        name: `${capability} Task`,
        description: `Execute ${capability} related tasks`,
        objective: `Complete ${capability} operations as part of ${primaryGoal.name}`,
        successCriteria: [
          {
            id: `criterion-${acId}-sub-${i}-1`,
            type: 'task_completion',
            target: capability,
            condition: 'completed',
          },
        ],
        targetAgents: relevantPartners.map(p => p.agentId),
        targetDevices: [],
        requiredCapabilities: [capability],
        priority: assessment.llmAssessment.urgency,
        maxDuration: primaryGoal.maxDuration / 2,
        timeout: this.config.defaultTimeout,
        dependsOn: [],
        blocks: [primaryGoal.id],
        status: 'pending',
        progress: 0,
      };

      subGoals.push(subGoal);
    }

    // Set up dependencies
    for (const subGoal of subGoals) {
      subGoal.dependsOn = subGoals
        .filter(sg => sg.id !== subGoal.id)
        .map(sg => sg.id);
    }

    return subGoals;
  }

  /**
   * Generate goal name
   */
  private generateGoalName(assessment: ACNecessityAssessment): string {
    const findings = assessment.clusterSummary.findings;
    const mainFinding = findings[0];

    if (mainFinding) {
      if (mainFinding.anomaly) {
        return `Resolve ${mainFinding.eventType} Anomaly`;
      }
      if (mainFinding.trend === 'increasing') {
        return `Mitigate ${mainFinding.eventType} Increase`;
      }
      if (mainFinding.trend === 'decreasing') {
        return `Address ${mainFinding.eventType} Decrease`;
      }
    }

    return 'Respond to Detected Events';
  }

  /**
   * Generate objective statement
   */
  private generateObjective(assessment: ACNecessityAssessment): string {
    const summary = assessment.clusterSummary.summary;
    const reasoning = assessment.llmAssessment.reasoning;

    // Combine summary and reasoning into clear objective
    return `${reasoning}. Target: ${summary.split('.')[0]}.`;
  }

  /**
   * Generate success criteria
   */
  private generateSuccessCriteria(assessment: ACNecessityAssessment): ACCSuccessCriterion[] {
    const criteria: ACCSuccessCriterion[] = [];
    const acId = uuidv4();

    // Add environment parameter criteria if applicable
    const findings = assessment.clusterSummary.findings;
    for (const finding of findings) {
      if (finding.anomaly) {
        // Try to generate a concrete numeric success criterion from the finding details
        const details = finding.details;
        if (details) {
          // Check for common parameter patterns in the event details
          const parameterMappings: Array<{
            key: string;
            parameter: string;
            normalValue: number;
            tolerance: number;
            operator: '<' | '>' | '<=' | '>=';
          }> = [
            { key: 'temperature', parameter: 'temperature', normalValue: 24, tolerance: 2, operator: '<=' },
            { key: 'humidity', parameter: 'humidity', normalValue: 55, tolerance: 5, operator: '<=' },
            { key: 'co2', parameter: 'co2', normalValue: 800, tolerance: 100, operator: '<=' },
            { key: 'light', parameter: 'light', normalValue: 500, tolerance: 50, operator: '<=' },
          ];

          let concreteCriterionAdded = false;
          for (const mapping of parameterMappings) {
            // Check if this mapping's parameter matches the event's parameter
            const paramMatch = details.parameter === mapping.parameter
              || details.parameter === mapping.key
              || details.eventType?.includes(mapping.key);
            const value = details[mapping.key] ?? details.newValue ?? details.value;

            if (paramMatch || typeof value === 'number') {
              criteria.push({
                id: `criterion-${acId}-env-${criteria.length}`,
                type: 'environment_parameter',
                target: mapping.parameter,
                condition: `${mapping.parameter} ${mapping.operator} ${mapping.normalValue}`,
                threshold: mapping.normalValue,
                operator: mapping.operator,
              });
              concreteCriterionAdded = true;
              break;
            }
          }

          if (!concreteCriterionAdded) {
            // Fallback: generic criterion without numeric target
            criteria.push({
              id: `criterion-${acId}-env-${criteria.length}`,
              type: 'environment_parameter',
              target: finding.eventType,
              condition: 'normalized',
            });
          }
        } else {
          criteria.push({
            id: `criterion-${acId}-env-${criteria.length}`,
            type: 'environment_parameter',
            target: finding.eventType,
            condition: 'normalized',
          });
        }
      }
    }

    // Add task completion criterion
    criteria.push({
      id: `criterion-${acId}-task`,
      type: 'task_completion',
      target: 'collaboration',
      condition: 'completed',
    });

    // Add time-bound criterion based on urgency
    if (assessment.llmAssessment.urgency === 'urgent') {
      criteria.push({
        id: `criterion-${acId}-time`,
        type: 'time_bound',
        target: 'response',
        condition: 'within_deadline',
        deadline: new Date(Date.now() + 30000), // 30 seconds
      });
    }

    return criteria;
  }

  /**
   * Identify target devices from assessment and environment
   */
  private identifyTargetDevices(
    assessment: ACNecessityAssessment,
    environment?: EnvironmentCenter,
  ): string[] {
    const devices: string[] = [];

    // Primary source: Add devices from agent context (initiator's devices)
    for (const resource of assessment.agentContext.availableResources) {
      if (resource.deviceId) {
        devices.push(resource.deviceId);
        logger.info(`Found device from agent context: ${resource.deviceId}`);
      }
    }

    // Secondary source: Query EnvironmentCenter for devices matching
    // required capabilities in the affected zone. This discovers partner
    // devices (e.g., HVAC actuators) that the initiator doesn't own.
    if (environment) {
      const requiredCapabilities = assessment.llmAssessment.requiredCapabilities ?? [];

      // Get zone ID from cluster region (region.id is the zoneId)
      const zoneId = assessment.clusterSummary.region.id;

      const allDevices = environment.listDevices();
      for (const device of allDevices) {
        // Check if device is in the affected zone
        const deviceZone = (device as any).location ?? (device as any).zoneId;
        if (zoneId !== 'unknown' && deviceZone && deviceZone !== zoneId) continue;

        // Check if device has any matching capability
        const deviceCapabilities = device.capabilities?.map(c =>
          typeof c === 'string' ? c : c.name
        ) ?? [];
        const hasMatch = requiredCapabilities.some(req =>
          deviceCapabilities.some((dc: string) =>
            dc.toLowerCase().includes(req.toLowerCase()) ||
            req.toLowerCase().includes(dc.toLowerCase())
          )
        );
        if (hasMatch) {
          devices.push(device.id);
          logger.info(`Found device from environment query: ${device.id} (${device.name})`);
        }
      }
    }

    // Tertiary source: Extract device IDs from cluster summary using UUID patterns
    const summary = assessment.clusterSummary.summary;
    const deviceMatches = summary.matchAll(/device[:\s]+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi);
    for (const match of deviceMatches) {
      if (match[1]) {
        devices.push(match[1]);
        logger.info(`Found device from summary (UUID pattern): ${match[1]}`);
      }
    }

    const deviceIdMatches = summary.matchAll(/deviceId[:\s]*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi);
    for (const match of deviceIdMatches) {
      if (match[1]) {
        devices.push(match[1]);
        logger.info(`Found device from summary (deviceId pattern): ${match[1]}`);
      }
    }

    const uniqueDevices = [...new Set(devices)];
    logger.info(`Total unique target devices identified: ${uniqueDevices.length}`);
    return uniqueDevices;
  }

  /**
   * Identify required resources
   */
  private identifyResources(
    assessment: ACNecessityAssessment,
    partnerSelection: PartnerSelectionResult,
    environment?: EnvironmentCenter
  ): ResourceRequirement[] {
    const resources: ResourceRequirement[] = [];

    // Add agent resources
    for (const partner of partnerSelection.selectedPartners) {
      resources.push({
        type: 'agent',
        id: partner.agentId,
        capability: partner.capabilities[0] || 'general',
        required: true,
        estimatedUsage: 50,
      });
    }

    // Add device resources
    for (const device of this.identifyTargetDevices(assessment, environment)) {
      resources.push({
        type: 'device',
        id: device,
        capability: 'actuation',
        required: false,
        estimatedUsage: 30,
      });
    }

    return resources;
  }

  /**
   * Generate AC name
   */
  private generateACName(
    assessment: ACNecessityAssessment,
    partnerSelection: PartnerSelectionResult
  ): string {
    const capability = assessment.llmAssessment.requiredCapabilities[0] || 'General';
    const urgency = assessment.llmAssessment.urgency;

    return `${urgency.toUpperCase()}_${capability}_Collaboration_${Date.now()}`;
  }

  /**
   * Estimate complexity of collaboration
   */
  private estimateComplexity(config: ACCollaborationConfig): 'simple' | 'moderate' | 'complex' {
    const totalParticipants = config.participantAgentIds.length + config.requiredResources.length;
    const goalCount = config.goals.length;

    const score = totalParticipants + goalCount;

    if (score <= this.config.simpleThreshold) return 'simple';
    if (score <= this.config.complexThreshold) return 'moderate';
    return 'complex';
  }

  /**
   * Estimate duration of collaboration
   */
  private estimateDuration(config: ACCollaborationConfig): number {
    const baseDuration = config.goals.length * this.config.baseTaskDuration;
    const participantOverhead = config.participantAgentIds.length * 1000;
    const communicationOverhead = baseDuration * this.config.communicationOverhead;

    return Math.round(baseDuration + participantOverhead + communicationOverhead);
  }

  /**
   * Identify risks in collaboration
   */
  private identifyRisks(
    config: ACCollaborationConfig,
    assessment: ACNecessityAssessment
  ): string[] {
    const risks: string[] = [];

    // Participant availability risk
    if (config.participantAgentIds.length < 2) {
      risks.push('Low participant count may limit collaboration effectiveness');
    }

    // Capability coverage risk
    const requiredCaps = new Set(assessment.llmAssessment.requiredCapabilities);
    const availableCaps = new Set(
      config.requiredResources.map(r => r.capability)
    );
    for (const cap of requiredCaps) {
      let covered = false;
      for (const avail of availableCaps) {
        if (avail.toLowerCase().includes(cap.toLowerCase())) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        risks.push(`Required capability '${cap}' may not be fully covered`);
      }
    }

    // Time constraint risk
    if (assessment.llmAssessment.urgency === 'urgent') {
      risks.push('Urgent priority may lead to rushed decisions');
    }

    // Complexity risk
    if (config.goals.length > 5) {
      risks.push('High goal count may complicate coordination');
    }

    // LLM confidence risk
    if (assessment.llmAssessment.confidence < 0.7) {
      risks.push('Low LLM confidence in collaboration necessity');
    }

    return risks;
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }
}

export default GoalFormulationEngine;
