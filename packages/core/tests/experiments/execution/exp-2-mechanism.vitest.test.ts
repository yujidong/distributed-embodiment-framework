/**
 * Experiment 2: RQ2 Mechanism Analysis — PAPER_DESIGN_V5
 *
 * Answers: "Which components of the Active Collaboration mechanism contribute
 * to system effectiveness?"
 *
 * Runs 7 conditions on apartment (multiAgentEval=true, realisticRouting=true, N=5):
 *   - full-ac: Complete system (all components active)
 *   - vague-spatial: Spatial reasoning degraded (vague zone descriptions)
 *   - no-propagation: Effect propagation disabled (no cross-zone awareness)
 *   - no-service: Service discovery disabled (no partner capability matching)
 *   - rule-only: Pure rule-based (no LLM reasoning)
 *   - coverage-aware: Physical coverage info only (no services, no propagation)
 *   - concise-service: Filtered services (event-zone only) with compact descriptions
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
  'vague-spatial',
  'no-propagation',
  'no-service',
  'rule-only',
  'coverage-aware',
  'concise-service',
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
  console.log('Experiment 2: RQ2 Mechanism Analysis');
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

  // Mechanism ablation analysis
  const fullAc = allResults.filter(r => r.config.condition === 'full-ac');
  const vagueSpatial = allResults.filter(r => r.config.condition === 'vague-spatial');
  const noPropagation = allResults.filter(r => r.config.condition === 'no-propagation');
  const noService = allResults.filter(r => r.config.condition === 'no-service');
  const ruleOnly = allResults.filter(r => r.config.condition === 'rule-only');
  const coverageAware = allResults.filter(r => r.config.condition === 'coverage-aware');
  const conciseService = allResults.filter(r => r.config.condition === 'concise-service');

  if (fullAc.length > 0) {
    const fullAcc = fullAc.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / fullAc.length;
    console.log(`\n--- Mechanism Ablation ---`);
    console.log(`  full-ac accuracy: ${(fullAcc * 100).toFixed(1)}%`);

    if (vagueSpatial.length > 0) {
      const vagueAcc = vagueSpatial.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / vagueSpatial.length;
      console.log(`  vague-spatial accuracy: ${(vagueAcc * 100).toFixed(1)}%`);
      console.log(`  spatial reasoning value: ${((fullAcc - vagueAcc) * 100).toFixed(1)}pp`);
    }

    if (noPropagation.length > 0) {
      const noPropAcc = noPropagation.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / noPropagation.length;
      console.log(`  no-propagation accuracy: ${(noPropAcc * 100).toFixed(1)}%`);
      console.log(`  effect propagation value: ${((fullAcc - noPropAcc) * 100).toFixed(1)}pp`);
    }

    if (noService.length > 0) {
      const noSvcAcc = noService.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / noService.length;
      console.log(`  no-service accuracy: ${(noSvcAcc * 100).toFixed(1)}%`);
      console.log(`  service discovery value: ${((fullAcc - noSvcAcc) * 100).toFixed(1)}pp`);
    }

    if (ruleOnly.length > 0) {
      const ruleAcc = ruleOnly.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / ruleOnly.length;
      console.log(`  rule-only accuracy: ${(ruleAcc * 100).toFixed(1)}%`);
      console.log(`  LLM reasoning value: ${((fullAcc - ruleAcc) * 100).toFixed(1)}pp`);
    }

    if (coverageAware.length > 0) {
      const covAcc = coverageAware.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / coverageAware.length;
      console.log(`  coverage-aware accuracy: ${(covAcc * 100).toFixed(1)}%`);
      console.log(`  physical coverage value (vs no-service+no-prop): ${(ruleOnly.length > 0 ? `rule-only=${((covAcc - (ruleOnly.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / ruleOnly.length)) * 100).toFixed(1)}pp` : 'N/A')}`);
    }

    if (conciseService.length > 0) {
      const conSvcAcc = conciseService.reduce((s, r) => s + r.decisionQuality.meanCorrectDecisionRate, 0) / conciseService.length;
      console.log(`  concise-service accuracy: ${(conSvcAcc * 100).toFixed(1)}%`);
      const conSvcTokens = conciseService.reduce((s, r) => s + r.efficiency.totalTokens, 0) / conciseService.length;
      const fullAcTokens = fullAc.reduce((s, r) => s + r.efficiency.totalTokens, 0) / fullAc.length;
      console.log(`  token efficiency: ${conSvcTokens.toFixed(0)} vs ${fullAcTokens.toFixed(0)} (${((conSvcTokens / fullAcTokens) * 100).toFixed(0)}%)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Experiment 2: RQ2 Mechanism Analysis', () => {
  afterAll(() => {
    printComparisonTable();

    // Save results
    try {
      const savedPaths = savePilotResults(allResults, 'exp-2-rq2-mechanism');
      console.log(`\nResults saved to ${savedPaths.length} files`);

      // Export CSV
      const csvPath = join(getResultsBaseDir(), 'exp-2-rq2-mechanism-summary.csv');
      exportResultsCSV(allResults, csvPath);
      console.log(`CSV exported to ${csvPath}`);
    } catch (err) {
      console.error('Failed to save results:', err);
    }
  });

  for (const condition of CONDITIONS) {
    it(`${condition} / ${SCENARIO} x ${ITERATIONS} iterations`, async () => {
      const config = PaperExperimentRunner.createConfig({
        id: `exp2-${condition}-${SCENARIO}`,
        name: `Exp 2 RQ2 Mechanism: ${condition}`,
        rq: 'RQ2',
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
