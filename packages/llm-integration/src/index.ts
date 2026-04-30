/**
 * @active-collaboration/llm-integration
 *
 * LLM provider abstraction supporting multiple backends
 */

// Main exports
export { LLMClient } from './client';

// Types
export type * from './types';

// Providers
export { BaseProvider } from './providers/base';
export type { LLMProvider } from './providers/base';
export { SiliconFlowProvider } from './providers/siliconflow';
export { OllamaProvider } from './providers/ollama';
export { createProvider, getAvailableProviders } from './providers/factory';
export type { ProviderType } from './providers/factory';

// Model Utilities
export { OllamaModelUtility } from './OllamaModelUtility';
export type {
  OllamaModelUtilityConfig,
  OllamaModel,
  OllamaModelInfo,
  OllamaRunningModel,
  PullProgress,
  PullOptions,
} from './OllamaModelUtility';

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

// LLM Initialization
export {
  LLMInitializer,
  initializeLLM,
  LLMInitializationError,
} from './LLMInitializer.js';
export type {
  LLMInitializerConfig,
  LLMInitializationResult,
} from './LLMInitializer.js';
