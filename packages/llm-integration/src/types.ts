/**
 * One part of a multimodal message (OpenAI chat-completions content-parts
 * shape). `image_url.url` is an http(s) URL or a `data:<mime>;base64,...`
 * URI.
 */
export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Message format for LLM chat completion.
 *
 * `content` is a plain string for text-only messages, or an array of
 * content parts for multimodal (vision) messages. Providers without vision
 * support simply forward the parts (OpenAI-compatible) or degrade to the
 * text parts only.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
}

/** Extract the text of a message for logging/cache keys; images become placeholders. */
export function messageContentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(part =>
      part.type === 'text'
        ? part.text
        : // Length + tail keep distinct images distinct in cache keys without
          // logging megabytes of base64.
          `[image ${part.image_url.url.length}B …${part.image_url.url.slice(-32)}]`,
    )
    .join('\n');
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
  /**
   * Structured/constrained output format.
   * - `'json'`: the model must respond with valid JSON.
   * - `Record<string, unknown>`: a JSON schema for constrained decoding.
   *
   * Mapped per provider: OpenAI-compatible providers receive it as
   * `response_format`.
   */
  format?: 'json' | Record<string, unknown>;
  /**
   * vLLM chat-template kwargs (Qwen3 thinking suppression). Sent verbatim as
   * the `chat_template_kwargs` request field — a vLLM extension its chat
   * template reads (Qwen3 honors `enable_thinking`). vLLM tolerates unknown
   * request fields, so non-Qwen models on vLLM are unaffected; backends with
   * strict request validation may reject the field — leave it unset there
   * (the platform's structured-output lanes gate it on LLM_DISABLE_THINKING).
   */
  chatTemplateKwargs?: Record<string, unknown>;
  /**
   * T-023 (DevLoop R17): caller-owned cancellation. Providers combine this
   * with their own request timeout — whichever fires first aborts the
   * in-flight fetch, releasing the global concurrency slot instead of
   * holding it until the provider timeout (the reviewer's Promise.race
   * timeout used to orphan the underlying request for up to 120s).
   * A call with an already-aborted signal rejects before entering the
   * request queue.
   */
  signal?: AbortSignal;
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
 * Permanent-error signatures — client-side mistakes a retry cannot fix.
 * A permanent signature WINS over any transient-looking text in the chain:
 * "last error: 404 after 3 timeouts" must not retry.
 */
const PERMANENT_LLM_ERROR_PATTERNS: readonly RegExp[] = [
  /\b(?:400|401|403|404|405|413|422)\b/,
  /invalid\s+api\s+key/i, /unauthorized/i, /forbidden/i,
  /model\s+["\w.-]*\s*not\s+found/i, // 'model "qwen3" not found' / 'model not found'
  /no\s+such\s+model/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

/**
 * T-022 (DevLoop R17): classify a provider error as TRANSIENT (a bounded
 * retry with backoff might succeed — dead port, DNS hiccup, gateway 502,
 * provider timeout) or PERMANENT (retry is wasted work — auth failure,
 * unknown model, 4xx bad request). Inspects the message plus up to 3 levels
 * of `cause` wrapping.
 *
 * Classification rule: a PERMANENT signature wins; everything else —
 * explicit transient signatures AND unclassifiable errors — counts as
 * transient. A bounded retry is cheap; misclassifying a dead-port
 * ECONNREFUSED as permanent was the R10 failure mode (every LLM-needing
 * event silently produced no decision).
 */
export function isTransientLLMError(error: unknown): boolean {
  // R40-A5: a circuit-open fast-fail is deliberately NON-transient — the
  // backend is already proven down and the breaker owns recovery timing;
  // a transient classification would make callers burn their retry budget
  // (with backoff) on an instant rejection. Name check (not instanceof)
  // keeps this module import-free by design; circuit-breaker.ts owns the
  // class.
  if (error instanceof Error && error.name === 'LlmCircuitOpenError') return false;
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    messages.push(`${current.name}: ${current.message}`);
    current = (current as { cause?: unknown }).cause;
  }
  const text = messages.join(' | ');
  return text.length === 0 || !matchesAny(text, PERMANENT_LLM_ERROR_PATTERNS);
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
