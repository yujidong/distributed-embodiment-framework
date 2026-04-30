/**
 * Pilot 1: RQ1 Paradigm Validation — PAPER_DESIGN_V5 (Sprint P33)
 *
 * Answers: "Is the Distributed Embodiment paradigm viable?"
 *
 * Runs 6 conditions on apartment (multiAgentEval=true, N=3 iterations):
 *   - full-ac: Complete system
 *   - always-collaborate: Naive baseline (always initiate_ac)
 *   - never-collaborate: Naive baseline (always handle_independently)
 *   - random-planner: Random baseline
 *   - rule-only: Strongest non-LLM baseline
 *   - oracle: Theoretical upper bound (perfect info, same capabilities)
 *
 * Decision point:
 *   If full-ac >> baselines → RQ1 confirmed, proceed to RQ2
 *   If not → analyze reasoning traces, diagnose issue
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { ExperimentCondition, PaperExperimentConfig } from '../infrastructure/types.js';
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

const CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'always-collaborate',
  'never-collaborate',
  'random-planner',
  'rule-only',
  'oracle',
];

const SCENARIO = 'apartment';
const ITERATIONS = 1; // 1 iteration per condition for pilot; increase for final runs
const TIMEOUT = 5400000; // 90 minutes per test (multi-agent LLM calls are slow)
const MODEL = 'qwen3-14b-q4:latest';

// Accumulator for all results
const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: print comparison table
// ---------------------------------------------------------------------------

function printComparisonTable(): void {
  console.log('\n========================================');
  console.log('Pilot 1: RQ1 Paradigm Validation');
  console.log(`Scenario: ${SCENARIO} | Iterations: ${ITERATIONS} | Model: ${MODEL}`);
  console.log('========================================\n');

  console.log('| Condition         | Accuracy | Macro F1 | AC-F1  | Tokens  | Wall(s) |');
  console.log('|-------------------|----------|----------|--------|---------|---------|');

  for (const condition of CONDITIONS) {
    const conditionResults = allResults.filter(r => r.config.condition === condition);
    if (conditionResults.length === 0) continue;

    const avgAccuracy = conditionResults.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / conditionResults.length;
    const avgMacroF1 = conditionResults.reduce((s, r) => s + (r.classification?.macroF1 ?? 0), 0) / conditionResults.length;
    const avgACF1 = conditionResults.reduce((s, r) => s + (r.classification?.collaborationTriggerF1.f1 ?? 0), 0) / conditionResults.length;
    const avgTokens = conditionResults.reduce((s, r) => s + r.efficiency.totalTokens, 0) / conditionResults.length;
    const avgWall = conditionResults.reduce((s, r) => s + r.efficiency.totalWallTimeMs, 0) / conditionResults.length / 1000;

    console.log(
      `| ${condition.padEnd(17)} | ${(avgAccuracy * 100).toFixed(1).padStart(6)}% | ` +
      `${(avgMacroF1 * 100).toFixed(1).padStart(6)}% | ` +
      `${(avgACF1 * 100).toFixed(1).padStart(4)}% | ` +
      `${avgTokens.toFixed(0).padStart(7)} | ` +
      `${avgWall.toFixed(1).padStart(7)} |`,
    );
  }

  // Key comparisons
  const fullAc = allResults.filter(r => r.config.condition === 'full-ac');
  const ruleOnly = allResults.filter(r => r.config.condition === 'rule-only');
  const alwaysCollab = allResults.filter(r => r.config.condition === 'always-collaborate');

  if (fullAc.length > 0) {
    const fullAcc = fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length;
    console.log(`\n--- Key Findings ---`);
    console.log(`  full-ac accuracy: ${(fullAcc * 100).toFixed(1)}%`);

    if (ruleOnly.length > 0) {
      const ruleAcc = ruleOnly.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / ruleOnly.length;
      console.log(`  rule-only accuracy: ${(ruleAcc * 100).toFixed(1)}%`);
      console.log(`  LLM value (full-ac - rule-only): ${((fullAcc - ruleAcc) * 100).toFixed(1)}pp`);
    }

    if (alwaysCollab.length > 0) {
      const alwaysAcc = alwaysCollab.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / alwaysCollab.length;
      console.log(`  always-collaborate accuracy: ${(alwaysAcc * 100).toFixed(1)}%`);
      console.log(`  full-ac advantage: ${((fullAcc - alwaysAcc) * 100).toFixed(1)}pp`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip('LEGACY: Pilot 1: RQ1 Paradigm Validation', () => {
  afterAll(() => {
    printComparisonTable();

    // Save results
    try {
      const savedPaths = savePilotResults(allResults, 'pilot-1-rq1-paradigm');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      // Export CSV
      const csvPath = join(getResultsBaseDir(), 'pilot-1-rq1-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} × ${ITERATIONS} iterations`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `pilot1-${condition}-${SCENARIO}`,
        name: `Pilot 1 RQ1: ${condition}`,
        rq: 'RQ1',
        scenario: SCENARIO,
        condition,
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
  }
});
