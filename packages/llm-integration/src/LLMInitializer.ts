/**
 * LLM Initializer - Validates LLM configuration at startup
 *
 * This module ensures that:
 * 1. The OpenAI-compatible backend (vLLM) is reachable
 * 2. Required models are served by the backend
 * 3. No silent fallbacks mask configuration errors
 *
 * IMPORTANT: This follows the "Fail Early" principle.
 * Errors are thrown, not silently handled.
 */

import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('LLMInitializer');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';

/**
 * Configuration for LLM initialization
 */
export interface LLMInitializerConfig {
  /** OpenAI-compatible base URL (default: LLM_BASE_URL env or http://127.0.0.1:8000/v1) */
  baseURL?: string;
  /** Required model name (will fail if not served) */
  requiredModel?: string;
  /** Preferred models to use (first served one will be selected) */
  preferredModels?: string[];
  /** Timeout for the reachability probe in ms (default: 5000) */
  timeout?: number;
  /** Whether to allow fallback to any served model (default: false) */
  allowFallback?: boolean;
}

/**
 * Result of LLM initialization
 */
export interface LLMInitializationResult {
  /** Whether initialization was successful */
  success: boolean;
  /** Selected model to use */
  selectedModel: string;
  /** All model ids served by the backend */
  availableModels: string[];
  /** Error message if initialization failed */
  error?: string;
  /** Whether fallback was used */
  usedFallback: boolean;
}

/**
 * Error thrown when LLM initialization fails
 */
export class LLMInitializationError extends Error {
  constructor(
    message: string,
    public readonly availableModels: string[],
    public readonly requiredModel?: string
  ) {
    super(message);
    this.name = 'LLMInitializationError';
  }
}

/**
 * LLM Initializer - Validates and selects models at startup against the
 * OpenAI-compatible backend (GET {baseURL}/models).
 *
 * @example
 * ```typescript
 * // Verify a specific served model
 * const result = await LLMInitializer.initialize({
 *   requiredModel: 'Qwen/Qwen2.5-7B-Instruct'
 * });
 *
 * // With preferred models (first served one wins)
 * const result = await LLMInitializer.initialize({
 *   preferredModels: ['Qwen/Qwen2.5-14B-Instruct', 'Qwen/Qwen2.5-7B-Instruct']
 * });
 *
 * // List served models
 * const models = await LLMInitializer.getAvailableModels();
 * ```
 */
export class LLMInitializer {
  /**
   * Initialize LLM and validate model availability
   *
   * @throws LLMInitializationError if initialization fails
   */
  static async initialize(config: LLMInitializerConfig = {}): Promise<LLMInitializationResult> {
    const {
      baseURL = process.env.LLM_BASE_URL || DEFAULT_BASE_URL,
      requiredModel,
      preferredModels = [],
      timeout = 5000,
      allowFallback = false,
    } = config;

    logger.info('Starting LLM initialization...');
    logger.info(`Base URL: ${baseURL}`);
    logger.info(`Required Model: ${requiredModel || 'Not specified'}`);
    logger.info(`Preferred Models: ${preferredModels.join(', ') || 'None'}`);
    logger.info(`Allow Fallback: ${allowFallback}`);

    // Step 1-2: probe the backend and list served models
    let modelNames: string[];
    try {
      modelNames = await this.getAvailableModels(baseURL, timeout);
    } catch (error) {
      const initError = new LLMInitializationError(
        `LLM backend not reachable at ${baseURL}: ${error instanceof Error ? error.message : String(error)} — ` +
        `ensure the OpenAI-compatible server (e.g. vLLM) is running`,
        [],
        requiredModel,
      );
      logger.error(`FAILED: ${initError.message}`);
      if (requiredModel !== undefined || preferredModels.length > 0) {
        throw initError;
      }
      return {
        success: false,
        selectedModel: '',
        availableModels: [],
        error: initError.message,
        usedFallback: false,
      };
    }

    logger.info(`Found ${modelNames.length} model(s): ${modelNames.join(', ')}`);

    // Step 3: Validate required model
    if (requiredModel) {
      if (modelNames.includes(requiredModel)) {
        logger.info(`SUCCESS: Required model "${requiredModel}" is served`);
        return {
          success: true,
          selectedModel: requiredModel,
          availableModels: modelNames,
          usedFallback: false,
        };
      }

      const errorMessage =
        `Required model "${requiredModel}" is not served by ${baseURL}.\n` +
        `Served models: ${modelNames.join(', ') || 'None'}\n` +
        `To fix:\n` +
        `  1. Serve the model under exactly this name (vLLM --served-model-name)\n` +
        `  2. Or use a served model from the list above\n` +
        `  3. Or set allowFallback: true to use an alternative model`;

      if (!allowFallback) {
        const error = new LLMInitializationError(errorMessage, modelNames, requiredModel);
        logger.error(`FAILED: Model not found`);
        logger.error(errorMessage);
        throw error;
      }

      logger.warn(`Required model not served, attempting fallback...`);
    }

    // Step 4: Select from preferred models
    if (preferredModels.length > 0) {
      for (const preferred of preferredModels) {
        if (modelNames.includes(preferred)) {
          logger.info(`SUCCESS: Selected preferred model "${preferred}"`);
          return {
            success: true,
            selectedModel: preferred,
            availableModels: modelNames,
            usedFallback: false,
          };
        }
      }

      if (!allowFallback) {
        const errorMessage =
          `None of the preferred models are served.\n` +
          `Preferred: ${preferredModels.join(', ')}\n` +
          `Served: ${modelNames.join(', ') || 'None'}\n` +
          `To fix:\n` +
          `  1. Serve one of the preferred models under exactly its name\n` +
          `  2. Or update preferredModels to include a served model\n` +
          `  3. Or set allowFallback: true to use any served model`;

        const error = new LLMInitializationError(errorMessage, modelNames, requiredModel);
        logger.error(`FAILED: No preferred model found`);
        logger.error(errorMessage);
        throw error;
      }

      logger.warn(`No preferred model served, attempting fallback...`);
    }

    // Step 5: Fallback to first served model
    if (modelNames.length > 0) {
      const fallbackModel = modelNames[0];
      logger.info(`FALLBACK: Using first served model "${fallbackModel}"`);
      return {
        success: true,
        selectedModel: fallbackModel,
        availableModels: modelNames,
        usedFallback: true,
      };
    }

    // No models served at all
    const errorMessage =
      `No models are served by ${baseURL}.\n` +
      `To fix: start the backend with at least one model ` +
      `(vLLM: --served-model-name <name>)`;

    const error = new LLMInitializationError(errorMessage, [], requiredModel);
    logger.error(`FAILED: No models available`);
    logger.error(errorMessage);
    throw error;
  }

  /**
   * Get the model ids served by the OpenAI-compatible backend without full
   * initialization (GET {baseURL}/models).
   */
  static async getAvailableModels(
    baseURL?: string,
    timeoutMs?: number,
  ): Promise<string[]> {
    const base = baseURL || process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      ...(process.env.LLM_API_KEY
        ? { headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}` } }
        : {}),
      signal: AbortSignal.timeout(timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      throw new Error(`GET ${base}/models answered HTTP ${response.status}`);
    }
    const data = await response.json() as { data?: Array<{ id?: unknown }> };
    return (data.data ?? [])
      .map(entry => (typeof entry.id === 'string' ? entry.id : ''))
      .filter(id => id.length > 0);
  }

  /**
   * Check if a specific model is served
   */
  static async isModelAvailable(modelName: string, baseURL?: string): Promise<boolean> {
    const models = await this.getAvailableModels(baseURL);
    return models.includes(modelName);
  }
}

/**
 * Quick helper to initialize LLM with recommended settings
 *
 * @example
 * ```typescript
 * // In test files
 * beforeAll(async () => {
 *   const result = await initializeLLM({
 *     preferredModels: ['Qwen/Qwen2.5-14B-Instruct', 'Qwen/Qwen2.5-7B-Instruct']
 *   });
 *   llmClient = new LLMClient('openai-compatible', {
 *     baseURL: process.env.LLM_BASE_URL,
 *     model: result.selectedModel,
 *   });
 * });
 * ```
 */
export async function initializeLLM(
  config: LLMInitializerConfig = {}
): Promise<LLMInitializationResult> {
  return LLMInitializer.initialize(config);
}
