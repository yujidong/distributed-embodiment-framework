/**
 * Agent Context Builder
 *
 * Builds complete context information for LLM decision-making.
 * Core principle: LLM decision quality depends on context completeness.
 *
 * Context includes:
 * 1. Agent self-info - identity, capabilities, role
 * 2. Environment state - physical environment, location, current status
 * 3. Resource details - devices, capabilities and real-time status of each device
 * 4. Service info - own services and accessible services from other agents
 * 5. Collaboration network - other agents and their capabilities
 * 6. Task history - previous decisions and outcomes
 * 7. Constraints - safety constraints, priorities, limitations
 *
 * Extended with Resource-Service Ontology as per ARCHITECTURE.md
 * Section: Resource-Service Ontology Architecture
 */

import type { ResourceManager } from '../resource/ResourceManager.js';
import type { ServiceRegistry } from '../service/ServiceRegistry.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import { ServiceOntologyManager } from '../service/ontologies/ServiceOntology.js';
import { DeviceType } from '@active-collaboration/shared';
import type { ResourceOntology } from '../resource/Resource.js';
import type { ServiceOntology } from '../service/SemanticService.js';

// Section-based architecture imports
import {
  type ContextSection,
  type SectionContext,
  buildSections,
  AgentIdentitySection,
  EnvironmentSection,
  ResourcesSection,
  ServicesSection,
  PeersSection,
  TemporalSection,
  TaskSection,
  OntologyResourcesSection,
  OntologyServicesSection,
  OntologyReasoningSection,
} from './sections/index.js';
import { OntologyContextComposer, type OntologyContextResult } from './OntologyContextComposer.js';
import { OntologyReasoningEngine } from '../ontology/OntologyReasoningEngine.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Device state information
 */
const logger = createLogger('AgentContextBuilder');

export interface DeviceStateInfo {
  id: string;
  name: string;
  type: string;
  location?: string;
  capabilities: string[];
  currentState: Record<string, unknown>;
  isOnline: boolean;
  lastUpdate?: Date;
  // Ontology information for semantic reasoning (legacy string format)
  ontology?: string;
  semanticContext?: string;
  // New: Structured Resource Ontology for semantic reasoning
  resourceOntology?: ResourceOntology;
}

/**
 * Service information
 */
export interface ServiceInfo {
  id: string;
  name: string;
  providerAgentId: string;
  providerAgentName: string;
  category: string;
  capabilities: string[];
  status: 'available' | 'busy' | 'offline';
  description?: string;
  // New: Structured Service Ontology for semantic reasoning
  serviceOntology?: ServiceOntology;
}

/**
 * Peer agent information
 */
export interface PeerAgentInfo {
  id: string;
  name: string;
  capabilities: string[];
  services: ServiceInfo[];
  status: string;
}

/**
 * Environment state
 */
export interface EnvironmentState {
  id: string;
  name: string;
  type: string;
  physicalState?: Record<string, unknown>;  // Physical parameters like temperature, humidity
  zones?: Array<{
    id: string;
    name: string;
    location: string;
    state: Record<string, unknown>;
  }>;
}

/**
 * Complete agent context for LLM decision-making
 * Named FullAgentContext to avoid conflict with AgentContext in proposal module
 */
export interface FullAgentContext {
  // Agent self information
  self: {
    id: string;
    name: string;
    description: string;
    capabilities: string[];
    role: string;
    status: string;
  };

  // Environment information
  environment: EnvironmentState;

  // Resources (devices)
  resources: DeviceStateInfo[];

  // Available services (own and from other agents)
  availableServices: {
    own: ServiceInfo[];
    fromPeers: ServiceInfo[];
  };

  // Collaboration network
  peerAgents: PeerAgentInfo[];

  // Task context
  taskContext?: {
    currentTask?: string;
    recentDecisions?: Array<{
      task: string;
      decision: string;
      outcome: string;
      timestamp: Date;
    }>;
    constraints?: string[];
  };

  // Temporal context
  temporal: {
    currentTime: Date;
    timeScale?: number;
  };
}

/**
 * Agent information interface (simplified version for constructor)
 */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
  status: string;
}

/**
 * Agent context builder
 *
 * Enhanced with section-based architecture for extensible context building.
 * Supports both legacy string-based formatting and new section-based formatting.
 *
 * P5: Added userId for user/environment isolation
 */
export class AgentContextBuilder {
  private agent: AgentInfo;
  private resourceManager: ResourceManager;
  private serviceRegistry: ServiceRegistry;
  private environment: EnvironmentCenter;
  private userId?: string;  // P5: User ID for permission filtering

  // Section-based architecture
  private sections: ContextSection[] = [];
  private ontologyReasoningEngine: OntologyReasoningEngine;
  private ontologyComposer: OntologyContextComposer;

  constructor(
    agent: AgentInfo,
    resourceManager: ResourceManager,
    serviceRegistry: ServiceRegistry,
    environment: EnvironmentCenter,
    userId?: string  // P5: Optional userId for permission filtering
  ) {
    this.agent = agent;
    this.resourceManager = resourceManager;
    this.serviceRegistry = serviceRegistry;
    this.environment = environment;
    this.userId = userId;

    // Initialize ontology reasoning engine and composer
    this.ontologyReasoningEngine = new OntologyReasoningEngine();
    this.ontologyComposer = new OntologyContextComposer(this.ontologyReasoningEngine);

    // Register default sections
    this.registerDefaultSections();
  }

  /**
   * P5: Set user ID for permission filtering
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * P5: Get current user ID
   */
  getUserId(): string | undefined {
    return this.userId;
  }

  /**
   * Register default context sections
   */
  private registerDefaultSections(): void {
    // Core sections (in priority order)
    this.sections.push(new AgentIdentitySection());      // priority: 100
    this.sections.push(new EnvironmentSection());        // priority: 95
    this.sections.push(new ResourcesSection());          // priority: 90
    this.sections.push(new OntologyResourcesSection());  // priority: 85
    this.sections.push(new ServicesSection());           // priority: 80
    this.sections.push(new OntologyServicesSection());   // priority: 75
    this.sections.push(new PeersSection());              // priority: 70
    this.sections.push(new TaskSection());               // priority: 60
    this.sections.push(new OntologyReasoningSection());  // priority: 50
    this.sections.push(new TemporalSection());           // priority: 40

    // Sort by priority
    this.sections.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get all registered sections
   */
  getSections(): ContextSection[] {
    return [...this.sections];
  }

  /**
   * Register a new context section
   */
  registerSection(section: ContextSection): void {
    this.sections.push(section);
    this.sections.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unregister a section by ID
   */
  unregisterSection(sectionId: string): void {
    this.sections = this.sections.filter(s => s.id !== sectionId);
  }

  /**
   * Get the ontology composer
   */
  getOntologyComposer(): OntologyContextComposer {
    return this.ontologyComposer;
  }

  /**
   * Build complete agent context
   */
  async buildFullContext(): Promise<FullAgentContext> {
    const [resources, services, peerAgents, environmentState] = await Promise.all([
      this.collectResourceStates(),
      this.collectServiceInfo(),
      this.collectPeerAgents(),
      this.collectEnvironmentState(),
    ]);

    return {
      self: {
        id: this.agent.id,
        name: this.agent.name,
        description: this.agent.description,
        capabilities: this.agent.capabilities,
        role: (this.agent.metadata?.role as string) || 'general',
        status: this.agent.status,
      },
      environment: environmentState,
      resources,
      availableServices: services,
      peerAgents,
      temporal: {
        currentTime: new Date(),
      },
    };
  }

  /**
   * Collect all resource (device) states
   * P5: Added permission filtering using listDevicesVisibleTo when userId is available
   */
  private async collectResourceStates(): Promise<DeviceStateInfo[]> {
    // P5: Use permission-filtered method if userId is available
    // Get devices from EnvironmentCenter for proper permission filtering
    const resources = this.userId
      ? this.environment.listDevicesVisibleTo(this.userId)
      : this.resourceManager.getAllResources();

    const deviceStates: DeviceStateInfo[] = [];

    for (const resource of resources) {
      try {
        const resourceRecord = resource as unknown as Record<string, unknown>;
        // Handle both Device interface (from listDevicesVisibleTo) and Resource class (from ResourceManager)
        const isDevice = 'status' in resource && typeof resourceRecord.status === 'string';

        // Get resource state - Device uses status, Resource uses getState()
        const state = isDevice
          ? { status: resourceRecord.status as string }
          : (typeof resourceRecord.getState === 'function' ? (resourceRecord.getState as () => Record<string, unknown>)() : {});

        // Get capabilities list - Device uses capabilities array, Resource uses getCapabilities()
        const capabilities = isDevice
          ? ((resourceRecord.capabilities as Array<Record<string, unknown>>) || []).map((c: Record<string, unknown>) => (c.name || c.type || String(c)) as string)
          : (typeof resourceRecord.getCapabilities === 'function'
              ? ((resourceRecord.getCapabilities as () => Array<Record<string, unknown>>)()).map((c: Record<string, unknown>) => (c.name || c.type || String(c)) as string)
              : []);

        // Generate ontology information for semantic reasoning
        let ontologyInfo: string | undefined;
        let semanticContext: string | undefined;

        try {
          // Create a minimal device object for ontology classification
          const deviceForOntology = {
            id: resource.id,
            name: resource.name,
            type: this.mapResourceTypeToDeviceType(resource.type),
            location: typeof resourceRecord.location === 'string'
              ? resourceRecord.location
              : (resourceRecord.location as Record<string, unknown> | undefined)?.path || 'unknown',
            status: isDevice ? resourceRecord.status as string : 'online',
            capabilities: isDevice
              ? resourceRecord.capabilities as Array<Record<string, unknown>>
              : (typeof resourceRecord.getCapabilities === 'function' ? (resourceRecord.getCapabilities as () => Array<Record<string, unknown>>)() : []),
          };

          const ontologyResult = ServiceOntologyManager.generateLLMServiceDescription(deviceForOntology as unknown as Parameters<typeof ServiceOntologyManager.generateLLMServiceDescription>[0]);
          ontologyInfo = ontologyResult.ontologyInfo;
          semanticContext = ontologyResult.semanticContext;
        } catch (ontologyError) {
          // Non-critical: ontology generation failure should not break context building
          logger.warn(`Could not generate ontology for ${resource.id}:`, ontologyError);
        }

        deviceStates.push({
          id: resource.id,
          name: resource.name,
          type: resource.type || 'unknown',
          location: typeof resourceRecord.location === 'string'
            ? resourceRecord.location
            : (resourceRecord.location as Record<string, unknown> | undefined)?.path as string || undefined,
          capabilities,
          currentState: state,
          isOnline: isDevice
            ? resourceRecord.status === 'online'
            : ((resourceRecord.isAvailable as (() => boolean) | undefined)?.() ?? true),
          // Add ontology information for semantic reasoning
          ontology: ontologyInfo,
          semanticContext: semanticContext,
        });
      } catch (error) {
        logger.error(`Error collecting state for resource ${resource.id}:`, error);
      }
    }

    return deviceStates;
  }

  /**
   * Map resource type string to DeviceType enum
   */
  private mapResourceTypeToDeviceType(type: string | undefined): DeviceType {
    if (!type) {
      return DeviceType.SENSOR; // Default to sensor
    }

    const typeLower = type.toLowerCase();
    if (typeLower.includes('actuator') || typeLower.includes('light') || typeLower.includes('hvac')) {
      return DeviceType.ACTUATOR;
    }
    if (typeLower.includes('controller')) {
      return DeviceType.CONTROLLER;
    }
    if (typeLower.includes('hybrid')) {
      return DeviceType.HYBRID;
    }
    // Default to sensor for sensing-related types
    return DeviceType.SENSOR;
  }

  /**
   * Collect service information
   */
  private async collectServiceInfo(): Promise<{ own: ServiceInfo[]; fromPeers: ServiceInfo[] }> {
    const ownServices: ServiceInfo[] = [];
    const peerServices: ServiceInfo[] = [];

    try {
      // Get all services
      const allServices = this.serviceRegistry.getAllServices();

      for (const service of allServices) {
        // Use getOwner method to get service provider ID
        const providerId = typeof service.getOwner === 'function' ? service.getOwner() : 'unknown';

        const serviceInfo: ServiceInfo = {
          id: service.id,
          name: service.name,
          providerAgentId: providerId,
          providerAgentName: 'Agent', // Simplified handling
          category: service.category || 'general',
          capabilities: Array.isArray(service.capabilities)
            ? service.capabilities.map((c: Record<string, unknown> | string) => typeof c === 'string' ? c : (c.name || c.type || '') as string)
            : [],
          status: 'available',
          description: service.description,
        };

        // Determine if it's own service or from other agent
        if (providerId === this.agent.id || providerId === this.agent.name) {
          ownServices.push(serviceInfo);
        } else {
          peerServices.push(serviceInfo);
        }
      }
    } catch (error) {
      logger.error('Error collecting services:', error);
    }

    return { own: ownServices, fromPeers: peerServices };
  }

  /**
   * Collect peer agents information including their services from environment
   * P5: Added permission filtering using listAgentsVisibleTo when userId is available
   */
  private async collectPeerAgents(): Promise<PeerAgentInfo[]> {
    const peers: PeerAgentInfo[] = [];

    try {
      // P5: Use permission-filtered method if userId is available
      const agents = this.userId
        ? this.environment.listAgentsVisibleTo(this.userId)
        : await this.environment.listAgents();

      // Get ALL service registrations from environment (includes agentId)
      const envServices = (this.environment as unknown as { services: Map<string, { service: Record<string, unknown>; agentId: string; deviceId?: string }> }).services;
      const allServiceRegistrations: Array<{
        service: Record<string, unknown>;
        agentId: string;
        deviceId?: string;
      }> = envServices ? Array.from(envServices.values()) : [];

      for (const agentInfo of agents) {
        if (agentInfo.id === this.agent.id) continue;

        // Filter services that belong to this agent
        const agentServices = allServiceRegistrations
          .filter(reg => reg.agentId === agentInfo.id)
          .map(reg => reg.service);

        // Convert capabilities to string array
        const capabilities = Array.isArray(agentInfo.capabilities)
          ? agentInfo.capabilities.map((c: { type?: string; name?: string; description?: string } | string) => typeof c === 'string' ? c : (c.name || c.type || ''))
          : [];

        peers.push({
          id: agentInfo.id,
          name: agentInfo.name,
          capabilities,
          services: agentServices.map((s: Record<string, unknown>) => ({
            id: s.id as string,
            name: s.name as string,
            providerAgentId: agentInfo.id,
            providerAgentName: agentInfo.name,
            category: (s.category as string) || 'general',
            capabilities: Array.isArray(s.capabilities)
              ? (s.capabilities as Array<Record<string, unknown> | string>).map((c: Record<string, unknown> | string) => typeof c === 'string' ? c : (c.name as string || ''))
              : [],
            status: 'available',
            description: s.description as string,
          })),
          status: (agentInfo as unknown as Record<string, unknown>).status as string || 'online',
        });
      }
    } catch (error) {
      logger.error('Error collecting peer agents:', error);
    }

    return peers;
  }

  /**
   * Collect environment state
   */
  private async collectEnvironmentState(): Promise<EnvironmentState> {
    const envState: EnvironmentState = {
      id: this.environment.id,
      name: this.environment.name,
      type: 'environment', // EnvironmentCenter doesn't have type property
    };

    try {
      // Get physical environment state
      const physEnv = (this.environment as unknown as Record<string, unknown>).physicalEnvironment as Record<string, unknown> | undefined;
      if (physEnv) {
        envState.physicalState = typeof physEnv.getAllParameters === 'function'
          ? (physEnv.getAllParameters as () => Record<string, unknown>)()
          : {};

        // Get zone information
        if (typeof physEnv.getSpatialManager === 'function') {
          const spatialManager = (physEnv.getSpatialManager as () => Record<string, unknown>)();
          const zones = typeof spatialManager?.getAllZones === 'function'
            ? (spatialManager.getAllZones as () => Array<Record<string, unknown>>)()
            : [];
          envState.zones = zones.map((zone: Record<string, unknown>) => ({
            id: zone.id as string,
            name: zone.name as string,
            location: (zone.location as string) || '',
            state: (zone.state as Record<string, unknown>) || {},
          }));
        }
      }
    } catch (error) {
      logger.error('Error collecting environment state:', error);
    }

    return envState;
  }

  /**
   * Format context for LLM consumption
   *
   * Uses section-based architecture for extensible context building.
   * Falls back to legacy format if section-based building fails.
   * P5: Added userId and environmentId for proper isolation
   */
  async formatContextForLLMAsync(context: FullAgentContext, task?: string): Promise<string> {
    try {
      // Build section context with P5 isolation fields
      const sectionContext: SectionContext = {
        agent: {
          id: context.self.id,
          name: context.self.name,
          description: context.self.description,
          capabilities: context.self.capabilities,
          metadata: { role: context.self.role },
          status: context.self.status,
        },
        environment: context.environment,
        resources: context.resources,
        services: context.availableServices,
        peers: context.peerAgents,
        task,
        temporal: context.temporal,
        // P5: Add userId and environmentId for permission filtering
        userId: this.userId,
        environmentId: this.environment.id,
      };

      // Include ontology reasoning if task is provided
      if (task) {
        try {
          const ontologyResult = await this.ontologyComposer.composeForTask(
            task,
            context.resources,
            context.availableServices,
            context.peerAgents
          );
          sectionContext.ontologyReasoning = ontologyResult.combinedReasoning;
        } catch (error) {
          logger.warn('Ontology reasoning failed, continuing without it:', error);
        }
      }

      // Build all sections
      return await buildSections(this.sections, sectionContext);
    } catch (error) {
      logger.error('Section-based formatting failed, using legacy:', error);
      return this.formatContextForLLMLegacy(context, task);
    }
  }

  /**
   * Format context for LLM consumption (synchronous version for backward compatibility)
   */
  formatContextForLLM(context: FullAgentContext, task?: string): string {
    // For backward compatibility, use the legacy implementation
    // Callers that need ontology reasoning should use formatContextForLLMAsync
    return this.formatContextForLLMLegacy(context, task);
  }

  /**
   * Legacy format implementation
   */
  private formatContextForLLMLegacy(context: FullAgentContext, task?: string): string {
    const contentSections: string[] = [];

    // 1. Agent Identity
    contentSections.push(`## Agent Identity
- **Name**: ${context.self.name}
- **ID**: ${context.self.id}
- **Role**: ${context.self.role}
- **Capabilities**: ${context.self.capabilities.join(', ') || 'None'}
- **Status**: ${context.self.status}

`);

    // 2. Environment State
    contentSections.push(`## Environment State
- **Environment Name**: ${context.environment.name}
- **Environment Type**: ${context.environment.type}
`);

    if (context.environment.physicalState) {
      contentSections.push(`- **Physical Parameters**:
${Object.entries(context.environment.physicalState)
  .filter(([_, v]) => typeof v !== 'object')
  .map(([k, v]) => `  - ${k}: ${v}`)
  .join('\n')}
`);
    }

    if (context.environment.zones?.length) {
      contentSections.push(`- **Zones**:
${context.environment.zones.map(z =>
  `  - ${z.name}: ${JSON.stringify(z.state)}`
).join('\n')}
`);
    }
    contentSections.push('\n');

    // 3. Available Resources (Devices)
    if (context.resources.length > 0) {
      contentSections.push(`## Available Resources (Devices)
You can directly control the following devices:

${context.resources.map(r => `### ${r.name} (${r.type})
- **ID**: ${r.id}
- **Location**: ${r.location || 'Unknown'}
- **Capabilities**: ${r.capabilities.join(', ')}
- **Current State**: ${JSON.stringify(r.currentState)}
- **Online**: ${r.isOnline ? 'Yes' : 'No'}
`).join('\n')}
`);
    } else {
      contentSections.push(`## Available Resources (Devices)
No devices available.

`);
    }

    // 4. Available Services
    const allServices = [...context.availableServices.own, ...context.availableServices.fromPeers];
    if (allServices.length > 0) {
      contentSections.push(`## Available Services
${context.availableServices.own.length > 0 ? `
**Your Services**:
${context.availableServices.own.map(s => `- ${s.name}: ${s.description || s.category}`).join('\n')}
` : ''}
${context.availableServices.fromPeers.length > 0 ? `
**Services from Other Agents** (available via collaboration):
${context.availableServices.fromPeers.map(s => `- ${s.name} (from ${s.providerAgentName}): ${s.description || s.category}`).join('\n')}
` : ''}
`);
    }

    // 5. Peer Agents
    if (context.peerAgents.length > 0) {
      contentSections.push(`## Peer Agents (Available for Collaboration)

${context.peerAgents.map(a => `### ${a.name}
- **Capabilities**: ${a.capabilities.join(', ') || 'Unknown'}
- **Status**: ${a.status}
- **Services**: ${a.services.map(s => s.name).join(', ') || 'None'}
`).join('\n')}
`);
    }

    // 6. Current Task (if provided)
    if (task) {
      contentSections.push(`## Current Task
${task}

`);
    }

    // 7. Temporal Context
    contentSections.push(`## Temporal Information
- **Current Time**: ${context.temporal.currentTime.toISOString()}
${context.temporal.timeScale ? `- **Time Scale**: ${context.temporal.timeScale}x` : ''}

`);

    return contentSections.join('');
  }

  /**
   * Build full LLM prompt (context + task + instructions)
   */
  buildFullPrompt(task: string, instructions: string, context?: FullAgentContext): string {
    const ctx = context || { self: this.agent, environment: {} as EnvironmentState, resources: [] as DeviceStateInfo[], availableServices: { own: [] as ServiceInfo[], fromPeers: [] as ServiceInfo[] }, peerAgents: [] as PeerAgentInfo[], temporal: { currentTime: new Date() } } as FullAgentContext;

    const contextStr = this.formatContextForLLM(ctx, task);

    return `${contextStr}

## Instructions
${instructions}

## Output Format
Please return your decision in the format specified in the instructions. Ensure your decision is based on the context above.
`;
  }
}

/**
 * Factory function to create context builder
 */
export function createContextBuilder(
  agent: AgentInfo,
  resourceManager: ResourceManager,
  serviceRegistry: ServiceRegistry,
  environment: EnvironmentCenter
): AgentContextBuilder {
  return new AgentContextBuilder(agent, resourceManager, serviceRegistry, environment);
}
