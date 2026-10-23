/**
 * Service Registry
 *
 * Manages all services provided by an agent
 * Handles service registration, discovery, and invocation
 */

import {
  AgentService,
  ServiceExecutionContext,
  ServiceExecutionResult,
  ProviderInfo,
} from './Service.js';

import { CommandBridge } from './CommandBridge.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ServiceRegistry');

/**
 * Service filter criteria.
 *
 * Semantic filtering deliberately has NO fields here — the four former
 * stubs (ontologyClass/semanticCapability/qosRequirements/
 * contextRequirements) were declared but findServices never read them.
 * Semantic/capability matching has a single source of truth:
 * utils/capabilityMatching.ts (synonym-aware matching used by discovery
 * and the decision layer).
 */
export interface ServiceFilter {
  category?: string;
  location?: string;
  available?: boolean;
  owner?: string;
  // Provider filters (Sprint 9)
  providerAgentId?: string;
}

/**
 * Service Registry manages agent services
 * Sprint 9: Auto-populates provider information on services during registration
 */
export class ServiceRegistry {
  private services: Map<string, AgentService>;
  private owner: string; // Agent ID that owns this registry
  // Sprint 9: Provider info for auto-population
  private providerInfo: ProviderInfo = {};
  // CommandBridge for routing device-derived service executions to device commands.
  // TEST FACILITY: the bridge lane is NOT on the production path —
  // setCommandBridge is only called from tests and executeService has no
  // production caller; production execution routes through
  // EnvironmentCenter.executeDeviceService / DeviceCommandCoordinator. The
  // executeService bridge branch below is kept behavior-as-is for tests.
  private commandBridge: CommandBridge | null = null;

  constructor(owner: string) {
    this.owner = owner;
    this.services = new Map();
    logger.info(`[ServiceRegistry:${owner}] Initialized`);
  }

  /**
   * Set the CommandBridge for routing device-derived service executions
   * @param bridge - CommandBridge instance
   */
  setCommandBridge(bridge: CommandBridge): void {
    this.commandBridge = bridge;
    logger.info(`[ServiceRegistry:${this.owner}] CommandBridge set`);
  }

  /**
   * Register a service
   * Sprint 9: Auto-populates provider information if not already set
   * @param service - Service to register
   * @returns True if registered successfully
   */
  registerService(service: AgentService): boolean {
    logger.info(`[ServiceRegistry:${this.owner}] Registering service: ${service.id}`);

    // Check if service belongs to this owner
    if (service.getOwner() !== this.owner) {
      logger.error(
        `[ServiceRegistry:${this.owner}] Service ${service.id} belongs to different owner`
      );
      return false;
    }

    // Check if service ID already exists
    if (this.services.has(service.id)) {
      logger.error(`[ServiceRegistry:${this.owner}] Service ${service.id} already registered`);
      return false;
    }

    // Sprint 9: Auto-populate provider info if not already set
    const currentProviderInfo = service.getProviderInfo();
    const serviceRecord = service as unknown as Record<string, unknown>;
    if (!currentProviderInfo.providerAgentId) {
      // Use providerInfo if set, otherwise default to registry owner
      const agentId = this.providerInfo.providerAgentId || this.owner;
      serviceRecord._providerAgentId = agentId;
      serviceRecord.providerAgentId = agentId;
    }
    if (!currentProviderInfo.providerAgentName && this.providerInfo.providerAgentName) {
      serviceRecord._providerAgentName = this.providerInfo.providerAgentName;
      serviceRecord.providerAgentName = this.providerInfo.providerAgentName;
    }
    if (!currentProviderInfo.providerCapabilities && this.providerInfo.providerCapabilities) {
      serviceRecord._providerCapabilities = this.providerInfo.providerCapabilities;
      serviceRecord.providerCapabilities = this.providerInfo.providerCapabilities;
    }

    this.services.set(service.id, service);

    logger.info(`[ServiceRegistry:${this.owner}] Service registered: ${service.id}`);

    return true;
  }

  /**
   * Unregister a service
   * @param serviceId - Service ID to unregister
   * @returns True if unregistered successfully
   */
  unregisterService(serviceId: string): boolean {
    logger.info(`[ServiceRegistry:${this.owner}] Unregistering service: ${serviceId}`);

    const service = this.services.get(serviceId);
    if (!service) {
      logger.error(`[ServiceRegistry:${this.owner}] Service ${serviceId} not found`);
      return false;
    }

    this.services.delete(serviceId);

    logger.info(`[ServiceRegistry:${this.owner}] Service unregistered: ${serviceId}`);

    return true;
  }

  /**
   * Get a service by ID
   * @param serviceId - Service ID
   * @returns Service or undefined
   */
  getService(serviceId: string): AgentService | undefined {
    return this.services.get(serviceId);
  }

  /**
   * Get all services
   * @returns Array of all services
   */
  getAllServices(): AgentService[] {
    return Array.from(this.services.values());
  }

  /**
   * Alias for getService - for convenient access
   * @param serviceId - Service ID
   * @returns Service or undefined
   */
  get(serviceId: string): AgentService | undefined {
    return this.getService(serviceId);
  }

  /**
   * Alias for getAllServices - for convenient access
   * @returns Array of all services
   */
  getAll(): AgentService[] {
    return this.getAllServices();
  }

  /**
   * Find services by filter criteria
   * Sprint 9: Added providerAgentId filter support
   * @param filter - Filter criteria
   * @returns Array of matching services
   */
  findServices(filter: ServiceFilter): AgentService[] {
    logger.info(`[ServiceRegistry:${this.owner}] Finding services with filter:`, filter);

    let results = this.getAllServices();

    if (filter.category) {
      results = results.filter((s) => s.category === filter.category);
    }

    if (filter.location) {
      results = results.filter((s) => s.location === filter.location);
    }

    if (filter.available !== undefined) {
      results = results.filter((s) => s.isAvailable() === filter.available);
    }

    if (filter.owner) {
      results = results.filter((s) => s.getOwner() === filter.owner);
    }

    // Sprint 9: Filter by provider agent ID
    if (filter.providerAgentId) {
      results = results.filter((s) => {
        const providerInfo = s.getProviderInfo();
        return providerInfo.providerAgentId === filter.providerAgentId;
      });
    }

    logger.info(`[ServiceRegistry:${this.owner}] Found ${results.length} services`);

    return results;
  }

  /**
   * Get services by category
   * @param category - Category to filter
   * @returns Services in the category
   */
  getServicesByCategory(category: string): AgentService[] {
    return this.findServices({ category });
  }

  /**
   * Get available services
   * @returns Array of available services
   */
  getAvailableServices(): AgentService[] {
    return this.findServices({ available: true });
  }

  /**
   * Execute a service
   * If the service is derived from a device and a CommandBridge is set,
   * the execution is routed through the bridge to the underlying device.
   *
   * Architecture flow:
   *   ServiceRegistry.executeService()
   *     → CommandBridge.executeServiceAsDeviceCommand()
   *       → Resource.execute()
   *         → Device.executeCommand()
   *
   * @param serviceId - Service ID to execute
   * @param context - Execution context
   * @returns Execution result
   */
  async executeService(
    serviceId: string,
    context: ServiceExecutionContext
  ): Promise<ServiceExecutionResult> {
    logger.info(`[ServiceRegistry:${this.owner}] Executing service: ${serviceId}`);

    const service = this.services.get(serviceId);

    if (!service) {
      logger.error(`[ServiceRegistry:${this.owner}] Service not found: ${serviceId}`);
      return {
        success: false,
        error: `Service ${serviceId} not found`,
        executedAt: new Date(),
        executionTime: 0,
      };
    }

    if (!service.isAvailable()) {
      logger.error(`[ServiceRegistry:${this.owner}] Service not available: ${serviceId}`);
      return {
        success: false,
        error: `Service ${serviceId} is not available`,
        executedAt: new Date(),
        executionTime: 0,
      };
    }

    const startTime = Date.now();

    try {
      // Check if this service should be routed through CommandBridge
      if (this.commandBridge && this.isDeviceDerivedService(service)) {
        logger.info(
          `[ServiceRegistry:${this.owner}] Routing device-derived service through CommandBridge: ${serviceId}`
        );
        // Use explicit targetCapabilityName if available, fallback to category
        const capabilityName = this.getServiceCapabilityName(service);
        const bridgedResult = await this.commandBridge.executeServiceAsDeviceCommand(
          capabilityName,
          context
        );
        return this.commandBridge.toServiceExecutionResult(bridgedResult, startTime);
      }

      // Standard service execution (non-device-derived or no bridge set)
      const result = await service.execute(context);
      const executionTime = Date.now() - startTime;

      logger.info(
        `[ServiceRegistry:${this.owner}] Service executed: ${serviceId} in ${executionTime}ms`
      );

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      logger.error(`[ServiceRegistry:${this.owner}] Service execution failed:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executedAt: new Date(),
        executionTime,
      };
    }
  }

  /**
   * Check if a service is derived from a device resource
   * A service is device-derived if its deviceId references a real registered resource
   * in the ResourceManager (not a synthetic/pure-service ID).
   */
  private isDeviceDerivedService(service: AgentService): boolean {
    if (!this.commandBridge) return false;
    // Device-derived services have a deviceId that resolves to a real resource
    return service.deviceId !== 'auto-generated'
      && service.deviceId !== 'unknown'
      && service.deviceId.length > 0;
  }

  /**
   * Get the explicit capability name for bridged execution
   * Checks for an explicit targetCapabilityName on the service first,
   * then falls back to category
   */
  private getServiceCapabilityName(service: AgentService): string {
    if ('targetCapabilityName' in service) {
      return (service as { targetCapabilityName: string }).targetCapabilityName;
    }
    return service.category;
  }

  /**
   * Get service count
   * @returns Number of services
   */
  getServiceCount(): number {
    return this.services.size;
  }

  /**
   * Get registry statistics
   * @returns Statistics object
   */
  getStats(): {
    total: number;
    available: number;
    unavailable: number;
    byCategory: Record<string, number>;
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
  } {
    const services = this.getAllServices();

    const byCategory: Record<string, number> = {};
    let available = 0;
    let totalExecutions = 0;
    let successfulExecutions = 0;
    let failedExecutions = 0;

    for (const service of services) {
      // Count by category
      byCategory[service.category] = (byCategory[service.category] || 0) + 1;

      // Count available
      if (service.isAvailable()) {
        available++;
      }

      // Aggregate execution stats
      const stats = service.getStats();
      totalExecutions += stats.totalExecutions;
      successfulExecutions += stats.successfulExecutions;
      failedExecutions += stats.failedExecutions;
    }

    return {
      total: services.length,
      available,
      unavailable: services.length - available,
      byCategory,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
    };
  }

  /**
   * Clear all services
   */
  clear(): void {
    logger.info(`[ServiceRegistry:${this.owner}] Clearing all services`);
    this.services.clear();
  }

  /**
   * Set provider agent information for auto-population (Sprint 9)
   * This information will be automatically populated on services during registration
   * @param info - Provider agent information
   */
  setProviderAgentInfo(info: {
    agentId: string;
    agentName?: string;
    capabilities?: string[];
  }): void {
    this.providerInfo = {
      providerAgentId: info.agentId,
      providerAgentName: info.agentName,
      providerCapabilities: info.capabilities,
    };
    logger.info(`[ServiceRegistry:${this.owner}] Provider agent info set:`, info);
  }

  /**
   * Find services by provider capability (Sprint 9)
   * @param capability - Capability to search for
   * @returns Services whose provider has the specified capability
   */
  findServicesByProviderCapability(capability: string): AgentService[] {
    logger.info(`[ServiceRegistry:${this.owner}] Finding services by provider capability: ${capability}`);

    const results = this.getAllServices().filter((s) => {
      const providerInfo = s.getProviderInfo();
      return providerInfo.providerCapabilities?.includes(capability) ?? false;
    });

    logger.info(`[ServiceRegistry:${this.owner}] Found ${results.length} services with provider capability: ${capability}`);
    return results;
  }

  /**
   * Get registry owner
   * @returns Owner (agent) ID
   */
  getOwner(): string {
    return this.owner;
  }
}
