/**
 * RQ3: Two-Layer Dual-Trigger Architecture Efficiency
 *
 * Research Question: How efficient is the two-layer dual-trigger architecture?
 *
 * This experiment evaluates RQ3 by comparing resource consumption across three
 * experimental conditions that isolate the contribution of each filtering layer:
 *
 *   1. full-ac     — Layer 1 (rule-based) + Layer 2 (LLM assessment) enabled
 *   2. rule-only   — Layer 1 only; Layer 2 disabled (no LLM calls)
 *   3. text-only   — All physical context stripped; LLM processes raw text only
 *
 * By comparing these conditions we establish that:
 *   - Layer 1 filtering reduces LLM call volume (rule-only should have 0 LLM calls)
 *   - The two-layer architecture maintains quality while reducing cost
 *   - Text-only processing reveals the overhead of missing physical context
 *
 * Scenarios:
 *   - apartment:        Five-room apartment with three agents
 *   - campus:           Nine-building campus with six agents
 *
 * Conditions x Scenarios = 6 test cases, each running 1 iteration.
 *
 * Key efficiency metrics (from results[0].efficiency):
 *   - totalEvents:        Total events processed
 *   - layer1Filtered:     Events filtered by Layer 1 only
 *   - layer1FilterRate:   Fraction of events handled by Layer 1 (0-1)
 *   - llmCallCount:       Number of LLM API calls made
 *   - totalTokens:        Total token count across all LLM calls
 *   - promptTokens:       Prompt tokens consumed
 *   - completionTokens:   Completion tokens produced
 *   - avgAssessmentTimeMs: Average Layer 2 assessment time
 *   - totalWallTimeMs:    Total wall-clock time for the iteration
 *
 * Paper Section: Results - RQ3 Architecture Efficiency
 *
 * CLAUDE.md compliance:
 *   - NO mocks, NO fallbacks -- real Ollama LLM (qwen3-14b-q4:latest)
 *   - Full CognitiveAgent with dual-trigger architecture
 *   - Real SimulatedDevice with actual state changes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LLMClient, initializeLLM } from '@active-collaboration/llm-integration';
import { PaperExperimentRunner } from './infrastructure/paper-experiment-runner.js';
import type { ScenarioType, ExperimentCondition } from './infrastructure/types.js';

// ---------------------------------------------------------------------------
// Experiment parameters
// ---------------------------------------------------------------------------

const conditions: ExperimentCondition[] = [
  'full-ac',
  'rule-only',
  'text-only',
];

const scenarios: ScenarioType[] = ['apartment', 'campus'];

const LLM_MODEL = 'qwen3-14b-q4:latest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that all efficiency metric values are finite numbers.
 * Throws a descriptive assertion failure if any metric is NaN or Infinity.
 */
function assertAllEfficiencyMetricsFinite(
  efficiency: {
    totalEvents: number;
    layer1Filtered: number;
    layer1FilterRate: number;
    llmCallCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    avgAssessmentTimeMs: number;
    totalWallTimeMs: number;
  },
  label: string,
): void {
  const metricNames = [
    'totalEvents',
    'layer1Filtered',
    'layer1FilterRate',
    'llmCallCount',
    'totalTokens',
    'promptTokens',
    'completionTokens',
    'avgAssessmentTimeMs',
    'totalWallTimeMs',
  ] as const;

  for (const metric of metricNames) {
    const value = efficiency[metric];
    expect(
      Number.isFinite(value),
      `[${label}] efficiency.${metric} should be finite, got: ${value}`,
    ).toBe(true);
  }
}

/**
 * Log a structured efficiency summary for paper data collection.
 */
function logEfficiencySummary(
  condition: ExperimentCondition,
  scenario: ScenarioType,
  efficiency: {
    totalEvents: number;
    layer1Filtered: number;
    layer1FilterRate: number;
    llmCallCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    avgAssessmentTimeMs: number;
    totalWallTimeMs: number;
  },
): void {
  console.log(`\n=== RQ3 Efficiency: ${condition} / ${scenario} ===`);
  console.log(`  totalEvents:         ${efficiency.totalEvents}`);
  console.log(`  layer1Filtered:      ${efficiency.layer1Filtered}`);
  console.log(`  layer1FilterRate:    ${efficiency.layer1FilterRate.toFixed(3)}`);
  console.log(`  llmCallCount:        ${efficiency.llmCallCount}`);
  console.log(`  totalTokens:         ${efficiency.totalTokens}`);
  console.log(`  promptTokens:        ${efficiency.promptTokens}`);
  console.log(`  completionTokens:    ${efficiency.completionTokens}`);
  console.log(`  avgAssessmentTimeMs: ${efficiency.avgAssessmentTimeMs.toFixed(1)} ms`);
  console.log(`  totalWallTimeMs:     ${efficiency.totalWallTimeMs.toFixed(1)} ms`);

  // Derived metrics useful for the paper
  if (efficiency.totalEvents > 0) {
    const avgTokensPerEvent = efficiency.totalTokens / efficiency.totalEvents;
    const avgTokensPerLLMCall = efficiency.llmCallCount > 0
      ? efficiency.totalTokens / efficiency.llmCallCount
      : 0;
    console.log(`  --- Derived ---`);
    console.log(`  avgTokensPerEvent:   ${avgTokensPerEvent.toFixed(1)}`);
    console.log(`  avgTokensPerLLMCall: ${avgTokensPerLLMCall.toFixed(1)}`);
    console.log(`  llmCallReduction:    ${((1 - efficiency.llmCallCount / efficiency.totalEvents) * 100).toFixed(1)}% of events bypassed LLM`);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RQ3: Two-Layer Dual-Trigger Architecture Efficiency', () => {
  // Shared LLM initialization -- verify connectivity once before all tests
  let sharedLLMClient: LLMClient;

  // Accumulate efficiency data across all test cases for cross-condition comparison
  const efficiencyData: Array<{
    condition: ExperimentCondition;
    scenario: ScenarioType;
    efficiency: {
      totalEvents: number;
      layer1Filtered: number;
      layer1FilterRate: number;
      llmCallCount: number;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      avgAssessmentTimeMs: number;
      totalWallTimeMs: number;
    };
  }> = [];

  beforeAll(async () => {
    console.log('\n========================================');
    console.log('[RQ3] Two-Layer Dual-Trigger Architecture Efficiency');
    console.log('========================================\n');

    const initResult = await initializeLLM({
      preferredModels: [LLM_MODEL],
      allowFallback: false,
    });

    if (!initResult.success) {
      throw new Error(`LLM initialization failed: ${initResult.error}`);
    }

    sharedLLMClient = new LLMClient('ollama', { model: initResult.selectedModel });

    console.log(`[RQ3] Using model: ${initResult.selectedModel}`);
    console.log(`[RQ3] Conditions: ${conditions.join(', ')}`);
    console.log(`[RQ3] Scenarios: ${scenarios.join(', ')}`);
    console.log(`[RQ3] Total test cases: ${conditions.length * scenarios.length}`);
  }, 120000);

  // -----------------------------------------------------------------------
  // Cross-product: condition x scenario
  // -----------------------------------------------------------------------

  for (const condition of conditions) {
    for (const scenario of scenarios) {
      it(`${condition} / ${scenario}`, async () => {
        console.log(`\n[RQ3] Running: ${condition} / ${scenario}`);

        // Build the experiment configuration
        const config = PaperExperimentRunner.createConfig({
          id: `rq3-${condition}-${scenario}`,
          name: `RQ3 ${condition} ${scenario}`,
          rq: 'RQ3',
          scenario,
          condition,
          iterations: 1,
          llmModel: LLM_MODEL,
          timeoutMs: 120000,
        });

        // Execute the experiment -- real LLM, real simulation, no mocks
        const runner = new PaperExperimentRunner(config);
        const results = await runner.run();

        // -----------------------------------------------------------------
        // Structural assertions
        // -----------------------------------------------------------------

        // One result per iteration (we configured iterations: 1)
        expect(results).toHaveLength(1);

        // The result should contain events from the scenario
        expect(results[0].events.length).toBeGreaterThan(0);

        // -----------------------------------------------------------------
        // Efficiency metric extraction
        // -----------------------------------------------------------------

        const efficiency = results[0].efficiency;

        // Store for cross-condition comparison in afterAll
        efficiencyData.push({ condition, scenario, efficiency });

        // -----------------------------------------------------------------
        // Core efficiency assertions
        // -----------------------------------------------------------------

        // All efficiency metrics must be finite numbers
        assertAllEfficiencyMetricsFinite(efficiency, `${condition}/${scenario}`);

        // layer1FilterRate must be in [0, 1]
        expect(
          efficiency.layer1FilterRate,
          `[${condition}/${scenario}] layer1FilterRate should be >= 0, got: ${efficiency.layer1FilterRate}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          efficiency.layer1FilterRate,
          `[${condition}/${scenario}] layer1FilterRate should be <= 1, got: ${efficiency.layer1FilterRate}`,
        ).toBeLessThanOrEqual(1);

        // totalWallTimeMs must be positive (the experiment did run)
        expect(
          efficiency.totalWallTimeMs,
          `[${condition}/${scenario}] totalWallTimeMs should be > 0, got: ${efficiency.totalWallTimeMs}`,
        ).toBeGreaterThan(0);

        // -----------------------------------------------------------------
        // Condition-specific assertions
        // -----------------------------------------------------------------

        if (condition === 'rule-only') {
          // Layer 2 is disabled for rule-only: no LLM calls should occur.
          // The buildDualTriggerConfig sets enableLayer2: false for this condition.
          expect(
            efficiency.llmCallCount,
            `[rule-only/${scenario}] llmCallCount must be 0 when Layer 2 is disabled, got: ${efficiency.llmCallCount}`,
          ).toBe(0);

          // When no LLM calls are made, token counts should be 0
          expect(
            efficiency.totalTokens,
            `[rule-only/${scenario}] totalTokens must be 0 when no LLM calls, got: ${efficiency.totalTokens}`,
          ).toBe(0);
          expect(
            efficiency.promptTokens,
            `[rule-only/${scenario}] promptTokens must be 0 when no LLM calls, got: ${efficiency.promptTokens}`,
          ).toBe(0);
          expect(
            efficiency.completionTokens,
            `[rule-only/${scenario}] completionTokens must be 0 when no LLM calls, got: ${efficiency.completionTokens}`,
          ).toBe(0);

          // All events should be handled by Layer 1
          expect(
            efficiency.layer1FilterRate,
            `[rule-only/${scenario}] layer1FilterRate should be 1.0 when Layer 2 is disabled, got: ${efficiency.layer1FilterRate}`,
          ).toBe(1);

          // Assessment time should be 0 (no LLM assessment)
          expect(
            efficiency.avgAssessmentTimeMs,
            `[rule-only/${scenario}] avgAssessmentTimeMs should be 0 when no LLM calls, got: ${efficiency.avgAssessmentTimeMs}`,
          ).toBe(0);
        }

        if (condition === 'full-ac') {
          // Full AC should use some LLM calls (Layer 2 is enabled)
          // We cannot assert > 0 because Layer 1 might filter all events,
          // but we can assert the count is non-negative and finite
          expect(efficiency.llmCallCount).toBeGreaterThanOrEqual(0);

          // When LLM calls are made, tokens should be positive
          if (efficiency.llmCallCount > 0) {
            expect(efficiency.totalTokens).toBeGreaterThan(0);
            expect(efficiency.promptTokens).toBeGreaterThan(0);
            expect(efficiency.completionTokens).toBeGreaterThan(0);
            expect(efficiency.avgAssessmentTimeMs).toBeGreaterThan(0);
          }
        }

        if (condition === 'text-only') {
          // Text-only uses LLM but without physical context.
          // LLM call count and tokens should be non-negative and finite.
          expect(efficiency.llmCallCount).toBeGreaterThanOrEqual(0);

          if (efficiency.llmCallCount > 0) {
            expect(efficiency.totalTokens).toBeGreaterThan(0);
          }
        }

        // -----------------------------------------------------------------
        // Log metrics for paper data collection
        // -----------------------------------------------------------------

        logEfficiencySummary(condition, scenario, efficiency);

        // Log per-event details for deeper analysis
        for (const eventResult of results[0].events) {
          console.log(
            `  Event ${eventResult.eventId}: ` +
            `decision=${eventResult.decisionMade}, ` +
            `assessmentTime=${eventResult.assessmentTimeMs.toFixed(1)}ms, ` +
            `correct=${eventResult.correctDecision}`,
          );
        }

        // Log raw dual-trigger stats for architecture-level analysis
        console.log(
          `  rawDualTriggerStats: ${JSON.stringify(results[0].rawDualTriggerStats, null, 2)}`,
        );
      }, 300000); // 5-minute timeout per test (real LLM calls)
    }
  }

  // -----------------------------------------------------------------------
  // Summary after all test cases complete
  // -----------------------------------------------------------------------

  afterAll(() => {
    console.log('\n========================================');
    console.log('[RQ3] Two-Layer Architecture Efficiency Experiment Complete');
    console.log('========================================');

    // -----------------------------------------------------------------
    // Cross-condition comparison table
    // -----------------------------------------------------------------

    console.log('\n[RQ3] Cross-Condition Efficiency Comparison\n');

    // Header
    console.log(
      'Condition'.padEnd(16) +
      'Scenario'.padEnd(12) +
      'Events'.padEnd(8) +
      'L1-Filter%'.padEnd(12) +
      'LLM-Calls'.padEnd(12) +
      'Total-Tok'.padEnd(12) +
      'Avg-Assess'.padEnd(12) +
      'Wall-Time',
    );
    console.log('-'.repeat(96));

    for (const entry of efficiencyData) {
      const { condition, scenario, efficiency: eff } = entry;
      console.log(
        condition.padEnd(16) +
        scenario.padEnd(12) +
        String(eff.totalEvents).padEnd(8) +
        `${(eff.layer1FilterRate * 100).toFixed(1)}%`.padEnd(12) +
        String(eff.llmCallCount).padEnd(12) +
        String(eff.totalTokens).padEnd(12) +
        `${eff.avgAssessmentTimeMs.toFixed(0)}ms`.padEnd(12) +
        `${(eff.totalWallTimeMs / 1000).toFixed(1)}s`,
      );
    }

    // -----------------------------------------------------------------
    // Key findings summary
    // -----------------------------------------------------------------

    console.log('\n[RQ3] Key Efficiency Findings:');

    // Layer 1 savings: compare rule-only (all Layer 1) vs full-ac
    for (const scenario of scenarios) {
      const fullAcEntry = efficiencyData.find(
        e => e.condition === 'full-ac' && e.scenario === scenario,
      );
      const ruleOnlyEntry = efficiencyData.find(
        e => e.condition === 'rule-only' && e.scenario === scenario,
      );

      if (fullAcEntry && ruleOnlyEntry) {
        const llmSavings = ruleOnlyEntry.efficiency.totalEvents > 0
          ? ((1 - fullAcEntry.efficiency.llmCallCount / fullAcEntry.efficiency.totalEvents) * 100).toFixed(1)
          : 'N/A';

        console.log(
          `  ${scenario}: ` +
          `full-ac made ${fullAcEntry.efficiency.llmCallCount} LLM calls ` +
          `(${fullAcEntry.efficiency.totalTokens} tokens) ` +
          `vs rule-only made ${ruleOnlyEntry.efficiency.llmCallCount} LLM calls ` +
          `(${ruleOnlyEntry.efficiency.totalTokens} tokens). ` +
          `Layer 1 filter rate for full-ac: ${(fullAcEntry.efficiency.layer1FilterRate * 100).toFixed(1)}%. ` +
          `LLM call reduction: ${llmSavings}%`,
        );
      }
    }

    // Wall-time comparison
    console.log('\n[RQ3] Wall-Time Comparison:');
    for (const scenario of scenarios) {
      for (const condition of conditions) {
        const entry = efficiencyData.find(
          e => e.condition === condition && e.scenario === scenario,
        );
        if (entry) {
          console.log(
            `  ${condition} / ${scenario}: ` +
            `${(entry.efficiency.totalWallTimeMs / 1000).toFixed(2)}s`,
          );
        }
      }
    }

    console.log(
      '\nExpectation: rule-only should be fastest (no LLM calls). ' +
      'full-ac should be faster than text-only because Layer 1 ' +
      'filters out events that do not require LLM assessment, ' +
      'reducing total LLM call volume.\n',
    );
  });
});
