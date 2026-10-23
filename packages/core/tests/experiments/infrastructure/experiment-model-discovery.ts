/**
 * Experiment Model Discovery — Sprint P33
 *
 * Dynamically discovers served LLM models from the OpenAI-compatible backend
 * (vLLM) at experiment start. Replaces hardcoded model lists with runtime
 * discovery, so experiments never need to guess what models are available.
 *
 * Usage:
 *   const discovery = await ExperimentModelDiscovery.create();
 *   const models = discovery.getSuitableModels();
 *   // models is an array of model names ready for experiments
 *
 * Suitability threshold:
 *   Models below a minimum parameter count are marked unsuitable (default:
 *   7B). Override per call with `create({ minParamCount: 1.5 })` or globally
 *   via the EXPERIMENT_MIN_MODEL_PARAMS_B environment variable (billions of
 *   parameters, e.g. `EXPERIMENT_MIN_MODEL_PARAMS_B=1.5` to allow small local
 *   models such as qwen2.5-1.5b-q4). Note: an explicitly configured
 *   `PaperExperimentConfig.llmModel` bypasses discovery entirely — the runner
 *   passes it to initializeLLM({ preferredModels: [llmModel] }), which honors
 *   any served model regardless of size. This threshold only gates
 *   discovery-driven (auto/enumerated) model selection.
 */

import { LLMInitializer } from '@active-collaboration/llm-integration';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ExperimentModelDiscovery');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredModel {
  /** Full model name as served by the backend (e.g., 'qwen3-14b-q4:latest') */
  name: string;
  /** Model family (e.g., 'qwen3', 'llama3.1', 'qwen2.5') */
  family: string;
  /** Approximate parameter count (e.g., 14, 7, 32, 8) */
  paramCount: number;
  /** Quantization level (e.g., 'Q4', 'F16') or '' for unquantized */
  quantization: string;
  /** Model size in bytes — the models endpoint carries no size; always 0 */
  sizeBytes: number;
  /** Whether this model is suitable for experiment use */
  isSuitable: boolean;
  /** Reason if not suitable */
  unsuitableReason?: string;
}

export interface ModelDiscoveryResult {
  /** All discovered models */
  allModels: DiscoveredModel[];
  /** Only models deemed suitable for experiments */
  suitableModels: DiscoveredModel[];
  /** Primary model (best available, used for Pilot 1-2-4-5) */
  primaryModel: string;
  /** Whether the backend was reachable */
  backendReachable: boolean;
  /** Error message if discovery failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Experiment Model Discovery
// ---------------------------------------------------------------------------

export class ExperimentModelDiscovery {
  /** Default minimum parameter count (in billions) for experiment suitability. */
  static readonly DEFAULT_MIN_PARAM_COUNT = 7;

  private allModels: DiscoveredModel[] = [];
  private suitableModels: DiscoveredModel[] = [];
  private primaryModel: string;
  private _backendReachable: boolean;
  /** Minimum parameter count (B) for a model to be experiment-suitable. */
  private readonly minParamCount: number;

  private constructor(
    rawModels: string[],
    backendReachable: boolean,
    error?: string,
    minParamCount?: number,
  ) {
    this._backendReachable = backendReachable;
    this.primaryModel = '';
    this.minParamCount = minParamCount ?? ExperimentModelDiscovery.DEFAULT_MIN_PARAM_COUNT;
    if (error) {
      logger.error(`Discovery error: ${error}`);
    }
    if (rawModels.length > 0) {
      this.allModels = rawModels.map(m => this.parseModel(m));
      this.suitableModels = this.allModels.filter(m => m.isSuitable);
      this.primaryModel = this.selectPrimaryModel();
    }
  }

  /**
   * Create a discovery instance by querying the backend for served models.
   *
   * @param options.minParamCount - Minimum parameter count (in billions) for
   *   a model to be suitable. Defaults to the EXPERIMENT_MIN_MODEL_PARAMS_B
   *   env var when set, otherwise 7.
   */
  static async create(
    options: { minParamCount?: number } = {},
  ): Promise<ExperimentModelDiscovery> {
    let rawModels: string[] = [];
    let reachable = false;
    let error: string | undefined;

    try {
      rawModels = await LLMInitializer.getAvailableModels();
      reachable = true;
      logger.info(`Discovered ${rawModels.length} model(s) from the backend`);
    } catch (err) {
      reachable = false;
      error = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to discover models: ${error}`);
    }

    const instance = new ExperimentModelDiscovery(
      rawModels,
      reachable,
      error,
      options.minParamCount ?? this.minParamCountFromEnv(),
    );
    instance.printSummary();
    return instance;
  }

  /**
   * Read the suitability threshold from EXPERIMENT_MIN_MODEL_PARAMS_B.
   * Returns undefined when unset/invalid so the default (7B) applies.
   */
  private static minParamCountFromEnv(): number | undefined {
    const raw = process.env.EXPERIMENT_MIN_MODEL_PARAMS_B;
    if (!raw) return undefined;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** All served models, including unsuitable ones. */
  getAllModels(): DiscoveredModel[] {
    return this.allModels;
  }

  /** Models suitable for experiment use (>= minParamCount B parameters, not tools-variant). */
  getSuitableModels(): DiscoveredModel[] {
    return this.suitableModels;
  }

  /** Names of suitable models, ready for use in PaperExperimentRunner configs. */
  getSuitableModelNames(): string[] {
    return this.suitableModels.map(m => m.name);
  }

  /** The best available model for primary experiment use. */
  getPrimaryModel(): string {
    return this.primaryModel;
  }

  /** Whether the backend was reachable during discovery. */
  get backendReachable(): boolean {
    return this._backendReachable;
  }

  /** Get model names grouped by family (for cross-model comparison). */
  getModelFamilies(): Map<string, DiscoveredModel[]> {
    const families = new Map<string, DiscoveredModel[]>();
    for (const model of this.suitableModels) {
      const existing = families.get(model.family) || [];
      existing.push(model);
      families.set(model.family, existing);
    }
    return families;
  }

  // -------------------------------------------------------------------------
  // Internal: Model parsing
  // -------------------------------------------------------------------------

  private parseModel(name: string): DiscoveredModel {
    const sizeBytes = 0; // the models endpoint carries no size information

    const family = this.extractFamily(name);
    const paramCount = this.extractParamCount(name);
    const quantization = this.extractQuantization(name);

    // Suitability check: we want models that can handle complex reasoning
    const { isSuitable, unsuitableReason } = this.checkSuitability(
      name, family, paramCount, quantization, sizeBytes,
    );

    return { name, family, paramCount, quantization, sizeBytes, isSuitable, unsuitableReason };
  }

  private extractFamily(name: string): string {
    // Extract base family from model name like 'qwen3-14b-q4:latest'
    const base = name.replace(/:latest$/, '');
    const parts = base.split('-');
    // Try to find the family: everything before the parameter count indicator
    const familyParts: string[] = [];
    for (const part of parts) {
      if (/^\d+b$/i.test(part) || /^q\d/i.test(part)) break;
      familyParts.push(part);
    }
    return familyParts.join('-') || base;
  }

  private extractParamCount(name: string): number {
    // Parse from names like 'qwen3-14b-q4' or 'Qwen/Qwen2.5-7B-Instruct'
    const nameMatch = name.match(/[-:](\d+(?:\.\d+)?)b/i);
    return nameMatch ? parseFloat(nameMatch[1]) : 0;
  }

  private extractQuantization(name: string): string {
    // Parse from name like 'qwen3-14b-q4'
    const match = name.match(/-q(\d+)/i);
    return match ? `Q${match[1]}` : '';
  }

  private checkSuitability(
    name: string,
    _family: string,
    paramCount: number,
    _quantization: string,
    _sizeBytes: number,
  ): { isSuitable: boolean; unsuitableReason?: string } {
    // Skip tools-variant models — they have tool-use overhead that adds noise
    if (name.includes('-tools')) {
      return { isSuitable: false, unsuitableReason: 'tools-variant: not suitable for direct reasoning tasks' };
    }

    // Skip very small models (below the suitability threshold) — insufficient
    // for complex AC reasoning. Threshold defaults to 7B; configurable via
    // create({ minParamCount }) or EXPERIMENT_MIN_MODEL_PARAMS_B.
    if (paramCount > 0 && paramCount < this.minParamCount) {
      return { isSuitable: false, unsuitableReason: `too small (${paramCount}B < ${this.minParamCount}B threshold)` };
    }

    // Models with 0 detected params but not a known large model family — skip
    // (embedding models, etc.)
    if (paramCount === 0 && !/qwen|llama|mistral|deepseek|ds-/i.test(name)) {
      return { isSuitable: false, unsuitableReason: 'unknown model family or embedding model' };
    }

    return { isSuitable: true };
  }

  // -------------------------------------------------------------------------
  // Internal: Primary model selection
  // -------------------------------------------------------------------------

  private selectPrimaryModel(): string {
    if (this.suitableModels.length === 0) return '';

    // Priority: prefer 14B quantized models, then 7B+ quantized, then any
    const priority = (m: DiscoveredModel): number => {
      let score = 0;
      // Prefer models around 14B (sweet spot for reasoning vs speed)
      if (m.paramCount >= 12 && m.paramCount <= 20) score += 100;
      else if (m.paramCount >= 7) score += 50;
      // Prefer quantized (faster inference)
      if (m.quantization) score += 10;
      // Prefer qwen3 family (best tested)
      if (m.family.includes('qwen3')) score += 20;
      return score;
    };

    const sorted = [...this.suitableModels].sort(
      (a, b) => priority(b) - priority(a),
    );
    return sorted[0].name;
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  private printSummary(): void {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║   Experiment Model Discovery                ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`  Backend reachable: ${this._backendReachable}`);
    console.log(`  Total models:     ${this.allModels.length}`);
    console.log(`  Suitable models:  ${this.suitableModels.length}`);
    console.log(`  Min parameters:   ${this.minParamCount}B`);
    console.log(`  Primary model:    ${this.primaryModel || '(none)'}`);
    console.log('');

    if (this.allModels.length > 0) {
      console.log('  All discovered models:');
      for (const m of this.allModels) {
        const flag = m.isSuitable ? '✓' : '✗';
        const reason = m.unsuitableReason ? ` (${m.unsuitableReason})` : '';
        console.log(`    ${flag} ${m.name} — ${m.family}/${m.paramCount}B/${m.quantization || 'full'}${reason}`);
      }
    }

    if (this.suitableModels.length > 0) {
      console.log('\n  Models available for experiments:');
      for (const m of this.suitableModels) {
        console.log(`    - ${m.name}`);
      }
    }
    console.log('');
  }
}
