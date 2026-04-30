/**
 * Service Auto-Generator
 *
 * Automatically generates SemanticServices from device capabilities.
 * Enables zero-code service creation with proper semantic annotations.
 *
 * Active Collaboration Theory - Core Property 2: Semantic Self-Awareness
 * - Services are generated with semantic annotations
 * - Ontology classes are inferred from capability types
 * - Semantic relationships are established automatically
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentService, ServiceExecutionContext, ServiceExecutionResult, ServiceStats, ProviderInfo } from './Service.js';
import { ServiceHealthStatus } from './Service.js';
import type { HTTPMethod, ParameterDefinition } from '@active-collaboration/shared';
import {
  SemanticService,
  ServiceOntologyClass,
  SemanticAnnotation,
  SemanticAnnotationType,
  ServiceRelationshipType,
  createSemanticService,
  addSemanticAnnotation,
} from './SemanticService.js';

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ServiceAutoGenerator');

/**
 * Bridge execution function type
 * Accepts capability name and context, returns execution result
 */
export type BridgeExecutionFn = (
  capabilityName: string,
  deviceId: string,
  context: ServiceExecutionContext
) => Promise<ServiceExecutionResult>;

/**
 * Simple implementation of AgentService for auto-generated services
 * Supports bridge execution to route service calls to device commands
 */
class SimpleAgentService implements AgentService {
  private _stats: ServiceStats = {
    totalExecutions: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    averageExecutionTime: 0,
  };

  private _bridgeFn: BridgeExecutionFn | null = null;
  /**
   * The explicit capability name this service targets on the device.
   * Used by CommandBridge to look up the correct resource and command.
   */
  public readonly targetCapabilityName: string;

  constructor(
    public readonly id: string,
    public name: string,
    public description: string,
    public category: string,
    private _owner: string,
    public location: string,
    public deviceId: string,
    targetCapabilityName?: string,
    public uri: string = 'auto-generated',
    public httpMethod: HTTPMethod = 'GET',
    public parameters: ParameterDefinition[] = [],
    public isConditional: boolean = false
  ) {
    this.targetCapabilityName = targetCapabilityName || category;
  }

  /**
   * Set the bridge execution function for routing to device commands
   */
  setBridgeExecutionFn(fn: BridgeExecutionFn): void {
    this._bridgeFn = fn;
  }

  async execute(context: ServiceExecutionContext): Promise<ServiceExecutionResult> {
    this._stats.totalExecutions++;
    const startTime = Date.now();

    // If a bridge function is set, route through CommandBridge → Resource → Device
    if (this._bridgeFn) {
      try {
        const result = await this._bridgeFn(this.targetCapabilityName, this.deviceId, context);
        const executionTime = Date.now() - startTime;

        if (result.success) {
          this._stats.successfulExecutions++;
        } else {
          this._stats.failedExecutions++;
        }
        this._updateAverageExecutionTime(executionTime);

        return {
          ...result,
          executedAt: new Date(),
          executionTime,
        };
      } catch (error) {
        const executionTime = Date.now() - startTime;
        this._stats.failedExecutions++;
        this._updateAverageExecutionTime(executionTime);

        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          executedAt: new Date(),
          executionTime,
        };
      }
    }

    // No bridge configured
    const executionTime = Date.now() - startTime;

    // Device-derived service without bridge — configuration error (Fail Early principle)
    if (this.deviceId && this.deviceId !== 'auto-generated' && this.deviceId !== 'unknown') {
      this._stats.failedExecutions++;
      this._updateAverageExecutionTime(executionTime);
      return {
        success: false,
        error: `Device-derived service '${this.id}' has no CommandBridge configured. ` +
          `Service cannot execute device command '${this.targetCapabilityName}' on device '${this.deviceId}'.`,
        executedAt: new Date(),
        executionTime,
      };
    }

    // Pure service (non-device-derived) — OK to succeed without bridge
    return {
      success: true,
      executedAt: new Date(),
      executionTime,
    };
  }

  private _updateAverageExecutionTime(executionTime: number): void {
    const total = this._stats.totalExecutions;
    this._stats.averageExecutionTime =
      (this._stats.averageExecutionTime * (total - 1) + executionTime) / total;
  }

  getHealth(): ServiceHealthStatus {
    return ServiceHealthStatus.HEALTHY;
  }

  getStats(): ServiceStats {
    return { ...this._stats };
  }

  isAvailable(): boolean {
    return true;
  }

  getOwner(): string {
    return this._owner;
  }

  getProviderInfo(): ProviderInfo {
    return {
      providerAgentId: this._owner,
      providerAgentName: this._owner,
    };
  }
}

/**
 * Device capability info for service generation
 */


export interface ServiceGenCapability {
  name: string;
  type: string; // 'read' | 'write' | 'execute' | 'event' | 'composite'
  parameters?: Array<{
    name: string;
    type: string;
    required?: boolean;
    defaultValue?: unknown;
  }>;
  description?: string;
}

/**
 * Device context for service generation
 */
export interface ServiceGenDeviceContext {
  id: string;
  name: string;
  type: string;
  location?: string;
  metadata?: Record<string, any>;
}

/**
 * Generated service information
 */
export interface GeneratedService {
  service: SemanticService;
  capabilityName: string;
  ontologyClass: ServiceOntologyClass;
  inferredCapabilities: string[];
}

/**
 * Set the bridge execution function on a generated service
 * This connects the auto-generated service to CommandBridge for device command execution
 */
export function setBridgeOnGeneratedService(
  generated: GeneratedService,
  bridgeFn: BridgeExecutionFn
): void {
  const service = generated.service as unknown as { setBridgeExecutionFn?: (fn: BridgeExecutionFn) => void };
  if (service.setBridgeExecutionFn) {
    service.setBridgeExecutionFn(bridgeFn);
  }
}

/**
 * Service generation options
 */
export interface ServiceGenerationOptions {
  includeImplicitCapabilities?: boolean;
  enrichWithMetadata?: boolean;
  defaultOwner?: string;
  semanticInferenceLevel?: 'basic' | 'standard' | 'advanced';
}

/**
 * Mapping from capability types to ontology classes
 */
const CAPABILITY_TO_ONTOLOGY: Record<string, ServiceOntologyClass[]> = {
  'temperature': [ServiceOntologyClass.SSN_TEMPERATURE_SERVICE, ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE],
  'temp': [ServiceOntologyClass.SSN_TEMPERATURE_SERVICE, ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE],
  'humidity': [ServiceOntologyClass.SSN_HUMIDITY_SERVICE],
  'pressure': [ServiceOntologyClass.SSN_PRESSURE_SERVICE],
  'presence': [ServiceOntologyClass.SSN_PRESENCE_SERVICE],
  'occupancy': [ServiceOntologyClass.SSN_PRESENCE_SERVICE],
  'motion': [ServiceOntologyClass.SSN_PRESENCE_SERVICE],
  'light': [ServiceOntologyClass.SAREF_LIGHTING_SERVICE],
  'lighting': [ServiceOntologyClass.SAREF_LIGHTING_SERVICE],
  'illumination': [ServiceOntologyClass.SAREF_LIGHTING_SERVICE],
  'hvac': [ServiceOntologyClass.SAREF_HVAC_SERVICE],
  'heating': [ServiceOntologyClass.SAREF_HVAC_SERVICE],
  'cooling': [ServiceOntologyClass.SAREF_HVAC_SERVICE],
  'ventilation': [ServiceOntologyClass.SAREF_HVAC_SERVICE],
  'thermostat': [ServiceOntologyClass.SAREF_HVAC_SERVICE, ServiceOntologyClass.SAREF_TEMPERATURE_SERVICE],
  'security': [ServiceOntologyClass.SAREF_SECURITY_SERVICE],
  'lock': [ServiceOntologyClass.SAREF_SECURITY_SERVICE],
  'alarm': [ServiceOntologyClass.SAREF_SECURITY_SERVICE, ServiceOntologyClass.IOT_EMERGENCY_SERVICE],
  'camera': [ServiceOntologyClass.SAREF_SECURITY_SERVICE],
  'energy': [ServiceOntologyClass.SAREF_ENERGY_SERVICE],
  'power': [ServiceOntologyClass.SAREF_ENERGY_SERVICE],
  'electricity': [ServiceOntologyClass.SAREF_ENERGY_SERVICE],
  'sensor': [ServiceOntologyClass.SSN_SENSING_SERVICE],
  'actuator': [ServiceOntologyClass.SAREF_ACTUATION_SERVICE],
  'control': [ServiceOntologyClass.IOT_CONTROL_SERVICE],
  'monitor': [ServiceOntologyClass.IOT_MONITORING_SERVICE],
  'analytics': [ServiceOntologyClass.IOT_ANALYTICS_SERVICE],
};

/**
 * Service Auto-Generator
 */
export class ServiceAutoGenerator {
  private options: ServiceGenerationOptions;

  constructor(options: ServiceGenerationOptions = {}) {
    this.options = {
      includeImplicitCapabilities: true,
      enrichWithMetadata: true,
      semanticInferenceLevel: 'standard',
      ...options,
    };
  }

  /**
   * Generate services from a single device
   */
  generateFromDevice(
    device: ServiceGenDeviceContext,
    capabilities: ServiceGenCapability[],
    owner: string
  ): GeneratedService[] {
    logger.info(`Generating services for device: ${device.name}`);

    const generatedServices: GeneratedService[] = [];

    for (const capability of capabilities) {
      const generated = this.generateServiceForCapability(device, capability, owner);
      if (generated) {
        generatedServices.push(generated);
      }
    }

    if (this.options.includeImplicitCapabilities && capabilities.length > 1) {
      const compositeServices = this.generateCompositeServices(device, capabilities, owner);
      generatedServices.push(...compositeServices);
    }

    logger.info(`Generated ${generatedServices.length} services for ${device.name}`);
    return generatedServices;
  }

  /**
   * Generate services for multiple devices
   */
  generateFromDevices(
    devices: Array<{ device: ServiceGenDeviceContext; capabilities: ServiceGenCapability[] }>,
    owner: string
  ): GeneratedService[] {
    const allServices: GeneratedService[] = [];

    for (const { device, capabilities } of devices) {
      const services = this.generateFromDevice(device, capabilities, owner);
      allServices.push(...services);
    }

    return allServices;
  }

  /**
   * Infer ontology classes from capability
   */
  inferOntologyClasses(capability: ServiceGenCapability): ServiceOntologyClass[] {
    const name = capability.name.toLowerCase();
    const type = capability.type.toLowerCase();

    for (const [key, classes] of Object.entries(CAPABILITY_TO_ONTOLOGY)) {
      if (name.includes(key)) {
        return classes;
      }
    }

    if (type === 'read' || type === 'event') {
      return [ServiceOntologyClass.SSN_SENSING_SERVICE];
    } else if (type === 'write' || type === 'control') {
      return [ServiceOntologyClass.SAREF_ACTUATION_SERVICE];
    } else if (type === 'composite') {
      return [ServiceOntologyClass.IOT_COMPOSITE_SERVICE];
    }

    return [ServiceOntologyClass.IOT_MONITORING_SERVICE];
  }

  /**
   * Infer semantic capabilities from capability
   */
  inferSemanticCapabilities(capability: ServiceGenCapability): string[] {
    const capabilities: string[] = [];
    const name = capability.name.toLowerCase();

    capabilities.push(`Provides ${capability.name} functionality`);

    if (capability.type === 'read') {
      capabilities.push('Can read sensor data');
      capabilities.push('Provides observation data');
    } else if (capability.type === 'write' || capability.type === 'control') {
      capabilities.push('Can control/actuate');
      capabilities.push('Accepts commands');
    } else if (capability.type === 'event') {
      capabilities.push('Generates events');
      capabilities.push('Supports event subscription');
    }

    if (name.includes('temperature')) {
      capabilities.push('Measures temperature');
    }
    if (name.includes('humidity')) {
      capabilities.push('Measures relative humidity');
    }
    if (name.includes('light') || name.includes('illumination')) {
      capabilities.push('Controls or measures lighting');
    }
    if (name.includes('power') || name.includes('energy')) {
      capabilities.push('Monitors power consumption');
    }

    return capabilities;
  }

  /**
   * Generate service schema from capability parameters
   */
  inferServiceSchema(capability: ServiceGenCapability): {
    inputSchema: Record<string, any>;
    outputSchema: Record<string, any>;
  } {
    const inputSchema: Record<string, any> = {
      type: 'object',
      properties: {},
      required: [],
    };

    const outputSchema: Record<string, any> = {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        timestamp: { type: 'string', format: 'date-time' },
      },
      required: ['success'],
    };

    if (capability.parameters) {
      for (const param of capability.parameters) {
        inputSchema.properties[param.name] = {
          type: this.mapParameterType(param.type),
          description: `${param.name} parameter`,
        };
        if (param.required) {
          inputSchema.required.push(param.name);
        }
      }
    }

    if (capability.type === 'read' || capability.type === 'event') {
      outputSchema.properties.data = { type: 'object', description: 'Sensor reading data' };
      outputSchema.properties.value = { type: 'number', description: 'Sensor value' };
      outputSchema.properties.unit = { type: 'string', description: 'Unit of measurement' };
    }

    return { inputSchema, outputSchema };
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Generate a service for a single capability
   */
  private generateServiceForCapability(
    device: ServiceGenDeviceContext,
    capability: ServiceGenCapability,
    owner: string
  ): GeneratedService | null {
    const ontologyClasses = this.inferOntologyClasses(capability);
    const primaryOntologyClass = ontologyClasses[0];
    const semanticCapabilities = this.inferSemanticCapabilities(capability);

    const serviceId = `svc-${device.id}-${capability.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Create a base AgentService using SimpleAgentService
    const baseService = new SimpleAgentService(
      serviceId,
      `${device.name} - ${capability.name}`,
      capability.description || `Auto-generated ${capability.name} service for ${device.name}`,
      this.inferCategory(capability),
      owner,
      device.location || 'unknown',
      device.id,
      capability.name  // targetCapabilityName
    );

    // Create semantic service using helper
    const semanticService = createSemanticService(baseService, primaryOntologyClass, {
      qosProperties: {
        priority: 5,
      },
      context: device.location ? {
        location: device.location,
      } : undefined,
    });

    // Add semantic annotations
    addSemanticAnnotation(semanticService, SemanticAnnotationType.RDFS_LABEL, `${capability.name} Service`);
    addSemanticAnnotation(semanticService, SemanticAnnotationType.RDFS_COMMENT,
      capability.description || `Auto-generated service for ${capability.name} capability`);
    addSemanticAnnotation(semanticService, SemanticAnnotationType.CAPABILITY,
      semanticCapabilities.join('; '));

    if (device.location) {
      addSemanticAnnotation(semanticService, SemanticAnnotationType.CONTEXT, `location:${device.location}`);
    }

    return {
      service: semanticService,
      capabilityName: capability.name,
      ontologyClass: primaryOntologyClass,
      inferredCapabilities: semanticCapabilities,
    };
  }

  /**
   * Generate composite services from multiple capabilities
   */
  private generateCompositeServices(
    device: ServiceGenDeviceContext,
    capabilities: ServiceGenCapability[],
    owner: string
  ): GeneratedService[] {
    const compositeServices: GeneratedService[] = [];

    const readCapabilities = capabilities.filter(c => c.type === 'read' || c.type === 'event');
    const writeCapabilities = capabilities.filter(c => c.type === 'write' || c.type === 'control');

    if (readCapabilities.length > 1) {
      const monitoringService = this.createMonitoringComposite(device, readCapabilities, owner);
      compositeServices.push(monitoringService);
    }

    if (writeCapabilities.length > 1) {
      const controlService = this.createControlComposite(device, writeCapabilities, owner);
      compositeServices.push(controlService);
    }

    return compositeServices;
  }

  /**
   * Create monitoring composite service
   */
  private createMonitoringComposite(
    device: ServiceGenDeviceContext,
    capabilities: ServiceGenCapability[],
    owner: string
  ): GeneratedService {
    const serviceId = `svc-${device.id}-monitoring-composite`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const baseService = new SimpleAgentService(
      serviceId,
      `${device.name} - Monitoring Composite`,
      `Composite monitoring service aggregating ${capabilities.length} sensors`,
      'monitoring',
      owner,
      device.location || 'unknown',
      device.id,
      'monitoring-composite'  // targetCapabilityName
    );

    const semanticService = createSemanticService(baseService, ServiceOntologyClass.IOT_MONITORING_SERVICE, {
      context: device.location ? { location: device.location } : undefined,
    });

    addSemanticAnnotation(semanticService, SemanticAnnotationType.RDFS_LABEL, `${device.name} Monitoring Service`);
    addSemanticAnnotation(semanticService, SemanticAnnotationType.COMPOSITION, capabilities.map(c => c.name).join(', '));

    return {
      service: semanticService,
      capabilityName: 'monitoring-composite',
      ontologyClass: ServiceOntologyClass.IOT_MONITORING_SERVICE,
      inferredCapabilities: ['Aggregates multiple sensors', 'Provides unified monitoring interface'],
    };
  }

  /**
   * Create control composite service
   */
  private createControlComposite(
    device: ServiceGenDeviceContext,
    capabilities: ServiceGenCapability[],
    owner: string
  ): GeneratedService {
    const serviceId = `svc-${device.id}-control-composite`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const baseService = new SimpleAgentService(
      serviceId,
      `${device.name} - Control Composite`,
      `Composite control service for ${capabilities.length} actuators`,
      'control',
      owner,
      device.location || 'unknown',
      device.id,
      'control-composite'  // targetCapabilityName
    );

    const semanticService = createSemanticService(baseService, ServiceOntologyClass.IOT_CONTROL_SERVICE, {
      context: device.location ? { location: device.location } : undefined,
    });

    addSemanticAnnotation(semanticService, SemanticAnnotationType.RDFS_LABEL, `${device.name} Control Service`);
    addSemanticAnnotation(semanticService, SemanticAnnotationType.COMPOSITION, capabilities.map(c => c.name).join(', '));

    return {
      service: semanticService,
      capabilityName: 'control-composite',
      ontologyClass: ServiceOntologyClass.IOT_CONTROL_SERVICE,
      inferredCapabilities: ['Controls multiple actuators', 'Provides unified control interface'],
    };
  }

  /**
   * Infer service category from capability
   */
  private inferCategory(capability: ServiceGenCapability): string {
    const name = capability.name.toLowerCase();

    if (name.includes('temperature') || name.includes('humidity') || name.includes('pressure')) {
      return 'environmental';
    }
    if (name.includes('light') || name.includes('illumination')) {
      return 'lighting';
    }
    if (name.includes('hvac') || name.includes('heating') || name.includes('cooling')) {
      return 'hvac';
    }
    if (name.includes('security') || name.includes('lock') || name.includes('alarm')) {
      return 'security';
    }
    if (name.includes('power') || name.includes('energy')) {
      return 'energy';
    }

    return capability.type;
  }

  /**
   * Map parameter type to JSON Schema type
   */
  private mapParameterType(type: string): string {
    const typeMap: Record<string, string> = {
      'number': 'number',
      'integer': 'integer',
      'string': 'string',
      'boolean': 'boolean',
      'object': 'object',
      'array': 'array',
    };
    return typeMap[type.toLowerCase()] || 'string';
  }
}
