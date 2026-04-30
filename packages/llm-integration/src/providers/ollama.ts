import 'cross-fetch/polyfill';
import fetch from 'cross-fetch';
import { BaseProvider } from './base';
import { ChatParams, ChatResponse, LLMError, EmbeddingParams, EmbeddingResponse } from '../types';
import { ModelStrategy } from '../ModelStrategy';
import { TaskType, TaskComplexity } from '../model-config';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('OllamaProvider');

/**
 * Ollama API configuration
 */
export interface OllamaConfig {
  baseURL?: string;
  model?: string;
  strategy?: import('../ModelStrategy').ModelStrategy;
  timeout?: number;  // Request timeout in milliseconds (default: 120000 for large models)
  numGPU?: number;   // Number of GPU layers to offload (default: auto, set to 99 to force GPU)
  numThread?: number;  // Number of threads to use (default: auto, set to 8 for multi-core)
}

/**
 * Ollama API chat request format
 */
interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  tools?: Array<{
    type: string;
    function: {
      name: string;
      description: string;
      parameters: {
        type: string;
        properties: Record<string, {
          type: string;
          description: string;
        }>;
        required: string[];
      };
    };
  }>;
  options?: {
    temperature?: number;
    num_predict?: number;
    num_gpu?: number;
    num_thread?: number;
  };
}

/**
 * Ollama API response format
 */
interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      type: string;
      function: {
        name: string;
        arguments: { [key: string]: any };
      };
    }>;
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama LLM provider (local)
 *
 * Connects to local Ollama instance
 * Default endpoint: http://localhost:11434
 */
export class OllamaProvider extends BaseProvider {
  private baseURL: string;
  private strategy?: ModelStrategy;
  private numGPU?: number;
  private numThread?: number;

  constructor(config: OllamaConfig = {}) {
    const {
      baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model = process.env.OLLAMA_MODEL || 'llama3.2',
      strategy,
      timeout = 120000,  // 2 minutes default for large models (32b, 70b)
      numGPU,
      numThread,
    } = config;

    super('ollama', model, { baseURL, timeout });
    this.baseURL = baseURL;
    this.strategy = strategy;
    this.numGPU = numGPU;
    this.numThread = numThread;

    this.log('Initialized', {
      model,
      baseURL,
      timeout,
      ...(numGPU !== undefined && { numGPU }),
      ...(numThread !== undefined && { numThread }),
      hasStrategy: !!strategy
    });
  }

  /**
   * Set or update the model strategy
   */
  setModelStrategy(strategy: ModelStrategy): void {
    this.strategy = strategy;
    this.log('Model strategy updated', { hasStrategy: true });
  }

  /**
   * Get the current model strategy
   */
  getModelStrategy(): ModelStrategy | undefined {
    return this.strategy;
  }

  // ========================================================================
  // Task-Aware Chat Methods
  // ========================================================================

  /**
   * Chat with automatic model selection based on task type
   */
  async chatByTask(
    taskType: TaskType,
    params: ChatParams,
    complexity?: TaskComplexity
  ): Promise<ChatResponse & { selectedModel: string }> {
    // Validate params
    if (!params || !params.messages) {
      const error = new LLMError(
        `chatByTask called with invalid params: ${JSON.stringify(params)}`,
        'ollama',
        new Error('Invalid params: messages array is required')
      );
      this.logError('chatByTask validation error', { params, taskType, complexity });
      throw error;
    }

    if (!this.strategy) {
      this.log('No strategy configured, using default model', { taskType, params: { messageCount: params.messages.length } });
      const response = await this.chat(params);
      return { ...response, selectedModel: response.model };
    }

    // Select model based on task
    const selection = this.strategy.selectModel(taskType, complexity);
    this.log('Task-aware chat', {
      taskType,
      complexity,
      selectedModel: selection.model,
      reason: selection.reason,
      messageCount: params.messages.length,
    });

    // Execute chat with selected model
    const startTime = Date.now();
    try {
      const response = await this.chat({ ...params, model: selection.model });
      const duration = Date.now() - startTime;

      // Record success
      this.strategy.markModelSuccess(selection.model);
      this.strategy.recordModelLoadTime(selection.model, duration);

      return { ...response, selectedModel: selection.model };
    } catch (error) {
      // Enhanced error logging
      const duration = Date.now() - startTime;
      this.logError('chatByTask failed', {
        taskType,
        complexity,
        selectedModel: selection.model,
        duration: `${duration}ms`,
        error: error instanceof Error ? error.message : String(error),
        messageCount: params.messages.length,
      });

      // Record failure
      this.strategy.markModelFailed(selection.model);
      throw error;
    }
  }

  /**
   * Stream chat with task-based model selection
   */
  async *chatStreamByTask(
    taskType: TaskType,
    params: ChatParams,
    complexity?: TaskComplexity
  ): AsyncGenerator<string, void, unknown> {
    if (!this.strategy) {
      throw new Error('Streaming requires a ModelStrategy to be configured');
    }

    const selection = this.strategy.selectModel(taskType, complexity);
    this.log('Task-aware streaming chat', {
      taskType,
      selectedModel: selection.model,
    });

    // For streaming, we'd need to implement streaming support
    // For now, fall back to non-streaming
    const response = await this.chat({ ...params, model: selection.model });
    yield response.content;
  }

  /**
   * Send chat completion request to Ollama API
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const startTime = Date.now();
    const model = params.model || this.defaultModel;

    this.log('Sending chat request', {
      messageCount: params.messages.length,
      model,
      temperature: params.temperature,
      hasTools: !!params.tools?.length,
    });

    try {
      // Build options object, only include GPU/thread options if defined
      const options: Record<string, any> = {
        temperature: params.temperature || 0.7,
        num_predict: params.maxTokens || 4096,
      };

      if (this.numGPU !== undefined) {
        options.num_gpu = this.numGPU;
      }
      if (this.numThread !== undefined) {
        options.num_thread = this.numThread;
      }

      const requestBody: OllamaChatRequest = {
        model,
        messages: params.messages,
        stream: false,
        options,
      };

      // Add tools if provided
      if (params.tools && params.tools.length > 0) {
        requestBody.tools = params.tools as OllamaChatRequest['tools'];
      }

      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
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
          'ollama',
          new Error(errorText)
        );
      }

      const data: OllamaChatResponse = await response.json();

      const duration = Date.now() - startTime;
      this.log('Chat response received', {
        duration: `${duration}ms`,
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
        hasToolCalls: !!data.message.tool_calls?.length,
        contentLength: data.message.content?.length || 0,
      });

      // Debug: Log raw response data
      if (!data.message.content || data.message.content.length === 0) {
        logger.warn('Empty content received');
        logger.debug('Raw message:', JSON.stringify(data.message, null, 2));
      }

      // Process tool calls if present
      const toolCalls = data.message.tool_calls?.map(tc => ({
        id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));

      // Strip qwen3-style thinking tags from response content.
      // qwen3 models (qwen3-14b, qwen3-4b, etc.) emit <think ...>...</think > blocks
      // that wrap their internal reasoning. These are NOT part of the actual answer
      // and will break JSON parsers downstream if left in place.
      let content = data.message.content || '';
      content = content.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/g, '').trim();

      // Log warning when Ollama omits token count fields (intermittent issue)
      if (data.prompt_eval_count === undefined || data.eval_count === undefined) {
        this.log('Warning: Ollama response missing token count fields', {
          has_prompt_eval_count: data.prompt_eval_count !== undefined,
          has_eval_count: data.eval_count !== undefined,
          model: data.model,
        });
      }

      const promptTokens = data.prompt_eval_count ?? 0;
      const completionTokens = data.eval_count ?? 0;

      return {
        content,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        model: data.model,
        toolCalls,
      };
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }

      // Provide helpful error message for common issues
      let errorMessage = `Failed to complete chat request`;

      if (error instanceof TypeError && error.message.includes('fetch')) {
        errorMessage += '. Is Ollama running? Start with: ollama serve';
      } else if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
      } else {
        errorMessage += `: ${String(error)}`;
      }

      this.logError('Chat request error', error);
      throw new LLMError(errorMessage, 'ollama', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Check if Ollama is running and accessible
   */

  /**
   * Generate embedding for text using Ollama API
   */
  async generateEmbedding(params: EmbeddingParams): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const model = params.model || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';

    this.log('Generating embedding', { inputLength: params.input.length, model });

    try {
      const requestBody = {
        model,
        prompt: params.input,
      };

      const response = await fetch(`${this.baseURL}/api/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logError('Embedding API request failed', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        return {
          success: false,
          error: `API request failed: ${response.status} ${response.statusText}`,
        };
      }

      const data = await response.json();

      if (!data.embedding || !Array.isArray(data.embedding)) {
        return {
          success: false,
          error: 'Invalid response: missing embedding array',
        };
      }

      const duration = Date.now() - startTime;
      this.log('Embedding generated', {
        duration: `${duration}ms`,
        dimension: data.embedding.length,
      });

      return {
        success: true,
        embedding: data.embedding,
        model,
      };
    } catch (error) {
      this.logError('Embedding generation error', error);

      // Provide helpful error message for common issues
      let errorMessage = 'Failed to generate embedding';

      if (error instanceof TypeError && error.message.includes('fetch')) {
        errorMessage += '. Is Ollama running? Start with: ollama serve';
      } else if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
      } else {
        errorMessage += `: ${String(error)}`;
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.log('Health check', 'Checking Ollama connectivity...');

      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      const isHealthy = response.ok;

      if (isHealthy) {
        const data = await response.json();
        const modelNames = data.models?.map((m: any) => m.name) || [];
        this.log('Health check', `OK - Available models: ${modelNames.join(', ')}`);
      } else {
        this.log('Health check', `Failed: ${response.status}`);
      }

      return isHealthy;
    } catch (error) {
      this.logError('Health check failed', error);
      return false;
    }
  }

  /**
   * List available models from Ollama
   */
  async listModels(): Promise<Array<{ name: string; size?: number; modified_at?: string }>> {
    this.log('List models', 'Fetching available models from Ollama...');

    try {
      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logError('List models failed', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        throw new LLMError(
          `Failed to list models: ${response.status} ${response.statusText}`,
          'ollama',
          new Error(errorText)
        );
      }

      const data = await response.json();
      const models = data.models?.map((m: any) => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
      })) || [];

      this.log('Available models', models.map((m: any) => m.name).join(', '));

      return models;
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logError('List models error', error);
      throw new LLMError(
        `Failed to list models: ${errorMessage}. Is Ollama running?`,
        'ollama',
        error instanceof Error ? error : undefined
      );
    }
  }
}
