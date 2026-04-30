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

import type { Device, ParameterType } from '@active-collaboration/shared';
import type { ResourceManager } from '../../resource/ResourceManager.js';
import type { ServicePublisher } from '../../service/ServicePublisher.js';
import type { ServiceRegistry } from '../../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../../environment/EnvironmentCenter.js';
import type { Service } from '@active-collaboration/shared';
import type { AgentService, ServiceExecutionContext, ServiceExecutionResult } from '../../service/Service.js';
import { ServiceHealthStatus as ServiceHealthStatusEnum } from '../../service/Service.js';

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
    private agentCapabilities: string[]
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
   */
  private publishDeviceAsService(device: Device): void {
    const resourceType = this.mapDeviceToResourceType(device);

    // Extract capabilities and determine actionType from device capabilities
    const deviceCapabilities = device.capabilities || [];
    const deviceCapabilityNames = deviceCapabilities.map(cap => cap.name);

    // ENHANCED: Combine device capabilities with agent capabilities
    // This ensures that service discovery can match based on agent's functional capabilities
    // For example, an agent with 'temperature-monitoring' capability can provide 'monitoring' service
    const allCapabilities = new Set([
      ...deviceCapabilityNames,
      ...this.agentCapabilities, // Include agent's own capabilities
    ]);

    // Also add derived capabilities based on device type and agent capabilities
    // This helps with semantic matching
    const derivedCapabilities = this.deriveServiceCapabilities(device, this.agentCapabilities);
    derivedCapabilities.forEach(cap => allCapabilities.add(cap));

    const capabilityNames = Array.from(allCapabilities);

    logger.info(`[ResourceCoordinator:${this.agentId}] Service capabilities: device=${deviceCapabilityNames.join(',')}, agent=${this.agentCapabilities.join(',')}, combined=${capabilityNames.join(',')}`);

    // Determine actionType based on capability types
    const hasReadCapabilities = deviceCapabilities.some(cap => cap.type === 'read');
    const hasWriteCapabilities = deviceCapabilities.some(cap => cap.type === 'write' || cap.type === 'execute');

    let actionType: 'observe' | 'control' | 'both' = 'observe';
    if (hasReadCapabilities && hasWriteCapabilities) {
      actionType = 'both';
    } else if (hasWriteCapabilities) {
      actionType = 'control';
    }

    const service: Service = {
      id: `service-${device.id}`,
      name: `${device.name} Service`,
      description: `Service provided by device ${device.name}`,
      deviceId: device.id,
      uri: `device://${device.id}`,
      httpMethod: 'GET',
      parameters: deviceCapabilities.map(cap => ({
        name: cap.name,
        type: this.mapCapabilityTypeToParameterType(cap.type) as ParameterType,
        required: false,
        description: `${cap.name} parameter`,
      })),
      location: device.location,
      category: resourceType, // Use resource type as category for workflow matching
      isConditional: false,
      // Service capability metadata for automatic matching
      actionType,
      capabilities: capabilityNames,
    };

    // Register service with environment center
    this.environment.registerService(service, this.agentId, device.id);

    // Publish service
    this.servicePublisher.publishService(
      {
        ...service,
        execute: async () => ({
          success: true,
          result: { deviceId: device.id, status: device.status, resourceType },
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
      this.environment
    );

    logger.info(`[ResourceCoordinator:${this.agentId}] Published service: ${service.id} (${service.name}) [resourceType: ${resourceType}]`);
  }

  /**
   * Derive additional service capabilities from device and agent capabilities
   * This helps with semantic matching in service discovery
   * Extracted from CognitiveAgent.deriveServiceCapabilities() (lines 1705-1789)
   */
  private deriveServiceCapabilities(device: Device, agentCapabilities: string[]): string[] {
    const derived: string[] = [];
    const deviceType = device.type?.toLowerCase() || '';
    const deviceName = device.name.toLowerCase();

    // Combine device type/name with agent capabilities to derive new capabilities
    // For example, if agent has 'monitoring' capability and device is a temperature sensor,
    // we can derive 'temperature-monitoring' capability

    for (const agentCap of agentCapabilities) {
      const agentCapLower = agentCap.toLowerCase();

      // Check for monitoring capability combinations
      if (agentCapLower.includes('monitoring') || agentCapLower.includes('sensing')) {
        if (deviceType.includes('temp') || deviceName.includes('temp')) {
          derived.push('temperature-monitoring');
          derived.push('temperature-sensor');
          derived.push('sensing');
        }
        if (deviceType.includes('humidity') || deviceName.includes('humidity')) {
          derived.push('humidity-monitoring');
          derived.push('humidity-sensor');
        }
        if (deviceType.includes('motion') || deviceName.includes('motion')) {
          derived.push('motion-monitoring');
          derived.push('motion-sensor');
        }
      }

      // Check for control capability combinations
      if (agentCapLower.includes('control') || agentCapLower.includes('actuation')) {
        if (deviceType.includes('hvac') || deviceName.includes('hvac') || deviceName.includes('thermostat')) {
          derived.push('hvac-control');
          derived.push('temperature-control');
          derived.push('cooling');
          derived.push('heating');
        }
        if (deviceType.includes('light') || deviceName.includes('light')) {
          derived.push('lighting-control');
        }
        if (deviceType.includes('curtain') || deviceName.includes('curtain') || deviceName.includes('blind')) {
          derived.push('curtain-control');
        }
      }

      // Add the agent capability itself if not already present
      derived.push(agentCap);
    }

    // Also derive from device capabilities
    const deviceCapabilities = device.capabilities || [];
    for (const deviceCap of deviceCapabilities) {
      const capName = deviceCap.name.toLowerCase();
      const capType = deviceCap.type?.toLowerCase() || '';

      // Read capabilities -> monitoring/sensing
      if (capType === 'read') {
        if (capName.includes('temp')) {
          derived.push('monitoring');
          derived.push('sensing');
          derived.push('temperature-monitoring');
        }
        if (capName.includes('humidity')) {
          derived.push('monitoring');
          derived.push('humidity-monitoring');
        }
      }

      // Write/execute capabilities -> control/actuation
      if (capType === 'write' || capType === 'execute') {
        derived.push('control');
        derived.push('actuation');

        if (capName.includes('hvac') || capName.includes('temp')) {
          derived.push('temperature-control');
          derived.push('hvac-control');
        }
      }
    }

    return derived;
  }

  /**
   * Map device to resource type
   * Extracted from CognitiveAgent.mapDeviceToResourceType() (lines 1793-1925)
   */
  private mapDeviceToResourceType(device: Device): string {
    const deviceType = device.type?.toLowerCase() || '';

    if (deviceType.includes('sensor')) return 'sensor';
    if (deviceType.includes('actuator')) return 'actuator';
    if (deviceType.includes('thermostat')) return 'thermostat';
    if (deviceType.includes('light') || deviceType.includes('lamp')) return 'lighting';
    if (deviceType.includes('camera')) return 'security';
    if (deviceType.includes('lock')) return 'security';
    if (deviceType.includes('switch')) return 'switch';
    if (deviceType.includes('outlet') || deviceType.includes('plug')) return 'power';
    if (deviceType.includes('speaker')) return 'audio';
    if (deviceType.includes('display') || deviceType.includes('screen')) return 'display';
    if (deviceType.includes('hvac')) return 'hvac';
    if (deviceType.includes('curtain') || deviceType.includes('blind')) return 'curtain';
    if (deviceType.includes('appliance')) return 'appliance';

    return 'device';
  }

  /**
   * Map capability type to parameter type
   * Extracted from CognitiveAgent.mapCapabilityTypeToParameterType() (lines 1926-1941)
   */
  private mapCapabilityTypeToParameterType(capType: string): string {
    const typeMap: Record<string, string> = {
      'read': 'string',
      'write': 'string',
      'execute': 'string',
      'number': 'number',
      'boolean': 'boolean',
      'integer': 'integer',
      'float': 'number',
      'string': 'string',
      'array': 'array',
      'object': 'object',
    };

    return typeMap[capType?.toLowerCase()] || 'string';
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
