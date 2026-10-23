/**
 * Model Strategy Configuration
 *
 * Defines task types and model mappings for intelligent model selection
 */

/**
 * Task types that require different LLM models
 */
export enum TaskType {
  CONTROL = 'control',           // Fast device control commands (small, fast model)
  PLANNING = 'planning',         // Complex task decomposition (large, capable model)
  REASONING = 'reasoning',       // Logical reasoning and analysis (specialized reasoning model)
  CODE = 'code',                 // Code generation and review (code-specialized model)
  EMBEDDING = 'embedding',       // Text embeddings (embedding model)
  CHAT = 'chat',                 // General conversation (balanced model)
  ANALYSIS = 'analysis',         // Data analysis (medium model)
  SUMMARIZATION = 'summarization', // Text summarization (fast model)
}

/**
 * Task complexity level (0-1)
 * Used for selecting appropriate model based on task difficulty
 */
export enum TaskComplexity {
  SIMPLE = 0.2,      // Basic queries, simple commands
  MODERATE = 0.5,    // Standard tasks
  COMPLEX = 0.8,     // Multi-step reasoning
  CRITICAL = 1.0,    // Mission-critical decisions
}

/**
 * Model configuration for a specific task type
 */
export interface TaskModelConfig {
  taskType: TaskType;
  model: string;
  fallbackModels: string[];
  minComplexity?: number;  // Minimum complexity to use this model
  maxComplexity?: number;  // Maximum complexity for this model
  priority?: number;       // Priority for model selection (higher = preferred)
}

/**
 * Complete model strategy configuration
 */
export interface ModelStrategyConfig {
  // Default models for each task type
  taskModels: {
    control: string;
    planning: string;
    reasoning: string;
    code: string;
    embedding: string;
    chat: string;
    analysis: string;
    summarization: string;
  };

  // Fallback models (used if primary model fails)
  fallbackModels: string[];

  // Model availability (tracked at runtime)
  availableModels: string[];

  // Preferred models by complexity level
  complexityMapping?: {
    simple?: string;
    moderate?: string;
    complex?: string;
    critical?: string;
  };
}

/**
 * Recommended model configurations for common use cases
 */
export const DefaultModelConfigs = {
  // Local-model configuration (served over an OpenAI-compatible endpoint)
  LOCAL: {
    taskModels: {
      control: 'Qwen/Qwen2.5-1.5B-Instruct',   // Fast for simple commands
      planning: 'Qwen/Qwen2.5-14B-Instruct',   // Large model for complex planning
      reasoning: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', // Specialized reasoning model
      code: 'Qwen/Qwen2.5-Coder-14B-Instruct', // Code generation
      embedding: 'text-embedding-v3',          // Embeddings
      chat: 'Qwen/Qwen2.5-7B-Instruct',        // Balanced for conversation
      analysis: 'Qwen/Qwen2.5-14B-Instruct',   // Large model for analysis
      summarization: 'Qwen/Qwen2.5-1.5B-Instruct', // Fast for summarization
    },
    fallbackModels: [
      'Qwen/Qwen2.5-7B-Instruct',  // General purpose fallback
      'Qwen/Qwen2.5-1.5B-Instruct', // Lightweight fallback
      'Qwen/Qwen2.5-14B-Instruct', // Alternative mid-range model
    ],
    availableModels: [],  // Discovered at runtime
    complexityMapping: {
      simple: 'Qwen/Qwen2.5-1.5B-Instruct',
      moderate: 'Qwen/Qwen2.5-7B-Instruct',
      complex: 'Qwen/Qwen2.5-14B-Instruct',
      critical: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
    },
  } as ModelStrategyConfig,

  // Lightweight configuration (faster, less capable)
  LIGHTWEIGHT: {
    taskModels: {
      control: 'Qwen/Qwen2.5-0.5B-Instruct',
      planning: 'Qwen/Qwen2.5-1.5B-Instruct',
      reasoning: 'Qwen/Qwen2.5-1.5B-Instruct',
      code: 'Qwen/Qwen2.5-Coder-7B-Instruct',
      embedding: 'text-embedding-v3',
      chat: 'Qwen/Qwen2.5-1.5B-Instruct',
      analysis: 'Qwen/Qwen2.5-1.5B-Instruct',
      summarization: 'Qwen/Qwen2.5-0.5B-Instruct',
    },
    fallbackModels: ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-1.5B-Instruct'],
    availableModels: [],
  } as ModelStrategyConfig,

  // High-performance configuration (best quality, slower)
  HIGH_PERFORMANCE: {
    taskModels: {
      control: 'Qwen/Qwen2.5-7B-Instruct',
      planning: 'Qwen/Qwen2.5-72B-Instruct',
      reasoning: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
      code: 'Qwen/Qwen2.5-Coder-32B-Instruct',
      embedding: 'text-embedding-v3',
      chat: 'Qwen/Qwen2.5-7B-Instruct',
      analysis: 'Qwen/Qwen2.5-72B-Instruct',
      summarization: 'Qwen/Qwen2.5-7B-Instruct',
    },
    fallbackModels: ['Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2.5-7B-Instruct'],
    availableModels: [],
  } as ModelStrategyConfig,
};

/**
 * Task metadata for intelligent model selection
 */
export interface TaskMetadata {
  type: TaskType;
  complexity?: TaskComplexity;
  estimatedTokens?: number;
  timeoutMs?: number;
  requiresStreaming?: boolean;
  requiresReasoning?: boolean;
  requiresCodeGeneration?: boolean;
}

/**
 * Model selection result
 */
export interface ModelSelection {
  model: string;
  reason: string;
  fallback: boolean;
  complexity: TaskComplexity;
}
