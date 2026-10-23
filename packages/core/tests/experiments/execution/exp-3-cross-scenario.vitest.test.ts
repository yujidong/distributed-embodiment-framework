/**
 * Experiment 3: RQ3 Cross-Scenario Robustness
 *
 * Validates that the Active Collaboration framework performs robustly across
 * all 6 physical scenarios (single-room through smart-city). Runs oracle,
 * full-ac, and rule-only conditions to quantify cross-scenario generalization
 * and distribution cost.
 *
 * Scenarios: single-room, apartment, campus, hospital, factory, smart-city
 * Conditions: oracle, full-ac, rule-only
 * Config: multiAgentEval: true, realisticRouting: true
 * N=1 iteration per scenario (18 total condition-scenario pairs)
 * Model: qwen3-14b-q4:latest
 *
 * Produces: Cross-scenario comparison table (accuracy by scenario)
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { ExperimentCondition, ScenarioType } from '../infrastructure/types.js';
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

const CONDITIONS: ExperimentCondition[] = [
  'oracle',
  'full-ac',
  'rule-only',
];

const SCENARIOS_LIST: ScenarioType[] = [
  'single-room',
  'apartment',
  'campus',
  'hospital',
  'factory',
  'smart-city',
];

const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Cross-scenario comparison table
// ---------------------------------------------------------------------------

function printCrossScenarioComparison(): void {
  console.log('\n========================================');
  console.log('Experiment 3: RQ3 Cross-Scenario Robustness');
  console.log(`Model: ${MODEL} | Iterations: ${ITERATIONS}`);
  console.log('========================================\n');

  // Main comparison table: accuracy by scenario
  console.log('| Scenario       | Oracle  | Full-AC | Rule-Only | Dist. Cost |');
  console.log('|----------------|---------|---------|-----------|------------|');

  for (const scenario of SCENARIOS_LIST) {
    const row: string[] = [scenario.padEnd(14)];

    let oracleAcc = 0;
    let fullAcAcc = 0;

    for (const condition of CONDITIONS) {
      const results = allResults.filter(
        r => r.config.scenario === scenario && r.config.condition === condition,
      );
      if (results.length === 0) {
        row.push('N/A'.padStart(7));
        continue;
      }

      const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
      row.push(`${(avgAcc * 100).toFixed(1)}%`.padStart(7));

      if (condition === 'oracle') oracleAcc = avgAcc;
      if (condition === 'full-ac') fullAcAcc = avgAcc;
    }

    // Distribution cost = oracle accuracy - full-ac accuracy
    const distCost = oracleAcc > 0 && fullAcAcc > 0
      ? ((oracleAcc - fullAcAcc) * 100).toFixed(1) + 'pp'
      : 'N/A';
    row.push(distCost.padStart(10));

    console.log(`| ${row.join(' | ')} |`);
  }

  // Scenario complexity summary
  console.log('\n--- Scenario Complexity Summary ---');
  for (const scenario of SCENARIOS_LIST) {
    const scenarioDef = SCENARIOS[scenario];
    const fullAc = allResults.filter(
      r => r.config.scenario === scenario && r.config.condition === 'full-ac',
    );
    const avgAcc = fullAc.length > 0
      ? fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length
      : NaN;

    console.log(
      `  ${scenario}: zones=${scenarioDef.zones.length}, ` +
      `agents=${scenarioDef.agents.length}, ` +
      `events=${scenarioDef.events.length}, ` +
      `full-ac accuracy=${isNaN(avgAcc) ? 'N/A' : (avgAcc * 100).toFixed(1) + '%'}`,
    );
  }

  // Type distribution per scenario (full-ac only)
  console.log('\n--- Type Distribution (full-ac) ---');
  const types = ['A', 'B', 'C', 'D', 'E'] as const;
  for (const scenario of SCENARIOS_LIST) {
    const fullAc = allResults.filter(
      r => r.config.scenario === scenario && r.config.condition === 'full-ac',
    );
    if (fullAc.length === 0) continue;

    const allEvents = fullAc.flatMap(r => r.events);
    const typeCounts = types.map(t => {
      const tc = allEvents.filter(e => e.interactionType === t).length;
      return `${t}:${tc}`;
    });
    console.log(`  ${scenario}: ${typeCounts.join(', ')} (total: ${allEvents.length})`);
  }

  // Cross-scenario robustness: standard deviation of full-ac accuracy
  const fullAcAccuracies: number[] = [];
  for (const scenario of SCENARIOS_LIST) {
    const fullAc = allResults.filter(
      r => r.config.scenario === scenario && r.config.condition === 'full-ac',
    );
    if (fullAc.length > 0) {
      const avg = fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length;
      fullAcAccuracies.push(avg);
    }
  }
  if (fullAcAccuracies.length > 1) {
    const mean = fullAcAccuracies.reduce((a, b) => a + b, 0) / fullAcAccuracies.length;
    const variance = fullAcAccuracies.reduce((s, v) => s + (v - mean) ** 2, 0) / fullAcAccuracies.length;
    const stdDev = Math.sqrt(variance);
    console.log(`\n--- Cross-Scenario Robustness (full-ac) ---`);
    console.log(`  Mean accuracy: ${(mean * 100).toFixed(1)}%`);
    console.log(`  Std deviation: ${(stdDev * 100).toFixed(1)}pp`);
    console.log(`  Min: ${(Math.min(...fullAcAccuracies) * 100).toFixed(1)}%, Max: ${(Math.max(...fullAcAccuracies) * 100).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 3: RQ3 Cross-Scenario Robustness', () => {
  afterAll(() => {
    printCrossScenarioComparison();

    try {
      const savedPaths = savePilotResults(allResults, 'exp-3-cross-scenario');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'exp-3-cross-scenario-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const scenario of SCENARIOS_LIST) {
    for (const condition of CONDITIONS) {
      it(`${condition} / ${scenario}`, async () => {
        const config = PaperExperimentRunner.createConfig({
          id: `exp3-${condition}-${scenario}`,
          name: `Exp 3 RQ3: ${condition} ${scenario}`,
          rq: 'RQ3',
          scenario,
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
          const csvPath = join(getResultsBaseDir(), 'exp-3-cross-scenario-summary.csv');
          exportResultsCSV(allResults, csvPath);
          console.log(`[Incremental] CSV saved (${allResults.length} results): ${csvPath}`);
        } catch (err) {
          console.error('[Incremental] Failed to save CSV:', err);
        }
      }, TIMEOUT);
    }
  }
});
