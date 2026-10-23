/**
 * Semantic Requirement Types
 *
 * Extends the requirement specification with ontology-based
 * semantic matching capabilities using SSN and SAREF standards.
 */

/**
 * Ontology class references based on SSN (Semantic Sensor Network)
 * and SAREF (Smart Appliances REFerence ontology)
 */
export const ONTOLOGY_CLASSES = {
  // SSN Ontology
  SSN: 'http://www.w3.org/ns/ssn/',
  SSN_SENSING: 'http://www.w3.org/ns/ssn/Sensing',
  SSN_ACTUATING: 'http://www.w3.org/ns/ssn/Actuating',
  SSN_OBSERVED_PROPERTY: 'http://www.w3.org/ns/ssn/ObservedProperty',
  SSN_SENSOR: 'http://www.w3.org/ns/ssn/Sensor',
  SSN_ACTUATOR: 'http://www.w3.org/ns/ssn/Actuator',
  SSN_SYSTEM: 'http://www.w3.org/ns/ssn/System',
  SSN_DEPLOYMENT: 'http://www.w3.org/ns/ssn/Deployment',

  // SAREF Ontology
  SAREF: 'https://w3id.org/saref#',
  SAREF_DEVICE: 'https://w3id.org/saref#Device',
  SAREF_TEMPERATURE_SENSOR: 'https://w3id.org/saref#TemperatureSensor',
  SAREF_HUMIDITY_SENSOR: 'https://w3id.org/saref#HumiditySensor',
  SAREF_ACTUATOR: 'https://w3id.org/saref#Actuator',
  SAREF_SWITCH_ACTUATOR: 'https://w3id.org/saref#SwitchActuator',
  SAREF_STATE: 'https://w3id.org/saref#State',
  SAREF_PROPERTY: 'https://w3id.org/saref#Property',
  SAREF_COMMAND: 'https://w3id.org/saref#Command',
  SAREF_MEASUREMENT: 'https://w3id.org/saref#Measurement',

  // IoT Domain Extensions
  IOT_CORE: 'https://w3id.org/iot/core#',
  IOT_SERVICE: 'https://w3id.org/iot/service#',
  IOT_CAPABILITY: 'https://w3id.org/iot/capability#',
} as const;

/**
 * Semantic annotation types for rich service descriptions
 */
export type SemanticAnnotationType =
  | 'ontology-class'
  | 'property-type'
  | 'unit-of-measure'
  | 'domain-context'
  | 'quality-attribute';

/**
 * Semantic annotation
 */
export interface SemanticAnnotation {
  type: SemanticAnnotationType;
  value: string;
  confidence?: number; // 0-1
  source?: string; // Ontology or standard reference
}

/**
 * Service ontology class (SSN/SAREF based)
 */
export type ServiceOntologyClass =
  // SSN classes
  | 'ssn:Sensing'
  | 'ssn:Actuating'
  | 'ssn:ObservedProperty'
  | 'ssn:Sensor'
  | 'ssn:Actuator'
  | 'ssn:System'
  // SAREF classes
  | 'saref:TemperatureSensor'
  | 'saref:HumiditySensor'
  | 'saref:SwitchActuator'
  | 'saref:LightingActuator'
  | 'saref:HVAC'
  | 'saref:Lock'
  // Domain-specific
  | 'iot:TemperatureControl'
  | 'iot:HumidityControl'
  | 'iot:AirQualityMonitoring'
  | 'iot:SecurityMonitoring';

/**
 * QoS Properties
 */
export interface QoSProperties {
  responseTime?: {
    min: number;
    max: number;
    preferred: number;
    unit: string;
  };
  availability?: {
    min: number; // 0-1
    preferred: number;
  };
  reliability?: {
    min: number; // 0-1
    preferred: number;
  };
  throughput?: {
    min: number;
    max: number;
    unit: string;
  };
  cost?: {
    max: number;
    preferred: number;
    currency?: string;
  };
}

/**
 * Semantic service context
 * Context information for semantic service descriptions
 */
export interface SemanticServiceContext {
  environmentType?: 'indoor' | 'outdoor' | 'mobile' | 'distributed';
  domain?: 'smart-home' | 'smart-building' | 'smart-city' | 'industrial';
  physicalLocation?: {
    coordinates?: { latitude: number; longitude: number };
    area?: string;
  };
  timeContext?: {
    validFrom?: Date;
    validUntil?: Date;
    operatingHours?: { start: string; end: string };
  };
}

/**
 * Service relationship
 */
export interface ServiceRelationship {
  type: ServiceRelationshipType;
  targetService: string;
  strength: number; // 0-1
  description?: string;
}

/**
 * Service relationship types
 */
export type ServiceRelationshipType =
  | 'composes'        // A composes B (A is part of B)
  | 'is-composed-by'   // A is composed by B (B is part of A)
  | 'precedes'         // A must execute before B
  | 'follows'         // A must execute after B
  | 'enables'         // A enables B to execute
  | 'requires'        // A requires B to execute
  | 'excludes'        // A excludes B (mutually exclusive)
  | 'complements'     // A complements B (enhances when together)
  | 'substitutes'      // A can substitute B
  | 'is-substituted-by'; // B can substitute A

/**
 * Semantic matching result
 */
export interface SemanticMatchResult {
  matches: boolean;
  score: number; // 0-1
  matchedCapabilities: string[];
  missingCapabilities: string[];
  partialMatches: Array<{
    capability: string;
    similarity: number;
    suggestion?: string;
  }>;
  confidence: number; // 0-1
  suggestion?: string;
}

/**
 * Ontology-based semantic matcher configuration
 */
export interface SemanticMatcherConfig {
  ontologyBase: string;
  enableFuzzyMatching: boolean;
  similarityThreshold: number; // 0-1
  useLLMForSemanticUnderstanding: boolean;
  cacheResults: boolean;
}

/**
 * Semantic compatibility matrix
 */
export interface SemanticCompatibilityMatrix {
  /**
   * Returns compatibility score between two service types
   */
  getCompatibility(serviceType1: string, serviceType2: string): number;

  /**
   * Check if two services can work together
   */
  areCompatible(serviceType1: string, serviceType2: string): boolean;

  /**
   * Find complementary services for a given service
   */
  findComplementary(serviceType: string): string[];
}

/**
 * Capability semantic mapping
 */
export interface CapabilitySemanticMapping {
  /**
   * Get canonical form of a capability
   */
  getCanonical(capability: string): string;

  /**
   * Get synonyms for a capability
   */
  getSynonyms(capability: string): string[];

  /**
   * Check if two capabilities are semantically equivalent
   */
  areEquivalent(cap1: string, cap2: string): boolean;

  /**
   * Calculate semantic similarity
   */
  similarity(cap1: string, cap2: string): number;
}

/**
 * Re-export types from requirement-spec
 */
export type {
  RequirementSpec,
  JSONSchema,
  TestCase,
  ValidationContext,
  ValidationResult,
  SemanticRequirement,
  SemanticCapability,
  SemanticRelationship,
} from './requirement-spec.js';
