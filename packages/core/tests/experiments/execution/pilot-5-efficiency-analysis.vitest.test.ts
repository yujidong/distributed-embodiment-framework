/**
 * Pilot 5: Efficiency Analysis — PAPER_DESIGN_V5 (Sprint P33)
 *
 * Quantifies the dual-layer architecture's efficiency contribution:
 * - Layer 1 filter rate (how many events bypass LLM)
 * - Token savings rate
 * - Accuracy vs. efficiency tradeoff
 *
 * Runs full-ac on apartment with detailed filter metrics collection.
 * Also runs a hypothetical "all-LLM" condition for comparison.
 *
 * Produces: Supplementary Table (Dual-Layer Efficiency), Fig 9 data
 */

import { describe, it, expect, afterAll } from 'vitest';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import { MetricsCollector } from '../infrastructure/metrics-collector.js';
import { SCENARIOS } from '../infrastructure/scenario-definitions.js';
import {
  savePilotResults,
  exportResultsCSV,
  getResultsBaseDir,
} from '../infrastructure/result-persistence.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCENARIO = 'apartment';
const ITERATIONS = 1;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Efficiency analysis
// ---------------------------------------------------------------------------

function printEfficiencyAnalysis(): void {
  console.log('\n========================================');
  console.log('Pilot 5: Efficiency Analysis');
  console.log(`Scenario: ${SCENARIO} | Model: ${MODEL}`);
  console.log('========================================\n');

  for (const result of allResults) {
    const condition = result.config.condition;
    const dq = result.decisionQuality;
    const eff = result.efficiency;

    console.log(`--- ${condition} ---`);
    console.log(`  Total events evaluated: ${eff.totalEvents}`);
    console.log(`  Layer 1 filter rate: ${(eff.layer1FilterRate * 100).toFixed(1)}%`);
    console.log(`  LLM call count: ${eff.llmCallCount}`);
    console.log(`  Total tokens: ${eff.totalTokens}`);
    console.log(`  Avg assessment time: ${eff.avgAssessmentTimeMs.toFixed(1)}ms`);
    console.log(`  Wall time: ${(eff.totalWallTimeMs / 1000).toFixed(1)}s`);
    console.log(`  Accuracy: ${(dq.meanCorrectDecisionRate * 100).toFixed(1)}%`);

    // Compute filter metrics using MetricsCollector
    const collector = new MetricsCollector(SCENARIOS[SCENARIO].zones);
    const filterMetrics = collector.computeFilterMetrics(result.events, eff.totalTokens);

    console.log(`\n  --- Filter Metrics ---`);
    console.log(`  Layer 1 handled: ${filterMetrics.layer1Handled}/${filterMetrics.totalEvents} (${(filterMetrics.layer1FilterRate * 100).toFixed(1)}%)`);
    console.log(`  Layer 1 precision: ${(filterMetrics.layer1Precision * 100).toFixed(1)}%`);
    console.log(`  Layer 1 false negative rate: ${(filterMetrics.layer1FalseNegativeRate * 100).toFixed(1)}%`);
    console.log(`  Layer 2 handled: ${filterMetrics.layer2Handled}`);
    console.log(`  Layer 2 accuracy: ${(filterMetrics.layer2Accuracy * 100).toFixed(1)}%`);
    console.log(`  Token savings rate: ${(filterMetrics.tokenSavingsRate * 100).toFixed(1)}%`);
    console.log(`  Actual tokens: ${filterMetrics.actualTokens}`);
    console.log(`  Estimated all-LLM tokens: ${filterMetrics.estimatedAllLlmTokens}`);

    // Type-wise breakdown
    const typeMetrics = collector.computeTypeWiseMetrics(result.events);
    console.log(`\n  --- Type-wise ---`);
    for (const type of ['A', 'B', 'C', 'D', 'E'] as const) {
      const m = typeMetrics.byType?.[type];
      if (!m || m.support === 0) continue;
      console.log(
        `    Type ${type}: acc=${(m.decisionAccuracy * 100).toFixed(1)}% ` +
        `support=${m.support} F1=${(m.triggerF1 * 100).toFixed(1)}%`,
      );
    }
  }

  // Efficiency-Quality tradeoff summary
  console.log('\n--- Efficiency-Quality Tradeoff ---');
  console.log('| Condition | Accuracy | L1 Filter% | Tokens | Wall(s) | Token Savings |');
  console.log('|-----------|----------|------------|--------|---------|---------------|');
  for (const result of allResults) {
    const collector = new MetricsCollector(SCENARIOS[SCENARIO].zones);
    const fm = collector.computeFilterMetrics(result.events, result.efficiency.totalTokens);
    console.log(
      `| ${(result.config.condition as string).padEnd(9)} | ` +
      `${(result.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1).padStart(6)}% | ` +
      `${(fm.layer1FilterRate * 100).toFixed(1).padStart(9)}% | ` +
      `${fm.actualTokens.toString().padStart(6)} | ` +
      `${(result.efficiency.totalWallTimeMs / 1000).toFixed(1).padStart(7)} | ` +
      `${(fm.tokenSavingsRate * 100).toFixed(1).padStart(12)}% |`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip('LEGACY: Pilot 5: Efficiency Analysis', () => {
  afterAll(() => {
    printEfficiencyAnalysis();

    try {
      const savedPaths = savePilotResults(allResults, 'pilot-5-efficiency');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'pilot-5-efficiency-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  // Run full-ac with detailed metrics
  it(`full-ac / ${SCENARIO} (detailed efficiency)`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `pilot5-full-ac-${SCENARIO}`,
      name: `Pilot 5 Efficiency: full-ac`,
      rq: 'RQ2',
      scenario: SCENARIO,
      condition: 'full-ac',
      iterations: ITERATIONS,
      llmModel: MODEL,
      timeoutMs: 120000,
      multiAgentEval: true,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    expect(results).toHaveLength(ITERATIONS);

    for (const result of results) {
      expect(result.events.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
      allResults.push(result);
    }
  }, TIMEOUT);

  // Run rule-only for comparison
  it(`rule-only / ${SCENARIO} (efficiency baseline)`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `pilot5-rule-only-${SCENARIO}`,
      name: `Pilot 5 Efficiency: rule-only`,
      rq: 'RQ2',
      scenario: SCENARIO,
      condition: 'rule-only',
      iterations: ITERATIONS,
      llmModel: MODEL,
      timeoutMs: 120000,
      multiAgentEval: true,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    expect(results).toHaveLength(ITERATIONS);

    for (const result of results) {
      expect(result.events.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
      allResults.push(result);
    }
  }, TIMEOUT);

  // Run always-collaborate to see "all-LLM" cost
  it(`always-collaborate / ${SCENARIO} (all-LLM cost)`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `pilot5-always-collaborate-${SCENARIO}`,
      name: `Pilot 5 Efficiency: always-collaborate`,
      rq: 'RQ2',
      scenario: SCENARIO,
      condition: 'always-collaborate',
      iterations: ITERATIONS,
      llmModel: MODEL,
      timeoutMs: 120000,
      multiAgentEval: true,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    expect(results).toHaveLength(ITERATIONS);

    for (const result of results) {
      expect(result.events.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
      allResults.push(result);
    }
  }, TIMEOUT);
});
