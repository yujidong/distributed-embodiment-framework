/**
 * Semantic Requirement Matcher
 *
 * Performs ontology-based semantic matching using SSN (Semantic Sensor Network)
 * and SAREF (Smart Appliances REFerence) standards.
 *
 * Matching Capabilities:
 * - Ontology class matching (SSN/SAREF)
 * - Capability semantic equivalence
 * - Synonym and alternative term matching
 * - Hierarchical relationship matching (subClassOf, partOf)
 */

import type {
  SemanticRequirement,
  SemanticCapability,
  SemanticMatchResult,
  ONTOLOGY_CLASSES,
  ServiceOntologyClass
} from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('SemanticRequirementMatcher');

/**
 * Semantic Requirement Matcher class
 * Matches services to requirements using ontology-based semantic analysis
 */


export class SemanticRequirementMatcher {
  // Capability synonym mappings for fuzzy matching
  private capabilitySynonyms: Map<string, string[]>;
  // Ontology hierarchy mappings (simplified)
  private ontologyHierarchy: Map<string, string[]>;

  constructor() {
    this.capabilitySynonyms = new Map(this.initializeSynonyms());
    this.ontologyHierarchy = new Map(this.initializeHierarchy());
    logger.info('Initialized with ontology mappings');
  }

  /**
   * Match a service's capabilities against semantic requirements
   *
   * @param serviceCapabilities - Service capabilities
   * @param serviceOntologyClass - Service ontology class
   * @param requirement - Semantic requirement to match against
   * @returns Semantic match result with detailed analysis
   */
  matchRequirements(
    serviceCapabilities: string[],
    serviceOntologyClass: string,
    requirement: SemanticRequirement
  ): SemanticMatchResult {
    logger.info(`Matching service ${serviceOntologyClass} against requirement ${requirement.ontologyClass}`);

    // 1. Check ontology class compatibility
    const ontologyMatch = this.matchOntologyClass(serviceOntologyClass, requirement.ontologyClass);
    if (!ontologyMatch.matches) {
      return {
        matches: false,
        score: 0,
        matchedCapabilities: [],
        missingCapabilities: requirement.semanticCapabilities.map(c => c.capability),
        partialMatches: [],
        confidence: 0,
        suggestion: `Service ontology class '${serviceOntologyClass}' does not match requirement '${requirement.ontologyClass}'`
      };
    }

    // 2. Match semantic capabilities
    const capabilityMatch = this.matchCapabilities(serviceCapabilities, requirement.semanticCapabilities);

    // 3. Check semantic relationships
    const relationshipScore = this.matchRelationships(requirement);

    // 4. Calculate overall score
    const overallScore = this.calculateOverallScore(ontologyMatch.score, capabilityMatch.score, relationshipScore);

    // 5. Determine if match is successful
    const matches = capabilityMatch.matchedCapabilities.length > 0 &&
                   capabilityMatch.missingCapabilities.filter(c => c.critical).length === 0;

    return {
      matches,
      score: overallScore,
      matchedCapabilities: capabilityMatch.matchedCapabilities,
      missingCapabilities: capabilityMatch.missingCapabilities.map(c => c.capability),
      partialMatches: capabilityMatch.partialMatches,
      confidence: this.calculateConfidence(ontologyMatch.score, capabilityMatch.score),
      suggestion: this.generateSuggestion(capabilityMatch, requirement)
    };
  }

  /**
   * Match ontology classes using hierarchy and equivalence
   *
   * @param serviceClass - Service ontology class
   * @param requirementClass - Required ontology class
   * @returns Ontology match result
   */
  private matchOntologyClass(serviceClass: string, requirementClass: string): { matches: boolean; score: number } {
    // Exact match
    if (serviceClass === requirementClass) {
      return { matches: true, score: 1.0 };
    }

    // Check hierarchy (subClassOf relationships)
    if (this.isSubClassOf(serviceClass, requirementClass)) {
      return { matches: true, score: 0.9 };
    }

    // Check if classes are compatible (e.g., both sensing)
    const serviceCategory = this.getOntologyCategory(serviceClass);
    const requirementCategory = this.getOntologyCategory(requirementClass);

    if (serviceCategory === requirementCategory) {
      return { matches: true, score: 0.7 };
    }

    return { matches: false, score: 0 };
  }

  /**
   * Match capabilities against semantic requirements
   *
   * @param serviceCapabilities - Service capabilities
   * @param requiredCapabilities - Required semantic capabilities
   * @returns Capability match result
   */
  private matchCapabilities(
    serviceCapabilities: string[],
    requiredCapabilities: SemanticCapability[]
  ): {
    matchedCapabilities: string[];
    missingCapabilities: Array<{ capability: string; critical: boolean }>;
    partialMatches: Array<{ capability: string; similarity: number; suggestion?: string }>;
    score: number;
  } {
    const matchedCapabilities: string[] = [];
    const missingCapabilities: Array<{ capability: string; critical: boolean }> = [];
    const partialMatches: Array<{ capability: string; similarity: number; suggestion?: string }> = [];

    for (const requiredCap of requiredCapabilities) {
      let matched = false;

      // Direct match
      if (serviceCapabilities.includes(requiredCap.capability)) {
        matchedCapabilities.push(requiredCap.capability);
        matched = true;
        continue;
      }

      // Synonym match
      const synonyms = this.capabilitySynonyms.get(requiredCap.capability) || [];
      for (const synonym of synonyms) {
        if (serviceCapabilities.includes(synonym)) {
          matchedCapabilities.push(requiredCap.capability);
          matched = true;
          break;
        }
      }

      if (matched) continue;

      // Fuzzy match (string similarity)
      let bestMatch = '';
      let bestSimilarity = 0;

      for (const serviceCap of serviceCapabilities) {
        const similarity = this.stringSimilarity(requiredCap.capability, serviceCap);
        if (similarity > bestSimilarity && similarity > 0.6) {
          bestSimilarity = similarity;
          bestMatch = serviceCap;
        }
      }

      if (bestMatch) {
        partialMatches.push({
          capability: requiredCap.capability,
          similarity: bestSimilarity,
          suggestion: `Consider using capability '${bestMatch}' as alternative to '${requiredCap.capability}'`
        });
      } else {
        // Check if capability is critical
        missingCapabilities.push({
          capability: requiredCap.capability,
          critical: requiredCap.category === 'sensing' || requiredCap.category === 'acting'
        });
      }
    }

    // Calculate score
    const totalRequired = requiredCapabilities.length;
    const matched = matchedCapabilities.length;
    const partialScore = partialMatches.reduce((sum, p) => sum + p.similarity, 0);
    const score = totalRequired > 0 ? (matched + partialScore) / totalRequired : 1.0;

    return {
      matchedCapabilities,
      missingCapabilities,
      partialMatches,
      score
    };
  }

  /**
   * Match semantic relationships
   *
   * @param requirement - Semantic requirement with relationships
   * @returns Relationship match score (0-1)
   */
  private matchRelationships(requirement: SemanticRequirement): number {
    if (!requirement.relationships || requirement.relationships.length === 0) {
      return 1.0;
    }

    // For now, return 1.0 (relationship matching would require service graph)
    // In production, this would check if related services exist
    return 1.0;
  }

  /**
   * Calculate overall semantic score
   *
   * @param ontologyScore - Ontology class match score
   * @param capabilityScore - Capability match score
   * @param relationshipScore - Relationship match score
   * @returns Overall score (0-1)
   */
  private calculateOverallScore(
    ontologyScore: number,
    capabilityScore: number,
    relationshipScore: number
  ): number {
    // Weighted combination
    return (ontologyScore * 0.3 + capabilityScore * 0.6 + relationshipScore * 0.1);
  }

  /**
   * Calculate confidence in the match
   *
   * @param ontologyScore - Ontology match score
   * @param capabilityScore - Capability match score
   * @returns Confidence score (0-1)
   */
  private calculateConfidence(ontologyScore: number, capabilityScore: number): number {
    // Confidence is higher when both ontology and capabilities match well
    return (ontologyScore + capabilityScore) / 2;
  }

  /**
   * Generate suggestion for improving match
   *
   * @param capabilityMatch - Capability match result
   * @param requirement - Semantic requirement
   * @returns Suggestion string
   */
  private generateSuggestion(
    capabilityMatch: { missingCapabilities: Array<{ capability: string; critical: boolean }> },
    requirement: SemanticRequirement
  ): string | undefined {
    const criticalMissing = capabilityMatch.missingCapabilities.filter(c => c.critical);

    if (criticalMissing.length > 0) {
      return `Service missing critical capabilities: ${criticalMissing.map(c => c.capability).join(', ')}`;
    }

    return undefined;
  }

  /**
   * Check if class A is a subclass of class B
   *
   * @param classA - Potential subclass
   * @param classB - Potential superclass
   * @returns True if A is subclass of B
   */
  private isSubClassOf(classA: string, classB: string): boolean {
    const subclasses = this.ontologyHierarchy.get(classB) || [];
    return subclasses.includes(classA);
  }

  /**
   * Get ontology category (sensing, acting, etc.)
   *
   * @param ontologyClass - Ontology class
   * @returns Category string
   */
  private getOntologyCategory(ontologyClass: string): string {
    if (ontologyClass.includes('Sensing') || ontologyClass.includes('Sensor')) {
      return 'sensing';
    }
    if (ontologyClass.includes('Actuating') || ontologyClass.includes('Actuator')) {
      return 'acting';
    }
    if (ontologyClass.includes('Control') || ontologyClass.includes('HVAC')) {
      return 'control';
    }
    return 'other';
  }

  /**
   * Calculate string similarity using Jaro-Winkler distance
   *
   * @param s1 - First string
   * @param s2 - Second string
   * @returns Similarity score (0-1)
   */
  private stringSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;

    // Simple Levenshtein distance-based similarity
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
   *
   * @param s1 - First string
   * @param s2 - Second string
   * @returns Edit distance
   */
  private levenshteinDistance(s1: string, s2: string): number {
    const matrix = [];

    for (let i = 0; i <= s2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= s1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= s2.length; i++) {
      for (let j = 1; j <= s1.length; j++) {
        if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[s2.length][s1.length];
  }

  /**
   * Initialize capability synonym mappings
   *
   * @returns Array of [capability, synonyms[]] tuples
   */
  private initializeSynonyms(): [string, string[]][] {
    return [
      // Temperature-related
      ['read-temperature', ['get-temperature', 'measure-temperature', 'temperature-reading']],
      ['set-temperature', ['adjust-temperature', 'change-temperature', 'temperature-control']],

      // Humidity-related
      ['read-humidity', ['get-humidity', 'measure-humidity', 'humidity-reading']],
      ['set-humidity', ['adjust-humidity', 'change-humidity', 'humidity-control']],

      // Lighting-related
      ['turn-on-light', ['light-on', 'enable-light', 'switch-light']],
      ['turn-off-light', ['light-off', 'disable-light', 'switch-light']],

      // Air quality
      ['read-air-quality', ['measure-air-quality', 'air-quality-sensor', 'air-quality-reading']],

      // Motion-related
      ['detect-motion', ['motion-detection', 'motion-sensor', 'presence-detection']],
    ];
  }

  /**
   * Initialize ontology hierarchy
   *
   * @returns Array of [superclass, subclasses[]] tuples
   */
  private initializeHierarchy(): [string, string[]][] {
    return [
      // SSN hierarchy
      ['ssn:Sensing', ['ssn:Sensor', 'saref:TemperatureSensor', 'saref:HumiditySensor']],
      ['ssn:Actuating', ['ssn:Actuator', 'saref:SwitchActuator', 'saref:LightingActuator']],

      // SAREF hierarchy
      ['saref:Device', ['ssn:Sensor', 'ssn:Actuator', 'saref:TemperatureSensor', 'saref:HumiditySensor']],
      ['iot:TemperatureControl', ['saref:TemperatureSensor', 'saref:HVAC']],
      ['iot:HumidityControl', ['saref:HumiditySensor', 'saref:HVAC']],
    ];
  }
}
