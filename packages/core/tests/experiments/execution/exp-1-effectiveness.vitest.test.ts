/**
 * Experiment 1: RQ1 System Effectiveness — PAPER_DESIGN_V5
 *
 * Answers: "How effective is the Active Collaboration system compared to
 * baselines under realistic event routing?"
 *
 * Runs 5 conditions on apartment (multiAgentEval=true, realisticRouting=true, N=3):
 *   - full-ac: Complete system
 *   - always-collaborate: Naive baseline (always initiate_ac)
 *   - never-collaborate: Naive baseline (always handle_independently)
 *   - rule-only: Strongest non-LLM baseline
 *   - oracle: Theoretical upper bound (perfect info, same capabilities)
 *
 * Key differences from pilot:
 *   - realisticRouting: true (routes device-originated events to managing agents only)
 *   - N=3 iterations per condition (was 1 in pilots)
 *   - Type-wise breakdown table including Non-D accuracy
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { ExperimentCondition, PaperExperimentConfig, AgentEventType } from '../infrastructure/types.js';
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
  'rule-only',
  'oracle',
];

const SCENARIO = 'apartment';
const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test (multi-agent LLM calls are slow)
const MODEL = 'qwen3-14b-q4:latest';

// Accumulator for all results
const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: print comparison table
// ---------------------------------------------------------------------------

function printComparisonTable(): void {
  console.log('\n========================================');
  console.log('Experiment 1: RQ1 System Effectiveness');
  console.log(`Scenario: ${SCENARIO} | Iterations: ${ITERATIONS} | Model: ${MODEL}`);
  console.log(`realisticRouting: true | multiAgentEval: true`);
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

  // Type-wise breakdown including Non-D accuracy
  console.log('\n--- Type-wise Breakdown ---');
  console.log('| Condition         | Type A | Type B | Type C | Type D (Non-D Acc) | Type E |');
  console.log('|-------------------|--------|--------|--------|--------------------|--------|');

  const interactionTypes: AgentEventType[] = ['A', 'B', 'C', 'D', 'E'];

  for (const condition of CONDITIONS) {
    const conditionResults = allResults.filter(r => r.config.condition === condition);
    if (conditionResults.length === 0) continue;

    // Collect all events across iterations for this condition
    const allEvents = conditionResults.flatMap(r => r.events);
    const typeAccuracies: string[] = [];

    for (const type of interactionTypes) {
      const typeEvents = allEvents.filter(e => e.interactionType === type);
      if (typeEvents.length === 0) {
        typeAccuracies.push('  N/A ');
      } else {
        const acc = typeEvents.filter(e => e.correctDecision).length / typeEvents.length;
        typeAccuracies.push(`${(acc * 100).toFixed(1).padStart(5)}%`);
      }
    }

    // Non-D accuracy: accuracy on all types except D (i.e., types where agent has some relevance)
    const nonDEvents = allEvents.filter(e => e.interactionType !== 'D');
    const nonDAcc = nonDEvents.length > 0
      ? nonDEvents.filter(e => e.correctDecision).length / nonDEvents.length
      : 0;
    typeAccuracies[3] += ` (${(nonDAcc * 100).toFixed(1).padStart(5)}%)`;

    console.log(
      `| ${condition.padEnd(17)} | ${typeAccuracies[0]} | ${typeAccuracies[1]} | ${typeAccuracies[2]} | ${typeAccuracies[3].padStart(18)} | ${typeAccuracies[4]} |`,
    );
  }

  // Key comparisons
  const fullAc = allResults.filter(r => r.config.condition === 'full-ac');
  const ruleOnly = allResults.filter(r => r.config.condition === 'rule-only');
  const alwaysCollab = allResults.filter(r => r.config.condition === 'always-collaborate');
  const neverCollab = allResults.filter(r => r.config.condition === 'never-collaborate');
  const oracle = allResults.filter(r => r.config.condition === 'oracle');

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

    if (neverCollab.length > 0) {
      const neverAcc = neverCollab.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / neverCollab.length;
      console.log(`  never-collaborate accuracy: ${(neverAcc * 100).toFixed(1)}%`);
      console.log(`  collaboration value (full-ac - never-collaborate): ${((fullAcc - neverAcc) * 100).toFixed(1)}pp`);
    }

    if (oracle.length > 0) {
      const oracleAcc = oracle.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / oracle.length;
      console.log(`  oracle accuracy: ${(oracleAcc * 100).toFixed(1)}%`);
      console.log(`  gap to oracle: ${((oracleAcc - fullAcc) * 100).toFixed(1)}pp`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 1: RQ1 System Effectiveness', () => {
  afterAll(() => {
    printComparisonTable();

    // Save results
    try {
      const savedPaths = savePilotResults(allResults, 'exp-1-rq1-effectiveness');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      // Export CSV
      const csvPath = join(getResultsBaseDir(), 'exp-1-rq1-effectiveness-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} x ${ITERATIONS} iterations`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `exp1-${condition}-${SCENARIO}`,
        name: `Exp 1 RQ1 Effectiveness: ${condition}`,
        rq: 'RQ1',
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
    }, TIMEOUT);
  }
});
