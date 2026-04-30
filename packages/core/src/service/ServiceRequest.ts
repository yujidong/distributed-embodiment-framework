/**
 * Service Request Module
 *
 * Structured service discovery and request system for agent collaboration.
 * Replaces prompt-based collaboration with structured workflows.
 */

import type { DeviceLocation } from '@active-collaboration/shared';

/**
 * Service query for finding available services
 */
export interface CollaborationServiceQuery {
  serviceType: string; // e.g., 'energy-monitoring', 'hvac-control'
  requiredCapabilities: string[]; // Required capabilities
  constraints?: ServiceConstraints;
  preferences?: ServicePreferences;
}

/**
 * Service constraints
 */
export interface ServiceConstraints {
  maxLatency?: number; // Maximum acceptable latency (ms)
  minAvailability?: number; // Minimum availability (0-1)
  maxCost?: number; // Maximum cost per use
  allowedProviders?: string[]; // Specific agent IDs to use
  excludedProviders?: string[]; // Agent IDs to avoid
}

/**
 * Service preferences
 */
export interface ServicePreferences {
  preferredProviders?: string[]; // Agent IDs to prefer
  optimizeFor?: 'cost' | 'latency' | 'reliability' | 'quality';
}

/**
 * Service offer from a provider
 * Rich information for LLM-based decision making
 */
export interface ServiceOffer {
  providerId: string;
  providerName: string;
  serviceId: string;
  serviceName: string;
  serviceType: string;
  serviceDescription: string; // Detailed description of what this service does
  actionType: 'observe' | 'control' | 'both'; // Service action type
  capabilities: string[];
  capabilitiesDescriptions: string[]; // Human-readable descriptions of each capability
  deviceId: string; // Device that provides this service
  deviceType: string; // Type of device (sensor, actuator, controller, etc.)
  deviceLocation?: DeviceLocation; // Where the device is located
  estimatedLatency?: number;
  estimatedCost?: number;
  availability?: number;
  sla?: ServiceLevelAgreement;
}

/**
 * Service level agreement
 */
export interface ServiceLevelAgreement {
  uptime: number; // Guaranteed uptime (0-1)
  responseTime: number; // Maximum response time (ms)
  throughput?: number; // Requests per time unit
}

/**
 * Service request
 */
export interface ServiceRequest {
  requestId: string;
  requesterId: string;
  providerId: string;
  serviceId: string;
  serviceType: string;
  query: CollaborationServiceQuery;
  state: 'pending' | 'accepted' | 'rejected' | 'active' | 'completed' | 'failed' | 'expired';
  requestedAt: Date;
  expiresAt?: Date;
  contract?: ServiceContract;
  response?: ServiceResponse;
}

/**
 * Service contract
 * Manages lifecycle of service usage
 */
export interface ServiceContract {
  contractId: string;
  requestId: string;
  providerId: string;
  consumerId: string;
  serviceId: string;
  serviceType: string;
  state: 'negotiating' | 'active' | 'suspended' | 'terminated' | 'expired';
  createdAt: Date;
  activatedAt?: Date;
  expiresAt?: Date;
  terms: ContractTerms;
  usage: ServiceUsage;
}

/**
 * Contract terms
 */
export interface ContractTerms {
  duration?: number; // Contract duration (ms), undefined = indefinite
  maxRequests?: number; // Maximum requests allowed
  costPerRequest?: number;
  sla: ServiceLevelAgreement;
  renewalPolicy?: 'manual' | 'auto' | 'none';
  terminationConditions?: string[];
}

/**
 * Service usage tracking
 */
export interface ServiceUsage {
  requestsMade: number;
  requestsSucceeded: number;
  requestsFailed: number;
  totalCost: number;
  lastUsed?: Date;
  averageLatency?: number;
}

/**
 * Service response
 */
export interface ServiceResponse {
  responseId: string;
  requestId: string;
  providerId: string;
  decision: 'accept' | 'reject' | 'counter';
  message: string;
  counterTerms?: ContractTerms;
  estimatedAvailability?: Date;
}

/**
 * Service discovery result
 */
export interface ServiceDiscoveryResult {
  query: CollaborationServiceQuery;
  offers: ServiceOffer[];
  selectedOffer?: ServiceOffer;
  timestamp: Date;
}

/**
 * Service request result
 */
export interface ServiceRequestResult {
  request: ServiceRequest;
  success: boolean;
  contract?: ServiceContract;
  error?: string;
}
