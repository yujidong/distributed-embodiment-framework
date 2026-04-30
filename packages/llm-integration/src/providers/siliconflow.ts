import 'cross-fetch/polyfill';
import fetch from 'cross-fetch';
import { BaseProvider } from './base';
import { ChatParams, ChatResponse, LLMError, EmbeddingParams, EmbeddingResponse } from '../types';

/**
 * SiliconFlow API credentials from environment
 */
export interface SiliconFlowConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

/**
 * SiliconFlow API response format (OpenAI-compatible)
 */
interface SiliconFlowAPIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * SiliconFlow LLM provider
 *
 * Uses SiliconFlow API with Qwen/Qwen3-8B model
 * API is OpenAI-compatible
 */
export class SiliconFlowProvider extends BaseProvider {
  private apiKey: string;
  private baseURL: string;

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

    super('siliconflow', model, { apiKey, baseURL });
    this.apiKey = apiKey;
    this.baseURL = baseURL;

    this.log('Initialized', { model, baseURL });
  }

  /**
   * Send chat completion request to SiliconFlow API
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const startTime = Date.now();
    const model = params.model || this.defaultModel;

    this.log('Sending chat request', {
      messageCount: params.messages.length,
      model,
      temperature: params.temperature,
    });

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: params.messages,
          temperature: params.temperature || 0.7,
          max_tokens: params.maxTokens || 2000,
        }),
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logError('API request failed', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new LLMError(
          `API request failed: ${response.status} ${response.statusText}`,
          'siliconflow',
          new Error(errorText)
        );
      }

      const data: SiliconFlowAPIResponse = await response.json();

      const duration = Date.now() - startTime;
      this.log('Chat response received', {
        duration: `${duration}ms`,
        tokens: data.usage.total_tokens,
      });

      return {
        content: data.choices[0].message.content,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
        model: data.model,
      };
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }

      this.logError('Chat request error', error);
      throw new LLMError(
        `Failed to complete chat request: ${error instanceof Error ? error.message : String(error)}`,
        'siliconflow',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if SiliconFlow API is accessible
   */

  /**
   * Generate embedding for text using SiliconFlow API
   * Note: SiliconFlow may not support embeddings, so this returns an error
   * Use Ollama provider for embedding generation instead
   */
  async generateEmbedding(_params: EmbeddingParams): Promise<EmbeddingResponse> {
    // SiliconFlow API doesn't currently support embeddings
    // This is a placeholder that returns an error
    this.log('Embedding generation', 'SiliconFlow does not support embeddings. Use Ollama provider instead.');

    return {
      success: false,
      error: 'SiliconFlow does not support embedding generation. Use Ollama provider instead.',
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.log('Health check', 'Checking API connectivity...');

      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      const isHealthy = response.ok;

      this.log('Health check', isHealthy ? 'OK' : `Failed: ${response.status}`);

      return isHealthy;
    } catch (error) {
      this.logError('Health check failed', error);
      return false;
    }
  }
}
