/**
 * Resource Auto-Generator
 *
 * Automatically generates enriched Resources from devices with semantic metadata.
 * Enables zero-code resource creation with proper categorization and tagging.
 *
 * Active Collaboration Theory - Core Property 3: Resource Abstraction
 * - Resources abstract devices with semantic metadata
 * - Resources are enriched with context and capabilities
 * - Resources support LLM-friendly specification generation
 */

import { v4 as uuidv4 } from 'uuid';
import type { Resource } from './Resource.js';
import { DeviceResource } from './DeviceResource.js';
import { DeviceType, DeviceStatus, type Device, type DeviceCapability, type ConnectionInfo, type DeviceMetadata } from '@active-collaboration/shared';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device context for resource generation
 */
const logger = createLogger('ResourceAutoGenerator');

export interface ResourceGenDeviceContext {
  id: string;
  name: string;
  type: string;
  location?: string;
  state?: Record<string, any>;
  capabilities?: Array<{
    name: string;
    type: string;
    parameters?: any[];
  }>;
  metadata?: Record<string, any>;
}

/**
 * Environment context for resource enrichment
 */
export interface ResourceGenEnvContext {
  id: string;
  name: string;
  type?: string;
  parameters?: Record<string, any>;
  zones?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
}

/**
 * Generated resource information
 */
export interface GeneratedResource {
  resource: Resource;
  deviceId: string;
  resourceType: string;
  semanticTags: string[];
  inferredCategory: string;
  llmSpec: string; // LLM-friendly specification
}

/**
 * Resource generation options
 */
export interface ResourceGenerationOptions {
  includeSemanticTags?: boolean;
  includeLlmSpec?: boolean;
  enrichWithEnvironmentContext?: boolean;
  defaultOwner?: string;
}

/**
 * Mapping from device types to categories
 */
const DEVICE_TYPE_TO_CATEGORY: Record<string, string> = {
  'temperature-sensor': 'environmental-sensor',
  'humidity-sensor': 'environmental-sensor',
  'pressure-sensor': 'environmental-sensor',
  'motion-sensor': 'security-sensor',
  'presence-sensor': 'security-sensor',
  'light-sensor': 'environmental-sensor',
  'power-meter': 'energy-sensor',
  'thermostat': 'hvac-actuator',
  'smart-light': 'lighting-actuator',
  'smart-lock': 'security-actuator',
  'smart-plug': 'power-actuator',
  'hvac-controller': 'hvac-actuator',
  'sensor': 'sensor',
  'actuator': 'actuator',
  'device': 'device',
};

/**
 * Mapping from device types to semantic tags
 */
const DEVICE_TYPE_TO_TAGS: Record<string, string[]> = {
  'temperature-sensor': ['temperature', 'environmental', 'iot', 'sensor', 'monitoring'],
  'humidity-sensor': ['humidity', 'environmental', 'iot', 'sensor', 'monitoring'],
  'pressure-sensor': ['pressure', 'environmental', 'iot', 'sensor', 'monitoring'],
  'motion-sensor': ['motion', 'security', 'iot', 'sensor', 'presence'],
  'presence-sensor': ['presence', 'occupancy', 'security', 'iot', 'sensor'],
  'light-sensor': ['light', 'illumination', 'environmental', 'iot', 'sensor'],
  'power-meter': ['power', 'energy', 'consumption', 'iot', 'sensor', 'meter'],
  'thermostat': ['temperature', 'hvac', 'control', 'iot', 'actuator', 'climate'],
  'smart-light': ['lighting', 'illumination', 'control', 'iot', 'actuator'],
  'smart-lock': ['security', 'lock', 'access', 'iot', 'actuator'],
  'smart-plug': ['power', 'control', 'energy', 'iot', 'actuator'],
  'hvac-controller': ['hvac', 'climate', 'control', 'iot', 'actuator'],
};

/**
 * Resource Auto-Generator
 */
export class ResourceAutoGenerator {
  private options: ResourceGenerationOptions;

  constructor(options: ResourceGenerationOptions = {}) {
    this.options = {
      includeSemanticTags: true,
      includeLlmSpec: true,
      enrichWithEnvironmentContext: true,
      ...options,
    };
  }

  /**
   * Generate a resource from a device
   */
  generateFromDevice(
    device: ResourceGenDeviceContext,
    owner: string,
    envContext?: ResourceGenEnvContext
  ): GeneratedResource {
    logger.info(`Generating resource for device: ${device.name}`);

    // Infer category and tags
    const inferredCategory = this.inferCategory(device);
    const semanticTags = this.inferSemanticTags(device);

    // Create a minimal Device object for DeviceResource
    const deviceObj: Device = {
      id: device.id,
      name: device.name,
      type: this.mapToDeviceType(device.type),
      status: DeviceStatus.ONLINE,
      capabilities: (device.capabilities || []).map(cap => ({
        name: cap.name,
        type: this.mapToCapabilityType(cap.type),
        parameters: cap.parameters || [],
      })) as DeviceCapability[],
      location: device.location || 'unknown',
      services: [],
      connectionInfo: {
        protocol: 'http',
        endpoint: 'localhost',
      } as ConnectionInfo,
      lastHeartbeat: new Date(),
      metadata: (device.metadata || {}) as DeviceMetadata,
    };

    // Create resource using DeviceResource
    const resource = new DeviceResource(deviceObj, owner);

    // Set additional properties
    resource.tags = semanticTags;

    // Generate LLM specification
    const llmSpec = this.generateLlmSpec(device, inferredCategory, semanticTags, envContext);

    return {
      resource,
      deviceId: device.id,
      resourceType: device.type,
      semanticTags,
      inferredCategory,
      llmSpec,
    };
  }

  /**
   * Generate resources from multiple devices
   */
  generateFromDevices(
    devices: ResourceGenDeviceContext[],
    owner: string,
    envContext?: ResourceGenEnvContext
  ): GeneratedResource[] {
    return devices.map(device => this.generateFromDevice(device, owner, envContext));
  }

  /**
   * Infer category from device
   */
  inferCategory(device: ResourceGenDeviceContext): string {
    const type = device.type.toLowerCase();

    if (DEVICE_TYPE_TO_CATEGORY[type]) {
      return DEVICE_TYPE_TO_CATEGORY[type];
    }

    for (const [key, category] of Object.entries(DEVICE_TYPE_TO_CATEGORY)) {
      if (type.includes(key) || key.includes(type)) {
        return category;
      }
    }

    if (device.capabilities && device.capabilities.length > 0) {
      const hasRead = device.capabilities.some(c => c.type === 'read');
      const hasWrite = device.capabilities.some(c => c.type === 'write' || c.type === 'control');

      if (hasRead && !hasWrite) return 'sensor';
      if (hasWrite && !hasRead) return 'actuator';
      if (hasRead && hasWrite) return 'composite';
    }

    return 'device';
  }

  /**
   * Infer semantic tags from device
   */
  inferSemanticTags(device: ResourceGenDeviceContext): string[] {
    const tags: Set<string> = new Set();
    const type = device.type.toLowerCase();

    if (DEVICE_TYPE_TO_TAGS[type]) {
      DEVICE_TYPE_TO_TAGS[type].forEach(tag => tags.add(tag));
    }

    for (const [key, typeTags] of Object.entries(DEVICE_TYPE_TO_TAGS)) {
      if (type.includes(key)) {
        typeTags.forEach(tag => tags.add(tag));
      }
    }

    if (device.capabilities) {
      for (const cap of device.capabilities) {
        tags.add(cap.name.toLowerCase());
        tags.add(cap.type.toLowerCase());
      }
    }

    if (device.location) {
      tags.add('location-aware');
      const locationParts = device.location.split('/');
      locationParts.forEach(part => {
        if (part) tags.add(part.toLowerCase());
      });
    }

    if (device.metadata) {
      if (device.metadata.criticality) {
        tags.add(`criticality:${device.metadata.criticality}`);
      }
      if (device.metadata.zone) {
        tags.add(`zone:${device.metadata.zone}`);
      }
    }

    return Array.from(tags);
  }

  /**
   * Generate LLM-friendly specification
   */
  generateLlmSpec(
    device: ResourceGenDeviceContext,
    category: string,
    tags: string[],
    envContext?: ResourceGenEnvContext
  ): string {
    const lines: string[] = [];

    lines.push(`# Resource: ${device.name}`);
    lines.push(`- ID: ${device.id}`);
    lines.push(`- Type: ${device.type}`);
    lines.push(`- Category: ${category}`);
    lines.push('');

    lines.push('## Description');
    lines.push(this.generateDescription(device, category));
    lines.push('');

    if (device.capabilities && device.capabilities.length > 0) {
      lines.push('## Capabilities');
      for (const cap of device.capabilities) {
        lines.push(`- **${cap.name}** (${cap.type})`);
        if (cap.parameters && cap.parameters.length > 0) {
          lines.push(`  - Parameters: ${cap.parameters.map((p: any) => p.name).join(', ')}`);
        }
      }
      lines.push('');
    }

    if (device.location) {
      lines.push('## Location');
      lines.push(`- Path: ${device.location}`);
      lines.push('');
    }

    lines.push('## Tags');
    lines.push(tags.map(t => `\`${t}\``).join(', '));
    lines.push('');

    if (envContext && this.options.enrichWithEnvironmentContext) {
      lines.push('## Environment Context');
      lines.push(`- Environment: ${envContext.name}`);
      if (envContext.type) {
        lines.push(`- Type: ${envContext.type}`);
      }
      lines.push('');
    }

    if (device.state && Object.keys(device.state).length > 0) {
      lines.push('## Current State');
      for (const [key, value] of Object.entries(device.state)) {
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        lines.push(`- ${key}: ${displayValue}`);
      }
      lines.push('');
    }

    lines.push('## Usage Hints');
    lines.push(this.generateUsageHints(device, category));

    return lines.join('\n');
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Generate natural language description
   */
  private generateDescription(device: ResourceGenDeviceContext, category: string): string {
    const parts: string[] = [];

    if (category.includes('sensor')) {
      parts.push(`${device.name} is a sensing device that monitors environmental or system conditions.`);
    } else if (category.includes('actuator')) {
      parts.push(`${device.name} is an actuation device that can control or modify the environment.`);
    } else {
      parts.push(`${device.name} is a ${device.type} device.`);
    }

    if (device.capabilities && device.capabilities.length > 0) {
      const readCaps = device.capabilities.filter(c => c.type === 'read').map(c => c.name);
      const writeCaps = device.capabilities.filter(c => c.type === 'write' || c.type === 'control').map(c => c.name);

      if (readCaps.length > 0) {
        parts.push(`It can read: ${readCaps.join(', ')}.`);
      }
      if (writeCaps.length > 0) {
        parts.push(`It can control: ${writeCaps.join(', ')}.`);
      }
    }

    if (device.location) {
      parts.push(`Located at: ${device.location}.`);
    }

    return parts.join(' ');
  }

  /**
   * Generate usage hints for LLM
   */
  private generateUsageHints(device: ResourceGenDeviceContext, category: string): string {
    const hints: string[] = [];

    if (category.includes('sensor')) {
      hints.push('- Use this resource to monitor conditions');
      hints.push('- Poll periodically or subscribe to events for updates');
      hints.push('- Check `state` property for current readings');
    } else if (category.includes('actuator')) {
      hints.push('- Use this resource to control the environment');
      hints.push('- Send commands via the `execute` method');
      hints.push('- Verify state changes after actuation');
    }

    if (device.capabilities) {
      const hasEvent = device.capabilities.some(c => c.type === 'event');
      if (hasEvent) {
        hints.push('- This resource can emit events on state changes');
      }
    }

    if (device.metadata?.criticality === 'critical') {
      hints.push('- **CRITICAL**: This resource requires careful handling');
    }

    return hints.join('\n');
  }

  /**
   * Map string type to DeviceType enum
   */
  private mapToDeviceType(type: string): DeviceType {
    const typeMap: Record<string, DeviceType> = {
      'sensor': DeviceType.SENSOR,
      'actuator': DeviceType.ACTUATOR,
      'controller': DeviceType.CONTROLLER,
      'hybrid': DeviceType.HYBRID,
    };

    const normalizedType = type.toLowerCase();
    for (const [key, deviceType] of Object.entries(typeMap)) {
      if (normalizedType.includes(key)) {
        return deviceType;
      }
    }

    return DeviceType.SENSOR; // Default
  }

  /**
   * Map string type to CapabilityType
   */
  private mapToCapabilityType(type: string): 'read' | 'write' | 'execute' {
    const normalizedType = type.toLowerCase();
    if (normalizedType === 'control' || normalizedType === 'write') {
      return 'write';
    }
    if (normalizedType === 'execute' || normalizedType === 'action') {
      return 'execute';
    }
    return 'read'; // Default
  }
}
