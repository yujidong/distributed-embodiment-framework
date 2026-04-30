/**
 * Environment Center - isolated deployment boundary
 *
 * Each Environment Center represents a physical context (home, office, factory)
 * where devices and agents can discover and interact with each other.
 *
 * Now supports multi-user shared environments where different users can deploy
 * agents and devices that collaborate.
 */

import type {
  EnvironmentCenterData,
  EnvironmentMember,
  ServiceQuery,
  AgentCriteria,
  ServiceRegistration,
  EnvironmentStats,
} from './types.js';
import type { Device, Service, Agent } from './types.js';
import { hasMatchingCapability } from './types.js';

import { EventManager, EventEmitter, EventType } from '../events/index.js';
import { CollaborationManager, ACState } from '../management/CollaborationManager.js';
import { MessageBroker } from '../management/MessageBroker.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Collaboration interface for AC hosting
 */
const logger = createLogger('EnvironmentCenter');

export interface Collaboration {
  id: string;
  name: string;
  description: string;
  participantAgentIds: string[];
  initiatorAgentId: string;
  status: 'forming' | 'active' | 'paused' | 'completed' | 'failed';
  goals: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Environment Center class
 */
export class EnvironmentCenter {
  public readonly id: string;
  public readonly environmentType: 'shared' | 'private';
  public readonly visibility: 'platform' | 'invite-only' | 'private';
  public readonly createdBy: string;
  public accessConfig: Record<string, unknown>;
  public name: string;
  public description?: string;
  public location?: string;
  public readonly createdAt: Date;
  public updatedAt: Date;

  // Event System
  public eventManager: EventManager;
  private eventEmitter: EventEmitter;

  // Message Broker (shared communication bus for agents)
  public messageBroker: MessageBroker;

  // AC Hosting
  private activeCollaborations: Map<string, Collaboration>;
  private collaborationManager?: CollaborationManager;

  // Physical Environment (optional, for simulation mode)
  public physicalEnvironment?: Record<string, unknown>; // PhysicalEnvironment from @active-collaboration/simulation

  // Environment Effect Manager (optional, for automatic device effects)
  private effectManager?: unknown; // EnvironmentEffectManager from @active-collaboration/simulation

  // Internal storage
  private devices: Map<string, Device>;
  private agents: Map<string, Agent>;
  private services: Map<string, ServiceRegistration>;
  private parameters: Map<string, unknown>;  // Environment parameters (temperature, humidity, etc.)
  private deviceEnvironmentMappings: Map<string, Record<string, unknown>[]>;  // deviceId -> mappings

  // Multi-user support
  private members: Map<string, EnvironmentMember>;
  private memberAgents: Map<string, Agent[]>;  // user_id -> agents
  private memberDevices: Map<string, Device[]>;  // user_id -> devices

  constructor(data: EnvironmentCenterData) {
    logger.info(`[EnvironmentCenter:${data.id}] Initializing environment center`);

    this.id = data.id;
    this.environmentType = data.environmentType || 'private';
    this.visibility = data.visibility || 'private';
    this.createdBy = data.createdBy;
    this.accessConfig = data.accessConfig || {};
    this.name = data.name;
    this.description = data.description;
    this.location = data.location;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;

    // Initialize Event System
    this.eventManager = new EventManager(1000);
    this.eventEmitter = new EventEmitter(this.eventManager, this.id);

    // Initialize Message Broker (shared communication bus)
    this.messageBroker = new MessageBroker();
    logger.info(`[EnvironmentCenter:${this.id}] MessageBroker initialized`);

    // Initialize AC Hosting
    this.activeCollaborations = new Map();
    this.collaborationManager = data.collaborationManager;

    // Initialize Physical Environment (optional, for simulation mode)
    this.physicalEnvironment = data.physicalEnvironment;
    if (this.physicalEnvironment) {
      logger.info(`[EnvironmentCenter:${this.id}] Physical environment attached`);
    }

    this.devices = new Map();
    this.agents = new Map();
    this.services = new Map();
    this.parameters = new Map();

    // Initialize multi-user storage
    this.members = new Map();
    this.memberAgents = new Map();
    this.memberDevices = new Map();

    // Initialize device-to-environment mappings
    this.deviceEnvironmentMappings = new Map();

    // Creator is automatically an admin
    this.addMember(data.createdBy, 'admin');

    logger.info(`[EnvironmentCenter:${this.id}] Initialized with name: ${this.name}, type: ${this.environmentType}, visibility: ${this.visibility}`);
  }

  /**
   * Add a member to this environment
   * @param userId - User ID to add
   * @param role - Member role
   */
  addMember(userId: string, role: 'admin' | 'member' | 'viewer'): void {
    if (this.members.has(userId)) {
      logger.info(`[EnvironmentCenter:${this.id}] User ${userId} is already a member`);
      return;
    }

    const member: EnvironmentMember = {
      userId,
      role,
      joinedAt: new Date(),
    };

    this.members.set(userId, member);
    this.updatedAt = new Date();

    logger.info(`[EnvironmentCenter:${this.id}] Added member: ${userId} (${role})`);

    // Emit member added event
    this.eventEmitter.emit(EventType.AGENT_REGISTERED, {
      type: 'member-added',
      userId,
      role,
      timestamp: member.joinedAt,
    });
  }

  /**
   * Remove a member from this environment
   * @param userId - User ID to remove
   */
  removeMember(userId: string): void {
    if (!this.members.has(userId)) {
      throw new Error(`User ${userId} is not a member of this environment`);
    }

    if (userId === this.createdBy) {
      throw new Error('Cannot remove the creator of the environment');
    }

    this.members.delete(userId);
    this.updatedAt = new Date();

    logger.info(`[EnvironmentCenter:${this.id}] Removed member: ${userId}`);
  }

  /**
   * Check if a user is a member of this environment
   * @param userId - User ID to check
   * @returns true if user is a member
   */
  isMember(userId: string): boolean {
    return this.members.has(userId) || this.createdBy === userId;
  }

  /**
   * Get member role
   * @param userId - User ID
   * @returns Member role or undefined
   */
  getMemberRole(userId: string): 'admin' | 'member' | 'viewer' | undefined {
    if (this.createdBy === userId) return 'admin';
    return this.members.get(userId)?.role;
  }

  /**
   * List all members of this environment
   * @returns Array of members
   */
  listMembers(): EnvironmentMember[] {
    return Array.from(this.members.values());
  }

  /**
   * Register a device in this environment center
   * @param device - Device to register
   * @param ownerId - User who owns this device
   */
  registerDevice(device: Device, ownerId: string): void {
    logger.info(`[EnvironmentCenter:${this.id}] Registering device: ${device.id} (owner: ${ownerId})`);

    if (this.devices.has(device.id)) {
      logger.info(`[EnvironmentCenter:${this.id}] Device already registered: ${device.id}`);
      throw new Error(`Device ${device.id} is already registered in this environment center`);
    }

    this.devices.set(device.id, device);

    // Track device by owner
    if (!this.memberDevices.has(ownerId)) {
      this.memberDevices.set(ownerId, []);
    }
    this.memberDevices.get(ownerId)!.push(device);

    // Pass event manager to device if it supports it (for emitting device events)
    const deviceRecord = device as unknown as Record<string, unknown>;
    if (deviceRecord.setEventManager && typeof deviceRecord.setEventManager === 'function') {
      (deviceRecord.setEventManager as (em: EventManager) => void)(this.eventManager);
      logger.info(`[EnvironmentCenter:${this.id}] EventManager attached to device: ${device.id}`);
    }

    // Attach PhysicalEnvironment if available (for physics effects)
    if (this.physicalEnvironment && deviceRecord.setPhysicalEnvironment && typeof deviceRecord.setPhysicalEnvironment === 'function') {
      (deviceRecord.setPhysicalEnvironment as (pe: Record<string, unknown>) => void)(this.physicalEnvironment);
      logger.info(`[EnvironmentCenter:${this.id}] PhysicalEnvironment attached to device: ${device.id}`);
    }

    this.updatedAt = new Date();

    // Emit device registered event
    this.eventEmitter.emit(EventType.DEVICE_REGISTERED, {
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      location: device.location,
      ownerId,
      capabilities: device.capabilities?.map(c => c.name) || [],
    });

    logger.info(`[EnvironmentCenter:${this.id}] Device registered: ${device.id} (${device.name}) owned by ${ownerId}`);
  }

  /**
   * Register an agent in this environment center
   * @param agent - Agent to register
   * @param ownerId - User who owns this agent
   */
  registerAgent(agent: Record<string, unknown> & { id: string; name: string }, ownerId: string): void {
    logger.info(`[EnvironmentCenter:${this.id}] Registering agent: ${agent.id} (owner: ${ownerId})`);

    if (this.agents.has(agent.id)) {
      logger.info(`[EnvironmentCenter:${this.id}] Agent already registered: ${agent.id}`);
      return;
    }

    this.agents.set(agent.id, agent as unknown as Agent);

    // Track agent by owner
    if (!this.memberAgents.has(ownerId)) {
      this.memberAgents.set(ownerId, []);
    }
    this.memberAgents.get(ownerId)!.push(agent as unknown as Agent);

    this.updatedAt = new Date();

    // Pass event manager to agent if it supports it
    if (agent.setEventManager && typeof agent.setEventManager === 'function') {
      agent.setEventManager(this.eventManager);
    }

    // Pass message broker to agent if it supports it (for inter-agent communication)
    if (agent.setMessageBroker && typeof agent.setMessageBroker === 'function') {
      agent.setMessageBroker(this.messageBroker);
      logger.info(`[EnvironmentCenter:${this.id}] MessageBroker attached to agent: ${agent.id}`);
    }

    // Register agent with MessageBroker to receive messages
    if (agent.handleMessageBrokerMessage && typeof agent.handleMessageBrokerMessage === 'function') {
      const handler = agent.handleMessageBrokerMessage as (message: unknown) => void;
      this.messageBroker.registerAgent(agent.id, agent.name, (message) => {
        handler(message);
      });
      logger.info(`[EnvironmentCenter:${this.id}] Agent registered with MessageBroker: ${agent.id}`);
    }

    // Note: Agent will emit its own AGENT_REGISTERED event in its constructor
    logger.info(`[EnvironmentCenter:${this.id}] Agent registered: ${agent.id} (${agent.name}) owned by ${ownerId}`);
  }

  /**
   * Remove a device from this environment center
   * @param deviceId - Device ID to remove
   */
  removeDevice(deviceId: string): void {
    logger.info(`[EnvironmentCenter:${this.id}] Removing device: ${deviceId}`);

    if (!this.devices.delete(deviceId)) {
      logger.info(`[EnvironmentCenter:${this.id}] Device not found: ${deviceId}`);
      throw new Error(`Device ${deviceId} not found in this environment center`);
    }

    // Remove services associated with this device
    for (const [key, registration] of this.services.entries()) {
      if (registration.deviceId === deviceId) {
        this.services.delete(key);
      }
    }

    this.updatedAt = new Date();
    logger.info(`[EnvironmentCenter:${this.id}] Device removed: ${deviceId}`);
  }

  /**
   * Remove an agent from this environment center
   * @param agentId - Agent ID to remove
   */
  removeAgent(agentId: string): void {
    logger.info(`[EnvironmentCenter:${this.id}] Removing agent: ${agentId}`);

    if (!this.agents.delete(agentId)) {
      logger.info(`[EnvironmentCenter:${this.id}] Agent not found: ${agentId}`);
      throw new Error(`Agent ${agentId} not found in this environment center`);
    }

    // Remove services associated with this agent
    for (const [key, registration] of this.services.entries()) {
      if (registration.agentId === agentId) {
        this.services.delete(key);
      }
    }

    this.updatedAt = new Date();
    logger.info(`[EnvironmentCenter:${this.id}] Agent removed: ${agentId}`);
  }

  /**
   * Get a device by ID
   * @param deviceId - Device ID
   * @returns Device or undefined
   */
  getDevice(deviceId: string): Device | undefined {
    const device = this.devices.get(deviceId);
    logger.info(`[EnvironmentCenter:${this.id}] Getting device: ${deviceId} - ${device ? 'found' : 'not found'}`);
    return device;
  }

  /**
   * Get an agent by ID
   * @param agentId - Agent ID
   * @returns Agent or undefined
   */
  getAgent(agentId: string): Agent | undefined {
    const agent = this.agents.get(agentId);
    logger.info(`[EnvironmentCenter:${this.id}] Getting agent: ${agentId} - ${agent ? 'found' : 'not found'}`);
    return agent;
  }

  /**
   * List all devices in this environment center
   * @returns Array of devices
   */
  listDevices(): Device[] {
    const devices = Array.from(this.devices.values());
    logger.info(`[EnvironmentCenter:${this.id}] Listing devices: ${devices.length} total`);
    return devices;
  }

  /**
   * List all agents in this environment center
   * @returns Array of agents
   */
  listAgents(): Agent[] {
    const agents = Array.from(this.agents.values());
    logger.info(`[EnvironmentCenter:${this.id}] Listing agents: ${agents.length} total`);
    return agents;
  }

  /**
   * Get a specific environment parameter
   * @param key - Parameter key (e.g., 'temperature', 'humidity')
   * @returns Parameter value or undefined if not set
   */
  getParameter(key: string): unknown {
    const value = this.parameters.get(key);
    logger.info(`[EnvironmentCenter:${this.id}] Getting parameter '${key}': ${value}`);
    return value;
  }

  /**
   * Set a specific environment parameter
   * @param key - Parameter key
   * @param value - Parameter value
   */
  setParameter(key: string, value: unknown): void {
    const oldValue = this.parameters.get(key);
    this.parameters.set(key, value);
    logger.info(`[EnvironmentCenter:${this.id}] Setting parameter '${key}': ${oldValue} -> ${value}`);

    // Emit parameter change event
    this.eventEmitter.emit(EventType.ENVIRONMENT_PARAM_CHANGED, {
      environmentId: this.id,
      parameter: key,
      oldValue,
      value,
      timestamp: new Date(),
    });
  }

  /**
   * Get all environment parameters
   * @returns Record of all parameters
   */
  getParameters(): Record<string, any> {
    const params = Object.fromEntries(this.parameters.entries());
    logger.info(`[EnvironmentCenter:${this.id}] Getting all parameters: ${Object.keys(params).length} total`);
    return params;
  }

  /**
   * Update multiple environment parameters at once
   * @param params - Record of parameters to update
   */
  updateParameters(params: Record<string, any>): void {
    logger.info(`[EnvironmentCenter:${this.id}] Updating ${Object.keys(params).length} parameters`);
    for (const [key, value] of Object.entries(params)) {
      this.setParameter(key, value);
    }
  }

  /**
   * Discover services within this environment center (local discovery)
   * @param query - Service query criteria
   * @returns Array of matching services
   */
  discoverServices(query: ServiceQuery): Service[] {
    logger.info(`[EnvironmentCenter:${this.id}] Discovering services:`, query);

    let services = Array.from(this.services.values()).map((reg) => reg.service);

    // Apply filters
    if (query.name) {
      services = services.filter((s) => s.name.includes(query.name!));
    }
    if (query.deviceId) {
      services = services.filter((s) => {
        const reg = this.services.get(`${query.deviceId}:${s.name}`);
        return reg?.deviceId === query.deviceId;
      });
    }

    logger.info(`[EnvironmentCenter:${this.id}] Found ${services.length} matching services`);
    return services;
  }

  /**
   * Discover agents within this environment center
   * @param criteria - Agent search criteria
   * @returns Array of matching agents
   */
  discoverAgents(criteria: AgentCriteria): Agent[] {
    logger.info(`[EnvironmentCenter:${this.id}] Discovering agents:`, criteria);

    let agents = Array.from(this.agents.values());

    // Filter by status
    if (criteria.status) {
      agents = agents.filter(agent => {
        const agentRecord = agent as unknown as Record<string, unknown>;
        const agentStatus = agentRecord.status;
        return agentStatus === criteria.status;
      })
    }

    // Filter by type
    if (criteria.type) {
      agents = agents.filter(agent => {
        const agentRecord = agent as unknown as Record<string, unknown>;
        const agentType = agentRecord.type || (agentRecord.agentProfile as Record<string, unknown> | undefined)?.type
        return agentType === criteria.type
      })
    }

    // Filter by capabilities
    if (criteria.capabilities && criteria.capabilities.length > 0) {
      const requiredCapabilities = criteria.capabilities;
      logger.info(`[EnvironmentCenter:${this.id}] Filtering by capabilities: [${requiredCapabilities.join(', ')}]`);
      agents = agents.filter(agent => {
        const agentRecord = agent as unknown as Record<string, unknown>;
        const agentCapabilities = agentRecord.capabilities as string[] || []
        if (!agentCapabilities || agentCapabilities.length === 0) {
          logger.info(`[EnvironmentCenter:${this.id}] Agent ${agent.id} has no capabilities - FILTERED`);
          return false;
        }

        // Semantic capability matching:
        // Uses domain-aware matching so that capabilities like "temperature-sensing"
        // match requirements like "temperature-control" (same domain: "temperature").
        const hasCapability = hasMatchingCapability(
          agentCapabilities as string[],
          requiredCapabilities
        );

        if (hasCapability) {
          logger.info(`[EnvironmentCenter:${this.id}] Agent ${agent.id} capabilities [${agentCapabilities.join(', ')}] match required [${requiredCapabilities.join(', ')}]`);
        }

        if (!hasCapability) {
          logger.info(`[EnvironmentCenter:${this.id}] Agent ${agent.id} capabilities [${agentCapabilities.join(', ')}] do not match required [${requiredCapabilities.join(', ')}] - FILTERED`);
        }

        return hasCapability;
      })
    }

    // Exclude specific agent IDs
    if (criteria.excludeIds && criteria.excludeIds.length > 0) {
      agents = agents.filter(agent => !criteria.excludeIds!.includes(agent.id))
    }

    logger.info(`[EnvironmentCenter:${this.id}] Found ${agents.length} matching agents after filtering`);
    return agents
  }

  /**
   * Register a service in this environment center
   * @param service - Service to register
   * @param agentId - Agent providing the service
   * @param deviceId - Optional device the service is associated with
   */
  registerService(service: Service, agentId: string, deviceId?: string): void {
    logger.info(
      `[EnvironmentCenter:${this.id}] Registering service: ${service.name} from agent ${agentId}`
    );

    const key = `${deviceId || 'global'}:${service.name}`;

    const registration: ServiceRegistration = {
      service,
      agentId,
      deviceId,
      registeredAt: new Date(),
    };

    this.services.set(key, registration);
    this.updatedAt = new Date();
    logger.info(`[EnvironmentCenter:${this.id}] Service registered: ${key}`);
  }

  /**
   * Get service registration by service name
   * @param serviceName - Service name
   * @param deviceId - Optional device ID
   * @returns ServiceRegistration or undefined
   */
  getServiceRegistration(serviceName: string, deviceId?: string): ServiceRegistration | undefined {
    const key = `${deviceId || 'global'}:${serviceName}`;
    return this.services.get(key);
  }

  /**
   * Unregister a service from this environment center
   * @param serviceName - Service name to unregister
   * @param deviceId - Optional device ID
   */
  unregisterService(serviceName: string, deviceId?: string): void {
    logger.info(`[EnvironmentCenter:${this.id}] Unregistering service: ${serviceName}`);

    const key = `${deviceId || 'global'}:${serviceName}`;

    if (!this.services.delete(key)) {
      logger.info(`[EnvironmentCenter:${this.id}] Service not found: ${key}`);
      throw new Error(`Service ${serviceName} not found in this environment center`);
    }

    this.updatedAt = new Date();
    logger.info(`[EnvironmentCenter:${this.id}] Service unregistered: ${key}`);
  }

  /**
   * Get statistics for this environment center
   * @returns Environment statistics
   */
  getStats(): EnvironmentStats {
    const stats: EnvironmentStats = {
      deviceCount: this.devices.size,
      agentCount: this.agents.size,
      serviceCount: this.services.size,
      activeConnections: 0, // TODO: Track active connections
    };

    logger.info(`[EnvironmentCenter:${this.id}] Stats:`, stats);
    return stats;
  }

  /**
   * Route a message to another environment center (interface for future)
   * @param targetCenterId - Target environment center ID
   * @param _message - Message to route
   */
  async routeToCenter(targetCenterId: string, _message: Record<string, unknown>): Promise<void> {
    logger.info(
      `[EnvironmentCenter:${this.id}] Routing message to center ${targetCenterId}`
    );

    // TODO: Implement cross-center routing
    // This will be implemented in Phase 8
    throw new Error('Cross-center routing not yet implemented');
  }

  /**
   * Update environment center metadata
   * @param updates - Fields to update
   */
  update(updates: Partial<Pick<EnvironmentCenterData, 'name' | 'description'>>): void {
    logger.info(`[EnvironmentCenter:${this.id}] Updating environment center`);

    if (updates.name) {
      this.name = updates.name;
    }
    if (updates.description !== undefined) {
      this.description = updates.description;
    }

    this.updatedAt = new Date();
    logger.info(`[EnvironmentCenter:${this.id}] Updated:`, updates);
  }

  // ============================================
  // Multi-User Environment Methods
  // ============================================

  /**
   * List agents visible to a specific user
   * In shared environments, returns all agents with ownership info
   * @param userId - User ID requesting the list
   * @returns Array of agents visible to the user
   */
  listAgentsVisibleTo(userId: string): Agent[] {
    if (!this.isMember(userId)) {
      throw new Error(`User ${userId} is not a member of this environment`);
    }

    // In shared environments, all agents are visible
    // Ownership is still tracked
    const allAgents = Array.from(this.agents.values());
    logger.info(`[EnvironmentCenter:${this.id}] User ${userId} can see ${allAgents.length} agents`);
    return allAgents;
  }

  /**
   * List devices visible to a specific user
   * In shared environments, returns all devices with ownership info
   * @param userId - User ID requesting the list
   * @returns Array of devices visible to the user
   */
  listDevicesVisibleTo(userId: string): Device[] {
    if (!this.isMember(userId)) {
      throw new Error(`User ${userId} is not a member of this environment`);
    }

    // In shared environments, all devices are visible
    const allDevices = Array.from(this.devices.values());
    logger.info(`[EnvironmentCenter:${this.id}] User ${userId} can see ${allDevices.length} devices`);
    return allDevices;
  }

  /**
   * Get agents owned by a specific user
   * @param ownerId - User ID who owns the agents
   * @returns Array of agents owned by the user
   */
  getAgentsByOwner(ownerId: string): Agent[] {
    return this.memberAgents.get(ownerId) || [];
  }

  /**
   * Get devices owned by a specific user
   * @param ownerId - User ID who owns the devices
   * @returns Array of devices owned by the user
   */
  getDevicesByOwner(ownerId: string): Device[] {
    return this.memberDevices.get(ownerId) || [];
  }

  /**
   * Get agents grouped by owner
   * @returns Record mapping user IDs to their agents
   */
  getAgentsGroupedByOwner(): Record<string, Agent[]> {
    const result: Record<string, Agent[]> = {};
    for (const agent of this.agents.values()) {
      // Get owner from agent metadata
      const ownerId = (agent as unknown as Record<string, unknown>).ownerId as string | undefined;
      if (ownerId) {
        if (!result[ownerId]) {
          result[ownerId] = [];
        }
        result[ownerId].push(agent);
      }
    }
    return result;
  }

  /**
   * Get devices grouped by owner
   * @returns Record mapping user IDs to their devices
   */
  getDevicesGroupedByOwner(): Record<string, Device[]> {
    const result: Record<string, Device[]> = {};
    for (const device of this.devices.values()) {
      // Get owner from device metadata
      const ownerId = (device as unknown as Record<string, unknown>).ownerId as string | undefined;
      if (ownerId) {
        if (!result[ownerId]) {
          result[ownerId] = [];
        }
        result[ownerId].push(device);
      }
    }
    return result;
  }

  // ============================================
  // Device-to-Environment Mapping Methods
  // ============================================

  /**
   * Add a device-to-environment mapping
   * @param mapping - Mapping configuration
   */
  addDeviceMapping(mapping: {
    deviceId: string;
    deviceOutput: string;
    environmentParameter: string;
    transform?: 'direct' | 'inverse' | 'scaled';
    scaleFactor?: number;
    offset?: number;
    enabled: boolean;
  }): void {
    logger.info(`[EnvironmentCenter:${this.id}] Adding device mapping:`, mapping);

    if (!this.devices.has(mapping.deviceId)) {
      throw new Error(`Device ${mapping.deviceId} not found in this environment`);
    }

    if (!this.deviceEnvironmentMappings.has(mapping.deviceId)) {
      this.deviceEnvironmentMappings.set(mapping.deviceId, []);
    }

    const mappings = this.deviceEnvironmentMappings.get(mapping.deviceId)!;

    // Check if mapping for this deviceOutput already exists
    const existingIndex = mappings.findIndex(m => m.deviceOutput === mapping.deviceOutput);
    if (existingIndex !== -1) {
      // Update existing mapping
      mappings[existingIndex] = { ...mapping, id: `mapping-${Date.now()}` };
    } else {
      // Add new mapping
      mappings.push({ ...mapping, id: `mapping-${Date.now()}` });
    }

    this.updatedAt = new Date();
    logger.info(`[EnvironmentCenter:${this.id}] Device mapping added: ${mapping.deviceId}.${mapping.deviceOutput} -> ${mapping.environmentParameter}`);
  }

  /**
   * Get device-to-environment mappings
   * @param deviceId - Optional device ID to filter by
   * @returns Array of mappings
   */
  getDeviceMappings(deviceId?: string): Record<string, unknown>[] {
    if (deviceId) {
      const mappings = this.deviceEnvironmentMappings.get(deviceId);
      logger.info(`[EnvironmentCenter:${this.id}] Getting mappings for device ${deviceId}: ${mappings?.length || 0} total`);
      return mappings || [];
    }

    // Return all mappings flattened
    const all: Record<string, unknown>[] = [];
    for (const mappings of this.deviceEnvironmentMappings.values()) {
      all.push(...mappings);
    }
    logger.info(`[EnvironmentCenter:${this.id}] Getting all mappings: ${all.length} total`);
    return all;
  }

  /**
   * Remove a device-to-environment mapping
   * @param mappingId - Mapping ID to remove
   */
  removeDeviceMapping(mappingId: string): void {
    logger.info(`[EnvironmentCenter:${this.id}] Removing mapping: ${mappingId}`);

    for (const [_deviceId, mappings] of this.deviceEnvironmentMappings.entries()) {
      const index = mappings.findIndex(m => m.id === mappingId);
      if (index !== -1) {
        mappings.splice(index, 1);
        this.updatedAt = new Date();
        logger.info(`[EnvironmentCenter:${this.id}] Mapping removed: ${mappingId}`);
        return;
      }
    }

    throw new Error(`Mapping ${mappingId} not found`);
  }

  /**
   * Update a device-to-environment mapping
   * @param mappingId - Mapping ID to update
   * @param updates - Fields to update
   */
  updateDeviceMapping(mappingId: string, updates: Partial<Record<string, unknown>>): void {
    logger.info(`[EnvironmentCenter:${this.id}] Updating mapping: ${mappingId}`, updates);

    for (const mappings of this.deviceEnvironmentMappings.values()) {
      const mapping = mappings.find(m => m.id === mappingId);
      if (mapping) {
        Object.assign(mapping, updates);
        this.updatedAt = new Date();
        logger.info(`[EnvironmentCenter:${this.id}] Mapping updated: ${mappingId}`);
        return;
      }
    }

    throw new Error(`Mapping ${mappingId} not found`);
  }

  /**
   * Process device state change and update environment parameters
   * This method should be called when a device's state changes
   * @param deviceId - Device ID that changed
   * @param newState - New device state
   */
  processDeviceStateChange(deviceId: string, newState: Record<string, unknown>): void {
    const mappings = this.deviceEnvironmentMappings.get(deviceId);
    if (!mappings || mappings.length === 0) {
      return; // No mappings for this device
    }

    logger.info(`[EnvironmentCenter:${this.id}] Processing state change for device ${deviceId}:`, newState);

    // Process each active mapping
    for (const mapping of mappings) {
      if (!mapping.enabled) {
        continue; // Skip disabled mappings
      }

      const deviceOutputKey = mapping.deviceOutput as string;
      const deviceValue = newState[deviceOutputKey];
      if (deviceValue === undefined) {
        logger.info(`[EnvironmentCenter:${this.id}] Device output ${deviceOutputKey} not found in state`);
        continue;
      }

      // Apply transformation
      let environmentValue = deviceValue;

      switch (mapping.transform) {
        case 'inverse':
          environmentValue = -(deviceValue as number);
          break;
        case 'scaled':
          if (mapping.scaleFactor !== undefined) {
            environmentValue = (deviceValue as number) * (mapping.scaleFactor as number);
          }
          if (mapping.offset !== undefined) {
            environmentValue = (environmentValue as number) + (mapping.offset as number);
          }
          break;
        case 'direct':
        default:
          // Direct mapping, no transformation
          break;
      }

      // Update environment parameter
      const envParam = mapping.environmentParameter as string;
      const oldValue = this.parameters.get(envParam);
      this.setParameter(envParam, environmentValue);

      logger.info(
        `[EnvironmentCenter:${this.id}] Updated parameter ${envParam}: ${oldValue} -> ${environmentValue} (from device ${deviceId}.${deviceOutputKey})`
      );
    }
  }

  // ============================================
  // Physical Environment Integration Methods
  // ============================================

  /**
   * Sync environment parameters from PhysicalEnvironment
   * This method updates environment parameters with values from PhysicalEnvironment
   * @param parameters - Array of parameter names to sync (optional, syncs all if not provided)
   */
  syncFromPhysicalEnvironment(parameters?: string[]): void {
    if (!this.physicalEnvironment) {
      logger.info(`[EnvironmentCenter:${this.id}] No physical environment attached, skipping sync`);
      return;
    }

    logger.info(`[EnvironmentCenter:${this.id}] Syncing parameters from physical environment`);

    // Get all devices in this environment
    const devices = Array.from(this.devices.values());

    // For each device, get its parameter values from physical environment
    for (const device of devices) {
      if (!device.location) {
        continue; // Skip devices without location
      }

      // If specific parameters requested, only sync those
      const paramsToSync = parameters && parameters.length > 0
        ? parameters
        : Object.keys(device.capabilities || {});

      for (const param of paramsToSync) {
        try {
          const value = (this.physicalEnvironment as unknown as { getParameterValue: (param: string, location: string) => unknown }).getParameterValue(param, typeof device.location === 'string' ? device.location : device.location.path);
          this.setParameter(param, value);
          logger.info(`[EnvironmentCenter:${this.id}] Synced ${param} = ${value} for device ${device.id}`);
        } catch (error) {
          logger.warn(`[EnvironmentCenter:${this.id}] Failed to sync ${param} for device ${device.id}:`, error);
        }
      }
    }
  }

  /**
   * Register device effect with PhysicalEnvironment
   * This allows devices to affect physical environment parameters
   * @param deviceId - Device ID
   * @param parameter - Parameter affected by device
   * @param effectConfig - Effect configuration
   */
  registerDeviceEffect(deviceId: string, parameter: string, effectConfig: {
    type: 'point' | 'area' | 'gradient';
    intensity: number;
    radius?: number;
    decay?: number;
  }): void {
    if (!this.physicalEnvironment) {
      logger.info(`[EnvironmentCenter:${this.id}] No physical environment attached, cannot register device effect`);
      return;
    }

    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    if (!device.location) {
      throw new Error(`Device ${deviceId} has no location, cannot register effect`);
    }

    try {
      (this.physicalEnvironment as unknown as { registerDeviceEffect: (config: Record<string, unknown>) => void }).registerDeviceEffect({
        deviceId,
        parameter: parameter as unknown as import('@active-collaboration/shared').PhysicalParameter,
        location: device.location,
        ...effectConfig,
      });

      logger.info(`[EnvironmentCenter:${this.id}] Registered device effect: ${deviceId} affects ${parameter}`);
    } catch (error) {
      logger.error(`[EnvironmentCenter:${this.id}] Failed to register device effect:`, error);
      throw error;
    }
  }

  /**
   * Unregister device effect from PhysicalEnvironment
   * @param deviceId - Device ID
   * @param parameter - Optional parameter (removes all effects for device if not specified)
   */
  unregisterDeviceEffect(deviceId: string, parameter?: string): void {
    if (!this.physicalEnvironment) {
      return;
    }

    try {
      (this.physicalEnvironment as unknown as { unregisterDeviceEffect: (deviceId: string, parameter?: unknown) => void }).unregisterDeviceEffect(deviceId, parameter as unknown as import('@active-collaboration/shared').PhysicalParameter);
      logger.info(`[EnvironmentCenter:${this.id}] Unregistered device effect: ${deviceId}${parameter ? ` for ${parameter}` : ''}`);
    } catch (error) {
      logger.error(`[EnvironmentCenter:${this.id}] Failed to unregister device effect:`, error);
    }
  }

  /**
   * Start physics simulation (if PhysicalEnvironment is attached)
   */
  startPhysicsSimulation(): void {
    if (!this.physicalEnvironment) {
      logger.info(`[EnvironmentCenter:${this.id}] No physical environment attached, cannot start physics simulation`);
      return;
    }

    try {
      (this.physicalEnvironment as unknown as { startPhysicsSimulation: () => void }).startPhysicsSimulation();
      logger.info(`[EnvironmentCenter:${this.id}] Physics simulation started`);
    } catch (error) {
      logger.error(`[EnvironmentCenter:${this.id}] Failed to start physics simulation:`, error);
    }
  }

  /**
   * Stop physics simulation (if PhysicalEnvironment is attached)
   */
  stopPhysicsSimulation(): void {
    if (!this.physicalEnvironment) {
      return;
    }

    try {
      (this.physicalEnvironment as unknown as { stopPhysicsSimulation: () => void }).stopPhysicsSimulation();
      logger.info(`[EnvironmentCenter:${this.id}] Physics simulation stopped`);
    } catch (error) {
      logger.error(`[EnvironmentCenter:${this.id}] Failed to stop physics simulation:`, error);
    }
  }

  /**
   * Run feedback-controlled physics simulation.
   *
   * This is the AC lifecycle's closed-loop monitoring mechanism:
   * the Observer agent monitors the environment parameter, and when the
   * target is reached, all device effects are automatically stopped
   * (e.g., HVAC stops cooling when target temperature is achieved).
   *
   * Uses PhysicalEnvironment.simulateWithFeedback() via duck-typing
   * to avoid direct dependency on @active-collaboration/simulation.
   *
   * @param goal - Target outcome: parameter, location, targetValue, tolerance, direction
   * @param totalDuration - Maximum simulated time in seconds (default 600)
   * @param stepSize - Duration per physics step in seconds (default 1.0)
   * @param settleSteps - Extra steps after goal achievement for settling (default 5)
   * @returns Simulation result or undefined if PhysicalEnvironment not available
   */
  runFeedbackSimulation(
    goal: {
      parameter: string;
      location: string;
      targetValue: number;
      tolerance?: number;
      direction: 'below' | 'above';
    },
    totalDuration?: number,
    stepSize?: number,
    settleSteps?: number,
  ): { stepsExecuted: number; goalAchieved: boolean; achievedAtStep?: number; achievedAtSeconds?: number; finalValue?: number } | undefined {
    if (!this.physicalEnvironment) {
      return undefined;
    }

    try {
      const pe = this.physicalEnvironment as unknown as {
        simulateWithFeedback: (
          totalDuration: number,
          goal: Record<string, unknown>,
          stepSize: number,
          settleSteps: number,
        ) => { stepsExecuted: number; goalAchieved: boolean; achievedAtStep?: number; achievedAtSeconds?: number; finalValue?: number };
      };

      if (typeof pe.simulateWithFeedback !== 'function') {
        logger.warn(`[EnvironmentCenter:${this.id}] PhysicalEnvironment does not have simulateWithFeedback method`);
        return undefined;
      }

      const result = pe.simulateWithFeedback(
        totalDuration ?? 600,
        goal as unknown as Record<string, unknown>,
        stepSize ?? 1.0,
        settleSteps ?? 5,
      );

      logger.info(
        `[EnvironmentCenter:${this.id}] Feedback simulation: ` +
        `achieved=${result.goalAchieved}, steps=${result.stepsExecuted}, ` +
        `final=${result.finalValue?.toFixed(2) ?? 'N/A'}`,
      );

      return result;
    } catch (error) {
      logger.error(`[EnvironmentCenter:${this.id}] Feedback simulation failed:`, error);
      return undefined;
    }
  }

  /**
   * Initialize EnvironmentEffectManager for automatic device effect handling
   * This should be called after PhysicalEnvironment is attached and devices are registered
   * @param deviceTemplateRegistry - DeviceTemplateRegistry from @active-collaboration/simulation
   */
  async initializeEffectManager(deviceTemplateRegistry: Record<string, unknown>): Promise<void> {
    if (!this.physicalEnvironment) {
      logger.warn(`[EnvironmentCenter:${this.id}] No physical environment attached, cannot initialize effect manager`);
      return;
    }

    if (!this.eventManager) {
      logger.warn(`[EnvironmentCenter:${this.id}] No event manager available, cannot initialize effect manager`);
      return;
    }

    try {
      // Dynamically import EnvironmentEffectManager to avoid circular dependency
      // @ts-ignore - simulation package is optional peer dependency
      const { EnvironmentEffectManager } = await import('@active-collaboration/simulation');

      type EffectManagerOptions = ConstructorParameters<typeof EnvironmentEffectManager>[0];
      // Cross-package dynamic import types don't align perfectly;
      // cast through unknown to bridge the gap
      const effectManagerOptions = {
        eventManager: this.eventManager,
        physicalEnvironment: this.physicalEnvironment,
        deviceTemplateRegistry,
        deviceGetter: (deviceId: string) => this.devices.get(deviceId),
      } as unknown as EffectManagerOptions;
      this.effectManager = new EnvironmentEffectManager(effectManagerOptions);

      // Start listening to device operations
      (this.effectManager as unknown as { start: () => void }).start();

      logger.info(`[EnvironmentCenter:${this.id}] EnvironmentEffectManager initialized and started`);
    } catch (error) {
      logger.error(`[EnvironmentCenter:${this.id}] Failed to initialize EnvironmentEffectManager:`, error);
    }
  }

  /**
   * Stop EnvironmentEffectManager
   */
  stopEffectManager(): void {
    if (this.effectManager) {
      (this.effectManager as unknown as { stop: () => void }).stop();
      logger.info(`[EnvironmentCenter:${this.id}] EnvironmentEffectManager stopped`);
    }
  }

  /**
   * Get effect manager statistics
   */
  getEffectManagerStats(): Record<string, unknown> {
    if (!this.effectManager) {
      return { enabled: false };
    }

    return ((this.effectManager as unknown as { getStats: () => Record<string, unknown> }).getStats)();
  }

  // ============================================
  // AC Hosting Methods
  // ============================================

  /**
   * Host an Active Collaboration in this environment
   * @param collaboration - Collaboration to host
   */
  async hostCollaboration(collaboration: Collaboration): Promise<void> {
    logger.info(`[EnvironmentCenter:${this.id}] Hosting collaboration: ${collaboration.id}`);

    // Validate participant agents
    if (!collaboration.participantAgentIds || collaboration.participantAgentIds.length === 0) {
      logger.error(`[EnvironmentCenter:${this.id}] Collaboration has no participant agents`);
      throw new Error(`Collaboration must have at least one participant agent`);
    }

    // Check if all participant agents exist in this environment
    for (const agentId of collaboration.participantAgentIds) {
      if (!this.agents.has(agentId)) {
        logger.error(`[EnvironmentCenter:${this.id}] Agent ${agentId} not found in environment`);
        throw new Error(`Agent ${agentId} not found in environment ${this.id}`);
      }
    }

    // Track AC state if CollaborationManager is available (before registering)
    if (this.collaborationManager) {
      await this.collaborationManager.trackACState(
        collaboration.id,
        ACState.INITIALIZING,
        'Collaboration hosted in environment'
      );
    }

    // Register collaboration (only after validation passes)
    this.activeCollaborations.set(collaboration.id, collaboration);
    this.updatedAt = new Date();

    // Initialize participant agents
    for (const agentId of collaboration.participantAgentIds) {
      const agent = this.agents.get(agentId);
      if (agent && 'participateInCollaboration' in agent && typeof (agent as unknown as Record<string, unknown>).participateInCollaboration === 'function') {
        try {
          await ((agent as unknown as { participateInCollaboration: (id: string) => Promise<void> }).participateInCollaboration)(collaboration.id);
          logger.info(`[EnvironmentCenter:${this.id}] Agent ${agentId} initialized for collaboration`);
        } catch (error) {
          logger.error(`[EnvironmentCenter:${this.id}] Failed to initialize agent ${agentId}:`, error);
        }
      }
    }

    // Track AC state as ready
    if (this.collaborationManager) {
      await this.collaborationManager.trackACState(
        collaboration.id,
        ACState.READY,
        'All agents initialized'
      );
    }

    logger.info(`[EnvironmentCenter:${this.id}] Collaboration ${collaboration.id} is ready`);

    // Emit collaboration hosted event
    this.eventEmitter.emit(EventType.AGENT_REGISTERED, {
      type: 'collaboration-hosted',
      collaborationId: collaboration.id,
      participantAgents: collaboration.participantAgentIds,
      timestamp: new Date(),
    });
  }

  /**
   * Get all active collaborations in this environment
   * @returns Array of active collaborations
   */
  getActiveCollaborations(): Collaboration[] {
    return Array.from(this.activeCollaborations.values());
  }

  /**
   * Get a specific collaboration by ID
   * @param collaborationId - Collaboration ID
   * @returns Collaboration or undefined
   */
  getCollaboration(collaborationId: string): Collaboration | undefined {
    return this.activeCollaborations.get(collaborationId);
  }

  /**
   * Update collaboration status
   * @param collaborationId - Collaboration ID
   * @param status - New status
   */
  async updateCollaborationStatus(
    collaborationId: string,
    status: 'forming' | 'active' | 'paused' | 'completed' | 'failed'
  ): Promise<void> {
    const collaboration = this.activeCollaborations.get(collaborationId);
    if (!collaboration) {
      throw new Error(`Collaboration ${collaborationId} not found`);
    }

    collaboration.status = status;
    collaboration.updatedAt = new Date();

    logger.info(`[EnvironmentCenter:${this.id}] Collaboration ${collaborationId} status: ${status}`);

    // Track AC state transition if CollaborationManager is available
    if (this.collaborationManager) {
      const acStateMap: Record<typeof status, ACState> = {
        forming: ACState.INITIALIZING,
        active: ACState.RUNNING,
        paused: ACState.PAUSED,
        completed: ACState.COMPLETED,
        failed: ACState.FAILED,
      };

      await this.collaborationManager.trackACState(
        collaborationId,
        acStateMap[status],
        `Status updated to ${status}`
      );
    }

    this.updatedAt = new Date();

    // Emit collaboration status change event
    this.eventEmitter.emit(EventType.AGENT_REGISTERED, {
      type: 'collaboration-status-changed',
      collaborationId,
      status,
      timestamp: new Date(),
    });
  }

  /**
   * Remove a collaboration from this environment
   * @param collaborationId - Collaboration ID to remove
   */
  async removeCollaboration(collaborationId: string): Promise<void> {
    logger.info(`[EnvironmentCenter:${this.id}] Removing collaboration: ${collaborationId}`);

    if (!this.activeCollaborations.has(collaborationId)) {
      throw new Error(`Collaboration ${collaborationId} not found`);
    }

    // Track AC state as terminated
    if (this.collaborationManager) {
      await this.collaborationManager.trackACState(
        collaborationId,
        ACState.TERMINATED,
        'Collaboration removed from environment'
      );
    }

    this.activeCollaborations.delete(collaborationId);
    this.updatedAt = new Date();

    logger.info(`[EnvironmentCenter:${this.id}] Collaboration ${collaborationId} removed`);

    // Emit collaboration removed event
    this.eventEmitter.emit(EventType.AGENT_REGISTERED, {
      type: 'collaboration-removed',
      collaborationId,
      timestamp: new Date(),
    });
  }

  /**
   * Set CollaborationManager for this environment
   * @param collaborationManager - CollaborationManager instance
   */
  setCollaborationManager(collaborationManager: CollaborationManager): void {
    this.collaborationManager = collaborationManager;
    logger.info(`[EnvironmentCenter:${this.id}] CollaborationManager attached`);
  }

  /**
   * Execute a device service
   * Called by agents during AC execution to control devices
   *
   * @param deviceId - Device ID
   * @param serviceName - Service name to execute
   * @param parameters - Service parameters
   * @returns Service execution result
   */
  async executeDeviceService(
    deviceId: string,
    serviceName: string,
    parameters: Record<string, unknown> = {}
  ): Promise<unknown> {
    logger.info(`[EnvironmentCenter:${this.id}] Executing service ${serviceName} on device ${deviceId}`);

    const device = this.getDevice(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found in environment ${this.id}`);
    }

    // Execute the command on the device
    // SimulatedDevice uses executeCommand() method
    if ('executeCommand' in device && typeof device.executeCommand === 'function') {
      const result = await (device as unknown as { executeCommand: (name: string, params: Record<string, unknown>) => Promise<unknown> }).executeCommand(serviceName, parameters);

      // Emit device operation event
      this.eventEmitter.emit(EventType.DEVICE_STATE_CHANGE, {
        deviceId,
        deviceName: device.name,
        service: serviceName,
        parameters,
        result,
        timestamp: new Date(),
      });

      return result;
    } else {
      throw new Error(`Device ${deviceId} does not support command execution`);
    }
  }

  /**
   * Get the services registry for external access
   * Used by components that need to discover services
   *
   * @returns Services registry map
   */
  getServices(): Map<string, ServiceRegistration> {
    return this.services;
  }

  /**
   * Get the physics engine for this environment
   * Used by agents to observe environment parameters
   *
   * @returns Physics engine or undefined
   */
  getPhysicsEngine(): Record<string, unknown> | undefined {
    // Return the physical environment if it exists
    if (this.physicalEnvironment && typeof (this.physicalEnvironment as Record<string, unknown>).getPhysicsEngine === 'function') {
      return (this.physicalEnvironment as unknown as { getPhysicsEngine: () => Record<string, unknown> }).getPhysicsEngine();
    }
    return undefined;
  }
}
