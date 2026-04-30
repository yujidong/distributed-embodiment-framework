/**
 * Agent Factory
 *
 * Factory for creating Cognitive Agents with common configurations
 */

import { v4 as uuidv4 } from 'uuid';
import { CognitiveAgent, CognitiveAgentConfig } from './CognitiveAgent.js';
import type { EnvironmentCenter } from '../environment/EnvironmentCenter.js';
import type { LLMClient } from '@active-collaboration/llm-integration';

import { createLogger } from '@active-collaboration/shared';
/**
 * Agent template
 */
const logger = createLogger('AgentFactory');

export interface AgentTemplate {
  name: string;
  description: string;
  capabilities: string[];
  metadata?: Record<string, any>;
}

/**
 * Predefined agent templates
 */
export const AgentTemplates: Record<string, AgentTemplate> = {
  'task-executor': {
    name: 'Task Executor Agent',
    description: 'Executes tasks on IoT devices',
    capabilities: ['task-execution', 'device-control', 'monitoring'],
    metadata: { category: 'executor' },
  },
  'code-generator': {
    name: 'Code Generator Agent',
    description: 'Generates and executes automation code',
    capabilities: ['code-generation', 'code-execution', 'automation'],
    metadata: { category: 'developer' },
  },
  'collaborator': {
    name: 'Collaborator Agent',
    description: 'Collaborates with other agents',
    capabilities: ['collaboration', 'negotiation', 'coordination'],
    metadata: { category: 'coordinator' },
  },
  'monitor': {
    name: 'Monitor Agent',
    description: 'Monitors devices and reports status',
    capabilities: ['monitoring', 'reporting', 'alerting'],
    metadata: { category: 'observer' },
  },
  'orchestrator': {
    name: 'Orchestrator Agent',
    description: 'Orchestrates complex multi-agent workflows',
    capabilities: [
      'orchestration',
      'task-decomposition',
      'coordination',
      'collaboration',
      'code-generation',
    ],
    metadata: { category: 'manager' },
  },
  // Frontend-compatible templates
  'cognitive': {
    name: 'Cognitive Agent',
    description: 'Advanced agent with task management, dialogue, and code generation capabilities',
    capabilities: [
      'orchestration',
      'task-decomposition',
      'coordination',
      'collaboration',
      'code-generation',
      'dialogue',
      'device-control',
    ],
    metadata: { category: 'manager' },
  },
  'automation': {
    name: 'Automation Agent',
    description: 'Agent focused on automating repetitive tasks and workflows',
    capabilities: ['task-execution', 'device-control', 'automation', 'code-execution'],
    metadata: { category: 'executor' },
  },
  'monitoring': {
    name: 'Monitoring Agent',
    description: 'Agent specialized in monitoring device states and generating alerts',
    capabilities: ['monitoring', 'reporting', 'alerting', 'device-control'],
    metadata: { category: 'observer' },
  },
  'collaborative': {
    name: 'Collaborative Agent',
    description: 'Agent designed to work with other agents to complete complex tasks',
    capabilities: ['collaboration', 'negotiation', 'coordination', 'dialogue'],
    metadata: { category: 'coordinator' },
  },
};

/**
 * Agent Factory creates Cognitive Agents
 */
export class AgentFactory {
  /**
   * Create a basic Cognitive Agent
   * @param name - Agent name
   * @param description - Agent description
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @param options - Additional options
   * @returns Created agent
   */
  static createAgent(
    name: string,
    description: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient,
    options: {
      id?: string;
      capabilities?: string[];
      metadata?: Record<string, any>;
    } = {}
  ): CognitiveAgent {
    const config: CognitiveAgentConfig = {
      id: options.id || uuidv4(),
      name,
      description,
      owner,
      environment,
      llmClient,
      capabilities: options.capabilities,
      metadata: options.metadata,
    };

    return new CognitiveAgent(config);
  }

  /**
   * Create an agent from a template
   * @param templateKey - Template key
   * @param name - Custom name (overrides template)
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @param options - Additional options
   * @returns Created agent
   */
  static createFromTemplate(
    templateKey: string,
    name: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient,
    options: {
      id?: string;
      capabilities?: string[];
      metadata?: Record<string, any>;
    } = {}
  ): CognitiveAgent {
    const template = AgentTemplates[templateKey];

    if (!template) {
      throw new Error(`Unknown agent template: ${templateKey}`);
    }

    const config: CognitiveAgentConfig = {
      id: options.id || uuidv4(),
      name: name || template.name,
      description: template.description,
      owner,
      environment,
      llmClient,
      capabilities: options.capabilities || template.capabilities,
      metadata: { ...template.metadata, ...options.metadata },
    };

    logger.info(`Creating agent from template: ${templateKey}`);

    return new CognitiveAgent(config);
  }

  /**
   * Create a Task Executor Agent
   * @param name - Agent name
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @returns Created agent
   */
  static createTaskExecutor(
    name: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient
  ): CognitiveAgent {
    return this.createFromTemplate('task-executor', name, owner, environment, llmClient);
  }

  /**
   * Create a Code Generator Agent
   * @param name - Agent name
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @returns Created agent
   */
  static createCodeGenerator(
    name: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient
  ): CognitiveAgent {
    return this.createFromTemplate('code-generator', name, owner, environment, llmClient);
  }

  /**
   * Create a Collaborator Agent
   * @param name - Agent name
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @returns Created agent
   */
  static createCollaborator(
    name: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient
  ): CognitiveAgent {
    return this.createFromTemplate('collaborator', name, owner, environment, llmClient);
  }

  /**
   * Create a Monitor Agent
   * @param name - Agent name
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @returns Created agent
   */
  static createMonitor(
    name: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient
  ): CognitiveAgent {
    return this.createFromTemplate('monitor', name, owner, environment, llmClient);
  }

  /**
   * Create an Orchestrator Agent
   * @param name - Agent name
   * @param owner - Owner user ID
   * @param environment - Environment Center
   * @param llmClient - LLM client
   * @returns Created agent
   */
  static createOrchestrator(
    name: string,
    owner: string,
    environment: EnvironmentCenter,
    llmClient: LLMClient
  ): CognitiveAgent {
    return this.createFromTemplate('orchestrator', name, owner, environment, llmClient);
  }

  /**
   * List available templates
   * @returns Array of template keys and names
   */
  static listTemplates(): Array<{ key: string; name: string; description: string }> {
    return Object.entries(AgentTemplates).map(([key, template]) => ({
      key,
      name: template.name,
      description: template.description,
    }));
  }

  /**
   * Get template details
   * @param templateKey - Template key
   * @returns Template or undefined
   */
  static getTemplate(templateKey: string): AgentTemplate | undefined {
    return AgentTemplates[templateKey];
  }
}
