/**
 * Agent Registry Module
 *
 * Extracted from EnvironmentCenter for Single Responsibility Principle.
 * Handles agent registration, tracking, and owner management.
 */

import type { EventManager } from '../../events/EventManager.js';
import type { EventEmitter } from '../../events/EventEmitter.js';
import { EventType } from '../../events/index.js';

import { createLogger } from '@active-collaboration/shared';
/**
 * Agent status
 */
const logger = createLogger('AgentRegistry');

export enum AgentStatus {
  INITIALIZING = 'initializing',
  IDLE = 'idle',
  BUSY = 'busy',
  COLLABORATING = 'collaborating',
  ERROR = 'error',
  TERMINATED = 'terminated',
}

/**
 * Agent interface
 */
export interface Agent {
  id: string;
  name: string;
  type?: string;
  status?: AgentStatus | string;
  capabilities?: string[];
  metadata?: Record<string, any>;
}

/**
 * Agent registration record
 */
export interface AgentRegistration {
  agent: Agent;
  ownerId: string;
  registeredAt: Date;
  messageBrokerAttached?: boolean;
}

/**
 * Agent filter options
 */
export interface AgentFilter {
  status?: AgentStatus | string;
  type?: string;
  ownerId?: string;
  capabilities?: string[];
  excludeIds?: string[];
}

/**
 * Agent Registry - Handles agent registration and management
 *
 * This class was extracted from EnvironmentCenter to follow Single Responsibility Principle.
 * It handles:
 * - Agent registration and removal
 * - Owner tracking
 * - Agent discovery and filtering
 */
export class AgentRegistry {
  private agents: Map<string, AgentRegistration> = new Map();
  private ownerAgents: Map<string, Set<string>> = new Map();

  constructor(
    private readonly environmentId: string,
    private readonly eventManager: EventManager,
    private readonly eventEmitter: EventEmitter
  ) {}

  /**
   * Register an agent
   */
  registerAgent(agent: Agent, ownerId: string): AgentRegistration {
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent ${agent.id} is already registered in this environment`);
    }

    const registration: AgentRegistration = {
      agent,
      ownerId,
      registeredAt: new Date(),
    };

    this.agents.set(agent.id, registration);

    // Track agent by owner
    if (!this.ownerAgents.has(ownerId)) {
      this.ownerAgents.set(ownerId, new Set());
    }
    this.ownerAgents.get(ownerId)!.add(agent.id);

    logger.info(`Registered agent: ${agent.id} (${agent.name}) owned by ${ownerId}`);

    // Emit agent registered event
    this.eventEmitter.emit(EventType.AGENT_REGISTERED, {
      environmentId: this.environmentId,
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.type,
      ownerId,
      capabilities: agent.capabilities || [],
      timestamp: new Date(),
    });

    return registration;
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): boolean {
    const registration = this.agents.get(agentId);
    if (!registration) {
      return false;
    }

    this.agents.delete(agentId);

    // Remove from owner tracking
    const ownerAgents = this.ownerAgents.get(registration.ownerId);
    if (ownerAgents) {
      ownerAgents.delete(agentId);
      if (ownerAgents.size === 0) {
        this.ownerAgents.delete(registration.ownerId);
      }
    }

    logger.info(`Unregistered agent: ${agentId}`);
    return true;
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId)?.agent;
  }

  /**
   * Get agent registration by ID
   */
  getAgentRegistration(agentId: string): AgentRegistration | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Check if agent exists
   */
  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Get all agents
   */
  getAllAgents(): Agent[] {
    return Array.from(this.agents.values()).map(r => r.agent);
  }

  /**
   * Get all agent registrations
   */
  getAllRegistrations(): AgentRegistration[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by owner
   */
  getAgentsByOwner(ownerId: string): Agent[] {
    const agentIds = this.ownerAgents.get(ownerId);
    if (!agentIds) {
      return [];
    }
    return Array.from(agentIds)
      .map(id => this.agents.get(id)?.agent)
      .filter((a): a is Agent => a !== undefined);
  }

  /**
   * Get agent owner
   */
  getAgentOwner(agentId: string): string | undefined {
    return this.agents.get(agentId)?.ownerId;
  }

  /**
   * Filter agents by criteria
   */
  filterAgents(filter: AgentFilter): Agent[] {
    let agents = this.getAllAgents();

    if (filter.status) {
      agents = agents.filter(a => a.status === filter.status);
    }

    if (filter.type) {
      agents = agents.filter(a => a.type === filter.type);
    }

    if (filter.ownerId) {
      agents = agents.filter(a => this.getAgentOwner(a.id) === filter.ownerId);
    }

    if (filter.capabilities && filter.capabilities.length > 0) {
      const requiredCapabilities = filter.capabilities;
      agents = agents.filter(agent => {
        const agentCapabilities = agent.capabilities || [];
        if (agentCapabilities.length === 0) {
          return false;
        }

        // Bidirectional capability matching
        return requiredCapabilities.some(cap => {
          const capLower = cap.toLowerCase();
          return agentCapabilities.some(agentCap => {
            const agentCapLower = agentCap.toLowerCase();
            return agentCapLower.includes(capLower) || capLower.includes(agentCapLower);
          });
        });
      });
    }

    if (filter.excludeIds && filter.excludeIds.length > 0) {
      agents = agents.filter(a => !filter.excludeIds!.includes(a.id));
    }

    return agents;
  }

  /**
   * Get agents by status
   */
  getAgentsByStatus(status: AgentStatus | string): Agent[] {
    return this.filterAgents({ status });
  }

  /**
   * Get agents by type
   */
  getAgentsByType(type: string): Agent[] {
    return this.filterAgents({ type });
  }

  /**
   * Get agents with specific capability
   */
  getAgentsWithCapability(capability: string): Agent[] {
    return this.filterAgents({ capabilities: [capability] });
  }

  /**
   * Get available agents (idle status)
   */
  getAvailableAgents(): Agent[] {
    return this.getAgentsByStatus(AgentStatus.IDLE);
  }

  /**
   * Get agent count
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * Get agent count by owner
   */
  getAgentCountByOwner(ownerId: string): number {
    return this.ownerAgents.get(ownerId)?.size || 0;
  }

  /**
   * Get owners list
   */
  getOwners(): string[] {
    return Array.from(this.ownerAgents.keys());
  }

  /**
   * Get agents grouped by owner
   */
  getAgentsGroupedByOwner(): Record<string, Agent[]> {
    const result: Record<string, Agent[]> = {};
    for (const [ownerId, agentIds] of this.ownerAgents.entries()) {
      result[ownerId] = Array.from(agentIds)
        .map(id => this.agents.get(id)?.agent)
        .filter((a): a is Agent => a !== undefined);
    }
    return result;
  }

  /**
   * Update agent status
   */
  updateAgentStatus(agentId: string, status: AgentStatus | string): boolean {
    const registration = this.agents.get(agentId);
    if (!registration) {
      return false;
    }

    registration.agent.status = status;
    logger.info(`Updated agent ${agentId} status to ${status}`);
    return true;
  }

  /**
   * Clear all agents
   */
  clearAll(): void {
    this.agents.clear();
    this.ownerAgents.clear();
    logger.info(`Cleared all agents`);
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalAgents: number;
    ownerCount: number;
    agentsByStatus: Record<string, number>;
    agentsByType: Record<string, number>;
    agentsByOwner: Record<string, number>;
  } {
    const agentsByStatus: Record<string, number> = {};
    const agentsByType: Record<string, number> = {};
    const agentsByOwner: Record<string, number> = {};

    for (const registration of this.agents.values()) {
      const status = registration.agent.status || 'unknown';
      agentsByStatus[status] = (agentsByStatus[status] || 0) + 1;

      const type = registration.agent.type || 'unknown';
      agentsByType[type] = (agentsByType[type] || 0) + 1;

      const owner = registration.ownerId;
      agentsByOwner[owner] = (agentsByOwner[owner] || 0) + 1;
    }

    return {
      totalAgents: this.agents.size,
      ownerCount: this.ownerAgents.size,
      agentsByStatus,
      agentsByType,
      agentsByOwner,
    };
  }
}
