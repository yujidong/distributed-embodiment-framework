/**
 * Service Execution Coordinator
 *
 * Handles Service Layer operations - cross-agent service requests
 *
 * Key Responsibilities:
 * - Request services from other agents
 * - Handle service discovery and brokerage
 * - Emit service execution events
 *
 * Architecture principle:
 * - Service Layer: Agent-exposed functionality to OTHER agents
 * - Services are NOT device commands (Device Layer handles commands)
 * - Services may or may not use devices internally
 * - This coordinator only handles Service-to-Service communication
 */

import type { ServiceBroker } from '../../service/ServiceBroker.js';
import type { ServiceRegistry } from '../../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '@active-collaboration/shared';

import type { Service } from '@active-collaboration/shared';

/**
 * Service Execution Result
 */
export interface ServiceExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  executionTime?: number;
}

/**
 * Service Request Result
 */
export interface ServiceRequestResult {
  success: boolean;
  result?: any;
  error?: string;
  providerAgentId?: string;
  responseTime?: number;
}
/**
 * Service Execution Coordinator
 *
 * Coordinates Service Layer operations for CognitiveAgent.
 * Only handles cross-agent service requests and service discovery.
 * Device commands are handled by DeviceCommandCoordinator.
 */
export class ServiceExecutionCoordinator {
  /**
   * Creates a new ServiceExecutionCoordinator
   *
   * @param serviceBroker - The ServiceBroker instance
   * @param serviceRegistry - The ServiceRegistry instance
   * @param environment - The EnvironmentCenter instance
   * @param eventEmitter - EventEmitter for emitting service events
   * @param agentId - ID of the agent this coordinator belongs to
   */
  constructor(
    private readonly serviceBroker: ServiceBroker,
    private readonly serviceRegistry: ServiceRegistry,
    private readonly environment: EnvironmentCenter,
    private readonly eventEmitter: EventEmitter,
    private readonly agentId: string
  ) {}

  /**
   * Request a service from another agent
   *
   * Delegates to ServiceBroker to discover and request service.
   * Emits a COLLABORATION_MESSAGE event upon successful request.
   *
   * @param targetAgentId - The target agent ID to request service from
   * @param serviceId - The service ID to request
   * @param parameters - Optional parameters for the service
   * @param retryOptions - Optional retry configuration (maxRetries, retryDelay)
   * @returns Service request result
   */
  async requestService(
    targetAgentId: string,
    serviceId: string,
    parameters?: any,
    retryOptions?: { maxRetries?: number; retryDelay?: number }
  ): Promise<ServiceRequestResult> {
    const startTime = Date.now();
    const maxRetries = retryOptions?.maxRetries ?? 3;
    const retryDelay = retryOptions?.retryDelay ?? 1000;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 1. Discover service through ServiceBroker
        const discoveryResult = await this.serviceBroker.discoverServices({
          serviceType: 'all',
          requiredCapabilities: [serviceId]
        });

        if (!discoveryResult.offers || discoveryResult.offers.length === 0) {
          return {
            success: false,
            error: `Service ${serviceId} not found`
          };
        }

        // Get the first matching service offer
        const serviceOffer = discoveryResult.offers[0];

        // 2. Verify target agent exists
        const targetAgent = this.environment.getAgent(targetAgentId);
        if (!targetAgent) {
          return {
            success: false,
            error: `Agent ${targetAgentId} not found`
          };
        }

        // 3. Request service through ServiceBroker
        const result = await this.serviceBroker.requestService(
          serviceOffer,
          parameters,
          this.agentId
        );

        const responseTime = Date.now() - startTime;

        // 4. Emit event - use actual EventType enum
        this.eventEmitter.emit(EventType.COLLABORATION_MESSAGE, {
          agentId: this.agentId,
          targetAgentId,
          serviceId,
          result,
          responseTime
        });

        return {
          success: true,
          result,
          providerAgentId: targetAgentId,
          responseTime
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // If this isn't the last attempt, wait before retrying
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    // All retries exhausted
    return {
      success: false,
      error: lastError?.message || 'Service request failed after all retries'
    };
  }

  /**
   * Get service from registry
   *
   * @param serviceId - Service ID
   * @returns Service if found, undefined otherwise
   */
  getService(serviceId: string): Service | undefined {
    return this.serviceRegistry.get(serviceId);
  }

  /**
   * Get all registered services
   *
   * @returns Array of services
   */
  getAllServices(): Service[] {
    return this.serviceRegistry.getAll();
  }
}
