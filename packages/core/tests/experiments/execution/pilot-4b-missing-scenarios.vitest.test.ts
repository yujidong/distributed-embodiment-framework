/**
 * Pilot 4b: Run missing scenarios (single-room, campus)
 *
 * These scenarios were missing from the initial Pilot 4 run due to
 * incorrect scenario names (office/warehouse instead of campus/single-room).
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

const MISSING_SCENARIOS: ScenarioType[] = [
  'single-room',
  'campus',
];

const ITERATIONS = 1;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skip('LEGACY: Pilot 4b: Missing Scenarios', () => {
  afterAll(() => {
    console.log('\n========================================');
    console.log('Pilot 4b: Missing Scenarios Results');
    console.log(`Model: ${MODEL} | Iterations: ${ITERATIONS}`);
    console.log('========================================\n');

    // Distribution cost table
    console.log('| Scenario    | Oracle  | Full-AC | Rule-Only | Distribution Cost |');
    console.log('|-------------|---------|---------|-----------|-------------------|');

    for (const scenario of MISSING_SCENARIOS) {
      const row: string[] = [scenario.padEnd(11)];

      let oracleAcc = 0;
      let fullAcAcc = 0;

      for (const condition of CONDITIONS) {
        const results = allResults.filter(
          r => r.config.scenario === scenario && r.config.condition === condition,
        );
        if (results.length === 0) {
          row.push('N/A'.padStart(5));
          continue;
        }

        const avgAcc = results.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / results.length;
        row.push(`${(avgAcc * 100).toFixed(1)}%`.padStart(5));

        if (condition === 'oracle') oracleAcc = avgAcc;
        if (condition === 'full-ac') fullAcAcc = avgAcc;
      }

      const distCost = oracleAcc > 0 ? ((oracleAcc - fullAcAcc) * 100).toFixed(1) + 'pp' : 'N/A';
      row.push(distCost.padStart(9));

      console.log(`| ${row.join(' | ')} |`);
    }

    // Type distribution
    console.log('\n--- Type Distribution (full-ac) ---');
    const types = ['A', 'B', 'C', 'D', 'E'] as const;
    for (const scenario of MISSING_SCENARIOS) {
      const fullAc = allResults.filter(
        r => r.config.scenario === scenario && r.config.condition === 'full-ac',
      );
      if (fullAc.length === 0) continue;

      const allEvents = fullAc.flatMap(r => r.events);
      const typeCounts = types.map(t => {
        const tc = allEvents.filter(e => e.interactionType === t);
        const acc = tc.length > 0 ? (tc.filter(e => e.correctDecision).length / tc.length * 100).toFixed(0) : '-';
        return `${t}:${tc.length}(${acc}%)`;
      });
      console.log(`  ${scenario}: ${typeCounts.join(', ')} (total: ${allEvents.length})`);
    }

    try {
      const savedPaths = savePilotResults(allResults, 'pilot-4b-missing-scenarios');
      console.log(`\nResults saved to ${savedPaths.length} files`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const scenario of MISSING_SCENARIOS) {
    for (const condition of CONDITIONS) {
      it(`${condition} / ${scenario}`, async () => {
        const config = PaperExperimentRunner.createConfig({
          id: `pilot4b-${condition}-${scenario}`,
          name: `Pilot 4b: ${condition} ${scenario}`,
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
