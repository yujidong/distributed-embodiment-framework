/**
 * Service Validator Module
 *
 * Formal validation and verification for service requests, contracts, and responses.
 * Ensures type safety and correctness of service-based collaboration.
 */

import type {
  CollaborationServiceQuery,
  ServiceOffer,
  ServiceRequest,
  ServiceContract,
  ServiceResponse,
  ContractTerms,
  ServiceConstraints,
  ServiceLevelAgreement,
} from './ServiceRequest.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ServiceValidator');

/**
 * Validation result
 */


export interface ServiceValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Service Validator
 * Performs formal validation and verification of service artifacts
 */
export class ServiceValidator {
  /**
   * Validate a service query
   */
  validateQuery(query: CollaborationServiceQuery): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate service type
    if (!query.serviceType || query.serviceType.trim().length === 0) {
      errors.push('serviceType is required and cannot be empty');
    }

    // Validate required capabilities
    // Allow empty capabilities for wildcard searches ('all' or 'any')
    const isWildcardSearch = query.serviceType === 'all' || query.serviceType === 'any';
    if (!isWildcardSearch && (!query.requiredCapabilities || query.requiredCapabilities.length === 0)) {
      errors.push('requiredCapabilities must have at least one capability');
    }

    // Validate constraints
    if (query.constraints) {
      const constraintResult = this.validateConstraints(query.constraints);
      errors.push(...constraintResult.errors);
      warnings.push(...constraintResult.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate service constraints
   */
  validateConstraints(constraints: ServiceConstraints): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (constraints.maxLatency !== undefined && constraints.maxLatency < 0) {
      errors.push('maxLatency must be non-negative');
    }

    if (constraints.minAvailability !== undefined) {
      if (constraints.minAvailability < 0 || constraints.minAvailability > 1) {
        errors.push('minAvailability must be between 0 and 1');
      }
    }

    if (constraints.maxCost !== undefined && constraints.maxCost < 0) {
      errors.push('maxCost must be non-negative');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a service offer
   */
  validateOffer(offer: ServiceOffer): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!offer.providerId || offer.providerId.trim().length === 0) {
      errors.push('providerId is required');
    }

    if (!offer.serviceId || offer.serviceId.trim().length === 0) {
      errors.push('serviceId is required');
    }

    if (!offer.serviceType || offer.serviceType.trim().length === 0) {
      errors.push('serviceType is required');
    }

    if (!offer.capabilities || offer.capabilities.length === 0) {
      errors.push('capabilities must have at least one capability');
    }

    // Validate numeric constraints
    if (offer.estimatedLatency !== undefined && offer.estimatedLatency < 0) {
      errors.push('estimatedLatency must be non-negative');
    }

    if (offer.estimatedCost !== undefined && offer.estimatedCost < 0) {
      errors.push('estimatedCost must be non-negative');
    }

    if (offer.availability !== undefined && (offer.availability < 0 || offer.availability > 1)) {
      errors.push('availability must be between 0 and 1');
    }

    // Validate SLA if provided
    if (offer.sla) {
      const slaResult = this.validateSLA(offer.sla);
      errors.push(...slaResult.errors);
      warnings.push(...slaResult.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate service level agreement
   */
  validateSLA(sla: ServiceLevelAgreement): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (sla.uptime < 0 || sla.uptime > 1) {
      errors.push('uptime must be between 0 and 1');
    }

    if (sla.uptime < 0.9) {
      warnings.push(`uptime is ${sla.uptime}, which is below recommended 0.9`);
    }

    if (sla.responseTime < 0) {
      errors.push('responseTime must be non-negative');
    }

    if (sla.responseTime > 10000) {
      warnings.push(`responseTime is ${sla.responseTime}ms, which is above recommended 10000ms`);
    }

    if (sla.throughput !== undefined && sla.throughput <= 0) {
      errors.push('throughput must be positive');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a service request
   */
  validateRequest(request: ServiceRequest): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!request.requestId || request.requestId.trim().length === 0) {
      errors.push('requestId is required');
    }

    if (!request.requesterId || request.requesterId.trim().length === 0) {
      errors.push('requesterId is required');
    }

    if (!request.providerId || request.providerId.trim().length === 0) {
      errors.push('providerId is required');
    }

    if (!request.serviceId || request.serviceId.trim().length === 0) {
      errors.push('serviceId is required');
    }

    // Validate query
    const queryResult = this.validateQuery(request.query);
    errors.push(...queryResult.errors);
    warnings.push(...queryResult.warnings);

    // Validate state
    const validStates = ['pending', 'accepted', 'rejected', 'active', 'completed', 'failed', 'expired'];
    if (!validStates.includes(request.state)) {
      errors.push(`Invalid state: ${request.state}`);
    }

    // Validate timestamps
    if (request.expiresAt && request.expiresAt <= request.requestedAt) {
      errors.push('expiresAt must be after requestedAt');
    }

    // Validate contract if present
    if (request.contract) {
      const contractResult = this.validateContract(request.contract);
      errors.push(...contractResult.errors);
      warnings.push(...contractResult.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate contract terms
   */
  validateContractTerms(terms: ContractTerms): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (terms.duration !== undefined && terms.duration <= 0) {
      errors.push('duration must be positive');
    }

    if (terms.maxRequests !== undefined && terms.maxRequests <= 0) {
      errors.push('maxRequests must be positive');
    }

    if (terms.costPerRequest !== undefined && terms.costPerRequest < 0) {
      errors.push('costPerRequest must be non-negative');
    }

    // Validate SLA
    const slaResult = this.validateSLA(terms.sla);
    errors.push(...slaResult.errors);
    warnings.push(...slaResult.warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a service contract
   */
  validateContract(contract: ServiceContract): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!contract.contractId || contract.contractId.trim().length === 0) {
      errors.push('contractId is required');
    }

    if (!contract.providerId || contract.providerId.trim().length === 0) {
      errors.push('providerId is required');
    }

    if (!contract.consumerId || contract.consumerId.trim().length === 0) {
      errors.push('consumerId is required');
    }

    if (!contract.serviceId || contract.serviceId.trim().length === 0) {
      errors.push('serviceId is required');
    }

    // Validate state
    const validStates = ['negotiating', 'active', 'suspended', 'terminated', 'expired'];
    if (!validStates.includes(contract.state)) {
      errors.push(`Invalid contract state: ${contract.state}`);
    }

    // Validate timestamps
    if (contract.activatedAt && contract.activatedAt <= contract.createdAt) {
      errors.push('activatedAt must be after createdAt');
    }

    if (contract.expiresAt && contract.createdAt >= contract.expiresAt) {
      errors.push('expiresAt must be after createdAt');
    }

    // Validate terms
    const termsResult = this.validateContractTerms(contract.terms);
    errors.push(...termsResult.errors);
    warnings.push(...termsResult.warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate a service response
   */
  validateResponse(response: ServiceResponse): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!response.responseId || response.responseId.trim().length === 0) {
      errors.push('responseId is required');
    }

    if (!response.requestId || response.requestId.trim().length === 0) {
      errors.push('requestId is required');
    }

    if (!response.providerId || response.providerId.trim().length === 0) {
      errors.push('providerId is required');
    }

    if (!response.message || response.message.trim().length === 0) {
      errors.push('message is required');
    }

    // Validate decision
    const validDecisions = ['accept', 'reject', 'counter'];
    if (!validDecisions.includes(response.decision)) {
      errors.push(`Invalid decision: ${response.decision}`);
    }

    // If decision is 'counter', counterTerms must be provided
    if (response.decision === 'counter' && !response.counterTerms) {
      errors.push('counterTerms must be provided when decision is "counter"');
    }

    // Validate counter terms if provided
    if (response.counterTerms) {
      const termsResult = this.validateContractTerms(response.counterTerms);
      errors.push(...termsResult.errors);
      warnings.push(...termsResult.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Verify that a service offer matches a query
   */
  verifyOfferMatchesQuery(offer: ServiceOffer, query: CollaborationServiceQuery): ServiceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check service type match (allow 'all' or 'any' wildcards)
    const isWildcardQuery = query.serviceType === 'all' || query.serviceType === 'any';
    if (!isWildcardQuery && offer.serviceType !== query.serviceType) {
      // ENHANCED: Use intelligent matching instead of strict equality

      // Extract entity and category from serviceType
      // Format: usually "entity-category" or "category-entity"
      const queryEntity = this.extractEntity(query.serviceType);
      const queryCategory = this.extractCategory(query.serviceType);
      const offerEntity = this.extractEntity(offer.serviceType);
      const offerCategory = this.extractCategory(offer.serviceType);

      logger.info(`Matching query="${query.serviceType}" (entity=${queryEntity}, category=${queryCategory}) vs offer="${offer.serviceType}" (entity=${offerEntity}, category=${offerCategory})`);

      // Check category match (fuzzy)
      const categoryMatches = this.fuzzyMatch(queryCategory, offerCategory);

      // Check entity match (fuzzy)
      const entityMatches = queryEntity && offerEntity ?
        this.fuzzyMatch(queryEntity, offerEntity) :
        true; // If no entity specified, don't filter on entity

      // Check capability match
      const capabilitiesMatch = query.requiredCapabilities.some(reqCap =>
        offer.capabilities.some(offCap =>
          offCap.toLowerCase().includes(reqCap.toLowerCase()) ||
          reqCap.toLowerCase().includes(offCap.toLowerCase())
        )
      );

      // Check description match
      const descriptionMatches = offer.serviceDescription &&
        (offer.serviceDescription.toLowerCase().includes(queryEntity?.toLowerCase() || '') ||
         offer.serviceDescription.toLowerCase().includes(queryCategory?.toLowerCase() || ''));

      // Combined match logic
      const intelligentMatch = categoryMatches && (entityMatches || capabilitiesMatch || descriptionMatches);

      if (!intelligentMatch) {
        errors.push(`Service type mismatch: offer is ${offer.serviceType}, query requires ${query.serviceType}`);
        logger.info(`Match failed: categoryMatches=${categoryMatches}, entityMatches=${entityMatches}, capabilitiesMatch=${capabilitiesMatch}, descriptionMatches=${descriptionMatches}`);
      } else {
        logger.info(`Intelligent match SUCCESS for ${offer.serviceName}`);
        warnings.push(`Service matched via intelligent matching: ${offer.serviceType} ~ ${query.serviceType}`);
      }
    }

    // Check required capabilities (skip for wildcard queries with no requirements)
    if (!isWildcardQuery || query.requiredCapabilities.length > 0) {
      // ENHANCED: Use comprehensive capability matching with semantic awareness
      const missingCapabilities = query.requiredCapabilities.filter(req => {
        // Use the enhanced capability matching
        if (this.matchesCapability(req, offer.capabilities)) {
          return false;
        }

        // Also check service name and description for capability hints
        const nameMatch = offer.serviceName && this.matchesCapability(req, [offer.serviceName]);
        const descMatch = offer.serviceDescription && this.matchesCapability(req, [offer.serviceDescription]);

        return !(nameMatch || descMatch);
      });

      if (missingCapabilities.length > 0) {
        // Log detailed information about why matching failed
        logger.info(`Capability matching details:`);
        logger.info(`  Required: ${missingCapabilities.join(', ')}`);
        logger.info(`  Offer capabilities: ${offer.capabilities.join(', ')}`);
        logger.info(`  Service name: ${offer.serviceName}`);

        errors.push(`Missing capabilities: ${missingCapabilities.join(', ')}`);
      } else {
        logger.info(`All required capabilities matched for ${offer.serviceName}`);
      }
    }

    // Check constraints
    if (query.constraints) {
      if (query.constraints.maxLatency && offer.estimatedLatency) {
        if (offer.estimatedLatency > query.constraints.maxLatency) {
          errors.push(`Latency constraint violated: ${offer.estimatedLatency}ms > ${query.constraints.maxLatency}ms`);
        }
      }

      if (query.constraints.minAvailability && offer.availability) {
        if (offer.availability < query.constraints.minAvailability) {
          errors.push(`Availability constraint violated: ${offer.availability} < ${query.constraints.minAvailability}`);
        }
      }

      if (query.constraints.maxCost && offer.estimatedCost) {
        if (offer.estimatedCost > query.constraints.maxCost) {
          errors.push(`Cost constraint violated: ${offer.estimatedCost} > ${query.constraints.maxCost}`);
        }
      }

      // Check allowed providers
      if (query.constraints.allowedProviders && query.constraints.allowedProviders.length > 0) {
        if (!query.constraints.allowedProviders.includes(offer.providerId)) {
          errors.push(`Provider ${offer.providerId} is not in allowed list`);
        }
      }

      // Check excluded providers
      if (query.constraints.excludedProviders && query.constraints.excludedProviders.includes(offer.providerId)) {
        errors.push(`Provider ${offer.providerId} is in excluded list`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Extract entity from service type (e.g., "temperature-control" -> "temperature")
   */
  private extractEntity(serviceType: string): string | null {
    if (!serviceType) return null;
    const parts = serviceType.split('-');
    if (parts.length >= 2) {
      // First part is usually entity
      return parts[0];
    }
    return null;
  }

  /**
   * Extract category from service type (e.g., "temperature-control" -> "control")
   */
  private extractCategory(serviceType: string): string | null {
    if (!serviceType) return null;
    const parts = serviceType.split('-');
    if (parts.length >= 2) {
      // Last part is usually category
      return parts[parts.length - 1];
    }
    return serviceType;
  }

  /**
   * Fuzzy string matching
   */
  private fuzzyMatch(str1: string | null, str2: string | null): boolean {
    if (!str1 || !str2) return false;

    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    // Exact match
    if (s1 === s2) return true;

    // Contains match
    if (s1.includes(s2) || s2.includes(s1)) return true;

    // Stem match (e.g., "monitoring" ~= "monitor")
    const stem1 = s1.replace(/(ing|ly|ed|es|s)$/, '');
    const stem2 = s2.replace(/(ing|ly|ed|es|s)$/, '');
    if (stem1 === stem2) return true;

    return false;
  }

  /**
   * Semantic capability mappings
   * Maps related concepts that should be considered equivalent
   */
  private getSemanticMappings(): Map<string, Set<string>> {
    const mappings = new Map<string, Set<string>>();

    // Temperature-related capabilities
    mappings.set('temperature', new Set(['temperature', 'hvac', 'thermostat', 'climate', 'heating', 'cooling', 'ac', 'temp']));
    mappings.set('monitoring', new Set(['monitoring', 'sensing', 'observing', 'reading', 'tracking', 'measure', 'sensor']));
    mappings.set('control', new Set(['control', 'actuation', 'adjust', 'regulate', 'manage', 'operate']));
    mappings.set('cooling', new Set(['cooling', 'hvac', 'ac', 'air-conditioning', 'temperature-control', 'refrigeration']));
    mappings.set('heating', new Set(['heating', 'hvac', 'temperature-control', 'heater', 'warmer']));

    return mappings;
  }

  /**
   * Check if two capabilities are semantically equivalent
   */
  private areCapabilitiesSemanticallyEquivalent(cap1: string, cap2: string): boolean {
    const c1 = cap1.toLowerCase().replace(/[-_]/g, '');
    const c2 = cap2.toLowerCase().replace(/[-_]/g, '');

    // Direct substring match
    if (c1.includes(c2) || c2.includes(c1)) {
      return true;
    }

    // Check semantic mappings
    const mappings = this.getSemanticMappings();

    for (const [_key, equivalents] of mappings) {
      const hasCap1 = Array.from(equivalents).some(e => c1.includes(e.replace(/[-_]/g, '')));
      const hasCap2 = Array.from(equivalents).some(e => c2.includes(e.replace(/[-_]/g, '')));

      if (hasCap1 && hasCap2) {
        logger.info(`Semantic match: '${cap1}' ~= '${cap2}'`);
        return true;
      }
    }

    return false;
  }

  /**
   * Enhanced capability matching with partial and semantic matching
   * Returns true if the required capability is satisfied by any offer capability
   */
  private matchesCapability(requiredCap: string, offerCapabilities: string[]): boolean {
    const reqLower = requiredCap.toLowerCase();

    for (const offerCap of offerCapabilities) {
      const offLower = offerCap.toLowerCase();

      // Exact match
      if (reqLower === offLower) {
        return true;
      }

      // Substring match (bidirectional)
      if (reqLower.includes(offLower) || offLower.includes(reqLower)) {
        return true;
      }

      // Semantic equivalence
      if (this.areCapabilitiesSemanticallyEquivalent(requiredCap, offerCap)) {
        return true;
      }

      // Word-level matching (e.g., 'temperature-monitoring' contains both 'temperature' and 'monitoring')
      const reqWords = reqLower.split(/[-_\s]+/);
      const offWords = offLower.split(/[-_\s]+/);

      // Check if all required words are present in offer
      const allReqWordsPresent = reqWords.every(rw =>
        offWords.some(ow => ow.includes(rw) || rw.includes(ow)) ||
        this.areCapabilitiesSemanticallyEquivalent(rw, offLower)
      );

      if (allReqWordsPresent) {
        return true;
      }

      // Check if any offer word matches required capability semantically
      const anyOffWordMatches = offWords.some(ow =>
        this.areCapabilitiesSemanticallyEquivalent(ow, reqLower)
      );

      if (anyOffWordMatches) {
        return true;
      }
    }

    return false;
  }
}
