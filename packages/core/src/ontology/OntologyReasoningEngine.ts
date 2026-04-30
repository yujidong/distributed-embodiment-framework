/**
 * Ontology Reasoning Engine
 *
 * Provides semantic reasoning capabilities for agents based on Resource-Service Ontology.
 * Implements the reasoning patterns described in ARCHITECTURE.md
 * Section: Resource-Service Ontology Architecture
 *
 * Key capabilities:
 * 1. Internal Reasoning: Agent understands its own capabilities through Resource Ontology
 * 2. External Reasoning: Agent understands others' offerings through Service Ontology
 * 3. Cross-layer Reasoning: Combined reasoning across Resource and Service layers
 */

import {
  ServiceType,
  ServiceOntologyClass,
  type ServiceOntology,
  type ServiceDependency,
  type ServiceSpatialContext,
  type ServiceSemanticContext,
  type BusinessCapability,
  getBusinessCapabilitySpec,
} from '../service/SemanticService.js';
import type { ResourceOntology } from '../resource/Resource.js';

/**
 * Reasoning result for internal capabilities
 */
export interface InternalReasoningResult {
  /** Whether the agent can handle the query with its own resources */
  canHandle: boolean;
  /** Resources that match the query */
  matchingResources: Array<{
    id: string;
    name: string;
    ontologyClass: string;
    location?: string;
    capabilities: string[];
  }>;
  /** Capabilities that are missing */
  missingCapabilities: string[];
  /** Reasoning explanation */
  reasoning: string;
  /** Confidence level (0-1) */
  confidence: number;
}

/**
 * Compatible peer service info
 */
export interface CompatiblePeerService {
  serviceId: string;
  serviceName: string;
  businessCapabilitySpec: string;
  compatibilityScore: number;
  location?: string;
  collaborationHints: string[];
}

/**
 * Reasoning result for peer services
 */
export interface PeerServiceReasoningResult {
  /** Compatible services found */
  compatibleServices: CompatiblePeerService[];
  /** Whether collaboration is possible */
  canCollaborate: boolean;
  /** Reasoning explanation */
  reasoning: string;
}

/**
 * Combined reasoning context
 */
export interface CombinedReasoningContext {
  /** Agent's own resources */
  resources: Array<{
    id: string;
    name: string;
    type: string;
    ontology?: ResourceOntology;
  }>;
  /** Available peer services */
  peerServices: Array<{
    id: string;
    name: string;
    ontology?: ServiceOntology;
  }>;
}

/**
 * Combined reasoning result
 */
export interface CombinedReasoningResult {
  /** Can handle with own resources */
  canHandleInternally: boolean;
  /** Can collaborate with peers */
  canCollaborate: boolean;
  /** Recommended execution strategy */
  recommendedStrategy: 'direct' | 'collaborative' | 'resource-based' | 'decomposed';
  /** Internal reasoning details */
  internalReasoning?: InternalReasoningResult;
  /** External reasoning details */
  externalReasoning?: PeerServiceReasoningResult;
  /** Overall reasoning explanation */
  reasoning: string;
}

/**
 * Reasoning context for task planner
 */
export interface ReasoningContext {
  /** Target location for the task */
  location?: string;
  /** Available capabilities from resources */
  availableCapabilities: string[];
  /** Missing capabilities */
  missingCapabilities: string[];
  /** Ontology summary for LLM */
  ontologySummary: string;
  /** Compatible peer services */
  peerServices: CompatiblePeerService[];
}

/**
 * Ontology Reasoning Engine
 *
 * Provides semantic reasoning capabilities for:
 * 1. Understanding own capabilities (internal reasoning)
 * 2. Understanding peer services (external reasoning)
 * 3. Combined decision making (cross-layer reasoning)
 * 4. Service ontology derivation from resources
 */
export class OntologyReasoningEngine {
  /**
   * Reason about own capabilities using resource ontology
   *
   * Analyzes whether the agent can handle a query using its own resources.
   * Uses semantic matching based on:
   * - Ontology class (SSN/SAREF)
   * - Spatial context (location, zone)
   * - Raw capabilities
   *
   * @param query - The capability query (e.g., "Can I control temperature?")
   * @param resources - Available resources with ontology
   * @param services - Available services (for service-based capabilities)
   * @returns Internal reasoning result
   */
  async reasonAboutOwnCapabilities(
    query: string,
    resources: Array<{
      id: string;
      name: string;
      type: string;
      ontology?: ResourceOntology;
    }>,
    services: Array<{
      id: string;
      name: string;
      ontology?: ServiceOntology;
    }> = []
  ): Promise<InternalReasoningResult> {
    const matchingResources: InternalReasoningResult['matchingResources'] = [];
    const availableCapabilities = new Set<string>();
    const queryLower = query.toLowerCase();

    // Extract intent from query
    const intent = this.extractIntent(queryLower);
    const targetLocation = this.extractLocation(queryLower);

    // Analyze resources
    for (const resource of resources) {
      if (!resource.ontology) {
        continue;
      }

      const ontology = resource.ontology;
      const capabilities = ontology.rawCapabilities.map(c => c.name);
      capabilities.forEach(c => availableCapabilities.add(c));

      // Check spatial match
      const spatialMatch = this.checkSpatialMatch(
        ontology.spatialContext,
        targetLocation
      );

      // Check capability match
      const capabilityMatch = this.checkCapabilityMatch(
        capabilities,
        intent.requiredCapabilities
      );

      // Check ontology class match
      const ontologyMatch = this.checkOntologyClassMatch(
        ontology.ontologyClass,
        intent.ontologyKeywords
      );

      if (capabilityMatch && (spatialMatch || !targetLocation) && ontologyMatch) {
        matchingResources.push({
          id: resource.id,
          name: resource.name,
          ontologyClass: ontology.ontologyClass,
          location: ontology.spatialContext?.location,
          capabilities,
        });
      }
    }

    // Analyze services
    for (const service of services) {
      if (!service.ontology) {
        continue;
      }

      const ontology = service.ontology;
      const capabilities = ontology.businessCapability?.name
        ? [ontology.businessCapability.name]
        : [];

      // Check if service can help
      const capabilityMatch = this.checkCapabilityMatch(
        capabilities,
        intent.requiredCapabilities
      );

      if (capabilityMatch) {
        // Service contributes to capability
        capabilities.forEach(c => availableCapabilities.add(c));
      }
    }

    // Determine missing capabilities
    const missingCapabilities = intent.requiredCapabilities.filter(
      cap => !Array.from(availableCapabilities).some(
        avail => avail.toLowerCase().includes(cap.toLowerCase()) ||
                 cap.toLowerCase().includes(avail.toLowerCase())
      )
    );

    const canHandle = matchingResources.length > 0 || missingCapabilities.length === 0;

    const reasoning = this.generateInternalReasoning(
      canHandle,
      matchingResources,
      missingCapabilities,
      targetLocation
    );

    return {
      canHandle,
      matchingResources,
      missingCapabilities,
      reasoning,
      confidence: canHandle ? 0.9 : 0.3,
    };
  }

  /**
   * Reason about peer services
   *
   * Finds compatible peer services based on:
   * - Business capability matching
   * - Spatial context (location, zones)
   * - Semantic context (business description, scenarios)
   *
   * Note: Resource details are hidden - only business capabilities are exposed
   *
   * @param query - The capability query
   * @param peerServices - Available peer services with ontology
   * @returns Peer service reasoning result
   */
  async reasonAboutPeerServices(
    query: string,
    peerServices: Array<{
      id: string;
      name: string;
      ontology?: ServiceOntology;
    }>
  ): Promise<PeerServiceReasoningResult> {
    const compatibleServices: CompatiblePeerService[] = [];
    const queryLower = query.toLowerCase();

    // Extract intent from query
    const intent = this.extractIntent(queryLower);
    const targetLocation = this.extractLocation(queryLower);

    for (const service of peerServices) {
      if (!service.ontology) {
        continue;
      }

      const ontology = service.ontology;
      let compatibilityScore = 0;
      const collaborationHints: string[] = [];

      // Check business capability match
      if (ontology.businessCapability) {
        const capName = ontology.businessCapability.name.toLowerCase();
        const capDesc = ontology.businessCapability.description.toLowerCase();

        for (const keyword of intent.keywords) {
          if (capName.includes(keyword) || capDesc.includes(keyword)) {
            compatibilityScore += 0.3;
          }
        }
      }

      // Check spatial context
      if (targetLocation && ontology.spatialContext) {
        const spatial = ontology.spatialContext;
        if (spatial.location === targetLocation) {
          compatibilityScore += 0.3;
        }
        if (spatial.zones?.includes(targetLocation)) {
          compatibilityScore += 0.2;
        }
      }

      // Check semantic context
      if (ontology.semanticContext) {
        const semantic = ontology.semanticContext;

        // Check applicable scenarios
        for (const scenario of semantic.applicableScenarios || []) {
          if (intent.keywords.some(k => scenario.toLowerCase().includes(k))) {
            compatibilityScore += 0.1;
          }
        }

        // Collect collaboration hints
        collaborationHints.push(...(semantic.collaborationHints || []));
      }

      // Check ontology class
      if (ontology.ontologyClass) {
        const classLower = ontology.ontologyClass.toLowerCase();
        for (const keyword of intent.ontologyKeywords) {
          if (classLower.includes(keyword)) {
            compatibilityScore += 0.2;
          }
        }
      }

      // Only include services with reasonable compatibility
      if (compatibilityScore > 0.2) {
        compatibleServices.push({
          serviceId: service.id,
          serviceName: service.name,
          businessCapabilitySpec: getBusinessCapabilitySpec(ontology),
          compatibilityScore: Math.min(1, compatibilityScore),
          location: ontology.spatialContext?.location,
          collaborationHints,
        });
      }
    }

    // Sort by compatibility score
    compatibleServices.sort((a, b) => b.compatibilityScore - a.compatibilityScore);

    const canCollaborate = compatibleServices.length > 0;

    const reasoning = canCollaborate
      ? `Found ${compatibleServices.length} compatible peer service(s). ` +
        `Best match: ${compatibleServices[0].serviceName} (score: ${compatibleServices[0].compatibilityScore.toFixed(2)})`
      : 'No compatible peer services found';

    return {
      compatibleServices,
      canCollaborate,
      reasoning,
    };
  }

  /**
   * Combined reasoning across internal and external capabilities
   *
   * Combines internal resource reasoning with external peer service reasoning
   * to determine the best execution strategy.
   *
   * @param query - The task query
   * @param context - Combined context with resources and peer services
   * @returns Combined reasoning result with recommended strategy
   */
  async combinedReasoning(
    query: string,
    context: CombinedReasoningContext
  ): Promise<CombinedReasoningResult> {
    // Run internal reasoning
    const internalReasoning = await this.reasonAboutOwnCapabilities(
      query,
      context.resources,
      []
    );

    // Run external reasoning
    const externalReasoning = await this.reasonAboutPeerServices(
      query,
      context.peerServices
    );

    // Determine recommended strategy
    let recommendedStrategy: CombinedReasoningResult['recommendedStrategy'];

    if (internalReasoning.canHandle) {
      if (internalReasoning.matchingResources.length > 1) {
        recommendedStrategy = 'resource-based';
      } else {
        recommendedStrategy = 'direct';
      }
    } else if (externalReasoning.canCollaborate) {
      recommendedStrategy = 'collaborative';
    } else {
      recommendedStrategy = 'decomposed';
    }

    const reasoning = this.generateCombinedReasoning(
      internalReasoning,
      externalReasoning,
      recommendedStrategy
    );

    return {
      canHandleInternally: internalReasoning.canHandle,
      canCollaborate: externalReasoning.canCollaborate,
      recommendedStrategy,
      internalReasoning,
      externalReasoning,
      reasoning,
    };
  }

  /**
   * Derive service ontology from resource ontology
   *
   * Creates a service ontology from a resource ontology for resource-backed services.
   * The service inherits:
   * - Spatial context (with source = 'inherited')
   * - Capabilities (mapped to business capability)
   * - Constraints (mapped to guarantees)
   *
   * @param resourceOntology - The resource ontology to derive from (null for pure-logic)
   * @param serviceType - The service type
   * @returns Derived service ontology
   */
  deriveServiceOntology(
    resourceOntology: ResourceOntology | null,
    serviceType: 'pure-logic' | 'resource-backed' | 'composite' | 'external'
  ): ServiceOntology {
    // For pure-logic services, create minimal ontology
    if (serviceType === 'pure-logic' || !resourceOntology) {
      return {
        serviceType: ServiceType.PURE_LOGIC,
        ontologyClass: ServiceOntologyClass.IOT_ANALYTICS_SERVICE,
        businessCapability: {
          name: 'Logic Service',
          description: 'Pure computation service',
          inputs: [],
          outputs: [],
        },
        dependencies: [],
        spatialContext: {
          source: 'none',
        },
        semanticContext: {
          businessDescription: 'Pure logic service without resource dependencies',
          applicableScenarios: [],
          collaborationHints: [],
        },
      };
    }

    // Derive from resource ontology
    const spatialContext: ServiceSpatialContext = {
      location: resourceOntology.spatialContext?.location,
      zones: resourceOntology.spatialContext?.zone
        ? [resourceOntology.spatialContext.zone]
        : [],
      source: 'inherited',
      position: resourceOntology.spatialContext?.position,
      coverage: resourceOntology.spatialContext?.coverage,
    };

    // Map capabilities
    const inputs: BusinessCapability['inputs'] = [];
    const outputs: BusinessCapability['outputs'] = [];

    for (const cap of resourceOntology.rawCapabilities) {
      if (cap.type === 'read') {
        outputs.push({
          name: cap.name,
          type: 'sensor-reading',
          description: cap.description,
        });
      } else if (cap.type === 'write') {
        inputs.push({
          name: cap.name,
          type: 'actuation-command',
          description: cap.description,
        });
      } else {
        inputs.push({
          name: cap.name,
          type: 'command',
          description: cap.description,
        });
      }
    }

    const businessCapability: BusinessCapability = {
      name: resourceOntology.semanticDescription?.what || 'Resource Service',
      description: resourceOntology.semanticDescription?.purpose || 'Service derived from resource',
      inputs,
      outputs,
      guarantees: resourceOntology.semanticDescription?.constraints || [],
    };

    const dependencies: ServiceDependency[] = [
      {
        type: 'resource',
        id: 'derived-from-resource',
        requiredCapabilities: resourceOntology.rawCapabilities.map(c => c.name),
      },
    ];

    const semanticContext: ServiceSemanticContext = {
      businessDescription: resourceOntology.semanticDescription?.purpose || '',
      applicableScenarios: [],
      collaborationHints: [],
    };

    // Map ontology class
    const ontologyClass = this.mapResourceToServiceOntologyClass(
      resourceOntology.ontologyClass
    );

    return {
      serviceType: serviceType as ServiceType,
      ontologyClass,
      businessCapability,
      dependencies,
      spatialContext,
      semanticContext,
    };
  }

  /**
   * Generate reasoning context for task planner
   *
   * Creates a summary of available capabilities and ontology information
   * for the task planner to use in LLM prompts.
   *
   * @param resources - Available resources
   * @param peerServices - Available peer services
   * @param targetLocation - Target location for the task
   * @returns Reasoning context for task planner
   */
  generateReasoningContext(
    resources: Array<{
      id: string;
      name: string;
      type: string;
      ontology?: ResourceOntology;
    }>,
    peerServices: Array<{
      id: string;
      name: string;
      ontology?: ServiceOntology;
    }>,
    targetLocation?: string
  ): ReasoningContext {
    const availableCapabilities = new Set<string>();
    const ontologyParts: string[] = [];

    // Collect capabilities from resources
    for (const resource of resources) {
      if (resource.ontology?.rawCapabilities) {
        for (const cap of resource.ontology.rawCapabilities) {
          availableCapabilities.add(cap.name);
        }
      }

      // Add ontology info
      if (resource.ontology) {
        ontologyParts.push(
          `${resource.name}: ${resource.ontology.ontologyClass} @ ${resource.ontology.spatialContext?.location || 'unknown'}`
        );
      }
    }

    // Collect compatible peer services
    const compatiblePeerServices: CompatiblePeerService[] = [];
    for (const service of peerServices) {
      if (service.ontology) {
        // Check location match if target specified
        if (targetLocation && service.ontology.spatialContext?.location !== targetLocation) {
          continue;
        }

        compatiblePeerServices.push({
          serviceId: service.id,
          serviceName: service.name,
          businessCapabilitySpec: getBusinessCapabilitySpec(service.ontology),
          compatibilityScore: 1.0,
          location: service.ontology.spatialContext?.location,
          collaborationHints: service.ontology.semanticContext?.collaborationHints || [],
        });
      }
    }

    return {
      location: targetLocation,
      availableCapabilities: Array.from(availableCapabilities),
      missingCapabilities: [], // Would be computed based on task requirements
      ontologySummary: ontologyParts.join('\n'),
      peerServices: compatiblePeerServices,
    };
  }

  // --- Private helper methods ---

  private extractIntent(query: string): {
    requiredCapabilities: string[];
    keywords: string[];
    ontologyKeywords: string[];
  } {
    const keywords: string[] = [];
    const requiredCapabilities: string[] = [];
    const ontologyKeywords: string[] = [];

    // Temperature related
    if (query.includes('temperature') || query.includes('temp')) {
      keywords.push('temperature');
      requiredCapabilities.push('temperature-sensor', 'read-temperature');
      ontologyKeywords.push('temperature');
    }

    // Humidity related
    if (query.includes('humidity')) {
      keywords.push('humidity');
      requiredCapabilities.push('humidity-sensor', 'read-humidity');
      ontologyKeywords.push('humidity');
    }

    // HVAC related
    if (query.includes('hvac') || query.includes('climate') || query.includes('heating') || query.includes('cooling')) {
      keywords.push('hvac', 'climate');
      requiredCapabilities.push('hvac-control');
      ontologyKeywords.push('hvac');
    }

    // Control vs observe
    if (query.includes('control') || query.includes('set') || query.includes('adjust') || query.includes('turn')) {
      keywords.push('control'); // Add control to keywords for peer service matching
      requiredCapabilities.push('control', 'actuation');
      ontologyKeywords.push('actuation');
    }

    if (query.includes('monitor') || query.includes('read') || query.includes('check') || query.includes('what is')) {
      requiredCapabilities.push('monitoring', 'sensing');
      ontologyKeywords.push('sensing');
    }

    // Also add help/who keywords for peer service queries
    if (query.includes('help') || query.includes('who can')) {
      keywords.push('help');
    }

    return { requiredCapabilities, keywords, ontologyKeywords };
  }

  private extractLocation(query: string): string | null {
    // Common location patterns
    const locationPatterns = [
      /in\s+(?:the\s+)?(\w+(?:-\w+)*)/i,
      /at\s+(?:the\s+)?(\w+(?:-\w+)*)/i,
      /for\s+(?:the\s+)?(\w+(?:-\w+)*)/i,
    ];

    for (const pattern of locationPatterns) {
      const match = query.match(pattern);
      if (match) {
        return match[1].toLowerCase();
      }
    }

    return null;
  }

  private checkSpatialMatch(
    spatialContext: ResourceOntology['spatialContext'],
    targetLocation: string | null
  ): boolean {
    if (!targetLocation || !spatialContext) {
      return true; // No location constraint
    }

    const location = spatialContext.location?.toLowerCase();
    const zone = spatialContext.zone?.toLowerCase();
    const coverage = spatialContext.coverage?.map(c => c.toLowerCase()) || [];

    return (
      location === targetLocation ||
      zone === targetLocation ||
      coverage.includes(targetLocation)
    );
  }

  private checkCapabilityMatch(
    available: string[],
    required: string[]
  ): boolean {
    if (required.length === 0) {
      return true; // No specific capability required
    }

    const availableLower = available.map(a => a.toLowerCase());

    return required.some(req =>
      availableLower.some(avail =>
        avail.includes(req.toLowerCase()) ||
        req.toLowerCase().includes(avail)
      )
    );
  }

  private checkOntologyClassMatch(
    ontologyClass: string,
    keywords: string[]
  ): boolean {
    if (keywords.length === 0) {
      return true;
    }

    const classLower = ontologyClass.toLowerCase();
    return keywords.some(k => classLower.includes(k.toLowerCase()));
  }

  private generateInternalReasoning(
    canHandle: boolean,
    matchingResources: InternalReasoningResult['matchingResources'],
    missingCapabilities: string[],
    targetLocation: string | null
  ): string {
    const parts: string[] = [];

    if (canHandle) {
      parts.push(`Can handle the request.`);
      parts.push(`Matching resources: ${matchingResources.map(r => r.name).join(', ')}`);
    } else {
      parts.push(`Cannot fully handle the request.`);
      if (missingCapabilities.length > 0) {
        parts.push(`Missing capabilities: ${missingCapabilities.join(', ')}`);
      }
    }

    if (targetLocation) {
      parts.push(`Target location: ${targetLocation}`);
    }

    return parts.join(' ');
  }

  private generateCombinedReasoning(
    internal: InternalReasoningResult,
    external: PeerServiceReasoningResult,
    strategy: CombinedReasoningResult['recommendedStrategy']
  ): string {
    const parts: string[] = [];

    parts.push(`Recommended strategy: ${strategy}`);

    if (internal.canHandle) {
      parts.push(`Internal: ${internal.reasoning}`);
    }

    if (external.canCollaborate) {
      parts.push(`External: ${external.reasoning}`);
    }

    return parts.join('. ');
  }

  private mapResourceToServiceOntologyClass(
    resourceClass: string
  ): ServiceOntologyClass {
    const classLower = resourceClass.toLowerCase();

    // SSN mappings
    if (classLower.includes('temperature') && classLower.includes('sensor')) {
      return ServiceOntologyClass.SSN_TEMPERATURE_SERVICE;
    }
    if (classLower.includes('humidity') && classLower.includes('sensor')) {
      return ServiceOntologyClass.SSN_HUMIDITY_SERVICE;
    }
    if (classLower.includes('pressure') && classLower.includes('sensor')) {
      return ServiceOntologyClass.SSN_PRESSURE_SERVICE;
    }
    if (classLower.includes('presence') || classLower.includes('motion')) {
      return ServiceOntologyClass.SSN_PRESENCE_SERVICE;
    }

    // SAREF mappings
    if (classLower.includes('hvac')) {
      return ServiceOntologyClass.SAREF_HVAC_SERVICE;
    }
    if (classLower.includes('temperature') && classLower.includes('actuator')) {
      return ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE;
    }
    if (classLower.includes('light')) {
      return ServiceOntologyClass.SAREF_LIGHTING_SERVICE;
    }
    if (classLower.includes('security')) {
      return ServiceOntologyClass.SAREF_SECURITY_SERVICE;
    }

    // Default
    if (classLower.includes('sensor') || classLower.startsWith('ssn:')) {
      return ServiceOntologyClass.SSN_SENSING_SERVICE;
    }
    if (classLower.includes('actuator') || classLower.startsWith('saref:')) {
      return ServiceOntologyClass.SAREF_ACTUATION_SERVICE;
    }

    return ServiceOntologyClass.IOT_MONITORING_SERVICE;
  }
}

export default OntologyReasoningEngine;
