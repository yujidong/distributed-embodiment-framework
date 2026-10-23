/**
 * Pilot 4: RQ3 Distribution Cost + Cross-Scenario — PAPER_DESIGN_V5 (Sprint P33)
 *
 * Answers: "What is the cost of distributed autonomous collaboration?"
 *
 * Runs 3 key conditions (oracle, full-ac, rule-only) across all 6 scenarios
 * to quantify the "cost of distribution" and validate cross-scenario robustness.
 *
 * Produces: Table 6 (Distribution Cost), Fig 6 data (Cost vs Physical Complexity)
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
  saveCrossScenarioResult,
} from '../infrastructure/result-persistence.js';
import { CrossScenarioRunner } from '../infrastructure/cross-scenario-runner.js';
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

const ITERATIONS = 1;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Distribution cost analysis
// ---------------------------------------------------------------------------

function printDistributionCost(): void {
  console.log('\n========================================');
  console.log('Pilot 4: RQ3 Distribution Cost');
  console.log(`Model: ${MODEL} | Iterations: ${ITERATIONS}`);
  console.log('========================================\n');

  // Table 6: Distribution Cost across Scenarios
  console.log('| Scenario       | Oracle | Full-AC | Rule-Only | Distribution Cost |');
  console.log('|----------------|--------|---------|-----------|-------------------|');

  for (const scenario of SCENARIOS_LIST) {
    const row: string[] = [scenario.padEnd(14)];

    let oracleAcc = 0;
    let fullAcAcc = 0;
    let ruleOnlyAcc = 0;

    for (const condition of CONDITIONS) {
      const results = allResults.filter(
        r => r.config.scenario === scenario && r.config.condition === condition,
      );
      if (results.length === 0) {
        row.push('N/A'.padStart(6));
        continue;
      }

      const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
      row.push(`${(avgAcc * 100).toFixed(1)}%`.padStart(6));

      if (condition === 'oracle') oracleAcc = avgAcc;
      if (condition === 'full-ac') fullAcAcc = avgAcc;
      if (condition === 'rule-only') ruleOnlyAcc = avgAcc;
    }

    // Distribution cost = oracle - full-ac
    const distCost = oracleAcc > 0 ? ((oracleAcc - fullAcAcc) * 100).toFixed(1) + 'pp' : 'N/A';
    row.push(distCost.padStart(8));

    console.log(`| ${row.join(' | ')} |`);
  }

  // Physical complexity analysis
  console.log('\n--- Physical Complexity vs Performance ---');
  for (const scenario of SCENARIOS_LIST) {
    const fullAc = allResults.filter(
      r => r.config.scenario === scenario && r.config.condition === 'full-ac',
    );
    if (fullAc.length === 0) continue;

    const scenarioDef = SCENARIOS[scenario];
    const avgAcc = fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length;

    console.log(
      `  ${scenario}: zones=${scenarioDef.zones.length}, ` +
      `agents=${scenarioDef.agents.length}, ` +
      `events=${scenarioDef.events.length}, ` +
      `accuracy=${(avgAcc * 100).toFixed(1)}%`,
    );
  }

  // Type distribution across scenarios
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
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip('LEGACY: Pilot 4: RQ3 Distribution Cost', () => {
  afterAll(() => {
    printDistributionCost();

    try {
      const savedPaths = savePilotResults(allResults, 'pilot-4-cross-scenario');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'pilot-4-cross-scenario-summary.csv');
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
          id: `pilot4-${condition}-${scenario}`,
          name: `Pilot 4 RQ3: ${condition} ${scenario}`,
          rq: 'RQ3',
          scenario,
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
  }
});
