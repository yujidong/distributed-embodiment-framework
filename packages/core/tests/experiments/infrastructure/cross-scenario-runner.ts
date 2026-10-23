/**
 * Cross-Scenario Runner for PAPER_DESIGN_V5 (Phase 6)
 *
 * Orchestrates paper experiments across multiple scenarios and conditions
 * with multi-agent evaluation enabled. Produces aggregated results for:
 *   - Paradigm validation (does AC outperform baselines?)
 *   - Type × Condition interaction matrix
 *   - Cross-scenario consistency analysis
 */

import type {
  ExperimentCondition,
  PaperExperimentConfig,
  PaperExperimentResult,
  ScenarioType,
  TypeWiseMetricsMap,
  AggregatedTypeWiseMetrics,
} from './types.js';
import { SCENARIOS } from './scenario-definitions.js';
import { PaperExperimentRunner } from './paper-experiment-runner.js';
import { MetricsCollector } from './metrics-collector.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default conditions for cross-scenario comparison. */
const DEFAULT_CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'vague-spatial',
  'no-propagation',
  'no-service',
  'rule-only',
  'oracle',
];

/** Default scenarios to include. */
const DEFAULT_SCENARIOS: ScenarioType[] = [
  'apartment',
];

// ---------------------------------------------------------------------------
// Cross-scenario runner result
// ---------------------------------------------------------------------------

/** Per-condition aggregated results across all scenarios. */
export interface ConditionSummary {
  condition: ExperimentCondition;
  scenarioResults: Map<ScenarioType, PaperExperimentResult>;
  meanDecisionAccuracy: number;
  meanInitiationRate: number;
  meanGoalAchievementRate: number;
  meanTokensPerEvent: number;
  typeWiseMetrics?: AggregatedTypeWiseMetrics;
}

/** A recorded failure during cross-scenario execution. */
export interface ScenarioFailure {
  scenario: ScenarioType;
  condition: ExperimentCondition;
  error: unknown;
}

/** Full cross-scenario experiment result. */
export interface CrossScenarioResult {
  /** The configuration used for this run. */
  conditions: ExperimentCondition[];
  scenarios: ScenarioType[];
  llmModel: string;
  iterations: number;

  /** Per-condition summaries. */
  conditionSummaries: Map<ExperimentCondition, ConditionSummary>;

  /** All raw results. */
  rawResults: PaperExperimentResult[];

  /** Failures encountered during execution. */
  failures: ScenarioFailure[];

  /** Timestamp. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Cross-scenario runner
// ---------------------------------------------------------------------------

export class CrossScenarioRunner {
  private llmModel: string;
  private conditions: ExperimentCondition[];
  private scenarios: ScenarioType[];
  private iterations: number;
  private timeoutMs: number;

  constructor(options: {
    llmModel: string;
    conditions?: ExperimentCondition[];
    scenarios?: ScenarioType[];
    iterations?: number;
    timeoutMs?: number;
  }) {
    this.llmModel = options.llmModel;
    this.conditions = options.conditions ?? DEFAULT_CONDITIONS;
    this.scenarios = options.scenarios ?? DEFAULT_SCENARIOS;
    this.iterations = options.iterations ?? 1;
    this.timeoutMs = options.timeoutMs ?? 300000;
  }

  /**
   * Run the cross-scenario experiment. Executes each (scenario, condition)
   * combination and aggregates results.
   */
  async run(): Promise<CrossScenarioResult> {
    const rawResults: PaperExperimentResult[] = [];
    const conditionSummaries = new Map<ExperimentCondition, ConditionSummary>();
    const failures: ScenarioFailure[] = [];

    for (const condition of this.conditions) {
      const scenarioResults = new Map<ScenarioType, PaperExperimentResult>();

      for (const scenarioType of this.scenarios) {
        const config: PaperExperimentConfig = {
          id: `cross-${scenarioType}-${condition}`,
          name: `Cross-scenario: ${scenarioType} × ${condition}`,
          rq: 'RQ2',
          scenario: scenarioType,
          condition,
          iterations: this.iterations,
          llmModel: this.llmModel,
          timeoutMs: this.timeoutMs,
          multiAgentEval: true,
        };

        const runner = new PaperExperimentRunner(config);

        try {
          const results = await runner.run();
          for (const result of results) {
            rawResults.push(result);
            scenarioResults.set(scenarioType, result);
          }
        } catch (error) {
          console.error(`[CrossScenarioRunner] Failed: ${scenarioType} × ${condition}:`, error);
          failures.push({ scenario: scenarioType, condition, error });
        }
      }

      // Aggregate condition results
      if (scenarioResults.size > 0) {
        const results = Array.from(scenarioResults.values());
        const meanDecisionAccuracy = this.meanOf(results, r =>
          r.decisionQuality.meanCorrectDecisionRate,
        );
        const meanInitiationRate = this.meanOf(results, r =>
          r.collaboration.initiationRate,
        );
        const meanGoalAchievementRate = this.meanOf(results, r =>
          r.collaboration.goalAchievementRate,
        );
        const meanTokensPerEvent = this.meanOf(results, r =>
          r.efficiency.totalEvents > 0
            ? r.efficiency.totalTokens / r.efficiency.totalEvents
            : 0,
        );

        // Aggregate type-wise metrics if available
        let typeWiseMetrics: AggregatedTypeWiseMetrics | undefined;
        const allEvents = results.flatMap(r => r.events);
        if (allEvents.some(e => e.interactionType !== undefined)) {
          const scenarioDef = SCENARIOS[scenarioResults.keys().next().value!];
          const collector = new MetricsCollector(scenarioDef?.zones ?? []);
          const perResultMaps: TypeWiseMetricsMap[] = [];
          for (const r of results) {
            if (r.events.some(e => e.interactionType !== undefined)) {
              perResultMaps.push(collector.computeTypeWiseMetrics(r.events));
            }
          }
          if (perResultMaps.length > 0) {
            typeWiseMetrics = collector.mergeTypeWiseMetrics(perResultMaps);
          }
        }

        conditionSummaries.set(condition, {
          condition,
          scenarioResults,
          meanDecisionAccuracy,
          meanInitiationRate,
          meanGoalAchievementRate,
          meanTokensPerEvent,
          typeWiseMetrics,
        });
      }
    }

    return {
      conditions: this.conditions,
      scenarios: this.scenarios,
      llmModel: this.llmModel,
      iterations: this.iterations,
      conditionSummaries,
      rawResults,
      failures,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Print a summary of cross-scenario results.
   */
  printSummary(result: CrossScenarioResult): void {
    console.log('\n========================================');
    console.log('Cross-Scenario Experiment Summary');
    console.log('========================================');
    console.log(`Scenarios: ${result.scenarios.join(', ')}`);
    console.log(`Conditions: ${result.conditions.join(', ')}`);
    console.log(`Model: ${result.llmModel}`);
    console.log(`Total results: ${result.rawResults.length}`);

    console.log('\n| Condition | Dec.Acc | Init.Rate | GoalRate | Tok/Evt |');
    console.log('|-----------|---------|-----------|----------|---------|');

    for (const [condition, summary] of result.conditionSummaries) {
      console.log(
        `| ${condition.padEnd(9)} | ${summary.meanDecisionAccuracy.toFixed(3).padStart(7)} | ` +
        `${summary.meanInitiationRate.toFixed(3).padStart(9)} | ` +
        `${summary.meanGoalAchievementRate.toFixed(3).padStart(8)} | ` +
        `${summary.meanTokensPerEvent.toFixed(0).padStart(7)} |`,
      );
    }

    if (result.failures.length > 0) {
      console.log(`\n⚠ ${result.failures.length} failure(s):`);
      for (const f of result.failures) {
        console.log(`  - ${f.scenario} × ${f.condition}: ${f.error}`);
      }
    }
  }

  private meanOf(results: PaperExperimentResult[], extractor: (r: PaperExperimentResult) => number): number {
    if (results.length === 0) return 0;
    return results.reduce((sum, r) => sum + extractor(r), 0) / results.length;
  }
}
