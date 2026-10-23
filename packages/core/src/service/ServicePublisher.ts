/**
 * Service Publisher
 *
 * Publishes agent services to Environment Center for discovery
 * Handles service lifecycle and registration with the environment
 */

import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { ServiceRegistrationMeta } from '../environment/types.js';
import { AgentService, ServiceHealthStatus } from './Service.js';
import type { Service as SharedService } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Service publication info
 */
const logger = createLogger('ServicePublisher');

export interface ServicePublication {
  serviceId: string;
  serviceName: string; // Service name for unregistering
  agentId: string;
  environmentId: string;
  environment: EnvironmentCenter;
  deviceId?: string; // Device scope of the registration (heartbeat key)
  identityKey?: string; // Name-independent registration key slot (heartbeat key)
  publishedAt: Date;
  lastHeartbeat: Date;
  status: 'published' | 'unpublished' | 'error';
}

/**
 * Default heartbeat cadence (ms). Overridable per-instance (constructor) or
 * deployment-wide via SERVICE_HEARTBEAT_INTERVAL_MS. Keep the ratio with the
 * EnvironmentCenter stale TTL (DEFAULT_SERVICE_STALE_TTL_MS = 90s = 3× the
 * default 30s beat): shortening the beat without shortening the TTL only
 * changes keepalive traffic; LENGTHENING it past TTL/3 risks live services
 * being marked stale between beats.
 */
export const DEFAULT_SERVICE_HEARTBEAT_INTERVAL_MS = 30_000;

/** Deployment-wide override: SERVICE_HEARTBEAT_INTERVAL_MS (invalid → default). */
function heartbeatIntervalFromEnv(): number {
  const raw = process.env.SERVICE_HEARTBEAT_INTERVAL_MS;
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SERVICE_HEARTBEAT_INTERVAL_MS;
}

/**
 * Service Publisher manages service publication to Environment Centers
 */
export class ServicePublisher {
  // Track published services: serviceId -> publication info
  private publications: Map<string, ServicePublication>;

  // Heartbeat intervals for published services
  private heartbeats: Map<string, NodeJS.Timeout>;

  // Heartbeat cadence shared by every publication of this publisher.
  private readonly heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs: number = heartbeatIntervalFromEnv()) {
    this.publications = new Map();
    this.heartbeats = new Map();
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    logger.info('Initialized');
  }

  /**
   * Publish a service to an Environment Center
   * @param service - Service to publish
   * @param agentId - Agent ID that owns the service
   * @param environment - Environment Center to publish to
   * @param registrationMeta - Optional provenance/semantics metadata for the registration
   * @returns True if published successfully
   */
  publishService(
    service: AgentService,
    agentId: string,
    environment: EnvironmentCenter,
    registrationMeta?: ServiceRegistrationMeta
  ): boolean {
    logger.info(`Publishing service ${service.id} to environment ${environment.id}`
    );

    try {
      // Register service with environment, passing deviceId if available on service
      const serviceWithDeviceId = service as unknown as { deviceId?: string };
      const deviceId = serviceWithDeviceId.deviceId;
      environment.registerService(service as unknown as SharedService, agentId, deviceId, registrationMeta);
      // Arm liveness: the first heartbeat stamp (from now on the heartbeat
      // keeps lastSeenAt fresh; silence past the env's stale TTL marks the
      // service stale — see EnvironmentCenter.isRegistrationStale).
      environment.touchServiceHeartbeat(service.name, deviceId, registrationMeta?.identityKey);

      const publication: ServicePublication = {
        serviceId: service.id,
        serviceName: service.name,
        agentId,
        environmentId: environment.id,
        environment,
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(registrationMeta?.identityKey !== undefined ? { identityKey: registrationMeta.identityKey } : {}),
        publishedAt: new Date(),
        lastHeartbeat: new Date(),
        status: 'published',
      };

      this.publications.set(service.id, publication);

      // Start heartbeat
      this.startHeartbeat(service.id, agentId, environment);

      logger.info(`Service published: ${service.id}`);

      return true;
    } catch (error) {
      logger.error(`Failed to publish service ${service.id}:`, error);

      const publication: ServicePublication = {
        serviceId: service.id,
        serviceName: service.name,
        agentId,
        environmentId: environment.id,
        environment,
        publishedAt: new Date(),
        lastHeartbeat: new Date(),
        status: 'error',
      };

      this.publications.set(service.id, publication);

      return false;
    }
  }

  /**
   * Unpublish a service
   * @param serviceId - Service ID to unpublish
   * @returns True if unpublished successfully
   */
  unpublishService(serviceId: string): boolean {
    logger.info(`Unpublishing service: ${serviceId}`);

    const publication = this.publications.get(serviceId);
    if (!publication) {
      logger.warn(`Service ${serviceId} not published`);
      return false;
    }

    // Stop heartbeat
    this.stopHeartbeat(serviceId);

    // Unregister service from environment (same device scope it was
    // registered under — without it the key misses and the dead
    // registration would linger as a stale-looking ghost)
    try {
      publication.environment.unregisterService(publication.serviceName, publication.deviceId);
    } catch (error) {
      logger.warn(`Failed to unregister service ${serviceId} from environment:`, error);
    }

    // Remove publication
    this.publications.delete(serviceId);

    logger.info(`Service unpublished: ${serviceId}`);

    return true;
  }

  /**
   * Unpublish all services for an agent
   * @param agentId - Agent ID
   * @returns Number of services unpublished
   */
  unpublishAllForAgent(agentId: string): number {
    logger.info(`Unpublishing all services for agent: ${agentId}`);

    let count = 0;

    for (const [serviceId, publication] of this.publications) {
      if (publication.agentId === agentId) {
        this.unpublishService(serviceId);
        count++;
      }
    }

    logger.info(`Unpublished ${count} services for agent ${agentId}`);

    return count;
  }

  /**
   * Update service health
   * @param serviceId - Service ID
   * @param health - New health status
   */
  updateServiceHealth(serviceId: string, health: ServiceHealthStatus): void {
    const publication = this.publications.get(serviceId);
    if (!publication) {
      return;
    }

    // Update heartbeat timestamp
    publication.lastHeartbeat = new Date();

    // If service is unhealthy, the publication status might change
    if (health !== ServiceHealthStatus.HEALTHY) {
      logger.info(`Service ${serviceId} health: ${health}`);
    }
  }

  /**
   * Get publication info for a service
   * @param serviceId - Service ID
   * @returns Publication info or undefined
   */
  getPublication(serviceId: string): ServicePublication | undefined {
    return this.publications.get(serviceId);
  }

  /**
   * Get all publications for an agent
   * @param agentId - Agent ID
   * @returns Array of publications
   */
  getPublicationsByAgent(agentId: string): ServicePublication[] {
    return Array.from(this.publications.values()).filter((p) => p.agentId === agentId);
  }

  /**
   * Get all publications for an environment
   * @param environmentId - Environment ID
   * @returns Array of publications
   */
  getPublicationsByEnvironment(environmentId: string): ServicePublication[] {
    return Array.from(this.publications.values()).filter((p) => p.environmentId === environmentId);
  }

  /**
   * Get all publications
   * @returns Array of all publications
   */
  getAllPublications(): ServicePublication[] {
    return Array.from(this.publications.values());
  }

  /**
   * Get publisher statistics
   * @returns Statistics object
   */
  getStats(): {
    total: number;
    published: number;
    error: number;
    byAgent: Record<string, number>;
    byEnvironment: Record<string, number>;
  } {
    const publications = this.getAllPublications();

    const byAgent: Record<string, number> = {};
    const byEnvironment: Record<string, number> = {};
    let published = 0;
    let error = 0;

    for (const pub of publications) {
      // Count by agent
      byAgent[pub.agentId] = (byAgent[pub.agentId] || 0) + 1;

      // Count by environment
      byEnvironment[pub.environmentId] = (byEnvironment[pub.environmentId] || 0) + 1;

      // Count by status
      if (pub.status === 'published') {
        published++;
      } else if (pub.status === 'error') {
        error++;
      }
    }

    return {
      total: publications.length,
      published,
      error,
      byAgent,
      byEnvironment,
    };
  }

  /**
   * Clear all publications
   */
  clear(): void {
    logger.info('Clearing all publications');

    // Stop all heartbeats
    for (const serviceId of this.heartbeats.keys()) {
      this.stopHeartbeat(serviceId);
    }

    this.publications.clear();
  }

  /**
   * Start heartbeat for a service
   * @param serviceId - Service ID
   * @param _agentId - Agent ID
   * @param _environment - Environment Center
   */
  private startHeartbeat(
    serviceId: string,
    _agentId: string,
    _environment: EnvironmentCenter
  ): void {
    // Send heartbeat on the configured cadence (default 30s — see
    // DEFAULT_SERVICE_HEARTBEAT_INTERVAL_MS for the TTL ratio contract).
    const interval = this.heartbeatIntervalMs;

    const timer = setInterval(() => {
      const publication = this.publications.get(serviceId);
      if (publication) {
        publication.lastHeartbeat = new Date();
        // Environment-level liveness: push the keepalive into the
        // EnvironmentCenter so a dead agent's services go stale on the
        // discovery face instead of staying signable forever.
        publication.environment.touchServiceHeartbeat(
          publication.serviceName,
          publication.deviceId,
          publication.identityKey,
        );
        logger.info(`Heartbeat for service ${serviceId}`);
      }
    }, interval);

    this.heartbeats.set(serviceId, timer);
  }

  /**
   * Stop heartbeat for a service
   * @param serviceId - Service ID
   */
  private stopHeartbeat(serviceId: string): void {
    const timer = this.heartbeats.get(serviceId);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(serviceId);
    }
  }
}
