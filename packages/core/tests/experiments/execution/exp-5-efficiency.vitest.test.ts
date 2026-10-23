/**
 * Experiment 5: Efficiency Analysis
 *
 * Quantifies the dual-layer architecture's efficiency contribution with
 * detailed metrics collection across three conditions. Focus on token usage,
 * wall time, Layer 1 filter rate, assessment time, and token efficiency
 * per decision.
 *
 * Scenario: apartment
 * Conditions: full-ac, rule-only, always-collaborate
 * Config: multiAgentEval: true, realisticRouting: true
 * N=3 iterations
 * Model: qwen3-14b-q4:latest
 *
 * Produces: Efficiency comparison table, filter metrics, type-wise breakdown,
 *           token efficiency per decision, Layer 1 vs Layer 2 analysis
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { ExperimentCondition } from '../infrastructure/types.js';
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

const CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'rule-only',
  'always-collaborate',
];

const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Efficiency analysis
// ---------------------------------------------------------------------------

function printEfficiencyAnalysis(): void {
  console.log('\n========================================');
  console.log('Experiment 5: Efficiency Analysis');
  console.log(`Scenario: ${SCENARIO} | Model: ${MODEL} | Iterations: ${ITERATIONS}`);
  console.log('========================================\n');

  const collector = new MetricsCollector(SCENARIOS[SCENARIO].zones);

  // --- Per-condition detailed metrics ---
  for (const condition of CONDITIONS) {
    const results = allResults.filter(r => r.config.condition === condition);
    if (results.length === 0) continue;

    console.log(`--- ${condition} ---`);

    for (const result of results) {
      const dq = result.decisionQuality;
      const eff = result.efficiency;
      const fm = collector.computeFilterMetrics(result.events, eff.totalTokens);

      console.log(`  Iteration ${result.iteration}:`);
      console.log(`    Total events: ${eff.totalEvents}`);
      console.log(`    Layer 1 filter rate: ${(eff.layer1FilterRate * 100).toFixed(1)}%`);
      console.log(`    Layer 1 handled: ${fm.layer1Handled}/${fm.totalEvents}`);
      console.log(`    Layer 1 precision: ${(fm.layer1Precision * 100).toFixed(1)}%`);
      console.log(`    Layer 1 false negative rate: ${(fm.layer1FalseNegativeRate * 100).toFixed(1)}%`);
      console.log(`    Layer 2 handled: ${fm.layer2Handled} (accuracy: ${(fm.layer2Accuracy * 100).toFixed(1)}%)`);
      console.log(`    LLM call count: ${eff.llmCallCount}`);
      console.log(`    Total tokens: ${eff.totalTokens} (prompt: ${eff.promptTokens}, completion: ${eff.completionTokens})`);
      console.log(`    Token savings rate: ${(fm.tokenSavingsRate * 100).toFixed(1)}%`);
      console.log(`    Estimated all-LLM tokens: ${fm.estimatedAllLlmTokens}`);
      console.log(`    Avg assessment time: ${eff.avgAssessmentTimeMs.toFixed(1)}ms`);
      console.log(`    Wall time: ${(eff.totalWallTimeMs / 1000).toFixed(1)}s`);
      console.log(`    Accuracy: ${(dq.meanCorrectDecisionRate * 100).toFixed(1)}%`);

      // Token efficiency per decision
      const correctDecisions = result.events.filter(e => e.correctDecision).length;
      const tokensPerCorrectDecision = correctDecisions > 0
        ? (eff.totalTokens / correctDecisions).toFixed(1)
        : 'N/A';
      const tokensPerDecision = result.events.length > 0
        ? (eff.totalTokens / result.events.length).toFixed(1)
        : 'N/A';

      console.log(`    Tokens per decision: ${tokensPerDecision}`);
      console.log(`    Tokens per correct decision: ${tokensPerCorrectDecision}`);
      console.log('');
    }

    // Aggregate across iterations
    const totalTokens = results.reduce((s, r) => s + r.efficiency.totalTokens, 0);
    const totalWallTime = results.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0);
    const avgAccuracy = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
    const avgFilterRate = results.reduce((s, r) => s + r.efficiency.layer1FilterRate, 0) / results.length;
    const avgAssessmentTime = results.reduce((s, r) => s + r.efficiency.avgAssessmentTimeMs, 0) / results.length;
    const totalCorrectDecisions = results.reduce(
      (s, r) => s + r.events.filter(e => e.correctDecision).length, 0,
    );
    const totalEvents = results.reduce((s, r) => s + r.events.length, 0);

    console.log(`  Aggregate (${results.length} iterations):`);
    console.log(`    Avg accuracy: ${(avgAccuracy * 100).toFixed(1)}%`);
    console.log(`    Avg Layer 1 filter rate: ${(avgFilterRate * 100).toFixed(1)}%`);
    console.log(`    Total tokens: ${totalTokens}`);
    console.log(`    Total wall time: ${(totalWallTime / 1000).toFixed(1)}s`);
    console.log(`    Avg assessment time: ${avgAssessmentTime.toFixed(1)}ms`);
    console.log(`    Tokens/decision: ${totalEvents > 0 ? (totalTokens / totalEvents).toFixed(1) : 'N/A'}`);
    console.log(`    Tokens/correct decision: ${totalCorrectDecisions > 0 ? (totalTokens / totalCorrectDecisions).toFixed(1) : 'N/A'}`);
    console.log('');
  }

  // --- Efficiency comparison table ---
  console.log('| Condition          | Accuracy | L1 Filter% | Tokens | Wall(s) | Assess(ms) | Tok/Decision | Tok/Correct | Token Savings |');
  console.log('|--------------------|----------|------------|--------|---------|------------|--------------|-------------|---------------|');

  for (const condition of CONDITIONS) {
    const results = allResults.filter(r => r.config.condition === condition);
    if (results.length === 0) continue;

    const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
    const avgFilter = results.reduce((s, r) => s + r.efficiency.layer1FilterRate, 0) / results.length;
    const totalTokens = results.reduce((s, r) => s + r.efficiency.totalTokens, 0);
    const totalWall = results.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0);
    const avgAssess = results.reduce((s, r) => s + r.efficiency.avgAssessmentTimeMs, 0) / results.length;
    const totalEvents = results.reduce((s, r) => s + r.events.length, 0);
    const totalCorrect = results.reduce((s, r) => s + r.events.filter(e => e.correctDecision).length, 0);

    const fm = collector.computeFilterMetrics(
      results.flatMap(r => r.events),
      totalTokens,
    );

    console.log(
      `| ${condition.padEnd(18)} | ` +
      `${(avgAcc * 100).toFixed(1).padStart(7)}% | ` +
      `${(avgFilter * 100).toFixed(1).padStart(9)}% | ` +
      `${totalTokens.toString().padStart(6)} | ` +
      `${(totalWall / 1000).toFixed(1).padStart(7)} | ` +
      `${avgAssess.toFixed(1).padStart(10)} | ` +
      `${totalEvents > 0 ? (totalTokens / totalEvents).toFixed(1).padStart(12) : 'N/A'.padStart(12)} | ` +
      `${totalCorrect > 0 ? (totalTokens / totalCorrect).toFixed(1).padStart(11) : 'N/A'.padStart(11)} | ` +
      `${(fm.tokenSavingsRate * 100).toFixed(1).padStart(12)}% |`,
    );
  }

  // --- Type-wise efficiency (full-ac only) ---
  const fullAcResults = allResults.filter(r => r.config.condition === 'full-ac');
  if (fullAcResults.length > 0) {
    console.log('\n--- Type-wise Metrics (full-ac) ---');
    const typeMetrics = collector.computeTypeWiseMetrics(fullAcResults.flatMap(r => r.events));
    for (const type of ['A', 'B', 'C', 'D', 'E'] as const) {
      const m = typeMetrics.byType?.[type];
      if (!m || m.support === 0) continue;
      console.log(
        `  Type ${type}: acc=${(m.decisionAccuracy * 100).toFixed(1)}% ` +
        `support=${m.support} F1=${(m.triggerF1 * 100).toFixed(1)}%`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 5: Efficiency Analysis', () => {
  afterAll(() => {
    printEfficiencyAnalysis();

    try {
      const savedPaths = savePilotResults(allResults, 'exp-5-efficiency');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'exp-5-efficiency-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} (efficiency, N=${ITERATIONS})`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `exp5-${condition}-${SCENARIO}`,
        name: `Exp 5 Efficiency: ${condition}`,
        rq: 'RQ3',
        scenario: SCENARIO,
        condition,
        iterations: ITERATIONS,
        llmModel: MODEL,
        timeoutMs: 120000,
        multiAgentEval: true,
      });
      config.realisticRouting = true;

      const runner = new PaperExperimentRunner(config);
      const results = await runner.run();

      expect(results).toHaveLength(ITERATIONS);

      for (const result of results) {
        expect(result.events.length).toBeGreaterThan(0);
        expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
        allResults.push(result);
      }

      // Incremental save: write CSV after each test case so data isn't lost if process hangs
      try {
        const csvPath = join(getResultsBaseDir(), 'exp-5-efficiency-summary.csv');
        exportResultsCSV(allResults, csvPath);
        console.log(`[Incremental] CSV saved (${allResults.length} results): ${csvPath}`);
      } catch (err) {
        console.error('[Incremental] Failed to save CSV:', err);
      }
    }, TIMEOUT);
  }
});
