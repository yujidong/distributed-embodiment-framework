/**
 * Resource Interface
 *
 * Base abstraction for all controllable entities in the system
 * Resources are the fundamental unit that Cognitive Agents work with
 *
 * Extended with Resource Ontology for semantic understanding as per ARCHITECTURE.md
 * Section: Resource-Service Ontology Architecture
 */

import type { DeviceLocation } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Resource state
 */
const logger = createLogger('Resource');

export interface ResourceState {
  [key: string]: any;
}

/**
 * Resource Ontology Class (SSN/SAREF based)
 *
 * Based on standard IoT ontologies:
 * - SSN: Semantic Sensor Network ontology for sensing capabilities
 * - SAREF: Smart Appliances REFerence ontology for actuation capabilities
 * - IOT: Custom extensions for composite/hybrid resources
 */
export enum ResourceOntologyClass {
  // SSN Ontology - Sensing capabilities
  SSN_SENSOR = 'ssn:Sensor',
  SSN_TEMPERATURE_SENSOR = 'ssn:TemperatureSensor',
  SSN_HUMIDITY_SENSOR = 'ssn:HumiditySensor',
  SSN_PRESSURE_SENSOR = 'ssn:PressureSensor',
  SSN_PRESENCE_SENSOR = 'ssn:PresenceSensor',
  SSN_MOTION_SENSOR = 'ssn:MotionSensor',
  SSN_LIGHT_SENSOR = 'ssn:LightSensor',
  SSN_AIR_QUALITY_SENSOR = 'ssn:AirQualitySensor',
  SSN_ENERGY_SENSOR = 'ssn:EnergySensor',

  // SAREF Ontology - Actuation capabilities
  SAREF_ACTUATOR = 'saref:Actuator',
  SAREF_TEMPERATURE_ACTUATOR = 'saref:TemperatureActuator',
  SAREF_HVAC = 'saref:HVAC',
  SAREF_LIGHTING = 'saref:Lighting',
  SAREF_SECURITY = 'saref:Security',
  SAREF_ENERGY = 'saref:Energy',
  SAREF_LOCK = 'saref:Lock',
  SAREF_SWITCH = 'saref:Switch',

  // Custom IoT extensions
  IOT_COMPOSITE = 'iot:CompositeResource',
  IOT_CONTROLLER = 'iot:Controller',
  IOT_HYBRID = 'iot:HybridResource',
  IOT_EXTERNAL = 'iot:ExternalResource',
  IOT_SERVICE = 'iot:ServiceResource',
}

/**
 * Semantic description for resource ontology
 * Describes what the resource is, its purpose, and constraints
 */
export interface ResourceSemanticDescription {
  /** What the resource is (e.g., "Temperature Sensor") */
  what: string;
  /** Purpose of the resource (e.g., "Monitor ambient temperature") */
  purpose: string;
  /** Constraints or limitations (e.g., ["Accuracy: +/-0.5C", "Range: -20~50C"]) */
  constraints: string[];
}

/**
 * Spatial context for resource ontology
 * Describes the physical location and spatial coverage of the resource
 */
export interface ResourceSpatialContext {
  /** Logical location name (e.g., "living-room", "lab-a") */
  location: string;
  /** Optional 3D position coordinates */
  position?: { x: number; y: number; z: number };
  /** Zone identifier for grouping */
  zone?: string;
  /** Coverage areas - which locations this resource can affect/monitor */
  coverage?: string[];
}

/**
 * Temporal context for resource ontology
 * Describes time-related properties of the resource
 */
export interface ResourceTemporalContext {
  /** Update interval in milliseconds for sensor readings */
  updateInterval?: number;
  /** When this resource became valid */
  validFrom?: Date;
  /** When this resource expires or becomes invalid */
  validUntil?: Date;
  /** Operating hours if applicable */
  operatingHours?: { start: string; end: string }[];
}

/**
 * Raw capability definition for resource ontology
 */
export interface ResourceRawCapability {
  /** Name of the capability */
  name: string;
  /** Type: read (sensor), write (actuator), or execute (action) */
  type: 'read' | 'write' | 'execute';
  /** Optional description of the capability */
  description?: string;
  /** Optional parameters for the capability */
  parameters?: Array<{
    name: string;
    type: string;
    required?: boolean;
  }>;
}

/**
 * Resource Ontology Interface
 *
 * Complete ontology definition for a resource as per ARCHITECTURE.md
 * Provides semantic understanding for agent reasoning
 */
export interface ResourceOntology {
  /** Ontology classification (SSN/SAREF based) */
  ontologyClass: ResourceOntologyClass;
  /** Semantic description of what, purpose, and constraints */
  semanticDescription: ResourceSemanticDescription;
  /** Spatial context - location, position, coverage */
  spatialContext: ResourceSpatialContext;
  /** Optional temporal context - timing, validity */
  temporalContext?: ResourceTemporalContext;
  /** Raw capabilities this resource provides */
  rawCapabilities: ResourceRawCapability[];
  /** Optional metadata for extended information */
  metadata?: Record<string, any>;
}

/**
 * Resource capability
 */
export interface ResourceCapability {
  name: string;
  type: string;
  description?: string;
  parameters?: any[];
}

/**
 * Resource metadata
 */
export interface ResourceMetadata {
  id: string;
  name: string;
  type: string;
  location: DeviceLocation;
  category: string;
  tags: string[];
  owner: string;
}

/**
 * Base Resource interface
 * All resources (devices, services, etc.) implement this interface
 *
 * Extended with optional ontology property for semantic reasoning
 */
export interface Resource {
  /**
   * Unique resource identifier
   */
  readonly id: string;

  /**
   * Human-readable resource name
   */
  name: string;

  /**
   * Resource type (e.g., 'device', 'service', 'composite')
   */
  readonly type: string;

  /**
   * Resource location (e.g., 'living-room', 'entrance')
   */
  location: DeviceLocation;

  /**
   * Resource category (e.g., 'sensor', 'actuator', 'controller')
   */
  readonly category: string;

  /**
   * Resource tags for discovery and filtering
   */
  tags: string[];

  /**
   * Resource owner (user ID)
   */
  readonly owner: string;

  /**
   * Optional Resource Ontology for semantic understanding
   * Provides rich semantic context for agent reasoning
   */
  ontology?: ResourceOntology;

  /**
   * Current resource state
   */
  getState(): ResourceState;

  /**
   * Get resource capabilities
   */
  getCapabilities(): ResourceCapability[];

  /**
   * Get resource metadata
   */
  getMetadata(): ResourceMetadata;

  /**
   * Execute a resource capability
   * @param capabilityName - Name of capability to execute
   * @param params - Execution parameters
   * @returns Execution result
   */
  execute(capabilityName: string, params?: any): Promise<ResourceExecutionResult>;

  /**
   * Check if resource is available
   */
  isAvailable(): boolean;

  /**
   * Get resource specification for LLM
   * Returns a structured description that LLMs can understand
   */
  getLLMSpec(): string;

  /**
   * Get ontology specification for LLM consumption
   * Returns semantic description including ontology class, capabilities, and spatial context
   */
  getOntologySpec(): string;
}

/**
 * Resource execution result
 */
export interface ResourceExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  timestamp: Date;
}

/**
 * Resource allocation status
 */
export enum ResourceAllocationStatus {
  AVAILABLE = 'available',
  ALLOCATED = 'allocated',
  BUSY = 'busy',
  ERROR = 'error',
}

/**
 * Resource allocation info
 */
export interface ResourceAllocation {
  resourceId: string;
  allocatedTo: string; // Agent ID or user ID
  status: ResourceAllocationStatus;
  allocatedAt?: Date;
  expiresAt?: Date;
  exclusive: boolean; // If true, no one else can use simultaneously
}

/**
 * Base resource class
 * Provides common functionality for all resources
 *
 * Extended with ontology support for semantic reasoning
 */
export abstract class BaseResource implements Resource {
  public readonly id: string;
  public name: string;
  public readonly type: string;
  public location: DeviceLocation;
  public readonly category: string;
  public tags: string[];
  public readonly owner: string;
  protected readonly capabilities: ResourceCapability[];

  /**
   * Optional Resource Ontology for semantic understanding
   */
  public ontology?: ResourceOntology;

  constructor(config: {
    id: string;
    name: string;
    type: string;
    location: DeviceLocation;
    category: string;
    capabilities: ResourceCapability[];
    owner: string;
    tags?: string[];
    ontology?: ResourceOntology;
  }) {
    logger.info(`[BaseResource:${config.id}] Initializing resource: ${config.name}`);

    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.location = config.location;
    this.category = config.category;
    this.capabilities = config.capabilities;
    this.owner = config.owner;
    this.tags = config.tags || [];
    this.ontology = config.ontology;

    logger.info(`[BaseResource:${this.id}] Resource initialized`);
  }

  abstract getState(): ResourceState;

  getCapabilities(): ResourceCapability[] {
    return [...this.capabilities];
  }

  getMetadata(): ResourceMetadata {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      location: this.location,
      category: this.category,
      tags: this.tags,
      owner: this.owner,
    };
  }

  abstract execute(capabilityName: string, params?: any): Promise<ResourceExecutionResult>;

  isAvailable(): boolean {
    // Base implementation - subclasses can override
    return true;
  }

  getLLMSpec(): string {
    const state = this.getState();
    const caps = this.getCapabilities()
      .map((c) => `  - ${c.name}: ${c.description || c.type}`)
      .join('\n');

    return `Resource: ${this.name} (${this.id})
Type: ${this.type}
Category: ${this.category}
Location: ${this.location}
Tags: ${this.tags.join(', ')}

Capabilities:
${caps}

Current State:
${JSON.stringify(state, null, 2)}`;
  }

  /**
   * Get ontology specification for LLM consumption
   * Returns semantic description including ontology class, capabilities, and spatial context
   *
   * This method provides rich semantic information that enables:
   * 1. Internal reasoning: Agent understands its own capabilities
   * 2. External collaboration: Other agents can understand what this resource offers
   * 3. Cross-layer reasoning: Combined resource-service reasoning
   */
  getOntologySpec(): string {
    if (!this.ontology) {
      // Return basic spec if no ontology is defined
      return this.getBasicOntologySpec();
    }

    const parts: string[] = [];

    // Resource identification
    parts.push(`Resource: ${this.name} (${this.id})`);

    // Ontology class
    parts.push(`Ontology Class: ${this.ontology.ontologyClass}`);

    // Semantic description
    parts.push(`What: ${this.ontology.semanticDescription.what}`);
    parts.push(`Purpose: ${this.ontology.semanticDescription.purpose}`);

    if (this.ontology.semanticDescription.constraints.length > 0) {
      parts.push(`Constraints: ${this.ontology.semanticDescription.constraints.join(', ')}`);
    }

    // Spatial context
    const spatial = this.ontology.spatialContext;
    parts.push(`Location: ${spatial.location}`);
    if (spatial.position) {
      parts.push(`Position: (${spatial.position.x}, ${spatial.position.y}, ${spatial.position.z})`);
    }
    if (spatial.zone) {
      parts.push(`Zone: ${spatial.zone}`);
    }
    if (spatial.coverage && spatial.coverage.length > 0) {
      parts.push(`Coverage: ${spatial.coverage.join(', ')}`);
    }

    // Temporal context (if available)
    if (this.ontology.temporalContext) {
      const temporal = this.ontology.temporalContext;
      if (temporal.updateInterval) {
        parts.push(`Update Interval: ${temporal.updateInterval}ms`);
      }
      if (temporal.validFrom && temporal.validUntil) {
        parts.push(`Valid: ${temporal.validFrom.toISOString()} - ${temporal.validUntil.toISOString()}`);
      }
    }

    // Raw capabilities
    if (this.ontology.rawCapabilities.length > 0) {
      const capStrs = this.ontology.rawCapabilities.map(
        cap => `${cap.name} (${cap.type})`
      );
      parts.push(`Capabilities: ${capStrs.join(', ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Get basic ontology spec when no formal ontology is defined
   * Infers ontology information from resource properties
   */
  private getBasicOntologySpec(): string {
    const parts: string[] = [];

    parts.push(`Resource: ${this.name} (${this.id})`);
    parts.push(`Type: ${this.type}`);
    parts.push(`Category: ${this.category}`);

    // Infer location string
    const locationStr = typeof this.location === 'string'
      ? this.location
      : (this.location as unknown as { path?: string }).path || 'unknown';
    parts.push(`Location: ${locationStr}`);

    // List capabilities
    const caps = this.getCapabilities();
    if (caps.length > 0) {
      const capStrs = caps.map(c => `${c.name} (${c.type})`);
      parts.push(`Capabilities: ${capStrs.join(', ')}`);
    }

    return parts.join('\n');
  }
}
