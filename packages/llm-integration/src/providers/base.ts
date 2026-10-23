import { ChatParams, ChatResponse, ProviderConfig, EmbeddingParams, EmbeddingResponse } from '../types';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('BaseProvider');

/**
 * Abstract base interface for LLM providers
 *
 * All LLM providers (OpenAI-compatible, SiliconFlow) must implement this
 * interface. This allows for easy switching between different LLM backends.
 */
export interface LLMProvider {
  /**
   * Provider name (e.g., 'openai-compatible', 'siliconflow')
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

/**
 * T-023 (DevLoop R17): combine caller-owned abort signals (e.g. a review
 * budget) with a provider timeout into ONE signal — whichever fires first
 * aborts the fetch. Uses native `AbortSignal.any` when available (Node
 * 20.3+); falls back to a manual combiner on older runtimes. `undefined`
 * entries are dropped; zero live signals → undefined (caller keeps its own
 * behavior).
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const live = signals.filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, live);

  // Manual combiner: aggregate listeners, clean up after the first abort.
  const controller = new AbortController();
  const listeners = new Array<() => void>();
  const teardown = (): void => {
    for (const off of listeners) off();
    listeners.length = 0;
  };
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      teardown();
      return controller.signal;
    }
    const onAbort = (): void => {
      controller.abort(signal.reason);
      teardown();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return controller.signal;
}
