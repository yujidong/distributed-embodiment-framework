import { OpenAICompatibleProvider } from './openai-compatible';
import { LLMError, EmbeddingParams, EmbeddingResponse } from '../types';

/**
 * SiliconFlow API credentials from environment
 */
export interface SiliconFlowConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

/**
 * SiliconFlow LLM provider
 *
 * Thin preset over OpenAICompatibleProvider with the SiliconFlow endpoint
 * (https://api.siliconflow.cn/v1) and Qwen/Qwen3-8B as the default model.
 * API is OpenAI-compatible; a Bearer apiKey is required.
 */
export class SiliconFlowProvider extends OpenAICompatibleProvider {
  constructor(config: SiliconFlowConfig) {
    const {
      apiKey = process.env.SILICONFLOW_API_KEY || '',
      baseURL = 'https://api.siliconflow.cn/v1',
      model = 'Qwen/Qwen3-8B',
    } = config;

    if (!apiKey) {
      throw new LLMError(
        'API key is required. Set SILICONFLOW_API_KEY environment variable.',
        'siliconflow'
      );
    }

    super({ baseURL, apiKey, model }, 'siliconflow');
  }

  /**
   * Generate embedding for text using SiliconFlow API
   * Note: SiliconFlow may not support embeddings, so this returns an error
   */
  async generateEmbedding(_params: EmbeddingParams): Promise<EmbeddingResponse> {
    // SiliconFlow API doesn't currently support embeddings
    // This is a placeholder that returns an error
    this.log('Embedding generation', 'SiliconFlow does not support embeddings.');

    return {
      success: false,
      error: 'SiliconFlow does not support embedding generation.',
    };
  }
}
