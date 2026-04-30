/**
 * Core Module
 *
 * Provides fundamental agent services:
 * - EventManager: System-wide event handling
 * - EventEmitter: Event emission for agent
 * - ContextBuilder: Agent context building
 */

import { BaseModule } from '../../container/Module.js';
import {
  TOKEN_EVENT_MANAGER,
  TOKEN_EVENT_EMITTER,
  TOKEN_CONTEXT_BUILDER,
  TOKEN_ENVIRONMENT_CENTER,
  TOKEN_LLM_CLIENT
} from '../../container/InjectionTokens.js';
import { EventManager } from '../../events/EventManager.js';
import { EventEmitter } from '../../events/EventEmitter.js';
import { AgentContextBuilder } from '../../context/AgentContextBuilder.js';
import { ServiceLifetime } from '../../container/types.js';

/**
 * Core Module - provides fundamental agent services
 */
export class CoreModule extends BaseModule {
  constructor() {
    super({
      name: 'CoreModule',
      providers: [
        {
          token: TOKEN_EVENT_MANAGER,
          factory: () => new EventManager(1000),
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: TOKEN_EVENT_EMITTER,
          factory: () => {
            // EventEmitter will be created differently - through agent initialization
            // For now, this is a placeholder
            throw new Error('EventEmitter must be created through agent initialization');
          },
          lifetime: ServiceLifetime.Singleton,
          dependencies: [TOKEN_EVENT_MANAGER]
        },
        {
          token: TOKEN_CONTEXT_BUILDER,
          factory: () => {
            // ContextBuilder will be created differently - through agent initialization
            // For now, this is a placeholder
            throw new Error('ContextBuilder must be created through agent initialization');
          },
          lifetime: ServiceLifetime.Singleton,
          dependencies: [TOKEN_ENVIRONMENT_CENTER, TOKEN_LLM_CLIENT]
        }
      ],
      exports: [
        TOKEN_EVENT_MANAGER,
        TOKEN_EVENT_EMITTER,
        TOKEN_CONTEXT_BUILDER
      ]
    });
  }
}
