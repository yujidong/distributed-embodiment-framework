/**
 * Local Discovery Service
 *
 * Provides fast local service and agent discovery within an environment center
 */

import type { ServiceQuery, AgentCriteria, DiscoveryResult } from './types.js';
import type { Service, Agent } from './types.js';
import { EnvironmentCenter } from './EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Local Discovery Service
 */
const logger = createLogger('LocalDiscovery');

export class LocalDiscovery {
  /**
   * Discover services within an environment center
   * @param center - Environment center to search in
   * @param query - Service query criteria
   * @returns Discovery result
   */
  discoverServices(
    center: EnvironmentCenter,
    query: ServiceQuery
  ): DiscoveryResult<Service> {
    logger.info(
      `[LocalDiscovery:${center.id}] Discovering services with query:`,
      query
    );

    const services = center.discoverServices(query);

    const result: DiscoveryResult<Service> = {
      items: services,
      centerId: center.id,
      timestamp: new Date(),
    };

    logger.info(`[LocalDiscovery:${center.id}] Discovery complete: ${services.length} services`);
    return result;
  }

  /**
   * Discover agents within an environment center
   * @param center - Environment center to search in
   * @param criteria - Agent search criteria
   * @returns Discovery result
   */
  discoverAgents(
    center: EnvironmentCenter,
    criteria: AgentCriteria
  ): DiscoveryResult<Agent> {
    logger.info(
      `[LocalDiscovery:${center.id}] Discovering agents with criteria:`,
      criteria
    );

    const agents = center.discoverAgents(criteria);

    const result: DiscoveryResult<Agent> = {
      items: agents,
      centerId: center.id,
      timestamp: new Date(),
    };

    logger.info(`[LocalDiscovery:${center.id}] Discovery complete: ${agents.length} agents`);
    return result;
  }

  /**
   * Find a specific service by name within an environment center
   * @param center - Environment center to search in
   * @param serviceName - Service name
   * @param deviceId - Optional device ID
   * @returns Service or undefined
   */
  findService(
    center: EnvironmentCenter,
    serviceName: string,
    deviceId?: string
  ): Service | undefined {
    logger.info(
      `[LocalDiscovery:${center.id}] Finding service: ${serviceName}${deviceId ? ` on device ${deviceId}` : ''}`
    );

    const services = center.discoverServices({
      name: serviceName,
      deviceId,
    });

    return services[0];
  }

  /**
   * Find services by capability within an environment center
   * @param center - Environment center to search in
   * @param capability - Required capability name
   * @returns Array of matching services
   */
  findServicesByCapability(center: EnvironmentCenter, capability: string): Service[] {
    logger.info(`[LocalDiscovery:${center.id}] Finding services with capability: ${capability}`);

    return center.discoverServices({
      capability,
    });
  }

  /**
   * Find agents by capability within an environment center
   * @param center - Environment center to search in
   * @param capability - Required capability name
   * @returns Array of matching agents
   */
  findAgentsByCapability(center: EnvironmentCenter, capability: string): Agent[] {
    logger.info(`[LocalDiscovery:${center.id}] Finding agents with capability: ${capability}`);

    return center.discoverAgents({
      capabilities: [capability],
    });
  }

  /**
   * List all services in an environment center
   * @param center - Environment center
   * @returns All services
   */
  listAllServices(center: EnvironmentCenter): Service[] {
    logger.info(`[LocalDiscovery:${center.id}] Listing all services`);

    return center.discoverServices({});
  }

  /**
   * List all agents in an environment center
   * @param center - Environment center
   * @returns All agents
   */
  listAllAgents(center: EnvironmentCenter): Agent[] {
    logger.info(`[LocalDiscovery:${center.id}] Listing all agents`);

    return center.discoverAgents({});
  }
}

// Export singleton instance
export const localDiscovery = new LocalDiscovery();
