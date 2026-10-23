import 'dotenv/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LLMProvider } from './providers/base';
import { createProvider, ProviderType } from './providers/factory';
import { ChatParams, ChatResponse, LLMError, messageContentToText } from './types';
import { LlmCircuitBreaker, isCircuitOpenError } from './circuit-breaker.js';
import { TaskType, TaskComplexity } from './model-config';
import { LLMCache, buildCacheKey } from './cache';
import {
  AdaptiveConcurrencyController,
  parseFastLaneConcurrency,
} from './adaptive-concurrency.js';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('LLMClient');

/**
 * Per-agent attribution for LLM-call logging (llm-failure agent 归因).
 *
 * The logging contextProvider is RUNTIME-level (EngineRuntime sets only the
 * in-flight eventId), and the responder lane's async path carries no agent
 * context — a timed-out/failed call was recorded with agentId 'unknown'.
 * Callers that KNOW the agent (the assessor's LLM lane, the proposal
 * handler's evaluation) wrap the call in runWithLLMAgentContext; the marker
 * rides the async context across awaits, so concurrent agents sharing one
 * client never cross-attribute. Explicit contextProvider values win on
 * conflicts (see currentLogContext).
 */
export interface LLMAgentContext {
  agentId?: string;
  agentName?: string;
}

const agentContextStorage = new AsyncLocalStorage<LLMAgentContext>();

export function runWithLLMAgentContext<T>(context: LLMAgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn);
}

/** 429 = 后端明确限流：fast-lane 自适应控制器的立即降档信号。 */
export function isRateLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message);
}

/**
 * Request queue for controlling concurrency
 *
 * R15-C1: besides depth gauges, the queue measures how long tasks WAITED
 * before executing — the number that separates "concurrency limit too low"
 * from "model slow" in latency attribution (C3).
 *
 * Exported for the adaptive-concurrency wiring tests (module was
 * module-private until R44-F1 第二阶段).
 */
export class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private activeCount = 0;
  private maxConcurrent: number;
  private waitCount = 0;
  private totalWaitMs = 0;
  private maxWaitMs = 0;
  private depthHighWater = 0;
  /** R44-F1 第二阶段：fast-lane 的自适应控制器（普通队列不传，行为不变）。 */
  private readonly adaptive?: AdaptiveConcurrencyController;

  constructor(maxConcurrent: number = 3, adaptive?: AdaptiveConcurrencyController) {
    this.adaptive = adaptive;
    this.maxConcurrent = adaptive ? adaptive.current : maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const enqueuedAt = Date.now();
      // T-023: an aborted request never enters the queue at all.
      if (signal?.aborted) {
        reject(new Error('LLM request aborted before dispatch (caller AbortSignal)'));
        return;
      }
      const task = async () => {
        // T-023: and one that aborted WHILE WAITING never executes — it
        // rejects at admission without running the provider call, so an
        // abandoned request cannot consume a concurrency slot.
        if (signal?.aborted) {
          reject(new Error('LLM request aborted before dispatch (caller AbortSignal)'));
          this.processNext();
          return;
        }
        const waitMs = Date.now() - enqueuedAt;
        this.waitCount++;
        this.totalWaitMs += waitMs;
        if (waitMs > this.maxWaitMs) this.maxWaitMs = waitMs;
        this.activeCount++;
        let outcome: { ok: boolean; rateLimited: boolean } = { ok: true, rateLimited: false };
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          outcome = { ok: false, rateLimited: isRateLimitedError(error) };
          reject(error);
        } finally {
          this.activeCount--;
          if (this.adaptive) {
            this.adaptive.observeQueue(this.queue.length);
            if (this.adaptive.recordCompletion(outcome)) {
              this.setMaxConcurrent(this.adaptive.current);
            }
          }
          this.processNext();
        }
      };

      if (this.activeCount < this.maxConcurrent) {
        task();
      } else {
        this.queue.push(task);
        this.adaptive?.observeQueue(this.queue.length);
        if (this.queue.length > this.depthHighWater) this.depthHighWater = this.queue.length;
      }
    });
  }

  private processNext(): void {
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
      // Cumulative wait accounting (R15-C1) — avg/max over every admitted
      // task plus the deepest the queue ever got.
      waitCount: this.waitCount,
      avgWaitMs: this.waitCount > 0 ? Math.round(this.totalWaitMs / this.waitCount) : 0,
      maxWaitMs: this.maxWaitMs,
      depthHighWater: this.depthHighWater,
      // R44-F1 第二阶段：自适应道的当前档位边界（fixed/普通道不带此字段）。
      ...(this.adaptive
        ? { adaptive: { min: this.adaptive.minLimit, max: this.adaptive.maxLimit } }
        : {}),
    };
  }

  /**
   * Resize the concurrency limit (R15-C1). Takes effect immediately for
   * newly admitted tasks; queued tasks drain under the new limit.
   */
  setMaxConcurrent(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    this.maxConcurrent = n;
    this.processNext();
  }
}

// Global request queue for all LLM clients (shared across agents)
const globalRequestQueue = new RequestQueue(
  parseInt(process.env.LLM_MAX_CONCURRENT || '3', 10)
);

/**
 * R44-F1: fast-lane queue for small models. The R44 city measurement found
 * the single global queue's head-of-line blocking: 1s-class ac-decision-v5
 * calls waited behind 30s-class 14B calls (avgWait 10s, max 41s). Small
 * models get their own lane so tiered decisions actually parallelize.
 *
 * A request takes the fast lane when its CLIENT is marked fastLane (the
 * per-function routing signal: the decision/triage call-site clients are
 * constructed with fastLane:true — the lane follows the CALL SITE, not the
 * model name). Unmarked clients keep the legacy heuristic as a compatibility
 * fallback: the ac-decision name prefix (the platform's fine-tuned decision
 * models, 1.5B class) still routes to the fast lane.
 */
const FAST_LANE_PREFIX = 'ac-decision';
/**
 * R44-F1 第二阶段：fast-lane 并发自适应。显式 LLM_FAST_LANE_CONCURRENT
 * 保持旧的钉死语义（R44 档位实验的工作流）；否则在
 * LLM_FAST_LANE_MIN/MAX（默认 8/32）之间由控制器伸缩——从 min 起步，
 * 排队持续且后端健康时升档，429/失败率升高时减半降档。
 */
const fastLaneConcurrency = parseFastLaneConcurrency();
const fastLaneQueue = new RequestQueue(
  fastLaneConcurrency.fixed ?? fastLaneConcurrency.min,
  fastLaneConcurrency.fixed === undefined
    ? new AdaptiveConcurrencyController({
        min: fastLaneConcurrency.min,
        max: fastLaneConcurrency.max,
      })
    : undefined,
);

/**
 * F4-4 fault-injection knob: override the circuit breaker's open→half-open
 * cooldown (default 5 minutes, circuit-breaker.ts). Read once at module load
 * and applied when a per-backend breaker is FIRST created — the harness sets
 * it before boot so a killed-and-revived backend recovers in seconds instead
 * of waiting out the production cooldown.
 */
const BREAKER_COOLDOWN_MS = (() => {
  const parsed = parseInt(process.env.LLM_BREAKER_COOLDOWN_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
})();

function isFastLaneModel(model: string | undefined): boolean {
  return model !== undefined && model.startsWith(FAST_LANE_PREFIX);
}

/**
 * Single-backend model normalization (P1 config-drift fix).
 *
 * The platform deploys ONE vLLM backend serving ONE model (LLM_MODEL). Agent
 * and scenario `llm.model` declarations are historical hints (Ollama-era
 * names like qwen3-14b-q4:latest persisted in scenario JSON and DB rows) —
 * sending them to the backend yields a 404, not a routing decision. A client
 * constructed with `deployedModel` rewrites any mismatching request model to
 * the deployed one at the unified request entry (chat()), with a warn naming
 * the agent, the requested model and the model actually used.
 *
 * Escape hatch for future multi-model deployments: LLM_MODEL_STRICT=1 (or
 * config modelStrict:true) turns a mismatch into an error instead of a
 * rewrite. Clients that legitimately call a DIFFERENT model (the floorplan
 * vision client) simply don't set deployedModel and are never rewritten.
 */
const MODEL_STRICT_ENV = 'LLM_MODEL_STRICT';

function isModelStrictEnv(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env[MODEL_STRICT_ENV] ?? '').trim());
}

/**
 * LLM_REPLAY (plan-r84 F4-2): VCR-style replay mode. With replay on, chat()
 * serves ONLY from the response cache — a miss throws LLMReplayMissError
 * carrying the request fingerprint (cache key + prompt preview) so the gap
 * can be re-recorded with scripts/eval/llm-record.mjs. PR-lane tests run
 * deterministically against a golden cache with no GPU backend involved.
 */
const REPLAY_ENV = 'LLM_REPLAY';

function isReplayEnv(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env[REPLAY_ENV] ?? '').trim());
}

/**
 * Thrown in replay mode when the cache cannot serve a request. The
 * fingerprint identifies exactly which semantic request needs recording.
 */
export class LLMReplayMissError extends LLMError {
  /** Full sha256 cache key of the missed request (buildCacheKey output). */
  readonly cacheKey?: string;

  constructor(message: string, provider: string, cacheKey?: string) {
    super(message, provider);
    this.name = 'LLMReplayMissError';
    this.cacheKey = cacheKey;
  }
}

export function isReplayMissError(error: unknown): error is LLMReplayMissError {
  return error instanceof LLMReplayMissError;
}

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
    /** True when the response was served from the LLM response cache (no provider call). */
    cached?: boolean;
    context?: {
      agentId?: string;
      agentName?: string;
      interactionType?: string;
      decisionContext?: string;
      decisionResult?: any;
      /** Optional experiment/event correlation id (e.g. the in-flight test event). */
      eventId?: string;
      /** P4-2 triage outcome attached to a triage log entry. */
      triage?: {
        decision: string;
        /** Whether the big model's decision matched (undefined when the big model was skipped). */
        agreed?: boolean;
        latencyMs: number;
      };
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
  private cache: LLMCache | null = null;
  private contextProvider: (() => {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
    eventId?: string;
  }) | null = null;
  /** P1 config-drift fix: the one model the deployment actually serves (see above). */
  private readonly deployedModel?: string;
  private readonly modelStrict: boolean;
  /** F4-2 VCR replay: serve only from the cache; a miss throws LLMReplayMissError. */
  private readonly replay: boolean;
  /**
   * Per-function routing: this client serves a decision-lane call site
   * (AC necessity / triage), so its requests take the fast-lane queue
   * regardless of model name. Undefined = legacy ac-decision prefix
   * heuristic; an explicit false opts an ac-decision-prefixed model OUT.
   */
  private readonly fastLane?: boolean;

  /**
   * Create a new LLM client
   *
   * @param providerType - Type of provider to use ('openai-compatible' or 'siliconflow')
   * @param config - Optional provider-specific configuration. Recognized here
   *   (not forwarded to the provider): `cache`, `deployedModel` (the model the
   *   backend actually serves — mismatching request models are rewritten to it
   *   with a warn), `modelStrict` (mismatch throws instead; default the
   *   LLM_MODEL_STRICT env), `replay` (F4-2 VCR mode: serve only from the
   *   response cache, a miss throws LLMReplayMissError; default the
   *   LLM_REPLAY env).
   *
   * @example
   * ```typescript
   * // Use a local vLLM server via the OpenAI-compatible provider
   * const client = new LLMClient('openai-compatible', {
   *   baseURL: 'http://localhost:8000/v1',
   *   model: 'Qwen/Qwen2.5-7B-Instruct',
   * });
   * ```
   */
  constructor(providerType: ProviderType, config?: any) {
    logger.info(`Initializing with provider: ${providerType}`);

    this.provider = createProvider(providerType, config);
    const deployed = typeof config?.deployedModel === 'string' ? config.deployedModel.trim() : '';
    this.deployedModel = deployed.length > 0 ? deployed : undefined;
    this.modelStrict = typeof config?.modelStrict === 'boolean' ? config.modelStrict : isModelStrictEnv();
    this.replay = typeof config?.replay === 'boolean' ? config.replay : isReplayEnv();
    this.fastLane = typeof config?.fastLane === 'boolean' ? config.fastLane : undefined;

    // Opt-in response cache via config.cache (LLMCache instance or options object)
    if (config?.cache) {
      this.cache = config.cache instanceof LLMCache ? config.cache : new LLMCache(config.cache);
      logger.info('Response cache enabled via constructor config');
    }

    logger.info(`Initialized successfully with ${this.provider.name}`);
  }

  /**
   * Enable response caching on this client (opt-in).
   * Cache hits short-circuit before the request queue — no provider call.
   */
  enableCache(cache: LLMCache): void {
    this.cache = cache;
    logger.info('Response cache enabled');
  }

  /**
   * The attached response cache, or null when caching is disabled.
   */
  getCache(): LLMCache | null {
    return this.cache;
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
    const userPrompt = params.messages.filter(m => m.role === 'user').map(m => messageContentToText(m.content)).join('\n');
    const systemPrompt = params.messages.filter(m => m.role === 'system').map(m => messageContentToText(m.content)).join('\n');

    // P1 config-drift fix: single-backend model normalization at the unified
    // request entry — BEFORE cache-keying, lane routing and the provider
    // call, so every downstream stage sees the model actually sent.
    let effectiveParams = params;
    const requestedModel = params.model ?? this.provider.getConfig().model ?? this.provider.defaultModel;
    let model = requestedModel;
    if (this.deployedModel !== undefined && requestedModel !== this.deployedModel) {
      const context = this.currentLogContext();
      const who = context.agentId !== undefined ? `agent ${context.agentId} ` : '';
      if (this.modelStrict) {
        // Phrased to classify PERMANENT (isTransientLLMError 'model not
        // found') — a mismatch is a config error, retries cannot fix it.
        throw new LLMError(
          `model not found in this deployment: ${who}requested "${requestedModel}" but the ` +
          `configured backend serves "${this.deployedModel}" (LLM_MODEL) and ${MODEL_STRICT_ENV}=1 ` +
          'refuses the mismatch — fix the agent/scenario llm.model or disable strict mode',
          this.provider.name,
        );
      }
      logger.warn(
        `Model drift normalized: ${who}requested model "${requestedModel}" but the deployment ` +
        `serves "${this.deployedModel}" (LLM_MODEL) — rewriting the request to the deployed model`,
      );
      effectiveParams = { ...params, model: this.deployedModel };
      model = this.deployedModel;
    }

    // Cache lookup — on hit, short-circuit BEFORE the request queue (P4-2).
    const cacheKey = this.cache
      ? buildCacheKey({
          provider: this.provider.name,
          model,
          systemPrompt,
          userPrompt,
          format: params.format,
          temperature: params.temperature,
        })
      : null;

    if (this.cache && cacheKey) {
      const cachedEntry = this.cache.get(cacheKey);
      if (cachedEntry) {
        const durationMs = Date.now() - startTime;
        logger.info(`Chat response served from cache (model=${cachedEntry.model})`);

        if (this.loggingCallback) {
          try {
            const context = this.currentLogContext();
            this.loggingCallback({
              systemPrompt,
              userPrompt,
              response: cachedEntry.response,
              promptTokens: cachedEntry.usage?.promptTokens,
              completionTokens: cachedEntry.usage?.completionTokens,
              totalTokens: cachedEntry.usage?.totalTokens,
              durationMs,
              model: cachedEntry.model,
              success: true,
              cached: true,
              context: {
                agentId: context.agentId,
                agentName: context.agentName,
                interactionType: context.interactionType,
                decisionContext: context.decisionContext,
                eventId: context.eventId,
              },
            });
          } catch (logError) {
            logger.error('Logging callback error:', logError);
          }
        }

        return { content: cachedEntry.response, usage: cachedEntry.usage, model: cachedEntry.model };
      }
    }

    // F4-2 replay: the cache is the ONLY source. A miss here never reaches
    // the provider — throw with the fingerprint so the gap can be recorded
    // (scripts/eval/llm-record.mjs). Thrown BEFORE the queue/breaker: a
    // replay miss is a test-fixture gap, not backend evidence.
    if (this.replay) {
      if (!this.cache || cacheKey === null) {
        throw new LLMReplayMissError(
          `${REPLAY_ENV} replay mode requires a response cache (config.cache / enableCache) — ` +
          'no cache attached, so no recorded response can be served',
          this.provider.name,
        );
      }
      const preview = userPrompt.trim().replace(/\s+/g, ' ').slice(0, 120);
      throw new LLMReplayMissError(
        `${REPLAY_ENV} cache miss: no recorded response for this request ` +
        `(provider=${this.provider.name} model=${model} key=${cacheKey.slice(0, 16)}… ` +
        `prompt="${preview}${userPrompt.length > 120 ? '…' : ''}"). ` +
        'Record the gap with scripts/eval/llm-record.mjs against a live backend.',
        this.provider.name,
        cacheKey,
      );
    }

    try {
      // Use request queue to control concurrency. T-023: the caller's abort
      // signal rides along — an aborted request rejects at dispatch (or at
      // admission after waiting) without running the provider call, and an
      // in-flight fetch is cancelled through the provider's combined signal.
      // R40-A5: the backend circuit breaker wraps the queued call — after
      // two consecutive backend failures every caller on this backend
      // fails fast (LlmCircuitOpenError) and takes its rule fallback,
      // instead of each event paying the provider-timeout wait.
      const breakerKey = `${this.provider.name}:${this.provider.getConfig().baseURL ?? 'default'}`;
      // Per-function routing: a client marked fastLane (decision/triage call
      // sites) takes the fast lane by CALL SITE, not model name; unmarked
      // clients keep the ac-decision prefix heuristic as compat fallback.
      const queue = (this.fastLane ?? isFastLaneModel(model)) ? fastLaneQueue : globalRequestQueue;
      const response = await LlmCircuitBreaker.for(
        breakerKey,
        BREAKER_COOLDOWN_MS !== undefined ? { cooldownMs: BREAKER_COOLDOWN_MS } : undefined,
      ).guard(() =>
        queue.run(() => this.provider.chat(effectiveParams), effectiveParams.signal),
      );
      const durationMs = Date.now() - startTime;

      // Store successful plain-text responses in the cache. Responses with
      // tool calls are not cached (the cached entry cannot replay them).
      if (this.cache && cacheKey && !response.toolCalls?.length) {
        this.cache.set(cacheKey, {
          response: response.content,
          usage: response.usage,
          model: response.model,
          storedAt: Date.now(),
        });
      }

      logger.info(`Chat response received:`, {
        contentLength: response.content.length,
        tokens: response.usage?.totalTokens,
        model: response.model,
        durationMs,
      });

      // Call logging callback if set
      if (this.loggingCallback) {
        try {
          const context = this.currentLogContext();
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
              eventId: context.eventId,
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
          const context = this.currentLogContext();
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
              eventId: context.eventId,
            },
          });
        } catch (logError) {
          logger.error('Logging callback error:', logError);
        }
      }

      if (error instanceof LLMError) {
        throw error;
      }

      // R40-A5: the breaker's fast-fail must pass through UNWRAPPED —
      // wrapping it in LLMError would hide its name from
      // isTransientLLMError's circuit-open check and make callers burn
      // retry backoff on an instant rejection.
      if (isCircuitOpenError(error)) {
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
   * @param format - Optional structured output format ('json' or a JSON schema)
   * @param options - Optional request overrides (R32-A3):
   *   - maxTokens: provider generation cap. Short-output decision calls
   *     should set this — the provider default (2000) reserves KV-cache
   *     headroom for generations that can never be that long.
   *   - temperature: sampling temperature. Decision-path callers must pin 0
   *     (R35 recommendation #2 — no sampling on decision endpoints; +18pp
   *     measured). Explicit 0 is its own cache bucket (never collides with
   *     omitted-temperature requests).
   *   - chatTemplateKwargs: vLLM chat-template kwargs (Qwen3
   *     enable_thinking suppression on the structured-output lanes).
   * @returns Chat response with content and tool calls
   *
   * @example
   * ```typescript
   * const response = await client.quickChat('What is 2+2?');
   * console.log(response.content); // "2+2 equals 4."
   * ```
   */
  async quickChat(
    content: string,
    systemPrompt?: string,
    tools?: any[],
    format?: ChatParams['format'],
    options?: { maxTokens?: number; temperature?: number; chatTemplateKwargs?: Record<string, unknown> },
  ): Promise<ChatResponse> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content });

    const response = await this.chat({
      messages,
      tools,
      format,
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.chatTemplateKwargs !== undefined
        ? { chatTemplateKwargs: options.chatTemplateKwargs }
        : {}),
    });
    return response;
  }

  /**
   * Set logging callback for LLM interactions
   */
  setLoggingCallback(callback: LLMLoggingCallback | null): void {
    this.loggingCallback = callback;
  }

  /**
   * The logging context for one call: the ambient per-agent marker
   * (runWithLLMAgentContext) merged UNDER the explicit contextProvider —
   * provider values (e.g. the runtime's in-flight eventId) win on conflict.
   */
  private currentLogContext(): {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
    eventId?: string;
  } {
    return { ...agentContextStorage.getStore(), ...(this.contextProvider?.() || {}) };
  }

  /**
   * Set context provider for logging
   */
  setContextProvider(provider: () => {
    agentId?: string;
    agentName?: string;
    interactionType?: string;
    decisionContext?: string;
    eventId?: string;
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
   * Get the configured model name (provider config override or default).
   */
  getModel(): string {
    return this.provider.getConfig().model ?? this.provider.defaultModel;
  }

  /**
   * Emit a log entry through the configured logging callback (P4-2).
   *
   * Used by engine components (e.g. the AC triage path) to record an LLM
   * interaction that happened on a DIFFERENT client — e.g. the cheap triage
   * model — so trajectory/token accounting sees every model call exactly
   * once, with additive context (context.triage).
   */
  emitLog(entry: Parameters<LLMLoggingCallback>[0]): void {
    if (!this.loggingCallback) return;
    try {
      this.loggingCallback(entry);
    } catch (logError) {
      logger.error('Logging callback error:', logError);
    }
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
    _complexity?: TaskComplexity
  ): Promise<ChatResponse & { selectedModel: string }> {
    logger.info(`Task-based chat: ${taskType}`);

    // Fallback to regular chat (single-model backends have no per-task routing)
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
}

/**
 * Export types for convenience
 */
export * from './types';
export * from './providers/base';
export * from './providers/factory';
export { SiliconFlowProvider } from './providers/siliconflow';
export * from './model-config';
export { ModelStrategy, TaskHelpers } from './ModelStrategy';
export { ModelHealthMonitor, quickHealthCheck } from './model-health';

/**
 * Get the current LLM request queue stats (R15-C1: includes wait
 * accounting for latency attribution).
 */
export function getLLMQueueStats() {
  return globalRequestQueue.getStats();
}

/**
 * R81-D2 (R44-dense-F4): the fast-lane queue's stats, same shape as
 * getLLMQueueStats. The dense tier runs its whole decision load through
 * this lane (32 concurrent) while the global queue sat at zero — health
 * reported an idle platform at peak contention. Pure read, no behavior
 * change.
 */
export function getFastLaneQueueStats() {
  return fastLaneQueue.getStats();
}

/**
 * Resize the global LLM request queue (R15-C1). The server applies its
 * validated LLM_MAX_CONCURRENT at boot; the env read at module load stays
 * as the pre-config default.
 */
export function setLLMMaxConcurrent(n: number): void {
  globalRequestQueue.setMaxConcurrent(n);
}
