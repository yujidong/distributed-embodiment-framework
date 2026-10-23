import 'cross-fetch/polyfill';
import fetch from 'cross-fetch';
import { BaseProvider, combineAbortSignals } from './base';
import { ChatParams, ChatResponse, LLMError, EmbeddingParams, EmbeddingResponse } from '../types';
import { stripThinkBlocks } from './strip-think';
import { GUIDED_JSON_ENV, isGuidedJsonEnabled } from '../guided-json';

/**
 * Configuration for a generic OpenAI-compatible chat-completions endpoint.
 */
export interface OpenAICompatibleConfig {
  /** Base URL of the server, including the API version path (e.g. http://localhost:8000/v1). */
  baseURL: string;
  /**
   * Bearer token. Optional — local servers (vLLM, llama.cpp) typically need
   * none, and no Authorization header is sent when it is unset. The key
   * comes ONLY from explicit config: no environment fallback (sending an
   * OpenAI bearer to an arbitrary keyless baseURL would be a credential
   * leak).
   */
  apiKey?: string;
  /** Default model identifier to send in requests. */
  model: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
  /**
   * F0-2: guided JSON (structured outputs) switch. When false, ChatParams.format
   * is NOT mapped onto `response_format` — the escape hatch for backends that
   * reject the field. Defaults to the LLM_GUIDED_JSON env toggle (ON unless
   * LLM_GUIDED_JSON=0/false/off); an explicit value here wins over the env.
   */
  guidedJson?: boolean;
}

/**
 * OpenAI-compatible API response format. `choices` and `usage` are optional:
 * minimal backends return 200 without them, and the provider must report
 * that as an LLMError instead of crashing on property access.
 */
interface OpenAICompatibleAPIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Generic OpenAI-compatible LLM provider
 *
 * Talks to any server exposing the OpenAI chat-completions API shape:
 * POST {baseURL}/chat/completions, GET {baseURL}/models.
 * The Authorization: Bearer header is only sent when an apiKey is configured.
 *
 * @example
 * ```typescript
 * // vLLM local server (no auth)
 * const provider = new OpenAICompatibleProvider({
 *   baseURL: 'http://localhost:8000/v1',
 *   model: 'Qwen/Qwen2.5-7B-Instruct',
 * });
 *
 * // llama.cpp server (no auth)
 * const provider = new OpenAICompatibleProvider({
 *   baseURL: 'http://localhost:8080/v1',
 *   model: 'qwen2.5-7b-instruct',
 * });
 *
 * // SiliconFlow (hosted, Bearer auth) — or just use createProvider('siliconflow', ...)
 * const provider = new OpenAICompatibleProvider({
 *   baseURL: 'https://api.siliconflow.cn/v1',
 *   apiKey: process.env.SILICONFLOW_API_KEY,
 *   model: 'Qwen/Qwen3-8B',
 * });
 * ```
 */
export class OpenAICompatibleProvider extends BaseProvider {
  protected apiKey?: string;
  protected baseURL: string;
  /** F0-2: whether ChatParams.format is sent as response_format (guided JSON). */
  protected readonly guidedJson: boolean;

  constructor(config: OpenAICompatibleConfig, providerName = 'openai-compatible') {
    const {
      baseURL,
      apiKey,
      model,
      timeout,
      guidedJson,
    } = config;

    if (!baseURL) {
      throw new LLMError('baseURL is required for an OpenAI-compatible provider.', providerName);
    }
    if (!model) {
      throw new LLMError('model is required for an OpenAI-compatible provider.', providerName);
    }

    super(providerName, model, {
      baseURL,
      ...(apiKey !== undefined && { apiKey }),
      ...(timeout !== undefined && { timeout }),
    });
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.guidedJson = guidedJson ?? isGuidedJsonEnabled();

    this.log('Initialized', { model, baseURL, guidedJson: this.guidedJson });
  }

  /**
   * Build request headers. Authorization is only included when an apiKey is set.
   */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Send chat completion request to the OpenAI-compatible endpoint
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
      const requestBody: Record<string, unknown> = {
        model,
        messages: params.messages,
        // Nullish defaults: temperature 0 (deterministic verdicts) and
        // maxTokens 0 are legal values and must reach the backend unchanged.
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 2000,
      };

      // Map format to OpenAI-style response_format (best-effort):
      // 'json' → json_object; schema object → json_schema. vLLM (≥0.5, incl.
      // 0.23) honors both via its guided-decoding backends. F0-2: when guided
      // JSON is disabled (config guidedJson:false or LLM_GUIDED_JSON=0) the
      // field is omitted entirely — server-side decision-v1 validation is
      // the backstop in that mode.
      if (params.format !== undefined) {
        if (this.guidedJson) {
          requestBody.response_format = params.format === 'json'
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: 'response', schema: params.format } };
        } else {
          this.log('Guided JSON disabled — response_format omitted', {
            reason: `${GUIDED_JSON_ENV}=0 or config guidedJson:false`,
          });
        }
      }

      // Qwen3/vLLM thinking suppression: chat_template_kwargs is a vLLM
      // request extension its chat template reads (Qwen3 honors
      // enable_thinking:false by skipping the <think> draft). vLLM tolerates
      // unknown request fields, so non-Qwen models on vLLM are unaffected;
      // backends with STRICT request validation may 400 on it — callers
      // targeting such backends must leave chatTemplateKwargs unset (the
      // platform's structured-output lanes gate it on LLM_DISABLE_THINKING).
      if (params.chatTemplateKwargs !== undefined) {
        requestBody.chat_template_kwargs = params.chatTemplateKwargs;
      }

      // Add tools if provided (OpenAI function-calling shape)
      if (params.tools && params.tools.length > 0) {
        requestBody.tools = params.tools;
        if (params.tool_choice !== undefined) {
          requestBody.tool_choice = params.tool_choice;
        }
      }

      // T-023: the caller's signal races the provider timeout — the first
      // one to fire aborts the fetch (queue slot released at the caller's
      // bound, not the provider timeout's).
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(requestBody),
        signal: combineAbortSignals(
          AbortSignal.timeout(this.config.timeout || 30000),
          params.signal,
        ),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logError('API request failed', {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        });
        // F0-2: a 400 on a guided-JSON request almost always means the
        // backend rejected response_format — say so explicitly and name the
        // escape hatch instead of surfacing a bare "Bad Request".
        const guidedHint = response.status === 400 && requestBody.response_format !== undefined
          ? ` — the request carried response_format (guided JSON); if this backend does not support it, disable guided JSON via ${GUIDED_JSON_ENV}=0 or provider config guidedJson:false`
          : '';
        throw new LLMError(
          `API request failed: ${response.status} ${response.statusText}${guidedHint}`,
          this.name,
          new Error(errorText)
        );
      }

      const data: OpenAICompatibleAPIResponse = await response.json();

      const duration = Date.now() - startTime;
      this.log('Chat response received', {
        duration: `${duration}ms`,
        tokens: data.usage?.total_tokens,
      });

      // A 200 with a degenerate body must fail loudly with the real
      // problem, not a TypeError that looks like a client bug.
      const rawContent = data.choices?.[0]?.message?.content;
      if (typeof rawContent !== 'string') {
        throw new LLMError(
          data.choices === undefined || data.choices.length === 0
            ? `Backend returned no choices for model "${model}" — the response cannot be used`
            : `Backend returned no message content for model "${model}" — the response cannot be used`,
          this.name,
        );
      }
      // Strip qwen-style <think> blocks before returning: the drafts inside
      // them break JSON parsing downstream.
      const content = stripThinkBlocks(rawContent);

      return {
        content,
        // Usage is optional in the wire format (some backends omit it).
        usage: data.usage
          ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
          : undefined,
        model: data.model,
      };
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }

      // AbortSignal.timeout aborts with a TimeoutError (or AbortError on
      // older runtimes) — nobody "aborted" the request, so name the timeout.
      // T-023: when the CALLER's signal fired (review budget, request
      // lifecycle), say that instead — the two causes have different owners.
      // Caller-budget nuance (fault-injection 'slow LLM' row): undici turns
      // AbortSignal.timeout's rejection into a plain AbortError — the only
      // place the timeout-vs-give-up distinction survives is
      // `signal.reason.name`. A budget timeout is slow-backend evidence
      // (counts toward the circuit breaker); a deliberate controller.abort()
      // (reason 'AbortError') is the caller giving up (exempt, R5-F10).
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        const reasonName = (params.signal?.reason as Error | undefined)?.name;
        if (params.signal?.aborted && reasonName !== 'TimeoutError') {
          this.logError('Chat request aborted by caller', { afterMs: Date.now() - startTime });
          throw new LLMError(
            `Request to ${this.baseURL}/chat/completions aborted by the caller after ${Date.now() - startTime}ms`,
            this.name,
            error,
          );
        }
        const timeoutMs = this.config.timeout || 30000;
        this.logError('Chat request timed out', { timeoutMs });
        // The breaker's chain walk needs a TimeoutError link to count this as
        // slow-backend evidence — fetch's rejection here is a plain AbortError
        // even for AbortSignal.timeout, so synthesize the link from
        // signal.reason when the caller budget fired.
        const budgetCause = new Error(
          reasonName === 'TimeoutError'
            ? `caller budget expired after ${Date.now() - startTime}ms (AbortSignal.timeout)`
            : `timed out after ${timeoutMs}ms`,
        );
        budgetCause.name = 'TimeoutError';
        throw new LLMError(
          `Request to ${this.baseURL}/chat/completions timed out after ${timeoutMs}ms`,
          this.name,
          budgetCause,
        );
      }

      this.logError('Chat request error', error);
      throw new LLMError(
        `Failed to complete chat request: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate embedding for text.
   * Note: chat-completions servers (vLLM/llama.cpp defaults, SiliconFlow chat
   * models) generally do not expose embeddings through this provider, so this
   * returns an error. Serve an embedding-capable endpoint to use embeddings.
   */
  async generateEmbedding(_params: EmbeddingParams): Promise<EmbeddingResponse> {
    const message = `${this.name} does not support embedding generation.`;
    this.log('Embedding generation', message);

    return {
      success: false,
      error: message,
    };
  }

  /**
   * Check if the server is reachable via the OpenAI-standard GET /models endpoint.
   * Never throws — connectivity problems are reported as `false`.
   */
  async healthCheck(): Promise<boolean> {
    try {
      this.log('Health check', 'Checking API connectivity...');

      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
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
