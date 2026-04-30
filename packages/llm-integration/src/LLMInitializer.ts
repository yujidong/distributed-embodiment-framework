/**
 * LLM Initializer - Validates LLM configuration at startup
 *
 * This module ensures that:
 * 1. Ollama is running and accessible
 * 2. Required models are available
 * 3. No silent fallbacks mask configuration errors
 *
 * IMPORTANT: This follows the "Fail Early" principle.
 * Errors are thrown, not silently handled.
 */

import { OllamaModelUtility, type OllamaModel } from './OllamaModelUtility.js';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('LLMInitializer');

/**
 * Configuration for LLM initialization
 */
export interface LLMInitializerConfig {
  /** Ollama base URL (default: http://localhost:11434) */
  baseURL?: string;
  /** Required model name (will fail if not available) */
  requiredModel?: string;
  /** Preferred models to use (first available will be selected) */
  preferredModels?: string[];
  /** Timeout for health check in ms (default: 5000) */
  timeout?: number;
  /** Whether to allow fallback to any available model (default: false) */
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
  /** All available models in Ollama */
  availableModels: OllamaModel[];
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
 * LLM Initializer - Validates and selects models at startup
 *
 * @example
 * ```typescript
 * // Basic usage - verify specific model
 * const result = await LLMInitializer.initialize({
 *   requiredModel: 'qwen3-14b-q4:latest'
 * });
 *
 * // With preferred models (first available wins)
 * const result = await LLMInitializer.initialize({
 *   preferredModels: ['qwen3-14b-q4:latest', 'qwen2.5:14b', 'llama3.1:8b']
 * });
 *
 * // Check available models
 * const models = await LLMInitializer.getAvailableModels();
 * ```
 */
export class LLMInitializer {
  private static utility: OllamaModelUtility;

  /**
   * Initialize LLM and validate model availability
   *
   * @throws LLMInitializationError if initialization fails
   */
  static async initialize(config: LLMInitializerConfig = {}): Promise<LLMInitializationResult> {
    const {
      baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
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

    // Create utility instance
    this.utility = new OllamaModelUtility({ baseURL, timeout });

    // Step 1: Check if Ollama is running
    logger.info('Step 1: Checking Ollama health...');
    const isHealthy = await this.utility.healthCheck();

    if (!isHealthy) {
      const error = new LLMInitializationError(
        `Ollama is not running or not accessible at ${baseURL}. ` +
        `Please ensure Ollama is running: ollama serve`,
        [],
        requiredModel
      );
      logger.error(`FAILED: ${error.message}`);
      return {
        success: false,
        selectedModel: '',
        availableModels: [],
        error: error.message,
        usedFallback: false,
      };
    }
    logger.info('Ollama is healthy');

    // Step 2: Get available models
    logger.info('Step 2: Fetching available models...');
    let availableModels: OllamaModel[];
    try {
      availableModels = await this.utility.listModels();
    } catch (error) {
      const initError = new LLMInitializationError(
        `Failed to fetch models from Ollama: ${error instanceof Error ? error.message : String(error)}`,
        [],
        requiredModel
      );
      logger.error(`FAILED: ${initError.message}`);
      return {
        success: false,
        selectedModel: '',
        availableModels: [],
        error: initError.message,
        usedFallback: false,
      };
    }

    const modelNames = availableModels.map(m => m.name);
    logger.info(`Found ${availableModels.length} model(s):`);
    for (const model of availableModels) {
      const size = model.size ? this.formatSize(model.size) : 'Unknown size';
      logger.info(`  - ${model.name} (${size})`);
    }

    // Step 3: Validate required model
    if (requiredModel) {
      logger.info(`Step 3: Validating required model "${requiredModel}"...`);

      const modelExists = this.findModel(requiredModel, modelNames);

      if (modelExists) {
        logger.info(`SUCCESS: Required model "${requiredModel}" is available`);
        return {
          success: true,
          selectedModel: requiredModel,
          availableModels,
          usedFallback: false,
        };
      }

      // Model not found
      const errorMessage =
        `Required model "${requiredModel}" is not available in Ollama.\n` +
        `Available models: ${modelNames.join(', ') || 'None'}\n` +
        `To fix:\n` +
        `  1. Pull the model: ollama pull ${requiredModel}\n` +
        `  2. Or use an available model from the list above\n` +
        `  3. Or set allowFallback: true to use an alternative model`;

      if (!allowFallback) {
        const error = new LLMInitializationError(errorMessage, modelNames, requiredModel);
        logger.error(`FAILED: Model not found`);
        logger.error(errorMessage);
        throw error;
      }

      logger.warn(`Required model not found, attempting fallback...`);
    }

    // Step 4: Select from preferred models
    if (preferredModels.length > 0) {
      logger.info('Step 4: Selecting from preferred models...');

      for (const preferred of preferredModels) {
        const found = this.findModel(preferred, modelNames);
        if (found) {
          logger.info(`SUCCESS: Selected preferred model "${found}"`);
          return {
            success: true,
            selectedModel: found,
            availableModels,
            usedFallback: false,
          };
        }
      }

      if (!allowFallback) {
        const errorMessage =
          `None of the preferred models are available.\n` +
          `Preferred: ${preferredModels.join(', ')}\n` +
          `Available: ${modelNames.join(', ') || 'None'}\n` +
          `To fix:\n` +
          `  1. Pull one of the preferred models: ollama pull ${preferredModels[0]}\n` +
          `  2. Or update preferredModels to include an available model\n` +
          `  3. Or set allowFallback: true to use any available model`;

        const error = new LLMInitializationError(errorMessage, modelNames, requiredModel);
        logger.error(`FAILED: No preferred model found`);
        logger.error(errorMessage);
        throw error;
      }

      logger.warn(`No preferred model found, attempting fallback...`);
    }

    // Step 5: Fallback to first available model
    if (availableModels.length > 0) {
      const fallbackModel = availableModels[0].name;
      logger.info(`FALLBACK: Using first available model "${fallbackModel}"`);

      if (!allowFallback) {
        // Even with allowFallback=false, if no specific model was required,
        // we can use the first available model
        logger.info(`SUCCESS: Using "${fallbackModel}" (no specific model required)`);
      }

      return {
        success: true,
        selectedModel: fallbackModel,
        availableModels,
        usedFallback: true,
      };
    }

    // No models available at all
    const errorMessage =
      `No models are available in Ollama.\n` +
      `To fix:\n` +
      `  1. Pull a model: ollama pull llama3.2\n` +
      `  2. Or pull a specific model: ollama pull qwen2.5:7b`;

    const error = new LLMInitializationError(errorMessage, [], requiredModel);
    logger.error(`FAILED: No models available`);
    logger.error(errorMessage);
    throw error;
  }

  /**
   * Get list of available models without full initialization
   */
  static async getAvailableModels(baseURL?: string): Promise<OllamaModel[]> {
    const utility = new OllamaModelUtility({
      baseURL: baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    });

    const isHealthy = await utility.healthCheck();
    if (!isHealthy) {
      throw new LLMInitializationError(
        `Ollama is not running or not accessible`,
        []
      );
    }

    return utility.listModels();
  }

  /**
   * Check if a specific model is available
   */
  static async isModelAvailable(modelName: string, baseURL?: string): Promise<boolean> {
    const models = await this.getAvailableModels(baseURL);
    const modelNames = models.map(m => m.name);
    return this.findModel(modelName, modelNames) !== null;
  }

  /**
   * Find a model by name, handling different tag formats
   */
  private static findModel(searchName: string, availableNames: string[]): string | null {
    // Exact match
    if (availableNames.includes(searchName)) {
      return searchName;
    }

    // Try without :latest tag
    const nameWithoutLatest = searchName.replace(':latest', '');
    const matchWithoutLatest = availableNames.find(n =>
      n === nameWithoutLatest || n === `${nameWithoutLatest}:latest`
    );
    if (matchWithoutLatest) {
      return matchWithoutLatest;
    }

    // Try with :latest tag
    const nameWithLatest = searchName.endsWith(':latest') ? searchName : `${searchName}:latest`;
    if (availableNames.includes(nameWithLatest)) {
      return nameWithLatest;
    }

    // Partial match (e.g., "qwen3-14b" matches "qwen3-14b-q4:latest")
    const partialMatch = availableNames.find(n =>
      n.startsWith(searchName.replace(':latest', ''))
    );
    if (partialMatch) {
      return partialMatch;
    }

    return null;
  }

  /**
   * Format bytes to human readable size
   */
  private static formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Get recommended model from available models
   *
   * Priority order:
   * 1. Large reasoning models (qwen3-14b, deepseek-r1, etc.)
   * 2. Large general models (llama3.1:8b, qwen2.5:14b)
   * 3. Medium models (llama3.2:3b, qwen2.5:7b)
   * 4. Small models (llama3.2:1b, phi3)
   */
  static getRecommendedModel(availableModels: OllamaModel[]): string | null {
    if (availableModels.length === 0) {
      return null;
    }

    const modelNames = availableModels.map(m => m.name);

    // Priority order for model selection
    const priorities = [
      // Large reasoning models (best for complex tasks)
      /qwen3[-.]?14b/i,
      /deepseek[-.]?r1/i,
      /qwen2\.5[-:]?14b/i,

      // Large general models
      /llama3\.1[-:]?8b/i,
      /llama3\.1[-:]?70b/i,
      /mixtral/i,

      // Medium models
      /qwen2\.5[-:]?7b/i,
      /llama3\.2[-:]?3b/i,
      /mistral/i,
      /phi3[-:]?14b/i,

      // Small models
      /llama3\.2[-:]?1b/i,
      /phi3[-:]?3\.?8b/i,
      /gemma2[-:]?2b/i,
    ];

    for (const pattern of priorities) {
      const match = modelNames.find(name => pattern.test(name));
      if (match) {
        return match;
      }
    }

    // Fallback to first available
    return availableModels[0].name;
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
 *     preferredModels: ['qwen3-14b-q4:latest', 'qwen2.5:14b', 'llama3.1:8b']
 *   });
 *   llmClient = new LLMClient('ollama', { model: result.selectedModel });
 * });
 * ```
 */
export async function initializeLLM(
  config: LLMInitializerConfig = {}
): Promise<LLMInitializationResult> {
  return LLMInitializer.initialize(config);
}
