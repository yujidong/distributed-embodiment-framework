/**
 * Experiment 6: RQ5 Execution-Phase Evaluation
 *
 * Answers: "Does the full AC lifecycle produce correct physical outcomes?"
 *   - RQ5.1: Partner selection accuracy
 *   - RQ5.2: Goal achievement rate
 *   - RQ5.3: Environment effect accuracy
 *
 * This experiment BUILDS ON the existing experiment infrastructure (same as exp-1)
 * but adds execution-phase evaluation via `executionPhaseEval: true`.
 *
 * Whereas exp-1 evaluates decision quality ("should I collaborate?"),
 * this experiment evaluates the FULL collaboration lifecycle:
 *   Decision → Partner Selection → Goal Formulation → Execution → Physical Effect
 *
 * Uses the apartment scenario with `full-ac` condition only (baselines like
 * always-collaborate/never-collaborate don't execute collaborations).
 * Runs N=3 iterations with simDurationSeconds=300 (5 minutes of simulated
 * cooling/heating per device command).
 *
 * Key metrics:
 *   - Partner Selection Rate: % of initiate_ac events where partners were found
 *   - Partner Accuracy: % of events where the correct partner was selected
 *   - Goal Achievement Rate: % of events where expected outcome was achieved
 *   - Execution Success Rate: % of completed executions
 *   - Outcome Achievement Rate: % of events with environment effects
 *   - Mean Environment Accuracy: how close the outcome matches the target
 *   - End-to-end Latency: from event injection to environment change
 */

import { describe, it, expect, afterAll } from 'vitest';
import { PaperExperimentRunner } from '../infrastructure/paper-experiment-runner.js';
import {
  savePilotResults,
  exportResultsCSV,
  getResultsBaseDir,
} from '../infrastructure/result-persistence.js';
import type { PaperExperimentResult, ExecutionPhaseResult } from '../infrastructure/types.js';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCENARIO = 'apartment';
const CONDITION = 'full-ac'; // Only full-ac executes collaborations
const ITERATIONS = 5;
const TIMEOUT = 5400000; // 90 minutes per test
const MODEL = 'qwen3-14b-q4:latest';
const SIM_DURATION_SECONDS = 1800; // 30 min — enough for heating 5→22°C (~708s needed)

// Accumulator for all results
const allResults: PaperExperimentResult[] = [];

// ---------------------------------------------------------------------------
// Helper: print execution-phase results table
// ---------------------------------------------------------------------------

function printExecutionTable(): void {
  console.log('\n========================================');
  console.log('Experiment 6: RQ5 Execution-Phase Evaluation');
  console.log(`Scenario: ${SCENARIO} | Condition: ${CONDITION} | Iterations: ${ITERATIONS}`);
  console.log(`Model: ${MODEL} | simDuration: ${SIM_DURATION_SECONDS}s`);
  console.log('========================================\n');

  // Decision-phase overview (same as exp-1)
  const avgAccuracy = allResults.reduce(
    (s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0,
  ) / allResults.length;
  console.log(`Decision Accuracy: ${(avgAccuracy * 100).toFixed(1)}%\n`);

  // Execution-phase table
  console.log('--- Execution-Phase Metrics ---');
  console.log('| Metric                         | Value  |');
  console.log('|--------------------------------|--------|');

  const execMetrics = allResults.filter(r => r.executionMetrics);
  if (execMetrics.length === 0) {
    console.log('| (no execution metrics)         | N/A    |');
    return;
  }

  // Aggregate execution metrics across iterations
  const n = execMetrics.length;
  const avg = (fn: (m: NonNullable<PaperExperimentResult['executionMetrics']>) => number) =>
    execMetrics.reduce((s, r) => s + fn(r.executionMetrics!), 0) / n;

  const metrics = {
    'AC Initiated Count': avg(m => m.acInitiatedCount),
    'Execution Completed': avg(m => m.executionCompletedCount),
    'Partner Selection Rate': avg(m => m.partnerSelectionRate),
    'Partner Accuracy': avg(m => m.partnerAccuracy),
    'Goal Achievement Rate': avg(m => m.goalAchievementRate),
    'Execution Success Rate': avg(m => m.executionSuccessRate),
    'Outcome Achievement Rate': avg(m => m.outcomeAchievementRate),
    'Mean Env Accuracy': avg(m => m.meanEnvironmentAccuracy),
    'Mean Execution Time (ms)': avg(m => m.meanExecutionTimeMs),
    'Mean Total Latency (ms)': avg(m => m.meanTotalLatencyMs),
  };

  for (const [name, value] of Object.entries(metrics)) {
    if (name.includes('Rate') || name.includes('Accuracy')) {
      console.log(`| ${name.padEnd(30)} | ${(value * 100).toFixed(1).padStart(5)}% |`);
    } else {
      console.log(`| ${name.padEnd(30)} | ${value.toFixed(1).padStart(5)}  |`);
    }
  }

  // Per-event execution detail
  console.log('\n--- Per-Event Execution Detail ---');
  console.log('| Event ID                   | Decision       | Partner Sel | Partner IDs       | Goals | Exec OK | Env Effect | Outcome OK |');
  console.log('|----------------------------|----------------|-------------|-------------------|-------|---------|------------|------------|');

  for (const result of allResults) {
    for (const event of result.events) {
      const ep = event.executionPhase;
      if (!ep) continue;

      const decision = event.decisionMade ?? 'N/A';
      const partnerSel = ep.partnerSelectionSuccess ? 'YES' : 'NO';
      const partners = ep.selectedPartnerIds.length > 0
        ? ep.selectedPartnerIds.join(',').substring(0, 17)
        : '(none)';
      const goals = ep.goalsFormulated.toString();
      const execOk = ep.executionCompleted ? 'YES' : 'NO';
      const envEffect = ep.environmentEffectsObserved ? 'YES' : 'NO';
      const outcomeOk = ep.expectedOutcomeAchieved ? 'YES' : 'NO';

      console.log(
        `| ${ep.eventId.padEnd(26)} | ${decision.padEnd(14)} | ${partnerSel.padEnd(11)} | ` +
        `${partners.padEnd(17)} | ${goals.padEnd(5)} | ${execOk.padEnd(7)} | ${envEffect.padEnd(10)} | ${outcomeOk.padEnd(10)} |`,
      );
    }
  }

  // Parameter changes detail
  console.log('\n--- Environment Parameter Changes ---');
  for (const result of allResults) {
    for (const event of result.events) {
      const ep = event.executionPhase;
      if (!ep || ep.parameterChanges.length === 0) continue;

      console.log(`\n  Event: ${ep.eventId}`);
      for (const change of ep.parameterChanges) {
        console.log(
          `    ${change.parameter}@${change.zone}: ${change.beforeValue} → ${change.afterValue}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 6: RQ5 Execution-Phase Evaluation', () => {
  afterAll(() => {
    printExecutionTable();

    // Save results
    try {
      const savedPaths = savePilotResults(allResults, 'exp-6-rq5-execution-phase');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      // Export CSV
      const csvPath = join(getResultsBaseDir(), 'exp-6-rq5-execution-phase-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  it(`${CONDITION} / ${SCENARIO} x ${ITERATIONS} iterations (execution-phase eval)`, async () => {
    const config = PaperExperimentRunner.createConfig({
      id: `exp6-${CONDITION}-${SCENARIO}`,
      name: `Exp 6 RQ5 Execution Phase: ${CONDITION}`,
      rq: 'RQ5',
      scenario: SCENARIO,
      condition: CONDITION,
      iterations: ITERATIONS,
      llmModel: MODEL,
      timeoutMs: 120000,
      multiAgentEval: true,
      realisticRouting: true,
      executionPhaseEval: true,
      simDurationSeconds: SIM_DURATION_SECONDS,
    });

    const runner = new PaperExperimentRunner(config);
    const results = await runner.run();

    expect(results).toHaveLength(ITERATIONS);

    for (const result of results) {
      expect(result.events.length).toBeGreaterThan(0);
      expect(Number.isFinite(result.decisionQuality.meanCorrectDecisionRate)).toBe(true);

      // Execution-phase assertions
      if (result.executionMetrics) {
        const m = result.executionMetrics;
        console.log(
          `[Exp 6] Execution metrics: AC initiated=${m.acInitiatedCount}, ` +
          `partnerSel=${(m.partnerSelectionRate * 100).toFixed(0)}%, ` +
          `outcomeOK=${(m.outcomeAchievementRate * 100).toFixed(0)}%, ` +
          `envAccuracy=${(m.meanEnvironmentAccuracy * 100).toFixed(0)}%`,
        );

        // At least some events should have initiated AC (the apartment scenario
        // has events requiring collaboration across agents)
        expect(m.acInitiatedCount).toBeGreaterThan(0);
      }

      allResults.push(result);
    }
  }, TIMEOUT);
});
