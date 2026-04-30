import { ChatParams, ChatResponse, ProviderConfig, EmbeddingParams, EmbeddingResponse } from '../types';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('BaseProvider');

/**
 * Abstract base interface for LLM providers
 *
 * All LLM providers (Ollama, SiliconFlow, etc.) must implement this interface.
 * This allows for easy switching between different LLM backends.
 */
export interface LLMProvider {
  /**
   * Provider name (e.g., 'ollama', 'siliconflow')
   */
  readonly name: string;

  /**
   * Default model for this provider
   */
  readonly defaultModel: string;

  /**
   * Send chat completion request
   *
   * @param params - Chat parameters including messages and optional settings
   * @returns Promise with chat response
   * @throws LLMError if request fails
   */
  chat(params: ChatParams): Promise<ChatResponse>;

  /**
   * Generate embedding for text
   *
   * @param params - Embedding parameters including input text
   * @returns Promise with embedding vector
   * @throws LLMError if request fails
   */
  generateEmbedding(params: EmbeddingParams): Promise<EmbeddingResponse>;

  /**
   * Check if provider is available/healthy
   *
   * @returns Promise resolving to true if provider is ready
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get current configuration
   */
  getConfig(): ProviderConfig;
}

/**
 * Abstract base class with common provider functionality
 */
export abstract class BaseProvider implements LLMProvider {
  protected config: ProviderConfig;

  constructor(
    public readonly name: string,
    public readonly defaultModel: string,
    config?: ProviderConfig
  ) {
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  abstract chat(params: ChatParams): Promise<ChatResponse>;
  abstract generateEmbedding(params: EmbeddingParams): Promise<EmbeddingResponse>;
  abstract healthCheck(): Promise<boolean>;

  getConfig(): ProviderConfig {
    return { ...this.config };
  }

  /**
   * Log provider actions for debugging
   */
  protected log(action: string, details: any): void {
    logger.info(`[${this.name}] ${action}:`, details);
  }

  /**
   * Log provider errors
   */
  protected logError(action: string, error: any): void {
    logger.error(`[${this.name}] ${action}:`, error);
  }
}
