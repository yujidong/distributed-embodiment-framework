/**
 * Auto Discovery
 *
 * Automatic discovery and registration of devices and services.
 * Provides periodic scanning, event-driven updates, and automatic registration.
 */

import { EventEmitter, EventType, EventPriority } from '../events/index.js';
import type { Device, Service, Agent } from '../environment/types.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Discovery event types
 */
const logger = createLogger('AutoDiscovery');

export enum DiscoveryEventType {
  DEVICE_DISCOVERED = 'device.discovered',
  DEVICE_REGISTERED = 'device.registered',
  DEVICE_REMOVED = 'device.removed',
  SERVICE_DISCOVERED = 'service.discovered',
  SERVICE_PUBLISHED = 'service.published',
  AGENT_DISCOVERED = 'agent.discovered',
  SCAN_COMPLETED = 'scan.completed',
}

/**
 * Discovery event
 */
export interface DiscoveryEvent {
  type: DiscoveryEventType;
  timestamp: Date;
  data: any;
}

/**
 * Discovery configuration
 */
export interface DiscoveryConfig {
  scanInterval?: number; // How often to scan (ms)
  enableAutoRegistration?: boolean; // Auto-register discovered devices
  enableAutoServicePublishing?: boolean; // Auto-publish discovered services
  enableEventDrivenUpdates?: boolean; // Enable event-driven discovery
  maxDiscoveryHistory?: number; // Maximum discovery history to keep
}

/**
 * Discovered resource
 */
export interface DiscoveredResource {
  id: string;
  name: string;
  type: 'device' | 'service' | 'agent';
  location?: string;
  capabilities: string[];
  metadata?: Record<string, any>;
  discoveredAt: Date;
  lastSeen: Date;
  registered?: boolean;
}

/**
 * Scan result
 */
export interface DiscoveryScanResult {
  timestamp: Date;
  duration: number; // milliseconds
  devicesDiscovered: number;
  servicesDiscovered: number;
  agentsDiscovered: number;
  resourcesRegistered: number;
  errors: string[];
}

/**
 * Auto Discovery Class
 *
 * Provides automatic discovery of devices, services, and agents.
 * Supports periodic scanning and event-driven discovery.
 */
export class AutoDiscovery {
  private environmentCenter: EnvironmentCenter;
  private eventEmitter: EventEmitter;
  private config: Required<DiscoveryConfig>;

  // Discovery state
  private isScanning: boolean = false;
  private scanInterval?: NodeJS.Timeout;
  private discoveryHistory: DiscoveryEvent[] = [];
  private discoveredResources: Map<string, DiscoveredResource> = new Map();

  // Event listeners
  private eventUnsubscribers: Array<string> = []; // Store subscription IDs

  constructor(environmentCenter: EnvironmentCenter, config: DiscoveryConfig = {}) {
    this.environmentCenter = environmentCenter;
    this.eventEmitter = new EventEmitter(environmentCenter.eventManager, 'auto-discovery');

    // Default configuration
    this.config = {
      scanInterval: config.scanInterval || 30000, // 30 seconds default
      enableAutoRegistration: config.enableAutoRegistration ?? true,
      enableAutoServicePublishing: config.enableAutoServicePublishing ?? true,
      enableEventDrivenUpdates: config.enableEventDrivenUpdates ?? true,
      maxDiscoveryHistory: config.maxDiscoveryHistory || 100,
    };

    logger.info('Initialized with config:', {
      scanInterval: `${this.config.scanInterval}ms`,
      autoRegistration: this.config.enableAutoRegistration,
      autoServicePublishing: this.config.enableAutoServicePublishing,
      eventDriven: this.config.enableEventDrivenUpdates,
    });

    // Subscribe to environment events if event-driven updates enabled
    if (this.config.enableEventDrivenUpdates) {
      this.setupEventListeners();
    }
  }

  /**
   * Start periodic scanning
   */
  startScanning(): void {
    if (this.isScanning) {
      logger.warn('Scanning already started');
      return;
    }

    this.isScanning = true;
    logger.info('Starting periodic scanning...');

    // Initial scan
    this.scan();

    // Set up periodic scans
    this.scanInterval = setInterval(() => {
      this.scan();
    }, this.config.scanInterval);

    logger.info(`Periodic scanning started (interval: ${this.config.scanInterval}ms)`);
  }

  /**
   * Stop periodic scanning
   */
  stopScanning(): void {
    if (!this.isScanning) {
      logger.warn('Scanning not started');
      return;
    }

    this.isScanning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }

    logger.info('Periodic scanning stopped');
  }

  /**
   * Perform a discovery scan
   * @returns Scan result
   */
  scan(): DiscoveryScanResult {
    const startTime = Date.now();
    logger.info('Starting discovery scan...');

    const result: DiscoveryScanResult = {
      timestamp: new Date(),
      duration: 0,
      devicesDiscovered: 0,
      servicesDiscovered: 0,
      agentsDiscovered: 0,
      resourcesRegistered: 0,
      errors: [],
    };

    try {
      // Discover new devices
      const devicesDiscovered = this.discoverNewDevices();
      result.devicesDiscovered = devicesDiscovered.length;

      // Discover removed devices
      const removedDevices = this.discoverRemovedDevices();
      result.devicesDiscovered += removedDevices.length;

      // Discover new services
      const servicesDiscovered = this.discoverNewServices();
      result.servicesDiscovered = servicesDiscovered.length;

      // Discover new agents
      const agentsDiscovered = this.discoverNewAgents();
      result.agentsDiscovered = agentsDiscovered.length;

      // Auto-register resources if enabled
      if (this.config.enableAutoRegistration || this.config.enableAutoServicePublishing) {
        result.resourcesRegistered = this.autoRegisterResources();
      }

      result.duration = Date.now() - startTime;

      logger.info('Scan complete:', {
        devices: result.devicesDiscovered,
        services: result.servicesDiscovered,
        agents: result.agentsDiscovered,
        registered: result.resourcesRegistered,
        duration: `${result.duration}ms`,
      });

      // Emit scan completed event
      this.emitDiscoveryEvent({
        type: DiscoveryEventType.SCAN_COMPLETED,
        timestamp: new Date(),
        data: result,
      });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      logger.error('Scan error:', errorMsg);
    }

    return result;
  }

  /**
   * Discover new devices (not yet registered)
   * @returns Array of discovered devices
   */
  private discoverNewDevices(): Device[] {
    // This is a simplified implementation
    // In a real system, this would scan the network, check databases, etc.
    // For now, we'll return empty array since devices are manually registered

    logger.info('Scanning for new devices...');
    return [];
  }

  /**
   * Discover removed devices
   * @returns Array of removed device IDs
   */
  private discoverRemovedDevices(): string[] {
    const removedDevices: string[] = [];
    const currentTime = new Date();
    const timeout = 60000; // 1 minute timeout

    for (const [id, resource] of this.discoveredResources) {
      if (resource.type === 'device' && !resource.registered) {
        const timeSinceLastSeen = currentTime.getTime() - resource.lastSeen.getTime();
        if (timeSinceLastSeen > timeout) {
          removedDevices.push(id);
          this.discoveredResources.delete(id);
          logger.info(`Removed stale device: ${id}`);
        }
      }
    }

    return removedDevices;
  }

  /**
   * Discover new services
   * @returns Array of discovered services
   */
  private discoverNewServices(): Service[] {
    logger.info('Scanning for new services...');
    // Simplified implementation
    return [];
  }

  /**
   * Discover new agents
   * @returns Array of discovered agents
   */
  private discoverNewAgents(): Agent[] {
    logger.info('Scanning for new agents...');
    // Simplified implementation
    return [];
  }

  /**
   * Auto-register discovered resources
   * @returns Number of resources registered
   */
  private autoRegisterResources(): number {
    let registered = 0;

    for (const [id, resource] of this.discoveredResources) {
      if (resource.registered) {
        continue;
      }

      try {
        if (resource.type === 'device' && this.config.enableAutoRegistration) {
          // Auto-register device
          logger.info(`Auto-registering device: ${id}`);
          // Note: In real implementation, would create device from discovery data
          resource.registered = true;
          registered++;

          this.emitDiscoveryEvent({
            type: DiscoveryEventType.DEVICE_REGISTERED,
            timestamp: new Date(),
            data: { resource },
          });
        }

        if (resource.type === 'service' && this.config.enableAutoServicePublishing) {
          // Auto-publish service
          logger.info(`Auto-publishing service: ${id}`);
          resource.registered = true;
          registered++;

          this.emitDiscoveryEvent({
            type: DiscoveryEventType.SERVICE_PUBLISHED,
            timestamp: new Date(),
            data: { resource },
          });
        }
      } catch (error) {
        logger.error(`Error registering ${resource.type} ${id}:`, error);
      }
    }

    return registered;
  }

  /**
   * Manually register a discovered resource
   * @param resource - Discovered resource
   */
  registerDiscoveredResource(resource: DiscoveredResource): void {
    this.discoveredResources.set(resource.id, {
      ...resource,
      discoveredAt: new Date(),
      lastSeen: new Date(),
      registered: false,
    });

    logger.info(`Registered discovered resource: ${resource.id} (${resource.type})`);

    this.emitDiscoveryEvent({
      type: this.getDiscoveredEventType(resource.type),
      timestamp: new Date(),
      data: { resource },
    });
  }

  /**
   * Get discovered resources
   * @param filter - Optional filter by type
   * @returns Array of discovered resources
   */
  getDiscoveredResources(filter?: 'device' | 'service' | 'agent'): DiscoveredResource[] {
    const resources = Array.from(this.discoveredResources.values());

    if (filter) {
      return resources.filter(r => r.type === filter);
    }

    return resources;
  }

  /**
   * Get discovery history
   * @param limit - Maximum number of events to return
   * @returns Discovery events
   */
  getDiscoveryHistory(limit?: number): DiscoveryEvent[] {
    const historyLimit = limit || this.discoveryHistory.length;
    return this.discoveryHistory.slice(-historyLimit);
  }

  /**
   * Get discovery statistics
   */
  getStats(): {
    isScanning: boolean;
    totalDiscovered: number;
    devicesDiscovered: number;
    servicesDiscovered: number;
    agentsDiscovered: number;
    registeredResources: number;
    scanHistory: number;
  } {
    const resources = Array.from(this.discoveredResources.values());

    return {
      isScanning: this.isScanning,
      totalDiscovered: this.discoveredResources.size,
      devicesDiscovered: resources.filter(r => r.type === 'device').length,
      servicesDiscovered: resources.filter(r => r.type === 'service').length,
      agentsDiscovered: resources.filter(r => r.type === 'agent').length,
      registeredResources: resources.filter(r => r.registered).length,
      scanHistory: this.discoveryHistory.filter(e => e.type === DiscoveryEventType.SCAN_COMPLETED).length,
    };
  }

  /**
   * Clear discovery history
   */
  clearHistory(): void {
    this.discoveryHistory = [];
    logger.info('Discovery history cleared');
  }

  /**
   * Clear all discovered resources
   */
  clearDiscoveredResources(): void {
    this.discoveredResources.clear();
    logger.info('Discovered resources cleared');
  }

  /**
   * Set up event listeners for event-driven discovery
   */
  private setupEventListeners(): void {
    logger.info('Setting up event listeners...');

    // Listen for device registered events
    const deviceUnsub = this.environmentCenter.eventManager.subscribe({
      subscriberId: 'auto-discovery',
      eventType: EventType.DEVICE_REGISTERED,
      handler: (event) => {
        logger.info(`Device registered event: ${event.payload.deviceId}`);
        // Track registered device
        if (this.discoveredResources.has(event.payload.deviceId)) {
          const resource = this.discoveredResources.get(event.payload.deviceId)!;
          resource.registered = true;
          resource.lastSeen = new Date();
        }
      },
      priority: EventPriority.NORMAL,
    });
    this.eventUnsubscribers.push(deviceUnsub);

    // Listen for agent registered events
    const agentUnsub = this.environmentCenter.eventManager.subscribe({
      subscriberId: 'auto-discovery',
      eventType: EventType.AGENT_REGISTERED,
      handler: (event) => {
        logger.info(`Agent registered event: ${event.payload.agentId}`);
        if (this.discoveredResources.has(event.payload.agentId)) {
          const resource = this.discoveredResources.get(event.payload.agentId)!;
          resource.registered = true;
          resource.lastSeen = new Date();
        }
      },
      priority: EventPriority.NORMAL,
    });
    this.eventUnsubscribers.push(agentUnsub);

    logger.info(`Set up ${this.eventUnsubscribers.length} event listeners`);
  }

  /**
   * Emit discovery event
   */
  private emitDiscoveryEvent(event: DiscoveryEvent): void {
    this.discoveryHistory.push(event);

    // Trim history if needed
    if (this.discoveryHistory.length > this.config.maxDiscoveryHistory) {
      this.discoveryHistory = this.discoveryHistory.slice(-this.config.maxDiscoveryHistory);
    }

    // Emit to event manager
    this.eventEmitter.emit(event.type as unknown as EventType, event);
  }

  /**
   * Get discovery event type for resource type
   */
  private getDiscoveredEventType(resourceType: string): DiscoveryEventType {
    switch (resourceType) {
      case 'device':
        return DiscoveryEventType.DEVICE_DISCOVERED;
      case 'service':
        return DiscoveryEventType.SERVICE_DISCOVERED;
      case 'agent':
        return DiscoveryEventType.AGENT_DISCOVERED;
      default:
        return DiscoveryEventType.SCAN_COMPLETED;
    }
  }

  /**
   * Cleanup and destroy
   */
  destroy(): void {
    logger.info('Destroying...');

    this.stopScanning();

    // Unsubscribe from events
    for (const subscriptionId of this.eventUnsubscribers) {
      try {
        this.environmentCenter.eventManager.unsubscribe(subscriptionId);
      } catch (error) {
        logger.error('Error unsubscribing:', error);
      }
    }
    this.eventUnsubscribers = [];

    this.clearHistory();
    this.clearDiscoveredResources();

    logger.info('Destroyed');
  }
}
