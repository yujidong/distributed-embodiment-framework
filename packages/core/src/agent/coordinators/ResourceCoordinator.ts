/**
 * Resource Coordinator
 *
 * Extracted from CognitiveAgent lines 1581-1941
 *
 * Responsibilities:
 * - Device assignment and management
 * - Service publishing from devices
 * - Device-to-service mapping
 * - Resource type mapping
 * - Capability derivation
 */

import type { Device } from '@active-collaboration/shared';
import type { ResourceManager } from '../../resource/ResourceManager.js';
import type { ServicePublisher } from '../../service/ServicePublisher.js';
import type { ServiceRegistry } from '../../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { Service } from '@active-collaboration/shared';
import type { AgentService, ServiceExecutionContext, ServiceExecutionResult } from '../../service/Service.js';
import { ServiceHealthStatus as ServiceHealthStatusEnum } from '../../service/Service.js';
import { deriveDeviceService, DERIVED_DEVICE_SERVICE_IDENTITY } from '../../service/device-service-derivation.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Resource Coordinator
 *
 * Coordinates device/resource management for CognitiveAgent
 */
const logger = createLogger('ResourceCoordinator');

export class ResourceCoordinator {
  constructor(
    private resourceManager: ResourceManager,
    private servicePublisher: ServicePublisher,
    private serviceRegistry: ServiceRegistry,
    private environment: EnvironmentCenter,
    private agentId: string,
    private agentCapabilities: string[],
    private agentName: string = agentId
  ) {}

  /**
   * Assign devices to agent
   * Extracted from CognitiveAgent.assignDevices() (lines 1581-1602)
   */
  assignDevices(devices: Device[], owner: string): void {
    logger.info(`[ResourceCoordinator:${this.agentId}] Assigning ${devices.length} devices`);

    for (const device of devices) {
      this.resourceManager.registerDevice(device, owner);
      // Auto-publish device as service
      this.publishDeviceAsService(device);
    }

    logger.info(`[ResourceCoordinator:${this.agentId}] Devices assigned. Total: ${this.resourceManager.getCount()}`);
  }

  /**
   * Publish device as service
   * Extracted from CognitiveAgent.publishDeviceAsService() (lines 1608-1696)
   *
   * The derivation itself (naming / capabilities / semanticType /
   * description) lives in service/device-service-derivation.ts — the single
   * source of truth shared with the world-layer derivation sync.
   */
  private publishDeviceAsService(device: Device): void {
    // T-202 capability honesty: the service's MATCHING field advertises the
    // DEVICE only — its own capabilities plus device-type-derived semantics
    // (deriveDeviceService with NO agent input). The previous merge of
    // the agent's full capability union made every per-device service claim
    // everything the agent could do ("Lobby Ceiling Lights Service"
    // advertised cooling), so LLM partner selection could not tell which
    // service actually delivers a capability. The agent union stays visible
    // as providerCapabilities metadata (display-only, never matched).
    const spec = deriveDeviceService(device);

    logger.info(`[ResourceCoordinator:${this.agentId}] Service capabilities (device-only): ${spec.capabilities.join(',')}`);

    const service: Service = {
      id: `service-${device.id}`,
      name: spec.name,
      description: spec.description,
      deviceId: device.id,
      uri: `device://${device.id}`,
      httpMethod: 'GET',
      parameters: spec.parameters,
      location: device.location,
      category: spec.category, // Use resource type as category for workflow matching
      isConditional: false,
      // Service capability metadata for automatic matching
      actionType: spec.actionType,
      capabilities: spec.capabilities,
      // Provenance/semantics: derived from this device, labeled by its resource type
      origin: 'derived',
      semanticType: spec.semanticType,
      // Phase 1: provider metadata so ServiceBroker.discoverServices() can
      // resolve the owning agent without calling getProviderInfo() (which
      // only exists on AgentService instances, not plain Service objects).
      providerAgentId: this.agentId,
      providerAgentName: this.agentName,
      providerCapabilities: this.agentCapabilities,
    };

    // Registration provenance metadata — publishService re-registers the
    // same key, so the meta rides along on both registrations. The
    // name-independent identityKey makes the registry slot rename-stable:
    // the derived service name is built from the device name, so keying by
    // name orphaned the old registration on every device rename.
    const registrationMeta = {
      origin: 'derived' as const,
      semanticType: spec.semanticType,
      identityKey: DERIVED_DEVICE_SERVICE_IDENTITY,
    };

    // Register service with environment center
    this.environment.registerService(service, this.agentId, device.id, registrationMeta);

    // Publish service
    this.servicePublisher.publishService(
      {
        ...service,
        execute: async () => ({
          success: true,
          result: { deviceId: device.id, status: device.status, resourceType: spec.semanticType },
          executedAt: new Date(),
          executionTime: 0,
        }),
        getHealth: () => ServiceHealthStatusEnum.HEALTHY,
        getStats: () => ({
          totalExecutions: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          averageExecutionTime: 0,
        }),
        isAvailable: () => true,
        getOwner: () => this.agentId,
      } as unknown as AgentService,
      this.agentId,
      this.environment,
      registrationMeta
    );

    logger.info(`[ResourceCoordinator:${this.agentId}] Published service: ${service.id} (${service.name}) [resourceType: ${spec.semanticType}]`);
  }

  /**
   * Get device count
   */
  getDeviceCount(): number {
    return this.resourceManager.getCount();
  }

  /**
   * Get all resources
   */
  getAllResources() {
    return this.resourceManager.getAllResources();
  }
}
