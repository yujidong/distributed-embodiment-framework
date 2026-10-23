/**
 * @active-collaboration/llm-integration
 *
 * LLM provider abstraction. The OpenAI-compatible provider (vLLM et al.) is
 * the platform's backend; SiliconFlow remains as a hosted alternative.
 */

// Main exports
export { LLMClient, getLLMQueueStats, getFastLaneQueueStats, setLLMMaxConcurrent, runWithLLMAgentContext } from './client';
export type { LLMAgentContext } from './client';

// Response cache (P4-2)
export { LLMCache, buildCacheKey } from './cache';
export type {
  LLMCacheKeyInput,
  LLMCacheEntry,
  LLMCacheStats,
  LLMCacheOptions,
} from './cache';

// Types
export type * from './types';
// Values (T-022): provider error classification for bounded-retry policies.
export { LLMError, isTransientLLMError } from './types';
export { LlmCircuitBreaker, LlmCircuitOpenError, isCircuitOpenError } from './circuit-breaker';
// F0-2: guided JSON (structured outputs) toggle — LLM_GUIDED_JSON env + resolver.
export { GUIDED_JSON_ENV, isGuidedJsonEnabled } from './guided-json';
// Qwen3 thinking suppression on the structured-output lanes — LLM_DISABLE_THINKING env.
export { DISABLE_THINKING_ENV, isThinkingDisabled, noThinkingTemplateKwargs } from './thinking';
// Per-function model routing (LLM_DECISION_MODEL / LLM_EVAL_MODEL / LLM_NL_MODEL).
export { parseModelRoute, formatModelRoute } from './model-route';
export type { ModelRoute, LlmModelRoutes } from './model-route';

// R44-F1 第二阶段：fast-lane 并发自适应（LLM_FAST_LANE_MIN/MAX）。
export {
  AdaptiveConcurrencyController,
  parseFastLaneConcurrency,
  FAST_LANE_DEFAULT_MIN,
  FAST_LANE_DEFAULT_MAX,
} from './adaptive-concurrency';
export type {
  AdaptiveConcurrencyOptions,
  CompletionOutcome,
  FastLaneConcurrencyConfig,
} from './adaptive-concurrency';

// Providers
export { BaseProvider } from './providers/base';
export type { LLMProvider } from './providers/base';
export { SiliconFlowProvider } from './providers/siliconflow';
export { OpenAICompatibleProvider } from './providers/openai-compatible';
export type { OpenAICompatibleConfig } from './providers/openai-compatible';
export { createProvider, getAvailableProviders } from './providers/factory';
export type { ProviderType } from './providers/factory';

// Model Strategy
export { ModelStrategy, TaskHelpers } from './ModelStrategy';
export type {
  TaskType,
  TaskComplexity,
  ModelStrategyConfig,
  TaskMetadata,
  ModelSelection,
} from './model-config';
export { DefaultModelConfigs } from './model-config';

// Model Health Monitoring
export {
  ModelHealthMonitor,
  quickHealthCheck,
  checkModelsAvailable,
} from './model-health';
export type {
  ModelHealthStatus,
  ModelInfo,
} from './model-health';

// LLM Initialization (OpenAI-compatible backend probe + model validation)
export {
  LLMInitializer,
  initializeLLM,
  LLMInitializationError,
} from './LLMInitializer.js';
export type {
  LLMInitializerConfig,
  LLMInitializationResult,
} from './LLMInitializer.js';
