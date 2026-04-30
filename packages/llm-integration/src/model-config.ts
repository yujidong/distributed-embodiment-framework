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
  // Ollama-based configuration (local models)
  OLLAMA: {
    taskModels: {
      control: 'llama3.2:3b',           // Fast for simple commands
      planning: 'llama3.1:70b',         // Large model for complex planning
      reasoning: 'deepseek-r1:32b',     // Specialized reasoning model
      code: 'codellama:34b',            // Code generation
      embedding: 'nomic-embed-text',    // Embeddings
      chat: 'llama3.1:8b',              // Balanced for conversation
      analysis: 'llama3.1:70b',         // Large model for analysis
      summarization: 'llama3.2:3b',     // Fast for summarization
    },
    fallbackModels: [
      'llama3.1:8b',      // General purpose fallback
      'llama3.2:3b',      // Lightweight fallback
      'phi3:14b',         // Alternative mid-range model
    ],
    availableModels: [],  // Discovered at runtime
    complexityMapping: {
      simple: 'llama3.2:3b',
      moderate: 'llama3.1:8b',
      complex: 'llama3.1:70b',
      critical: 'deepseek-r1:32b',
    },
  } as ModelStrategyConfig,

  // Lightweight configuration (faster, less capable)
  LIGHTWEIGHT: {
    taskModels: {
      control: 'llama3.2:1b',
      planning: 'llama3.2:3b',
      reasoning: 'llama3.2:3b',
      code: 'codellama:13b',
      embedding: 'nomic-embed-text',
      chat: 'llama3.2:3b',
      analysis: 'llama3.2:3b',
      summarization: 'llama3.2:1b',
    },
    fallbackModels: ['llama3.2:1b', 'phi3:3.8b'],
    availableModels: [],
  } as ModelStrategyConfig,

  // High-performance configuration (best quality, slower)
  HIGH_PERFORMANCE: {
    taskModels: {
      control: 'llama3.1:8b',
      planning: 'llama3.1:70b',
      reasoning: 'deepseek-r1:70b',
      code: 'codellama:34b',
      embedding: 'nomic-embed-text',
      chat: 'llama3.1:8b',
      analysis: 'llama3.1:70b',
      summarization: 'llama3.1:8b',
    },
    fallbackModels: ['llama3.1:70b', 'llama3.1:8b'],
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
