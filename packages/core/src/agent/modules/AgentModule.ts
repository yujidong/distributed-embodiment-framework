/**
 * Agent Module
 *
 * Main module that aggregates all agent sub-modules.
 * This provides a complete DI container for CognitiveAgent.
 */

import { BaseModule } from '../../container/Module.js';
import { CoreModule } from './CoreModule.js';
import { ResourceModule } from './ResourceModule.js';
import {
  TOKEN_ENVIRONMENT_CENTER,
  TOKEN_LLM_CLIENT,
  TOKEN_RESOURCE_COORDINATOR,
  TOKEN_COLLABORATION_COORDINATOR,
  TOKEN_SERVICE_EXECUTION_COORDINATOR
} from '../../container/InjectionTokens.js';
import { ServiceLifetime } from '../../container/types.js';

/**
 * Agent Configuration
 */
export interface AgentModuleConfig {
  id: string;
  name: string;
  description: string;
  owner: string;
  capabilities?: string[];
  environment: any;
  llmClient: any;
}

/**
 * Agent Module - main module that aggregates all agent sub-modules
 *
 * This module provides a complete DI container for CognitiveAgent
 */
export class AgentModule extends BaseModule {
  private agentConfig: AgentModuleConfig;

  constructor(config: AgentModuleConfig) {
    super({
      name: 'AgentModule',
      imports: [
        new CoreModule(),
        new ResourceModule()
      ],
      providers: [
        // Agent-specific configuration tokens
        {
          token: 'agentId',
          factory: () => config.id,
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: 'agentName',
          factory: () => config.name,
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: 'agentDescription',
          factory: () => config.description,
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: 'agentOwner',
          factory: () => config.owner,
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: 'agentCapabilities',
          factory: () => config.capabilities || ['task-execution'],
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: TOKEN_ENVIRONMENT_CENTER,
          factory: () => config.environment,
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: TOKEN_LLM_CLIENT,
          factory: () => config.llmClient,
          lifetime: ServiceLifetime.Singleton
        },
        // Coordinators will be registered here when created
        // {
        //   token: TOKEN_RESOURCE_COORDINATOR,
        //   factory: (container) => new ResourceCoordinator(...),
        //   lifetime: ServiceLifetime.Singleton
        // }
      ],
      exports: [
        'agentId',
        'agentName',
        'agentOwner',
        'agentCapabilities',
        TOKEN_ENVIRONMENT_CENTER,
        TOKEN_LLM_CLIENT
      ]
    });

    this.agentConfig = config;
  }

  /**
   * Get agent configuration
   */
  getConfig(): AgentModuleConfig {
    return this.agentConfig;
  }
}
