/**
 * Service Ontology Mapping
 *
 * Maps IoT devices and capabilities to service ontology classes
 * Based on SSN (Semantic Sensor Network) and SAREF (Smart Appliances REFerence) ontologies
 *
 * Active Collaboration Theory - Enables:
 * - Semantic understanding of service capabilities
 * - Ontology-based service discovery and matching
 * - LLM-enhanced semantic reasoning for proactive collaboration
 */

import { Device, DeviceType } from '@active-collaboration/shared';
import { ServiceOntologyClass, SemanticService } from '../SemanticService.js';

/**
 * Device category to ontology class mapping
 */
export const DEVICE_CATEGORY_ONTOLOGY_MAP: Record<string, ServiceOntologyClass> = {
  // Temperature sensors
  'temperature': ServiceOntologyClass.SSN_TEMPERATURE_SERVICE,
  'temp': ServiceOntologyClass.SSN_TEMPERATURE_SERVICE,

  // Humidity sensors
  'humidity': ServiceOntologyClass.SSN_HUMIDITY_SERVICE,

  // Pressure sensors
  'pressure': ServiceOntologyClass.SSN_PRESSURE_SERVICE,

  // Presence/motion sensors
  'presence': ServiceOntologyClass.SSN_PRESENCE_SERVICE,
  'motion': ServiceOntologyClass.SSN_PRESENCE_SERVICE,
  'occupancy': ServiceOntologyClass.SSN_PRESENCE_SERVICE,

  // Lighting actuators
  'light': ServiceOntologyClass.SAREF_LIGHTING_SERVICE,
  'lighting': ServiceOntologyClass.SAREF_LIGHTING_SERVICE,
  'lamp': ServiceOntologyClass.SAREF_LIGHTING_SERVICE,
  'bulb': ServiceOntologyClass.SAREF_LIGHTING_SERVICE,

  // HVAC systems
  'hvac': ServiceOntologyClass.SAREF_HVAC_SERVICE,
  'thermostat': ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE,
  'air conditioner': ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE,
  'heater': ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE,
  'cooler': ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE,

  // Security systems
  'camera': ServiceOntologyClass.SAREF_SECURITY_SERVICE,
  'lock': ServiceOntologyClass.SAREF_SECURITY_SERVICE,
  'alarm': ServiceOntologyClass.SAREF_SECURITY_SERVICE,
  'sensor': ServiceOntologyClass.SSN_SENSING_SERVICE,
  'actuator': ServiceOntologyClass.SAREF_ACTUATION_SERVICE,
};

/**
 * Capability type to ontology class mapping
 */
export const CAPABILITY_ONTOLOGY_MAP: Record<string, ServiceOntologyClass> = {
  // Read capabilities (SSN - Sensing)
  'read temperature': ServiceOntologyClass.SSN_TEMPERATURE_SERVICE,
  'read humidity': ServiceOntologyClass.SSN_HUMIDITY_SERVICE,
  'read pressure': ServiceOntologyClass.SSN_PRESSURE_SERVICE,
  'read presence': ServiceOntologyClass.SSN_PRESENCE_SERVICE,
  'read motion': ServiceOntologyClass.SSN_PRESENCE_SERVICE,
  'read occupancy': ServiceOntologyClass.SSN_PRESENCE_SERVICE,

  // Write capabilities (SAREF - Actuation)
  'set temperature': ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE,
  'set lighting': ServiceOntologyClass.SAREF_LIGHTING_SERVICE,
  'turn on': ServiceOntologyClass.SAREF_ACTUATION_SERVICE,
  'turn off': ServiceOntologyClass.SAREF_ACTUATION_SERVICE,
  'lock': ServiceOntologyClass.SAREF_SECURITY_SERVICE,
  'unlock': ServiceOntologyClass.SAREF_SECURITY_SERVICE,
  'activate alarm': ServiceOntologyClass.SAREF_SECURITY_SERVICE,

  // Control capabilities
  'control': ServiceOntologyClass.SAREF_ACTUATION_SERVICE,
  'adjust': ServiceOntologyClass.SAREF_ACTUATION_SERVICE,
  'regulate': ServiceOntologyClass.SAREF_ACTUATION_SERVICE,
};

/**
 * Service Ontology Manager
 * Manages ontology mappings and provides utility functions
 */
export class ServiceOntologyManager {
  /**
   * Determine ontology class for a device
   * @param device - Device to classify
   * @returns Ontology class for the device
   */
  static getOntologyClassForDevice(device: Device): ServiceOntologyClass {
    // Check device type first
    if (device.type === DeviceType.SENSOR) {
      // For sensors, use SSN ontology
      // Check capabilities for specific service type
      for (const capability of device.capabilities) {
        const ontologyClass = this.getOntologyClassForCapability(
          capability.name
        );
        if (
          ontologyClass &&
          (ontologyClass.startsWith('ssn:') ||
          ontologyClass === ServiceOntologyClass.SSN_SENSING_SERVICE)
        ) {
          return ontologyClass;
        }
      }
      // Default to generic sensing service
      return ServiceOntologyClass.SSN_SENSING_SERVICE;
    }

    if (device.type === DeviceType.ACTUATOR) {
      // For actuators, use SAREF ontology
      for (const capability of device.capabilities) {
        const ontologyClass = this.getOntologyClassForCapability(
          capability.name
        );
        if (
          ontologyClass &&
          (ontologyClass.startsWith('saref:') ||
          ontologyClass === ServiceOntologyClass.SAREF_ACTUATION_SERVICE)
        ) {
          return ontologyClass;
        }
      }
      // Default to generic actuation service
      return ServiceOntologyClass.SAREF_ACTUATION_SERVICE;
    }

    // For controllers/hybrid, determine based on capabilities
    for (const capability of device.capabilities) {
      const ontologyClass = this.getOntologyClassForCapability(
        capability.name
      );
      if (ontologyClass) {
        return ontologyClass;
      }
    }

    // Default to generic IoT monitoring service
    return ServiceOntologyClass.IOT_MONITORING_SERVICE;
  }

  /**
   * Get ontology class for a specific capability
   * @param capabilityName - Name of the capability
   * @returns Ontology class if found
   */
  static getOntologyClassForCapability(
    capabilityName: string
  ): ServiceOntologyClass | null {
    const normalizedName = capabilityName.toLowerCase();

    // Check direct capability matches
    if (CAPABILITY_ONTOLOGY_MAP[normalizedName]) {
      return CAPABILITY_ONTOLOGY_MAP[normalizedName];
    }

    // Check for keyword matches
    for (const [keyword, ontologyClass] of Object.entries(
      DEVICE_CATEGORY_ONTOLOGY_MAP
    )) {
      if (normalizedName.includes(keyword)) {
        return ontologyClass;
      }
    }

    return null;
  }

  /**
   * Generate semantic description for a device
   * @param device - Device to describe
   * @returns Human-readable semantic description
   */
  static generateSemanticDescription(device: Device): string {
    const parts: string[] = [];

    // Device type and name
    parts.push(`${device.type}: ${device.name}`);

    // Capabilities
    const capabilityNames = device.capabilities.map((c) => c.name).join(', ');
    parts.push(`Capabilities: ${capabilityNames}`);

    // Location
    parts.push(`Location: ${device.location}`);

    // Status
    parts.push(`Status: ${device.status}`);

    return parts.join(' | ');
  }

  /**
   * Generate service description for LLM prompts
   * This is crucial for Active Collaboration - enables semantic reasoning
   * @param device - Device to describe as service
   * @returns Rich semantic description for LLM
   */
  static generateLLMServiceDescription(device: Device): {
    description: string;
    semanticContext: string;
    capabilities: string[];
    ontologyInfo: string;
  } {
    const ontologyClass = this.getOntologyClassForDevice(device);

    // Extract semantic information
    const isSensing = ontologyClass.startsWith('ssn:');
    const isActuation = ontologyClass.startsWith('saref:');

    // Build description
    const description = `${device.name} is a ${device.type} located in ${device.location} that provides ${device.capabilities.length} capabilities: ${device.capabilities.map((c) => c.name).join(', ')}.`;

    // Build semantic context
    const semanticContext = `This device belongs to the ${ontologyClass} ontology class, which ${isSensing ? 'provides sensing capabilities for monitoring environmental conditions' : isActuation ? 'provides actuation capabilities for controlling physical systems' : 'offers IoT functionality'}.`;

    // Extract capabilities
    const capabilities = device.capabilities.map((c) => {
      const ontologyClass = this.getOntologyClassForCapability(c.name);
      return `${c.name} (${c.type})${ontologyClass ? ` [${ontologyClass}]` : ''}`;
    });

    // Ontology information
    const ontologyInfo = `Ontology: ${ontologyClass} | Type: ${isSensing ? 'Sensing' : isActuation ? 'Actuation' : 'General'} | Status: ${device.status}`;

    return {
      description,
      semanticContext,
      capabilities,
      ontologyInfo,
    };
  }

  /**
   * Find semantically compatible services
   * Used for service discovery in Active Collaboration
   * @param service - Service to find compatible partners for
   * @param candidateServices - Potential partner services
   * @returns Compatible services with compatibility scores
   */
  static findSemanticallyCompatibleServices(
    service: SemanticService,
    candidateServices: SemanticService[]
  ): Array<{
    service: SemanticService;
    compatibilityScore: number;
    reasons: string[];
  }> {
    const compatible: Array<{
      service: SemanticService;
      compatibilityScore: number;
      reasons: string[];
    }> = [];

    for (const candidate of candidateServices) {
      // Skip self
      if (candidate.id === service.id) {
        continue;
      }

      // Check basic availability
      if (!candidate.isAvailable()) {
        continue;
      }

      // Calculate semantic compatibility
      const score = this.calculateSemanticCompatibility(service, candidate);

      // Only include reasonably compatible services
      if (score.compatibilityScore > 0.5) {
        compatible.push({
          service: candidate,
          compatibilityScore: score.compatibilityScore,
          reasons: score.reasons,
        });
      }
    }

    // Sort by compatibility score (descending)
    compatible.sort((a, b) => b.compatibilityScore - a.compatibilityScore);

    return compatible;
  }

  /**
   * Calculate semantic compatibility score between two services
   * @param service1 - First service
   * @param service2 - Second service
   * @returns Compatibility assessment
   */
  static calculateSemanticCompatibility(
    service1: SemanticService,
    service2: SemanticService
  ): {
    compatible: boolean;
    compatibilityScore: number;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let score = 0.5; // Start with neutral score

    // Check ontology complementarity
    const s1Class = service1.ontologyClass;
    const s2Class = service2.ontologyClass;

    // Sensing + Actuation = Highly complementary
    if (
      (s1Class.startsWith('ssn:') && s2Class.startsWith('saref:')) ||
      (s2Class.startsWith('ssn:') && s1Class.startsWith('saref:'))
    ) {
      score += 0.3;
      reasons.push('Sensing-actuation complementarity');
    }

    // Same ontology class = Some redundancy
    if (s1Class === s2Class) {
      score -= 0.1;
      reasons.push('Same ontology class (potential redundancy)');
    }

    // Check location compatibility
    if (service1.location === service2.location) {
      score += 0.2;
      reasons.push('Same location (easier coordination)');
    }

    // Check QoS compatibility if available
    if (service1.qosProperties && service2.qosProperties) {
      if (
        service1.qosProperties.responseTime &&
        service2.qosProperties.responseTime
      ) {
        const avg1 = service1.qosProperties.responseTime.average;
        const avg2 = service2.qosProperties.responseTime.average;

        if (Math.abs(avg1 - avg2) < avg1 * 0.2) {
          score += 0.1;
          reasons.push('Compatible response times');
        }
      }

      if (
        service1.qosProperties.reliability &&
        service2.qosProperties.reliability
      ) {
        const reliability1 = service1.qosProperties.reliability.availability;
        const reliability2 = service2.qosProperties.reliability.availability;

        // Both highly reliable = Good compatibility
        if (reliability1 > 0.9 && reliability2 > 0.9) {
          score += 0.1;
          reasons.push('Both highly reliable');
        }
      }
    }

    // Check category compatibility
    if (service1.category !== service2.category) {
      score += 0.05;
      reasons.push('Different categories (complementary)');
    }

    // Normalize to 0-1 range
    score = Math.max(0, Math.min(1, score));

    return {
      compatible: score > 0.5,
      compatibilityScore: score,
      reasons,
    };
  }

  /**
   * Get all ontology classes
   * @returns Array of all defined ontology classes
   */
  static getAllOntologyClasses(): ServiceOntologyClass[] {
    return Object.values(ServiceOntologyClass);
  }

  /**
   * Get ontology class by name
   * @param className - Name of the ontology class
   * @returns Ontology class if found
   */
  static getOntologyClassByName(
    className: string
  ): ServiceOntologyClass | undefined {
    return Object.values(ServiceOntologyClass).find((c) => c === className);
  }
}
