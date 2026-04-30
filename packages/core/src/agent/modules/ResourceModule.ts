/**
 * Resource Module
 *
 * Provides resource management services:
 * - ResourceManager: Manages agent resources
 * - ResourceAllocator: Allocates resources to tasks
 */

import { BaseModule } from '../../container/Module.js';
import {
  TOKEN_RESOURCE_MANAGER,
  TOKEN_RESOURCE_ALLOCATOR
} from '../../container/InjectionTokens.js';
import { ResourceManager } from '../../resource/ResourceManager.js';
import { ResourceAllocator } from '../../resource/ResourceAllocator.js';
import { ServiceLifetime } from '../../container/types.js';

/**
 * Resource Module - manages agent resources
 */
export class ResourceModule extends BaseModule {
  constructor() {
    super({
      name: 'ResourceModule',
      providers: [
        {
          token: TOKEN_RESOURCE_MANAGER,
          factory: () => {
            // ResourceManager will be created differently - through agent initialization
            // For now, this is a placeholder
            throw new Error('ResourceManager must be created through agent initialization');
          },
          lifetime: ServiceLifetime.Singleton
        },
        {
          token: TOKEN_RESOURCE_ALLOCATOR,
          factory: () => {
            // ResourceAllocator will be created differently - through agent initialization
            // For now, this is a placeholder
            throw new Error('ResourceAllocator must be created through agent initialization');
          },
          lifetime: ServiceLifetime.Singleton,
          dependencies: [TOKEN_RESOURCE_MANAGER]
        }
      ],
      exports: [
        TOKEN_RESOURCE_MANAGER,
        TOKEN_RESOURCE_ALLOCATOR
      ]
    });
  }
}
