import 'dotenv/config';
import { LLMProvider } from './providers/base';
import { createProvider, ProviderType } from './providers/factory';
import { ChatParams, ChatResponse, LLMError } from './types';
import { TaskType, TaskComplexity } from './model-config';
import { OllamaProvider } from './providers/ollama';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('LLMClient');

/**
 * Request queue for controlling concurrency
 */
class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private activeCount = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = async () => {
        this.activeCount++;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeCount--;
          this.processNext();
        }
      };

      if (this.activeCount < this.maxConcurrent) {
        task();
      } else {
        this.queue.push(task);
      }
    });
  }

  private processNext() {
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  getStats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

// Global request queue for all LLM clients (shared across agents)
const globalRequestQueue = new RequestQueue(
  parseInt(process.env.LLM_MAX_CONCURRENT || '3', 10)
);

/**
 * Logging callback for LLM interactions
 */
export interface LLMLoggingCallback {
  (params: {
    systemPrompt?: string;
    userPrompt: string;
    response: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    durationMs: number;
    model?: string;
    success: boolean;
    errorMessage?: string;
    context?: {
      agentId?: string;
      agentName?: string;
      interactionType?: string;
      decisionContext?: string;
      decisionResult?: any;
    };
  }): void;
}

/**
 * Main LLM client for interacting with different providers
 *
 * Provides a unified interface for working with multiple LLM providers.
 * Handles provider switching and provides convenient chat methods.
 */
export class LLMClient {
  private provider: LLMProvider;
  private loggingCallback: LLMLoggingCallback | null = null;
  private contextProvider: (() => {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
  }) | null = null;

  /**
   * Create a new LLM client
   *
   * @param providerType - Type of provider to use ('ollama' or 'siliconflow')
   * @param config - Optional provider-specific configuration
   *
   * @example
   * ```typescript
   * // Use SiliconFlow with default config
   * const client = new LLMClient('siliconflow');
   *
   * // Use Ollama with custom model
   * const client = new LLMClient('ollama', { model: 'llama3.2' });
   * ```
   */
  constructor(providerType: ProviderType, config?: any) {
    logger.info(`Initializing with provider: ${providerType}`);

    this.provider = createProvider(providerType, config);

    logger.info(`Initialized successfully with ${this.provider.name}`);
  }

  /**
   * Send chat completion request
   *
   * @param params - Chat parameters
   * @returns Chat response with content and usage info
   *
   * @example
   * ```typescript
   * const response = await client.chat({
   *   messages: [
   *     { role: 'user', content: 'Hello!' }
   *   ],
   *   temperature: 0.7,
   * });
   * console.log(response.content);
   * ```
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const queueStats = globalRequestQueue.getStats();
    logger.info(`Sending chat request via ${this.provider.name} (queue: ${queueStats.active} active, ${queueStats.queued} waiting)`);

    const startTime = Date.now();
    const userPrompt = params.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    const systemPrompt = params.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');

    try {
      // Use request queue to control concurrency
      const response = await globalRequestQueue.run(() => this.provider.chat(params));
      const durationMs = Date.now() - startTime;

      logger.info(`Chat response received:`, {
        contentLength: response.content.length,
        tokens: response.usage?.totalTokens,
        model: response.model,
        durationMs,
      });

      // Call logging callback if set
      if (this.loggingCallback) {
        try {
          const context = this.contextProvider?.() || {};
          this.loggingCallback({
            systemPrompt,
            userPrompt,
            response: response.content,
            promptTokens: response.usage?.promptTokens,
            completionTokens: response.usage?.completionTokens,
            totalTokens: response.usage?.totalTokens,
            durationMs,
            model: response.model,
            success: true,
            context: {
              agentId: context.agentId,
              agentName: context.agentName,
              interactionType: context.interactionType,
              decisionContext: context.decisionContext,
              decisionResult: response.toolCalls?.length ? { toolCalls: response.toolCalls } : undefined,
            },
          });
        } catch (logError) {
          logger.error('Logging callback error:', logError);
        }
      }

      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      logger.error(`Chat request failed:`, error);

      // Call logging callback for error case
      if (this.loggingCallback) {
        try {
          const context = this.contextProvider?.() || {};
          this.loggingCallback({
            systemPrompt,
            userPrompt,
            response: '',
            durationMs,
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
            context: {
              agentId: context.agentId,
              agentName: context.agentName,
              interactionType: context.interactionType,
              decisionContext: context.decisionContext,
            },
          });
        } catch (logError) {
          logger.error('Logging callback error:', logError);
        }
      }

      if (error instanceof LLMError) {
        throw error;
      }

      throw new LLMError(
        `Chat request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.provider.name,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Quick chat with a single user message
   *
   * @param content - User message content
   * @param systemPrompt - Optional system prompt
   * @param tools - Optional tools for function calling
   * @returns Chat response with content and tool calls
   *
   * @example
   * ```typescript
   * const response = await client.quickChat('What is 2+2?');
   * console.log(response.content); // "2+2 equals 4."
   * ```
   */
  async quickChat(content: string, systemPrompt?: string, tools?: any[]): Promise<ChatResponse> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content });

    const response = await this.chat({ messages, tools });
    return response;
  }

  /**
   * Set logging callback for LLM interactions
   */
  setLoggingCallback(callback: LLMLoggingCallback | null): void {
    this.loggingCallback = callback;
  }

  /**
   * Set context provider for logging
   */
  setContextProvider(provider: () => {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
  }): void {
    this.contextProvider = provider;
  }

  /**
   * Check if the current provider is healthy
   *
   * @returns true if provider is accessible
   */
  async healthCheck(): Promise<boolean> {
    logger.info(`Checking health of ${this.provider.name}`);

    const isHealthy = await this.provider.healthCheck();

    logger.info(`Health check result: ${isHealthy ? 'OK' : 'FAILED'}`);

    return isHealthy;
  }

  /**
   * Get the current provider
   */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Get provider name
   */
  getProviderName(): string {
    return this.provider.name;
  }

  /**
   * Generate embedding for text
   *
   * @param input - Text to embed
   * @param model - Optional model to use for embedding
   * @returns Embedding response with vector
   *
   * @example
   * ```typescript
   * const response = await client.generateEmbedding('Hello world');
   * if (response.success && response.embedding) {
   *   console.log('Embedding dimension:', response.embedding.length);
   * }
   * ```
   */
  async generateEmbedding(input: string, model?: string): Promise<import('./types').EmbeddingResponse> {
    logger.info(`Generating embedding via ${this.provider.name}`);

    try {
      const response = await this.provider.generateEmbedding({ input, model });

      if (response.success) {
        logger.info(`Embedding generated: dimension=${response.embedding?.length}, model=${response.model}`);
      } else {
        logger.error(`Embedding generation failed: ${response.error}`);
      }

      return response;
    } catch (error) {
      logger.error(`Embedding generation error:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ========================================================================
  // Task-Based Chat Methods
  // ========================================================================

  /**
   * Chat with automatic model selection based on task type
   *
   * @param taskType - Type of task (control, planning, reasoning, code, etc.)
   * @param params - Chat parameters
   * @param complexity - Optional task complexity level
   * @returns Chat response with selected model info
   *
   * @example
   * ```typescript
   * const response = await client.chatByTask(TaskType.CONTROL, {
   *   messages: [{ role: 'user', content: 'Turn on the lights' }]
   * });
   * console.log(response.content);
   * console.log('Model used:', response.selectedModel);
   * ```
   */
  async chatByTask(
    taskType: TaskType,
    params: ChatParams,
    complexity?: TaskComplexity
  ): Promise<ChatResponse & { selectedModel: string }> {
    logger.info(`Task-based chat: ${taskType}`);

    // Check if provider is OllamaProvider with task support
    if (this.isOllamaProvider()) {
      const ollamaProvider = this.provider as unknown as OllamaProvider;
      return ollamaProvider.chatByTask(taskType, params, complexity);
    }

    // Fallback to regular chat for other providers
    logger.warn(`Task-based chat not supported by ${this.provider.name}, using default`);
    const response = await this.chat(params);
    return { ...response, selectedModel: response.model };
  }

  /**
   * Quick control command (fast model)
   *
   * @param command - Control command text
   * @returns Command response
   */
  async controlCommand(command: string): Promise<string> {
    const response = await this.chatByTask(TaskType.CONTROL, {
      messages: [{ role: 'user', content: command }],
    });
    return response.content;
  }

  /**
   * Planning task (complex model)
   *
   * @param task - Planning task description
   * @param context - Optional context
   * @returns Plan response
   */
  async planTask(task: string, context?: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: 'You are a task planning assistant. Break down complex tasks into steps.' },
    ];

    if (context) {
      messages.push({ role: 'system', content: `Context: ${context}` });
    }

    messages.push({ role: 'user', content: task });

    const response = await this.chatByTask(TaskType.PLANNING, { messages });
    return response.content;
  }

  /**
   * Code generation (code model)
   *
   * @param prompt - Code generation prompt
   * @param language - Programming language
   * @returns Generated code
   */
  async generateCode(prompt: string, language?: string): Promise<string> {
    const languageContext = language ? ` in ${language}` : '';
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: `You are a code generation expert. Generate clean, well-documented code${languageContext}.` },
      { role: 'user', content: prompt },
    ];

    const response = await this.chatByTask(TaskType.CODE, { messages });
    return response.content;
  }

  /**
   * Reasoning task (specialized model)
   *
   * @param problem - Problem to solve
   * @returns Reasoning response
   */
  async reason(problem: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: 'You are a logical reasoning expert. Think step by step and explain your reasoning.' },
      { role: 'user', content: problem },
    ];

    const response = await this.chatByTask(TaskType.REASONING, { messages });
    return response.content;
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  /**
   * Check if provider is OllamaProvider
   */
  private isOllamaProvider(): boolean {
    return this.provider.constructor.name === 'OllamaProvider';
  }
}

/**
 * Export types for convenience
 */
export * from './types';
export * from './providers/base';
export * from './providers/factory';
export { SiliconFlowProvider } from './providers/siliconflow';
export { OllamaProvider } from './providers/ollama';
export * from './model-config';
export { ModelStrategy, TaskHelpers } from './ModelStrategy';
export { ModelHealthMonitor, quickHealthCheck } from './model-health';

/**
 * Get the current LLM request queue stats
 */
export function getLLMQueueStats() {
  return globalRequestQueue.getStats();
}
