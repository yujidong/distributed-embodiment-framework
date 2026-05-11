/**
 * Experiment Model Discovery — Sprint P33
 *
 * Dynamically discovers available LLM models from Ollama at experiment start.
 * Replaces hardcoded model lists with runtime discovery, so experiments never
 * need to guess what models are available.
 *
 * Usage:
 *   const discovery = await ExperimentModelDiscovery.create();
 *   const models = discovery.getSuitableModels();
 *   // models is an array of model names ready for experiments
 */

import { LLMInitializer } from '@active-collaboration/llm-integration';
import type { OllamaModel } from '@active-collaboration/llm-integration';
import { createLogger } from '@active-collaboration/shared';

const logger = createLogger('ExperimentModelDiscovery');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredModel {
  /** Full model name as registered in Ollama (e.g., 'qwen3-14b-q4:latest') */
  name: string;
  /** Model family (e.g., 'qwen3', 'llama3.1', 'qwen2.5') */
  family: string;
  /** Approximate parameter count (e.g., 14, 7, 32, 8) */
  paramCount: number;
  /** Quantization level (e.g., 'Q4_0', 'F16') or '' for unquantized */
  quantization: string;
  /** Model size in bytes */
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
  /** Whether Ollama was reachable */
  ollamaReachable: boolean;
  /** Error message if discovery failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Experiment Model Discovery
// ---------------------------------------------------------------------------

export class ExperimentModelDiscovery {
  private allModels: DiscoveredModel[] = [];
  private suitableModels: DiscoveredModel[] = [];
  private primaryModel: string;
  private _ollamaReachable: boolean;

  private constructor(
    rawModels: OllamaModel[],
    ollamaReachable: boolean,
    error?: string,
  ) {
    this._ollamaReachable = ollamaReachable;
    this.primaryModel = '';
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
   * Create a discovery instance by querying Ollama for available models.
   */
  static async create(): Promise<ExperimentModelDiscovery> {
    let rawModels: OllamaModel[] = [];
    let reachable = false;
    let error: string | undefined;

    try {
      rawModels = await LLMInitializer.getAvailableModels();
      reachable = true;
      logger.info(`Discovered ${rawModels.length} model(s) from Ollama`);
    } catch (err) {
      reachable = false;
      error = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to discover models: ${error}`);
    }

    const instance = new ExperimentModelDiscovery(rawModels, reachable, error);
    instance.printSummary();
    return instance;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** All models found in Ollama, including unsuitable ones. */
  getAllModels(): DiscoveredModel[] {
    return this.allModels;
  }

  /** Models suitable for experiment use (>= 7B parameters, not tools-variant). */
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

  /** Whether Ollama was reachable during discovery. */
  get ollamaReachable(): boolean {
    return this._ollamaReachable;
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

  private parseModel(raw: OllamaModel): DiscoveredModel {
    const name = raw.name;
    const sizeBytes = raw.size ?? 0;
    const details = raw.details;

    const family = details?.family ?? this.extractFamily(name);
    const paramCount = this.extractParamCount(name, details?.parameter_size);
    const quantization = this.extractQuantization(name, details?.quantization_level);

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

  private extractParamCount(name: string, parameterSize?: string): number {
    if (parameterSize) {
      // e.g., "14B" → 14, "7B" → 7
      const match = parameterSize.match(/(\d+(?:\.\d+)?)/i);
      if (match) return parseFloat(match[1]);
    }
    // Fallback: parse from name like 'qwen3-14b-q4'
    const nameMatch = name.match(/[-:](\d+(?:\.\d+)?)b/i);
    return nameMatch ? parseFloat(nameMatch[1]) : 0;
  }

  private extractQuantization(name: string, quantLevel?: string): string {
    if (quantLevel) return quantLevel;
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

    // Skip very small models (< 7B) — insufficient for complex AC reasoning
    if (paramCount > 0 && paramCount < 7) {
      return { isSuitable: false, unsuitableReason: `too small (${paramCount}B < 7B threshold)` };
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
    console.log(`  Ollama reachable: ${this._ollamaReachable}`);
    console.log(`  Total models:     ${this.allModels.length}`);
    console.log(`  Suitable models:  ${this.suitableModels.length}`);
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
