/**
 * AC Decision Context Builder
 *
 * Assembles complete context for AC (Active Collaboration) decision-making.
 * This is the core component of Phase 2 of the Context Management System.
 *
 * Key Features:
 * 1. Builds complete ACDecisionContext from multiple sources
 * 2. Performs ontology reasoning for capability analysis
 * 3. Analyzes capability gaps for collaboration necessity
 * 4. Recommends potential partners based on capability matching
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                    ACContextBuilder                              │
 * ├─────────────────────────────────────────────────────────────────┤
 * │  Inputs:                                                        │
 * │  - SpatialClusterSummary (from Layer 1)                        │
 * │  - SystemEvent (trigger event)                                  │
 * │  - AgentTraits (optional)                                       │
 * │  - MotivationSuggestion (optional)                             │
 * │                                                                  │
 * │  Processing:                                                    │
 * │  1. Normalize event context                                     │
 * │  2. Build full agent context                                    │
 * │  3. Perform ontology reasoning                                  │
 * │  4. Analyze capability gaps                                     │
 * │  5. Recommend partners                                          │
 * │                                                                  │
 * │  Output:                                                        │
 * │  - ACDecisionContext (complete decision context)               │
 * └─────────────────────────────────────────────────────────────────┘
 */

import type { ResourceManager } from '../resource/ResourceManager.js';
import type { ServiceRegistry } from '../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { SpatialClusterSummary } from '../events/SpatialTemporalClusterEngine.js';
import type { SystemEvent } from '../events/EventManager.js';
import type { AgentTraits, MotivationSuggestion } from '../decision/ACNecessityAssessor.js';
import type { ResourceOntology } from '../resource/Resource.js';
import type { ServiceOntology } from '../service/SemanticService.js';

import { AgentContextBuilder, type AgentInfo, type DeviceStateInfo, type ServiceInfo, type PeerAgentInfo, type EnvironmentState } from './AgentContextBuilder.js';
import { EventContextNormalizer, type NormalizedEventContext } from './EventContextNormalizer.js';
import { OntologyContextComposer, type OntologyContextResult } from './OntologyContextComposer.js';
import { OntologyReasoningEngine } from '../ontology/OntologyReasoningEngine.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Agent context for AC decision-making
 */
const logger = createLogger('ACContextBuilder');

export interface AgentContextForAC {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  role: string;
  status: string;
  traits?: AgentTraits;
  motivationSuggestion?: MotivationSuggestion;
  currentWorkload: 'idle' | 'light' | 'moderate' | 'heavy';
  currentCollaborations: number;
  recentCollaborations: string[];
}

/**
 * Resource information for AC context
 */
export interface ResourceInfo {
  id: string;
  name: string;
  type: string;
  location?: string;
  capabilities: string[];
  currentState: Record<string, any>;
  isOnline: boolean;
  ontology?: ResourceOntology;
}

/**
 * Service information for AC context
 */
export interface ServiceInfoForAC {
  id: string;
  name: string;
  category: string;
  capabilities: string[];
  status: 'available' | 'busy' | 'offline';
  ontology?: ServiceOntology;
}

/**
 * Peer service information for AC context
 */
export interface PeerServiceInfo {
  id: string;
  name: string;
  providerAgentId: string;
  providerAgentName: string;
  category: string;
  capabilities: string[];
  status: 'available' | 'busy' | 'offline';
  ontology?: ServiceOntology;
}

/**
 * Resource context for AC decision
 */
export interface ResourceContext {
  ownResources: ResourceInfo[];
  capabilityGaps: string[];
  availableCapabilities: string[];
}

/**
 * Service context for AC decision
 */
export interface ServiceContext {
  ownServices: ServiceInfoForAC[];
  peerServices: PeerServiceInfo[];
}

/**
 * Peer agent information for AC context
 */
export interface PeerAgentInfoForAC {
  id: string;
  name: string;
  capabilities: string[];
  status: string;
  services: Array<{
    id: string;
    name: string;
    capabilities: string[];
  }>;
}

/**
 * Recommended partner information
 */
export interface RecommendedPartner {
  agentId: string;
  agentName: string;
  matchScore: number;
  matchedCapabilities: string[];
  reason: string;
}

/**
 * Collaboration context for AC decision
 */
export interface CollaborationContext {
  peerAgents: PeerAgentInfoForAC[];
  recommendedPartners: RecommendedPartner[];
}

/**
 * Zone information for environment context
 */
export interface ZoneInfo {
  id: string;
  name: string;
  location: string;
  state: Record<string, any>;
}

/**
 * Environment context for AC decision
 */
export interface EnvironmentContext {
  environmentId: string;
  environmentName: string;
  environmentType?: string;
  physicalState?: Record<string, any>;
  zones?: ZoneInfo[];
}

/**
 * Task analysis from ontology reasoning
 */
export interface TaskAnalysis {
  requiredCapabilities: string[];
  relevantResources: string[];
  suggestedServices: string[];
}

/**
 * Collaboration analysis from ontology reasoning
 */
export interface CollaborationAnalysis {
  isCollaborationNeeded: boolean;
  reason: string;
  suggestedPartnerTypes: string[];
}

/**
 * Spatial-temporal analysis from ontology reasoning
 */
export interface SpatialTemporalAnalysis {
  affectedZones: string[];
  propagationPath?: Array<{ x: number; y: number; z: number }>;
  estimatedImpactTime?: number;
}

/**
 * Ontology reasoning context
 */
export interface OntologyReasoningContext {
  taskAnalysis: TaskAnalysis;
  collaborationAnalysis: CollaborationAnalysis;
  spatialTemporalAnalysis?: SpatialTemporalAnalysis;
}

/**
 * Temporal context for AC decision
 */
export interface TemporalContext {
  currentTime: Date;
  timeScale?: number;
  urgencyLevel: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * Complete AC decision context
 * Contains all information needed for LLM-based AC decision-making
 */
export interface ACDecisionContext {
  // Trigger event (normalized)
  triggerEvent: NormalizedEventContext;

  // Cluster summary from Layer 1
  clusterSummary: SpatialClusterSummary;

  // Agent context
  agentContext: AgentContextForAC;

  // Resource context
  resourceContext: ResourceContext;

  // Service context
  serviceContext: ServiceContext;

  // Collaboration context
  collaborationContext: CollaborationContext;

  // Environment context
  environmentContext: EnvironmentContext;

  // Ontology reasoning results
  ontologyReasoning?: OntologyReasoningContext;

  // Temporal context
  temporalContext: TemporalContext;
}

// ============================================================================
// ACContextBuilder
// ============================================================================

/**
 * AC Decision Context Builder
 *
 * Assembles complete context for AC decision-making by combining:
 * 1. Event context (normalized from trigger event)
 * 2. Agent context (identity, capabilities, workload)
 * 3. Resource context (devices, capabilities)
 * 4. Service context (own and peer services)
 * 5. Collaboration context (peers, recommendations)
 * 6. Environment context (physical state, zones)
 * 7. Ontology reasoning (task analysis, collaboration analysis)
 * 8. Temporal context (time, urgency)
 */
export class ACContextBuilder {
  private agent: AgentInfo;
  private resourceManager: ResourceManager;
  private serviceRegistry: ServiceRegistry;
  private environment: EnvironmentCenter;

  // Internal builders and composers
  private agentContextBuilder: AgentContextBuilder;
  private eventNormalizer: EventContextNormalizer;
  private ontologyComposer: OntologyContextComposer;
  private ontologyReasoningEngine: OntologyReasoningEngine;

  constructor(
    agent: AgentInfo,
    resourceManager: ResourceManager,
    serviceRegistry: ServiceRegistry,
    environment: EnvironmentCenter
  ) {
    this.agent = agent;
    this.resourceManager = resourceManager;
    this.serviceRegistry = serviceRegistry;
    this.environment = environment;

    // Initialize internal components
    this.agentContextBuilder = new AgentContextBuilder(
      agent,
      resourceManager,
      serviceRegistry,
      environment
    );
    this.eventNormalizer = new EventContextNormalizer();
    this.ontologyReasoningEngine = new OntologyReasoningEngine();
    this.ontologyComposer = this.agentContextBuilder.getOntologyComposer();

    logger.info('Initialized');
  }

  /**
   * Build complete decision context for AC decision-making
   *
   * This is the main entry point that assembles all context components.
   *
   * @param clusterSummary - Cluster summary from Layer 1
   * @param triggerEvent - The triggering event
   * @param agentTraits - Optional agent personality traits
   * @param motivationSuggestion - Optional motivation from Role & Goal system
   * @returns Complete ACDecisionContext
   */
  async buildDecisionContext(
    clusterSummary: SpatialClusterSummary,
    triggerEvent: SystemEvent,
    agentTraits?: AgentTraits,
    motivationSuggestion?: MotivationSuggestion
  ): Promise<ACDecisionContext> {
    logger.info('Building decision context...');

    // Step 1: Normalize trigger event
    const normalizedEvent = this.eventNormalizer.normalizeQuick(triggerEvent);
    logger.info(`Normalized event: ${normalizedEvent.eventType}, severity: ${normalizedEvent.severity}`);

    // Step 2: Build full agent context
    const fullContext = await this.agentContextBuilder.buildFullContext();
    logger.info(`Built full agent context: ${fullContext.resources.length} resources, ${fullContext.peerAgents.length} peers`);

    // Step 3: Perform ontology reasoning
    const ontologyReasoning = await this.performOntologyReasoning(normalizedEvent, fullContext);

    // Step 4: Analyze capability gaps
    const capabilityGaps = this.analyzeCapabilityGaps(
      normalizedEvent.taskContext?.requiredCapabilities || [],
      fullContext.resources,
      ontologyReasoning.taskAnalysis.requiredCapabilities
    );
    logger.info(`Capability gaps: ${capabilityGaps.join(', ') || 'none'}`);

    // Step 5: Recommend partners
    const recommendedPartners = this.recommendPartners(
      capabilityGaps,
      fullContext.peerAgents,
      normalizedEvent
    );
    logger.info(`Recommended partners: ${recommendedPartners.length}`);

    // Step 6: Determine urgency level
    const urgencyLevel = this.determineUrgencyLevel(normalizedEvent, clusterSummary);

    // Step 7: Calculate workload
    const currentWorkload = this.calculateWorkload(fullContext.peerAgents.length);

    // Step 8: Assemble complete decision context
    return {
      triggerEvent: normalizedEvent,
      clusterSummary,

      agentContext: {
        id: fullContext.self.id,
        name: fullContext.self.name,
        description: fullContext.self.description,
        capabilities: fullContext.self.capabilities,
        role: fullContext.self.role,
        status: fullContext.self.status,
        traits: agentTraits,
        motivationSuggestion,
        currentWorkload,
        currentCollaborations: 0, // Would need to track from CollaborationManager
        recentCollaborations: [], // Would need to track from CollaborationManager
      },

      resourceContext: {
        ownResources: fullContext.resources.map(r => ({
          id: r.id,
          name: r.name,
          type: r.type,
          location: r.location,
          capabilities: r.capabilities,
          currentState: r.currentState,
          isOnline: r.isOnline,
          ontology: r.resourceOntology,
        })),
        capabilityGaps,
        availableCapabilities: fullContext.self.capabilities,
      },

      serviceContext: {
        ownServices: fullContext.availableServices.own.map(s => ({
          id: s.id,
          name: s.name,
          category: s.category,
          capabilities: s.capabilities,
          status: s.status,
          ontology: s.serviceOntology,
        })),
        peerServices: fullContext.availableServices.fromPeers.map(s => ({
          id: s.id,
          name: s.name,
          providerAgentId: s.providerAgentId,
          providerAgentName: s.providerAgentName,
          category: s.category,
          capabilities: s.capabilities,
          status: s.status,
          ontology: s.serviceOntology,
        })),
      },

      collaborationContext: {
        peerAgents: fullContext.peerAgents.map(p => ({
          id: p.id,
          name: p.name,
          capabilities: p.capabilities,
          status: p.status,
          services: p.services.map(s => ({
            id: s.id,
            name: s.name,
            capabilities: s.capabilities,
          })),
        })),
        recommendedPartners,
      },

      environmentContext: {
        environmentId: fullContext.environment.id,
        environmentName: fullContext.environment.name,
        environmentType: fullContext.environment.type,
        physicalState: fullContext.environment.physicalState,
        zones: fullContext.environment.zones,
      },

      ontologyReasoning,

      temporalContext: {
        currentTime: new Date(),
        timeScale: fullContext.temporal.timeScale,
        urgencyLevel,
      },
    };
  }

  /**
   * Perform ontology reasoning for task and collaboration analysis
   */
  private async performOntologyReasoning(
    event: NormalizedEventContext,
    context: Awaited<ReturnType<AgentContextBuilder['buildFullContext']>>
  ): Promise<OntologyReasoningContext> {
    const taskDescription = event.taskContext?.taskDescription ||
      `Handle ${event.eventType} at ${event.spatialContext.zone || 'unknown location'}`;

    try {
      const ontologyResult = await this.ontologyComposer.composeForTask(
        taskDescription,
        context.resources,
        context.availableServices,
        context.peerAgents
      );

      return {
        taskAnalysis: {
          requiredCapabilities: ontologyResult.internalReasoning?.missingCapabilities || [],
          relevantResources: ontologyResult.internalReasoning?.matchingResources.map(r => r.name) || [],
          suggestedServices: ontologyResult.externalReasoning?.compatibleServices.map(s => s.serviceName) || [],
        },
        collaborationAnalysis: {
          isCollaborationNeeded: ontologyResult.combinedReasoning?.canCollaborate || false,
          reason: ontologyResult.combinedReasoning?.reasoning || '',
          suggestedPartnerTypes: ontologyResult.externalReasoning?.compatibleServices.map(s => s.serviceName) || [],
        },
        spatialTemporalAnalysis: this.analyzeSpatialTemporal(event, context),
      };
    } catch (error) {
      logger.warn('Ontology reasoning failed, using defaults:', error);
      return {
        taskAnalysis: {
          requiredCapabilities: event.taskContext?.requiredCapabilities || [],
          relevantResources: [],
          suggestedServices: [],
        },
        collaborationAnalysis: {
          isCollaborationNeeded: false,
          reason: 'Ontology reasoning unavailable',
          suggestedPartnerTypes: [],
        },
      };
    }
  }

  /**
   * Analyze capability gaps between required and available capabilities
   */
  analyzeCapabilityGaps(
    requiredFromTask: string[],
    resources: DeviceStateInfo[],
    requiredFromOntology: string[]
  ): string[] {
    const allRequired = new Set([
      ...requiredFromTask.map(c => c.toLowerCase()),
      ...requiredFromOntology.map(c => c.toLowerCase()),
    ]);

    // Collect available capabilities from resources
    const availableCapabilities = new Set<string>();
    for (const resource of resources) {
      for (const cap of resource.capabilities) {
        availableCapabilities.add(cap.toLowerCase());
      }
    }

    // Also include agent's own capabilities
    for (const cap of this.agent.capabilities) {
      availableCapabilities.add(cap.toLowerCase());
    }

    // Find gaps
    const gaps: string[] = [];
    for (const required of allRequired) {
      // Check if any available capability matches (case-insensitive, partial match)
      let hasCapability = false;
      for (const available of availableCapabilities) {
        if (available.includes(required) || required.includes(available)) {
          hasCapability = true;
          break;
        }
      }
      if (!hasCapability) {
        gaps.push(required);
      }
    }

    return gaps;
  }

  /**
   * Recommend potential partners based on capability matching
   */
  recommendPartners(
    capabilityGaps: string[],
    peerAgents: PeerAgentInfo[],
    event: NormalizedEventContext
  ): RecommendedPartner[] {
    if (capabilityGaps.length === 0) {
      return [];
    }

    const recommendations: RecommendedPartner[] = [];

    for (const peer of peerAgents) {
      const matchedCapabilities: string[] = [];
      let matchScore = 0;

      // Check peer's direct capabilities
      for (const gap of capabilityGaps) {
        const gapLower = gap.toLowerCase();
        for (const peerCap of peer.capabilities) {
          const peerCapLower = peerCap.toLowerCase();
          if (peerCapLower.includes(gapLower) || gapLower.includes(peerCapLower)) {
            if (!matchedCapabilities.includes(gap)) {
              matchedCapabilities.push(gap);
              matchScore += 0.3;
            }
            break;
          }
        }
      }

      // Check peer's service capabilities
      for (const service of peer.services) {
        for (const gap of capabilityGaps) {
          const gapLower = gap.toLowerCase();
          for (const serviceCap of service.capabilities) {
            const serviceCapLower = serviceCap.toLowerCase();
            if (serviceCapLower.includes(gapLower) || gapLower.includes(serviceCapLower)) {
              if (!matchedCapabilities.includes(gap)) {
                matchedCapabilities.push(gap);
                matchScore += 0.2;
              }
              break;
            }
          }
        }
      }

      if (matchedCapabilities.length > 0) {
        // Bonus for number of matched capabilities
        matchScore += matchedCapabilities.length * 0.1;

        recommendations.push({
          agentId: peer.id,
          agentName: peer.name,
          matchScore: Math.min(1, matchScore),
          matchedCapabilities,
          reason: `Can provide: ${matchedCapabilities.join(', ')}`,
        });
      }
    }

    // Sort by match score (descending)
    return recommendations.sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Analyze spatial-temporal impact of the event
   */
  private analyzeSpatialTemporal(
    event: NormalizedEventContext,
    context: Awaited<ReturnType<AgentContextBuilder['buildFullContext']>>
  ): SpatialTemporalAnalysis {
    const affectedZones: string[] = [];

    // Add event zone
    if (event.spatialContext.zone) {
      affectedZones.push(event.spatialContext.zone);
    }

    // If there's a location, check for nearby zones
    if (event.spatialContext.location && context.environment.zones) {
      // Could implement proximity-based zone detection here
      // For now, just include the direct zone
    }

    return {
      affectedZones,
    };
  }

  /**
   * Determine urgency level based on event and cluster summary
   */
  private determineUrgencyLevel(
    event: NormalizedEventContext,
    clusterSummary: SpatialClusterSummary
  ): 'low' | 'medium' | 'high' | 'urgent' {
    // Priority 1: Check event severity
    const eventSeverity = event.severity;
    if (eventSeverity === 'critical') return 'urgent';
    if (eventSeverity === 'urgent') return 'urgent';
    if (eventSeverity === 'high') return 'high';

    // Priority 2: Check cluster significance
    const clusterSignificance = clusterSummary.significance;
    if (clusterSignificance === 'urgent') return 'urgent';
    if (clusterSignificance === 'high') return 'high';
    if (clusterSignificance === 'medium') return 'medium';

    return 'low';
  }

  /**
   * Calculate workload level based on activity
   */
  private calculateWorkload(peerCount: number): 'idle' | 'light' | 'moderate' | 'heavy' {
    // This is a simplified calculation
    // In production, would track actual active collaborations
    if (peerCount === 0) return 'idle';
    if (peerCount < 3) return 'light';
    if (peerCount < 6) return 'moderate';
    return 'heavy';
  }

  /**
   * Get the underlying AgentContextBuilder
   */
  getAgentContextBuilder(): AgentContextBuilder {
    return this.agentContextBuilder;
  }

  /**
   * Get the OntologyContextComposer
   */
  getOntologyComposer(): OntologyContextComposer {
    return this.ontologyComposer;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an ACContextBuilder instance
 */
export function createACContextBuilder(
  agent: AgentInfo,
  resourceManager: ResourceManager,
  serviceRegistry: ServiceRegistry,
  environment: EnvironmentCenter
): ACContextBuilder {
  return new ACContextBuilder(agent, resourceManager, serviceRegistry, environment);
}
