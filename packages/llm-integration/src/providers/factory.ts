import { LLMProvider } from './base';
import { SiliconFlowProvider, SiliconFlowConfig } from './siliconflow';
import { OpenAICompatibleProvider, OpenAICompatibleConfig } from './openai-compatible';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ProviderFactory');

/**
 * Supported provider types
 */
export type ProviderType = 'siliconflow' | 'openai-compatible';

/**
 * Configuration for creating a provider
 */
export type ProviderConfigType = SiliconFlowConfig | OpenAICompatibleConfig;

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
 * // Create a generic OpenAI-compatible provider (e.g. local vLLM server)
 * const provider = createProvider('openai-compatible', {
 *   baseURL: 'http://localhost:8000/v1',
 *   model: 'Qwen/Qwen2.5-7B-Instruct',
 * });
 * ```
 */
export function createProvider(type: ProviderType, config?: ProviderConfigType): LLMProvider {
  logger.info(`Creating provider: ${type}`);

  switch (type) {
    case 'siliconflow':
      return new SiliconFlowProvider(config as SiliconFlowConfig);
    case 'openai-compatible':
      return new OpenAICompatibleProvider(config as OpenAICompatibleConfig);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

/**
 * Get list of available provider types
 */
export function getAvailableProviders(): ProviderType[] {
  return ['siliconflow', 'openai-compatible'];
}
