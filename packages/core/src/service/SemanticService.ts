/**
 * Semantic Service Extension
 *
 * Extends base AgentService with semantic annotations for Active Collaboration Theory (ACT)
 * Enables ontology-based service discovery and LLM-enhanced semantic reasoning
 *
 * Active Collaboration Theory - Core Property 2: Semantic Self-Awareness
 * - Agents understand own capabilities semantically
 * - Agents understand others' capabilities semantically
 * - Enable semantic matching (not just interface matching)
 *
 * Extended with Service Ontology as per ARCHITECTURE.md
 * Section: Resource-Service Ontology Architecture
 */

import type { AgentService } from './Service.js';

/**
 * Service Type enum
 *
 * Defines the four types of services as per ARCHITECTURE.md:
 * - pure-logic: No resource dependencies, pure computation/logic
 * - resource-backed: Single or multiple resources backing the service
 * - composite: Combines resources and services
 * - external: Calls third-party APIs
 */
export enum ServiceType {
  PURE_LOGIC = 'pure-logic',
  RESOURCE_BACKED = 'resource-backed',
  COMPOSITE = 'composite',
  EXTERNAL = 'external',
}

/**
 * Ontology classes for service semantic annotation
 * Based on standard IoT ontologies: SSN (Semantic Sensor Network) and SAREF (Smart Appliances REFerence)
 */
export enum ServiceOntologyClass {
  // SSN Ontology - Sensing capabilities
  SSN_SENSING_SERVICE = 'ssn:SensingService',
  SSN_TEMPERATURE_SERVICE = 'ssn:TemperatureObservation',
  SSN_HUMIDITY_SERVICE = 'ssn:HumidityObservation',
  SSN_PRESSURE_SERVICE = 'ssn:PressureObservation',
  SSN_PRESENCE_SERVICE = 'ssn:PresenceObservation',

  // SAREF Ontology - Actuation capabilities
  SAREF_ACTUATION_SERVICE = 'saref:ActuationService',
  SAREF_TEMPERATURE_SERVICE = 'saref:TemperatureService',
  SAREF_LIGHTING_SERVICE = 'saref:LightingService',
  SAREF_HVAC_SERVICE = 'saref:HvacService',
  SAREF_SECURITY_SERVICE = 'saref:SecurityService',
  SAREF_ENERGY_SERVICE = 'saref:EnergyService',

  // Custom IoT service extensions
  IOT_COMPOSITE_SERVICE = 'iot:CompositeService',
  IOT_MONITORING_SERVICE = 'iot:MonitoringService',
  IOT_CONTROL_SERVICE = 'iot:ControlService',
  IOT_ANALYTICS_SERVICE = 'iot:AnalyticsService',
  IOT_EMERGENCY_SERVICE = 'iot:EmergencyService',
}

/**
 * Semantic annotation types
 */
export enum SemanticAnnotationType {
  // RDF/OWL standard annotation types
  RDF_TYPE = 'rdf:type',
  RDFS_LABEL = 'rdfs:label',
  RDFS_COMMENT = 'rdfs:comment',
  OWL_EQUIVALENT_CLASS = 'owl:equivalentClass',
  OWL_DISJOINT_WITH = 'owl:disjointWith',

  // Domain-specific annotations
  CAPABILITY = 'iot:capability',
  CONTEXT = 'iot:context',
  CONSTRAINT = 'iot:constraint',
  DEPENDENCY = 'iot:dependency',
  COMPOSITION = 'iot:composition',
}

/**
 * Service relationship types for knowledge graph
 * Defines how services can relate to each other semantically
 */
export enum ServiceRelationshipType {
  // Composition relationships
  COMPOSED_OF = 'composedOf', // Service A is composed of Service B
  COMPOSES_WITH = 'composesWith', // Service A composes with Service B
  SEQUENCE = 'sequence', // Service A must execute before Service B
  PARALLEL = 'parallel', // Service A can execute in parallel with Service B

  // Dependency relationships
  REQUIRES = 'requires', // Service A requires Service B
  PROVIDES = 'provides', // Service A provides input for Service B
  EXCLUDES = 'excludes', // Service A excludes Service B (mutex)

  // Semantic similarity relationships
  SEMANTICALLY_SIMILAR = 'semanticallySimilar',
  FUNCTIONALLY_EQUIVALENT = 'functionallyEquivalent',
  SPECIALIZATION_OF = 'specializationOf',
  GENERALIZATION_OF = 'generalizationOf',

  // Spatial/Contextual relationships
  LOCATED_NEAR = 'locatedNear',
  SERVES_SAME_LOCATION = 'servesSameLocation',
  SHARES_CONTEXT = 'sharesContext',
}

/**
 * Service relationship definition
 * Represents semantic connections between services
 */
export interface ServiceRelationship {
  id: string;
  sourceServiceId: string;
  targetServiceId: string;
  relationshipType: ServiceRelationshipType;
  strength?: number; // 0-1, confidence or strength of relationship
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

/**
 * QoS (Quality of Service) properties
 * Essential for TSC: service quality metrics
 */
export interface QoSProperties {
  // Response time metrics
  responseTime?: {
    average: number; // milliseconds
    min: number;
    max: number;
    p95?: number; // 95th percentile
    p99?: number; // 99th percentile
  };

  // Reliability metrics
  reliability?: {
    availability: number; // 0-1, uptime percentage
    successRate: number; // 0-1, successful executions / total
    meanTimeBetweenFailures?: number; // milliseconds
    meanTimeToRecovery?: number; // milliseconds
  };

  // Performance metrics
  performance?: {
    throughput?: number; // requests per second
    latency?: number; // milliseconds
    capacity?: number; // max concurrent requests
  };

  // Resource usage
  resources?: {
    cpu?: number; // percentage
    memory?: number; // MB
    bandwidth?: number; // Mbps
  };

  // Cost and priority
  cost?: {
    executionCost?: number; // arbitrary units
    resourceCost?: number;
  };

  priority?: number; // 1-10, higher = more important

  // Service-level agreement parameters
  sla?: {
    guaranteedResponseTime?: number; // milliseconds
    maxResponseTime?: number; // milliseconds
    penalty?: number; // for SLA violation
  };
}

/**
 * Semantic service annotation
 * RDF/OWL-style semantic metadata
 */
export interface SemanticAnnotation {
  annotationType: SemanticAnnotationType;
  value: string;
  language?: string; // e.g., "en" for English
  datatype?: string; // XML datatype for typed literals
  metadata?: Record<string, unknown>;
}

/**
 * Service context information
 * Provides situational awareness for Active Collaboration
 */
export interface ServiceContext {
  location?: string; // Physical or logical location
  timeContext?: {
    validFrom?: Date;
    validTo?: Date;
    operatingHours?: { start: string; end: string }[];
  };
  environmentalContext?: {
    temperature?: { min: number; max: number; unit: string };
    humidity?: { min: number; max: number; unit: string };
    otherConditions?: Record<string, any>;
  };
  userContext?: {
    userRoles?: string[];
    userPreferences?: Record<string, any>;
  };
  organizationalContext?: {
    owner?: string;
    department?: string;
    accessControl?: string[];
  };
}

/**
 * Semantic Service interface
 * Extends AgentService with semantic capabilities
 *
 * Active Collaboration Theory - Key Innovation:
 * - Services have semantic self-awareness (understand own capabilities semantically)
 * - Services can discover each other through semantic matching (not interface matching)
 * - Services can anticipate collaboration needs through semantic reasoning
 */
export interface SemanticService extends AgentService {
  // ---------- Core Semantic Properties ----------

  /**
   * Primary ontology class for this service
   * Determines which ontology (SSN, SAREF, custom) the service belongs to
   */
  ontologyClass: ServiceOntologyClass;

  /**
   * RDF/OWL semantic annotations
   * Provides rich semantic metadata about the service
   */
  semanticAnnotations: Map<SemanticAnnotationType, SemanticAnnotation>;

  /**
   * Semantic relationships to other services
   * Enables knowledge graph-based service discovery and composition
   */
  serviceRelationships: ServiceRelationship[];

  // ---------- QoS Properties (for TSC) ----------

  /**
   * Quality of Service properties
   * Essential for service selection and SLA management
   */
  qosProperties?: QoSProperties;

  // ---------- Contextual Properties ----------

  /**
   * Service context information
   * Enables context-aware service composition
   */
  context?: ServiceContext;

  // ---------- Active Collaboration Properties ----------

  /**
   * Collaboration history
   * Tracks past collaborations for learning and optimization
   */
  collaborationHistory?: {
    collaborations: number;
    successRate: number;
    averageResponseTime: number;
    preferredPartners: string[]; // Service IDs
    avoidedPartners: string[]; // Service IDs
  };

  /**
   * Active collaboration capability
   * Indicates service's ability to proactively form collaborations
   */
  activeCollaborationCapability?: {
    proactivity: number; // 0-1, how proactive this service is
    semanticAwareness: number; // 0-1, depth of semantic understanding
    adaptability: number; // 0-1, ability to adapt to context
  };
}

// ============================================================================
// Extended Service Ontology (as per ARCHITECTURE.md Section: Resource-Service Ontology)
// ============================================================================

/**
 * Service dependency definition
 * Describes what a service depends on (resources, other services, external APIs)
 */
export interface ServiceDependency {
  /** Type of dependency: resource, service, or external */
  type: 'resource' | 'service' | 'external';
  /** ID of the dependency */
  id: string;
  /** Required capabilities from this dependency */
  requiredCapabilities?: string[];
  /** Whether this dependency is optional */
  optional?: boolean;
  /** Additional metadata about the dependency */
  metadata?: Record<string, unknown>;
}

/**
 * Service spatial context with source information
 * Describes where the service operates and how the location is derived
 */
export interface ServiceSpatialContext {
  /** Logical location name (e.g., "living-room") */
  location?: string;
  /** Zones this service covers */
  zones?: string[];
  /** Source of spatial context: inherited from resource, composite from multiple, or none */
  source: 'inherited' | 'composite' | 'none';
  /** Optional position coordinates */
  position?: { x: number; y: number; z: number };
  /** Coverage areas */
  coverage?: string[];
}

/**
 * Service semantic context with business description
 * Provides business-level understanding of the service
 */
export interface ServiceSemanticContext {
  /** Business-level description of what the service does */
  businessDescription: string;
  /** Scenarios where this service is applicable */
  applicableScenarios: string[];
  /** Hints for collaboration with other services */
  collaborationHints: string[];
}

/**
 * Business capability parameter definition
 */
export interface BusinessCapabilityParameter {
  /** Parameter name */
  name: string;
  /** Parameter type */
  type: string;
  /** Optional unit (e.g., "celsius", "percentage") */
  unit?: string;
  /** Optional description */
  description?: string;
  /** Whether this parameter is required */
  required?: boolean;
}

/**
 * Business capability definition
 * Describes what the service provides from a business perspective
 */
export interface BusinessCapability {
  /** Name of the business capability */
  name: string;
  /** Description of the capability */
  description: string;
  /** Input parameters */
  inputs: BusinessCapabilityParameter[];
  /** Output parameters */
  outputs: BusinessCapabilityParameter[];
  /** Service guarantees (SLA-like promises) */
  guarantees?: string[];
  /** Preconditions for using this capability */
  preconditions?: string[];
  /** Postconditions after using this capability */
  postconditions?: string[];
}

/**
 * Extended Service Ontology Interface
 *
 * Complete service ontology definition as per ARCHITECTURE.md
 * Section: Resource-Service Ontology Architecture
 *
 * This extends the basic service ontology with:
 * 1. serviceType: pure-logic, resource-backed, composite, external
 * 2. dependencies: what the service depends on
 * 3. spatialContext: location with source information
 * 4. semanticContext: business description
 * 5. businessCapability: inputs, outputs, guarantees
 */
export interface ServiceOntology {
  /** Service type classification */
  serviceType: ServiceType;
  /** Ontology class (SSN/SAREF based) */
  ontologyClass: ServiceOntologyClass;
  /** Business capability this service provides */
  businessCapability: BusinessCapability;
  /** Dependencies this service has */
  dependencies: ServiceDependency[];
  /** Spatial context with source information */
  spatialContext: ServiceSpatialContext;
  /** Semantic context with business description */
  semanticContext: ServiceSemanticContext;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Semantic Service Filter
 * Extends basic service filter with semantic criteria
 */
export interface SemanticServiceFilter {
  // Basic filters (from existing ServiceFilter)
  category?: string;
  location?: string;
  available?: boolean;
  owner?: string;

  // Semantic filters
  ontologyClass?: ServiceOntologyClass;
  semanticCapability?: string; // Semantic capability description
  qosRequirements?: {
    maxResponseTime?: number;
    minAvailability?: number;
    minSuccessRate?: number;
  };
  contextRequirements?: {
    location?: string;
    timeOfDay?: string;
    userRole?: string;
  };
}

/**
 * Helper function to create a SemanticService from base AgentService
 */
export function createSemanticService(
  baseService: AgentService,
  ontologyClass: ServiceOntologyClass,
  options?: {
    semanticAnnotations?: Map<SemanticAnnotationType, SemanticAnnotation>;
    serviceRelationships?: ServiceRelationship[];
    qosProperties?: QoSProperties;
    context?: ServiceContext;
  }
): SemanticService {
  // Create a proper object that preserves prototype methods
  const semanticService: SemanticService = Object.create(baseService);

  // Add semantic properties
  semanticService.ontologyClass = ontologyClass;
  semanticService.semanticAnnotations = options?.semanticAnnotations || new Map();
  semanticService.serviceRelationships = options?.serviceRelationships || [];
  semanticService.qosProperties = options?.qosProperties;
  semanticService.context = options?.context;

  return semanticService;
}

/**
 * Helper function to add semantic annotation
 */
export function addSemanticAnnotation(
  service: SemanticService,
  annotationType: SemanticAnnotationType,
  value: string,
  metadata?: Record<string, any>
): void {
  service.semanticAnnotations.set(annotationType, {
    annotationType,
    value,
    language: 'en',
    metadata,
  });
}

/**
 * Helper function to add service relationship
 */
export function addServiceRelationship(
  service: SemanticService,
  targetServiceId: string,
  relationshipType: ServiceRelationshipType,
  strength?: number,
  metadata?: Record<string, any>
): void {
  const relationship: ServiceRelationship = {
    id: `rel_${service.id}_${targetServiceId}_${Date.now()}`,
    sourceServiceId: service.id,
    targetServiceId,
    relationshipType,
    strength,
    metadata,
    timestamp: new Date(),
  };

  service.serviceRelationships.push(relationship);
}

/**
 * Helper function to check semantic compatibility
 * Determines if two services can collaborate based on semantic annotations
 */
export function checkSemanticCompatibility(
  service1: SemanticService,
  service2: SemanticService
): {
    compatible: boolean;
    compatibilityScore: number; // 0-1
    reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0.5; // Start with neutral compatibility

  // Check ontology compatibility
  const s1Class = service1.ontologyClass;
  const s2Class = service2.ontologyClass;

  // Sensing + Actuation = Highly compatible
  if (
    (s1Class.startsWith('ssn:') && s2Class.startsWith('saref:')) ||
    (s2Class.startsWith('ssn:') && s1Class.startsWith('saref:'))
  ) {
    score += 0.3;
    reasons.push('Sensing-actuation complementarity');
  }

  // Same category = Medium compatibility
  if (s1Class === s2Class) {
    score -= 0.1;
    reasons.push('Same ontology class (redundancy)');
  }

  // Check location compatibility
  if (service1.location === service2.location) {
    score += 0.2;
    reasons.push('Same location (easier coordination)');
  }

  // Check QoS compatibility
  if (service1.qosProperties && service2.qosProperties) {
    // Check if response times are compatible
    if (
      service1.qosProperties.responseTime &&
      service2.qosProperties.responseTime
    ) {
      const avg1 = service1.qosProperties.responseTime.average;
      const avg2 = service2.qosProperties.responseTime.average;

      // Similar response times = Good compatibility
      if (Math.abs(avg1 - avg2) < avg1 * 0.2) {
        score += 0.1;
        reasons.push('Compatible response times');
      }
    }
  }

  // Normalize score to 0-1 range
  score = Math.max(0, Math.min(1, score));

  return {
    compatible: score > 0.5,
    compatibilityScore: score,
    reasons,
  };
}

/**
 * Helper function to get semantic description
 * Generates human-readable semantic description for LLM prompts
 */
export function getSemanticDescription(service: SemanticService): string {
  const parts: string[] = [];

  // Ontology class
  parts.push(`Ontology: ${service.ontologyClass}`);

  // Category and location
  parts.push(`Category: ${service.category}`);
  parts.push(`Location: ${service.location}`);

  // Capabilities from semantic annotations
  const capabilityAnnotation = service.semanticAnnotations.get(
    SemanticAnnotationType.CAPABILITY
  );
  if (capabilityAnnotation) {
    parts.push(`Capability: ${capabilityAnnotation.value}`);
  }

  // Context information
  if (service.context?.location) {
    parts.push(`Context: ${service.context.location}`);
  }

  // Relationships
  if (service.serviceRelationships.length > 0) {
    parts.push(
      `Related services: ${service.serviceRelationships.length} connections`
    );
  }

  // QoS information
  if (service.qosProperties?.responseTime) {
    parts.push(
      `Avg response time: ${service.qosProperties.responseTime.average}ms`
    );
  }

  if (service.qosProperties?.reliability) {
    parts.push(
      `Availability: ${(service.qosProperties.reliability.availability * 100).toFixed(1)}%`
    );
  }

  return parts.join(' | ');
}

/**
 * Get business capability specification for LLM consumption
 *
 * Generates a comprehensive business capability description that includes:
 * 1. Service type (pure-logic, resource-backed, composite, external)
 * 2. Business capability name and description
 * 3. Dependencies (resources, services, external APIs)
 * 4. Spatial context (location, zones, source)
 * 5. Semantic context (business description, scenarios, collaboration hints)
 * 6. Guarantees (SLA-like promises)
 *
 * @param ontology - The service ontology to describe
 * @returns Human-readable business capability specification for LLM prompts
 */
export function getBusinessCapabilitySpec(ontology: Partial<ServiceOntology>): string {
  const parts: string[] = [];

  // Service type
  if (ontology.serviceType) {
    parts.push(`Service Type: ${ontology.serviceType}`);
  }

  // Business capability
  if (ontology.businessCapability) {
    const cap = ontology.businessCapability;
    parts.push(`Business Capability: ${cap.name}`);
    parts.push(`Description: ${cap.description}`);

    // Inputs
    if (cap.inputs && cap.inputs.length > 0) {
      const inputStrs = cap.inputs.map(i => {
        let str = `${i.name} (${i.type}`;
        if (i.unit) str += `, ${i.unit}`;
        str += ')';
        return str;
      });
      parts.push(`Inputs: ${inputStrs.join(', ')}`);
    }

    // Outputs
    if (cap.outputs && cap.outputs.length > 0) {
      const outputStrs = cap.outputs.map(o => {
        let str = `${o.name} (${o.type}`;
        if (o.unit) str += `, ${o.unit}`;
        str += ')';
        return str;
      });
      parts.push(`Outputs: ${outputStrs.join(', ')}`);
    }

    // Guarantees
    if (cap.guarantees && cap.guarantees.length > 0) {
      parts.push(`Guarantees: ${cap.guarantees.join(', ')}`);
    }
  }

  // Dependencies
  if (ontology.dependencies && ontology.dependencies.length > 0) {
    const depStrs = ontology.dependencies.map(d => {
      let str = `${d.type}:${d.id}`;
      if (d.requiredCapabilities && d.requiredCapabilities.length > 0) {
        str += ` [${d.requiredCapabilities.join(', ')}]`;
      }
      if (d.optional) str += ' (optional)';
      return str;
    });
    parts.push(`Dependencies: ${depStrs.join(', ')}`);
  }

  // Spatial context
  if (ontology.spatialContext) {
    const spatial = ontology.spatialContext;
    if (spatial.location) {
      parts.push(`Location: ${spatial.location}`);
    }
    if (spatial.zones && spatial.zones.length > 0) {
      parts.push(`Zones: ${spatial.zones.join(', ')}`);
    }
    parts.push(`Spatial Source: ${spatial.source}`);
  }

  // Semantic context
  if (ontology.semanticContext) {
    const semantic = ontology.semanticContext;
    parts.push(`Business Description: ${semantic.businessDescription}`);

    if (semantic.applicableScenarios && semantic.applicableScenarios.length > 0) {
      parts.push(`Applicable Scenarios: ${semantic.applicableScenarios.join(', ')}`);
    }

    if (semantic.collaborationHints && semantic.collaborationHints.length > 0) {
      parts.push(`Collaboration Hints: ${semantic.collaborationHints.join('; ')}`);
    }
  }

  // Ontology class
  if (ontology.ontologyClass) {
    parts.push(`Ontology Class: ${ontology.ontologyClass}`);
  }

  return parts.join('\n');
}

/**
 * Derive service ontology from resource ontology
 *
 * Creates a service ontology from a resource ontology for resource-backed services.
 * The service inherits spatial context and some capabilities from the resource.
 *
 * @param resourceOntology - The resource ontology to derive from
 * @param serviceOntologyClass - The target service ontology class
 * @param options - Additional options for derivation
 * @returns Derived service ontology
 */
export function deriveServiceOntologyFromResource(
  resourceOntology: {
    ontologyClass?: string;
    spatialContext?: {
      location?: string;
      zone?: string;
      position?: { x: number; y: number; z: number };
      coverage?: string[];
    };
    rawCapabilities?: Array<{ name: string; type: string; description?: string }>;
    semanticDescription?: {
      what?: string;
      purpose?: string;
      constraints?: string[];
    };
  },
  serviceOntologyClass: ServiceOntologyClass,
  options?: {
    serviceName?: string;
    serviceDescription?: string;
    additionalDependencies?: ServiceDependency[];
  }
): ServiceOntology {
  // Map resource ontology class to service type
  const isSensing = resourceOntology.ontologyClass?.startsWith?.('ssn:');
  const serviceType = isSensing ? ServiceType.RESOURCE_BACKED : ServiceType.RESOURCE_BACKED;

  // Inherit spatial context from resource
  const spatialContext: ServiceSpatialContext = {
    location: resourceOntology.spatialContext?.location,
    zones: resourceOntology.spatialContext?.zone
      ? [resourceOntology.spatialContext.zone]
      : [],
    source: 'inherited',
    position: resourceOntology.spatialContext?.position,
    coverage: resourceOntology.spatialContext?.coverage,
  };

  // Map resource capabilities to business capability
  const inputs: BusinessCapabilityParameter[] = [];
  const outputs: BusinessCapabilityParameter[] = [];

  if (resourceOntology.rawCapabilities) {
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
      }
    }
  }

  const businessCapability: BusinessCapability = {
    name: options?.serviceName || resourceOntology.semanticDescription?.what || 'Resource Service',
    description: options?.serviceDescription ||
      resourceOntology.semanticDescription?.purpose ||
      'Service derived from resource',
    inputs,
    outputs,
    guarantees: resourceOntology.semanticDescription?.constraints || [],
  };

  // Create semantic context
  const semanticContext: ServiceSemanticContext = {
    businessDescription: resourceOntology.semanticDescription?.purpose || '',
    applicableScenarios: [],
    collaborationHints: [],
  };

  // Create dependency on the resource
  const dependencies: ServiceDependency[] = [
    {
      type: 'resource',
      id: 'resource-id', // Should be provided by caller
      requiredCapabilities: resourceOntology.rawCapabilities?.map((c: Record<string, unknown>) => c.name as string) || [],
    },
    ...(options?.additionalDependencies || []),
  ];

  return {
    serviceType,
    ontologyClass: serviceOntologyClass,
    businessCapability,
    dependencies,
    spatialContext,
    semanticContext,
  };
}
