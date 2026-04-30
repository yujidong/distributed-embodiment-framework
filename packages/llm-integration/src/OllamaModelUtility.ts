/**
 * Ollama Model Utility
 *
 * Comprehensive utility for managing local Ollama models.
 * Provides functions to list, pull, delete, and get model information.
 *
 * @example
 * ```typescript
 * import { OllamaModelUtility } from './OllamaModelUtility';
 *
 * const utility = new OllamaModelUtility();
 *
 * // Check if Ollama is running
 * const isHealthy = await utility.healthCheck();
 *
 * // List all available models
 * const models = await utility.listModels();
 *
 * // Get detailed model information
 * const info = await utility.getModelInfo('llama3.2');
 *
 * // Pull a new model
 * await utility.pullModel('qwen2.5');
 *
 * // Show running models
 * const running = await utility.showRunningModels();
 * ```
 */

import 'cross-fetch/polyfill';
import fetch from 'cross-fetch';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('OllamaModelUtility');

/**
 * Ollama configuration options
 */
export interface OllamaModelUtilityConfig {
  baseURL?: string;
  timeout?: number;
}

/**
 * Model information from Ollama
 */
export interface OllamaModel {
  name: string;
  modified_at?: number;
  size?: number;
  digest?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

/**
 * Model detailed information
 */
export interface OllamaModelInfo {
  license?: string;
  modelfile?: string;
  parameters?: Record<string, string>;
  template?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  metadata?: {
    modelfile?: string;
  };
}

/**
 * Running model information
 */
export interface OllamaRunningModel {
  name: string;
  model?: string;
  size?: number;
  vram_total?: number;
  vram_used?: number;
  expires_at?: number;
}

/**
 * Pull progress callback
 */
export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/**
 * Pull options
 */
export interface PullOptions {
  insecure?: boolean;
  stream?: boolean;
  onProgress?: (progress: PullProgress) => void;
}

/**
 * Comprehensive utility for Ollama model management
 */
export class OllamaModelUtility {
  private baseURL: string;
  private timeout: number;

  constructor(config: OllamaModelUtilityConfig = {}) {
    this.baseURL = config.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.timeout = config.timeout || 300000; // 5 minutes for pull operations

    logger.info(`Initialized with baseURL: ${this.baseURL}`);
  }

  /**
   * Check if Ollama is running and accessible
   *
   * @returns true if Ollama is healthy
   */
  async healthCheck(): Promise<boolean> {
    logger.info('Checking Ollama health...');

    try {
      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        logger.info('Health check: OK');
        return true;
      } else {
        logger.info(`Health check: FAILED (${response.status})`);
        return false;
      }
    } catch (error) {
      logger.error('Health check error:', error);
      return false;
    }
  }

  /**
   * List all available models in Ollama
   *
   * @returns Array of model information
   *
   * @example
   * ```typescript
   * const models = await utility.listModels();
   * models.forEach(model => {
   *   console.log(`${model.name} - ${formatSize(model.size || 0)}`);
   * });
   * ```
   */
  async listModels(): Promise<OllamaModel[]> {
    logger.info('Listing models...');

    try {
      const response = await fetch(`${this.baseURL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const models: OllamaModel[] = data.models || [];

      logger.info(`Found ${models.length} model(s)`);
      return models;
    } catch (error) {
      logger.error('Error listing models:', error);
      throw error;
    }
  }

  /**
   * Get detailed information about a specific model
   *
   * @param modelName - Name of the model (e.g., 'llama3.2', 'qwen2.5')
   * @returns Detailed model information
   *
   * @example
   * ```typescript
   * const info = await utility.getModelInfo('llama3.2');
   * console.log('License:', info.license);
   * console.log('Parameters:', info.parameters);
   * ```
   */
  async getModelInfo(modelName: string): Promise<OllamaModelInfo> {
    logger.info(`Getting info for model: ${modelName}`);

    try {
      const response = await fetch(`${this.baseURL}/api/show`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Failed to get model info: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      logger.info(`Model info retrieved for ${modelName}`);
      return data;
    } catch (error) {
      logger.error('Error getting model info:', error);
      throw error;
    }
  }

  /**
   * Show models currently running in memory
   *
   * @returns Array of running model information
   *
   * @example
   * ```typescript
   * const running = await utility.showRunningModels();
   * running.forEach(model => {
   *   console.log(`${model.name} - VRAM: ${formatSize(model.vram_total || 0)}`);
   * });
   * ```
   */
  async showRunningModels(): Promise<OllamaRunningModel[]> {
    logger.info('Showing running models...');

    try {
      const response = await fetch(`${this.baseURL}/api/ps`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Failed to get running models: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const models: OllamaRunningModel[] = data.models || [];

      logger.info(`Found ${models.length} running model(s)`);
      return models;
    } catch (error) {
      logger.error('Error showing running models:', error);
      throw error;
    }
  }

  /**
   * Pull (download) a model from Ollama library
   *
   * @param modelName - Name of the model to pull (e.g., 'llama3.2', 'qwen2.5:7b')
   * @param options - Pull options
   * @returns Success message when complete
   *
   * @example
   * ```typescript
   * // Simple pull
   * await utility.pullModel('llama3.2');
   *
   * // Pull with progress callback
   * await utility.pullModel('qwen2.5:7b', {
   *   onProgress: (progress) => {
   *     console.log(`${progress.status}: ${progress.completed || 0}/${progress.total || 0}`);
   *   }
   * });
   * ```
   */
  async pullModel(modelName: string, options: PullOptions = {}): Promise<string> {
    logger.info(`Pulling model: ${modelName}`);

    const { insecure = false, stream = true, onProgress } = options;

    try {
      const response = await fetch(`${this.baseURL}/api/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: modelName,
          insecure,
          stream,
        }),
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`Failed to pull model: ${response.status} ${response.statusText}`);
      }

      if (stream) {
        // Read streaming response
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error('Response body is not readable');
        }

        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line);

              if (data.error) {
                throw new Error(data.error);
              }

              if (data.status === 'success') {
                logger.info(`Model ${modelName} pulled successfully`);
                return `Model ${modelName} pulled successfully`;
              }

              // Call progress callback
              if (onProgress) {
                onProgress(data);
              }

              // Log progress
              if (data.total && data.completed) {
                const percent = ((data.completed / data.total) * 100).toFixed(1);
                logger.info(`${data.status}: ${percent}%`);
              } else if (data.digest) {
                logger.info(`${data.status}: ${data.digest.substring(0, 12)}...`);
              } else {
                logger.info(data.status);
              }
            } catch (parseError) {
              // Skip invalid JSON lines
            }
          }
        }

        logger.info(`Model ${modelName} pulled successfully`);
        return `Model ${modelName} pulled successfully`;
      } else {
        // Non-streaming response
        await response.json();
        logger.info(`Model ${modelName} pulled successfully`);
        return `Model ${modelName} pulled successfully`;
      }
    } catch (error) {
      logger.error('Error pulling model:', error);
      throw error;
    }
  }

  /**
   * Delete a model from Ollama
   *
   * @param modelName - Name of the model to delete
   * @returns Success message
   *
   * @example
   * ```typescript
   * await utility.deleteModel('old-model:latest');
   * ```
   */
  async deleteModel(modelName: string): Promise<string> {
    logger.info(`Deleting model: ${modelName}`);

    try {
      const response = await fetch(`${this.baseURL}/api/delete`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Failed to delete model: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      logger.info(`Model ${modelName} deleted successfully`);
      return `Model ${modelName} deleted successfully`;
    } catch (error) {
      logger.error('Error deleting model:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for text using a model
   *
   * @param text - Text to generate embeddings for
   * @param modelName - Model to use (default: 'llama3.2')
   * @returns Vector of numbers representing the text
   *
   * @example
   * ```typescript
   * const embedding = await utility.generateEmbedding('Hello, world!', 'llama3.2');
   * console.log('Embedding dimension:', embedding.length);
   * ```
   */
  async generateEmbedding(text: string, modelName: string = 'llama3.2'): Promise<number[]> {
    logger.info(`Generating embedding for text (${text.length} chars)`);

    try {
      const response = await fetch(`${this.baseURL}/api/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          input: text,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        throw new Error(`Failed to generate embedding: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const embedding: number[] = data.embedding || [];

      logger.info(`Generated ${embedding.length}-dimensional embedding`);
      return embedding;
    } catch (error) {
      logger.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Get a list of popular Ollama models with descriptions
   *
   * @returns Array of model names and their descriptions
   *
   * @example
   * ```typescript
   * const models = utility.getAvailableModelsList();
   * models.forEach(model => {
   *   console.log(`${model.name}: ${model.description}`);
   * });
   * ```
   */
  getAvailableModelsList(): Array<{ name: string; description: string; size?: string }> {
    return [
      {
        name: 'llama3.2',
        description: 'Meta Llama 3.2 - Open foundation model with 3B and 1B parameters. Excellent for general tasks, reasoning, and multilingual support.',
        size: '~2GB (3B) / ~1GB (1B)',
      },
      {
        name: 'llama3.2:latest',
        description: 'Latest version of Llama 3.2 - General purpose model with strong performance across most tasks.',
        size: '~2GB',
      },
      {
        name: 'qwen2.5',
        description: 'Alibaba Qwen 2.5 - Strong multilingual model with excellent English and Chinese capabilities. Good for coding and reasoning.',
        size: '~4.7GB (7B)',
      },
      {
        name: 'qwen2.5:7b',
        description: 'Qwen 2.5 with 7 billion parameters - Balanced performance and resource usage.',
        size: '~4.7GB',
      },
      {
        name: 'qwen2.5:14b',
        description: 'Qwen 2.5 with 14 billion parameters - Better performance for complex tasks.',
        size: '~9GB',
      },
      {
        name: 'mistral',
        description: 'Mistral 7B - Efficient open-source model with strong reasoning capabilities.',
        size: '~4.1GB',
      },
      {
        name: 'mixtral',
        description: 'Mixtral 8x7B - Mixture of Experts model with excellent performance on complex tasks.',
        size: '~26GB',
      },
      {
        name: 'codellama',
        description: 'Code Llama - Specialized model for code generation and understanding.',
        size: '~3.8GB (7B) / ~7.5GB (13B) / ~16GB (34B)',
      },
      {
        name: 'deepseek-coder',
        description: 'DeepSeek Coder - Advanced code generation model with strong performance across multiple programming languages.',
        size: '~4GB (6.7B) / ~9GB (33B)',
      },
      {
        name: 'phi3',
        description: 'Microsoft Phi-3 - Compact model with surprisingly strong performance. Good for edge deployment.',
        size: '~2.3GB (3.8B) / ~4.6GB (14B)',
      },
      {
        name: 'gemma2',
        description: 'Google Gemma 2 - Open lightweight model with good performance for general tasks.',
        size: '~2.7GB (2B) / ~5.4GB (9B) / ~9GB (27B)',
      },
      {
        name: 'nomic-embed-text',
        description: 'Nomic Embed Text - Specialized model for generating text embeddings (1024 dimensions).',
        size: '~274MB',
      },
      {
        name: 'mxbai-embed-large',
        description: 'MixedBread AI Embedding Large - High-quality text embedding model (1024 dimensions).',
        size: '~669MB',
      },
      {
        name: 'stablelm2',
        description: 'Stability AI StableLM 2 - General purpose language model with Zephyr fine-tuning.',
        size: '~4.1GB (12B)',
      },
      {
        name: 'yi',
        description: '01.AI Yi - Bilingual Chinese-English model with strong performance on both languages.',
        size: '~4GB (6B) / ~8GB (9B) / ~16GB (34B)',
      },
    ];
  }
}

/**
 * Export for convenience
 */
export default OllamaModelUtility;
