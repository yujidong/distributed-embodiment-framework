/**
 * Environment Center type definitions
 */

import type { Device, Service, CognitiveAgent, CollaborationMessage } from '@active-collaboration/shared';
import type { CollaborationManager } from '../management/CollaborationManager.js';

/**
 * Environment Center - isolated deployment boundary
 * Now supports multi-user shared environments
 */
export interface EnvironmentCenterData {
  id: string;
  name: string;
  description?: string;
  environmentType?: 'shared' | 'private';
  visibility?: 'platform' | 'invite-only' | 'private';
  createdBy: string;
  accessConfig?: Record<string, any>;
  location?: string;
  createdAt: Date;
  updatedAt: Date;
  // Optional physical environment for simulation mode
  physicalEnvironment?: any; // PhysicalEnvironment from @active-collaboration/simulation
  // Optional collaboration manager for AC hosting
  collaborationManager?: CollaborationManager;
}

/**
 * Environment member (for multi-user environments)
 */
export interface EnvironmentMember {
  userId: string;
  role: 'admin' | 'member' | 'viewer';
  joinedAt: Date;
}

/**
 * Service query for discovery
 */
export interface ServiceQuery {
  type?: string;
  name?: string;
  capability?: string;
  deviceId?: string;
}

/**
 * Agent search criteria
 */
export interface AgentCriteria {
  status?: 'active' | 'inactive' | 'error';
  type?: string;
  capabilities?: string[];
  excludeIds?: string[];  // Agent IDs to exclude from results
}

/**
 * Message routing information
 */
export interface RouteInfo {
  fromCenterId: string;
  toCenterId: string;
  message: CollaborationMessage;
  timestamp: Date;
}

/**
 * Local discovery result
 */
export interface DiscoveryResult<T> {
  items: T[];
  centerId: string;
  timestamp: Date;
}

/**
 * Service registration info
 */
export interface ServiceRegistration {
  service: Service;
  agentId: string;
  deviceId?: string;
  registeredAt: Date;
}

/**
 * Environment center statistics
 */
export interface EnvironmentStats {
  deviceCount: number;
  agentCount: number;
  serviceCount: number;
  activeConnections: number;
}

// Re-export types for convenience
export type { Device, Service, CognitiveAgent as Agent, CollaborationMessage as Message };

/**
 * Extract the domain part of a capability string (the part before the first dash).
 * For example:
 *   "temperature-sensing" -> "temperature"
 *   "hvac-control" -> "hvac"
 *   "monitoring" -> "monitoring" (no dash, returns whole string)
 */
function getCapabilityDomain(capability: string): string {
  const dashIndex = capability.indexOf('-');
  return dashIndex > 0 ? capability.substring(0, dashIndex) : capability;
}

/**
 * Check if two capability strings match semantically.
 *
 * Matching rules (case-insensitive):
 * 1. Exact match: "temperature-sensing" == "temperature-sensing"
 * 2. Substring match: "traffic-control" contains "control"
 * 3. Domain match: "temperature-sensing" and "temperature-regulation" share domain "temperature"
 *
 * The domain match ensures that capabilities in the same problem domain are
 * considered related even when their specific functions differ (e.g., sensing
 * vs. regulation vs. monitoring for temperature).
 */
/**
 * Cross-domain capability mappings.
 * Maps a domain to its semantically related sub-domains.
 * Used by capabilitiesMatch() to bridge semantically connected capabilities.
 */
const CAPABILITY_DOMAIN_ALIASES: Record<string, string[]> = {
  'temperature': ['hvac', 'climate', 'cooling', 'heating', 'thermostat'],
  'hvac': ['temperature', 'climate', 'cooling', 'heating'],
  'device': ['actuator', 'sensor'],
  'actuation': ['hvac', 'lighting', 'actuator'],
  'security': ['monitoring', 'surveillance'],
  'lighting': ['light', 'illumination'],
  'humidity': ['moisture', 'dehumidifier', 'humidifier'],
};

export function capabilitiesMatch(agentCapability: string, requiredCapability: string): boolean {
  const agentCapLower = agentCapability.toLowerCase();
  const reqCapLower = requiredCapability.toLowerCase();

  // Exact match
  if (agentCapLower === reqCapLower) {
    return true;
  }

  // Substring match (bidirectional)
  if (agentCapLower.includes(reqCapLower) || reqCapLower.includes(agentCapLower)) {
    return true;
  }

  // Domain match: if they share the same domain prefix, they are semantically related
  const agentDomain = getCapabilityDomain(agentCapLower);
  const reqDomain = getCapabilityDomain(reqCapLower);

  // Only match on domain if the domain is meaningful (not a single character)
  if (agentDomain.length > 1 && reqDomain.length > 1 && agentDomain === reqDomain) {
    return true;
  }

  // Cross-domain alias match: semantically related domains
  const agentAliases = CAPABILITY_DOMAIN_ALIASES[agentDomain] || [];
  const reqAliases = CAPABILITY_DOMAIN_ALIASES[reqDomain] || [];
  if (agentAliases.includes(reqDomain) || reqAliases.includes(agentDomain)) {
    return true;
  }

  return false;
}

/**
 * Check if an agent's capabilities satisfy any of the required capabilities.
 * Returns true if at least one required capability is matched by at least one
 * agent capability.
 */
export function hasMatchingCapability(
  agentCapabilities: string[],
  requiredCapabilities: string[]
): boolean {
  return requiredCapabilities.some(req =>
    agentCapabilities.some(agentCap => capabilitiesMatch(agentCap, req))
  );
}
