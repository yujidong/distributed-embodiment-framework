/**
 * Pilot 2: RQ2 Mechanism Analysis — PAPER_DESIGN_V5 (Sprint P33)
 *
 * Answers: "How and under what conditions does physical context influence
 * collaboration decisions?"
 *
 * Runs 5 conditions on apartment (multiAgentEval=true, N=3 iterations):
 *   - full-ac: Baseline (reuses Pilot 1 data if available)
 *   - vague-spatial: Imprecise spatial descriptions
 *   - no-propagation: No effect propagation info
 *   - no-service: No partner discovery
 *   - rule-only: Pure computation (no physical context to LLM)
 *
 * Produces: Type × Condition interaction matrix (5 Types × 5 Conditions)
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
  loadLatestPilotResults,
} from '../infrastructure/result-persistence.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONDITIONS: ExperimentCondition[] = [
  'full-ac',
  'vague-spatial',
  'no-propagation',
  'no-service',
  'rule-only',
];

const SCENARIO = 'apartment';
const ITERATIONS = 1; // 1 iteration for pilot; increase for final runs
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';

const allResults: Awaited<ReturnType<PaperExperimentRunner['run']>>[number][] = [];

// ---------------------------------------------------------------------------
// Helper: Type × Condition matrix
// ---------------------------------------------------------------------------

function printTypeConditionMatrix(): void {
  console.log('\n========================================');
  console.log('Pilot 2: RQ2 Mechanism Analysis');
  console.log(`Scenario: ${SCENARIO} | Iterations: ${ITERATIONS} | Model: ${MODEL}`);
  console.log('========================================\n');

  // Build Type × Condition accuracy matrix
  const types = ['A', 'B', 'C', 'D', 'E'] as const;
  const collector = new MetricsCollector(SCENARIOS[SCENARIO].zones);

  console.log('| Type | full-ac | vague-spatial | no-propagation | no-service | rule-only |');
  console.log('|------|---------|---------------|----------------|------------|-----------|');

  for (const type of types) {
    const row: string[] = [type];
    for (const condition of CONDITIONS) {
      const conditionResults = allResults.filter(r => r.config.condition === condition);
      const allEvents = conditionResults.flatMap(r => r.events);
      const typeEvents = allEvents.filter(e => e.interactionType === type);

      if (typeEvents.length === 0) {
        row.push('N/A');
        continue;
      }

      const accuracy = typeEvents.filter(e => e.correctDecision).length / typeEvents.length;
      row.push(`${(accuracy * 100).toFixed(1)}%`);
    }
    console.log(`| ${row[0].padEnd(4)} | ${row.slice(1).map(v => v.padStart(7)).join(' | ')} |`);
  }

  // Overall accuracy per condition
  console.log('\n--- Overall Accuracy ---');
  for (const condition of CONDITIONS) {
    const conditionResults = allResults.filter(r => r.config.condition === condition);
    if (conditionResults.length === 0) continue;

    const avgAccuracy = conditionResults.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / conditionResults.length;
    console.log(`  ${condition}: ${(avgAccuracy * 100).toFixed(1)}%`);
  }

  // Type-wise metrics using MetricsCollector
  console.log('\n--- Type-wise Metrics (full-ac) ---');
  const fullAcResults = allResults.filter(r => r.config.condition === 'full-ac');
  if (fullAcResults.length > 0) {
    const maps = fullAcResults.map(r => collector.computeTypeWiseMetrics(r.events));
    const merged = collector.mergeTypeWiseMetrics(maps);
    for (const type of types) {
      const m = merged.byType[type];
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

describe.skip('LEGACY: Pilot 2: RQ2 Mechanism Analysis', () => {
  afterAll(() => {
    printTypeConditionMatrix();

    try {
      const savedPaths = savePilotResults(allResults, 'pilot-2-rq2-mechanism');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      const csvPath = join(getResultsBaseDir(), 'pilot-2-rq2-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  // Try to reuse Pilot 1 full-ac results
  let fullAcLoaded = false;
  try {
    const pilot1Results = loadLatestPilotResults('pilot-1');
    const pilot1FullAc = pilot1Results.filter(r => r.config.condition === 'full-ac');
    if (pilot1FullAc.length >= ITERATIONS) {
      allResults.push(...pilot1FullAc.slice(0, ITERATIONS));
      fullAcLoaded = true;
      console.log(`Reused ${ITERATIONS} full-ac results from Pilot 1`);
    }
  } catch {
    // Pilot 1 results not available, will run fresh
  }

  for (const condition of CONDITIONS) {
    // Skip full-ac if already loaded from Pilot 1
    if (condition === 'full-ac' && fullAcLoaded) {
      it(`${condition} / ${SCENARIO} (reused from Pilot 1)`, () => {
        expect(allResults.filter(r => r.config.condition === 'full-ac')).toHaveLength(ITERATIONS);
      });
      continue;
    }

    it(`${condition} / ${SCENARIO} × ${ITERATIONS} iterations`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `pilot2-${condition}-${SCENARIO}`,
        name: `Pilot 2 RQ2: ${condition}`,
        rq: 'RQ2',
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
