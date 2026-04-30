/**
 * Message format for LLM chat completion
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Tool definition for function calling
 */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: 'string' | 'number' | 'boolean' | 'array' | 'object';
        description: string;
        items?: { type: string };
      }>;
      required: string[];
    };
  };
}

/**
 * Tool call from LLM response
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * Parameters for chat completion requests
 */
export interface ChatParams {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  tools?: Tool[];
  tool_choice?: 'auto' | { type: 'function'; name: string };
}

/**
 * Token usage information
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Response from LLM chat completion
 */
export interface ChatResponse {
  content: string;
  usage?: TokenUsage;
  model: string;
  toolCalls?: ToolCall[];
}

/**
 * Error types for LLM operations
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: Error
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'LLMError';
  }
}

/**
 * Configuration for LLM providers
 */
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeout?: number;
}

/**
 * Parameters for embedding generation
 */
export interface EmbeddingParams {
  input: string;
  model?: string;
}

/**
 * Response from embedding generation
 */
export interface EmbeddingResponse {
  success: boolean;
  embedding?: number[];
  error?: string;
  model?: string;
}
