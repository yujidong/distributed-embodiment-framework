/**
 * Service Broker Module
 *
 * Orchestrates structured service discovery, requests, and contract management.
 * Replaces prompt-based collaboration with formal workflows.
 */

import { v4 as uuidv4 } from 'uuid';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type {
  CollaborationServiceQuery,
  ServiceOffer,
  ServiceRequest,
  ServiceContract,
  ServiceDiscoveryResult,
  ServiceRequestResult,
} from './ServiceRequest.js';
import { ServiceValidator } from './ServiceValidator.js';
import type { Service } from '@active-collaboration/shared';
import type { ProviderInfo } from './Service.js';

/** Runtime service with optional provider info method */
interface ServiceWithProvider extends Service {
  getProviderInfo?(): ProviderInfo;
}

/** Runtime service with optional capability metadata */
interface ServiceWithCapability extends Service {
  capability?: { canDo?: string[] };
}

import { createLogger } from '@active-collaboration/shared';
/**
 * Service request options
 */
const logger = createLogger('ServiceBroker');

export interface ServiceRequestOptions {
  timeout?: number; // Request timeout (ms)
  maxAttempts?: number; // Maximum retry attempts
  retryDelay?: number; // Delay between retries (ms)
}

/**
 * Service Broker
 * Manages structured service discovery and requests
 */
export class ServiceBroker {
  private environment: EnvironmentCenter;
  private validator: ServiceValidator;
  private activeContracts: Map<string, ServiceContract>;
  private pendingRequests: Map<string, ServiceRequest>;

  constructor(environment: EnvironmentCenter) {
    this.environment = environment;
    this.validator = new ServiceValidator();
    this.activeContracts = new Map();
    this.pendingRequests = new Map();

    logger.info(`Initialized with environment: ${environment.id}`);
  }

  /**
   * Discover services that match a query
   * Returns structured offers with validation
   */
  async discoverServices(query: CollaborationServiceQuery): Promise<ServiceDiscoveryResult> {
    logger.info(`Discovering services for type: ${query.serviceType}`);

    // Validate query
    const validation = this.validator.validateQuery(query);
    if (!validation.valid) {
      logger.error(`Invalid query:`, validation.errors);
      throw new Error(`Invalid service query: ${validation.errors.join(', ')}`);
    }

    // Get all registered services from environment
    const allServices = this.environment.discoverServices({});
    const offers: ServiceOffer[] = [];

    // Get all agents to map services to providers
    const agents = this.environment.listAgents();

    // Filter and convert services to offers
    for (const service of allServices) {
      // ENHANCED: Don't filter early - let validator do intelligent matching
      // Only skip if explicitly requesting a wildcard (then include all)
      if (query.serviceType === 'all' || query.serviceType === 'any') {
        logger.info(`Including service ${service.id} (wildcard query)`);
      } else {
        logger.info(`Considering service ${service.id}: category '${service.category}' vs query '${query.serviceType}'`);
      }

      // Find the agent that provides this service using getProviderInfo()
      // This is the correct approach per architecture: use service metadata,
      // NOT direct access to agent's private ResourceManager
      const serviceWithProvider = service as ServiceWithProvider;
      const providerInfo: ProviderInfo | undefined = typeof serviceWithProvider.getProviderInfo === 'function'
        ? serviceWithProvider.getProviderInfo()
        : undefined;
      const providerAgentId = providerInfo?.providerAgentId;

      if (!providerAgentId) {
        logger.info(`Skipping service ${service.id}: no providerAgentId in getProviderInfo()`);
        continue;
      }

      // Find the agent that provides this service
      const providerAgent = agents.find((agent: { id: string }) => {
        return agent.id === providerAgentId;
      });

      if (!providerAgent) {
        logger.info(`Skipping service ${service.id}: no provider agent found with id ${providerAgentId}`);
        continue;
      }

      logger.info(`Found provider agent ${providerAgent.id} for service ${service.id}`);

      // Check if this provider is excluded
      if (query.constraints?.excludedProviders?.includes(providerAgent.id)) {
        logger.info(`Skipping service ${service.id}: provider ${providerAgent.id} is in excluded list`);
        continue;
      }

      // Check if allowedProviders is specified and this provider is not in the list
      if (query.constraints?.allowedProviders && query.constraints.allowedProviders.length > 0) {
        if (!query.constraints.allowedProviders.includes(providerAgent.id)) {
          logger.info(`Skipping service ${service.id}: provider ${providerAgent.id} is not in allowed list`);
          continue;
        }
      }

      logger.info(`Found provider agent ${providerAgent.id} for service ${service.id}`);

      // ENHANCED: Extract capabilities from service category, description, and capability.canDo
      const serviceCategory = service.category || '';
      const serviceCapabilities = [
        serviceCategory,
        ...(query.requiredCapabilities.filter(req =>
          service.name.toLowerCase().includes(req.toLowerCase()) ||
          (service.description || '').toLowerCase().includes(req.toLowerCase()) ||
          serviceCategory.toLowerCase().includes(req.toLowerCase())
        ))
      ];

      // Check service's capability.canDo (for MicroserviceService)
      const serviceWithCapability = service as ServiceWithCapability;
      if (serviceWithCapability.capability && serviceWithCapability.capability.canDo) {
        const canDoCapabilities = serviceWithCapability.capability.canDo;
        // Add canDo capabilities to the list
        canDoCapabilities.forEach((can: string) => {
          // Extract key terms from CAN statements
          const match = can.match(/CAN:\s*(.+?)(?:\.|$)/i);
          if (match) {
            serviceCapabilities.push(match[1].trim());
          }
        });
        logger.info(`Service ${service.id} capabilities:`, serviceCapabilities);
      }

      // ENHANCED: Check if required capabilities are met using fuzzy matching
      const hasAllRequired = query.requiredCapabilities.every(req => {
        const reqLower = req.toLowerCase();
        const serviceNameLower = service.name.toLowerCase();
        const serviceDescLower = service.description.toLowerCase();
        const serviceCategoryLower = (service.category || '').toLowerCase();

        // Check bidirectional: service contains req OR req contains service keywords
        const basicMatch =
          serviceNameLower.includes(reqLower) ||
          serviceDescLower.includes(reqLower) ||
          serviceCategoryLower.includes(reqLower) ||
          // NEW: Check if req contains key terms from service
          this.containsKeyTerms(reqLower, serviceNameLower) ||
          this.containsKeyTerms(reqLower, serviceDescLower);

        if (basicMatch) return true;

        // Check extracted capabilities
        const capabilityMatch = serviceCapabilities.some(cap =>
          cap.toLowerCase().includes(reqLower) ||
          reqLower.includes(cap.toLowerCase())
        );

        if (capabilityMatch) return true;

        // Fuzzy match entity/category
        // e.g., "hvac" should match "temperature" (HVAC controls temperature)
        // e.g., "thermostat" should match "temperature"
        const semanticMatch = this.semanticCapabilityMatch(req, service);
        return semanticMatch;
      });

      if (!hasAllRequired && query.requiredCapabilities.length > 0) {
        logger.info(`Service ${service.id} missing capabilities: ${query.requiredCapabilities.join(', ')}`);
        continue;
      }

      logger.info(`Service ${service.id} matches required capabilities`);

      // Get device information for rich metadata
      const device = this.environment.getDevice(service.deviceId);

      // Generic capability description generation (no hardcoded cases)
      // Uses DeviceCapability type information to generate descriptions
      const capabilitiesDescriptions = device?.capabilities?.map(deviceCap => {
        const capType = deviceCap.type.toUpperCase(); // READ, WRITE, EXECUTE
        const capName = deviceCap.name;

        // Generic description based on capability type (not hardcoded to specific capabilities)
        let canDo = '';
        let cannotDo = '';

        if (deviceCap.type === 'read') {
          canDo = `CAN: Read/measure ${capName.replace(/^read-/, '')}`;
          cannotDo = `CANNOT: Modify, control, or change ${capName.replace(/^read-/, '')}`;
        } else if (deviceCap.type === 'write' || deviceCap.type === 'execute') {
          canDo = `CAN: Control/modify ${capName.replace(/^(set|control|write-)/, '')}`;
          cannotDo = `CANNOT: Read or measure ${capName.replace(/^(set|control|write-)/, '')}`;
        } else {
          canDo = `CAN: ${capName}`;
          cannotDo = `CANNOT: See device-specific documentation`;
        }

        return `${canDo}. ${cannotDo}.`;
      }) || [];

      // Generic service-level description based on actionType (not hardcoded to specific device types)
      const actionTypeLabel = service.actionType?.toUpperCase() || 'BOTH';
      let serviceDescription = service.description || '';

      // Add generic action type constraints
      if (service.actionType === 'observe') {
        serviceDescription = `[${actionTypeLabel}] ${serviceDescription} Capability: READ-ONLY. Can observe/monitor data. Cannot modify/control anything.`;
      } else if (service.actionType === 'control') {
        serviceDescription = `[${actionTypeLabel}] ${serviceDescription} Capability: CONTROL-ONLY. Can modify/control devices. Cannot observe/monitor data.`;
      } else {
        serviceDescription = `[${actionTypeLabel}] ${serviceDescription} Capability: READ AND CONTROL. Can both observe and modify.`;
      }

      // Create rich offer with generic metadata
      const offer: ServiceOffer = {
        providerId: providerAgent.id,
        providerName: providerAgent.name,
        serviceId: service.id,
        serviceName: service.name,
        serviceType: service.category,
        serviceDescription,
        actionType: service.actionType || 'both',
        capabilities: serviceCapabilities,
        capabilitiesDescriptions,
        deviceId: service.deviceId,
        deviceType: device?.type || 'unknown',
        deviceLocation: device?.location,
        estimatedLatency: 50,
        estimatedCost: 0,
        availability: 1.0,
      };

      // Verify offer matches query
      const matchValidation = this.validator.verifyOfferMatchesQuery(offer, query);
      if (matchValidation.valid) {
        offers.push(offer);
        logger.info(`Offer added for ${service.name}: provider=${providerAgent.id}`);
      } else {
        // Log warnings but don't include the offer
        logger.info(`Offer rejected for ${service.name}: valid=${matchValidation.valid}, warnings:`, matchValidation.warnings);
        if (matchValidation.warnings.length > 0) {
          logger.warn(`Offer warnings for ${service.name}:`, matchValidation.warnings);
        }
      }
    }

    logger.info(`Found ${offers.length} matching services`);

    return {
      query,
      offers,
      timestamp: new Date(),
    };
  }

  /**
   * Select best offer from discovery results
   * Uses preferences and constraints to choose
   */
  selectBestOffer(discovery: ServiceDiscoveryResult): ServiceOffer | undefined {
    if (discovery.offers.length === 0) {
      return undefined;
    }

    // If only one offer, return it
    if (discovery.offers.length === 1) {
      return discovery.offers[0];
    }

    // Sort offers based on preferences
    const sortedOffers = [...discovery.offers].sort((a, b) => {
      const prefs = discovery.query.preferences;

      // Optimization preference
      if (prefs?.optimizeFor === 'cost') {
        return (a.estimatedCost || 0) - (b.estimatedCost || 0);
      } else if (prefs?.optimizeFor === 'latency') {
        return (a.estimatedLatency || 0) - (b.estimatedLatency || 0);
      } else if (prefs?.optimizeFor === 'reliability') {
        return (b.availability || 0) - (a.availability || 0);
      } else if (prefs?.optimizeFor === 'quality') {
        return (b.sla?.uptime || 0) - (a.sla?.uptime || 0);
      }

      // Default: prefer preferred providers
      if (prefs?.preferredProviders && prefs.preferredProviders.length > 0) {
        const aPreferred = prefs.preferredProviders.includes(a.providerId);
        const bPreferred = prefs.preferredProviders.includes(b.providerId);
        if (aPreferred && !bPreferred) return -1;
        if (!aPreferred && bPreferred) return 1;
      }

      return 0;
    });

    return sortedOffers[0];
  }

  /**
   * Send a structured service request
   */
  async requestService(
    offer: ServiceOffer,
    query: CollaborationServiceQuery,
    requesterId: string,
    options?: ServiceRequestOptions
  ): Promise<ServiceRequestResult> {
    logger.info(`Requesting service ${offer.serviceId} from ${offer.providerId}`);

    // Create service request
    const request: ServiceRequest = {
      requestId: uuidv4(),
      requesterId,
      providerId: offer.providerId,
      serviceId: offer.serviceId,
      serviceType: offer.serviceType,
      query,
      state: 'pending',
      requestedAt: new Date(),
      expiresAt: options?.timeout ? new Date(Date.now() + options.timeout) : undefined,
    };

    // Validate request
    const validation = this.validator.validateRequest(request);
    if (!validation.valid) {
      return {
        request,
        success: false,
        error: `Invalid request: ${validation.errors.join(', ')}`,
      };
    }

    // Store pending request
    this.pendingRequests.set(request.requestId, request);

    // TODO: Emit event for provider to handle
    // For now, auto-accept for testing
    request.state = 'accepted';

    // Create contract
    const contract = this.createContract(request, offer);
    request.contract = contract;

    logger.info(`Service request accepted: ${request.requestId}`);

    return {
      request,
      success: true,
      contract,
    };
  }

  /**
   * Create a service contract
   */
  private createContract(request: ServiceRequest, offer: ServiceOffer): ServiceContract {
    const contract: ServiceContract = {
      contractId: uuidv4(),
      requestId: request.requestId,
      providerId: request.providerId,
      consumerId: request.requesterId,
      serviceId: request.serviceId,
      serviceType: request.serviceType,
      state: 'active',
      createdAt: new Date(),
      activatedAt: new Date(),
      terms: {
        sla: offer.sla || {
          uptime: 0.95,
          responseTime: 1000,
        },
        costPerRequest: offer.estimatedCost || 0,
      },
      usage: {
        requestsMade: 0,
        requestsSucceeded: 0,
        requestsFailed: 0,
        totalCost: 0,
      },
    };

    // Store contract
    this.activeContracts.set(contract.contractId, contract);

    logger.info(`Contract created: ${contract.contractId}`);

    return contract;
  }

  /**
   * Use a service (invoke it)
   */
  async useService(
    contractId: string,
    methodName: string,
    _params: Record<string, any>
  ): Promise<any> {
    const contract = this.activeContracts.get(contractId);
    if (!contract) {
      throw new Error(`Contract not found: ${contractId}`);
    }

    if (contract.state !== 'active') {
      throw new Error(`Contract is not active: ${contract.state}`);
    }

    logger.info(`Using service ${contract.serviceId} method: ${methodName}`);

    // Update usage tracking
    contract.usage.requestsMade++;

    // TODO: Actually execute the service
    // For now, simulate execution
    const startTime = Date.now();

    // Simulate processing
    await new Promise(resolve => setTimeout(resolve, 100));

    const endTime = Date.now();
    const latency = endTime - startTime;

    // Update usage
    contract.usage.requestsSucceeded++;
    contract.usage.totalCost += contract.terms.costPerRequest || 0;
    contract.usage.lastUsed = new Date();

    // Update average latency
    if (contract.usage.averageLatency) {
      contract.usage.averageLatency =
        (contract.usage.averageLatency * (contract.usage.requestsSucceeded - 1) + latency) /
        contract.usage.requestsSucceeded;
    } else {
      contract.usage.averageLatency = latency;
    }

    logger.info(`Service executed: ${methodName}, latency: ${latency}ms`);

    return {
      success: true,
      latency,
      cost: contract.terms.costPerRequest || 0,
    };
  }

  /**
   * Terminate a contract
   */
  terminateContract(contractId: string, reason?: string): void {
    const contract = this.activeContracts.get(contractId);
    if (!contract) {
      throw new Error(`Contract not found: ${contractId}`);
    }

    contract.state = 'terminated';

    logger.info(`Contract terminated: ${contractId}, reason: ${reason || 'not specified'}`);
  }

  /**
   * Get active contracts
   */
  getActiveContracts(): ServiceContract[] {
    return Array.from(this.activeContracts.values());
  }

  /**
   * Get pending requests
   */
  getPendingRequests(): ServiceRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Semantic capability matching
   * Matches capabilities based on semantic relationships, not just string matching
   */
  private semanticCapabilityMatch(requiredCapability: string, service: Pick<Service, 'name' | 'description' | 'category'>): boolean {
    // Define semantic mappings
    const semanticMap: Record<string, string[]> = {
      'temperature': ['hvac', 'thermostat', 'climate', 'heating', 'cooling', 'ac'],
      'humidity': ['humidifier', 'dehumidifier', 'climate', 'humidity'],
      'air-quality': ['purifier', 'ventilation', 'air-filter'],
      'security': ['lock', 'camera', 'alarm', 'sensor'],
      'lighting': ['light', 'lamp', 'bulb', 'dimmer']
    };

    const reqLower = requiredCapability.toLowerCase();

    // Check if service category/name/description matches semantically
    const serviceText = `${service.name} ${service.description} ${service.category}`.toLowerCase();

    // Check semantic mappings
    for (const [key, relatedTerms] of Object.entries(semanticMap)) {
      if (reqLower === key || reqLower.includes(key)) {
        // Required capability is 'temperature', check if service is 'hvac', 'thermostat', etc.
        for (const term of relatedTerms) {
          if (serviceText.includes(term)) {
            logger.info(`Semantic match: '${requiredCapability}' ~= '${term}' in ${service.name}`);
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if a requirement string contains key terms from service text
   * E.g., "request_humidity_data" contains "humidity" from "Humidity Monitoring"
   */
  private containsKeyTerms(reqLower: string, serviceTextLower: string): boolean {
    // Extract key terms from service text (words longer than 3 chars)
    const keyTerms = serviceTextLower
      .split(/[\s_-]+/)
      .filter(word => word.length > 3)
      .filter(word => !['with', 'from', 'this', 'that', 'provides', 'service'].includes(word));

    for (const term of keyTerms) {
      if (reqLower.includes(term)) {
        logger.info(`Key term match: req '${reqLower}' contains '${term}' from service`);
        return true;
      }
    }

    return false;
  }
}
