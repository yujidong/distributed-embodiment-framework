/**
 * AutonomousDecisionEngine
 *
 * Enables agents to autonomously evaluate situations and decide
 * when collaboration is needed without requiring pre-configured workflows.
 *
 * This engine uses a hybrid approach:
 * 1. Structured rules for fast, pattern-based decisions
 * 2. LLM reasoning for complex, novel situations
 */

import type { LLMClient } from '@active-collaboration/llm-integration';
import type { SystemEvent } from '@active-collaboration/shared';
import type {
  SituationAssessment,
  DecisionResult,
  DecisionEngineConfig,
  EventPattern,
  EventAnalysis,
  CapabilityAssessment,
  ServiceRequirement,
  CollaborationPartner,
} from '../types/decision.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Default configuration for decision engine
 */
const DEFAULT_CONFIG: DecisionEngineConfig = {
  enabled: true,
  confidenceThreshold: 0.7,
  maxLLMReasoningTime: 5000, // 5 seconds
  useStructuredRules: true,
  maxPartners: 3,
  costSensitivity: 0.5,
  qualitySensitivity: 0.8,
  // Cost control: LLM is only called through explicit tasks by default
  enableAutoLLMProcessing: false,
};

/**
 * Predefined event patterns for structured decision rules
 * These patterns cover common IoT scenarios
 *
 * NOTE: Event patterns use EventType enum values. The specific event type
 * (e.g., 'temperature-alert') is conveyed via the payload's eventType field.
 */
const EVENT_PATTERNS: EventPattern[] = [
  {
    eventType: 'device.state_change',
    requiredFields: ['deviceId', 'stateChange'],
    fieldValues: {
      'stateChange.property': 'temperature',
    },
    severity: 'high',
    urgency: 0.9,
    typicallyRequiresCollaboration: true,
    requiredCapabilities: ['temperature-control', 'hvac-control'],
    reasoning: 'High temperature detected, requires HVAC control capability for temperature regulation',
  },
  {
    eventType: 'device.state_change',
    requiredFields: ['deviceId', 'stateChange'],
    severity: 'high',
    urgency: 0.8,
    typicallyRequiresCollaboration: true,
    requiredCapabilities: ['temperature-control', 'hvac-control'],
    reasoning: 'Device state changes may require coordination with control systems',
  },
  {
    eventType: 'environment.param_changed', // EventType.ENVIRONMENT_PARAM_CHANGED
    requiredFields: ['parameter', 'value'],
    typicallyRequiresCollaboration: false,
    reasoning: 'Environment parameter changes are informational, may not require collaboration',
  },
];

const logger = createLogger('AutonomousDecisionEngine');

export class AutonomousDecisionEngine {
  private config: DecisionEngineConfig;
  private llmClient: LLMClient;
  private environment: EnvironmentCenter;
  private agentId: string;
  private agentName: string;
  private agentCapabilities: string[];
  private patterns: EventPattern[];

  constructor(config: {
    llmClient: LLMClient;
    environment: EnvironmentCenter;
    agentId: string;
    agentName: string;
    agentCapabilities: string[];
    config?: Partial<DecisionEngineConfig>;
    patterns?: EventPattern[];
  }) {
    this.llmClient = config.llmClient;
    this.environment = config.environment;
    this.agentId = config.agentId;
    this.agentName = config.agentName;
    this.agentCapabilities = config.agentCapabilities;
    this.config = { ...DEFAULT_CONFIG, ...config.config };
    this.patterns = config.patterns || EVENT_PATTERNS;

    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Initialized with config:`, {
      enabled: this.config.enabled,
      confidenceThreshold: this.config.confidenceThreshold,
    });
  }

  /**
   * Main entry point: Evaluate a situation and make a decision
   *
   * This is the key method that enables autonomous collaboration.
   * It assesses the situation and decides whether collaboration is needed.
   */
  async evaluateSituation(event: SystemEvent): Promise<SituationAssessment> {
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Evaluating situation for event: ${event.type}`);

    const startTime = Date.now();

    // Step 1: Analyze the event
    const eventAnalysis = await this.analyzeEvent(event);

    // Step 2: Assess own capabilities
    const capabilityAssessment = await this.assessOwnCapabilities(eventAnalysis);

    // Step 3: Determine if collaboration is needed
    const needsCollaboration = this.decideCollaborationNeeded(
      eventAnalysis,
      capabilityAssessment
    );

    // Step 4: Identify required services if collaboration is needed
    const requiredServices = needsCollaboration
      ? await this.identifyRequiredServices(eventAnalysis, capabilityAssessment)
      : [];

    // Step 5: Calculate confidence
    const confidence = this.calculateConfidence(
      eventAnalysis,
      capabilityAssessment,
      requiredServices
    );

    // Step 6: Generate reasoning
    const reasoning = this.generateReasoning(
      eventAnalysis,
      capabilityAssessment,
      needsCollaboration,
      requiredServices
    );

    const assessment: SituationAssessment = {
      event,
      eventAnalysis,
      ownCapabilities: capabilityAssessment,
      needsCollaboration,
      requiredServices,
      confidence,
      reasoning,
    };

    const duration = Date.now() - startTime;
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Situation assessment complete:`, {
      needsCollaboration,
      requiredServices: requiredServices.length,
      confidence: confidence.toFixed(2),
      duration: `${duration}ms`,
    });

    return assessment;
  }

  /**
   * Make a final decision based on situation assessment
   */
  async makeDecision(assessment: SituationAssessment): Promise<DecisionResult> {
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Making decision...`);

    const decision: DecisionResult = {
      decision: assessment.needsCollaboration ? 'collaborate' : 'handle_independently',
      assessment,
      reasoning: assessment.reasoning,
      confidence: assessment.confidence,
      nextActions: [],
    };

    // If collaboration is needed, find partners
    if (assessment.needsCollaboration && assessment.requiredServices.length > 0) {
      const partners = await this.selectCollaborationPartners(assessment.requiredServices);

      if (partners.length > 0) {
        decision.decision = 'collaborate';
        decision.selectedPartners = partners;
        decision.nextActions = partners.map(p => `Send collaboration proposal to ${p.agentId}`);
      } else {
        // No partners found, might need to defer or ignore
        decision.decision = 'defer';
        decision.nextActions = ['Publish requirement to marketplace', 'Wait for service providers'];
      }
    } else if (!assessment.needsCollaboration) {
      decision.nextActions = ['Handle event independently using own capabilities'];
    }

    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Decision:`, {
      decision: decision.decision,
      partners: decision.selectedPartners?.length || 0,
      nextActions: decision.nextActions,
    });

    return decision;
  }

  /**
   * Analyze an event to understand its meaning
   */
  private async analyzeEvent(event: SystemEvent): Promise<EventAnalysis> {
    // First, try to match against known patterns
    const matchedPattern = this.patterns.find(p =>
      this.matchEventPattern(event, p)
    );

    if (matchedPattern) {
      logger.info(`[AutonomousDecisionEngine:${this.agentId}] Event matched pattern: ${matchedPattern.eventType}`);

      return {
        eventType: event.type,
        severity: matchedPattern.severity || 'medium',
        urgency: matchedPattern.urgency || 0.5,
        requirements: matchedPattern.requiredCapabilities || [],
        context: event.payload || {},
        potentialImpact: matchedPattern.reasoning || 'Unknown',
      };
    }

    // Cost control: Skip automatic LLM processing if disabled
    // LLM should only be called through explicit task requests
    if (!this.config.enableAutoLLMProcessing) {
      logger.info(`[AutonomousDecisionEngine:${this.agentId}] No pattern match, but auto LLM processing is disabled. Using default analysis.`);
      return {
        eventType: event.type,
        severity: 'medium',
        urgency: 0.5,
        requirements: [],
        context: event.payload || {},
        potentialImpact: 'Event type not recognized (LLM auto-processing disabled)',
      };
    }

    // If no pattern match and LLM enabled, use LLM to analyze
    if (this.config.useStructuredRules) {
      return this.analyzeEventWithLLM(event);
    }

    // Default analysis
    return {
      eventType: event.type,
      severity: 'medium',
      urgency: 0.5,
      requirements: [],
      context: event.payload || {},
      potentialImpact: 'Event type not recognized',
    };
  }

  /**
   * Use LLM to analyze an event
   */
  private async analyzeEventWithLLM(event: SystemEvent): Promise<EventAnalysis> {
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Using LLM to analyze event...`);

    try {
      // Increased payload limit from 200 to 500 characters to preserve more information
      const payloadStr = JSON.stringify(event.payload).slice(0, 500);

      // Natural language prompt format instead of pipe-separated format
      const prompt = `You are ${this.agentName}, an IoT agent with capabilities: ${this.agentCapabilities.join(', ')}.

EVENT ANALYSIS REQUEST:
- Event Type: ${event.type}
- Source: ${event.source}
- Severity: ${event.payload?.severity || 'unknown'}
- Data: ${payloadStr}

YOUR CAPABILITIES:
- You can: ${this.agentCapabilities.join(', ')}

DECISION FRAMEWORK:
1. Assess severity (low/medium/high/critical)
2. Determine urgency (0.0-1.0)
3. Identify required capabilities for this event
4. Explain potential impact

Respond in JSON format:
{
  "severity": "low|medium|high|critical",
  "urgency": 0.0-1.0,
  "requirements": ["capability1", "capability2"],
  "potentialImpact": "explanation"
}`;

      const response = await this.llmClient.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 500,
      });

      // Extract JSON from response (handle markdown code blocks)
      const cleanedContent = this.extractJSON(response.content);
      const analysis = JSON.parse(cleanedContent);

      return {
        eventType: event.type,
        severity: analysis.severity || 'medium',
        urgency: analysis.urgency || 0.5,
        requirements: analysis.requirements || [],
        context: event.payload || {},
        potentialImpact: analysis.potentialImpact || 'Unknown',
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      // Fail Early: Log with full context and throw error instead of returning default value
      logger.error(`[AutonomousDecisionEngine:${this.agentId}] LLM analysis failed for event ${event.type} from ${event.source}:`, error);
      throw new Error(`[${this.agentName}] analyzeEventWithLLM failed for event ${event.id} (${event.type}): ${msg}`);
    }
  }

  /**
   * Extract JSON from LLM response (handles markdown code blocks)
   */
  private extractJSON(content: string): string {
    // Check if content contains markdown code blocks
    const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonBlockMatch) {
      return jsonBlockMatch[1].trim();
    }

    // Check if content starts with { but has extra text
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return content.substring(firstBrace, lastBrace + 1);
    }

    // Return as-is if no patterns found
    return content.trim();
  }

  /**
   * Assess agent's own capabilities
   */
  private async assessOwnCapabilities(eventAnalysis: EventAnalysis): Promise<CapabilityAssessment> {
    // Get available capabilities from resource manager
    const availableCapabilities = this.agentCapabilities;

    // Determine which capabilities are relevant to this event
    const relevantCapabilities = availableCapabilities.filter(cap =>
      eventAnalysis.requirements.some(req => cap.toLowerCase().includes(req.toLowerCase()))
    );

    // Identify missing capabilities
    const missingCapabilities = eventAnalysis.requirements.filter(
      req => !availableCapabilities.some(cap => cap.toLowerCase().includes(req.toLowerCase()))
    );

    // Determine if agent can handle alone
    const canHandleAlone = missingCapabilities.length === 0;

    // Calculate handling quality
    const handlingQuality = canHandleAlone
      ? relevantCapabilities.length / Math.max(eventAnalysis.requirements.length, 1)
      : 0.0;

    return {
      availableCapabilities,
      relevantCapabilities,
      missingCapabilities,
      canHandleAlone,
      handlingQuality,
    };
  }

  /**
   * Decide if collaboration is needed
   */
  private decideCollaborationNeeded(
    eventAnalysis: EventAnalysis,
    capabilityAssessment: CapabilityAssessment
  ): boolean {
    // Explicit collaboration needed if agent cannot handle alone
    if (!capabilityAssessment.canHandleAlone) {
      return true;
    }

    // For high urgency or high/critical severity events with requirements,
    // strongly lean toward collaboration for reliability and redundancy
    const isHighSeverity = eventAnalysis.severity === 'high' || eventAnalysis.severity === 'critical';
    const isHighUrgency = eventAnalysis.urgency > 0.8;
    const hasRequirements = eventAnalysis.requirements.length > 0;
    const hasMissingCapabilities = !capabilityAssessment.canHandleAlone;

    // If the event is high severity/urgency AND has requirements AND the agent has
    // any missing capabilities, always collaborate
    if ((isHighSeverity || isHighUrgency) && hasRequirements && hasMissingCapabilities) {
      return true;
    }

    // Consider severity and urgency for events the agent can technically handle alone
    if (isHighSeverity || isHighUrgency) {
      // For high-severity/high-urgency events with requirements, collaborate even if
      // the agent can technically handle it alone, to provide redundancy and faster response
      if (hasRequirements) {
        return capabilityAssessment.handlingQuality < 0.9;
      }
    }

    // Otherwise, can handle independently
    return false;
  }

  /**
   * Identify required services for collaboration
   */
  private async identifyRequiredServices(
    eventAnalysis: EventAnalysis,
    capabilityAssessment: CapabilityAssessment
  ): Promise<ServiceRequirement[]> {
    const requirements: ServiceRequirement[] = [];

    for (const missing of capabilityAssessment.missingCapabilities) {
      requirements.push({
        serviceName: missing,
        reason: `Agent lacks ${missing} capability required to handle ${eventAnalysis.eventType}`,
        priority: eventAnalysis.severity === 'critical' || eventAnalysis.urgency > 0.8
          ? 'high'
          : 'medium',
        requiredParams: {},
      });
    }

    return requirements;
  }

  /**
   * Select collaboration partners based on required services
   */
  private async selectCollaborationPartners(
    requiredServices: ServiceRequirement[]
  ): Promise<CollaborationPartner[]> {
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Selecting collaboration partners...`);

    const partners: CollaborationPartner[] = [];

    // Note: Partners are automatically filtered to same EnvironmentCenter
    // since this.environment only contains local agents.
    // In real deployment, EnvironmentCenter maps to physical space,
    // so only physically reachable agents are considered.

    // Get all agents (excluding self)
    const agents = this.environment.listAgents().filter(agent => agent.id !== this.agentId);

    // Group services by deviceId and find which agent provides them
    const serviceProviders = new Map<string, { agentId: string; services: string[] }>();

    // Access the services registry through proper type
    // Use the public getter method instead of accessing private property
    const servicesRegistry = this.environment.getServices();

    if (!servicesRegistry || servicesRegistry.size === 0) {
      logger.info(`[AutonomousDecisionEngine:${this.agentId}] No services found in environment`);
      return partners;
    }

    // Define proper types for service registry entries
    interface ServiceRegistration {
      service: {
        category?: string;
        name?: string;
        deviceId?: string;
      };
      agentId?: string;
    }

    for (const requirement of requiredServices) {
      // Find matching services from registry
      for (const [key, registration] of servicesRegistry.entries()) {
        // Type-safe cast with runtime validation
        const reg = registration as ServiceRegistration;
        if (!reg || !reg.service) {
          logger.warn(`[AutonomousDecisionEngine:${this.agentId}] Invalid service registration for key ${key}`);
          continue;
        }

        const service = reg.service;

        // Check if service matches requirement
        const matchesRequirement =
          (service.category?.toLowerCase().includes(requirement.serviceName.toLowerCase()) ?? false) ||
          (service.name?.toLowerCase().includes(requirement.serviceName.toLowerCase()) ?? false);

        if (matchesRequirement) {
          const agentId = reg.agentId;
          if (!agentId) {
            logger.warn(`[AutonomousDecisionEngine:${this.agentId}] Service ${service.name} has no agentId`);
            continue;
          }

          const deviceId = service.deviceId || service.name || 'unknown';

          // Skip own services
          if (agentId === this.agentId) {
            continue;
          }

          if (!serviceProviders.has(deviceId)) {
            serviceProviders.set(deviceId, {
              agentId,
              services: [],
            });
          }

          const provider = serviceProviders.get(deviceId);
          if (provider && service.name && !provider.services.includes(service.name)) {
            provider.services.push(service.name);
          }
        }
      }
    }

    // Convert Map to CollaborationPartner array
    for (const [deviceId, provider] of serviceProviders) {
      partners.push({
        agentId: provider.agentId,
        services: provider.services,
        selectionReason: `Provides services matching requirements`,
        estimatedCost: 0,
      });
    }

    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Selected ${partners.length} collaboration partners`);

    return partners;
  }

  /**
   * Calculate confidence in the assessment
   */
  private calculateConfidence(
    eventAnalysis: EventAnalysis,
    capabilityAssessment: CapabilityAssessment,
    requiredServices: ServiceRequirement[]
  ): number {
    let confidence = 0.5;

    // Higher confidence if we matched a known pattern
    if (eventAnalysis.requirements.length > 0) {
      confidence += 0.2;
    }

    // Higher confidence if we clearly can or cannot handle
    if (capabilityAssessment.canHandleAlone || capabilityAssessment.missingCapabilities.length > 0) {
      confidence += 0.2;
    }

    // Higher confidence if we found required services
    if (requiredServices.length > 0) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Generate reasoning for the decision
   */
  private generateReasoning(
    eventAnalysis: EventAnalysis,
    capabilityAssessment: CapabilityAssessment,
    needsCollaboration: boolean,
    requiredServices: ServiceRequirement[]
  ): string {
    if (needsCollaboration) {
      return `Event ${eventAnalysis.eventType} (severity: ${eventAnalysis.severity}, urgency: ${eventAnalysis.urgency}) ` +
        `requires capabilities: ${capabilityAssessment.missingCapabilities.join(', ')}. ` +
        `Agent lacks these capabilities, collaboration needed with ${requiredServices.length} service(s).`;
    } else {
      return `Event ${eventAnalysis.eventType} can be handled independently. ` +
        `Agent has required capabilities: ${capabilityAssessment.relevantCapabilities.join(', ')}.`;
    }
  }

  /**
   * Get a nested value from an object using dot notation
   * e.g., getNestedValue(obj, 'stateChange.property') returns obj.stateChange.property
   */
  private getNestedValue(obj: Record<string, any>, path: string): unknown {
    const keys = path.split('.');
    let current: unknown = obj;
    for (const key of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  /**
   * Match event against a pattern
   */
  private matchEventPattern(event: SystemEvent, pattern: EventPattern): boolean {
    // Check event type
    if (pattern.eventType !== '*' && event.type !== pattern.eventType) {
      // Support wildcard matching
      if (!pattern.eventType.includes('*')) {
        return false;
      }

      // Convert wildcard pattern to regex
      const regex = new RegExp('^' + pattern.eventType.replace(/\*/g, '.*') + '$');
      if (!regex.test(event.type)) {
        return false;
      }
    }

    // Check required fields (supports dot notation for nested fields)
    if (pattern.requiredFields) {
      for (const field of pattern.requiredFields) {
        const value = this.getNestedValue(event.payload || {}, field);
        if (value === undefined) {
          return false;
        }
      }
    }

    // Check field values (supports dot notation for nested fields)
    if (pattern.fieldValues) {
      for (const [fieldPath, expectedValue] of Object.entries(pattern.fieldValues)) {
        const actualValue = this.getNestedValue(event.payload || {}, fieldPath);
        if (actualValue !== expectedValue) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Update the decision engine configuration
   */
  updateConfig(config: Partial<DecisionEngineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Configuration updated`);
  }

  /**
   * Add custom event patterns
   */
  addPatterns(patterns: EventPattern[]): void {
    this.patterns.push(...patterns);
    logger.info(`[AutonomousDecisionEngine:${this.agentId}] Added ${patterns.length} custom patterns`);
  }
}
