/**
 * Enhanced Event Processor - Dual-Trigger Layer 1 Integration
 *
 * This is an enhanced version of EventProcessor that integrates:
 * 1. SpatialTemporalClusterEngine - Grid-based spatial clustering
 * 2. SpatialClusterSummarizer - Generate summaries for LLM
 * 3. TriggerConditionEvaluator - Rule-based AC need detection
 *
 * This is Layer 1 of the dual-trigger AC mechanism.
 * It efficiently filters 95% of events without LLM involvement.
 *
 * Flow:
 * High-freq Events → SpatialTemporalClusterEngine → SpatialClusterSummarizer
 *   → TriggerConditionEvaluator → (if needed) Layer 2 Cognitive Decision
 */

import type { SystemEvent, EventType } from './EventManager.js';
import {
  SpatialTemporalClusterEngine,
  type SpatialCluster,
  type SpatialClusterSummary,
  type ClusterEngineConfig,
} from './SpatialTemporalClusterEngine.js';
import {
  SpatialClusterSummarizer,
  type SummarizerConfig,
} from './SpatialClusterSummarizer.js';
import {
  TriggerConditionEvaluator,
  type TriggerEvaluationResult,
  type EvaluatorConfig,
} from './TriggerConditionEvaluator.js';
import type { AggregatedEvent, RuleContext, EventProcessorConfig } from './EventProcessor.js';
import { EventAggregator, RuleBasedFilter } from './EventProcessor.js';

import { createLogger } from '@active-collaboration/shared';
// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for EnhancedEventProcessor
 */
const logger = createLogger('EnhancedEventProcessor');

export interface EnhancedEventProcessorConfig {
  // Feature flags
  enableSpatialClustering: boolean;
  enableDualTrigger: boolean;

  // Layer 1 configurations
  clusterEngine: Partial<ClusterEngineConfig>;
  summarizer: Partial<SummarizerConfig>;
  evaluator: Partial<EvaluatorConfig>;

  // Fallback to simple aggregation
  simpleAggregation: EventProcessorConfig;
}

const DEFAULT_ENHANCED_CONFIG: EnhancedEventProcessorConfig = {
  enableSpatialClustering: true,
  enableDualTrigger: true,

  clusterEngine: {},
  summarizer: {},
  evaluator: {},

  simpleAggregation: {
    aggregationWindowMs: 1000,
    maxBatchSize: 100,
    significanceThresholds: {
      temperatureChange: 2,
      humidityChange: 5,
      stateChangeCount: 3,
    },
    bypassLLMForNormalChanges: true,
    bypassLLMForRoutinePeriodic: true,
    // Cost control: LLM is only called through explicit tasks by default
    enableAutoLLMProcessing: false,
  },
};

/**
 * Result of processing a cluster through Layer 1
 */
export interface Layer1Result {
  cluster: SpatialCluster;
  summary: SpatialClusterSummary;
  evaluation: TriggerEvaluationResult;
  needsLayer2: boolean;
}

/**
 * Callback for Layer 2 (LLM-based) processing
 */
export type Layer2Callback = (result: Layer1Result) => Promise<void>;

// ============================================================================
// EnhancedEventProcessor
// ============================================================================

export class EnhancedEventProcessor {
  private config: EnhancedEventProcessorConfig;
  private context: RuleContext;

  // Layer 1 components
  private clusterEngine: SpatialTemporalClusterEngine | null = null;
  private summarizer: SpatialClusterSummarizer | null = null;
  private evaluator: TriggerConditionEvaluator | null = null;

  // Fallback simple aggregation
  private simpleAggregator: EventAggregator | null = null;
  private ruleFilter: RuleBasedFilter | null = null;

  // Callbacks
  private onLayer2Needed: Layer2Callback;
  private onSimpleLLMNeeded: (event: AggregatedEvent) => Promise<void>;

  // Statistics
  private stats = {
    totalEventsProcessed: 0,
    clustersCreated: 0,
    passedToLayer2: 0,
    filteredByLayer1: 0,
    simpleAggregationUsed: 0,
  };

  constructor(
    config: Partial<EnhancedEventProcessorConfig>,
    context: RuleContext,
    onLayer2Needed: Layer2Callback,
    onSimpleLLMNeeded: (event: AggregatedEvent) => Promise<void>
  ) {
    // Deep merge config to properly propagate nested configuration objects
    // This ensures that clusterEngine, summarizer, evaluator, and simpleAggregation
    // configs are properly merged rather than replaced entirely
    this.config = {
      ...DEFAULT_ENHANCED_CONFIG,
      ...config,
      // Deep merge nested configuration objects
      clusterEngine: {
        ...DEFAULT_ENHANCED_CONFIG.clusterEngine,
        ...config.clusterEngine,
      },
      summarizer: {
        ...DEFAULT_ENHANCED_CONFIG.summarizer,
        ...config.summarizer,
      },
      evaluator: {
        ...DEFAULT_ENHANCED_CONFIG.evaluator,
        ...config.evaluator,
      },
      simpleAggregation: {
        ...DEFAULT_ENHANCED_CONFIG.simpleAggregation,
        ...config.simpleAggregation,
      },
    };
    this.context = context;
    this.onLayer2Needed = onLayer2Needed;
    this.onSimpleLLMNeeded = onSimpleLLMNeeded;

    this.initializeComponents();

    logger.info('Initialized with:', {
      spatialClustering: this.config.enableSpatialClustering,
      dualTrigger: this.config.enableDualTrigger,
    });
  }

  /**
   * Initialize Layer 1 components
   */
  private initializeComponents(): void {
    if (this.config.enableSpatialClustering && this.config.enableDualTrigger) {
      // Initialize spatial clustering pipeline
      this.clusterEngine = new SpatialTemporalClusterEngine(
        this.config.clusterEngine,
        (cluster) => this.handleClusterReady(cluster)
      );

      this.summarizer = new SpatialClusterSummarizer(this.config.summarizer);

      this.evaluator = new TriggerConditionEvaluator(this.config.evaluator);

      logger.info('Layer 1 components initialized');
    } else {
      // Fall back to simple aggregation
      this.simpleAggregator = new EventAggregator(
        this.config.simpleAggregation,
        (events) => this.handleSimpleBatch(events)
      );

      this.ruleFilter = new RuleBasedFilter(this.config.simpleAggregation);

      logger.info('Using simple aggregation fallback');
    }
  }

  /**
   * Process an incoming event
   */
  processEvent(event: SystemEvent): void {
    this.stats.totalEventsProcessed++;

    if (this.config.enableSpatialClustering && this.clusterEngine) {
      // Use spatial clustering pipeline
      this.clusterEngine.addEvent(event);
    } else if (this.simpleAggregator) {
      // Use simple aggregation
      this.simpleAggregator.addEvent(event);
    }
  }

  /**
   * Handle a cluster ready from the clustering engine
   */
  private async handleClusterReady(cluster: SpatialCluster): Promise<void> {
    this.stats.clustersCreated++;

    // Generate summary
    const summary = this.summarizer!.summarize(cluster);

    // Evaluate trigger conditions
    const evaluation = this.evaluator!.evaluate(cluster, summary);

    // Create Layer 1 result
    const result: Layer1Result = {
      cluster,
      summary,
      evaluation,
      needsLayer2: evaluation.needsEvaluation,
    };

    // Cost control: Skip automatic LLM processing if disabled
    if (!this.config.simpleAggregation.enableAutoLLMProcessing) {
      this.stats.filteredByLayer1++;
      logger.info(`Cluster ${cluster.id} would need Layer 2, but auto LLM processing is disabled. Skipping.`);
      return;
    }

    if (evaluation.needsEvaluation) {
      // Pass to Layer 2 for LLM-based decision
      this.stats.passedToLayer2++;

      logger.info(`Cluster ${cluster.id} passed to Layer 2:`, {
        significance: summary.significance,
        urgency: evaluation.urgency,
        matchedTriggers: evaluation.matchedTriggers.length,
        recommendation: evaluation.recommendation,
      });

      await this.onLayer2Needed(result);
    } else {
      // Filtered by Layer 1
      this.stats.filteredByLayer1++;

      logger.info(`Cluster ${cluster.id} filtered by Layer 1:`, {
        significance: summary.significance,
        reasoning: evaluation.reasoning,
      });
    }
  }

  /**
   * Handle a batch from simple aggregation (fallback mode)
   */
  private async handleSimpleBatch(events: AggregatedEvent[]): Promise<void> {
    this.stats.simpleAggregationUsed += events.length;

    for (const event of events) {
      // Try rule-based processing
      const { handled, result } = this.ruleFilter!.process(event, this.context);

      if (handled) {
        logger.info(`Event handled by simple rules: ${result?.reason}`);
        continue;
      }

      // Cost control: Skip automatic LLM processing if disabled
      if (!this.config.simpleAggregation.enableAutoLLMProcessing) {
        logger.info(`Event not handled by rules, but auto LLM processing is disabled. Skipping.`);
        continue;
      }

      // Needs LLM processing
      await this.onSimpleLLMNeeded(event);
    }
  }

  /**
   * Update context (e.g., when device states change)
   */
  updateContext(updates: Partial<RuleContext>): void {
    Object.assign(this.context, updates);
  }

  /**
   * Get current statistics
   */
  getStats(): typeof this.stats & {
    filteringRate: number;
    layer2Rate: number;
  } {
    const filteringRate = this.stats.clustersCreated > 0
      ? (this.stats.filteredByLayer1 / this.stats.clustersCreated) * 100
      : 0;

    const layer2Rate = this.stats.clustersCreated > 0
      ? (this.stats.passedToLayer2 / this.stats.clustersCreated) * 100
      : 0;

    return {
      ...this.stats,
      filteringRate,
      layer2Rate,
    };
  }

  /**
   * Stop processing and flush remaining data
   */
  stop(): void {
    logger.info('Stopping...');

    if (this.clusterEngine) {
      this.clusterEngine.stop();
    }

    if (this.simpleAggregator) {
      this.simpleAggregator.stop();
    }

    logger.info('Final stats:', this.getStats());
  }

  /**
   * Force flush of pending data
   */
  flush(): void {
    if (this.clusterEngine) {
      this.clusterEngine.flush();
    }

    if (this.simpleAggregator) {
      this.simpleAggregator.flush();
    }
  }

  /**
   * Get Layer 1 component status
   */
  getStatus(): {
    mode: 'dual-trigger' | 'simple';
    components: {
      clusterEngine: boolean;
      summarizer: boolean;
      evaluator: boolean;
    };
  } {
    return {
      mode: this.config.enableSpatialClustering && this.config.enableDualTrigger
        ? 'dual-trigger'
        : 'simple',
      components: {
        clusterEngine: this.clusterEngine !== null,
        summarizer: this.summarizer !== null,
        evaluator: this.evaluator !== null,
      },
    };
  }
}

export default EnhancedEventProcessor;
