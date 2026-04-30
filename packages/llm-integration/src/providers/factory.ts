import { LLMProvider } from './base';
import { SiliconFlowProvider, SiliconFlowConfig } from './siliconflow';
import { OllamaProvider, OllamaConfig } from './ollama';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ProviderFactory');

/**
 * Supported provider types
 */
export type ProviderType = 'ollama' | 'siliconflow';

/**
 * Configuration for creating a provider
 */
export type ProviderConfigType = SiliconFlowConfig | OllamaConfig;

/**
 * Create an LLM provider instance
 *
 * @param type - Provider type to create
 * @param config - Provider-specific configuration
 * @returns Configured LLM provider instance
 *
 * @example
 * ```typescript
 * // Create SiliconFlow provider
 * const provider = createProvider('siliconflow', {
 *   apiKey: 'sk-xxx',
 *   model: 'Qwen/Qwen3-8B-Instruct',
 * });
 *
 * // Create Ollama provider
 * const provider = createProvider('ollama', {
 *   model: 'llama3.2',
 * });
 * ```
 */
export function createProvider(type: ProviderType, config?: ProviderConfigType): LLMProvider {
  logger.info(`Creating provider: ${type}`);

  switch (type) {
    case 'siliconflow':
      return new SiliconFlowProvider(config as SiliconFlowConfig);
    case 'ollama':
      return new OllamaProvider(config as OllamaConfig);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

/**
 * Get list of available provider types
 */
export function getAvailableProviders(): ProviderType[] {
  return ['ollama', 'siliconflow'];
}
