/**
 * Experiment 8: Layer 1 Validation
 *
 * Validates that Layer 1 (rule-based event classifier) correctly:
 *   1. Filters noise events (routine sensor readings with low severity)
 *   2. Passes interesting events through to Layer 2 (LLM assessment)
 *   3. Maintains decision accuracy comparable to full-ac control
 *   4. Reduces token consumption proportionally to noise ratio
 *
 * Two conditions compared:
 *   - 'layer1-enabled': Layer 1 active with severity-escalation classifier + noise injection
 *   - 'full-ac':        Layer 1 disabled (control baseline)
 *
 * The layer1-enabled condition injects 2 noise events per zone (in zones other
 * than the interesting event's zone) before each interesting event. This simulates
 * realistic IoT environments where devices generate frequent routine readings.
 *
 * Key metrics:
 *   - Noise Filter Rate: % of injected noise events filtered by Layer 1
 *   - Decision Accuracy: accuracy on interesting events (should match control)
 *   - Token Savings: reduction in total tokens vs control
 *   - Layer 1 Filter Rate: overall filter rate including both noise and interesting events
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
  'layer1-enabled',  // Layer 1 active with noise injection
  'full-ac',         // Control: Layer 1 disabled
];

const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Layer 1 validation analysis
// ---------------------------------------------------------------------------

function printLayer1ValidationTable(): {
  noiseFilterRate: number;
  accuracyRetention: number;
  tokenSavings: number;
} {
  console.log('\n========================================');
  console.log('Experiment 8: Layer 1 Validation');
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
      const noiseStats = result.rawDualTriggerStats as Record<string, unknown>;

      console.log(`  Iteration ${result.iteration}:`);
      console.log(`    Total events: ${eff.totalEvents}`);
      console.log(`    Accuracy: ${(dq.meanCorrectDecisionRate * 100).toFixed(1)}%`);
      console.log(`    Layer 1 filter rate: ${(eff.layer1FilterRate * 100).toFixed(1)}%`);
      console.log(`    LLM call count: ${eff.llmCallCount}`);
      console.log(`    Total tokens: ${eff.totalTokens}`);
      console.log(`    Wall time: ${(eff.totalWallTimeMs / 1000).toFixed(1)}s`);

      if (condition === 'layer1-enabled') {
        const injected = noiseStats.noiseEventsInjected as number ?? 0;
        const clustersTotal = noiseStats.noiseClustersTotal as number ?? 0;
        const clustersFiltered = noiseStats.noiseClustersFiltered as number ?? 0;
        const noiseRate = noiseStats.noiseFilterRate as number ?? 0;
        console.log(`    Noise events injected: ${injected}`);
        console.log(`    Noise clusters: ${clustersFiltered}/${clustersTotal} filtered`);
        console.log(`    Noise cluster filter rate: ${(noiseRate * 100).toFixed(1)}%`);
      }
      console.log('');
    }
  }

  // --- Comparison table ---
  console.log('| Condition       | Accuracy | Noise Filter% | L1 Filter% | Tokens | Wall(s) | LLM Calls |');
  console.log('|-----------------|----------|---------------|------------|--------|---------|-----------|');

  let noiseFilterRate = 0;
  let accuracyRetention = 0;
  let tokenSavings = 0;

  const fullAcResults = allResults.filter(r => r.config.condition === 'full-ac');
  const l1Results = allResults.filter(r => r.config.condition === 'layer1-enabled');

  for (const condition of CONDITIONS) {
    const results = allResults.filter(r => r.config.condition === condition);
    if (results.length === 0) continue;

    const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
    const totalTokens = results.reduce((s, r) => s + r.efficiency.totalTokens, 0);
    const totalWall = results.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0);
    const avgFilter = results.reduce((s, r) => s + r.efficiency.layer1FilterRate, 0) / results.length;
    const totalLLMCalls = results.reduce((s, r) => s + r.efficiency.llmCallCount, 0);

    let noiseFilterStr = 'N/A';
    if (condition === 'layer1-enabled') {
      const avgNoiseFilter = results.reduce((s, r) => {
        const noiseRate = (r.rawDualTriggerStats as Record<string, unknown>).noiseFilterRate as number ?? 0;
        return s + noiseRate;
      }, 0) / results.length;
      noiseFilterStr = `${(avgNoiseFilter * 100).toFixed(1)}%`;
      noiseFilterRate = avgNoiseFilter;
    }

    console.log(
      `| ${condition.padEnd(15)} | ` +
      `${(avgAcc * 100).toFixed(1).padStart(7)}% | ` +
      `${noiseFilterStr.padStart(13)} | ` +
      `${(avgFilter * 100).toFixed(1).padStart(9)}% | ` +
      `${totalTokens.toString().padStart(6)} | ` +
      `${(totalWall / 1000).toFixed(1).padStart(7)} | ` +
      `${totalLLMCalls.toString().padStart(9)} |`,
    );
  }

  // Compute comparison metrics
  if (fullAcResults.length > 0 && l1Results.length > 0) {
    const fullAcAcc = fullAcResults.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAcResults.length;
    const l1Acc = l1Results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / l1Results.length;
    accuracyRetention = l1Acc / fullAcAcc; // Should be close to 1.0

    const fullAcTokens = fullAcResults.reduce((s, r) => s + r.efficiency.totalTokens, 0);
    const l1Tokens = l1Results.reduce((s, r) => s + r.efficiency.totalTokens, 0);
    tokenSavings = fullAcTokens > 0 ? 1 - (l1Tokens / fullAcTokens) : 0;

    console.log('\n--- Comparison ---');
    console.log(`  Accuracy retention: ${(accuracyRetention * 100).toFixed(1)}% (L1/Control)`);
    console.log(`  Token savings: ${(tokenSavings * 100).toFixed(1)}%`);
    console.log(`  Noise filter rate: ${(noiseFilterRate * 100).toFixed(1)}%`);
  }

  return { noiseFilterRate, accuracyRetention, tokenSavings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 8: Layer 1 Validation', () => {
  afterAll(() => {
    printLayer1ValidationTable();

    try {
      const savedPaths = savePilotResults(allResults, 'exp-8-layer1-validation');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'exp-8-layer1-validation-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} (Layer 1 validation, N=${ITERATIONS})`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `exp8-${condition}-${SCENARIO}`,
        name: `Exp 8 Layer 1 Validation: ${condition}`,
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

        // Layer 1 specific assertions
        if (condition === 'layer1-enabled') {
          const noiseStats = result.rawDualTriggerStats as Record<string, unknown>;
          console.log(
            `[Exp 8 L1] accuracy=${(result.decisionQuality.meanCorrectDecisionRate * 100).toFixed(1)}%, ` +
            `clusters=${noiseStats.noiseClustersFiltered}/${noiseStats.noiseClustersTotal}, ` +
            `events=${noiseStats.noiseEventsInjected}, ` +
            `tokens=${result.efficiency.totalTokens}`,
          );
        }

        allResults.push(result);
      }

      // Incremental save after each condition
      try {
        const csvPath = join(getResultsBaseDir(), 'exp-8-layer1-validation-summary.csv');
        exportResultsCSV(allResults, csvPath);
        console.log(`[Incremental] CSV saved (${allResults.length} results): ${csvPath}`);
      } catch (err) {
        console.error('[Incremental] Failed to save CSV:', err);
      }
    }, TIMEOUT);
  }
});
