/**
 * Experiment 9: 7B Model N=5 Re-run
 *
 * Re-runs Qwen2.5-7B with N=5 iterations for full-ac and oracle conditions
 * to provide more statistically robust results (original exp-7 had N=3).
 *
 * Results replace the 7B N=3 data in the multi-model table (tab:multimodel).
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { ExperimentCondition } from '../infrastructure/types.js';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import {
  savePilotResults,
  exportResultsCSV,
  getResultsBaseDir,
} from '../infrastructure/result-persistence.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL = 'qwen2.5-7b-q4:latest';
const SCENARIO = 'apartment';
const CONDITIONS: ExperimentCondition[] = ['full-ac', 'oracle'];
const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printResultsTable(): void {
  console.log('\n========================================');
  console.log('Experiment 9: 7B Model N=5');
  console.log(`Model: ${MODEL} | Scenario: ${SCENARIO} | Iterations: ${ITERATIONS}`);
  console.log('========================================\n');

  for (const condition of CONDITIONS) {
    const results = allResults.filter(r => r.config.condition === condition);
    if (results.length === 0) continue;

    console.log(`--- ${condition} ---`);
    for (const result of results) {
      const dq = result.decisionQuality;
      const eff = result.efficiency;
      console.log(
        `  Iteration ${result.iteration}: ` +
        `accuracy=${(dq.meanCorrectDecisionRate * 100).toFixed(1)}%, ` +
        `tokens=${eff.totalTokens}, ` +
        `wall=${(eff.totalWallTimeMs / 1000).toFixed(1)}s`,
      );
    }

    const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
    const avgTokens = results.reduce((s, r) => s + r.efficiency.totalTokens, 0) / results.length;
    const avgWall = results.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0) / results.length / 1000;
    console.log(`  Average: accuracy=${(avgAcc * 100).toFixed(1)}%, tokens=${avgTokens.toFixed(0)}, wall=${avgWall.toFixed(1)}s\n`);
  }

  // Distribution cost
  const fullAc = allResults.filter(r => r.config.condition === 'full-ac');
  const oracle = allResults.filter(r => r.config.condition === 'oracle');
  if (fullAc.length > 0 && oracle.length > 0) {
    const fullAcAcc = fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length;
    const oracleAcc = oracle.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / oracle.length;
    console.log(`Distribution cost: ${((oracleAcc - fullAcAcc) * 100).toFixed(1)}pp`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 9: 7B Model N=5', () => {
  afterAll(() => {
    printResultsTable();

    try {
      const savedPaths = savePilotResults(allResults, 'exp-9-7b-n5');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'exp-9-7b-n5-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} (7B N=5)`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `exp9-7b-${condition}-${SCENARIO}`,
        name: `Exp 9 7B N=5: ${condition}`,
        rq: 'RQ-M1',
        scenario: SCENARIO,
        condition,
        iterations: ITERATIONS,
        llmModel: MODEL,
        timeoutMs: 120000,
        multiAgentEval: true,
        realisticRouting: true,
      });

      const runner = new PaperExperimentRunner(config);
      const results = await runner.run();

      expect(results).toHaveLength(ITERATIONS);

      for (const result of results) {
        expect(result.events.length).toBeGreaterThan(0);
        expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);
        allResults.push(result);
      }

      // Incremental save after each condition
      try {
        const csvPath = join(getResultsBaseDir(), 'exp-9-7b-n5-summary.csv');
        exportResultsCSV(allResults, csvPath);
        console.log(`[Incremental] CSV saved (${allResults.length} results): ${csvPath}`);
      } catch (err) {
        console.error('[Incremental] Failed to save CSV:', err);
      }
    }, TIMEOUT);
  }
});
